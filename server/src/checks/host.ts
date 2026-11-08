import { readFile, readdir, statfs } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../lib/config.js';
import type { CheckExecutor } from './types.js';
import { m, type MetricValue } from './types.js';

async function read(p: string): Promise<string | null> {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'f2fs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'jfs', 'reiserfs', 'bcachefs', 'nfs', 'nfs4', 'cifs', 'fuseblk']);
const SKIP_MOUNT = /^\/(proc|sys|dev|run|var\/lib\/docker|var\/lib\/containerd|snap|boot\/efi$)/;
const SKIP_NET = /^(lo|veth|br-|docker|virbr|tap|tun|cali|flannel|cni|kube|vxlan)/;
const SKIP_DISK = /^(loop|ram|zram|sr|fd|dm-|md\d+p)/;

/**
 * Host metrics read agentlessly from the host's /proc, /sys and root filesystem mounted
 * read-only into the worker. Rates (CPU, disk, network) are deltas against the previous run.
 */
export const hostCheck: CheckExecutor = {
  type: 'host', label: 'Host-Ressourcen (lokal)', category: 'Ressourcen', defaultInterval: 30,
  description: 'CPU, RAM, Swap, Load, Prozesse, Dateisysteme (Belegung, Inodes), Disk-I/O und Latenz, Netzwerkdurchsatz/-fehler, Temperaturen – für den Host, auf dem Hermes läuft.',
  fields: [{ key: 'mounts', label: 'Nur diese Mountpoints (optional)', type: 'text', hint: 'Kommagetrennt, z. B. /,/data. Leer = alle echten Dateisysteme' }],
  defaultThresholds: [
    { metric: 'cpu_percent', op: '>', warning: 85, critical: 97 },
    { metric: 'mem_used_percent', op: '>', warning: 90, critical: 97 },
    { metric: 'swap_used_percent', op: '>', warning: 60, critical: 90 },
    { metric: 'fs_used_percent:*', op: '>', warning: 85, critical: 95 },
    { metric: 'fs_inodes_used_percent:*', op: '>', warning: 85, critical: 95 },
    { metric: 'temp_max_celsius', op: '>', warning: 80, critical: 92 },
  ],
  metrics: [
    { name: 'cpu_percent', unit: 'percent', label: 'CPU' }, { name: 'cpu_iowait_percent', unit: 'percent', label: 'CPU I/O-Wait' },
    { name: 'load1', unit: 'count', label: 'Load 1m' }, { name: 'load5', unit: 'count', label: 'Load 5m' }, { name: 'load15', unit: 'count', label: 'Load 15m' },
    { name: 'load1_per_cpu', unit: 'count', label: 'Load 1m je CPU' },
    { name: 'mem_used_percent', unit: 'percent', label: 'RAM belegt' }, { name: 'mem_available_bytes', unit: 'bytes', label: 'RAM verfügbar' }, { name: 'mem_used_bytes', unit: 'bytes', label: 'RAM belegt' },
    { name: 'swap_used_percent', unit: 'percent', label: 'Swap belegt' }, { name: 'swap_used_bytes', unit: 'bytes', label: 'Swap belegt' },
    { name: 'procs_running', unit: 'count', label: 'Prozesse lauffähig' }, { name: 'procs_blocked', unit: 'count', label: 'Prozesse blockiert (D)' }, { name: 'procs_zombie', unit: 'count', label: 'Zombies' }, { name: 'procs_total', unit: 'count', label: 'Prozesse' },
    { name: 'fs_used_percent:*', unit: 'percent', label: 'Dateisystem belegt' }, { name: 'fs_free_bytes:*', unit: 'bytes', label: 'Dateisystem frei' }, { name: 'fs_inodes_used_percent:*', unit: 'percent', label: 'Inodes belegt' },
    { name: 'disk_read_bps:*', unit: 'bytes/s', label: 'Disk lesen' }, { name: 'disk_write_bps:*', unit: 'bytes/s', label: 'Disk schreiben' }, { name: 'disk_util_percent:*', unit: 'percent', label: 'Disk-Auslastung' }, { name: 'disk_await_ms:*', unit: 'ms', label: 'Disk-Latenz' },
    { name: 'net_rx_bps:*', unit: 'bytes/s', label: 'Netz empfangen' }, { name: 'net_tx_bps:*', unit: 'bytes/s', label: 'Netz gesendet' }, { name: 'net_errors_ps:*', unit: '/s', label: 'Netzfehler' },
    { name: 'temp_max_celsius', unit: 'celsius', label: 'Höchste Temperatur' }, { name: 'uptime_s', unit: 's', label: 'Uptime' },
  ],
  async run(ctx) {
    const P = config.hostProc;
    if (!existsSync(join(P, 'stat'))) return { status: 'unknown', message: `Host-/proc nicht gemountet (${P})`, unavailable: { host: `${P} fehlt – Volume /proc:/host/proc:ro im Worker` } };
    const prev = (ctx.check.last_metrics?._carry ?? {}) as Record<string, any>;
    const now = Date.now();
    const dt = prev.t ? (now - prev.t) / 1000 : 0;
    const metrics: Record<string, MetricValue | undefined> = {};
    const unavailable: Record<string, string> = {};
    const carry: Record<string, any> = { t: now };

    // CPU
    const stat = (await read(join(P, 'stat'))) ?? '';
    const cpu = stat.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
    const total = cpu.slice(0, 8).reduce((a, b) => a + b, 0);
    const idle = cpu[3] + (cpu[4] ?? 0);
    carry.cpu = { total, idle, iowait: cpu[4] ?? 0 };
    if (prev.cpu && total > prev.cpu.total) {
      const dTotal = total - prev.cpu.total;
      metrics.cpu_percent = m(100 * (1 - (idle - prev.cpu.idle) / dTotal), 'percent');
      metrics.cpu_iowait_percent = m(100 * ((cpu[4] ?? 0) - prev.cpu.iowait) / dTotal, 'percent');
    }
    const ncpu = (stat.match(/^cpu\d+/gm) ?? []).length || 1;
    metrics.procs_running = m(Number(stat.match(/^procs_running (\d+)/m)?.[1]), 'count');
    metrics.procs_blocked = m(Number(stat.match(/^procs_blocked (\d+)/m)?.[1]), 'count');

    // load
    const load = ((await read(join(P, 'loadavg'))) ?? '').split(/\s+/);
    metrics.load1 = m(Number(load[0]), 'count'); metrics.load5 = m(Number(load[1]), 'count'); metrics.load15 = m(Number(load[2]), 'count');
    metrics.load1_per_cpu = m(Number(load[0]) / ncpu, 'count');
    const total_procs = Number(load[3]?.split('/')[1]);
    metrics.procs_total = m(total_procs, 'count');

    // zombies: scan /proc/<pid>/stat states (cheap enough for homelab process counts)
    try {
      let z = 0;
      const pids = (await readdir(P)).filter((f) => /^\d+$/.test(f));
      for (const pid of pids) {
        const s = await read(join(P, pid, 'stat'));
        if (s && s.slice(s.lastIndexOf(')') + 2, s.lastIndexOf(')') + 3) === 'Z') z++;
      }
      metrics.procs_zombie = m(z, 'count');
    } catch { unavailable.procs_zombie = 'Prozessliste nicht lesbar'; }

    // memory
    const mem = (await read(join(P, 'meminfo'))) ?? '';
    const kb = (k: string) => Number(mem.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? NaN) * 1024;
    const memTotal = kb('MemTotal'), memAvail = kb('MemAvailable'), swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree');
    metrics.mem_available_bytes = m(memAvail, 'bytes');
    metrics.mem_used_bytes = m(memTotal - memAvail, 'bytes');
    metrics.mem_total_bytes = m(memTotal, 'bytes');
    metrics.mem_used_percent = m(((memTotal - memAvail) / memTotal) * 100, 'percent');
    if (swapTotal > 0) { metrics.swap_used_bytes = m(swapTotal - swapFree, 'bytes'); metrics.swap_used_percent = m(((swapTotal - swapFree) / swapTotal) * 100, 'percent'); }
    else unavailable.swap = 'kein Swap konfiguriert';
    metrics.uptime_s = m(Number(((await read(join(P, 'uptime'))) ?? '').split(' ')[0]), 's');

    // filesystems (host mount namespace = pid 1)
    const only = String(ctx.check.config.mounts ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const mounts = ((await read(join(P, '1/mounts'))) ?? '').split('\n').map((l) => l.split(' ')).filter((p) => p.length > 3);
    const seenDev = new Set<string>();
    let fsCount = 0;
    if (!existsSync(config.hostRoot)) unavailable.filesystems = `Host-Wurzel nicht gemountet (${config.hostRoot})`;
    else for (const [dev, mp, type] of mounts) {
      const point = mp.replace(/\\040/g, ' ');
      if (only.length ? !only.includes(point) : !REAL_FS.has(type) || SKIP_MOUNT.test(point)) continue;
      if (seenDev.has(dev)) continue;
      seenDev.add(dev);
      try {
        const s = await statfs(join(config.hostRoot, point));
        if (!s.blocks) continue;
        const used = (s.blocks - s.bfree) * s.bsize;
        const avail = s.bavail * s.bsize;
        metrics[`fs_used_percent:${point}`] = m((used / (used + avail)) * 100, 'percent', `Belegt ${point}`);
        metrics[`fs_free_bytes:${point}`] = m(avail, 'bytes', `Frei ${point}`);
        metrics[`fs_size_bytes:${point}`] = m(s.blocks * s.bsize, 'bytes', `Größe ${point}`);
        if (s.files > 0) metrics[`fs_inodes_used_percent:${point}`] = m(((s.files - s.ffree) / s.files) * 100, 'percent', `Inodes ${point}`);
        fsCount++;
      } catch { /* not reachable under hostfs */ }
    }
    if (!fsCount && !unavailable.filesystems) unavailable.filesystems = 'keine echten Dateisysteme unter dem Host-Mount gefunden';

    // disk io
    const ds = ((await read(join(P, 'diskstats'))) ?? '').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 14);
    carry.disk = {};
    for (const p of ds) {
      const name = p[2];
      if (SKIP_DISK.test(name) || /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+)\d+$/.test(name) || /^nvme\d+n\d+p\d+$/.test(name) || /^mmcblk\d+p\d+$/.test(name)) continue;
      const reads = Number(p[3]), readSect = Number(p[5]), readMs = Number(p[6]), writes = Number(p[7]), writeSect = Number(p[9]), writeMs = Number(p[10]), ioMs = Number(p[12]);
      if (reads + writes === 0) continue;
      carry.disk[name] = { reads, writes, readSect, writeSect, readMs, writeMs, ioMs };
      const o = prev.disk?.[name];
      if (o && dt > 0) {
        metrics[`disk_read_bps:${name}`] = m(((readSect - o.readSect) * 512) / dt, 'bytes/s', `Lesen ${name}`);
        metrics[`disk_write_bps:${name}`] = m(((writeSect - o.writeSect) * 512) / dt, 'bytes/s', `Schreiben ${name}`);
        metrics[`disk_util_percent:${name}`] = m(Math.min(100, ((ioMs - o.ioMs) / (dt * 1000)) * 100), 'percent', `Auslastung ${name}`);
        const ops = reads - o.reads + (writes - o.writes);
        metrics[`disk_await_ms:${name}`] = m(ops > 0 ? (readMs - o.readMs + (writeMs - o.writeMs)) / ops : 0, 'ms', `Latenz ${name}`);
      }
    }

    // network (host netns = pid 1)
    const nd = ((await read(join(P, '1/net/dev'))) ?? '').split('\n').slice(2).map((l) => l.trim()).filter(Boolean);
    carry.net = {};
    for (const line of nd) {
      const [ifname, rest] = line.split(':');
      const name = ifname.trim();
      if (SKIP_NET.test(name)) continue;
      const f = rest.trim().split(/\s+/).map(Number);
      const cur = { rx: f[0], rxErr: f[2] + f[3], tx: f[8], txErr: f[10] + f[11] };
      carry.net[name] = cur;
      const o = prev.net?.[name];
      if (o && dt > 0 && cur.rx >= o.rx) {
        metrics[`net_rx_bps:${name}`] = m((cur.rx - o.rx) / dt, 'bytes/s', `Empfangen ${name}`);
        metrics[`net_tx_bps:${name}`] = m((cur.tx - o.tx) / dt, 'bytes/s', `Gesendet ${name}`);
        metrics[`net_errors_ps:${name}`] = m((cur.rxErr - o.rxErr + (cur.txErr - o.txErr)) / dt, '/s', `Fehler ${name}`);
      }
    }

    // temperatures (hwmon, thermal zones)
    const temps: number[] = [];
    const S = config.hostSys;
    try {
      for (const hw of await readdir(join(S, 'class/hwmon'))) {
        for (const f of (await readdir(join(S, 'class/hwmon', hw))).filter((x) => /^temp\d+_input$/.test(x))) {
          const v = Number(await read(join(S, 'class/hwmon', hw, f))) / 1000;
          if (v > 0 && v < 150) temps.push(v);
        }
      }
    } catch { /* no hwmon */ }
    try {
      for (const z of (await readdir(join(S, 'class/thermal'))).filter((x) => x.startsWith('thermal_zone'))) {
        const v = Number(await read(join(S, 'class/thermal', z, 'temp'))) / 1000;
        if (v > 0 && v < 150) temps.push(v);
      }
    } catch { /* no thermal */ }
    if (temps.length) metrics.temp_max_celsius = m(Math.max(...temps), 'celsius');
    else unavailable.temperature = 'keine Temperatursensoren unter /sys/class/hwmon oder thermal';
    unavailable.smart = 'SMART erfordert privilegierten Zugriff auf Block-Geräte (smartctl) – in v1 nicht aktiviert';

    const out: Record<string, MetricValue> = {};
    for (const [k, v] of Object.entries(metrics)) if (v) out[k] = v;
    const cpuTxt = out.cpu_percent ? `CPU ${out.cpu_percent.value.toFixed(0)} %` : 'CPU (erster Messpunkt)';
    return { status: 'ok', message: `${cpuTxt}, RAM ${out.mem_used_percent?.value.toFixed(0)} %, Load ${load[0]}, ${fsCount} Dateisysteme`, metrics: out, carry, unavailable };
  },
};

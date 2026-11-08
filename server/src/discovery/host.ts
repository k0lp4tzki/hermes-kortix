import type { DiscoveredItem } from '../core/types.js';
import type { DiscoveryAdapter } from './adapter.js';
import { activeSystemdUnits, hostIps, hostName, hostProcAvailable, osRelease, readText } from './hostinfo.js';
import { config } from '../lib/config.js';
import { join } from 'node:path';

const UNIT_IGNORE = /^(systemd-|user@|user-runtime-dir@|getty@|serial-getty@|session-|dbus|init\.scope|-\.slice|.*\.slice$|.*\.scope$|.*\.mount$|.*\.device$|.*\.swap$|.*\.socket$|.*\.target$|.*\.path$|.*\.timer$)/;

/** The machine Hermes runs on, read agentlessly via the read-only /proc, /sys and / mounts. */
export const hostAdapter: DiscoveryAdapter = {
  type: 'host',
  label: 'Lokaler Linux-Host (/proc, /sys)',
  async availability() {
    return hostProcAvailable() ? null : `Host-/proc ist nicht unter ${config.hostProc} gemountet`;
  },
  async discover(source) {
    const name = await hostName();
    const key = `host:${name}`;
    const cpuinfo = (await readText(join(config.hostProc, 'cpuinfo'))) ?? '';
    const meminfo = (await readText(join(config.hostProc, 'meminfo'))) ?? '';
    const model = cpuinfo.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? null;
    const cpus = (cpuinfo.match(/^processor\s*:/gm) ?? []).length || null;
    const memKb = Number(meminfo.match(/^MemTotal:\s+(\d+)/m)?.[1] ?? 0);
    const kernel = (await readText(join(config.hostProc, 'sys/kernel/osrelease')))?.trim() ?? null;
    const virt = (await readText(join(config.hostSys, 'class/dmi/id/product_name')))?.trim() ?? null;
    const ips = await hostIps();
    const items: DiscoveredItem[] = [{
      identityKey: key, kind: 'host', name, running: true,
      attributes: { os: await osRelease(), kernel, cpu_model: model, cpus, mem_total: memKb * 1024, ips, product: virt, procfs: config.hostProc },
      connection: { host: ips[0] ?? null },
    }];
    if (source.config.systemd !== false) {
      const units = await activeSystemdUnits();
      for (const u of units ?? []) {
        if (!u.endsWith('.service') || UNIT_IGNORE.test(u)) continue;
        items.push({
          identityKey: `systemd:${name}/${u}`, kind: 'systemd_service', name: u.replace(/\.service$/, ''), parentIdentityKey: key, running: true,
          attributes: { unit: u, unit_state: 'active' }, connection: { unit: u },
        });
      }
    }
    return items;
  },
};

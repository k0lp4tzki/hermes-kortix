import { DockerClient, computeContainerStats } from '../lib/docker.js';
import { config } from '../lib/config.js';
import type { CheckExecutor, CheckContext } from './types.js';
import { compact, m, ConfigError } from './types.js';

const clients = new Map<string, DockerClient>();
function dockerFor(ctx: CheckContext): DockerClient {
  const ep = ctx.check.config.endpoint || ctx.resource.discovered.docker_endpoint || `unix://${config.dockerSocket}`;
  let c = clients.get(ep);
  if (!c) { c = new DockerClient(ep, 15000); clients.set(ep, c); }
  return c;
}

/** Finds the container for a resource; follows re-creation via compose labels or name. */
async function findContainer(ctx: CheckContext, d: DockerClient): Promise<any | null> {
  const disc = ctx.resource.discovered;
  const id = ctx.check.config.container || ctx.resource.connection.container_id || disc.container_id;
  if (id) {
    try { return await d.inspect(id); } catch { /* re-created or removed */ }
  }
  const list = await d.containers(true);
  const match = list.find((c: any) => {
    const l = c.Labels ?? {};
    if (disc.compose_project && disc.compose_service) {
      return l['com.docker.compose.project'] === disc.compose_project && l['com.docker.compose.service'] === disc.compose_service;
    }
    const name = ctx.check.config.container || disc.container_name || ctx.resource.connection.container_name || ctx.resource.name;
    return (c.Names ?? []).some((n: string) => n.replace(/^\//, '') === name);
  });
  return match ? d.inspect(match.Id) : null;
}

function rate(cur: number, prev: number | undefined, dtS: number): number | null {
  if (prev === undefined || dtS <= 0 || cur < prev) return null;
  return (cur - prev) / dtS;
}

export const containerCheck: CheckExecutor = {
  type: 'container', label: 'Docker-Container', category: 'Container', defaultInterval: 30,
  description: 'Vorhanden, läuft, Healthcheck, Neustarts, OOM-Kill, CPU/RAM/Netz/IO je Container und Speicherlimit-Auslastung.',
  fields: [{ key: 'container', label: 'Container (Name oder ID, optional)', type: 'text', hint: 'Leer = aus der Discovery (folgt Neuerstellungen)' }, { key: 'expect_running', label: 'Muss laufen', type: 'boolean', default: true }],
  defaultThresholds: [{ metric: 'restarts_recent', op: '>', warning: 0, critical: 3 }, { metric: 'mem_limit_percent', op: '>', warning: 85, critical: 95 }, { metric: 'cpu_percent', op: '>', warning: 90, critical: null }],
  metrics: [
    { name: 'cpu_percent', unit: 'percent', label: 'CPU' }, { name: 'mem_used_bytes', unit: 'bytes', label: 'RAM' }, { name: 'mem_limit_percent', unit: 'percent', label: 'RAM vs. Limit' },
    { name: 'net_rx_bps', unit: 'bytes/s', label: 'Netz empfangen' }, { name: 'net_tx_bps', unit: 'bytes/s', label: 'Netz gesendet' },
    { name: 'blk_read_bps', unit: 'bytes/s', label: 'Disk lesen' }, { name: 'blk_write_bps', unit: 'bytes/s', label: 'Disk schreiben' },
    { name: 'restart_count', unit: 'count', label: 'Neustarts gesamt' }, { name: 'restarts_recent', unit: 'count', label: 'Neustarts seit letztem Check' }, { name: 'pids', unit: 'count', label: 'Prozesse' },
    { name: 'running', unit: 'bool', label: 'Läuft' }, { name: 'uptime_s', unit: 's', label: 'Laufzeit' },
  ],
  async run(ctx) {
    const d = dockerFor(ctx);
    if (!d.available()) return { status: 'unknown', message: `Docker-Socket nicht verfügbar (${d.endpoint})`, unavailable: { docker: 'Socket nicht gemountet' } };
    const c = await findContainer(ctx, d);
    if (!c) return { status: 'critical', message: 'Container nicht vorhanden', metrics: { running: { value: 0, unit: 'bool' } } };
    const prev = (ctx.check.last_metrics?._carry ?? {}) as Record<string, number>;
    const now = Date.now();
    const dt = prev.t ? (now - prev.t) / 1000 : 0;
    const restartCount = c.RestartCount ?? 0;
    // a re-created container (new id) starts its restart counter at 0: only compare the same container
    const restartsRecent = prev.restart_count !== undefined && String(prev.container_id) === c.Id ? Math.max(0, restartCount - prev.restart_count) : 0;
    const running = c.State?.Running === true;
    const health = c.State?.Health?.Status as string | undefined;
    const startedAt = c.State?.StartedAt ? new Date(c.State.StartedAt).getTime() : null;
    let stats: ReturnType<typeof computeContainerStats> | null = null;
    if (running) { try { stats = computeContainerStats(await d.stats(c.Id)); } catch { /* stats unavailable */ } }
    const limit = c.HostConfig?.Memory || 0;
    const metrics = compact({
      running: m(running ? 1 : 0, 'bool'), restart_count: m(restartCount, 'count'), restarts_recent: m(restartsRecent, 'count'),
      uptime_s: m(running && startedAt ? (now - startedAt) / 1000 : null, 's'),
      cpu_percent: m(stats?.cpuPercent, 'percent'), mem_used_bytes: m(stats?.memUsed, 'bytes'), mem_limit_bytes: m(limit || null, 'bytes'),
      mem_limit_percent: m(limit && stats?.memUsed != null ? (stats.memUsed / limit) * 100 : null, 'percent'),
      net_rx_bps: m(stats ? rate(stats.rx, prev.rx, dt) : null, 'bytes/s'), net_tx_bps: m(stats ? rate(stats.tx, prev.tx, dt) : null, 'bytes/s'),
      blk_read_bps: m(stats ? rate(stats.blkRead, prev.blkRead, dt) : null, 'bytes/s'), blk_write_bps: m(stats ? rate(stats.blkWrite, prev.blkWrite, dt) : null, 'bytes/s'),
      pids: m(stats?.pids, 'count'),
    });
    const carry = { t: now, restart_count: restartCount, container_id: c.Id, ...(stats ? { rx: stats.rx, tx: stats.tx, blkRead: stats.blkRead, blkWrite: stats.blkWrite } : {}) } as Record<string, unknown>;
    const unavailable: Record<string, string> = {};
    if (!limit) unavailable.mem_limit_percent = 'kein Speicherlimit gesetzt';
    if (running && stats && !stats.hasNetworks) unavailable.net = 'Host-Netzwerk: keine Container-Netzwerkzähler';
    const name = c.Name?.replace(/^\//, '');
    if (c.State?.OOMKilled) return { status: 'critical', message: `${name}: vom Kernel beendet (OOM, Speicherlimit erreicht)`, metrics, carry, unavailable };
    if (!running) {
      if (ctx.check.config.expect_running === false) return { status: 'ok', message: `${name}: ${c.State?.Status} (Laufen nicht erforderlich)`, metrics, carry, unavailable };
      return { status: 'critical', message: `${name}: ${c.State?.Status}${c.State?.ExitCode ? `, Exit-Code ${c.State.ExitCode}` : ''}${c.State?.Error ? ` (${c.State.Error})` : ''}`, metrics, carry, unavailable };
    }
    if (health === 'unhealthy') {
      const last = c.State?.Health?.Log?.slice(-1)[0]?.Output?.trim().slice(0, 200);
      return { status: 'critical', message: `${name}: Healthcheck fehlgeschlagen${last ? ` – ${last}` : ''}`, metrics, carry, unavailable };
    }
    if (health === 'starting') return { status: 'warning', message: `${name}: Healthcheck startet`, metrics, carry, unavailable };
    return { status: 'ok', message: `${name}: läuft${health ? ` (${health})` : ''}, ${restartCount} Neustarts gesamt`, metrics, carry, unavailable };
  },
};

const DEFAULT_ERROR = '\\b(error|exception|fatal|panic|traceback)\\b';
const DEFAULT_WARN = '\\b(warn|warning)\\b';

export const containerLogsCheck: CheckExecutor = {
  type: 'container_logs', label: 'Container-Logs (Fehlerregeln)', category: 'Container', defaultInterval: 120,
  description: 'Zählt neue Logzeilen, die auf konfigurierbare Fehler-/Warnmuster passen (seit dem letzten Lauf).',
  fields: [
    { key: 'container', label: 'Container (optional)', type: 'text', hint: 'Leer = aus der Discovery' },
    { key: 'error_pattern', label: 'Fehlermuster (Regex)', type: 'text', default: DEFAULT_ERROR },
    { key: 'warn_pattern', label: 'Warnmuster (Regex)', type: 'text', default: DEFAULT_WARN },
    { key: 'ignore_pattern', label: 'Ignorieren (Regex, optional)', type: 'text' },
  ],
  defaultThresholds: [{ metric: 'error_lines', op: '>', warning: 0, critical: 20 }],
  metrics: [{ name: 'error_lines', unit: 'count', label: 'Fehlerzeilen' }, { name: 'warn_lines', unit: 'count', label: 'Warnzeilen' }, { name: 'lines', unit: 'count', label: 'Zeilen gesamt' }],
  async run(ctx) {
    const d = dockerFor(ctx);
    if (!d.available()) return { status: 'unknown', message: 'Docker-Socket nicht verfügbar', unavailable: { docker: 'Socket nicht gemountet' } };
    const c = await findContainer(ctx, d);
    if (!c) return { status: 'unknown', message: 'Container nicht vorhanden – keine Logs' };
    const since = ctx.check.last_run ? ctx.check.last_run.getTime() / 1000 : Date.now() / 1000 - ctx.check.interval_s;
    let errRe: RegExp, warnRe: RegExp, ignRe: RegExp | null;
    try {
      errRe = new RegExp(ctx.check.config.error_pattern || DEFAULT_ERROR, 'i');
      warnRe = new RegExp(ctx.check.config.warn_pattern || DEFAULT_WARN, 'i');
      ignRe = ctx.check.config.ignore_pattern ? new RegExp(ctx.check.config.ignore_pattern, 'i') : null;
    } catch (e) { throw new ConfigError(`ungültiges Muster: ${(e as Error).message}`); }
    const lines = await d.logs(c.Id, since);
    let errors = 0, warns = 0;
    let sample = '';
    for (const l of lines) {
      if (ignRe?.test(l)) continue;
      if (errRe.test(l)) { errors++; sample = l; } else if (warnRe.test(l)) warns++;
    }
    const metrics = { error_lines: { value: errors, unit: 'count' }, warn_lines: { value: warns, unit: 'count' }, lines: { value: lines.length, unit: 'count' } };
    return { status: 'ok', message: errors ? `${errors} Fehlerzeilen, z. B.: ${sample.slice(0, 180)}` : `${lines.length} neue Zeilen, ${warns} Warnungen, keine Fehler`, metrics };
  },
};

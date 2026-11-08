import { q, q1 } from '../db/pool.js';
import type { CheckExecutor } from './types.js';
import { compact, m } from './types.js';

/** Self-monitoring: liveness of api/worker, scheduler lag and backlog, database health. */
export const platformCheck: CheckExecutor = {
  type: 'platform', label: 'Hermes Selbstüberwachung', category: 'Plattform', defaultInterval: 30,
  description: 'Heartbeats von API und Worker, Scheduler-Verzug, Check-Rückstau, DB-Latenz und -Verbindungen, Aufbewahrungs-/Downsampling-Jobs.',
  fields: [],
  defaultThresholds: [
    { metric: 'api_heartbeat_age_s', op: '>', warning: 30, critical: 90 },
    { metric: 'scheduler_lag_s', op: '>', warning: 30, critical: 120 },
    { metric: 'check_backlog', op: '>', warning: 10, critical: 50 },
    { metric: 'db_latency_ms', op: '>', warning: 100, critical: 1000 },
    { metric: 'db_connections_percent', op: '>', warning: 80, critical: 95 },
    { metric: 'failed_jobs', op: '>', warning: 0, critical: null },
  ],
  metrics: [
    { name: 'api_heartbeat_age_s', unit: 's', label: 'API-Heartbeat-Alter' }, { name: 'scheduler_lag_s', unit: 's', label: 'Scheduler-Verzug' },
    { name: 'check_backlog', unit: 'count', label: 'Check-Rückstau' }, { name: 'db_latency_ms', unit: 'ms', label: 'DB-Latenz' },
    { name: 'db_connections_percent', unit: 'percent', label: 'DB-Verbindungen' }, { name: 'db_size_bytes', unit: 'bytes', label: 'DB-Größe' },
    { name: 'results_per_min', unit: 'count', label: 'Check-Ergebnisse/min' }, { name: 'failed_jobs', unit: 'count', label: 'Fehlgeschlagene DB-Jobs' },
  ],
  async run() {
    const t0 = performance.now();
    await q('SELECT 1');
    const dbMs = performance.now() - t0;
    const hb = await q(`SELECT component, extract(epoch FROM now() - last_beat)::float AS age FROM platform_heartbeats`);
    const api = hb.find((h) => h.component === 'api');
    const s = await q1(`SELECT count(*) FILTER (WHERE c.next_run < now() - interval '10 seconds')::int AS backlog,
        COALESCE(max(extract(epoch FROM now() - c.next_run)) FILTER (WHERE c.next_run < now()), 0)::float AS lag
      FROM checks c JOIN resources r ON r.id = c.resource_id WHERE c.enabled AND r.monitoring_enabled AND c.type <> 'platform'`);
    const db = await q1(`SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::int AS conns, current_setting('max_connections')::int AS max,
      pg_database_size(current_database())::bigint AS size`);
    const rpm = await q1(`SELECT count(*)::int AS n FROM check_results WHERE time > now() - interval '1 minute'`);
    const jobs = await q1(`SELECT count(*)::int AS n FROM timescaledb_information.job_stats WHERE last_run_status = 'Failed' AND job_id >= 1000`).catch(() => ({ n: 0 }));
    const metrics = compact({
      api_heartbeat_age_s: m(api?.age, 's'), scheduler_lag_s: m(s?.lag, 's'), check_backlog: m(s?.backlog, 'count'), db_latency_ms: m(dbMs, 'ms'),
      db_connections_percent: m(db ? (db.conns / db.max) * 100 : null, 'percent'), db_size_bytes: m(Number(db?.size), 'bytes'), results_per_min: m(rpm?.n, 'count'), failed_jobs: m(jobs?.n, 'count'),
    });
    if (!api) return { status: 'critical', message: 'API meldet keinen Heartbeat', metrics };
    return { status: 'ok', message: `Worker aktiv, ${rpm?.n ?? 0} Ergebnisse/min, Rückstau ${s?.backlog ?? 0}, DB ${dbMs.toFixed(1)} ms`, metrics };
  },
};

import type { FastifyInstance } from 'fastify';
import { q, q1 } from '../../db/pool.js';
import { liveClientCount } from '../live.js';

/** Health of the monitoring platform itself. */
export default async function platformRoutes(app: FastifyInstance) {
  app.get('/api/platform/health', async () => {
    const t0 = performance.now();
    await q('SELECT 1');
    const dbLatencyMs = performance.now() - t0;
    const components = await q(`SELECT component, instance, started_at, last_beat, info,
      extract(epoch FROM now() - last_beat)::float AS age_s FROM platform_heartbeats ORDER BY component`);
    const db = await q1(`SELECT pg_database_size(current_database())::bigint AS size_bytes,
      (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
      current_setting('max_connections')::int AS max_connections,
      (SELECT extversion FROM pg_extension WHERE extname = 'timescaledb') AS timescale_version,
      version() AS pg_version`);
    const hypertables = await q(`SELECT hypertable_name AS name, hypertable_size(format('%I.%I', hypertable_schema, hypertable_name)::regclass)::bigint AS size_bytes
      FROM timescaledb_information.hypertables ORDER BY 1`).catch(() => []);
    const jobs = await q(`SELECT j.job_id, j.application_name, j.proc_name, j.hypertable_name, j.schedule_interval::text, s.last_run_status, s.last_successful_finish, s.next_start, s.total_failures
      FROM timescaledb_information.jobs j LEFT JOIN timescaledb_information.job_stats s USING (job_id) WHERE j.job_id >= 1000 ORDER BY j.job_id`).catch(() => []);
    const scheduler = await q1(`SELECT
        count(*) FILTER (WHERE c.enabled AND r.monitoring_enabled)::int AS active_checks,
        count(*) FILTER (WHERE c.enabled AND r.monitoring_enabled AND c.next_run < now() - interval '10 seconds')::int AS overdue,
        COALESCE(max(extract(epoch FROM now() - c.next_run)) FILTER (WHERE c.enabled AND r.monitoring_enabled AND c.next_run < now()), 0)::float AS max_lag_s
      FROM checks c JOIN resources r ON r.id = c.resource_id`).catch(() => null);
    const throughput = await q1(`SELECT count(*)::int AS results_5m, COALESCE(avg(duration_ms),0)::float AS avg_duration_ms,
      count(*) FILTER (WHERE raw_state IN ('critical','unknown'))::int AS failing_5m
      FROM check_results WHERE time > now() - interval '5 minutes'`).catch(() => null);
    return { time: new Date().toISOString(), dbLatencyMs, components, db, hypertables, jobs, scheduler, throughput, sseClients: liveClientCount() };
  });
}

export async function navCountsRoute(app: FastifyInstance) {
  app.get('/api/nav-counts', async () => {
    const r = await q1(`SELECT
      (SELECT count(*)::int FROM discovery_candidates WHERE status = 'pending') AS discovery,
      (SELECT count(*)::int FROM incidents WHERE status = 'open') AS incidents,
      (SELECT count(*)::int FROM dependency_suggestions WHERE status = 'pending') AS suggestions`).catch(() => ({}));
    return r ?? {};
  });
}

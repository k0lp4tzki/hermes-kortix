import type { FastifyInstance } from 'fastify';
import { q, q1 } from '../../db/pool.js';

/** Aggregates for the Command Center: status tiles, platform liveness, state history. */
export default async function overviewRoutes(app: FastifyInstance) {
  app.get('/api/overview', async () => {
    const tiles = await q1(`SELECT
        count(*) FILTER (WHERE monitoring_enabled)::int AS monitored,
        count(*) FILTER (WHERE NOT monitoring_enabled)::int AS unmonitored,
        count(*) FILTER (WHERE monitoring_enabled AND status = 'ok')::int AS ok,
        count(*) FILTER (WHERE monitoring_enabled AND status = 'warning')::int AS warning,
        count(*) FILTER (WHERE monitoring_enabled AND status = 'critical')::int AS critical,
        count(*) FILTER (WHERE monitoring_enabled AND status = 'unknown')::int AS unknown,
        count(*) FILTER (WHERE monitoring_enabled AND status = 'pending')::int AS pending,
        count(*) FILTER (WHERE cardinality(impacted_by) > 0)::int AS impacted,
        count(*) FILTER (WHERE in_maintenance)::int AS in_maintenance,
        count(*) FILTER (WHERE kind IN ('host','vm','hypervisor','nas'))::int AS hosts,
        count(*) FILTER (WHERE kind = 'container')::int AS containers,
        count(*) FILTER (WHERE discovery_status IN ('missing','orphaned'))::int AS missing
      FROM resources`);
    const checks = await q1(`SELECT count(*) FILTER (WHERE c.enabled AND r.monitoring_enabled)::int AS active,
        count(*) FILTER (WHERE c.enabled AND r.monitoring_enabled AND c.state IN ('warning','critical'))::int AS failing,
        count(*) FILTER (WHERE c.flapping)::int AS flapping
      FROM checks c JOIN resources r ON r.id = c.resource_id`);
    const incidents = await q1(`SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
        count(*) FILTER (WHERE status = 'open' AND severity = 'critical')::int AS critical,
        count(*) FILTER (WHERE opened_at > now() - interval '24 hours')::int AS last_24h,
        COALESCE(sum(extract(epoch FROM COALESCE(resolved_at, now()) - opened_at)) FILTER (WHERE opened_at > now() - interval '7 days'), 0)::float AS downtime_7d_s
      FROM incidents`);
    const discovery = await q1(`SELECT (SELECT count(*)::int FROM discovery_candidates WHERE status = 'pending') AS pending, max(last_run_at) AS last_run,
      count(*) FILTER (WHERE last_error IS NOT NULL AND enabled)::int AS errors FROM discovery_sources`);
    const platform = await q(`SELECT component, extract(epoch FROM now() - last_beat)::float AS age_s, info FROM platform_heartbeats`);
    const platformResource = await q1(`SELECT id, status FROM resources WHERE kind = 'platform' AND metadata->>'system' = 'hermes'`);
    return { tiles, checks, incidents, discovery, platform, platformResource, time: new Date().toISOString() };
  });

  /** Non-OK check results over time (how the state of the lab changed). */
  app.get('/api/overview/history', async (req) => {
    const { hours } = req.query as { hours?: string };
    const h = Math.min(Math.max(Number(hours ?? 24), 1), 24 * 30);
    const bucket = Math.max(60, Math.round((h * 3600) / 96));
    return q(`SELECT extract(epoch FROM time_bucket(make_interval(secs => $2), time))::float AS t,
        count(*)::int AS total, count(*) FILTER (WHERE raw_state = 'warning')::int AS warning,
        count(*) FILTER (WHERE raw_state = 'critical')::int AS critical, count(*) FILTER (WHERE raw_state = 'unknown')::int AS unknown
      FROM check_results WHERE time > now() - make_interval(hours => $1) GROUP BY 1 ORDER BY 1`, [h, bucket]);
  });
}

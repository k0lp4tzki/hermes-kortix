import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notify, q, q1 } from '../../db/pool.js';
import { executors, plannedCheckTypes } from '../../checks/registry.js';
import { randomToken } from '../../lib/crypto.js';
import { audit, HttpError, requireRole } from '../auth.js';
import { notFound, parse } from '../util.js';

const threshold = z.object({ metric: z.string().min(1).max(200), op: z.enum(['>', '>=', '<', '<=', '==', '!=']), warning: z.number().nullable().optional(), critical: z.number().nullable().optional() });
const body = z.object({
  resource_id: z.string().uuid(),
  type: z.string(),
  name: z.string().min(1).max(200),
  config: z.record(z.any()).default({}),
  secret_id: z.string().uuid().nullable().optional(),
  interval_s: z.number().int().min(5).max(86400).optional(),
  timeout_ms: z.number().int().min(100).max(120000).default(10000),
  enabled: z.boolean().default(true),
  thresholds: z.array(threshold).max(50).optional(),
  fail_after: z.number().int().min(1).max(100).default(2),
  recover_after: z.number().int().min(1).max(100).default(2),
  hold_s: z.number().int().min(0).max(86400).default(0),
});

const CHECK_SELECT = `SELECT c.*, COALESCE(r.display_name, r.name) AS resource_name, r.kind AS resource_kind, r.monitoring_enabled AS resource_monitoring, s.name AS secret_name
  FROM checks c JOIN resources r ON r.id = c.resource_id LEFT JOIN secrets s ON s.id = c.secret_id`;

function strip(c: any) {
  // never leak executor carry-over data; keep unavailable reasons
  if (c?.last_metrics) {
    const { _carry, ...rest } = c.last_metrics;
    c.last_metrics = rest;
  }
  return c;
}

export default async function checkRoutes(app: FastifyInstance) {
  app.get('/api/check-types', async () => ({
    types: Object.values(executors).map((e) => ({ type: e.type, label: e.label, description: e.description, category: e.category, fields: e.fields, usesSecret: e.usesSecret ?? null,
      defaultInterval: e.defaultInterval, defaultThresholds: e.defaultThresholds, metrics: e.metrics })),
    planned: plannedCheckTypes,
  }));

  app.get('/api/checks', async (req) => {
    const { resource_id } = req.query as { resource_id?: string };
    return (await q(`${CHECK_SELECT} WHERE ($1::uuid IS NULL OR c.resource_id = $1) ORDER BY r.name, c.name`, [resource_id ?? null])).map(strip);
  });

  app.get('/api/checks/:id', async (req) => {
    const { id } = req.params as { id: string };
    const c = await q1(`${CHECK_SELECT} WHERE c.id = $1`, [id]);
    if (!c) notFound('Check');
    return strip(c);
  });

  app.get('/api/checks/:id/results', async (req) => {
    const { id } = req.params as { id: string };
    const { limit } = req.query as { limit?: string };
    return q(`SELECT time, raw_state, state, duration_ms, message FROM check_results WHERE check_id = $1 ORDER BY time DESC LIMIT $2`, [id, Math.min(Number(limit ?? 50), 500)]);
  });

  app.post('/api/checks', async (req) => {
    requireRole(req, 'operator');
    const b = parse(body, req.body);
    const ex = executors[b.type];
    if (!ex) throw new HttpError(400, `Unbekannter Check-Typ ${b.type}`);
    if (ex.usesSecret === 'required' && !b.secret_id) throw new HttpError(400, 'Dieser Check benötigt Zugangsdaten');
    if (!(await q1(`SELECT 1 FROM resources WHERE id = $1`, [b.resource_id]))) notFound('Ressource');
    const token = b.type === 'heartbeat' ? randomToken(18) : null;
    const row = await q1(`INSERT INTO checks(resource_id, type, name, config, secret_id, interval_s, timeout_ms, enabled, thresholds, fail_after, recover_after, hold_s, origin, push_token)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$13) RETURNING id`, [
      b.resource_id, b.type, b.name, b.config, b.secret_id ?? null, b.interval_s ?? ex.defaultInterval, b.timeout_ms, b.enabled, JSON.stringify(b.thresholds ?? ex.defaultThresholds),
      b.fail_after, b.recover_after, b.hold_s, token]);
    await q(`INSERT INTO events(resource_id, check_id, kind, message, actor) VALUES ($1,$2,'config',$3,$4)`, [b.resource_id, row!.id, `Check „${b.name}“ (${ex.label}) angelegt`, req.user!.username]);
    await audit(req, 'check.created', b.name, { type: b.type });
    await notify('inventory');
    return strip(await q1(`${CHECK_SELECT} WHERE c.id = $1`, [row!.id]));
  });

  app.put('/api/checks/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const b = parse(body.omit({ resource_id: true, type: true }), req.body);
    const cur = await q1(`SELECT * FROM checks WHERE id = $1`, [id]);
    if (!cur) notFound('Check');
    const ex = executors[cur.type];
    await q(`UPDATE checks SET name=$2, config=$3, secret_id=$4, interval_s=$5, timeout_ms=$6, enabled=$7, thresholds=$8, fail_after=$9, recover_after=$10, hold_s=$11,
      updated_at=now(), next_run = LEAST(next_run, now() + interval '2 seconds'),
      state = CASE WHEN $7 THEN state ELSE 'pending' END, soft_state = CASE WHEN $7 THEN soft_state ELSE NULL END, soft_count = CASE WHEN $7 THEN soft_count ELSE 0 END WHERE id = $1`,
      [id, b.name, b.config, b.secret_id ?? null, b.interval_s ?? ex?.defaultInterval ?? 60, b.timeout_ms, b.enabled, JSON.stringify(b.thresholds ?? []), b.fail_after, b.recover_after, b.hold_s]);
    await q(`INSERT INTO events(resource_id, check_id, kind, message, actor, data) VALUES ($1,$2,'config',$3,$4,$5)`,
      [cur.resource_id, id, `Check „${b.name}“ geändert${cur.enabled !== b.enabled ? (b.enabled ? ' (aktiviert)' : ' (deaktiviert)') : ''}`, req.user!.username, { thresholds: b.thresholds }]);
    await audit(req, 'check.updated', b.name);
    await notify('inventory');
    return strip(await q1(`${CHECK_SELECT} WHERE c.id = $1`, [id]));
  });

  app.delete('/api/checks/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const c = await q1(`DELETE FROM checks WHERE id = $1 RETURNING name, resource_id`, [id]);
    if (!c) notFound('Check');
    await q(`DELETE FROM metric_series WHERE check_id IS NULL AND resource_id = $1`, [c.resource_id]);
    await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'config',$2,$3)`, [c.resource_id, `Check „${c.name}“ gelöscht`, req.user!.username]);
    await audit(req, 'check.deleted', c.name);
    await notify('inventory');
    return { ok: true };
  });

  app.post('/api/checks/:id/run', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const c = await q1(`UPDATE checks SET next_run = now() WHERE id = $1 RETURNING name`, [id]);
    if (!c) notFound('Check');
    return { ok: true };
  });

  /** Push endpoint for heartbeat checks: GET/POST /api/push/<token>?status=ok|fail&msg=… (no login, token is the secret). */
  const push = async (req: any) => {
    const { token } = req.params as { token: string };
    const qs = { ...(req.query ?? {}), ...(typeof req.body === 'object' ? req.body : {}) } as { status?: string; msg?: string };
    const status = qs.status === 'fail' || qs.status === 'error' ? 'fail' : 'ok';
    const c = await q1(`UPDATE checks SET push_last_at = now(), push_last_status = $2, push_last_message = $3, next_run = now() WHERE push_token = $1 AND type = 'heartbeat' RETURNING id, name`,
      [token, status, qs.msg ? String(qs.msg).slice(0, 500) : null]);
    if (!c) throw new HttpError(404, 'Unbekanntes Token');
    return { ok: true, check: c.name, status };
  };
  app.get('/api/push/:token', push);
  app.post('/api/push/:token', push);

  /** Series available for a resource (drives the metrics tab). */
  app.get('/api/resources/:id/series', async (req) => {
    const { id } = req.params as { id: string };
    return q(`SELECT ms.metric, ms.unit, ms.label, ms.last_value, ms.last_time, ms.check_id, c.name AS check_name, c.type AS check_type
      FROM metric_series ms LEFT JOIN checks c ON c.id = ms.check_id WHERE ms.resource_id = $1 ORDER BY c.name, ms.metric`, [id]);
  });

  /**
   * Time series with automatic resolution: raw ≤ 6 h, 5-minute rollups ≤ 14 d, hourly beyond.
   * Rollups are real-time continuous aggregates, so recent data is included.
   */
  app.get('/api/metrics', async (req) => {
    const qs = req.query as { resource_id: string; metric: string; from?: string; to?: string; res?: string };
    if (!qs.resource_id || !qs.metric) throw new HttpError(400, 'resource_id und metric erforderlich');
    const to = qs.to ? new Date(qs.to) : new Date();
    const from = qs.from ? new Date(qs.from) : new Date(to.getTime() - 3600_000);
    const span = (to.getTime() - from.getTime()) / 1000;
    const metrics = qs.metric.split(',').slice(0, 12);
    const res = qs.res ?? (span <= 6 * 3600 ? 'raw' : span <= 14 * 86400 ? '5m' : '1h');
    let rows;
    if (res === 'raw') {
      rows = await q(`SELECT metric, extract(epoch FROM time)::float AS t, value AS v, value AS min, value AS max FROM metrics
        WHERE resource_id = $1 AND metric = ANY($2) AND time BETWEEN $3 AND $4 ORDER BY time`, [qs.resource_id, metrics, from, to]);
    } else {
      const view = res === '5m' ? 'metrics_5m' : 'metrics_1h';
      rows = await q(`SELECT metric, extract(epoch FROM bucket)::float AS t, avg AS v, min, max FROM ${view}
        WHERE resource_id = $1 AND metric = ANY($2) AND bucket BETWEEN $3 AND $4 ORDER BY bucket`, [qs.resource_id, metrics, from, to]);
    }
    const series: Record<string, { t: number[]; v: number[]; min: number[]; max: number[] }> = {};
    for (const m of metrics) series[m] = { t: [], v: [], min: [], max: [] };
    for (const r of rows) { const s = series[r.metric]; s.t.push(r.t); s.v.push(r.v); s.min.push(r.min); s.max.push(r.max); }
    return { from, to, resolution: res, series };
  });

  /** Check results as a state timeline (availability over time). */
  app.get('/api/resources/:id/availability', async (req) => {
    const { id } = req.params as { id: string };
    const { hours } = req.query as { hours?: string };
    const h = Math.min(Number(hours ?? 24), 24 * 90);
    return q(`SELECT time_bucket(make_interval(secs => $3), time) AS bucket,
        count(*) FILTER (WHERE raw_state = 'ok')::int AS ok, count(*) FILTER (WHERE raw_state = 'warning')::int AS warning,
        count(*) FILTER (WHERE raw_state = 'critical')::int AS critical, count(*) FILTER (WHERE raw_state = 'unknown')::int AS unknown
      FROM check_results WHERE resource_id = $1 AND time > now() - make_interval(hours => $2) GROUP BY 1 ORDER BY 1`, [id, h, Math.max(60, Math.round((h * 3600) / 96))]);
  });

  /** Top consumers across containers and hosts (latest values). */
  app.get('/api/top', async () => {
    const rows = await q(`SELECT ms.resource_id, COALESCE(r.display_name, r.name) AS name, r.kind, ms.metric, ms.last_value, ms.unit, ms.last_time
      FROM metric_series ms JOIN resources r ON r.id = ms.resource_id
      WHERE ms.metric IN ('cpu_percent', 'mem_used_bytes', 'net_rx_bps', 'net_tx_bps', 'blk_write_bps', 'mem_limit_percent') AND ms.last_time > now() - interval '10 minutes' AND r.monitoring_enabled`);
    const pick = (metric: string, kinds: string[]) => rows.filter((r) => r.metric === metric && kinds.includes(r.kind)).sort((a, b) => b.last_value - a.last_value).slice(0, 8);
    return {
      cpu: pick('cpu_percent', ['container']), memory: pick('mem_used_bytes', ['container']), net_rx: pick('net_rx_bps', ['container']), net_tx: pick('net_tx_bps', ['container']),
      disk_write: pick('blk_write_bps', ['container']), hosts_cpu: pick('cpu_percent', ['host', 'vm', 'hypervisor']), hosts_mem: rows.filter((r) => r.metric === 'mem_used_bytes' && r.kind === 'host'),
    };
  });
}

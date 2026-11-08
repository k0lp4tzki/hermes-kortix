import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notify, q, q1 } from '../../db/pool.js';
import { sendWebhook } from '../../alerting/webhook.js';
import { planBulkEdges } from '../../core/deps.js';
import { tx } from '../../db/pool.js';
import { audit, HttpError, requireRole } from '../auth.js';
import { notFound, parse } from '../util.js';

const DEP_TYPES = ['runs_on', 'depends_on', 'uses_db', 'uses_cache', 'uses_broker', 'proxied_by', 'resolves_via', 'backup_source', 'backup_storage', 'consumes_api', 'network_link', 'powered_by', 'uses_storage', 'other'] as const;
const depBody = z.object({
  from_id: z.string().uuid(), to_id: z.string().uuid(), type: z.enum(DEP_TYPES), strength: z.enum(['hard', 'soft']).default('hard'),
  attributes: z.object({ network: z.string().max(100).optional(), subnet: z.string().max(60).optional(), vlan: z.string().max(20).optional(), port: z.string().max(40).optional(), label: z.string().max(100).optional() }).partial().default({}),
  description: z.string().max(500).nullable().optional(),
});

const channelBody = z.object({
  name: z.string().min(1).max(100), type: z.literal('webhook').default('webhook'), enabled: z.boolean().default(true),
  config: z.object({ url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'nur http(s)'), method: z.enum(['POST', 'PUT']).default('POST'), headers: z.record(z.string()).default({}),
    hmac_secret_id: z.string().uuid().nullable().optional(), auth_secret_id: z.string().uuid().nullable().optional(), timeout_ms: z.number().int().min(500).max(60000).default(10000) }),
});
const ruleBody = z.object({
  name: z.string().min(1).max(200), priority: z.number().int().default(100), enabled: z.boolean().default(true),
  match: z.object({ min_severity: z.enum(['warning', 'critical']).optional(), kinds: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), environments: z.array(z.string()).optional(),
    criticalities: z.array(z.string()).optional(), groups: z.array(z.string()).optional(), resource_ids: z.array(z.string().uuid()).optional() }).default({}),
  channel_ids: z.array(z.string().uuid()).min(1, 'mindestens ein Kanal'), on_warning: z.boolean().default(true), on_critical: z.boolean().default(true), on_recovery: z.boolean().default(true),
  repeat_interval_s: z.number().int().min(0).max(7 * 86400).default(0), stop: z.boolean().default(false),
});
const maintBody = z.object({
  name: z.string().min(1).max(200), reason: z.string().max(1000).nullable().optional(), starts_at: z.string().datetime(), ends_at: z.string().datetime(),
  resource_ids: z.array(z.string().uuid()).default([]), match_tags: z.array(z.string()).default([]), include_dependents: z.boolean().default(true),
});

export default async function alertingRoutes(app: FastifyInstance) {
  // ---- dependencies & graph
  app.get('/api/dependencies', async (req) => {
    const { resource_id } = req.query as { resource_id?: string };
    return q(`SELECT d.*, COALESCE(f.display_name, f.name) AS from_name, f.kind AS from_kind, f.status AS from_status,
        COALESCE(t.display_name, t.name) AS to_name, t.kind AS to_kind, t.status AS to_status
      FROM dependencies d JOIN resources f ON f.id = d.from_id JOIN resources t ON t.id = d.to_id
      WHERE ($1::uuid IS NULL OR d.from_id = $1 OR d.to_id = $1) ORDER BY d.suppressed, from_name, to_name`, [resource_id ?? null]);
  });

  app.post('/api/dependencies', async (req) => {
    requireRole(req, 'operator');
    const b = parse(depBody, req.body);
    if (b.from_id === b.to_id) throw new HttpError(400, 'Eine Ressource kann nicht von sich selbst abhängen');
    const row = await q1(`INSERT INTO dependencies(from_id, to_id, type, strength, origin, attributes, description) VALUES ($1,$2,$3,$4,'manual',$5,$6)
      ON CONFLICT (from_id, to_id, type) DO UPDATE SET suppressed = false, strength = $4, attributes = $5, description = $6 RETURNING *`,
      [b.from_id, b.to_id, b.type, b.strength, b.attributes, b.description ?? null]);
    await q(`INSERT INTO events(resource_id, kind, message, actor) SELECT $1, 'config', 'Abhängigkeit hinzugefügt: ' || $3 || ' → ' || COALESCE(display_name, name), $2 FROM resources WHERE id = $4`,
      [b.from_id, req.user!.username, b.type, b.to_id]);
    await audit(req, 'dependency.created', `${b.from_id} → ${b.to_id}`, { type: b.type });
    await notify('inventory');
    return row;
  });

  /**
   * Batch: link (or unlink) many resources with one target, e.g. "all selected depend on the firewall".
   * Existing edges of the same type are updated; removed automatic edges are restored.
   */
  app.post('/api/dependencies/bulk', async (req) => {
    requireRole(req, 'operator');
    const b = parse(z.object({
      ids: z.array(z.string().uuid()).min(1).max(1000),
      target_id: z.string().uuid(),
      direction: z.enum(['selection_depends_on_target', 'target_depends_on_selection']).default('selection_depends_on_target'),
      action: z.enum(['add', 'remove']).default('add'),
      type: z.enum(DEP_TYPES),
      strength: z.enum(['hard', 'soft']).default('hard'),
      attributes: depBody.shape.attributes,
      description: z.string().max(500).nullable().optional(),
    }), req.body);
    const target = await q1(`SELECT id, COALESCE(display_name, name) AS label FROM resources WHERE id = $1`, [b.target_id]);
    if (!target) notFound('Ziel-Ressource');
    const known = new Set((await q(`SELECT id FROM resources WHERE id = ANY($1)`, [b.ids])).map((r) => r.id));
    const plan = planBulkEdges(b.ids.filter((id) => known.has(id)), b.target_id, b.direction);
    let changed = 0;
    await tx(async (c) => {
      for (const e of plan.edges) {
        if (b.action === 'add') {
          await q(`INSERT INTO dependencies(from_id, to_id, type, strength, origin, attributes, description) VALUES ($1,$2,$3,$4,'manual',$5,$6)
            ON CONFLICT (from_id, to_id, type) DO UPDATE SET suppressed = false, strength = $4, attributes = $5, description = COALESCE($6, dependencies.description)`,
            [e.from, e.to, b.type, b.strength, b.attributes, b.description ?? null], c);
          changed++;
        } else {
          // manual edges are deleted, automatic ones suppressed (discovery would re-create them)
          const del = await q(`DELETE FROM dependencies WHERE from_id = $1 AND to_id = $2 AND type = $3 AND origin = 'manual' RETURNING id`, [e.from, e.to, b.type], c);
          const sup = await q(`UPDATE dependencies SET suppressed = true WHERE from_id = $1 AND to_id = $2 AND type = $3 AND origin = 'auto' AND NOT suppressed RETURNING id`, [e.from, e.to, b.type], c);
          changed += del.length + sup.length;
        }
      }
      const verb = b.action === 'add' ? 'hinzugefügt' : 'entfernt';
      const msg = b.direction === 'selection_depends_on_target' ? `Abhängigkeit ${verb} (Stapel): ${b.type} → ${target.label}` : `Abhängigkeit ${verb} (Stapel): ${target.label} ${b.type} → diese Ressource`;
      for (const e of plan.edges) {
        const rid = b.direction === 'selection_depends_on_target' ? e.from : e.to;
        await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'config',$2,$3)`, [rid, msg, req.user!.username], c);
      }
    });
    await audit(req, `dependency.bulk_${b.action}`, target.label, { count: plan.edges.length, type: b.type, direction: b.direction });
    await notify('inventory');
    return { ok: true, edges: plan.edges.length, changed, skipped: plan.skipped.length };
  });

  app.patch('/api/dependencies/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const b = parse(depBody.pick({ type: true, strength: true, attributes: true, description: true }).partial(), req.body);
    const row = await q1(`UPDATE dependencies SET type = COALESCE($2, type), strength = COALESCE($3, strength), attributes = COALESCE($4, attributes), description = COALESCE($5, description)
      WHERE id = $1 RETURNING *`, [id, b.type ?? null, b.strength ?? null, b.attributes ?? null, b.description ?? null]);
    if (!row) notFound('Abhängigkeit');
    await notify('inventory');
    return row;
  });

  app.delete('/api/dependencies/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const d = await q1(`SELECT * FROM dependencies WHERE id = $1`, [id]);
    if (!d) notFound('Abhängigkeit');
    // automatic edges are suppressed (so discovery does not re-create them); manual ones are deleted
    if (d.origin === 'auto') await q(`UPDATE dependencies SET suppressed = true WHERE id = $1`, [id]);
    else await q(`DELETE FROM dependencies WHERE id = $1`, [id]);
    await audit(req, 'dependency.deleted', id);
    await notify('inventory');
    return { ok: true };
  });

  app.post('/api/dependencies/:id/restore', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    await q(`UPDATE dependencies SET suppressed = false WHERE id = $1`, [id]);
    await notify('inventory');
    return { ok: true };
  });

  app.get('/api/graph', async () => {
    const nodes = await q(`SELECT r.id, COALESCE(r.display_name, r.name) AS label, r.name, r.kind, r.status, r.own_status, r.criticality, r.parent_id, r.group_name, r.environment,
        r.compose_project, r.tags, r.monitoring_enabled, r.root_cause_ids, r.impacted_by, r.in_maintenance, r.status_since, r.last_change_at, r.status_message, r.metadata,
        r.connection->>'host' AS address, r.discovery_status,
        (SELECT i.id FROM incidents i WHERE i.status = 'open' AND i.resource_id = r.id) AS incident_id,
        (SELECT json_object_agg(ms.metric, ms.last_value) FROM metric_series ms WHERE ms.resource_id = r.id AND ms.metric IN ('cpu_percent', 'mem_used_percent', 'mem_used_bytes', 'mem_limit_percent', 'response_ms', 'query_ms', 'rtt_avg_ms')) AS vitals
      FROM resources r`);
    const edges = await q(`SELECT d.id, d.from_id, d.to_id, d.type, d.strength, d.origin, d.attributes, d.description FROM dependencies d WHERE NOT d.suppressed`);
    return { nodes, edges };
  });

  // ---- incidents
  app.get('/api/incidents', async (req) => {
    const { status, resource_id, limit } = req.query as { status?: string; resource_id?: string; limit?: string };
    return q(`SELECT i.*, COALESCE(r.display_name, r.name) AS resource_name, r.kind AS resource_kind, r.criticality,
        (SELECT count(*)::int FROM notifications n WHERE n.incident_id = i.id AND n.status = 'sent') AS notifications_sent
      FROM incidents i LEFT JOIN resources r ON r.id = i.resource_id
      WHERE ($1::text IS NULL OR i.status = $1) AND ($2::uuid IS NULL OR i.resource_id = $2 OR $2 = ANY(i.affected_ids) OR $2 = ANY(i.suppressed_ids))
      ORDER BY (i.status = 'open') DESC, CASE i.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, i.opened_at DESC LIMIT $3`,
      [status ?? null, resource_id ?? null, Math.min(Number(limit ?? 200), 1000)]);
  });

  app.get('/api/incidents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const i = await q1(`SELECT i.*, COALESCE(r.display_name, r.name) AS resource_name, r.kind AS resource_kind, r.criticality FROM incidents i LEFT JOIN resources r ON r.id = i.resource_id WHERE i.id = $1`, [id]);
    if (!i) notFound('Störung');
    const ids = [...(i.affected_ids ?? []), ...(i.suppressed_ids ?? [])];
    const related = ids.length ? await q(`SELECT id, COALESCE(display_name, name) AS name, kind, status FROM resources WHERE id = ANY($1)`, [ids]) : [];
    const timeline = await q(`SELECT e.*, COALESCE(r.display_name, r.name) AS resource_name FROM events e LEFT JOIN resources r ON r.id = e.resource_id
      WHERE e.incident_id = $1 OR (e.resource_id = ANY($2) AND e.time BETWEEN $3::timestamptz - interval '10 minutes' AND COALESCE($4::timestamptz, now()) AND e.kind IN ('state_change','recovery','flapping','discovery_change','recreated','config','monitoring','maintenance','discovery_missing'))
      ORDER BY e.time DESC LIMIT 300`, [id, [i.resource_id, ...ids], i.opened_at, i.resolved_at]);
    const notifications = await q(`SELECT n.id, n.time, n.event, n.status, n.reason, n.http_status, n.duration_ms, c.name AS channel_name, r.name AS rule_name
      FROM notifications n LEFT JOIN notification_channels c ON c.id = n.channel_id LEFT JOIN routing_rules r ON r.id = n.rule_id WHERE n.incident_id = $1 ORDER BY n.time DESC`, [id]);
    const history = await q(`SELECT id, status, severity, opened_at, resolved_at FROM incidents WHERE resource_id = $1 ORDER BY opened_at DESC LIMIT 30`, [i.resource_id]);
    return { ...i, related, timeline, notifications, history };
  });

  app.post('/api/incidents/:id/ack', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const i = await q1(`UPDATE incidents SET acknowledged_by = $2, acknowledged_at = now(), last_change_at = now() WHERE id = $1 AND status = 'open' RETURNING resource_id`, [id, req.user!.username]);
    if (!i) throw new HttpError(400, 'Störung nicht offen');
    await q(`INSERT INTO events(resource_id, incident_id, kind, message, actor) VALUES ($1,$2,'incident_ack','Störung bestätigt – keine Erinnerungen mehr',$3)`, [i.resource_id, id, req.user!.username]);
    await notify('incidents');
    return { ok: true };
  });

  // ---- notification channels, routing, log
  app.get('/api/notifications/channels', async () => q(`SELECT c.*, (SELECT count(*)::int FROM notifications n WHERE n.channel_id = c.id AND n.time > now() - interval '7 days') AS sent_7d FROM notification_channels c ORDER BY name`));

  app.post('/api/notifications/channels', async (req) => {
    requireRole(req, 'operator');
    const b = parse(channelBody, req.body);
    const row = await q1(`INSERT INTO notification_channels(name, type, config, enabled) VALUES ($1,$2,$3,$4) RETURNING *`, [b.name, b.type, b.config, b.enabled]);
    await audit(req, 'channel.created', b.name);
    return row;
  });

  app.put('/api/notifications/channels/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const b = parse(channelBody, req.body);
    const row = await q1(`UPDATE notification_channels SET name = $2, config = $3, enabled = $4 WHERE id = $1 RETURNING *`, [id, b.name, b.config, b.enabled]);
    if (!row) notFound('Kanal');
    await audit(req, 'channel.updated', b.name);
    return row;
  });

  app.delete('/api/notifications/channels/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    await q(`UPDATE routing_rules SET channel_ids = array_remove(channel_ids, $1::uuid)`, [id]);
    const c = await q1(`DELETE FROM notification_channels WHERE id = $1 RETURNING name`, [id]);
    if (!c) notFound('Kanal');
    await audit(req, 'channel.deleted', c.name);
    return { ok: true };
  });

  app.post('/api/notifications/channels/:id/test', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const ch = await q1(`SELECT * FROM notification_channels WHERE id = $1`, [id]);
    if (!ch) notFound('Kanal');
    const payload = { version: 1, source: 'hermes', event: 'test', timestamp: new Date().toISOString(), message: `Testnachricht von Hermes (ausgelöst von ${req.user!.username})`, dedup_key: `hermes:test:${Date.now()}` };
    const r = await sendWebhook(ch, payload);
    await q(`INSERT INTO notifications(channel_id, event, status, reason, http_status, duration_ms, payload) VALUES ($1,'test',$2,$3,$4,$5,$6)`, [id, r.ok ? 'sent' : 'failed', r.error, r.status, r.durationMs, payload]);
    await q(`UPDATE notification_channels SET last_status = $2, last_sent_at = now() WHERE id = $1`, [id, r.ok ? 'ok' : r.error]);
    return r;
  });

  app.get('/api/notifications/rules', async () => q(`SELECT * FROM routing_rules ORDER BY priority, name`));

  app.post('/api/notifications/rules', async (req) => {
    requireRole(req, 'operator');
    const b = parse(ruleBody, req.body);
    const row = await q1(`INSERT INTO routing_rules(name, priority, enabled, match, channel_ids, on_warning, on_critical, on_recovery, repeat_interval_s, stop) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [b.name, b.priority, b.enabled, b.match, b.channel_ids, b.on_warning, b.on_critical, b.on_recovery, b.repeat_interval_s, b.stop]);
    await audit(req, 'routing.created', b.name);
    return row;
  });

  app.put('/api/notifications/rules/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const b = parse(ruleBody, req.body);
    const row = await q1(`UPDATE routing_rules SET name=$2, priority=$3, enabled=$4, match=$5, channel_ids=$6, on_warning=$7, on_critical=$8, on_recovery=$9, repeat_interval_s=$10, stop=$11 WHERE id=$1 RETURNING *`,
      [id, b.name, b.priority, b.enabled, b.match, b.channel_ids, b.on_warning, b.on_critical, b.on_recovery, b.repeat_interval_s, b.stop]);
    if (!row) notFound('Regel');
    await audit(req, 'routing.updated', b.name);
    return row;
  });

  app.delete('/api/notifications/rules/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const r = await q1(`DELETE FROM routing_rules WHERE id = $1 RETURNING name`, [id]);
    if (!r) notFound('Regel');
    await audit(req, 'routing.deleted', r.name);
    return { ok: true };
  });

  app.get('/api/notifications/log', async () => q(`SELECT n.id, n.time, n.event, n.status, n.reason, n.http_status, n.duration_ms, n.incident_id, c.name AS channel_name, r.name AS rule_name, i.title AS incident_title
    FROM notifications n LEFT JOIN notification_channels c ON c.id = n.channel_id LEFT JOIN routing_rules r ON r.id = n.rule_id LEFT JOIN incidents i ON i.id = n.incident_id
    ORDER BY n.time DESC LIMIT 300`));

  app.get('/api/notifications/log/:id', async (req) => {
    const { id } = req.params as { id: string };
    return q1(`SELECT * FROM notifications WHERE id = $1`, [id]);
  });

  // ---- maintenance / silences
  app.get('/api/maintenance', async () => q(`SELECT m.*, (m.starts_at <= now() AND m.ends_at > now()) AS active,
      (SELECT array_agg(COALESCE(r.display_name, r.name)) FROM resources r WHERE r.id = ANY(m.resource_ids)) AS resource_names
    FROM maintenance_windows m WHERE m.ends_at > now() - interval '30 days' ORDER BY m.ends_at DESC`));

  app.post('/api/maintenance', async (req) => {
    requireRole(req, 'operator');
    const b = parse(maintBody, req.body);
    if (new Date(b.ends_at) <= new Date(b.starts_at)) throw new HttpError(400, 'Ende muss nach dem Beginn liegen');
    if (!b.resource_ids.length && !b.match_tags.length) throw new HttpError(400, 'Mindestens eine Ressource oder ein Tag wählen');
    const row = await q1(`INSERT INTO maintenance_windows(name, reason, starts_at, ends_at, resource_ids, match_tags, include_dependents, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.name, b.reason ?? null, b.starts_at, b.ends_at, b.resource_ids, b.match_tags, b.include_dependents, req.user!.username]);
    await audit(req, 'maintenance.created', b.name, b);
    await notify('state');
    return row;
  });

  app.post('/api/maintenance/:id/end', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    await q(`UPDATE maintenance_windows SET ends_at = GREATEST(starts_at + interval '1 second', now()) WHERE id = $1`, [id]);
    await notify('state');
    return { ok: true };
  });

  app.delete('/api/maintenance/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    await q(`DELETE FROM maintenance_windows WHERE id = $1`, [id]);
    return { ok: true };
  });
}

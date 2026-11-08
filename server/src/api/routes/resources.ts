import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notify, pool, q, q1, tx } from '../../db/pool.js';
import { findDuplicates, itemIps } from '../../core/reconcile.js';
import { RESOURCE_KINDS } from '../../core/types.js';
import { audit, HttpError, requireRole } from '../auth.js';
import { notFound, parse } from '../util.js';
import { createChecks } from '../../checks/defaults.js';
import { mergeResources } from '../../inventory/merge.js';

const kind = z.enum(RESOURCE_KINDS as [string, ...string[]]);
const crit = z.enum(['low', 'medium', 'high', 'critical']);
const editable = z.object({
  name: z.string().min(1).max(200),
  display_name: z.string().max(200).nullable(),
  kind,
  parent_id: z.string().uuid().nullable(),
  environment: z.string().max(100).nullable(),
  group_name: z.string().max(100).nullable(),
  criticality: crit,
  owner: z.string().max(100).nullable(),
  tags: z.array(z.string().min(1).max(60)).max(50),
  metadata: z.record(z.string()),
  connection: z.record(z.any()),
  notes: z.string().max(5000).nullable(),
  monitoring_enabled: z.boolean(),
});

/** SQL used by list and detail: one row per resource with the fields the inventory needs. */
export const RESOURCE_SELECT = `
  SELECT r.*, COALESCE(r.display_name, r.name) AS label, p.name AS parent_name, p.kind AS parent_kind,
    (SELECT count(*)::int FROM resources ch WHERE ch.parent_id = r.id) AS child_count,
    (SELECT count(*)::int FROM checks c WHERE c.resource_id = r.id) AS check_count,
    (SELECT count(*)::int FROM checks c WHERE c.resource_id = r.id AND c.enabled) AS active_check_count,
    (SELECT count(*)::int FROM incidents i WHERE i.status = 'open' AND (i.resource_id = r.id OR r.id = ANY(i.affected_ids))) AS open_incidents,
    s.name AS source_name
  FROM resources r
  LEFT JOIN resources p ON p.id = r.parent_id
  LEFT JOIN discovery_sources s ON s.id = r.source_id`;

export default async function resourceRoutes(app: FastifyInstance) {
  app.get('/api/resources', async () => q(`${RESOURCE_SELECT} ORDER BY COALESCE(p.name, r.name), r.kind, r.name`));

  app.get('/api/resources/duplicates', async () => {
    const rows = await q(`SELECT id, name, COALESCE(display_name, name) AS label, kind, origin, connection->>'host' AS host, connection->>'port' AS port,
      discovered->>'container_id' AS container_id, connection->>'url' AS url, discovered, connection FROM resources`);
    const dismissed = new Set<string>(((await q1(`SELECT value FROM settings WHERE key = 'dismissed_duplicates'`))?.value ?? []) as string[]);
    const groups = findDuplicates(rows.map((r) => ({ id: r.id, name: r.label, kind: r.kind, containerId: r.container_id, ips: itemIps(r.discovered, r.connection), address: r.url ?? (r.host && r.port ? `${r.host}:${r.port}` : null) })))
      .filter((g) => !dismissed.has([...g.ids].sort().join(',')));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return groups.map((g) => ({ ...g, key: [...g.ids].sort().join(','), resources: g.ids.map((id) => { const { discovered, connection, ...r } = byId.get(id); void discovered; void connection; return r; }) }));
  });

  app.post('/api/resources/duplicates/dismiss', async (req) => {
    requireRole(req, 'operator');
    const { key } = parse(z.object({ key: z.string().min(3) }), req.body);
    await q(`INSERT INTO settings(key, value) VALUES ('dismissed_duplicates', $1::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = settings.value || $1::jsonb, updated_at = now()`, [JSON.stringify([key])]);
    return { ok: true };
  });

  app.get('/api/resources/:id', async (req) => {
    const { id } = req.params as { id: string };
    const r = await q1(`${RESOURCE_SELECT} WHERE r.id = $1`, [id]);
    if (!r) notFound('Ressource');
    const children = await q(`SELECT id, name, COALESCE(display_name, name) AS label, kind, status, monitoring_enabled FROM resources WHERE parent_id = $1 ORDER BY name`, [id]);
    const aliases = await q(`SELECT identity_key, created_at FROM resource_aliases WHERE resource_id = $1`, [id]);
    return { ...r, children, aliases };
  });

  app.post('/api/resources', async (req) => {
    requireRole(req, 'operator');
    const b = parse(editable.partial().required({ name: true, kind: true }).extend({ default_checks: z.boolean().optional() }), req.body);
    const row = await q1(`INSERT INTO resources(kind, name, display_name, parent_id, environment, group_name, criticality, owner, tags, metadata, connection, notes,
        origin, monitoring_enabled, status, first_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual',$13,$14, now()) RETURNING id`, [
      b.kind, b.name, b.display_name ?? null, b.parent_id ?? null, b.environment ?? null, b.group_name ?? null, b.criticality ?? 'medium', b.owner ?? null,
      b.tags ?? [], b.metadata ?? {}, b.connection ?? {}, b.notes ?? null, b.monitoring_enabled ?? true, (b.monitoring_enabled ?? true) ? 'pending' : 'unmonitored']);
    await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'config','Manuell angelegt',$2)`, [row!.id, req.user!.username]);
    if (b.default_checks) {
      // reachability checks from the connection data a person entered: ping for an address, HTTP + TLS for a URL, TCP for a port
      const c = b.connection ?? {};
      const tpl: Array<{ type: string; name: string; config?: Record<string, unknown> }> = [];
      if (c.host) tpl.push({ type: 'ping', name: 'Erreichbarkeit (Ping)' });
      if (c.host && c.port) tpl.push({ type: 'tcp', name: `TCP :${c.port}` });
      if (c.url) {
        tpl.push({ type: 'http', name: 'HTTP-Endpunkt', config: { url: c.url } });
        if (String(c.url).startsWith('https://')) tpl.push({ type: 'tls', name: 'TLS-Zertifikat', config: { host: new URL(String(c.url)).hostname, port: Number(new URL(String(c.url)).port || 443) } });
      }
      await createChecks(pool, row!.id, tpl, 'manual');
    }
    await audit(req, 'resource.created', b.name, { kind: b.kind });
    await notify('inventory');
    return q1(`${RESOURCE_SELECT} WHERE r.id = $1`, [row!.id]);
  });

  app.patch('/api/resources/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const b = parse(editable.partial(), req.body);
    const cur = await q1(`SELECT * FROM resources WHERE id = $1`, [id]);
    if (!cur) notFound('Ressource');
    if (b.parent_id === id) throw new HttpError(400, 'Eine Ressource kann nicht ihr eigenes übergeordnetes System sein');
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const changed: string[] = [];
    for (const [k, v] of Object.entries(b)) {
      if (k === 'monitoring_enabled') continue;
      if (JSON.stringify(cur[k]) === JSON.stringify(v)) continue;
      vals.push(v);
      sets.push(`${k} = $${vals.length}`);
      changed.push(k);
    }
    if (changed.length) {
      // fields a person edited are owned by them from now on: discovery will not overwrite them
      vals.push(changed);
      sets.push(`locked_fields = ARRAY(SELECT DISTINCT unnest(locked_fields || $${vals.length}::text[]))`);
      await q(`UPDATE resources SET ${sets.join(', ')}, updated_at = now(), last_change_at = now() WHERE id = $1`, vals);
      await q(`INSERT INTO events(resource_id, kind, message, actor, data) VALUES ($1,'config',$2,$3,$4)`, [id, `Konfiguration geändert: ${changed.join(', ')}`, req.user!.username, { fields: changed }]);
    }
    if (b.monitoring_enabled !== undefined && b.monitoring_enabled !== cur.monitoring_enabled) await setMonitoring([id], b.monitoring_enabled, req.user!.username);
    await audit(req, 'resource.updated', cur.name, { fields: changed });
    await notify('inventory');
    return q1(`${RESOURCE_SELECT} WHERE r.id = $1`, [id]);
  });

  app.post('/api/resources/:id/unlock', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const { field } = parse(z.object({ field: z.string() }), req.body);
    await q(`UPDATE resources SET locked_fields = array_remove(locked_fields, $2) WHERE id = $1`, [id, field]);
    return { ok: true };
  });

  app.delete('/api/resources/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const r = await q1(`DELETE FROM resources WHERE id = $1 RETURNING name, identity_key, source_id`, [id]);
    if (!r) notFound('Ressource');
    // keep discovery from re-adding it silently: the candidate goes back to the inbox
    if (r.identity_key) await q(`UPDATE discovery_candidates SET status = 'pending', resource_id = NULL WHERE identity_key = $1`, [r.identity_key]);
    await audit(req, 'resource.deleted', r.name);
    await notify('inventory');
    return { ok: true };
  });

  app.post('/api/resources/bulk', async (req) => {
    requireRole(req, 'operator');
    const b = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(1000), action: z.enum(['enable_monitoring', 'disable_monitoring', 'delete', 'set']),
      set: z.object({ environment: z.string().nullable(), group_name: z.string().nullable(), criticality: crit, owner: z.string().nullable(), add_tags: z.array(z.string()) }).partial().optional() }), req.body);
    if (b.action === 'enable_monitoring' || b.action === 'disable_monitoring') await setMonitoring(b.ids, b.action === 'enable_monitoring', req.user!.username);
    if (b.action === 'delete') {
      const del = await q(`DELETE FROM resources WHERE id = ANY($1) RETURNING identity_key`, [b.ids]);
      await q(`UPDATE discovery_candidates SET status = 'pending', resource_id = NULL WHERE identity_key = ANY($1)`, [del.map((d) => d.identity_key).filter(Boolean)]);
    }
    if (b.action === 'set' && b.set) {
      const s = b.set;
      const fields = Object.keys(s).filter((k) => k !== 'add_tags');
      await q(`UPDATE resources SET environment = CASE WHEN $2 THEN $3 ELSE environment END, group_name = CASE WHEN $4 THEN $5 ELSE group_name END,
          criticality = COALESCE($6, criticality), owner = CASE WHEN $7 THEN $8 ELSE owner END,
          tags = ARRAY(SELECT DISTINCT unnest(tags || $9::text[])), locked_fields = ARRAY(SELECT DISTINCT unnest(locked_fields || $10::text[])), updated_at = now(), last_change_at = now()
        WHERE id = ANY($1)`, [b.ids, 'environment' in s, s.environment ?? null, 'group_name' in s, s.group_name ?? null, s.criticality ?? null, 'owner' in s, s.owner ?? null,
        s.add_tags ?? [], [...fields, ...(s.add_tags?.length ? ['tags'] : [])]]);
    }
    await audit(req, `resource.bulk_${b.action}`, `${b.ids.length} Ressourcen`);
    await notify('inventory');
    return { ok: true, count: b.ids.length };
  });

  /** Take a discovered resource out of discovery management (keeps it as manual). */
  app.post('/api/resources/:id/detach', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const r = await q1(`UPDATE resources SET origin = 'manual', discovery_status = 'detached', updated_at = now() WHERE id = $1 RETURNING name`, [id]);
    if (!r) notFound('Ressource');
    await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'config','Von der Discovery gelöst: wird jetzt manuell verwaltet',$2)`, [id, req.user!.username]);
    await notify('inventory');
    return { ok: true };
  });

  /** Merge `source_id` into `:id`: checks, dependencies, events, tags and identity move to the survivor. */
  app.post('/api/resources/:id/merge', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const { source_id } = parse(z.object({ source_id: z.string().uuid() }), req.body);
    if (source_id === id) throw new HttpError(400, 'Quelle und Ziel sind identisch');
    await tx(async (c) => { if (!(await mergeResources(c, id, source_id, req.user!.username))) notFound('Ressource'); });
    await audit(req, 'resource.merged', id, { source_id });
    await notify('inventory');
    return q1(`${RESOURCE_SELECT} WHERE r.id = $1`, [id]);
  });

  app.get('/api/events', async (req) => {
    const qs = req.query as { resource_id?: string; limit?: string; kind?: string; severity?: string; incident_id?: string; before?: string };
    const limit = Math.min(Number(qs.limit ?? 100), 1000);
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (qs.resource_id) { vals.push(qs.resource_id); conds.push(`e.resource_id = $${vals.length}`); }
    if (qs.incident_id) { vals.push(qs.incident_id); conds.push(`e.incident_id = $${vals.length}`); }
    if (qs.kind) { vals.push(qs.kind.split(',')); conds.push(`e.kind = ANY($${vals.length})`); }
    if (qs.severity) { vals.push(qs.severity.split(',')); conds.push(`e.severity = ANY($${vals.length})`); }
    if (qs.before) { vals.push(qs.before); conds.push(`e.time < $${vals.length}`); }
    vals.push(limit);
    return q(`SELECT e.*, COALESCE(r.display_name, r.name) AS resource_name, r.kind AS resource_kind FROM events e LEFT JOIN resources r ON r.id = e.resource_id
      ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY e.time DESC, e.id DESC LIMIT $${vals.length}`, vals);
  });
}

export async function setMonitoring(ids: string[], enabled: boolean, actor: string) {
  const rows = await q(`UPDATE resources SET monitoring_enabled = $2,
      status = CASE WHEN $2 THEN (CASE WHEN status = 'unmonitored' THEN 'pending' ELSE status END) ELSE 'unmonitored' END,
      status_since = CASE WHEN monitoring_enabled <> $2 THEN now() ELSE status_since END, last_change_at = now()
    WHERE id = ANY($1) AND monitoring_enabled <> $2 RETURNING id`, [ids, enabled]);
  for (const r of rows) {
    await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'monitoring',$2,$3)`, [r.id, enabled ? 'Überwachung aktiviert' : 'Überwachung deaktiviert', actor]);
  }
  // due immediately after activation
  if (enabled) await q(`UPDATE checks SET next_run = now() WHERE resource_id = ANY($1)`, [ids]).catch(() => {});
}

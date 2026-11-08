import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notify, q, q1, tx } from '../../db/pool.js';
import { createChecks } from '../../checks/defaults.js';
import { mergeResources } from '../../inventory/merge.js';
import { audit, HttpError, requireRole } from '../auth.js';
import { notFound, parse } from '../util.js';

const LAYER: Record<string, number> = { wan: 0, router: 1, firewall: 1, switch: 2, access_point: 2, network: 2, dns: 3, dhcp: 3, hypervisor: 4, host: 5, vm: 6, platform: 7, container: 8, nas: 10, storage: 10 };

export default async function suggestionRoutes(app: FastifyInstance) {
  app.get('/api/suggestions', async (req) => {
    const { status } = req.query as { status?: string };
    const rows = await q(`SELECT s.*, COALESCE(f.display_name, f.name) AS from_name, f.kind AS from_kind, f.status AS from_status,
        COALESCE(t.display_name, t.name) AS to_name, t.kind AS to_kind, t.status AS to_status
      FROM dependency_suggestions s JOIN resources f ON f.id = s.from_id LEFT JOIN resources t ON t.id = s.to_id
      WHERE s.status = COALESCE($1, 'pending') ORDER BY s.last_seen_at DESC LIMIT 1000`, [status ?? null]);
    // walkthrough order: from the network edge inwards (provider layer first), then confidence
    const conf = { sure: 0, evidence: 1, hint: 2 } as Record<string, number>;
    const META_ORDER: Record<string, number> = { remove_edge: 0, same_as: 1, set_kind: 2 };
    return rows.sort((a, b) => (META_ORDER[a.type] ?? 3) - (META_ORDER[b.type] ?? 3) || (LAYER[a.to_kind ?? a.target?.kind] ?? 9) - (LAYER[b.to_kind ?? b.target?.kind] ?? 9) || conf[a.confidence] - conf[b.confidence] || a.from_name.localeCompare(b.from_name));
  });

  app.post('/api/suggestions/analyze', async (req) => {
    requireRole(req, 'operator');
    await q(`INSERT INTO settings(key, value) VALUES ('suggest_requested', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [{ at: new Date().toISOString() }]);
    return { ok: true };
  });

  const decide = z.object({ ids: z.array(z.string().uuid()).min(1).max(500), type: z.string().optional(), strength: z.enum(['hard', 'soft']).optional() });

  app.post('/api/suggestions/accept', async (req) => {
    requireRole(req, 'operator');
    const b = parse(decide, req.body);
    let created = 0, newResources = 0, merged = 0, removed = 0, reclassified = 0;
    await tx(async (c) => {
      const rows = await q(`SELECT * FROM dependency_suggestions WHERE id = ANY($1) AND status = 'pending' FOR UPDATE`, [b.ids], c);
      // several suggestions may point to the same unknown target: create it once
      const madeFor = new Map<string, string>();
      for (const s of rows) {
        if (s.type === 'remove_edge') {
          const d = await q1(`SELECT id, origin FROM dependencies WHERE id::text = $1`, [s.data?.dependency_id], c);
          if (d) {
            if (d.origin === 'auto') await q(`UPDATE dependencies SET suppressed = true WHERE id = $1`, [d.id], c);
            else await q(`DELETE FROM dependencies WHERE id = $1`, [d.id], c);
            await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'config',$2,$3)`, [s.from_id, `Abhängigkeit entfernt (Bereinigung): ${s.evidence}`.slice(0, 500), req.user!.username], c);
            removed++;
          }
          await q(`UPDATE dependency_suggestions SET status = 'accepted', decided_at = now(), decided_by = $2 WHERE id = $1`, [s.id, req.user!.username], c);
          continue;
        }
        if (s.type === 'set_kind') {
          const kind = String(s.data?.kind ?? 'router');
          await q(`UPDATE resources SET kind = $2, name = COALESCE($3, name), display_name = CASE WHEN $3::text IS NOT NULL AND display_name LIKE '\_gateway%' THEN NULL ELSE display_name END,
              locked_fields = ARRAY(SELECT DISTINCT unnest(locked_fields || '{kind}'::text[])), last_change_at = now(), updated_at = now() WHERE id = $1`, [s.from_id, kind, s.data?.rename ?? null], c);
          await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'config',$2,$3)`, [s.from_id, `Typ geändert auf ${kind}: ${s.evidence}`.slice(0, 500), req.user!.username], c);
          await q(`UPDATE dependency_suggestions SET status = 'accepted', decided_at = now(), decided_by = $2 WHERE id = $1`, [s.id, req.user!.username], c);
          reclassified++;
          continue;
        }
        if (s.type === 'same_as') {
          // same machine under two entries: merge the less specific one into the other
          if (s.to_id && (await mergeResources(c, s.to_id, s.from_id, req.user!.username))) merged++;
          await q(`UPDATE dependency_suggestions SET status = 'accepted', decided_at = now(), decided_by = $2 WHERE id = $1`, [s.id, req.user!.username], c).catch(() => {});
          continue;
        }
        let to = s.to_id as string | null;
        if (!to) {
          const t = s.target ?? {};
          if (!t.host) continue;
          const k = `${t.host}:${t.port ?? ''}`;
          to = madeFor.get(k) ?? (await q1(`SELECT id FROM resources WHERE connection->>'host' = $1 AND ($2::text IS NULL OR connection->>'port' = $2) LIMIT 1`, [t.host, t.port ? String(t.port) : null], c))?.id ?? null;
          if (!to) {
            const r = await q1(`INSERT INTO resources(kind, name, origin, connection, monitoring_enabled, status, first_seen_at, notes)
              VALUES ($1,$2,'manual',$3,true,'pending',now(),$4) RETURNING id`, [t.kind ?? 'endpoint', t.name ?? t.host, { host: t.host, ...(t.port ? { port: t.port } : {}) }, `Angelegt aus Abhängigkeitsvorschlag: ${s.evidence}`], c);
            to = r!.id;
            const tpl = [{ type: 'ping', name: 'Erreichbarkeit (Ping)' }, ...(t.port ? [{ type: 'tcp', name: `TCP :${t.port}` }] : [])];
            await createChecks(c, to!, tpl, 'manual');
            await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'config',$2,$3)`, [to, `Aus Abhängigkeitsvorschlag angelegt (${t.host}${t.port ? ':' + t.port : ''})`, req.user!.username], c);
            newResources++;
          }
          madeFor.set(k, to!);
        }
        if (to === s.from_id) continue;
        await q(`INSERT INTO dependencies(from_id, to_id, type, strength, origin, description) VALUES ($1,$2,$3,$4,'manual',$5)
          ON CONFLICT (from_id, to_id, type) DO UPDATE SET suppressed = false`, [s.from_id, to, b.type ?? s.type, b.strength ?? (s.confidence === 'hint' ? 'soft' : s.strength), `Vorschlag (${s.source}): ${s.evidence}`.slice(0, 500)], c);
        await q(`UPDATE dependency_suggestions SET status = 'accepted', to_id = $2, decided_at = now(), decided_by = $3 WHERE id = $1`, [s.id, to, req.user!.username], c);
        await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'config',$2,$3)`, [s.from_id, `Abhängigkeit aus Vorschlag übernommen: ${s.evidence}`.slice(0, 500), req.user!.username], c);
        created++;
      }
    });
    await audit(req, 'suggestion.accepted', `${created} Vorschläge`, { newResources, merged, removed, reclassified });
    await notify('inventory');
    await notify('suggestions');
    return { ok: true, created, newResources, merged, removed, reclassified };
  });

  app.post('/api/suggestions/reject', async (req) => {
    requireRole(req, 'operator');
    const b = parse(decide, req.body);
    const rows = await q(`UPDATE dependency_suggestions SET status = 'rejected', decided_at = now(), decided_by = $2 WHERE id = ANY($1) AND status = 'pending' RETURNING id`, [b.ids, req.user!.username]);
    await audit(req, 'suggestion.rejected', `${rows.length} Vorschläge`);
    await notify('suggestions');
    return { ok: true, count: rows.length };
  });

  app.post('/api/suggestions/:id/reset', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const r = await q1(`UPDATE dependency_suggestions SET status = 'pending', decided_at = NULL, decided_by = NULL WHERE id = $1 AND status = 'rejected' RETURNING id`, [id]);
    if (!r) throw new HttpError(400, 'Nur abgelehnte Vorschläge lassen sich zurücksetzen');
    await notify('suggestions');
    return { ok: true };
  });

  app.get('/api/suggestions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const s = await q1(`SELECT * FROM dependency_suggestions WHERE id = $1`, [id]);
    if (!s) notFound('Vorschlag');
    return s;
  });
}

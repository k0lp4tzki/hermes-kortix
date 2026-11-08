import type pg from 'pg';
import { q, q1, type Queryable } from '../db/pool.js';
import type { DiscoveredItem, DiscoveryRule } from '../core/types.js';
import { config } from '../lib/config.js';

export interface AcceptOptions {
  sourceId: string;
  enableMonitoring: boolean;
  set?: DiscoveryRule['set'];
  actor: string; // "regel:<name>" or username
  candidateId?: string;
}

/** Hook for M3: create default checks for a newly accepted resource. */
export type DefaultChecksHook = (db: Queryable, resourceId: string, item: DiscoveredItem) => Promise<void>;
let defaultChecksHook: DefaultChecksHook | null = null;
export function setDefaultChecksHook(h: DefaultChecksHook) { defaultChecksHook = h; }

export async function resolveIdentity(db: Queryable, key: string | undefined | null): Promise<string | null> {
  if (!key) return null;
  const r = await q1<{ id: string }>(`SELECT id FROM resources WHERE identity_key = $1 UNION ALL SELECT resource_id FROM resource_aliases WHERE identity_key = $1 LIMIT 1`, [key], db);
  return r?.id ?? null;
}

export function discoveredPayload(item: DiscoveredItem) {
  return { ...item.attributes, parent_key: item.parentIdentityKey ?? null, depends_on: item.dependsOn ?? [] };
}

/** Turns a discovered item into an inventory resource (auto-accept rule or approval in the inbox). */
export async function acceptItem(db: pg.PoolClient, item: DiscoveredItem, o: AcceptOptions): Promise<string> {
  const existing = await resolveIdentity(db, item.identityKey);
  if (existing) return existing;
  const parentId = await resolveIdentity(db, item.parentIdentityKey);
  const s = o.set ?? {};
  const row = await q1<{ id: string }>(
    `INSERT INTO resources(identity_key, kind, name, parent_id, environment, group_name, criticality, owner, tags, discovered, connection,
       origin, source_id, discovery_status, first_seen_at, last_seen_at, monitoring_enabled, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'auto',$12,'active',now(),now(),$13,$14) RETURNING id`,
    [item.identityKey, item.kind, item.name, parentId, s.environment ?? null, s.group_name ?? null, s.criticality ?? 'medium', s.owner ?? null,
      s.tags ?? [], discoveredPayload(item), item.connection ?? {}, o.sourceId, o.enableMonitoring, o.enableMonitoring ? 'pending' : 'unmonitored'], db);
  const id = row!.id;
  await q(`INSERT INTO events(resource_id, kind, severity, message, actor, data) VALUES ($1,'discovery_accepted','info',$2,$3,$4)`,
    [id, `${item.kind} „${item.name}“ ins Inventar übernommen${o.enableMonitoring ? ', Überwachung aktiv' : ', Überwachung aus'}`, o.actor, { identity_key: item.identityKey }], db);
  await q(`INSERT INTO discovery_candidates(source_id, identity_key, kind, name, parent_identity_key, proposed, status, resource_id, decided_at, decided_by)
           VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7,now(),$8)
           ON CONFLICT (source_id, identity_key) DO UPDATE SET status='accepted', resource_id=$7, decided_at=now(), decided_by=$8, proposed=$6, last_seen_at=now()`,
    [o.sourceId, item.identityKey, item.kind, item.name, item.parentIdentityKey ?? null, item, id, o.actor], db);
  if (defaultChecksHook) await defaultChecksHook(db, id, item);
  return id;
}

/**
 * Derives automatic edges from discovery facts: parent → "runs_on", compose depends_on → "depends_on".
 * Edges a person deleted stay suppressed; manual edges are never touched.
 */
export async function syncAutoStructure(db: Queryable) {
  // link children whose parent was accepted after them (unless the parent field was edited by hand)
  await q(`UPDATE resources c SET parent_id = p.id FROM resources p
           WHERE c.parent_id IS NULL AND NOT ('parent_id' = ANY(c.locked_fields)) AND c.discovered->>'parent_key' IS NOT NULL
             AND (p.identity_key = c.discovered->>'parent_key' OR p.id = (SELECT resource_id FROM resource_aliases a WHERE a.identity_key = c.discovered->>'parent_key'))`, [], db);
  // parent moved (VM migrated to another hypervisor, container on another engine): follow it
  await q(`UPDATE resources c SET parent_id = p.id, last_change_at = now() FROM resources p
           WHERE c.origin = 'auto' AND NOT ('parent_id' = ANY(c.locked_fields)) AND c.discovered->>'parent_key' IS NOT NULL
             AND p.identity_key = c.discovered->>'parent_key' AND c.parent_id IS DISTINCT FROM p.id`, [], db);
  await q(`DELETE FROM dependencies d USING resources c WHERE d.from_id = c.id AND d.type = 'runs_on' AND d.origin = 'auto' AND c.parent_id IS DISTINCT FROM d.to_id
             AND NOT ('parent_id' = ANY(c.locked_fields))`, [], db);
  await q(`INSERT INTO dependencies(from_id, to_id, type, strength, origin)
           SELECT c.id, c.parent_id, 'runs_on', 'hard', 'auto' FROM resources c
           WHERE c.parent_id IS NOT NULL AND c.origin = 'auto'
           ON CONFLICT (from_id, to_id, type) DO NOTHING`, [], db);
  await q(`INSERT INTO dependencies(from_id, to_id, type, strength, origin, description)
           SELECT r.id, t.id, 'depends_on', 'hard', 'auto', 'aus docker compose depends_on' FROM resources r
           CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r.discovered->'depends_on', '[]'::jsonb)) AS k(key)
           JOIN resources t ON t.identity_key = k.key OR t.id = (SELECT resource_id FROM resource_aliases a WHERE a.identity_key = k.key)
           WHERE t.id <> r.id
           ON CONFLICT (from_id, to_id, type) DO NOTHING`, [], db);
  // the platform resource depends on Hermes' own containers (self-monitoring topology)
  await q(`INSERT INTO dependencies(from_id, to_id, type, strength, origin, description)
           SELECT p.id, r.id, 'depends_on', 'hard', 'auto', 'Hermes-Komponente' FROM resources p JOIN resources r ON r.compose_project = $1 AND r.kind = 'container'
           WHERE p.kind = 'platform' AND p.metadata->>'system' = 'hermes'
           ON CONFLICT (from_id, to_id, type) DO NOTHING`, [config.composeProject], db);
}

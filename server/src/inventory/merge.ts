import type pg from 'pg';
import { q, q1 } from '../db/pool.js';

/**
 * Merges resource `sourceId` into `targetId` inside a transaction: checks, children, edges,
 * events, incidents and discovery identities move to the survivor; a generic kind
 * (endpoint/other) is upgraded to the more specific kind of the merged resource.
 * Returns false when one of them does not exist.
 */
export async function mergeResources(c: pg.PoolClient, targetId: string, sourceId: string, actor: string): Promise<boolean> {
      const target = await q1(`SELECT * FROM resources WHERE id = $1 FOR UPDATE`, [targetId], c);
      const src = await q1(`SELECT * FROM resources WHERE id = $1 FOR UPDATE`, [sourceId], c);
      if (!target || !src) return false;
      await q(`UPDATE checks SET resource_id = $1 WHERE resource_id = $2`, [targetId, sourceId], c);
      await q(`UPDATE resources SET parent_id = $1 WHERE parent_id = $2`, [targetId, sourceId], c);
      // re-point edges, dropping ones that would duplicate or self-loop
      await q(`DELETE FROM dependencies d WHERE (d.from_id = $2 AND (d.to_id = $1 OR EXISTS (SELECT 1 FROM dependencies x WHERE x.from_id = $1 AND x.to_id = d.to_id AND x.type = d.type)))
                 OR (d.to_id = $2 AND (d.from_id = $1 OR EXISTS (SELECT 1 FROM dependencies x WHERE x.to_id = $1 AND x.from_id = d.from_id AND x.type = d.type)))`, [targetId, sourceId], c);
      await q(`UPDATE dependencies SET from_id = $1 WHERE from_id = $2`, [targetId, sourceId], c);
      await q(`UPDATE dependencies SET to_id = $1 WHERE to_id = $2`, [targetId, sourceId], c);
      await q(`UPDATE events SET resource_id = $1 WHERE resource_id = $2`, [targetId, sourceId], c);
      await q(`UPDATE incidents SET resource_id = $1 WHERE resource_id = $2`, [targetId, sourceId], c);
      await q(`UPDATE resource_aliases SET resource_id = $1 WHERE resource_id = $2`, [targetId, sourceId], c);
      if (src.identity_key) {
        await q(`INSERT INTO resource_aliases(identity_key, resource_id) VALUES ($1, $2) ON CONFLICT (identity_key) DO UPDATE SET resource_id = $2`, [src.identity_key, targetId], c);
        await q(`UPDATE discovery_candidates SET resource_id = $1 WHERE identity_key = $2`, [targetId, src.identity_key], c);
      }
      // an auto resource merged into a manual one keeps feeding discovery data into the survivor
      await q(`UPDATE resources SET tags = ARRAY(SELECT DISTINCT unnest(tags || $2::text[])), metadata = $3::jsonb || metadata,
                 discovered = $4::jsonb || discovered,
                 source_id = COALESCE(source_id, $5), first_seen_at = LEAST(first_seen_at, $6), last_seen_at = GREATEST(last_seen_at, $7),
                 discovery_status = COALESCE(discovery_status, $8), monitoring_enabled = monitoring_enabled OR $9, updated_at = now(), last_change_at = now() WHERE id = $1`,
        [targetId, src.tags, src.metadata, src.discovered, src.source_id, src.first_seen_at, src.last_seen_at, src.discovery_status, src.monitoring_enabled], c);
      await q(`DELETE FROM resources WHERE id = $1`, [sourceId], c);
      await q(`INSERT INTO events(resource_id, kind, message, actor) VALUES ($1,'merge',$2,$3)`, [targetId, `„${src.name}“ (${src.kind}) wurde hier zusammengeführt`, actor], c);
    
  if (!(target.locked_fields ?? []).includes('kind') && ((['endpoint', 'other'].includes(target.kind) && !['endpoint', 'other'].includes(src.kind)) || (target.kind === 'host' && src.kind === 'vm'))) {
    await q(`UPDATE resources SET kind = $2 WHERE id = $1`, [targetId, src.kind], c);
  }
  return true;
}

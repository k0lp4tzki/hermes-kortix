import { pool, q, q1, tx, notify } from '../db/pool.js';
import { reconcile, itemIps, type ExistingResource, type ExistingCandidate } from '../core/reconcile.js';
import type { DiscoveryRule } from '../core/types.js';
import { adapters } from './registry.js';
import { acceptItem, discoveredPayload, syncAutoStructure } from './accept.js';
import { logger, errMsg } from '../lib/log.js';
import type { SourceRow } from './adapter.js';

const log = logger('discovery');

export async function loadRules(): Promise<DiscoveryRule[]> {
  return q<DiscoveryRule>(`SELECT id, name, priority, enabled, match, action, enable_monitoring, set FROM discovery_rules`);
}

function describeChange(field: string, from: unknown, to: unknown): string {
  const s = (v: unknown) => (v === null || v === undefined ? '–' : typeof v === 'object' ? JSON.stringify(v).slice(0, 120) : String(v).slice(0, 80));
  return `${field}: ${s(from)} → ${s(to)}`;
}

/** Runs one discovery source and applies the reconciliation plan. */
export async function runSource(source: SourceRow & { orphan_after_s: number }) {
  const adapter = adapters[source.type];
  const t0 = Date.now();
  if (!adapter) throw new Error(`unbekannter Discovery-Typ ${source.type}`);
  const unavailable = await adapter.availability(source);
  if (unavailable) {
    await q(`UPDATE discovery_sources SET last_run_at = now(), last_error = $2, last_duration_ms = $3 WHERE id = $1`, [source.id, `nicht verfügbar: ${unavailable}`, Date.now() - t0]);
    return;
  }
  let items;
  try {
    items = await adapter.discover(source);
  } catch (e) {
    await q(`UPDATE discovery_sources SET last_run_at = now(), last_error = $2, last_duration_ms = $3 WHERE id = $1`, [source.id, errMsg(e), Date.now() - t0]);
    throw e;
  }
  // parents first so children can be linked in the same run
  items.sort((a, b) => (a.parentIdentityKey ? 1 : 0) - (b.parentIdentityKey ? 1 : 0));

  const resources = await q<any>(`
    SELECT r.id, r.identity_key AS key, r.discovered, r.discovery_status, r.last_seen_at, r.source_id FROM resources r WHERE r.identity_key IS NOT NULL
    UNION ALL
    SELECT r.id, a.identity_key AS key, r.discovered, r.discovery_status, r.last_seen_at, r.source_id FROM resource_aliases a JOIN resources r ON r.id = a.resource_id`);
  const existing: ExistingResource[] = resources.map((r) => ({ id: r.id, identityKey: r.key, discovered: r.discovered, discoveryStatus: r.discovery_status, lastSeen: r.last_seen_at, sourceId: r.source_id }));
  const candidates: ExistingCandidate[] = (await q<any>(`SELECT id, identity_key, status FROM discovery_candidates WHERE source_id = $1`, [source.id]))
    .map((c) => ({ id: c.id, identityKey: c.identity_key, status: c.status }));
  const rules = await loadRules();
  // IP → resource for machines (not containers); addresses claimed by two resources are ambiguous and skipped
  const ipIndex = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const r of await q<any>(`SELECT id, discovered, connection FROM resources WHERE kind <> 'container' AND COALESCE(discovery_status, '') <> 'detached'`)) {
    for (const ip of itemIps(r.discovered, r.connection)) {
      if (ipIndex.has(ip) && ipIndex.get(ip) !== r.id) ambiguous.add(ip); else ipIndex.set(ip, r.id);
    }
  }
  for (const ip of ambiguous) ipIndex.delete(ip);
  const plan = reconcile({ items, resources: existing, candidates, rules, ctx: { sourceId: source.id, sourceType: source.type }, now: new Date(), orphanAfterMs: source.orphan_after_s * 1000, ipIndex });

  let created = 0, newPending = 0, changed = 0;
  await tx(async (c) => {
    for (const a of plan) {
      switch (a.type) {
        case 'update_resource': {
          await q(`UPDATE resources SET discovered = discovered || $2::jsonb, last_seen_at = now(), discovery_status = 'active',
                     name = CASE WHEN 'name' = ANY(locked_fields) THEN name ELSE $3 END,
                     connection = CASE WHEN 'connection' = ANY(locked_fields) THEN connection ELSE connection || $4::jsonb END,
                     last_change_at = CASE WHEN $5 THEN now() ELSE last_change_at END, updated_at = now()
                   WHERE id = $1`, [a.resourceId, discoveredPayload(a.item), a.item.name, a.item.connection ?? {}, a.changes.length > 0 || a.reappeared], c);
          if (a.recreated) {
            const ch = a.changes.find((x) => x.field === 'container_id')!;
            await q(`INSERT INTO events(resource_id, kind, severity, message, data) VALUES ($1,'recreated','info',$2,$3)`,
              [a.resourceId, `Container neu erstellt (${String(ch.from).slice(0, 12)} → ${String(ch.to).slice(0, 12)}); logischer Service bleibt erhalten`, { changes: a.changes }], c);
          }
          const other = a.changes.filter((x) => x.field !== 'container_id');
          if (other.length) {
            changed++;
            await q(`INSERT INTO events(resource_id, kind, severity, message, data) VALUES ($1,'discovery_change','info',$2,$3)`,
              [a.resourceId, `Geändert: ${other.map((x) => describeChange(x.field, x.from, x.to)).join('; ')}`, { changes: other }], c);
          }
          if (a.reappeared) await q(`INSERT INTO events(resource_id, kind, severity, message) VALUES ($1,'discovery_back','ok','Wieder gefunden')`, [a.resourceId], c);
          break;
        }
        case 'attach_resource': {
          // same machine already in the inventory: keep it, add this identity and the discovered facts
          const cur = await q1(`SELECT id, identity_key, kind, locked_fields, COALESCE(display_name, name) AS label FROM resources WHERE id = $1`, [a.resourceId], c);
          if (!cur) break;
          if (cur.identity_key) {
            await q(`INSERT INTO resource_aliases(identity_key, resource_id) VALUES ($1,$2) ON CONFLICT (identity_key) DO UPDATE SET resource_id = $2`, [a.item.identityKey, cur.id], c);
          }
          const upgradeKind = ['endpoint', 'other'].includes(cur.kind) && !['endpoint', 'other'].includes(a.item.kind) && !(cur.locked_fields ?? []).includes('kind');
          await q(`UPDATE resources SET identity_key = COALESCE(identity_key, $2), discovered = discovered || $3::jsonb, source_id = COALESCE(source_id, $4),
                     discovery_status = COALESCE(discovery_status, 'active'), first_seen_at = COALESCE(first_seen_at, now()), last_seen_at = now(),
                     kind = CASE WHEN $5 THEN $6 ELSE kind END, last_change_at = now(), updated_at = now() WHERE id = $1`,
            [cur.id, a.item.identityKey, discoveredPayload(a.item), source.id, upgradeKind, a.item.kind], c);
          await q(`INSERT INTO discovery_candidates(source_id, identity_key, kind, name, parent_identity_key, proposed, status, resource_id, decided_at, decided_by)
                   VALUES ($1,$2,$3,$4,$5,$6,'accepted',$7,now(),$8)
                   ON CONFLICT (source_id, identity_key) DO UPDATE SET status = 'accepted', resource_id = $7, proposed = $6, last_seen_at = now(), decided_at = now(), decided_by = $8`,
            [source.id, a.item.identityKey, a.item.kind, a.item.name, a.item.parentIdentityKey ?? null, a.item, cur.id, `gleiche IP ${a.ip}`], c);
          await q(`INSERT INTO events(resource_id, kind, severity, message, data) VALUES ($1,'discovery_attached','info',$2,$3)`,
            [cur.id, `„${source.name}“ hat ${a.item.kind} „${a.item.name}“ gefunden – dieselbe Maschine (IP ${a.ip}), kein neuer Eintrag${upgradeKind ? `; Typ jetzt ${a.item.kind}` : ''}`, { identity_key: a.item.identityKey, ip: a.ip }], c);
          changed++;
          break;
        }
        case 'create_resource':
          await acceptItem(c, a.item, { sourceId: source.id, enableMonitoring: a.rule.enable_monitoring, set: a.rule.set, actor: `Regel „${a.rule.name}“` });
          created++;
          break;
        case 'upsert_candidate':
          if (a.isNew && a.status === 'pending') newPending++;
          await q(`INSERT INTO discovery_candidates(source_id, identity_key, kind, name, parent_identity_key, proposed, status, rule_id, decided_at, decided_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $7 = 'ignored' THEN now() END, CASE WHEN $7 = 'ignored' THEN $9 END)
                   ON CONFLICT (source_id, identity_key) DO UPDATE SET proposed = $6, name = $4, kind = $3, last_seen_at = now(), status = $7, rule_id = $8, resource_id = NULL,
                     decided_at = CASE WHEN $7 = 'ignored' THEN now() ELSE discovery_candidates.decided_at END, decided_by = CASE WHEN $7 = 'ignored' THEN $9 ELSE discovery_candidates.decided_by END`,
            [source.id, a.item.identityKey, a.item.kind, a.item.name, a.item.parentIdentityKey ?? null, a.item, a.status, a.rule?.id ?? null, a.rule ? `Regel „${a.rule.name}“` : null], c);
          break;
        case 'touch_candidate':
          await q(`UPDATE discovery_candidates SET proposed = $2, last_seen_at = now() WHERE id = $1`, [a.candidateId, a.item], c);
          break;
        case 'mark_missing':
          await q(`UPDATE resources SET discovery_status = 'missing', last_change_at = now() WHERE id = $1`, [a.resourceId], c);
          await q(`INSERT INTO events(resource_id, kind, severity, message) VALUES ($1,'discovery_missing','warning',$2)`, [a.resourceId, `Von „${source.name}“ nicht mehr gefunden`], c);
          break;
        case 'mark_orphaned':
          await q(`UPDATE resources SET discovery_status = 'orphaned', last_change_at = now() WHERE id = $1`, [a.resourceId], c);
          await q(`INSERT INTO events(resource_id, kind, severity, message) VALUES ($1,'discovery_orphaned','warning',$2)`, [a.resourceId, `Verwaist: seit über ${Math.round(source.orphan_after_s / 3600)} h nicht mehr gefunden`], c);
          break;
      }
    }
    // candidates of this source that disappeared and are still pending are kept (with last_seen) for review
    await syncAutoStructure(c);
    await q(`UPDATE discovery_sources SET last_run_at = now(), last_error = NULL, last_duration_ms = $2, last_item_count = $3 WHERE id = $1`, [source.id, Date.now() - t0, items.length], c);
  });
  if (created || newPending || changed || plan.some((a) => a.type === 'mark_missing' || a.type === 'mark_orphaned')) {
    await notify('discovery');
    await notify('events');
  }
  log.info('source run', { source: source.name, items: items.length, created, newPending, changed, ms: Date.now() - t0 });
}

/** Worker loop body: run every source that is due or that a person asked to run now. */
export async function discoveryTick() {
  const due = await q<any>(`SELECT * FROM discovery_sources WHERE enabled AND (last_run_at IS NULL OR last_run_at + make_interval(secs => interval_s) <= now()
                            OR (run_requested_at IS NOT NULL AND run_requested_at > COALESCE(last_run_at, 'epoch')))
                            ORDER BY last_run_at NULLS FIRST`);
  for (const s of due) {
    try { await runSource(s); } catch (e) { log.warn('source failed', { source: s.name, err: errMsg(e) }); }
  }
}

export { pool };

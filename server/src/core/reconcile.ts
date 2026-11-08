import { FINGERPRINT_FIELDS, type DiscoveredItem, type DiscoveryRule } from './types.js';
import { decide, type RuleContext } from './rules.js';

export interface ExistingResource {
  id: string;
  identityKey: string; // the key that matched (own key or alias)
  discovered: Record<string, unknown>;
  discoveryStatus: 'active' | 'missing' | 'orphaned' | 'detached' | null;
  lastSeen: Date | null;
  sourceId: string | null;
}

export interface ExistingCandidate {
  id: string;
  identityKey: string;
  status: 'pending' | 'ignored' | 'accepted';
}

export interface Change { field: string; from: unknown; to: unknown }

export type PlanAction =
  | { type: 'update_resource'; resourceId: string; item: DiscoveredItem; changes: Change[]; recreated: boolean; reappeared: boolean }
  | { type: 'create_resource'; item: DiscoveredItem; rule: DiscoveryRule }
  | { type: 'upsert_candidate'; candidateId?: string; item: DiscoveredItem; status: 'pending' | 'ignored'; rule: DiscoveryRule | null; isNew: boolean }
  | { type: 'touch_candidate'; candidateId: string; item: DiscoveredItem }
  | { type: 'mark_missing'; resourceId: string }
  | { type: 'mark_orphaned'; resourceId: string };

export interface ReconcileInput {
  items: DiscoveredItem[];
  resources: ExistingResource[]; // all resources (own keys + aliases) known for any source
  candidates: ExistingCandidate[]; // candidates of this source
  rules: DiscoveryRule[];
  ctx: RuleContext;
  now: Date;
  /** a resource missing for longer than this becomes orphaned */
  orphanAfterMs: number;
}

function stable(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return JSON.stringify([...v].map((x) => (typeof x === 'object' ? stable(x) : x)).sort());
  if (v && typeof v === 'object') {
    return JSON.stringify(Object.keys(v as object).sort().reduce((acc, k) => ({ ...acc, [k]: (v as any)[k] }), {}));
  }
  return JSON.stringify(v);
}

export function diffFingerprint(before: Record<string, unknown>, after: Record<string, unknown>): Change[] {
  const out: Change[] = [];
  for (const f of FINGERPRINT_FIELDS) {
    // only fields this adapter reports are compared (several sources may describe one host)
    if (!(f in after)) continue;
    if (stable(before[f]) !== stable(after[f])) out.push({ field: f, from: before[f], to: after[f] });
  }
  return out;
}

/**
 * Pure reconciliation of one discovery run against what is known.
 * - known identities update the resource (never user-owned fields) and report changes
 * - a changed container id under the same identity is a re-creation, not a new service
 * - unknown identities go through the rules: auto_accept, ignore, or the inbox (default)
 * - previously seen resources of this source that are absent become missing, later orphaned
 */
export function reconcile(input: ReconcileInput): PlanAction[] {
  const plan: PlanAction[] = [];
  const byKey = new Map(input.resources.map((r) => [r.identityKey, r]));
  const candByKey = new Map(input.candidates.map((c) => [c.identityKey, c]));
  const seenResourceIds = new Set<string>();
  const seenKeys = new Set<string>();

  for (const item of input.items) {
    if (seenKeys.has(item.identityKey)) continue; // adapters may report duplicates; first wins
    seenKeys.add(item.identityKey);
    const res = byKey.get(item.identityKey);
    if (res) {
      if (seenResourceIds.has(res.id)) continue; // two aliases of a merged resource in one run
      seenResourceIds.add(res.id);
      if (res.discoveryStatus === 'detached') continue; // user took this resource out of discovery
      const changes = diffFingerprint(res.discovered ?? {}, item.attributes);
      const recreated = changes.some((c) => c.field === 'container_id' && c.from !== undefined);
      const reappeared = res.discoveryStatus === 'missing' || res.discoveryStatus === 'orphaned';
      plan.push({ type: 'update_resource', resourceId: res.id, item, changes, recreated, reappeared });
      continue;
    }
    const cand = candByKey.get(item.identityKey);
    if (cand && cand.status === 'ignored') {
      plan.push({ type: 'touch_candidate', candidateId: cand.id, item });
      continue;
    }
    const d = decide(input.rules, item, input.ctx);
    if (d.action === 'auto_accept' && d.rule) {
      plan.push({ type: 'create_resource', item, rule: d.rule });
    } else if (cand && cand.status === 'pending') {
      plan.push({ type: 'upsert_candidate', candidateId: cand.id, item, status: d.action === 'ignore' ? 'ignored' : 'pending', rule: d.rule, isNew: false });
    } else if (cand && cand.status === 'accepted') {
      // accepted earlier but the resource was deleted since: ask again
      plan.push({ type: 'upsert_candidate', candidateId: cand.id, item, status: d.action === 'ignore' ? 'ignored' : 'pending', rule: d.rule, isNew: true });
    } else {
      plan.push({ type: 'upsert_candidate', item, status: d.action === 'ignore' ? 'ignored' : 'pending', rule: d.rule, isNew: true });
    }
  }

  // absence handling: only resources that this source discovered
  const ownIds = new Set<string>();
  for (const r of input.resources) {
    if (r.sourceId !== input.ctx.sourceId || seenResourceIds.has(r.id) || ownIds.has(r.id)) continue;
    ownIds.add(r.id);
    if (r.discoveryStatus === 'active') plan.push({ type: 'mark_missing', resourceId: r.id });
    else if (r.discoveryStatus === 'missing' && r.lastSeen && input.now.getTime() - r.lastSeen.getTime() > input.orphanAfterMs) {
      plan.push({ type: 'mark_orphaned', resourceId: r.id });
    }
  }
  return plan;
}

/** Normalised name used to spot duplicates ("Grafana", "grafana-1", "grafana_1" → "grafana"). */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/^\//, '').replace(/[-_.](\d+)$/, '').replace(/[^a-z0-9]/g, '');
}

export interface DupResource { id: string; name: string; kind: string; address?: string | null; containerId?: string | null }

/** Groups of resources that probably describe the same thing. */
export function findDuplicates(resources: DupResource[]): Array<{ reason: string; ids: string[] }> {
  const groups: Array<{ reason: string; ids: string[] }> = [];
  const seenPairs = new Set<string>();
  const add = (reason: string, ids: string[]) => {
    const key = [...ids].sort().join(',');
    if (ids.length < 2 || seenPairs.has(key)) return;
    seenPairs.add(key);
    groups.push({ reason, ids });
  };
  const bucket = (fn: (r: DupResource) => string | null | undefined) => {
    const m = new Map<string, string[]>();
    for (const r of resources) {
      const k = fn(r);
      if (!k) continue;
      m.set(k, [...(m.get(k) ?? []), r.id]);
    }
    return m;
  };
  for (const [k, ids] of bucket((r) => (r.containerId ? r.containerId : null))) add(`gleiche Container-ID ${k.slice(0, 12)}`, ids);
  for (const [k, ids] of bucket((r) => (r.address ? r.address.toLowerCase() : null))) add(`gleiche Adresse ${k}`, ids);
  for (const [k, ids] of bucket((r) => (['host', 'vm', 'hypervisor', 'nas'].includes(r.kind) ? 'host:' : 'svc:') + normalizeName(r.name))) {
    add(`ähnlicher Name „${k.split(':')[1]}“`, ids);
  }
  return groups;
}

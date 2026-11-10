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
  | { type: 'attach_resource'; resourceId: string; item: DiscoveredItem; ip: string; via: 'ip' | 'mac' }
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
  /** IPv4 → id of the one inventory resource (not a container) owning that address */
  ipIndex?: Map<string, string>;
  /** MAC → id of the one inventory resource (not a container) owning that network card */
  macIndex?: Map<string, string>;
}

const usableMac = (m: unknown): m is string => typeof m === 'string' && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m) && m !== '00:00:00:00:00:00';

/** MAC addresses an item or resource claims (attributes.macs), normalised. */
export function itemMacs(attrs: Record<string, any> | null | undefined): string[] {
  const a = attrs ?? {};
  return [...new Set((Array.isArray(a.macs) ? a.macs : []).map((m: unknown) => String(m).toLowerCase()).filter(usableMac))] as string[];
}

const usableIp = (ip: unknown): ip is string => typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('127.') && !ip.startsWith('169.254.');

/** IPv4 addresses an item or resource claims (attributes.ips, attributes.ip, connection.host). */
export function itemIps(attrs: Record<string, any> | null | undefined, connection?: Record<string, any> | null): string[] {
  const a = attrs ?? {};
  return [...new Set([...(Array.isArray(a.ips) ? a.ips : []), a.ip, connection?.host].filter(usableIp))];
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
    // the same machine is already in the inventory under another name (same IP): attach, do not duplicate
    // MAC first: it identifies a network card even when a VM reports no guest IP (no VMware Tools)
    if (item.kind !== 'container') {
      const mac = input.macIndex ? itemMacs(item.attributes).find((x) => input.macIndex!.has(x)) : undefined;
      const ip = !mac && input.ipIndex ? itemIps(item.attributes, item.connection).find((x) => input.ipIndex!.has(x)) : undefined;
      const resId = mac ? input.macIndex!.get(mac)! : ip ? input.ipIndex!.get(ip)! : null;
      if (resId && !seenResourceIds.has(resId)) {
        seenResourceIds.add(resId);
        plan.push({ type: 'attach_resource', resourceId: resId, item, ip: (mac ?? ip)!, via: mac ? 'mac' : 'ip' });
        continue;
      }
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

export interface DupResource { id: string; name: string; kind: string; address?: string | null; containerId?: string | null; ips?: string[]; macs?: string[] }
export interface DupGroup { reason: string; confidence: 'sure' | 'hint'; ids: string[] }

/**
 * Resources that describe the same thing. "sure" groups rest on hard facts (same container id,
 * same IPv4 address of a machine, same URL / host:port); "hint" groups only on a similar name.
 * Containers are left out of the IP comparison: their addresses are internal to a docker network.
 */
export function findDuplicates(resources: DupResource[]): DupGroup[] {
  const groups: DupGroup[] = [];
  const seenPairs = new Set<string>();
  const sureLinked = new Set<string>();
  const add = (reason: string, confidence: DupGroup['confidence'], ids: string[]) => {
    const uniq = [...new Set(ids)];
    const key = [...uniq].sort().join(',');
    if (uniq.length < 2 || seenPairs.has(key)) return;
    if (confidence === 'hint' && uniq.every((a) => uniq.every((b) => a === b || sureLinked.has(`${a}|${b}`)))) return;
    seenPairs.add(key);
    if (confidence === 'sure') for (const a of uniq) for (const b of uniq) sureLinked.add(`${a}|${b}`);
    groups.push({ reason, confidence, ids: uniq });
  };
  const bucket = (fn: (r: DupResource) => Array<string | null | undefined>) => {
    const m = new Map<string, string[]>();
    for (const r of resources) for (const k of new Set(fn(r))) if (k) m.set(k, [...(m.get(k) ?? []), r.id]);
    return m;
  };
  for (const [k, ids] of bucket((r) => [r.containerId])) add(`gleiche Container-ID ${k.slice(0, 12)}`, 'sure', ids);
  for (const [k, ids] of bucket((r) => (r.kind === 'container' ? [] : (r.macs ?? []).filter(usableMac)))) add(`gleiche MAC-Adresse ${k}`, 'sure', ids);
  for (const [k, ids] of bucket((r) => (r.kind === 'container' ? [] : (r.ips ?? []).filter(usableIp)))) add(`gleiche IP-Adresse ${k}`, 'sure', ids);
  for (const [k, ids] of bucket((r) => [r.address ? r.address.toLowerCase() : null])) add(`gleiche Adresse ${k}`, 'sure', ids);
  for (const [k, ids] of bucket((r) => [(['host', 'vm', 'hypervisor', 'nas'].includes(r.kind) ? 'host:' : 'svc:') + normalizeName(r.name)])) {
    add(`ähnlicher Name „${k.split(':')[1]}“ (nur Vermutung)`, 'hint', ids);
  }
  return groups.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'sure' ? -1 : 1));
}

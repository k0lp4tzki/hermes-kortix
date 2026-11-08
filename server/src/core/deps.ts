/**
 * Dependency analysis (pure). Edge semantics: `from` depends on `to` (to = provider).
 *
 * - A failing resource is a *symptom* when a hard provider path leads to a provider that is
 *   critical; the failing providers at the top of that chain are its *root causes*.
 *   Only paths through critical providers count: a healthy provider in between means the
 *   outage further up is not what broke this resource.
 * - Every resource downstream of a root cause (hard or soft edges) is *impacted*, even when
 *   its own checks are still green.
 * - Alerts are raised for root causes only; symptoms are attached to the root incident.
 */

export interface DepNode { id: string; status: string; monitored: boolean }
export interface DepEdge { from: string; to: string; strength: 'hard' | 'soft' }

export interface DepResult {
  /** failing nodes that are not explained by an upstream failure */
  roots: Set<string>;
  /** for symptoms: the root causes explaining them */
  rootCauses: Map<string, string[]>;
  /** for every node: the roots it is downstream of */
  impactedBy: Map<string, string[]>;
  /** for every root: all downstream nodes */
  downstream: Map<string, string[]>;
}

const BAD = new Set(['critical', 'warning', 'unknown']);
const isProviderDown = (n: DepNode | undefined) => !!n && n.monitored && n.status === 'critical';
const isBad = (n: DepNode | undefined) => !!n && n.monitored && BAD.has(n.status);

export function analyzeDependencies(nodes: DepNode[], edges: DepEdge[]): DepResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hardUp = new Map<string, string[]>();   // id → hard providers
  const allDown = new Map<string, string[]>();  // id → dependents (hard + soft)
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    if (e.strength === 'hard') hardUp.set(e.from, [...(hardUp.get(e.from) ?? []), e.to]);
    allDown.set(e.to, [...(allDown.get(e.to) ?? []), e.from]);
  }

  // failing upstream closure through critical providers only
  const upCache = new Map<string, Set<string>>();
  const failingUpstream = (id: string): Set<string> => {
    const cached = upCache.get(id);
    if (cached) return cached;
    const seen = new Set<string>();
    const stack = [...(hardUp.get(id) ?? [])];
    while (stack.length) {
      const p = stack.pop()!;
      if (seen.has(p) || p === id || !isProviderDown(byId.get(p))) continue;
      seen.add(p);
      stack.push(...(hardUp.get(p) ?? []));
    }
    upCache.set(id, seen);
    return seen;
  };

  // a failing node is a root when every failing provider above it also depends on it (cycle) or none exists
  const roots = new Set<string>();
  for (const n of nodes) {
    if (!isBad(n)) continue;
    const up = failingUpstream(n.id);
    const outside = [...up].filter((u) => !failingUpstream(u).has(n.id));
    if (outside.length === 0) roots.add(n.id);
  }

  const rootCauses = new Map<string, string[]>();
  for (const n of nodes) {
    if (!isBad(n) || roots.has(n.id)) continue;
    const rc = [...failingUpstream(n.id)].filter((u) => roots.has(u));
    if (rc.length) rootCauses.set(n.id, rc.sort());
  }

  const downstream = new Map<string, string[]>();
  const impactedBy = new Map<string, string[]>();
  for (const r of roots) {
    if (!isProviderDown(byId.get(r))) continue; // warning/unknown roots do not propagate impact
    const seen = new Set<string>();
    const stack = [...(allDown.get(r) ?? [])];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d) || d === r) continue;
      seen.add(d);
      stack.push(...(allDown.get(d) ?? []));
    }
    downstream.set(r, [...seen].sort());
    for (const d of seen) impactedBy.set(d, [...(impactedBy.get(d) ?? []), r].sort());
  }
  return { roots, rootCauses, impactedBy, downstream };
}

/** Resources covered by a maintenance window: direct ids, matching tags, optionally their dependents. */
export function maintenanceScope(
  windows: Array<{ resource_ids: string[]; match_tags: string[]; include_dependents: boolean }>,
  nodes: Array<{ id: string; tags: string[] }>,
  edges: DepEdge[],
): Set<string> {
  const down = new Map<string, string[]>();
  for (const e of edges) down.set(e.to, [...(down.get(e.to) ?? []), e.from]);
  const out = new Set<string>();
  for (const w of windows) {
    const direct = nodes.filter((n) => w.resource_ids.includes(n.id) || n.tags.some((t) => w.match_tags.includes(t))).map((n) => n.id);
    const stack = [...direct];
    while (stack.length) {
      const id = stack.pop()!;
      if (out.has(id)) continue;
      out.add(id);
      if (w.include_dependents) stack.push(...(down.get(id) ?? []));
    }
  }
  return out;
}

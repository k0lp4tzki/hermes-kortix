import { KIND_LABEL, KINDS } from './meta';

/**
 * Type filter for Discovery → Inbox.
 *
 * The filter is held in the URL as `typ`:
 *   - absent            → all types visible (default)
 *   - `typ=a,b`         → only these types visible
 *   - `typ=` (empty)    → no type visible ("keine")
 * Pure functions only, so the logic is testable without a browser.
 */
export const TYPE_PARAM = 'typ';

type Cand = { id: string; kind: string };

/** Types that actually occur in the given candidates, with their count, in the order of the known kinds. */
export function typeCounts(list: Cand[]): Array<{ kind: string; label: string; count: number }> {
  const m = new Map<string, number>();
  for (const c of list) m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
  const rank = (k: string) => { const i = KINDS.indexOf(k); return i < 0 ? KINDS.length : i; };
  return [...m.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([kind, count]) => ({ kind, label: KIND_LABEL[kind] ?? kind, count }));
}

/** Selected types from the URL; `null` means "all". */
export function parseTypes(params: URLSearchParams): Set<string> | null {
  const raw = params.get(TYPE_PARAM);
  if (raw === null) return null;
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Writes the selection back; selecting every available type collapses to "all" (no parameter). */
export function writeTypes(params: URLSearchParams, types: Set<string> | null, available: string[]): URLSearchParams {
  const p = new URLSearchParams(params);
  if (types === null || (available.length > 0 && available.every((k) => types.has(k)))) p.delete(TYPE_PARAM);
  else p.set(TYPE_PARAM, [...types].sort().join(','));
  return p;
}

export function isTypeVisible(types: Set<string> | null, kind: string): boolean {
  return types === null || types.has(kind);
}

/** Toggles one type. From "all", toggling a type hides just that type. */
export function toggleType(types: Set<string> | null, kind: string, available: string[]): Set<string> {
  const next = new Set(types ?? available);
  if (next.has(kind)) next.delete(kind); else next.add(kind);
  return next;
}

/** Shows only this one type. */
export function onlyType(kind: string): Set<string> {
  return new Set([kind]);
}

export function matchesSearch(c: { name: string; parent_name?: string | null }, text: string, search: string): boolean {
  if (!search) return true;
  return `${c.name} ${text} ${c.parent_name ?? ''}`.toLowerCase().includes(search.toLowerCase());
}

/** Candidates that are visible: right status, matching search AND matching type filter. */
export function visibleCandidates<T extends Cand & { status: string; name: string; parent_name?: string | null }>(
  all: T[], opts: { status: string; search: string; types: Set<string> | null; text: (c: T) => string },
): T[] {
  return all.filter((c) => c.status === opts.status && isTypeVisible(opts.types, c.kind) && matchesSearch(c, opts.text(c), opts.search));
}

/** Drops marks on entries that are not visible any more. Returns the same set if nothing changed. */
export function pruneSelection(sel: Set<string>, visible: Cand[]): Set<string> {
  const ids = new Set(visible.map((c) => c.id));
  const next = new Set([...sel].filter((id) => ids.has(id)));
  return next.size === sel.size ? sel : next;
}

/** The IDs an action works on: marked AND visible, in list order. Never anything hidden. */
export function actionIds(sel: Set<string>, visible: Cand[]): string[] {
  return visible.filter((c) => sel.has(c.id)).map((c) => c.id);
}

/** The server accepts at most this many IDs per request. */
export const MAX_IDS_PER_REQUEST = 1000;

/** Sends a decision for exactly the given IDs, in batches the server accepts. */
export async function sendDecision<R>(
  send: (path: string, body: unknown) => Promise<R>,
  action: 'approve' | 'ignore' | 'reset',
  ids: string[],
  options: Record<string, unknown> = {},
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
    out.push(await send(`/discovery/candidates/${action}`, { ...options, ids: ids.slice(i, i + MAX_IDS_PER_REQUEST) }));
  }
  return out;
}

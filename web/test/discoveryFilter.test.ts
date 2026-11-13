import { describe, expect, it } from 'vitest';
import {
  actionIds, MAX_IDS_PER_REQUEST, onlyType, parseTypes, pruneSelection, sendDecision, toggleType, typeCounts, visibleCandidates, writeTypes,
} from '../src/lib/discoveryFilter';

// Shaped like real /api/discovery/candidates rows: a host source (host + systemd units),
// a network source (endpoints, gateway, DNS) and one already accepted entry.
const c = (id: string, kind: string, name: string, status = 'pending', parent_name: string | null = null) => ({ id, kind, name, status, parent_name });
const ALL = [
  c('h1', 'host', 'nas01'),
  c('s1', 'systemd_service', 'sshd', 'pending', 'nas01'),
  c('s2', 'systemd_service', 'cron', 'pending', 'nas01'),
  c('s3', 'systemd_service', 'docker', 'pending', 'nas01'),
  c('e1', 'endpoint', '192.168.1.20'),
  c('e2', 'endpoint', 'printer.lan'),
  c('r1', 'router', 'Gateway 192.168.1.1'),
  c('d1', 'dns', 'pihole.lan'),
  c('x1', 'endpoint', '192.168.1.99', 'accepted'),
];
const text = () => '';
const visible = (types: Set<string> | null, search = '') => visibleCandidates(ALL, { status: 'pending', search, types, text });
const ids = (l: { id: string }[]) => l.map((x) => x.id);

describe('type options', () => {
  it('lists only the types that occur, with counts, in the known order', () => {
    expect(typeCounts(ALL.filter((x) => x.status === 'pending'))).toEqual([
      { kind: 'host', label: 'Host', count: 1 },
      { kind: 'systemd_service', label: 'systemd-Dienst', count: 3 },
      { kind: 'endpoint', label: 'Endpunkt', count: 2 },
      { kind: 'dns', label: 'DNS', count: 1 },
      { kind: 'router', label: 'Router/Gateway', count: 1 },
    ]);
  });
  it('keeps unknown kinds instead of inventing labels', () => {
    expect(typeCounts([{ id: 'a', kind: 'zzz_new' }])).toEqual([{ kind: 'zzz_new', label: 'zzz_new', count: 1 }]);
  });
});

describe('URL state', () => {
  const avail = ['host', 'systemd_service', 'endpoint', 'dns', 'router'];
  it('no parameter means all types', () => {
    expect(parseTypes(new URLSearchParams(''))).toBeNull();
  });
  it('round-trips a selection and keeps other parameters', () => {
    const p = writeTypes(new URLSearchParams('foo=1'), new Set(['endpoint', 'host']), avail);
    expect(p.get('typ')).toBe('endpoint,host');
    expect(p.get('foo')).toBe('1');
    expect(parseTypes(p)).toEqual(new Set(['endpoint', 'host']));
  });
  it('"keine" is an empty parameter, distinct from "alle"', () => {
    const p = writeTypes(new URLSearchParams(), new Set(), avail);
    expect(p.toString()).toBe('typ=');
    expect(parseTypes(p)).toEqual(new Set());
  });
  it('selecting every type collapses back to "alle"', () => {
    expect(writeTypes(new URLSearchParams('typ=host'), new Set(avail), avail).has('typ')).toBe(false);
    expect(writeTypes(new URLSearchParams('typ=host'), null, avail).has('typ')).toBe(false);
  });
});

describe('filtering', () => {
  const avail = ['host', 'systemd_service', 'endpoint', 'dns', 'router'];
  it('shows all pending entries by default', () => {
    expect(ids(visible(null))).toEqual(['h1', 's1', 's2', 's3', 'e1', 'e2', 'r1', 'd1']);
  });
  it('"nur Endpunkt" in one step', () => {
    expect(ids(visible(onlyType('endpoint')))).toEqual(['e1', 'e2']);
  });
  it('hiding systemd from "alle" in one step keeps everything else', () => {
    const t = toggleType(null, 'systemd_service', avail);
    expect(ids(visible(t))).toEqual(['h1', 'e1', 'e2', 'r1', 'd1']);
  });
  it('"keine" then a type gives only that type (two clicks)', () => {
    const t = toggleType(new Set(), 'host', avail);
    expect(ids(visible(t))).toEqual(['h1']);
  });
  it('combines with the search (AND)', () => {
    expect(ids(visible(toggleType(null, 'systemd_service', avail), '.lan'))).toEqual(['e2', 'd1']);
    expect(ids(visible(onlyType('systemd_service'), 'nas01'))).toEqual(['s1', 's2', 's3']);
    expect(ids(visible(onlyType('endpoint'), 'pihole'))).toEqual([]);
  });
  it('never shows entries of other statuses', () => {
    expect(ids(visible(onlyType('endpoint')))).not.toContain('x1');
  });
});

describe('selection follows the filter', () => {
  it('drops marks on entries that became hidden', () => {
    const sel = new Set(['h1', 's1', 'e1']);
    const after = pruneSelection(sel, visible(onlyType('endpoint')));
    expect([...after]).toEqual(['e1']);
  });
  it('returns the same set when nothing is hidden (no needless re-render)', () => {
    const sel = new Set(['e1']);
    expect(pruneSelection(sel, visible(null))).toBe(sel);
  });
  it('action ids are only marked AND visible, even before pruning ran', () => {
    const sel = new Set(['h1', 's1', 's2', 'e1', 'e2']);
    expect(actionIds(sel, visible(toggleType(null, 'systemd_service', ['host', 'systemd_service', 'endpoint', 'dns', 'router'])))).toEqual(['h1', 'e1', 'e2']);
  });
});

describe('what is sent to the server', () => {
  const recorder = () => {
    const calls: Array<{ path: string; body: any }> = [];
    const send = async (path: string, body: unknown) => { calls.push({ path, body }); return { ok: true }; };
    return { calls, send };
  };

  it('journey A: only endpoints, select all, approve → exactly the endpoint ids', async () => {
    const list = visible(onlyType('endpoint'));
    const sel = new Set(list.map((x) => x.id)); // "Alle auswählen" marks the visible ones
    const { calls, send } = recorder();
    await sendDecision(send, 'approve', actionIds(sel, list), { enable_monitoring: true, create_rule: false });
    expect(calls).toEqual([{ path: '/discovery/candidates/approve', body: { ids: ['e1', 'e2'], enable_monitoring: true, create_rule: false } }]);
  });

  it('journey B: systemd hidden, select all, approve → no systemd id is sent', async () => {
    const list = visible(toggleType(null, 'systemd_service', ['host', 'systemd_service', 'endpoint', 'dns', 'router']));
    const { calls, send } = recorder();
    await sendDecision(send, 'approve', actionIds(new Set(list.map((x) => x.id)), list));
    expect(calls[0].body.ids).toEqual(['h1', 'e1', 'e2', 'r1', 'd1']);
    expect(calls[0].body.ids.some((id: string) => id.startsWith('s'))).toBe(false);
  });

  it('journey C: marked, then filter narrows → only the still visible marks are sent', async () => {
    const sel = new Set(ids(visible(null))); // everything marked
    const list = visible(onlyType('host'));
    const { calls, send } = recorder();
    await sendDecision(send, 'ignore', actionIds(sel, list), { create_rule: false });
    expect(calls).toEqual([{ path: '/discovery/candidates/ignore', body: { ids: ['h1'], create_rule: false } }]);
  });

  it('cannot smuggle ids through options', async () => {
    const { calls, send } = recorder();
    await sendDecision(send, 'approve', ['e1'], { ids: ['s1', 's2'] });
    expect(calls[0].body.ids).toEqual(['e1']);
  });

  it('splits large selections into batches the server accepts, sending each id once', async () => {
    const many = Array.from({ length: 2 * MAX_IDS_PER_REQUEST + 5 }, (_, i) => `id${i}`);
    const { calls, send } = recorder();
    await sendDecision(send, 'approve', many);
    expect(calls.map((x) => x.body.ids.length)).toEqual([MAX_IDS_PER_REQUEST, MAX_IDS_PER_REQUEST, 5]);
    expect(calls.flatMap((x) => x.body.ids)).toEqual(many);
  });

  it('sends nothing when nothing visible is marked', async () => {
    const { calls, send } = recorder();
    await sendDecision(send, 'approve', actionIds(new Set(['s1']), visible(onlyType('endpoint'))));
    expect(calls).toEqual([]);
  });
});

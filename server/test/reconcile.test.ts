import { describe, expect, it } from 'vitest';
import { reconcile, findDuplicates, diffFingerprint, type ExistingResource } from '../src/core/reconcile.js';
import type { DiscoveredItem, DiscoveryRule } from '../src/core/types.js';

const now = new Date('2026-11-08T12:00:00Z');
const ctx = { sourceId: 'docker-1', sourceType: 'docker' };
const item = (key: string, attrs: Record<string, unknown> = {}, p: Partial<DiscoveredItem> = {}): DiscoveredItem => ({ identityKey: key, kind: 'container', name: key.split('/').pop()!, attributes: attrs, ...p });
const res = (id: string, key: string, p: Partial<ExistingResource> = {}): ExistingResource => ({ id, identityKey: key, discovered: {}, discoveryStatus: 'active', lastSeen: now, sourceId: 'docker-1', ...p });
const base = { candidates: [], rules: [] as DiscoveryRule[], ctx, now, orphanAfterMs: 3600_000 };

describe('reconcile', () => {
  it('puts unknown items into the inbox instead of monitoring them', () => {
    const plan = reconcile({ ...base, items: [item('docker:h/compose/app/web')], resources: [] });
    expect(plan).toEqual([expect.objectContaining({ type: 'upsert_candidate', status: 'pending', isNew: true })]);
  });

  it('auto-accepts via rule and ignores via deny rule', () => {
    const rules: DiscoveryRule[] = [
      { id: 'a', name: 'self', priority: 10, enabled: true, match: { compose_project: 'hermes' }, action: 'auto_accept', enable_monitoring: true, set: {} },
      { id: 'b', name: 'deny', priority: 5, enabled: true, match: { labels: { 'hermes.ignore': 'true' } }, action: 'ignore', enable_monitoring: false, set: {} },
    ];
    const plan = reconcile({ ...base, rules, resources: [], items: [
      item('docker:h/compose/hermes/api', { compose_project: 'hermes' }),
      item('docker:h/name/scratch', { labels: { 'hermes.ignore': 'true' } }),
    ] });
    expect(plan[0]).toMatchObject({ type: 'create_resource', rule: { name: 'self' } });
    expect(plan[1]).toMatchObject({ type: 'upsert_candidate', status: 'ignored' });
  });

  it('treats a re-created container (new id, same compose service) as the same logical service', () => {
    const existing = res('r1', 'docker:h/compose/app/db', { discovered: { container_id: 'aaa', image: 'postgres:16' } });
    const plan = reconcile({ ...base, resources: [existing], items: [item('docker:h/compose/app/db', { container_id: 'bbb', image: 'postgres:16' })] });
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ type: 'update_resource', resourceId: 'r1', recreated: true });
    expect((plan[0] as any).changes).toEqual([{ field: 'container_id', from: 'aaa', to: 'bbb' }]);
  });

  it('reports metadata changes (image, ports, labels) without creating anything new', () => {
    const existing = res('r1', 'k', { discovered: { image: 'nginx:1.25', ports: [{ private: 80, public: 8080 }], labels: { a: '1' } } });
    const plan = reconcile({ ...base, resources: [existing], items: [item('k', { image: 'nginx:1.27', ports: [{ private: 80, public: 8080 }], labels: { a: '2' } })] });
    const changes = (plan[0] as any).changes.map((c: any) => c.field);
    expect(changes).toEqual(['image', 'labels']);
  });

  it('never acts on resources a person detached from discovery', () => {
    const plan = reconcile({ ...base, resources: [res('r1', 'k', { discoveryStatus: 'detached' })], items: [item('k', { image: 'x' })] });
    expect(plan).toEqual([]);
  });

  it('maps merged identities (aliases) to the surviving resource', () => {
    const plan = reconcile({ ...base, resources: [res('keep', 'docker:h/name/old-name'), res('keep', 'manual-alias')], items: [item('docker:h/name/old-name')] });
    expect(plan).toEqual([expect.objectContaining({ type: 'update_resource', resourceId: 'keep' })]);
  });

  it('marks absent resources missing, and orphaned after the grace period', () => {
    const plan = reconcile({ ...base, items: [], resources: [
      res('gone-now', 'a'),
      res('gone-long', 'b', { discoveryStatus: 'missing', lastSeen: new Date(now.getTime() - 2 * 3600_000) }),
      res('gone-short', 'c', { discoveryStatus: 'missing', lastSeen: new Date(now.getTime() - 60_000) }),
      res('other-source', 'd', { sourceId: 'host-1' }),
    ] });
    expect(plan).toEqual([{ type: 'mark_missing', resourceId: 'gone-now' }, { type: 'mark_orphaned', resourceId: 'gone-long' }]);
  });

  it('flags reappearance of a missing resource', () => {
    const plan = reconcile({ ...base, items: [item('a')], resources: [res('r', 'a', { discoveryStatus: 'missing' })] });
    expect(plan[0]).toMatchObject({ type: 'update_resource', reappeared: true });
  });

  it('keeps ignored candidates ignored and refreshes them', () => {
    const plan = reconcile({ ...base, items: [item('x')], resources: [], candidates: [{ id: 'c1', identityKey: 'x', status: 'ignored' }] });
    expect(plan).toEqual([expect.objectContaining({ type: 'touch_candidate', candidateId: 'c1' })]);
  });

  it('only compares fingerprint fields the adapter reports', () => {
    expect(diffFingerprint({ os: 'Debian', kernel: '6.1' }, { kernel: '6.1' })).toEqual([]);
    expect(diffFingerprint({ ports: [{ b: 2, a: 1 }] }, { ports: [{ a: 1, b: 2 }] })).toEqual([]);
  });
});

describe('duplicate detection', () => {
  it('groups by container id, address and normalised name', () => {
    const groups = findDuplicates([
      { id: '1', name: 'Grafana', kind: 'service', address: 'http://10.0.0.5:3000' },
      { id: '2', name: 'grafana-1', kind: 'container', containerId: 'abc' },
      { id: '3', name: 'grafana-web', kind: 'endpoint', address: 'http://10.0.0.5:3000' },
      { id: '4', name: 'nas', kind: 'host' },
      { id: '5', name: 'NAS', kind: 'nas' },
    ]);
    expect(groups.map((g) => g.ids.sort().join(','))).toEqual(expect.arrayContaining(['1,3', '1,2', '4,5']));
  });
});

import { describe, expect, it } from 'vitest';
import { analyzeDependencies, maintenanceScope, type DepEdge, type DepNode } from '../src/core/deps.js';

const n = (id: string, status = 'ok', monitored = true): DepNode => ({ id, status, monitored });
const hard = (from: string, to: string): DepEdge => ({ from, to, strength: 'hard' });
const soft = (from: string, to: string): DepEdge => ({ from, to, strength: 'soft' });

describe('dependency analysis', () => {
  // host ← db ← app ← proxy ; app ← cache(soft)
  const edges = [hard('db', 'host'), hard('app', 'db'), hard('proxy', 'app'), soft('app', 'cache'), hard('cache', 'host')];

  it('identifies the host as root cause and suppresses its failing dependents', () => {
    const r = analyzeDependencies([n('host', 'critical'), n('db', 'critical'), n('app', 'critical'), n('proxy', 'warning'), n('cache', 'unknown')], edges);
    expect([...r.roots]).toEqual(['host']);
    expect(r.rootCauses.get('db')).toEqual(['host']);
    expect(r.rootCauses.get('proxy')).toEqual(['host']);
    expect(r.rootCauses.get('cache')).toEqual(['host']);
    expect(r.downstream.get('host')).toEqual(['app', 'cache', 'db', 'proxy']);
  });

  it('marks healthy dependents as impacted (impact propagation)', () => {
    const r = analyzeDependencies([n('host'), n('db', 'critical'), n('app'), n('proxy'), n('cache')], edges);
    expect([...r.roots]).toEqual(['db']);
    expect(r.impactedBy.get('app')).toEqual(['db']);
    expect(r.impactedBy.get('proxy')).toEqual(['db']);
    expect(r.impactedBy.has('cache')).toBe(false);
  });

  it('does not blame an upstream outage when a healthy provider sits in between', () => {
    const r = analyzeDependencies([n('host', 'critical'), n('db'), n('app', 'critical'), n('proxy'), n('cache')], [hard('db', 'host'), hard('app', 'db')]);
    expect(r.roots).toEqual(new Set(['host', 'app']));
    expect(r.rootCauses.has('app')).toBe(false);
  });

  it('does not suppress via soft dependencies, but still reports impact', () => {
    const r = analyzeDependencies([n('host'), n('db'), n('app', 'critical'), n('proxy'), n('cache', 'critical')], edges);
    expect(r.roots).toEqual(new Set(['app', 'cache']));
    expect(r.impactedBy.get('app')).toEqual(['cache']);
  });

  it('ignores unmonitored providers and warning providers for suppression', () => {
    const r1 = analyzeDependencies([n('host', 'critical', false), n('db', 'critical'), n('app'), n('proxy'), n('cache')], edges);
    expect(r1.roots).toEqual(new Set(['db']));
    const r2 = analyzeDependencies([n('host', 'warning'), n('db', 'critical'), n('app'), n('proxy'), n('cache')], edges);
    expect(r2.roots).toEqual(new Set(['host', 'db']));
    expect(r2.downstream.has('host')).toBe(false);
  });

  it('handles cycles without looping and reports all members as roots', () => {
    const r = analyzeDependencies([n('a', 'critical'), n('b', 'critical'), n('c', 'critical')], [hard('a', 'b'), hard('b', 'a'), hard('c', 'a')]);
    expect(r.roots).toEqual(new Set(['a', 'b']));
    expect(r.rootCauses.get('c')).toEqual(['a', 'b']);
  });

  it('chooses multiple independent root causes', () => {
    const r = analyzeDependencies([n('dns', 'critical'), n('nas', 'critical'), n('app', 'critical')], [hard('app', 'dns'), hard('app', 'nas')]);
    expect(r.rootCauses.get('app')).toEqual(['dns', 'nas']);
  });
});

describe('maintenance scope', () => {
  it('covers direct resources, tags and dependents', () => {
    const nodes = [{ id: 'nas', tags: [] }, { id: 'plex', tags: [] }, { id: 'router', tags: ['netz'] }, { id: 'other', tags: [] }];
    const edges = [hard('plex', 'nas')];
    expect(maintenanceScope([{ resource_ids: ['nas'], match_tags: [], include_dependents: true }], nodes, edges)).toEqual(new Set(['nas', 'plex']));
    expect(maintenanceScope([{ resource_ids: ['nas'], match_tags: ['netz'], include_dependents: false }], nodes, edges)).toEqual(new Set(['nas', 'router']));
  });
});

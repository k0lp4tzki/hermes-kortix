import { describe, expect, it } from 'vitest';
import { decide, expandCidr, globMatch, inCidr } from '../src/core/rules.js';
import type { DiscoveredItem, DiscoveryRule } from '../src/core/types.js';

const rule = (p: Partial<DiscoveryRule>): DiscoveryRule => ({ id: p.name ?? 'r', name: 'r', priority: 100, enabled: true, match: {}, action: 'manual', enable_monitoring: false, set: {}, ...p });
const item = (p: Partial<DiscoveredItem> = {}): DiscoveredItem => ({ identityKey: 'docker:h/name/x', kind: 'container', name: 'x', attributes: {}, ...p });
const ctx = { sourceId: 'src-1', sourceType: 'docker' };

describe('glob / cidr helpers', () => {
  it('matches globs case-insensitively', () => {
    expect(globMatch('graf*', 'Grafana')).toBe(true);
    expect(globMatch('*.example.com', 'a.example.com')).toBe(true);
    expect(globMatch('db?', 'db12')).toBe(false);
    expect(globMatch('x', undefined)).toBe(false);
  });
  it('checks IPv4 CIDR membership', () => {
    expect(inCidr('192.168.1.20', '192.168.1.0/24')).toBe(true);
    expect(inCidr('192.168.2.20', '192.168.1.0/24')).toBe(false);
    expect(inCidr('10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(inCidr('10.1.2.3', '10.1.2.3')).toBe(true);
    expect(inCidr('fe80::1', '10.0.0.0/8')).toBe(false);
  });
  it('expands ranges and refuses oversized ones', () => {
    expect(expandCidr('192.168.1.0/30')).toEqual(['192.168.1.1', '192.168.1.2']);
    expect(expandCidr('192.168.1.0/24')).toHaveLength(254);
    expect(() => expandCidr('10.0.0.0/16')).toThrow(/zu groß/);
  });
});

describe('discovery rules', () => {
  it('defaults to manual approval when nothing matches (safe default)', () => {
    expect(decide([], item(), ctx)).toEqual({ action: 'manual', rule: null });
  });
  it('uses the lowest priority matching rule and skips disabled rules', () => {
    const rules = [
      rule({ name: 'accept-all', priority: 100, action: 'auto_accept' }),
      rule({ name: 'deny-test', priority: 10, action: 'ignore', match: { name_glob: 'test-*' } }),
      rule({ name: 'disabled', priority: 1, action: 'auto_accept', enabled: false }),
    ];
    expect(decide(rules, item({ name: 'test-1' }), ctx).rule?.name).toBe('deny-test');
    expect(decide(rules, item({ name: 'grafana' }), ctx).rule?.name).toBe('accept-all');
  });
  it('matches labels (exact, glob and presence), compose project and image', () => {
    const r = rule({ action: 'auto_accept', match: { labels: { 'hermes.monitor': 'true', team: '*' }, compose_project: 'media*', image_glob: 'linuxserver/*' } });
    const ok = item({ attributes: { labels: { 'hermes.monitor': 'true', team: 'ops' }, compose_project: 'mediastack', image: 'linuxserver/sonarr:latest' } });
    expect(decide([r], ok, ctx).action).toBe('auto_accept');
    expect(decide([r], item({ attributes: { ...ok.attributes, labels: { 'hermes.monitor': 'true' } } }), ctx).action).toBe('manual');
    expect(decide([r], item({ attributes: { ...ok.attributes, image: 'nginx' } }), ctx).action).toBe('manual');
  });
  it('matches network ranges, ports, kinds and sources', () => {
    const r = rule({ action: 'auto_accept', match: { cidrs: ['192.168.10.0/24'], ports: [22], kinds: ['endpoint'], source_types: ['network'] } });
    const ep = item({ kind: 'endpoint', attributes: { ip: '192.168.10.5', open_ports: [22, 80] } });
    expect(decide([r], ep, { sourceId: 'n', sourceType: 'network' }).action).toBe('auto_accept');
    expect(decide([r], ep, ctx).action).toBe('manual');
    expect(decide([r], item({ kind: 'endpoint', attributes: { ip: '192.168.11.5', open_ports: [22] } }), { sourceId: 'n', sourceType: 'network' }).action).toBe('manual');
  });
});

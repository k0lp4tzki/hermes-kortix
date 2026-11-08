import { describe, expect, it } from 'vitest';
import { suggestDependencies, type SugResource, type SuggestInput } from '../src/core/suggest.js';

const r = (id: string, kind: string, ips: string[], p: Partial<SugResource> = {}): SugResource => ({ id, label: id, kind, identityKey: null, parentId: null, ips, port: null, discovered: {}, ...p });
const base: SuggestInput = { resources: [], edges: [], vms: [], hypervisors: [], connections: [], routes: [], dns: [] };

describe('dependency suggestions', () => {
  it('VMware: a VM known only by its IP is suggested to run on its ESXi host (user scenario)', () => {
    const s = suggestDependencies({ ...base,
      resources: [r('esx1', 'host', ['10.1.1.254']), r('app-vm', 'endpoint', ['10.1.1.155'])],
      hypervisors: [{ identity: 'vmware-host:esx1.lab', name: 'esx1.lab', ips: ['10.1.1.254'], datastores: [] }],
      vms: [{ vmIdentity: 'vmware-vm:abc', name: 'app01', ips: ['10.1.1.155'], hostIdentity: 'vmware-host:esx1.lab', datastores: [] }] });
    expect(s).toEqual([expect.objectContaining({ from: 'app-vm', to: 'esx1', type: 'runs_on', confidence: 'sure', source: 'vmware' })]);
    expect(s[0].evidence).toContain('app01');
  });

  it('VMware: no suggestion when the discovered VM already hangs below its host; NFS datastores point to the NAS', () => {
    const s = suggestDependencies({ ...base,
      resources: [r('hv', 'hypervisor', ['10.1.1.254'], { identityKey: 'vmware-host:esx1' }), r('vm', 'vm', ['10.1.1.155'], { identityKey: 'vmware-vm:abc', parentId: 'hv' }), r('nas', 'nas', ['10.1.1.20'])],
      edges: [{ from: 'vm', to: 'hv', suppressed: false }],
      hypervisors: [{ identity: 'vmware-host:esx1', name: 'esx1', ips: ['10.1.1.254'], datastores: [{ name: 'nfs-vms', remote_host: '10.1.1.20' }] }],
      vms: [{ vmIdentity: 'vmware-vm:abc', name: 'app01', ips: ['10.1.1.155'], hostIdentity: 'vmware-host:esx1', datastores: [{ name: 'nfs-vms', remote_host: '10.1.1.20' }] }] });
    expect(s.map((x) => `${x.from}>${x.to}:${x.type}`).sort()).toEqual(['hv>nas:uses_storage', 'vm>nas:uses_storage']);
  });

  it('connections: maps container IP + port and published host ports to the providing resource and its role', () => {
    const host = r('host', 'host', ['10.0.0.5', '172.18.0.1']);
    const pg = r('pg', 'container', ['172.18.0.3'], { parentId: 'host', discovered: { ports: [{ private: 5432, public: 5433 }] } });
    const app = r('app', 'container', ['172.18.0.4'], { parentId: 'host' });
    const s = suggestDependencies({ ...base, resources: [host, pg, app], connections: [
      { fromId: 'app', remoteIp: '172.18.0.3', remotePort: 5432, count: 3 },
      { fromId: 'host', remoteIp: '10.0.0.5', remotePort: 5433, count: 1 },
      { fromId: 'app', remoteIp: '10.0.0.99', remotePort: 6379, count: 2 },
      { fromId: 'app', remoteIp: '140.82.121.3', remotePort: 443, count: 9 },
    ] });
    expect(s.find((x) => x.from === 'app' && x.to === 'pg')).toMatchObject({ type: 'uses_db', confidence: 'evidence' });
    expect(s.find((x) => x.from === 'host' && x.to === 'pg')).toMatchObject({ type: 'uses_db' });
    expect(s.find((x) => x.target?.host === '10.0.0.99')).toMatchObject({ type: 'uses_cache', target: { kind: 'cache', port: 6379 } });
    expect(s.some((x) => x.target?.host === '140.82.121.3')).toBe(false); // unknown public IPs are not suggested
  });

  it('routing and DNS: gateway and resolver, plus subnet neighbours as hints', () => {
    const s = suggestDependencies({ ...base,
      resources: [r('host', 'host', ['10.1.1.10']), r('gw', 'router', ['10.1.1.1']), r('nas', 'nas', ['10.1.1.20']), r('far', 'host', ['10.9.9.9'])],
      routes: [{ hostId: 'host', gateway: '10.1.1.1', subnets: ['10.1.1.0/24'] }],
      dns: [{ hostId: 'host', nameservers: ['10.1.1.53'] }] });
    expect(s.find((x) => x.from === 'host' && x.to === 'gw')).toMatchObject({ confidence: 'evidence', type: 'network_link' });
    expect(s.find((x) => x.from === 'nas' && x.to === 'gw')).toMatchObject({ confidence: 'hint' });
    expect(s.some((x) => x.from === 'far')).toBe(false);
    expect(s.find((x) => x.type === 'resolves_via')).toMatchObject({ to: null, target: { host: '10.1.1.53', kind: 'dns' } });
  });

  it('never re-suggests existing or removed edges, nor the reverse of an existing edge', () => {
    const res = [r('host', 'host', ['10.1.1.10']), r('gw', 'router', ['10.1.1.1'])];
    const routes = [{ hostId: 'host', gateway: '10.1.1.1', subnets: [] }];
    expect(suggestDependencies({ ...base, resources: res, routes, edges: [{ from: 'host', to: 'gw', suppressed: true }] })).toEqual([]);
    expect(suggestDependencies({ ...base, resources: res, routes, edges: [{ from: 'gw', to: 'host', suppressed: false }] })).toEqual([]);
  });
});

import { parseTcp, hexToIp } from '../src/worker/suggestions.js';
describe('/proc/net/tcp parsing', () => {
  it('returns outbound established IPv4 connections only (also IPv4-mapped in tcp6)', () => {
    const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1
   1: 040012AC:1F90 050012AC:D2F0 01 00000000:00000000 00:00000000 00000000     0        0 2 1
   2: 040012AC:A1B2 030012AC:1538 01 00000000:00000000 00:00000000 00000000     0        0 3 1
   3: 0100007F:A1B3 0100007F:1538 01 00000000:00000000 00:00000000 00000000     0        0 4 1`;
    const tcp6 = `  sl  local_address                         remote_address                        st
   0: 0000000000000000FFFF0000040012AC:B000 0000000000000000FFFF0000030012AC:18EB 01 0`;
    expect(hexToIp('030012AC')).toBe('172.18.0.3');
    expect(parseTcp(tcp, tcp6)).toEqual([{ ip: '172.18.0.3', port: 5432 }, { ip: '172.18.0.3', port: 6379 }]);
  });
});

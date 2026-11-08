/**
 * Dependency suggestions (pure). Every suggestion carries the evidence it is based on and a
 * confidence: "sure" (an authoritative API says so, e.g. vSphere), "evidence" (observed on the
 * system: open TCP connections, routing table, resolver config), "hint" (inferred, e.g. same subnet).
 * Nothing here changes the inventory; a person (or later a rule) accepts suggestions.
 */
import { inCidr } from './rules.js';

export interface SugResource {
  id: string; label: string; kind: string; identityKey: string | null; parentId: string | null;
  ips: string[]; port: number | null; discovered: Record<string, any>;
}
export interface SugEdge { from: string; to: string; suppressed: boolean }
export interface VmFact { vmIdentity: string; name: string; ips: string[]; hostIdentity: string | null; datastores: Array<{ name: string; remote_host: string | null }> }
export interface HypervisorFact { identity: string; name: string; ips: string[]; datastores: Array<{ name: string; remote_host: string | null }> }
export interface ConnectionFact { fromId: string; remoteIp: string; remotePort: number; count: number }
export interface RouteFact { hostId: string; gateway: string | null; subnets: string[] }
export interface DnsFact { hostId: string; nameservers: string[] }

export interface Suggestion {
  key: string;
  from: string;
  to: string | null;
  target: { host: string; port?: number; kind: string; name: string } | null;
  type: string;
  strength: 'hard' | 'soft';
  source: 'vmware' | 'connections' | 'routing' | 'dns';
  confidence: 'sure' | 'evidence' | 'hint';
  evidence: string;
  data: Record<string, unknown>;
}

export interface SuggestInput {
  resources: SugResource[];
  edges: SugEdge[];
  vms: VmFact[];
  hypervisors: HypervisorFact[];
  connections: ConnectionFact[];
  routes: RouteFact[];
  dns: DnsFact[];
}

const PORT_ROLE: Record<number, { type: string; kind: string; label: string }> = {
  5432: { type: 'uses_db', kind: 'database', label: 'PostgreSQL' }, 3306: { type: 'uses_db', kind: 'database', label: 'MySQL/MariaDB' },
  1433: { type: 'uses_db', kind: 'database', label: 'SQL Server' }, 27017: { type: 'uses_db', kind: 'database', label: 'MongoDB' },
  9200: { type: 'uses_db', kind: 'database', label: 'Elasticsearch' }, 8086: { type: 'uses_db', kind: 'database', label: 'InfluxDB' },
  6379: { type: 'uses_cache', kind: 'cache', label: 'Redis' }, 11211: { type: 'uses_cache', kind: 'cache', label: 'Memcached' },
  5672: { type: 'uses_broker', kind: 'broker', label: 'AMQP' }, 1883: { type: 'uses_broker', kind: 'broker', label: 'MQTT' }, 9092: { type: 'uses_broker', kind: 'broker', label: 'Kafka' },
  4222: { type: 'uses_broker', kind: 'broker', label: 'NATS' }, 53: { type: 'resolves_via', kind: 'dns', label: 'DNS' },
  2049: { type: 'uses_storage', kind: 'nas', label: 'NFS' }, 445: { type: 'uses_storage', kind: 'nas', label: 'SMB' },
  389: { type: 'depends_on', kind: 'service', label: 'LDAP' }, 636: { type: 'depends_on', kind: 'service', label: 'LDAPS' },
};
export function portRole(port: number) { return PORT_ROLE[port] ?? { type: 'depends_on', kind: 'endpoint', label: `TCP ${port}` }; }

export function isPrivate(ip: string) {
  return ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'].some((c) => inCidr(ip, c));
}

export function suggestDependencies(input: SuggestInput): Suggestion[] {
  const byId = new Map(input.resources.map((r) => [r.id, r]));
  const byIdentity = new Map(input.resources.filter((r) => r.identityKey).map((r) => [r.identityKey!, r]));
  const byIp = new Map<string, SugResource[]>();
  for (const r of input.resources) for (const ip of r.ips) byIp.set(ip, [...(byIp.get(ip) ?? []), r]);
  const linked = new Set<string>();
  const removed = new Set<string>();
  for (const e of input.edges) {
    if (e.suppressed) removed.add(`${e.from}>${e.to}`);
    else { linked.add(`${e.from}>${e.to}`); linked.add(`${e.to}>${e.from}`); }
  }
  const out = new Map<string, Suggestion>();
  const add = (s: Omit<Suggestion, 'key'>) => {
    if (s.to && (s.to === s.from || linked.has(`${s.from}>${s.to}`) || removed.has(`${s.from}>${s.to}`))) return;
    const key = `${s.from}>${s.to ?? `ext:${s.target!.host}${s.target!.port ? ':' + s.target!.port : ''}`}>${s.type}`;
    const cur = out.get(key);
    const rank = { sure: 3, evidence: 2, hint: 1 };
    if (!cur || rank[s.confidence] > rank[cur.confidence]) out.set(key, { ...s, key });
  };
  /** prefer the most specific resource for an IP: hypervisor/host/vm/nas over containers and endpoints */
  const pickByIp = (ip: string, exclude?: string) => (byIp.get(ip) ?? []).filter((r) => r.id !== exclude)
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind))[0];

  // 1. vSphere: VM → runs on → ESXi host; host/VM → NFS datastore server
  const hvResource = (identity: string | null, ips: string[] = []) => (identity && byIdentity.get(identity)) || ips.map((ip) => pickByIp(ip)).find(Boolean);
  for (const vm of input.vms) {
    const hvFact = input.hypervisors.find((h) => h.identity === vm.hostIdentity);
    const hv = hvResource(vm.hostIdentity, hvFact?.ips);
    const vmRes = byIdentity.get(vm.vmIdentity);
    const holders = new Map<string, SugResource>();
    if (vmRes) holders.set(vmRes.id, vmRes);
    for (const ip of vm.ips) for (const r of byIp.get(ip) ?? []) if (!['hypervisor', 'container'].includes(r.kind)) holders.set(r.id, r);
    for (const r of holders.values()) {
      if (hv && (r.id !== vmRes?.id || r.parentId !== hv.id)) {
        add({ from: r.id, to: hv.id, target: null, type: 'runs_on', strength: 'hard', source: 'vmware', confidence: 'sure',
          evidence: `vSphere: VM „${vm.name}“${vm.ips.length ? ` (${vm.ips.join(', ')})` : ''} läuft auf ESXi-Host „${hvFact?.name ?? hv.label}“`, data: { vm: vm.name, ips: vm.ips } });
      }
      for (const ds of vm.datastores) {
        if (!ds.remote_host) continue;
        const nas = pickByIp(ds.remote_host, r.id) ?? input.resources.find((x) => x.label.toLowerCase() === ds.remote_host!.toLowerCase());
        if (nas) add({ from: r.id, to: nas.id, target: null, type: 'uses_storage', strength: 'hard', source: 'vmware', confidence: 'sure',
          evidence: `vSphere: Festplatten von „${vm.name}“ liegen auf NFS-Datastore „${ds.name}“ von ${ds.remote_host}`, data: { datastore: ds.name } });
      }
    }
  }
  for (const h of input.hypervisors) {
    const hv = hvResource(h.identity, h.ips);
    if (!hv) continue;
    for (const ds of h.datastores) {
      if (!ds.remote_host) continue;
      const nas = pickByIp(ds.remote_host, hv.id);
      if (nas) add({ from: hv.id, to: nas.id, target: null, type: 'uses_storage', strength: 'hard', source: 'vmware', confidence: 'sure',
        evidence: `vSphere: Host „${h.name}“ bindet NFS-Datastore „${ds.name}“ von ${ds.remote_host} ein`, data: { datastore: ds.name } });
      else if (isPrivate(ds.remote_host)) add({ from: hv.id, to: null, target: { host: ds.remote_host, port: 2049, kind: 'nas', name: `NFS ${ds.remote_host}` }, type: 'uses_storage', strength: 'hard',
        source: 'vmware', confidence: 'sure', evidence: `vSphere: Host „${h.name}“ bindet NFS-Datastore „${ds.name}“ von ${ds.remote_host} ein (nicht im Inventar)`, data: { datastore: ds.name } });
    }
  }

  // 2. observed outbound TCP connections
  for (const c of input.connections) {
    const from = byId.get(c.fromId);
    if (!from) continue;
    const role = { ...portRole(c.remotePort) };
    // exact: a resource with this IP that listens on this port (container private port, published port, configured port)
    const candidates = byIp.get(c.remoteIp) ?? [];
    let to = candidates.find((r) => r.port === c.remotePort)
      ?? candidates.find((r) => publishes(r, c.remotePort, false))
      ?? input.resources.find((r) => r.kind === 'container' && publishes(r, c.remotePort, true) && hostOf(r, byId)?.ips.includes(c.remoteIp));
    if (!to && candidates.length) to = candidates.sort((a, b) => kindRank(a.kind) - kindRank(b.kind))[0];
    // a published port (5433 → 5432) keeps the role of the internal port
    const mapped = to && ((to.discovered.ports ?? []) as Array<{ private?: number; public?: number | null }>).find((p) => p.public === c.remotePort);
    if (mapped?.private) Object.assign(role, portRole(mapped.private));
    const ev = `${c.count}× offene TCP-Verbindung von „${from.label}“ zu ${c.remoteIp}:${c.remotePort} beobachtet${role.label.startsWith('TCP') ? '' : ` (${role.label})`}`;
    if (to) add({ from: from.id, to: to.id, target: null, type: role.type, strength: 'hard', source: 'connections', confidence: 'evidence', evidence: ev, data: { ip: c.remoteIp, port: c.remotePort, count: c.count } });
    else if (isPrivate(c.remoteIp)) add({ from: from.id, to: null, target: { host: c.remoteIp, port: c.remotePort, kind: role.kind, name: `${role.label.startsWith('TCP') ? 'Dienst' : role.label} ${c.remoteIp}:${c.remotePort}` },
      type: role.type, strength: 'hard', source: 'connections', confidence: 'evidence', evidence: `${ev} – Ziel nicht im Inventar`, data: { ip: c.remoteIp, port: c.remotePort, count: c.count } });
  }

  // 3. routing: host → default gateway; other machines in the same subnet probably use it too
  for (const r of input.routes) {
    if (!r.gateway) continue;
    const gw = pickByIp(r.gateway, r.hostId);
    const host = byId.get(r.hostId);
    if (!host) continue;
    const ev = `Routing-Tabelle von „${host.label}“: Default-Gateway ${r.gateway}`;
    if (gw) add({ from: host.id, to: gw.id, target: null, type: 'network_link', strength: 'hard', source: 'routing', confidence: 'evidence', evidence: ev, data: { gateway: r.gateway } });
    else add({ from: host.id, to: null, target: { host: r.gateway, kind: 'router', name: `Gateway ${r.gateway}` }, type: 'network_link', strength: 'hard', source: 'routing', confidence: 'evidence', evidence: `${ev} – nicht im Inventar`, data: { gateway: r.gateway } });
    if (!gw) continue;
    const subnet = r.subnets.find((s) => inCidr(r.gateway!, s));
    if (!subnet) continue;
    for (const other of input.resources) {
      if (other.id === host.id || other.id === gw.id || !['host', 'vm', 'hypervisor', 'nas', 'endpoint', 'storage', 'access_point', 'switch'].includes(other.kind)) continue;
      if (other.kind === 'vm' && other.parentId) continue; // VMs reach the network through their hypervisor
      const ip = other.ips.find((x) => inCidr(x, subnet));
      if (ip) add({ from: other.id, to: gw.id, target: null, type: 'network_link', strength: 'hard', source: 'routing', confidence: 'hint',
        evidence: `${ip} liegt im selben Subnetz ${subnet} wie Gateway ${r.gateway} – nutzt es vermutlich als Gateway`, data: { subnet } });
    }
  }

  // 4. resolver configuration
  for (const d of input.dns) {
    const host = byId.get(d.hostId);
    if (!host) continue;
    for (const ns of d.nameservers) {
      const dnsRes = pickByIp(ns, host.id);
      const ev = `Resolver-Konfiguration von „${host.label}“: Nameserver ${ns}`;
      if (dnsRes) add({ from: host.id, to: dnsRes.id, target: null, type: 'resolves_via', strength: 'hard', source: 'dns', confidence: 'evidence', evidence: ev, data: { nameserver: ns } });
      else add({ from: host.id, to: null, target: { host: ns, port: 53, kind: 'dns', name: `DNS ${ns}` }, type: 'resolves_via', strength: 'hard', source: 'dns', confidence: 'evidence', evidence: `${ev} – nicht im Inventar`, data: { nameserver: ns } });
    }
  }
  return [...out.values()];
}

function kindRank(kind: string) {
  return ['hypervisor', 'host', 'vm', 'nas', 'router', 'firewall', 'database', 'cache', 'broker', 'dns', 'service', 'proxy', 'endpoint', 'container'].indexOf(kind) + 1 || 99;
}
function publishes(r: SugResource, port: number, publicOnly: boolean) {
  return ((r.discovered.ports ?? []) as Array<{ private?: number; public?: number | null }>).some((p) => (publicOnly ? p.public === port : p.private === port || p.public === port));
}
function hostOf(r: SugResource, byId: Map<string, SugResource>) { return r.parentId ? byId.get(r.parentId) : undefined; }

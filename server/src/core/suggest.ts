/**
 * Dependency suggestions (pure). Every suggestion carries the evidence it is based on and a
 * confidence: "sure" (an authoritative API says so, e.g. vSphere), "evidence" (observed on the
 * system: open TCP connections, routing table, traceroute, resolver config), "hint" (inferred, e.g. same host name).
 * Nothing here changes the inventory; a person (or later a rule) accepts suggestions.
 */
import { inCidr } from './rules.js';

export interface SugResource {
  id: string; label: string; kind: string; identityKey: string | null; parentId: string | null;
  ips: string[]; macs?: string[]; locked?: string[]; port: number | null; discovered: Record<string, any>;
}
export interface SugEdge { id?: string; from: string; to: string; suppressed: boolean; strength?: string; description?: string | null }
export interface VmFact { vmIdentity: string; name: string; ips: string[]; macs?: string[]; guestHostname?: string | null; hostIdentity: string | null; datastores: Array<{ name: string; remote_host: string | null }> }
export interface HypervisorFact { identity: string; name: string; ips: string[]; gateway?: string | null; datastores: Array<{ name: string; remote_host: string | null }> }
export interface ConnectionFact { fromId: string; remoteIp: string; remotePort: number; count: number }
/** gateway: default route of a host; path: private router hops after it (traceroute), wan: first public hop */
export interface RouteFact { hostId: string; gateway: string | null; subnets: string[]; path?: string[]; wan?: string | null }
export interface DnsFact { hostId: string; nameservers: string[] }

export interface Suggestion {
  key: string;
  from: string;
  to: string | null;
  target: { host: string; port?: number; kind: string; name: string } | null;
  type: string;
  strength: 'hard' | 'soft';
  source: 'vmware' | 'connections' | 'routing' | 'dns' | 'identity' | 'cleanup';
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
  const byMac = new Map<string, SugResource[]>();
  for (const r of input.resources) if (r.kind !== 'container') for (const m of r.macs ?? []) byMac.set(m, [...(byMac.get(m) ?? []), r]);
  const linked = new Set<string>();
  const removed = new Set<string>();
  for (const e of input.edges) {
    if (e.suppressed) removed.add(`${e.from}>${e.to}`);
    else { linked.add(`${e.from}>${e.to}`); linked.add(`${e.to}>${e.from}`); }
  }
  const out = new Map<string, Suggestion>();
  const sameMachine = (a: string, b: string) => {
    const x = byId.get(a), y = byId.get(b);
    return !!x && !!y && x.kind !== 'container' && y.kind !== 'container' && (x.ips.some((ip) => y.ips.includes(ip)) || (x.macs ?? []).some((m) => (y.macs ?? []).includes(m)));
  };
  const META = ['same_as', 'remove_edge', 'set_kind'];
  const add = (s: Omit<Suggestion, 'key'>) => {
    if (s.type === 'set_kind' || s.type === 'remove_edge') {
      const key = `${s.from}>${s.type}:${s.type === 'set_kind' ? s.data.kind : s.data.dependency_id}`;
      if (!out.has(key)) out.set(key, { ...s, key });
      return;
    }
    if (!META.includes(s.type) && s.to && sameMachine(s.from, s.to)) return;
    if (s.to && (s.to === s.from || linked.has(`${s.from}>${s.to}`) || removed.has(`${s.from}>${s.to}`))) return;
    const key = `${s.from}>${s.to ?? `ext:${s.target!.host}${s.target!.port ? ':' + s.target!.port : ''}`}>${s.type}`;
    const cur = out.get(key);
    const rank = { sure: 3, evidence: 2, hint: 1 };
    if (!cur || rank[s.confidence] > rank[cur.confidence]) out.set(key, { ...s, key });
  };
  /** prefer the most specific resource for an IP: hypervisor/host/vm/nas over containers and endpoints */
  const pickByIp = (ip: string, exclude?: string, prefer: string[] = []) => (byIp.get(ip) ?? []).filter((r) => r.id !== exclude)
    .sort((a, b) => (prefer.includes(a.kind) ? 0 : 1) - (prefer.includes(b.kind) ? 0 : 1) || kindRank(a.kind) - kindRank(b.kind))[0];
  const GATEWAY_KINDS = ['router', 'firewall', 'wan'];

  // 0. identity: two inventory entries with the same IPv4 address are the same machine (merge, not an edge)
  for (const [ip, list] of byIp) {
    const machines = list.filter((r) => r.kind !== 'container').sort((a, b) => specificity(a.kind) - specificity(b.kind));
    if (machines.length < 2) continue;
    const keep = machines[0];
    for (const other of machines.slice(1)) {
      add({ from: other.id, to: keep.id, target: null, type: 'same_as', strength: 'hard', source: 'identity', confidence: 'sure',
        evidence: `„${other.label}“ und „${keep.label}“ haben dieselbe IP-Adresse ${ip} – dasselbe Gerät; beim Übernehmen wird „${other.label}“ in „${keep.label}“ zusammengeführt`, data: { ip } });
    }
  }
  // same MAC address = same network card (works for VMs without VMware Tools, e.g. OPNsense)
  for (const [mac, list] of byMac) {
    const machines = [...new Map(list.map((r) => [r.id, r])).values()].sort((a, b) => specificity(a.kind) - specificity(b.kind));
    if (machines.length < 2) continue;
    const keep = machines[0];
    for (const other of machines.slice(1)) {
      add({ from: other.id, to: keep.id, target: null, type: 'same_as', strength: 'hard', source: 'identity', confidence: 'sure',
        evidence: `„${other.label}“ und „${keep.label}“ haben dieselbe MAC-Adresse ${mac} – dieselbe Netzwerkkarte; beim Übernehmen wird „${other.label}“ in „${keep.label}“ zusammengeführt`, data: { mac } });
    }
  }
  // same host name (reverse DNS / guest host name vs. VM or host name): only a hint
  const shortName = (n: unknown) => (typeof n === 'string' && n && !/^\d+\.\d+\.\d+\.\d+$/.test(n) ? n.toLowerCase().split('.')[0].replace(/[^a-z0-9]/g, '') : '');
  const byName = new Map<string, SugResource[]>();
  for (const r of input.resources) {
    if (r.kind === 'container') continue;
    const names = new Set([shortName(r.label), shortName(r.discovered.rdns), shortName(r.discovered.guest_hostname)].filter((x) => x.length >= 3));
    for (const n of names) byName.set(n, [...(byName.get(n) ?? []), r]);
  }
  for (const [n, list] of byName) {
    const machines = [...new Map(list.map((r) => [r.id, r])).values()].sort((a, b) => specificity(a.kind) - specificity(b.kind));
    for (const other of machines.slice(1)) {
      if (sameMachine(other.id, machines[0].id)) continue; // already covered by IP/MAC
      add({ from: other.id, to: machines[0].id, target: null, type: 'same_as', strength: 'hard', source: 'identity', confidence: 'hint',
        evidence: `„${other.label}“ und „${machines[0].label}“ tragen denselben Namen „${n}“ – vermutlich dasselbe Gerät, bitte prüfen`, data: { name: n } });
    }
  }

  // 1. vSphere: VM → runs on → ESXi host; host/VM → NFS datastore server
  const hvResource = (identity: string | null, ips: string[] = []) => (identity && byIdentity.get(identity)) || ips.map((ip) => pickByIp(ip)).find(Boolean);
  for (const vm of input.vms) {
    const hvFact = input.hypervisors.find((h) => h.identity === vm.hostIdentity);
    const hv = hvResource(vm.hostIdentity, hvFact?.ips);
    const vmRes = byIdentity.get(vm.vmIdentity);
    const holders = new Map<string, SugResource>();
    if (vmRes) holders.set(vmRes.id, vmRes);
    for (const ip of vm.ips) for (const r of byIp.get(ip) ?? []) if (!['hypervisor', 'container'].includes(r.kind)) holders.set(r.id, r);
    for (const m of vm.macs ?? []) for (const r of byMac.get(m) ?? []) if (r.kind !== 'hypervisor') holders.set(r.id, r);
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
  // a hypervisor's own storage mounts are not dependencies (the VMs on them are); its network uplink is
  for (const h of input.hypervisors) {
    const hv = hvResource(h.identity, h.ips);
    if (!hv || !h.gateway) continue;
    const gw = pickByIp(h.gateway, hv.id, GATEWAY_KINDS);
    const ev = `vSphere: Default-Gateway von ESXi-Host „${h.name}“ ist ${h.gateway}`;
    if (gw) add({ from: hv.id, to: gw.id, target: null, type: 'network_link', strength: 'hard', source: 'vmware', confidence: 'sure', evidence: ev, data: { gateway: h.gateway } });
    else add({ from: hv.id, to: null, target: { host: h.gateway, kind: 'router', name: `Gateway ${h.gateway}` }, type: 'network_link', strength: 'hard', source: 'vmware', confidence: 'sure', evidence: `${ev} – nicht im Inventar`, data: { gateway: h.gateway } });
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

  // 3. routing: host → default gateway → next router hops (traceroute) → internet.
  //    Machines in the same subnet talk directly; they do NOT depend on the gateway for that, so
  //    there is no subnet-based guessing any more.
  const asRouter = (r: SugResource | undefined, why: string) => {
    if (r && ['endpoint', 'other', 'host'].includes(r.kind) && !(r.locked ?? []).includes('kind')) {
      add({ from: r.id, to: null, target: null, type: 'set_kind', strength: 'hard', source: 'routing', confidence: 'evidence',
        evidence: `„${r.label}“ ${why} – als Router/Gateway einordnen (Ebene Netzwerk)`, data: { kind: 'router', rename: /^_gateway/.test(r.label) || /^\d+\.\d+\.\d+\.\d+$/.test(r.label) ? `Gateway ${r.ips[0] ?? ''}`.trim() : null } });
    }
  };
  for (const r of input.routes) {
    const host = byId.get(r.hostId);
    if (!host || !r.gateway) continue;
    const chain = [r.gateway, ...(r.path ?? []).filter((ip) => ip !== r.gateway)];
    const ev = `Routing-Tabelle von „${host.label}“: Default-Gateway ${r.gateway}`;
    let prev: { res: SugResource | null; ip: string; label: string } = { res: host, ip: host.ips[0] ?? '', label: host.label };
    chain.forEach((ip, i) => {
      const hop = pickByIp(ip, prev.res?.id, GATEWAY_KINDS);
      asRouter(hop, i === 0 ? `ist das Default-Gateway von „${host.label}“` : `leitet laut Traceroute den Verkehr weiter (Hop ${i + 1})`);
      const evidence = i === 0 ? ev : `Traceroute von „${host.label}“ ins Internet: nach ${prev.ip} folgt ${ip}`;
      // a VM reaches the network through its hypervisor: no direct VM → gateway edge (the chain after it stays)
      const viaHypervisor = i === 0 && host.kind === 'vm' && !!host.parentId;
      if (prev.res && !viaHypervisor) {
        if (hop) add({ from: prev.res.id, to: hop.id, target: null, type: 'network_link', strength: 'hard', source: 'routing', confidence: 'evidence', evidence, data: { gateway: ip, hop: i + 1 } });
        else add({ from: prev.res.id, to: null, target: { host: ip, kind: 'router', name: `Gateway ${ip}` }, type: 'network_link', strength: 'hard', source: 'routing', confidence: 'evidence', evidence: `${evidence} – nicht im Inventar`, data: { gateway: ip, hop: i + 1 } });
      }
      prev = { res: hop ?? null, ip, label: hop?.label ?? ip };
    });
    // the last router before public addresses is the internet uplink
    if (r.wan && prev.res && (r.path ?? []).length > 0) {
      const wan = input.resources.find((x) => x.kind === 'wan');
      const evidence = `Traceroute von „${host.label}“: nach ${prev.ip} folgt die erste öffentliche Adresse ${r.wan} – Übergang ins Internet`;
      if (wan) add({ from: prev.res.id, to: wan.id, target: null, type: 'network_link', strength: 'hard', source: 'routing', confidence: 'evidence', evidence, data: { wan: r.wan } });
      else add({ from: prev.res.id, to: null, target: { host: '1.1.1.1', kind: 'wan', name: 'Internet (WAN)' }, type: 'network_link', strength: 'hard', source: 'routing', confidence: 'evidence', evidence, data: { wan: r.wan } });
    }
  }

  // cleanup: edges accepted from the removed "same subnet as the gateway" rule are wrong
  for (const e of input.edges) {
    if (!e.id || e.suppressed || !(e.description ?? '').includes('selben Subnetz')) continue;
    add({ from: e.from, to: e.to, target: null, type: 'remove_edge', strength: 'soft', source: 'cleanup', confidence: 'sure',
      evidence: `Diese Abhängigkeit stammt aus der alten Regel „gleiches Subnetz wie das Gateway“. Geräte im selben Subnetz reden direkt miteinander und hängen dafür nicht vom Gateway ab – Abhängigkeit entfernen`, data: { dependency_id: e.id } });
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

/** lower = more specific; the most specific entry survives a merge */
function specificity(kind: string) {
  const order = ['hypervisor', 'vm', 'nas', 'router', 'firewall', 'switch', 'access_point', 'host', 'storage', 'database', 'dns', 'proxy', 'service', 'platform'];
  const i = order.indexOf(kind);
  return i < 0 ? (kind === 'endpoint' ? 90 : kind === 'other' ? 95 : 50) : i;
}

function kindRank(kind: string) {
  return ['hypervisor', 'host', 'vm', 'nas', 'router', 'firewall', 'database', 'cache', 'broker', 'dns', 'service', 'proxy', 'endpoint', 'container'].indexOf(kind) + 1 || 99;
}
function publishes(r: SugResource, port: number, publicOnly: boolean) {
  return ((r.discovered.ports ?? []) as Array<{ private?: number; public?: number | null }>).some((p) => (publicOnly ? p.public === port : p.private === port || p.public === port));
}
function hostOf(r: SugResource, byId: Map<string, SugResource>) { return r.parentId ? byId.get(r.parentId) : undefined; }

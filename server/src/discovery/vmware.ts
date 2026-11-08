import { q1 } from '../db/pool.js';
import { unseal } from '../lib/crypto.js';
import { VsphereClient, arr, type VsphereObject } from '../lib/vsphere.js';
import type { DiscoveredItem } from '../core/types.js';
import type { DiscoveryAdapter, SourceRow } from './adapter.js';

const isV4 = (ip: unknown): ip is string => typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && !ip.startsWith('169.254.') && !ip.startsWith('127.');

async function password(source: SourceRow): Promise<string> {
  if (!source.config.secret_id) throw new Error('keine Zugangsdaten gewählt');
  const s = await q1(`SELECT ciphertext, iv, auth_tag FROM secrets WHERE id = $1`, [source.config.secret_id]);
  if (!s) throw new Error('gewählte Zugangsdaten existieren nicht mehr');
  return unseal({ ciphertext: s.ciphertext, iv: s.iv, authTag: s.auth_tag });
}

/** Pure mapping from vSphere inventory to discovered items (unit-tested with fixtures). */
export function mapVsphere(hosts: VsphereObject[], vms: VsphereObject[], datastores: VsphereObject[], endpointHost: string): DiscoveredItem[] {
  const dsById = new Map(datastores.map((d) => [d.moid, d]));
  const dsInfo = (ids: unknown) => arr(ids as string[]).map((id) => dsById.get(id)).filter(Boolean).map((d) => ({
    name: d!.props.name, type: d!.props['summary.type'] ?? null, remote_host: d!.props.info?.nas?.remoteHost ?? null, remote_path: d!.props.info?.nas?.remotePath ?? null,
  }));
  const hostKey = new Map<string, string>();
  const items: DiscoveredItem[] = [];
  for (const h of hosts) {
    const name = String(h.props.name);
    const key = `vmware-host:${name.toLowerCase()}`;
    hostKey.set(h.moid, key);
    const vnics = arr(h.props['config.network.vnic']);
    const ips = vnics.map((n: any) => n?.spec?.ip?.ipAddress).filter(isV4).sort();
    const hw = h.props['summary.hardware'] ?? {};
    items.push({
      identityKey: key, kind: 'hypervisor', name, running: h.props['runtime.connectionState'] !== 'disconnected',
      attributes: {
        product: h.props['summary.config.product.fullName'] ?? null, vendor: hw.vendor ?? null, model: hw.model ?? null, cpu_model: hw.cpuModel ?? null,
        cpus: hw.numCpuCores ? Number(hw.numCpuCores) : null, mem_total: hw.memorySize ? Number(hw.memorySize) : null,
        ips, gateway: isV4(h.props['config.network.ipRouteConfig']?.defaultGateway) ? h.props['config.network.ipRouteConfig'].defaultGateway : null,
        state: h.props['runtime.connectionState'] ?? null, power_state: h.props['runtime.powerState'] ?? null,
        datastores: dsInfo(h.props.datastore), vmware_moid: h.moid, vmware_endpoint: endpointHost,
      },
      connection: { host: ips[0] ?? endpointHost },
    });
  }
  for (const v of vms) {
    if (String(v.props['config.template']) === 'true') continue;
    const uuid = v.props['config.instanceUuid'];
    const nets = arr(v.props['guest.net']);
    const ips = [...new Set([v.props['guest.ipAddress'], ...nets.flatMap((n: any) => arr(n?.ipAddress))].filter(isV4))].sort();
    const hwMacs = arr(v.props['config.hardware.device']).map((d: any) => d?.macAddress).filter(Boolean);
    const macs = [...new Set([...nets.map((n: any) => n?.macAddress), ...hwMacs].filter(Boolean).map((m: string) => m.toLowerCase()))].sort();
    const parent = hostKey.get(String(v.props['runtime.host']));
    const power = v.props['runtime.powerState'] ?? null;
    items.push({
      identityKey: uuid ? `vmware-vm:${String(uuid).toLowerCase()}` : `vmware-vm:${endpointHost}/${v.moid}`,
      kind: 'vm', name: String(v.props.name), parentIdentityKey: parent, running: power === 'poweredOn',
      attributes: {
        guest_os: v.props['config.guestFullName'] ?? null, guest_hostname: v.props['guest.hostName'] ?? null, ips, macs, state: power,
        cpus: v.props['summary.config.numCpu'] ? Number(v.props['summary.config.numCpu']) : null,
        mem_total: v.props['summary.config.memorySizeMB'] ? Number(v.props['summary.config.memorySizeMB']) * 1024 * 1024 : null,
        datastores: dsInfo(v.props.datastore), vmware_moid: v.moid, vmware_endpoint: endpointHost,
        tools: v.props['guest.toolsRunningStatus'] ?? null,
      },
      connection: { host: ips[0] ?? null },
    });
  }
  return items;
}

/**
 * VMware ESXi / vCenter via the vSphere web services API (read-only user is enough).
 * Hosts become hypervisors, VMs become children of the host they run on.
 */
export const vmwareAdapter: DiscoveryAdapter = {
  type: 'vmware',
  label: 'VMware ESXi / vCenter',
  async availability(source) {
    if (!source.config.url) return 'keine Adresse konfiguriert';
    if (!source.config.username || !source.config.secret_id) return 'Benutzer oder Zugangsdaten fehlen';
    return null;
  },
  async discover(source) {
    const c = new VsphereClient(source.config.url, { allowUntrusted: source.config.allow_untrusted !== false });
    try {
      await c.connect(source.config.username, await password(source));
      const hosts = await c.list('HostSystem', ['name', 'summary.hardware', 'summary.config.product.fullName', 'config.network.vnic', 'config.network.ipRouteConfig', 'runtime.connectionState', 'runtime.powerState', 'datastore']);
      const vms = await c.list('VirtualMachine', ['name', 'config.instanceUuid', 'config.guestFullName', 'config.template', 'config.hardware.device', 'runtime.host', 'runtime.powerState', 'guest.ipAddress', 'guest.net', 'guest.hostName', 'guest.toolsRunningStatus', 'summary.config.numCpu', 'summary.config.memorySizeMB', 'datastore']);
      const ds = await c.list('Datastore', ['name', 'summary.type', 'info']);
      return mapVsphere(hosts, vms, ds, new URL(source.config.url.includes('://') ? source.config.url : `https://${source.config.url}`).hostname);
    } finally {
      await c.logout();
    }
  },
};

/** Connection test for the source dialog. */
export async function testVsphere(cfg: Record<string, any>, pw: string) {
  const c = new VsphereClient(cfg.url, { allowUntrusted: cfg.allow_untrusted !== false, timeoutMs: 10000 });
  try {
    const about = await c.connect(cfg.username, pw);
    const hosts = await c.list('HostSystem', ['name']);
    const vms = await c.list('VirtualMachine', ['name']);
    return { ok: true, ...about, hosts: hosts.length, vms: vms.length };
  } finally {
    await c.logout();
  }
}

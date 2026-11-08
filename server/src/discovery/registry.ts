import type { DiscoveryAdapter } from './adapter.js';
import { dockerAdapter } from './docker.js';
import { hostAdapter } from './host.js';
import { networkAdapter } from './network.js';

/** All discovery adapters. Add Podman/SNMP/Proxmox/... here. */
export const adapters: Record<string, DiscoveryAdapter> = {
  [dockerAdapter.type]: dockerAdapter,
  [hostAdapter.type]: hostAdapter,
  [networkAdapter.type]: networkAdapter,
};

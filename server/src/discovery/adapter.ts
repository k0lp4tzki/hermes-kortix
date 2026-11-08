import type { DiscoveredItem } from '../core/types.js';

export interface SourceRow { id: string; name: string; type: string; config: Record<string, any> }

/**
 * A discovery adapter turns one configured source into DiscoveredItems.
 * New runtimes (Podman, SNMP, Proxmox, Windows/WinRM, ...) plug in by implementing this
 * interface and registering in ./registry.ts; reconciliation, rules and the inbox are shared.
 */
export interface DiscoveryAdapter {
  type: string;
  label: string;
  /** Returns null when the adapter can run, else a human-readable reason ("nicht verfügbar"). */
  availability(source: SourceRow): Promise<string | null>;
  discover(source: SourceRow): Promise<DiscoveredItem[]>;
}

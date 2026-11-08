/**
 * Shared domain types. Everything under src/core is pure (no I/O) so the
 * discovery reconciliation, state engine and dependency analysis are unit-testable.
 */

export type ResourceKind =
  | 'host' | 'vm' | 'hypervisor' | 'container' | 'compose_project' | 'systemd_service'
  | 'service' | 'endpoint' | 'database' | 'cache' | 'broker' | 'proxy' | 'dns' | 'dhcp'
  | 'router' | 'firewall' | 'switch' | 'access_point' | 'wan' | 'nas' | 'storage'
  | 'external_api' | 'backup_job' | 'platform' | 'network' | 'other';

export const RESOURCE_KINDS: ResourceKind[] = [
  'host', 'vm', 'hypervisor', 'container', 'compose_project', 'systemd_service', 'service', 'endpoint',
  'database', 'cache', 'broker', 'proxy', 'dns', 'dhcp', 'router', 'firewall', 'switch', 'access_point',
  'wan', 'nas', 'storage', 'external_api', 'backup_job', 'platform', 'network', 'other',
];

export type Criticality = 'low' | 'medium' | 'high' | 'critical';
export type State = 'ok' | 'warning' | 'critical' | 'unknown';
export type ResourceStatus = State | 'pending' | 'unmonitored';

/** A thing an adapter found during one discovery run. */
export interface DiscoveredItem {
  /** Stable logical identity, e.g. docker:<engine>/compose/<project>/<service>. Survives container re-creation. */
  identityKey: string;
  kind: ResourceKind;
  name: string;
  /** identityKey of the parent (host for a container). */
  parentIdentityKey?: string;
  /** Technical attributes as discovered (image, ports, ips, labels, container id ...). */
  attributes: Record<string, unknown>;
  /** Connection hints used for default checks (host, port, url). */
  connection?: Record<string, unknown>;
  /** Logical dependencies the adapter can prove (compose depends_on): identityKeys of providers. */
  dependsOn?: string[];
  /** When false the item is reported but not considered alive (e.g. stopped container). */
  running?: boolean;
}

/** Attributes whose change is reported as a discovery change event. */
export const FINGERPRINT_FIELDS = ['image', 'container_id', 'ips', 'ports', 'labels', 'networks', 'state', 'health', 'compose_project', 'compose_service', 'kernel', 'os', 'open_ports', 'unit_state'];

export interface RuleMatch {
  kinds?: string[];
  source_ids?: string[];
  source_types?: string[];
  name_glob?: string;
  image_glob?: string;
  compose_project?: string;
  labels?: Record<string, string>;
  cidrs?: string[];
  ports?: number[];
}

export type RuleAction = 'auto_accept' | 'ignore' | 'manual';

export interface DiscoveryRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  match: RuleMatch;
  action: RuleAction;
  enable_monitoring: boolean;
  set: { environment?: string; group_name?: string; criticality?: Criticality; owner?: string; tags?: string[] };
}

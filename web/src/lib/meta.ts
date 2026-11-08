export const KIND_LABEL: Record<string, string> = {
  host: 'Host', vm: 'VM', hypervisor: 'Virtualisierungshost', container: 'Container', compose_project: 'Compose-Projekt',
  systemd_service: 'systemd-Dienst', service: 'Anwendung', endpoint: 'Endpunkt', database: 'Datenbank', cache: 'Cache',
  broker: 'Message Broker', proxy: 'Reverse Proxy', dns: 'DNS', dhcp: 'DHCP', router: 'Router/Gateway', firewall: 'Firewall',
  switch: 'Switch', access_point: 'WLAN-AP', wan: 'Internet/WAN', nas: 'NAS', storage: 'Storage', external_api: 'Externe API',
  backup_job: 'Backup-Job', platform: 'Monitoring-Plattform', network: 'Netzwerk/VLAN', other: 'Sonstiges',
};
export const KINDS = Object.keys(KIND_LABEL);
export const CRIT_LABEL: Record<string, string> = { low: 'niedrig', medium: 'mittel', high: 'hoch', critical: 'kritisch' };
export const CRITS = ['low', 'medium', 'high', 'critical'];
export const STATUSES = ['critical', 'warning', 'unknown', 'ok', 'pending', 'unmonitored'];
export const STATUS_RANK: Record<string, number> = { critical: 5, warning: 4, unknown: 3, pending: 2, ok: 1, unmonitored: 0 };
export const DISCOVERY_LABEL: Record<string, string> = { active: 'aktiv', missing: 'fehlt', orphaned: 'verwaist', detached: 'gelöst' };
export const DEP_TYPES: Record<string, string> = {
  runs_on: 'läuft auf', depends_on: 'hängt ab von', uses_db: 'nutzt Datenbank', uses_cache: 'nutzt Cache', uses_broker: 'nutzt Message Broker',
  proxied_by: 'wird bereitgestellt über Proxy', resolves_via: 'löst Namen auf über DNS', backup_source: 'Backup von', backup_storage: 'Backup nach',
  consumes_api: 'nutzt externe API', network_link: 'Netzwerkverbindung', powered_by: 'Strom über', other: 'sonstige Abhängigkeit',
};

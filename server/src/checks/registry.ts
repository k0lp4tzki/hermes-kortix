import type { CheckExecutor } from './types.js';
import { dnsCheck, httpCheck, pingCheck, sshCheck, tcpCheck, tlsCheck } from './network.js';
import { mysqlCheck, postgresCheck, redisCheck } from './databases.js';
import { containerCheck, containerLogsCheck } from './container.js';
import { hostCheck } from './host.js';
import { fileAgeCheck, heartbeatCheck, secretExpiryCheck, systemdCheck } from './ops.js';
import { platformCheck } from './platform.js';

export const executors: Record<string, CheckExecutor> = Object.fromEntries(
  [pingCheck, tcpCheck, httpCheck, dnsCheck, tlsCheck, sshCheck, postgresCheck, mysqlCheck, redisCheck, containerCheck, containerLogsCheck, hostCheck, systemdCheck, fileAgeCheck, heartbeatCheck, secretExpiryCheck, platformCheck]
    .map((e) => [e.type, e]),
);

/** Check types that do not exist yet but are planned (shown as "nicht verfügbar"). */
export const plannedCheckTypes = [
  { type: 'snmp', label: 'SNMP (Switches, Router, USV)', reason: 'nicht in v1 – Netzwerkgeräte manuell anlegen und per Ping/TCP/HTTP prüfen' },
  { type: 'smart', label: 'SMART-Werte', reason: 'benötigt privilegierten Zugriff auf Block-Geräte' },
  { type: 'winrm', label: 'Windows-Hosts', reason: 'nicht in v1' },
];

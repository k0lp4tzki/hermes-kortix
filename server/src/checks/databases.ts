import pg from 'pg';
import mysql from 'mysql2/promise';
import { Redis } from 'ioredis';
import type { CheckExecutor, CheckContext } from './types.js';
import { compact, m, ConfigError } from './types.js';

function dbTarget(ctx: CheckContext, defPort: number) {
  const c = ctx.check.config;
  const host = c.host || ctx.resource.connection.host;
  if (!host && ctx.secret?.kind !== 'connection_string') throw new ConfigError('kein Host konfiguriert (oder Zugangsdaten vom Typ Verbindungs-URL hinterlegen)');
  return { host, port: Number(c.port || ctx.resource.connection.port || defPort) };
}

const commonFields = (defPort: number, userDefault: string) => [
  { key: 'host', label: 'Host', type: 'text' as const, fromConnection: 'host' },
  { key: 'port', label: 'Port', type: 'number' as const, default: defPort },
  { key: 'username', label: 'Benutzer', type: 'text' as const, default: userDefault, hint: 'Ein Benutzer mit Leserechten genügt' },
];

export const postgresCheck: CheckExecutor = {
  type: 'postgres', label: 'PostgreSQL', category: 'Datenbank', defaultInterval: 60, usesSecret: 'optional',
  description: 'Verbindung, Read-only-Abfrage (SELECT 1), Antwortzeit, Verbindungsauslastung, Replikation, Datenbankgröße.',
  fields: [...commonFields(5432, 'postgres'), { key: 'database', label: 'Datenbank', type: 'text', default: 'postgres' }, { key: 'ssl', label: 'TLS verwenden', type: 'boolean', default: false }],
  defaultThresholds: [{ metric: 'query_ms', op: '>', warning: 200, critical: 2000 }, { metric: 'connections_percent', op: '>', warning: 80, critical: 95 }, { metric: 'replication_lag_s', op: '>', warning: 30, critical: 300 }],
  metrics: [
    { name: 'query_ms', unit: 'ms', label: 'Abfragezeit' }, { name: 'connect_ms', unit: 'ms', label: 'Verbindungsaufbau' }, { name: 'connections', unit: 'count', label: 'Verbindungen' },
    { name: 'connections_percent', unit: 'percent', label: 'Verbindungsauslastung' }, { name: 'db_size_bytes', unit: 'bytes', label: 'Größe' },
    { name: 'replication_lag_s', unit: 's', label: 'Replikationsverzug' }, { name: 'replicas', unit: 'count', label: 'Replikas' }, { name: 'is_replica', unit: 'bool', label: 'Ist Replika' },
  ],
  async run(ctx) {
    const c = ctx.check.config;
    const conf: pg.ClientConfig = ctx.secret?.kind === 'connection_string'
      ? { connectionString: ctx.secret.value }
      : { ...dbTarget(ctx, 5432), user: c.username || 'postgres', password: ctx.secret?.value, database: c.database || 'postgres', ssl: c.ssl ? { rejectUnauthorized: false } : undefined };
    const client = new pg.Client({ ...conf, connectionTimeoutMillis: ctx.check.timeout_ms, query_timeout: ctx.check.timeout_ms, application_name: 'hermes-healthcheck' });
    const t0 = performance.now();
    try {
      await client.connect();
      const connectMs = performance.now() - t0;
      await client.query('SET default_transaction_read_only = on');
      const t1 = performance.now();
      await client.query('SELECT 1');
      const queryMs = performance.now() - t1;
      const s = (await client.query(`SELECT (SELECT count(*) FROM pg_stat_activity)::int AS conns, current_setting('max_connections')::int AS max_conns,
        pg_database_size(current_database())::bigint AS size, pg_is_in_recovery() AS replica,
        CASE WHEN pg_is_in_recovery() THEN extract(epoch FROM now() - pg_last_xact_replay_timestamp()) END AS lag,
        (SELECT count(*) FROM pg_stat_replication)::int AS replicas, version() AS version`)).rows[0];
      const metrics = compact({
        connect_ms: m(connectMs, 'ms'), query_ms: m(queryMs, 'ms'), connections: m(s.conns, 'count'), connections_percent: m((s.conns / s.max_conns) * 100, 'percent'),
        db_size_bytes: m(Number(s.size), 'bytes'), is_replica: m(s.replica ? 1 : 0, 'bool'), replication_lag_s: m(s.lag === null ? null : Number(s.lag), 's'), replicas: m(s.replicas, 'count'),
      });
      return { status: 'ok', message: `${String(s.version).split(' on ')[0]}: ${s.conns}/${s.max_conns} Verbindungen${s.replica ? ', Replika' : s.replicas ? `, ${s.replicas} Replikas` : ''}`, metrics };
    } catch (e) {
      return { status: 'critical', message: `PostgreSQL: ${(e as Error).message}`, metrics: compact({ connect_ms: undefined }) };
    } finally {
      client.end().catch(() => {});
    }
  },
};

export const mysqlCheck: CheckExecutor = {
  type: 'mysql', label: 'MySQL / MariaDB', category: 'Datenbank', defaultInterval: 60, usesSecret: 'optional',
  description: 'Verbindung, SELECT 1, Antwortzeit, Threads/Verbindungen, Replikationsstatus.',
  fields: [...commonFields(3306, 'root'), { key: 'database', label: 'Datenbank (optional)', type: 'text' }],
  defaultThresholds: [{ metric: 'query_ms', op: '>', warning: 200, critical: 2000 }, { metric: 'connections_percent', op: '>', warning: 80, critical: 95 }, { metric: 'replication_lag_s', op: '>', warning: 30, critical: 300 }],
  metrics: [
    { name: 'query_ms', unit: 'ms', label: 'Abfragezeit' }, { name: 'connections', unit: 'count', label: 'Verbindungen' }, { name: 'connections_percent', unit: 'percent', label: 'Verbindungsauslastung' },
    { name: 'threads_running', unit: 'count', label: 'Aktive Threads' }, { name: 'replication_lag_s', unit: 's', label: 'Replikationsverzug' }, { name: 'aborted_connects', unit: 'count', label: 'Abgebrochene Verbindungen' },
  ],
  async run(ctx) {
    const c = ctx.check.config;
    const t = ctx.secret?.kind === 'connection_string' ? { uri: ctx.secret.value } : { ...dbTarget(ctx, 3306), user: c.username || 'root', password: ctx.secret?.value, database: c.database || undefined };
    let conn: mysql.Connection | null = null;
    const t0 = performance.now();
    try {
      conn = await mysql.createConnection({ ...(t as any), connectTimeout: ctx.check.timeout_ms });
      const connectMs = performance.now() - t0;
      const t1 = performance.now();
      await conn.query('SELECT 1');
      const queryMs = performance.now() - t1;
      const [statusRows] = await conn.query(`SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Aborted_connects','Uptime')`) as any;
      const st: Record<string, number> = Object.fromEntries(statusRows.map((r: any) => [r.Variable_name, Number(r.Value)]));
      const [vars] = await conn.query(`SHOW VARIABLES WHERE Variable_name IN ('max_connections','version')`) as any;
      const v: Record<string, string> = Object.fromEntries(vars.map((r: any) => [r.Variable_name, r.Value]));
      let lag: number | null = null;
      let replication = '';
      try {
        const [rep] = await conn.query('SHOW REPLICA STATUS') as any;
        if (rep?.length) {
          lag = rep[0].Seconds_Behind_Source ?? rep[0].Seconds_Behind_Master ?? null;
          const io = rep[0].Replica_IO_Running ?? rep[0].Slave_IO_Running;
          const sql = rep[0].Replica_SQL_Running ?? rep[0].Slave_SQL_Running;
          replication = `, Replikation IO=${io} SQL=${sql}`;
          if (io !== 'Yes' || sql !== 'Yes') return { status: 'critical', message: `Replikation gestoppt (IO=${io}, SQL=${sql})`, metrics: compact({ query_ms: m(queryMs, 'ms') }) };
        }
      } catch { /* no privilege or not a replica */ }
      const max = Number(v.max_connections);
      const metrics = compact({
        connect_ms: m(connectMs, 'ms'), query_ms: m(queryMs, 'ms'), connections: m(st.Threads_connected, 'count'), connections_percent: m(max ? (st.Threads_connected / max) * 100 : null, 'percent'),
        threads_running: m(st.Threads_running, 'count'), aborted_connects: m(st.Aborted_connects, 'count'), uptime_s: m(st.Uptime, 's'), replication_lag_s: m(lag === null ? null : Number(lag), 's'),
      });
      return { status: 'ok', message: `${v.version}: ${st.Threads_connected}/${max} Verbindungen${replication}`, metrics };
    } catch (e) {
      return { status: 'critical', message: `MySQL: ${(e as Error).message}` };
    } finally {
      conn?.end().catch(() => {});
    }
  },
};

export const redisCheck: CheckExecutor = {
  type: 'redis', label: 'Redis', category: 'Datenbank', defaultInterval: 60, usesSecret: 'optional',
  description: 'PING-Latenz, Clients, Speicher, Rolle/Replikation und Status der letzten Persistierung (RDB).',
  fields: [{ key: 'host', label: 'Host', type: 'text', fromConnection: 'host' }, { key: 'port', label: 'Port', type: 'number', default: 6379 }, { key: 'username', label: 'Benutzer (ACL, optional)', type: 'text' }, { key: 'tls', label: 'TLS', type: 'boolean', default: false }],
  defaultThresholds: [{ metric: 'ping_ms', op: '>', warning: 50, critical: 500 }, { metric: 'memory_percent', op: '>', warning: 85, critical: 95 }, { metric: 'clients_percent', op: '>', warning: 80, critical: 95 }],
  metrics: [
    { name: 'ping_ms', unit: 'ms', label: 'PING' }, { name: 'connected_clients', unit: 'count', label: 'Clients' }, { name: 'clients_percent', unit: 'percent', label: 'Client-Auslastung' },
    { name: 'used_memory_bytes', unit: 'bytes', label: 'Speicher' }, { name: 'memory_percent', unit: 'percent', label: 'Speicher vs. maxmemory' },
    { name: 'last_save_age_s', unit: 's', label: 'Alter letzte Persistierung' }, { name: 'connected_replicas', unit: 'count', label: 'Replikas' },
  ],
  async run(ctx) {
    const c = ctx.check.config;
    const { host, port } = dbTarget(ctx, 6379);
    const r = new Redis({ host, port, username: c.username || undefined, password: ctx.secret?.value, tls: c.tls ? { rejectUnauthorized: false } : undefined,
      connectTimeout: ctx.check.timeout_ms, commandTimeout: ctx.check.timeout_ms, lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null, enableOfflineQueue: false });
    r.on('error', () => {});
    try {
      await r.connect();
      const t1 = performance.now();
      await r.ping();
      const pingMs = performance.now() - t1;
      const info = await r.info();
      const kv: Record<string, string> = {};
      for (const line of info.split('\r\n')) { const i = line.indexOf(':'); if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1); }
      let maxclients: number | null = null;
      try { const cfg = (await r.config('GET', 'maxclients')) as string[]; maxclients = Number(cfg[1]); } catch { /* CONFIG disabled */ }
      const used = Number(kv.used_memory);
      const maxmem = Number(kv.maxmemory || 0);
      const lastSave = Number(kv.rdb_last_save_time || 0);
      const metrics = compact({
        ping_ms: m(pingMs, 'ms'), connected_clients: m(Number(kv.connected_clients), 'count'), clients_percent: m(maxclients ? (Number(kv.connected_clients) / maxclients) * 100 : null, 'percent'),
        used_memory_bytes: m(used, 'bytes'), memory_percent: m(maxmem > 0 ? (used / maxmem) * 100 : null, 'percent'),
        last_save_age_s: m(lastSave ? Date.now() / 1000 - lastSave : null, 's'), connected_replicas: m(Number(kv.connected_slaves ?? 0), 'count'),
      });
      const unavailable: Record<string, string> = {};
      if (!maxmem) unavailable.memory_percent = 'maxmemory nicht gesetzt (unbegrenzt)';
      if (!maxclients) unavailable.clients_percent = 'CONFIG GET nicht erlaubt';
      if (kv.role === 'slave' && kv.master_link_status !== 'up') return { status: 'critical', message: `Replika: Verbindung zum Master ${kv.master_link_status}`, metrics, unavailable };
      if (kv.rdb_last_bgsave_status && kv.rdb_last_bgsave_status !== 'ok') return { status: 'warning', message: `Letzte RDB-Persistierung fehlgeschlagen (${kv.rdb_last_bgsave_status})`, metrics, unavailable };
      return { status: 'ok', message: `Redis ${kv.redis_version} (${kv.role}), ${kv.connected_clients} Clients, ${kv.used_memory_human}`, metrics, unavailable };
    } catch (e) {
      return { status: 'critical', message: `Redis ${host}:${port}: ${(e as Error).message}` };
    } finally {
      r.disconnect();
    }
  },
};

import { q, q1, tx } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/log.js';

const log = logger('bootstrap');

/**
 * First-start defaults. Safe by design: only the host Hermes runs on and Hermes' own compose
 * services are taken over automatically; everything else that is discovered waits in the inbox.
 */
export async function bootstrap() {
  const done = await q1(`SELECT value FROM settings WHERE key = 'bootstrap_v1'`);
  if (done) return;
  await tx(async (c) => {
    const [docker] = await q(`INSERT INTO discovery_sources(name, type, config, interval_s, orphan_after_s, system) VALUES
      ('Lokaler Docker-Host', 'docker', $1, 60, 86400, true) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [{ endpoint: `unix://${config.dockerSocket}`, include_stopped: true }], c);
    const [host] = await q(`INSERT INTO discovery_sources(name, type, config, interval_s, orphan_after_s, system) VALUES
      ('Lokaler Linux-Host', 'host', $1, 300, 86400, true) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [{ systemd: true }], c);
    await q(`INSERT INTO discovery_sources(name, type, config, enabled, interval_s, orphan_after_s) VALUES
      ('Heimnetz-Scan', 'network', $1, false, 3600, 172800) ON CONFLICT (name) DO NOTHING`, [{ cidrs: [], exclude: [], ports: [], timeout_ms: 400 }], c);
    await q(`INSERT INTO discovery_rules(name, priority, match, action, enable_monitoring, set, system) VALUES
      ('Container mit Label hermes.ignore=true ignorieren', 5, $1, 'ignore', false, '{}', true),
      ('Hermes-Plattform selbst überwachen', 10, $2, 'auto_accept', true, $3, true),
      ('Lokalen Host übernehmen', 20, $4, 'auto_accept', true, $5, true)`,
      [{ labels: { 'hermes.ignore': 'true' } },
        { kinds: ['container'], compose_project: config.composeProject },
        { group_name: 'Hermes', criticality: 'high', tags: ['hermes', 'self-monitoring'] },
        { kinds: ['host'], source_ids: [docker.id, host.id] },
        { criticality: 'critical', group_name: 'Infrastruktur' }], c);
    await q(`INSERT INTO settings(key, value) VALUES ('bootstrap_v1', $1)`, [{ at: new Date().toISOString() }], c);
  });
  log.info('created default discovery sources and rules');
}

process.env.HERMES_COMPONENT ??= 'hermes-worker';
import { logger, errMsg } from '../lib/log.js';
import { waitForDb } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { startHeartbeat } from '../lib/heartbeat.js';
import { loops, loopStats } from './loops.js';
import { bootstrap } from './bootstrap.js';

const log = logger('worker');

async function main() {
  await waitForDb((m) => log.warn(m));
  await migrate();
  await bootstrap();
  startHeartbeat('worker', () => loopStats());
  for (const l of loops) runLoop(l.name, l.everyMs, l.fn);
  log.info('worker started', { loops: loops.map((l) => l.name) });
}

/** Runs fn every everyMs without overlap; errors are logged and the loop keeps going. */
function runLoop(name: string, everyMs: number, fn: () => Promise<void>) {
  const tick = async () => {
    const t0 = Date.now();
    try {
      await fn();
    } catch (e) {
      log.error(`loop ${name} failed`, { err: errMsg(e) });
    }
    setTimeout(tick, Math.max(0, everyMs - (Date.now() - t0)));
  };
  setTimeout(tick, 500);
}

process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: errMsg(e) }));
main().catch((e) => {
  log.error('fatal', { err: errMsg(e) });
  process.exit(1);
});

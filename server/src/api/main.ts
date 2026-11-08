process.env.HERMES_COMPONENT ??= 'hermes-api';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { config } from '../lib/config.js';
import { logger } from '../lib/log.js';
import { waitForDb, pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { bootstrapAdmin, HttpError, registerAuth } from './auth.js';
import { registerLive, startLiveRelay, liveClientCount } from './live.js';
import { startHeartbeat } from '../lib/heartbeat.js';
import { routeModules } from './routes/index.js';
import { setDefaultChecksHook } from '../discovery/accept.js';
import { defaultChecksHook } from '../checks/defaults.js';

const log = logger('api');

async function main() {
  await waitForDb((m) => log.warn(m));
  await migrate();
  await bootstrapAdmin();
  setDefaultChecksHook(defaultChecksHook);

  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: err.message });
    if (err.validation || err.statusCode === 400) return reply.code(400).send({ error: err.message });
    if (err.code === '23505') return reply.code(409).send({ error: 'Eintrag existiert bereits (Eindeutigkeit verletzt)' });
    if (err.code === '22P02') return reply.code(400).send({ error: 'Ungültige ID' });
    log.error('request failed', { url: req.url, err: err.message, stack: err.stack });
    return reply.code(500).send({ error: 'Interner Fehler: ' + err.message });
  });

  registerAuth(app);
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true, component: 'api', time: new Date().toISOString() };
  });
  registerLive(app);
  for (const mod of routeModules) await app.register(mod);

  const webDir = config.webDir ? resolve(config.webDir) : '';
  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Nicht gefunden' });
      return reply.sendFile('index.html');
    });
    log.info(`serving web UI from ${webDir}`);
  }

  await startLiveRelay();
  startHeartbeat('api', () => ({ sse_clients: liveClientCount() }));
  await app.listen({ port: config.port, host: config.host });
  log.info(`listening on ${config.host}:${config.port}`);
}

main().catch((e) => {
  log.error('fatal', { err: e.message, stack: e.stack });
  process.exit(1);
});

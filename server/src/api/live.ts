import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { config } from '../lib/config.js';
import { logger } from '../lib/log.js';

const log = logger('live');
type Client = { write: (s: string) => void };
const clients = new Set<Client>();

/** One LISTEN connection; fan-out to all SSE subscribers. */
export async function startLiveRelay() {
  const connect = async () => {
    const c = new pg.Client({ connectionString: config.databaseUrl, application_name: 'hermes-api-listen' });
    c.on('error', (e) => { log.warn('listen connection error', { err: e.message }); setTimeout(connect, 3000); });
    c.on('notification', (n) => {
      const data = `event: update\ndata: ${n.payload}\n\n`;
      for (const cl of clients) cl.write(data);
    });
    try {
      await c.connect();
      await c.query('LISTEN hermes_live');
      log.info('listening for live updates');
    } catch (e) {
      log.warn('listen connect failed', { err: (e as Error).message });
      setTimeout(connect, 3000);
    }
  };
  await connect();
}

export function registerLive(app: FastifyInstance) {
  app.get('/api/live', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: {"user":"${req.user?.username ?? ''}"}\n\n`);
    const client: Client = { write: (s) => res.write(s) };
    clients.add(client);
    const ping = setInterval(() => res.write(`: ping\n\n`), 20000);
    req.raw.on('close', () => { clearInterval(ping); clients.delete(client); });
  });
}

export function liveClientCount() { return clients.size; }

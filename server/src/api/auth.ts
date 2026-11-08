import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import bcrypt from 'bcryptjs';
import { q, q1 } from '../db/pool.js';
import { config } from '../lib/config.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { logger } from '../lib/log.js';

export const SESSION_COOKIE = 'hermes_session';
export type Role = 'admin' | 'operator' | 'viewer';
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export interface AuthUser { id: string; username: string; display_name: string | null; role: Role }

declare module 'fastify' {
  interface FastifyRequest { user?: AuthUser }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function requireRole(req: FastifyRequest, role: Role) {
  if (!req.user) throw new HttpError(401, 'Nicht angemeldet');
  if (RANK[req.user.role] < RANK[role]) throw new HttpError(403, `Rolle "${role}" erforderlich`);
}

export async function hashPassword(pw: string) {
  return bcrypt.hash(pw, 12);
}

export async function createSession(userId: string, req: FastifyRequest) {
  const token = randomToken();
  const expires = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  await q(`INSERT INTO user_sessions(token_hash, user_id, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5)`, [
    sha256(token), userId, expires, req.headers['user-agent'] ?? null, req.ip,
  ]);
  return { token, expires };
}

export async function verifyPassword(username: string, password: string) {
  const u = await q1<{ id: string; password_hash: string; disabled: boolean }>(`SELECT id, password_hash, disabled FROM users WHERE lower(username) = lower($1)`, [username]);
  // constant-ish time even for unknown users
  const hash = u?.password_hash ?? '$2a$12$C6UzMDM.H6dfI/f/IKcEeO7Y4D0p5aG5o5o8KkqvJqk6h6S9Rj9mW';
  const ok = await bcrypt.compare(password, hash);
  if (!u || !ok || u.disabled) return null;
  return u.id;
}

/** Resolve the session cookie on every /api request (except public routes). */
export function registerAuth(app: FastifyInstance) {
  const PUBLIC = [/^\/api\/auth\/login$/, /^\/api\/health$/, /^\/api\/push\//];
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const row = await q1<AuthUser & { expires_at: Date }>(
        `SELECT u.id, u.username, u.display_name, u.role, s.expires_at FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`, [sha256(token)]);
      if (row) {
        req.user = { id: row.id, username: row.username, display_name: row.display_name, role: row.role };
        // sliding last-seen; cheap update
        q(`UPDATE user_sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '1 minute'`, [sha256(token)]).catch(() => {});
      }
    }
    if (PUBLIC.some((r) => r.test(url))) return;
    if (!req.user) {
      reply.code(401).send({ error: 'Nicht angemeldet' });
      return reply;
    }
    // viewers are read-only
    if (req.method !== 'GET' && req.user.role === 'viewer' && !url.startsWith('/api/auth/')) {
      reply.code(403).send({ error: 'Nur Lesezugriff (Rolle viewer)' });
      return reply;
    }
  });
}

export async function audit(req: FastifyRequest, action: string, target?: string, details: Record<string, unknown> = {}) {
  await q(`INSERT INTO audit_log(user_id, username, action, target, details) VALUES ($1,$2,$3,$4,$5)`, [
    req.user?.id ?? null, req.user?.username ?? null, action, target ?? null, details,
  ]).catch(() => {});
}

export async function bootstrapAdmin() {
  const log = logger('auth');
  const existing = await q1<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
  if (existing && existing.n > 0) return;
  if (!config.adminPassword || config.adminPassword.length < 8) {
    log.error('No users exist and HERMES_ADMIN_PASSWORD is unset or shorter than 8 characters; cannot create the initial admin.');
    return;
  }
  await q(`INSERT INTO users(username, display_name, password_hash, role) VALUES ($1,$2,$3,'admin')`, [
    config.adminUser, 'Administrator', await hashPassword(config.adminPassword),
  ]);
  log.info(`created initial admin user "${config.adminUser}"`);
}

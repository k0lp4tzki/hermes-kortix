import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q } from '../../db/pool.js';
import { config } from '../../lib/config.js';
import { sha256 } from '../../lib/crypto.js';
import { audit, createSession, hashPassword, HttpError, SESSION_COOKIE, verifyPassword } from '../auth.js';
import { parse } from '../util.js';

const attempts = new Map<string, { n: number; until: number }>();

export default async function authRoutes(app: FastifyInstance) {
  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) }), req.body);
    const key = `${req.ip}:${body.username.toLowerCase()}`;
    const a = attempts.get(key);
    if (a && a.n >= 5 && a.until > Date.now()) throw new HttpError(429, 'Zu viele Fehlversuche, bitte später erneut versuchen');
    const userId = await verifyPassword(body.username, body.password);
    if (!userId) {
      const n = (a && a.until > Date.now() ? a.n : 0) + 1;
      attempts.set(key, { n, until: Date.now() + 5 * 60_000 });
      await audit(req, 'auth.login_failed', body.username);
      throw new HttpError(401, 'Benutzername oder Passwort falsch');
    }
    attempts.delete(key);
    const { token, expires } = await createSession(userId, req);
    await q(`UPDATE users SET last_login_at = now() WHERE id = $1`, [userId]);
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires });
    const [user] = await q(`SELECT id, username, display_name, role FROM users WHERE id = $1`, [userId]);
    req.user = user;
    await audit(req, 'auth.login', user.username);
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await q(`DELETE FROM user_sessions WHERE token_hash = $1`, [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));

  app.post('/api/auth/password', async (req) => {
    const body = parse(z.object({ current: z.string(), next: z.string().min(8).max(200) }), req.body);
    const ok = await verifyPassword(req.user!.username, body.current);
    if (!ok) throw new HttpError(400, 'Aktuelles Passwort ist falsch');
    await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.user!.id, await hashPassword(body.next)]);
    await audit(req, 'user.password_changed', req.user!.username);
    return { ok: true };
  });
}

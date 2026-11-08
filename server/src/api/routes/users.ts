import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, q1 } from '../../db/pool.js';
import { audit, hashPassword, HttpError, requireRole } from '../auth.js';
import { notFound, parse } from '../util.js';

const role = z.enum(['admin', 'operator', 'viewer']);

export default async function userRoutes(app: FastifyInstance) {
  app.get('/api/users', async (req) => {
    requireRole(req, 'admin');
    return q(`SELECT id, username, display_name, role, disabled, created_at, last_login_at FROM users ORDER BY username`);
  });

  app.post('/api/users', async (req) => {
    requireRole(req, 'admin');
    const b = parse(z.object({ username: z.string().min(2).max(64).regex(/^[a-zA-Z0-9._-]+$/), display_name: z.string().max(100).optional(), password: z.string().min(8).max(200), role }), req.body);
    const exists = await q1(`SELECT 1 FROM users WHERE lower(username) = lower($1)`, [b.username]);
    if (exists) throw new HttpError(409, 'Benutzername existiert bereits');
    const [u] = await q(`INSERT INTO users(username, display_name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, username, display_name, role, disabled, created_at`, [
      b.username, b.display_name ?? null, await hashPassword(b.password), b.role,
    ]);
    await audit(req, 'user.created', b.username, { role: b.role });
    return u;
  });

  app.patch('/api/users/:id', async (req) => {
    requireRole(req, 'admin');
    const { id } = req.params as { id: string };
    const b = parse(z.object({ display_name: z.string().max(100).nullable().optional(), role: role.optional(), disabled: z.boolean().optional(), password: z.string().min(8).max(200).optional() }), req.body);
    const u = await q1(`SELECT * FROM users WHERE id = $1`, [id]);
    if (!u) notFound('Benutzer');
    if (id === req.user!.id && (b.disabled || (b.role && b.role !== 'admin'))) throw new HttpError(400, 'Eigenes Konto kann nicht deaktiviert oder herabgestuft werden');
    await q(`UPDATE users SET display_name = COALESCE($2, display_name), role = COALESCE($3, role), disabled = COALESCE($4, disabled),
             password_hash = COALESCE($5, password_hash) WHERE id = $1`, [id, b.display_name ?? null, b.role ?? null, b.disabled ?? null, b.password ? await hashPassword(b.password) : null]);
    if (b.disabled || b.password) await q(`DELETE FROM user_sessions WHERE user_id = $1`, [id]);
    await audit(req, 'user.updated', u.username, { ...b, password: b.password ? '***' : undefined });
    return q1(`SELECT id, username, display_name, role, disabled, created_at, last_login_at FROM users WHERE id = $1`, [id]);
  });

  app.delete('/api/users/:id', async (req) => {
    requireRole(req, 'admin');
    const { id } = req.params as { id: string };
    if (id === req.user!.id) throw new HttpError(400, 'Eigenes Konto kann nicht gelöscht werden');
    const u = await q1(`DELETE FROM users WHERE id = $1 RETURNING username`, [id]);
    if (!u) notFound('Benutzer');
    await audit(req, 'user.deleted', u.username);
    return { ok: true };
  });

  app.get('/api/audit', async (req) => {
    requireRole(req, 'admin');
    return q(`SELECT * FROM audit_log ORDER BY time DESC LIMIT 200`);
  });
}

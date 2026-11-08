import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, q1 } from '../../db/pool.js';
import { seal } from '../../lib/crypto.js';
import { audit, HttpError, requireRole } from '../auth.js';
import { notFound, parse } from '../util.js';

const body = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/, 'nur Buchstaben, Ziffern, . _ -'),
  description: z.string().max(500).nullable().optional(),
  kind: z.enum(['generic', 'password', 'token', 'basic_auth', 'connection_string']).default('generic'),
  value: z.string().min(1).max(10000),
  expires_at: z.string().datetime().nullable().optional(),
});

/** Secrets are write-only through the API: plaintext is never returned. */
export default async function secretRoutes(app: FastifyInstance) {
  app.get('/api/secrets', async (req) => {
    requireRole(req, 'operator');
    return q(`SELECT s.id, s.name, s.description, s.kind, s.created_at, s.updated_at, s.expires_at,
      (SELECT count(*)::int FROM checks c WHERE c.secret_id = s.id) AS used_by_checks
      FROM secrets s ORDER BY s.name`).catch(() => q(`SELECT id, name, description, kind, created_at, updated_at, expires_at, 0 AS used_by_checks FROM secrets ORDER BY name`));
  });

  app.post('/api/secrets', async (req) => {
    requireRole(req, 'operator');
    const b = parse(body, req.body);
    if (await q1(`SELECT 1 FROM secrets WHERE name = $1`, [b.name])) throw new HttpError(409, 'Name existiert bereits');
    const s = seal(b.value);
    const [row] = await q(`INSERT INTO secrets(name, description, kind, ciphertext, iv, auth_tag, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, name, description, kind, created_at, updated_at, expires_at`, [b.name, b.description ?? null, b.kind, s.ciphertext, s.iv, s.authTag, b.expires_at ?? null]);
    await audit(req, 'secret.created', b.name);
    return row;
  });

  app.put('/api/secrets/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const b = parse(body.partial({ name: true, value: true }), req.body);
    const cur = await q1(`SELECT * FROM secrets WHERE id = $1`, [id]);
    if (!cur) notFound('Secret');
    if (b.value) {
      const s = seal(b.value);
      await q(`UPDATE secrets SET ciphertext=$2, iv=$3, auth_tag=$4, updated_at=now() WHERE id=$1`, [id, s.ciphertext, s.iv, s.authTag]);
    }
    await q(`UPDATE secrets SET description = COALESCE($2, description), kind = COALESCE($3, kind), expires_at = $4, updated_at = now() WHERE id = $1`,
      [id, b.description ?? null, b.kind ?? null, b.expires_at === undefined ? cur.expires_at : b.expires_at]);
    await audit(req, 'secret.updated', cur.name, { valueChanged: !!b.value });
    return q1(`SELECT id, name, description, kind, created_at, updated_at, expires_at FROM secrets WHERE id = $1`, [id]);
  });

  app.delete('/api/secrets/:id', async (req) => {
    requireRole(req, 'operator');
    const { id } = req.params as { id: string };
    const s = await q1(`DELETE FROM secrets WHERE id = $1 RETURNING name`, [id]);
    if (!s) notFound('Secret');
    await audit(req, 'secret.deleted', s.name);
    return { ok: true };
  });
}

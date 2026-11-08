import { createHmac } from 'node:crypto';
import { request } from 'undici';
import { q1 } from '../db/pool.js';
import { unseal } from '../lib/crypto.js';

export interface SendResult { ok: boolean; status: number | null; error: string | null; durationMs: number }

/**
 * Generic JSON webhook. Optional HMAC-SHA256 signature over the raw body in
 * `X-Hermes-Signature: sha256=<hex>` using a stored secret; custom headers allowed.
 * Up to 3 attempts with backoff on network errors and 5xx.
 */
export async function sendWebhook(channel: { config: Record<string, any> }, payload: unknown): Promise<SendResult> {
  const c = channel.config;
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Hermes-Monitoring/1.0' };
  for (const [k, v] of Object.entries<string>(c.headers ?? {})) headers[k.toLowerCase()] = String(v);
  if (c.hmac_secret_id) {
    const s = await q1(`SELECT ciphertext, iv, auth_tag FROM secrets WHERE id = $1`, [c.hmac_secret_id]);
    if (s) headers['x-hermes-signature'] = 'sha256=' + createHmac('sha256', unseal({ ciphertext: s.ciphertext, iv: s.iv, authTag: s.auth_tag })).update(body).digest('hex');
  }
  if (c.auth_secret_id) {
    const s = await q1(`SELECT ciphertext, iv, auth_tag FROM secrets WHERE id = $1`, [c.auth_secret_id]);
    if (s) headers.authorization = `Bearer ${unseal({ ciphertext: s.ciphertext, iv: s.iv, authTag: s.auth_tag })}`;
  }
  const t0 = performance.now();
  let last: SendResult = { ok: false, status: null, error: 'nicht gesendet', durationMs: 0 };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 2000));
    try {
      const res = await request(c.url, { method: c.method === 'PUT' ? 'PUT' : 'POST', headers, body, headersTimeout: Number(c.timeout_ms ?? 10000), bodyTimeout: Number(c.timeout_ms ?? 10000) });
      const text = await res.body.text();
      last = { ok: res.statusCode < 300, status: res.statusCode, error: res.statusCode < 300 ? null : `HTTP ${res.statusCode}: ${text.slice(0, 200)}`, durationMs: performance.now() - t0 };
      if (res.statusCode < 500) break;
    } catch (e) {
      const err = e as any;
      last = { ok: false, status: null, error: `${err.cause?.code ?? err.code ?? ''} ${err.cause?.message ?? err.message}`.trim(), durationMs: performance.now() - t0 };
    }
  }
  return last;
}

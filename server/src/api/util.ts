import type { z } from 'zod';
import { HttpError } from './auth.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    throw new HttpError(400, msg);
  }
  return r.data;
}

export function notFound(what = 'Objekt'): never {
  throw new HttpError(404, `${what} nicht gefunden`);
}

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { encryptionKey } from './config.js';

export interface Sealed { ciphertext: Buffer; iv: Buffer; authTag: Buffer }

export function seal(plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function unseal(s: Sealed): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), s.iv);
  decipher.setAuthTag(s.authTag);
  return Buffer.concat([decipher.update(s.ciphertext), decipher.final()]).toString('utf8');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

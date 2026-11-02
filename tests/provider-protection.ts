import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretProtection } from '../apps/desktop/src/provider-vault.js';
export function protection(): SecretProtection {
  const key = randomBytes(32);
  return {
    available: async () => true,
    encrypt: async (text) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), body]);
    },
    decrypt: async (value) => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return {
        result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(),
        shouldReEncrypt: false,
      };
    },
  };
}

/**
 * Mã hoá field cấp ứng dụng — AES-256-GCM bằng FIELD_KEY (arch §7.2, §11).
 * Dùng cho totp_secret; không dùng cho số dư (Atlas/R2 đã mã hoá at-rest).
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from '../env.ts';

const ALGO = 'aes-256-gcm';

export function encryptField(plain: string, keyHex?: string): string {
  const key = Buffer.from(keyHex ?? getEnv().FIELD_KEY, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // base64url(iv).tag.ciphertext — tự phân tách, không cần schema
  return [iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

export function decryptField(payload: string | null | undefined, keyHex?: string): string | null {
  if (!payload) return null;
  const parts = payload.split('.');
  if (parts.length !== 3) return null;
  const [iv, tag, data] = parts as [string, string, string];
  try {
    const key = Buffer.from(keyHex ?? getEnv().FIELD_KEY, 'hex');
    const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // key đổi / dữ liệu bị sửa → coi như chưa có secret, không làm sập request
    return null;
  }
}

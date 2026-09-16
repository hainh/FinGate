/**
 * Mật khẩu bằng `node:crypto.scrypt` (K-17: không native dependency → build Render không risk).
 * So sánh luôn dùng timingSafeEqual.
 */

import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number, options: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const KEYLEN = 64;
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 } as const;
// N=2^15 · r=8 cần đúng 32MB → Node đòi maxmem LỚN HƠN mức đó, nên khai báo rõ.
// arch §7.2 giữ nguyên độ khó (N,r,p); maxmem chỉ là trần cho phép.

export interface PasswordHash {
  kdf: 'scrypt';
  hash: string;
  salt: string;
}

export async function hashPassword(plain: string): Promise<PasswordHash> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(normalize(plain), salt, KEYLEN, PARAMS);
  return { kdf: 'scrypt', hash: derived.toString('hex'), salt };
}

export async function verifyPassword(
  plain: string,
  stored: { kdf?: string; hash?: string | null; salt?: string | null } | null | undefined,
): Promise<boolean> {
  if (!stored?.hash || !stored?.salt) return false;
  const expected = Buffer.from(stored.hash, 'hex');
  if (expected.length !== KEYLEN) return false;
  const derived = await scrypt(normalize(plain), stored.salt, KEYLEN, PARAMS);
  return timingSafeEqual(derived, expected);
}

/** NFC + giới hạn độ dài để chống DoS qua chuỗi dài. */
function normalize(plain: string): string {
  return plain.normalize('NFC').slice(0, 200);
}

/** Token ngẫu nhiên cho session/invite/reset — trả { raw, hash }. */
export function randomToken(bytes = 32): { raw: string; hash: string } {
  const raw = randomBytes(bytes).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw: string): string {
  const secret = process.env.SESSION_SECRET ?? 'fingate-static-pepper';
  return createHmac('sha256', secret).update(raw).digest('hex');
}

/** OTP/recovery code so sánh không lộ thời gian. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 10 recovery codes một lần dùng (arch §7.2). */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

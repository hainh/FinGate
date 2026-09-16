/**
 * TOTP RFC 6238 bằng `node:crypto` — không thêm dependency.
 *
 * README ghi rõ: kiến trúc chốt `otp@13.5.0` nhưng npm chỉ có tới `2.0.1`.
 * Thay bằng tự implement ~40 dòng: không native dep (an toàn build Render — K-17),
 * không bị động khi package dừng protect, và có unit test chính tả (test/totp.test.ts).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@fingate/shared';

export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 encode (không padding) — đúng chuẩn otpauth:// các app Authenticator dùng. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secret mới 20 byte = 160 bit (RFC 4226). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpCode(secretB32: string, at: Date = new Date(), step = TOTP_PERIOD, digits = TOTP_DIGITS): string {
  const counter = Math.floor(at.getTime() / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const bin = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** Cho phép lệch ±window bước (mặc định 1 = ±30s) — đồng hồ điện thoại không bao giờ đúng tuyệt đối. */
export function verifyTotp(
  code: string,
  secretB32: string,
  opts: { at?: Date; window?: number; step?: number; digits?: number; /** đã dùng rồi thì không cho dùng lại */ consume?: (used: string) => boolean } = {},
): boolean {
  const step = opts.step ?? TOTP_PERIOD;
  const digits = opts.digits ?? TOTP_DIGITS;
  const at = opts.at ?? new Date();
  const window = opts.window ?? 1;
  if (!/^\d{6}$/.test(code.trim())) return false;
  for (let i = -window; i <= window; i++) {
    const candidate = totpCode(secretB32, new Date(at.getTime() + i * step * 1000), step, digits);
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(code.trim().padEnd(candidate.length, '\0').slice(0, candidate.length)))) {
      return true;
    }
  }
  return false;
}

export function otpauthUrl(input: { secret: string; account: string; issuer?: string }): string {
  const issuer = encodeURIComponent(input.issuer ?? 'FinGate');
  const account = encodeURIComponent(input.account);
  return `otpauth://totp/${issuer}:${account}?secret=${input.secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
}

/** Vứt lỗi step-up — dùng chung cho các hành động nhạy cảm (ADR-14). */
export function requireTotp(code: string | undefined, secretB32: string | null | undefined): void {
  if (!secretB32) throw new ApiError({ code: 'FG-AUTH-008', detail: 'Tài khoản chưa bật 2FA' });
  if (!code || !verifyTotp(code, secretB32)) throw new ApiError({ code: 'FG-AUTH-006' });
}

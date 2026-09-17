/**
 * Liên kết kích hoạt do Quản trị tự copy gửi (không cần SMTP).
 *
 * Token tự chứa + CÓ CHỮ KÝ (HMAC-SHA256 bằng SESSION_SECRET):
 *   <base64url(user.seed.exp)>.<base64url(hmac)>
 * - Chữ ký không thể đoán/sửa → server không cần tra theo token, chỉ cần đúng user.
 * - `exp` nằm trong payload đã ký → đổi hạn mức phải ký lại (= regenerate).
 * - Thu hồi tức thì: DB lưu `invite.seed`; mỗi lần activate server so seed,
 *   regenerate đổi seed làm MỌI link cũ chết ngay, revoke xoá seed là link chết.
 * - Seed lưu thuận (invite.seed) để endpoint GET trả lại đúng link cho admin copy.
 *
 * `invite.mode` phân biệt mục đích link (cùng chung cơ chế ký):
 * - `activate` (mặc định) — tài khoản `invited`, mở link để đặt mật khẩu lần đầu + kích hoạt.
 * - `reset` — tài khoản đã `active`; quản trị nhân sự cấp lại link để người dùng
 *   đặt mật khẩu mới. Dùng xong seed bị xoá như link kích hoạt.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiError } from '@fingate/shared';
import { getEnv } from '../env.ts';

/** Hạn mặc định của link mời: 1 ngày (§ yêu cầu "link có chữ ký có thời hạn 1 ngày"). */
export const DEFAULT_INVITE_DAYS = 1;

/** Đường dẫn SPA nhận token — route/kích-hoat. */
export const ACTIVATE_PATH = '/kich-hoat';

export interface InviteTokenPayload {
  user_id: string;
  seed: string;
  /** epoch ms */
  exp: number;
}

function key(): Buffer {
  return Buffer.from(getEnv().SESSION_SECRET, 'utf8');
}

function sign(data: string): string {
  return createHmac('sha256', key()).update(data).digest('base64url');
}

function b64urlJson(v: unknown): string {
  return Buffer.from(JSON.stringify(v), 'utf8').toString('base64url');
}

/** Ký payload → token đưa vào link. */
export function signInviteToken(p: InviteTokenPayload): string {
  const body = b64urlJson(p);
  return `${body}.${sign(body)}`;
}

/**
 * Kiểm chữ ký + hạn. Không tung hoạn thông tin: token lạ/sửa/hết hạn → cùng một lỗi.
 * Trả payload khi chữ ký hợp lệ (vẫn phải đối chiếu seed trong DB ở bước sau).
 */
export function verifyInviteToken(token: string): InviteTokenPayload {
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) throw new ApiError({ code: 'FG-AUTH-009' });
  const body = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError({ code: 'FG-AUTH-009' });
  let payload: InviteTokenPayload | undefined;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as InviteTokenPayload;
  } catch {
    throw new ApiError({ code: 'FG-AUTH-009' });
  }
  if (!payload?.user_id || !payload?.seed || !Number.isFinite(payload?.exp)) throw new ApiError({ code: 'FG-AUTH-009' });
  if (payload.exp < Date.now()) throw new ApiError({ code: 'FG-AUTH-009' });
  return payload;
}

/** Seed ngẫu nhiên (base64url, 128 bit) — đưa vào payload đã ký. */
export function newInviteSeed(): string {
  return randomBytes(16).toString('base64url');
}

export function inviteExpiresAt(days: number = DEFAULT_INVITE_DAYS): Date {
  return new Date(Date.now() + Math.max(1, Math.floor(days)) * 86_400_000);
}

/** URL tuyệt đối để admin copy (PUBLIC_URL là nguồn duy nhất — arch §16). */
export function inviteUrl(token: string): { url: string; path: string } {
  const path = `${ACTIVATE_PATH}?token=${encodeURIComponent(token)}`;
  const base = getEnv().PUBLIC_URL.replace(/\/$/, '');
  return { url: `${base}${path}`, path };
}

/** Ghép lại token từ bản ghi invite trong DB. */
export function inviteTokenFor(input: { user_id: string; seed: string; expires_at: Date }): string {
  return signInviteToken({ user_id: input.user_id, seed: input.seed, exp: input.expires_at.getTime() });
}

/**
 * So seed đã gửi với seed trong DB, không lộ thời gian.
 * Seed đã đổi/xoá (regenerate/revoke/kích hoạt xong) → false.
 */
export function seedMatches(storedSeed: string | null | undefined, given: string): boolean {
  if (!storedSeed) return false;
  const a = Buffer.from(storedSeed);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Mục đích link: kích hoạt lần đầu hay đặt lại mật khẩu cho tài khoản đã hoạt động. */
export type InviteMode = 'activate' | 'reset';

/** dáng `user.invite` đọc từ DB (lean) — đủ cho tính trạng thái link. */
export interface InviteShape {
  seed?: string | null;
  expires_at?: Date | null;
  revoked_at?: Date | null;
  sent_at?: Date | null;
  send_count?: number;
  regenerate_count?: number;
  /** 'activate' | 'reset'; undefined = activate (tương thích bản ghi cũ). */
  mode?: string | null;
  company_id?: unknown;
  role?: string | null;
  department_id?: unknown;
  invited_by?: unknown;
}

export type InviteLinkStatus = 'active' | 'expired' | 'revoked' | 'used' | 'none';

/**
 * Trạng thái link của một user (status tài khoản + seed + hạn + revoke).
 * - Tài khoản `active` KHÔNG còn seed ⇒ 'used' (link kích hoạt đã tiêu thụ).
 * - Tài khoản `active` còn seed ⇒ link `reset` do quản trị cấp → 'active'/'expired'/'revoked'.
 * - Tài khoản `deactivated`: link còn seed cũng không dùng được → 'revoked'.
 */
export function inviteLinkStatus(userStatus: string, inv: InviteShape | undefined, now = new Date()): InviteLinkStatus {
  if (userStatus === 'deactivated') return inv?.seed ? 'revoked' : 'none';
  if (inv?.revoked_at) return 'revoked';
  if (!inv?.seed) return userStatus === 'active' ? 'used' : 'none';
  if (!inv.expires_at || new Date(inv.expires_at) <= now) return 'expired';
  return 'active';
}

/**
 * Ký lại link hiện hành từ bản ghi invite (HMAC tất định → đúng link đã gửi).
 * null khi không còn link (chưa cấp / đã dùng — seed bị xoá lúc activate).
 */
export function currentInviteLink(userId: string, inv: InviteShape | undefined): { url: string; expires_at: string } | null {
  if (!inv?.seed || !inv.expires_at) return null;
  const token = inviteTokenFor({ user_id: userId, seed: inv.seed, expires_at: new Date(inv.expires_at) });
  return { url: inviteUrl(token).url, expires_at: new Date(inv.expires_at).toISOString() };
}

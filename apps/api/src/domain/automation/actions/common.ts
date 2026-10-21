/**
 * Tiện ích dùng chung cho các BƯỚC tự động (v2/v2.md §14.3): người thực hiện, ép kiểu tiền, ID.
 *
 * Người thực hiện của bước = NGƯỜI KÍCH HOẠT SỰ KIỆN (VD người duyệt cuối / người thực thi phiếu chi);
 * sự kiện do hệ thống phát (lịch) thì người thực hiện là `null`. Đây là đường đi chuẩn của nghiệp vụ —
 * bước gọi đúng các hàm nghiệp vụ, không ghi DB tắt.
 */

import type { ActorInfo } from '../../types.ts';
import type { AutomationEventView } from '../engine.ts';

/** Tên hiển thị khi hành động do hệ thống thực hiện. */
export const SYSTEM_ACTOR_NAME = 'Hệ thống tự động';

/** Người thực hiện (ghi vào lịch sử / audit): người kích hoạt sự kiện hoặc null (hệ thống). */
export interface AutoActor {
  user_id: string | null;
  name: string | null;
  role: string | null;
}

/** `session_id` đánh dấu phiên của bộ máy tự động (được miễn step-up khi thực thi phiếu). */
export const AUTOMATION_SESSION_ID = 'automation';

/** Người kích hoạt sự kiện (ai duyệt / ai thực thi); null nếu sự kiện do hệ thống phát. */
export function actorOfEvent(ev: AutomationEventView): AutoActor {
  return {
    user_id: ev.actor.user_id,
    name: ev.actor.name ?? SYSTEM_ACTOR_NAME,
    role: ev.actor.role,
  };
}

/**
 * Hồ sơ người thực hiện cho `transition()` (chỉ quyền cần cho hành động tự động, VD `payment:mark`).
 * `user_id` có thể là null — hành động của hệ thống; ghi nhận null là hợp lệ.
 */
export function automationActor(actor: AutoActor, permissions: readonly string[]): ActorInfo {
  return {
    user_id: actor.user_id as unknown as string,
    name: actor.name ?? SYSTEM_ACTOR_NAME,
    email: '',
    role: actor.role as ActorInfo['role'],
    role_label: '',
    company_id: null,
    department_id: null,
    amount_limit_minor: 0n,
    scope_all: true,
    permissions: [...permissions],
    totp_enabled: false,
    session_id: AUTOMATION_SESSION_ID,
  };
}

/** Ép giá trị từ DB / payload (BigInt, số, chuỗi) về BigInt; null/rỗng ⇒ 0. */
export function big(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') return 0n;
  return BigInt(String(value));
}

/** ID dạng chuỗi hoặc null. */
export function idOf(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

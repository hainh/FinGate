/**
 * Gõ lại số tiền để xác nhận (v2 §6.3, §7.2; DS §7.14 rule 4) — hàm thuần, không gọi mạng.
 *
 * Quy tắc: `confirm_amount_minor` CHỈ được gửi khi người duyệt đã gõ lại đúng số tiền cần xác nhận.
 * Không echo số tiền tự động: server chỉ đối chiếu confirm với số hiệu lực nên echo sẽ qua mặt bước gõ lại.
 */
import { cmp, parseMoneyInput, type Money } from '@fingate/shared';

export type RetypeCheck = { ok: true; minor: string } | { ok: false; error: string };

/** So số người duyệt gõ với số tiền cần xác nhận. Chỉ `ok: true` mới được gửi `confirm_amount_minor`. */
export function checkRetypedAmount(typed: string, expected: Money): RetypeCheck {
  if (!typed.trim()) return { ok: false, error: 'Nhập lại số tiền để xác nhận.' };
  let parsed: Money;
  try {
    parsed = parseMoneyInput(typed, expected.currency);
  } catch {
    return { ok: false, error: 'Định dạng số tiền không hợp lệ.' };
  }
  if (cmp(parsed, expected) !== 0)
    return { ok: false, error: 'Số tiền nhập lại KHÔNG khớp — đọc kỹ và nhập lại.' };
  return { ok: true, minor: parsed.minor.toString() };
}

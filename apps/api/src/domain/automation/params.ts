/**
 * Tham số cấu hình được của từng quy tắc tự động (v2/v2.md §11.7 US-AUTO-07: "chỉnh tham số mặc định
 * (kỳ hạn, lệch hạn thanh toán) theo công ty"). Thuần — không chạm DB.
 */

import { z } from 'zod';
import { ApiError } from '@fingate/shared';

/** Tham số của từng quy tắc: khoá ⇒ kiểu. Quy tắc không có tham số cấu hình: không khoá nào. */
export const RULE_PARAM_SCHEMAS: Record<string, Record<string, z.ZodType>> = {
  R2: {
    term_months: z.number().int().min(1).max(600),
    due_offset_months: z.number().int().min(0).max(36),
    r2_create_at: z.enum(['save', 'approve']),
  },
  R3: {
    term_months: z.number().int().min(1).max(600),
    due_offset_months: z.number().int().min(0).max(36),
  },
};

/**
 * Kiểm tra và chuẩn hoá tham số của một quy tắc. Khoá lạ hoặc giá trị sai ⇒ `FG-VAL-001` kèm lỗi từng khoá.
 * Trả về đúng các khoá đã hợp lệ.
 */
export function checkRuleParams(code: string, params: Record<string, unknown>): Record<string, unknown> {
  const spec = RULE_PARAM_SCHEMAS[code] ?? {};
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const schema = spec[key];
    if (!schema) {
      errors[key] = 'Tham số không áp dụng cho quy tắc này';
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) out[key] = parsed.data;
    else errors[key] = parsed.error.issues[0]?.message ?? 'Giá trị không hợp lệ';
  }
  if (Object.keys(errors).length) throw new ApiError({ code: 'FG-VAL-001', detail: 'Tham số quy tắc không hợp lệ', errors });
  return out;
}

/**
 * Bước CẢNH BÁO / THÔNG BÁO (v2/v2.md §11.5 ngoại lệ, §11.7 US-AUTO-06): ghi cảnh báo cho kế toán trưởng.
 * Chống lặp bằng `dedupe_key` (unique một phần trong `alerts`): chạy lại không tạo cảnh báo thứ hai.
 */

import { Models } from '../../../db/models.ts';

export interface AutomationAlertInput {
  companyId: string | null;
  alertType: string;
  text: string;
  /** 0 thông tin · 1 nhắc · 2 cảnh báo · 3 khẩn. */
  severity?: number;
  href?: string | null;
  toRoles?: string[];
  subject?: Record<string, unknown> | null;
  dedupeKey: string;
}

function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/** Ghi cảnh báo. Trả về false nếu đã có cảnh báo cùng `dedupe_key` (không lỗi). */
export async function raiseAutomationAlert(input: AutomationAlertInput): Promise<boolean> {
  try {
    await Models.Alert.create({
      type: 'event',
      alert_type: input.alertType,
      company_id: input.companyId,
      severity: input.severity ?? 2,
      text: input.text,
      to_roles: input.toRoles ?? ['chief_accountant'],
      href: input.href ?? null,
      subject: input.subject ?? null,
      channels: ['web'],
      dedupe_key: input.dedupeKey,
    } as never);
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

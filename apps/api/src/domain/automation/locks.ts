/**
 * Khoá số tiền phiếu chi sau khi quy trình vay để chi (R3) đã chạy (v2/v2.md §11.5 ngoại lệ).
 *
 * Khoản vay và phiếu thu giải ngân đã được sinh theo số tiền đã chốt; vì vậy sau khi R3 bắt đầu, phiếu chi
 * không còn đổi được số tiền (duyệt hay thực thi). Chỉ đọc `automation_runs` — không phụ thuộc workflow.
 */

import { Models } from '../../db/models.ts';

/** R3 đã chạy (lượt không còn "chờ") cho phiếu chi này ⇒ số tiền bị khoá. */
export async function amountLockedByAutomation(documentId: string): Promise<boolean> {
  const hit = await Models.AutomationRun.findOne({ rule_code: 'R3', source_id: documentId, status: { $ne: 'pending' } } as never)
    .select({ _id: 1 })
    .lean();
  return Boolean(hit);
}

/**
 * Kiểm tra tài khoản tiền hợp lệ cho phiếu — dùng chung giữa route tạo/sửa hồ sơ
 * và workflow duyệt (cấp duyệt được đổi tài khoản trong phạm vi công ty — §VIII).
 */

import { ApiError } from '@fingate/shared';
import { Models } from '../db/models.ts';

/**
 * Tài khoản nguồn/đích chỉ được chọn từ tài khoản của **công ty của phiếu** HOẶC
 * tài khoản Tập đoàn (`company_id` null, `is_group`). Chặn ở server, không tin UI.
 * Lỗi trả về key `source.account_id` để UI hiển thị inline đúng field.
 */
export async function assertAccountAllowedForCompany(companyId: string, accountId: string | null | undefined): Promise<void> {
  if (!accountId) return;
  const acct = await Models.BankAccount.findOne({ _id: accountId })
    .select({ company_id: 1, is_group: 1, status: 1 })
    .lean();
  if (!acct || acct.status !== 'active') {
    throw new ApiError({
      code: 'FG-VAL-001',
      errors: { 'source.account_id': 'Tài khoản không tồn tại hoặc đã đóng/phong tỏa' },
    });
  }
  const owner = acct.company_id ? String(acct.company_id) : null;
  if (!acct.is_group && owner !== companyId) {
    throw new ApiError({
      code: 'FG-RBAC-002',
      detail: 'Tài khoản không thuộc công ty của phiếu hoặc Tập đoàn',
    });
  }
}

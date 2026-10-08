/**
 * Kiểm tra tài khoản tiền hợp lệ cho phiếu — dùng chung giữa route tạo/sửa hồ sơ
 * và workflow duyệt (cấp duyệt được đổi tài khoản trong phạm vi công ty — §VIII).
 */

import { ApiError } from '@fingate/shared';
import { Models } from '../db/models.ts';

/** Id pháp nhân cấp Tập đoàn (`companies.is_group = true`) — null nếu chưa có. */
async function groupCompanyId(): Promise<string | null> {
  const c = await Models.Company.findOne({ is_group: true } as never).select({ _id: 1 }).lean();
  return c ? String((c as { _id: unknown })._id) : null;
}

/**
 * Tài khoản nguồn/đích chỉ được chọn từ tài khoản của **công ty của phiếu**.
 * Tài khoản Tập đoàn (`company_id` null, `is_group`) — gồm Quỹ tiền mặt Tập đoàn —
 * CHỈ dùng cho phiếu thuộc pháp nhân Tập đoàn; phiếu của công ty con không được
 * động vào quỹ/tài khoản Tập đoàn (sửa lỗi: công ty con từng chọn được nguồn này).
 * Chặn ở server, không tin UI (§VIII).
 * Lỗi trả về key theo `field` để UI hiển thị inline đúng field.
 */
export async function assertAccountAllowedForCompany(
  companyId: string,
  accountId: string | null | undefined,
  field = 'source.account_id',
): Promise<void> {
  if (!accountId) return;
  const acct = await Models.BankAccount.findOne({ _id: accountId })
    .select({ company_id: 1, is_group: 1, status: 1 })
    .lean();
  if (!acct || acct.status !== 'active') {
    throw new ApiError({
      code: 'FG-VAL-001',
      errors: { [field]: 'Tài khoản không tồn tại hoặc đã đóng/phong tỏa' },
    });
  }
  const owner = acct.company_id ? String(acct.company_id) : null;
  if (owner === companyId) return;
  if (acct.is_group) {
    const gid = await groupCompanyId();
    if (gid && companyId === gid) return;
    throw new ApiError({
      code: 'FG-RBAC-002',
      detail: 'Không dùng được quỹ/tài khoản Tập đoàn cho phiếu của công ty con',
      errors: { [field]: 'Tài khoản Tập đoàn — chỉ dùng cho phiếu cấp Tập đoàn' },
    });
  }
  throw new ApiError({
    code: 'FG-RBAC-002',
    detail: 'Tài khoản không thuộc công ty của phiếu',
    errors: { [field]: 'Tài khoản không thuộc công ty của phiếu' },
  });
}

/**
 * Trường "Tài khoản tập đoàn phụ trách" (§VIII, áp dụng khi `group_managed`):
 * chỉ nhận tài khoản Tập đoàn, và chỉ với phiếu thuộc pháp nhân Tập đoàn —
 * phiếu công ty con không được đi qua quỹ Tập đoàn kể cả qua trường này.
 */
export async function assertGroupAccountForCompany(
  companyId: string,
  accountId: string | null | undefined,
): Promise<void> {
  if (!accountId) return;
  const acct = await Models.BankAccount.findOne({ _id: accountId }).select({ is_group: 1 }).lean();
  if (!acct || !acct.is_group) {
    throw new ApiError({
      code: 'FG-VAL-001',
      errors: { 'source.group_account_id': 'Chỉ chọn được tài khoản Tập đoàn cho trường này' },
    });
  }
  await assertAccountAllowedForCompany(companyId, accountId, 'source.group_account_id');
}

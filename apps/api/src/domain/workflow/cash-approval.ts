/**
 * Cài đặt "Duyệt tiền mặt" — phiếu THU/CHI quỹ tiền mặt (`cash`) và Quỹ phụ (`fund`) có phải
 * đi qua Kế toán trưởng (KTT) duyệt hay không (ADM-04, tab "Duyệt tiền mặt").
 *
 * NGHIỆP VỤ: tiền mặt/ví quỹ nội bộ thường do chính kế toán viên nộp/rút, nên trước đây phiếu
 * quỹ tiền mặt được đặc cách hiện ngay trong "Chờ tôi duyệt" của MỌI cấp còn bước chưa duyệt.
 * Đặc cách đó bỏ: phiếu quỹ tiền mặt vào "Chờ tôi duyệt" đúng như phiếu thường (chỉ cấp thấp
 * nhất còn chờ). Thay vào đó là cài đặt theo CÔNG TY: bật → giữ nguyên quy trình như ma trận;
 * tắt (MẶC ĐỊNH) → bỏ bước KTT, phiếu đi thẳng tới cấp duyệt kế tiếp.
 *
 * VÌ SAO MẶC ĐỊNH TẮT: bật mặc định sẽ chặn nhầm mọi khoản tiền mặt ở bước KTT — trong khi phần
 * lớn công ty coi khoản tiền mặt nhỏ là việc của cấp duyệt trực tiếp. Công ty nào cần kiểm soát
 * chặt thì admin tự tick (một lần, ở màn quản trị), không phải cấu hình lại ma trận duyệt.
 *
 * Cài đặt là MỘT document Setting (key `CASH_APPROVAL_SETTING_KEY`), giá trị đa chiều:
 * `{ companies: { <company_id>: true } }` — chỉ công ty được tick mới có khoá `true`.
 */

import { CASH_APPROVAL_SETTING_KEY } from '@fingate/shared';
import { Models } from '../../db/models.ts';

/** Giá trị document Setting của cài đặt "Duyệt tiền mặt". */
export interface CashApprovalConfig {
  /** khoá = company_id; chỉ công ty BẬT mới có khoá `true` (thiếu khoá / false = tắt). */
  companies?: Record<string, boolean> | null;
}

/**
 * Công ty có bắt phiếu quỹ tiền mặt đi qua KTT duyệt không — hàm THUẦN, MẶC ĐỊNH `false`
 * (không có cấu hình, công ty không có khoá, hay khoá mang giá trị `false` đều là tắt).
 */
export function resolveCashRequiresKtt(config: CashApprovalConfig | null | undefined, companyId: string | null | undefined): boolean {
  if (!companyId) return false;
  return config?.companies?.[companyId] === true;
}

/** Đọc cài đặt cho MỘT công ty (dùng ở `resolveMatrix`). */
export async function cashRequiresKttFor(companyId: string | null | undefined): Promise<boolean> {
  if (!companyId) return false;
  const s = await Models.Setting.findOne({ key: CASH_APPROVAL_SETTING_KEY }).lean<{ value?: CashApprovalConfig } | null>();
  return resolveCashRequiresKtt(s?.value, companyId);
}

/**
 * Đọc cài đặt MỘT LẦN cho nhiều công ty (tầng đọc: lọc "Chờ tôi duyệt" theo phạm vi nhiều công ty).
 * Công ty không có trong map / không đọc được cài đặt = `false`.
 */
export async function cashRequiresKttForMany(companyIds: readonly string[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const ids = [...new Set(companyIds.map(String).filter(Boolean))];
  if (!ids.length) return out;
  const s = await Models.Setting.findOne({ key: CASH_APPROVAL_SETTING_KEY }).lean<{ value?: CashApprovalConfig } | null>();
  for (const id of ids) out.set(id, resolveCashRequiresKtt(s?.value, id));
  return out;
}

/**
 * Phiếu có thuộc nhóm "quỹ tiền mặt" không: chỉ phiếu THU (`income`) và phiếu CHI (`spend`),
 * với quỹ nguồn là tiền mặt (`cash`) hoặc Quỹ phụ (`fund`) — Quỹ phụ chứa tiền thật, hoạt động
 * giống quỹ tiền mặt nên đi chung nhóm này. Phiếu ngân hàng / đáo hạn / chuyển nội bộ: KHÔNG.
 */
export function isCashVoucher(input: { kind: string | null | undefined; fund: string | null | undefined }): boolean {
  if (input.kind !== 'spend' && input.kind !== 'income') return false;
  return input.fund === 'cash' || input.fund === 'fund';
}

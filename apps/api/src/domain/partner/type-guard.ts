/**
 * Chặn đổi LOẠI đối tác làm vỡ ràng buộc hiện có (v2/v2.md §5.1, FG-PARTNER-003).
 *
 * Ràng buộc theo loại (§5.1 bảng "Loại đối tác cho phép"):
 *  - Khoản nợ ngân hàng  → đối tác phải là Ngân hàng (đang có khoản nợ NH ⇒ không đổi khỏi Ngân hàng);
 *  - Khoản công nợ      → Khách hàng hoặc Nhà cung cấp (đang có công nợ ⇒ không đổi sang Ngân hàng);
 *  - Phiếu vay (options.loan.lender_partner_id) → Ngân hàng (là ngân hàng cho vay ⇒ phải giữ Ngân hàng);
 *  - Phiếu đã liên kết trả nợ / giải ngân (đầu nguồn phải là ngân hàng) ⇒ phải giữ Ngân hàng.
 * Phần thuần (`partnerTypeBlockers`) tách khỏi phần đếm DB (`loadPartnerTypeUsage`) để kiểm thử.
 */

import { ApiError, PARTNER_TYPE_LABEL, type PartnerType } from '@fingate/shared';
import { Models } from '../../db/models.ts';

/** Số lượng đối tượng đang phụ thuộc vào đối tác (đếm theo công ty của đối tác). */
export interface PartnerTypeUsage {
  /** khoản nợ ngân hàng gắn đối tác */
  bank_debts: number;
  /** khoản công nợ (KH/NCC) gắn đối tác */
  debt_vouchers: number;
  /** phiếu có `options.loan.lender_partner_id` = đối tác (ngân hàng cho vay) */
  lender_documents: number;
  /** phiếu của đối tác đang là đầu nguồn của liên kết trả nợ / giải ngân */
  bank_relation_documents: number;
}

export const EMPTY_TYPE_USAGE: PartnerTypeUsage = {
  bank_debts: 0,
  debt_vouchers: 0,
  lender_documents: 0,
  bank_relation_documents: 0,
};

/** Các lý do chặn (tiếng Việt). Rỗng ⇒ được phép đổi. Thuần. */
export function partnerTypeBlockers(from: PartnerType, to: PartnerType, usage: PartnerTypeUsage): string[] {
  if (from === to) return [];
  const blockers: string[] = [];
  if (to !== 'bank') {
    if (usage.bank_debts > 0) blockers.push(`đang có ${usage.bank_debts} khoản nợ ngân hàng`);
    if (usage.lender_documents > 0) blockers.push(`là ngân hàng cho vay trên ${usage.lender_documents} phiếu`);
    if (usage.bank_relation_documents > 0) blockers.push(`có ${usage.bank_relation_documents} phiếu đã liên kết trả nợ / giải ngân vay`);
  }
  if (to === 'bank' && usage.debt_vouchers > 0) {
    blockers.push(`đang có ${usage.debt_vouchers} khoản công nợ (chỉ Khách hàng / Nhà cung cấp)`);
  }
  return blockers;
}

/** Ném `FG-PARTNER-003` nếu việc đổi loại vỡ ràng buộc. */
export function assertPartnerTypeChange(from: PartnerType, to: PartnerType, usage: PartnerTypeUsage): void {
  const blockers = partnerTypeBlockers(from, to, usage);
  if (blockers.length) {
    throw new ApiError({
      code: 'FG-PARTNER-003',
      detail: `Không đổi sang "${PARTNER_TYPE_LABEL[to]}": ${blockers.join('; ')}`,
      data: { blockers },
    });
  }
}

/** Đếm các phụ thuộc của một đối tác trong công ty (dùng cho guard đổi loại). */
export async function loadPartnerTypeUsage(companyId: string, partnerId: string): Promise<PartnerTypeUsage> {
  const [bank_debts, debt_vouchers, lender_documents, relationIds] = await Promise.all([
    Models.BankDebt.countDocuments({ company_id: companyId, partner_id: partnerId } as never).exec(),
    Models.DebtVoucher.countDocuments({ company_id: companyId, partner_id: partnerId } as never).exec(),
    Models.Document.countDocuments({ company_id: companyId, 'options.loan.lender_partner_id': partnerId } as never).exec(),
    Models.BusinessLink.distinct('from_id', {
      company_id: companyId,
      from_type: 'document',
      relation: { $in: ['repayment', 'disbursement'] },
      status: 'active',
    } as never).exec(),
  ]);
  const bank_relation_documents = relationIds.length
    ? await Models.Document.countDocuments({ _id: { $in: relationIds }, partner_id: partnerId } as never).exec()
    : 0;
  return { bank_debts, debt_vouchers, lender_documents, bank_relation_documents };
}

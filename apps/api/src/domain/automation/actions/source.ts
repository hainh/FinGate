/**
 * Khoản vay của một PHIẾU NGUỒN đã huỷ / từ chối / bị xoá (v2/v2.md §11.5 ngoại lệ, §14.3 (6)) — dùng chung cho
 * R6 và cho thao tác xoá phiếu nguồn, để cả hai cùng một quyết định:
 *  - chưa có tiền, khoản do quy tắc sinh ⇒ HUỶ khoản vay (không có tiền, không cần bút toán);
 *  - chưa có tiền, khoản tạo tay      ⇒ chỉ GỠ liên kết (khoản vay còn dùng được cho phiếu khác);
 *  - đã có tiền về                     ⇒ KHÔNG tự huỷ — người gọi cảnh báo KTT.
 *
 * Khoản vay được tìm qua liên kết hiệu lực VÀ qua phiếu nguồn ghi trên khoản vay tự sinh (`origin.source_document_id`),
 * nên khoản do quy tắc sinh vẫn được xử lý khi liên kết đã bị gỡ.
 */

import { decideOnSourceFinal } from '../policy.ts';
import type { AutoActor } from './common.ts';
import { unlinkAutomationLink } from './link.ts';
import { activeLoanLinks, automationLoansOfSource, cancelLoan, loadLoan, type LoanView } from './loan.ts';

export interface SourceLoan {
  /** liên kết hiệu lực từ phiếu nguồn tới khoản vay (null nếu chỉ tìm thấy theo phiếu nguồn ghi trên khoản vay). */
  linkId: string | null;
  loan: LoanView;
}

/** Khoản vay gắn với phiếu nguồn (giải ngân, vay để chi, và khoản do quy tắc sinh ra từ phiếu này), không trùng. */
export async function loansFromSource(sourceId: string): Promise<SourceLoan[]> {
  const found = new Map<string, SourceLoan>();
  for (const link of [...(await activeLoanLinks(sourceId, 'disbursement')), ...(await activeLoanLinks(sourceId, 'funded_by'))]) {
    const loan = await loadLoan(link.loanId);
    if (loan && !found.has(loan.id)) found.set(loan.id, { linkId: link.linkId, loan });
  }
  for (const loan of await automationLoansOfSource(sourceId)) {
    if (!found.has(loan.id)) found.set(loan.id, { linkId: null, loan });
  }
  return [...found.values()];
}

/**
 * Áp quyết định cho các khoản vay của phiếu nguồn đã huỷ / từ chối / xoá. Trả về id khoản vay vừa huỷ (đầu tiên),
 * hoặc null. Chạy lại an toàn: khoản đã huỷ / đã gỡ liên kết thì bỏ qua.
 */
export async function releaseLoansOfSource(input: { sourceId: string; reason: string; actor: AutoActor; requestId: string }): Promise<string | null> {
  let cancelledId: string | null = null;
  for (const { linkId, loan } of await loansFromSource(input.sourceId)) {
    const decision = decideOnSourceFinal({ loanStatus: loan.status, origin: loan.origin, disbursedAt: loan.disbursed_at });
    if (decision === 'cancel') {
      const res = await cancelLoan({ loanId: loan.id, reason: input.reason, actor: input.actor, requestId: input.requestId });
      if (res === 'cancelled') cancelledId ??= loan.id;
    } else if (decision === 'unlink' && linkId) {
      await unlinkAutomationLink({ linkId, reason: `${input.reason}: gỡ liên kết khoản vay`, actor: input.actor, requestId: input.requestId });
    }
  }
  return cancelledId;
}

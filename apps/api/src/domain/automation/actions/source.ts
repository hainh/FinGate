/**
 * Khoản vay của một PHIẾU NGUỒN đã huỷ / từ chối / bị xoá (v2/v2.md §11.3 R6, §11.5 ngoại lệ, §14.3 (6)) — dùng chung
 * cho R6 và cho thao tác xoá phiếu nguồn, để cả hai cùng một quyết định (`decideOnSourceFinal`):
 *  - khoản do quy tắc sinh từ phiếu này, chưa có tiền ⇒ HUỶ khoản vay (không có tiền, không cần bút toán);
 *  - khoản chỉ gắn THỦ CÔNG vào phiếu này (không do phiếu sinh ra) ⇒ chỉ GỠ liên kết (khoản vay còn dùng được cho
 *    phiếu khác), không cảnh báo — R6 chỉ xử lý đối tượng tự sinh;
 *  - khoản do quy tắc sinh, đã có tiền về ⇒ KHÔNG tự huỷ, chỉ cảnh báo KTT (`alertLoansOfSource`).
 *
 * Khoản vay được tìm qua liên kết hiệu lực VÀ qua phiếu nguồn ghi trên khoản vay tự sinh (`origin.source_document_id`),
 * nên khoản do quy tắc sinh vẫn được xử lý khi liên kết đã bị gỡ.
 */

import { decideOnSourceFinal, type SourceFinalDecision, type SourceLinkOrigin } from '../policy.ts';
import type { AutoActor } from './common.ts';
import { unlinkAutomationLink } from './link.ts';
import { activeLoanLinks, automationLoansOfSource, cancelLoan, loadLoan, type LoanView } from './loan.ts';

export interface SourceLoan {
  /** liên kết hiệu lực từ phiếu nguồn tới khoản vay (null nếu không có). */
  linkId: string | null;
  /** nguồn của liên kết đó (`Thủ công` / `Tự động`); null nếu không có liên kết. */
  linkOrigin: SourceLinkOrigin | null;
  /** khoản do CHÍNH phiếu nguồn sinh ra (quy tắc tự động), kể cả khi liên kết đã gỡ. */
  generated: boolean;
  loan: LoanView;
}

/** Khoản vay gắn với phiếu nguồn (giải ngân, vay để chi, và khoản do quy tắc sinh ra từ phiếu này), không trùng. */
export async function loansFromSource(sourceId: string): Promise<SourceLoan[]> {
  const found = new Map<string, SourceLoan>();
  for (const link of [...(await activeLoanLinks(sourceId, 'disbursement')), ...(await activeLoanLinks(sourceId, 'funded_by'))]) {
    const loan = await loadLoan(link.loanId);
    if (loan && !found.has(loan.id)) found.set(loan.id, { linkId: link.linkId, linkOrigin: link.origin, generated: false, loan });
  }
  for (const loan of await automationLoansOfSource(sourceId)) {
    const linked = found.get(loan.id);
    if (linked) linked.generated = true;
    else found.set(loan.id, { linkId: null, linkOrigin: null, generated: true, loan });
  }
  return [...found.values()];
}

/** Quyết định R6 cho một khoản vay của phiếu nguồn (xem `decideOnSourceFinal`). */
function decisionOf(s: SourceLoan): SourceFinalDecision {
  return decideOnSourceFinal({ loanStatus: s.loan.status, generated: s.generated, linkOrigin: s.linkOrigin, disbursedAt: s.loan.disbursed_at });
}

/** Khoản vay do quy tắc sinh ra từ phiếu nguồn ĐÃ CÓ TIỀN — cần cảnh báo KTT (không tự huỷ). */
export async function alertLoansOfSource(sourceId: string): Promise<SourceLoan[]> {
  return (await loansFromSource(sourceId)).filter((s) => decisionOf(s) === 'alert');
}

/**
 * Áp quyết định cho các khoản vay của phiếu nguồn đã huỷ / từ chối / xoá. Trả về id khoản vay vừa huỷ (đầu tiên),
 * hoặc null. Chạy lại an toàn: khoản đã huỷ / đã gỡ liên kết thì bỏ qua.
 */
export async function releaseLoansOfSource(input: { sourceId: string; reason: string; actor: AutoActor; requestId: string }): Promise<string | null> {
  let cancelledId: string | null = null;
  for (const s of await loansFromSource(input.sourceId)) {
    const decision = decisionOf(s);
    if (decision === 'cancel') {
      const res = await cancelLoan({ loanId: s.loan.id, reason: input.reason, actor: input.actor, requestId: input.requestId });
      if (res === 'cancelled') cancelledId ??= s.loan.id;
    } else if (decision === 'unlink' && s.linkId) {
      await unlinkAutomationLink({ linkId: s.linkId, reason: `${input.reason}: gỡ liên kết khoản vay`, actor: input.actor, requestId: input.requestId });
    }
  }
  return cancelledId;
}

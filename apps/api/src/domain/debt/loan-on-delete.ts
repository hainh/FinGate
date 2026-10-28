/**
 * Xoá phiếu giải ngân đã thực thi (v2 §8, §11.4): khoản vay đang `active` mà chỉ phiếu này giải ngân thì phải về
 * `Chờ giải ngân`, vì tiền đã được đảo trong sổ cái khi xoá. Trước đây khoản giữ `active` dù không còn tiền về
 * và liên kết giải ngân đã bị gỡ mềm, nên không còn chứng từ nào giải thích khoản vay.
 */

import { ApiError } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { buildHistoryEntry, mirrorAudit } from '../audit/index.ts';
import { loadDocs } from './loads.ts';

interface LoanActorLike {
  user_id: string | null;
  name?: string | null;
  role?: string | null;
}

/** Khoản vay sẽ về `Chờ giải ngân` khi phiếu giải ngân bị xoá. */
export interface LoanToRevert {
  _id: string;
  code: string;
  company_id: string;
}

/** Có liên kết `relation` đã thực thi (phiếu `paid`) tới khoản vay, trừ phiếu `exceptDocId`. */
async function hasPaidLink(loanId: string, relation: 'disbursement' | 'repayment', exceptDocId?: string): Promise<boolean> {
  const filter: Record<string, unknown> = { to_type: 'bank_debt', to_id: loanId, relation, status: 'active' };
  if (exceptDocId) filter.from_id = { $ne: exceptDocId };
  const links = await Models.BusinessLink.find(filter as never).select({ from_id: 1 }).lean<{ from_id: unknown }[]>();
  if (!links.length) return false;
  const docs = await loadDocs(links.map((l) => l.from_id));
  return [...docs.values()].some((d) => d.status === 'paid');
}

/**
 * Các khoản vay sẽ về `Chờ giải ngân` khi xoá phiếu `documentId`: phiếu đã thực thi, có liên kết giải ngân hiệu lực
 * tới khoản đang `active`, và khoản không còn phiếu giải ngân thực thi nào khác. Khoản đã có phiếu trả nợ thực thi ⇒ chặn
 * (phải xoá phiếu trả nợ trước). Chỉ đọc: gọi TRƯỚC khi đảo sổ để lỗi không để lại phiếu đã đảo nhưng còn nguyên.
 */
export async function loansToRevertOnDelete(documentId: string): Promise<LoanToRevert[]> {
  const doc = (await loadDocs([documentId])).get(documentId);
  if (doc?.status !== 'paid') return [];
  const links = await Models.BusinessLink.find({
    from_type: 'document',
    from_id: documentId,
    to_type: 'bank_debt',
    relation: 'disbursement',
    status: 'active',
  } as never)
    .select({ to_id: 1 })
    .lean<{ to_id: unknown }[]>();

  const out: LoanToRevert[] = [];
  for (const link of links) {
    const loanId = String(link.to_id);
    const loan = await Models.BankDebt.findById(loanId)
      .select({ code: 1, company_id: 1, status: 1 })
      .lean<{ code?: string; company_id?: unknown; status?: string } | null>();
    if (!loan || loan.status !== 'active') continue;
    if (await hasPaidLink(loanId, 'disbursement', documentId)) continue;
    if (await hasPaidLink(loanId, 'repayment')) {
      throw new ApiError({
        code: 'FG-WF-001',
        detail: `Khoản vay ${loan.code ?? loanId} đã có phiếu trả nợ thực thi — xoá phiếu trả nợ đó trước, rồi xoá phiếu giải ngân`,
      });
    }
    out.push({ _id: loanId, code: String(loan.code ?? ''), company_id: String(loan.company_id ?? '') });
  }
  return out;
}

/** Đưa các khoản (từ `loansToRevertOnDelete`) về `Chờ giải ngân`. Chạy lại an toàn: khoản đã đổi trạng thái thì bỏ qua. */
export async function revertLoansOnDelete(
  loans: LoanToRevert[],
  input: { actor: LoanActorLike; reason: string; requestId: string | null },
): Promise<void> {
  for (const loan of loans) {
    const now = new Date();
    const res = await Models.BankDebt.updateOne(
      { _id: loan._id, status: 'active' } as never,
      {
        $set: { status: 'pending_disbursement', disbursed_at: null, outstanding_minor: 0n, updated_at: now },
        $push: {
          history: buildHistoryEntry({
            action: 'revert_disbursement',
            actor: input.actor,
            from: 'active',
            to: 'pending_disbursement',
            reason: input.reason,
            request_id: input.requestId,
            at: now,
          }),
        },
      } as never,
    ).exec();
    if (!res.modifiedCount) continue;
    await mirrorAudit({
      at: now,
      actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
      action: 'bank_debt.revert_disbursement',
      subject: { type: 'bank_debt', id: loan._id, code: loan.code },
      company_id: loan.company_id,
      diff_fields: { status: { before: 'active', after: 'pending_disbursement' }, reason: input.reason },
      request_id: input.requestId,
    });
  }
}

/**
 * R3 — Phiếu chi "VAY NGÂN HÀNG ĐỂ CHI" (v2/v2.md §11.5). Mới trong v2.
 *
 * Kích hoạt: `voucher.approved` của phiếu chi có `options.loan.kind = fund` (duyệt CUỐI, số tiền đã chốt).
 * Bước (theo thứ tự chạy):
 *  1. create_loan      — khoản nợ NH `Chờ giải ngân` (ngân hàng cho vay, gốc = số tiền vay) + liên kết `funded_by`
 *                        phiếu chi → khoản vay;
 *  2. create_voucher   — phiếu THU cùng công ty: ngân hàng cho vay, TK nhận giải ngân, số tiền vay, nội dung
 *                        "(Tự động) Giải ngân vay cho phiếu chi …", ĐÃ DUYỆT (kế thừa chuỗi duyệt của phiếu chi);
 *  3. link             — `generated` phiếu chi → phiếu thu, `disbursement` phiếu thu → khoản vay;
 *  4. execute_voucher  — thực thi phiếu thu, ngày thực thi = ngày duyệt cuối của phiếu chi (tiền vào trước khi chi);
 *  5. activate_loan    — khoản vay → `Đang vay`, ngày giải ngân = ngày thực thi, gốc = số thực thu.
 * Phiếu chi giữ `Đã duyệt`, chờ kế toán thực thi như thường. Sau khi R3 chạy, số tiền phiếu chi bị khoá.
 */

import { vnDate } from '@fingate/shared';
import { registerRule, type StepContext, type StepOutput } from '../engine.ts';
import {
  APPROVED_VOUCHER_STATUSES,
  finalApprovalDateOf,
  resolveLoanAmount,
  resolveLoanTerms,
  submittedAmountOf,
  type LoanTermsInput,
} from '../policy.ts';
import { actorOfEvent, big } from '../actions/common.ts';
import { bankPartnerOrThrow, fundOfAccount, loadVoucher, type VoucherRow } from '../actions/lookup.ts';
import { activeLoanLinks, activateLoan, createAutoLoan, findAutoLoanFor, loadLoan } from '../actions/loan.ts';
import { ensureAutomationLink } from '../actions/link.ts';
import { createAutoVoucher, executeAutoVoucher, findAutoVoucher } from '../actions/voucher.ts';
import { assertAccountAllowedForCompany } from '../../accounts.ts';

const RULE = 'R3';

registerRule(RULE, {
  steps: [
    { name: 'create_loan', run: createLoanStep },
    { name: 'create_voucher', run: createVoucherStep },
    { name: 'link', run: linkStep },
    { name: 'execute_voucher', run: executeVoucherStep },
    { name: 'activate_loan', run: activateLoanStep },
  ],
});

type FundOptions = NonNullable<NonNullable<VoucherRow['options']>['loan']>;

/** Phiếu chi vay để chi (đúng loại + cờ fund) hoặc null. */
async function fundPaymentOf(ctx: StepContext): Promise<{ doc: VoucherRow; opt: FundOptions } | null> {
  const doc = await loadVoucher(ctx.event.subject_id);
  const opt = doc?.options?.loan;
  if (!doc || doc.kind !== 'spend' || opt?.kind !== 'fund') return null;
  return { doc, opt };
}

/** Ngày duyệt cuối của phiếu chi (ngày VN) — ngày giải ngân và ngày gốc hạn. */
function finalDateOf(doc: VoucherRow): string {
  return finalApprovalDateOf(doc.history, vnDate());
}

async function loanIdOf(ctx: StepContext, doc: VoucherRow): Promise<string | null> {
  return ctx.outputs.create_loan?.output_id ?? (await findAutoLoanFor({ sourceDocId: String(doc._id), relation: 'funded_by', ruleCode: RULE, runId: ctx.runId }))?.id ?? null;
}

async function receiptIdOf(ctx: StepContext): Promise<string | null> {
  return ctx.outputs.create_voucher?.output_id ?? (await findAutoVoucher(ctx.runId, RULE, 'income'))?.id ?? null;
}

/* ------------------------------------------------------------------ *
 * 1. create_loan
 * ------------------------------------------------------------------ */

async function createLoanStep(ctx: StepContext): Promise<StepOutput> {
  const found = await fundPaymentOf(ctx);
  if (!found) return { skipped: true };
  const { doc, opt } = found;
  const actor = actorOfEvent(ctx.event);
  const sourceId = String(doc._id);

  const existing = await findAutoLoanFor({ sourceDocId: sourceId, relation: 'funded_by', ruleCode: RULE, runId: ctx.runId });
  if (existing) {
    // đã có khoản vay của lượt này (chạy lại): bảo đảm liên kết funded_by
    await ensureAutomationLink({
      from: { type: 'document', id: sourceId },
      to: { type: 'bank_debt', id: existing.id },
      relation: 'funded_by',
      amountMinor: existing.principal_minor,
      runId: ctx.runId,
      ruleCode: RULE,
      actor,
      requestId: ctx.stepKey,
    });
    return { output_type: 'bank_debt', output_id: existing.id };
  }

  if (!APPROVED_VOUCHER_STATUSES.includes(doc.status)) {
    throw new Error(`Phiếu chi ${doc.code} chưa duyệt cuối (đang ${doc.status})`);
  }
  const lender = await bankPartnerOrThrow(opt.lender_partner_id, 'Ngân hàng cho vay');
  const finalMinor = big(doc.amount.minor);
  const { amount } = resolveLoanAmount({
    requested: opt.amount_minor === null || opt.amount_minor === undefined ? null : big(opt.amount_minor),
    originalMinor: submittedAmountOf(doc.history) ?? finalMinor,
    finalMinor,
  });
  const baseDate = finalDateOf(doc);
  const terms = resolveLoanTerms({ terms: opt.terms as LoanTermsInput | null, baseDate, params: ctx.params });

  const created = await createAutoLoan({
    companyId: String(doc.company_id),
    partnerId: lender.id,
    bankName: lender.name,
    principalMinor: amount,
    currency: doc.amount.currency ?? 'VND',
    terms,
    note: `Tự động tạo cho phiếu chi ${doc.code}`,
    runId: ctx.runId,
    ruleCode: RULE,
    source: { id: sourceId, code: doc.code },
    actor,
    requestId: ctx.stepKey,
  });
  await ensureAutomationLink({
    from: { type: 'document', id: sourceId },
    to: { type: 'bank_debt', id: created.id },
    relation: 'funded_by',
    amountMinor: amount,
    runId: ctx.runId,
    ruleCode: RULE,
    actor,
    requestId: ctx.stepKey,
  });
  return { output_type: 'bank_debt', output_id: created.id };
}

/* ------------------------------------------------------------------ *
 * 2. create_voucher — phiếu thu giải ngân (đã duyệt, kế thừa chuỗi duyệt)
 * ------------------------------------------------------------------ */

async function createVoucherStep(ctx: StepContext): Promise<StepOutput> {
  const found = await fundPaymentOf(ctx);
  if (!found) return { skipped: true };
  const { doc, opt } = found;

  const existing = await findAutoVoucher(ctx.runId, RULE, 'income');
  if (existing) return { output_type: 'document', output_id: existing.id };

  const loanId = await loanIdOf(ctx, doc);
  if (!loanId) throw new Error('Chưa có khoản vay để giải ngân');
  const loan = await loadLoan(loanId);
  if (!loan) throw new Error('Không tìm thấy khoản vay để giải ngân');
  if (!opt.receive_account_id) throw new Error('Thiếu tài khoản nhận giải ngân của công ty');
  const receiveAccountId = String(opt.receive_account_id);
  await assertAccountAllowedForCompany(String(doc.company_id), receiveAccountId);

  const actor = actorOfEvent(ctx.event);
  const created = await createAutoVoucher({
    kind: 'income',
    companyId: String(doc.company_id),
    title: `Giải ngân vay cho phiếu chi ${doc.code}`,
    purpose: `(Tự động) Giải ngân vay cho phiếu chi ${doc.code}`,
    note: `Tự động tạo từ quy tắc R3 · khoản vay ${loan.code}`,
    amountMinor: loan.principal_minor,
    currency: loan.currency,
    decimals: 0,
    fund: await fundOfAccount(receiveAccountId),
    accountId: receiveAccountId,
    partnerId: loan.partner_id,
    plannedDate: finalDateOf(doc),
    businessDate: finalDateOf(doc),
    approvalSteps: doc.approval?.steps,
    matrixLabel: 'Tự động (theo phiếu chi)',
    createdBy: actor.user_id ?? String(doc.created_by ?? ''),
    source: { id: String(doc._id), code: doc.code },
    ruleCode: RULE,
    runId: ctx.runId,
    eventType: ctx.event.type,
    actor,
    requestId: ctx.stepKey,
  });
  return { output_type: 'document', output_id: created.id };
}

/* ------------------------------------------------------------------ *
 * 3. link — generated (chi → thu) + disbursement (thu → khoản vay)
 * ------------------------------------------------------------------ */

async function linkStep(ctx: StepContext): Promise<StepOutput> {
  const found = await fundPaymentOf(ctx);
  const receiptId = await receiptIdOf(ctx);
  if (!found || !receiptId) return { skipped: true };
  const { doc } = found;
  const loanId = await loanIdOf(ctx, doc);
  if (!loanId) throw new Error('Chưa có khoản vay để liên kết');
  const loan = await loadLoan(loanId);
  if (!loan) throw new Error('Không tìm thấy khoản vay để liên kết');
  const actor = actorOfEvent(ctx.event);
  const common = { runId: ctx.runId, ruleCode: RULE, actor, requestId: ctx.stepKey };

  await ensureAutomationLink({ ...common, from: { type: 'document', id: String(doc._id) }, to: { type: 'document', id: receiptId }, relation: 'generated', amountMinor: null });
  await ensureAutomationLink({ ...common, from: { type: 'document', id: receiptId }, to: { type: 'bank_debt', id: loan.id }, relation: 'disbursement', amountMinor: loan.principal_minor });
  return { output_type: 'document', output_id: receiptId };
}

/* ------------------------------------------------------------------ *
 * 4. execute_voucher — thực thi phiếu thu, ngày = ngày duyệt cuối phiếu chi
 * ------------------------------------------------------------------ */

async function executeVoucherStep(ctx: StepContext): Promise<StepOutput> {
  const found = await fundPaymentOf(ctx);
  const receiptId = await receiptIdOf(ctx);
  if (!found || !receiptId) return { skipped: true };
  await executeAutoVoucher({ docId: receiptId, paidAt: finalDateOf(found.doc), actor: actorOfEvent(ctx.event), requestId: ctx.stepKey });
  return { output_type: 'document', output_id: receiptId };
}

/* ------------------------------------------------------------------ *
 * 5. activate_loan — tiền giải ngân đã về ⇒ khoản vay Đang vay
 * ------------------------------------------------------------------ */

async function activateLoanStep(ctx: StepContext): Promise<StepOutput> {
  const found = await fundPaymentOf(ctx);
  const receiptId = await receiptIdOf(ctx);
  if (!found || !receiptId) return { skipped: true };
  const receipt = await loadVoucher(receiptId);
  if (!receipt || receipt.status !== 'paid' || !receipt.execution?.paid_at) return { skipped: true };

  const actor = actorOfEvent(ctx.event);
  let first: string | null = null;
  for (const link of await activeLoanLinks(receiptId, 'disbursement')) {
    await activateLoan({
      loanId: link.loanId,
      disbursedAt: receipt.execution.paid_at,
      actualMinor: big(receipt.execution.actual_amount_minor ?? receipt.amount.minor),
      dueDate: null,
      actor,
      requestId: ctx.stepKey,
    });
    first ??= link.loanId;
  }
  return first ? { output_type: 'bank_debt', output_id: first } : { skipped: true };
}

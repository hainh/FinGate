/**
 * R8 — Phiếu chi MƯỢN TIỀN từ tài khoản khác cùng công ty (`options.account_borrow`).
 *
 * Hai phiếu mượn tiền được sinh và THỰC THI NGAY TRONG bước thực thi phiếu chi gốc, trước khi phiếu gốc ra tiền
 * (`vouchers/account-borrow-run.ts`, gọi từ `workflow.transition`) — TK A có tiền trước khi chi, TK B không âm.
 * Quy tắc này chạy sau đó: dùng lại hai phiếu đã có (theo phiếu nguồn), bảo đảm đã thực thi và gán liên kết; chỉ sinh
 * mới khi thiếu (dự phòng).
 *
 * Kích hoạt: `voucher.paid` của phiếu chi có cờ mượn tiền (phiếu chi từ TK A cho đối tác X đã duyệt và thực thi).
 * Bước:
 *  1. create_spend    — phiếu CHI ĐÃ DUYỆT từ TK cho mượn B sang TK A (kế thừa người duyệt của phiếu chi gốc, nhãn Tự động);
 *  2. create_receipt  — phiếu THU ĐÃ DUYỆT vào TK A từ TK B (cùng công ty, cùng số tiền);
 *  3. execute_spend   — thực thi phiếu chi B → A (ngày thực thi = ngày thực thi phiếu chi gốc): TK B giảm;
 *  4. execute_receipt — thực thi phiếu thu: TK A được bù;
 *  5. link            — `generated` phiếu gốc → hai phiếu sinh ra; `internal_transfer` phiếu chi B → phiếu thu A.
 * Số tiền = số tiền mượn đã ghi trên phiếu (không vượt số thực chi), bỏ trống = toàn bộ số thực chi.
 * Hai phiếu sinh ra không có đối tác ngoài (chuyển giữa hai TK của chính công ty — như phiếu thu của R1).
 */

import { registerRule, type StepContext, type StepOutput } from '../engine.ts';
import { assertAccountAllowedForCompany } from '../../accounts.ts';
import { actorOfEvent, big } from '../actions/common.ts';
import { fundOfAccount, loadVoucher, type VoucherRow } from '../actions/lookup.ts';
import { createAutoVoucher, executeAutoVoucher, todayVn } from '../actions/voucher.ts';
import { ensureAutomationLink } from '../actions/link.ts';
import { effectiveBorrowAmount, storedAccountBorrowToPlan } from '../../vouchers/account-borrow.ts';
import { findBorrowVoucher } from '../../vouchers/account-borrow-run.ts';
import { Models } from '../../../db/models.ts';
import { bankAccountLabelOf } from '../../queries/index.ts';

const RULE = 'R8';

registerRule(RULE, {
  steps: [
    { name: 'create_spend', run: createSpendStep },
    { name: 'create_receipt', run: createReceiptStep },
    { name: 'execute_spend', run: executeSpendStep },
    { name: 'execute_receipt', run: executeReceiptStep },
    { name: 'link', run: linkStep },
  ],
});

interface Borrow {
  src: VoucherRow;
  /** TK chi của phiếu gốc (nhận tiền mượn). */
  toAccountId: string;
  /** TK cho mượn. */
  fromAccountId: string;
  amountMinor: bigint;
  paidDate: string;
}

/** Phiếu chi gốc đã thực thi có cờ mượn tiền — null nếu không áp dụng. */
async function borrowOf(ctx: StepContext): Promise<Borrow | null> {
  const src = await loadVoucher(ctx.event.subject_id);
  if (!src || src.kind !== 'spend' || src.status !== 'paid') return null;
  const plan = storedAccountBorrowToPlan((src.options as { account_borrow?: Record<string, unknown> | null } | null | undefined)?.account_borrow ?? null);
  if (!plan) return null;
  const toAccountId = src.source?.account_id ? String(src.source.account_id) : null;
  if (!toAccountId) throw new Error(`Phiếu chi ${src.code} chưa có tài khoản chi`);
  if (toAccountId === plan.account_id) throw new Error('Tài khoản cho mượn trùng tài khoản chi của phiếu');
  const spent = big(src.execution?.actual_amount_minor ?? src.amount.minor);
  return {
    src,
    toAccountId,
    fromAccountId: plan.account_id,
    amountMinor: effectiveBorrowAmount(plan, spent),
    paidDate: src.execution?.paid_at ?? todayVn(),
  };
}

async function accountLabel(id: string): Promise<string> {
  const a = await Models.BankAccount.findById(id).select({ bank_name: 1, account_number: 1, account_name: 1 }).lean<{ bank_name?: string; account_number?: string; account_name?: string } | null>();
  return a ? bankAccountLabelOf(a) : id;
}

async function spendIdOf(ctx: StepContext): Promise<string | null> {
  return ctx.outputs.create_spend?.output_id ?? (await findBorrowVoucher(String(ctx.event.subject_id), 'spend'))?.id ?? null;
}

async function receiptIdOf(ctx: StepContext): Promise<string | null> {
  return ctx.outputs.create_receipt?.output_id ?? (await findBorrowVoucher(String(ctx.event.subject_id), 'income'))?.id ?? null;
}

/** Phần chung của hai phiếu sinh ra. */
function commonSpec(ctx: StepContext, b: Borrow) {
  const actor = actorOfEvent(ctx.event);
  return {
    companyId: String(b.src.company_id),
    amountMinor: b.amountMinor,
    currency: b.src.amount.currency ?? 'VND',
    decimals: b.src.amount.decimals ?? 0,
    partnerId: null,
    plannedDate: b.paidDate,
    businessDate: b.paidDate,
    approvalSteps: b.src.approval?.steps,
    matrixLabel: 'Tự động (theo phiếu chi)',
    createdBy: actor.user_id ?? String(b.src.created_by ?? ''),
    source: { id: String(b.src._id), code: b.src.code },
    ruleCode: RULE,
    runId: ctx.runId,
    eventType: ctx.event.type,
    actor,
    requestId: ctx.stepKey,
  };
}

async function createSpendStep(ctx: StepContext): Promise<StepOutput> {
  const b = await borrowOf(ctx);
  if (!b) return { skipped: true };
  const existing = await findBorrowVoucher(String(b.src._id), 'spend');
  if (existing) return { output_type: 'document', output_id: existing.id };
  await assertAccountAllowedForCompany(String(b.src.company_id), b.fromAccountId);
  const toLabel = await accountLabel(b.toAccountId);
  const created = await createAutoVoucher({
    ...commonSpec(ctx, b),
    kind: 'spend',
    title: `Cho mượn tiền để chi phiếu ${b.src.code}`,
    purpose: `(Tự động) Chuyển tiền sang TK ${toLabel} để chi phiếu ${b.src.code}`,
    note: `Tự động tạo khi thực thi phiếu chi ${b.src.code} · chuyển sang ${toLabel}`,
    fund: await fundOfAccount(b.fromAccountId),
    accountId: b.fromAccountId,
  });
  return { output_type: 'document', output_id: created.id };
}

async function createReceiptStep(ctx: StepContext): Promise<StepOutput> {
  const b = await borrowOf(ctx);
  if (!b) return { skipped: true };
  const existing = await findBorrowVoucher(String(b.src._id), 'income');
  if (existing) return { output_type: 'document', output_id: existing.id };
  const fromLabel = await accountLabel(b.fromAccountId);
  const created = await createAutoVoucher({
    ...commonSpec(ctx, b),
    kind: 'income',
    title: `Nhận tiền mượn để chi phiếu ${b.src.code}`,
    purpose: `(Tự động) Nhận tiền từ TK ${fromLabel} để chi phiếu ${b.src.code}`,
    note: `Tự động tạo khi thực thi phiếu chi ${b.src.code} · từ ${fromLabel}`,
    fund: await fundOfAccount(b.toAccountId),
    accountId: b.toAccountId,
  });
  return { output_type: 'document', output_id: created.id };
}

async function executeSpendStep(ctx: StepContext): Promise<StepOutput> {
  const b = await borrowOf(ctx);
  const spendId = await spendIdOf(ctx);
  if (!b || !spendId) return { skipped: true };
  await executeAutoVoucher({ docId: spendId, paidAt: b.paidDate, actor: actorOfEvent(ctx.event), requestId: ctx.stepKey });
  return { output_type: 'document', output_id: spendId };
}

async function executeReceiptStep(ctx: StepContext): Promise<StepOutput> {
  const b = await borrowOf(ctx);
  const receiptId = await receiptIdOf(ctx);
  if (!b || !receiptId) return { skipped: true };
  await executeAutoVoucher({ docId: receiptId, paidAt: b.paidDate, actor: actorOfEvent(ctx.event), requestId: ctx.stepKey });
  return { output_type: 'document', output_id: receiptId };
}

async function linkStep(ctx: StepContext): Promise<StepOutput> {
  const b = await borrowOf(ctx);
  const spendId = await spendIdOf(ctx);
  const receiptId = await receiptIdOf(ctx);
  if (!b || !spendId || !receiptId) return { skipped: true };
  const common = { amountMinor: null, runId: ctx.runId, ruleCode: RULE, actor: actorOfEvent(ctx.event), requestId: ctx.stepKey };
  const srcRef = { type: 'document' as const, id: String(b.src._id) };
  await ensureAutomationLink({ ...common, from: srcRef, to: { type: 'document', id: spendId }, relation: 'generated' });
  await ensureAutomationLink({ ...common, from: srcRef, to: { type: 'document', id: receiptId }, relation: 'generated' });
  await ensureAutomationLink({ ...common, from: { type: 'document', id: spendId }, to: { type: 'document', id: receiptId }, relation: 'internal_transfer' });
  return { output_type: 'document', output_id: receiptId };
}

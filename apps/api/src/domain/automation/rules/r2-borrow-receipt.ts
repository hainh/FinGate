/**
 * R2 — Phiếu thu ĐI VAY ngân hàng → khoản nợ ngân hàng (v2/v2.md §11.4, §10.2). Thay cờ v1 `create_bank_debt`.
 *
 * Kích hoạt: `voucher.created` (+ `voucher.updated`, `voucher.submitted`, `voucher.approved`, `voucher.paid`),
 * điều kiện: mọi phiếu thu (`payload.kind = income`). Mỗi lần SỬA / GỬI LẠI là một lượt riêng
 * (`occurrenceEvents`) để khoản vay chờ giải ngân được đồng bộ theo từng lần sửa.
 *
 * Chế độ (`options.loan.mode`, chỉ khi phiếu có cờ `borrow`; không có cờ ⇒ coi như `later`):
 *  - `new`      — tạo khoản vay (gốc = số tiền phiếu thu, đối tác = ngân hàng đã chọn, kỳ hạn/hạn mặc định
 *                 theo tham số) khi lưu phiếu (`r2_create_at = save`) hoặc khi duyệt (`approve`);
 *  - `existing` — gắn phiếu vào khoản vay có sẵn (cùng ngân hàng, đang chờ / đang vay, còn sức chứa);
 *  - `later` / không cờ — không tạo; khoản vay tự sinh chưa giải ngân được huỷ, liên kết tự sinh được gỡ.
 *
 * Bước:
 *  1. create_loan    — tạo / đồng bộ / phục hồi khoản vay tự sinh (chỉ phiếu đi vay chế độ `new`);
 *  2. activate_loan  — phiếu ĐÃ THỰC THI: mọi liên kết `disbursement` hiệu lực (kể cả gán tay, kể cả phiếu
 *                      không có cờ vay) ⇒ khoản vay `Đang vay`, ngày giải ngân = ngày thực thi (§10.2);
 *  3. link           — `disbursement` phiếu thu → khoản vay: khoản tự sinh (chế độ `new`, nguồn Tự động) hoặc khoản
 *                      đã có người dùng chọn (chế độ `existing`, nguồn Thủ công — v2 §11.2).
 */

import { today } from '@fingate/shared';
import { registerRule, type StepContext, type StepOutput } from '../engine.ts';
import {
  loanBaseDate,
  mayCreateLoan,
  mayFollowLoanEdits,
  mayReviveLoan,
  r2CreateAtOf,
  resolveLoanTerms,
  type LoanTermsInput,
} from '../policy.ts';
import { actorOfEvent, big, type AutoActor } from '../actions/common.ts';
import { bankPartnerOrThrow, loadVoucher, type VoucherRow } from '../actions/lookup.ts';
import {
  activeLoanLinks,
  activateLoan,
  automationLoansOfSource,
  cancelLoan,
  createAutoLoan,
  findAutoLoanFor,
  loadLoan,
  reviveLoan,
  syncAutoLoan,
  type LoanView,
} from '../actions/loan.ts';
import { ensureAutomationLink, ensureManualLink, unlinkAutomationLink } from '../actions/link.ts';
import { activateLoanOnDisbursement } from '../../debt/loans.ts';

const RULE = 'R2';
/** Khoản vay có thể gắn / kích hoạt giải ngân. */
const LINKABLE_LOAN_STATUSES = ['pending_disbursement', 'active', 'overdue'];

registerRule(RULE, {
  occurrenceEvents: ['voucher.updated', 'voucher.submitted'],
  steps: [
    { name: 'create_loan', run: createLoanStep },
    { name: 'activate_loan', run: activateLoanStep },
    { name: 'link', run: linkStep },
  ],
});

type LoanOptions = NonNullable<NonNullable<VoucherRow['options']>['loan']>;
type Mode = 'new' | 'existing' | 'later';

interface ReceiptCtx {
  doc: VoucherRow;
  /** Tuỳ chọn vay (chỉ khi phiếu có cờ `borrow`); null = không đi vay. */
  opt: LoanOptions | null;
  /** Chế độ hiệu lực: không cờ vay ⇒ `later`. */
  mode: Mode;
}

/** Phiếu thu (mọi phiếu thu) kèm chế độ vay hiệu lực, hoặc null nếu không phải phiếu thu. */
async function receiptOf(ctx: StepContext): Promise<ReceiptCtx | null> {
  const doc = await loadVoucher(ctx.event.subject_id);
  if (!doc || doc.kind !== 'income') return null;
  const opt = doc.options?.loan?.kind === 'borrow' ? doc.options.loan : null;
  const mode: Mode = opt?.mode === 'new' || opt?.mode === 'existing' ? opt.mode : 'later';
  return { doc, opt, mode };
}

/** Số tiền của khoản giải ngân: đã thực thi ⇒ số thực thu; chưa ⇒ số tiền phiếu. */
function receiptAmountOf(doc: VoucherRow): bigint {
  if (doc.status === 'paid' && doc.execution?.actual_amount_minor !== undefined && doc.execution?.actual_amount_minor !== null) {
    return big(doc.execution.actual_amount_minor);
  }
  return big(doc.amount.minor);
}

/** Ngày gốc tính hạn: ngày thực thi nếu đã giải ngân, không thì ngày dự kiến của phiếu. */
function baseDateOf(doc: VoucherRow): string {
  return loanBaseDate({ paidDate: doc.status === 'paid' ? (doc.execution?.paid_at ?? null) : null, plannedDate: doc.planned_date, fallback: today() });
}

const out = (loanId: string): StepOutput => ({ output_type: 'bank_debt', output_id: loanId });

/**
 * Khoản vay R2 tự sinh của phiếu thu nhưng KHÔNG còn đi vay (đổi sang "để sau", bỏ cờ, hoặc đổi sang khoản có sẵn):
 * khoản CHƯA có tiền ⇒ huỷ; liên kết tự sinh tới nó ⇒ gỡ (có lý do). Khoản đã có tiền không đụng tới.
 */
async function releaseAutoLoanOf(ctx: StepContext, sourceId: string, reason: string, actor: AutoActor): Promise<void> {
  for (const loan of await automationLoansOfSource(sourceId)) {
    if (loan.rule_code !== RULE || loan.status !== 'pending_disbursement') continue;
    for (const link of await activeLoanLinks(sourceId, 'disbursement')) {
      if (link.loanId === loan.id) await unlinkAutomationLink({ linkId: link.linkId, reason, actor, requestId: ctx.stepKey });
    }
    await cancelLoan({ loanId: loan.id, reason, actor, requestId: ctx.stepKey });
  }
}

/* ------------------------------------------------------------------ *
 * create_loan
 * ------------------------------------------------------------------ */

async function createLoanStep(ctx: StepContext): Promise<StepOutput> {
  const found = await receiptOf(ctx);
  if (!found) return { skipped: true };
  const { doc, opt, mode } = found;
  const actor = actorOfEvent(ctx.event);
  const sourceId = String(doc._id);

  if (mode !== 'new' || !opt) {
    // để sau / khoản có sẵn / không còn cờ vay: khoản do quy tắc sinh và chưa giải ngân ⇒ huỷ (không có tiền)
    await releaseAutoLoanOf(ctx, sourceId, `Phiếu thu ${doc.code} không còn đi vay khoản này`, actor);
    return { skipped: true };
  }

  const createAt = r2CreateAtOf(ctx.params.r2_create_at);
  const baseDate = baseDateOf(doc);
  const existing = await findAutoLoanFor({ sourceDocId: sourceId, relation: 'disbursement', ruleCode: RULE, runId: ctx.runId });
  if (existing) {
    if (existing.status === 'cancelled') {
      // chọn lại "vay mới" trên phiếu còn trước duyệt ⇒ phục hồi khoản đã huỷ (chưa từng có tiền)
      if (mayReviveLoan({ status: doc.status })) {
        await reviveLoan({ loanId: existing.id, actor, requestId: ctx.stepKey });
      }
      return out(existing.id);
    }
    if (existing.status === 'pending_disbursement' && mayFollowLoanEdits(doc.status)) {
      // phiếu còn sửa được: thông tin khoản vay chờ giải ngân theo phiếu (đối tác, gốc, điều khoản)
      const bank = await bankPartnerOrThrow(doc.partner_id, 'Phiếu thu đi vay');
      const terms = resolveLoanTerms({ terms: opt.terms as LoanTermsInput | null, baseDate, params: ctx.params });
      await syncAutoLoan({
        loanId: existing.id,
        partnerId: bank.id,
        bankName: bank.name,
        principalMinor: receiptAmountOf(doc),
        terms,
        requestId: ctx.stepKey,
        actor,
      });
    }
    return out(existing.id);
  }

  if (!mayCreateLoan({ createAt, eventType: ctx.event.type, status: doc.status })) return { skipped: true };

  const bank = await bankPartnerOrThrow(doc.partner_id, 'Phiếu thu đi vay');
  const terms = resolveLoanTerms({ terms: opt.terms as LoanTermsInput | null, baseDate, params: ctx.params });
  const created = await createAutoLoan({
    companyId: String(doc.company_id),
    partnerId: bank.id,
    bankName: bank.name,
    principalMinor: receiptAmountOf(doc),
    currency: doc.amount.currency ?? 'VND',
    terms,
    note: `Tự động tạo khi lập phiếu thu ${doc.code}`,
    runId: ctx.runId,
    ruleCode: RULE,
    source: { id: sourceId, code: doc.code },
    actor,
    requestId: ctx.stepKey,
  });
  return out(created.id);
}

/* ------------------------------------------------------------------ *
 * activate_loan — phiếu đã thực thi (thu tiền về): mọi liên kết giải ngân hiệu lực
 * ------------------------------------------------------------------ */

async function activateLoanStep(ctx: StepContext): Promise<StepOutput> {
  const doc = await loadVoucher(ctx.event.subject_id);
  if (!doc || doc.kind !== 'income' || doc.status !== 'paid' || !doc.execution?.paid_at) return { skipped: true };
  const paidAt = doc.execution.paid_at;
  const actor = actorOfEvent(ctx.event);
  const opt = doc.options?.loan?.kind === 'borrow' ? doc.options.loan : null;

  // khoản cần kích hoạt: mọi liên kết giải ngân hiệu lực (gán tay hoặc tự sinh), kèm khoản vừa tạo ở bước create_loan
  const loanIds = new Set((await activeLoanLinks(String(doc._id), 'disbursement')).map((l) => l.loanId));
  if (ctx.outputs.create_loan?.output_id) loanIds.add(ctx.outputs.create_loan.output_id);

  // đối tượng "đã tạo" của lượt chỉ là khoản do R2 sinh ra; khoản người dùng gắn tay chỉ được kích hoạt, không liệt kê
  let generated: string | null = null;
  let activated = false;
  for (const loanId of loanIds) {
    const loan = await loadLoan(loanId);
    if (!loan || !LINKABLE_LOAN_STATUSES.includes(loan.status)) continue; // đã huỷ / đã đang vay: không kích hoạt lại
    activated = true;
    if (loan.origin === 'automation' && loan.rule_code === RULE) {
      // khoản do R2 tạo: gốc = số thực thu; hạn mặc định = ngày giải ngân + lệch tháng (§11.4 (a)); người dùng đã nhập hạn thì giữ
      const terms = resolveLoanTerms({ terms: opt?.terms as LoanTermsInput | null, baseDate: paidAt, params: ctx.params });
      await activateLoan({
        loanId,
        disbursedAt: paidAt,
        actualMinor: receiptAmountOf(doc),
        dueDate: terms.due_is_default ? terms.due_date : null,
        actor,
        requestId: ctx.stepKey,
      });
      generated ??= loanId;
    } else {
      // khoản tạo tay (hoặc do quy tắc khác): đường chuẩn của nợ ngân hàng — idempotent (chỉ chuyển khi còn chờ)
      await activateLoanOnDisbursement(loanId, actor);
    }
  }
  if (generated) return out(generated);
  return activated ? {} : { skipped: true };
}

/* ------------------------------------------------------------------ *
 * link — liên kết giải ngân phiếu thu → khoản vay tự sinh
 * ------------------------------------------------------------------ */

async function linkStep(ctx: StepContext): Promise<StepOutput> {
  const found = await receiptOf(ctx);
  if (!found) return { skipped: true };
  const { doc, opt, mode } = found;
  const sourceId = String(doc._id);
  const actor = actorOfEvent(ctx.event);

  let target: LoanView | null = null;
  if (mode === 'new') {
    const id = ctx.outputs.create_loan?.output_id ?? (await findAutoLoanFor({ sourceDocId: sourceId, relation: 'disbursement', ruleCode: RULE, runId: ctx.runId }))?.id;
    target = id ? await loadLoan(id) : null;
  } else if (mode === 'existing') {
    if (!opt?.existing_loan_id) throw new Error('Chưa chọn khoản vay có sẵn để gắn phiếu thu');
    target = await loadLoan(String(opt.existing_loan_id));
    if (!target) throw new Error('Khoản vay đã chọn không còn tồn tại');
    if (!LINKABLE_LOAN_STATUSES.includes(target.status)) {
      throw new Error(`Khoản vay ${target.code} đang ở trạng thái ${target.status}, không gắn thêm phiếu giải ngân được`);
    }
  }

  // gỡ liên kết giải ngân TỰ SINH tới khoản KHÁC (không đụng liên kết gán tay, trừ khi đổi sang khoản có sẵn)
  for (const link of await activeLoanLinks(sourceId, 'disbursement')) {
    if (target && link.loanId === target.id) continue;
    const other = await loadLoan(link.loanId);
    const automated = other?.origin === 'automation' && other.rule_code === RULE;
    if (automated || mode === 'existing') {
      await unlinkAutomationLink({ linkId: link.linkId, reason: `Phiếu thu ${doc.code} đổi khoản vay giải ngân`, actor, requestId: ctx.stepKey });
    }
  }

  if (!target) return { skipped: true }; // để sau / không cờ vay
  if (mode === 'new' && !LINKABLE_LOAN_STATUSES.includes(target.status)) return { skipped: true }; // đã huỷ theo phiếu — chờ gửi lại

  const disbursement = {
    from: { type: 'document' as const, id: sourceId },
    to: { type: 'bank_debt' as const, id: target.id },
    relation: 'disbursement' as const,
    amountMinor: receiptAmountOf(doc),
    actor,
    requestId: ctx.stepKey,
  };
  // khoản người dùng đã chọn ("Gắn khoản vay đã có") ⇒ nguồn Thủ công và R2 KHÔNG sinh khoản nào: không liệt kê là "đã tạo"
  if (mode === 'existing') {
    await ensureManualLink(disbursement);
    return {};
  }
  try {
    await ensureAutomationLink({ ...disbursement, runId: ctx.runId, ruleCode: RULE });
  } catch (err) {
    // khoản VỪA tạo ở create_loan của lượt này mà không gắn được phiếu (vd phiếu hết sức chứa) ⇒ huỷ luôn,
    // không để khoản "Chờ giải ngân" mồ côi thiếu liên kết giải ngân (v2 §10.2)
    if (ctx.outputs.create_loan?.output_id === target.id) {
      await cancelLoan({ loanId: target.id, reason: `Không gắn được phiếu thu ${doc.code} — huỷ khoản vay vừa tạo`, actor, requestId: ctx.stepKey });
    }
    throw err;
  }
  return out(target.id);
}

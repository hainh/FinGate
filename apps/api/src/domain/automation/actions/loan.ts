/**
 * Bước KHOẢN VAY (v2/v2.md §10.1–10.2, §11.4–11.5, §14.3 (3)): tạo, đồng bộ, kích hoạt, huỷ, phục hồi.
 *
 * Ghi theo đúng quy ước của route nợ ngân hàng (mã NHD, lịch sử `history[]`, audit, sự kiện `loan.created`).
 * Mọi thao tác có điều kiện trên trạng thái (CAS theo status) ⇒ chạy lại không ghi đè / không trùng.
 * Idempotency: khoản vay sinh ra được tìm lại theo PHIẾU NGUỒN ghi trên khoản vay (`origin.source_document_id`
 * + mã quy tắc) — không phụ thuộc liên kết hiệu lực, nên gỡ liên kết không sinh khoản trùng. Dữ liệu cũ (chưa có
 * phiếu nguồn trên khoản vay) thì tìm qua liên kết hiệu lực, rồi qua lượt chạy (`origin.run_id`).
 */

import { Models } from '../../../db/models.ts';
import { nextSequentialCode } from '../../numbering/index.ts';
import { buildHistoryEntry, mirrorAudit } from '../../audit/index.ts';
import { emitDomainEvent } from '../../events/index.ts';
import type { ResolvedLoanTerms } from '../policy.ts';
import { big, idOf, type AutoActor } from './common.ts';

/** Khoản vay ở dạng đọc được cho bước (BigInt đã chuẩn hoá). */
export interface LoanView {
  id: string;
  code: string;
  company_id: string;
  partner_id: string | null;
  bank_name: string;
  status: string;
  currency: string;
  principal_minor: bigint;
  disbursed_at: Date | null;
  maturity_date: string | null;
  origin: 'automation' | 'manual';
  rule_code: string | null;
  run_id: string | null;
  /** Phiếu nguồn đã sinh khoản vay này (chỉ khoản do quy tắc sinh; dữ liệu cũ có thể null). */
  source_document_id: string | null;
}

interface LoanRow {
  _id: unknown;
  code: string;
  company_id: unknown;
  partner_id?: unknown;
  bank_name: string;
  principal_minor: unknown;
  status: string;
  disbursed_at?: Date | null;
  maturity_date?: string | null;
  interest_rate?: string | null;
  term_months?: number | null;
  contract_no?: string | null;
  collateral?: string | null;
  origin?: { kind?: string | null; run_id?: unknown; rule_code?: string | null; source_document_id?: unknown } | null;
  amount?: { currency?: string | null } | null;
  currency?: string | null;
}

function viewOf(row: LoanRow): LoanView {
  const automated = row.origin?.kind === 'automation';
  return {
    id: String(row._id),
    code: row.code,
    company_id: String(row.company_id),
    partner_id: idOf(row.partner_id),
    bank_name: row.bank_name,
    status: row.status,
    currency: row.currency ?? row.amount?.currency ?? 'VND',
    principal_minor: big(row.principal_minor),
    disbursed_at: row.disbursed_at ?? null,
    maturity_date: row.maturity_date ?? null,
    origin: automated ? 'automation' : 'manual',
    rule_code: automated ? (row.origin?.rule_code ?? null) : null,
    run_id: idOf(row.origin?.run_id),
    source_document_id: automated ? idOf(row.origin?.source_document_id) : null,
  };
}

/** Đọc khoản vay theo ID (null nếu không có). */
export async function loadLoan(id: string): Promise<LoanView | null> {
  const row = await Models.BankDebt.findById(id).lean<LoanRow | null>();
  return row ? viewOf(row) : null;
}

/** Người thực hiện theo dạng ghi lịch sử (`buildHistoryEntry`). */
function actorFields(actor: AutoActor) {
  return { user_id: actor.user_id, role: actor.role, name: actor.name };
}

/**
 * Các trường khoản vay lấy từ điều khoản đã chốt: số HĐ tín dụng và TSĐB (trường riêng của khoản vay, v2 §10.1),
 * lãi suất, kỳ hạn, kỳ trả, phương thức trả, hạn thanh toán.
 */
export function termFields(terms: ResolvedLoanTerms) {
  return {
    contract_no: terms.contract_no,
    collateral: terms.collateral,
    interest_rate: terms.interest_rate,
    term_months: terms.term_months,
    payment_frequency: terms.payment_frequency,
    repayment_method: terms.repayment_method,
    maturity_date: terms.due_date,
    next_due_date: terms.due_date,
  };
}

/**
 * Trường nào khác giữa trạng thái cũ và mới (so sánh dạng chuỗi; null và rỗng coi như trống).
 * Rỗng ⇒ không có thay đổi thật, không ghi lịch sử.
 */
export function changedFieldsOf(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (String(before[key] ?? '') !== String(after[key] ?? '')) changed[key] = { from: before[key], to: after[key] };
  }
  return changed;
}

/* ------------------------------------------------------------------ *
 * Tạo
 * ------------------------------------------------------------------ */

export interface CreateAutoLoanInput {
  companyId: string;
  partnerId: string;
  bankName: string;
  principalMinor: bigint;
  currency: string;
  terms: ResolvedLoanTerms;
  /** Ghi chú khoản vay (nguồn sinh). Số HĐ tín dụng và TSĐB nằm ở trường riêng, lấy từ `terms`. */
  note: string;
  runId: string;
  ruleCode: string;
  source: { id: string; code: string };
  actor: AutoActor;
  requestId: string;
}

/** Tạo khoản nợ ngân hàng `Chờ giải ngân` do quy tắc sinh ra (không tính dư nợ cho tới khi giải ngân). */
export async function createAutoLoan(input: CreateAutoLoanInput): Promise<{ id: string; code: string }> {
  if (input.principalMinor <= 0n) throw new Error('Số tiền vay phải lớn hơn 0');
  const now = new Date();
  const code = await nextSequentialCode('NHD', now);
  const history = [
    buildHistoryEntry({
      action: 'auto_create',
      actor: actorFields(input.actor),
      from: null,
      to: 'pending_disbursement',
      request_id: input.requestId,
      fields: { rule_code: input.ruleCode, run_id: input.runId, source_document_id: input.source.id, source_code: input.source.code },
    }),
  ];
  const created = await Models.BankDebt.create({
    code,
    company_id: input.companyId,
    bank_name: input.bankName,
    branch: null,
    partner_id: input.partnerId,
    principal_minor: input.principalMinor,
    credit_limit_minor: 0n,
    outstanding_minor: 0n,
    amount: { minor: input.principalMinor, currency: input.currency, decimals: 0 },
    currency: input.currency,
    ...termFields(input.terms),
    status: 'pending_disbursement',
    note: input.note,
    created_by: input.actor.user_id,
    origin: { kind: 'automation', run_id: input.runId, rule_code: input.ruleCode, source_document_id: input.source.id },
    history,
    created_at: now,
    updated_at: now,
  } as never);
  const id = String(created._id);

  await emitDomainEvent({
    type: 'loan.created',
    company_id: input.companyId,
    subject_type: 'bank_debt',
    subject_id: id,
    payload: {
      code,
      bank_name: input.bankName,
      principal_minor: input.principalMinor,
      partner_id: input.partnerId,
      origin: 'automation',
      rule_code: input.ruleCode,
      source_document_id: input.source.id,
    },
    actor: input.actor,
  });
  await mirrorAudit({
    at: now,
    actor: { user_id: input.actor.user_id, name: input.actor.name, role: input.actor.role },
    action: 'bank_debt.auto_create',
    subject: { type: 'bank_debt', id, code },
    company_id: input.companyId,
    diff_fields: { auto: true, rule_code: input.ruleCode, source_document_id: input.source.id, principal_minor: input.principalMinor.toString() },
    request_id: input.requestId,
  });
  return { id, code };
}

/* ------------------------------------------------------------------ *
 * Tìm khoản vay đã sinh cho một phiếu nguồn (idempotency)
 * ------------------------------------------------------------------ */

/** Liên kết hiệu lực từ phiếu nguồn tới khoản vay theo quan hệ (`funded_by` | `disbursement`). */
export async function activeLoanLinks(sourceDocId: string, relation: 'funded_by' | 'disbursement') {
  const rows = await Models.BusinessLink.find({
    from_type: 'document',
    from_id: sourceDocId,
    to_type: 'bank_debt',
    relation,
    status: 'active',
  } as never)
    .select({ _id: 1, to_id: 1, amount_minor: 1 })
    .lean<{ _id: unknown; to_id: unknown; amount_minor?: unknown }[]>();
  return rows.map((r) => ({ linkId: String(r._id), loanId: String(r.to_id), amountMinor: r.amount_minor === null || r.amount_minor === undefined ? null : big(r.amount_minor) }));
}

/**
 * Khoản vay do quy tắc `ruleCode` sinh cho phiếu nguồn. Thứ tự tìm:
 *  1. theo phiếu nguồn ghi trên khoản vay (`origin.source_document_id`) — đúng cả khi liên kết đã bị gỡ;
 *  2. dữ liệu cũ: theo liên kết hiệu lực (`funded_by` / `disbursement`);
 *  3. tiến trình chết giữa chừng: theo lượt chạy `runId` đã tạo khoản vay đó.
 */
export async function findAutoLoanFor(input: { sourceDocId: string; relation: 'funded_by' | 'disbursement'; ruleCode: string; runId: string }): Promise<LoanView | null> {
  const bySource = await Models.BankDebt.findOne({
    'origin.kind': 'automation',
    'origin.rule_code': input.ruleCode,
    'origin.source_document_id': input.sourceDocId,
  } as never).lean<LoanRow | null>();
  if (bySource) return viewOf(bySource);

  for (const link of await activeLoanLinks(input.sourceDocId, input.relation)) {
    const loan = await loadLoan(link.loanId);
    if (loan && loan.origin === 'automation' && loan.rule_code === input.ruleCode) return loan;
  }
  const orphan = await Models.BankDebt.findOne({ 'origin.run_id': input.runId, 'origin.rule_code': input.ruleCode } as never).lean<LoanRow | null>();
  return orphan ? viewOf(orphan) : null;
}

/**
 * Mọi khoản vay do quy tắc tự động sinh ra từ phiếu nguồn (mọi trạng thái, kể cả liên kết đã gỡ).
 * Dùng cho R6 (huỷ / cảnh báo khi phiếu nguồn bị huỷ) và khi phiếu nguồn bị xoá.
 */
export async function automationLoansOfSource(sourceDocId: string): Promise<LoanView[]> {
  const rows = await Models.BankDebt.find({ 'origin.kind': 'automation', 'origin.source_document_id': sourceDocId } as never).lean<LoanRow[]>();
  return rows.map(viewOf);
}

/* ------------------------------------------------------------------ *
 * Đồng bộ (khi phiếu còn sửa được) — chỉ khoản đang Chờ giải ngân
 * ------------------------------------------------------------------ */

export interface SyncAutoLoanInput {
  loanId: string;
  partnerId: string;
  bankName: string;
  principalMinor: bigint;
  terms: ResolvedLoanTerms;
  requestId: string;
  actor: AutoActor;
}

/**
 * Cập nhật thông tin khoản vay chờ giải ngân theo phiếu thu (gốc, đối tác, số HĐ, TSĐB, điều khoản).
 * Ghi chú không đồng bộ lại: người dùng có thể đã sửa trên khoản vay. Trả về true nếu có thay đổi thật.
 */
export async function syncAutoLoan(input: SyncAutoLoanInput): Promise<boolean> {
  const loan = await Models.BankDebt.findById(input.loanId).lean<LoanRow & { history?: unknown[] } | null>();
  if (!loan || loan.status !== 'pending_disbursement') return false;

  const before = {
    partner_id: idOf(loan.partner_id),
    bank_name: loan.bank_name,
    principal_minor: big(loan.principal_minor).toString(),
    contract_no: loan.contract_no ?? null,
    collateral: loan.collateral ?? null,
    interest_rate: loan.interest_rate ?? '0',
    term_months: loan.term_months ?? null,
    maturity_date: loan.maturity_date ?? null,
  };
  const after = {
    partner_id: input.partnerId,
    bank_name: input.bankName,
    principal_minor: input.principalMinor.toString(),
    contract_no: input.terms.contract_no,
    collateral: input.terms.collateral,
    interest_rate: input.terms.interest_rate,
    term_months: input.terms.term_months,
    maturity_date: input.terms.due_date,
  };
  const changed = changedFieldsOf(before, after);
  if (!Object.keys(changed).length) return false;

  const now = new Date();
  const entry = buildHistoryEntry({
    action: 'auto_sync',
    actor: actorFields(input.actor),
    from: 'pending_disbursement',
    to: 'pending_disbursement',
    request_id: input.requestId,
    fields: { changed },
    at: now,
  });
  const res = await Models.BankDebt.updateOne(
    { _id: input.loanId, status: 'pending_disbursement' } as never,
    {
      $set: {
        partner_id: input.partnerId,
        bank_name: input.bankName,
        principal_minor: input.principalMinor,
        outstanding_minor: 0n,
        amount: { minor: input.principalMinor, currency: loan.currency ?? loan.amount?.currency ?? 'VND', decimals: 0 },
        ...termFields(input.terms),
        updated_at: now,
      },
      $push: { history: entry },
    } as never,
  ).exec();
  return res.modifiedCount > 0;
}

/* ------------------------------------------------------------------ *
 * Kích hoạt (giải ngân) · Huỷ · Phục hồi
 * ------------------------------------------------------------------ */

/**
 * Kích hoạt khoản vay khi phiếu thu giải ngân được thực thi: `Chờ giải ngân` → `Đang vay`, ngày giải ngân =
 * ngày thực thi. Khoản do quy tắc sinh (`automation`): gốc = số tiền thực thu. `dueDate` (nếu có) thay hạn mặc định.
 * Khoản tạo tay giữ nguyên gốc (có thể giải ngân nhiều đợt). Gọi lại khi đã đang vay ⇒ 'already'.
 */
export async function activateLoan(input: {
  loanId: string;
  disbursedAt: string;
  actualMinor: bigint | null;
  dueDate: string | null;
  actor: AutoActor;
  requestId: string;
}): Promise<'activated' | 'already'> {
  const loan = await Models.BankDebt.findById(input.loanId).lean<LoanRow | null>();
  if (!loan) throw new Error('Không tìm thấy khoản vay để kích hoạt');
  if (loan.status !== 'pending_disbursement') {
    if (loan.status === 'active' || loan.status === 'overdue') return 'already';
    throw new Error(`Khoản vay ${loan.code} đang ở trạng thái ${loan.status}, không kích hoạt được`);
  }
  const now = new Date();
  const principal = input.actualMinor ?? big(loan.principal_minor);
  const set: Record<string, unknown> = {
    status: 'active',
    disbursed_at: new Date(`${input.disbursedAt}T00:00:00Z`),
    updated_at: now,
  };
  if (input.actualMinor !== null) {
    set.principal_minor = principal;
    set.outstanding_minor = principal;
    set.amount = { minor: principal, currency: loan.currency ?? loan.amount?.currency ?? 'VND', decimals: 0 };
  }
  if (input.dueDate) {
    set.maturity_date = input.dueDate;
    set.next_due_date = input.dueDate;
  }
  const entry = buildHistoryEntry({
    action: 'activate',
    actor: actorFields(input.actor),
    from: 'pending_disbursement',
    to: 'active',
    amount_at_decision: principal.toString(),
    request_id: input.requestId,
    fields: { disbursed_at: input.disbursedAt, ...(input.dueDate ? { due_date: input.dueDate } : {}) },
    at: now,
  });
  const res = await Models.BankDebt.updateOne({ _id: input.loanId, status: 'pending_disbursement' } as never, { $set: set, $push: { history: entry } } as never).exec();
  if (!res.modifiedCount) return 'already';
  await mirrorAudit({
    at: now,
    actor: { user_id: input.actor.user_id, name: input.actor.name, role: input.actor.role },
    action: 'bank_debt.activate',
    subject: { type: 'bank_debt', id: input.loanId, code: loan.code },
    company_id: String(loan.company_id),
    diff_fields: { status: { before: 'pending_disbursement', after: 'active' }, disbursed_at: input.disbursedAt, principal_minor: principal.toString() },
    request_id: input.requestId,
  });
  return 'activated';
}

/** Huỷ khoản vay CHƯA có tiền (chỉ `Chờ giải ngân`). Trả về 'skipped' nếu không còn ở trạng thái đó. */
export async function cancelLoan(input: { loanId: string; reason: string; actor: AutoActor; requestId: string }): Promise<'cancelled' | 'skipped'> {
  const loan = await Models.BankDebt.findById(input.loanId).lean<LoanRow | null>();
  if (!loan || loan.status !== 'pending_disbursement') return 'skipped';
  const now = new Date();
  const entry = buildHistoryEntry({
    action: 'cancel',
    actor: actorFields(input.actor),
    from: 'pending_disbursement',
    to: 'cancelled',
    reason: input.reason,
    request_id: input.requestId,
    at: now,
  });
  const res = await Models.BankDebt.updateOne(
    { _id: input.loanId, status: 'pending_disbursement' } as never,
    { $set: { status: 'cancelled', updated_at: now }, $push: { history: entry } } as never,
  ).exec();
  if (!res.modifiedCount) return 'skipped';
  await mirrorAudit({
    at: now,
    actor: { user_id: input.actor.user_id, name: input.actor.name, role: input.actor.role },
    action: 'bank_debt.cancel',
    subject: { type: 'bank_debt', id: input.loanId, code: loan.code },
    company_id: String(loan.company_id),
    diff_fields: { status: { before: 'pending_disbursement', after: 'cancelled' }, reason: input.reason },
    request_id: input.requestId,
  });
  return 'cancelled';
}

/** Phục hồi khoản vay tự sinh đã huỷ khi phiếu được gửi lại duyệt (chưa từng có tiền). */
export async function reviveLoan(input: { loanId: string; actor: AutoActor; requestId: string }): Promise<'revived' | 'skipped'> {
  const loan = await Models.BankDebt.findById(input.loanId).lean<LoanRow | null>();
  if (!loan || loan.status !== 'cancelled' || loan.disbursed_at) return 'skipped';
  const now = new Date();
  const entry = buildHistoryEntry({
    action: 'revive',
    actor: actorFields(input.actor),
    from: 'cancelled',
    to: 'pending_disbursement',
    request_id: input.requestId,
    at: now,
  });
  const res = await Models.BankDebt.updateOne(
    { _id: input.loanId, status: 'cancelled', disbursed_at: null } as never,
    { $set: { status: 'pending_disbursement', updated_at: now }, $push: { history: entry } } as never,
  ).exec();
  return res.modifiedCount ? 'revived' : 'skipped';
}

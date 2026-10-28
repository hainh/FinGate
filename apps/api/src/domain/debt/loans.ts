/**
 * Nợ ngân hàng (v2/v2.md §10, §11.4, §11.5, US-AUTO-08): khoản vay theo ĐỐI TÁC ngân hàng, vòng đời
 * (chờ giải ngân → đang vay → quá hạn / tất toán; huỷ; lưu trữ), trả nợ & giải ngân qua `business_links`.
 * Dư nợ = gốc − Σ phần GỐC của phiếu chi trả nợ đã thực thi (suy ra khi đọc).
 *
 * Vòng đời (v2 §10.2): giải ngân qua `assignDisbursement` (phiếu thu đã thực thi ⇒ `activateLoanOnDisbursement`
 * ⇒ Đang vay), huỷ khoản chờ giải ngân qua `cancelPendingLoan` (chặn khi còn phiếu chưa huỷ), trả nợ qua
 * `assignRepayment`, đảo hạn qua `assertLoanForRollover` / `applyRolloverResultToLoan`.
 * Quy tắc tự động R2/R3/R6 hiện ghi khoản vay qua `domain/automation/actions/loan.ts` (chưa dùng hàm này).
 */

import { ApiError, daysUntil, today, vnDate } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { scopeFilter, scopedFind } from '../../lib/mongo.ts';
import { buildHistoryEntry, mirrorAudit } from '../audit/index.ts';
import { emitDomainEvent } from '../events/index.ts';
import { nextSequentialCode } from '../numbering/index.ts';
import { parseRate, simpleInterest } from '../loan-schedule/index.ts';
import {
  allocationOf,
  createLink,
  documentAllocatedTotalOf,
  emitLoanSettledAfterPayment,
  loanOutstanding,
  loanOutstandingOf,
  principalPartOf,
  removeLink,
  reservingLinks,
  type LinkActor,
  type LinkRecord,
} from '../links/index.ts';
import type { ScopeLike } from '../types.ts';
import { loanImportRow, type LoanCreateBody, type LoanImportRow, type LoanUpdateBody } from './bodies.ts';
import {
  LOAN_PARTNER_TYPES,
  UNLINKABLE_DOC_STATUSES,
  assertLinkableDocStatus,
  assertMaturityAfterDisbursement,
  businessDateStart,
  changesOf,
  defaultAllocation,
  disbursementFigures,
  escapeRegex,
  isLoanOnMaturityBoard,
  isoOf,
  loanStatusOf,
  loanWarningOf,
  loanDisbursementToggle,
  manualLoanDisbursement,
  positiveMinor,
  wireMoney,
  type LoanStatus,
} from './rules.ts';
import { assertDisbursementNotChosenLoan, type StoredLoanChoice } from '../vouchers/rules.ts';
import {
  assertInScope,
  assertPartner,
  documentCandidates,
  isExecuted,
  lastPaidAt,
  loadCompanyNames,
  loadDocs,
  loadLinks,
  loadPartners,
  paidRepaymentParts,
  sumBy,
  validIds,
  type DocRef,
  type PartnerRef,
} from './loads.ts';
import type { DebtActor, ReqMeta } from './debts.ts';

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** Người thực hiện: người dùng (ActorInfo) hoặc hệ thống/quy tắc tự động (user_id null). */
export interface LoanActor {
  user_id: string | null;
  name?: string | null;
  role?: string | null;
}

export interface LoanRaw {
  _id: unknown;
  company_id: unknown;
  code?: string;
  bank_name?: string;
  partner_id?: unknown;
  principal_minor?: unknown;
  credit_limit_minor?: unknown;
  outstanding_minor?: unknown;
  amount?: { minor?: unknown; currency?: string } | null;
  currency?: string;
  interest_rate?: string;
  term_months?: number | null;
  payment_frequency?: string;
  repayment_method?: string;
  maturity_date?: string;
  next_due_date?: string | null;
  status?: string;
  disbursed_at?: Date | string | null;
  origin?: { kind?: string; run_id?: unknown; rule_code?: string | null } | null;
  attachments?: unknown[];
  history?: unknown[];
  note?: string | null;
  contract_no?: string | null;
  collateral?: string | null;
  responsible?: string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

/** Trường được ghi lịch sử trước → sau khi sửa khoản vay (v2 §2.3). */
const LOAN_TRACKED = ['partner_id', 'principal_minor', 'credit_limit_minor', 'interest_rate', 'term_months', 'payment_frequency', 'repayment_method', 'maturity_date', 'contract_no', 'collateral', 'responsible', 'note'] as const;

function toBigSafe(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

export async function loadLoanOrFail(id: string): Promise<LoanRaw> {
  const b = OBJECT_ID_RE.test(id) ? await Models.BankDebt.findById(id).lean<LoanRaw | null>() : null;
  if (!b) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy khoản nợ' });
  return b;
}

interface LoanCtx {
  partners: Map<string, PartnerRef>;
  companies: Map<string, string>;
  /** Phần đã trả (phiếu chi đã thực thi). */
  repaid: { principal: Map<string, bigint>; interest: Map<string, bigint>; fee: Map<string, bigint> };
  /** Gốc đã gán trả nợ (mọi trạng thái phiếu) — dùng kiểm sức chứa khi sửa gốc. */
  repaidPlanned: Map<string, bigint>;
  /** Số tiền giải ngân đã thực thi / đã gán (mọi trạng thái). */
  disbursedPaid: Map<string, bigint>;
  disbursedPlanned: Map<string, bigint>;
  /** Số liên kết giải ngân hiệu lực theo khoản (0 ⇒ khoản tạo tay / nhập lô: đã giải ngân = gốc). */
  disbursementCount: Map<string, number>;
  funded: Map<string, bigint>;
  repaymentCounts: Map<string, number>;
}

async function loanContext(rows: LoanRaw[]): Promise<LoanCtx> {
  const ids = rows.map((r) => String(r._id));
  const [partners, companies, links] = await Promise.all([
    loadPartners(rows.map((r) => r.partner_id)),
    loadCompanyNames(rows.map((r) => r.company_id)),
    loadLinks({ to_type: 'bank_debt', to_ids: ids }),
  ]);
  const docs = await loadDocs(links.map((l) => l.from_id));
  const paid = isExecuted(docs);
  const repayments = links.filter((l) => l.relation === 'repayment');
  const disbursements = links.filter((l) => l.relation === 'disbursement');
  const funded = links.filter((l) => l.relation === 'funded_by');
  const counts = sumBy(repayments, (l) => l.to_id, () => 1n);
  // chỉ phiếu ĐÃ THỰC THI được tính là "có giải ngân": phiếu chưa thực thi / bị từ chối không làm "Đã giải ngân" về 0
  const disbursementCounts = sumBy(disbursements, (l) => l.to_id, () => 1n, paid);
  return {
    partners,
    companies,
    repaid: paidRepaymentParts(repayments, docs),
    repaidPlanned: sumBy(repayments, (l) => l.to_id, principalPartOf),
    disbursedPaid: sumBy(disbursements, (l) => l.to_id, allocationOf, paid),
    disbursedPlanned: sumBy(disbursements, (l) => l.to_id, allocationOf),
    disbursementCount: new Map([...disbursementCounts].map(([k, v]) => [k, Number(v)])),
    funded: sumBy(funded, (l) => l.to_id, allocationOf),
    repaymentCounts: new Map([...counts].map(([k, v]) => [k, Number(v)])),
  };
}

function buildLoan(b: LoanRaw, ctx: LoanCtx) {
  const id = String(b._id);
  const currency = String(b.currency ?? 'VND');
  const principal = toBigSafe(b.principal_minor);
  const repaidPrincipal = ctx.repaid.principal.get(id) ?? 0n;
  const dueDate = String(b.maturity_date ?? today());
  const outstanding = loanOutstandingOf(principal, repaidPrincipal, b.status ?? null);
  const status = loanStatusOf(b.status, outstanding, dueDate);
  const partner = b.partner_id ? (ctx.partners.get(String(b.partner_id)) ?? null) : null;
  const days = daysUntil(dueDate);
  const disbursedPlanned = ctx.disbursedPlanned.get(id) ?? 0n;
  const figures = disbursementFigures({
    principal,
    status: b.status ?? null,
    paid: ctx.disbursedPaid.get(id) ?? 0n,
    planned: disbursedPlanned,
    linkCount: ctx.disbursementCount.get(id) ?? 0,
  });
  const item: Record<string, unknown> = {
    _id: id,
    company_id: String(b.company_id),
    company_name: ctx.companies.get(String(b.company_id)) ?? '',
    code: String(b.code ?? ''),
    partner_id: b.partner_id ? String(b.partner_id) : null,
    partner,
    /* Tên ngân hàng lấy từ đối tác (v2 §5.1 — không đọc `bank_name` v1). */
    bank_name: partner?.name ?? '',
    credit_limit: wireMoney(toBigSafe(b.credit_limit_minor), currency),
    principal: wireMoney(principal, currency),
    outstanding: wireMoney(outstanding, currency),
    repaid: wireMoney(repaidPrincipal, currency),
    repaid_interest: wireMoney(ctx.repaid.interest.get(id) ?? 0n, currency),
    repaid_fee: wireMoney(ctx.repaid.fee.get(id) ?? 0n, currency),
    disbursed: wireMoney(figures.disbursed, currency),
    disbursement_planned: wireMoney(disbursedPlanned, currency),
    undisbursed: wireMoney(figures.undisbursed, currency),
    contract_no: b.contract_no ?? null,
    collateral: b.collateral ?? null,
    responsible: b.responsible ?? null,
    funded_by_total: wireMoney(ctx.funded.get(id) ?? 0n, currency),
    currency,
    interest_rate: String(b.interest_rate ?? '0'),
    term_months: b.term_months ?? null,
    payment_frequency: String(b.payment_frequency ?? 'maturity'),
    repayment_method: String(b.repayment_method ?? 'interest_only'),
    /** Lãi dự kiến tới đáo hạn (0 khi đã tất toán / chờ giải ngân / đã huỷ — dư nợ bằng 0). */
    interest_to_maturity: wireMoney(simpleInterest(outstanding, parseRate(b.interest_rate), Math.max(0, days)), currency),
    maturity_date: dueDate,
    next_due_date: b.next_due_date ? String(b.next_due_date) : dueDate,
    days_to_due: days,
    status,
    warning: loanWarningOf(status, dueDate),
    disbursed_at: b.disbursed_at ? isoOf(b.disbursed_at) : null,
    origin: {
      kind: b.origin?.kind ?? 'manual',
      run_id: b.origin?.run_id ? String(b.origin.run_id) : null,
      rule_code: b.origin?.rule_code ?? null,
    },
    repayment_count: ctx.repaymentCounts.get(id) ?? 0,
    attachment_count: Array.isArray(b.attachments) ? b.attachments.length : 0,
    note: b.note ?? null,
    created_at: b.created_at ? isoOf(b.created_at) : null,
    updated_at: b.updated_at ? isoOf(b.updated_at) : null,
  };
  return { item, status, outstanding, principal, disbursedPlanned, disbursedPaid: figures.disbursed, days };
}

export interface LoanListQuery {
  status?: string;
  partner_id?: string;
  company_id?: string;
  q?: string;
  summary?: 'true' | 'false';
  page?: number;
  limit?: number;
}

/** Trạng thái LƯU TRỰC TIẾP (không phụ thuộc dư nợ / hạn): lọc được ngay trong DB. Đang vay / quá hạn / tất toán suy ra khi đọc. */
const STORED_LOAN_STATUSES: ReadonlySet<string> = new Set(['pending_disbursement', 'cancelled', 'archived']);

/**
 * Điều kiện DB của danh sách: công ty (phạm vi), đối tác, trạng thái lưu trực tiếp, ô tìm (mã khoản hoặc tên ngân hàng).
 * Lọc TRƯỚC khi dựng khoản vay: tìm theo mã không còn phải dựng cả danh sách rồi mới lọc.
 */
async function loanListFilter(scope: ScopeLike, q: LoanListQuery): Promise<Record<string, unknown>> {
  const clauses: Record<string, unknown>[] = [];
  if (q.company_id) {
    assertInScope(scope.companyIds, q.company_id);
    clauses.push({ company_id: q.company_id });
  }
  if (q.partner_id) clauses.push({ partner_id: q.partner_id });
  if (q.status && STORED_LOAN_STATUSES.has(q.status)) clauses.push({ status: q.status });
  const needle = q.q?.trim();
  if (needle) {
    const rx = { $regex: escapeRegex(needle), $options: 'i' };
    // tên ngân hàng nằm ở đối tác (v2 §5.1): tìm đối tác trong phạm vi rồi khớp theo id
    const partners = await Models.Partner.find({ name: rx, ...scopeFilter({ companyIds: scope.companyIds }) } as never)
      .select({ _id: 1 })
      .lean<{ _id: unknown }[]>();
    clauses.push({ $or: [{ code: rx }, { partner_id: { $in: partners.map((p) => p._id) } }] });
  }
  return clauses.length ? { $and: clauses } : {};
}

/** Phần của một khoản cần cho tổng hợp dư nợ (kết quả của `buildLoan`). */
export interface LoanTotalsRow {
  item: Record<string, unknown>;
  status: LoanStatus;
  outstanding: bigint;
  days: number;
}

/** Dư nợ theo ngân hàng (US-LOAN-02): chỉ khoản đang vay / quá hạn; sắp theo dư nợ giảm dần. Tính trên MỌI khoản khớp bộ lọc. */
export function loanBankTotals(built: readonly LoanTotalsRow[]) {
  const map = new Map<string, { key: string; partner_id: string | null; bank_name: string; count: number; outstanding: bigint; due7: bigint; due30: bigint }>();
  for (const x of built) {
    if (!isLoanOnMaturityBoard(x.status)) continue;
    const partnerId = x.item.partner_id ? String(x.item.partner_id) : null;
    const bankName = String(x.item.bank_name ?? '');
    const key = partnerId ?? `name:${bankName}`;
    const row = map.get(key) ?? { key, partner_id: partnerId, bank_name: bankName, count: 0, outstanding: 0n, due7: 0n, due30: 0n };
    row.count += 1;
    row.outstanding += x.outstanding;
    if (x.days <= 7) row.due7 += x.outstanding;
    if (x.days <= 30) row.due30 += x.outstanding;
    map.set(key, row);
  }
  return [...map.values()]
    .sort((a, b) => (a.outstanding === b.outstanding ? 0 : a.outstanding > b.outstanding ? -1 : 1))
    .map((r) => ({
      key: r.key,
      partner_id: r.partner_id,
      bank_name: r.bank_name,
      count: r.count,
      outstanding: wireMoney(r.outstanding),
      due7: wireMoney(r.due7),
      due30: wireMoney(r.due30),
    }));
}

/** Cỡ trang mặc định của danh sách khoản vay (trần 1.000 — `loanListQuery`). */
const LOAN_LIST_PAGE_SIZE = 50;

/**
 * Danh sách nợ ngân hàng. Khoản chờ giải ngân nằm trong danh sách ("Sắp giải ngân") nhưng KHÔNG vào dư nợ.
 * Lọc trong DB; `items` chỉ gồm MỘT TRANG (`page`/`limit`) để phản hồi và bảng không phình theo số khoản;
 * tổng, số khoản (`total`/`totals.count`) và `by_bank` luôn tính trên MỌI khoản khớp bộ lọc.
 * `summary=true` bỏ `items` (chỉ tổng hợp) cho màn chỉ cần số liệu.
 */
export async function listLoans(scope: ScopeLike, q: LoanListQuery) {
  const filter = await loanListFilter(scope, q);
  // không kéo lịch sử thay đổi (có thể dài) — danh sách không dùng
  const rows = await scopedFind<LoanRaw>(Models.BankDebt, { companyIds: scope.companyIds }, filter, {
    sort: { maturity_date: 1, _id: 1 },
    projection: { history: 0 },
  });
  const ctx = await loanContext(rows);
  let built = rows.map((b) => buildLoan(b, ctx));
  // trạng thái suy ra (đang vay / quá hạn / tất toán) chỉ biết sau khi tính dư nợ ⇒ lọc ở đây
  if (q.status && !STORED_LOAN_STATUSES.has(q.status)) built = built.filter((x) => x.status === q.status);
  let outstanding = 0n;
  let pendingCount = 0;
  let pendingAmount = 0n;
  for (const x of built) {
    if (x.status === 'active' || x.status === 'overdue') outstanding += x.outstanding;
    if (x.status === 'pending_disbursement') {
      pendingCount += 1;
      // v2 §10.2: "Chờ giải ngân" = khoản đã lập & liên kết phiếu thu nhưng TIỀN CHƯA VỀ ⇒ gốc − đã giải ngân thực tế
      // (không trừ phần mới "gán phiếu thu": khoản đã gán vẫn đang chờ giải ngân).
      const notYetReceived = x.principal - x.disbursedPaid;
      pendingAmount += notYetReceived > 0n ? notYetReceived : 0n;
    }
  }
  const page = q.page ?? 1;
  const limit = q.limit ?? LOAN_LIST_PAGE_SIZE;
  return {
    items: q.summary === 'true' ? [] : built.slice((page - 1) * limit, page * limit).map((x) => x.item),
    total: built.length,
    page,
    limit,
    totals: {
      outstanding: wireMoney(outstanding),
      count: built.length,
      pending_count: pendingCount,
      pending_amount: wireMoney(pendingAmount),
    },
    by_bank: loanBankTotals(built),
  };
}

/** Dòng liên kết của khoản vay (phiếu, số tiền, phần gốc/lãi/phí, trạng thái phiếu). */
export function loanLinkRow(l: LinkRecord, docs: Map<string, DocRef>) {
  const doc = docs.get(l.from_id);
  return {
    _id: l._id,
    link_id: l._id,
    relation: l.relation,
    document_id: l.from_id,
    document_code: doc?.code ?? '',
    document_title: doc?.title ?? '',
    document_kind: doc?.kind ?? '',
    document_status: doc?.status ?? 'unknown',
    executed: doc?.status === 'paid',
    amount: wireMoney(allocationOf(l)),
    principal: wireMoney(principalPartOf(l)),
    interest: wireMoney(l.split?.interest ?? 0n),
    fee: wireMoney(l.split?.fee ?? 0n),
    origin: l.origin,
    rule_code: l.rule_code,
    linked_at: l.created_at ? isoOf(l.created_at) : null,
    note: l.note,
  };
}

/** Chi tiết khoản vay + chuỗi liên quan (US-AUTO-08): phiếu chi được tài trợ, phiếu thu giải ngân, phiếu trả nợ. */
export async function getLoanDetail(scope: ScopeLike, id: string) {
  const b = await loadLoanOrFail(id);
  assertInScope(scope.companyIds, String(b.company_id));
  const ctx = await loanContext([b]);
  const { item } = buildLoan(b, ctx);
  const links = await loadLinks({ to_type: 'bank_debt', to_ids: [id] });
  const docs = await loadDocs(links.map((l) => l.from_id));
  const byRelation = (rel: string) => links.filter((l) => l.relation === rel).map((l) => loanLinkRow(l, docs));
  const funded = byRelation('funded_by');
  const disbursements = byRelation('disbursement');
  const repayments = byRelation('repayment');
  return {
    ...item,
    funded_by_links: funded,
    disbursement_links: disbursements,
    chain: { funded_by: funded, disbursements, repayments },
    history: b.history ?? [],
    /** Chứng từ nhúng (route chuẩn hoá thành đường dẫn tải). */
    attachments: b.attachments ?? [],
  };
}

/** Đọc trạng thái hiện hành (có dư nợ từ liên kết). */
async function currentStatus(b: LoanRaw): Promise<LoanStatus> {
  const outstanding = await loanOutstanding(String(b._id));
  return loanStatusOf(b.status, outstanding, String(b.maturity_date ?? today()));
}

/** Ghi lại `outstanding_minor` (cache đọc nhanh) theo giá trị suy ra. */
async function refreshLoanCache(loanId: string): Promise<void> {
  const outstanding = await loanOutstanding(loanId);
  await Models.BankDebt.updateOne({ _id: loanId } as never, { $set: { outstanding_minor: outstanding } } as never).exec();
}

interface LoanInsert {
  companyId: string;
  partner: PartnerRef;
  actor: LoanActor;
  principal: bigint;
  currency: string;
  creditLimit: bigint;
  rate: string;
  maturity: string;
  termMonths: number | null;
  frequency: string;
  method: string;
  note: string | null;
  status: 'active' | 'pending_disbursement';
  disbursedAt: Date | null;
  origin: { kind: 'manual' | 'automation'; run_id: string | null; rule_code: string | null };
  contractNo?: string | null;
  collateral?: string | null;
  responsible?: string | null;
  ip?: string | null;
  importRow?: boolean;
  /** Khoá chống gửi lặp (ghi vào lịch sử để tra lại). */
  requestId?: string | null;
}

/** Ghi khoản vay mới (dùng chung cho tạo tay, nhập Excel, và quy tắc tự động). */
async function insertLoan(input: LoanInsert): Promise<{ _id: string; code: string }> {
  const code = await nextSequentialCode('NHD');
  const history = buildHistoryEntry({
    action: 'create',
    actor: { user_id: input.actor.user_id, role: input.actor.role ?? null, name: input.actor.name ?? null },
    to: null,
    ip: input.ip ?? null,
    request_id: input.requestId ?? null,
    fields: { bank_name: input.partner.name, amount_minor: input.principal.toString(), status: input.status, origin: input.origin.kind, import: Boolean(input.importRow) },
  });
  const outstanding = input.status === 'pending_disbursement' ? 0n : input.principal;
  const created = await Models.BankDebt.create({
    code,
    company_id: input.companyId,
    /* Bản sao hiển thị do server điền từ đối tác (model còn bắt buộc v1); đọc luôn lấy theo partner_id. */
    bank_name: input.partner.name,
    partner_id: input.partner._id,
    principal_minor: input.principal,
    credit_limit_minor: input.creditLimit,
    outstanding_minor: outstanding,
    amount: { minor: input.principal, currency: input.currency, decimals: 0 },
    currency: input.currency,
    interest_rate: input.rate,
    term_months: input.termMonths,
    payment_frequency: input.frequency,
    repayment_method: input.method,
    maturity_date: input.maturity,
    next_due_date: input.maturity,
    status: input.status,
    disbursed_at: input.disbursedAt,
    origin: { kind: input.origin.kind, run_id: input.origin.run_id, rule_code: input.origin.rule_code },
    contract_no: input.contractNo ?? null,
    collateral: input.collateral ?? null,
    responsible: input.responsible ?? null,
    note: input.note,
    created_by: input.actor.user_id,
    history: [history],
  } as never);
  await emitDomainEvent({
    type: 'loan.created',
    company_id: input.companyId,
    subject_type: 'bank_debt',
    subject_id: String(created._id),
    payload: {
      code,
      bank_name: input.partner.name,
      principal_minor: input.principal,
      partner_id: input.partner._id,
      status: input.status,
      origin: input.origin.kind,
      rule_code: input.origin.rule_code,
      import: Boolean(input.importRow),
    },
    actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
  });
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
    action: 'bank_debt.create',
    subject: { type: 'bank_debt', id: String(created._id), code },
    company_id: input.companyId,
    ip: input.ip ?? null,
  });
  return { _id: String(created._id), code };
}

/** Tạo khoản vay thủ công: đã giải ngân (đang vay). Ngân hàng cho vay bắt buộc, đúng công ty, đang hoạt động. */
export async function createLoan(actor: DebtActor, scope: ScopeLike, body: LoanCreateBody, meta: ReqMeta): Promise<{ _id: string; code: string }> {
  const companyId = body.company_id ?? actor.company_id;
  if (!companyId) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Chưa chọn công ty' });
  assertInScope(scope.companyIds, companyId);
  // Idempotency: gửi lại cùng request_id (retry sau timeout) ⇒ trả lại khoản đã tạo, không tạo trùng.
  if (body.request_id) {
    const prev = await Models.BankDebt.findOne({ company_id: companyId, 'history.request_id': body.request_id } as never)
      .select({ _id: 1, code: 1 })
      .lean<{ _id: unknown; code?: string } | null>();
    if (prev) return { _id: String(prev._id), code: String(prev.code ?? '') };
  }
  const principal = positiveMinor(body.amount.amount_minor, 'amount', 'Số tiền vay phải lớn hơn 0');
  const partner = await assertPartner(body.partner_id, companyId, LOAN_PARTNER_TYPES, { usage: 'Khoản nợ ngân hàng' });
  const { status, disbursedDate } = manualLoanDisbursement(body, today());
  assertMaturityAfterDisbursement(body.maturity_date, disbursedDate);
  return insertLoan({
    companyId,
    partner,
    actor,
    principal,
    currency: body.amount.currency,
    creditLimit: body.credit_limit ? toBigSafe(body.credit_limit.amount_minor) : 0n,
    rate: body.interest_rate,
    maturity: body.maturity_date,
    termMonths: body.term_months ?? null,
    frequency: body.payment_frequency,
    method: body.repayment_method,
    contractNo: body.contract_no || null,
    collateral: body.collateral || null,
    responsible: body.responsible || null,
    note: body.note ?? null,
    status,
    disbursedAt: disbursedDate ? businessDateStart(disbursedDate) : null,
    origin: { kind: 'manual', run_id: null, rule_code: null },
    ip: meta.ip ?? null,
    requestId: body.request_id ?? null,
  });
}

/** Nhập khoản vay theo lô (LOAN-05). Đối tác chọn bằng ID/mã (DT-…), KHÔNG khớp theo tên; dòng lỗi báo riêng. */
export async function importLoans(actor: DebtActor, scope: ScopeLike, companyIdIn: string | undefined, rows: unknown[], meta: ReqMeta) {
  const companyId = companyIdIn ?? actor.company_id;
  if (!companyId) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Chưa chọn công ty' });
  assertInScope(scope.companyIds, companyId);
  const created: { code: string; bank_name: string }[] = [];
  const failed: { row: number; error: string }[] = [];
  /* Dòng trùng trong cùng lô (cùng ngân hàng, gốc, hạn) — bỏ qua, không tạo lại. */
  const seenInBatch = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const parsed = importRowParse(rows[i]);
    if (!parsed.ok) {
      failed.push({ row: i + 1, error: parsed.error });
      continue;
    }
    const r: LoanImportRow = parsed.data;
    try {
      const partnerId = r.partner_id ?? (await partnerIdByCode(r.partner_code ?? '', companyId));
      const partner = await assertPartner(partnerId, companyId, LOAN_PARTNER_TYPES, { usage: 'Khoản nợ ngân hàng' });
      const principal = positiveMinor(r.amount.amount_minor, 'amount', 'Số tiền vay phải lớn hơn 0');
      // Chống trùng khi nhập lại cùng file / retry: cùng công ty, ngân hàng, gốc, hạn (khoản chưa huỷ) ⇒ bỏ qua và báo.
      const key = `${partner._id}|${principal.toString()}|${r.maturity_date}`;
      if (seenInBatch.has(key)) throw new ApiError({ code: 'FG-VAL-001', detail: 'Trùng với một dòng khác trong cùng lô — bỏ qua' });
      seenInBatch.add(key);
      const dup = await Models.BankDebt.findOne({
        company_id: companyId,
        partner_id: partner._id,
        principal_minor: principal,
        maturity_date: r.maturity_date,
        status: { $ne: 'cancelled' },
      } as never)
        .select({ code: 1 })
        .lean<{ code?: string } | null>();
      if (dup) throw new ApiError({ code: 'FG-VAL-001', detail: `Trùng khoản ${String(dup.code ?? '')} (cùng ngân hàng, gốc, hạn) — bỏ qua` });
      const res = await insertLoan({
        companyId,
        partner,
        actor,
        principal,
        currency: r.amount.currency,
        creditLimit: r.credit_limit ? toBigSafe(r.credit_limit.amount_minor) : 0n,
        rate: r.interest_rate,
        maturity: r.maturity_date,
        termMonths: r.term_months ?? null,
        frequency: r.payment_frequency,
        method: r.repayment_method,
        contractNo: r.contract_no || null,
        collateral: r.collateral || null,
        responsible: r.responsible || null,
        note: r.note ?? null,
        status: 'active',
        /* Khoản nhập lô là dữ liệu đã có sẵn — không suy ngày giải ngân (để trống). */
        disbursedAt: null,
        origin: { kind: 'manual', run_id: null, rule_code: null },
        ip: meta.ip ?? null,
        importRow: true,
      });
      created.push({ code: res.code, bank_name: partner.name });
    } catch (err) {
      failed.push({ row: i + 1, error: errorText(err) });
    }
  }
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'bank_debt.import',
    subject: { type: 'bank_debt', id: null, code: `${created.length} dòng` },
    company_id: companyId,
    diff_fields: { total_rows: rows.length, inserted: created.length, failed: failed.length },
    ip: meta.ip ?? null,
  });
  return { inserted: created.length, failed, total_rows: rows.length, created };
}

function importRowParse(raw: unknown): { ok: true; data: LoanImportRow } | { ok: false; error: string } {
  const parsed = loanImportRow.safeParse(raw);
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, error: parsed.error.issues[0]?.message ?? 'Dữ liệu không hợp lệ' };
}

async function partnerIdByCode(code: string, companyId: string): Promise<string> {
  const p = await Models.Partner.findOne({ code: code.trim(), company_id: companyId } as never).select({ _id: 1 }).lean<{ _id: unknown } | null>();
  if (!p) throw new ApiError({ code: 'FG-PARTNER-001', detail: `Không tìm thấy đối tác mã "${code}" trong công ty — không khớp theo tên` });
  return String(p._id);
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const first = err.errors ? Object.values(err.errors)[0] : undefined;
    return err.detail ?? first ?? err.message;
  }
  return (err as Error).message ?? 'Lỗi không xác định';
}

/** Sửa khoản vay. Đổi ngân hàng bị chặn khi đã có liên kết; gốc không nhỏ hơn đã giải ngân / đã gán trả gốc. */
export async function updateLoan(actor: DebtActor, scope: ScopeLike, id: string, body: LoanUpdateBody, meta: ReqMeta): Promise<{ changed: string[] }> {
  const b = await loadLoanOrFail(id);
  assertInScope(scope.companyIds, String(b.company_id));
  if (b.status === 'cancelled' || b.status === 'archived') {
    throw new ApiError({ code: 'FG-WF-001', detail: `Khoản đã ${b.status === 'cancelled' ? 'huỷ' : 'lưu trữ'} — không sửa` });
  }
  const companyId = String(b.company_id);
  const links = await loadLinks({ to_type: 'bank_debt', to_ids: [id] });
  // Sức chứa giữ bởi liên kết còn hiệu lực (phiếu đã huỷ / từ chối không giữ — v2 §9.2).
  const reserved = await reservingLinks(links);
  const disbursedPlanned = reserved.filter((l) => l.relation === 'disbursement').reduce((s, l) => s + allocationOf(l), 0n);
  const repaidPlanned = reserved.filter((l) => l.relation === 'repayment').reduce((s, l) => s + principalPartOf(l), 0n);
  const set: Record<string, unknown> = { updated_at: new Date() };
  // Đổi giải ngân tay: đang vay ⇄ chờ giải ngân. Về chờ chỉ khi chưa có liên kết nào (chưa có tiền); sang đang vay
  // chỉ khi chưa gán phiếu thu giải ngân (tiền về theo phiếu thu thì để phiếu thu chuyển trạng thái).
  const toggle = loanDisbursementToggle(b.status, body.disbursed);
  let disbursedDate: string | null = b.disbursed_at ? vnDate(b.disbursed_at) : null;
  if (toggle === 'to_pending') {
    if (links.length) throw new ApiError({ code: 'FG-WF-001', detail: 'Khoản đã có liên kết — không chuyển về chờ giải ngân' });
    set.status = 'pending_disbursement';
    set.disbursed_at = null;
    disbursedDate = null;
  } else if (toggle === 'to_active') {
    if (links.some((l) => l.relation === 'disbursement')) {
      throw new ApiError({ code: 'FG-WF-001', detail: 'Khoản đã gán phiếu thu giải ngân — tiền về theo phiếu thu, không đánh dấu tay' });
    }
    disbursedDate = body.disbursed_date ?? today();
    set.status = 'active';
    set.disbursed_at = businessDateStart(disbursedDate);
  }
  if (body.maturity_date !== undefined || toggle === 'to_active') {
    assertMaturityAfterDisbursement(body.maturity_date ?? String(b.maturity_date ?? ''), disbursedDate);
  }

  if (body.partner_id !== undefined && body.partner_id !== String(b.partner_id ?? '')) {
    if (links.length) throw new ApiError({ code: 'FG-PARTNER-003', detail: 'Khoản đã có liên kết giải ngân / trả nợ — không đổi ngân hàng' });
    const partner = await assertPartner(body.partner_id, companyId, LOAN_PARTNER_TYPES, { usage: 'Khoản nợ ngân hàng' });
    set.partner_id = partner._id;
    set.bank_name = partner.name;
  }
  if (body.amount) {
    const principal = positiveMinor(body.amount.amount_minor, 'amount', 'Số tiền vay phải lớn hơn 0');
    if (principal < disbursedPlanned) {
      throw new ApiError({ code: 'FG-LINK-002', detail: 'Gốc không được nhỏ hơn tổng đã gán giải ngân', errors: { amount: 'Nhỏ hơn tổng giải ngân' } });
    }
    if (principal < repaidPlanned) {
      throw new ApiError({ code: 'FG-LINK-002', detail: 'Gốc không được nhỏ hơn số gốc đã gán trả nợ', errors: { amount: 'Nhỏ hơn số gốc đã trả' } });
    }
    const currency = body.amount.currency ?? String(b.currency ?? 'VND');
    set.principal_minor = principal;
    set.amount = { minor: principal, currency, decimals: 0 };
    set.currency = currency;
  }
  if (body.credit_limit !== undefined) set.credit_limit_minor = body.credit_limit ? toBigSafe(body.credit_limit.amount_minor) : 0n;
  if (body.interest_rate !== undefined) set.interest_rate = body.interest_rate;
  if (body.term_months !== undefined) set.term_months = body.term_months ?? null;
  if (body.payment_frequency !== undefined) set.payment_frequency = body.payment_frequency;
  if (body.repayment_method !== undefined) set.repayment_method = body.repayment_method;
  if (body.maturity_date !== undefined) {
    set.maturity_date = body.maturity_date;
    set.next_due_date = body.maturity_date;
  }
  if (body.contract_no !== undefined) set.contract_no = body.contract_no || null;
  if (body.collateral !== undefined) set.collateral = body.collateral || null;
  if (body.responsible !== undefined) set.responsible = body.responsible || null;
  if (body.note !== undefined) set.note = body.note || null;

  // Lịch sử trước → sau cho từng trường thực sự đổi (v2 §2.3: ai, khi nào, trước → sau).
  const rawB = b as unknown as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of LOAN_TRACKED) {
    before[k] = rawB[k];
    after[k] = k in set ? set[k] : rawB[k];
  }
  const changes = changesOf(before, after);
  if (toggle) changes.status = { from: b.status ?? null, to: String(set.status) };
  const changed = Object.keys(changes);
  if (!changed.length) return { changed };
  const history = buildHistoryEntry({
    action: 'update',
    actor: { user_id: actor.user_id, role: actor.role ?? null, name: actor.name ?? null },
    to: null,
    ip: meta.ip ?? null,
    request_id: meta.request_id ?? null,
    fields: { changed, changes },
  });
  await Models.BankDebt.updateOne({ _id: id } as never, { $set: set, $push: { history } } as never).exec();
  await refreshLoanCache(id);
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'bank_debt.update',
    subject: { type: 'bank_debt', id, code: String(b.code ?? '') },
    company_id: companyId,
    diff_fields: { changes },
    ip: meta.ip ?? null,
  });
  return { changed };
}

/**
 * Xoá khoản vay chỉ khi CHƯA PHÁT SINH TIỀN và chưa từng có liên kết (v2 §2.3: không xoá vật lý đối tượng đã phát sinh tiền).
 * Khoản đang vay / đã tất toán / đã huỷ / có liên kết (kể cả đã gỡ — giữ làm lịch sử) ⇒ không xoá; dùng Huỷ hoặc Lưu trữ.
 */
export async function assertLoanDeletable(scope: ScopeLike, b: LoanRaw): Promise<void> {
  assertInScope(scope.companyIds, String(b.company_id));
  if (b.status !== 'pending_disbursement') {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Khoản đã đang vay hoặc đã xử lý — không xoá (chờ giải ngân thì dùng Huỷ; đã tất toán thì Lưu trữ)' });
  }
  const linked = await Models.BusinessLink.exists({
    $or: [{ to_type: 'bank_debt', to_id: b._id }, { from_type: 'bank_debt', from_id: b._id }],
  } as never);
  if (linked) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Khoản đã có liên kết (kể cả đã gỡ) — không xoá; dùng Huỷ để giữ lịch sử' });
  }
}

/** Xoá bản ghi khoản vay (sau `assertLoanDeletable`). Không có liên kết nào để xoá theo; lịch sử của khoản đi theo bản ghi. */
export async function deleteLoanRecord(id: string): Promise<void> {
  await Models.BankDebt.deleteOne({ _id: id } as never).exec();
}

/** Gán một phiếu thu làm GIẢI NGÂN của khoản vay (từ phía khoản vay hoặc phía phiếu thu). */
export async function assignDisbursement(
  actor: DebtActor,
  scope: ScopeLike,
  loanId: string,
  body: { document_id: string; amount_minor?: string; note?: string },
  meta: ReqMeta,
): Promise<{ _id: string }> {
  const b = await loadLoanOrFail(loanId);
  assertInScope(scope.companyIds, String(b.company_id));
  const status = await currentStatus(b);
  if (status === 'cancelled' || status === 'archived' || status === 'settled') {
    throw new ApiError({ code: 'FG-WF-001', detail: `Khoản đang ở trạng thái ${status === 'settled' ? 'tất toán' : status === 'archived' ? 'lưu trữ' : 'đã huỷ'} — không gán giải ngân` });
  }
  if (!b.partner_id) throw new ApiError({ code: 'FG-PARTNER-001', detail: 'Khoản vay chưa gắn ngân hàng cho vay' });
  const doc = (await loadDocs([body.document_id])).get(body.document_id);
  if (!doc) throw new ApiError({ code: 'FG-VAL-001', errors: { document_id: 'Không tìm thấy hồ sơ' } });
  assertInScope(scope.companyIds, doc.company_id);
  if (doc.kind !== 'income') throw new ApiError({ code: 'FG-LINK-001', detail: 'Chỉ gán phiếu thu làm giải ngân' });
  assertLinkableDocStatus(doc.status);
  if (doc.partner_id !== String(b.partner_id)) throw new ApiError({ code: 'FG-LINK-001', detail: 'Phiếu thu phải do đúng ngân hàng cho vay chuyển tiền' });

  let amount: bigint;
  if (body.amount_minor !== undefined) {
    amount = positiveMinor(body.amount_minor, 'amount_minor', 'Số tiền giải ngân phải lớn hơn 0');
  } else {
    const docUsed = await documentAllocatedTotalOf(doc._id);
    const links = await reservingLinks(await loadLinks({ to_type: 'bank_debt', to_ids: [loanId], relations: ['disbursement'] }));
    const planned = links.reduce((s, l) => s + allocationOf(l), 0n);
    amount = defaultAllocation(doc.amount_minor - docUsed, toBigSafe(b.principal_minor) - planned);
  }
  const link = await createLink({
    from: { type: 'document', id: doc._id },
    to: { type: 'bank_debt', id: loanId },
    relation: 'disbursement',
    amount_minor: amount,
    note: body.note ?? null,
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    scopeCompanyIds: scope.companyIds,
    request_id: meta.request_id ?? null,
    ip: meta.ip ?? null,
  });
  // Phiếu thu đã thực thi ⇒ khoản vay chuyển "Đang vay" ngay (v2 §10.2).
  if (doc.status === 'paid') await activateLoanOnDisbursement(loanId, actor);
  await refreshLoanCache(loanId);
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'bank_debt.disburse_link',
    subject: { type: 'bank_debt', id: loanId, code: String(b.code ?? '') },
    company_id: String(b.company_id),
    diff_fields: { document_id: doc._id, amount_minor: amount.toString() },
    ip: meta.ip ?? null,
  });
  return { _id: link._id };
}

/** Gán một phiếu chi trả nợ (quan hệ `repayment`). Tách gốc / lãi / phí tuỳ chọn. */
export async function assignRepayment(
  actor: DebtActor,
  scope: ScopeLike,
  loanId: string,
  body: { document_id: string; amount_minor?: string; split?: { principal?: string; interest?: string; fee?: string }; note?: string },
  meta: ReqMeta,
): Promise<{ _id: string }> {
  const b = await loadLoanOrFail(loanId);
  assertInScope(scope.companyIds, String(b.company_id));
  const status = await currentStatus(b);
  if (status !== 'active' && status !== 'overdue') {
    throw new ApiError({ code: 'FG-WF-001', detail: 'Chỉ trả nợ khoản đang vay (chưa tất toán / chưa huỷ / chưa giải ngân xong)' });
  }
  if (!b.partner_id) throw new ApiError({ code: 'FG-PARTNER-001', detail: 'Khoản vay chưa gắn ngân hàng cho vay' });
  const doc = (await loadDocs([body.document_id])).get(body.document_id);
  if (!doc) throw new ApiError({ code: 'FG-VAL-001', errors: { document_id: 'Không tìm thấy hồ sơ' } });
  assertInScope(scope.companyIds, doc.company_id);
  if (doc.kind !== 'spend') throw new ApiError({ code: 'FG-LINK-001', detail: 'Chỉ gán phiếu chi làm trả nợ' });
  assertLinkableDocStatus(doc.status);
  if (doc.partner_id !== String(b.partner_id)) throw new ApiError({ code: 'FG-LINK-001', detail: 'Phiếu chi phải trả đúng ngân hàng cho vay' });

  const split = body.split
    ? {
        principal: toBigSafe(body.split.principal ?? '0'),
        interest: toBigSafe(body.split.interest ?? '0'),
        fee: toBigSafe(body.split.fee ?? '0'),
      }
    : null;
  // Số tiền tường minh (nếu có) — khi có tách, createLink sẽ kiểm tổng gốc + lãi + phí = số tiền.
  const explicit = body.amount_minor !== undefined ? positiveMinor(body.amount_minor, 'amount_minor', 'Số tiền trả nợ phải lớn hơn 0') : undefined;
  let amount: bigint | undefined = explicit;
  if (!split && amount === undefined) {
    const docUsed = await documentAllocatedTotalOf(doc._id);
    const links = await reservingLinks(await loadLinks({ to_type: 'bank_debt', to_ids: [loanId], relations: ['repayment'] }));
    const repaidPlanned = links.reduce((s, l) => s + principalPartOf(l), 0n);
    amount = defaultAllocation(doc.amount_minor - docUsed, toBigSafe(b.principal_minor) - repaidPlanned);
  }
  const link = await createLink({
    from: { type: 'document', id: doc._id },
    to: { type: 'bank_debt', id: loanId },
    relation: 'repayment',
    amount_minor: amount ?? null,
    split,
    note: body.note ?? null,
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    scopeCompanyIds: scope.companyIds,
    request_id: meta.request_id ?? null,
    ip: meta.ip ?? null,
  });
  // Phiếu chi đã thực thi ⇒ kiểm tra tất toán ngay (loan.settled, best-effort).
  if (doc.status === 'paid') {
    await emitLoanSettledAfterPayment(doc._id, { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null }).catch(() => []);
  }
  await refreshLoanCache(loanId);
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'bank_debt.repay',
    subject: { type: 'bank_debt', id: loanId, code: String(b.code ?? '') },
    company_id: String(b.company_id),
    diff_fields: { document_id: doc._id, amount_minor: link.amount_minor?.toString() ?? null },
    ip: meta.ip ?? null,
  });
  return { _id: link._id };
}

/** Gỡ liên kết giải ngân / trả nợ của đúng khoản vay này (đánh dấu removed, có lý do). */
export async function unassignLoanLink(
  actor: DebtActor,
  scope: ScopeLike,
  loanId: string,
  linkId: string,
  relation: 'disbursement' | 'repayment' | 'funded_by',
  reason: string,
  meta: ReqMeta,
): Promise<void> {
  const b = await loadLoanOrFail(loanId);
  assertInScope(scope.companyIds, String(b.company_id));
  const link = validIds([linkId]).length ? await Models.BusinessLink.findById(linkId).lean<Record<string, unknown> | null>() : null;
  if (!link || link.relation !== relation || link.to_type !== 'bank_debt' || String(link.to_id) !== loanId) {
    throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy liên kết' });
  }
  // v2 §11.2: liên kết do quy trình tự động tạo không gỡ tay (ngoại lệ `funded_by`, §11.5) — đổi lựa chọn vay trên phiếu
  if (link.origin === 'automation' && relation !== 'funded_by') {
    throw new ApiError({ code: 'FG-WF-005', detail: 'Liên kết do quy trình tự động tạo — không gỡ tay. Đổi lựa chọn vay trên phiếu để quy trình cập nhật.' });
  }
  // Phiếu đã thực thi (tiền đã về / đã trả): không gỡ giải ngân / trả nợ — tránh lệch dư nợ với sổ cái.
  // `funded_by` (chi bằng vốn vay) được gỡ thủ công khi cần (v2 §11.5 ngoại lệ).
  if (relation !== 'funded_by') {
    const doc = (await loadDocs([String(link.from_id)])).get(String(link.from_id));
    if (doc?.status === 'paid') {
      throw new ApiError({ code: 'FG-WF-001', detail: 'Phiếu đã thực thi (tiền đã thu/chi) — không gỡ liên kết này; cần bút toán điều chỉnh' });
    }
  }
  // v2 §11.4 (b): giải ngân tới khoản vay ĐANG CHỌN trên phiếu thu — cùng quy tắc với gỡ từ phiếu (routes/documents.ts).
  if (relation === 'disbursement') {
    const src = validIds([link.from_id]).length
      ? await Models.Document.findById(String(link.from_id)).select({ options: 1 }).lean<{ options?: { loan?: StoredLoanChoice | null } | null } | null>()
      : null;
    assertDisbursementNotChosenLoan(link, src?.options?.loan);
  }
  await removeLink({
    link_id: linkId,
    reason,
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    scopeCompanyIds: scope.companyIds,
    request_id: meta.request_id ?? null,
    ip: meta.ip ?? null,
  });
  await refreshLoanCache(loanId);
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: relation === 'repayment' ? 'bank_debt.unrepay' : 'bank_debt.unlink',
    subject: { type: 'bank_debt', id: loanId, code: String(b.code ?? '') },
    company_id: String(b.company_id),
    diff_fields: { link_id: linkId, relation, reason },
    ip: meta.ip ?? null,
  });
}

/** Ứng viên phiếu cho giải ngân (phiếu thu) hoặc trả nợ (phiếu chi) — cùng công ty, cùng ngân hàng. */
export async function loanCandidates(scope: ScopeLike, loanId: string, relation: 'disbursement' | 'repayment', q: string | undefined) {
  const b = await loadLoanOrFail(loanId);
  assertInScope(scope.companyIds, String(b.company_id));
  if (!b.partner_id) return [];
  return documentCandidates({
    companyId: String(b.company_id),
    partnerId: String(b.partner_id),
    kind: relation === 'repayment' ? 'spend' : 'income',
    q,
    forType: 'bank_debt',
    forId: loanId,
    relation,
  });
}

/** Lưu trữ khoản đã tất toán (trạng thái `archived`). */
export async function archiveLoan(actor: DebtActor, scope: ScopeLike, loanId: string, meta: ReqMeta): Promise<void> {
  const b = await loadLoanOrFail(loanId);
  assertInScope(scope.companyIds, String(b.company_id));
  if ((await currentStatus(b)) !== 'settled') throw new ApiError({ code: 'FG-WF-001', detail: 'Chỉ lưu trữ khoản đã tất toán' });
  await Models.BankDebt.updateOne(
    { _id: loanId, status: { $ne: 'archived' } } as never,
    { $set: { status: 'archived', updated_at: new Date() }, $push: { history: buildHistoryEntry({ action: 'archive', actor: { user_id: actor.user_id, role: actor.role ?? null, name: actor.name ?? null }, to: 'archived', ip: meta.ip ?? null }) } } as never,
  ).exec();
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'bank_debt.archive',
    subject: { type: 'bank_debt', id: loanId, code: String(b.code ?? '') },
    company_id: String(b.company_id),
    ip: meta.ip ?? null,
  });
}

/**
 * Huỷ khoản đang CHỜ GIẢI NGÂN (v2 §10.2, R6): gỡ mọi liên kết còn hiệu lực (có lý do), chuyển `cancelled`.
 * Không huỷ nếu đã có tiền giải ngân về (đã thực thi) — khi đó chỉ cảnh báo, xử lý thủ công.
 */
export async function cancelPendingLoan(
  actor: LoanActor,
  scope: ScopeLike | null,
  loanId: string,
  reason: string,
  meta: ReqMeta = {},
): Promise<{ cancelled: true; code: string }> {
  const b = await loadLoanOrFail(loanId);
  if (scope) assertInScope(scope.companyIds, String(b.company_id));
  if (b.status !== 'pending_disbursement') throw new ApiError({ code: 'FG-WF-001', detail: 'Chỉ huỷ khoản đang chờ giải ngân' });
  const links = await loadLinks({ to_type: 'bank_debt', to_ids: [loanId] });
  const docs = await loadDocs(links.map((l) => l.from_id));
  if (links.some((l) => l.relation === 'disbursement' && docs.get(l.from_id)?.status === 'paid')) {
    throw new ApiError({ code: 'FG-WF-001', detail: 'Đã có tiền giải ngân về tài khoản — không huỷ; xử lý thủ công' });
  }
  // Còn phiếu giải ngân / liên kết tới phiếu CHƯA huỷ / từ chối ⇒ chưa được huỷ (v2 §10.2, §11.4): tiền về sau sẽ mồ côi.
  const live = links.filter((l) => {
    const st = docs.get(l.from_id)?.status;
    return Boolean(st) && !UNLINKABLE_DOC_STATUSES.includes(String(st));
  });
  if (live.length) {
    const codes = live.map((l) => docs.get(l.from_id)?.code ?? String(l.from_id)).join(', ');
    throw new ApiError({
      code: 'FG-WF-001',
      detail: `Còn phiếu chưa huỷ / chưa từ chối đang liên kết tới khoản này (${codes}) — gỡ liên kết hoặc huỷ phiếu trước`,
    });
  }
  for (const l of links) {
    await removeLink({
      link_id: l._id,
      reason: `Huỷ khoản vay ${String(b.code ?? '')}: ${reason}`,
      actor,
      scopeCompanyIds: scope ? scope.companyIds : null,
      request_id: meta.request_id ?? null,
      ip: meta.ip ?? null,
    });
  }
  await Models.BankDebt.updateOne(
    { _id: loanId, status: 'pending_disbursement' } as never,
    {
      $set: { status: 'cancelled', outstanding_minor: 0n, updated_at: new Date() },
      $push: { history: buildHistoryEntry({ action: 'cancel', actor: { user_id: actor.user_id, role: actor.role ?? null, name: actor.name ?? null }, to: 'cancelled', reason, ip: meta.ip ?? null }) },
    } as never,
  ).exec();
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'bank_debt.cancel',
    subject: { type: 'bank_debt', id: loanId, code: String(b.code ?? '') },
    company_id: String(b.company_id),
    diff_fields: { reason },
    ip: meta.ip ?? null,
  });
  return { cancelled: true, code: String(b.code ?? '') };
}

/**
 * Chuyển `pending_disbursement` → `active` khi có phiếu thu giải ngân ĐÃ THỰC THI (v2 §10.2, §11.4).
 * Gốc = số thực thu (tổng các phiếu giải ngân đã thực thi). Trả về true nếu đã chuyển.
 */
export async function activateLoanOnDisbursement(loanId: string, actor: LinkActor | LoanActor | null = null): Promise<boolean> {
  if (!validIds([loanId]).length) return false;
  const b = await Models.BankDebt.findById(loanId).lean<LoanRaw | null>();
  if (!b || b.status !== 'pending_disbursement') return false;
  const links = await reservingLinks(await loadLinks({ to_type: 'bank_debt', to_ids: [loanId], relations: ['disbursement'] }));
  const docs = await loadDocs(links.map((l) => l.from_id));
  const paidLinks = links.filter((l) => docs.get(l.from_id)?.status === 'paid');
  if (!paidLinks.length) return false;
  const paidSum = paidLinks.reduce((s, l) => s + allocationOf(l), 0n);
  const plannedSum = links.reduce((s, l) => s + allocationOf(l), 0n);
  const paidAt = lastPaidAt(docs, paidLinks) ?? today();
  const set: Record<string, unknown> = { status: 'active', disbursed_at: businessDateStart(paidAt), updated_at: new Date() };
  const changes: Record<string, { from: string | null; to: string | null }> = {
    status: { from: 'pending_disbursement', to: 'active' },
    disbursed_at: { from: null, to: paidAt },
  };
  // Gốc = số thực thu khi đã giải ngân hết các phiếu gán (không còn phiếu chờ). Còn đợt chờ ⇒ giữ gốc hợp đồng (v2 §11.4(b)).
  if (paidSum > 0n && plannedSum === paidSum) {
    const oldPrincipal = toBigSafe(b.principal_minor);
    set.principal_minor = paidSum;
    set.amount = { minor: paidSum, currency: String(b.currency ?? 'VND'), decimals: 0 };
    set.outstanding_minor = paidSum;
    if (oldPrincipal !== paidSum) changes.principal_minor = { from: oldPrincipal.toString(), to: paidSum.toString() };
  }
  const res = await Models.BankDebt.updateOne(
    { _id: loanId, status: 'pending_disbursement' } as never,
    {
      $set: set,
      $push: {
        history: buildHistoryEntry({
          action: 'activate',
          actor: { user_id: actor?.user_id ?? null, role: actor?.role ?? null, name: actor?.name ?? null },
          from: 'pending_disbursement',
          to: 'active',
          fields: { changes, disbursed_at: paidAt, principal_minor: paidSum.toString() },
        }),
      },
    } as never,
  ).exec();
  return res.modifiedCount === 1;
}

/* ------------------------------ Đảo hạn (v2 §7.3, §10.3, US-LOAN-04) ------------------------------ */

/**
 * Khoản vay gắn vào phương án đảo hạn (v2 §10.3): cùng công ty, cùng ngân hàng (đối tác của phương án),
 * đang vay hoặc quá hạn. Gọi khi lưu phương án (POST / PATCH `/documents`).
 */
export async function assertLoanForRollover(loanId: string, companyId: string, partnerId: string | null): Promise<void> {
  const b = OBJECT_ID_RE.test(loanId) ? await Models.BankDebt.findById(loanId).lean<LoanRaw | null>() : null;
  if (!b) throw new ApiError({ code: 'FG-VAL-001', errors: { loan_id: 'Không tìm thấy khoản vay' } });
  if (String(b.company_id) !== companyId) throw new ApiError({ code: 'FG-VAL-001', errors: { loan_id: 'Khoản vay thuộc công ty khác' } });
  if (!partnerId || String(b.partner_id ?? '') !== partnerId) {
    throw new ApiError({ code: 'FG-LINK-001', detail: 'Khoản vay không thuộc ngân hàng của phương án', errors: { loan_id: 'Chọn khoản vay của đúng ngân hàng' } });
  }
  const status = await currentStatus(b);
  if (status !== 'active' && status !== 'overdue') {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Chỉ lập phương án đảo hạn cho khoản đang vay hoặc quá hạn', errors: { loan_id: 'Khoản vay không đang vay / quá hạn' } });
  }
}

export interface RolloverResultForLoan {
  document_id: string;
  document_code: string;
  new_maturity_date: string;
  new_contract_code: string;
  new_limit_minor: bigint;
  new_rate: string;
  actual_fee_minor: bigint;
}

/**
 * Kiểm TRƯỚC khi ghi kết quả đảo hạn (chạy trước khi đổi trạng thái phiếu, để không lưu kết quả mà không cập nhật được khoản vay):
 * khoản còn đang vay / quá hạn và ngày đáo hạn mới nằm sau hạn hiện tại và sau ngày giải ngân.
 */
export async function assertRolloverResultForLoan(loanId: string, newMaturityDate: string): Promise<void> {
  const b = await loadLoanOrFail(loanId);
  const status = await currentStatus(b);
  if (status !== 'active' && status !== 'overdue') {
    throw new ApiError({ code: 'FG-WF-001', detail: 'Khoản vay không còn đang vay / quá hạn — không cập nhật kết quả đảo hạn' });
  }
  if (newMaturityDate <= String(b.maturity_date ?? '')) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Ngày đáo hạn mới phải sau hạn hiện tại', errors: { new_maturity_date: 'Phải sau hạn hiện tại' } });
  }
  assertMaturityAfterDisbursement(newMaturityDate, b.disbursed_at ? vnDate(b.disbursed_at) : null);
}

/**
 * Cập nhật khoản vay theo kết quả đảo hạn (v2 §10.3, §7.3): hạn thanh toán, kỳ kế tiếp, hạn mức mới, lãi suất mới,
 * số HĐ mới. Ghi lịch sử `rollover_result` trước → sau. Gốc không đổi. Gọi SAU khi kết quả đã được ghi vào phiếu.
 */
export async function applyRolloverResultToLoan(loanId: string, input: RolloverResultForLoan, actor: LoanActor, ip: string | null): Promise<{ changed: string[] }> {
  const b = await loadLoanOrFail(loanId);
  const set: Record<string, unknown> = {
    maturity_date: input.new_maturity_date,
    next_due_date: input.new_maturity_date,
    interest_rate: input.new_rate,
    contract_no: input.new_contract_code || null,
    credit_limit_minor: input.new_limit_minor,
    updated_at: new Date(),
  };
  const rawB = b as unknown as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of LOAN_TRACKED) {
    before[k] = rawB[k];
    after[k] = k in set ? set[k] : rawB[k];
  }
  const changes = changesOf(before, after);
  const history = buildHistoryEntry({
    action: 'rollover_result',
    actor: { user_id: actor.user_id, role: actor.role ?? null, name: actor.name ?? null },
    to: null,
    ip,
    fields: { changes, document_id: input.document_id, document_code: input.document_code, actual_fee_minor: input.actual_fee_minor.toString() },
  });
  await Models.BankDebt.updateOne({ _id: loanId } as never, { $set: set, $push: { history } } as never).exec();
  await refreshLoanCache(loanId);
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'bank_debt.rollover_result',
    subject: { type: 'bank_debt', id: loanId, code: String(b.code ?? '') },
    company_id: String(b.company_id),
    document_id: input.document_id,
    diff_fields: { changes },
    ip,
  });
  return { changed: Object.keys(changes) };
}

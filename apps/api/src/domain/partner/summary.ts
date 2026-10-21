/**
 * Số liệu tóm tắt của đối tác (v2/v2.md §5.3) — KHÔNG lưu, suy ra từ liên kết + trạng thái phiếu.
 *
 * - KH / NCC: còn phải thu, còn phải trả (Σ giá trị − đã cấn trừ hiệu lực), quá hạn (còn dư và đã qua hạn).
 * - Ngân hàng: dư nợ (Σ gốc − gốc đã trả hiệu lực), đáo hạn gần nhất (hạn của khoản còn dư nợ).
 * - Mọi loại: tổng thu / tổng chi ĐÃ THỰC THI trong kỳ (theo ngày thực thi / kỳ chi từng phần).
 *
 * "Đã cấn trừ / đã trả" chỉ tính phiếu đã `paid` (domain/links: EXECUTED_DOCUMENT_STATUSES).
 * Liên kết hiệu lực đọc từ `business_links` (v2); dữ liệu v1 nhúng đã chuyển sang đó (migrate M3).
 *
 * Phần thuần (`numbersOf`, `resolveDebtDirection`, `overdueDaysOf`, `paidTotalsInPeriod`) tách khỏi
 * phần nạp DB (`loadPartnerLedgers`) để kiểm thử.
 */

import { ApiError, daysBetween, daysUntil, maturity, type PartnerType, vnDate } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import {
  EXECUTED_DOCUMENT_STATUSES,
  allocationOf,
  debtOffsetAppliedFrom,
  debtRemainingOf,
  loanOutstandingOf,
  loanRepaidPrincipalFrom,
  principalPartOf,
  reservingLinks,
  toBig,
  toLinkRecord,
} from '../links/index.ts';

export type DebtDirection = 'receivable' | 'payable';

export interface Period {
  /** YYYY-MM-DD, gồm cả ngày đầu */
  from: string;
  /** YYYY-MM-DD, gồm cả ngày cuối */
  to: string;
}

/** Hướng khoản: `direction` mới; dữ liệu v1 (null) suy theo `side` như migrate M3b (Nợ ⇒ phải thu, Có ⇒ phải trả). */
export function resolveDebtDirection(direction: string | null | undefined, side: string | null | undefined): DebtDirection {
  if (direction === 'receivable' || direction === 'payable') return direction;
  return side === 'debit' ? 'receivable' : 'payable';
}

/** Số ngày quá hạn (0 nếu chưa tới hạn). `dueIso` và `todayIso` là YYYY-MM-DD. */
export function overdueDaysOf(dueIso: string, todayIso: string): number {
  if (!dueIso || dueIso >= todayIso) return 0;
  return Math.max(0, daysBetween(dueIso, todayIso));
}

/** Kỳ mặc định: từ ngày 1 của tháng VN hiện tại tới hôm nay. */
export function defaultPeriod(today: string = vnDate()): Period {
  return { from: `${today.slice(0, 8)}01`, to: today };
}

/** Kỳ thu/chi từ tham số (thiếu đầu ⇒ ngày 1 tháng VN; thiếu cuối ⇒ hôm nay). Đầu kỳ sau cuối kỳ ⇒ FG-VAL-001. */
export function resolvePeriod(from: string | null | undefined, to: string | null | undefined, today: string = vnDate()): Period {
  const base = defaultPeriod(today);
  const period: Period = { from: from ?? base.from, to: to ?? today };
  if (period.from > period.to) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Cuối kỳ phải sau đầu kỳ', errors: { period_to: 'Cuối kỳ phải sau đầu kỳ' } });
  }
  return period;
}

export function inPeriod(at: string | null | undefined, period: Period): boolean {
  if (!at) return false;
  const d = at.slice(0, 10);
  return d >= period.from && d <= period.to;
}

export interface DebtView {
  _id: string;
  code: string;
  company_id: string;
  partner_id: string;
  direction: DebtDirection;
  account_code: string | null;
  side: string | null;
  contract_code: string | null;
  priority: string | null;
  value: bigint;
  /** đã cấn trừ (hiệu lực, phiếu đã paid) */
  applied: bigint;
  /** còn lại = giá trị − đã cấn trừ, không âm */
  remaining: bigint;
  /**
   * CÒN CÓ THỂ TRẢ = giá trị − mọi liên kết còn giữ sức chứa (kể cả phiếu chưa thực thi, trừ phiếu
   * huỷ / từ chối / hết hạn). Đây là giới hạn mà `createLink` / trả nợ kiểm tra. Không âm.
   */
  available: bigint;
  due_date: string;
  overdue_days: number;
}

export interface LoanView {
  _id: string;
  code: string;
  company_id: string;
  partner_id: string;
  status: string;
  principal: bigint;
  /** gốc đã trả (hiệu lực, phiếu chi đã paid) */
  repaid: bigint;
  /** dư nợ; khoản chờ giải ngân / đã huỷ = 0 */
  outstanding: bigint;
  /** gốc còn có thể trả (gốc − gốc đã giữ chỗ bởi phiếu còn giữ sức chứa), không âm — giới hạn của "Trả nợ". */
  available_principal: bigint;
  maturity_date: string;
  disbursed_at: Date | null;
  interest_rate: string | null;
  term_months: number | null;
  repayment_method: string | null;
  payment_frequency: string | null;
}

/** Một lần thực thi tiền của phiếu (một kỳ chi từng phần, hoặc cả phiếu). */
export interface PaidFlow {
  at: string;
  amount: bigint;
}

export interface PaidDocView {
  _id: string;
  code: string;
  kind: 'income' | 'spend';
  status: string;
  company_id: string;
  partner_id: string;
  business_date: string | null;
  flows: PaidFlow[];
}

export interface PartnerLedger {
  debts: DebtView[];
  loans: LoanView[];
  paid: PaidDocView[];
  has_activity: boolean;
}

export interface PartnerNumbers {
  receivable_remaining: bigint | null;
  payable_remaining: bigint | null;
  overdue_amount: bigint | null;
  outstanding: bigint | null;
  next_maturity_date: string | null;
  paid_in_period: bigint;
  paid_out_period: bigint;
  has_activity: boolean;
}

export function emptyLedger(): PartnerLedger {
  return { debts: [], loans: [], paid: [], has_activity: false };
}

/**
 * Nhóm số liệu được xem trên danh sách / chi tiết (v2 §3.2). Thiếu quyền ⇒ server trả `null` cho nhóm đó
 * (không rò rỉ công nợ / khoản vay / tiền thu chi qua màn chỉ có `partner:read`).
 */
export interface SummaryVisibility {
  /** còn phải thu / còn phải trả / quá hạn — cần `debt:read` */
  debt: boolean;
  /** dư nợ / đáo hạn gần nhất — cần `loan:read` hoặc `bank:read` */
  loan: boolean;
  /** tổng thu / tổng chi đã thực thi trong kỳ — cần `doc:read` */
  cash: boolean;
}

export function summaryVisibilityOf(perms: readonly string[]): SummaryVisibility {
  return {
    debt: perms.includes('debt:read'),
    loan: perms.includes('loan:read') || perms.includes('bank:read'),
    cash: perms.includes('doc:read'),
  };
}

/** Số tiền còn có thể trả: giá trị − đã giữ chỗ, không âm. */
export function availableOf(total: bigint, reserved: bigint): bigint {
  return total > reserved ? total - reserved : 0n;
}

/** Tổng thu (phiếu thu) và tổng chi (phiếu chi) đã thực thi trong kỳ — thuần. */
export function paidTotalsInPeriod(paid: readonly PaidDocView[], period: Period): { in: bigint; out: bigint } {
  let received = 0n;
  let disbursed = 0n;
  for (const doc of paid) {
    for (const f of doc.flows) {
      if (!inPeriod(f.at, period)) continue;
      if (doc.kind === 'income') received += f.amount;
      else disbursed += f.amount;
    }
  }
  return { in: received, out: disbursed };
}

/**
 * Các số liệu tóm tắt của một đối tác (thuần — nhận ledger đã nạp).
 * KH/NCC: còn phải thu / còn phải trả / quá hạn; NH: dư nợ / đáo hạn gần nhất; cột không áp dụng = null.
 */
export function numbersOf(type: PartnerType, ledger: PartnerLedger, period: Period, today: string): PartnerNumbers {
  const isBank = type === 'bank';
  let receivable = 0n;
  let payable = 0n;
  let overdue = 0n;
  for (const d of ledger.debts) {
    if (d.direction === 'receivable') receivable += d.remaining;
    else payable += d.remaining;
    if (d.remaining > 0n && d.due_date < today) overdue += d.remaining;
  }
  let outstanding = 0n;
  let nextMaturity: string | null = null;
  for (const l of ledger.loans) {
    if (l.outstanding <= 0n) continue;
    outstanding += l.outstanding;
    if (nextMaturity === null || l.maturity_date < nextMaturity) nextMaturity = l.maturity_date;
  }
  const paid = paidTotalsInPeriod(ledger.paid, period);
  return {
    receivable_remaining: isBank ? null : receivable,
    payable_remaining: isBank ? null : payable,
    overdue_amount: isBank ? null : overdue,
    outstanding: isBank ? outstanding : null,
    next_maturity_date: isBank ? nextMaturity : null,
    paid_in_period: paid.in,
    paid_out_period: paid.out,
    has_activity: ledger.has_activity,
  };
}

/** Số ngày tới đáo hạn (âm = quá hạn) và mức cảnh báo (DS §3.3) của một khoản vay. */
export function maturityInfo(maturityIso: string, now: Date = new Date()): { days: number; level: number; tone: string; bucket: string } {
  const days = daysUntil(maturityIso, now);
  const band = maturity(days);
  return { days, level: band.level, tone: band.tone, bucket: band.bucket };
}

/* ================================================================== *
 * Nạp dữ liệu (batch cho cả trang danh sách)
 * ================================================================== */

type RawLink = Parameters<typeof toLinkRecord>[0];

interface DebtRaw {
  _id: unknown;
  code?: string;
  company_id: unknown;
  partner_id: unknown;
  direction?: string | null;
  side?: string | null;
  account_code?: string | null;
  contract_code?: string | null;
  priority?: string | null;
  value_minor?: unknown;
  due_date?: string;
}

interface LoanRaw {
  _id: unknown;
  code?: string;
  company_id: unknown;
  partner_id: unknown;
  status?: string;
  principal_minor?: unknown;
  maturity_date?: string;
  disbursed_at?: Date | null;
  interest_rate?: string | null;
  term_months?: number | null;
  repayment_method?: string | null;
  payment_frequency?: string | null;
}

interface DocRaw {
  _id: unknown;
  code?: string;
  kind: 'income' | 'spend';
  status?: string;
  company_id: unknown;
  partner_id: unknown;
  business_date?: string | null;
  amount?: { minor?: unknown } | null;
  execution?: {
    paid_at?: string | null;
    actual_amount_minor?: unknown;
    installments?: { at?: string; amount_minor?: unknown }[] | null;
  } | null;
}

export interface LedgerPartner {
  _id: string;
  company_id: string;
  type: PartnerType;
}

const keyOf = (companyId: unknown, partnerId: unknown): string => `${String(companyId)}|${String(partnerId)}`;

/** Ghép flow tiền của một phiếu đã thực thi (kỳ chi từng phần hoặc cả phiếu). */
function flowsOf(doc: DocRaw): PaidFlow[] {
  const installments = doc.execution?.installments ?? [];
  if (installments.length) return installments.map((i) => ({ at: String(i.at ?? ''), amount: toBig(i.amount_minor) }));
  if (doc.status !== 'paid') return [];
  const actual = doc.execution?.actual_amount_minor;
  const amount = actual !== null && actual !== undefined ? toBig(actual) : toBig(doc.amount?.minor);
  return [{ at: String(doc.execution?.paid_at ?? doc.business_date ?? ''), amount }];
}

/**
 * Nạp sổ theo đối tác (một lượt cho cả danh sách). Trả về map `partnerId → ledger`.
 * Mọi truy vấn lọc theo đối tác VÀ công ty của đối tác (không đọc chéo công ty).
 */
export async function loadPartnerLedgers(partners: readonly LedgerPartner[]): Promise<Map<string, PartnerLedger>> {
  const out = new Map<string, PartnerLedger>();
  for (const p of partners) out.set(p._id, emptyLedger());
  if (!partners.length) return out;

  const partnerIds = partners.map((p) => p._id);
  // Mọi truy vấn lọc theo đối tác VÀ công ty của đối tác (không đọc chéo công ty, kể cả ở tầng DB).
  const companyIds = [...new Set(partners.map((p) => p.company_id))];
  const partnerByKey = new Map(partners.map((p) => [keyOf(p.company_id, p._id), p._id] as const));
  const scoped = { partner_id: { $in: partnerIds }, company_id: { $in: companyIds } };

  const [debtRows, loanRows, docRows, usedDocPartners, usedRecurring] = await Promise.all([
    Models.DebtVoucher.find(scoped as never)
      .select({ code: 1, company_id: 1, partner_id: 1, direction: 1, side: 1, account_code: 1, contract_code: 1, priority: 1, value_minor: 1, due_date: 1 })
      .lean<DebtRaw[]>(),
    Models.BankDebt.find(scoped as never)
      .select({ code: 1, company_id: 1, partner_id: 1, status: 1, principal_minor: 1, maturity_date: 1, disbursed_at: 1, interest_rate: 1, term_months: 1, repayment_method: 1, payment_frequency: 1 })
      .lean<LoanRaw[]>(),
    Models.Document.find({
      ...scoped,
      kind: { $in: ['income', 'spend'] },
      $or: [{ status: 'paid' }, { 'execution.installments.0': { $exists: true } }],
    } as never)
      .select({ code: 1, kind: 1, status: 1, company_id: 1, partner_id: 1, business_date: 1, amount: 1, execution: 1 })
      .lean<DocRaw[]>(),
    Models.Document.distinct('partner_id', scoped as never).exec(),
    Models.RecurringRule.distinct('partner_id', scoped as never).exec(),
  ]);

  const debtIds = debtRows.map((d) => String(d._id));
  const loanIds = loanRows.map((l) => String(l._id));
  const [offsetRaw, repaymentRaw] = await Promise.all([
    debtIds.length
      ? Models.BusinessLink.find({ company_id: { $in: companyIds }, status: 'active', relation: 'offset', to_type: 'debt_voucher', to_id: { $in: debtIds } } as never).lean<RawLink[]>()
      : Promise.resolve([] as RawLink[]),
    loanIds.length
      ? Models.BusinessLink.find({ company_id: { $in: companyIds }, status: 'active', relation: 'repayment', to_type: 'bank_debt', to_id: { $in: loanIds } } as never).lean<RawLink[]>()
      : Promise.resolve([] as RawLink[]),
  ]);
  const offsetLinks = offsetRaw.map(toLinkRecord);
  const repaymentLinks = repaymentRaw.map(toLinkRecord);

  // Phiếu nguồn của mọi liên kết hiệu lực → tập phiếu đã paid.
  const sourceIds = [...new Set([...offsetLinks.map((l) => l.from_id), ...repaymentLinks.map((l) => l.from_id)])];
  const executedRows = sourceIds.length
    ? await Models.Document.find({ company_id: { $in: companyIds }, _id: { $in: sourceIds }, status: { $in: [...EXECUTED_DOCUMENT_STATUSES] } } as never)
        .select({ _id: 1 })
        .lean<{ _id: unknown }[]>()
    : [];
  const executed = new Set(executedRows.map((r) => String(r._id)));
  // Liên kết còn GIỮ sức chứa (phiếu nguồn không huỷ / từ chối / hết hạn) → "còn có thể trả".
  const offsetHolding = await reservingLinks(offsetLinks);
  const repaymentHolding = await reservingLinks(repaymentLinks);

  const today = vnDate();
  for (const d of debtRows) {
    const pid = partnerByKey.get(keyOf(d.company_id, d.partner_id));
    if (!pid) continue;
    const id = String(d._id);
    const companyId = String(d.company_id);
    const links = offsetLinks.filter((l) => l.to_id === id);
    const value = toBig(d.value_minor);
    const applied = debtOffsetAppliedFrom(links, id, executed);
    const reserved = offsetHolding.filter((l) => l.to_id === id).reduce((s, l) => s + allocationOf(l), 0n);
    const due = String(d.due_date ?? '');
    out.get(pid)?.debts.push({
      _id: id,
      code: String(d.code ?? id),
      company_id: companyId,
      partner_id: pid,
      direction: resolveDebtDirection(d.direction, d.side),
      account_code: d.account_code ?? null,
      side: d.side ?? null,
      contract_code: d.contract_code ?? null,
      priority: d.priority ?? null,
      value,
      applied,
      remaining: debtRemainingOf(value, applied),
      available: availableOf(value, reserved),
      due_date: due,
      overdue_days: overdueDaysOf(due, today),
    });
  }

  for (const l of loanRows) {
    const pid = partnerByKey.get(keyOf(l.company_id, l.partner_id));
    if (!pid) continue;
    const id = String(l._id);
    const companyId = String(l.company_id);
    const links = repaymentLinks.filter((x) => x.to_id === id);
    const principal = toBig(l.principal_minor);
    const repaid = loanRepaidPrincipalFrom(links, id, executed);
    const reservedPrincipal = repaymentHolding.filter((x) => x.to_id === id).reduce((s, x) => s + principalPartOf(x), 0n);
    const status = l.status ?? 'active';
    out.get(pid)?.loans.push({
      _id: id,
      code: String(l.code ?? id),
      company_id: companyId,
      partner_id: pid,
      status,
      principal,
      repaid,
      outstanding: loanOutstandingOf(principal, repaid, status),
      // chỉ khoản đang vay / quá hạn còn nhận trả nợ (cùng quy tắc với `planSettlement`)
      available_principal: status === 'active' || status === 'overdue' ? availableOf(principal, reservedPrincipal) : 0n,
      maturity_date: String(l.maturity_date ?? ''),
      disbursed_at: l.disbursed_at ?? null,
      interest_rate: l.interest_rate ?? null,
      term_months: l.term_months ?? null,
      repayment_method: l.repayment_method ?? null,
      payment_frequency: l.payment_frequency ?? null,
    });
  }

  for (const doc of docRows) {
    const pid = partnerByKey.get(keyOf(doc.company_id, doc.partner_id));
    if (!pid) continue;
    out.get(pid)?.paid.push({
      _id: String(doc._id),
      code: String(doc.code ?? doc._id),
      kind: doc.kind,
      status: String(doc.status ?? ''),
      company_id: String(doc.company_id),
      partner_id: pid,
      business_date: doc.business_date ?? null,
      flows: flowsOf(doc),
    });
  }

  const usedSet = new Set<string>([...usedDocPartners.map((x) => String(x)), ...usedRecurring.map((x) => String(x))]);
  for (const p of partners) {
    const ledger = out.get(p._id);
    if (!ledger) continue;
    ledger.has_activity = usedSet.has(p._id) || ledger.debts.length > 0 || ledger.loans.length > 0 || ledger.paid.length > 0;
  }
  return out;
}

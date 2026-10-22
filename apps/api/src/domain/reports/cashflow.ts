/**
 * Dự báo dòng tiền 7 / 30 / 60 / 90 ngày (v2 §12): đầu kỳ, thu, chi dự kiến, cuối kỳ;
 * dưới số dư tối thiểu → đỏ. Gồm **giải ngân sắp tới** và **lịch trả nợ vay**.
 *
 * Nguyên tắc không đếm trùng:
 *   · đầu kỳ = sổ cái thực tế đến hết ngày bắt đầu (đã gồm phiếu đã thực thi trong ngày);
 *   · dòng dự kiến = phiếu đang chờ thực thi (`pending.*`, `approved`, `processing`) — KHÔNG gồm `paid`;
 *   · phiếu thu giải ngân vay (borrow) tách bucket `disbursement_in`; khoản vay chờ giải ngân
 *     CHƯA có phiếu thu giải ngân CÓ HIỆU LỰC (phiếu trong pipeline hoặc đã thực thi; phiếu nháp chưa tính)
 *     thì nằm ở danh sách "chưa có ngày" (không cộng vào dòng);
 *   · lịch trả nợ = kỳ CHƯA đến hạn của khoản vay đang vay, trừ phần đã có phiếu trả nợ trong pipeline.
 *     Kỳ đã qua KHÔNG được dự báo (không biết kỳ nào đã trả qua phiếu không gắn kỳ).
 *
 * Phần thuần (`buildForecastSeries`, `netInstallments`, `weekdayOf`) tách khỏi phần đọc DB để test.
 */

import { addDays, today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { oid } from '../../lib/mongo.ts';
import { loadPipelineDocs, PLANNED_FLOW_STATUSES, plannedFlowsOf, type PlannedFlow, type PipelineDoc } from '../ledger/planned.ts';
import { buildRemainingSchedule } from '../loan-schedule/index.ts';
import { docHref, wire, type WireAmount } from '../queries/index.ts';
import { toBig } from '../links/index.ts';
import type { ScopeLike } from '../types.ts';
import { dayOf, loadLoanSettlements, loadPartnerRefs, partnerNameOf } from './refs.ts';
import { executedSum } from './aggregate.ts';

export const FORECAST_HORIZONS = [7, 30, 60, 90] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

/** Chuẩn hoá tham số `horizon` (mặc định 30; ngoài 7/30/60/90 → 30). */
export function parseHorizon(v: unknown): ForecastHorizon {
  const n = Number(v);
  return (FORECAST_HORIZONS as readonly number[]).includes(n) ? (n as ForecastHorizon) : 30;
}

export type ForecastBucket = 'operating_in' | 'disbursement_in' | 'internal_in' | 'operating_out' | 'internal_out' | 'loan_repayment_out';

export interface ForecastFlow {
  date: string;
  bucket: ForecastBucket;
  amount: bigint;
}

export interface ForecastDay {
  date: string;
  weekday: string;
  opening: bigint;
  operating_in: bigint;
  disbursement_in: bigint;
  internal_in: bigint;
  operating_out: bigint;
  internal_out: bigint;
  loan_repayment_out: bigint;
  inflow: bigint;
  outflow: bigint;
  net: bigint;
  closing: bigint;
  min_balance: bigint;
  breach: boolean;
}

export interface ForecastTotals {
  operating_in: bigint;
  disbursement_in: bigint;
  internal_in: bigint;
  operating_out: bigint;
  internal_out: bigint;
  loan_repayment_out: bigint;
  inflow: bigint;
  outflow: bigint;
  net: bigint;
}

export interface ForecastSeries {
  days: ForecastDay[];
  totals: ForecastTotals;
  min_closing: bigint;
  end_closing: bigint;
  first_breach_date: string | null;
}

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

/** Thứ trong tuần tiếng Việt của ngày `YYYY-MM-DD`. */
export function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? '';
}

function emptyBuckets(): Record<ForecastBucket, bigint> {
  return { operating_in: 0n, disbursement_in: 0n, internal_in: 0n, operating_out: 0n, internal_out: 0n, loan_repayment_out: 0n };
}

/**
 * Hàm thuần: dựng chuỗi `horizon` ngày từ số dư đầu kỳ và dòng dự kiến.
 * Dòng trước `from` (quá hạn chưa thực thi) được kẹp vào `from`; dòng sau kỳ bị bỏ qua.
 */
export function buildForecastSeries(input: {
  from: string;
  horizon: number;
  opening: bigint;
  minBalance: bigint;
  flows: ForecastFlow[];
}): ForecastSeries {
  const dates = Array.from({ length: Math.max(0, input.horizon) }, (_, i) => addDays(input.from, i));
  const last = dates[dates.length - 1] ?? input.from;
  const byDate = new Map<string, Record<ForecastBucket, bigint>>();
  for (const f of input.flows) {
    const date = f.date < input.from ? input.from : f.date;
    if (date > last) continue;
    const cur = byDate.get(date) ?? emptyBuckets();
    cur[f.bucket] += f.amount;
    byDate.set(date, cur);
  }

  const days: ForecastDay[] = [];
  const totals: ForecastTotals = {
    operating_in: 0n,
    disbursement_in: 0n,
    internal_in: 0n,
    operating_out: 0n,
    internal_out: 0n,
    loan_repayment_out: 0n,
    inflow: 0n,
    outflow: 0n,
    net: 0n,
  };
  let running = input.opening;
  let minClosing = input.opening;
  let firstBreach: string | null = null;
  for (const date of dates) {
    const b = byDate.get(date) ?? emptyBuckets();
    const opening = running;
    const inflow = b.operating_in + b.disbursement_in + b.internal_in;
    const outflow = b.operating_out + b.internal_out + b.loan_repayment_out;
    const net = inflow - outflow;
    running = opening + net;
    const breach = running < input.minBalance;
    if (breach && !firstBreach) firstBreach = date;
    if (running < minClosing) minClosing = running;
    days.push({
      date,
      weekday: weekdayOf(date),
      opening,
      operating_in: b.operating_in,
      disbursement_in: b.disbursement_in,
      internal_in: b.internal_in,
      operating_out: b.operating_out,
      internal_out: b.internal_out,
      loan_repayment_out: b.loan_repayment_out,
      inflow,
      outflow,
      net,
      closing: running,
      min_balance: input.minBalance,
      breach,
    });
    totals.operating_in += b.operating_in;
    totals.disbursement_in += b.disbursement_in;
    totals.internal_in += b.internal_in;
    totals.operating_out += b.operating_out;
    totals.internal_out += b.internal_out;
    totals.loan_repayment_out += b.loan_repayment_out;
    totals.inflow += inflow;
    totals.outflow += outflow;
    totals.net += net;
  }
  return { days, totals, min_closing: minClosing, end_closing: running, first_breach_date: firstBreach };
}

/** Một kỳ trả nợ theo lịch. */
export interface Installment {
  due_date: string;
  principal: bigint;
  interest: bigint;
  total: bigint;
}

/**
 * Trừ phần đã có phiếu trả nợ trong pipeline khỏi lịch: trừ dần từ kỳ SỚM NHẤT, bỏ kỳ về 0.
 * Trong một kỳ trừ LÃI trước, rồi tới GỐC — để `principal + interest = total` luôn đúng.
 * Hàm thuần (xấp xỉ theo số tiền — không khớp kỳ theo ngày).
 */
export function netInstallments(rows: Installment[], plannedRepayments: bigint): Installment[] {
  let left = plannedRepayments > 0n ? plannedRepayments : 0n;
  const out: Installment[] = [];
  for (const r of [...rows].sort((a, b) => a.due_date.localeCompare(b.due_date))) {
    if (left <= 0n) {
      out.push(r);
      continue;
    }
    const take = left < r.total ? left : r.total;
    left -= take;
    const fromInterest = take < r.interest ? take : r.interest;
    const fromPrincipal = take - fromInterest;
    const interest = r.interest - fromInterest;
    const principal = r.principal - fromPrincipal;
    const total = principal + interest;
    if (total > 0n) out.push({ ...r, principal, interest, total });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Kết quả (JSON-ready: số tiền dạng chuỗi minor units)
 * ------------------------------------------------------------------ */

export interface ForecastDisbursementItem {
  kind: 'receipt' | 'pending_loan';
  code: string;
  company_id: string;
  partner_name: string;
  date: string | null;
  amount: WireAmount;
  href: string | null;
}

export interface ForecastRepaymentItem {
  bank_debt_id: string;
  code: string;
  company_id: string;
  partner_name: string;
  due_date: string;
  principal: WireAmount;
  interest: WireAmount;
  total: WireAmount;
}

export interface ForecastDayWire {
  date: string;
  weekday: string;
  opening: WireAmount;
  operating_in: WireAmount;
  disbursement_in: WireAmount;
  internal_in: WireAmount;
  operating_out: WireAmount;
  internal_out: WireAmount;
  loan_repayment_out: WireAmount;
  inflow: WireAmount;
  outflow: WireAmount;
  net: WireAmount;
  closing: WireAmount;
  min_balance: WireAmount;
  breach: boolean;
}

export interface CashflowForecastResult {
  horizon: number;
  from: string;
  to: string;
  opening: WireAmount;
  min_balance: WireAmount;
  totals: Record<keyof ForecastTotals | 'min_closing' | 'end_closing', WireAmount>;
  first_breach_date: string | null;
  days: ForecastDayWire[];
  shortfall_by_company: { company_id: string; company_name: string; first_breach_date: string; min_closing: WireAmount; amount: WireAmount }[];
  disbursements: { dated: ForecastDisbursementItem[]; undated: ForecastDisbursementItem[]; undated_total: WireAmount };
  repayments: ForecastRepaymentItem[];
  generated_at: string;
}

const w = (m: bigint): WireAmount => wire(m);

/* ------------------------------------------------------------------ *
 * Nạp dữ liệu & dựng dự báo
 * ------------------------------------------------------------------ */

export async function cashflowForecast(
  scope: ScopeLike,
  opts: { horizon?: number; from?: string } = {},
): Promise<CashflowForecastResult> {
  const horizon = parseHorizon(opts.horizon ?? 30);
  const from = opts.from ?? today();
  const to = addDays(from, horizon - 1);
  const inScope = (companyId: string | null | undefined): boolean =>
    scope.companyIds === null || (!!companyId && scope.companyIds.includes(String(companyId)));
  const companyFilter = scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds } };

  const companies = await Models.Company.find(scope.companyIds === null ? {} : ({ _id: { $in: scope.companyIds } } as never))
    .select({ name: 1, min_balance_minor: 1 })
    .lean<{ _id: unknown; name?: string; min_balance_minor?: unknown }[]>();
  const companyName = new Map(companies.map((c) => [String(c._id), String(c.name ?? '')]));
  const minByCompany = new Map(companies.map((c) => [String(c._id), toBig(c.min_balance_minor)]));
  const totalMin = [...minByCompany.values()].reduce((a, b) => a + b, 0n);

  // 1 · đầu kỳ: sổ cái đến hết ngày bắt đầu (gồm phiếu đã thực thi trong ngày)
  const openingRows = (await Models.CashEntry.aggregate([
    {
      $match: {
        date: { $lte: from },
        ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds.map((id) => oid(id)) } }),
      },
    },
    {
      $group: {
        _id: '$company_id',
        in_minor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount_minor', 0] } },
        out_minor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount_minor', 0] } },
      },
    },
  ] as never[])) as unknown as { _id: unknown; in_minor: unknown; out_minor: unknown }[];
  const openingByCompany = new Map<string, bigint>();
  for (const r of openingRows) openingByCompany.set(String(r._id), toBig(r.in_minor) - toBig(r.out_minor));
  const opening = [...openingByCompany.values()].reduce((a, b) => a + b, 0n);

  // 2 · dòng dự kiến từ pipeline (phiếu chưa thực thi)
  const internalScope =
    scope.companyIds === null
      ? {}
      : {
          $or: [
            { company_id: { $in: scope.companyIds } },
            { kind: 'internal', 'transfer_target.company_id': { $in: scope.companyIds } },
            { kind: 'internal', 'target.company_id': { $in: scope.companyIds } },
          ],
        };
  const pipeline = await loadPipelineDocs(internalScope, to);
  const pipelineById = new Map(pipeline.map((d) => [d.id, d]));
  const pipelineFlows: PlannedFlow[] = pipeline.flatMap((d) => plannedFlowsOf(d, from)).filter((f) => inScope(f.company_id));
  const flows: ForecastFlow[] = pipelineFlows.map((f) => ({ date: f.date, bucket: f.bucket, amount: f.amount }));

  // 3 · lịch trả nợ của khoản vay đang vay (kỳ chưa đến hạn; trừ phiếu trả nợ đã có trong pipeline)
  const loans = await Models.BankDebt.find({ status: { $in: ['active', 'overdue'] }, ...companyFilter } as never)
    .select({ code: 1, company_id: 1, partner_id: 1, principal_minor: 1, interest_rate: 1, maturity_date: 1, payment_frequency: 1, repayment_method: 1, disbursed_at: 1, created_at: 1 })
    .lean<Record<string, unknown>[]>();
  const loanSettlements = await loadLoanSettlements(loans.map((l) => ({ id: String(l._id) })));
  const repaidByLoan = new Map<string, bigint>();
  for (const [loanId, rows] of groupBy(loanSettlements, (r) => r.target_id)) {
    repaidByLoan.set(loanId, executedSum(rows, 'principal'));
  }
  const plannedRepayByLoan = await plannedRepaymentsByLoan(
    loans.map((l) => String(l._id)),
    pipelineById,
    to,
  );
  const partnerMap = await loadPartnerRefs(loans.map((l) => (l.partner_id ? String(l.partner_id) : null)));

  const repayments: ForecastRepaymentItem[] = [];
  for (const l of loans) {
    const id = String(l._id);
    const outstanding = toBig(l.principal_minor) - (repaidByLoan.get(id) ?? 0n);
    if (outstanding <= 0n) continue;
    const startDate = dayOf(l.disbursed_at ?? l.created_at);
    const maturity = String(l.maturity_date ?? '');
    if (!startDate || !maturity) continue;
    // Lịch CÒN LẠI: gốc ban đầu trừ gốc đã trả; chia đều theo số kỳ còn lại (không theo lịch đầy đủ).
    const schedule = buildRemainingSchedule({
      principalMinor: toBig(l.principal_minor),
      repaidPrincipalMinor: repaidByLoan.get(id) ?? 0n,
      rate: String(l.interest_rate ?? '0'),
      maturityDate: maturity,
      startDate,
      frequency: (l.payment_frequency as never) ?? 'maturity',
      method: (l.repayment_method as never) ?? 'interest_only',
    });
    const upcoming: Installment[] = schedule.rows
      .filter((row) => row.due_date >= from && row.due_date <= to)
      .map((row) => ({ due_date: row.due_date, principal: row.principal, interest: row.interest, total: row.total }));
    const left = netInstallments(upcoming, plannedRepayByLoan.get(id) ?? 0n);
    const partnerName = partnerNameOf(partnerMap, l.partner_id ? String(l.partner_id) : null, 'Chưa gán ngân hàng');
    for (const row of left) {
      flows.push({ date: row.due_date, bucket: 'loan_repayment_out', amount: row.total });
      repayments.push({
        bank_debt_id: id,
        code: String(l.code ?? ''),
        company_id: String(l.company_id ?? ''),
        partner_name: partnerName,
        due_date: row.due_date,
        principal: w(row.principal),
        interest: w(row.interest),
        total: w(row.total),
      });
    }
  }

  // 4 · tổng hợp: toàn phạm vi + từng công ty (cảnh báo thiếu tiền theo công ty)
  const series = buildForecastSeries({ from, horizon, opening, minBalance: totalMin, flows });
  const shortfalls: CashflowForecastResult['shortfall_by_company'] = [];
  for (const companyId of minByCompany.keys()) {
    const min = minByCompany.get(companyId) ?? 0n;
    const perFlows = flowsForCompany(pipelineFlows, repayments, companyId, from, to);
    const s = buildForecastSeries({
      from,
      horizon,
      opening: openingByCompany.get(companyId) ?? 0n,
      minBalance: min,
      flows: perFlows,
    });
    if (s.first_breach_date) {
      const gap = min - s.min_closing;
      shortfalls.push({
        company_id: companyId,
        company_name: companyName.get(companyId) ?? '',
        first_breach_date: s.first_breach_date,
        min_closing: w(s.min_closing),
        amount: w(gap > 0n ? gap : 0n),
      });
    }
  }

  // 5 · giải ngân: phiếu thu vay trong pipeline (có ngày) + khoản vay chờ giải ngân chưa có phiếu
  const receiptFlows = pipelineFlows.filter((f) => f.bucket === 'disbursement_in');
  const receiptPartners = await loadPartnerRefs(receiptFlows.map((f) => pipelineById.get(f.doc_id)?.partner_id ?? null));
  const dated: ForecastDisbursementItem[] = receiptFlows.map((f) => {
    const partnerId = pipelineById.get(f.doc_id)?.partner_id ?? null;
    return {
      kind: 'receipt',
      code: f.code,
      company_id: f.company_id,
      partner_name: partnerNameOf(receiptPartners, partnerId, 'Chưa gán ngân hàng'),
      date: f.date,
      amount: w(f.amount),
      href: docHref('income', f.doc_id),
    };
  });

  const pending = await Models.BankDebt.find({ status: 'pending_disbursement', ...companyFilter } as never)
    .select({ code: 1, company_id: 1, partner_id: 1, principal_minor: 1 })
    .lean<Record<string, unknown>[]>();
  const withReceipt = await loansWithReceipt(pending.map((p) => String(p._id)));
  const pendingPartners = await loadPartnerRefs(pending.map((p) => (p.partner_id ? String(p.partner_id) : null)));
  const undated: ForecastDisbursementItem[] = pending
    .filter((p) => inScope(String(p.company_id ?? '')) && !withReceipt.has(String(p._id)))
    .map((p) => ({
      kind: 'pending_loan' as const,
      code: String(p.code ?? ''),
      company_id: String(p.company_id ?? ''),
      partner_name: partnerNameOf(pendingPartners, p.partner_id ? String(p.partner_id) : null, 'Chưa gán ngân hàng'),
      date: null,
      amount: w(toBig(p.principal_minor)),
      href: `/ngan-hang/khoan-vay/${String(p._id)}`,
    }));
  const undatedTotal = undated.reduce((a, r) => a + BigInt(r.amount.minor), 0n);

  const t = series.totals;
  return {
    horizon,
    from,
    to,
    opening: w(opening),
    min_balance: w(totalMin),
    totals: {
      operating_in: w(t.operating_in),
      disbursement_in: w(t.disbursement_in),
      internal_in: w(t.internal_in),
      operating_out: w(t.operating_out),
      internal_out: w(t.internal_out),
      loan_repayment_out: w(t.loan_repayment_out),
      inflow: w(t.inflow),
      outflow: w(t.outflow),
      net: w(t.net),
      min_closing: w(series.min_closing),
      end_closing: w(series.end_closing),
    },
    first_breach_date: series.first_breach_date,
    days: series.days.map((d) => ({
      date: d.date,
      weekday: d.weekday,
      opening: w(d.opening),
      operating_in: w(d.operating_in),
      disbursement_in: w(d.disbursement_in),
      internal_in: w(d.internal_in),
      operating_out: w(d.operating_out),
      internal_out: w(d.internal_out),
      loan_repayment_out: w(d.loan_repayment_out),
      inflow: w(d.inflow),
      outflow: w(d.outflow),
      net: w(d.net),
      closing: w(d.closing),
      min_balance: w(d.min_balance),
      breach: d.breach,
    })),
    shortfall_by_company: shortfalls,
    disbursements: { dated, undated, undated_total: w(undatedTotal) },
    repayments: repayments.sort((a, b) => a.due_date.localeCompare(b.due_date)),
    generated_at: new Date().toISOString(),
  };
}

/** Tổng phiếu trả nợ còn trong pipeline của từng khoản vay (đến hạn `upTo`) — để trừ khỏi lịch. */
async function plannedRepaymentsByLoan(loanIds: string[], pipelineById: Map<string, PipelineDoc>, upTo: string): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!loanIds.length || !pipelineById.size) return out;
  const links = await Models.BusinessLink.find({ to_type: 'bank_debt', to_id: { $in: loanIds }, relation: 'repayment', status: 'active' } as never)
    .select({ to_id: 1, from_id: 1 })
    .lean<{ to_id: unknown; from_id: unknown }[]>();
  for (const l of links) {
    const doc = pipelineById.get(String(l.from_id));
    if (!doc || doc.planned_date > upTo) continue;
    const key = String(l.to_id);
    out.set(key, (out.get(key) ?? 0n) + doc.amount_minor);
  }
  return out;
}

/**
 * Hàm thuần: khoản vay đã có phiếu thu giải ngân CÓ HIỆU LỰC trong dự báo (v2 §11.2, §12).
 * Liên kết `disbursement` tới phiếu đang trong pipeline (đã có ngày dự kiến) hoặc đã thực thi
 * (`PLANNED_FLOW_STATUSES`). Phiếu nháp / trả về / từ chối… CHƯA có hiệu lực ⇒ khoản vay vẫn "chưa có ngày".
 */
export function loansCoveredByReceipts(links: { loanId: string; receiptId: string }[], statusByReceiptId: ReadonlyMap<string, string>): Set<string> {
  const out = new Set<string>();
  for (const l of links) {
    if (PLANNED_FLOW_STATUSES.includes(statusByReceiptId.get(l.receiptId) ?? '')) out.add(l.loanId);
  }
  return out;
}

/** Khoản vay chờ giải ngân đã có phiếu thu giải ngân có hiệu lực — không đưa vào "chưa có ngày". */
async function loansWithReceipt(loanIds: string[]): Promise<Set<string>> {
  if (!loanIds.length) return new Set();
  const links = await Models.BusinessLink.find({ to_type: 'bank_debt', to_id: { $in: loanIds }, relation: 'disbursement', status: 'active' } as never)
    .select({ to_id: 1, from_id: 1 })
    .lean<{ to_id: unknown; from_id: unknown }[]>();
  if (!links.length) return new Set();
  const receiptIds = [...new Set(links.map((l) => String(l.from_id)))];
  const receipts = await Models.Document.find({ _id: { $in: receiptIds.map((id) => oid(id)) } } as never)
    .select({ status: 1 })
    .lean<{ _id: unknown; status?: unknown }[]>();
  const statusByReceiptId = new Map(receipts.map((r) => [String(r._id), String(r.status ?? '')]));
  return loansCoveredByReceipts(
    links.map((l) => ({ loanId: String(l.to_id), receiptId: String(l.from_id) })),
    statusByReceiptId,
  );
}

/** Dòng dự kiến của một công ty, gồm cả trả nợ vay đã trừ kỳ (theo công ty của khoản vay). */
function flowsForCompany(pipelineFlows: PlannedFlow[], repayments: ForecastRepaymentItem[], companyId: string, from: string, to: string): ForecastFlow[] {
  const out: ForecastFlow[] = pipelineFlows
    .filter((f) => f.company_id === companyId)
    .map((f) => ({ date: f.date, bucket: f.bucket, amount: f.amount }));
  for (const r of repayments) {
    if (r.company_id !== companyId) continue;
    if (r.due_date < from || r.due_date > to) continue;
    out.push({ date: r.due_date, bucket: 'loan_repayment_out', amount: toBig(r.total.minor) });
  }
  return out;
}

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k) ?? [];
    list.push(r);
    out.set(k, list);
  }
  return out;
}

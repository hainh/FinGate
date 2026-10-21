/**
 * Bản tin tài chính hàng ngày (blueprint §XIV; v2 §12) — "tính khi đọc" + cache vào `settings`.
 *
 * Instance free ngủ nên cron có thể chạy muộn (§12.5): mở `/ban-tin` mà cache thiếu
 * thì hệ thống tự dựng lại — đó là lý do bản tin là HÀM THUẦN TÚC trên read path.
 *
 * v2: số dư = sổ cái (thực tế) + dự kiến; dự báo dùng `cashflowForecast` (giải ngân & lịch trả nợ);
 * tên ngân hàng theo `partner_id`; thêm cảnh báo khoản vay chờ giải ngân và lượt tự động lỗi.
 * "Chờ GĐ duyệt" là số liệu CẤP CÔNG TY (không phụ thuộc người xem nên bản tin gửi GĐ được);
 * thu/chi dự kiến dùng chung `PLANNED_FLOW_STATUSES` (không tính nháp / từ chối / huỷ / hết hạn).
 */

import { addDays, dayEndOf, dayStartOf, formatMoney, money, today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import type { ScopeLike } from '../types.ts';
import { asBigInt, compact, maturityLadder, wire, type WireAmount } from '../queries/index.ts';
import { ledgerAccountViews } from '../accounts.ts';
import { PLANNED_FLOW_STATUSES } from '../ledger/planned.ts';
import { cashflowForecast } from '../reports/cashflow.ts';
import { receivableOverdueTotal } from '../reports/dashboard.ts';
import { loadPartnerRefs, partnerNameOf } from '../reports/refs.ts';

/** Trạng thái chờ duyệt ở cấp Giám đốc (Phó GĐ / GĐ, §3.2). */
const GD_PENDING_STATUSES = ['pending.pgd', 'pending.gd'] as const;

export interface Newsletter {
  date: string;
  generated_at: string;
  company_names: string[];
  lines: {
    total_cash: WireAmount;
    income_today: WireAmount;
    income_today_realized: WireAmount;
    spend_today: WireAmount;
    net_today: WireAmount;
    awaiting_gd: WireAmount;
    awaiting_gd_count: number;
    receivable_overdue: WireAmount;
    maturity_today: WireAmount;
    maturity_3d: WireAmount;
    maturity_7d: WireAmount;
    maturity_30d: WireAmount;
  };
  warnings: { tone: string; text: string; href: string | null }[];
  sections: { key: string; title: string; items: { label: string; amount: WireAmount | null; note: string | null }[] }[];
}

export async function buildNewsletter(scope: ScopeLike, date = today()): Promise<Newsletter> {
  const [forecast, accounts, mat, spendToday, incomeToday, overdue, awaiting, missing, pendingLoans, failedRuns] = await Promise.all([
    cashflowForecast(scope, { horizon: 30, from: date }),
    // tài khoản đã đóng vẫn có số dư sổ cái thì tính vào tổng tiền (khớp dashboard và số dư đầu kỳ dự báo)
    ledgerAccountViews(scope, { asOf: date, includeClosed: true }),
    maturityLadder(scope, { horizonDays: 30 }),
    sumToday(scope, 'spend', date),
    sumToday(scope, 'income', date),
    receivableOverdueTotal(scope, date),
    awaitingGdSum(scope),
    countMissingEvidence(scope),
    pendingLoanSummary(scope),
    failedRunCount(scope),
  ]);

  const cash = accounts.reduce((a, x) => a + x.actual, 0n);
  const income = incomeToday.total;
  const spend = spendToday.total;
  const net = income - spend;
  const sumBucket = (days: number) => mat.filter((m) => m.days_to_due <= days).reduce((a, m) => a + asBigInt(m.outstanding.minor), 0n);

  // tên ngân hàng của khoản đáo hạn theo partner_id (không dùng text v1)
  const loanIds = mat.map((m) => m.loan_id);
  const loans = loanIds.length
    ? await Models.BankDebt.find({ _id: { $in: loanIds } } as never).select({ partner_id: 1 }).lean<{ _id: unknown; partner_id?: unknown }[]>()
    : [];
  const partnerOfLoan = new Map(loans.map((l) => [String(l._id), l.partner_id ? String(l.partner_id) : null]));
  const partners = await loadPartnerRefs([...partnerOfLoan.values()]);

  const warnings: { tone: string; text: string; href: string | null }[] = [];
  for (const s of forecast.shortfall_by_company) {
    warnings.push({
      tone: 'danger',
      text: `${s.company_name} có khả năng thiếu ${compact(asBigInt(s.amount.minor))} vào ngày ${s.first_breach_date}`,
      href: '/dong-tien',
    });
  }
  if (forecast.first_breach_date) {
    warnings.push({ tone: 'danger', text: `Dự kiến thủng ngưỡng tối thiểu vào ${forecast.first_breach_date}`, href: '/dong-tien' });
  }
  if (awaiting.count > 0) {
    warnings.push({ tone: 'warning', text: `${awaiting.count} khoản chờ GĐ duyệt · ${compact(awaiting.total)}`, href: '/cho-toi-duyet' });
  }
  if (pendingLoans.count > 0) {
    warnings.push({ tone: 'attention', text: `${pendingLoans.count} khoản vay chờ giải ngân · ${compact(pendingLoans.total)}`, href: '/ngan-hang/khoan-vay' });
  }
  if (failedRuns > 0) {
    warnings.push({ tone: 'danger', text: `${failedRuns} lượt tự động lỗi cần chạy lại`, href: '/can-xu-ly' });
  }
  if (missing > 0) warnings.push({ tone: 'attention', text: `${missing} hồ sơ thiếu chứng từ`, href: '/can-xu-ly' });

  const fcDays = forecast.days.filter((_, i) => i % 7 === 0).slice(0, 6);
  return {
    date,
    generated_at: new Date().toISOString(),
    company_names: accounts.map((a) => a.company_name).filter((v, i, arr) => arr.indexOf(v) === i),
    lines: {
      total_cash: wire(cash),
      income_today: wire(income),
      income_today_realized: wire(incomeToday.realized),
      spend_today: wire(spend),
      net_today: wire(net),
      awaiting_gd: wire(awaiting.total),
      awaiting_gd_count: awaiting.count,
      receivable_overdue: wire(overdue),
      maturity_today: wire(sumBucket(0)),
      maturity_3d: wire(sumBucket(3)),
      maturity_7d: wire(sumBucket(7)),
      maturity_30d: wire(sumBucket(30)),
    },
    warnings: warnings.slice(0, 10),
    sections: [
      {
        key: 'forecast',
        title: `Dòng tiền 30 ngày (${formatMoney(money(BigInt(forecast.totals.net.minor)), { mode: 'compact' })} thuần)`,
        items: fcDays.map((r) => ({ label: `${r.weekday} ${r.date}`, amount: r.closing, note: r.breach ? 'dưới ngưỡng' : null })),
      },
      {
        key: 'disbursement',
        title: 'Giải ngân & trả nợ sắp tới',
        items: [
          ...forecast.disbursements.dated.slice(0, 4).map((d) => ({ label: `Giải ngân ${d.partner_name} · ${d.code}`, amount: d.amount, note: d.date })),
          ...forecast.disbursements.undated.slice(0, 3).map((d) => ({ label: `Chờ giải ngân · ${d.partner_name} · ${d.code}`, amount: d.amount, note: 'chưa có ngày' })),
          ...forecast.repayments.slice(0, 4).map((r) => ({ label: `Trả nợ ${r.partner_name} · ${r.code}`, amount: r.total, note: r.due_date })),
        ],
      },
      {
        key: 'maturity',
        title: 'Đáo hạn',
        items: mat.slice(0, 6).map((m) => ({
          label: `${partnerNameOf(partners, partnerOfLoan.get(m.loan_id) ?? null, 'Chưa gán ngân hàng')} ${m.contract_code}`,
          amount: m.outstanding,
          note: m.label,
        })),
      },
      {
        key: 'cash_by_account',
        title: 'Tiền theo tài khoản',
        items: accounts.slice(0, 8).map((a) => ({
          label: `${a.company_name} · ${a.label}`,
          amount: wire(a.actual, a.currency),
          note: a.breach ? 'dưới ngưỡng' : a.breach_projected ? 'dự kiến dưới ngưỡng' : null,
        })),
      },
    ],
  };
}

/** Thu/chi dự kiến trong ngày `date` (chỉ phiếu thuộc chỉ tiêu thu–chi, không giới hạn số dòng). */
async function sumToday(scope: ScopeLike, kind: 'spend' | 'income', date: string) {
  const rows = await Models.Document.find({
    kind,
    status: { $in: [...PLANNED_FLOW_STATUSES] },
    planned_date: { $gte: dayStartOf(date), $lte: dayEndOf(date) },
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds as never } }),
  } as never)
    .select({ status: 1, 'amount.minor': 1 })
    .lean<{ status?: string; amount?: { minor?: unknown } }[]>();
  let total = 0n;
  let realized = 0n;
  for (const r of rows) {
    const m = asBigInt(r.amount?.minor);
    total += m;
    if (r.status === 'paid') realized += m;
  }
  return { total, realized };
}

/** Phiếu chờ GĐ duyệt trong phạm vi công ty (không phụ thuộc người xem). */
async function awaitingGdSum(scope: ScopeLike) {
  const rows = await Models.Document.find({
    status: { $in: [...GD_PENDING_STATUSES] },
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds as never } }),
  } as never)
    .select({ 'amount.minor': 1 })
    .lean<{ amount?: { minor?: unknown } }[]>();
  return { total: rows.reduce((a, r) => a + asBigInt(r.amount?.minor), 0n), count: rows.length };
}

async function countMissingEvidence(scope: ScopeLike): Promise<number> {
  return Models.Document.countDocuments({
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds as never } }),
    'evidence.missing.0': { $exists: true },
    status: { $nin: ['paid', 'rejected', 'cancelled'] },
  } as never);
}

async function pendingLoanSummary(scope: ScopeLike): Promise<{ count: number; total: bigint }> {
  const rows = await Models.BankDebt.find({
    status: 'pending_disbursement',
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds as never } }),
  } as never)
    .select({ principal_minor: 1 })
    .lean<{ principal_minor?: unknown }[]>();
  return { count: rows.length, total: rows.reduce((a, r) => a + asBigInt(r.principal_minor), 0n) };
}

async function failedRunCount(scope: ScopeLike): Promise<number> {
  return Models.AutomationRun.countDocuments({
    status: 'failed',
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds as never } }),
  } as never).exec();
}

/* ------------------------------------------------------------------ *
 * Cache vào `settings` (không thêm collection — arch §8.1)
 * ------------------------------------------------------------------ */

export async function cachedNewsletter(key: string): Promise<Newsletter | null> {
  const doc = await Models.Setting.findOne({ key }).lean<{ value?: Newsletter } | null>();
  return (doc?.value as Newsletter | undefined) ?? null;
}

export async function storeNewsletter(key: string, data: Newsletter): Promise<void> {
  await Models.Setting.updateOne(
    { key },
    { $set: { key, value: data, updated_at: new Date() }, $setOnInsert: { description: 'Bản tin hàng ngày (cache)' } },
    { upsert: true },
  ).exec();
}

/** Ngày bản tin: hôm nay, và cho lịch sử DASH-04. */
export const newsletterDates = (n = 14, from = today()): string[] => Array.from({ length: n }, (_, i) => addDays(from, -i));

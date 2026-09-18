/**
 * Báo cáo quản trị (§XXII) — KIẾN TRÚC 1 runner + N preset (screens §14: "không design
 * 14 layout khác nhau"). Mỗi preset = 1 aggregation + 1 `columns()` khai báo cách format.
 *
 * Mọi số qua `shared/money` (UI + Excel + email cùng hàm), `$match` trước `$group`
 * để đi qua index (arch §14), quyền export check SERVER-SIDE (§19.5-4).
 */

import {
  REPORT_LABEL,
  addDays,
  dayEndOf,
  dayStartOf,
  daysUntil,
  formatMoney,
  money,
  statusLabel,
  today,
  type Role,
} from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { scopedAggregate } from '../../lib/mongo.ts';
import { ROLE_LABEL } from '@fingate/shared';
import { DECISION_STATUSES, asBigInt, wire, type WireAmount } from '../queries/index.ts';
import type { ScopeLike } from '../types.ts';

export interface ReportColumn {
  key: string;
  label: string;
  type: 'text' | 'money' | 'compact' | 'percent' | 'date' | 'number' | 'status' | 'days';
  align: 'left' | 'right' | 'center';
  sortable?: boolean;
  permission?: string;
}

export interface ReportResult {
  preset: string;
  title: string;
  scope_label: string;
  as_of: string;
  generated_by: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown>;
  kpi: { label: string; value: string; note: string | null }[];
  chart: {
    type: 'area' | 'line' | 'bar' | 'stacked' | 'donut';
    x_key: string;
    series: { key: string; label: string; values: (number | null)[] }[];
    threshold: { value: number; label: string } | null;
  } | null;
  truncated: boolean;
  row_count: number;
}

export interface ReportInput {
  scope: ScopeLike;
  from?: string;
  to?: string;
  groupBy?: string;
  limit: number;
  canExport: boolean;
}

/** tỷ → số thực (chart cần number; tiền thật không bao giờ đi đường này). */
const ty = (minor: unknown): number => Number(asBigInt(minor)) / 1e9;

const T = (key: string, label: string, extra: Partial<ReportColumn> = {}): ReportColumn => ({
  key,
  label,
  type: 'text',
  align: 'left',
  ...extra,
});
const C = (key: string, label: string): ReportColumn => T(key, label, { type: 'compact', align: 'right', sortable: true });
const N = (key: string, label: string): ReportColumn => T(key, label, { type: 'number', align: 'right', sortable: true });
const D = (key: string, label: string): ReportColumn => T(key, label, { type: 'date', align: 'left', sortable: true });

async function scopeLabel(scope: ScopeLike): Promise<string> {
  if (scope.companyIds === null) return 'Tất cả công ty';
  const rows = await Models.Company.find({ _id: { $in: scope.companyIds as never } }).select({ name: 1 }).lean();
  return rows.map((r) => String(r.name)).join(' · ') || '—';
}

/** doc_kind → nhãn Việt (cho nhóm "theo loại"). */
const KIND_VI: Record<string, string> = { spend: 'Chi', income: 'Thu', rollover: 'Đảo hạn', internal: 'Chuyển nội bộ' };

export async function reportPreset(preset: string, input: ReportInput): Promise<ReportResult> {
  const base: Omit<ReportResult, 'columns' | 'rows' | 'totals' | 'kpi' | 'chart' | 'row_count' | 'truncated'> = {
    preset,
    title: REPORT_LABEL[preset as keyof typeof REPORT_LABEL] ?? preset,
    scope_label: await scopeLabel(input.scope),
    as_of: new Date().toISOString(),
    generated_by: '',
  };
  const from = input.from ?? addDays(today(), -30);
  const to = input.to ?? addDays(today(), 30);

  switch (preset) {
    /* ---------------- 1 · Thu – chi ngày ---------------- */
    case 'thu-chi-ngay': {
      const rows = await scopedAggregate<{ _id: { date: string; kind: string }; total: unknown; count: number }>(
        Models.Document,
        input.scope,
        [
          { $match: { planned_date: { $gte: dayStartOf(from), $lte: dayEndOf(to) }, status: { $ne: 'draft' } } },
          { $group: { _id: { date: { $substr: ['$planned_date', 0, 10] }, kind: '$kind' }, total: { $sum: '$amount.minor' }, count: { $sum: 1 } } },
          { $sort: { '_id.date': 1 } },
        ],
      );
      const dates = [...new Set(rows.map((r) => r._id.date))];
      const at = (d: string, k: string) => rows.find((r) => r._id.date === d && r._id.kind === k);
      const out = dates.map((d) => {
        const inc = asBigInt(at(d, 'income')?.total ?? 0n);
        const exp = asBigInt(at(d, 'spend')?.total ?? 0n);
        const ren = asBigInt(at(d, 'rollover')?.total ?? 0n);
        return {
          date: d,
          income: wire(inc),
          income_compact: formatMoney(money(inc), { mode: 'compact' }),
          expense: wire(exp),
          expense_compact: formatMoney(money(exp), { mode: 'compact' }),
          rollover: wire(ren),
          net: wire(inc - exp),
          net_compact: formatMoney(money(inc - exp), { mode: 'compact' }),
          documents: (at(d, 'income')?.count ?? 0) + (at(d, 'spend')?.count ?? 0),
        };
      });
      const totalIn = out.reduce((a, r) => a + asBigInt(r.income.minor), 0n);
      const totalOut = out.reduce((a, r) => a + asBigInt(r.expense.minor), 0n);
      return {
        ...base,
        columns: [D('date', 'Ngày'), C('income_compact', 'Thu'), C('expense_compact', 'Chi'), C('rollover' as never, 'Đảo hạn') as never, C('net_compact', 'Thuần'), N('documents', 'Số phiếu')] as ReportColumn[],
        rows: out,
        totals: { income: wire(totalIn), expense: wire(totalOut), net: wire(totalIn - totalOut) },
        kpi: [
          { label: 'Tổng thu', value: formatMoney(money(totalIn), { mode: 'kpi' }), note: `${from} → ${to}` },
          { label: 'Tổng chi', value: formatMoney(money(totalOut), { mode: 'kpi' }), note: null },
          { label: 'Dòng tiền thuần', value: formatMoney(money(totalIn - totalOut), { mode: 'kpi' }), note: totalIn - totalOut < 0n ? 'âm' : null },
        ],
        chart: {
          type: 'bar',
          x_key: 'date',
          series: [
            { key: 'income', label: 'Thu', values: out.map((r) => ty(r.income.minor)) },
            { key: 'expense', label: 'Chi', values: out.map((r) => ty(r.expense.minor)) },
          ],
          threshold: null,
        },
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 2 · Thu – chi tháng ---------------- */
    case 'thu-chi-thang': {
      const rows = await scopedAggregate<{ _id: string; income: unknown; expense: unknown; count: number }>(
        Models.Document,
        input.scope,
        [
          { $match: { status: { $ne: 'draft' } } },
          { $project: { month: { $substr: ['$planned_date', 0, 7] }, kind: 1, minor: '$amount.minor' } },
          { $group: { _id: '$month', income: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, '$minor', 0] } }, expense: { $sum: { $cond: [{ $eq: ['$kind', 'spend'] }, '$minor', 0] } }, count: { $sum: 1 } } },
          { $sort: { _id: -1 } },
          { $limit: 13 },
        ],
      );
      const out = rows.map((r) => ({
        month: r._id,
        income: wire(asBigInt(r.income)),
        income_compact: formatMoney(money(asBigInt(r.income)), { mode: 'compact' }),
        expense: wire(asBigInt(r.expense)),
        expense_compact: formatMoney(money(asBigInt(r.expense)), { mode: 'compact' }),
        net_compact: formatMoney(money(asBigInt(r.income) - asBigInt(r.expense)), { mode: 'compact' }),
        count: r.count,
      }));
      return {
        ...base,
        columns: [T('month', 'Tháng'), C('income_compact', 'Thu'), C('expense_compact', 'Chi'), C('net_compact', 'Thuần'), N('count', 'Số phiếu')],
        rows: out,
        totals: {},
        kpi: out.slice(0, 1).map((r) => ({ label: r.month, value: r.net_compact, note: 'so sánh với kỳ trước ở bảng' })),
        chart: { type: 'bar', x_key: 'month', series: [{ key: 'income', label: 'Thu', values: out.map((r) => ty(r.income.minor)) }, { key: 'expense', label: 'Chi', values: out.map((r) => ty(r.expense.minor)) }], threshold: null },
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 3 · Số dư ngân hàng ---------------- */
    case 'so-du-ngan-hang': {
      const latest = await scopedAggregate<{ _id: string; date: string; closing: unknown; blocked: unknown }>(
        Models.BalanceDaily,
        input.scope,
        [{ $sort: { date: -1 } }, { $group: { _id: '$account_id', date: { $first: '$date' }, closing: { $first: '$closing_minor' }, blocked: { $first: '$blocked_minor' }, company: { $first: '$company_id' } } }],
      );
      const accounts = await Models.BankAccount.find({}).select({ bank_name: 1, account_number: 1, company_id: 1 }).lean();
      const amap = new Map(accounts.map((a) => [String(a._id), a]));
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      const out = latest.map((l) => {
        const a = amap.get(String(l._id));
        const closing = asBigInt(l.closing);
        const blocked = asBigInt(l.blocked);
        return {
          company_name: cmap.get(String((a as { company_id?: unknown } | undefined)?.company_id ?? '')) ?? 'Tập đoàn',
          bank_name: String((a as { bank_name?: string } | undefined)?.bank_name ?? '—'),
          account: String((a as { account_number?: string } | undefined)?.account_number ?? ''),
          balance: wire(closing),
          balance_compact: formatMoney(money(closing), { mode: 'compact' }),
          available_compact: formatMoney(money(closing - blocked), { mode: 'compact' }),
          blocked_compact: formatMoney(money(blocked), { mode: 'compact' }),
          as_of: l.date,
        };
      });
      const total = out.reduce((a, r) => a + asBigInt(r.balance.minor), 0n);
      return {
        ...base,
        columns: [T('company_name', 'Công ty'), T('bank_name', 'Ngân hàng'), T('account', 'Số TK'), C('balance_compact', 'Số dư'), C('available_compact', 'Khả dụng'), C('blocked_compact', 'Phong tỏa'), D('as_of', 'Cập nhật')],
        rows: out,
        totals: { balance: wire(total) },
        kpi: [{ label: 'Tổng số dư', value: formatMoney(money(total), { mode: 'kpi' }), note: null }],
        chart: { type: 'donut', x_key: 'bank_name', series: [{ key: 'balance', label: 'Số dư', values: out.map((r) => ty(r.balance.minor)) }], threshold: null },
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 4/5 · Công nợ phải thu / phải trả ---------------- */
    case 'cong-no-phai-thu':
    case 'cong-no-phai-tra': {
      const kind = preset === 'cong-no-phai-thu' ? 'receivable' : 'payable';
      const rows = await scopedAggregate<{ _id: string; value: unknown; settled: unknown; count: number; oldest_due: string }>(
        Models.DebtItem,
        input.scope,
        [
          { $match: { kind } },
          { $group: { _id: '$counterparty_name', value: { $sum: '$value_minor' }, settled: { $sum: '$settled_minor' }, count: { $sum: 1 }, oldest_due: { $min: '$due_date' } } },
          { $sort: { value: -1 } },
          { $limit: input.limit },
        ],
      );
      const out = rows.map((r) => {
        const remaining = asBigInt(r.value) - asBigInt(r.settled);
        const overdue = r.oldest_due && r.oldest_due < today() ? -daysUntil(r.oldest_due) : 0;
        return {
          counterparty: r._id,
          value_compact: formatMoney(money(asBigInt(r.value)), { mode: 'compact' }),
          settled_compact: formatMoney(money(asBigInt(r.settled)), { mode: 'compact' }),
          remaining: wire(remaining),
          remaining_compact: formatMoney(money(remaining), { mode: 'compact' }),
          count: r.count,
          days_overdue: overdue,
          due_date: r.oldest_due,
        };
      });
      const totalRemaining = out.reduce((a, r) => a + asBigInt(r.remaining.minor), 0n);
      return {
        ...base,
        columns: [T('counterparty', kind === 'receivable' ? 'Khách hàng' : 'Nhà cung cấp'), C('value_compact', 'Giá trị'), C('settled_compact', 'Đã xử lý'), C('remaining_compact', 'Còn lại'), N('count', 'Số HĐ'), D('due_date', 'Hạn'), N('days_overdue', 'Quá hạn (ngày)')],
        rows: out,
        totals: { remaining: wire(totalRemaining) },
        kpi: [{ label: kind === 'receivable' ? 'Tổng còn phải thu' : 'Tổng còn phải trả', value: formatMoney(money(totalRemaining), { mode: 'kpi' }), note: null }],
        chart: { type: 'bar', x_key: 'counterparty', series: [{ key: 'remaining', label: 'Còn lại', values: out.slice(0, 8).map((r) => ty(r.remaining.minor)) }], threshold: null },
        truncated: rows.length >= input.limit,
        row_count: out.length,
      };
    }

    /* ---------------- 6 · Vay ngân hàng ---------------- */
    case 'vay-ngan-hang': {
      const loans = await Models.Loan.find(
        input.scope.companyIds === null ? ({} as never) : ({ company_id: { $in: input.scope.companyIds as never[] } } as never),
      )
        .select({ company_id: 1, bank_name: 1, contract_code: 1, outstanding_minor: 1, limit_minor: 1, maturity_date: 1, interest_rate: 1, status: 1 })
        .lean();
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      const out = loans.map((l) => ({
        company_name: cmap.get(String(l.company_id)) ?? '',
        bank_name: String(l.bank_name),
        contract_code: String(l.contract_code),
        limit_compact: formatMoney(money(asBigInt(l.limit_minor)), { mode: 'compact' }),
        outstanding: wire(asBigInt(l.outstanding_minor)),
        outstanding_compact: formatMoney(money(asBigInt(l.outstanding_minor)), { mode: 'compact' }),
        interest_rate: String(l.interest_rate),
        maturity_date: String(l.maturity_date),
        days_to_due: daysUntil(String(l.maturity_date)),
        status: String(l.status),
      }));
      const total = out.reduce((a, r) => a + asBigInt(r.outstanding.minor), 0n);
      return {
        ...base,
        columns: [T('company_name', 'Công ty'), T('bank_name', 'Ngân hàng'), T('contract_code', 'HĐTD'), C('limit_compact', 'Hạn mức'), C('outstanding_compact', 'Dư nợ'), T('interest_rate', 'Lãi suất'), D('maturity_date', 'Đáo hạn'), N('days_to_due', 'Còn lại')],
        rows: out,
        totals: { outstanding: wire(total) },
        kpi: [{ label: 'Tổng dư nợ', value: formatMoney(money(total), { mode: 'kpi' }), note: `${out.length} hợp đồng` }],
        chart: null,
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 7 · Đáo hạn ---------------- */
    case 'dao-han': {
      const loans = await Models.Loan.find(
        input.scope.companyIds === null ? ({ status: { $in: ['active', 'overdue'] } } as never) : ({ company_id: { $in: input.scope.companyIds as never[] }, status: { $in: ['active', 'overdue'] } } as never),
      )
        .select({ company_id: 1, bank_name: 1, contract_code: 1, outstanding_minor: 1, maturity_date: 1 })
        .sort({ maturity_date: 1 })
        .lean();
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      const out = loans.map((l) => {
        const days = daysUntil(String(l.maturity_date));
        return {
          company_name: cmap.get(String(l.company_id)) ?? '',
          bank_name: String(l.bank_name),
          contract_code: String(l.contract_code),
          outstanding: wire(asBigInt(l.outstanding_minor)),
          outstanding_compact: formatMoney(money(asBigInt(l.outstanding_minor)), { mode: 'compact' }),
          maturity_date: String(l.maturity_date),
          days_to_due: days,
          bucket: days <= 0 ? 'Hôm nay' : days <= 3 ? '3 ngày' : days <= 7 ? '4–7 ngày' : days <= 30 ? '8–30 ngày' : '> 30 ngày',
          tone: days <= 3 ? 'danger' : days <= 7 ? 'warning' : days <= 30 ? 'attention' : 'neutral',
        };
      });
      const bucketSum = (b: string) => out.filter((r) => r.bucket === b).reduce((a, r) => a + asBigInt(r.outstanding.minor), 0n);
      return {
        ...base,
        columns: [T('company_name', 'Công ty'), T('bank_name', 'Ngân hàng'), T('contract_code', 'Khoản vay'), C('outstanding_compact', 'Dư nợ'), D('maturity_date', 'Đáo hạn'), N('days_to_due', 'Còn lại'), T('bucket', 'Nhóm')],
        rows: out,
        totals: { today: wire(bucketSum('Hôm nay')), d7: wire(bucketSum('4–7 ngày') + bucketSum('3 ngày') + bucketSum('Hôm nay')) },
        kpi: [
          { label: 'Đáo hạn hôm nay', value: formatMoney(money(bucketSum('Hôm nay')), { mode: 'kpi' }), note: null },
          { label: 'Trong 7 ngày', value: formatMoney(money(bucketSum('Hôm nay') + bucketSum('3 ngày') + bucketSum('4–7 ngày')), { mode: 'kpi' }), note: null },
          { label: 'Trong 30 ngày', value: formatMoney(money(out.filter((r) => r.days_to_due <= 30).reduce((a, r) => a + asBigInt(r.outstanding.minor), 0n)), { mode: 'kpi' }), note: null },
        ],
        chart: null,
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 8 · Dòng tiền (dùng chung FgCashFlowTable với CASH-01) ---------------- */
    case 'dong-tien': {
      const rows = await scopedAggregate<{ _id: string; in: unknown; out: unknown }>(
        Models.Document,
        input.scope,
        [
          { $match: { planned_date: { $gte: dayStartOf(from), $lte: dayEndOf(to) }, status: { $ne: 'draft' } } },
          { $group: { _id: { $substr: ['$planned_date', 0, 10] }, in: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, '$amount.minor', 0] } }, out: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, 0, '$amount.minor'] } } } },
          { $sort: { _id: 1 } },
        ],
      );
      const companies = await Models.Company.find(input.scope.companyIds === null ? {} : { _id: { $in: input.scope.companyIds as never } }).select({ min_balance_minor: 1 }).lean();
      const threshold = companies.reduce((a, c) => a + asBigInt(c.min_balance_minor), 0n);
      const opening = (
        await scopedAggregate<{ total: unknown }>(Models.BalanceDaily, input.scope, [{ $match: { date: { $lte: from } } }, { $sort: { date: -1 } }, { $group: { _id: '$account_id', closing: { $first: '$closing_minor' } } }, { $group: { _id: null, total: { $sum: '$closing' } } }])
      )[0];
      let running = asBigInt(opening?.total ?? 0n);
      const out = rows.map((r) => {
        const inn = asBigInt(r.in);
        const ot = asBigInt(r.out);
        const start = running;
        running = start + inn - ot;
        return {
          date: r._id,
          opening: wire(start),
          inflow_compact: formatMoney(money(inn), { mode: 'compact' }),
          outflow_compact: formatMoney(money(ot), { mode: 'compact' }),
          closing: wire(running),
          closing_compact: formatMoney(money(running), { mode: 'compact' }),
          breach: running < threshold,
        };
      });
      return {
        ...base,
        columns: [D('date', 'Ngày'), C('opening' as never, 'Đầu kỳ') as never, C('inflow_compact', 'Thu'), C('outflow_compact', 'Chi'), C('closing_compact', 'Cuối kỳ')],
        rows: out,
        totals: {},
        kpi: [{ label: 'Số dư cuối kỳ dự kiến', value: formatMoney(money(running), { mode: 'kpi' }), note: threshold > 0n ? `Ngưỡng ${formatMoney(money(threshold), { mode: 'compact' })}` : null }],
        chart: { type: 'area', x_key: 'date', series: [{ key: 'closing', label: 'Số dư cuối kỳ', values: out.map((r) => ty(r.closing.minor)) }], threshold: threshold > 0n ? { value: ty(threshold), label: 'Ngưỡng tối thiểu' } : null },
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 9 · Chi theo bộ phận ---------------- */
    case 'chi-bo-phan': {
      const rows = await groupByDimension(input, 'department_id', 'department');
      return { ...base, ...rows, truncated: false, row_count: rows.rows.length, chart: { type: 'bar', x_key: 'label', series: [{ key: 'amount', label: 'Chi', values: rows.rows.slice(0, 6).map((r) => ty((r as { amount: WireAmount }).amount.minor)) }], threshold: null } };
    }

    /* ---------------- 10 · Chi theo loại ---------------- */
    case 'chi-loai': {
      const rows = await groupByDimension(input, 'category_id', 'category');
      return { ...base, ...rows, truncated: false, row_count: rows.rows.length, chart: { type: 'donut', x_key: 'label', series: [{ key: 'amount', label: 'Chi', values: rows.rows.slice(0, 4).map((r) => ty((r as { amount: WireAmount }).amount.minor)) }], threshold: null } };
    }

    /* ---------------- 11 · So sánh theo công ty ---------------- */
    case 'theo-cong-ty': {
      const rows = await scopedAggregate<{ _id: unknown; income: unknown; expense: unknown; count: number }>(
        Models.Document,
        input.scope,
        [
          { $match: { status: { $ne: 'draft' }, planned_date: { $gte: dayStartOf(from), $lte: dayEndOf(to) } } },
          { $group: { _id: '$company_id', income: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, '$amount.minor', 0] } }, expense: { $sum: { $cond: [{ $eq: ['$kind', 'spend'] }, '$amount.minor', 0] } }, count: { $sum: 1 } } },
          { $sort: { expense: -1 } },
        ],
      );
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      const out = rows.map((r) => {
        const inc = asBigInt(r.income);
        const exp = asBigInt(r.expense);
        return {
          company_name: cmap.get(String(r._id)) ?? '—',
          income_compact: formatMoney(money(inc), { mode: 'compact' }),
          expense_compact: formatMoney(money(exp), { mode: 'compact' }),
          net_compact: formatMoney(money(inc - exp), { mode: 'compact' }),
          documents: r.count,
        };
      });
      return {
        ...base,
        columns: [T('company_name', 'Công ty'), C('income_compact', 'Thu'), C('expense_compact', 'Chi'), C('net_compact', 'Thuần'), N('documents', 'Số phiếu')],
        rows: out,
        totals: {},
        kpi: out.slice(0, 3).map((r) => ({ label: r.company_name, value: r.net_compact, note: null })),
        chart: { type: 'stacked', x_key: 'company_name', series: [{ key: 'income', label: 'Thu', values: out.map((r) => Number(r.income_compact.replace(/\D/g, '') || 0)) }, { key: 'expense', label: 'Chi', values: out.map((r) => Number(r.expense_compact.replace(/\D/g, '') || 0)) }], threshold: null },
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 12 · Khoản chờ duyệt (aging phê duyệt) ---------------- */
    case 'cho-duyet': {
      const rows = await Models.Document.find(
        (input.scope.companyIds === null
          ? { status: { $in: [...DECISION_STATUSES] } }
          : { company_id: { $in: input.scope.companyIds as never[] }, status: { $in: [...DECISION_STATUSES] } }) as never,
      )
        .select({ code: 1, kind: 1, company_id: 1, amount: 1, approval: 1, submitted_at: 1, sla_deadline: 1, title: 1 })
        .limit(500)
        .lean();
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      const out = rows.map((d) => {
        const steps = ((d.approval as { steps?: { role: Role; state: string }[] }) ?? { steps: [] }).steps ?? [];
        const current = steps.find((s) => s.state === 'current') ?? steps.find((s) => s.state === 'waiting');
        const waiting = d.submitted_at ? Math.floor((Date.now() - new Date(d.submitted_at).getTime()) / 86_400_000) : 0;
        const overdue = d.sla_deadline ? new Date(d.sla_deadline) < new Date() : false;
        return {
          code: String(d.code),
          company_name: cmap.get(String(d.company_id)) ?? '',
          title: String(d.title ?? ''),
          kind: KIND_VI[String(d.kind)] ?? String(d.kind),
          amount: wire(asBigInt((d.amount as { minor?: unknown })?.minor)),
          amount_compact: formatMoney(money(asBigInt((d.amount as { minor?: unknown })?.minor)), { mode: 'compact' }),
          owner: current ? (ROLE_LABEL[current.role] ?? current.role) : '—',
          waiting_days: waiting,
          status_label: statusLabel(String(d.status)),
          overdue,
        };
      });
      out.sort((a, b) => b.waiting_days - a.waiting_days);
      const total = out.reduce((a, r) => a + asBigInt(r.amount.minor), 0n);
      const byOwner = new Map<string, { count: number; amount: bigint }>();
      for (const r of out) {
        const cur = byOwner.get(r.owner) ?? { count: 0, amount: 0n };
        byOwner.set(r.owner, { count: cur.count + 1, amount: cur.amount + asBigInt(r.amount.minor) });
      }
      return {
        ...base,
        columns: [T('code', 'Mã'), T('company_name', 'Công ty'), T('title', 'Nội dung'), T('kind', 'Loại'), C('amount_compact', 'Số tiền'), T('owner', 'Cấp duyệt'), N('waiting_days', 'Đã chờ'), T('status_label', 'Trạng thái')],
        rows: out,
        totals: { amount: wire(total) },
        kpi: [
          { label: 'Đang chờ duyệt', value: `${out.length} khoản`, note: formatMoney(money(total), { mode: 'kpi' }) },
          ...[...byOwner.entries()].slice(0, 4).map(([owner, v]) => ({ label: owner, value: formatMoney(money(v.amount), { mode: 'compact' }), note: `${v.count} khoản` })),
        ],
        chart: null,
        truncated: rows.length >= 500,
        row_count: out.length,
      };
    }

    /* ---------------- 13 · Hiệu suất phòng kế toán ---------------- */
    case 'hs-ketoan': {
      const rows = await scopedAggregate<{ _id: unknown; docs: number; decisions: number; rejected: number }>(
        Models.Document,
        input.scope,
        [
          { $match: { 'approval.steps.user_id': { $exists: true, $ne: null } } },
          { $unwind: '$approval.steps' },
          { $group: { _id: '$approval.steps.user_id', docs: { $addToSet: '$_id' }, decisions: { $sum: { $cond: [{ $eq: ['$approval.steps.state', 'done'] }, 1, 0] } }, rejected: { $sum: { $cond: [{ $eq: ['$approval.steps.state', 'rejected'] }, 1, 0] } } } },
          { $project: { decisions: 1, rejected: 1, docs: { $size: '$docs' } } },
          { $sort: { decisions: -1 } },
          { $limit: 40 },
        ],
      );
      const userIds = rows.map((r) => String(r._id));
      const users = userIds.length ? await Models.User.find({ _id: { $in: userIds as never } }).select({ display_name: 1, email: 1 }).lean() : [];
      const umap = new Map(users.map((u) => [String(u._id), String(u.display_name ?? u.email)]));
      const slaRows = await Models.Document.find({ 'approval.steps.user_id': { $in: userIds as never } } as never)
        .select({ 'approval.steps': 1 })
        .limit(2000)
        .lean();
      const stats = new Map<string, { decided: number; late: number; total_hours: number }>();
      for (const d of slaRows) {
        for (const s of ((d.approval as { steps?: { user_id?: string | null; state?: string; decided_at?: Date | null; sla_deadline?: Date | null }[] }) ?? { steps: [] }).steps ?? []) {
          if (!s.user_id || s.state !== 'done' || !s.decided_at) continue;
          const key = String(s.user_id);
          const cur = stats.get(key) ?? { decided: 0, late: 0, total_hours: 0 };
          cur.decided++;
          if (s.sla_deadline && new Date(s.decided_at) > new Date(s.sla_deadline)) cur.late++;
          stats.set(key, cur);
        }
      }
      const out = rows
        .map((r) => {
          const st = stats.get(String(r._id)) ?? { decided: 0, late: 0, total_hours: 0 };
          return {
            user_name: umap.get(String(r._id)) ?? '—',
            docs: r.docs,
            decisions: r.decisions,
            sla_breaches: st.late,
            sla_percent: st.decided ? Math.round(((st.decided - st.late) / st.decided) * 100) : 100,
            rejected: r.rejected,
          };
        })
        .filter((r) => r.decisions > 0);
      const sampleEnough = out.length > 0 && out.reduce((a, r) => a + r.decisions, 0) >= 10;
      return {
        ...base,
        columns: [T('user_name', 'Người xử lý'), N('docs', 'Số hồ sơ liên quan'), N('decisions', 'Số quyết định'), N('sla_breaches', 'Quá SLA'), T('sla_percent', 'Đúng SLA', { type: 'percent', align: 'right', sortable: true }), N('rejected', 'Từ chối')],
        rows: sampleEnough ? out : [],
        totals: {},
        kpi: sampleEnough ? [] : [{ label: 'Chưa đủ mẫu', value: 'Không xếp hạng khi dưới 10 hồ sơ', note: null }],
        chart: null,
        truncated: false,
        row_count: out.length,
      };
    }

    default:
      return { ...base, columns: [], rows: [], totals: {}, kpi: [], chart: null, truncated: false, row_count: 0 };
  }
}

/** Nhóm theo dimension (bộ phận / danh mục) — dùng cho RPT-09/10. */
async function groupByDimension(input: ReportInput, field: string, kind: 'department' | 'category'): Promise<Pick<ReportResult, 'columns' | 'rows' | 'totals' | 'kpi'>> {
  const rows = await scopedAggregate<{ _id: unknown; total: unknown; count: number }>(
    Models.Document,
    input.scope,
    [
      { $match: { kind: 'spend', status: { $ne: 'draft' } } },
      { $group: { _id: `$${field}`, total: { $sum: '$amount.minor' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
      { $limit: input.limit },
    ],
  );
  const ids = rows.map((r) => r._id).filter(Boolean) as string[];
  const lookup = ids.length
    ? kind === 'department'
      ? (await Models.Department.find({ _id: { $in: ids as never } } as never).select({ name: 1 }).lean()) as { _id: unknown; name?: string }[]
      : (await Models.Category.find({ _id: { $in: ids as never } } as never).select({ name: 1 }).lean()) as { _id: unknown; name?: string }[]
    : [];
  const map = new Map(lookup.map((d) => [String(d._id), String(d.name)]));
  const total = rows.reduce((a, r) => a + asBigInt(r.total), 0n);
  const out = rows.map((r) => {
    const amount = asBigInt(r.total);
    return {
      label: r._id ? (map.get(String(r._id)) ?? 'Chưa gán') : 'Chưa gán',
      amount: wire(amount),
      amount_compact: formatMoney(money(amount), { mode: 'compact' }),
      percent: total > 0n ? Number((amount * 10_000n) / total) / 100 : 0,
      count: r.count,
    };
  });
  return {
    columns: [T('label', kind === 'department' ? 'Bộ phận' : 'Loại khoản chi'), C('amount_compact', 'Số tiền'), T('percent', '% tổng', { type: 'percent', align: 'right', sortable: true }), N('count', 'Số phiếu')],
    rows: out,
    totals: { amount: wire(total) },
    kpi: [
      { label: 'Tổng chi', value: formatMoney(money(total), { mode: 'kpi' }), note: `${out.length} nhóm` },
      ...out.slice(0, 3).map((r) => ({ label: r.label, value: r.amount_compact, note: `${r.percent.toFixed(1)}%` })),
    ],
  };
}

/**
 * Báo cáo quản trị (§XXII; v2 §12) — KIẾN TRÚC 1 runner + N preset (screens §14: "không design
 * 14 layout khác nhau"). Mỗi preset = 1 aggregation + 1 khai báo cột (format).
 *
 * v2:
 *   · lọc theo `partner_id` và `tag_ids` trên các báo cáo hiện có;
 *   · thu–chi (ngày/tháng/theo công ty/dòng tiền) LOẠI chuyển nội bộ khỏi doanh thu/chi phí;
 *   · tên đối tác/ngân hàng lấy theo `partner_id` (không dùng text v1);
 *   · số dư ngân hàng: chỉ sổ cái + dự kiến (không còn khả dụng/phong toả);
 *   · preset mới: theo đối tác, theo tag (gộp theo tên chuẩn hoá), sổ chi tiết đối tác.
 *
 * Mọi số qua `shared/money` (UI + Excel cùng hàm); `$match` trước `$group` để đi qua index;
 * quyền export check SERVER-SIDE (§19.5-4).
 */

import {
  REPORT_LABEL,
  ROLE_LABEL,
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
import { oid, scopedAggregate } from '../../lib/mongo.ts';
import { DECISION_STATUSES, asBigInt, wire, type WireAmount } from '../queries/index.ts';
import { parseRate, simpleInterest } from '../loan-schedule/index.ts';
import { ledgerAccountViews } from '../accounts.ts';
import type { ScopeLike } from '../types.ts';
import {
  debtDirectionOf,
  executedSum,
  groupByTagName,
  outstandingLoanOf,
  overdueDaysOf,
  partnerActivityOf,
  percentOf,
  remainingOf,
  type ReportDocLike,
} from './aggregate.ts';
import {
  groupSettlements,
  loadDebtSettlements,
  loadInternalDocIds,
  loadLoanSettlements,
  loadPartnerRefs,
  loadTagRefs,
  partnerNameOf,
} from './refs.ts';
import { buildPartnerLedger, loadPartnerLedgerEvents } from './partner-ledger.ts';
import { bankOutstandingByPartner, partnerExposures } from './dashboard.ts';
import { toBig } from '../links/index.ts';
import { PIPELINE_STATUSES, PLANNED_FLOW_STATUSES } from '../ledger/planned.ts';

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
  /** lọc theo đối tác (ID). Bắt buộc với `so-chi-tiet-doi-tac`. */
  partnerId?: string | null;
  /** lọc theo tag (ID). */
  tagIds?: string[];
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
const compactOf = (minor: bigint): string => formatMoney(money(minor), { mode: 'compact' });

async function scopeLabel(scope: ScopeLike): Promise<string> {
  if (scope.companyIds === null) return 'Tất cả công ty';
  const rows = await Models.Company.find({ _id: { $in: scope.companyIds as never } }).select({ name: 1 }).lean();
  return rows.map((r) => String(r.name)).join(' · ') || '—';
}

/** doc_kind → nhãn Việt (cho nhóm "theo loại"). */
const KIND_VI: Record<string, string> = { spend: 'Chi', income: 'Thu', rollover: 'Đảo hạn', internal: 'Chuyển nội bộ' };

const OID_RE = /^[0-9a-fA-F]{24}$/;

/** ObjectId của tập phiếu nội bộ (để `$nin` trong aggregate). */
function internalOids(internal: ReadonlySet<string>): unknown[] {
  return [...internal].filter((id) => OID_RE.test(id)).map((id) => oid(id));
}

/**
 * Điều kiện phiếu dùng chung: lọc đối tác/tag và (tuỳ chọn) loại chuyển nội bộ.
 * Trả về object đã cast ObjectId để dùng được trong `$match` của aggregate.
 */
function docFilter(input: ReportInput, internal: ReadonlySet<string> | null): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (input.partnerId) f.partner_id = oid(input.partnerId);
  if (input.tagIds?.length) f.tag_ids = { $in: input.tagIds.filter((t) => OID_RE.test(t)).map((t) => oid(t)) };
  if (internal) {
    const ids = internalOids(internal);
    if (ids.length) f._id = { $nin: ids };
  }
  return f;
}

/** Phiếu (đã nạp) để tổng hợp ở JS: theo tag, theo đối tác. */
async function reportDocs(input: ReportInput, from: string, to: string, internal: ReadonlySet<string>): Promise<ReportDocLike[]> {
  const filter: Record<string, unknown> = {
    planned_date: { $gte: dayStartOf(from), $lte: dayEndOf(to) },
    status: { $in: [...PLANNED_FLOW_STATUSES] },
    ...docFilter(input, internal),
  };
  if (input.scope.companyIds !== null) filter.company_id = { $in: input.scope.companyIds.map((id) => oid(id)) };
  const rows = await Models.Document.find(filter as never)
    .select({ kind: 1, company_id: 1, amount: 1, partner_id: 1, tag_ids: 1 })
    .limit(50_000)
    .lean<Record<string, unknown>[]>();
  return rows.map((r) => ({
    id: String(r._id),
    kind: String(r.kind ?? ''),
    company_id: String(r.company_id ?? ''),
    amount: toBig((r.amount as { minor?: unknown } | undefined)?.minor),
    partner_id: r.partner_id ? String(r.partner_id) : null,
    tag_ids: ((r.tag_ids as unknown[] | undefined) ?? []).map((t) => String(t)),
  }));
}

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
  const internal = await loadInternalDocIds();

  switch (preset) {
    /* ---------------- 1 · Thu – chi ngày (không tính chuyển nội bộ) ---------------- */
    case 'thu-chi-ngay': {
      const rows = await scopedAggregate<{ _id: { date: string; kind: string }; total: unknown; count: number }>(
        Models.Document,
        input.scope,
        [
          { $match: { planned_date: { $gte: dayStartOf(from), $lte: dayEndOf(to) }, status: { $in: [...PLANNED_FLOW_STATUSES] }, ...docFilter(input, internal) } },
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
          income_compact: compactOf(inc),
          expense: wire(exp),
          expense_compact: compactOf(exp),
          rollover: wire(ren),
          net: wire(inc - exp),
          net_compact: compactOf(inc - exp),
          documents: (at(d, 'income')?.count ?? 0) + (at(d, 'spend')?.count ?? 0),
        };
      });
      const totalIn = out.reduce((a, r) => a + asBigInt(r.income.minor), 0n);
      const totalOut = out.reduce((a, r) => a + asBigInt(r.expense.minor), 0n);
      return {
        ...base,
        columns: [D('date', 'Ngày'), C('income', 'Thu'), C('expense', 'Chi'), C('rollover' as never, 'Đảo hạn') as never, C('net', 'Thuần'), N('documents', 'Số phiếu')] as ReportColumn[],
        rows: out,
        totals: { income: wire(totalIn), expense: wire(totalOut), net: wire(totalIn - totalOut) },
        kpi: [
          { label: 'Tổng thu', value: formatMoney(money(totalIn), { mode: 'kpi' }), note: `${from} → ${to}` },
          { label: 'Tổng chi', value: formatMoney(money(totalOut), { mode: 'kpi' }), note: 'không gồm chuyển nội bộ' },
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

    /* ---------------- 2 · Thu – chi tháng (không tính chuyển nội bộ) ---------------- */
    case 'thu-chi-thang': {
      const rows = await scopedAggregate<{ _id: string; income: unknown; expense: unknown; count: number }>(
        Models.Document,
        input.scope,
        [
          { $match: { status: { $in: [...PLANNED_FLOW_STATUSES] }, kind: { $in: ['income', 'spend'] }, ...docFilter(input, internal) } },
          { $project: { month: { $substr: ['$planned_date', 0, 7] }, kind: 1, minor: '$amount.minor' } },
          { $group: { _id: '$month', income: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, '$minor', 0] } }, expense: { $sum: { $cond: [{ $eq: ['$kind', 'spend'] }, '$minor', 0] } }, count: { $sum: 1 } } },
          { $sort: { _id: -1 } },
          { $limit: 13 },
        ],
      );
      const out = rows.map((r) => ({
        month: r._id,
        income: wire(asBigInt(r.income)),
        income_compact: compactOf(asBigInt(r.income)),
        expense: wire(asBigInt(r.expense)),
        expense_compact: compactOf(asBigInt(r.expense)),
        net: wire(asBigInt(r.income) - asBigInt(r.expense)),
        net_compact: compactOf(asBigInt(r.income) - asBigInt(r.expense)),
        count: r.count,
      }));
      return {
        ...base,
        columns: [T('month', 'Tháng'), C('income', 'Thu'), C('expense', 'Chi'), C('net', 'Thuần'), N('count', 'Số phiếu')],
        rows: out,
        totals: {},
        kpi: out.slice(0, 1).map((r) => ({ label: r.month, value: r.net_compact, note: 'so sánh với kỳ trước ở bảng' })),
        chart: {
          type: 'bar',
          x_key: 'month',
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

    /* ---------------- 3 · Số dư ngân hàng (sổ cái + dự kiến; không phong toả/khả dụng) ---------------- */
    case 'so-du-ngan-hang': {
      const asOf = input.to ?? today();
      const views = await ledgerAccountViews(input.scope, { asOf, horizonDays: 30, includeGroup: input.scope.companyIds !== null });
      const out = views.map((v) => ({
        company_name: v.company_name,
        bank_name: v.bank_name || '—',
        account: v.account_number_masked,
        balance: wire(v.actual, v.currency),
        balance_compact: compactOf(v.actual),
        projected: wire(v.projected, v.currency),
        projected_compact: compactOf(v.projected),
        min_balance: wire(v.min_balance, v.currency),
        breach: v.breach || v.breach_projected,
        as_of: v.balance_date ?? asOf,
      }));
      const total = views.reduce((a, v) => a + v.actual, 0n);
      const projected = views.reduce((a, v) => a + v.projected, 0n);
      return {
        ...base,
        columns: [
          T('company_name', 'Công ty'),
          T('bank_name', 'Ngân hàng / quỹ'),
          T('account', 'Số TK'),
          C('balance', 'Số dư thực tế'),
          C('projected', 'Dự kiến (30 ngày)'),
          C('min_balance', 'Tối thiểu'),
          T('breach', 'Vi phạm', { type: 'status', align: 'center' }),
          D('as_of', 'Cập nhật'),
        ],
        rows: out,
        totals: { balance: wire(total), projected: wire(projected) },
        kpi: [
          { label: 'Tổng số dư thực tế', value: formatMoney(money(total), { mode: 'kpi' }), note: `đến ${asOf}` },
          { label: 'Dự kiến 30 ngày', value: formatMoney(money(projected), { mode: 'kpi' }), note: 'gồm phiếu đã gửi duyệt chưa thực thi' },
        ],
        chart: { type: 'donut', x_key: 'bank_name', series: [{ key: 'balance', label: 'Số dư', values: out.map((r) => ty(r.balance.minor)) }], threshold: null },
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 4/5 · Công nợ phải thu / phải trả (theo đối tác) ---------------- */
    case 'cong-no-phai-thu':
    case 'cong-no-phai-tra': {
      const want = preset === 'cong-no-phai-thu' ? 'receivable' : 'payable';
      // Nhân viên (TK 334) chỉ đọc, không thuộc đối tác: loại khỏi báo cáo phải thu / phải trả theo đối tác.
      const debtFilter: Record<string, unknown> = { party_type: { $ne: 'employee' } };
      if (input.scope.companyIds !== null) debtFilter.company_id = { $in: input.scope.companyIds.map((id) => oid(id)) };
      if (input.partnerId) debtFilter.partner_id = oid(input.partnerId);
      const vouchers = await Models.DebtVoucher.find(debtFilter as never)
        .select({ company_id: 1, partner_id: 1, direction: 1, side: 1, value_minor: 1, due_date: 1 })
        .lean<Record<string, unknown>[]>();
      const mine = vouchers.filter((v) => debtDirectionOf(v as never) === want);
      const settlements = await loadDebtSettlements(mine.map((v) => ({ id: String(v._id) })));
      const byDebt = groupSettlements(settlements);
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      const partners = await loadPartnerRefs(mine.map((v) => (v.partner_id ? String(v.partner_id) : null)));

      const groups = new Map<string, { company: string; partner: string; value: bigint; settled: bigint; count: number; oldest: string }>();
      for (const v of mine) {
        const pname = partnerNameOf(partners, v.partner_id ? String(v.partner_id) : null);
        const key = `${String(v.company_id)}|${v.partner_id ? String(v.partner_id) : pname}`;
        const cur = groups.get(key) ?? { company: String(v.company_id), partner: pname, value: 0n, settled: 0n, count: 0, oldest: '' };
        cur.value += asBigInt(v.value_minor);
        cur.settled += executedSum(byDebt.get(String(v._id)) ?? []);
        cur.count += 1;
        const due = String(v.due_date ?? '');
        if (due && (!cur.oldest || due < cur.oldest)) cur.oldest = due;
        groups.set(key, cur);
      }
      // Tổng tính trên TOÀN BỘ nhóm; giới hạn `limit` chỉ áp cho số dòng hiển thị (không làm lệch KPI).
      const allRows = [...groups.values()]
        .map((p) => ({ ...p, remaining: remainingOf(p.value, p.settled) }))
        .filter((p) => p.remaining > 0n)
        .sort((a, b) => (b.remaining > a.remaining ? 1 : -1));
      const totalRemaining = allRows.reduce((a, r) => a + r.remaining, 0n);
      const out = allRows
        .slice(0, input.limit)
        .map((r) => {
          const overdue = overdueDaysOf(r.oldest, today());
          return {
            counterparty: r.partner,
            company_name: cmap.get(r.company) ?? '',
            value: wire(r.value),
            value_compact: compactOf(r.value),
            settled: wire(r.settled),
            settled_compact: compactOf(r.settled),
            remaining: wire(r.remaining),
            remaining_compact: compactOf(r.remaining),
            count: r.count,
            days_overdue: overdue,
            due_date: r.oldest || null,
          };
        });
      return {
        ...base,
        columns: [T('counterparty', 'Đối tác'), T('company_name', 'Công ty'), C('value', 'Giá trị'), C('settled', 'Đã cấn trừ'), C('remaining', 'Còn lại'), N('count', 'Số khoản'), D('due_date', 'Hạn'), N('days_overdue', 'Quá hạn (ngày)')],
        rows: out,
        totals: { remaining: wire(totalRemaining) },
        kpi: [{ label: want === 'receivable' ? 'Tổng còn phải thu' : 'Tổng còn phải trả', value: formatMoney(money(totalRemaining), { mode: 'kpi' }), note: null }],
        chart: { type: 'bar', x_key: 'counterparty', series: [{ key: 'remaining', label: 'Còn lại', values: out.slice(0, 8).map((r) => ty(r.remaining.minor)) }], threshold: null },
        truncated: allRows.length > input.limit,
        row_count: out.length,
      };
    }

    /* ---------------- 6 · Nợ ngân hàng (theo ngân hàng — partner_id) ---------------- */
    case 'vay-ngan-hang': {
      const loans = await Models.BankDebt.find(loanFilter(input) as never)
        .select({ company_id: 1, partner_id: 1, code: 1, principal_minor: 1, maturity_date: 1, interest_rate: 1, status: 1 })
        .lean<Record<string, unknown>[]>();
      const settlements = groupSettlements(await loadLoanSettlements(loans.map((l) => ({ id: String(l._id) }))));
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      const partners = await loadPartnerRefs(loans.map((l) => (l.partner_id ? String(l.partner_id) : null)));
      const out = loans.map((l) => {
        const principal = asBigInt(l.principal_minor);
        const repaid = executedSum(settlements.get(String(l._id)) ?? [], 'principal');
        const outstanding = outstandingLoanOf(principal, repaid, String(l.status));
        return {
          company_name: cmap.get(String(l.company_id)) ?? '',
          bank_name: partnerNameOf(partners, l.partner_id ? String(l.partner_id) : null, 'Chưa gán ngân hàng'),
          contract_code: String(l.code ?? ''),
          limit: wire(principal),
          limit_compact: compactOf(principal),
          outstanding: wire(outstanding),
          outstanding_compact: compactOf(outstanding),
          interest_rate: String(l.interest_rate),
          maturity_date: String(l.maturity_date),
          days_to_due: daysUntil(String(l.maturity_date)),
          status: String(l.status),
        };
      });
      const total = out.reduce((a, r) => a + asBigInt(r.outstanding.minor), 0n);
      return {
        ...base,
        columns: [T('company_name', 'Công ty'), T('bank_name', 'Ngân hàng'), T('contract_code', 'Mã khoản'), C('limit', 'Số tiền vay'), C('outstanding', 'Dư nợ'), T('interest_rate', 'Lãi suất'), D('maturity_date', 'Hạn trả'), N('days_to_due', 'Còn lại')],
        rows: out,
        totals: { outstanding: wire(total) },
        kpi: [{ label: 'Tổng dư nợ', value: formatMoney(money(total), { mode: 'kpi' }), note: `${out.length} khoản` }],
        chart: null,
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 7 · Đáo hạn ---------------- */
    case 'dao-han': {
      const loans = await Models.BankDebt.find(
        {
          status: { $in: ['active', 'overdue'] },
          ...(input.scope.companyIds === null ? {} : { company_id: { $in: input.scope.companyIds.map((id) => oid(id)) } }),
          ...(input.partnerId ? { partner_id: oid(input.partnerId) } : {}),
        } as never,
      )
        .select({ company_id: 1, partner_id: 1, code: 1, principal_minor: 1, maturity_date: 1, interest_rate: 1 })
        .sort({ maturity_date: 1 })
        .lean<Record<string, unknown>[]>();
      const settlements = groupSettlements(await loadLoanSettlements(loans.map((l) => ({ id: String(l._id) }))));
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      const partners = await loadPartnerRefs(loans.map((l) => (l.partner_id ? String(l.partner_id) : null)));
      const out = loans.map((l) => {
        const days = daysUntil(String(l.maturity_date));
        const principal = asBigInt(l.principal_minor);
        const outstanding = outstandingLoanOf(principal, executedSum(settlements.get(String(l._id)) ?? [], 'principal'), 'active');
        const interest = simpleInterest(outstanding, parseRate(l.interest_rate as string), Math.max(0, days));
        const need = outstanding + interest;
        return {
          company_name: cmap.get(String(l.company_id)) ?? '',
          bank_name: partnerNameOf(partners, l.partner_id ? String(l.partner_id) : null, 'Chưa gán ngân hàng'),
          contract_code: String(l.code ?? ''),
          outstanding: wire(outstanding),
          outstanding_compact: compactOf(outstanding),
          interest: wire(interest),
          interest_compact: compactOf(interest),
          need: wire(need),
          need_compact: compactOf(need),
          maturity_date: String(l.maturity_date),
          days_to_due: days,
          bucket: days <= 0 ? 'Hôm nay' : days <= 3 ? '3 ngày' : days <= 7 ? '4–7 ngày' : days <= 30 ? '8–30 ngày' : '> 30 ngày',
          tone: days <= 3 ? 'danger' : days <= 7 ? 'warning' : days <= 30 ? 'attention' : 'neutral',
        };
      });
      const bucketSum = (b: string) => out.filter((r) => r.bucket === b).reduce((a, r) => a + asBigInt(r.outstanding.minor), 0n);
      return {
        ...base,
        columns: [T('company_name', 'Công ty'), T('bank_name', 'Ngân hàng'), T('contract_code', 'Khoản vay'), C('outstanding', 'Dư nợ'), C('interest', 'Lãi dự kiến'), C('need', 'Cần chuẩn bị'), D('maturity_date', 'Đáo hạn'), N('days_to_due', 'Còn lại'), T('bucket', 'Nhóm')],
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

    /* ---------------- 8 · Dòng tiền (thu + chuyển nội bộ đến; chi + chuyển nội bộ đi) ---------------- */
    case 'dong-tien': {
      // dòng tiền là tiền THẬT dịch chuyển: không loại cặp nội bộ (chỉ khác với doanh thu/chi phí);
      // chuyển nội bộ kind `internal` được tính riêng ở hai chân (nguồn ra / đích vào).
      // Không đếm trùng: phần ĐÃ THỰC THI lấy từ sổ cái (CashEntry, theo ngày ghi sổ) — cùng cơ sở với số dư đầu kỳ;
      // phần CHƯA THỰC THI lấy từ phiếu theo ngày dự kiến (PIPELINE_STATUSES, không gồm paid).
      const scopeIds = input.scope.companyIds;
      const docs = await scopedAggregate<{ _id: string; in: unknown; out: unknown }>(
        Models.Document,
        input.scope,
        [
          {
            $match: {
              planned_date: { $gte: dayStartOf(from), $lte: dayEndOf(to) },
              status: { $in: [...PIPELINE_STATUSES] },
              kind: { $in: ['income', 'spend', 'rollover'] },
              ...docFilter(input, null),
            },
          },
          {
            $group: {
              _id: { $substr: ['$planned_date', 0, 10] },
              in: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, '$amount.minor', 0] } },
              out: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, 0, '$amount.minor'] } },
            },
          },
          { $sort: { _id: 1 } },
        ],
      );
      // chuyển nội bộ: chân ra ở công ty nguồn, chân vào ở công ty đích (chỉ trong phạm vi)
      const transfers = await Models.Document.find({
        kind: 'internal',
        status: { $in: [...PIPELINE_STATUSES] },
        planned_date: { $gte: dayStartOf(from), $lte: dayEndOf(to) },
      } as never)
        .select({ company_id: 1, amount: 1, planned_date: 1, target: 1, transfer_target: 1 })
        .lean<Record<string, unknown>[]>();
      const transferIn = new Map<string, bigint>();
      const transferOut = new Map<string, bigint>();
      for (const t of transfers) {
        const day = String(t.planned_date ?? '').slice(0, 10);
        const amount = toBig((t.amount as { minor?: unknown } | undefined)?.minor);
        const src = String(t.company_id ?? '');
        const dst = String(((t.transfer_target as { company_id?: unknown } | null)?.company_id ?? (t.target as { company_id?: unknown } | null)?.company_id ?? ''));
        if (!scopeIds || scopeIds.includes(src)) transferOut.set(day, (transferOut.get(day) ?? 0n) + amount);
        if (dst && (!scopeIds || scopeIds.includes(dst))) transferIn.set(day, (transferIn.get(day) ?? 0n) + amount);
      }
      // phần đã thực thi (sổ cái) trong kỳ — chân nội bộ đã thực thi cũng nằm đây, mỗi công ty một chân
      const ledgerRows = (await Models.CashEntry.aggregate([
        {
          $match: {
            date: { $gte: from, $lte: to },
            ...(scopeIds === null ? {} : { company_id: { $in: scopeIds.map((id) => oid(id)) } }),
          },
        },
        { $group: { _id: { date: '$date', direction: '$direction' }, total: { $sum: '$amount_minor' } } },
      ] as never[])) as unknown as { _id: { date: string; direction: string }; total: unknown }[];
      const ledgerIn = new Map<string, bigint>();
      const ledgerOut = new Map<string, bigint>();
      for (const r of ledgerRows) {
        const bucket = r._id.direction === 'in' ? ledgerIn : ledgerOut;
        bucket.set(r._id.date, (bucket.get(r._id.date) ?? 0n) + toBig(r.total));
      }
      const dayKeys = [
        ...new Set([...docs.map((r) => String(r._id)), ...transferIn.keys(), ...transferOut.keys(), ...ledgerIn.keys(), ...ledgerOut.keys()]),
      ].sort();

      const threshold = await scopeMinBalance(input.scope);
      const opening = await openingBalance(input.scope, addDays(from, -1));
      let running = opening;
      const byDay = new Map(docs.map((r) => [String(r._id), r]));
      const out = dayKeys.map((d) => {
        const r = byDay.get(d);
        const inn = asBigInt(r?.in ?? 0n) + (transferIn.get(d) ?? 0n) + (ledgerIn.get(d) ?? 0n);
        const ot = asBigInt(r?.out ?? 0n) + (transferOut.get(d) ?? 0n) + (ledgerOut.get(d) ?? 0n);
        const start = running;
        running = start + inn - ot;
        return {
          date: d,
          opening: wire(start),
          inflow: wire(inn),
          inflow_compact: compactOf(inn),
          outflow: wire(ot),
          outflow_compact: compactOf(ot),
          closing: wire(running),
          closing_compact: compactOf(running),
          breach: running < threshold,
        };
      });
      return {
        ...base,
        columns: [D('date', 'Ngày'), C('opening' as never, 'Đầu kỳ') as never, C('inflow', 'Thu'), C('outflow', 'Chi'), C('closing', 'Cuối kỳ')],
        rows: out,
        totals: {},
        kpi: [{ label: 'Số dư cuối kỳ dự kiến', value: formatMoney(money(running), { mode: 'kpi' }), note: threshold > 0n ? `Ngưỡng ${compactOf(threshold)}` : null }],
        chart: { type: 'area', x_key: 'date', series: [{ key: 'closing', label: 'Số dư cuối kỳ', values: out.map((r) => ty(r.closing.minor)) }], threshold: threshold > 0n ? { value: ty(threshold), label: 'Ngưỡng tối thiểu' } : null },
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 9 · Chi theo bộ phận ---------------- */
    case 'chi-bo-phan': {
      const rows = await groupByDimension(input, internal, 'department_id', 'department');
      return { ...base, ...rows, truncated: false, row_count: rows.rows.length, chart: { type: 'bar', x_key: 'label', series: [{ key: 'amount', label: 'Chi', values: rows.rows.slice(0, 6).map((r) => ty((r as { amount: WireAmount }).amount.minor)) }], threshold: null } };
    }

    /* ---------------- 10 · Chi theo loại ---------------- */
    case 'chi-loai': {
      const rows = await groupByDimension(input, internal, 'category_id', 'category');
      return { ...base, ...rows, truncated: false, row_count: rows.rows.length, chart: { type: 'donut', x_key: 'label', series: [{ key: 'amount', label: 'Chi', values: rows.rows.slice(0, 4).map((r) => ty((r as { amount: WireAmount }).amount.minor)) }], threshold: null } };
    }

    /* ---------------- 11 · So sánh theo công ty (không tính chuyển nội bộ) ---------------- */
    case 'theo-cong-ty': {
      const rows = await scopedAggregate<{ _id: unknown; income: unknown; expense: unknown; count: number }>(
        Models.Document,
        input.scope,
        [
          { $match: { status: { $in: [...PLANNED_FLOW_STATUSES] }, kind: { $in: ['income', 'spend'] }, planned_date: { $gte: dayStartOf(from), $lte: dayEndOf(to) }, ...docFilter(input, internal) } },
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
          income: wire(inc),
          income_compact: compactOf(inc),
          expense: wire(exp),
          expense_compact: compactOf(exp),
          net: wire(inc - exp),
          net_compact: compactOf(inc - exp),
          documents: r.count,
        };
      });
      return {
        ...base,
        columns: [T('company_name', 'Công ty'), C('income', 'Thu'), C('expense', 'Chi'), C('net', 'Thuần'), N('documents', 'Số phiếu')],
        rows: out,
        totals: {},
        kpi: out.slice(0, 3).map((r) => ({ label: r.company_name, value: r.net_compact, note: null })),
        // giá trị biểu đồ tính từ số tiền minor (tỷ đồng), không parse chuỗi nén đã định dạng ("2,50 tỷ")
        chart: { type: 'stacked', x_key: 'company_name', series: [{ key: 'income', label: 'Thu', values: rows.map((r) => ty(r.income)) }, { key: 'expense', label: 'Chi', values: rows.map((r) => ty(r.expense)) }], threshold: null },
        truncated: false,
        row_count: out.length,
      };
    }

    /* ---------------- 12 · Khoản chờ duyệt (aging phê duyệt) ---------------- */
    case 'cho-duyet': {
      const rows = await Models.Document.find(
        {
          status: { $in: [...DECISION_STATUSES] },
          ...(input.scope.companyIds === null ? {} : { company_id: { $in: input.scope.companyIds.map((id) => oid(id)) } }),
          ...(input.partnerId ? { partner_id: oid(input.partnerId) } : {}),
          ...(input.tagIds?.length ? { tag_ids: { $in: input.tagIds.filter((t) => OID_RE.test(t)).map((t) => oid(t)) } } : {}),
        } as never,
      )
        .select({ code: 1, kind: 1, company_id: 1, amount: 1, approval: 1, submitted_at: 1, sla_deadline: 1, title: 1, status: 1, partner_id: 1 })
        .limit(500)
        .lean<Record<string, unknown>[]>();
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      const partners = await loadPartnerRefs(rows.map((d) => (d.partner_id ? String(d.partner_id) : null)));
      const out = rows.map((d) => {
        const steps = ((d.approval as { steps?: { role: Role; state: string }[] }) ?? { steps: [] }).steps ?? [];
        const current = steps.find((s) => s.state === 'current') ?? steps.find((s) => s.state === 'waiting');
        const waiting = d.submitted_at ? Math.floor((Date.now() - new Date(String(d.submitted_at)).getTime()) / 86_400_000) : 0;
        const overdue = d.sla_deadline ? new Date(String(d.sla_deadline)) < new Date() : false;
        const amount = asBigInt((d.amount as { minor?: unknown })?.minor);
        return {
          code: String(d.code),
          counterparty: partnerNameOf(partners, d.partner_id ? String(d.partner_id) : null, '—'),
          company_name: cmap.get(String(d.company_id)) ?? '',
          title: String(d.title ?? ''),
          kind: KIND_VI[String(d.kind)] ?? String(d.kind),
          amount: wire(amount),
          amount_compact: compactOf(amount),
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
        columns: [T('code', 'Mã'), T('counterparty', 'Đối tác'), T('company_name', 'Công ty'), T('title', 'Nội dung'), T('kind', 'Loại'), C('amount', 'Số tiền'), T('owner', 'Cấp duyệt'), N('waiting_days', 'Đã chờ'), T('status_label', 'Trạng thái')],
        rows: out,
        totals: { amount: wire(total) },
        kpi: [
          { label: 'Đang chờ duyệt', value: `${out.length} khoản`, note: formatMoney(money(total), { mode: 'kpi' }) },
          ...[...byOwner.entries()].slice(0, 4).map(([owner, v]) => ({ label: owner, value: compactOf(v.amount), note: `${v.count} khoản` })),
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
      // SLA chỉ đếm quyết định TRONG PHẠM VI công ty (scopedAggregate) và đếm đủ bằng aggregate (không cắt số hồ sơ).
      const slaRows = rows.length
        ? await scopedAggregate<{ _id: unknown; decided: number; late: number }>(Models.Document, input.scope, [
            { $match: { 'approval.steps.user_id': { $in: rows.map((r) => r._id) } } },
            { $unwind: '$approval.steps' },
            {
              $match: {
                'approval.steps.state': 'done',
                'approval.steps.decided_at': { $type: 'date' },
                'approval.steps.user_id': { $in: rows.map((r) => r._id) },
              },
            },
            {
              $group: {
                _id: '$approval.steps.user_id',
                decided: { $sum: 1 },
                late: {
                  $sum: {
                    $cond: [
                      { $and: [{ $eq: [{ $type: '$approval.steps.sla_deadline' }, 'date'] }, { $gt: ['$approval.steps.decided_at', '$approval.steps.sla_deadline'] }] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ])
        : [];
      const stats = new Map(slaRows.map((r) => [String(r._id), { decided: Number(r.decided), late: Number(r.late) }]));
      const out = rows
        .map((r) => {
          const st = stats.get(String(r._id)) ?? { decided: 0, late: 0 };
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

    /* ---------------- 14 · Theo đối tác (v2 — MỚI) ---------------- */
    case 'theo-doi-tac': {
      const docs = await reportDocs({ ...input, partnerId: null, tagIds: [] }, from, to, internal);
      const activity = partnerActivityOf(docs, new Set());
      const exposures = await partnerExposures(input.scope, to);
      const bankRows = await bankOutstandingByPartner(input.scope);
      const keys = new Set<string>([...activity.keys(), ...exposures.receivable.map((e) => e.partner_id ?? ''), ...exposures.payable.map((e) => e.partner_id ?? ''), ...bankRows.map((b) => b.partner_id ?? '')]);
      keys.delete('');
      const partnerIds = [...keys].filter((k) => !input.partnerId || k === input.partnerId);
      const partners = await loadPartnerRefs(partnerIds);
      const recv = new Map(exposures.receivable.map((e) => [e.partner_id ?? '', toBig(e.remaining.minor)]));
      const pay = new Map(exposures.payable.map((e) => [e.partner_id ?? '', toBig(e.remaining.minor)]));
      const loan = new Map(bankRows.map((b) => [b.partner_id ?? '', b.outstanding]));
      const partnerRows = partnerIds
        .map((id) => {
          const a = activity.get(id) ?? { income: 0n, expense: 0n, count: 0 };
          const p = partners.get(id);
          return {
            counterparty: partnerNameOf(partners, id, '—'),
            partner_type: p?.type ?? '—',
            income: wire(a.income),
            income_compact: compactOf(a.income),
            expense: wire(a.expense),
            expense_compact: compactOf(a.expense),
            net: wire(a.income - a.expense),
            net_compact: compactOf(a.income - a.expense),
            receivable: wire(recv.get(id) ?? 0n),
            payable: wire(pay.get(id) ?? 0n),
            loan_outstanding: wire(loan.get(id) ?? 0n),
            documents: a.count,
          };
        })
        .sort((x, y) => (toBig(y.income.minor) + toBig(y.expense.minor) + toBig(y.receivable.minor) + toBig(y.payable.minor) > toBig(x.income.minor) + toBig(x.expense.minor) + toBig(x.receivable.minor) + toBig(x.payable.minor) ? 1 : -1));
      // tổng trên TOÀN BỘ đối tác; `limit` chỉ cắt dòng hiển thị
      const totalIn = partnerRows.reduce((a, r) => a + toBig(r.income.minor), 0n);
      const totalOut = partnerRows.reduce((a, r) => a + toBig(r.expense.minor), 0n);
      const out = partnerRows.slice(0, input.limit);
      return {
        ...base,
        columns: [T('counterparty', 'Đối tác'), T('partner_type', 'Loại', { type: 'text' }), C('income', 'Thu'), C('expense', 'Chi'), C('net', 'Thuần'), C('receivable', 'Còn phải thu'), C('payable', 'Còn phải trả'), C('loan_outstanding', 'Dư nợ vay'), N('documents', 'Số phiếu')],
        rows: out,
        totals: { income: wire(totalIn), expense: wire(totalOut) },
        kpi: [
          { label: 'Tổng thu theo đối tác', value: formatMoney(money(totalIn), { mode: 'kpi' }), note: `${from} → ${to}` },
          { label: 'Tổng chi theo đối tác', value: formatMoney(money(totalOut), { mode: 'kpi' }), note: 'không gồm chuyển nội bộ' },
        ],
        chart: { type: 'bar', x_key: 'counterparty', series: [{ key: 'income', label: 'Thu', values: out.slice(0, 8).map((r) => ty(r.income.minor)) }, { key: 'expense', label: 'Chi', values: out.slice(0, 8).map((r) => ty(r.expense.minor)) }], threshold: null },
        truncated: partnerRows.length > input.limit,
        row_count: out.length,
      };
    }

    /* ---------------- 15 · Theo tag (v2 — gộp theo tên chuẩn hoá khi "tất cả công ty") ---------------- */
    case 'theo-tag': {
      const docs = await reportDocs(input, from, to, internal);
      const tagIds = [...new Set(docs.flatMap((d) => d.tag_ids))];
      const tags = await loadTagRefs(tagIds);
      const groups = groupByTagName(docs, tags, new Set());
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
      // KPI cộng từ PHIẾU (mỗi phiếu một lần); phiếu nhiều tag xuất hiện ở nhiều nhóm nên không cộng theo nhóm.
      const countedDocs = docs.filter((d) => d.kind === 'income' || d.kind === 'spend');
      const totalIn = countedDocs.filter((d) => d.kind === 'income').reduce((a, d) => a + d.amount, 0n);
      const totalOut = countedDocs.filter((d) => d.kind === 'spend').reduce((a, d) => a + d.amount, 0n);
      const out = groups.slice(0, input.limit).map((g) => ({
        tag: g.name,
        companies: g.company_ids.map((id) => cmap.get(id) ?? id).join(', '),
        company_count: g.company_ids.length,
        income: wire(g.income),
        income_compact: compactOf(g.income),
        expense: wire(g.expense),
        expense_compact: compactOf(g.expense),
        net: wire(g.income - g.expense),
        net_compact: compactOf(g.income - g.expense),
        documents: g.count,
      }));
      return {
        ...base,
        columns: [T('tag', 'Tag'), T('companies', 'Công ty'), C('income', 'Thu'), C('expense', 'Chi'), C('net', 'Thuần'), N('documents', 'Số phiếu')],
        rows: out,
        totals: { income: wire(totalIn), expense: wire(totalOut) },
        kpi: [
          { label: 'Thu theo tag', value: formatMoney(money(totalIn), { mode: 'kpi' }), note: input.scope.companyIds === null ? 'mỗi phiếu tính một lần · gộp theo tên tag' : 'mỗi phiếu tính một lần' },
          { label: 'Chi theo tag', value: formatMoney(money(totalOut), { mode: 'kpi' }), note: 'mỗi phiếu tính một lần' },
        ],
        chart: { type: 'bar', x_key: 'tag', series: [{ key: 'expense', label: 'Chi', values: out.slice(0, 8).map((r) => ty(r.expense.minor)) }], threshold: null },
        truncated: groups.length > input.limit,
        row_count: out.length,
      };
    }

    /* ---------------- 16 · Sổ chi tiết đối tác (v2 — MỚI) ---------------- */
    case 'so-chi-tiet-doi-tac': {
      const emptyBase = { ...base, columns: [] as ReportColumn[], rows: [], totals: {}, chart: null, truncated: false, row_count: 0 };
      if (!input.partnerId) {
        return { ...emptyBase, kpi: [{ label: 'Chưa chọn đối tác', value: 'Chọn một đối tác để xem sổ', note: null }] };
      }
      const partner = await Models.Partner.findById(input.partnerId).select({ company_id: 1, name: 1, type: 1 }).lean<{ company_id?: unknown; name?: string } | null>();
      if (!partner || (input.scope.companyIds !== null && !input.scope.companyIds.includes(String(partner.company_id)))) {
        return { ...emptyBase, kpi: [{ label: 'Không tìm thấy đối tác', value: '—', note: null }] };
      }
      const periodFrom = input.from ?? addDays(today(), -30);
      const periodTo = input.to ?? today();
      const events = await loadPartnerLedgerEvents(input.partnerId);
      const ledger = buildPartnerLedger(events, periodFrom, periodTo);
      const rows = ledger.rows.map((r) => ({
        date: r.date,
        kind: LEDGER_KIND_VI[r.kind],
        code: r.code,
        description: r.description,
        cash_in: wire(r.cash_in),
        cash_out: wire(r.cash_out),
        effect: wire(r.effect),
        balance: wire(r.balance),
        balance_compact: compactOf(r.balance),
        href: r.href,
      }));
      return {
        ...base,
        title: `Sổ chi tiết · ${String(partner.name ?? '')}`,
        columns: [
          D('date', 'Ngày'),
          T('kind', 'Loại'),
          T('code', 'Chứng từ'),
          T('description', 'Diễn giải'),
          C('cash_in', 'Thu'),
          C('cash_out', 'Chi'),
          C('effect', 'Tác động công nợ'),
          C('balance', 'Dư lũy kế'),
        ],
        rows,
        totals: { opening: wire(ledger.opening), cash_in: wire(ledger.totals.cash_in), cash_out: wire(ledger.totals.cash_out), closing: wire(ledger.totals.closing) },
        kpi: [
          { label: 'Dư đầu kỳ', value: compactOf(ledger.opening), note: `${periodFrom} → ${periodTo}` },
          { label: 'Dư cuối kỳ', value: compactOf(ledger.totals.closing), note: '+ đối tác còn nợ công ty · − công ty còn nợ' },
          { label: 'Thu / chi trong kỳ', value: `${compactOf(ledger.totals.cash_in)} / ${compactOf(ledger.totals.cash_out)}`, note: null },
        ],
        chart: null,
        truncated: rows.length >= input.limit,
        row_count: rows.length,
      };
    }

    default:
      return { ...base, columns: [], rows: [], totals: {}, kpi: [], chart: null, truncated: false, row_count: 0 };
  }
}

const LEDGER_KIND_VI: Record<string, string> = {
  cong_no: 'Công nợ',
  khoan_vay: 'Khoản vay',
  phieu_thu: 'Phiếu thu',
  phieu_chi: 'Phiếu chi',
};

/** Điều kiện khoản vay theo phạm vi công ty và đối tác ngân hàng (nếu có). */
function loanFilter(input: ReportInput): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  if (input.scope.companyIds !== null) f.company_id = { $in: input.scope.companyIds.map((id) => oid(id)) };
  if (input.partnerId) f.partner_id = oid(input.partnerId);
  return f;
}

/** Tổng ngưỡng tối thiểu của các công ty trong phạm vi. */
async function scopeMinBalance(scope: ScopeLike): Promise<bigint> {
  const companies = await Models.Company.find(scope.companyIds === null ? {} : ({ _id: { $in: scope.companyIds } } as never))
    .select({ min_balance_minor: 1 })
    .lean();
  return companies.reduce((a, c) => a + asBigInt(c.min_balance_minor), 0n);
}

/** Số dư sổ cái đến hết ngày `asOf` (tổng tài khoản trong phạm vi). */
async function openingBalance(scope: ScopeLike, asOf: string): Promise<bigint> {
  const views = await ledgerAccountViews(scope, { asOf, includeGroup: scope.companyIds !== null });
  return views.reduce((a, v) => a + v.actual, 0n);
}

/** Nhóm theo dimension (bộ phận / danh mục) — dùng cho RPT-09/10. Loại chuyển nội bộ & áp bộ lọc. */
async function groupByDimension(
  input: ReportInput,
  internal: ReadonlySet<string>,
  field: string,
  kind: 'department' | 'category',
): Promise<Pick<ReportResult, 'columns' | 'rows' | 'totals' | 'kpi'>> {
  const allRows = await scopedAggregate<{ _id: unknown; total: unknown; count: number }>(
    Models.Document,
    input.scope,
    [
      { $match: { kind: 'spend', status: { $in: [...PLANNED_FLOW_STATUSES] }, ...docFilter(input, internal) } },
      { $group: { _id: `$${field}`, total: { $sum: '$amount.minor' }, count: { $sum: 1 } } },
      { $sort: { total: -1 } },
    ],
  );
  // tổng và % trên TOÀN BỘ nhóm; giới hạn `limit` chỉ áp cho dòng hiển thị
  const total = allRows.reduce((a, r) => a + asBigInt(r.total), 0n);
  const rows = allRows.slice(0, input.limit);
  const ids = rows.map((r) => r._id).filter(Boolean) as string[];
  const lookup = ids.length
    ? kind === 'department'
      ? (await Models.Department.find({ _id: { $in: ids as never } } as never).select({ name: 1 }).lean()) as { _id: unknown; name?: string }[]
      : (await Models.Category.find({ _id: { $in: ids as never } } as never).select({ name: 1 }).lean()) as { _id: unknown; name?: string }[]
    : [];
  const map = new Map(lookup.map((d) => [String(d._id), String(d.name)]));
  const out = rows.map((r) => {
    const amount = asBigInt(r.total);
    return {
      label: r._id ? (map.get(String(r._id)) ?? 'Chưa gán') : 'Chưa gán',
      amount: wire(amount),
      amount_compact: compactOf(amount),
      percent: percentOf(amount, total),
      count: r.count,
    };
  });
  return {
    columns: [T('label', kind === 'department' ? 'Bộ phận' : 'Loại khoản chi'), C('amount', 'Số tiền'), T('percent', '% tổng', { type: 'percent', align: 'right', sortable: true }), N('count', 'Số phiếu')],
    rows: out,
    totals: { amount: wire(total) },
    kpi: [
      { label: 'Tổng chi', value: formatMoney(money(total), { mode: 'kpi' }), note: `${out.length} nhóm` },
      ...out.slice(0, 3).map((r) => ({ label: r.label, value: r.amount_compact, note: `${r.percent.toFixed(1)}%` })),
    ],
  };
}

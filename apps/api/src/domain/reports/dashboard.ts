/**
 * Phần BỔ SUNG v2 cho Dashboard (v2 §12): top đối tác phải thu / phải trả, dư nợ theo ngân hàng
 * (theo ID đối tác), khoản vay "Chờ giải ngân", lượt chạy tự động lỗi, và tiền từ sổ cái
 * (không còn "bị phong toả" / "khả dụng").
 *
 * Route `/dashboard/overview` gọi `dashboardOverview` (queries) rồi GHI ĐÈ các trường cần đổi
 * bằng kết quả ở đây (không sửa bản cache của queries).
 */

import { today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { docHref, wire, type WireAmount } from '../queries/index.ts';
import { ledgerAccountViews, type LedgerAccountView } from '../accounts.ts';
import type { ScopeLike } from '../types.ts';
import { debtDirectionOf, executedSum, outstandingLoanOf, overdueDaysOf, percentOf, remainingOf, type DebtDirection } from './aggregate.ts';
import { dayOf, loadDebtSettlements, loadLoanSettlements, loadPartnerRefs, partnerNameOf } from './refs.ts';
import { toBig } from '../links/index.ts';

export interface PartnerExposure {
  partner_id: string | null;
  partner_name: string;
  partner_type: string | null;
  direction: DebtDirection;
  count: number;
  remaining: WireAmount;
  overdue: WireAmount;
  /** số khoản còn dư đã quá hạn (theo HƯỚNG công nợ, không theo bút toán side). */
  overdue_count: number;
  /** ngày quá hạn lâu nhất (0 nếu không quá hạn). */
  max_overdue_days: number;
}

export interface DashboardExtras {
  cash: {
    actual: WireAmount;
    projected: WireAmount;
    cash_on_hand: WireAmount;
    bank_money: WireAmount;
    accounts_below_min: { account_id: string; label: string; company_name: string; actual: WireAmount; min_balance: WireAmount }[];
  };
  partners: {
    top_receivable: PartnerExposure[];
    top_payable: PartnerExposure[];
    receivable_total: WireAmount;
    receivable_overdue_total: WireAmount;
    /** số khoản phải thu quá hạn (theo hướng công nợ) — thay cho đếm theo side v1. */
    receivable_overdue_count: number;
    payable_total: WireAmount;
  };
  bank_by_partner: { partner_id: string | null; partner_name: string; outstanding: WireAmount; share_percent: number }[];
  loans_pending: {
    count: number;
    total: WireAmount;
    items: { id: string; code: string; company_id: string; partner_name: string; principal: WireAmount; created_at: string | null; href: string }[];
  };
  automation: {
    failed_count: number;
    items: {
      id: string;
      rule_code: string;
      rule_name: string;
      company_name: string;
      source_id: string;
      source_code: string | null;
      error: string | null;
      updated_at: string | null;
      href: string | null;
    }[];
  };
}

const TOP_N = 5;

interface ExposureGroup {
  partner_id: string | null;
  direction: DebtDirection;
  count: number;
  remaining: bigint;
  overdue: bigint;
  overdueCount: number;
  maxDays: number;
}

/** Công nợ còn lại theo đối tác (phải thu / phải trả), kèm quá hạn. Tính từ phân bổ ĐÃ THỰC THI. */
export async function partnerExposures(scope: ScopeLike, asOf: string = today()): Promise<{ receivable: PartnerExposure[]; payable: PartnerExposure[] }> {
  // Nhân viên (TK 334, M5) chỉ đọc: không thuộc đối tác nên không tính vào phải thu / phải trả theo đối tác.
  const debts = await Models.DebtVoucher.find({
    party_type: { $ne: 'employee' },
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds } }),
  } as never)
    .select({ company_id: 1, partner_id: 1, direction: 1, side: 1, value_minor: 1, due_date: 1 })
    .lean<Record<string, unknown>[]>();
  const settlements = await loadDebtSettlements(debts.map((d) => ({ id: String(d._id) })));
  const byDebt = new Map<string, typeof settlements>();
  for (const r of settlements) {
    const list = byDebt.get(r.target_id) ?? [];
    list.push(r);
    byDebt.set(r.target_id, list);
  }

  const partners = await loadPartnerRefs(debts.map((d) => (d.partner_id ? String(d.partner_id) : null)));
  const groups = new Map<string, ExposureGroup>();
  for (const d of debts) {
    const id = String(d._id);
    const direction = debtDirectionOf(d as never);
    const value = toBig(d.value_minor);
    const remaining = remainingOf(value, executedSum(byDebt.get(id) ?? []));
    if (remaining <= 0n) continue;
    const partnerId = d.partner_id ? String(d.partner_id) : null;
    const key = `${direction}|${partnerId ?? ''}`;
    const cur = groups.get(key) ?? { partner_id: partnerId, direction, count: 0, remaining: 0n, overdue: 0n, overdueCount: 0, maxDays: 0 };
    cur.count += 1;
    cur.remaining += remaining;
    const dueDate = String(d.due_date ?? '');
    const days = overdueDaysOf(dueDate, asOf);
    if (days > 0) {
      cur.overdue += remaining;
      cur.overdueCount += 1;
      cur.maxDays = Math.max(cur.maxDays, days);
    }
    groups.set(key, cur);
  }
  const toExposure = (g: ExposureGroup): PartnerExposure => {
    const p = g.partner_id ? partners.get(g.partner_id) : undefined;
    return {
      partner_id: g.partner_id,
      partner_name: partnerNameOf(partners, g.partner_id, 'Chưa gán đối tác'),
      partner_type: p?.type ?? null,
      direction: g.direction,
      count: g.count,
      remaining: wire(g.remaining),
      overdue: wire(g.overdue),
      overdue_count: g.overdueCount,
      max_overdue_days: g.maxDays,
    };
  };
  const all = [...groups.values()].map(toExposure);
  const sortDesc = (a: PartnerExposure, b: PartnerExposure) => (toBig(b.remaining.minor) > toBig(a.remaining.minor) ? 1 : -1);
  return {
    receivable: all.filter((x) => x.direction === 'receivable').sort(sortDesc),
    payable: all.filter((x) => x.direction === 'payable').sort(sortDesc),
  };
}

/** Tổng phải thu quá hạn (còn lại) của phạm vi — dùng cho bản tin & dashboard. */
export async function receivableOverdueTotal(scope: ScopeLike, asOf: string = today()): Promise<bigint> {
  const { receivable } = await partnerExposures(scope, asOf);
  return receivable.reduce((a, r) => a + toBig(r.overdue.minor), 0n);
}

/** Dư nợ vay theo ngân hàng (ID đối tác) — thay cho nhóm theo `bank_name` text của v1. */
export async function bankOutstandingByPartner(scope: ScopeLike): Promise<{ partner_id: string | null; outstanding: bigint }[]> {
  const loans = await Models.BankDebt.find({
    status: { $in: ['active', 'overdue'] },
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds } }),
  } as never)
    .select({ partner_id: 1, principal_minor: 1, status: 1 })
    .lean<Record<string, unknown>[]>();
  const settlements = await loadLoanSettlements(loans.map((l) => ({ id: String(l._id) })));
  const repaid = new Map<string, bigint>();
  for (const r of settlements) {
    if (r.doc_status !== 'paid') continue;
    repaid.set(r.target_id, (repaid.get(r.target_id) ?? 0n) + r.principal);
  }
  const byPartner = new Map<string | null, bigint>();
  for (const l of loans) {
    const outstanding = outstandingLoanOf(toBig(l.principal_minor), repaid.get(String(l._id)) ?? 0n, String(l.status));
    if (outstanding <= 0n) continue;
    const key = l.partner_id ? String(l.partner_id) : null;
    byPartner.set(key, (byPartner.get(key) ?? 0n) + outstanding);
  }
  return [...byPartner.entries()].map(([partner_id, outstanding]) => ({ partner_id, outstanding }));
}

/** Toàn bộ phần bổ sung của dashboard. */
export async function dashboardExtras(scope: ScopeLike, asOf: string = today()): Promise<DashboardExtras> {
  // Tài khoản ĐÃ ĐÓNG vẫn có thể còn số dư sổ cái: tính vào tổng tiền (khớp số dư đầu kỳ của dự báo).
  const [accounts, exposures, bankRows, pending, failed] = await Promise.all([
    ledgerAccountViews(scope, { asOf, includeClosed: true }),
    partnerExposures(scope, asOf),
    bankOutstandingByPartner(scope),
    pendingLoans(scope),
    failedRuns(scope),
  ]);

  const cashTotal = accounts.reduce((a, x) => a + x.actual, 0n);
  const projectedTotal = accounts.reduce((a, x) => a + x.projected, 0n);
  const onHand = accounts.filter((a) => a.kind === 'cash').reduce((a, x) => a + x.actual, 0n);
  const receivableTotal = exposures.receivable.reduce((a, r) => a + toBig(r.remaining.minor), 0n);
  const payableTotal = exposures.payable.reduce((a, r) => a + toBig(r.remaining.minor), 0n);

  const bankNames = await loadPartnerRefs(bankRows.map((b) => b.partner_id));
  const bankTotal = bankRows.reduce((a, b) => a + b.outstanding, 0n);
  const bankByPartner = bankRows
    .map((b) => ({
      partner_id: b.partner_id,
      partner_name: partnerNameOf(bankNames, b.partner_id, 'Chưa gán ngân hàng'),
      outstanding: wire(b.outstanding),
      share_percent: percentOf(b.outstanding, bankTotal),
    }))
    .sort((a, b) => (toBig(b.outstanding.minor) > toBig(a.outstanding.minor) ? 1 : -1));

  return {
    cash: {
      actual: wire(cashTotal),
      projected: wire(projectedTotal),
      cash_on_hand: wire(onHand),
      bank_money: wire(cashTotal - onHand),
      accounts_below_min: accounts
        .filter((a) => a.breach && a.status !== 'closed')
        .slice(0, 3)
        .map((a) => belowMin(a)),
    },
    partners: {
      top_receivable: exposures.receivable.slice(0, TOP_N),
      top_payable: exposures.payable.slice(0, TOP_N),
      receivable_total: wire(receivableTotal),
      receivable_overdue_total: wire(exposures.receivable.reduce((a, r) => a + toBig(r.overdue.minor), 0n)),
      receivable_overdue_count: exposures.receivable.reduce((a, r) => a + r.overdue_count, 0),
      payable_total: wire(payableTotal),
    },
    bank_by_partner: bankByPartner,
    loans_pending: pending,
    automation: failed,
  };
}

function belowMin(a: LedgerAccountView) {
  return { account_id: a.account_id, label: a.label, company_name: a.company_name, actual: wire(a.actual), min_balance: wire(a.min_balance) };
}

async function pendingLoans(scope: ScopeLike): Promise<DashboardExtras['loans_pending']> {
  const rows = await Models.BankDebt.find({
    status: 'pending_disbursement',
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds } }),
  } as never)
    .select({ code: 1, company_id: 1, partner_id: 1, principal_minor: 1, created_at: 1 })
    .sort({ created_at: -1 })
    .lean<Record<string, unknown>[]>();
  const partners = await loadPartnerRefs(rows.map((r) => (r.partner_id ? String(r.partner_id) : null)));
  const total = rows.reduce((a, r) => a + toBig(r.principal_minor), 0n);
  return {
    count: rows.length,
    total: wire(total),
    items: rows.slice(0, 10).map((r) => ({
      id: String(r._id),
      code: String(r.code ?? ''),
      company_id: String(r.company_id ?? ''),
      partner_name: partnerNameOf(partners, r.partner_id ? String(r.partner_id) : null, 'Chưa gán ngân hàng'),
      principal: wire(toBig(r.principal_minor)),
      created_at: r.created_at ? dayOf(r.created_at) : null,
      href: `/ngan-hang/khoan-vay/${String(r._id)}`,
    })),
  };
}

async function failedRuns(scope: ScopeLike): Promise<DashboardExtras['automation']> {
  const filter = { status: 'failed', ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds } }) };
  const [count, rows, rules, companies] = await Promise.all([
    Models.AutomationRun.countDocuments(filter as never).exec(),
    Models.AutomationRun.find(filter as never)
      .sort({ updated_at: -1 })
      .limit(20)
      .lean<Record<string, unknown>[]>(),
    Models.AutomationRule.find({}).select({ code: 1, name: 1 }).lean<{ code: string; name: string }[]>(),
    Models.Company.find({}).select({ name: 1 }).lean<{ _id: unknown; name?: string }[]>(),
  ]);
  const ruleName = new Map(rules.map((r) => [String(r.code), String(r.name)]));
  const companyName = new Map(companies.map((c) => [String(c._id), String(c.name ?? '')]));
  const docIds = rows.filter((r) => String(r.source_type) === 'document').map((r) => String(r.source_id));
  const docs = docIds.length
    ? await Models.Document.find({ _id: { $in: docIds } } as never).select({ code: 1, kind: 1 }).lean<{ _id: unknown; code?: string; kind?: string }[]>()
    : [];
  const docMeta = new Map(docs.map((d) => [String(d._id), { code: String(d.code ?? ''), kind: String(d.kind ?? '') }]));
  return {
    failed_count: count,
    items: rows.map((r) => {
      const sourceId = String(r.source_id ?? '');
      const doc = docMeta.get(sourceId);
      return {
        id: String(r._id),
        rule_code: String(r.rule_code ?? ''),
        rule_name: ruleName.get(String(r.rule_code)) ?? String(r.rule_code ?? ''),
        company_name: companyName.get(String(r.company_id ?? '')) ?? '',
        source_id: sourceId,
        source_code: doc?.code ?? null,
        error: r.error ? String(r.error) : null,
        updated_at: r.updated_at ? new Date(String(r.updated_at)).toISOString() : null,
        href: doc ? docHref(doc.kind, sourceId) : null,
      };
    }),
  };
}

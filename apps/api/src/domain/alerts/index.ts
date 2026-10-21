/**
 * Cảnh báo (blueprint §XVIII; v2 §12 + §11.5 R6) — `alerts` chứa cả rule lẫn event (§8.1).
 * Dedupe `dedupe_key` (unique) → task chạy mỗi 15 phút không spam.
 * Email chỉ cho severity = danger (§9.4); quiet hours xử lý ở mail/sender.
 *
 * v2:
 *   · loại mới `automation_run_failed` (lượt tự động lỗi) và `source_cancelled_with_money`
 *     (phiếu nguồn bị huỷ/từ chối khi đối tượng sinh đã phát sinh tiền — R6 gọi `raiseAlert`);
 *   · tên đối tác trong nội dung cảnh báo lấy theo `partner_id` (không dùng text v1);
 *   · số dư dưới ngưỡng = SỐ DƯ SỔ CÁI (không còn trừ "phong toả").
 */

import { addDays, dayEndOf, deadlineLabel, formatMoney, isDeadlinePast, money, today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { PLANNED_FLOW_STATUSES } from '../ledger/planned.ts';
import { mailTemplates, sendMail } from '../../mail/sender.ts';
import { asBigInt, docHref, maturityLadder } from '../queries/index.ts';
import { ledgerAccountViews } from '../accounts.ts';
import { cashflowForecast } from '../reports/cashflow.ts';
import { debtDirectionOf, executedSum, remainingOf } from '../reports/aggregate.ts';
import { loadDebtSettlements, loadPartnerRefs, partnerNameOf, type PartnerRef } from '../reports/refs.ts';

export type AlertKind =
  | 'approval_overdue'
  | 'loan_maturity'
  | 'low_balance'
  | 'receivable_overdue'
  | 'budget_exceeded'
  | 'missing_evidence'
  | 'payment_due'
  | 'negative_cashflow'
  | 'automation_run_failed'
  | 'source_cancelled_with_money';

/** Loại cảnh báo cũ do bộ máy tự động ghi trước v2 — vẫn nhận diện để không cảnh báo trùng. */
export const LEGACY_AUTOMATION_ALERTS = ['automation_failed', 'automation_event_failed'] as const;

interface Rule {
  severity: number;
  channels: string[];
  to_roles: string[];
  enabled: boolean;
  threshold: Record<string, unknown>;
}

interface Hit {
  alert_type: AlertKind;
  company_id: string | null;
  severity: number;
  text: string;
  amount_minor: bigint | null;
  href: string | null;
  dedupe_key: string;
  subject?: Record<string, unknown> | null;
}

const compact = (minor: bigint) => formatMoney(money(minor), { mode: 'compact' });

/** Ghép tên đối tác vào nội dung (để rỗng nếu không có). */
const withPartner = (name: string | null) => (name ? ` · ${name}` : '');

async function loadRules(): Promise<Map<string, Rule>> {
  const rows = await Models.Alert.find({ type: 'rule' } as never).lean();
  const map = new Map<string, Rule>();
  for (const r of rows) {
    const o = r as Record<string, unknown>;
    map.set(String(o.alert_type), {
      severity: Number(o.severity ?? 2),
      channels: (o.channels as string[] | undefined) ?? ['web'],
      to_roles: (o.to_roles as string[] | undefined) ?? [],
      enabled: o.enabled !== false,
      threshold: (o.threshold as Record<string, unknown> | undefined) ?? {},
    });
  }
  return map;
}

/**
 * Ghi MỘT cảnh báo sự kiện (idempotent theo `dedupe_key`) và giao cho vai trò nhận.
 * Trả true nếu vừa tạo mới. Lỗi giao thông báo KHÔNG làm hỏng nghiệp vụ gọi (R6, bộ máy tự động).
 */
export interface RaiseAlertInput {
  alert_type: AlertKind | string;
  company_id: string | null;
  severity: number;
  text: string;
  amount_minor?: bigint | null;
  href?: string | null;
  dedupe_key: string;
  subject?: Record<string, unknown> | null;
  /** mặc định: KTT (`chief_accountant`). */
  to_roles?: string[];
  /** mặc định: web (+ email khi severity ≥ 3 và người dùng bật email). */
  channels?: string[];
}

export async function raiseAlert(input: RaiseAlertInput): Promise<boolean> {
  try {
    const res = await Models.Alert.updateOne(
      { dedupe_key: input.dedupe_key },
      {
        $setOnInsert: {
          type: 'event',
          alert_type: input.alert_type,
          company_id: input.company_id,
          severity: input.severity,
          text: input.text,
          amount_minor: input.amount_minor ?? null,
          href: input.href ?? null,
          subject: input.subject ?? null,
          dedupe_key: input.dedupe_key,
          created_at: new Date(),
        },
      },
      { upsert: true },
    ).exec();
    if (!res.upsertedCount) return false;
  } catch (err) {
    // trùng khoá (unique partial index) khi chạy song song → coi như đã có
    if (isDuplicateKey(err)) return false;
    console.error(`[alerts] không ghi được cảnh báo ${input.alert_type}: ${(err as Error).message}`);
    return false;
  }
  const hit = { company_id: input.company_id, severity: input.severity, text: input.text, href: input.href ?? null };
  await fanout(
    hit,
    {
      severity: input.severity,
      channels: input.channels ?? ['web', 'email'],
      to_roles: input.to_roles ?? ['chief_accountant'],
      enabled: true,
      threshold: {},
    },
  ).catch((err: unknown) => console.error(`[alerts] lỗi giao thông báo: ${(err as Error).message}`));
  return true;
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export async function evaluateAlerts(): Promise<Record<string, unknown>> {
  const day = today();
  const rules = await loadRules();
  const rule = (k: AlertKind): Rule => rules.get(k) ?? { severity: 2, channels: ['web'], to_roles: [], enabled: true, threshold: {} };
  const on = (k: AlertKind) => (rules.has(k) ? rule(k).enabled : true);
  const hits: Hit[] = [];

  /* 1 · chờ duyệt quá lâu */
  if (on('approval_overdue')) {
    const rows = await Models.Document.find({
      status: { $in: ['pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman'] },
      'approval.steps.sla_deadline': { $ne: null, $lt: new Date() },
    } as never)
      .select({ code: 1, company_id: 1, amount: 1, partner_id: 1, kind: 1 })
      .limit(200)
      .lean<Record<string, unknown>[]>();
    const partners = await loadPartnerRefs(rows.map((d) => (d.partner_id ? String(d.partner_id) : null)));
    for (const d of rows) {
      const minor = asBigInt((d.amount as { minor?: unknown } | undefined)?.minor);
      hits.push({
        alert_type: 'approval_overdue',
        company_id: String(d.company_id),
        severity: rule('approval_overdue').severity,
        text: `${String(d.code)} chờ duyệt quá SLA${withPartner(partnerLabelOf(partners, d.partner_id))} · ${compact(minor)}`,
        amount_minor: minor,
        href: docHref(String(d.kind), String(d._id)),
        dedupe_key: `approval_overdue:${String(d._id)}:${day}`,
      });
    }
  }

  /* 2 · đáo hạn — luôn kèm số ngày cụ thể (DS §3.3); tên ngân hàng theo partner_id */
  if (on('loan_maturity')) {
    const ladder = await maturityLadder({ companyIds: null }, { horizonDays: 30 });
    const loanIds = ladder.filter((m) => m.level >= 1).map((m) => m.loan_id);
    const loans = loanIds.length
      ? await Models.BankDebt.find({ _id: { $in: loanIds } } as never).select({ partner_id: 1 }).lean<{ _id: unknown; partner_id?: unknown }[]>()
      : [];
    const partnerOfLoan = new Map(loans.map((l) => [String(l._id), l.partner_id ? String(l.partner_id) : null]));
    const partners = await loadPartnerRefs([...partnerOfLoan.values()]);
    for (const m of ladder) {
      if (m.level < 1) continue;
      const need = asBigInt(m.need_prepare.minor);
      const interest = asBigInt(m.interest_to_due.minor);
      const unplanned = !m.rollover?.prepared;
      const bankName = partnerNameOf(partners, partnerOfLoan.get(m.loan_id) ?? null, 'Chưa gán ngân hàng');
      hits.push({
        alert_type: 'loan_maturity',
        company_id: m.company_id,
        severity: m.level,
        text: `${bankName} ${m.contract_code} ${m.label} · cần chuẩn bị ${compact(need)}${interest > 0n ? ` (gồm lãi ${compact(interest)})` : ''}${
          unplanned ? ' · chưa có phương án đảo hạn' : ''
        }`,
        amount_minor: need,
        href: '/ngan-hang/dao-han',
        dedupe_key: `loan_maturity:${m.loan_id}:${day}`,
      });
    }
  }

  /* 3 · số dư SỔ CÁI dưới ngưỡng công ty (không trừ phong toả — v2 BỎ) */
  if (on('low_balance')) {
    const companies = await Models.Company.find({ status: 'active' }).select({ name: 1, min_balance_minor: 1 }).lean<{ _id: unknown; name?: string; min_balance_minor?: unknown }[]>();
    const views = await ledgerAccountViews({ companyIds: null }, { asOf: day });
    const actualByCompany = new Map<string, bigint>();
    for (const v of views) {
      if (v.is_group || !v.company_id) continue;
      actualByCompany.set(v.company_id, (actualByCompany.get(v.company_id) ?? 0n) + v.actual);
    }
    for (const c of companies) {
      const min = asBigInt(c.min_balance_minor);
      if (min <= 0n) continue;
      const total = actualByCompany.get(String(c._id)) ?? 0n;
      if (total < min) {
        hits.push({
          alert_type: 'low_balance',
          company_id: String(c._id),
          severity: rule('low_balance').severity,
          text: `${String(c.name)} số dư sổ cái ${compact(total)}, dưới ngưỡng ${compact(min)}`,
          amount_minor: min - total,
          href: null,
          dedupe_key: `low_balance:${String(c._id)}:${day}`,
        });
      }
    }
  }

  /* 4 · phải thu (hướng receivable) quá hạn — còn lại = giá trị − phân bổ đã thực thi */
  if (on('receivable_overdue')) {
    // Nhân viên (TK 334) chỉ đọc, không thuộc đối tác: không đưa vào cảnh báo phải thu quá hạn.
    const debts = await Models.DebtVoucher.find({ due_date: { $lt: day }, party_type: { $ne: 'employee' } } as never)
      .select({ company_id: 1, partner_id: 1, direction: 1, side: 1, value_minor: 1 })
      .lean<Record<string, unknown>[]>();
    const receivable = debts.filter((d) => debtDirectionOf(d as never) === 'receivable');
    const settlements = await loadDebtSettlements(receivable.map((d) => ({ id: String(d._id) })));
    const byDebt = new Map<string, typeof settlements>();
    for (const s of settlements) byDebt.set(s.target_id, [...(byDebt.get(s.target_id) ?? []), s]);
    const partners = await loadPartnerRefs(receivable.map((d) => (d.partner_id ? String(d.partner_id) : null)));
    const byCompany = new Map<string, { total: bigint; count: number; partners: Map<string, bigint> }>();
    for (const d of receivable) {
      const remaining = remainingOf(asBigInt(d.value_minor), executedSum(byDebt.get(String(d._id)) ?? []));
      if (remaining <= 0n) continue;
      const key = String(d.company_id);
      const cur = byCompany.get(key) ?? { total: 0n, count: 0, partners: new Map<string, bigint>() };
      cur.total += remaining;
      cur.count += 1;
      const pname = partnerNameOf(partners, d.partner_id ? String(d.partner_id) : null);
      cur.partners.set(pname, (cur.partners.get(pname) ?? 0n) + remaining);
      byCompany.set(key, cur);
    }
    for (const [company_id, v] of byCompany) {
      const top = [...v.partners.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 2).map(([n]) => n);
      hits.push({
        alert_type: 'receivable_overdue',
        company_id,
        severity: rule('receivable_overdue').severity,
        text: `${v.count} khoản phải thu quá hạn · ${compact(v.total)}${top.length ? ` · ${top.join(', ')}` : ''}`,
        amount_minor: v.total,
        href: '/thu/qua-han',
        dedupe_key: `receivable_overdue:${company_id}:${day}`,
      });
    }
  }

  /* 5 · vượt ngân sách */
  if (on('budget_exceeded')) {
    const budgets = await Models.Budget.find({} as never).lean();
    for (const b of budgets) {
      const limit = asBigInt(b.limit_minor);
      if (limit <= 0n) continue;
      const used = await Models.Document.aggregate(
        // aggregate $match không cast string → ObjectId — giữ nguyên ObjectId từ lean()
        [{ $match: { 'budget.budget_id': b._id as never, kind: 'spend', status: { $in: [...PLANNED_FLOW_STATUSES] } } }, { $group: { _id: null, total: { $sum: '$amount.minor' } } }] as never[],
      );
      const u = asBigInt((used as { total?: unknown }[])[0]?.total ?? 0n);
      const percent = Number((u * 100n) / limit);
      if (u > limit || percent >= 90) {
        hits.push({
          alert_type: 'budget_exceeded',
          company_id: String(b.company_id),
          severity: u > limit ? 3 : 2,
          text: `Ngân sách ${String((b as { period_start?: string }).period_start)} đạt ${percent}% · ${compact(u)}/${compact(limit)}`,
          amount_minor: u > limit ? u - limit : 0n,
          // chưa có màn ngân sách trên web: không đặt đường dẫn chết
          href: null,
          dedupe_key: `budget_exceeded:${String(b._id)}:${day}`,
        });
      }
    }
  }

  /* 6 · thiếu chứng từ */
  if (on('missing_evidence')) {
    const rows = await Models.Document.find({
      'evidence.missing.0': { $exists: true },
      status: { $in: ['draft', 'pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman'] },
    } as never)
      .select({ code: 1, company_id: 1, partner_id: 1, kind: 1 })
      .limit(200)
      .lean<Record<string, unknown>[]>();
    const partners = await loadPartnerRefs(rows.map((d) => (d.partner_id ? String(d.partner_id) : null)));
    for (const d of rows) {
      hits.push({
        alert_type: 'missing_evidence',
        company_id: String(d.company_id),
        severity: rule('missing_evidence').severity,
        text: `Hồ sơ ${String(d.code)}${withPartner(partnerLabelOf(partners, d.partner_id))} thiếu chứng từ`,
        amount_minor: null,
        href: docHref(String(d.kind), String(d._id)),
        dedupe_key: `missing_evidence:${String(d._id)}:${day}`,
      });
    }
  }

  /* 7 · thanh toán đến hạn — quá hạn tính theo ĐÚNG giờ:phút deadline */
  if (on('payment_due')) {
    const rows = await Models.Document.find({ status: 'approved', planned_date: { $lte: dayEndOf(addDays(day, 3)) } } as never)
      .select({ code: 1, company_id: 1, amount: 1, planned_date: 1, partner_id: 1, kind: 1 })
      .limit(200)
      .lean<Record<string, unknown>[]>();
    const partners = await loadPartnerRefs(rows.map((d) => (d.partner_id ? String(d.partner_id) : null)));
    for (const d of rows) {
      const minor = asBigInt((d.amount as { minor?: unknown } | undefined)?.minor);
      const planned = String(d.planned_date ?? '');
      const late = isDeadlinePast(planned);
      const who = withPartner(partnerLabelOf(partners, d.partner_id));
      hits.push({
        alert_type: 'payment_due',
        company_id: String(d.company_id),
        severity: late ? 3 : rule('payment_due').severity,
        text: late
          ? `${String(d.code)}${who} QUÁ HẠN thanh toán ${deadlineLabel(planned)} · ${compact(minor)}`
          : `${String(d.code)}${who} đến hạn thanh toán ${deadlineLabel(planned)} · ${compact(minor)}`,
        amount_minor: minor,
        href: docHref(String(d.kind), String(d._id)),
        dedupe_key: `payment_due:${String(d._id)}:${day}:${late ? 'late' : 'soon'}`,
      });
    }
  }

  /* 8 · dòng tiền âm trong 30 ngày tới (dự báo: sổ cái + phiếu chờ thực thi, không đếm trùng) */
  if (on('negative_cashflow')) {
    const fc = await cashflowForecast({ companyIds: null }, { horizon: 30, from: day });
    const negative = fc.days.find((d) => BigInt(d.closing.minor) < 0n);
    if (negative) {
      const minClosing = BigInt(fc.totals.min_closing.minor);
      hits.push({
        alert_type: 'negative_cashflow',
        company_id: null,
        severity: 3,
        text: `Dòng tiền 30 ngày tới dự kiến âm ${compact(-minClosing)} (từ ${negative.date})`,
        amount_minor: -minClosing,
        href: '/dong-tien',
        dedupe_key: `negative_cashflow:${day}`,
      });
    }
  }

  /* 9 · lượt tự động lỗi — engine đã ghi cảnh báo lúc lỗi; ở đây chỉ bù cho lượt chưa có cảnh báo */
  if (on('automation_run_failed')) {
    const since = new Date(Date.now() - 14 * 86_400_000);
    const runs = await Models.AutomationRun.find({ status: 'failed', updated_at: { $gte: since } } as never)
      .select({ rule_code: 1, company_id: 1, source_id: 1, source_type: 1, error: 1, event_type: 1 })
      .limit(200)
      .lean<Record<string, unknown>[]>();
    const keys = runs.flatMap((r) => [`automation_run_failed:${String(r._id)}`, `automation_failed:${String(r._id)}`]);
    const existing = keys.length ? new Set((await Models.Alert.find({ dedupe_key: { $in: keys } } as never).select({ dedupe_key: 1 }).lean<{ dedupe_key?: string }[]>()).map((a) => a.dedupe_key)) : new Set<string>();
    for (const r of runs) {
      const id = String(r._id);
      if (existing.has(`automation_run_failed:${id}`) || existing.has(`automation_failed:${id}`)) continue;
      hits.push({
        alert_type: 'automation_run_failed',
        company_id: r.company_id ? String(r.company_id) : null,
        severity: rule('automation_run_failed').severity,
        text: `Quy trình tự động ${String(r.rule_code)} lỗi${r.error ? `: ${String(r.error).slice(0, 160)}` : ''}`,
        amount_minor: null,
        href: '/can-xu-ly',
        dedupe_key: `automation_run_failed:${id}`,
        subject: { run_id: id, rule_code: String(r.rule_code), source_id: String(r.source_id ?? '') },
      });
    }
  }

  let created = 0;
  for (const h of hits) {
    const inserted = await Models.Alert.updateOne(
      { dedupe_key: h.dedupe_key },
      {
        $setOnInsert: {
          type: 'event',
          alert_type: h.alert_type,
          company_id: h.company_id,
          severity: h.severity,
          text: h.text,
          amount_minor: h.amount_minor,
          href: h.href,
          subject: h.subject ?? null,
          dedupe_key: h.dedupe_key,
          created_at: new Date(),
        },
      },
      { upsert: true },
    ).exec();
    if (!inserted.upsertedCount) continue;
    created++;
    await fanout(h, rule(h.alert_type));
  }
  return { evaluated: hits.length, created, at: new Date().toISOString() };
}

function partnerLabelOf(partners: Map<string, PartnerRef>, partnerId: unknown): string | null {
  if (!partnerId) return null;
  return partners.get(String(partnerId))?.name ?? null;
}

/** Giao cho đúng vai trò nhận (`to_roles` của rule) — web luôn, email khi danger. */
async function fanout(hit: Pick<Hit, 'company_id' | 'severity' | 'text' | 'href'>, r: Rule): Promise<void> {
  const roles = r.to_roles.length ? r.to_roles : ['chief_accountant', 'director'];
  const assignments = await Models.Assignment.find({
    $or: hit.company_id
      ? [{ company_id: hit.company_id, role: { $in: roles }, status: 'active' }]
      : [{ role: { $in: roles }, status: 'active' }],
  } as never)
    .select({ user_id: 1 })
    .lean();
  const userIds = [...new Set(assignments.map((a) => String(a.user_id)))];
  if (!userIds.length) return;
  const users = await Models.User.find({ _id: { $in: userIds as never }, status: 'active' }).select({ email: 1, prefs: 1 }).lean();

  for (const u of users) {
    if (r.channels.includes('web')) {
      await Models.Notification.create({
        user_id: String(u._id),
        company_id: hit.company_id,
        kind: 'alert',
        severity: hit.severity,
        title: hit.text.slice(0, 120),
        body: hit.text,
        href: hit.href,
      } as never).catch(() => undefined);
    }
    const wantsEmail = ((u as { prefs?: { notify_channels?: string[] } }).prefs?.notify_channels ?? ['web']).includes('email');
    if (r.channels.includes('email') && wantsEmail && hit.severity >= 3) {
      void sendMail({
        to: String(u.email),
        subject: hit.text.slice(0, 100),
        html: mailTemplates.digest({ name: '', body: `<p>${hit.text}</p>`, href: hit.href ?? '/thong-bao' }),
        urgent: true,
      });
    }
  }
}

/**
 * 8 loại cảnh báo (blueprint §XVIII) — `alerts` chứa cả rule lẫn event (§8.1).
 * Dedupe `key = rule + subject + period` (§9.4) → task chạy mỗi 15 phút không spam.
 * Email chỉ cho severity = danger (§9.4); quiet hours xử lý ở mail/sender.
 */

import { addDays, dayEndOf, dayStartOf, deadlineLabel, formatMoney, isDeadlinePast, money, today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { mailTemplates, sendMail } from '../../mail/sender.ts';
import { asBigInt, maturityLadder } from '../queries/index.ts';

export type AlertKind =
  | 'approval_overdue'
  | 'loan_maturity'
  | 'low_balance'
  | 'receivable_overdue'
  | 'budget_exceeded'
  | 'missing_evidence'
  | 'payment_due'
  | 'negative_cashflow';

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
}

const compact = (minor: bigint) => formatMoney(money(minor), { mode: 'compact' });

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

export async function evaluateAlerts(): Promise<Record<string, unknown>> {
  const day = today();
  const rules = await loadRules();
  const rule = (k: AlertKind): Rule => rules.get(k) ?? { severity: 2, channels: ['web'], to_roles: [], enabled: true, threshold: {} };
  const on = (k: AlertKind) => rules.has(k) ? rule(k).enabled : true;
  const hits: Hit[] = [];

  /* 1 · chờ duyệt quá lâu */
  if (on('approval_overdue')) {
    const rows = await Models.Document.find({
      status: { $in: ['pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman'] },
      'approval.steps.sla_deadline': { $ne: null, $lt: new Date() },
    } as never)
      .select({ code: 1, company_id: 1, amount: 1 })
      .limit(200)
      .lean();
    for (const d of rows) {
      const minor = asBigInt((d.amount as { minor?: unknown } | undefined)?.minor);
      hits.push({
        alert_type: 'approval_overdue',
        company_id: String(d.company_id),
        severity: rule('approval_overdue').severity,
        text: `${String(d.code)} chờ duyệt quá SLA · ${compact(minor)}`,
        amount_minor: minor,
        href: `/ho-so/chi/${String(d._id)}`,
        dedupe_key: `approval_overdue:${String(d._id)}:${day}`,
      });
    }
  }

  /* 2 · đáo hạn — luôn kèm số ngày cụ thể (DS §3.3) */
  if (on('loan_maturity')) {
    for (const m of await maturityLadder({ companyIds: null }, { horizonDays: 30 })) {
      if (m.level < 1) continue;
      hits.push({
        alert_type: 'loan_maturity',
        company_id: m.company_id,
        severity: m.level,
        text: `${m.bank_name} ${m.contract_code} ${m.label} · ${compact(asBigInt(m.outstanding.minor))}`,
        amount_minor: asBigInt(m.outstanding.minor),
        href: '/ngan-hang/dao-han',
        dedupe_key: `loan_maturity:${m.loan_id}:${day}`,
      });
    }
  }

  /* 3 · số dư dưới ngưỡng công ty */
  if (on('low_balance')) {
    const companies = await Models.Company.find({ status: 'active' }).select({ name: 1, min_balance_minor: 1 }).lean();
    for (const c of companies) {
      const min = asBigInt(c.min_balance_minor);
      if (min <= 0n) continue;
      const latest = await Models.BalanceDaily.find({ company_id: String(c._id) } as never).sort({ date: -1 }).limit(40).lean();
      const seen = new Set<string>();
      let total = 0n;
      for (const b of latest) {
        const acct = String(b.account_id);
        if (seen.has(acct)) continue;
        seen.add(acct);
        total += asBigInt(b.closing_minor) - asBigInt(b.blocked_minor);
      }
      if (total < min) {
        hits.push({
          alert_type: 'low_balance',
          company_id: String(c._id),
          severity: rule('low_balance').severity,
          text: `${String(c.name)} còn khả dụng ${compact(total)}, dưới ngưỡng ${compact(min)}`,
          amount_minor: min - total,
          href: null,
          dedupe_key: `low_balance:${String(c._id)}:${day}`,
        });
      }
    }
  }

  /* 4 · phải thu quá hạn */
  if (on('receivable_overdue')) {
    const rows = await Models.DebtItem.find({ kind: 'receivable', status: { $ne: 'settled' }, due_date: { $lt: day } } as never).lean();
    const byCompany = new Map<string, { total: bigint; count: number }>();
    for (const r of rows) {
      const key = String(r.company_id);
      const cur = byCompany.get(key) ?? { total: 0n, count: 0 };
      cur.total += asBigInt(r.value_minor) - asBigInt(r.settled_minor);
      cur.count += 1;
      byCompany.set(key, cur);
    }
    for (const [company_id, v] of byCompany) {
      hits.push({
        alert_type: 'receivable_overdue',
        company_id,
        severity: rule('receivable_overdue').severity,
        text: `${v.count} khoản phải thu quá hạn · ${compact(v.total)}`,
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
        [{ $match: { 'budget.budget_id': b._id as never, kind: 'spend', status: { $ne: 'draft' } } }, { $group: { _id: null, total: { $sum: '$amount.minor' } } }] as never[],
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
          href: '/dong-tien/ngan-sach',
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
      .select({ code: 1, company_id: 1 })
      .limit(200)
      .lean();
    for (const d of rows) {
      hits.push({
        alert_type: 'missing_evidence',
        company_id: String(d.company_id),
        severity: rule('missing_evidence').severity,
        text: `Hồ sơ ${String(d.code)} thiếu chứng từ`,
        amount_minor: null,
        href: `/ho-so/chi/${String(d._id)}`,
        dedupe_key: `missing_evidence:${String(d._id)}:${day}`,
      });
    }
  }

  /* 7 · thanh toán đến hạn — quá hạn tính theo ĐÚNG giờ:phút deadline */
  if (on('payment_due')) {
    const rows = await Models.Document.find({ status: 'approved', planned_date: { $lte: dayEndOf(addDays(day, 3)) } } as never)
      .select({ code: 1, company_id: 1, amount: 1, planned_date: 1 })
      .limit(200)
      .lean();
    for (const d of rows) {
      const minor = asBigInt((d.amount as { minor?: unknown } | undefined)?.minor);
      const planned = String(d.planned_date ?? '');
      const late = isDeadlinePast(planned);
      hits.push({
        alert_type: 'payment_due',
        company_id: String(d.company_id),
        severity: late ? 3 : rule('payment_due').severity,
        text: late
          ? `${String(d.code)} QUÁ HẠN thanh toán ${deadlineLabel(planned)} · ${compact(minor)}`
          : `${String(d.code)} đến hạn thanh toán ${deadlineLabel(planned)} · ${compact(minor)}`,
        amount_minor: minor,
        href: '/chi/cho-thanh-toan',
        dedupe_key: `payment_due:${String(d._id)}:${day}:${late ? 'late' : 'soon'}`,
      });
    }
  }

  /* 8 · dòng tiền âm dự kiến 30 ngày */
  if (on('negative_cashflow')) {
    const latest = await Models.BalanceDaily.find({} as never).sort({ date: -1 }).limit(500).lean();
    const seen = new Set<string>();
    let start = 0n;
    for (const b of latest) {
      if (seen.has(String(b.account_id))) continue;
      seen.add(String(b.account_id));
      start += asBigInt(b.closing_minor);
    }
    const flows = await Models.Document.aggregate(
      [
        { $match: { planned_date: { $gte: dayStartOf(day), $lte: dayEndOf(addDays(day, 30)) }, status: { $ne: 'draft' } } },
        { $group: { _id: '$kind', total: { $sum: '$amount.minor' } } },
      ] as never[],
    );
    let projected = start;
    for (const f of flows as { _id?: unknown; total?: unknown }[]) {
      projected += (String(f._id) === 'income' ? 1n : -1n) * asBigInt(f.total);
    }
    if (projected < 0n) {
      hits.push({
        alert_type: 'negative_cashflow',
        company_id: null,
        severity: 3,
        text: `Dòng tiền 30 ngày tới dự kiến âm ${compact(-projected)}`,
        amount_minor: -projected,
        href: '/dong-tien',
        dedupe_key: `negative_cashflow:${day}`,
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

/** Giao cho đúng vai trò nhận (`to_roles` của rule) — web luôn, email khi danger. */
async function fanout(hit: Hit, r: Rule): Promise<void> {
  const roles = r.to_roles.length ? r.to_roles : ['chief_accountant', 'director'];
  const orClauses: Record<string, unknown>[] = [{ role: { $in: roles }, status: 'active' }];
  if (hit.company_id) orClauses.push({ company_id: hit.company_id, role: { $in: roles }, status: 'active' });
  const assignments = await Models.Assignment.find({ $or: hit.company_id ? [{ company_id: hit.company_id, role: { $in: roles }, status: 'active' }] : orClauses.slice(0, 1) } as never)
    .select({ user_id: 1 })
    .lean();
  const userIds = [...new Set(assignments.map((a) => String(a.user_id)))];
  if (!userIds.length) return;
  const users = await Models.User.find({ _id: { $in: userIds } as never, status: 'active' }).select({ email: 1, prefs: 1 }).lean();

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

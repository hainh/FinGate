/**
 * Khoản chi định kỳ (§XVII) — task 00:05 VN vật phiếu NHÁP cho kỳ tới + nhắc 7/3/1 ngày.
 * `last_run_period` là con dấu idempotency: chạy lại trong cùng kỳ không tạo phiếu trùng.
 */

import { addDays, formatMoney, money, today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { nextDocumentCode } from '../numbering/index.ts';
import { buildHistoryEntry } from '../audit/index.ts';

interface RuleRow extends Record<string, unknown> {
  _id: unknown;
  company_id: unknown;
  title: string;
  purpose?: string | null;
  category_id?: unknown;
  department_id?: unknown;
  payee?: { name?: string };
  amount_minor?: unknown;
  currency?: string;
  source?: { fund?: string; account_id?: unknown };
  cadence?: string;
  day_of_period?: number;
  remind_days?: number[];
  effective_from?: string;
  effective_to?: string | null;
  last_run_period?: string | null;
  auto_create_draft?: boolean;
}

export async function materializeRecurring(): Promise<Record<string, unknown>> {
  const day = today();
  const rules = (await Models.RecurringRule.find({ status: 'active', effective_from: { $lte: day } } as never).limit(500).lean()) as unknown as RuleRow[];
  let created = 0;
  let reminded = 0;
  let skipped = 0;

  for (const r of rules) {
    if (r.effective_to && day > String(r.effective_to)) continue;
    const next = nextDue(r, day);
    if (!next) continue;
    const period = periodOf(String(r.cadence ?? 'monthly'), next);

    if (r.last_run_period === period) skipped++;
    else if (r.auto_create_draft === false) continue;
    else if (next < day || next > addDays(day, 14)) continue;
    else {
      const code = await nextDocumentCode('spend');
      const doc = await Models.Document.create({
        code,
        kind: 'spend',
        company_id: r.company_id,
        department_id: r.department_id ?? null,
        created_by: null,
        status: 'draft',
        version: 1,
        title: r.title,
        purpose: r.purpose ?? r.title,
        category_id: r.category_id ?? null,
        payee: { name: String(r.payee?.name ?? ''), is_internal: false },
        amount: { minor: BigInt(String(r.amount_minor ?? '0')), currency: String(r.currency ?? 'VND'), decimals: 0 },
        source: { fund: String(r.source?.fund ?? 'bank'), account_id: r.source?.account_id ?? null },
        planned_date: next,
        business_date: day,
        note: `Phát sinh tự động từ khoản định kỳ ${period}`,
        evidence: { required: [], present: [], missing: [] },
        approval: { steps: [] },
        history: [
          buildHistoryEntry({
            action: 'recurring_materialize',
            actor: { user_id: null, role: null, name: 'Hệ thống' },
            to: 'draft',
            fields: { rule_id: String(r._id), period, planned_date: next },
          }),
        ],
      } as never);
      await Models.RecurringRule.updateOne(
        { _id: r._id } as never,
        { $set: { last_run_period: period, last_document_id: (doc as { _id?: unknown })._id ?? null, updated_at: new Date() } },
      ).exec();
      created++;
    }

    const days = Math.ceil((new Date(`${next}T00:00:00Z`).getTime() - Date.now()) / 86_400_000);
    const remindDays = r.remind_days?.length ? r.remind_days : [7, 3, 1];
    if (remindDays.includes(days)) {
      const res = await Models.Alert.updateOne(
        { dedupe_key: `recurring_remind:${String(r._id)}:${next}` },
        {
          $setOnInsert: {
            type: 'event',
            alert_type: 'payment_due',
            company_id: r.company_id,
            severity: 1,
            text: `${r.title} đến hạn ${next} · ${formatMoney(money(BigInt(String(r.amount_minor ?? '0'))), { mode: 'compact' })}`,
            href: '/chi/dinh-ky',
            dedupe_key: `recurring_remind:${String(r._id)}:${next}`,
            created_at: new Date(),
          },
        },
        { upsert: true },
      ).exec();
      if (res.upsertedCount) reminded++;
    }
  }
  return { rules: rules.length, created, reminded, skipped, at: new Date().toISOString() };
}

/** Nhãn kỳ: `2026-09` (tháng) · `2026-Q3` · `2026` — dùng làm con dấu chống trùng. */
export function periodOf(cadence: string, iso: string): string {
  const y = iso.split('-')[0] ?? String(new Date().getUTCFullYear());
  const month = Number(iso.split('-')[1] ?? '1');
  switch (cadence) {
    case 'annual':
      return y;
    case 'semi_annual':
      return `${y}-H${month > 6 ? 2 : 1}`;
    case 'quarterly':
      return `${y}-Q${Math.ceil(month / 3)}`;
    case 'weekly': {
      const d = new Date(`${iso}T00:00:00Z`);
      return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    }
    default:
      return `${y}-${String(month).padStart(2, '0')}`;
  }
}

/** Ngày phát sinh kế tiếp >= `from`, không bao giờ quay lại quá khứ. */
export function nextDue(rule: RuleRow, from: string): string | null {
  const cadence = String(rule.cadence ?? 'monthly');
  const dayOfPeriod = Math.max(1, Math.min(28, Number(rule.day_of_period ?? 1)));
  let cursor = (rule.effective_from && rule.effective_from > from ? rule.effective_from : from) as string;

  for (let i = 0; i < 60; i++) {
    if (cadence === 'weekly') {
      const d = new Date(`${cursor}T00:00:00Z`);
      const target = dayOfPeriod % 7;
      const hit = addDays(cursor, (target - d.getUTCDay() + 7) % 7);
      if (hit >= from) return hit;
      cursor = addDays(cursor, 7);
      continue;
    }
    const [yRaw, mRaw] = cursor.split('-');
    const y = yRaw ?? String(new Date().getUTCFullYear());
    const month = Number(mRaw ?? '1');
    const candidate = `${y}-${String(month).padStart(2, '0')}-${String(dayOfPeriod).padStart(2, '0')}`;
    if (candidate >= from) return candidate;
    const stepMonths = cadence === 'annual' ? 12 : cadence === 'semi_annual' ? 6 : cadence === 'quarterly' ? 3 : 1;
    const nextMonth = month + stepMonths;
    cursor = `${Number(y) + Math.floor((nextMonth - 1) / 12)}-${String(((nextMonth - 1) % 12) + 1).padStart(2, '0')}-01`;
  }
  return null;
}

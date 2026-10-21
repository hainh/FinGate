/**
 * Khoản chi định kỳ (§XVII; v2/v2.md §11.3 R5, §14.3).
 *
 * - Tác vụ `recurring` (cron 00:05 VN) KHÔNG tạo phiếu nữa: chỉ phát sự kiện lịch `schedule.recurring` cho
 *   từng khoản đến kỳ (subject = khoản định kỳ, payload = kỳ + ngày dự kiến).
 * - Quy tắc R5 của bộ máy tự động tạo phiếu NHÁP cho kỳ đó (`createRecurringDraft`): đứng tên kế toán trưởng
 *   của công ty, nhãn Tự động (`origin`), đối tác theo `partner_id`.
 * - Nhắc trước 7/3/1 ngày vẫn do tác vụ này đảm nhiệm (chỉ cảnh báo, không tạo phiếu).
 * - Idempotency: kỳ đã có phiếu (lịch sử `recurring_materialize` của khoản) ⇒ không tạo thêm; đã có sự kiện chờ
 *   cho cùng kỳ ⇒ không phát thêm.
 */

import { addDays, formatMoney, money, today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { nextDocumentCode } from '../numbering/index.ts';
import { buildHistoryEntry, mirrorAudit } from '../audit/index.ts';
import { emitDomainEvent, emitVoucherEvent, type VoucherEventSubject } from '../events/index.ts';

/** Khoản định kỳ ở dạng đọc được (chỉ các trường dùng ở đây). */
export interface RecurringRuleRow extends Record<string, unknown> {
  _id: unknown;
  company_id: unknown;
  title: string;
  purpose?: string | null;
  category_id?: unknown;
  department_id?: unknown;
  payee?: { name?: string };
  partner_id?: unknown;
  amount_minor?: unknown;
  currency?: string;
  source?: { fund?: string; account_id?: unknown };
  cadence?: string;
  day_of_period?: number;
  remind_days?: number[];
  effective_from?: string;
  effective_to?: string | null;
  last_run_period?: string | null;
  last_document_id?: unknown;
  auto_create_draft?: boolean;
  status?: string;
}

/** Số lần / ngày nhìn trước khi phát sự kiện: kỳ trong vòng 14 ngày tới. */
const LOOKAHEAD_DAYS = 14;

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
export function nextDue(rule: Pick<RecurringRuleRow, 'cadence' | 'day_of_period' | 'effective_from'>, from: string): string | null {
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

/** Khoản còn hiệu lực vào ngày `day` (chưa hết hạn). */
function activeOn(rule: RecurringRuleRow, day: string): boolean {
  return !(rule.effective_to && day > String(rule.effective_to));
}

/* ------------------------------------------------------------------ *
 * Phát sự kiện lịch (R5 xử lý qua bộ máy tự động)
 * ------------------------------------------------------------------ */

/** Phát `schedule.recurring` cho từng khoản đến kỳ trong 14 ngày tới (mỗi kỳ một sự kiện). */
export async function scheduleRecurringDue(day: string = today()): Promise<{ rules: number; scheduled: number; skipped: number }> {
  const rules = (await Models.RecurringRule.find({
    status: 'active',
    effective_from: { $lte: day },
    auto_create_draft: { $ne: false },
  } as never)
    .limit(500)
    .lean()) as unknown as RecurringRuleRow[];

  let scheduled = 0;
  let skipped = 0;
  for (const r of rules) {
    if (!activeOn(r, day)) continue;
    const next = nextDue(r, day);
    if (!next || next < day || next > addDays(day, LOOKAHEAD_DAYS)) continue;
    const period = periodOf(String(r.cadence ?? 'monthly'), next);
    if (r.last_run_period === period) {
      skipped++;
      continue;
    }
    const waiting = await Models.DomainEvent.exists({
      type: 'schedule.recurring',
      subject_id: r._id,
      processed_at: null,
      'payload.period': period,
    } as never);
    if (waiting) {
      skipped++;
      continue;
    }
    await emitDomainEvent({
      type: 'schedule.recurring',
      company_id: String(r.company_id),
      subject_type: 'recurring_rule',
      subject_id: String(r._id),
      payload: { period, planned_date: `${next}T09:00`, cadence: String(r.cadence ?? 'monthly') },
      actor: null,
    });
    scheduled++;
  }
  return { rules: rules.length, scheduled, skipped };
}

/* ------------------------------------------------------------------ *
 * R5: tạo phiếu nháp cho một kỳ (gọi từ quy tắc tự động)
 * ------------------------------------------------------------------ */

/**
 * Tạo phiếu NHÁP của khoản định kỳ cho kỳ `period` (idempotent theo lịch sử `recurring_materialize`).
 * Trả về null nếu khoản không còn đang hoạt động. Người đứng tên: kế toán trưởng đang phụ trách công ty.
 */
export async function createRecurringDraft(input: {
  ruleId: string;
  period: string;
  plannedDate: string;
  runId: string;
  requestId: string;
  actor: { user_id: string | null; name: string | null; role: string | null };
}): Promise<{ id: string; code: string; created: boolean } | null> {
  const r = await Models.RecurringRule.findById(input.ruleId).lean<RecurringRuleRow | null>();
  if (!r || r.status !== 'active') return null;
  const ruleId = String(r._id);

  const done = await Models.Document.findOne({
    company_id: r.company_id,
    kind: 'spend',
    history: { $elemMatch: { action: 'recurring_materialize', 'fields.rule_id': ruleId, 'fields.period': input.period } },
  } as never)
    .select({ _id: 1, code: 1 })
    .lean<{ _id: unknown; code: string } | null>();
  if (done) return { id: String(done._id), code: done.code, created: false };

  const ktt = await Models.Assignment.findOne({ company_id: r.company_id, role: 'chief_accountant', status: 'active' } as never)
    .select({ user_id: 1 })
    .lean<{ user_id: unknown } | null>();
  if (!ktt) throw new Error('Công ty chưa có kế toán trưởng để đứng tên phiếu nháp định kỳ');

  const partner = r.partner_id ? await Models.Partner.findById(String(r.partner_id)).select({ name: 1 }).lean<{ name?: string } | null>() : null;
  const now = new Date();
  const code = await nextDocumentCode('spend', now);
  const doc = await Models.Document.create({
    code,
    kind: 'spend',
    company_id: r.company_id,
    department_id: r.department_id ?? null,
    created_by: ktt.user_id,
    status: 'draft',
    version: 1,
    title: r.title,
    purpose: r.purpose ?? r.title,
    category_id: r.category_id ?? null,
    payee: { name: String(partner?.name ?? r.payee?.name ?? ''), is_internal: false },
    partner_id: r.partner_id ?? null,
    tag_ids: [],
    amount: { minor: BigInt(String(r.amount_minor ?? '0')), currency: String(r.currency ?? 'VND'), decimals: 0 },
    source: { fund: String(r.source?.fund ?? 'bank'), account_id: r.source?.account_id ?? null },
    planned_date: input.plannedDate,
    business_date: today(),
    note: `Phát sinh tự động từ khoản định kỳ ${input.period}`,
    evidence: { required: [], present: [], missing: [] },
    approval: { steps: [] },
    origin: { kind: 'automation', run_id: input.runId, rule_code: 'R5' },
    history: [
      buildHistoryEntry({
        action: 'recurring_materialize',
        actor: { user_id: null, role: null, name: input.actor.name ?? 'Hệ thống tự động' },
        to: 'draft',
        fields: { rule_id: ruleId, period: input.period, planned_date: input.plannedDate, run_id: input.runId },
        at: now,
      }),
    ],
    created_at: now,
    updated_at: now,
  } as never);
  const id = String(doc._id);

  const subject: VoucherEventSubject = {
    _id: doc._id,
    company_id: r.company_id,
    kind: 'spend',
    code,
    status: 'draft',
    partner_id: r.partner_id ?? null,
    amount: { minor: BigInt(String(r.amount_minor ?? '0')), currency: String(r.currency ?? 'VND') },
    options: null,
  };
  await emitVoucherEvent('voucher.created', subject, { user_id: null, name: input.actor.name, role: null }, {
    from: null,
    to: 'draft',
    action: 'recurring_materialize',
    recurring_rule_id: ruleId,
    period: input.period,
  });
  await Models.RecurringRule.updateOne(
    { _id: r._id } as never,
    { $set: { last_run_period: input.period, last_document_id: doc._id, updated_at: now } } as never,
  ).exec();
  await mirrorAudit({
    at: now,
    actor: { user_id: null, name: input.actor.name ?? 'Hệ thống tự động', role: null },
    action: 'recurring.materialize',
    subject: { type: 'spend', id, code },
    company_id: String(r.company_id),
    document_id: id,
    diff_fields: { rule_id: ruleId, period: input.period, planned_date: input.plannedDate },
    request_id: input.requestId,
  });
  return { id, code, created: true };
}

/* ------------------------------------------------------------------ *
 * Nhắc 7/3/1 ngày (cảnh báo, không tạo phiếu) + tác vụ định kỳ
 * ------------------------------------------------------------------ */

/** Nhắc trước kỳ (mặc định 7/3/1 ngày) bằng cảnh báo `payment_due`, dedupe theo khoản + ngày đến kỳ. */
export async function remindRecurring(day: string = today()): Promise<number> {
  const rules = (await Models.RecurringRule.find({ status: 'active', effective_from: { $lte: day } } as never).limit(500).lean()) as unknown as RecurringRuleRow[];
  let reminded = 0;
  for (const r of rules) {
    if (!activeOn(r, day)) continue;
    const next = nextDue(r, day);
    if (!next) continue;
    const days = Math.ceil((new Date(`${next}T00:00:00Z`).getTime() - Date.now()) / 86_400_000);
    const remindDays = r.remind_days?.length ? r.remind_days : [7, 3, 1];
    if (!remindDays.includes(days)) continue;
    const amountMinor = BigInt(String(r.amount_minor ?? '0'));
    const dedupe = `recurring_remind:${String(r._id)}:${next}`;
    const res = await Models.Alert.updateOne(
      { dedupe_key: dedupe },
      {
        $setOnInsert: {
          type: 'event',
          alert_type: 'payment_due',
          company_id: r.company_id,
          severity: 1,
          text: `${r.title} đến hạn ${next} · ${formatMoney(money(amountMinor), { mode: 'compact' })}`,
          href: '/chi/dinh-ky',
          dedupe_key: dedupe,
          created_at: new Date(),
        },
      },
      { upsert: true },
    ).exec();
    if (res.upsertedCount) reminded++;
  }
  return reminded;
}

/** Tác vụ `recurring`: phát sự kiện lịch cho các khoản đến kỳ + nhắc 7/3/1 ngày. */
export async function runRecurringTick(): Promise<Record<string, unknown>> {
  const day = today();
  const scheduled = await scheduleRecurringDue(day);
  const reminded = await remindRecurring(day);
  return { ...scheduled, reminded, at: new Date().toISOString() };
}

/** Tên cũ của tác vụ (tương thích). */
export const materializeRecurring = runRecurringTick;

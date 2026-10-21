/**
 * Outbox sự kiện nghiệp vụ (v2/v2.md §11.2, §14.2 `domain_events`, §14.3 (2)).
 *
 * Quy tắc:
 *  - Sự kiện được GHI SAU KHI đổi trạng thái đã commit (CAS). Codebase không dùng transaction
 *    (ADR-03), nên ghi sự kiện là BEST-EFFORT: lỗi chỉ được log, KHÔNG làm hỏng nghiệp vụ gốc.
 *  - Khi truyền `session` (khi về sau có transaction) thì lỗi được NÉM RA để transaction rollback.
 *  - Ghi thành công ⇒ kích bộ máy tự động (`kickAutomation`, setImmediate, gộp nhiều lần gọi).
 *    Việc xử lý thật do `domain/automation/engine.ts` đảm nhiệm — không chờ chu kỳ job.
 */

import type { ClientSession } from 'mongoose';
import { docHref } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { kickAutomation } from '../automation/engine.ts';

/** Sự kiện phiếu thu/chi — phát từ các điểm chuyển trạng thái (v2 §7.2, §8). */
export const VOUCHER_EVENT_TYPES = [
  'voucher.created',
  'voucher.updated',
  'voucher.submitted',
  'voucher.step_approved',
  'voucher.approved',
  'voucher.rejected',
  'voucher.changes_requested',
  'voucher.queued',
  'voucher.paid',
  'voucher.cancelled',
  'voucher.expired',
] as const;
export type VoucherEventType = (typeof VOUCHER_EVENT_TYPES)[number];

/** Sự kiện công nợ / khoản vay (v2 §9, §10, §11). */
export type DebtLoanEventType = 'debt.created' | 'loan.created' | 'loan.settled';

/** Sự kiện theo lịch (VD R5 khoản chi định kỳ) — tiến trình lịch phát `schedule.<tên>`. */
export type ScheduleEventType = `schedule.${string}`;

export type DomainEventType = VoucherEventType | DebtLoanEventType | ScheduleEventType;

/** Đối tượng nguồn của sự kiện: giống `LinkObjectType` (document | debt_voucher | bank_debt). */
export type DomainSubjectType = 'document' | 'debt_voucher' | 'bank_debt' | (string & {});

export interface DomainEventActor {
  user_id?: string | null;
  name?: string | null;
  role?: string | null;
}

export interface DomainEventInput {
  type: DomainEventType;
  company_id?: string | null;
  subject_type: DomainSubjectType;
  subject_id?: string | null;
  payload?: Record<string, unknown>;
  actor?: DomainEventActor | null;
}

/** Tên sự kiện: `nhóm.hành_động`, chữ thường, có thể có gạch dưới (VD `voucher.step_approved`). */
const EVENT_TYPE_RE = /^[a-z]+(\.[a-z_]+)+$/;

/**
 * Chuyển giá trị về dạng lưu được trong `Mixed`: BigInt → chuỗi (BSON không đảm bảo BigInt),
 * ObjectId → hex, Date → ISO. Giới hạn độ sâu để tránh object vòng.
 */
export function toEventPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;
  if (depth > 5) return null;
  if (Array.isArray(value)) return value.map((v) => toEventPayload(v, depth + 1));
  const maybeId = value as { toHexString?: () => string };
  if (typeof maybeId.toHexString === 'function') return maybeId.toHexString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = toEventPayload(v, depth + 1);
  return out;
}

/** Dựng bản ghi `domain_events` (thuần — không chạm DB). Ném TypeError nếu đầu vào sai. */
export function buildDomainEventDoc(input: DomainEventInput, now: Date = new Date()): Record<string, unknown> {
  if (typeof input.type !== 'string' || !EVENT_TYPE_RE.test(input.type)) {
    throw new TypeError(`Tên sự kiện không hợp lệ: ${String(input.type)}`);
  }
  if (!input.subject_type) throw new TypeError('Thiếu subject_type của sự kiện');
  const payload = toEventPayload(input.payload ?? {});
  return {
    type: input.type,
    company_id: input.company_id ?? null,
    subject_type: input.subject_type,
    subject_id: input.subject_id ?? null,
    payload: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {},
    actor: {
      user_id: input.actor?.user_id ?? null,
      name: input.actor?.name ?? null,
      role: input.actor?.role ?? null,
    },
    created_at: now,
    processed_at: null,
    claimed_at: null,
    attempts: 0,
    last_error: null,
  };
}

/**
 * Ghi một sự kiện vào outbox. Trả về `_id` (chuỗi) hoặc null nếu không ghi được.
 *
 * - Không có `session` (mặc định): KHÔNG BAO GIỜ ném lỗi — chỉ log. Nghiệp vụ gốc không bị ảnh hưởng.
 * - Có `session`: lỗi được ném ra để transaction của người gọi rollback.
 */
export async function emitDomainEvent(input: DomainEventInput, session?: ClientSession): Promise<string | null> {
  try {
    const doc = buildDomainEventDoc(input);
    if (session) {
      const [created] = await Models.DomainEvent.create([doc as never], { session });
      return created ? String(created._id) : null;
    }
    const created = await Models.DomainEvent.create(doc as never);
    kickAutomation();
    return String(created._id);
  } catch (err) {
    if (session) throw err;
    console.error(`[events] không ghi được sự kiện ${input.type}: ${(err as Error).message}`);
    return null;
  }
}

/** Đối tượng phiếu tối thiểu để phát sự kiện (lấy từ Mongoose doc hoặc domain doc). */
export interface VoucherEventSubject {
  _id: unknown;
  company_id: unknown;
  kind: string;
  code: string;
  status: string;
  partner_id?: unknown;
  amount?: { minor?: unknown; currency?: string | null } | null;
  options?: { loan?: { kind?: string | null } | null } | null;
}

/**
 * Phát sự kiện phiếu. Payload luôn có: `kind`, `code`, `status`, `partner_id`, `amount_minor`
 * (chuỗi), `currency`, `loan_kind` (`borrow` | `fund` | null) — các điều kiện quy tắc dựa vào đây.
 * `extra` bổ sung (VD `from`, `to`, `action`, `changed`).
 */
export async function emitVoucherEvent(
  type: VoucherEventType,
  doc: VoucherEventSubject,
  actor: DomainEventActor | null,
  extra: Record<string, unknown> = {},
): Promise<string | null> {
  const amountMinor = doc.amount?.minor;
  return emitDomainEvent({
    type,
    company_id: doc.company_id == null ? null : String(doc.company_id),
    subject_type: 'document',
    subject_id: doc._id == null ? null : String(doc._id),
    payload: {
      kind: doc.kind,
      code: doc.code,
      status: doc.status,
      partner_id: doc.partner_id == null ? null : String(doc.partner_id),
      amount_minor: amountMinor == null ? null : String(amountMinor),
      currency: doc.amount?.currency ?? null,
      loan_kind: doc.options?.loan?.kind ?? null,
      ...extra,
    },
    actor,
  });
}

/* ================================================================== *
 * Đối chiếu outbox (v2/v2.md §14.2 domain_events, §11.2): lưới an toàn cho khoảng trống
 * ================================================================== */

/**
 * Hành động trong `history[]` mà `workflow.transition` / `submitDocument` LUÔN phát ít nhất một sự kiện
 * sau khi ghi (xem `emitTransitionEvents`). Dùng để phát hiện thao tác đã ghi nhưng sự kiện bị mất.
 */
export const TRANSITION_HISTORY_ACTIONS: readonly string[] = [
  'submit',
  'approve',
  'approve_with_reason',
  'reject',
  'request_changes',
  'queue_payment',
  'pay',
  'cancel',
  'expire',
];

/** Cửa sổ đối chiếu: thao tác trong vài ngày gần đây (TTL của hàng đã xử lý là 30 ngày, nên luôn còn sự kiện). */
export const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60_000;
/** Chờ tối thiểu sau thao tác để sự kiện kịp ghi — tránh báo nhầm. */
export const RECONCILE_GRACE_MS = 2 * 60_000;

/**
 * Thuần: thao tác `action` lúc `at` có PHẢI đối chiếu (đã đủ thời gian chờ, còn trong cửa sổ, là thao tác
 * chuyển trạng thái) và có sự kiện tương ứng (`eventsAfter` = số sự kiện của hồ sơ sau thời điểm đó).
 */
export function isOutboxGap(input: { action: string | null | undefined; at: Date | null | undefined; now: Date; eventsAfter: number }): boolean {
  if (!input.action || !input.at) return false;
  if (!TRANSITION_HISTORY_ACTIONS.includes(input.action)) return false;
  const age = input.now.getTime() - input.at.getTime();
  if (age < RECONCILE_GRACE_MS || age > RECONCILE_WINDOW_MS) return false;
  return input.eventsAfter === 0;
}

const ACTION_LABEL_FOR_GAP: Record<string, string> = {
  submit: 'gửi duyệt',
  approve: 'duyệt',
  approve_with_reason: 'duyệt vượt cấp',
  reject: 'từ chối',
  request_changes: 'yêu cầu bổ sung',
  queue_payment: 'đưa vào chờ thực thi',
  pay: 'thực thi',
  cancel: 'huỷ',
  expire: 'hết hạn',
};

/**
 * Đối chiếu: với mỗi hồ sơ đổi gần đây, thao tác GẦN NHẤT trong lịch sử phải có ít nhất một sự kiện được ghi sau
 * thời điểm thao tác. Thiếu ⇒ cảnh báo KTT (`outbox_gap`, chống lặp theo thao tác) để người xử lý kiểm tra —
 * quy trình tự động của thao tác đó có thể chưa chạy (ADR-03: không có transaction nên khoảng trống là khả thi).
 * Trả về số khoảng trống phát hiện được trong lượt này.
 */
export async function reconcileTransitionEvents(opts: { now?: Date; limit?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - RECONCILE_WINDOW_MS);
  const docs = await Models.Document.find({ updated_at: { $gte: since }, 'history.0': { $exists: true } } as never)
    .select({ code: 1, kind: 1, company_id: 1, history: { $slice: -1 } })
    .sort({ updated_at: -1 })
    .limit(opts.limit ?? 500)
    .lean<{ _id: unknown; code: string; kind: string; company_id: unknown; history?: { action?: string | null; at?: Date | null }[] }[]>();

  let gaps = 0;
  for (const doc of docs) {
    const last = doc.history?.[0];
    const at = last?.at ? new Date(last.at) : null;
    if (!last || !at) continue;
    // kiểm tra nhanh trước khi truy vấn sự kiện: chỉ thao tác chuyển trạng thái đã đủ thời gian chờ
    if (!isOutboxGap({ action: last.action, at, now, eventsAfter: 1 })) continue;
    const hit = await Models.DomainEvent.exists({ subject_id: doc._id, created_at: { $gte: new Date(at.getTime() - 1000) } } as never);
    if (!isOutboxGap({ action: last.action, at, now, eventsAfter: hit ? 1 : 0 })) continue;

    gaps++;
    const id = String(doc._id);
    const label = ACTION_LABEL_FOR_GAP[String(last.action)] ?? String(last.action);
    // cảnh báo chuẩn (fan-out tới KTT). Import động: alerts → queries → links → events là chuỗi phụ thuộc.
    const { raiseAlert } = await import('../alerts/index.ts');
    await raiseAlert({
      alert_type: 'automation_run_failed',
      company_id: doc.company_id == null ? null : String(doc.company_id),
      severity: 2,
      text: `Phiếu ${doc.code}: không ghi nhận sự kiện sau thao tác "${label}" — quy trình tự động có thể chưa chạy, kiểm tra phiếu`,
      href: docHref(doc.kind, id),
      subject: { type: 'document', id, action: last.action, at: at.toISOString(), outbox_gap: true },
      to_roles: ['chief_accountant'],
      channels: ['web'],
      dedupe_key: `outbox_gap:${id}:${at.getTime()}`,
    });
  }
  return gaps;
}

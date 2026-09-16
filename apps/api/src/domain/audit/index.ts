/**
 * Audit (architecture §7.4) — `document.history[]` là NGUỒN SỰ THẬT, `audit_log` là feed
 * suy diễn được (ADR-05). Vì cả hai nằm trong MỘT update của document (§7.3) nên không có
 * trạng thái "phiếu đã duyệt mà audit chưa ghi".
 */

import { Models } from '../../db/models.ts';
import type { ScopeLike } from '../types.ts';

export const HISTORY_SOFT_CAP = 1000; // arch §8.2 — guard trong service

export interface HistoryEntryInput {
  action: string;
  actor: { user_id?: string | null; role?: string | null; name?: string | null };
  from?: string | null;
  to?: string | null;
  amount_at_decision?: string | null;
  opinion?: string | null;
  reason?: string | null;
  request_id?: string | null;
  ip?: string | null;
  fields?: Record<string, unknown> | null;
  at?: Date;
}

export interface AuditEntry {
  at: Date;
  action: string;
  actor: { user_id: string | null; role: string | null; name: string | null };
  from: string | null;
  to: string | null;
  amount_at_decision: string | null;
  opinion: string | null;
  reason: string | null;
  request_id: string | null;
  ip: string | null;
  fields: Record<string, unknown> | null;
}

export function buildHistoryEntry(input: HistoryEntryInput): AuditEntry {
  return {
    at: input.at ?? new Date(),
    actor: { user_id: input.actor.user_id ?? null, role: input.actor.role ?? null, name: input.actor.name ?? null },
    action: input.action,
    from: input.from ?? null,
    to: input.to ?? null,
    amount_at_decision: input.amount_at_decision ?? null,
    opinion: input.opinion ?? null,
    reason: input.reason ?? null,
    request_id: input.request_id ?? null,
    ip: input.ip ?? null,
    fields: input.fields ?? null,
  };
}

/**
 * Mirror `history[]` sang `audit_log` — best-effort SAU khi CAS thành công (§7.3 bước 3).
 * Fail thì im lặng + ghi job `reconcile`; `pnpm db:rebuild-audit` dựng lại từ history.
 */
export async function mirrorAudit(input: {
  at: Date;
  actor: { user_id?: string | null; name?: string | null; role?: string | null };
  action: string;
  subject: { type: string; id?: string | null; code?: string | null };
  company_id?: string | null;
  document_id?: string | null;
  diff_fields?: Record<string, unknown> | null;
  request_id?: string | null;
  ip?: string | null;
  ua?: string | null;
}): Promise<void> {
  try {
    await Models.AuditLog.create({
      at: input.at,
      actor: { user_id: input.actor.user_id ?? null, name: input.actor.name ?? null, role: input.actor.role ?? null },
      action: input.action,
      subject: { type: input.subject.type, id: input.subject.id ?? null, code: input.subject.code ?? null },
      company_id: input.company_id ?? null,
      document_id: input.document_id ?? null,
      diff_fields: input.diff_fields ?? null,
      request_id: input.request_id ?? null,
      ip: input.ip ?? null,
      ua: input.ua ?? null,
    });
  } catch (err) {
    // không để lỗi audit-log làm hỏng nghiệp vụ đã commit — queue reconcile
    await queueReconcile(input.request_id ?? undefined);
    console.warn('[audit] mirror thất bại, đã queue reconcile:', (err as Error).message);
  }
}

export async function queueReconcile(requestId?: string): Promise<void> {
  try {
    await Models.Job.updateOne(
      { name: 'reconcile', dedupe_key: `reconcile:${requestId ?? 'any'}` },
      { $setOnInsert: { name: 'reconcile', state: 'queued', run_at: new Date(), dedupe_key: `reconcile:${requestId ?? 'any'}`, payload: { requestId: requestId ?? null } } },
      { upsert: true },
    ).exec();
  } catch {
    /* jobs cũng lỗi thì chỉ còn cách log — runbook §13 */
  }
}

/** So sánh 2 bản doc để ghi diff cho các trường được phép sửa (trước/sau — blueprint §XIX). */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  watched = [
    'title',
    'purpose',
    'amount',
    'payee',
    'source',
    'planned_date',
    'category_id',
    'contract',
    'budget',
    'priority',
    'note',
    'target',
    'rollover',
  ],
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of watched) {
    const a = serialise(before[key]);
    const b = serialise(after[key]);
    if (a !== b) out[key] = { before: before[key] ?? null, after: after[key] ?? null };
  }
  return out;
}

function serialise(v: unknown): string {
  if (v === undefined || v === null) return '∅';
  if (typeof v === 'bigint') return v.toString();
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));
  } catch {
    return String(v);
  }
}

/**
 * Dựng lại `audit_log` từ `documents.history[]` (arch §7.4) — idempotent theo (document, action, at).
 * Dùng cho `pnpm db:rebuild-audit` và job `reconcile`.
 */
export async function rebuildAudit(scope: ScopeLike, opts: { companyIds?: string[] | null; after?: Date } = {}, log?: (m: string) => void): Promise<{ scanned: number; written: number }> {
  const filter: Record<string, unknown> = { history: { $exists: true, $ne: [] } };
  if (scope.companyIds !== null) filter.company_id = { $in: (opts.companyIds ?? scope.companyIds ?? []).map(String) };
  if (opts.after) filter['history.at'] = { $gte: opts.after };

  let scanned = 0;
  let written = 0;
  const cursor = Models.Document.find(filter)
    .select({ code: 1, company_id: 1, kind: 1, history: 1 })
    .batchSize(200)
    .cursor();

  for await (const doc of cursor as unknown as AsyncIterable<Record<string, unknown>>) {
    scanned++;
    const history = (doc.history ?? []) as HistoryEntryInput[];
    for (const h of history) {
      const at = h.at instanceof Date ? h.at : new Date(String(h.at));
      if (opts.after && at < opts.after) continue;
      const dedupe = { 'subject.id': String(doc._id), action: h.action, at };
      try {
        await Models.AuditLog.updateOne(
          dedupe,
          {
            $setOnInsert: {
              at,
              actor: { user_id: h.actor?.user_id ?? null, name: h.actor?.name ?? null, role: h.actor?.role ?? null },
              action: h.action,
              subject: { type: String(doc.kind ?? 'document'), id: String(doc._id), code: String(doc.code ?? '') },
              company_id: doc.company_id ?? null,
              document_id: doc._id ?? null,
              diff_fields: h.fields ?? null,
              request_id: h.request_id ?? null,
              ip: h.ip ?? null,
              ua: null,
            },
          },
          { upsert: true },
        ).exec();
        written++;
      } catch (err) {
        log?.(`  ! ${String(doc.code)} ${h.action}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    if (scanned % 500 === 0) log?.(`  · đã xử lý ${scanned} hồ sơ`);
  }
  return { scanned, written };
}

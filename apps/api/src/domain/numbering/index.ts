/**
 * Sinh mã phiếu `PC-2026-00123` (blueprint §XXX.1) — tự sinh, không trùng,
 * bất biến sau khi gửi. CAS bằng `$inc` trên MỘT document counters (không cần transaction).
 */

import { DOC_CODE_PREFIX, type DocKind } from '@fingate/shared';
import { Models } from '../../db/models.ts';

export async function nextDocumentCode(kind: DocKind, at: Date = new Date()): Promise<string> {
  const prefix = DOC_CODE_PREFIX[kind] ?? 'FG';
  const year = at.getUTCFullYear();
  const key = `${prefix}-${year}`;
  const doc = await Models.Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 }, $set: { updated_at: new Date() } },
    { upsert: true, returnDocument: 'after' },
  )
    .select({ seq: 1 })
    .lean<{ seq: number } | null>();
  const seq = doc?.seq ?? 1;
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

/** Số tham chiếu ngân hàng cho job/idempotency: `EXP-2026-09-15-0001`. */
export async function nextRef(kind: string, at: Date = new Date()): Promise<string> {
  const day = at.toISOString().slice(0, 10);
  const key = `REF-${kind}-${day}`;
  const doc = await Models.Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 }, $set: { updated_at: new Date() } },
    { upsert: true, returnDocument: 'after' },
  )
    .select({ seq: 1 })
    .lean<{ seq: number } | null>();
  return `${kind.toUpperCase()}-${day}-${String(doc?.seq ?? 1).padStart(4, '0')}`;
}

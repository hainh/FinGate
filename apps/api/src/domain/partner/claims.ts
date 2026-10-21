/**
 * Khoá chống ghi đúp theo `request_id` cho thao tác đối tác (tạo / sao chép / trả nợ) — docs §12.6.
 *
 * Không có transaction (ADR-03), nên dựa vào khoá `_id` duy nhất của `request_claims`:
 * 1. `acquireClaim`: tạo bản ghi `pending` với `_id` = khoá. Hai lượt chạy song song ⇒ đúng một lượt tạo được.
 * 2. Đã `done` ⇒ REPLAY: trả lại kết quả lần đầu, không ghi lại gì.
 * 3. Còn `pending` ⇒ 409 (lượt khác đang chạy). Quá `CLAIM_STALE_MS` (tiến trình chết giữa chừng) ⇒ giành lại.
 * 4. Thành công ⇒ `completeClaim` ghi kết quả. Lỗi ⇒ `releaseClaim` xoá khoá để người dùng thử lại
 *    (cùng `request_id`, sửa dữ liệu rồi gửi lại).
 */

import { ApiError } from '@fingate/shared';
import { Models } from '../../db/models.ts';

/** Quá thời gian này mà vẫn `pending` ⇒ coi như tiến trình đã chết, cho phép giành lại. */
export const CLAIM_STALE_MS = 120_000;

export interface ClaimHandle {
  key: string;
}

export type ClaimOutcome<T> = { replayed: true; result: T } | { replayed: false; handle: ClaimHandle };

interface ClaimRow {
  _id: string;
  status: 'pending' | 'done';
  result?: unknown;
  created_at?: Date;
}

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/** Khoá cho một thao tác: `kind:companyId:requestId` (request_id là UUID do client sinh, ổn định theo lần mở form). */
export function claimKeyOf(kind: string, scopeId: string, requestId: string): string {
  return `${kind}:${scopeId}:${requestId}`;
}

/** Giành khoá (hoặc trả về kết quả cũ nếu đã xong). */
export async function acquireClaim<T>(key: string, kind: string, companyId: string | null): Promise<ClaimOutcome<T>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = new Date();
    try {
      await Models.RequestClaim.create({
        _id: key,
        kind,
        company_id: companyId,
        status: 'pending',
        result: null,
        created_at: now,
        updated_at: now,
      } as never);
      return { replayed: false, handle: { key } };
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    const row = await Models.RequestClaim.findById(key).lean<ClaimRow | null>();
    if (!row) continue; // vừa bị lượt khác xoá (thất bại) — thử giành lại một lần
    if (row.status === 'done') return { replayed: true, result: row.result as T };
    // còn đang chạy: giành lại chỉ khi đã quá lease (tiến trình trước đã chết giữa chừng)
    const cutoff = new Date(now.getTime() - CLAIM_STALE_MS);
    const taken = await Models.RequestClaim.updateOne(
      { _id: key, status: 'pending', created_at: { $lt: cutoff } } as never,
      { $set: { created_at: now, updated_at: now } } as never,
    ).exec();
    if (taken.modifiedCount === 1) return { replayed: false, handle: { key } };
    break;
  }
  throw new ApiError({ code: 'FG-WF-011', detail: 'Yêu cầu này đang được xử lý — chờ vài giây rồi thử lại' });
}

/** Ghi kết quả thành công để replay. Kết quả phải là JSON thuần (chuỗi / số / mảng / đối tượng). */
export async function completeClaim(handle: ClaimHandle, result: unknown): Promise<void> {
  const plain = JSON.parse(JSON.stringify(result ?? null)) as unknown;
  await Models.RequestClaim.updateOne(
    { _id: handle.key } as never,
    { $set: { status: 'done', result: plain, updated_at: new Date() } } as never,
  ).exec();
}

/** Thất bại: xoá khoá (chỉ khi còn pending) để người dùng gửi lại. Lỗi xoá được ghi log, lease cũng tự hết hạn. */
export async function releaseClaim(handle: ClaimHandle): Promise<void> {
  await Models.RequestClaim.deleteOne({ _id: handle.key, status: 'pending' } as never)
    .exec()
    .catch((err: unknown) => {
      console.error(`[claims] không nhả được khoá ${handle.key}: ${(err as Error).message}`);
    });
}

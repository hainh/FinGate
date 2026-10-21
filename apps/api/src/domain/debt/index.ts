/**
 * Công nợ & nợ ngân hàng — điểm vào thuần (không DB).
 *
 * Mọi quy tắc tuổi nợ / trạng thái nằm ở `./rules.ts` (một bản duy nhất); file này chỉ giữ tên cũ để test và
 * import cũ dùng được. "Đã cấn trừ / đã trả" đọc từ `business_links` (v2): xem `./debts.ts`, `./loans.ts`.
 */

import { AGING_BUCKET_LABEL, agingBucketOf, debtFigures, type DebtAgingBucket } from './rules.ts';

export function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

/** Nhóm tuổi nợ theo số ngày quá hạn (= `agingBucketOf`). */
export function debtAgingBucket(overdueDays: number): DebtAgingBucket {
  return agingBucketOf(overdueDays);
}

/** Trạng thái cấn trừ theo giá trị và số đã cấn trừ (= `debtFigures(...).status`, không xét hạn). */
export function debtStatus(value: bigint, settled: bigint): 'open' | 'partial' | 'settled' {
  return debtFigures(value, settled, '9999-12-31').status;
}

/** Nhãn tuổi nợ tiếng Việt. */
export function debtAgingLabel(b: string): string {
  return AGING_BUCKET_LABEL[b as DebtAgingBucket] ?? b;
}

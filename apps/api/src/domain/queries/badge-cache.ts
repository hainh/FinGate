/**
 * Khoá cache cho badge "Chờ tôi duyệt" (v2 US-APR-01) — hàm THUẦN, không chạm DB, có test.
 *
 * Số đếm được tính với `withScope(scope)` nên PHỤ THUỘC phạm vi công ty. Khoá phải gồm phạm vi, nếu không
 * đổi công ty trong vòng TTL sẽ nhận lại số đếm của công ty trước (thẻ/chân danh sách hiện sai tổng).
 * `invalidateFor` xoá theo tiền tố `BADGE_CACHE_PREFIX` sau thay đổi phiếu đi qua các đường gọi nó.
 */

import { tagFilterSuffix } from './dashboard-tags.ts';

/** Tiền tố của mọi khoá badge. */
export const BADGE_CACHE_PREFIX = 'badge:';

/**
 * Khoá phạm vi công ty: `all` = toàn tập đoàn, `none` = không có công ty nào, còn lại = danh sách id đã
 * sắp xếp và khử trùng (cùng một tập luôn cho cùng khoá, bất kể thứ tự).
 */
export function scopeCacheKey(companyIds: readonly string[] | null): string {
  if (companyIds === null) return 'all';
  if (companyIds.length === 0) return 'none';
  return [...new Set(companyIds)].sort().join(',');
}

export function badgeCacheKey(input: {
  userId: string;
  companyIds: readonly string[] | null;
  role?: string;
  canPay: boolean;
  tagIds?: readonly string[] | null;
}): string {
  const pay = input.canPay ? 'pay' : '';
  return `${BADGE_CACHE_PREFIX}${input.userId}:${scopeCacheKey(input.companyIds)}:${input.role ?? ''}:${pay}${tagFilterSuffix(input.tagIds)}`;
}

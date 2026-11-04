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
  /** APPR-01: số đếm của một tab (`turn` / `later`) khác số của cả hàng chờ ⇒ phải khác khoá. */
  awaiting?: 'turn' | 'later';
  /**
   * Cài đặt "Duyệt tiền mặt" (ADM-04): tập công ty đang bật "qua KTT duyệt" quyết định phiếu quỹ
   * tiền mặt nào nằm trong "Chờ tôi duyệt" ⇒ khác tập thì phải khác khoá, nếu không badge trả số cũ
   * ngay sau khi admin đổi cài đặt (khi cache chưa bị xoá).
   */
  cashKttCompanyIds?: readonly string[] | null;
}): string {
  const pay = input.canPay ? 'pay' : '';
  const cash = input.cashKttCompanyIds?.length ? `:cash=${scopeCacheKey(input.cashKttCompanyIds)}` : '';
  return `${BADGE_CACHE_PREFIX}${input.userId}:${scopeCacheKey(input.companyIds)}:${input.role ?? ''}:${pay}${tagFilterSuffix(input.tagIds)}${input.awaiting ? `:${input.awaiting}` : ''}${cash}`;
}

/**
 * Lọc theo tag cho số liệu dashboard (v2 §6.2) — hàm THUẦN, không chạm DB, có test.
 *
 * Khoá cache (`overview`, `badge`) phải phân biệt các tập tag: cùng một tập (bất kể thứ tự, trùng lặp)
 * cho cùng khoá; khác tập cho khoá khác. Nếu không, yêu cầu có lọc sẽ nhận lại bản cache không lọc
 * (hoặc ngược lại) trong 20 giây.
 */

/** Hậu tố khoá cache cho một tập tag. Không lọc → chuỗi rỗng (khoá cũ giữ nguyên). */
export function tagFilterSuffix(tagIds: readonly string[] | null | undefined): string {
  if (!tagIds || tagIds.length === 0) return '';
  return `:tags=${[...new Set(tagIds)].sort().join(',')}`;
}

/**
 * Hàm thuần của ô chọn đối tác (components/partner-picker.tsx) — v2/v2.md §5.2 "Gõ để tìm".
 * Không React, không gọi server: để kiểm thử bằng vitest.
 */

/**
 * Kết quả gợi ý của server chỉ ứng với chữ đang gõ KHI chữ đó đã qua debounce (`debounced`).
 * Trước đó kết quả đang có là của chữ cũ ⇒ không được hiển thị (có thể chứa đối tác không khớp chữ gõ).
 */
export function isSearchSettled(typed: string, debounced: string): boolean {
  return typed.trim() === debounced;
}

/**
 * Có đưa ĐỐI TÁC ĐANG CHỌN vào đầu danh sách gợi ý không — chỉ để ô hiển thị được nhãn của nó.
 * - Đang gõ tìm: KHÔNG. Đối tác đang chọn có thể không khớp chữ gõ; nếu được thêm, nó đứng đầu và được tô sáng
 *   ⇒ Enter chọn lại đối tác cũ, và "Không có đối tác phù hợp" không bao giờ hiện.
 * - Không gõ: CÓ, khi chưa nằm trong kết quả (vd. đối tác ngoài 20 dòng đầu, hoặc form mở sẵn partner_id).
 */
export function needsSelectedOption(typed: string, selectedId: string, resultIds: readonly string[]): boolean {
  return typed.trim() === '' && !resultIds.includes(selectedId);
}

/**
 * Chi tiết đối tác CHỈ dùng được khi đúng là đối tác đang chọn. Khi vừa đổi sang đối tác khác, chi tiết của đối tác
 * trước có thể còn trong bộ nhớ ⇒ không được coi là của đối tác mới (không hiện NH/STK/MST cũ, không mở "Sửa" cho
 * đối tác cũ). Chưa có `value` ⇒ không có chi tiết.
 */
export function detailForValue<T extends { _id: string }>(value: string | null | undefined, detail: T | undefined): T | undefined {
  return value && detail && detail._id === value ? detail : undefined;
}

/**
 * Hàm thuần của ô chọn đối tác (partner-picker-options.ts) — v2/v2.md §5.2 "Gõ để tìm".
 */

import { describe, expect, it } from 'vitest';
import { detailForValue, internalCompanyOptionsFor, isSearchSettled, needsSelectedOption } from './partner-picker-options.ts';

const A = 'partner-a';
const B = 'partner-b';

describe('detailForValue — chi tiết đối tác chỉ được dùng khi đúng đối tác đang chọn', () => {
  it('chi tiết đúng đối tác đang chọn ⇒ trả về chính chi tiết đó', () => {
    const detailA = { _id: A, name: 'Đối tác A' };
    expect(detailForValue(A, detailA)).toBe(detailA);
  });

  it('đang chọn B nhưng bộ nhớ còn chi tiết của A (đang tải B) ⇒ KHÔNG coi là của B (không hiện NH/STK của A, không mở "Sửa" A)', () => {
    expect(detailForValue(B, { _id: A, name: 'Đối tác A' })).toBeUndefined();
  });

  it('chưa chọn (value rỗng / null) hoặc chưa có chi tiết ⇒ không có chi tiết', () => {
    expect(detailForValue(null, { _id: A })).toBeUndefined();
    expect(detailForValue('', { _id: A })).toBeUndefined();
    expect(detailForValue(A, undefined)).toBeUndefined();
  });
});

describe('isSearchSettled — kết quả gợi ý có còn đúng với chữ đang gõ không', () => {
  it('chữ đã debounce trùng chữ đang gõ (bỏ khoảng trắng thừa) ⇒ đúng', () => {
    expect(isSearchSettled('PKR B', 'PKR B')).toBe(true);
    expect(isSearchSettled('  PKR B ', 'PKR B')).toBe(true);
    expect(isSearchSettled('', '')).toBe(true);
  });

  it('đang chờ debounce (chữ đã đổi, chữ debounce còn cũ) ⇒ chưa đúng: không hiện kết quả của chữ cũ', () => {
    expect(isSearchSettled('PKR B', 'PKR')).toBe(false);
    expect(isSearchSettled('', 'PKR A')).toBe(false);
  });
});

describe('needsSelectedOption — đối tác đang chọn có được đưa vào danh sách gợi ý không', () => {
  it('đang gõ tìm B, đang chọn A (A không khớp, không nằm trong kết quả) ⇒ KHÔNG thêm A: Enter không chọn lại A', () => {
    expect(needsSelectedOption('PKR B', A, [B])).toBe(false);
  });

  it('đang gõ mà không có kết quả nào ⇒ KHÔNG thêm A (để hiện "Không có đối tác phù hợp")', () => {
    expect(needsSelectedOption('PKR khong khop', A, [])).toBe(false);
  });

  it('đang gõ và A khớp chữ gõ (đã nằm trong kết quả) ⇒ không thêm trùng', () => {
    expect(needsSelectedOption('PKR A', A, [A, B])).toBe(false);
  });

  it('không gõ (hoặc chỉ khoảng trắng) và A chưa có trong kết quả (vd. ngoài 20 dòng đầu / form mở sẵn partner_id) ⇒ THÊM để có nhãn', () => {
    expect(needsSelectedOption('', A, [B])).toBe(true);
    expect(needsSelectedOption('   ', A, [])).toBe(true);
  });

  it('không gõ và A đã nằm trong kết quả ⇒ không thêm trùng', () => {
    expect(needsSelectedOption('', A, [A, B])).toBe(false);
  });
});

describe('internalCompanyOptionsFor — công ty trong tập đoàn của đối tác nội bộ', () => {
  const companies = [
    { _id: 'g', name: 'Tập đoàn' },
    { _id: 'a', name: 'Công ty A' },
    { _id: 'b', name: 'Công ty B' },
  ];

  it('bỏ công ty đang tạo đối tác và giữ thứ tự danh sách', () => {
    expect(internalCompanyOptionsFor(companies, 'a')).toEqual([
      { value: 'g', label: 'Tập đoàn' },
      { value: 'b', label: 'Công ty B' },
    ]);
  });

  it('chưa rõ công ty đang tạo ⇒ giữ đủ mọi công ty', () => {
    expect(internalCompanyOptionsFor(companies, null)).toHaveLength(3);
    expect(internalCompanyOptionsFor(companies, undefined)).toHaveLength(3);
  });
});

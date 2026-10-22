/**
 * Hàm thuần của đối tác (app/v2/partners.ts): không gọi server, không React.
 */

import { describe, expect, it } from 'vitest';
import { partnerOptionsEmptyState } from './partners.ts';

describe('partnerOptionsEmptyState — danh sách gợi ý của ô chọn đang trống', () => {
  it('đang tải ⇒ loading (kể cả khi lần trước đã lỗi: đang thử lại thì chưa báo lỗi)', () => {
    expect(partnerOptionsEmptyState({ isFetching: true, isError: false })).toBe('loading');
    expect(partnerOptionsEmptyState({ isFetching: true, isError: true })).toBe('loading');
  });

  it('lỗi tải và không còn tải ⇒ error (không được báo "Không có đối tác phù hợp")', () => {
    expect(partnerOptionsEmptyState({ isFetching: false, isError: true })).toBe('error');
  });

  it('tải xong, không lỗi ⇒ none (thật sự không có đối tác khớp)', () => {
    expect(partnerOptionsEmptyState({ isFetching: false, isError: false })).toBe('none');
  });
});

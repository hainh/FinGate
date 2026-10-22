import { describe, expect, it } from 'vitest';
import { tagListQuery } from '../src/contracts/tags.js';

describe('tagListQuery — phân trang danh bạ tag', () => {
  it('mặc định: limit 100, offset 0', () => {
    expect(tagListQuery.parse({})).toMatchObject({ limit: 100, offset: 0 });
  });

  it('đọc offset và limit từ chuỗi query (trang kế tiếp của danh bạ hơn 500 tag)', () => {
    expect(tagListQuery.parse({ limit: '500', offset: '500' })).toMatchObject({ limit: 500, offset: 500 });
  });

  it('từ chối offset âm và limit vượt 500', () => {
    expect(tagListQuery.safeParse({ offset: '-1' }).success).toBe(false);
    expect(tagListQuery.safeParse({ limit: '501' }).success).toBe(false);
  });
});

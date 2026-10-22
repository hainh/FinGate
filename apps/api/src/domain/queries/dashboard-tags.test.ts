import { describe, expect, it } from 'vitest';
import { tagFilterSuffix } from './dashboard-tags.ts';

const A = '64b000000000000000000001';
const B = '64b000000000000000000002';

describe('tagFilterSuffix — khoá cache theo tập tag (dashboard, v2 §6.2)', () => {
  it('không lọc → chuỗi rỗng, giữ nguyên khoá cũ', () => {
    expect(tagFilterSuffix(undefined)).toBe('');
    expect(tagFilterSuffix(null)).toBe('');
    expect(tagFilterSuffix([])).toBe('');
  });

  it('không phụ thuộc thứ tự và trùng lặp', () => {
    expect(tagFilterSuffix([B, A])).toBe(tagFilterSuffix([A, B, A]));
    expect(tagFilterSuffix([B, A])).not.toBe('');
  });

  it('khác tập tag → khác khoá (không trùng với bản cache không lọc)', () => {
    expect(tagFilterSuffix([A])).not.toBe(tagFilterSuffix([B]));
    expect(tagFilterSuffix([A])).not.toBe(tagFilterSuffix([]));
    expect(tagFilterSuffix([A, B])).not.toBe(tagFilterSuffix([A]));
  });
});

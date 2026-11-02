import { describe, expect, it } from 'vitest';
import { minorKey, parseSort, sortRows } from './sort.ts';

const ALLOWED = ['name', 'amount'] as const;

describe('parseSort', () => {
  it('tăng dần / giảm dần theo tiền tố -', () => {
    expect(parseSort('name', ALLOWED)).toEqual({ field: 'name', dir: 1 });
    expect(parseSort('-amount', ALLOWED)).toEqual({ field: 'amount', dir: -1 });
    expect(parseSort(' +name', ALLOWED)).toEqual({ field: 'name', dir: 1 });
  });
  it('trường lạ hoặc rỗng → null (dùng thứ tự mặc định)', () => {
    expect(parseSort('password', ALLOWED)).toBeNull();
    expect(parseSort('', ALLOWED)).toBeNull();
    expect(parseSort(undefined, ALLOWED)).toBeNull();
  });
});

describe('sortRows', () => {
  const rows = [
    { id: 1, name: 'Đông', amount: 5n },
    { id: 2, name: 'An', amount: null },
    { id: 3, name: 'Bình', amount: 20n },
    { id: 4, name: 'Chi', amount: 5n },
  ];
  const getters = { name: (r: (typeof rows)[number]) => r.name, amount: (r: (typeof rows)[number]) => r.amount };

  it('so sánh tiếng Việt và giữ ổn định khi bằng nhau', () => {
    expect(sortRows(rows, { field: 'name', dir: 1 }, getters).map((r) => r.id)).toEqual([2, 3, 4, 1]);
    expect(sortRows(rows, { field: 'amount', dir: 1 }, getters).map((r) => r.id)).toEqual([1, 4, 3, 2]);
  });
  it('giá trị trống luôn xuống cuối, kể cả khi giảm dần', () => {
    expect(sortRows(rows, { field: 'amount', dir: -1 }, getters).map((r) => r.id)).toEqual([3, 1, 4, 2]);
  });
  it('không có spec → giữ nguyên thứ tự', () => {
    expect(sortRows(rows, null, getters).map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});

describe('minorKey', () => {
  it('đọc minor dạng chuỗi/bigint, không mất độ chính xác', () => {
    expect(minorKey({ minor: '9007199254740993' })).toBe(9007199254740993n);
    expect(minorKey('12')).toBe(12n);
    expect(minorKey(null)).toBeNull();
    expect(minorKey({ minor: 'x' })).toBeNull();
  });
});

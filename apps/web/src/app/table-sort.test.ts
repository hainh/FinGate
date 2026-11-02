import { describe, expect, it } from 'vitest';
import type { TableColumnsType } from 'antd';
import { onSortChange, parseSort, serializeSort, sortFromTable, withServerSort } from './table-sort.ts';

describe('parseSort / serializeSort', () => {
  it('khứ hồi', () => {
    expect(parseSort('-amount')).toEqual({ key: 'amount', order: 'descend' });
    expect(parseSort('code')).toEqual({ key: 'code', order: 'ascend' });
    expect(parseSort('')).toBeNull();
    expect(serializeSort(parseSort('-amount'))).toBe('-amount');
    expect(serializeSort(null)).toBe('');
  });
});

describe('withServerSort', () => {
  type Row = { a: string };
  const columns: TableColumnsType<Row> = [
    { key: 'a', title: 'A' },
    { key: 'b', title: 'B' },
    { title: 'Nhóm', children: [{ key: 'c', title: 'C' }] },
  ];

  it('chỉ cột nằm trong danh sách được gắn sorter, mũi tên theo sort đang chọn (kể cả cột lồng)', () => {
    const out = withServerSort(columns, ['a', 'c'], '-c');
    expect(out[0]).toMatchObject({ sorter: true, sortOrder: null });
    expect(out[1]).not.toHaveProperty('sorter');
    const child = (out[2] as { children: TableColumnsType<Row> }).children[0]!;
    expect(child).toMatchObject({ sorter: true, sortOrder: 'descend' });
  });
  it('sort rỗng → dùng thứ tự mặc định của màn', () => {
    expect(withServerSort(columns, ['a'], '', '-a')[0]).toMatchObject({ sortOrder: 'descend' });
  });
});

describe('onSortChange', () => {
  it('bấm tiêu đề cột → ghi sort; bỏ sắp xếp → rỗng; đổi trang bị bỏ qua', () => {
    const calls: string[] = [];
    const h = onSortChange((v) => calls.push(v));
    h({}, {}, { columnKey: 'amount', order: 'descend' }, { action: 'sort' });
    h({}, {}, { columnKey: 'amount', order: null }, { action: 'sort' });
    h({}, {}, { columnKey: 'amount', order: 'ascend' }, { action: 'paginate' });
    expect(calls).toEqual(['-amount', '']);
  });
  it('sortFromTable nhận cả mảng', () => {
    expect(sortFromTable([{ columnKey: 'x', order: 'ascend' }])).toEqual({ key: 'x', order: 'ascend' });
  });
});

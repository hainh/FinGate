import { describe, expect, it } from 'vitest';
import { loanListQuery } from './bodies.ts';
import { DEBT_SORT_GETTERS } from './debts.ts';
import { LOAN_SORT_GETTERS } from './loans.ts';
import { parseSort, sortRows } from '../../lib/sort.ts';

describe('sắp xếp danh sách công nợ / khoản vay phía máy chủ', () => {
  it('công nợ: số tiền so sánh theo bigint, giảm dần', () => {
    const rows = [
      { value: 9n, applied: 0n, figures: { remaining: 9n }, item: { code: 'CN-2' } },
      { value: 100000000000000000000n, applied: 0n, figures: { remaining: 1n }, item: { code: 'CN-3' } },
      { value: 10n, applied: 0n, figures: { remaining: 5n }, item: { code: 'CN-1' } },
    ] as never[];
    const spec = parseSort('-value', Object.keys(DEBT_SORT_GETTERS));
    const out = sortRows(rows, spec, DEBT_SORT_GETTERS) as unknown as { item: { code: string } }[];
    expect(out.map((r) => r.item.code)).toEqual(['CN-3', 'CN-1', 'CN-2']);
  });

  it('công nợ: sort lạ → giữ thứ tự mặc định', () => {
    expect(parseSort('hack', Object.keys(DEBT_SORT_GETTERS))).toBeNull();
  });

  it('khoản vay: lãi suất dạng chuỗi có dấu phẩy sắp theo số', () => {
    const mk = (ir: string) => ({ item: { interest_rate: ir }, principal: 0n, outstanding: 0n, status: 'active' }) as never;
    const rows = [mk('10,5'), mk('9'), mk('11')];
    const out = sortRows(rows, parseSort('ir', Object.keys(LOAN_SORT_GETTERS)), LOAN_SORT_GETTERS) as unknown as { item: { interest_rate: string } }[];
    expect(out.map((r) => r.item.interest_rate)).toEqual(['9', '10,5', '11']);
  });

  it('loanListQuery nhận tham số sort', () => {
    expect(loanListQuery.parse({ sort: '-md' }).sort).toBe('-md');
  });
});

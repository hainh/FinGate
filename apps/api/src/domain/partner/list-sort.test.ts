import { describe, expect, it } from 'vitest';
import { sortRows, parseSort } from '../../lib/sort.ts';
import { PARTNER_SORT_FIELDS, partnerSortGetters } from './index.ts';
import type { PartnerNumbers } from './summary.ts';

type P = Parameters<ReturnType<typeof partnerSortGetters>[string]>[0];
const p = (id: string, name: string, company = 'c1') => ({ _id: id, name, company_id: company, type: 'customer', status: 'active' }) as unknown as P;
const nums: Record<string, Partial<PartnerNumbers>> = {
  a: { receivable_remaining: 50n, paid_in_period: 0n },
  b: { receivable_remaining: 900n, paid_in_period: 5n },
  c: { receivable_remaining: null, paid_in_period: 9n },
};
const metric = (r: P): PartnerNumbers => nums[String((r as unknown as { _id: string })._id)] as PartnerNumbers;
const rows = [p('a', 'An'), p('b', 'Bình'), p('c', 'Cường')];
const ids = (xs: P[]) => xs.map((x) => (x as unknown as { _id: string })._id);

describe('partnerSortGetters', () => {
  const all = { debt: true, loan: true, cash: true };
  it('xếp theo số liệu sổ công nợ, null luôn cuối cả hai chiều', () => {
    const g = partnerSortGetters(metric, new Map(), all);
    expect(ids(sortRows(rows, parseSort('receivable', PARTNER_SORT_FIELDS), g))).toEqual(['a', 'b', 'c']);
    expect(ids(sortRows(rows, parseSort('-receivable', PARTNER_SORT_FIELDS), g))).toEqual(['b', 'a', 'c']);
  });
  it('thiếu quyền xem nhóm ⇒ mọi dòng null ⇒ giữ thứ tự gốc (không lộ thứ tự)', () => {
    const g = partnerSortGetters(metric, new Map(), { debt: false, loan: true, cash: true });
    expect(ids(sortRows(rows, parseSort('-receivable', PARTNER_SORT_FIELDS), g))).toEqual(['a', 'b', 'c']);
  });
  it('xếp theo tổng thu và tên công ty', () => {
    const g = partnerSortGetters(metric, new Map([['c1', 'Zeta']]), all);
    expect(ids(sortRows(rows, parseSort('-paid_in', PARTNER_SORT_FIELDS), g))).toEqual(['c', 'b', 'a']);
    expect(ids(sortRows(rows, parseSort('company', PARTNER_SORT_FIELDS), g))).toEqual(['a', 'b', 'c']);
  });
});

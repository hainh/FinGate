import { describe, expect, it } from 'vitest';
import { composeAccountBalance, pageAccountViews, type LedgerAccountView } from './accounts.ts';

describe('composeAccountBalance — số dư = sổ cái + dự kiến (không phong toả)', () => {
  it('projected = thực tế + vào dự kiến − ra dự kiến', () => {
    const r = composeAccountBalance({ actual: 1000n, planned_in: 300n, planned_out: 500n, min_balance: 0n });
    expect(r.projected).toBe(800n);
  });

  it('vi phạm thực tế và vi phạm dự kiến tách bạch', () => {
    const r = composeAccountBalance({ actual: 1000n, planned_in: 0n, planned_out: 200n, min_balance: 900n });
    expect(r.breach).toBe(false); // sổ cái 1000 ≥ 900
    expect(r.breach_projected).toBe(true); // dự kiến 800 < 900
  });

  it('số dư âm vẫn được tính (không kẹp về 0)', () => {
    const r = composeAccountBalance({ actual: 100n, planned_in: 0n, planned_out: 250n, min_balance: 0n });
    expect(r.projected).toBe(-150n);
    expect(r.breach).toBe(false);
    expect(r.breach_projected).toBe(true);
  });
});

describe('pageAccountViews — lọc loại TK rồi cắt trang (BANK-01)', () => {
  const acct = (id: string, kind: string) => ({ account_id: id, kind }) as LedgerAccountView;
  const rows = [acct('a1', 'bank'), acct('a2', 'cash'), acct('a3', 'bank'), acct('a4', 'bank'), acct('a5', 'cash')];

  it('không gửi page/limit ⇒ trả toàn bộ', () => {
    const r = pageAccountViews(rows);
    expect(r.items.map((x) => x.account_id)).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(r.total).toBe(5);
  });

  it('kind lọc danh sách; total đếm theo loại đã lọc', () => {
    const r = pageAccountViews(rows, { kind: 'cash' });
    expect(r.items.map((x) => x.account_id)).toEqual(['a2', 'a5']);
    expect(r.total).toBe(2);
  });

  it('cắt đúng trang; total là số dòng trước khi cắt', () => {
    const r = pageAccountViews(rows, { page: 2, limit: 2 });
    expect(r.items.map((x) => x.account_id)).toEqual(['a3', 'a4']);
    expect(r.total).toBe(5);
  });

  it('trang vượt quá ⇒ rỗng nhưng total vẫn đúng', () => {
    const r = pageAccountViews(rows, { page: 9, limit: 2 });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(5);
  });

  it('chỉ gửi page ⇒ cỡ trang mặc định 50', () => {
    const many = Array.from({ length: 60 }, (_, i) => acct(`m${i}`, 'bank'));
    const r = pageAccountViews(many, { page: 2 });
    expect(r.items).toHaveLength(10);
    expect(r.total).toBe(60);
  });
});

import { describe, expect, it } from 'vitest';
import { accountTotals, composeAccountBalance, pageAccountViews, type LedgerAccountView } from './accounts.ts';

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

describe('pageAccountViews — loại tài khoản Quỹ phụ (fund) như tiền thật, tách khỏi ngân hàng', () => {
  const acct = (id: string, kind: string) => ({ account_id: id, kind }) as LedgerAccountView;
  const rows = [acct('b1', 'bank'), acct('c1', 'cash'), acct('f1', 'fund'), acct('b2', 'bank'), acct('f2', 'fund')];

  it("kind='fund' chỉ trả tài khoản Quỹ phụ", () => {
    const r = pageAccountViews(rows, { kind: 'fund' });
    expect(r.items.map((x) => x.account_id)).toEqual(['f1', 'f2']);
    expect(r.total).toBe(2);
  });

  it('kind không loại chéo: ngân hàng không thấy quỹ phụ và ngược lại', () => {
    expect(pageAccountViews(rows, { kind: 'bank' }).items.map((x) => x.account_id)).toEqual(['b1', 'b2']);
    expect(pageAccountViews(rows, { kind: 'cash' }).items.map((x) => x.account_id)).toEqual(['c1']);
  });

  it('`filtered` trả TOÀN BỘ dòng đã lọc, không cắt trang', () => {
    const r = pageAccountViews(rows, { kind: 'fund', page: 1, limit: 1 });
    expect(r.items.map((x) => x.account_id)).toEqual(['f1']);
    expect(r.filtered.map((x) => x.account_id)).toEqual(['f1', 'f2']);
    expect(r.total).toBe(2);
  });
});

describe('accountTotals — KPI phải cộng trên tập ĐÃ LỌC theo kind (bug BANK-01)', () => {
  const acct = (id: string, kind: string, actual: bigint, projected: bigint) =>
    ({ account_id: id, kind, actual, projected }) as unknown as LedgerAccountView;
  const rows = [
    acct('b1', 'bank', 1000n, 1200n),
    acct('c1', 'cash', 200n, 150n),
    acct('f1', 'fund', 50n, 70n),
    acct('b2', 'bank', 500n, 400n),
    acct('f2', 'fund', 30n, 20n),
  ];

  it('không lọc ⇒ Σ mọi tài khoản', () => {
    const listed = pageAccountViews(rows, {});
    expect(accountTotals(listed.filtered)).toEqual({ balance: 1780n, projected: 1840n });
  });

  it("lọc 'fund' ⇒ KPI đổi theo đúng tập Quỹ phụ", () => {
    const listed = pageAccountViews(rows, { kind: 'fund' });
    expect(accountTotals(listed.filtered)).toEqual({ balance: 80n, projected: 90n });
  });

  it('lọc theo kind nhưng CÓ phân trang ⇒ totals vẫn cộng cả tập đã lọc, không chỉ trang đang xem', () => {
    const listed = pageAccountViews(rows, { kind: 'bank', page: 1, limit: 1 });
    expect(listed.items.map((r) => r.account_id)).toEqual(['b1']); // items = đúng một trang
    expect(accountTotals(listed.filtered)).toEqual({ balance: 1500n, projected: 1600n });
  });

  it('KPI theo bộ lọc ≠ KPI toàn bộ khi có nhiều loại TK (tái hiện lỗi cũ)', () => {
    const all = accountTotals(pageAccountViews(rows, {}).filtered);
    const cashLike = accountTotals(pageAccountViews(rows, { kind: 'cash' }).filtered);
    expect(cashLike.balance).not.toBe(all.balance);
    expect(cashLike).toEqual({ balance: 200n, projected: 150n });
  });

  it('tập rỗng ⇒ 0', () => {
    expect(accountTotals([])).toEqual({ balance: 0n, projected: 0n });
  });
});

describe('pageAccountViews — sắp xếp trước khi cắt trang', () => {
  const acct = (id: string, label: string, actual: bigint, kind = 'bank') =>
    ({ account_id: id, label, actual, projected: actual, min_balance: 0n, kind, currency: 'VND', status: 'active', account_number_masked: id }) as unknown as LedgerAccountView;
  const rows = [acct('a', 'B', 5n), acct('b', 'A', 100n), acct('c', 'C', -7n)];

  it('sort=bal xếp theo số dư (bigint) và áp trước khi cắt trang', () => {
    expect(pageAccountViews(rows, { sort: 'bal' }).items.map((r) => r.account_id)).toEqual(['c', 'a', 'b']);
    expect(pageAccountViews(rows, { sort: '-bal', page: 1, limit: 1 }).items.map((r) => r.account_id)).toEqual(['b']);
  });

  it('sort=tk theo nhãn; trường lạ / rỗng giữ thứ tự gốc', () => {
    expect(pageAccountViews(rows, { sort: 'tk' }).items.map((r) => r.label)).toEqual(['A', 'B', 'C']);
    expect(pageAccountViews(rows, { sort: 'xyz' }).items.map((r) => r.account_id)).toEqual(['a', 'b', 'c']);
    expect(pageAccountViews(rows, { sort: '' }).items.map((r) => r.account_id)).toEqual(['a', 'b', 'c']);
  });
});

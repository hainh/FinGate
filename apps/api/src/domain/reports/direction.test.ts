import { describe, expect, it } from 'vitest';
import { debtDirectionOf, overdueDaysOf } from './aggregate.ts';

/**
 * Hướng công nợ (v2 §9.1) chọn tay và độc lập với bút toán `side`. Dashboard, cảnh báo và báo cáo
 * đều đếm phải thu quá hạn theo HƯỚNG — một con số duy nhất — nên trường hợp hướng và side lệch nhau phải đúng.
 */
describe('debtDirectionOf — hướng thắng bút toán side (v2 §9.1)', () => {
  it('hướng thu nhưng bút toán Có (side credit) vẫn là phải thu', () => {
    expect(debtDirectionOf({ direction: 'receivable', side: 'credit' })).toBe('receivable');
  });

  it('hướng trả nhưng bút toán Nợ (side debit) vẫn là phải trả', () => {
    expect(debtDirectionOf({ direction: 'payable', side: 'debit' })).toBe('payable');
  });

  it('bản ghi v1 chưa có hướng: suy theo side (M3b)', () => {
    expect(debtDirectionOf({ direction: null, side: 'debit' })).toBe('receivable');
    expect(debtDirectionOf({ direction: null, side: 'credit' })).toBe('payable');
  });
});

describe('overdueDaysOf — quá hạn theo ngày', () => {
  it('đến hạn hôm nay hoặc chưa đến hạn thì không quá hạn', () => {
    expect(overdueDaysOf('2026-10-21', '2026-10-21')).toBe(0);
    expect(overdueDaysOf('2026-10-25', '2026-10-21')).toBe(0);
  });

  it('quá hạn tính theo số ngày', () => {
    expect(overdueDaysOf('2026-10-01', '2026-10-21')).toBe(20);
  });
});

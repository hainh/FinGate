import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/models.ts', () => ({ Models: {} }));

import { nextDue, periodOf } from './index.ts';

describe('recurring › kỳ (con dấu chống trùng)', () => {
  it('nhãn kỳ theo chu kỳ', () => {
    expect(periodOf('monthly', '2026-10-05')).toBe('2026-10');
    expect(periodOf('quarterly', '2026-10-05')).toBe('2026-Q4');
    expect(periodOf('quarterly', '2026-02-05')).toBe('2026-Q1');
    expect(periodOf('semi_annual', '2026-03-05')).toBe('2026-H1');
    expect(periodOf('semi_annual', '2026-09-05')).toBe('2026-H2');
    expect(periodOf('annual', '2026-09-05')).toBe('2026');
  });

  it('tuần: nhãn là thứ Hai đầu tuần', () => {
    // 21/10/2026 là thứ Tư → thứ Hai của tuần là 19/10/2026
    expect(periodOf('weekly', '2026-10-21')).toBe('2026-10-19');
  });
});

describe('recurring › ngày phát sinh kế tiếp (không quay lại quá khứ)', () => {
  it('hàng tháng: trong tháng nếu còn kịp, không thì sang tháng sau', () => {
    const rule = { cadence: 'monthly', day_of_period: 5, effective_from: '2026-01-01' };
    expect(nextDue(rule, '2026-10-01')).toBe('2026-10-05');
    expect(nextDue(rule, '2026-10-21')).toBe('2026-11-05');
  });

  it('hàng quý: bước 3 tháng', () => {
    expect(nextDue({ cadence: 'quarterly', day_of_period: 5, effective_from: '2026-01-01' }, '2026-10-21')).toBe('2027-01-05');
  });

  it('chưa đến ngày bắt đầu hiệu lực ⇒ tính từ ngày hiệu lực', () => {
    expect(nextDue({ cadence: 'monthly', day_of_period: 5, effective_from: '2026-12-01' }, '2026-10-21')).toBe('2026-12-05');
  });

  it('hàng tuần: thứ trong tuần theo day_of_period (1 = thứ Hai)', () => {
    // từ thứ Tư 21/10/2026 đến thứ Hai 26/10/2026
    expect(nextDue({ cadence: 'weekly', day_of_period: 1, effective_from: '2026-01-01' }, '2026-10-21')).toBe('2026-10-26');
  });

  it('ngày trong kỳ bị kẹp về 1…28 để không vượt cuối tháng', () => {
    expect(nextDue({ cadence: 'monthly', day_of_period: 31, effective_from: '2026-01-01' }, '2026-10-01')).toBe('2026-10-28');
  });
});

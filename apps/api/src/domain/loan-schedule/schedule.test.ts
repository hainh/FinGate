import { describe, expect, it } from 'vitest';
import { addMonths, buildSchedule, parseRate, simpleInterest } from './index.ts';

describe('loan-schedule', () => {
  it('parseRate hiểu dấu phẩy và dấu chấm', () => {
    expect(parseRate('9,5')).toBe(9.5);
    expect(parseRate('9.5')).toBe(9.5);
    expect(parseRate('0')).toBe(0);
    expect(parseRate(null)).toBe(0);
  });

  it('addMonths kẹp ngày cuối tháng', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-01-15', 3)).toBe('2026-04-15');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });

  it('simpleInterest lãi đơn 365 ngày', () => {
    // 1 tỷ × 10%/năm × 365 ngày = 100 triệu
    expect(simpleInterest(1_000_000_000n, 10, 365)).toBe(100_000_000n);
    expect(simpleInterest(1_000_000_000n, 10, 0)).toBe(0n);
  });

  it('interest_only: gốc cuối kỳ, lãi mỗi kỳ trên dư nợ gốc', () => {
    const s = buildSchedule({
      principalMinor: 1_000_000_000n,
      rate: '12',
      startDate: '2026-01-01',
      maturityDate: '2026-04-01',
      frequency: 'monthly',
      method: 'interest_only',
    });
    // 3 kỳ: 01/02, 01/03, 01/04 (kỳ cuối = đáo hạn)
    expect(s.rows).toHaveLength(3);
    expect(s.rows[0]!.principal).toBe(0n);
    expect(s.rows[1]!.principal).toBe(0n);
    expect(s.rows[2]!.principal).toBe(1_000_000_000n);
    expect(s.totals.principal).toBe(1_000_000_000n);
    // lãi ~ 1 tỷ × 12% × 90/365 = 29.589.041
    expect(s.totals.interest).toBe(29_589_041n);
  });

  it('equal_principal: chia đều gốc, tổng gốc khớp', () => {
    const s = buildSchedule({
      principalMinor: 1_200_000_000n,
      rate: '12',
      startDate: '2026-01-01',
      maturityDate: '2026-04-01',
      frequency: 'monthly',
      method: 'equal_principal',
    });
    expect(s.rows).toHaveLength(3);
    expect(s.rows[0]!.principal).toBe(400_000_000n);
    expect(s.totals.principal).toBe(1_200_000_000n);
  });

  it('một kỳ khi tần suất = maturity', () => {
    const s = buildSchedule({
      principalMinor: 500_000_000n,
      rate: '8',
      startDate: '2026-01-01',
      maturityDate: '2026-07-01',
      frequency: 'maturity',
      method: 'interest_only',
    });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]!.principal).toBe(500_000_000n);
    expect(s.rows[0]!.due_date).toBe('2026-07-01');
  });
});

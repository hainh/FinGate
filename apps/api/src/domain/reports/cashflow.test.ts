import { describe, expect, it } from 'vitest';
import { buildForecastSeries, loansCoveredByReceipts, netInstallments, parseHorizon, weekdayOf, type ForecastFlow } from './cashflow.ts';
import { buildRemainingSchedule, buildSchedule, simpleInterest } from '../loan-schedule/index.ts';
import { PIPELINE_STATUSES } from '../ledger/planned.ts';

describe('buildForecastSeries — dự báo theo ngày', () => {
  it('đầu/cuối kỳ, vi phạm tối thiểu và tổng theo nhóm', () => {
    const flows: ForecastFlow[] = [
      { date: '2026-10-21', bucket: 'operating_in', amount: 500n },
      { date: '2026-10-22', bucket: 'operating_out', amount: 800n },
      { date: '2026-10-23', bucket: 'disbursement_in', amount: 1000n },
    ];
    const s = buildForecastSeries({ from: '2026-10-21', horizon: 3, opening: 1000n, minBalance: 1200n, flows });
    expect(s.days.map((d) => d.date)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    expect(s.days.map((d) => d.closing)).toEqual([1500n, 700n, 1700n]);
    expect(s.days.map((d) => d.breach)).toEqual([false, true, false]);
    expect(s.first_breach_date).toBe('2026-10-22');
    expect(s.totals).toMatchObject({
      operating_in: 500n,
      operating_out: 800n,
      disbursement_in: 1000n,
      inflow: 1500n,
      outflow: 800n,
      net: 700n,
    });
    expect(s.min_closing).toBe(700n);
    expect(s.end_closing).toBe(1700n);
  });

  it('kẹp phiếu quá hạn chưa thực thi vào ngày bắt đầu; bỏ phiếu ngoài kỳ', () => {
    const flows: ForecastFlow[] = [
      { date: '2026-10-10', bucket: 'operating_out', amount: 100n },
      { date: '2026-12-31', bucket: 'operating_in', amount: 999n },
    ];
    const s = buildForecastSeries({ from: '2026-10-21', horizon: 7, opening: 500n, minBalance: 0n, flows });
    expect(s.days[0]!.outflow).toBe(100n);
    expect(s.days[0]!.closing).toBe(400n);
    expect(s.totals.inflow).toBe(0n);
    expect(s.first_breach_date).toBeNull();
  });

  it('số ngày bằng đúng horizon (7/30/60/90)', () => {
    for (const h of [7, 30, 60, 90]) {
      const s = buildForecastSeries({ from: '2026-10-21', horizon: h, opening: 0n, minBalance: 0n, flows: [] });
      expect(s.days).toHaveLength(h);
    }
  });
});

describe('netInstallments — trừ phiếu trả nợ đã có trong pipeline', () => {
  const rows = [
    { due_date: '2026-11-01', principal: 0n, interest: 100n, total: 100n },
    { due_date: '2026-12-01', principal: 0n, interest: 100n, total: 100n },
    { due_date: '2027-01-01', principal: 1000n, interest: 100n, total: 1100n },
  ];
  it('trừ dần từ kỳ sớm nhất, bỏ kỳ về 0', () => {
    const left = netInstallments(rows, 150n);
    expect(left.map((r) => [r.due_date, r.total])).toEqual([
      ['2026-12-01', 50n],
      ['2027-01-01', 1100n],
    ]);
  });
  it('không trừ khi không có phiếu; trừ hết thì rỗng', () => {
    expect(netInstallments(rows, 0n)).toHaveLength(3);
    expect(netInstallments(rows, 10_000n)).toEqual([]);
  });
  it('trong một kỳ trừ lãi trước rồi gốc; principal + interest luôn = total', () => {
    const one = [{ due_date: '2027-01-01', principal: 1000n, interest: 100n, total: 1100n }];
    const left = netInstallments(one, 600n);
    expect(left).toEqual([{ due_date: '2027-01-01', principal: 500n, interest: 0n, total: 500n }]);
    for (const r of netInstallments(rows, 150n)) expect(r.principal + r.interest).toBe(r.total);
  });
});

describe('loansCoveredByReceipts — giải ngân có hiệu lực (v2 §11.2, §12)', () => {
  it('phiếu nháp / trả về CHƯA có hiệu lực ⇒ khoản vay vẫn "chưa có ngày"; phiếu trong pipeline hoặc đã thực thi ⇒ đã có giải ngân', () => {
    const links = [
      { loanId: 'loan-draft', receiptId: 'rc-draft' },
      { loanId: 'loan-pipeline', receiptId: 'rc-pipeline' },
      { loanId: 'loan-paid', receiptId: 'rc-paid' },
      { loanId: 'loan-returned', receiptId: 'rc-returned' },
    ];
    const statuses = new Map([
      ['rc-draft', 'draft'],
      ['rc-pipeline', 'pending.gd'],
      ['rc-paid', 'paid'],
      ['rc-returned', 'changes_requested'],
    ]);
    expect([...loansCoveredByReceipts(links, statuses)].sort()).toEqual(['loan-paid', 'loan-pipeline']);
  });

  it.each([...PIPELINE_STATUSES, 'paid'])('phiếu ở trạng thái %s có hiệu lực', (status) => {
    expect(loansCoveredByReceipts([{ loanId: 'L', receiptId: 'R' }], new Map([['R', status]]))).toEqual(new Set(['L']));
  });

  it.each(['draft', 'rejected', 'cancelled', 'expired', 'changes_requested'])('phiếu ở trạng thái %s chưa có hiệu lực', (status) => {
    expect(loansCoveredByReceipts([{ loanId: 'L', receiptId: 'R' }], new Map([['R', status]]))).toEqual(new Set());
  });

  it('phiếu không còn tồn tại không tính là có hiệu lực', () => {
    expect(loansCoveredByReceipts([{ loanId: 'L', receiptId: 'R' }], new Map())).toEqual(new Set());
  });
});

describe('tham số & lịch', () => {
  it('parseHorizon chỉ nhận 7/30/60/90, mặc định 30', () => {
    expect(parseHorizon(60)).toBe(60);
    expect(parseHorizon('90')).toBe(90);
    expect(parseHorizon(45)).toBe(30);
    expect(parseHorizon(undefined)).toBe(30);
  });
  it('weekdayOf theo lịch Việt Nam (T2…T7, CN)', () => {
    expect(weekdayOf('2026-10-21')).toBe('T4');
    expect(weekdayOf('2026-10-25')).toBe('CN');
  });
});

describe('buildRemainingSchedule — lịch còn lại khi đã trả một phần gốc (dự báo, §12 · §10.3)', () => {
  const base = {
    principalMinor: 12_000_000n,
    rate: 0,
    startDate: '2026-01-15',
    maturityDate: '2027-01-15',
    frequency: 'monthly' as const,
    method: 'equal_principal' as const,
  };

  it('vay chia đều đã trả 3 kỳ: còn 9 kỳ, mỗi kỳ 1.000.000 (không còn chia lại 750.000 trên lịch đầy đủ)', () => {
    const s = buildRemainingSchedule({ ...base, repaidPrincipalMinor: 3_000_000n });
    expect(s.rows).toHaveLength(9);
    expect(s.rows.map((r) => r.principal)).toEqual(Array(9).fill(1_000_000n));
    expect(s.totals.principal).toBe(9_000_000n);
    expect(s.rows[0]).toMatchObject({ period: 4, due_date: '2026-05-15' });
    expect(s.rows[s.rows.length - 1]).toMatchObject({ period: 12, due_date: '2027-01-15' });
  });

  it('dự báo từ 15/04/2026: các kỳ còn lại đủ 9.000.000 gốc, không thiếu 2.250.000', () => {
    const s = buildRemainingSchedule({ ...base, repaidPrincipalMinor: 3_000_000n });
    const upcoming = s.rows.filter((r) => r.due_date >= '2026-04-15' && r.due_date <= '2027-04-14');
    expect(upcoming.reduce((sum, r) => sum + r.principal, 0n)).toBe(9_000_000n);
  });

  it('lãi tính trên dư nợ còn lại, từ kỳ đã trả gần nhất', () => {
    const s = buildRemainingSchedule({ ...base, rate: 12, repaidPrincipalMinor: 3_000_000n });
    expect(s.rows[0]).toMatchObject({ days: 30, due_date: '2026-05-15' });
    expect(s.rows[0]!.interest).toBe(simpleInterest(9_000_000n, 12, 30));
  });

  it('gốc đã trả lẻ: chỉ kỳ được phủ hết mới tính là đã trả', () => {
    const s = buildRemainingSchedule({ ...base, repaidPrincipalMinor: 2_500_000n });
    expect(s.rows).toHaveLength(10);
    expect(s.rows[0]).toMatchObject({ period: 3, due_date: '2026-04-15' });
    expect(s.totals.principal).toBe(9_500_000n);
  });

  it('đã trả đủ gốc thì không còn kỳ nào; chưa trả gì thì trùng lịch gốc', () => {
    expect(buildRemainingSchedule({ ...base, repaidPrincipalMinor: 12_000_000n }).rows).toEqual([]);
    expect(buildRemainingSchedule({ ...base, repaidPrincipalMinor: 0n })).toEqual(buildSchedule(base));
  });

  it('gốc một lần cuối kỳ (interest_only): giữ đủ kỳ, gốc còn lại trả ở kỳ cuối', () => {
    const s = buildRemainingSchedule({ ...base, method: 'interest_only', repaidPrincipalMinor: 3_000_000n });
    expect(s.rows).toHaveLength(12);
    expect(s.rows[0]!.principal).toBe(0n);
    expect(s.rows[s.rows.length - 1]!.principal).toBe(9_000_000n);
  });
});

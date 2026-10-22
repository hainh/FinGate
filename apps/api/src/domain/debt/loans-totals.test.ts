import { describe, expect, it } from 'vitest';
import { loanBankTotals, type LoanTotalsRow } from './loans.ts';

const row = (partnerId: string | null, bankName: string, status: LoanTotalsRow['status'], outstanding: bigint, days: number): LoanTotalsRow => ({
  item: { partner_id: partnerId, bank_name: bankName },
  status,
  outstanding,
  days,
});

describe('loanBankTotals — dư nợ theo ngân hàng (US-LOAN-02)', () => {
  it('chỉ khoản đang vay / quá hạn; đáo hạn ≤ 7 và ≤ 30 ngày (gồm quá hạn); sắp theo dư nợ giảm dần', () => {
    const rows = loanBankTotals([
      row('bidv', 'BIDV', 'active', 100n, 5),
      row('bidv', 'BIDV', 'active', 50n, 20),
      row('vcb', 'VCB', 'overdue', 300n, -3),
      row('vcb', 'VCB', 'pending_disbursement', 999n, 10),
      row('vcb', 'VCB', 'settled', 0n, 400),
    ]);
    expect(rows.map((r) => r.bank_name)).toEqual(['VCB', 'BIDV']);
    expect(rows[0]).toMatchObject({ key: 'vcb', partner_id: 'vcb', count: 1, outstanding: { minor: '300' }, due7: { minor: '300' }, due30: { minor: '300' } });
    expect(rows[1]).toMatchObject({ count: 2, outstanding: { minor: '150' }, due7: { minor: '100' }, due30: { minor: '150' } });
  });

  it('tính trên đủ mọi khoản (không cắt ở 2.000 dòng): 2.500 khoản của một ngân hàng vẫn cộng đủ số khoản và dư nợ', () => {
    const many = Array.from({ length: 2500 }, (_, i) => row('bidv', 'BIDV', 'active', 1000n, 100 + (i % 3)));
    const rows = loanBankTotals(many);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2500, outstanding: { minor: '2500000' }, due7: { minor: '0' }, due30: { minor: '0' } });
  });

  it('khoản không có đối tác: gom theo tên ngân hàng', () => {
    const rows = loanBankTotals([row(null, 'NH cũ', 'active', 70n, 1), row(null, 'NH cũ', 'overdue', 30n, -1)]);
    expect(rows).toEqual([expect.objectContaining({ key: 'name:NH cũ', partner_id: null, count: 2, outstanding: { minor: '100', currency: 'VND', decimals: 0 } })]);
  });
});

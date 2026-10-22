import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingFundingInflowFor, pendingFundingInflowOf } from './index.ts';

const SRC_ACC = '64b000000000000000000001';
const OTHER_ACC = '64b000000000000000000002';
const COMPANY = '64b0000000000000000000c1';

/* Mô hình DB tối thiểu: quy tắc R3 và phiếu thu do R3 sinh (đọc qua Models). */
const db = vi.hoisted(() => ({
  rule: null as Record<string, unknown> | null,
  receipt: null as Record<string, unknown> | null,
}));

vi.mock('../../db/models.ts', () => ({
  Models: {
    AutomationRule: { findOne: () => ({ lean: async () => db.rule }) },
    Document: { findOne: () => ({ select: () => ({ lean: async () => db.receipt }) }) },
  },
}));

/** Phiếu chi vay để chi (R3) đang chờ duyệt: 6.000.000, TK nhận = TK nguồn, số tiền vay để trống. */
function fundSpend(over: Record<string, unknown> = {}, loanOver: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: '64b0000000000000000000d1',
    company_id: COMPANY,
    kind: 'spend',
    status: 'pending.ktt',
    amount: { minor: 6_000_000n, currency: 'VND', decimals: 0 },
    history: [{ action: 'submit', amount_at_decision: '6000000' }],
    options: {
      loan: { kind: 'fund', mode: 'new', lender_partner_id: 'bank', receive_account_id: SRC_ACC, amount_minor: null, existing_loan_id: null, terms: null, ...loanOver },
    },
    ...over,
  };
}

describe('pendingFundingInflowOf — giải ngân vay để chi chưa vào sổ trước duyệt cuối (R3, §11.5)', () => {
  it('TK nhận = TK nguồn, để trống số tiền vay ⇒ cộng đủ số tiền phiếu (6 tr về trước khi chi 6 tr)', () => {
    expect(pendingFundingInflowOf(fundSpend(), SRC_ACC)).toBe(6_000_000n);
  });

  it('vay một phần (số tiền vay ghi riêng) ⇒ cộng đúng số tiền vay', () => {
    expect(pendingFundingInflowOf(fundSpend({}, { amount_minor: 3_000_000n }), SRC_ACC)).toBe(3_000_000n);
  });

  it('cấp duyệt sửa giảm số tiền phiếu, số vay để trống ⇒ theo số đã chốt', () => {
    expect(pendingFundingInflowOf(fundSpend({ amount: { minor: 4_000_000n, currency: 'VND', decimals: 0 } }), SRC_ACC)).toBe(4_000_000n);
  });

  it.each(['draft', 'changes_requested', 'pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman'])(
    'trạng thái %s (chưa duyệt cuối) ⇒ còn khoản giải ngân sắp về',
    (status) => {
      expect(pendingFundingInflowOf(fundSpend({ status }), SRC_ACC)).toBe(6_000_000n);
    },
  );

  it.each(['approved', 'processing', 'paid', 'rejected', 'cancelled'])('trạng thái %s ⇒ 0 (R3 đã ghi sổ hoặc phiếu không còn hiệu lực)', (status) => {
    expect(pendingFundingInflowOf(fundSpend({ status }), SRC_ACC)).toBe(0n);
  });

  it('TK nhận khác TK nguồn ⇒ 0 (tiền về TK khác, không cộng vào TK nguồn)', () => {
    expect(pendingFundingInflowOf(fundSpend(), OTHER_ACC)).toBe(0n);
  });

  it('không có TK nguồn (quỹ tiền mặt) ⇒ 0', () => {
    expect(pendingFundingInflowOf(fundSpend(), null)).toBe(0n);
  });

  it('phiếu chi không vay, vay kiểu đi vay (borrow) hoặc phiếu thu ⇒ 0', () => {
    expect(pendingFundingInflowOf(fundSpend({ options: { loan: null } }), SRC_ACC)).toBe(0n);
    expect(pendingFundingInflowOf(fundSpend({ options: { loan: { kind: 'borrow', receive_account_id: null } } }), SRC_ACC)).toBe(0n);
    expect(pendingFundingInflowOf(fundSpend({ kind: 'income' }), SRC_ACC)).toBe(0n);
  });

  it('số tiền vay vượt số tiền phiếu ⇒ 0 (R3 sẽ lỗi khi duyệt cuối nên không có giải ngân)', () => {
    expect(pendingFundingInflowOf(fundSpend({}, { amount_minor: 7_000_000n }), SRC_ACC)).toBe(0n);
  });
});

describe('pendingFundingInflowFor — chỉ khi R3 đang bật cho công ty và chưa có phiếu thu R3 (không đếm trùng)', () => {
  beforeEach(() => {
    db.rule = { code: 'R3', enabled: true, company_ids: [], company_overrides: [] };
    db.receipt = null;
  });

  it('R3 bật, chưa có phiếu thu R3 ⇒ cộng khoản giải ngân', async () => {
    await expect(pendingFundingInflowFor(fundSpend(), SRC_ACC)).resolves.toBe(6_000_000n);
  });

  it('R3 tắt toàn hệ thống ⇒ 0 (sẽ không có giải ngân tự động khi duyệt cuối)', async () => {
    db.rule = { code: 'R3', enabled: false, company_ids: [], company_overrides: [] };
    await expect(pendingFundingInflowFor(fundSpend(), SRC_ACC)).resolves.toBe(0n);
  });

  it('R3 tắt riêng cho công ty của phiếu ⇒ 0', async () => {
    db.rule = { code: 'R3', enabled: true, company_ids: [], company_overrides: [{ company_id: COMPANY, enabled: false }] };
    await expect(pendingFundingInflowFor(fundSpend(), SRC_ACC)).resolves.toBe(0n);
  });

  it('không tìm thấy quy tắc R3 ⇒ 0', async () => {
    db.rule = null;
    await expect(pendingFundingInflowFor(fundSpend(), SRC_ACC)).resolves.toBe(0n);
  });

  it('đã có phiếu thu giải ngân do R3 sinh (đã ghi sổ, VD phiếu bị yêu cầu bổ sung khi đang thanh toán) ⇒ 0', async () => {
    db.receipt = { _id: '64b0000000000000000000e1' };
    await expect(pendingFundingInflowFor(fundSpend({ status: 'changes_requested' }), SRC_ACC)).resolves.toBe(0n);
  });
});

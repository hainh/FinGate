import { describe, expect, it } from 'vitest';
import { ApiError } from '@fingate/shared';
import { draftCodeFor } from './voucher-draft.ts';
import {
  planSettlement,
  totalOf,
  type SettleDebtFact,
  type SettleLoanFact,
  type SettlePartnerFact,
} from './settle.ts';

const CO = '6650a1b2c3d4e5f600000001';
const KH = '6650a1b2c3d4e5f600000011';
const KH2 = '6650a1b2c3d4e5f600000012';
const NH = '6650a1b2c3d4e5f600000021';

const customer: SettlePartnerFact = { _id: KH, company_id: CO, type: 'customer', status: 'active', name: 'Khách hàng A' };
const bank: SettlePartnerFact = { _id: NH, company_id: CO, type: 'bank', status: 'active', name: 'BIDV – CN Đông Đô' };

function debt(over: Partial<SettleDebtFact>): SettleDebtFact {
  return { _id: 'd1', code: 'CN-1', company_id: CO, partner_id: KH, direction: 'receivable', value: 1000n, committed: 0n, ...over };
}

function loan(over: Partial<SettleLoanFact>): SettleLoanFact {
  return { _id: 'l1', code: 'NHD-1', company_id: CO, partner_id: NH, status: 'active', principal: 1000n, committed_principal: 0n, ...over };
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.code : 'unknown';
  }
}

describe('planSettlement — kiểm tra trước khi ghi (KH / NCC)', () => {
  it('phân nhóm: khoản phải thu → phiếu thu; khoản phải trả → phiếu chi (cả hai hướng ⇒ hai phiếu)', () => {
    const plan = planSettlement(
      customer,
      [
        { id: 'd1', amount: 400n },
        { id: 'd2', amount: 250n },
      ],
      [],
      [
        debt({ _id: 'd1', direction: 'receivable', value: 1000n }),
        debt({ _id: 'd2', code: 'CN-2', direction: 'payable', value: 300n }),
      ],
      [],
    );
    expect(plan.receivable.map((a) => [a.target_id, a.amount])).toEqual([['d1', 400n]]);
    expect(plan.payable.map((a) => [a.target_id, a.amount])).toEqual([['d2', 250n]]);
    expect(plan.loans).toEqual([]);
    expect(plan.receivable[0]).toMatchObject({ relation: 'offset', target_type: 'debt_voucher', split: null });
    expect(totalOf(plan.receivable)).toBe(400n);
  });

  it('sức chứa: số tiền không vượt phần còn lại (giá trị − đã phân bổ hiệu lực)', () => {
    const d = debt({ value: 1000n, committed: 700n });
    expect(codeOf(() => planSettlement(customer, [{ id: 'd1', amount: 300n }], [], [d], []))).toBeNull();
    expect(codeOf(() => planSettlement(customer, [{ id: 'd1', amount: 301n }], [], [d], []))).toBe('FG-LINK-002');
  });

  it('khoản không thuộc đối tác này (hoặc khác công ty) ⇒ FG-PARTNER-001', () => {
    const other = debt({ partner_id: KH2 });
    expect(codeOf(() => planSettlement(customer, [{ id: 'd1', amount: 10n }], [], [other], []))).toBe('FG-PARTNER-001');
    const otherCompany = debt({ company_id: '6650a1b2c3d4e5f600000099' });
    expect(codeOf(() => planSettlement(customer, [{ id: 'd1', amount: 10n }], [], [otherCompany], []))).toBe('FG-PARTNER-001');
  });

  it('khoản không tồn tại trong danh sách nạp ⇒ FG-PARTNER-001', () => {
    expect(codeOf(() => planSettlement(customer, [{ id: 'missing', amount: 10n }], [], [], []))).toBe('FG-PARTNER-001');
  });

  it('đối tác đã ngừng giao dịch không được trả nợ', () => {
    const inactive: SettlePartnerFact = { ...customer, status: 'inactive' };
    expect(codeOf(() => planSettlement(inactive, [{ id: 'd1', amount: 10n }], [], [debt({})], []))).toBe('FG-PARTNER-001');
  });

  it('không chọn khoản nào ⇒ FG-VAL-001; chọn trùng một khoản ⇒ FG-VAL-001', () => {
    expect(codeOf(() => planSettlement(customer, [], [], [], []))).toBe('FG-VAL-001');
    expect(
      codeOf(() =>
        planSettlement(customer, [{ id: 'd1', amount: 10n }, { id: 'd1', amount: 5n }], [], [debt({})], []),
      ),
    ).toBe('FG-VAL-001');
  });

  it('số tiền không dương ⇒ FG-VAL-001', () => {
    expect(codeOf(() => planSettlement(customer, [{ id: 'd1', amount: 0n }], [], [debt({})], []))).toBe('FG-VAL-001');
  });

  it('KH/NCC không được trả bằng khoản vay; NH không được trả bằng công nợ', () => {
    expect(codeOf(() => planSettlement(customer, [], [{ id: 'l1', amount: 10n, split: null }], [], [loan({ partner_id: KH })]))).toBe('FG-PARTNER-001');
    expect(codeOf(() => planSettlement(bank, [{ id: 'd1', amount: 10n }], [], [debt({ partner_id: NH })], []))).toBe('FG-PARTNER-001');
  });
});

describe('planSettlement — Ngân hàng (phiếu chi trả nợ vay)', () => {
  it('khoản vay đang vay được trả; số tiền không có tách ⇒ toàn bộ là gốc', () => {
    const plan = planSettlement(bank, [], [{ id: 'l1', amount: 300n, split: null }], [], [loan({ principal: 1000n, committed_principal: 200n })]);
    expect(plan.loans).toEqual([
      expect.objectContaining({ relation: 'repayment', target_type: 'bank_debt', target_id: 'l1', amount: 300n, split: null }),
    ]);
  });

  it('khi có tách: sức chứa tính theo phần GỐC, không theo số tiền', () => {
    const l = loan({ principal: 1000n, committed_principal: 900n });
    // gốc 100 + lãi 20 = 120 phải trả: gốc còn 100 ⇒ đủ
    expect(codeOf(() => planSettlement(bank, [], [{ id: 'l1', amount: 120n, split: { principal: 100n, interest: 20n, fee: 0n } }], [], [l]))).toBeNull();
    // gốc 101 > 100 còn lại ⇒ không đủ
    expect(codeOf(() => planSettlement(bank, [], [{ id: 'l1', amount: 121n, split: { principal: 101n, interest: 20n, fee: 0n } }], [], [l]))).toBe('FG-LINK-002');
  });

  it('tổng gốc + lãi + phí phải bằng số tiền trả ⇒ FG-VAL-001', () => {
    const l = loan({});
    expect(codeOf(() => planSettlement(bank, [], [{ id: 'l1', amount: 100n, split: { principal: 60n, interest: 30n, fee: 0n } }], [], [l]))).toBe('FG-VAL-001');
  });

  it('chỉ trả khoản vay đang vay / quá hạn (không trả khoản chờ giải ngân, đã huỷ, đã tất toán)', () => {
    for (const status of ['pending_disbursement', 'cancelled', 'settled', 'archived']) {
      expect(codeOf(() => planSettlement(bank, [], [{ id: 'l1', amount: 10n, split: null }], [], [loan({ status })]))).toBe('FG-PARTNER-001');
    }
    expect(codeOf(() => planSettlement(bank, [], [{ id: 'l1', amount: 10n, split: null }], [], [loan({ status: 'overdue' })]))).toBeNull();
  });

  it('khoản vay của ngân hàng khác ⇒ FG-PARTNER-001', () => {
    expect(codeOf(() => planSettlement(bank, [], [{ id: 'l1', amount: 10n, split: null }], [], [loan({ partner_id: KH })]))).toBe('FG-PARTNER-001');
  });
});

describe('draftCodeFor — mã nháp không trùng khi tạo nhiều phiếu cùng lúc', () => {
  it('luôn có tiền tố DRAFT- (workflow cấp mã thật khi gửi duyệt) và khác nhau giữa các lần gọi', () => {
    const at = new Date('2026-10-21T10:00:00Z');
    const a = draftCodeFor(at);
    const b = draftCodeFor(at);
    expect(a.startsWith('DRAFT-')).toBe(true);
    expect(b.startsWith('DRAFT-')).toBe(true);
    expect(a).not.toBe(b);
  });
});

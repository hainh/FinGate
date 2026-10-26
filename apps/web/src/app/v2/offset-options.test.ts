/**
 * Cấn trừ khoản vay trên phiếu chi (`options.offset`, R7): form → body và nhãn ô chọn. Hàm thuần, không gọi mạng.
 */
import { describe, expect, it } from 'vitest';
import { offsetDebtOptionLabel, offsetLoanOptionLabel, offsetOptionsBody, type OffsetFormValues } from './documents.ts';

const LOAN_ID = 'a'.repeat(24);

const bankForm: OffsetFormValues = {
  on: true,
  target: 'bank_debt',
  targetId: LOAN_ID,
  amountMinor: null,
  interestMinor: '2000000',
  feeMinor: '500000',
};

describe('offsetOptionsBody — form → options.offset', () => {
  it('không cấn trừ (tắt hoặc chưa có form) ⇒ null, để server bỏ cấn trừ đã lưu', () => {
    expect(offsetOptionsBody(null)).toBeNull();
    expect(offsetOptionsBody({ ...bankForm, on: false })).toBeNull();
  });

  it('khoản vay ngân hàng: gửi lãi / phí; số tiền để trống = toàn bộ số tiền phiếu', () => {
    expect(offsetOptionsBody(bankForm)).toEqual({
      target: 'bank_debt',
      target_id: LOAN_ID,
      amount_minor: null,
      interest_minor: '2000000',
      fee_minor: '500000',
    });
  });

  it('công nợ phải trả: số tiền riêng được gửi; lãi / phí không gửi dù form còn số', () => {
    expect(offsetOptionsBody({ ...bankForm, target: 'debt_voucher', amountMinor: '40000000' })).toEqual({
      target: 'debt_voucher',
      target_id: LOAN_ID,
      amount_minor: '40000000',
      interest_minor: null,
      fee_minor: null,
    });
  });
});

describe('nhãn ô cấn trừ', () => {
  it('khoản vay: mã · còn trả được; công nợ: mã · còn cấn trừ được', () => {
    expect(offsetLoanOptionLabel({ code: 'NHD-001', available_principal: { minor: '150000000', currency: 'VND', decimals: 0 } })).toMatch(
      /^NHD-001 · còn trả được /,
    );
    expect(offsetDebtOptionLabel({ code: 'CN-007', available: null })).toMatch(/^CN-007 · còn cấn trừ được /);
  });
});

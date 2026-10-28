import { describe, expect, it } from 'vitest';
import { loanCreateBody, loanUpdateBody } from './bodies.ts';
import { assertMaturityAfterDisbursement, loanDisbursementToggle, manualLoanDisbursement } from './rules.ts';

const PARTNER = '65a000000000000000000001';
const base = { partner_id: PARTNER, amount: { amount_minor: '500000000', currency: 'VND' }, maturity_date: '2027-12-31' };

describe('tạo khoản vay thủ công: đã giải ngân hay chờ giải ngân', () => {
  it('mặc định (không gửi disbursed) là đang vay, ngày giải ngân = hôm nay', () => {
    expect(manualLoanDisbursement({}, '2026-10-28')).toEqual({ status: 'active', disbursedDate: '2026-10-28' });
  });

  it('disbursed_date có thì dùng ngày đó', () => {
    expect(manualLoanDisbursement({ disbursed: true, disbursed_date: '2026-10-01' }, '2026-10-28')).toEqual({
      status: 'active',
      disbursedDate: '2026-10-01',
    });
  });

  it('disbursed: false ⇒ chờ giải ngân, không có ngày giải ngân (bỏ qua disbursed_date)', () => {
    expect(manualLoanDisbursement({ disbursed: false, disbursed_date: '2026-10-01' }, '2026-10-28')).toEqual({
      status: 'pending_disbursement',
      disbursedDate: null,
    });
  });

  it('chờ giải ngân không bị kiểm hạn thanh toán so với ngày giải ngân', () => {
    const { disbursedDate } = manualLoanDisbursement({ disbursed: false }, '2026-10-28');
    expect(() => assertMaturityAfterDisbursement('2026-01-01', disbursedDate)).not.toThrow();
  });

  it('đang vay vẫn kiểm hạn thanh toán phải sau ngày giải ngân', () => {
    const { disbursedDate } = manualLoanDisbursement({}, '2026-10-28');
    expect(() => assertMaturityAfterDisbursement('2026-10-01', disbursedDate)).toThrow();
  });

  it('contract: disbursed là boolean tuỳ chọn; body cũ không gửi vẫn hợp lệ', () => {
    expect(loanCreateBody.safeParse({ ...base, disbursed: false }).success).toBe(true);
    expect(loanCreateBody.safeParse({ ...base, disbursed: 'no' }).success).toBe(false);
    expect(loanCreateBody.safeParse(base).success).toBe(true);
  });
});

describe('sửa khoản vay: đổi giải ngân tay', () => {
  it('chờ giải ngân ⇄ đang vay theo cờ disbursed; không gửi cờ hoặc trùng trạng thái ⇒ không đổi', () => {
    expect(loanDisbursementToggle('pending_disbursement', true)).toBe('to_active');
    expect(loanDisbursementToggle('active', false)).toBe('to_pending');
    expect(loanDisbursementToggle('pending_disbursement', false)).toBeNull();
    expect(loanDisbursementToggle('active', true)).toBeNull();
    expect(loanDisbursementToggle('active', undefined)).toBeNull();
    expect(loanDisbursementToggle('archived', false)).toBeNull();
  });

  it('PATCH nhận disbursed và disbursed_date', () => {
    expect(loanUpdateBody.safeParse({ disbursed: true, disbursed_date: '2026-10-20' }).success).toBe(true);
    expect(loanUpdateBody.safeParse({ disbursed: 'yes' }).success).toBe(false);
  });
});

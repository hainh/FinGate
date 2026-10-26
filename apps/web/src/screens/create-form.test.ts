/**
 * Form phiếu (create-form.tsx): đổi đối tác bỏ khoản vay của ngân hàng cũ (v2 §5.2, §10.3, §11.4);
 * lãi suất nhập tay chỉ nhận số, tối đa 2 chữ số thập phân (cùng quy tắc server).
 */
import { describe, expect, it } from 'vitest';
import { rateTextError, withPartner, type FormState } from './create-form.tsx';

/** Form tối thiểu — chỉ các trường `withPartner` đọc. */
function formWith(partnerId: string | null): FormState {
  return {
    partnerId,
    rolloverLoanId: 'loan-of-A',
    loan: {
      on: true,
      mode: 'existing',
      existingLoanId: 'loan-of-A',
      lenderId: null,
      receiveAccountId: '',
      amount: null,
      contractNo: '',
      interestRate: '',
      termMonths: null,
      dueDate: '',
      repaymentPeriod: '',
      repaymentMethod: '',
      collateral: '',
    },
  } as unknown as FormState;
}

describe('withPartner — đổi đối tác bỏ khoản vay của ngân hàng cũ', () => {
  it('đổi sang ngân hàng khác: bỏ khoản vay có sẵn và khoản đảo hạn đang chọn', () => {
    const next = withPartner(formWith('bank-A'), 'bank-B');
    expect(next.partnerId).toBe('bank-B');
    expect(next.loan.existingLoanId).toBe('');
    expect(next.rolloverLoanId).toBe('');
  });

  it('bỏ chọn đối tác (×): cũng bỏ hai khoản đang chọn', () => {
    const next = withPartner(formWith('bank-A'), null);
    expect(next.partnerId).toBeNull();
    expect(next.loan.existingLoanId).toBe('');
    expect(next.rolloverLoanId).toBe('');
  });

  it('chọn lại đúng đối tác đang chọn (vd. vừa sửa thông tin đối tác): giữ nguyên khoản đã chọn', () => {
    const f = formWith('bank-A');
    expect(withPartner(f, 'bank-A')).toBe(f);
  });

  it('đổi đối tác: bỏ khoản cấn trừ đã chọn (thuộc đối tác cũ), giữ cờ và loại khoản', () => {
    const f = {
      ...formWith('bank-A'),
      offset: { on: true, target: 'bank_debt', targetId: 'loan-of-A', amount: null, interest: null, fee: null },
    } as unknown as FormState;
    const next = withPartner(f, 'bank-B');
    expect(next.offset).toMatchObject({ on: true, target: 'bank_debt', targetId: '' });
  });
});

describe('rateTextError — lãi suất nhập tay: số, tối đa 2 chữ số thập phân', () => {
  it('chấp nhận 9,5 · 9.5 · 9,55 · 12 và để trống', () => {
    for (const v of ['9,5', '9.5', '9,55', '12', '', '  ']) expect(rateTextError(v)).toBeNull();
  });

  it('từ chối chữ, 3–4 chữ số thập phân và dấu phẩy thừa', () => {
    for (const v of ['abc', '9,555', '9,5555', '12,']) expect(rateTextError(v)).toMatch(/Lãi suất dạng số/);
  });
});

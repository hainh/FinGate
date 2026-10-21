/**
 * Kiểm thử hàm thuần của phiếu v2 (form → body, quy tắc liên kết, khoá R3). Không gọi mạng.
 */
import { describe, expect, it } from 'vitest';
import {
  allocatedMinorOf,
  debtDirectionForVoucher,
  defaultLoanDueDate,
  hasAutoLoanRun,
  loanOptionsBody,
  loanTermsBody,
  manualLinkRelationsFor,
  transferTargetBody,
  type DocLink,
  type LoanTermsValues,
} from './documents.ts';

const EMPTY_TERMS: LoanTermsValues = {
  contractNo: '',
  interestRate: '',
  termMonths: null,
  dueDate: '',
  repaymentPeriod: '',
  repaymentMethod: '',
  collateral: '',
};

const link = (over: Partial<DocLink>): DocLink => ({ status: 'active', direction: 'out', amount_minor: '0', ...over }) as unknown as DocLink;

describe('defaultLoanDueDate', () => {
  it('hạn mặc định = ngày gốc + 11 tháng (YYYY-MM-DD)', () => {
    expect(defaultLoanDueDate('2026-10-21T17:00')).toBe('2027-09-21');
  });
  it('không có ngày ⇒ rỗng', () => {
    expect(defaultLoanDueDate('')).toBe('');
    expect(defaultLoanDueDate(null)).toBe('');
  });
});

describe('manualLinkRelationsFor', () => {
  it('ngân hàng: chi ⇒ trả nợ; thu ⇒ giải ngân', () => {
    expect(manualLinkRelationsFor('spend', 'bank')).toEqual(['repayment']);
    expect(manualLinkRelationsFor('income', 'bank')).toEqual(['disbursement']);
  });
  it('KH / NCC: cấn trừ; loại khác hoặc chưa có đối tác: không gắn', () => {
    expect(manualLinkRelationsFor('spend', 'supplier')).toEqual(['offset']);
    expect(manualLinkRelationsFor('income', 'customer')).toEqual(['offset']);
    expect(manualLinkRelationsFor('internal', 'supplier')).toEqual([]);
    expect(manualLinkRelationsFor('income', undefined)).toEqual([]);
  });
  it('hướng công nợ theo loại phiếu', () => {
    expect(debtDirectionForVoucher('income')).toBe('receivable');
    expect(debtDirectionForVoucher('spend')).toBe('payable');
  });
});

describe('allocatedMinorOf', () => {
  it('chỉ cộng liên kết hiệu lực đi ra từ phiếu', () => {
    const total = allocatedMinorOf([
      link({ amount_minor: '100' }),
      link({ amount_minor: '50', status: 'removed' }),
      link({ amount_minor: '30', direction: 'in' }),
      link({ amount_minor: '20' }),
    ]);
    expect(total).toBe(120n);
  });
});

describe('hasAutoLoanRun', () => {
  it('có lượt R3 ⇒ khoá sửa số tiền', () => {
    expect(hasAutoLoanRun([{ rule_code: 'R2' }, { rule_code: 'R3' }])).toBe(true);
    expect(hasAutoLoanRun([{ rule_code: 'R2' }])).toBe(false);
    expect(hasAutoLoanRun(undefined)).toBe(false);
  });
});

describe('loanTermsBody', () => {
  it('mọi ô trống ⇒ null', () => {
    expect(loanTermsBody(EMPTY_TERMS)).toBeNull();
  });
  it('lãi suất dấu phẩy chuẩn hoá thành dấu chấm', () => {
    expect(loanTermsBody({ ...EMPTY_TERMS, interestRate: ' 9,5 ' })?.interest_rate).toBe('9.5');
  });
});

describe('loanOptionsBody', () => {
  const terms = { ...EMPTY_TERMS, termMonths: 12 };
  it('phiếu thu đi vay, gắn khoản có sẵn: gửi khoản có sẵn, không gửi điều khoản', () => {
    const body = loanOptionsBody({
      kind: 'borrow',
      mode: 'existing',
      lenderPartnerId: 'p1',
      receiveAccountId: null,
      amountMinor: null,
      existingLoanId: 'l1',
      terms,
    });
    expect(body).toEqual({
      kind: 'borrow',
      mode: 'existing',
      lender_partner_id: 'p1',
      receive_account_id: null,
      amount_minor: null,
      existing_loan_id: 'l1',
      terms: null,
    });
  });
  it('phiếu thu đi vay, tạo mới: gửi điều khoản, gốc theo số tiền phiếu', () => {
    const body = loanOptionsBody({ kind: 'borrow', mode: 'new', lenderPartnerId: 'p1', receiveAccountId: null, amountMinor: null, existingLoanId: null, terms });
    expect(body?.amount_minor).toBeNull();
    expect(body?.terms?.term_months).toBe(12);
  });
  it('vay để chi: gửi TK nhận giải ngân và số tiền vay, luôn mode mới', () => {
    const body = loanOptionsBody({
      kind: 'fund',
      mode: 'new',
      lenderPartnerId: 'bank1',
      receiveAccountId: 'acc1',
      amountMinor: '500',
      existingLoanId: null,
      terms,
    });
    expect(body).toMatchObject({ kind: 'fund', mode: 'new', receive_account_id: 'acc1', amount_minor: '500', existing_loan_id: null });
  });
  it('không có tuỳ chọn ⇒ null', () => {
    expect(loanOptionsBody(null)).toBeNull();
  });
});

describe('transferTargetBody', () => {
  it('không bật hoặc thiếu công ty ⇒ null; TK không chọn ⇒ account_id null', () => {
    expect(transferTargetBody(false, 'c1', 'a1')).toBeNull();
    expect(transferTargetBody(true, '', 'a1')).toBeNull();
    expect(transferTargetBody(true, 'c1', '')).toEqual({ company_id: 'c1', account_id: null });
  });
});

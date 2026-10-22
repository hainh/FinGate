/**
 * Kiểm thử hàm thuần của phiếu v2 (form → body, quy tắc liên kết, khoá R3). Không gọi mạng.
 */
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  AUTOMATION_FAST_POLL_MS,
  AUTOMATION_IDLE_POLL_MS,
  AUTOMATION_WATCH_MS,
  allocatedMinorOf,
  automationRunsPollMs,
  bankAccountOptionLabel,
  debtDirectionForVoucher,
  defaultLoanDueDate,
  hasAutoLoanRun,
  loanOptionsBody,
  loanTermsBody,
  manualLinkRelationsFor,
  normalizeInterestRate,
  refreshDocumentAfterSave,
  rolloverLoanOptionLabel,
  transferTargetBody,
  type DocLink,
  type LoanTermsValues,
} from './documents.ts';
import type { DocumentDetail } from '../types.ts';

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

describe('automationRunsPollMs — làm tươi lượt tự động của phiếu (panel không bỏ sót lượt đến sau)', () => {
  const OPENED = 1_000_000;
  const done = { status: 'done' };
  const running = { status: 'running' };
  const pending = { status: 'pending' };

  it('có lượt đang chờ / đang chạy ⇒ nhanh (3 giây), dù đã quá khoảng theo dõi', () => {
    expect(automationRunsPollMs([running], OPENED, OPENED + AUTOMATION_WATCH_MS * 5)).toBe(AUTOMATION_FAST_POLL_MS);
    expect(automationRunsPollMs([done, pending], OPENED, OPENED + AUTOMATION_WATCH_MS * 5)).toBe(AUTOMATION_FAST_POLL_MS);
  });

  it('danh sách rỗng (lúc mở chưa có lượt) trong khoảng theo dõi ⇒ vẫn nhanh, để bắt lượt vừa được sinh', () => {
    expect(automationRunsPollMs([], OPENED, OPENED + 5_000)).toBe(AUTOMATION_FAST_POLL_MS);
    expect(automationRunsPollMs(undefined, OPENED, OPENED)).toBe(AUTOMATION_FAST_POLL_MS);
  });

  it('chỉ có lượt đã xong, trong khoảng theo dõi ⇒ nhanh (lần sửa tiếp theo có thể sinh lượt mới)', () => {
    expect(automationRunsPollMs([done], OPENED, OPENED + 60_000)).toBe(AUTOMATION_FAST_POLL_MS);
  });

  it('hết khoảng theo dõi, không có lượt đang chạy ⇒ polling mặc định 30 giây, KHÔNG tắt (không được trả false)', () => {
    expect(automationRunsPollMs([], OPENED, OPENED + AUTOMATION_WATCH_MS)).toBe(AUTOMATION_IDLE_POLL_MS);
    expect(automationRunsPollMs([{ status: 'failed' }], OPENED, OPENED + AUTOMATION_WATCH_MS + 1)).toBe(AUTOMATION_IDLE_POLL_MS);
    expect(AUTOMATION_IDLE_POLL_MS).toBe(30_000);
  });
});

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

describe('normalizeInterestRate', () => {
  it('lãi suất gửi theo dấu phẩy VN, dù người dùng gõ "9,5" hay "9.5" (không đổi thành dấu chấm)', () => {
    expect(normalizeInterestRate(' 9,5 ')).toBe('9,5');
    expect(normalizeInterestRate('9.5')).toBe('9,5');
    expect(normalizeInterestRate('12')).toBe('12');
  });
  it('rỗng ⇒ null; không phải số thập phân thuần thì giữ nguyên để server báo lỗi đúng ô (không đổi thành số khác)', () => {
    expect(normalizeInterestRate('   ')).toBeNull();
    expect(normalizeInterestRate('9%')).toBe('9%');
    expect(normalizeInterestRate('1e3')).toBe('1e3');
  });
});

describe('loanTermsBody', () => {
  it('mọi ô trống ⇒ null', () => {
    expect(loanTermsBody(EMPTY_TERMS)).toBeNull();
  });
  it('lãi suất gửi đúng dạng dấu phẩy "9,5" (phiếu thu đi vay và vay để chi dùng chung)', () => {
    expect(loanTermsBody({ ...EMPTY_TERMS, interestRate: ' 9,5 ' })?.interest_rate).toBe('9,5');
    expect(loanTermsBody({ ...EMPTY_TERMS, interestRate: '9.5' })?.interest_rate).toBe('9,5');
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
  it('vay để chi (R3): lãi suất nhập "9.5" gửi là "9,5" (cùng quy ước với phiếu thu đi vay)', () => {
    const body = loanOptionsBody({
      kind: 'fund',
      mode: 'new',
      lenderPartnerId: 'bank1',
      receiveAccountId: 'acc1',
      amountMinor: null,
      existingLoanId: null,
      terms: { ...terms, interestRate: '9.5' },
    });
    expect(body?.terms?.interest_rate).toBe('9,5');
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

describe('bankAccountOptionLabel', () => {
  type AcctLabel = Parameters<typeof bankAccountOptionLabel>[0];
  const acct = (over: Partial<AcctLabel> = {}): AcctLabel => ({
    bank_name: 'BIDV',
    account_number_masked: '****1234',
    account_name: '',
    is_group: false,
    company_name: 'CTA',
    ...over,
  });
  it('TK cùng ngân hàng, khác tên ⇒ nhãn khác nhau và có tên TK (US-AUTO-03)', () => {
    expect(bankAccountOptionLabel(acct({ account_name: 'TK A' }))).toBe('BIDV · ****1234 · TK A');
    expect(bankAccountOptionLabel(acct({ account_name: 'TK B' }))).toBe('BIDV · ****1234 · TK B');
  });
  it('withCompany: đầu nhãn là tên công ty, hoặc "Tập đoàn" cho TK Tập đoàn', () => {
    expect(bankAccountOptionLabel(acct({ account_name: 'TK A' }), true)).toBe('CTA · BIDV · ****1234 · TK A');
    expect(bankAccountOptionLabel(acct({ is_group: true, company_name: null, account_name: 'Quỹ chung' }), true)).toBe(
      'Tập đoàn · BIDV · ****1234 · Quỹ chung',
    );
    expect(bankAccountOptionLabel(acct({ company_name: null }), true)).toBe('— · BIDV · ****1234');
  });
  it('không có tên TK ⇒ không có hậu tố " · "', () => {
    expect(bankAccountOptionLabel(acct())).toBe('BIDV · ****1234');
  });
});

describe('rolloverLoanOptionLabel', () => {
  type LoanLabel = Parameters<typeof rolloverLoanOptionLabel>[0];
  const loan = (over: Partial<LoanLabel> = {}): LoanLabel => ({
    code: 'NHD-2026-00935',
    principal: { minor: '30000000', currency: 'VND', decimals: 0 },
    maturity_date: '2026-11-11',
    ...over,
  });
  // số tiền gọn dùng khoảng không ngắt (U+00A0) trước "tr" như mọi nhãn tiền của ứng dụng
  it('đáo hạn hiện DD/MM/YYYY, không hiện ISO yyyy-mm-dd (docs/02_design_system.md §4.3)', () => {
    expect(rolloverLoanOptionLabel(loan())).toBe('NHD-2026-00935 · gốc 30 tr · đáo hạn 11/11/2026');
  });
  it('không có ngày đáo hạn ⇒ "—" (không ném lỗi khi vẽ ô chọn)', () => {
    expect(rolloverLoanOptionLabel(loan({ maturity_date: '' }))).toBe('NHD-2026-00935 · gốc 30 tr · đáo hạn —');
  });
});

describe('refreshDocumentAfterSave', () => {
  const SCOPE = 'c1';
  const DOC = 'd1';
  /** Chi tiết tối thiểu: chỉ cần mode khoản vay để phân biệt bản trước/sau khi lưu. */
  const detail = (mode: string): DocumentDetail => ({ _id: DOC, options: { loan: { mode } } }) as unknown as DocumentDetail;

  it('sau khi lưu: bản đệm chi tiết = bản vừa lưu; danh sách và công nợ liên quan bị đánh dấu cũ', () => {
    const qc = new QueryClient();
    qc.setQueryData(['document', SCOPE, DOC], detail('existing'));
    qc.setQueryData(['documents', SCOPE], { items: [] });
    qc.setQueryData(['bank-debts', SCOPE], { items: [] });

    refreshDocumentAfterSave(qc, SCOPE, DOC, detail('later'));

    expect(qc.getQueryData(['document', SCOPE, DOC])).toEqual(detail('later'));
    expect(qc.getQueryState(['documents', SCOPE])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['bank-debts', SCOPE])?.isInvalidated).toBe(true);
  });

  it('không có bản vừa lưu (tạo mới / bước gửi duyệt): giữ bản đệm nhưng đánh dấu cũ để tải lại', () => {
    const qc = new QueryClient();
    qc.setQueryData(['document', SCOPE, DOC], detail('existing'));

    refreshDocumentAfterSave(qc, SCOPE, DOC, null);

    expect(qc.getQueryData(['document', SCOPE, DOC])).toEqual(detail('existing'));
    expect(qc.getQueryState(['document', SCOPE, DOC])?.isInvalidated).toBe(true);
  });
});

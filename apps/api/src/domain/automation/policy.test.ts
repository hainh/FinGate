import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUE_OFFSET_MONTHS,
  DEFAULT_TERM_MONTHS,
  decideOnSourceFinal,
  finalApprovalDateOf,
  intParam,
  isIsoDay,
  loanBaseDate,
  loanExceedsSpend,
  mayCreateLoan,
  mayFollowLoanEdits,
  mayReviveLoan,
  moneyMoved,
  r2CreateAtOf,
  resolveLoanAmount,
  resolveLoanTerms,
  submittedAmountOf,
} from './policy.ts';
import { checkRuleParams, RULE_PARAM_SCHEMAS } from './params.ts';

describe('policy › điều khoản vay mặc định (R2/R3, §11.4 (a))', () => {
  it('mặc định: kỳ hạn 12 tháng, hạn thanh toán = ngày giải ngân + 11 tháng', () => {
    const t = resolveLoanTerms({ terms: null, baseDate: '2026-10-21' });
    expect(DEFAULT_TERM_MONTHS).toBe(12);
    expect(DEFAULT_DUE_OFFSET_MONTHS).toBe(11);
    expect(t.term_months).toBe(12);
    expect(t.due_date).toBe('2027-09-21');
    expect(t.due_is_default).toBe(true);
    expect(t.interest_rate).toBe('0');
    expect(t.payment_frequency).toBe('maturity');
    expect(t.repayment_method).toBe('interest_only');
  });

  it('lệch tháng lùi về ngày cuối tháng khi tháng đích ngắn hơn (31/03 + 11 = 28/02 năm sau)', () => {
    const t = resolveLoanTerms({ terms: null, baseDate: '2026-03-31' });
    expect(t.due_date).toBe('2027-02-28');
  });

  it('người dùng nhập hạn và kỳ hạn thì giữ nguyên (không phải mặc định)', () => {
    const t = resolveLoanTerms({
      terms: { due_date: '2028-01-15', term_months: 24, interest_rate: '8.5', contract_no: ' HD-01 ', collateral: 'Sổ đỏ' },
      baseDate: '2026-10-21',
    });
    expect(t.due_date).toBe('2028-01-15');
    expect(t.due_is_default).toBe(false);
    expect(t.term_months).toBe(24);
    expect(t.interest_rate).toBe('8.5');
    expect(t.contract_no).toBe('HD-01');
    expect(t.collateral).toBe('Sổ đỏ');
  });

  it('hạn người dùng nhập sai định dạng ⇒ coi như chưa nhập', () => {
    const t = resolveLoanTerms({ terms: { due_date: '21/10/2027' }, baseDate: '2026-10-21' });
    expect(t.due_is_default).toBe(true);
    expect(t.due_date).toBe('2027-09-21');
  });

  it('tham số của quy tắc thay mặc định (kỳ hạn, lệch tháng); giá trị sai ⇒ mặc định', () => {
    expect(resolveLoanTerms({ terms: null, baseDate: '2026-10-21', params: { term_months: 24, due_offset_months: 6 } })).toMatchObject({
      term_months: 24,
      due_date: '2027-04-21',
    });
    expect(resolveLoanTerms({ terms: null, baseDate: '2026-10-21', params: { term_months: 'abc', due_offset_months: -3 } })).toMatchObject({
      term_months: 12,
      due_date: '2027-09-21',
    });
  });

  it('kỳ trả và phương thức: giá trị lạ ⇒ mặc định', () => {
    const t = resolveLoanTerms({ terms: { repayment_period: 'monthly', repayment_method: 'equal_principal' }, baseDate: '2026-10-21' });
    expect(t.payment_frequency).toBe('monthly');
    expect(t.repayment_method).toBe('equal_principal');
    const u = resolveLoanTerms({ terms: { repayment_period: 'weekly', repayment_method: 'x' }, baseDate: '2026-10-21' });
    expect(u.payment_frequency).toBe('maturity');
    expect(u.repayment_method).toBe('interest_only');
  });
});

describe('policy › tham số & kiểu dữ liệu', () => {
  it('intParam: số nguyên trong khoảng mới nhận; chuỗi số được chấp nhận', () => {
    expect(intParam(12, 1, 1, 600)).toBe(12);
    expect(intParam('18', 1, 1, 600)).toBe(18);
    expect(intParam(12.5, 1, 1, 600)).toBe(1);
    expect(intParam(0, 1, 1, 600)).toBe(1);
    expect(intParam(null, 7, 1, 600)).toBe(7);
    expect(intParam('   ', 7, 1, 600)).toBe(7);
  });

  it('isIsoDay chỉ nhận YYYY-MM-DD thật', () => {
    expect(isIsoDay('2026-02-28')).toBe(true);
    expect(isIsoDay('2026-02-30')).toBe(false);
    expect(isIsoDay('2026-2-3')).toBe(false);
    expect(isIsoDay(null)).toBe(false);
  });

  it('r2_create_at: chỉ "approve" là duyệt, còn lại là lưu', () => {
    expect(r2CreateAtOf('approve')).toBe('approve');
    expect(r2CreateAtOf('save')).toBe('save');
    expect(r2CreateAtOf(undefined)).toBe('save');
    expect(r2CreateAtOf('xyz')).toBe('save');
  });

  it('ngày gốc tính hạn: ưu tiên ngày thực thi, rồi ngày dự kiến (bỏ phần giờ), cuối cùng là ngày mặc định', () => {
    expect(loanBaseDate({ paidDate: '2026-10-22', plannedDate: '2026-10-30', fallback: '2026-10-21' })).toBe('2026-10-22');
    expect(loanBaseDate({ paidDate: null, plannedDate: '2026-10-30T09:00', fallback: '2026-10-21' })).toBe('2026-10-30');
    expect(loanBaseDate({ paidDate: null, plannedDate: '', fallback: '2026-10-21' })).toBe('2026-10-21');
  });
});

describe('policy › số tiền vay của R3 (§11.5, ngoại lệ "cấp duyệt sửa số tiền")', () => {
  it('không nhập số tiền vay ⇒ theo số tiền đã duyệt cuối', () => {
    expect(resolveLoanAmount({ requested: null, originalMinor: 100n, finalMinor: 80n })).toEqual({ amount: 80n, followsFinal: true });
  });

  it('số tiền vay BẰNG số tiền lúc gửi duyệt ⇒ đi theo số đã chốt khi duyệt', () => {
    expect(resolveLoanAmount({ requested: 100n, originalMinor: 100n, finalMinor: 80n })).toEqual({ amount: 80n, followsFinal: true });
  });

  it('số tiền vay khác số lúc gửi duyệt (vay một phần) ⇒ giữ số đó', () => {
    expect(resolveLoanAmount({ requested: 60n, originalMinor: 100n, finalMinor: 100n })).toEqual({ amount: 60n, followsFinal: false });
  });

  it('số tiền vay vượt số phiếu chi đã duyệt, hoặc không dương ⇒ lỗi', () => {
    expect(() => resolveLoanAmount({ requested: 120n, originalMinor: 100n, finalMinor: 100n })).toThrow(/lớn hơn số tiền/);
    expect(() => resolveLoanAmount({ requested: 0n, originalMinor: 100n, finalMinor: 100n })).toThrow(/lớn hơn 0/);
  });

  it('số tiền lúc gửi duyệt đọc từ dòng `submit` đầu tiên; thiếu ⇒ null', () => {
    expect(submittedAmountOf([{ action: 'submit', amount_at_decision: '5000' }, { action: 'approve', amount_at_decision: '4000' }])).toBe(5000n);
    expect(submittedAmountOf([{ action: 'approve', amount_at_decision: '4000' }])).toBeNull();
    expect(submittedAmountOf([{ action: 'submit', amount_at_decision: 'abc' }])).toBeNull();
  });

  it('ngày duyệt cuối = thời điểm dòng duyệt cuối (giờ Việt Nam); không có ⇒ ngày mặc định', () => {
    const history = [
      { action: 'submit', at: new Date('2026-10-20T03:00:00Z') },
      { action: 'approve', at: new Date('2026-10-20T04:00:00Z') },
      { action: 'approve_with_reason', at: new Date('2026-10-21T18:00:00Z') },
    ];
    // 18:00 UTC = 01:00 ngày 22/10 theo giờ Việt Nam
    expect(finalApprovalDateOf(history, '2026-01-01')).toBe('2026-10-22');
    expect(finalApprovalDateOf([{ action: 'submit', at: new Date() }], '2026-01-01')).toBe('2026-01-01');
  });
});

describe('policy › R6: huỷ phiếu nguồn', () => {
  it('có tiền về (trạng thái đã giải ngân hoặc có ngày giải ngân) ⇒ đã phát sinh tiền', () => {
    expect(moneyMoved({ status: 'active' })).toBe(true);
    expect(moneyMoved({ status: 'pending_disbursement', disbursed_at: new Date() })).toBe(true);
    expect(moneyMoved({ status: 'pending_disbursement' })).toBe(false);
    expect(moneyMoved({ status: 'cancelled' })).toBe(false);
  });

  it('chưa có tiền, khoản do quy tắc sinh ⇒ HUỶ; khoản tạo tay ⇒ chỉ GỠ liên kết', () => {
    expect(decideOnSourceFinal({ loanStatus: 'pending_disbursement', origin: 'automation' })).toBe('cancel');
    expect(decideOnSourceFinal({ loanStatus: 'pending_disbursement', origin: 'manual' })).toBe('unlink');
  });

  it('đã có tiền ⇒ chỉ CẢNH BÁO (không tự huỷ), dù khoản do quy tắc sinh', () => {
    expect(decideOnSourceFinal({ loanStatus: 'active', origin: 'automation' })).toBe('alert');
    expect(decideOnSourceFinal({ loanStatus: 'settled', origin: 'manual' })).toBe('alert');
    expect(decideOnSourceFinal({ loanStatus: 'pending_disbursement', origin: 'automation', disbursedAt: new Date() })).toBe('alert');
  });

  it('đã huỷ rồi ⇒ không làm gì', () => {
    expect(decideOnSourceFinal({ loanStatus: 'cancelled', origin: 'automation' })).toBe('none');
  });
});

describe('policy › R2: thời điểm tạo / đồng bộ / phục hồi khoản vay', () => {
  it('chế độ lưu (save): tạo khi lập, sửa, gửi duyệt — khi còn trước duyệt cuối, không tạo khi bị từ chối', () => {
    expect(mayCreateLoan({ createAt: 'save', eventType: 'voucher.created', status: 'draft' })).toBe(true);
    expect(mayCreateLoan({ createAt: 'save', eventType: 'voucher.updated', status: 'pending.ktt' })).toBe(true);
    expect(mayCreateLoan({ createAt: 'save', eventType: 'voucher.submitted', status: 'pending.pgd' })).toBe(true);
    expect(mayCreateLoan({ createAt: 'save', eventType: 'voucher.updated', status: 'rejected' })).toBe(false);
    expect(mayCreateLoan({ createAt: 'save', eventType: 'voucher.updated', status: 'cancelled' })).toBe(false);
  });

  it('chế độ duyệt (approve): chỉ tạo sau khi phiếu được duyệt', () => {
    expect(mayCreateLoan({ createAt: 'approve', eventType: 'voucher.updated', status: 'draft' })).toBe(false);
    expect(mayCreateLoan({ createAt: 'approve', eventType: 'voucher.approved', status: 'paid' })).toBe(true);
  });

  it('đã giải ngân mà chưa có khoản vay (quy tắc bật sau) ⇒ tạo bù ở mọi chế độ', () => {
    expect(mayCreateLoan({ createAt: 'save', eventType: 'voucher.paid', status: 'paid' })).toBe(true);
  });

  it('chỉ đồng bộ khoản vay khi phiếu còn trước duyệt cuối', () => {
    expect(mayFollowLoanEdits('draft')).toBe(true);
    expect(mayFollowLoanEdits('changes_requested')).toBe(true);
    expect(mayFollowLoanEdits('pending.chairman')).toBe(true);
    expect(mayFollowLoanEdits('approved')).toBe(false);
    expect(mayFollowLoanEdits('paid')).toBe(false);
  });

  it('phục hồi khoản đã huỷ khi chọn lại "vay mới" trên phiếu còn trước duyệt cuối (kể cả nháp)', () => {
    expect(mayReviveLoan({ eventType: 'voucher.submitted', status: 'pending.ktt' })).toBe(true);
    expect(mayReviveLoan({ eventType: 'voucher.updated', status: 'draft' })).toBe(true);
    expect(mayReviveLoan({ eventType: 'voucher.updated', status: 'changes_requested' })).toBe(true);
  });

  it('không phục hồi khi phiếu bị từ chối đứng yên, đã duyệt cuối hoặc đã huỷ', () => {
    expect(mayReviveLoan({ eventType: 'voucher.updated', status: 'rejected' })).toBe(false);
    expect(mayReviveLoan({ eventType: 'voucher.submitted', status: 'rejected' })).toBe(false);
    expect(mayReviveLoan({ eventType: 'voucher.approved', status: 'approved' })).toBe(false);
    expect(mayReviveLoan({ eventType: 'voucher.updated', status: 'cancelled' })).toBe(false);
  });
});

describe('policy › vay một phần của phiếu chi vay để chi (§6.3, §11.5)', () => {
  it('vay theo số tiền phiếu (null) luôn hợp lệ, kể cả khi số tiền chi giảm khi duyệt', () => {
    expect(loanExceedsSpend({ loanMinor: null, spendMinor: 1n })).toBe(false);
  });

  it('số tiền chi sau duyệt không được nhỏ hơn số tiền vay riêng; bằng nhau thì hợp lệ', () => {
    expect(loanExceedsSpend({ loanMinor: 80_000_000n, spendMinor: 60_000_000n })).toBe(true);
    expect(loanExceedsSpend({ loanMinor: 60_000_000n, spendMinor: 60_000_000n })).toBe(false);
    expect(loanExceedsSpend({ loanMinor: 60_000_000n, spendMinor: 100_000_000n })).toBe(false);
  });
});

describe('automation › kiểm tra tham số quy tắc (US-AUTO-07)', () => {
  it('chấp nhận tham số đã biết, đúng kiểu', () => {
    expect(checkRuleParams('R2', { term_months: 24, due_offset_months: 6, r2_create_at: 'approve' })).toEqual({
      term_months: 24,
      due_offset_months: 6,
      r2_create_at: 'approve',
    });
    expect(checkRuleParams('R3', { due_offset_months: 0 })).toEqual({ due_offset_months: 0 });
  });

  it('khoá lạ, kiểu sai, ngoài khoảng ⇒ FG-VAL-001 kèm lỗi theo khoá', () => {
    const thrown = (() => {
      try {
        checkRuleParams('R2', { term_months: 0, r2_create_at: 'later', unknown_key: 1 });
        return null;
      } catch (err) {
        return err as { code?: string; errors?: Record<string, string> };
      }
    })();
    expect(thrown?.code).toBe('FG-VAL-001');
    expect(Object.keys(thrown?.errors ?? {}).sort()).toEqual(['r2_create_at', 'term_months', 'unknown_key']);
  });

  it('quy tắc không có tham số cấu hình ⇒ mọi khoá đều bị từ chối', () => {
    expect(() => checkRuleParams('R6', { term_months: 12 })).toThrow();
    expect(RULE_PARAM_SCHEMAS.R6).toBeUndefined();
  });
});

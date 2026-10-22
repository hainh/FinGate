import { describe, expect, it } from 'vitest';
import { ApiError } from '@fingate/shared';
import {
  assertAmountEditAllowed,
  assertDisbursementNotChosenLoan,
  assertDocumentLinkable,
  assertLenderBank,
  assertTagSelection,
  assertTransferTargetAccount,
  assertTransferTargetFits,
  assertTransferTargetSubmittable,
  assertVoucherPartner,
  diffIds,
  dedupeIds,
  effectiveLoanAmount,
  manualLinkTargetType,
  parseIdList,
  planLoanOptions,
} from './rules.ts';

const CO = 'a'.repeat(24);
const CO2 = 'c'.repeat(24);
const P_BANK = 'b'.repeat(24);
const P_CUST = 'd'.repeat(24);
const ACC = 'e'.repeat(24);
const LOAN = 'f'.repeat(24);
const LOAN_OTHER = '1'.repeat(24);

/** Mã lỗi của một hàm ném ApiError ('' nếu không ném). */
function codeOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (err) {
    return err instanceof ApiError ? err.code : `OTHER:${String(err)}`;
  }
}

describe('id & so sánh tập id', () => {
  it('dedupeIds khử trùng và giữ thứ tự', () => {
    expect(dedupeIds([P_BANK, P_CUST, P_BANK])).toEqual([P_BANK, P_CUST]);
  });

  it('diffIds trả phần thêm và phần bỏ', () => {
    expect(diffIds([P_BANK, P_CUST], [P_CUST, ACC])).toEqual({ added: [ACC], removed: [P_BANK] });
    expect(diffIds([P_BANK], [P_BANK])).toEqual({ added: [], removed: [] });
  });

  it('parseIdList đọc "a,b" và tham số lặp; ID sai định dạng ⇒ FG-VAL-001', () => {
    expect(parseIdList(`${P_BANK},${P_CUST}`)).toEqual([P_BANK, P_CUST]);
    expect(parseIdList([P_BANK, `${P_CUST},${P_BANK}`])).toEqual([P_BANK, P_CUST]);
    expect(parseIdList(undefined)).toEqual([]);
    expect(codeOf(() => parseIdList('khong-hop-le'))).toBe('FG-VAL-001');
  });
});

describe('đối tác của phiếu (§5.2)', () => {
  const bank = { company_id: CO, type: 'bank', status: 'active' };
  const cust = { company_id: CO, type: 'customer', status: 'active' };

  it('đối tác thuộc công ty khác / không tồn tại ⇒ FG-PARTNER-001', () => {
    expect(codeOf(() => assertVoucherPartner(null, { companyId: CO, loanKind: null, requireActive: true }))).toBe('FG-PARTNER-001');
    expect(codeOf(() => assertVoucherPartner({ ...cust, company_id: CO2 }, { companyId: CO, loanKind: null, requireActive: true }))).toBe('FG-PARTNER-001');
  });

  it('lựa chọn MỚI phải đang hoạt động; giữ nguyên thì ngừng giao dịch vẫn chấp nhận', () => {
    const stopped = { ...cust, status: 'inactive' };
    expect(codeOf(() => assertVoucherPartner(stopped, { companyId: CO, loanKind: null, requireActive: true }))).toBe('FG-PARTNER-001');
    expect(codeOf(() => assertVoucherPartner(stopped, { companyId: CO, loanKind: null, requireActive: false }))).toBe('');
  });

  it('phiếu thu đi vay: bên nộp tiền phải là Ngân hàng; mọi loại khác đều được', () => {
    expect(codeOf(() => assertVoucherPartner(cust, { companyId: CO, loanKind: 'borrow', requireActive: true }))).toBe('FG-PARTNER-001');
    expect(codeOf(() => assertVoucherPartner(bank, { companyId: CO, loanKind: 'borrow', requireActive: true }))).toBe('');
    expect(codeOf(() => assertVoucherPartner(cust, { companyId: CO, loanKind: null, requireActive: true }))).toBe('');
  });

  it('ngân hàng cho vay (phiếu chi vay để chi) phải là loại Ngân hàng, đang hoạt động khi chọn mới', () => {
    expect(codeOf(() => assertLenderBank(cust, { companyId: CO, requireActive: true, field: 'options.loan.lender_partner_id' }))).toBe('FG-PARTNER-001');
    expect(codeOf(() => assertLenderBank(bank, { companyId: CO, requireActive: true, field: 'options.loan.lender_partner_id' }))).toBe('');
    expect(codeOf(() => assertLenderBank({ ...bank, status: 'inactive' }, { companyId: CO, requireActive: true, field: 'x' }))).toBe('FG-PARTNER-001');
  });
});

describe('tag (§6.2)', () => {
  it('tag không thuộc công ty (thiếu bản ghi) ⇒ FG-VAL-001', () => {
    expect(codeOf(() => assertTagSelection([P_BANK, CO], [{ id: P_BANK, hidden: false }], []))).toBe('FG-VAL-001');
  });

  it('tag ĐÃ ẨN không được gắn thêm; tag đã ẩn đang có trên phiếu thì giữ được', () => {
    const rows = [{ id: P_BANK, hidden: true }];
    expect(codeOf(() => assertTagSelection([P_BANK], rows, []))).toBe('FG-VAL-001');
    expect(codeOf(() => assertTagSelection([P_BANK], rows, [P_BANK]))).toBe('');
  });

  it('quá 50 tag ⇒ FG-VAL-001', () => {
    const ids = Array.from({ length: 51 }, (_, i) => i.toString(16).padStart(24, '0'));
    expect(codeOf(() => assertTagSelection(ids, ids.map((id) => ({ id, hidden: false })), []))).toBe('FG-VAL-001');
  });
});

describe('tuỳ chọn vay — phiếu thu đi vay (R2, §11.4)', () => {
  const ctx = (over: Partial<{ voucherKind: 'income' | 'spend'; voucherPartnerId: string | null; voucherAmountMinor: bigint }> = {}) => ({
    voucherKind: 'income' as const,
    voucherPartnerId: P_BANK,
    voucherAmountMinor: 500_000_000n,
    ...over,
  });

  it('không khai báo ⇒ null (không phải phiếu vay)', () => {
    expect(planLoanOptions(null, ctx())).toBeNull();
    expect(planLoanOptions(undefined, ctx())).toBeNull();
  });

  it('"đi vay" mặc định mode later; gốc = số tiền phiếu (lưu null để đi theo phiếu); lender = đối tác phiếu', () => {
    const plan = planLoanOptions({ kind: 'borrow', mode: 'later' }, ctx());
    expect(plan).toEqual({
      kind: 'borrow',
      mode: 'later',
      lender_partner_id: P_BANK,
      receive_account_id: null,
      amount_minor: null,
      existing_loan_id: null,
      terms: null,
    });
  });

  it('gốc khai báo khác số tiền phiếu ⇒ FG-VAL-001; bằng đúng số tiền phiếu thì chấp nhận', () => {
    expect(codeOf(() => planLoanOptions({ kind: 'borrow', mode: 'new', amount_minor: '1' }, ctx()))).toBe('FG-VAL-001');
    expect(codeOf(() => planLoanOptions({ kind: 'borrow', mode: 'new', amount_minor: '500000000' }, ctx()))).toBe('');
  });

  it('chỉ phiếu thu mới được "đi vay"; mode existing cần khoản vay có sẵn', () => {
    expect(codeOf(() => planLoanOptions({ kind: 'borrow', mode: 'later' }, ctx({ voucherKind: 'spend' })))).toBe('FG-VAL-001');
    expect(codeOf(() => planLoanOptions({ kind: 'borrow', mode: 'existing' }, ctx()))).toBe('FG-VAL-001');
    const plan = planLoanOptions({ kind: 'borrow', mode: 'existing', existing_loan_id: LOAN }, ctx());
    expect(plan?.existing_loan_id).toBe(LOAN);
  });

  it('ngân hàng cho vay khác đối tác phiếu ⇒ FG-VAL-001; không có đối tác ⇒ FG-VAL-001', () => {
    expect(codeOf(() => planLoanOptions({ kind: 'borrow', lender_partner_id: P_CUST }, ctx()))).toBe('FG-VAL-001');
    expect(codeOf(() => planLoanOptions({ kind: 'borrow' }, ctx({ voucherPartnerId: null })))).toBe('FG-VAL-001');
  });

  it('điều khoản toàn trống ⇒ terms null; có một trường ⇒ giữ điều khoản', () => {
    expect(planLoanOptions({ kind: 'borrow', terms: { contract_no: null, term_months: null } }, ctx())?.terms).toBeNull();
    const plan = planLoanOptions({ kind: 'borrow', terms: { contract_no: 'HĐTD-1', term_months: 12, interest_rate: '9.5' } }, ctx());
    expect(plan?.terms).toMatchObject({ contract_no: 'HĐTD-1', term_months: 12, interest_rate: '9.5', due_date: null });
  });
});

describe('tuỳ chọn vay — phiếu chi vay để chi (R3, §11.5)', () => {
  const ctx = (over: Partial<{ voucherKind: 'income' | 'spend'; voucherAmountMinor: bigint }> = {}) => ({
    voucherKind: 'spend' as const,
    voucherPartnerId: P_CUST,
    voucherAmountMinor: 100_000_000n,
    ...over,
  });
  const fund = { kind: 'fund' as const, lender_partner_id: P_BANK, receive_account_id: ACC };

  it('thiếu ngân hàng cho vay hoặc TK nhận giải ngân ⇒ FG-VAL-001', () => {
    expect(codeOf(() => planLoanOptions({ kind: 'fund', receive_account_id: ACC }, ctx()))).toBe('FG-VAL-001');
    expect(codeOf(() => planLoanOptions({ kind: 'fund', lender_partner_id: P_BANK }, ctx()))).toBe('FG-VAL-001');
  });

  it('chỉ phiếu chi mới "vay để chi"', () => {
    expect(codeOf(() => planLoanOptions(fund, ctx({ voucherKind: 'income' })))).toBe('FG-VAL-001');
  });

  it('luôn tạo khoản vay mới (mode new); mode existing bị từ chối', () => {
    expect(planLoanOptions({ ...fund, mode: 'later' }, ctx())?.mode).toBe('new');
    expect(codeOf(() => planLoanOptions({ ...fund, mode: 'existing' }, ctx()))).toBe('FG-VAL-001');
  });

  it('số tiền vay mặc định theo phiếu (null); bằng đúng số tiền phiếu cũng để null; vay một phần thì giữ số', () => {
    expect(planLoanOptions(fund, ctx())?.amount_minor).toBeNull();
    expect(planLoanOptions({ ...fund, amount_minor: '100000000' }, ctx())?.amount_minor).toBeNull();
    expect(planLoanOptions({ ...fund, amount_minor: '60000000' }, ctx())?.amount_minor).toBe(60_000_000n);
  });

  it('số tiền vay phải > 0 và không vượt số tiền phiếu chi', () => {
    expect(codeOf(() => planLoanOptions({ ...fund, amount_minor: '0' }, ctx()))).toBe('FG-VAL-001');
    expect(codeOf(() => planLoanOptions({ ...fund, amount_minor: '100000001' }, ctx()))).toBe('FG-VAL-001');
  });

  it('effectiveLoanAmount: để theo phiếu thì lấy số tiền phiếu; có số tiền thì lấy số đó', () => {
    expect(effectiveLoanAmount({ amount_minor: null }, 100n)).toBe(100n);
    expect(effectiveLoanAmount({ amount_minor: 60n }, 100n)).toBe(60n);
  });
});

describe('chuyển tiền nội bộ theo ID (§11.6)', () => {
  it('không có đích ⇒ không kiểm', () => {
    expect(codeOf(() => assertTransferTargetFits('spend', null, CO))).toBe('');
  });

  it('chỉ phiếu chi / chuyển nội bộ có đích; phiếu thu có đích ⇒ FG-VAL-001', () => {
    expect(codeOf(() => assertTransferTargetFits('spend', { company_id: CO2 }, CO))).toBe('');
    expect(codeOf(() => assertTransferTargetFits('internal', { company_id: CO2 }, CO))).toBe('');
    expect(codeOf(() => assertTransferTargetFits('income', { company_id: CO2 }, CO))).toBe('FG-VAL-001');
  });

  it('công ty nhận phải khác công ty lập phiếu', () => {
    expect(codeOf(() => assertTransferTargetFits('spend', { company_id: CO }, CO))).toBe('FG-VAL-001');
  });

  it('có công ty nhận thì bắt buộc TK đích theo ID (thiếu / null ⇒ FG-VAL-001); không có đích ⇒ không kiểm', () => {
    expect(codeOf(() => assertTransferTargetAccount(null))).toBe('');
    expect(codeOf(() => assertTransferTargetAccount({ account_id: null }))).toBe('FG-VAL-001');
    expect(codeOf(() => assertTransferTargetAccount({ account_id: undefined }))).toBe('FG-VAL-001');
    expect(codeOf(() => assertTransferTargetAccount({ account_id: ACC }))).toBe('');
  });

  it('gửi duyệt: nháp chuyển nội bộ thiếu TK đích (lưu trước khi có kiểm tra khi lưu) ⇒ FG-VAL-001, không để lọt vào duyệt', () => {
    expect(codeOf(() => assertTransferTargetSubmittable('spend', CO, { company_id: CO2, account_id: null }))).toBe('FG-VAL-001');
    expect(codeOf(() => assertTransferTargetSubmittable('spend', CO, { company_id: CO2 }))).toBe('FG-VAL-001');
    expect(codeOf(() => assertTransferTargetSubmittable('spend', CO, { company_id: CO2, account_id: ACC }))).toBe('');
  });

  it('gửi duyệt: đích không có công ty nhận ⇒ không kiểm; công ty nhận trùng công ty phiếu / phiếu thu có đích ⇒ FG-VAL-001', () => {
    expect(codeOf(() => assertTransferTargetSubmittable('spend', CO, null))).toBe('');
    expect(codeOf(() => assertTransferTargetSubmittable('spend', CO, { company_id: null, account_id: null }))).toBe('');
    expect(codeOf(() => assertTransferTargetSubmittable('spend', CO, { company_id: CO, account_id: ACC }))).toBe('FG-VAL-001');
    expect(codeOf(() => assertTransferTargetSubmittable('income', CO, { company_id: CO2, account_id: ACC }))).toBe('FG-VAL-001');
  });

  it('thông báo lỗi nêu đúng việc cần làm: "Chọn tài khoản nhận của công ty đích" (khớp kiểm tra khi lưu)', () => {
    try {
      assertTransferTargetSubmittable('spend', CO, { company_id: CO2, account_id: null });
      throw new Error('không ném lỗi');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).detail).toBe('Chọn tài khoản nhận của công ty đích');
    }
  });
});

describe('gỡ liên kết giải ngân theo lựa chọn vay trên phiếu (§11.2, §11.4 (b))', () => {
  const manualToChosen = { origin: 'manual', relation: 'disbursement', to_type: 'bank_debt', to_id: LOAN };
  const chosen = { kind: 'borrow', mode: 'existing', existing_loan_id: LOAN };

  it('liên kết thủ công tới khoản ĐANG CHỌN ("Gắn khoản vay đã có") ⇒ FG-WF-005, dù gỡ từ phiếu hay từ khoản vay', () => {
    expect(codeOf(() => assertDisbursementNotChosenLoan(manualToChosen, chosen))).toBe('FG-WF-005');
  });

  it('gỡ được khi lựa chọn vay đã đổi / để sau / vay mới / không vay, hoặc liên kết tới khoản khác', () => {
    expect(codeOf(() => assertDisbursementNotChosenLoan(manualToChosen, { ...chosen, existing_loan_id: LOAN_OTHER }))).toBe('');
    expect(codeOf(() => assertDisbursementNotChosenLoan(manualToChosen, { ...chosen, mode: 'later', existing_loan_id: null }))).toBe('');
    expect(codeOf(() => assertDisbursementNotChosenLoan(manualToChosen, { ...chosen, mode: 'new' }))).toBe('');
    expect(codeOf(() => assertDisbursementNotChosenLoan(manualToChosen, { kind: 'fund', mode: 'existing', existing_loan_id: LOAN }))).toBe('');
    expect(codeOf(() => assertDisbursementNotChosenLoan(manualToChosen, null))).toBe('');
    expect(codeOf(() => assertDisbursementNotChosenLoan(manualToChosen, undefined))).toBe('');
  });

  it('liên kết tự động (không thuộc lựa chọn thủ công), quan hệ khác hoặc không tới nợ NH thì không chặn ở đây', () => {
    expect(codeOf(() => assertDisbursementNotChosenLoan({ ...manualToChosen, origin: 'automation' }, chosen))).toBe('');
    expect(codeOf(() => assertDisbursementNotChosenLoan({ ...manualToChosen, relation: 'repayment' }, chosen))).toBe('');
    expect(codeOf(() => assertDisbursementNotChosenLoan({ ...manualToChosen, to_type: 'debt_voucher' }, chosen))).toBe('');
  });
});

describe('sửa số tiền ở cấp duyệt sau R3 (§11.5 ngoại lệ)', () => {
  it('không đổi số tiền / không gửi số tiền ⇒ luôn cho qua, kể cả đã có R3', () => {
    expect(codeOf(() => assertAmountEditAllowed(100n, null, true))).toBe('');
    expect(codeOf(() => assertAmountEditAllowed(100n, 100n, true))).toBe('');
  });

  it('đổi số tiền khi CHƯA có R3 ⇒ được; đã có R3 ⇒ FG-WF-005', () => {
    expect(codeOf(() => assertAmountEditAllowed(100n, 120n, false))).toBe('');
    expect(codeOf(() => assertAmountEditAllowed(100n, 120n, true))).toBe('FG-WF-005');
  });
});

describe('liên kết thủ công từ phiếu (§11.2)', () => {
  it('cấn trừ → khoản công nợ; trả nợ / giải ngân → khoản nợ ngân hàng', () => {
    expect(manualLinkTargetType('offset')).toBe('debt_voucher');
    expect(manualLinkTargetType('repayment')).toBe('bank_debt');
    expect(manualLinkTargetType('disbursement')).toBe('bank_debt');
  });

  it('phiếu đã từ chối / huỷ không gắn liên kết; phiếu đang xử lý thì được', () => {
    expect(codeOf(() => assertDocumentLinkable('draft'))).toBe('');
    expect(codeOf(() => assertDocumentLinkable('paid'))).toBe('');
    expect(codeOf(() => assertDocumentLinkable('rejected'))).toBe('FG-WF-005');
    expect(codeOf(() => assertDocumentLinkable('cancelled'))).toBe('FG-WF-005');
  });
});

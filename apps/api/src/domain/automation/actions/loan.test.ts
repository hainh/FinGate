import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveLoanTerms, type LoanTermsInput } from '../policy.ts';

const models = vi.hoisted(() => ({ BankDebt: { findById: vi.fn(), updateOne: vi.fn() } }));

vi.mock('../../../db/models.ts', () => ({ Models: models }));
vi.mock('../../numbering/index.ts', () => ({ nextSequentialCode: vi.fn() }));
vi.mock('../../audit/index.ts', () => ({ buildHistoryEntry: vi.fn((entry: unknown) => entry), mirrorAudit: vi.fn() }));
vi.mock('../../events/index.ts', () => ({ emitDomainEvent: vi.fn() }));

import { changedFieldsOf, syncAutoLoan, termFields } from './loan.ts';

describe('khoản vay tự sinh › số HĐ tín dụng và TSĐB là trường riêng (v2 §10.1, §11.4)', () => {
  it('số HĐ tín dụng và TSĐB được ghi vào trường riêng, không chỉ nằm trong ghi chú', () => {
    const terms = resolveLoanTerms({ terms: { contract_no: ' HDTD-2026-01 ', collateral: 'Nhà 12 Lê Lợi' }, baseDate: '2026-10-22' });
    const fields = termFields(terms);
    expect(fields.contract_no).toBe('HDTD-2026-01');
    expect(fields.collateral).toBe('Nhà 12 Lê Lợi');
  });

  it('không nhập số HĐ / TSĐB thì hai trường là null', () => {
    const fields = termFields(resolveLoanTerms({ terms: null, baseDate: '2026-10-22' }));
    expect(fields.contract_no).toBeNull();
    expect(fields.collateral).toBeNull();
  });
});

describe('khoản vay tự sinh › đồng bộ khi sửa phiếu trước duyệt', () => {
  const stored = {
    partner_id: 'p1',
    bank_name: 'BIDV',
    principal_minor: '50000000',
    contract_no: 'HDTD-1',
    collateral: null,
    interest_rate: '9.5',
    term_months: 12,
    maturity_date: '2027-10-22',
  };

  it('chỉ sửa số HĐ tín dụng vẫn là thay đổi cần đồng bộ (trước đây bị bỏ qua)', () => {
    const changed = changedFieldsOf(stored, { ...stored, contract_no: 'HDTD-2' });
    expect(Object.keys(changed)).toEqual(['contract_no']);
    expect(changed.contract_no).toEqual({ from: 'HDTD-1', to: 'HDTD-2' });
  });

  it('chỉ thêm TSĐB vẫn là thay đổi cần đồng bộ', () => {
    expect(Object.keys(changedFieldsOf(stored, { ...stored, collateral: 'Xe ô tô' }))).toEqual(['collateral']);
  });

  it('không đổi gì, hoặc null và chuỗi rỗng cùng coi là trống ⇒ không có thay đổi', () => {
    expect(changedFieldsOf(stored, { ...stored })).toEqual({});
    expect(changedFieldsOf({ collateral: null }, { collateral: '' })).toEqual({});
  });
});

describe('khoản vay tự sinh › syncAutoLoan: đồng bộ kỳ trả lãi/gốc và phương thức trả nợ (R2-41, R2-42)', () => {
  const actor = { user_id: 'u1', name: 'Nhân viên', role: 'staff' };
  const baseDate = '2026-10-22';
  const termsOf = (input: LoanTermsInput) => resolveLoanTerms({ terms: input, baseDate });

  /** Khoản vay chờ giải ngân đã lưu theo điều khoản ban đầu: hàng tháng, chỉ trả lãi. */
  function storedLoan(status = 'pending_disbursement') {
    return {
      _id: 'loan1',
      code: 'NHD-000001',
      status,
      company_id: 'c1',
      partner_id: 'p1',
      bank_name: 'BIDV',
      principal_minor: 50000000n,
      currency: 'VND',
      ...termFields(termsOf({ repayment_period: 'monthly', repayment_method: 'interest_only' })),
    };
  }

  function sync(input: LoanTermsInput, principalMinor = 50000000n) {
    return syncAutoLoan({ loanId: 'loan1', partnerId: 'p1', bankName: 'BIDV', principalMinor, terms: termsOf(input), requestId: 'req-1', actor });
  }

  /** Lệnh cập nhật khoản vay gửi đi gần nhất (filter, update). */
  function sentUpdate() {
    const calls = models.BankDebt.updateOne.mock.calls;
    const call = calls[calls.length - 1];
    if (!call) throw new Error('chưa có lệnh cập nhật khoản vay');
    return { filter: call[0], update: call[1] };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    models.BankDebt.findById.mockReturnValue({ lean: async () => storedLoan() });
    models.BankDebt.updateOne.mockReturnValue({ exec: async () => ({ modifiedCount: 1 }) });
  });

  it('chỉ đổi phương thức trả nợ gốc ⇒ ghi phương thức mới và có lịch sử auto_sync (trước đây bị bỏ qua)', async () => {
    expect(await sync({ repayment_period: 'monthly', repayment_method: 'equal_principal' })).toBe(true);
    const { filter, update } = sentUpdate();
    expect(filter).toEqual({ _id: 'loan1', status: 'pending_disbursement' });
    expect(update.$set).toMatchObject({ repayment_method: 'equal_principal', payment_frequency: 'monthly' });
    expect(update.$push.history.action).toBe('auto_sync');
    expect(update.$push.history.fields.changed).toEqual({ repayment_method: { from: 'interest_only', to: 'equal_principal' } });
  });

  it('chỉ đổi kỳ trả lãi/gốc ⇒ ghi kỳ trả mới và có lịch sử auto_sync', async () => {
    expect(await sync({ repayment_period: 'quarterly', repayment_method: 'interest_only' })).toBe(true);
    const { update } = sentUpdate();
    expect(update.$set).toMatchObject({ payment_frequency: 'quarterly', repayment_method: 'interest_only' });
    expect(update.$push.history.action).toBe('auto_sync');
    expect(update.$push.history.fields.changed).toEqual({ payment_frequency: { from: 'monthly', to: 'quarterly' } });
  });

  it('đổi gốc cùng lúc với phương thức ⇒ lịch sử ghi đủ cả hai thay đổi', async () => {
    expect(await sync({ repayment_period: 'monthly', repayment_method: 'equal_principal' }, 60000000n)).toBe(true);
    const changed = sentUpdate().update.$push.history.fields.changed;
    expect(Object.keys(changed).sort()).toEqual(['principal_minor', 'repayment_method']);
  });

  it('không đổi điều khoản nào ⇒ không ghi, không có lịch sử', async () => {
    expect(await sync({ repayment_period: 'monthly', repayment_method: 'interest_only' })).toBe(false);
    expect(models.BankDebt.updateOne).not.toHaveBeenCalled();
  });

  it('khoản đã không còn chờ giải ngân ⇒ không đụng tới', async () => {
    models.BankDebt.findById.mockReturnValue({ lean: async () => storedLoan('active') });
    expect(await sync({ repayment_period: 'quarterly', repayment_method: 'equal_principal' })).toBe(false);
    expect(models.BankDebt.updateOne).not.toHaveBeenCalled();
  });
});

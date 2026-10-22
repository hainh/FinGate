/**
 * "Gắn khoản vay đã có" khi LƯU phiếu thu (v2 §11.4 (b)): sức chứa kiểm ngay (FG-LINK-002) và liên kết
 * giải ngân Thủ công được ghi ngay, không phụ thuộc quy tắc R2 đang bật/tắt.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@fingate/shared';
import type { LoanPlan } from './rules.ts';

const m = vi.hoisted(() => ({
  loanRow: null as Record<string, unknown> | null,
  listLinksFor: vi.fn(),
  removeLink: vi.fn(),
  assertLoanDisbursementCapacity: vi.fn(),
  ensureManualLink: vi.fn(),
}));

vi.mock('../../db/models.ts', () => ({
  Models: { BankDebt: { findOne: () => ({ select: () => ({ lean: async () => m.loanRow }) }) } },
}));
vi.mock('../links/index.ts', () => ({
  listLinksFor: m.listLinksFor,
  removeLink: m.removeLink,
  assertLoanDisbursementCapacity: m.assertLoanDisbursementCapacity,
}));
vi.mock('../automation/actions/link.ts', () => ({ ensureManualLink: m.ensureManualLink }));

import { disbursementReleasedByLoanChoice, linkChosenLoanOnSave, resolveLoanPlan } from './refs.ts';

const COMPANY = 'e'.repeat(24);
const BANK = 'c'.repeat(24);
const LOAN = 'a'.repeat(24);
const OTHER_LOAN = '9'.repeat(24);
const DOC = 'b'.repeat(24);
const GENERATED_TARGET = '8'.repeat(24);
const ACTOR = { user_id: 'u1', name: 'Kế toán viên', role: 'staff' };

const borrowPlan = (mode: 'new' | 'existing' | 'later', loanId: string | null = null): LoanPlan =>
  ({ kind: 'borrow', mode, lender_partner_id: BANK, receive_account_id: null, amount_minor: null, existing_loan_id: loanId, terms: null }) as unknown as LoanPlan;

const resolve = (over: Partial<Parameters<typeof resolveLoanPlan>[0]> = {}) =>
  resolveLoanPlan({
    companyId: COMPANY,
    voucherKind: 'income',
    voucherPartnerId: BANK,
    voucherAmountMinor: 10_000_000n,
    loan: { kind: 'borrow', mode: 'existing', lender_partner_id: BANK, existing_loan_id: LOAN },
    previous: null,
    ...over,
  });

describe('resolveLoanPlan — khoản vay có sẵn kiểm sức chứa ngay khi LƯU (FG-LINK-002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.loanRow = { partner_id: BANK, status: 'pending_disbursement' };
    m.assertLoanDisbursementCapacity.mockResolvedValue(undefined);
  });

  it('khoản đã kín sức chứa: chặn ngay khi lưu bằng FG-LINK-002, không chờ quy tắc R2', async () => {
    m.assertLoanDisbursementCapacity.mockRejectedValue(new ApiError({ code: 'FG-LINK-002' }));
    const err = await resolve().catch((e: unknown) => e);
    expect((err as ApiError).code).toBe('FG-LINK-002');
  });

  it('khi sửa phiếu: giải ngân của chính phiếu đó được loại trừ khỏi sức chứa', async () => {
    await resolve({ voucherId: DOC });
    expect(m.assertLoanDisbursementCapacity).toHaveBeenCalledWith({ loanId: LOAN, amountMinor: 10_000_000n, excludeDocumentId: DOC });
  });

  it('lập phiếu mới: không có phiếu nào để loại trừ', async () => {
    await resolve();
    expect(m.assertLoanDisbursementCapacity).toHaveBeenCalledWith({ loanId: LOAN, amountMinor: 10_000_000n, excludeDocumentId: null });
  });

  it('chế độ không phải khoản có sẵn: không kiểm sức chứa khoản vay', async () => {
    await resolve({ loan: { kind: 'borrow', mode: 'later', lender_partner_id: BANK } });
    expect(m.assertLoanDisbursementCapacity).not.toHaveBeenCalled();
  });
});

describe('linkChosenLoanOnSave — gắn khoản đã chọn được ghi NGAY khi lưu, không phụ thuộc R2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.listLinksFor.mockResolvedValue([]);
  });

  it('khoản có sẵn: ghi liên kết giải ngân Thủ công theo số tiền phiếu', async () => {
    await linkChosenLoanOnSave({ documentId: DOC, previous: null, plan: borrowPlan('existing', LOAN), amountMinor: 10_000_000n, actor: ACTOR, requestId: 'req-1' });
    expect(m.ensureManualLink).toHaveBeenCalledWith({
      from: { type: 'document', id: DOC },
      to: { type: 'bank_debt', id: LOAN },
      relation: 'disbursement',
      amountMinor: 10_000_000n,
      actor: ACTOR,
      requestId: 'req-1',
    });
  });

  it('gỡ giải ngân của phiếu tới khoản khác trước khi gắn khoản đã chọn; giữ nguyên liên kết khác', async () => {
    m.listLinksFor.mockResolvedValue([
      { _id: 'l-old', relation: 'disbursement', from_type: 'document', from_id: DOC, to_type: 'bank_debt', to_id: OTHER_LOAN },
      { _id: 'l-same', relation: 'disbursement', from_type: 'document', from_id: DOC, to_type: 'bank_debt', to_id: LOAN },
      { _id: 'l-gen', relation: 'generated', from_type: 'document', from_id: DOC, to_type: 'document', to_id: GENERATED_TARGET },
    ]);
    await linkChosenLoanOnSave({ documentId: DOC, previous: null, plan: borrowPlan('existing', LOAN), amountMinor: 10_000_000n, actor: ACTOR, requestId: null });
    expect(m.removeLink).toHaveBeenCalledTimes(1);
    expect(m.removeLink).toHaveBeenCalledWith(expect.objectContaining({ link_id: 'l-old' }));
  });

  it('để sau / khoản mới / không có kế hoạch vay (lập mới): không ghi gì, để quy tắc R2 xử lý như trước', async () => {
    await linkChosenLoanOnSave({ documentId: DOC, previous: null, plan: borrowPlan('new'), amountMinor: 10_000_000n, actor: ACTOR, requestId: null });
    await linkChosenLoanOnSave({ documentId: DOC, previous: null, plan: null, amountMinor: 10_000_000n, actor: ACTOR, requestId: null });
    expect(m.ensureManualLink).not.toHaveBeenCalled();
    expect(m.removeLink).not.toHaveBeenCalled();
  });

  describe('đổi lựa chọn khi sửa phiếu: gỡ liên kết Thủ công do lựa chọn CŨ tạo ra (R2-20/21/22)', () => {
    const manualToOld = { _id: 'l-manual', relation: 'disbursement', origin: 'manual', from_type: 'document', from_id: DOC, to_type: 'bank_debt', to_id: LOAN };
    const linkedFromTab = { _id: 'l-tab', relation: 'disbursement', origin: 'manual', from_type: 'document', from_id: DOC, to_type: 'bank_debt', to_id: OTHER_LOAN };
    const autoToNew = { _id: 'l-auto', relation: 'disbursement', origin: 'automation', from_type: 'document', from_id: DOC, to_type: 'bank_debt', to_id: GENERATED_TARGET };

    it('vay có sẵn → vay mới: gỡ liên kết Thủ công tới khoản cũ, không ghi liên kết mới', async () => {
      m.listLinksFor.mockResolvedValue([manualToOld]);
      await linkChosenLoanOnSave({ documentId: DOC, previous: storedExisting(LOAN), plan: borrowPlan('new'), amountMinor: 5_000_000n, actor: ACTOR, requestId: null });
      expect(m.removeLink).toHaveBeenCalledTimes(1);
      expect(m.removeLink).toHaveBeenCalledWith(expect.objectContaining({ link_id: 'l-manual' }));
      expect(m.ensureManualLink).not.toHaveBeenCalled();
    });

    it('vay có sẵn → để sau hoặc bỏ cờ vay: gỡ liên kết Thủ công tới khoản cũ', async () => {
      m.listLinksFor.mockResolvedValue([manualToOld]);
      await linkChosenLoanOnSave({ documentId: DOC, previous: storedExisting(LOAN), plan: borrowPlan('later'), amountMinor: 5_000_000n, actor: ACTOR, requestId: null });
      await linkChosenLoanOnSave({ documentId: DOC, previous: storedExisting(LOAN), plan: null, amountMinor: 5_000_000n, actor: ACTOR, requestId: null });
      expect(m.removeLink).toHaveBeenCalledTimes(2);
      expect(m.ensureManualLink).not.toHaveBeenCalled();
    });

    it('để sau giữ nguyên liên kết gán tay từ tab Liên kết (không do lựa chọn cũ tạo ra)', async () => {
      m.listLinksFor.mockResolvedValue([linkedFromTab]);
      await linkChosenLoanOnSave({ documentId: DOC, previous: borrowPlan('later'), plan: borrowPlan('later'), amountMinor: 5_000_000n, actor: ACTOR, requestId: null });
      expect(m.removeLink).not.toHaveBeenCalled();
    });

    it('vay có sẵn M → vẫn M: không gỡ liên kết tới M, chỉ đồng bộ lại số tiền', async () => {
      m.listLinksFor.mockResolvedValue([manualToOld]);
      await linkChosenLoanOnSave({ documentId: DOC, previous: storedExisting(LOAN), plan: borrowPlan('existing', LOAN), amountMinor: 4_000_000n, actor: ACTOR, requestId: null });
      expect(m.removeLink).not.toHaveBeenCalled();
      expect(m.ensureManualLink).toHaveBeenCalledWith(expect.objectContaining({ to: { type: 'bank_debt', id: LOAN }, amountMinor: 4_000_000n }));
    });

    it('giải ngân tự động của R2 không bị gỡ ở bước lưu (R2 tự gỡ theo quy tắc riêng khi đổi chế độ)', async () => {
      m.listLinksFor.mockResolvedValue([autoToNew]);
      await linkChosenLoanOnSave({ documentId: DOC, previous: storedExisting(LOAN), plan: borrowPlan('new'), amountMinor: 5_000_000n, actor: ACTOR, requestId: null });
      expect(m.removeLink).not.toHaveBeenCalled();
    });
  });
});

describe('disbursementReleasedByLoanChoice — liên kết giải ngân mà lần lưu đổi lựa chọn khoản vay sẽ gỡ (đổi đối tác + chọn khoản mới trong một lần lưu)', () => {
  const manualTo = (loanId: string) => ({ relation: 'disbursement' as const, to_type: 'bank_debt' as const, to_id: loanId, origin: 'manual' as const });

  it('chọn khoản có sẵn KHÁC ⇒ gỡ giải ngân tới khoản cũ (kể cả khoản do người dùng gán từ tab Liên kết)', () => {
    expect(disbursementReleasedByLoanChoice(manualTo(LOAN), storedExisting(LOAN), borrowPlan('existing', OTHER_LOAN))).toBe(true);
    expect(disbursementReleasedByLoanChoice({ ...manualTo(LOAN), origin: 'manual' }, null, borrowPlan('existing', OTHER_LOAN))).toBe(true);
  });

  it('không chọn khoản nữa (để sau / vay mới / bỏ cờ vay) ⇒ chỉ gỡ liên kết Thủ công tới khoản ĐÃ CHỌN trước đó', () => {
    expect(disbursementReleasedByLoanChoice(manualTo(LOAN), storedExisting(LOAN), borrowPlan('later'))).toBe(true);
    expect(disbursementReleasedByLoanChoice(manualTo(OTHER_LOAN), storedExisting(LOAN), borrowPlan('later'))).toBe(false);
  });

  it('chọn đúng khoản đang gắn ⇒ không gỡ; liên kết không phải giải ngân / không tới khoản vay ⇒ không gỡ', () => {
    expect(disbursementReleasedByLoanChoice(manualTo(LOAN), storedExisting(LOAN), borrowPlan('existing', LOAN))).toBe(false);
    expect(disbursementReleasedByLoanChoice({ ...manualTo(LOAN), relation: 'repayment' }, storedExisting(LOAN), borrowPlan('existing', OTHER_LOAN))).toBe(false);
    expect(disbursementReleasedByLoanChoice({ ...manualTo(LOAN), to_type: 'debt_voucher' }, storedExisting(LOAN), borrowPlan('existing', OTHER_LOAN))).toBe(false);
  });
});

/** Kế hoạch đã lưu "gắn khoản vay có sẵn" (dạng đọc từ phiếu). */
function storedExisting(loanId: string): LoanPlan {
  return borrowPlan('existing', loanId);
}

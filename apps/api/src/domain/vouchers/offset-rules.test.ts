import { describe, expect, it } from 'vitest';
import { ApiError } from '@fingate/shared';
import {
  effectiveOffsetAmount,
  offsetLinkSpecOf,
  offsetRelationOf,
  planOffsetOptions,
  planToOffsetInput,
  planToStoredOffset,
  sameOffsetPlan,
  storedOffsetToPlan,
  type OffsetPlan,
} from './rules.ts';

const LOAN = 'f'.repeat(24);
const DEBT = '2'.repeat(24);
const PARTNER = 'd'.repeat(24);
const VOUCHER = 100_000_000n;

const spendCtx = { voucherKind: 'spend' as const, voucherPartnerId: PARTNER, voucherAmountMinor: VOUCHER };

/** Lỗi ApiError của một hàm ('' nếu không ném) — kèm khoá field lỗi đầu tiên để kiểm đúng ô trên form. */
function errorOf(fn: () => unknown): { code: string; field: string } | null {
  try {
    fn();
    return null;
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    return { code: err.code, field: Object.keys(err.errors ?? {})[0] ?? '' };
  }
}

describe('cấn trừ khoản vay › kiểm khi lưu (planOffsetOptions)', () => {
  it('không có cấn trừ ⇒ null', () => {
    expect(planOffsetOptions(null, spendCtx)).toBeNull();
    expect(planOffsetOptions(undefined, spendCtx)).toBeNull();
  });

  it('phiếu thu chỉ cấn trừ khoản phải thu (công nợ), không cấn trừ khoản vay ngân hàng', () => {
    const incomeCtx = { ...spendCtx, voucherKind: 'income' as const };
    const err = errorOf(() => planOffsetOptions({ target: 'bank_debt', target_id: LOAN }, incomeCtx));
    expect(err).toEqual({ code: 'FG-VAL-001', field: 'options.offset.target' });
    expect(planOffsetOptions({ target: 'debt_voucher', target_id: DEBT }, incomeCtx)).toEqual({
      target: 'debt_voucher',
      target_id: DEBT,
      amount_minor: null,
      interest_minor: null,
      fee_minor: null,
    });
  });

  it('phiếu thu không tách lãi / phí (công nợ không tách) và không cấn trừ quá số tiền phiếu', () => {
    const incomeCtx = { ...spendCtx, voucherKind: 'income' as const };
    expect(errorOf(() => planOffsetOptions({ target: 'debt_voucher', target_id: DEBT, fee_minor: '1000' }, incomeCtx))).toEqual({
      code: 'FG-VAL-001',
      field: 'options.offset.interest_minor',
    });
    expect(errorOf(() => planOffsetOptions({ target: 'debt_voucher', target_id: DEBT, amount_minor: (VOUCHER + 1n).toString() }, incomeCtx))).toEqual({
      code: 'FG-VAL-001',
      field: 'options.offset.amount_minor',
    });
  });

  it('phiếu thu đi vay không cấn trừ khoản phải thu cùng lúc (gốc khoản vay = số tiền phiếu)', () => {
    const err = errorOf(() =>
      planOffsetOptions({ target: 'debt_voucher', target_id: DEBT }, { ...spendCtx, voucherKind: 'income', voucherLoanKind: 'borrow' }),
    );
    expect(err).toEqual({ code: 'FG-VAL-001', field: 'options.offset.target' });
  });

  it('phiếu chi vẫn cấn trừ được cả khoản vay ngân hàng và công nợ phải trả', () => {
    expect(planOffsetOptions({ target: 'bank_debt', target_id: LOAN }, spendCtx)?.target).toBe('bank_debt');
    expect(planOffsetOptions({ target: 'debt_voucher', target_id: DEBT }, spendCtx)?.target).toBe('debt_voucher');
  });

  it('vay ngân hàng để chi không cấn trừ khoản vay cùng lúc (hai nghiệp vụ trái nhau)', () => {
    const err = errorOf(() => planOffsetOptions({ target: 'bank_debt', target_id: LOAN }, { ...spendCtx, voucherLoanKind: 'fund' }));
    expect(err).toEqual({ code: 'FG-VAL-001', field: 'options.offset.target' });
  });

  it('phiếu chưa có đối tác ⇒ chặn; khoản không hợp lệ ⇒ chặn đúng ô target_id', () => {
    expect(errorOf(() => planOffsetOptions({ target: 'bank_debt', target_id: LOAN }, { ...spendCtx, voucherPartnerId: null }))).toEqual({
      code: 'FG-VAL-001',
      field: 'options.offset.target_id',
    });
    expect(errorOf(() => planOffsetOptions({ target: 'debt_voucher', target_id: 'khong-hop-le' }, spendCtx))).toEqual({
      code: 'FG-VAL-001',
      field: 'options.offset.target_id',
    });
  });

  it('số tiền cấn trừ phải > 0 và không vượt số tiền phiếu', () => {
    const f = (amount: string) => errorOf(() => planOffsetOptions({ target: 'debt_voucher', target_id: DEBT, amount_minor: amount }, spendCtx));
    expect(f('0')).toEqual({ code: 'FG-VAL-001', field: 'options.offset.amount_minor' });
    expect(f((VOUCHER + 1n).toString())).toEqual({ code: 'FG-VAL-001', field: 'options.offset.amount_minor' });
  });

  it('số tiền đúng bằng số tiền phiếu ⇒ lưu null (theo phiếu khi duyệt); số tiền riêng ⇒ lưu đúng', () => {
    expect(planOffsetOptions({ target: 'debt_voucher', target_id: DEBT, amount_minor: VOUCHER.toString() }, spendCtx)?.amount_minor).toBeNull();
    expect(planOffsetOptions({ target: 'debt_voucher', target_id: DEBT, amount_minor: '40000000' }, spendCtx)?.amount_minor).toBe(40_000_000n);
    expect(planOffsetOptions({ target: 'debt_voucher', target_id: DEBT }, spendCtx)?.amount_minor).toBeNull();
  });

  it('công nợ không được tách lãi / phí; khoản vay ngân hàng thì được', () => {
    expect(errorOf(() => planOffsetOptions({ target: 'debt_voucher', target_id: DEBT, interest_minor: '1000' }, spendCtx))).toEqual({
      code: 'FG-VAL-001',
      field: 'options.offset.interest_minor',
    });
    const plan = planOffsetOptions({ target: 'bank_debt', target_id: LOAN, interest_minor: '2000000', fee_minor: '0' }, spendCtx);
    expect(plan).toMatchObject({ target: 'bank_debt', interest_minor: 2_000_000n, fee_minor: null });
  });

  it('lãi + phí không được vượt số tiền cấn trừ', () => {
    const err = errorOf(() =>
      planOffsetOptions({ target: 'bank_debt', target_id: LOAN, amount_minor: '50000000', interest_minor: '40000000', fee_minor: '20000000' }, spendCtx),
    );
    expect(err).toEqual({ code: 'FG-VAL-001', field: 'options.offset.interest_minor' });
  });
});

describe('cấn trừ khoản vay › quan hệ & đặc tả liên kết khi duyệt (offsetLinkSpecOf)', () => {
  it('khoản vay ngân hàng ⇒ trả nợ (repayment), gốc = số tiền − lãi − phí', () => {
    const plan: OffsetPlan = { target: 'bank_debt', target_id: LOAN, amount_minor: null, interest_minor: 2_000_000n, fee_minor: 500_000n };
    expect(offsetRelationOf('bank_debt')).toBe('repayment');
    expect(offsetLinkSpecOf(plan, VOUCHER)).toEqual({
      relation: 'repayment',
      to_type: 'bank_debt',
      to_id: LOAN,
      amount_minor: VOUCHER,
      split: { principal: 97_500_000n, interest: 2_000_000n, fee: 500_000n },
    });
  });

  it('khoản vay ngân hàng không tách ⇒ toàn bộ là gốc', () => {
    const plan: OffsetPlan = { target: 'bank_debt', target_id: LOAN, amount_minor: 30_000_000n, interest_minor: null, fee_minor: null };
    expect(offsetLinkSpecOf(plan, VOUCHER)).toMatchObject({ amount_minor: 30_000_000n, split: { principal: 30_000_000n, interest: 0n, fee: 0n } });
  });

  it('công nợ ⇒ cấn trừ (offset), không tách; số tiền theo phiếu khi để trống', () => {
    const plan: OffsetPlan = { target: 'debt_voucher', target_id: DEBT, amount_minor: null, interest_minor: null, fee_minor: null };
    expect(offsetRelationOf('debt_voucher')).toBe('offset');
    expect(offsetLinkSpecOf(plan, VOUCHER)).toEqual({ relation: 'offset', to_type: 'debt_voucher', to_id: DEBT, amount_minor: VOUCHER, split: null });
  });

  it('số tiền phiếu hạ sau khi kiểm (cấp duyệt) làm lãi + phí vượt ⇒ lỗi rõ ràng, không tạo tách sai', () => {
    const plan: OffsetPlan = { target: 'bank_debt', target_id: LOAN, amount_minor: null, interest_minor: 60_000_000n, fee_minor: null };
    expect(() => offsetLinkSpecOf(plan, 50_000_000n)).toThrow(ApiError);
  });

  it('số tiền cấn trừ hiệu lực: đã ghi, hoặc số tiền phiếu hiện tại', () => {
    expect(effectiveOffsetAmount({ amount_minor: null }, VOUCHER)).toBe(VOUCHER);
    expect(effectiveOffsetAmount({ amount_minor: 1n }, VOUCHER)).toBe(1n);
  });
});

describe('cấn trừ khoản vay › lưu trữ & đổi cấn trừ', () => {
  const bankPlan: OffsetPlan = { target: 'bank_debt', target_id: LOAN, amount_minor: 40_000_000n, interest_minor: 1_000_000n, fee_minor: null };

  it('lưu rồi đọc lại ra đúng kế hoạch (BigInt giữ nguyên, null giữ null)', () => {
    const stored = planToStoredOffset(bankPlan) as Record<string, unknown>;
    expect(storedOffsetToPlan(stored)).toEqual(bankPlan);
    expect(storedOffsetToPlan(null)).toBeNull();
    expect(storedOffsetToPlan({ target: null, target_id: LOAN })).toBeNull();
    expect(planToStoredOffset(null)).toBeNull();
  });

  it('kế hoạch đã lưu → đầu vào → kiểm lại ra cùng kế hoạch', () => {
    const replanned = planOffsetOptions(planToOffsetInput(bankPlan), spendCtx);
    expect(replanned).toEqual(bankPlan);
  });

  it('sameOffsetPlan: cùng khoản và số tiền hiệu lực ⇒ không đổi; khác khoản / lãi / số tiền ⇒ đổi', () => {
    expect(sameOffsetPlan(bankPlan, VOUCHER, { ...bankPlan }, VOUCHER)).toBe(true);
    expect(sameOffsetPlan(null, VOUCHER, null, VOUCHER)).toBe(true);
    expect(sameOffsetPlan(null, VOUCHER, bankPlan, VOUCHER)).toBe(false);
    expect(sameOffsetPlan(bankPlan, VOUCHER, { ...bankPlan, target_id: DEBT }, VOUCHER)).toBe(false);
    expect(sameOffsetPlan(bankPlan, VOUCHER, { ...bankPlan, interest_minor: null }, VOUCHER)).toBe(false);
    // theo phiếu (amount null): số tiền phiếu đổi ⇒ số tiền cấn trừ đổi theo
    const follow: OffsetPlan = { target: 'debt_voucher', target_id: DEBT, amount_minor: null, interest_minor: null, fee_minor: null };
    expect(sameOffsetPlan(follow, VOUCHER, follow, VOUCHER / 2n)).toBe(false);
  });
});

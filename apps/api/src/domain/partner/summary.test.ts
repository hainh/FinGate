import { describe, expect, it } from 'vitest';
import { ApiError } from '@fingate/shared';
import {
  defaultPeriod,
  inPeriod,
  numbersOf,
  overdueDaysOf,
  paidTotalsInPeriod,
  resolveDebtDirection,
  resolvePeriod,
  type DebtView,
  type LoanView,
  type PaidDocView,
  type PartnerLedger,
  availableOf,
  summaryVisibilityOf,
} from './summary.ts';

const TODAY = '2026-10-21';
const PERIOD = { from: '2026-10-01', to: '2026-10-21' };

function debt(over: Partial<DebtView>): DebtView {
  return {
    _id: 'd',
    code: 'CN-1',
    company_id: 'c1',
    partner_id: 'p1',
    direction: 'receivable',
    account_code: '131',
    side: 'debit',
    contract_code: null,
    priority: null,
    value: 1000n,
    applied: 0n,
    remaining: 1000n,
    available: 1000n,
    due_date: '2026-12-31',
    overdue_days: 0,
    ...over,
  };
}

function loan(over: Partial<LoanView>): LoanView {
  return {
    _id: 'l',
    code: 'NHD-1',
    company_id: 'c1',
    partner_id: 'bank1',
    status: 'active',
    principal: 1000n,
    repaid: 0n,
    outstanding: 1000n,
    available_principal: 1000n,
    maturity_date: '2027-03-01',
    disbursed_at: null,
    interest_rate: null,
    term_months: 12,
    repayment_method: null,
    payment_frequency: null,
    ...over,
  };
}

function ledger(over: Partial<PartnerLedger> = {}): PartnerLedger {
  return { debts: [], loans: [], paid: [], has_activity: false, ...over };
}

describe('hướng công nợ và quá hạn', () => {
  it('hướng mới được giữ nguyên; dữ liệu v1 (null) suy theo side như migrate M3b', () => {
    expect(resolveDebtDirection('payable', 'debit')).toBe('payable');
    expect(resolveDebtDirection(null, 'debit')).toBe('receivable');
    expect(resolveDebtDirection(undefined, 'credit')).toBe('payable');
  });

  it('số ngày quá hạn: chưa tới hạn hoặc đúng hạn là 0; quá hạn tính theo ngày', () => {
    expect(overdueDaysOf('2026-10-21', TODAY)).toBe(0);
    expect(overdueDaysOf('2026-11-01', TODAY)).toBe(0);
    expect(overdueDaysOf('2026-10-16', TODAY)).toBe(5);
    expect(overdueDaysOf('', TODAY)).toBe(0);
  });
});

describe('kỳ thu/chi', () => {
  it('mặc định: ngày 1 tháng hiện tại tới hôm nay', () => {
    expect(defaultPeriod(TODAY)).toEqual(PERIOD);
  });

  it('thiếu đầu kỳ / cuối kỳ được điền mặc định; đầu sau cuối ⇒ FG-VAL-001', () => {
    expect(resolvePeriod(null, null, TODAY)).toEqual(PERIOD);
    expect(resolvePeriod('2026-09-01', null, TODAY)).toEqual({ from: '2026-09-01', to: TODAY });
    expect(resolvePeriod(null, '2026-10-05', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    let caught: ApiError | null = null;
    try {
      resolvePeriod('2026-10-10', '2026-10-01', TODAY);
    } catch (err) {
      caught = err as ApiError;
    }
    expect(caught?.code).toBe('FG-VAL-001');
  });

  it('inPeriod gồm cả hai đầu mút, bỏ qua ngày rỗng', () => {
    expect(inPeriod('2026-10-01', PERIOD)).toBe(true);
    expect(inPeriod('2026-10-21', PERIOD)).toBe(true);
    expect(inPeriod('2026-10-22', PERIOD)).toBe(false);
    expect(inPeriod('2026-09-30', PERIOD)).toBe(false);
    expect(inPeriod(null, PERIOD)).toBe(false);
  });
});

describe('numbersOf — KH / NCC', () => {
  it('còn phải thu, còn phải trả, quá hạn (chỉ khoản còn dư và đã qua hạn)', () => {
    const l = ledger({
      debts: [
        debt({ _id: 'r1', direction: 'receivable', remaining: 700n, due_date: '2026-10-10' }), // quá hạn
        debt({ _id: 'r2', direction: 'receivable', remaining: 300n, due_date: '2026-12-31' }), // chưa tới hạn
        debt({ _id: 'r3', direction: 'receivable', remaining: 0n, due_date: '2026-01-01' }), // đã thu đủ
        debt({ _id: 'p1', direction: 'payable', remaining: 450n, due_date: '2026-10-21' }), // đúng hạn hôm nay ⇒ chưa quá hạn
      ],
    });
    const n = numbersOf('customer', l, PERIOD, TODAY);
    expect(n.receivable_remaining).toBe(1000n);
    expect(n.payable_remaining).toBe(450n);
    expect(n.overdue_amount).toBe(700n);
    expect(n.outstanding).toBeNull();
    expect(n.next_maturity_date).toBeNull();
  });

  it('thu / chi đã thực thi trong kỳ: tính theo ngày thực thi, loại trừ ngoài kỳ', () => {
    const paid: PaidDocView[] = [
      { _id: 'i1', code: 'PT-1', kind: 'income', status: 'paid', company_id: 'c1', partner_id: 'p1', business_date: '2026-10-03', flows: [{ at: '2026-10-03', amount: 500n }] },
      { _id: 'i2', code: 'PT-2', kind: 'income', status: 'paid', company_id: 'c1', partner_id: 'p1', business_date: '2026-09-20', flows: [{ at: '2026-09-20', amount: 999n }] },
      { _id: 's1', code: 'PC-1', kind: 'spend', status: 'paid', company_id: 'c1', partner_id: 'p1', business_date: '2026-10-10', flows: [{ at: '2026-10-10', amount: 200n }] },
    ];
    const n = numbersOf('supplier', ledger({ paid }), PERIOD, TODAY);
    expect(n.paid_in_period).toBe(500n);
    expect(n.paid_out_period).toBe(200n);
  });
});

describe('numbersOf — Ngân hàng', () => {
  it('dư nợ = Σ dư nợ khoản còn lại; đáo hạn gần nhất = hạn sớm nhất của khoản còn dư nợ', () => {
    const l = ledger({
      loans: [
        loan({ _id: 'a', outstanding: 400n, maturity_date: '2027-06-30' }),
        loan({ _id: 'b', outstanding: 600n, maturity_date: '2026-12-15' }),
        loan({ _id: 'c', outstanding: 0n, maturity_date: '2026-10-25', status: 'settled' }), // đã tất toán: không tính
      ],
    });
    const n = numbersOf('bank', l, PERIOD, TODAY);
    expect(n.outstanding).toBe(1000n);
    expect(n.next_maturity_date).toBe('2026-12-15');
    expect(n.receivable_remaining).toBeNull();
    expect(n.payable_remaining).toBeNull();
    expect(n.overdue_amount).toBeNull();
  });

  it('không còn dư nợ ⇒ không có ngày đáo hạn', () => {
    const n = numbersOf('bank', ledger({ loans: [loan({ outstanding: 0n })] }), PERIOD, TODAY);
    expect(n.outstanding).toBe(0n);
    expect(n.next_maturity_date).toBeNull();
  });

  it('has_activity đi theo ledger', () => {
    expect(numbersOf('bank', ledger({ has_activity: true }), PERIOD, TODAY).has_activity).toBe(true);
    expect(numbersOf('bank', ledger(), PERIOD, TODAY).has_activity).toBe(false);
  });
});

describe('paidTotalsInPeriod — kỳ chi từng phần', () => {
  it('phiếu có nhiều kỳ chi: chỉ cộng các kỳ nằm trong kỳ tính', () => {
    const paid: PaidDocView[] = [
      {
        _id: 's2',
        code: 'PC-9',
        kind: 'spend',
        status: 'approved',
        company_id: 'c1',
        partner_id: 'p1',
        business_date: '2026-09-28',
        flows: [
          { at: '2026-09-28', amount: 100n }, // ngoài kỳ
          { at: '2026-10-02', amount: 250n },
          { at: '2026-10-15', amount: 50n },
        ],
      },
    ];
    expect(paidTotalsInPeriod(paid, PERIOD)).toEqual({ in: 0n, out: 300n });
  });
});

describe('quyền xem số liệu (v2 §3.2) và "còn có thể trả"', () => {
  it('thiếu quyền ⇒ nhóm số liệu tương ứng không hiển thị', () => {
    expect(summaryVisibilityOf(['partner:read'])).toEqual({ debt: false, loan: false, cash: false });
    expect(summaryVisibilityOf(['partner:read', 'debt:read'])).toEqual({ debt: true, loan: false, cash: false });
    expect(summaryVisibilityOf(['partner:read', 'bank:read'])).toEqual({ debt: false, loan: true, cash: false });
    expect(summaryVisibilityOf(['partner:read', 'loan:read', 'doc:read'])).toEqual({ debt: false, loan: true, cash: true });
  });

  it('còn có thể trả = giá trị − đã giữ chỗ, không âm', () => {
    expect(availableOf(1000n, 300n)).toBe(700n);
    expect(availableOf(1000n, 1000n)).toBe(0n);
    expect(availableOf(1000n, 1200n)).toBe(0n);
  });
});

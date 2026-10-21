/**
 * Hàm thuần của công nợ / nợ ngân hàng (app/v2/debts.ts): không gọi server, không React.
 */

import { describe, expect, it } from 'vitest';
import {
  accountCodeOf,
  bankTotalsOf,
  canAssignDisbursement,
  canAssignRepayment,
  canCancelLoan,
  directionFromSide,
  hasDeadOffsetLink,
  historyRowsOf,
  minorOf,
  newRequestId,
  originLabel,
  parseDirection,
  principalOfSplit,
  voucherHref,
  type LoanRow,
} from './debts.ts';

/** Dòng khoản vay tối thiểu cho hàm thuần (chỉ các trường hàm đọc). */
function loanRow(p: Partial<LoanRow> & { _id: string }): LoanRow {
  return {
    company_id: 'c1',
    company_name: 'Công ty A',
    code: `NHD-${p._id}`,
    partner_id: 'bank-1',
    partner: null,
    bank_name: 'BIDV',
    credit_limit: { minor: '0', currency: 'VND', decimals: 0 },
    principal: { minor: '100', currency: 'VND', decimals: 0 },
    outstanding: { minor: '100', currency: 'VND', decimals: 0 },
    repaid: { minor: '0', currency: 'VND', decimals: 0 },
    repaid_interest: { minor: '0', currency: 'VND', decimals: 0 },
    repaid_fee: { minor: '0', currency: 'VND', decimals: 0 },
    disbursed: { minor: '100', currency: 'VND', decimals: 0 },
    disbursement_planned: { minor: '0', currency: 'VND', decimals: 0 },
    undisbursed: { minor: '0', currency: 'VND', decimals: 0 },
    funded_by_total: { minor: '0', currency: 'VND', decimals: 0 },
    currency: 'VND',
    interest_rate: '9',
    term_months: 12,
    payment_frequency: 'maturity',
    repayment_method: 'interest_only',
    interest_to_maturity: { minor: '0', currency: 'VND', decimals: 0 },
    maturity_date: '2027-01-01',
    next_due_date: null,
    days_to_due: 100,
    status: 'active',
    warning: null,
    contract_no: null,
    collateral: null,
    responsible: null,
    disbursed_at: null,
    origin: { kind: 'manual', run_id: null, rule_code: null },
    repayment_count: 0,
    attachment_count: 0,
    note: null,
    created_at: null,
    updated_at: null,
    ...p,
  } as LoanRow;
}

describe('công nợ — hàm thuần', () => {
  it('minorOf đọc số tiền minor từ chuỗi hoặc số; sai định dạng hoặc thiếu ⇒ 0', () => {
    expect(minorOf({ minor: '1500000' })).toBe(1500000n);
    expect(minorOf({ minor: 42 })).toBe(42n);
    expect(minorOf({ minor: 'abc' })).toBe(0n);
    expect(minorOf(null)).toBe(0n);
    expect(minorOf(undefined)).toBe(0n);
  });

  it('principalOfSplit: gốc = tổng − lãi − phí; âm hoặc tổng ≤ 0 ⇒ null', () => {
    expect(principalOfSplit(1000n, 100n, 50n)).toBe(850n);
    expect(principalOfSplit(1000n, 0n, 0n)).toBe(1000n);
    expect(principalOfSplit(100n, 80n, 30n)).toBeNull();
    expect(principalOfSplit(0n, 0n, 0n)).toBeNull();
    expect(principalOfSplit(100n, -1n, 0n)).toBeNull();
  });

  it('hướng: tham số URL và `side` v1 quy về phải thu / phải trả', () => {
    expect(parseDirection('payable')).toBe('payable');
    expect(parseDirection('khac')).toBeUndefined();
    expect(parseDirection(null)).toBeUndefined();
    expect(directionFromSide('credit')).toBe('payable');
    expect(directionFromSide('debit')).toBe('receivable');
    expect(directionFromSide(null)).toBe('receivable');
  });

  it('TK kế toán theo loại đối tác: KH 131, NCC 331, khác ⇒ null', () => {
    expect(accountCodeOf('customer')).toBe('131');
    expect(accountCodeOf('supplier')).toBe('331');
    expect(accountCodeOf('employee')).toBeNull();
    expect(accountCodeOf(null)).toBeNull();
  });
});

describe('nợ ngân hàng — thao tác theo trạng thái', () => {
  it('gán giải ngân: chờ giải ngân / đang vay / quá hạn; không cho đã huỷ, lưu trữ, tất toán', () => {
    expect(canAssignDisbursement('pending_disbursement')).toBe(true);
    expect(canAssignDisbursement('active')).toBe(true);
    expect(canAssignDisbursement('overdue')).toBe(true);
    expect(canAssignDisbursement('cancelled')).toBe(false);
    expect(canAssignDisbursement('archived')).toBe(false);
    expect(canAssignDisbursement('settled')).toBe(false);
  });

  it('gán trả nợ chỉ khi đang vay / quá hạn; huỷ chỉ khi chờ giải ngân', () => {
    expect(canAssignRepayment('active')).toBe(true);
    expect(canAssignRepayment('overdue')).toBe(true);
    expect(canAssignRepayment('pending_disbursement')).toBe(false);
    expect(canCancelLoan('pending_disbursement')).toBe(true);
    expect(canCancelLoan('active')).toBe(false);
  });
});

describe('đường dẫn chứng từ và nhãn nguồn', () => {
  it('voucherHref theo loại chứng từ (khớp /ho-so/:loai/:id)', () => {
    expect(voucherHref('income', 'a1')).toBe('/ho-so/thu/a1');
    expect(voucherHref('spend', 'a1')).toBe('/ho-so/chi/a1');
    expect(voucherHref('rollover', 'a1')).toBe('/ho-so/dao-han/a1');
    expect(voucherHref('internal', 'a1')).toBe('/ho-so/noi-bo/a1');
  });

  it('originLabel: tự động kèm mã quy tắc; thủ công', () => {
    expect(originLabel({ kind: 'automation', rule_code: 'R2' })).toBe('Tự động · R2');
    expect(originLabel({ kind: 'automation', rule_code: null })).toBe('Tự động');
    expect(originLabel({ kind: 'manual', rule_code: null })).toBe('Thủ công');
    expect(originLabel(null)).toBe('Thủ công');
  });
});

describe('công nợ — tổng theo ngân hàng, lịch sử, chống gửi lặp', () => {
  it('bankTotalsOf: chỉ khoản đang vay / quá hạn; dư nợ đáo hạn ≤ 7 và ≤ 30 ngày (gồm quá hạn); sắp theo dư nợ', () => {
    const rows = bankTotalsOf([
      loanRow({ _id: 'a', partner_id: 'bidv', bank_name: 'BIDV', outstanding: { minor: '100', currency: 'VND', decimals: 0 }, days_to_due: 5 }),
      loanRow({ _id: 'b', partner_id: 'bidv', bank_name: 'BIDV', outstanding: { minor: '50', currency: 'VND', decimals: 0 }, days_to_due: 20 }),
      loanRow({ _id: 'c', partner_id: 'vcb', bank_name: 'VCB', outstanding: { minor: '300', currency: 'VND', decimals: 0 }, days_to_due: -3, status: 'overdue' }),
      loanRow({ _id: 'd', partner_id: 'vcb', status: 'pending_disbursement', outstanding: { minor: '999', currency: 'VND', decimals: 0 } }),
    ]);
    expect(rows.map((r) => r.bank_name)).toEqual(['VCB', 'BIDV']);
    expect(rows[0]).toMatchObject({ count: 1, outstanding: 300n, due7: 300n, due30: 300n });
    expect(rows[1]).toMatchObject({ count: 2, outstanding: 150n, due7: 100n, due30: 150n });
  });

  it('historyRowsOf: đọc fields.changes trước → sau, người thực hiện, nhãn tiếng Việt', () => {
    const rows = historyRowsOf([
      {
        at: '2026-10-01T03:00:00.000Z',
        action: 'update',
        actor: { name: 'Kế toán A' },
        ip: '10.0.0.5',
        fields: { changes: { maturity_date: { from: '2027-01-01', to: '2028-01-01' }, principal_minor: { from: '100', to: '120' } } },
      },
      { at: '2026-09-01T03:00:00.000Z', action: 'create', actor: null, fields: null },
    ]);
    expect(rows[0].actor).toBe('Kế toán A');
    expect(rows[0].ip).toBe('10.0.0.5');
    expect(rows[0].changes).toEqual([
      { field: 'maturity_date', label: 'Hạn thanh toán (đáo hạn)', from: '2027-01-01', to: '2028-01-01' },
      { field: 'principal_minor', label: 'Gốc', from: '100', to: '120' },
    ]);
    expect(rows[1]).toMatchObject({ actor: 'Hệ thống', changes: [] });
  });

  it('hasDeadOffsetLink: phát hiện liên kết tới phiếu đã huỷ / từ chối / hết hạn', () => {
    expect(hasDeadOffsetLink([{ document_status: 'paid' }, { document_status: 'approved' }])).toBe(false);
    expect(hasDeadOffsetLink([{ document_status: 'paid' }, { document_status: 'cancelled' }])).toBe(true);
  });

  it('newRequestId: mã đủ dài (≥ 8 ký tự) và khác nhau giữa các lần gọi', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a).not.toBe(b);
  });
});

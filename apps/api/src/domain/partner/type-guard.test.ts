import { describe, expect, it } from 'vitest';
import { ApiError, type PartnerType } from '@fingate/shared';
import { EMPTY_TYPE_USAGE, assertPartnerTypeChange, partnerTypeBlockers, type PartnerTypeUsage } from './type-guard.ts';

const none: PartnerTypeUsage = { ...EMPTY_TYPE_USAGE };

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.code : 'unknown';
  }
}

describe('partnerTypeBlockers — ràng buộc khi đổi loại (v2 §5.1)', () => {
  it('không đổi loại ⇒ không có lý do chặn, dù đang có phụ thuộc', () => {
    const busy: PartnerTypeUsage = { bank_debts: 2, debt_vouchers: 3, lender_documents: 1, bank_relation_documents: 1 };
    expect(partnerTypeBlockers('bank', 'bank', busy)).toEqual([]);
    expect(partnerTypeBlockers('customer', 'customer', busy)).toEqual([]);
  });

  it('đối tác đang có khoản nợ ngân hàng KHÔNG đổi sang Khách hàng / Nhà cung cấp', () => {
    const toCustomer = partnerTypeBlockers('bank', 'customer', { ...none, bank_debts: 1 });
    const toSupplier = partnerTypeBlockers('bank', 'supplier', { ...none, bank_debts: 1 });
    expect(toCustomer.join(' ')).toContain('khoản nợ ngân hàng');
    expect(toSupplier.join(' ')).toContain('khoản nợ ngân hàng');
  });

  it('đối tác không có khoản nợ NH thì đổi được khỏi Ngân hàng', () => {
    expect(partnerTypeBlockers('bank', 'customer', none)).toEqual([]);
    expect(partnerTypeBlockers('bank', 'supplier', none)).toEqual([]);
  });

  it('đang có công nợ KH/NCC KHÔNG đổi sang Ngân hàng', () => {
    const blockers = partnerTypeBlockers('customer', 'bank', { ...none, debt_vouchers: 4 });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('4 khoản công nợ');
  });

  it('Khách hàng ↔ Nhà cung cấp luôn được phép kể cả khi đang có công nợ', () => {
    const busy: PartnerTypeUsage = { ...none, debt_vouchers: 5 };
    expect(partnerTypeBlockers('customer', 'supplier', busy)).toEqual([]);
    expect(partnerTypeBlockers('supplier', 'customer', busy)).toEqual([]);
  });

  it('đang là ngân hàng cho vay trên phiếu (options.loan) ⇒ phải giữ loại Ngân hàng', () => {
    const blockers = partnerTypeBlockers('bank', 'customer', { ...none, lender_documents: 2 });
    expect(blockers.join(' ')).toContain('ngân hàng cho vay');
    expect(partnerTypeBlockers('bank', 'bank', { ...none, lender_documents: 2 })).toEqual([]);
  });

  it('phiếu đã liên kết trả nợ / giải ngân (đầu nguồn phải là NH) ⇒ phải giữ loại Ngân hàng', () => {
    const blockers = partnerTypeBlockers('bank', 'supplier', { ...none, bank_relation_documents: 1 });
    expect(blockers.join(' ')).toContain('liên kết trả nợ / giải ngân');
  });

  it('nhiều lý do cùng lúc được liệt kê đủ', () => {
    const blockers = partnerTypeBlockers('bank', 'customer', { bank_debts: 1, debt_vouchers: 0, lender_documents: 1, bank_relation_documents: 1 });
    expect(blockers).toHaveLength(3);
  });
});

describe('assertPartnerTypeChange — chặn bằng FG-PARTNER-003', () => {
  it('ném FG-PARTNER-003 khi vỡ ràng buộc, kèm lý do trong data.blockers', () => {
    let caught: ApiError | null = null;
    try {
      assertPartnerTypeChange('bank', 'customer', { ...none, bank_debts: 2 });
    } catch (err) {
      caught = err as ApiError;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect(caught?.code).toBe('FG-PARTNER-003');
    expect(caught?.status).toBe(409);
    expect(Array.isArray(caught?.data?.['blockers'])).toBe(true);
  });

  it('không ném khi không vỡ ràng buộc', () => {
    const cases: [PartnerType, PartnerType][] = [
      ['bank', 'customer'],
      ['customer', 'supplier'],
      ['supplier', 'bank'],
    ];
    for (const [from, to] of cases) {
      expect(codeOf(() => assertPartnerTypeChange(from, to, none))).toBeNull();
    }
  });

  it('đổi Khách hàng → Ngân hàng khi đang có công nợ ⇒ bị chặn', () => {
    expect(codeOf(() => assertPartnerTypeChange('customer', 'bank', { ...none, debt_vouchers: 1 }))).toBe('FG-PARTNER-003');
  });
});

import { describe, expect, it } from 'vitest';
import {
  allocationOf,
  assertRelationRules,
  assertWithinCapacity,
  debtOffsetAppliedFrom,
  debtRemainingOf,
  disbursedExcludingDocument,
  documentAllocatedTotal,
  loanOutstandingOf,
  loanRepaidPrincipalFrom,
  normalizeAmount,
  principalPartOf,
  toBig,
  type LinkEndpoint,
  type LinkRecord,
} from './index.ts';

function ep(over: Partial<LinkEndpoint> = {}): LinkEndpoint {
  return {
    type: 'document',
    id: 'd1',
    company_id: 'c1',
    code: 'PC-2026-00001',
    partner_id: 'p1',
    partner_type: 'supplier',
    total_minor: 1_000n,
    kind: 'spend',
    status: 'approved',
    ...over,
  };
}

function link(over: Partial<LinkRecord>): LinkRecord {
  return {
    _id: 'l' + Math.random().toString(36).slice(2),
    company_id: 'c1',
    from_type: 'document',
    from_id: 'd1',
    to_type: 'debt_voucher',
    to_id: 'v1',
    relation: 'offset',
    amount_minor: 100n,
    split: null,
    origin: 'manual',
    run_id: null,
    rule_code: null,
    status: 'active',
    note: null,
    created_by: null,
    created_at: new Date('2026-10-21T00:00:00Z'),
    removed_by: null,
    removed_at: null,
    removed_reason: null,
    ...over,
  };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
}

describe('links › quy tắc theo quan hệ (v2 §11.2)', () => {
  it('cấn trừ: phiếu chi NCC → công nợ NCC cùng đối tác, cùng công ty — hợp lệ', () => {
    const debt = ep({ type: 'debt_voucher', id: 'v1', partner_type: 'supplier', kind: null, status: null, total_minor: 5_000n });
    expect(() => assertRelationRules('offset', ep(), debt)).not.toThrow();
  });

  it('cấn trừ bị chặn khi đối tác không khớp hoặc công nợ gắn NH', () => {
    const debtOtherPartner = ep({ type: 'debt_voucher', id: 'v1', partner_id: 'p2', partner_type: 'supplier', kind: null, status: null });
    expect(codeOf(() => assertRelationRules('offset', ep(), debtOtherPartner))).toBe('FG-LINK-001');
    const debtBank = ep({ type: 'debt_voucher', id: 'v1', partner_type: 'bank', kind: null, status: null });
    expect(codeOf(() => assertRelationRules('offset', ep(), debtBank))).toBe('FG-LINK-001');
  });

  it('cấn trừ đúng hướng từ cả hai phía: phiếu thu ↔ khoản phải thu, phiếu chi ↔ khoản phải trả (v2 §9.2)', () => {
    const receivable = ep({ type: 'debt_voucher', id: 'v1', partner_type: 'customer', kind: null, status: null, direction: 'receivable' });
    const payable = ep({ type: 'debt_voucher', id: 'v2', partner_type: 'customer', kind: null, status: null, direction: 'payable' });
    const receipt = ep({ kind: 'income', partner_type: 'customer' });
    const spend = ep({ kind: 'spend', partner_type: 'customer' });
    expect(() => assertRelationRules('offset', receipt, receivable)).not.toThrow();
    expect(() => assertRelationRules('offset', spend, payable)).not.toThrow();
    expect(codeOf(() => assertRelationRules('offset', receipt, payable))).toBe('FG-LINK-001');
    expect(codeOf(() => assertRelationRules('offset', spend, receivable))).toBe('FG-LINK-001');
  });

  it('cấn trừ không áp dụng cho phiếu đảo hạn / chuyển nội bộ', () => {
    const debt = ep({ type: 'debt_voucher', id: 'v1', partner_type: 'supplier', kind: null, status: null });
    expect(codeOf(() => assertRelationRules('offset', ep({ kind: 'rollover' }), debt))).toBe('FG-LINK-001');
    expect(codeOf(() => assertRelationRules('offset', ep({ kind: 'internal' }), debt))).toBe('FG-LINK-001');
  });

  it('trả nợ: phiếu chi cho NH → khoản vay NH cùng ngân hàng — hợp lệ; phiếu chi cho NCC → bị chặn', () => {
    const loan = ep({ type: 'bank_debt', id: 'b1', partner_id: 'bank1', partner_type: 'bank', kind: null, status: 'active', total_minor: 9_000n });
    const bankSpend = ep({ partner_id: 'bank1', partner_type: 'bank' });
    expect(() => assertRelationRules('repayment', bankSpend, loan)).not.toThrow();
    expect(codeOf(() => assertRelationRules('repayment', ep(), loan))).toBe('FG-LINK-001');
  });

  it('giải ngân: phiếu thu từ NH → khoản vay cùng NH; phiếu chi không được là giải ngân', () => {
    const loan = ep({ type: 'bank_debt', id: 'b1', partner_id: 'bank1', partner_type: 'bank', kind: null, status: 'pending_disbursement' });
    const receipt = ep({ kind: 'income', partner_id: 'bank1', partner_type: 'bank' });
    expect(() => assertRelationRules('disbursement', receipt, loan)).not.toThrow();
    expect(codeOf(() => assertRelationRules('disbursement', ep({ kind: 'spend', partner_id: 'bank1', partner_type: 'bank' }), loan))).toBe('FG-LINK-001');
  });

  it('vay để chi: phiếu chi bất kỳ đối tác → khoản vay NH; không cần khớp đối tác', () => {
    const loan = ep({ type: 'bank_debt', id: 'b1', partner_id: 'bank1', partner_type: 'bank', kind: null, status: 'pending_disbursement' });
    expect(() => assertRelationRules('funded_by', ep({ partner_id: 'ncc9' }), loan)).not.toThrow();
  });

  it('chuyển nội bộ: hai công ty khác nhau, phiếu chi → phiếu thu; cùng công ty bị chặn', () => {
    const spend = ep({ company_id: 'c1', kind: 'spend' });
    const income = ep({ type: 'document', id: 'd2', company_id: 'c2', kind: 'income', partner_id: null, partner_type: null });
    expect(() => assertRelationRules('internal_transfer', spend, income)).not.toThrow();
    expect(codeOf(() => assertRelationRules('internal_transfer', spend, { ...income, company_id: 'c1' }))).toBe('FG-LINK-001');
    expect(codeOf(() => assertRelationRules('internal_transfer', spend, { ...income, kind: 'spend' }))).toBe('FG-LINK-001');
  });

  it('sinh tự động: liên kết cùng công ty; không tự liên kết chính mình', () => {
    const src = ep({ type: 'document', id: 'd1', kind: 'spend' });
    const gen = ep({ type: 'document', id: 'd2', kind: 'income' });
    expect(() => assertRelationRules('generated', src, gen)).not.toThrow();
    expect(codeOf(() => assertRelationRules('generated', src, src))).toBe('FG-LINK-001');
    expect(codeOf(() => assertRelationRules('generated', src, { ...gen, company_id: 'c9' }))).toBe('FG-LINK-001');
  });

  it('đối tượng chưa gắn đối tác không được cấn trừ', () => {
    const debt = ep({ type: 'debt_voucher', id: 'v1', partner_id: null, partner_type: null, kind: null, status: null });
    expect(codeOf(() => assertRelationRules('offset', ep({ partner_id: null, partner_type: null }), debt))).toBe('FG-LINK-001');
  });
});

describe('links › số tiền, tách gốc / lãi / phí, sức chứa', () => {
  it('tách: tổng ba phần là số tiền phân bổ; số tiền khác tổng thì báo lỗi', () => {
    const split = { principal: 60n, interest: 30n, fee: 5n };
    expect(normalizeAmount({ amount_minor: null, split })).toEqual({ amount: 95n, split });
    expect(normalizeAmount({ amount_minor: 95n, split })).toEqual({ amount: 95n, split });
    expect(codeOf(() => normalizeAmount({ amount_minor: 100n, split }))).toBe('FG-VAL-001');
  });

  it('allocation: tách → tổng ba phần; gốc trả nợ = phần gốc (không tách → cả số tiền)', () => {
    const split = { principal: 60n, interest: 30n, fee: 5n };
    expect(allocationOf({ amount_minor: null, split })).toBe(95n);
    expect(principalPartOf({ amount_minor: null, split })).toBe(60n);
    expect(allocationOf({ amount_minor: 40n, split: null })).toBe(40n);
    expect(principalPartOf({ amount_minor: 40n, split: null })).toBe(40n);
  });

  it('sức chứa: đủ thì qua; vượt thì FG-LINK-002 kèm phần còn lại', () => {
    expect(() => assertWithinCapacity({ limit: 1_000n, committed: 600n, add: 400n, what: 'Phiếu X' })).not.toThrow();
    let err: { code?: string; detail?: string } | undefined;
    try {
      assertWithinCapacity({ limit: 1_000n, committed: 600n, add: 500n, what: 'Phiếu X' });
    } catch (e) {
      err = e as { code?: string; detail?: string };
    }
    expect(err?.code).toBe('FG-LINK-002');
    expect(err?.detail).toContain('Phiếu X');
  });

  it('giải ngân khi lưu phiếu gắn khoản có sẵn: giải ngân của phiếu khác được tính, của chính phiếu đang sửa thì không', () => {
    const disb = (from: string, amount: bigint): LinkRecord =>
      ({ _id: `l-${from}`, from_type: 'document', from_id: from, to_type: 'bank_debt', to_id: 'loan', relation: 'disbursement', amount_minor: amount, split: null, status: 'active' }) as unknown as LinkRecord;
    // khoản 30 triệu đã có 30 triệu của phiếu khác: phiếu mới 10 triệu vượt sức chứa
    const others = [disb('d-other', 30_000_000n)];
    expect(disbursedExcludingDocument(others, 'd-new')).toBe(30_000_000n);
    expect(() => assertWithinCapacity({ limit: 30_000_000n, committed: disbursedExcludingDocument(others, 'd-new'), add: 10_000_000n, what: 'Khoản vay X' })).toThrow();
    // sửa chính phiếu đang gắn: giải ngân của nó không tính trùng → 30 triệu vẫn vừa khoản
    const self = [disb('d-self', 30_000_000n)];
    expect(disbursedExcludingDocument(self, 'd-self')).toBe(0n);
    expect(() => assertWithinCapacity({ limit: 30_000_000n, committed: disbursedExcludingDocument(self, 'd-self'), add: 30_000_000n, what: 'Khoản vay X' })).not.toThrow();
    // không có phiếu loại trừ: tính đủ
    expect(disbursedExcludingDocument([...others, ...self], null)).toBe(60_000_000n);
  });

  it('toBig an toàn với dữ liệu lạ', () => {
    expect(toBig(12n)).toBe(12n);
    expect(toBig('345')).toBe(345n);
    expect(toBig(7)).toBe(7n);
    expect(toBig(undefined)).toBe(0n);
    expect(toBig('abc')).toBe(0n);
  });
});

describe('links › chỉ tiêu suy ra (không lưu cứng)', () => {
  it('đã phân bổ từ phiếu: chỉ liên kết hiệu lực, chỉ quan hệ mang tiền', () => {
    const links = [
      link({ from_id: 'd1', relation: 'offset', amount_minor: 100n }),
      link({ from_id: 'd1', relation: 'repayment', amount_minor: 50n, to_type: 'bank_debt', to_id: 'b1' }),
      link({ from_id: 'd1', relation: 'generated', amount_minor: 999n, to_type: 'document', to_id: 'd9' }),
      link({ from_id: 'd1', relation: 'offset', amount_minor: 70n, status: 'removed' }),
      link({ from_id: 'd2', relation: 'offset', amount_minor: 500n }),
    ];
    expect(documentAllocatedTotal(links, 'd1')).toBe(150n);
  });

  it('cấn trừ hiệu lực chỉ tính khi PHIẾU NGUỒN đã thực thi (paid)', () => {
    const links = [
      link({ from_id: 'd1', to_id: 'v1', amount_minor: 100n }),
      link({ from_id: 'd2', to_id: 'v1', amount_minor: 40n }),
      link({ from_id: 'd3', to_id: 'v1', amount_minor: 30n, status: 'removed' }),
    ];
    expect(debtOffsetAppliedFrom(links, 'v1', new Set(['d1']))).toBe(100n);
    expect(debtOffsetAppliedFrom(links, 'v1', new Set(['d1', 'd2']))).toBe(140n);
    expect(debtOffsetAppliedFrom(links, 'v1', new Set())).toBe(0n);
  });

  it('còn phải thu = giá trị − đã cấn trừ, không âm', () => {
    expect(debtRemainingOf(1_000n, 300n)).toBe(700n);
    expect(debtRemainingOf(1_000n, 1_200n)).toBe(0n);
  });

  it('gốc đã trả dùng phần gốc khi có tách lãi/phí; chỉ phiếu paid', () => {
    const links = [
      link({ from_id: 'd1', to_type: 'bank_debt', to_id: 'b1', relation: 'repayment', amount_minor: 95n, split: { principal: 60n, interest: 30n, fee: 5n } }),
      link({ from_id: 'd2', to_type: 'bank_debt', to_id: 'b1', relation: 'repayment', amount_minor: 200n, split: null }),
    ];
    expect(loanRepaidPrincipalFrom(links, 'b1', new Set(['d1']))).toBe(60n);
    expect(loanRepaidPrincipalFrom(links, 'b1', new Set(['d1', 'd2']))).toBe(260n);
  });

  it('dư nợ: gốc − đã trả; khoản chờ giải ngân hoặc đã huỷ không tính dư nợ', () => {
    expect(loanOutstandingOf(1_000n, 250n, 'active')).toBe(750n);
    expect(loanOutstandingOf(1_000n, 1_500n, 'active')).toBe(0n);
    expect(loanOutstandingOf(1_000n, 0n, 'pending_disbursement')).toBe(0n);
    expect(loanOutstandingOf(1_000n, 0n, 'cancelled')).toBe(0n);
  });
});

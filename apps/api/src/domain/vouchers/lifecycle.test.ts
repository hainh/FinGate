import { describe, expect, it } from 'vitest';
import {
  actualAmountProblem,
  mayChangeVoucherTags,
  reversalEntriesFor,
  roundLocksEdit,
  voucherAmountField,
  type LedgerEntryForReversal,
} from './lifecycle.ts';

describe('roundLocksEdit — US-VOU-05: yêu cầu bổ sung không bị khoá bởi vòng duyệt cũ', () => {
  it('chưa có KTT+ duyệt ⇒ không khoá', () => {
    expect(roundLocksEdit('pending.pgd', false)).toBe(false);
  });
  it('KTT+ đã duyệt trong vòng hiện tại ⇒ khoá', () => {
    expect(roundLocksEdit('pending.gd', true)).toBe(true);
  });
  it('bị yêu cầu bổ sung sau khi KTT+ duyệt ⇒ người lập sửa được (không khoá)', () => {
    expect(roundLocksEdit('changes_requested', true)).toBe(false);
  });
});

describe('mayChangeVoucherTags — §6.2: chỉ người lập hoặc kế toán trưởng đổi tag', () => {
  it('người lập đổi được', () => {
    expect(mayChangeVoucherTags({ user_id: 'u1', permissions: ['doc:create'] }, { created_by: 'u1' })).toBe(true);
  });
  it('KTV khác không đổi được tag phiếu của người khác', () => {
    expect(mayChangeVoucherTags({ user_id: 'u2', permissions: ['doc:create', 'tag:create'] }, { created_by: 'u1' })).toBe(false);
  });
  it('kế toán trưởng (tag:manage) đổi được tag phiếu của người khác', () => {
    expect(mayChangeVoucherTags({ user_id: 'u3', permissions: ['tag:manage'] }, { created_by: 'u1' })).toBe(true);
  });
});

describe('voucherAmountField — số thập phân theo tiền tệ (không hard-code 0)', () => {
  it('USD có 2 chữ số thập phân', () => {
    expect(voucherAmountField('USD', 12345n)).toEqual({ minor: 12345n, currency: 'USD', decimals: 2 });
  });
  it('VND có 0 chữ số thập phân', () => {
    expect(voucherAmountField('VND', 500n)).toEqual({ minor: 500n, currency: 'VND', decimals: 0 });
  });
});

describe('actualAmountProblem — §6.1/§8: số thực chi không vượt số đã duyệt', () => {
  it('bằng số đã duyệt ⇒ hợp lệ', () => {
    expect(actualAmountProblem(1000n, 1000n, null)).toBeNull();
  });
  it('vượt số đã duyệt ⇒ từ chối, kể cả có lý do', () => {
    expect(actualAmountProblem(1000n, 1001n, 'lý do đủ dài')).toBe('over_approved');
  });
  it('thấp hơn nhưng thiếu lý do ⇒ từ chối', () => {
    expect(actualAmountProblem(1000n, 900n, undefined)).toBe('short_needs_reason');
  });
  it('lý do toàn khoảng trắng không được tính là lý do', () => {
    expect(actualAmountProblem(1000n, 900n, '   ab  ')).toBe('short_needs_reason');
  });
  it('thấp hơn có lý do ≥ 5 ký tự ⇒ hợp lệ', () => {
    expect(actualAmountProblem(1000n, 900n, 'Trả thiếu theo thoả thuận')).toBeNull();
  });
});

describe('reversalEntriesFor — §8: sổ cái chỉ thêm, huỷ phiếu = bút toán đảo', () => {
  const original: LedgerEntryForReversal = {
    _id: 'e1',
    company_id: 'c1',
    account_id: 'a1',
    direction: 'out',
    amount_minor: 100n,
    currency: 'VND',
    document_id: 'd1',
    document_code: 'PC-0001',
    dedupe_key: 'doc:d1:actual:0',
    reverses: null,
  };

  it('đảo chiều, cùng số tiền và tài khoản, trỏ về bút toán gốc', () => {
    const [rev] = reversalEntriesFor([original], { date: '2026-10-21', createdBy: 'u9' });
    expect(rev).toEqual({
      company_id: 'c1',
      account_id: 'a1',
      date: '2026-10-21',
      direction: 'in',
      amount_minor: 100n,
      currency: 'VND',
      reason: 'paid',
      document_id: 'd1',
      document_code: 'PC-0001',
      reverses: 'e1',
      dedupe_key: 'rev:doc:d1:actual:0',
      created_by: 'u9',
    });
  });

  it('không đảo bút toán đảo (reverses đã có)', () => {
    const rev = { ...original, _id: 'e2', direction: 'in', reverses: 'e1', dedupe_key: 'rev:doc:d1:actual:0' };
    expect(reversalEntriesFor([rev], { date: '2026-10-21', createdBy: null })).toEqual([]);
  });

  it('chạy lại cho cùng bút toán gốc ⇒ cùng khoá idempotency (không đảo trùng)', () => {
    const first = reversalEntriesFor([original], { date: '2026-10-21', createdBy: 'u9' });
    const second = reversalEntriesFor([original], { date: '2026-10-21', createdBy: 'u9' });
    expect(second.map((e) => e.dedupe_key)).toEqual(first.map((e) => e.dedupe_key));
  });

  it('bút toán vào (in) được đảo thành ra (out)', () => {
    const [rev] = reversalEntriesFor([{ ...original, direction: 'in', dedupe_key: 'doc:d1:actual:1' }], { date: '2026-10-21', createdBy: null });
    expect(rev?.direction).toBe('out');
  });
});

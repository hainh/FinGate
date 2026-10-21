import { describe, expect, it } from 'vitest';
import { entriesForExecutedDocument, internalDestOf } from './index.ts';

describe('internalDestOf — đích chuyển nội bộ', () => {
  it('ưu tiên transfer_target (v2), rơi về target (v1) khi thiếu', () => {
    expect(internalDestOf({ target: { company_id: 'cX', account_id: 'aX' }, transfer_target: { company_id: 'cY', account_id: 'aY' } })).toEqual({
      company_id: 'cY',
      account_id: 'aY',
    });
    expect(internalDestOf({ target: { company_id: 'cX', account_id: 'aX' }, transfer_target: null })).toEqual({ company_id: 'cX', account_id: 'aX' });
  });
  it('null khi thiếu công ty hoặc tài khoản', () => {
    expect(internalDestOf({ target: { company_id: null, account_id: 'aX' }, transfer_target: null })).toBeNull();
    expect(internalDestOf({})).toBeNull();
  });
});

describe('entriesForExecutedDocument — chuyển nội bộ chỉ có transfer_target (v2)', () => {
  it('ghi chân ra ở công ty nguồn và chân vào (mirror) ở tài khoản đích theo transfer_target', () => {
    const entries = entriesForExecutedDocument({
      _id: 'doc1',
      code: 'NB-1',
      kind: 'internal',
      company_id: 'cA',
      amount: { minor: 1000n, currency: 'VND' },
      source: { account_id: 'aA' },
      target: null,
      transfer_target: { company_id: 'cB', account_id: 'aB' },
      planned_date: '2026-10-20',
      status: 'paid',
      execution: { paid_at: '2026-10-20', actual_amount_minor: 1000n },
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ company_id: 'cA', account_id: 'aA', direction: 'out', amount_minor: 1000n, reason: 'paid' });
    expect(entries[1]).toMatchObject({ company_id: 'cB', account_id: 'aB', direction: 'in', amount_minor: 1000n, reason: 'mirror' });
    expect(entries[1]!.dedupe_key).toBe('doc:doc1:actual:0:mirror:aB');
  });
});

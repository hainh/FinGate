import { describe, expect, it } from 'vitest';
import { entriesForExecutedDocument, entriesForPayment, sourceAccountOf } from './index.ts';
import type { DomainDoc } from '../types.ts';

const base = {
  company_id: 'c1',
  amount: { minor: 1000n, currency: 'VND', decimals: 0 },
  source: { fund: 'bank' as const, account_id: 'a1' },
  planned_date: '2026-01-05',
};

describe('ledger · sourceAccountOf', () => {
  it('ưu tiên tài khoản công ty, fallback tài khoản Tập đoàn', () => {
    expect(sourceAccountOf({ source: { account_id: 'a1', group_account_id: 'g1' } })).toBe('a1');
    expect(sourceAccountOf({ source: { account_id: null, group_account_id: 'g1' } })).toBe('g1');
    expect(sourceAccountOf({ source: {} })).toBeNull();
  });
});

describe('ledger · entriesForExecutedDocument', () => {
  it('phiếu thu đã trả → 1 entry "in"', () => {
    const doc = { ...base, _id: 'd1', code: 'PT-1', kind: 'income', status: 'paid', execution: { paid_at: '2026-01-05', actual_amount_minor: 1000n } };
    const e = entriesForExecutedDocument(doc);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ account_id: 'a1', direction: 'in', amount_minor: 1000n, date: '2026-01-05', dedupe_key: 'doc:d1:actual:0' });
  });

  it('phiếu chi từng phần → mỗi kỳ 1 entry "out", giữ đúng chỉ số dedupe', () => {
    const doc = {
      ...base,
      _id: 'd2',
      code: 'PC-1',
      kind: 'spend',
      status: 'paid',
      execution: {
        allow_partial: true,
        paid_at: '2026-02-01',
        installments: [
          { at: '2026-02-01', amount_minor: 300n, account_id: 'a1' },
          { at: '2026-02-05', amount_minor: 700n, account_id: 'a1' },
        ],
      },
    };
    const e = entriesForExecutedDocument(doc);
    expect(e.map((x) => x.dedupe_key)).toEqual(['doc:d2:actual:0', 'doc:d2:actual:1']);
    expect(e.map((x) => x.direction)).toEqual(['out', 'out']);
    expect(e.map((x) => x.amount_minor)).toEqual([300n, 700n]);
  });

  it('chuyển nội bộ → sinh entry đối ứng công ty đích', () => {
    const doc = {
      ...base,
      _id: 'd3',
      code: 'NB-1',
      kind: 'internal',
      status: 'paid',
      target: { company_id: 'c2', account_id: 'a2' },
      execution: { paid_at: '2026-01-06', actual_amount_minor: 500n },
    };
    const e = entriesForExecutedDocument(doc);
    expect(e).toHaveLength(2);
    const mirror = e.find((x) => x.dedupe_key.includes('mirror'));
    expect(mirror).toMatchObject({ company_id: 'c2', account_id: 'a2', direction: 'in', amount_minor: 500n });
  });

  it('hồ sơ chưa thực thi → không sinh entry', () => {
    expect(entriesForExecutedDocument({ ...base, _id: 'd4', code: 'PC-X', kind: 'spend', status: 'approved' })).toHaveLength(0);
  });

  it('phiếu chi từng phần đang mở (approved) đã có kỳ → vẫn ghi ledger', () => {
    const doc = {
      ...base,
      _id: 'd6',
      code: 'PC-3',
      kind: 'spend',
      status: 'approved',
      execution: { allow_partial: true, installments: [{ at: '2026-03-01', amount_minor: 400n, account_id: 'a1' }] },
    };
    const e = entriesForExecutedDocument(doc);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ direction: 'out', amount_minor: 400n, date: '2026-03-01' });
  });

  it('dedupe_key khớp giữa runtime và backfill (idempotent)', () => {
    const doc = { ...base, _id: 'd5', code: 'PC-2', kind: 'spend', status: 'paid', execution: { paid_at: '2026-01-07', actual_amount_minor: 900n } };
    const backfill = entriesForExecutedDocument(doc);
    const runtime = entriesForPayment({ doc: doc as unknown as DomainDoc, accountId: 'a1', amountMinor: 900n, date: '2026-01-07', installmentIndex: 0 });
    expect(runtime).toHaveLength(1);
    expect(runtime[0]!.dedupe_key).toBe(backfill[0]!.dedupe_key);
    expect(runtime[0]).toMatchObject({ direction: 'out', amount_minor: 900n, date: '2026-01-07' });
  });
});

import { describe, expect, it } from 'vitest';
import { buildPartnerLedger, effectsByDocument, type PartnerLedgerEvent } from './partner-ledger.ts';
import type { SettlementRow } from './aggregate.ts';

function ev(over: Partial<PartnerLedgerEvent>): PartnerLedgerEvent {
  return { date: '2026-10-01', kind: 'cong_no', code: 'X', description: '', cash_in: 0n, cash_out: 0n, effect: 0n, ref_id: 'r', href: null, ...over };
}

function srow(over: Partial<SettlementRow>): SettlementRow {
  return {
    target_id: 't',
    document_id: 'd',
    source: 'v2',
    link_id: 'L',
    amount: 0n,
    principal: 0n,
    doc_status: 'paid',
    doc_kind: 'spend',
    doc_code: 'PC',
    doc_date: '2026-10-01',
    doc_company_id: 'c1',
    doc_partner_id: 'p1',
    doc_amount: 0n,
    ...over,
  };
}

describe('buildPartnerLedger — sổ chi tiết đối tác', () => {
  it('dư đầu kỳ = tác động trước kỳ; dư lũy kế trong kỳ; bỏ dòng ngoài kỳ', () => {
    const events = [
      ev({ date: '2026-09-01', kind: 'cong_no', code: 'CN-1', effect: 1000n, ref_id: 'd1' }),
      ev({ date: '2026-10-05', kind: 'phieu_thu', code: 'PT-1', cash_in: 400n, effect: -400n, ref_id: 'p1' }),
      ev({ date: '2026-10-10', kind: 'khoan_vay', code: 'NHD-1', effect: -300n, ref_id: 'l1' }),
      ev({ date: '2026-10-20', kind: 'phieu_chi', code: 'PC-1', cash_out: 200n, effect: 0n, ref_id: 'p2' }),
      ev({ date: '2026-11-02', kind: 'phieu_thu', code: 'PT-2', cash_in: 50n, effect: -50n, ref_id: 'p3' }),
    ];
    const r = buildPartnerLedger(events, '2026-10-01', '2026-10-31');
    expect(r.opening).toBe(1000n);
    expect(r.rows.map((x) => x.code)).toEqual(['PT-1', 'NHD-1', 'PC-1']);
    expect(r.rows.map((x) => x.balance)).toEqual([600n, 300n, 300n]);
    expect(r.totals).toEqual({ cash_in: 400n, cash_out: 200n, effect: -700n, closing: 300n });
  });

  it('cùng ngày: sắp theo loại (công nợ trước chứng từ)', () => {
    const events = [
      ev({ date: '2026-10-03', kind: 'phieu_thu', code: 'PT-9', cash_in: 10n, effect: -10n, ref_id: 'x' }),
      ev({ date: '2026-10-03', kind: 'cong_no', code: 'CN-9', effect: 100n, ref_id: 'y' }),
    ];
    const r = buildPartnerLedger(events, '2026-10-01', '2026-10-31');
    expect(r.rows.map((x) => x.code)).toEqual(['CN-9', 'PT-9']);
    expect(r.rows.map((x) => x.balance)).toEqual([100n, 90n]);
  });

  it('kỳ không có sự kiện: dư đầu = dư cuối = tác động lũy kế trước kỳ', () => {
    const r = buildPartnerLedger([ev({ date: '2026-01-01', effect: 250n })], '2026-10-01', '2026-10-31');
    expect(r.rows).toEqual([]);
    expect(r.opening).toBe(250n);
    expect(r.totals.closing).toBe(250n);
  });
});

describe('effectsByDocument — tác động lên dư của từng phiếu đã thực thi', () => {
  it('thu cấn trừ phải thu làm giảm; chi cấn trừ phải trả làm tăng; trả nợ vay tính theo gốc', () => {
    const debtRows = [
      srow({ target_id: 'd-recv', document_id: 'pt1', amount: 300n, principal: 300n, doc_kind: 'income' }),
      srow({ target_id: 'd-pay', document_id: 'pc1', amount: 200n, principal: 200n, doc_kind: 'spend' }),
    ];
    const loanRows = [srow({ target_id: 'l1', document_id: 'pc2', amount: 500n, principal: 400n, doc_kind: 'spend' })];
    const dir = new Map<string, 'receivable' | 'payable'>([
      ['d-recv', 'receivable'],
      ['d-pay', 'payable'],
    ]);
    const eff = effectsByDocument(debtRows, loanRows, dir);
    expect(eff.get('pt1')).toBe(-300n);
    expect(eff.get('pc1')).toBe(200n);
    expect(eff.get('pc2')).toBe(400n);
  });
});

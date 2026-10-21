import { describe, expect, it } from 'vitest';
import { clampDay, plannedFlowsByAccount, plannedFlowsOf, toPipelineDoc, type PipelineDoc } from './planned.ts';

const base: PipelineDoc = {
  id: 'd1',
  code: 'PC-1',
  kind: 'spend',
  company_id: 'c1',
  status: 'approved',
  planned_date: '2026-10-25',
  amount_minor: 500n,
  source_account_id: 'a1',
  target_company_id: null,
  target_account_id: null,
  borrow: false,
  partner_id: 'p1',
  tag_ids: [],
};

describe('plannedFlowsOf — phiếu chờ thực thi thành dòng dự kiến', () => {
  it('chi → operating_out tại tài khoản nguồn, đúng ngày dự kiến', () => {
    expect(plannedFlowsOf(base, '2026-10-21')).toEqual([
      { doc_id: 'd1', code: 'PC-1', company_id: 'c1', account_id: 'a1', date: '2026-10-25', direction: 'out', bucket: 'operating_out', amount: 500n },
    ]);
  });

  it('thu thường → operating_in; thu giải ngân vay (borrow) → disbursement_in', () => {
    const income = { ...base, kind: 'income', code: 'PT-1' };
    expect(plannedFlowsOf(income, '2026-10-21')[0]).toMatchObject({ direction: 'in', bucket: 'operating_in' });
    expect(plannedFlowsOf({ ...income, borrow: true }, '2026-10-21')[0]).toMatchObject({ direction: 'in', bucket: 'disbursement_in' });
  });

  it('phiếu quá hạn chưa thực thi được kẹp vào ngày bắt đầu dự báo', () => {
    const late = { ...base, planned_date: '2026-10-01' };
    expect(plannedFlowsOf(late, '2026-10-21')[0]?.date).toBe('2026-10-21');
    expect(clampDay('2026-10-25', '2026-10-21')).toBe('2026-10-25');
  });

  it('chuyển nội bộ → chân ra ở công ty nguồn và chân vào ở công ty đích', () => {
    const transfer: PipelineDoc = {
      ...base,
      kind: 'internal',
      target_company_id: 'c2',
      target_account_id: 'a2',
    };
    const flows = plannedFlowsOf(transfer, '2026-10-21');
    expect(flows.map((f) => [f.company_id, f.account_id, f.direction, f.bucket])).toEqual([
      ['c1', 'a1', 'out', 'internal_out'],
      ['c2', 'a2', 'in', 'internal_in'],
    ]);
  });

  it('số tiền còn lại ≤ 0 không tạo dòng', () => {
    expect(plannedFlowsOf({ ...base, amount_minor: 0n }, '2026-10-21')).toEqual([]);
  });
});

describe('plannedFlowsByAccount', () => {
  it('cộng vào/ra theo tài khoản, chỉ các tài khoản trong tập cho phép', () => {
    const flows = [
      ...plannedFlowsOf({ ...base, kind: 'income', amount_minor: 300n }, '2026-10-21'),
      ...plannedFlowsOf(base, '2026-10-21'),
      ...plannedFlowsOf({ ...base, source_account_id: 'other', amount_minor: 900n }, '2026-10-21'),
    ];
    const m = plannedFlowsByAccount(flows, new Set(['a1']));
    expect(m.get('a1')).toEqual({ in: 300n, out: 500n });
    expect(m.has('other')).toBe(false);
  });
});

describe('toPipelineDoc — rút gọn từ bản ghi phiếu', () => {
  it('số tiền còn lại = amount − paid_minor; cắt giờ ngày dự kiến; cờ vay; ưu tiên transfer_target', () => {
    const doc = toPipelineDoc({
      _id: 'd9',
      code: 'PT-9',
      kind: 'income',
      company_id: 'c1',
      status: 'approved',
      planned_date: '2026-10-25T09:00',
      amount: { minor: 1000n },
      execution: { paid_minor: 400n },
      options: { loan: { kind: 'borrow' } },
      source: { account_id: 'a2' },
      partner_id: 'p2',
      tag_ids: ['t1'],
    });
    expect(doc).toMatchObject({
      id: 'd9',
      amount_minor: 600n,
      planned_date: '2026-10-25',
      borrow: true,
      source_account_id: 'a2',
      partner_id: 'p2',
      tag_ids: ['t1'],
      target_company_id: null,
    });

    const transfer = toPipelineDoc({
      _id: 'n1',
      code: 'NB-1',
      kind: 'internal',
      company_id: 'c1',
      status: 'approved',
      planned_date: '2026-10-25',
      amount: { minor: 10n },
      source: { account_id: 'a1' },
      target: { company_id: 'cX', account_id: 'aX' },
      transfer_target: { company_id: 'cY', account_id: 'aY' },
    });
    expect(transfer).toMatchObject({ target_company_id: 'cY', target_account_id: 'aY' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  debtDirectionOf,
  executedSum,
  groupByTagName,
  outstandingLoanOf,
  overdueDaysOf,
  partnerActivityOf,
  percentOf,
  remainingOf,
  revenueExpenseOf,
  type ReportDocLike,
  type SettlementRow,
} from './aggregate.ts';

function srow(over: Partial<SettlementRow> = {}): SettlementRow {
  return {
    target_id: 'd1',
    document_id: 'p1',
    source: 'v2',
    link_id: null,
    amount: 100n,
    principal: 100n,
    doc_status: 'paid',
    doc_kind: 'income',
    doc_code: 'PT-1',
    doc_date: '2026-10-01',
    doc_company_id: 'c1',
    doc_partner_id: 'pt1',
    doc_amount: 100n,
    ...over,
  };
}

describe('debtDirectionOf (M3b)', () => {
  it('ưu tiên direction v2', () => {
    expect(debtDirectionOf({ direction: 'payable', side: 'debit' })).toBe('payable');
  });
  it('v1 chưa migrate: side debit = phải thu, credit = phải trả', () => {
    expect(debtDirectionOf({ side: 'debit' })).toBe('receivable');
    expect(debtDirectionOf({ side: 'credit' })).toBe('payable');
  });
});

describe('revenueExpenseOf — loại chuyển nội bộ khỏi doanh thu/chi phí', () => {
  const docs = [
    { id: 'a', kind: 'income', amount: 1000n },
    { id: 'b', kind: 'spend', amount: 400n },
    { id: 'c', kind: 'income', amount: 500n }, // thu tự động của cặp nội bộ
    { id: 'd', kind: 'spend', amount: 500n }, // chi của cặp nội bộ
    { id: 'e', kind: 'rollover', amount: 300n }, // đảo hạn: không phải chi phí
  ];
  it('bỏ cặp nội bộ', () => {
    expect(revenueExpenseOf(docs, new Set(['c', 'd']))).toEqual({ income: 1000n, expense: 400n, count: 2 });
  });
  it('không loại gì khi tập rỗng; rollover không tính vào chi', () => {
    expect(revenueExpenseOf(docs, new Set())).toEqual({ income: 1500n, expense: 900n, count: 4 });
  });
});

describe('partnerActivityOf', () => {
  it('gom theo đối tác, bỏ nội bộ, khoá rỗng cho phiếu chưa gán đối tác', () => {
    const docs: ReportDocLike[] = [
      { id: 'a', kind: 'income', company_id: 'c1', amount: 100n, partner_id: 'p1', tag_ids: [] },
      { id: 'b', kind: 'spend', company_id: 'c1', amount: 40n, partner_id: 'p1', tag_ids: [] },
      { id: 'c', kind: 'spend', company_id: 'c1', amount: 70n, partner_id: null, tag_ids: [] },
      { id: 'x', kind: 'spend', company_id: 'c1', amount: 900n, partner_id: 'p1', tag_ids: [] },
    ];
    const m = partnerActivityOf(docs, new Set(['x']));
    expect(m.get('p1')).toEqual({ income: 100n, expense: 40n, count: 2 });
    expect(m.get('')).toEqual({ income: 0n, expense: 70n, count: 1 });
  });
});

describe('groupByTagName — gộp theo tên chuẩn hoá', () => {
  it('cùng tên ở nhiều công ty được cộng chung; phiếu không tag vào nhóm riêng', () => {
    const tags = new Map([
      ['t1', { name: 'Dự án  Alpha', name_key: 'dự án alpha' }],
      ['t2', { name: 'dự án alpha' }], // không có name_key → chuẩn hoá từ tên
      ['t3', { name: 'Đợt 2', name_key: 'đợt 2' }],
    ]);
    const docs: ReportDocLike[] = [
      { id: 'a', kind: 'income', company_id: 'c1', amount: 100n, partner_id: null, tag_ids: ['t1'] },
      { id: 'b', kind: 'spend', company_id: 'c2', amount: 30n, partner_id: null, tag_ids: ['t2', 't3'] },
      { id: 'c', kind: 'spend', company_id: 'c1', amount: 5n, partner_id: null, tag_ids: [] },
    ];
    const groups = groupByTagName(docs, tags, new Set());
    const alpha = groups.find((g) => g.key === 'dự án alpha');
    expect(alpha).toBeDefined();
    expect(alpha!.income).toBe(100n);
    expect(alpha!.expense).toBe(30n);
    expect(alpha!.count).toBe(2);
    expect([...alpha!.company_ids].sort()).toEqual(['c1', 'c2']);
    expect([...alpha!.tag_ids].sort()).toEqual(['t1', 't2']);
    expect(groups.find((g) => g.key === '')?.name).toBe('Chưa gắn tag');
  });

  it('bỏ phiếu nội bộ và tag không còn trong danh bạ', () => {
    const tags = new Map([['t1', { name: 'A', name_key: 'a' }]]);
    const docs: ReportDocLike[] = [
      { id: 'n', kind: 'spend', company_id: 'c1', amount: 999n, partner_id: null, tag_ids: ['t1'] },
      { id: 'm', kind: 'spend', company_id: 'c1', amount: 10n, partner_id: null, tag_ids: ['gone'] },
    ];
    const groups = groupByTagName(docs, tags, new Set(['n']));
    expect(groups.map((g) => g.name)).toEqual(['Chưa gắn tag']);
    expect(groups[0]?.expense).toBe(10n);
  });
});

describe('phân bổ cấn trừ / trả nợ (business_links)', () => {
  it('chỉ phiếu ĐÃ THỰC THI (paid) được tính đã cấn trừ', () => {
    const rows = [srow({ amount: 100n }), srow({ document_id: 'p2', amount: 50n, doc_status: 'approved' })];
    expect(executedSum(rows)).toBe(100n);
  });

  it('trả nợ vay tính theo phần GỐC', () => {
    expect(executedSum([srow({ amount: 150n, principal: 100n })], 'principal')).toBe(100n);
  });

  it('còn lại không âm; dư nợ vay = 0 khi chờ giải ngân / đã huỷ', () => {
    expect(remainingOf(100n, 130n)).toBe(0n);
    expect(remainingOf(100n, 30n)).toBe(70n);
    expect(outstandingLoanOf(1000n, 300n, 'active')).toBe(700n);
    expect(outstandingLoanOf(1000n, 0n, 'pending_disbursement')).toBe(0n);
    expect(outstandingLoanOf(1000n, 0n, 'cancelled')).toBe(0n);
    expect(outstandingLoanOf(500n, 900n, 'overdue')).toBe(0n);
  });
});

describe('tiện ích số liệu', () => {
  it('overdueDaysOf: số ngày quá hạn, 0 khi chưa đến hạn hoặc thiếu ngày', () => {
    expect(overdueDaysOf('2026-10-01', '2026-10-21')).toBe(20);
    expect(overdueDaysOf('2026-10-25', '2026-10-21')).toBe(0);
    expect(overdueDaysOf('', '2026-10-21')).toBe(0);
  });
  it('percentOf làm tròn 2 số thập phân, 0 khi mẫu số ≤ 0', () => {
    expect(percentOf(25n, 100n)).toBe(25);
    expect(percentOf(1n, 3n)).toBe(33.33);
    expect(percentOf(5n, 0n)).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { ApiError, debtListQuery, toJsonSchema } from '@fingate/shared';
import {
  accountCodeOfPartnerType,
  agingBucketOf,
  assertLinkableDocStatus,
  assertOffsetDirection,
  businessDateStart,
  debtFigures,
  defaultAllocation,
  directionOf,
  docKindForDirection,
  escapeRegex,
  loanStatusOf,
  loanWarningOf,
  positiveMinor,
  resolveSide,
  sideForDirection,
  wireMoney,
} from './rules.ts';
import {
  debtAgingQuery,
  debtCreateBody,
  debtOffsetBody,
  debtUpdateBody,
  linkCandidatesQuery,
  loanCancelBody,
  loanCreateBody,
  loanDisbursementBody,
  loanImportRow,
  loanListQuery,
  loanRepaymentBody,
  loanUpdateBody,
  unlinkBody,
} from './bodies.ts';
import { paidRepaymentParts, sumBy, validIds, type DocRef } from './loads.ts';
import { loanOutstandingOf, principalPartOf, type LinkRecord } from '../links/index.ts';

const P1 = '65a000000000000000000001';
const P2 = '65a000000000000000000002';
const D1 = '65a000000000000000000011';
const D2 = '65a000000000000000000012';

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof ApiError ? err.code : 'OTHER';
  }
}

function link(over: Partial<LinkRecord>): LinkRecord {
  return {
    _id: 'l',
    company_id: 'c1',
    from_type: 'document',
    from_id: D1,
    to_type: 'bank_debt',
    to_id: P1,
    relation: 'repayment',
    amount_minor: 100n,
    split: null,
    origin: 'manual',
    run_id: null,
    rule_code: null,
    status: 'active',
    note: null,
    created_by: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    removed_by: null,
    removed_at: null,
    removed_reason: null,
    ...over,
  };
}

function doc(id: string, status: string, amount = 100n): DocRef {
  return { _id: id, company_id: 'c1', code: id, title: '', kind: 'spend', status, partner_id: P1, amount_minor: amount, actual_minor: null, paid_at: '2026-10-01' };
}

describe('công nợ v2 › hướng, bút toán và tài khoản', () => {
  it('phải thu ↔ Nợ, phải trả ↔ Có (độc lập loại đối tác)', () => {
    expect(sideForDirection('receivable')).toBe('debit');
    expect(sideForDirection('payable')).toBe('credit');
  });

  it('hướng hiệu lực: ưu tiên direction; v1 chưa migrate suy từ Nợ/Có', () => {
    expect(directionOf({ direction: 'payable', side: 'debit' })).toBe('payable');
    expect(directionOf({ direction: null, side: 'credit' })).toBe('payable');
    expect(directionOf({ direction: null, side: 'debit' })).toBe('receivable');
  });

  it('bút toán bỏ trống suy từ hướng; lệch hướng ⇒ FG-VAL-001', () => {
    expect(resolveSide('receivable', undefined)).toBe('debit');
    expect(resolveSide('payable', 'credit')).toBe('credit');
    expect(codeOf(() => resolveSide('receivable', 'credit'))).toBe('FG-VAL-001');
  });

  it('tài khoản: KH = 131, NCC = 331; loại khác không có', () => {
    expect(accountCodeOfPartnerType('customer')).toBe('131');
    expect(accountCodeOfPartnerType('supplier')).toBe('331');
    expect(accountCodeOfPartnerType('bank')).toBeNull();
  });

  it('cấn trừ: phiếu thu ↔ phải thu; phiếu chi ↔ phải trả', () => {
    expect(docKindForDirection('receivable')).toBe('income');
    expect(docKindForDirection('payable')).toBe('spend');
    expect(() => assertOffsetDirection('receivable', 'income')).not.toThrow();
    expect(codeOf(() => assertOffsetDirection('receivable', 'spend'))).toBe('FG-LINK-001');
    expect(codeOf(() => assertOffsetDirection('payable', 'income'))).toBe('FG-LINK-001');
  });

  it('phiếu đã huỷ / từ chối / hết hạn không được liên kết', () => {
    expect(() => assertLinkableDocStatus('paid')).not.toThrow();
    expect(() => assertLinkableDocStatus('draft')).not.toThrow();
    expect(codeOf(() => assertLinkableDocStatus('cancelled'))).toBe('FG-LINK-001');
    expect(codeOf(() => assertLinkableDocStatus('rejected'))).toBe('FG-LINK-001');
    expect(codeOf(() => assertLinkableDocStatus('expired'))).toBe('FG-LINK-001');
  });
});

describe('công nợ v2 › chỉ tiêu suy ra', () => {
  it('còn lại = giá trị − đã cấn trừ; quá hạn khi còn dư', () => {
    const f = debtFigures(1_000n, 300n, '2026-01-01', '2026-02-01');
    expect(f.remaining).toBe(700n);
    expect(f.status).toBe('partial');
    expect(f.overdue_days).toBe(31);
    expect(f.aging_bucket).toBe('d30_60');
  });

  it('khoản đã cấn trừ đủ không quá hạn dù qua hạn', () => {
    const f = debtFigures(1_000n, 1_000n, '2026-01-01', '2026-02-01');
    expect(f.remaining).toBe(0n);
    expect(f.status).toBe('settled');
    expect(f.overdue_days).toBe(0);
    expect(f.aging_bucket).toBe('none');
  });

  it('chưa cấn trừ ⇒ open; còn hạn ⇒ không quá hạn', () => {
    const f = debtFigures(500n, 0n, '2030-01-01', '2026-02-01');
    expect(f.status).toBe('open');
    expect(f.overdue_days).toBe(0);
  });

  it('nhóm tuổi nợ theo ngưỡng 30/60/90 ngày', () => {
    expect(agingBucketOf(0)).toBe('none');
    expect(agingBucketOf(1)).toBe('lt30');
    expect(agingBucketOf(29)).toBe('lt30');
    expect(agingBucketOf(30)).toBe('d30_60');
    expect(agingBucketOf(60)).toBe('d30_60');
    expect(agingBucketOf(61)).toBe('d60_90');
    expect(agingBucketOf(90)).toBe('d60_90');
    expect(agingBucketOf(91)).toBe('gt90');
  });
});

describe('nợ ngân hàng v2 › trạng thái và cảnh báo', () => {
  const NOW = '2026-10-21';

  it('chờ giải ngân giữ nguyên dù dư nợ bằng 0; huỷ & lưu trữ theo trạng thái lưu', () => {
    expect(loanStatusOf('pending_disbursement', 0n, '2027-01-01', NOW)).toBe('pending_disbursement');
    expect(loanStatusOf('cancelled', 500n, '2027-01-01', NOW)).toBe('cancelled');
    expect(loanStatusOf('archived', 0n, '2027-01-01', NOW)).toBe('archived');
  });

  it('dư nợ 0 ⇒ tất toán; còn dư & qua hạn ⇒ quá hạn; còn dư & còn hạn ⇒ đang vay', () => {
    expect(loanStatusOf('active', 0n, '2027-01-01', NOW)).toBe('settled');
    expect(loanStatusOf('active', 10n, '2026-10-01', NOW)).toBe('overdue');
    expect(loanStatusOf('active', 10n, '2026-10-21', NOW)).toBe('active');
    expect(loanStatusOf('active', 10n, '2027-01-01', NOW)).toBe('active');
  });

  it('cảnh báo đáo hạn theo bảng chung; khoản chờ/tất toán không có cảnh báo', () => {
    expect(loanWarningOf('pending_disbursement', '2026-10-22', NOW)).toBeNull();
    expect(loanWarningOf('settled', '2026-10-22', NOW)).toBeNull();
    expect(loanWarningOf('active', '2026-10-21', NOW)?.level).toBe(3);
    expect(loanWarningOf('active', '2026-10-24', NOW)?.level).toBe(3);
    expect(loanWarningOf('active', '2026-10-28', NOW)).toMatchObject({ level: 2, tone: 'warning', bucket: '7d' });
    expect(loanWarningOf('active', '2026-11-10', NOW)).toMatchObject({ level: 1, bucket: '30d' });
    expect(loanWarningOf('active', '2027-03-01', NOW)?.level).toBe(0);
  });

  it('dư nợ = gốc − Σ phần GỐC phiếu chi đã thực thi; khoản chờ/huỷ ⇒ 0', () => {
    expect(loanOutstandingOf(1_000n, 600n, 'active')).toBe(400n);
    expect(loanOutstandingOf(1_000n, 0n, 'pending_disbursement')).toBe(0n);
    expect(loanOutstandingOf(1_000n, 0n, 'cancelled')).toBe(0n);
    expect(loanOutstandingOf(1_000n, 1_200n, 'active')).toBe(0n);
  });

  it('trả nợ tách gốc/lãi/phí: chỉ phần gốc (đã thực thi) trừ dư nợ', () => {
    const split = link({ amount_minor: 100n, split: { principal: 60n, interest: 30n, fee: 10n } });
    expect(principalPartOf(split)).toBe(60n);
    const docs = new Map<string, DocRef>([
      [D1, doc(D1, 'paid')],
      [D2, doc(D2, 'approved')],
    ]);
    const links = [
      link({ _id: 'x1', from_id: D1, amount_minor: 100n, split: { principal: 60n, interest: 30n, fee: 10n } }),
      link({ _id: 'x2', from_id: D2, amount_minor: 200n, split: null }),
    ];
    const parts = paidRepaymentParts(links, docs);
    expect(parts.principal.get(P1)).toBe(60n);
    expect(parts.interest.get(P1)).toBe(30n);
    expect(parts.fee.get(P1)).toBe(10n);
    expect(loanOutstandingOf(1_000n, parts.principal.get(P1) ?? 0n, 'active')).toBe(940n);
  });
});

describe('số tiền & tiện ích', () => {
  it('ngày nghiệp vụ → đầu ngày giờ Việt Nam (UTC+7)', () => {
    expect(businessDateStart('2026-10-21').toISOString()).toBe('2026-10-20T17:00:00.000Z');
  });

  it('phân bổ mặc định = min(phần còn lại của phiếu, của đối tượng); hết ⇒ FG-LINK-002', () => {
    expect(defaultAllocation(300n, 500n)).toBe(300n);
    expect(defaultAllocation(900n, 500n)).toBe(500n);
    expect(codeOf(() => defaultAllocation(0n, 500n))).toBe('FG-LINK-002');
    expect(codeOf(() => defaultAllocation(-5n, 500n))).toBe('FG-LINK-002');
  });

  it('số tiền dương: chuỗi hợp lệ > 0; còn lại ⇒ FG-VAL-001', () => {
    expect(positiveMinor('100', 'amount')).toBe(100n);
    expect(codeOf(() => positiveMinor('0', 'amount'))).toBe('FG-VAL-001');
    expect(codeOf(() => positiveMinor('-5', 'amount'))).toBe('FG-VAL-001');
    expect(codeOf(() => positiveMinor('abc', 'amount'))).toBe('FG-VAL-001');
  });

  it('tiền trên wire là chuỗi minor units', () => {
    expect(wireMoney(123_000n)).toEqual({ minor: '123000', currency: 'VND', decimals: 0 });
  });

  it('escape regex và lọc ID hợp lệ', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    expect(validIds([P1, 'bad', P1, null, D2])).toEqual([P1, D2]);
  });

  it('sumBy cộng theo khoá, có bộ lọc', () => {
    const links = [link({ to_id: P1, amount_minor: 5n }), link({ to_id: P1, amount_minor: 7n }), link({ to_id: P2, amount_minor: 9n })];
    const m = sumBy(links, (l) => l.to_id, (l) => l.amount_minor ?? 0n, (l) => l.to_id !== P2);
    expect(m.get(P1)).toBe(12n);
    expect(m.get(P2)).toBeUndefined();
  });
});

describe('hợp đồng vào (zod) v2', () => {
  const amount = { amount_minor: '1000000', currency: 'VND' };

  it('POST công nợ: đối tác và hướng bắt buộc; không còn tên nhập tự do', () => {
    expect(debtCreateBody.safeParse({ value: amount, due_date: '2026-12-31' }).success).toBe(false);
    expect(debtCreateBody.safeParse({ partner_id: P1, value: amount, due_date: '2026-12-31' }).success).toBe(false);
    expect(debtCreateBody.safeParse({ partner_id: P1, direction: 'sideways', value: amount, due_date: '2026-12-31' }).success).toBe(false);
    const ok = debtCreateBody.parse({ partner_id: P1, direction: 'payable', value: amount, due_date: '2026-12-31', party_name: 'bỏ qua' });
    expect(ok.direction).toBe('payable');
    expect(ok.priority).toBe('normal');
    expect('party_name' in ok).toBe(false);
  });

  it('PATCH công nợ không đặt mặc định (không ghi đè giá trị cũ)', () => {
    const parsed = debtUpdateBody.parse({ note: 'ghi chú' });
    expect(parsed).toEqual({ note: 'ghi chú' });
  });

  it('POST nợ ngân hàng: ngân hàng (partner_id) bắt buộc; bank_name bị bỏ qua; mặc định kỳ trả', () => {
    expect(loanCreateBody.safeParse({ amount, maturity_date: '2027-01-01' }).success).toBe(false);
    const parsed = loanCreateBody.parse({ partner_id: P1, bank_name: 'Tự do', amount, maturity_date: '2027-01-01' });
    expect(parsed.payment_frequency).toBe('maturity');
    expect(parsed.repayment_method).toBe('interest_only');
    expect(parsed.interest_rate).toBe('0');
    expect('bank_name' in parsed).toBe(false);
  });

  it('PATCH nợ ngân hàng không đặt mặc định cho kỳ trả', () => {
    expect(loanUpdateBody.parse({ note: 'x' })).toEqual({ note: 'x' });
  });

  it('gán trả nợ: tách gốc/lãi/phí, thiếu phần nào mặc định 0', () => {
    const parsed = loanRepaymentBody.parse({ document_id: D1, split: { principal: '100' } });
    expect(parsed.split).toEqual({ principal: '100', interest: '0', fee: '0' });
  });

  it('nhập Excel: phải có partner_id hoặc partner_code (không khớp theo tên)', () => {
    const base = { amount, maturity_date: '2027-01-01' };
    expect(loanImportRow.safeParse(base).success).toBe(false);
    expect(loanImportRow.safeParse({ ...base, bank_name: 'BIDV' }).success).toBe(false);
    expect(loanImportRow.safeParse({ ...base, partner_code: 'DT-2026-00001' }).success).toBe(true);
  });

  it('lý do: gỡ liên kết BẮT BUỘC ≥ 5 ký tự (không mặc định); huỷ khoản bắt buộc ≥ 5 ký tự', () => {
    expect(unlinkBody.safeParse({ reason: 'abc' }).success).toBe(false);
    expect(unlinkBody.safeParse({}).success).toBe(false);
    expect(unlinkBody.safeParse({ reason: 'Nhập nhầm ngân hàng' }).success).toBe(true);
    expect(loanCancelBody.safeParse({ reason: 'abcd' }).success).toBe(false);
    expect(loanCancelBody.safeParse({ reason: 'Hủy do ngân hàng từ chối' }).success).toBe(true);
  });

  it('ứng viên: từ khoá tìm kiếm tuỳ chọn', () => {
    expect(linkCandidatesQuery.parse({})).toEqual({});
  });

  it('mọi hợp đồng dùng cho route sinh được JSON Schema (tài liệu OpenAPI)', () => {
    const schemas = [
      debtCreateBody,
      debtUpdateBody,
      debtOffsetBody,
      unlinkBody,
      debtAgingQuery,
      linkCandidatesQuery,
      loanCreateBody,
      loanUpdateBody,
      loanRepaymentBody,
      loanDisbursementBody,
      loanCancelBody,
      loanListQuery,
      debtListQuery,
    ];
    for (const s of schemas) {
      expect(() => toJsonSchema(s)).not.toThrow();
    }
  });
});

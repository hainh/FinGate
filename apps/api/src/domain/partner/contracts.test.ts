import { describe, expect, it } from 'vitest';
import * as routeSchemas from '../../routes/schemas.ts';
import { parseTypeParam, partnerDirectoryQuery, partnerSettleBody, partnerTabQuery } from './contracts.ts';

const CO = '6650a1b2c3d4e5f600000001';
const NH = '6650a1b2c3d4e5f600000021';
const D1 = '6650a1b2c3d4e5f600000031';
const L1 = '6650a1b2c3d4e5f600000041';

describe('parseTypeParam — tham số loại trong query', () => {
  it('chấp nhận dạng gộp bằng dấu phẩy và dạng lặp khoá', () => {
    expect(parseTypeParam('bank,customer')).toEqual(['bank', 'customer']);
    expect(parseTypeParam(['bank', 'supplier'])).toEqual(['bank', 'supplier']);
    expect(parseTypeParam(' bank , ,customer ')).toEqual(['bank', 'customer']);
  });

  it('rỗng / thiếu ⇒ undefined (không lọc)', () => {
    expect(parseTypeParam(undefined)).toBeUndefined();
    expect(parseTypeParam('')).toBeUndefined();
    expect(parseTypeParam(' , ')).toBeUndefined();
  });
});

describe('partnerDirectoryQuery', () => {
  it('mặc định: 50 dòng, bỏ qua trạng thái (all), không lọc', () => {
    const q = partnerDirectoryQuery.parse({});
    expect(q).toMatchObject({ status: 'all', limit: 50, offset: 0 });
  });

  it('đầu kỳ sau cuối kỳ ⇒ không hợp lệ', () => {
    expect(partnerDirectoryQuery.safeParse({ period_from: '2026-10-10', period_to: '2026-10-01' }).success).toBe(false);
    expect(partnerDirectoryQuery.safeParse({ period_from: '2026-10-01', period_to: '2026-10-10' }).success).toBe(true);
  });

  it('giới hạn số dòng 1..200', () => {
    expect(partnerDirectoryQuery.safeParse({ limit: 0 }).success).toBe(false);
    expect(partnerDirectoryQuery.safeParse({ limit: 201 }).success).toBe(false);
    expect(partnerDirectoryQuery.safeParse({ limit: '200' }).success).toBe(true);
  });
});

describe('partnerTabQuery', () => {
  it('kind chỉ nhận spend / income; limit mặc định 100', () => {
    expect(partnerTabQuery.parse({})).toEqual({ limit: 100 });
    expect(partnerTabQuery.safeParse({ kind: 'rollover' }).success).toBe(false);
  });
});

describe('partnerSettleBody — trả nợ', () => {
  const debtOnly = { items: [{ debt_voucher_id: D1, amount_minor: '5000000' }] };

  it('khoản công nợ hợp lệ', () => {
    expect(partnerSettleBody.safeParse(debtOnly).success).toBe(true);
  });

  it('phải chọn ít nhất một khoản', () => {
    const r = partnerSettleBody.safeParse({ items: [], loans: [] });
    expect(r.success).toBe(false);
  });

  it('số tiền phải là số nguyên dương (chuỗi minor units)', () => {
    expect(partnerSettleBody.safeParse({ items: [{ debt_voucher_id: D1, amount_minor: '0' }] }).success).toBe(false);
    expect(partnerSettleBody.safeParse({ items: [{ debt_voucher_id: D1, amount_minor: '12.5' }] }).success).toBe(false);
    expect(partnerSettleBody.safeParse({ items: [{ debt_voucher_id: D1, amount_minor: 100 }] }).success).toBe(false);
  });

  it('không chọn trùng một khoản công nợ / một khoản vay', () => {
    expect(partnerSettleBody.safeParse({ items: [{ debt_voucher_id: D1, amount_minor: '1' }, { debt_voucher_id: D1, amount_minor: '2' }] }).success).toBe(false);
    expect(partnerSettleBody.safeParse({ loans: [{ bank_debt_id: L1, amount_minor: '1' }, { bank_debt_id: L1, amount_minor: '2' }] }).success).toBe(false);
  });

  it('tách gốc / lãi / phí: tổng phải bằng số tiền trả', () => {
    const ok = partnerSettleBody.safeParse({
      loans: [{ bank_debt_id: L1, amount_minor: '120', split: { principal: '100', interest: '20', fee: '0' } }],
    });
    expect(ok.success).toBe(true);
    const bad = partnerSettleBody.safeParse({
      loans: [{ bank_debt_id: L1, amount_minor: '120', split: { principal: '100', interest: '10', fee: '0' } }],
    });
    expect(bad.success).toBe(false);
  });

  it('ngày nghiệp vụ theo YYYY-MM-DD, tài khoản nhận / chi là ObjectId hoặc null', () => {
    expect(partnerSettleBody.safeParse({ ...debtOnly, business_date: '2026-10-21' }).success).toBe(true);
    expect(partnerSettleBody.safeParse({ ...debtOnly, business_date: '21/10/2026' }).success).toBe(false);
    expect(partnerSettleBody.safeParse({ ...debtOnly, receipt_account_id: null }).success).toBe(true);
    expect(partnerSettleBody.safeParse({ ...debtOnly, payment_account_id: 'abc' }).success).toBe(false);
  });

  it('một lần trả có thể gồm khoản vay của ngân hàng và có company bị bỏ qua (không thuộc body)', () => {
    const r = partnerSettleBody.safeParse({ loans: [{ bank_debt_id: L1, amount_minor: '50' }], company_id: CO });
    expect(r.success).toBe(true);
    expect(NH).toMatch(/^[0-9a-f]{24}$/);
  });
});

describe('hợp đồng OpenAPI của route đối tác', () => {
  it('sinh JSON Schema không lỗi khi nạp module (routes/schemas.ts)', () => {
    for (const key of [
      'partnerCreateBodySchema',
      'partnerUpdateBodySchema',
      'partnerCopyBodySchema',
      'partnerMergeBodySchema',
      'partnerDirectoryQuerySchema',
      'partnerTabQuerySchema',
      'partnerSettleBodySchema',
    ] as const) {
      const schema = routeSchemas[key] as Record<string, unknown>;
      expect(schema, key).toBeTruthy();
      expect(schema['type'], key).toBe('object');
    }
  });
});

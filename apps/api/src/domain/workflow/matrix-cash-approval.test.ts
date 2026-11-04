/**
 * `resolveMatrix` + cài đặt "Duyệt tiền mặt" (ADM-04, tab "Duyệt tiền mặt"):
 *  - phiếu THU/CHI quỹ tiền mặt (`cash` / `fund`) của công ty CHƯA tick → chuỗi bỏ bước Kế toán trưởng,
 *    `cash_overridden: true` (đi thẳng tới cấp duyệt kế tiếp);
 *  - công ty ĐANG tick → chuỗi như ma trận;
 *  - phiếu NGÂN HÀNG / loại khác → không áp cài đặt;
 *  - ma trận riêng của công ty (có dòng khớp) cũng bị áp cài đặt như chuỗi mặc định.
 *
 * `Models` được mock thay vì nối DB: resolver chỉ ĐỌC `ApprovalMatrix` + `Setting`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CASH_APPROVAL_SETTING_KEY } from '@fingate/shared';

const env = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  return {
    state: { matrices: [] as Row[], settings: [] as Row[] },
    /** truy vấn `find().sort().lean()` tối giản */
    cursor: (rows: Row[]) => {
      const q = {
        sort: () => q,
        lean: async () => rows,
      };
      return q;
    },
  };
});

vi.mock('../../db/models.ts', () => ({
  Models: {
    ApprovalMatrix: { find: (filter: Record<string, unknown>) => env.cursor(env.state.matrices.filter((m) => m.doc_kind === filter.doc_kind)) },
    Setting: {
      findOne: (filter: Record<string, unknown>) => ({
        lean: async () => env.state.settings.find((s) => s.key === filter.key) ?? null,
      }),
    },
  },
}));

import { resolveMatrix } from './matrix.ts';

const COMPANY_A = 'a'.repeat(24);
const COMPANY_B = 'b'.repeat(24);

/** Bật "khoản tiền mặt phải qua KTT duyệt" cho một công ty. */
function enableCashKtt(companyId: string): void {
  env.state.settings = [{ key: CASH_APPROVAL_SETTING_KEY, value: { companies: { [companyId]: true } } }];
}

beforeEach(() => {
  env.state.matrices = [];
  env.state.settings = [];
});

describe('resolveMatrix — cài đặt "Duyệt tiền mặt" theo công ty', () => {
  it('công ty chưa tick: phiếu chi tiền mặt dưới 50 triệu bỏ KTT → chỉ còn PGĐ', async () => {
    const m = await resolveMatrix({ company_id: COMPANY_A, kind: 'spend', amount_minor: 1_000_000n, fund: 'cash' });
    expect(m.steps.map((s) => s.role)).toEqual(['deputy_director']);
    expect(m.steps.map((s) => s.order)).toEqual([1]);
    expect(m.cash_overridden).toBe(true);
  });

  it('công ty chưa tick: phiếu thu Quỹ phụ (`fund`) cũng bỏ KTT', async () => {
    const m = await resolveMatrix({ company_id: COMPANY_A, kind: 'income', amount_minor: 1_000_000n, fund: 'fund' });
    expect(m.steps.map((s) => s.role)).toEqual(['deputy_director', 'director', 'deputy_chairman']);
    expect(m.cash_overridden).toBe(true);
  });

  it('công ty ĐANG tick: giữ nguyên chuỗi ma trận (có KTT)', async () => {
    enableCashKtt(COMPANY_A);
    const m = await resolveMatrix({ company_id: COMPANY_A, kind: 'spend', amount_minor: 1_000_000n, fund: 'cash' });
    expect(m.steps.map((s) => s.role)).toEqual(['chief_accountant', 'deputy_director']);
    expect(m.cash_overridden).toBe(false);
  });

  it('cài đặt riêng theo công ty: bật CTA không làm đổi phiếu của CTB', async () => {
    enableCashKtt(COMPANY_A);
    const m = await resolveMatrix({ company_id: COMPANY_B, kind: 'spend', amount_minor: 1_000_000n, fund: 'cash' });
    expect(m.steps.map((s) => s.role)).toEqual(['deputy_director']);
    expect(m.cash_overridden).toBe(true);
  });

  it('phiếu NGÂN HÀNG không bị áp cài đặt (giữ nguyên bước KTT)', async () => {
    const m = await resolveMatrix({ company_id: COMPANY_A, kind: 'spend', amount_minor: 1_000_000n, fund: 'bank' });
    expect(m.steps.map((s) => s.role)).toEqual(['chief_accountant', 'deputy_director']);
    expect(m.cash_overridden).toBe(false);
  });

  it('không truyền fund (tương thích nơi gọi cũ) → chuỗi ma trận nguyên vẹn', async () => {
    const m = await resolveMatrix({ company_id: COMPANY_A, kind: 'income', amount_minor: 1_000_000n });
    expect(m.steps.map((s) => s.role)).toEqual(['chief_accountant', 'deputy_director', 'director', 'deputy_chairman']);
    expect(m.cash_overridden).toBe(false);
  });

  it('loại khác (đáo hạn) không bị áp cài đặt dù quỹ là tiền mặt', async () => {
    const m = await resolveMatrix({ company_id: COMPANY_A, kind: 'rollover', amount_minor: 1_000_000n, fund: 'cash' });
    expect(m.steps.map((s) => s.role)).toEqual(['chief_accountant', 'deputy_director', 'director', 'deputy_chairman']);
    expect(m.cash_overridden).toBe(false);
  });

  it('ma trận riêng của công ty cũng bị áp cài đặt khi chưa tick', async () => {
    env.state.matrices = [
      {
        _id: 'm1',
        company_id: COMPANY_A,
        doc_kind: 'spend',
        category_id: null,
        amount_min_minor: 0n,
        amount_max_minor: null,
        steps: [
          { order: 1, role: 'chief_accountant' },
          { order: 2, role: 'director' },
        ],
        version: 3,
        label: 'Ma trận riêng CTA',
        effective_from: new Date(0),
      },
    ];
    const noKtt = await resolveMatrix({ company_id: COMPANY_A, kind: 'spend', amount_minor: 2_000_000n, fund: 'cash' });
    expect(noKtt.steps.map((s) => s.role)).toEqual(['director']);
    expect(noKtt.steps.map((s) => s.order)).toEqual([1]);
    expect(noKtt.cash_overridden).toBe(true);
    expect(noKtt.matrix_version).toBe(3);

    enableCashKtt(COMPANY_A);
    const withKtt = await resolveMatrix({ company_id: COMPANY_A, kind: 'spend', amount_minor: 2_000_000n, fund: 'cash' });
    expect(withKtt.steps.map((s) => s.role)).toEqual(['chief_accountant', 'director']);
    expect(withKtt.cash_overridden).toBe(false);
  });

  it('vượt ngưỡng Chủ tịch: bỏ KTT nhưng vẫn giữ bước Chairman thêm sau cùng', async () => {
    const m = await resolveMatrix({
      company_id: COMPANY_A,
      kind: 'spend',
      amount_minor: 6_000_000_000n,
      fund: 'cash',
    });
    expect(m.steps.map((s) => s.role)).toEqual(['deputy_director', 'director', 'deputy_chairman', 'chairman']);
    expect(m.steps.map((s) => s.order)).toEqual([1, 2, 3, 4]);
    expect(m.cash_overridden).toBe(true);
  });
});

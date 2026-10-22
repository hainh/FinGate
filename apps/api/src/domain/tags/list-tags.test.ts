/**
 * Phân trang danh bạ tag (GET /tags → listTags): offset/limit đi xuống truy vấn, `total` là số dòng khớp
 * bộ lọc (không phải số dòng của trang), thứ tự có khoá phụ `_id`. DB được thay bằng bản giả trong bộ nhớ.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TAG_COLOR_DEFAULT } from '@fingate/shared';
import { listTags } from './index.ts';

type Row = Record<string, unknown>;
interface FindOpts {
  sort?: Record<string, 1 | -1>;
  skip?: number;
  limit?: number;
}

const state = vi.hoisted(() => ({
  rows: [] as Row[],
  finds: [] as Array<{ filter: Record<string, unknown>; opts: FindOpts }>,
}));

vi.mock('../../db/models.ts', () => ({ Models: {} }));
vi.mock('../../db/cas.ts', () => ({ cas: vi.fn() }));
vi.mock('../audit/index.ts', () => ({ buildHistoryEntry: vi.fn(), mirrorAudit: vi.fn() }));
vi.mock('../../lib/mongo.ts', () => ({
  oid: (id: string) => ({ $oid: id }),
  scopedAggregate: vi.fn(async () => []),
  scopedById: vi.fn(async () => null),
  scopedOne: vi.fn(async () => null),
  scopedCount: vi.fn(async () => state.rows.length),
  scopedFind: vi.fn(async (_model: unknown, _scope: unknown, filter: Record<string, unknown>, opts: FindOpts) => {
    state.finds.push({ filter, opts });
    const from = opts.skip ?? 0;
    return state.rows.slice(from, from + (opts.limit ?? state.rows.length));
  }),
}));

const COMPANY = '6aace643253531e3b1e1be55';

/** Danh bạ đã sắp theo tên chuẩn hoá: "Tag 1" … "Tag n". */
function tagRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: `t${String(i + 1).padStart(3, '0')}`,
    company_id: COMPANY,
    name: `Tag ${i + 1}`,
    name_key: `tag ${i + 1}`,
    color: TAG_COLOR_DEFAULT,
    hidden: false,
    updated_at: new Date('2026-01-01T00:00:00Z'),
  }));
}

const ALL_COMPANIES = { companyIds: null };

describe('listTags — phân trang danh bạ tag', () => {
  beforeEach(() => {
    state.rows = [];
    state.finds = [];
  });

  it('trả đúng cửa sổ offset/limit; total là số dòng khớp bộ lọc, không phải số dòng của trang', async () => {
    state.rows = tagRows(7);
    const page = await listTags(ALL_COMPANIES, { companyId: COMPANY, includeHidden: true, offset: 5, limit: 3 });
    expect(page.items.map((t) => t.name)).toEqual(['Tag 6', 'Tag 7']);
    expect(page.total).toBe(7);
    expect(state.finds[0]?.opts).toMatchObject({ skip: 5, limit: 3 });
  });

  it('thứ tự ổn định qua các trang: sắp theo tên chuẩn hoá rồi đến _id', async () => {
    state.rows = tagRows(1);
    await listTags(ALL_COMPANIES, { companyId: COMPANY, limit: 500 });
    expect(state.finds[0]?.opts.sort).toEqual({ name_key: 1, _id: 1 });
  });

  it('không offset thì bắt đầu từ dòng đầu; tag đã ẩn bị loại khi không bật includeHidden; q được chuẩn hoá và escape', async () => {
    state.rows = tagRows(1);
    await listTags(ALL_COMPANIES, { companyId: COMPANY, q: '  A (B)  ', limit: 100 });
    expect(state.finds[0]?.opts.skip).toBe(0);
    expect(state.finds[0]?.filter).toMatchObject({ hidden: { $ne: true }, name_key: { $regex: 'a \\(b\\)' } });
  });
});

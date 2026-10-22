/**
 * Tạo tag đồng thời: unique index (company_id, name_key) chặn bản thứ hai (E11000) → createTag phải trả chính
 * tag đã có (created = false), không tạo trùng và không ném lỗi thô. Nhánh này chỉ xảy ra khi index tồn tại
 * (db/indexes.ts). DB được thay bằng bản giả trong bộ nhớ.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TAG_COLOR_DEFAULT } from '@fingate/shared';
import { createTag, type TagCallCtx } from './index.ts';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  /** Kết quả lần lượt của các lần tìm theo tên (lần đầu: chưa có; lần sau: tag của lượt thắng). */
  lookups: [] as Array<Row | null>,
  /** Lỗi `Tag.create` ném ra (null = thành công). */
  createError: null as unknown,
  creates: 0,
  audits: 0,
}));

vi.mock('../../db/models.ts', () => ({
  Models: {
    Tag: {
      create: vi.fn(async () => {
        state.creates++;
        if (state.createError) throw state.createError;
        return { _id: 'new-tag-id' };
      }),
    },
    Document: {},
  },
}));
vi.mock('../../db/cas.ts', () => ({ cas: vi.fn() }));
vi.mock('../audit/index.ts', () => ({
  buildHistoryEntry: vi.fn(),
  mirrorAudit: vi.fn(async () => {
    state.audits++;
  }),
}));
vi.mock('../../lib/mongo.ts', () => ({
  oid: (id: string) => ({ $oid: id }),
  scopedAggregate: vi.fn(async () => []),
  scopedById: vi.fn(async () => null),
  scopedOne: vi.fn(async () => (state.lookups.length ? (state.lookups.shift() ?? null) : null)),
  scopedCount: vi.fn(async () => 0),
  scopedFind: vi.fn(async () => []),
}));

const COMPANY = '6aace643253531e3b1e1be55';
const EXISTING_ID = '6ad99a2fb22d5d8479ce0131';
const ctx: TagCallCtx = {
  actor: { user_id: '6aab60429c678ed5e6125348', name: 'Kế toán', role: 'staff' },
  scope: { companyIds: [COMPANY] },
};

const dupKeyError = (): Error =>
  Object.assign(new Error('E11000 duplicate key error collection: fingate.tags'), { code: 11000 });

function existingRow(over: Row = {}): Row {
  return {
    _id: EXISTING_ID,
    company_id: COMPANY,
    name: 'Chi phí vận chuyển',
    name_key: 'chi phí vận chuyển',
    color: TAG_COLOR_DEFAULT,
    hidden: false,
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('createTag — hai yêu cầu cùng tạo một tên', () => {
  beforeEach(() => {
    state.lookups = [];
    state.createError = null;
    state.creates = 0;
    state.audits = 0;
  });

  it('tạo thành công khi chưa có tên trùng: created = true và có audit', async () => {
    state.lookups = [null];
    const res = await createTag(ctx, { company_id: COMPANY, name: 'Tên mới' });
    expect(res.created).toBe(true);
    expect(state.creates).toBe(1);
    expect(state.audits).toBe(1);
  });

  it('bản thứ hai bị unique index chặn → trả tag đã có, created = false, không ghi audit', async () => {
    state.lookups = [null, existingRow()];
    state.createError = dupKeyError();
    const res = await createTag(ctx, { company_id: COMPANY, name: '  Chi phí   vận chuyển ' });
    expect(res.created).toBe(false);
    expect(res.tag._id).toBe(EXISTING_ID);
    expect(res.tag.name).toBe('Chi phí vận chuyển');
    expect(state.creates).toBe(1);
    expect(state.audits).toBe(0);
  });

  it('bản thứ hai bị chặn, tag đã có đang bị ẩn → FG-TAG-001 (cần kế toán trưởng hiện lại)', async () => {
    state.lookups = [null, existingRow({ hidden: true })];
    state.createError = dupKeyError();
    await expect(
      createTag(ctx, { company_id: COMPANY, name: 'Chi phí vận chuyển' }),
    ).rejects.toMatchObject({
      code: 'FG-TAG-001',
    });
  });

  it('lỗi trùng khoá nhưng không tìm lại được tag → ném lại lỗi gốc, không nuốt lỗi', async () => {
    state.lookups = [null, null];
    state.createError = dupKeyError();
    await expect(createTag(ctx, { company_id: COMPANY, name: 'Tên mới' })).rejects.toMatchObject({
      code: 11000,
    });
  });

  it('lỗi không phải trùng khoá được ném nguyên vẹn', async () => {
    state.lookups = [null];
    state.createError = new Error('mất kết nối');
    await expect(createTag(ctx, { company_id: COMPANY, name: 'Tên mới' })).rejects.toThrow(
      'mất kết nối',
    );
  });
});

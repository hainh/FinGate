/**
 * applyIndexes phải gọi createIndex của driver cho MỌI index khai báo ở INDEXES. Hồi quy: Model.createIndexes
 * của Mongoose 9 bỏ qua danh sách truyền vào, nên tag / documents / partners … không có index nào trong DB.
 * DB được thay bằng bản giả ghi lại từng lệnh createIndex theo tên model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyIndexes, INDEXES } from './indexes.ts';

interface IndexCall {
  key: Record<string, unknown>;
  options: Record<string, unknown>;
}

const fake = vi.hoisted(() => ({
  calls: new Map<string, IndexCall[]>(),
  /** Nhãn `Model:field1,field2` của các index mà "DB" từ chối. */
  failing: new Set<string>(),
}));

vi.mock('./models.ts', () => {
  type FakeModel = {
    collection: {
      createIndex: (
        key: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => Promise<string>;
    };
  };
  const models = new Map<string, FakeModel>();
  const modelFor = (name: string): FakeModel => {
    const existing = models.get(name);
    if (existing) return existing;
    const model: FakeModel = {
      collection: {
        createIndex: async (key, options = {}) => {
          fake.calls.set(name, [...(fake.calls.get(name) ?? []), { key, options }]);
          if (fake.failing.has(`${name}:${Object.keys(key).join(',')}`)) {
            throw new Error('simulated failure\nsecond line');
          }
          return 'ok';
        },
      },
    };
    models.set(name, model);
    return model;
  };
  return {
    Models: new Proxy(
      {},
      { get: (_target, name) => (typeof name === 'string' ? modelFor(name) : undefined) },
    ),
  };
});

const callsOf = (model: string): IndexCall[] => fake.calls.get(model) ?? [];
const totalCalls = (): number =>
  [...fake.calls.values()].reduce((sum, list) => sum + list.length, 0);
const declaredCount = (): number =>
  Object.values(INDEXES).reduce((sum, defs) => sum + defs.length, 0);

describe('applyIndexes — mọi index khai báo đều được tạo', () => {
  beforeEach(() => {
    fake.calls.clear();
    fake.failing.clear();
  });

  it('gọi createIndex cho từng index khai báo và trả về đúng số index đã bảo đảm', async () => {
    const applied = await applyIndexes(() => {});
    expect(totalCalls()).toBe(declaredCount());
    expect(applied).toBe(declaredCount());
  });

  it('mọi collection khai báo đều có model: không dòng "bỏ qua" nào', async () => {
    const lines: string[] = [];
    await applyIndexes((m) => lines.push(m));
    expect(lines.filter((l) => l.includes('bỏ qua'))).toEqual([]);
  });

  it('giữ đúng khoá và tuỳ chọn của index chống trùng và index truy vấn', async () => {
    await applyIndexes(() => {});
    // tag: unique theo (công ty, tên chuẩn hoá) — v2 §6.2
    expect(callsOf('Tag')).toContainEqual({
      key: { company_id: 1, name_key: 1 },
      options: expect.objectContaining({ unique: true }),
    });
    // liên kết nghiệp vụ: chỉ một liên kết ĐANG HIỆU LỰC cho cùng cặp + quan hệ — v2 §14.2
    expect(callsOf('BusinessLink')).toContainEqual({
      key: { from_id: 1, to_id: 1, relation: 1 },
      options: expect.objectContaining({
        unique: true,
        partialFilterExpression: { status: 'active' },
      }),
    });
    // mã đối tác unique toàn hệ thống; idem_key của lượt chạy tự động unique
    expect(callsOf('Partner')).toContainEqual({
      key: { code: 1 },
      options: expect.objectContaining({ unique: true }),
    });
    expect(callsOf('AutomationRun')).toContainEqual({
      key: { idem_key: 1 },
      options: expect.objectContaining({ unique: true }),
    });
    // phiếu: tab "Phiếu thu/chi" của đối tác và lọc theo tag (v2 §5.3, §6.2)
    expect(callsOf('Document')).toContainEqual({
      key: { company_id: 1, partner_id: 1 },
      options: expect.any(Object),
    });
    expect(callsOf('Document')).toContainEqual({
      key: { company_id: 1, tag_ids: 1 },
      options: expect.any(Object),
    });
    // TTL của outbox: dọn bản đã xử lý sau 30 ngày
    expect(callsOf('DomainEvent')).toContainEqual({
      key: { processed_at: 1 },
      options: expect.objectContaining({ expireAfterSeconds: 30 * 86_400 }),
    });
  });

  it('không đặt tên index tuỳ ý: để MongoDB dùng tên mặc định, khớp index schema đã có cùng khoá', async () => {
    await applyIndexes(() => {});
    for (const list of fake.calls.values()) {
      for (const call of list) expect(call.options).not.toHaveProperty('name');
    }
  });

  it('một index bị từ chối không chặn các index còn lại, không tính là đã tạo, và được ghi log', async () => {
    fake.failing.add('Tag:company_id,name_key');
    const lines: string[] = [];
    const applied = await applyIndexes((m) => lines.push(m));
    expect(applied).toBe(declaredCount() - 1);
    expect(totalCalls()).toBe(declaredCount());
    expect(lines).toContain('  ! tags.company_id_1_name_key_1: simulated failure');
    expect(lines).toContain('  ! tags: 0/1 index');
  });
});

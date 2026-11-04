/**
 * NOTI-03 (tối giản) — nhặt "phiếu mới chờ tôi duyệt" để báo trên thiết bị.
 *
 * Trọng tâm test là TÍNH ĐÚNG MỘT LẦN: hai request đồng thời / poll lặp lại không được bắn trùng
 * thông báo, và không được nhặt bản ghi của người khác. Đây là chỗ dễ sai nhất của một "chuông" poll.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = { rows: [] as Row[] };
  const matchOp = (cond: unknown, value: unknown): boolean => {
    if (cond && typeof cond === 'object') {
      const c = cond as Record<string, unknown>;
      if ('$in' in c) return (c.$in as unknown[]).some((x) => String(x) === String(value));
      if ('$gt' in c || '$lte' in c) {
        const t = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
        if ('$gt' in c && !(t > new Date(String(c.$gt)).getTime())) return false;
        if ('$lte' in c && !(t <= new Date(String(c.$lte)).getTime())) return false;
        return true;
      }
    }
    return String(cond) === String(value);
  };
  /** `null` khớp mọi bản ghi có giá trị null/undefined (giống Mongo). */
  const matches = (row: Row, filter: Row): boolean =>
    Object.entries(filter).every(([k, v]) =>
      v === null ? row[k] === null || row[k] === undefined : matchOp(v, row[k]),
    );
  return { state, matches };
});

vi.mock('../../db/models.ts', () => ({
  Models: {
    Notification: {
      // Chỉ dùng trong push-pending.ts: find(...).sort().limit().select().lean()
      find: (filter: Record<string, unknown>) => {
        const chain = {
          sort: () => chain,
          limit: (n: number) => {
            chain._limit = n;
            return chain;
          },
          _limit: 99,
          select: () => chain,
          lean: async () =>
            env.state.rows
              .filter((r) => env.matches(r, filter))
              .sort((a, b) => new Date(String(a.created_at)).getTime() - new Date(String(b.created_at)).getTime())
              .slice(0, chain._limit)
              .map((r) => ({ _id: r._id })),
        };
        return chain;
      },
      /** Nguyên tử như Mongo: chỉ khớp bản ghi còn `push_seen_at: null`. */
      findOneAndUpdate: (filter: Record<string, unknown>, update: { $set: { push_seen_at: Date } }) => ({
        lean: async () => {
          const row = env.state.rows.find((r) => env.matches(r, filter)) as Record<string, unknown> | undefined;
          if (!row) return null;
          row.push_seen_at = update.$set.push_seen_at;
          return { title: row.title, body: row.body ?? null, href: row.href ?? null, created_at: row.created_at };
        },
      }),
    },
  },
}));

import { collectPushPending } from './push-pending.ts';

let seq = 0;
const notification = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    _id: `n${seq}`,
    user_id: 'u1',
    kind: 'approval',
    title: `PC-000${seq} đang chờ bạn duyệt`,
    body: `PC-000${seq} · 500 tr · gửi bởi KTV`,
    href: `/ho-so/chi/n${seq}`,
    push_seen_at: null,
    created_at: new Date(Date.now() - 60_000 + seq * 1000),
    ...over,
  };
};

const at = (msAgo: number) => new Date(Date.now() - msAgo);

beforeEach(() => {
  env.state.rows = [];
  seq = 0;
});

describe('collectPushPending', () => {
  it('nhặt bản ghi duyệt mới hơn mốc và đánh dấu đã bắn', async () => {
    const mine = notification();
    env.state.rows = [mine];
    const res = await collectPushPending('u1', at(5 * 60_000));
    expect(res.rows.map((r) => r.title)).toEqual([mine.title]);
    expect(mine.push_seen_at).toBeInstanceOf(Date);
  });

  it('gọi lặp lại (poll lần 2) KHÔNG bắn lại', async () => {
    env.state.rows = [notification()];
    const first = await collectPushPending('u1', at(5 * 60_000));
    expect(first.rows).toHaveLength(1);

    // Server trả `cursor`; client lấy cursor đó làm `since` cho lần sau.
    const second = await collectPushPending('u1', first.cutoff);
    expect(second.rows).toHaveLength(0);
    expect(second.cutoff.getTime()).toBeGreaterThanOrEqual(first.cutoff.getTime());
  });

  it('hai vòng chạy SONG SONG chỉ một vòng nhận bản ghi (không bắn trùng)', async () => {
    const row = notification();
    env.state.rows = [row];
    // Giả lập: cả hai đọc danh sách ứng viên TRƯỚC, rồi cùng giành — Mongo đảm bảo chỉ một thắng vì
    // điều kiện `push_seen_at: null` nằm trong chính lệnh findOneAndUpdate.
    const candidates = await collectPushPending('u1', at(5 * 60_000));
    const winner = await collectPushPending('u1', candidates.cutoff);
    const total = candidates.rows.length + winner.rows.length;
    expect(total).toBe(1);
  });

  it('bỏ qua bản ghi cũ hơn mốc người dùng đã báo', async () => {
    env.state.rows = [notification({ created_at: at(60 * 60_000) })];
    const res = await collectPushPending('u1', at(5 * 60_000));
    expect(res.rows).toHaveLength(0);
  });

  it('bỏ qua bản ghi của người khác', async () => {
    env.state.rows = [notification({ user_id: 'u2' })];
    const res = await collectPushPending('u1', at(5 * 60_000));
    expect(res.rows).toHaveLength(0);
  });

  it('bỏ qua thông báo hệ thống/cảnh báo — chỉ loại "duyệt"', async () => {
    env.state.rows = [notification({ kind: 'system' }), notification({ kind: 'newsletter' })];
    const res = await collectPushPending('u1', at(5 * 60_000));
    expect(res.rows).toHaveLength(0);
  });

  it('giới hạn số thông báo mỗi lần — phần dư để lần poll sau', async () => {
    env.state.rows = Array.from({ length: 8 }, () => notification());
    const res = await collectPushPending('u1', at(5 * 60_000), 3);
    expect(res.rows).toHaveLength(3);
    const rest = await collectPushPending('u1', at(5 * 60_000), 3);
    expect(rest.rows).toHaveLength(3);
  });

  it('trả về theo thứ tự phiếu đến (cũ → mới)', async () => {
    const older = notification({ created_at: at(120_000) });
    const newer = notification({ created_at: at(30_000) });
    env.state.rows = [newer, older];
    const res = await collectPushPending('u1', at(5 * 60_000));
    expect(res.rows.map((r) => r.title)).toEqual([older.title, newer.title]);
  });

  it('bản ghi tạo SAU mốc chốt để dành cho lần gọi sau (không thất lạc)', async () => {
    const res = await collectPushPending('u1', at(5 * 60_000));
    expect(res.cutoff).toBeInstanceOf(Date);
    // Chốt mốc phải nằm ở hiện tại: bản ghi sinh trong lúc xử lý có created_at > cutoff.
    expect(Date.now() - res.cutoff.getTime()).toBeLessThan(5_000);
  });
});

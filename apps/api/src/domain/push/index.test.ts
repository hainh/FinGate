/**
 * Web Push NOTI-03 — gửi thông báo "chờ tôi duyệt" tới thiết bị, KỂ CẢ KHI APP ĐÃ ĐÓNG.
 *
 * Trọng tâm: tính ĐÚNG MỘT LẦN (hai vòng chạy song song không gửi trùng), dọn subscription chết,
 * và không bao giờ ném lỗi ra ngoài (đẩy thông báo là best-effort, không được làm hỏng nghiệp vụ).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({
  state: {
    notifications: [] as Record<string, unknown>[],
    subscriptions: [] as Record<string, unknown>[],
    configured: true,
  },
  /** So khớp tối giản cho các truy vấn của deliverPendingPushes. */
  matches: (row: Record<string, unknown>, filter: Record<string, unknown>): boolean =>
    Object.entries(filter).every(([k, v]) => {
      if (v === null) return row[k] === null || row[k] === undefined;
      if (v && typeof v === 'object' && '$in' in (v as object)) {
        return ((v as { $in: unknown[] }).$in as unknown[]).some((x) => String(x) === String(row[k]));
      }
      if (v && typeof v === 'object' && '$lte' in (v as object)) {
        return (row[k] as Date).getTime() <= (v as { $lte: Date }).$lte.getTime();
      }
      return String(v) === String(row[k]);
    }),
}));

vi.mock('../../env.ts', () => ({
  getEnv: () => ({
    pushConfigured: env.state.configured,
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_SUBJECT: 'mailto:test@fingate.test',
    PUSH_INTERVAL_SECONDS: 30,
  }),
}));

vi.mock('../../db/models.ts', () => {
  const Notification = {
    find: (filter: Record<string, unknown>) => {
      const chain = {
        sort: () => chain,
        limit: (n: number) => {
          chain._limit = n;
          return chain;
        },
        _limit: 999,
        select: () => chain,
        lean: async () =>
          env.state.notifications.filter((r) => env.matches(r, filter)).slice(0, chain._limit),
      };
      return chain;
    },
    findOneAndUpdate: (filter: Record<string, unknown>, update: { $set: { push_seen_at: Date } }) => ({
      lean: async () => {
        const row = env.state.notifications.find((r) => env.matches(r, filter));
        if (!row) return null;
        row.push_seen_at = update.$set.push_seen_at;
        return row;
      },
    }),
  };
  const PushSubscription = {
    find: (filter: Record<string, unknown>) => {
      const chain = {
        limit: () => chain,
        lean: async () => env.state.subscriptions.filter((r) => env.matches(r, filter)),
      };
      return chain;
    },
    updateOne: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      const row = env.state.subscriptions.find((r) => String(r._id) === String(filter._id));
      // Giả lập `fails += 1` như Mongo `$set`.
      if (row && typeof update.$set.fails === 'number') row.fails = update.$set.fails;
      return {};
    },
    deleteOne: async (filter: Record<string, unknown>) => {
      env.state.subscriptions = env.state.subscriptions.filter((r) => String(r._id) !== String(filter._id));
      return {};
    },
  };
  return { Models: { Notification, PushSubscription } };
});

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => ({ statusCode: 201 })),
  },
}));

import { deliverPendingPushes } from './index.ts';

let seq = 0;
const notification = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    _id: `n${seq}`,
    user_id: 'u1',
    kind: 'approval',
    title: `PC-${seq} đang chờ bạn duyệt`,
    body: `PC-${seq} · 500 tr`,
    href: `/ho-so/chi/n${seq}`,
    push_seen_at: null,
    created_at: new Date(Date.now() - 10_000),
    ...over,
  };
};

const subscription = (over: Record<string, unknown> = {}) => ({
  _id: `s${(seq += 1)}`,
  user_id: 'u1',
  endpoint: 'https://push.example/ep',
  keys: { p256dh: 'k', auth: 'a' },
  fails: 0,
  ...over,
});

beforeEach(() => {
  env.state.notifications = [];
  env.state.subscriptions = [];
  env.state.configured = true;
  seq = 0;
});

describe('deliverPendingPushes', () => {
  it('gửi tới mọi thiết bị của người nhận', async () => {
    env.state.notifications = [notification()];
    env.state.subscriptions = [subscription(), subscription({ endpoint: 'https://push.example/ep2' })];
    const send = vi.fn(async () => 'ok' as const);
    const r = await deliverPendingPushes({ send });
    expect(r.claimed).toBe(1);
    expect(r.delivered).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('payload gồm title/body/url để SW mở đúng hồ sơ', async () => {
    env.state.notifications = [notification({ href: '/ho-so/chi/abc' })];
    env.state.subscriptions = [subscription()];
    const send = vi.fn(async () => 'ok' as const);
    await deliverPendingPushes({ send });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example/ep' }),
      expect.objectContaining({ url: '/ho-so/chi/abc', title: expect.stringContaining('chờ bạn duyệt') }),
    );
  });

  it('lượt sau KHÔNG gửi lại (push_seen_at đã đặt)', async () => {
    env.state.notifications = [notification()];
    env.state.subscriptions = [subscription()];
    const send = vi.fn(async () => 'ok' as const);
    await deliverPendingPushes({ send });
    await deliverPendingPushes({ send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('hai vòng SONG SONG không gửi trùng (giành nguyên tử)', async () => {
    env.state.notifications = [notification()];
    env.state.subscriptions = [subscription()];
    const send = vi.fn(async () => 'ok' as const);
    const [a, b] = await Promise.all([deliverPendingPushes({ send }), deliverPendingPushes({ send })]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('không gửi cho người chưa đăng ký thiết bị', async () => {
    env.state.notifications = [notification()];
    env.state.subscriptions = [];
    const send = vi.fn(async () => 'ok' as const);
    const r = await deliverPendingPushes({ send });
    expect(r.claimed).toBe(1);
    expect(send).not.toHaveBeenCalled();
  });

  it('subscription chết (410) bị xoá khỏi DB', async () => {
    env.state.notifications = [notification()];
    env.state.subscriptions = [subscription()];
    const r = await deliverPendingPushes({ send: async () => 'gone' });
    expect(r.gone).toBe(1);
    expect(env.state.subscriptions).toHaveLength(0);
  });

  it('tắt êm khi server chưa cấu hình VAPID', async () => {
    env.state.configured = false;
    env.state.notifications = [notification()];
    env.state.subscriptions = [subscription()];
    const send = vi.fn(async () => 'ok' as const);
    const r = await deliverPendingPushes({ send });
    expect(r.claimed).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('bỏ qua notification không phải loại duyệt', async () => {
    env.state.notifications = [notification({ kind: 'system' })];
    env.state.subscriptions = [subscription()];
    const send = vi.fn(async () => 'ok' as const);
    await deliverPendingPushes({ send });
    expect(send).not.toHaveBeenCalled();
  });

  it('chỉ gửi cho đúng người nhận', async () => {
    env.state.notifications = [notification({ user_id: 'u2' })];
    env.state.subscriptions = [subscription({ user_id: 'u1' })];
    const send = vi.fn(async () => 'ok' as const);
    await deliverPendingPushes({ send });
    expect(send).not.toHaveBeenCalled();
  });
});

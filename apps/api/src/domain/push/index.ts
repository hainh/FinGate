/**
 * FinGate — Web Push (NOTI-03): thông báo phiếu "Chờ tôi duyệt" **kể cả khi app đã đóng**.
 *
 * Khác với "chuông poll" (chỉ chạy khi app còn mở), ở đây server chủ động gửi qua push service của
 * trình duyệt (FCM / APNs / Mozilla) ⇒ thiết bị thức dậy và hiện thông báo dù app không chạy.
 *
 * LUỒNG:
 *  1. Client `pushManager.subscribe({ applicationServerKey })` lấy `endpoint` + khoá `p256dh`/`auth`,
 *     POST lên `/notifications/push/subscribe` → lưu bảng `push_subscriptions`.
 *  2. Vòng `startPushLoop` (trong tiến trình API, giống vòng sao lưu) gọi `deliverPendingPushes()`:
 *     nhặt các `Notification` duyệt CHƯA bắn, nguyên tử giành bằng `push_seen_at`, rồi gửi tới mọi
 *     thiết bị của người nhận.
 *  3. Push service trả 404/410 ⇒ subscription đã chết → xoá bản ghi (tự dọn).
 *
 * VÌ SAO KHÔNG THỂ "CHỈ GỬI ĐI": mọi bước đều phải chịu lỗi mạng/khoá chết, nên gửi là best-effort và
 * KHÔNG được làm hỏng bất kỳ luồng nghiệp vụ nào — hàm ở đây không ném lỗi ra ngoài.
 */

import webpush from 'web-push';
import { getEnv } from '../../env.ts';
import { Models } from '../../db/models.ts';

const PUSH_KINDS = ['approval'] as const;
/** Số thông báo xử lý mỗi lượt — vòng chạy 30s nên còn tồn sẽ được nhặt ở lượt sau. */
const BATCH = 25;
/** Số thông báo tối đa gộp cho MỘT thiết bị trong một lượt (tránh làm ngập khay thông báo). */
const MAX_PER_DEVICE = 3;
/** Gửi thất bại liên tiếp bao nhiêu lần thì coi là subscription chết. */
const MAX_FAILS = 5;

let vapidReady = false;

/** Cấu hình VAPID một lần; trả false nếu chưa cấu hình (tính năng tắt êm). */
export function pushReady(): boolean {
  const env = getEnv();
  if (!env.pushConfigured) return false;
  if (!vapidReady) {
    try {
      webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
      vapidReady = true;
    } catch (err) {
      console.warn('[push] VAPID không hợp lệ — tắt Web Push:', (err as Error).message);
      return false;
    }
  }
  return true;
}

export interface PushSubscriptionRow {
  _id: string;
  user_id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  fails?: number;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  /** Gom thông báo cùng loại trên một thiết bị; cùng tag thì thông báo sau THAY thế (không chồng). */
  tag?: string;
}

/**
 * Gửi một payload tới MỘT thiết bị.
 * Trả 'ok' | 'gone' (subscription chết, phải xoá) | 'error' (lỗi tạm thời).
 */
export async function sendToSubscription(
  sub: PushSubscriptionRow,
  payload: PushPayload,
): Promise<'ok' | 'gone' | 'error'> {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
      // TTL: thông báo duyệt vẫn có ích vài giờ (người chủ tịch ngủ dậy vẫn cần biết).
      { TTL: 4 * 60 * 60, urgency: 'high' },
    );
    return 'ok';
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // 404/410 = push service báo endpoint không còn tồn tại (gỡ app, tắt thông báo, hết hạn).
    if (status === 404 || status === 410) return 'gone';
    return 'error';
  }
}

/** Cập nhật `fails`/`last_ok_at`, xoá khi vượt ngưỡng. Không ném lỗi. */
async function recordOutcome(sub: PushSubscriptionRow, outcome: 'ok' | 'gone' | 'error'): Promise<void> {
  try {
    if (outcome === 'ok') {
      await Models.PushSubscription.updateOne(
        { _id: sub._id } as never,
        { $set: { fails: 0, last_ok_at: new Date(), updated_at: new Date() } },
      ).exec();
      return;
    }
    if (outcome === 'gone') {
      await Models.PushSubscription.deleteOne({ _id: sub._id } as never).exec();
      return;
    }
    const fails = (sub.fails ?? 0) + 1;
    if (fails >= MAX_FAILS) {
      // Lỗi lặp lại nhiều lần: coi như chết. Giữ lại chỉ làm mỗi lượt gửi chậm thêm.
      await Models.PushSubscription.deleteOne({ _id: sub._id } as never).exec();
      return;
    }
    await Models.PushSubscription.updateOne({ _id: sub._id } as never, { $set: { fails, updated_at: new Date() } }).exec();
  } catch {
    /* dọn dẹp là best-effort, không được làm hỏng lượt gửi */
  }
}

/**
 * Nhặt các `Notification` duyệt chưa bắn (tạo trước `cutoff`), giành nguyên tử rồi gửi.
 *
 * TÁCH RIÊNG PHẦN "GIÀNH" (claim) khỏi phần "GỬI" để test được tính đúng-một-lần mà không cần mạng.
 *
 * @param opts.now mốc chốt (mặc định hiện tại) — bản ghi tạo SAU mốc này để lượt sau.
 * @param opts.send hàm gửi (mặc định `sendToSubscription`) — thay được trong test.
 */
export async function deliverPendingPushes(
  opts: {
    now?: Date;
    send?: (sub: PushSubscriptionRow, payload: PushPayload) => Promise<'ok' | 'gone' | 'error'>;
  } = {},
): Promise<{ claimed: number; delivered: number; gone: number; failed: number }> {
  const stats = { claimed: 0, delivered: 0, gone: 0, failed: 0 };
  if (!pushReady()) return stats;
  const send = opts.send ?? sendToSubscription;
  const cutoff = opts.now ?? new Date();

  // Ứng viên: chưa bắn, đúng loại. Không giới hạn "created_at > X" vì đây là server tự quét —
  // nhưng chỉ nhặt cái cũ hơn `cutoff` để không tranh với bản ghi đang phát sinh.
  const candidates = await Models.Notification.find({
    push_seen_at: null,
    kind: { $in: PUSH_KINDS },
    created_at: { $lte: cutoff },
  })
    .sort({ created_at: 1 })
    .limit(BATCH)
    .select({ _id: 1, user_id: 1, title: 1, body: 1, href: 1 })
    .lean<{ _id: unknown; user_id: unknown; title: string; body: string | null; href: string | null }[]>();

  for (const n of candidates) {
    // Giành NGUYÊN TỬ: hai vòng chạy song song (hoặc instance khác) không gửi trùng.
    const claimed = await Models.Notification.findOneAndUpdate(
      { _id: n._id, push_seen_at: null },
      { $set: { push_seen_at: cutoff } },
      { new: true },
    ).lean<{ _id: unknown } | null>();
    if (!claimed) continue;
    stats.claimed++;

    const subs = await Models.PushSubscription.find({ user_id: String(n.user_id) })
      .limit(MAX_PER_DEVICE * 5)
      .lean<PushSubscriptionRow[]>();
    if (!subs.length) continue; // người này chưa bật thông báo trên thiết bị nào

    const payload: PushPayload = {
      title: n.title,
      body: n.body ?? '',
      url: n.href ?? '/cho-toi-duyet',
      // Cùng tag ⇒ thông báo mới THAY thế cái cũ trên thiết bị, tránh dồn 10 thông báo.
      tag: `fg-approval-${String(n._id)}`,
    };
    for (const sub of subs) {
      const outcome = await send(sub, payload);
      await recordOutcome(sub, outcome);
      if (outcome === 'ok') stats.delivered++;
      else if (outcome === 'gone') stats.gone++;
      else stats.failed++;
    }
  }
  return stats;
}

/**
 * Vòng đẩy trong tiến trình API (mặc định 30 giây). Trả về hàm dừng.
 * Giống vòng sao lưu: không chồng lượt, bỏ qua khi DB chưa lên hoặc chưa cấu hình VAPID.
 */
export function startPushLoop(
  log: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void },
  opts: { ready: () => boolean; intervalMs?: number; task?: () => Promise<unknown> },
): () => void {
  const { ready, intervalMs, task = deliverPendingPushes } = opts;
  if (!pushReady()) return () => undefined;
  const ms = intervalMs ?? Math.max(10, getEnv().PUSH_INTERVAL_SECONDS) * 1000;
  let running = false;
  const timer = setInterval(() => {
    if (running || !ready()) return;
    running = true;
    task()
      .then((result) => {
        // Chỉ log khi có việc — mỗi 30s một dòng "không có gì" sẽ làm rối log.
        const r = result as { claimed?: number } | undefined;
        if (r && (r.claimed ?? 0) > 0) log.info({ result }, 'đẩy thông báo xong');
      })
      .catch((err: unknown) => log.error({ err }, 'đẩy thông báo lỗi'))
      .finally(() => {
        running = false;
      });
  }, ms);
  timer.unref();
  return () => clearInterval(timer);
}

export { MAX_FAILS, MAX_PER_DEVICE };

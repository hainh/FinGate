/**
 * FinGate web — thông báo khi có phiếu mới CHỜ TÔI DUYỆT.
 *
 * HAI ĐƯỜNG, dùng chung quyền Notification:
 *
 *  A. **Web Push (chính)** — thiết bị đã đăng ký với server; server đẩy qua push service nên thông báo
 *     đến **cả khi app đã đóng**. Page không làm gì cả: `sw.js` tự nhận `push` và hiện thông báo.
 *     Đây là chế độ dùng khi server đã cấu hình VAPID + đã `subscribeToPush` thành công.
 *
 *  B. **Chuông poll (dự phòng)** — app đang mở, server chưa cấu hình VAPID (hoặc thiết bị chưa đăng ký
 *     được, ví dụ Chrome desktop chặn push). Poll 30s hỏi `/notifications/push-pending`.
 *
 * ⚠️ HAI ĐƯỜNG DÙNG CHUNG CỜ `push_seen_at` Ở SERVER, nên **không bao giờ chạy cả hai cùng lúc**: bên nào
 * lấy trước thì bên kia mất thông báo. Vì vậy `useApprovalNotifications` chỉ bật (A) hoặc (B), và tắt
 * hẳn khi chưa biết trạng thái server.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiCall, apiData } from './api.ts';
import {
  currentPushSubscription,
  getAck,
  pushPermission,
  pushSupported,
  requestPushPermission,
  setAck,
  subscribeToPush,
  unsubscribeFromPush,
  type PushPermission,
} from '../lib/pwa.ts';

/* ---------------- Trạng thái Web Push phía server ---------------- */

export interface PushStatus {
  /** Server đã cấu hình VAPID và đang bật gửi. */
  enabled: boolean;
  /** Khoá công khai để `pushManager.subscribe`. */
  public_key: string;
  /** Số thiết bị của tôi đã đăng ký. */
  devices: number;
}

export function usePushStatus() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void apiData<PushStatus>('/notifications/push/status')
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        if (alive) setStatus({ enabled: false, public_key: '', devices: 0 });
      });
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

/* ---------------- Quyền Notification ---------------- */

const permListeners = new Set<() => void>();
let permSnapshot: PushPermission = pushSupported() ? pushPermission() : 'unsupported';

function refreshPermission(): void {
  const next = pushSupported() ? pushPermission() : 'unsupported';
  if (next !== permSnapshot) {
    permSnapshot = next;
    permListeners.forEach((l) => l());
  }
}

export function usePushPermission(): PushPermission {
  const value = useSyncExternalStore(
    (l) => {
      permListeners.add(l);
      return () => permListeners.delete(l);
    },
    () => permSnapshot,
    () => 'unsupported' as PushPermission,
  );
  useEffect(() => {
    // Quyền có thể đổi ở tab khác / cài đặt hệ thống — giữ đồng bộ khi quay lại app.
    const h = (): void => refreshPermission();
    document.addEventListener('visibilitychange', h);
    window.addEventListener('focus', h);
    return () => {
      document.removeEventListener('visibilitychange', h);
      window.removeEventListener('focus', h);
    };
  }, []);
  return value;
}

/**
 * Bật thông báo: xin quyền → (nếu server có VAPID) đăng ký thiết bị → báo server lưu endpoint.
 * @returns 'push' nếu Web Push hoạt động (báo cả khi app đóng), 'local' nếu chỉ có chuông poll.
 */
export async function enableApprovalNotifications(): Promise<'push' | 'local' | 'denied'> {
  const permission = await requestPushPermission();
  refreshPermission();
  if (permission !== 'granted') return 'denied';
  const done = await subscribeCurrentDevice();
  return done ? 'push' : 'local';
}

/**
 * Đăng ký thiết bị này với server. Trả true nếu server đã lưu endpoint (Web Push dùng được).
 * Không ném lỗi: mọi thất bại đều quay về chuông poll.
 */
export async function subscribeCurrentDevice(): Promise<boolean> {
  try {
    const status = await apiData<PushStatus>('/notifications/push/status');
    if (!status.enabled || !status.public_key) return false;
    const sub = await subscribeToPush(status.public_key);
    if (!sub.ok) return false;
    await apiCall('/notifications/push/subscribe', {
      method: 'POST',
      body: {
        endpoint: sub.endpoint,
        keys: await keysOf(),
        user_agent: navigator.userAgent.slice(0, 280),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Khoá `p256dh`/`auth` của subscription hiện tại (server cần để mã hoá payload). */
async function keysOf(): Promise<{ p256dh: string; auth: string }> {
  const sub = await currentPushSubscription();
  const json = sub?.toJSON() as { keys?: { p256dh?: string; auth?: string } } | undefined;
  return { p256dh: json?.keys?.p256dh ?? '', auth: json?.keys?.auth ?? '' };
}

/** Tắt thông báo trên thiết bị này: huỷ đăng ký trình duyệt + báo server xoá endpoint. */
export async function disableApprovalNotifications(): Promise<void> {
  const endpoint = await unsubscribeFromPush();
  if (endpoint) {
    await apiCall('/notifications/push/unsubscribe', { method: 'POST', body: { endpoint } }).catch(() => undefined);
  }
}

/* ---------------- Chuông poll (dự phòng) ---------------- */

interface PushPendingResponse {
  data?: { count: number; cursor: string; items: { title: string; body: string; href: string }[] };
  count?: number;
  cursor?: string;
  items?: { title: string; body: string; href: string }[];
}

/** Hiện thông báo từ trang: ưu tiên SW (bấm mở đúng hồ sơ, còn khi app ở nền). */
async function showNotification(n: { title: string; body: string; href: string }, tag: string): Promise<void> {
  const options: NotificationOptions = {
    body: n.body || undefined,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag,
    data: { url: n.href },
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(n.title, options);
      return;
    }
  } catch {
    /* rơi xuống phương án trang */
  }
  const local = new Notification(n.title, options);
  local.onclick = () => {
    window.focus();
    window.location.assign(n.href);
    local.close();
  };
}

/**
 * Poll 30s khi: đã đăng nhập + đã có quyền + server KHÔNG có Web Push (hoặc thiết bị chưa đăng ký).
 * Gắn MỘT lần trong `App.tsx`.
 */
export function useApprovalNotifications(enabled: boolean, mode: 'push' | 'local' | 'off'): void {
  const [signedInAt] = useState(() => Date.now());

  useEffect(() => {
    // Chế độ 'push': server tự đẩy, page KHÔNG được chạm vào push_seen_at (xem ghi chú đầu file).
    if (!enabled || mode !== 'local') return;
    let cancelled = false;
    let running = false;

    const tick = async (): Promise<void> => {
      if (running || document.visibilityState === 'hidden') return; // tab ẩn: để hệ điều hành lo
      running = true;
      try {
        // Mốc: lần báo cuối, hoặc lúc đăng nhập (không báo tồn đọng trước khi vào app).
        const sinceIso = getAck() ? new Date(getAck()).toISOString() : new Date(signedInAt).toISOString();
        const res = await apiCall<PushPendingResponse>('/notifications/push-pending', {
          query: { since: sinceIso },
        });
        if (cancelled) return;
        const items = res.data?.items ?? res.items ?? [];
        const cursor = res.data?.cursor ?? res.cursor;
        if (cursor) setAck(cursor);
        for (const [i, n] of items.entries()) {
          await showNotification(n, `fg-approval-${cursor}-${i}`);
        }
      } catch {
        // Lỗi mạng/quyền: bỏ qua vòng này, lần poll sau thử lại — không làm phiền người dùng.
      } finally {
        running = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, mode, signedInAt]);
}

/** Xoá mốc "đã báo" của chuông dự phòng (gọi khi đăng xuất — máy có thể được dùng bởi người khác). */
export function resetPushAck(): void {
  try {
    localStorage.removeItem('fg.push.ack');
  } catch {
    /* ignore */
  }
}

export { pushSupported };

/**
 * FinGate web — thông báo hệ thống khi có phiếu mới CHỜ TÔI DUYỆT.
 *
 * Luồng một vòng poll (30s, dùng chính `refetchInterval` react-query của dự án):
 *   1. GET `/notifications/push-pending?since=<mốc đã báo>` → server nhặt các bản ghi duyệt CHƯA bắn và
 *      nguyên tử đánh dấu `push_seen_at` (xem apps/api/src/domain/queries/push-pending.ts) nên hai tab
 *      hoặc StrictMode double-mount KHÔNG bắn trùng.
 *   2. Bắn `Notification` bằng SW registration (nếu có) để bấm vào là mở đúng hồ sơ; không có SW thì dùng
 *      `new Notification()` của trang (vẫn bấm được, chỉ không giữ khi đóng tab).
 *   3. Lưu `cursor` server trả về làm mốc lần sau.
 *
 * Không có quyền Notification ⇒ poll tự tắt (không gọi API thừa).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiCall } from './api.ts';
import { getAck, pushPermission, pushSupported, requestPushPermission, setAck, type PushPermission } from '../lib/pwa.ts';

interface PushPendingResponse {
  data?: {
    count: number;
    cursor: string;
    items: { title: string; body: string; href: string }[];
  };
  count?: number;
  cursor?: string;
  items?: { title: string; body: string; href: string }[];
}

/** Theo dõi quyền Notification để UI (nút bật/tắt) cập nhật ngay — quyền không có event chuẩn. */
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

/** Gọi sau khi người dùng vừa cấp quyền, để các component khác thấy ngay. */
export function notifyPermissionChanged(): void {
  refreshPermission();
}

/** Hiện thông báo: ưu tiên SW (bấm mở đúng hồ sơ, còn khi app ở nền). */
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

/** Trả về true nếu bật được (đã có quyền), false nếu không. */
export async function enableApprovalNotifications(): Promise<boolean> {
  const result = await requestPushPermission();
  refreshPermission();
  return result === 'granted';
}

/**
 * Đang đăng nhập ⇒ poll mỗi 30s, bắn thông báo cho phiếu mới vào hàng chờ của tôi.
 * Tách riêng khỏi UI để gắn MỘT lần trong `App.tsx`.
 */
export function useApprovalNotifications(enabled: boolean): void {
  const permission = usePushPermission();
  const [signedInAt] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled || permission !== 'granted') return;
    let cancelled = false;
    let running = false;

    const tick = async (): Promise<void> => {
      if (running || document.visibilityState === 'hidden') return; // tab ẩn: không spam, để SW lo
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
        // Bắn tuần tự để giữ thứ tự phiếu đến; mỗi phiếu một tag riêng để không đè nhau.
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
  }, [enabled, permission, signedInAt]);
}

/** Đồng bộ: người dùng đã bật thông báo chưa (dùng cho nhãn nút). */
export function approvalNotificationsOn(): boolean {
  return pushSupported() && pushPermission() === 'granted';
}

/** Xoá mốc đã báo (dùng khi đăng xuất để người dùng khác trên máy không "ăn" mốc cũ). */
export function resetPushAck(): void {
  try {
    localStorage.removeItem('fg.push.ack');
  } catch {
    /* ignore */
  }
}

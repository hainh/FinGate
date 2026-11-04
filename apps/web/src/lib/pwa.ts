/**
 * FinGate web — PWA (K-13 "MAY thêm PWA sau").
 *
 * Hai việc duy nhất:
 *  1. `registerServiceWorker()` — đăng ký `/sw.js` để app CÀI ĐƯỢC lên màn hình chính và mở nhanh.
 *     SW nằm ở `public/sw.js`, KHÔNG cache `/api/` (xem ghi chú đầu file đó).
 *  2. `useApprovalNotifications()` — thông báo hệ thống (màn hình khoá/khay thông báo) mỗi khi có
 *     phiếu mới vào hàng **"Chờ tôi duyệt"** (và phiếu đã duyệt xong cần kế toán thanh toán).
 *
 * Vì sao là POLLING chứ không phải Web Push: server hiện chưa có VAPID + bảng `push_subscriptions`
 * (NOTI-03 mới ở mức P4, ADR-07 đã chốt "không WebSocket, poll 30s"). App đã có sẵn react-query poll
 * 30s cho badge `/dashboard/badges`, nên hiệu quả tương đương — chỉ cần thêm quyền Notification của
 * trình duyệt. Khi nào làm Web Push thật: server đẩy đúng payload `{ title, body, url }`, SW đã có
 * handler `push`/`notificationclick` sẵn.
 *
 * Giới hạn cần biết (không phải bug):
 *  - Chạy khi app còn ở nền ≥ ~5 phút (tối đa ~30s sau khi phiếu xuất hiện). Trình duyệt trên Android
 *    thường tạm dừng timer khi đóng hẳn app; iOS chặn hoàn toàn timer khi app bị tắt. Muốn báo cả khi
 *    đóng app ⇒ phải làm Web Push.
 *  - iOS chỉ cho `Notification.requestPermission()` khi app đã được "Thêm vào MH chính" và gọi từ cú
 *    chạm của người dùng ⇒ luôn bật qua nút trong màn Cá nhân, không tự xin ở lần mở đầu.
 */

const NOTIF_ACK_KEY = 'fg.push.ack';

export type PushPermission = 'default' | 'granted' | 'denied' | 'unsupported';

/** Có API thông báo + service worker không (Chrome Android, Safari iOS 16.4+ trong app đã cài). */
export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator;
}

export function pushPermission(): PushPermission {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission as PushPermission;
}

/**
 * Người dùng bấm "Bật thông báo": xin quyền rồi ghi nhận mốc hiện tại để KHÔNG bắn lại các phiếu đang
 * chờ sẵn (bật xong bị dội 10 thông báo cũ là trải nghiệm tệ).
 */
export async function requestPushPermission(): Promise<PushPermission> {
  if (!pushSupported()) return 'unsupported';
  const result = (await Notification.requestPermission()) as PushPermission;
  if (result === 'granted') {
    // Mốc đánh dấu NẶNG HƠN "xảy ra nhưng tôi đã thấy thông báo" — ack riêng của việc bật quyền.
    localStorage.setItem(NOTIF_ACK_KEY, new Date().toISOString());
  }
  return result;
}

/* ------------- Đăng ký service worker ------------- */

let swRegistered = false;

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (swRegistered) return;
  swRegistered = true;
  // Chỉ đăng ký ở bản production build hoặc khi dev phục vụ từ HTTPS/localhost — SW vô dụng với HMR
  // và dễ gây khó chịu khi Vite đổi port. `import.meta.env.DEV` do Vite thay lúc build.
  if (import.meta.env.DEV) return;
  const onReady = (): void => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((err) => {
      // Không có SW thì app vẫn chạy bình thường — chỉ mất khả năng cài đặt/offline shell.
      console.warn('[pwa] không đăng ký được service worker:', (err as Error).message);
    });
  };
  if (document.readyState === 'complete') onReady();
  else window.addEventListener('load', onReady, { once: true });
}

/* ------------- Thông báo "Chờ tôi duyệt" ------------- */

export interface ApprovalNotification {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** Mốc "đã thấy" — dùng chung cho footer của SW.
 *  ack lưu ở localStorage; SW chạy chung storage với trang vì cùng origin. */
export function getAck(): number {
  const raw = localStorage.getItem(NOTIF_ACK_KEY);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export function setAck(iso: string): void {
  localStorage.setItem(NOTIF_ACK_KEY, iso);
}

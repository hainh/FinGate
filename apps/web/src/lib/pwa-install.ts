/**
 * FinGate web — onboarding PWA trên điện thoại.
 *
 * Hai việc buộc người dùng di động phải làm (xem docs/07_pwa-mobile.md §7):
 *  1. **Cài thành app** (Thêm vào MH chính) — đang mở trong tab trình duyệt thì thông báo duyệt phiếu
 *     chết theo tab, và iOS còn KHÔNG có API Notification ngoài app đã cài.
 *  2. **Bật thông báo** — đã ở chế độ app (`display-mode: standalone`) mà quyền Notification chưa
 *     `granted` ⇒ chưa nhận được phiếu chờ duyệt.
 *
 * Tách ra khỏi `lib/pwa.ts` vì file đó nói về *cơ chế* (SW, subscribe VAPID), còn file này nói về
 * *trạng thái hiển thị*: thiết bị nào, đang chạy ở chế độ nào, trình duyệt có chịu cho cài tự động
 * không. Các hàm decide (`isMobileDevice`, `isAppMode`, `onboardingStep`) là hàm THUẦN để test được
 * mà không cần DOM.
 */

import { useSyncExternalStore } from 'react';
import type { PushPermission } from './pwa.ts';

/* ---------------- Nhận diện thiết bị / chế độ chạy (hàm thuần) ---------------- */

/** UA thiết bị di động thật (Android/iOS). Desktop thu hẹp cửa sổ KHÔNG tính — nút này là cho điện thoại. */
const MOBILE_UA = /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i;
const IOS_UA = /iPhone|iPad|iPod/i;

export interface DeviceHint {
  userAgent: string;
  maxTouchPoints: number;
}

/** iPadOS 13+ giả UA thành "Macintosh" ⇒ chỉ phân biệt được bằng số điểm chạm. */
export function isMobileDevice({ userAgent, maxTouchPoints }: DeviceHint): boolean {
  if (MOBILE_UA.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

export function isIosDevice({ userAgent, maxTouchPoints }: DeviceHint): boolean {
  if (IOS_UA.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** Mảng chi tiết cài cho từng nền tảng — thuần dữ liệu, test được. */
export function installSteps(ios: boolean): string[] {
  return ios
    ? [
        'Mở trang này bằng Safari (trên iPhone, Chrome KHÔNG cài được app).',
        'Chạm nút Chia sẻ (ô vuông có mũi tên, dưới thanh địa chỉ).',
        'Chọn “Thêm vào MH chính” → Xác nhận.',
        'Mở FinGate từ biểu tượng vừa tạo ngoài màn hình chính.',
      ]
    : [
        'Mở FinGate bằng Chrome.',
        'Chạm dấu ⋮ ở góc trên phải trình duyệt.',
        'Chọn “Cài đặt ứng dụng” (hoặc “Thêm vào màn hình chính”).',
        'Mở FinGate từ biểu tượng vừa tạo ngoài màn hình chính.',
      ];
}

/**
 * App đang chạy ở CHẾ ĐỘ APP (mở từ icon, không còn thanh địa chỉ) hay trong tab trình duyệt?
 * `queryMatches` được đưa vào để test không cần matchMedia.
 */
export function isAppMode(queryMatches: (query: string) => boolean, iosStandalone: boolean): boolean {
  return queryMatches(APP_MODE_QUERY) || iosStandalone;
}

/** Mọi chế độ "đã cài app" — `browser` = tab thường; `window-controls-overlay` = Chrome desktop PWA. */
export const APP_MODE_QUERY =
  '(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui), (display-mode: window-controls-overlay)';

/* ---------------- Bước onboarding phải hiện ---------------- */

export type OnboardingStep = 'install' | 'notifications' | null;

export interface OnboardingInput {
  isMobile: boolean;
  isAppMode: boolean;
  permission: PushPermission;
}

/**
 * Thứ tự ép: chưa cài app ⇒ chưa thể bật thông báo (iOS chặn hẳn API), nên bước `install` luôn thắng.
 * Desktop: không hiện gì — tránh chiếm chỗ trên màn hình làm việc.
 */
export function onboardingStep({ isMobile, isAppMode: app, permission }: OnboardingInput): OnboardingStep {
  if (!isMobile) return null;
  if (!app) return 'install';
  return permission === 'granted' ? null : 'notifications';
}

/* ---------------- Standalone: matchMedia + navigator.standalone (iOS) ---------------- */

let modeMql: MediaQueryList | null = null;

function modeList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  modeMql ??= window.matchMedia(APP_MODE_QUERY);
  return modeMql;
}

function iosStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function appModeSnapshot(): boolean {
  // Bỏ qua tham số query: một MQL duy nhất cho cả danh sách môi trường ở `APP_MODE_QUERY`.
  return isAppMode(() => modeList()?.matches ?? false, iosStandalone());
}

function subscribeAppMode(onChange: () => void): () => void {
  const mql = modeList();
  if (!mql) return () => undefined;
  const handler = (): void => onChange();
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}

export function useAppMode(): boolean {
  return useSyncExternalStore(subscribeAppMode, appModeSnapshot, () => false);
}

/** Thiết bị di động — xác định một lần lúc tải trang (không đổi khi xoay/ngang dọc). */
export function useIsMobileDevice(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => (typeof navigator === 'undefined' ? false : isMobileDevice(navigator)),
    () => false,
  );
}

export function useIsIos(): boolean {
  return useSyncExternalStore(
    () => () => undefined,
    () => (typeof navigator === 'undefined' ? false : isIosDevice(navigator)),
    () => false,
  );
}

/* ---------------- beforeinstallprompt: cài app BẰNG MỘT NÚT ---------------- */

/** Chrome/Edge bắn sự kiện này khi app ĐỦ điều kiện cài; phải giữ lại rồi gọi `.prompt()` lúc người dùng bấm. */
interface InstallPromptEventLike extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: InstallPromptEventLike | null = null;
let installedSeen = false;
let capturing = false;
const promptListeners = new Set<() => void>();

function emitPrompt(): void {
  promptListeners.forEach((l) => l());
}

/**
 * Nghe sớm nhất có thể (gọi từ `main.tsx`): `beforeinstallprompt` bắn sau khi SW sẵn sàng, nhưng nếu
 * trang tải nhanh hơn lúc React mount thì mất luôn sự kiện và nút chỉ còn hướng dẫn thủ công.
 */
export function startInstallCapture(): void {
  if (capturing || typeof window === 'undefined') return;
  capturing = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    // preventDefault GIỮ LẠI quyền hỏi — nếu không Chrome tự hiển thị/ẩn banner của riêng nó.
    event.preventDefault();
    deferredPrompt = event as InstallPromptEventLike;
    emitPrompt();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    installedSeen = true;
    emitPrompt();
  });
}

function subscribePrompt(onChange: () => void): () => void {
  promptListeners.add(onChange);
  startInstallCapture();
  return () => promptListeners.delete(onChange);
}

/** true nếu trình duyệt cho phép mở hộp thoại cài đặt ngay từ nút. */
export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

/**
 * Mở hộp thoại cài đặt của trình duyệt. iOS KHÔNG có sự kiện này (Apple không hỗ trợ) ⇒ 'unavailable',
 * caller hiện hướng dẫn thủ công.
 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferredPrompt;
  if (!event) return 'unavailable';
  deferredPrompt = null;
  emitPrompt();
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice.outcome;
  } catch {
    return 'unavailable';
  }
}

export interface InstallPromptState {
  /** Bấm được ⇒ trình duyệt sẽ tự hiện hộp thoại cài (Android/Chrome, Edge, Opera). */
  canPrompt: boolean;
  /** Đã bấm cài thành công trên CHÍNH tab này (sự kiện `appinstalled`) — vẫn phải mở từ icon. */
  installed: boolean;
  prompt: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export function useInstallPrompt(): InstallPromptState {
  const canPrompt = useSyncExternalStore(subscribePrompt, () => deferredPrompt !== null, () => false);
  const installed = useSyncExternalStore(subscribePrompt, () => installedSeen, () => false);
  return { canPrompt, installed, prompt: promptInstall };
}

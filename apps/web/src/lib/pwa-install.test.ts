/**
 * Logic chọn bước onboarding PWA (lib/pwa-install.ts) — hàm thuần, không DOM, không gọi mạng.
 * Hai bước ép theo thứ tự: cài app trước, bật thông báo sau (docs/07 §7).
 */
import { describe, expect, it } from 'vitest';
import { installSteps, isAppMode, isIosDevice, isMobileDevice, onboardingStep } from './pwa-install.ts';

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const UA_IPAD_OS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

describe('isMobileDevice — chỉ thiết bị di động mới bị ép cài app', () => {
  it('Android và iPhone là mobile', () => {
    expect(isMobileDevice({ userAgent: UA_ANDROID, maxTouchPoints: 5 })).toBe(true);
    expect(isMobileDevice({ userAgent: UA_IPHONE, maxTouchPoints: 5 })).toBe(true);
  });

  it('iPadOS 13+ giả UA thành Macintosh — nhận ra nhờ số điểm chạm', () => {
    expect(isMobileDevice({ userAgent: UA_IPAD_OS, maxTouchPoints: 5 })).toBe(true);
    expect(isIosDevice({ userAgent: UA_IPAD_OS, maxTouchPoints: 5 })).toBe(true);
  });

  it('desktop (kể cả laptop có cảm ứng, cửa sổ hẹp) KHÔNG phải mobile', () => {
    expect(isMobileDevice({ userAgent: UA_DESKTOP, maxTouchPoints: 0 })).toBe(false);
    expect(isMobileDevice({ userAgent: UA_DESKTOP, maxTouchPoints: 10 })).toBe(false);
    // Mac thật (touchpad, không có điểm chạm) không bị nhầm với iPad.
    expect(isMobileDevice({ userAgent: UA_IPAD_OS, maxTouchPoints: 0 })).toBe(false);
  });
});

describe('isAppMode — phân biệt mở từ icon ngoài MH chính với mở trong tab', () => {
  it('matchMedia standalone = app mode', () => {
    expect(isAppMode((q) => q.includes('standalone'), false)).toBe(true);
  });

  it('iOS chỉ có navigator.standalone (không hỗ trợ display-mode) vẫn tính là app', () => {
    expect(isAppMode(() => false, true)).toBe(true);
  });

  it('tab trình duyệt thường = chưa cài', () => {
    expect(isAppMode(() => false, false)).toBe(false);
  });
});

describe('onboardingStep — chọn bước phải hiện trên thanh', () => {
  it('desktop: không hiện gì', () => {
    expect(onboardingStep({ isMobile: false, isAppMode: false, permission: 'default' })).toBeNull();
    expect(onboardingStep({ isMobile: false, isAppMode: true, permission: 'denied' })).toBeNull();
  });

  it('mobile trong tab trình duyệt: bắt cài app, bất kể quyền thông báo', () => {
    expect(onboardingStep({ isMobile: true, isAppMode: false, permission: 'default' })).toBe('install');
    // iOS chặn API Notification ngoài app ⇒ granted cũng chưa nghĩa là gì, vẫn phải cài đã.
    expect(onboardingStep({ isMobile: true, isAppMode: false, permission: 'granted' })).toBe('install');
    expect(onboardingStep({ isMobile: true, isAppMode: false, permission: 'unsupported' })).toBe('install');
  });

  it('mobile đã cài app: đòi bật thông báo cho tới khi quyền granted', () => {
    expect(onboardingStep({ isMobile: true, isAppMode: true, permission: 'default' })).toBe('notifications');
    expect(onboardingStep({ isMobile: true, isAppMode: true, permission: 'denied' })).toBe('notifications');
    expect(onboardingStep({ isMobile: true, isAppMode: true, permission: 'unsupported' })).toBe('notifications');
  });

  it('mobile đã cài app + đã bật thông báo: ẩn thanh', () => {
    expect(onboardingStep({ isMobile: true, isAppMode: true, permission: 'granted' })).toBeNull();
  });
});

describe('installSteps — hướng dẫn thủ công cho từng nền tảng', () => {
  it('iOS phải nhắc dùng Safari (Chrome iOS không cài được PWA)', () => {
    const ios = installSteps(true);
    expect(ios.join(' ').toLowerCase()).toContain('safari');
    expect(ios.some((s) => s.includes('Thêm vào MH chính'))).toBe(true);
    expect(ios).toHaveLength(4);
  });

  it('Android dùng menu ⋮ của Chrome', () => {
    const android = installSteps(false);
    expect(android.join(' ')).toContain('⋮');
    expect(android.some((s) => s.includes('Cài đặt ứng dụng'))).toBe(true);
    expect(android).toHaveLength(4);
  });
});

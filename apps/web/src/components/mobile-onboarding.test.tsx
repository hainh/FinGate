/**
 * Khói (smoke): component onboarding phải render được ở môi trường không có DOM (Node/SSR) và TỒN TẠI
 * yên lặng với thiết bị không phải di động — logic chọn bước đã kiểm riêng ở `lib/pwa-install.test.ts`.
 *
 * `renderToStaticMarkup` dùng getServerSnapshot ⇒ `isMobile = false` ⇒ trả về null. Ngoài ra không được
 * chạm tới `Notification` / `matchMedia` / `ResizeObserver` (chỉ chạy trong hiệu ứng phía client).
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { App as AntdApp } from 'antd';
import { FgMobileOnboardingBar } from './mobile-onboarding.tsx';

describe('FgMobileOnboardingBar', () => {
  it('không phải thiết bị di động ⇒ không render gì (desktop giữ nguyên header)', () => {
    const html = renderToStaticMarkup(
      <AntdApp component={false}>
        <FgMobileOnboardingBar />
      </AntdApp>,
    );
    expect(html).toBe('');
  });
});

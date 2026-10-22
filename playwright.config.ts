/**
 * E2E trên trình duyệt thật (Chromium) — chạy với app đang bật (`pnpm dev`), không tự khởi động server.
 *
 *   npx playwright test e2e/v2-partners.spec.ts
 *
 * `PW_AREA` tách thư mục kết quả + phiên đăng nhập theo nhóm test để nhiều tiến trình chạy song song.
 */
import { defineConfig, devices } from '@playwright/test';

const area = process.env.PW_AREA || 'default';

export default defineConfig({
  testDir: './e2e',
  outputDir: `test-results/${area}`,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: `test-results/${area}/report.json` }]],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5139',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } } }],
});

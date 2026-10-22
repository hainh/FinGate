/**
 * Fix3 — lỗi tạm thời khi tải /me (502 / mất mạng) không được đưa người dùng về màn Đăng nhập.
 * store.tsx: chỉ 401 / FG-AUTH-001 mới là hết phiên; lỗi khác hiện "Thử lại" và tự tải lại /me.
 */
import { test, expect } from './fixtures';

const ME = '**/api/v1/me';
const AGING_URL = '/cong-no?view=aging';
const AGING_MARK = 'Tuổi nợ theo đối tác';

test.describe('Phiên đăng nhập khi /me lỗi tạm thời', () => {
  test('502 khi tải /me: không về màn Đăng nhập, hiện lỗi "Thử lại", rồi tự tải lại và vào được màn', async ({ as }) => {
    const page = await as('director');
    let apiDown = true;
    await page.route(ME, (route) =>
      apiDown ? route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }) : route.continue(),
    );

    await page.goto(AGING_URL);
    await expect(page.getByText('Hệ thống đang gặp sự cố')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Thử lại' })).toBeVisible();
    await expect(page.getByLabel('Email công việc')).toHaveCount(0);

    // API khởi động lại xong → màn tự tải lại /me, không cần bấm gì
    apiDown = false;
    await expect(page.getByText(AGING_MARK)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Hệ thống đang gặp sự cố')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/cong-no');
  });

  test('bấm "Thử lại" sau khi API sẵn sàng thì vào được màn (không mất phiên)', async ({ as }) => {
    const page = await as('staff');
    let apiDown = true;
    await page.route(ME, (route) =>
      apiDown ? route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }) : route.continue(),
    );

    await page.goto(AGING_URL);
    await expect(page.getByText('Hệ thống đang gặp sự cố')).toBeVisible({ timeout: 20_000 });
    apiDown = false;
    await page.getByRole('button', { name: 'Thử lại' }).click();
    await expect(page.getByText(AGING_MARK)).toBeVisible({ timeout: 30_000 });
    expect(new URL(page.url()).pathname).toBe('/cong-no');
  });

  test('401 FG-AUTH-001 khi tải /me vẫn đưa về màn Đăng nhập', async ({ as }) => {
    const page = await as('staff');
    await page.route(ME, (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        body: JSON.stringify({ type: 'about:blank', title: 'Phiên làm việc đã kết thúc', status: 401, code: 'FG-AUTH-001' }),
      }),
    );

    await page.goto(AGING_URL);
    await expect(page).toHaveURL(/\/dang-nhap/, { timeout: 20_000 });
    await expect(page.getByLabel('Email công việc')).toBeVisible();
  });
});

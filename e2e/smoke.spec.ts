import { test, expect } from './fixtures';

test('đăng nhập KTV và mở trang chủ', async ({ as }) => {
  const page = await as('staff');
  await page.goto('/');
  await expect(page.locator('body')).not.toContainText('Đăng nhập', { timeout: 15_000 });
});

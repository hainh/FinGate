/**
 * BANK-01 — màn "Tài khoản tiền": khi phạm vi đang chọn là MỘT công ty con thì danh sách và 2 thẻ KPI
 * KHÔNG còn tài khoản / quỹ của Tập đoàn (`is_group`); "Toàn tập đoàn" và pháp nhân Tập đoàn vẫn thấy đủ.
 *
 * Kiểm cả UI lẫn API (`GET /bank-accounts?group=subsidiary`) để khẳng định việc ẩn là do MÁY CHỦ lọc
 * (KPI tính lại trên tập đó), không phải chỉ ẩn dòng ở client.
 */
import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

const EMAIL = 'admin@fingate.maygogu.com';
const PASSWORD = '123qweasdzxc';

interface AccountRow {
  _id: string;
  label: string;
  is_group: boolean;
}

/** Trang đã đăng nhập bằng tài khoản quản trị cấp Tập đoàn (thấy "Toàn tập đoàn"). */
async function adminPage(page: Page): Promise<Page> {
  const res = await page.request.post('/api/v1/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  expect(res.ok(), `login admin: ${res.status()} ${await res.text()}`).toBeTruthy();
  return page;
}

/** Ô chuyển phạm vi (OVL-10) ở header. */
async function pickScope(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: 'Phạm vi dữ liệu' }).click();
  await page.locator('.ant-dropdown-menu-item:visible', { hasText: label }).first().click();
  await expect(page.locator('.ant-dropdown:visible')).toHaveCount(0);
}

/** Số tiền ở thẻ KPI "Tổng số dư sổ cái". */
async function kpiBalance(page: Page): Promise<string> {
  const card = page.locator('.fg-kpi').filter({ hasText: 'Tổng số dư sổ cái' }).first();
  await expect(card).toBeVisible();
  return (await card.locator('.fg-kpi-value').first().innerText()).trim();
}

const GROUP_HINT = /Chỉ tài khoản của .* \(không gồm tài khoản Tập đoàn\)/;

test.describe.serial('BANK-01 · ẩn tài khoản Tập đoàn khi phạm vi là công ty con', () => {
  test('API: group=subsidiary loại hết TK Tập đoàn, KPI nhỏ hơn; giá trị lạ bị chặn', async ({ page }) => {
    await adminPage(page);

    const all = (await (await page.request.get('/api/v1/bank-accounts?scope=all')).json()) as { items: AccountRow[]; totals: { balance: { minor: string } } };
    const groupRows = all.items.filter((r) => r.is_group);
    expect(groupRows.length, 'DB phải có ít nhất 1 TK Tập đoàn để phép thử có nghĩa').toBeGreaterThan(0);

    const subRes = await page.request.get('/api/v1/bank-accounts?scope=all&group=subsidiary');
    expect(subRes.ok()).toBeTruthy();
    const sub = (await subRes.json()) as { items: AccountRow[]; totals: { balance: { minor: string } } };
    expect(sub.items.filter((r) => r.is_group)).toEqual([]);
    expect(sub.items.length).toBe(all.items.length - groupRows.length);
    expect(BigInt(sub.totals.balance.minor)).toBeLessThan(BigInt(all.totals.balance.minor));

    const bad = await page.request.get('/api/v1/bank-accounts?scope=all&group=xyz');
    expect(bad.status(), 'group lạ phải bị contract từ chối').toBe(422);
  });

  test('UI: phạm vi Toàn tập đoàn thấy TK Tập đoàn; chuyển sang công ty con thì không còn', async ({ page }) => {
    await adminPage(page);
    await page.goto('/ngan-hang/taikhoan');
    await expect(page.getByRole('heading', { name: 'Tài khoản tiền' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Phạm vi dữ liệu' })).toContainText('Toàn tập đoàn');

    const table = page.locator('.fg-table tbody');
    await expect(table.locator('tr').first()).toBeVisible({ timeout: 15_000 });
    await expect(table).toContainText('Tài khoản Tập đoàn'); // mốc: đang thấy TK Tập đoàn
    await expect(page.getByText(GROUP_HINT)).toHaveCount(0);
    const kpiAll = await kpiBalance(page);

    // Chuyển sang một công ty con thật (không phải pháp nhân Tập đoàn)
    await pickScope(page, 'VIXITO ·');
    await expect(page.getByRole('button', { name: 'Phạm vi dữ liệu' })).toContainText('VIXITO');
    await expect(page.getByText(GROUP_HINT)).toBeVisible({ timeout: 15_000 });

    const rows = page.locator('.fg-table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      await expect(rows.nth(i), `dòng ${i} không được là TK Tập đoàn`).not.toContainText('Tài khoản Tập đoàn');
    }
    const kpiSub = await kpiBalance(page);
    expect(kpiSub, 'KPI phải tính lại: không cộng tiền Tập đoàn').not.toBe(kpiAll);

    // Chi tiết TK của công ty con vẫn mở bình thường
    await rows.first().click();
    await expect(page).toHaveURL(/\/ngan-hang\/taikhoan\/[a-f0-9]{24}/);
    await expect(page.getByRole('heading', { name: /Lịch sử giao dịch/ })).toBeVisible({ timeout: 15_000 });
  });

  test('UI: phạm vi pháp nhân Tập đoàn giữ nguyên danh sách có TK Tập đoàn', async ({ page }) => {
    await adminPage(page);
    await page.goto('/ngan-hang/taikhoan');
    await expect(page.getByRole('button', { name: 'Phạm vi dữ liệu' })).toBeVisible();

    await pickScope(page, 'GROUP ·');
    await expect(page.getByRole('button', { name: 'Phạm vi dữ liệu' })).toContainText('GROUP');
    await expect(page.locator('.fg-table tbody')).toContainText('Tài khoản Tập đoàn', { timeout: 15_000 });
    await expect(page.getByText(GROUP_HINT)).toHaveCount(0);
  });
});

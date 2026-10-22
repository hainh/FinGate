/**
 * Nhóm fix3 — hai lỗi nhỏ trên form/hồ sơ (v2/v2.md §10.3, §11.4; docs/02_design_system.md §4.3):
 *
 * 1) R2: sửa phiếu "Gắn khoản vay đã có" → "Để sau" rồi "Lưu thay đổi". Màn hồ sơ mở NGAY sau đó phải hiện
 *    trạng thái vừa lưu ("Chưa gắn khoản vay …"), không được hiện banner của khoản cũ tới lần tải lại kế tiếp.
 *    Test KHÔNG tải lại trang sau khi lưu (tải lại sẽ che lỗi).
 * 2) Đảo hạn: nhãn "Khoản vay đang đảo hạn" hiện ngày DD/MM/YYYY (không hiện ISO yyyy-mm-dd).
 *
 *   PW_AREA=fix3 npx playwright test e2e/fix3-r2-stale-save.spec.ts
 *
 * Dữ liệu: mỗi test tạo đối tác ngân hàng riêng (uniq) trong công ty CTA. Đăng nhập: fixture `as`.
 */
import type { Page } from '@playwright/test';
import { test, expect, uniq, type Role } from './fixtures';
import {
  borrowCheckbox,
  companyIdOf,
  createManualLoan,
  createPartner,
  docIdFromUrl,
  eventually,
  fieldOf,
  fillAmount,
  getDocument,
  pickLoanMode,
  pickPartner,
  pickSelect,
  setDefaultScope,
  watchErrors,
  ddmmyyyy,
} from './helpers-r2';

/** Lỗi JS / HTTP 5xx của lượt test hiện tại (xem `watchErrors`). */
let pageErrors: string[] = [];

test.beforeEach(() => {
  pageErrors = [];
});

test.afterEach(() => {
  expect(pageErrors, 'lỗi JS (pageerror) / HTTP 5xx trong lượt test này').toEqual([]);
});

/** Liên kết của phiếu (một phần của `DocumentDetail.links`, đủ cho các kiểm tra ở đây). */
interface WireLink {
  relation?: string;
  status?: string;
  counterpart?: { id?: string } | null;
}

/** Liên kết giải ngân đang hiệu lực của phiếu tới một khoản vay. */
function activeDisbursementTo(d: { links?: WireLink[] }, loanId: string): WireLink[] {
  return (d.links ?? []).filter((l) => l.relation === 'disbursement' && l.status === 'active' && l.counterpart?.id === loanId);
}

/** Đăng nhập kế toán viên; thử lại khi máy chủ đang khởi động lại (502/503) do bản sửa khác. */
async function staffPage(as: (r: Role) => Promise<Page>) {
  const page = await loginRetry(as);
  watchErrors(page, pageErrors);
  const cta = await companyIdOf(page, 'CTA');
  await setDefaultScope(page, cta);
  return { page, cta };
}

async function loginRetry(as: (r: Role) => Promise<Page>): Promise<Page> {
  for (let i = 0; ; i++) {
    try {
      return await as('staff');
    } catch (e) {
      if (i >= 3 || !/50[23]|ECONNRESET|ECONNREFUSED/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
}

/** Phiếu thu đi vay ở chế độ "Gắn khoản vay đã có" (lưu nháp) — trả về mã hồ sơ. */
async function createExistingLoanReceipt(page: Page, bank: { _id: string; name: string }, loanCode: string, amount: string): Promise<string> {
  await page.goto('/thu/moi');
  await expect(page.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 30_000 });
  await fieldOf(page, /^Nội dung \/ mục đích/).locator('textarea').fill(uniq('Gắn có sẵn fix'));
  await pickPartner(page, /^Bên nộp tiền/, bank.name);
  await fillAmount(page, amount);
  await pickSelect(page, /^Tài khoản đích/, null, /Cty A/);
  await borrowCheckbox(page).check();
  await pickLoanMode(page, 'Gắn khoản vay đã có');
  await pickSelect(page, /^Khoản vay có sẵn/, loanCode);
  await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
  await page.waitForURL(/\/ho-so\/thu\/[0-9a-f]{24}$/, { timeout: 30_000 });
  return docIdFromUrl(page.url());
}

test('fix R2 · sửa "Gắn khoản vay đã có" → "Để sau" rồi lưu: màn hồ sơ hiện ngay trạng thái vừa lưu (không tải lại trang)', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH fix stale'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const docId = await createExistingLoanReceipt(page, bank, manual.code, '50000000');

  // Hồ sơ đang hiện banner liên kết tới khoản đã có (bản đệm của trang chi tiết vừa tải).
  await expect(page.getByText(`Gắn vào khoản vay ${manual.code}`)).toBeVisible({ timeout: 30_000 });
  await eventually('liên kết giải ngân tới khoản đã có', () => getDocument(page, docId, cta), (d) => activeDisbursementTo(d, manual._id).length > 0);

  // Sửa NGAY trong cùng phiên (không page.goto): màn sửa dùng chung bản đệm của hồ sơ, rồi đổi sang "Để sau" và lưu.
  await page.getByRole('button', { name: 'Sửa', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Lưu thay đổi', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Số tiền', { exact: true })).toHaveValue('50.000.000', { timeout: 30_000 });
  await pickLoanMode(page, 'Để sau');
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await page.waitForURL(/\/ho-so\/thu\/[0-9a-f]{24}$/, { timeout: 30_000 });

  // Máy chủ đã lưu đúng (không phụ thuộc giao diện).
  const d = await getDocument(page, docId, cta);
  expect(d.options?.loan?.mode, 'chế độ đã lưu = để sau').toBe('later');
  expect.soft(activeDisbursementTo(d, manual._id), 'để sau: không còn liên kết giải ngân hiệu lực tới khoản cũ').toHaveLength(0);

  // Ngay sau khi lưu: màn hồ sơ phải hiện trạng thái MỚI, không còn banner của khoản cũ (không tải lại trang).
  await expect(page.getByText('Chưa gắn khoản vay — gán sau từ khoản vay hoặc từ phiếu')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(`Gắn vào khoản vay ${manual.code}`)).toHaveCount(0);

  // Và vẫn đúng sau một lúc (bản đệm cũ không được "sống lại" khi trang đang mở).
  await page.waitForTimeout(16_000);
  await expect(page.getByText('Chưa gắn khoản vay — gán sau từ khoản vay hoặc từ phiếu')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(`Gắn vào khoản vay ${manual.code}`)).toHaveCount(0);
});

test('fix đảo hạn · nhãn "Khoản vay đang đảo hạn" hiện ngày DD/MM/YYYY (không ISO)', async ({ as }) => {
  test.setTimeout(120_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH fix nhãn đảo hạn'));
  const maturity = '2027-12-31';
  const loan = await createManualLoan(page, cta, bank._id, '30000000', maturity);

  await page.goto('/ngan-hang/dao-han/phuong-an/moi');
  await expect(fieldOf(page, /^Khoản vay đang đảo hạn/)).toBeVisible({ timeout: 30_000 });
  await pickPartner(page, /^Ngân hàng$/, bank.name);
  await fieldOf(page, /^Khoản vay đang đảo hạn/).locator('.ant-select').first().click();

  const option = page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: loan.code }).first();
  await expect(option, 'nhãn khoản đảo hạn có ngày đáo hạn DD/MM/YYYY').toContainText(`đáo hạn ${ddmmyyyy(maturity)}`, { timeout: 20_000 });
  await expect(option, 'nhãn khoản đảo hạn không còn ISO yyyy-mm-dd').not.toContainText(maturity);
});

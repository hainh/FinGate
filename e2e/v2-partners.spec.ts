/**
 * E2E màn ĐỐI TÁC (v2/v2.md §5, US-PAR-01..09) — chạy với app đang bật (pnpm dev do người dùng chạy).
 *
 *   PW_AREA=partners npx playwright test e2e/v2-partners.spec.ts
 *
 * Mỗi bài test tự chuẩn bị dữ liệu bằng uniq() (không phụ thuộc số lượng toàn cục) và kiểm tra cả
 * giao diện lẫn API. Chỉ dùng tài khoản test chung (mật khẩu trong fixtures.ts).
 */
import { test, expect, uniq } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import {
  COMPANY,
  FAR_FUTURE,
  LONG_PAST,
  LIST_COL,
  api,
  pinScope,
  cellOf,
  clickMenuItem,
  companyId,
  createDebtApi,
  createLoanApi,
  createPartnerApi,
  dialogWith,
  fillPartnerForm,
  findPartnerApi,
  getDebtApi,
  getDocumentApi,
  getLoanApi,
  getPartnerApi,
  gotoDetail,
  gotoList,
  menuItemDisabled,
  moneyDigits,
  openRowMenu,
  optionsApi,
  patchPartnerApi,
  pickSegment,
  randomDigits,
  rowOf,
  searchList,
  setStatusApi,
  watchErrors,
} from './helpers-partners';

// Phạm vi mặc định lưu trên máy chủ theo người dùng → ghim về CTA trước mỗi bài (tránh trạng thái do bài khác để lại).
test.beforeEach(async ({ as }) => {
  for (const role of ['staff', 'director'] as const) {
    const p = await as(role);
    await pinScope(p, COMPANY.CTA);
  }
});

/* ================= tiện ích cục bộ ================= */

/** Ô chọn (antd Select) có các thuộc tính aria-label của bộ lọc màn danh sách. */
async function pickFilterOption(page: Page, ariaLabel: string, optionText: string): Promise<void> {
  await page.locator(`[aria-label="${ariaLabel}"]`).first().click();
  await page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: optionText })
    .first()
    .click();
}

/**
 * Ô chọn đối tác trên form phiếu / công nợ / khoản vay. Placeholder tuỳ form: "Tìm khách hàng / ngân hàng…"
 * (thu), "Tìm nhà cung cấp / đối tác…" (chi), "Tìm theo tên, số tài khoản, MST…" (mặc định), "Tìm ngân hàng…".
 */
function partnerPicker(page: Page): Locator {
  return page.locator('.ant-select').filter({ hasText: /Tìm (khách hàng|nhà cung cấp|ngân hàng|đối tác|theo tên)|Chọn ngân hàng|Chỉ chọn đối tác Ngân hàng/ }).first();
}

/** Gõ tìm trong ô chọn đối tác của form và trả về dropdown đang mở. */
async function searchPicker(page: Page, text: string): Promise<Locator> {
  const sel = partnerPicker(page);
  await sel.click();
  await sel.locator('input').first().fill(text);
  return page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
}

/** Tên đối tác đang hiển thị trong ô chọn đối tác của form (đã chọn sẵn; nhãn nằm trong gốc .ant-select). */
function selectedPartnerItem(page: Page, name: string): Locator {
  return page.locator('.ant-select').filter({ hasText: name }).first();
}

/** Thu thập số tiền (chữ số) trong dòng chọn theo cột theo tên header, để tránh phụ thuộc chỉ số cột. */
async function rowCellDigits(page: Page, name: string, col: number): Promise<string> {
  return moneyDigits(await cellOf(page, name, col).textContent());
}

/** Hàng bảng trong hộp thoại (Trả nợ / Sao chép) có chứa `text`. */
function dialogRow(dlg: Locator, text: string): Locator {
  return dlg.locator('tr.ant-table-row').filter({ hasText: text });
}

/** Chọn một hàng trong bảng hộp thoại (checkbox của antd). */
async function tickRow(dlg: Locator, text: string): Promise<void> {
  await dialogRow(dlg, text).locator('label.ant-checkbox-wrapper').click();
}

/** Mở trang Trả nợ của đối tác từ màn chi tiết. */
async function openSettle(page: Page, partnerId: string): Promise<Locator> {
  await gotoDetail(page, partnerId);
  await page.getByRole('button', { name: 'Trả nợ', exact: true }).click();
  return dialogWith(page, /Trả nợ — /);
}

/** Mã id phiếu từ URL /ho-so/<loai>/<id>. */
async function docIdFromUrl(page: Page): Promise<string> {
  await page.waitForURL(/\/ho-so\/(thu|chi)\/[a-f0-9]{24}/, { timeout: 30_000 });
  const m = page.url().match(/\/ho-so\/(?:thu|chi)\/([a-f0-9]{24})/);
  if (!m) throw new Error(`không đọc được id phiếu từ URL ${page.url()}`);
  return m[1];
}

/** Một dòng của tab đối tác (GET /partners/:id/debts | /loans), theo _id. */
async function partnerTabRow(page: Page, code: string, partnerId: string, tab: 'debts' | 'loans', rowId: string): Promise<any> {
  const scope = await companyId(page, code);
  const r = await api(page, 'GET', `/partners/${partnerId}/${tab}`, { scope });
  expect(r.status, r.text).toBe(200);
  return (r.body?.items ?? []).find((x: any) => x._id === rowId);
}

/** Số tiền (chuỗi minor) từ wire {minor, currency} hoặc {amount_minor}. */
function moneyWire(m: any): string | undefined {
  return m?.minor ?? m?.amount_minor ?? undefined;
}

/* ================= 1. Danh sách & bộ lọc ================= */

test.describe('Danh sách đối tác & bộ lọc', () => {
  test('danh sách có đủ cột tóm tắt, không lỗi trang', async ({ as }) => {
    const page = await as('staff');
    const errors = watchErrors(page);
    await gotoList(page);
    for (const h of ['Đối tác', 'Loại', 'Ngân hàng · STK · MST', 'Còn phải thu', 'Còn phải trả', 'Quá hạn', 'Dư nợ', 'Đáo hạn gần nhất', 'Tổng thu', 'Tổng chi', 'Trạng thái']) {
      await expect(page.locator('thead').getByText(h, { exact: true }).first(), `cột "${h}"`).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Sao chép từ công ty khác' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ Tạo đối tác', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('lọc theo loại đối tác: Ngân hàng / Khách hàng / Nhà cung cấp', async ({ as }) => {
    const page = await as('staff');
    // mọi đối tác của bài test dùng chung một tiền tố (tag) để tìm đúng nhóm, không phụ thuộc phân trang
    const tag = uniq('loc loai');
    const bank = await createPartnerApi(page, COMPANY.CTA, { type: 'bank', name: `${tag} NH`, bank_name: 'BIDV', account_number: randomDigits() });
    const cust = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: `${tag} KH` });
    const supp = await createPartnerApi(page, COMPANY.CTA, { type: 'supplier', name: `${tag} NCC` });
    await gotoList(page);
    await searchList(page, tag);
    await expect(rowOf(page, bank.name)).toBeVisible();
    await expect(rowOf(page, cust.name)).toBeVisible();

    await pickFilterOption(page, 'Lọc theo loại đối tác', 'Ngân hàng');
    await expect(page).toHaveURL(/type=bank/);
    await expect(rowOf(page, bank.name)).toBeVisible();
    await expect(rowOf(page, cust.name)).toHaveCount(0);
    await expect(rowOf(page, supp.name)).toHaveCount(0);

    await pickFilterOption(page, 'Lọc theo loại đối tác', 'Khách hàng');
    await expect(page).toHaveURL(/type=customer/);
    await expect(rowOf(page, cust.name)).toBeVisible();
    await expect(rowOf(page, bank.name)).toHaveCount(0);

    await pickFilterOption(page, 'Lọc theo loại đối tác', 'Nhà cung cấp');
    await expect(page).toHaveURL(/type=supplier/);
    await expect(rowOf(page, supp.name)).toBeVisible();
    await expect(rowOf(page, cust.name)).toHaveCount(0);
  });

  test('lọc theo trạng thái: Hoạt động / Ngừng giao dịch', async ({ as }) => {
    const page = await as('staff');
    const tag = uniq('loc trang thai');
    const active = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: `${tag} A` });
    const inactive = await createPartnerApi(page, COMPANY.CTA, { type: 'supplier', name: `${tag} B` });
    await setStatusApi(page, COMPANY.CTA, inactive._id, 'inactive');
    await gotoList(page);
    await searchList(page, tag);
    await pickFilterOption(page, 'Lọc theo trạng thái', 'Ngừng giao dịch');
    await expect(page).toHaveURL(/status=inactive/);
    await expect(rowOf(page, inactive.name)).toBeVisible();
    await expect(rowOf(page, active.name)).toHaveCount(0);
    await pickFilterOption(page, 'Lọc theo trạng thái', 'Hoạt động');
    await expect(page).toHaveURL(/status=active/);
    await expect(rowOf(page, active.name)).toBeVisible();
    await expect(rowOf(page, inactive.name)).toHaveCount(0);
  });

  test('tìm theo tên, số tài khoản và MST; không khớp thì báo trống và xoá lọc được', async ({ as }) => {
    const page = await as('staff');
    const acc = randomDigits(11);
    const tax = randomDigits(10);
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Tim kiem'), bank_name: 'Vietcombank', account_number: acc, tax_code: tax });
    await gotoList(page);
    await searchList(page, p.name);
    await expect(rowOf(page, p.name)).toBeVisible();
    await searchList(page, acc);
    await expect(rowOf(page, p.name), 'tìm theo số tài khoản').toBeVisible();
    await searchList(page, tax);
    await expect(rowOf(page, p.name), 'tìm theo MST').toBeVisible();
    await searchList(page, `khong-co ${randomDigits(9)}`);
    await expect(page.getByText('Không có đối tác với bộ lọc này')).toBeVisible();
    await page.getByRole('button', { name: 'Xoá lọc', exact: true }).click();
    await expect(page.getByText('Không có đối tác với bộ lọc này')).toHaveCount(0);
  });

  test('kỳ tổng hợp: đổi kỳ cập nhật tham số period và tiêu đề cột "Đã thực thi"', async ({ as }) => {
    const page = await as('staff');
    await gotoList(page);
    const d = new Date();
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const label = `Tháng ${String(prev.getMonth() + 1).padStart(2, '0')}/${prev.getFullYear()}`;
    await pickFilterOption(page, 'Kỳ tổng hợp thu/chi', label);
    await expect(page).toHaveURL(/period=\d{4}-\d{2}/);
    await expect(page.getByText(`Đã thực thi · ${label}`).first()).toBeVisible();
  });
});

/* ================= 2. Tạo đối tác (US-PAR-01, US-PAR-07) ================= */

test.describe('Tạo đối tác', () => {
  test('tạo Khách hàng bằng popup: mã DT tự sinh, lưu đúng loại và thông tin', async ({ as }) => {
    const page = await as('staff');
    const errors = watchErrors(page);
    const name = uniq('KH moi');
    const acc = randomDigits();
    const tax = randomDigits(10);
    await gotoList(page);
    await page.getByRole('button', { name: '+ Tạo đối tác', exact: true }).click();
    const dlg = dialogWith(page, 'Tên đối tác');
    await expect(dlg).toBeVisible();
    await fillPartnerForm(dlg, { type: 'customer', name, bank: 'Vietcombank', account: acc, tax, note: 'ghi chú kiểm thử' });
    await dlg.getByRole('button', { name: 'Tạo đối tác', exact: true }).click();
    await expect(page.getByText('Đã tạo đối tác', { exact: true })).toBeVisible();
    await searchList(page, name);
    await expect(rowOf(page, name)).toBeVisible();
    await expect(cellOf(page, name, LIST_COL.type)).toHaveText('Khách hàng');
    await expect(cellOf(page, name, LIST_COL.bank)).toContainText('Vietcombank');
    await expect(cellOf(page, name, LIST_COL.bank)).toContainText(acc);
    const p = await findPartnerApi(page, COMPANY.CTA, name);
    expect(p, 'đối tác vừa tạo có trong API').toBeTruthy();
    expect(p!.type).toBe('customer');
    expect(p!.status).toBe('active');
    expect(p!.code).toMatch(/^DT-\d{4}-\d{5}$/);
    expect(p!.bank_name).toBe('Vietcombank');
    expect(p!.account_number).toBe(acc);
    expect(p!.tax_code).toBe(tax);
    expect(errors).toEqual([]);
  });

  test('tạo Nhà cung cấp bằng popup: loại Nhà cung cấp', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('NCC moi');
    await gotoList(page);
    await page.getByRole('button', { name: '+ Tạo đối tác', exact: true }).click();
    const dlg = dialogWith(page, 'Tên đối tác');
    await fillPartnerForm(dlg, { type: 'supplier', name, bank: 'ACB', account: randomDigits(), tax: randomDigits(10) });
    await dlg.getByRole('button', { name: 'Tạo đối tác', exact: true }).click();
    await expect(page.getByText('Đã tạo đối tác', { exact: true })).toBeVisible();
    await searchList(page, name);
    await expect(cellOf(page, name, LIST_COL.type)).toHaveText('Nhà cung cấp');
    const p = await findPartnerApi(page, COMPANY.CTA, name);
    expect(p?.type).toBe('supplier');
  });

  test('tạo đối tác Ngân hàng: ô tên gợi ý "ngân hàng + chi nhánh", loại Ngân hàng, không có phải thu', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('BIDV CN');
    await gotoList(page);
    await page.getByRole('button', { name: '+ Tạo đối tác', exact: true }).click();
    const dlg = dialogWith(page, 'Tên đối tác');
    await fillPartnerForm(dlg, { type: 'bank', name, bank: 'BIDV', account: randomDigits(12) });
    await dlg.getByRole('button', { name: 'Tạo đối tác', exact: true }).click();
    await expect(page.getByText('Đã tạo đối tác', { exact: true })).toBeVisible();
    await searchList(page, name);
    await expect(cellOf(page, name, LIST_COL.type)).toHaveText('Ngân hàng');
    await expect(cellOf(page, name, LIST_COL.receivable)).toHaveText('—');
    const p = await findPartnerApi(page, COMPANY.CTA, name);
    expect(p?.type).toBe('bank');
  });

  test('tên đối tác tối thiểu 2 ký tự: báo lỗi và không gửi yêu cầu tạo', async ({ as }) => {
    const page = await as('staff');
    let posted = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/v1\/partners$/.test(r.url())) posted++;
    });
    await gotoList(page);
    await page.getByRole('button', { name: '+ Tạo đối tác', exact: true }).click();
    const dlg = dialogWith(page, 'Tên đối tác');
    await fillPartnerForm(dlg, { name: 'A' });
    await dlg.getByRole('button', { name: 'Tạo đối tác', exact: true }).click();
    await expect(dlg.getByText('Tên đối tác tối thiểu 2 ký tự')).toBeVisible();
    await page.waitForTimeout(500);
    expect(posted).toBe(0);
    await expect(dlg).toBeVisible();
  });

  test('cảnh báo trùng tên: hiện trước khi lưu, vẫn lưu được và báo lại sau khi lưu (khác loại)', async ({ as }) => {
    const page = await as('staff');
    const errors = watchErrors(page);
    const existing = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Trung ten') });
    await gotoList(page);
    await page.getByRole('button', { name: '+ Tạo đối tác', exact: true }).click();
    const dlg = dialogWith(page, 'Tên đối tác');
    await fillPartnerForm(dlg, { type: 'supplier', name: existing.name });
    await expect(dlg.getByText('Có thể trùng với đối tác đã có — vẫn lưu được')).toBeVisible({ timeout: 15_000 });
    await expect(dlg.getByText(/Trùng tên với đối tác/)).toBeVisible();
    await dlg.getByRole('button', { name: 'Tạo đối tác', exact: true }).click();
    await expect(page.getByText('Cảnh báo trùng đối tác — đối tác vẫn đã được lưu')).toBeVisible();
    await searchList(page, existing.name);
    await expect(rowOf(page, existing.name), 'cả hai đối tác cùng tên đều được lưu').toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('cảnh báo trùng (ngân hàng, số tài khoản) khác loại: không chặn lưu, chuẩn hoá tên NH và STK', async ({ as }) => {
    const page = await as('staff');
    const acc = randomDigits(10);
    const first = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('STK goc'), bank_name: 'Techcombank', account_number: acc });
    const name = uniq('STK trung');
    await gotoList(page);
    await page.getByRole('button', { name: '+ Tạo đối tác', exact: true }).click();
    const dlg = dialogWith(page, 'Tên đối tác');
    // ngân hàng viết thường + STK có gạch ngang: vẫn được coi là trùng (chuẩn hoá)
    await fillPartnerForm(dlg, { type: 'supplier', name, bank: 'techcombank', account: `${acc.slice(0, 4)}-${acc.slice(4)}` });
    await expect(dlg.getByText(/Trùng ngân hàng và số tài khoản với đối tác/)).toBeVisible({ timeout: 15_000 });
    await expect(dlg.getByText(new RegExp(first.code))).toBeVisible();
    await dlg.getByRole('button', { name: 'Tạo đối tác', exact: true }).click();
    await expect(page.getByText('Cảnh báo trùng đối tác — đối tác vẫn đã được lưu')).toBeVisible();
    await searchList(page, name);
    await expect(rowOf(page, name)).toBeVisible();
  });

  test('không cảnh báo khi chỉ trùng số tài khoản nhưng khác ngân hàng', async ({ as }) => {
    const page = await as('staff');
    const acc = randomDigits(10);
    await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('STK A'), bank_name: 'Vietcombank', account_number: acc });
    await gotoList(page);
    await page.getByRole('button', { name: '+ Tạo đối tác', exact: true }).click();
    const dlg = dialogWith(page, 'Tên đối tác');
    await fillPartnerForm(dlg, { type: 'supplier', name: uniq('STK B'), bank: 'Agribank', account: acc });
    await page.waitForTimeout(1500);
    await expect(dlg.getByText('Có thể trùng với đối tác đã có')).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Hủy', exact: true }).click();
  });
});

/* ================= 3. Sửa & lịch sử (US-PAR-08) ================= */

test.describe('Sửa đối tác & lịch sử', () => {
  test('sửa từ danh sách: đổi tên và ngân hàng; lịch sử ghi từ → sang', async ({ as }) => {
    const page = await as('staff');
    const oldName = uniq('Sua cu');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: oldName, bank_name: 'ACB', account_number: randomDigits() });
    const newName = uniq('Sua moi');
    await gotoList(page);
    await searchList(page, oldName);
    await openRowMenu(page, oldName);
    await clickMenuItem(page, 'Sửa');
    const dlg = dialogWith(page, /Sửa đối tác/);
    await dlg.getByPlaceholder('VD: Công ty TNHH ABC').fill(newName);
    await dlg.getByPlaceholder('VD: Vietcombank').fill('Techcombank');
    await dlg.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await expect(page.getByText('Đã lưu đối tác', { exact: true })).toBeVisible();
    await searchList(page, newName);
    await expect(rowOf(page, newName)).toBeVisible();

    await gotoDetail(page, p._id);
    await page.getByRole('tab', { name: 'Lịch sử' }).click();
    const nameRow = page.locator('tr.ant-table-row').filter({ hasText: 'Tên' }).filter({ hasText: oldName }).filter({ hasText: newName });
    await expect(nameRow, 'lịch sử: Tên từ cũ → mới').toHaveCount(1);
    const me = await api(page, 'GET', '/me');
    const displayName: string = (me.body?.data ?? me.body)?.display_name;
    await expect(nameRow, 'lịch sử ghi người sửa').toContainText(displayName);
    const bankRow = page.locator('tr.ant-table-row').filter({ hasText: 'Ngân hàng' }).filter({ hasText: 'ACB' }).filter({ hasText: 'Techcombank' });
    await expect(bankRow, 'lịch sử: Ngân hàng ACB → Techcombank').toHaveCount(1);

    const detail = await getPartnerApi(page, COMPANY.CTA, p._id);
    const last = (detail.history ?? [])[0];
    expect(last?.changes?.name?.from).toBe(oldName);
    expect(last?.changes?.name?.to).toBe(newName);
  });

  test('sửa từ màn chi tiết (Khác → Sửa đối tác): đổi MST, hiển thị ngay', async ({ as }) => {
    const page = await as('staff');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'supplier', name: uniq('Sua chi tiet'), tax_code: '0100000001' });
    const newTax = randomDigits(10);
    await gotoDetail(page, p._id);
    await page.getByRole('button', { name: 'Khác ▾' }).click();
    await clickMenuItem(page, 'Sửa đối tác');
    const dlg = dialogWith(page, /Sửa đối tác/);
    await dlg.getByPlaceholder('VD: 0101234567').fill(newTax);
    await dlg.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await expect(page.getByText('Đã lưu đối tác', { exact: true })).toBeVisible();
    await expect(page.locator('.ant-descriptions-item-content', { hasText: newTax })).toBeVisible();
  });
});

/* ================= 4. Ngừng / kích hoạt (US-PAR-06) ================= */

test.describe('Ngừng và kích hoạt lại', () => {
  test('ngừng giao dịch: khoá Thu/Chi, không hiện trong ô chọn đối tác của phiếu', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('Ngung GD');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name });
    await gotoList(page);
    await searchList(page, name);
    await openRowMenu(page, name);
    await clickMenuItem(page, 'Ngừng giao dịch');
    const dlg = dialogWith(page, 'Ngừng giao dịch với đối tác?');
    await dlg.getByRole('button', { name: 'Ngừng giao dịch', exact: true }).click();
    await expect(page.getByText('Đã ngừng giao dịch', { exact: true })).toBeVisible();
    await expect(cellOf(page, name, LIST_COL.status)).toHaveText('Ngừng giao dịch');

    await gotoDetail(page, p._id);
    await expect(page.getByText('Đối tác đang ngừng giao dịch')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Thu', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Chi', exact: true })).toBeDisabled();

    const opts = await optionsApi(page, COMPANY.CTA, name);
    expect(opts.find((o) => o._id === p._id), 'ô chọn (API) không trả đối tác ngừng').toBeUndefined();

    await page.goto('/thu/moi?kind=income');
    const dd = await searchPicker(page, name);
    await expect(dd.getByText('Không có đối tác phù hợp')).toBeVisible({ timeout: 15_000 });
    await expect(dd.getByText(name, { exact: true })).toHaveCount(0);
  });

  test('kích hoạt lại: đối tác chọn lại được và các nút thao tác mở lại', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('Kich hoat lai');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name });
    await setStatusApi(page, COMPANY.CTA, p._id, 'inactive');
    await gotoList(page);
    await searchList(page, name);
    await openRowMenu(page, name);
    await clickMenuItem(page, 'Kích hoạt lại');
    const dlg = dialogWith(page, 'Kích hoạt lại đối tác?');
    await dlg.getByRole('button', { name: 'Kích hoạt lại', exact: true }).click();
    await expect(page.getByText('Đã kích hoạt lại', { exact: true })).toBeVisible();
    await expect(cellOf(page, name, LIST_COL.status)).toHaveText('Hoạt động');
    const opts = await optionsApi(page, COMPANY.CTA, name);
    expect(opts.find((o) => o._id === p._id)).toBeTruthy();
    await gotoDetail(page, p._id);
    await expect(page.getByRole('button', { name: 'Thu', exact: true })).toBeEnabled();
  });
});

/* ================= 5. Xoá (chỉ khi chưa phát sinh) ================= */

test.describe('Xoá đối tác', () => {
  test('xoá đối tác chưa phát sinh: biến mất khỏi danh sách và API trả 404', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('Xoa duoc');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'supplier', name });
    await gotoList(page);
    await searchList(page, name);
    await openRowMenu(page, name);
    await clickMenuItem(page, 'Xoá');
    const dlg = dialogWith(page, 'Xoá đối tác?');
    await dlg.getByRole('button', { name: 'Xoá', exact: true }).click();
    await expect(page.getByText('Đã xoá đối tác', { exact: true })).toBeVisible();
    await expect(rowOf(page, name)).toHaveCount(0);
    const scope = await companyId(page, COMPANY.CTA);
    const r = await api(page, 'GET', `/partners/${p._id}`, { scope });
    expect(r.status).toBe(404);
  });

  test('đối tác đã phát sinh (có công nợ): không xoá được ở danh sách, chi tiết và API', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('Da phat sinh');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name });
    await createDebtApi(page, COMPANY.CTA, { partnerId: p._id, direction: 'receivable', amount: 100000, dueDate: FAR_FUTURE });
    await gotoList(page);
    await searchList(page, name);
    await openRowMenu(page, name);
    expect(await menuItemDisabled(page, 'Xoá (đã phát sinh)'), 'mục xoá bị khoá khi đã phát sinh').toBe(true);
    await page.keyboard.press('Escape');

    await gotoDetail(page, p._id);
    await page.getByRole('button', { name: 'Khác ▾' }).click();
    expect(await menuItemDisabled(page, 'Xoá (đã phát sinh — chỉ ngừng giao dịch)'), 'chi tiết: xoá bị khoá').toBe(true);
    await page.keyboard.press('Escape');

    const scope = await companyId(page, COMPANY.CTA);
    const r = await api(page, 'DELETE', `/partners/${p._id}`, { scope });
    expect(r.status, r.text).toBe(409);
    expect(JSON.stringify(r.body) + r.text).toContain('FG-PARTNER-002');
  });
});

/* ================= 6. Đổi loại đối tác ================= */

test.describe('Đổi loại đối tác', () => {
  test('chặn đổi Ngân hàng → Khách hàng khi đang có khoản nợ ngân hàng', async ({ as }) => {
    const page = await as('staff');
    const bank = await createPartnerApi(page, COMPANY.CTA, { type: 'bank', name: uniq('NH co khoan vay'), bank_name: 'MB', account_number: randomDigits() });
    await createLoanApi(page, COMPANY.CTA, { partnerId: bank._id, amount: 500000, maturityDate: FAR_FUTURE });
    await gotoDetail(page, bank._id);
    await page.getByRole('button', { name: 'Khác ▾' }).click();
    await clickMenuItem(page, 'Sửa đối tác');
    const dlg = dialogWith(page, /Sửa đối tác/);
    await pickSegment(dlg, 'Khách hàng');
    await dlg.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await expect(dlg.getByText('Không đổi được loại đối tác vì đang vướng ràng buộc')).toBeVisible();
    await expect(dlg.getByText(/khoản nợ ngân hàng/)).toBeVisible();
    const after = await getPartnerApi(page, COMPANY.CTA, bank._id);
    expect(after.type).toBe('bank');
  });

  test('chặn đổi Khách hàng → Ngân hàng khi đang có công nợ', async ({ as }) => {
    const page = await as('staff');
    const cust = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('KH co cong no') });
    await createDebtApi(page, COMPANY.CTA, { partnerId: cust._id, direction: 'receivable', amount: 200000, dueDate: FAR_FUTURE });
    await gotoDetail(page, cust._id);
    await page.getByRole('button', { name: 'Khác ▾' }).click();
    await clickMenuItem(page, 'Sửa đối tác');
    const dlg = dialogWith(page, /Sửa đối tác/);
    await pickSegment(dlg, 'Ngân hàng');
    await dlg.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await expect(dlg.getByText('Không đổi được loại đối tác vì đang vướng ràng buộc')).toBeVisible();
    const after = await getPartnerApi(page, COMPANY.CTA, cust._id);
    expect(after.type).toBe('customer');
  });

  test('cho phép đổi Khách hàng ↔ Nhà cung cấp; lịch sử ghi Loại từ → sang', async ({ as }) => {
    const page = await as('staff');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('KH doi NCC') });
    await gotoDetail(page, p._id);
    await page.getByRole('button', { name: 'Khác ▾' }).click();
    await clickMenuItem(page, 'Sửa đối tác');
    const dlg = dialogWith(page, /Sửa đối tác/);
    await pickSegment(dlg, 'Nhà cung cấp');
    await dlg.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await expect(page.getByText('Đã lưu đối tác', { exact: true })).toBeVisible();
    const after = await getPartnerApi(page, COMPANY.CTA, p._id);
    expect(after.type).toBe('supplier');
    await page.getByRole('tab', { name: 'Lịch sử' }).click();
    await expect(page.locator('tr.ant-table-row').filter({ hasText: 'Loại' }).filter({ hasText: 'Khách hàng' }).filter({ hasText: 'Nhà cung cấp' })).toHaveCount(1);
  });
});

/* ================= 7. Sao chép từ công ty khác (US-PAR-09) ================= */

test.describe('Sao chép đối tác', () => {
  test('sao chép đối tác từ CTB sang CTA: bản sao có ID/mã riêng, sửa độc lập', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('Sao chep CTB');
    const acc = randomDigits();
    const tax = randomDigits(10);
    const src = await createPartnerApi(page, COMPANY.CTB, { type: 'supplier', name, bank_name: 'ACB', account_number: acc, tax_code: tax });
    await gotoList(page);
    await page.getByRole('button', { name: 'Sao chép từ công ty khác', exact: true }).click();
    const dlg = dialogWith(page, 'Sao chép đối tác từ công ty khác');
    await dlg.locator('.ant-select').filter({ hasText: 'Chọn công ty có quyền xem' }).first().click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Cty B' }).first().click();
    await dlg.getByLabel('Tìm đối tác công ty nguồn', { exact: true }).fill(name);
    await expect(dialogRow(dlg, name)).toHaveCount(1, { timeout: 15_000 });
    await tickRow(dlg, name);
    await dlg.getByRole('button', { name: 'Sao chép 1 đối tác', exact: true }).click();
    await expect(dlg.getByText(/Đã sao chép 1 đối tác vào công ty hiện tại/)).toBeVisible({ timeout: 15_000 });
    await dlg.locator('.ant-modal-footer').getByRole('button', { name: 'Đóng', exact: true }).click();

    const copy = await findPartnerApi(page, COMPANY.CTA, name);
    expect(copy, 'bản sao có trong CTA').toBeTruthy();
    expect(copy!._id).not.toBe(src._id);
    expect(copy!.code).not.toBe(src.code);
    expect(copy!.code).toMatch(/^DT-/);
    expect(copy!.type).toBe('supplier');
    expect(copy!.bank_name).toBe('ACB');
    expect(copy!.account_number).toBe(acc);
    expect(copy!.tax_code).toBe(tax);
    const copyDetail = await getPartnerApi(page, COMPANY.CTA, copy!._id);
    expect(copyDetail.company_id, 'bản sao thuộc CTA').toBe(await companyId(page, COMPANY.CTA));
    const copyHist = (copyDetail.history ?? []).find((h: any) => h.changes?.copied_from);
    expect(copyHist?.changes?.copied_from?.to?.code, 'lịch sử ghi mã đối tác nguồn đã sao chép').toBe(src.code);

    // sửa bản sao không ảnh hưởng bản gốc
    const r = await patchPartnerApi(page, COMPANY.CTA, copy!._id, { name: `${name} (CTA)` });
    expect(r.status, r.text).toBe(200);
    const srcAfter = await getPartnerApi(page, COMPANY.CTB, src._id);
    expect(srcAfter.name).toBe(name);
  });
});

/* ================= 8. Tóm tắt & tab chi tiết (US-PAR-03) ================= */

test.describe('Tóm tắt & tab chi tiết', () => {
  test('cột tóm tắt: KH/NCC còn phải thu/trả & quá hạn; NH dư nợ & đáo hạn gần nhất', async ({ as }) => {
    const page = await as('staff');
    const k = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Tom tat KH') });
    const s = await createPartnerApi(page, COMPANY.CTA, { type: 'supplier', name: uniq('Tom tat NCC') });
    const b = await createPartnerApi(page, COMPANY.CTA, { type: 'bank', name: uniq('Tom tat NH'), bank_name: 'Agribank', account_number: randomDigits() });
    await createDebtApi(page, COMPANY.CTA, { partnerId: k._id, direction: 'receivable', amount: 750000, dueDate: LONG_PAST });
    await createDebtApi(page, COMPANY.CTA, { partnerId: s._id, direction: 'payable', amount: 120000, dueDate: FAR_FUTURE });
    await createLoanApi(page, COMPANY.CTA, { partnerId: b._id, amount: 1000000, maturityDate: FAR_FUTURE });

    await gotoList(page);
    await searchList(page, k.name);
    await expect(rowOf(page, k.name)).toBeVisible();
    expect(await rowCellDigits(page, k.name, LIST_COL.receivable), 'KH còn phải thu').toBe('750000');
    expect(await rowCellDigits(page, k.name, LIST_COL.payable), 'KH còn phải trả').toBe('0');
    expect(await rowCellDigits(page, k.name, LIST_COL.overdue), 'KH quá hạn (hạn 2020)').toBe('750000');

    await searchList(page, s.name);
    await expect(rowOf(page, s.name)).toBeVisible();
    expect(await rowCellDigits(page, s.name, LIST_COL.payable), 'NCC còn phải trả').toBe('120000');
    expect(await rowCellDigits(page, s.name, LIST_COL.receivable), 'NCC còn phải thu').toBe('0');
    expect(await rowCellDigits(page, s.name, LIST_COL.overdue), 'NCC chưa quá hạn').toBe('0');

    await searchList(page, b.name);
    await expect(rowOf(page, b.name)).toBeVisible();
    expect(await rowCellDigits(page, b.name, LIST_COL.outstanding), 'NH dư nợ').toBe('1000000');
    await expect(cellOf(page, b.name, LIST_COL.maturity), 'NH đáo hạn gần nhất').toContainText('31/12/2099');
    await expect(cellOf(page, b.name, LIST_COL.receivable)).toHaveText('—');
  });

  test('chi tiết: tab Công nợ / Nợ ngân hàng / Phiếu thu-chi / Lịch sử theo loại đối tác', async ({ as }) => {
    const page = await as('staff');
    const k = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Tab KH') });
    const debt = await createDebtApi(page, COMPANY.CTA, { partnerId: k._id, direction: 'receivable', amount: 300000, dueDate: FAR_FUTURE });
    const b = await createPartnerApi(page, COMPANY.CTA, { type: 'bank', name: uniq('Tab NH'), bank_name: 'Sacombank', account_number: randomDigits() });
    const loan = await createLoanApi(page, COMPANY.CTA, { partnerId: b._id, amount: 800000, maturityDate: FAR_FUTURE });

    await gotoDetail(page, k._id);
    await page.getByRole('tab', { name: 'Công nợ' }).click();
    await expect(page.getByText(debt.code)).toBeVisible();
    await expect(page.getByText('Phải thu', { exact: true }).first()).toBeVisible();
    await page.getByRole('tab', { name: 'Nợ ngân hàng' }).click();
    await expect(page.getByText('Nợ ngân hàng chỉ gắn với đối tác loại Ngân hàng')).toBeVisible();
    await page.getByRole('tab', { name: 'Phiếu thu/chi' }).click();
    await expect(page.getByText('Chưa có phiếu thu/chi')).toBeVisible();
    await page.getByRole('tab', { name: 'Lịch sử' }).click();
    await expect(page.locator('tr.ant-table-row').filter({ hasText: k.name }).first()).toBeVisible();

    await gotoDetail(page, b._id);
    await page.getByRole('tab', { name: 'Nợ ngân hàng' }).click();
    await expect(page.getByText(loan.code)).toBeVisible();
    await page.getByRole('tab', { name: 'Công nợ' }).click();
    await expect(page.getByText('Công nợ phải thu / phải trả chỉ dùng cho khách hàng và nhà cung cấp')).toBeVisible();
  });
});

/* ================= 9. Nút Thu / Chi / Ghi nợ (US-PAR-02, US-PAR-05) ================= */

test.describe('Nút thao tác theo loại đối tác', () => {
  test('Thu / Chi từ hồ sơ Khách hàng mở form với đối tác điền sẵn', async ({ as }) => {
    const page = await as('staff');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Thu chi KH') });
    await gotoDetail(page, p._id);
    await page.getByRole('button', { name: 'Thu', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/thu/moi\\?.*partner_id=${p._id}.*kind=income`));
    await expect(selectedPartnerItem(page, p.name)).toBeVisible({ timeout: 15_000 });

    await gotoDetail(page, p._id);
    await page.getByRole('button', { name: 'Chi', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/chi/moi\\?.*partner_id=${p._id}.*kind=spend`));
    await expect(selectedPartnerItem(page, p.name)).toBeVisible({ timeout: 15_000 });

    await gotoList(page);
    await searchList(page, p.name);
    await openRowMenu(page, p.name);
    await clickMenuItem(page, 'Thu');
    await expect(page).toHaveURL(/\/thu\/moi/);
    await expect(selectedPartnerItem(page, p.name)).toBeVisible({ timeout: 15_000 });
  });

  test('Thu của Ngân hàng bật "đi vay" và điền sẵn ngân hàng; Ghi nợ mở form khoản vay điền sẵn', async ({ as }) => {
    const page = await as('staff');
    const b = await createPartnerApi(page, COMPANY.CTA, { type: 'bank', name: uniq('NH thu vay'), bank_name: 'VPBank', account_number: randomDigits() });
    await gotoDetail(page, b._id);
    await page.getByRole('button', { name: 'Thu', exact: true }).click();
    await expect(page).toHaveURL(/loan=borrow/);
    await expect(selectedPartnerItem(page, b.name)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Đây là khoản vay ngân hàng (đi vay)')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: /Đây là khoản vay ngân hàng/ })).toBeChecked();

    await gotoDetail(page, b._id);
    await page.getByRole('button', { name: 'Ghi nợ', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/ngan-hang/khoan-vay/moi\\?partner_id=${b._id}`));
    await expect(selectedPartnerItem(page, b.name)).toBeVisible({ timeout: 15_000 });
  });

  test('Ghi nợ Khách hàng: chọn hướng Phải trả rồi mở form công nợ điền sẵn đối tác và hướng', async ({ as }) => {
    const page = await as('staff');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Ghi no KH') });
    await gotoDetail(page, p._id);
    await page.getByRole('button', { name: 'Ghi nợ', exact: true }).click();
    const dlg = dialogWith(page, 'Ghi nợ — chọn hướng khoản công nợ');
    await dlg.locator('.ant-segmented-item', { hasText: 'Phải trả' }).click();
    await dlg.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/cong-no/moi\\?.*partner_id=${p._id}.*direction=payable`));
    await expect(selectedPartnerItem(page, p.name)).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ant-segmented-item-selected', { hasText: 'Phải trả' })).toBeVisible();
  });
});

/* ================= 10. Trả nợ (US-PAR-04, mục 11 — liên kết) ================= */

test.describe('Trả nợ', () => {
  test('Trả nợ Khách hàng: phiếu thu nháp đã gắn liên kết cấn trừ (offset), còn có thể trả giảm', async ({ as }) => {
    const page = await as('staff');
    const k = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Tra no KH') });
    const debt = await createDebtApi(page, COMPANY.CTA, { partnerId: k._id, direction: 'receivable', amount: 500000, dueDate: FAR_FUTURE });
    const dlg = await openSettle(page, k._id);
    await tickRow(dlg, debt.code);
    await dlg.locator(`input[aria-label="Số tiền ${debt.code}"]`).fill('200000');
    await expect(dlg.getByText(/Phiếu thu nháp:.*200\.000/)).toBeVisible();
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();
    await expect(page.getByText(/Đã tạo phiếu nháp/)).toBeVisible();
    const docId = await docIdFromUrl(page);
    expect(page.url()).toContain('/ho-so/thu/');

    const doc = await getDocumentApi(page, COMPANY.CTA, docId);
    expect(doc.kind ?? doc.type, 'phiếu nháp là phiếu thu').toBe('income');
    const links: any[] = doc.links ?? [];
    const link = links.find((l) => l.relation === 'offset' && (l.counterpart?.id === debt._id || l.to_id === debt._id));
    expect(link, `phiếu ${docId} có liên kết offset tới khoản ${debt.code}; links=${JSON.stringify(links).slice(0, 400)}`).toBeTruthy();
    expect(String(link.amount_minor)).toBe('200000');

    const d = await getDebtApi(page, COMPANY.CTA, debt._id);
    expect(JSON.stringify(d.offset_links ?? []), 'khoản công nợ liệt kê liên kết tới phiếu nháp').toContain(docId);
    const row = await partnerTabRow(page, COMPANY.CTA, k._id, 'debts', debt._id);
    expect(moneyWire(row?.available), 'còn có thể trả sau khi giữ chỗ phiếu nháp 200.000').toBe('300000');
  });

  test('Trả nợ Nhà cung cấp (phải trả): tạo phiếu chi nháp đã gắn liên kết', async ({ as }) => {
    const page = await as('staff');
    const s = await createPartnerApi(page, COMPANY.CTA, { type: 'supplier', name: uniq('Tra no NCC') });
    const debt = await createDebtApi(page, COMPANY.CTA, { partnerId: s._id, direction: 'payable', amount: 300000, dueDate: FAR_FUTURE });
    const dlg = await openSettle(page, s._id);
    await dialogRow(dlg, debt.code).getByText('Phải trả → phiếu chi').first().waitFor();
    await tickRow(dlg, debt.code);
    await dlg.locator(`input[aria-label="Số tiền ${debt.code}"]`).fill('100000');
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();
    const docId = await docIdFromUrl(page);
    expect(page.url()).toContain('/ho-so/chi/');
    const doc = await getDocumentApi(page, COMPANY.CTA, docId);
    const links: any[] = doc.links ?? [];
    const link = links.find((l) => l.relation === 'offset' && (l.counterpart?.id === debt._id || l.to_id === debt._id));
    expect(link, `phiếu chi ${docId} có liên kết offset tới ${debt.code}`).toBeTruthy();
    expect(String(link.amount_minor)).toBe('100000');
  });

  test('Trả nợ Ngân hàng: gốc / lãi / phí tách riêng, phiếu chi nháp có liên kết trả nợ vay', async ({ as }) => {
    const page = await as('staff');
    const b = await createPartnerApi(page, COMPANY.CTA, { type: 'bank', name: uniq('Tra no NH'), bank_name: 'HDBank', account_number: randomDigits() });
    const loan = await createLoanApi(page, COMPANY.CTA, { partnerId: b._id, amount: 1000000, maturityDate: FAR_FUTURE });
    const dlg = await openSettle(page, b._id);
    await tickRow(dlg, loan.code);
    await dlg.locator(`input[aria-label="Số tiền ${loan.code}"]`).fill('300000');
    await dlg.locator(`input[aria-label="Lãi ${loan.code}"]`).fill('10000');
    await dlg.locator(`input[aria-label="Phí ${loan.code}"]`).fill('5000');
    await expect(dlg.getByText(/Phiếu chi nháp:.*315\.000/)).toBeVisible();
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();
    const docId = await docIdFromUrl(page);
    expect(page.url()).toContain('/ho-so/chi/');
    const doc = await getDocumentApi(page, COMPANY.CTA, docId);
    const link = (doc.links ?? []).find((l: any) => l.relation === 'repayment');
    expect(link, `phiếu chi ${docId} có liên kết repayment`).toBeTruthy();
    expect(link.split?.principal).toBe('300000');
    expect(link.split?.interest).toBe('10000');
    expect(link.split?.fee).toBe('5000');
    // phiếu nháp chưa thực thi: dư nợ chưa đổi; gốc còn có thể trả giảm đúng phần gốc đã giữ chỗ (300.000)
    const row = await partnerTabRow(page, COMPANY.CTA, b._id, 'loans', loan._id);
    expect(moneyWire(row?.outstanding), 'dư nợ chưa đổi khi phiếu chưa thực thi').toBe('1000000');
    expect(moneyWire(row?.available_principal), 'gốc còn có thể trả giảm 300.000').toBe('700000');
  });

  test('Trả nợ: chặn khi chưa nhập số tiền và khi vượt số còn có thể trả', async ({ as }) => {
    const page = await as('staff');
    const k = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Tra no loi') });
    const debt = await createDebtApi(page, COMPANY.CTA, { partnerId: k._id, direction: 'receivable', amount: 100000, dueDate: FAR_FUTURE });
    const dlg = await openSettle(page, k._id);
    await expect(dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true })).toBeDisabled();
    await tickRow(dlg, debt.code);
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();
    await expect(dlg.getByText('Nhập số tiền phân bổ')).toBeVisible();
    await dlg.locator(`input[aria-label="Số tiền ${debt.code}"]`).fill('999999');
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();
    await expect(dlg.getByText(/Vượt số còn có thể trả/)).toBeVisible();
    await expect(page).toHaveURL(/\/doi-tac\//);
  });
});

/* ================= 11. Phân quyền ================= */

test.describe('Phân quyền màn Đối tác', () => {
  test('Giám đốc (chỉ xem đối tác): không có nút tạo / sao chép / sửa / xoá / trả nợ / khác', async ({ as }) => {
    const staff = await as('staff');
    const p = await createPartnerApi(staff, COMPANY.CTA, { type: 'customer', name: uniq('Chi xem') });
    await createDebtApi(staff, COMPANY.CTA, { partnerId: p._id, direction: 'receivable', amount: 90000, dueDate: FAR_FUTURE });

    const page = await as('director');
    await gotoList(page);
    await expect(page.getByRole('button', { name: '+ Tạo đối tác', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sao chép từ công ty khác' })).toHaveCount(0);
    await searchList(page, p.name);
    await expect(rowOf(page, p.name)).toBeVisible();
    await openRowMenu(page, p.name);
    await expect(page.getByRole('menuitem', { name: 'Sửa', exact: true })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Xoá', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await gotoDetail(page, p._id);
    await expect(page.getByRole('button', { name: 'Trả nợ', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ghi nợ', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Khác ▾' })).toHaveCount(0);
  });
});

/* ================= 12. Tạo đối tác ngay trên form (US-PAR-02) ================= */

test.describe('Ô chọn đối tác trên form', () => {
  test('"+ Tạo đối tác" trên form phiếu mở popup có sẵn tên, lưu xong đối tác được chọn sẵn', async ({ as }) => {
    const page = await as('staff');
    await page.goto('/thu/moi?kind=income');
    const name = uniq('Tao tu phieu');
    const dd = await searchPicker(page, name);
    await dd.getByRole('button', { name: `+ Tạo đối tác "${name}"` }).click();
    const dlg = dialogWith(page, 'Tạo đối tác');
    await expect(dlg.getByPlaceholder('VD: Công ty TNHH ABC')).toHaveValue(name);
    await dlg.getByRole('button', { name: 'Tạo đối tác', exact: true }).click();
    await expect(selectedPartnerItem(page, name)).toBeVisible({ timeout: 15_000 });
    const p = await findPartnerApi(page, COMPANY.CTA, name);
    expect(p, 'đối tác tạo từ popup có trong API').toBeTruthy();
  });
});

/* ================= kiểm tra lại dữ liệu trả nợ hiển thị trên tab ================= */

test.describe('Dữ liệu sau trả nợ', () => {
  test('tab Phiếu thu/chi hiện phiếu nháp vừa tạo khi trả nợ', async ({ as }) => {
    const page = await as('staff');
    const k = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Tab phieu') });
    const debt = await createDebtApi(page, COMPANY.CTA, { partnerId: k._id, direction: 'receivable', amount: 150000, dueDate: FAR_FUTURE });
    const dlg = await openSettle(page, k._id);
    await tickRow(dlg, debt.code);
    await dlg.locator(`input[aria-label="Số tiền ${debt.code}"]`).fill('150000');
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();
    const docId = await docIdFromUrl(page);
    const doc = await getDocumentApi(page, COMPANY.CTA, docId);
    await gotoDetail(page, k._id);
    await page.getByRole('tab', { name: 'Phiếu thu/chi' }).click();
    await expect(page.getByRole('link', { name: doc.code ?? '' })).toBeVisible();
  });
});

/* ================= 13. Bổ sung: sửa mọi trường, phiếu liên quan, đáo hạn, trùng khi sao chép ================= */

test.describe('Bổ sung', () => {
  test('sửa mọi trường (STK, MST, ghi chú, trạng thái): lịch sử ghi đủ từ → sang', async ({ as }) => {
    const page = await as('staff');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Sua moi truong'), bank_name: 'ACB', account_number: randomDigits(), tax_code: randomDigits(10) });
    const acc2 = randomDigits(11);
    const tax2 = randomDigits(10);
    const note2 = 'ghi chú sửa kiểm thử';
    await gotoDetail(page, p._id);
    await page.getByRole('button', { name: 'Khác ▾' }).click();
    await clickMenuItem(page, 'Sửa đối tác');
    const dlg = dialogWith(page, /Sửa đối tác/);
    await dlg.getByPlaceholder('VD: 0123456789').fill(acc2);
    await dlg.getByPlaceholder('VD: 0101234567').fill(tax2);
    await dlg.locator('textarea').fill(note2);
    await pickSegment(dlg, 'Ngừng giao dịch');
    await dlg.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await expect(page.getByText('Đã lưu đối tác', { exact: true })).toBeVisible();
    await expect(page.getByText('Đối tác đang ngừng giao dịch')).toBeVisible();

    await page.getByRole('tab', { name: 'Lịch sử' }).click();
    await expect(page.locator('tr.ant-table-row').filter({ hasText: 'Số tài khoản' }).filter({ hasText: acc2 }), 'lịch sử: STK').toHaveCount(1);
    await expect(page.locator('tr.ant-table-row').filter({ hasText: 'Mã số thuế' }).filter({ hasText: tax2 }), 'lịch sử: MST').toHaveCount(1);
    await expect(page.locator('tr.ant-table-row').filter({ hasText: 'Ghi chú' }).filter({ hasText: note2 }), 'lịch sử: ghi chú').toHaveCount(1);
    await expect(page.locator('tr.ant-table-row').filter({ hasText: 'Trạng thái' }).filter({ hasText: 'Hoạt động' }).filter({ hasText: 'Ngừng giao dịch' }), 'lịch sử: trạng thái').toHaveCount(1);
    const detail = await getPartnerApi(page, COMPANY.CTA, p._id);
    expect(Object.keys((detail.history ?? [])[0]?.changes ?? {}).sort(), 'trường thay đổi trong bản ghi lịch sử').toEqual(['account_number', 'note', 'status', 'tax_code'].sort());
  });

  test('sửa đối tác: phiếu nháp đã trả nợ hiển thị tên mới (không lưu bản sao thông tin đối tác)', async ({ as }) => {
    const page = await as('staff');
    const k = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Ten ban dau') });
    const debt = await createDebtApi(page, COMPANY.CTA, { partnerId: k._id, direction: 'receivable', amount: 100000, dueDate: FAR_FUTURE });
    const dlg = await openSettle(page, k._id);
    await tickRow(dlg, debt.code);
    await dlg.locator(`input[aria-label="Số tiền ${debt.code}"]`).fill('50000');
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();
    const docId = await docIdFromUrl(page);

    const newName = uniq('Ten moi');
    const r = await patchPartnerApi(page, COMPANY.CTA, k._id, { name: newName });
    expect(r.status, r.text).toBe(200);
    const doc = await getDocumentApi(page, COMPANY.CTA, docId);
    expect(doc.partner?.name ?? doc.payee?.name, 'phiếu hiển thị tên đối tác hiện tại').toBe(newName);
    await page.goto(`/ho-so/thu/${docId}`);
    await expect(page.getByText(newName).first()).toBeVisible({ timeout: 20_000 });
  });

  test('đáo hạn gần nhất của Ngân hàng là hạn sớm nhất trong các khoản còn dư nợ', async ({ as }) => {
    const page = await as('staff');
    const b = await createPartnerApi(page, COMPANY.CTA, { type: 'bank', name: uniq('Dao han NH'), bank_name: 'OCB', account_number: randomDigits() });
    await createLoanApi(page, COMPANY.CTA, { partnerId: b._id, amount: 400000, maturityDate: FAR_FUTURE });
    await createLoanApi(page, COMPANY.CTA, { partnerId: b._id, amount: 600000, maturityDate: '2099-06-30' });
    await gotoList(page);
    await searchList(page, b.name);
    await expect(rowOf(page, b.name)).toBeVisible();
    expect(await rowCellDigits(page, b.name, LIST_COL.outstanding), 'dư nợ = tổng các khoản').toBe('1000000');
    await expect(cellOf(page, b.name, LIST_COL.maturity), 'đáo hạn gần nhất').toContainText('30/06/2099');
    await gotoDetail(page, b._id);
    await expect(page.locator('.ant-card, .fg-card', { hasText: 'Đáo hạn gần nhất' }).first()).toContainText('30/06/2099');
  });

  test('sao chép: vẫn cảnh báo trùng tên với đối tác đã có trong công ty đích (không chặn)', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('Sao chep trung');
    await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name });
    await createPartnerApi(page, COMPANY.CTB, { type: 'customer', name });
    await gotoList(page);
    await page.getByRole('button', { name: 'Sao chép từ công ty khác', exact: true }).click();
    const dlg = dialogWith(page, 'Sao chép đối tác từ công ty khác');
    await dlg.locator('.ant-select').filter({ hasText: 'Chọn công ty có quyền xem' }).first().click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Cty B' }).first().click();
    await dlg.getByLabel('Tìm đối tác công ty nguồn', { exact: true }).fill(name);
    await expect(dialogRow(dlg, name)).toHaveCount(1, { timeout: 15_000 });
    await tickRow(dlg, name);
    await dlg.getByRole('button', { name: 'Sao chép 1 đối tác', exact: true }).click();
    await expect(dlg.getByText(/Đã sao chép 1 đối tác vào công ty hiện tại/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Cảnh báo trùng đối tác — đối tác vẫn đã được lưu')).toBeVisible();
    await dlg.locator('.ant-modal-footer').getByRole('button', { name: 'Đóng', exact: true }).click();
    await searchList(page, name);
    await expect(rowOf(page, name), 'CTA có hai đối tác cùng tên (bản sao độc lập)').toHaveCount(2);
  });
});

/* ================= 14. Bổ sung 2: hai hướng, loại trong ô chọn, phạm vi công ty, trạng thái, xoá, kiểm tra dữ liệu ================= */

test.describe('Bổ sung 2', () => {
  test('trả nợ cả hai hướng: tạo đồng thời phiếu thu (phải thu) và phiếu chi (phải trả), đều đã cấn trừ', async ({ as }) => {
    const page = await as('staff');
    const k = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Hai huong') });
    const ar = await createDebtApi(page, COMPANY.CTA, { partnerId: k._id, direction: 'receivable', amount: 300000, dueDate: FAR_FUTURE });
    const ap = await createDebtApi(page, COMPANY.CTA, { partnerId: k._id, direction: 'payable', amount: 200000, dueDate: FAR_FUTURE });
    const dlg = await openSettle(page, k._id);
    await tickRow(dlg, ar.code);
    await dlg.locator(`input[aria-label="Số tiền ${ar.code}"]`).fill('100000');
    await tickRow(dlg, ap.code);
    await dlg.locator(`input[aria-label="Số tiền ${ap.code}"]`).fill('50000');
    await expect(dlg.getByText(/Phiếu thu nháp:.*100\.000/)).toBeVisible();
    await expect(dlg.getByText(/Phiếu chi nháp:.*50\.000/)).toBeVisible();
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();
    await expect(page.getByText(/Đã tạo 2 phiếu nháp/)).toBeVisible({ timeout: 20_000 });
    await docIdFromUrl(page);

    const scope = await companyId(page, COMPANY.CTA);
    const r = await api(page, 'GET', `/partners/${k._id}/documents`, { scope });
    expect(r.status, r.text).toBe(200);
    const drafts: any[] = r.body?.items ?? [];
    expect(drafts.map((d) => d.kind).sort(), 'một phiếu thu và một phiếu chi').toEqual(['income', 'spend']);
    for (const d of drafts) {
      const doc = await getDocumentApi(page, COMPANY.CTA, d._id);
      const offset = (doc.links ?? []).find((l: any) => l.relation === 'offset');
      expect(offset, `phiếu ${d.code} (${d.kind}) có liên kết cấn trừ`).toBeTruthy();
    }
  });

  test('ô chọn đối tác theo loại hợp lệ: form công nợ chỉ có KH/NCC, form khoản vay chỉ có Ngân hàng', async ({ as }) => {
    const page = await as('staff');
    const tag = uniq('loc picker');
    const bank = await createPartnerApi(page, COMPANY.CTA, { type: 'bank', name: `${tag} NH`, bank_name: 'SHB', account_number: randomDigits() });
    const cust = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: `${tag} KH` });
    await page.goto('/cong-no/moi?direction=receivable');
    let dd = await searchPicker(page, tag);
    await expect(dd.getByText(cust.name, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(dd.getByText(bank.name, { exact: true })).toHaveCount(0);

    await page.goto('/ngan-hang/khoan-vay/moi');
    dd = await searchPicker(page, tag);
    await expect(dd.getByText(bank.name, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(dd.getByText(cust.name, { exact: true })).toHaveCount(0);
  });

  test('danh bạ theo công ty: đối tác của CTB không hiện ở CTA; đổi phạm vi sang CTB thì hiện', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('Rieng CTB');
    await createPartnerApi(page, COMPANY.CTB, { type: 'customer', name });
    await gotoList(page);
    await searchList(page, name);
    await expect(page.getByText('Không có đối tác với bộ lọc này')).toBeVisible();
    await page.getByRole('button', { name: 'Phạm vi dữ liệu' }).click();
    await page.getByRole('menuitem', { name: /^CTB · / }).click();
    await expect(rowOf(page, name)).toBeVisible({ timeout: 15_000 });
    await pinScope(page, COMPANY.CTA); // trả lại phạm vi mặc định cho các bài sau
  });

  test('đối tác ngừng giao dịch: menu Thu / Chi / Ghi nợ / Trả nợ bị khoá kèm lý do', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('Menu ngung');
    const p = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name });
    await setStatusApi(page, COMPANY.CTA, p._id, 'inactive');
    await gotoList(page);
    await searchList(page, name);
    await openRowMenu(page, name);
    for (const label of ['Thu (đang ngừng giao dịch)', 'Chi (đang ngừng giao dịch)', 'Ghi nợ (đang ngừng giao dịch)', 'Trả nợ (đang ngừng giao dịch)']) {
      await expect(page.getByRole('menuitem', { name: label, exact: true }), `mục "${label}"`).toHaveCount(1);
      expect(await menuItemDisabled(page, label), `mục "${label}" bị khoá`).toBe(true);
    }
  });

  test('Ngân hàng đang có khoản vay: không xoá được (danh sách khoá mục xoá, API 409)', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('NH co vay');
    const b = await createPartnerApi(page, COMPANY.CTA, { type: 'bank', name, bank_name: 'Eximbank', account_number: randomDigits() });
    await createLoanApi(page, COMPANY.CTA, { partnerId: b._id, amount: 250000, maturityDate: FAR_FUTURE });
    await gotoList(page);
    await searchList(page, name);
    await openRowMenu(page, name);
    expect(await menuItemDisabled(page, 'Xoá (đã phát sinh)'), 'mục xoá khoá khi có khoản vay').toBe(true);
    await page.keyboard.press('Escape');
    const scope = await companyId(page, COMPANY.CTA);
    const r = await api(page, 'DELETE', `/partners/${b._id}`, { scope });
    expect(r.status, r.text).toBe(409);
    expect(r.text).toContain('FG-PARTNER-002');
  });

  test('KH/NCC có số tài khoản nhưng thiếu ngân hàng: không lưu, báo lỗi trên form', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('STK khong NH');
    await gotoList(page);
    await page.getByRole('button', { name: '+ Tạo đối tác', exact: true }).click();
    const dlg = dialogWith(page, 'Tên đối tác');
    await fillPartnerForm(dlg, { type: 'customer', name, account: randomDigits() });
    await dlg.getByRole('button', { name: 'Tạo đối tác', exact: true }).click();
    await expect(dlg.getByRole('alert').first()).toBeVisible({ timeout: 15_000 });
    await expect(dlg).toBeVisible();
    expect(await findPartnerApi(page, COMPANY.CTA, name), 'không tạo đối tác khi thiếu ngân hàng').toBeNull();
  });

  test('sửa đối tác: cảnh báo trùng không tự báo chính nó, và so khớp tên không phân biệt hoa thường / khoảng trắng', async ({ as }) => {
    const page = await as('staff');
    const base = uniq('Chuan hoa');
    const a = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: base });
    const b = await createPartnerApi(page, COMPANY.CTA, { type: 'supplier', name: `  ${base.toUpperCase().replace(/ /g, '   ')}  ` });
    await gotoDetail(page, a._id);
    await page.getByRole('button', { name: 'Khác ▾' }).click();
    await clickMenuItem(page, 'Sửa đối tác');
    const dlg = dialogWith(page, /Sửa đối tác/);
    await expect(dlg.getByText('Có thể trùng với đối tác đã có — vẫn lưu được')).toBeVisible({ timeout: 15_000 });
    await expect(dlg.getByText(b.code)).toBeVisible();
    await expect(dlg.getByText(a.code), 'không tự báo trùng chính đối tác đang sửa').toHaveCount(0);
    await dlg.getByRole('button', { name: 'Hủy', exact: true }).click();
  });

  test('sao chép: đối tác ngừng giao dịch của công ty nguồn không được đưa vào danh sách chọn', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('Ngung nguon');
    const src = await createPartnerApi(page, COMPANY.CTB, { type: 'customer', name });
    await setStatusApi(page, COMPANY.CTB, src._id, 'inactive');
    await gotoList(page);
    await page.getByRole('button', { name: 'Sao chép từ công ty khác', exact: true }).click();
    const dlg = dialogWith(page, 'Sao chép đối tác từ công ty khác');
    await dlg.locator('.ant-select').filter({ hasText: 'Chọn công ty có quyền xem' }).first().click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: 'Cty B' }).first().click();
    await dlg.getByLabel('Tìm đối tác công ty nguồn', { exact: true }).fill(name);
    await expect(dlg.getByText('Không có đối tác phù hợp với từ khoá')).toBeVisible({ timeout: 15_000 });
    await expect(dialogRow(dlg, name)).toHaveCount(0);
  });
});

test.describe('Phạm vi toàn tập đoàn', () => {
  test('Chủ tịch (Toàn tập đoàn): danh bạ gộp nhiều công ty, có cột Công ty, chỉ xem', async ({ as }) => {
    const staff = await as('staff');
    const tag = uniq('Toan doan');
    const a = await createPartnerApi(staff, COMPANY.CTA, { type: 'customer', name: `${tag} A` });
    const b = await createPartnerApi(staff, COMPANY.CTB, { type: 'supplier', name: `${tag} B` });
    const page = await as('chairman');
    const chairScope = await api(page, 'GET', '/me');
    const prevDefault: string = (chairScope.body?.data ?? chairScope.body)?.prefs?.default_scope;
    const set = await api(page, 'PATCH', '/me/prefs', { data: { default_scope: 'all' } });
    expect(set.status, set.text).toBe(200);
    try {
      await gotoList(page);
      await searchList(page, tag);
      await expect(page.locator('thead').getByText('Công ty', { exact: true }).first(), 'cột Công ty ở phạm vi toàn tập đoàn').toBeVisible();
      await expect(rowOf(page, a.name)).toContainText('Cty A');
      await expect(rowOf(page, b.name)).toContainText('Cty B');
      await expect(page.getByRole('button', { name: '+ Tạo đối tác', exact: true })).toHaveCount(0);
      await openRowMenu(page, a.name);
      await expect(page.getByRole('menuitem', { name: 'Xem chi tiết', exact: true })).toHaveCount(1);
      await expect(page.getByRole('menuitem', { name: 'Sửa', exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
      // hồ sơ đối tác của công ty khác: báo "thuộc công ty khác" và không có nút thao tác
      await gotoDetail(page, b._id);
      await expect(page.getByText('Đối tác thuộc công ty khác')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Thu', exact: true })).toHaveCount(0);
    } finally {
      await api(page, 'PATCH', '/me/prefs', { data: { default_scope: prevDefault ?? COMPANY.CTA } });
    }
  });
});

test.describe('Tổng đã thực thi trong kỳ', () => {
  test('Tổng thu / Tổng chi đã thực thi trong kỳ khớp tổng các phiếu đã thực thi của đối tác (API và màn danh sách)', async ({ as }) => {
    const page = await as('staff');
    const scope = await companyId(page, COMPANY.CTA);
    // kỳ mặc định của màn danh sách = tháng hiện tại theo giờ Việt Nam (UTC+7)
    const periodKey = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 7);
    const listed = await api(page, 'GET', '/documents?status=paid&limit=200', { scope });
    expect(listed.status, listed.text).toBe(200);
    const paidDocs: any[] = listed.body?.items ?? [];

    // cộng theo đối tác, chỉ các phiếu đã thực thi có ngày nghiệp vụ trong kỳ và không trả góp
    const sums = new Map<string, { income: number; spend: number }>();
    for (const d of paidDocs) {
      if (!d.partner_id || !d.amount?.minor) continue;
      const det = await api(page, 'GET', `/documents/${d._id}`, { scope });
      const doc = det.body?.data ?? det.body;
      const bd = String(doc?.business_date ?? '');
      if (!bd.startsWith(periodKey) || (doc?.execution?.installments ?? []).length) continue;
      const cur = sums.get(String(d.partner_id)) ?? { income: 0, spend: 0 };
      if (d.kind === 'income') cur.income += Number(d.amount.minor);
      else if (d.kind === 'spend') cur.spend += Number(d.amount.minor);
      sums.set(String(d.partner_id), cur);
    }

    // chọn đối tác có tên duy nhất trong công ty để tìm đúng hàng
    let picked: { id: string; name: string; income: number; spend: number } | null = null;
    for (const [pid, s] of sums) {
      if (!s.income && !s.spend) continue;
      const det = await api(page, 'GET', `/partners/${pid}`, { scope });
      const name: string = (det.body?.data ?? det.body)?.name;
      const found = await findPartnerApi(page, COMPANY.CTA, name);
      if (found && found._id === pid) {
        picked = { id: pid, name, income: s.income, spend: s.spend };
        break;
      }
    }
    test.skip(!picked, `không có đối tác nào có phiếu đã thực thi trong ${periodKey} để đối chiếu`);
    if (!picked) return;

    // API tóm tắt (cùng kỳ mặc định)
    const summary = await findPartnerApi(page, COMPANY.CTA, picked.name);
    const apiRow: any = await api(page, 'GET', `/partners?q=${encodeURIComponent(picked.name)}&status=all&limit=5`, { scope });
    const item = (apiRow.body?.items ?? []).find((x: any) => x._id === picked!.id);
    expect(String(item?.paid_in_period?.minor), `API tổng thu kỳ ${periodKey} = tổng phiếu thu đã thực thi`).toBe(String(picked.income));
    expect(String(item?.paid_out_period?.minor), `API tổng chi kỳ ${periodKey} = tổng phiếu chi đã thực thi`).toBe(String(picked.spend));
    expect(summary).toBeTruthy();

    // màn danh sách hiển thị đúng hai cột
    await gotoList(page);
    await searchList(page, picked.name);
    await expect(rowOf(page, picked.name)).toBeVisible();
    expect(await rowCellDigits(page, picked.name, LIST_COL.paidIn), 'cột Tổng thu').toBe(String(picked.income));
    expect(await rowCellDigits(page, picked.name, LIST_COL.paidOut), 'cột Tổng chi').toBe(String(picked.spend));
  });
});

test.describe('Phân trang & trạng thái trống', () => {
  test('phân trang: 51 đối tác cùng nhóm → trang 1 có 50 dòng, trang 2 còn 1 dòng', async ({ as }) => {
    const page = await as('staff');
    const tag = uniq('Phan trang');
    for (let i = 0; i < 51; i++) {
      await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: `${tag} ${String(i).padStart(2, '0')}` });
    }
    await gotoList(page);
    await searchList(page, tag);
    await expect(page.getByText('51 đối tác', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('tr.ant-table-row')).toHaveCount(50);
    await page.locator('.ant-pagination-item-2').click();
    await expect(page.locator('tr.ant-table-row')).toHaveCount(1, { timeout: 15_000 });
    await expect(rowOf(page, `${tag} 50`)).toBeVisible();
  });

  test('trả nợ khi không còn khoản nào: báo trống và không cho tạo phiếu nháp', async ({ as }) => {
    const page = await as('staff');
    const k = await createPartnerApi(page, COMPANY.CTA, { type: 'customer', name: uniq('Khong con no') });
    const dlg = await openSettle(page, k._id);
    await expect(dlg.getByText('Không còn khoản nào cần trả')).toBeVisible({ timeout: 15_000 });
    await expect(dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true })).toBeDisabled();
  });
});

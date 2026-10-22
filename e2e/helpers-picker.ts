/**
 * Tiện ích dùng chung cho spec "partner picker" (v2/v2.md §5.1, §5.2, US-PAR-02).
 *
 * Chỉ thêm mới — không sửa fixtures.ts / playwright.config.ts.
 * Ô chọn đối tác: antd 6 (`.ant-select`, `input[role=combobox]`); nhãn FgField KHÔNG gắn htmlFor nên
 * định vị ô qua khối cha của `<label>`.
 */
import { expect, type Locator, type Page } from '@playwright/test';

/* ============================== dữ liệu cố định ============================== */

/** Công ty CTA (KTV `staff` mặc định đang ở công ty này). */
export const CTA = '6aace643253531e3b1e1be55';
/** Công ty CTB — dùng kiểm tra danh bạ riêng từng công ty. */
export const CTB = '6aae2a00cb58746ba01f0352';

export type PartnerType = 'bank' | 'customer' | 'supplier';
export const TYPE_LABEL: Record<PartnerType, string> = {
  bank: 'Ngân hàng',
  customer: 'Khách hàng',
  supplier: 'Nhà cung cấp',
};

export interface PartnerRow {
  _id: string;
  code: string;
  type: PartnerType;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  tax_code: string | null;
  status: 'active' | 'inactive';
}

export interface PartnerInput {
  type: PartnerType;
  name: string;
  bank_name?: string | null;
  account_number?: string | null;
  tax_code?: string | null;
  note?: string | null;
}

/** Đường dẫn các màn có ô chọn đối tác. */
export const ROUTES = {
  payment: '/chi/moi',
  receipt: '/thu/moi',
  debt: '/cong-no/moi',
  bankDebt: '/ngan-hang/khoan-vay/moi',
  recurring: '/quantri/dinh-ky',
} as const;

/* ============================== chuỗi / số duy nhất ============================== */

/** Chuỗi chữ số duy nhất (STK / MST) — tách khỏi uniq() vì cần chữ số thuần. */
export function uniqDigits(len: number): string {
  const seed = `${Date.now()}${Math.floor(Math.random() * 1e6)}`.replace(/\D/g, '');
  return seed.slice(-len).padStart(len, '1');
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ============================== API (setup / kiểm chứng) ============================== */

const scopeHeader = (companyId: string) => ({ 'x-company-scope': companyId });

/** POST /partners — tạo đối tác qua API (setup dữ liệu). Trả về bản ghi đối tác. */
export async function apiCreatePartner(page: Page, body: PartnerInput, companyId: string = CTA): Promise<PartnerRow> {
  const res = await page.request.post('/api/v1/partners', {
    data: { company_id: companyId, ...body },
    headers: scopeHeader(companyId),
  });
  const text = await res.text();
  expect(res.status(), `POST /partners ${JSON.stringify(body)} → ${text}`).toBe(201);
  return (JSON.parse(text) as { data: { partner: PartnerRow } }).data.partner;
}

/** GET /partners/:id — chi tiết kèm lịch sử. */
export async function apiGetPartner(page: Page, id: string, companyId: string = CTA): Promise<PartnerRow & { history: { changes: Record<string, unknown> }[] }> {
  const res = await page.request.get(`/api/v1/partners/${id}`, { headers: scopeHeader(companyId) });
  const text = await res.text();
  expect(res.status(), `GET /partners/${id} → ${text}`).toBe(200);
  return (JSON.parse(text) as { data: PartnerRow & { history: { changes: Record<string, unknown> }[] } }).data;
}

/** POST /partners/:id/deactivate — ngừng giao dịch (không xoá). */
export async function apiDeactivatePartner(page: Page, id: string, companyId: string = CTA): Promise<void> {
  const res = await page.request.post(`/api/v1/partners/${id}/deactivate`, { headers: scopeHeader(companyId) });
  expect(res.status(), `deactivate ${id} → ${await res.text()}`).toBe(200);
}

/** GET /partners/options — đúng API mà ô chọn gọi (mặc định chỉ đối tác đang hoạt động). */
export async function apiOptions(page: Page, q: string, companyId: string = CTA, type?: PartnerType[]): Promise<PartnerRow[]> {
  const params = new URLSearchParams({ company_id: companyId, q, limit: '50' });
  for (const t of type ?? []) params.append('type', t);
  const res = await page.request.get(`/api/v1/partners/options?${params.toString()}`, { headers: scopeHeader(companyId) });
  const text = await res.text();
  expect(res.status(), `GET /partners/options → ${text}`).toBe(200);
  return (JSON.parse(text) as { items: PartnerRow[] }).items;
}

/* ============================== định vị trong form ============================== */

/**
 * Khối FgField bao quanh `<label>` có nhãn `label` (chấp nhận hậu tố " *").
 * Nhãn không gắn `htmlFor` ⇒ dùng khối cha để tìm ô nhập / ô chọn / nút / dòng chỉ đọc bên trong.
 */
export function fieldOf(scope: Page | Locator, label: string): Locator {
  return scope
    .locator('label')
    .filter({ hasText: new RegExp(`^${esc(label)}(\\s\\*)?$`) })
    .first()
    .locator('xpath=..');
}

/** Ô chọn đối tác (PartnerPicker) có nhãn `label`. */
export function pickerOf(scope: Page | Locator, label: string): Locator {
  return fieldOf(scope, label);
}

/** Ô gõ của ô chọn đối tác (combobox antd). */
export function comboOf(picker: Locator): Locator {
  return picker.locator('input[role="combobox"]').first();
}

/** Mở ô chọn (nếu chưa có focus) rồi gõ tìm; chờ request /partners/options và debounce 300 ms. */
export async function searchPicker(page: Page, picker: Locator, text: string): Promise<void> {
  const input = comboOf(picker);
  const focused = await input.evaluate((el) => el === document.activeElement);
  if (!focused) await picker.locator('.ant-select').first().click();
  const reply = page.waitForResponse((r) => r.url().includes('/api/v1/partners/options'), { timeout: 3000 }).catch(() => null);
  await input.fill(text);
  await reply;
  await page.waitForTimeout(350);
}

/** Dropdown đang mở của ô chọn (antd render qua portal). */
export function dropdown(page: Page): Locator {
  return page.locator('.ant-select-dropdown:visible').last();
}

/** Mọi dòng gợi ý đang hiển thị. */
export function optionsOf(page: Page): Locator {
  return page.locator('.ant-select-dropdown:visible .ant-select-item-option');
}

/** Dòng gợi ý có chứa `text` (tên đối tác). */
export function optionNamed(page: Page, text: string): Locator {
  return optionsOf(page).filter({ hasText: text });
}

/** Bấm nút "+ Tạo đối tác…" nằm ở chân dropdown. */
export async function clickDropdownCreate(page: Page): Promise<void> {
  await dropdown(page).getByRole('button', { name: /^\+ Tạo đối tác/ }).click();
}

/** Nút "+ Tạo đối tác" cạnh ô chọn (khi chưa chọn đối tác). */
export function sideCreateButton(picker: Locator): Locator {
  return picker.getByRole('button', { name: '+ Tạo đối tác', exact: true });
}

/* ============================== popup tạo / sửa đối tác ============================== */

/** Popup tạo/sửa đối tác đang mở (lấy modal có tiêu đề khớp, phòng khi có modal lồng nhau). */
export function partnerPopup(page: Page, title: RegExp = /^(Tạo đối tác|Sửa đối tác)/): Locator {
  return page.locator('.ant-modal:visible').filter({ has: page.locator('.ant-modal-title', { hasText: title }) }).last();
}

/** Modal "Khoản chi định kỳ mới" đang mở (form định kỳ nằm trong modal của màn /quantri/dinh-ky). */
export function recurModalLocator(page: Page): Locator {
  return page.locator('.ant-modal:visible').filter({ has: page.locator('.ant-modal-title', { hasText: /Khoản chi định kỳ mới/ }) }).last();
}

/** Ô "Tên đối tác" (ô nhập có maxlength 200 — duy nhất trong popup). */
export function popName(pop: Locator): Locator {
  return pop.locator('input[maxlength="200"]').first();
}
export function popBank(pop: Locator): Locator {
  return pop.getByPlaceholder('VD: Vietcombank');
}
export function popAccount(pop: Locator): Locator {
  return pop.getByPlaceholder('VD: 0123456789');
}
export function popTax(pop: Locator): Locator {
  return pop.getByPlaceholder('VD: 0101234567');
}

/** Các lựa chọn Loại đối tác đang hiện trong popup (rỗng nếu chỉ có một loại). */
export async function popTypeOptions(pop: Locator): Promise<string[]> {
  const items = pop.locator('.ant-segmented').first().locator('.ant-segmented-item');
  return (await items.allInnerTexts()).map((s) => s.trim()).filter(Boolean);
}

/** Loại đang chọn trong popup (nhãn). Với một loại cố định: trả về nội dung dòng "Loại đối tác". */
export async function popSelectedType(pop: Locator): Promise<string> {
  const seg = pop.locator('.ant-segmented').first();
  if ((await seg.count()) === 0) {
    // một loại cố định: khối "Loại đối tác *" gồm nhãn rồi tới nội dung loại
    const lines = (await fieldOf(pop, 'Loại đối tác').innerText()).split('\n').map((s) => s.trim()).filter(Boolean);
    return lines[1] ?? '';
  }
  return (await seg.locator('.ant-segmented-item-selected').first().innerText()).trim();
}

/** Chọn loại trong popup (chỉ khi có nhiều loại). */
export async function popChooseType(pop: Locator, t: PartnerType): Promise<void> {
  await pop.locator('.ant-segmented-item').filter({ hasText: TYPE_LABEL[t] }).first().click();
}

/** Nút trong chân popup. */
export function popFooter(pop: Locator, name: string): Locator {
  return pop.locator('.ant-modal-footer').getByRole('button', { name, exact: true });
}

/** Chờ popup đóng hẳn. */
export async function expectPopupClosed(pop: Locator): Promise<void> {
  await expect(pop).toHaveCount(0, { timeout: 10000 });
}

/* ============================== chỉ đọc bên dưới ô ============================== */

/** Dòng chỉ đọc "Ngân hàng: …" / "STK: …" / "MST: …" dưới ô chọn. */
export function readonlyLine(picker: Locator, prefix: 'Ngân hàng' | 'STK' | 'MST'): Locator {
  return picker.locator('span').filter({ hasText: new RegExp(`^${prefix}: `) }).first();
}

/* ============================== tiện ích form ============================== */

/** Mở một màn có ô chọn và chờ nhãn ô xuất hiện. */
export async function openForm(page: Page, path: string, label: string): Promise<Locator> {
  await page.goto(path);
  const picker = pickerOf(page, label);
  await expect(picker).toBeVisible({ timeout: 20000 });
  return picker;
}

/** Ghi nhận mọi request ghi (không GET) tới API trong lúc chạy thao tác. */
export function trackWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'GET' && r.url().includes('/api/v1/')) writes.push(`${r.method()} ${new URL(r.url()).pathname}`);
  });
  return writes;
}

/** Điền số tiền (ô FgMoneyInput có aria-label "Số tiền"). */
export async function fillAmount(scope: Page | Locator, label: string, digits: string): Promise<void> {
  await fieldOf(scope, label).locator('input').first().fill(digits);
}

/** Toast thông báo (antd message/notification) chứa `text`. */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.getByText(text).first();
}

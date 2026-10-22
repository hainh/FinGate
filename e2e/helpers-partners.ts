/**
 * Tiện ích dùng chung cho spec Đối tác (v2/v2.md §5): gọi API để chuẩn bị / kiểm tra dữ liệu,
 * và thao tác màn hình (danh sách, popup, hộp thoại). Chỉ dùng trong e2e/v2-partners.spec.ts.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const COMPANY = { CTA: 'CTA', CTB: 'CTB', GROUP: 'GROUP', MAYOGU: 'MAYOGU' } as const;

/** Ngày hạn xa trong tương lai (không quá hạn) / ngày quá khứ (quá hạn). */
export const FAR_FUTURE = '2099-12-31';
export const LONG_PAST = '2020-01-15';

/** Chuỗi số ngẫu nhiên (số tài khoản / MST không trùng giữa các lượt). */
export function randomDigits(len = 10): string {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}

/* ================= API ================= */

export interface ApiResult {
  status: number;
  body: any;
  text: string;
}

/** Gọi `/api/v1/...` bằng cookie của trang (cùng phiên đăng nhập). `scope` = id công ty (header x-company-scope). */
export async function api(page: Page, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, opts: { scope?: string; data?: unknown } = {}): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (opts.scope) headers['x-company-scope'] = opts.scope;
  const res = await page.request.fetch(`/api/v1${path}`, {
    method,
    headers,
    data: opts.data as never,
    failOnStatusCode: false,
  });
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status(), body, text };
}

const companyIdCache = new Map<string, string>();

/** Id công ty theo mã (CTA, CTB…) lấy từ hồ sơ người dùng đang đăng nhập. */
export async function companyId(page: Page, code: string): Promise<string> {
  const cached = companyIdCache.get(code);
  if (cached) return cached;
  const r = await api(page, 'GET', '/me');
  expect(r.status, r.text).toBe(200);
  const me = r.body?.data ?? r.body;
  const list: { company_id: string; company_code: string }[] = me?.companies ?? [];
  const hit = list.find((c) => c.company_code === code);
  expect(hit, `người dùng không có công ty ${code}: ${JSON.stringify(list)}`).toBeTruthy();
  companyIdCache.set(code, hit!.company_id);
  return hit!.company_id;
}

/**
 * Ghim phạm vi mặc định của người dùng về một công ty. Phạm vi lưu trên máy chủ (prefs.default_scope) và
 * dùng chung giữa các bài test / lượt chạy, nên mỗi bài phải tự ghim trước khi mở màn hình.
 */
export async function pinScope(page: Page, code: string): Promise<void> {
  const id = await companyId(page, code);
  const r = await api(page, 'PATCH', '/me/prefs', { data: { default_scope: id } });
  expect(r.status, r.text).toBe(200);
}

export interface PartnerRow {
  _id: string;
  code: string;
  type: 'bank' | 'customer' | 'supplier';
  name: string;
  bank_name: string | null;
  account_number: string | null;
  tax_code: string | null;
  status: 'active' | 'inactive';
  company_id?: string;
  has_activity?: boolean;
  [k: string]: unknown;
}

/** Tạo đối tác qua API (công ty theo mã). Kỳ vọng 201. */
export async function createPartnerApi(page: Page, code: string, body: Record<string, unknown>): Promise<PartnerRow> {
  const scope = await companyId(page, code);
  const r = await api(page, 'POST', '/partners', { scope, data: { company_id: scope, ...body } });
  expect(r.status, `tạo đối tác: ${r.text}`).toBe(201);
  return r.body.data.partner as PartnerRow;
}

/** Chi tiết đối tác (GET /partners/:id) theo công ty của đối tác. */
export async function getPartnerApi(page: Page, code: string, id: string): Promise<any> {
  const scope = await companyId(page, code);
  const r = await api(page, 'GET', `/partners/${id}`, { scope });
  expect(r.status, r.text).toBe(200);
  return r.body.data;
}

/** Tìm đối tác theo tên đúng (qua GET /partners?q=). Trả null nếu không có. */
export async function findPartnerApi(page: Page, code: string, name: string): Promise<PartnerRow | null> {
  const scope = await companyId(page, code);
  const r = await api(page, 'GET', `/partners?q=${encodeURIComponent(name)}&status=all&limit=200`, { scope });
  expect(r.status, r.text).toBe(200);
  const items: PartnerRow[] = r.body?.items ?? r.body?.data?.items ?? [];
  return items.find((p) => p.name === name) ?? null;
}

/** Ô chọn đối tác (GET /partners/options) — mặc định chỉ đối tác đang hoạt động. */
export async function optionsApi(page: Page, code: string, q: string): Promise<PartnerRow[]> {
  const scope = await companyId(page, code);
  const r = await api(page, 'GET', `/partners/options?q=${encodeURIComponent(q)}`, { scope });
  expect(r.status, r.text).toBe(200);
  return r.body?.items ?? r.body?.data?.items ?? [];
}

export async function patchPartnerApi(page: Page, code: string, id: string, body: Record<string, unknown>): Promise<ApiResult> {
  const scope = await companyId(page, code);
  return api(page, 'PATCH', `/partners/${id}`, { scope, data: body });
}

export async function setStatusApi(page: Page, code: string, id: string, status: 'active' | 'inactive'): Promise<void> {
  const scope = await companyId(page, code);
  const r = await api(page, 'POST', `/partners/${id}/${status === 'active' ? 'reactivate' : 'deactivate'}`, { scope });
  expect(r.status, r.text).toBe(200);
}

/** Công nợ phải thu (receivable) / phải trả (payable) cho KH/NCC. `amount` = đồng (VND). */
export async function createDebtApi(
  page: Page,
  code: string,
  opts: { partnerId: string; direction: 'receivable' | 'payable'; amount: number; dueDate: string },
): Promise<{ _id: string; code: string }> {
  const scope = await companyId(page, code);
  const r = await api(page, 'POST', '/debts', {
    scope,
    data: {
      company_id: scope,
      partner_id: opts.partnerId,
      direction: opts.direction,
      value: { amount_minor: String(opts.amount), currency: 'VND' },
      due_date: opts.dueDate,
    },
  });
  expect(r.status, `tạo công nợ: ${r.text}`).toBe(201);
  return r.body.data;
}

export async function getDebtApi(page: Page, code: string, id: string): Promise<any> {
  const scope = await companyId(page, code);
  const r = await api(page, 'GET', `/debts/${id}`, { scope });
  expect(r.status, r.text).toBe(200);
  return r.body.data;
}

/** Khoản vay ngân hàng (đang vay ngay, giải ngân hôm nay). `amount` = đồng. */
export async function createLoanApi(page: Page, code: string, opts: { partnerId: string; amount: number; maturityDate: string }): Promise<{ _id: string; code: string }> {
  const scope = await companyId(page, code);
  const r = await api(page, 'POST', '/bank-debts', {
    scope,
    data: {
      company_id: scope,
      partner_id: opts.partnerId,
      amount: { amount_minor: String(opts.amount), currency: 'VND' },
      maturity_date: opts.maturityDate,
    },
  });
  expect(r.status, `tạo khoản vay: ${r.text}`).toBe(201);
  return r.body.data;
}

export async function getLoanApi(page: Page, code: string, id: string): Promise<any> {
  const scope = await companyId(page, code);
  const r = await api(page, 'GET', `/bank-debts/${id}`, { scope });
  expect(r.status, r.text).toBe(200);
  return r.body.data;
}

export async function getDocumentApi(page: Page, code: string, id: string): Promise<any> {
  const scope = await companyId(page, code);
  const r = await api(page, 'GET', `/documents/${id}`, { scope });
  expect(r.status, r.text).toBe(200);
  return r.body.data;
}

/* ================= theo dõi lỗi ================= */

/** Ghi lại lỗi JS trang và lỗi 5xx của API đối tác / công nợ / khoản vay trong suốt bài test. */
export function watchErrors(page: Page): string[] {
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() >= 500 && /\/api\/v1\/(partners|debts|bank-debts|documents)/.test(url)) {
      failures.push(`HTTP ${res.status()} ${res.request().method()} ${url}`);
    }
    // 4xx của API chỉ ghi nhật ký để chẩn đoán (không tính là lỗi)
    if (res.status() === 404 && url.includes('/api/v1/')) {
      console.log(`[api 404 info] ${res.request().method()} ${url}`);
    }
  });
  return failures;
}

/* ================= điều hướng & thao tác màn Đối tác ================= */

export async function gotoList(page: Page, qs = ''): Promise<void> {
  await page.goto(`/doi-tac${qs}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Đối tác' })).toBeVisible({ timeout: 20_000 });
}

export async function gotoDetail(page: Page, id: string): Promise<void> {
  await page.goto(`/doi-tac/${id}`);
  await expect(page.getByRole('link', { name: '← Danh sách đối tác' })).toBeVisible({ timeout: 20_000 });
}

/** Hàng bảng có liên kết tên đối tác đúng `name`. */
export function rowOf(page: Page, name: string): Locator {
  return page.locator('tr.ant-table-row').filter({ has: page.getByRole('link', { name, exact: true }) });
}

/** Gõ vào ô tìm của màn danh sách và chờ kết quả (debounce 300ms). */
export async function searchList(page: Page, text: string): Promise<void> {
  const box = page.getByLabel('Tìm đối tác', { exact: true });
  await box.fill(text);
  await page.waitForTimeout(400);
}

/** Mở menu "Thao tác ▾" của một hàng. */
export async function openRowMenu(page: Page, name: string): Promise<void> {
  await rowOf(page, name).getByRole('button', { name: `Thao tác với ${name}` }).click();
}

/** Chọn một mục menu đang mở (khớp nguyên văn nhãn). */
export async function clickMenuItem(page: Page, label: string): Promise<void> {
  await page.getByRole('menuitem', { name: label, exact: true }).first().click();
}

/** Hộp thoại đang mở có chứa `text`. */
export function dialogWith(page: Page, text: string | RegExp): Locator {
  return page.getByRole('dialog').filter({ hasText: text }).last();
}

/** Chọn loại trong popup tạo / sửa đối tác (nhãn nút đoạn). */
export async function pickSegment(scope: Locator, label: string): Promise<void> {
  await scope.locator('.ant-segmented-item', { hasText: label }).click();
}

/** Điền popup tạo / sửa đối tác. `type` chọn trước (vì placeholder ô tên phụ thuộc loại). */
export async function fillPartnerForm(
  dlg: Locator,
  f: { type?: 'bank' | 'customer' | 'supplier'; name?: string; bank?: string; account?: string; tax?: string; note?: string },
): Promise<void> {
  if (f.type) await pickSegment(dlg, f.type === 'bank' ? 'Ngân hàng' : f.type === 'customer' ? 'Khách hàng' : 'Nhà cung cấp');
  if (f.name !== undefined) {
    const placeholder = f.type === 'bank' ? 'VD: BIDV – CN Đông Đô' : 'VD: Công ty TNHH ABC';
    await dlg.getByPlaceholder(placeholder).fill(f.name);
  }
  if (f.bank !== undefined) await dlg.getByPlaceholder('VD: Vietcombank').fill(f.bank);
  if (f.account !== undefined) await dlg.getByPlaceholder('VD: 0123456789').fill(f.account);
  if (f.tax !== undefined) await dlg.getByPlaceholder('VD: 0101234567').fill(f.tax);
  if (f.note !== undefined) await dlg.locator('textarea').fill(f.note);
}

/** Số đồng trong một ô tiền (bỏ mọi ký tự không phải chữ số): "750.000 ₫" → "750000", "—" → "". */
export function moneyDigits(text: string | null): string {
  return (text ?? '').replace(/\D/g, '');
}

/** Ô (td) của hàng theo thứ tự cột: 0 Đối tác · 1 Loại · 2 Ngân hàng·STK·MST · 3 Còn phải thu · 4 Còn phải trả · 5 Quá hạn · 6 Dư nợ · 7 Đáo hạn gần nhất · 8 Tổng thu · 9 Tổng chi · 10 Trạng thái (công ty = chỉ hiện khi phạm vi "Toàn tập đoàn"). */
export const LIST_COL = { name: 0, type: 1, bank: 2, receivable: 3, payable: 4, overdue: 5, outstanding: 6, maturity: 7, paidIn: 8, paidOut: 9, status: 10 } as const;

export function cellOf(page: Page, name: string, col: number): Locator {
  return rowOf(page, name).locator('td').nth(col);
}

/** Đếm xem mục menu có bị vô hiệu hoá không (antd: aria-disabled / class). */
export async function menuItemDisabled(page: Page, label: string): Promise<boolean> {
  const item = page.getByRole('menuitem', { name: label, exact: true }).first();
  const aria = await item.getAttribute('aria-disabled');
  const cls = (await item.getAttribute('class')) ?? '';
  return aria === 'true' || cls.includes('disabled');
}

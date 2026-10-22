/**
 * Tiện ích cho spec R2 — phiếu thu đi vay ngân hàng (v2/v2.md §11.4, §10.2, US-AUTO-01/02/05).
 *
 * - API được gọi qua `page.request` (dùng chung cookie phiên của trang) kèm `x-company-scope`.
 * - Bộ máy tự động chạy bất đồng bộ (vài giây): dùng `eventually()` để chờ kết quả, không dùng sleep cố định.
 * - Form / hồ sơ dùng selector theo nhãn tiếng Việt (FgField không gắn htmlFor nên lấy khối bao quanh nhãn).
 */
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';

export const PASSWORD = '123qweasdzxc';

/* ============================== API ============================== */

export interface ApiResult<T> {
  status: number;
  ok: boolean;
  /** Phần `data` (nếu server bọc `{ data }`), không thì toàn bộ thân trả về. */
  data: T;
  text: string;
}

/**
 * Gọi API (đường dẫn tương đối từ `/api/v1`). Thân ghi (POST/PATCH) tự thêm `request_id` như web.
 * Không ném lỗi theo HTTP status (trừ khi `expectOk`), để test tự kiểm tra và in nội dung lỗi.
 */
export async function api<T = any>(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  opts: { data?: Record<string, unknown>; scope?: string; expectOk?: boolean } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = {};
  if (opts.scope) headers['x-company-scope'] = opts.scope;
  let data = opts.data;
  if (method !== 'GET' && data && !('request_id' in data)) data = { ...data, request_id: randomUUID() };
  let res = await page.request.fetch(`/api/v1${path}`, { method, headers, data, failOnStatusCode: false });
  // proxy dev trả 502/503 khi API đang khởi động lại do bản sửa khác: yêu cầu chưa tới được API nên an toàn thử lại (cả POST)
  for (let i = 0; i < 3 && (res.status() === 502 || res.status() === 503); i++) {
    await new Promise((r) => setTimeout(r, 4000));
    res = await page.request.fetch(`/api/v1${path}`, { method, headers, data, failOnStatusCode: false });
  }
  const text = await res.text();
  let raw: any = text;
  try {
    raw = text ? JSON.parse(text) : null;
  } catch {
    /* không phải JSON */
  }
  const payload = raw && typeof raw === 'object' && !Array.isArray(raw) && 'data' in raw ? raw.data : raw;
  const result: ApiResult<T> = { status: res.status(), ok: res.ok(), data: payload as T, text };
  if (opts.expectOk !== false && !res.ok()) {
    throw new Error(`${method} /api/v1${path} → HTTP ${res.status()}: ${text.slice(0, 600)}`);
  }
  return result;
}

/** Mã định danh (ObjectId) của công ty theo mã (VD "CTA"). */
const companyCache = new Map<string, string>();
export async function companyIdOf(page: Page, code: string): Promise<string> {
  const hit = companyCache.get(code);
  if (hit) return hit;
  const r = await api<any>(page, 'GET', '/companies');
  const list: any[] = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
  const company = list.find((c) => c.code === code);
  if (!company) throw new Error(`Không thấy công ty ${code} trong phạm vi của tài khoản: ${r.text.slice(0, 300)}`);
  const id = String(company._id ?? company.id);
  companyCache.set(code, id);
  return id;
}

/**
 * Đặt phạm vi mặc định của người dùng (prefs) = công ty cần test. Trang tải sau đó sẽ ở đúng phạm vi.
 * (Cùng cơ chế với bộ chọn phạm vi trên thanh đầu.)
 */
export async function setDefaultScope(page: Page, companyId: string): Promise<void> {
  const res = await page.request.patch('/api/v1/me/prefs', { data: { default_scope: companyId }, failOnStatusCode: false });
  expect(res.ok(), `đặt phạm vi mặc định: HTTP ${res.status()}`).toBeTruthy();
}

export async function createPartner(page: Page, companyId: string, type: 'bank' | 'customer' | 'supplier', name: string) {
  const r = await api<any>(page, 'POST', '/partners', { data: { company_id: companyId, type, name, status: 'active' }, scope: companyId });
  const partner = r.data?.partner ?? r.data;
  return { _id: String(partner._id), name: String(partner.name ?? name), code: String(partner.code ?? '') };
}

export async function getDocument(page: Page, docId: string, companyId: string): Promise<any> {
  return (await api<any>(page, 'GET', `/documents/${docId}`, { scope: companyId })).data;
}

export async function getLoan(page: Page, loanId: string, companyId: string): Promise<any> {
  return (await api<any>(page, 'GET', `/bank-debts/${loanId}`, { scope: companyId })).data;
}

/** Khoản vay của một ngân hàng (cùng công ty). */
export async function loansOf(page: Page, partnerId: string, companyId: string): Promise<any[]> {
  const r = await api<any>(page, 'GET', `/bank-debts?partner_id=${partnerId}&company_id=${companyId}`, { scope: companyId });
  return Array.isArray(r.data?.items) ? r.data.items : [];
}

/** Lượt tự động đã chạy cho một phiếu (kể cả bước bỏ qua). */
export async function runsOfDocument(page: Page, docId: string, companyId: string): Promise<any[]> {
  const r = await api<any>(page, 'GET', `/automation/runs/by-source?source_type=document&source_id=${docId}&include_skipped=true`, {
    scope: companyId,
  });
  return Array.isArray(r.data) ? r.data : [];
}

/** Tạo khoản vay thủ công (đã giải ngân ⇒ trạng thái Đang vay). */
export async function createManualLoan(
  page: Page,
  companyId: string,
  partnerId: string,
  amountMinor: string,
  maturityDate: string,
): Promise<{ _id: string; code: string }> {
  const r = await api<any>(page, 'POST', '/bank-debts', {
    data: {
      company_id: companyId,
      partner_id: partnerId,
      amount: { amount_minor: amountMinor, currency: 'VND' },
      maturity_date: maturityDate,
      interest_rate: '8',
      term_months: 12,
      contract_no: `HĐ thủ công ${Date.now().toString(36)}`,
    },
    scope: companyId,
  });
  const created = r.data?.loan ?? r.data;
  return { _id: String(created._id ?? created.id), code: String(created.code) };
}

/** Chờ đến khi `read()` thoả `done()` (bộ máy tự động xử lý bất đồng bộ). Hết giờ ⇒ lỗi kèm giá trị cuối. */
export async function eventually<T>(what: string, read: () => Promise<T>, done: (v: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastErr: unknown = null;
  for (;;) {
    try {
      last = await read();
      lastErr = null;
      if (done(last)) return last;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const shown = last === undefined ? '(chưa có)' : JSON.stringify(last).slice(0, 800);
  throw new Error(`Hết ${timeoutMs} ms chờ: ${what}. Giá trị cuối: ${shown}${lastErr ? ` · lỗi: ${String(lastErr)}` : ''}`);
}

/* ============================== ngày tháng ============================== */

/** Cộng tháng cho ngày ISO (YYYY-MM-DD); lùi về ngày cuối tháng khi cần (như bộ máy). */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** Ngày hôm nay theo giờ Việt Nam (YYYY-MM-DD). */
export function todayIsoVn(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
}

/** YYYY-MM-DD → DD/MM/YYYY (định dạng ô nhập ngày của giao diện). */
export function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

export function escapeRe(s: string): RegExp {
  return new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
}

/* ============================== giao diện: form ============================== */

/** Khối bao quanh một nhãn trên form (nhãn không gắn `for`, nên tìm qua khối cha). */
export function fieldOf(page: Page, label: RegExp): Locator {
  return page.locator('label').filter({ hasText: label }).first().locator('xpath=..');
}

/** Ô "Đây là khoản vay ngân hàng (đi vay)". */
export function borrowCheckbox(page: Page): Locator {
  return page.locator('label').filter({ hasText: 'Đây là khoản vay ngân hàng (đi vay)' }).locator('input[type="checkbox"]');
}

/** Chọn đối tác bằng cách gõ tên rồi bấm đúng dòng gợi ý (PartnerPicker: antd Select có tìm kiếm). */
export async function pickPartner(page: Page, label: RegExp, name: string): Promise<void> {
  const field = fieldOf(page, label);
  await field.locator('.ant-select').first().click();
  await field.locator('input[role="combobox"]').first().fill(name);
  const opt = page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: name }).first();
  await expect(opt).toBeVisible({ timeout: 15_000 });
  await opt.click();
  // khi đã chọn, nút "Sửa đối tác" xuất hiện (ô tìm còn chữ đang gõ nên không đọc được tên ở đây)
  await expect(field.getByRole('button', { name: 'Sửa đối tác' })).toBeVisible({ timeout: 10_000 });
}

/** Đối tác của ô chọn đã được xoá (chưa chọn): nút "+ Tạo đối tác" hiện, "Sửa đối tác" biến mất. */
export async function expectPartnerCleared(page: Page, label: RegExp): Promise<void> {
  const field = fieldOf(page, label);
  await expect(field.getByRole('button', { name: 'Sửa đối tác' })).toHaveCount(0, { timeout: 10_000 });
  await expect(field.getByRole('button', { name: '+ Tạo đối tác' })).toBeVisible({ timeout: 10_000 });
}

/** Chọn một dòng trong ô chọn (antd Select). `preferred` ưu tiên nếu có, không thì dòng đầu. */
export async function pickSelect(page: Page, label: RegExp, option: string | RegExp | null, preferred?: RegExp): Promise<void> {
  const field = fieldOf(page, label);
  for (let attempt = 0; ; attempt++) {
    await field.locator('.ant-select').first().click();
    const opts = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
    await expect(opts.first()).toBeVisible({ timeout: 15_000 });
    let target = option === null ? opts.first() : opts.filter({ hasText: option }).first();
    if (preferred && (await opts.filter({ hasText: preferred }).count())) target = opts.filter({ hasText: preferred }).first();
    try {
      await target.click({ timeout: 8_000 });
      return;
    } catch (e) {
      // danh sách đang được làm mới (dữ liệu dùng chung, spec khác chạy song song) ⇒ dropdown đóng giữa chừng: đóng, mở lại, chọn lại
      if (attempt >= 2) throw e;
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
}

export async function fillAmount(page: Page, digits: string): Promise<void> {
  const input = page.getByLabel('Số tiền', { exact: true });
  await input.click();
  await input.fill(digits);
}

export async function fillField(page: Page, label: RegExp, text: string): Promise<void> {
  await fieldOf(page, label).locator('input, textarea').first().fill(text);
}

/** Chọn chế độ vay trên form phiếu thu (Segmented). */
export async function pickLoanMode(page: Page, label: string): Promise<void> {
  await page.locator('.ant-segmented-item-label').filter({ hasText: escapeRe(label) }).first().click();
}

/** Hạn thanh toán của khoản vay trên form (DatePicker: gõ DD/MM/YYYY rồi Enter). */
export async function setLoanDueDate(page: Page, ddmm: string): Promise<void> {
  const input = fieldOf(page, /^Hạn thanh toán$/).locator('input').first();
  await input.click();
  await input.fill(ddmm);
  await input.press('Enter');
}

/* ============================== giao diện: hồ sơ / phê duyệt ============================== */

export function docIdFromUrl(url: string): string {
  const m = url.match(/\/ho-so\/(?:thu|chi|dao-han|noi-bo)\/([0-9a-f]{24})/);
  if (!m) throw new Error(`URL không phải hồ sơ: ${url}`);
  return m[1];
}

/** Bấm nút trên thanh hành động của hồ sơ, rồi xác nhận trong hộp thoại. */
export async function actOnDocument(page: Page, bar: RegExp, confirm: RegExp, opinion?: string): Promise<void> {
  const toolbar = page.getByRole('toolbar', { name: 'Hành động phê duyệt' });
  await expect(toolbar.getByRole('button', { name: bar }).first()).toBeVisible({ timeout: 20_000 });
  await toolbar.getByRole('button', { name: bar }).first().click();
  const modal = page.locator('.ant-modal:visible').last();
  await expect(modal).toBeVisible({ timeout: 15_000 });
  if (opinion) await modal.locator('textarea').first().fill(opinion);
  await modal.getByRole('button', { name: confirm }).click();
  try {
    await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 20_000 });
  } catch {
    const texts = await page.locator('.ant-modal:visible').allInnerTexts();
    throw new Error(`Hộp thoại không đóng sau khi xác nhận "${String(confirm)}": ${texts.join(' | ').replace(/\s+/g, ' ').slice(0, 700)}`);
  }
}

/** Vai trò trực tiếp xử lý theo trạng thái (CTA: KTT → GĐ → Chủ tịch nếu vượt ngưỡng/ghế trống). */
export function roleForStatus(status: string): 'chief' | 'director' | 'chairman' | null {
  switch (status) {
    case 'pending.ktt':
      return 'chief';
    case 'pending.gd':
      return 'director';
    case 'pending.ptg':
    case 'pending.chairman':
      return 'chairman';
    default:
      return null;
  }
}

/* ============================== tiện ích chung ============================== */

/**
 * Trang không bị thay bằng màn "Hệ thống đang gặp sự cố" (lỗi render làm vỡ cả trang).
 * Chờ trang tải xong trước (lỗi render thường xảy ra sau khi dữ liệu về).
 */
export async function expectPageNotBroken(page: Page, what: string): Promise<void> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(3000);
  await expect(page.getByText('Hệ thống đang gặp sự cố'), what).toHaveCount(0, { timeout: 15_000 });
}

/** Ghi nhận lỗi JS (pageerror) và phản hồi 5xx (trừ 502/503/504 của proxy đang khởi động lại). */
export function watchErrors(page: Page, bag: string[]): void {
  page.on('pageerror', (err) => bag.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    const s = res.status();
    if (s >= 500 && ![502, 503, 504].includes(s)) bag.push(`HTTP ${s} ${res.request().method()} ${res.url()}`);
    // 4xx chỉ để tham khảo (in ra, không tính là lỗi)
    else if (s >= 400 && s !== 401) console.log(`[info HTTP ${s}] ${res.request().method()} ${res.url()}`);
  });
}

export function docPath(kind: 'thu', id: string): string {
  return `/ho-so/${kind}/${id}`;
}

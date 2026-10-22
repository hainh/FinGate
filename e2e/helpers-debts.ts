/**
 * Helper riêng cho e2e/v2-debts.spec.ts (khu vực "debts", v2/v2.md §9, §5.3, §11).
 *
 * - Chuẩn bị dữ liệu qua API (đối tác, khoản công nợ, phiếu thu/chi → duyệt → thực thi, liên kết cấn trừ).
 * - Đọc lại qua API để đối chiếu số liệu với giao diện.
 * - Tiện ích locator cho các thành phần antd / FgField (FgField không gắn htmlFor nên tìm ô nhập theo nhãn).
 *
 * Không sửa fixtures.ts / playwright.config.ts. Mọi tên tạo ra đều đi qua uniq() ở spec.
 */
import { createHash, randomUUID } from 'node:crypto';
import { expect, request as pwRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { PASSWORD, USERS, type Role } from './fixtures';

export const BASE = process.env.E2E_BASE_URL || 'http://localhost:5139';
/** Email các tài khoản duyệt (CTA: KTT → GĐ; TGĐ/PTGĐ không có trong CTA nên bị bỏ qua). */
export const GD_EMAIL = 'gd@fingate.local';

export interface ApiUser {
  email: string;
  userId: string;
  ctx: APIRequestContext;
}

export interface ApiResult<T = any> {
  status: number;
  ok: boolean;
  json: T;
  text: string;
}

/* ============================================================ *
 * Thời gian & định dạng
 * ============================================================ */

/** Ngày nghiệp vụ theo giờ Việt Nam (YYYY-MM-DD), lệch `offsetDays`. */
export function vnToday(offsetDays = 0): string {
  return new Date(Date.now() + 7 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** Số tiền hiển thị kiểu VN: 5000000 → "5.000.000" (khớp Intl vi-VN của formatMoney). */
export function vnd(n: number | string | bigint): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/* ============================================================ *
 * API (đăng nhập từng tài khoản một lần, cache trong tiến trình)
 * ============================================================ */

const sessions = new Map<string, Promise<ApiUser>>();

/**
 * Máy chủ tự khởi động lại khi mã nguồn API đổi (node --watch): trong lúc đó trả 502/503/504 hoặc lỗi kết nối.
 * Thử lại sau vài giây thay vì coi đó là lỗi nghiệp vụ.
 */
async function retryTransient<T>(fn: () => Promise<T>, statusOf: (v: T) => number): Promise<T> {
  let last: unknown = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const v = await fn();
      const s = statusOf(v);
      if (s !== 502 && s !== 503 && s !== 504) return v;
      last = new Error(`HTTP ${s} (máy chủ đang khởi động lại)`);
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function apiUser(email: string): Promise<ApiUser> {
  let p = sessions.get(email);
  if (!p) {
    p = (async () => {
      const ctx = await pwRequest.newContext({ baseURL: BASE });
      const res = await retryTransient(() => ctx.post('/api/v1/auth/login', { data: { email, password: PASSWORD } }), (r) => r.status());
      if (!res.ok()) throw new Error(`đăng nhập ${email} thất bại: ${res.status()} ${await res.text()}`);
      const body = (await res.json()) as { data?: { user_id?: string; need_2fa?: boolean } };
      const data = body.data ?? {};
      if (data.need_2fa) throw new Error(`đăng nhập ${email} yêu cầu 2FA — không dùng được cho e2e`);
      return { email, userId: String(data.user_id ?? ''), ctx };
    })();
    // Không giữ phiên lỗi trong bộ nhớ đệm: lần gọi sau sẽ đăng nhập lại
    sessions.set(
      email,
      p.catch((e) => {
        sessions.delete(email);
        throw e;
      }),
    );
  }
  return p;
}

export async function apiAs(role: Role): Promise<ApiUser> {
  return apiUser(USERS[role]);
}

export async function api<T = any>(
  user: ApiUser,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  opts: { body?: unknown; company?: string | null; query?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.company) headers['x-company-scope'] = opts.company;
  const url = opts.query && Object.keys(opts.query).length ? `${path}?${new URLSearchParams(opts.query).toString()}` : path;
  const res = await retryTransient(
    () =>
      user.ctx.fetch(url, {
        method,
        headers,
        data: opts.body as object | undefined,
        failOnStatusCode: false,
      }),
    (r) => r.status(),
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status(), ok: res.ok(), json: json as T, text };
}

/** Bắt buộc thành công; trả về phần thân JSON. Lỗi ghi rõ HTTP + nội dung server. */
export function must<T = any>(r: ApiResult<any>, label: string): T {
  if (!r.ok) throw new Error(`${label}: HTTP ${r.status} ${r.text.slice(0, 600)}`);
  return r.json as T;
}

let ctaCache: string | null = null;
/** Id công ty CTA (đọc từ /me của kế toán viên, không cố định trong mã). */
export async function ctaId(): Promise<string> {
  if (ctaCache) return ctaCache;
  const staff = await apiAs('staff');
  const me = must<any>(await api(staff, 'GET', '/api/v1/me'), 'đọc /me');
  const list: { company_id: string; company_code: string }[] = (me.data ?? me).companies ?? [];
  const hit = list.find((c) => c.company_code === 'CTA');
  if (!hit) throw new Error('Không thấy công ty CTA trong /me của kế toán viên');
  ctaCache = String(hit.company_id);
  return ctaCache;
}

let bankCache: string | null = null;
/** Tài khoản ngân hàng đang hoạt động của CTA (nguồn/đích tiền cho phiếu test). */
export async function ctaBankAccountId(): Promise<string> {
  if (bankCache) return bankCache;
  const staff = await apiAs('staff');
  const cta = await ctaId();
  const r = must<any>(await api(staff, 'GET', '/api/v1/bank-accounts', { company: cta }), 'đọc tài khoản');
  const acc = (r.items as any[]).find((a) => a.company_code === 'CTA' && a.kind === 'bank' && a.status === 'active');
  if (!acc) throw new Error('CTA không có tài khoản ngân hàng đang hoạt động');
  bankCache = String(acc._id);
  return bankCache;
}

/**
 * Đặt công ty mặc định (default_scope) của người dùng về CTA để màn hình (UI) mở đúng phạm vi.
 * Trả về hàm khôi phục giá trị cũ — gọi trong afterAll.
 */
export async function useCtaScope(email: string): Promise<() => Promise<void>> {
  const u = await apiUser(email);
  const cta = await ctaId();
  const me = must<any>(await api(u, 'GET', '/api/v1/me'), 'đọc /me');
  const original: string | null = (me.data ?? me).prefs?.default_scope ?? null;
  if (original === cta) return async () => {};
  must(await api(u, 'PATCH', '/api/v1/me/prefs', { body: { default_scope: cta } }), 'đặt phạm vi CTA');
  return async () => {
    await api(u, 'PATCH', '/api/v1/me/prefs', { body: { default_scope: original ?? 'all' } });
  };
}

/* ============================================================ *
 * Đối tác, khoản công nợ, phiếu
 * ============================================================ */

export interface PartnerRow {
  id: string;
  name: string;
  type: 'customer' | 'supplier' | 'bank';
}

export async function createPartner(
  type: 'customer' | 'supplier' | 'bank',
  name: string,
  extra: { bank_name?: string; account_number?: string } = {},
): Promise<PartnerRow> {
  const staff = await apiAs('staff');
  const cta = await ctaId();
  const r = must<any>(
    await api(staff, 'POST', '/api/v1/partners', {
      company: cta,
      body: { type, name, company_id: cta, status: 'active', request_id: randomUUID(), ...extra },
    }),
    `tạo đối tác ${name}`,
  );
  const p = r.data.partner;
  return { id: String(p._id), name: String(p.name), type };
}

export interface DebtRef {
  id: string;
  code: string;
}

export async function createDebt(
  partnerId: string,
  direction: 'receivable' | 'payable',
  valueMinor: number,
  dueDate: string,
  extra: { contract_code?: string; note?: string; priority?: string } = {},
): Promise<DebtRef> {
  const staff = await apiAs('staff');
  const cta = await ctaId();
  const r = must<any>(
    await api(staff, 'POST', '/api/v1/debts', {
      company: cta,
      body: {
        company_id: cta,
        partner_id: partnerId,
        direction,
        value: { amount_minor: String(valueMinor), currency: 'VND' },
        due_date: dueDate,
        priority: extra.priority ?? 'normal',
        request_id: randomUUID(),
        ...(extra.contract_code ? { contract_code: extra.contract_code } : {}),
        ...(extra.note ? { note: extra.note } : {}),
      },
    }),
    `tạo khoản công nợ (${direction})`,
  );
  return { id: String(r.data._id), code: String(r.data.code) };
}

/** Chi tiết khoản công nợ (GET /debts/:id → { data }). */
export async function getDebt(debtId: string): Promise<any> {
  const staff = await apiAs('staff');
  const cta = await ctaId();
  return must<any>(await api(staff, 'GET', `/api/v1/debts/${debtId}`, { company: cta }), 'đọc khoản công nợ').data;
}

/** Mã hiện tại của phiếu: mã nháp DRAFT-… được đổi thành mã thật khi gửi duyệt. */
export async function codeOf(docId: string, user?: ApiUser): Promise<string> {
  return String((await getDoc(docId, user)).code);
}

export async function getDoc(docId: string, user?: ApiUser): Promise<any> {
  const u = user ?? (await apiAs('staff'));
  const cta = await ctaId();
  return must<any>(await api(u, 'GET', `/api/v1/documents/${docId}`, { company: cta }), 'đọc phiếu').data;
}

export interface VoucherRef {
  id: string;
  code: string;
  kind: 'income' | 'spend';
}

/** Lập phiếu thu/chi nháp của CTA (kế toán viên). Nguồn tiền = tài khoản ngân hàng của CTA. */
export async function createVoucher(kind: 'income' | 'spend', partnerId: string, amountMinor: number, title: string): Promise<VoucherRef> {
  const staff = await apiAs('staff');
  const cta = await ctaId();
  const bank = await ctaBankAccountId();
  const r = must<any>(
    await api(staff, 'POST', '/api/v1/documents', {
      company: cta,
      body: {
        kind,
        company_id: cta,
        title,
        purpose: `Nội dung ${title}`,
        partner_id: partnerId,
        amount: { amount_minor: String(amountMinor), currency: 'VND' },
        source: { fund: 'bank', account_id: bank, group_managed: false },
        planned_date: `${vnToday()}T09:00`,
        priority: 'normal',
        budget: { in_plan: true },
        contract: {},
        tag_ids: [],
        options: { loan: null },
        transfer_target: null,
      },
    }),
    `lập phiếu ${kind}`,
  );
  const d = r.data ?? r;
  return { id: String(d._id), code: String(d.code), kind };
}

/**
 * Nháp tạo từ "Trả nợ" chưa có tài khoản (dialog không gửi receipt/payment_account_id):
 * kế toán viên chọn tài khoản ngân hàng của CTA trước khi gửi duyệt.
 */
export async function setDraftAccount(docId: string): Promise<void> {
  const staff = await apiAs('staff');
  const cta = await ctaId();
  const bank = await ctaBankAccountId();
  const doc = await getDoc(docId, staff);
  must(
    await api(staff, 'PATCH', `/api/v1/documents/${docId}`, {
      company: cta,
      body: { source: { fund: 'bank', account_id: bank, group_managed: false }, if_match: doc.version, request_id: randomUUID() },
    }),
    `chọn tài khoản cho nháp ${doc.code}`,
  );
}

/**
 * Gửi duyệt (kế toán viên là người lập).
 * `api()` thử lại khi đứt kết nối / 502–504 (máy chủ khởi động lại) bằng cùng một yêu cầu. Nếu lượt đầu đã được
 * máy chủ xử lý nhưng phản hồi bị mất, lượt thử lại gặp CAS 409 FG-WF-011 dù hồ sơ ĐÃ sang "chờ duyệt" — khi đó
 * coi như gửi duyệt thành công (không đổi hành vi máy chủ; chỉ chống lỗi do thử lại của test).
 */
export async function submitVoucher(docId: string): Promise<void> {
  const staff = await apiAs('staff');
  const r = await transition(staff, docId, 'submit');
  if (!r.ok && r.status === 409 && String((await getDoc(docId, staff)).status).startsWith('pending.')) return;
  must(r, `gửi duyệt ${docId}`);
}

export async function transition(user: ApiUser, docId: string, action: string, extra: Record<string, unknown> = {}): Promise<ApiResult<any>> {
  const cta = await ctaId();
  const doc = await getDoc(docId, user);
  return api(user, 'POST', `/api/v1/documents/${docId}/transition`, {
    company: cta,
    body: { action, if_match: doc.version, request_id: randomUUID(), ...extra },
  });
}

/**
 * Tài khoản có thể duyệt trong CTA. `gd@` đã ngừng hoạt động trong DB test nên không đăng nhập được — bỏ qua.
 */
const APPROVER_EMAILS = [USERS.chief, USERS.director, USERS.chairman];

/** Chọn người đang đứng ở bước duyệt hiện tại (theo user_id của bước, rồi theo chức danh). */
async function approverFor(step: { role?: string; user_id?: string | null }): Promise<ApiUser> {
  const settled = await Promise.allSettled(APPROVER_EMAILS.map((e) => apiUser(e)));
  const pool = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
  if (step.user_id) {
    const hit = pool.find((p) => p.userId === String(step.user_id));
    if (hit) return hit;
  }
  const byRole: Record<string, string> = {
    chief_accountant: USERS.chief,
    director: USERS.director,
    chairman: USERS.chairman,
  };
  return apiUser(byRole[String(step.role)] ?? USERS.director);
}

/** Duyệt hồ sơ tới khi xong (income → paid tự động; spend → approved, chờ thực thi). */
export async function approveToEnd(docId: string): Promise<string> {
  const finals = ['approved', 'paid', 'queued', 'rejected', 'cancelled'];
  for (let i = 0; i < 6; i++) {
    const doc = await getDoc(docId);
    if (finals.includes(doc.status)) return String(doc.status);
    const current = ((doc.approval?.steps ?? []) as any[]).find((s) => s.state === 'current');
    if (!current) return String(doc.status);
    const approver = await approverFor(current);
    const r = await transition(approver, docId, 'approve', { verify: { method: 'password', value: PASSWORD } });
    must(r, `duyệt ${doc.code} (${current.role})`);
  }
  return String((await getDoc(docId)).status);
}

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/** Đính kèm UNC (loại `bank_order`) — điều kiện bắt buộc để đánh dấu đã chi. */
export async function attachUnc(docId: string): Promise<void> {
  const staff = await apiAs('staff');
  const cta = await ctaId();
  const sha = createHash('sha256').update(PNG_1X1).digest('hex');
  const doc = await getDoc(docId, staff);
  const prep = must<any>(
    await api(staff, 'POST', `/api/v1/documents/${docId}/attachments/prepare`, {
      company: cta,
      body: {
        filename: 'UNC-e2e.png',
        size: PNG_1X1.length,
        mime: 'image/png',
        sha256: sha,
        type: 'bank_order',
        if_match: doc.version,
        request_id: randomUUID(),
      },
    }),
    `xin upload UNC ${doc.code}`,
  ).data;
  const put = await staff.ctx.fetch(String(prep.upload_url), {
    method: 'PUT',
    headers: { 'content-type': 'image/png', 'x-company-scope': cta },
    data: PNG_1X1,
    failOnStatusCode: false,
  });
  if (!put.ok()) throw new Error(`upload UNC thất bại: ${put.status()} ${await put.text()}`);
  const doc2 = await getDoc(docId, staff);
  must(
    await api(staff, 'POST', `/api/v1/documents/${docId}/attachments/confirm`, {
      company: cta,
      body: { attachment_id: prep.attachment_id, if_match: doc2.version, request_id: randomUUID() },
    }),
    `xác nhận UNC ${doc2.code}`,
  );
}

/** Thực thi phiếu chi đã duyệt: UNC + số tham chiếu + ngày thực chi (kế toán viên). */
export async function payVoucher(docId: string, bankRef = `REF-${Date.now().toString(36)}`): Promise<void> {
  const staff = await apiAs('staff');
  await attachUnc(docId);
  const r = await transition(staff, docId, 'pay', {
    verify: { method: 'password', value: PASSWORD },
    execution: { paid_at: vnToday(), bank_ref: bankRef },
  });
  must(r, `thực thi phiếu ${docId}`);
}

/** Đưa phiếu thu/chi từ nháp tới đã duyệt / đã thanh toán (spend cần thêm bước thực thi). */
export async function runVoucherToPaid(kind: 'income' | 'spend', docId: string): Promise<string> {
  await submitVoucher(docId);
  const status = await approveToEnd(docId);
  if (kind === 'spend' && status !== 'paid') {
    await payVoucher(docId);
  }
  return String((await getDoc(docId)).status);
}

/** Gán phiếu vào khoản công nợ qua API (POST /debts/:id/links). */
export async function linkDebt(debtId: string, docId: string, amountMinor?: number): Promise<ApiResult<any>> {
  const staff = await apiAs('staff');
  const cta = await ctaId();
  return api(staff, 'POST', `/api/v1/debts/${debtId}/links`, {
    company: cta,
    body: { document_id: docId, ...(amountMinor !== undefined ? { amount_minor: String(amountMinor) } : {}) },
  });
}

/* ============================================================ *
 * Locator tiện ích (FgField không liên kết nhãn với ô nhập)
 * ============================================================ */

/** Khối trường (FgField): nhãn + điều khiển + thông báo lỗi nằm cùng một thẻ cha. */
export function fieldRoot(scope: Page | Locator, label: string): Locator {
  return scope.locator('label').filter({ hasText: label }).first().locator('xpath=..');
}

/** Ô KPI (thẻ .fg-kpi) chứa nhãn. */
export function kpi(page: Page, label: string): Locator {
  return page.locator('.fg-kpi').filter({ hasText: label }).first();
}

/** Thẻ số liệu trên màn chi tiết đối tác (PartnerKpi). */
export function cardWith(page: Page, label: string): Locator {
  return page.locator('.ant-card').filter({ hasText: label }).first();
}

/** Hàng bảng antd chứa văn bản. */
export function rowWith(scope: Page | Locator, text: string): Locator {
  return scope.locator('tr.ant-table-row, tbody tr').filter({ hasText: text }).first();
}

/** Mở dropdown antd trong một trường, gõ tìm (tuỳ chọn) rồi chọn đúng dòng có chữ `option`. */
export async function pickAntdOption(page: Page, root: Locator, option: string | RegExp, search?: string): Promise<void> {
  const combo = root.locator('input[role="combobox"]').first();
  await combo.click();
  if (search) await combo.fill(search);
  const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: option }).first();
  await expect(opt).toBeVisible({ timeout: 15_000 });
  await opt.click();
}

/** Chọn đối tác trên FgPartnerPicker (antd Select có tìm kiếm) theo tên. */
export async function pickPartner(page: Page, label: string, name: string): Promise<void> {
  const root = fieldRoot(page, label);
  const input = root.locator('input[role="combobox"]').first();
  await input.click();
  await input.fill(name);
  const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: name }).first();
  await expect(opt).toBeVisible({ timeout: 15_000 });
  await opt.click();
  await expect(root).toContainText(name);
}

/**
 * Chọn hướng trên biểu mẫu công nợ bằng một lần bấm trực tiếp (đúng thao tác người dùng).
 * Lỗi "bấm Phải thu không đặt được hướng" đã được sửa (FgSegmented giữ `null` = chưa chọn); test A8 kiểm tra lại.
 */
export async function chooseDirection(page: Page, direction: 'receivable' | 'payable'): Promise<void> {
  const field = fieldRoot(page, 'Hướng công nợ');
  await field.getByText(direction === 'receivable' ? 'Phải thu' : 'Phải trả', { exact: true }).click();
}

/** Theo dõi lỗi JS (pageerror) và phản hồi 5xx của API trong suốt bài kiểm thử. */
export interface Watch {
  pageErrors: string[];
  serverErrors: string[];
}

export function watch(page: Page): Watch {
  const w: Watch = { pageErrors: [], serverErrors: [] };
  page.on('pageerror', (e) => w.pageErrors.push(e.message));
  page.on('response', (r) => {
    if (!r.url().includes('/api/v1/') || r.status() < 500) return;
    // 502/503/504 KHÔNG kèm thân JSON của API (cổng dev trả text/plain khi máy chủ đang khởi động lại) ⇒ không phải lỗi ứng dụng.
    // Lỗi do API trả luôn là application/problem+json nên vẫn bị bắt.
    const fromApi = /json/i.test(r.headers()['content-type'] ?? '');
    if ([502, 503, 504].includes(r.status()) && !fromApi) return;
    w.serverErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  return w;
}

export function expectNoErrors(w: Watch): void {
  expect(w.pageErrors, 'không có lỗi JS (pageerror) trên trang').toEqual([]);
  expect(w.serverErrors, 'không có lỗi máy chủ 5xx').toEqual([]);
}

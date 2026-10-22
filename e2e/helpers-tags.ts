/**
 * Tiện ích cho spec v2 "tags" (v2/v2.md §6.2, §12, §13; US-VOU-02..04).
 *
 * - Phạm vi công ty: đặt qua `PATCH /me/prefs` (đúng việc bộ chọn phạm vi trên header làm, và
 *   server dùng làm phạm vi mặc định khi đăng nhập). Hàm trả về cách khôi phục giá trị cũ để
 *   không để lại thay đổi cho agent khác.
 * - API chỉ dùng để CHUẨN BỊ / KIỂM TRA dữ liệu; mọi tên dữ liệu đều đi qua uniq().
 * - Theo dõi lỗi trang (pageerror) và phản hồi 5xx/404 của API.
 */
import { randomUUID } from 'node:crypto';
import type { APIResponse, Locator, Page } from '@playwright/test';
import { expect } from './fixtures';

export const COMPANY = { CTA: 'CTA', MAYOGU: 'MAYOGU', GROUP: 'GROUP', CTB: 'CTB' } as const;

export interface MeCompany {
  company_id: string;
  company_code: string;
  company_name: string;
}

export interface MeData {
  companies: MeCompany[];
  scope: { all: boolean; active_company_id: string | null; company_ids: string[] };
  prefs?: { default_scope?: string };
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
  raw: APIResponse;
}

/* ============================ phạm vi & phiên ============================ */

/** Hồ sơ người dùng đang đăng nhập (qua `GET /api/v1/me`). */
export async function meOf(page: Page): Promise<MeData> {
  const res = await page.request.get('/api/v1/me');
  expect(res.ok(), `GET /me ${res.status()}`).toBeTruthy();
  const body = await res.json();
  return (body.data ?? body) as MeData;
}

/** company_id theo mã công ty. Ném lỗi nếu người dùng không thuộc công ty đó. */
export async function companyIdOf(page: Page, code: string): Promise<string> {
  const me = await meOf(page);
  const c = me.companies.find((x) => x.company_code === code);
  if (!c) throw new Error(`Người dùng không thuộc công ty ${code}`);
  return c.company_id;
}

async function setDefaultScope(page: Page, value: string): Promise<void> {
  const res = await page.request.patch('/api/v1/me/prefs', { data: { default_scope: value } });
  expect(res.ok(), `PATCH /me/prefs ${res.status()} ${await res.text()}`).toBeTruthy();
}

/**
 * Đặt phạm vi mặc định = công ty `code` TRƯỚC khi mở trang (lần tải /me đầu tiên sẽ đọc giá trị này).
 * Trả về hàm khôi phục giá trị cũ — gọi trong `finally`.
 */
export async function useCompanyScope(page: Page, code: string): Promise<() => Promise<void>> {
  const me = await meOf(page);
  const original = me.prefs?.default_scope;
  await setDefaultScope(page, await companyIdOf(page, code));
  return async () => {
    if (original) await setDefaultScope(page, original).catch(() => undefined);
  };
}

/** Phạm vi "Toàn tập đoàn" (chỉ chủ tịch / người có `scope.all`). */
export async function useAllScope(page: Page): Promise<() => Promise<void>> {
  const me = await meOf(page);
  const original = me.prefs?.default_scope;
  await setDefaultScope(page, 'all');
  return async () => {
    if (original) await setDefaultScope(page, original).catch(() => undefined);
  };
}

/* ============================ gọi API ============================ */

/**
 * Gọi API tuỳ ý, KHÔNG ném lỗi khi HTTP không OK (caller tự kiểm tra status).
 * `scope` = company_id gắn `x-company-scope`; `'all'` hoặc rỗng → không gắn header (như UI).
 * Thân POST/PATCH tự thêm `request_id` (UUID) như client web.
 */
export async function api<T = any>(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { data?: unknown; scope?: string; query?: Record<string, string | number | boolean | undefined | string[]> } = {},
): Promise<ApiResult<T>> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((one) => params.append(k, String(one)));
    else params.set(k, String(v));
  }
  const qs = params.toString() ? `?${params.toString()}` : '';
  const headers: Record<string, string> = {};
  if (opts.scope && opts.scope !== 'all') headers['x-company-scope'] = opts.scope;
  const data =
    opts.data !== undefined && method !== 'GET' && method !== 'DELETE'
      ? { request_id: randomUUID(), ...(opts.data as object) }
      : undefined;
  const raw = await page.request.fetch(`/api/v1${path}${qs}`, { method, headers, data });
  let body: any = null;
  try {
    body = await raw.json();
  } catch {
    body = null;
  }
  return { status: raw.status(), body, raw };
}

/** Phần `data` của envelope `{data}` (hoặc chính body nếu không có envelope). */
export function dataOf<T = any>(r: ApiResult): T {
  return (r.body && typeof r.body === 'object' && 'data' in r.body ? r.body.data : r.body) as T;
}

/* ============================ tag (API) ============================ */

export interface TagApi {
  _id: string;
  name: string;
  name_key: string;
  color: string;
  hidden: boolean;
  usage_count: number;
  company_id: string;
}

/** Danh bạ tag của công ty, KỂ CẢ tag đã ẩn (cần tag:manage). */
export async function listTagsApi(page: Page, scope: string, q?: string): Promise<TagApi[]> {
  const r = await api<{ items: TagApi[] }>(page, 'GET', '/tags', {
    scope,
    query: { company_id: scope, scope, include_hidden: 'true', limit: 500, q },
  });
  expect(r.status, `GET /tags ${r.status}`).toBe(200);
  return r.body.items ?? [];
}

/**
 * Khoá chuẩn hoá phía client (giống server `normalizeNameKey`). API trả dòng tag KHÔNG kèm
 * `name_key`, nên so khớp trên tên đã chuẩn hoá.
 */
export function sameNameKey(name: string): string {
  return name.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function tagByName(page: Page, scope: string, name: string): Promise<TagApi | undefined> {
  const all = await listTagsApi(page, scope, name.slice(0, 20));
  return all.find((t) => sameNameKey(t.name) === sameNameKey(name));
}

/** Mọi tag có cùng tên chuẩn hoá trong công ty (kể cả đã ẩn) — dùng để chứng minh không tạo trùng. */
export async function tagsNamed(page: Page, scope: string, name: string): Promise<TagApi[]> {
  const all = await listTagsApi(page, scope, name.slice(0, 20));
  return all.filter((t) => sameNameKey(t.name) === sameNameKey(name));
}

export async function createTagApi(page: Page, scope: string, name: string, color?: string): Promise<ApiResult> {
  return api(page, 'POST', '/tags', { scope, data: { company_id: scope, name, color } });
}

/** Tạo tag qua API và trả về `_id` (ném lỗi nếu không tạo được). */
export async function ensureTagApi(page: Page, scope: string, name: string): Promise<string> {
  const r = await createTagApi(page, scope, name);
  expect(r.status, `POST /tags ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  return String(dataOf<any>(r)._id);
}

/* ============================ phiếu / đối tác (API) ============================ */

export interface VoucherRef {
  id: string;
  code: string;
  version: number;
}

export interface VoucherSpec {
  kind?: 'spend' | 'income';
  partnerId: string;
  accountId: string | null;
  title: string;
  amountMinor?: string;
  tagIds?: string[];
}

/** Tạo phiếu nháp qua API (contract giống form web). */
export async function createVoucherApi(page: Page, scope: string, spec: VoucherSpec): Promise<VoucherRef> {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const r = await api(page, 'POST', '/documents', {
    scope,
    data: {
      kind: spec.kind ?? 'spend',
      company_id: scope,
      title: spec.title,
      purpose: `Kiểm thử tag — ${spec.title}`,
      partner_id: spec.partnerId,
      amount: { amount_minor: spec.amountMinor ?? '150000', currency: 'VND' },
      source: { fund: 'bank', account_id: spec.accountId, group_managed: false },
      planned_date: `${tomorrow}T10:00`,
      priority: 'normal',
      tag_ids: spec.tagIds ?? [],
    },
  });
  expect(r.status, `POST /documents ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  const d = dataOf<any>(r);
  const doc = d?.document ?? d?.doc ?? d;
  const id = String(doc?._id ?? doc?.id);
  expect(id, 'phản hồi tạo phiếu thiếu _id').toMatch(/^[0-9a-f]{24}$/);
  return { id, code: String(doc?.code ?? ''), version: Number(doc?.version ?? 1) };
}

export async function getDocApi(page: Page, scope: string, id: string): Promise<any> {
  const r = await api(page, 'GET', `/documents/${id}`, { scope });
  expect(r.status, `GET /documents/${id} ${r.status}`).toBe(200);
  return dataOf(r);
}

/** Chuyển trạng thái với CAS theo version hiện tại (submit / approve / pay ...). */
export async function transitionApi(page: Page, scope: string, id: string, action: string, extra: Record<string, unknown> = {}): Promise<ApiResult> {
  const doc = await getDocApi(page, scope, id);
  return api(page, 'POST', `/documents/${id}/transition`, { scope, data: { action, if_match: doc.version, ...extra } });
}

/**
 * Đưa phiếu chi về trạng thái đã duyệt: KTV gửi → KTT duyệt → GĐ duyệt → (Chủ tịch duyệt nếu chuỗi còn cấp).
 * Chuỗi duyệt phụ thuộc số tiền (ma trận duyệt, v2 §7.2: dưới 5 tỷ thì GĐ duyệt là cấp cuối) — nên dừng ngay khi
 * phiếu đã "Đã duyệt", không gửi thêm lượt duyệt (sẽ bị 422 "Không thể approve khi hồ sơ đang ở Đã duyệt").
 */
export async function approveFullyApi(
  users: { staff: Page; chief: Page; director: Page; chairman: Page },
  scope: string,
  id: string,
): Promise<string> {
  const steps: [Page, string][] = [
    [users.staff, 'submit'],
    [users.chief, 'approve'],
    [users.director, 'approve'],
    [users.chairman, 'approve'],
  ];
  for (const [page, action] of steps) {
    if (action !== 'submit' && String((await getDocApi(users.chief, scope, id)).status) === 'approved') break;
    const r = await transitionApi(page, scope, id, action);
    expect(r.status, `transition ${action} ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  }
  const doc = await getDocApi(users.chief, scope, id);
  return String(doc.status);
}

/** Gán tag cho phiếu bằng API (PATCH /documents/:id/tags). */
export async function setDocTagsApi(page: Page, scope: string, id: string, tagIds: string[]): Promise<ApiResult> {
  const doc = await getDocApi(page, scope, id);
  return api(page, 'PATCH', `/documents/${id}/tags`, { scope, data: { tag_ids: tagIds, if_match: doc.version } });
}

export async function createPartnerApi(page: Page, scope: string, type: 'customer' | 'supplier' | 'bank', name: string): Promise<string> {
  const r = await api(page, 'POST', '/partners', { scope, data: { company_id: scope, type, name, status: 'active' } });
  expect(r.status, `POST /partners ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  const d = dataOf<any>(r);
  const p = d?.partner ?? d;
  return String(p?._id ?? p?.id);
}

/** Tài khoản ngân hàng đang hoạt động đầu tiên của công ty. */
export async function firstBankAccountApi(page: Page, scope: string): Promise<string> {
  const r = await api<{ items: any[] }>(page, 'GET', '/bank-accounts', { scope, query: { scope, for_company: scope } });
  expect(r.status, `GET /bank-accounts ${r.status}`).toBe(200);
  const items = (r.body.items ?? []) as any[];
  const acc = items.find((a) => a.kind === 'bank' && a.status === 'active' && !a.is_group) ?? items[0];
  expect(acc, 'Công ty không có tài khoản ngân hàng').toBeTruthy();
  return String(acc._id ?? acc.id);
}

/* ============================ báo cáo (API) ============================ */

export async function reportApi(page: Page, scope: string | undefined, preset: string, query: Record<string, string | undefined> = {}): Promise<any> {
  const r = await api(page, 'GET', `/reports/${preset}`, { scope, query });
  expect(r.status, `GET /reports/${preset} ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`).toBe(200);
  return dataOf(r);
}

/* ============================ theo dõi lỗi ============================ */

export interface PageWatch {
  pageErrors: string[];
  serverErrors: string[];
  notFound: string[];
}

/** Ghi nhận pageerror, phản hồi 5xx và 404 của API trong suốt test. */
export function watchPage(page: Page, label: string): PageWatch {
  const watch: PageWatch = { pageErrors: [], serverErrors: [], notFound: [] };
  page.on('pageerror', (err) => {
    watch.pageErrors.push(err.message);
    console.log(`[pageerror ${label}] ${err.message}`);
  });
  // Lỗi render bị React bắt (error boundary) không tới 'pageerror' mà chỉ ra console.error.
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/TypeError|Uncaught |above error occurred in/.test(text)) {
      watch.pageErrors.push(text.replace(/\s+/g, ' ').slice(0, 300));
      console.log(`[render-error ${label}] ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  });
  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('/api/')) return;
    const status = res.status();
    const line = `${status} ${res.request().method()} ${url.replace(/^https?:\/\/[^/]+/, '')}`;
    if (status >= 500) {
      watch.serverErrors.push(line);
      console.log(`[5xx ${label}] ${line}`);
    } else if (status === 404) {
      watch.notFound.push(line);
      console.log(`[404 ${label}] ${line}`);
    }
  });
  return watch;
}

/** Lỗi trang / 5xx là APP BUG theo tiêu chí kiểm thử; 404 chỉ ghi nhận. */
export function expectNoAppCrash(watch: PageWatch): void {
  expect(watch.pageErrors, 'Lỗi JavaScript (pageerror) trên trang').toEqual([]);
  expect(watch.serverErrors, 'API trả 5xx').toEqual([]);
}

/* ============================ UI ============================ */

/** Mở trang và chờ mạng nghỉ (dữ liệu đã tải). */
export async function openPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await settle(page);
}

/** Chờ mạng nghỉ — sau thao tác ghi, để trang làm tươi dữ liệu (version mới) như người dùng thật. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

/** Ô chọn tag theo nhãn truy cập: "Tag" (form phiếu), "Tag của phiếu" (thẻ tag chi tiết), ... */
export function tagCombo(page: Page, name: string): Locator {
  return page.getByRole('combobox', { name, exact: true });
}

/** Dòng gợi ý đang hiện (antd dropdown) có chứa `text`. */
export function visibleOption(page: Page, text: string): Locator {
  return page.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: text }).first();
}

/** Tên các chip tag trong ô chọn đang mở trên trang (`.fg-chip`). */
export async function chipNames(scope: Locator): Promise<string[]> {
  return (await scope.locator('.fg-chip').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
}

/** Gõ tên vào ô tag và chọn đúng một gợi ý có sẵn. */
export async function pickExistingTag(page: Page, box: Locator, typed: string, expectName: string): Promise<void> {
  await box.click();
  await box.pressSequentially(typed);
  const opt = visibleOption(page, expectName);
  await expect(opt, `gợi ý "${expectName}" hiện khi gõ "${typed}"`).toBeVisible({ timeout: 10_000 });
  await opt.click();
  await page.keyboard.press('Escape');
}

/** Hàng bảng (antd) có chứa `text`. */
export function tableRow(page: Page, text: string): Locator {
  return page.locator('.ant-table-tbody tr.ant-table-row', { hasText: text }).first();
}

/** Ghi chú: "Lưu tag" của thẻ tag ở chi tiết phiếu. */
export function saveTagsButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Lưu tag', exact: true });
}

/** Thông báo nổi (antd message) có chứa `text`. */
export function toast(page: Page, text: string | RegExp): Locator {
  return page.locator('.ant-message-notice', { hasText: text }).first();
}

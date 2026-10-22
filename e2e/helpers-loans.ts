/**
 * Tiện ích dùng chung cho e2e khoản vay ngân hàng (v2 §10, §11.4–11.5, US-LOAN-01…04, US-AUTO-08).
 * Dữ liệu thiết lập (đối tác ngân hàng, phiếu, duyệt, thực thi) gọi API bằng cookie của từng vai trò
 * (`page.request` dùng chung cookie với context). Mọi tên tạo ra đều có hậu tố uniq(...) để tránh đụng với tiến trình khác.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { APIResponse, Page } from '@playwright/test';
import { uniq } from './fixtures';

export type ApproverRole = 'staff' | 'chief' | 'director' | 'chairman';

export interface Cta {
  id: string;
  name: string;
  code: string;
}

export interface PartnerRow {
  id: string;
  code: string;
  name: string;
}

/* ============================ ngày & số ============================ */

/** Ngày hôm nay theo giờ Việt Nam, dạng YYYY-MM-DD. */
export function vnToday(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Cộng n tháng (kẹp cuối tháng) — cùng quy tắc với máy chủ (VD 31/01 + 1 tháng = 28/02). */
export function addMonthsIso(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

/** Cộng n ngày vào một ngày YYYY-MM-DD (tính theo UTC, không ảnh hưởng ngày lịch). */
export function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD → DD/MM/YYYY (định dạng gõ vào ô ngày trên UI). */
export function toDdmmyyyy(iso: string): string {
  const [y, m, dd] = iso.split('-');
  return `${dd}/${m}/${y}`;
}

/** Số tiền dạng chuỗi minor (VND) → chuỗi hiển thị giống formatMoney 'full' của web (VD 150.000.000). */
export function viGroup(minor: string | number | bigint): string {
  const s = String(minor).replace(/^-/, '');
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Tạo nội dung TSV (tab-separated) từ danh sách dòng. */
export function tsv(rows: string[][]): string {
  return rows.map((r) => r.join('\t')).join('\n');
}

/** Lý do đủ dài (≥ 20 ký tự) để người có quyền override chứng từ thiếu duyệt được. */
export const LONG_REASON = 'E2E: duyệt phục vụ kiểm thử khoản vay, chứng từ sẽ bổ sung sau';

/* ============================ API nền ============================ */

/** Gỡ lớp `{data: ...}` của envelope API nếu có. */
export function unwrap<T = any>(json: any): T {
  return (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
}

async function jsonOf(res: APIResponse, label: string): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok()) {
    const err = new Error(`${label} → HTTP ${res.status()}: ${body?.detail ?? body?.title ?? text.slice(0, 300)} [${body?.code ?? ''}]`);
    (err as Error & { problem?: unknown }).problem = body;
    throw err;
  }
  return body;
}

/**
 * Công ty CTA (id, tên) lấy từ phiên đăng nhập.
 * Đồng thời đặt phạm vi mặc định của tài khoản = CTA (prefs.default_scope): màn UI đọc phạm vi từ đây khi tải,
 * nên tránh bị lệch sang công ty khác do tiến trình khác đổi cùng tài khoản.
 */
export async function findCta(page: Page): Promise<Cta> {
  const me = unwrap<any>(await jsonOf(await page.request.get('/api/v1/me'), 'GET /me'));
  const c = (me.companies as { company_id: string; company_name: string; company_code: string }[]).find((x) => x.company_code === 'CTA');
  if (!c) throw new Error('Tài khoản không có công ty CTA');
  await page.request.patch('/api/v1/me/prefs', { data: { default_scope: c.company_id } }).catch(() => undefined);
  return { id: c.company_id, name: c.company_name, code: c.company_code };
}

/** Header phạm vi công ty (server đọc `x-company-scope`). */
export function scopeOf(cta: Cta): Record<string, string> {
  return { 'x-company-scope': cta.id };
}

/** Tài khoản NGÂN HÀNG (kind = bank, đang hoạt động) của CTA. */
export async function ctaBankAccount(page: Page, cta: Cta): Promise<string> {
  const body = unwrap<any>(await jsonOf(await page.request.get('/api/v1/bank-accounts', { headers: scopeOf(cta) }), 'GET /bank-accounts'));
  const items: any[] = body.items ?? body;
  const acc = items.find((a) => a.kind === 'bank' && a.company_id === cta.id && a.status === 'active');
  if (!acc) throw new Error('CTA không có tài khoản ngân hàng đang hoạt động');
  return String(acc._id);
}

/* ============================ đối tác ============================ */

async function createPartner(page: Page, cta: Cta, type: 'bank' | 'customer' | 'supplier', name: string): Promise<PartnerRow> {
  const body = unwrap<any>(
    await jsonOf(
      await page.request.post('/api/v1/partners', {
        headers: scopeOf(cta),
        data: { type, name, bank_name: type === 'bank' ? 'E2E Bank' : null, company_id: cta.id, request_id: randomUUID() },
      }),
      `POST /partners (${type})`,
    ),
  );
  const p = body.partner;
  return { id: String(p._id), code: String(p.code), name: String(p.name) };
}

/** Tạo một ngân hàng (đối tác loại Ngân hàng) mới trong CTA, tên duy nhất. */
export function createBank(page: Page, cta: Cta, label = 'NH E2E'): Promise<PartnerRow> {
  return createPartner(page, cta, 'bank', uniq(label));
}

/** Tạo một nhà cung cấp (đối tác chi cho R3 — không phải ngân hàng). */
export function createSupplier(page: Page, cta: Cta, label = 'NCC E2E'): Promise<PartnerRow> {
  return createPartner(page, cta, 'supplier', uniq(label));
}

/** Tạo một khách hàng (không phải ngân hàng) để kiểm tra chặn chọn sai loại. */
export function createCustomer(page: Page, cta: Cta, label = 'KH E2E'): Promise<PartnerRow> {
  return createPartner(page, cta, 'customer', uniq(label));
}

/* ============================ khoản vay (API) ============================ */

export interface LoanApi {
  _id: string;
  code: string;
  status: string;
  partner_id: string | null;
  bank_name: string;
  principal: { minor: string };
  credit_limit: { minor: string };
  interest_to_maturity: { minor: string };
  outstanding: { minor: string };
  repaid: { minor: string };
  repaid_interest: { minor: string };
  repaid_fee: { minor: string };
  disbursed: { minor: string };
  undisbursed: { minor: string };
  interest_rate: string;
  term_months: number | null;
  maturity_date: string;
  days_to_due: number;
  contract_no: string | null;
  collateral: string | null;
  responsible: string | null;
  note: string | null;
  origin: { kind: string; rule_code: string | null; run_id: string | null };
  warning: { level: number; tone: string; label: string; days_to_due: number } | null;
  disbursed_at: string | null;
  [k: string]: unknown;
}

export async function createLoanApi(page: Page, cta: Cta, body: Record<string, unknown>): Promise<{ _id: string; code: string }> {
  return unwrap(await jsonOf(await page.request.post('/api/v1/bank-debts', { headers: scopeOf(cta), data: { company_id: cta.id, ...body } }), 'POST /bank-debts'));
}

export async function getLoanApi(page: Page, cta: Cta, id: string): Promise<LoanApi & { chain: any; [k: string]: unknown }> {
  return unwrap(await jsonOf(await page.request.get(`/api/v1/bank-debts/${id}`, { headers: scopeOf(cta) }), `GET /bank-debts/${id}`));
}

export async function listLoansApi(page: Page, cta: Cta, params: Record<string, string> = {}): Promise<{ items: LoanApi[]; totals: any }> {
  return unwrap(await jsonOf(await page.request.get('/api/v1/bank-debts', { headers: scopeOf(cta), params }), 'GET /bank-debts'));
}

/** Chờ tới khi danh sách theo ngân hàng có khoản thoả điều kiện (khoản do quy tắc tự động tạo ra là bất đồng bộ). */
export async function waitForLoan(
  page: Page,
  cta: Cta,
  partnerId: string,
  pick: (l: LoanApi) => boolean,
  timeoutMs = 30_000,
): Promise<LoanApi> {
  const until = Date.now() + timeoutMs;
  let last: LoanApi[] = [];
  while (Date.now() < until) {
    last = (await listLoansApi(page, cta, { partner_id: partnerId })).items;
    const hit = last.find(pick);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Không thấy khoản vay phù hợp trong ${timeoutMs}ms (đang có: ${JSON.stringify(last.map((l) => [l.code, l.status, l.origin?.rule_code]))})`);
}

/* ============================ phiếu (API) ============================ */

export interface VoucherApi {
  _id: string;
  code: string;
  status: string;
  version: number;
  kind: string;
  approval?: { steps: { order: number; role: string; state: string }[] };
  [k: string]: unknown;
}

export async function getVoucherApi(page: Page, cta: Cta, id: string): Promise<VoucherApi> {
  return unwrap(await jsonOf(await page.request.get(`/api/v1/documents/${id}`, { headers: scopeOf(cta) }), `GET /documents/${id}`));
}

/** Tạo phiếu nháp (spend/income/rollover). `body` theo hợp đồng documentCreateBody. */
export async function createVoucherApi(page: Page, cta: Cta, body: Record<string, unknown>): Promise<VoucherApi> {
  return unwrap(
    await jsonOf(
      await page.request.post('/api/v1/documents', {
        headers: scopeOf(cta),
        data: { company_id: cta.id, ...body },
      }),
      'POST /documents',
    ),
  );
}

/** Thực hiện một hành động workflow theo phiên bản hiện tại của phiếu (If-Match). */
export async function transitionApi(
  page: Page,
  cta: Cta,
  id: string,
  action: 'submit' | 'approve' | 'pay' | 'cancel',
  extra: Record<string, unknown> = {},
): Promise<any> {
  const cur = await getVoucherApi(page, cta, id);
  return unwrap(
    await jsonOf(
      await page.request.post(`/api/v1/documents/${id}/transition`, {
        headers: scopeOf(cta),
        data: { action, if_match: cur.version, request_id: randomUUID(), ...(action === 'approve' ? { reason: LONG_REASON } : {}), ...extra },
      }),
      `POST /documents/${id}/transition (${action})`,
    ),
  );
}

/**
 * Đưa phiếu qua chuỗi duyệt: mỗi bước "current" được duyệt bởi vai trò tương ứng
 * (KTT → GĐ → Chủ tịch theo ma trận CTA; các bước trống được server bỏ qua / đẩy lên).
 * Dừng khi phiếu không còn ở trạng thái chờ duyệt.
 */
export async function approveChain(pages: Record<ApproverRole, Page>, cta: Cta, id: string): Promise<VoucherApi> {
  const roleToPage: Record<string, ApproverRole> = {
    chief_accountant: 'chief',
    deputy_director: 'director',
    director: 'director',
    deputy_chairman: 'chairman',
    chairman: 'chairman',
  };
  for (let i = 0; i < 8; i++) {
    const doc = await getVoucherApi(pages.staff, cta, id);
    if (!String(doc.status).startsWith('pending')) return doc;
    const current = doc.approval?.steps.find((s) => s.state === 'current');
    if (!current) throw new Error(`Phiếu ${doc.code} đang chờ duyệt nhưng không có bước current`);
    const who = roleToPage[current.role];
    if (!who) throw new Error(`Chưa có người duyệt cho vai trò ${current.role}`);
    await transitionApi(pages[who], cta, id, 'approve');
  }
  throw new Error('Chuỗi duyệt không kết thúc sau 8 bước');
}

/**
 * Đính kèm chứng từ UNC (loại bank_order) vào phiếu chi: prepare → PUT nội dung (storage dev = fs) → confirm.
 * Máy chủ yêu cầu UNC khi đánh dấu phiếu chi đã thi hành (FG-VAL-001 "chứng từ UNC").
 */
export async function attachUnc(page: Page, cta: Cta, docId: string): Promise<void> {
  // PDF tối thiểu (storage fs kiểm chữ ký tệp: chỉ nhận PDF/ảnh thật)
  const bytes = Buffer.from(`%PDF-1.4
% ${uniq('UNC E2E')}
1 0 obj << >> endobj
trailer << >>
%%EOF
`, 'utf-8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const cur = await getVoucherApi(page, cta, docId);
  const prep = unwrap<any>(
    await jsonOf(
      await page.request.post(`/api/v1/documents/${docId}/attachments/prepare`, {
        headers: scopeOf(cta),
        data: { filename: 'UNC-e2e.pdf', size: bytes.length, mime: 'application/pdf', sha256, type: 'bank_order', if_match: cur.version, request_id: randomUUID() },
      }),
      'POST attachments/prepare (UNC)',
    ),
  );
  const put = await page.request.put(String(prep.upload_url), { data: bytes, headers: { 'content-type': 'application/pdf' } });
  if (!put.ok()) throw new Error(`Tải UNC lên storage thất bại: HTTP ${put.status()}`);
  const cur2 = await getVoucherApi(page, cta, docId);
  await jsonOf(
    await page.request.post(`/api/v1/documents/${docId}/attachments/confirm`, {
      headers: scopeOf(cta),
      data: { attachment_id: prep.attachment_id, if_match: cur2.version, request_id: randomUUID() },
    }),
    'POST attachments/confirm (UNC)',
  );
}

/** Thực thi thanh toán phiếu chi (kế toán viên có payment:mark). Phiếu chi cần UNC + số tham chiếu NH. */
export async function payVoucherApi(page: Page, cta: Cta, id: string, paidAt = vnToday()): Promise<any> {
  const doc = await getVoucherApi(page, cta, id);
  const hasUnc = ((doc as any).attachments ?? []).some((a: { type?: string }) => a.type === 'bank_order');
  if (!hasUnc) await attachUnc(page, cta, id);
  return transitionApi(page, cta, id, 'pay', { execution: { paid_at: paidAt, bank_ref: uniq('UNC') } });
}

/** Phiếu chi chuẩn để kiểm thử: nguồn = tài khoản ngân hàng CTA, đối tác = ngân hàng cho vay. */
export function spendBody(opts: { partnerId: string; accountId: string; amountMinor: string; title?: string; options?: Record<string, unknown> }) {
  return {
    kind: 'spend',
    title: opts.title ?? uniq('Chi trả nợ NH'),
    purpose: 'E2E: thanh toán cho ngân hàng theo khoản vay',
    partner_id: opts.partnerId,
    amount: { amount_minor: opts.amountMinor, currency: 'VND', decimals: 0 },
    source: { fund: 'bank', account_id: opts.accountId, group_managed: false },
    planned_date: `${vnToday()}T09:00`,
    ...(opts.options ? { options: opts.options } : {}),
  };
}

/** Phiếu thu chuẩn: đối tác = ngân hàng, tiền vào tài khoản ngân hàng CTA. */
export function incomeBody(opts: { partnerId: string; accountId: string; amountMinor: string; title?: string; options?: Record<string, unknown> }) {
  return {
    kind: 'income',
    title: opts.title ?? uniq('Thu giải ngân NH'),
    purpose: 'E2E: tiền giải ngân khoản vay ngân hàng',
    partner_id: opts.partnerId,
    amount: { amount_minor: opts.amountMinor, currency: 'VND', decimals: 0 },
    source: { fund: 'bank', account_id: opts.accountId, group_managed: false },
    planned_date: `${vnToday()}T09:00`,
    ...(opts.options ? { options: opts.options } : {}),
  };
}

/* ============================ UI helpers ============================ */

/**
 * Ô nhập gắn với nhãn (FgField không gắn htmlFor): tìm nhãn chứa chữ, lấy input trong cùng khối.
 * `index` chọn input thứ n trong khối (vd. ô tìm trong antd Select).
 */
export function fieldInput(page: Page, label: string | RegExp, selector = 'input, textarea') {
  const lbl = page.locator('label').filter({ hasText: label }).first();
  return lbl.locator('xpath=..').locator(selector).first();
}

/** Khối nội dung (card/section) có tiêu đề chứa chữ — dùng để khoanh vùng assert. */
export function sectionByTitle(page: Page, title: string | RegExp) {
  return page
    .locator('h1, h2, h3, .fg-card-title, .fg-page-title, div')
    .filter({ hasText: title })
    .locator('xpath=ancestor-or-self::*[contains(@class,"fg-card") or self::section][1]')
    .first();
}

/** Nhập ngày vào antd DatePicker (định dạng DD/MM/YYYY). */
export async function typeDate(page: Page, label: string | RegExp, iso: string): Promise<void> {
  const input = fieldInput(page, label);
  await input.click();
  await input.fill('');
  await input.fill(toDdmmyyyy(iso));
  await input.press('Enter');
  await page.keyboard.press('Escape').catch(() => undefined);
}

/** Đăng ký phản hồi giả (chỉ dùng cho chẩn đoán có đánh dấu rõ) — sửa một trường mảng null trong chi tiết khoản vay. */
export async function patchLoanDetailChain(page: Page, loanId: string): Promise<void> {
  const re = new RegExp(`/api/v1/bank-debts/${loanId}(\\?.*)?$`);
  await page.route(re, async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    const d = json.data ?? json;
    d.chain = d.chain ?? {};
    d.chain.funded_by = d.funded_by_links ?? [];
    d.chain.disbursements = d.disbursement_links ?? [];
    await route.fulfill({ response: res, json: json.data ? { data: d } : d });
  });
}

/** Chuẩn hoá số hiển thị (bỏ dấu chấm/khoảng trắng) để so sánh nội dung ô tiền. */
export function digitsOf(text: string): string {
  return text.replace(/[^\d]/g, '');
}

/** GET tuỳ ý trong phạm vi công ty CTA (đọc envelope {data}). */
export async function apiGet(page: Page, cta: Cta, path: string, params: Record<string, string> = {}): Promise<any> {
  return unwrap(await jsonOf(await page.request.get(`/api/v1/${path}`, { headers: scopeOf(cta), params }), `GET ${path}`));
}

/** POST tuỳ ý; trả về JSON gốc và HTTP status (không ném lỗi — dùng cho kiểm tra lỗi có chủ đích). */
export async function apiPostRaw(page: Page, cta: Cta, path: string, data: unknown): Promise<{ status: number; body: any }> {
  const res = await page.request.post(`/api/v1/${path}`, { headers: scopeOf(cta), data });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: res.status(), body };
}

/** POST tuỳ ý, ném lỗi nếu HTTP không thành công (dùng cho bước thiết lập). */
export async function apiPost(page: Page, cta: Cta, path: string, data: unknown): Promise<any> {
  return unwrap(await jsonOf(await page.request.post(`/api/v1/${path}`, { headers: scopeOf(cta), data }), `POST ${path}`));
}

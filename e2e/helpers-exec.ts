/**
 * Tiện ích cho spec "exec" (điều hành & quản trị, v2/v2.md §4.2, §11–13).
 *
 * - `apiAs(role)`: APIRequestContext đã đăng nhập (cookie phiên) — dùng để dựng dữ liệu test và đối chiếu số liệu.
 * - `watch(page)`: ghi nhận pageerror, 5xx/403/404 của /api/, lỗi console (lọc nhiễu antd/React).
 * - Dữ liệu test luôn có hậu tố duy nhất (`uniq`) vì các tiến trình khác dùng chung DB.
 */
import { expect, request, type APIRequestContext, type ConsoleMessage, type Locator, type Page, type Response } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PASSWORD, USERS, uniq, type Role } from './fixtures';

export const BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:5139';

/* ============================ phiên API ============================ */

const openContexts: APIRequestContext[] = [];

/** Đăng nhập API theo vai trò (cookie `fgs` nằm trong cookie jar của context). */
export async function apiAs(role: Role): Promise<APIRequestContext> {
  // timeout rộng: máy chạy nhiều tiến trình e2e song song (đăng nhập đôi khi >15 giây)
  const ctx = await request.newContext({ baseURL: BASE_URL, timeout: 60_000 });
  openContexts.push(ctx);
  // API có thể đang khởi động lại (node --watch sau thay đổi mã của tiến trình khác): thử lại khi 5xx / lỗi mạng
  let lastStatus = 0;
  let lastError = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await ctx.post('/api/v1/auth/login', { data: { email: USERS[role], password: PASSWORD }, timeout: 60_000 });
      lastStatus = res.status();
      if (res.ok()) return ctx;
      if (res.status() < 500) break;
    } catch (e) {
      lastError = String((e as Error).message ?? e).slice(0, 200);
    }
    await new Promise((r) => setTimeout(r, 4_000));
  }
  throw new Error(`đăng nhập API ${role} thất bại: HTTP ${lastStatus}${lastError ? ` (${lastError})` : ''}`);
}

export async function closeApiContexts(): Promise<void> {
  for (const c of openContexts.splice(0)) await c.dispose().catch(() => undefined);
}

/** Gọi API `/api/v1{path}`; ném lỗi kèm nội dung nếu HTTP ≠ 2xx. `scope` = id công ty (x-company-scope). */
export async function api<T = any>(
  ctx: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { scope?: string; data?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.scope) headers['x-company-scope'] = opts.scope;
  // GET được thử lại khi API đang khởi động lại (502/503/504); ghi (POST/PATCH) không thử lại để tránh trùng dữ liệu
  const attempts = method === 'GET' ? 4 : 1;
  let res = await ctx.fetch(`/api/v1${path}`, { method, headers, data: opts.data, timeout: 60_000 });
  for (let i = 1; i < attempts && [502, 503, 504].includes(res.status()); i++) {
    await new Promise((r) => setTimeout(r, 4_000));
    res = await ctx.fetch(`/api/v1${path}`, { method, headers, data: opts.data, timeout: 60_000 });
  }
  const text = await res.text();
  if (!res.ok()) throw new Error(`${method} ${path} → HTTP ${res.status()}: ${text.slice(0, 600)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Ngày nghiệp vụ hôm nay (giờ Việt Nam), YYYY-MM-DD. */
export function vnToday(offsetDays = 0): string {
  const d = new Date(Date.now() + 7 * 3600_000 + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/* ============================ theo dõi lỗi trang ============================ */

export interface Watch {
  /** Lỗi JS chưa bắt (pageerror). Bất kỳ phần tử nào ⇒ lỗi. */
  pageErrors: string[];
  /** Phản hồi HTTP 5xx của /api/. Bất kỳ phần tử nào ⇒ lỗi. */
  serverErrors: string[];
  /** 403 của /api/ (ghi nhận để rà soát RBAC, không tự coi là lỗi). */
  forbidden: string[];
  /** 404 của /api/ (lời gọi tới endpoint không tồn tại ⇒ cần xem xét). */
  notFound: string[];
  /** console.error (đã lọc cảnh báo deprecate của antd / React DevTools). */
  consoleErrors: string[];
  /** Tài nguyên tĩnh lỗi (favicon…), chỉ để tham khảo. */
  assetErrors: string[];
}

const CONSOLE_NOISE = [/\[antd: /, /DevTools/, /Download the React/, /Failed to load resource/];

export function watch(page: Page): Watch {
  const w: Watch = { pageErrors: [], serverErrors: [], forbidden: [], notFound: [], consoleErrors: [], assetErrors: [] };
  page.on('pageerror', (e: Error) => w.pageErrors.push(`${e.name}: ${e.message}`));
  page.on('response', (r: Response) => {
    const url = new URL(r.url());
    const s = r.status();
    if (url.pathname.startsWith('/api/')) {
      const label = `${s} ${r.request().method()} ${url.pathname}${url.search}`;
      if (s >= 500) w.serverErrors.push(label);
      else if (s === 403) w.forbidden.push(label);
      else if (s === 404) w.notFound.push(label);
    } else if (s >= 400) {
      w.assetErrors.push(`${s} ${url.pathname}`);
    }
  });
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (CONSOLE_NOISE.some((re) => re.test(t))) return;
    w.consoleErrors.push(t.slice(0, 300));
  });
  return w;
}

/** Điểm đánh dấu để chỉ xét lỗi phát sinh sau thời điểm này. */
export function mark(w: Watch): { pe: number; se: number } {
  return { pe: w.pageErrors.length, se: w.serverErrors.length };
}
export function since(w: Watch, m: { pe: number; se: number }): { pageErrors: string[]; serverErrors: string[] } {
  return { pageErrors: w.pageErrors.slice(m.pe), serverErrors: w.serverErrors.slice(m.se) };
}

/** Mở đường dẫn và chờ dữ liệu tải xong (networkidle có giới hạn, app có polling). */
export async function go(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
}

/** Văn bản hiển thị của trang (body). */
export async function pageText(page: Page): Promise<string> {
  return (await page.locator('body').innerText().catch(() => '')) ?? '';
}

/** Màn sập (ErrorBoundary) hoặc thông báo lỗi toàn trang. */
export const CRASH_TEXT = 'Hệ thống đang gặp sự cố';

/* ============================ chọn trong antd ============================ */

/**
 * Chọn một mục trong dropdown antd theo nhãn (khớp một phần).
 * `search`: gõ vào ô tìm (select có showSearch) trước khi chọn — dùng khi danh sách dài / phân trang.
 */
export async function pickOption(page: Page, trigger: Locator, label: string | RegExp, search?: string): Promise<void> {
  await trigger.click();
  if (search) await page.keyboard.type(search);
  const option = page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')
    .filter({ hasText: label })
    .first();
  await option.waitFor({ state: 'visible', timeout: 15_000 });
  await option.click();
}

/** Đọc toàn bộ mục của dropdown antd đang mở (cuộn danh sách ảo để lấy đủ). */
export async function readOpenOptions(page: Page): Promise<string[]> {
  const seen = new Set<string>();
  const holder = page
    .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-list-holder, .ant-select-dropdown:not(.ant-select-dropdown-hidden) .rc-virtual-list-holder')
    .first();
  for (let i = 0; i < 40; i++) {
    for (const t of await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').allInnerTexts()) {
      seen.add(t.trim());
    }
    const atEnd = await holder
      .evaluate((el) => {
        const before = el.scrollTop;
        el.scrollTop = before + el.clientHeight;
        return el.scrollTop === before;
      })
      .catch(() => true);
    if (atEnd) break;
    await page.waitForTimeout(120);
  }
  return [...seen];
}

/* ============================ dữ liệu dựng sẵn ============================ */

export interface Fixture {
  chief: APIRequestContext;
  director: APIRequestContext;
  chairman: APIRequestContext;
  staff: APIRequestContext;
  cos: Record<string, string>;
  cta: string;
  bankPartner: { _id: string; name: string };
  customerPartner: { _id: string; name: string } | null;
  account: { _id: string; label: string };
  /** Khoản vay đã giải ngân (active), có lịch trả nợ trong 60–90 ngày tới. */
  loan: { _id: string; code: string; principal: string };
  /** Phiếu thu đi vay (R2) và khoản vay chờ giải ngân do quy tắc R2 sinh ra. */
  borrowDoc: { _id: string; code: string };
  pendingLoan: { _id: string; code: string; principal: string } | null;
  r2Run: { _id: string; status: string; error: string | null } | null;
}

let fixturePromise: Promise<Fixture> | null = null;

/** Dựng dữ liệu một lần cho cả file (idempotent theo hậu tố uniq). */
export function buildFixture(): Promise<Fixture> {
  fixturePromise ??= doBuildFixture();
  return fixturePromise;
}

async function doBuildFixture(): Promise<Fixture> {
  const chief = await apiAs('chief');
  const director = await apiAs('director');
  const chairman = await apiAs('chairman');
  const staff = await apiAs('staff');

  const me = await api<any>(chief, 'GET', '/me');
  const cos: Record<string, string> = Object.fromEntries(
    ((me.data?.companies ?? []) as { company_code: string; company_id: string }[]).map((c) => [c.company_code, c.company_id]),
  );
  const cta = cos.CTA;
  if (!cta) throw new Error('Không thấy công ty CTA trong /me của KTT');

  // Đối tác Ngân hàng riêng cho lượt test (tên duy nhất): tên đối tác có thể trùng giữa các dữ liệu test khác.
  const bankName = uniq('exec NH cho vay');
  const createdPartner = await api<any>(chief, 'POST', '/partners', {
    scope: cta,
    data: { company_id: cta, type: 'bank', name: bankName, bank_name: 'Ngân hàng kiểm thử exec', status: 'active', request_id: randomUUID() },
  });
  // Phản hồi: { data: { partner, warnings } }
  const bankId = String(createdPartner.data?.partner?._id ?? createdPartner.data?._id ?? '');
  if (!bankId) throw new Error(`Tạo đối tác Ngân hàng không trả về id: ${JSON.stringify(createdPartner).slice(0, 200)}`);
  const bankPartner = { _id: bankId, name: bankName, status: 'active' };

  const customers = (await api<any>(chief, 'GET', `/partners?company_id=${cta}&type=customer&limit=50`, { scope: cta })).items as {
    _id: string;
    name: string;
    status: string;
  }[];
  const customerPartner = customers.find((p) => p.status === 'active') ?? null;

  const accounts = (await api<any>(chief, 'GET', `/bank-accounts?company_id=${cta}`, { scope: cta })).items as {
    _id: string;
    label: string;
    kind: string;
    company_id: string;
    status: string;
  }[];
  const account = accounts.find((a) => a.kind === 'bank' && a.company_id === cta && a.status === 'active');
  if (!account) throw new Error('CTA chưa có tài khoản ngân hàng đang hoạt động');

  // Khoản vay đã giải ngân hôm nay, trả góp hàng tháng gốc đều: có kỳ trả trong 60/90 ngày tới.
  const loanRes = await api<any>(chief, 'POST', '/bank-debts', {
    scope: cta,
    data: {
      partner_id: bankPartner._id,
      amount: { amount_minor: '120000000', currency: 'VND' },
      disbursed_date: vnToday(),
      maturity_date: vnToday(180),
      interest_rate: '9.5',
      term_months: 6,
      payment_frequency: 'monthly',
      repayment_method: 'equal_principal',
      note: uniq('exec-loan'),
      request_id: randomUUID(),
    },
  });
  const loanId = String(loanRes.data?._id ?? loanRes.data?.id ?? '');
  const loanDetail = await api<any>(chief, 'GET', `/bank-debts/${loanId}`, { scope: cta });
  const loan = { _id: loanId, code: String(loanDetail.data.code), principal: String(loanDetail.data.principal?.minor ?? '120000000') };

  // Phiếu thu đi vay (R2): bên nộp là ngân hàng cho vay, khoản vay tạo khi lưu phiếu (chờ giải ngân).
  const title = uniq('exec phiếu thu vay');
  const docRes = await api<any>(chief, 'POST', '/documents', {
    scope: cta,
    data: {
      kind: 'income',
      company_id: cta,
      title,
      purpose: `Giải ngân ${title}`,
      amount: { amount_minor: '50000000', currency: 'VND' },
      source: { fund: 'bank', account_id: account._id, group_managed: false },
      planned_date: `${vnToday(10)}T10:00`,
      partner_id: bankPartner._id,
      priority: 'normal',
      options: {
        loan: {
          kind: 'borrow',
          mode: 'new',
          lender_partner_id: bankPartner._id,
          amount_minor: '50000000',
          terms: { contract_no: uniq('HĐTD'), interest_rate: '9.5', term_months: 12, repayment_period: 'maturity', repayment_method: 'interest_only' },
        },
      },
      request_id: randomUUID(),
    },
  });
  const borrowId = String(docRes.data?._id ?? docRes.data?.id ?? '');
  const borrowCode = String(docRes.data?.code ?? '');
  const run = await waitForRun(chief, cta, borrowId, 'R2', 60_000);
  // Khoản vay sinh ra lấy từ đầu ra của bước create_loan (generated[] có thể chứa null — xem spec).
  let pendingLoan: Fixture['pendingLoan'] = null;
  const created = run?.steps?.find((s: { name: string }) => s.name === 'create_loan')?.output as
    | { id?: string; code?: string | null }
    | null
    | undefined;
  if (created?.id) pendingLoan = { _id: String(created.id), code: String(created.code ?? ''), principal: '50000000' };

  return {
    chief,
    director,
    chairman,
    staff,
    cos,
    cta,
    bankPartner: { _id: bankPartner._id, name: bankPartner.name },
    customerPartner: customerPartner ? { _id: customerPartner._id, name: customerPartner.name } : null,
    account: { _id: account._id, label: account.label },
    loan,
    borrowDoc: { _id: borrowId, code: borrowCode },
    pendingLoan,
    r2Run: run ? { _id: String(run._id), status: String(run.status), error: run.error ?? null } : null,
  };
}

/** Chờ lượt tự động của một phiếu nguồn kết thúc (done/failed). Trả null nếu hết giờ. */
export async function waitForRun(
  ctx: APIRequestContext,
  scope: string,
  sourceId: string,
  rule: string,
  timeoutMs = 30_000,
): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // lỗi tạm (API đang khởi động lại) không dừng việc chờ: thử lại tới khi hết giờ
    let r: any = null;
    try {
      r = await api<any>(ctx, 'GET', `/automation/runs/by-source?source_type=document&source_id=${sourceId}`, { scope });
    } catch {
      r = null;
    }
    const hit = (r?.data ?? []).find((x: { rule_code: string; status: string }) => x.rule_code === rule && (x.status === 'done' || x.status === 'failed'));
    if (hit) return hit;
    await new Promise((res) => setTimeout(res, 1500));
  }
  return null;
}

/**
 * Lập phiếu thu đi vay MỚI (R2) và chờ lượt tự động của nó. Dùng khi cần tìm lượt R2 trong bảng
 * "Lượt chạy": API chỉ trả 100 lượt gần nhất, nên phiếu dựng sẵn từ đầu lượt có thể đã bị đẩy ra ngoài.
 */
export async function createBorrowReceipt(
  f: { chief: APIRequestContext; cta: string; bankPartner: { _id: string }; account: { _id: string } },
  label: string,
): Promise<{ id: string; code: string; run: any | null; loan: { id: string; code: string } | null }> {
  const title = uniq(label);
  const docRes = await api<any>(f.chief, 'POST', '/documents', {
    scope: f.cta,
    data: {
      kind: 'income',
      company_id: f.cta,
      title,
      purpose: `Giải ngân ${title}`,
      amount: { amount_minor: '50000000', currency: 'VND' },
      source: { fund: 'bank', account_id: f.account._id, group_managed: false },
      planned_date: `${vnToday(10)}T10:00`,
      partner_id: f.bankPartner._id,
      priority: 'normal',
      options: {
        loan: {
          kind: 'borrow',
          mode: 'new',
          lender_partner_id: f.bankPartner._id,
          amount_minor: '50000000',
          terms: { contract_no: uniq('HĐTD'), interest_rate: '9.5', term_months: 12, repayment_period: 'maturity', repayment_method: 'interest_only' },
        },
      },
      request_id: randomUUID(),
    },
  });
  const id = String(docRes.data?._id ?? docRes.data?.id ?? '');
  const code = String(docRes.data?.code ?? '');
  const run = await waitForRun(f.chief, f.cta, id, 'R2', 60_000);
  const created = run?.steps?.find((s: { name: string }) => s.name === 'create_loan')?.output as { id?: string; code?: string | null } | null | undefined;
  const loan = created?.id ? { id: String(created.id), code: String(created.code ?? '') } : null;
  return { id, code, run, loan };
}

export { expect };

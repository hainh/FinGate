/**
 * Hàm dùng chung cho `e2e/v2-auto-r3-r1.spec.ts` — R3 (vay ngân hàng để chi), R1 (chuyển nội bộ), R6 (huỷ nguồn).
 * Đặc tả: v2/v2.md §11.5, §11.6, §11.3, US-AUTO-03..06.
 *
 * Quy ước: mọi dữ liệu tạo ra đều có hậu tố duy nhất (`uniq`), không xoá gì. Gọi API bằng `page.request`
 * (cùng cookie phiên của trang đăng nhập) với header `x-company-scope` như web đang làm.
 */
import { createHash, randomUUID } from 'node:crypto';
import { expect, type APIResponse, type Locator, type Page } from '@playwright/test';

export const API = '/api/v1';
export type Res = { status: number; ok: boolean; body: any };
export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

/**
 * Gọi API. `scope` = company_id hoặc `all` (gửi thành header `x-company-scope`). Không ném lỗi khi 4xx/5xx.
 * GET chỉ đọc nên được thử lại (tối đa 6 lần, cách 5 giây) khi API đang khởi động lại: 502/503/504 hoặc lỗi mạng.
 */
export async function req(page: Page, method: Method, path: string, opts: { data?: unknown; scope?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.scope) headers['x-company-scope'] = opts.scope;
  const maxTries = method === 'GET' ? 6 : 1;
  for (let attempt = 1; ; attempt++) {
    let res: APIResponse;
    try {
      res = await page.request.fetch(`${API}${path}`, { method, headers, data: opts.data as never, failOnStatusCode: false, timeout: 30_000 });
    } catch (err) {
      if (attempt >= maxTries) throw err;
      await sleep(5000);
      continue;
    }
    if (attempt < maxTries && [502, 503, 504].includes(res.status())) {
      await sleep(5000);
      continue;
    }
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: res.status(), ok: res.ok(), body };
  }
}

/** Lấy phần `data` của envelope `{data}`; nếu không có thì trả thân nguyên. */
export function dataOf<T = any>(r: Res): T {
  const b = r.body as Record<string, unknown> | null;
  return (b && typeof b === 'object' && 'data' in b ? b.data : b) as T;
}

/** Ném lỗi kèm mã và thân phản hồi khi không thành công. */
export function must(r: Res, what: string): Res {
  if (!r.ok) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 700)}`);
  return r;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ngày hôm nay theo giờ Việt Nam (YYYY-MM-DD). */
export function vnToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function digits(n: number): string {
  let s = String(1 + Math.floor(Math.random() * 9));
  while (s.length < n) s += String(Math.floor(Math.random() * 10));
  return s;
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Mã company → id (chủ tịch thấy mọi công ty). */
export async function companyIdsByCode(chairman: Page): Promise<Record<string, string>> {
  const r = must(await req(chairman, 'GET', '/companies', { scope: 'all' }), 'danh sách công ty');
  const items = dataOf<{ items: { _id: string; code: string }[] }>(r).items;
  return Object.fromEntries(items.map((c) => [c.code, c._id]));
}

/** Tạo đối tác (bank | supplier | customer) trong công ty. Trả về id. */
export async function createPartner(page: Page, companyId: string, type: 'bank' | 'supplier' | 'customer', name: string): Promise<string> {
  const data: Record<string, unknown> = { type, name, company_id: companyId, status: 'active', request_id: randomUUID() };
  if (type === 'bank') {
    data.bank_name = 'BIDV';
    data.account_number = digits(10);
  }
  const r = must(await req(page, 'POST', '/partners', { scope: companyId, data }), `tạo đối tác ${name}`);
  const d = dataOf<{ partner?: { _id?: string }; _id?: string }>(r);
  const id = d.partner?._id ?? d._id;
  if (!id) throw new Error(`tạo đối tác ${name}: không có _id trong phản hồi ${JSON.stringify(r.body).slice(0, 300)}`);
  return String(id);
}

/**
 * Tạo tài khoản tiền loại ngân hàng cho công ty (số dư ban đầu = 0). Trả về id.
 * `label` là TÊN tài khoản (account_name, duy nhất). `bankName` mặc định "BIDV" để nhiều TK cùng ngân hàng: ô chọn
 * phải hiện tên TK mới phân biệt được (v2 — mỗi mục có tên tài khoản).
 */
export async function createBankAccount(page: Page, companyId: string, label: string, bankName = 'BIDV'): Promise<string> {
  const data = {
    company_id: companyId,
    is_group: false,
    bank_name: bankName,
    account_name: label,
    account_number: digits(12),
    currency: 'VND',
    kind: 'bank',
    status: 'active',
    min_balance_minor: '0',
    show_on_dashboard: true,
    request_id: randomUUID(),
  };
  const r = must(await req(page, 'POST', '/bank-accounts', { scope: companyId, data }), `tạo TK ${label}`);
  return String(dataOf(r)._id);
}

/** Đổi trạng thái tài khoản (frozen/closed/active). */
export async function setAccountStatus(page: Page, companyId: string, accountId: string, status: 'active' | 'frozen' | 'closed'): Promise<Res> {
  return req(page, 'PATCH', `/bank-accounts/${accountId}/status`, { scope: companyId, data: { status } });
}

/** Số dư hiện tại của một tài khoản (đọc từ danh sách tài khoản của công ty). */
export async function balanceOf(page: Page, companyId: string, accountId: string): Promise<bigint> {
  const r = must(await req(page, 'GET', '/bank-accounts', { scope: companyId }), 'danh sách TK');
  const items = dataOf<{ items: { _id: string; balance?: { amount_minor?: unknown; minor?: unknown } }[] }>(r).items ?? [];
  const it = items.find((i) => String(i._id) === accountId);
  const m = it?.balance;
  const raw = m?.amount_minor ?? m?.minor ?? 0;
  return BigInt(String(raw));
}

/**
 * Bút toán của MỘT phiếu trên một tài khoản (theo mã phiếu): chiều và số tiền. Dùng thay cho chênh lệch số dư khi
 * tài khoản có thể bị ghi đồng thời bởi lượt test khác (số dư chung không tách được nguồn thay đổi).
 */
export async function entriesOfDoc(page: Page, companyId: string, accountId: string, docCode: string): Promise<{ direction: string; amount: string }[]> {
  const r = dataOf<{ items: any[] }>(must(await req(page, 'GET', `/bank-accounts/${accountId}/transactions?limit=2000`, { scope: companyId }), 'bút toán tài khoản'));
  return (r.items ?? [])
    .filter((x) => JSON.stringify(x).includes(docCode))
    .map((x) => ({ direction: String(x.direction), amount: String(x.amount?.minor ?? '') }));
}

export interface LoanParams {
  lenderId: string;
  receiveAccountId: string;
  /** Bỏ trống ⇒ số tiền vay = số tiền phiếu chi (đi theo số đã chốt). */
  amountMinor?: string | null;
  terms?: Record<string, unknown> | null;
}

export interface SpendParams {
  companyId: string;
  partnerId: string;
  amountMinor: string;
  sourceAccountId: string;
  purpose: string;
  loan?: LoanParams | null;
  transferTarget?: { companyId: string; accountId: string | null } | null;
  /** Header phạm vi khi tạo (mặc định = công ty của phiếu). Chuyển nội bộ sang công ty khác cần `all` (chủ tịch). */
  scope?: string;
}

/** Tạo phiếu chi (nháp) đúng dạng body web gửi (`documentCreateBody`). */
export async function createSpend(page: Page, p: SpendParams): Promise<{ id: string; version: number }> {
  const loan = p.loan
    ? {
        kind: 'fund',
        mode: 'new',
        lender_partner_id: p.loan.lenderId,
        receive_account_id: p.loan.receiveAccountId,
        amount_minor: p.loan.amountMinor ?? null,
        existing_loan_id: null,
        terms: p.loan.terms ?? null,
      }
    : null;
  const body = {
    kind: 'spend',
    company_id: p.companyId,
    title: p.purpose.slice(0, 120),
    purpose: p.purpose,
    partner_id: p.partnerId,
    amount: { amount_minor: p.amountMinor, currency: 'VND' },
    source: { fund: 'bank', account_id: p.sourceAccountId, group_managed: false },
    planned_date: `${vnToday()}T17:00`,
    priority: 'normal',
    budget: { in_plan: true },
    options: { loan },
    transfer_target: p.transferTarget ? { company_id: p.transferTarget.companyId, account_id: p.transferTarget.accountId } : null,
    tag_ids: [],
    request_id: randomUUID(),
  };
  const r = must(await req(page, 'POST', '/documents', { scope: p.scope ?? p.companyId, data: body }), `tạo phiếu chi ${p.purpose}`);
  const d = dataOf<{ _id: string; version: number }>(r);
  return { id: String(d._id), version: Number(d.version ?? 1) };
}

export async function getDoc(page: Page, companyId: string, id: string): Promise<any> {
  return dataOf(must(await req(page, 'GET', `/documents/${id}`, { scope: companyId }), `chi tiết phiếu ${id}`));
}

/** Gửi một hành động workflow (submit/approve/approve_with_reason/pay/cancel…), tự lấy `if_match` mới nhất. */
export async function transition(page: Page, companyId: string, id: string, action: string, extra: Record<string, unknown> = {}): Promise<Res> {
  const doc = await getDoc(page, companyId, id);
  return req(page, 'POST', `/documents/${id}/transition`, {
    scope: companyId,
    data: { action, if_match: doc.version, request_id: randomUUID(), ...extra },
  });
}

/** Vai trò người duyệt theo bước → trang đăng nhập tương ứng. */
export interface Approvers {
  chief: Page;
  director: Page;
  chairman: Page;
}

const ROLE_TO_APPROVER: Record<string, keyof Approvers> = {
  chief_accountant: 'chief',
  director: 'director',
  deputy_director: 'director',
  chairman: 'chairman',
  deputy_chairman: 'chairman',
};

/**
 * Duyệt tới khi phiếu `approved`: mỗi lượt lấy bước `current`, gọi đúng người (theo vai trò bước).
 * `amountAt`: đổi số tiền khi duyệt ở một vai trò (vd `{director: '4500000'}`).
 * Trả về chi tiết phiếu sau cùng. Bước đầu tiên có thể đã tự duyệt khi người lập giữ bước đó.
 */
export async function approveToFinal(
  approvers: Approvers,
  companyId: string,
  id: string,
  opts: { amountAt?: Partial<Record<string, string>>; stopAtRole?: string } = {},
): Promise<any> {
  for (let guard = 0; guard < 8; guard++) {
    const doc = await getDoc(approvers.chief, companyId, id);
    if (doc.status === 'approved' || doc.status === 'paid') return doc;
    if (opts.stopAtRole && doc.approval?.steps?.find((s: any) => s.state === 'current')?.role === opts.stopAtRole) return doc;
    const cur = (doc.approval?.steps ?? []).find((s: any) => s.state === 'current');
    if (!cur) throw new Error(`Phiếu ${doc.code} không còn bước nào chờ (status=${doc.status})`);
    const key = ROLE_TO_APPROVER[cur.role];
    if (!key) throw new Error(`Chưa có người duyệt cho vai trò ${cur.role}`);
    const extra: Record<string, unknown> = {};
    const amt = opts.amountAt?.[cur.role];
    if (amt) extra.amount_minor = amt;
    must(await transition(approvers[key], companyId, id, 'approve', extra), `duyệt bước ${cur.role} của ${doc.code}`);
  }
  throw new Error(`Duyệt không hội tụ cho phiếu ${id}`);
}

/** Đính kèm UNC (ủy nhiệm chi) để thực thi phiếu chi: prepare → PUT → confirm. */
export async function attachUnc(page: Page, companyId: string, id: string): Promise<void> {
  const bytes = Buffer.from(`%PDF-1.4\n% UNC kiem thu ${id}\n%%EOF\n`);
  const doc = await getDoc(page, companyId, id);
  const prep = dataOf(
    must(
      await req(page, 'POST', `/documents/${id}/attachments/prepare`, {
        scope: companyId,
        data: {
          filename: 'UNC-kiem-thu.pdf',
          size: bytes.length,
          mime: 'application/pdf',
          sha256: sha256Hex(bytes),
          type: 'bank_order',
          if_match: doc.version,
          request_id: randomUUID(),
        },
      }),
      'xin URL tải UNC',
    ),
  );
  const up = await page.request.fetch(String(prep.upload_url), {
    method: 'PUT',
    headers: (prep.required_headers ?? {}) as Record<string, string>,
    data: bytes,
    failOnStatusCode: false,
  });
  if (!up.ok()) throw new Error(`tải UNC lên kho lưu trữ lỗi: HTTP ${up.status()} ${await up.text()}`);
  // `if_match` của xác nhận là phiên bản HỒ SƠ hiện tại (sau bước prepare), không phải phiên bản đính kèm.
  const fresh = await getDoc(page, companyId, id);
  must(
    await req(page, 'POST', `/documents/${id}/attachments/confirm`, {
      scope: companyId,
      data: { attachment_id: prep.attachment_id, if_match: fresh.version, request_id: randomUUID() },
    }),
    'xác nhận UNC',
  );
}

/** Thực thi phiếu chi bằng API (kèm số tham chiếu ngân hàng). */
export async function payByApi(page: Page, companyId: string, id: string, paidAt = vnToday()): Promise<Res> {
  return transition(page, companyId, id, 'pay', { execution: { paid_at: paidAt, bank_ref: `FT${digits(10)}` } });
}

/** Các lượt tự động đã chạy cho một phiếu (cũ → mới, không kể bước đều bỏ qua). */
export async function runsOf(page: Page, companyId: string, id: string): Promise<any[]> {
  const r = must(await req(page, 'GET', `/automation/runs/by-source?source_type=document&source_id=${id}`, { scope: companyId }), 'lượt tự động');
  return dataOf<any[]>(r) ?? [];
}

/** Chờ tới khi có lượt `rule` ở trạng thái `status`; ném lỗi kèm tình trạng cuối nếu hết hạn. */
export async function waitForRun(page: Page, companyId: string, id: string, rule: string, status: 'done' | 'failed', timeoutMs = 75_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any[] = [];
  while (Date.now() < deadline) {
    last = await runsOf(page, companyId, id);
    const hit = last.filter((r) => r.rule_code === rule && r.status === status).at(-1);
    if (hit) return hit;
    await sleep(1000);
  }
  const summary = last.map((r) => `${r.rule_code}:${r.status} [${(r.steps ?? []).map((s: any) => `${s.name}=${s.status}${s.error ? `(${s.error})` : ''}`).join(', ')}]`);
  throw new Error(`Không thấy lượt ${rule} ở trạng thái ${status} sau ${timeoutMs}ms. Hiện có: ${summary.join(' | ') || '(không có lượt nào)'}`);
}

/** Bước của lượt chạy theo tên. */
export function stepOf(run: any, name: string): any {
  return (run?.steps ?? []).find((s: any) => s.name === name);
}

export async function getLoan(page: Page, companyId: string, loanId: string): Promise<any> {
  return dataOf(must(await req(page, 'GET', `/bank-debts/${loanId}`, { scope: companyId }), `khoản vay ${loanId}`));
}

export async function alertsOf(page: Page, companyId: string): Promise<any[]> {
  const r = must(await req(page, 'GET', '/alerts', { scope: companyId }), 'cảnh báo');
  return dataOf<{ items: any[] }>(r).items ?? [];
}

/** Lấy id phiếu được sinh bởi lượt (theo loại đối tượng sinh `generated` hoặc output của bước). */
export function generatedId(run: any, stepName: string): string | null {
  return stepOf(run, stepName)?.output_id ?? null;
}

/** Mặc định phạm vi công ty hiện tại (để khôi phục sau khi đổi trong UI). */
export async function defaultScopeOf(page: Page): Promise<string | null> {
  const me = dataOf(must(await req(page, 'GET', '/me'), 'hồ sơ người dùng'));
  return me?.prefs?.default_scope ?? null;
}

export async function restoreDefaultScope(page: Page, value: string | null): Promise<void> {
  if (!value) return;
  await req(page, 'PATCH', '/me/prefs', { data: { default_scope: value } });
}

/* ------------------------------------------------------------------ *
 * UI — dùng chung
 * ------------------------------------------------------------------ */

/** Đổi phạm vi dữ liệu trên thanh đầu (nút "Phạm vi dữ liệu" → mục "CODE · Tên"). */
export async function switchScope(page: Page, code: string): Promise<void> {
  // Trang mới mở từ fixture còn ở about:blank: vào ứng dụng trước để có thanh đầu.
  if (page.url() === 'about:blank' || page.url() === '') await page.goto('/');
  const trigger = page.getByRole('button', { name: 'Phạm vi dữ liệu' });
  await trigger.waitFor({ state: 'visible', timeout: 30_000 });
  await trigger.click();
  await page.getByRole('menuitem', { name: new RegExp(`^${code}\\s*·`) }).click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await sleep(400);
}

/** Khối của một FgField theo nhãn (nhãn và ô nhập nằm chung một thẻ bao). */
export function fieldOf(root: Page | Locator, label: string): Locator {
  return root.locator('label').filter({ hasText: label }).first().locator('xpath=..');
}

/** Chọn một mục trong ô antd Select (có tìm kiếm). `search` gõ vào ô, `option` là chữ khớp mục cần bấm. */
export async function pickSelect(page: Page, field: Locator, search: string, option: string | RegExp): Promise<void> {
  const input = field.locator('.ant-select').first();
  await input.click();
  const box = field.locator('input').first();
  const opt = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: option }).first();
  // Ô tìm kiếm có độ trễ (debounce + truy vấn): gõ lại nếu chưa thấy mục sau một lúc.
  for (let attempt = 0; attempt < 3; attempt++) {
    await box.fill('').catch(() => undefined);
    await box.fill(search).catch(() => undefined);
    try {
      await opt.waitFor({ state: 'visible', timeout: 7_000 });
      break;
    } catch (e) {
      if (attempt === 2) throw e;
    }
  }
  await opt.click();
  await sleep(300);
}

/**
 * Chọn mục trong ô antd Select KHÔNG có tìm kiếm (FgSelect). Danh sách ảo hoá: cuộn cho tới khi mục hiện ra.
 * `option` là chữ có trong nhãn mục cần chọn.
 */
export async function pickPlainSelect(page: Page, field: Locator, option: string): Promise<void> {
  await field.locator('.ant-select').first().click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.waitFor({ state: 'visible', timeout: 10_000 });
  const item = dropdown.locator('.ant-select-item-option', { hasText: option });
  // Danh sách ảo hoá (hàng trăm tài khoản): cuộn bằng bánh xe chuột trên danh sách đang mở cho tới khi mục hiện ra.
  for (let i = 0; i < 400 && (await item.count()) === 0; i++) {
    await dropdown.hover({ timeout: 5_000 }).catch(() => undefined);
    await page.mouse.wheel(0, 500);
    await sleep(50);
  }
  await item.first().click({ timeout: 10_000 });
  await sleep(300);
}

/**
 * Chọn mục trong ô antd Select KHÔNG có tìm kiếm nhưng danh sách rất dài (hàng trăm TK của công ty): cuộn chính khung
 * danh sách ảo hoá (`.rc-virtual-list-holder`) từng bước nửa chiều cao khung, mục hiện ra thì bấm.
 * Không đi bằng phím mũi tên: danh sách được tải lại định kỳ (30 giây) và làm mất vị trí con trỏ giữa chừng.
 */
export async function pickLongSelect(page: Page, field: Locator, option: string): Promise<void> {
  // hộp thoại chọn lần trước còn đang đóng (hiệu ứng) thì chờ hẳn, tránh bấm nhầm vào danh sách cũ
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  await field.locator('.ant-select').first().click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.waitFor({ state: 'visible', timeout: 10_000 });
  await dropdown.locator('.ant-select-item-option').first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => undefined);
  const item = dropdown.locator('.ant-select-item-option').filter({ hasText: option });
  for (let i = 0; i < 1200 && (await item.count()) === 0; i++) {
    // khung cuộn của danh sách ảo hoá: nội dung cao hơn khung hiển thị (rc-virtual-list dùng overflow ẩn + scrollTop)
    await dropdown.evaluate((root) => {
      const all = [root as HTMLElement, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
      const el = all
        .filter((e) => e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 10)
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (el) el.scrollTop += Math.max(40, Math.floor(el.clientHeight / 2));
    });
    await sleep(25);
  }
  if ((await item.count()) === 0) throw new Error(`Không tìm thấy mục "${option}" trong danh sách dài của ô chọn`);
  await item.first().click({ timeout: 10_000 });
  await dropdown.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  await sleep(300);
}

/** Chọn mục đầu tiên của một ô antd Select (khi chỉ cần một tài khoản bất kỳ, VD tài khoản nguồn của phiếu nháp). */
export async function pickFirstOption(page: Page, field: Locator): Promise<void> {
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').first().waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  await field.locator('.ant-select').first().click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.waitFor({ state: 'visible', timeout: 10_000 });
  await dropdown.locator('.ant-select-item-option').first().click({ timeout: 15_000 });
  await dropdown.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  await sleep(300);
}

/**
 * Huỷ phiếu từ chi tiết phiếu (trang phải đang ở chi tiết): nút "Hủy hồ sơ" ⇒ hộp thoại có ô lý do bắt buộc
 * (≥ 5 ký tự) ⇒ nút "Hủy hồ sơ" trong hộp thoại.
 */
export async function cancelFromDetail(page: Page, reason: string): Promise<void> {
  await page.getByRole('button', { name: 'Hủy hồ sơ', exact: true }).first().click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('textarea').fill(reason);
  await dlg.getByRole('button', { name: 'Hủy hồ sơ', exact: true }).click();
  await expect(dlg).toBeHidden({ timeout: 20_000 });
}

/** Danh sách mục đang hiện trong một ô antd Select đã mở (để kiểm tra nội dung). */
export async function visibleOptions(page: Page): Promise<string[]> {
  return page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').allInnerTexts();
}

/** Trang đã rơi vào màn "Hệ thống đang gặp sự cố" (error boundary) ⇒ ném lỗi kèm thông báo lỗi hiển thị. */
export async function assertNoPageCrash(page: Page, where: string): Promise<void> {
  // Lỗi hiển thị thường xảy ra sau khi dữ liệu tải xong: chờ một nhịp để React kịp render.
  await page.waitForTimeout(1500);
  if ((await page.getByText('Hệ thống đang gặp sự cố', { exact: false }).count()) === 0) return;
  const msg = (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 260);
  throw new Error(`Trang ${where} bị lỗi giao diện (error boundary): ${msg}`);
}

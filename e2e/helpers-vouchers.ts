/**
 * Helper riêng cho e2e/v2-vouchers.spec.ts (khu vực "vouchers": phiếu thu/chi, duyệt, thực thi).
 *
 *  - API (page.request, dùng chung cookie của context): dữ liệu nền (đối tác, tài khoản, phiếu, chứng từ,
 *    bước duyệt, thực thi) và đọc trạng thái / số dư để kiểm tra.
 *  - UI: thao tác form, hồ sơ, modal duyệt. Locator bám nhãn tiếng Việt lấy từ apps/web/src.
 *
 * Mọi tên dữ liệu tạo ra đi qua uniq() của fixtures (tránh đụng dữ liệu của tiến trình khác).
 * Không dùng số đếm toàn cục: mỗi test tự tạo đối tác / tài khoản / phiếu riêng.
 */
import { createHash, randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';

export const CTA_CODE = 'CTA';
/** Hạn thanh toán cố định (tương lai): dạng ô nhập DatePicker và dạng gửi lên API. */
export const DEADLINE_UI = '30/12/2026 17:00';
export const DEADLINE_ISO = '2026-12-30T17:00';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:5139';
/**
 * Giới hạn cho MỖI lời gọi API của helper. Mặc định của Playwright là use.actionTimeout (15 giây), quá sát khi máy
 * đang tải nặng (nhiều tiến trình e2e chạy song song): lời gọi vẫn thành công sau 15–25 giây nhưng bị báo timeout giả.
 */
const API_TIMEOUT_MS = 60_000;

type Json = any;
export type ApiResult = { status: number; body: Json; text: string };

/** Một số endpoint bọc `{ data }`, một số trả thẳng. */
export function unwrap<T = Json>(body: Json): T {
  return (body && typeof body === 'object' && 'data' in body ? body.data : body) as T;
}

/* ============================================================
 * API
 * ============================================================ */

/**
 * API đang khởi động lại (node --watch khi có sửa mã) → 502/503/504 hoặc lỗi kết nối. Gọi lại tối đa vài lần
 * (có khoá request_id cho ghi); lỗi nghiệp vụ 4xx/5xx khác được trả về nguyên để test báo đúng.
 */
export async function withApiRetry<T extends { status(): number }>(call: () => Promise<T>, max = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    let res: T | undefined;
    try {
      res = await call();
    } catch (e) {
      if (attempt >= max || !/ECONN|socket hang up|EPIPE|fetch failed/i.test(String(e))) throw e;
    }
    if (res && (res.status() < 502 || res.status() > 504 || attempt >= max)) return res;
    await new Promise((r) => setTimeout(r, 2_000 * attempt));
  }
}

export async function api(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  opts: { scope?: string; data?: unknown } = {},
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (opts.scope) headers['x-company-scope'] = opts.scope;
  // web tự sinh request_id (UUID) cho mọi lời gọi ghi (api.ts); server yêu cầu có khoá này
  let data: unknown = opts.data;
  if (method !== 'GET' && data && typeof data === 'object' && !Array.isArray(data) && !('request_id' in (data as object))) {
    data = { ...(data as object), request_id: randomUUID() };
  }
  const res = await withApiRetry(() => page.request.fetch(`${BASE}/api/v1${path}`, { method, headers, data: data as never, timeout: API_TIMEOUT_MS }));
  const text = await res.text();
  let body: Json = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status(), body, text };
}

/** Mã công ty (id) theo mã ngắn, lấy từ /me của người dùng đang đăng nhập. */
export async function companyId(page: Page, code = CTA_CODE): Promise<string> {
  const r = await api(page, 'GET', '/me');
  const companies = unwrap<{ companies: { company_id: string; company_code: string }[] }>(r.body).companies;
  const c = companies.find((x) => x.company_code === code);
  if (!c) throw new Error(`Không thấy công ty ${code} trong /me`);
  return c.company_id;
}

/** Tag của công ty (tên uniq). Nhân viên có tag:create. */
export async function createTag(page: Page, co: string, name: string): Promise<string> {
  const r = await api(page, 'POST', '/tags', { scope: co, data: { name, company_id: co, color: '#2563eb' } });
  expect(r.status, `tạo tag: ${r.text}`).toBeLessThan(300);
  const d = unwrap<Json>(r.body);
  return String(d.tag?._id ?? d._id ?? d.data?._id);
}

export type PartnerType = 'bank' | 'customer' | 'supplier';

export async function createPartner(
  page: Page,
  co: string,
  type: PartnerType,
  name: string,
  extra: { bank?: string; account?: string; tax?: string } = {},
): Promise<string> {
  const r = await api(page, 'POST', '/partners', {
    scope: co,
    data: {
      type,
      name,
      bank_name: extra.bank ?? null,
      account_number: extra.account ?? null,
      tax_code: extra.tax ?? null,
      company_id: co,
    },
  });
  expect(r.status, `tạo đối tác: ${r.text}`).toBeLessThan(300);
  const d = unwrap<Json>(r.body);
  return String(d.partner?._id ?? d._id);
}

export async function getPartner(page: Page, co: string, partnerId: string): Promise<Json> {
  const r = await api(page, 'GET', `/partners/${partnerId}`, { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const d = unwrap<Json>(r.body);
  return d.partner ?? d;
}

/** Tài khoản ngân hàng của công ty (KTT có bank:write). Số dư bắt đầu bằng 0. */
export async function createAccount(page: Page, co: string, bankName: string, kind: 'bank' | 'cash' = 'bank'): Promise<string> {
  const number = String(Math.floor(1_000_000_000 + Math.random() * 8_999_999_999));
  const r = await api(page, 'POST', '/bank-accounts', {
    scope: co,
    data: {
      company_id: co,
      is_group: false,
      bank_name: bankName,
      account_name: 'Tài khoản kiểm thử',
      account_number: number,
      currency: 'VND',
      kind,
      min_balance_minor: '0',
      show_on_dashboard: true,
      status: 'active',
    },
  });
  expect(r.status, `tạo tài khoản: ${r.text}`).toBeLessThan(300);
  const d = unwrap<Json>(r.body);
  return String(d._id ?? d.account?._id ?? d.id);
}

/** Số dư sổ cái hiện tại (minor) của một tài khoản trong công ty. */
export async function balanceOf(page: Page, co: string, accountId: string): Promise<bigint> {
  const r = await api(page, 'GET', '/bank-accounts', { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const items = (r.body?.items ?? unwrap<Json>(r.body)?.items ?? []) as Json[];
  const it = items.find((x) => String(x._id) === accountId);
  if (!it) throw new Error(`Không thấy tài khoản ${accountId} trong danh sách`);
  return BigInt(String(it.balance.minor));
}

export async function getDoc(page: Page, co: string, id: string): Promise<Json> {
  const r = await api(page, 'GET', `/documents/${id}`, { scope: co });
  expect(r.status, `đọc hồ sơ ${id}: ${r.text}`).toBeLessThan(300);
  return unwrap<Json>(r.body);
}

/** Tạo phiếu nháp (thu: kind income, chi: kind spend) — cùng body mà form web gửi. */
export async function createVoucherApi(
  page: Page,
  co: string,
  o: { kind: 'spend' | 'income'; partnerId: string; accountId: string; amount: number; title: string; purpose: string; tagIds?: string[] },
): Promise<{ id: string; version: number }> {
  const r = await api(page, 'POST', '/documents', {
    scope: co,
    data: {
      kind: o.kind,
      company_id: co,
      title: o.title,
      purpose: o.purpose,
      partner_id: o.partnerId,
      amount: { amount_minor: String(o.amount), currency: 'VND' },
      source: { fund: 'bank', account_id: o.accountId, group_managed: false },
      planned_date: DEADLINE_ISO,
      priority: 'normal',
      category_id: null,
      budget: { budget_id: null, line_id: null, in_plan: true },
      contract: {},
      tag_ids: o.tagIds ?? [],
      options: { loan: null },
      transfer_target: null,
    },
  });
  expect(r.status, `tạo phiếu: ${r.text}`).toBeLessThan(300);
  const d = unwrap<Json>(r.body);
  return { id: String(d._id), version: Number(d.version ?? 1) };
}

/** Gọi POST /documents/:id/transition với if_match = phiên bản hiện tại. */
export async function transitionApi(page: Page, co: string, id: string, body: Record<string, unknown>): Promise<ApiResult> {
  const d = await getDoc(page, co, id);
  return api(page, 'POST', `/documents/${id}/transition`, {
    scope: co,
    data: { request_id: randomUUID(), if_match: Number(d.version ?? 1), ...body },
  });
}

export async function submitApi(page: Page, co: string, id: string): Promise<void> {
  const r = await transitionApi(page, co, id, { action: 'submit' });
  expect(r.status, `gửi duyệt: ${r.text}`).toBeLessThan(300);
}

export async function approveApi(page: Page, co: string, id: string, extra: Record<string, unknown> = {}): Promise<void> {
  const r = await transitionApi(page, co, id, { action: 'approve', ...extra });
  expect(r.status, `duyệt: ${r.text}`).toBeLessThan(300);
}

/** File PDF tối thiểu, mỗi lần một nội dung khác nhau (tránh trùng sha256). */
export function miniPdf(name: string): Buffer {
  const body =
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n';
  return Buffer.from(`${body}% ${name} ${Date.now()}${Math.random()}\n%%EOF\n`, 'latin1');
}

/** Chứng từ qua API: prepare → PUT byte → confirm (cùng luồng với web). */
export async function attachApi(
  page: Page,
  co: string,
  id: string,
  type: 'contract' | 'invoice' | 'bank_order' | 'other',
  name: string,
): Promise<void> {
  const buf = miniPdf(name);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const ifMatch = Number((await getDoc(page, co, id)).version ?? 1);
  const prep = await api(page, 'POST', `/documents/${id}/attachments/prepare`, {
    scope: co,
    data: { filename: name, size: buf.length, mime: 'application/pdf', sha256, type, if_match: ifMatch },
  });
  expect(prep.status, `chuẩn bị chứng từ: ${prep.text}`).toBeLessThan(300);
  const p = unwrap<Json>(prep.body);
  const url = String(p.upload_url).startsWith('http') ? String(p.upload_url) : `${BASE}${p.upload_url}`;
  const put = await withApiRetry(() =>
    page.request.fetch(url, {
      method: 'PUT',
      headers: { ...(p.required_headers ?? {}), 'x-company-scope': co },
      data: buf,
      timeout: API_TIMEOUT_MS,
    }),
  );
  expect(put.status(), 'PUT chứng từ').toBeLessThan(300);
  const conf = await api(page, 'POST', `/documents/${id}/attachments/confirm`, {
    scope: co,
    data: { attachment_id: p.attachment_id, if_match: ifMatch },
  });
  expect(conf.status, `xác nhận chứng từ: ${conf.text}`).toBeLessThan(300);
}

/** Đọc trạng thái (polling: đợi bước bất đồng bộ như sổ cái / tự thực thi). Khi sai, báo trạng thái thực tế. */
export async function expectStatus(page: Page, co: string, id: string, status: string): Promise<void> {
  try {
    await expect
      .poll(
        async () => {
          // lỗi đọc tạm thời (API chậm / đang khởi động lại) không được làm hỏng cả khung chờ: để poll thử lại.
          // (expect.poll không tự thử lại khi chính hàm đọc ném lỗi.)
          try {
            return String((await getDoc(page, co, id)).status);
          } catch (err) {
            return `lỗi đọc tạm thời: ${String(err).slice(0, 120)}`;
          }
        },
        { timeout: 20_000, message: `trạng thái ${status}` },
      )
      .toBe(status);
  } catch (e) {
    const d = await getDoc(page, co, id);
    const steps = ((d.approval?.steps ?? []) as { role: string; state: string }[]).map((s) => `${s.role}:${s.state}`).join(' > ');
    throw new Error(`Trạng thái thực tế "${d.status}", cần "${status}". Bước duyệt: ${steps || '—'}. Lịch sử: ${JSON.stringify((d.history ?? []).map((h: { action: string; to?: string }) => `${h.action}->${h.to ?? ''}`))}`, { cause: e });
  }
}

/**
 * Duyệt tới khi hồ sơ không còn chờ (đi đúng chuỗi duyệt mà server dựng), dùng cho các test không kiểm chuỗi.
 * Mỗi bước chọn đúng người theo vai trò của bước đang "current".
 */
export async function approveToFinal(
  pages: { chief?: Page; director?: Page; chairman?: Page },
  co: string,
  id: string,
  first?: { page: Page; body?: Record<string, unknown> },
): Promise<string> {
  const byRole: Record<string, Page | undefined> = {
    chief_accountant: pages.chief,
    director: pages.director,
    chairman: pages.chairman,
  };
  if (first) await approveApi(first.page, co, id, first.body ?? {});
  const anyPage = pages.chief ?? pages.director ?? pages.chairman;
  if (!anyPage) throw new Error('Cần ít nhất một trang đăng nhập');
  for (let i = 0; i < 6; i++) {
    const d = await getDoc(anyPage, co, id);
    const status = String(d.status);
    if (!status.startsWith('pending.')) return status;
    const cur = ((d.approval?.steps ?? []) as { role: string; state: string }[]).find((s) => s.state === 'current');
    const page = cur ? byRole[cur.role] : undefined;
    if (!page) throw new Error(`Không có tài khoản cho bước ${cur?.role ?? '?'} (trạng thái ${status})`);
    await approveApi(page, co, id);
  }
  return String((await getDoc(anyPage, co, id)).status);
}

/** Chuẩn bị một phiếu đã gửi duyệt (KTV) kèm đủ hợp đồng + hoá đơn. */
export async function submittedVoucherApi(
  staff: Page,
  co: string,
  o: { kind?: 'spend' | 'income'; partnerId: string; accountId: string; amount: number; title: string; purpose?: string; tagIds?: string[] },
): Promise<{ id: string }> {
  const { id } = await createVoucherApi(staff, co, {
    kind: o.kind ?? 'spend',
    partnerId: o.partnerId,
    accountId: o.accountId,
    amount: o.amount,
    title: o.title,
    purpose: o.purpose ?? `Nội dung kiểm thử ${o.title}`,
    tagIds: o.tagIds,
  });
  await attachApi(staff, co, id, 'contract', 'hop-dong.pdf');
  if ((o.kind ?? 'spend') === 'spend') await attachApi(staff, co, id, 'invoice', 'hoa-don.pdf');
  await submitApi(staff, co, id);
  return { id };
}

/* ============================================================
 * UI — tiện ích chung
 * ============================================================ */

/** Ô nhập theo nhãn: FgField là <div><label/>{ô}</div> (không gắn htmlFor), nên lấy khối cha của nhãn. */
export function fieldOf(root: Page | Locator, label: string): Locator {
  return root.locator('label').filter({ hasText: label }).first().locator('xpath=..');
}

/** Modal (antd) đang hiển thị ở lớp trên cùng. */
export function topModal(page: Page): Locator {
  return page.locator('.ant-modal:visible').last();
}

export function actionBar(page: Page): Locator {
  return page.getByRole('toolbar', { name: 'Hành động phê duyệt' });
}

/**
 * Chọn một mục trong antd Select (không gõ tìm). Danh sách antd là "ảo" (chỉ render một phần), nên nếu mục
 * chưa có trong DOM thì điều hướng bằng bàn phím: lên đầu rồi đi xuống tới khi mục đang active khớp, Enter.
 */
export async function pickSelect(page: Page, wrapper: Locator, option: string | RegExp): Promise<void> {
  await wrapper.locator('.ant-select').first().click();
  const visible = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
  const direct = visible.filter({ hasText: option }).first();
  if ((await direct.count()) > 0) {
    await direct.click();
    return;
  }
  // danh sách rất dài (tài khoản tích luỹ qua nhiều lượt test, > 800 mục): cuộn bánh xe chuột trong danh sách ảo
  // (khung ảo của antd không có phần tử cuộn riêng để đặt scrollTop), dừng khi cửa sổ hiển thị không đổi nữa
  const firstOption = visible.first();
  const box = (await firstOption.count()) > 0 ? await firstOption.boundingBox() : null;
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    let prev = '';
    let stuck = 0;
    for (let i = 0; i < 4000 && stuck < 3; i++) {
      if ((await direct.count()) > 0) {
        await direct.click();
        return;
      }
      await page.mouse.wheel(0, 240);
      await page.waitForTimeout(30);
      const cur = (await firstOption.textContent().catch(() => '')) ?? '';
      stuck = cur === prev ? stuck + 1 : 0;
      prev = cur;
    }
  }
  // mục nằm ngoài cửa sổ ảo: đọc mục đang active rồi di chuyển bằng phím mũi tên
  const matches = (t: string): boolean => (typeof option === 'string' ? t.includes(option) : option.test(t));
  const activeText = (): Promise<string> =>
    page.evaluate(() => {
      const el = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-active');
      return el ? (el.textContent ?? '').trim() : '';
    });
  // quét xuống hết danh sách, rồi quét lên (mục có thể nằm phía trên mục đang chọn)
  for (const key of ['ArrowDown', 'ArrowUp'] as const) {
    for (let i = 0; i < 800; i++) {
      if (matches(await activeText())) {
        await page.keyboard.press('Enter');
        return;
      }
      await page.keyboard.press(key);
    }
  }
  const seen = await visible.allTextContents();
  throw new Error(`Không chọn được mục "${String(option)}" (mục đang hiển thị: ${JSON.stringify(seen)})`);
}

/** Ô chọn đối tác (PartnerPicker): gõ tên rồi chọn đúng đối tác trong danh sách gợi ý. */
export async function pickPartner(page: Page, wrapper: Locator, name: string): Promise<void> {
  const input = wrapper.locator('input[role="combobox"]').first();
  await input.click();
  await input.fill(name);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: name }).first().click();
}

/**
 * Phạm vi làm việc giao diện lấy từ tuỳ chọn `default_scope` LƯU TRÊN TÀI KHOẢN — dùng chung cho mọi trình duyệt
 * đăng nhập cùng tài khoản (kt@, ktt@ được nhiều khu vực test dùng song song, có tiến trình đổi phạm vi sang
 * MAYOGU/CTB). Nếu phạm vi đang khác CTA, đặt lại CTA (đúng dữ liệu seed) trước khi mở trang để hồ sơ CTA không
 * bị báo "ngoài phạm vi". Người có toàn phạm vi (chủ tịch) giữ nguyên lựa chọn "Tất cả công ty".
 */
export async function ensureCtaScope(page: Page): Promise<void> {
  const r = await api(page, 'GET', '/me');
  const d = unwrap<Json>(r.body);
  const co = (d.companies as { company_id: string; company_code: string }[] | undefined)?.find((c) => c.company_code === CTA_CODE)?.company_id;
  if (!co) throw new Error(`Không thấy công ty ${CTA_CODE} trong /me`);
  const pref = String(d.prefs?.default_scope ?? 'all');
  const okPref = pref === co || (pref === 'all' && Boolean(d.scope?.all));
  if (!okPref) {
    const p = await api(page, 'PATCH', '/me/prefs', { data: { default_scope: co } });
    expect(p.status, `đặt phạm vi mặc định CTA: ${p.text}`).toBeLessThan(300);
  }
}

/** Mở trang giao diện khi phạm vi đang là CTA (xem ensureCtaScope). */
export async function gotoCta(page: Page, path: string): Promise<void> {
  await ensureCtaScope(page);
  await page.goto(path);
}

export async function openDoc(page: Page, kind: 'spend' | 'income', id: string): Promise<void> {
  const path = `/ho-so/${kind === 'spend' ? 'chi' : 'thu'}/${id}`;
  // Phạm vi mặc định nằm trên tài khoản DÙNG CHUNG (kt@, ktt@ có nhiều tiến trình test): tiến trình khác có thể đổi nó
  // giữa lúc gotoCta đặt CTA và lúc trang tải xong → hồ sơ CTA bị báo "không có quyền" (đổi phạm vi, không phải lỗi app).
  // Khi gặp thông báo đó thì đặt lại CTA và tải lại (tối đa 3 lượt).
  const tab = page.getByRole('tab', { name: 'Tóm tắt' });
  const denied = page.getByText('Bạn không có quyền xem mục này');
  for (let attempt = 1; ; attempt++) {
    await gotoCta(page, path);
    await expect
      .poll(async () => (await tab.isVisible()) || (await denied.isVisible()), { timeout: 20_000, message: 'hồ sơ hiện tab Tóm tắt hoặc thông báo quyền' })
      .toBe(true);
    if (await tab.isVisible()) return;
    if (attempt >= 3) throw new Error(`Hồ sơ ${id} vẫn báo "Bạn không có quyền xem mục này" sau ${attempt} lần mở (phạm vi CTA)`);
  }
}

/* ============================================================
 * UI — tạo phiếu (form /chi/moi, /thu/moi)
 * ============================================================ */

export async function uiCreateVoucher(
  page: Page,
  o: {
    kind: 'spend' | 'income';
    partnerName: string;
    accountName: string;
    amount: number;
    title: string;
    purpose: string;
    submit: boolean;
  },
): Promise<{ id: string }> {
  await gotoCta(page, o.kind === 'spend' ? '/chi/moi' : '/thu/moi');
  // mặc định form là "Lưu nháp"; chọn "Gửi duyệt ngay sau khi tạo" mới đổi thành "Tạo & gửi duyệt"
  await expect(page.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 20_000 });
  await fieldOf(page, 'Tiêu đề').locator('input').fill(o.title);
  await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(o.purpose);
  await pickPartner(page, fieldOf(page, o.kind === 'spend' ? 'Bên nhận tiền' : 'Bên nộp tiền'), o.partnerName);
  await page.getByLabel('Số tiền', { exact: true }).first().fill(String(o.amount));
  const deadline = fieldOf(page, 'Hạn thanh toán').locator('input').first();
  await deadline.click();
  await deadline.fill(DEADLINE_UI);
  await deadline.press('Enter');
  await pickSelect(page, fieldOf(page, o.kind === 'spend' ? 'Tài khoản nguồn' : 'Tài khoản đích'), o.accountName);
  if (o.submit) await page.getByRole('checkbox', { name: 'Gửi duyệt ngay sau khi tạo' }).check();
  await page.getByRole('button', { name: o.submit ? 'Tạo & gửi duyệt' : 'Lưu nháp', exact: true }).click();
  await page.waitForURL(/\/ho-so\/(chi|thu)\/[0-9a-f]{24}/, { timeout: 30_000 });
  const id = page.url().match(/\/ho-so\/(?:chi|thu)\/([0-9a-f]{24})/)![1]!;
  return { id };
}

/* ============================================================
 * UI — hồ sơ: chứng từ, duyệt, từ chối, yêu cầu bổ sung, gửi, thực thi
 * ============================================================ */

/** Tải chứng từ qua modal "Tải chứng từ lên" (tab Chứng từ). */
export async function uiUploadEvidence(page: Page, typeLabel: string, name: string): Promise<void> {
  await page.getByRole('tab', { name: /Chứng từ/ }).click();
  await page.getByRole('button', { name: '+ Tải chứng từ lên' }).click();
  const m = topModal(page);
  await expect(m.getByText('Tải chứng từ lên', { exact: true })).toBeVisible();
  await pickSelect(page, fieldOf(m, 'Loại chứng từ'), typeLabel);
  await m.locator('input[type="file"]').setInputFiles({ name, mimeType: 'application/pdf', buffer: miniPdf(name) });
  await m.locator('.ant-modal-footer').getByRole('button', { name: 'Tải lên', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 30_000 });
}

export interface ApproveOpts {
  /** Số tiền duyệt mới (chỉ phiếu chi, cấp duyệt). */
  amount?: number;
  /** Tài khoản nguồn mới (theo tên hiển thị trong danh sách). */
  account?: string;
  /** Ý kiến / lý do (bắt buộc khi duyệt trước). */
  opinion?: string;
  /** Số tiền gõ lại khi hệ thống yêu cầu xác nhận (> 5 tỷ hoặc ngoài ngân sách). */
  retype?: string;
}

/**
 * Duyệt trên hồ sơ: bấm "Duyệt khoản …" (hoặc "Duyệt trước …"), điền tuỳ chọn, xác nhận, và đi qua
 * các modal xác nhận phát sinh (tăng số tiền / gõ lại số tiền) cho tới khi đóng hết.
 */
/** Trạng thái modal ở lớp trên cùng: đóng / xác nhận tăng tiền / gõ lại tiền / lỗi / khác (modal duyệt). */
async function modalState(page: Page): Promise<{ kind: 'closed' | 'increase' | 'retype' | 'error' | 'other'; title: string }> {
  const top = topModal(page);
  if ((await top.count()) === 0) return { kind: 'closed', title: '' };
  // modal có thể đóng ngay sau lần đếm (duyệt thành công): đọc tiêu đề có hạn ngắn; mất thì coi như đã đóng
  const titleText = await top
    .locator('.ant-modal-title')
    .first()
    .textContent({ timeout: 2_000 })
    .catch(() => null);
  const title = (titleText ?? '').trim();
  if (!title) return (await topModal(page).count()) === 0 ? { kind: 'closed', title: '' } : { kind: 'other', title: '' };
  if (/Xác nhận tăng số tiền/.test(title)) return { kind: 'increase', title };
  if (/Xác nhận số tiền/.test(title)) return { kind: 'retype', title };
  if (/Không thực hiện được/.test(title)) return { kind: 'error', title };
  return { kind: 'other', title };
}

/**
 * Duyệt trên hồ sơ: bấm "Duyệt khoản …" (hoặc "Duyệt trước …"), điền tuỳ chọn, xác nhận, rồi xử lý các
 * modal phát sinh (tăng số tiền → xác nhận; > 5 tỷ / ngoài ngân sách → gõ lại số tiền) tới khi modal duyệt đóng.
 * Gặp lỗi nghiệp vụ (modal "Không thực hiện được") thì ném lỗi kèm nội dung để test báo đúng nguyên nhân.
 */
export async function uiApprove(page: Page, o: ApproveOpts = {}): Promise<void> {
  await actionBar(page).getByRole('button', { name: /^(Duyệt khoản|Duyệt trước)/ }).click();
  const m = topModal(page);
  await expect(m.locator('.ant-modal-footer')).toBeVisible();
  if (o.opinion) await fieldOf(m, 'Ý kiến').locator('textarea').fill(o.opinion);
  if (o.account) await pickSelect(page, fieldOf(m, 'Tài khoản nguồn'), o.account);
  if (o.amount !== undefined) await fieldOf(m, 'Số tiền duyệt').locator('input').fill(String(o.amount));
  await m.locator('.ant-modal-footer').getByRole('button', { name: /^(Duyệt khoản|Duyệt trước)/ }).click();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const st = await modalState(page);
    if (st.kind === 'closed') return;
    if (st.kind === 'error') {
      const detail = (await topModal(page).innerText()).replace(/\s+/g, ' ').trim();
      throw new Error(`Duyệt bị từ chối bởi hệ thống: ${detail}`);
    }
    if (st.kind === 'increase') {
      // v2 §6.3: tăng số tiền phải GÕ LẠI số tiền mới để xác nhận — không được chỉ bấm xác nhận
      const box = fieldOf(topModal(page), 'Nhập lại số tiền').locator('input');
      if ((await box.count()) === 0) {
        throw new Error('Tăng số tiền: chỉ có hộp xác nhận, KHÔNG có ô "Nhập lại số tiền" (v2 §6.3 yêu cầu gõ lại số tiền mới)');
      }
      if (!o.retype) throw new Error('Tăng số tiền: hệ thống yêu cầu gõ lại số tiền mới nhưng test không truyền o.retype');
      await box.fill(o.retype);
      await topModal(page).locator('.ant-modal-footer').getByRole('button', { name: /^Xác nhận/ }).click();
    } else if (st.kind === 'retype') {
      if (!o.retype) throw new Error('Hệ thống yêu cầu gõ lại số tiền nhưng test không truyền o.retype');
      await fieldOf(topModal(page), 'Nhập lại số tiền').locator('input').fill(o.retype);
      await topModal(page).locator('.ant-modal-footer').getByRole('button', { name: 'Xác nhận', exact: true }).click();
    } else {
      await page.waitForTimeout(200);
      continue;
    }
    // đợi modal xác nhận vừa xử lý đóng hoặc chuyển sang modal khác
    await expect
      .poll(async () => (await modalState(page)).title, { timeout: 15_000, message: 'modal xác nhận đổi' })
      .not.toBe(st.title);
  }
  throw new Error('Modal duyệt không đóng sau 45 giây');
}

/** Từ chối / Yêu cầu bổ sung: toolbar → modal có ý kiến → xác nhận. */
export async function uiDecision(page: Page, toolbarName: string, confirmName: string, opinion: string): Promise<void> {
  await actionBar(page).getByRole('button', { name: toolbarName, exact: true }).click();
  const m = topModal(page);
  await fieldOf(m, 'Ý kiến').locator('textarea').fill(opinion);
  await m.locator('.ant-modal-footer').getByRole('button', { name: confirmName, exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 25_000 });
}

/** Gửi duyệt (nháp / bị trả về / từ chối): toolbar "Gửi duyệt" → xác nhận trong modal. */
export async function uiSubmit(page: Page): Promise<void> {
  await actionBar(page).getByRole('button', { name: 'Gửi duyệt', exact: true }).click();
  const m = topModal(page);
  await m.locator('.ant-modal-footer').getByRole('button', { name: 'Gửi duyệt', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 25_000 });
}

/** Huỷ hồ sơ (v2 §7.1): toolbar "Hủy hồ sơ" → nhập lý do (≥ 5 ký tự) → nút "Hủy hồ sơ" trong modal. */
export async function uiCancel(page: Page, reason: string): Promise<void> {
  await actionBar(page).getByRole('button', { name: 'Hủy hồ sơ', exact: true }).click();
  const m = topModal(page);
  await fieldOf(m, 'Ý kiến').locator('textarea').fill(reason);
  await m.locator('.ant-modal-footer').getByRole('button', { name: 'Hủy hồ sơ', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 25_000 });
}

/** Thực thi phiếu chi: toolbar "Thực thi" → nhập số tham chiếu ngân hàng → xác nhận. */
export async function uiPay(page: Page, bankRef: string): Promise<void> {
  await actionBar(page).getByRole('button', { name: 'Thực thi', exact: true }).click();
  const m = topModal(page);
  await fieldOf(m, 'Số tham chiếu ngân hàng').locator('input').fill(bankRef);
  await m.locator('.ant-modal-footer').getByRole('button', { name: /^Thực thi/ }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 25_000 });
}

/** Ô tìm trong danh sách hồ sơ (DocListScreen): gõ, chờ debounce 300ms và tải xong dữ liệu. */
export async function searchList(page: Page, text: string): Promise<void> {
  const box = page.getByLabel('Tìm kiếm trong danh sách');
  await expect(box).toBeVisible({ timeout: 20_000 });
  await box.fill(text);
  await page.waitForTimeout(700);
  await page.waitForLoadState('networkidle');
}

/** Hàng trong bảng có mã phiếu (tránh khớp nhầm hàng tiêu đề). */
export function rowOf(page: Page, code: string): Locator {
  return page.locator('tr', { hasText: code });
}

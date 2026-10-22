/**
 * E2E khu vực "vouchers" (v2/v2.md §5.2, §6, §7, §8; US-VOU-01/05/06, US-APR-01..03, US-EXE-01).
 *
 *   PW_AREA=vouchers npx playwright test e2e/v2-vouchers.spec.ts
 *
 * Chạy với app đang bật (web :5139, API :8024) — spec KHÔNG tự khởi động server.
 * Mỗi test tự tạo đối tác / tài khoản / phiếu bằng tên uniq() và chỉ so sánh số liệu của chính mình,
 * nên có thể chạy cạnh các tiến trình khác dùng chung CSDL test.
 *
 * Quy ước: test mang tên "…" khẳng định ĐÚNG spec. Test nào đỏ vì hành vi lệch spec là phát hiện lỗi app
 * (không sửa spec cho khớp app). Các test cần số dư / thực thi đi qua chuỗi duyệt thực tế của server
 * (approveToFinal), để kiểm tra phần nghiệp vụ đó mà không phụ thuộc vào lỗi chuỗi duyệt.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test, expect, uniq } from './fixtures';
import * as H from './helpers-vouchers';

const CO_NAME = H.CTA_CODE;
const SPEND = 5_000_000;
// 50 triệu – 5 tỷ theo bảng §7.2. CTA có ngưỡng Chủ tịch riêng cho phiếu chi (ADM-04: 70 triệu),
// nên mẫu trong dải này phải nằm dưới ngưỡng đó để chuỗi không có Chủ tịch.
const BAND_50M_5B = 60_000_000;
const SIX_BILLION = 6_000_000_000; // > 5 tỷ: cần gõ lại số tiền và có cấp Chủ tịch

/** Phiếu có trong "Chờ tôi duyệt" của người dùng không (máy chủ lọc theo tên đối tác). */
async function inQueue(page: import('@playwright/test').Page, co: string, partner: string, code: string): Promise<boolean> {
  const r = await H.api(page, 'GET', `/queue?q=${encodeURIComponent(partner)}&limit=100`, { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const items = (r.body?.items ?? H.unwrap<{ items?: { code: string }[] }>(r.body)?.items ?? []) as { code: string }[];
  return items.some((i) => i.code === code);
}

/** Hai phiếu chi cùng đối tác: một đang chờ KTT (chưa ai duyệt), một đã qua KTT (đang chờ GĐ). */
async function pendingPair(staff: import('@playwright/test').Page, chief: import('@playwright/test').Page, co: string): Promise<{ partner: string; codeKtt: string; codeGd: string }> {
  const partner = uniq('Đối tác CHI-04');
  const partnerId = await H.createPartner(staff, co, 'supplier', partner);
  const accountId = await H.createAccount(chief, co, uniq('NH CHI-04'));
  const ktt = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BAND_50M_5B, title: uniq('CHI-04 chờ KTT') });
  const gd = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BAND_50M_5B, title: uniq('CHI-04 chờ GĐ') });
  await H.approveApi(chief, co, gd.id);
  await H.expectStatus(chief, co, gd.id, 'pending.gd');
  const codeKtt = String((await H.getDoc(staff, co, ktt.id)).code);
  const codeGd = String((await H.getDoc(staff, co, gd.id)).code);
  return { partner, codeKtt, codeGd };
}

/* ------------------------------------------------------------------ *
 * Vòng kiểm thử lại (round 6): số đếm theo phạm vi, phương án đảo hạn, cạnh Đang thanh toán → Yêu cầu bổ sung.
 * ------------------------------------------------------------------ */

type Pg = import('@playwright/test').Page;

/** Ngày hôm nay theo múi giờ VN (YYYY-MM-DD) và phép cộng ngày trên chuỗi YYYY-MM-DD. */
function vnToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Số đếm "Chờ tôi duyệt" của một phạm vi: `summary.count` (chân danh sách, huy hiệu) và `total` trong CÙNG một lượt đọc. */
async function queueCounts(page: Pg, co: string): Promise<{ count: number; total: number }> {
  const r = await H.api(page, 'GET', '/queue?limit=1', { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const q = H.unwrap<{ total: number; summary: { count: number } }>(r.body);
  return { count: q.summary.count, total: q.total };
}

/** Số hồ sơ trên chân danh sách "Chờ tôi duyệt" (`N hồ sơ · tổng …`); -1 khi chân chưa hiện. */
async function listFooterCount(page: Pg): Promise<number> {
  const foot = page.getByText(/hồ sơ · tổng/).first();
  if ((await foot.count()) === 0) return -1;
  const m = ((await foot.innerText()) ?? '').match(/(\d+)\s*hồ sơ/);
  return m ? Number(m[1]) : -2;
}

/** Chân danh sách "Chờ tôi duyệt" đọc từ API: số hồ sơ, tổng tiền (minor, dạng chuỗi) và chuỗi rút gọn của cùng lượt đọc. */
async function queueSummary(page: Pg, co: string): Promise<{ count: number; amount: string; compact: string }> {
  const r = await H.api(page, 'GET', '/queue?limit=1', { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const s = H.unwrap<{ summary: { count: number; amount: string; compact: string } }>(r.body).summary;
  return { count: s.count, amount: String(s.amount), compact: String(s.compact) };
}

/** Chạy đoạn mongosh trên CSDL test (container `fingate-mongo`, như v2-auto-r2) và đọc dòng JSON cuối. */
function mongoEval<T>(script: string): T {
  const out = execFileSync('docker', ['exec', 'fingate-mongo', 'mongosh', '--quiet', 'fingate', '--eval', script], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const last = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? 'null';
  return JSON.parse(last) as T;
}

/** Số hồ sơ và tổng tiền (minor) của mọi phiếu chi đang chờ thực thi trong công ty — đúng tập mà hàng chờ của KTV liệt kê. */
function executionTotalInDb(co: string): { n: number; sum: string } {
  return mongoEval<{ n: number; sum: string }>(
    `const c = ObjectId('${co}'); let n = 0; let sum = 0n; db.documents.find({ company_id: c, kind: 'spend', status: { $in: ['approved', 'processing'] } }, { 'amount.minor': 1 }).forEach((d) => { n++; sum += BigInt(d.amount.minor.toString()); }); print(JSON.stringify({ n: n, sum: sum.toString() }));`,
  );
}

/** Chuẩn hoá khoảng trắng (kể cả khoảng trắng không ngắt) để so chuỗi trên màn với chuỗi máy chủ. */
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Người xem hàng chờ: mã người dùng, vai trò trong công ty, có quyền thực thi (payment:mark) — đúng dữ liệu máy chủ dùng để lọc. */
interface Viewer {
  userId: string;
  role: string;
  canPay: boolean;
}
async function viewerOf(page: Pg, co: string): Promise<Viewer> {
  const r = await H.api(page, 'GET', '/me', { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const me = H.unwrap<{
    user_id: string;
    assignments?: { company_id: string; role: string }[];
    entitlements?: { role?: string; permissions?: string[] };
  }>(r.body);
  const a = (me.assignments ?? []).find((x) => String(x.company_id) === co);
  return {
    userId: String(me.user_id),
    role: String(a?.role ?? me.entitlements?.role ?? ''),
    canPay: (me.entitlements?.permissions ?? []).includes('payment:mark'),
  };
}

/**
 * Hàng chờ "Chờ tôi duyệt" của một người xem, tính từ CSDL theo đúng luật máy chủ (queue / awaitingBadge):
 * bước của người đó là cấp thấp nhất còn chờ, hoặc (có quyền thực thi) phiếu chi đã duyệt / đang thanh toán.
 */
function queueTruthInDb(co: string, v: Viewer): { n: number; sum: string } {
  return mongoEval<{ n: number; sum: string }>(
    `const co = ObjectId('${co}'); const uid = '${v.userId}'; const role = '${v.role}'; const canPay = ${v.canPay ? 'true' : 'false'};` +
      ` const st = ['pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman'].concat(canPay ? ['approved', 'processing'] : []);` +
      ` let n = 0; let sum = 0n;` +
      ` db.documents.find({ company_id: co, status: { $in: st } }, { status: 1, kind: 1, 'amount.minor': 1, 'approval.steps': 1 }).forEach((d) => {` +
      ` const steps = (d.approval && d.approval.steps) || [];` +
      ` const pend = steps.filter((s) => s.state === 'current' || s.state === 'waiting');` +
      ` let mine = false;` +
      ` if (pend.length) { const min = Math.min(...pend.map((s) => s.order)); const s = pend.find((x) => x.order === min); mine = s.user_id != null ? String(s.user_id) === uid : s.role === role; }` +
      ` const exec = canPay && d.kind === 'spend' && (d.status === 'approved' || d.status === 'processing');` +
      ` if (mine || exec) { n++; sum += BigInt(String(d.amount.minor)); } });` +
      ` print(JSON.stringify({ n: n, sum: sum.toString() }));`,
  );
}

/** "" khi chân "Chờ tôi duyệt" của máy chủ (số hồ sơ, tổng tiền) khớp CSDL; ngược lại mô tả chỗ lệch để báo lỗi. */
async function queueDiffVsDb(page: Pg, co: string, v: Viewer): Promise<string> {
  const a = await queueSummary(page, co);
  const truth = queueTruthInDb(co, v);
  const b = await queueSummary(page, co);
  if (a.count !== b.count || a.amount !== b.amount) return `hàng chờ đổi trong lúc đọc (${a.count} → ${b.count} hồ sơ)`;
  if (truth.n !== a.count) return `số hồ sơ: máy chủ ${a.count}, CSDL ${truth.n}`;
  if (truth.sum !== a.amount) {
    return `tổng tiền: máy chủ ${a.amount}, CSDL ${truth.sum} (lệch ${BigInt(truth.sum) - BigInt(a.amount)} đ trên ${a.count} hồ sơ)`;
  }
  return '';
}

/** "" khi thẻ "chờ tôi duyệt" của tổng quan hôm nay (`/dashboard/today`) khớp CSDL. */
async function todayDiffVsDb(page: Pg, co: string, v: Viewer): Promise<string> {
  const truth = queueTruthInDb(co, v);
  const r = await H.api(page, 'GET', '/dashboard/today', { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const minor = String(H.unwrap<{ awaiting?: { amount?: { minor?: unknown } } }>(r.body)?.awaiting?.amount?.minor ?? '');
  return minor === truth.sum ? '' : `thẻ tổng quan hôm nay: máy chủ ${minor}, CSDL ${truth.sum}`;
}

/** "" khi KPI "Chờ tôi duyệt" của tổng quan (số khoản và tổng tiền) khớp CSDL. */
async function overviewDiffVsDb(page: Pg, co: string, v: Viewer): Promise<string> {
  const truth = queueTruthInDb(co, v);
  const r = await H.api(page, 'GET', '/dashboard/overview', { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const o = H.unwrap<{ kpi?: { awaiting_me?: { amount?: { minor?: unknown } } }; counts?: { awaiting_me?: number } }>(r.body);
  const cnt = o.counts?.awaiting_me;
  const amt = String(o.kpi?.awaiting_me?.amount?.minor ?? '');
  if (cnt !== truth.n) return `tổng quan: số khoản máy chủ ${cnt}, CSDL ${truth.n}`;
  return amt === truth.sum ? '' : `KPI tổng quan: máy chủ ${amt}, CSDL ${truth.sum}`;
}

/** Chân danh sách trên màn ("N hồ sơ · tổng X đang chờ") → "N | X"; "" khi chân chưa hiện. */
async function listFooterText(page: Pg): Promise<string> {
  const foot = page.getByText(/hồ sơ · tổng/).first();
  await foot.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  if ((await foot.count()) === 0) return '';
  const t = norm((await foot.innerText()) ?? '');
  const m = t.match(/(\d+)\s*hồ sơ · tổng\s*(.+?)\s*đang chờ/);
  return m ? `${m[1]} | ${m[2]}` : `không đọc được chân danh sách: ${t}`;
}

/** Thẻ "Chờ tôi duyệt" (KPI) trên Tổng quan: số tiền rút gọn đang hiện; "" khi chưa thấy thẻ. */
async function dashboardKpiText(page: Pg): Promise<string> {
  const card = page.locator('.fg-kpi').filter({ hasText: 'Chờ tôi duyệt' }).first();
  await card.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => undefined);
  if ((await card.count()) === 0) return '';
  return norm((await card.locator('.fg-kpi-value').first().textContent()) ?? '');
}

/** Số thông báo web của người dùng gắn với một hồ sơ (tuỳ chọn: tiêu đề khớp mẫu). Hộp thư: GET /notifications (NOTI-01). */
async function notificationsOf(page: Pg, co: string, docId: string, title?: RegExp): Promise<number> {
  const r = await H.api(page, 'GET', '/notifications?limit=100', { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const items = (H.unwrap<{ items?: { document_id?: unknown; title?: string }[] }>(r.body)?.items ?? []) as { document_id?: unknown; title?: string }[];
  return items.filter((n) => String(n.document_id ?? '') === docId && (title ? title.test(String(n.title ?? '')) : true)).length;
}

/**
 * Đợi tới khi số thông báo khớp đạt ngưỡng (thông báo ghi SAU chuyển trạng thái, best-effort, không nằm trong giao dịch),
 * tối đa ~20 giây. Trả về số đọc được lần cuối.
 */
async function notificationsWait(page: Pg, co: string, docId: string, title: RegExp, atLeast: number): Promise<number> {
  let n = 0;
  for (let i = 0; i < 20; i++) {
    n = await notificationsOf(page, co, docId, title);
    if (n >= atLeast) return n;
    await page.waitForTimeout(1_000);
  }
  return n;
}

/** Mã phiếu của MỘT trang danh sách (`/queue` hoặc `/documents`, phân trang theo page/limit) và tổng số hồ sơ. */
async function pageCodes(page: Pg, co: string, path: string, query: string): Promise<{ total: number; codes: string[] }> {
  const r = await H.api(page, 'GET', `${path}?${query}`, { scope: co });
  expect(r.status, r.text).toBeLessThan(300);
  const body = H.unwrap<{ items?: { code: string }[]; total?: number }>(r.body);
  return { total: Number(body.total ?? 0), codes: (body.items ?? []).map((i) => String(i.code)) };
}

/** Nhãn huy hiệu antd: rỗng khi 0 (antd ẩn), "99+" khi trên 99. */
function badgeLabel(n: number): string {
  return n === 0 ? '' : n > 99 ? '99+' : String(n);
}
async function headerBadgeLabel(page: Pg): Promise<string> {
  const sup = page.locator('a[aria-label="Chờ tôi duyệt"] .ant-badge-count').first();
  if ((await sup.count()) === 0) return '';
  return ((await sup.textContent()) ?? '').trim();
}

/** Số trong nút "Xem tất cả (N)" của thẻ "Chờ … duyệt" trên Tổng quan; -1 khi chưa thấy. */
async function dashboardAwaitingCount(page: Pg): Promise<number> {
  const link = page.locator('a[href="/cho-toi-duyet"]').filter({ hasText: /Xem tất cả \(\d+\)/ }).first();
  if ((await link.count()) === 0) return -1;
  const m = ((await link.textContent()) ?? '').match(/\((\d+)\)/);
  return m ? Number(m[1]) : -1;
}

/** Đọc số trên chân danh sách sau khi đã hiện (chờ tối đa 10 giây để màn tải xong). */
async function listFooterShown(page: Pg): Promise<number> {
  await page.getByText(/hồ sơ · tổng/).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  return listFooterCount(page);
}
/** Đọc huy hiệu thanh đầu sau khi đã hiện (không có huy hiệu khi bằng 0). */
async function headerBadgeShown(page: Pg): Promise<string> {
  await page.locator('a[aria-label="Chờ tôi duyệt"] .ant-badge-count').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  return headerBadgeLabel(page);
}
/** Đọc thẻ tổng quan sau khi đã hiện. */
async function dashboardShown(page: Pg): Promise<number> {
  await page
    .locator('a[href="/cho-toi-duyet"]')
    .filter({ hasText: /Xem tất cả \(\d+\)/ })
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => undefined);
  return dashboardAwaitingCount(page);
}

/**
 * Số trên màn phải khớp số API của cùng phạm vi. Màn không tự làm mới số khi hàng chờ đổi (tiến trình khác), nên khi
 * lệch thì tải lại trang và đọc lại — tối đa 3 lượt. Lệch cả 3 lượt là lỗi của app (số của phạm vi khác / số cũ).
 */
async function expectShownCount(page: Pg, what: string, shown: () => Promise<number | string>, want: () => Promise<number | string>): Promise<void> {
  let s: number | string = '';
  let w: number | string = '';
  for (let i = 0; i < 3; i++) {
    s = await shown();
    w = await want();
    if (s === w) return;
    await page.waitForTimeout(1_000);
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  expect(s, `${what}: số trên màn phải khớp hàng chờ của phạm vi đang chọn`).toBe(w);
}

/** Đổi phạm vi dữ liệu bằng ô "Phạm vi dữ liệu" trên thanh đầu, chọn công ty theo mã (CTA, CTB…). */
async function switchScopeUi(page: Pg, code: string): Promise<void> {
  await page.getByRole('button', { name: 'Phạm vi dữ liệu', exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${code}\\s`) }).click();
}

/**
 * Phương án đảo hạn (kind `rollover`) đã duyệt xong: tạo ngân hàng + khoản vay đang vay trong công ty,
 * lập phương án gắn khoản vay, đính kèm HĐ, gửi duyệt và duyệt tới cấp cuối.
 */
async function approvedRolloverApi(staff: Pg, pages: { chief: Pg; director: Pg; chairman: Pg }, co: string): Promise<{ id: string }> {
  const bankId = await H.createPartner(staff, co, 'bank', uniq('NH đảo hạn kiểm thử'));
  const accountId = await H.createAccount(pages.chief, co, uniq('NH đảo hạn TK'));
  const today = vnToday();
  const loan = await H.api(staff, 'POST', '/bank-debts', {
    scope: co,
    data: {
      company_id: co,
      partner_id: bankId,
      amount: { amount_minor: '30000000', currency: 'VND' },
      disbursed_date: addDaysIso(today, -60),
      maturity_date: addDaysIso(today, 20),
      interest_rate: '9,5',
      contract_no: uniq('HDTD đảo hạn').slice(0, 60),
    },
  });
  expect(loan.status, `tạo khoản vay đang đảo hạn: ${loan.text}`).toBeLessThan(300);
  const loanId = String(H.unwrap<{ _id: string }>(loan.body)._id);
  const r = await H.api(staff, 'POST', '/documents', {
    scope: co,
    data: {
      kind: 'rollover',
      company_id: co,
      title: uniq('Phương án đảo hạn'),
      purpose: 'Phương án đảo hạn kiểm thử',
      partner_id: bankId,
      loan_id: loanId,
      amount: { amount_minor: '30000000', currency: 'VND' },
      source: { fund: 'bank', account_id: accountId, group_managed: false },
      planned_date: H.DEADLINE_ISO,
      priority: 'normal',
      category_id: null,
      budget: { budget_id: null, line_id: null, in_plan: true },
      contract: {},
      tag_ids: [],
      options: { loan: null },
      transfer_target: null,
      rollover: {
        need_amount: { amount_minor: '30000000', currency: 'VND' },
        plan: 'Gia hạn 12 tháng (kiểm thử)',
        new_maturity_date: addDaysIso(today, 385),
        new_rate: '9,5',
      },
    },
  });
  expect(r.status, `tạo phương án đảo hạn: ${r.text}`).toBeLessThan(300);
  const id = String(H.unwrap<{ _id: string }>(r.body)._id);
  // chứng từ bắt buộc mặc định của phương án đảo hạn là "Lịch trả nợ" (side-effects.ts requiredEvidenceFor)
  await H.attachApi(staff, co, id, 'loan_schedule' as unknown as 'contract', 'lich-tra-no-dao-han.pdf');
  await H.submitApi(staff, co, id);
  expect(await H.approveToFinal(pages, co, id), 'phương án đảo hạn: duyệt xong cấp cuối').toBe('approved');
  return { id };
}

test.describe('Phiếu thu/chi, phê duyệt và thực thi (CTA)', () => {
  /* ------------------------------------------------------------------ */
  test('KTV lập phiếu chi CTA (đối tác, tài khoản nguồn, số tiền, nội dung) và gửi duyệt', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    // lỗi JavaScript không bắt được trên trang nhân viên trong suốt luồng lập phiếu (pageerror = lỗi app)
    const pageErrors: string[] = [];
    staff.on('pageerror', (e) => pageErrors.push(e.message));
    // lời gọi mạng lỗi trong luồng: 4xx được ghi lại để biết nguồn; 5xx hoặc 4xx từ API là lỗi app
    const networkErrors: string[] = [];
    staff.on('response', (r) => {
      if (r.status() < 400) return;
      console.log(`[http ${r.status()} staff] ${r.request().method()} ${r.url()}`);
      if (r.url().includes('/api/')) networkErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    });
    const co = await H.companyId(staff, CO_NAME);
    const supplier = uniq('NCC lập phiếu');
    const partnerId = await H.createPartner(staff, co, 'supplier', supplier, { bank: 'Vietcombank', account: '0123456789', tax: '0312345678' });
    const bankName = uniq('NH chi lập phiếu');
    const accountId = await H.createAccount(chief, co, bankName);

    const { id } = await H.uiCreateVoucher(staff, {
      kind: 'spend',
      partnerName: supplier,
      accountName: bankName,
      amount: SPEND,
      title: uniq('Thanh toán kiểm thử'),
      purpose: 'Thanh toán đợt 1 theo hợp đồng kiểm thử',
      submit: true,
    });

    const doc = await H.getDoc(staff, co, id);
    expect(doc.status, 'gửi duyệt ngay → chờ KTT').toBe('pending.ktt');
    expect(String(doc.code), 'mã phiếu sinh khi gửi duyệt').not.toMatch(/^DRAFT-/);
    expect(doc.partner_id, 'phiếu lưu đúng partner_id').toBe(partnerId);
    expect(doc.source.account_id, 'tài khoản nguồn đã chọn').toBe(accountId);
    expect(String(doc.amount.minor)).toBe(String(SPEND));

    await expect(staff.getByText('Chờ Kế toán trưởng').first()).toBeVisible();
    // thẻ đối tác (v2 §5.2): tên + STK hiển thị từ đối tác
    await expect(staff.getByText(supplier).first()).toBeVisible();
    await expect(staff.getByText('STK: 0123456789')).toBeVisible();
    expect(pageErrors, 'không có lỗi JavaScript trên trang trong luồng lập phiếu và gửi duyệt').toEqual([]);
    expect(networkErrors, 'không có lời gọi API lỗi (4xx/5xx) trong luồng lập phiếu và gửi duyệt').toEqual([]);
  });

  /* ------------------------------------------------------------------ */
  test('lập phiếu thiếu đối tác và số tiền: báo lỗi trên form, không rời form', async ({ as }) => {
    test.setTimeout(120_000);
    const staff = await as('staff');
    const purpose = uniq('Nội dung thiếu đối tác');
    await H.gotoCta(staff, '/chi/moi');
    await expect(staff.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 20_000 });
    await H.fieldOf(staff, 'Nội dung / mục đích').locator('textarea').fill(purpose);
    await staff.getByRole('button', { name: 'Lưu nháp', exact: true }).click();

    await expect(staff.getByRole('alert').filter({ hasText: 'Chọn đối tác' })).toBeVisible();
    await expect(staff.getByRole('alert').filter({ hasText: 'Nhập số tiền' })).toBeVisible();
    await expect(staff).toHaveURL(/\/chi\/moi$/);
  });

  /* ------------------------------------------------------------------ */
  test('KTV đính kèm chứng từ (hợp đồng, hóa đơn) trên hồ sơ nháp: tệp đúng loại, hiện trên hồ sơ', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC chứng từ'));
    const accountId = await H.createAccount(chief, co, uniq('NH chứng từ'));
    const { id } = await H.createVoucherApi(staff, co, {
      kind: 'spend',
      partnerId,
      accountId,
      amount: SPEND,
      title: uniq('Phiếu có chứng từ'),
      purpose: 'Nội dung kiểm thử chứng từ',
    });

    await H.openDoc(staff, 'spend', id);
    await staff.getByRole('tab', { name: /Chứng từ/ }).click();
    await expect(staff.getByRole('button', { name: '+ Tải chứng từ lên' })).toBeEnabled();

    await H.uiUploadEvidence(staff, 'Hợp đồng', 'hop-dong-kiem-thu.pdf');
    await expect(staff.getByRole('tab', { name: /Chứng từ \(1\// })).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByText('hop-dong-kiem-thu.pdf')).toBeVisible();

    await H.uiUploadEvidence(staff, 'Hóa đơn', 'hoa-don-kiem-thu.pdf');
    await expect(staff.getByRole('tab', { name: /Chứng từ \(2\// })).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByText('hoa-don-kiem-thu.pdf')).toBeVisible();

    const doc = await H.getDoc(staff, co, id);
    expect(doc.attachments.map((a: { type: string }) => a.type).sort()).toEqual(['contract', 'invoice']);
  });

  /* ------------------------------------------------------------------ */
  test('chuỗi duyệt §7.2: "Chờ tôi duyệt" đúng bàn; GĐ duyệt trước khi KTT xong; chuỗi chỉ KTT → GĐ', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const co = await H.companyId(staff, CO_NAME);
    const partner = uniq('Đối tác chuỗi duyệt');
    const partnerId = await H.createPartner(staff, co, 'supplier', partner);
    const accountId = await H.createAccount(chief, co, uniq('NH chuỗi duyệt'));
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BAND_50M_5B, title: uniq('Chuỗi duyệt') });
    const code = String((await H.getDoc(staff, co, id)).code);
    await H.expectStatus(staff, co, id, 'pending.ktt');

    // "Chờ tôi duyệt" (máy chủ, lọc theo tên đối tác): chỉ KTT thấy khi KTT là cấp thấp nhất còn chờ
    expect(await inQueue(director, co, partner, code), 'GĐ chưa đến lượt: không có trong hàng chờ').toBe(false);
    expect(await inQueue(chief, co, partner, code), 'KTT đúng bàn: có trong hàng chờ').toBe(true);

    // Giám đốc chưa đến lượt nhưng hồ sơ hiện "Duyệt trước" (vượt cấp), không có nút duyệt thường
    await H.openDoc(director, 'spend', id);
    await expect(H.actionBar(director).getByRole('button', { name: /^Duyệt trước/ })).toBeVisible();
    await expect(H.actionBar(director).getByRole('button', { name: /^Duyệt khoản/ })).toHaveCount(0);

    await H.openDoc(chief, 'spend', id);
    await H.uiApprove(chief);
    await H.expectStatus(chief, co, id, 'pending.gd');
    await expect(chief.getByText('Chờ Giám đốc').first()).toBeVisible();

    // sau khi KTT duyệt: KTT hết việc, GĐ vào hàng chờ
    expect(await inQueue(chief, co, partner, code), 'KTT đã duyệt: rời hàng chờ').toBe(false);
    expect(await inQueue(director, co, partner, code), 'GĐ đến lượt: vào hàng chờ').toBe(true);

    // §7.2 (50 triệu – 5 tỷ): KTT → PGĐ → GĐ; công ty không có PGĐ/P.TGĐ nên chuỗi chỉ còn KTT → GĐ.
    // Chủ tịch chỉ được thêm khi vượt ngưỡng (không do cấp dưới khuyết).
    const doc = await H.getDoc(chief, co, id);
    const roles = ((doc.approval?.steps ?? []) as { role: string }[]).map((s) => s.role);
    expect(roles, 'chuỗi duyệt cho 50 triệu – 5 tỷ không có Chủ tịch').toEqual(['chief_accountant', 'director']);
  });

  test('chuỗi duyệt §7.2: phiếu dưới 50 triệu chỉ qua KTT → PGĐ; CTA khuyết PGĐ nên không có GĐ trong chuỗi', async ({ as }) => {
    test.setTimeout(180_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('Đối tác dưới 50 triệu'));
    const accountId = await H.createAccount(chief, co, uniq('NH dưới 50 triệu'));
    // SPEND = 5 triệu: thuộc khoảng "< 50 triệu" của bảng §7.2
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Dưới 50 triệu') });
    const doc = await H.getDoc(staff, co, id);
    const roles = ((doc.approval?.steps ?? []) as { role: string }[]).map((s) => s.role);
    expect(roles, 'phiếu dưới 50 triệu: §7.2 là KTT → PGĐ; PGĐ khuyết nên chuỗi chỉ còn KTT (không thêm GĐ)').toEqual(['chief_accountant']);
  });

  test('ô tìm trên "Chờ tôi duyệt" lọc danh sách theo tên đối tác', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partner = uniq('Đối tác tìm hàng chờ');
    const partnerId = await H.createPartner(staff, co, 'supplier', partner);
    const accountId = await H.createAccount(chief, co, uniq('NH tìm hàng chờ'));
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Tìm hàng chờ') });
    const code = String((await H.getDoc(staff, co, id)).code);

    await H.gotoCta(chief, '/cho-toi-duyet');
    await H.searchList(chief, partner);
    // chỉ phiếu của đối tác vừa tìm được hiện trong bảng
    await expect(chief.locator('.ant-table-tbody tr.ant-table-row'), 'kết quả tìm chỉ gồm phiếu khớp').toHaveCount(1, { timeout: 20_000 });
    await expect(H.rowOf(chief, code)).toBeVisible();
  });

  test('US-APR-01: số đếm "chờ tôi duyệt" (chân danh sách và thẻ tổng quan) khớp đúng phạm vi công ty đang chọn, không giữ số của phạm vi trước', async ({ as }) => {
    test.setTimeout(180_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const coB = await H.companyId(staff, 'CTB');
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC đếm chờ'));
    const accountId = await H.createAccount(chief, co, uniq('NH đếm chờ'));
    // phiếu gửi duyệt ở CTA: KTT (chief) có việc ở CTA
    await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq("Đếm chờ") });
    // 1) phạm vi CTA: nạp số đếm của CTA trước (phiếu vừa gửi phải nằm trong hàng chờ CTA).
    // Không so cứng số đếm với tổng ở bước này: các tiến trình khác cùng đổi hàng chờ CTA nên hai lần gọi lệch nhau
    // là bình thường; lỗi cần kiểm tra là số đếm của PHẠM VI KHÁC (bước 2, 3).
    const inA = await H.api(chief, 'GET', '/queue?limit=1', { scope: co });
    expect(inA.status).toBeLessThan(300);
    const qA = H.unwrap<{ total: number; summary: { count: number } }>(inA.body);
    expect(qA.total, 'CTA có ít nhất một phiếu chờ KTT vừa gửi').toBeGreaterThanOrEqual(1);

    // 2) đổi sang phạm vi CTB (cùng người dùng, vừa đếm ở CTA): số đếm phải theo CTB, không giữ số của CTA
    const inB = await H.api(chief, 'GET', '/queue?limit=1', { scope: coB });
    expect(inB.status).toBeLessThan(300);
    const qB = H.unwrap<{ total: number; summary: { count: number } }>(inB.body);
    expect(qB.summary.count, `phạm vi CTB: số đếm (${qB.summary.count}) phải khớp danh sách CTB (${qB.total}), không lấy số của CTA (${qA.total})`).toBe(qB.total);

    // 3) thẻ tổng quan (dashboard) theo phạm vi CTB cũng phải khớp danh sách CTB
    const dash = await H.api(chief, 'GET', '/dashboard/today', { scope: coB });
    expect(dash.status).toBeLessThan(300);
    const awaiting = H.unwrap<{ awaiting?: { count: number } }>(dash.body)?.awaiting?.count;
    expect(awaiting, 'thẻ tổng quan phạm vi CTB: chờ tôi duyệt khớp danh sách CTB').toBe(qB.total);
  });

  test('Chờ tôi duyệt: ô chọn đối tác và ô chọn tag thu hẹp bảng; hai phiếu cùng tag hiện đủ chip, không lỗi', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerA = uniq('Đối tác hàng chờ A');
    const partnerB = uniq('Đối tác hàng chờ B');
    const pA = await H.createPartner(staff, co, 'supplier', partnerA);
    const pB = await H.createPartner(staff, co, 'supplier', partnerB);
    const accountId = await H.createAccount(chief, co, uniq('NH hàng chờ lọc'));
    const tagName = uniq('Tag hàng chờ');
    const tagId = await H.createTag(staff, co, tagName);
    // hai phiếu của hai đối tác khác nhau, cùng một tag
    const a = await H.submittedVoucherApi(staff, co, { partnerId: pA, accountId, amount: SPEND, title: uniq('Hàng chờ A'), tagIds: [tagId] });
    const b = await H.submittedVoucherApi(staff, co, { partnerId: pB, accountId, amount: SPEND, title: uniq('Hàng chờ B'), tagIds: [tagId] });
    const codeA = String((await H.getDoc(staff, co, a.id)).code);
    const codeB = String((await H.getDoc(staff, co, b.id)).code);

    // ô chọn đối tác: chỉ còn phiếu của đối tác A
    await H.gotoCta(chief, '/cho-toi-duyet');
    const partnerBox = chief.getByRole('combobox', { name: 'Lọc theo đối tác' });
    await partnerBox.click();
    await partnerBox.fill(partnerA);
    await chief.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: partnerA }).first().click();
    await expect.poll(() => new URL(chief.url()).searchParams.get('partner_id') ?? '', 'bộ lọc đối tác lên URL').toBe(pA);
    await expect(H.rowOf(chief, codeA), 'hàng chờ lọc theo đối tác: có phiếu của A').toBeVisible({ timeout: 20_000 });
    await expect(H.rowOf(chief, codeB), 'hàng chờ lọc theo đối tác: không có phiếu của B').toHaveCount(0);
    await expect(chief.locator('.ant-table-tbody tr.ant-table-row'), 'đúng một hàng khớp đối tác').toHaveCount(1);

    // ô chọn tag: bỏ lọc đối tác, chọn tag dùng chung → cả hai phiếu, mỗi hàng có chip tag đầy đủ
    await H.gotoCta(chief, '/cho-toi-duyet');
    const tagBox = chief.getByRole('combobox', { name: 'Lọc theo tag' });
    await tagBox.click();
    await tagBox.fill(tagName);
    await chief.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: tagName }).first().click();
    await expect.poll(() => new URL(chief.url()).searchParams.get('tag_ids') ?? '', 'bộ lọc tag lên URL').toContain(tagId);
    await expect(H.rowOf(chief, codeA), 'hàng chờ lọc theo tag: có phiếu A').toBeVisible({ timeout: 20_000 });
    await expect(H.rowOf(chief, codeB), 'hàng chờ lọc theo tag: có phiếu B').toBeVisible();
    await expect(H.rowOf(chief, codeA).getByText(tagName, { exact: true }), 'chip tag hiện ở phiếu A').toBeVisible();
    await expect(H.rowOf(chief, codeB).getByText(tagName, { exact: true }), 'chip tag hiện ở phiếu B').toBeVisible();
    await expect(chief.getByText('Hệ thống đang gặp sự cố'), 'hàng chờ không báo lỗi hệ thống').toHaveCount(0);
  });

  test('KTT từ chối phiếu; KTV gửi lại; lịch sử giữ cả hai lượt', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC từ chối'));
    const accountId = await H.createAccount(chief, co, uniq('NH từ chối'));
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Từ chối') });

    await H.openDoc(chief, 'spend', id);
    await H.uiDecision(chief, 'Từ chối', 'Từ chối', 'Thiếu biên bản nghiệm thu kèm theo');
    await H.expectStatus(chief, co, id, 'rejected');

    await H.openDoc(staff, 'spend', id);
    await expect(staff.getByText('Từ chối').first()).toBeVisible();
    await H.uiSubmit(staff);
    await H.expectStatus(staff, co, id, 'pending.ktt');

    const doc = await H.getDoc(staff, co, id);
    const actions: string[] = (doc.history ?? []).map((h: { action: string }) => h.action);
    expect(actions, 'lịch sử có lượt từ chối').toContain('reject');
    expect(actions.filter((a) => a === 'submit').length, 'lịch sử có hai lần gửi duyệt').toBeGreaterThanOrEqual(2);
  });

  /* ------------------------------------------------------------------ */
  test('KTT yêu cầu bổ sung; KTV sửa và gửi lại; nhật ký giữ lượt cũ với nhãn tiếng Việt', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC bổ sung'));
    const accountId = await H.createAccount(chief, co, uniq('NH bổ sung'));
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Bổ sung') });

    const opinion = 'Cần bổ sung phụ lục điều chỉnh giá';
    await H.openDoc(chief, 'spend', id);
    await H.uiDecision(chief, 'Yêu cầu bổ sung', 'Yêu cầu bổ sung', opinion);
    await H.expectStatus(chief, co, id, 'changes_requested');

    // KTV: Sửa → đổi nội dung → Lưu → Gửi duyệt lại
    const newPurpose = uniq('Nội dung đã bổ sung');
    await H.openDoc(staff, 'spend', id);
    await H.actionBar(staff).getByRole('button', { name: 'Sửa', exact: true }).click();
    await staff.waitForURL(new RegExp(`/chi/${id}/sua$`), { timeout: 20_000 });
    await H.fieldOf(staff, 'Nội dung / mục đích').locator('textarea').fill(newPurpose);
    await staff.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await staff.waitForURL(new RegExp(`/ho-so/chi/${id}$`), { timeout: 30_000 });
    await H.openDoc(staff, 'spend', id);
    await H.uiSubmit(staff);
    await H.expectStatus(staff, co, id, 'pending.ktt');

    const doc = await H.getDoc(staff, co, id);
    expect(doc.purpose).toBe(newPurpose);
    const actions: string[] = (doc.history ?? []).map((h: { action: string }) => h.action);
    expect(actions, 'còn lượt yêu cầu bổ sung trong lịch sử').toContain('request_changes');
    expect(actions.filter((a) => a === 'submit').length).toBeGreaterThanOrEqual(2);

    // nhật ký hồ sơ còn ý kiến của lượt cũ (lịch sử không mất) và hiển thị nhãn hành động tiếng Việt
    await staff.getByRole('tab', { name: 'Audit log' }).click();
    await expect(staff.getByText(opinion).first()).toBeVisible();
    await expect(staff.getByText('Yêu cầu bổ sung', { exact: true }).first(), 'nhãn hành động hiển thị tiếng Việt').toBeVisible();
    // không còn mã kỹ thuật thô trong nhật ký: hành động (request_changes, submit, create, update) và khoá trạng thái
    for (const raw of ['request_changes', 'submit', 'create', 'update']) {
      await expect(staff.getByText(raw, { exact: true }), `không hiện mã hành động thô "${raw}"`).toHaveCount(0);
    }
    await expect(staff.getByText(/pending\.ktt|changes_requested/), 'không hiện khoá trạng thái thô').toHaveCount(0);
    await expect(
      staff.getByText('Chờ Kế toán trưởng → Yêu cầu bổ sung', { exact: true }).first(),
      'chuyển trạng thái hiển thị nhãn tiếng Việt',
    ).toBeVisible();
  });

  /* ------------------------------------------------------------------ */
  test('KTT đổi tài khoản nguồn khi duyệt vì tài khoản ban đầu không đủ (US-APR-03)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC đổi TK'));
    const fromName = uniq('NH nguồn ban đầu');
    const toName = uniq('NH nguồn thay thế');
    const fromId = await H.createAccount(chief, co, fromName);
    const toId = await H.createAccount(chief, co, toName);
    // 50 triệu – 5 tỷ (§7.2: KTT → PGĐ → GĐ): sau KTT còn GĐ nên hồ sơ chờ Giám đốc
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId: fromId, amount: BAND_50M_5B, title: uniq('Đổi TK') });

    await H.openDoc(chief, 'spend', id);
    await H.uiApprove(chief, { account: toName });
    await H.expectStatus(chief, co, id, 'pending.gd');
    const doc = await H.getDoc(chief, co, id);
    expect(doc.source.account_id, 'tài khoản nguồn đổi sang tài khoản được chọn khi duyệt').toBe(toId);
    expect(doc.source.account_id).not.toBe(fromId);
  });

  /* ------------------------------------------------------------------ */
  test('KTT giảm số tiền khi duyệt: sửa trực tiếp; lịch sử ghi trước → sau và số tiền tại quyết định của cấp (v2 §6.3)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC giảm tiền'));
    const accountId = await H.createAccount(chief, co, uniq('NH giảm tiền'));
    // 60 triệu (dải 50 triệu – 5 tỷ, §7.2): sau KTT còn GĐ nên hồ sơ chờ Giám đốc
    const down = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BAND_50M_5B, title: uniq('Giảm tiền') });

    await H.openDoc(chief, 'spend', down.id);
    await H.uiApprove(chief, { amount: 56_000_000 });
    await H.expectStatus(chief, co, down.id, 'pending.gd');
    const doc = await H.getDoc(chief, co, down.id);
    expect(String(doc.amount.minor), 'giảm số tiền: số tiền hiệu lực là số mới').toBe('56000000');
    const chiefStep = ((doc.approval?.steps ?? []) as { role: string; amount_at_decision?: string | null }[]).find((s) => s.role === 'chief_accountant');
    expect(chiefStep?.amount_at_decision, 'bước KTT ghi số tiền tại thời điểm quyết định').toBe('56000000');
    const approveEntry = (doc.history ?? []).find((h: { action: string }) => h.action === 'approve');
    expect(approveEntry?.fields?.amount_change, 'lịch sử ghi số tiền trước → sau').toEqual({ before: '60000000', after: '56000000' });
  });

  /* ------------------------------------------------------------------ */
  test('KTT tăng số tiền khi duyệt phải GÕ LẠI số tiền mới để xác nhận (v2 §6.3, §7.2)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC tăng tiền'));
    const accountId = await H.createAccount(chief, co, uniq('NH tăng tiền'));
    // 60 triệu → 62 triệu (tăng): chờ KTT duyệt, sau đó còn GĐ
    const up = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BAND_50M_5B, title: uniq('Tăng tiền') });

    // máy chủ cũng chặn (không chỉ giao diện): duyệt kèm số tăng mà không xác nhận → 422 FG-WF-007, phiếu không đổi
    const noConfirm = await H.transitionApi(chief, co, up.id, { action: 'approve', amount_minor: '62000000' });
    expect(noConfirm.status, `API: tăng số tiền không xác nhận phải bị chặn: ${noConfirm.text}`).toBe(422);
    expect(noConfirm.body?.code, 'API: mã lỗi xác nhận tăng số tiền').toBe('FG-WF-007');
    // tiêu đề phải nêu đúng nguyên nhân: khoản 60→62 triệu nằm TRONG ngân sách nên không được gọi là "ngoài ngân sách"
    expect(String(noConfirm.body?.title ?? ''), 'API: tiêu đề FG-WF-007 không nói "ngoài ngân sách" khi chỉ tăng số tiền trong ngân sách').not.toMatch(/ngoài ngân sách/i);
    expect(String(noConfirm.body?.title ?? ''), 'API: tiêu đề FG-WF-007 nêu việc tăng số tiền').toMatch(/tăng/i);
    expect(noConfirm.body?.data?.previous_amount_minor, 'API: số tiền trước khi tăng').toBe('60000000');
    await H.expectStatus(chief, co, up.id, 'pending.ktt');
    expect(String((await H.getDoc(chief, co, up.id)).amount.minor), 'API: số tiền chưa đổi').toBe('60000000');

    await H.openDoc(chief, 'spend', up.id);
    await H.actionBar(chief).getByRole('button', { name: /^Duyệt khoản/ }).click();
    const first = H.topModal(chief);
    await H.fieldOf(first, 'Số tiền duyệt').locator('input').fill('62000000');
    await first.locator('.ant-modal-footer').getByRole('button', { name: /^Duyệt khoản/ }).click();

    // tăng số tiền: hệ thống phải yêu cầu gõ lại đúng số tiền mới (không chỉ bấm xác nhận)
    const confirm = H.topModal(chief);
    await expect(confirm.locator('.ant-modal-title').first(), 'tiêu đề hộp xác nhận tăng số tiền').toHaveText('Xác nhận tăng số tiền');
    await expect(confirm.getByText('Bạn đang tăng số tiền của phiếu chi'), 'cảnh báo tăng số tiền hiện trong hộp xác nhận').toBeVisible();
    const retype = H.fieldOf(confirm, 'Nhập lại số tiền').locator('input');
    await expect(retype, 'tăng số tiền: có ô gõ lại số tiền mới (v2 §6.3)').toBeVisible({ timeout: 5_000 });

    // gõ số cũ (chưa đúng số mới): báo lỗi không khớp, chưa gửi duyệt
    await retype.fill('60000000');
    await confirm.locator('.ant-modal-footer').getByRole('button', { name: /^Xác nhận/ }).click();
    await expect(confirm.getByText('Số tiền nhập lại KHÔNG khớp'), 'gõ sai: báo lỗi không khớp').toBeVisible();
    await H.expectStatus(chief, co, up.id, 'pending.ktt');

    // Hủy hộp xác nhận: không gửi gì, trạng thái và số tiền giữ nguyên
    await confirm.locator('.ant-modal-footer').getByRole('button', { name: 'Hủy', exact: true }).click();
    await expect(chief.locator('.ant-modal:visible').filter({ hasText: 'Xác nhận tăng số tiền' })).toHaveCount(0, { timeout: 10_000 });
    await H.expectStatus(chief, co, up.id, 'pending.ktt');
    expect(String((await H.getDoc(chief, co, up.id)).amount.minor), 'hủy xác nhận: số tiền chưa đổi').toBe('60000000');

    // mở lại: hộp duyệt vẫn giữ số 62 triệu → bấm duyệt lại mới ra hộp xác nhận tăng số tiền
    await H.topModal(chief).locator('.ant-modal-footer').getByRole('button', { name: /^Duyệt khoản/ }).click();
    await expect(H.topModal(chief).locator('.ant-modal-title').first(), 'mở lại: vẫn là hộp xác nhận tăng số tiền').toHaveText('Xác nhận tăng số tiền');

    // gõ đúng số mới → duyệt, chuyển sang GĐ
    await H.fieldOf(H.topModal(chief), 'Nhập lại số tiền').locator('input').fill('62000000');
    await H.topModal(chief).locator('.ant-modal-footer').getByRole('button', { name: /^Xác nhận/ }).click();
    await expect(chief.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 25_000 });
    await H.expectStatus(chief, co, up.id, 'pending.gd');
    const doc = await H.getDoc(chief, co, up.id);
    expect(String(doc.amount.minor), 'tăng số tiền: số tiền hiệu lực là số mới').toBe('62000000');
    const approveEntry = (doc.history ?? []).find((h: { action: string }) => h.action === 'approve');
    expect(approveEntry?.fields?.amount_change, 'lịch sử ghi số tiền trước → sau').toEqual({ before: '60000000', after: '62000000' });
  });

  /* ------------------------------------------------------------------ */
  test('phiếu trên 5 tỷ: KTT phải gõ lại đúng số tiền mới duyệt được (DS §7.14)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC 6 tỷ'));
    const accountId = await H.createAccount(chief, co, uniq('NH 6 tỷ'));
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SIX_BILLION, title: uniq('Khoản lớn') });

    // API: duyệt chưa gõ lại số tiền → 422 FG-WF-007; tiêu đề nêu đúng nguyên nhân (vượt ngưỡng, khoản vẫn trong ngân sách)
    const noRetype = await H.transitionApi(chief, co, id, { action: 'approve' });
    expect(noRetype.status, `khoản > 5 tỷ phải bị chặn khi chưa gõ lại: ${noRetype.text}`).toBe(422);
    expect(noRetype.body?.code, 'API: mã lỗi gõ lại số tiền').toBe('FG-WF-007');
    expect(String(noRetype.body?.title ?? ''), 'API: tiêu đề nêu khoản vượt ngưỡng').toMatch(/vượt ngưỡng/);
    expect(String(noRetype.body?.title ?? ''), 'API: khoản trong ngân sách không được gọi là ngoài ngân sách').not.toMatch(/ngoài ngân sách/);
    await H.expectStatus(chief, co, id, 'pending.ktt');

    await H.openDoc(chief, 'spend', id);
    await H.actionBar(chief).getByRole('button', { name: /^Duyệt khoản/ }).click();
    const first = H.topModal(chief);
    await first.locator('.ant-modal-footer').getByRole('button', { name: /^Duyệt khoản/ }).click();

    // hệ thống đòi gõ lại số tiền
    const retype = H.topModal(chief);
    await expect(retype.locator('.ant-modal-title').first()).toHaveText(/Xác nhận số tiền/);
    await H.fieldOf(retype, 'Nhập lại số tiền').locator('input').fill('5000000000');
    await retype.locator('.ant-modal-footer').getByRole('button', { name: 'Xác nhận', exact: true }).click();
    // gõ sai thì chưa duyệt
    await expect(H.topModal(chief).locator('.ant-modal-title').first()).toHaveText(/Xác nhận số tiền/);
    await H.expectStatus(chief, co, id, 'pending.ktt');

    await H.fieldOf(H.topModal(chief), 'Nhập lại số tiền').locator('input').fill(String(SIX_BILLION));
    await H.topModal(chief).locator('.ant-modal-footer').getByRole('button', { name: 'Xác nhận', exact: true }).click();
    await expect(chief.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 25_000 });
    await H.expectStatus(chief, co, id, 'pending.gd');
  });

  /* ------------------------------------------------------------------ */
  test('phiếu NGOÀI ngân sách: duyệt bị chặn FG-WF-007 và tiêu đề nêu đúng "ngoài ngân sách", không gọi là vượt ngưỡng (v2 §6.3, DS §7.14)', async ({ as }) => {
    test.setTimeout(180_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC ngoài ngân sách'));
    const accountId = await H.createAccount(chief, co, uniq('NH ngoài ngân sách'));
    // phiếu chi NGOÀI kế hoạch ngân sách (budget.in_plan = false), số tiền nhỏ: nguyên nhân chặn chỉ là ngoài ngân sách
    const created = await H.api(staff, 'POST', '/documents', {
      scope: co,
      data: {
        kind: 'spend',
        company_id: co,
        title: uniq('Khoản ngoài ngân sách'),
        purpose: 'Khoản chi ngoài kế hoạch ngân sách kiểm thử',
        partner_id: partnerId,
        amount: { amount_minor: String(SPEND), currency: 'VND' },
        source: { fund: 'bank', account_id: accountId, group_managed: false },
        planned_date: H.DEADLINE_ISO,
        priority: 'normal',
        category_id: null,
        budget: { budget_id: null, line_id: null, in_plan: false },
        contract: {},
        tag_ids: [],
        options: { loan: null },
        transfer_target: null,
      },
    });
    expect(created.status, `tạo phiếu ngoài ngân sách: ${created.text}`).toBeLessThan(300);
    const id = String(H.unwrap<{ _id: string }>(created.body)._id);
    await H.attachApi(staff, co, id, 'contract', 'hop-dong-ngoai-ngan-sach.pdf');
    await H.attachApi(staff, co, id, 'invoice', 'hoa-don-ngoai-ngan-sach.pdf');
    await H.submitApi(staff, co, id);
    await H.expectStatus(staff, co, id, 'pending.ktt');

    const r = await H.transitionApi(chief, co, id, { action: 'approve' });
    expect(r.status, `khoản ngoài ngân sách phải bị chặn khi chưa gõ lại số tiền: ${r.text}`).toBe(422);
    expect(r.body?.code, 'API: mã lỗi gõ lại số tiền').toBe('FG-WF-007');
    expect(String(r.body?.title ?? ''), 'API: tiêu đề nêu đúng nguyên nhân ngoài ngân sách').toMatch(/ngoài ngân sách/);
    expect(String(r.body?.title ?? ''), 'API: tiêu đề không gọi là vượt ngưỡng khi khoản chỉ ngoài ngân sách').not.toMatch(/vượt ngưỡng/);
    await H.expectStatus(chief, co, id, 'pending.ktt');
  });

  test('Chủ tịch duyệt vượt cấp phiếu khẩn và ghi lý do; các cấp dưới được đánh dấu bỏ qua (US-APR-02)', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC khẩn'));
    const accountId = await H.createAccount(chief, co, uniq('NH khẩn'));
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SIX_BILLION, title: uniq('Phiếu khẩn') });
    await H.expectStatus(staff, co, id, 'pending.ktt');

    // Giám đốc: vẫn "Duyệt trước" được khi KTT chưa duyệt, nhưng không có nút duyệt thường
    await H.openDoc(director, 'spend', id);
    await expect(H.actionBar(director).getByRole('button', { name: /^Duyệt trước/ })).toBeVisible();

    // Chủ tịch: duyệt vượt cấp, có lý do
    await H.openDoc(chairman, 'spend', id);
    await H.uiApprove(chairman, { opinion: 'Phiếu khẩn, cần chi trong ngày', retype: String(SIX_BILLION) });
    await H.expectStatus(chairman, co, id, 'approved');

    const doc = await H.getDoc(chairman, co, id);
    const steps: { role: string; state: string; fast_tracked?: boolean }[] = doc.approval?.steps ?? [];
    const ct = steps.find((s) => s.role === 'chairman');
    expect(ct?.fast_tracked, 'bước Chủ tịch ghi nhận duyệt vượt cấp').toBe(true);
    expect(steps.filter((s) => s.role !== 'chairman').every((s) => s.state === 'skipped' || s.state === 'done'), 'cấp dưới bỏ qua').toBe(true);
    await H.openDoc(chairman, 'spend', id);
    await expect(chairman.getByText(/Đã duyệt trước bởi/).first()).toBeVisible();
  });

  /* ------------------------------------------------------------------ */
  test('phiếu thu: duyệt xong cấp cuối tự thực thi, cộng số dư tài khoản đích (§8)', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const co = await H.companyId(staff, CO_NAME);
    const customer = uniq('Khách hàng thu');
    await H.createPartner(staff, co, 'customer', customer);
    const bankName = uniq('NH thu tự động');
    const accountId = await H.createAccount(chief, co, bankName);
    expect(await H.balanceOf(staff, co, accountId)).toBe(0n);

    const income = await H.uiCreateVoucher(staff, {
      kind: 'income',
      partnerName: customer,
      accountName: bankName,
      amount: 20_000_000,
      title: uniq('Thu kiểm thử'),
      purpose: 'Thu tiền bán hàng kiểm thử',
      submit: false,
    });
    await H.attachApi(staff, co, income.id, 'contract', 'hop-dong-thu.pdf');
    await H.openDoc(staff, 'income', income.id);
    await H.uiSubmit(staff);
    await H.expectStatus(staff, co, income.id, 'pending.ktt');

    await H.openDoc(chief, 'income', income.id);
    await H.uiApprove(chief);
    await H.expectStatus(chief, co, income.id, 'pending.gd');

    // phiếu thu 20 triệu: chuỗi KTT → GĐ (PGĐ/P.TGĐ khuyết nên bỏ qua; dưới ngưỡng Chủ tịch) → GĐ là cấp cuối
    await H.openDoc(director, 'income', income.id);
    await H.uiApprove(director);
    await H.expectStatus(director, co, income.id, 'paid');
    const incomeDoc = await H.getDoc(director, co, income.id);
    expect(((incomeDoc.approval?.steps ?? []) as { role: string }[]).map((s) => s.role), 'chuỗi phiếu thu 20 triệu: KTT → GĐ').toEqual([
      'chief_accountant',
      'director',
    ]);

    await H.openDoc(director, 'income', income.id);
    await expect(director.getByText('Đã thanh toán').first()).toBeVisible();
    await expect(H.actionBar(director).getByRole('button', { name: 'Thực thi', exact: true })).toHaveCount(0);
    expect(await H.balanceOf(director, co, accountId), 'số dư tăng đúng số tiền thu').toBe(20_000_000n);

    // sổ cái của TK mới: dòng thu có số dư cuối 20.000.000 ₫ (danh sách TK phân trang, TK mới có thể nằm sau trang 1)
    await H.gotoCta(director, `/ngan-hang/taikhoan/${accountId}`);
    await expect(director.getByText('20.000.000').first(), 'sổ cái TK đích: dòng thu có số dư cuối 20.000.000').toBeVisible({ timeout: 20_000 });
  });

  /* ------------------------------------------------------------------ */
  test('thực thi phiếu chi: cần UNC và số tham chiếu; số dư giảm đúng số tiền duyệt cuối (US-EXE-01)', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const co = await H.companyId(staff, CO_NAME);
    const customerId = await H.createPartner(staff, co, 'customer', uniq('Khách nạp quỹ'));
    const supplierId = await H.createPartner(staff, co, 'supplier', uniq('NCC thực thi'));
    const bankName = uniq('NH thực thi');
    const accountId = await H.createAccount(chief, co, bankName);

    // nạp quỹ bằng phiếu thu (tự thực thi khi duyệt cuối)
    const income = await H.createVoucherApi(staff, co, {
      kind: 'income',
      partnerId: customerId,
      accountId,
      amount: 20_000_000,
      title: uniq('Nạp quỹ'),
      purpose: 'Nạp quỹ kiểm thử thực thi',
    });
    await H.attachApi(staff, co, income.id, 'contract', 'hop-dong-nap.pdf');
    await H.submitApi(staff, co, income.id);
    expect(await H.approveToFinal({ chief, director, chairman }, co, income.id)).toBe('paid');
    expect(await H.balanceOf(staff, co, accountId)).toBe(20_000_000n);

    // phiếu chi 5 triệu, KTT chốt còn 4,5 triệu; duyệt không trừ số dư
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId: supplierId, accountId, amount: SPEND, title: uniq('Chi thực thi') });
    expect(await H.approveToFinal({ chief, director, chairman }, co, id, { page: chief, body: { amount_minor: '4500000' } })).toBe('approved');
    expect(await H.balanceOf(staff, co, accountId), 'duyệt không trừ số dư').toBe(20_000_000n);

    // chưa có UNC: không được xác nhận
    await H.openDoc(staff, 'spend', id);
    await H.actionBar(staff).getByRole('button', { name: 'Thực thi', exact: true }).click();
    const m = H.topModal(staff);
    await expect(m.getByText('Chưa có chứng từ UNC')).toBeVisible();
    await H.fieldOf(m, 'Số tham chiếu ngân hàng').locator('input').fill('FT26300TEST01');
    await expect(m.locator('.ant-modal-footer').getByRole('button', { name: /^Thực thi/ })).toBeDisabled();
    await m.locator('.ant-modal-footer').getByRole('button', { name: 'Hủy bỏ', exact: true }).click();
    await expect(staff.locator('.ant-modal:visible')).toHaveCount(0);

    // đính kèm UNC rồi thực thi
    await H.attachApi(staff, co, id, 'bank_order', 'uy-nhiem-chi.pdf');
    await H.openDoc(staff, 'spend', id);
    await H.uiPay(staff, 'FT26300TEST01');
    await H.expectStatus(staff, co, id, 'paid');
    expect(await H.balanceOf(staff, co, accountId), 'số dư giảm đúng số tiền duyệt cuối').toBe(15_500_000n);
    const doc = await H.getDoc(staff, co, id);
    expect(JSON.stringify(doc), 'lưu số tham chiếu ngân hàng').toContain('FT26300TEST01');

    // sổ cái TK nguồn hiển thị số dư đã trừ sau khi thực thi (US-EXE-01: số dư cập nhật ngay; danh sách TK phân trang nên đọc từ sổ cái của TK)
    await H.gotoCta(staff, `/ngan-hang/taikhoan/${accountId}`);
    await expect(staff.getByText('15.500.000').first(), 'sổ cái TK nguồn: số dư cuối 15.500.000 sau thực thi').toBeVisible({ timeout: 20_000 });

    // §6.3: mỗi phiếu chi được thực thi MỘT lần — thực thi lần hai bị từ chối, số dư không bị trừ thêm
    const todayVn = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    const again = await H.transitionApi(staff, co, id, { action: 'pay', execution: { paid_at: todayVn, bank_ref: 'FT26300TEST02' } });
    expect(again.status, `thực thi lần hai phải bị từ chối: ${again.text}`).toBeGreaterThanOrEqual(400);
    await H.expectStatus(staff, co, id, 'paid');
    expect(await H.balanceOf(staff, co, accountId), 'thực thi lần hai không trừ thêm tiền').toBe(15_500_000n);
  });

  /* ------------------------------------------------------------------ */
  test('thực thi bị chặn khi số dư tài khoản nguồn không đủ (§8); duyệt không bị chặn', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const co = await H.companyId(staff, CO_NAME);
    const supplierId = await H.createPartner(staff, co, 'supplier', uniq('NCC thiếu số dư'));
    const bankName = uniq('NH không đủ tiền');
    const accountId = await H.createAccount(chief, co, bankName);
    expect(await H.balanceOf(staff, co, accountId)).toBe(0n);

    const { id } = await H.submittedVoucherApi(staff, co, { partnerId: supplierId, accountId, amount: 1_000_000, title: uniq('Thiếu số dư') });
    // duyệt không kiểm số dư: vẫn đi hết chuỗi tới "Đã duyệt"
    expect(await H.approveToFinal({ chief, director, chairman }, co, id)).toBe('approved');
    await H.attachApi(staff, co, id, 'bank_order', 'uy-nhiem-chi-thieu.pdf');

    await H.openDoc(staff, 'spend', id);
    await H.actionBar(staff).getByRole('button', { name: 'Thực thi', exact: true }).click();
    const m = H.topModal(staff);
    await H.fieldOf(m, 'Số tham chiếu ngân hàng').locator('input').fill('FT-INSUFFICIENT-01');
    await m.locator('.ant-modal-footer').getByRole('button', { name: /^Thực thi/ }).click();

    const err = staff.locator('.ant-modal:visible').filter({ hasText: 'Không thực hiện được' });
    await expect(err).toBeVisible({ timeout: 20_000 });
    await expect(err.getByText('Số dư khả dụng không đủ')).toBeVisible();
    await err.getByRole('button', { name: 'Đã hiểu', exact: true }).click();

    await H.expectStatus(staff, co, id, 'approved');
    expect(await H.balanceOf(staff, co, accountId)).toBe(0n);
  });

  /* ------------------------------------------------------------------ */
  test('KTV hủy phiếu nháp từ hồ sơ (v2 §7.1: Nháp → Huỷ)', async ({ as }) => {
    test.setTimeout(180_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC hủy'));
    const accountId = await H.createAccount(chief, co, uniq('NH hủy'));

    // máy chủ có chuyển trạng thái Huỷ cho nháp (kiểm tra API)
    const { id: apiId } = await H.createVoucherApi(staff, co, { kind: 'spend', partnerId, accountId, amount: SPEND, title: uniq('Hủy nháp API'), purpose: 'Phiếu nháp để kiểm tra API hủy' });
    const apiCancel = await H.transitionApi(staff, co, apiId, { action: 'cancel', opinion: 'Hủy phiếu nháp để kiểm thử' });
    expect(apiCancel.status, `API hủy nháp: ${apiCancel.text}`).toBeLessThan(300);
    await H.expectStatus(staff, co, apiId, 'cancelled');

    // giao diện: hồ sơ nháp phải có nút Huỷ để KTV thực hiện (§7.1)
    const { id } = await H.createVoucherApi(staff, co, { kind: 'spend', partnerId, accountId, amount: SPEND, title: uniq('Hủy nháp UI'), purpose: 'Phiếu nháp hủy trên giao diện' });
    await H.openDoc(staff, 'spend', id);
    await expect(
      H.actionBar(staff).getByRole('button', { name: 'Hủy hồ sơ', exact: true }),
      'hồ sơ nháp phải có nút Huỷ (spec §7.1)',
    ).toBeVisible();
    // bấm Huỷ trên giao diện: modal bắt buộc lý do → xác nhận → trạng thái Huỷ
    await H.uiCancel(staff, 'Hủy phiếu nháp trên giao diện kiểm thử');
    await H.expectStatus(staff, co, id, 'cancelled');
  });

  /* ------------------------------------------------------------------ */
  test('KTV hủy phiếu đang yêu cầu bổ sung và phiếu đã duyệt từ hồ sơ (v2 §7.1: Yêu cầu bổ sung → Huỷ, Đã duyệt → Huỷ)', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC hủy sau duyệt'));
    const accountId = await H.createAccount(chief, co, uniq('NH hủy sau duyệt'));

    // 1) đang yêu cầu bổ sung → KTV hủy được
    const cr = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Hủy khi bổ sung') });
    await H.openDoc(chief, 'spend', cr.id);
    await H.uiDecision(chief, 'Yêu cầu bổ sung', 'Yêu cầu bổ sung', 'Cần bổ sung biên bản nghiệm thu');
    await H.expectStatus(chief, co, cr.id, 'changes_requested');
    await H.openDoc(staff, 'spend', cr.id);
    await expect(H.actionBar(staff).getByRole('button', { name: 'Hủy hồ sơ', exact: true }), 'yêu cầu bổ sung → Huỷ').toBeVisible();
    await H.uiCancel(staff, 'Không tiếp tục khoản chi này');
    await H.expectStatus(staff, co, cr.id, 'cancelled');

    // 2) đã duyệt (chưa thực thi) → KTV hủy được
    const ap = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Hủy sau duyệt') });
    expect(await H.approveToFinal({ chief, director }, co, ap.id), 'chuỗi 5 triệu: KTT → GĐ, duyệt xong cấp cuối').toBe('approved');
    await H.openDoc(staff, 'spend', ap.id);
    await expect(H.actionBar(staff).getByRole('button', { name: 'Hủy hồ sơ', exact: true }), 'đã duyệt → Huỷ').toBeVisible();
    await H.uiCancel(staff, 'Hủy khoản đã duyệt theo yêu cầu kiểm thử');
    await H.expectStatus(staff, co, ap.id, 'cancelled');
  });

  /* ------------------------------------------------------------------ */
  test('danh sách phiếu lọc theo đối tác và trạng thái; tìm theo tên đối tác', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const p1Name = uniq('Đối tác lọc A');
    const p2Name = uniq('Đối tác lọc B');
    const p1 = await H.createPartner(staff, co, 'supplier', p1Name);
    const p2 = await H.createPartner(staff, co, 'supplier', p2Name);
    const accountId = await H.createAccount(chief, co, uniq('NH lọc'));

    const v1 = await H.submittedVoucherApi(staff, co, { partnerId: p1, accountId, amount: SPEND, title: uniq('Lọc gửi duyệt') });
    const v2 = await H.createVoucherApi(staff, co, { kind: 'spend', partnerId: p2, accountId, amount: SPEND, title: uniq('Lọc nháp B'), purpose: 'Nháp của đối tác B' });
    const v3 = await H.createVoucherApi(staff, co, { kind: 'spend', partnerId: p1, accountId, amount: SPEND, title: uniq('Lọc nháp A'), purpose: 'Nháp của đối tác A' });
    const code1 = String((await H.getDoc(staff, co, v1.id)).code);
    const code2 = String((await H.getDoc(staff, co, v2.id)).code);
    const code3 = String((await H.getDoc(staff, co, v3.id)).code);

    // lọc theo đối tác A (URL là trạng thái của danh sách)
    await H.gotoCta(staff, `/chi?partner_id=${p1}`);
    await expect(H.rowOf(staff, code1)).toBeVisible({ timeout: 20_000 });
    await expect(H.rowOf(staff, code3)).toBeVisible();
    await expect(H.rowOf(staff, code2)).toHaveCount(0);

    // màn Phiếu chi chia khối theo trạng thái (swimlane): phiếu nháp nằm ở khối "Nháp / cần bổ sung / từ chối"
    await expect(staff.getByText('Nháp / cần bổ sung / từ chối').first()).toBeVisible();
    await expect(staff.getByText('Đang chờ duyệt').first()).toBeVisible();

    // đổi bộ lọc đối tác sang B bằng ô chọn: chỉ còn phiếu nháp của B
    const partnerBox = staff.getByRole('combobox', { name: 'Lọc theo đối tác' });
    await partnerBox.click();
    await partnerBox.fill(p2Name);
    await staff.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: p2Name }).first().click();
    await expect.poll(() => new URL(staff.url()).searchParams.get('partner_id') ?? '').toBe(p2);
    await expect(H.rowOf(staff, code2)).toBeVisible({ timeout: 20_000 });
    await expect(H.rowOf(staff, code1)).toHaveCount(0);
    await expect(H.rowOf(staff, code3)).toHaveCount(0);

    // tìm theo tên đối tác bằng ô tìm (khớp tên đối tác phía máy chủ)
    await H.gotoCta(staff, `/chi?q=${encodeURIComponent(p1Name)}`);
    await expect(H.rowOf(staff, code1)).toBeVisible({ timeout: 20_000 });
    await expect(H.rowOf(staff, code3)).toBeVisible();
    await expect(H.rowOf(staff, code2)).toHaveCount(0);
    await H.searchList(staff, p2Name);
    await expect(H.rowOf(staff, code2)).toBeVisible({ timeout: 20_000 });
    await expect(H.rowOf(staff, code1)).toHaveCount(0);
    await expect(H.rowOf(staff, code3)).toHaveCount(0);
  });

  /* ------------------------------------------------------------------ */
  test('sửa tên đối tác: thẻ đối tác trên chi tiết phiếu hiển thị tên mới (US-PAR-08)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const oldName = uniq('Đối tác đổi tên cũ');
    const newName = uniq('Đối tác đổi tên mới');
    const partnerId = await H.createPartner(staff, co, 'supplier', oldName, { bank: 'Techcombank', account: '19030201020' });
    const accountId = await H.createAccount(chief, co, uniq('NH đổi tên'));
    const { id } = await H.createVoucherApi(staff, co, { kind: 'spend', partnerId, accountId, amount: SPEND, title: uniq('Đổi tên'), purpose: 'Phiếu kiểm thử đổi tên đối tác' });

    await H.openDoc(staff, 'spend', id);
    await expect(staff.getByText(oldName).first()).toBeVisible();

    await staff.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();
    const m = H.topModal(staff);
    await H.fieldOf(m, 'Tên đối tác').locator('input').fill(newName);
    await m.locator('.ant-modal-footer').getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await expect(staff.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 25_000 });

    await expect(staff.getByText(newName).first()).toBeVisible({ timeout: 20_000 });
    expect((await H.getPartner(staff, co, partnerId)).name).toBe(newName);

    // tải lại bằng openDoc (không staff.reload()): phạm vi mặc định nằm trên tài khoản DÙNG CHUNG, tiến trình khác có thể
    // đổi nó giữa chừng → openDoc đặt lại CTA và thử lại khi báo "không có quyền" (cùng cách với các test khác)
    await H.openDoc(staff, 'spend', id);
    await expect(staff.getByText(newName).first()).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByText(oldName)).toHaveCount(0);
  });

  /* ------------------------------------------------------------------ */
  test('danh sách phiếu: hai phiếu cùng một tag đều trả về tag đầy đủ (không null) và trang không lỗi', async ({ as }) => {
    test.setTimeout(180_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    // tên tag tối đa 40 ký tự (FG-VAL-001): uniq() cộng thêm PW_AREA dài (vd. "vouchers-final") làm vượt giới hạn → tên ngắn riêng
    const tagName = `Tag chung ${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    const tagId = await H.createTag(staff, co, tagName);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC tag chung'));
    const accountId = await H.createAccount(chief, co, uniq('NH tag chung'));
    const a = await H.createVoucherApi(staff, co, { kind: 'spend', partnerId, accountId, amount: SPEND, title: uniq('Tag A'), purpose: 'Phiếu A có tag dùng chung', tagIds: [tagId] });
    const b = await H.createVoucherApi(staff, co, { kind: 'spend', partnerId, accountId, amount: SPEND, title: uniq('Tag B'), purpose: 'Phiếu B có tag dùng chung', tagIds: [tagId] });
    const codeA = String((await H.getDoc(staff, co, a.id)).code);
    const codeB = String((await H.getDoc(staff, co, b.id)).code);

    // API danh sách: mọi hàng đều có tag đầy đủ (không có phần tử null)
    const r = await H.api(staff, 'GET', `/documents?kind=spend&q=${encodeURIComponent(tagName)}&limit=50`, { scope: co });
    expect(r.status).toBeLessThan(300);
    const rows = ((r.body?.items ?? []) as { code: string; tags: (null | { _id: string })[] }[]).filter((x) => [codeA, codeB].includes(x.code));
    expect(rows.map((x) => x.code).sort(), 'cả hai phiếu có trong danh sách').toEqual([codeA, codeB].sort());
    for (const row of rows) {
      expect(row.tags.map((t) => t?._id ?? null), `tag của ${row.code}`).toEqual([tagId]);
    }

    // giao diện: danh sách lọc theo tag mở được, không báo lỗi hệ thống
    await H.gotoCta(staff, `/chi?q=${encodeURIComponent(tagName)}`);
    await expect(H.rowOf(staff, codeA).or(staff.getByText('Hệ thống đang gặp sự cố'))).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByText('Hệ thống đang gặp sự cố'), 'danh sách không báo lỗi hệ thống').toHaveCount(0);
    await expect(H.rowOf(staff, codeB)).toBeVisible();
    await expect(H.rowOf(staff, codeA).getByText(tagName, { exact: true }), 'chip tag hiện ở phiếu A').toBeVisible();
    await expect(H.rowOf(staff, codeB).getByText(tagName, { exact: true }), 'chip tag hiện ở phiếu B').toBeVisible();
  });

  /* ------------------------------------------------------------------ */
  test('xung đột phiên bản: gửi duyệt với phiên bản cũ bị từ chối 409, hồ sơ không đổi (v2 §7.2 chống xung đột)', async ({ as }) => {
    test.setTimeout(120_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC xung đột'));
    const accountId = await H.createAccount(chief, co, uniq('NH xung đột'));
    const { id } = await H.createVoucherApi(staff, co, {
      kind: 'spend',
      partnerId,
      accountId,
      amount: SPEND,
      title: uniq('Xung đột phiên bản'),
      purpose: 'Phiếu nháp kiểm tra xung đột phiên bản',
    });
    // đủ chứng từ để chỉ còn lỗi phiên bản là lý do từ chối
    await H.attachApi(staff, co, id, 'contract', 'hop-dong.pdf');
    await H.attachApi(staff, co, id, 'invoice', 'hoa-don.pdf');
    const before = await H.getDoc(staff, co, id);

    const stale = await H.api(staff, 'POST', `/documents/${id}/transition`, {
      scope: co,
      data: { action: 'submit', if_match: Number(before.version) + 7 },
    });
    expect(stale.status, `phiên bản sai phải bị từ chối 409: ${stale.text}`).toBe(409);
    await H.expectStatus(staff, co, id, 'draft');
  });

  /* ------------------------------------------------------------------ */
  test('Duyệt trước (vượt cấp) phải nêu lý do: API từ chối khi thiếu lý do; giao diện chưa cho xác nhận (v2 §7.2)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC duyệt trước'));
    const accountId = await H.createAccount(chief, co, uniq('NH duyệt trước'));
    // 60 triệu: chuỗi KTT → GĐ; GĐ duyệt trước khi KTT xong
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BAND_50M_5B, title: uniq('Duyệt trước lý do') });

    const noReason = await H.transitionApi(director, co, id, { action: 'approve_with_reason' });
    expect(noReason.status, `duyệt trước thiếu lý do phải bị từ chối: ${noReason.text}`).toBeGreaterThanOrEqual(400);
    await H.expectStatus(director, co, id, 'pending.ktt');

    await H.openDoc(director, 'spend', id);
    await H.actionBar(director).getByRole('button', { name: /^Duyệt trước/ }).click();
    const m = H.topModal(director);
    const confirmBtn = m.locator('.ant-modal-footer').getByRole('button', { name: /^Duyệt trước/ });
    await expect(confirmBtn, 'chưa nêu lý do thì chưa cho duyệt trước').toBeDisabled();
    await H.fieldOf(m, 'Ý kiến').locator('textarea').fill('Đã đối chiếu, cần chi gấp');
    await expect(confirmBtn, 'đã nêu lý do thì được duyệt trước').toBeEnabled();
    await confirmBtn.click();
    await expect(director.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 25_000 });
    await H.expectStatus(director, co, id, 'approved');
  });

  /* ------------------------------------------------------------------ */
  test('danh sách phiếu chia khối theo trạng thái: phiếu nháp và phiếu đang duyệt nằm đúng khối', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partner = uniq('Đối tác lọc trạng thái');
    const partnerId = await H.createPartner(staff, co, 'supplier', partner);
    const accountId = await H.createAccount(chief, co, uniq('NH lọc trạng thái'));
    const sent = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Lọc đang duyệt') });
    const draft = await H.createVoucherApi(staff, co, {
      kind: 'spend',
      partnerId,
      accountId,
      amount: SPEND,
      title: uniq('Lọc nháp'),
      purpose: 'Nháp để lọc theo trạng thái',
    });
    const codeSent = String((await H.getDoc(staff, co, sent.id)).code);
    const codeDraft = String((await H.getDoc(staff, co, draft.id)).code);

    await H.gotoCta(staff, `/chi?q=${encodeURIComponent(partner)}`);
    await expect(H.rowOf(staff, codeSent)).toBeVisible({ timeout: 20_000 });
    await expect(H.rowOf(staff, codeDraft)).toBeVisible();

    // màn Chi không có ô lọc trạng thái: trạng thái thể hiện bằng khối (swimlane), mỗi phiếu đúng khối của nó
    const lane = (title: string) => staff.locator('section').filter({ has: staff.getByText(title, { exact: true }) });
    await expect(lane('Đang chờ duyệt').locator('tr', { hasText: codeSent }), 'phiếu đã gửi duyệt nằm ở khối "Đang chờ duyệt"').toHaveCount(1, {
      timeout: 20_000,
    });
    await expect(lane('Nháp / cần bổ sung / từ chối').locator('tr', { hasText: codeDraft }), 'phiếu nháp nằm ở khối "Nháp / cần bổ sung / từ chối"').toHaveCount(1);
    await expect(lane('Đang chờ duyệt').locator('tr', { hasText: codeDraft }), 'phiếu nháp không nằm ở khối đang chờ duyệt').toHaveCount(0);
    await expect(lane('Nháp / cần bổ sung / từ chối').locator('tr', { hasText: codeSent }), 'phiếu đang chờ không nằm ở khối nháp').toHaveCount(0);
  });

  /* ------------------------------------------------------------------ */
  test('Chi chờ duyệt (CHI-04): phiếu đang chờ KTT và phiếu đang chờ GĐ đều hiện (filter ghim pending.*, docs/03_screens.md)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const { partner, codeKtt, codeGd } = await pendingPair(staff, chief, co);

    await H.gotoCta(chief, `/chi/cho-duyet?q=${encodeURIComponent(partner)}`);
    await expect(H.rowOf(chief, codeGd), 'phiếu chờ GĐ có trong "Chi chờ duyệt"').toBeVisible({ timeout: 20_000 });
    await expect(H.rowOf(chief, codeKtt), 'phiếu chờ KTT cũng phải có trong "Chi chờ duyệt" (CHI-04 ghim pending.*)').toBeVisible();
  });

  test('Chi chờ duyệt: ô lọc trạng thái thu hẹp đúng một bước (Chờ Kế toán trưởng)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const { partner, codeKtt, codeGd } = await pendingPair(staff, chief, co);

    await H.gotoCta(chief, `/chi/cho-duyet?q=${encodeURIComponent(partner)}`);
    const box = chief.getByRole('combobox', { name: 'Lọc theo trạng thái' });
    await box.click();
    await chief.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'Chờ Kế toán trưởng' }).first().click();
    await expect.poll(() => new URL(chief.url()).searchParams.get('status') ?? '', 'bộ lọc trạng thái lên URL').toBe('pending.ktt');
    await expect(H.rowOf(chief, codeKtt), 'lọc "Chờ Kế toán trưởng": có phiếu chờ KTT').toBeVisible({ timeout: 20_000 });
    await expect(H.rowOf(chief, codeGd), 'lọc "Chờ Kế toán trưởng": không có phiếu chờ GĐ').toHaveCount(0);
  });

  /* ------------------------------------------------------------------ */
  test('KTT không gán được tài khoản của công ty khác khi duyệt (CTB cho phiếu CTA): bị chặn, phiếu không đổi (v2 §6.3)', async ({ as }) => {
    test.setTimeout(120_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const coB = await H.companyId(staff, 'CTB');
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC phạm vi TK'));
    const accountId = await H.createAccount(chief, co, uniq('NH phạm vi TK'));
    const foreignId = await H.createAccount(chief, coB, uniq('NH CTB phạm vi TK'));
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Phạm vi TK') });

    const r = await H.transitionApi(chief, co, id, { action: 'approve', source_account_id: foreignId });
    expect(r.status, `tài khoản công ty khác phải bị chặn: ${r.text}`).toBeGreaterThanOrEqual(400);
    await H.expectStatus(chief, co, id, 'pending.ktt');
    expect(String((await H.getDoc(chief, co, id)).source.account_id), 'tài khoản nguồn giữ nguyên').toBe(accountId);
  });

  /* ------------------------------------------------------------------ */
  test('chống thao tác trùng: bấm duyệt hai lần cùng khoá yêu cầu không duyệt đôi, lịch sử chỉ một lượt (v2 §7.2)', async ({ as }) => {
    test.setTimeout(180_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC duyệt trùng'));
    const accountId = await H.createAccount(chief, co, uniq('NH duyệt trùng'));
    // 60 triệu: KTT duyệt → còn GĐ; lần bấm thứ hai không được đẩy hồ sơ đi thêm bước
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BAND_50M_5B, title: uniq('Duyệt trùng') });
    const before = await H.getDoc(chief, co, id);
    const body = { action: 'approve', request_id: randomUUID(), if_match: Number(before.version) };
    const first = await H.api(chief, 'POST', `/documents/${id}/transition`, { scope: co, data: body });
    const second = await H.api(chief, 'POST', `/documents/${id}/transition`, { scope: co, data: body });
    expect(first.status, `duyệt lần 1: ${first.text}`).toBeLessThan(300);
    expect(second.status, `bấm lần 2 cùng khoá phải được coi là đã xử lý, không báo lỗi: ${second.text}`).toBeLessThan(300);
    const dup = second.body?.idempotent === true || (H.unwrap(second.body) as { skipped?: boolean } | null)?.skipped === true;
    expect(dup, 'lần bấm trùng được nhận diện là đã xử lý').toBe(true);
    await H.expectStatus(chief, co, id, 'pending.gd');
    const after = await H.getDoc(chief, co, id);
    expect(Number(after.version), 'phiên bản chỉ tăng đúng một lần').toBe(Number(before.version) + 1);
    expect((after.history ?? []).filter((h: { action: string }) => h.action === 'approve').length, 'lịch sử chỉ có một lượt duyệt').toBe(1);
  });

  /* ------------------------------------------------------------------ */
  test('phiếu chi đã duyệt → đưa vào hàng thanh toán → thực thi: trừ số dư đúng một lần (v2 §7.1 DaDuyet → DangThanhToan → DaThanhToan)', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const co = await H.companyId(staff, CO_NAME);
    const customerId = await H.createPartner(staff, co, 'customer', uniq('Khách nạp hàng chờ'));
    const supplierId = await H.createPartner(staff, co, 'supplier', uniq('NCC hàng chờ'));
    const accountId = await H.createAccount(chief, co, uniq('NH hàng chờ TT'));

    // nạp quỹ 20 triệu bằng phiếu thu (tự thực thi khi duyệt cuối)
    const income = await H.createVoucherApi(staff, co, {
      kind: 'income',
      partnerId: customerId,
      accountId,
      amount: 20_000_000,
      title: uniq('Nạp hàng chờ'),
      purpose: 'Nạp quỹ kiểm thử hàng thanh toán',
    });
    await H.attachApi(staff, co, income.id, 'contract', 'hop-dong-nap-hang-cho.pdf');
    await H.submitApi(staff, co, income.id);
    expect(await H.approveToFinal({ chief, director, chairman }, co, income.id)).toBe('paid');
    expect(await H.balanceOf(staff, co, accountId)).toBe(20_000_000n);

    // phiếu chi 5 triệu: KTT là cấp cuối → Đã duyệt → đưa vào hàng thanh toán → thực thi
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId: supplierId, accountId, amount: SPEND, title: uniq('Chi hàng chờ') });
    expect(await H.approveToFinal({ chief, director, chairman }, co, id), 'chuỗi 5 triệu: duyệt xong cấp cuối').toBe('approved');
    await H.attachApi(staff, co, id, 'bank_order', 'uy-nhiem-chi-hang-cho.pdf');

    const queued = await H.transitionApi(staff, co, id, { action: 'queue_payment' });
    expect(queued.status, `đưa vào hàng thanh toán: ${queued.text}`).toBeLessThan(300);
    await H.expectStatus(staff, co, id, 'processing');
    expect(await H.balanceOf(staff, co, accountId), 'đưa vào hàng thanh toán chưa trừ số dư').toBe(20_000_000n);

    const todayVn = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    const paid = await H.transitionApi(staff, co, id, { action: 'pay', execution: { paid_at: todayVn, bank_ref: 'FT26300QUEUE01' } });
    expect(paid.status, `thực thi từ hàng thanh toán: ${paid.text}`).toBeLessThan(300);
    await H.expectStatus(staff, co, id, 'paid');
    expect(await H.balanceOf(staff, co, accountId), 'thực thi trừ đúng 5 triệu một lần').toBe(15_000_000n);
  });

  /* ------------------------------------------------------------------ */
  test('phiếu chi đã duyệt trên GIAO DIỆN: nút "Đưa vào hàng thanh toán" → Đang thanh toán → "Thực thi" trừ số dư đúng một lần (v2 §7.1)', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const co = await H.companyId(staff, CO_NAME);
    const customerId = await H.createPartner(staff, co, 'customer', uniq('Khách hàng chờ UI'));
    const supplierId = await H.createPartner(staff, co, 'supplier', uniq('NCC hàng chờ UI'));
    const accountId = await H.createAccount(chief, co, uniq('NH hàng chờ UI'));

    // nạp quỹ 20 triệu bằng phiếu thu (tự thực thi khi duyệt cuối)
    const income = await H.createVoucherApi(staff, co, {
      kind: 'income',
      partnerId: customerId,
      accountId,
      amount: 20_000_000,
      title: uniq('Nạp hàng chờ UI'),
      purpose: 'Nạp quỹ kiểm thử hàng thanh toán trên giao diện',
    });
    await H.attachApi(staff, co, income.id, 'contract', 'hop-dong-nap-hang-cho-ui.pdf');
    await H.submitApi(staff, co, income.id);
    expect(await H.approveToFinal({ chief, director, chairman }, co, income.id)).toBe('paid');
    expect(await H.balanceOf(staff, co, accountId)).toBe(20_000_000n);

    // phiếu chi 5 triệu: KTT → GĐ, duyệt xong cấp cuối (Đã duyệt), có UNC
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId: supplierId, accountId, amount: SPEND, title: uniq('Chi hàng chờ UI') });
    expect(await H.approveToFinal({ chief, director, chairman }, co, id), 'chuỗi 5 triệu: duyệt xong cấp cuối').toBe('approved');
    await H.attachApi(staff, co, id, 'bank_order', 'uy-nhiem-chi-hang-cho-ui.pdf');

    // hồ sơ Đã duyệt: có nút "Đưa vào hàng thanh toán" trên giao diện (không chỉ qua API)
    await H.openDoc(staff, 'spend', id);
    const bar = H.actionBar(staff);
    await expect(bar.getByRole('button', { name: 'Đưa vào hàng thanh toán', exact: true }), 'Đã duyệt: có nút "Đưa vào hàng thanh toán"').toBeVisible();
    await bar.getByRole('button', { name: 'Đưa vào hàng thanh toán', exact: true }).click();
    const confirm = H.topModal(staff);
    await confirm.locator('.ant-modal-footer').getByRole('button', { name: 'Đưa vào hàng thanh toán', exact: true }).click();
    await expect(staff.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 25_000 });
    await H.expectStatus(staff, co, id, 'processing');
    expect(await H.balanceOf(staff, co, accountId), 'đưa vào hàng thanh toán chưa trừ số dư').toBe(20_000_000n);

    // đang thanh toán: trạng thái hiện trên hồ sơ, nút đưa vào hàng biến mất, "Thực thi" còn hiện
    await H.openDoc(staff, 'spend', id);
    await expect(staff.getByText('Đang thanh toán').first(), 'hồ sơ hiện trạng thái Đang thanh toán').toBeVisible();
    await expect(H.actionBar(staff).getByRole('button', { name: 'Đưa vào hàng thanh toán', exact: true }), 'đã vào hàng: không còn nút đưa vào hàng').toHaveCount(0);
    await expect(H.actionBar(staff).getByRole('button', { name: 'Thực thi', exact: true }), 'đang thanh toán: có nút Thực thi').toBeVisible();

    // thực thi trên giao diện: số dư trừ đúng 5 triệu một lần
    await H.uiPay(staff, 'FT26300QUEUE02');
    await H.expectStatus(staff, co, id, 'paid');
    expect(await H.balanceOf(staff, co, accountId), 'thực thi từ hàng thanh toán trừ đúng 5 triệu một lần').toBe(15_000_000n);
  });

  test('phiếu thu: cấp duyệt đổi tài khoản đích khi duyệt → tự thực thi cộng vào tài khoản MỚI, tài khoản cũ không đổi (v2 §6.3, US-APR-03)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const co = await H.companyId(staff, CO_NAME);
    const customerId = await H.createPartner(staff, co, 'customer', uniq('Khách đổi TK thu'));
    const fromId = await H.createAccount(chief, co, uniq('NH thu ban đầu'));
    const toId = await H.createAccount(chief, co, uniq('NH thu thay thế'));
    // 20 triệu: KTT → GĐ (chuỗi phiếu thu, xem test phiếu thu ở trên)
    const { id } = await H.submittedVoucherApi(staff, co, { kind: 'income', partnerId: customerId, accountId: fromId, amount: 20_000_000, title: uniq('Thu đổi TK') });

    const r = await H.transitionApi(chief, co, id, { action: 'approve', source_account_id: toId });
    expect(r.status, `KTT duyệt kèm đổi tài khoản đích: ${r.text}`).toBeLessThan(300);
    await H.expectStatus(chief, co, id, 'pending.gd');
    expect(String((await H.getDoc(chief, co, id)).source.account_id), 'tài khoản đích đã đổi khi duyệt').toBe(toId);

    expect(await H.approveToFinal({ director }, co, id), 'GĐ duyệt cuối → tự thực thi').toBe('paid');
    expect(await H.balanceOf(staff, co, toId), 'tiền thu vào tài khoản đã đổi sang').toBe(20_000_000n);
    expect(await H.balanceOf(staff, co, fromId), 'tài khoản ban đầu không nhận tiền').toBe(0n);
  });

  /* ------------------------------------------------------------------ */
  test('US-APR-01 (giao diện): đổi phạm vi công ty → chân danh sách, huy hiệu thanh đầu và thẻ tổng quan đổi theo phạm vi (không giữ số của phạm vi trước)', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const coB = await H.companyId(staff, 'CTB');
    // mỗi phạm vi có ít nhất một phiếu chờ KTT: khi hàng trống, màn hiện thông báo trống và KHÔNG có chân danh sách
    const pA = await H.createPartner(staff, co, 'supplier', uniq('NCC phạm vi CTA'));
    const accA = await H.createAccount(chief, co, uniq('NH phạm vi CTA'));
    await H.submittedVoucherApi(staff, co, { partnerId: pA, accountId: accA, amount: SPEND, title: uniq('Phạm vi CTA') });
    const pB = await H.createPartner(staff, coB, 'supplier', uniq('NCC phạm vi CTB'));
    const accB = await H.createAccount(chief, coB, uniq('NH phạm vi CTB'));
    await H.submittedVoucherApi(staff, coB, { partnerId: pB, accountId: accB, amount: SPEND, title: uniq('Phạm vi CTB') });

    try {
      // 1) phạm vi CTA: chân danh sách và huy hiệu khớp hàng chờ CTA
      await H.gotoCta(chief, '/cho-toi-duyet');
      expect((await queueCounts(chief, co)).count, 'CTA có ít nhất một phiếu chờ KTT').toBeGreaterThan(0);
      await expectShownCount(
        chief,
        'chân danh sách (CTA)',
        () => listFooterShown(chief),
        async () => (await queueCounts(chief, co)).count,
      );
      await expectShownCount(
        chief,
        'huy hiệu thanh đầu (CTA)',
        () => headerBadgeShown(chief),
        async () => badgeLabel((await queueCounts(chief, co)).count),
      );

      // 2) đổi sang CTB bằng ô phạm vi: chân danh sách, huy hiệu phải theo CTB, không giữ số của CTA
      await switchScopeUi(chief, 'CTB');
      expect((await queueCounts(chief, coB)).count, 'CTB có ít nhất một phiếu chờ KTT').toBeGreaterThan(0);
      await expectShownCount(
        chief,
        'chân danh sách sau khi đổi sang CTB (không giữ số của CTA)',
        () => listFooterShown(chief),
        async () => (await queueCounts(chief, coB)).count,
      );
      await expectShownCount(
        chief,
        'huy hiệu thanh đầu sau khi đổi sang CTB',
        () => headerBadgeShown(chief),
        async () => badgeLabel((await queueCounts(chief, coB)).count),
      );

      // 3) thẻ tổng quan ("Xem tất cả (N)") cùng phạm vi CTB
      await chief.locator('a[href="/dashboard"]').first().click();
      await expectShownCount(
        chief,
        'thẻ tổng quan (CTB)',
        () => dashboardShown(chief),
        async () => (await queueCounts(chief, coB)).count,
      );
    } finally {
      // trả phạm vi mặc định của tài khoản dùng chung về CTA (các khu vực test khác đọc cùng tài khoản)
      const back = await H.api(chief, 'PATCH', '/me/prefs', { data: { default_scope: co } });
      expect(back.status, `khôi phục phạm vi CTA: ${back.text}`).toBeLessThan(300);
    }
  });

  /* ------------------------------------------------------------------ */
  test('US-APR-01: số đếm "chờ tôi duyệt" đổi NGAY sau gửi duyệt và sau khi duyệt (không giữ số của lượt đọc trước)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const co = await H.companyId(staff, CO_NAME);
    const partner = uniq('NCC đếm ngay');
    const partnerId = await H.createPartner(staff, co, 'supplier', partner);
    const accountId = await H.createAccount(chief, co, uniq('NH đếm ngay'));

    // nạp số đếm của KTT và GĐ trước (lượt đọc đầu tiên lưu vào cache)
    const chief0 = await queueCounts(chief, co);
    const dir0 = await queueCounts(director, co);
    expect(chief0.count, 'KTT: số đếm khớp danh sách trước khi gửi').toBe(chief0.total);
    expect(dir0.count, 'GĐ: số đếm khớp danh sách trước khi gửi').toBe(dir0.total);

    // 60 triệu (KTT → GĐ): KTV gửi duyệt → hàng chờ KTT có phiếu và số đếm đổi ngay
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BAND_50M_5B, title: uniq('Đếm ngay') });
    const code = String((await H.getDoc(staff, co, id)).code);
    expect(await inQueue(chief, co, partner, code), 'KTT: phiếu vừa gửi nằm trong hàng chờ').toBe(true);
    const chief1 = await queueCounts(chief, co);
    expect(chief1.count, 'KTT: sau gửi duyệt số đếm khớp danh sách ngay, không giữ số cũ').toBe(chief1.total);

    // KTT duyệt → phiếu chuyển sang GĐ: hàng chờ GĐ có phiếu và số đếm GĐ đổi ngay (cache GĐ đã nạp trước đó)
    await H.approveApi(chief, co, id);
    await H.expectStatus(chief, co, id, 'pending.gd');
    expect(await inQueue(director, co, partner, code), 'GĐ: nhận phiếu ngay sau khi KTT duyệt').toBe(true);
    const dir1 = await queueCounts(director, co);
    expect(dir1.count, 'GĐ: sau khi KTT duyệt số đếm khớp danh sách ngay, không giữ số cũ').toBe(dir1.total);
    const chief2 = await queueCounts(chief, co);
    expect(chief2.count, 'KTT: sau khi duyệt số đếm khớp danh sách ngay').toBe(chief2.total);
  });

  /* ------------------------------------------------------------------ */
  test('FG-WF-005 · phương án đảo hạn đã duyệt: không có "Thực thi" trên giao diện, máy chủ từ chối ghi thanh toán, kết quả đi qua RENEW-04', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const co = await H.companyId(staff, CO_NAME);
    const { id } = await approvedRolloverApi(staff, { chief, director, chairman }, co);

    // API: phương án đảo hạn đã duyệt không có can.pay / can.queue_payment (v2 §7.3: không phải dòng tiền)
    const sDoc = await H.getDoc(staff, co, id);
    expect(sDoc.kind, 'hồ sơ là phương án đảo hạn').toBe('rollover');
    expect(sDoc.status, 'phương án đã duyệt').toBe('approved');
    expect(sDoc.can.pay, 'can.pay = false cho phương án đảo hạn').toBe(false);
    expect(sDoc.can.queue_payment, 'can.queue_payment = false cho phương án đảo hạn').toBe(false);
    // máy chủ cũng từ chối "Thực thi" với FG-WF-005 (khớp với can.pay = false), không đổi trạng thái
    const pay = await H.transitionApi(staff, co, id, { action: 'pay', execution: { paid_at: vnToday(), bank_ref: 'FT-ROLLOVER-01' } });
    expect(pay.status, `máy chủ phải từ chối thực thi phương án đảo hạn: ${pay.text}`).toBeGreaterThanOrEqual(400);
    expect(pay.body?.code, 'mã lỗi thực thi phương án đảo hạn').toBe('FG-WF-005');
    await H.expectStatus(staff, co, id, 'approved');

    // giao diện: kế toán viên không thấy "Thực thi" hay "Đưa vào hàng thanh toán"
    await H.gotoCta(staff, `/ho-so/dao-han/${id}`);
    await expect(staff.getByText('Phương án đảo hạn', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByRole('button', { name: 'Thực thi', exact: true }), 'phương án đảo hạn: không có nút Thực thi').toHaveCount(0);
    await expect(staff.getByRole('button', { name: 'Đưa vào hàng thanh toán', exact: true })).toHaveCount(0);

    // giao diện: giám đốc (rollover:act) có form kết quả RENEW-04, vẫn không có "Thực thi"
    await H.gotoCta(director, `/ho-so/dao-han/${id}`);
    await expect(director.getByText('Phương án đảo hạn', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(director.getByRole('button', { name: 'Thực thi', exact: true }), 'giám đốc: không có nút Thực thi').toHaveCount(0);
    await expect(director.getByRole('button', { name: 'Lưu kết quả thực hiện' }), 'giám đốc: có form cập nhật kết quả (RENEW-04)').toBeVisible();
  });

  /* ------------------------------------------------------------------ */
  test('v2 §7.1 · phiếu Đang thanh toán → Yêu cầu bổ sung (cạnh DangThanhToan --> YeuCauBoSung): máy chủ và giao diện cho KTT, không đổi số dư, KTV gửi lại', async ({ as }) => {
    test.setTimeout(420_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const co = await H.companyId(staff, CO_NAME);
    const coB = await H.companyId(staff, 'CTB');
    const partner = uniq('NCC đang thanh toán');
    const partnerId = await H.createPartner(staff, co, 'supplier', partner);
    const accountId = await H.createAccount(chief, co, uniq('NH đang thanh toán'));
    const pages = { chief, director, chairman };

    // hai phiếu chi 5 triệu đã duyệt xong, đưa vào hàng thanh toán → Đang thanh toán (processing)
    const toProcessing = async (title: string): Promise<{ id: string; code: string }> => {
      const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title });
      expect(await H.approveToFinal(pages, co, id), `${title}: duyệt xong cấp cuối`).toBe('approved');
      const q = await H.transitionApi(staff, co, id, { action: 'queue_payment' });
      expect(q.status, `đưa vào hàng thanh toán: ${q.text}`).toBeLessThan(300);
      await H.expectStatus(staff, co, id, 'processing');
      return { id, code: String((await H.getDoc(staff, co, id)).code) };
    };
    const shown = await toProcessing(uniq('Đang TT hiển thị'));
    const probe = await toProcessing(uniq('Đang TT thử máy chủ'));
    const balance0 = await H.balanceOf(staff, co, accountId);
    expect(balance0, 'tài khoản mới chưa có số dư').toBe(0n);

    // (1) ranh giới quyền trên máy chủ: các lượt bị chặn không đổi trạng thái
    const byStaff = await H.transitionApi(staff, co, probe.id, { action: 'request_changes', reason: 'KTV thử đưa về bổ sung' });
    expect(byStaff.status, `KTV không có quyền đưa phiếu đang thanh toán về bổ sung: ${byStaff.text}`).toBeGreaterThanOrEqual(400);
    expect(byStaff.body?.code, 'mã lỗi quyền khi KTV thử đưa về bổ sung').toBe('FG-RBAC-001');
    const byApprove = await H.transitionApi(chief, co, probe.id, { action: 'approve' });
    expect(byApprove.status, `duyệt không có ở trạng thái Đang thanh toán (máy trạng thái): ${byApprove.text}`).toBeGreaterThanOrEqual(400);
    const byReject = await H.transitionApi(chief, co, probe.id, { action: 'reject', reason: 'Thử từ chối khi đang thanh toán' });
    expect(byReject.status, `từ chối không có ở trạng thái Đang thanh toán: ${byReject.text}`).toBeGreaterThanOrEqual(400);
    const ver = Number((await H.getDoc(staff, co, probe.id)).version);
    const outOfScope = await H.api(chief, 'POST', `/documents/${probe.id}/transition`, {
      scope: coB,
      data: { action: 'request_changes', reason: 'Thử từ phạm vi công ty khác', if_match: ver },
    });
    expect(outOfScope.status, `phạm vi CTB không đưa được phiếu của CTA về bổ sung: ${outOfScope.text}`).toBeGreaterThanOrEqual(400);
    await H.expectStatus(staff, co, probe.id, 'processing');

    // (2) máy chủ: KTT (approval:act, trong hạn mức) đưa phiếu đang thanh toán về bổ sung (cạnh DangThanhToan → YeuCauBoSung, v2 §7.1).
    // Lý do là trường `reason` (server yêu cầu; `opinion` bị từ chối 422 FG-VAL-001).
    const r = await H.transitionApi(chief, co, probe.id, { action: 'request_changes', reason: 'Kiểm tra cạnh đang thanh toán về bổ sung' });
    expect(r.status, `máy chủ phải cho KTT đưa phiếu đang thanh toán về bổ sung (cạnh v2 §7.1): ${r.text.slice(0, 200)}`).toBeLessThan(300);
    await H.expectStatus(chief, co, probe.id, 'changes_requested');

    // (3) quyền trên hồ sơ (can) khớp máy chủ, đọc trên phiếu còn đang thanh toán
    const cDoc = await H.getDoc(chief, co, shown.id);
    expect(cDoc.status, 'phiếu đang ở Đang thanh toán').toBe('processing');
    expect(cDoc.can.request_changes, 'can.request_changes = true với KTT (khớp máy chủ)').toBe(true);
    expect(cDoc.can.approve, 'không có Duyệt khi Đang thanh toán').toBe(false);
    expect(cDoc.can.reject, 'không có Từ chối khi Đang thanh toán').toBe(false);
    const sDoc = await H.getDoc(staff, co, shown.id);
    expect(sDoc.can.request_changes, 'KTV không có quyền yêu cầu bổ sung phiếu đang thanh toán').toBe(false);

    // (4) giao diện KTT: nút "Yêu cầu bổ sung" hiện trên phiếu đang thanh toán và bấm được
    await H.openDoc(chief, 'spend', shown.id);
    await expect(chief.getByText('Đang thanh toán').first(), 'hồ sơ hiện trạng thái Đang thanh toán').toBeVisible({ timeout: 20_000 });
    await expect(
      H.actionBar(chief).getByRole('button', { name: 'Yêu cầu bổ sung', exact: true }),
      'giao diện: KTT thấy nút "Yêu cầu bổ sung" trên phiếu đang thanh toán (v2 §7.1)',
    ).toBeVisible();
    await H.uiDecision(chief, 'Yêu cầu bổ sung', 'Yêu cầu bổ sung', 'Cần bổ sung chứng từ thanh toán');
    await H.expectStatus(chief, co, shown.id, 'changes_requested');

    // (5) đưa về bổ sung không ghi sổ cái
    expect(await H.balanceOf(staff, co, accountId), 'đưa về bổ sung không đổi số dư').toBe(balance0);

    // (6) KTV: phiếu bị đưa về bổ sung có nút Gửi duyệt; gửi lại → chuỗi duyệt mới, phiếu về hàng chờ KTT
    await H.openDoc(staff, 'spend', shown.id);
    await expect(H.actionBar(staff).getByRole('button', { name: 'Gửi duyệt', exact: true }), 'KTV thấy Gửi duyệt sau khi bị đưa về bổ sung').toBeVisible();
    await H.uiSubmit(staff);
    await H.expectStatus(staff, co, shown.id, 'pending.ktt');
    expect(await inQueue(chief, co, partner, shown.code), 'KTT: phiếu gửi lại nằm trong hàng chờ').toBe(true);
    expect(await H.balanceOf(staff, co, accountId), 'gửi lại không đổi số dư').toBe(balance0);

    // (7) lịch sử giữ lượt Đang thanh toán → Yêu cầu bổ sung (từ / sang)
    const doc = await H.getDoc(staff, co, shown.id);
    const hist = (doc.history ?? []) as { action: string; from?: string | null; to?: string | null }[];
    expect(
      hist.some((h) => h.action === 'request_changes' && h.from === 'processing' && h.to === 'changes_requested'),
      'lịch sử ghi lượt từ Đang thanh toán sang Yêu cầu bổ sung',
    ).toBe(true);
    await staff.getByRole('tab', { name: 'Audit log' }).click();
    await expect
      .soft(staff.getByText('Đang thanh toán → Yêu cầu bổ sung', { exact: true }).first(), 'nhật ký: chuyển trạng thái hiển thị nhãn tiếng Việt')
      .toBeVisible();
  });

  /* ------------------------------------------------------------------ */
  test('US-APR-01: tổng tiền "chờ tôi duyệt" cộng đủ mọi hồ sơ trong hàng chờ của từng người xem (API, thẻ tổng quan, chân danh sách, KPI), không chỉ 500 hồ sơ đầu', async ({ as }) => {
    test.setTimeout(420_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const co = await H.companyId(staff, CO_NAME);
    const vStaff = await viewerOf(staff, co);
    const vChief = await viewerOf(chief, co);
    const vDirector = await viewerOf(director, co);
    const poll = { timeout: 40_000, intervals: [1_000, 2_000, 3_000] };

    // 1) API: tổng máy chủ = tổng CSDL theo luật hàng chờ của từng người (KTV có quyền thực thi; KTT và GĐ duyệt)
    await expect.poll(() => queueDiffVsDb(staff, co, vStaff), { message: 'KTV: tổng hàng chờ khớp CSDL', ...poll }).toBe('');
    await expect.poll(() => queueDiffVsDb(chief, co, vChief), { message: 'KTT: tổng hàng chờ khớp CSDL', ...poll }).toBe('');
    await expect.poll(() => queueDiffVsDb(director, co, vDirector), { message: 'GĐ: tổng hàng chờ khớp CSDL', ...poll }).toBe('');
    // 2) thẻ "hôm nay" (KTV) và KPI tổng quan (KTT) cùng số với CSDL
    await expect.poll(() => todayDiffVsDb(staff, co, vStaff), { message: 'KTV: thẻ tổng quan hôm nay khớp CSDL', ...poll }).toBe('');
    await expect.poll(() => overviewDiffVsDb(chief, co, vChief), { message: 'KTT: KPI tổng quan khớp CSDL', ...poll }).toBe('');

    // 3) giao diện KTT (phạm vi CTA): chân danh sách = số hồ sơ + tổng rút gọn đúng của máy chủ (không tự cộng từng dòng)
    await H.gotoCta(chief, '/cho-toi-duyet');
    await expectShownCount(
      chief,
      'chân danh sách (số hồ sơ | tổng tiền)',
      () => listFooterText(chief),
      async () => {
        const q = await queueSummary(chief, co);
        return `${q.count} | ${norm(q.compact)}`;
      },
    );
    // 4) thẻ KPI "Chờ tôi duyệt" trên Tổng quan hiện đúng số tiền của máy chủ
    await H.gotoCta(chief, '/dashboard');
    await expectShownCount(
      chief,
      'KPI "Chờ tôi duyệt" trên Tổng quan',
      () => dashboardKpiText(chief),
      async () => {
        const r = await H.api(chief, 'GET', '/dashboard/overview', { scope: co });
        expect(r.status, r.text).toBeLessThan(300);
        return norm(String(H.unwrap<{ kpi?: { awaiting_me?: { compact?: string } } }>(r.body).kpi?.awaiting_me?.compact ?? ''));
      },
    );
  });

  /* ------------------------------------------------------------------ */
  test('APPR-01 · hàng chờ "Chờ tôi duyệt" có hơn một trang thì có phân trang để xem hết hồ sơ (docs/03_screens.md, FgPagination)', async ({ as }) => {
    test.setTimeout(120_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const co = await H.companyId(staff, CO_NAME);
    const q = await queueSummary(chief, co);
    // cỡ trang mặc định của màn danh sách là 50 (DocListScreen): từ 51 hồ sơ trở lên là có trang 2
    test.skip(q.count <= 50, `hàng chờ CTA chỉ có ${q.count} hồ sơ (không vượt một trang 50 dòng): không có gì để phân trang`);

    // API: /queue phải nhận page (trang 2 không lặp hồ sơ của trang 1)
    const p1 = await pageCodes(chief, co, '/queue', 'limit=50&page=1');
    const p2 = await pageCodes(chief, co, '/queue', 'limit=50&page=2');
    expect(p2.codes.length, 'API /queue?page=2: có hồ sơ ở trang 2').toBeGreaterThan(0);
    expect(p2.codes.filter((c) => p1.codes.includes(c)), 'API /queue?page=2: không lặp lại hồ sơ của trang 1 (bỏ qua page là lỗi)').toEqual([]);

    await H.gotoCta(chief, '/cho-toi-duyet');
    const rows = chief.locator('.ant-table-tbody tr.ant-table-row');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    const shownRows = await rows.count();
    await expect(
      chief.locator('.ant-pagination').first(),
      `hàng chờ có ${q.count} hồ sơ nhưng màn chỉ hiện ${shownRows} dòng và không có điều khiển phân trang: phải có phân trang để xem các hồ sơ còn lại (APPR-01)`,
    ).toBeVisible({ timeout: 10_000 });

    // giao diện: bấm trang 2 → URL có page=2 và bảng hiện hồ sơ khác trang 1
    const firstOnPage1 = ((await rows.first().innerText()) ?? '').trim();
    await chief.locator('.ant-pagination-item-2').first().click();
    await expect.poll(() => new URL(chief.url()).searchParams.get('page') ?? '', { message: 'bấm trang 2: URL có page=2', timeout: 10_000 }).toBe('2');
    await expect
      .poll(async () => ((await rows.first().innerText()) ?? '').trim(), { message: 'trang 2 hiện hồ sơ khác trang 1 (APPR-01)', timeout: 15_000 })
      .not.toBe(firstOnPage1);
  });

  test('CHI-01 · danh sách phiếu chi có phân trang: API trang 2 khác trang 1; /chi hiện điều khiển và chuyển trang đổi hồ sơ', async ({ as }) => {
    test.setTimeout(180_000);
    const staff = await as('staff');
    const co = await H.companyId(staff, CO_NAME);
    const p1 = await pageCodes(staff, co, '/documents', 'kind=spend&limit=50&page=1');
    test.skip(p1.total <= 50, `phiếu chi CTA chỉ có ${p1.total} hồ sơ (không vượt một trang 50 dòng): không có trang 2`);

    // API: /documents phải nhận page (trước đây bỏ qua → trang 2 lặp trang 1, không xem được phần còn lại)
    const p2 = await pageCodes(staff, co, '/documents', 'kind=spend&limit=50&page=2');
    expect(p2.codes.length, 'API /documents?page=2: có hồ sơ ở trang 2').toBeGreaterThan(0);
    expect(p2.codes.filter((c) => p1.codes.includes(c)), 'API /documents?page=2: không lặp lại hồ sơ của trang 1').toEqual([]);

    // giao diện: chân danh sách "Hiển thị 1–50 / N hồ sơ" + điều khiển phân trang, bấm trang 2 đổi hàng
    // phạm vi trên tài khoản dùng chung có thể bị tiến trình khác đổi lúc tải: đặt lại CTA và tải lại (như H.openDoc)
    let footerShown = false;
    for (let attempt = 1; attempt <= 3 && !footerShown; attempt++) {
      await H.gotoCta(staff, '/chi');
      footerShown = await staff
        .getByText(/Hiển thị 1\D+50 \/ \d+ hồ sơ/)
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true, () => false);
    }
    await expect(staff.getByText(/Hiển thị 1\D+50 \/ \d+ hồ sơ/).first(), 'chân danh sách /chi: "Hiển thị 1–50 / N hồ sơ"').toBeVisible({ timeout: 5_000 });
    await expect(staff.locator('.ant-pagination').first(), 'danh sách phiếu chi có điều khiển phân trang khi nhiều hơn một trang').toBeVisible();
    const firstRow = staff.locator('tr.ant-table-row').first();
    await expect(firstRow).toBeVisible({ timeout: 20_000 });
    const before = ((await firstRow.innerText()) ?? '').trim();
    await staff.locator('.ant-pagination-item-2').first().click();
    await expect.poll(() => new URL(staff.url()).searchParams.get('page') ?? '', { message: 'bấm trang 2: URL có page=2', timeout: 10_000 }).toBe('2');
    await expect(staff.getByText(/Hiển thị 51\D+100 \/ \d+ hồ sơ/).first(), 'trang 2 hiện "Hiển thị 51–100"').toBeVisible({ timeout: 20_000 });
    await expect
      .poll(async () => ((await staff.locator('tr.ant-table-row').first().innerText()) ?? '').trim(), { message: 'trang 2 hiện hồ sơ khác trang 1 (CHI-01)', timeout: 15_000 })
      .not.toBe(before);
  });

  /* ------------------------------------------------------------------ */
  test('§6.3 hạn mức duyệt: KTT không duyệt được khoản vượt hạn mức (FG-RBAC-012), can khớp máy chủ; Chủ tịch duyệt vượt cấp được', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const chairman = await as('chairman');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC vượt hạn mức'));
    const accountId = await H.createAccount(chief, co, uniq('NH vượt hạn mức'));
    // 60 tỷ > hạn mức duyệt của KTT ở CTA (50 tỷ, assignments.amount_limit_minor); Chủ tịch không giới hạn
    const BIG = 60_000_000_000;
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BIG, title: uniq('Vượt hạn mức') });
    await H.expectStatus(staff, co, id, 'pending.ktt');

    const cDoc = await H.getDoc(chief, co, id);
    expect(cDoc.can.approve, 'KTT: can.approve = false khi khoản vượt hạn mức duyệt của mình').toBe(false);
    const r = await H.transitionApi(chief, co, id, { action: 'approve', confirm_amount_minor: String(BIG) });
    expect(r.status, `máy chủ phải chặn KTT duyệt khoản vượt hạn mức: ${r.text}`).toBeGreaterThanOrEqual(400);
    expect(r.body?.code, 'mã lỗi vượt hạn mức duyệt').toBe('FG-RBAC-012');
    await H.expectStatus(chief, co, id, 'pending.ktt');

    // Chủ tịch duyệt vượt cấp: có lý do và gõ lại đúng số tiền (khoản > 5 tỷ)
    const ct = await H.transitionApi(chairman, co, id, {
      action: 'approve_with_reason',
      reason: 'Khoản lớn cần chi gấp theo chỉ đạo',
      confirm_amount_minor: String(BIG),
    });
    expect(ct.status, `Chủ tịch duyệt vượt cấp khoản vượt hạn mức: ${ct.text}`).toBeLessThan(300);
    await H.expectStatus(chairman, co, id, 'approved');
  });

  /* ------------------------------------------------------------------ */
  test('§8 Chủ tịch xoá phiếu chi đã thực thi: bút toán được đảo, số dư trở lại trước khi chi', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const co = await H.companyId(staff, CO_NAME);
    const customerId = await H.createPartner(staff, co, 'customer', uniq('Khách xoá phiếu'));
    const supplierId = await H.createPartner(staff, co, 'supplier', uniq('NCC xoá phiếu'));
    const accountId = await H.createAccount(chief, co, uniq('NH xoá phiếu'));

    // nạp 20 triệu bằng phiếu thu (tự thực thi khi duyệt cuối)
    const income = await H.createVoucherApi(staff, co, {
      kind: 'income',
      partnerId: customerId,
      accountId,
      amount: 20_000_000,
      title: uniq('Nạp xoá phiếu'),
      purpose: 'Nạp quỹ kiểm thử xoá phiếu đã thực thi',
    });
    await H.attachApi(staff, co, income.id, 'contract', 'hop-dong-nap-xoa.pdf');
    await H.submitApi(staff, co, income.id);
    expect(await H.approveToFinal({ chief, director, chairman }, co, income.id)).toBe('paid');
    expect(await H.balanceOf(staff, co, accountId)).toBe(20_000_000n);

    // chi 5 triệu: duyệt xong, có UNC, thực thi → còn 15 triệu
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId: supplierId, accountId, amount: SPEND, title: uniq('Chi xoá phiếu') });
    expect(await H.approveToFinal({ chief, director, chairman }, co, id), 'chuỗi 5 triệu: duyệt xong cấp cuối').toBe('approved');
    await H.attachApi(staff, co, id, 'bank_order', 'uy-nhiem-chi-xoa.pdf');
    const todayVn = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    const paid = await H.transitionApi(staff, co, id, { action: 'pay', execution: { paid_at: todayVn, bank_ref: 'FT26300DEL01' } });
    expect(paid.status, `thực thi phiếu chi: ${paid.text}`).toBeLessThan(300);
    await H.expectStatus(staff, co, id, 'paid');
    expect(await H.balanceOf(staff, co, accountId)).toBe(15_000_000n);

    // Chủ tịch xoá phiếu đã thực thi (không cần xác thực lại): sổ cái được đảo bút toán, số dư trở lại 20 triệu
    const del = await H.api(chairman, 'POST', `/documents/${id}/delete`, { scope: co, data: { reason: 'Xoá phiếu chi kiểm thử đã thực thi' } });
    expect(del.status, `Chủ tịch xoá phiếu đã thực thi: ${del.text}`).toBeLessThan(300);
    expect(await H.balanceOf(staff, co, accountId), 'xoá phiếu đã thực thi: số dư trở lại trước khi chi (bút toán đảo)').toBe(20_000_000n);
    const gone = await H.api(staff, 'GET', `/documents/${id}`, { scope: co });
    expect(gone.status, 'hồ sơ đã xoá không còn đọc được').toBeGreaterThanOrEqual(400);
  });

  /* ------------------------------------------------------------------ */
  test('v2 §7.2 · thông báo cấp kế tiếp: phiếu bị từ chối / yêu cầu bổ sung → người lập (KTV) nhận thông báo web; phiếu duyệt xong → người thanh toán nhận', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC thông báo'));
    const accountId = await H.createAccount(chief, co, uniq('NH thông báo'));
    const rej = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Thông báo từ chối') });
    const cr = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Thông báo bổ sung') });
    const done = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: SPEND, title: uniq('Thông báo duyệt xong') });

    // KTT (cấp kế tiếp khi KTV gửi duyệt) nhận "đang chờ bạn duyệt": đọc làm mốc để so sau khi KTT xử lý
    const waitingRe = /đang chờ bạn duyệt/;
    const rejWaitingBefore = await notificationsWait(chief, co, rej.id, waitingRe, 1);
    const crWaitingBefore = await notificationsWait(chief, co, cr.id, waitingRe, 1);
    expect.soft(rejWaitingBefore, 'KTT (cấp kế tiếp): nhận "đang chờ bạn duyệt" khi KTV gửi duyệt (phiếu sẽ bị từ chối)').toBeGreaterThan(0);
    expect.soft(crWaitingBefore, 'KTT (cấp kế tiếp): nhận "đang chờ bạn duyệt" khi KTV gửi duyệt (phiếu sẽ bị yêu cầu bổ sung)').toBeGreaterThan(0);

    await H.openDoc(chief, 'spend', rej.id);
    await H.uiDecision(chief, 'Từ chối', 'Từ chối', 'Thiếu biên bản nghiệm thu kèm theo');
    await H.expectStatus(chief, co, rej.id, 'rejected');

    await H.openDoc(chief, 'spend', cr.id);
    await H.uiDecision(chief, 'Yêu cầu bổ sung', 'Yêu cầu bổ sung', 'Cần bổ sung biên bản nghiệm thu');
    await H.expectStatus(chief, co, cr.id, 'changes_requested');

    expect(await H.approveToFinal({ chief, director }, co, done.id), 'chuỗi 5 triệu: duyệt xong cấp cuối').toBe('approved');

    // (1) người lập (KTV) nhận thông báo web khi phiếu bị từ chối / bị trả về bổ sung (người lập là cấp kế tiếp).
    //     Thông báo ghi sau chuyển trạng thái (best-effort): đợi tới khi có, tối đa ~20 giây.
    expect.soft(await notificationsWait(staff, co, rej.id, /bị từ chối/, 1), 'KTV (người lập): có thông báo "bị từ chối" về phiếu bị từ chối').toBeGreaterThan(0);
    expect.soft(await notificationsWait(staff, co, cr.id, /bị yêu cầu bổ sung/, 1), 'KTV (người lập): có thông báo "bị yêu cầu bổ sung" về phiếu bị trả về').toBeGreaterThan(0);
    expect.soft(await notificationsWait(staff, co, done.id, /cần thực hiện thanh toán/, 1), 'KTV (người thanh toán): có thông báo "cần thực hiện thanh toán"').toBeGreaterThan(0);

    // đợi thêm để các thông báo "âm" (không được có) có thời gian xuất hiện trước khi đối chiếu
    await staff.waitForTimeout(3_000);
    // (2) người vừa từ chối / trả về không nhận thông báo "bị từ chối" / "đang chờ bạn duyệt" về chính phiếu đó
    expect.soft(await notificationsOf(chief, co, rej.id, /bị từ chối/), 'KTT (người từ chối) không nhận thông báo "bị từ chối"').toBe(0);
    expect.soft(await notificationsOf(chief, co, rej.id, waitingRe), 'KTT (người từ chối) không nhận thêm "đang chờ bạn duyệt" về phiếu vừa từ chối').toBe(rejWaitingBefore);
    expect.soft(await notificationsOf(chief, co, cr.id, waitingRe), 'KTT (người trả về bổ sung) không nhận thêm "đang chờ bạn duyệt" về phiếu vừa trả về').toBe(crWaitingBefore);
    expect.soft(await notificationsOf(chief, co, cr.id, /bị yêu cầu bổ sung/), 'KTT (người trả về bổ sung) không nhận thông báo "bị yêu cầu bổ sung"').toBe(0);
    // (3) phiếu duyệt xong (cấp duyệt cuối là KTT): KTT vừa duyệt xong thì không nhận "cần thực hiện thanh toán"
    expect.soft(await notificationsOf(chief, co, done.id, /cần thực hiện thanh toán/), 'KTT (người vừa duyệt xong) không nhận "cần thực hiện thanh toán"').toBe(0);
  });

  test('v2 §7.2 · thông báo cấp kế tiếp khi DUYỆT: KTT duyệt → GĐ nhận "đang chờ bạn duyệt"; KTT không nhận thêm', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const co = await H.companyId(staff, CO_NAME);
    const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC thông báo duyệt'));
    const accountId = await H.createAccount(chief, co, uniq('NH thông báo duyệt'));
    // 60 triệu (50 triệu – 5 tỷ): KTT → GĐ
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: BAND_50M_5B, title: uniq('Thông báo duyệt') });
    const waitingRe = /đang chờ bạn duyệt/;
    // KTT nhận khi KTV gửi duyệt (cấp kế tiếp là KTT): mốc để so sau khi KTT duyệt
    const kttBefore = await notificationsWait(chief, co, id, waitingRe, 1);
    expect.soft(kttBefore, 'KTT (cấp kế tiếp khi KTV gửi duyệt): nhận "đang chờ bạn duyệt"').toBeGreaterThan(0);

    await H.approveApi(chief, co, id);
    await H.expectStatus(chief, co, id, 'pending.gd');
    // GĐ là cấp kế tiếp sau khi KTT duyệt: nhận "đang chờ bạn duyệt" (web)
    expect.soft(await notificationsWait(director, co, id, waitingRe, 1), 'GĐ (cấp kế tiếp sau khi KTT duyệt): nhận "đang chờ bạn duyệt"').toBeGreaterThan(0);
    // KTT vừa duyệt không nhận thêm "đang chờ bạn duyệt" về phiếu đó
    await staff.waitForTimeout(3_000);
    expect.soft(await notificationsOf(chief, co, id, waitingRe), 'KTT (người vừa duyệt): không nhận thêm "đang chờ bạn duyệt" về phiếu đó').toBe(kttBefore);
  });

  test('CHI-01 (khối trạng thái): số hồ sơ các khối trên /chi cộng đủ toàn danh sách, không chỉ trang đang xem (footer ghi N hồ sơ)', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const co = await H.companyId(staff, CO_NAME);
    const probe = await pageCodes(staff, co, '/documents', 'kind=spend&limit=50&page=1');
    test.skip(probe.total <= 50, `phiếu chi CTA chỉ có ${probe.total} hồ sơ (một trang đủ): khối không thiếu hồ sơ`);
    // phạm vi giao diện lấy từ tuỳ chọn của tài khoản DÙNG CHUNG: tiến trình khác có thể đổi nó lúc tải trang
    // (khi đó /chi hiện ít hồ sơ, không có chân phân trang) → đặt lại CTA và tải lại, tối đa 3 lượt (như H.openDoc)
    let footerShown = false;
    for (let attempt = 1; attempt <= 3 && !footerShown; attempt++) {
      await H.gotoCta(staff, '/chi');
      footerShown = await staff
        .getByText(/Hiển thị 1\D+50 \/ \d+ hồ sơ/)
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(() => true, () => false);
    }
    await expect(staff.getByText(/Hiển thị 1\D+50 \/ \d+ hồ sơ/).first(), 'chân danh sách /chi (phạm vi CTA): "Hiển thị 1–50 / N hồ sơ"').toBeVisible({ timeout: 5_000 });
    // các khối (Đã duyệt chờ chi / Đang chờ duyệt / Nháp… / Đã chi / Hủy…) phủ mọi trạng thái: tổng số hồ sơ của khối
    // phải bằng tổng của danh sách; lỗi nếu khối chỉ đếm trang đang xem (≤ 50 dòng)
    await expectShownCount(
      staff,
      'tổng số hồ sơ của các khối trên /chi (phải bằng số hồ sơ toàn danh sách)',
      async () => {
        // đợi khối đầu tiên hiện (sau tải lại trang khối có thể chưa vẽ); không có khối nào → 0
        await staff
          .locator('section')
          .filter({ hasText: 'hồ sơ ·' })
          .first()
          .waitFor({ state: 'visible', timeout: 15_000 })
          .catch(() => undefined);
        const heads = await staff.locator('section').filter({ hasText: 'hồ sơ ·' }).allInnerTexts();
        return heads.reduce((acc, t) => {
          const m = norm(t).match(/(\d+) hồ sơ ·/);
          return acc + (m ? Number(m[1]) : 0);
        }, 0);
      },
      async () => (await pageCodes(staff, co, '/documents', 'kind=spend&limit=1&page=1')).total,
    );
  });
});

/**
 * R2 — Phiếu thu đi vay ngân hàng → khoản nợ ngân hàng (v2/v2.md §11.4, §10.2, US-AUTO-01/02/05).
 *
 *   PW_AREA=r2 npx playwright test e2e/v2-auto-r2.spec.ts
 *
 * Dữ liệu: mỗi test tạo đối tác ngân hàng riêng (uniq) trong công ty CTA; không dùng số đếm toàn cục.
 * Đăng nhập: fixture `as(role)`; mật khẩu test 123qweasdzxc. Không sửa mã ứng dụng.
 *
 * Lỗi JS (pageerror) và HTTP 5xx ghi nhận trong mỗi test được kiểm ở `afterEach` (test vẫn chạy hết các bước).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect, uniq, type Role } from './fixtures';
import {
  actOnDocument,
  addMonthsIso,
  api,
  borrowCheckbox,
  companyIdOf,
  createManualLoan,
  createPartner,
  docIdFromUrl,
  docPath,
  eventually,
  expectPageNotBroken,
  expectPartnerCleared,
  fieldOf,
  fillAmount,
  fillField,
  getDocument,
  getLoan,
  loansOf,
  pickLoanMode,
  pickPartner,
  pickSelect,
  roleForStatus,
  runsOfDocument,
  setDefaultScope,
  setLoanDueDate,
  todayIsoVn,
  watchErrors,
} from './helpers-r2';

type Pages = Partial<Record<'chief' | 'director' | 'chairman', Page>>;

/** Lỗi JS / HTTP 5xx của lượt test hiện tại (xem `watchErrors`). */
let pageErrors: string[] = [];

test.beforeEach(() => {
  pageErrors = [];
});

test.afterEach(() => {
  expect(pageErrors, 'lỗi JS (pageerror) / HTTP 5xx trong lượt test này').toEqual([]);
});

/* ============================== nền tảng chung ============================== */

/** Đăng nhập theo vai trò; thử lại khi máy chủ đang khởi động lại (502/503) do bản sửa khác. */
async function loginRetry(as: (r: Role) => Promise<Page>, role: Role): Promise<Page> {
  for (let i = 0; ; i++) {
    try {
      return await as(role);
    } catch (e) {
      if (i >= 3 || !/50[23]|ECONNRESET|ECONNREFUSED/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
}

/** Đặt phạm vi mặc định; thử lại khi máy chủ đang khởi động lại (502/503 của proxy do bản sửa khác). */
async function setScopeRetry(page: Page, cta: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await setDefaultScope(page, cta);
      return;
    } catch (e) {
      if (i >= 3 || !/50[23]|ECONNRESET|ECONNREFUSED/.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
}

/** Trang kế toán viên (lập và thực thi phiếu) ở phạm vi CTA. */
async function staffPage(as: (r: Role) => Promise<Page>) {
  const page = await loginRetry(as, 'staff');
  watchErrors(page, pageErrors);
  const cta = await companyIdOf(page, 'CTA');
  await setScopeRetry(page, cta);
  return { page, cta };
}

/** Trang của một vai trò phê duyệt (KTT / GĐ / Chủ tịch) ở phạm vi CTA. */
async function approverPage(as: (r: Role) => Promise<Page>, role: 'chief' | 'director' | 'chairman', cta: string) {
  const page = await loginRetry(as, role);
  watchErrors(page, pageErrors);
  await setScopeRetry(page, cta);
  return page;
}

/** Thân POST /documents gần nhất (điều khoản gửi lên) — phân biệt lỗi phía giao diện với lỗi phía máy chủ. */
let lastDraftPost: any = null;
const watchedPages = new WeakSet<Page>();

/** Mở form "Thu" mới và chờ form hiển thị. */
async function openNewReceipt(page: Page): Promise<void> {
  if (!watchedPages.has(page)) {
    watchedPages.add(page);
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/v1\/documents$/.test(r.url())) {
        try {
          lastDraftPost = JSON.parse(r.postData() ?? 'null');
        } catch {
          lastDraftPost = null;
        }
      }
    });
  }
  await page.goto('/thu/moi');
  await expect(page.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 30_000 });
}

/** Điền các ô chung của phiếu thu (nội dung, bên nộp tiền, số tiền, tài khoản đích). */
async function fillReceiptBase(page: Page, o: { purpose: string; partner: string; amount: string }): Promise<void> {
  await fieldOf(page, /^Nội dung \/ mục đích/).locator('textarea').fill(o.purpose);
  await pickPartner(page, /^Bên nộp tiền/, o.partner);
  await fillAmount(page, o.amount);
  await pickSelect(page, /^Tài khoản đích/, null, /Cty A/);
}

/** Lưu nháp; trả về mã (ObjectId) của hồ sơ. Nếu không chuyển trang thì báo lỗi hiển thị trên form. */
async function saveDraft(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
  try {
    await page.waitForURL(/\/ho-so\/thu\/[0-9a-f]{24}$/, { timeout: 30_000 });
  } catch {
    const alerts = await page.locator('[role="alert"], .ant-message-notice').allInnerTexts();
    throw new Error(`Không lưu được phiếu, form vẫn mở. Thông báo: ${alerts.join(' | ').slice(0, 600)}`);
  }
  return docIdFromUrl(page.url());
}

/** Lưu thay đổi (màn sửa); chờ quay lại hồ sơ. */
async function saveEdit(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await page.waitForURL(/\/ho-so\/thu\/[0-9a-f]{24}$/, { timeout: 30_000 });
  return docIdFromUrl(page.url());
}

/** Tạo phiếu thu đi vay (mode "Tạo khoản vay mới") và trả về mã hồ sơ. */
async function createBorrowReceipt(
  page: Page,
  bank: { _id: string; name: string },
  o: { amount: string; contractNo?: string; collateral?: string; interest?: string; due?: string },
): Promise<string> {
  await openNewReceipt(page);
  await fillReceiptBase(page, { purpose: uniq('Giải ngân R2'), partner: bank.name, amount: o.amount });
  await borrowCheckbox(page).check();
  if (o.contractNo) await fillField(page, /^Số HĐ tín dụng/, o.contractNo);
  if (o.interest) await fillField(page, /^Lãi suất \(%\/năm\)/, o.interest);
  if (o.due) await setLoanDueDate(page, o.due);
  if (o.collateral) await fillField(page, /^Tài sản bảo đảm/, o.collateral);
  return saveDraft(page);
}

/** Vòng duyệt qua API (nhanh, dùng cho bước chuẩn bị). */
async function approveToFinalByApi(staff: Page, pages: Pages, docId: string, cta: string): Promise<string> {
  const sub = await getDocument(staff, docId, cta);
  const r0 = await api(staff, 'POST', `/documents/${docId}/transition`, { data: { action: 'submit', if_match: sub.version }, scope: cta });
  expect(r0.ok, `gửi duyệt qua API: ${r0.text.slice(0, 300)}`).toBeTruthy();
  for (let i = 0; i < 4; i++) {
    const d = await getDocument(staff, docId, cta);
    if (['approved', 'processing', 'paid'].includes(d.status)) return d.status;
    const role = roleForStatus(d.status);
    if (!role || !pages[role]) throw new Error(`Không duyệt được ở trạng thái ${d.status}`);
    const r = await api(pages[role]!, 'POST', `/documents/${docId}/transition`, { data: { action: 'approve', if_match: d.version }, scope: cta });
    expect(r.ok, `duyệt qua API (${role}): ${r.text.slice(0, 300)}`).toBeTruthy();
  }
  throw new Error('Phiếu chưa đạt trạng thái đã duyệt (API)');
}

/** Liên kết giải ngân đang hiệu lực của phiếu tới một khoản vay (theo ID khoản). */
function disbursementLinkTo(doc: any, loanId: string): any {
  return (doc.links ?? []).find((l: any) => l.relation === 'disbursement' && l.counterpart?.id === loanId && l.status === 'active');
}

/** Khoản vay do R2 tạo ra (origin tự động) trong danh sách khoản vay của một ngân hàng. */
function autoLoansOf(loans: any[]): any[] {
  return loans.filter((l) => l.origin?.kind === 'automation' && l.origin?.rule_code === 'R2');
}

/* ============================== 1. form ============================== */

test('R2-01 form phiếu thu: ô "đi vay", 3 chế độ vay và các ô điều khoản hiển thị đúng', async ({ as }) => {
  test.setTimeout(120_000);
  const { page } = await staffPage(as);
  await openNewReceipt(page);

  const cb = borrowCheckbox(page);
  await expect(cb).toBeVisible();
  await expect(cb).not.toBeChecked();
  await expect(page.getByText('Gốc khoản vay = số tiền phiếu thu')).toHaveCount(0);

  await cb.check();
  for (const m of ['Tạo khoản vay mới', 'Gắn khoản vay đã có', 'Để sau']) {
    await expect(page.locator('.ant-segmented-item-label').filter({ hasText: m }).first()).toBeVisible();
  }
  // mặc định: tạo khoản vay mới
  await expect(page.locator('.ant-segmented-item-selected')).toContainText('Tạo khoản vay mới');
  await expect(page.getByText(/Gốc khoản vay = số tiền phiếu thu/)).toBeVisible();

  for (const l of [/^Số HĐ tín dụng/, /^Lãi suất \(%\/năm\)/, /^Kỳ hạn \(tháng\)/, /^Hạn thanh toán$/, /^Kỳ trả lãi \/ gốc/, /^Phương thức trả nợ gốc/, /^Tài sản bảo đảm/]) {
    await expect(page.locator('label').filter({ hasText: l }).first()).toBeVisible();
  }
  // kỳ hạn mặc định 12 tháng (gợi ý) và hạn = ngày gốc + 11 tháng (tham số công ty)
  await expect(fieldOf(page, /^Kỳ hạn \(tháng\)/).locator('input')).toHaveAttribute('placeholder', '12', { timeout: 15_000 });
  await expect(fieldOf(page, /^Hạn thanh toán$/)).toContainText('ngày gốc + 11 tháng', { timeout: 15_000 });

  await pickLoanMode(page, 'Gắn khoản vay đã có');
  await expect(fieldOf(page, /^Khoản vay có sẵn/)).toBeVisible();

  await pickLoanMode(page, 'Để sau');
  await expect(page.getByText('Phiếu chỉ mang cờ. Gán khoản vay sau từ tab Liên kết của phiếu hoặc từ khoản vay.')).toBeVisible();

  await cb.uncheck();
  await expect(page.locator('.ant-segmented')).toHaveCount(0);
});

test('R2-02 form phiếu thu: đi vay chỉ chọn được Ngân hàng; đối tác khách hàng đang chọn bị xoá', async ({ as }) => {
  test.setTimeout(120_000);
  const { page, cta } = await staffPage(as);
  const customer = await createPartner(page, cta, 'customer', uniq('KH R2'));

  await openNewReceipt(page);
  // chờ tải xong thông tin đối tác đã chọn (form kiểm loại đối tác theo dữ liệu đã tải)
  const partnerLoaded = page.waitForResponse((r) => r.url().includes(`/partners/${customer._id}`) && r.request().method() === 'GET', { timeout: 20_000 });
  await pickPartner(page, /^Bên nộp tiền/, customer.name);
  await partnerLoaded;
  await borrowCheckbox(page).check();

  await expect(page.getByText('bên nộp tiền phải là Ngân hàng', { exact: false })).toBeVisible({ timeout: 10_000 });
  await expectPartnerCleared(page, /^Bên nộp tiền/);

  // danh sách chỉ có Ngân hàng: tìm đúng tên khách hàng ⇒ không có kết quả
  const field = fieldOf(page, /^Bên nộp tiền/);
  await field.locator('.ant-select').first().click();
  await field.locator('input[role="combobox"]').first().fill(customer.name);
  await expect(page.locator('.ant-select-dropdown:visible')).toContainText('Không có đối tác phù hợp', { timeout: 15_000 });
  await page.keyboard.press('Escape');
});

test('R2-03 form phiếu thu: báo lỗi khi đi vay thiếu đối tác, hoặc chọn "Gắn khoản vay đã có" mà chưa chọn khoản', async ({ as }) => {
  test.setTimeout(120_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 lỗi'));

  // (a) đi vay nhưng chưa chọn bên nộp tiền ⇒ "Chọn đối tác", không lưu
  await openNewReceipt(page);
  await fieldOf(page, /^Nội dung \/ mục đích/).locator('textarea').fill(uniq('Thiếu đối tác'));
  await fillAmount(page, '1000000');
  await borrowCheckbox(page).check();
  await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
  await expect(page.locator('[role="alert"]').filter({ hasText: /^Chọn đối tác$/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/thu\/moi/);

  // (b) chọn bên nộp tiền là ngân hàng, chế độ "Gắn khoản vay đã có" nhưng chưa chọn khoản ⇒ lỗi, không lưu
  await pickPartner(page, /^Bên nộp tiền/, bank.name);
  await pickLoanMode(page, 'Gắn khoản vay đã có');
  await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
  await expect(page.locator('[role="alert"]').filter({ hasText: /^Chọn khoản vay đã có$/ }).first()).toBeVisible({ timeout: 10_000 });
  await expect(page).toHaveURL(/\/thu\/moi/);
});

/* ============================== 2. lập phiếu → khoản vay tự tạo ============================== */

test('R2-04 lưu phiếu đi vay (tạo khoản vay mới): khoản "Chờ giải ngân" được tạo, liên kết giải ngân, điều khoản đủ', async ({ as }) => {
  test.setTimeout(150_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 tạo'));
  const contractNo = uniq('HĐTD');
  const collateral = uniq('TSĐB');

  const docId = await createBorrowReceipt(page, bank, { amount: '50000000', contractNo, collateral, interest: '9,5' });
  const doc = await getDocument(page, docId, cta);
  expect(doc.options?.loan?.kind).toBe('borrow');
  expect(doc.options?.loan?.mode).toBe('new');
  expect(String(doc.options?.loan?.lender_partner_id)).toBe(bank._id);
  expect(doc.partner?.type).toBe('bank');

  const loan = await eventually('khoản vay R2 đã tạo khi lưu phiếu', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l);
  const detail = await getLoan(page, loan._id, cta);
  expect(detail.status, 'trạng thái khoản vay tự tạo').toBe('pending_disbursement');
  expect(detail.origin?.kind).toBe('automation');
  expect(detail.origin?.rule_code).toBe('R2');
  expect(String(detail.principal?.minor), 'gốc = số tiền phiếu').toBe('50000000');
  expect(detail.term_months, 'kỳ hạn mặc định 12 tháng').toBe(12);
  expect(detail.interest_rate, 'lãi suất lưu đúng dạng dấu phẩy đã nhập ("9,5", không đổi thành "9.5")').toBe('9,5');
  expect(detail.maturity_date, 'hạn thanh toán = ngày gốc + 11 tháng').toBe(addMonthsIso(String(doc.planned_date).slice(0, 10), 11));
  // v2 §11.2: đối tượng sinh tự động có lịch sử auto_create (kèm mã quy tắc)
  expect.soft(
    (detail.history ?? []).some((h: any) => h.action === 'auto_create' && h.fields?.rule_code === 'R2'),
    'lịch sử khoản vay có mục auto_create (quy tắc R2) — v2 §11.2',
  ).toBeTruthy();

  // liên kết giải ngân được tạo ở bước sau của cùng lượt: chờ tới khi có
  const linked = await eventually('liên kết giải ngân phiếu → khoản vay', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, loan._id));
  expect(disbursementLinkTo(linked, loan._id)?.origin, 'liên kết do quy trình R2 tạo').toBe('automation');

  // chuỗi khoản vay (US-AUTO-08): chain.funded_by / chain.disbursements phải là mảng, không null
  const withChain = await getLoan(page, loan._id, cta);
  expect.soft(Array.isArray(withChain.chain?.funded_by), 'chain.funded_by là mảng (không null)').toBeTruthy();
  expect.soft(Array.isArray(withChain.chain?.disbursements), 'chain.disbursements là mảng (không null)').toBeTruthy();
  expect.soft(withChain.chain?.disbursements?.length ?? 0, 'chuỗi giải ngân có ít nhất một phiếu thu').toBeGreaterThan(0);

  // lượt R2 của phiếu (panel Quy trình tự động): generated không có mục null; bước đã tạo đối tượng thì có output
  const runs2 = await eventually('lượt R2 của phiếu đã xong (sau khi lưu)', () => runsOfDocument(page, docId, cta), (rs) =>
    rs.some((r) => r.rule_code === 'R2' && r.status === 'done' && (r.generated ?? []).some((g: any) => g?.code === loan.code)),
  );
  const r2s = runs2.filter((r) => r.rule_code === 'R2');
  expect.soft(r2s.flatMap((r) => r.generated ?? []).filter((g: unknown) => g === null), 'generated của lượt R2 không có mục null').toHaveLength(0);
  for (const r of r2s) {
    for (const s of (r.steps ?? []).filter((x: any) => x.status === 'done' && x.output_id)) {
      expect.soft(s.output, `steps[${s.name}].output không null khi bước đã tạo đối tượng`).not.toBeNull();
    }
  }

  // v2 §10.1 / §11.4: số HĐ tín dụng và TSĐB là thông tin của khoản vay (trường riêng)
  expect.soft(detail.contract_no, 'số HĐ tín dụng lưu trên khoản vay (trường contract_no)').toBe(contractNo);
  expect.soft(detail.collateral, 'TSĐB lưu trên khoản vay (trường collateral)').toBe(collateral);

  // giao diện hồ sơ: sau khi lưu, lượt R2 có kết quả (đã tạo khoản vay) — trang hồ sơ không được vỡ
  await page.waitForTimeout(2500);
  await expectPageNotBroken(page, 'trang hồ sơ phiếu đi vay không bị vỡ sau khi lưu (panel Quy trình tự động có lượt R2)');
  await expect.soft(page.getByText(`Phiếu thu đi vay ${bank.name}`), 'tiêu đề tóm tắt vay nêu tên ngân hàng').toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Khoản vay mới — tạo khi lưu phiếu (chờ giải ngân)')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Quy trình tự động: R2/).first(), 'panel Quy trình tự động hiển thị lượt R2').toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(new RegExp(`${loan.code} \\(chờ giải ngân\\)`)).first()).toBeVisible({ timeout: 10_000 });

  // màn chi tiết khoản vay: số HĐ tín dụng và TSĐB hiển thị đúng giá trị (không "—")
  await page.goto(`/ngan-hang/khoan-vay/${loan._id}`);
  await expectPageNotBroken(page, 'trang chi tiết khoản vay tự tạo mở được (không vỡ)');
  await expect.soft(page.getByText(contractNo, { exact: true }).first(), 'màn khoản vay hiển thị số HĐ tín dụng').toBeVisible({ timeout: 15_000 });
  await expect.soft(page.getByText(collateral, { exact: true }).first(), 'màn khoản vay hiển thị TSĐB').toBeVisible({ timeout: 10_000 });
});

test('R2-05 sửa phiếu trước khi duyệt: gốc và điều khoản của khoản vay chờ giải ngân đồng bộ theo, không tạo trùng', async ({ as }) => {
  test.setTimeout(150_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 sửa'));
  const docId = await createBorrowReceipt(page, bank, { amount: '50000000', contractNo: uniq('HĐ cũ') });
  const first = await eventually('khoản vay R2 ban đầu', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l);

  // sửa: gốc 70 triệu, số HĐ mới (openReceiptEdit chờ form nạp xong hồ sơ — gốc hiện tại — kẻo phần nạp ghi đè thay đổi của test)
  const newContract = uniq('HĐ mới');
  await openReceiptEdit(page, docId, '50.000.000');
  await fillAmount(page, '70000000');
  await fillField(page, /^Số HĐ tín dụng/, newContract);
  await saveEdit(page);

  const synced = await eventually('gốc khoản vay theo số tiền phiếu mới', () => getLoan(page, first._id, cta), (l) => String(l.principal?.minor) === '70000000');
  expect(synced.status).toBe('pending_disbursement');
  expect(autoLoansOf(await loansOf(page, bank._id, cta)), 'không tạo khoản vay thứ hai khi sửa phiếu').toHaveLength(1);
  await eventually('số tiền phân bổ của liên kết theo phiếu mới', () => getDocument(page, docId, cta), (d) => disbursementLinkTo(d, first._id)?.amount_minor === '70000000');
  expect.soft(synced.contract_no, 'số HĐ mới đồng bộ sang khoản vay (trường contract_no)').toBe(newContract);
});

/* ============================== 3. duyệt → thực thi ============================== */

test('R2-06 duyệt đến cuối rồi thực thi phiếu thu (API): khoản vay thành Đang vay (ngày giải ngân, gốc, hạn tay giữ nguyên, nhãn Tự động)', async ({ as }) => {
  test.setTimeout(300_000);
  const { page: staff, cta } = await staffPage(as);
  const pages: Pages = {
    chief: await approverPage(as, 'chief', cta),
    director: await approverPage(as, 'director', cta),
    chairman: await approverPage(as, 'chairman', cta),
  };
  const bank = await createPartner(staff, cta, 'bank', uniq('NH R2 duyệt'));
  const docId = await createBorrowReceipt(staff, bank, { amount: '70000000', due: '15/06/2028', contractNo: uniq('HĐ duyệt'), collateral: uniq('TS duyệt') });
  // phân biệt: giao diện có gửi hạn nhập tay không (phía máy khách), rồi máy chủ có lưu không
  expect(lastDraftPost?.options?.loan?.terms?.due_date, 'phiếu gửi lên có hạn thanh toán nhập tay (phía giao diện)').toBe('2028-06-15');
  expect((await getDocument(staff, docId, cta)).options?.loan?.terms?.due_date, 'máy chủ lưu hạn thanh toán nhập tay trên phiếu').toBe('2028-06-15');
  const loan0 = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(staff, bank._id, cta))[0], (l) => !!l);
  expect(loan0.maturity_date, 'hạn tay nhập trên form').toBe('2028-06-15');

  // gửi duyệt → KTT → GĐ (→ cấp cao hơn nếu có) qua API để không phụ thuộc giao diện hồ sơ (xem R2-04).
  // Phiếu thu duyệt cuối được TỰ thực thi (v2 §7.1: "Phiếu thu — duyệt cuối tự thực thi"), không cần bước "Thực thi".
  const finalStatus = await approveToFinalByApi(staff, pages, docId, cta);
  expect(finalStatus, 'phiếu thu duyệt cuối tự thực thi').toBe('paid');

  const paid = await getDocument(staff, docId, cta);
  expect(paid.execution?.paid_at, 'ngày thực thi tự động = ngày duyệt cuối').toBe(todayIsoVn());
  const active = await eventually('khoản vay Đang vay sau khi phiếu tự thực thi', () => getLoan(staff, loan0._id, cta), (l) => l.status === 'active');
  expect(String(active.disbursed_at ?? '').slice(0, 10), 'ngày giải ngân = ngày thực thi').toBe(todayIsoVn());
  expect(String(active.principal?.minor), 'gốc = số thực thu').toBe('70000000');
  expect(active.maturity_date, 'hạn thanh toán tay nhập được giữ nguyên').toBe('2028-06-15');
  expect(active.origin?.rule_code).toBe('R2');
  const runs = await eventually('lượt R2 hoàn tất sau thực thi', () => runsOfDocument(staff, docId, cta), (rs) => rs.some((r) => r.rule_code === 'R2' && r.status === 'done' && r.event_type === 'voucher.paid'));
  expect(runs.length).toBeGreaterThan(0);

  // giao diện khoản vay (không dùng màn hồ sơ phiếu): trạng thái, nhãn Tự động, phiếu nguồn
  const doc = await getDocument(staff, docId, cta);
  await staff.goto(`/ngan-hang/khoan-vay/${loan0._id}`);
  await expect(staff.locator('body')).toContainText('Đang vay', { timeout: 20_000 });
  await expectPageNotBroken(staff, 'trang chi tiết khoản vay Đang vay mở được (không vỡ)');
  await expect(staff.getByText('Tự động · R2').first()).toBeVisible({ timeout: 10_000 });
  await expect(staff.getByRole('link', { name: doc.code }).first()).toBeVisible({ timeout: 10_000 });

  // hồ sơ phiếu sau thực thi: panel Quy trình tự động có lượt R2 và khoản vay đã ở trạng thái Đang vay
  await staff.goto(docPath('thu', docId));
  await expectPageNotBroken(staff, 'hồ sơ phiếu thu đã thực thi không vỡ (panel Quy trình tự động)');
  await expect(staff.getByText(/Quy trình tự động: R2/).first(), 'panel Quy trình tự động có lượt R2').toBeVisible({ timeout: 20_000 });
  await expect(staff.getByText(new RegExp(`${loan0.code} \\(đang vay\\)`)).first(), 'đối tượng sinh: khoản vay đang vay').toBeVisible({ timeout: 10_000 });
});

test('R2-15 KTT duyệt phiếu đi vay bằng nút trên hồ sơ (giao diện): hồ sơ hiển thị và nút "Duyệt khoản" dùng được', async ({ as }) => {
  test.setTimeout(180_000);
  const { page: staff, cta } = await staffPage(as);
  const chief = await approverPage(as, 'chief', cta);
  const bank = await createPartner(staff, cta, 'bank', uniq('NH R2 UI duyệt'));
  const docId = await createBorrowReceipt(staff, bank, { amount: '45000000' });
  await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(staff, bank._id, cta))[0], (l) => !!l);
  await staff.goto(docPath('thu', docId));
  await expectPageNotBroken(staff, 'hồ sơ phiếu đi vay (người lập) không vỡ trước khi gửi duyệt');
  await actOnDocument(staff, /^Gửi duyệt$/, /^Gửi duyệt$/);
  await eventually('phiếu chờ KTT', () => getDocument(staff, docId, cta), (d) => d.status === 'pending.ktt');

  await chief.goto(docPath('thu', docId));
  await expectPageNotBroken(chief, 'hồ sơ phiếu đi vay hiển thị cho KTT (không vỡ)');
  await actOnDocument(chief, /^Duyệt khoản/, /^Duyệt khoản/);
  await eventually('phiếu rời KTT', () => getDocument(staff, docId, cta), (d) => d.status !== 'pending.ktt');
});

test('R2-07 trước duyệt cuối khoản vay vẫn "Chờ giải ngân" (chưa tính dư nợ); KTT duyệt xong chưa đổi trạng thái', async ({ as }) => {
  test.setTimeout(240_000);
  const { page: staff, cta } = await staffPage(as);
  const chief = await approverPage(as, 'chief', cta);
  const bank = await createPartner(staff, cta, 'bank', uniq('NH R2 trước duyệt cuối'));
  const docId = await createBorrowReceipt(staff, bank, { amount: '60000000' });
  const loan0 = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(staff, bank._id, cta))[0], (l) => !!l);

  const sub = await getDocument(staff, docId, cta);
  const s = await api(staff, 'POST', `/documents/${docId}/transition`, { data: { action: 'submit', if_match: sub.version }, scope: cta });
  expect(s.ok, `gửi duyệt: ${s.text.slice(0, 300)}`).toBeTruthy();
  const k = await getDocument(staff, docId, cta);
  const a = await api(chief, 'POST', `/documents/${docId}/transition`, { data: { action: 'approve', if_match: k.version }, scope: cta });
  expect(a.ok, `KTT duyệt: ${a.text.slice(0, 300)}`).toBeTruthy();
  const mid = await getDocument(staff, docId, cta);
  expect(mid.status, 'sau KTT duyệt phiếu còn chờ cấp trên').not.toBe('paid');
  const still = await getLoan(staff, loan0._id, cta);
  expect(still.status, 'khoản vay vẫn Chờ giải ngân trước khi phiếu thực thi').toBe('pending_disbursement');
  expect(still.disbursed_at, 'chưa có ngày giải ngân').toBeFalsy();
  expect(String(still.outstanding?.minor ?? '0'), 'chưa tính vào dư nợ').toBe('0');
});

/* ============================== 4. các chế độ gắn khoản vay ============================== */

test('R2-08 "Gắn khoản vay đã có": phiếu gắn vào khoản đã có, không tạo khoản mới, khoản tạo tay giữ nguyên', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 có sẵn'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');

  await openNewReceipt(page);
  await fillReceiptBase(page, { purpose: uniq('Giải ngân đợt 1'), partner: bank.name, amount: '50000000' });
  await borrowCheckbox(page).check();
  await pickLoanMode(page, 'Gắn khoản vay đã có');
  await pickSelect(page, /^Khoản vay có sẵn/, manual.code);
  const docId = await saveDraft(page);

  const doc = await eventually('liên kết giải ngân tới khoản đã có', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));
  expect(doc.options?.loan?.mode).toBe('existing');
  expect(doc.options?.loan?.existing_loan_id).toBe(manual._id);
  expect(autoLoansOf(await loansOf(page, bank._id, cta)), 'không tạo khoản vay tự động mới').toHaveLength(0);
  const unchanged = await getLoan(page, manual._id, cta);
  expect(unchanged.status).toBe('active');
  expect(String(unchanged.principal?.minor)).toBe('200000000');
  // v2 §11.2: liên kết do người dùng chọn "Gắn khoản vay đã có" là gán THỦ CÔNG (nguồn Thủ công, không mang mã quy tắc R2)
  const chosen = disbursementLinkTo(doc, manual._id);
  expect.soft(chosen?.origin, 'nguồn liên kết người dùng chọn = Thủ công (manual)').toBe('manual');
  expect.soft(chosen?.rule_code ?? null, 'liên kết người dùng chọn không mang mã quy tắc R2').toBeNull();

  await page.waitForTimeout(2500);
  await expectPageNotBroken(page, 'trang hồ sơ phiếu gắn khoản vay có sẵn không bị vỡ');
  await expect(page.getByText(`Gắn vào khoản vay ${manual.code} (Đang vay)`)).toBeVisible({ timeout: 15_000 });

  // tải lại trang (dữ liệu máy chủ): panel "Quy trình tự động" chỉ liệt kê đối tượng do quy tắc SINH RA;
  // khoản người dùng tự chọn (tạo tay, đang vay) không được hiện "Đã tạo ..." (v2 §11.2)
  await page.goto(docPath('thu', docId));
  await expectPageNotBroken(page, 'hồ sơ phiếu gắn có sẵn (tải lại) không bị vỡ');
  await expect(page.getByText(`Gắn vào khoản vay ${manual.code} (Đang vay)`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`Đã tạo ${manual.code}`), 'khoản tạo tay không được liệt kê là "Đã tạo" của quy trình tự động').toHaveCount(0);
  await expect.soft(page.getByText(/Quy trình tự động: R2/).first(), 'panel có lượt R2 của phiếu gắn có sẵn').toBeVisible({ timeout: 15_000 });
});

test('R2-09 "Để sau": không tạo khoản; gán sau từ màn khoản vay ("+ Gán phiếu giải ngân")', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 để sau'));

  await openNewReceipt(page);
  await fillReceiptBase(page, { purpose: uniq('Để sau'), partner: bank.name, amount: '30000000' });
  await borrowCheckbox(page).check();
  await pickLoanMode(page, 'Để sau');
  const docId = await saveDraft(page);
  const doc = await getDocument(page, docId, cta);
  expect(doc.options?.loan?.mode).toBe('later');
  await page.waitForTimeout(2000); // để bộ máy xử lý sự kiện lưu phiếu
  expect(autoLoansOf(await loansOf(page, bank._id, cta)), 'để sau: không tạo khoản vay').toHaveLength(0);
  expect((await runsOfDocument(page, docId, cta)).filter((r) => r.rule_code === 'R2' && r.status === 'failed')).toHaveLength(0);
  await expect(page.getByText('Chưa gắn khoản vay — gán sau từ khoản vay hoặc từ phiếu')).toBeVisible({ timeout: 15_000 });

  // khoản vay tạo tay (đang vay) cùng ngân hàng; gán phiếu giải ngân (API: POST /bank-debts/:id/disbursements)
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const assign = await api(page, 'POST', `/bank-debts/${manual._id}/disbursements`, { data: { document_id: docId, amount_minor: '30000000' }, scope: cta });
  expect(assign.ok, `gán phiếu giải ngân (API): ${assign.text.slice(0, 300)}`).toBeTruthy();
  const linked = await eventually('phiếu đã gán vào khoản vay', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));
  expect(disbursementLinkTo(linked, manual._id)?.amount_minor).toBe('30000000');
  expect(disbursementLinkTo(linked, manual._id)?.origin).toBe('manual');

  // màn khoản vay: nút "+ Gán phiếu giải ngân" (UI) — trang chi tiết khoản vay phải mở được
  await page.goto(`/ngan-hang/khoan-vay/${manual._id}`);
  await expectPageNotBroken(page, 'trang chi tiết khoản vay tạo tay mở được (không vỡ)');
  await expect(page.getByRole('button', { name: '+ Gán phiếu giải ngân' })).toBeVisible({ timeout: 20_000 });
});

test('R2-10 gán khoản vay từ phiếu thu ("+ Gán liên kết", quan hệ Giải ngân)', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 từ phiếu'));
  const manual = await createManualLoan(page, cta, bank._id, '150000000', '2027-12-31');

  await openNewReceipt(page);
  await fillReceiptBase(page, { purpose: uniq('Gán từ phiếu'), partner: bank.name, amount: '20000000' });
  await borrowCheckbox(page).check();
  await pickLoanMode(page, 'Để sau');
  const docId = await saveDraft(page);

  await page.getByRole('tab', { name: /Liên kết/ }).click();
  await page.getByRole('button', { name: '+ Gán liên kết' }).click();
  const modal = page.locator('.ant-modal:visible').last();
  await expect(modal).toContainText('Gán liên kết nghiệp vụ', { timeout: 10_000 });
  await expect(modal).toContainText('Giải ngân');
  await pickSelect(page, /^Khoản vay ngân hàng/, manual.code);
  await modal.getByRole('button', { name: 'Gán liên kết', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 15_000 });

  const linked = await eventually('liên kết giải ngân từ phiếu', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));
  expect(disbursementLinkTo(linked, manual._id)?.origin).toBe('manual');
});

/* ============================== 5. huỷ / từ chối → R6 ============================== */

test('R2-11 KTT từ chối phiếu đang có khoản chờ giải ngân ⇒ khoản vay thành Đã huỷ (R6), có lượt R6', async ({ as }) => {
  test.setTimeout(180_000);
  const { page: staff, cta } = await staffPage(as);
  const chief = await approverPage(as, 'chief', cta);
  const bank = await createPartner(staff, cta, 'bank', uniq('NH R2 từ chối'));
  const docId = await createBorrowReceipt(staff, bank, { amount: '40000000' });
  const loan0 = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(staff, bank._id, cta))[0], (l) => !!l);

  // gửi duyệt rồi KTT từ chối (qua API: nút trên hồ sơ không dùng được khi trang vỡ, xem R2-04)
  const sub = await getDocument(staff, docId, cta);
  const s = await api(staff, 'POST', `/documents/${docId}/transition`, { data: { action: 'submit', if_match: sub.version }, scope: cta });
  expect(s.ok, `gửi duyệt: ${s.text.slice(0, 300)}`).toBeTruthy();
  const cur = await getDocument(staff, docId, cta);
  const rej = await api(chief, 'POST', `/documents/${docId}/transition`, {
    data: { action: 'reject', if_match: cur.version, reason: 'Từ chối để kiểm thử R6 (khoản vay chờ giải ngân)', opinion: 'Từ chối để kiểm thử R6 (khoản vay chờ giải ngân)' },
    scope: cta,
  });
  expect(rej.ok, `từ chối: ${rej.text.slice(0, 300)}`).toBeTruthy();
  await eventually('phiếu bị từ chối', () => getDocument(staff, docId, cta), (d) => d.status === 'rejected');

  await eventually('khoản vay Đã huỷ sau khi phiếu bị từ chối', () => getLoan(staff, loan0._id, cta), (l) => l.status === 'cancelled');
  await eventually('lượt R6 hoàn tất', () => runsOfDocument(staff, docId, cta), (rs) => rs.some((r) => r.rule_code === 'R6' && r.status === 'done'));

  await staff.goto(`/ngan-hang/khoan-vay/${loan0._id}`);
  await expectPageNotBroken(staff, 'trang chi tiết khoản vay đã huỷ mở được (không vỡ)');
  await expect(staff.getByText('Khoản đã huỷ')).toBeVisible({ timeout: 20_000 });
});

test('R2-12 huỷ phiếu nháp (chuyển trạng thái Huỷ, API) ⇒ khoản vay chờ giải ngân thành Đã huỷ (R6)', async ({ as }) => {
  test.setTimeout(150_000);
  const { page: staff, cta } = await staffPage(as);
  const bank = await createPartner(staff, cta, 'bank', uniq('NH R2 huỷ'));
  const docId = await createBorrowReceipt(staff, bank, { amount: '25000000' });
  const loan0 = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(staff, bank._id, cta))[0], (l) => !!l);

  const d = await getDocument(staff, docId, cta);
  const reason = 'Huỷ phiếu nháp để kiểm thử R6 (khoản vay chờ giải ngân)';
  const r = await api(staff, 'POST', `/documents/${docId}/transition`, { data: { action: 'cancel', if_match: d.version, reason, opinion: reason }, scope: cta });
  expect(r.ok, `huỷ phiếu nháp: ${r.text.slice(0, 300)}`).toBeTruthy();
  expect((await getDocument(staff, docId, cta)).status).toBe('cancelled');

  await eventually('khoản vay Đã huỷ sau khi huỷ phiếu nháp', () => getLoan(staff, loan0._id, cta), (l) => l.status === 'cancelled');
  await eventually('lượt R6 hoàn tất sau huỷ phiếu', () => runsOfDocument(staff, docId, cta), (rs) => rs.some((r2) => r2.rule_code === 'R6' && r2.status === 'done'));
  await staff.goto(`/ngan-hang/khoan-vay/${loan0._id}`);
  await expectPageNotBroken(staff, 'trang chi tiết khoản vay đã huỷ mở được (không vỡ)');
  await expect(staff.getByText('Khoản đã huỷ')).toBeVisible({ timeout: 20_000 });
});

test('R2-13 phiếu nháp có nút "Hủy hồ sơ" trên giao diện (v2 §7.1: Nháp → Huỷ; người lập huỷ được)', async ({ as }) => {
  test.setTimeout(120_000);
  const { page: staff, cta } = await staffPage(as);
  const bank = await createPartner(staff, cta, 'bank', uniq('NH nút huỷ'));
  // chế độ "Để sau" để không có lượt tự động nào (trang hồ sơ không bị ảnh hưởng)
  await openNewReceipt(staff);
  await fillReceiptBase(staff, { purpose: uniq('Nút huỷ'), partner: bank.name, amount: '10000000' });
  await borrowCheckbox(staff).check();
  await pickLoanMode(staff, 'Để sau');
  const docId = await saveDraft(staff);
  await staff.goto(docPath('thu', docId));
  const toolbar = staff.getByRole('toolbar', { name: 'Hành động phê duyệt' });
  await expect(toolbar.getByRole('button', { name: 'Gửi duyệt', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(toolbar.getByRole('button', { name: /^(Hủy hồ sơ|Huỷ hồ sơ|Hủy|Huỷ)$/ }), 'nút huỷ hồ sơ nháp').toBeVisible({ timeout: 5_000 });

  // bấm "Hủy hồ sơ" → hộp thoại (lý do tối thiểu 5 ký tự) → xác nhận ⇒ phiếu Đã huỷ (v2 §7.1: Nháp → Huỷ)
  await actOnDocument(staff, /^Hủy hồ sơ$/, /^Hủy hồ sơ$/, 'Huỷ phiếu nháp để kiểm thử nút Hủy hồ sơ');
  await eventually('phiếu nháp đã huỷ bằng nút Hủy hồ sơ', () => getDocument(staff, docId, cta), (d) => d.status === 'cancelled');
});

test('R2-18 huỷ phiếu nháp đi vay bằng nút "Hủy hồ sơ" (giao diện) ⇒ khoản vay chờ giải ngân thành Đã huỷ (R6)', async ({ as }) => {
  test.setTimeout(180_000);
  const { page: staff, cta } = await staffPage(as);
  const bank = await createPartner(staff, cta, 'bank', uniq('NH R2 UI huỷ'));
  const docId = await createBorrowReceipt(staff, bank, { amount: '22000000' });
  const loan0 = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(staff, bank._id, cta))[0], (l) => !!l);

  await staff.goto(docPath('thu', docId));
  await expectPageNotBroken(staff, 'hồ sơ phiếu đi vay nháp không vỡ trước khi huỷ');
  await actOnDocument(staff, /^Hủy hồ sơ$/, /^Hủy hồ sơ$/, 'Huỷ phiếu nháp đi vay để kiểm thử R6 qua giao diện');
  await eventually('phiếu nháp đã huỷ (giao diện)', () => getDocument(staff, docId, cta), (d) => d.status === 'cancelled');
  await eventually('khoản vay Đã huỷ sau khi huỷ phiếu nháp (giao diện)', () => getLoan(staff, loan0._id, cta), (l) => l.status === 'cancelled');
  await eventually('lượt R6 hoàn tất (giao diện)', () => runsOfDocument(staff, docId, cta), (rs) => rs.some((r) => r.rule_code === 'R6' && r.status === 'done'));
  await staff.goto(`/ngan-hang/khoan-vay/${loan0._id}`);
  await expectPageNotBroken(staff, 'trang chi tiết khoản vay đã huỷ (giao diện) mở được (không vỡ)');
  await expect(staff.getByText('Khoản đã huỷ')).toBeVisible({ timeout: 20_000 });
});

/* ============================== 6. hiển thị & danh sách ============================== */

test('R2-14 khoản vay tự tạo hiện trong danh sách Nợ ngân hàng với nhãn "Tự động · R2" và trạng thái Chờ giải ngân', async ({ as }) => {
  test.setTimeout(150_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 danh sách'));
  await createBorrowReceipt(page, bank, { amount: '12000000' });
  const loan0 = await eventually('khoản vay R2', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l);

  await page.goto('/ngan-hang/khoan-vay');
  const row = page.locator('.ant-table-row').filter({ hasText: loan0.code }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText('Tự động · R2');
  await expect(row).toContainText('Chờ giải ngân');
  await row.getByRole('link', { name: loan0.code }).click();
  await expectPageNotBroken(page, 'trang chi tiết khoản vay chờ giải ngân mở được (không vỡ)');
  await expect(page.getByText('Khoản chờ giải ngân — chưa tính vào dư nợ')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Tự động sinh từ quy trình R2')).toBeVisible({ timeout: 10_000 });
});

/* ============================== 7. kiểm tra phía máy chủ (API) ============================== */

/** Tạo phiếu thu qua API (cùng thân yêu cầu như form web). */
async function createReceiptApi(page: Page, cta: string, partnerId: string, amountMinor: string, loan: Record<string, unknown> | null) {
  return api(page, 'POST', '/documents', {
    data: {
      kind: 'income',
      company_id: cta,
      title: uniq('Thu API R2'),
      purpose: uniq('Thu API R2 mục đích'),
      partner_id: partnerId,
      amount: { amount_minor: amountMinor, currency: 'VND' },
      source: { fund: 'bank', account_id: null, group_managed: false },
      planned_date: `${todayIsoVn()}T23:59`,
      priority: 'normal',
      category_id: null,
      budget: { budget_id: null, line_id: null, in_plan: true },
      contract: {},
      tag_ids: [],
      options: { loan },
      transfer_target: null,
    },
    scope: cta,
    expectOk: false,
  });
}

test('R2-16 gán phiếu giải ngân vượt gốc khoản vay, hoặc khác ngân hàng, bị máy chủ chặn (API)', async ({ as }) => {
  test.setTimeout(120_000);
  const { page, cta } = await staffPage(as);
  const bankA = await createPartner(page, cta, 'bank', uniq('NH R2 A'));
  const bankB = await createPartner(page, cta, 'bank', uniq('NH R2 B'));
  const loanB = await createManualLoan(page, cta, bankB._id, '10000000', '2027-12-31');
  const rA = await createReceiptApi(page, cta, bankA._id, '30000000', {
    kind: 'borrow', mode: 'later', lender_partner_id: bankA._id, receive_account_id: null, amount_minor: null, existing_loan_id: null, terms: null,
  });
  expect(rA.ok, `tạo phiếu thu của ngân hàng A: ${rA.text.slice(0, 300)}`).toBeTruthy();
  const docA = String(rA.data?._id);

  const over = await api(page, 'POST', `/bank-debts/${loanB._id}/disbursements`, { data: { document_id: docA, amount_minor: '30000000' }, scope: cta, expectOk: false });
  expect(over.ok, `giải ngân 30 triệu vào khoản 10 triệu phải bị chặn (HTTP ${over.status})`).toBeFalsy();
  const other = await api(page, 'POST', `/bank-debts/${loanB._id}/disbursements`, { data: { document_id: docA, amount_minor: '1000000' }, scope: cta, expectOk: false });
  expect(other.ok, `phiếu của ngân hàng A không được gán vào khoản của ngân hàng B (HTTP ${other.status})`).toBeFalsy();
  const after = await getLoan(page, loanB._id, cta);
  expect((after.disbursement_links ?? []).length, 'không có liên kết nào được tạo').toBe(0);
});

test('R2-17 phiếu thu đi vay: máy chủ từ chối đối tác không phải Ngân hàng làm bên cho vay (API)', async ({ as }) => {
  test.setTimeout(120_000);
  const { page, cta } = await staffPage(as);
  const customer = await createPartner(page, cta, 'customer', uniq('KH R2 API'));
  const r = await createReceiptApi(page, cta, customer._id, '1000000', {
    kind: 'borrow', mode: 'new', lender_partner_id: customer._id, receive_account_id: null, amount_minor: null, existing_loan_id: null, terms: null,
  });
  expect(r.ok, `đối tác khách hàng không được làm bên cho vay (HTTP ${r.status}: ${r.text.slice(0, 200)})`).toBeFalsy();
});

/* ============================== 8. đổi chế độ khi sửa; R2 tắt (vòng retest 3) ============================== */

type RuleOverride = { company_id: string; enabled: boolean; params: Record<string, unknown> };

/** Quy tắc R2 qua API bằng tài khoản Chủ tịch (phạm vi toàn tập đoàn: scope "all"). */
async function r2RuleOf(chairman: Page): Promise<{ _id: string; company_overrides: RuleOverride[] }> {
  const r = await api<any[]>(chairman, 'GET', '/automation/rules', { scope: 'all' });
  const rule = (Array.isArray(r.data) ? r.data : []).find((x: any) => x.code === 'R2');
  if (!rule) throw new Error('Không thấy quy tắc R2');
  return rule;
}

/** R2 có đang hiệu lực ở công ty này không (trường `effective` của danh sách quy tắc). */
async function r2EnabledFor(chairman: Page, companyId: string): Promise<boolean> {
  const r = await api<any[]>(chairman, 'GET', `/automation/rules?company_id=${companyId}`, { scope: 'all' });
  const rule = (Array.isArray(r.data) ? r.data : []).find((x: any) => x.code === 'R2');
  return rule?.effective?.enabled === true;
}

/** Ghi danh sách ghi đè theo công ty của R2 (PATCH thay toàn bộ danh sách). */
async function putR2Overrides(chairman: Page, overrides: RuleOverride[]): Promise<void> {
  const rule = await r2RuleOf(chairman);
  const r = await api(chairman, 'PATCH', `/automation/rules/${rule._id}`, {
    data: { company_overrides: overrides.map((o) => ({ company_id: String(o.company_id), enabled: o.enabled, params: o.params ?? {} })) },
    scope: 'all',
  });
  expect(r.ok, `ghi đè R2 theo công ty (API): ${r.text.slice(0, 300)}`).toBeTruthy();
}

/** So sánh danh sách ghi đè (công ty + bật/tắt). */
function overrideKeys(xs: RuleOverride[]): string[] {
  return xs.map((o) => `${String(o.company_id)}:${o.enabled !== false}`).sort();
}

/** Liên kết giải ngân đang hiệu lực của phiếu (mọi khoản vay). */
function activeDisbursementsOf(doc: any): any[] {
  return (doc.links ?? []).filter((l: any) => l.relation === 'disbursement' && l.status === 'active');
}

/** Mã công ty theo mã, đọc với phạm vi "all" (không phụ thuộc phạm vi mặc định đã lưu của tài khoản). */
async function companyIdAll(page: Page, code: string): Promise<string> {
  const r = await api<any>(page, 'GET', '/companies', { scope: 'all' });
  const list: any[] = Array.isArray(r.data) ? r.data : (r.data?.items ?? []);
  const company = list.find((c) => c.code === code);
  if (!company) throw new Error(`Không thấy công ty ${code} (phạm vi all): ${r.text.slice(0, 300)}`);
  return String(company._id ?? company.id);
}

/** Số lượt R2 của phiếu đã lỗi (để báo kèm thông báo lỗi của bước). */
async function failedR2RunsOf(page: Page, docId: string, cta: string): Promise<any[]> {
  return (await runsOfDocument(page, docId, cta)).filter((r) => r.rule_code === 'R2' && r.status === 'failed');
}

/** Phiếu đi vay "Gắn khoản vay đã có" (khoản có sẵn) — dùng cho các ca đổi chế độ. */
async function createExistingLoanReceipt(page: Page, cta: string, bank: { _id: string; name: string }, loanCode: string, amount: string): Promise<string> {
  await openNewReceipt(page);
  await fillReceiptBase(page, { purpose: uniq('Gắn có sẵn'), partner: bank.name, amount });
  await borrowCheckbox(page).check();
  await pickLoanMode(page, 'Gắn khoản vay đã có');
  await pickSelect(page, /^Khoản vay có sẵn/, loanCode);
  return saveDraft(page);
}

/**
 * Mở màn sửa phiếu thu và chờ nạp xong (số tiền hiện đúng).
 * Phạm vi mặc định của tài khoản kế toán là dùng chung (pref trên máy chủ): spec khác chạy song song có thể đổi nó giữa chừng,
 * khi đó trang tải ở công ty khác ⇒ GET hồ sơ 403 và form trống. Đặt lại phạm vi CTA trước mỗi lần tải; thử lại tối đa 2 lần.
 */
async function openReceiptEdit(page: Page, docId: string, amountText: string): Promise<void> {
  const cta = await companyIdOf(page, 'CTA');
  for (let attempt = 0; ; attempt++) {
    await setScopeRetry(page, cta);
    await page.goto(`/thu/${docId}/sua`);
    await expect(page.getByRole('button', { name: 'Lưu thay đổi', exact: true })).toBeVisible({ timeout: 30_000 });
    try {
      await expect(page.getByLabel('Số tiền', { exact: true })).toHaveValue(amountText, { timeout: 15_000 });
      return;
    } catch (e) {
      if (attempt >= 2) throw e;
    }
  }
}

/** Sửa phiếu qua API (PATCH /documents/:id) với if_match = phiên bản hiện tại; phạm vi công ty tường minh. */
async function patchDoc(page: Page, companyId: string, docId: string, body: Record<string, unknown>): Promise<void> {
  const d = await getDocument(page, docId, companyId);
  const r = await api(page, 'PATCH', `/documents/${docId}`, { data: { ...body, if_match: d.version }, scope: companyId });
  expect(r.ok, `sửa phiếu (API): ${r.text.slice(0, 300)}`).toBeTruthy();
}

test('R2-19 R2 tắt riêng cho công ty: "Gắn khoản vay đã có" vẫn ghi liên kết Thủ công ngay khi lưu và khi sửa (không phụ thuộc quy tắc)', async ({ as }) => {
  test.setTimeout(240_000);
  const chairman = await loginRetry(as, 'chairman');
  const page = await loginRetry(as, 'staff');
  watchErrors(page, pageErrors);
  // mã công ty đọc qua tài khoản Chủ tịch (phạm vi all). Mọi lệnh dưới đây gửi kèm phạm vi công ty tường minh
  // (không dựa vào phạm vi mặc định đã lưu của kế toán: tài khoản dùng chung, các ca test khác có thể đổi nó).
  const mayogu = await companyIdAll(chairman, 'MAYOGU');

  const before = (await r2RuleOf(chairman)).company_overrides;
  try {
    // tắt R2 CHỈ ở MAYOGU (không đụng CTA đang dùng cho các ca khác); khôi phục trong finally
    await putR2Overrides(chairman, [...before.filter((o) => String(o.company_id) !== mayogu), { company_id: mayogu, enabled: false, params: {} }]);
    expect(await r2EnabledFor(chairman, mayogu), 'R2 đã tắt ở MAYOGU').toBe(false);

    const bank = await createPartner(page, mayogu, 'bank', uniq('NH R2 tắt'));
    const manual = await createManualLoan(page, mayogu, bank._id, '200000000', '2027-12-31');
    const existingLoan = { kind: 'borrow', mode: 'existing', lender_partner_id: bank._id, receive_account_id: null, amount_minor: null, existing_loan_id: manual._id, terms: null };

    // (1) lưu phiếu "Gắn khoản vay đã có" (POST): liên kết Thủ công được ghi NGAY khi lưu, dù R2 tắt
    const created = await createReceiptApi(page, mayogu, bank._id, '50000000', existingLoan);
    expect(created.ok, `lưu phiếu gắn khoản có sẵn (R2 tắt): ${created.text.slice(0, 300)}`).toBeTruthy();
    const docId = String(created.data?._id);
    const saved = await getDocument(page, docId, mayogu);
    const chosen = disbursementLinkTo(saved, manual._id);
    expect(chosen, 'liên kết giải ngân tới khoản đã có được ghi ngay khi lưu (R2 tắt)').toBeTruthy();
    expect.soft(chosen?.origin, 'nguồn liên kết = Thủ công').toBe('manual');
    expect.soft(chosen?.rule_code ?? null, 'liên kết Thủ công không mang mã quy tắc').toBeNull();
    expect.soft(String(chosen?.amount_minor), 'số tiền phân bổ = số tiền phiếu').toBe('50000000');

    // (2) sửa số tiền (PATCH) khi R2 vẫn tắt: liên kết Thủ công theo số tiền mới ngay sau khi lưu
    await patchDoc(page, mayogu, docId, { amount: { amount_minor: '40000000', currency: 'VND' } });
    const edited = disbursementLinkTo(await getDocument(page, docId, mayogu), manual._id);
    expect(edited, 'sau khi sửa số tiền: vẫn có liên kết tới khoản đã có (R2 tắt)').toBeTruthy();
    expect.soft(edited?.origin, 'sau khi sửa số tiền: nguồn vẫn = Thủ công').toBe('manual');
    expect.soft(String(edited?.amount_minor), 'sau khi sửa số tiền: số tiền phân bổ theo phiếu mới').toBe('40000000');

    // (3) phiếu "Để sau" rồi đổi sang "Gắn khoản vay đã có" khi sửa (PATCH options): liên kết Thủ công ngay (R2 tắt)
    const later = await createReceiptApi(page, mayogu, bank._id, '30000000', { ...existingLoan, mode: 'later', existing_loan_id: null });
    expect(later.ok, `lưu phiếu để sau (R2 tắt): ${later.text.slice(0, 300)}`).toBeTruthy();
    const laterId = String(later.data?._id);
    await patchDoc(page, mayogu, laterId, { options: { loan: existingLoan } });
    const viaEdit = disbursementLinkTo(await getDocument(page, laterId, mayogu), manual._id);
    expect(viaEdit, 'đổi sang "Gắn khoản vay đã có" khi sửa: liên kết được ghi ngay (R2 tắt)').toBeTruthy();
    expect.soft(viaEdit?.origin, 'đổi sang "Gắn khoản vay đã có" khi sửa: nguồn = Thủ công').toBe('manual');

    // (4) R2 tắt: không khoản vay tự động, không lượt R2 nào
    await new Promise((r) => setTimeout(r, 3000));
    expect(autoLoansOf(await loansOf(page, bank._id, mayogu)), 'R2 tắt: không tạo khoản vay tự động').toHaveLength(0);
    expect((await runsOfDocument(page, docId, mayogu)).filter((r) => r.rule_code === 'R2'), 'R2 tắt: không có lượt R2').toHaveLength(0);
  } finally {
    await putR2Overrides(chairman, before);
    const restored = (await r2RuleOf(chairman)).company_overrides;
    expect(overrideKeys(restored), 'đã khôi phục ghi đè R2 như trước khi test').toEqual(overrideKeys(before));
  }
});

test('R2-20 sửa phiếu "Gắn khoản vay đã có" → "Tạo khoản vay mới" (trước duyệt): liên kết tới khoản cũ được gỡ, chỉ còn một giải ngân tới khoản mới, không lỗi R2', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 đổi vay mới'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const docId = await createExistingLoanReceipt(page, cta, bank, manual.code, '50000000');
  await eventually('liên kết giải ngân tới khoản đã có', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));

  await openReceiptEdit(page, docId, '50.000.000');
  await pickLoanMode(page, 'Tạo khoản vay mới');
  await saveEdit(page);

  const fresh = await eventually('khoản vay R2 mới sau khi đổi sang vay mới', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l);
  expect(fresh.status, 'khoản vay mới chờ giải ngân').toBe('pending_disbursement');
  await page.waitForTimeout(4000);
  const d = await getDocument(page, docId, cta);
  expect.soft(disbursementLinkTo(d, manual._id), 'liên kết Thủ công tới khoản cũ đã được gỡ khi đổi sang vay mới').toBeUndefined();
  expect.soft(disbursementLinkTo(d, fresh._id)?.origin, 'liên kết tới khoản vay mới = Tự động').toBe('automation');
  expect.soft(activeDisbursementsOf(d).map((l: any) => l.counterpart?.id), 'chỉ giải ngân tới khoản vay mới (phiếu 50 triệu không phân bổ hai lần)').toEqual([fresh._id]);
  expect.soft((await failedR2RunsOf(page, docId, cta)).length, 'không có lượt R2 lỗi sau khi đổi chế độ').toBe(0);
  expect.soft(String((await getLoan(page, manual._id, cta)).principal?.minor), 'khoản đã có không bị đổi gốc').toBe('200000000');
});

test('R2-21 sửa phiếu "Gắn khoản vay đã có" → "Để sau": không còn liên kết giải ngân tới khoản cũ (khớp với nhãn "Chưa gắn khoản vay")', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 để sau sửa'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const docId = await createExistingLoanReceipt(page, cta, bank, manual.code, '50000000');
  await eventually('liên kết giải ngân tới khoản đã có', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));

  await openReceiptEdit(page, docId, '50.000.000');
  await pickLoanMode(page, 'Để sau');
  await saveEdit(page);

  await page.waitForTimeout(3000);
  const d = await getDocument(page, docId, cta);
  expect(d.options?.loan?.mode, 'chế độ đã lưu = để sau').toBe('later');
  expect.soft(disbursementLinkTo(d, manual._id), 'để sau: không còn liên kết giải ngân hiệu lực tới khoản cũ').toBeUndefined();
  expect.soft(activeDisbursementsOf(d), 'để sau: phiếu không còn giải ngân hiệu lực nào').toHaveLength(0);
  const m = await getLoan(page, manual._id, cta);
  expect.soft(m.status, 'khoản đã có vẫn Đang vay').toBe('active');
  expect.soft(String(m.principal?.minor), 'khoản đã có giữ nguyên gốc').toBe('200000000');
  // tải lại trang để đọc dữ liệu máy chủ (không dùng bản đệm của màn sửa vừa lưu)
  await page.goto(docPath('thu', docId));
  await expectPageNotBroken(page, 'hồ sơ phiếu để sau không vỡ');
  await expect(page.getByText('Chưa gắn khoản vay — gán sau từ khoản vay hoặc từ phiếu')).toBeVisible({ timeout: 15_000 });

  // sức chứa được trả lại: phiếu 160 triệu gắn vào khoản 200 triệu (còn trống) phải được nhận (bản lỗi: chỉ còn 150 triệu)
  const probe = await createReceiptApi(page, cta, bank._id, '160000000', {
    kind: 'borrow', mode: 'existing', lender_partner_id: bank._id, receive_account_id: null, amount_minor: null, existing_loan_id: manual._id, terms: null,
  });
  expect(probe.ok, `phiếu 160 triệu gắn khoản 200 triệu phải được nhận sau khi đổi sang để sau (HTTP ${probe.status}: ${probe.text.slice(0, 200)})`).toBeTruthy();
});

test('R2-22 sửa phiếu "Gắn khoản vay đã có" → bỏ cờ "đi vay": không còn liên kết giải ngân tới khoản cũ', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 bỏ cờ'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const docId = await createExistingLoanReceipt(page, cta, bank, manual.code, '50000000');
  await eventually('liên kết giải ngân tới khoản đã có', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));

  await openReceiptEdit(page, docId, '50.000.000');
  await borrowCheckbox(page).uncheck();
  await saveEdit(page);

  await page.waitForTimeout(3000);
  const d = await getDocument(page, docId, cta);
  expect.soft(d.options?.loan?.kind ?? null, 'phiếu không còn là phiếu đi vay').not.toBe('borrow');
  expect.soft(disbursementLinkTo(d, manual._id), 'bỏ cờ đi vay: không còn liên kết giải ngân tới khoản cũ').toBeUndefined();
  expect.soft(activeDisbursementsOf(d), 'bỏ cờ đi vay: phiếu không còn giải ngân hiệu lực nào').toHaveLength(0);
  expect.soft(String((await getLoan(page, manual._id, cta)).principal?.minor), 'khoản đã có giữ nguyên gốc').toBe('200000000');

  // sức chứa được trả lại: phiếu 160 triệu gắn vào khoản 200 triệu (còn trống) phải được nhận
  const probe = await createReceiptApi(page, cta, bank._id, '160000000', {
    kind: 'borrow', mode: 'existing', lender_partner_id: bank._id, receive_account_id: null, amount_minor: null, existing_loan_id: manual._id, terms: null,
  });
  expect(probe.ok, `phiếu 160 triệu gắn khoản 200 triệu phải được nhận sau khi bỏ cờ đi vay (HTTP ${probe.status}: ${probe.text.slice(0, 200)})`).toBeTruthy();
});

/** Gỡ liên kết qua API (DELETE, như nút "Gỡ" trên tab Liên kết): lý do bắt buộc (≥ 5 ký tự). */
async function removeLinkApi(page: Page, docId: string, linkId: string, companyId: string, reason: string): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await page.request.fetch(`/api/v1/documents/${docId}/links/${linkId}`, {
    method: 'DELETE',
    headers: { 'x-company-scope': companyId },
    data: { reason, request_id: randomUUID() },
    failOnStatusCode: false,
  });
  return { ok: res.ok(), status: res.status(), text: await res.text() };
}

test('R2-32 phiếu "Để sau" có liên kết giải ngân thủ công 20 triệu (tab Liên kết), đổi sang "Tạo khoản vay mới": lưu bị chặn, hoặc không có lượt R2 lỗi và tổng phân bổ không vượt số tiền phiếu', async ({ as }) => {
  test.setTimeout(220_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 gán rồi vay mới'));
  const manual = await createManualLoan(page, cta, bank._id, '150000000', '2027-12-31');

  await openNewReceipt(page);
  await fillReceiptBase(page, { purpose: uniq('Gán rồi vay mới'), partner: bank.name, amount: '20000000' });
  await borrowCheckbox(page).check();
  await pickLoanMode(page, 'Để sau');
  const docId = await saveDraft(page);
  // gán thủ công từ tab Liên kết (như R2-10): toàn bộ 20 triệu của phiếu đã phân bổ cho khoản có sẵn
  await page.getByRole('tab', { name: /Liên kết/ }).click();
  await page.getByRole('button', { name: '+ Gán liên kết' }).click();
  const linkModal = page.locator('.ant-modal:visible').last();
  await expect(linkModal).toContainText('Gán liên kết nghiệp vụ', { timeout: 10_000 });
  await pickSelect(page, /^Khoản vay ngân hàng/, manual.code);
  await linkModal.getByRole('button', { name: 'Gán liên kết', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 15_000 });
  await eventually('liên kết giải ngân thủ công tới khoản vay', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));

  // đổi sang "Tạo khoản vay mới" rồi lưu (không chờ chuyển trang: lưu có thể bị chặn và giữ ở form)
  await openReceiptEdit(page, docId, '20.000.000');
  await pickLoanMode(page, 'Tạo khoản vay mới');
  // chờ phản hồi của lần lưu (API có thể chậm vài giây khi máy đang bận) rồi đọc toast ngay sau đó
  const saveResponse = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && /\/api\/v1\/documents\/[0-9a-f]{24}$/.test(new URL(r.url()).pathname),
    { timeout: 60_000 },
  );
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
  await saveResponse;
  // lưu bị chặn ⇒ toast lỗi (tiêu đề — chi tiết) hiện ngay sau phản hồi: đọc trước khi toast tự tắt (~3 s)
  const notice = await page.locator('.ant-message-notice').first().innerText({ timeout: 10_000 }).catch(() => '');
  const accepted = await page.waitForURL(/\/ho-so\/thu\/[0-9a-f]{24}$/, { timeout: 8_000 }).then(() => true, () => false);
  if (!accepted) {
    // bản sửa: "Lưu bị chặn với thông báo rõ" — nêu phiếu đã phân bổ và cách xử lý (gỡ liên kết hoặc chọn "Gắn khoản vay đã có")
    expect(notice, 'lưu bị chặn: thông báo nêu rõ phiếu đã phân bổ cho liên kết khác và cách xử lý').toMatch(/vượt số tiền còn lại|Gỡ các liên kết|Gắn khoản vay đã có/);
  }

  const d = await getDocument(page, docId, cta);
  const allocated = activeDisbursementsOf(d).reduce((s: bigint, l: any) => s + BigInt(String(l.amount_minor ?? '0')), 0n);
  const failed = await failedR2RunsOf(page, docId, cta);
  const outcome = accepted ? 'lưu được' : 'lưu bị chặn';
  expect(allocated <= 20000000n, `tổng giải ngân hiệu lực (${allocated} đồng) không vượt số tiền phiếu 20 triệu (${outcome})`).toBeTruthy();
  expect.soft(failed.length, `không có lượt R2 lỗi (${outcome}): ${JSON.stringify(failed.map((r: any) => r.error)).slice(0, 300)}`).toBe(0);
  // không để khoản vay "Chờ giải ngân" mồ côi (đã tạo nhưng không có liên kết giải ngân nào)
  const linkedIds = new Set(activeDisbursementsOf(d).map((l: any) => String(l.counterpart?.id)));
  const orphans = autoLoansOf(await loansOf(page, bank._id, cta)).filter((l: any) => l.status === 'pending_disbursement' && !linkedIds.has(String(l._id)));
  expect.soft(orphans.map((l: any) => l.code), 'không có khoản vay tự sinh chờ giải ngân mà không có liên kết giải ngân').toEqual([]);
});

test('R2-33 gỡ tay liên kết "Gắn khoản vay đã có" bị chặn (FG-WF-005, như liên kết tự động) từ phiếu, API và giao diện màn khoản vay: liên kết còn hiệu lực; lưu lại phiếu không tạo liên kết trùng', async ({ as }) => {
  test.setTimeout(200_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 gỡ tay'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const docId = await createExistingLoanReceipt(page, cta, bank, manual.code, '50000000');
  const linked = await eventually('liên kết tới khoản đã có', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));
  // chờ bộ máy xử lý xong lượt của lần lưu (tránh đua với việc gỡ: lượt đang chạy vẫn có thể gán lại)
  await eventually('lượt R2 của lần lưu đã xong', () => runsOfDocument(page, docId, cta), (rs) => rs.some((r) => r.rule_code === 'R2' && r.status === 'done'));
  await page.waitForTimeout(1_500);

  // liên kết theo lựa chọn "Gắn khoản vay đã có" không gỡ tay (như liên kết tự động, v2 §11.2): máy chủ chặn FG-WF-005
  // kèm hướng dẫn đổi lựa chọn vay; liên kết vẫn hiệu lực
  const rm = await removeLinkApi(page, docId, String(disbursementLinkTo(linked, manual._id)._id), cta, 'Gỡ thử nghiệm R2-33 (gỡ tay)');
  expect(rm.status, `gỡ liên kết theo lựa chọn vay phải bị chặn: ${rm.text.slice(0, 200)}`).toBe(422);
  expect(rm.text, 'mã FG-WF-005 (không gỡ tay)').toContain('FG-WF-005');
  expect(disbursementLinkTo(await getDocument(page, docId, cta), manual._id), 'liên kết còn hiệu lực sau khi gỡ bị chặn').toBeTruthy();

  // giao diện: tab Liên kết → "Gỡ" → hộp thoại "Gỡ liên kết" hiện hướng dẫn đổi lựa chọn vay; liên kết vẫn hiệu lực
  await page.goto(docPath('thu', docId));
  await expectPageNotBroken(page, 'hồ sơ phiếu gắn có sẵn không vỡ (tab Liên kết)');
  await page.getByRole('tab', { name: /Liên kết/ }).click();
  await page.getByRole('button', { name: 'Gỡ', exact: true }).first().click();
  const removeModal = page.locator('.ant-modal:visible').last();
  await expect(removeModal).toContainText('Gỡ liên kết', { timeout: 10_000 });
  await removeModal.locator('input, textarea').first().fill('Gỡ thử nghiệm R2-33 (giao diện)');
  await removeModal.getByRole('button', { name: 'Gỡ liên kết', exact: true }).click();
  await expect(removeModal, 'hộp thoại gỡ hiện hướng dẫn đổi lựa chọn vay (FG-WF-005)').toContainText('Đổi lựa chọn vay trên phiếu để gỡ liên kết', { timeout: 10_000 });
  await removeModal.getByRole('button', { name: 'Hủy', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 10_000 });
  expect(disbursementLinkTo(await getDocument(page, docId, cta), manual._id), 'sau khi thử gỡ trên giao diện: liên kết vẫn hiệu lực').toBeTruthy();

  // đường khác (màn khoản vay, DELETE /bank-debts/:id/disbursements/:linkId): cùng quy tắc — không gỡ tay liên kết mà
  // phiếu đang chọn "Gắn khoản vay đã có" (nếu gỡ được, lần lưu sau sẽ gán lại: lựa chọn vay và liên kết lệch nhau)
  const loanSideRes = await page.request.fetch(`/api/v1/bank-debts/${manual._id}/disbursements/${String(disbursementLinkTo(linked, manual._id)._id)}`, {
    method: 'DELETE',
    headers: { 'x-company-scope': cta },
    data: { reason: 'Gỡ thử nghiệm R2-33 (từ màn khoản vay)', request_id: randomUUID() },
    failOnStatusCode: false,
  });
  const loanSideText = await loanSideRes.text();
  expect.soft(loanSideRes.status(), `gỡ liên kết theo lựa chọn vay từ màn khoản vay phải bị chặn như từ phiếu (FG-WF-005): ${loanSideText.slice(0, 200)}`).toBe(422);
  expect.soft(loanSideText, 'mã FG-WF-005 (màn khoản vay)').toContain('FG-WF-005');
  // bị chặn đúng ⇒ liên kết còn hiệu lực; nếu máy chủ chấp nhận gỡ (HTTP 200) thì xác nhận liên kết đã được đánh dấu gỡ,
  // và lần lưu bên dưới được kiểm tiếp (bản lỗi: lưu lại gán lại liên kết đã gỡ, lựa chọn vay và liên kết lệch nhau)
  if (loanSideRes.status() !== 200) {
    expect(disbursementLinkTo(await getDocument(page, docId, cta), manual._id), 'sau khi thử gỡ từ màn khoản vay bị chặn: liên kết vẫn hiệu lực').toBeTruthy();
  } else {
    expect.soft(disbursementLinkTo(await getDocument(page, docId, cta), manual._id), 'máy chủ đã nhận lệnh gỡ: liên kết không còn hiệu lực').toBeUndefined();
  }

  // giao diện màn khoản vay (đường khác, cùng quy tắc FG-WF-005): "Gỡ" trên dòng phiếu giải ngân ⇒ hộp thoại
  // "Gỡ phiếu giải ngân" ⇒ "Gỡ liên kết" bị chặn: thông báo nêu đổi lựa chọn vay trên phiếu; liên kết vẫn hiệu lực
  const docCode = String((await getDocument(page, docId, cta)).code ?? '');
  await page.goto(`/ngan-hang/khoan-vay/${manual._id}`);
  await expectPageNotBroken(page, 'chi tiết khoản vay tạo tay không vỡ (gỡ tay từ màn khoản vay)');
  const loanRow = page.locator('.ant-table-row').filter({ hasText: docCode }).first();
  const rowShown = await loanRow.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
  expect.soft(rowShown, 'màn khoản vay: dòng phiếu giải ngân còn hiện (liên kết còn hiệu lực)').toBeTruthy();
  if (rowShown) {
    await loanRow.getByRole('button', { name: 'Gỡ', exact: true }).click();
    const loanModal = page.locator('.ant-modal:visible').last();
    await expect(loanModal).toContainText('Gỡ phiếu giải ngân', { timeout: 10_000 });
    await loanModal.locator('input, textarea').first().fill('Gỡ thử nghiệm R2-33 (màn khoản vay)');
    await loanModal.getByRole('button', { name: 'Gỡ liên kết', exact: true }).click();
    await expect
      .soft(page.locator('.ant-message-notice').filter({ hasText: 'Đổi lựa chọn vay trên phiếu để gỡ liên kết' }).first(), 'màn khoản vay: gỡ bị chặn, thông báo nêu đổi lựa chọn vay trên phiếu (FG-WF-005)')
      .toBeVisible({ timeout: 10_000 });
    await loanModal.getByRole('button', { name: 'Hủy', exact: true }).click();
    await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 10_000 });
  }
  expect(disbursementLinkTo(await getDocument(page, docId, cta), manual._id), 'sau khi gỡ từ màn khoản vay (giao diện) bị chặn: liên kết vẫn hiệu lực').toBeTruthy();

  // lưu lại phiếu (đổi mục đích, vẫn chọn "Gắn khoản vay đã có"): lựa chọn giữ nguyên, không sinh liên kết trùng
  await openReceiptEdit(page, docId, '50.000.000');
  await fieldOf(page, /^Nội dung \/ mục đích/).locator('textarea').fill(uniq('Sửa sau khi gỡ tay'));
  await saveEdit(page);
  await page.waitForTimeout(5_000);
  const d = await getDocument(page, docId, cta);
  expect.soft(d.options?.loan?.mode, 'lựa chọn vay vẫn là "Gắn khoản vay đã có"').toBe('existing');
  expect(activeDisbursementsOf(d).filter((l: any) => String(l.counterpart?.id) === String(manual._id)), 'vẫn đúng một liên kết giải ngân tới khoản đã chọn').toHaveLength(1);
});

test('R2-38 gỡ tay liên kết giải ngân KHÔNG phải lựa chọn vay (phiếu "Để sau", gán từ tab Liên kết) vẫn được phép (không chặn quá mức): từ màn khoản vay (giao diện) và từ phiếu (API)', async ({ as }) => {
  test.setTimeout(200_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 gỡ được'));
  const manual = await createManualLoan(page, cta, bank._id, '150000000', '2027-12-31');
  await openNewReceipt(page);
  await fillReceiptBase(page, { purpose: uniq('Gỡ được'), partner: bank.name, amount: '20000000' });
  await borrowCheckbox(page).check();
  await pickLoanMode(page, 'Để sau');
  const docId = await saveDraft(page);
  // gán tay từ tab Liên kết (không phải "Gắn khoản vay đã có" của phiếu ⇒ quy tắc chặn gỡ không áp dụng)
  await page.getByRole('tab', { name: /Liên kết/ }).click();
  await page.getByRole('button', { name: '+ Gán liên kết' }).click();
  const linkModal = page.locator('.ant-modal:visible').last();
  await expect(linkModal).toContainText('Gán liên kết nghiệp vụ', { timeout: 10_000 });
  await pickSelect(page, /^Khoản vay ngân hàng/, manual.code);
  await linkModal.getByRole('button', { name: 'Gán liên kết', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 15_000 });
  await eventually('liên kết thủ công (không phải lựa chọn vay)', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));

  // (1) màn khoản vay (giao diện): "Gỡ" → lý do → "Gỡ liên kết" ⇒ được phép (thông báo "Đã gỡ liên kết"), liên kết đánh dấu đã gỡ
  const docCode = String((await getDocument(page, docId, cta)).code ?? '');
  await page.goto(`/ngan-hang/khoan-vay/${manual._id}`);
  await expectPageNotBroken(page, 'chi tiết khoản vay tạo tay không vỡ (gỡ liên kết không phải lựa chọn vay)');
  const row = page.locator('.ant-table-row').filter({ hasText: docCode }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Gỡ', exact: true }).click();
  const modal = page.locator('.ant-modal:visible').last();
  await expect(modal).toContainText('Gỡ phiếu giải ngân', { timeout: 10_000 });
  await modal.locator('input, textarea').first().fill('Gỡ thử nghiệm R2-38 (màn khoản vay)');
  await modal.getByRole('button', { name: 'Gỡ liên kết', exact: true }).click();
  await expect(page.locator('.ant-message-notice').filter({ hasText: 'Đã gỡ liên kết' }).first(), 'gỡ liên kết không phải lựa chọn vay: được phép').toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 10_000 });
  await eventually('liên kết đã được gỡ (từ màn khoản vay)', () => getDocument(page, docId, cta), (d) => !disbursementLinkTo(d, manual._id));

  // (2) gán lại rồi gỡ từ phiếu (API, như nút "Gỡ" trên tab Liên kết): được phép
  const again = await api(page, 'POST', `/bank-debts/${manual._id}/disbursements`, { data: { document_id: docId, amount_minor: '20000000' }, scope: cta, expectOk: false });
  expect(again.ok, `gán lại phiếu vào khoản (API): ${again.text.slice(0, 200)}`).toBeTruthy();
  const relinked = await eventually('liên kết gán lại', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));
  const rm = await removeLinkApi(page, docId, String(disbursementLinkTo(relinked, manual._id)._id), cta, 'Gỡ thử nghiệm R2-38 (từ phiếu)');
  expect(rm.ok, `gỡ liên kết không phải lựa chọn vay từ phiếu phải được phép: HTTP ${rm.status} ${rm.text.slice(0, 200)}`).toBeTruthy();
  expect(disbursementLinkTo(await getDocument(page, docId, cta), manual._id), 'đã gỡ từ phiếu').toBeUndefined();
});

test('R2-39 liên kết giải ngân do quy trình tự động tạo (R2, "Tạo khoản vay mới") không gỡ tay được ở màn khoản vay và ở phiếu: máy chủ chặn FG-WF-005, liên kết còn hiệu lực', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 tự động không gỡ'));
  const docId = await createBorrowReceipt(page, bank, { amount: '35000000' });
  const loan = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l);
  const linked = await eventually('liên kết tự động tới khoản vay', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, loan._id));
  const linkId = String(disbursementLinkTo(linked, loan._id)._id);

  // (1) màn khoản vay (API): chặn FG-WF-005 (liên kết Tự động không gỡ tay)
  const loanSide = await page.request.fetch(`/api/v1/bank-debts/${loan._id}/disbursements/${linkId}`, {
    method: 'DELETE',
    headers: { 'x-company-scope': cta },
    data: { reason: 'Gỡ thử nghiệm R2-39 (màn khoản vay)', request_id: randomUUID() },
    failOnStatusCode: false,
  });
  const loanText = await loanSide.text();
  expect(loanSide.status(), `gỡ liên kết tự động từ màn khoản vay phải bị chặn: ${loanText.slice(0, 200)}`).toBe(422);
  expect(loanText, 'mã FG-WF-005 (màn khoản vay, liên kết tự động)').toContain('FG-WF-005');

  // (2) phiếu (API): chặn FG-WF-005
  const rm = await removeLinkApi(page, docId, linkId, cta, 'Gỡ thử nghiệm R2-39 (từ phiếu)');
  expect(rm.status, `gỡ liên kết tự động từ phiếu phải bị chặn: ${rm.text.slice(0, 200)}`).toBe(422);
  expect(rm.text, 'mã FG-WF-005 (phiếu, liên kết tự động)').toContain('FG-WF-005');

  // liên kết vẫn hiệu lực; khoản vay vẫn chờ giải ngân (không mồ côi, không lệch)
  expect(disbursementLinkTo(await getDocument(page, docId, cta), loan._id), 'liên kết tự động vẫn hiệu lực sau khi bị chặn').toBeTruthy();
  expect((await getLoan(page, loan._id, cta)).status, 'khoản vay vẫn chờ giải ngân').toBe('pending_disbursement');
});

test('R2-40 mở màn sửa phiếu thu ngoài phạm vi (GET hồ sơ 403): hiện thông báo không có quyền như màn chi tiết, không hiện form trống có nút "Lưu thay đổi"', async ({ as }) => {
  test.setTimeout(150_000);
  const { page, cta } = await staffPage(as);
  const chairman = await loginRetry(as, 'chairman');
  // phiếu ở MAYOGU (ngoài phạm vi mặc định CTA của kế toán); tạo bằng phạm vi MAYOGU như R2-19
  const mayogu = await companyIdAll(chairman, 'MAYOGU');
  const customer = await createPartner(page, mayogu, 'customer', uniq('KH R2 ngoài phạm vi'));
  const created = await createReceiptApi(page, mayogu, customer._id, '12000000', null);
  expect(created.ok, `tạo phiếu thu ở MAYOGU (API): ${created.text.slice(0, 200)}`).toBeTruthy();
  const docId = String(created.data?._id);
  expect((await api(page, 'GET', `/documents/${docId}`, { scope: cta, expectOk: false })).status, 'kế toán không xem được hồ sơ ngoài phạm vi (API)').toBe(403);

  // màn sửa: không tải được hồ sơ ⇒ phải báo không có quyền (như màn chi tiết), không để form trống
  await page.goto(`/thu/${docId}/sua`);
  await expect(page.getByText('Bạn không có quyền xem mục này'), 'màn sửa báo không có quyền xem hồ sơ (không hiện form trống)').toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Lưu thay đổi', exact: true }), 'không có nút "Lưu thay đổi" trên form trống').toHaveCount(0);
});

test('R2-34 lượt R2 lỗi vì xung đột sức chứa: gỡ liên kết gây xung đột rồi "Chạy lại" (KTT) ⇒ nối vào khoản đã tạo, không tạo trùng (US-AUTO-05)', async ({ as }) => {
  // Kịch bản này cần lượt R2 lỗi sau khi LƯU "Tạo khoản vay mới" khi phiếu còn giải ngân thủ công — chính lỗi đã sửa
  // (FG-LINK-002 chặn ngay khi lưu, xem R2-32), nên không còn tạo được lượt lỗi theo cách này. Bỏ qua tới khi có kịch bản khác.
  test.skip(true, 'premise đã bị chặn khi lưu (R2-32): không còn lượt R2 lỗi do giải ngân thủ công');
  test.setTimeout(260_000);
  const { page, cta } = await staffPage(as);
  const chief = await approverPage(as, 'chief', cta);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 chạy lại'));
  const manual = await createManualLoan(page, cta, bank._id, '150000000', '2027-12-31');

  // phiếu "Để sau" + liên kết thủ công 20 triệu (tab Liên kết), rồi đổi sang "Tạo khoản vay mới" (như R2-32)
  await openNewReceipt(page);
  await fillReceiptBase(page, { purpose: uniq('Chạy lại R2'), partner: bank.name, amount: '20000000' });
  await borrowCheckbox(page).check();
  await pickLoanMode(page, 'Để sau');
  const docId = await saveDraft(page);
  await page.getByRole('tab', { name: /Liên kết/ }).click();
  await page.getByRole('button', { name: '+ Gán liên kết' }).click();
  const linkModal = page.locator('.ant-modal:visible').last();
  await expect(linkModal).toContainText('Gán liên kết nghiệp vụ', { timeout: 10_000 });
  await pickSelect(page, /^Khoản vay ngân hàng/, manual.code);
  await linkModal.getByRole('button', { name: 'Gán liên kết', exact: true }).click();
  await expect(page.locator('.ant-modal:visible')).toHaveCount(0, { timeout: 15_000 });
  const manualLink = await eventually('liên kết giải ngân thủ công', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));
  await openReceiptEdit(page, docId, '20.000.000');
  await pickLoanMode(page, 'Tạo khoản vay mới');
  await page.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();

  // lượt R2 lỗi do xung đột sức chứa (hiện trạng: lưu được, lượt lỗi) — đây là điều kiện để kiểm "Chạy lại"
  const failed = await eventually('lượt R2 lỗi vì xung đột sức chứa', () => failedR2RunsOf(page, docId, cta), (rs) => rs.length > 0);
  // KTT/người lập gỡ liên kết gây xung đột (có lý do), rồi chạy lại lượt lỗi
  const rm = await removeLinkApi(page, docId, String(disbursementLinkTo(manualLink, manual._id)._id), cta, 'Gỡ để chạy lại R2 (thử nghiệm R2-34)');
  expect(rm.ok, `gỡ liên kết xung đột (API): HTTP ${rm.status} ${rm.text.slice(0, 200)}`).toBeTruthy();
  const rr = await api(chief, 'POST', `/automation/runs/${String(failed[0]._id)}/rerun`, { data: {}, scope: cta, expectOk: false });
  expect(rr.ok, `chạy lại lượt lỗi (KTT): HTTP ${rr.status} ${rr.text.slice(0, 200)}`).toBeTruthy();

  const loan = await eventually('khoản vay tự sinh được nối sau khi chạy lại', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l);
  const d = await eventually('liên kết tự sinh tới khoản vay sau khi chạy lại', () => getDocument(page, docId, cta), (x) => !!disbursementLinkTo(x, loan._id));
  expect(disbursementLinkTo(d, loan._id)?.origin, 'liên kết sau khi chạy lại = Tự động').toBe('automation');
  expect(autoLoansOf(await loansOf(page, bank._id, cta)), 'chạy lại không tạo khoản vay thứ hai').toHaveLength(1);
  expect(activeDisbursementsOf(d).map((l: any) => String(l.counterpart?.id)), 'chỉ một giải ngân hiệu lực (tới khoản vay tự sinh)').toEqual([String(loan._id)]);
  const runsAfter = await runsOfDocument(page, docId, cta);
  expect.soft(runsAfter.some((r: any) => r.rule_code === 'R2' && r.status === 'done' && String(r._id) === String(failed[0]._id)), 'lượt đã chạy lại có trạng thái Xong').toBeTruthy();
});

test('R2-35 panel "Quy trình tự động" tự cập nhật: lượt R2 xuất hiện sau khi hồ sơ đã tải (lúc tải danh sách lượt rỗng) hiện mà không cần tải lại', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 panel tự cập nhật'));
  // phiếu "để sau": lượt R2 chỉ có bước bỏ qua ⇒ danh sách lượt của hồ sơ lúc tải là rỗng
  const created = await createReceiptApi(page, cta, bank._id, '10000000', {
    kind: 'borrow', mode: 'later', lender_partner_id: bank._id, receive_account_id: null, amount_minor: null, existing_loan_id: null, terms: null,
  });
  expect(created.ok, `tạo phiếu để sau (API): ${created.text.slice(0, 200)}`).toBeTruthy();
  const docId = String(created.data?._id);
  await eventually('lượt R2 của phiếu đã xong (bước bỏ qua)', () => runsOfDocument(page, docId, cta), (rs) => rs.some((r) => r.rule_code === 'R2' && r.status === 'done'));

  await page.goto(docPath('thu', docId));
  await expectPageNotBroken(page, 'hồ sơ phiếu để sau không vỡ');
  await page.waitForTimeout(2_000);

  // khi trang đang mở (không tải lại, không đổi tiêu điểm): sửa phiếu sang "Tạo khoản vay mới" qua API
  const cur = await getDocument(page, docId, cta);
  const patch = await api(page, 'PATCH', `/documents/${docId}`, {
    data: {
      if_match: cur.version,
      options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank._id, receive_account_id: null, amount_minor: null, existing_loan_id: null, terms: null } },
    },
    scope: cta,
  });
  expect(patch.ok, `sửa phiếu (API): ${patch.text.slice(0, 200)}`).toBeTruthy();
  await eventually('lượt R2 có khoản vay sinh ra', () => runsOfDocument(page, docId, cta), (rs) => rs.some((r) => r.rule_code === 'R2' && r.status === 'done' && (r.generated ?? []).length > 0));

  // panel phải hiện lượt mới sau vài giây (bộ máy xử lý bất đồng bộ), không chờ tải lại trang
  await expect(page.getByText(/Quy trình tự động: R2/).first(), 'panel tự cập nhật khi lượt R2 xuất hiện sau khi hồ sơ đã tải').toBeVisible({ timeout: 20_000 });
});

test('R2-23 sửa phiếu "Tạo khoản vay mới" → "Để sau" (trước duyệt): khoản chờ giải ngân tự sinh thành Đã huỷ và gỡ liên kết tự sinh', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 vay mới để sau'));
  const docId = await createBorrowReceipt(page, bank, { amount: '60000000' });
  const loan0 = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l);
  await eventually('liên kết giải ngân tự sinh tới khoản vay', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, loan0._id));

  await openReceiptEdit(page, docId, '60.000.000');
  await pickLoanMode(page, 'Để sau');
  await saveEdit(page);

  await eventually('khoản vay tự sinh đã huỷ sau khi đổi sang để sau', () => getLoan(page, loan0._id, cta), (l) => l.status === 'cancelled');
  const d = await getDocument(page, docId, cta);
  expect.soft(disbursementLinkTo(d, loan0._id), 'liên kết tự sinh tới khoản đã huỷ được gỡ').toBeUndefined();
  expect.soft(activeDisbursementsOf(d), 'không còn giải ngân hiệu lực').toHaveLength(0);
  expect.soft((await failedR2RunsOf(page, docId, cta)).length, 'không có lượt R2 lỗi').toBe(0);
});

test('R2-24 phiếu "Gắn khoản vay đã có" được duyệt & thực thi: khoản đang vay giữ nguyên gốc, ngày giải ngân và hạn; liên kết Thủ công vẫn hiệu lực', async ({ as }) => {
  test.setTimeout(300_000);
  const { page: staff, cta } = await staffPage(as);
  const pages: Pages = {
    chief: await approverPage(as, 'chief', cta),
    director: await approverPage(as, 'director', cta),
    chairman: await approverPage(as, 'chairman', cta),
  };
  const bank = await createPartner(staff, cta, 'bank', uniq('NH R2 gắn rồi thực thi'));
  const manual = await createManualLoan(staff, cta, bank._id, '200000000', '2027-12-31');
  const before = await getLoan(staff, manual._id, cta);
  const docId = await createExistingLoanReceipt(staff, cta, bank, manual.code, '50000000');
  await eventually('liên kết giải ngân tới khoản đã có', () => getDocument(staff, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));

  const finalStatus = await approveToFinalByApi(staff, pages, docId, cta);
  expect(finalStatus, 'phiếu thu duyệt cuối tự thực thi').toBe('paid');
  await new Promise((r) => setTimeout(r, 3000)); // để bộ máy xử lý sự kiện thực thi
  const after = await getLoan(staff, manual._id, cta);
  expect(after.status, 'khoản đang vay vẫn Đang vay').toBe('active');
  expect(String(after.principal?.minor), 'khoản nhiều đợt: gốc giữ theo hợp đồng, không bị ghi đè bằng số tiền phiếu').toBe('200000000');
  expect(String(after.disbursed_at ?? '').slice(0, 10), 'ngày giải ngân không đổi khi có đợt mới').toBe(String(before.disbursed_at ?? '').slice(0, 10));
  expect(after.maturity_date, 'hạn thanh toán không đổi').toBe(before.maturity_date);
  const d = await getDocument(staff, docId, cta);
  expect.soft(disbursementLinkTo(d, manual._id)?.origin, 'liên kết vẫn là Thủ công sau thực thi').toBe('manual');
  expect.soft(String(disbursementLinkTo(d, manual._id)?.amount_minor), 'số tiền phân bổ = số tiền phiếu').toBe('50000000');
  expect.soft((await failedR2RunsOf(staff, docId, cta)).length, 'không có lượt R2 lỗi sau thực thi').toBe(0);

  // tải lại hồ sơ: khoản tạo tay (đang vay) không được hiện là đối tượng "đã tạo" của quy trình tự động
  await staff.goto(docPath('thu', docId));
  await expectPageNotBroken(staff, 'hồ sơ phiếu gắn có sẵn đã thực thi (tải lại) không bị vỡ');
  await expect(staff.getByText(`Gắn vào khoản vay ${manual.code} (Đang vay)`)).toBeVisible({ timeout: 15_000 });
  await expect(staff.getByText(`Đã tạo ${manual.code}`), 'khoản tạo tay không được liệt kê là "Đã tạo" sau thực thi').toHaveCount(0);
});

test('R2-25 đổi "Khoản vay có sẵn" sang khoản khác khi sửa phiếu: chỉ còn giải ngân tới khoản mới, khoản cũ không còn liên kết', async ({ as }) => {
  test.setTimeout(180_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 đổi khoản có sẵn'));
  const loan1 = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const loan2 = await createManualLoan(page, cta, bank._id, '150000000', '2027-12-31');
  const docId = await createExistingLoanReceipt(page, cta, bank, loan1.code, '50000000');
  await eventually('liên kết tới khoản thứ nhất', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, loan1._id));

  await openReceiptEdit(page, docId, '50.000.000');
  await pickSelect(page, /^Khoản vay có sẵn/, loan2.code);
  await saveEdit(page);

  await page.waitForTimeout(3000);
  const d = await getDocument(page, docId, cta);
  expect.soft(disbursementLinkTo(d, loan2._id)?.origin, 'liên kết tới khoản mới = Thủ công').toBe('manual');
  expect.soft(disbursementLinkTo(d, loan1._id), 'khoản cũ không còn liên kết hiệu lực').toBeUndefined();
  expect.soft(activeDisbursementsOf(d), 'chỉ một giải ngân hiệu lực').toHaveLength(1);
  expect.soft(String((await getLoan(page, loan1._id, cta)).principal?.minor), 'khoản cũ giữ gốc').toBe('200000000');
});

test('R2-26 lưu phiếu "Gắn khoản vay đã có" với số tiền vượt phần còn lại của khoản vay: máy chủ từ chối, không ghi liên kết (API)', async ({ as }) => {
  test.setTimeout(120_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 vượt sức chứa'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const r = await createReceiptApi(page, cta, bank._id, '250000000', {
    kind: 'borrow', mode: 'existing', lender_partner_id: bank._id, receive_account_id: null, amount_minor: null, existing_loan_id: manual._id, terms: null,
  });
  expect(r.ok, `phiếu 250 triệu gắn khoản 200 triệu phải bị chặn (HTTP ${r.status}: ${r.text.slice(0, 200)})`).toBeFalsy();
  expect(r.text, 'thông báo nêu sức chứa không đủ').toMatch(/FG-LINK-002|không đủ|chỉ còn/);
  const after = await getLoan(page, manual._id, cta);
  expect((after.disbursement_links ?? []).length, 'không có liên kết giải ngân nào được ghi tới khoản vay').toBe(0);
});

/* ============================== 9. retest vòng 4: hồ sơ sau khi sửa; đổi chế độ ============================== */

test('R2-27 sửa phiếu xong trong ứng dụng, hồ sơ hiện ngay trạng thái đã lưu và vẫn đúng sau 16 s (không giữ banner trước khi sửa)', async ({ as }) => {
  test.setTimeout(240_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 banner sau lưu'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  // lưu phiếu: ứng dụng chuyển sang hồ sơ bằng điều hướng trong ứng dụng (bản đệm = trạng thái trước khi sửa)
  const docId = await createExistingLoanReceipt(page, cta, bank, manual.code, '50000000');
  await expect(page.getByText(`Gắn vào khoản vay ${manual.code} (Đang vay)`)).toBeVisible({ timeout: 20_000 });

  // sửa bằng nút "Sửa" trên hồ sơ (KHÔNG tải lại trang, để giữ bản đệm): chuyển sang "Để sau" rồi lưu
  await page.getByRole('button', { name: 'Sửa', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Lưu thay đổi', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Số tiền', { exact: true })).toHaveValue('50.000.000', { timeout: 30_000 });
  await pickLoanMode(page, 'Để sau');
  await saveEdit(page);
  const laterText = 'Chưa gắn khoản vay — gán sau từ khoản vay hoặc từ phiếu';
  const stale = `Gắn vào khoản vay ${manual.code}`;

  await expect(page.getByText(laterText), 'ngay sau khi lưu, hồ sơ hiện trạng thái đã lưu (Để sau)').toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(stale), 'không còn banner khoản vay cũ sau khi lưu').toHaveCount(0);
  // quá thời gian bản đệm (10 s) và trước chu kỳ làm mới 30 s: vẫn phải là dữ liệu đã lưu, không cần tải lại
  await page.waitForTimeout(16_000);
  await expect(page.getByText(laterText), 'sau 16 s hồ sơ vẫn hiện trạng thái đã lưu (không quay về banner cũ)').toBeVisible({ timeout: 3_000 });
  await expect(page.getByText(stale), 'sau 16 s không còn banner khoản vay cũ').toHaveCount(0);
  const d = await getDocument(page, docId, cta);
  expect(d.options?.loan?.mode, 'máy chủ lưu chế độ "để sau"').toBe('later');
});

test('R2-28 sửa phiếu "Tạo khoản vay mới" → "Gắn khoản vay đã có" (trước duyệt): khoản tự sinh chờ giải ngân bị huỷ, chỉ còn liên kết Thủ công tới khoản có sẵn', async ({ as }) => {
  test.setTimeout(200_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 mới sang có sẵn'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const docId = await createBorrowReceipt(page, bank, { amount: '50000000' });
  const auto = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l);
  await eventually('liên kết tự sinh tới khoản vay tự sinh', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, auto._id));

  await openReceiptEdit(page, docId, '50.000.000');
  await pickLoanMode(page, 'Gắn khoản vay đã có');
  await pickSelect(page, /^Khoản vay có sẵn/, manual.code);
  await saveEdit(page);

  await eventually('khoản vay tự sinh bị huỷ sau khi chọn khoản có sẵn', () => getLoan(page, auto._id, cta), (l) => l.status === 'cancelled');
  const d = await eventually('liên kết Thủ công tới khoản có sẵn', () => getDocument(page, docId, cta), (x) => !!disbursementLinkTo(x, manual._id));
  expect.soft(disbursementLinkTo(d, manual._id)?.origin, 'liên kết tới khoản có sẵn = Thủ công').toBe('manual');
  expect.soft(disbursementLinkTo(d, auto._id), 'liên kết tự sinh tới khoản đã huỷ được gỡ').toBeUndefined();
  expect.soft(activeDisbursementsOf(d).map((l: any) => l.counterpart?.id), 'chỉ một giải ngân hiệu lực (tới khoản có sẵn)').toEqual([manual._id]);
  expect.soft((await failedR2RunsOf(page, docId, cta)).length, 'không có lượt R2 lỗi').toBe(0);
  expect.soft(String((await getLoan(page, manual._id, cta)).principal?.minor), 'khoản có sẵn giữ nguyên gốc').toBe('200000000');
});

test('R2-29 "Tạo khoản vay mới" → "Để sau" → "Tạo khoản vay mới" (trước duyệt): khoản tự sinh được phục hồi, một khoản, một liên kết, không lỗi R2', async ({ as }) => {
  test.setTimeout(220_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 phục hồi'));
  const docId = await createBorrowReceipt(page, bank, { amount: '45000000' });
  // chẩn đoán khi không có khoản: ghi rõ trạng thái lượt R2 của phiếu (lượt "running" bị bỏ dở ⇒ tiến trình API đã khởi động lại giữa chừng)
  const loan0 = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l, 45_000).catch(async (e: Error) => {
    const runs = (await runsOfDocument(page, docId, cta)).map((r) => ({ rule: r.rule_code, status: r.status, attempts: r.attempts, error: r.error, updated_at: r.updated_at }));
    throw new Error(`${e.message} · lượt của phiếu: ${JSON.stringify(runs).slice(0, 500)}`);
  });

  await openReceiptEdit(page, docId, '45.000.000');
  await pickLoanMode(page, 'Để sau');
  await saveEdit(page);
  await eventually('khoản tự sinh đã huỷ khi chọn để sau', () => getLoan(page, loan0._id, cta), (l) => l.status === 'cancelled');

  await openReceiptEdit(page, docId, '45.000.000');
  await pickLoanMode(page, 'Tạo khoản vay mới');
  await saveEdit(page);
  const back = await eventually('khoản tự sinh được phục hồi khi chọn lại vay mới', () => getLoan(page, loan0._id, cta), (l) => l.status === 'pending_disbursement');
  expect(String(back.principal?.minor), 'gốc theo số tiền phiếu').toBe('45000000');
  const d = await eventually('liên kết tự sinh được tạo lại', () => getDocument(page, docId, cta), (x) => !!disbursementLinkTo(x, loan0._id));
  expect.soft(disbursementLinkTo(d, loan0._id)?.origin, 'liên kết tạo lại = Tự động').toBe('automation');
  expect.soft(activeDisbursementsOf(d), 'chỉ một giải ngân hiệu lực').toHaveLength(1);
  expect(autoLoansOf(await loansOf(page, bank._id, cta)), 'không tạo khoản vay thứ hai khi phục hồi').toHaveLength(1);
  await page.waitForTimeout(3000);
  expect.soft((await failedR2RunsOf(page, docId, cta)).length, 'không có lượt R2 lỗi').toBe(0);
});

test('R2-30 sửa số tiền phiếu "Gắn khoản vay đã có" vượt sức chứa khoản vay: máy chủ từ chối, phiếu và liên kết giữ nguyên (API)', async ({ as }) => {
  test.setTimeout(150_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 sửa vượt sức chứa'));
  const manual = await createManualLoan(page, cta, bank._id, '200000000', '2027-12-31');
  const docId = await createExistingLoanReceipt(page, cta, bank, manual.code, '50000000');
  await eventually('liên kết tới khoản đã có', () => getDocument(page, docId, cta), (d) => !!disbursementLinkTo(d, manual._id));

  const before = await getDocument(page, docId, cta);
  const r = await api(page, 'PATCH', `/documents/${docId}`, {
    data: { amount: { amount_minor: '250000000', currency: 'VND' }, if_match: before.version },
    scope: cta,
    expectOk: false,
  });
  expect(r.ok, `sửa phiếu lên 250 triệu vào khoản 200 triệu phải bị chặn (HTTP ${r.status}: ${r.text.slice(0, 200)})`).toBeFalsy();
  expect(r.text, 'thông báo nêu sức chứa không đủ').toMatch(/FG-LINK-002|không đủ|chỉ còn/);
  const after = await getDocument(page, docId, cta);
  expect(after.version, 'phiếu không đổi phiên bản').toBe(before.version);
  expect(disbursementLinkTo(after, manual._id)?.amount_minor, 'liên kết giữ số tiền cũ (50 triệu)').toBe('50000000');
  expect(String(after.amount?.minor ?? after.amount?.amount_minor ?? ''), 'số tiền phiếu giữ nguyên (50 triệu)').toBe('50000000');
});

test('R2-31 sửa trong ứng dụng phiếu "Tạo khoản vay mới" (đổi số tiền và số HĐ): banner hồ sơ hiện ngay giá trị đã lưu, không giữ giá trị cũ sau 16 s', async ({ as }) => {
  test.setTimeout(200_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 banner mới'));
  const oldContract = uniq('HĐ banner cũ');
  const newContract = uniq('HĐ banner mới');
  // phiếu vừa lưu: ứng dụng chuyển sang hồ sơ bằng điều hướng trong ứng dụng (bản đệm = giá trị trước khi sửa)
  const docId = await createBorrowReceipt(page, bank, { amount: '50000000', contractNo: oldContract });
  const loan0 = await eventually('khoản vay R2 chờ giải ngân', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l);
  await expect(page.getByText(`Số HĐ tín dụng: ${oldContract}`)).toBeVisible({ timeout: 20_000 });

  // sửa bằng nút "Sửa" trên hồ sơ (không tải lại trang): gốc 70 triệu, số HĐ mới
  await page.getByRole('button', { name: 'Sửa', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Lưu thay đổi', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Số tiền', { exact: true })).toHaveValue('50.000.000', { timeout: 30_000 });
  await fillAmount(page, '70000000');
  await fillField(page, /^Số HĐ tín dụng/, newContract);
  await saveEdit(page);

  await expect(page.getByText(`Số HĐ tín dụng: ${newContract}`), 'ngay sau khi lưu, banner hiện số HĐ mới').toBeVisible({ timeout: 5_000 });
  await expect(page.getByText(`Số HĐ tín dụng: ${oldContract}`), 'không còn số HĐ cũ trên banner').toHaveCount(0);
  await eventually('khoản vay đồng bộ gốc 70 triệu và số HĐ mới', () => getLoan(page, loan0._id, cta), (l) => String(l.principal?.minor) === '70000000' && l.contract_no === newContract);
  await page.waitForTimeout(16_000);
  await expect(page.getByText(`Số HĐ tín dụng: ${newContract}`), 'sau 16 s banner vẫn là số HĐ mới (không quay về bản trước khi sửa)').toBeVisible({ timeout: 3_000 });
  await expect(page.getByText(`Số HĐ tín dụng: ${oldContract}`)).toHaveCount(0);
  await expect(page.getByText('Khoản vay mới — tạo khi lưu phiếu (chờ giải ngân)')).toBeVisible({ timeout: 5_000 });
});

/* ============================== 10. retest vòng 5: lượt bị bỏ dở được tiếp quản ============================== */

/**
 * Chạy đoạn mongosh trên MongoDB của môi trường test (container `fingate-mongo`, CSDL `fingate`), đọc dòng JSON cuối
 * (đoạn script kết thúc bằng `print(JSON.stringify(...))`). CHỈ dùng để chuẩn bị / đọc trạng thái NỘI BỘ mà API không
 * cung cấp (lượt đang chạy bị bỏ dở, cờ đã xử lý của sự kiện) — không dùng để kiểm tra nghiệp vụ.
 */
function mongoEval<T>(script: string): T {
  const out = execFileSync('docker', ['exec', 'fingate-mongo', 'mongosh', '--quiet', 'fingate', '--eval', script], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const last = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? 'null';
  return JSON.parse(last) as T;
}

/** Sự kiện nguồn đã được đánh dấu xử lý trong CSDL (processed_at có giá trị)? */
function eventProcessedInDb(eventId: string): boolean {
  return mongoEval<{ processed: boolean }>(
    `const ev = db.domain_events.findOne({ _id: ObjectId('${eventId}') }); print(JSON.stringify({ processed: ev.processed_at != null }));`,
  ).processed;
}

/**
 * Các bước R2 ở trạng thái "chờ" (đúng như `getOrCreateRun` tạo khi lượt được lập). Lượt không có bước nào
 * sẽ bị bộ lọc "bỏ lượt mà mọi bước đều bỏ qua" của danh sách lượt ẩn khỏi panel — không phải tình huống thật.
 */
const R2_STEPS_PENDING = `[${['create_loan', 'activate_loan', 'link']
  .map((n) => `{ name: '${n}', status: 'pending', output_type: null, output_id: null, error: null, at: null }`)
  .join(', ')}]`;

test('R2-36 lượt R2 bị bỏ dở (tiến trình trước dừng giữa chừng: lượt còn "Đang chạy" trong lease, sự kiện chưa xử lý): sự kiện không bị đánh dấu xong sớm; hết lease bộ máy tiếp quản và tạo khoản vay, không Lỗi', async ({ as }) => {
  test.setTimeout(240_000);
  const { page, cta } = await staffPage(as);
  const bank = await createPartner(page, cta, 'bank', uniq('NH R2 tiếp quản'));
  // (1) phiếu "để sau": lượt R2 đã xong (mọi bước bỏ qua), chưa có khoản vay
  const created = await createReceiptApi(page, cta, bank._id, '15000000', {
    kind: 'borrow', mode: 'later', lender_partner_id: bank._id, receive_account_id: null, amount_minor: null, existing_loan_id: null, terms: null,
  });
  expect(created.ok, `tạo phiếu để sau (API): ${created.text.slice(0, 200)}`).toBeTruthy();
  const docId = String(created.data?._id);
  await eventually('lượt R2 của phiếu để sau đã xong', () => runsOfDocument(page, docId, cta), (rs) => rs.some((r) => r.rule_code === 'R2' && r.status === 'done'));

  // (2) mô phỏng tiến trình chết giữa chừng (ghi thẳng CSDL, không qua API để không sinh sự kiện mới): phiếu chuyển sang
  //     "Tạo khoản vay mới"; lượt R2 còn "Đang chạy" với lease CÒN ~30 s (RUN_LEASE_MS = 5 phút, engine.ts); sự kiện nguồn CHƯA xử lý.
  const RUN_LEASE_MS = 5 * 60_000;
  const LEASE_LEFT_MS = 30_000;
  const leaseEndAt = Date.now() + LEASE_LEFT_MS;
  const sim = mongoEval<{ runId: string; eventId: string }>(
    [
      `const d = ObjectId('${docId}');`,
      `const r = db.automation_runs.find({ rule_code: 'R2', source_id: d }).sort({ created_at: -1 }).limit(1).toArray()[0];`,
      `db.documents.updateOne({ _id: d }, { $set: { 'options.loan.mode': 'new' } });`,
      `db.automation_runs.updateOne({ _id: r._id }, { $set: { status: 'running', claimed_at: new Date(Date.now() - ${RUN_LEASE_MS - LEASE_LEFT_MS}), error: null, steps: ${R2_STEPS_PENDING}, updated_at: new Date() } });`,
      `db.domain_events.updateOne({ _id: r.event_id }, { $set: { processed_at: null, claimed_at: null } });`,
      `print(JSON.stringify({ runId: String(r._id), eventId: String(r.event_id) }));`,
    ].join(' '),
  );

  // (3) trong lúc lượt còn lease (sau ≥ 2 chu kỳ bộ máy 5 s, còn ~15 s trước khi hết lease): sự kiện vẫn CHƯA xử lý,
  //     lượt vẫn "Đang chạy", chưa có khoản vay. (Bản lỗi: sự kiện bị đánh dấu xong ngay ⇒ lượt chết hẳn, khoản không bao giờ được tạo.)
  await page.waitForTimeout(12_000);
  const runDuring = (await runsOfDocument(page, docId, cta)).find((r: any) => String(r._id) === sim.runId);
  expect(eventProcessedInDb(sim.eventId), 'trong lease: sự kiện nguồn CHƯA được đánh dấu đã xử lý (bộ máy giữ lại để tiếp quản)').toBe(false);
  expect(runDuring?.status, 'trong lease: lượt vẫn "Đang chạy" (chưa bị đánh dấu Lỗi)').toBe('running');
  expect(autoLoansOf(await loansOf(page, bank._id, cta)), 'trong lease: chưa tạo khoản vay').toHaveLength(0);

  // (4) hết lease: bộ máy tiếp quản lượt (nhánh takeover của claimRun) và tạo khoản vay chờ giải ngân trong vài giây,
  //     không cần KTT chạy lại thủ công (v2 §11.2: xử lý bất đồng bộ "vài giây"; US-AUTO-05)
  const loan = await eventually('khoản vay R2 được tạo sau khi hết lease (bộ máy tiếp quản)', async () => autoLoansOf(await loansOf(page, bank._id, cta))[0], (l) => !!l, 90_000);
  const seenAt = Date.now();
  expect(seenAt - leaseEndAt, 'khoản vay xuất hiện trong vài chục giây sau khi hết lease, không phải chờ lâu').toBeLessThan(30_000);
  expect(loan.status, 'khoản vay tiếp quản ở trạng thái chờ giải ngân').toBe('pending_disbursement');
  expect(String(loan.principal?.minor), 'gốc = số tiền phiếu').toBe('15000000');
  await eventually('lượt R2 đã xong sau khi tiếp quản', () => runsOfDocument(page, docId, cta), (rs) => rs.some((r) => String(r._id) === sim.runId && r.status === 'done'), 60_000);
  expect(eventProcessedInDb(sim.eventId), 'sau khi tiếp quản: sự kiện đã được đánh dấu xử lý').toBe(true);
  expect(autoLoansOf(await loansOf(page, bank._id, cta)), 'không tạo khoản vay thứ hai').toHaveLength(1);
  expect((await runsOfDocument(page, docId, cta)).filter((r) => r.rule_code === 'R2' && r.status === 'failed'), 'không có lượt R2 lỗi').toHaveLength(0);
  const d = await eventually('liên kết giải ngân tự sinh tới khoản vay tiếp quản', () => getDocument(page, docId, cta), (x) => !!disbursementLinkTo(x, loan._id));
  expect.soft(disbursementLinkTo(d, loan._id)?.origin, 'liên kết tiếp quản = Tự động').toBe('automation');
});

test('R2-37 lượt R2 bị gián đoạn (lượt còn "Đang chạy" quá lease, sự kiện đã xử lý) ⇒ bộ máy đánh dấu "Lỗi"; KTT bấm "Chạy lại" trên hồ sơ ⇒ khoản vay tạo đúng một lần (US-AUTO-05)', async ({ as }) => {
  test.setTimeout(240_000);
  const { page: staff, cta } = await staffPage(as);
  const chief = await approverPage(as, 'chief', cta);
  const bank = await createPartner(staff, cta, 'bank', uniq('NH R2 chạy lại'));
  // (1) phiếu "để sau": lượt R2 đã xong (mọi bước bỏ qua), chưa có khoản vay
  const created = await createReceiptApi(staff, cta, bank._id, '12000000', {
    kind: 'borrow', mode: 'later', lender_partner_id: bank._id, receive_account_id: null, amount_minor: null, existing_loan_id: null, terms: null,
  });
  expect(created.ok, `tạo phiếu để sau (API): ${created.text.slice(0, 200)}`).toBeTruthy();
  const docId = String(created.data?._id);
  await eventually('lượt R2 của phiếu để sau đã xong', () => runsOfDocument(staff, docId, cta), (rs) => rs.some((r) => r.rule_code === 'R2' && r.status === 'done'));

  // (2) tiến trình chết khi đang chạy (ghi thẳng CSDL): phiếu chuyển sang "Tạo khoản vay mới"; lượt còn "Đang chạy" nhưng đã
  //     quá lease (RUN_LEASE_MS = 5 phút); sự kiện nguồn ĐÃ xử lý ⇒ lượt mồ côi, bộ máy đánh dấu "Lỗi" (sweepStaleRuns)
  const RUN_LEASE_MS = 5 * 60_000;
  const sim = mongoEval<{ runId: string }>(
    [
      `const d = ObjectId('${docId}');`,
      `const r = db.automation_runs.find({ rule_code: 'R2', source_id: d }).sort({ created_at: -1 }).limit(1).toArray()[0];`,
      `db.documents.updateOne({ _id: d }, { $set: { 'options.loan.mode': 'new' } });`,
      `db.automation_runs.updateOne({ _id: r._id }, { $set: { status: 'running', claimed_at: new Date(Date.now() - ${RUN_LEASE_MS + 60_000}), error: null, steps: ${R2_STEPS_PENDING}, updated_at: new Date() } });`,
      `print(JSON.stringify({ runId: String(r._id) }));`,
    ].join(' '),
  );

  // (3) bộ máy đánh dấu lượt "Lỗi" và KHÔNG tự tạo khoản vay; KTT thấy "Lỗi — cần chạy lại" trên hồ sơ
  await eventually('lượt R2 bị gián đoạn được đánh dấu Lỗi', () => runsOfDocument(staff, docId, cta), (rs) => rs.some((r) => String(r._id) === sim.runId && r.status === 'failed'), 60_000);
  expect(autoLoansOf(await loansOf(staff, bank._id, cta)), 'lượt lỗi: chưa tự tạo khoản vay').toHaveLength(0);
  await chief.goto(docPath('thu', docId));
  await expectPageNotBroken(chief, 'hồ sơ phiếu có lượt R2 lỗi không vỡ (KTT)');
  await expect(chief.getByText('Lỗi — cần chạy lại').first(), 'panel hiện "Lỗi — cần chạy lại" cho lượt R2 bị gián đoạn').toBeVisible({ timeout: 20_000 });

  // (4) KTT bấm "Chạy lại" (chỉ chạy các bước chưa xong, không tạo trùng)
  await chief.getByRole('button', { name: 'Chạy lại', exact: true }).first().click();

  // (5) khoản vay được tạo đúng một lần với gốc = số tiền phiếu; lượt xong; panel hiện khoản đã tạo
  const loan = await eventually('khoản vay R2 được tạo sau khi KTT chạy lại', async () => autoLoansOf(await loansOf(staff, bank._id, cta))[0], (l) => !!l, 60_000);
  expect(String(loan.principal?.minor), 'gốc = số tiền phiếu').toBe('12000000');
  expect(autoLoansOf(await loansOf(staff, bank._id, cta)), 'chạy lại không tạo khoản vay thứ hai').toHaveLength(1);
  await eventually('lượt R2 đã xong sau khi chạy lại', () => runsOfDocument(staff, docId, cta), (rs) => rs.some((r) => String(r._id) === sim.runId && r.status === 'done'), 30_000);
  await expect(chief.getByText(new RegExp(`${loan.code} \\(chờ giải ngân\\)`)).first(), 'panel hiện khoản vay đã tạo sau khi chạy lại').toBeVisible({ timeout: 20_000 });
});

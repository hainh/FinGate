/**
 * Ô chọn đối tác trên form nghiệp vụ — v2/v2.md §5.1, §5.2, US-PAR-02.
 *
 *   PW_AREA=picker npx playwright test e2e/v2-partner-picker.spec.ts
 *
 * Phạm vi: tìm theo tên/STK/MST (kể cả đoạn số giữa) · loại hợp lệ theo từng chỗ dùng · đối tác ngừng
 * giao dịch · popup "+ Tạo đối tác" (loại điền sẵn, tên điền sẵn, giữ dữ liệu form, huỷ, bàn phím, chân
 * dropdown) · cảnh báo trùng · "Sửa đối tác" (kể cả đổi loại làm vỡ ràng buộc) · bỏ chọn · bắt buộc chọn
 * đối tác · phiếu thu "đi vay" · khoản chi định kỳ · đang chọn đối tác A rồi gõ tìm đối tác khác · danh sách
 * khi đổi chữ / đang tải / lỗi tải · đổi sang đối tác khác khi chi tiết đang tải · cảnh báo trùng của tên cũ ·
 * đổi loại đối tác đang được phiếu "đi vay" dùng (§5.1, FG-PARTNER-003) · khoản vay / khoản đảo hạn đã chọn không
 * được giữ khi đổi ngân hàng (§11.4 b, phiếu thu "gắn khoản đã có" và phương án đảo hạn).
 * Mọi trang mở bằng `as(...)` đều được theo dõi lỗi JS (pageerror) và HTTP 5xx: có lỗi là test FAIL.
 * Dữ liệu test dùng uniq() / STK-MST ngẫu nhiên; không xoá dữ liệu có sẵn.
 */
import { test as baseTest, expect, uniq, type Role } from './fixtures';
import { randomUUID } from 'node:crypto';
import type { Locator, Page, Route } from '@playwright/test';
import {
  CTA,
  CTB,
  ROUTES,
  TYPE_LABEL,
  apiCreatePartner,
  apiDeactivatePartner,
  apiGetPartner,
  apiOptions,
  clickDropdownCreate,
  comboOf,
  dropdown,
  expectPopupClosed,
  fieldOf,
  fillAmount,
  openForm,
  optionNamed,
  optionsOf,
  partnerPopup,
  pickerOf,
  popAccount,
  popBank,
  popChooseType,
  popFooter,
  popName,
  popSelectedType,
  popTax,
  popTypeOptions,
  readonlyLine,
  recurModalLocator,
  searchPicker,
  sideCreateButton,
  toast,
  trackWrites,
  uniqDigits,
  type PartnerType,
} from './helpers-picker';

/**
 * Ghim công ty đang làm việc của TRANG về CTA (đúng công ty mà spec tạo dữ liệu).
 * Lý do: app chọn công ty khi đăng nhập theo `prefs.default_scope` của TÀI KHOẢN DÙNG CHUNG (PATCH /me/prefs mỗi
 * lần đổi phạm vi); spec khác chạy song song có thể đổi nó (vd. sang MAYOGU) ⇒ ô chọn tìm trong công ty sai và
 * đối tác vừa tạo ở CTA "biến mất". Chỉ sửa phản hồi GET /me của TRANG này (không ghi DB, không đổi cài đặt chung).
 */
async function pinCompanyToCta(page: Page): Promise<void> {
  await page.route('**/api/v1/me', async (route) => {
    const res = await route.fetch();
    if (!res.ok()) return route.fulfill({ response: res });
    const json = (await res.json()) as Record<string, unknown>;
    const me = (json && typeof json === 'object' && 'data' in json ? json.data : json) as
      | { scope?: { company_ids?: string[] }; prefs?: Record<string, unknown> }
      | undefined;
    if (me?.scope?.company_ids?.includes(CTA)) me.prefs = { ...(me.prefs ?? {}), default_scope: CTA };
    const headers = { ...res.headers() };
    delete headers['content-length'];
    delete headers['content-encoding'];
    return route.fulfill({ status: res.status(), headers, body: JSON.stringify(json) });
  });
}

/**
 * Bộ theo dõi lỗi gắn cho mọi trang mở bằng `as(...)`: lỗi JS (pageerror) hoặc phản hồi HTTP 5xx làm FAIL test.
 * Phản hồi 4xx chỉ ghi log `[watch <mã> <vai trò>]` để rà soát (vd. 409 khi đổi loại bị chặn là có chủ đích).
 */
const test = baseTest.extend<{ as: (role: Role) => Promise<Page> }>({
  as: async ({ as: openAs }, use) => {
    const problems: string[] = [];
    await use(async (role) => {
      // API đang khởi động lại (node --watch khi có sửa code) ⇒ đăng nhập trả 502/503: thử lại, không tính là lỗi
      let page: Page | null = null;
      for (let attempt = 1; !page; attempt++) {
        try {
          page = await openAs(role);
        } catch (e) {
          if (attempt >= 4 || !/: 50[23]\b/.test((e as Error).message)) throw e;
          await new Promise((r) => setTimeout(r, 8000));
        }
      }
      await pinCompanyToCta(page);
      page.on('pageerror', (err) => problems.push(`[${role}] pageerror: ${err.message}`));
      page.on('response', (res) => {
        const status = res.status();
        if (status < 400) return;
        const path = new URL(res.url()).pathname;
        if (status >= 500) problems.push(`[${role}] HTTP ${status} ${res.request().method()} ${path}`);
        else console.log(`[watch ${status} ${role}] ${res.request().method()} ${path}`);
      });
      return page;
    });
    expect(problems, 'không có lỗi JS (pageerror) hoặc lỗi máy chủ 5xx trong lúc thao tác').toEqual([]);
  },
});

/* ============================== nhãn ô chọn theo màn ============================== */

const PAY_PICKER = 'Bên nhận tiền';
const LENDER_PICKER = 'Ngân hàng cho vay';
const REC_PICKER = 'Bên nộp tiền';
const DEBT_PICKER = 'Khách hàng / Nhà cung cấp';
const LOAN_PICKER = 'Ngân hàng cho vay';
const RECUR_PICKER = 'Bên nhận';

const ALL: PartnerType[] = ['bank', 'customer', 'supplier'];

const BORROW_CHECKBOX = 'Đây là khoản vay ngân hàng (đi vay)';
const LOAN_CHECKBOX = 'Vay ngân hàng để chi';
const BORROW_NOT_BANK = 'Phiếu thu đi vay: bên nộp tiền phải là Ngân hàng — chọn lại đối tác';

/* ============================== thao tác phụ trợ ============================== */

async function tickCheckbox(page: Page, labelText: string): Promise<void> {
  const cb = page.locator('label').filter({ hasText: labelText }).locator('input[type="checkbox"]').first();
  await cb.click();
  await expect(cb).toBeChecked();
}

async function tickBorrow(page: Page): Promise<void> {
  await tickCheckbox(page, BORROW_CHECKBOX);
}

async function tickLoanForSpend(page: Page): Promise<void> {
  await tickCheckbox(page, LOAN_CHECKBOX);
}

/** Thân (postData) của mọi POST /api/v1/documents trong lúc chạy thao tác — kiểm "không gửi khoản của NH cũ". */
function trackDocPosts(page: Page): string[] {
  const bodies: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/documents') bodies.push(r.postData() ?? '');
  });
  return bodies;
}

/** Khoản vay ngân hàng qua API (setup dữ liệu) của công ty CTA; trả về `_id` và mã khoản. */
async function apiCreateLoan(page: Page, bankId: string): Promise<{ _id: string; code: string }> {
  const maturity = new Date();
  maturity.setFullYear(maturity.getFullYear() + 1);
  const res = await page.request.post('/api/v1/bank-debts', {
    data: {
      company_id: CTA,
      partner_id: bankId,
      amount: { amount_minor: '1000000000', currency: 'VND' },
      maturity_date: maturity.toISOString().slice(0, 10),
      interest_rate: '9.5',
      payment_frequency: 'maturity',
      repayment_method: 'interest_only',
    },
    headers: { 'x-company-scope': CTA },
  });
  const text = await res.text();
  expect(res.status(), `tạo khoản vay: ${text}`).toBe(201);
  return (JSON.parse(text) as { data: { _id: string; code: string } }).data;
}

/** Mở ô khoản vay (FgSelect) và chọn khoản có mã `code`. */
async function pickLoan(page: Page, loanField: Locator, code: string): Promise<void> {
  await loanField.locator('.ant-select').first().click();
  await dropdown(page).locator('.ant-select-item-option').filter({ hasText: code }).first().click();
  await expect(loanField.locator('.ant-select')).toContainText(code);
}

/**
 * Đổi NH của ô chọn đối tác khi đang có khoản vay đã chọn của NH cũ.
 * `direct` = chọn NH khác ngay; `clear` = bỏ chọn (×) rồi chọn NH khác.
 */
async function switchBank(page: Page, picker: Locator, toName: string, mode: 'direct' | 'clear'): Promise<void> {
  if (mode === 'clear') {
    await picker.locator('.ant-select').first().hover();
    await picker.locator('.ant-select-clear').click({ force: true });
  }
  await searchPicker(page, picker, toName);
  await optionNamed(page, toName).first().click();
  await expect(picker.locator('.ant-select')).toContainText(toName);
}

/** Thông tin bảng cấu hình một chỗ dùng ô chọn đối tác. */
interface Context {
  id: string;
  /** Đường dẫn màn (bỏ qua khi `modal`). */
  path?: string;
  /** Khoản chi định kỳ: ô nằm trong modal "Khoản chi định kỳ mới". */
  modal?: boolean;
  /** Bước bổ sung sau khi mở màn (vd. tick "đi vay"). */
  prepare?: (page: Page) => Promise<void>;
  label: string;
  /** Loại được liệt kê khi tìm. */
  allowed: PartnerType[];
  /** Loại điền sẵn trong popup "+ Tạo đối tác". */
  defaultType: PartnerType;
  /** Nhãn các chữ khác trong popup (nếu có nhiều loại thì hiển thị radio). */
  placeholderHint?: string;
}

const CONTEXTS: Context[] = [
  { id: 'phiếu chi', path: ROUTES.payment, label: PAY_PICKER, allowed: ALL, defaultType: 'supplier' },
  { id: 'phiếu chi · vay ngân hàng để chi', path: ROUTES.payment, prepare: tickLoanForSpend, label: LENDER_PICKER, allowed: ['bank'], defaultType: 'bank' },
  { id: 'phiếu thu', path: ROUTES.receipt, label: REC_PICKER, allowed: ALL, defaultType: 'customer' },
  { id: 'phiếu thu · đi vay', path: ROUTES.receipt, prepare: tickBorrow, label: REC_PICKER, allowed: ['bank'], defaultType: 'bank' },
  { id: 'công nợ', path: ROUTES.debt, label: DEBT_PICKER, allowed: ['customer', 'supplier'], defaultType: 'customer' },
  { id: 'nợ ngân hàng', path: ROUTES.bankDebt, label: LOAN_PICKER, allowed: ['bank'], defaultType: 'bank' },
  { id: 'khoản chi định kỳ', modal: true, label: RECUR_PICKER, allowed: ALL, defaultType: 'customer' },
];

/** Mở đúng màn/modal của chỗ dùng; trả về phạm vi chứa form và ô chọn. */
async function openContext(page: Page, ctx: Context): Promise<{ scope: Page | Locator; picker: Locator }> {
  if (ctx.modal) {
    await page.goto(ROUTES.recurring);
    await page.getByRole('button', { name: '+ Thêm khoản định kỳ' }).click();
    const modal = recurModalLocator(page);
    await expect(modal).toBeVisible({ timeout: 15000 });
    const picker = pickerOf(modal, ctx.label);
    await expect(picker).toBeVisible();
    return { scope: modal, picker };
  }
  await page.goto(ctx.path!);
  if (ctx.prepare) await ctx.prepare(page);
  const picker = pickerOf(page, ctx.label);
  await expect(picker).toBeVisible({ timeout: 20000 });
  return { scope: page, picker };
}

/** Tên ba đối tác (ngân hàng / KH / NCC) dùng chung một tiền tố để tìm một lần. */
async function seedThreeTypes(page: Page, base: string): Promise<Record<PartnerType, string>> {
  const names: Record<PartnerType, string> = {
    bank: `${base} NGANHANG`,
    customer: `${base} KHACHHANG`,
    supplier: `${base} NHACC`,
  };
  await apiCreatePartner(page, { type: 'bank', name: names.bank, bank_name: 'BIDV', account_number: uniqDigits(12) });
  await apiCreatePartner(page, { type: 'customer', name: names.customer });
  await apiCreatePartner(page, { type: 'supplier', name: names.supplier, tax_code: uniqDigits(10) });
  return names;
}

/** Kiểm tra danh sách gợi ý theo loại được phép. */
async function expectListedTypes(page: Page, picker: Locator, base: string, names: Record<PartnerType, string>, allowed: PartnerType[]): Promise<void> {
  await searchPicker(page, picker, base);
  for (const t of ALL) {
    const shouldShow = allowed.includes(t);
    await expect(optionNamed(page, names[t]), `${TYPE_LABEL[t]} ${shouldShow ? 'phải được liệt kê' : 'không được liệt kê'}`).toHaveCount(shouldShow ? 1 : 0);
  }
  await expect(optionsOf(page).filter({ hasText: base }), 'số dòng gợi ý khớp đúng loại hợp lệ').toHaveCount(allowed.length);
}

/** Kiểm tra popup "Tạo đối tác": tên điền sẵn, loại điền sẵn, danh sách loại. */
async function expectCreatePopupDefaults(page: Page, ctx: Context, typed: string): Promise<Locator> {
  const pop = partnerPopup(page, /^Tạo đối tác$/);
  await expect(pop).toBeVisible({ timeout: 10000 });
  await expect(popName(pop), 'tên điền sẵn = chữ đang gõ trong ô tìm').toHaveValue(typed);
  if (ctx.allowed.length > 1) {
    expect(await popTypeOptions(pop), 'radio loại trong popup = loại hợp lệ theo ngữ cảnh').toEqual(ctx.allowed.map((t) => TYPE_LABEL[t]));
  } else {
    expect(await popTypeOptions(pop), 'chỉ một loại hợp lệ ⇒ không hiện radio').toEqual([]);
  }
  expect(await popSelectedType(pop), 'loại điền sẵn theo ngữ cảnh').toBe(TYPE_LABEL[ctx.defaultType]);
  return pop;
}

/** Chữ đã gõ trong ô tìm được điền vào Tên; giữ tên nếu mở popup bằng nút cạnh ô. */
const readValue = async (loc: Locator): Promise<string> => loc.inputValue();

/* ============================== 1. tìm & chọn ============================== */

test.describe('Tìm và chọn đối tác (§5.2)', () => {
  test('tìm theo tên / STK / MST; chọn xong hiện Ngân hàng · STK · MST chỉ đọc', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Search');
    const stk = uniqDigits(12);
    const mst = uniqDigits(10);
    await apiCreatePartner(page, { type: 'supplier', name, bank_name: 'Vietcombank', account_number: stk, tax_code: mst });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);

    // tên: không phân biệt hoa thường (tên đầy đủ có hậu tố duy nhất — gợi ý chỉ hiện tối đa 20 dòng)
    await searchPicker(page, picker, name.toUpperCase());
    await expect(optionNamed(page, name)).toHaveCount(1);
    // STK
    await searchPicker(page, picker, stk);
    await expect(optionNamed(page, name), 'tìm theo số tài khoản').toHaveCount(1);
    // MST
    await searchPicker(page, picker, mst);
    await expect(optionNamed(page, name), 'tìm theo mã số thuế').toHaveCount(1);
    // không khớp
    await searchPicker(page, picker, `${name} KHONG-CO-DOI-TAC`);
    await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');

    // chọn
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveText('Ngân hàng: Vietcombank');
    await expect(readonlyLine(picker, 'STK')).toHaveText(`STK: ${stk}`);
    await expect(readonlyLine(picker, 'MST')).toHaveText(`MST: ${mst}`);
    // chỉ đọc: dòng ngân hàng/STK/MST không phải ô nhập (chỉ ô tìm là input)
    await expect(picker.locator('input'), 'chỉ ô tìm là ô nhập').toHaveCount(1);
  });

  test('danh bạ theo công ty: đối tác cùng tên ở công ty khác không hiện', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Scope');
    const otherCompany = await apiCreatePartner(page, { type: 'customer', name }, CTB);
    const mine = await apiCreatePartner(page, { type: 'supplier', name }, CTA);
    expect(otherCompany._id).not.toBe(mine._id);

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, name);
    await expect(optionNamed(page, name), 'chỉ đối tác của công ty đang lập phiếu').toHaveCount(1);
    await expect(optionNamed(page, name)).toContainText(TYPE_LABEL.supplier);
    await expect(optionNamed(page, name)).not.toContainText(TYPE_LABEL.customer);
  });

  test('đối tác ngừng giao dịch không được liệt kê cho phiếu mới', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Ngung');
    const p = await apiCreatePartner(page, { type: 'customer', name });
    await apiDeactivatePartner(page, p._id);

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, name);
    await expect(optionNamed(page, name), 'đối tác ngừng giao dịch không hiện').toHaveCount(0);
    await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');
  });

  test('đối tác đã ngừng giao dịch mở sẵn trên form: vẫn hiện tên, cảnh báo không dùng cho phiếu mới', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Ngung Sẵn');
    const p = await apiCreatePartner(page, { type: 'supplier', name, bank_name: 'Techcombank', account_number: uniqDigits(12) });
    await apiDeactivatePartner(page, p._id);

    await page.goto(`${ROUTES.payment}?partner_id=${p._id}`);
    const picker = pickerOf(page, PAY_PICKER);
    await expect(picker.locator('.ant-select')).toContainText(name, { timeout: 15000 });
    await expect(picker.getByText('không dùng cho phiếu mới')).toBeVisible();
  });

  test('máy chủ từ chối phiếu chi MỚI dùng đối tác ngừng giao dịch (§5.1)', async ({ as }) => {
    const page = await as('staff');
    const active = await apiCreatePartner(page, { type: 'supplier', name: uniq('PKR Api Hoat Dong') });
    const inactive = await apiCreatePartner(page, { type: 'supplier', name: uniq('PKR Api Ngung') });
    await apiDeactivatePartner(page, inactive._id);

    const draft = (partnerId: string) => ({
      kind: 'spend',
      company_id: CTA,
      title: uniq('PKR Phieu Api'),
      purpose: 'Kiểm tra đối tác ngừng giao dịch',
      partner_id: partnerId,
      amount: { amount_minor: '100000', currency: 'VND' },
      source: { fund: 'bank', account_id: null, group_managed: false },
      planned_date: '2026-12-01T10:00',
      priority: 'normal',
      tag_ids: [],
    });
    const headers = { 'x-company-scope': CTA };

    // đối chứng: đối tác đang hoạt động phải tạo được (chứng minh body hợp lệ)
    const control = await page.request.post('/api/v1/documents', { data: draft(active._id), headers });
    expect(control.status(), `đối chứng (đối tác hoạt động): ${await control.text()}`).toBeLessThan(300);

    const bad = await page.request.post('/api/v1/documents', { data: draft(inactive._id), headers });
    const badText = await bad.text();
    expect(bad.status(), `phiếu mới với đối tác ngừng giao dịch phải bị từ chối: ${badText}`).toBeGreaterThanOrEqual(400);
    expect(bad.status(), `lỗi phải là 4xx nghiệp vụ, không phải 5xx: ${badText}`).toBeLessThan(500);
    expect(badText.toLowerCase()).toContain('ngừng giao dịch');
  });

  test('máy chủ từ chối phiếu dùng đối tác của CÔNG TY KHÁC (danh bạ riêng từng công ty, §5.1)', async ({ as }) => {
    const page = await as('staff');
    const foreign = await apiCreatePartner(page, { type: 'supplier', name: uniq('PKR Api Cong Ty Khac') }, CTB);
    const body = {
      kind: 'spend',
      company_id: CTA,
      title: uniq('PKR Phieu Cong Ty Khac'),
      purpose: 'Kiểm tra đối tác khác công ty',
      partner_id: foreign._id,
      amount: { amount_minor: '100000', currency: 'VND' },
      source: { fund: 'bank', account_id: null, group_managed: false },
      planned_date: '2026-12-01T10:00',
      priority: 'normal',
      tag_ids: [],
    };
    const res = await page.request.post('/api/v1/documents', { data: body, headers: { 'x-company-scope': CTA } });
    const text = await res.text();
    expect(res.status(), `đối tác công ty khác phải bị từ chối: ${text}`).toBeGreaterThanOrEqual(400);
    expect(res.status(), `lỗi phải là 4xx nghiệp vụ, không phải 5xx: ${text}`).toBeLessThan(500);
  });

  test('tìm theo đoạn số giữa của STK hoặc MST (không cần gõ đủ số)', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Doan So');
    const stk = uniqDigits(12);
    const mst = uniqDigits(10);
    await apiCreatePartner(page, { type: 'supplier', name, bank_name: 'ACB', account_number: stk, tax_code: mst });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, stk.slice(2, 10));
    await expect(optionNamed(page, name), 'gõ đoạn giữa số tài khoản').toHaveCount(1);
    await searchPicker(page, picker, mst.slice(1, 8));
    await expect(optionNamed(page, name), 'gõ đoạn giữa mã số thuế').toHaveCount(1);
  });

  test('tìm STK / MST bỏ qua dấu phân cách (khoảng trắng . - _ /): gõ chữ số liền vẫn thấy đối tác lưu có dấu (§5.1 = §5.2)', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Phan Cach');
    const stkDigits = uniqDigits(12);
    const mstDigits = uniqDigits(10);
    // lưu có dấu phân cách; gõ lại chỉ bằng chữ số (và ngược lại) vẫn phải tìm thấy — cùng quy tắc với cảnh báo trùng
    const stkStored = `${stkDigits.slice(0, 3)}-${stkDigits.slice(3, 6)} ${stkDigits.slice(6, 9)}.${stkDigits.slice(9)}`;
    const mstStored = `${mstDigits.slice(0, 7)}-${mstDigits.slice(7)}`;
    await apiCreatePartner(page, { type: 'supplier', name, bank_name: 'Agribank', account_number: stkStored, tax_code: mstStored });

    // API: đúng truy vấn mà ô chọn gọi
    expect((await apiOptions(page, stkDigits)).map((p) => p.name), 'q = STK chỉ có chữ số').toContain(name);
    expect((await apiOptions(page, stkStored)).map((p) => p.name), 'q = STK đúng như đã lưu (có dấu)').toContain(name);
    expect((await apiOptions(page, mstDigits)).map((p) => p.name), 'q = MST chỉ có chữ số').toContain(name);
    expect((await apiOptions(page, mstStored)).map((p) => p.name), 'q = MST đúng như đã lưu (có gạch)').toContain(name);

    // UI: ô chọn trên form phiếu chi
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, stkDigits);
    await expect(optionNamed(page, name), 'gõ STK liền, STK lưu có dấu cách / gạch / chấm').toHaveCount(1);
    await searchPicker(page, picker, mstDigits);
    await expect(optionNamed(page, name), 'gõ MST liền, MST lưu có gạch').toHaveCount(1);
  });

  test('đang chọn đối tác A rồi gõ chữ KHÔNG khớp A ⇒ A không được liệt kê; hiện "Không có đối tác phù hợp" (§5.2 "Gõ để tìm")', async ({ as }) => {
    const page = await as('staff');
    const a = uniq('PKR Dang Chon');
    await apiCreatePartner(page, { type: 'supplier', name: a });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, a);
    await optionNamed(page, a).first().click();
    await expect(picker.locator('.ant-select')).toContainText(a);

    await searchPicker(page, picker, uniq('PKR Khong Khop'));
    await expect(optionNamed(page, a), 'đối tác đang chọn nhưng không khớp chữ tìm ⇒ không được liệt kê').toHaveCount(0);
    await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');
  });
});

/* ============================== 2. loại hợp lệ theo từng chỗ dùng ============================== */

test.describe('Loại đối tác hợp lệ theo chỗ dùng (§5.2 bảng "Loại lọc sẵn")', () => {
  for (const ctx of CONTEXTS) {
    test(`liệt kê đúng loại: ${ctx.id} → ${ctx.allowed.map((t) => TYPE_LABEL[t]).join(', ')}`, async ({ as }) => {
      const page = await as('staff');
      const base = uniq('PKR Loai');
      const names = await seedThreeTypes(page, base);
      const { picker } = await openContext(page, ctx);
      await expectListedTypes(page, picker, base, names, ctx.allowed);
    });
  }
});

/* ============================== 2b. đã có đối tác A rồi gõ tìm đối tác B ============================== */

test.describe('Đang chọn đối tác A rồi gõ tìm đối tác B (§5.2 "Gõ để tìm")', () => {
  for (const ctx of CONTEXTS) {
    test(`đang chọn A, gõ tên B rồi Enter ⇒ chọn đúng B, không lấy lại A (${ctx.id})`, async ({ as }) => {
      const page = await as('staff');
      const base = uniq('PKR Enter');
      const t = ctx.allowed[0];
      const a = `${base} A`;
      const b = `${base} B`;
      await apiCreatePartner(page, { type: t, name: a });
      await apiCreatePartner(page, { type: t, name: b });

      const { picker } = await openContext(page, ctx);
      await searchPicker(page, picker, a);
      await optionNamed(page, a).first().click();
      await expect(picker.locator('.ant-select')).toContainText(a);

      await searchPicker(page, picker, b);
      await expect(optionNamed(page, b), 'đối tác B có trong gợi ý').toHaveCount(1);
      await expect(optionNamed(page, a), 'A (đang chọn) không khớp chữ gõ B ⇒ không được liệt kê').toHaveCount(0);
      await expect(optionsOf(page), 'danh sách chỉ gồm đối tác khớp chữ gõ (B)').toHaveCount(1);
      await comboOf(picker).press('Enter');
      await expect(picker.locator('.ant-select'), 'Enter chọn dòng được tô sáng: phải là B vừa gõ, không phải A đang chọn').toContainText(b);
      await expect(picker.locator('.ant-select')).not.toContainText(a);
    });
  }
});

/* ============================== 2c. danh sách khi đổi chữ, đang tải, lỗi tải ============================== */

test.describe('Danh sách gợi ý khi đổi chữ, đang tải và lỗi tải (§5.2 "Gõ để tìm")', () => {
  test('gõ chữ mới: đếm NGAY sau khi gõ (trong lúc chờ debounce) — đối tác khớp chữ cũ không còn hiện', async ({ as }) => {
    const page = await as('staff');
    const x = uniq('PKR Debounce Cu');
    const y = uniq('PKR Debounce Moi');
    await apiCreatePartner(page, { type: 'supplier', name: x });
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, x);
    await expect(optionNamed(page, x)).toHaveCount(1);

    await comboOf(picker).fill(y);
    // không chờ (expect có thử lại): đếm đúng thời điểm vừa gõ, khi debounce 300 ms chưa xong
    expect(await optionNamed(page, x).count(), 'chữ cũ chưa được thay: kết quả của chữ cũ không được hiện').toBe(0);
    await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');
  });

  for (const ctx of CONTEXTS) {
    test(`đang tải kết quả của chữ mới: đối tác khớp chữ cũ không còn hiện; Enter không chọn nó (${ctx.id})`, async ({ as }) => {
      const page = await as('staff');
      const base = uniq('PKR Dang Tai');
      const t = ctx.allowed[0];
      const a = `${base} A`;
      const b = `${base} B`;
      await apiCreatePartner(page, { type: t, name: a });
      await apiCreatePartner(page, { type: t, name: b });

      const { picker } = await openContext(page, ctx);
      await searchPicker(page, picker, base);
      await expect(optionNamed(page, a)).toHaveCount(1);
      await expect(optionNamed(page, b)).toHaveCount(1);

      // giữ phản hồi của chữ mới B: kiểm đúng trạng thái "đang tải" (sau debounce, trước khi có kết quả)
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      await page.route(
        (url) => url.pathname === '/api/v1/partners/options' && url.searchParams.get('q') === b,
        async (route) => {
          await gate;
          await route.continue();
        },
      );

      await comboOf(picker).fill(b);
      await page.waitForTimeout(700);
      await expect.soft(optionNamed(page, a), 'đang tải chữ B: A (khớp chữ cũ, không khớp B) không được hiện').toHaveCount(0);
      await expect.soft(dropdown(page), 'đang tải chữ B: dropdown hiện "Đang tìm…" (v2/v2.md §5.2)').toContainText('Đang tìm…');
      await comboOf(picker).press('Enter');
      await expect.soft(picker.locator('.ant-select'), 'Enter lúc đang tải không được chọn A').not.toContainText(a);

      release();
      await expect(optionNamed(page, b)).toHaveCount(1, { timeout: 15000 });
      await comboOf(picker).press('Enter');
      await expect(picker.locator('.ant-select'), 'sau khi có kết quả, Enter chọn đúng B').toContainText(b);
      await expect(picker.locator('.ant-select')).not.toContainText(a);
    });
  }

  test('lỗi tải danh sách gợi ý: báo "Không tải được danh sách đối tác." (không báo "Không có đối tác phù hợp"); "Thử lại" tải lại được', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Loi Tai');
    await apiCreatePartner(page, { type: 'supplier', name });
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);

    const isOptions = (url: URL) => url.pathname === '/api/v1/partners/options';
    const failing = (route: Route) => route.abort();
    await page.route(isOptions, failing);
    await picker.locator('.ant-select').first().click();
    await comboOf(picker).fill(name);

    await expect(dropdown(page)).toContainText('Không tải được danh sách đối tác.', { timeout: 20000 });
    await expect(dropdown(page), 'lỗi tải không được báo như "không có đối tác"').not.toContainText('Không có đối tác phù hợp');

    await page.unroute(isOptions, failing);
    await dropdown(page).getByRole('button', { name: 'Thử lại', exact: true }).click();
    await expect(optionNamed(page, name), 'Thử lại tải được danh sách').toHaveCount(1, { timeout: 15000 });
  });
});

/* ============================== 3. popup "+ Tạo đối tác" — mở & huỷ ============================== */

test.describe('Popup "+ Tạo đối tác": loại & tên điền sẵn, huỷ (US-PAR-02)', () => {
  for (const ctx of CONTEXTS) {
    test(`mở popup: loại = ${TYPE_LABEL[ctx.defaultType]} (${ctx.id}), tên = chữ đang gõ; huỷ → ô trống`, async ({ as }) => {
      const page = await as('staff');
      const { picker } = await openContext(page, ctx);
      const urlBefore = page.url();
      const typed = uniq('PKR Moi Huy');

      await searchPicker(page, picker, typed);
      await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');
      await clickDropdownCreate(page);
      const pop = await expectCreatePopupDefaults(page, ctx, typed);
      expect(page.url(), 'popup mở ngay trên form, không chuyển trang').toBe(urlBefore);

      await popFooter(pop, 'Hủy').click();
      await expectPopupClosed(pop);
      await expect(picker.locator('.ant-select-placeholder'), 'huỷ popup ⇒ ô vẫn trống').toBeVisible();
      await expect(readonlyLine(picker, 'Ngân hàng'), 'không có dòng chỉ đọc khi chưa chọn').toHaveCount(0);
      await expect(sideCreateButton(picker), 'vẫn có nút + Tạo đối tác cạnh ô').toBeVisible();
    });
  }

  for (const ctx of CONTEXTS) {
    test(`mở popup từ chân dropdown (${ctx.id}): dropdown của ô chọn phải đóng, popup thao tác được (radio loại, Ngân hàng)`, async ({ as }) => {
      const page = await as('staff');
      const { picker } = await openContext(page, ctx);
      await searchPicker(page, picker, uniq('PKR Dropdown Dong'));
      await clickDropdownCreate(page);
      const pop = partnerPopup(page, /^Tạo đối tác$/);
      await expect(pop).toBeVisible({ timeout: 10000 });
      await expect(page.locator('.ant-select-dropdown:visible'), 'dropdown ô chọn phải đóng khi popup mở').toHaveCount(0, { timeout: 5000 });
      // popup không bị dropdown che: radio Loại (khi có nhiều loại) và ô Ngân hàng bấm / gõ được
      const other = ctx.allowed.find((t) => t !== ctx.defaultType);
      if (other) {
        await popChooseType(pop, other);
        expect(await popSelectedType(pop), 'chọn được loại khác trong popup').toBe(TYPE_LABEL[other]);
      }
      await popBank(pop).fill('Kiểm tra popup');
      await expect(popBank(pop), 'ô Ngân hàng gõ được trong popup').toHaveValue('Kiểm tra popup');
      await popFooter(pop, 'Hủy').click();
      await expectPopupClosed(pop);
    });
  }

  test('nút "+ Tạo đối tác" cạnh ô (chưa chọn, không gõ): popup với tên trống', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await sideCreateButton(picker).click();
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(pop).toBeVisible();
    await expect(popName(pop)).toHaveValue('');
    expect(await popSelectedType(pop)).toBe(TYPE_LABEL.supplier);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('gõ tên rồi bấm "+ Tạo đối tác" cạnh ô (không qua dropdown): Tên điền sẵn chữ đang gõ (§5.2)', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    const typed = uniq('PKR Go Canh O');
    await searchPicker(page, picker, typed);
    await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');
    await sideCreateButton(picker).click();
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(pop).toBeVisible({ timeout: 10000 });
    await expect(popName(pop), 'chữ đang gõ trong ô tìm được điền sẵn vào Tên').toHaveValue(typed);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
    await expect(picker.locator('.ant-select-placeholder'), 'huỷ ⇒ ô vẫn trống').toBeVisible();
  });

  test('gõ tên rồi giữ chuột ~150 ms trên "+ Tạo đối tác" cạnh ô (nhịp bấm của người dùng): Tên vẫn là chữ đang gõ', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    const typed = uniq('PKR Giu Chuot Canh O');
    await searchPicker(page, picker, typed);
    await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');
    const box = await sideCreateButton(picker).boundingBox();
    expect(box, 'nút + Tạo đối tác cạnh ô hiển thị').not.toBeNull();
    // bấm thật: nhấn xuống, giữ ~150 ms rồi thả (dropdown có đủ thời gian đóng và xoá ô tìm trước khi click)
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(pop).toBeVisible({ timeout: 10000 });
    await expect(popName(pop), 'chữ đang gõ không bị mất khi bấm nút cạnh ô (§5.2)').toHaveValue(typed);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('gõ tên rồi giữ chuột ~150 ms trên "+ Tạo đối tác" trong chân dropdown: Tên vẫn là chữ đang gõ', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    const typed = uniq('PKR Giu Chuot Chan Dropdown');
    await searchPicker(page, picker, typed);
    await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');
    const box = await dropdown(page).getByRole('button', { name: /^\+ Tạo đối tác/ }).boundingBox();
    expect(box, 'nút trong chân dropdown hiển thị').not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(pop).toBeVisible({ timeout: 10000 });
    await expect(popName(pop), 'chữ đang gõ được điền sẵn vào Tên (nút trong chân dropdown)').toHaveValue(typed);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('bàn phím: gõ tên → Tab tới "+ Tạo đối tác" cạnh ô → Enter: Tên vẫn là chữ đang gõ (§5.2)', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    const typed = uniq('PKR Tab Enter');
    await searchPicker(page, picker, typed);
    await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');

    // thứ tự Tab: ô tìm → nút xoá (×) của ô chọn (khi còn chữ) → nút cạnh ô; Tab tới khi đúng nút
    const sideBtn = sideCreateButton(picker);
    for (let i = 0; i < 3 && !(await sideBtn.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(sideBtn).toBeFocused();
    await page.keyboard.press('Enter');

    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(pop).toBeVisible({ timeout: 10000 });
    await expect(popName(pop), 'đi bằng bàn phím: chữ đang gõ vẫn điền vào Tên').toHaveValue(typed);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });
});

/* ============================== 4. tạo đối tác từ form: lưu, chọn sẵn, giữ dữ liệu ============================== */

test.describe('Tạo đối tác ngay trên form (US-PAR-02)', () => {
  test('phiếu chi: lưu popup → đối tác được chọn sẵn, các trường đã nhập vẫn còn, phiếu lưu đúng đối tác', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    const tag = uniq('PKR Giu');
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);

    await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Mục đích ${tag}`);
    await fieldOf(page, 'Tiêu đề (bỏ trống sẽ tự sinh)').locator('input').fill(`Tiêu đề ${tag}`);
    await fillAmount(page, 'Số tiền', '2500000');
    await fieldOf(page, 'Ghi chú').locator('textarea').fill(`Ghi chú ${tag}`);
    const before = {
      purpose: await readValue(fieldOf(page, 'Nội dung / mục đích').locator('textarea')),
      title: await readValue(fieldOf(page, 'Tiêu đề (bỏ trống sẽ tự sinh)').locator('input')),
      amount: await readValue(fieldOf(page, 'Số tiền').locator('input')),
      note: await readValue(fieldOf(page, 'Ghi chú').locator('textarea')),
    };

    const newName = uniq('PKR Moi Luu');
    const stk = uniqDigits(12);
    const mst = uniqDigits(10);
    await searchPicker(page, picker, newName);
    await clickDropdownCreate(page);
    const pop = await expectCreatePopupDefaults(page, { id: 'phiếu chi', allowed: ALL, defaultType: 'supplier', label: PAY_PICKER, path: ROUTES.payment }, newName);
    await popBank(pop).fill('Vietcombank');
    await popAccount(pop).fill(stk);
    await popTax(pop).fill(mst);
    await popFooter(pop, 'Tạo đối tác').click();

    await expectPopupClosed(pop);
    await expect(toast(page, 'Đã tạo đối tác')).toBeVisible();
    await expect(picker.locator('.ant-select'), 'đối tác mới được chọn sẵn').toContainText(newName);
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveText('Ngân hàng: Vietcombank');
    await expect(readonlyLine(picker, 'STK')).toHaveText(`STK: ${stk}`);
    await expect(readonlyLine(picker, 'MST')).toHaveText(`MST: ${mst}`);

    // các trường đã nhập không mất
    expect(await readValue(fieldOf(page, 'Nội dung / mục đích').locator('textarea'))).toBe(before.purpose);
    expect(await readValue(fieldOf(page, 'Tiêu đề (bỏ trống sẽ tự sinh)').locator('input'))).toBe(before.title);
    expect(await readValue(fieldOf(page, 'Số tiền').locator('input'))).toBe(before.amount);
    expect(await readValue(fieldOf(page, 'Ghi chú').locator('textarea'))).toBe(before.note);

    // đối tác thật (có ID) trong công ty đang lập phiếu, đúng loại
    const created = (await apiOptions(page, newName, CTA)).find((p) => p.name === newName);
    expect(created, 'đối tác đã được tạo trong CTA').toBeTruthy();
    expect(created!.type).toBe('supplier');
    expect(await apiOptions(page, newName, CTB), 'không tạo sang công ty khác').toHaveLength(0);

    // lưu nháp ⇒ phiếu mang đúng partner_id
    await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await page.waitForURL(/\/ho-so\/chi\/[0-9a-f]{24}/, { timeout: 20000 });
    const docId = page.url().match(/\/ho-so\/chi\/([0-9a-f]{24})/)![1];
    const res = await page.request.get(`/api/v1/documents/${docId}`, { headers: { 'x-company-scope': CTA } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data?: { partner_id?: string | null } } & { partner_id?: string | null };
    expect((body.data ?? body).partner_id, 'phiếu lưu partner_id của đối tác vừa tạo').toBe(created!._id);
    expect(writes.some((w) => w.startsWith('POST /api/v1/documents')), 'đã gửi POST phiếu').toBe(true);
  });

  test('phiếu chi: huỷ popup sau khi gõ → không tạo đối tác, ô trống, dữ liệu form còn nguyên', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    const tag = uniq('PKR Huy');
    await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Mục đích ${tag}`);
    await fillAmount(page, 'Số tiền', '1200000');

    const name = uniq('PKR Huy Popup');
    await searchPicker(page, picker, name);
    await clickDropdownCreate(page);
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(popName(pop)).toHaveValue(name);
    await popBank(pop).fill('Huy Bank');
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);

    await expect(picker.locator('.ant-select-placeholder')).toBeVisible();
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveCount(0);
    expect(await readValue(fieldOf(page, 'Nội dung / mục đích').locator('textarea'))).toBe(`Mục đích ${tag}`);
    expect(await apiOptions(page, name, CTA), 'huỷ ⇒ không có đối tác nào được tạo').toHaveLength(0);
  });

  test('cảnh báo trùng TÊN (khác loại vẫn cảnh báo): không chặn lưu, đối tác vẫn được tạo và chọn', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Trung Ten');
    const existing = await apiCreatePartner(page, { type: 'customer', name });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, name);
    await expect(optionNamed(page, name)).toHaveCount(1);
    await clickDropdownCreate(page);

    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(popName(pop)).toHaveValue(name);
    await expect(pop.getByText('Có thể trùng với đối tác đã có — vẫn lưu được'), 'cảnh báo trùng trước khi lưu').toBeVisible({ timeout: 10000 });
    await expect(pop.getByText(`Trùng tên với đối tác ${existing.code}`)).toBeVisible();
    await popFooter(pop, 'Tạo đối tác').click();

    await expectPopupClosed(pop);
    await expect(toast(page, 'Cảnh báo trùng đối tác — đối tác vẫn đã được lưu'), 'cảnh báo sau khi lưu').toBeVisible();
    await expect(picker.locator('.ant-select')).toContainText(name);
    expect(await apiOptions(page, name, CTA), 'cả hai đối tác cùng tên đều tồn tại').toHaveLength(2);
  });

  test('cảnh báo trùng (NGÂN HÀNG + STK) — khác tên vẫn lưu được', async ({ as }) => {
    const page = await as('staff');
    const bankName = `BIDV ${uniqDigits(4)}`;
    const stk = uniqDigits(12);
    await apiCreatePartner(page, { type: 'bank', name: uniq('PKR NH Goc'), bank_name: bankName, account_number: stk });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    const newName = uniq('PKR KH Trung STK');
    await searchPicker(page, picker, newName);
    await clickDropdownCreate(page);

    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await popChooseType(pop, 'customer');
    await popBank(pop).fill(bankName);
    await popAccount(pop).fill(stk);
    await expect(pop.getByText('Trùng ngân hàng và số tài khoản với đối tác'), 'cảnh báo trùng (NH, STK)').toBeVisible({ timeout: 10000 });
    await popFooter(pop, 'Tạo đối tác').click();

    await expectPopupClosed(pop);
    await expect(toast(page, 'Cảnh báo trùng đối tác — đối tác vẫn đã được lưu')).toBeVisible();
    await expect(picker.locator('.ant-select')).toContainText(newName);
    expect(await apiOptions(page, stk, CTA), 'hai đối tác cùng (NH, STK) đều được lưu').toHaveLength(2);
  });

  test('cảnh báo trùng (NH + STK) bỏ qua dấu phân cách: STK lưu "123-456 789.012", gõ chữ số liền ⇒ vẫn cảnh báo (§5.1)', async ({ as }) => {
    const page = await as('staff');
    const bankName = `Agribank ${uniqDigits(4)}`;
    const digits = uniqDigits(12);
    const stkStored = `${digits.slice(0, 3)}-${digits.slice(3, 6)} ${digits.slice(6, 9)}.${digits.slice(9)}`;
    await apiCreatePartner(page, { type: 'bank', name: uniq('PKR NH Goc Phan Cach'), bank_name: bankName, account_number: stkStored });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, uniq('PKR KH Phan Cach'));
    await clickDropdownCreate(page);
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await popChooseType(pop, 'customer');
    await popBank(pop).fill(bankName);
    await popAccount(pop).fill(digits);
    await expect(pop.getByText('Trùng ngân hàng và số tài khoản với đối tác'), 'cảnh báo trùng (NH, STK) khi gõ STK không dấu').toBeVisible({ timeout: 10000 });
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('phiếu thu: lưu popup → đối tác được chọn sẵn, mục đích / số tiền / ghi chú còn nguyên, phiếu lưu đúng partner_id', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    const tag = uniq('PKR Thu Giu');
    const picker = await openForm(page, ROUTES.receipt, REC_PICKER);

    await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Mục đích thu ${tag}`);
    await fillAmount(page, 'Số tiền', '1800000');
    await fieldOf(page, 'Ghi chú').locator('textarea').fill(`Ghi chú thu ${tag}`);
    const before = {
      purpose: await readValue(fieldOf(page, 'Nội dung / mục đích').locator('textarea')),
      amount: await readValue(fieldOf(page, 'Số tiền').locator('input')),
      note: await readValue(fieldOf(page, 'Ghi chú').locator('textarea')),
    };

    const newName = uniq('PKR Thu Moi');
    await searchPicker(page, picker, newName);
    await clickDropdownCreate(page);
    const pop = await expectCreatePopupDefaults(page, { id: 'phiếu thu', allowed: ALL, defaultType: 'customer', label: REC_PICKER, path: ROUTES.receipt }, newName);
    await popFooter(pop, 'Tạo đối tác').click();
    await expectPopupClosed(pop);

    await expect(picker.locator('.ant-select'), 'đối tác mới được chọn sẵn').toContainText(newName);
    expect(await readValue(fieldOf(page, 'Nội dung / mục đích').locator('textarea'))).toBe(before.purpose);
    expect(await readValue(fieldOf(page, 'Số tiền').locator('input'))).toBe(before.amount);
    expect(await readValue(fieldOf(page, 'Ghi chú').locator('textarea'))).toBe(before.note);

    const created = (await apiOptions(page, newName, CTA)).find((p) => p.name === newName);
    expect(created, 'đối tác đã được tạo trong CTA').toBeTruthy();
    expect(created!.type).toBe('customer');

    await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await page.waitForURL(/\/ho-so\/thu\/[0-9a-f]{24}/, { timeout: 20000 });
    const docId = page.url().match(/\/ho-so\/thu\/([0-9a-f]{24})/)![1];
    const res = await page.request.get(`/api/v1/documents/${docId}`, { headers: { 'x-company-scope': CTA } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data?: { partner_id?: string | null } } & { partner_id?: string | null };
    expect((body.data ?? body).partner_id, 'phiếu thu lưu partner_id của đối tác vừa tạo').toBe(created!._id);
    expect(writes.some((w) => w.startsWith('POST /api/v1/documents')), 'đã gửi POST phiếu').toBe(true);
  });

  test('đang chọn A → gõ tên mới → "+ Tạo đối tác" trong chân dropdown → lưu: đối tác mới thay A (A không bị ghi đè)', async ({ as }) => {
    const page = await as('staff');
    const a = uniq('PKR Thay Doi A');
    await apiCreatePartner(page, { type: 'supplier', name: a });
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, a);
    await optionNamed(page, a).first().click();
    await expect(picker.locator('.ant-select')).toContainText(a);

    const fresh = uniq('PKR Thay Doi Moi');
    await searchPicker(page, picker, fresh);
    await clickDropdownCreate(page);
    const pop = await expectCreatePopupDefaults(page, { id: 'phiếu chi', allowed: ALL, defaultType: 'supplier', label: PAY_PICKER, path: ROUTES.payment }, fresh);
    await popFooter(pop, 'Tạo đối tác').click();
    await expectPopupClosed(pop);

    await expect(picker.locator('.ant-select'), 'đối tác mới được chọn thay A').toContainText(fresh);
    await expect(picker.locator('.ant-select')).not.toContainText(a);
    expect((await apiOptions(page, a, CTA)).map((p) => p.name), 'A vẫn tồn tại, không bị đổi tên').toContain(a);
  });
});

/* ============================== 5. đọc & sửa đối tác ============================== */

test.describe('Thông tin chỉ đọc & "Sửa đối tác" (§5.2, US-PAR-08)', () => {
  test('Sửa đối tác: đổi tên / NH / STK / MST → ô và mọi màn khác hiện thông tin mới; lịch sử ghi lại', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Sua');
    const stk1 = uniqDigits(12);
    const mst1 = uniqDigits(10);
    const p = await apiCreatePartner(page, { type: 'customer', name, bank_name: 'Techcombank', account_number: stk1, tax_code: mst1 });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveText('Ngân hàng: Techcombank');

    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();
    const pop = partnerPopup(page, /^Sửa đối tác/);
    await expect(pop.locator('.ant-modal-title')).toHaveText(`Sửa đối tác — ${name}`);
    await expect(popBank(pop)).toHaveValue('Techcombank');
    await expect(popAccount(pop)).toHaveValue(stk1);
    await expect(popTax(pop)).toHaveValue(mst1);
    expect(await popSelectedType(pop)).toBe(TYPE_LABEL.customer);

    const newName = `${name} DOI`;
    const stk2 = uniqDigits(12);
    const mst2 = uniqDigits(10);
    await popName(pop).fill(newName);
    await popBank(pop).fill('MB Bank');
    await popAccount(pop).fill(stk2);
    await popTax(pop).fill(mst2);
    await popFooter(pop, 'Lưu thay đổi').click();

    await expectPopupClosed(pop);
    await expect(toast(page, 'Đã lưu đối tác')).toBeVisible();
    await expect(picker.locator('.ant-select')).toContainText(newName);
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveText('Ngân hàng: MB Bank');
    await expect(readonlyLine(picker, 'STK')).toHaveText(`STK: ${stk2}`);
    await expect(readonlyLine(picker, 'MST')).toHaveText(`MST: ${mst2}`);

    const after = await apiGetPartner(page, p._id);
    expect(after.name).toBe(newName);
    expect(after.bank_name).toBe('MB Bank');
    expect(after.account_number).toBe(stk2);
    expect(after.history.length, 'lịch sử đối tác có thêm bản ghi sửa').toBeGreaterThanOrEqual(2);

    // thông tin mới hiện ở màn khác đang dùng cùng đối tác (công nợ)
    const picker2 = await openForm(page, ROUTES.debt, DEBT_PICKER);
    await searchPicker(page, picker2, newName);
    await optionNamed(page, newName).first().click();
    await expect(readonlyLine(picker2, 'Ngân hàng'), 'màn Công nợ hiện NH mới').toHaveText('Ngân hàng: MB Bank');
  });

  test('sửa đối tác: đổi tên trùng đối tác khác → cảnh báo trực tiếp trong popup và sau khi lưu (không chặn)', async ({ as }) => {
    const page = await as('staff');
    const other = await apiCreatePartner(page, { type: 'customer', name: uniq('PKR Trung Sua Khac') });
    const mineName = uniq('PKR Trung Sua Minh');
    const mine = await apiCreatePartner(page, { type: 'supplier', name: mineName });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, mineName);
    await optionNamed(page, mineName).first().click();
    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();

    const pop = partnerPopup(page, /^Sửa đối tác/);
    await popName(pop).fill(other.name);
    await expect(pop.getByText('Có thể trùng với đối tác đã có — vẫn lưu được'), 'cảnh báo trùng trực tiếp khi sửa').toBeVisible({ timeout: 10000 });
    await expect(pop.getByText(`Trùng tên với đối tác ${other.code}`)).toBeVisible();
    await popFooter(pop, 'Lưu thay đổi').click();

    await expectPopupClosed(pop);
    await expect(toast(page, 'Cảnh báo trùng đối tác — đối tác vẫn đã được lưu')).toBeVisible();
    await expect(picker.locator('.ant-select')).toContainText(other.name);
    expect((await apiGetPartner(page, mine._id)).name).toBe(other.name);
  });

  test('sửa đối tác: đổi Loại làm vỡ ràng buộc (ngân hàng đang có khoản vay) → báo lỗi trong popup, popup không đóng, loại không đổi', async ({ as }) => {
    const page = await as('staff');
    const bank = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR NH Rang Buoc'), bank_name: 'BIDV', account_number: uniqDigits(12) });
    const maturity = new Date();
    maturity.setFullYear(maturity.getFullYear() + 1);
    const loanRes = await page.request.post('/api/v1/bank-debts', {
      data: {
        company_id: CTA,
        partner_id: bank._id,
        amount: { amount_minor: '1000000000', currency: 'VND' },
        maturity_date: maturity.toISOString().slice(0, 10),
        interest_rate: '9.5',
        payment_frequency: 'maturity',
        repayment_method: 'interest_only',
      },
      headers: { 'x-company-scope': CTA },
    });
    expect(loanRes.status(), `tạo khoản vay để kiểm ràng buộc: ${await loanRes.text()}`).toBe(201);

    await page.goto(`${ROUTES.bankDebt}?partner_id=${bank._id}`);
    const picker = pickerOf(page, LOAN_PICKER);
    await expect(picker.locator('.ant-select')).toContainText(bank.name, { timeout: 15000 });
    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();

    const pop = partnerPopup(page, /^Sửa đối tác/);
    await popChooseType(pop, 'customer');
    await popFooter(pop, 'Lưu thay đổi').click();

    await expect(pop.getByText('đang có 1 khoản nợ ngân hàng'), 'lý do chặn đổi loại hiện trong popup').toBeVisible({ timeout: 10000 });
    await expect(pop, 'popup không đóng khi bị chặn').toBeVisible();
    expect((await apiGetPartner(page, bank._id)).type, 'loại đối tác không đổi').toBe('bank');
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('bỏ chọn (×) → ô về trống: hết dòng chỉ đọc và nút Sửa; hiện lại nút + Tạo đối tác', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Bo Chon');
    await apiCreatePartner(page, { type: 'supplier', name, bank_name: 'ACB', account_number: uniqDigits(12) });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveText('Ngân hàng: ACB');

    await picker.locator('.ant-select').first().hover();
    await picker.locator('.ant-select-clear').click({ force: true });

    await expect(picker.locator('.ant-select-placeholder')).toBeVisible();
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveCount(0);
    await expect(picker.getByRole('button', { name: 'Sửa đối tác', exact: true })).toHaveCount(0);
    await expect(sideCreateButton(picker)).toBeVisible();
  });

  test('sửa đối tác: KH đang có khoản công nợ → đổi sang Ngân hàng bị chặn trong popup (§5.1), popup không đóng, loại không đổi', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR KH Co Cong No');
    const cust = await apiCreatePartner(page, { type: 'customer', name });
    const due = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const debt = await page.request.post('/api/v1/debts', {
      data: {
        company_id: CTA,
        partner_id: cust._id,
        direction: 'receivable',
        value: { amount_minor: '1500000', currency: 'VND' },
        due_date: due,
        priority: 'normal',
        request_id: randomUUID(),
      },
      headers: { 'x-company-scope': CTA },
    });
    expect(debt.status(), `tạo khoản công nợ để kiểm ràng buộc: ${await debt.text()}`).toBe(201);

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();

    const pop = partnerPopup(page, /^Sửa đối tác/);
    await popChooseType(pop, 'bank');
    await popFooter(pop, 'Lưu thay đổi').click();

    await expect(pop.getByText('đang có 1 khoản công nợ'), 'lý do chặn đổi sang Ngân hàng hiện trong popup').toBeVisible({ timeout: 10000 });
    await expect(pop, 'popup không đóng khi bị chặn').toBeVisible();
    expect((await apiGetPartner(page, cust._id)).type, 'loại đối tác không đổi').toBe('customer');
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });
  test('chuyển sang đối tác khác: khi chi tiết đối tác MỚI chưa tải xong, không hiện NH/STK của đối tác cũ và không mở "Sửa đối tác" cho đối tác cũ', async ({ as }) => {
    const page = await as('staff');
    const base = uniq('PKR Chuyen Doi');
    const a = await apiCreatePartner(page, { type: 'supplier', name: `${base} A`, bank_name: 'Techcombank', account_number: uniqDigits(12), tax_code: uniqDigits(10) });
    const b = await apiCreatePartner(page, { type: 'supplier', name: `${base} B`, bank_name: 'MB Bank', account_number: uniqDigits(12), tax_code: uniqDigits(10) });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, `${base} A`);
    await optionNamed(page, `${base} A`).first().click();
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveText('Ngân hàng: Techcombank');

    // giữ phản hồi chi tiết của B (đối tác mới) cho tới khi kiểm xong trạng thái đang tải
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === `/api/v1/partners/${b._id}`,
      async (route) => {
        await gate;
        await route.continue();
      },
    );

    await searchPicker(page, picker, `${base} B`);
    await optionNamed(page, `${base} B`).first().click();
    await page.waitForTimeout(500);

    await expect.soft(picker.locator('.ant-select'), 'ô chọn hiện đối tác đang chọn (B)').toContainText(`${base} B`);
    await expect.soft(picker.locator('.ant-select'), 'ô chọn không hiện tên đối tác cũ (A)').not.toContainText(`${base} A`);
    await expect.soft(picker.getByText('Ngân hàng: Techcombank'), 'không hiện NH của đối tác cũ A khi chi tiết B chưa tải').toHaveCount(0);
    await expect.soft(picker.getByText(`STK: ${a.account_number}`), 'không hiện STK của đối tác cũ A khi chi tiết B chưa tải').toHaveCount(0);
    await expect.soft(picker.getByText(`MST: ${a.tax_code}`), 'không hiện MST của đối tác cũ A khi chi tiết B chưa tải').toHaveCount(0);
    // "Sửa đối tác" có thể bị khoá trong lúc chờ, nhưng nếu đang bấm được thì popup phải là B (không được là A)
    const editBtn = picker.getByRole('button', { name: 'Sửa đối tác', exact: true });
    if (await editBtn.isEnabled()) {
      await editBtn.click();
      const early = partnerPopup(page, /^Sửa đối tác/);
      await expect.soft(early.locator('.ant-modal-title'), 'bấm Sửa khi chi tiết B chưa về phải mở B, không mở A').toHaveText(`Sửa đối tác — ${base} B`);
      await popFooter(early, 'Hủy').click();
      await expectPopupClosed(early);
    }

    release();
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveText('Ngân hàng: MB Bank', { timeout: 15000 });
    await expect(picker.getByRole('button', { name: 'Sửa đối tác', exact: true })).toBeEnabled();
    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();
    const pop = partnerPopup(page, /^Sửa đối tác/);
    await expect(pop.locator('.ant-modal-title')).toHaveText(`Sửa đối tác — ${base} B`);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('khoản chi định kỳ: "Sửa đối tác" đổi tên bên nhận → dòng "Tên bên nhận lấy từ đối tác đã chọn" hiện tên MỚI (không giữ tên cũ)', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Dinh Ky Doi Ten');
    await apiCreatePartner(page, { type: 'customer', name, bank_name: 'ACB', account_number: uniqDigits(12) });
    await page.goto(ROUTES.recurring);
    await page.getByRole('button', { name: '+ Thêm khoản định kỳ' }).click();
    const modal = recurModalLocator(page);
    await expect(modal).toBeVisible();
    const picker = pickerOf(modal, RECUR_PICKER);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    await expect(modal.getByText(`Tên bên nhận lấy từ đối tác đã chọn: ${name}`)).toBeVisible({ timeout: 10000 });

    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();
    const pop = partnerPopup(page, /^Sửa đối tác/);
    const newName = `${name} DOI`;
    await popName(pop).fill(newName);
    await popFooter(pop, 'Lưu thay đổi').click();
    await expectPopupClosed(pop);
    await expect(picker.locator('.ant-select')).toContainText(newName);
    await expect(modal.getByText(`Tên bên nhận lấy từ đối tác đã chọn: ${newName}`), 'dòng gợi ý của khoản định kỳ theo tên hiện tại của đối tác').toBeVisible({ timeout: 10000 });
  });
});

/* ============================== 6. bắt buộc chọn đối tác ============================== */

test.describe('Không có đối tác ⇒ không lưu được (§5.2)', () => {
  test('phiếu chi: thiếu đối tác → báo "Chọn đối tác", không gửi POST phiếu', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    await openForm(page, ROUTES.payment, PAY_PICKER);
    await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Thiếu đối tác ${uniq('PKR')}`);
    await fillAmount(page, 'Số tiền', '500000');
    await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await expect(fieldOf(page, PAY_PICKER).getByText('Chọn đối tác', { exact: true })).toBeVisible();
    expect(writes.filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  test('phiếu thu: thiếu đối tác → báo "Chọn đối tác", không gửi POST phiếu', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    await openForm(page, ROUTES.receipt, REC_PICKER);
    await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Thu thiếu đối tác ${uniq('PKR')}`);
    await fillAmount(page, 'Số tiền', '500000');
    await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await expect(fieldOf(page, REC_PICKER).getByText('Chọn đối tác', { exact: true })).toBeVisible();
    expect(writes.filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  test('công nợ: thiếu KH/NCC → báo lỗi dưới ô, không tạo khoản', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    await openForm(page, ROUTES.debt, DEBT_PICKER);
    await fillAmount(page, 'Số tiền', '900000');
    await page.getByRole('button', { name: 'Lưu khoản công nợ', exact: true }).click();
    await expect(fieldOf(page, DEBT_PICKER).getByText('Chọn khách hàng hoặc nhà cung cấp')).toBeVisible();
    expect(writes.filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  test('nợ ngân hàng: thiếu ngân hàng cho vay → báo lỗi dưới ô, không tạo khoản', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    await openForm(page, ROUTES.bankDebt, LOAN_PICKER);
    await fillAmount(page, 'Số tiền vay (gốc)', '3000000000');
    await page.getByRole('button', { name: 'Lưu khoản vay', exact: true }).click();
    await expect(fieldOf(page, LOAN_PICKER).getByText('Chọn ngân hàng cho vay')).toBeVisible();
    expect(writes.filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  test('khoản chi định kỳ: thiếu bên nhận → báo lỗi dưới ô, không tạo khoản', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    await page.goto(ROUTES.recurring);
    await page.getByRole('button', { name: '+ Thêm khoản định kỳ' }).click();
    const modal = recurModalLocator(page);
    await expect(modal).toBeVisible();
    await fieldOf(modal, 'Tiêu đề').locator('input').fill(uniq('PKR Dinh Ky'));
    await fieldOf(modal, 'Mục đích / ghi chú').locator('input').fill('Thuê mặt bằng test');
    await fillAmount(modal, 'Số tiền mỗi kỳ', '4000000');
    await modal.locator('.ant-modal-footer').getByRole('button', { name: 'Tạo khoản định kỳ' }).click();
    await expect(fieldOf(modal, RECUR_PICKER).getByText('Chọn bên nhận từ danh bạ đối tác')).toBeVisible();
    expect(writes.filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  test('phiếu chi "vay để chi": đã có bên nhận nhưng thiếu ngân hàng cho vay → báo "Chọn ngân hàng cho vay", không gửi POST', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    const payee = await apiCreatePartner(page, { type: 'supplier', name: uniq('PKR Thieu NH Ben Nhan') });
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, payee.name);
    await optionNamed(page, payee.name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(payee.name);
    await tickLoanForSpend(page);
    await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Vay để chi thiếu NH ${uniq('PKR')}`);
    await fillAmount(page, 'Số tiền', '500000');
    await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await expect(fieldOf(page, LENDER_PICKER).getByText('Chọn ngân hàng cho vay')).toBeVisible();
    expect(writes.filter((w) => w.startsWith('POST'))).toEqual([]);
  });

  test('phiếu thu đi vay: chưa chọn bên nộp (ngân hàng) → báo "Chọn đối tác", không gửi POST', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    await openForm(page, ROUTES.receipt, REC_PICKER);
    await tickBorrow(page);
    await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Đi vay thiếu NH ${uniq('PKR')}`);
    await fillAmount(page, 'Số tiền', '500000');
    await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await expect(fieldOf(page, REC_PICKER).getByText('Chọn đối tác', { exact: true })).toBeVisible();
    expect(writes.filter((w) => w.startsWith('POST'))).toEqual([]);
  });
});

/* ============================== 7. phiếu thu "đi vay": chỉ Ngân hàng ============================== */

test.describe('Phiếu thu "đi vay" (§11.4)', () => {
  test('bật "đi vay" khi bên nộp là KH/NCC → xoá đối tác và báo chọn lại', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Khach Vay');
    const cust = await apiCreatePartner(page, { type: 'customer', name });

    const picker = await openForm(page, ROUTES.receipt, REC_PICKER);
    await searchPicker(page, picker, name);
    // người dùng thực tế bật "đi vay" sau khi chi tiết đối tác đã tải xong
    const detailLoaded = page.waitForResponse((r) => r.url().includes(`/api/v1/partners/${cust._id}`) && r.request().method() === 'GET');
    await optionNamed(page, name).first().click();
    await detailLoaded;
    await expect(picker.locator('.ant-select')).toContainText(name);

    await tickBorrow(page);
    await expect(page.getByText(BORROW_NOT_BANK), 'thông báo chọn lại đối tác').toBeVisible();
    await expect(picker.locator('.ant-select-placeholder'), 'đối tác không phải NH bị xoá').toBeVisible();
    await expect(picker.locator('.ant-select')).not.toContainText(name);
  });

  test('phiếu thu: bật "đi vay" NGAY sau khi chọn KH (không chờ chi tiết) → KH bị bỏ và không quay lại', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Khach Vay Nhanh');
    await apiCreatePartner(page, { type: 'customer', name });

    const picker = await openForm(page, ROUTES.receipt, REC_PICKER);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    // bật ngay, không đợi GET chi tiết đối tác (thao tác nhanh)
    await tickBorrow(page);

    await expect(page.getByText(BORROW_NOT_BANK), 'thông báo chọn lại đối tác').toBeVisible();
    await expect(picker.locator('.ant-select-placeholder'), 'KH không phải NH bị bỏ ngay').toBeVisible();
    // chờ chi tiết (nếu có) tải xong rồi kiểm lại: KH không được giữ / quay lại
    await page.waitForTimeout(800);
    await expect(picker.locator('.ant-select-placeholder'), 'KH không quay lại sau khi chi tiết tải xong').toBeVisible();
    await expect(picker.locator('.ant-select')).not.toContainText(name);
    await expect(page.locator('label').filter({ hasText: BORROW_CHECKBOX }).locator('input[type="checkbox"]'), 'ô "đi vay" vẫn bật').toBeChecked();
  });

  test('đi vay: popup chỉ có loại Ngân hàng; tạo xong NH được chọn, ô "đi vay" vẫn bật', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.receipt, REC_PICKER);
    await tickBorrow(page);

    const newBank = uniq('PKR NH Vay');
    await searchPicker(page, picker, newBank);
    await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');
    await clickDropdownCreate(page);

    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(popName(pop)).toHaveValue(newBank);
    expect(await popTypeOptions(pop), 'đi vay ⇒ chỉ loại Ngân hàng').toEqual([]);
    expect(await popSelectedType(pop)).toBe(TYPE_LABEL.bank);
    await popFooter(pop, 'Tạo đối tác').click();

    await expectPopupClosed(pop);
    await expect(picker.locator('.ant-select')).toContainText(newBank);
    await expect(page.locator('label').filter({ hasText: BORROW_CHECKBOX }).locator('input[type="checkbox"]')).toBeChecked();
    const banks = await apiOptions(page, newBank, CTA, ['bank']);
    expect(banks.map((b) => b.name), 'đối tác tạo ra là Ngân hàng').toContain(newBank);
  });

  test('phiếu thu: KH được đổi thành Ngân hàng bằng "Sửa đối tác" rồi bật "đi vay" → vẫn giữ (đã là NH, không báo chọn lại)', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR KH Doi Thanh NH Vay');
    await apiCreatePartner(page, { type: 'customer', name });
    const picker = await openForm(page, ROUTES.receipt, REC_PICKER);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    const editBtn = picker.getByRole('button', { name: 'Sửa đối tác', exact: true });
    await expect(editBtn).toBeEnabled({ timeout: 15000 });
    await editBtn.click();
    const pop = partnerPopup(page, /^Sửa đối tác/);
    await popChooseType(pop, 'bank');
    await popFooter(pop, 'Lưu thay đổi').click();
    await expectPopupClosed(pop);
    await page.waitForTimeout(1000);
    await tickBorrow(page);
    await page.waitForTimeout(1000);
    // loại đối tác đã đổi thành Ngân hàng (sau khi sửa): không được coi là KH cũ
    await expect(page.getByText(BORROW_NOT_BANK), 'đối tác đã là Ngân hàng ⇒ không báo chọn lại').toHaveCount(0);
    await expect(picker.locator('.ant-select'), 'đối tác (nay là NH) vẫn được giữ khi bật đi vay').toContainText(name);
  });

  test('phiếu thu: NH được đổi thành KH bằng "Sửa đối tác" rồi bật "đi vay" → bị bỏ và báo chọn lại (đối tác nay là KH, §11.4)', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR NH Doi Thanh KH');
    await apiCreatePartner(page, { type: 'bank', name, bank_name: 'BIDV', account_number: uniqDigits(12) });
    const picker = await openForm(page, ROUTES.receipt, REC_PICKER);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    await expect(readonlyLine(picker, 'Ngân hàng')).toBeVisible({ timeout: 15000 });
    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();
    const pop = partnerPopup(page, /^Sửa đối tác/);
    await popChooseType(pop, 'customer');
    await popFooter(pop, 'Lưu thay đổi').click();
    await expectPopupClosed(pop);
    await page.waitForTimeout(1000);
    await tickBorrow(page);
    await expect(page.getByText(BORROW_NOT_BANK), 'KH không được là bên nộp của phiếu đi vay: báo chọn lại').toBeVisible({ timeout: 10000 });
    await expect(picker.locator('.ant-select-placeholder'), 'đối tác không phải NH bị bỏ').toBeVisible();
    await expect(picker.locator('.ant-select')).not.toContainText(name);
  });
});

/* ============================== 8. các màn khác: giữ dữ liệu sau khi tạo đối tác ============================== */

test.describe('Giữ dữ liệu đang nhập khi tạo đối tác trên form', () => {
  test('công nợ: popup chọn NCC → hướng, số tiền, ghi chú, số HĐ còn nguyên', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.debt, DEBT_PICKER);
    const tag = uniq('PKR CN');
    await page.locator('.ant-segmented-item').filter({ hasText: 'Phải trả' }).click();
    await fillAmount(page, 'Số tiền', '750000');
    await fieldOf(page, 'Số hợp đồng').locator('input').fill(`HD ${tag}`);
    await fieldOf(page, 'Ghi chú').locator('textarea').fill(`Ghi chú ${tag}`);
    const amount = await readValue(fieldOf(page, 'Số tiền').locator('input'));

    const newName = uniq('PKR NCC Moi');
    await searchPicker(page, picker, newName);
    await clickDropdownCreate(page);
    const pop = await expectCreatePopupDefaults(page, { id: 'công nợ', allowed: ['customer', 'supplier'], defaultType: 'customer', label: DEBT_PICKER, path: ROUTES.debt }, newName);
    await popChooseType(pop, 'supplier');
    await popFooter(pop, 'Tạo đối tác').click();
    await expectPopupClosed(pop);

    await expect(picker.locator('.ant-select')).toContainText(newName);
    await expect(page.locator('.ant-segmented-item-selected').filter({ hasText: 'Phải trả' }), 'hướng vẫn là Phải trả').toHaveCount(1);
    expect(await readValue(fieldOf(page, 'Số tiền').locator('input'))).toBe(amount);
    expect(await readValue(fieldOf(page, 'Số hợp đồng').locator('input'))).toBe(`HD ${tag}`);
    expect(await readValue(fieldOf(page, 'Ghi chú').locator('textarea'))).toBe(`Ghi chú ${tag}`);
    const created = (await apiOptions(page, newName, CTA)).find((p) => p.name === newName);
    expect(created?.type, 'chọn loại Nhà cung cấp trong popup ⇒ đối tác là NCC').toBe('supplier');
  });

  test('nợ ngân hàng: popup chỉ có Ngân hàng; tạo xong giữ số tiền, lãi suất, số HĐ', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.bankDebt, LOAN_PICKER);
    const tag = uniq('PKR NH Khoan');
    await fillAmount(page, 'Số tiền vay (gốc)', '5000000000');
    await fieldOf(page, 'Lãi suất (%/năm)').locator('input').fill('9,5');
    await fieldOf(page, 'Số HĐ tín dụng').locator('input').fill(`HDTD ${tag}`);
    const amount = await readValue(fieldOf(page, 'Số tiền vay (gốc)').locator('input'));

    const newBank = uniq('PKR BIDV CN');
    await searchPicker(page, picker, newBank);
    await clickDropdownCreate(page);
    const pop = await expectCreatePopupDefaults(page, { id: 'nợ ngân hàng', allowed: ['bank'], defaultType: 'bank', label: LOAN_PICKER, path: ROUTES.bankDebt }, newBank);
    await expect(pop.getByText('Với Ngân hàng: tên ngân hàng + chi nhánh cho vay')).toBeVisible();
    await popFooter(pop, 'Tạo đối tác').click();
    await expectPopupClosed(pop);

    await expect(picker.locator('.ant-select')).toContainText(newBank);
    expect(await readValue(fieldOf(page, 'Số tiền vay (gốc)').locator('input'))).toBe(amount);
    expect(await readValue(fieldOf(page, 'Lãi suất (%/năm)').locator('input'))).toBe('9,5');
    expect(await readValue(fieldOf(page, 'Số HĐ tín dụng').locator('input'))).toBe(`HDTD ${tag}`);
  });

  test('phiếu chi vay để chi: ô "Ngân hàng cho vay" chỉ liệt kê NH; tạo NH từ popup → được chọn', async ({ as }) => {
    const page = await as('staff');
    await page.goto(ROUTES.payment);
    await tickLoanForSpend(page);
    const lender = pickerOf(page, LENDER_PICKER);
    await expect(lender).toBeVisible();

    const newBank = uniq('PKR NH De Chi');
    await searchPicker(page, lender, newBank);
    await clickDropdownCreate(page);
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    expect(await popSelectedType(pop)).toBe(TYPE_LABEL.bank);
    await popFooter(pop, 'Tạo đối tác').click();
    await expectPopupClosed(pop);
    await expect(lender.locator('.ant-select')).toContainText(newBank);
  });

  test('khoản chi định kỳ: popup tạo bên nhận → giữ tiêu đề, mục đích, số tiền; lưu được khoản', async ({ as }) => {
    const page = await as('staff');
    await page.goto(ROUTES.recurring);
    await page.getByRole('button', { name: '+ Thêm khoản định kỳ' }).click();
    const modal = recurModalLocator(page);
    await expect(modal).toBeVisible();
    const picker = pickerOf(modal, RECUR_PICKER);
    const tag = uniq('PKR Dinh Ky Luu');
    const title = `Thuê ${tag}`;
    await fieldOf(modal, 'Tiêu đề').locator('input').fill(title);
    await fieldOf(modal, 'Mục đích / ghi chú').locator('input').fill(`Mục đích ${tag}`);
    await fillAmount(modal, 'Số tiền mỗi kỳ', '3000000');

    const newName = uniq('PKR Ben Nhan');
    await searchPicker(page, picker, newName);
    await clickDropdownCreate(page);
    const pop = await expectCreatePopupDefaults(page, { id: 'định kỳ', allowed: ALL, defaultType: 'customer', label: RECUR_PICKER }, newName);
    await popFooter(pop, 'Tạo đối tác').click();
    await expectPopupClosed(pop);

    await expect(picker.locator('.ant-select')).toContainText(newName);
    await expect(modal.getByText(`Tên bên nhận lấy từ đối tác đã chọn: ${newName}`)).toBeVisible();
    await expect(fieldOf(modal, 'Tiêu đề').locator('input')).toHaveValue(title);
    await expect(fieldOf(modal, 'Mục đích / ghi chú').locator('input')).toHaveValue(`Mục đích ${tag}`);

    await modal.locator('.ant-modal-footer').getByRole('button', { name: 'Tạo khoản định kỳ' }).click();
    await expect(modal, 'khoản định kỳ được tạo, modal đóng').toHaveCount(0, { timeout: 15000 });
    await expect(page.getByText(title).first(), 'khoản định kỳ hiện trong danh sách').toBeVisible({ timeout: 15000 });
  });
});

/* ============================== 9. quyền: giám đốc chỉ xem đối tác (§3.2) ============================== */

test.describe('Quyền đối tác trên ô chọn (§3.2: Giám đốc chỉ "xem" đối tác)', () => {
  test('giám đốc (không có partner:write): "+ Tạo đối tác" và "Sửa đối tác" bị khoá', async ({ as }) => {
    const kt = await as('staff');
    const name = uniq('PKR Quyen Xem');
    await apiCreatePartner(kt, { type: 'bank', name, bank_name: 'VPBank', account_number: uniqDigits(12) });

    const page = await as('director');
    const picker = await openForm(page, ROUTES.bankDebt, LOAN_PICKER);
    await expect(sideCreateButton(picker), 'nút + Tạo đối tác cạnh ô bị khoá').toBeDisabled();

    await searchPicker(page, picker, name);
    await expect(optionNamed(page, name)).toHaveCount(1);
    await expect(dropdown(page).getByRole('button', { name: /^\+ Tạo đối tác/ }), 'nút trong chân dropdown bị khoá').toBeDisabled();
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    await expect(picker.getByRole('button', { name: 'Sửa đối tác', exact: true }), 'Sửa đối tác bị khoá').toBeDisabled();
    await expect(readonlyLine(picker, 'Ngân hàng')).toHaveText('Ngân hàng: VPBank');
  });
});

/* ============================== 10. các trường hợp biên & chống ghi đúp ============================== */

test.describe('Trường hợp biên', () => {
  test('bấm "Tạo đối tác" hai lần nhanh → chỉ một đối tác được tạo (request_id)', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    const name = uniq('PKR Bam Doi');
    await searchPicker(page, picker, name);
    await clickDropdownCreate(page);
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(popName(pop)).toHaveValue(name);
    await popFooter(pop, 'Tạo đối tác').dblclick();
    await expectPopupClosed(pop);
    await expect(picker.locator('.ant-select')).toContainText(name);
    expect(await apiOptions(page, name, CTA), 'chỉ một đối tác dù bấm hai lần').toHaveLength(1);
  });

  test('popup: tên 1 ký tự → báo lỗi dưới ô "Tên đối tác", không gửi yêu cầu tạo', async ({ as }) => {
    const page = await as('staff');
    const writes = trackWrites(page);
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, 'Z');
    await clickDropdownCreate(page);
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(popName(pop)).toHaveValue('Z');
    await popFooter(pop, 'Tạo đối tác').click();
    await expect(fieldOf(pop, 'Tên đối tác').getByText('Tên đối tác tối thiểu 2 ký tự')).toBeVisible();
    expect(writes.filter((w) => w.startsWith('POST /api/v1/partners'))).toEqual([]);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('popup: đổi tên sau khi đã có cảnh báo trùng → cảnh báo của TÊN CŨ không còn hiện trong lúc kiểm tra tên mới', async ({ as }) => {
    const page = await as('staff');
    const old = uniq('PKR Dup Cu');
    const oldP = await apiCreatePartner(page, { type: 'customer', name: old });
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, old);
    await clickDropdownCreate(page);
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(pop.getByText('Có thể trùng với đối tác đã có — vẫn lưu được')).toBeVisible({ timeout: 10000 });

    // giữ kết quả kiểm trùng của tên mới (không trùng) để xem cảnh báo của tên cũ có còn hiện không
    let holding = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/api/v1/partners/check-duplicates', async (route) => {
      if (holding) await gate;
      await route.continue();
    });
    await popName(pop).fill(uniq('PKR Dup Moi Khac'));
    await page.waitForTimeout(1200);
    await expect.soft(pop.getByText('Có thể trùng với đối tác đã có — vẫn lưu được'), 'tên mới chưa có kết quả kiểm trùng ⇒ không hiện cảnh báo của tên cũ').toHaveCount(0);

    holding = false;
    release();
    await expect(pop.getByText('Có thể trùng với đối tác đã có — vẫn lưu được'), 'tên mới không trùng ⇒ không còn cảnh báo').toHaveCount(0, { timeout: 10000 });

    // đổi sang tên TRÙNG một đối tác khác: cảnh báo phải là của tên hiện tại; mã của đối tác tên cũ không còn hiện
    const clash = await apiCreatePartner(page, { type: 'customer', name: uniq('PKR Dup Dich') });
    await popName(pop).fill(clash.name);
    await expect(pop.getByText(`Trùng tên với đối tác ${clash.code}`), 'cảnh báo đúng với tên hiện tại').toBeVisible({ timeout: 10000 });
    await expect(pop.getByText(`Trùng tên với đối tác ${oldP.code}`), 'không còn cảnh báo của tên cũ').toHaveCount(0);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('trùng tên với đối tác ở CÔNG TY KHÁC: không cảnh báo (chỉ xét trong cùng công ty)', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Trung Cong Ty Khac');
    await apiCreatePartner(page, { type: 'customer', name }, CTB);

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, name);
    await clickDropdownCreate(page);
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(popName(pop)).toHaveValue(name);
    await page.waitForResponse((r) => r.url().includes('/api/v1/partners/check-duplicates') && r.status() === 200, { timeout: 8000 }).catch(() => null);
    await page.waitForTimeout(400);
    await expect(pop.getByText('Có thể trùng với đối tác đã có')).toHaveCount(0);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('đối tác vừa tạo từ popup xuất hiện trong gợi ý ngay sau khi lưu', async ({ as }) => {
    const page = await as('staff');
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    const name = uniq('PKR Cache');
    await searchPicker(page, picker, name);
    await clickDropdownCreate(page);
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await popFooter(pop, 'Tạo đối tác').click();
    await expectPopupClosed(pop);

    await picker.locator('.ant-select').first().hover();
    await picker.locator('.ant-select-clear').click({ force: true });
    await expect(picker.locator('.ant-select-placeholder')).toBeVisible();
    await searchPicker(page, picker, name);
    await expect(optionNamed(page, name), 'danh sách gợi ý làm mới sau khi tạo').toHaveCount(1);
  });

  test('bỏ chọn rồi bấm "+ Tạo đối tác" cạnh ô: Tên không lấy lại chữ tìm của đối tác đã bỏ', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Bo Ten Cu');
    await apiCreatePartner(page, { type: 'customer', name });
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);

    await picker.locator('.ant-select').first().hover();
    await picker.locator('.ant-select-clear').click({ force: true });
    await expect(sideCreateButton(picker)).toBeVisible();
    await expect(comboOf(picker), 'ô tìm đã trống sau khi bỏ chọn').toHaveValue('');
    await sideCreateButton(picker).click();
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(pop).toBeVisible();
    await expect(popName(pop), 'ô tìm đã trống nên Tên phải trống').toHaveValue('');
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('chọn đối tác → bỏ chọn (×) → gõ tên mới → "+ Tạo đối tác": popup thao tác được (radio loại bấm được)', async ({ as }) => {
    const page = await as('staff');
    const old = uniq('PKR Cu Bo Chon');
    await apiCreatePartner(page, { type: 'customer', name: old });
    const picker = await openForm(page, ROUTES.debt, DEBT_PICKER);
    await searchPicker(page, picker, old);
    await optionNamed(page, old).first().click();
    await expect(picker.locator('.ant-select')).toContainText(old);

    await picker.locator('.ant-select').first().hover();
    await picker.locator('.ant-select-clear').click();
    await expect(picker.locator('.ant-select-placeholder')).toBeVisible();

    const fresh = uniq('PKR Moi Sau Bo Chon');
    await searchPicker(page, picker, fresh);
    await clickDropdownCreate(page);
    const pop = partnerPopup(page, /^Tạo đối tác$/);
    await expect(popName(pop)).toHaveValue(fresh);
    await popChooseType(pop, 'supplier');
    await expect(pop.locator('.ant-segmented-item-selected').filter({ hasText: TYPE_LABEL.supplier }), 'chọn được loại trong popup').toHaveCount(1);
    await popFooter(pop, 'Hủy').click();
    await expectPopupClosed(pop);
  });

  test('sửa đối tác → Trạng thái "Ngừng giao dịch": ô báo không dùng cho phiếu mới; không còn gợi ý', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Sua Ngung');
    await apiCreatePartner(page, { type: 'customer', name, bank_name: 'ACB', account_number: uniqDigits(12) });
    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();

    const pop = partnerPopup(page, /^Sửa đối tác/);
    await fieldOf(pop, 'Trạng thái').locator('.ant-segmented-item').filter({ hasText: 'Ngừng giao dịch' }).click();
    await popFooter(pop, 'Lưu thay đổi').click();
    await expectPopupClosed(pop);

    await expect(picker.getByText('không dùng cho phiếu mới'), 'cảnh báo ngừng giao dịch trên ô').toBeVisible();
    await picker.locator('.ant-select').first().hover();
    await picker.locator('.ant-select-clear').click({ force: true });
    await searchPicker(page, picker, name);
    await expect(optionNamed(page, name), 'đối tác ngừng giao dịch không được gợi ý').toHaveCount(0);
  });

  test('công nợ: "Tài khoản kế toán" theo loại đối tác — KH ⇒ TK 131, đổi sang NCC (Sửa đối tác) ⇒ TK 331', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR TK Doi Loai');
    const cust = await apiCreatePartner(page, { type: 'customer', name });

    const picker = await openForm(page, ROUTES.debt, DEBT_PICKER);
    await expect(page.getByText('Chọn đối tác để suy TK')).toBeVisible();
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    await expect(page.getByText('TK 131').first(), 'KH ⇒ TK 131').toBeVisible();

    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();
    const pop = partnerPopup(page, /^Sửa đối tác/);
    await popChooseType(pop, 'supplier');
    await popFooter(pop, 'Lưu thay đổi').click();
    await expectPopupClosed(pop);
    await expect(page.getByText('TK 331').first(), 'sau khi đổi sang NCC ⇒ TK 331').toBeVisible();
    expect((await apiGetPartner(page, cust._id)).type).toBe('supplier');
  });

  test('phiếu thu: đối tác vừa chọn chưa tải xong chi tiết khi bật "đi vay" → không được giữ đối tác không phải NH', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Race Vay');
    const cust = await apiCreatePartner(page, { type: 'customer', name });
    const picker = await openForm(page, ROUTES.receipt, REC_PICKER);

    // mô phỏng mạng chậm: giữ phản hồi chi tiết đối tác cho tới khi tick xong
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === `/api/v1/partners/${cust._id}`,
      async (route) => {
        await gate;
        await route.continue();
      },
    );

    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    await tickBorrow(page);

    const detailLoaded = page.waitForResponse((r) => r.url().includes(`/api/v1/partners/${cust._id}`) && r.request().method() === 'GET', { timeout: 15000 });
    release();
    await detailLoaded;
    await page.waitForTimeout(400);

    const shown = (await picker.locator('.ant-select').innerText()).replace(/\s+/g, ' ').trim();
    expect(shown.includes(name), `bật "đi vay" nhưng đối tác KH vẫn được giữ sau khi tải xong (ô hiện: "${shown}"; đi vay: đã bật)`).toBe(false);
    await expect(page.getByText(BORROW_NOT_BANK), 'thông báo chọn lại đối tác').toBeVisible();
  });
});

/* ============================== 11. đổi loại đối tác đang được phiếu "đi vay" dùng (§5.1, §11.4) ============================== */

test.describe('Đổi loại đối tác đang được phiếu "đi vay" dùng (§5.1 bảng ràng buộc, §11.4)', () => {
  test('máy chủ chặn đổi NH sang KH khi còn phiếu thu "đi vay" (chế độ Để sau) dùng NH này (FG-PARTNER-003)', async ({ as }) => {
    const page = await as('staff');
    const headers = { 'x-company-scope': CTA };
    const bank = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Co Phieu Vay NH'), bank_name: 'BIDV', account_number: uniqDigits(12) });
    // phiếu thu "đi vay", chế độ "Để sau": chỉ mang cờ đi vay (chưa tạo khoản vay / chưa gắn NH cho vay) — bên nộp tiền là NH
    const draft = await page.request.post('/api/v1/documents', {
      data: {
        kind: 'income',
        company_id: CTA,
        title: uniq('PKR Vay De Sau'),
        purpose: 'Phiếu thu đi vay chế độ để sau',
        partner_id: bank._id,
        amount: { amount_minor: '100000000', currency: 'VND' },
        source: { fund: 'bank', account_id: null, group_managed: false },
        planned_date: '2026-12-01T10:00',
        priority: 'normal',
        tag_ids: [],
        options: { loan: { kind: 'borrow', mode: 'later', lender_partner_id: null, receive_account_id: null, amount_minor: null, existing_loan_id: null, terms: null } },
      },
      headers,
    });
    const draftText = await draft.text();
    expect(draft.status(), `lập phiếu thu đi vay (để sau) với NH: ${draftText}`).toBe(201);

    // đổi loại NH → KH: phải bị chặn vì phiếu đi vay vẫn bắt bên nộp tiền là NH (§11.4; §5.1 bảng "Phiếu thu đi vay → Ngân hàng")
    const res = await page.request.patch(`/api/v1/partners/${bank._id}`, { data: { type: 'customer' }, headers });
    const text = await res.text();
    if (res.status() < 300) {
      // dọn dữ liệu test: trả lại loại Ngân hàng để không để lại đối tác sai loại
      await page.request.patch(`/api/v1/partners/${bank._id}`, { data: { type: 'bank' }, headers });
    }
    expect(res.status(), `đổi NH sang KH khi còn phiếu thu đi vay dùng NH này phải bị chặn: ${text}`).toBeGreaterThanOrEqual(400);
    expect(res.status(), `lỗi phải là 4xx nghiệp vụ, không phải 5xx: ${text}`).toBeLessThan(500);
    expect(text, 'mã lỗi nghiệp vụ đổi loại đối tác').toContain('FG-PARTNER-003');
  });

  test('phiếu thu: đang bật "đi vay" với NH đã chọn → "Sửa đối tác" đổi NH thành KH ⇒ bị bỏ khỏi ô và báo chọn lại (§11.4)', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR NH Dang Vay Doi KH');
    await apiCreatePartner(page, { type: 'bank', name, bank_name: 'BIDV', account_number: uniqDigits(12) });
    const picker = await openForm(page, ROUTES.receipt, REC_PICKER);
    await tickBorrow(page);
    await searchPicker(page, picker, name);
    await optionNamed(page, name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(name);
    await expect(readonlyLine(picker, 'Ngân hàng')).toBeVisible({ timeout: 15000 });

    await picker.getByRole('button', { name: 'Sửa đối tác', exact: true }).click();
    const pop = partnerPopup(page, /^Sửa đối tác/);
    await popChooseType(pop, 'customer');
    await popFooter(pop, 'Lưu thay đổi').click();
    await expectPopupClosed(pop);

    await expect(page.getByText(BORROW_NOT_BANK), 'đối tác nay là KH ⇒ báo chọn lại').toBeVisible({ timeout: 10000 });
    await expect(picker.locator('.ant-select-placeholder'), 'KH không phải NH bị bỏ khỏi ô').toBeVisible();
    await expect(picker.locator('.ant-select')).not.toContainText(name);
    await expect(page.locator('label').filter({ hasText: BORROW_CHECKBOX }).locator('input[type="checkbox"]'), 'ô "đi vay" vẫn bật').toBeChecked();
  });

  // Đổi NH cho vay khi đã chọn khoản của NH cũ: (direct) chọn NH khác ngay; (clear) bỏ chọn (×) rồi chọn NH khác.
  for (const mode of ['direct', 'clear'] as const) {
    test(`phiếu thu đi vay ("Gắn khoản vay đã có"), đổi NH ${mode === 'direct' ? 'trực tiếp sang NH khác' : 'sau khi bỏ chọn (×)'} ⇒ ô khoản vay về "Chọn khoản vay", lưu bị chặn ở ô khoản vay, không gửi khoản của NH cũ (§11.4 b)`, async ({ as }) => {
      const page = await as('staff');
      const posts = trackDocPosts(page);
      const bankA = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Khoan NH A'), bank_name: 'BIDV', account_number: uniqDigits(12) });
      const bankB = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Khoan NH B'), bank_name: 'VCB', account_number: uniqDigits(12) });
      const loanA = await apiCreateLoan(page, bankA._id);

      const picker = await openForm(page, ROUTES.receipt, REC_PICKER);
      await tickBorrow(page);
      await page.locator('.ant-segmented-item').filter({ hasText: 'Gắn khoản vay đã có' }).click();
      const loanField = fieldOf(page, 'Khoản vay có sẵn');

      await searchPicker(page, picker, bankA.name);
      await optionNamed(page, bankA.name).first().click();
      await expect(picker.locator('.ant-select')).toContainText(bankA.name);
      await pickLoan(page, loanField, loanA.code);

      await switchBank(page, picker, bankB.name, mode);
      await expect(loanField.locator('.ant-select-placeholder'), 'ô khoản vay về placeholder "Chọn khoản vay"').toHaveText('Chọn khoản vay');
      await expect(loanField.locator('.ant-select-selection-item'), 'không còn hiện khoản của NH cũ').toHaveCount(0);
      await expect(loanField, 'dòng chú thích khớp với ô (NH mới chưa có khoản)').toContainText('Ngân hàng này chưa có khoản vay chờ giải ngân / đang vay');

      await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Đi vay khoản NH cũ ${uniq('PKR')}`);
      await fillAmount(page, 'Số tiền', '1000000');
      await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
      await expect(loanField.getByRole('alert'), 'lưu bị chặn: lỗi hiện ngay dưới ô khoản vay').toHaveText('Chọn khoản vay đã có');
      expect(posts.filter((b) => b.includes(loanA._id) || b.includes(loanA.code)), 'không gửi khoản của NH cũ lên máy chủ').toEqual([]);
    });
  }

  test('phiếu thu đi vay: đổi sang NH có khoản riêng ⇒ danh sách chỉ có khoản của NH đó; chọn khoản đó rồi lưu nháp được (§11.4 b)', async ({ as }) => {
    const page = await as('staff');
    const bankA = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Khoan NH A Ok'), bank_name: 'BIDV', account_number: uniqDigits(12) });
    const bankB = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Khoan NH B Ok'), bank_name: 'VCB', account_number: uniqDigits(12) });
    const loanA = await apiCreateLoan(page, bankA._id);
    const loanB = await apiCreateLoan(page, bankB._id);

    const picker = await openForm(page, ROUTES.receipt, REC_PICKER);
    await tickBorrow(page);
    await page.locator('.ant-segmented-item').filter({ hasText: 'Gắn khoản vay đã có' }).click();
    const loanField = fieldOf(page, 'Khoản vay có sẵn');

    await searchPicker(page, picker, bankA.name);
    await optionNamed(page, bankA.name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(bankA.name);
    await pickLoan(page, loanField, loanA.code);

    await switchBank(page, picker, bankB.name, 'direct');
    await expect(loanField.locator('.ant-select-placeholder')).toHaveText('Chọn khoản vay');
    await loanField.locator('.ant-select').first().click();
    await expect(dropdown(page).locator('.ant-select-item-option').filter({ hasText: loanB.code }), 'khoản của NH mới được liệt kê').toHaveCount(1, { timeout: 15000 });
    await expect(dropdown(page).locator('.ant-select-item-option').filter({ hasText: loanA.code }), 'khoản của NH cũ không được liệt kê').toHaveCount(0);
    await dropdown(page).locator('.ant-select-item-option').filter({ hasText: loanB.code }).first().click();
    await expect(loanField.locator('.ant-select')).toContainText(loanB.code);

    await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Đi vay khoản NH B ${uniq('PKR')}`);
    await fillAmount(page, 'Số tiền', '1000000');
    const posted = page.waitForResponse((r) => r.url().includes('/api/v1/documents') && r.request().method() === 'POST', { timeout: 15000 });
    await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    const res = await posted;
    const text = await res.text();
    expect(res.status(), `lưu nháp với khoản của NH mới phải được nhận: ${text}`).toBe(201);
    expect(text, 'phiếu gửi đúng khoản của NH mới').toContain(loanB._id);
  });

  // Đảo hạn: đổi NH sau khi đã chọn khoản đang vay của NH cũ (direct / clear như trên).
  for (const mode of ['direct', 'clear'] as const) {
    test(`đảo hạn, đổi NH ${mode === 'direct' ? 'trực tiếp sang NH khác' : 'sau khi bỏ chọn (×)'} khi đã chọn khoản đang vay ⇒ ô khoản vay về "Chọn khoản vay của ngân hàng này", danh sách chỉ có khoản của NH mới, lưu bị chặn (§10.3, §11.4)`, async ({ as }) => {
      const page = await as('staff');
      const posts = trackDocPosts(page);
      const bankA = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Dao Han NH A'), bank_name: 'BIDV', account_number: uniqDigits(12) });
      const bankB = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Dao Han NH B'), bank_name: 'VCB', account_number: uniqDigits(12) });
      const loanA = await apiCreateLoan(page, bankA._id);
      const loanB = await apiCreateLoan(page, bankB._id);

      const picker = await openForm(page, '/ngan-hang/dao-han/phuong-an/moi', 'Ngân hàng');
      const loanField = fieldOf(page, 'Khoản vay đang đảo hạn');
      await searchPicker(page, picker, bankA.name);
      await optionNamed(page, bankA.name).first().click();
      await expect(picker.locator('.ant-select')).toContainText(bankA.name);
      await pickLoan(page, loanField, loanA.code);

      await switchBank(page, picker, bankB.name, mode);
      await expect(loanField.locator('.ant-select-placeholder'), 'ô khoản vay về placeholder của đảo hạn').toHaveText('Chọn khoản vay của ngân hàng này');
      await expect(loanField.locator('.ant-select-selection-item'), 'không còn hiện khoản của NH cũ').toHaveCount(0);

      await loanField.locator('.ant-select').first().click();
      await expect(dropdown(page).locator('.ant-select-item-option').filter({ hasText: loanB.code }), 'khoản của NH mới được liệt kê').toHaveCount(1, { timeout: 15000 });
      await expect(dropdown(page).locator('.ant-select-item-option').filter({ hasText: loanA.code }), 'khoản của NH cũ không được liệt kê').toHaveCount(0);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
      await expect(loanField.getByRole('alert'), 'lưu bị chặn: lỗi hiện ngay dưới ô khoản vay').toHaveText('Chọn khoản vay đang đảo hạn (cùng ngân hàng)');
      expect(posts.filter((b) => b.includes(loanA._id) || b.includes(loanA.code)), 'không gửi khoản của NH cũ lên máy chủ').toEqual([]);
    });
  }

  test('đảo hạn: đổi sang NH có khoản đang vay ⇒ chọn được khoản của NH mới và lưu nháp được (máy chủ nhận loan_id của NH mới)', async ({ as }) => {
    const page = await as('staff');
    const bankA = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Dao Han Ok NH A'), bank_name: 'BIDV', account_number: uniqDigits(12) });
    const bankB = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Dao Han Ok NH B'), bank_name: 'VCB', account_number: uniqDigits(12) });
    const loanA = await apiCreateLoan(page, bankA._id);
    const loanB = await apiCreateLoan(page, bankB._id);

    const picker = await openForm(page, '/ngan-hang/dao-han/phuong-an/moi', 'Ngân hàng');
    const loanField = fieldOf(page, 'Khoản vay đang đảo hạn');
    await searchPicker(page, picker, bankA.name);
    await optionNamed(page, bankA.name).first().click();
    await expect(picker.locator('.ant-select')).toContainText(bankA.name);
    await pickLoan(page, loanField, loanA.code);
    await switchBank(page, picker, bankB.name, 'direct');
    await pickLoan(page, loanField, loanB.code);

    await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(`Đảo hạn ${uniq('PKR')}`);
    await fillAmount(page, 'Số tiền', '1000000000');
    const maturity = fieldOf(page, 'Ngày đáo hạn mới').locator('input').first();
    await maturity.fill('01/12/2027');
    await maturity.press('Enter');
    await fieldOf(page, 'Phương án đảo hạn').locator('textarea').fill(`Gia hạn ${uniq('PKR')}`);

    const posted = page.waitForResponse((r) => r.url().includes('/api/v1/documents') && r.request().method() === 'POST', { timeout: 15000 });
    await page.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    const res = await posted;
    const text = await res.text();
    expect(res.status(), `lưu phương án đảo hạn với khoản của NH mới phải được nhận: ${text}`).toBe(201);
    expect(text, 'phương án gửi đúng khoản của NH mới').toContain(loanB._id);
  });

  test('đảo hạn mở từ khoản vay (?loan_id & partner_id): ô Ngân hàng và ô khoản vay đã điền sẵn đúng khoản', async ({ as }) => {
    const page = await as('staff');
    const bank = await apiCreatePartner(page, { type: 'bank', name: uniq('PKR Dao Han Prefill NH'), bank_name: 'BIDV', account_number: uniqDigits(12) });
    const loan = await apiCreateLoan(page, bank._id);

    await page.goto(`/ngan-hang/dao-han/phuong-an/moi?kind=rollover&loan_id=${loan._id}&partner_id=${bank._id}`);
    const picker = pickerOf(page, 'Ngân hàng');
    await expect(picker.locator('.ant-select')).toContainText(bank.name, { timeout: 15000 });
    await expect(fieldOf(page, 'Khoản vay đang đảo hạn').locator('.ant-select')).toContainText(loan.code, { timeout: 15000 });
  });
});

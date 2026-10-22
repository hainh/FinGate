/**
 * E2E · Nợ ngân hàng & đáo hạn (v2/v2.md §10, §11.4–11.5, US-LOAN-01…04, US-AUTO-08, LOAN-05).
 *
 *   PW_AREA=loans npx playwright test e2e/v2-loans.spec.ts
 *
 * Quy ước:
 *  - Thiết lập dữ liệu (đối tác, phiếu, duyệt, thực thi) gọi API; kiểm tra hành vi bằng UI thật.
 *  - Vòng retest 2: ĐÃ BỎ phản hồi giả (`patchLoanDetailChain`). Màn chi tiết đọc chuỗi thật
 *    (`chain.funded_by` / `chain.disbursements` / `chain.repayments` đều là mảng).
 *  - Các lỗi đã báo có assertion riêng, đánh dấu "[lỗi đã báo]" trong code, để chạy lại thấy ngay nếu tái diễn.
 *  - Vòng retest 4: thêm kiểm tra cho (a) danh sách không cắt 2.000 dòng — cả tổng và "Dư nợ theo ngân hàng";
 *    (b) lãi suất chỉ 2 chữ số thập phân ở mọi đường nhập (API + form + nhập lô + kết quả đảo hạn);
 *    (c) phương án đảo hạn nhận "abc" bị chặn ở API và ở form; (d) hiệu năng danh sách / đáo hạn (ngân sách ghi trong test).
 *  - Vòng retest 5: (e) lãi suất cũ trong CSDL đã làm sạch (kiểm đếm trực tiếp, migration 0006 đã ghi nhận);
 *    (f) danh sách có phân trang phía máy chủ (trang 2 khác trang 1; tìm theo mã khi ở trang 2 ⇒ về trang 1);
 *    (g) nhập theo lô tra mã đúng công ty (partners/options?codes= trả 200, dòng hợp lệ hiện "Hợp lệ" với tên ngân hàng);
 *    (h) mọi trang của file này ghim phạm vi về CTA (tài khoản kt@/ktt@ dùng chung; tiến trình khác có thể đổi default_scope).
 *  - Tên dữ liệu đều dùng uniq(...) (các tiến trình khác dùng chung DB test).
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect as baseExpect, uniq } from './fixtures';
import {
  addDays,
  addMonthsIso,
  apiGet,
  apiPost,
  apiPostRaw,
  approveChain,
  createBank,
  createCustomer,
  createLoanApi,
  createSupplier,
  createVoucherApi,
  ctaBankAccount,
  fieldInput,
  findCta,
  getLoanApi,
  getVoucherApi,
  incomeBody,
  LONG_REASON,
  listLoansApi,
  payVoucherApi,
  scopeOf,
  spendBody,
  transitionApi,
  tsv,
  typeDate,
  toDdmmyyyy,
  unwrap,
  vnToday,
  waitForLoan,
  type Cta,
  type LoanApi,
} from './helpers-loans';
import { DEADLINE_UI, fieldOf, gotoCta, pickPartner, pickSelect } from './helpers-vouchers';

const SEARCH_PLACEHOLDER = 'Tìm theo mã hoặc tên ngân hàng';
/**
 * `expect` của file này chờ tối đa 30 s (mặc định toàn cục 10 s). Lý do: danh sách / bảng đáo hạn / chi tiết chứng từ
 * tải lại khoản vay (API trả tới 2.000 khoản mỗi lượt), nên khi máy chủ dùng chung đang bận, 10 s không đủ —
 * đây là lỗi chờ, không phải dữ liệu sai. Chỉ đổi thời gian chờ; không đổi giá trị kỳ vọng nào.
 */
const expect = baseExpect.configure({ timeout: 30_000 });

/** Ô khối "Dư nợ theo ngân hàng" (bảng ngay sau tiêu đề h2). */
const bankTotalsTable = (page: Page) => page.locator('h2', { hasText: 'Dư nợ theo ngân hàng' }).locator('xpath=following::table[1]');
/**
 * Dòng của một ngân hàng trong "Dư nợ theo ngân hàng". Bảng có hàng nghìn ngân hàng (DB test) và phân trang 20 dòng
 * ⇒ không nằm chắc ở trang đầu: lọc theo tên (ô tìm trong bảng) trước khi kiểm.
 */
const bankTotalsRow = async (page: Page, name: string) => {
  await page.getByPlaceholder('Tìm ngân hàng trong bảng').fill(name);
  return bankTotalsTable(page).locator('tr', { hasText: name });
};
/** Bảng "Sắp giải ngân" (bảng ngay sau tiêu đề h2). */
const pendingTable = (page: Page) => page.locator('h2', { hasText: 'Sắp giải ngân' }).locator('xpath=following::table[1]');

/** Dialog Ant Design đang hiển thị (portal ngoài <main>). */
const openDialog = (page: Page) => page.locator('.ant-modal-wrap:visible, [role="dialog"]:visible').last();
/** Thẻ "Lịch sử thay đổi" trên màn chi tiết khoản vay (khối chứa bảng lịch sử). */
const historyCardOf = (page: Page) => page.getByText('Lịch sử thay đổi', { exact: true }).first().locator('xpath=ancestor::*[.//table][1]');

/**
 * Ghim phạm vi của TRANG về CTA (cùng cách với v2-debts.spec.ts / v2-partner-picker.spec.ts). Tài khoản kt@/ktt@ dùng
 * chung giữa các tiến trình e2e; tiến trình khác có thể đặt prefs.default_scope sang MAYOGU/CTB giữa lúc trang mở.
 * Khi đó ô tra mã nhập lô tra đúng nhưng trong công ty sai ⇒ báo "Không có ngân hàng đang hoạt động với mã này" giả
 * (đã thấy ở vòng 5). Chỉ đổi phản hồi GET /me gửi TỚI TRANG NÀY; không ghi gì vào DB.
 */
async function pinCtaScope(page: Page, cta: Cta): Promise<void> {
  await page.route('**/api/v1/me', async (route) => {
    try {
      const res = await route.fetch();
      if (!res.ok()) {
        await route.fulfill({ response: res });
        return;
      }
      const body = (await res.json()) as Record<string, any>;
      const d = body.data ?? body;
      if (d.prefs) d.prefs.default_scope = cta.id;
      if (d.scope) d.scope.active_company_id = cta.id;
      await route.fulfill({ response: res, json: body });
    } catch {
      // [ổn định] lỗi trong route (máy chủ chậm quá thời gian chờ của route.fetch, hoặc context đóng lúc test kết thúc
      // khi còn yêu cầu /me đang chạy) được Playwright ghi thành lỗi của TEST dù nghiệp vụ đúng ("Request context
      // disposed" / "Response has been disposed"). Khi đó để yêu cầu đi thẳng tới máy chủ (không ghim phạm vi) và bỏ
      // qua lỗi nếu trang/context đã đóng.
      await route.continue().catch(() => undefined);
    }
  });
}

/** Tìm công ty CTA rồi ghim phạm vi của trang về CTA (xem pinCtaScope). */
async function ctaPinned(page: Page): Promise<Cta> {
  const cta = await findCta(page);
  await pinCtaScope(page, cta);
  return cta;
}

/**
 * Lãi suất vi phạm quy tắc 2 chữ số thập phân trong CSDL test (đọc-only, qua container fingate-mongo).
 * Cùng regex với migration db/migrations/0006-clean-interest-rates.js (RATE_RE). Kiểm toàn bộ công ty: nguồn
 * sự thật của "dữ liệu cũ" — API chỉ trả một phần (trang) nên không đủ để khẳng định không còn bản ghi vi phạm.
 */
const LEGACY_RATE_SCRIPT = String.raw`
const re = /^\d+([.,]\d{1,2})?$/;
const bad = (v) => v !== undefined && v !== null && !re.test(String(v));
const loans = db.bank_debts.find({}, { interest_rate: 1 }).toArray();
const docs = db.documents.find({}, { rollover: 1, options: 1 }).toArray();
const out = {
  bank_debts_total: loans.length,
  bank_debts_bad: loans.filter((d) => bad(d.interest_rate)).length,
  rollover_new_rate_bad: docs.filter((d) => d.rollover && bad(d.rollover.new_rate)).length,
  rollover_result_rate_bad: docs.filter((d) => d.rollover && d.rollover.result && bad(d.rollover.result.new_rate)).length,
  loan_terms_rate_bad: docs.filter((d) => d.options && d.options.loan && d.options.loan.terms && bad(d.options.loan.terms.interest_rate)).length,
  migrations_applied: ((db.settings.findOne({ key: 'migrations.applied' }) || {}).value || {}).applied || [],
};
print(JSON.stringify(out));
`;

interface LegacyRateReport {
  bank_debts_total: number;
  bank_debts_bad: number;
  rollover_new_rate_bad: number;
  rollover_result_rate_bad: number;
  loan_terms_rate_bad: number;
  migrations_applied: string[];
}

function legacyRateReport(): LegacyRateReport {
  const raw = execFileSync('docker', ['exec', 'fingate-mongo', 'mongosh', '--quiet', 'fingate', '--eval', LEGACY_RATE_SCRIPT], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const line = raw.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error(`Không đọc được kết quả kiểm lãi suất cũ từ CSDL: ${raw.slice(0, 300)}`);
  return JSON.parse(line) as LegacyRateReport;
}

test.describe('v2 · Nợ ngân hàng & đáo hạn', () => {
  /* ------------------------------ LOAN-01 · tạo khoản vay ------------------------------ */

  test('US-LOAN-01 · ô "Ngân hàng cho vay" chỉ liệt kê đối tác loại Ngân hàng', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Chon');
    const customer = await createCustomer(staff, cta, 'KH Khong Chon');

    await staff.goto('/ngan-hang/khoan-vay/moi');
    await expect(staff.getByText('Tạo khoản nợ ngân hàng', { exact: true })).toBeVisible();

    const picker = fieldInput(staff, 'Ngân hàng cho vay');
    await picker.click();
    await picker.fill(bank.name);
    await expect(staff.locator('.ant-select-item-option', { hasText: bank.name })).toBeVisible();

    // Đối tác Khách hàng (không phải ngân hàng) không được gợi ý
    await picker.fill(customer.name);
    await expect(staff.getByText('Không có đối tác phù hợp')).toBeVisible();
    await expect(staff.locator('.ant-select-item-option', { hasText: customer.name })).toHaveCount(0);

    // Danh sách mặc định: mọi lựa chọn đều là Ngân hàng
    await picker.fill('');
    await expect(staff.locator('.ant-select-item-option').first()).toBeVisible();
    const labels = await staff.locator('.ant-select-item-option').allInnerTexts();
    expect(labels.length).toBeGreaterThan(0);
    for (const t of labels) expect(t, `lựa chọn "${t.slice(0, 60)}"`).not.toMatch(/Khách hàng|Nhà cung cấp/);
  });

  test('US-LOAN-01 · ô "Ngân hàng cho vay": khi tải danh sách đối tác bị lỗi, không báo "Không có đối tác phù hợp" (dễ hiểu nhầm là chưa có ngân hàng)', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Tai Lai');
    // giả lập lỗi máy chủ cho danh sách đối tác của ô chọn (chỉ trong test này)
    const optionsRoute = /\/api\/v1\/partners\/options/;
    await staff.route(optionsRoute, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ title: 'Tạm thời không khả dụng', status: 503, code: 'FG-E2E-503', detail: 'E2E: giả lập lỗi tải danh sách' }) }),
    );

    await staff.goto('/ngan-hang/khoan-vay/moi');
    const picker = fieldInput(staff, 'Ngân hàng cho vay');
    await picker.click();
    // chờ tới khi ô chọn kết thúc tải (sau lỗi và các lượt thử lại của máy khách)
    await expect(staff.getByText('Đang tìm…')).toHaveCount(0, { timeout: 20_000 });
    // [lỗi đã báo] khi lỗi phải có thông báo lỗi, không được hiện như "không có kết quả"
    await expect(staff.getByText(/không tải được|lỗi tải/i).first(), 'lỗi tải danh sách đối tác phải được báo').toBeVisible();
    await expect(staff.getByText('Không có đối tác phù hợp'), 'không được báo "Không có đối tác phù hợp" khi thực ra là lỗi tải').toHaveCount(0);

    // "để người dùng thử lại": bỏ giả lập lỗi, bấm "Thử lại" ⇒ thông báo lỗi biến mất, tìm được ngân hàng vừa tạo
    await staff.unroute(optionsRoute);
    await staff.getByRole('button', { name: 'Thử lại' }).click();
    await expect(staff.getByText(/Không tải được danh sách đối tác/), 'sau "Thử lại" thông báo lỗi phải biến mất').toHaveCount(0, { timeout: 20_000 });
    await picker.fill(bank.name);
    await expect(staff.locator('.ant-select-item-option', { hasText: bank.name }).first()).toBeVisible({ timeout: 20_000 });
  });

  test('US-LOAN-01 · KTV tạo khoản vay (chọn ngân hàng, gốc, hạn mức, lãi, kỳ hạn, hạn) → lưu, trạng thái "Đang vay"', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Tao Vay');
    const today = vnToday();
    const maturity = addDays(today, 365);
    const contract = uniq('HDTD E2E').slice(0, 60);
    const collateral = uniq('Nhà xưởng E2E');
    const note = uniq('Ghi chú vay E2E');

    await staff.goto('/ngan-hang/khoan-vay/moi');
    const picker = fieldInput(staff, 'Ngân hàng cho vay');
    await picker.click();
    await picker.fill(bank.name);
    await staff.locator('.ant-select-item-option', { hasText: bank.name }).first().click();

    await fieldInput(staff, 'Số tiền vay (gốc)').fill('150000000');
    await expect(staff.getByText('150.000.000 ₫').first()).toBeVisible();
    await fieldInput(staff, 'Hạn mức tín dụng').fill('200000000');
    await typeDate(staff, 'Hạn thanh toán (đáo hạn)', maturity);
    await fieldInput(staff, 'Lãi suất (%/năm)').fill('9,5');
    await fieldInput(staff, 'Kỳ hạn (tháng)').fill('12');
    await fieldInput(staff, 'Số HĐ tín dụng').fill(contract);
    await fieldInput(staff, 'Người phụ trách').fill('Nguyễn Văn Kế');
    await fieldInput(staff, 'Tài sản đảm bảo', 'textarea').fill(collateral);
    await fieldInput(staff, 'Ghi chú', 'textarea').fill(note);

    await staff.getByRole('button', { name: 'Lưu khoản vay' }).click();
    await expect(staff).toHaveURL(/\/ngan-hang\/khoan-vay\/[0-9a-f]{24}$/, { timeout: 20_000 });
    const id = staff.url().split('/').pop() as string;

    const loan = await getLoanApi(staff, cta, id);
    expect(loan.status).toBe('active');
    expect(loan.partner_id).toBe(bank.id);
    expect(loan.principal.minor).toBe('150000000');
    expect(loan.outstanding.minor).toBe('150000000');
    expect(loan.disbursed.minor).toBe('150000000');
    expect(loan.undisbursed.minor).toBe('0');
    // lãi dự kiến tới đáo hạn = 150 triệu × 9,5% × 365/365 = 14.250.000
    expect(loan.interest_to_maturity.minor).toBe('14250000');
    expect(loan.credit_limit.minor).toBe('200000000');
    expect(Number(loan.interest_rate.replace(',', '.'))).toBe(9.5);
    // [lỗi đã báo] lãi suất nhập "9,5" được lưu đúng dạng dấu phẩy (không đổi thành "9.5")
    expect.soft(loan.interest_rate, 'lãi suất lưu dạng dấu phẩy "9,5"').toBe('9,5');
    expect(loan.term_months).toBe(12);
    expect(loan.maturity_date).toBe(maturity);
    expect(loan.origin.kind).toBe('manual');
    expect(loan.contract_no).toBe(contract);
    expect(loan.responsible).toBe('Nguyễn Văn Kế');
    expect(loan.collateral).toBe(collateral);
    expect(loan.note).toBe(note);

    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(loan.code);
    const row = staff.locator('tr', { hasText: loan.code });
    await expect(row).toContainText('Đang vay');
    await expect(row).toContainText(bank.name);
    await expect(row).toContainText('150.000.000');
    // [lỗi đã báo] danh sách hiện lãi suất theo quy ước VN: "9,5 %/năm"
    await expect.soft(row, 'danh sách: lãi suất "9,5 %/năm"').toContainText('9,5 %/năm');
  });

  test('US-LOAN-01 · kiểm tra bắt buộc (form) và chặn ở máy chủ (đối tác không phải ngân hàng, hạn không sau giải ngân)', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Kiem Tra');
    const customer = await createCustomer(staff, cta, 'KH Kiem Tra');

    await staff.goto('/ngan-hang/khoan-vay/moi');
    await staff.getByRole('button', { name: 'Lưu khoản vay' }).click();
    await expect(staff.getByRole('alert').filter({ hasText: 'Chọn ngân hàng cho vay' })).toBeVisible();

    const picker = fieldInput(staff, 'Ngân hàng cho vay');
    await picker.click();
    await picker.fill(bank.name);
    await staff.locator('.ant-select-item-option', { hasText: bank.name }).first().click();
    await fieldInput(staff, 'Số tiền vay (gốc)').fill('0');
    await staff.getByRole('button', { name: 'Lưu khoản vay' }).click();
    await expect(staff.getByRole('alert').filter({ hasText: 'Nhập số tiền vay lớn hơn 0' })).toBeVisible();

    await fieldInput(staff, 'Số tiền vay (gốc)').fill('1000000');
    await typeDate(staff, 'Hạn thanh toán (đáo hạn)', vnToday());
    await staff.getByRole('button', { name: 'Lưu khoản vay' }).click();
    await expect(staff.getByRole('alert').filter({ hasText: 'Hạn thanh toán phải sau ngày giải ngân' })).toBeVisible();

    // Máy chủ: đối tác Khách hàng bị từ chối (FG-PARTNER-001)
    const badPartner = await apiPostRaw(staff, cta, 'bank-debts', {
      partner_id: customer.id,
      amount: { amount_minor: '1000000', currency: 'VND' },
      maturity_date: addDays(vnToday(), 90),
    });
    expect(badPartner.status).toBe(422);
    expect(badPartner.body.code).toBe('FG-PARTNER-001');
    expect(String(badPartner.body.detail)).toContain('chỉ dùng đối tác loại Ngân hàng');

    // Máy chủ: hạn thanh toán không sau ngày giải ngân (FG-VAL-001)
    const badMaturity = await apiPostRaw(staff, cta, 'bank-debts', {
      partner_id: bank.id,
      amount: { amount_minor: '1000000', currency: 'VND' },
      disbursed_date: vnToday(),
      maturity_date: vnToday(),
    });
    expect(badMaturity.status).toBe(422);
    expect(badMaturity.body.code).toBe('FG-VAL-001');
    expect(String(badMaturity.body.detail)).toContain('Hạn thanh toán phải sau ngày giải ngân');
  });

  test('US-LOAN-02 · [chi tiết] màn chi tiết khoản vay mở được và hiển thị chỉ tiêu (trạng thái, dư nợ, đã trả)', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Chi Tiet');
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '80000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -30),
      maturity_date: addDays(vnToday(), 120),
      interest_rate: '8',
    });

    await staff.goto(`/ngan-hang/khoan-vay/${loan._id}`);
    // Chờ màn hình ổn định (chỉ tiêu hoặc khung lỗi) rồi mới khẳng định không có lỗi
    const crashed = staff.getByText('Hệ thống đang gặp sự cố');
    const kpiDue = staff.getByText('Dư nợ', { exact: true });
    await expect(crashed.or(kpiDue).first()).toBeVisible({ timeout: 20_000 });
    await expect(crashed, 'màn chi tiết không được hiện khung lỗi').toHaveCount(0);
    await expect(kpiDue).toBeVisible();
    await expect(staff.getByText('Đang vay').first()).toBeVisible();
    await expect(staff.getByText('80.000.000 ₫').first()).toBeVisible();

    // [lỗi đã báo] đủ các chỉ tiêu và ba mục chuỗi trên màn chi tiết (v2 §10.1–10.3, US-AUTO-08)
    for (const label of ['Số tiền vay (gốc)', 'Đã giải ngân', 'Đã trả gốc', 'Dư nợ']) {
      await expect(staff.getByText(label, { exact: true }).first(), `chỉ tiêu "${label}"`).toBeVisible();
    }
    for (const title of ['Phiếu chi được tài trợ', 'Phiếu thu giải ngân', 'Phiếu chi trả nợ']) {
      await expect(staff.getByText(title, { exact: false }).first(), `mục chuỗi "${title}"`).toBeVisible();
    }

    // [lỗi đã báo] "Lịch sử thay đổi": cột "Thao tác" hiện nhãn tiếng Việt, không hiện mã kỹ thuật ("create")
    const histCard = historyCardOf(staff);
    await expect.soft(histCard, 'lịch sử: thao tác "create" hiện "Tạo khoản vay"').toContainText('Tạo khoản vay');
    await expect.soft(histCard, 'lịch sử: không hiện mã kỹ thuật "create"').not.toContainText('create');

    // [lỗi đã báo] chuỗi chứng từ luôn là mảng, kể cả khi khoản vay chưa có liên kết nào (không được null)
    const detail = await getLoanApi(staff, cta, loan._id);
    expect(Array.isArray(detail.chain.funded_by), 'chain.funded_by phải là mảng').toBe(true);
    expect(Array.isArray(detail.chain.disbursements), 'chain.disbursements phải là mảng').toBe(true);
    expect(Array.isArray(detail.chain.repayments), 'chain.repayments phải là mảng').toBe(true);
  });

  /* ------------------------------ US-LOAN-02 · giải ngân chờ & đáo hạn ------------------------------ */

  test('US-LOAN-02 · khoản chờ giải ngân (R2) nằm ở "Sắp giải ngân", không vào dư nợ; giải ngân xong thì "Đang vay"', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Cho Giai Ngan');
    const account = await ctaBankAccount(staff, cta);

    // Phiếu thu đi vay (R2): tạo khoản chờ giải ngân ngay khi lưu phiếu
    const contractR2 = uniq('HDTD R2').slice(0, 60);
    const collateralR2 = uniq('TSĐB R2');
    const receipt = await createVoucherApi(
      staff,
      cta,
      incomeBody({
        partnerId: bank.id,
        accountId: account,
        amountMinor: '30000000',
        options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank.id, terms: { contract_no: contractR2, interest_rate: '8,5', collateral: collateralR2 } } },
      }),
    );
    const pending = await waitForLoan(staff, cta, bank.id, (l) => l.status === 'pending_disbursement');
    expect(pending.origin.kind).toBe('automation');
    expect(pending.origin.rule_code).toBe('R2');
    expect(pending.principal.minor).toBe('30000000');
    expect(pending.outstanding.minor).toBe('0');
    expect(pending.maturity_date).toBe(addMonthsIso(vnToday(), 11));
    // [lỗi đã báo] số HĐ tín dụng và TSĐB phải nằm ở trường riêng của khoản vay, không chỉ trong ghi chú (§10.1, §11.4)
    expect(pending.contract_no, 'số HĐ tín dụng của khoản R2 (trường riêng)').toBe(contractR2);
    expect(pending.collateral, 'TSĐB của khoản R2 (trường riêng)').toBe(collateralR2);
    // §11.4: kỳ hạn mặc định 12 tháng; lãi suất nhập trên phiếu (8,5) được giữ (so sánh không phụ thuộc dấu phẩy/chấm)
    expect(pending.term_months, 'kỳ hạn mặc định của khoản R2 (12 tháng)').toBe(12);
    expect(Number(String(pending.interest_rate).replace(',', '.')), 'lãi suất khoản R2 (8,5)').toBe(8.5);
    expect.soft(pending.interest_rate, 'lãi suất khoản R2 lưu đúng dạng dấu phẩy "8,5"').toBe('8,5');

    // Tổng của danh sách theo ngân hàng: chờ giải ngân không tính vào dư nợ
    const partnerList = await listLoansApi(staff, cta, { partner_id: bank.id });
    expect(partnerList.totals.outstanding.minor).toBe('0');
    expect(partnerList.totals.pending_count).toBe(1);

    await staff.goto('/ngan-hang/dao-han');
    await expect(pendingTable(staff).locator('tr', { hasText: pending.code })).toHaveCount(1);
    // Ngày trong bảng theo DS (ngày đầy đủ DD/MM/YYYY — docs/02_design_system.md), không hiện dạng ISO yyyy-mm-dd
    // expect.soft: lỗi định dạng không được chặn các bước giải ngân phía dưới của cùng test
    await expect
      .soft(pendingTable(staff).locator('tr', { hasText: pending.code }), 'hạn thanh toán trong mục "Sắp giải ngân" dạng DD/MM/YYYY')
      .toContainText(toDdmmyyyy(pending.maturity_date));
    await expect
      .soft(pendingTable(staff).locator('tr', { hasText: pending.code }), 'mục "Sắp giải ngân" không hiện hạn dạng ISO yyyy-mm-dd')
      .not.toContainText(pending.maturity_date);
    await expect(bankTotalsTable(staff).locator('tr', { hasText: bank.name })).toHaveCount(0);
    await expect(staff.locator('table tr', { hasText: pending.code })).toHaveCount(1);

    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(pending.code);
    await expect(staff.locator('tr', { hasText: pending.code })).toContainText('Chờ giải ngân');

    // Màn chi tiết khoản chờ giải ngân: khối thông tin vay hiện số HĐ tín dụng và TSĐB (§11.4) — [lỗi đã báo]
    await staff.goto(`/ngan-hang/khoan-vay/${pending._id}`);
    await expect(staff.getByText(contractR2, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByText(collateralR2, { exact: true }).first()).toBeVisible();

    // Giải ngân: phiếu thu được duyệt đủ cấp ⇒ tự thực thi ⇒ khoản vay "Đang vay"
    await transitionApi(staff, cta, receipt._id, 'submit');
    receipt.code = (await approveChain({ staff, chief, director, chairman }, cta, receipt._id)).code;
    const active = await waitForLoan(staff, cta, bank.id, (l) => l._id === pending._id && l.status === 'active', 30_000);
    expect(active.disbursed.minor).toBe('30000000');
    expect(active.disbursed_at).toBeTruthy();
    expect(active.outstanding.minor).toBe('30000000');

    await staff.goto('/ngan-hang/dao-han');
    await expect(await bankTotalsRow(staff, bank.name)).toContainText('30.000.000', { timeout: 30_000 });
    await expect(pendingTable(staff).locator('tr', { hasText: pending.code })).toHaveCount(0);
  });

  test('[lỗi đã báo · đường phiếu thu] R2 · phiếu thu đi vay nhập lãi suất "9,5" trên FORM ⇒ khoản vay lưu "9,5" và ô lãi suất khi mở lại vẫn "9,5" (không thành "9.5")', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Lai Phieu Thu');
    await gotoCta(staff, '/thu/moi');
    await expect(staff.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 20_000 });
    await fieldOf(staff, 'Tiêu đề').locator('input').fill(uniq('Thu vay lai E2E'));
    await fieldOf(staff, 'Nội dung / mục đích').locator('textarea').fill('E2E: phiếu thu đi vay, kiểm tra lãi suất');
    await pickPartner(staff, fieldOf(staff, 'Bên nộp tiền'), bank.name);
    await staff.getByLabel('Số tiền', { exact: true }).first().fill('25000000');
    const deadline = fieldOf(staff, 'Hạn thanh toán').locator('input').first();
    await deadline.click();
    await deadline.fill(DEADLINE_UI);
    await deadline.press('Enter');
    await pickSelect(staff, fieldOf(staff, 'Tài khoản đích'), /./);
    // bật "Đây là khoản vay ngân hàng (đi vay)" ⇒ khối điều khoản vay (chế độ mặc định: tạo mới)
    await staff.getByRole('checkbox', { name: /Đây là khoản vay ngân hàng/ }).check();
    const rateInput = fieldOf(staff, 'Lãi suất (%/năm)').locator('input').first();
    await rateInput.fill('9,5');

    // đúng giá trị form GỬI LÊN máy chủ (điều khoản vay của phiếu)
    const posted = staff.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/documents');
    await staff.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    const body = (await posted).postDataJSON() as { options?: { loan?: { terms?: { interest_rate?: string | null } | null } | null } | null };
    // [lỗi đã báo · đường phiếu thu] form gửi "9,5" (không đổi thành "9.5" trước khi gửi)
    expect.soft(body.options?.loan?.terms?.interest_rate, '[lỗi đã báo · đường phiếu thu] điều khoản vay gửi lên: lãi suất "9,5"').toBe('9,5');
    await staff.waitForURL(/\/ho-so\/thu\/[0-9a-f]{24}/, { timeout: 30_000 });
    const id = (staff.url().match(/\/ho-so\/thu\/([0-9a-f]{24})/) ?? [])[1] as string;

    // khoản vay chờ giải ngân được lập từ phiếu: lãi suất lưu đúng dạng "9,5"
    const pending = await waitForLoan(staff, cta, bank.id, (l) => l.status === 'pending_disbursement' && l.principal.minor === '25000000', 30_000);
    expect.soft(pending.interest_rate, '[lỗi đã báo · đường phiếu thu] khoản vay từ phiếu thu lưu lãi suất "9,5", không "9.5"').toBe('9,5');

    // mở lại phiếu (nháp) ⇒ ô "Lãi suất (%/năm)" vẫn hiện "9,5"
    await gotoCta(staff, `/thu/${id}/sua`);
    const rateAgain = fieldOf(staff, 'Lãi suất (%/năm)').locator('input').first();
    await expect(rateAgain).toBeVisible({ timeout: 20_000 });
    await expect.soft(rateAgain, '[lỗi đã báo · đường phiếu thu] mở lại phiếu: ô lãi suất hiện "9,5"').toHaveValue('9,5');
  });

  test('[lỗi đã báo · đường phiếu chi R3] phiếu chi "Vay ngân hàng để chi" nhập lãi suất "9,5" trên FORM ⇒ form gửi "9,5", phiếu lưu và mở lại vẫn "9,5", khoản R3 lưu "9,5" (không thành "9.5")', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await ctaPinned(staff);
    const lender = await createBank(staff, cta, 'NH Lai Phieu Chi');
    const supplier = await createSupplier(staff, cta, 'NCC Lai Phieu Chi');

    await gotoCta(staff, '/chi/moi');
    await expect(staff.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 20_000 });
    await fieldOf(staff, 'Tiêu đề').locator('input').fill(uniq('Chi vay de chi lai E2E'));
    await fieldOf(staff, 'Nội dung / mục đích').locator('textarea').fill('E2E: chi bằng vốn vay ngân hàng, kiểm tra lãi suất');
    await pickPartner(staff, fieldOf(staff, 'Bên nhận tiền'), supplier.name);
    await staff.getByLabel('Số tiền', { exact: true }).first().fill('4000000');
    const deadline = fieldOf(staff, 'Hạn thanh toán').locator('input').first();
    await deadline.click();
    await deadline.fill(DEADLINE_UI);
    await deadline.press('Enter');

    // bật "Vay ngân hàng để chi" ⇒ khối vay: ngân hàng cho vay, TK nhận giải ngân (mặc định cũng là TK nguồn), điều khoản
    await staff.getByRole('checkbox', { name: /Vay ngân hàng để chi/ }).check();
    await pickPartner(staff, fieldOf(staff, 'Ngân hàng cho vay'), lender.name);
    // dropdown của ô đối tác phải đóng hẳn trước khi mở ô TK nhận (tránh khớp nhầm mục của dropdown đang đóng)
    await expect(staff.locator('.ant-select-dropdown:visible'), 'dropdown ô đối tác đã đóng').toHaveCount(0, { timeout: 10_000 });
    await pickSelect(staff, fieldOf(staff, 'Tài khoản nhận giải ngân'), /./);
    await fieldOf(staff, 'Lãi suất (%/năm)').locator('input').first().fill('9,5');

    // đúng giá trị form GỬI LÊN máy chủ (điều khoản vay của phiếu chi)
    const posted = staff.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/documents');
    await staff.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    const body = (await posted).postDataJSON() as { options?: { loan?: { kind?: string; terms?: { interest_rate?: string | null } | null } | null } | null };
    expect(body.options?.loan?.kind, 'phiếu chi gửi khối vay để chi (fund)').toBe('fund');
    // [lỗi đã báo · đường phiếu chi R3] form gửi "9,5" (không đổi thành "9.5" trước khi gửi)
    expect.soft(body.options?.loan?.terms?.interest_rate, '[lỗi đã báo · đường phiếu chi R3] điều khoản vay gửi lên: lãi suất "9,5"').toBe('9,5');
    await staff.waitForURL(/\/ho-so\/chi\/[0-9a-f]{24}/, { timeout: 30_000 });
    const id = (staff.url().match(/\/ho-so\/chi\/([0-9a-f]{24})/) ?? [])[1] as string;

    // phiếu đã lưu: điều khoản vay lưu "9,5"
    const saved = await getVoucherApi(staff, cta, id);
    expect.soft((saved as any).options?.loan?.terms?.interest_rate, '[lỗi đã báo · đường phiếu chi R3] phiếu chi lưu lãi suất "9,5"').toBe('9,5');

    // mở lại phiếu (nháp) ⇒ ô "Lãi suất (%/năm)" vẫn hiện "9,5"
    await gotoCta(staff, `/chi/${id}/sua`);
    const rateAgain = fieldOf(staff, 'Lãi suất (%/năm)').locator('input').first();
    await expect(rateAgain).toBeVisible({ timeout: 20_000 });
    await expect.soft(rateAgain, '[lỗi đã báo · đường phiếu chi R3] mở lại phiếu chi: ô lãi suất hiện "9,5"').toHaveValue('9,5');

    // duyệt đủ cấp ⇒ R3 tạo khoản vay (chờ giải ngân rồi đang vay): lãi suất khoản vay lưu "9,5"
    await transitionApi(staff, cta, id, 'submit');
    await approveChain({ staff, chief, director, chairman }, cta, id);
    const loan = await waitForLoan(staff, cta, lender.id, (l) => l.origin?.rule_code === 'R3' && l.status === 'active', 40_000);
    expect.soft(loan.interest_rate, '[lỗi đã báo · đường phiếu chi R3] khoản vay do R3 tạo lưu lãi suất "9,5"').toBe('9,5');
  });

  test('R2 · "gắn vào khoản vay đã có" khi khoản đã kín sức chứa (gốc đã gán hết) ⇒ lưu phiếu bị chặn ngay, không để lượt R2 lỗi sau khi thực thi', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Suc Chua R2');
    const account = await ctaBankAccount(staff, cta);
    // Phiếu A (R2, 30 triệu, còn nháp) đã gán hết gốc của khoản LA ⇒ LA không còn sức chứa
    await createVoucherApi(
      staff,
      cta,
      incomeBody({ partnerId: bank.id, accountId: account, amountMinor: '30000000', options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank.id } } }),
    );
    const LA = await waitForLoan(staff, cta, bank.id, (l) => l.status === 'pending_disbursement');
    // chờ liên kết giải ngân của phiếu A (bước R2 "link", chạy sau bước tạo khoản vay) có hiệu lực ⇒ LA hết sức chứa
    await expect
      .poll(async () => ((await getLoanApi(staff, cta, LA._id)).disbursement_links as unknown[]).length, { timeout: 20_000, message: 'liên kết giải ngân của phiếu A' })
      .toBe(1);
    // Phiếu B (10 triệu) gắn vào LA: tổng giải ngân không được vượt gốc (§11.4 (b), "Gán thủ công sau") ⇒ phải bị chặn khi lưu
    const attempt = await apiPostRaw(staff, cta, 'documents', {
      company_id: cta.id,
      ...incomeBody({
        partnerId: bank.id,
        accountId: account,
        amountMinor: '10000000',
        options: { loan: { kind: 'borrow', mode: 'existing', lender_partner_id: bank.id, existing_loan_id: LA._id } },
      }),
    });
    expect(attempt.status, 'lưu phiếu gắn khoản đã kín sức chứa phải bị chặn (422), không được lưu rồi để lượt R2 lỗi').toBe(422);
    // cùng quy tắc như gán thủ công: FG-LINK-002 (vượt sức chứa khoản vay)
    expect(attempt.body.code, 'mã lỗi giống gán thủ công (FG-LINK-002)').toBe('FG-LINK-002');
    // phiếu bị chặn không để lại dấu vết: LA chỉ còn liên kết giải ngân của phiếu A, không có khoản vay nào khác
    const afterLA = await getLoanApi(staff, cta, LA._id);
    expect(afterLA.disbursement_links as unknown[], 'LA chỉ còn liên kết giải ngân của phiếu A').toHaveLength(1);
    expect(afterLA.status).toBe('pending_disbursement');
    expect((await listLoansApi(staff, cta, { partner_id: bank.id })).items, 'không sinh thêm khoản vay cho ngân hàng này').toHaveLength(1);
  });

  test('R6 · hủy phiếu thu đi vay còn nháp → khoản chờ giải ngân chuyển "Đã huỷ"', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Huy Phieu');
    const account = await ctaBankAccount(staff, cta);

    const receipt = await createVoucherApi(
      staff,
      cta,
      incomeBody({ partnerId: bank.id, accountId: account, amountMinor: '12000000', options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank.id } } }),
    );
    const pending = await waitForLoan(staff, cta, bank.id, (l) => l.status === 'pending_disbursement');

    await transitionApi(staff, cta, receipt._id, 'cancel', { opinion: 'E2E huỷ phiếu nháp để kiểm tra R6' });
    const cancelled = await waitForLoan(staff, cta, bank.id, (l) => l._id === pending._id && l.status === 'cancelled', 30_000);
    expect(cancelled.outstanding.minor).toBe('0');

    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(pending.code);
    await expect(staff.locator('tr', { hasText: pending.code })).toContainText('Đã huỷ');
  });

  test('R6 · phiếu thu đi vay bị TỪ CHỐI khi đang duyệt → khoản chờ giải ngân chuyển "Đã huỷ"', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Tu Choi');
    const account = await ctaBankAccount(staff, cta);
    const receipt = await createVoucherApi(
      staff,
      cta,
      incomeBody({ partnerId: bank.id, accountId: account, amountMinor: '8000000', options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank.id } } }),
    );
    const pending = await waitForLoan(staff, cta, bank.id, (l) => l.status === 'pending_disbursement');
    await transitionApi(staff, cta, receipt._id, 'submit');

    // Kế toán trưởng từ chối hẳn phiếu (lý do đủ dài)
    const cur = await getVoucherApi(chief, cta, receipt._id);
    await apiPost(chief, cta, `documents/${receipt._id}/transition`, { action: 'reject', if_match: cur.version, request_id: randomUUID(), reason: LONG_REASON });
    expect((await getVoucherApi(staff, cta, receipt._id)).status).toBe('rejected');

    const cancelled = await waitForLoan(staff, cta, bank.id, (l) => l._id === pending._id && l.status === 'cancelled', 30_000);
    expect(cancelled.outstanding.minor).toBe('0');
    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(pending.code);
    await expect(staff.locator('tr', { hasText: pending.code })).toContainText('Đã huỷ');
  });

  test('US-LOAN-02 · [đáo hạn] mức cảnh báo theo số ngày và dư nợ theo ngân hàng 7 / 30 ngày (góc nhìn Giám đốc)', async ({ as }) => {
    const staff = await as('staff');
    const director = await as('director');
    const cta = await ctaPinned(staff);
    await ctaPinned(director);
    const bank = await createBank(staff, cta, 'NH Dao Han');
    const today = vnToday();
    // hạn tính từ hôm nay; ngày giải ngân lùi 30 ngày để hạn hôm nay vẫn hợp lệ
    const plan = [
      { offset: 0, principal: '10000000', expectLevel: 3, tone: 'danger', label: '⛔ hôm nay' },
      { offset: 2, principal: '20000000', expectLevel: 3, tone: 'danger', label: '⛔ còn 2 ngày' },
      { offset: 5, principal: '30000000', expectLevel: 2, tone: 'warning', label: '⚠ còn 5 ngày' },
      { offset: 20, principal: '40000000', expectLevel: 1, tone: 'attention', label: '▲ còn 20 ngày' },
      { offset: 60, principal: '50000000', expectLevel: 0, tone: 'neutral', label: 'còn 2 tháng' },
      // quá hạn 15 ngày, còn dư nợ ⇒ trạng thái "Quá hạn", vẫn trong dư nợ và bảng đáo hạn (§10.2)
      { offset: -15, principal: '5000000', expectLevel: 3, tone: 'danger', label: '⛔ qua hạn 15 ngày' },
    ];
    const created: { code?: string; id: string; offset: number }[] = [];
    for (const p of plan) {
      const r = await createLoanApi(staff, cta, {
        partner_id: bank.id,
        amount: { amount_minor: p.principal, currency: 'VND' },
        disbursed_date: addDays(today, -30),
        maturity_date: addDays(today, p.offset),
        interest_rate: '0',
        contract_no: uniq('HDTD DH').slice(0, 60),
      });
      created.push({ id: r._id, offset: p.offset });
    }

    const list = await listLoansApi(director, cta, { partner_id: bank.id });
    expect(list.items).toHaveLength(plan.length);
    for (const p of plan) {
      const loan = list.items.find((l) => l.days_to_due === p.offset) as LoanApi;
      expect(loan, `khoản đáo hạn sau ${p.offset} ngày`).toBeTruthy();
      expect(loan.status, `trạng thái khoản đáo hạn sau ${p.offset} ngày`).toBe(p.offset < 0 ? 'overdue' : 'active');
      expect(loan.warning?.level, `mức cảnh báo ${p.offset} ngày`).toBe(p.expectLevel);
      expect(loan.warning?.tone, `tone ${p.offset} ngày`).toBe(p.tone);
      expect(loan.warning?.label, `nhãn ${p.offset} ngày`).toBe(p.label);
      created.find((c) => c.offset === p.offset)!.code = loan.code;
    }
    // dư nợ = đang vay + quá hạn: 10 + 20 + 30 + 40 + 50 + 5 (quá hạn) = 155 triệu
    expect(list.totals.outstanding.minor).toBe('155000000');

    await director.goto('/ngan-hang/dao-han');
    // trang nặng (nhiều ngân hàng, dev server có thể chậm ở lần tải đầu của phiên): chờ tiêu đề rồi mới kiểm tra dòng
    await expect(director.getByRole('heading', { name: 'Bảng đáo hạn' })).toBeVisible({ timeout: 30_000 });
    const totals = await bankTotalsRow(director, bank.name);
    await expect(totals).toBeVisible({ timeout: 30_000 });
    const cells = totals.locator('td');
    await expect(cells.nth(1)).toHaveText('6');
    await expect(cells.nth(2)).toContainText('155.000.000');
    // đáo hạn ≤ 7 ngày (gồm quá hạn): 10 + 20 + 30 + 5 = 65 triệu; ≤ 30 ngày: + 40 = 105 triệu
    await expect(cells.nth(3)).toContainText('65.000.000');
    await expect(cells.nth(4)).toContainText('105.000.000');

    // Bảng đáo hạn mặc định "30 ngày": 5 khoản (gồm 1 quá hạn; không có khoản 60 ngày)
    for (const p of plan.filter((x) => x.offset <= 30)) {
      const code = created.find((c) => c.offset === p.offset)!.code as string;
      const row = director.locator('table tr', { hasText: code });
      await expect(row).toHaveCount(1);
      const chip = row.getByRole('status').first();
      await expect(chip, `nhãn đáo hạn ${p.offset} ngày`).toHaveAttribute('aria-label', p.label);
      // [lỗi đã báo] chữ hiển thị chỉ có MỘT biểu tượng + số ngày (không "⛔⛔ …", "▲▲ …")
      await expect(chip, `chữ hiển thị đáo hạn ${p.offset} ngày`).toHaveText(p.label);
    }
    await expect(director.locator('table tr', { hasText: created.find((c) => c.offset === 60)!.code as string })).toHaveCount(0);

    // [lỗi đã báo] cùng chip ở danh sách khoản vay và màn chi tiết: một biểu tượng
    const twoDay = created.find((c) => c.offset === 2)!;
    await director.goto('/ngan-hang/khoan-vay');
    await director.getByPlaceholder(SEARCH_PLACEHOLDER).fill(twoDay.code as string);
    await expect(director.locator('tr', { hasText: twoDay.code as string }).getByRole('status').first()).toHaveText('⛔ còn 2 ngày');
    await director.goto(`/ngan-hang/khoan-vay/${twoDay.id}`);
    await expect(director.getByRole('status').filter({ hasText: 'còn 2 ngày' }).first()).toHaveText('⛔ còn 2 ngày', { timeout: 20_000 });

    // khoản quá hạn: trạng thái "Quá hạn" và chip "⛔ qua hạn 15 ngày" (một biểu tượng)
    const overdueLoan = created.find((c) => c.offset === -15)!;
    await director.goto('/ngan-hang/khoan-vay');
    await director.getByPlaceholder(SEARCH_PLACEHOLDER).fill(overdueLoan.code as string);
    const overdueRow = director.locator('tr', { hasText: overdueLoan.code as string });
    await expect(overdueRow).toContainText('Quá hạn');
    await expect(overdueRow.getByRole('status').first()).toHaveText('⛔ qua hạn 15 ngày');
  });

  test('US-LOAN-02 · mức cảnh báo tại biên (§10.1): 3/4 ngày, 7/8 ngày, 30/31 ngày', async ({ as }) => {
    const staff = await as('staff');
    const director = await as('director');
    const cta = await ctaPinned(staff);
    await ctaPinned(director);
    const bank = await createBank(staff, cta, 'NH Bien Dao Han');
    const today = vnToday();
    // hôm nay / ≤3 ngày: đỏ (3); 4–7 ngày: cam (2); 8–30 ngày: vàng (1); quá 30 ngày: không cảnh báo (0)
    const edges = [
      { offset: 3, level: 3, tone: 'danger' },
      { offset: 4, level: 2, tone: 'warning' },
      { offset: 7, level: 2, tone: 'warning' },
      { offset: 8, level: 1, tone: 'attention' },
      { offset: 30, level: 1, tone: 'attention' },
      { offset: 31, level: 0, tone: 'neutral' },
    ];
    const codeByOffset = new Map<number, string>();
    for (const e of edges) {
      const r = await createLoanApi(staff, cta, {
        partner_id: bank.id,
        amount: { amount_minor: '1000000', currency: 'VND' },
        disbursed_date: addDays(today, -30),
        maturity_date: addDays(today, e.offset),
        interest_rate: '0',
        contract_no: uniq('HDTD BIEN').slice(0, 60),
      });
      codeByOffset.set(e.offset, (await getLoanApi(staff, cta, r._id)).code);
    }
    const list = await listLoansApi(director, cta, { partner_id: bank.id });
    for (const e of edges) {
      const loan = list.items.find((l) => l.code === codeByOffset.get(e.offset)) as LoanApi | undefined;
      expect(loan, `khoản đáo hạn sau ${e.offset} ngày`).toBeTruthy();
      expect(loan!.days_to_due, `số ngày tới đáo hạn (${e.offset})`).toBe(e.offset);
      expect(loan!.warning?.level, `mức cảnh báo ${e.offset} ngày`).toBe(e.level);
      expect(loan!.warning?.tone, `tone ${e.offset} ngày`).toBe(e.tone);
    }
  });

  /* ------------------------------ LOAN-03 · trả nợ tách gốc / lãi / phí ------------------------------ */

  test('US-LOAN-03 · gán phiếu chi trả nợ tách gốc / lãi / phí — chỉ phần gốc trừ dư nợ, và chỉ sau khi thực thi', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Tra No');
    const account = await ctaBankAccount(staff, cta);
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '10000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -30),
      maturity_date: addDays(vnToday(), 200),
      interest_rate: '10',
      term_months: 12,
    });
    const pay = await createVoucherApi(staff, cta, spendBody({ partnerId: bank.id, accountId: account, amountMinor: '3000000', title: uniq('Tra no ky 1') }));
    await transitionApi(staff, cta, pay._id, 'submit');
    pay.code = (await approveChain({ staff, chief, director, chairman }, cta, pay._id)).code;

    // gốc 2.750.000 + lãi 200.000 + phí 50.000 = 3.000.000
    const link = await apiPost(staff, cta, `bank-debts/${loan._id}/repayments`, {
      document_id: pay._id,
      amount_minor: '3000000',
      split: { principal: '2750000', interest: '200000', fee: '50000' },
    });
    expect(link._id).toBeTruthy();

    // Chưa thực thi ⇒ dư nợ chưa đổi
    const before = await getLoanApi(staff, cta, loan._id);
    expect(before.outstanding.minor).toBe('10000000');
    expect(before.repaid.minor).toBe('0');

    // Gán sai tổng (gốc + lãi + phí ≠ số tiền) bị chặn
    const mismatch = await apiPostRaw(staff, cta, `bank-debts/${loan._id}/repayments`, {
      document_id: pay._id,
      amount_minor: '3000000',
      split: { principal: '1000000', interest: '200000', fee: '50000' },
    });
    expect(mismatch.status).toBe(422);

    await payVoucherApi(staff, cta, pay._id);
    const after = await getLoanApi(staff, cta, loan._id);
    expect(after.repaid.minor).toBe('2750000');
    expect(after.repaid_interest.minor).toBe('200000');
    expect(after.repaid_fee.minor).toBe('50000');
    expect(after.outstanding.minor).toBe('7250000');
    expect(after.status).toBe('active');

    // Danh sách và bảng đáo hạn hiển thị đúng số (không cần màn chi tiết)
    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(loan.code as string);
    const row = staff.locator('tr', { hasText: loan.code as string });
    await expect(row).toContainText('2.750.000');
    await expect(row).toContainText('7.250.000');
    await staff.goto('/ngan-hang/dao-han');
    // trang đáo hạn dựng cả bảng dư nợ (mọi ngân hàng trong DB test, >1.000 dòng khi đầy dữ liệu) ⇒ chờ lâu hơn mặc định 10 s
    await expect(await bankTotalsRow(staff, bank.name)).toContainText('7.250.000', { timeout: 30_000 });
  });

  test('US-LOAN-03 · màn chi tiết: gán phiếu chi trả nợ (tách lãi/phí) rồi thực thi → "Đã trừ dư nợ"', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Tra No UI');
    const account = await ctaBankAccount(staff, cta);
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '10000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -30),
      maturity_date: addDays(vnToday(), 200),
      interest_rate: '10',
    });
    const pay = await createVoucherApi(staff, cta, spendBody({ partnerId: bank.id, accountId: account, amountMinor: '3000000' }));
    await transitionApi(staff, cta, pay._id, 'submit');
    pay.code = (await approveChain({ staff, chief, director, chairman }, cta, pay._id)).code;

    await staff.goto(`/ngan-hang/khoan-vay/${loan._id}`);
    await staff.getByRole('button', { name: '+ Gán phiếu chi trả nợ' }).click();
    const dlg = openDialog(staff);
    await dlg.getByPlaceholder('VD: PC-2026 hoặc nội dung').fill(pay.code);
    await dlg.locator('tr', { hasText: pay.code }).getByRole('button', { name: 'Chọn' }).click();
    await expect(dlg.getByText('Gán phiếu chi trả nợ', { exact: true })).toBeVisible();
    await fieldInput(staff, 'Trong đó: lãi').fill('200000');
    await fieldInput(staff, 'Trong đó: phí').fill('50000');
    await expect(dlg).toContainText('2.750.000');
    await dlg.getByRole('button', { name: 'Gán phiếu trả nợ' }).click();
    await expect(staff.getByText('Đã gán phiếu chi trả nợ')).toBeVisible();
    await expect(staff.locator('tr', { hasText: pay.code })).toContainText('Chờ thực thi');

    await payVoucherApi(staff, cta, pay._id);
    await staff.reload();
    await expect(staff.locator('tr', { hasText: pay.code })).toContainText('Đã trừ dư nợ');
    await expect(staff.getByText('2.750.000 ₫').first()).toBeVisible();
    await expect(staff.getByText('7.250.000 ₫').first()).toBeVisible();
  });

  test('US-LOAN-03 · trả đủ gốc ⇒ "Tất toán"; lưu trữ được khoản đã tất toán', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Tat Toan');
    const account = await ctaBankAccount(staff, cta);
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '10000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -30),
      maturity_date: addDays(vnToday(), 200),
      interest_rate: '0',
    });
    const pay = await createVoucherApi(staff, cta, spendBody({ partnerId: bank.id, accountId: account, amountMinor: '10000000' }));
    await transitionApi(staff, cta, pay._id, 'submit');
    pay.code = (await approveChain({ staff, chief, director, chairman }, cta, pay._id)).code;
    await apiPost(staff, cta, `bank-debts/${loan._id}/repayments`, { document_id: pay._id, amount_minor: '10000000', split: { principal: '10000000', interest: '0', fee: '0' } });
    await payVoucherApi(staff, cta, pay._id);

    const settled = await getLoanApi(staff, cta, loan._id);
    expect(settled.outstanding.minor).toBe('0');
    expect(settled.status).toBe('settled');

    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(loan.code as string);
    await expect(staff.locator('tr', { hasText: loan.code as string })).toContainText('Tất toán');

    const archived = await apiPostRaw(staff, cta, `bank-debts/${loan._id}/archive`, {});
    expect(archived.status).toBe(200);
    const after = await getLoanApi(staff, cta, loan._id);
    expect(after.status).toBe('archived');
    await staff.reload();
    // danh sách phân trang (trang đầu 50 khoản) và ô tìm không lưu trên URL: tìm lại theo mã sau khi tải lại
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(loan.code as string);
    await expect(staff.locator('tr', { hasText: loan.code as string })).toContainText('Lưu trữ');
  });

  /* ------------------------------ US-AUTO-02 · gán phiếu giải ngân ------------------------------ */

  test('US-AUTO-02 · gán phiếu thu giải ngân vào khoản vay tạo tay (chỉ phiếu cùng ngân hàng)', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Gan Giai Ngan');
    const otherBank = await createBank(staff, cta, 'NH Khac');
    const account = await ctaBankAccount(staff, cta);
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '20000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -30),
      maturity_date: addDays(vnToday(), 300),
      interest_rate: '9',
    });
    const mine = await createVoucherApi(staff, cta, incomeBody({ partnerId: bank.id, accountId: account, amountMinor: '20000000', title: uniq('Thu giai ngan dung NH') }));
    await transitionApi(staff, cta, mine._id, 'submit');
    mine.code = (await approveChain({ staff, chief, director, chairman }, cta, mine._id)).code;
    const foreign = await createVoucherApi(staff, cta, incomeBody({ partnerId: otherBank.id, accountId: account, amountMinor: '5000000', title: uniq('Thu sai NH') }));
    await transitionApi(staff, cta, foreign._id, 'submit');
    foreign.code = (await approveChain({ staff, chief, director, chairman }, cta, foreign._id)).code;

    await staff.goto(`/ngan-hang/khoan-vay/${loan._id}`);
    await staff.getByRole('button', { name: '+ Gán phiếu giải ngân' }).click();
    const dlg = openDialog(staff);
    await expect(dlg.locator('tr', { hasText: mine.code })).toHaveCount(1);
    await expect(dlg.locator('tr', { hasText: foreign.code })).toHaveCount(0);
    await dlg.locator('tr', { hasText: mine.code }).getByRole('button', { name: 'Gán' }).click();
    await expect(staff.getByText('Đã gán phiếu giải ngân')).toBeVisible();

    const after = await getLoanApi(staff, cta, loan._id);
    const linked = (after.disbursement_links as { document_code: string; executed: boolean }[]).map((l) => l.document_code);
    expect(linked).toContain(mine.code);
    expect(after.status).toBe('active');
    expect(after.disbursed.minor).toBe('20000000');
    await staff.reload();
    await expect(staff.locator('tr', { hasText: mine.code })).toContainText('Đã giải ngân');
  });

  /* ------------------------------ US-AUTO-08 · chuỗi khoản vay (R3) ------------------------------ */

  test('US-AUTO-08 · khoản vay R3: phiếu chi được tài trợ + phiếu thu giải ngân tự sinh + phiếu trả nợ', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await ctaPinned(staff);
    const lender = await createBank(staff, cta, 'NH Vay De Chi');
    const supplier = await createSupplier(staff, cta, 'NCC Vay De Chi');
    const account = await ctaBankAccount(staff, cta);

    // Phiếu chi "vay ngân hàng để chi" (R3) — duyệt đủ cấp ⇒ tự sinh khoản vay + phiếu thu giải ngân đã thực thi
    const contractR3 = uniq('HDTD R3').slice(0, 60);
    const collateralR3 = uniq('TSĐB R3');
    const funded = await createVoucherApi(
      staff,
      cta,
      spendBody({
        partnerId: supplier.id,
        accountId: account,
        amountMinor: '4000000',
        title: uniq('Chi bang von vay'),
        options: {
          loan: { kind: 'fund', mode: 'new', lender_partner_id: lender.id, receive_account_id: account, terms: { contract_no: contractR3, interest_rate: '9,5', term_months: 12, collateral: collateralR3 } },
        },
      }),
    );
    await transitionApi(staff, cta, funded._id, 'submit');
    funded.code = (await approveChain({ staff, chief, director, chairman }, cta, funded._id)).code;

    const loan = await waitForLoan(staff, cta, lender.id, (l) => l.origin?.rule_code === 'R3' && l.status === 'active', 40_000);
    expect(loan.principal.minor).toBe('4000000');
    // [lỗi đã báo] số HĐ tín dụng và TSĐB của khoản vay do R3 tạo phải nằm ở trường riêng (§10.1, §11.5)
    expect(loan.contract_no, 'số HĐ tín dụng của khoản vay do R3 tạo (trường riêng)').toBe(contractR3);
    expect(loan.collateral, 'TSĐB của khoản vay do R3 tạo (trường riêng)').toBe(collateralR3);
    expect(loan.disbursed.minor).toBe('4000000');
    expect(loan.origin.kind).toBe('automation');
    // khoản do R3 tạo lưu lãi suất đúng dạng dấu phẩy "9,5" (điều khoản nhập trên phiếu chi)
    expect.soft(loan.interest_rate, 'khoản R3 lưu lãi suất "9,5"').toBe('9,5');

    // Phiếu trả nợ đầu tiên (chưa thực thi)
    const repay = await createVoucherApi(staff, cta, spendBody({ partnerId: lender.id, accountId: account, amountMinor: '1000000', title: uniq('Tra no R3') }));
    await transitionApi(staff, cta, repay._id, 'submit');
    repay.code = (await approveChain({ staff, chief, director, chairman }, cta, repay._id)).code;
    await apiPost(staff, cta, `bank-debts/${loan._id}/repayments`, { document_id: repay._id, amount_minor: '1000000' });

    const detail = await getLoanApi(staff, cta, loan._id);
    expect(detail.funded_by_links).toHaveLength(1);
    expect((detail.funded_by_links as { document_code: string }[])[0]!.document_code).toBe(funded.code);
    expect(detail.disbursement_links).toHaveLength(1);
    expect((detail.disbursement_links as { executed: boolean; origin: string; rule_code: string }[])[0]).toMatchObject({ executed: true, origin: 'automation', rule_code: 'R3' });
    expect((detail.chain as any).repayments).toHaveLength(1);
    // [lỗi đã báo] chuỗi chứng từ phải là danh sách thật (không được null)
    expect(Array.isArray(detail.chain.funded_by), 'chain.funded_by phải là danh sách').toBe(true);
    expect(Array.isArray(detail.chain.disbursements), 'chain.disbursements phải là danh sách').toBe(true);
    expect(detail.chain.funded_by).toHaveLength(1);
    expect(detail.chain.disbursements).toHaveLength(1);

    await staff.goto(`/ngan-hang/khoan-vay/${loan._id}`);
    // Khối thông tin vay (§11.4): số HĐ tín dụng và TSĐB hiển thị trên màn chi tiết
    await expect(staff.getByText(contractR3, { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByText(collateralR3, { exact: true }).first()).toBeVisible();
    const fundedCard = staff.getByText('Phiếu chi được tài trợ', { exact: false }).first().locator('xpath=ancestor::*[.//table][1]');
    await expect(fundedCard.locator('tr', { hasText: funded.code })).toHaveCount(1);
    await expect(staff.locator('tr', { hasText: (detail.disbursement_links as { document_code: string }[])[0]!.document_code })).toContainText('Đã giải ngân');
    await expect(staff.getByText('Tự động · R3').first()).toBeVisible();
    await expect(staff.getByText(/Tự động sinh từ quy trình R3/)).toBeVisible();
    await expect(staff.locator('tr', { hasText: repay.code })).toContainText('Chờ thực thi');

    // US-AUTO-04: phiếu chi được tài trợ hiện rõ ngân hàng cho vay và số tiền vay (khối "Chi bằng vốn vay …")
    await staff.goto(`/ho-so/chi/${funded._id}`);
    await expect(staff.getByText(`Chi bằng vốn vay ${lender.name}`, { exact: false }).first()).toBeVisible();

    // Kiểm tra phòng ngừa (đang đạt): lãi suất trong danh sách theo quy ước VN (dấu phẩy thập phân, DS §4) với khoản R3 nhập "9,5"
    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(loan.code as string);
    const r3Row = staff.locator('tr', { hasText: loan.code as string });
    await expect.soft(r3Row, 'lãi suất khoản R3 hiện dấu phẩy "9,5"').toContainText('9,5');
    await expect.soft(r3Row, 'lãi suất khoản R3 không hiện dấu chấm "9.5 %"').not.toContainText('9.5 %');
  });

  /* ------------------------------ LOAN-04 · đảo hạn ------------------------------ */

  test('US-LOAN-04 · lập phương án đảo hạn (KTV) → duyệt đủ cấp → cập nhật kết quả (Giám đốc) → khoản vay đổi hạn, HĐ, lãi, hạn mức', async ({ as }) => {
    // Luồng dài (lập phương án → duyệt đủ cấp → ghi kết quả → kiểm tra quyền, lịch sử, bảng đáo hạn): 90 s mặc định không đủ khi máy chủ bận.
    test.setTimeout(180_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Dao Han');
    const account = await ctaBankAccount(staff, cta);
    const today = vnToday();
    const oldMaturity = addDays(today, 20);
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '30000000', currency: 'VND' },
      disbursed_date: addDays(today, -60),
      maturity_date: oldMaturity,
      // lãi cũ 8 (khác lãi mới 9,5 nhập ở kết quả) để dòng "Lãi suất: trước → sau" trong lịch sử thể hiện đổi lãi
      interest_rate: '8',
      contract_no: 'HDTD-CU-001',
    });
    const loanCode = (await getLoanApi(staff, cta, loan._id)).code;

    // 1) KTV lập phương án đảo hạn từ bảng đáo hạn
    await staff.goto('/ngan-hang/dao-han');
    await staff.locator('a', { hasText: '+ Lập phương án đảo hạn' }).first().click();
    await expect(staff).toHaveURL(/\/ngan-hang\/dao-han\/phuong-an\/moi/);
    const picker = fieldInput(staff, /^Ngân hàng$/);
    await picker.click();
    await picker.fill(bank.name);
    await staff.locator('.ant-select-item-option', { hasText: bank.name }).first().click();
    await fieldInput(staff, 'Khoản vay đang đảo hạn').click();
    // [lỗi mới, cùng loại với "Sắp giải ngân"] nhãn khoản đảo hạn hiện ngày DD/MM/YYYY, không hiện ISO yyyy-mm-dd
    const loanOption = staff.locator('.ant-select-item-option', { hasText: loanCode }).first();
    await expect.soft(loanOption, 'nhãn khoản đảo hạn: đáo hạn dạng DD/MM/YYYY').toContainText(toDdmmyyyy(oldMaturity));
    await expect.soft(loanOption, 'nhãn khoản đảo hạn: không hiện ISO yyyy-mm-dd').not.toContainText(oldMaturity);
    await loanOption.click();
    await fieldInput(staff, 'Số tiền *').fill('30000000');
    const deadline = fieldInput(staff, 'Hạn thanh toán (deadline)');
    await deadline.click();
    await deadline.fill(`${toDdmmyyyy(today)} 09:00`);
    await deadline.press('Enter');
    await staff.keyboard.press('Escape').catch(() => undefined);
    await fieldInput(staff, 'Nội dung / mục đích').fill('E2E: đảo hạn khoản vay trước khi đến hạn');
    await fieldInput(staff, 'Tài khoản nguồn').click();
    await staff.locator('.ant-select-item-option', { hasText: 'mbb' }).first().click();
    const newMaturity = addDays(oldMaturity, 365);
    await typeDate(staff, 'Ngày đáo hạn mới', newMaturity);
    await fieldInput(staff, 'Phương án đảo hạn', 'textarea').fill('Gia hạn 12 tháng, giữ nguyên TSĐB');
    await fieldInput(staff, 'Lãi suất mới (%/năm)').fill('10');
    await staff.getByText('Gửi duyệt ngay sau khi tạo').click();
    await staff.getByRole('button', { name: 'Tạo & gửi duyệt' }).click();
    await expect(staff).toHaveURL(/\/ho-so\/dao-han\/[0-9a-f]{24}/, { timeout: 20_000 });
    const docId = staff.url().split('/').pop() as string;

    // 2) Duyệt đủ cấp (KTT → GĐ → Chủ tịch theo ma trận CTA)
    const approved = await approveChain({ staff, chief, director, chairman }, cta, docId);
    expect(approved.status).toBe('approved');

    // 3) Bảng đáo hạn: phương án đã chuẩn bị
    await staff.goto('/ngan-hang/dao-han');
    await expect(staff.locator('table tr', { hasText: loanCode })).toContainText('đã chuẩn bị');

    // 4) Giám đốc ghi kết quả thực hiện (RENEW-04)
    const newContract = uniq('HDTD-MOI').slice(0, 60);
    await ctaPinned(director);
    await director.goto(`/ho-so/dao-han/${docId}`);
    await expect(director.getByText('Phương án đảo hạn', { exact: true }).first()).toBeVisible();
    // [lỗi mới] ô ngày của kết quả đảo hạn: DS §7.8 — ô ngày theo DD/MM/YYYY, không bắt gõ định dạng kỹ thuật YYYY-MM-DD
    await expect.soft(fieldInput(director, 'Ngày thực hiện'), '[lỗi mới] ô "Ngày thực hiện" không dùng placeholder YYYY-MM-DD').not.toHaveAttribute('placeholder', 'YYYY-MM-DD');
    await expect.soft(fieldInput(director, 'Ngày đáo hạn mới'), '[lỗi mới] ô "Ngày đáo hạn mới" không dùng placeholder YYYY-MM-DD').not.toHaveAttribute('placeholder', 'YYYY-MM-DD');
    await expect.soft(fieldInput(director, 'Ngày đáo hạn mới'), '[lỗi mới] giá trị đề xuất của "Ngày đáo hạn mới" hiện DD/MM/YYYY, không hiện ISO').not.toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    // [lỗi đã báo] ô ngày là DatePicker DD/MM/YYYY: placeholder DD/MM/YYYY và giá trị đề xuất = ngày đáo hạn mới của phương án
    await expect.soft(fieldInput(director, 'Ngày đáo hạn mới'), '[lỗi đã báo] placeholder ô "Ngày đáo hạn mới" là DD/MM/YYYY').toHaveAttribute('placeholder', 'DD/MM/YYYY');
    await expect.soft(fieldInput(director, 'Ngày đáo hạn mới'), '[lỗi đã báo] giá trị đề xuất hiện đúng DD/MM/YYYY').toHaveValue(toDdmmyyyy(newMaturity));
    // ô ngày là DatePicker DD/MM/YYYY (DS §7.8): gõ đúng định dạng hiển thị qua typeDate
    await typeDate(director, 'Ngày thực hiện', today);
    await typeDate(director, 'Ngày đáo hạn mới', newMaturity);
    await fieldInput(director, 'Số hợp đồng mới').fill(newContract);
    await fieldInput(director, 'Hạn mức mới').fill('40000000');
    // [lỗi đã báo · vòng 4] "9,555" (3 chữ số thập phân) bị chặn: form báo lỗi ngay, không ghi kết quả
    await fieldInput(director, 'Lãi suất mới (%/năm) *').fill('9,555');
    await director.getByRole('button', { name: 'Lưu kết quả thực hiện' }).click();
    await expect(director.getByText('Lãi suất mới không hợp lệ'), '[lỗi đã báo · vòng 4] ô kết quả đảo hạn báo lỗi khi nhập "9,555"').toBeVisible();
    await expect(director.getByText('Đã cập nhật kết quả đảo hạn'), 'không được báo đã ghi kết quả khi lãi suất sai').toHaveCount(0);
    // máy chủ cũng từ chối (422) — kiểm trước khi ghi, không đổi trạng thái phiếu
    const curDoc = await getVoucherApi(director, cta, docId);
    const badResult = await apiPostRaw(director, cta, `documents/${docId}/rollover-result`, {
      done_at: today,
      new_maturity_date: newMaturity,
      new_contract_code: 'HD-SAI-4SO',
      new_limit: { amount_minor: '40000000', currency: 'VND' },
      new_rate: '9,555',
      actual_fee: { amount_minor: '0', currency: 'VND' },
      if_match: curDoc.version,
      request_id: randomUUID(),
    });
    expect(badResult.status, '[lỗi đã báo · vòng 4] máy chủ từ chối kết quả đảo hạn "9,555" (422)').toBe(422);
    expect(String(badResult.body?.detail ?? ''), 'thông báo nêu quy tắc 2 chữ số thập phân').toContain('2 chữ số thập phân');
    // [lỗi đã báo] lãi suất nhập "9,5" phải được gửi và lưu đúng dạng dấu phẩy
    await fieldInput(director, 'Lãi suất mới (%/năm) *').fill('9,5');
    await fieldInput(director, 'Phí thực tế').fill('500000');
    await director.getByRole('button', { name: 'Lưu kết quả thực hiện' }).click();
    await expect(director.getByText('Đã cập nhật kết quả đảo hạn')).toBeVisible();
    // [lỗi đã báo · kết quả đảo hạn] mở lại phiếu ⇒ ô "Lãi suất mới (%/năm)" vẫn hiện "9,5" (không thành "9.5")
    await director.goto(`/ho-so/dao-han/${docId}`);
    await expect.soft(fieldInput(director, 'Lãi suất mới (%/năm) *'), '[lỗi đã báo · kết quả đảo hạn] mở lại: ô lãi suất mới hiện "9,5"').toHaveValue('9,5', { timeout: 20_000 });

    // 5) Khoản vay được cập nhật: hạn mới, HĐ mới, lãi mới, hạn mức mới; gốc không đổi
    const updated = await getLoanApi(staff, cta, loan._id);
    expect(updated.maturity_date).toBe(newMaturity);
    expect(updated.contract_no).toBe(newContract);
    expect(Number(String(updated.interest_rate).replace(',', '.'))).toBe(9.5);
    // [lỗi đã báo] khoản vay và kết quả đảo hạn lưu lãi suất đúng dạng dấu phẩy "9,5" (không "9.5")
    expect.soft(updated.interest_rate, '[lỗi đã báo] lãi suất khoản vay sau đảo hạn lưu "9,5"').toBe('9,5');
    const docAfter = await getVoucherApi(staff, cta, docId);
    expect.soft((docAfter as any).rollover?.result?.new_rate, '[lỗi đã báo] kết quả đảo hạn lưu new_rate "9,5"').toBe('9,5');
    expect(updated.credit_limit.minor).toBe('40000000');
    expect(updated.principal.minor).toBe('30000000');
    expect(updated.status).toBe('active');
    expect((updated.history as { action: string }[]).some((h) => h.action === 'rollover_result')).toBe(true);

    // [lỗi mới, cùng loại với "Sắp giải ngân"] dòng "✓ Đã thực hiện … đáo hạn mới …" hiện cho người KHÔNG có quyền ghi kết quả
    // (rollover:act). Kế toán viên không có rollover:act ⇒ thấy phần tóm tắt thay vì form (RolloverResultCard: canSubmit = doc.can.rollover_result).
    // Ngày phải dạng DD/MM/YYYY, không ISO yyyy-mm-dd
    await gotoCta(staff, `/ho-so/dao-han/${docId}`);
    const resultLine = staff.getByText(/Đã thực hiện.*đáo hạn mới/).first();
    await expect(staff.getByRole('button', { name: 'Lưu kết quả thực hiện' }), 'KTV không có rollover:act: không thấy form ghi kết quả').toHaveCount(0);
    await expect.soft(resultLine, 'dòng kết quả (KTV): ngày thực hiện DD/MM/YYYY').toContainText(toDdmmyyyy(today));
    await expect.soft(resultLine, 'dòng kết quả (KTV): ngày đáo hạn mới DD/MM/YYYY').toContainText(toDdmmyyyy(newMaturity));
    await expect.soft(resultLine, 'dòng kết quả (KTV): không hiện ISO yyyy-mm-dd').not.toContainText(newMaturity);
    await expect.soft(resultLine, 'dòng kết quả (KTV): đủ "Đã thực hiện DD/MM/YYYY · đáo hạn mới DD/MM/YYYY"').toContainText(`Đã thực hiện ${toDdmmyyyy(today)} · đáo hạn mới ${toDdmmyyyy(newMaturity)}`);
    await expect.soft(resultLine, 'dòng kết quả (KTV): không hiện ISO của ngày thực hiện').not.toContainText(today);
    // [lỗi đã báo] lãi suất trong dòng kết quả theo quy ước VN: "LS 9,5%/năm"
    await expect.soft(resultLine, '[lỗi đã báo] dòng kết quả (KTV): lãi suất "LS 9,5%/năm"').toContainText('LS 9,5%/năm');
    // Chủ tịch có rollover:act (ma trận quyền) ⇒ thấy form ghi kết quả, không thấy dòng tóm tắt
    await ctaPinned(chairman);
    await chairman.goto(`/ho-so/dao-han/${docId}`);
    await expect.soft(chairman.getByRole('button', { name: 'Lưu kết quả thực hiện' }), '[đúng quyền] Chủ tịch thấy form ghi kết quả đảo hạn').toBeVisible({ timeout: 20_000 });
    await expect.soft(chairman.getByText(/Đã thực hiện.*đáo hạn mới/), '[đúng quyền] Chủ tịch không thấy dòng tóm tắt khi có quyền ghi').toHaveCount(0);
    // "Lịch sử thay đổi" trên màn chi tiết khoản vay: dòng đổi "Hạn thanh toán (đáo hạn)" dạng DD/MM/YYYY (trước → sau)
    await staff.goto(`/ngan-hang/khoan-vay/${loan._id}`);
    const dueChange = staff.getByText(/Hạn thanh toán \(đáo hạn\):.*→/).first();
    await expect.soft(dueChange, 'lịch sử khoản vay: đổi hạn hiện DD/MM/YYYY').toContainText(toDdmmyyyy(newMaturity));
    await expect.soft(dueChange, 'lịch sử khoản vay: đổi hạn không hiện ISO yyyy-mm-dd').not.toContainText(newMaturity);
    await expect.soft(dueChange, 'lịch sử khoản vay: đủ "trước → sau" dạng DD/MM/YYYY').toContainText(`${toDdmmyyyy(oldMaturity)} → ${toDdmmyyyy(newMaturity)}`);
    // [lỗi mới] cột "Thao tác" của lịch sử phải là nhãn tiếng Việt, không phải mã kỹ thuật (rollover_result)
    const historyCard = staff.getByText('Lịch sử thay đổi', { exact: true }).first().locator('xpath=ancestor::*[.//table][1]');
    await expect.soft(historyCard, '[lỗi mới] cột "Thao tác" không hiện mã kỹ thuật rollover_result').not.toContainText('rollover_result');
    // [lỗi đã báo] nhãn tiếng Việt: "Kết quả đảo hạn" (thao tác rollover_result) và "Tạo khoản vay" (thao tác create)
    await expect.soft(historyCard, '[lỗi đã báo] thao tác "Kết quả đảo hạn" hiện nhãn tiếng Việt').toContainText('Kết quả đảo hạn');
    await expect.soft(historyCard, '[lỗi đã báo] thao tác "Tạo khoản vay" hiện nhãn tiếng Việt').toContainText('Tạo khoản vay');
    // [lỗi đã báo] đổi lãi suất trước → sau theo dấu phẩy: "8 → 9,5" (không "8 → 9.5")
    await expect.soft(historyCard.getByText(/Lãi suất:.*→/).first(), '[lỗi đã báo] lịch sử: đổi lãi suất "8 → 9,5"').toContainText('8 → 9,5');

    // 6) Khoản đã đáo hạn xa hơn 30 ngày không còn trên bảng đáo hạn
    await staff.goto('/ngan-hang/dao-han');
    await expect(staff.locator('table tr', { hasText: loanCode })).toHaveCount(0);
  });

  /* ------------------------------ LOAN-05 · nhập theo lô ------------------------------ */

  test('LOAN-05 · nhập theo lô (.tsv): dòng hợp lệ được nhập, dòng lỗi báo rõ lý do', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Nhap Lo');
    const customer = await createCustomer(staff, cta, 'KH Nhap Lo');
    const maturity = addDays(vnToday(), 200);
    const rows = [
      ['Mã đối tác', 'Số tiền vay', 'Hạn mức', 'Lãi suất', 'Hạn thanh toán', 'Kỳ hạn', 'Ghi chú'],
      [bank.code, '20000000', '30000000', '9,5', toDdmmyyyy(maturity), '12', 'Nhập lô E2E'],
      ['XYZ-1', '1000000', '', '8', toDdmmyyyy(maturity), '', 'Sai mã đối tác'],
      [bank.code, '0', '', '8', toDdmmyyyy(maturity), '', 'Số tiền bằng 0'],
      ['DT-9999-99999', '1000000', '', '8', toDdmmyyyy(maturity), '', 'Mã không tồn tại'],
    ];

    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByRole('button', { name: 'Nhập theo lô (.tsv)' }).click();
    const dlg = openDialog(staff);
    await staff.locator('input[type="file"]').setInputFiles({
      name: 'khoan-vay-e2e.tsv',
      mimeType: 'text/tab-separated-values',
      buffer: Buffer.from(tsv(rows), 'utf-8'),
    });
    await expect(dlg).toContainText('3 dòng không hợp lệ sẽ bị bỏ qua');
    await expect(dlg).toContainText('Cột 1 phải là mã đối tác ngân hàng (DT-…)');
    await expect(dlg).toContainText('Không có ngân hàng đang hoạt động với mã này');
    await expect(dlg).toContainText('Số tiền vay không hợp lệ');
    // [lỗi mới] xem trước: lãi suất nhập "9,5" phải hiện dấu phẩy theo quy ước VN ("9,5 %"), không hiện dấu chấm ("9.5 %")
    await expect.soft(dlg.locator('tr', { hasText: '20.000.000 ₫' }).first(), '[lỗi mới] xem trước: lãi suất "9,5" hiện dấu phẩy').not.toContainText('9.5 %');
    // [lỗi đã báo] xem trước hiện đúng "9,5 %"
    await expect.soft(dlg.locator('tr', { hasText: '20.000.000 ₫' }).first(), '[lỗi đã báo] xem trước: lãi suất hiện "9,5 %"').toContainText('9,5 %');
    await dlg.getByRole('button', { name: 'Nhập 1 dòng' }).click();
    // Máy chủ và trình duyệt có thể chậm khi nhiều tiến trình e2e dùng chung (đã thấy import ~3 s, danh sách ~6 s): chờ kết quả lâu hơn
    await expect(dlg.getByText(/Đã nhập 1 khoản nợ/)).toBeVisible({ timeout: 30_000 });

    const imported = await listLoansApi(staff, cta, { partner_id: bank.id });
    expect(imported.items).toHaveLength(1);
    const loan = imported.items[0] as LoanApi;
    expect(loan.principal.minor).toBe('20000000');
    expect(loan.credit_limit.minor).toBe('30000000');
    expect(loan.maturity_date).toBe(maturity);
    expect(loan.term_months).toBe(12);
    expect(loan.origin.kind).toBe('manual');

    // [lỗi mới] sau khi nhập, danh sách hiện lãi suất "9,5" theo quy ước VN (không hiện "9.5 %/năm")
    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(loan.code);
    await expect.soft(staff.locator('tr', { hasText: loan.code }), '[lỗi mới] danh sách: khoản nhập từ .tsv không hiện dấu chấm "9.5 %"').not.toContainText('9.5 %');
    // [lỗi đã báo] danh sách hiện "9,5 %/năm" và khoản lưu lãi suất đúng dạng "9,5"
    await expect.soft(staff.locator('tr', { hasText: loan.code }), '[lỗi đã báo] danh sách: lãi suất "9,5 %/năm"').toContainText('9,5 %/năm');
    expect.soft(loan.interest_rate, '[lỗi đã báo] khoản nhập theo lô lưu lãi suất "9,5"').toBe('9,5');

    // Máy chủ: mã đối tác không phải ngân hàng và dòng trùng đều báo lỗi riêng từng dòng
    const res = await apiPostRaw(staff, cta, 'bank-debts/import', {
      rows: [
        { partner_code: customer.code, amount: { amount_minor: '1000000', currency: 'VND' }, maturity_date: maturity },
        { partner_code: bank.code, amount: { amount_minor: '20000000', currency: 'VND' }, maturity_date: maturity, interest_rate: '9,5' },
      ],
    });
    expect(res.status).toBe(201);
    const failed = unwrap<any>(res.body).failed as { row: number; error: string }[];
    expect(failed.find((f) => f.row === 1)?.error).toContain('chỉ dùng đối tác loại Ngân hàng');
    expect(failed.find((f) => f.row === 2)?.error).toContain('Trùng khoản');
  });

  test('LOAN-05 · nhập theo lô: ngân hàng hợp lệ nằm NGOÀI 1.000 đối tác đầu (tên xếp cuối) vẫn được nhận, không báo "Không có ngân hàng đang hoạt động"', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    // tên bắt đầu bằng "ZZZ" ⇒ xếp cuối theo name_key, sau 1.000 ngân hàng đầu của công ty có nhiều ngân hàng
    const bank = await createBank(staff, cta, 'ZZZ NH Xep Cuoi');
    const maturity = addDays(vnToday(), 200);
    const rows = [
      ['Mã đối tác', 'Số tiền vay', 'Hạn mức', 'Lãi suất', 'Hạn thanh toán', 'Kỳ hạn', 'Ghi chú'],
      [bank.code, '1000000', '', '8', toDdmmyyyy(maturity), '', 'Dòng hợp lệ ngoài 1.000 đầu'],
    ];

    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByRole('button', { name: 'Nhập theo lô (.tsv)' }).click();
    const dlg = openDialog(staff);
    await staff.locator('input[type="file"]').setInputFiles({
      name: 'khoan-vay-xep-cuoi.tsv',
      mimeType: 'text/tab-separated-values',
      buffer: Buffer.from(tsv(rows), 'utf-8'),
    });
    await expect(dlg.getByRole('button', { name: 'Nhập 1 dòng' }), 'dòng có mã ngân hàng hợp lệ phải được nhận (nút nhập bật)').toBeEnabled({ timeout: 20_000 });
    await expect(dlg).not.toContainText('Không có ngân hàng đang hoạt động với mã này');
    await expect(dlg).not.toContainText('dòng không hợp lệ');
  });

  test('LOAN-05 · xem trước: ngày hạn không hợp lệ (31/13) phải báo lỗi, không được coi là "Hợp lệ"', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Ngay Sai');
    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByRole('button', { name: 'Nhập theo lô (.tsv)' }).click();
    const dlg = openDialog(staff);
    await staff.locator('input[type="file"]').setInputFiles({
      name: 'ngay-sai.tsv',
      mimeType: 'text/tab-separated-values',
      buffer: Buffer.from(
        tsv([
          ['Mã', 'Số tiền', 'Hạn mức', 'Lãi', 'Hạn', 'Kỳ hạn', 'Ghi chú'],
          [bank.code, '1000000', '', '8', '31/13/2030', '', 'Ngày sai'],
          [bank.code, '2000000', '', '8', '29/02/2027', '', 'Năm không nhuận'],
        ]),
        'utf-8',
      ),
    });
    // [lỗi đã báo] 31/13/2030 không được hiện "31/01/2031 — Hợp lệ"; 29/02/2027 (không phải năm nhuận) cũng bị loại
    const badRollover = dlg.locator('tr', { hasText: '1.000.000 ₫' });
    await expect(badRollover).toContainText('Hạn thanh toán không hợp lệ');
    await expect(badRollover).not.toContainText('Hợp lệ');
    await expect(badRollover).not.toContainText('31/01/2031');
    const badLeap = dlg.locator('tr', { hasText: '2.000.000 ₫' });
    await expect(badLeap).toContainText('Hạn thanh toán không hợp lệ');
    await expect(badLeap).not.toContainText('Hợp lệ');
    await expect(dlg).toContainText('2 dòng không hợp lệ sẽ bị bỏ qua');
    await expect(dlg.getByRole('button', { name: /^Nhập/ })).toBeDisabled();
  });

  /* ------------------------------ LOAN-04 · lịch trả nợ ------------------------------ */

  test('§10.3 · lịch trả nợ: tổng gốc theo kỳ khớp gốc khoản vay (trả góp đều gốc)', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Lich Tra');
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '12000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -30),
      maturity_date: addDays(vnToday(), 180),
      interest_rate: '12',
      payment_frequency: 'monthly',
      repayment_method: 'equal_principal',
    });
    const schedule = await apiGet(staff, cta, `bank-debts/${loan._id}/schedule`);
    expect(schedule.rows.length).toBeGreaterThan(1);
    expect(schedule.rows.at(-1).due_date).toBe(addDays(vnToday(), 180));
    expect(schedule.totals.principal.minor).toBe('12000000');
    const sumPrincipal = (schedule.rows as { principal: { minor: string } }[]).reduce((a, r) => a + BigInt(r.principal.minor), 0n);
    expect(sumPrincipal.toString()).toBe('12000000');

    await staff.goto(`/ngan-hang/khoan-vay/${loan._id}/lich-tra`);
    await expect(staff.getByText('Tổng gốc', { exact: true })).toBeVisible();
    await expect(staff.getByText('12.000.000 ₫').first()).toBeVisible();
  });

  test('RENEW-05 · tiền cần chuẩn bị 30 ngày = đáo hạn + chi định kỳ; báo thiếu / đủ so với số dư sổ cái', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const prep = await apiGet(staff, cta, 'rollovers/preparation');
    const m = (w: { minor: string }) => BigInt(w.minor);
    expect(m(prep.need)).toBe(m(prep.maturity) + m(prep.planned_spend));
    expect(m(prep.gap)).toBe(m(prep.balance) - m(prep.need));
    expect(prep.breach).toBe(m(prep.gap) < 0n);

    await staff.goto('/ngan-hang/dao-han/chuan-bi');
    await expect(staff.getByText('Tiền cần chuẩn bị cho 30 ngày tới', { exact: true })).toBeVisible();
    await expect(staff.getByText(prep.breach ? 'Thiếu tiền' : 'Đủ tiền', { exact: true })).toBeVisible();
  });

  /* ------------------------------ sức chứa & đúng đối tác khi gán liên kết ------------------------------ */

  test('§10.3 · sức chứa: không gán trả nợ / giải ngân vượt gốc; không gán phiếu của ngân hàng khác', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bankA = await createBank(staff, cta, 'NH Suc Chua A');
    const bankB = await createBank(staff, cta, 'NH Suc Chua B');
    const account = await ctaBankAccount(staff, cta);
    const loan = await createLoanApi(staff, cta, {
      partner_id: bankA.id,
      amount: { amount_minor: '10000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -30),
      maturity_date: addDays(vnToday(), 200),
      interest_rate: '0',
    });
    const payA1 = await createVoucherApi(staff, cta, spendBody({ partnerId: bankA.id, accountId: account, amountMinor: '6000000' }));
    const payA2 = await createVoucherApi(staff, cta, spendBody({ partnerId: bankA.id, accountId: account, amountMinor: '6000000' }));
    const payB = await createVoucherApi(staff, cta, spendBody({ partnerId: bankB.id, accountId: account, amountMinor: '2000000' }));

    await apiPost(staff, cta, `bank-debts/${loan._id}/repayments`, { document_id: payA1._id, amount_minor: '6000000', split: { principal: '6000000', interest: '0', fee: '0' } });
    const overCap = await apiPostRaw(staff, cta, `bank-debts/${loan._id}/repayments`, { document_id: payA2._id, amount_minor: '6000000', split: { principal: '6000000', interest: '0', fee: '0' } });
    expect(overCap.status).toBe(422);
    expect(overCap.body.code).toBe('FG-LINK-002');
    const wrongBank = await apiPostRaw(staff, cta, `bank-debts/${loan._id}/repayments`, { document_id: payB._id, amount_minor: '2000000' });
    expect(wrongBank.status).toBe(422);
    expect(wrongBank.body.code).toBe('FG-LINK-001');

    const incA1 = await createVoucherApi(staff, cta, incomeBody({ partnerId: bankA.id, accountId: account, amountMinor: '10000000' }));
    const incA2 = await createVoucherApi(staff, cta, incomeBody({ partnerId: bankA.id, accountId: account, amountMinor: '5000000' }));
    await apiPost(staff, cta, `bank-debts/${loan._id}/disbursements`, { document_id: incA1._id, amount_minor: '10000000' });
    const overDisb = await apiPostRaw(staff, cta, `bank-debts/${loan._id}/disbursements`, { document_id: incA2._id, amount_minor: '5000000' });
    expect(overDisb.status).toBe(422);
    expect(overDisb.body.code).toBe('FG-LINK-002');
  });

  test('US-LOAN-02 · tổng "Chờ giải ngân" của ngân hàng gồm cả khoản đã gán phiếu thu (chưa về tiền)', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH KPI Cho GN');
    const account = await ctaBankAccount(staff, cta);
    await createVoucherApi(
      staff,
      cta,
      incomeBody({ partnerId: bank.id, accountId: account, amountMinor: '30000000', options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank.id } } }),
    );
    const pending = await waitForLoan(staff, cta, bank.id, (l) => l.status === 'pending_disbursement');
    expect(pending.principal.minor).toBe('30000000');
    const single = await listLoansApi(staff, cta, { partner_id: bank.id, status: 'pending_disbursement' });
    expect(single.totals.pending_count).toBe(1);
    // Khoản 30 triệu đang chờ tiền về: KPI phải phản ánh 30 triệu, không phải phần chưa gán (0)
    expect(single.totals.pending_amount.minor).toBe('30000000');

    // Thêm một phiếu thu đi vay 12 triệu (chưa về tiền): tổng phải cộng cả hai khoản
    await createVoucherApi(
      staff,
      cta,
      incomeBody({ partnerId: bank.id, accountId: account, amountMinor: '12000000', options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank.id } } }),
    );
    await expect
      .poll(async () => (await listLoansApi(staff, cta, { partner_id: bank.id, status: 'pending_disbursement' })).totals.pending_count, { timeout: 30_000 })
      .toBe(2);
    const both = await listLoansApi(staff, cta, { partner_id: bank.id, status: 'pending_disbursement' });
    // [lỗi đã báo] pending_amount = tổng gốc các khoản chờ (kể cả khoản đã gán phiếu thu), không phải phần chưa gán
    expect(both.totals.pending_amount.minor).toBe('42000000');
    expect(both.totals.outstanding.minor).toBe('0');

    // UI: KPI "Chờ giải ngân" của danh sách khi lọc theo ngân hàng hiển thị đúng 42.000.000
    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(bank.name);
    await expect(staff.locator('.fg-kpi', { hasText: 'Chờ giải ngân' })).toContainText('42.000.000', { timeout: 20_000 });
  });

  /* ------------------------------ lỗi mới (vòng 6) ------------------------------ */

  test('[lỗi mới · đảo hạn] phương án đảo hạn nhận "lãi suất mới" là chữ "abc" — phải bị từ chối như ô kết quả đảo hạn (lãi suất dạng số)', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Plan Rate');
    const account = await ctaBankAccount(staff, cta);
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '30000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -60),
      maturity_date: addDays(vnToday(), 20),
      interest_rate: '8',
    });
    const res = await apiPostRaw(staff, cta, 'documents', {
      company_id: cta.id,
      kind: 'rollover',
      title: uniq('Phuong an lai abc'),
      purpose: 'E2E: kiểm tra lãi suất mới của phương án đảo hạn',
      partner_id: bank.id,
      amount: { amount_minor: '30000000', currency: 'VND', decimals: 0 },
      source: { fund: 'bank', account_id: account, group_managed: false },
      planned_date: `${vnToday()}T09:00`,
      loan_id: loan._id,
      rollover: {
        plan: 'E2E lãi suất chữ',
        new_rate: 'abc',
        need_amount: { amount_minor: '30000000', currency: 'VND', decimals: 0 },
        new_maturity_date: addDays(vnToday(), 385),
      },
    });
    // [lỗi đã báo] máy chủ phải trả 422 (trước đây lưu "abc" với HTTP 201): cùng quy tắc ô kết quả đảo hạn (số, tối đa 2 chữ số thập phân)
    expect.soft(res.status, '[lỗi đã báo] phương án có lãi suất mới "abc" phải bị từ chối (422), không được lưu').toBe(422);
    expect.soft(String(res.body?.detail ?? ''), '[lỗi đã báo] thông báo lỗi nêu "Lãi suất dạng số" (không lưu "abc")').toContain('Lãi suất dạng số');
    // đối chứng: "9,5" (đúng quy tắc) vẫn được nhận và lưu
    const valid = await apiPostRaw(staff, cta, 'documents', {
      company_id: cta.id,
      kind: 'rollover',
      title: uniq('Phuong an lai dung'),
      purpose: 'E2E: đối chứng lãi suất mới hợp lệ',
      partner_id: bank.id,
      amount: { amount_minor: '30000000', currency: 'VND', decimals: 0 },
      source: { fund: 'bank', account_id: account, group_managed: false },
      planned_date: `${vnToday()}T09:00`,
      loan_id: loan._id,
      rollover: {
        plan: 'E2E lãi suất hợp lệ',
        new_rate: '9,5',
        need_amount: { amount_minor: '30000000', currency: 'VND', decimals: 0 },
        new_maturity_date: addDays(vnToday(), 385),
      },
    });
    expect(valid.status, 'lãi suất mới "9,5" vẫn được nhận (201)').toBe(201);
  });

  test('[lỗi đã báo · đảo hạn · form] "Lãi suất mới (%/năm)" của phương án nhập "abc" hoặc "9,555" ⇒ báo lỗi ngay tại ô, không gửi phương án lên máy chủ', async ({ as }) => {
    const staff = await as('staff');
    await ctaPinned(staff);
    await gotoCta(staff, '/ngan-hang/dao-han/phuong-an/moi');
    await expect(staff.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 20_000 });
    const rate = fieldInput(staff, 'Lãi suất mới (%/năm)');
    const msg = 'Lãi suất dạng số, tối đa 2 chữ số thập phân';
    let posts = 0;
    const onRequest = (r: { method(): string; url(): string }) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/documents') posts++;
    };
    staff.on('request', onRequest);
    // lượt 1: "abc"
    await rate.fill('abc');
    await staff.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await expect(staff.getByText(msg).first(), '[lỗi đã báo · form] "abc" báo lỗi tại ô "Lãi suất mới (%/năm)"').toBeVisible();
    // lượt 2: làm mới form rồi thử "9,555" (để thông báo lượt 1 không che kết quả lượt 2)
    await staff.reload();
    await expect(staff.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 20_000 });
    await fieldInput(staff, 'Lãi suất mới (%/năm)').fill('9,555');
    await staff.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await expect(staff.getByText(msg).first(), '[lỗi đã báo · form] "9,555" báo lỗi tại ô "Lãi suất mới (%/năm)"').toBeVisible();
    await staff.waitForTimeout(1000);
    staff.off('request', onRequest);
    expect(posts, 'không gửi phương án lên máy chủ khi lãi suất sai').toBe(0);
  });

  test('[lỗi đã báo · khoản vay] danh sách cắt âm thầm ở 2.000 dòng: khoản đáo hạn muộn phải tìm được theo mã, nằm trong danh sách không lọc, trong tổng và "Dư nợ theo ngân hàng"', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Gioi Han Danh Sach');
    // đáo hạn muộn nhất có thể: máy chủ sắp theo hạn tăng dần ⇒ khoản này nằm cuối (trước đây bị cắt ở 2.000 dòng, ~2.500 khoản trong DB test)
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '1000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -1),
      maturity_date: '2099-12-31',
      interest_rate: '0',
    });
    const code = (await getLoanApi(staff, cta, loan._id)).code;
    const found = await listLoansApi(staff, cta, { q: code });
    expect.soft(found.items.map((l) => l.code), '[lỗi đã báo] tìm theo mã phải thấy khoản vừa tạo (không bị cắt ở 2.000 dòng)').toContain(code);

    // [lỗi đã báo] danh sách KHÔNG lọc phân trang (không tải cả danh sách mỗi lần, xem perf bên dưới): không cắt âm thầm —
    // tổng khớp mọi trang và khoản đáo hạn muộn nhất nằm ở TRANG CUỐI
    const first = await apiGet(staff, cta, 'bank-debts', {});
    const total = Number(first.total);
    const limit = Number(first.limit);
    expect.soft(total, '[lỗi đã báo] "total" của danh sách không lọc = số khoản khớp (mọi trang)').toBeGreaterThanOrEqual(1);
    expect.soft(first.items.length, '[lỗi đã báo] một trang không vượt cỡ trang').toBeLessThanOrEqual(limit);
    expect.soft(first.totals.count, '[lỗi đã báo] tổng số khoản = "total" (không tính theo trang)').toBe(total);
    const lastPage = Math.max(1, Math.ceil(total / limit));
    const last = await apiGet(staff, cta, 'bank-debts', { page: String(lastPage) });
    expect.soft((last.items as { _id: string }[]).map((l) => l._id), '[lỗi đã báo] danh sách không lọc phải chứa khoản đáo hạn 2099 (ở trang cuối)').toContain(loan._id);

    // [lỗi đã báo] tổng theo ngân hàng (tính trên mọi khoản, không chỉ phần đã nạp) có khoản này; Σ dư nợ theo ngân hàng = tổng dư nợ
    const summary = await apiGet(staff, cta, 'bank-debts', { summary: 'true' });
    const byBank = summary.by_bank as { partner_id: string | null; outstanding: { minor: string }; count: number }[];
    const row = byBank.find((r) => r.partner_id === bank.id);
    expect.soft(row, '[lỗi đã báo] "Dư nợ theo ngân hàng" có dòng cho ngân hàng vừa tạo').toBeTruthy();
    expect.soft(row?.outstanding.minor, '[lỗi đã báo] dư nợ ngân hàng gồm khoản đáo hạn 2099 (1.000.000)').toBe('1000000');
    const sumByBank = byBank.reduce((a, r) => a + BigInt(r.outstanding.minor), 0n);
    expect.soft(sumByBank.toString(), '[lỗi đã báo] Σ "Dư nợ theo ngân hàng" = tổng dư nợ của công ty').toBe(String(summary.totals.outstanding.minor));

    // UI: bảng "Dư nợ theo ngân hàng" trên màn đáo hạn hiện dòng ngân hàng này với 1.000.000
    await staff.goto('/ngan-hang/dao-han');
    await expect(await bankTotalsRow(staff, bank.name), '[lỗi đã báo] bảng dư nợ theo ngân hàng hiện ngân hàng vừa tạo').toContainText('1.000.000', { timeout: 30_000 });
  });

  /* ------------------------------ lỗi đã báo (vòng 4): lãi suất 2 chữ số thập phân ------------------------------ */

  test('[lỗi đã báo · vòng 4] lãi suất "9,555" (3 chữ số thập phân) bị chặn ở mọi đường: API (phiếu thu/chi vay, sửa phiếu nháp, khoản tạo tay, sửa khoản, nhập lô, phương án đảo hạn) và form/nhập lô trên UI', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Lai 4 So');
    const supplier = await createSupplier(staff, cta, 'NCC Lai 4 So');
    const account = await ctaBankAccount(staff, cta);
    const bad = '9,555';
    const RATE_MSG = '2 chữ số thập phân';

    // API — phiếu thu đi vay (R2)
    const receipt = await apiPostRaw(staff, cta, 'documents', {
      company_id: cta.id,
      ...incomeBody({ partnerId: bank.id, accountId: account, amountMinor: '5000000', options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank.id, terms: { interest_rate: bad } } } }),
    });
    expect(receipt.status, '[lỗi đã báo · vòng 4] phiếu thu đi vay lãi suất "9,555" phải bị từ chối (422)').toBe(422);
    expect(String(receipt.body?.detail ?? ''), 'phiếu thu: thông báo nêu 2 chữ số thập phân').toContain(RATE_MSG);

    // API — phiếu chi vay để chi (R3)
    const fund = await apiPostRaw(staff, cta, 'documents', {
      company_id: cta.id,
      ...spendBody({ partnerId: supplier.id, accountId: account, amountMinor: '4000000', options: { loan: { kind: 'fund', mode: 'new', lender_partner_id: bank.id, receive_account_id: account, terms: { interest_rate: bad } } } }),
    });
    expect(fund.status, '[lỗi đã báo · vòng 4] phiếu chi vay để chi lãi suất "9,555" phải bị từ chối (422)').toBe(422);
    expect(String(fund.body?.detail ?? ''), 'phiếu chi: thông báo nêu 2 chữ số thập phân').toContain(RATE_MSG);

    // API — sửa phiếu nháp sang "9,555"
    const draft = await createVoucherApi(
      staff,
      cta,
      incomeBody({ partnerId: bank.id, accountId: account, amountMinor: '5000000', options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank.id, terms: { interest_rate: '8,5' } } } }),
    );
    const draftVersion = (await getVoucherApi(staff, cta, draft._id)).version;
    const patched = await staff.request.patch(`/api/v1/documents/${draft._id}`, {
      headers: scopeOf(cta),
      data: {
        if_match: draftVersion,
        request_id: randomUUID(),
        options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: bank.id, terms: { interest_rate: bad } } },
      },
    });
    expect(patched.status(), '[lỗi đã báo · vòng 4] sửa phiếu nháp sang lãi suất "9,555" phải bị từ chối (422)').toBe(422);

    // API — khoản vay tạo tay và sửa khoản vay
    const manual = await apiPostRaw(staff, cta, 'bank-debts', {
      partner_id: bank.id,
      amount: { amount_minor: '1000000', currency: 'VND' },
      maturity_date: addDays(vnToday(), 200),
      interest_rate: bad,
    });
    expect(manual.status, '[lỗi đã báo · vòng 4] khoản vay tạo tay lãi suất "9,555" → 422').toBe(422);
    expect(String(manual.body?.detail ?? ''), 'khoản vay tạo tay: thông báo nêu 2 chữ số thập phân').toContain(RATE_MSG);
    const okLoan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '1000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -1),
      maturity_date: addDays(vnToday(), 200),
      interest_rate: '8,5',
    });
    const patchLoan = await staff.request.patch(`/api/v1/bank-debts/${okLoan._id}`, { headers: scopeOf(cta), data: { interest_rate: bad } });
    expect(patchLoan.status(), '[lỗi đã báo · vòng 4] sửa khoản vay sang lãi suất "9,555" → 422').toBe(422);

    // API — nhập lô: dòng "9,555" bị báo lỗi riêng, không tạo khoản
    const imp = await apiPostRaw(staff, cta, 'bank-debts/import', {
      rows: [{ partner_code: bank.code, amount: { amount_minor: '1000000', currency: 'VND' }, maturity_date: addDays(vnToday(), 200), interest_rate: bad }],
    });
    expect(imp.status, 'nhập lô vẫn trả 201 với danh sách dòng lỗi').toBe(201);
    const impFailed = unwrap<any>(imp.body).failed as { row: number; error: string }[];
    expect(impFailed.find((f) => f.row === 1)?.error, '[lỗi đã báo · vòng 4] nhập lô: dòng "9,555" bị báo lỗi lãi suất').toContain(RATE_MSG);
    expect(unwrap<any>(imp.body).inserted, 'nhập lô: dòng lỗi không được tạo khoản').toBe(0);

    // API — phương án đảo hạn có lãi suất mới "9,555"
    const plan = await apiPostRaw(staff, cta, 'documents', {
      company_id: cta.id,
      kind: 'rollover',
      title: uniq('Phuong an 4 so'),
      purpose: 'E2E: lãi suất 4 chữ số của phương án đảo hạn',
      partner_id: bank.id,
      amount: { amount_minor: '1000000', currency: 'VND', decimals: 0 },
      source: { fund: 'bank', account_id: account, group_managed: false },
      planned_date: `${vnToday()}T09:00`,
      loan_id: okLoan._id,
      rollover: {
        plan: 'E2E lãi suất 4 số',
        new_rate: bad,
        need_amount: { amount_minor: '1000000', currency: 'VND', decimals: 0 },
        new_maturity_date: addDays(vnToday(), 400),
      },
    });
    expect(plan.status, '[lỗi đã báo · vòng 4] phương án đảo hạn "9,555" → 422').toBe(422);

    // UI — phiếu thu đi vay: ô "Lãi suất (%/năm)" báo lỗi, không gửi phiếu
    await gotoCta(staff, '/thu/moi');
    await expect(staff.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 20_000 });
    await fieldOf(staff, 'Tiêu đề').locator('input').fill(uniq('Thu lai 4 so E2E'));
    await fieldOf(staff, 'Nội dung / mục đích').locator('textarea').fill('E2E: phiếu thu đi vay, kiểm tra lãi suất 4 chữ số');
    await pickPartner(staff, fieldOf(staff, 'Bên nộp tiền'), bank.name);
    await staff.getByLabel('Số tiền', { exact: true }).first().fill('5000000');
    const receiptDeadline = fieldOf(staff, 'Hạn thanh toán').locator('input').first();
    await receiptDeadline.click();
    await receiptDeadline.fill(DEADLINE_UI);
    await receiptDeadline.press('Enter');
    await pickSelect(staff, fieldOf(staff, 'Tài khoản đích'), /./);
    await staff.getByRole('checkbox', { name: /Đây là khoản vay ngân hàng/ }).check();
    await fieldOf(staff, 'Lãi suất (%/năm)').locator('input').first().fill(bad);
    let receiptPosts = 0;
    const onReceiptReq = (r: { method(): string; url(): string }) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/documents') receiptPosts++;
    };
    staff.on('request', onReceiptReq);
    await staff.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await expect(staff.getByText('Lãi suất dạng số, tối đa 2 chữ số thập phân').first(), '[lỗi đã báo · vòng 4] form phiếu thu: "9,555" báo lỗi tại ô lãi suất').toBeVisible();
    await staff.waitForTimeout(1000);
    staff.off('request', onReceiptReq);
    expect(receiptPosts, '[lỗi đã báo · vòng 4] phiếu thu lãi suất sai không được gửi lên máy chủ').toBe(0);

    // UI — phiếu chi "Vay ngân hàng để chi": cùng quy tắc
    await gotoCta(staff, '/chi/moi');
    await expect(staff.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 20_000 });
    await fieldOf(staff, 'Tiêu đề').locator('input').fill(uniq('Chi vay lai 4 so E2E'));
    await fieldOf(staff, 'Nội dung / mục đích').locator('textarea').fill('E2E: chi bằng vốn vay, kiểm tra lãi suất 4 chữ số');
    await pickPartner(staff, fieldOf(staff, 'Bên nhận tiền'), supplier.name);
    await staff.getByLabel('Số tiền', { exact: true }).first().fill('4000000');
    const spendDeadline = fieldOf(staff, 'Hạn thanh toán').locator('input').first();
    await spendDeadline.click();
    await spendDeadline.fill(DEADLINE_UI);
    await spendDeadline.press('Enter');
    await staff.getByRole('checkbox', { name: /Vay ngân hàng để chi/ }).check();
    await pickPartner(staff, fieldOf(staff, 'Ngân hàng cho vay'), bank.name);
    await expect(staff.locator('.ant-select-dropdown:visible'), 'dropdown ô đối tác đã đóng').toHaveCount(0, { timeout: 10_000 });
    await pickSelect(staff, fieldOf(staff, 'Tài khoản nhận giải ngân'), /./);
    await fieldOf(staff, 'Lãi suất (%/năm)').locator('input').first().fill(bad);
    let spendPosts = 0;
    const onSpendReq = (r: { method(): string; url(): string }) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/v1/documents') spendPosts++;
    };
    staff.on('request', onSpendReq);
    await staff.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
    await expect(staff.getByText('Lãi suất dạng số, tối đa 2 chữ số thập phân').first(), '[lỗi đã báo · vòng 4] form phiếu chi vay: "9,555" báo lỗi tại ô lãi suất').toBeVisible();
    await staff.waitForTimeout(1000);
    staff.off('request', onSpendReq);
    expect(spendPosts, '[lỗi đã báo · vòng 4] phiếu chi vay lãi suất sai không được gửi lên máy chủ').toBe(0);

    // UI — nhập lô (.tsv): xem trước báo "Lãi suất không hợp lệ", không cho nhập
    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByRole('button', { name: 'Nhập theo lô (.tsv)' }).click();
    const dlg = openDialog(staff);
    await staff.locator('input[type="file"]').setInputFiles({
      name: 'lai-4-so.tsv',
      mimeType: 'text/tab-separated-values',
      buffer: Buffer.from(
        tsv([
          ['Mã', 'Số tiền', 'Hạn mức', 'Lãi', 'Hạn', 'Kỳ hạn', 'Ghi chú'],
          [bank.code, '1000000', '', bad, toDdmmyyyy(addDays(vnToday(), 200)), '', 'Lãi 4 số'],
        ]),
        'utf-8',
      ),
    });
    await expect(dlg, '[lỗi đã báo · vòng 4] xem trước nhập lô: "9,555" báo "Lãi suất không hợp lệ"').toContainText('Lãi suất không hợp lệ');
    await expect(dlg.getByRole('button', { name: /^Nhập/ }), 'không cho nhập khi dòng lãi suất sai').toBeDisabled();
  });

  test('[lỗi đã báo · vòng 4] nhập lô: mã ngân hàng HỢP LỆ không bị báo "Không có ngân hàng đang hoạt động với mã này" khi công ty có nhiều hơn 1.000 ngân hàng', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    // partners/options sắp theo tên (name_key) và chỉ trả tối đa `limit` dòng; tên bắt đầu bằng "ZZZ" xếp cuối,
    // nên khi công ty có >1.000 ngân hàng (DB test hiện ~3.500) mã này nằm NGOÀI danh sách xem trước nạp về.
    const bank = await createBank(staff, cta, 'ZZZ NH Nhap Lo Cuoi');
    await gotoCta(staff, '/ngan-hang/khoan-vay');
    await staff.getByRole('button', { name: 'Nhập theo lô (.tsv)' }).click();
    const dlg = openDialog(staff);
    // mã trong file được tra đúng trên máy chủ (partners/options?codes=…) sau khi chọn file
    const codesChecked = staff.waitForResponse((r) => r.url().includes('/api/v1/partners/options') && r.url().includes('codes='), { timeout: 60_000 });
    await staff.locator('input[type="file"]').setInputFiles({
      name: 'nhap-lo-ma-hop-le.tsv',
      mimeType: 'text/tab-separated-values',
      buffer: Buffer.from(
        tsv([
          ['Mã', 'Số tiền', 'Hạn mức', 'Lãi', 'Hạn', 'Kỳ hạn', 'Ghi chú'],
          [bank.code, '1000000', '', '8', toDdmmyyyy(addDays(vnToday(), 200)), '', 'Mã hợp lệ'],
        ]),
        'utf-8',
      ),
    });
    // [vòng 5] lượt tra mã phải thành công (200) — không phải lỗi 422 do giới hạn `limit`
    const codesRes = await codesChecked;
    expect(codesRes.status(), '[vòng 5] tra mã đối tác (partners/options?codes=) trả 200').toBe(200);
    await expect(dlg, '[lỗi đã báo · vòng 4] mã ngân hàng hợp lệ không được báo "Không có ngân hàng đang hoạt động với mã này"').not.toContainText('Không có ngân hàng đang hoạt động với mã này');
    // [vòng 5] dòng hiện "Hợp lệ" kèm tên ngân hàng tra được trên máy chủ
    await expect(dlg.locator('tr', { hasText: bank.code }), '[vòng 5] dòng có mã hợp lệ hiện tên ngân hàng và "Hợp lệ"').toContainText(bank.name, { timeout: 30_000 });
    await expect(dlg.locator('tr', { hasText: bank.code })).toContainText('Hợp lệ');
    await expect(dlg.getByRole('button', { name: 'Nhập 1 dòng' }), '[lỗi đã báo · vòng 4] dòng có mã hợp lệ nhập được ("Nhập 1 dòng" bật)').toBeEnabled({ timeout: 30_000 });
  });

  /* ------------------------------ lỗi đã báo (vòng 4): hiệu năng danh sách & đáo hạn ------------------------------ */

  test('[lỗi đã báo · vòng 4 · hiệu năng] danh sách & đáo hạn: không tải cả danh sách mỗi lần (≤ 1 MB, không lọc) và hiện dữ liệu trong ngân sách 5 s', async ({ as }) => {
    test.setTimeout(180_000);
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    // Ngân sách đề xuất (đo trên DB test hiện tại, ~2.600 khoản): phản hồi danh sách không lọc ≤ 1.000.000 byte;
    // hàng đầu tiên của danh sách và bảng "Dư nợ theo ngân hàng" hiện trong ≤ 5 s. Số đo in ra console để đối chiếu.
    const LIST_BYTES_BUDGET = 1_000_000;
    const UI_BUDGET_MS = 5_000;

    const listRes = await staff.request.get('/api/v1/bank-debts', { headers: scopeOf(cta) });
    expect(listRes.status(), 'GET /bank-debts (không lọc) trả 200').toBe(200);
    const listBuf = await listRes.body();
    const listBytes = listBuf.length;
    const listBody = JSON.parse(listBuf.toString('utf8')) as { items: unknown[]; by_bank: unknown[] };
    // [vòng 5] mỗi lượt tải trang kèm "by_bank" (tổng theo MỌI ngân hàng có khoản, không phân trang): đo để theo dõi
    const byBankBytes = JSON.stringify(listBody.by_bank).length;
    console.log(`[perf] GET /bank-debts (không lọc): ${listBytes} byte · ${listBody.items.length} khoản trong trang · by_bank ${listBody.by_bank.length} ngân hàng (${byBankBytes} byte)`);
    expect.soft(listBody.items.length, '[vòng 5] một trang danh sách ≤ 50 khoản').toBeLessThanOrEqual(50);
    expect.soft(listBytes, `[lỗi đã báo · hiệu năng] danh sách không lọc tải ${listBytes} byte cho toàn bộ khoản vay (ngân sách ≤ ${LIST_BYTES_BUDGET}): cần phân trang hoặc tổng hợp trên DB`).toBeLessThan(LIST_BYTES_BUDGET);

    const t0 = Date.now();
    await gotoCta(staff, '/ngan-hang/khoan-vay');
    await staff.locator('tbody tr').first().waitFor({ timeout: 60_000 });
    const firstRowMs = Date.now() - t0;
    console.log(`[perf] danh sách khoản vay: hàng đầu tiên sau ${firstRowMs} ms`);
    expect.soft(firstRowMs, `[lỗi đã báo · hiệu năng] danh sách hiện hàng đầu tiên sau ${firstRowMs} ms (ngân sách ≤ ${UI_BUDGET_MS} ms)`).toBeLessThan(UI_BUDGET_MS);

    const t1 = Date.now();
    await gotoCta(staff, '/ngan-hang/dao-han');
    await expect(staff.locator('h2', { hasText: 'Dư nợ theo ngân hàng' })).toBeVisible({ timeout: 60_000 });
    const boardMs = Date.now() - t1;
    console.log(`[perf] bảng đáo hạn: "Dư nợ theo ngân hàng" hiện sau ${boardMs} ms`);
    expect.soft(boardMs, `[lỗi đã báo · hiệu năng] bảng đáo hạn hiện dư nợ theo ngân hàng sau ${boardMs} ms (ngân sách ≤ ${UI_BUDGET_MS} ms)`).toBeLessThan(UI_BUDGET_MS);

    // Form phương án đảo hạn khi CHƯA chọn ngân hàng: ô "Khoản vay đang đảo hạn" không được tải toàn bộ khoản vay của công ty
    const loanReqs: string[] = [];
    const onLoanReq = (r: { url(): string }) => {
      if (new URL(r.url()).pathname === '/api/v1/bank-debts') loanReqs.push(r.url());
    };
    staff.on('request', onLoanReq);
    await gotoCta(staff, '/ngan-hang/dao-han/phuong-an/moi');
    await expect(staff.getByRole('button', { name: 'Lưu nháp', exact: true })).toBeVisible({ timeout: 30_000 });
    await staff.waitForTimeout(1500);
    staff.off('request', onLoanReq);
    const unfiltered = loanReqs.filter((u) => !new URL(u).searchParams.has('partner_id'));
    console.log(`[perf] form phương án đảo hạn (chưa chọn ngân hàng): ${loanReqs.length} lượt GET /bank-debts, ${unfiltered.length} lượt không lọc`);
    expect.soft(unfiltered, '[lỗi đã báo · vòng 4 · hiệu năng] form phương án đảo hạn chưa chọn ngân hàng vẫn tải TOÀN BỘ khoản vay (ô "Khoản vay đang đảo hạn" lọc ở trình duyệt)').toEqual([]);
  });

  /* ------------------------------ lỗi đã báo (vòng 4) · dữ liệu cũ; vòng 5 · phân trang ------------------------------ */

  test('[lỗi đã báo · dữ liệu cũ] không còn khoản vay / phương án / điều khoản vay nào có lãi suất vi phạm 2 chữ số thập phân (3–4 chữ số, "abc"); migration 0006 đã ghi nhận', async () => {
    const r = legacyRateReport();
    expect(r.migrations_applied, 'migration 0006-clean-interest-rates.js đã được ghi nhận (chạy `pnpm db:migrate` nếu thiếu)').toContain('0006-clean-interest-rates.js');
    expect(r.bank_debts_total, 'CSDL có khoản vay để kiểm (kết quả không rỗng)').toBeGreaterThan(0);
    expect.soft(r.bank_debts_bad, '[lỗi đã báo · dữ liệu cũ] khoản vay còn lãi suất vi phạm quy tắc 2 chữ số thập phân').toBe(0);
    expect.soft(r.rollover_new_rate_bad, '[lỗi đã báo · dữ liệu cũ] phương án đảo hạn còn "lãi suất mới" vi phạm').toBe(0);
    expect.soft(r.rollover_result_rate_bad, '[lỗi đã báo · dữ liệu cũ] kết quả đảo hạn còn lãi suất vi phạm').toBe(0);
    expect.soft(r.loan_terms_rate_bad, '[lỗi đã báo · dữ liệu cũ] điều khoản vay trên phiếu còn lãi suất vi phạm').toBe(0);
  });

  test('[vòng 5 · danh sách] phân trang phía máy chủ: "Hiển thị 1–50", trang 2 hiện dòng khác; tìm theo mã khi đang ở trang 2 ⇒ về trang 1 và thấy đúng khoản', async ({ as }) => {
    const staff = await as('staff');
    const cta = await ctaPinned(staff);
    const bank = await createBank(staff, cta, 'NH Phan Trang');
    // cần hơn 50 khoản trong CTA để có trang 2 (DB test có sẵn hàng nghìn khoản; chỉ bổ sung khi thiếu)
    const probe = await apiGet(staff, cta, 'bank-debts', { limit: '1' });
    for (let n = Number(probe.total); n <= 50; n++) {
      await createLoanApi(staff, cta, {
        partner_id: bank.id,
        amount: { amount_minor: '1000000', currency: 'VND' },
        disbursed_date: addDays(vnToday(), -1),
        maturity_date: addDays(vnToday(), 300),
        interest_rate: '0',
      });
    }
    // hạn rất xa ⇒ sắp xếp theo hạn đưa khoản này về cuối danh sách (trang sau)
    const target = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '1000000', currency: 'VND' },
      disbursed_date: addDays(vnToday(), -1),
      maturity_date: '2099-06-30',
      interest_rate: '0',
    });

    await gotoCta(staff, '/ngan-hang/khoan-vay');
    await expect(staff.getByText(/Hiển thị 1.+50 \/ \d+ khoản/), 'trang 1 hiện khoảng "Hiển thị 1–50 / N khoản"').toBeVisible({ timeout: 30_000 });
    const firstPageRow = await staff.locator('tbody tr.ant-table-row').first().innerText();

    await staff.locator('li.ant-pagination-item[title="2"]').click();
    await expect(staff.getByText(/Hiển thị 51.+ \/ \d+ khoản/), 'trang 2 hiện "Hiển thị 51–…"').toBeVisible({ timeout: 30_000 });
    // nhãn đổi ngay khi bấm, còn bảng giữ dữ liệu trang 1 đến khi trang 2 tải xong ⇒ chờ dòng đầu THAY ĐỔI
    await expect
      .poll(async () => staff.locator('tbody tr.ant-table-row').first().innerText(), { timeout: 30_000, message: 'dòng đầu của trang 2 khác trang 1 (phân trang thật)' })
      .not.toBe(firstPageRow);
    const secondPageRow = await staff.locator('tbody tr.ant-table-row').first().innerText();
    expect(secondPageRow, 'trang 2 có dòng khác trang 1').not.toBe(firstPageRow);

    // đang ở trang 2 ⇒ tìm theo mã: phải quay về trang 1 và thấy đúng khoản (không hiện "Trang này không còn khoản nào")
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(target.code);
    await expect(staff.locator('tr', { hasText: target.code }), 'tìm theo mã khi đang ở trang 2 thấy đúng khoản').toHaveCount(1, { timeout: 30_000 });
    await expect(staff.getByText('Trang này không còn khoản nào')).toHaveCount(0);
  });
});

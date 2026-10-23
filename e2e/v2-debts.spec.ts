/**
 * E2E khu vực CÔNG NỢ (v2/v2.md §9 Công nợ, §5.3 màn Đối tác, §11 Liên kết nghiệp vụ; US-DEBT-01…04, US-PAR-03/04/05).
 *
 * Chạy (app đã bật bằng `pnpm dev`, không tự khởi động server):
 *   PW_AREA=debts npx playwright test e2e/v2-debts.spec.ts
 *
 * Quy ước dữ liệu: mọi đối tác / khoản / phiếu tạo bằng uniq(); số liệu đối chiếu qua API cùng lúc với giao diện.
 * Phạm vi công ty: CTA (default_scope của tài khoản đặt về CTA trong beforeAll, khôi phục trong afterAll).
 * Không bấm "Xoá" khoản công nợ (thao tác xoá vĩnh viễn): chỉ kiểm tra nút có/không hiện.
 */
import { test, expect, uniq, PASSWORD, USERS } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import {
  api,
  apiAs,
  approveToEnd,
  attachUnc,
  chooseDirection,
  cardWith,
  createDebt,
  createPartner,
  createVoucher,
  ctaId,
  expectNoErrors,
  fieldRoot,
  getDebt,
  codeOf,
  getDoc,
  kpi,
  linkDebt,
  must,
  payVoucher,
  pickAntdOption,
  pickPartner,
  rowWith,
  runVoucherToPaid,
  setDraftAccount,
  submitVoucher,
  transition,
  useCtaScope,
  vnToday,
  vnd,
  watch,
} from './helpers-debts';

/** dd/mm/yyyy từ yyyy-mm-dd (định dạng ô ngày trên giao diện). */
const dmy = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const accountNo = (): string => String(Math.floor(1e9 + Math.random() * 8e9));
const LINK_HEAD = 'Cấn trừ bằng phiếu';

/**
 * Ghim phạm vi CTA cho trang của KTV. Tài khoản KTV dùng chung với các tiến trình e2e khác, và chúng đổi
 * prefs.default_scope giữa chừng (trang mở ra ở MAYOGU → "không có quyền" hoặc danh sách trống). Ở đây chỉ đổi
 * phản hồi /me gửi tới TRANG NÀY (không ghi gì vào DB) để phạm vi luôn là CTA.
 */
async function pinCtaScope(page: Page): Promise<void> {
  const cta = await ctaId();
  await page.route('**/api/v1/me', async (route) => {
    // Máy chủ đang khởi động lại (node --watch): proxy trả lỗi rỗng hoặc treo. Handler không được ném lỗi (trang sẽ kẹt ở
    // màn tải): khi fetch lỗi thì để yêu cầu đi thẳng, khi không phải JSON thì trả nguyên phản hồi — màn hình tự thử lại /me.
    const res = await route.fetch().catch(() => null);
    if (!res) return route.continue();
    const text = await res.text();
    let body: Record<string, any>;
    try {
      body = JSON.parse(text) as Record<string, any>;
    } catch {
      return route.fulfill({ response: res, body: text });
    }
    const d = body.data ?? body;
    if (d.prefs) d.prefs.default_scope = cta;
    if (d.scope) d.scope.active_company_id = cta;
    await route.fulfill({ response: res, json: body });
  });
}

/** Ô nhập số tiền của hộp thoại gán cấn trừ (FgMoneyInput, aria-label "Số tiền"). */
const amountBox = (scope: Page | Locator): Locator => scope.getByLabel('Số tiền', { exact: true });

/** Mở "Gán phiếu cấn trừ" trên khoản công nợ. */
async function openAssignDialog(page: Page, debtId: string): Promise<Locator> {
  await page.goto(`/cong-no/phieu/${debtId}`);
  await page.getByRole('button', { name: '+ Gán phiếu cấn trừ' }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Gán phiếu cấn trừ');
  return dlg;
}

/** Tìm phiếu theo mã trong hộp thoại, nhập số tiền tuỳ chọn rồi bấm "Gán" trên đúng dòng. */
async function assignCandidate(dlg: Locator, code: string, amountMinor?: number): Promise<void> {
  await dlg.getByPlaceholder('VD: PT-2026 hoặc nội dung').fill(code);
  const row = rowWith(dlg, code);
  await expect(row).toBeVisible({ timeout: 15_000 });
  if (amountMinor !== undefined) await amountBox(dlg).fill(String(amountMinor));
  await row.getByRole('button', { name: 'Gán', exact: true }).click();
}

/** Khối "Cấn trừ bằng phiếu" trên màn chi tiết khoản công nợ. */
const linkCard = (page: Page): Locator => page.locator('.ant-card').filter({ hasText: LINK_HEAD }).first();

/** Thứ tự cột: tìm chỉ số cột theo tiêu đề rồi lấy ô tương ứng trong dòng. */
async function cellUnder(page: Page, row: Locator, header: string): Promise<Locator> {
  const heads = (await page.locator('thead th').allTextContents()).map((t) => t.trim());
  const idx = heads.findIndex((h) => h === header);
  expect(idx, `có cột "${header}"`).toBeGreaterThanOrEqual(0);
  return row.locator('td').nth(idx);
}

test.describe('Công nợ — phải thu / phải trả, cấn trừ, tuổi nợ (v2 §9, §5.3, §11)', () => {
  test.describe.configure({ timeout: 240_000 });

  const restores: Array<() => Promise<void>> = [];
  test.beforeAll(async () => {
    for (const email of [USERS.staff, USERS.chief, USERS.director]) restores.push(await useCtaScope(email));
  });
  test.afterAll(async () => {
    for (const restore of restores.reverse()) await restore();
  });

  /* ------------------------------------------------------------------ *
   * 0. Nền: chuỗi lập → duyệt → thực thi qua API (phục vụ các kịch bản bên dưới)
   * ------------------------------------------------------------------ */

  test('0. Nền API: phiếu thu tự thực thi khi duyệt xong; phiếu chi thực thi được qua API', async () => {
    const cta = await ctaId();
    const cust = await createPartner('customer', uniq('KH debts N0'));
    const sup = await createPartner('supplier', uniq('NCC debts N0'));
    const staff = await apiAs('staff');

    const inc = await createVoucher('income', cust.id, 1_000_000, uniq('Thu N0'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');
    const incDoc = await getDoc(inc.id, staff);
    expect(String(incDoc.company_id)).toBe(cta);
    expect(String(incDoc.partner_id)).toBe(cust.id);

    // Phiếu chi vừa gửi: chỉ đang chờ duyệt, chưa thực thi
    const spendSent = await createVoucher('spend', sup.id, 500_000, uniq('Chi N0a'));
    await submitVoucher(spendSent.id);
    expect(['pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptgd']).toContain((await getDoc(spendSent.id)).status);

    // Phiếu chi đã duyệt xong (approved) → thực thi → paid
    const spend = await createVoucher('spend', sup.id, 500_000, uniq('Chi N0'));
    expect(await runVoucherToPaid('spend', spend.id)).toBe('paid');
  });

  /* ------------------------------------------------------------------ *
   * A. Tạo khoản công nợ (US-DEBT-01, US-DEBT-04)
   * ------------------------------------------------------------------ */

  test('A1 KTV ghi khoản Phải thu cho khách hàng bằng biểu mẫu (US-DEBT-01)', async ({ as }) => {
    const cta = await ctaId();
    const cust = await createPartner('customer', uniq('KH debts A1'));
    const contract = `HD-A1-${Date.now().toString(36)}`;
    const due = vnToday(30);
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);

    await page.goto('/cong-no/moi');
    await pickPartner(page, 'Khách hàng / Nhà cung cấp', cust.name);
    await chooseDirection(page, 'receivable');
    await amountBox(page).fill('5000000');
    const dateInput = fieldRoot(page, 'Hạn thanh toán').locator('input').first();
    await dateInput.click();
    await dateInput.fill(dmy(due));
    await dateInput.press('Enter');
    await fieldRoot(page, 'Số hợp đồng').locator('input').fill(contract);
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();

    await expect(page).toHaveURL(/\/cong-no\/phieu\/[0-9a-f]{24}$/, { timeout: 20_000 });
    const debtId = page.url().split('/').pop() as string;
    await expect(page.locator('h1.fg-page-title')).toContainText(cust.name);
    await expect(page.locator('.fg-page-meta')).toContainText('Khách hàng · TK 131 · Phải thu (ghi Nợ)');
    await expect(kpi(page, 'Giá trị')).toContainText(vnd(5_000_000));
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(5_000_000));
    await expect(page.getByText(contract, { exact: true })).toBeVisible();

    const d = await getDebt(debtId);
    expect(String(d.company_id)).toBe(cta);
    expect(d.partner_id).toBe(cust.id);
    expect(d.direction).toBe('receivable');
    expect(d.party_type).toBe('customer');
    expect(d.account_code).toBe('131');
    expect(d.side).toBe('debit');
    expect(d.value.minor).toBe('5000000');
    expect(d.due_date).toBe(due);
    expect(d.contract_code).toBe(contract);
    expectNoErrors(w);
  });

  test('A2 KTV ghi khoản Phải trả cho nhà cung cấp (US-DEBT-01)', async ({ as }) => {
    const sup = await createPartner('supplier', uniq('NCC debts A2'));
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);

    await page.goto('/cong-no/moi');
    await pickPartner(page, 'Khách hàng / Nhà cung cấp', sup.name);
    await chooseDirection(page, 'payable');
    await amountBox(page).fill('3000000');
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();

    await expect(page).toHaveURL(/\/cong-no\/phieu\/[0-9a-f]{24}$/, { timeout: 20_000 });
    const debtId = page.url().split('/').pop() as string;
    await expect(page.locator('.fg-page-meta')).toContainText('Nhà cung cấp · TK 331 · Phải trả (ghi Có)');
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(3_000_000));

    const d = await getDebt(debtId);
    expect(d.direction).toBe('payable');
    expect(d.party_type).toBe('supplier');
    expect(d.account_code).toBe('331');
    expect(d.side).toBe('credit');
    expectNoErrors(w);
  });

  test('A3 Chéo: ứng trước cho NCC là khoản Phải thu (TK 331, ghi Nợ) — US-DEBT-04', async ({ as }) => {
    const sup = await createPartner('supplier', uniq('NCC debts A3'));
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);

    await page.goto('/cong-no/moi');
    await pickPartner(page, 'Khách hàng / Nhà cung cấp', sup.name);
    await chooseDirection(page, 'receivable');
    await amountBox(page).fill('800000');
    await fieldRoot(page, 'Ghi chú').locator('textarea').fill('Ứng trước cho NCC theo hợp đồng');
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();

    await expect(page).toHaveURL(/\/cong-no\/phieu\/[0-9a-f]{24}$/, { timeout: 20_000 });
    const debtId = page.url().split('/').pop() as string;
    await expect(page.locator('.fg-page-meta')).toContainText('Nhà cung cấp · TK 331 · Phải thu (ghi Nợ)');

    const d = await getDebt(debtId);
    expect(d.direction).toBe('receivable');
    expect(d.party_type).toBe('supplier');
    expect(d.account_code).toBe('331');
    expect(d.side).toBe('debit');
    expectNoErrors(w);
  });

  test('A4 Chéo: khách hàng đặt cọc là khoản Phải trả (TK 131, ghi Có) — US-DEBT-04', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts A4'));
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);

    await page.goto('/cong-no/moi');
    await pickPartner(page, 'Khách hàng / Nhà cung cấp', cust.name);
    await chooseDirection(page, 'payable');
    await amountBox(page).fill('1200000');
    await fieldRoot(page, 'Ghi chú').locator('textarea').fill('Khách đặt cọc, hoàn lại khi nghiệm thu');
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();

    await expect(page).toHaveURL(/\/cong-no\/phieu\/[0-9a-f]{24}$/, { timeout: 20_000 });
    const debtId = page.url().split('/').pop() as string;
    await expect(page.locator('.fg-page-meta')).toContainText('Khách hàng · TK 131 · Phải trả (ghi Có)');

    const d = await getDebt(debtId);
    expect(d.direction).toBe('payable');
    expect(d.party_type).toBe('customer');
    expect(d.account_code).toBe('131');
    expect(d.side).toBe('credit');
    expectNoErrors(w);
  });

  test('A5 Ngân hàng không chọn được làm đối tác công nợ (chỉ KH / NCC) — v2 §5.2', async ({ as }) => {
    const cta = await ctaId();
    const bank = await createPartner('bank', uniq('NH debts A5'), { bank_name: 'Ngân hàng thử A5', account_number: accountNo() });
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);

    await page.goto('/cong-no/moi');
    const combo = fieldRoot(page, 'Khách hàng / Nhà cung cấp').locator('input[role="combobox"]').first();
    await combo.click();
    await combo.fill(bank.name);
    await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('Không có đối tác phù hợp')).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');

    // Máy chủ cũng từ chối đối tác ngân hàng khi gọi trực tiếp
    const staff = await apiAs('staff');
    const r = await api(staff, 'POST', '/api/v1/debts', {
      company: cta,
      body: {
        company_id: cta,
        partner_id: bank.id,
        direction: 'receivable',
        value: { amount_minor: '1000000', currency: 'VND' },
        due_date: vnToday(10),
        request_id: crypto.randomUUID(),
      },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.text).toContain('FG-PARTNER-001');
    expectNoErrors(w);
  });

  test('A6 Biểu mẫu chặn lưu khi thiếu đối tác, số tiền ≤ 0 hoặc chưa chọn hướng', async ({ as }) => {
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto('/cong-no/moi');

    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();
    await expect(page.getByText('Chọn khách hàng hoặc nhà cung cấp')).toBeVisible();
    expect(page.url()).toContain('/cong-no/moi');

    // Thứ tự kiểm tra của biểu mẫu: đối tác → số tiền → hạn → hướng.
    const cust = await createPartner('customer', uniq('KH debts A6'));
    await pickPartner(page, 'Khách hàng / Nhà cung cấp', cust.name);
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();
    await expect(page.getByText('Nhập số tiền lớn hơn 0')).toBeVisible();

    await amountBox(page).fill('0');
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();
    await expect(page.getByText('Nhập số tiền lớn hơn 0')).toBeVisible();

    await amountBox(page).fill('5000000');
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();
    await expect(page.getByText('Chọn hướng: phải thu (đối tác nợ công ty)')).toBeVisible();
    expect(page.url()).toContain('/cong-no/moi');
    expectNoErrors(w);
  });

  test('A9 Đối tác ngừng giao dịch không chọn được cho khoản công nợ mới; khoản cũ giữ nguyên (v2 §5.1)', async ({ as }) => {
    const cta = await ctaId();
    const cust = await createPartner('customer', uniq('KH debts A9'));
    const old = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));
    const staff = await apiAs('staff');
    must(
      await api(staff, 'PATCH', `/api/v1/partners/${cust.id}`, { company: cta, body: { status: 'inactive', request_id: crypto.randomUUID() } }),
      'ngừng giao dịch đối tác',
    );

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto('/cong-no/moi');
    const combo = fieldRoot(page, 'Khách hàng / Nhà cung cấp').locator('input[role="combobox"]').first();
    await combo.click();
    await combo.fill(cust.name);
    await expect(page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('Không có đối tác phù hợp')).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');

    const r = await api(staff, 'POST', '/api/v1/debts', {
      company: cta,
      body: {
        company_id: cta,
        partner_id: cust.id,
        direction: 'receivable',
        value: { amount_minor: '1000000', currency: 'VND' },
        due_date: vnToday(10),
        request_id: crypto.randomUUID(),
      },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.text).toContain('FG-PARTNER-001');

    // Khoản đã có vẫn mở được và giữ nguyên số liệu
    await page.goto(`/cong-no/phieu/${old.id}`);
    await expect(page.locator('h1.fg-page-title')).toContainText(old.code);
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(1_000_000));
    expectNoErrors(w);
  });

  test('A7 Nút Ghi nợ trên đối tác mở hộp thoại hướng rồi điền sẵn đối tác + hướng (US-PAR-03/05)', async ({ as }) => {
    const sup = await createPartner('supplier', uniq('NCC debts A7'));
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);

    await page.goto('/doi-tac');
    await page.getByLabel('Tìm đối tác').fill(sup.name);
    await page.getByRole('button', { name: `Thao tác với ${sup.name}` }).click();
    await page.getByRole('menuitem', { name: 'Ghi nợ' }).click();

    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Ghi nợ — chọn hướng khoản công nợ');
    await dlg.getByText('Phải trả', { exact: true }).click();
    await dlg.getByRole('button', { name: 'Tiếp tục' }).click();

    await expect(page).toHaveURL(new RegExp(`/cong-no/moi\\?.*partner_id=${sup.id}`), { timeout: 20_000 });
    await expect(page).toHaveURL(/direction=payable/);
    await expect(fieldRoot(page, 'Khách hàng / Nhà cung cấp')).toContainText(sup.name);
    await amountBox(page).fill('2000000');
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();

    await expect(page).toHaveURL(/\/cong-no\/phieu\/[0-9a-f]{24}$/, { timeout: 20_000 });
    await expect(page.locator('.fg-page-meta')).toContainText('Nhà cung cấp · TK 331 · Phải trả (ghi Có)');
    expectNoErrors(w);
  });

  test('A8 [lỗi giao diện] Hướng công nợ: bấm "Phải thu" trên biểu mẫu mới phải đặt được hướng (v2 §9.1)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts A8'));
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);

    await page.goto('/cong-no/moi');
    await pickPartner(page, 'Khách hàng / Nhà cung cấp', cust.name);
    await amountBox(page).fill('1000000');
    // Chưa chọn hướng nên phần Tóm tắt phải báo "Chưa chọn" (v2 §9.1: người dùng chọn, không mặc định).
    const summaryDirection = page.locator('.fg-stat-row').filter({ hasText: 'Hướng' }).first();
    await expect(summaryDirection).toContainText('Chưa chọn');

    await fieldRoot(page, 'Hướng công nợ').getByText('Phải thu', { exact: true }).click();
    await expect(summaryDirection).toContainText('Phải thu · ghi Nợ');
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();
    await expect(page).toHaveURL(/\/cong-no\/phieu\/[0-9a-f]{24}$/, { timeout: 20_000 });
    // Không còn lỗi "Chọn hướng" và hướng đã lưu đúng (phải thu → ghi Nợ, TK 131)
    await expect(page.getByText('Chọn hướng', { exact: false })).toHaveCount(0);
    const debtId = page.url().split('/').pop() as string;
    const d = await getDebt(debtId);
    expect(d.direction).toBe('receivable');
    expect(d.side).toBe('debit');
    expect(d.account_code).toBe('131');
    expectNoErrors(w);
  });

  /* ------------------------------------------------------------------ *
   * B. Cấn trừ: gán / gỡ / giới hạn / trả nợ (US-DEBT-02, US-PAR-04)
   * ------------------------------------------------------------------ */

  test('B1 Gán phiếu thu đã thực thi vào khoản Phải thu: đã cấn trừ tăng, còn lại giảm (US-DEBT-02)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts B1'));
    const debt = await createDebt(cust.id, 'receivable', 5_000_000, vnToday(30));
    const inc = await createVoucher('income', cust.id, 2_000_000, uniq('Thu B1'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    const dlg = await openAssignDialog(page, debt.id);
    await expect(page.locator('h1.fg-page-title')).toContainText(debt.code);
    await assignCandidate(dlg, (await codeOf(inc.id))); // bỏ trống số tiền = phần còn lại của phiếu

    await expect(page.locator('.ant-message')).toContainText('Đã gán phiếu cấn trừ');
    await expect(kpi(page, 'Đã cấn trừ')).toContainText(vnd(2_000_000));
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(3_000_000));
    await expect(page.getByText('Cấn một phần', { exact: true })).toBeVisible();
    await expect(rowWith(linkCard(page), (await codeOf(inc.id)))).toContainText('Đã cấn trừ');
    await expect(rowWith(linkCard(page), (await codeOf(inc.id)))).toContainText('Thủ công');
    await expect(rowWith(linkCard(page), (await codeOf(inc.id)))).toContainText(vnd(2_000_000));

    const d = await getDebt(debt.id);
    expect(d.offset_applied.minor).toBe('2000000');
    expect(d.remaining.minor).toBe('3000000');
    expect(d.status).toBe('partial');
    expectNoErrors(w);
  });

  test('B2 Gán phiếu chi đã thực thi vào khoản Phải trả với số tiền phân bổ tuỳ ý (US-DEBT-02)', async ({ as }) => {
    const sup = await createPartner('supplier', uniq('NCC debts B2'));
    const debt = await createDebt(sup.id, 'payable', 4_000_000, vnToday(20));
    const spend = await createVoucher('spend', sup.id, 1_500_000, uniq('Chi B2'));
    expect(await runVoucherToPaid('spend', spend.id)).toBe('paid');

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    const dlg = await openAssignDialog(page, debt.id);
    await assignCandidate(dlg, (await codeOf(spend.id)), 1_000_000);

    await expect(page.locator('.ant-message')).toContainText('Đã gán phiếu cấn trừ');
    await expect(kpi(page, 'Đã cấn trừ')).toContainText(vnd(1_000_000));
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(3_000_000));
    await expect(rowWith(linkCard(page), (await codeOf(spend.id)))).toContainText(vnd(1_000_000));

    const d = await getDebt(debt.id);
    expect(d.direction).toBe('payable');
    expect(d.offset_applied.minor).toBe('1000000');
    expect(d.remaining.minor).toBe('3000000');
    expectNoErrors(w);
  });

  test('B3 Phiếu chi chưa thực thi chỉ giữ chỗ, không trừ khoản; thực thi xong mới trừ (US-DEBT-02, v2 §9.2)', async ({ as }) => {
    const sup = await createPartner('supplier', uniq('NCC debts B3'));
    const debt = await createDebt(sup.id, 'payable', 4_000_000, vnToday(20));
    const spend = await createVoucher('spend', sup.id, 1_000_000, uniq('Chi B3'));
    await submitVoucher(spend.id); // đang chờ kế toán trưởng duyệt — chưa thực thi

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    const dlg = await openAssignDialog(page, debt.id);
    await assignCandidate(dlg, (await codeOf(spend.id)));

    await expect(page.locator('.ant-message')).toContainText('Đã gán phiếu cấn trừ');
    await expect(kpi(page, 'Đã cấn trừ')).toContainText(vnd(0));
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(4_000_000));
    await expect(rowWith(linkCard(page), (await codeOf(spend.id)))).toContainText('Chờ thực thi — chưa trừ');

    // Đối tác: phần đã giữ chỗ vẫn làm giảm "Còn có thể trả" (không làm giảm "Còn lại")
    const staff = await apiAs('staff');
    const cta = await ctaId();
    const partnerDebts = (await api(staff, 'GET', `/api/v1/partners/${sup.id}/debts`, { company: cta })).json as {
      items: { _id: string; available: { minor: string }; remaining: { minor: string } }[];
    };
    const row = partnerDebts.items.find((x) => x._id === debt.id);
    expect(row?.available.minor).toBe('3000000');
    expect(row?.remaining.minor).toBe('4000000');

    // Thực thi phiếu chi: duyệt xong → UNC + số tham chiếu → đã chi
    expect(await approveToEnd(spend.id)).toBe('approved');
    await payVoucher(spend.id);
    expect((await getDoc(spend.id)).status).toBe('paid');

    await page.reload();
    await expect(kpi(page, 'Đã cấn trừ')).toContainText(vnd(1_000_000));
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(3_000_000));
    await expect(rowWith(linkCard(page), (await codeOf(spend.id)))).toContainText('Đã cấn trừ');
    expectNoErrors(w);
  });

  test('B4 Chặn cấn trừ vượt số còn lại của khoản hoặc của phiếu; đủ số thì khoản chuyển "Đã cấn đủ" (v2 §9.2)', async ({ as }) => {
    const cta = await ctaId();
    const cust = await createPartner('customer', uniq('KH debts B4'));
    const debt = await createDebt(cust.id, 'receivable', 2_000_000, vnToday(15));
    const debt2 = await createDebt(cust.id, 'receivable', 5_000_000, vnToday(15));
    const inc = await createVoucher('income', cust.id, 3_000_000, uniq('Thu B4'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    const dlg = await openAssignDialog(page, debt.id);
    // 2.500.000 > còn lại của khoản (2.000.000) → máy chủ từ chối, không tạo liên kết
    await assignCandidate(dlg, (await codeOf(inc.id)), 2_500_000);
    await expect(page.locator('.ant-message')).toContainText('không đủ cho');
    await expect(dlg).toBeVisible();
    const afterReject = await getDebt(debt.id);
    expect(afterReject.offset_applied.minor).toBe('0');
    expect(afterReject.link_count).toBe(0);

    // Đúng bằng số còn lại của khoản → được phép, khoản về 0
    await amountBox(dlg).fill('2000000');
    // Chờ danh sách ứng viên tải xong (máy chủ có thể đang khởi động lại) rồi mới bấm Gán
    const code2 = await codeOf(inc.id);
    await expect(rowWith(dlg, code2)).toBeVisible({ timeout: 30_000 });
    await rowWith(dlg, code2).getByRole('button', { name: 'Gán', exact: true }).click();
    await expect(page.locator('.ant-message')).toContainText('Đã gán phiếu cấn trừ');
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(0));
    await expect(page.getByText('Đã cấn đủ', { exact: true }).first()).toBeVisible();

    // Phiếu còn 1.000.000 chưa phân bổ: gán cho khoản khác vượt mức phiếu còn lại → bị chặn
    const dlg2 = await openAssignDialog(page, debt2.id);
    await assignCandidate(dlg2, (await codeOf(inc.id)), 1_500_000);
    await expect(page.locator('.ant-message')).toContainText('không đủ cho');
    const debt2Now = await getDebt(debt2.id);
    expect(debt2Now.offset_applied.minor).toBe('0');
    const incDoc = await getDoc(inc.id);
    expect(incDoc.links.filter((l: any) => l.status === 'active' && l.to_id === debt2.id)).toHaveLength(0);
    expect(cta).toBeTruthy();
    expectNoErrors(w);
  });

  test('B5 Gỡ cấn trừ phải có lý do (≥ 5 ký tự); sau khi gỡ số còn lại được tính lại ngay (v2 §9.2, §11.2)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts B5'));
    const debt = await createDebt(cust.id, 'receivable', 5_000_000, vnToday(30));
    const inc = await createVoucher('income', cust.id, 2_000_000, uniq('Thu B5'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');
    const linked = await linkDebt(debt.id, inc.id, 2_000_000);
    expect(linked.ok, `gán cấn trừ: ${linked.text}`).toBeTruthy();

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}`);
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(3_000_000));
    await rowWith(linkCard(page), (await codeOf(inc.id))).getByRole('button', { name: 'Gỡ', exact: true }).click();

    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Gỡ cấn trừ');
    const reasonBox = fieldRoot(dlg, 'Lý do gỡ liên kết').locator('input').first();
    const confirm = dlg.getByRole('button', { name: 'Gỡ liên kết', exact: true });
    await reasonBox.fill('Gán');
    await expect(confirm).toBeDisabled();
    const reason = 'Gán nhầm phiếu, sẽ gán lại sau';
    await reasonBox.fill(reason);
    await expect(confirm).toBeEnabled();
    await confirm.click();

    await expect(page.locator('.ant-message')).toContainText('Đã gỡ cấn trừ');
    await expect(kpi(page, 'Đã cấn trừ')).toContainText(vnd(0));
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(5_000_000));
    await expect(page.getByText('Chưa cấn trừ phiếu nào')).toBeVisible();

    const d = await getDebt(debt.id);
    expect(d.offset_applied.minor).toBe('0');
    expect(d.remaining.minor).toBe('5000000');
    // Liên kết vẫn còn trong sổ nhưng ở trạng thái đã gỡ, kèm lý do và người gỡ (không xoá)
    const incDoc = await getDoc(inc.id);
    const removed = (incDoc.links as any[]).find((l) => String(l.to_id) === debt.id);
    expect(removed?.status).toBe('removed');
    expect(removed?.removed_reason).toBe(reason);
    expectNoErrors(w);
  });

  test('B6 Gán và gỡ cấn trừ từ phía phiếu (tab Liên kết của phiếu thu) (v2 §11.2, US-DEBT-02)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts B6'));
    const debt = await createDebt(cust.id, 'receivable', 4_000_000, vnToday(30));
    const inc = await createVoucher('income', cust.id, 1_500_000, uniq('Thu B6'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/ho-so/thu/${inc.id}`);
    await page.getByRole('tab', { name: /Liên kết/ }).click();
    await page.getByRole('button', { name: '+ Gán liên kết' }).click();

    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Gán liên kết nghiệp vụ');
    await pickAntdOption(page, fieldRoot(dlg, 'Khoản công nợ'), new RegExp(debt.code));
    await amountBox(dlg).fill('1500000');
    await dlg.getByRole('button', { name: 'Gán liên kết', exact: true }).click();

    await expect(page.locator('.ant-message')).toContainText('Đã gán liên kết');
    await expect(rowWith(page, debt.code)).toContainText('Cấn trừ công nợ');
    await expect(rowWith(page, debt.code)).toContainText(vnd(1_500_000));
    const afterAssign = await getDebt(debt.id);
    expect(afterAssign.offset_applied.minor).toBe('1500000');
    expect(afterAssign.remaining.minor).toBe('2500000');

    // Gỡ từ phía phiếu: phải có lý do; khoản công nợ được tính lại
    await rowWith(page, debt.code).getByRole('button', { name: 'Gỡ', exact: true }).click();
    const rm = page.getByRole('dialog');
    await expect(rm).toContainText('Gỡ liên kết');
    const reason = 'Chọn nhầm khoản công nợ';
    await fieldRoot(rm, 'Lý do gỡ liên kết').locator('input').fill(reason);
    await rm.getByRole('button', { name: 'Gỡ liên kết', exact: true }).click();

    await expect(page.locator('.ant-message')).toContainText('Đã gỡ liên kết');
    await expect(rowWith(page, debt.code)).toContainText('Đã gỡ');
    await expect(rowWith(page, debt.code)).toContainText(reason);
    const afterRemove = await getDebt(debt.id);
    expect(afterRemove.offset_applied.minor).toBe('0');
    expect(afterRemove.remaining.minor).toBe('4000000');
    expectNoErrors(w);
  });

  test('B7 Trả nợ KH (Phải thu) từ đối tác: phiếu thu nháp đã gắn cấn trừ; khoản chỉ giảm khi phiếu được thực thi (US-PAR-04)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts B7'));
    const debt = await createDebt(cust.id, 'receivable', 6_000_000, vnToday(30));

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto('/doi-tac');
    await page.getByLabel('Tìm đối tác').fill(cust.name);
    await page.getByRole('button', { name: `Thao tác với ${cust.name}` }).click();
    await page.getByRole('menuitem', { name: 'Trả nợ' }).click();

    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText(`Trả nợ — ${cust.name}`);
    await rowWith(dlg, debt.code).getByRole('checkbox').check();
    await dlg.getByLabel(`Số tiền ${debt.code}`).fill('2000000');
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();

    await expect(page).toHaveURL(/\/ho-so\/thu\/[0-9a-f]{24}$/, { timeout: 20_000 });
    const voucherId = page.url().split('/').pop() as string;
    await page.getByRole('tab', { name: /Liên kết/ }).click();
    await expect(rowWith(page, debt.code)).toContainText('Cấn trừ công nợ');
    await expect(rowWith(page, debt.code)).toContainText(vnd(2_000_000));

    // Phiếu còn là nháp: khoản chưa giảm
    const before = await getDebt(debt.id);
    expect(before.offset_applied.minor).toBe('0');
    expect(before.remaining.minor).toBe('6000000');
    await page.goto(`/cong-no/phieu/${debt.id}`);
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(6_000_000));
    await expect(linkCard(page)).toContainText('Chờ thực thi — chưa trừ');

    // Hoàn tất nháp (chọn tài khoản) → gửi → duyệt (KTT, GĐ) → phiếu thu tự thực thi → khoản giảm đúng lúc đó
    await setDraftAccount(voucherId);
    expect(await runVoucherToPaid('income', voucherId)).toBe('paid');
    await page.reload();
    await expect(kpi(page, 'Đã cấn trừ')).toContainText(vnd(2_000_000));
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(4_000_000));
    // Trên màn khoản công nợ, dòng cấn trừ hiển thị MÃ PHIẾU (không phải mã khoản)
    await expect(rowWith(linkCard(page), await codeOf(voucherId))).toContainText('Đã cấn trừ');
    expectNoErrors(w);
  });

  test('B8 Trả nợ NCC (Phải trả) từ đối tác: phiếu chi nháp đã gắn cấn trừ, thực thi xong mới trừ khoản (US-PAR-04)', async ({ as }) => {
    const sup = await createPartner('supplier', uniq('NCC debts B8'));
    const debt = await createDebt(sup.id, 'payable', 3_000_000, vnToday(20));

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/doi-tac/${sup.id}`);
    await page.getByRole('button', { name: 'Trả nợ', exact: true }).click();

    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText(`Trả nợ — ${sup.name}`);
    await rowWith(dlg, debt.code).getByRole('checkbox').check();
    await dlg.getByLabel(`Số tiền ${debt.code}`).fill('1000000');
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();

    await expect(page).toHaveURL(/\/ho-so\/chi\/[0-9a-f]{24}$/, { timeout: 20_000 });
    const spendId = page.url().split('/').pop() as string;
    await page.getByRole('tab', { name: /Liên kết/ }).click();
    await expect(rowWith(page, debt.code)).toContainText('Cấn trừ công nợ');
    await expect(rowWith(page, debt.code)).toContainText(vnd(1_000_000));
    expect((await getDebt(debt.id)).remaining.minor).toBe('3000000');

    await setDraftAccount(spendId);
    expect(await runVoucherToPaid('spend', spendId)).toBe('paid');
    await page.goto(`/cong-no/phieu/${debt.id}`);
    await expect(kpi(page, 'Đã cấn trừ')).toContainText(vnd(1_000_000));
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(2_000_000));
    expectNoErrors(w);
  });

  test('B9 Trả nợ chặn số tiền vượt "còn có thể trả" của khoản và không tạo phiếu (US-PAR-04)', async ({ as }) => {
    const cta = await ctaId();
    const cust = await createPartner('customer', uniq('KH debts B9'));
    const debt = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/doi-tac/${cust.id}`);
    await page.getByRole('button', { name: 'Trả nợ', exact: true }).click();

    const dlg = page.getByRole('dialog');
    await rowWith(dlg, debt.code).getByRole('checkbox').check();
    await dlg.getByLabel(`Số tiền ${debt.code}`).fill('1500000');
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();

    await expect(dlg.getByText(/Vượt số còn có thể trả/)).toBeVisible();
    expect(page.url()).toContain(`/doi-tac/${cust.id}`);
    const after = await getDebt(debt.id);
    expect(after.link_count).toBe(0);
    expect(after.remaining.minor).toBe('1000000');
    expect(cta).toBeTruthy();
    expectNoErrors(w);
  });

  /* ------------------------------------------------------------------ *
   * C. Tuổi nợ & quá hạn (US-DEBT-03)
   * ------------------------------------------------------------------ */

  test('C1 Giám đốc xem báo cáo tuổi nợ theo đối tác; danh sách hiện số ngày quá hạn (US-DEBT-03)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts C1'));
    const sup = await createPartner('supplier', uniq('NCC debts C1'));
    const late45 = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(-45)); // 45 ngày → 30–60
    await createDebt(cust.id, 'receivable', 500_000, vnToday(-10)); // 10 ngày → < 30
    await createDebt(cust.id, 'receivable', 300_000, vnToday(20)); // chưa đến hạn
    await createDebt(sup.id, 'payable', 2_000_000, vnToday(-100)); // 100 ngày → > 90

    const dir = await as('director');
    const w = watch(dir);
    await dir.goto('/cong-no?view=aging');
    const custRow = rowWith(dir, cust.name);
    await expect(custRow).toBeVisible({ timeout: 20_000 });
    await expect(await cellUnder(dir, custRow, 'Chưa đến hạn')).toContainText(vnd(300_000));
    await expect(await cellUnder(dir, custRow, 'Quá hạn < 30 ngày')).toContainText(vnd(500_000));
    await expect(await cellUnder(dir, custRow, '30–60 ngày')).toContainText(vnd(1_000_000));
    await expect(await cellUnder(dir, custRow, '60–90 ngày')).toContainText('—');
    await expect(await cellUnder(dir, custRow, '> 90 ngày')).toContainText('—');
    await expect(custRow).toContainText(vnd(1_800_000));

    const supRow = rowWith(dir, sup.name);
    await expect(supRow).toBeVisible();
    await expect(await cellUnder(dir, supRow, '> 90 ngày')).toContainText(vnd(2_000_000));
    await expect(supRow).toContainText('Phải trả');
    // Giám đốc chỉ xem: không có nút tạo khoản công nợ
    await expect(dir.getByText('+ Tạo khoản công nợ')).toHaveCount(0);
    expectNoErrors(w);

    // Kế toán viên: danh sách theo đối tác, cột "Quá hạn" và số ngày
    const staff = await as('staff');
    await pinCtaScope(staff);
    const sw = watch(staff);
    await staff.goto(`/cong-no?partner_id=${cust.id}`);
    await expect(rowWith(staff, '⛔ 45 ngày')).toBeVisible({ timeout: 20_000 });
    await expect(rowWith(staff, '⛔ 10 ngày')).toBeVisible();
    await expect(staff.getByText('đúng hạn', { exact: true }).first()).toBeVisible();
    await staff.goto(`/cong-no/phieu/${late45.id}`);
    await expect(staff.getByText('⛔ Quá hạn 45 ngày · 30–60 ngày', { exact: true })).toBeVisible();
    expectNoErrors(sw);
  });

  /* ------------------------------------------------------------------ *
   * D. Cột tóm tắt trên màn Đối tác (v2 §5.3)
   * ------------------------------------------------------------------ */

  test('D1 Danh sách & chi tiết đối tác: Còn phải thu / Còn phải trả / Quá hạn phản ánh cấn trừ (v2 §5.3)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts D1'));
    const ar = await createDebt(cust.id, 'receivable', 5_000_000, vnToday(-20)); // quá hạn 20 ngày
    await createDebt(cust.id, 'payable', 1_000_000, vnToday(15)); // chưa đến hạn
    const inc = await createVoucher('income', cust.id, 2_000_000, uniq('Thu D1'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');
    const linked = await linkDebt(ar.id, inc.id, 2_000_000);
    expect(linked.ok, `gán cấn trừ: ${linked.text}`).toBeTruthy();

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto('/doi-tac');
    await page.getByLabel('Tìm đối tác').fill(cust.name);
    const listRow = rowWith(page, cust.name);
    await expect(listRow).toBeVisible({ timeout: 20_000 });
    // Còn phải thu = 3.000.000 (5.000.000 − 2.000.000); còn phải trả = 1.000.000; quá hạn = 3.000.000
    await expect(listRow).toContainText(vnd(3_000_000));
    await expect(listRow).toContainText(vnd(1_000_000));

    await listRow.getByRole('link', { name: cust.name }).click();
    await expect(page.locator('h1.fg-page-title')).toContainText(cust.name);
    await expect(cardWith(page, 'Còn phải thu')).toContainText(vnd(3_000_000));
    await expect(cardWith(page, 'Còn phải trả')).toContainText(vnd(1_000_000));
    await expect(cardWith(page, 'Quá hạn')).toContainText(vnd(3_000_000));

    await page.getByRole('tab', { name: 'Công nợ' }).click();
    const arRow = rowWith(page, ar.code);
    await expect(arRow).toContainText(vnd(2_000_000));
    await expect(arRow).toContainText(vnd(3_000_000));
    await expect(arRow).toContainText('quá 20 ngày');
    expectNoErrors(w);
  });

  /* ------------------------------------------------------------------ *
   * E. Quyền (v2 §3.2: Giám đốc chỉ xem công nợ)
   * ------------------------------------------------------------------ */

  test('E1 Giám đốc (chỉ xem) không thấy nút gán cấn trừ / sửa / xoá và không gán được qua API', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts E1'));
    const debt = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));

    const page = await as('director');
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}`);
    await expect(page.locator('h1.fg-page-title')).toContainText(debt.code);
    await expect(page.getByRole('button', { name: '+ Gán phiếu cấn trừ' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Sửa', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Xoá', exact: true })).toHaveCount(0);

    const dir = await apiAs('director');
    const cta = await ctaId();
    const r = await api(dir, 'POST', `/api/v1/debts/${debt.id}/links`, {
      company: cta,
      body: { document_id: '0123456789abcdef01234567', amount_minor: '1000' },
    });
    expect(r.status).toBe(403);
    expectNoErrors(w);
  });

  /* ------------------------------------------------------------------ *
   * F. Sửa khoản đã có cấn trừ (v2 §9.1: không đổi đối tác / hướng khi đã cấn trừ; chặn xoá khi còn liên kết)
   * ------------------------------------------------------------------ */

  test('F1 Khoản đã có cấn trừ: màn Sửa khoá đối tác và hướng; chi tiết không cho xoá (v2 §9.1)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts F1'));
    const debt = await createDebt(cust.id, 'receivable', 3_000_000, vnToday(10));
    const inc = await createVoucher('income', cust.id, 1_000_000, uniq('Thu F1'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');
    const linked = await linkDebt(debt.id, inc.id, 1_000_000);
    expect(linked.ok, `gán cấn trừ: ${linked.text}`).toBeTruthy();

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}/sua`);
    await expect(page.getByText('Đã có phiếu cấn trừ: không đổi đối tác hoặc hướng', { exact: false })).toBeVisible();
    const radios = fieldRoot(page, 'Hướng công nợ').locator('input[type="radio"]');
    await expect(radios.first()).toBeDisabled();
    await expect(radios.nth(1)).toBeDisabled();
    // §5.1: khoản đã có cấn trừ khoá việc CHỌN đối tác (lockSelection)
    await expect(fieldRoot(page, 'Khách hàng / Nhà cung cấp').locator('input[role="combobox"]').first()).toBeDisabled();

    await page.goto(`/cong-no/phieu/${debt.id}`);
    await expect(page.locator('h1.fg-page-title')).toContainText(debt.code);
    await expect(page.getByRole('button', { name: 'Xoá', exact: true })).toHaveCount(0);
    expectNoErrors(w);

    // Máy chủ cũng chặn: không đổi hướng khi đã cấn trừ; không hạ giá trị dưới số đã cấn trừ
    const staff = await apiAs('staff');
    const cta = await ctaId();
    const flip = await api(staff, 'PATCH', `/api/v1/debts/${debt.id}`, { company: cta, body: { direction: 'payable' } });
    expect(flip.ok, 'không đổi hướng khi đã có cấn trừ').toBeFalsy();
    const lower = await api(staff, 'PATCH', `/api/v1/debts/${debt.id}`, {
      company: cta,
      body: { value: { amount_minor: '500000', currency: 'VND' } },
    });
    expect(lower.ok, 'không hạ giá trị xuống dưới số đã cấn trừ').toBeFalsy();
    expect(lower.text).toContain('FG-LINK-002');
    expect((await getDebt(debt.id)).value.minor).toBe('3000000');
  });

  /* ------------------------------------------------------------------ *
   * H. Quy tắc ghép cấn trừ (v2 §9.2, §11.2)
   * ------------------------------------------------------------------ */

  test('H1 Cấn trừ chỉ ghép đúng hướng và đúng đối tác: phiếu chi không vào khoản phải thu; phiếu đối tác khác bị chặn', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts H1'));
    const other = await createPartner('customer', uniq('KH debts H1b'));
    const ar = await createDebt(cust.id, 'receivable', 2_000_000, vnToday(10));
    const spend = await createVoucher('spend', cust.id, 1_000_000, uniq('Chi H1'));
    expect(await runVoucherToPaid('spend', spend.id)).toBe('paid');
    const incOther = await createVoucher('income', other.id, 1_000_000, uniq('Thu H1b'));
    expect(await runVoucherToPaid('income', incOther.id)).toBe('paid');

    const wrongDirection = await linkDebt(ar.id, spend.id, 1_000_000);
    expect(wrongDirection.ok, 'phiếu chi không được gán vào khoản phải thu').toBeFalsy();
    expect(wrongDirection.status).toBeGreaterThanOrEqual(400);
    expect(wrongDirection.status).toBeLessThan(500);
    const wrongPartner = await linkDebt(ar.id, incOther.id, 1_000_000);
    expect(wrongPartner.ok, 'phiếu của đối tác khác không được gán').toBeFalsy();
    expect((await getDebt(ar.id)).link_count).toBe(0);

    // Giao diện: danh sách ứng viên của khoản phải thu không có phiếu chi
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    const dlg = await openAssignDialog(page, ar.id);
    const spendCode = await codeOf(spend.id);
    await dlg.getByPlaceholder('VD: PT-2026 hoặc nội dung').fill(spendCode);
    await expect(dlg.getByText('Không có phiếu thu phù hợp')).toBeVisible({ timeout: 15_000 });
    expect(await rowWith(dlg, spendCode).count()).toBe(0);
    expectNoErrors(w);
  });

  test('H2 Một phiếu thu phân bổ cho nhiều khoản; một khoản nhận từ nhiều phiếu (v2 §9.2)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts H2'));
    const d1 = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));
    const d2 = await createDebt(cust.id, 'receivable', 3_000_000, vnToday(10));
    const inc = await createVoucher('income', cust.id, 3_000_000, uniq('Thu H2'));
    const inc2 = await createVoucher('income', cust.id, 500_000, uniq('Thu H2b'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');
    expect(await runVoucherToPaid('income', inc2.id)).toBe('paid');
    const incCode = await codeOf(inc.id);
    const inc2Code = await codeOf(inc2.id);

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    const dlg1 = await openAssignDialog(page, d1.id);
    await assignCandidate(dlg1, incCode, 1_000_000);
    await expect(page.locator('.ant-message')).toContainText('Đã gán phiếu cấn trừ');

    const dlg2 = await openAssignDialog(page, d2.id);
    await assignCandidate(dlg2, incCode, 2_000_000);
    await expect(page.locator('.ant-message')).toContainText('Đã gán phiếu cấn trừ');
    const dlg3 = await openAssignDialog(page, d2.id);
    await assignCandidate(dlg3, inc2Code, 500_000);
    await expect(page.locator('.ant-message')).toContainText('Đã gán phiếu cấn trừ');

    // Khoản d2 nhận từ hai phiếu: đã cấn 2.500.000, còn lại 500.000
    await expect(kpi(page, 'Đã cấn trừ')).toContainText(vnd(2_500_000));
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(500_000));
    await expect(rowWith(linkCard(page), incCode)).toContainText(vnd(2_000_000));
    await expect(rowWith(linkCard(page), inc2Code)).toContainText(vnd(500_000));

    // Phiếu inc đã phân bổ hết (1.000.000 + 2.000.000): với khoản CHƯA gán, ứng viên không còn nút "Gán"
    const d3 = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));
    const dlg4 = await openAssignDialog(page, d3.id);
    await dlg4.getByPlaceholder('VD: PT-2026 hoặc nội dung').fill(incCode);
    await expect(rowWith(dlg4, incCode).getByRole('button', { name: 'Gán', exact: true })).toBeDisabled({ timeout: 15_000 });
    expectNoErrors(w);
  });

  test('H3 Huỷ phiếu đang giữ chỗ cấn trừ: số còn có thể trả được tính lại ngay (v2 §9.2)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts H3'));
    const debt = await createDebt(cust.id, 'receivable', 3_000_000, vnToday(10));
    const draft = await createVoucher('income', cust.id, 1_000_000, uniq('Thu H3'));
    const linked = await linkDebt(debt.id, draft.id, 1_000_000);
    expect(linked.ok, `gán phiếu nháp: ${linked.text}`).toBeTruthy();

    const staff = await apiAs('staff');
    const cta = await ctaId();
    const available = async (): Promise<string | undefined> => {
      const r = (await api(staff, 'GET', `/api/v1/partners/${cust.id}/debts`, { company: cta })).json as {
        items: { _id: string; available: { minor: string } }[];
      };
      return r.items.find((x) => x._id === debt.id)?.available.minor;
    };
    expect(await available()).toBe('2000000'); // phiếu nháp đang giữ 1.000.000

    const cancelled = await transition(staff, draft.id, 'cancel', { opinion: 'Huỷ phiếu nháp kiểm thử' });
    must(cancelled, 'huỷ phiếu nháp');
    expect(await available()).toBe('3000000');
    expect((await getDebt(debt.id)).remaining.minor).toBe('3000000');

    // Giao diện: liên kết tới phiếu đã huỷ được cảnh báo để gỡ
    const page = await as('staff');
    await pinCtaScope(page);
    await page.goto(`/cong-no/phieu/${debt.id}`);
    await expect(page.getByText('Có liên kết tới phiếu đã huỷ / từ chối / hết hạn', { exact: false })).toBeVisible();
    await expect(rowWith(linkCard(page), await codeOf(draft.id))).toContainText('Hủy');
  });

  test('H3b Phiếu đã huỷ không còn hiệu lực cấn trừ: dòng liên kết không ghi "Chờ thực thi — chưa trừ" (v2 §9.2)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts H3b'));
    const debt = await createDebt(cust.id, 'receivable', 3_000_000, vnToday(10));
    const draft = await createVoucher('income', cust.id, 1_000_000, uniq('Thu H3b'));
    const linked = await linkDebt(debt.id, draft.id, 1_000_000);
    expect(linked.ok, `gán phiếu nháp: ${linked.text}`).toBeTruthy();
    const staff = await apiAs('staff');
    must(await transition(staff, draft.id, 'cancel', { opinion: 'Huỷ phiếu nháp kiểm thử' }), 'huỷ phiếu nháp');

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}`);
    const row = rowWith(linkCard(page), await codeOf(draft.id));
    await expect(row).toBeVisible();
    // Cột "Trạng thái phiếu" = Hủy; cột "Hiệu lực" phải là "Không còn hiệu lực" (không "Chờ thực thi — chưa trừ")
    await expect(row).toContainText('Hủy');
    await expect(row).toContainText('Không còn hiệu lực');
    await expect(row).not.toContainText('Chờ thực thi');
    await expect(row).not.toContainText('Đã cấn trừ');
    // Số liệu không đổi: đã cấn 0, còn lại 3.000.000 (đối chiếu API)
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(3_000_000));
    expect((await getDebt(debt.id)).offset_applied.minor).toBe('0');
    expectNoErrors(w);
  });

  test('H4 Phiếu chi bị từ chối: giữ chỗ được trả lại và khoản hiện cảnh báo liên kết đã từ chối (v2 §9.2)', async ({ as }) => {
    const sup = await createPartner('supplier', uniq('NCC debts H4'));
    const debt = await createDebt(sup.id, 'payable', 3_000_000, vnToday(10));
    const spend = await createVoucher('spend', sup.id, 1_000_000, uniq('Chi H4'));
    await submitVoucher(spend.id);
    const linked = await linkDebt(debt.id, spend.id, 1_000_000);
    expect(linked.ok, `gán phiếu chờ duyệt: ${linked.text}`).toBeTruthy();

    const staff = await apiAs('staff');
    const cta = await ctaId();
    const available = async (): Promise<string | undefined> => {
      const r = (await api(staff, 'GET', `/api/v1/partners/${sup.id}/debts`, { company: cta })).json as {
        items: { _id: string; available: { minor: string } }[];
      };
      return r.items.find((x) => x._id === debt.id)?.available.minor;
    };
    expect(await available()).toBe('2000000');

    // Kế toán trưởng từ chối (kèm lý do)
    const ktt = await apiAs('chief');
    const rejected = await transition(ktt, spend.id, 'reject', {
      opinion: 'Sai đối tác, từ chối kiểm thử',
      reason: 'Sai đối tác, từ chối kiểm thử',
      verify: { method: 'password', value: PASSWORD },
    });
    must(rejected, 'từ chối phiếu chi');
    expect((await getDoc(spend.id)).status).toBe('rejected');
    expect(await available()).toBe('3000000');

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}`);
    await expect(page.getByText('Có liên kết tới phiếu đã huỷ / từ chối / hết hạn', { exact: false })).toBeVisible();
    await expect(kpi(page, 'Còn lại')).toContainText(vnd(3_000_000));
    // Dòng liên kết phiếu bị từ chối: trạng thái "Từ chối", hiệu lực "Không còn hiệu lực" (không "Chờ thực thi — chưa trừ")
    const row = rowWith(linkCard(page), await codeOf(spend.id));
    await expect(row).toContainText('Từ chối');
    await expect(row).toContainText('Không còn hiệu lực');
    await expect(row).not.toContainText('Chờ thực thi');
    expect((await getDebt(debt.id)).offset_applied.minor).toBe('0');
    expectNoErrors(w);
  });

  test('H5 Trả nợ đồng thời cả hai hướng (KH vừa phải thu vừa phải trả): hệ thống tạo 2 phiếu nháp, mỗi phiếu gắn đúng khoản (US-PAR-04)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts H5'));
    const ar = await createDebt(cust.id, 'receivable', 1_500_000, vnToday(10));
    const ap = await createDebt(cust.id, 'payable', 800_000, vnToday(10));

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto('/doi-tac');
    await page.getByLabel('Tìm đối tác').fill(cust.name);
    await page.getByRole('button', { name: `Thao tác với ${cust.name}` }).click();
    await page.getByRole('menuitem', { name: 'Trả nợ' }).click();

    const dlg = page.getByRole('dialog');
    await rowWith(dlg, ar.code).getByRole('checkbox').check();
    await rowWith(dlg, ap.code).getByRole('checkbox').check();
    await dlg.getByLabel(`Số tiền ${ar.code}`).fill('1000000');
    await dlg.getByLabel(`Số tiền ${ap.code}`).fill('500000');
    await expect(dlg.getByText('Phiếu thu nháp: 1.000.000')).toBeVisible();
    await expect(dlg.getByText('Phiếu chi nháp: 500.000')).toBeVisible();
    await dlg.getByRole('button', { name: 'Tạo phiếu nháp', exact: true }).click();

    await expect(page.getByText('Đã tạo 2 phiếu nháp')).toBeVisible({ timeout: 20_000 });
    await expect(page).toHaveURL(/\/ho-so\/thu\/[0-9a-f]{24}$/, { timeout: 20_000 });

    // Mỗi khoản nhận đúng một liên kết; phiếu còn là nháp nên số còn lại không đổi
    const arAfter = await getDebt(ar.id);
    const apAfter = await getDebt(ap.id);
    expect(arAfter.link_count).toBe(1);
    expect(apAfter.link_count).toBe(1);
    expect(arAfter.remaining.minor).toBe('1500000');
    expect(apAfter.remaining.minor).toBe('800000');
    expectNoErrors(w);
  });

  test('H6 Không tạo trùng cùng cặp (khoản, phiếu) đang hiệu lực: gán lần hai bị chặn FG-LINK-003 (v2 §11.2)', async () => {
    const cust = await createPartner('customer', uniq('KH debts H6'));
    const debt = await createDebt(cust.id, 'receivable', 5_000_000, vnToday(10));
    const inc = await createVoucher('income', cust.id, 2_000_000, uniq('Thu H6'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');

    const first = await linkDebt(debt.id, inc.id, 1_000_000);
    expect(first.ok, `gán lần 1: ${first.text}`).toBeTruthy();
    // Còn đủ sức chứa cả hai phía (phiếu còn 1.000.000, khoản còn 4.000.000): lỗi chỉ do trùng cặp
    const again = await linkDebt(debt.id, inc.id, 500_000);
    expect(again.ok, 'gán trùng cùng cặp phải bị chặn').toBeFalsy();
    expect(again.text).toContain('FG-LINK-003');

    const after = await getDebt(debt.id);
    expect(after.link_count).toBe(1);
    expect(after.offset_applied.minor).toBe('1000000');
    expect(after.remaining.minor).toBe('4000000');
  });

  /* ------------------------------------------------------------------ *
   * G. Khoản công nợ: sửa, tìm kiếm, nhóm đã cấn đủ, chứng từ đính kèm
   * ------------------------------------------------------------------ */

  test('G1 Sửa khoản công nợ chưa cấn trừ: hạn thanh toán và ghi chú được cập nhật (US-DEBT-01)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts G1'));
    const oldDue = vnToday(10);
    const debt = await createDebt(cust.id, 'receivable', 1_000_000, oldDue);

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}/sua`);
    await expect(page.getByText(/Sửa khoản công nợ/).first()).toBeVisible({ timeout: 20_000 });
    const newDue = vnToday(40);
    const dateInput = fieldRoot(page, 'Hạn thanh toán').locator('input').first();
    // Form sửa nạp khoản hiện có sau khi tải chi tiết (useEffect). Chờ hạn cũ hiện lên rồi mới gõ hạn mới:
    // nếu gõ trước khi nạp xong, lần nạp muộn ghi đè hạn vừa gõ (PATCH gửi lại đúng hạn cũ).
    await expect(dateInput).toHaveValue(dmy(oldDue), { timeout: 20_000 });
    await dateInput.click();
    await dateInput.fill(dmy(newDue));
    await dateInput.press('Enter');
    // Chờ lịch đóng và ô hiện đúng ngày mới trước khi chạm trường khác
    await expect(page.locator('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)')).toHaveCount(0, { timeout: 10_000 });
    await expect(dateInput).toHaveValue(dmy(newDue));
    await fieldRoot(page, 'Mức ưu tiên').locator('input[role="combobox"]').first().click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option').filter({ hasText: 'Cao' }).first().click();
    await fieldRoot(page, 'Ghi chú').locator('textarea').fill('Đã gia hạn theo thoả thuận E2E');
    await expect(dateInput).toHaveValue(dmy(newDue));
    await page.getByRole('button', { name: 'Lưu thay đổi' }).click();

    await expect(page).toHaveURL(new RegExp(`/cong-no/phieu/${debt.id}$`), { timeout: 20_000 });
    // Ghi chú hiển thị ở ô mô tả; mục lịch sử "Ghi chú: — → …" cũng chứa chuỗi này nên phải khớp nguyên văn ô.
    await expect(page.locator('.ant-descriptions-item-content').getByText('Đã gia hạn theo thoả thuận E2E', { exact: true })).toBeVisible();
    const d = await getDebt(debt.id);
    expect(d.due_date).toBe(newDue);
    expect(d.note).toBe('Đã gia hạn theo thoả thuận E2E');
    expect(d.priority).toBe('high');
    expect(d.value.minor).toBe('1000000');
    expectNoErrors(w);
  });

  test('G2 Danh sách công nợ: tìm theo số hợp đồng; khoản đã cấn đủ nằm trong nhóm thu gọn (US-DEBT-01/02)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts G2'));
    const contract = `HD-G2-${Date.now().toString(36)}`;
    const full = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(-5), { contract_code: contract });
    const open = await createDebt(cust.id, 'receivable', 2_000_000, vnToday(10));
    const inc = await createVoucher('income', cust.id, 1_000_000, uniq('Thu G2'));
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');
    const linked = await linkDebt(full.id, inc.id, 1_000_000);
    expect(linked.ok, `gán cấn trừ: ${linked.text}`).toBeTruthy();

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto('/cong-no');
    const search = page.getByPlaceholder('Tìm theo đối tác, mã, số hợp đồng');
    // Khoản đã cấn đủ không nằm trong bảng chính mà ở mục thu gọn (đếm trong nút)
    await search.fill(cust.name);
    await expect(rowWith(page, open.code)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('tbody tr').filter({ hasText: full.code })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Hiện các khoản đã cấn trừ đủ \(1\)/ })).toBeVisible();

    // Tìm theo số hợp đồng: đúng khoản đã cấn đủ; mở mục thu gọn để thấy dòng
    await search.fill(contract);
    await expect(page.getByRole('button', { name: /Hiện các khoản đã cấn trừ đủ \(1\)/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /Hiện các khoản đã cấn trừ đủ/ }).click();
    await expect(rowWith(page, full.code)).toBeVisible();
    await expect(page.locator('tbody tr').filter({ hasText: open.code })).toHaveCount(0);
    expectNoErrors(w);
  });

  test('G3 Chứng từ đính kèm trên khoản công nợ: tải ảnh lên và xem được ngay trên màn chi tiết', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts G3'));
    const debt = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}`);

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const filename = `ung-tien-${Date.now().toString(36)}.png`;
    await page.locator('input[type="file"]').first().setInputFiles({ name: filename, mimeType: 'image/png', buffer: png });
    await expect(page.locator('.ant-message')).toContainText('Đã tải chứng từ lên', { timeout: 20_000 });
    await expect(page.getByRole('button', { name: `Xem ${filename}` })).toBeVisible();
    const d = await getDebt(debt.id);
    expect((d.attachments ?? []).some((a: any) => a.filename === filename)).toBeTruthy();
    expectNoErrors(w);
  });

  test('C2 Bộ lọc danh sách công nợ: hướng, nhóm tuổi nợ, chỉ quá hạn còn lại (US-DEBT-03)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts C2'));
    const late = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(-45)); // 30–60 ngày
    const soon = await createDebt(cust.id, 'receivable', 500_000, vnToday(-10)); // < 30 ngày
    const notDue = await createDebt(cust.id, 'receivable', 300_000, vnToday(20)); // chưa đến hạn
    const pay = await createDebt(cust.id, 'payable', 700_000, vnToday(-100)); // phải trả, > 90 ngày

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    const base = `/cong-no?partner_id=${cust.id}`;

    await page.goto(`${base}&direction=payable`);
    await expect(rowWith(page, pay.code)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('tbody tr').filter({ hasText: late.code })).toHaveCount(0);
    await expect(page.locator('tbody tr').filter({ hasText: soon.code })).toHaveCount(0);
    await expect(page.locator('tbody tr').filter({ hasText: notDue.code })).toHaveCount(0);

    await page.goto(`${base}&direction=receivable&bucket=d30_60`);
    await expect(rowWith(page, late.code)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('tbody tr').filter({ hasText: soon.code })).toHaveCount(0);
    await expect(page.locator('tbody tr').filter({ hasText: notDue.code })).toHaveCount(0);
    await expect(page.locator('tbody tr').filter({ hasText: pay.code })).toHaveCount(0);

    await page.goto(`${base}&overdue_only=true`);
    await expect(rowWith(page, late.code)).toBeVisible({ timeout: 20_000 });
    await expect(rowWith(page, soon.code)).toBeVisible();
    await expect(rowWith(page, pay.code)).toBeVisible();
    await expect(page.locator('tbody tr').filter({ hasText: notDue.code })).toHaveCount(0);
    expectNoErrors(w);
  });

  /* ------------------------------------------------------------------ *
   * R. Bổ sung sau vòng retest 3: lỗi /me đã sửa (C3) và các quy tắc chưa có assertion
   * ------------------------------------------------------------------ */

  test('C3 [lỗi đã sửa] /me lỗi tạm thời (502) trên màn tuổi nợ: không về màn Đăng nhập, hiện "Thử lại" rồi tự tải lại', async ({ as }) => {
    const page = await as('director');
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    let apiDown = true;
    // Chỉ /me lỗi; cookie phiên vẫn còn hợp lệ nên KHÔNG được coi là hết phiên (store.tsx: chỉ 401 / FG-AUTH-001 mới là hết phiên)
    await page.route('**/api/v1/me', (route) =>
      apiDown ? route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' }) : route.continue(),
    );

    await page.goto('/cong-no?view=aging');
    await expect(page.getByText('Hệ thống đang gặp sự cố').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Thử lại' })).toBeVisible();
    await expect(page.getByLabel('Email công việc')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/cong-no');

    // API sẵn sàng → màn tự tải lại /me và hiện lại bảng tuổi nợ, không cần bấm gì
    apiDown = false;
    await expect(page.getByText('Tuổi nợ theo đối tác').first()).toBeVisible({ timeout: 45_000 });
    expect(new URL(page.url()).pathname).toBe('/cong-no');
    expect(pageErrors, 'không có lỗi JS (pageerror) trên trang').toEqual([]);
  });

  test('C4 Nhóm tuổi nợ 60–90 ngày: khoản quá hạn 75 ngày đúng cột trên báo cáo và đúng nhãn trên chi tiết (US-DEBT-03)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts C4'));
    const late75 = await createDebt(cust.id, 'receivable', 700_000, vnToday(-75));

    const dir = await as('director');
    const w = watch(dir);
    await dir.goto('/cong-no?view=aging');
    const row = rowWith(dir, cust.name);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(await cellUnder(dir, row, '60–90 ngày')).toContainText(vnd(700_000));
    await expect(await cellUnder(dir, row, '30–60 ngày')).toContainText('—');
    await expect(await cellUnder(dir, row, 'Quá hạn < 30 ngày')).toContainText('—');
    await expect(row).toContainText(vnd(700_000));
    expectNoErrors(w);

    const staff = await as('staff');
    await pinCtaScope(staff);
    await staff.goto(`/cong-no/phieu/${late75.id}`);
    await expect(staff.getByText('⛔ Quá hạn 75 ngày · 60–90 ngày', { exact: true })).toBeVisible();
  });

  test('A10 Chưa có đối tác: "+ Tạo đối tác" ngay trên form công nợ, lưu xong đối tác được chọn sẵn (US-PAR-02, v2 §5.2)', async ({ as }) => {
    const name = uniq('KH debts A10');
    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto('/cong-no/moi');

    const partnerField = fieldRoot(page, 'Khách hàng / Nhà cung cấp');
    await partnerField.getByRole('button', { name: '+ Tạo đối tác', exact: true }).click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toContainText('Tạo đối tác');
    // Loại điền sẵn theo ngữ cảnh: form công nợ chỉ KH / NCC → mặc định Khách hàng
    await expect(fieldRoot(dlg, 'Loại đối tác')).toContainText('Khách hàng');
    await fieldRoot(dlg, 'Tên đối tác').locator('input').first().fill(name);
    await dlg.getByRole('button', { name: 'Tạo đối tác', exact: true }).click();

    await expect(dlg).toBeHidden({ timeout: 20_000 });
    await expect(partnerField).toContainText(name);
    await amountBox(page).fill('750000');
    await chooseDirection(page, 'receivable');
    await page.getByRole('button', { name: 'Lưu khoản công nợ' }).click();

    await expect(page).toHaveURL(/\/cong-no\/phieu\/[0-9a-f]{24}$/, { timeout: 20_000 });
    const debtId = page.url().split('/').pop() as string;
    await expect(page.locator('h1.fg-page-title')).toContainText(name);
    await expect(page.locator('.fg-page-meta')).toContainText('Khách hàng · TK 131 · Phải thu (ghi Nợ)');
    const d = await getDebt(debtId);
    expect(d.party_type).toBe('customer');
    expect(d.partner_id).toBeTruthy();
    expectNoErrors(w);
  });

  test('A11 Đổi loại đối tác đang có khoản công nợ sang Ngân hàng bị chặn FG-PARTNER-003 (v2 §5.1)', async () => {
    const cta = await ctaId();
    const cust = await createPartner('customer', uniq('KH debts A11'));
    await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));
    const staff = await apiAs('staff');
    const r = await api(staff, 'PATCH', `/api/v1/partners/${cust.id}`, {
      company: cta,
      body: { type: 'bank', bank_name: 'Ngân hàng thử A11', account_number: accountNo(), request_id: crypto.randomUUID() },
    });
    expect(r.ok, 'không đổi sang Ngân hàng khi còn khoản công nợ').toBeFalsy();
    expect(r.text).toContain('FG-PARTNER-003');
    const g = await api(staff, 'GET', `/api/v1/partners/${cust.id}`, { company: cta });
    const p = g.json?.data?.partner ?? g.json?.data ?? g.json;
    expect(p?.type).toBe('customer');
  });

  test('A12 Phiếu đã huỷ không gán được vào khoản công nợ và không hiện trong danh sách ứng viên (v2 §9.2, §11.2)', async () => {
    const cta = await ctaId();
    const staff = await apiAs('staff');
    const cust = await createPartner('customer', uniq('KH debts A12'));
    const debt = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));
    const draft = await createVoucher('income', cust.id, 500_000, uniq('Thu A12'));
    must(await transition(staff, draft.id, 'cancel', { opinion: 'Huỷ phiếu nháp kiểm thử' }), 'huỷ phiếu nháp');

    const r = await linkDebt(debt.id, draft.id, 500_000);
    expect(r.ok, 'phiếu đã huỷ không được gán').toBeFalsy();
    expect(r.text).toContain('FG-LINK-001');
    expect((await getDebt(debt.id)).link_count).toBe(0);

    const cands = await api(staff, 'GET', `/api/v1/debts/${debt.id}/link-candidates`, { company: cta, query: { q: draft.id } });
    const items = (cands.json?.items ?? []) as { _id: string }[];
    expect(items.some((x) => String(x._id) === draft.id), 'phiếu đã huỷ không được là ứng viên').toBeFalsy();
  });

  test('E2 Giám đốc không tạo / sửa khoản công nợ qua API (chỉ xem; v2 §3.2)', async () => {
    const cta = await ctaId();
    const cust = await createPartner('customer', uniq('KH debts E2'));
    const debt = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));
    const dir = await apiAs('director');

    const created = await api(dir, 'POST', '/api/v1/debts', {
      company: cta,
      body: {
        company_id: cta,
        partner_id: cust.id,
        direction: 'receivable',
        value: { amount_minor: '100000', currency: 'VND' },
        due_date: vnToday(5),
        request_id: crypto.randomUUID(),
      },
    });
    expect(created.status).toBe(403);
    const patched = await api(dir, 'PATCH', `/api/v1/debts/${debt.id}`, { company: cta, body: { note: 'Giám đốc không được sửa' } });
    expect(patched.status).toBe(403);
    expect((await getDebt(debt.id)).note ?? null).toBeNull();
  });

  test('F2 Hạ giá trị khoản xuống dưới số đang giữ chỗ (phiếu chưa thực thi) bị chặn FG-LINK-002; hạ đúng bằng số giữ chỗ thì được (v2 §9.2)', async () => {
    const cta = await ctaId();
    const staff = await apiAs('staff');
    const cust = await createPartner('customer', uniq('KH debts F2'));
    const debt = await createDebt(cust.id, 'receivable', 3_000_000, vnToday(10));
    const inc = await createVoucher('income', cust.id, 1_000_000, uniq('Thu F2'));
    await submitVoucher(inc.id); // đang chờ duyệt: chưa thực thi nhưng vẫn giữ chỗ
    const linked = await linkDebt(debt.id, inc.id, 1_000_000);
    expect(linked.ok, `gán phiếu chờ duyệt: ${linked.text}`).toBeTruthy();

    const low = await api(staff, 'PATCH', `/api/v1/debts/${debt.id}`, { company: cta, body: { value: { amount_minor: '500000', currency: 'VND' } } });
    expect(low.ok, 'không hạ xuống dưới số đang giữ chỗ').toBeFalsy();
    expect(low.text).toContain('FG-LINK-002');
    expect((await getDebt(debt.id)).value.minor).toBe('3000000');

    must(await api(staff, 'PATCH', `/api/v1/debts/${debt.id}`, { company: cta, body: { value: { amount_minor: '1000000', currency: 'VND' } } }), 'hạ đúng số giữ chỗ');
    const after = await getDebt(debt.id);
    expect(after.value.minor).toBe('1000000');
    expect(after.remaining.minor).toBe('1000000');
    expect(after.offset_applied.minor).toBe('0');
  });

  test('G4 Đổi tên đối tác: khoản công nợ và danh sách đối tác hiển thị tên mới (không lưu bản sao, v2 §5.1)', async ({ as }) => {
    const cta = await ctaId();
    const cust = await createPartner('customer', uniq('KH debts G4'));
    const debt = await createDebt(cust.id, 'receivable', 900_000, vnToday(5));
    const newName = uniq('KH debts G4 doi ten');
    const staff = await apiAs('staff');
    must(await api(staff, 'PATCH', `/api/v1/partners/${cust.id}`, { company: cta, body: { name: newName, request_id: crypto.randomUUID() } }), 'đổi tên đối tác');
    expect((await getDebt(debt.id)).party_name).toBe(newName);

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}`);
    await expect(page.locator('h1.fg-page-title')).toContainText(newName);
    await page.goto('/doi-tac');
    await page.getByLabel('Tìm đối tác').fill(newName);
    await expect(rowWith(page, newName)).toBeVisible({ timeout: 20_000 });
    expectNoErrors(w);
  });

  test('G5 Sửa hướng khoản chưa cấn trừ trên form Sửa: bút toán Nợ/Có, TK và trang chi tiết cập nhật đúng (v2 §9.1)', async ({ as }) => {
    const cust = await createPartner('customer', uniq('KH debts G5'));
    const debt = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}/sua`);
    await expect(page.getByText(/Sửa khoản công nợ/).first()).toBeVisible({ timeout: 20_000 });
    await chooseDirection(page, 'payable');
    await page.getByRole('button', { name: 'Lưu thay đổi' }).click();

    await expect(page).toHaveURL(new RegExp(`/cong-no/phieu/${debt.id}$`), { timeout: 20_000 });
    await expect(page.locator('.fg-page-meta')).toContainText('Khách hàng · TK 131 · Phải trả (ghi Có)');
    const d = await getDebt(debt.id);
    expect(d.direction).toBe('payable');
    expect(d.side).toBe('credit');
    expect(d.account_code).toBe('131');
    expectNoErrors(w);
  });

  test('H8 Sửa số tiền phiếu xuống dưới số đã phân bổ cho khoản công nợ bị chặn FG-LINK-002; tăng lên thì được; thực thi xong số liệu đúng (v2 §9.2, §11.2)', async () => {
    const cta = await ctaId();
    const staff = await apiAs('staff');
    const cust = await createPartner('customer', uniq('KH debts H8'));
    const debt = await createDebt(cust.id, 'receivable', 2_000_000, vnToday(10));
    const inc = await createVoucher('income', cust.id, 1_000_000, uniq('Thu H8'));
    const linked = await linkDebt(debt.id, inc.id, 1_000_000);
    expect(linked.ok, `gán phiếu nháp: ${linked.text}`).toBeTruthy();

    // Tổng phân bổ cấn trừ (1.000.000) không được vượt số tiền phiếu sau khi sửa → bị chặn, phiếu giữ nguyên 1.000.000
    const doc = await getDoc(inc.id, staff);
    const low = await api(staff, 'PATCH', `/api/v1/documents/${inc.id}`, {
      company: cta,
      body: { amount: { amount_minor: '400000', currency: 'VND' }, if_match: doc.version, request_id: crypto.randomUUID() },
    });
    expect(low.ok, 'không hạ số tiền phiếu xuống dưới số đã phân bổ cấn trừ').toBeFalsy();
    expect(low.text).toContain('FG-LINK-002');
    expect(String((await getDoc(inc.id, staff)).amount?.minor), 'số tiền phiếu không bị ghi khi bị chặn').toBe('1000000');
    expect((await getDebt(debt.id)).link_count).toBe(1);

    const doc2 = await getDoc(inc.id, staff);
    must(
      await api(staff, 'PATCH', `/api/v1/documents/${inc.id}`, {
        company: cta,
        body: { amount: { amount_minor: '1200000', currency: 'VND' }, if_match: doc2.version, request_id: crypto.randomUUID() },
      }),
      'tăng số tiền phiếu',
    );

    // Thực thi: khoản chỉ giảm đúng số đã phân bổ 1.000.000 → còn lại 1.000.000 (không 1.600.000, không 0)
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');
    const after = await getDebt(debt.id);
    expect(after.offset_applied.minor).toBe('1000000');
    expect(after.remaining.minor).toBe('1000000');
    expect(after.status).toBe('partial');
    expect(after.link_count).toBe(1);
    expect(String(after.offset_links?.[0]?.amount?.minor ?? '')).toBe('1000000');
  });

  test('H9 Đổi đối tác của phiếu đang giữ cấn trừ khoản của đối tác cũ bị chặn; thực thi xong chỉ cấn trừ khoản của đối tác cũ (v2 §9.2, §11.2)', async () => {
    const cta = await ctaId();
    const staff = await apiAs('staff');
    const custA = await createPartner('customer', uniq('KH debts H9a'));
    const custB = await createPartner('customer', uniq('KH debts H9b'));
    const debt = await createDebt(custA.id, 'receivable', 2_000_000, vnToday(10));
    const debtB = await createDebt(custB.id, 'receivable', 1_000_000, vnToday(10));
    const inc = await createVoucher('income', custA.id, 1_000_000, uniq('Thu H9'));
    const linked = await linkDebt(debt.id, inc.id, 1_000_000);
    expect(linked.ok, `gán phiếu nháp: ${linked.text}`).toBeTruthy();

    const doc = await getDoc(inc.id, staff);
    const r = await api(staff, 'PATCH', `/api/v1/documents/${inc.id}`, {
      company: cta,
      body: { partner_id: custB.id, if_match: doc.version, request_id: crypto.randomUUID() },
    });
    expect(r.ok, 'không đổi đối tác khi phiếu đang cấn trừ khoản của đối tác cũ').toBeFalsy();
    expect(r.text).toMatch(/FG-(LINK|PARTNER)-00\d/);
    expect(String((await getDoc(inc.id, staff)).partner_id)).toBe(custA.id);
    expect((await getDebt(debt.id)).link_count).toBe(1);

    // Thực thi: chỉ khoản của KH A được cấn trừ (1.000.000, còn 1.000.000); khoản của KH B không bị ảnh hưởng
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');
    const a = await getDebt(debt.id);
    expect(a.offset_applied.minor).toBe('1000000');
    expect(a.remaining.minor).toBe('1000000');
    const b = await getDebt(debtB.id);
    expect(b.offset_applied.minor).toBe('0');
    expect(b.remaining.minor).toBe('1000000');
    expect(b.link_count).toBe(0);
  });

  test('H11 Cấn trừ từ phía phiếu cũng phải đúng hướng: phiếu thu không gán được vào khoản phải trả, phiếu chi không gán được vào khoản phải thu (v2 §9.2)', async () => {
    const cta = await ctaId();
    const staff = await apiAs('staff');
    const cust = await createPartner('customer', uniq('KH debts H11'));
    const ap = await createDebt(cust.id, 'payable', 1_000_000, vnToday(10)); // KH đặt cọc = phải trả (TK 131, ghi Có)
    const ar = await createDebt(cust.id, 'receivable', 1_000_000, vnToday(10));
    const inc = await createVoucher('income', cust.id, 500_000, uniq('Thu H11'));
    const inc2 = await createVoucher('income', cust.id, 500_000, uniq('Thu H11b')); // phiếu riêng cho lần thử sai hướng
    const spend = await createVoucher('spend', cust.id, 500_000, uniq('Chi H11'));

    // Đối chứng: phiếu thu → khoản phải thu (đúng hướng) gán được từ phía phiếu
    must(
      await api(staff, 'POST', `/api/v1/documents/${inc.id}/links`, {
        company: cta,
        body: { relation: 'offset', to_id: ar.id, amount_minor: '500000', request_id: crypto.randomUUID() },
      }),
      'gán đúng hướng từ phía phiếu',
    );

    const wrongIncome = await api(staff, 'POST', `/api/v1/documents/${inc2.id}/links`, {
      company: cta,
      body: { relation: 'offset', to_id: ap.id, amount_minor: '500000', request_id: crypto.randomUUID() },
    });
    // expect.soft: cả hai chiều sai hướng đều được báo, không dừng ở chiều đầu tiên
    expect.soft(wrongIncome.ok, 'phiếu thu không được cấn trừ khoản phải trả').toBeFalsy();
    expect.soft(wrongIncome.text).toContain('FG-LINK-001');

    const wrongSpend = await api(staff, 'POST', `/api/v1/documents/${spend.id}/links`, {
      company: cta,
      body: { relation: 'offset', to_id: ar.id, amount_minor: '500000', request_id: crypto.randomUUID() },
    });
    expect.soft(wrongSpend.ok, 'phiếu chi không được cấn trừ khoản phải thu').toBeFalsy();
    expect.soft(wrongSpend.text).toContain('FG-LINK-001');

    expect((await getDebt(ap.id)).link_count).toBe(0);
    expect((await getDebt(ar.id)).link_count).toBe(1);

    // Thực thi cả hai phiếu thu: chỉ khoản phải thu (đúng hướng) giảm 500.000; khoản phải trả không bị giảm bởi tiền thu
    expect(await runVoucherToPaid('income', inc.id)).toBe('paid');
    expect(await runVoucherToPaid('income', inc2.id)).toBe('paid');
    const arAfter = await getDebt(ar.id);
    expect(arAfter.offset_applied.minor).toBe('500000');
    expect(arAfter.remaining.minor).toBe('500000');
    const apAfter = await getDebt(ap.id);
    expect(apAfter.offset_applied.minor).toBe('0');
    expect(apAfter.remaining.minor).toBe('1000000');
  });

  test('H12 Đổi loại NCC → KH của đối tác đang có khoản công nợ: khoản hiển thị theo đối tác hiện tại (loại, TK 131), không giữ loại/TK cũ (v2 §5.1, §9.1)', async ({ as }) => {
    const cta = await ctaId();
    const staff = await apiAs('staff');
    const p = await createPartner('supplier', uniq('NCC debts H12'));
    const debt = await createDebt(p.id, 'payable', 1_000_000, vnToday(10));
    must(await api(staff, 'PATCH', `/api/v1/partners/${p.id}`, { company: cta, body: { type: 'customer', request_id: crypto.randomUUID() } }), 'đổi loại NCC sang KH');

    const d = await getDebt(debt.id);
    // expect.soft: báo đủ loại / TK / hiển thị, không dừng ở trường đầu tiên
    expect.soft(d.party_type, 'loại đối tác trên khoản = loại hiện tại của đối tác').toBe('customer');
    expect.soft(d.account_code, 'TK theo loại đối tác hiện tại (KH = 131)').toBe('131');
    expect.soft(d.side).toBe('credit');
    // Tab Công nợ của đối tác dùng dữ liệu lưu theo khoản (TK): cũng phải thấy TK 131 sau khi đổi loại
    const pDebts = (await api(staff, 'GET', `/api/v1/partners/${p.id}/debts`, { company: cta })).json as {
      items: { _id: string; account_code: string | null }[];
    };
    expect.soft(pDebts.items.find((x) => x._id === debt.id)?.account_code, 'tab Công nợ đối tác: TK 131 sau khi đổi loại').toBe('131');

    const page = await as('staff');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/cong-no/phieu/${debt.id}`);
    await expect.soft(page.locator('.fg-page-meta')).toContainText('Khách hàng · TK 131 · Phải trả (ghi Có)');
    expectNoErrors(w);
  });

  test('H13 Cấp duyệt hạ "Số tiền duyệt" phiếu chi đang cấn trừ xuống dưới số đã phân bổ bị chặn FG-LINK-002 (v2 §9.2, §11.2)', async () => {
    const cta = await ctaId();
    const staff = await apiAs('staff');
    const sup = await createPartner('supplier', uniq('NCC debts H13'));
    const debt = await createDebt(sup.id, 'payable', 2_000_000, vnToday(20));
    const spend = await createVoucher('spend', sup.id, 1_000_000, uniq('Chi H13'));
    await submitVoucher(spend.id); // đang chờ kế toán trưởng duyệt
    const linked = await linkDebt(debt.id, spend.id, 1_000_000);
    expect(linked.ok, `gán phiếu chờ duyệt: ${linked.text}`).toBeTruthy();

    // Kế toán trưởng (bước đang chờ) hạ số tiền duyệt xuống 400.000 — dưới số đã cấn trừ 1.000.000 → phải bị chặn
    const ktt = await apiAs('chief');
    const r = await transition(ktt, spend.id, 'approve', { amount_minor: '400000' });
    expect(r.ok, 'không duyệt với số tiền thấp hơn số đã cấn trừ').toBeFalsy();
    expect(r.text).toContain('FG-LINK-002');
    const doc = await getDoc(spend.id, staff);
    expect(doc.status).toBe('pending.ktt');
    expect(String(doc.amount?.minor)).toBe('1000000');
    expect((await getDebt(debt.id)).link_count).toBe(1);

    // Duyệt đúng số tiền rồi thực thi: khoản chỉ giảm đúng 1.000.000 (còn 1.000.000)
    expect(await approveToEnd(spend.id)).toBe('approved');
    await payVoucher(spend.id);
    const after = await getDebt(debt.id);
    expect(after.offset_applied.minor).toBe('1000000');
    expect(after.remaining.minor).toBe('1000000');
    expect(cta).toBeTruthy();
  });

  test('H13b [giao diện] KTT hạ "Số tiền duyệt" phiếu chi đang cấn trừ: màn duyệt báo FG-LINK-002, phiếu không đổi số tiền (v2 §9.2, §11.2)', async ({ as }) => {
    const sup = await createPartner('supplier', uniq('NCC debts H13b'));
    const debt = await createDebt(sup.id, 'payable', 2_000_000, vnToday(20));
    const spend = await createVoucher('spend', sup.id, 1_000_000, uniq('Chi H13b'));
    await submitVoucher(spend.id);
    const linked = await linkDebt(debt.id, spend.id, 1_000_000);
    expect(linked.ok, `gán phiếu chờ duyệt: ${linked.text}`).toBeTruthy();

    const page = await as('chief');
    await pinCtaScope(page);
    const w = watch(page);
    await page.goto(`/ho-so/chi/${spend.id}`);
    await page.getByRole('button', { name: /^Duyệt khoản/ }).click();
    const dlg = page.getByRole('dialog');
    await fieldRoot(dlg, 'Số tiền duyệt').locator('input').fill('400000');
    await dlg.getByRole('button', { name: /^Duyệt khoản/ }).click();

    // Máy chủ phải từ chối (FG-LINK-002) thay vì lưu số tiền 400.000 dưới mức đã cấn trừ
    await expect(page.getByRole('dialog').filter({ hasText: 'Không thực hiện được' })).toContainText('FG-LINK-002', { timeout: 15_000 });
    const doc = await getDoc(spend.id);
    expect(doc.status).toBe('pending.ktt');
    expect(String(doc.amount?.minor)).toBe('1000000');
    expect((await getDebt(debt.id)).link_count).toBe(1);
    expectNoErrors(w);
  });

  test('H7 Gửi lại cùng request_id khi lập khoản công nợ không tạo trùng (chống gửi lặp, v2 §11.2)', async () => {
    const cta = await ctaId();
    const staff = await apiAs('staff');
    const cust = await createPartner('customer', uniq('KH debts H7'));
    const body = {
      company_id: cta,
      partner_id: cust.id,
      direction: 'receivable',
      value: { amount_minor: '700000', currency: 'VND' },
      due_date: vnToday(10),
      request_id: crypto.randomUUID(),
    };
    const first = must<any>(await api(staff, 'POST', '/api/v1/debts', { company: cta, body }), 'lập khoản lần 1');
    const again = must<any>(await api(staff, 'POST', '/api/v1/debts', { company: cta, body }), 'gửi lại cùng request_id');
    expect(String(again.data._id)).toBe(String(first.data._id));
    const list = must<any>(await api(staff, 'GET', '/api/v1/debts', { company: cta, query: { partner_id: cust.id } }), 'danh sách khoản của đối tác');
    expect(list.total).toBe(1);
  });

  test('H13c Cấp duyệt hạ "Số tiền duyệt" đúng bằng số đã phân bổ vẫn được duyệt (ranh giới FG-LINK-002); thực thi xong số liệu đúng (v2 §9.2)', async () => {
    const staff = await apiAs('staff');
    const sup = await createPartner('supplier', uniq('NCC debts H13c'));
    const debt = await createDebt(sup.id, 'payable', 2_000_000, vnToday(20));
    const spend = await createVoucher('spend', sup.id, 1_500_000, uniq('Chi H13c'));
    await submitVoucher(spend.id);
    const linked = await linkDebt(debt.id, spend.id, 1_000_000);
    expect(linked.ok, `gán phiếu chờ duyệt: ${linked.text}`).toBeTruthy();

    // Hạ đúng bằng số đã phân bổ (1.000.000): không thấp hơn mức đó nên phải được duyệt, số tiền phiếu ghi 1.000.000
    const ktt = await apiAs('chief');
    const r = await transition(ktt, spend.id, 'approve', { amount_minor: '1000000' });
    expect(r.ok, `hạ đúng bằng số đã phân bổ phải được duyệt: ${r.text}`).toBeTruthy();
    expect(String((await getDoc(spend.id, staff)).amount?.minor)).toBe('1000000');

    expect(await approveToEnd(spend.id)).toBe('approved');
    await payVoucher(spend.id);
    const after = await getDebt(debt.id);
    expect(after.offset_applied.minor).toBe('1000000');
    expect(after.remaining.minor).toBe('1000000');
    expect(after.link_count).toBe(1);
  });

  test('H13d Duyệt kèm lý do (approve_with_reason) hạ số tiền dưới số đã phân bổ cũng bị chặn FG-LINK-002 (v2 §9.2)', async () => {
    const staff = await apiAs('staff');
    const sup = await createPartner('supplier', uniq('NCC debts H13d'));
    const debt = await createDebt(sup.id, 'payable', 2_000_000, vnToday(20));
    const spend = await createVoucher('spend', sup.id, 1_000_000, uniq('Chi H13d'));
    await submitVoucher(spend.id);
    const linked = await linkDebt(debt.id, spend.id, 1_000_000);
    expect(linked.ok, `gán phiếu chờ duyệt: ${linked.text}`).toBeTruthy();

    const ktt = await apiAs('chief');
    const r = await transition(ktt, spend.id, 'approve_with_reason', { reason: 'Đối chiếu hợp đồng, giảm số tiền', amount_minor: '400000' });
    expect(r.ok, 'duyệt kèm lý do không được hạ dưới số đã phân bổ').toBeFalsy();
    expect(r.text).toContain('FG-LINK-002');
    const doc = await getDoc(spend.id, staff);
    expect(doc.status).toBe('pending.ktt');
    expect(String(doc.amount?.minor)).toBe('1000000');
    expect((await getDebt(debt.id)).link_count).toBe(1);
  });

  test('H13e Sửa số tiền phiếu chi đang chờ duyệt xuống dưới số đã cấn trừ bị chặn FG-LINK-002 (đường sửa hồ sơ, v2 §9.2)', async () => {
    const cta = await ctaId();
    const staff = await apiAs('staff');
    const sup = await createPartner('supplier', uniq('NCC debts H13e'));
    const debt = await createDebt(sup.id, 'payable', 2_000_000, vnToday(20));
    const spend = await createVoucher('spend', sup.id, 1_500_000, uniq('Chi H13e'));
    await submitVoucher(spend.id);
    const linked = await linkDebt(debt.id, spend.id, 1_000_000);
    expect(linked.ok, `gán phiếu chờ duyệt: ${linked.text}`).toBeTruthy();

    const doc = await getDoc(spend.id, staff);
    const low = await api(staff, 'PATCH', `/api/v1/documents/${spend.id}`, {
      company: cta,
      body: { amount: { amount_minor: '400000', currency: 'VND' }, if_match: doc.version, request_id: crypto.randomUUID() },
    });
    expect(low.ok, 'không sửa số tiền phiếu xuống dưới số đã cấn trừ').toBeFalsy();
    expect(low.text).toContain('FG-LINK-002');
    expect(String((await getDoc(spend.id, staff)).amount?.minor), 'số tiền phiếu không bị ghi khi bị chặn').toBe('1500000');
    expect((await getDebt(debt.id)).link_count).toBe(1);
  });

  test('H14 Thực chi thấp hơn số đã duyệt: phiếu ghi đúng số thực chi, số tiền phiếu giữ nguyên, liên kết không bị gỡ (v2 §8)', async () => {
    const staff = await apiAs('staff');
    const sup = await createPartner('supplier', uniq('NCC debts H14'));
    const debt = await createDebt(sup.id, 'payable', 2_000_000, vnToday(20));
    const spend = await createVoucher('spend', sup.id, 1_000_000, uniq('Chi H14'));
    await submitVoucher(spend.id);
    expect(await approveToEnd(spend.id)).toBe('approved');
    const linked = await linkDebt(debt.id, spend.id, 1_000_000);
    expect(linked.ok, `gán phiếu đã duyệt: ${linked.text}`).toBeTruthy();

    // Thực chi 400.000 (thấp hơn 1.000.000 đã duyệt), có lý do ghi vào lịch sử
    await attachUnc(spend.id);
    const r = await transition(staff, spend.id, 'pay', {
      verify: { method: 'password', value: PASSWORD },
      reason: 'Thực chi ít hơn số đã duyệt',
      execution: { paid_at: vnToday(), bank_ref: `REF-H14-${Date.now().toString(36)}`, actual_amount_minor: '400000' },
    });
    expect(r.ok, `thực chi thấp hơn số đã duyệt (có lý do) phải được ghi nhận: ${r.text}`).toBeTruthy();
    const doc = await getDoc(spend.id, staff);
    expect(doc.status).toBe('paid');
    expect(String(doc.amount?.minor), 'số tiền đã duyệt của phiếu không đổi').toBe('1000000');
    expect(String(doc.execution?.actual_amount?.minor), 'số thực chi được ghi nhận').toBe('400000');
    expect((await getDebt(debt.id)).link_count, 'liên kết không bị gỡ khi thực chi thấp hơn').toBe(1);
    // CÂU HỎI MỞ (v2.md chưa quy định, không khẳng định trong test): cấn trừ hiện trừ đủ 1.000.000 dù thực chi 400.000.
    // Cần sản phẩm quyết định: giới hạn theo thực chi, chặn (FG-LINK-002), hay chấp nhận như chiết khấu thanh toán.
  });
});

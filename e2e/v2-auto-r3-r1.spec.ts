/**
 * v2 — R3 "Vay ngân hàng để chi", R1 "Chuyển tiền nội bộ", R6 "Huỷ phiếu nguồn" (v2/v2.md §7.1, §11.3, §11.5,
 * §11.6; US-AUTO-03, 04, 05, 06; US-EXE-01). Chạy trên app đang bật (không tự khởi động server):
 *
 *   PW_AREA=r3r1 npx playwright test e2e/v2-auto-r3-r1.spec.ts
 *
 * Dữ liệu: mọi tên có hậu tố duy nhất (uniq). Công ty: CTA (KTV/KTT/GĐ) và CTB (đích chuyển nội bộ).
 * Vòng kiểm lại 3: phiếu chuyển nội bộ lập qua API/UI (không gán đích bằng DB); ô "Công ty nhận" liệt kê CTB;
 * ô tài khoản hiện TÊN tài khoản; huỷ phiếu từ nút "Hủy hồ sơ"; lượt lỗi nêu nguyên nhân; panel/drawer không crash.
 * Ô "Tài khoản nguồn" (phiếu chi, cả trên modal duyệt) và "Tài khoản đích" (phiếu thu) đều hiện tên TK.
 * Chuỗi duyệt phiếu chi CTA theo số tiền (§7.2): dưới 50 triệu chỉ còn KTT (cấp PGĐ khuyết bị bỏ), 50 triệu – 5 tỷ
 * có GĐ. Các kịch bản cần GĐ duyệt dùng 60 triệu.
 * Vòng kiểm lại 4: nhãn TK ở bốn chỗ (dòng "Giải ngân vào" và khối nguồn tiền trên modal duyệt, dòng "Tài khoản nguồn"
 * ở chi tiết phiếu chi, dòng "Tài khoản đích" ở chi tiết phiếu thu tự động) phải có TÊN TK (test "nhãn TK có TÊN TK").
 * Số TK hiển thị đầy đủ theo commit d2ebf1d ("bỏ che số tài khoản"), nên spec KHÔNG khẳng định số TK bị che.
 * Vòng kiểm lại 5: điều khoản vay (số HĐ, TSĐB, lãi, kỳ hạn, hạn mặc định +11 tháng) lưu trên khoản vay; sửa điều khoản /
 * đổi TK nhận / bỏ vay trên phiếu nháp hoặc phiếu bị trả về; server từ chối vay để chi và chuyển nội bộ không hợp lệ;
 * sổ cái theo mã phiếu; báo cáo thu-chi loại chuyển nội bộ; panel "Quy trình tự động" của phiếu chuyển nội bộ;
 * màn duyệt của phiếu vay để chi; gỡ funded_by thủ công sau khi huỷ phiếu đã R3 (§11.5 ngoại lệ).
 * Kiểm lại: TK đích / TK nhận của chuyển nội bộ và số dư "Sau giao dịch" của phiếu vay để chi được kiểm bằng cả API lẫn UI.
 * Vòng kiểm lại 6: bug #1 (chuyển nội bộ thiếu TK nhận bị chặn khi lưu, khi sửa nháp và ngay trên form); bug #2 (modal duyệt
 * phiếu vay để chi: "Sau giao dịch" = 0 ₫ khi khoản vay về đúng TK nguồn trước khi chi, không báo dưới ngưỡng giả); lượt R1
 * lỗi vì TK đích bị khoá rồi chạy lại từ giao diện (một phiếu thu, cộng đúng một lần).
 */
import { randomUUID } from 'node:crypto';
import type { Browser, Page } from '@playwright/test';
import { test, expect, uniq, loginContext, type Role } from './fixtures';
import {
  type Approvers,
  alertsOf,
  approveToFinal,
  assertNoPageCrash,
  attachUnc,
  balanceOf,
  cancelFromDetail,
  companyIdsByCode,
  createBankAccount,
  createPartner,
  createSpend,
  dataOf,
  defaultScopeOf,
  digits,
  entriesOfDoc,
  fieldOf,
  generatedId,
  getDoc,
  getLoan,
  must,
  payByApi,
  pickFirstOption,
  pickLongSelect,
  pickPlainSelect,
  pickSelect,
  req,
  restoreDefaultScope,
  runsOf,
  setAccountStatus,
  sleep,
  stepOf,
  switchScope,
  transition,
  vnToday,
  visibleOptions,
  waitForRun,
  type Res,
} from './helpers-r3r1';

const T = 300_000;

/**
 * Đổi phạm vi trên giao diện ghi vào `default_scope` của người dùng (dùng chung giữa các tiến trình test).
 * Lưu giá trị gốc trước khi chạy và khôi phục sau khi xong để không ảnh hưởng người khác.
 * KTV cũng nằm trong danh sách: các ô chọn tài khoản/công ty của form phiếu chi theo công ty đang xem (CTA).
 */
const SCOPE_ROLES: Role[] = ['staff', 'chief', 'director', 'chairman'];
const originalScope: Partial<Record<Role, string | null>> = {};

/** Đăng nhập có thử lại khi API đang khởi động lại (502 / ECONNRESET). */
async function loginWithRetry(browser: Browser, role: Role) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await loginContext(browser, role);
    } catch (err) {
      if (attempt >= 6) throw err;
      await sleep(5000);
    }
  }
}

test.beforeAll(async ({ browser }) => {
  for (const role of SCOPE_ROLES) {
    const ctx = await loginWithRetry(browser, role);
    const p = await ctx.newPage();
    originalScope[role] = await defaultScopeOf(p);
    await ctx.close();
  }
});

test.afterAll(async ({ browser }) => {
  for (const role of SCOPE_ROLES) {
    const value = originalScope[role];
    if (value === undefined) continue;
    const ctx = await loginWithRetry(browser, role);
    const p = await ctx.newPage();
    await restoreDefaultScope(p, value);
    await ctx.close();
  }
});

interface World {
  staff: Page;
  chief: Page;
  director: Page;
  chairman: Page;
  CTA: string;
  CTB: string;
  approvers: Approvers;
}

/** Đăng nhập các vai trò cần cho kịch bản và lấy id công ty CTA/CTB. */
async function world(as: (r: Role) => Promise<Page>): Promise<World> {
  const staff = await as('staff');
  const chief = await as('chief');
  const director = await as('director');
  const chairman = await as('chairman');
  for (const [role, p] of [['staff', staff], ['chief', chief], ['director', director], ['chairman', chairman]] as const) logHttpErrors(p, role);
  const companies = await companyIdsByCode(chairman);
  const CTA = companies.CTA;
  const CTB = companies.CTB;
  if (!CTA || !CTB) throw new Error(`Thiếu công ty CTA/CTB: ${JSON.stringify(companies)}`);
  return { staff, chief, director, chairman, CTA, CTB, approvers: { chief, director, chairman } };
}

/** Ghi lại phản hồi HTTP lỗi (4xx/5xx) của trang: đường dẫn + mã, để biết lỗi đến từ API nào (không ghi nội dung). */
function logHttpErrors(page: Page, role: string): void {
  page.on('response', (res) => {
    if (res.status() >= 400) console.log(`[http ${res.status()} ${role}] ${res.request().method()} ${new URL(res.url()).pathname}`);
  });
}

/**
 * Chờ hộp thoại duyệt (tiêu đề có mã phiếu) đóng sau khi bấm "Duyệt khoản". Nếu server từ chối, màn hiện hộp
 * "Không thực hiện được": ném lỗi kèm nội dung hộp đó (nguyên nhân thật). Hết 20 giây vẫn mở thì ném lỗi kèm các hộp đang mở.
 */
async function waitApproveDialogClosed(page: Page, code: string): Promise<void> {
  const approve = page.getByRole('dialog', { name: new RegExp(code) });
  const refused = page.getByRole('dialog', { name: 'Không thực hiện được' });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await approve.isVisible().catch(() => false))) return;
    if (await refused.isVisible().catch(() => false)) {
      throw new Error(`Server từ chối duyệt ${code}: ${((await refused.innerText()) ?? '').replace(/\s+/g, ' ').slice(0, 400)}`);
    }
    await sleep(300);
  }
  const open = (await page.getByRole('dialog').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 200));
  throw new Error(`Hộp thoại duyệt ${code} vẫn mở sau 20 giây. Hộp đang mở: ${JSON.stringify(open)}`);
}

/**
 * Chờ phản hồi sau khi bấm "Chạy lại" trên khối tự động hoá của phiếu: thành công ⇒ toast "Đã chạy lại quy trình";
 * lỗi ⇒ ném lỗi kèm nội dung toast lỗi (nguyên nhân từ server).
 */
async function expectRerunAccepted(page: Page): Promise<void> {
  const ok = page.getByText('Đã chạy lại quy trình', { exact: false }).first();
  const err = page.locator('.ant-message-error').first();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await ok.isVisible().catch(() => false)) return;
    if (await err.isVisible().catch(() => false)) {
      throw new Error(`Chạy lại báo lỗi: ${((await err.innerText()) ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    await sleep(200);
  }
  throw new Error('Không thấy thông báo "Đã chạy lại quy trình" sau 20 giây');
}

/** KTV mở form phiếu chi mới ở phạm vi CTA (form lấy tài khoản/công ty theo công ty đang xem). */
async function openNewSpend(page: Page): Promise<void> {
  await switchScope(page, 'CTA');
  await page.goto('/chi/moi');
  await page.waitForLoadState('networkidle');
  await expect(page.getByText('Tạo mới phiếu chi', { exact: false }).first()).toBeVisible();
}

/**
 * Danh sách antd đang mở (ảo hoá: chỉ mục đang hiện nằm trong DOM) ⇒ cuộn từng bước tới mục có chữ `text`.
 * Trả về nhãn đầy đủ của mục, hoặc null nếu không thấy. Không bấm mục nào (chỉ đọc nhãn để kiểm tra).
 */
async function openOptionText(page: Page, text: string): Promise<string | null> {
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.waitFor({ state: 'visible', timeout: 10_000 });
  // danh sách có thể còn đang nạp (dropdown hiện trước, mục đến sau): chờ tới khi có mục đầu tiên gắn vào DOM
  await dropdown.locator('.ant-select-item-option').first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => undefined);
  // chỉ mục HIỂN THỊ (rc-select còn giữ bản ẩn để đọc bằng trợ năng; bản ẩn không có chữ nhìn thấy)
  const item = dropdown.locator('.ant-select-item-option').filter({ hasText: text }).filter({ visible: true });
  // đưa khung cuộn về đầu (lần gọi trước có thể đã cuộn xuống), rồi quét xuống dần
  await dropdown.evaluate((root) => {
    const all = [root as HTMLElement, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
    const el = all.filter((e) => e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 10).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
    if (el) el.scrollTop = 0;
  });
  for (let i = 0; i < 1200 && (await item.count()) === 0; i++) {
    await dropdown.evaluate((root) => {
      const all = [root as HTMLElement, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
      const el = all.filter((e) => e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 10).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (el) el.scrollTop += Math.max(40, Math.floor(el.clientHeight / 2));
    });
    await sleep(25);
  }
  return (await item.count()) ? item.first().innerText() : null;
}

/** Giá trị của một dòng "nhãn … giá trị" (fg-stat-row) sau khi dữ liệu tải xong (bỏ qua lúc đang hiện "—"). */
async function statRowValue(page: Page, label: string): Promise<string> {
  const row = page.locator('.fg-stat-row').filter({ hasText: label }).first();
  let text = '';
  for (let i = 0; i < 30; i++) {
    text = ((await row.innerText({ timeout: 5_000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ');
    if (text && !/—\s*$/.test(text)) break;
    await sleep(500);
  }
  return text;
}

interface FundOpts {
  tag: string;
  amountMinor?: string;
  /** null/undefined ⇒ để trống (vay = số tiền phiếu). */
  loanAmountMinor?: string | null;
  accountId?: string;
  sourceAccountId?: string;
  terms?: Record<string, unknown> | null;
}

interface FundDoc {
  id: string;
  code: string;
  bankId: string;
  bankName: string;
  accountId: string;
  accountName: string;
  sourceAccountId: string;
  supplierId: string;
  amountMinor: string;
}

/**
 * KTV lập phiếu chi "vay ngân hàng để chi" qua API rồi gửi duyệt. Ngân hàng cho vay và tài khoản nhận giải ngân là
 * dữ liệu mới của lượt test (không dùng chung, để không phụ thuộc trạng thái của người khác).
 */
async function fundPayment(w: World, o: FundOpts): Promise<FundDoc> {
  const bankName = uniq(`NH ${o.tag}`);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', bankName);
  const accountName = uniq(`TK giải ngân ${o.tag}`);
  const accountId = o.accountId ?? (await createBankAccount(w.chairman, w.CTA, accountName));
  const supplierName = uniq(`NCC ${o.tag}`);
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', supplierName);
  const amountMinor = o.amountMinor ?? '6000000';
  const sourceAccountId = o.sourceAccountId ?? accountId;
  const terms = o.terms === undefined ? { contract_no: `HĐTD-${digits(6)}`, interest_rate: '9.5', term_months: 12 } : o.terms;
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor,
    sourceAccountId,
    purpose: uniq(`Chi vay ${o.tag}`),
    loan: { lenderId: bankId, receiveAccountId: accountId, amountMinor: o.loanAmountMinor ?? null, terms },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt phiếu chi vay');
  const doc = await getDoc(w.staff, w.CTA, created.id);
  return { id: created.id, code: String(doc.code), bankId, bankName, accountId, accountName, sourceAccountId, supplierId, amountMinor };
}

/** Các bước R3 theo thứ tự chạy. */
const R3_STEPS = ['create_loan', 'create_voucher', 'link', 'execute_voucher', 'activate_loan'];

/** Ngày (YYYY-MM-DD) của một mốc thời gian. */
const dateOnly = (v: unknown): string => String(v ?? '').slice(0, 10);

/**
 * Lượt R3 LỖI có chủ đích: tài khoản nhận giải ngân bị khoá (frozen) trước khi duyệt cuối ⇒ bước create_loan xong
 * (khoản vay tạo ra), bước create_voucher lỗi vì tài khoản không còn hoạt động.
 */
async function failedR3(w: World, tag: string) {
  const recvId = await createBankAccount(w.chairman, w.CTA, uniq(`TK khoá ${tag}`));
  const srcId = await createBankAccount(w.chairman, w.CTA, uniq(`TK nguồn ${tag}`));
  const f = await fundPayment(w, { tag, accountId: recvId, sourceAccountId: srcId });
  must(await setAccountStatus(w.chairman, w.CTA, recvId, 'frozen'), 'khoá TK nhận giải ngân');
  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'failed');
  return { f, recvId, run };
}

/** Một TK ngân hàng của CTA có số dư đủ lớn để thực thi chuyển nội bộ (có sẵn trong dữ liệu test). */
async function fundedCtaAccount(w: World, minMinor = 5_000_000n): Promise<string> {
  const list = dataOf<{ items: any[] }>(must(await req(w.chairman, 'GET', '/bank-accounts', { scope: w.CTA }), 'TK CTA')).items ?? [];
  for (const a of list) {
    if (a.kind !== 'bank' || a.status !== 'active') continue;
    if ((await balanceOf(w.chairman, w.CTA, String(a._id))) > minMinor) return String(a._id);
  }
  throw new Error('Không có TK ngân hàng CTA đủ số dư để chuyển nội bộ');
}

// ---------------------------------------------------------------------------------------------------------------
// R3 — tạo phiếu, màn duyệt, chạy tự động (§11.5, US-AUTO-03/04)
// ---------------------------------------------------------------------------------------------------------------

test('UI · KTV lập phiếu chi "Vay ngân hàng để chi" và gửi duyệt (US-AUTO-03)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const page = w.staff;
  const bankName = uniq('NH UI');
  const bankId = await createPartner(w.staff, w.CTA, 'bank', bankName);
  const accountName = uniq('TK nhận UI');
  const accountId = await createBankAccount(w.chairman, w.CTA, accountName);
  const supplierName = uniq('NCC UI');
  await createPartner(w.staff, w.CTA, 'supplier', supplierName);
  const purpose = uniq('Mua hàng bằng vốn vay UI');

  await openNewSpend(page);

  await pickSelect(page, fieldOf(page, 'Bên nhận tiền'), supplierName, supplierName);
  await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(purpose);
  await fieldOf(page, 'Số tiền *').locator('input').fill('6000000');
  await fieldOf(page, 'Số tiền *').locator('input').press('Tab');

  // Bật "Vay ngân hàng để chi": hiện ngân hàng cho vay, TK nhận giải ngân, số tiền vay, điều khoản
  await page.locator('label').filter({ hasText: 'Vay ngân hàng để chi' }).click();
  await expect(fieldOf(page, 'Ngân hàng cho vay')).toBeVisible();
  await expect(fieldOf(page, 'Tài khoản nhận giải ngân')).toBeVisible();
  await expect(fieldOf(page, 'Số tiền vay')).toBeVisible();

  await pickSelect(page, fieldOf(page, 'Ngân hàng cho vay'), bankName, bankName);
  // ô tài khoản nhận giải ngân: danh sách dài, chọn đúng theo tên TK (không có nhãn khác để tìm)
  await pickLongSelect(page, fieldOf(page, 'Tài khoản nhận giải ngân'), accountName);
  await fieldOf(page, 'Số HĐ tín dụng').locator('input').fill('HĐTD-UI-1');
  await fieldOf(page, 'Lãi suất (%/năm)').locator('input').fill('9.5');

  await page.locator('label').filter({ hasText: 'Gửi duyệt ngay sau khi tạo' }).click();
  await page.getByRole('button', { name: 'Tạo & gửi duyệt' }).click();
  await page.waitForURL(/\/ho-so\/chi\/[0-9a-f]{24}/, { timeout: 30_000 });
  const id = page.url().split('/').pop() as string;

  const doc = await getDoc(page, w.CTA, id);
  expect(doc.status).toBe('pending.ktt');
  expect(String(doc.amount.minor)).toBe('6000000');
  expect(doc.partner_id).toBeTruthy(); // đối tác bắt buộc của phiếu chi
  // Tài khoản nguồn mặc định = tài khoản nhận giải ngân (§11.5)
  expect(String(doc.source.account_id)).toBe(accountId);
  const loanJson = JSON.stringify(doc.options ?? {});
  expect.soft(loanJson).toContain(bankId);
  expect.soft(loanJson).toContain('HĐTD-UI-1');
  await expect(page.getByText('Chi bằng vốn vay', { exact: false }).first()).toBeVisible();
});

test('UI · ô "Tài khoản nhận giải ngân" hiện tên từng tài khoản: TK cùng ngân hàng vẫn phân biệt được (US-AUTO-03)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const sharedBank = uniq('BIDV chi nhánh chung');
  const nameA = uniq('TK A cùng NH');
  const nameB = uniq('TK B cùng NH');
  await createBankAccount(w.chairman, w.CTA, nameA, sharedBank);
  await createBankAccount(w.chairman, w.CTA, nameB, sharedBank);

  await openNewSpend(w.staff);
  await w.staff.locator('label').filter({ hasText: 'Vay ngân hàng để chi' }).click();
  const field = fieldOf(w.staff, 'Tài khoản nhận giải ngân');
  // phạm vi là thiết lập dùng chung của tài khoản (default_scope): phiên test khác có thể đổi giữa chừng ⇒ nếu không
  // thấy mục thì đưa về CTA, mở lại form một lần rồi chọn lại
  const pickIn = async (name: string): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await pickLongSelect(w.staff, field, name);
        return;
      } catch (err) {
        if (attempt >= 2) throw err;
        await openNewSpend(w.staff);
        await w.staff.locator('label').filter({ hasText: 'Vay ngân hàng để chi' }).click();
      }
    }
  };
  await pickIn(nameB);
  const shownB = await field.innerText();
  expect(shownB, 'ô đã chọn hiện tên TK B (không chỉ tên ngân hàng dùng chung)').toContain(nameB);
  expect(shownB).toContain(sharedBank);
  await pickIn(nameA);
  const shownA = await field.innerText();
  expect(shownA, 'ô đã chọn đổi sang tên TK A').toContain(nameA);
  expect(shownA).not.toContain(nameB);
});

test('UI · ô "Tài khoản nguồn" của phiếu chi hiện tên từng tài khoản: TK cùng ngân hàng phân biệt được (US-AUTO-03)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const sharedBank = uniq('BIDV nguồn chung');
  const nameA = uniq('TK nguồn A');
  await createBankAccount(w.chairman, w.CTA, nameA, sharedBank);
  await openNewSpend(w.staff);
  // Mỗi mục của ô tài khoản nguồn phải có tên tài khoản (đặc tả: chọn đúng TK khi nhiều TK cùng ngân hàng).
  await pickLongSelect(w.staff, fieldOf(w.staff, 'Tài khoản nguồn'), nameA);
  expect(await fieldOf(w.staff, 'Tài khoản nguồn').innerText()).toContain(nameA);
});

test('UI · KTT thấy "Chi bằng vốn vay <ngân hàng> <số tiền>, kỳ hạn <n> tháng" khi duyệt (US-AUTO-04)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'MODAL' });
  await switchScope(w.chief, 'CTA');
  await w.chief.goto(`/ho-so/chi/${f.id}`);
  await w.chief.waitForLoadState('networkidle');
  await assertNoPageCrash(w.chief, 'chi tiết phiếu vay để chi');

  await w.chief.getByRole('button', { name: /^Duyệt khoản/ }).first().click();
  const dlg = w.chief.getByRole('dialog');
  await expect(dlg).toBeVisible();
  const headline = dlg.getByText(/Chi bằng vốn vay/).first();
  await expect(headline).toBeVisible();
  const text = await headline.innerText();
  expect(text).toContain(f.bankName);
  expect(text).toMatch(/6\s*(tr|triệu)/);
  expect(text).toMatch(/kỳ hạn 12 tháng/);
  await expect(dlg.getByText(/Giải ngân vào:/)).toBeVisible();
  await expect(fieldOf(dlg, 'Số tiền duyệt').locator('input')).toBeVisible();

  // Ô "Tài khoản nguồn" trên modal duyệt (cấp duyệt đổi được TK): mỗi mục phải có TÊN TK để chọn đúng khi TK cùng NH
  await fieldOf(dlg, 'Tài khoản nguồn').locator('.ant-select').first().click();
  const srcOpt = await openOptionText(w.chief, f.accountName);
  console.log('[T4 modal source option]', srcOpt);
  expect(srcOpt ?? '', 'mục TK nguồn trên modal duyệt có tên TK').toContain(f.accountName);
  await dlg.getByText(/Chi bằng vốn vay/).first().click(); // đóng danh sách, giữ nguyên modal

  await dlg.getByRole('button', { name: /^Duyệt khoản/ }).click();
  await waitApproveDialogClosed(w.chief, f.code);
  const after = await getDoc(w.chief, w.CTA, f.id);
  expect(after.status).not.toBe('pending.ktt');
});

test('UI · ô "Tài khoản đích" của phiếu thu hiện tên từng tài khoản: TK cùng ngân hàng phân biệt được (bug #6, US-AUTO-03)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const sharedBank = uniq('BIDV đích chung');
  const nameA = uniq('TK đích A');
  const nameB = uniq('TK đích B');
  await createBankAccount(w.chairman, w.CTA, nameA, sharedBank);
  await createBankAccount(w.chairman, w.CTA, nameB, sharedBank);

  await switchScope(w.staff, 'CTA');
  await w.staff.goto('/thu/moi');
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'form phiếu thu mới');
  await expect(w.staff.getByText('Tạo mới phiếu thu', { exact: false }).first()).toBeVisible();
  const field = fieldOf(w.staff, 'Tài khoản đích');
  await expect(field).toBeVisible();
  // mục trong danh sách phải có tên TK (không chỉ "Ngân hàng · số TK che"): cuộn tới từng TK cùng ngân hàng
  await field.locator('.ant-select').first().click();
  const optA = await openOptionText(w.staff, nameA);
  const optB = await openOptionText(w.staff, nameB);
  console.log('[T-income target options]', JSON.stringify({ optA, optB }));
  expect(optA ?? '', 'mục TK A có tên TK và tên ngân hàng').toContain(sharedBank);
  expect(optA ?? '').toContain(nameA);
  expect(optB ?? '', 'mục TK B có tên TK và tên ngân hàng').toContain(sharedBank);
  expect(optB ?? '').toContain(nameB);
  await w.staff.keyboard.press('Escape');

  await pickLongSelect(w.staff, field, nameB);
  const shownB = await field.innerText();
  expect(shownB, 'ô đích đã chọn hiện tên TK B').toContain(nameB);
  expect(shownB).toContain(sharedBank);
  await pickLongSelect(w.staff, field, nameA);
  const shownA = await field.innerText();
  expect(shownA, 'ô đích đổi sang tên TK A').toContain(nameA);
  expect(shownA).not.toContain(nameB);
});

test('R3 · duyệt cuối ⇒ khoản vay Đang vay, phiếu thu tự động đã thực thi, liên kết đủ; phiếu chi vẫn Đã duyệt (§11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'R3 FULL' });
  const balBefore = await balanceOf(w.staff, w.CTA, f.accountId);

  const approved = await approveToFinal(w.approvers, w.CTA, f.id);
  expect(approved.status).toBe('approved');
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  expect(run.steps.map((s: any) => s.name)).toEqual(R3_STEPS);
  for (const name of R3_STEPS) expect.soft(stepOf(run, name)?.status, `bước ${name}`).toBe('done');

  const loanId = generatedId(run, 'create_loan') as string;
  const receiptId = generatedId(run, 'create_voucher') as string;
  expect(loanId).toBeTruthy();
  expect(receiptId).toBeTruthy();

  // Khoản vay: Đang vay, gốc = số tiền phiếu, do quy tắc R3 sinh ra, gắn đúng ngân hàng cho vay
  const loan = await getLoan(w.staff, w.CTA, loanId);
  expect(loan.status).toBe('active');
  expect(JSON.stringify(loan.principal)).toContain(f.amountMinor);
  expect.soft(JSON.stringify(loan)).toContain(f.bankId);
  expect.soft(loan.origin?.kind).toBe('automation');
  expect.soft(loan.origin?.rule_code).toBe('R3');

  // Phiếu thu tự động: đã duyệt + đã thực thi vào TK nhận giải ngân, nội dung theo đặc tả
  const receipt = await getDoc(w.staff, w.CTA, receiptId);
  expect(receipt.kind).toBe('income');
  expect(receipt.status).toBe('paid');
  expect(receipt.purpose).toBe(`(Tự động) Giải ngân vay cho phiếu chi ${f.code}`);
  expect(String(receipt.amount.minor)).toBe(f.amountMinor);
  expect(String(receipt.source.account_id)).toBe(f.accountId);
  expect(String(receipt.partner_id)).toBe(f.bankId);
  expect.soft(receipt.origin?.kind).toBe('automation');
  expect.soft(receipt.origin?.rule_code).toBe('R3');
  // ngày thực thi = ngày duyệt cuối của phiếu chi (ngày VN)
  expect.soft(dateOnly(receipt.execution?.paid_at)).toBe(vnToday());
  // kế thừa chuỗi duyệt của phiếu chi
  expect.soft(receipt.approval?.steps?.length).toBe(approved.approval?.steps?.length);
  // phiếu thu → khoản vay (disbursement); khoản vay Đang vay có ngày giải ngân = ngày thực thi phiếu thu (§11.4, §11.5 bước 3)
  expect.soft(JSON.stringify(receipt.links ?? [])).toContain('disbursement');
  expect.soft(JSON.stringify(receipt.links ?? [])).toContain(loanId);
  expect.soft(dateOnly(loan.disbursed_at), 'ngày giải ngân của khoản vay').toBe(vnToday());
  const histText = JSON.stringify(dataOf(await req(w.staff, 'GET', `/documents/${receiptId}/history`, { scope: w.CTA })));
  expect.soft(histText).toContain('auto_create');

  // Tiền giải ngân đã về TK nhận
  expect(await balanceOf(w.staff, w.CTA, f.accountId)).toBe(balBefore + BigInt(f.amountMinor));

  // Phiếu chi: vẫn Đã duyệt, số tiền không đổi, có liên kết funded_by + generated
  const pay = await getDoc(w.staff, w.CTA, f.id);
  expect(pay.status).toBe('approved');
  expect(String(pay.amount.minor)).toBe(f.amountMinor);
  const payLinks = JSON.stringify(pay.links ?? []);
  expect.soft(payLinks).toContain(loanId);
  expect.soft(payLinks).toContain(receiptId);
  expect.soft(payLinks).toContain('funded_by');
  expect.soft(payLinks).toContain('generated');
});

test('UI · chi tiết phiếu chi đã R3 hiện "Quy trình tự động: R3 ✔", đối tượng sinh ra và trạng thái (US-AUTO-05)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'PANEL' });
  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const receipt = await getDoc(w.staff, w.CTA, generatedId(run, 'create_voucher') as string);
  const loan = await getLoan(w.staff, w.CTA, generatedId(run, 'create_loan') as string);

  await switchScope(w.staff, 'CTA');
  await w.staff.goto(`/ho-so/chi/${f.id}`);
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'chi tiết phiếu đã R3');
  await expect(w.staff.getByText('Quy trình tự động', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  const bodyText = (await w.staff.locator('body').innerText()).replace(/\n+/g, ' | ');
  const at = bodyText.indexOf('Quy trình tự động');
  const panel = bodyText.slice(at, at + 420);
  expect(panel).toContain('R3');
  expect(panel).toContain('Đã tạo');
  expect(panel).toContain(String(receipt.code));
  expect(panel).toContain(String(loan.code));
  expect(panel).toContain('đã thanh toán');
  expect(panel).toContain('đang vay');
});

test('R3 · sau khi R3 chạy, số tiền phiếu chi không đổi được nữa (§11.5, FG-WF-005)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'KHOÁ SỐ TIỀN' });
  await approveToFinal(w.approvers, w.CTA, f.id);
  await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');

  const before = await getDoc(w.staff, w.CTA, f.id);
  const patch = await req(w.staff, 'PATCH', `/documents/${f.id}`, {
    scope: w.CTA,
    data: { amount: { amount_minor: '5000000', currency: 'VND' }, if_match: before.version, request_id: randomUUID() },
  });
  console.log('[T4 PATCH]', patch.status, JSON.stringify(patch.body).slice(0, 220));
  expect(patch.ok).toBeFalsy();
  const reApprove = await transition(w.chief, w.CTA, f.id, 'approve', { amount_minor: '5000000' });
  console.log('[T4 approve]', reApprove.status, JSON.stringify(reApprove.body).slice(0, 220));
  expect(reApprove.ok).toBeFalsy();
  expect(JSON.stringify(reApprove.body)).toContain('FG-WF-005');
  const after = await getDoc(w.staff, w.CTA, f.id);
  expect(String(after.amount.minor)).toBe(f.amountMinor);
});

test('R3 · cấp duyệt hạ số tiền phiếu chi ⇒ khoản vay và phiếu thu theo số đã chốt (§11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  // 60 triệu: chuỗi CTA là KTT → GĐ (PGĐ khuyết bị bỏ, §7.2); GĐ là cấp duyệt cuối nên hạ số tiền ở đó
  const f = await fundPayment(w, { tag: 'HẠ TIỀN', amountMinor: '60000000', loanAmountMinor: null });
  must(await transition(w.chief, w.CTA, f.id, 'approve'), 'KTT duyệt');

  // Giám đốc hạ số tiền ngay trên modal duyệt (cấp cuối): 60.000.000 → 45.000.000
  await switchScope(w.director, 'CTA');
  await w.director.goto(`/ho-so/chi/${f.id}`);
  await w.director.waitForLoadState('networkidle');
  await assertNoPageCrash(w.director, 'chi tiết phiếu chờ GĐ');
  await w.director.getByRole('button', { name: /^Duyệt khoản/ }).first().click();
  const dlg = w.director.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await fieldOf(dlg, 'Số tiền duyệt').locator('input').fill('45000000');
  const opinionBox = dlg.locator('textarea').first();
  if (await opinionBox.count()) await opinionBox.fill('Giám đốc hạ số tiền theo thương lượng với nhà cung cấp');
  await dlg.getByRole('button', { name: /^Duyệt khoản/ }).click();
  await waitApproveDialogClosed(w.director, f.code);
  const done = await getDoc(w.director, w.CTA, f.id);
  expect(done.status).toBe('approved');
  expect(String(done.amount.minor)).toBe('45000000');

  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const loan = await getLoan(w.staff, w.CTA, generatedId(run, 'create_loan') as string);
  const receipt = await getDoc(w.staff, w.CTA, generatedId(run, 'create_voucher') as string);
  expect(JSON.stringify(loan.principal)).toContain('45000000');
  expect(String(receipt.amount.minor)).toBe('45000000');
  const pay = await getDoc(w.staff, w.CTA, f.id);
  expect(String(pay.amount.minor)).toBe('45000000');
});

test('R3 · vay một phần giữ số đã nhập; không hạ được số tiền phiếu xuống dưới số tiền vay (§11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  // 60 triệu (chuỗi KTT → GĐ), vay 30 triệu: GĐ không hạ được số tiền chi xuống dưới số tiền vay
  const f = await fundPayment(w, { tag: 'VAY MỘT PHẦN', amountMinor: '60000000', loanAmountMinor: '30000000' });
  must(await transition(w.chief, w.CTA, f.id, 'approve'), 'KTT duyệt');

  const low = await transition(w.director, w.CTA, f.id, 'approve', { amount_minor: '20000000' });
  console.log('[T6 lower below loan]', low.status, JSON.stringify(low.body).slice(0, 260));
  expect(low.ok).toBeFalsy();
  expect(JSON.stringify(low.body)).toContain('FG-VAL-001');
  const still = await getDoc(w.director, w.CTA, f.id);
  expect(String(still.amount.minor)).toBe('60000000');

  // hạ xuống 40 triệu (vẫn ≥ số tiền vay) được chấp nhận; số tiền vay 30 triệu giữ nguyên đã nhập
  must(await transition(w.director, w.CTA, f.id, 'approve', { amount_minor: '40000000' }), 'GĐ hạ còn 40 triệu (≥ số tiền vay)');
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const loan = await getLoan(w.staff, w.CTA, generatedId(run, 'create_loan') as string);
  const receipt = await getDoc(w.staff, w.CTA, generatedId(run, 'create_voucher') as string);
  expect(JSON.stringify(loan.principal)).toContain('30000000');
  expect(String(receipt.amount.minor)).toBe('30000000');
  const pay = await getDoc(w.staff, w.CTA, f.id);
  expect(pay.status).toBe('approved');
  expect(String(pay.amount.minor)).toBe('40000000');
});

// ---------------------------------------------------------------------------------------------------------------
// Thực thi sau R3 (§11.5 bước 4, US-EXE-01)
// ---------------------------------------------------------------------------------------------------------------

test('Âm tính · phiếu chi vay để chi bị yêu cầu bổ sung trước khi duyệt xong ⇒ R3 chưa chạy (§11.5 ngoại lệ)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'YÊU CẦU BỔ SUNG' });
  const why = 'Bổ sung hồ sơ hợp đồng vay để kiểm thử R3';
  must(await transition(w.chief, w.CTA, f.id, 'request_changes', { reason: why, opinion: why }), 'KTT yêu cầu bổ sung');
  const doc = await getDoc(w.staff, w.CTA, f.id);
  expect(doc.status).toBe('changes_requested');
  await sleep(4000); // bộ máy tự động xử lý bất đồng bộ: chờ một nhịp rồi mới khẳng định không có lượt nào
  const runs = await runsOf(w.staff, w.CTA, f.id);
  expect(runs.filter((r) => r.rule_code === 'R3')).toHaveLength(0);
});

test('R3 · thực thi phiếu chi sau R3 (nghiệp vụ): tiền ra khỏi TK nhận giải ngân, phiếu chi Đã thanh toán (US-EXE-01)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'THỰC THI API' });
  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  await attachUnc(w.staff, w.CTA, f.id);
  must(await payByApi(w.staff, w.CTA, f.id), 'thực thi phiếu chi');

  const pay = await getDoc(w.staff, w.CTA, f.id);
  expect(pay.status).toBe('paid');
  expect(dateOnly(pay.execution?.paid_at)).toBe(vnToday());
  // Tiền vào (R3) rồi ra (thực thi): số dư TK nhận giải ngân trở về 0
  expect(await balanceOf(w.staff, w.CTA, f.accountId)).toBe(0n);
  const loan = await getLoan(w.staff, w.CTA, generatedId(run, 'create_loan') as string);
  expect(loan.status).toBe('active');
});

test('UI · KTV thực thi phiếu chi đã R3 từ chi tiết phiếu (US-EXE-01)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'THỰC THI UI' });
  await approveToFinal(w.approvers, w.CTA, f.id);
  await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  await attachUnc(w.staff, w.CTA, f.id);

  await switchScope(w.staff, 'CTA');
  await w.staff.goto(`/ho-so/chi/${f.id}`);
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'chi tiết phiếu trước khi thực thi');
  await w.staff.getByRole('button', { name: 'Thực thi', exact: true }).first().click();
  const dlg = w.staff.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await fieldOf(dlg, 'Số tham chiếu ngân hàng').locator('input').fill(`FT${digits(10)}`);
  await dlg.getByRole('button', { name: /^Thực thi/ }).click();
  await expect(dlg).toBeHidden({ timeout: 25_000 });
  expect((await getDoc(w.staff, w.CTA, f.id)).status).toBe('paid');
});

// ---------------------------------------------------------------------------------------------------------------
// R6 — huỷ phiếu nguồn sau khi R3 chạy (US-AUTO-06, §11.5)
// ---------------------------------------------------------------------------------------------------------------

test('R6 · huỷ phiếu chi (nút Hủy hồ sơ) sau khi R3 chạy: khoản vay không tự huỷ, KTT được cảnh báo (US-AUTO-06)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'HUỶ SAU R3' });
  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const loanId = generatedId(run, 'create_loan') as string;
  const receiptId = generatedId(run, 'create_voucher') as string;

  // người lập huỷ từ giao diện (chi tiết phiếu đã duyệt)
  await switchScope(w.staff, 'CTA');
  await w.staff.goto(`/ho-so/chi/${f.id}`);
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'chi tiết phiếu đã R3 trước khi huỷ');
  await cancelFromDetail(w.staff, 'Huỷ phiếu để kiểm thử R6');
  expect((await getDoc(w.staff, w.CTA, f.id)).status).toBe('cancelled');

  const r6 = await waitForRun(w.staff, w.CTA, f.id, 'R6', 'done');
  expect(stepOf(r6, 'alert')?.status).toBe('done');
  expect(stepOf(r6, 'alert')?.output_id).toBe(loanId);

  // Khoản vay không bị huỷ; phiếu thu đã thực thi không bị đụng
  const loan = await getLoan(w.staff, w.CTA, loanId);
  expect(loan.status).toBe('active');
  expect((await getDoc(w.staff, w.CTA, receiptId)).status).toBe('paid');

  // Cảnh báo cho KTT — loại source_cancelled_with_money, nội dung theo §11.5
  const alerts = await alertsOf(w.chief, w.CTA);
  const hit = alerts.find((a) => a.type === 'source_cancelled_with_money' && String(a.text).includes(f.code));
  expect(hit, 'cảnh báo source_cancelled_with_money cho KTT').toBeTruthy();
  expect.soft(String(hit?.text ?? '')).toContain(String(loan.code));
  expect.soft(String(hit?.href ?? '')).toContain(loanId);

  // Hiện trên màn Cảnh báo của KTT
  await switchScope(w.chief, 'CTA');
  await w.chief.goto('/canh-bao');
  await w.chief.waitForLoadState('networkidle');
  await expect(w.chief.getByText(f.code, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
});

test('R6 · huỷ phiếu chi khi R3 lỗi giữa chừng (khoản vay chưa có tiền): khoản vay tự sinh bị HUỶ, không cảnh báo tiền (§11.3, §11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const { f, run } = await failedR3(w, 'HUỶ KHI LỖI');
  const loanId = generatedId(run, 'create_loan') as string;
  expect((await getLoan(w.staff, w.CTA, loanId)).status).toBe('pending_disbursement');

  // phiếu đã duyệt nhưng khoản vay chưa có tiền về ⇒ huỷ phiếu từ giao diện
  await switchScope(w.staff, 'CTA');
  await w.staff.goto(`/ho-so/chi/${f.id}`);
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'chi tiết phiếu R3 lỗi trước khi huỷ');
  await cancelFromDetail(w.staff, 'Huỷ phiếu để kiểm thử R6 khi chưa giải ngân');
  expect((await getDoc(w.staff, w.CTA, f.id)).status).toBe('cancelled');

  const r6 = await waitForRun(w.staff, w.CTA, f.id, 'R6', 'done');
  expect(stepOf(r6, 'cancel_unpaid')?.status).toBe('done');
  expect(stepOf(r6, 'cancel_unpaid')?.output_id).toBe(loanId);
  expect(stepOf(r6, 'alert')?.status).toBe('skipped');
  // khoản vay chưa có tiền, do quy tắc sinh ra ⇒ bị HUỶ (không cần bút toán)
  expect((await getLoan(w.staff, w.CTA, loanId)).status).toBe('cancelled');
  // không có tiền ⇒ không có cảnh báo "đã giải ngân" cho phiếu này
  const alerts = await alertsOf(w.chief, w.CTA);
  expect(alerts.some((a) => a.type === 'source_cancelled_with_money' && String(a.text).includes(f.code))).toBeFalsy();
});

test('UI · nhãn TK có TÊN TK ở khung "Giải ngân vào" (modal duyệt) và ở "Tài khoản nguồn/đích" (chi tiết) — TK cùng ngân hàng (US-AUTO-03/04)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'NHÃN TK' });

  // KTT mở modal duyệt: dòng "Giải ngân vào" phải nêu tên TK nhận giải ngân để phân biệt với TK khác cùng ngân hàng
  await switchScope(w.chief, 'CTA');
  await w.chief.goto(`/ho-so/chi/${f.id}`);
  await w.chief.waitForLoadState('networkidle');
  await w.chief.getByRole('button', { name: /^Duyệt khoản/ }).first().click();
  const dlg = w.chief.getByRole('dialog');
  await expect(dlg).toBeVisible();
  const giaiNgan = (await dlg.getByText(/Giải ngân vào:/).first().innerText()).replace(/\s+/g, ' ');
  console.log('[LABEL approve-modal banner]', giaiNgan);
  expect.soft(giaiNgan, 'dòng "Giải ngân vào" có tên TK nhận giải ngân').toContain(f.accountName);
  // khối "Nguồn tiền & ảnh hưởng số dư" trên modal duyệt: dòng "Tài khoản nguồn" (ngay trên ô chọn TK)
  const modalText = (await dlg.innerText()).replace(/\s+/g, ' ');
  const packSource = /Tài khoản nguồn (.+?) Số dư trước/.exec(modalText)?.[1] ?? '';
  console.log('[LABEL approve-modal decision pack source row]', packSource);
  expect.soft(packSource, 'khối nguồn tiền trên modal duyệt: "Tài khoản nguồn" có tên TK').toContain(f.accountName);

  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const receiptId = generatedId(run, 'create_voucher') as string;

  // chi tiết phiếu chi, tab "Dòng tiền liên quan": dòng "Tài khoản nguồn" (ảnh hưởng số dư)
  await switchScope(w.staff, 'CTA');
  await w.staff.goto(`/ho-so/chi/${f.id}`);
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'chi tiết phiếu chi R3 (nhãn TK)');
  await w.staff.getByText('Dòng tiền liên quan', { exact: false }).first().click();
  await w.staff.waitForLoadState('networkidle');
  const srcRow = await statRowValue(w.staff, 'Tài khoản nguồn');
  console.log('[LABEL spend detail source row]', srcRow);
  expect.soft(srcRow, 'chi tiết phiếu chi: "Tài khoản nguồn" có tên TK').toContain(f.accountName);

  // chi tiết phiếu thu tự động, cùng tab: dòng "Tài khoản đích"
  await w.staff.goto(`/ho-so/thu/${receiptId}`);
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'chi tiết phiếu thu tự động R3 (nhãn TK)');
  await w.staff.getByText('Dòng tiền liên quan', { exact: false }).first().click();
  await w.staff.waitForLoadState('networkidle');
  const tgtRow = await statRowValue(w.staff, 'Tài khoản đích');
  console.log('[LABEL receipt detail target row]', tgtRow);
  expect.soft(tgtRow, 'chi tiết phiếu thu tự động: "Tài khoản đích" có tên TK').toContain(f.accountName);
});

test('UI · tiêu đề "Lịch sử giao dịch" của tài khoản (BANK-05) có TÊN TK — cùng họ với bug #6, TK cùng ngân hàng phân biệt được', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const sharedBank = uniq('BIDV lịch sử');
  const name = uniq('TK lịch sử A');
  const accountId = await createBankAccount(w.chairman, w.CTA, name, sharedBank);
  await switchScope(w.chief, 'CTA');
  await w.chief.goto(`/ngan-hang/taikhoan/${accountId}`);
  await w.chief.waitForLoadState('networkidle');
  await assertNoPageCrash(w.chief, 'lịch sử giao dịch của tài khoản');
  const title = (await w.chief.getByText('Lịch sử giao dịch ·', { exact: false }).first().innerText()).replace(/\s+/g, ' ');
  console.log('[LABEL bank history title]', title);
  expect(title, 'tiêu đề lịch sử giao dịch có tên TK').toContain(name);
});

test('UI · người lập huỷ được phiếu chi đã duyệt từ giao diện (Spec §7.1: Đã duyệt → Huỷ)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  // Phiếu chi thường (không vay): tách biệt với lỗi hiển thị của lượt R3
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC huỷ UI'));
  const srcId = await fundedCtaAccount(w);
  const d = await createSpend(w.staff, { companyId: w.CTA, partnerId: supplierId, amountMinor: '1000000', sourceAccountId: srcId, purpose: uniq('Phiếu chi huỷ UI') });
  must(await transition(w.staff, w.CTA, d.id, 'submit'), 'gửi duyệt');
  await approveToFinal(w.approvers, w.CTA, d.id);

  await switchScope(w.staff, 'CTA');
  await w.staff.goto(`/ho-so/chi/${d.id}`);
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'chi tiết phiếu đã duyệt');
  await expect(w.staff.getByRole('button', { name: /^(Hủy|Huỷ)( hồ sơ)?$/ })).toHaveCount(1);
  await cancelFromDetail(w.staff, 'Huỷ phiếu để kiểm thử UI');
  expect((await getDoc(w.staff, w.CTA, d.id)).status).toBe('cancelled');
});

// ---------------------------------------------------------------------------------------------------------------
// R3 — lượt lỗi giữa chừng, chạy lại (§11.5 ngoại lệ, US-AUTO-05)
// ---------------------------------------------------------------------------------------------------------------

test('R3 · lượt lỗi giữa chừng: khoản vay đã tạo, cảnh báo KTT, chạy lại tiếp tục không tạo trùng (§11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const { f, recvId, run } = await failedR3(w, 'LỖI R3');
  expect(stepOf(run, 'create_loan')?.status).toBe('done');
  expect(stepOf(run, 'create_voucher')?.status).toBe('failed');
  const loanId = generatedId(run, 'create_loan') as string;
  // lý do lỗi phải nêu nguyên nhân (không chỉ tiêu đề chung "Dữ liệu không hợp lệ")
  const cause = String(stepOf(run, 'create_voucher')?.error ?? '');
  expect(cause, 'lý do lỗi hiển thị cho KTT').toMatch(/không tồn tại|đã đóng|phong tỏa|không hoạt động/i);
  expect(cause).not.toBe('Dữ liệu không hợp lệ');
  expect((await getLoan(w.staff, w.CTA, loanId)).status).toBe('pending_disbursement');

  // Lỗi tự động ⇒ cảnh báo cho KTT
  const alerts = await alertsOf(w.chief, w.CTA);
  expect(alerts.some((a) => a.type === 'automation_run_failed'), 'cảnh báo automation_run_failed cho KTT').toBeTruthy();

  // Số tiền đã khoá ngay khi R3 đã chạy (dù lượt lỗi)
  const before = await getDoc(w.staff, w.CTA, f.id);
  const patch = await req(w.staff, 'PATCH', `/documents/${f.id}`, {
    scope: w.CTA,
    data: { amount: { amount_minor: '5000000', currency: 'VND' }, if_match: before.version, request_id: randomUUID() },
  });
  expect(patch.ok).toBeFalsy();
  expect(String(((await getDoc(w.staff, w.CTA, f.id)).amount).minor)).toBe(f.amountMinor);

  // Mở lại tài khoản rồi chạy lại lượt (KTT)
  must(await setAccountStatus(w.chairman, w.CTA, recvId, 'active'), 'mở lại TK nhận giải ngân');
  const rerun = await req(w.chief, 'POST', `/automation/runs/${run._id}/rerun`, { scope: w.CTA, data: { request_id: randomUUID() } });
  must(rerun, 'chạy lại lượt R3');
  const done = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  expect(String(done._id)).toBe(String(run._id));
  expect(generatedId(done, 'create_loan')).toBe(loanId);
  const r3runs = (await runsOf(w.staff, w.CTA, f.id)).filter((r) => r.rule_code === 'R3');
  expect(r3runs.length, 'không tạo lượt R3 trùng').toBe(1);
  const receipt = await getDoc(w.staff, w.CTA, generatedId(done, 'create_voucher') as string);
  expect(receipt.status).toBe('paid');
  expect((await getLoan(w.staff, w.CTA, loanId)).status).toBe('active');
});

test('UI · KTT thấy lượt R3 lỗi trên chi tiết phiếu (kèm nguyên nhân) và chạy lại từ đó (US-AUTO-05)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const { f, recvId } = await failedR3(w, 'LỖI UI');

  await switchScope(w.chief, 'CTA');
  await w.chief.goto(`/ho-so/chi/${f.id}`);
  await w.chief.waitForLoadState('networkidle');
  await assertNoPageCrash(w.chief, 'chi tiết phiếu có lượt lỗi');
  await expect(w.chief.getByText('Lỗi — cần chạy lại', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  // nguyên nhân bước lỗi hiện ngay trên panel (không chỉ "Lỗi")
  await expect(w.chief.getByText(/không tồn tại|đã đóng|phong tỏa|không hoạt động/).first()).toBeVisible();

  must(await setAccountStatus(w.chairman, w.CTA, recvId, 'active'), 'mở lại TK nhận giải ngân');
  await w.chief.reload();
  await w.chief.waitForLoadState('networkidle');
  await assertNoPageCrash(w.chief, 'chi tiết phiếu sau khi mở lại TK');
  await w.chief.getByRole('button', { name: 'Chạy lại', exact: true }).first().click();
  await expectRerunAccepted(w.chief);
  await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
});

test('Tự động hoá · màn lượt chạy liệt kê lượt R3, mở chi tiết lượt có đối tượng sinh, và chạy lại lượt lỗi (US-AUTO-05)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const { f, recvId } = await failedR3(w, 'MÀN LƯỢT');
  must(await setAccountStatus(w.chairman, w.CTA, recvId, 'active'), 'mở lại TK nhận giải ngân');

  await switchScope(w.chief, 'CTA');
  await w.chief.goto('/quantri/tu-dong');
  await w.chief.waitForLoadState('networkidle');
  await w.chief.getByText('Lượt chạy', { exact: true }).first().click();
  await w.chief.waitForLoadState('networkidle');
  await assertNoPageCrash(w.chief, 'màn Tự động hoá · Lượt chạy');
  const row = w.chief.locator('tr').filter({ hasText: 'R3' }).filter({ hasText: 'Lỗi' }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  // ngăn chi tiết của lượt lỗi: mở được, nêu nguyên nhân bước lỗi, liệt kê đối tượng đã sinh, có nút Chạy lại
  await row.getByRole('button', { name: 'Chi tiết', exact: true }).click();
  const drawer = w.chief.getByRole('dialog').filter({ hasText: 'Các bước' }).first();
  await expect(drawer).toBeVisible({ timeout: 15_000 });
  await assertNoPageCrash(w.chief, 'ngăn chi tiết lượt lỗi');
  await expect(drawer.getByText(/không tồn tại|đã đóng|phong tỏa|không hoạt động/).first()).toBeVisible();
  await expect(drawer.getByText('Đối tượng đã sinh', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Chạy lại', exact: true })).toBeVisible();
  await w.chief.keyboard.press('Escape');
  await expect(drawer).toBeHidden({ timeout: 10_000 });

  await row.getByRole('button', { name: 'Chạy lại', exact: true }).click();
  const confirm = w.chief.getByRole('dialog').filter({ hasText: 'Chạy lại lượt tự động' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Chạy lại', exact: true }).click();
  // Sau khi chạy lại, màn mở ngăn chi tiết lượt (cần hiển thị danh sách đối tượng đã sinh, không crash)
  await assertNoPageCrash(w.chief, 'màn Tự động hoá sau khi chạy lại');
  await expect(w.chief.getByText('Chạy lại xong', { exact: false }).first()).toBeVisible({ timeout: 45_000 });
  await expect(w.chief.getByText('Đối tượng đã sinh', { exact: true })).toBeVisible({ timeout: 20_000 });
  await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
});

// ---------------------------------------------------------------------------------------------------------------
// R1 — chuyển tiền nội bộ (§11.6)
// ---------------------------------------------------------------------------------------------------------------

test('UI · form phiếu chi "Nhận: tài khoản nội bộ" cho chọn công ty nhận CTB (§11.6)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const page = w.staff;
  await openNewSpend(page);
  await page.locator('label').filter({ hasText: 'Tiền chuyển cho tài khoản nội bộ' }).click();
  const companyField = fieldOf(page, 'Công ty nhận');
  await expect(companyField).toBeVisible();
  await companyField.locator('.ant-select').first().click();
  await page.waitForTimeout(600);
  const opts = await visibleOptions(page);
  console.log('[T13 company options]', JSON.stringify(opts));
  await page.keyboard.press('Escape');
  // Spec §11.6: KTV chọn công ty nhận (CTB) và tài khoản nhận ngay trên phiếu chi
  expect(opts.join(' ')).toContain('CTB');
});

test('UI · KTV lập phiếu chi "Nhận: tài khoản nội bộ" tới TK của CTB rồi lưu nháp ⇒ phiếu lưu đích theo ID (§11.6)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const page = w.staff;
  const supplierName = uniq('NCC nội bộ UI');
  await createPartner(w.staff, w.CTA, 'supplier', supplierName);
  const ctbAccName = uniq('TK CTB nhận UI');
  const ctbAccountId = await createBankAccount(w.chairman, w.CTB, ctbAccName);
  const purpose = uniq('Chuyển nội bộ UI');

  await openNewSpend(page);
  await pickSelect(page, fieldOf(page, 'Bên nhận tiền'), supplierName, supplierName);
  await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(purpose);
  await fieldOf(page, 'Số tiền *').locator('input').fill('1500000');
  await fieldOf(page, 'Số tiền *').locator('input').press('Tab');
  // tài khoản nguồn của phiếu nháp: một TK bất kỳ của CTA (xem test riêng về tên TK bên dưới)
  await pickFirstOption(page, fieldOf(page, 'Tài khoản nguồn'));

  await page.locator('label').filter({ hasText: 'Tiền chuyển cho tài khoản nội bộ' }).click();
  await pickPlainSelect(page, fieldOf(page, 'Công ty nhận'), '(CTB)');
  await pickLongSelect(page, fieldOf(page, 'Tài khoản nhận *'), ctbAccName);

  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await page.waitForURL(/\/ho-so\/chi\/[0-9a-f]{24}/, { timeout: 30_000 });
  const id = page.url().split('/').pop() as string;
  await assertNoPageCrash(page, 'chi tiết phiếu chuyển nội bộ vừa lưu');

  const doc = await getDoc(page, w.CTA, id);
  expect(doc.status).toBe('draft');
  expect(String(doc.transfer_target?.company_id)).toBe(w.CTB);
  expect(String(doc.transfer_target?.account_id)).toBe(ctbAccountId);
});

test('UI · phiếu chi "Nhận: tài khoản nội bộ" lập, gửi duyệt và thực thi trên giao diện ⇒ R1 tạo phiếu thu ở CTB (§11.6)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const page = w.staff;
  const supplierName = uniq('NCC nội bộ E2E');
  await createPartner(w.staff, w.CTA, 'supplier', supplierName);
  const ctbAccName = uniq('TK CTB E2E');
  const ctbAccountId = await createBankAccount(w.chairman, w.CTB, ctbAccName);
  // tài khoản nguồn của CTA: TK có số dư, chọn theo tên trên ô (đúng mục, không phải mục đầu)
  const srcId = await fundedCtaAccount(w);
  const srcList = dataOf<{ items: any[] }>(must(await req(w.chairman, 'GET', '/bank-accounts', { scope: w.CTA }), 'TK CTA')).items ?? [];
  const srcName = String(srcList.find((a) => String(a._id) === srcId)?.account_name ?? '');
  expect(srcName, 'TK nguồn có tên').toBeTruthy();
  const purpose = uniq('Chuyển nội bộ E2E UI');

  await openNewSpend(page);
  await pickSelect(page, fieldOf(page, 'Bên nhận tiền'), supplierName, supplierName);
  await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(purpose);
  await fieldOf(page, 'Số tiền *').locator('input').fill('1500000');
  await fieldOf(page, 'Số tiền *').locator('input').press('Tab');
  await pickLongSelect(page, fieldOf(page, 'Tài khoản nguồn'), srcName);
  await page.locator('label').filter({ hasText: 'Tiền chuyển cho tài khoản nội bộ' }).click();
  await pickPlainSelect(page, fieldOf(page, 'Công ty nhận'), '(CTB)');
  await pickLongSelect(page, fieldOf(page, 'Tài khoản nhận *'), ctbAccName);
  await page.locator('label').filter({ hasText: 'Gửi duyệt ngay sau khi tạo' }).click();
  await page.getByRole('button', { name: 'Tạo & gửi duyệt' }).click();
  await page.waitForURL(/\/ho-so\/chi\/[0-9a-f]{24}/, { timeout: 30_000 });
  const id = page.url().split('/').pop() as string;
  await assertNoPageCrash(page, 'chi tiết phiếu nội bộ vừa gửi duyệt');
  const sent = await getDoc(w.staff, w.CTA, id);
  expect(String(sent.transfer_target?.account_id)).toBe(ctbAccountId);
  expect(String(sent.transfer_target?.company_id)).toBe(w.CTB);

  // duyệt đủ cấp (API theo chuỗi), đính kèm UNC, thực thi trên giao diện
  await approveToFinal(w.approvers, w.CTA, id);
  await attachUnc(w.staff, w.CTA, id);
  await switchScope(page, 'CTA');
  await page.goto(`/ho-so/chi/${id}`);
  await page.waitForLoadState('networkidle');
  await assertNoPageCrash(page, 'chi tiết phiếu nội bộ đã duyệt');
  await page.getByRole('button', { name: 'Thực thi', exact: true }).first().click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toBeVisible();
  await fieldOf(dlg, 'Số tham chiếu ngân hàng').locator('input').fill(`FT${digits(10)}`);
  await dlg.getByRole('button', { name: /^Thực thi/ }).click();
  await expect(dlg).toBeHidden({ timeout: 25_000 });
  expect((await getDoc(page, w.CTA, id)).status).toBe('paid');

  const run = await waitForRun(page, w.CTA, id, 'R1', 'done');
  const receipt = await getDoc(w.chairman, w.CTB, generatedId(run, 'create_voucher') as string);
  expect(receipt.kind).toBe('income');
  expect(receipt.status).toBe('paid');
  expect(String(receipt.amount.minor)).toBe('1500000');
  expect(String(receipt.source.account_id)).toBe(ctbAccountId);
  expect(await balanceOf(w.chairman, w.CTB, ctbAccountId)).toBe(1_500_000n);
});

test('R1 · KTV lập phiếu chi "Nhận: tài khoản nội bộ" qua API tới TK của CTB (§11.6, §7.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const ctbAccountId = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB nhận nội bộ'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC nội bộ'));
  const srcId = await fundedCtaAccount(w);
  // Spec §11.6 / §7.5: phiếu chi của CTA chuyển cho TK của CTB ⇒ KTV lập được phiếu (công ty nhận thuộc phạm vi gán cho KTV)
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '1500000',
    sourceAccountId: srcId,
    purpose: uniq('Chuyển nội bộ qua API'),
    transferTarget: { companyId: w.CTB, accountId: ctbAccountId },
  });
  const doc = await getDoc(w.staff, w.CTA, created.id);
  expect(String(doc.transfer_target?.company_id)).toBe(w.CTB);
  expect(String(doc.transfer_target?.account_id)).toBe(ctbAccountId);
});

test('R1 · phiếu chi có đích nội bộ được thực thi ⇒ phiếu thu ở CTB đã duyệt + đã thực thi, liên kết internal_transfer, số dư CTB tăng (§11.6)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const ctbAccountId = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB nhận nội bộ'));
  const srcId = await fundedCtaAccount(w);
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC nội bộ'));
  // Lập phiếu chi có đích nội bộ qua API (đúng body web gửi), rồi chạy luồng thường: gửi duyệt → duyệt → UNC → thực thi
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '1500000',
    sourceAccountId: srcId,
    purpose: uniq('Chuyển nội bộ sang CTB'),
    transferTarget: { companyId: w.CTB, accountId: ctbAccountId },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt chuyển nội bộ');
  await approveToFinal(w.approvers, w.CTA, created.id);
  await attachUnc(w.staff, w.CTA, created.id);
  must(await payByApi(w.staff, w.CTA, created.id), 'thực thi chuyển nội bộ');

  const run = await waitForRun(w.staff, w.CTA, created.id, 'R1', 'done');
  expect(run.steps.map((s: any) => s.name)).toEqual(['create_voucher', 'execute_voucher', 'link']);
  const receiptId = generatedId(run, 'create_voucher') as string;
  const receipt = await getDoc(w.chairman, w.CTB, receiptId);
  expect(String(receipt.company_id)).toBe(w.CTB);
  expect(receipt.kind).toBe('income');
  expect(receipt.status).toBe('paid');
  expect(String(receipt.amount.minor)).toBe('1500000');
  expect(String(receipt.source.account_id)).toBe(ctbAccountId);
  expect.soft(receipt.origin?.rule_code).toBe('R1');
  expect.soft(String(receipt.purpose)).toMatch(/^\(Tự động nhập\) /);
  // phiếu thu kế thừa chuỗi duyệt của phiếu chi (§11.6: đã duyệt, kế thừa người duyệt)
  const approverKeys = (d: any) => (d.approval?.steps ?? []).map((s: any) => `${s.role}:${s.user_id ?? ''}`);
  expect.soft(approverKeys(receipt), 'chuỗi duyệt phiếu thu = chuỗi duyệt phiếu chi').toEqual(approverKeys(await getDoc(w.staff, w.CTA, created.id)));
  expect.soft(approverKeys(receipt).length, 'phiếu thu có ít nhất một cấp duyệt kế thừa').toBeGreaterThan(0);
  const payLinks = JSON.stringify((await getDoc(w.staff, w.CTA, created.id)).links ?? []);
  expect.soft(payLinks).toContain('internal_transfer');
  expect.soft(payLinks).toContain(receiptId);

  expect(await balanceOf(w.chairman, w.CTB, ctbAccountId)).toBe(1_500_000n);
  // Bút toán: CTA ghi chi 1.500.000 từ TK nguồn, CTB ghi thu 1.500.000 vào TK nhận (theo mã phiếu, không dựa số dư chung)
  const pay = await getDoc(w.staff, w.CTA, created.id);
  expect(await entriesOfDoc(w.chairman, w.CTA, srcId, String(pay.code))).toEqual([{ direction: 'out', amount: '1500000' }]);
  const receiptDoc = await getDoc(w.chairman, w.CTB, receiptId);
  expect(await entriesOfDoc(w.chairman, w.CTB, ctbAccountId, String(receiptDoc.code))).toEqual([{ direction: 'in', amount: '1500000' }]);
});

test('R1 + R3 độc lập: phiếu chi vừa vay để chi vừa chuyển nội bộ ⇒ R3 chạy khi duyệt cuối, R1 chạy khi thực thi (§11.5 ngoại lệ)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH combo'));
  const recvId = await createBankAccount(w.chairman, w.CTA, uniq('TK combo nhận'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC combo'));
  const ctbAccountId = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB combo'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '1500000',
    sourceAccountId: recvId,
    purpose: uniq('Chi vay rồi chuyển nội bộ'),
    loan: { lenderId: bankId, receiveAccountId: recvId, amountMinor: null, terms: { contract_no: `HĐTD-${digits(6)}`, interest_rate: '9.5', term_months: 12 } },
    transferTarget: { companyId: w.CTB, accountId: ctbAccountId },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt phiếu vay + chuyển nội bộ');
  await approveToFinal(w.approvers, w.CTA, created.id);

  const r3 = await waitForRun(w.staff, w.CTA, created.id, 'R3', 'done');
  expect(r3.steps.map((s: any) => s.name)).toEqual(R3_STEPS);
  // R1 chưa chạy khi mới duyệt (chỉ chạy khi phiếu chi đã thực thi)
  expect((await runsOf(w.staff, w.CTA, created.id)).filter((r) => r.rule_code === 'R1')).toHaveLength(0);

  await attachUnc(w.staff, w.CTA, created.id);
  must(await payByApi(w.staff, w.CTA, created.id), 'thực thi phiếu chi vừa vay vừa chuyển nội bộ');
  const r1 = await waitForRun(w.staff, w.CTA, created.id, 'R1', 'done');
  expect(r1.steps.map((s: any) => s.name)).toEqual(['create_voucher', 'execute_voucher', 'link']);
  const ctbReceipt = await getDoc(w.chairman, w.CTB, generatedId(r1, 'create_voucher') as string);
  expect(String(ctbReceipt.company_id)).toBe(w.CTB);
  expect(ctbReceipt.status).toBe('paid');
  // khoản vay của R3 vẫn Đang vay (R1 không ảnh hưởng)
  expect((await getLoan(w.staff, w.CTA, generatedId(r3, 'create_loan') as string)).status).toBe('active');
});

// ---------------------------------------------------------------------------------------------------------------
// Âm tính & biên
// ---------------------------------------------------------------------------------------------------------------

test('Âm tính · phiếu chi thường (không vay, không chuyển nội bộ) không sinh lượt tự động', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const srcId = await fundedCtaAccount(w);
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC thường'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '2000000',
    sourceAccountId: srcId,
    purpose: uniq('Chi thường không vay'),
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt');
  await approveToFinal(w.approvers, w.CTA, created.id);
  const runs = await runsOf(w.staff, w.CTA, created.id);
  expect(runs.filter((r) => r.rule_code === 'R3' || r.rule_code === 'R1')).toHaveLength(0);
  await switchScope(w.staff, 'CTA');
  await w.staff.goto(`/ho-so/chi/${created.id}`);
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'chi tiết phiếu chi thường');
  await expect(w.staff.getByText('Quy trình tự động', { exact: true })).toHaveCount(0);
});

test('UI · bật "Vay ngân hàng để chi" mà thiếu ngân hàng và TK nhận ⇒ form chặn lưu (§11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const page = w.staff;
  await openNewSpend(page);
  await page.locator('label').filter({ hasText: 'Vay ngân hàng để chi' }).click();
  await fieldOf(page, 'Số tiền *').locator('input').fill('1000000');
  await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(uniq('Thiếu ngân hàng'));
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page.getByText('Chọn ngân hàng cho vay', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Chọn tài khoản nhận giải ngân', { exact: false }).first()).toBeVisible();
  expect(page.url()).toContain('/chi/moi');
});

test('UI · ô "Ngân hàng cho vay" chỉ liệt kê đối tác loại Ngân hàng (§11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const supplierName = uniq('NCC không phải ngân hàng');
  await createPartner(w.staff, w.CTA, 'supplier', supplierName);
  const page = w.staff;
  await openNewSpend(page);
  await page.locator('label').filter({ hasText: 'Vay ngân hàng để chi' }).click();
  const field = fieldOf(page, 'Ngân hàng cho vay');
  await field.locator('.ant-select').first().click();
  await field.locator('input').first().fill(supplierName);
  await page.waitForTimeout(1200);
  const opts = await visibleOptions(page);
  console.log('[T18 bank picker options for supplier search]', JSON.stringify(opts));
  expect(opts.some((o) => o.includes(supplierName))).toBeFalsy();
  await page.keyboard.press('Escape');
});

// ---------------------------------------------------------------------------------------------------------------
// Vòng kiểm lại 5 — điều khoản vay, sửa phiếu nháp / bị trả về, từ chối của server, sổ cái & báo cáo, màn duyệt
// ---------------------------------------------------------------------------------------------------------------

/** Ngày + n tháng, kẹp ngày cuối tháng (sao y `addMonths` của apps/api/src/domain/loan-schedule). */
function addMonthsIso(iso: string, months: number): string {
  const [y0, m0, d0] = iso.slice(0, 10).split('-').map(Number);
  const base = new Date(Date.UTC(y0!, m0! - 1 + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(d0!, lastDay))).toISOString().slice(0, 10);
}

/** Khối tuỳ chọn vay để chi đúng dạng web gửi (`options.loan`, mode `new`). */
function fundLoanBody(lenderId: string, receiveAccountId: string, amountMinor: string | null, terms: Record<string, unknown> | null = null) {
  return { kind: 'fund', mode: 'new', lender_partner_id: lenderId, receive_account_id: receiveAccountId, amount_minor: amountMinor, existing_loan_id: null, terms };
}

/** Tạo phiếu chi qua API, KHÔNG ném lỗi (trả phản hồi để kiểm mã từ chối). Ngày kế hoạch mặc định là hôm nay. */
async function postSpend(
  page: Page,
  p: {
    companyId: string;
    partnerId: string;
    amountMinor: string;
    sourceAccountId: string;
    purpose: string;
    loan?: Record<string, unknown> | null;
    transferTarget?: { company_id: string; account_id: string | null } | null;
    plannedDate?: string;
  },
): Promise<Res> {
  return req(page, 'POST', '/documents', {
    scope: p.companyId,
    data: {
      kind: 'spend',
      company_id: p.companyId,
      title: p.purpose.slice(0, 120),
      purpose: p.purpose,
      partner_id: p.partnerId,
      amount: { amount_minor: p.amountMinor, currency: 'VND' },
      source: { fund: 'bank', account_id: p.sourceAccountId, group_managed: false },
      planned_date: p.plannedDate ?? `${vnToday()}T17:00`,
      priority: 'normal',
      budget: { in_plan: true },
      options: { loan: p.loan ?? null },
      transfer_target: p.transferTarget ?? null,
      tag_ids: [],
      request_id: randomUUID(),
    },
  });
}

/** Bút toán của MỘT phiếu trên một tài khoản, khớp đúng `document.code` (không khớp chuỗi trong nội dung bút toán). */
async function ledgerOfDocCode(page: Page, companyId: string, accountId: string, docCode: string): Promise<{ direction: string; amount: string }[]> {
  const r = dataOf<{ items: any[] }>(must(await req(page, 'GET', `/bank-accounts/${accountId}/transactions?limit=2000`, { scope: companyId }), 'bút toán tài khoản'));
  return (r.items ?? [])
    .filter((x) => String(x.document?.code ?? '') === docCode)
    .map((x) => ({ direction: String(x.direction), amount: String(x.amount?.minor ?? '') }));
}

/** Tổng chi trong báo cáo thu-chi ngày của một công ty (báo cáo đã loại chuyển nội bộ, §11.6). */
async function expenseOfDay(page: Page, companyId: string, day: string): Promise<bigint> {
  const rep = dataOf<any>(must(await req(page, 'GET', `/reports/thu-chi-ngay?from=${day}&to=${day}`, { scope: companyId }), 'báo cáo thu-chi ngày'));
  return BigInt(String(rep.totals?.expense?.minor ?? '0'));
}

/** Tài khoản ngân hàng mới của công ty đã khoá (không được chọn cho phiếu mới). */
async function frozenBankAccount(w: World, tag: string): Promise<string> {
  const id = await createBankAccount(w.chairman, w.CTA, uniq(`TK khoá ${tag}`));
  must(await setAccountStatus(w.chairman, w.CTA, id, 'frozen'), `khoá TK ${tag}`);
  return id;
}

/** Quỹ tiền mặt của công ty (kiểm: TK nhận giải ngân phải là TK ngân hàng). */
async function cashAccount(w: World, companyId: string, tag: string): Promise<string> {
  const r = must(
    await req(w.chairman, 'POST', '/bank-accounts', {
      scope: companyId,
      data: {
        company_id: companyId,
        is_group: false,
        bank_name: uniq(`Quỹ ${tag}`),
        account_name: uniq(`Quỹ tiền mặt ${tag}`),
        account_number: digits(8),
        currency: 'VND',
        kind: 'cash',
        status: 'active',
        min_balance_minor: '0',
        show_on_dashboard: true,
        request_id: randomUUID(),
      },
    }),
    `tạo quỹ tiền mặt ${tag}`,
  );
  return String(dataOf(r)._id);
}

test('R3 · khoản vay lưu đủ số HĐ tín dụng, TSĐB, lãi suất, kỳ hạn; hạn thanh toán mặc định = ngày giải ngân + 11 tháng (§10.1, §11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const contract = `HĐTD-${digits(6)}`;
  const collateral = uniq('TSĐB');
  const f = await fundPayment(w, { tag: 'ĐIỀU KHOẢN', terms: { contract_no: contract, interest_rate: '9.5', term_months: 12, collateral } });
  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const loan = await getLoan(w.staff, w.CTA, generatedId(run, 'create_loan') as string);
  expect(loan.contract_no, 'số HĐ tín dụng nằm ở trường riêng của khoản vay').toBe(contract);
  expect(loan.collateral, 'TSĐB nằm ở trường riêng của khoản vay').toBe(collateral);
  expect(String(loan.interest_rate)).toBe('9.5');
  expect(Number(loan.term_months)).toBe(12);
  expect(String(loan.maturity_date).slice(0, 10), 'hạn thanh toán = ngày giải ngân + 11 tháng').toBe(addMonthsIso(vnToday(), 11));
});

test('R3 · sửa điều khoản vay trên phiếu nháp (PATCH options.loan) rồi gửi duyệt ⇒ khoản vay theo điều khoản đã sửa (§11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH N2'));
  const accId = await createBankAccount(w.chairman, w.CTA, uniq('TK N2'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC N2'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: accId,
    purpose: uniq('Chi vay N2'),
    loan: { lenderId: bankId, receiveAccountId: accId, amountMinor: null, terms: { contract_no: 'HĐ-N2-CŨ', interest_rate: '9.5', term_months: 12 } },
  });
  const cur = await getDoc(w.staff, w.CTA, created.id);
  must(
    await req(w.staff, 'PATCH', `/documents/${created.id}`, {
      scope: w.CTA,
      data: {
        options: { loan: fundLoanBody(bankId, accId, null, { contract_no: 'HĐ-N2-MỚI', interest_rate: '10.5', term_months: 6, due_date: '2027-06-30' }) },
        if_match: cur.version,
        request_id: randomUUID(),
      },
    }),
    'sửa điều khoản vay trên phiếu nháp',
  );
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt phiếu đã sửa điều khoản');
  await approveToFinal(w.approvers, w.CTA, created.id);
  const run = await waitForRun(w.staff, w.CTA, created.id, 'R3', 'done');
  const loan = await getLoan(w.staff, w.CTA, generatedId(run, 'create_loan') as string);
  expect(loan.contract_no, 'số HĐ theo điều khoản đã sửa').toBe('HĐ-N2-MỚI');
  expect(String(loan.interest_rate)).toBe('10.5');
  expect(Number(loan.term_months)).toBe(6);
  expect(String(loan.maturity_date).slice(0, 10), 'hạn thanh toán do người lập nhập').toBe('2027-06-30');
});

test('R3 · phiếu nháp đổi số tiền trước khi gửi duyệt (vay để trống) ⇒ khoản vay và phiếu thu theo số tiền đã chốt (§11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH N5'));
  const accId = await createBankAccount(w.chairman, w.CTA, uniq('TK N5'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC N5'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: accId,
    purpose: uniq('Chi vay N5'),
    loan: { lenderId: bankId, receiveAccountId: accId, amountMinor: null, terms: { interest_rate: '9.5', term_months: 12 } },
  });
  const cur = await getDoc(w.staff, w.CTA, created.id);
  must(await req(w.staff, 'PATCH', `/documents/${created.id}`, { scope: w.CTA, data: { amount: { amount_minor: '8000000', currency: 'VND' }, if_match: cur.version, request_id: randomUUID() } }), 'đổi số tiền phiếu nháp');
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt phiếu đã đổi số tiền');
  await approveToFinal(w.approvers, w.CTA, created.id);
  const run = await waitForRun(w.staff, w.CTA, created.id, 'R3', 'done');
  const loan = await getLoan(w.staff, w.CTA, generatedId(run, 'create_loan') as string);
  const receipt = await getDoc(w.staff, w.CTA, generatedId(run, 'create_voucher') as string);
  expect(String(loan.principal.minor), 'gốc khoản vay theo số tiền đã chốt').toBe('8000000');
  expect(String(receipt.amount.minor), 'phiếu thu giải ngân theo số tiền đã chốt').toBe('8000000');
});

test('R3 · cấp duyệt TĂNG số tiền phiếu (vay để trống, KTT gõ lại số mới để xác nhận) ⇒ khoản vay và phiếu thu theo số mới (§7.2, §11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH N6'));
  const accId = await createBankAccount(w.chairman, w.CTA, uniq('TK N6'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC N6'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: accId,
    purpose: uniq('Chi vay N6'),
    loan: { lenderId: bankId, receiveAccountId: accId, amountMinor: null, terms: { interest_rate: '9.5', term_months: 12 } },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt N6');
  must(await transition(w.chief, w.CTA, created.id, 'approve', { amount_minor: '7000000', confirm_amount_minor: '7000000' }), 'KTT tăng số tiền và xác nhận');
  await approveToFinal(w.approvers, w.CTA, created.id);
  const run = await waitForRun(w.staff, w.CTA, created.id, 'R3', 'done');
  const loan = await getLoan(w.staff, w.CTA, generatedId(run, 'create_loan') as string);
  const receipt = await getDoc(w.staff, w.CTA, generatedId(run, 'create_voucher') as string);
  expect(String(loan.principal.minor), 'gốc khoản vay theo số tiền mới đã chốt').toBe('7000000');
  expect(String(receipt.amount.minor), 'phiếu thu giải ngân theo số tiền mới đã chốt').toBe('7000000');
});

test('R3 · phiếu bị trả về: bỏ tick "Vay để chi" ⇒ duyệt như phiếu thường, không R3, không liên kết funded_by (§11.5 ngoại lệ)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH N3'));
  const accId = await createBankAccount(w.chairman, w.CTA, uniq('TK N3'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC N3'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: accId,
    purpose: uniq('Chi vay N3'),
    loan: { lenderId: bankId, receiveAccountId: accId, amountMinor: null, terms: { interest_rate: '9.5', term_months: 12 } },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt N3');
  must(await transition(w.chief, w.CTA, created.id, 'request_changes', { reason: 'Bỏ vay, bổ sung chứng từ N3', opinion: 'Bỏ vay, bổ sung chứng từ N3' }), 'KTT trả về N3');
  const cur = await getDoc(w.staff, w.CTA, created.id);
  must(await req(w.staff, 'PATCH', `/documents/${created.id}`, { scope: w.CTA, data: { options: { loan: null }, if_match: cur.version, request_id: randomUUID() } }), 'bỏ tick vay khi phiếu bị trả về');
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi lại N3');
  await approveToFinal(w.approvers, w.CTA, created.id);
  await sleep(4000); // bộ máy tự động xử lý bất đồng bộ: chờ một nhịp rồi mới khẳng định không có lượt nào
  expect((await runsOf(w.staff, w.CTA, created.id)).filter((r) => r.rule_code === 'R3'), 'không có lượt R3').toHaveLength(0);
  const after = await getDoc(w.staff, w.CTA, created.id);
  expect(after.status).toBe('approved');
  expect(JSON.stringify(after.links ?? []), 'không có liên kết funded_by').not.toContain('funded_by');
});

test('R3 · phiếu bị trả về: đổi TK nhận giải ngân (và TK nguồn) ⇒ tiền giải ngân vào TK mới, TK cũ không đổi (§11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH N4'));
  const accA = await createBankAccount(w.chairman, w.CTA, uniq('TK N4 A'));
  const accB = await createBankAccount(w.chairman, w.CTA, uniq('TK N4 B'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC N4'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: accA,
    purpose: uniq('Chi vay N4'),
    loan: { lenderId: bankId, receiveAccountId: accA, amountMinor: null, terms: { interest_rate: '9.5', term_months: 12 } },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt N4');
  must(await transition(w.chief, w.CTA, created.id, 'request_changes', { reason: 'Đổi TK nhận N4', opinion: 'Đổi TK nhận N4' }), 'KTT trả về N4');
  const cur = await getDoc(w.staff, w.CTA, created.id);
  must(
    await req(w.staff, 'PATCH', `/documents/${created.id}`, {
      scope: w.CTA,
      data: {
        options: { loan: fundLoanBody(bankId, accB, null, { interest_rate: '9.5', term_months: 12 }) },
        source: { fund: 'bank', account_id: accB, group_managed: false },
        if_match: cur.version,
        request_id: randomUUID(),
      },
    }),
    'đổi TK nhận trên phiếu bị trả về',
  );
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi lại N4');
  await approveToFinal(w.approvers, w.CTA, created.id);
  const run = await waitForRun(w.staff, w.CTA, created.id, 'R3', 'done');
  const receipt = await getDoc(w.staff, w.CTA, generatedId(run, 'create_voucher') as string);
  expect(String(receipt.source.account_id), 'phiếu thu giải ngân vào TK nhận mới').toBe(accB);
  expect(await balanceOf(w.staff, w.CTA, accB), 'TK nhận mới có đủ tiền giải ngân').toBe(6_000_000n);
  expect(await balanceOf(w.staff, w.CTA, accA), 'TK nhận cũ không nhận tiền').toBe(0n);
});

test('Âm tính · server từ chối khoản vay để chi không hợp lệ: số tiền vay lớn hơn phiếu hoặc bằng 0, ngân hàng cho vay là nhà cung cấp, TK nhận là tiền mặt hoặc đã khoá (§11.5, §13.3)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH V1'));
  const accId = await createBankAccount(w.chairman, w.CTA, uniq('TK V1'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC V1'));
  const cashId = await cashAccount(w, w.CTA, 'V1');
  const frozenId = await frozenBankAccount(w, 'V1');
  const base = { companyId: w.CTA, partnerId: supplierId, amountMinor: '6000000', sourceAccountId: accId, purpose: uniq('Vay V1') };
  const cases: { name: string; res: Res }[] = [
    { name: 'số tiền vay lớn hơn số tiền phiếu', res: await postSpend(w.staff, { ...base, loan: fundLoanBody(bankId, accId, '7000000') }) },
    { name: 'số tiền vay bằng 0', res: await postSpend(w.staff, { ...base, loan: fundLoanBody(bankId, accId, '0') }) },
    { name: 'ngân hàng cho vay là nhà cung cấp', res: await postSpend(w.staff, { ...base, loan: fundLoanBody(supplierId, accId, null) }) },
    { name: 'TK nhận giải ngân là tiền mặt', res: await postSpend(w.staff, { ...base, loan: fundLoanBody(bankId, cashId, null) }) },
    { name: 'TK nhận giải ngân đã khoá', res: await postSpend(w.staff, { ...base, loan: fundLoanBody(bankId, frozenId, null) }) },
  ];
  for (const c of cases) expect.soft(c.res.status, `server phải từ chối: ${c.name}`).toBe(422);
});

test('Âm tính · server từ chối chuyển nội bộ tới TK đã khoá, TK không thuộc công ty nhận, công ty nhận trùng công ty lập phiếu; giám đốc (chỉ CTA) không gửi được sang CTB (§11.6, §7.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC V2'));
  const srcId = await fundedCtaAccount(w);
  const ctbAcc = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB V2'));
  const ctbFrozen = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB khoá V2'));
  must(await setAccountStatus(w.chairman, w.CTB, ctbFrozen, 'frozen'), 'khoá TK CTB');
  const ctaAcc = await createBankAccount(w.chairman, w.CTA, uniq('TK CTA V2'));
  const base = { companyId: w.CTA, partnerId: supplierId, amountMinor: '1500000', sourceAccountId: srcId, purpose: uniq('Chuyển V2') };
  const cases: { name: string; res: Res; want: number }[] = [
    { name: 'TK đích đã khoá', res: await postSpend(w.staff, { ...base, transferTarget: { company_id: w.CTB, account_id: ctbFrozen } }), want: 422 },
    { name: 'TK đích thuộc công ty khác công ty nhận', res: await postSpend(w.staff, { ...base, transferTarget: { company_id: w.CTB, account_id: ctaAcc } }), want: 422 },
    { name: 'công ty nhận trùng công ty lập phiếu', res: await postSpend(w.staff, { ...base, transferTarget: { company_id: w.CTA, account_id: ctaAcc } }), want: 422 },
    { name: 'giám đốc (chỉ CTA) gửi sang CTB', res: await postSpend(w.director, { ...base, transferTarget: { company_id: w.CTB, account_id: ctbAcc } }), want: 403 },
  ];
  for (const c of cases) expect.soft(c.res.status, `server phải từ chối: ${c.name}`).toBe(c.want);
});

test('Âm tính · server từ chối "Nhận: tài khoản nội bộ" khi chưa chọn TK nhận của công ty đích (§11.6; ô này bắt buộc trên form)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC V3'));
  const srcId = await fundedCtaAccount(w);
  const res = await postSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '1500000',
    sourceAccountId: srcId,
    purpose: uniq('Chuyển V3 thiếu TK nhận'),
    transferTarget: { company_id: w.CTB, account_id: null },
  });
  // Nếu server nhận phiếu này, phiếu chi có thể được thực thi (tiền ra khỏi CTA) mà R1 không có TK để ghi phiếu thu bên CTB.
  expect(res.status, 'phiếu chuyển nội bộ thiếu TK nhận phải bị từ chối khi lưu').toBe(422);
});

test('R3 · sổ cái theo mã phiếu: phiếu thu giải ngân vào TK nhận, phiếu chi thực thi ra khỏi TK nhận, mỗi phiếu đúng một bút toán (§8, US-EXE-02)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'SỔ CÁI' });
  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const receipt = await getDoc(w.staff, w.CTA, generatedId(run, 'create_voucher') as string);
  await attachUnc(w.staff, w.CTA, f.id);
  must(await payByApi(w.staff, w.CTA, f.id), 'thực thi phiếu chi');
  const pay = await getDoc(w.staff, w.CTA, f.id);
  expect(await ledgerOfDocCode(w.chairman, w.CTA, f.accountId, String(receipt.code)), 'bút toán phiếu thu giải ngân').toEqual([{ direction: 'in', amount: f.amountMinor }]);
  expect(await ledgerOfDocCode(w.chairman, w.CTA, f.accountId, String(pay.code)), 'bút toán phiếu chi').toEqual([{ direction: 'out', amount: f.amountMinor }]);
});

test('§11.6 · báo cáo thu-chi ngày không tính phiếu chi chuyển nội bộ; phiếu chi thường cùng ngày vẫn được tính (đối chứng)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  // ngày kế hoạch xa (2031) để không lẫn dữ liệu khác; đo chênh lệch trước/sau nên không phụ thuộc số liệu chung
  const day = `2031-0${1 + Math.floor(Math.random() * 8)}-1${Math.floor(Math.random() * 9)}`;
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC L2'));
  const srcId = await fundedCtaAccount(w);
  const ctbAcc = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB L2'));
  const before = await expenseOfDay(w.chief, w.CTA, day);

  const normalId = String(dataOf<{ _id: string }>(must(await postSpend(w.staff, { companyId: w.CTA, partnerId: supplierId, amountMinor: '1100000', sourceAccountId: srcId, purpose: uniq('L2 chi thường'), plannedDate: `${day}T17:00` }), 'tạo phiếu chi thường'))._id);
  must(await transition(w.staff, w.CTA, normalId, 'submit'), 'gửi duyệt phiếu chi thường');
  await approveToFinal(w.approvers, w.CTA, normalId);

  const internalId = String(
    dataOf<{ _id: string }>(
      must(await postSpend(w.staff, { companyId: w.CTA, partnerId: supplierId, amountMinor: '2200000', sourceAccountId: srcId, purpose: uniq('L2 nội bộ'), plannedDate: `${day}T17:00`, transferTarget: { company_id: w.CTB, account_id: ctbAcc } }), 'tạo phiếu chuyển nội bộ'),
    )._id,
  );
  must(await transition(w.staff, w.CTA, internalId, 'submit'), 'gửi duyệt phiếu chuyển nội bộ');
  await approveToFinal(w.approvers, w.CTA, internalId);
  await attachUnc(w.staff, w.CTA, internalId);
  must(await payByApi(w.staff, w.CTA, internalId), 'thực thi phiếu chuyển nội bộ');
  await waitForRun(w.staff, w.CTA, internalId, 'R1', 'done');

  const after = await expenseOfDay(w.chief, w.CTA, day);
  expect(String(after - before), 'chi trong báo cáo tăng đúng phiếu thường 1.100.000 (2.200.000 chuyển nội bộ không được tính)').toBe('1100000');
});

test('R1 · phiếu chi chuyển nội bộ đã thực thi: panel "Quy trình tự động" trên phiếu nêu mã phiếu thu ở CTB (US-AUTO-05, §11.6)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const ctbAcc = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB L3'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC L3'));
  const srcId = await fundedCtaAccount(w);
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '1500000',
    sourceAccountId: srcId,
    purpose: uniq('Chuyển L3'),
    transferTarget: { companyId: w.CTB, accountId: ctbAcc },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt phiếu chuyển nội bộ L3');
  await approveToFinal(w.approvers, w.CTA, created.id);
  await attachUnc(w.staff, w.CTA, created.id);
  must(await payByApi(w.staff, w.CTA, created.id), 'thực thi phiếu chuyển nội bộ L3');
  const run = await waitForRun(w.staff, w.CTA, created.id, 'R1', 'done');
  const receipt = await getDoc(w.chairman, w.CTB, generatedId(run, 'create_voucher') as string);

  await switchScope(w.staff, 'CTA');
  await w.staff.goto(`/ho-so/chi/${created.id}`);
  await w.staff.waitForLoadState('networkidle');
  await assertNoPageCrash(w.staff, 'chi tiết phiếu chuyển nội bộ đã thực thi');
  await expect(w.staff.getByText('Quy trình tự động', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  const bodyText = (await w.staff.locator('body').innerText()).replace(/\n+/g, ' | ');
  const at = bodyText.indexOf('Quy trình tự động');
  expect(bodyText.slice(at, at + 420), 'panel nêu phiếu thu tự động ở CTB đã thanh toán').toContain(String(receipt.code));
});

test('R3 · màn duyệt: "Sau giao dịch" của phiếu vay để chi tính cả khoản giải ngân sắp về TK nhận, không báo vượt ngưỡng giả (§8, §11.5, US-AUTO-04)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH D1'));
  const accId = await createBankAccount(w.chairman, w.CTA, uniq('TK D1 nhận (chưa có tiền)'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC D1'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: accId,
    purpose: uniq('Chi vay D1'),
    loan: { lenderId: bankId, receiveAccountId: accId, amountMinor: null, terms: { interest_rate: '9.5', term_months: 12 } },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt D1');
  const pack = dataOf<any>(must(await req(w.chief, 'GET', `/documents/${created.id}/decision-pack`, { scope: w.CTA }), 'gói quyết định D1'));
  const impact = pack.q6_impact ?? {};
  console.log('[IMPACT D1 decision pack]', JSON.stringify(impact));
  // TK nhận đang 0; khoản vay 6 tr giải ngân VÀO TK đó trước khi chi 6 tr ⇒ sau giao dịch = 0, không vượt ngưỡng
  expect.soft(String(impact.balance_after?.minor), 'số dư sau giao dịch: 6 tr giải ngân vào rồi 6 tr chi ra').toBe('0');
  expect.soft(impact.breach, 'không báo dưới ngưỡng tối thiểu (khoản vay đã về trước khi chi)').toBe(false);
});

test('R6 · huỷ phiếu chi đã R3 (tiền vay đã về): KTT gỡ liên kết funded_by thủ công (có lý do), khoản vay vẫn Đang vay (§11.5 ngoại lệ)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'GỠ FUNDED' });
  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const loanId = generatedId(run, 'create_loan') as string;
  must(await transition(w.staff, w.CTA, f.id, 'cancel', { reason: 'Huỷ phiếu để kiểm thử gỡ funded_by', opinion: 'Huỷ phiếu để kiểm thử gỡ funded_by' }), 'huỷ phiếu đã R3');
  await waitForRun(w.staff, w.CTA, f.id, 'R6', 'done');
  const loan = await getLoan(w.staff, w.CTA, loanId);
  const link = ((loan.funded_by_links ?? []) as any[]).find((l) => String(l.document_id) === f.id);
  expect(link, 'liên kết funded_by của phiếu đã huỷ còn hiệu lực trên khoản vay').toBeTruthy();
  const del = await w.chief.request.fetch(`/api/v1/bank-debts/${loanId}/funded-by/${String(link.link_id ?? link._id)}`, {
    method: 'DELETE',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'x-company-scope': w.CTA },
    data: { reason: 'Giữ khoản vay cho mục đích khác' },
    failOnStatusCode: false,
  });
  expect(del.ok(), `KTT gỡ funded_by thủ công được (HTTP ${del.status()})`).toBeTruthy();
  expect((await getLoan(w.staff, w.CTA, loanId)).status, 'khoản vay vẫn Đang vay sau khi gỡ liên kết').toBe('active');
});

// ---------------------------------------------------------------------------------------------------------------
// Vòng kiểm lại 6 — bug #1 (chuyển nội bộ thiếu TK nhận), bug #2 ("Sau giao dịch" của phiếu vay để chi), R1 lỗi rồi chạy lại
// ---------------------------------------------------------------------------------------------------------------

test('Âm tính · sửa nháp chuyển nội bộ: bỏ TK nhận (PATCH transfer_target.account_id = null) ⇒ 422, TK cũ giữ nguyên; bỏ hẳn chuyển nội bộ vẫn được (§11.6, bug #1)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC V6 PATCH'));
  const srcId = await fundedCtaAccount(w);
  const ctbAcc = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB V6 PATCH'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '1500000',
    sourceAccountId: srcId,
    purpose: uniq('Chuyển V6 PATCH'),
    transferTarget: { companyId: w.CTB, accountId: ctbAcc },
  });
  const before = await getDoc(w.staff, w.CTA, created.id);
  const bad = await req(w.staff, 'PATCH', `/documents/${created.id}`, {
    scope: w.CTA,
    data: { transfer_target: { company_id: w.CTB, account_id: null }, if_match: before.version, request_id: randomUUID() },
  });
  expect(bad.status, 'bỏ TK nhận của phiếu chuyển nội bộ phải bị từ chối khi sửa nháp').toBe(422);
  const kept = await getDoc(w.staff, w.CTA, created.id);
  expect(String(kept.transfer_target?.account_id), 'TK nhận cũ không bị xoá khi PATCH bị từ chối').toBe(ctbAcc);
  // bỏ hẳn chuyển nội bộ (đích = null) vẫn hợp lệ: không còn ô nào bắt buộc
  must(
    await req(w.staff, 'PATCH', `/documents/${created.id}`, {
      scope: w.CTA,
      data: { transfer_target: null, if_match: kept.version, request_id: randomUUID() },
    }),
    'bỏ hẳn chuyển nội bộ của phiếu nháp',
  );
  expect((await getDoc(w.staff, w.CTA, created.id)).transfer_target ?? null, 'đích chuyển nội bộ đã bỏ').toBeNull();
});

test('UI · "Nhận: tài khoản nội bộ" đã chọn công ty nhận nhưng chưa chọn TK nhận ⇒ "Lưu nháp" bị chặn ngay ở form, báo lỗi dưới ô "Tài khoản nhận" (§11.6, bug #1)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const page = w.staff;
  const supplierName = uniq('NCC nội bộ thiếu TK');
  await createPartner(w.staff, w.CTA, 'supplier', supplierName);
  await openNewSpend(page);
  await pickSelect(page, fieldOf(page, 'Bên nhận tiền'), supplierName, supplierName);
  await fieldOf(page, 'Nội dung / mục đích').locator('textarea').fill(uniq('Chuyển nội bộ thiếu TK UI'));
  await fieldOf(page, 'Số tiền *').locator('input').fill('1500000');
  await fieldOf(page, 'Số tiền *').locator('input').press('Tab');
  await pickFirstOption(page, fieldOf(page, 'Tài khoản nguồn'));
  await page.locator('label').filter({ hasText: 'Tiền chuyển cho tài khoản nội bộ' }).click();
  await pickPlainSelect(page, fieldOf(page, 'Công ty nhận'), '(CTB)');
  // cố ý KHÔNG chọn "Tài khoản nhận"
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Chọn tài khoản nhận' }).first()).toBeVisible({ timeout: 10_000 });
  await assertNoPageCrash(page, 'form chuyển nội bộ thiếu TK nhận');
  expect(page.url(), 'không chuyển sang hồ sơ mới khi thiếu TK nhận').not.toMatch(/\/ho-so\/chi\//);
});

test('UI · modal duyệt phiếu vay để chi: "Sau giao dịch" = 0 ₫ khi khoản vay về đúng TK nguồn trước khi chi (6 tr về, 6 tr chi), không báo dưới ngưỡng giả (bug #2, US-AUTO-04)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH D1 UI'));
  const accId = await createBankAccount(w.chairman, w.CTA, uniq('TK D1 UI nhận (chưa có tiền)'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC D1 UI'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: accId,
    purpose: uniq('Chi vay D1 UI'),
    loan: { lenderId: bankId, receiveAccountId: accId, amountMinor: null, terms: { interest_rate: '9.5', term_months: 12 } },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt D1 UI');
  await switchScope(w.chief, 'CTA');
  await w.chief.goto(`/ho-so/chi/${created.id}`);
  await w.chief.waitForLoadState('networkidle');
  await assertNoPageCrash(w.chief, 'chi tiết phiếu vay để chi (D1 UI)');
  await w.chief.getByRole('button', { name: /^Duyệt khoản/ }).first().click();
  const dlg = w.chief.getByRole('dialog');
  await expect(dlg).toBeVisible();
  const row = (label: string) => dlg.locator('.fg-sum-row').filter({ hasText: label }).first();
  await expect(row('Sau giao dịch')).toBeVisible({ timeout: 20_000 });
  // chờ gói quyết định tải xong (giá trị có chữ số; lúc đang tải chỉ có nhãn)
  let after = '';
  for (let i = 0; i < 40; i++) {
    after = ((await row('Sau giao dịch').innerText()) ?? '').replace(/\s+/g, ' ').trim();
    if (/\d/.test(after)) break;
    await sleep(300);
  }
  const before = ((await row('Số dư trước giao dịch').innerText()) ?? '').replace(/\s+/g, ' ').trim();
  console.log('[D1 UI modal rows]', JSON.stringify({ before, after }));
  expect(after, '"Sau giao dịch" = 0 ₫: khoản vay về TK nhận (cũng là TK nguồn) trước, rồi chi 6 tr').toMatch(/^Sau giao dịch 0\s*₫$/);
  expect(before, '"Số dư trước giao dịch" = 0 ₫').toMatch(/^Số dư trước giao dịch 0\s*₫$/);
  await expect(dlg.getByText('Sau giao dịch sẽ dưới ngưỡng tối thiểu'), 'không báo dưới ngưỡng tối thiểu giả').toHaveCount(0);
});

test('R3 · TK nhận giải ngân KHÁC TK nguồn ⇒ "Sau giao dịch" của TK nguồn chỉ trừ số tiền chi, không cộng khoản vay về TK khác (§8, §11.5)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH V6 khác TK'));
  const recvAcc = await createBankAccount(w.chairman, w.CTA, uniq('TK V6 nhận (khác nguồn)'));
  const srcId = await fundedCtaAccount(w);
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC V6 khác TK'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: srcId,
    purpose: uniq('Chi vay V6 khác TK'),
    loan: { lenderId: bankId, receiveAccountId: recvAcc, amountMinor: null, terms: { interest_rate: '9.5', term_months: 12 } },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt V6 khác TK');
  const pack = dataOf<any>(must(await req(w.chief, 'GET', `/documents/${created.id}/decision-pack`, { scope: w.CTA }), 'gói quyết định V6 khác TK'));
  console.log('[V6 khác TK q6]', JSON.stringify(pack.q6_impact));
  const before = BigInt(String(pack.q6_impact?.balance_before?.minor));
  const after = BigInt(String(pack.q6_impact?.balance_after?.minor));
  expect(after, 'TK nguồn chỉ trừ 6 tr; khoản vay về TK khác không được cộng vào TK nguồn').toBe(before - 6_000_000n);
});

test('R1 + R3 · chạy lại lượt ĐÃ HOÀN TẤT bị từ chối, không sinh đối tượng trùng: TK đích cộng đúng một lần, khoản vay không nhân đôi (§11.3 idempotency)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  // R1: chuyển nội bộ đã thực thi xong
  const ctbAcc = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB rerun xong'));
  const srcId = await fundedCtaAccount(w);
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC rerun xong'));
  const r1 = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '1500000',
    sourceAccountId: srcId,
    purpose: uniq('Chuyển rerun xong'),
    transferTarget: { companyId: w.CTB, accountId: ctbAcc },
  });
  must(await transition(w.staff, w.CTA, r1.id, 'submit'), 'gửi duyệt chuyển nội bộ (rerun xong)');
  await approveToFinal(w.approvers, w.CTA, r1.id);
  await attachUnc(w.staff, w.CTA, r1.id);
  must(await payByApi(w.staff, w.CTA, r1.id), 'thực thi chuyển nội bộ (rerun xong)');
  const run1 = await waitForRun(w.staff, w.CTA, r1.id, 'R1', 'done');
  const receiptCode = String((await getDoc(w.chairman, w.CTB, generatedId(run1, 'create_voucher') as string)).code);

  // R3: vay để chi đã R3 xong (khoản vay về TK nhận giải ngân)
  const f = await fundPayment(w, { tag: 'RERUN XONG' });
  await approveToFinal(w.approvers, w.CTA, f.id);
  const run3 = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const loanId = generatedId(run3, 'create_loan') as string;

  // chạy lại cả hai lượt đã xong ⇒ server từ chối (không còn bước nào chưa xong)
  for (const [label, run] of [
    ['R1', run1],
    ['R3', run3],
  ] as const) {
    const res = await req(w.chief, 'POST', `/automation/runs/${run._id}/rerun`, { scope: w.CTA, data: { request_id: randomUUID() } });
    expect(res.ok, `chạy lại lượt ${label} đã hoàn tất phải bị từ chối`).toBeFalsy();
    expect(JSON.stringify(res.body), `lý do từ chối lượt ${label}`).toMatch(/hoàn tất|không cần chạy lại/);
  }
  // không sinh trùng: một lượt mỗi quy tắc; TK đích cộng đúng một lần; khoản vay vẫn một và đang vay
  expect((await runsOf(w.staff, w.CTA, r1.id)).filter((r) => r.rule_code === 'R1').length, 'không tạo lượt R1 trùng').toBe(1);
  expect((await runsOf(w.staff, w.CTA, f.id)).filter((r) => r.rule_code === 'R3').length, 'không tạo lượt R3 trùng').toBe(1);
  expect(await balanceOf(w.chairman, w.CTB, ctbAcc), 'TK đích CTB cộng đúng một lần').toBe(1_500_000n);
  expect(await entriesOfDoc(w.chairman, w.CTB, ctbAcc, receiptCode)).toEqual([{ direction: 'in', amount: '1500000' }]);
  expect(await balanceOf(w.chairman, w.CTA, f.accountId), 'TK nhận giải ngân R3 chỉ có một lần 6 tr').toBe(6_000_000n);
  expect((await getLoan(w.staff, w.CTA, loanId)).status, 'khoản vay R3 vẫn Đang vay (không tạo khoản thứ hai)').toBe('active');
});

test('UI · phiếu thu giải ngân do R3 sinh ra mang nhãn "Tự động · R3" và mở được từ giao diện (§11.3, US-AUTO-05)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const f = await fundPayment(w, { tag: 'NHÃN R3' });
  await approveToFinal(w.approvers, w.CTA, f.id);
  const run = await waitForRun(w.staff, w.CTA, f.id, 'R3', 'done');
  const receiptId = generatedId(run, 'create_voucher') as string;
  await switchScope(w.chief, 'CTA');
  await w.chief.goto(`/ho-so/thu/${receiptId}`);
  await w.chief.waitForLoadState('networkidle');
  await assertNoPageCrash(w.chief, 'phiếu thu giải ngân tự động (R3)');
  await expect(w.chief.getByText('Tự động · R3', { exact: true }).first(), 'nhãn Tự động · R3 trên phiếu thu sinh ra').toBeVisible({ timeout: 20_000 });
  await expect(w.chief.getByLabel('Phiếu do quy trình tự động sinh ra').first()).toBeVisible();
});

test('UI · phiếu thu chuyển nội bộ do R1 sinh ra ở CTB mang nhãn "Tự động · R1" và mở được từ giao diện (§11.3, §11.6)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const ctbAcc = await createBankAccount(w.chairman, w.CTB, uniq('TK CTB nhãn R1'));
  const srcId = await fundedCtaAccount(w);
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC nhãn R1'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '1500000',
    sourceAccountId: srcId,
    purpose: uniq('Chuyển nhãn R1'),
    transferTarget: { companyId: w.CTB, accountId: ctbAcc },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt chuyển nội bộ (nhãn R1)');
  await approveToFinal(w.approvers, w.CTA, created.id);
  await attachUnc(w.staff, w.CTA, created.id);
  must(await payByApi(w.staff, w.CTA, created.id), 'thực thi chuyển nội bộ (nhãn R1)');
  const run = await waitForRun(w.staff, w.CTA, created.id, 'R1', 'done');
  const receiptId = generatedId(run, 'create_voucher') as string;
  await switchScope(w.chief, 'CTB');
  await w.chief.goto(`/ho-so/thu/${receiptId}`);
  await w.chief.waitForLoadState('networkidle');
  await assertNoPageCrash(w.chief, 'phiếu thu chuyển nội bộ tự động (R1) ở CTB');
  await expect(w.chief.getByText('Tự động · R1', { exact: true }).first(), 'nhãn Tự động · R1 trên phiếu thu ở CTB').toBeVisible({ timeout: 20_000 });
  await expect(w.chief.getByLabel('Phiếu do quy trình tự động sinh ra').first()).toBeVisible();
});

test('UI · modal duyệt: KTT đổi "Tài khoản nguồn" ngay khi duyệt ⇒ khối "Nguồn tiền & ảnh hưởng số dư" (TK, số dư trước) theo TK vừa chọn, không giữ số của TK cũ (US-APR-03, §6.3, US-AUTO-04)', async ({ as }) => {
  test.setTimeout(T);
  const w = await world(as);
  const bankId = await createPartner(w.staff, w.CTA, 'bank', uniq('NH ĐỔI TK'));
  const accA = await createBankAccount(w.chairman, w.CTA, uniq('TK ĐỔI TK A (nhận, 0 đồng)'));
  const supplierId = await createPartner(w.staff, w.CTA, 'supplier', uniq('NCC ĐỔI TK'));
  const created = await createSpend(w.staff, {
    companyId: w.CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: accA,
    purpose: uniq('Chi ĐỔI TK'),
    loan: { lenderId: bankId, receiveAccountId: accA, amountMinor: null, terms: { interest_rate: '9.5', term_months: 12 } },
  });
  must(await transition(w.staff, w.CTA, created.id, 'submit'), 'gửi duyệt (đổi TK nguồn khi duyệt)');
  // TK B: tài khoản khác của CTA có số dư lớn (để số dư trước giao dịch khác 0)
  const accs = dataOf<{ items: any[] }>(must(await req(w.chairman, 'GET', '/bank-accounts', { scope: w.CTA }), 'TK CTA')).items ?? [];
  let bId = '';
  for (const a of accs) {
    if (a.kind !== 'bank' || a.status !== 'active' || String(a._id) === accA) continue;
    if ((await balanceOf(w.chairman, w.CTA, String(a._id))) > 5_000_000n) {
      bId = String(a._id);
      break;
    }
  }
  expect(bId, 'có TK CTA khác có số dư để đổi sang').toBeTruthy();
  const bName = String(accs.find((a) => String(a._id) === bId)?.account_name ?? '');
  const bBal = await balanceOf(w.chairman, w.CTA, bId);

  await switchScope(w.chief, 'CTA');
  await w.chief.goto(`/ho-so/chi/${created.id}`);
  await w.chief.waitForLoadState('networkidle');
  await w.chief.getByRole('button', { name: /^Duyệt khoản/ }).first().click();
  const dlg = w.chief.getByRole('dialog');
  await expect(dlg).toBeVisible();
  const row = (label: string) => dlg.locator('.fg-sum-row').filter({ hasText: label }).first();
  await expect(row('Số dư trước giao dịch')).toBeVisible({ timeout: 20_000 });

  // KTT mở ô "Tài khoản nguồn" của modal, cuộn danh sách về đầu rồi chọn TK B
  await fieldOf(dlg, 'Tài khoản nguồn').locator('.ant-select').first().click();
  const dd = w.chief.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dd.waitFor({ state: 'visible', timeout: 10_000 });
  const scrollDropdown = (toTop: boolean) =>
    dd.evaluate((root, top) => {
      const all = [root as HTMLElement, ...Array.from(root.querySelectorAll<HTMLElement>('*'))];
      const el = all.filter((e) => e.clientHeight > 0 && e.scrollHeight > e.clientHeight + 10).sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!el) return;
      el.scrollTop = top ? 0 : el.scrollTop + Math.max(40, Math.floor(el.clientHeight / 2));
    }, toTop);
  await scrollDropdown(true);
  const optB = dd.locator('.ant-select-item-option').filter({ hasText: bName });
  for (let i = 0; i < 1200 && (await optB.count()) === 0; i++) {
    await scrollDropdown(false);
    await sleep(25);
  }
  expect(await optB.count(), 'mục TK B có trong danh sách của modal').toBeGreaterThan(0);
  await optB.first().click();
  await sleep(300);

  // sau khi đổi, khối nguồn tiền phải nêu TK vừa chọn và số dư trước giao dịch của TK đó (không giữ số của TK cũ)
  await expect
    .poll(async () => ((await row('Tài khoản nguồn').innerText()) ?? '').replace(/\s+/g, ' '), { timeout: 8_000, message: 'khối nguồn tiền theo TK vừa chọn' })
    .toContain(bName);
  const beforeText = ((await row('Số dư trước giao dịch').innerText()) ?? '').replace(/\s+/g, ' ');
  console.log('[ĐỔI TK pack sau khi chọn B]', JSON.stringify({ src: await row('Tài khoản nguồn').innerText(), before: beforeText, expectB: bBal.toString() }));
  expect(beforeText.replace(/\D/g, ''), 'số dư trước giao dịch là số dư TK vừa chọn, không phải TK cũ (0)').toContain(bBal.toString());
});

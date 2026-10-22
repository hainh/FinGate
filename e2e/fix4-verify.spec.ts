/**
 * E2E kiểm chứng các lỗi nhóm fix4 (tags / vouchers / R2 / loans) — spec riêng, không sửa spec gốc.
 *
 *   PW_AREA=fix4 npx playwright test e2e/fix4-verify.spec.ts
 *
 * Dữ liệu tạo qua API (helpers-loans), kiểm tra hành vi bằng UI thật. Tên dữ liệu dùng uniq(...).
 */
import { randomUUID } from 'node:crypto';
import { test, expect, uniq } from './fixtures';
import { api, ensureTagApi } from './helpers-tags';
import {
  addDays,
  approveChain,
  createBank,
  createLoanApi,
  createSupplier,
  createVoucherApi,
  ctaBankAccount,
  fieldInput,
  findCta,
  getLoanApi,
  getVoucherApi,
  LONG_REASON,
  scopeOf,
  spendBody,
  toDdmmyyyy,
  transitionApi,
  typeDate,
  vnToday,
} from './helpers-loans';

const SEARCH_PLACEHOLDER = 'Tìm theo mã hoặc tên ngân hàng';

test.describe('fix4 · kiểm chứng sửa lỗi', () => {
  test('UI · phiếu chi đã duyệt: "Đưa vào hàng thanh toán" → Đang thanh toán (chưa trừ số dư), vẫn còn "Thực thi"', async ({ as }) => {
    test.setTimeout(240_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await findCta(staff);
    const supplier = await createSupplier(staff, cta, 'NCC fix4 hàng chờ');
    const accountId = await ctaBankAccount(staff, cta);
    const v = await createVoucherApi(staff, cta, spendBody({ partnerId: supplier.id, accountId, amountMinor: '5000000', title: uniq('Hàng chờ fix4') }));
    await transitionApi(staff, cta, v._id, 'submit');
    const finalDoc = await approveChain({ staff, chief, director, chairman }, cta, v._id);
    expect(finalDoc.status, 'phiếu 5 triệu duyệt xong (đã duyệt, chưa thực thi)').toBe('approved');

    await staff.goto(`/ho-so/chi/${v._id}`);
    const bar = staff.getByRole('toolbar', { name: 'Hành động phê duyệt' });
    const queueBtn = bar.getByRole('button', { name: 'Đưa vào hàng thanh toán', exact: true });
    await expect(queueBtn, 'thanh hành động có nút "Đưa vào hàng thanh toán"').toBeVisible({ timeout: 15_000 });
    await queueBtn.click();
    const modal = staff.locator('.ant-modal-wrap:visible, [role="dialog"]:visible').last();
    await modal.locator('.ant-modal-footer').getByRole('button', { name: 'Đưa vào hàng thanh toán', exact: true }).click();

    await expect.poll(async () => (await getVoucherApi(staff, cta, v._id)).status, { timeout: 20_000, message: 'trạng thái sau khi đưa vào hàng' }).toBe('processing');
    await staff.reload();
    await expect(staff.getByText('Đang thanh toán', { exact: false }).first(), 'chip trạng thái "Đang thanh toán"').toBeVisible({ timeout: 15_000 });
    await expect(bar.getByRole('button', { name: 'Thực thi', exact: true }), 'vẫn có nút "Thực thi" từ Đang thanh toán').toBeVisible({ timeout: 15_000 });
    await expect(bar.getByRole('button', { name: 'Đưa vào hàng thanh toán', exact: true }), 'không còn nút đưa vào hàng khi đã đang thanh toán').toHaveCount(0);
  });

  test('API · duyệt tăng số tiền không xác nhận ⇒ 422 FG-WF-007, tiêu đề nêu đúng nguyên nhân (không nói "ngoài ngân sách")', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const cta = await findCta(staff);
    const supplier = await createSupplier(staff, cta, 'NCC fix4 tăng tiền');
    const accountId = await ctaBankAccount(staff, cta);
    const v = await createVoucherApi(staff, cta, spendBody({ partnerId: supplier.id, accountId, amountMinor: '5000000', title: uniq('Tăng tiền fix4') }));
    await transitionApi(staff, cta, v._id, 'submit');
    const cur = await getVoucherApi(chief, cta, v._id);
    const res = await chief.request.post(`/api/v1/documents/${v._id}/transition`, {
      headers: scopeOf(cta),
      data: { action: 'approve', if_match: cur.version, request_id: randomUUID(), reason: LONG_REASON, amount_minor: '6000000' },
    });
    const body = (await res.json()) as { code?: string; title?: string; detail?: string; data?: Record<string, unknown> };
    expect(res.status(), `duyệt tăng số tiền không xác nhận: ${JSON.stringify(body).slice(0, 200)}`).toBe(422);
    expect(body.code).toBe('FG-WF-007');
    expect(body.title, 'tiêu đề đúng nguyên nhân tăng số tiền').toBe('Số tiền duyệt tăng — cần xác nhận');
    expect(body.title ?? '', 'tiêu đề không nói "ngoài ngân sách" khi khoản nằm trong ngân sách').not.toContain('ngoài ngân sách');
    expect(body.data?.previous_amount_minor, 'số tiền trước khi tăng').toBe('5000000');
    expect((await getVoucherApi(chief, cta, v._id)).status, 'phiếu không đổi trạng thái').toBe('pending.ktt');
  });

  test('UI · phương án đảo hạn: ô ngày nhập DD/MM/YYYY, lãi "9,5" giữ dấu phẩy; lịch sử khoản vay ghi "Kết quả đảo hạn"', async ({ as }) => {
    test.setTimeout(300_000);
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const cta = await findCta(staff);
    const bank = await createBank(staff, cta, 'NH fix4 đảo hạn');
    const today = vnToday();
    const oldMaturity = addDays(today, 20);
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '30000000', currency: 'VND' },
      disbursed_date: addDays(today, -60),
      maturity_date: oldMaturity,
      interest_rate: '9,5',
      contract_no: 'HDTD-FIX4-001',
    });
    const loanCode = (await getLoanApi(staff, cta, loan._id)).code as string;

    // 1) KTV lập phương án đảo hạn
    await staff.goto('/ngan-hang/dao-han');
    await staff.locator('a', { hasText: '+ Lập phương án đảo hạn' }).first().click();
    await expect(staff).toHaveURL(/\/ngan-hang\/dao-han\/phuong-an\/moi/);
    const picker = fieldInput(staff, /^Ngân hàng$/);
    await picker.click();
    await picker.fill(bank.name);
    await staff.locator('.ant-select-item-option', { hasText: bank.name }).first().click();
    await fieldInput(staff, 'Khoản vay đang đảo hạn').click();
    await staff.locator('.ant-select-item-option', { hasText: loanCode }).first().click();
    await fieldInput(staff, 'Số tiền *').fill('30000000');
    const deadline = fieldInput(staff, 'Hạn thanh toán (deadline)');
    await deadline.click();
    await deadline.fill(`${toDdmmyyyy(today)} 09:00`);
    await deadline.press('Enter');
    await staff.keyboard.press('Escape').catch(() => undefined);
    await fieldInput(staff, 'Nội dung / mục đích').fill('E2E fix4: đảo hạn khoản vay trước khi đến hạn');
    await fieldInput(staff, 'Tài khoản nguồn').click();
    await staff.locator('.ant-select-item-option', { hasText: 'mbb' }).first().click();
    const newMaturity = addDays(oldMaturity, 365);
    await typeDate(staff, 'Ngày đáo hạn mới', newMaturity);
    await fieldInput(staff, 'Phương án đảo hạn', 'textarea').fill('Gia hạn 12 tháng, giữ nguyên TSĐB');
    await fieldInput(staff, 'Lãi suất mới (%/năm)').fill('9,5');
    await staff.getByText('Gửi duyệt ngay sau khi tạo').click();
    await staff.getByRole('button', { name: 'Tạo & gửi duyệt' }).click();
    await expect(staff).toHaveURL(/\/ho-so\/dao-han\/[0-9a-f]{24}/, { timeout: 20_000 });
    const docId = staff.url().split('/').pop() as string;

    // 2) duyệt đủ cấp
    const approved = await approveChain({ staff, chief, director, chairman }, cta, docId);
    expect(approved.status).toBe('approved');

    // 3) Giám đốc ghi kết quả: ô ngày gõ DD/MM/YYYY (DS §7.8), lãi gõ "9,5"
    const newContract = uniq('HDTD-FIX4').slice(0, 60);
    await findCta(director);
    await director.goto(`/ho-so/dao-han/${docId}`);
    await expect(director.getByText('Phương án đảo hạn', { exact: true }).first()).toBeVisible();
    await expect(fieldInput(director, 'Ngày đáo hạn mới'), 'ô ngày không dùng placeholder ISO').not.toHaveAttribute('placeholder', 'YYYY-MM-DD');
    await typeDate(director, 'Ngày thực hiện', today);
    await typeDate(director, 'Ngày đáo hạn mới', newMaturity);
    await fieldInput(director, 'Số hợp đồng mới').fill(newContract);
    await fieldInput(director, 'Hạn mức mới').fill('40000000');
    await fieldInput(director, 'Lãi suất mới (%/năm) *').fill('9,5');
    await fieldInput(director, 'Phí thực tế').fill('500000');
    await director.getByRole('button', { name: 'Lưu kết quả thực hiện' }).click();
    await expect(director.getByText('Đã cập nhật kết quả đảo hạn'), 'lưu kết quả đảo hạn được chấp nhận').toBeVisible({ timeout: 15_000 });

    // 4) khoản vay: hạn mới, HĐ mới; lãi lưu theo dấu phẩy "9,5" (cùng giá trị 9,5)
    const updated = await getLoanApi(staff, cta, loan._id);
    expect(updated.maturity_date).toBe(newMaturity);
    expect(updated.contract_no).toBe(newContract);
    expect(Number(String(updated.interest_rate).replace(',', '.'))).toBe(9.5);

    // 5) dòng kết quả hiện lãi "9,5%/năm" (không "9.5%")
    await findCta(chairman);
    await chairman.goto(`/ho-so/dao-han/${docId}`);
    const resultLine = chairman.getByText(/Đã thực hiện.*đáo hạn mới/).first();
    await expect(resultLine, 'dòng kết quả hiện lãi theo dấu phẩy').toContainText('9,5%/năm');
    await expect(resultLine, 'dòng kết quả không hiện dấu chấm').not.toContainText('9.5%');

    // 6) lịch sử khoản vay: cột "Thao tác" là nhãn tiếng Việt
    await staff.goto(`/ngan-hang/khoan-vay/${loan._id}`);
    const historyCard = staff.getByText('Lịch sử thay đổi', { exact: true }).first().locator('xpath=ancestor::*[.//table][1]');
    await expect(historyCard.locator('tr', { hasText: 'Kết quả đảo hạn' }).first(), 'lịch sử khoản vay ghi "Kết quả đảo hạn"').toBeVisible({ timeout: 15_000 });
    await expect(historyCard, 'không hiện mã rollover_result').not.toContainText('rollover_result');
    await expect(historyCard, 'không hiện mã create').not.toContainText(/(^|\s)create(\s|$)/);
  });

  test('API · ADM-12: đổi tên tag ghi diff trước → sau (name: before/after), không để dạng {from, to} thô', async ({ as }) => {
    const chief = await as('chief');
    const cta = await findCta(chief);
    const oldName = uniq('Tag fix4 cũ');
    const newName = uniq('Tag fix4 mới');
    const id = await ensureTagApi(chief, cta.id, oldName);
    const r = await api(chief, 'PATCH', `/tags/${id}`, { scope: cta.id, data: { name: newName } });
    expect(r.status, `đổi tên tag: ${JSON.stringify(r.body).slice(0, 200)}`).toBe(200);

    const res = await chief.request.get('/api/v1/audit-log', { headers: scopeOf(cta), params: { action: 'tag.update', subject_id: id, limit: '5' } });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { items: { action: string; diff_fields: { field: string; before: unknown; after: unknown }[] }[] };
    const row = body.items.find((x) => x.action === 'tag.update');
    expect(row, 'audit có dòng tag.update của tag vừa đổi tên').toBeTruthy();
    const nameDiff = row!.diff_fields.find((d) => d.field === 'name');
    expect(nameDiff, 'diff có trường name').toBeTruthy();
    expect(nameDiff!.before, 'trước: tên cũ').toBe(oldName);
    expect(nameDiff!.after, 'sau: tên mới').toBe(newName);
  });

  test('UI · danh sách khoản vay: lãi suất lưu kiểu cũ "9.5" hiện "9,5 %/năm" (không hiện "9.5 %/năm")', async ({ as }) => {
    const staff = await as('staff');
    const cta = await findCta(staff);
    const bank = await createBank(staff, cta, 'NH fix4 lãi');
    const today = vnToday();
    const loan = await createLoanApi(staff, cta, {
      partner_id: bank.id,
      amount: { amount_minor: '10000000', currency: 'VND' },
      disbursed_date: addDays(today, -10),
      maturity_date: addDays(today, 200),
      interest_rate: '9.5',
      contract_no: 'HDTD-FIX4-LS',
    });
    const code = (await getLoanApi(staff, cta, loan._id)).code as string;
    await staff.goto('/ngan-hang/khoan-vay');
    await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(code);
    const row = staff.locator('tr', { hasText: code });
    await expect(row, 'khoản vừa tạo có trong danh sách').toBeVisible({ timeout: 15_000 });
    await expect(row, 'lãi suất hiện dấu phẩy thập phân').toContainText('9,5 %/năm');
    await expect(row, 'không hiện dấu chấm').not.toContainText('9.5 %/năm');
  });
});

/**
 * E2E — khu Điều hành & Quản trị (v2/v2.md §4.2, §11, §12, §13; US-AUTO-05/07/08).
 *
 *   PW_AREA=exec npx playwright test e2e/v2-exec.spec.ts
 *
 * Yêu cầu: app đang chạy (web :5139, api :8024). Spec KHÔNG khởi động server.
 * Dữ liệu test dựng qua API (tên có hậu tố `uniq`); không xoá dữ liệu của người khác.
 */
import { randomUUID } from 'node:crypto';
import { test, expect, uniq, type Role } from './fixtures';
import { CRASH_TEXT, api, buildFixture, closeApiContexts, createBorrowReceipt, go, mark, pageText, pickOption, readOpenOptions, since, vnToday, watch } from './helpers-exec';

const ROLES: Role[] = ['staff', 'chief', 'director', 'chairman'];

/** Toàn bộ route tĩnh trong apps/web/src/routes.tsx (không tham số). */
/** 16 mẫu báo cáo dựng sẵn (apps/api/src/domain/reports/index.ts, RPT-01→13 + v2 theo đối tác / tag / sổ chi tiết). */
const REPORT_PRESETS = [
  'thu-chi-ngay',
  'thu-chi-thang',
  'so-du-ngan-hang',
  'cong-no-phai-thu',
  'cong-no-phai-tra',
  'vay-ngan-hang',
  'dao-han',
  'dong-tien',
  'chi-bo-phan',
  'chi-loai',
  'theo-cong-ty',
  'cho-duyet',
  'hs-ketoan',
  'theo-doi-tac',
  'theo-tag',
  'so-chi-tiet-doi-tac',
];

const STATIC_ROUTES = [
  '/dashboard',
  '/cho-toi-duyet',
  '/toi-da-duyet',
  '/can-bo-sung',
  '/can-xu-ly',
  '/chi',
  '/chi/cho-duyet',
  '/chi/da-thanh-toan',
  '/chi/moi',
  '/thu',
  '/thu/qua-han',
  '/thu/moi',
  '/ngan-hang/taikhoan',
  '/ngan-hang/taikhoan/moi',
  '/ngan-hang/khoan-vay',
  '/ngan-hang/khoan-vay/moi',
  '/ngan-hang/dao-han',
  '/ngan-hang/dao-han/chuan-bi',
  '/ngan-hang/dao-han/phuong-an/moi',
  '/ngan-hang/chuyen-noi-bo',
  '/ngan-hang/chuyen-noi-bo/moi',
  '/cong-no',
  '/cong-no/moi',
  '/cong-no/phai-thu',
  '/cong-no/phai-tra',
  '/cong-no/phai-thu/moi',
  '/cong-no/phai-tra/moi',
  '/doi-tac',
  '/dong-tien',
  '/dong-tien?view=forecast',
  '/baocao',
  ...REPORT_PRESETS.map((p) => `/baocao/${p}`),
  '/ban-tin/ngay',
  '/thong-bao',
  '/tim-kiem?q=exec',
  '/canh-bao',
  '/ca-nhan',
  '/quantri',
  '/quantri/nguoidung',
  '/quantri/cong-ty',
  '/quantri/quy-trinh-duyet',
  '/quantri/nguong-duyet',
  '/quantri/audit',
  '/quantri/sao-luu',
  '/quantri/tags',
  '/quantri/dinh-ky',
  '/quantri/tu-dong',
  '/quantri/tu-dong?tab=runs',
  '/quantri/tu-dong?tab=links',
  '/403',
  '/route-khong-ton-tai-exec',
];

/** Các chữ "khả dụng / bị phong toả" không được xuất hiện như cột hay ô nhập (v2 §4.2). */
const BLOCKED_OR_AVAILABLE = /khả dụng|bị phong|phong toả/i;

/** Chữ hiển thị khi KHÔNG có quyền xem một màn (không phải lỗi). */
const FORBIDDEN_TEXT = 'Bạn không có quyền xem mục này';

/* ======================================================================
 * 1. Tổng quan (DASH-01, §12)
 * ====================================================================== */

test.describe('§12 Tổng quan — dashboard theo vai trò', () => {
  for (const role of ROLES) {
    test(`Tổng quan ${role}: tải không lỗi và có đủ thẻ v2 (đối tác, khoản vay chờ giải ngân, lượt tự động lỗi)`, async ({ as }) => {
      test.setTimeout(180_000);
      const page = await as(role);
      const w = watch(page);
      await go(page, '/dashboard');

      await expect(page.getByText('Tổng quan dòng tiền', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
      for (const title of [
        'Cần xử lý ngay',
        'Thu – chi 30 ngày',
        'Dự báo 30 ngày',
        'Đáo hạn 30 ngày tới',
        'Dư nợ theo ngân hàng',
        'Phải thu theo đối tác',
        'Phải trả theo đối tác',
        'Khoản vay chờ giải ngân',
        'Quy trình tự động lỗi',
      ]) {
        await expect(page.getByText(title, { exact: false }).first(), `thẻ "${title}"`).toBeVisible({ timeout: 15_000 });
      }
      const txt = await pageText(page);
      expect(txt, 'không được hiện màn sập').not.toContain(CRASH_TEXT);
      expect(txt, 'không được báo thiếu quyền trên Tổng quan').not.toContain(FORBIDDEN_TEXT);
      expect(w.pageErrors, 'pageerror').toEqual([]);
      expect(w.serverErrors, '5xx của API').toEqual([]);
    });
  }

  test('Tổng quan: thẻ "Quy trình tự động lỗi" chỉ có lối vào "Lượt chạy" với người xem được màn tự động', async ({ as }) => {
    test.setTimeout(120_000);
    const chairman = await as('chairman');
    await go(chairman, '/dashboard');
    await expect(chairman.getByRole('link', { name: 'Lượt chạy' }).first()).toHaveAttribute('href', '/quantri/tu-dong?status=failed', { timeout: 20_000 });

    const staff = await as('staff');
    await go(staff, '/dashboard');
    await expect(staff.getByText('Quy trình tự động lỗi', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByRole('link', { name: 'Lượt chạy' })).toHaveCount(0);
  });

  test('Tổng quan: chủ tịch đổi phạm vi Toàn tập đoàn ↔ Cty A, dữ liệu tải lại theo công ty', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const page = await as('chairman');
    const w = watch(page);
    await go(page, '/dashboard');
    await expect(page.getByText('Toàn tập đoàn · Ngày nghiệp vụ', { exact: false }).first()).toBeVisible({ timeout: 20_000 });

    const scopeBtn = page.getByRole('button', { name: 'Phạm vi dữ liệu' });
    await scopeBtn.click();
    const reqP = page.waitForRequest((r) => r.url().includes('/api/v1/dashboard/overview') && r.headers()['x-company-scope'] === f.cta, { timeout: 20_000 });
    await page.getByRole('menuitem', { name: /CTA · Cty A/ }).click();
    await reqP;
    await expect(scopeBtn).toContainText('CTA', { timeout: 10_000 });
    await expect(page.getByText('Theo công ty · Ngày nghiệp vụ', { exact: false }).first()).toBeVisible({ timeout: 20_000 });

    await scopeBtn.click();
    await page.getByRole('menuitem', { name: 'Toàn tập đoàn', exact: true }).click();
    await expect(page.getByText('Toàn tập đoàn · Ngày nghiệp vụ', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('Tổng quan: tổng tiền hiện có khớp Σ số dư sổ cái các tài khoản (API, hai phạm vi)', async () => {
    test.setTimeout(120_000);
    const f = await buildFixture();
    const sum = (items: { balance: { minor: string }; status: string }[]) =>
      items.filter((a) => a.status === 'active').reduce((acc, a) => acc + BigInt(a.balance?.minor ?? '0'), 0n);

    // Người khác đang ghi sổ trên DB dùng chung: chỉ so sánh khi số dư tài khoản không đổi giữa hai lần đọc.
    let lastDetail = '';
    let ok = false;
    for (let attempt = 0; attempt < 6 && !ok; attempt++) {
      const read = async () => (await api<any>(f.chairman, 'GET', `/bank-accounts?company_id=${f.cta}`, { scope: f.cta })).items as any[];
      const before = sum((await read()).filter((a) => a.company_id === f.cta));
      const ov = await api<any>(f.chairman, 'GET', '/dashboard/overview', { scope: f.cta });
      const after = await read();
      const afterSum = sum(after.filter((a) => a.company_id === f.cta));
      const cashTotal = BigInt(ov.data.kpi.cash_total.amount.minor);
      lastDetail = `dashboard CTA=${cashTotal} · Σ TK CTA=${afterSum}`;
      if (before === afterSum) ok = cashTotal === afterSum;
      if (!ok) await new Promise((r) => setTimeout(r, 1_500));
    }
    expect(ok, `Tổng tiền hiện có phải bằng Σ số dư sổ cái tài khoản của công ty (${lastDetail})`).toBeTruthy();
  });
});

/* ======================================================================
 * 2. Dự báo dòng tiền (CASH-02, §12) — gồm giải ngân và lịch trả nợ vay
 * ====================================================================== */

test.describe('§12 Dự báo dòng tiền 7 / 30 / 60 / 90 ngày', () => {
  test('API: mỗi kỳ có đúng N ngày, số dư nối tiếp, thu/chi/cuối kỳ khớp cộng dồn', async () => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    for (const h of [7, 30, 60, 90]) {
      const r = (await api<any>(f.chief, 'GET', `/cashflow/forecast?horizon=${h}`, { scope: f.cta })).data;
      expect(r.days.length, `horizon ${h}: số ngày`).toBe(h);
      expect(r.from, `horizon ${h}: từ ngày`).toBe(vnToday());
      expect(r.to, `horizon ${h}: đến ngày`).toBe(vnToday(h - 1));

      let prev = BigInt(r.opening.minor);
      let minClosing = prev;
      let sumOut = 0n;
      let sumIn = 0n;
      let sumRepay = 0n;
      for (const d of r.days as any[]) {
        const open = BigInt(d.opening.minor);
        expect(open, `horizon ${h} ${d.date}: đầu ngày = cuối ngày hôm trước`).toBe(prev);
        const inflow = BigInt(d.operating_in.minor) + BigInt(d.disbursement_in.minor) + BigInt(d.internal_in.minor);
        const outflow = BigInt(d.operating_out.minor) + BigInt(d.internal_out.minor) + BigInt(d.loan_repayment_out.minor);
        expect(BigInt(d.inflow.minor), `horizon ${h} ${d.date}: thu`).toBe(inflow);
        expect(BigInt(d.outflow.minor), `horizon ${h} ${d.date}: chi (gồm trả nợ vay)`).toBe(outflow);
        expect(BigInt(d.closing.minor), `horizon ${h} ${d.date}: cuối ngày`).toBe(open + inflow - outflow);
        prev = BigInt(d.closing.minor);
        if (prev < minClosing) minClosing = prev;
        sumIn += inflow;
        sumOut += outflow;
        sumRepay += BigInt(d.loan_repayment_out.minor);
      }
      expect(BigInt(r.totals.end_closing.minor), `horizon ${h}: cuối kỳ`).toBe(prev);
      expect(BigInt(r.totals.inflow.minor), `horizon ${h}: tổng thu`).toBe(sumIn);
      expect(BigInt(r.totals.outflow.minor), `horizon ${h}: tổng chi`).toBe(sumOut);
      expect(BigInt(r.totals.loan_repayment_out.minor), `horizon ${h}: tổng trả nợ vay`).toBe(sumRepay);
      expect(BigInt(r.totals.min_closing.minor), `horizon ${h}: thấp nhất trong kỳ`).toBe(minClosing);
      expect(BigInt(r.totals.net.minor), `horizon ${h}: thuần`).toBe(sumIn - sumOut);

      // Lịch trả nợ vay và giải ngân: mọi kỳ trả phải nằm trong cửa sổ dự báo, tổng khớp dòng chi trả nợ.
      for (const p of r.repayments as any[]) {
        expect(p.due_date >= r.from && p.due_date <= r.to, `horizon ${h}: kỳ trả ${p.code} ${p.due_date} nằm ngoài kỳ`).toBeTruthy();
      }
      const repaySum = (r.repayments as any[]).reduce((a, p) => a + BigInt(p.total.minor), 0n);
      expect(repaySum, `horizon ${h}: Σ lịch trả nợ = Σ chi trả nợ theo ngày`).toBe(sumRepay);
      const undatedSum = (r.disbursements.undated as any[]).reduce((a, x) => a + BigInt(x.amount.minor), 0n);
      expect(BigInt(r.disbursements.undated_total.minor), `horizon ${h}: tổng chờ giải ngân chưa có ngày`).toBe(undatedSum);
    }
  });

  test('API: khoản vay chờ giải ngân do R2 (phiếu thu đi vay còn nháp, dự kiến trong kỳ) phải nằm trong "Giải ngân sắp tới"', async () => {
    test.setTimeout(120_000);
    const f = await buildFixture();
    expect(f.pendingLoan, 'khoản vay R2 đã sinh').not.toBeNull();
    const r = (await api<any>(f.chief, 'GET', '/cashflow/forecast?horizon=90', { scope: f.cta })).data;
    const undatedCodes = (r.disbursements.undated as { code: string }[]).map((x) => x.code);
    expect(undatedCodes, 'giải ngân sắp tới (chưa có ngày) phải gồm khoản vay chờ giải ngân của R2').toContain(f.pendingLoan!.code);
  });

  test('UI: nút 7 / 30 / 60 / 90 ngày đổi khoảng ngày và số dòng bảng', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const page = await as('director');
    const w = watch(page);
    await go(page, '/dong-tien?view=forecast');
    await expect(page.getByRole('button', { name: '30 ngày', exact: true })).toBeVisible({ timeout: 20_000 });

    for (const h of [7, 30, 60, 90] as const) {
      const btn = page.getByRole('button', { name: `${h} ngày`, exact: true });
      const isActive = async () => (await btn.getAttribute('class'))?.includes('ant-btn-primary') ?? false;
      if (!(await isActive())) {
        // nút đổi trạng thái sau khi có phản hồi của truy vấn mới — thử lại tối đa 2 lần nếu nhấp chưa ăn
        for (let attempt = 0; attempt < 3 && !(await isActive()); attempt++) {
          await Promise.all([
            page.waitForResponse((r) => r.url().includes('/api/v1/cashflow/forecast') && r.url().includes(`horizon=${h}`), { timeout: 15_000 }).catch(() => null),
            btn.click(),
          ]);
        }
      }
      await expect(btn, `nút ${h} ngày đang chọn`).toHaveClass(/ant-btn-primary/, { timeout: 15_000 });
      const to = vnToday(h - 1);
      const range = `${vnToday().slice(8, 10)}/${vnToday().slice(5, 7)}/${vnToday().slice(0, 4)} → ${to.slice(8, 10)}/${to.slice(5, 7)}/${to.slice(0, 4)}`;
      await expect(page.getByText(range, { exact: false }).first(), `khoảng ngày ${range}`).toBeVisible({ timeout: 15_000 });
      const rows = page.locator('.ant-table-tbody tr.ant-table-row');
      await expect(rows).toHaveCount(Math.min(h, 31), { timeout: 15_000 });
    }
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('UI: kỳ 60/90 ngày hiện lịch trả nợ vay của khoản vay đang trả góp; khoản chờ giải ngân nằm ở mục giải ngân', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const page = await as('director');
    const w = watch(page);
    await go(page, '/dong-tien?view=forecast');
    await page.getByRole('button', { name: '90 ngày', exact: true }).click();
    await expect(page.getByText('Lịch trả nợ vay', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`a[href="/ngan-hang/khoan-vay/${f.loan._id}/lich-tra"]`).first(), 'kỳ trả nợ của khoản vay mới').toBeVisible({ timeout: 20_000 });

    if (f.pendingLoan) {
      await expect(page.getByText('Giải ngân sắp tới', { exact: true }).first()).toBeVisible();
      await expect(page.locator(`a[href="/ngan-hang/khoan-vay/${f.pendingLoan._id}"]`).first(), 'khoản vay chờ giải ngân trong mục giải ngân').toBeVisible({ timeout: 20_000 });
    }
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });
});

/* ======================================================================
 * 3. Tài khoản tiền & số dư (§4.2)
 * ====================================================================== */

test.describe('§4.2 Tài khoản tiền & số dư', () => {
  test('danh sách tài khoản chỉ có số dư sổ cái và dự kiến; không có cột khả dụng / bị phong toả', async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as('chairman');
    const w = watch(page);
    await go(page, '/ngan-hang/taikhoan');
    await expect(page.getByText('Tài khoản tiền', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    const headers = (await page.locator('.ant-table-thead th').allInnerTexts()).map((t) => t.trim());
    for (const h of ['Số dư sổ cái', 'Dự kiến 30 ngày', 'Ngưỡng tối thiểu', 'Trạng thái']) {
      expect(headers, `cột "${h}"`).toContain(h);
    }
    for (const h of headers) expect(h, `cột "${h}" không được là khả dụng/bị phong toả`).not.toMatch(BLOCKED_OR_AVAILABLE);
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('API tài khoản: không trả trường số dư khả dụng / bị phong toả', async () => {
    const f = await buildFixture();
    const r = await api<any>(f.chief, 'GET', `/bank-accounts?company_id=${f.cta}`, { scope: f.cta });
    expect(r.items.length).toBeGreaterThan(0);
    for (const a of r.items as Record<string, unknown>[]) {
      for (const key of Object.keys(a)) {
        expect(key, `trường "${key}" của tài khoản`).not.toMatch(/blocked|available|khadung|phong/i);
      }
    }
  });

  test('form thêm tài khoản: chỉ có ngưỡng tối thiểu, không có ô tiền bị phong toả / khả dụng', async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as('chief');
    const w = watch(page);
    await go(page, '/ngan-hang/taikhoan/moi');
    await expect(page.getByText('Thêm tài khoản tiền', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    const labels = (await page.locator('form label, label').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    expect(labels).toContain('Ngưỡng tối thiểu');
    for (const l of labels) expect(l, `nhãn "${l}"`).not.toMatch(/khả dụng|bị phong|phong toả \(|hạn chế/i);
    const inputNames = await page.locator('input').evaluateAll((els) =>
      els.map((e) => `${e.getAttribute('aria-label') ?? ''}|${e.getAttribute('placeholder') ?? ''}|${e.getAttribute('name') ?? ''}`),
    );
    for (const n of inputNames) expect(n, `ô nhập "${n}"`).not.toMatch(/khả dụng|phong|blocked|available/i);
    expect(w.pageErrors).toEqual([]);
  });
});

/* ======================================================================
 * 4. Cảnh báo (§12)
 * ====================================================================== */

test.describe('§12 Cảnh báo', () => {
  test('danh sách cảnh báo: lọc trạng thái và lọc theo loại (có các loại v2)', async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as('chief');
    const w = watch(page);
    await go(page, '/canh-bao');
    await expect(page.getByText('Cảnh báo', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await page.getByText('Tất cả', { exact: true }).first().click();
    await page.waitForTimeout(300);
    await page.locator('.fg-filterbar .ant-select').first().click();
    const options = await readOpenOptions(page);
    expect(options, 'lọc loại: có mục "Tất cả loại cảnh báo"').toContain('Tất cả loại cảnh báo');
    expect(options, 'loại cảnh báo v2: quy trình tự động lỗi').toContain('Quy trình tự động lỗi');
    expect(options, 'loại cảnh báo v2: phiếu nguồn đã huỷ').toContain('Phiếu nguồn đã huỷ, đối tượng sinh đã phát sinh tiền');
    await page.keyboard.press('Escape');
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });
});

/* ======================================================================
 * 5. Báo cáo (§12) — theo đối tác, theo tag, sổ chi tiết đối tác, lọc, Excel
 * ====================================================================== */

test.describe('§12 Báo cáo', () => {
  test('thư viện báo cáo: đủ mẫu, có "Theo đối tác", "Theo tag", "Sổ chi tiết đối tác" (cần chọn đối tác)', async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as('chief');
    const w = watch(page);
    await go(page, '/baocao');
    await expect(page.getByText('Báo cáo', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    const cards = page.locator('a[href^="/baocao/"]');
    await expect(cards).toHaveCount(16, { timeout: 20_000 });
    const text = await pageText(page);
    for (const t of ['Theo đối tác', 'Theo tag', 'Sổ chi tiết đối tác', 'Công nợ phải thu', 'Đáo hạn']) expect(text, t).toContain(t);
    expect(text).toContain('cần chọn đối tác');
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('sổ chi tiết đối tác: chờ chọn đối tác → sổ có dòng khoản vay + dư luỹ kế → xuất Excel tải về', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const page = await as('director');
    const w = watch(page);
    await go(page, '/baocao/so-chi-tiet-doi-tac');
    await expect(page.getByText('Chọn đối tác để xem sổ chi tiết', { exact: true })).toBeVisible({ timeout: 20_000 });
    const exportBtn = page.getByRole('button', { name: /Xuất Excel/ });
    await expect(exportBtn).toBeDisabled();

    await pickOption(page, page.locator('.ant-select').filter({ hasText: 'Lọc theo đối tác' }).first(), f.bankPartner.name, f.bankPartner.name);
    await expect(page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: f.loan.code }).first(), 'dòng khoản vay trong sổ').toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Chọn đối tác để xem sổ chi tiết', { exact: true })).toHaveCount(0);

    const headers = (await page.locator('.ant-table-thead th').allInnerTexts()).map((t) => t.trim());
    expect(headers.join('|'), 'sổ có cột dư luỹ kế').toMatch(/dư|số dư|luỹ kế/i);

    await expect(exportBtn).toBeEnabled();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), exportBtn.click()]);
    expect(dl.suggestedFilename()).toBe('so-chi-tiet-doi-tac.xlsx');
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('theo đối tác và theo tag: mở được và xuất Excel tải về đúng bộ lọc', async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as('director');
    const w = watch(page);
    for (const preset of ['theo-doi-tac', 'theo-tag']) {
      await go(page, `/baocao/${preset}`);
      await expect(page.getByRole('button', { name: /Xuất Excel/ })).toBeEnabled({ timeout: 20_000 });
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.getByRole('button', { name: /Xuất Excel/ }).click()]);
      expect(dl.suggestedFilename(), preset).toBe(`${preset}.xlsx`);
    }
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('báo cáo có bộ lọc đối tác: yêu cầu gửi partner_id, thông báo "theo bộ lọc", "Xóa lọc" bỏ lọc', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const page = await as('director');
    const w = watch(page);
    const firstLoad = page.waitForResponse((r) => r.url().includes('/api/v1/reports/cong-no-phai-tra') && r.request().method() === 'GET', { timeout: 30_000 });
    await go(page, '/baocao/cong-no-phai-tra');
    await firstLoad;
    await expect(page.getByText('Công nợ phải trả', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    const reqP = page.waitForRequest((r) => r.url().includes('/api/v1/reports/cong-no-phai-tra') && r.url().includes(`partner_id=${f.bankPartner._id}`), { timeout: 20_000 });
    await pickOption(page, page.locator('.ant-select').filter({ hasText: 'Lọc theo đối tác' }).first(), f.bankPartner.name, f.bankPartner.name);
    await reqP;
    await expect(page.getByText('File Excel theo đúng bộ lọc đang chọn', { exact: false })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Xóa lọc', exact: true }).click();
    await expect(page.getByText('File Excel theo đúng bộ lọc đang chọn', { exact: false })).toHaveCount(0, { timeout: 15_000 });
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('báo cáo theo tag: tạo tag thử, chọn tag → gửi tag_ids và thông báo bộ lọc', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const tagName = uniq('exec tag');
    const created = await api<any>(f.director, 'POST', '/tags', { scope: f.cta, data: { company_id: f.cta, name: tagName, request_id: randomUUID() } });
    const tagId = String(created.data?._id ?? created.data?.id ?? created._id ?? '');
    expect(tagId, 'tạo tag thành công').not.toBe('');

    const page = await as('director');
    const w = watch(page);
    await go(page, '/baocao/theo-tag');
    const reqP = page.waitForRequest((r) => r.url().includes('/api/v1/reports/theo-tag') && r.url().includes(`tag_ids=${tagId}`), { timeout: 20_000 });
    await pickOption(page, page.locator('.ant-select').filter({ hasText: 'Lọc theo tag' }).first(), tagName, tagName);
    await reqP;
    await expect(page.getByText('File Excel theo đúng bộ lọc đang chọn', { exact: false })).toBeVisible({ timeout: 15_000 });
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });
});

/* ======================================================================
 * 6. Quy trình tự động (§11, §13; US-AUTO-05/07/08)
 * ====================================================================== */

test.describe('Tính toàn vẹn JSON của API dùng ở màn Điều hành', () => {
  test('danh sách hồ sơ: không có phần tử null trong mảng tags (thẻ dùng chung giữa nhiều hồ sơ)', async () => {
    test.setTimeout(120_000);
    const f = await buildFixture();
    const r = await api<any>(f.chief, 'GET', '/documents?kind=spend&limit=100', { scope: f.cta });
    const bad = (r.items as { code: string; tags?: unknown[] }[]).filter((it) => (it.tags ?? []).some((t) => t === null)).map((it) => it.code);
    expect(bad, 'hồ sơ có tags[] chứa null (đối tượng đã serialize bị thay bằng null)').toEqual([]);
  });

  test('chi tiết khoản vay: chain.funded_by và chain.disbursements là mảng (không null)', async () => {
    test.setTimeout(120_000);
    const f = await buildFixture();
    const d = (await api<any>(f.chief, 'GET', `/bank-debts/${f.pendingLoan!._id}`, { scope: f.cta })).data;
    expect(Array.isArray(d.funded_by_links), 'funded_by_links').toBeTruthy();
    expect(Array.isArray(d.chain?.funded_by), 'chain.funded_by phải là mảng (đang là null khi trùng tham chiếu)').toBeTruthy();
    expect(Array.isArray(d.chain?.disbursements), 'chain.disbursements phải là mảng').toBeTruthy();
  });
});

test.describe('Hồi quy: danh sách phiếu và chi tiết khoản vay không sập', () => {
  test('Phiếu chi & Chờ tôi duyệt: hai phiếu dùng chung một tag đều hiện tag, không sập (TagList / tags[] không được null)', async ({ as }) => {
    test.setTimeout(240_000);
    const f = await buildFixture();
    const tagName = uniq('exec tag chung');
    const tagRes = await api<any>(f.director, 'POST', '/tags', { scope: f.cta, data: { company_id: f.cta, name: tagName, request_id: randomUUID() } });
    const tagId = String(tagRes.data?._id ?? tagRes.data?.id ?? tagRes._id ?? '');
    expect(tagId, 'tạo tag dùng chung').not.toBe('');

    const supplierRes = await api<any>(f.chief, 'POST', '/partners', {
      scope: f.cta,
      data: { company_id: f.cta, type: 'supplier', name: uniq('exec NCC tag'), status: 'active', request_id: randomUUID() },
    });
    const supplierId = String(supplierRes.data?.partner?._id ?? supplierRes.data?._id ?? '');
    expect(supplierId, 'tạo nhà cung cấp').not.toBe('');

    // hai phiếu chi cùng gắn một tag (cùng object tag trong response) → KTV gửi duyệt để vào hàng chờ KTT
    const titles: string[] = [];
    for (let i = 0; i < 2; i++) {
      const title = uniq(`exec chi tag ${i + 1}`);
      titles.push(title);
      const created = await api<any>(f.staff, 'POST', '/documents', {
        scope: f.cta,
        data: {
          kind: 'spend',
          company_id: f.cta,
          title,
          purpose: `Kiểm thử tag dùng chung — ${title}`,
          partner_id: supplierId,
          amount: { amount_minor: '1000000', currency: 'VND' },
          source: { fund: 'bank', account_id: f.account._id, group_managed: false },
          planned_date: `${vnToday(7)}T10:00`,
          priority: 'normal',
          category_id: null,
          budget: { budget_id: null, line_id: null, in_plan: true },
          contract: {},
          tag_ids: [tagId],
          options: { loan: null },
          transfer_target: null,
          request_id: randomUUID(),
        },
      });
      const id = String(created.data?._id ?? created.data?.id ?? '');
      expect(id, 'tạo phiếu chi').not.toBe('');
      const cur = await api<any>(f.staff, 'GET', `/documents/${id}`, { scope: f.cta });
      const version = cur.data?.version ?? cur.data?.document?.version ?? 1;
      await api(f.staff, 'POST', `/documents/${id}/transition`, { scope: f.cta, data: { action: 'submit', if_match: version, request_id: randomUUID() } });
    }

    const page = await as('chief');
    const w = watch(page);
    await go(page, `/chi?tag_ids=${tagId}`);
    for (const t of titles) await expect(page.getByText(t, { exact: false }).first(), `phiếu chi "${t}" trong danh sách`).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(tagName, { exact: false }).first(), 'tag hiện trên hàng phiếu').toBeVisible({ timeout: 10_000 });
    expect(await pageText(page), 'danh sách phiếu chi không được sập').not.toContain(CRASH_TEXT);

    await go(page, `/cho-toi-duyet?tag_ids=${tagId}`);
    for (const t of titles) await expect(page.getByText(t, { exact: false }).first(), `"${t}" trong Chờ tôi duyệt`).toBeVisible({ timeout: 20_000 });
    expect(await pageText(page), 'Chờ tôi duyệt không được sập').not.toContain(CRASH_TEXT);
    expect(w.pageErrors, 'pageerror').toEqual([]);
    expect(w.serverErrors, '5xx của API').toEqual([]);
  });

  test('chi tiết khoản vay do R2 sinh ra có mục "Phiếu thu giải ngân" trỏ tới phiếu thu; khoản vay thường vẫn mở được', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    expect(f.pendingLoan, 'khoản vay R2 đã sinh').not.toBeNull();
    const page = await as('chief');
    const w = watch(page);
    await go(page, `/ngan-hang/khoan-vay/${f.pendingLoan!._id}`);
    await expect(page.getByText('Phiếu thu giải ngân', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(`a[href="/ho-so/thu/${f.borrowDoc._id}"]`).first(), 'phiếu thu đi vay nằm trong chuỗi khoản vay').toBeVisible({ timeout: 15_000 });
    expect(await pageText(page), 'chi tiết khoản vay R2 không được sập').not.toContain(CRASH_TEXT);

    await go(page, `/ngan-hang/khoan-vay/${f.loan._id}`);
    await expect(page.getByText('Phiếu chi được tài trợ', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    expect(await pageText(page), 'chi tiết khoản vay thường không được sập').not.toContain(CRASH_TEXT);
    expect(w.pageErrors, 'pageerror').toEqual([]);
    expect(w.serverErrors, '5xx của API').toEqual([]);
  });
});

test.describe('§11–13 Quy trình tự động', () => {
  test('chủ tịch: bảng quy tắc R1–R6; bật/tắt R1 cho Cty A rồi khôi phục', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const page = await as('chairman');
    const w = watch(page);
    await go(page, '/quantri/tu-dong');
    await expect(page.getByText('Quy trình tự động', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    const table = page.locator('.ant-table').first();
    for (const code of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) await expect(table, `quy tắc ${code}`).toContainText(code);

    await pickOption(page, page.locator('[aria-label="Công ty áp dụng quy tắc"]').first(), /CTA · Cty A/);
    await expect(page.getByText('Tại Cty A', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    const sw = page.getByRole('switch', { name: 'Bật R1 cho Cty A' });
    const before = await sw.getAttribute('aria-checked');
    const want = before === 'true' ? 'false' : 'true';
    try {
      await sw.click();
      await expect(sw, 'công tắc đổi trạng thái').toHaveAttribute('aria-checked', want, { timeout: 15_000 });
      const rules = await api<any>(f.chairman, 'GET', `/automation/rules?company_id=${f.cta}`, { scope: f.cta });
      const r1 = (rules.data as any[]).find((r) => r.code === 'R1');
      expect(r1.effective.enabled, 'API: hiệu lực R1 tại CTA').toBe(want === 'true');
    } finally {
      // khôi phục đúng trạng thái ban đầu
      if ((await sw.getAttribute('aria-checked')) !== before) {
        await sw.click();
        await expect(sw).toHaveAttribute('aria-checked', before ?? 'true', { timeout: 15_000 });
      }
    }
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('chủ tịch: sửa tham số R2 theo công ty (kỳ hạn 1–600 tháng), khôi phục 12 tháng', async ({ as }) => {
    test.setTimeout(180_000);
    const page = await as('chairman');
    const w = watch(page);
    await go(page, '/quantri/tu-dong');
    await pickOption(page, page.locator('[aria-label="Công ty áp dụng quy tắc"]').first(), /CTA · Cty A/);
    const r2Row = page.locator('.ant-table-row').filter({ hasText: 'Phiếu thu đi vay → khoản nợ ngân hàng' }).first();
    await expect(r2Row).toBeVisible({ timeout: 20_000 });

    const openParams = async () => {
      await r2Row.getByRole('button', { name: 'Sửa tham số' }).click();
      await expect(page.getByText('Tham số R2 · Cty A', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
      return page.locator('.ant-modal').filter({ hasText: 'Tham số R2' }).first();
    };

    // kiểm tra giới hạn phía client
    let modal = await openParams();
    await modal.locator('input[type="number"]').first().fill('0');
    await modal.getByRole('button', { name: 'Lưu cho công ty' }).click();
    await expect(modal.getByText('nhập số nguyên từ 1 đến 600', { exact: false })).toBeVisible({ timeout: 10_000 });
    await modal.getByRole('button', { name: 'Hủy' }).click();

    try {
      modal = await openParams();
      await modal.locator('input[type="number"]').first().fill('18');
      await modal.getByRole('button', { name: 'Lưu cho công ty' }).click();
      await expect(r2Row).toContainText('18 tháng vay', { timeout: 15_000 });
    } finally {
      modal = await openParams();
      await modal.locator('input[type="number"]').first().fill('12');
      await modal.getByRole('button', { name: 'Lưu cho công ty' }).click();
      await expect(r2Row).toContainText('12 tháng vay', { timeout: 15_000 });
    }
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('chủ tịch: bật rồi tắt công tắc toàn hệ thống của R4 (khôi phục trạng thái tắt)', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const page = await as('chairman');
    const w = watch(page);
    await go(page, '/quantri/tu-dong');
    await expect(page.locator('.ant-table-row').filter({ hasText: 'Khoản vay tất toán' }).first()).toBeVisible({ timeout: 20_000 });
    const row = page.locator('.ant-table-row').filter({ hasText: 'Khoản vay tất toán' }).first();
    const initiallyEnabled = (await api<any>(f.chairman, 'GET', '/automation/rules')).data.find((r: any) => r.code === 'R4').enabled as boolean;
    try {
      await row.getByRole('button', { name: initiallyEnabled ? 'Tắt toàn hệ thống' : 'Bật toàn hệ thống' }).click();
      await page.locator('.ant-modal-footer').getByRole('button', { name: initiallyEnabled ? 'Tắt' : 'Bật', exact: true }).click();
      await expect(page.getByText(`Đã ${initiallyEnabled ? 'tắt' : 'bật'} R4 toàn hệ thống`, { exact: false }).first()).toBeVisible({ timeout: 15_000 });
      const after = (await api<any>(f.chairman, 'GET', '/automation/rules')).data.find((r: any) => r.code === 'R4').enabled as boolean;
      expect(after, 'API: R4 đã đổi công tắc tổng').toBe(!initiallyEnabled);
    } finally {
      // khôi phục công tắc tổng về trạng thái ban đầu (qua API nếu UI chưa kịp; phạm vi toàn tập đoàn)
      const rules = (await api<any>(f.chairman, 'GET', '/automation/rules')).data as any[];
      const r4 = rules.find((r) => r.code === 'R4');
      if (r4.enabled !== initiallyEnabled) {
        await api(f.chairman, 'PATCH', `/automation/rules/${r4._id}`, { data: { enabled: initiallyEnabled, if_updated_at: r4.updated_at } });
      }
    }
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('API lượt chạy R2: đầu ra của bước link và generated[] trả đủ khoản vay sinh ra (không null)', async () => {
    test.setTimeout(120_000);
    const f = await buildFixture();
    expect(f.pendingLoan, 'khoản vay R2 đã sinh').not.toBeNull();
    const runs = await api<any>(f.chief, 'GET', `/automation/runs/by-source?source_type=document&source_id=${f.borrowDoc._id}`, { scope: f.cta });
    const run = (runs.data as any[]).find((r) => r.rule_code === 'R2');
    expect(run, 'lượt R2 của phiếu').toBeTruthy();
    const link = (run.steps as any[]).find((s) => s.name === 'link');
    expect(link?.status, 'bước liên kết đã chạy').toBe('done');
    expect(link?.output?.id, 'bước liên kết trả khoản vay (đầu ra không được null)').toBe(f.pendingLoan!._id);
    expect(run.generated as unknown[], 'generated[] không được chứa phần tử null').not.toContain(null);
    expect((run.generated as any[]).map((g) => g?.id), 'generated[] có khoản vay sinh ra').toContain(f.pendingLoan!._id);
  });

  test('R2 chạy cho phiếu thu đi vay: tab Lượt chạy có lượt hoàn tất, chi tiết các bước và khoản vay sinh ra', async ({ as }) => {
    test.setTimeout(240_000);
    const f = await buildFixture();
    // phiếu thu đi vay MỚI cho đúng lượt này: API lượt chạy chỉ trả 100 lượt gần nhất nên phiếu dựng sẵn có thể đã bị đẩy ra ngoài
    const fresh = await createBorrowReceipt(f, 'exec phiếu thu vay lượt');
    expect(fresh.run, 'lượt R2 đã chạy xong cho phiếu thu đi vay').not.toBeNull();
    expect(fresh.run!.status, `trạng thái lượt R2 (lỗi: ${fresh.run!.error ?? '—'})`).toBe('done');
    expect(fresh.loan, 'khoản vay chờ giải ngân do R2 sinh ra').not.toBeNull();

    const loan = (await api<any>(f.chief, 'GET', `/bank-debts/${fresh.loan!.id}`, { scope: f.cta })).data;
    expect(loan.status, 'khoản vay R2 đang chờ giải ngân').toBe('pending_disbursement');
    expect(loan.origin?.kind, 'nguồn gốc: tự động').toBe('automation');

    const page = await as('chief');
    const w = watch(page);
    await go(page, '/quantri/tu-dong?tab=runs');
    await expect(page.getByText('Lượt chạy', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    // bộ lọc "Quy tắc" là ô thứ hai trong thanh lọc của tab Lượt chạy
    await pickOption(page, page.locator('.fg-filterbar .ant-select').nth(1), /^R2 ·/);
    const sourceTag = `…${fresh.id.slice(-6)}`;
    const row = page.locator('.ant-table-row').filter({ hasText: sourceTag }).first();
    await expect(row, 'dòng lượt R2 của phiếu thu vừa tạo').toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('Hoàn tất');
    await row.getByRole('button', { name: 'Chi tiết', exact: true }).click();

    const drawer = page.locator('.ant-drawer').filter({ hasText: 'R2 · ' }).first();
    await expect(drawer.or(page.getByText(CRASH_TEXT))).toBeVisible({ timeout: 15_000 });
    expect(await pageText(page), 'mở chi tiết lượt không được làm sập màn hình').not.toContain(CRASH_TEXT);
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByText('Đối tượng đã sinh', { exact: true })).toBeVisible();
    await expect(drawer, 'khoản vay sinh ra').toContainText(fresh.loan!.code);
    for (const step of ['Tạo khoản vay', 'Liên kết']) await expect(drawer, `bước "${step}"`).toContainText(step);
    await drawer.getByRole('link', { name: 'Mở', exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`/ngan-hang/khoan-vay/${fresh.loan!.id}`), { timeout: 20_000 });
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('phiếu thu đi vay hiện "Quy trình tự động: R2" và khoản vay sinh ra trên hồ sơ phiếu', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const page = await as('chief');
    const w = watch(page);
    await go(page, `/ho-so/thu/${f.borrowDoc._id}`);
    await expect(page.getByText(f.borrowDoc.code, { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    // Panel "Quy trình tự động" tải riêng (by-source): chờ panel hoặc màn sập rồi mới kết luận.
    await expect(page.getByText('Quy trình tự động', { exact: false }).or(page.getByText(CRASH_TEXT)).first()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_000);
    expect(await pageText(page), 'hồ sơ phiếu thu đi vay không được sập khi có lượt tự động').not.toContain(CRASH_TEXT);
    await expect(page.getByText('Quy trình tự động: R2', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    if (f.pendingLoan) await expect(page.getByText(f.pendingLoan.code, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('dashboard: khoản vay vừa sinh ra hiện trong "Khoản vay chờ giải ngân" và đếm đúng', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    expect(f.pendingLoan).not.toBeNull();
    // Tổng quan có cache phần bổ sung 20 giây (reports/dashboard.ts): chờ tối đa 30 giây để khoản vay mới hiện.
    const deadline = Date.now() + 30_000;
    let ids: string[] = [];
    let count = 0;
    while (Date.now() < deadline) {
      const ov = await api<any>(f.director, 'GET', '/dashboard/overview', { scope: f.cta });
      ids = ((ov.data.loans_pending?.items ?? []) as { id: string }[]).map((i) => i.id);
      count = Number(ov.data.loans_pending?.count ?? 0);
      if (ids.includes(f.pendingLoan!._id)) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    expect(ids, 'API Tổng quan: khoản vay chờ giải ngân vừa sinh ra (trong 30 giây)').toContain(f.pendingLoan!._id);
    expect(count, 'Tổng quan báo số khoản chờ giải ngân (đếm đầy đủ, không chỉ 10 dòng)').toBeGreaterThanOrEqual(ids.length);

    const page = await as('director');
    const w = watch(page);
    await go(page, '/dashboard');
    await expect(page.getByText('Khoản vay chờ giải ngân', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    const card = page.locator('.fg-card, .ant-card').filter({ hasText: 'Khoản vay chờ giải ngân' }).first();
    await expect(card).toContainText('Gốc chờ về', { timeout: 15_000 });
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('phiếu thu đi vay với bên nộp KHÔNG phải ngân hàng bị từ chối (đối tác phải là Ngân hàng)', async () => {
    test.setTimeout(120_000);
    const f = await buildFixture();
    if (!f.customerPartner) test.skip(true, 'CTA chưa có đối tác khách hàng đang hoạt động');
    const res = await f.chief.fetch('/api/v1/documents', {
      method: 'POST',
      headers: { 'x-company-scope': f.cta },
      data: {
        kind: 'income',
        company_id: f.cta,
        title: uniq('exec sai đối tác vay'),
        purpose: 'Kiểm tra quy tắc đối tác đi vay',
        amount: { amount_minor: '1000000', currency: 'VND' },
        source: { fund: 'bank', account_id: f.account._id, group_managed: false },
        planned_date: `${vnToday(5)}T10:00`,
        partner_id: f.customerPartner!._id,
        priority: 'normal',
        options: { loan: { kind: 'borrow', mode: 'new', lender_partner_id: f.bankPartner._id, amount_minor: '1000000', terms: { term_months: 12 } } },
        request_id: randomUUID(),
      },
    });
    const body = await res.text();
    expect(res.status(), `phiếu thu đi vay với KH phải bị từ chối: ${body.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
    expect(body).toContain('Ngân hàng');
  });

  test('tab Loại liên kết: 6 quan hệ, mô tả đầy đủ, chỉ đọc', async ({ as }) => {
    test.setTimeout(120_000);
    const page = await as('chairman');
    const w = watch(page);
    await go(page, '/quantri/tu-dong?tab=links');
    await expect(page.getByText('Loại liên kết nghiệp vụ', { exact: true })).toBeVisible({ timeout: 20_000 });
    const rows = page.locator('.ant-table-tbody tr.ant-table-row');
    await expect(rows).toHaveCount(6);
    for (const label of ['Cấn trừ công nợ', 'Trả nợ vay', 'Giải ngân', 'Chi bằng vốn vay', 'Tự động sinh', 'Chuyển tiền nội bộ']) {
      await expect(page.locator('.ant-table-tbody').getByText(label, { exact: true }).first(), label).toBeVisible();
    }
    for (const code of ['offset', 'repayment', 'disbursement', 'funded_by', 'generated', 'internal_transfer']) {
      await expect(page.locator('.ant-table-tbody').getByText(code, { exact: true }).first(), code).toBeVisible();
    }
    const card = page.locator('.fg-card, .ant-card').filter({ hasText: 'Loại liên kết nghiệp vụ' }).first();
    await expect(card.getByRole('button', { name: /Thêm|Sửa|Xoá|Lưu/ })).toHaveCount(0);
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });

  test('phân quyền: KTT và Giám đốc chỉ xem (công tắc bị khoá); KTV bị chuyển khỏi màn tự động', async ({ as }) => {
    test.setTimeout(180_000);
    for (const role of ['chief', 'director'] as Role[]) {
      const page = await as(role);
      const w = watch(page);
      await go(page, '/quantri/tu-dong');
      await expect(page.getByText('Chỉ xem — cần quyền cấu hình quy trình tự động để sửa.', { exact: false }), `${role}: thông báo chỉ xem`).toBeVisible({ timeout: 20_000 });
      const switches = page.getByRole('switch');
      // bảng quy tắc tải riêng sau banner: chờ công tắc đầu tiên xuất hiện rồi mới đếm
      await expect(switches.first(), `${role}: chờ bảng quy tắc có công tắc`).toBeVisible({ timeout: 20_000 });
      expect(await switches.count(), `${role}: có công tắc`).toBeGreaterThan(0);
      for (let i = 0; i < (await switches.count()); i++) await expect(switches.nth(i), `${role}: công tắc ${i} bị khoá`).toBeDisabled();
      expect(w.pageErrors).toEqual([]);
    }
    const staff = await as('staff');
    await go(staff, '/quantri/tu-dong');
    await expect(staff).toHaveURL(/\/dashboard/, { timeout: 20_000 });
  });
});

/* ======================================================================
 * 7. Khoản chi định kỳ — chọn bên nhận bằng ô chọn đối tác (CHI-08/09, R5)
 * ====================================================================== */

test.describe('§13 Khoản chi định kỳ', () => {
  test('KTV tạo khoản chi định kỳ: bắt buộc chọn bên nhận từ danh bạ; lưu được với đối tác đã chọn', async ({ as }) => {
    test.setTimeout(180_000);
    const f = await buildFixture();
    const page = await as('staff');
    const w = watch(page);
    await go(page, '/quantri/dinh-ky');
    await expect(page.getByText('Khoản chi định kỳ', { exact: true }).first()).toBeVisible({ timeout: 20_000 });

    await page.getByRole('button', { name: '+ Thêm khoản định kỳ' }).click();
    const modal = page.locator('.ant-modal').filter({ hasText: 'Khoản chi định kỳ mới' }).first();
    await expect(modal).toBeVisible({ timeout: 10_000 });
    await modal.getByPlaceholder('Thuê văn phòng quận 1').fill('');
    await page.locator('.ant-modal-footer').getByRole('button', { name: 'Tạo khoản định kỳ' }).click();
    await expect(modal.getByText('Chọn bên nhận từ danh bạ đối tác', { exact: false })).toBeVisible({ timeout: 10_000 });

    const title = uniq('exec định kỳ');
    await modal.getByPlaceholder('Thuê văn phòng quận 1').fill(title);
    await modal.getByPlaceholder('Tiền thuê mặt bằng tháng').fill('Thanh toán định kỳ kiểm thử');
    await pickOption(page, modal.locator('.ant-select').filter({ hasText: 'Tìm theo tên, số tài khoản, MST' }).first(), f.bankPartner.name, f.bankPartner.name);
    await modal.getByLabel('Số tiền mỗi kỳ').fill('1000000');

    const createRes = page.waitForResponse((r) => r.url().includes('/api/v1/admin/recurring') && r.request().method() === 'POST', { timeout: 20_000 });
    await page.locator('.ant-modal-footer').getByRole('button', { name: 'Tạo khoản định kỳ' }).click();
    const res = await createRes;
    expect(res.status(), 'tạo khoản định kỳ thành công').toBeLessThan(300);
    await expect(page.getByText('Đã tạo khoản chi định kỳ', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.ant-table-row').filter({ hasText: title }).first()).toBeVisible({ timeout: 20_000 });

    const list = await api<any>(f.staff, 'GET', '/admin/recurring', { scope: f.cta });
    const row = (list.items as any[]).find((r) => r.title === title);
    expect(row, 'API: khoản định kỳ đã lưu').toBeTruthy();
    expect(row.partner_id, 'khoản định kỳ lưu đúng đối tác đã chọn').toBe(f.bankPartner._id);
    expect(row.partner_name, 'tên bên nhận lấy qua đối tác').toBe(f.bankPartner.name);

    // Kỳ kế tiếp: ngày phát sinh 1 hàng tháng kể từ hôm nay ⇒ mùng 1 của tháng sau (hoặc hôm nay nếu hôm nay là mùng 1).
    const today = vnToday();
    const expectedNext = today.endsWith('-01') ? today : `${Number(today.slice(0, 4)) + (Number(today.slice(5, 7)) === 12 ? 1 : 0)}-${String((Number(today.slice(5, 7)) % 12) + 1).padStart(2, '0')}-01`;
    expect(row.next_date, 'API: kỳ kế tiếp của khoản chi hằng tháng ngày 1 (cách hơn 9 ngày vẫn phải có)').toBe(expectedNext);
    const daysExpected = Math.ceil((Date.parse(`${expectedNext}T00:00:00Z`) - Date.now()) / 86_400_000);
    expect(row.days_until, 'API: số ngày tới kỳ kế tiếp (không được là 999 = "không có kỳ")').toBe(daysExpected);
    const ddmmyyyy = `${expectedNext.slice(8, 10)}/${expectedNext.slice(5, 7)}/${expectedNext.slice(0, 4)}`;
    await expect(page.locator('.ant-table-row').filter({ hasText: title }).first(), `màn hình hiện kỳ kế tiếp ${ddmmyyyy}`).toContainText(ddmmyyyy, { timeout: 10_000 });
    expect(w.pageErrors).toEqual([]);
    expect(w.serverErrors).toEqual([]);
  });
});

/* ======================================================================
 * 8. Điều hướng theo vai trò — mọi mục menu và mọi route tĩnh không lỗi
 * ====================================================================== */

test.describe('Điều hướng — crawl theo vai trò', () => {
  for (const role of ROLES) {
    test(`${role}: mọi mục menu trên thanh điều hướng mở không pageerror / 5xx`, async ({ as }) => {
      test.setTimeout(600_000);
      const page = await as(role);
      const w = watch(page);
      await go(page, '/dashboard');
      await expect(page.locator('nav.fg-rail-nav a').first()).toBeVisible({ timeout: 20_000 });
      const items = await page.locator('nav.fg-rail-nav a').evaluateAll((els) =>
        els.map((a) => ({ href: a.getAttribute('href') ?? '', label: (a as HTMLElement).innerText.replace(/\n/g, ' ').trim() })),
      );
      expect(items.length, 'số mục menu').toBeGreaterThan(5);
      const problems: string[] = [];
      for (const item of items) {
        const m = mark(w);
        await go(page, item.href);
        const txt = await pageText(page);
        if (txt.includes(CRASH_TEXT)) problems.push(`${item.label} (${item.href}): màn sập`);
        const e = since(w, m);
        for (const pe of e.pageErrors) problems.push(`${item.label} (${item.href}): pageerror ${pe}`);
        for (const se of e.serverErrors) problems.push(`${item.label} (${item.href}): ${se}`);
      }
      expect(problems, `lỗi khi mở menu của ${role}`).toEqual([]);
    });

    test(`${role}: mọi route tĩnh trong routes.tsx không pageerror / 5xx / màn sập`, async ({ as }) => {
      test.setTimeout(900_000);
      const page = await as(role);
      const w = watch(page);
      const problems: string[] = [];
      for (const path of STATIC_ROUTES) {
        const m = mark(w);
        await go(page, path);
        const txt = await pageText(page);
        if (txt.includes(CRASH_TEXT)) problems.push(`${path}: màn sập`);
        const e = since(w, m);
        for (const pe of e.pageErrors) problems.push(`${path}: pageerror ${pe}`);
        for (const se of e.serverErrors) problems.push(`${path}: ${se}`);
      }
      expect(problems, `lỗi route của ${role}`).toEqual([]);
    });
  }

  for (const role of ROLES) {
    test(`${role}: route chi tiết có tham số (đối tác, khoản vay R2 & thường, tài khoản, hồ sơ, báo cáo) không lỗi`, async ({ as }) => {
      test.setTimeout(420_000);
      const f = await buildFixture();
      const page = await as(role);
      const w = watch(page);
      const routes = [
        `/doi-tac/${f.bankPartner._id}`,
        `/ngan-hang/khoan-vay/${f.loan._id}`,
        `/ngan-hang/khoan-vay/${f.loan._id}/lich-tra`,
        `/ngan-hang/khoan-vay/${f.loan._id}/sua`,
        ...(f.pendingLoan
          ? [`/ngan-hang/khoan-vay/${f.pendingLoan._id}`, `/ngan-hang/khoan-vay/${f.pendingLoan._id}/lich-tra`, `/ngan-hang/khoan-vay/${f.pendingLoan._id}/sua`]
          : []),
        `/ngan-hang/taikhoan/${f.account._id}`,
        `/ngan-hang/taikhoan/${f.account._id}/sua`,
        `/ho-so/thu/${f.borrowDoc._id}`,
        `/thu/${f.borrowDoc._id}/sua`,
        `/baocao/so-du-ngan-hang`,
        `/baocao/dao-han`,
        `/baocao/dong-tien`,
        `/baocao/theo-doi-tac`,
        `/baocao/theo-tag`,
      ];
      const problems: string[] = [];
      for (const path of routes) {
        const m = mark(w);
        await go(page, path);
        const txt = await pageText(page);
        if (txt.includes(CRASH_TEXT)) problems.push(`${path}: màn sập`);
        const e = since(w, m);
        for (const pe of e.pageErrors) problems.push(`${path}: pageerror ${pe}`);
        for (const se of e.serverErrors) problems.push(`${path}: ${se}`);
      }
      expect(problems, `lỗi route tham số của ${role}`).toEqual([]);
    });
  }
});

test.afterAll(async () => {
  await closeApiContexts();
});

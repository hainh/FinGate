/**
 * Fix — dashboard · lọc / nhóm theo tag (v2/v2.md §6.2: "dashboard lọc / nhóm theo tag"; §12).
 *
 *   PW_AREA=fix1 npx playwright test e2e/fix1-dashboard-tags.spec.ts
 *
 * Dữ liệu dùng uniq() (không phụ thuộc số liệu toàn cục). Phạm vi đặt qua useCompanyScope / useAllScope
 * và được khôi phục trong finally. API chỉ dùng để chuẩn bị và kiểm tra.
 */
import type { Page } from '@playwright/test';
import { test, expect, uniq } from './fixtures';
import {
  COMPANY,
  api,
  companyIdOf,
  createPartnerApi,
  dataOf,
  ensureTagApi,
  expectNoAppCrash,
  firstBankAccountApi,
  openPage,
  pickExistingTag,
  tagCombo,
  transitionApi,
  useAllScope,
  useCompanyScope,
  watchPage,
} from './helpers-tags';

/** Ngày nghiệp vụ hôm nay theo giờ Việt Nam (UTC+7) — khớp `today()` của server. */
const vnToday = (): string => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

/** Phần của `GET /dashboard/overview` mà spec này kiểm tra. */
interface OverviewCheck {
  kpi: { spend_today: { amount: { minor: string } }; income_today: { amount: { minor: string } } };
  counts: { awaiting_me: number };
  awaiting_me_rows: { document_id: string }[];
}

/** Thẻ (antd Card) có tiêu đề đúng `title` trên dashboard (FgCard → `.fg-card-title`). */
function dashboardCard(page: Page, title: string) {
  return page.locator('.ant-card').filter({ has: page.locator('.fg-card-title', { hasText: new RegExp(`^${title}$`) }) });
}

/** Phiếu chi có ngày dự kiến HÔM NAY (createVoucherApi chỉ đặt ngày mai). Trả về ID phiếu. */
async function createSpendToday(
  page: Page,
  scope: string,
  spec: { partnerId: string; accountId: string; title: string; amountMinor: string; tagIds: string[] },
): Promise<string> {
  const r = await api(page, 'POST', '/documents', {
    scope,
    data: {
      kind: 'spend',
      company_id: scope,
      title: spec.title,
      purpose: `Kiểm thử lọc dashboard theo tag — ${spec.title}`,
      partner_id: spec.partnerId,
      amount: { amount_minor: spec.amountMinor, currency: 'VND' },
      source: { fund: 'bank', account_id: spec.accountId, group_managed: false },
      planned_date: `${vnToday()}T10:00`,
      priority: 'normal',
      tag_ids: spec.tagIds,
    },
  });
  expect(r.status, `POST /documents ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(300);
  const body = dataOf<{ document?: { _id?: string; id?: string }; _id?: string; id?: string }>(r);
  const doc = body.document ?? body;
  const id = String(doc._id ?? doc.id);
  expect(id, 'phản hồi tạo phiếu thiếu _id').toMatch(/^[0-9a-f]{24}$/);
  return id;
}

test.describe('dashboard · lọc / nhóm theo tag (§6.2)', () => {
  test('KTV: dashboard có ô lọc theo tag và thẻ "Theo tag"', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    try {
      const watch = watchPage(staff, 'dashboard');
      await openPage(staff, '/dashboard');
      await expect(tagCombo(staff, 'Lọc theo tag')).toBeVisible({ timeout: 15_000 });
      await expect(dashboardCard(staff, 'Theo tag')).toBeVisible({ timeout: 15_000 });
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('lọc theo tag: số liệu theo phiếu chỉ tính phiếu có tag; thẻ "Theo tag" và ô lọc khớp nhau', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Lọc dashboard');
      const tagId = await ensureTagApi(staff, cta, tagName);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC lọc dashboard'));
      const accountId = await firstBankAccountApi(staff, cta);
      const amountMinor = '98765432';
      const docId = await createSpendToday(staff, cta, {
        partnerId,
        accountId,
        title: uniq('Phiếu lọc dashboard'),
        amountMinor,
        tagIds: [tagId],
      });
      const submit = await transitionApi(staff, cta, docId, 'submit');
      expect(submit.status, `submit ${submit.status} ${JSON.stringify(submit.body)}`).toBeLessThan(300);

      // API: tag_ids lọc số liệu theo phiếu (chi hôm nay, chờ tôi duyệt); phiếu không có tag không lọt vào
      const filteredRes = await api(chief, 'GET', '/dashboard/overview', { scope: cta, query: { tag_ids: tagId } });
      expect(filteredRes.status).toBe(200);
      const filtered = dataOf<OverviewCheck>(filteredRes);
      // tag này chỉ gắn đúng một phiếu (uniq) → số liệu đã lọc phải đúng bằng phiếu đó
      expect(filtered.kpi.spend_today.amount.minor).toBe(amountMinor);
      expect(filtered.kpi.income_today.amount.minor).toBe('0');
      expect(filtered.counts.awaiting_me).toBe(1);
      expect(filtered.awaiting_me_rows.map((row) => row.document_id)).toEqual([docId]);

      // không lọc: toàn công ty ≥ số liệu đã lọc
      const all = dataOf<OverviewCheck>(await api(chief, 'GET', '/dashboard/overview', { scope: cta }));
      expect(Number(all.kpi.spend_today.amount.minor)).toBeGreaterThanOrEqual(Number(amountMinor));
      expect(all.counts.awaiting_me).toBeGreaterThanOrEqual(filtered.counts.awaiting_me);

      // UI: mở bằng liên kết có ?tag_ids → thanh thông báo lọc và thẻ "Theo tag" chỉ có tag đã chọn
      const watch = watchPage(staff, 'dashboard-tag-filter');
      await openPage(staff, `/dashboard?tag_ids=${tagId}`);
      await expect(staff.getByText('Số liệu theo phiếu đang lọc theo tag')).toBeVisible({ timeout: 15_000 });
      const card = dashboardCard(staff, 'Theo tag');
      await expect(card.getByText(tagName, { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(card.getByText('1 phiếu', { exact: true })).toBeVisible();
      expectNoAppCrash(watch);

      // UI: "Bỏ lọc tag" → URL không còn tag_ids; chờ React vẽ lại (thanh lọc biến mất) trước khi chọn lại,
      // nếu không cú bấm chọn có thể trúng cái chip cũ đang còn trên màn hình và bỏ chọn nó.
      await staff.getByRole('button', { name: 'Bỏ lọc tag' }).click();
      await expect(staff).not.toHaveURL(/tag_ids=/);
      await expect(staff.getByText('Số liệu theo phiếu đang lọc theo tag')).toHaveCount(0);

      // UI: chọn tag ở ô lọc → URL có tag_ids và thanh thông báo lọc hiện
      await pickExistingTag(staff, tagCombo(staff, 'Lọc theo tag'), tagName, tagName);
      await expect(staff).toHaveURL(new RegExp(`tag_ids=${tagId}`));
      await expect(staff.getByText('Số liệu theo phiếu đang lọc theo tag')).toBeVisible();
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('URL có tag_ids sai định dạng: dashboard vẫn chạy và ô lọc vẫn dùng được để bỏ lọc', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    try {
      const watch = watchPage(staff, 'dashboard-bad-tag');
      await openPage(staff, '/dashboard?tag_ids=khong-hop-le,abc');
      await expect(staff.getByText('Tổng quan dòng tiền', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(tagCombo(staff, 'Lọc theo tag')).toBeVisible();
      await expect(staff.getByRole('button', { name: 'Bỏ lọc tag' })).toHaveCount(0);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('URL có tag_id viết hoa (hợp lệ) vẫn áp dụng bộ lọc, không làm hỏng dashboard', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagId = await ensureTagApi(staff, cta, uniq('Lọc hoa'));
      const watch = watchPage(staff, 'dashboard-upper-tag');
      await openPage(staff, `/dashboard?tag_ids=${tagId.toUpperCase()}`);
      await expect(staff.getByText('Số liệu theo phiếu đang lọc theo tag')).toBeVisible({ timeout: 15_000 });
      await expect(staff.getByRole('button', { name: 'Bỏ lọc tag' })).toBeVisible();
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('"Toàn tập đoàn": ô lọc tag bị khoá nhưng thẻ "Theo tag" vẫn hiện (gộp theo tên tag)', async ({ as }) => {
    const chairman = await as('chairman');
    const restore = await useAllScope(chairman);
    try {
      const watch = watchPage(chairman, 'dashboard-all');
      await openPage(chairman, '/dashboard');
      await expect(chairman.getByText('Chọn một công ty để lọc theo tag', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(dashboardCard(chairman, 'Theo tag')).toBeVisible({ timeout: 15_000 });
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('API: tag_ids sai định dạng bị từ chối (422 FG-VAL-001), không trả số liệu không lọc', async ({ as }) => {
    const staff = await as('staff');
    const cta = await companyIdOf(staff, COMPANY.CTA);
    const r = await api(staff, 'GET', '/dashboard/overview', { scope: cta, query: { tag_ids: 'khong-hop-le' } });
    // FG-VAL-001 = 422 trong toàn hệ thống (xem v2-loans.spec.ts)
    expect(r.status, `GET /dashboard/overview?tag_ids=… ${r.status} ${JSON.stringify(r.body)}`).toBe(422);
    expect(r.body?.code).toBe('FG-VAL-001');
  });
});

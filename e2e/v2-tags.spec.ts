/**
 * v2 — Tag (v2/v2.md §6.2; US-VOU-02, US-VOU-03, US-VOU-04; §12 báo cáo/tìm kiếm; §3.2 quyền tag:create / tag:manage).
 *
 *   PW_AREA=tags npx playwright test e2e/v2-tags.spec.ts
 *
 * Dữ liệu test dùng uniq() — không phụ thuộc số liệu toàn cục. Phạm vi công ty đặt bằng
 * useCompanyScope/useAllScope và được khôi phục sau mỗi test.
 */
import { test, expect, uniq as uniqRaw } from './fixtures';
import {
  COMPANY,
  api,
  companyIdOf,
  createPartnerApi,
  createTagApi,
  createVoucherApi,
  dataOf,
  ensureTagApi,
  expectNoAppCrash,
  firstBankAccountApi,
  getDocApi,
  listTagsApi,
  openPage,
  pickExistingTag,
  reportApi,
  saveTagsButton,
  setDocTagsApi,
  tableRow,
  tagByName,
  tagCombo,
  toast,
  transitionApi,
  useAllScope,
  useCompanyScope,
  visibleOption,
  watchPage,
  approveFullyApi,
  sameNameKey,
  settle,
  tagsNamed,
} from './helpers-tags';

const VOUCHER_TAG_LABEL = 'Tag';
const DETAIL_TAG_LABEL = 'Tag của phiếu';

/**
 * Tên tag tối đa 40 ký tự (contract `tagName`, FG-VAL-001). `uniqRaw()` thêm ~21–24 ký tự (PW_AREA + thời gian +
 * số ngẫu nhiên): với PW_AREA dài như `tags-final`, tiền tố dài sẽ vượt 40 ký tự và API trả 422. Hàm này rút gọn
 * TIỀN TỐ khi cần, giữ nguyên hậu tố duy nhất nên tên vẫn hợp lệ và không trùng. Tên ngắn giữ nguyên như cũ.
 */
function uniq(prefix: string): string {
  const name = uniqRaw(prefix);
  if (name.length <= 40) return name;
  const suffix = name.slice(prefix.length);
  return `${prefix.slice(0, 40 - suffix.length).trimEnd()}${suffix}`;
}

/** Ô nhập bên trong một trường có nhãn (FgField: <div><label/>…</div>). */
function fieldInput(page: import('@playwright/test').Page, label: string) {
  return page.getByText(label, { exact: true }).first().locator('xpath=..').locator('input').first();
}

/**
 * Bấm "Lưu tag" và CHỜ đúng phản hồi PATCH /documents/:id/tags (không dựa vào việc nút biến mất:
 * nút đổi tên truy cập khi đang lưu nên dễ đọc sớm trạng thái cũ).
 */
async function saveTagsAndWait(page: import('@playwright/test').Page, docId: string, expectedTagCount: number): Promise<void> {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && new RegExp(`/documents/${docId}/tags$`).test(new URL(r.url()).pathname),
      { timeout: 15_000 },
    ),
    saveTagsButton(page).click(),
  ]);
  expect(res.status(), 'PATCH tag của phiếu phải thành công').toBe(200);
  await expect(toast(page, 'Đã cập nhật tag của phiếu')).toBeVisible({ timeout: 10_000 });
  // Sau khi lưu, phiếu được làm tươi: thẻ tag chỉ có đúng số tag đã lưu (trước khi làm tươi còn hiện trạng thái cũ).
  await expect(detailTagChips(page), 'thẻ tag hiển thị đúng sau khi làm tươi phiếu').toHaveCount(expectedTagCount, { timeout: 10_000 });
}

/**
 * Chờ các request do việc chọn tag `tagId` gây ra (gửi tới `paths`) đã có response. Gọi TRƯỚC khi chọn tag.
 * Lọc theo URL đổi qua transition nên request lọc có thể gửi trễ vài trăm ms sau khi chọn tag; nếu không
 * chờ, request đó bị ghi nhận nhầm là request của lần đổi phạm vi (`settle` không chờ mạng vì trang đã idle).
 */
function tagRequestsDone(page: import('@playwright/test').Page, tagId: string, paths: string[]): Promise<unknown> {
  return Promise.all(
    paths.map((p) => page.waitForResponse((r) => r.url().includes(p) && r.url().includes(`tag_ids=${tagId}`), { timeout: 15_000 })),
  );
}

/** Chip tag trong thẻ "Tag của phiếu" (chi tiết phiếu), không gồm chip trạng thái. */
function detailTagChips(page: import('@playwright/test').Page) {
  return page
    .locator('.ant-select', { has: page.getByRole('combobox', { name: DETAIL_TAG_LABEL, exact: true }) })
    .first()
    .locator('.fg-chip');
}

/* =========================================================================
 * 1. Gắn tag trên phiếu — US-VOU-02
 * ========================================================================= */

test.describe('US-VOU-02 · gắn tag khi lập / sửa phiếu', () => {
  test('KTV lập phiếu chi: gõ tag chưa có → "+ Tạo tag" tạo và gắn ngay, lưu nháp', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'create-voucher');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerName = uniq('NCC lập phiếu');
      await createPartnerApi(staff, cta, 'supplier', partnerName);
      const newTag = uniq('Dự án lập phiếu');
      const purpose = uniq('Thanh toán kiểm thử');

      await openPage(staff, '/chi/moi');
      await staff.getByPlaceholder(/Thanh toán đợt 2/).fill(purpose);

      // Đối tác: gõ tên rồi chọn gợi ý
      const partnerBox = staff.locator('.ant-select', { hasText: 'Tìm nhà cung cấp' }).locator('input').first();
      await partnerBox.click();
      await partnerBox.pressSequentially(partnerName);
      await visibleOption(staff, partnerName).click();

      await fieldInput(staff, 'Số tiền *').fill('150000');
      await fieldInput(staff, 'Số tiền *').press('Tab');

      const deadline = fieldInput(staff, 'Hạn thanh toán (deadline) *');
      await deadline.click();
      await deadline.fill('30/12/2026 10:00');
      await deadline.press('Enter');

      await staff.locator('.ant-select', { hasText: 'Chọn tài khoản ngân hàng' }).first().click();
      await visibleOption(staff, '').first().click();

      // Tag: gõ tên mới → dòng "+ Tạo tag"
      const box = tagCombo(staff, VOUCHER_TAG_LABEL);
      await expect(box).toBeEnabled();
      await box.click();
      await box.pressSequentially(newTag);
      const createOpt = visibleOption(staff, '+ Tạo tag');
      await expect(createOpt, 'dòng "+ Tạo tag" hiện khi tên chưa tồn tại').toBeVisible();
      await createOpt.click();
      await expect(staff.locator('.fg-chip', { hasText: newTag })).toBeVisible({ timeout: 10_000 });
      await staff.keyboard.press('Escape');

      await staff.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
      await staff.waitForURL(/\/ho-so\/chi\/[0-9a-f]{24}/, { timeout: 20_000 });
      const id = staff.url().split('/').pop()!;
      const doc = await getDocApi(staff, cta, id);
      const names = (doc.tags ?? []).map((t: any) => t.name);
      expect(names, 'phiếu lưu đúng tag vừa tạo').toContain(newTag);
      expect(doc.tag_ids?.length).toBe(1);
      const created = await tagByName(staff, cta, newTag);
      expect(created, 'tag tạo ra nằm trong danh bạ công ty CTA').toBeTruthy();
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('chuẩn hoá: gõ khác hoa/thường + nhiều khoảng trắng → dùng lại tag có sẵn, không tạo trùng', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'normalise');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const base = uniq('Dự án Chuẩn hoá');
      const tagId = await ensureTagApi(staff, cta, base);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'customer', uniq('KH chuẩn hoá'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu chuẩn hoá') });

      await openPage(staff, `/chi/${v.id}/sua`);
      const box = tagCombo(staff, VOUCHER_TAG_LABEL);
      await box.click();
      // biến thể: chữ hoa + khoảng trắng thừa ở đầu, giữa và cuối
      const variant = `   ${base.toUpperCase().replace(/ /g, '    ')}   `;
      await box.pressSequentially(variant);
      await expect(visibleOption(staff, base), 'gợi ý tag cũ khi gõ biến thể').toBeVisible({ timeout: 10_000 });
      await expect(visibleOption(staff, '+ Tạo tag'), 'không đề nghị tạo tag trùng tên').toHaveCount(0);
      await visibleOption(staff, base).click();
      await staff.keyboard.press('Escape');
      await expect(staff.locator('.fg-chip', { hasText: base })).toHaveCount(1);

      await staff.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
      await staff.waitForURL(/\/ho-so\/chi\//, { timeout: 20_000 });

      const doc = await getDocApi(staff, cta, v.id);
      expect(doc.tag_ids, 'phiếu gắn đúng id tag có sẵn').toEqual([tagId]);
      const same = await tagsNamed(staff, cta, base);
      expect(same.length, 'chỉ một tag cùng tên chuẩn hoá trong danh bạ').toBe(1);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('nhiều tag: gắn hai tag có sẵn và một tag mới trong cùng một phiếu', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'multi-tag');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagA = uniq('Đa tag A');
      const tagB = uniq('Đa tag B');
      const idA = await ensureTagApi(staff, cta, tagA);
      const idB = await ensureTagApi(staff, cta, tagB);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'customer', uniq('KH đa tag'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu đa tag'), tagIds: [idA] });
      const tagC = uniq('Đa tag C');

      await openPage(staff, `/chi/${v.id}/sua`);
      const box = tagCombo(staff, VOUCHER_TAG_LABEL);
      await pickExistingTag(staff, box, tagB, tagB);
      await expect(staff.locator('.fg-chip', { hasText: tagB }), 'chip tag có sẵn hiện sau khi chọn').toHaveCount(1, { timeout: 10_000 });
      await box.click();
      await box.pressSequentially(tagC);
      await visibleOption(staff, '+ Tạo tag').click();
      await expect(staff.locator('.fg-chip', { hasText: tagC })).toBeVisible({ timeout: 10_000 });
      await expect(staff.locator('.fg-chip', { hasText: tagB }), 'tag đã chọn vẫn còn sau khi tạo tag mới').toHaveCount(1);
      await expect(staff.locator('.fg-chip', { hasText: tagA }), 'tag ban đầu vẫn còn').toHaveCount(1);
      await staff.keyboard.press('Escape');
      await staff.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
      await staff.waitForURL(/\/ho-so\/chi\//, { timeout: 20_000 });

      const doc = await getDocApi(staff, cta, v.id);
      expect(doc.tag_ids?.length, 'phiếu có đủ 3 tag').toBe(3);
      expect(doc.tag_ids).toEqual(expect.arrayContaining([idA, idB]));
      const names = (doc.tags ?? []).map((t: any) => t.name).sort();
      expect(names).toEqual([tagA, tagB, tagC].sort());
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('tag đã ẩn không được gợi ý khi gõ; tên trùng tag đã ẩn không tạo được tag mới', async ({ as }) => {
    const chief = await as('chief');
    const staff = await as('staff');
    const restoreChief = await useCompanyScope(chief, COMPANY.CTA);
    const restoreStaff = await useCompanyScope(staff, COMPANY.CTA);
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const hiddenName = uniq('Đã ẩn gợi ý');
      const hiddenId = await ensureTagApi(chief, cta, hiddenName);
      const hide = await api(chief, 'PATCH', `/tags/${hiddenId}`, { scope: cta, data: { hidden: true } });
      expect(hide.status, 'KTT ẩn tag không dùng').toBe(200);

      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'customer', uniq('KH ẩn tag'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu tag ẩn') });

      await openPage(staff, `/chi/${v.id}/sua`);
      const box = tagCombo(staff, VOUCHER_TAG_LABEL);
      await box.click();
      await box.pressSequentially(hiddenName);
      await staff.waitForTimeout(800);
      // tag đã ẩn KHÔNG được gợi ý như một tag có sẵn
      const existing = staff.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: hiddenName }).filter({ hasNotText: '+ Tạo tag' });
      await expect(existing, 'tag đã ẩn không nằm trong danh sách gợi ý').toHaveCount(0);
      // nếu vẫn đề nghị "+ Tạo tag" cho đúng tên đó, bấm vào không được tạo bản trùng và phải báo tag đã ẩn
      const createOpt = staff.locator('.ant-select-dropdown:visible .ant-select-item-option', { hasText: '+ Tạo tag' });
      if (await createOpt.count()) {
        await createOpt.first().click();
        await expect(toast(staff, 'đang bị ẩn')).toBeVisible({ timeout: 10_000 });
      }
      await staff.keyboard.press('Escape');
      const copies = await tagsNamed(chief, cta, hiddenName);
      expect(copies.length, 'không tạo bản trùng của tag đã ẩn').toBe(1);

      const dup = await api(staff, 'POST', '/tags', { scope: cta, data: { company_id: cta, name: hiddenName } });
      expect(dup.status, 'tạo trùng tên tag đang ẩn bị từ chối').toBe(409);
      expect(dup.body?.code).toBe('FG-TAG-001');
    } finally {
      await restoreStaff();
      await restoreChief();
    }
  });
});

/* =========================================================================
 * 2. Quản lý tag (KTT) — §6.2, §13, US-VOU-04
 * ========================================================================= */

test.describe('KTT · màn Quản lý tag', () => {
  test('KTT tạo tag trong modal (chọn màu) và thấy đúng dòng trong bảng; tạo trùng tên báo "đã có sẵn"', async ({ as }) => {
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'tags-create');
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const name = uniq('Công trình KTT');
      await openPage(chief, '/quantri/tags');
      await chief.getByRole('button', { name: '+ Tạo tag', exact: true }).click();
      const dialog = chief.getByRole('dialog');
      await dialog.getByLabel('Tên tag').fill(name);
      await dialog.getByRole('radio', { name: 'Màu #2563eb', exact: true }).click();
      await dialog.getByRole('button', { name: 'Tạo tag', exact: true }).click();
      await expect(toast(chief, `Đã tạo tag “${name}”`)).toBeVisible({ timeout: 10_000 });

      const row = tableRow(chief, name);
      await expect(row).toBeVisible();
      await expect(row).toContainText('Đang dùng');
      await expect(row.locator('.fg-chip span[aria-hidden]').first(), 'chấm màu đúng màu đã chọn').toHaveCSS('background-color', 'rgb(37, 99, 235)');
      const saved = await tagByName(chief, cta, name);
      expect(saved?.color).toBe('#2563eb');

      // trùng tên: không tạo thêm, báo tag đã có. Ô "Tên tag" giới hạn 40 ký tự (maxLength): chỉ thêm một khoảng trắng
      // mỗi đầu, nếu không thì phần cuối bị cắt cụt, tên đổi và tạo tag mới thay vì báo trùng.
      await chief.getByRole('button', { name: '+ Tạo tag', exact: true }).click();
      const dialog2 = chief.getByRole('dialog');
      await dialog2.getByLabel('Tên tag').fill(` ${name.toUpperCase()} `);
      await dialog2.getByRole('button', { name: 'Tạo tag', exact: true }).click();
      await expect(toast(chief, 'đã có sẵn — không tạo trùng')).toBeVisible({ timeout: 10_000 });
      const all = await tagsNamed(chief, cta, name);
      expect(all.length, 'không tạo bản trùng').toBe(1);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  // Round 4 báo lỗi: danh bạ CTA > 500 tag, UI chỉ tải 500 tag đầu nên không tìm / sửa được tag ngoài đó.
  // Round 5: UI tải đủ mọi trang. Tên "Đợt cũ…" xếp sau 500 tag đầu (mục 11 kiểm thêm tag cuối danh bạ).
  test('KTT sửa tên và màu tag đang gắn phiếu → bảng và chip trên phiếu cập nhật theo', async ({ as }) => {
    const chief = await as('chief');
    const staff = await as('staff');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'tags-edit');
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const oldName = uniq('Đợt cũ');
      const newName = uniq('Đợt mới đổi tên');
      const tagId = await ensureTagApi(chief, cta, oldName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'customer', uniq('KH đổi tên'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu đổi tên'), tagIds: [tagId] });

      await openPage(chief, '/quantri/tags');
      await chief.getByRole('textbox', { name: 'Tìm tag theo tên', exact: true }).fill(oldName);
      await chief.getByRole('button', { name: `Sửa tag ${oldName}`, exact: true }).click();
      const dialog = chief.getByRole('dialog');
      await expect(dialog).toContainText(oldName);
      await dialog.getByLabel('Tên tag').fill(newName);
      await dialog.getByRole('radio', { name: 'Màu #0891b2', exact: true }).click();
      await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
      await expect(toast(chief, 'Đã lưu tag')).toBeVisible({ timeout: 10_000 });
      // ô tìm vẫn là tên cũ: đổi sang tên mới để thấy dòng đã đổi tên
      await chief.getByRole('textbox', { name: 'Tìm tag theo tên', exact: true }).fill(newName);

      const row = tableRow(chief, newName);
      await expect(row).toBeVisible();
      await expect(row.locator('.fg-chip span[aria-hidden]').first()).toHaveCSS('background-color', 'rgb(8, 145, 178)');
      const saved = await tagByName(chief, cta, newName);
      expect(saved?.color).toBe('#0891b2');
      const doc = await getDocApi(chief, cta, v.id);
      expect((doc.tags ?? []).map((t: any) => t.name), 'phiếu hiển thị tên mới của tag').toContain(newName);
      // thẻ tag trên trang phiếu cũng hiện tên và màu mới (không chỉ bảng quản lý)
      await openPage(chief, `/ho-so/chi/${v.id}`);
      const renamedChip = detailTagChips(chief).filter({ hasText: newName });
      await expect(renamedChip, 'thẻ tag trên phiếu hiện tên mới').toHaveCount(1, { timeout: 10_000 });
      await expect(renamedChip.locator('span[aria-hidden]').first(), 'chấm màu trên phiếu đổi theo màu mới').toHaveCSS('background-color', 'rgb(8, 145, 178)');
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('đổi tên trùng với tag khác bị chặn (FG-TAG-001) và giữ nguyên tên cũ', async ({ as }) => {
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const nameP = uniq('Tag gốc P');
      const nameQ = uniq('Tag đổi Q');
      await ensureTagApi(chief, cta, nameP);
      await ensureTagApi(chief, cta, nameQ);

      await openPage(chief, '/quantri/tags');
      await chief.getByRole('textbox', { name: 'Tìm tag theo tên', exact: true }).fill(nameQ);
      await chief.getByRole('button', { name: `Sửa tag ${nameQ}`, exact: true }).click();
      const dialog = chief.getByRole('dialog');
      await dialog.getByLabel('Tên tag').fill(nameP);
      await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
      await expect(dialog).toContainText('gộp hai tag', { timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Hủy', exact: true }).click();

      const q = await tagByName(chief, cta, nameQ);
      expect(q?.name, 'tên tag không đổi khi bị chặn').toBe(nameQ);
    } finally {
      await restore();
    }
  });

  test('ẩn / hiện tag không dùng; tag đang gắn phiếu không ẩn được (nút bị khoá)', async ({ as }) => {
    const chief = await as('chief');
    const staff = await as('staff');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'tags-hide');
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const idle = uniq('Tag ẩn được');
      const busy = uniq('Tag đang dùng');
      await ensureTagApi(chief, cta, idle);
      const busyId = await ensureTagApi(chief, cta, busy);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'customer', uniq('KH ẩn'));
      await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu đang dùng tag'), tagIds: [busyId] });

      await openPage(chief, '/quantri/tags');
      await chief.getByRole('button', { name: `Ẩn tag ${idle}`, exact: true }).click();
      await expect(toast(chief, `Đã ẩn tag “${idle}”`)).toBeVisible({ timeout: 10_000 });
      await expect(tableRow(chief, idle)).toContainText('Đã ẩn');

      await chief.getByRole('button', { name: `Hiện lại tag ${idle}`, exact: true }).click();
      await expect(toast(chief, `Đã hiện lại tag “${idle}”`)).toBeVisible({ timeout: 10_000 });
      await expect(tableRow(chief, idle)).toContainText('Đang dùng');

      await expect(chief.getByRole('button', { name: `Ẩn tag ${busy}`, exact: true }), 'nút ẩn bị khoá khi tag còn phiếu').toBeDisabled();
      const hideApi = await api(chief, 'PATCH', `/tags/${busyId}`, { scope: cta, data: { hidden: true } });
      expect(hideApi.status, 'server cũng từ chối ẩn tag đang gắn phiếu').toBe(422);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('gộp tag (US-VOU-04): mọi phiếu (nháp và đã duyệt) chuyển sang tag đích, tag nguồn bị ẩn, có lịch sử', async ({ as }) => {
    const chief = await as('chief');
    const staff = await as('staff');
    const restoreChief = await useCompanyScope(chief, COMPANY.CTA);
    const restoreStaff = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(chief, 'tags-merge');
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const sourceName = uniq('DA-X');
      const targetName = uniq('Dự án X');
      const sourceId = await ensureTagApi(staff, cta, sourceName);
      const targetId = await ensureTagApi(staff, cta, targetName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'customer', uniq('KH gộp'));
      const draft = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu gộp nháp'), tagIds: [sourceId] });
      const approved = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu gộp đã duyệt'), tagIds: [sourceId] });
      const status = await approveFullyApi({ staff, chief, director: await as('director'), chairman: await as('chairman') }, cta, approved.id);
      expect(status).toBe('approved');

      await openPage(chief, '/quantri/tags');
      await chief.getByRole('textbox', { name: 'Tìm tag theo tên', exact: true }).fill(sourceName);
      await chief.getByRole('button', { name: `Gộp tag ${sourceName}`, exact: true }).click();
      const dialog = chief.getByRole('dialog');
      await dialog.getByRole('combobox', { name: 'Tag đích', exact: true }).click();
      await dialog.getByRole('combobox', { name: 'Tag đích', exact: true }).pressSequentially(targetName);
      await visibleOption(chief, targetName).click();
      await dialog.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
      await expect(dialog, 'bước xác nhận nêu số phiếu sẽ chuyển').toContainText('2 phiếu');
      await dialog.getByRole('button', { name: 'Gộp tag', exact: true }).click();
      await expect(toast(chief, /Đã gộp .* vào .* · đã chuyển 2 phiếu/)).toBeVisible({ timeout: 15_000 });

      const d1 = await getDocApi(chief, cta, draft.id);
      const d2 = await getDocApi(chief, cta, approved.id);
      expect(d1.tag_ids, 'phiếu nháp chuyển sang tag đích').toEqual([targetId]);
      expect(d2.tag_ids, 'phiếu đã duyệt chuyển sang tag đích').toEqual([targetId]);
      expect((d2.history ?? []).map((h: any) => h.action), 'lịch sử ghi tag_merge').toContain('tag_merge');
      const src = await tagByName(chief, cta, sourceName);
      expect(src?.hidden, 'tag nguồn bị ẩn (không xoá)').toBe(true);
      expect(src?.usage_count).toBe(0);
      const tgt = await tagByName(chief, cta, targetName);
      expect(tgt?.usage_count).toBeGreaterThanOrEqual(2);
      // tab Audit log của phiếu đã duyệt: hành động gộp hiện nhãn "Gộp tag", không hiện mã thô tag_merge
      await openPage(chief, `/ho-so/chi/${approved.id}`);
      await chief.getByRole('tab', { name: /Audit log/ }).click();
      const mergeAudit = chief.locator('.ant-table').filter({ has: chief.getByRole('columnheader', { name: 'Hành động', exact: true }) });
      await expect(mergeAudit.getByText('Gộp tag', { exact: true }), 'Audit log hiện nhãn "Gộp tag"').toBeVisible({ timeout: 10_000 });
      await expect(mergeAudit.getByText('tag_merge', { exact: true }), 'Audit log không hiện mã thô tag_merge').toHaveCount(0);
      expectNoAppCrash(watch);
    } finally {
      await restoreStaff();
      await restoreChief();
    }
  });

  test('gộp khi phiếu đã có CẢ HAI tag: phiếu không bị trùng tag, chỉ còn tag đích; gộp vào tag đang ẩn bị từ chối (422)', async ({ as }) => {
    const chief = await as('chief');
    const staff = await as('staff');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const srcId = await ensureTagApi(staff, cta, uniq('Gộp trùng nguồn'));
      const dstId = await ensureTagApi(staff, cta, uniq('Gộp trùng đích'));
      const hiddenId = await ensureTagApi(staff, cta, uniq('Gộp vào tag ẩn'));
      expect((await api(chief, 'PATCH', `/tags/${hiddenId}`, { scope: cta, data: { hidden: true } })).status, 'KTT ẩn tag không dùng').toBe(200);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC gộp trùng'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu gộp trùng'), tagIds: [srcId, dstId] });

      const refused = await api(chief, 'POST', '/tags/merge', { scope: cta, data: { source_id: srcId, target_id: hiddenId } });
      expect(refused.status, 'không gộp được vào tag đích đang ẩn').toBe(422);

      const merged = await api(chief, 'POST', '/tags/merge', { scope: cta, data: { source_id: srcId, target_id: dstId } });
      expect(merged.status, 'gộp hai tag thành công').toBeLessThan(300);
      const doc = await getDocApi(chief, cta, v.id);
      expect(doc.tag_ids, 'phiếu có cả hai tag chỉ còn đúng một tag đích (không trùng)').toEqual([dstId]);
    } finally {
      await restore();
    }
  });
});

/* =========================================================================
 * 3. Sau khi duyệt — §6.2 "sửa được cả sau khi duyệt, không ảnh hưởng tiền, ghi lịch sử"
 * ========================================================================= */

test.describe('sau khi duyệt · sửa tag trên phiếu đã duyệt', () => {
  test('KTT sửa tag phiếu đã duyệt: lưu được nhiều lần, số tiền/trạng thái không đổi, lịch sử ghi tags_update', async ({ as }) => {
    const chief = await as('chief');
    const staff = await as('staff');
    const director = await as('director');
    const chairman = await as('chairman');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'post-approval');
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const tagOld = uniq('Đợt đầu');
      const tagNew = uniq('Đợt sau duyệt');
      const oldId = await ensureTagApi(staff, cta, tagOld);
      const newId = await ensureTagApi(staff, cta, tagNew);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC sau duyệt'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu sau duyệt'), tagIds: [oldId] });
      expect(await approveFullyApi({ staff, chief, director, chairman }, cta, v.id)).toBe('approved');
      const before = await getDocApi(chief, cta, v.id);

      await openPage(chief, `/ho-so/chi/${v.id}`);
      const box = tagCombo(chief, DETAIL_TAG_LABEL);
      await expect(box).toBeEnabled();
      await box.click();
      await box.pressSequentially(tagNew);
      await visibleOption(chief, tagNew).click();
      await chief.keyboard.press('Escape');
      await saveTagsAndWait(chief, v.id, 2);
      // lần 2 trên cùng trang (không tải lại): phiếu đã làm tươi nên version mới được dùng
      await detailTagChips(chief).filter({ hasText: tagOld }).getByRole('button', { name: `Bỏ tag ${tagOld}` }).click();
      await saveTagsAndWait(chief, v.id, 1);

      const after = await getDocApi(chief, cta, v.id);
      expect(after.tag_ids, 'chỉ còn tag mới').toEqual([newId]);
      expect(after.status).toBe('approved');
      expect(after.amount, 'số tiền không đổi').toEqual(before.amount);
      const tagHistory = (after.history ?? []).filter((h: any) => h.action === 'tags_update');
      expect(tagHistory.length, 'mỗi lần sửa ghi một dòng lịch sử').toBe(2);
      expect(tagHistory[0].fields?.added?.map((x: any) => x.id)).toContain(newId);
      expect(tagHistory[1].fields?.removed?.map((x: any) => x.id)).toContain(oldId);

      // lịch sử hiển thị ở tab Audit log: nhãn đọc được (không hiện mã kỹ thuật)
      await chief.getByRole('tab', { name: /Audit log/ }).click();
      const auditTable = chief.locator('.ant-table').filter({ has: chief.getByRole('columnheader', { name: 'Hành động', exact: true }) });
      await expect(auditTable, 'bảng Audit log (cột Hành động)').toHaveCount(1);
      const auditBody = auditTable.locator('.ant-table-tbody');
      await expect(auditBody.locator('tr').first()).toBeVisible({ timeout: 10_000 });
      const rawCode = await auditBody.getByText('tags_update', { exact: true }).count();
      const readable = await auditBody.getByText(/Sửa tag|Cập nhật tag|Đổi tag/).count();
      console.log(`[post-approval] audit: raw tags_update=${rawCode}, nhãn tiếng Việt=${readable}`);
      expect(rawCode, 'Audit log không hiện mã kỹ thuật tags_update').toBe(0);
      expect(readable, 'Audit log có nhãn tiếng Việt cho lần sửa tag').toBeGreaterThan(0);
      // các hành động khác của cùng lịch sử phiếu cũng phải có nhãn (không hiện create / submit / approve thô)
      for (const raw of ['create', 'submit', 'approve']) {
        expect(await auditBody.getByText(raw, { exact: true }).count(), `Audit log không hiện mã thô "${raw}"`).toBe(0);
      }
      for (const label of ['Tạo hồ sơ', 'Gửi duyệt', 'Duyệt']) {
        expect(await auditBody.getByText(label, { exact: true }).count(), `Audit log có nhãn "${label}"`).toBeGreaterThan(0);
      }
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('KTV là người lập phiếu sửa được tag phiếu đã duyệt của mình', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'creator-edit');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const extra = uniq('Tag KTV sau duyệt');
      await ensureTagApi(staff, cta, extra);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'customer', uniq('KH KTV'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu KTV tự sửa') });
      expect(await approveFullyApi({ staff, chief, director, chairman }, cta, v.id)).toBe('approved');

      await openPage(staff, `/ho-so/chi/${v.id}`);
      const box = tagCombo(staff, DETAIL_TAG_LABEL);
      await expect(box, 'người lập được sửa tag').toBeEnabled();
      await box.click();
      await box.pressSequentially(extra);
      await visibleOption(staff, extra).click();
      await staff.keyboard.press('Escape');
      await saveTagsAndWait(staff, v.id, 1);
      const doc = await getDocApi(staff, cta, v.id);
      expect(doc.tags?.map((t: any) => t.name)).toContain(extra);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('lịch sử "Sửa tag" trên tab Audit của phiếu đã duyệt nêu tên tag được thêm và tag bị bỏ (không chỉ nhãn chung)', async ({ as }) => {
    const chief = await as('chief');
    const staff = await as('staff');
    const director = await as('director');
    const chairman = await as('chairman');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'post-approval-history-names');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const oldName = uniq('Lịch sử tag cũ');
      const newName = uniq('Lịch sử tag mới');
      const oldId = await ensureTagApi(staff, cta, oldName);
      await ensureTagApi(staff, cta, newName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC lịch sử tag'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu lịch sử tag'), tagIds: [oldId] });
      expect(await approveFullyApi({ staff, chief, director, chairman }, cta, v.id)).toBe('approved');

      await openPage(chief, `/ho-so/chi/${v.id}`);
      const box = tagCombo(chief, DETAIL_TAG_LABEL);
      await box.click();
      await box.pressSequentially(newName);
      await visibleOption(chief, newName).click();
      await chief.keyboard.press('Escape');
      await detailTagChips(chief).filter({ hasText: oldName }).getByRole('button', { name: `Bỏ tag ${oldName}` }).click();
      await saveTagsAndWait(chief, v.id, 1);

      await chief.getByRole('tab', { name: /Audit log/ }).click();
      const auditTable = chief.locator('.ant-table').filter({ has: chief.getByRole('columnheader', { name: 'Hành động', exact: true }) });
      const editRow = auditTable.locator('.ant-table-tbody tr.ant-table-row', { hasText: 'Sửa tag' }).first();
      await expect(editRow, 'lịch sử có dòng "Sửa tag"').toBeVisible({ timeout: 10_000 });
      await expect(editRow, 'dòng "Sửa tag" nêu tag được thêm (để biết đã đổi gì)').toContainText(newName);
      await expect(editRow, 'dòng "Sửa tag" nêu tag bị bỏ (để biết đã đổi gì)').toContainText(oldName);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('giám đốc (không phải người lập, không có tag:manage) không sửa được tag: ô khoá, API từ chối', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const restoreDir = await useCompanyScope(director, COMPANY.CTA);
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'customer', uniq('KH giám đốc'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu giám đốc xem') });
      expect(await approveFullyApi({ staff, chief, director, chairman }, cta, v.id)).toBe('approved');

      await openPage(director, `/ho-so/chi/${v.id}`);
      await expect(tagCombo(director, DETAIL_TAG_LABEL)).toBeDisabled();
      await expect(director.getByText('Bạn không có quyền sửa tag của phiếu này.')).toBeVisible();

      const attempt = await api(director, 'PATCH', `/documents/${v.id}/tags`, {
        scope: cta,
        data: { tag_ids: [], if_match: (await getDocApi(director, cta, v.id)).version },
      });
      expect([401, 403]).toContain(attempt.status);
    } finally {
      await restoreDir();
    }
  });

  test('KTV không phải người lập (phiếu KTT đã duyệt): máy chủ từ chối sửa tag, can.tag và ô tag khoá đúng như vậy', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const director = await as('director');
    const chairman = await as('chairman');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'non-creator-ktv-tag');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagId = await ensureTagApi(chief, cta, uniq('Tag KTV không lập'));
      const acc = await firstBankAccountApi(chief, cta);
      const partnerId = await createPartnerApi(chief, cta, 'customer', uniq('KH KTV không lập'));
      // phiếu do KTT lập và đã duyệt: KTV (kt) không phải người lập và không có tag:manage
      const v = await createVoucherApi(chief, cta, { partnerId, accountId: acc, title: uniq('Phiếu KTT lập đã duyệt') });
      expect(await approveFullyApi({ staff: chief, chief, director, chairman }, cta, v.id)).toBe('approved');

      const attempt = await setDocTagsApi(staff, cta, v.id, [tagId]);
      expect(attempt.status, 'máy chủ từ chối KTV không phải người lập sửa tag (FG-RBAC-001)').toBe(403);
      const doc = await getDocApi(staff, cta, v.id);
      expect(doc.can?.tag, 'can.tag khớp luật máy chủ (chỉ người lập hoặc KTT): không được báo là sửa được').toBe(false);

      await openPage(staff, `/ho-so/chi/${v.id}`);
      await expect(tagCombo(staff, DETAIL_TAG_LABEL), 'ô tag khoá với KTV không phải người lập').toBeDisabled();
      await expect(staff.getByText('Bạn không có quyền sửa tag của phiếu này.')).toBeVisible();
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

/* =========================================================================
 * 4. Danh sách phiếu — lọc / tìm theo tag (US-VOU-03, §12)
 * ========================================================================= */

test.describe('danh sách phiếu · lọc và tìm theo tag', () => {
  test('lọc theo một tag: chỉ hiện phiếu có tag đó; URL giữ tag_ids; "Xóa lọc" bỏ bộ lọc', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'list-filter');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const t1 = uniq('Lọc T1');
      const t2 = uniq('Lọc T2');
      const id1 = await ensureTagApi(staff, cta, t1);
      const id2 = await ensureTagApi(staff, cta, t2);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC lọc'));
      const d1 = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu lọc 1'), tagIds: [id1] });
      const d2 = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu lọc 2'), tagIds: [id2] });
      // phiếu thứ ba cùng tag T1 với d1: danh sách phải hiện đủ cả hai (hồi quy: TagList sập khi hai phiếu cùng tag)
      const d3 = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu lọc 3'), tagIds: [id1] });

      await openPage(staff, '/chi');
      await staff.waitForTimeout(1000);
      expect(watch.pageErrors, 'danh sách phiếu không được lỗi JS (có hai phiếu cùng tag)').toEqual([]);
      await tagCombo(staff, 'Lọc theo tag').click();
      await tagCombo(staff, 'Lọc theo tag').pressSequentially(t1);
      await visibleOption(staff, t1).click();
      await staff.keyboard.press('Escape');
      await staff.waitForURL(new RegExp(`tag_ids=${id1}`), { timeout: 10_000 });

      await expect(staff.locator('tr', { hasText: d1.code })).toHaveCount(1, { timeout: 15_000 });
      await expect(staff.locator('tr', { hasText: d3.code }), 'phiếu thứ hai cùng tag cũng hiện').toHaveCount(1);
      await expect(staff.locator('tr', { hasText: d2.code }), 'phiếu không có tag đã chọn bị loại').toHaveCount(0);
      await expect(staff.locator('tr', { hasText: d1.code }).locator('.fg-chip', { hasText: t1 })).toHaveCount(1);
      await expect(staff.locator('tr', { hasText: d3.code }).locator('.fg-chip', { hasText: t1 })).toHaveCount(1);

      await staff.getByRole('button', { name: 'Xóa lọc', exact: true }).click();
      await expect(staff).not.toHaveURL(/tag_ids=/);
      // Phiếu nháp mới nằm ngoài 100 dòng đầu của kho dữ liệu dùng chung (sắp theo thời gian chờ): tìm đúng mã
      // để chứng minh bộ lọc tag đã bỏ — d2 (tag khác) hiện lại khi không còn lọc.
      await staff.getByRole('textbox', { name: 'Tìm kiếm trong danh sách', exact: true }).fill(d2.code);
      await expect(staff.locator('tr', { hasText: d2.code }), 'sau "Xóa lọc" phiếu không tag T1 hiện lại').toHaveCount(1, { timeout: 15_000 });
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('lọc nhiều tag: phiếu có ÍT NHẤT một trong các tag đã chọn đều hiện', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const t1 = uniq('Hợp T1');
      const t2 = uniq('Hợp T2');
      const id1 = await ensureTagApi(staff, cta, t1);
      const id2 = await ensureTagApi(staff, cta, t2);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC hợp'));
      const d1 = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu hợp 1'), tagIds: [id1] });
      const d2 = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu hợp 2'), tagIds: [id2] });
      const none = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu hợp không tag') });

      await openPage(staff, `/chi?tag_ids=${id1},${id2}`);
      await expect(staff.locator('tr', { hasText: d1.code })).toHaveCount(1, { timeout: 15_000 });
      await expect(staff.locator('tr', { hasText: d2.code })).toHaveCount(1);
      await expect(staff.locator('tr', { hasText: none.code })).toHaveCount(0);
    } finally {
      await restore();
    }
  });

  test('ô tìm kiếm trong danh sách khớp theo tên tag (§12 tìm theo tag)', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'list-search');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Tìm theo tag');
      const tagId = await ensureTagApi(staff, cta, tagName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC tìm'));
      const hit = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu tìm có tag'), tagIds: [tagId] });
      // hai phiếu cùng tag (đúng như chú thích bên dưới): cả hai phải hiện khi tìm theo tên tag
      const hit2 = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu tìm có tag 2'), tagIds: [tagId] });
      const miss = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu tìm không tag') });

      await openPage(staff, '/chi');
      await staff.waitForTimeout(1000);
      expect(watch.pageErrors, 'danh sách phiếu không được lỗi JS (có hai phiếu cùng tag)').toEqual([]);
      await staff.getByRole('textbox', { name: 'Tìm kiếm trong danh sách', exact: true }).fill(tagName);
      await expect(staff.locator('tr', { hasText: hit.code })).toHaveCount(1, { timeout: 15_000 });
      await expect(staff.locator('tr', { hasText: hit2.code }), 'phiếu thứ hai cùng tag cũng hiện khi tìm').toHaveCount(1);
      await expect(staff.locator('tr', { hasText: miss.code })).toHaveCount(0);
    } finally {
      await restore();
    }
  });

  test('hai phiếu cùng một tag: API không trả mục tag null; danh sách hiện đủ hai dòng với chip tag (hồi quy TagList)', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'list-shared-tag');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const shared = uniq('Tag chung hai phiếu');
      const tagId = await ensureTagApi(staff, cta, shared);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC tag chung'));
      const first = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu tag chung 1'), tagIds: [tagId] });
      const second = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu tag chung 2'), tagIds: [tagId] });

      // API: phiếu thứ hai cùng tag phải có đủ object tag (không phải null) — nguyên nhân gốc của lỗi TagList
      const list = await api<any>(staff, 'GET', '/documents', { scope: cta, query: { kind: 'spend', tag_ids: tagId, limit: 50 } });
      expect(list.status, 'GET /documents lọc theo tag').toBe(200);
      const items = (list.body?.items ?? []) as any[];
      const mine = items.filter((x) => [first.id, second.id].includes(String(x._id)));
      expect(mine.map((x) => String(x._id)).sort(), 'API trả đủ hai phiếu cùng tag').toEqual([first.id, second.id].sort());
      for (const x of mine) {
        expect(x.tags, `phiếu ${x.code}: mục tag không được null`).toEqual([expect.objectContaining({ _id: tagId, name: shared })]);
      }

      // giao diện: danh sách không sập (không error boundary), đủ hai dòng, mỗi dòng có chip đúng tên tag
      await openPage(staff, `/chi?tag_ids=${tagId}`);
      await expect(staff.locator('tr', { hasText: first.code })).toHaveCount(1, { timeout: 15_000 });
      await expect(staff.locator('tr', { hasText: second.code })).toHaveCount(1, { timeout: 15_000 });
      await expect(staff.locator('tr', { hasText: first.code }).locator('.fg-chip', { hasText: shared })).toHaveCount(1);
      await expect(staff.locator('tr', { hasText: second.code }).locator('.fg-chip', { hasText: shared })).toHaveCount(1);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

/* =========================================================================
 * 5. Báo cáo — lọc / nhóm theo tag (§6.2, §12)
 * ========================================================================= */

test.describe('báo cáo · nhóm và lọc theo tag', () => {
  test('báo cáo "Theo tag" gộp đúng số phiếu và số tiền cho tag', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'report-theo-tag');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Báo cáo tag');
      const tagId = await ensureTagApi(staff, cta, tagName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC báo cáo'));
      // báo cáo chỉ tính phiếu đã gửi duyệt trở đi (nháp không được tính)
      for (const [title, amount] of [[uniq('BC 1'), '150000'], [uniq('BC 2'), '250000']]) {
        const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title, tagIds: [tagId], amountMinor: amount });
        expect((await transitionApi(staff, cta, v.id, 'submit')).status).toBeLessThan(300);
      }

      const data = await reportApi(chief, cta, 'theo-tag', { tag_ids: tagId });
      const rows = (data.rows ?? []) as any[];
      expect(rows.length, 'chỉ một nhóm tag khi lọc theo tag').toBe(1);
      expect(rows[0].tag).toBe(tagName);
      expect(rows[0].documents, 'đếm đúng số phiếu').toBe(2);
      expect(String(rows[0].expense.minor), 'cộng đúng số tiền chi').toBe('400000');

      // Bảng báo cáo phân trang (25 dòng/trang) và kho dữ liệu dùng chung rất lớn: lọc đúng tag này trước rồi mới kiểm dòng.
      await openPage(chief, '/baocao/theo-tag');
      const tagFilter = tagCombo(chief, 'Lọc theo tag');
      await tagFilter.click();
      await tagFilter.pressSequentially(tagName);
      await visibleOption(chief, tagName).click();
      await chief.keyboard.press('Escape');
      const reportRow = chief.locator('table tbody tr', { hasText: tagName });
      await expect(reportRow, 'báo cáo theo tag (đã lọc) hiện đúng một dòng của tag').toHaveCount(1, { timeout: 15_000 });
      await expect(reportRow.getByText(/400\.000\s*₫/).first(), 'cột Chi cộng đúng 400.000 ₫').toBeVisible();
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('bộ lọc tag ở báo cáo gửi tag_ids lên API và bật thông báo "Excel theo đúng bộ lọc"', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'report-filter');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Lọc báo cáo');
      const tagId = await ensureTagApi(staff, cta, tagName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC lọc báo cáo'));
      await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('BC lọc'), tagIds: [tagId] });

      await openPage(chief, '/baocao/theo-tag');
      const filter = tagCombo(chief, 'Lọc theo tag');
      await filter.click();
      await filter.pressSequentially(tagName);
      const reqPromise = chief.waitForRequest((req) => req.url().includes('/api/v1/reports/theo-tag') && req.url().includes(`tag_ids=${tagId}`), { timeout: 15_000 });
      await visibleOption(chief, tagName).click();
      await chief.keyboard.press('Escape');
      await reqPromise;
      await expect(chief.getByText('File Excel theo đúng bộ lọc đang chọn')).toBeVisible();
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('"Toàn tập đoàn": tag cùng tên ở hai công ty được cộng chung trong báo cáo theo tag', async ({ as }) => {
    const staff = await as('staff');
    const chairman = await as('chairman');
    const restore = await useAllScope(chairman);
    try {
      const sharedName = uniq('Chung hai công ty');
      const ctaId = await companyIdOf(staff, COMPANY.CTA);
      const mayId = await companyIdOf(staff, COMPANY.MAYOGU);
      const tagCta = await ensureTagApi(staff, ctaId, sharedName);
      const tagMay = await ensureTagApi(staff, mayId, sharedName);
      expect(tagCta).not.toBe(tagMay);

      const accCta = await firstBankAccountApi(staff, ctaId);
      const accMay = await firstBankAccountApi(staff, mayId);
      const pCta = await createPartnerApi(staff, ctaId, 'supplier', uniq('NCC chung A'));
      const pMay = await createPartnerApi(staff, mayId, 'supplier', uniq('NCC chung M'));
      const va = await createVoucherApi(staff, ctaId, { partnerId: pCta, accountId: accCta, title: uniq('Chung A'), tagIds: [tagCta], amountMinor: '100000' });
      expect((await transitionApi(staff, ctaId, va.id, 'submit')).status).toBeLessThan(300);
      const vm = await createVoucherApi(staff, mayId, { partnerId: pMay, accountId: accMay, title: uniq('Chung M'), tagIds: [tagMay], amountMinor: '200000' });
      expect((await transitionApi(staff, mayId, vm.id, 'submit')).status).toBeLessThan(300);

      const data = await reportApi(chairman, 'all', 'theo-tag');
      const row = (data.rows as any[]).find((r) => r.tag === sharedName);
      expect(row, 'báo cáo hợp nhất có nhóm theo tên tag').toBeTruthy();
      expect(row.company_count, 'gộp hai công ty vào một nhóm').toBe(2);
      expect(row.documents).toBe(2);
      expect(String(row.expense.minor)).toBe('300000');
    } finally {
      await restore();
    }
  });

  test('báo cáo thu-chi theo ngày lọc theo tag (§6.2 "báo cáo thu-chi lọc theo tag"): chỉ cộng phiếu có tag đã chọn', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Thu chi lọc tag');
      const tagId = await ensureTagApi(staff, cta, tagName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC thu chi tag'));
      const tagged1 = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('TC có tag 1'), tagIds: [tagId], amountMinor: '150000' });
      const tagged2 = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('TC có tag 2'), tagIds: [tagId], amountMinor: '250000' });
      const untagged = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('TC không tag'), amountMinor: '999000' });
      for (const v of [tagged1, tagged2, untagged]) {
        expect((await transitionApi(staff, cta, v.id, 'submit')).status, 'gửi duyệt phiếu cho báo cáo').toBeLessThan(300);
      }

      const from = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
      const to = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
      const filtered = await reportApi(chief, cta, 'thu-chi-ngay', { from, to, tag_ids: tagId });
      expect(String(filtered.totals.expense.minor), 'thu-chi lọc theo tag: chỉ cộng hai phiếu có tag').toBe('400000');
      const unfiltered = await reportApi(chief, cta, 'thu-chi-ngay', { from, to });
      expect(BigInt(unfiltered.totals.expense.minor), 'không lọc tag thì phiếu không tag được tính').toBeGreaterThanOrEqual(1_399_000n);
    } finally {
      await restore();
    }
  });
});

/* =========================================================================
 * 6. Dashboard — lọc / nhóm theo tag (§6.2)
 * ========================================================================= */

test.describe('dashboard · lọc / nhóm theo tag', () => {
  test('dashboard: ô lọc theo tag bật khi chọn công ty; chọn tag đưa tag_ids lên URL và API; thẻ "Theo tag" nhóm đúng tag; "Bỏ lọc tag" xoá lọc', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'dashboard');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Dashboard tag');
      const tagId = await ensureTagApi(staff, cta, tagName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC dashboard'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu dashboard tag'), tagIds: [tagId] });
      // thẻ "Theo tag" chỉ tính phiếu đã gửi duyệt trở đi (nháp không được tính)
      expect((await transitionApi(staff, cta, v.id, 'submit')).status, 'gửi duyệt phiếu có tag').toBeLessThan(300);

      await openPage(staff, '/dashboard');
      const filter = tagCombo(staff, 'Lọc theo tag');
      await expect(filter, 'ô lọc tag của dashboard bật khi đã chọn công ty (§6.2)').toBeEnabled({ timeout: 15_000 });
      await expect(staff.locator('.fg-card-title', { hasText: /^Theo tag$/ }), 'thẻ "Theo tag" (nhóm theo tag) hiện').toBeVisible({ timeout: 15_000 });

      const overviewReq = staff.waitForRequest(
        (req) => req.url().includes('/api/v1/dashboard/overview') && req.url().includes(`tag_ids=${tagId}`),
        { timeout: 15_000 },
      );
      const reportReq = staff.waitForRequest(
        (req) => req.url().includes('/api/v1/reports/theo-tag') && req.url().includes(`tag_ids=${tagId}`),
        { timeout: 15_000 },
      );
      await filter.click();
      await filter.pressSequentially(tagName);
      await visibleOption(staff, tagName).click();
      await staff.keyboard.press('Escape');
      await Promise.all([overviewReq, reportReq]);
      await expect(staff).toHaveURL(new RegExp(`tag_ids=${tagId}`));
      await expect(staff.getByText('Số liệu theo phiếu đang lọc theo tag'), 'dashboard báo đang lọc theo tag').toBeVisible();

      const card = staff.locator('.ant-card', { has: staff.locator('.fg-card-title', { hasText: /^Theo tag$/ }) });
      await expect(card.getByText(tagName, { exact: true }), 'thẻ "Theo tag" nhóm đúng theo tag đã chọn').toBeVisible({ timeout: 15_000 });

      await staff.getByRole('button', { name: 'Bỏ lọc tag', exact: true }).click();
      await expect(staff).not.toHaveURL(/tag_ids=/);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

/* =========================================================================
 * 7. Phân quyền — tag:manage (§3.2)
 * ========================================================================= */

test.describe('phân quyền tag', () => {
  test('KTV (không có tag:manage): không thấy mục "Quản lý tag", vào thẳng URL bị đưa về trang tổng quan', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    try {
      await openPage(staff, '/dashboard');
      await expect(staff.getByRole('link', { name: /Quản lý tag/ })).toHaveCount(0);
      await openPage(staff, '/quantri/tags');
      await expect(staff).toHaveURL(/\/dashboard$/, { timeout: 10_000 });
    } finally {
      await restore();
    }
  });

  test('KTV bị từ chối API quản lý: đổi tên / ẩn / gộp; danh sách không lộ tag đã ẩn', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const hidden = uniq('RBAC ẩn');
      const other = uniq('RBAC gộp');
      const hiddenId = await ensureTagApi(chief, cta, hidden);
      const otherId = await ensureTagApi(chief, cta, other);
      await api(chief, 'PATCH', `/tags/${hiddenId}`, { scope: cta, data: { hidden: true } });

      const rename = await api(staff, 'PATCH', `/tags/${otherId}`, { scope: cta, data: { name: uniq('Đổi trái phép') } });
      expect(rename.status).toBe(403);
      const hide = await api(staff, 'PATCH', `/tags/${otherId}`, { scope: cta, data: { hidden: true } });
      expect(hide.status).toBe(403);
      const merge = await api(staff, 'POST', '/tags/merge', { scope: cta, data: { source_id: otherId, target_id: hiddenId } });
      expect(merge.status).toBe(403);

      // Danh bạ CTA có > 500 tag và GET /tags không q chỉ trả 500 dòng đầu theo tên: tìm đúng tên của tag
      // (q) để kết quả không phụ thuộc vị trí tag trong danh bạ.
      const idsFor = async (page: import('@playwright/test').Page, name: string): Promise<string[]> => {
        const r = await api<{ items: any[] }>(page, 'GET', '/tags', {
          scope: cta,
          query: { company_id: cta, scope: cta, include_hidden: 'true', limit: 500, q: name },
        });
        expect(r.status).toBe(200);
        return (r.body.items ?? []).map((t: any) => t._id);
      };
      // đối chứng: KTT (có tag:manage) tìm đúng tên thì THẤY tag ẩn — nên việc KTV không thấy là do quyền, không do truy vấn
      expect(await idsFor(chief, hidden), 'tiền đề: KTT thấy tag ẩn khi tìm đúng tên').toContain(hiddenId);
      expect(await idsFor(staff, hidden), 'KTV không thấy tag đã ẩn trong danh bạ').not.toContain(hiddenId);
      expect(await idsFor(staff, other), 'KTV vẫn thấy tag đang dùng').toContain(otherId);
    } finally {
      await restore();
    }
  });

  test('KTT (có tag:manage): thấy mục "Quản lý tag" trên thanh điều hướng', async ({ as }) => {
    const chief = await as('chief');
    await openPage(chief, '/dashboard');
    await expect(chief.getByRole('link', { name: /Quản lý tag/ })).toBeVisible({ timeout: 10_000 });
  });
});

/* =========================================================================
 * 8. Chuẩn hoá và cách ly công ty (hợp đồng API)
 * ========================================================================= */

test.describe('hợp đồng tag (API)', () => {
  test('chuẩn hoá tên: bỏ khoảng trắng thừa, không phân biệt hoa thường, giữ dấu; tên quá dài / rỗng bị từ chối', async ({ as }) => {
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const base = uniq('Chuẩn hóa API');
      const first = await createTagApi(chief, cta, `  ${base.replace(/ /g, '   ')}  `);
      expect(first.status).toBe(201);
      const firstId = dataOf<any>(first)._id;
      expect(dataOf<any>(first).name, 'tên lưu đã gộp khoảng trắng').toBe(base);

      const again = await createTagApi(chief, cta, base.toLowerCase().toUpperCase().replace(/\s+/g, ' '));
      expect(again.status, 'trùng tên khác hoa/thường → trả tag cũ (200)').toBe(200);
      expect(again.body.created).toBe(false);
      expect(dataOf<any>(again)._id).toBe(firstId);

      const zw = await createTagApi(chief, cta, `​${base}‍`);
      expect(zw.status, 'ký tự vô hình bị bỏ, vẫn trùng').toBe(200);

      const diacritic = await createTagApi(chief, cta, base.normalize('NFD').replace(/[̀-ͯ]/g, ''));
      expect(diacritic.status, 'bỏ dấu tạo tên khác (không trùng)').toBe(201);

      const empty = await createTagApi(chief, cta, '   ');
      expect(empty.status).toBe(422);
      const long = await createTagApi(chief, cta, 'x'.repeat(41));
      expect(long.status).toBe(422);
    } finally {
      await restore();
    }
  });

  test('tag không dùng chung giữa các công ty: không gắn được tag công ty khác vào phiếu', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const may = await companyIdOf(staff, COMPANY.MAYOGU);
      const foreignTag = await ensureTagApi(staff, cta, uniq('Tag CTA riêng'));
      const acc = await firstBankAccountApi(staff, may);
      const partnerId = await createPartnerApi(staff, may, 'supplier', uniq('NCC MAYOGU'));
      const r = await api(staff, 'POST', '/documents', {
        scope: may,
        data: {
          kind: 'spend',
          company_id: may,
          title: uniq('Phiếu khác công ty'),
          purpose: 'Kiểm thử cách ly tag giữa công ty',
          partner_id: partnerId,
          amount: { amount_minor: '1000', currency: 'VND' },
          source: { fund: 'bank', account_id: acc, group_managed: false },
          planned_date: '2026-12-30T10:00',
          priority: 'normal',
          tag_ids: [foreignTag],
        },
      });
      expect(r.status, 'tag thuộc CTA không gắn được cho phiếu MAYOGU').toBe(422);
      expect(r.body?.code).toBe('FG-VAL-001');
    } finally {
      await restore();
    }
  });
});

/* =========================================================================
 * 10. Phần bổ sung (round 4): phiếu thu có tag · tìm toàn cục theo tag · GĐ lọc tổng chi theo tag (US-VOU-03) ·
 *     xuất Excel đúng bộ lọc tag. Mọi dữ liệu dùng uniq(); không phụ thuộc số liệu toàn cục.
 * ========================================================================= */

test.describe('phạm vi · đổi công ty khi đang lọc theo tag (§6.2 tag không dùng chung giữa công ty)', () => {
  test('đang lọc báo cáo theo tag của CTA, đổi sang MAYOGU: bộ lọc tag cũ được bỏ, không gửi tag của CTA cho MAYOGU', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'scope-switch-tag');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Tag CTA đổi phạm vi');
      const tagId = await ensureTagApi(staff, cta, tagName);

      await openPage(chief, '/baocao/theo-tag');
      const filter = tagCombo(chief, 'Lọc theo tag');
      await filter.click();
      await filter.pressSequentially(tagName);
      await visibleOption(chief, tagName).click();
      await chief.keyboard.press('Escape');
      await settle(chief);

      const sent: string[] = [];
      chief.on('request', (req) => {
        if (req.url().includes('/api/v1/reports/theo-tag')) sent.push(req.url());
      });
      await chief.getByRole('button', { name: 'Phạm vi dữ liệu', exact: true }).click();
      await chief.getByRole('menuitem', { name: /MAYOGU/ }).click();
      await settle(chief);

      await expect(chief.getByRole('button', { name: 'Phạm vi dữ liệu', exact: true })).toContainText('MAYOGU', { timeout: 10_000 });
      expect(sent.length, 'đổi công ty tải lại báo cáo').toBeGreaterThan(0);
      expect(
        sent.filter((u) => u.includes(`tag_ids=${tagId}`)),
        'báo cáo của MAYOGU không được lọc bằng tag của CTA (tag không dùng chung giữa công ty)',
      ).toEqual([]);
      await expect(chief.locator('.fg-chip', { hasText: 'Tag không còn tồn tại' }), 'không còn chip tag mồ côi trong ô lọc').toHaveCount(0);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('danh sách Chi đang lọc theo tag của CTA, đổi sang MAYOGU: danh sách không gửi tag của CTA', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'scope-switch-tag-list');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Tag CTA DS');
      const tagId = await ensureTagApi(staff, cta, tagName);

      await openPage(chief, '/chi');
      const filter = tagCombo(chief, 'Lọc theo tag');
      const listed = tagRequestsDone(chief, tagId, ['/api/v1/documents']);
      await filter.click();
      await filter.pressSequentially(tagName);
      await visibleOption(chief, tagName).click();
      await chief.keyboard.press('Escape');
      await listed;
      await settle(chief);

      const sent: string[] = [];
      chief.on('request', (req) => {
        if (req.url().includes('/api/v1/documents')) sent.push(req.url());
      });
      await chief.getByRole('button', { name: 'Phạm vi dữ liệu', exact: true }).click();
      await chief.getByRole('menuitem', { name: /MAYOGU/ }).click();
      await settle(chief);

      await expect(chief.getByRole('button', { name: 'Phạm vi dữ liệu', exact: true })).toContainText('MAYOGU', { timeout: 10_000 });
      expect(sent.length, 'đổi công ty tải lại danh sách phiếu').toBeGreaterThan(0);
      expect(
        sent.filter((u) => u.includes(`tag_ids=${tagId}`)),
        'danh sách MAYOGU không được lọc bằng tag của CTA (tag không dùng chung giữa công ty)',
      ).toEqual([]);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('dashboard đang lọc theo tag của CTA, đổi sang MAYOGU: số liệu MAYOGU không được lọc bằng tag của CTA', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'scope-switch-tag-dashboard');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Tag CTA DB');
      const tagId = await ensureTagApi(staff, cta, tagName);

      await openPage(chief, '/dashboard');
      const filter = tagCombo(chief, 'Lọc theo tag');
      await expect(filter).toBeEnabled({ timeout: 15_000 });
      const listed = tagRequestsDone(chief, tagId, ['/api/v1/dashboard/overview', '/api/v1/reports/thu-chi-ngay', '/api/v1/reports/theo-tag']);
      await filter.click();
      await filter.pressSequentially(tagName);
      await visibleOption(chief, tagName).click();
      await chief.keyboard.press('Escape');
      await listed;
      await settle(chief);

      const sent: string[] = [];
      chief.on('request', (req) => {
        if (req.url().includes('/api/v1/dashboard/') || req.url().includes('/api/v1/reports/')) sent.push(req.url());
      });
      await chief.getByRole('button', { name: 'Phạm vi dữ liệu', exact: true }).click();
      await chief.getByRole('menuitem', { name: /MAYOGU/ }).click();
      await settle(chief);

      await expect(chief.getByRole('button', { name: 'Phạm vi dữ liệu', exact: true })).toContainText('MAYOGU', { timeout: 10_000 });
      expect(sent.length, 'đổi công ty tải lại số liệu dashboard').toBeGreaterThan(0);
      expect(
        sent.filter((u) => u.includes(`tag_ids=${tagId}`)),
        'số liệu MAYOGU không được lọc bằng tag của CTA (tag không dùng chung giữa công ty)',
      ).toEqual([]);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

test.describe('phiếu thu · gắn tag (§6.2 áp dụng cho phiếu thu và phiếu chi)', () => {
  test('KTV lập phiếu thu: chọn tag có sẵn, tạo tag mới trong ô Tag, lưu nháp; phiếu thu giữ đủ tag và lọc được ở danh sách Thu', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'income-tags');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const existing = uniq('Thu có sẵn');
      const existingId = await ensureTagApi(staff, cta, existing);
      const newTag = uniq('Thu tạo mới');
      const customer = uniq('KH phiếu thu');
      await createPartnerApi(staff, cta, 'customer', customer);
      const purpose = uniq('Thu tiền kiểm thử');

      await openPage(staff, '/thu/moi');
      await staff.getByPlaceholder(/Thanh toán đợt 2/).fill(purpose);
      const partnerBox = staff.locator('.ant-select', { hasText: 'Tìm khách hàng' }).locator('input').first();
      await partnerBox.click();
      await partnerBox.pressSequentially(customer);
      await visibleOption(staff, customer).click();

      await fieldInput(staff, 'Số tiền *').fill('250000');
      await fieldInput(staff, 'Số tiền *').press('Tab');
      const deadline = fieldInput(staff, 'Hạn thanh toán (deadline) *');
      await deadline.click();
      await deadline.fill('30/12/2026 10:00');
      await deadline.press('Enter');
      await staff.locator('.ant-select', { hasText: 'Chọn tài khoản ngân hàng' }).first().click();
      await visibleOption(staff, '').first().click();

      const box = tagCombo(staff, VOUCHER_TAG_LABEL);
      await pickExistingTag(staff, box, existing, existing);
      await expect(staff.locator('.fg-chip', { hasText: existing })).toHaveCount(1, { timeout: 10_000 });
      await box.click();
      await box.pressSequentially(newTag);
      await visibleOption(staff, '+ Tạo tag').click();
      await expect(staff.locator('.fg-chip', { hasText: newTag })).toBeVisible({ timeout: 10_000 });
      await staff.keyboard.press('Escape');

      await staff.getByRole('button', { name: 'Lưu nháp', exact: true }).click();
      await staff.waitForURL(/\/ho-so\/thu\/[0-9a-f]{24}/, { timeout: 20_000 });
      const id = staff.url().split('/').pop()!;
      const doc = await getDocApi(staff, cta, id);
      expect(doc.kind, 'phiếu lập từ /thu/moi là phiếu thu').toBe('income');
      expect(doc.tag_ids?.length, 'phiếu thu có đủ hai tag').toBe(2);
      expect(doc.tag_ids, 'phiếu thu giữ tag có sẵn').toContain(existingId);
      expect((doc.tags ?? []).map((t: any) => t.name), 'phiếu thu giữ tag vừa tạo').toContain(newTag);

      await openPage(staff, '/thu');
      const filter = tagCombo(staff, 'Lọc theo tag');
      await filter.click();
      await filter.pressSequentially(newTag);
      await visibleOption(staff, newTag).click();
      await staff.keyboard.press('Escape');
      await expect(staff.locator('tr', { hasText: doc.code }), 'danh sách Thu lọc đúng phiếu theo tag').toHaveCount(1, { timeout: 15_000 });
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

test.describe('tìm kiếm toàn cục · theo tag (§12)', () => {
  test('gõ tên tag vào ô "Tìm kiếm toàn cục" → kết quả hiện các phiếu gắn tag đó, không hiện phiếu không gắn', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'global-search-tag');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Tìm toàn cục');
      const tagId = await ensureTagApi(staff, cta, tagName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC tìm toàn cục'));
      const hit = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu tìm toàn cục'), tagIds: [tagId] });
      const miss = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu tìm toàn cục không tag') });

      await openPage(staff, '/dashboard');
      const search = staff.getByRole('searchbox', { name: 'Tìm kiếm toàn cục', exact: true });
      await search.fill(tagName);
      await search.press('Enter');
      await staff.waitForURL(/\/tim-kiem\?q=/, { timeout: 10_000 });
      await settle(staff);
      await expect(staff.getByRole('link', { name: hit.code, exact: true }), 'kết quả tìm theo tag có phiếu gắn tag').toBeVisible({ timeout: 15_000 });
      await expect(staff.getByRole('link', { name: miss.code, exact: true }), 'phiếu không gắn tag không xuất hiện trong kết quả').toHaveCount(0);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

test.describe('GĐ · US-VOU-03 lọc tổng chi theo tag', () => {
  test('GĐ (không có tag:manage) lọc báo cáo thu-chi theo tag: tổng chi chỉ cộng các phiếu có tag đã chọn', async ({ as }) => {
    const staff = await as('staff');
    const director = await as('director');
    const restore = await useCompanyScope(director, COMPANY.CTA);
    const watch = watchPage(director, 'us-vou-03-director');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Dự án X GĐ');
      const tagId = await ensureTagApi(staff, cta, tagName);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC GĐ tag'));
      const plan: [string, string, boolean][] = [
        [uniq('GĐ chi có tag 1'), '120000', true],
        [uniq('GĐ chi có tag 2'), '80000', true],
        [uniq('GĐ chi không tag'), '999000', false],
      ];
      for (const [title, amount, tagged] of plan) {
        const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title, amountMinor: amount, tagIds: tagged ? [tagId] : [] });
        expect((await transitionApi(staff, cta, v.id, 'submit')).status, 'gửi duyệt phiếu chi').toBeLessThan(300);
      }

      const data = await reportApi(director, cta, 'thu-chi-ngay', { tag_ids: tagId });
      expect(String(data.totals.expense.minor), 'API: tổng chi theo tag chỉ cộng hai phiếu có tag').toBe('200000');

      await openPage(director, '/baocao/thu-chi-ngay');
      const filter = tagCombo(director, 'Lọc theo tag');
      await filter.click();
      await filter.pressSequentially(tagName);
      const reqPromise = director.waitForRequest(
        (req) => req.url().includes('/api/v1/reports/thu-chi-ngay') && req.url().includes(`tag_ids=${tagId}`),
        { timeout: 15_000 },
      );
      await visibleOption(director, tagName).click();
      await director.keyboard.press('Escape');
      await reqPromise;
      await settle(director);
      await expect(director.getByText('Tổng chi', { exact: true }).first(), 'KPI "Tổng chi" hiện trên báo cáo').toBeVisible({ timeout: 15_000 });
      await expect(director.getByText(/200\.000\s*₫/).first(), 'UI: tổng chi đã lọc theo tag = 200.000 ₫ (không cộng phiếu không tag)').toBeVisible({ timeout: 15_000 });
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

test.describe('báo cáo · xuất Excel theo bộ lọc tag', () => {
  test('bấm "Xuất Excel" khi đang lọc theo tag: yêu cầu POST /exports mang đúng tag_ids và preset', async ({ as }) => {
    const staff = await as('staff');
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'report-export-tag');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const tagName = uniq('Xuất Excel tag');
      const tagId = await ensureTagApi(staff, cta, tagName);

      await openPage(chief, '/baocao/theo-tag');
      const filter = tagCombo(chief, 'Lọc theo tag');
      await filter.click();
      await filter.pressSequentially(tagName);
      await visibleOption(chief, tagName).click();
      await chief.keyboard.press('Escape');
      await settle(chief);

      const exportReq = chief.waitForRequest(
        (req) => req.method() === 'POST' && new URL(req.url()).pathname === '/api/v1/exports',
        { timeout: 15_000 },
      );
      await chief.getByRole('button', { name: /Xuất Excel/ }).click();
      const body = (await exportReq).postDataJSON() as { preset?: string; query?: { tag_ids?: string } };
      expect(body.preset, 'xuất đúng báo cáo "Theo tag"').toBe('theo-tag');
      expect(body.query?.tag_ids, 'file Excel gửi đúng tag đang lọc (file khớp màn hình)').toBe(tagId);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

/* =========================================================================
 * 9. Audit log toàn hệ thống (ADM-12) — nhãn cho thao tác tag (§13 Tag; §13 audit log)
 * ========================================================================= */

/**
 * Mã kỹ thuật thô (vd `tag.hide`, `approve`, `document.create`, `migrate_v2`): chữ thường, chữ số, `_` và `.`,
 * không dấu cách. (Bản cũ thiếu chữ số nên bỏ sót `migrate_v2`.)
 */
const RAW_AUDIT_CODE = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/**
 * Các dòng Audit log (ADM-12) chứa `name` trong cột Đối tượng, lật tối đa `maxPages` trang (mới nhất trước).
 * Round 5: không dựa vào networkidle (có lúc trả về trước khi bảng trang mới tải, nên bỏ sót trang đang tìm
 * khi nhiều phiên cùng ghi audit). Sau mỗi lần bấm "Sau →" chờ đúng phản hồi GET /audit-log?page=n rồi chữ "Trang n"
 * (react-query giữ dữ liệu trang cũ làm placeholder nên chờ chữ "Trang n" một mình là chưa đủ).
 */
async function findAdminAuditRows(page: import('@playwright/test').Page, name: string, maxPages = 8): Promise<import('@playwright/test').Locator> {
  const rows = page.locator('.ant-table-tbody tr.ant-table-row', { hasText: name });
  const next = page.getByRole('button', { name: 'Sau →', exact: true });
  for (let p = 1; p <= maxPages; p++) {
    await expect(page.locator('.ant-table-tbody tr.ant-table-row').first(), `Audit log trang ${p} đã tải`).toBeVisible({ timeout: 15_000 });
    if ((await rows.count()) > 0) break;
    await expect(next, 'nút "Sau →" hiện').toBeVisible({ timeout: 10_000 });
    if (await next.isDisabled()) break;
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.request().method() === 'GET' && r.url().includes('/api/v1/audit-log') && new URL(r.url()).searchParams.get('page') === String(p + 1),
        { timeout: 15_000 },
      ),
      next.click(),
    ]);
    expect(res.status(), 'GET /audit-log trang kế tiếp').toBe(200);
    await expect(page.getByText(`Trang ${p + 1}`, { exact: true })).toBeVisible({ timeout: 15_000 });
  }
  return rows;
}

/** Cột "Hành động" (cột thứ 3) của mỗi dòng trong bảng Audit log. */
async function auditActionCells(rows: import('@playwright/test').Locator): Promise<string[]> {
  const out: string[] = [];
  for (const r of await rows.all()) out.push((await r.locator('td').nth(2).innerText()).trim());
  return out;
}

test.describe('ADM-12 · Audit log hiển thị nhãn cho thao tác tag', () => {
  test('KTT tạo, ẩn rồi hiện lại tag: các dòng Audit log của tag có nhãn tiếng Việt, không hiện tag.hide / tag.unhide', async ({ as }) => {
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'admin-audit-tag');
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const name = uniq('Audit nhãn tag');
      const id = await ensureTagApi(chief, cta, name);
      expect((await api(chief, 'PATCH', `/tags/${id}`, { scope: cta, data: { hidden: true } })).status, 'KTT ẩn tag không dùng').toBe(200);
      expect((await api(chief, 'PATCH', `/tags/${id}`, { scope: cta, data: { hidden: false } })).status, 'KTT hiện lại tag').toBe(200);

      await openPage(chief, '/quantri/audit');
      const rows = await findAdminAuditRows(chief, name);
      // dòng tạo + dòng ẩn + dòng hiện lại (ít nhất ba)
      await expect(rows.first(), 'Audit log có dòng của tag vừa thao tác').toBeVisible({ timeout: 15_000 });
      expect(await rows.count(), 'Audit log có đủ dòng tạo / ẩn / hiện lại của tag').toBeGreaterThanOrEqual(3);
      const actions = await auditActionCells(rows);
      console.log(`[admin-audit] nhãn hành động của tag: ${JSON.stringify(actions)}`);
      for (const a of actions) {
        expect(a, `Audit log hiện mã kỹ thuật "${a}" thay vì nhãn tiếng Việt`).not.toMatch(RAW_AUDIT_CODE);
      }
      // nhãn cụ thể của từng thao tác (tag.create / tag.hide / tag.unhide)
      for (const label of ['Tạo tag', 'Ẩn tag', 'Hiện lại tag']) {
        expect(actions, `Audit log có nhãn "${label}" cho thao tác tag`).toContain(label);
      }
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('Audit log (trang 1) không hiện mã kỹ thuật ở cột Hành động (tag.*, document.*, approve, submit)', async ({ as }) => {
    const chief = await as('chief');
    await openPage(chief, '/quantri/audit');
    // networkidle có thể trả về trước khi bảng vẽ xong: chờ dòng đầu tiên rồi mới đọc cột Hành động
    await expect(chief.locator('.ant-table-tbody tr.ant-table-row').first(), 'Audit log đã tải dòng đầu tiên').toBeVisible({ timeout: 15_000 });
    const cells = await auditActionCells(chief.locator('.ant-table-tbody tr.ant-table-row'));
    expect(cells.length, 'Audit log có dữ liệu').toBeGreaterThan(0);
    const raw = [...new Set(cells.filter((c) => RAW_AUDIT_CODE.test(c)))];
    console.log(`[admin-audit] mã thô còn hiện ở trang 1: ${JSON.stringify(raw)}`);
    expect(raw, 'Audit log không hiện mã kỹ thuật thay vì nhãn').toEqual([]);
  });

  test('ADM-12 · ngừng rồi kích hoạt lại đối tác: dòng partner.deactivate / partner.reactivate không hiện mã thô', async ({ as }) => {
    const chief = await as('chief');
    const staff = await as('staff');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'admin-audit-partner');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const created = await api(staff, 'POST', '/partners', {
        scope: cta,
        data: { company_id: cta, type: 'supplier', name: uniq('Audit đối tác'), status: 'active' },
      });
      expect(created.status, 'tạo đối tác thử').toBeLessThan(300);
      const partner = dataOf<any>(created).partner ?? dataOf<any>(created);
      const partnerId = String(partner._id);
      const code = String(partner.code ?? '');
      expect(code, 'đối tác có mã để đối chiếu dòng Audit log').not.toBe('');
      expect((await api(staff, 'POST', `/partners/${partnerId}/deactivate`, { scope: cta, data: {} })).status, 'ngừng giao dịch đối tác').toBe(200);
      expect((await api(staff, 'POST', `/partners/${partnerId}/reactivate`, { scope: cta, data: {} })).status, 'kích hoạt lại đối tác').toBe(200);

      await openPage(chief, '/quantri/audit');
      const rows = await findAdminAuditRows(chief, `partner · ${code}`);
      await expect(rows.first(), 'Audit log có dòng của đối tác vừa thao tác').toBeVisible({ timeout: 15_000 });
      const actions = await auditActionCells(rows);
      console.log(`[admin-audit] nhãn hành động của đối tác ${code}: ${JSON.stringify(actions)}`);
      for (const a of actions) {
        expect(a, `Audit log hiện mã kỹ thuật "${a}" thay vì nhãn tiếng Việt (đối tác)`).not.toMatch(RAW_AUDIT_CODE);
      }
      // nhãn đúng của từng thao tác (partner.create / partner.deactivate / partner.reactivate — routes/partners.ts)
      for (const label of ['Tạo đối tác', 'Ngừng giao dịch đối tác', 'Kích hoạt lại đối tác']) {
        expect(actions, `Audit log có nhãn "${label}" cho đối tác vừa thao tác`).toContain(label);
      }
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('ADM-12 · dòng "Sửa tag phiếu": cột "Trường thay đổi" nêu tên tag, không hiện id thô (ObjectId)', async ({ as }) => {
    const chief = await as('chief');
    const staff = await as('staff');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'admin-audit-tag-diff');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const name = uniq('ADM diff tag');
      const tagId = await ensureTagApi(staff, cta, name);
      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC ADM diff'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu ADM diff') });
      expect((await setDocTagsApi(staff, cta, v.id, [tagId])).status, 'KTV gắn tag cho phiếu').toBe(200);

      await openPage(chief, '/quantri/audit');
      const rows = (await findAdminAuditRows(chief, v.code)).filter({ hasText: 'Sửa tag phiếu' });
      await expect(rows.first(), 'Audit log có dòng "Sửa tag phiếu" của phiếu vừa sửa').toBeVisible({ timeout: 15_000 });
      const diffCell = (await rows.first().locator('td').nth(4).innerText()).trim();
      console.log(`[admin-audit] cột Trường thay đổi của dòng sửa tag: ${JSON.stringify(diffCell)}`);
      expect(diffCell, 'cột "Trường thay đổi" không hiện id thô (ObjectId) của tag').not.toMatch(/[0-9a-f]{24}/);
      expect(diffCell, 'cột "Trường thay đổi" nêu tên tag được thêm').toContain(name);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('ADM-12 · mã cũ / chưa có nhãn (auth.2fa_enable, counterparty.create|delete, document.auto_income) hiện nhãn tiếng Việt', async ({ as }) => {
    const chief = await as('chief');
    const watch = watchPage(chief, 'admin-audit-legacy');
    // Các dòng này trong audit_log nằm rất sâu (hàng trăm trang; auth.2fa_enable chưa có dòng nào), nên tiêm vài
    // dòng mẫu lên đầu phản hồi GET /audit-log (trang 1): kiểm tra đúng nhãn mà màn hình hiển thị cho từng mã.
    const samples = [
      { action: 'auth.2fa_enable', type: 'user', code: 'Kiểm thử 2FA', label: 'Bật xác thực 2 lớp' },
      { action: 'counterparty.create', type: 'counterparty', code: 'Kiểm thử đối tác cũ', label: 'Tạo đối tác' },
      { action: 'counterparty.delete', type: 'counterparty', code: 'Kiểm thử xoá đối tác cũ', label: 'Xoá đối tác' },
      { action: 'document.auto_income', type: 'income', code: 'Kiểm thử phiếu thu tự động', label: 'Tự động tạo phiếu thu' },
    ];
    await chief.route('**/api/v1/audit-log**', async (route) => {
      const res = await route.fetch();
      const json = await res.json();
      const payload = json.data ?? json;
      const at = new Date().toISOString();
      payload.items = [
        ...samples.map((s, i) => ({
          _id: `stub-audit-${i}`,
          at,
          actor: { user_id: null, name: 'Kiểm thử', role: 'chief_accountant' },
          action: s.action,
          subject: { type: s.type, id: null, code: s.code },
          company_id: null,
          company_name: null,
          diff_fields: [],
          ip: null,
          ua: null,
          request_id: null,
        })),
        ...(payload.items ?? []),
      ];
      await route.fulfill({ response: res, json });
    });
    try {
      await openPage(chief, '/quantri/audit');
      for (const s of samples) {
        const row = chief.locator('.ant-table-tbody tr.ant-table-row', { hasText: s.code });
        await expect(row, `Audit log hiển thị dòng ${s.action}`).toHaveCount(1, { timeout: 15_000 });
        const cell = (await row.locator('td').nth(2).innerText()).trim();
        expect(cell, `mã ${s.action} hiện nhãn tiếng Việt, không hiện mã thô`).toBe(s.label);
      }
      expectNoAppCrash(watch);
    } finally {
      await chief.unroute('**/api/v1/audit-log**');
    }
  });

  test('tab Audit log của phiếu: lịch sử migrate từ v1 (migrate_v2) có nhãn tiếng Việt, không hiện mã thô', async ({ as }) => {
    const chairman = await as('chairman');
    const restore = await useAllScope(chairman);
    const watch = watchPage(chairman, 'doc-audit-migrate');
    try {
      // phiếu chuyển từ v1 là phiếu cũ nhất: quét theo ngày tạo tăng dần (tối đa 60 phiếu)
      const list = await api<any>(chairman, 'GET', '/documents', { query: { sort: '+created_at', limit: 60 } });
      expect(list.status, 'GET /documents sắp theo ngày tạo tăng dần').toBe(200);
      let target: { id: string; kind: string; migrated: boolean } | null = null;
      for (const item of (list.body?.items ?? []) as any[]) {
        const doc = await getDocApi(chairman, 'all', String(item._id));
        const hist: any[] = doc.history ?? [];
        if (hist.some((h) => h.action === 'migrate_v2')) {
          target = { id: String(item._id), kind: String(doc.kind), migrated: true };
          break;
        }
        if (!target && hist.length) target = { id: String(item._id), kind: String(doc.kind), migrated: false };
      }
      expect(target, 'có phiếu có lịch sử để kiểm tra tab Audit log').toBeTruthy();
      const t = target!;
      console.log(`[doc-audit] phiếu ${t.id} (có lịch sử migrate_v2: ${t.migrated})`);
      const loai = ({ spend: 'chi', income: 'thu', rollover: 'dao-han', internal: 'noi-bo' } as Record<string, string>)[t.kind] ?? 'chi';
      await openPage(chairman, `/ho-so/${loai}/${t.id}`);
      await chairman.getByRole('tab', { name: /Audit log/ }).click();
      const auditTable = chairman.locator('.ant-table').filter({ has: chairman.getByRole('columnheader', { name: 'Hành động', exact: true }) });
      await expect(auditTable, 'bảng Audit log của phiếu (cột Hành động)').toHaveCount(1);
      const auditRows = auditTable.locator('.ant-table-tbody tr.ant-table-row');
      await expect(auditRows.first()).toBeVisible({ timeout: 10_000 });
      const cells: string[] = [];
      for (const r of await auditRows.all()) cells.push((await r.locator('td').nth(2).innerText()).trim());
      console.log(`[doc-audit] nhãn hành động: ${JSON.stringify([...new Set(cells)])}`);
      expect(cells.filter((c) => RAW_AUDIT_CODE.test(c)), 'Audit log của phiếu không hiện mã thô (kể cả migrate_v2)').toEqual([]);
      if (t.migrated) {
        expect(await auditRows.filter({ hasText: 'Chuyển dữ liệu từ v1' }).count(), 'mục migrate hiện nhãn "Chuyển dữ liệu từ v1"').toBeGreaterThan(0);
      }
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

/* =========================================================================
 * 11. Vòng 5 (retest) — kiểm lại các bug đã báo cáo: danh bạ > 500 tag · diff {trước, sau} của ADM-12 ·
 *     nhãn lịch sử khoản vay ngân hàng / công nợ. (Bộ lọc khi đổi công ty: mục 10.)
 * ========================================================================= */

/** Ngày ISO (YYYY-MM-DD) cách hôm nay `days` ngày. */
const isoDay = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Tên bắt đầu bằng "ỹ" (U+1EF9). name_key được sắp theo byte UTF-8 nên tag này xếp CUỐI danh bạ công ty
 * (đã kiểm trước khi viết test: CTA có > 500 tag và không tag nào xếp sau "ỹ"), tức nằm ngoài 500 dòng đầu.
 */
const LAST_IN_DIRECTORY = 'ỹ';

/** Cột "Thao tác" (cột thứ 3) của thẻ "Lịch sử thay đổi" trên màn khoản vay ngân hàng / công nợ. */
async function historyActionTexts(page: import('@playwright/test').Page): Promise<string[]> {
  const card = page.getByText('Lịch sử thay đổi', { exact: true }).first().locator('xpath=ancestor::*[.//table][1]');
  const rows = card.locator('.ant-table-tbody tr.ant-table-row');
  await expect(rows.first(), 'thẻ "Lịch sử thay đổi" có dòng').toBeVisible({ timeout: 15_000 });
  const out: string[] = [];
  for (const r of await rows.all()) out.push((await r.locator('td').nth(2).innerText()).trim());
  return out;
}

/**
 * Nhãn mong đợi của từng mã lịch sử KHOẢN CÔNG NỢ (đúng bảng DEBT_HISTORY_ACTION_LABEL,
 * apps/web/src/components/labels.ts). Mã v1 link_document / unlink_document (cấn trừ phiếu) là bug vòng 5.
 */
const DEBT_HISTORY_LABEL: Record<string, string> = {
  create: 'Tạo khoản công nợ',
  update: 'Sửa khoản công nợ',
  attachment_add: 'Thêm chứng từ',
  link_document: 'Cấn trừ phiếu',
  unlink_document: 'Gỡ cấn trừ phiếu',
  migrate_v2: 'Chuyển dữ liệu từ v1',
};

test.describe('danh bạ > 500 tag · tag ngoài 500 dòng đầu (round 5)', () => {
  test('gợi ý và bộ lọc: tag cuối danh bạ hiện đúng tên, không đề nghị "+ Tạo tag" cho tên đã có', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'directory-500-suggest');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const name = uniq(`${LAST_IN_DIRECTORY} Tag cuối DS`);
      const tagId = await ensureTagApi(staff, cta, name);
      // tiền đề: danh bạ có > 500 tag và tag vừa tạo nằm ngoài 500 dòng đầu khi GET /tags không có q (cách UI cũ tải)
      const head = await api<{ items: any[]; total: number }>(staff, 'GET', '/tags', {
        scope: cta,
        query: { company_id: cta, scope: cta, include_hidden: 'true', limit: 500 },
      });
      expect(head.status).toBe(200);
      expect(head.body.total, 'tiền đề: danh bạ CTA có > 500 tag').toBeGreaterThan(500);
      expect((head.body.items ?? []).map((t: any) => t._id), 'tiền đề: tag nằm ngoài 500 dòng đầu').not.toContain(tagId);

      const acc = await firstBankAccountApi(staff, cta);
      const partnerId = await createPartnerApi(staff, cta, 'supplier', uniq('NCC cuối DS'));
      const v = await createVoucherApi(staff, cta, { partnerId, accountId: acc, title: uniq('Phiếu cuối DS') });

      // ô Tag của phiếu: gõ đúng tên → có gợi ý tag đó, KHÔNG có dòng "+ Tạo tag"
      await openPage(staff, `/chi/${v.id}/sua`);
      const box = tagCombo(staff, VOUCHER_TAG_LABEL);
      await box.click();
      await box.pressSequentially(name);
      await expect(visibleOption(staff, name), 'gợi ý hiện tag ngoài 500 dòng đầu').toBeVisible({ timeout: 10_000 });
      await expect(visibleOption(staff, '+ Tạo tag'), 'không đề nghị tạo tag trùng tên đã có').toHaveCount(0);
      await visibleOption(staff, name).click();
      await staff.keyboard.press('Escape');
      await expect(staff.locator('.fg-chip', { hasText: name }), 'chip hiện đúng tên tag').toHaveCount(1);
      await expect(staff.locator('.fg-chip', { hasText: 'Tag không còn tồn tại' })).toHaveCount(0);

      // bộ lọc tag ở danh sách Chi: chip của tag ngoài 500 dòng đầu hiện đúng tên
      await openPage(staff, `/chi?tag_ids=${tagId}`);
      const filterBox = staff.locator('.ant-select', { has: tagCombo(staff, 'Lọc theo tag') });
      // antd đặt thêm một bản đo ẩn (opacity 0) trong ".ant-select-content-item-rest" với nhãn mặc định: không tính vào chip hiển thị
      const shownChips = filterBox.locator('xpath=.//span[contains(@class,"fg-chip")][not(ancestor::*[contains(@class,"ant-select-content-item-rest")])]');
      await expect(shownChips, 'bộ lọc hiện đúng một chip').toHaveCount(1, { timeout: 15_000 });
      await expect(shownChips.first(), 'chip hiện đúng tên tag ngoài 500 dòng đầu').toContainText(name);
      await expect(shownChips.filter({ hasText: 'Tag không còn tồn tại' })).toHaveCount(0);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('KTT tìm, sửa tên và ẩn tag cuối danh bạ trên màn Quản lý tag', async ({ as }) => {
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'directory-500-manage');
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const oldName = uniq(`${LAST_IN_DIRECTORY} Quản lý cuối DS`);
      const newName = uniq(`${LAST_IN_DIRECTORY} Đổi tên cuối DS`);
      await ensureTagApi(chief, cta, oldName);

      await openPage(chief, '/quantri/tags');
      await chief.getByRole('textbox', { name: 'Tìm tag theo tên', exact: true }).fill(oldName);
      await chief.getByRole('button', { name: `Sửa tag ${oldName}`, exact: true }).click();
      const dialog = chief.getByRole('dialog');
      await dialog.getByLabel('Tên tag').fill(newName);
      await dialog.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
      await expect(toast(chief, 'Đã lưu tag')).toBeVisible({ timeout: 10_000 });

      await chief.getByRole('textbox', { name: 'Tìm tag theo tên', exact: true }).fill(newName);
      await expect(tableRow(chief, newName), 'bảng hiện tag cuối danh bạ sau khi đổi tên').toBeVisible({ timeout: 10_000 });
      await chief.getByRole('button', { name: `Ẩn tag ${newName}`, exact: true }).click();
      await expect(toast(chief, `Đã ẩn tag “${newName}”`)).toBeVisible({ timeout: 10_000 });
      await expect(tableRow(chief, newName)).toContainText('Đã ẩn');
      const saved = await tagByName(chief, cta, newName);
      expect(saved?.name, 'tên mới được lưu').toBe(newName);
      expect(saved?.hidden, 'tag cuối danh bạ đã bị ẩn').toBe(true);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

test.describe('ADM-12 · diff {trước, sau} của "Sửa tag" / "Ẩn tag" (round 5)', () => {
  test('dòng "Sửa tag" nêu tên cũ → tên mới; dòng "Ẩn tag" nêu trường đổi; không hiện JSON {from, to}', async ({ as }) => {
    const chief = await as('chief');
    const restore = await useCompanyScope(chief, COMPANY.CTA);
    const watch = watchPage(chief, 'admin-audit-from-to');
    try {
      const cta = await companyIdOf(chief, COMPANY.CTA);
      const oldName = uniq('Diff cũ tag');
      const newName = uniq('Diff mới tag');
      const id = await ensureTagApi(chief, cta, oldName);
      expect((await api(chief, 'PATCH', `/tags/${id}`, { scope: cta, data: { name: newName } })).status, 'KTT đổi tên tag').toBe(200);
      expect((await api(chief, 'PATCH', `/tags/${id}`, { scope: cta, data: { hidden: true } })).status, 'KTT ẩn tag').toBe(200);

      await openPage(chief, '/quantri/audit');
      const rows = await findAdminAuditRows(chief, newName);
      const editRow = rows.filter({ hasText: 'Sửa tag' }).first();
      await expect(editRow, 'Audit log có dòng "Sửa tag" của tag').toBeVisible({ timeout: 15_000 });
      const editDiff = (await editRow.locator('td').nth(4).innerText()).trim();
      console.log(`[admin-audit] Trường thay đổi (Sửa tag): ${JSON.stringify(editDiff)}`);
      expect(editDiff, 'trước → sau: nêu tên cũ').toContain(oldName);
      expect(editDiff, 'trước → sau: nêu tên mới').toContain(newName);
      expect(editDiff, 'không hiện JSON {from, to}').not.toMatch(/"from"|"to"/);

      const hideRow = rows.filter({ hasText: 'Ẩn tag' }).first();
      await expect(hideRow, 'Audit log có dòng "Ẩn tag" của tag').toBeVisible({ timeout: 15_000 });
      const hideDiff = (await hideRow.locator('td').nth(4).innerText()).trim();
      console.log(`[admin-audit] Trường thay đổi (Ẩn tag): ${JSON.stringify(hideDiff)}`);
      expect(hideDiff, 'nêu trường hidden').toContain('hidden');
      expect(hideDiff, 'không hiện JSON {from, to}').not.toMatch(/"from"|"to"/);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

test.describe('lịch sử thay đổi · nhãn mã hành động của khoản vay ngân hàng và công nợ (round 5)', () => {
  test('khoản vay ngân hàng thật: cột "Thao tác" không hiện mã thô', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'loan-history-real');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const list = await api<{ items: any[] }>(staff, 'GET', '/bank-debts', { scope: cta, query: { company_id: cta } });
      expect(list.status, 'GET /bank-debts').toBe(200);
      let loanId: string | null = null;
      for (const item of (list.body.items ?? []).slice(0, 20)) {
        const d = await api(staff, 'GET', `/bank-debts/${item._id}`, { scope: cta });
        if (d.status === 200 && (dataOf<any>(d).history ?? []).length > 0) {
          loanId = String(item._id);
          break;
        }
      }
      expect(loanId, 'có khoản vay có lịch sử để kiểm tra').not.toBeNull();
      await openPage(staff, `/ngan-hang/khoan-vay/${loanId}`);
      const texts = await historyActionTexts(staff);
      console.log(`[history] khoản vay thật: nhãn "Thao tác" = ${JSON.stringify([...new Set(texts)])}`);
      expect(texts.filter((t) => RAW_AUDIT_CODE.test(t)), 'lịch sử khoản vay không hiện mã thô').toEqual([]);
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('khoản vay ngân hàng: mọi mã lịch sử trong dữ liệu (create … migrate_v2) hiện đúng nhãn của bảng khoản vay', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'loan-history-codes');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const list = await api<{ items: any[] }>(staff, 'GET', '/bank-debts', { scope: cta, query: { company_id: cta } });
      expect(list.status, 'GET /bank-debts').toBe(200);
      const loanId = String((list.body.items ?? [])[0]?._id ?? '');
      expect(loanId, 'có khoản vay để mở màn chi tiết').toMatch(/^[0-9a-f]{24}$/);
      // mã có trong bank_debts.history của dữ liệu thật (đã kiểm bằng DB); nhãn theo LOAN_HISTORY_ACTION_LABEL
      const cases: [string, string][] = [
        ['create', 'Tạo khoản vay'],
        ['update', 'Sửa khoản vay'],
        ['activate', 'Kích hoạt khoản vay'],
        ['cancel', 'Hủy khoản vay'],
        ['archive', 'Lưu trữ khoản vay'],
        ['auto_create', 'Tự động tạo khoản vay'],
        ['auto_sync', 'Đồng bộ tự động từ phiếu'],
        ['rollover_result', 'Kết quả đảo hạn'],
        ['repay_link', 'Liên kết trả nợ'],
        ['attachment_add', 'Thêm chứng từ'],
        ['migrate_v2', 'Chuyển dữ liệu từ v1'],
      ];
      await staff.route(new RegExp(`/api/v1/bank-debts/${loanId}(\\?.*)?$`), async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const res = await route.fetch();
        const json = await res.json();
        const payload = json.data ?? json;
        payload.history = cases.map(([action], i) => ({
          at: new Date(Date.now() - i * 60_000).toISOString(),
          action,
          actor: { user_id: null, name: 'Kiểm thử', role: 'chief_accountant' },
          from: null,
          to: null,
          ip: null,
          fields: null,
        }));
        await route.fulfill({ response: res, json });
      });
      await openPage(staff, `/ngan-hang/khoan-vay/${loanId}`);
      const texts = await historyActionTexts(staff);
      expect(texts.length, 'thẻ hiện đủ mọi dòng lịch sử').toBe(cases.length);
      expect([...texts].sort(), 'nhãn của từng mã đúng bảng nhãn khoản vay').toEqual(cases.map(([, label]) => label).sort());
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('công nợ: lịch sử có link_document / unlink_document (mã có trong dữ liệu) hiện nhãn, không hiện mã thô', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.CTA);
    const watch = watchPage(staff, 'debt-history-codes');
    try {
      const cta = await companyIdOf(staff, COMPANY.CTA);
      const partnerId = await createPartnerApi(staff, cta, 'customer', uniq('KH lịch sử công nợ'));
      const created = await api(staff, 'POST', '/debts', {
        scope: cta,
        data: { company_id: cta, partner_id: partnerId, direction: 'receivable', value: { amount_minor: '1000000', currency: 'VND' }, due_date: isoDay(30) },
      });
      expect(created.status, 'tạo công nợ thử').toBe(201);
      const debtId = String(dataOf<any>(created)._id);
      // mã lịch sử công nợ có trong debt_vouchers.history của dữ liệu thật (đã kiểm bằng DB): create, update,
      // attachment_add, migrate_v2, link_document, unlink_document. Hai mã sau được tiêm vào phản hồi chi tiết để kiểm nhãn.
      const codes = ['create', 'update', 'attachment_add', 'link_document', 'unlink_document', 'migrate_v2'];
      await staff.route(new RegExp(`/api/v1/debts/${debtId}(\\?.*)?$`), async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const res = await route.fetch();
        const json = await res.json();
        const payload = json.data ?? json;
        payload.history = codes.map((action, i) => ({
          at: new Date(Date.now() - i * 60_000).toISOString(),
          action,
          actor: { user_id: null, name: 'Kiểm thử', role: 'staff' },
          from: null,
          to: null,
          ip: null,
          fields: null,
        }));
        await route.fulfill({ response: res, json });
      });
      await openPage(staff, `/cong-no/phieu/${debtId}`);
      const texts = await historyActionTexts(staff);
      console.log(`[history] công nợ: nhãn "Thao tác" = ${JSON.stringify(texts)}`);
      expect(texts.filter((t) => RAW_AUDIT_CODE.test(t)), 'lịch sử công nợ không hiện mã thô (link_document / unlink_document)').toEqual([]);
      // nhãn đúng từng mã (không chỉ "không còn mã thô"): đủ mọi dòng và đúng nhãn của bảng khoản công nợ
      expect(texts.length, 'thẻ hiện đủ mọi dòng lịch sử').toBe(codes.length);
      expect([...texts].sort(), 'nhãn của từng mã đúng bảng nhãn khoản công nợ').toEqual(codes.map((c) => DEBT_HISTORY_LABEL[c]).sort());
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });

  test('công nợ thật (GROUP): khoản có lịch sử cấn trừ hiện đúng nhãn từng dòng, không hiện mã thô', async ({ as }) => {
    const staff = await as('staff');
    const restore = await useCompanyScope(staff, COMPANY.GROUP);
    const watch = watchPage(staff, 'debt-history-real');
    try {
      const group = await companyIdOf(staff, COMPANY.GROUP);
      // GROUP có ít khoản công nợ; khoản có mã cấn trừ trong dữ liệu thật là CN-2026-00003 (đã kiểm bằng DB).
      const list = await api<{ items: any[] }>(staff, 'GET', '/debts', { scope: group, query: { company_id: group, limit: 200 } });
      expect(list.status, 'GET /debts').toBe(200);
      let debtId: string | null = null;
      let actions: string[] = [];
      for (const item of (list.body.items ?? []) as any[]) {
        const d = await api(staff, 'GET', `/debts/${item._id}`, { scope: group });
        const hist: any[] = d.status === 200 ? (dataOf<any>(d).history ?? []) : [];
        if (hist.some((h) => h.action === 'link_document' || h.action === 'unlink_document')) {
          debtId = String(item._id);
          actions = hist.map((h) => String(h.action));
          break;
        }
      }
      expect(debtId, 'có khoản công nợ thật có lịch sử cấn trừ').not.toBeNull();
      await openPage(staff, `/cong-no/phieu/${debtId}`);
      const texts = await historyActionTexts(staff);
      console.log(`[history] công nợ thật: mã = ${JSON.stringify(actions)}, nhãn = ${JSON.stringify(texts)}`);
      expect(texts.filter((t) => RAW_AUDIT_CODE.test(t)), 'lịch sử công nợ thật không hiện mã thô').toEqual([]);
      expect(texts.length, 'thẻ hiện đủ mọi dòng lịch sử thật').toBe(actions.length);
      expect([...texts].sort(), 'nhãn từng dòng khớp bảng nhãn khoản công nợ').toEqual(actions.map((a) => DEBT_HISTORY_LABEL[a] ?? a).sort());
      expectNoAppCrash(watch);
    } finally {
      await restore();
    }
  });
});

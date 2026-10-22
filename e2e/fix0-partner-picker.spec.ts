/**
 * Ô chọn đối tác — nút "+ Tạo đối tác" cạnh ô khi đi bằng BÀN PHÍM (v2/v2.md §5.2).
 *
 *   PW_AREA=fix0 npx playwright test e2e/fix0-partner-picker.spec.ts
 *
 * Gõ tên → Tab tới nút cạnh ô → Enter: Tên popup vẫn là chữ đang gõ (ô tìm mất focus làm rc-select xoá ô tìm).
 */
import { test, expect, uniq } from './fixtures';
import { ROUTES, dropdown, expectPopupClosed, openForm, partnerPopup, popFooter, popName, searchPicker, sideCreateButton } from './helpers-picker';

const PAY_PICKER = 'Bên nhận tiền';

test('gõ tên rồi Tab tới "+ Tạo đối tác" cạnh ô, Enter: Tên vẫn là chữ đang gõ (§5.2)', async ({ as }) => {
  const page = await as('staff');
  const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
  const typed = uniq('PKR Tab Enter');
  await searchPicker(page, picker, typed);
  await expect(dropdown(page)).toContainText('Không có đối tác phù hợp');

  // Thứ tự Tab: ô tìm → nút xoá (×) của ô chọn (khi còn chữ) → nút cạnh ô. Tab tới khi đúng nút.
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

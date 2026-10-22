/**
 * E2E · Chip đáo hạn chỉ hiện MỘT biểu tượng cảnh báo (v2/v2.md §10.1; DS §3.3, §4.1).
 *
 *   PW_AREA=fix6 npx playwright test e2e/fix6-maturity-chip.spec.ts
 *
 * Kiểm tra chip ở danh sách khoản vay, chi tiết khoản vay và bảng đáo hạn:
 *  - nội dung hiển thị phải là đúng một biểu tượng + nhãn số ngày (ví dụ "⛔ qua hạn 15 ngày", "▲ còn 10 ngày");
 *  - aria-label giữ nhãn đầy đủ có biểu tượng (đã đúng từ trước).
 */
import type { Locator } from '@playwright/test';
import { test, expect, uniq } from './fixtures';
import { addDays, createBank, createLoanApi, findCta, listLoansApi, vnToday, type LoanApi } from './helpers-loans';

const SEARCH_PLACEHOLDER = 'Tìm theo mã hoặc tên ngân hàng';

/** Hai khoản: quá hạn 15 ngày (mức đỏ) và còn 10 ngày (mức vàng). */
const PLAN = [
  { offset: -15, label: '⛔ qua hạn 15 ngày' },
  { offset: 10, label: '▲ còn 10 ngày' },
] as const;

/** Chip trong `root` phải có aria-label đúng và nội dung hiển thị đúng bằng nhãn (một biểu tượng, không lặp). */
async function expectChip(root: Locator, label: string): Promise<void> {
  const chip = root.getByRole('status', { name: label, exact: true });
  await expect(chip, `chip có aria-label "${label}"`).toHaveCount(1);
  await expect(chip, `chip hiển thị đúng "${label}" (không lặp biểu tượng)`).toHaveText(label);
}

test.describe('fix6 · chip đáo hạn không lặp biểu tượng', () => {
  test('danh sách khoản vay, chi tiết và bảng đáo hạn đều hiện một biểu tượng', async ({ as }) => {
    const staff = await as('staff');
    const director = await as('director');
    const cta = await findCta(staff);
    await findCta(director);
    const bank = await createBank(staff, cta, 'NH Chip');
    const today = vnToday();

    // hạn tính từ hôm nay; ngày giải ngân lùi 40 ngày để khoản quá hạn vẫn hợp lệ
    for (const p of PLAN) {
      await createLoanApi(staff, cta, {
        partner_id: bank.id,
        amount: { amount_minor: '10000000', currency: 'VND' },
        disbursed_date: addDays(today, -40),
        maturity_date: addDays(today, p.offset),
        interest_rate: '0',
        contract_no: uniq('HDTD CHIP').slice(0, 60),
      });
    }

    const list = await listLoansApi(director, cta, { partner_id: bank.id });
    const loans = PLAN.map((p) => {
      const loan = list.items.find((l) => l.days_to_due === p.offset) as LoanApi | undefined;
      expect(loan, `khoản đáo hạn ${p.offset} ngày`).toBeTruthy();
      expect(loan!.warning?.label, `nhãn API ${p.offset} ngày (một biểu tượng)`).toBe(p.label);
      return { ...p, id: loan!._id, code: loan!.code };
    });

    // 1) Danh sách khoản vay (cột Hạn thanh toán)
    await staff.goto('/ngan-hang/khoan-vay');
    for (const loan of loans) {
      await staff.getByPlaceholder(SEARCH_PLACEHOLDER).fill(loan.code);
      const row = staff.locator('tr', { hasText: loan.code });
      await expect(row, `dòng ${loan.code} trong danh sách`).toHaveCount(1);
      await expectChip(row, loan.label);
    }

    // 2) Chi tiết khoản vay (chip cạnh trạng thái)
    for (const loan of loans) {
      await staff.goto(`/ngan-hang/khoan-vay/${loan.id}`);
      await expectChip(staff.locator('body'), loan.label);
    }

    // 3) Bảng đáo hạn: khoản +10 ngày nằm trong kỳ mặc định "30 ngày"
    await director.goto('/ngan-hang/dao-han');
    const soon = loans.find((l) => l.offset === 10)!;
    const soonRow = director.locator('table tr', { hasText: soon.code });
    await expect(soonRow, `dòng ${soon.code} trên bảng đáo hạn`).toHaveCount(1);
    await expectChip(soonRow, soon.label);

    // khoản quá hạn nằm ngoài kỳ "30 ngày" → chọn "Mọi kỳ"
    await director.getByLabel('Kỳ đáo hạn').click();
    await director.getByText('Mọi kỳ', { exact: true }).click();
    const overdue = loans.find((l) => l.offset === -15)!;
    const overdueRow = director.locator('table tr', { hasText: overdue.code });
    await expect(overdueRow, `dòng ${overdue.code} trên bảng đáo hạn (mọi kỳ)`).toHaveCount(1);
    await expectChip(overdueRow, overdue.label);
    await overdueRow.screenshot({ path: test.info().outputPath('dao-han-qua-han.png') });
  });
});

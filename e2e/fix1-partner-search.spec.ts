/**
 * Fix1 — tìm STK / MST trong ô chọn đối tác và danh bạ BỎ QUA PHÂN CÁCH (v2/v2.md §5.2 "Gõ để tìm theo
 * tên / STK / MST"). Cùng quy tắc chuẩn hoá với cảnh báo trùng §5.1: bỏ khoảng trắng, gạch, chấm,
 * gạch dưới, gạch chéo khi so khớp số.
 *
 * Chỉ thêm mới — không sửa fixtures.ts / playwright.config.ts / helper dùng chung.
 */
import { test, expect, uniq } from './fixtures';
import { CTA, ROUTES, apiCreatePartner, apiOptions, openForm, optionNamed, searchPicker, uniqDigits } from './helpers-picker';

const PAY_PICKER = 'Bên nhận tiền';

test.describe('Tìm STK / MST bỏ qua phân cách (§5.2, §5.1)', () => {
  test('API: /partners/options và /partners tìm được đối tác khi gõ STK / MST không phân cách, đúng cách ghi, hoặc đoạn số', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Phan Cach');
    const d12 = uniqDigits(12);
    const d10 = uniqDigits(10);
    // cách ghi như người dùng thường nhập: gạch, khoảng trắng thường và khoảng trắng không ngắt NBSP (hay gặp khi copy từ web); MST có gạch chi nhánh
    const stk = `${d12.slice(0, 3)}-${d12.slice(3, 6)}\u00a0${d12.slice(6, 9)} ${d12.slice(9)}`;
    const mst = `${d10}-001`;
    const p = await apiCreatePartner(page, { type: 'supplier', name, bank_name: 'Vietcombank', account_number: stk, tax_code: mst });

    const optionIds = async (q: string): Promise<string[]> => (await apiOptions(page, q)).map((x) => x._id);
    const listIds = async (q: string): Promise<string[]> => {
      const params = new URLSearchParams({ company_id: CTA, q, status: 'all', limit: '50' });
      const res = await page.request.get(`/api/v1/partners?${params.toString()}`, { headers: { 'x-company-scope': CTA } });
      const text = await res.text();
      expect(res.status(), text).toBe(200);
      return (JSON.parse(text) as { items: { _id: string }[] }).items.map((x) => x._id);
    };

    const queries = [
      d12, // STK liền, không phân cách
      `${d10}001`, // MST liền, không phân cách
      stk, // STK đúng cách ghi đã lưu
      mst, // MST đúng cách ghi đã lưu
      d12.slice(2, 9), // đoạn giữa của STK
      d10.slice(0, 7), // tiền tố của MST
    ];
    for (const q of queries) {
      expect(await optionIds(q), `options: gõ "${q}"`).toContain(p._id);
      expect(await listIds(q), `danh sách: gõ "${q}"`).toContain(p._id);
    }
    // số khác (đổi chữ số cuối) ⇒ không khớp đối tác này
    const other = `${d12.slice(0, 11)}${(Number(d12[11]) + 1) % 10}`;
    expect(await optionIds(other), 'số khác không khớp').not.toContain(p._id);
  });

  test('ô chọn đối tác (form phiếu chi): gõ STK / MST liền không dấu vẫn ra đối tác', async ({ as }) => {
    const page = await as('staff');
    const name = uniq('PKR Phan Cach UI');
    const d12 = uniqDigits(12);
    const d10 = uniqDigits(10);
    await apiCreatePartner(page, {
      type: 'supplier',
      name,
      bank_name: 'ACB',
      account_number: `${d12.slice(0, 4)}.${d12.slice(4, 8)}_${d12.slice(8)}`,
      tax_code: `${d10}-001`,
    });

    const picker = await openForm(page, ROUTES.payment, PAY_PICKER);
    await searchPicker(page, picker, d12);
    await expect(optionNamed(page, name), 'gõ STK liền không dấu').toHaveCount(1);
    await searchPicker(page, picker, `${d10}001`);
    await expect(optionNamed(page, name), 'gõ MST liền không dấu').toHaveCount(1);
  });
});

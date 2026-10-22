/**
 * FG-WF-005 — phương án đảo hạn đã duyệt không được hiện "Thực thi" (v2 §7.3, RENEW-04).
 * Chỉ ĐỌC: không bấm nút ghi dữ liệu. Id phương án lấy từ FIX_ROLLOVER_ID (mặc định DH-2026-00002 trong DB test).
 */
import { test, expect } from './fixtures';

const ID = process.env.FIX_ROLLOVER_ID ?? '6ad99d04b22d5d8479ce0b8e';

test.describe('FG-WF-005 · phương án đảo hạn đã duyệt', () => {
  test('API: can.pay và can.queue_payment = false; can.rollover_result theo quyền rollover:act', async ({ as }) => {
    const staff = await as('staff');
    const sres = await staff.request.get(`/api/v1/documents/${ID}`);
    expect(sres.ok(), `GET phương án (kế toán viên): ${sres.status()} ${await sres.text()}`).toBeTruthy();
    const s = (await sres.json()).data;
    expect(s.kind, 'hồ sơ phải là phương án đảo hạn').toBe('rollover');
    expect(s.status, 'phương án phải ở trạng thái đã duyệt').toBe('approved');
    expect(s.can.pay, 'phương án đảo hạn: không có "Thực thi"').toBe(false);
    expect(s.can.queue_payment, 'phương án đảo hạn: không có "Đưa vào hàng thanh toán"').toBe(false);
    expect(s.can.rollover_result, 'kế toán viên không có rollover:act — không ghi kết quả').toBe(false);

    const director = await as('director');
    const dres = await director.request.get(`/api/v1/documents/${ID}`);
    expect(dres.ok(), `GET phương án (giám đốc): ${dres.status()} ${await dres.text()}`).toBeTruthy();
    const d = (await dres.json()).data;
    expect(d.can.pay, 'giám đốc cũng không được "Thực thi" phương án đảo hạn').toBe(false);
    expect(d.can.rollover_result, 'giám đốc (rollover:act) ghi được kết quả RENEW-04').toBe(true);
  });

  test('UI: kế toán viên không thấy "Thực thi"; giám đốc thấy form kết quả và không thấy "Thực thi"', async ({ as }) => {
    const staff = await as('staff');
    await staff.goto(`/ho-so/dao-han/${ID}`);
    await expect(staff.getByText('Phương án đảo hạn', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(staff.getByRole('button', { name: 'Thực thi', exact: true }), 'kế toán viên: không có nút Thực thi').toHaveCount(0);
    await expect(staff.getByRole('button', { name: 'Đưa vào hàng thanh toán', exact: true }), 'không có nút đưa vào hàng thanh toán').toHaveCount(0);

    const director = await as('director');
    await director.goto(`/ho-so/dao-han/${ID}`);
    await expect(director.getByText('Phương án đảo hạn', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
    await expect(director.getByRole('button', { name: 'Thực thi', exact: true }), 'giám đốc: không có nút Thực thi').toHaveCount(0);
    await expect(director.getByRole('button', { name: 'Lưu kết quả thực hiện' }), 'giám đốc: có form cập nhật kết quả (RENEW-04)').toBeVisible();
  });
});

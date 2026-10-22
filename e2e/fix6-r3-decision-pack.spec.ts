/**
 * fix6 — Gói quyết định (decision-pack) của phiếu chi "vay ngân hàng để chi" (R3, v2/v2.md §8, §11.5):
 * "Sau giao dịch" cộng khoản giải ngân SẮP về TK nhận trước duyệt cuối, rồi KHÔNG cộng lần nữa khi khoản đó đã
 * nằm trong sổ cái (sau duyệt cuối, khi đang thanh toán, khi đã thanh toán).
 *
 *   PW_AREA=fix6 npx playwright test e2e/fix6-r3-decision-pack.spec.ts
 */
import type { Page } from '@playwright/test';
import { test, expect, uniq } from './fixtures';
import {
  type Approvers,
  approveToFinal,
  attachUnc,
  balanceOf,
  companyIdsByCode,
  createBankAccount,
  createPartner,
  createSpend,
  dataOf,
  getDoc,
  must,
  payByApi,
  req,
  transition,
  waitForRun,
} from './helpers-r3r1';

interface Impact {
  balance_before: { minor: string };
  balance_after: { minor: string };
  min_balance: { minor: string };
  breach: boolean;
}

async function impactOf(page: Page, companyId: string, id: string): Promise<Impact> {
  const pack = dataOf<{ q6_impact: Impact }>(must(await req(page, 'GET', `/documents/${id}/decision-pack`, { scope: companyId }), 'gói quyết định'));
  return pack.q6_impact;
}

test('R3 · gói quyết định: "Sau giao dịch" đúng xuyên suốt vòng đời, không đếm trùng khoản giải ngân đã ghi sổ', async ({ as }) => {
  test.setTimeout(300_000);
  const staff = await as('staff');
  const chief = await as('chief');
  const director = await as('director');
  const chairman = await as('chairman');
  const CTA = (await companyIdsByCode(chairman)).CTA;
  if (!CTA) throw new Error('Thiếu công ty CTA');
  const approvers: Approvers = { chief, director, chairman };

  // TK mới của CTA: số dư 0, ngưỡng tối thiểu 0 — khoản vay 6 tr giải ngân VÀO TK này rồi phiếu chi 6 tr chi từ TK này
  const bankId = await createPartner(staff, CTA, 'bank', uniq('NH fix6'));
  const accId = await createBankAccount(chairman, CTA, uniq('TK fix6 nhận'));
  const supplierId = await createPartner(staff, CTA, 'supplier', uniq('NCC fix6'));
  const created = await createSpend(staff, {
    companyId: CTA,
    partnerId: supplierId,
    amountMinor: '6000000',
    sourceAccountId: accId,
    purpose: uniq('Chi vay fix6'),
    loan: { lenderId: bankId, receiveAccountId: accId, amountMinor: null, terms: { interest_rate: '9.5', term_months: 12 } },
  });
  const id = created.id;
  must(await transition(staff, CTA, id, 'submit'), 'gửi duyệt phiếu chi vay fix6');

  // 1) đang chờ duyệt: khoản vay sắp về (chưa vào sổ) được cộng ⇒ sau giao dịch 0, không cảnh báo
  const pending = await impactOf(chief, CTA, id);
  expect(String(pending.balance_after.minor), 'chờ duyệt: sau giao dịch = 6 tr về − 6 tr chi').toBe('0');
  expect(pending.breach, 'chờ duyệt: không báo dưới ngưỡng tối thiểu').toBe(false);

  // 2) duyệt cuối: R3 ghi sổ khoản giải ngân vào TK nhận; phiếu chi còn Đã duyệt
  await approveToFinal(approvers, CTA, id);
  await waitForRun(staff, CTA, id, 'R3', 'done');
  expect(await balanceOf(chairman, CTA, accId), 'R3 đã ghi sổ 6 tr giải ngân vào TK nhận').toBe(6_000_000n);
  const approved = await impactOf(chief, CTA, id);
  expect(String(approved.balance_after.minor), 'đã duyệt: khoản giải ngân đã trong sổ — sau giao dịch = 6 tr − 6 tr').toBe('0');
  expect(approved.breach, 'đã duyệt: không báo dưới ngưỡng tối thiểu').toBe(false);

  // 3) đưa vào hàng thanh toán: vẫn không cộng trùng khoản đã ghi sổ
  must(await transition(staff, CTA, id, 'queue_payment'), 'đưa phiếu chi vay fix6 vào hàng thanh toán');
  const queued = await impactOf(staff, CTA, id);
  expect(String(queued.balance_after.minor), 'đang thanh toán: sau giao dịch vẫn 0 (không đếm trùng)').toBe('0');
  expect(queued.breach, 'đang thanh toán: không báo dưới ngưỡng tối thiểu').toBe(false);

  // 4) thực thi: sổ cái ghi 6 tr chi ⇒ gói quyết định đọc theo sổ cái: trước 6 tr, sau 0
  await attachUnc(staff, CTA, id);
  must(await payByApi(staff, CTA, id), 'thực thi phiếu chi vay fix6');
  expect(await balanceOf(chairman, CTA, accId), 'sau thực thi: TK nhận còn 0').toBe(0n);
  const paid = await impactOf(chief, CTA, id);
  expect(String(paid.balance_before.minor), 'đã thanh toán: số dư trước = 6 tr trong sổ').toBe('6000000');
  expect(String(paid.balance_after.minor), 'đã thanh toán: số dư sau = 0').toBe('0');
  expect((await getDoc(chief, CTA, id)).status, 'trạng thái cuối: paid').toBe('paid');
});

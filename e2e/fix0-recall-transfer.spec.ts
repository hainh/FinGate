/**
 * Kiểm thử sửa lỗi (nhóm fix0):
 *  1) v2 §7.1 · Đang thanh toán → Yêu cầu bổ sung: máy chủ, quyền `can` và nút trên giao diện khớp nhau; KTV không được;
 *     KTT đưa về bổ sung qua giao diện, KTV sửa và gửi lại được.
 *  2) v2 §11.6 · chuyển nội bộ thiếu TK nhận (nháp lưu trước khi có kiểm tra khi lưu): gửi duyệt, duyệt, đưa vào hàng và
 *     thực thi đều bị từ chối 422 FG-VAL-001 "Chọn tài khoản nhận của công ty đích" — tiền không ra khỏi công ty nguồn.
 *
 * Dữ liệu tạo bằng uniq(). TK nhận thiếu được tạo bằng cách bỏ `transfer_target.account_id` trong CSDL test
 * (không có API nào lưu được trạng thái này sau khi sửa lỗi).
 */
import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { test, expect, uniq } from './fixtures';
import * as H from './helpers-vouchers';

const AMOUNT = 5_000_000;
const TARGET_CODE = 'CTB';
const MISSING_TARGET = 'Chọn tài khoản nhận của công ty đích';

/** Ngày hôm nay theo múi giờ VN (YYYY-MM-DD). */
function vnToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
}

/** Bỏ TK nhận của chuyển nội bộ trong CSDL test (mô phỏng nháp / phiếu đã lưu trước khi có kiểm tra khi lưu). */
function clearTransferAccountInDb(docId: string): void {
  const script = `print(db.documents.updateOne({ _id: ObjectId('${docId}') }, { $set: { 'transfer_target.account_id': null } }).modifiedCount)`;
  const out = execFileSync('docker', ['exec', 'fingate-mongo', 'mongosh', '--quiet', 'fingate', '--eval', script], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  expect(Number(out.trim().split(/\r?\n/).pop()), 'đã bỏ TK nhận trong CSDL test').toBe(1);
}

/** Chi chuyển nội bộ sang công ty đích (cùng body mà form web gửi, `transfer_target` theo ID). Trả về id hồ sơ. */
async function createTransferDraft(
  page: Page,
  co: string,
  o: { partnerId: string; accountId: string; targetCo: string; targetAccountId: string; title: string },
): Promise<string> {
  const r = await H.api(page, 'POST', '/documents', {
    scope: co,
    data: {
      kind: 'spend',
      company_id: co,
      title: o.title,
      purpose: `Nội dung kiểm thử ${o.title}`,
      partner_id: o.partnerId,
      amount: { amount_minor: String(AMOUNT), currency: 'VND' },
      source: { fund: 'bank', account_id: o.accountId, group_managed: false },
      planned_date: H.DEADLINE_ISO,
      priority: 'normal',
      category_id: null,
      budget: { budget_id: null, line_id: null, in_plan: true },
      contract: {},
      tag_ids: [],
      options: { loan: null },
      transfer_target: { company_id: o.targetCo, account_id: o.targetAccountId },
    },
  });
  expect(r.status, `tạo nháp chuyển nội bộ: ${r.text}`).toBeLessThan(300);
  return String(H.unwrap<{ _id: string }>(r.body)._id);
}

/** Đính kèm hợp đồng + hoá đơn rồi gửi duyệt (đủ chứng từ để duyệt). */
async function attachAndSubmit(staff: Page, co: string, id: string): Promise<void> {
  await H.attachApi(staff, co, id, 'contract', 'hop-dong.pdf');
  await H.attachApi(staff, co, id, 'invoice', 'hoa-don.pdf');
  await H.submitApi(staff, co, id);
}

/** Lỗi nghiệp vụ của máy chủ: mã, chi tiết (chuỗi JSON problem). */
function problemOf(r: H.ApiResult): { code: string; detail: string } {
  const b = (r.body ?? {}) as { code?: string; detail?: string };
  return { code: String(b.code ?? ''), detail: String(b.detail ?? '') };
}

test('v2 §7.1 · Đang thanh toán → Yêu cầu bổ sung: máy chủ, quyền (can) và nút giao diện khớp nhau; KTV không được; KTT trả về qua giao diện, KTV gửi lại được', async ({ as }) => {
  test.setTimeout(300_000);
  const staff = await as('staff');
  const chief = await as('chief');
  const director = await as('director');
  const chairman = await as('chairman');
  const co = await H.companyId(staff, H.CTA_CODE);
  const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC fix0 bổ sung'));
  const accountId = await H.createAccount(chief, co, uniq('NH fix0 bổ sung'));
  const pages = { chief, director, chairman };

  // hai phiếu chi 5 triệu đã duyệt xong, đưa vào hàng thanh toán → Đang thanh toán (processing)
  const toProcessing = async (title: string): Promise<string> => {
    const { id } = await H.submittedVoucherApi(staff, co, { partnerId, accountId, amount: AMOUNT, title });
    expect(await H.approveToFinal(pages, co, id), `${title}: duyệt xong cấp cuối`).toBe('approved');
    const q = await H.transitionApi(staff, co, id, { action: 'queue_payment' });
    expect(q.status, `đưa vào hàng thanh toán: ${q.text}`).toBeLessThan(300);
    await H.expectStatus(staff, co, id, 'processing');
    return id;
  };
  const byChief = await toProcessing(uniq('Đang TT KTT'));
  const byDirector = await toProcessing(uniq('Đang TT GĐ'));

  // (1) KTV (không có approval:act): quyền không có và máy chủ từ chối
  expect((await H.getDoc(staff, co, byChief)).can.request_changes, 'KTV không đưa phiếu đang thanh toán về bổ sung được').toBe(false);
  const denied = await H.transitionApi(staff, co, byChief, { action: 'request_changes', reason: 'KTV thử đưa về bổ sung' });
  expect(denied.status, `máy chủ chặn KTV: ${denied.text}`).toBe(403);

  // (2) Giám đốc: quyền (can) phải khớp với điều máy chủ chấp nhận
  const dirCan = (await H.getDoc(director, co, byDirector)).can.request_changes as boolean;
  const dirRes = await H.transitionApi(director, co, byDirector, { action: 'request_changes', reason: 'GĐ đưa về bổ sung phiếu đang thanh toán' });
  expect(dirRes.status < 300, `can.request_changes (${dirCan}) phải khớp máy chủ: ${dirRes.status} ${dirRes.text.slice(0, 200)}`).toBe(dirCan);

  // (3) KTT: có quyền (can) và nút "Yêu cầu bổ sung" hiện trên phiếu đang thanh toán
  expect((await H.getDoc(chief, co, byChief)).can.request_changes, 'KTT đưa được phiếu đang thanh toán về bổ sung').toBe(true);
  await H.gotoCta(chief, `/ho-so/chi/${byChief}`);
  await expect(chief.getByText('Đang thanh toán').first(), 'hồ sơ hiện trạng thái Đang thanh toán').toBeVisible({ timeout: 20_000 });
  await expect(H.actionBar(chief).getByRole('button', { name: 'Yêu cầu bổ sung', exact: true }), 'nút Yêu cầu bổ sung trên phiếu đang thanh toán').toBeVisible();

  // (4) KTT đưa về bổ sung qua giao diện (toolbar → modal có ý kiến → xác nhận)
  await H.uiDecision(chief, 'Yêu cầu bổ sung', 'Yêu cầu bổ sung', 'KTT yêu cầu bổ sung phiếu đang thanh toán');
  await H.expectStatus(chief, co, byChief, 'changes_requested');

  // (5) KTV sửa và gửi lại: phiếu quay lại chuỗi duyệt
  const resent = await H.transitionApi(staff, co, byChief, { action: 'submit' });
  expect(resent.status, `KTV gửi lại sau khi bổ sung: ${resent.text}`).toBeLessThan(300);
  expect(String((await H.getDoc(staff, co, byChief)).status).startsWith('pending.'), 'gửi lại đi vào chuỗi duyệt').toBe(true);
});

test('v2 §11.6 · nháp chuyển nội bộ thiếu TK nhận không gửi duyệt được: 422 FG-VAL-001 "Chọn tài khoản nhận của công ty đích"', async ({ as }) => {
  test.setTimeout(180_000);
  const staff = await as('staff');
  const chief = await as('chief');
  const chairman = await as('chairman');
  const co = await H.companyId(staff, H.CTA_CODE);
  const coB = await H.companyId(staff, TARGET_CODE);
  const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC fix0 nháp'));
  const srcAcc = await H.createAccount(chief, co, uniq('NH fix0 nguồn nháp'));
  const dstAcc = await H.createAccount(chairman, coB, uniq('NH fix0 đích nháp'));

  const draftId = await createTransferDraft(staff, co, {
    partnerId,
    accountId: srcAcc,
    targetCo: coB,
    targetAccountId: dstAcc,
    title: uniq('Nháp CN thiếu TK'),
  });
  clearTransferAccountInDb(draftId);
  expect((await H.getDoc(staff, co, draftId)).transfer_target?.account_id ?? null, 'nháp không còn TK nhận').toBeNull();

  const r = await H.transitionApi(staff, co, draftId, { action: 'submit' });
  expect(r.status, `gửi duyệt phải bị từ chối: ${r.text}`).toBe(422);
  expect(problemOf(r), 'mã và thông báo lỗi nêu đúng TK nhận thiếu').toEqual({ code: 'FG-VAL-001', detail: MISSING_TARGET });
  expect(String((await H.getDoc(staff, co, draftId)).status), 'phiếu vẫn là nháp').toBe('draft');
});

test('v2 §11.6 · phiếu đã gửi nhưng thiếu TK nhận: không duyệt được (422), KTT trả về được để KTV chọn lại TK', async ({ as }) => {
  test.setTimeout(180_000);
  const staff = await as('staff');
  const chief = await as('chief');
  const chairman = await as('chairman');
  const co = await H.companyId(staff, H.CTA_CODE);
  const coB = await H.companyId(staff, TARGET_CODE);
  const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC fix0 chờ duyệt'));
  const srcAcc = await H.createAccount(chief, co, uniq('NH fix0 nguồn chờ'));
  const dstAcc = await H.createAccount(chairman, coB, uniq('NH fix0 đích chờ'));

  const id = await createTransferDraft(staff, co, {
    partnerId,
    accountId: srcAcc,
    targetCo: coB,
    targetAccountId: dstAcc,
    title: uniq('Chờ duyệt CN thiếu TK'),
  });
  await attachAndSubmit(staff, co, id);
  const before = await H.getDoc(staff, co, id);
  expect(String(before.status).startsWith('pending.'), 'phiếu đã vào chuỗi duyệt').toBe(true);

  clearTransferAccountInDb(id);
  const approve = await H.transitionApi(chief, co, id, { action: 'approve' });
  expect(approve.status, `duyệt phải bị từ chối khi thiếu TK nhận: ${approve.text}`).toBe(422);
  expect(problemOf(approve), 'duyệt bị chặn đúng lý do').toEqual({ code: 'FG-VAL-001', detail: MISSING_TARGET });
  expect(String((await H.getDoc(staff, co, id)).status), 'duyệt bị chặn: phiếu không đổi trạng thái').toBe(before.status);

  // KTT trả về để KTV chọn TK nhận (đường đi của yêu cầu bổ sung ở vòng duyệt)
  const back = await H.transitionApi(chief, co, id, { action: 'request_changes', reason: 'Chọn tài khoản nhận của công ty đích' });
  expect(back.status, `KTT trả về được: ${back.text}`).toBeLessThan(300);
});

test('v2 §11.6 · phiếu đã duyệt nhưng TK nhận bị thiếu: đưa vào hàng và thực thi đều bị chặn — tiền không ra khỏi công ty nguồn', async ({ as }) => {
  test.setTimeout(240_000);
  const staff = await as('staff');
  const chief = await as('chief');
  const director = await as('director');
  const chairman = await as('chairman');
  const co = await H.companyId(staff, H.CTA_CODE);
  const coB = await H.companyId(staff, TARGET_CODE);
  const partnerId = await H.createPartner(staff, co, 'supplier', uniq('NCC fix0 thực thi'));
  const srcAcc = await H.createAccount(chief, co, uniq('NH fix0 nguồn thực thi'));
  const dstAcc = await H.createAccount(chairman, coB, uniq('NH fix0 đích thực thi'));

  const id = await createTransferDraft(staff, co, {
    partnerId,
    accountId: srcAcc,
    targetCo: coB,
    targetAccountId: dstAcc,
    title: uniq('Đã duyệt CN thiếu TK'),
  });
  await H.attachApi(staff, co, id, 'bank_order', 'uy-nhiem-chi.pdf');
  await attachAndSubmit(staff, co, id);
  expect(await H.approveToFinal({ chief, director, chairman }, co, id), 'duyệt xong cấp cuối').toBe('approved');

  clearTransferAccountInDb(id);

  const queue = await H.transitionApi(staff, co, id, { action: 'queue_payment' });
  expect(queue.status, `đưa vào hàng thanh toán phải bị chặn: ${queue.text}`).toBe(422);
  expect(problemOf(queue), 'đưa vào hàng bị chặn đúng lý do').toEqual({ code: 'FG-VAL-001', detail: MISSING_TARGET });

  const pay = await H.transitionApi(staff, co, id, {
    action: 'pay',
    execution: { paid_at: vnToday(), bank_ref: `FIX0${Date.now()}` },
  });
  expect(pay.status, `thực thi phải bị chặn: ${pay.text}`).toBe(422);
  expect(problemOf(pay), 'thực thi bị chặn đúng lý do').toEqual({ code: 'FG-VAL-001', detail: MISSING_TARGET });

  const after = await H.getDoc(staff, co, id);
  expect(after.status, 'phiếu vẫn Đã duyệt, chưa ghi nhận thanh toán').toBe('approved');
  expect(after.execution?.paid_at ?? null, 'không có bản ghi thực thi').toBeNull();
});

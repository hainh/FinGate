/**
 * R1 — Chuyển tiền nội bộ → phiếu thu tự động (v2/v2.md §11.3, §11.6, §6.3).
 *
 * Kích hoạt: `voucher.paid` của phiếu chi. Đích chuyển được xác định theo ID: `transfer_target = {company_id,
 * account_id}` (v2 bỏ nhận diện theo chuỗi "Mã công ty - NH - STK" của v1).
 *
 * Hai trường hợp:
 *  · công ty đích KHÁC công ty phiếu — chuyển tiền giữa các công ty trong tập đoàn: phiếu thu ở công ty đích, liên kết
 *    `internal_transfer` (quan hệ chỉ dành cho cặp KHÁC công ty — `RELATION_SPECS`);
 *  · công ty đích TRÙNG công ty phiếu — chuyển tiền giữa hai tài khoản của CÙNG một công ty: phiếu thu ở chính công ty
 *    đó, liên kết `generated` (quan hệ cùng công ty; báo cáo loại cặp này khỏi doanh thu/chi phí qua
 *    `transfer_target.company_id === company_id`, xem `reports/refs.ts`).
 *
 * Bước:
 *  1. create_voucher  — phiếu thu ĐÃ DUYỆT ở công ty đích, kế thừa người duyệt của phiếu chi (nhãn Tự động);
 *  2. execute_voucher — thực thi ngay (ngày thực thi = ngày thực thi phiếu chi): sổ cái công ty đích được cộng;
 *  3. link            — `internal_transfer` (khác công ty) / `generated` (cùng công ty) từ phiếu chi sang phiếu thu.
 * Phiếu chi không đích nội bộ ⇒ các bước bỏ qua (lượt hoàn tất, không có đối tượng sinh ra).
 */

import { registerRule, type StepContext, type StepOutput } from '../engine.ts';
import { assertAccountAllowedForCompany } from '../../accounts.ts';
import { actorOfEvent, big } from '../actions/common.ts';
import { companyView, fundOfAccount, loadVoucher } from '../actions/lookup.ts';
import { createAutoVoucher, executeAutoVoucher, findAutoVoucher, todayVn } from '../actions/voucher.ts';
import { ensureAutomationLink } from '../actions/link.ts';

const RULE = 'R1';
/** Tiền tố nội dung của phiếu thu tự động (mục đích), để nhận diện khoản chuyển nội bộ khi đọc. */
const AUTO_INCOME_PREFIX = '(Tự động nhập) ';

registerRule(RULE, {
  steps: [
    { name: 'create_voucher', run: createVoucherStep },
    { name: 'execute_voucher', run: executeVoucherStep },
    { name: 'link', run: linkStep },
  ],
});

/**
 * Quan hệ liên kết cho cặp phiếu chi → phiếu thu do R1 sinh: `internal_transfer` khi HAI CÔNG TY KHÁC NHAU,
 * `generated` khi CÙNG công ty (chuyển giữa hai tài khoản — ràng buộc của `RELATION_SPECS`).
 */
export function transferLinkRelationOf(sameCompany: boolean): 'internal_transfer' | 'generated' {
  return sameCompany ? 'generated' : 'internal_transfer';
}

/** Phiếu chi có đích chuyển nội bộ (theo ID) — null nếu không áp dụng. Cùng công ty cũng là chuyển nội bộ. */
async function transferOf(ctx: StepContext) {
  const src = await loadVoucher(ctx.event.subject_id);
  if (!src || src.kind !== 'spend') return null;
  const target = src.transfer_target;
  if (!target?.company_id) return null;
  const targetCompanyId = String(target.company_id);
  return {
    src,
    targetCompanyId,
    targetAccountId: target.account_id ? String(target.account_id) : null,
    sameCompany: targetCompanyId === String(src.company_id),
  };
}

async function receiptIdOf(ctx: StepContext): Promise<string | null> {
  return ctx.outputs.create_voucher?.output_id ?? (await findAutoVoucher(ctx.runId, RULE, 'income'))?.id ?? null;
}

/** Nhãn nguồn trong ghi chú phiếu thu: khác công ty ghi tên công ty nguồn; cùng công ty ghi rõ chuyển giữa hai TK. */
export function transferNoteOf(input: {
  sourceCode: string;
  sameCompany: boolean;
  sourceCompany: { code: string; name: string } | null;
}): string {
  const base = `Tự động tạo khi thực thi phiếu chi ${input.sourceCode}`;
  const company = input.sourceCompany;
  const tail = input.sameCompany
    ? company
      ? ` · chuyển giữa hai tài khoản cùng công ty ${company.code} - ${company.name}`
      : ' · chuyển giữa hai tài khoản cùng công ty'
    : company
      ? ` · từ ${company.code} - ${company.name}`
      : '';
  return `${base}${tail}`.trim();
}

async function createVoucherStep(ctx: StepContext): Promise<StepOutput> {
  const t = await transferOf(ctx);
  if (!t) return { skipped: true };
  const existing = await findAutoVoucher(ctx.runId, RULE, 'income');
  if (existing) return { output_type: 'document', output_id: existing.id };

  if (!t.targetAccountId) throw new Error('Chưa chọn tài khoản nhận của công ty đích');
  // chuyển CÙNG công ty: TK nhận phải khác TK nguồn — kiểm lại trước khi ghi phiếu thu (phòng TK nguồn đổi sau khi lưu)
  const sourceAccountId = t.src.source?.account_id ? String(t.src.source.account_id) : null;
  if (t.sameCompany && sourceAccountId && t.targetAccountId === sourceAccountId) {
    throw new Error('Tài khoản nhận trùng tài khoản nguồn — không chuyển được giữa hai tài khoản cùng công ty');
  }
  await assertAccountAllowedForCompany(t.targetCompanyId, t.targetAccountId);

  const { src } = t;
  const paidDate = src.execution?.paid_at ?? todayVn();
  const sourceCompany = await companyView(src.company_id);
  const actor = actorOfEvent(ctx.event);
  const created = await createAutoVoucher({
    kind: 'income',
    companyId: t.targetCompanyId,
    title: t.sameCompany ? `Thu tự động chuyển khoản nội bộ từ phiếu chi ${src.code}` : `Thu tự động từ phiếu chi ${src.code}`,
    purpose: `${AUTO_INCOME_PREFIX}${src.purpose || src.title || ''}`.trim(),
    // công ty chuyển đi là ngoại lệ "không đối tác": ghi nguồn trong ghi chú (không dùng payee.* v1)
    note: transferNoteOf({ sourceCode: src.code, sameCompany: t.sameCompany, sourceCompany }),
    amountMinor: big(src.execution?.actual_amount_minor ?? src.amount.minor),
    currency: src.amount.currency ?? 'VND',
    decimals: src.amount.decimals ?? 0,
    fund: await fundOfAccount(t.targetAccountId),
    accountId: t.targetAccountId,
    partnerId: null,
    plannedDate: paidDate,
    businessDate: paidDate,
    approvalSteps: src.approval?.steps,
    matrixLabel: 'Tự động (theo phiếu chi)',
    createdBy: actor.user_id ?? String(src.created_by ?? ''),
    source: { id: String(src._id), code: src.code },
    ruleCode: RULE,
    runId: ctx.runId,
    eventType: ctx.event.type,
    actor,
    requestId: ctx.stepKey,
  });
  return { output_type: 'document', output_id: created.id };
}

async function executeVoucherStep(ctx: StepContext): Promise<StepOutput> {
  const t = await transferOf(ctx);
  const receiptId = await receiptIdOf(ctx);
  if (!t || !receiptId) return { skipped: true };
  await executeAutoVoucher({
    docId: receiptId,
    paidAt: t.src.execution?.paid_at ?? todayVn(),
    actor: actorOfEvent(ctx.event),
    requestId: ctx.stepKey,
  });
  return { output_type: 'document', output_id: receiptId };
}

async function linkStep(ctx: StepContext): Promise<StepOutput> {
  const t = await transferOf(ctx);
  const receiptId = await receiptIdOf(ctx);
  if (!t || !receiptId) return { skipped: true };
  await ensureAutomationLink({
    from: { type: 'document', id: String(t.src._id) },
    to: { type: 'document', id: receiptId },
    // khác công ty: `internal_transfer`; cùng công ty: `generated` (ràng buộc sameCompany của RELATION_SPECS)
    relation: transferLinkRelationOf(t.sameCompany),
    amountMinor: null,
    runId: ctx.runId,
    ruleCode: RULE,
    actor: actorOfEvent(ctx.event),
    requestId: ctx.stepKey,
  });
  return { output_type: 'document', output_id: receiptId };
}

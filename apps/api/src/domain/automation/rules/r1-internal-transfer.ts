/**
 * R1 — Chuyển tiền nội bộ → phiếu thu tự động (v2/v2.md §11.3, §11.6, §6.3).
 *
 * Kích hoạt: `voucher.paid` của phiếu chi. Đích chuyển được xác định theo ID: `transfer_target = {company_id,
 * account_id}` (v2 bỏ nhận diện theo chuỗi "Mã công ty - NH - STK" của v1).
 *
 * Bước:
 *  1. create_voucher  — phiếu thu ĐÃ DUYỆT ở công ty đích, kế thừa người duyệt của phiếu chi (nhãn Tự động);
 *  2. execute_voucher — thực thi ngay (ngày thực thi = ngày thực thi phiếu chi): sổ cái công ty đích được cộng;
 *  3. link            — `internal_transfer` từ phiếu chi (A) sang phiếu thu (B).
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

/** Phiếu chi có đích chuyển nội bộ (ID công ty khác công ty phiếu) — null nếu không áp dụng. */
async function transferOf(ctx: StepContext) {
  const src = await loadVoucher(ctx.event.subject_id);
  if (!src || src.kind !== 'spend') return null;
  const target = src.transfer_target;
  if (!target?.company_id || String(target.company_id) === String(src.company_id)) return null;
  return { src, targetCompanyId: String(target.company_id), targetAccountId: target.account_id ? String(target.account_id) : null };
}

async function receiptIdOf(ctx: StepContext): Promise<string | null> {
  return ctx.outputs.create_voucher?.output_id ?? (await findAutoVoucher(ctx.runId, RULE, 'income'))?.id ?? null;
}

async function createVoucherStep(ctx: StepContext): Promise<StepOutput> {
  const t = await transferOf(ctx);
  if (!t) return { skipped: true };
  const existing = await findAutoVoucher(ctx.runId, RULE, 'income');
  if (existing) return { output_type: 'document', output_id: existing.id };

  if (!t.targetAccountId) throw new Error('Chưa chọn tài khoản nhận của công ty đích');
  await assertAccountAllowedForCompany(t.targetCompanyId, t.targetAccountId);

  const { src } = t;
  const paidDate = src.execution?.paid_at ?? todayVn();
  const sourceCompany = await companyView(src.company_id);
  const actor = actorOfEvent(ctx.event);
  const created = await createAutoVoucher({
    kind: 'income',
    companyId: t.targetCompanyId,
    title: `Thu tự động từ phiếu chi ${src.code}`,
    purpose: `${AUTO_INCOME_PREFIX}${src.purpose || src.title || ''}`.trim(),
    // công ty chuyển đi là ngoại lệ "không đối tác": ghi tên công ty nguồn trong ghi chú (không dùng payee.* v1)
    note: `Tự động tạo khi thực thi phiếu chi ${src.code}${sourceCompany ? ` · từ ${sourceCompany.code} - ${sourceCompany.name}`.trim() : ''}`,
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
    relation: 'internal_transfer',
    amountMinor: null,
    runId: ctx.runId,
    ruleCode: RULE,
    actor: actorOfEvent(ctx.event),
    requestId: ctx.stepKey,
  });
  return { output_type: 'document', output_id: receiptId };
}

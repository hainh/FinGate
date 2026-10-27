/**
 * R7 — Cấn trừ khoản vay khi duyệt xong phiếu thu / phiếu chi (đánh dấu lúc lập phiếu, v2 §11.2–§11.4).
 *
 * Kích hoạt: `voucher.approved` (mỗi lần duyệt xong là một lượt). Điều kiện: phiếu thu hoặc phiếu chi (engine.ts).
 * Phiếu có `options.offset` (đã kiểm khi lưu): khoản nợ ngân hàng ⇒ liên kết trả nợ `repayment` (tách gốc / lãi / phí, chỉ phiếu chi);
 * công nợ (phải trả với phiếu chi, phải thu với phiếu thu) ⇒ liên kết cấn trừ `offset`. Số tiền = số tiền cấn trừ hiệu lực: toàn bộ phiếu nếu để trống, đọc tại
 * thời điểm duyệt. Liên kết mang nguồn Tự động · R7 (khác với liên kết người dùng gán tay trên tab Liên kết).
 *
 * Duyệt lại sau khi phiếu đổi cấn trừ: liên kết R7 không còn khớp được gỡ trước, rồi gán theo lựa chọn hiện tại.
 * Không gán được (khoản không còn đang vay, hết sức chứa, lãi + phí vượt số tiền…) ⇒ bước lỗi, lượt `Lỗi`: KTT xử lý
 * rồi chạy lại. Phiếu vẫn đã duyệt — việc gán không làm hỏng luồng duyệt.
 */

import { registerRule, type StepContext, type StepOutput } from '../engine.ts';
import { actorOfEvent, big } from '../actions/common.ts';
import { loadVoucher } from '../actions/lookup.ts';
import { ensureAutomationLink, unlinkAutomationLink } from '../actions/link.ts';
import { loanOpenForRepayment, offsetRuleLinksOf } from '../../vouchers/offset.ts';
import { offsetLinkSpecOf, storedOffsetToPlan } from '../../vouchers/rules.ts';

const RULE = 'R7';

registerRule(RULE, {
  occurrenceEvents: ['voucher.approved'],
  steps: [{ name: 'link', run: linkStep }],
});

async function linkStep(ctx: StepContext): Promise<StepOutput> {
  const doc = await loadVoucher(ctx.event.subject_id);
  if (!doc || (doc.kind !== 'spend' && doc.kind !== 'income')) return { skipped: true };
  const documentId = String(doc._id);
  const actor = actorOfEvent(ctx.event);
  const amountMinor = big(doc.amount.minor);
  const plan = storedOffsetToPlan(doc.options?.offset as unknown as Record<string, unknown> | null | undefined);
  const spec = plan ? offsetLinkSpecOf(plan, amountMinor) : null;

  // gỡ liên kết cấn trừ R7 cũ không còn khớp lựa chọn hiện tại (đổi khoản, hoặc bỏ cấn trừ). Cùng khoản thì
  // `ensureAutomationLink` tự đồng bộ số tiền / lãi / phí (gỡ rồi tạo lại khi khác).
  for (const link of await offsetRuleLinksOf(documentId)) {
    if (spec && link.relation === spec.relation && link.to_type === spec.to_type && link.to_id === spec.to_id) continue;
    await unlinkAutomationLink({ linkId: link._id, reason: 'Phiếu đổi khoản cấn trừ — gán theo lựa chọn hiện tại', actor, requestId: ctx.stepKey });
  }
  if (!spec) return { skipped: true };

  if (spec.to_type === 'bank_debt' && !(await loanOpenForRepayment(spec.to_id))) {
    throw new Error('Khoản vay đã chọn không còn đang vay — không cấn trừ được, hãy chọn lại khoản vay');
  }
  await ensureAutomationLink({
    from: { type: 'document', id: documentId },
    to: { type: spec.to_type, id: spec.to_id },
    relation: spec.relation,
    amountMinor: spec.amount_minor,
    split: spec.split,
    runId: ctx.runId,
    ruleCode: RULE,
    actor,
    requestId: ctx.stepKey,
  });
  return { output_type: spec.to_type, output_id: spec.to_id };
}

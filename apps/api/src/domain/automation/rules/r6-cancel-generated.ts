/**
 * R6 — Huỷ phiếu nguồn → cảnh báo / huỷ đối tượng sinh ra CHƯA phát sinh tiền (v2/v2.md §11.3, §11.5 ngoại lệ,
 * §14.3 (6), US-AUTO-06).
 *
 * Kích hoạt: `voucher.cancelled` (+ `voucher.rejected`), điều kiện: phiếu có cờ vay (`loan_kind` khác rỗng).
 * Chỉ xử lý khi phiếu THẬT SỰ bị huỷ / từ chối hẳn (trạng thái hiện tại; phiếu đã gửi lại thì bỏ qua).
 *
 * Khoản vay của phiếu (giải ngân từ phiếu thu, vay để chi từ phiếu chi) — gồm cả khoản tự sinh đã gỡ liên kết
 * (`decideOnSourceFinal`):
 *  - do quy tắc sinh từ phiếu này, chưa có tiền ⇒ HUỶ khoản vay (`cancel_unpaid`);
 *  - do quy tắc sinh từ phiếu này, đã có tiền về ⇒ KHÔNG tự huỷ; cảnh báo KTT (`alert`), giữ liên kết;
 *  - gắn THỦ CÔNG (người dùng chọn trên phiếu, không do phiếu sinh ra) ⇒ chỉ GỠ liên kết (phiếu đã huỷ / từ chối thì
 *    liên kết không còn hiệu lực); khoản vay còn dùng được, KHÔNG cảnh báo — R6 chỉ xử lý đối tượng tự sinh.
 * Phiếu thu do phiếu nguồn sinh ra (liên kết `generated`, VD R3) mà CHƯA thực thi (`approved`) ⇒ HUỶ theo đường
 * chuẩn (`transition` cancel). Không huỷ được ⇒ bước lỗi, lượt `Lỗi` (KTT chạy lại, không tạo trùng).
 */

import { docHref } from '@fingate/shared';
import { registerRule, type StepContext, type StepOutput } from '../engine.ts';
import { FINAL_CANCEL_VOUCHER_STATUSES } from '../policy.ts';
import { actorOfEvent, automationActor, type AutoActor } from '../actions/common.ts';
import { loadVoucher, type VoucherRow } from '../actions/lookup.ts';
import { generatedDocumentIds } from '../actions/link.ts';
import { alertLoansOfSource, releaseLoansOfSource } from '../actions/source.ts';
import { raiseAlert } from '../../alerts/index.ts';
import { loadDoc, transition } from '../../workflow/index.ts';

const RULE = 'R6';

registerRule(RULE, {
  occurrenceEvents: ['voucher.cancelled', 'voucher.rejected'],
  steps: [
    { name: 'cancel_unpaid', run: cancelUnpaidStep },
    { name: 'alert', run: alertStep },
  ],
});

/** Phiếu nguồn đã HUỶ HẲN (trạng thái hiện tại). Đã gửi lại thì null. */
async function finalSourceOf(ctx: StepContext): Promise<VoucherRow | null> {
  const doc = await loadVoucher(ctx.event.subject_id);
  if (!doc || !FINAL_CANCEL_VOUCHER_STATUSES.includes(doc.status)) return null;
  return doc;
}

/** Động từ theo trạng thái huỷ hẳn: "huỷ" hoặc "từ chối". */
const verbOf = (status: string): string => (status === 'rejected' ? 'từ chối' : 'huỷ');

/**
 * Huỷ phiếu thu sinh tự động còn ở `approved` (chưa thực thi) theo đường chuẩn: lịch sử, sổ (không có bút toán),
 * sự kiện `voucher.cancelled`, audit. Chạy lại an toàn: `request_id` = khoá bước + phiếu.
 */
async function cancelGeneratedReceipt(ctx: StepContext, actor: AutoActor, receiptId: string): Promise<void> {
  const receipt = await loadVoucher(receiptId);
  if (!receipt || receipt.status !== 'approved') return; // đã thực thi / đã huỷ: không đụng (đã thực thi ⇒ cảnh báo khoản vay)
  await transition({
    doc: await loadDoc(receiptId),
    actor: automationActor(actor, ['approval:override']),
    body: { action: 'cancel', if_match: receipt.version, request_id: `${ctx.stepKey}#cancel:${receiptId}` },
    ip: null,
  });
}

async function cancelUnpaidStep(ctx: StepContext): Promise<StepOutput> {
  const doc = await finalSourceOf(ctx);
  if (!doc) return { skipped: true };
  const actor = actorOfEvent(ctx.event);
  const sourceId = String(doc._id);
  const reason = `Phiếu ${doc.code} bị ${verbOf(doc.status)}`;
  const cancelledId = await releaseLoansOfSource({ sourceId, reason, actor, requestId: ctx.stepKey });

  for (const receiptId of await generatedDocumentIds(sourceId)) {
    await cancelGeneratedReceipt(ctx, actor, receiptId);
  }
  return cancelledId ? { output_type: 'bank_debt', output_id: cancelledId } : { skipped: true };
}

async function alertStep(ctx: StepContext): Promise<StepOutput> {
  const doc = await finalSourceOf(ctx);
  if (!doc) return { skipped: true };
  const sourceId = String(doc._id);
  let raisedFor: string | null = null;
  for (const { loan } of await alertLoansOfSource(sourceId)) {
    const verb = verbOf(doc.status);
    const text =
      doc.kind === 'spend'
        ? `Khoản vay ${loan.code} đã giải ngân cho phiếu chi ${doc.code} đã ${verb}`
        : `Phiếu thu ${doc.code} đã ${verb} nhưng khoản vay ${loan.code} đã giải ngân`;
    // Loại cảnh báo trong danh mục (v2 §12): fan-out tới KTT + nhãn tiếng Việt; severity 3 (danger).
    await raiseAlert({
      alert_type: 'source_cancelled_with_money',
      company_id: loan.company_id,
      severity: 3,
      text: `${text} — xử lý thủ công (trả nợ sớm hoặc gỡ liên kết)`,
      href: `/ngan-hang/khoan-vay/${loan.id}`,
      subject: { type: 'bank_debt', id: loan.id, source_type: 'document', source_id: sourceId, rule_code: RULE, source_href: docHref(doc.kind, sourceId) },
      dedupe_key: `source_cancelled_with_money:${loan.id}:${sourceId}`,
    });
    raisedFor ??= loan.id;
  }
  return raisedFor ? { output_type: 'bank_debt', output_id: raisedFor } : { skipped: true };
}

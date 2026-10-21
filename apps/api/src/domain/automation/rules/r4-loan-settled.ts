/**
 * R4 — Khoản vay tất toán → nhắc lưu trữ / giải chấp TSĐB (v2/v2.md §11.3 "đề xuất"). MẶC ĐỊNH TẮT.
 *
 * Kích hoạt: `loan.settled` (dư nợ về 0 sau lần trả nợ từ phiếu chi). Bước: notify — cảnh báo nhắc KTT.
 */

import { registerRule, type StepContext, type StepOutput } from '../engine.ts';
import { raiseAutomationAlert } from '../actions/alert.ts';
import { loadLoan } from '../actions/loan.ts';

const RULE = 'R4';

registerRule(RULE, {
  steps: [{ name: 'notify', run: notifyStep }],
});

async function notifyStep(ctx: StepContext): Promise<StepOutput> {
  const loanId = ctx.event.subject_id;
  if (!loanId) return { skipped: true };
  const loan = await loadLoan(loanId);
  if (!loan) return { skipped: true };
  await raiseAutomationAlert({
    companyId: loan.company_id,
    alertType: 'loan_settled',
    severity: 1,
    text: `Khoản vay ${loan.code} đã tất toán — rà soát lưu trữ hồ sơ và giải chấp tài sản bảo đảm (nếu có)`,
    href: `/ngan-hang/khoan-vay/${loan.id}`,
    subject: { type: 'bank_debt', id: loan.id, rule_code: RULE },
    dedupeKey: `loan_settled:${loan.id}`,
  });
  return { output_type: 'bank_debt', output_id: loan.id };
}

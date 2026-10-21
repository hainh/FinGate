/**
 * R5 — Khoản chi định kỳ → phiếu nháp (v2/v2.md §11.3, §6.3). Chuyển từ tác vụ định kỳ của v1 sang bộ máy mới.
 *
 * Kích hoạt: `schedule.recurring` (một sự kiện cho mỗi kỳ đến hạn, do tác vụ `recurring` phát).
 * Bước: create_voucher — phiếu nháp của kỳ (đối tác theo `partner_id`), idempotent theo kỳ.
 */

import { registerRule, type StepContext, type StepOutput } from '../engine.ts';
import { createRecurringDraft } from '../../recurring/index.ts';
import { actorOfEvent } from '../actions/common.ts';

const RULE = 'R5';

registerRule(RULE, {
  occurrenceEvents: ['schedule.recurring'],
  steps: [{ name: 'create_voucher', run: createVoucherStep }],
});

async function createVoucherStep(ctx: StepContext): Promise<StepOutput> {
  const period = typeof ctx.event.payload.period === 'string' ? ctx.event.payload.period : null;
  const plannedDate = typeof ctx.event.payload.planned_date === 'string' ? ctx.event.payload.planned_date : null;
  const ruleId = ctx.event.subject_id;
  if (!period || !plannedDate || !ruleId) throw new Error('Sự kiện lịch thiếu kỳ hoặc ngày dự kiến');

  const res = await createRecurringDraft({
    ruleId,
    period,
    plannedDate,
    runId: ctx.runId,
    requestId: ctx.stepKey,
    actor: actorOfEvent(ctx.event),
  });
  if (!res) return { skipped: true };
  return { output_type: 'document', output_id: res.id };
}

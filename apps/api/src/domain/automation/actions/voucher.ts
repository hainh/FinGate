/**
 * Bước PHIẾU (v2/v2.md §11.5 bước 2–3, §11.6, §14.3 (4)): tạo phiếu sinh tự động và thực thi.
 *
 * - `createAutoVoucher`: tạo phiếu ĐÃ DUYỆT, kế thừa chuỗi duyệt của phiếu nguồn (người duyệt ghi nhận),
 *   nhãn Tự động (`origin`), lịch sử `auto_create`, audit, sự kiện `voucher.created`. Idempotent theo lượt chạy.
 * - `executeAutoVoucher`: thực thi phiếu đã duyệt bằng ĐÚNG hàm `transition()` mà người dùng gọi
 *   (hành động `pay`): lịch sử, sổ cái (bút toán vào/ra), audit, sự kiện `voucher.paid`. Idempotent theo khoá bước
 *   (`request_id` = khoá bước, đã xử lý thì `transition` trả về `skipped`).
 */

import { vnDate, type Role } from '@fingate/shared';
import { Models } from '../../../db/models.ts';
import { nextDocumentCode } from '../../numbering/index.ts';
import { buildHistoryEntry, mirrorAudit } from '../../audit/index.ts';
import { emitVoucherEvent, type VoucherEventSubject } from '../../events/index.ts';
import { loadDoc, transition } from '../../workflow/index.ts';
import type { StepRow } from '../../types.ts';
import { automationActor, type AutoActor } from './common.ts';
import type { StepLike } from './lookup.ts';

/** Các dòng duyệt của phiếu nguồn, chuyển thành dòng của phiếu sinh tự động (đều đã duyệt). */
export function inheritedApprovalSteps(steps: StepLike[] | null | undefined, amountMinor: bigint): StepRow[] {
  const now = new Date();
  return (steps ?? []).map((s) => {
    const skipped = s.state === 'skipped';
    return {
      order: s.order,
      role: s.role as Role,
      user_id: s.user_id ? String(s.user_id) : null,
      delegated_from: s.delegated_from ? String(s.delegated_from) : null,
      state: skipped ? 'skipped' : 'done',
      action: skipped ? null : 'approve',
      decided_at: s.decided_at ?? now,
      opinion: s.opinion ?? null,
      reason: s.reason ?? null,
      sla_deadline: null,
      amount_at_decision: skipped ? null : amountMinor.toString(),
      fast_tracked: Boolean(s.fast_tracked),
    };
  });
}

/** Phiếu do lượt chạy `runId` của quy tắc `ruleCode` đã tạo (idempotency của bước tạo phiếu). */
export async function findAutoVoucher(runId: string, ruleCode: string, kind: 'income' | 'spend'): Promise<{ id: string; code: string; status: string } | null> {
  const row = await Models.Document.findOne({ kind, 'origin.run_id': runId, 'origin.rule_code': ruleCode } as never)
    .select({ _id: 1, code: 1, status: 1 })
    .lean<{ _id: unknown; code: string; status: string } | null>();
  return row ? { id: String(row._id), code: row.code, status: row.status } : null;
}

export interface AutoVoucherSpec {
  kind: 'income' | 'spend';
  companyId: string;
  title: string;
  purpose: string;
  note: string;
  amountMinor: bigint;
  currency: string;
  decimals: number;
  fund: 'bank' | 'cash';
  accountId: string;
  /** Đối tác (theo ID). Phiếu chuyển nội bộ (R1) không có đối tác ngoài ⇒ null (ngoại lệ có ghi nhận, xem docs). */
  partnerId: string | null;
  plannedDate: string;
  businessDate: string;
  /** Chuỗi duyệt của phiếu nguồn (kế thừa). */
  approvalSteps: StepLike[] | null | undefined;
  matrixLabel: string;
  /** Người đứng tên phiếu (người kích hoạt, hoặc người lập phiếu nguồn khi không có). */
  createdBy: string;
  source: { id: string; code: string };
  ruleCode: string;
  runId: string;
  eventType: string;
  actor: AutoActor;
  requestId: string;
}

/** Tạo phiếu thu / chi tự động ở trạng thái ĐÃ DUYỆT (chưa thực thi). */
export async function createAutoVoucher(spec: AutoVoucherSpec): Promise<{ id: string; code: string }> {
  const now = new Date();
  const code = await nextDocumentCode(spec.kind, now);
  const who = { user_id: spec.actor.user_id, role: spec.actor.role, name: spec.actor.name };
  const history = [
    buildHistoryEntry({
      action: 'auto_create',
      actor: who,
      from: null,
      to: 'approved',
      amount_at_decision: spec.amountMinor.toString(),
      request_id: spec.requestId,
      fields: { rule_code: spec.ruleCode, run_id: spec.runId, source_document_id: spec.source.id, source_code: spec.source.code, event_type: spec.eventType },
    }),
  ];
  const created = await Models.Document.create({
    code,
    kind: spec.kind,
    company_id: spec.companyId,
    department_id: null,
    created_by: spec.createdBy,
    status: 'approved',
    version: 1,
    title: spec.title,
    purpose: spec.purpose,
    category_id: null,
    partner_id: spec.partnerId,
    tag_ids: [],
    amount: { minor: spec.amountMinor, currency: spec.currency, decimals: spec.decimals },
    source: { fund: spec.fund, account_id: spec.accountId, group_account_id: null, group_managed: false },
    target: { company_id: null, account_id: null },
    planned_date: spec.plannedDate,
    business_date: spec.businessDate,
    priority: 'normal',
    contract: { code: null, value: null },
    loan_id: null,
    options: { loan: null },
    transfer_target: null,
    origin: { kind: 'automation', run_id: spec.runId, rule_code: spec.ruleCode, source_document_id: spec.source.id },
    budget: { budget_id: null, line_id: null, in_plan: true },
    note: spec.note,
    approval: { matrix_id: null, matrix_version: 0, matrix_label: spec.matrixLabel, steps: inheritedApprovalSteps(spec.approvalSteps, spec.amountMinor) },
    evidence: { required: [], present: [], missing: [] },
    execution: null,
    history,
    created_at: now,
    updated_at: now,
    submitted_at: now,
    closed_at: null,
  } as never);
  const id = String(created._id);

  const subject: VoucherEventSubject = {
    _id: created._id,
    company_id: spec.companyId,
    kind: spec.kind,
    code,
    status: 'approved',
    partner_id: spec.partnerId,
    amount: { minor: spec.amountMinor, currency: spec.currency },
    options: null,
  };
  await emitVoucherEvent('voucher.created', subject, who, {
    from: null,
    to: 'approved',
    action: 'auto_create',
    rule_code: spec.ruleCode,
    run_id: spec.runId,
    source_document_id: spec.source.id,
  });
  await mirrorAudit({
    at: now,
    actor: { user_id: spec.actor.user_id, name: spec.actor.name, role: spec.actor.role },
    action: 'document.auto_create',
    subject: { type: spec.kind, id, code },
    company_id: spec.companyId,
    document_id: id,
    diff_fields: { auto: true, rule_code: spec.ruleCode, source_document_id: spec.source.id, source_code: spec.source.code, amount_minor: spec.amountMinor.toString() },
    request_id: spec.requestId,
  });
  return { id, code };
}

/**
 * Thực thi phiếu đã duyệt (hành động `pay`) qua `transition()` — cùng đường đi với người dùng. Trả về
 * 'already' nếu phiếu đã thanh toán hoặc khoá bước này đã xử lý. Phiếu ở trạng thái khác ⇒ lỗi.
 */
export async function executeAutoVoucher(input: { docId: string; paidAt: string; actor: AutoActor; requestId: string }): Promise<'paid' | 'already'> {
  const doc = await loadDoc(input.docId);
  if (doc.status === 'paid') return 'already';
  if (doc.status !== 'approved' && doc.status !== 'processing') {
    throw new Error(`Phiếu ${doc.code} đang ở trạng thái ${doc.status}, không thực thi tự động được`);
  }
  const res = await transition({
    doc,
    actor: automationActor(input.actor, ['payment:mark']),
    body: {
      action: 'pay',
      if_match: doc.version,
      request_id: input.requestId,
      execution: { paid_at: input.paidAt, actual_amount_minor: doc.amount.minor.toString() },
    },
    ip: null,
  });
  return res.skipped ? 'already' : 'paid';
}

/** Ngày VN hôm nay (ngày nghiệp vụ mặc định của phiếu sinh tự động). */
export function todayVn(): string {
  return vnDate();
}

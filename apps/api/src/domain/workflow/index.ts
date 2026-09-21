/**
 * `transition()` — hàm DUY NHẤT đổi status của hồ sơ (architecture §9.1).
 *
 * Thứ tự BẮT BUỘC:
 *   1. session + `approval:act`
 *   2. verify lại OTP/mật khẩu (hành động nhạy cảm)
 *   3. node `current` đúng user (hoặc delegation đang hiệu lực)
 *   4. `amount ≤ assignment.amount_limit_minor` — sai thì nêu hạn mức trong detail
 *   5. `evidence.missing` rỗng (trừ `approval:override` + `reason`)
 *   6. CAS update MỘT document: status + approval.steps + history[] + version++
 *   7. best-effort: mirror audit_log · notifications · balances_daily
 *   8. email người kế tiếp (không await làm chậm response)
 */

import {
  ACTION_REQUIRES_OPINION,
  ApiError,
  ROLE_LABEL,
  STATUS_REGISTRY,
  formatMoney,
  money,
  statusLabel,
  vnDate,
  type Action,
  type Role,
  type StatusKey,
} from '@fingate/shared';
import { getEnv } from '../../env.ts';
import { Models } from '../../db/models.ts';
import { cas } from '../../db/cas.ts';
import { verifyPassword } from '../../lib/password.ts';
import { decryptField } from '../../lib/crypto.ts';
import { verifyTotp } from '../../lib/totp.ts';
import { buildHistoryEntry, diffFields, mirrorAudit } from '../audit/index.ts';
import { resolveMatrix, type MatrixStep } from './matrix.ts';
import { DEFAULT_CALENDAR, slaDeadline, type WorkingCalendar } from '../calendar/index.ts';
import { nextDocumentCode } from '../numbering/index.ts';
import { notifyNextApprover, rebuildEvidence, syncBalancesForDocument } from '../side-effects.ts';
import {
  applyDecision,
  canTransition,
  currentStep,
  EDITABLE_STATUSES,
  FINAL_APPROVAL_STATUS,
  needsAmountRetype,
  recalcStatusFromSteps,
  requiresStepUp,
  statusForStep,
  type StepState,
} from './state-machine.ts';
import type { ActorInfo, DomainDoc, StepRow } from '../types.ts';

export interface TransitionInput {
  action: Action;
  opinion?: string;
  reason?: string;
  verify?: { method: 'password' | 'otp'; value: string };
  confirm_amount_minor?: string;
  if_match: number;
  request_id: string;
  execution?: { paid_at: string; bank_ref?: string; actual_amount_minor?: string; account_id?: string };
}

export interface TransitionResult {
  document_id: string;
  code: string;
  status: StatusKey;
  version: number;
  next_role: Role | null;
  next_user_ids: string[];
  skipped: boolean;
}

/** đọc hồ sơ ở dạng domain (BigInt đã chuẩn hoá) */
export async function loadDoc(id: string) {
  const doc = await Models.Document.findById(id)
    .select({
      code: 1,
      kind: 1,
      company_id: 1,
      target: 1,
      department_id: 1,
      created_by: 1,
      status: 1,
      version: 1,
      title: 1,
      purpose: 1,
      category_id: 1,
      payee: 1,
      amount: 1,
      source: 1,
      planned_date: 1,
      business_date: 1,
      priority: 1,
      contract: 1,
      loan_id: 1,
      budget: 1,
      rollover: 1,
      approval: 1,
      evidence: 1,
      attachments: 1,
      execution: 1,
      override: 1,
      history: 1,
      processed_requests: 1,
      sla_deadline: 1,
      archived_at: 1,
    })
    .lean();
  if (!doc) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy hồ sơ' });
  if (doc.archived_at) {
    // hồ sơ đã archive (arch §8.7) — chỉ đọc
    throw new ApiError({ code: 'FG-WF-005', detail: 'Hồ sơ đã lưu trữ, chỉ đọc' });
  }
  return doc as unknown as DomainDoc;
}

/* ================================================================== *
 * SUBMIT — resolve matrix + snapshot steps vào phiếu
 * ================================================================== */

export async function submitDocument(input: {
  doc: DomainDoc;
  actor: ActorInfo;
  ifMatch: number;
  requestId: string;
  ip: string | null;
  opinion?: string;
}): Promise<TransitionResult> {
  const { doc, actor } = input;
  if (!EDITABLE_STATUSES.includes(doc.status) && doc.status !== 'changes_requested') {
    throw new ApiError({
      code: 'FG-WF-001',
      detail: `Hồ sơ đang ở trạng thái ${statusLabel(doc.status)}, không gửi lại được`,
    });
  }
  if (String(doc.created_by) !== actor.user_id) {
    throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ người lập mới gửi được hồ sơ' });
  }

  // validate đủ trường bắt buộc theo loại phiếu (blueprint §XXX.1) → FG-WF-008
  const missingFields = requiredFieldsMissing(doc);
  if (missingFields.length) {
    throw new ApiError({
      code: 'FG-WF-008',
      detail: `Thiếu trường bắt buộc: ${missingFields.join(', ')}`,
      errors: Object.fromEntries(missingFields.map((f) => [f, 'Bắt buộc nhập'])),
    });
  }

  const matrix = await resolveMatrix({
    company_id: String(doc.company_id),
    kind: doc.kind,
    amount_minor: doc.amount.minor,
    category_id: doc.category_id ? String(doc.category_id) : null,
  });
  if (!matrix.steps.length) throw new ApiError({ code: 'FG-WF-006' });

  const evidence = await rebuildEvidence(doc);
  let steps: StepRow[] = await assignUsers(
    matrix.steps.map((s, i) => ({
      order: s.order,
      role: s.role,
      user_id: null as string | null,
      state: (i === 0 ? 'current' : 'waiting') as StepRow['state'],
      sla_deadline: null as Date | null,
      action: null,
      decided_at: null,
      opinion: null,
      reason: null,
      amount_at_decision: null,
      delegated_from: null,
      fast_tracked: false,
    })),
    doc,
  );

  const cal = await calendarFor(doc.company_id);
  const now = new Date();

  // KTT lập phiếu → bước kiểm tra kế toán coi như đã duyệt ngay khi gửi, đẩy thẳng
  // lên cấp cao hơn (PGĐ/GĐ/Chủ tịch). Chỉ áp dụng khi người lập đúng là người giữ
  // bước KTT (được gán theo công ty, hoặc chưa gán người nên khớp theo vai trò).
  const kttStep = steps.find((s) => s.role === 'chief_accountant' && s.state === 'current');
  const kttAutoApproved =
    !!kttStep &&
    (kttStep.user_id == null ? actor.role === 'chief_accountant' : String(kttStep.user_id) === actor.user_id);
  if (kttStep && kttAutoApproved) {
    const applied = applyDecision(
      steps.map((s) => ({ ...s })),
      kttStep.order,
      'approve',
    );
    steps = applied.steps as unknown as StepRow[];
    const s = steps.find((x) => x.order === kttStep.order);
    if (s) {
      if (s.user_id == null) s.user_id = actor.user_id;
      s.action = 'approve';
      s.decided_at = now;
      s.opinion = 'KTT lập phiếu — tự động xác nhận bước kế toán';
      s.amount_at_decision = doc.amount.minor.toString();
    }
  }

  const first = currentStep(steps as unknown as StepState[]);
  if (first) {
    const ms = matrix.steps.find((s) => s.role === first.role);
    steps.find((s) => s.order === first.order)!.sla_deadline = slaDeadline(now, ms?.sla_hours ?? 24, cal);
  }

  const status = first ? statusForStep(first.role) : FINAL_APPROVAL_STATUS;

  const history = buildHistoryEntry({
    action: 'submit',
    actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
    from: doc.status,
    to: status,
    amount_at_decision: doc.amount.minor.toString(),
    opinion: input.opinion ?? null,
    request_id: input.requestId,
    ip: input.ip,
    fields: {
      matrix_version: matrix.matrix_version,
      steps: steps.map((s) => `${s.order}:${s.role}`),
      ...(kttAutoApproved ? { ktt_auto_approved: true } : {}),
    },
  });

  const result = await cas<Record<string, unknown>>({
    model: 'Document',
    id: String(doc._id),
    ifMatch: input.ifMatch,
    extraFilter: { status: doc.status },
    set: {
      status,
      approval: { matrix_id: matrix.matrix_id, matrix_version: matrix.matrix_version, matrix_label: matrix.label, steps },
      evidence,
      sla_deadline: steps.find((s) => s.order === first?.order)?.sla_deadline ?? null,
      submitted_at: now,
      // mã phiếu bất biến sau khi gửi: cấp nếu đang là nháp tạm
      ...(doc.code.startsWith('DRAFT-') ? { code: await nextDocumentCode(doc.kind, now) } : {}),
    },
    push: { history },
    addToSet: { processed_requests: input.requestId },
  });
  if (!result) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy hồ sơ' });

  const updated = (result.doc as unknown as DomainDoc).approval.steps;
  void updated;
  await mirrorAudit({
    at: now,
    actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
    action: 'submit',
    subject: { type: doc.kind, id: String(doc._id), code: doc.code },
    company_id: String(doc.company_id),
    document_id: String(doc._id),
    diff_fields: { status: { before: doc.status, after: status } },
    request_id: input.requestId,
    ip: input.ip,
  });
  await syncBalancesForDocument({ doc, from: doc.status, to: status });
  const next = currentStep(steps as unknown as StepState[]);
  void notifyNextApprover({
    doc,
    actorName: actor.name,
    stepRole: next?.role ?? null,
    amountMinor: doc.amount.minor,
    compact: formatMoney(money(doc.amount.minor, doc.amount.currency), { mode: 'compact' }),
  });

  return {
    document_id: String(doc._id),
    code: doc.code,
    status,
    version: result.version,
    next_role: (next?.role as Role) ?? null,
    next_user_ids: next?.user_id ? [next.user_id] : [],
    skipped: false,
  };
}

function requiredFieldsMissing(doc: DomainDoc): string[] {
  const missing: string[] = [];
  if (!doc.title || doc.title.trim().length < 3) missing.push('title');
  if (!doc.purpose || doc.purpose.trim().length < 3) missing.push('purpose');
  if (!doc.payee?.name) missing.push('payee');
  if (!doc.amount?.minor) missing.push('amount');
  if (!doc.planned_date) missing.push('planned_date');
  if (doc.kind !== 'internal' && !doc.source?.account_id && !doc.source?.group_account_id) missing.push('source');
  if (doc.source?.group_managed && !doc.source.group_account_id) missing.push('source.group_account_id');
  if (doc.kind === 'rollover' && !doc.rollover) missing.push('rollover');
  if (doc.kind === 'internal' && !doc.target?.company_id) missing.push('target');
  return missing;
}

/** Gán người duyệt cụ thể cho từng step: assignment theo công ty + role (+ delegation). */
async function assignUsers<T extends StepRow>(steps: T[], doc: DomainDoc): Promise<T[]> {
  const companies = [String(doc.company_id)];
  if (doc.kind === 'internal' && doc.target?.company_id) companies.push(String(doc.target.company_id));

  const assignments = await Models.Assignment.find({
    company_id: { $in: companies },
    status: 'active',
    role: { $in: steps.map((s) => s.role) },
  })
    .select({ user_id: 1, role: 1, company_id: 1, amount_limit_minor: 1 })
    .lean();

  const users = await Models.User.find({ _id: { $in: [...new Set(assignments.map((a) => String(a.user_id)))] }, status: 'active' })
    .select({ _id: 1, display_name: 1 })
    .lean();
  const active = new Set(users.map((u) => String(u._id)));

  for (const step of steps) {
    const candidates = assignments.filter((a) => String(a.role) === step.role && active.has(String(a.user_id)));
    // ưu tiên người cùng công ty nguồn; internal transfer: đủ người 2 công ty -> lấy công ty nguồn
    const chosen = candidates[0];
    step.user_id = chosen ? String(chosen.user_id) : null;
  }
  return applyDelegations(steps, doc.company_id);
}

/** Ủy quyền đang hiệu lực (APPR-04) — node vẫn là của người được ủy, history ghi `delegated_from`. */
async function applyDelegations<T extends StepRow>(steps: T[], companyId: string): Promise<T[]> {
  const now = new Date();
  const orders = steps.filter((s) => s.user_id).map((s) => s.user_id as string);
  if (!orders.length) return steps;
  const dels = await Models.Delegation.find({
    user_id: { $in: orders },
    status: 'active',
    valid_from: { $lte: now },
    valid_to: { $gte: now },
  }).lean();
  if (!dels.length) return steps;
  const byFrom = new Map(dels.map((d) => [String(d.user_id), d]));
  for (const step of steps) {
    if (!step.user_id) continue;
    const d = byFrom.get(step.user_id);
    if (!d) continue;
    if (step.role && d.role && d.role !== step.role) continue;
    step.delegated_from = step.user_id;
    step.user_id = String(d.to_user_id);
  }
  void companyId;
  return steps;
}

async function calendarFor(companyId: string): Promise<WorkingCalendar> {
  const c = await Models.Company.findById(companyId).select({ working_calendar: 1 }).lean();
  const wc = c?.working_calendar as { workdays?: number[]; holidays?: string[] } | undefined;
  return { workdays: wc?.workdays ?? DEFAULT_CALENDAR.workdays, holidays: wc?.holidays ?? [] };
}

/* ================================================================== *
 * TRANSITION — approve / reject / changes / pay / cancel
 * ================================================================== */

export async function transition(input: {
  doc: DomainDoc;
  actor: ActorInfo;
  body: TransitionInput;
  ip: string | null;
}): Promise<TransitionResult> {
  const { doc, actor, body } = input;
  const action = body.action;

  // 1. submit đi đường riêng
  if (action === 'submit') {
    return submitDocument({ doc, actor, ifMatch: body.if_match, requestId: body.request_id, ip: input.ip, opinion: body.opinion });
  }

  const target = canTransition(doc.status, action);
  if (!target) {
    throw new ApiError({
      code: 'FG-WF-001',
      detail: `Không thể "${action}" khi hồ sơ đang ở "${statusLabel(doc.status)}"`,
    });
  }

  // idempotency: cùng request_id đã xử lý → trả nguyên trạng (arch §6)
  if ((doc.processed_requests ?? []).includes(body.request_id)) {
    return {
      document_id: String(doc._id),
      code: doc.code,
      status: doc.status,
      version: doc.version,
      next_role: currentStep(doc.approval?.steps as StepState[] | undefined ?? [])?.role ?? null,
      next_user_ids: [],
      skipped: true,
    };
  }

  const isApproval = action === 'approve' || action === 'approve_with_reason';
  const isDecision = isApproval || action === 'reject' || action === 'request_changes';

  if (isDecision && !actor.permissions.includes('approval:act')) {
    throw new ApiError({ code: 'FG-RBAC-001', detail: 'Bạn không có quyền duyệt hồ sơ' });
  }
  if (action === 'pay' && !actor.permissions.includes('payment:mark')) {
    throw new ApiError({ code: 'FG-RBAC-001', detail: 'Bạn không có quyền ghi nhận thanh toán' });
  }
  if (action === 'cancel' && String(doc.created_by) !== actor.user_id && !actor.permissions.includes('approval:override')) {
    throw new ApiError({ code: 'FG-RBAC-001' });
  }

  // 2. step-up verify cho hành động nhạy cảm (§7.2) — mặc định TẮT (APPROVAL_STEP_UP=false)
  if (requiresStepUp(action) && getEnv().APPROVAL_STEP_UP === 'true') {
    await assertStepUp(actor.user_id, body.verify);
  }

  const steps = (doc.approval?.steps ?? []) as StepRow[];
  if (!steps.length && isDecision) throw new ApiError({ code: 'FG-WF-006' });

  // 3. đúng người? fast-track: step của mình có thể đang `waiting`
  //    Bước chưa gán người (`user_id: null`, cấu hình người duyệt thêm sau khi gửi)
  //    → ai đúng vai trò cũng xử lý được; người xử lý sẽ "nhận" bước đó.
  const myStep = isDecision
    ? steps
        .filter(
          (s) =>
            (s.state === 'current' || s.state === 'waiting') &&
            (s.user_id != null ? String(s.user_id) === actor.user_id : s.role === actor.role),
        )
        .sort((a, b) => a.order - b.order)[0]
    : null;
  // tự duyệt bị chặn (blueprint §III). Ngoại lệ: bước kiểm tra KTT khi chính KTT lập
  // phiếu → coi như KTT đã kiểm tra, chỉ chặn tự duyệt ở các cấp cao hơn (PGĐ/GĐ/Chủ tịch).
  if (isDecision && myStep && String(doc.created_by) === actor.user_id && myStep.role !== 'chief_accountant') {
    throw new ApiError({ code: 'FG-WF-009' });
  }
  if (isDecision && !myStep) {
    const holder = steps.find((s) => s.state === 'current');
    throw new ApiError({
      code: 'FG-WF-002',
      detail: holder
        ? `Hồ sơ đang ở bước ${holder.order} · ${ROLE_LABEL[holder.role] ?? holder.role}`
        : 'Hồ sơ không còn ở bước nào chờ bạn duyệt',
    });
  }

  // 4. hạn mức duyệt — nêu rõ hạn mức trong detail (FG-RBAC-012)
  if (isDecision && doc.amount.minor > actor.amount_limit_minor) {
    throw new ApiError({
      code: 'FG-RBAC-012',
      detail: `Khoản ${formatMoney(money(doc.amount.minor, doc.amount.currency), { mode: 'compact' })} vượt hạn mức duyệt ${formatMoney(
        money(actor.amount_limit_minor, doc.amount.currency),
        { mode: 'compact' },
      )} của bạn`,
      data: { amount_limit_minor: actor.amount_limit_minor.toString(), amount_minor: doc.amount.minor.toString() },
    });
  }

  // 5. chứng từ bắt buộc — trừ khi có override + lý do
  const evidence = await rebuildEvidence(doc);
  const overriding = evidence.missing.length > 0 && isDecision;
  if (overriding) {
    if (!actor.permissions.includes('approval:override')) {
      throw new ApiError({
        code: 'FG-WF-003',
        detail: `Thiếu chứng từ bắt buộc: ${evidence.missing.join(', ')}`,
        data: { missing: evidence.missing },
      });
    }
    if (!body.reason || body.reason.trim().length < 20) {
      throw new ApiError({ code: 'FG-WF-004', detail: 'Bỏ qua chứng từ thiếu cần lý do >= 20 ký tự', errors: { reason: 'Cần nêu rõ lý do' } });
    }
  }

  // 6. CAS — status + step + history[] + version++ trong MỘT update
  const now = new Date();
  const businessDate = vnDate(now);
  let nextStatus: StatusKey = target;
  let nextSteps = steps;
  let finished: boolean;
  let skipped: StepState[] = [];

  if (isDecision && myStep) {
    const decision = action === 'reject' ? 'reject' : action === 'request_changes' ? 'changes' : 'approve';
    const applied = applyDecision(
      steps.map((s) => ({ ...s })),
      myStep.order,
      decision,
    );
    nextSteps = applied.steps as unknown as StepRow[];
    finished = applied.finished;
    skipped = nextSteps.filter((s) => s.state === 'skipped');

    if (action === 'approve_with_reason') {
      // fast-track: cấp cao hơn duyệt trước — status vẫn theo cấp thấp nhất chưa duyệt
      nextStatus = recalcStatusFromSteps(nextSteps as StepState[]);
      const s = nextSteps.find((x) => x.order === myStep.order);
      if (s) s.fast_tracked = true;
    } else if (decision === 'approve') {
      nextStatus = finished ? 'approved' : recalcStatusFromSteps(nextSteps as StepState[]);
    } else if (decision === 'reject') {
      nextStatus = 'rejected';
    } else {
      nextStatus = 'changes_requested';
    }
    const s = nextSteps.find((x) => x.order === myStep.order);
    if (s) {
      if (s.user_id == null) s.user_id = actor.user_id;
      s.action = action;
      s.decided_at = now;
      s.opinion = body.opinion ?? null;
      s.reason = body.reason ?? null;
      s.amount_at_decision = doc.amount.minor.toString();
    }
  }

  if (action === 'pay') {
    // "Thực thi": ngày thực chi mặc định là ngày nghiệp vụ hôm nay nếu client không gửi
    nextStatus = 'paid';
  }
  if (action === 'queue_payment') nextStatus = 'processing';
  if (action === 'expire') nextStatus = 'expired';
  if (action === 'cancel') nextStatus = 'cancelled';

  // ý kiến bắt buộc
  if (ACTION_REQUIRES_OPINION[action] && !((body.reason ?? '') || (body.opinion ?? '')).trim()) {
    throw new ApiError({ code: 'FG-WF-004', detail: 'Hành động này cần ý kiến hoặc lý do' });
  }

  // gõ lại số tiền cho khoản lớn / ngoài ngân sách (DS §7.14 rule 4)
  const inPlan = doc.budget?.in_plan !== false;
  if (isDecision && needsAmountRetype(doc.amount.minor, inPlan) && body.confirm_amount_minor !== doc.amount.minor.toString()) {
    throw new ApiError({
      code: 'FG-WF-007',
      detail: 'Khoản vượt ngưỡng hoặc ngoài ngân sách — cần gõ lại số tiền để xác nhận',
      data: { need_confirm_amount: true, amount_minor: doc.amount.minor.toString(), in_plan: inPlan },
    });
  }

  const cal = await calendarFor(doc.company_id);
  const nextStepAfter = isDecision ? currentStep(nextSteps as StepState[]) : nextStatus === 'approved' ? null : currentStep(steps as StepState[]);
  if (nextStepAfter) {
    const targetStep = nextSteps.find((s) => s.order === nextStepAfter.order);
    if (targetStep) {
      const matrixSteps = (await resolveMatrix({
        company_id: String(doc.company_id),
        kind: doc.kind,
        amount_minor: doc.amount.minor,
        category_id: doc.category_id ? String(doc.category_id) : null,
      })).steps;
      const ms: MatrixStep | undefined = matrixSteps.find((s) => s.role === targetStep.role);
      targetStep.sla_deadline = slaDeadline(now, ms?.sla_hours ?? 24, cal);
    }
  }

  const entry = buildHistoryEntry({
    action,
    actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
    from: doc.status,
    to: nextStatus,
    amount_at_decision: doc.amount.minor.toString(),
    opinion: body.opinion ?? null,
    reason: body.reason ?? null,
    request_id: body.request_id,
    ip: input.ip,
    fields: {
      ...(overriding ? { evidence_override: evidence.missing } : {}),
      ...(isDecision ? { skipped: skipped.map((s) => s.order) } : {}),
      ...(myStep ? { step_order: myStep.order } : {}),
    },
  });

  const set: Record<string, unknown> = { status: nextStatus };
  if (isDecision) set['approval.steps'] = nextSteps;
  if (isDecision) set.sla_deadline = nextStepAfter
    ? nextSteps.find((s) => s.order === nextStepAfter.order)?.sla_deadline ?? null
    : null;
  if (overriding) set.override = { fast_tracked: doc.override?.fast_tracked ?? action === 'approve_with_reason', reason: body.reason ?? null, by: actor.user_id };
  else if (action === 'approve_with_reason') set['override.fast_tracked'] = true;
  if (action === 'pay') {
    set.execution = {
      paid_at: body.execution?.paid_at ?? businessDate,
      bank_ref: body.execution?.bank_ref ?? null,
      executed_by: actor.user_id,
      actual_amount_minor: body.execution?.actual_amount_minor
        ? BigInt(body.execution.actual_amount_minor)
        : doc.amount.minor,
      actual_amount: {
        minor: BigInt(body.execution?.actual_amount_minor ?? doc.amount.minor.toString()),
        currency: doc.amount.currency,
        decimals: doc.amount.decimals ?? 0,
      },
    };
    if (body.execution?.account_id) set['source.account_id'] = body.execution.account_id;
  }
  if (['paid', 'rejected', 'cancelled', 'expired'].includes(nextStatus)) set.closed_at = now;
  if (isDecision || action === 'pay') set.evidence = evidence;

  const result = await cas<Record<string, unknown>>({
    model: 'Document',
    id: String(doc._id),
    ifMatch: body.if_match,
    extraFilter: { status: doc.status },
    set,
    push: { history: entry },
    addToSet: { processed_requests: body.request_id },
  });
  if (!result) throw new ApiError({ code: 'FG-WF-011', detail: 'Hồ sơ vừa được cập nhật bởi người khác' });

  // 7. best-effort side effects — lỗi ở đây KHÔNG làm hỏng nghiệp vụ đã commit
  await mirrorAudit({
    at: now,
    actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
    action,
    subject: { type: doc.kind, id: String(doc._id), code: doc.code },
    company_id: String(doc.company_id),
    document_id: String(doc._id),
    diff_fields: { status: { before: doc.status, after: nextStatus }, ...(isDecision ? { step: { before: myStep?.order, after: nextStepAfter?.order ?? null } } : {}) },
    request_id: body.request_id,
    ip: input.ip,
  });
  await syncBalancesForDocument({ doc, from: doc.status, to: nextStatus, execution: set.execution as never });

  // 8. thông báo cho cấp kế tiếp (email không await — arch §6)
  if (isDecision || action === 'pay' || action === 'queue_payment') {
    void notifyNextApprover({
      doc,
      actorName: actor.name,
      stepRole: nextStepAfter?.role ?? null,
      amountMinor: doc.amount.minor,
      compact: formatMoney(money(doc.amount.minor, doc.amount.currency), { mode: 'compact' }),
      status: nextStatus,
      statusLabel: STATUS_REGISTRY[nextStatus]?.labelVi ?? nextStatus,
    });
  }

  return {
    document_id: String(doc._id),
    code: doc.code,
    status: nextStatus,
    version: result.version,
    next_role: (nextStepAfter?.role as Role) ?? null,
    next_user_ids: nextStepAfter?.user_id ? [nextStepAfter.user_id] : [],
    skipped: false,
  };
}

/** Re-verify mật khẩu hoặc OTP trước hành động nhạy cảm (ADR-14). */
export async function assertStepUp(
  userId: string,
  verify: { method: 'password' | 'otp'; value: string } | undefined,
): Promise<void> {
  if (!verify) {
    throw new ApiError({
      code: 'FG-AUTH-008',
      status: 401,
      detail: 'Hành động này cần xác thực lại: nhập mật khẩu hoặc mã OTP',
      data: { need_verify: true },
    });
  }
  const user = await Models.User.findById(userId)
    .select({ password: 1, totp: 1, recovery_codes: 1 })
    .lean<{
      password?: { hash?: string; salt?: string };
      totp?: { enabled?: boolean; secret_enc?: string | null };
      recovery_codes?: { hash?: string; used_at?: Date | null }[];
    } | null>();
  if (!user) throw new ApiError({ code: 'FG-AUTH-001' });

  if (verify.method === 'password') {
    const ok = await verifyPassword(verify.value, user.password);
    if (!ok) throw new ApiError({ code: 'FG-AUTH-008' });
    return;
  }

  const secret = decryptField(user.totp?.secret_enc);
  if (!secret) throw new ApiError({ code: 'FG-AUTH-008', detail: 'Tài khoản chưa bật OTP' });
  if (verifyTotp(verify.value, secret)) return;

  // recovery code dùng một lần
  const codes = user.recovery_codes ?? [];
  const { hashToken } = await import('../../lib/password.ts');
  const h = hashToken(verify.value.trim().toUpperCase());
  const match = codes.find((c) => c.hash === h && !c.used_at);
  if (!match) throw new ApiError({ code: 'FG-AUTH-006' });
  await Models.User.updateOne(
    { _id: userId, 'recovery_codes.hash': h },
    { $set: { 'recovery_codes.$.used_at': new Date() } },
  ).exec();
}

/** Kiểm tra nhanh xem người dùng có phải đang giữ node nào không (cho entitlement per doc). */
export function holdsStep(steps: StepRow[], userId: string): boolean {
  return steps.some((s) => s.user_id != null && String(s.user_id) === userId && (s.state === 'current' || s.state === 'waiting'));
}

export function diffForAudit(before: Record<string, unknown>, after: Record<string, unknown>) {
  return diffFields(before, after);
}

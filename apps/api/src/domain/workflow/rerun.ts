/**
 * CHẠY LẠI phê duyệt cho hồ sơ ĐANG CHỜ khi ma trận duyệt hoặc nhân sự thay đổi.
 *
 * Mỗi hồ sơ snapshot chuỗi duyệt tại thời điểm gửi; khi cấu hình thay đổi (thêm/sửa
 * ma trận, thêm/xoá/chuyển nhân sự) chuỗi cũ có thể trỏ sai bàn hoặc kẹt ở chức danh
 * khuyết. Hàm này tính lại các bước CÒN phải duyệt theo ma trận hiện hành + phân công
 * hiện hành, GIỮ NGUYÊN các bước đã quyết định (done/skipped/rejected = lịch sử), rồi
 * cập nhật `status`/`sla_deadline` để hồ sơ nằm đúng bàn cấp cần duyệt.
 *
 * Chạy best-effort cho từng hồ sơ: hồ sơ nào CAS trượt (có người vừa duyệt) thì bỏ qua.
 */

import {
  ApiError,
  APPROVAL_ORDER,
  STATUS_REGISTRY,
  formatMoney,
  money,
  type DocKind,
  type Role,
} from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { cas } from '../../db/cas.ts';
import { buildHistoryEntry, mirrorAudit } from '../audit/index.ts';
import { slaDeadline } from '../calendar/index.ts';
import { notifyNextApprover } from '../side-effects.ts';
import { DECISION_STATUSES } from '../queries/index.ts';
import { resolveMatrix } from './matrix.ts';
import { calendarFor, assignUsers, newStep } from './index.ts';
import { dropVacantSteps, FINAL_APPROVAL_STATUS, pendingRolesForRerun, statusForStep } from './state-machine.ts';
import type { DomainDoc, StepRow } from '../types.ts';

export interface RerunChange {
  document_id: string;
  code: string;
  from: string;
  to: string;
  steps: string[];
}

export interface RerunResult {
  /** số hồ sơ đang chờ đã quét. */
  scanned: number;
  /** số hồ sơ được gán lại (chuỗi bước/người/trạng thái thực sự đổi). */
  changed: number;
  /** số hồ sơ giữ nguyên (đã đúng, hoặc không còn người để gán). */
  skipped: number;
  documents: RerunChange[];
}

export interface RerunInput {
  reason: string;
  actor?: { user_id: string | null; name: string; role: Role | null } | null;
  /** null/undefined = mọi công ty; mảng = chỉ các công ty này. */
  companyIds?: string[] | null;
  kinds?: DocKind[];
  requestId?: string | null;
  ip?: string | null;
}

const normId = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Chuỗi rút gọn để so sánh đổi/không (bỏ các field lịch sử như opinion/decided_at). */
function signature(steps: StepRow[]): string {
  return JSON.stringify(
    steps.map((s) => ({
      order: s.order,
      role: s.role,
      user_id: normId(s.user_id),
      state: s.state,
      delegated_from: normId(s.delegated_from),
    })),
  );
}

/**
 * Chạy lại toàn bộ hồ sơ đang chờ (pending.*). Trả thống kê để route hiển thị cho admin.
 * Không bao giờ ném lỗi vì một hồ sơ lẻ — lỗi được log và tính là `skipped`.
 */
export async function rerunPendingApprovals(input: RerunInput): Promise<RerunResult> {
  const filter: Record<string, unknown> = { status: { $in: [...DECISION_STATUSES] } };
  if (input.companyIds && input.companyIds.length) filter.company_id = { $in: input.companyIds.map(String) };
  if (input.kinds && input.kinds.length) filter.kind = { $in: input.kinds };

  const rows = await Models.Document.find(filter as never)
    .select({ code: 1, kind: 1, company_id: 1, target: 1, category_id: 1, amount: 1, status: 1, version: 1, created_by: 1, approval: 1 })
    .lean();

  const result: RerunResult = { scanned: rows.length, changed: 0, skipped: 0, documents: [] };
  for (const raw of rows) {
    try {
      const change = await rerunOne(raw as unknown as DomainDoc, input);
      if (change) {
        result.changed++;
        result.documents.push(change);
      } else {
        result.skipped++;
      }
    } catch (err) {
      result.skipped++;
      console.warn(`[rerun] bỏ qua ${(raw as { code?: string }).code ?? '?'}: ${(err as Error).message}`);
    }
  }
  return result;
}

/** Tính lại một hồ sơ; trả mô tả thay đổi hoặc null nếu không đổi / không gán được người. */
async function rerunOne(doc: DomainDoc, input: RerunInput): Promise<RerunChange | null> {
  const oldSteps = (doc.approval?.steps ?? []) as StepRow[];
  const frozen = oldSteps.filter((s) => s.state === 'done' || s.state === 'skipped' || s.state === 'rejected');

  const matrix = await resolveMatrix({
    company_id: String(doc.company_id),
    kind: doc.kind,
    amount_minor: doc.amount.minor,
    category_id: doc.category_id ? String(doc.category_id) : null,
  });

  const roles = pendingRolesForRerun(
    frozen.map((s) => s.role),
    matrix.steps.map((s) => s.role),
  );

  // Các cấp còn phải duyệt nhưng ma trận mới đã hoàn tất (không còn cấp nào) → để yên,
  // không tự chuyển "duyệt xong" (tránh hồ sơ nhảy thẳng sang đã duyệt ngoài ý muốn).
  if (!roles.length) return null;

  const assigned = await assignUsers(roles.map((role, i) => newStep(i + 1, role, 'waiting')), doc);
  const { steps: pending, dropped } = dropVacantSteps(assigned);
  // Không còn ai phụ trách bất kỳ cấp nào → giữ nguyên hồ sơ (không tự duyệt).
  if (!pending.length) return null;

  const merged: StepRow[] = [...frozen, ...pending].sort(
    (a, b) => APPROVAL_ORDER.indexOf(a.role) - APPROVAL_ORDER.indexOf(b.role),
  );
  merged.forEach((s, i) => {
    s.order = i + 1;
  });

  let first: StepRow | null = null;
  for (const s of merged) {
    if (s.state === 'current' || s.state === 'waiting') {
      s.state = first ? 'waiting' : 'current';
      if (!first) first = s;
    }
  }

  const cal = await calendarFor(String(doc.company_id));
  const now = new Date();
  const firstRole = first?.role;
  if (first && firstRole) {
    const ms = matrix.steps.find((s) => s.role === firstRole);
    first.sla_deadline = slaDeadline(now, ms?.sla_hours ?? 24, cal);
  }

  const status = first ? statusForStep(first.role) : FINAL_APPROVAL_STATUS;
  const assignChanged = signature(merged) !== signature(oldSteps);
  const matrixVersionChanged = Number(matrix.matrix_version) !== Number(doc.approval?.matrix_version ?? 0);
  if (!assignChanged && !matrixVersionChanged && status === doc.status) return null;

  const history = buildHistoryEntry({
    action: 'rerun',
    actor: input.actor ?? { user_id: null, role: null, name: 'Hệ thống' },
    from: doc.status,
    to: status,
    opinion: input.reason,
    request_id: input.requestId ?? null,
    ip: input.ip ?? null,
    fields: {
      reason: input.reason,
      matrix_version: { before: doc.approval?.matrix_version ?? 0, after: matrix.matrix_version },
      steps: merged.map((s) => `${s.order}:${s.role}:${normId(s.user_id) ?? '-'}`),
      ...(dropped.length ? { vacant_steps: dropped.map((d) => `${d.order}:${d.role}`) } : {}),
    },
  });

  const set: Record<string, unknown> = {
    status,
    approval: { matrix_id: matrix.matrix_id, matrix_version: matrix.matrix_version, matrix_label: matrix.label, steps: merged },
    sla_deadline: first?.sla_deadline ?? null,
  };

  let updated: Awaited<ReturnType<typeof cas>>;
  try {
    updated = await cas({
      model: 'Document',
      id: String(doc._id),
      ifMatch: doc.version,
      extraFilter: { status: doc.status },
      set,
      push: { history },
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'FG-WF-011') return null; // ai đó vừa duyệt — bỏ qua
    throw err;
  }
  if (!updated) return null;

  const updatedDoc: DomainDoc = {
    ...doc,
    status,
    approval: { matrix_id: matrix.matrix_id, matrix_version: matrix.matrix_version, matrix_label: matrix.label, steps: merged },
  };
  await mirrorAudit({
    at: now,
    actor: { user_id: input.actor?.user_id ?? null, name: input.actor?.name ?? 'Hệ thống', role: input.actor?.role ?? null },
    action: 'rerun',
    subject: { type: doc.kind, id: String(doc._id), code: doc.code },
    company_id: String(doc.company_id),
    document_id: String(doc._id),
    diff_fields: { status: { before: doc.status, after: status }, step: { after: first?.order ?? null } },
    request_id: input.requestId ?? null,
    ip: input.ip ?? null,
  });
  // Chỉ báo lại khi người/bước thực sự đổi (tránh spam khi chỉ tăng version ma trận).
  if (assignChanged) {
    void notifyNextApprover({
      doc: updatedDoc,
      actorName: input.actor?.name ?? 'Hệ thống',
      stepRole: (first?.role as Role) ?? null,
      amountMinor: doc.amount.minor,
      compact: formatMoney(money(doc.amount.minor, doc.amount.currency), { mode: 'compact' }),
      status,
      statusLabel: STATUS_REGISTRY[status]?.labelVi ?? status,
    });
  }

  return {
    document_id: String(doc._id),
    code: doc.code,
    from: doc.status,
    to: status,
    steps: merged.map((s) => `${s.order}:${s.role}:${normId(s.user_id) ?? '-'}`),
  };
}

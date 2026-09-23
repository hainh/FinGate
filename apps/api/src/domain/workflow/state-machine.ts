/**
 * Máy trạng thái hồ sơ — CHỖ DUY NHẤT được đổi `status` (K-16, ADR-11).
 *
 *   draft → pending.ktt → pending.pgd → pending.gd → pending.ptg → pending.chairman
 *             ↓ changes_requested (resubmit → node đầu)
 *             ↓ rejected · cancelled · expired
 *                                   payment_queued → paid
 *
 * Fast-track (blueprint §IV): mọi cấp trong quy trình đều thấy và duyệt ngay được;
 * thứ tự chỉ xác định cấp CAO NHẤT BẮT BUỘC. Status luôn phản ánh cấp thấp nhất chưa duyệt.
 */

import { APPROVAL_ORDER, type Action, type DocKind, type Role, type StatusKey } from '@fingate/shared';

/** đồ thị chuyển trạng thái — test mọi cạnh (arch §15 unit). */
export const TRANSITIONS: Record<StatusKey, Partial<Record<Action, StatusKey>>> = {
  draft: { submit: 'pending.ktt', cancel: 'cancelled' },
  'pending.ktt': {
    approve: 'pending.pgd',
    approve_with_reason: 'pending.pgd',
    reject: 'rejected',
    request_changes: 'changes_requested',
  },
  'pending.pgd': {
    approve: 'pending.gd',
    approve_with_reason: 'pending.gd',
    reject: 'rejected',
    request_changes: 'changes_requested',
  },
  'pending.gd': {
    approve: 'pending.ptg',
    approve_with_reason: 'pending.ptg',
    reject: 'rejected',
    request_changes: 'changes_requested',
  },
  'pending.ptg': {
    approve: 'pending.chairman',
    approve_with_reason: 'pending.chairman',
    reject: 'rejected',
    request_changes: 'changes_requested',
  },
  'pending.chairman': {
    approve: 'approved',
    approve_with_reason: 'approved',
    reject: 'rejected',
    request_changes: 'changes_requested',
  },
  // duyệt xong cấp cao nhất → kế toán viên "thực thi" (pay) trực tiếp, hoặc đưa vào hàng thanh toán
  approved: { pay: 'paid', queue_payment: 'processing', cancel: 'cancelled' },
  processing: { pay: 'paid', request_changes: 'changes_requested' },
  paid: {},
  rejected: { submit: 'pending.ktt' },
  changes_requested: { submit: 'pending.ktt', cancel: 'cancelled' },
  cancelled: {},
  expired: { submit: 'pending.ktt' },
  overdue: {},
};

/** loại hồ sơ → node đầu sau khi submit */
export const FIRST_NODE: Record<DocKind, StatusKey> = {
  spend: 'pending.ktt',
  income: 'pending.ktt',
  rollover: 'pending.ktt',
  internal: 'pending.ktt',
};

export const FINAL_APPROVAL_STATUS: StatusKey = 'approved';

/** trạng thái cho phép người lập sửa & gửi lại nội dung hồ sơ (CHI-03) */
export const EDITABLE_STATUSES: StatusKey[] = ['draft', 'changes_requested', 'rejected'];

/** trạng thái đã "khóa" với người tạo — chỉ cấp duyệt/có quyền override mới xử lý được */
export const LOCKED_STATUSES: StatusKey[] = [
  'pending.ktt',
  'pending.pgd',
  'pending.gd',
  'pending.ptg',
  'pending.chairman',
  'approved',
  'processing',
  'paid',
];

export const READONLY_AFTER = FINAL_APPROVAL_STATUS;

export function canTransition(from: StatusKey, action: Action): StatusKey | null {
  return TRANSITIONS[from]?.[action] ?? null;
}

/**
 * Trạng thái "đang ở bàn ai" = cấp THẤP NHẤT chưa duyệt (blueprint §IV).
 * `steps` đã snapshot theo matrix; mỗi step có `state` waiting|current|done|skipped|rejected.
 */
export function recalcStatusFromSteps(steps: StepState[], allApprovedStatus: StatusKey = 'approved'): StatusKey {
  const lowest = steps.filter((s) => s.state === 'current' || s.state === 'waiting').sort((a, b) => a.order - b.order)[0];
  if (!lowest) return allApprovedStatus;
  return statusForStep(lowest.role);
}

/** role duyệt → status key hiển thị (DS §3.1). */
export function statusForStep(role: Role): StatusKey {
  switch (role) {
    case 'chief_accountant':
      return 'pending.ktt';
    case 'deputy_director':
      return 'pending.pgd';
    case 'director':
      return 'pending.gd';
    case 'deputy_chairman':
      return 'pending.ptg';
    case 'chairman':
      return 'pending.chairman';
    default:
      return 'pending.ktt';
  }
}

export interface StepState {
  order: number;
  role: Role;
  state: 'waiting' | 'current' | 'done' | 'skipped' | 'rejected';
  user_id?: string | null;
}

/**
 * Đánh dấu một step đã duyệt + tính lại state các step còn lại.
 * Cấp cao hơn duyệt trước (fast-track) → các cấp trung gian chưa xử lý = `skipped`
 * khi hồ sơ đạt cấp cao nhất; KHÔNG xoá, audit giữ nguyên (blueprint §IV).
 */
export function applyDecision(
  steps: { order: number; role: Role; state: string; user_id?: string | null }[],
  decidedOrder: number,
  decision: 'approve' | 'reject' | 'changes',
): { steps: StepState[]; finished: boolean } {
  const next = steps.map((s) => ({ ...s, state: s.state as StepState['state'] }));
  const idx = next.findIndex((s) => s.order === decidedOrder);
  if (idx < 0) return { steps: next, finished: false };

  if (decision === 'reject') {
    next[idx]!.state = 'rejected';
    return { steps: next, finished: true };
  }
  if (decision === 'changes') {
    // trả về bổ sung: mọi step về trạng thái chờ người tạo xử lý
    next[idx]!.state = 'waiting';
    for (let i = 0; i < idx; i++) if (next[i]!.state === 'done') next[i]!.state = 'waiting';
    return { steps: next, finished: false };
  }

  next[idx]!.state = 'done';
  const highestOrder = Math.max(...next.map((s) => s.order));
  const topDone = next.find((s) => s.order === highestOrder)?.state === 'done';
  if (topDone) {
    // hồ sơ đạt cấp cao nhất → các cấp chưa xử lý = skipped (giữ lịch sử, không xóa)
    for (const s of next) if (s.state === 'waiting' || s.state === 'current') s.state = 'skipped';
  } else {
    // cấp thấp nhất chưa xử lý thành `current`
    const lowestPending = next.filter((s) => s.state === 'waiting').sort((a, b) => a.order - b.order)[0];
    if (lowestPending) lowestPending.state = 'current';
  }
  return { steps: next, finished: topDone };
}

/** Bước tiếp theo cần ai đó làm gì (để chọn sla_deadline + notification). */
export function currentStep(steps: StepState[]): StepState | null {
  const pending = steps.filter((s) => s.state === 'current' || s.state === 'waiting');
  if (!pending.length) return null;
  return pending.sort((a, b) => a.order - b.order)[0]!;
}

export function isTerminal(status: StatusKey): boolean {
  return status === 'paid' || status === 'rejected' || status === 'cancelled' || status === 'expired';
}

export function isApprovalAction(action: Action): boolean {
  return action === 'approve' || action === 'approve_with_reason';
}

/** Hành động nào yêu cầu step-up verify (arch §7.2, ADR-14). */
export function requiresStepUp(action: Action): boolean {
  return action === 'approve' || action === 'approve_with_reason' || action === 'reject' || action === 'pay';
}

/** Gõ lại số tiền khi > 5 tỷ hoặc ngoài ngân sách (DS §7.14 rule 4). */
export const RETYPE_THRESHOLD_MINOR = 5_000_000_000n;

export function needsAmountRetype(amountMinor: bigint, inPlan: boolean, thresholdMinor: bigint = RETYPE_THRESHOLD_MINOR): boolean {
  return amountMinor > thresholdMinor || !inPlan;
}

/* ------------------------------------------------------------------ *
 * Feature: "Nếu cty thiếu chức danh nào thì không cần chức danh đó phải duyệt"
 * ------------------------------------------------------------------ */

export interface VacantFilterableStep {
  order: number;
  role: Role;
  user_id?: string | null;
}

/**
 * Bỏ khỏi chuỗi duyệt những bước KHÔNG có người phụ trách (công ty khuyết chức danh);
 * hồ sơ tự động đẩy lên cấp cao hơn. Trả kèm danh sách bước bị bỏ để ghi `history`.
 * Các bước còn lại được đánh số lại liên tục từ 1.
 */
export function dropVacantSteps<T extends VacantFilterableStep>(
  steps: T[],
): { steps: T[]; dropped: { order: number; role: Role }[] } {
  const kept = steps.filter((s) => s.user_id != null);
  const dropped = steps.filter((s) => s.user_id == null).map((s) => ({ order: s.order, role: s.role }));
  return { steps: kept.map((s, i) => ({ ...s, order: i + 1 }) as T), dropped };
}

/**
 * Bước CAO NHẤT của matrix khuyết chức danh → không được bỏ hẳn (nếu bỏ hết thì hồ sơ
 * "duyệt xong ngay khi gửi"). Thay vào đó đẩy yêu cầu duyệt lên chức danh cao hơn kế tiếp
 * CÓ người phụ trách (theo `APPROVAL_ORDER`). Trả `null` khi không còn cấp nào cao hơn.
 */
export function escalatedTopRole(topRole: Role, availableRoles: Iterable<Role>): Role | null {
  const available = availableRoles instanceof Set ? availableRoles : new Set(availableRoles);
  for (let i = APPROVAL_ORDER.indexOf(topRole) + 1; i < APPROVAL_ORDER.length; i++) {
    const role = APPROVAL_ORDER[i]!;
    if (available.has(role)) return role;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Feature: "Phiếu chi từng phần" — chi nhiều kỳ, giữ phiếu mở tới khi chi hết
 * ------------------------------------------------------------------ */

export interface InstallmentLike {
  amount_minor?: unknown;
}

function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s.trim()) ? BigInt(s.trim()) : 0n;
}

/** Tổng đã chi qua các kỳ. */
export function sumInstallments(rows: readonly InstallmentLike[] | null | undefined): bigint {
  return (rows ?? []).reduce((sum, r) => sum + toBigInt(r.amount_minor), 0n);
}

export interface PartialStage {
  /** tổng đã chi sau kỳ này. */
  paid_total: bigint;
  /** phần còn lại sau kỳ này. */
  remaining: bigint;
  /** kỳ này có làm phiếu chi hết không. */
  finished: boolean;
  /** số tiền của kỳ này. */
  amount: bigint;
}

/**
 * Tính kỳ chi tiếp theo của phiếu chi từng phần. `requested` = null → chi hết phần còn lại.
 * Trả `{ ok:false, detail }` khi số tiền không hợp lệ (route dịch thành FG-VAL-001).
 */
export function nextPartialStage(
  total: bigint,
  alreadyPaid: bigint,
  requested: bigint | null,
): { ok: true; stage: PartialStage } | { ok: false; detail: string } {
  const remaining = total - alreadyPaid;
  if (remaining <= 0n) return { ok: false, detail: 'Phiếu đã được chi đủ' };
  const amount = requested ?? remaining;
  if (amount <= 0n) return { ok: false, detail: 'Số tiền chi phải lớn hơn 0' };
  if (amount > remaining) return { ok: false, detail: 'Số tiền chi vượt phần còn lại của phiếu' };
  const paidTotal = alreadyPaid + amount;
  return { ok: true, stage: { paid_total: paidTotal, remaining: total - paidTotal, finished: paidTotal >= total, amount } };
}

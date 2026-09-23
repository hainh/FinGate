/**
 * Entitlement (architecture §7.1) — chỗ DUY NHẤT trả lời "người này được thấy gì, làm gì".
 *
 * Server check cho TỪNG hành động, TỪNG cột, TỪNG file tải về (§19.5-4).
 * UI ẩn nút chỉ là mỹ thuật; không có đường nào cho FE tự quyết định quyền.
 */

import {
  buildEntitlements,
  formatMoney,
  hasPermission,
  isGroupOnlyRole,
  money,
  PERMISSIONS,
  ROLE_LABEL,
  type Permission,
  type Role,
} from '@fingate/shared';
import { Models } from '../../db/models.ts';
import type { ActorInfo, ScopeLike } from '../types.ts';

export interface ResolvedIdentity {
  user: Record<string, unknown>;
  assignments: AssignmentRow[];
  role: Role;
  company_id: string | null;
  department_id: string | null;
  amount_limit_minor: bigint;
  scope_all: boolean;
  permissions: Permission[];
  extra: Permission[];
  denied: Permission[];
}

interface AssignmentRow {
  _id: string;
  company_id: string;
  department_id: string | null;
  role: Role;
  amount_limit_minor: bigint;
  scope_all: boolean;
  extra_permissions: Permission[];
  denied_permissions: Permission[];
}

function asBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s.trim()) ? BigInt(s.trim()) : 0n;
}

/**
 * Đọc user + assignment đang hoạt động. `activeCompanyId` đến từ phiên
 * (header `x-company-scope` hoặc prefs) — nếu không hợp lệ thì null.
 */
export async function resolveIdentity(
  userId: string,
  opts: { activeCompanyId?: string | null } = {},
): Promise<ResolvedIdentity | null> {
  const user = await Models.User.findOne({ _id: userId, status: 'active' })
    .select({
      email: 1,
      display_name: 1,
      prefs: 1,
      totp: 1,
      recovery_codes: 1,
    })
    .lean<Record<string, unknown> | null>();
  if (!user) return null;

  const now = new Date();
  const rows = await Models.Assignment.find({
    user_id: userId,
    status: 'active',
    $or: [{ valid_to: null }, { valid_to: { $exists: false } }, { valid_to: { $gt: now } }],
  })
    .select({ company_id: 1, department_id: 1, role: 1, amount_limit_minor: 1, scope_all: 1, extra_permissions: 1, denied_permissions: 1 })
    .lean();

  if (rows.length === 0) {
    return {
      user,
      assignments: [],
      role: 'staff',
      company_id: null,
      department_id: null,
      amount_limit_minor: 0n,
      scope_all: false,
      permissions: [],
      extra: [],
      denied: [],
    };
  }

  const assignments: AssignmentRow[] = rows.map((r) => ({
    _id: String(r._id),
    company_id: String(r.company_id),
    department_id: r.department_id ? String(r.department_id) : null,
    role: String(r.role) as Role,
    amount_limit_minor: asBigInt(r.amount_limit_minor),
    scope_all: Boolean(r.scope_all),
    extra_permissions: (r.extra_permissions ?? []) as Permission[],
    denied_permissions: (r.denied_permissions ?? []) as Permission[],
  }));

  const wanted = opts.activeCompanyId;
  const chosen = (wanted ? assignments.find((a) => a.company_id === wanted) : undefined) ?? assignments[0]!;

  const permissions = new Set<Permission>();
  let scope_all = false;
  for (const a of assignments) {
    for (const p of buildEntitlements({ role: a.role, company_id: a.company_id }).permissions) permissions.add(p);
    for (const p of a.extra_permissions) permissions.add(p);
    if (a.scope_all) scope_all = true;
  }
  for (const a of assignments) for (const p of a.denied_permissions) permissions.delete(p);
  // chức danh cấp Tập đoàn (P.TGĐ, TGĐ) + quản trị thấy mọi công ty của tập đoàn (blueprint §XXIX)
  if (assignments.some((a) => isGroupOnlyRole(a.role) || a.role === 'admin')) scope_all = true;

  return {
    user,
    assignments,
    role: chosen.role,
    company_id: chosen.company_id,
    department_id: chosen.department_id,
    amount_limit_minor: chosen.amount_limit_minor,
    scope_all,
    permissions: [...permissions],
    extra: chosen.extra_permissions,
    denied: chosen.denied_permissions,
  };
}

export function scopeFor(identity: ResolvedIdentity, requested?: string | null): ScopeLike {
  const ids = identity.assignments.map((a) => a.company_id);
  // Yêu cầu MỘT công ty cụ thể → LUÔN thu hẹp về đúng công ty đó, kể cả người có
  // `scope_all` (chủ tịch/quản trị). Nếu không, bộ chuyển phạm vi ở header vô tác dụng
  // và dữ liệu công ty A vẫn hiện khi đang chọn công ty B (§7.5).
  if (requested && requested !== 'all') {
    if (!identity.scope_all && !ids.includes(requested)) return { companyIds: [] }; // ngoài scope → rỗng, không 500
    return { companyIds: [requested] };
  }
  if (identity.scope_all) {
    // không yêu cầu gì → chủ tịch/quản trị thấy mọi công ty của tập đoàn
    return { companyIds: null };
  }
  return { companyIds: ids };
}

export function actorInfoFrom(identity: ResolvedIdentity, sessionId: string): ActorInfo {
  const u = identity.user;
  return {
    user_id: String(u._id),
    name: String(u.display_name ?? u.email ?? ''),
    email: String(u.email ?? ''),
    role: identity.role,
    role_label: ROLE_LABEL[identity.role] ?? identity.role,
    company_id: identity.company_id,
    department_id: identity.department_id,
    amount_limit_minor: identity.amount_limit_minor,
    scope_all: identity.scope_all,
    permissions: identity.permissions,
    totp_enabled: Boolean((u.totp as { enabled?: boolean } | undefined)?.enabled),
    session_id: sessionId,
  };
}

export function can(actor: { permissions: readonly string[] }, need: Permission | Permission[]): boolean {
  return hasPermission(actor.permissions as string[], need);
}

/** Quyền per-hồ sơ: UI dựng action bar từ đúng đối tượng này (không tự suy). */
export interface DocPermissions {
  read: boolean;
  edit: boolean;
  submit: boolean;
  approve: boolean;
  reject: boolean;
  request_changes: boolean;
  fast_track: boolean;
  pay: boolean;
  override: boolean;
  attach: boolean;
  export: boolean;
  delete: boolean;
  reason?: string;
  amount_limit_minor: string;
  over_limit: boolean;
  step_order: number | null;
}

/** Cấp duyệt "từ Kế toán trưởng trở lên" (blueprint §III). */
const ROLES_FROM_CHIEF_ACCOUNTANT: readonly string[] = ['chief_accountant', 'deputy_director', 'director', 'deputy_chairman', 'chairman'];

/** Trạng thái người lập còn được xoá/sửa (kết hợp gate chưa ai KTT+ duyệt ở vòng hiện tại). */
const MAINTAINABLE_STATUSES: readonly string[] = ['draft', 'pending.ktt', 'changes_requested', 'rejected'];

/**
 * Đã có ai từ Kế toán trưởng trở lên **duyệt** trong VÒNG DUYỆT HIỆN TẠI chưa?
 * Đọc từ `history[]` (nguồn sự thật) và chỉ xét các lần duyệt SAU lần `submit` gần
 * nhất — khi người lập gửi lại (vd sau khi bị trả về bổ sung) thì các duyệt cũ bị
 * vô hiệu, phiếu coi như "chưa ai duyệt".
 */
export function approvedFromChiefAccountantUp(
  history: readonly { action?: string | null; actor?: { role?: string | null } | null }[],
): boolean {
  let lastSubmit = -1;
  history.forEach((h, i) => {
    if (h.action === 'submit') lastSubmit = i;
  });
  for (let i = lastSubmit + 1; i < history.length; i++) {
    const h = history[i]!;
    if (
      (h.action === 'approve' || h.action === 'approve_with_reason') &&
      ROLES_FROM_CHIEF_ACCOUNTANT.includes(String(h.actor?.role ?? ''))
    ) {
      return true;
    }
  }
  return false;
}

export function documentPermissions(
  actor: { user_id: string; permissions: string[]; amount_limit_minor: bigint; role: Role },
  doc: {
    status: string;
    created_by: string;
    amount_minor: bigint;
    steps: { order: number; role: Role; user_id: string | null; state: string; action?: string | null }[];
    evidence_missing: string[];
    company_id: string;
    actor_companies: string[];
    delegatedStepOrders: number[];
    /** Đã có ai từ Kế toán trưởng trở lên duyệt (tính từ `history[]`). */
    approved_from_ktt_up: boolean;
  },
): DocPermissions {
  const has = (p: Permission) => actor.permissions.includes(p);
  const mine = doc.created_by === actor.user_id;
  // Người lập xoá/sửa được khi phiếu còn nháp, đang CHỜ Kế toán trưởng duyệt (vòng hiện tại),
  // bị trả về bổ sung, hoặc bị từ chối — miễn chưa ai từ KTT trở lên duyệt ở vòng này.
  const creatorMaintainable = mine && MAINTAINABLE_STATUSES.includes(doc.status) && !doc.approved_from_ktt_up;
  const editable = creatorMaintainable && has('doc:create');
  const currentSteps = doc.steps.filter((s) => s.state === 'current' || s.state === 'waiting');
  const iAmStep = currentSteps.filter(
    (s) =>
      s.user_id === actor.user_id ||
      // bước chưa gán người (người duyệt được cấu hình sau khi gửi) → đúng vai trò là duyệt được
      (s.user_id == null && s.role === actor.role) ||
      doc.delegatedStepOrders.includes(s.order),
  );
  const overLimit = doc.amount_minor > actor.amount_limit_minor;

  // cấp hiện tại = step `current` đầu tiên theo thứ tự
  const current = doc.steps.find((s) => s.state === 'current') ?? null;

  const inScope = doc.actor_companies.includes(doc.company_id) || actor.permissions.includes('doc:read');
  // Người lập được tự duyệt tại mọi cấp mà chính họ phụ trách (yêu cầu nghiệp vụ).
  const approveAllowed =
    has('approval:act') &&
    iAmStep.length > 0 &&
    !overLimit &&
    (doc.evidence_missing.length === 0 || has('approval:override')) &&
    !['paid', 'rejected', 'cancelled', 'expired'].includes(doc.status);

  return {
    read: inScope && has('doc:read'),
    edit: editable,
    submit: (doc.status === 'draft' || doc.status === 'changes_requested' || doc.status === 'rejected') && mine && has('doc:submit'),
    // Xoá cứng phiếu: chỉ NGƯỜI LẬP, khi phiếu còn nháp / bị trả về bổ sung / bị từ chối
    // và chưa có ai từ Kế toán trưởng trở lên duyệt.
    delete: has('doc:delete') && creatorMaintainable,
    approve: approveAllowed,
    reject: approveAllowed,
    request_changes: approveAllowed,
    // fast-track (blueprint §IV): mọi cấp trong quy trình đều duyệt ngay được →
    // `can approve` đã bao gồm step `waiting` của chính mình
    fast_track:
      approveAllowed && !!current && iAmStep.some((s) => s.state === 'waiting'),
    // "Thực thi" phiếu đã duyệt xong: kế toán viên (payment:mark) thực hiện, KHÔNG giới hạn
    // bởi hạn mức duyệt — hạn mức là thẩm quyền duyệt, không phải quyền ghi nhận dòng tiền.
    pay: (doc.status === 'approved' || doc.status === 'processing') && has('payment:mark'),
    override: has('approval:override'),
    attach: (doc.status === 'draft' || doc.status === 'changes_requested' || has('doc:create')) && has('doc:read'),
    export: has('report:export'),
    amount_limit_minor: actor.amount_limit_minor.toString(),
    over_limit: overLimit,
    step_order: iAmStep[0]?.order ?? null,
    reason: !has('approval:act')
      ? 'Bạn không có quyền duyệt'
      : overLimit
        ? `Vượt hạn mức duyệt ${formatMoney(money(actor.amount_limit_minor), { mode: 'compact' })}`
        : doc.evidence_missing.length && !has('approval:override')
          ? 'Hồ sơ thiếu chứng từ bắt buộc'
          : undefined,
  };
}

export { PERMISSIONS, ROLE_LABEL };

/**
 * FinGate — RBAC (blueprint §III, architecture §7.1)
 *
 * `PERMISSIONS` là registry duy nhất. Server check quyền cho TỪNG cột, TỪNG hành
 * động, TỪNG file tải về (§19.5-4); UI ẩn nút chỉ là mỹ thuật.
 */

import type { Role } from '../status/index.js';

export const PERMISSIONS = [
  'doc:read',
  'doc:create',
  'doc:update',
  'doc:submit',
  'doc:delete',
  'approval:act',
  'approval:override',
  'payment:mark',
  'bank:read',
  'bank:write',
  'bank:transfer',
  'loan:read',
  'loan:write',
  'rollover:act',
  'debt:read',
  'debt:write',
  'budget:read',
  'budget:write',
  'forecast:read',
  'report:view',
  'report:export',
  'alert:config',
  'hr:invite',
  'hr:disable',
  'hr:transfer',
  'admin:matrix',
  'admin:settings',
  'admin:group_accounts',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Ma trận quyền mặc định theo chức danh (blueprint §III). ADM-03 cho phép điều chỉnh per công ty. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  // Nhân viên kế toán: tạo phiếu, nhập liệu, theo dõi — KHÔNG tự duyệt.
  staff: [
    'doc:read',
    'doc:create',
    'doc:update',
    'doc:submit',
    'doc:delete',
    'payment:mark',
    'bank:read',
    'debt:read',
    'debt:write',
    'budget:read',
    'forecast:read',
    'report:view',
  ],
  // Kế toán trưởng: kiểm tra hồ sơ, đối chiếu, duyệt kế toán → gửi cấp trên.
  chief_accountant: [
    'doc:read',
    'doc:create',
    'doc:update',
    'doc:submit',
    'doc:delete',
    'approval:act',
    'approval:override',
    'payment:mark',
    'bank:read',
    'bank:write',
    'bank:transfer',
    'loan:read',
    'loan:write',
    'rollover:act',
    'debt:read',
    'debt:write',
    'budget:read',
    'budget:write',
    'forecast:read',
    'report:view',
    'report:export',
    'alert:config',
    'hr:invite',
    'audit:read',
  ],
  deputy_director: [
    'doc:read',
    'approval:act',
    'bank:read',
    'loan:read',
    'rollover:act',
    'debt:read',
    'budget:read',
    'forecast:read',
    'report:view',
    'report:export',
    'audit:read',
  ],
  director: [
    'doc:read',
    'doc:create',
    'approval:act',
    'approval:override',
    'payment:mark',
    'bank:read',
    'bank:write',
    'bank:transfer',
    'loan:read',
    'loan:write',
    'rollover:act',
    'debt:read',
    'budget:read',
    'budget:write',
    'forecast:read',
    'report:view',
    'report:export',
    'alert:config',
    'hr:invite',
    'audit:read',
    'admin:matrix',
  ],
  // Chủ tịch HĐQT: phê duyệt + giám sát toàn hệ thống + nhân sự + cấu hình/tài khoản tập đoàn
  // + ma trận duyệt. Có `admin:settings` để tự tạo công ty con (ADM-06) — KHÔNG nhập liệu hồ sơ.
  chairman: [
    'doc:read',
    'approval:act',
    'approval:override',
    'bank:read',
    'bank:write',
    'loan:read',
    'rollover:act',
    'debt:read',
    'budget:read',
    'forecast:read',
    'report:view',
    'report:export',
    'alert:config',
    'hr:invite',
    'hr:disable',
    'hr:transfer',
    'admin:matrix',
    'admin:settings',
    'admin:group_accounts',
    'audit:read',
  ],
  // Quản trị hệ thống: CHỈ quyền quản lý (nhân sự, công ty/bộ phận, ma trận duyệt,
  // cấu hình, tài khoản tập đoàn, audit). KHÔNG có bất kỳ quyền nào với hồ sơ,
  // hoá đơn hay phiếu thu/chi (không `doc:*`, `approval:*`, `payment:*`,
  // bank/loan/debt/budget/forecast/report) — tách bạch nhiệm vụ, đúng yêu cầu
  // "tài khoản quản trị đầu tiên" (bootstrap): quản lý hệ thống, không giao dịch.
  admin: [
    'hr:invite',
    'hr:disable',
    'hr:transfer',
    'admin:matrix',
    'admin:settings',
    'admin:group_accounts',
    'alert:config',
    'audit:read',
  ],
};

export const ROLE_LABEL: Record<Role, string> = {
  staff: 'Nhân viên kế toán',
  chief_accountant: 'Kế toán trưởng',
  deputy_director: 'Phó Giám đốc phụ trách',
  director: 'Giám đốc / Tổng Giám đốc',
  chairman: 'Chủ tịch HĐQT',
  admin: 'Quản trị hệ thống',
};

/** Nhãn tiếng Việt của từng quyền — dùng cho bảng phân quyền (ADM-01). */
export const PERMISSION_LABEL: Record<Permission, string> = {
  'doc:read': 'Xem hồ sơ',
  'doc:create': 'Tạo phiếu thu / phiếu chi',
  'doc:update': 'Sửa hồ sơ',
  'doc:submit': 'Gửi duyệt',
  'doc:delete': 'Xoá phiếu thu / phiếu chi',
  'approval:act': 'Duyệt hồ sơ',
  'approval:override': 'Duyệt vượt cấp / ghi đè',
  'payment:mark': 'Ghi nhận thanh toán',
  'bank:read': 'Xem tài khoản ngân hàng & quỹ',
  'bank:write': 'Sửa tài khoản ngân hàng & quỹ',
  'bank:transfer': 'Chuyển tiền',
  'loan:read': 'Xem khoản vay',
  'loan:write': 'Sửa khoản vay',
  'rollover:act': 'Xử lý đáo hạn',
  'debt:read': 'Xem công nợ',
  'debt:write': 'Sửa công nợ',
  'budget:read': 'Xem ngân sách',
  'budget:write': 'Sửa ngân sách',
  'forecast:read': 'Xem dự báo dòng tiền',
  'report:view': 'Xem báo cáo',
  'report:export': 'Xuất báo cáo',
  'alert:config': 'Cấu hình cảnh báo',
  'hr:invite': 'Quản lý nhân sự',
  'hr:disable': 'Ngừng hoạt động nhân sự',
  'hr:transfer': 'Chuyển nhân sự giữa công ty',
  'admin:matrix': 'Sửa ma trận duyệt',
  'admin:settings': 'Cấu hình hệ thống / công ty',
  'admin:group_accounts': 'Tài khoản tập đoàn',
  'audit:read': 'Xem audit log',
};

/** Nhóm quyền theo module — dựng bảng tick phân quyền ở màn sửa nhân sự. */
export interface PermissionGroup {
  key: string;
  label: string;
  permissions: readonly Permission[];
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  { key: 'doc', label: 'Hồ sơ & phiếu thu/chi', permissions: ['doc:read', 'doc:create', 'doc:update', 'doc:submit', 'doc:delete'] },
  { key: 'approval', label: 'Phê duyệt', permissions: ['approval:act', 'approval:override'] },
  { key: 'payment', label: 'Thanh toán', permissions: ['payment:mark'] },
  { key: 'bank', label: 'Ngân hàng & quỹ', permissions: ['bank:read', 'bank:write', 'bank:transfer'] },
  { key: 'loan', label: 'Khoản vay & đáo hạn', permissions: ['loan:read', 'loan:write', 'rollover:act'] },
  { key: 'debt', label: 'Công nợ', permissions: ['debt:read', 'debt:write'] },
  { key: 'budget', label: 'Ngân sách & dự báo', permissions: ['budget:read', 'budget:write', 'forecast:read'] },
  { key: 'report', label: 'Báo cáo', permissions: ['report:view', 'report:export'] },
  { key: 'alert', label: 'Cảnh báo', permissions: ['alert:config'] },
  { key: 'hr', label: 'Nhân sự', permissions: ['hr:invite', 'hr:disable', 'hr:transfer'] },
  { key: 'admin', label: 'Quản trị hệ thống', permissions: ['admin:matrix', 'admin:settings', 'admin:group_accounts'] },
  { key: 'audit', label: 'Audit', permissions: ['audit:read'] },
];

/**
 * Quyền hiệu lực = quyền mặc định của vai trò + quyền cấp thêm − quyền thu hồi.
 * `extra`/`denied` là quyền riêng per người (ADM-01/ADM-03).
 */
export function effectivePermissions(
  role: Role,
  extra: readonly Permission[] = [],
  denied: readonly Permission[] = [],
): Permission[] {
  const base = new Set(permissionsForRole(role));
  for (const p of extra) base.add(p);
  for (const p of denied) base.delete(p);
  return [...base];
}

/** Vai trò bắt buộc 2FA (architecture §7.2). */
export const MFA_REQUIRED_ROLES: readonly Role[] = [
  'chief_accountant',
  'deputy_director',
  'director',
  'chairman',
  'admin',
] as const;

/** Vai trò được duyệt hồ sơ (có mặt trong Approval Matrix). */
export const APPROVER_ROLES: readonly Role[] = [
  'chief_accountant',
  'deputy_director',
  'director',
  'chairman',
] as const;

export function permissionsForRole(role: Role): Permission[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

export function hasPermission(perms: readonly string[], need: Permission | readonly Permission[]): boolean {
  const list = Array.isArray(need) ? need : [need];
  return list.some((p) => perms.includes(p));
}

/** Hành động nhạy cảm → bắt buộc re-verify mật khẩu/OTP trước khi ghi (§7.2, ADR-14). */
export const SENSITIVE_ACTIONS: readonly Permission[] = [
  'approval:act',
  'report:export',
  'hr:disable',
  'bank:transfer',
  'admin:settings',
  'admin:matrix',
] as const;

export function isSensitiveAction(p: Permission): boolean {
  return SENSITIVE_ACTIONS.includes(p);
}

/**
 * Hạn mức duyệt mặc định theo chức danh (minor units VND) — blueprint §XX.
 * Thực tế lưu ở `assignments.amount_limit_minor`, cấu hình per công ty (BA-2).
 */
export const DEFAULT_AMOUNT_LIMIT_MINOR: Record<Role, string> = {
  staff: '0',
  chief_accountant: '50000000000',
  deputy_director: '50000000000',
  director: '50000000000',
  chairman: '999999999000000000', // không chặn
  admin: '0',
};

/** Ngưỡng chairman mặc định: > 5 tỷ (blueprint §XX, cấu hình được). */
export const DEFAULT_CHAIRMAN_THRESHOLD_MINOR = '5000000000';

/**
 * entitlement trả về cho FE: actions được phép + cột bị ẩn + lý do ẩn.
 * Server là nguồn duy nhất; FE chỉ ẩn theo thông tin này.
 */
export interface ColumnRule {
  column: string;
  visible: boolean;
  reason?: string;
}

export interface Entitlements {
  role: Role;
  company_id: string;
  permissions: Permission[];
  actions: Record<string, boolean>;
  amount_limit_minor: string;
  columns: ColumnRule[];
  mfa_required: boolean;
  scope_all: boolean;
}

/** Những cột cần quyền riêng (số TK NH, MST) — DS §7.10 + blueprint §XXVI. */
export const SENSITIVE_COLUMNS: { column: string; permission: Permission; reason: string }[] = [
  { column: 'account_number', permission: 'bank:read', reason: 'Cần quyền Xem ngân hàng' },
  { column: 'tax_code', permission: 'doc:read', reason: 'Cần quyền Xem hồ sơ' },
  { column: 'salary', permission: 'hr:invite', reason: 'Cần quyền Quản lý nhân sự' },
  { column: 'user_email', permission: 'hr:invite', reason: 'Cần quyền Quản lý nhân sự' },
];

export function buildEntitlements(input: {
  role: Role;
  company_id: string;
  amount_limit_minor?: string;
  scope_all?: boolean;
  extra?: readonly Permission[];
  denied?: readonly Permission[];
}): Entitlements {
  const perms = effectivePermissions(input.role, input.extra, input.denied);
  const base = new Set(perms);
  const can = (p: Permission) => base.has(p);
  return {
    role: input.role,
    company_id: input.company_id,
    permissions: perms,
    actions: {
      'doc:read': can('doc:read'),
      'doc:create': can('doc:create'),
      'doc:submit': can('doc:submit'),
      'doc:delete': can('doc:delete'),
      'approval:act': can('approval:act'),
      'approval:override': can('approval:override'),
      'payment:mark': can('payment:mark'),
      'bank:write': can('bank:write'),
      'bank:transfer': can('bank:transfer'),
      'loan:write': can('loan:write'),
      'rollover:act': can('rollover:act'),
      'debt:write': can('debt:write'),
      'budget:write': can('budget:write'),
      'report:export': can('report:export'),
      'hr:invite': can('hr:invite'),
      'hr:disable': can('hr:disable'),
      'admin:matrix': can('admin:matrix'),
      'admin:group_accounts': can('admin:group_accounts'),
      'audit:read': can('audit:read'),
    },
    amount_limit_minor: input.amount_limit_minor ?? DEFAULT_AMOUNT_LIMIT_MINOR[input.role],
    columns: SENSITIVE_COLUMNS.map((c) => ({
      column: c.column,
      visible: can(c.permission),
      reason: can(c.permission) ? undefined : c.reason,
    })),
    mfa_required: MFA_REQUIRED_ROLES.includes(input.role),
    scope_all: input.scope_all ?? (input.role === 'chairman' || input.role === 'admin'),
  };
}

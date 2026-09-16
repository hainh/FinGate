/**
 * FinGate — hệ thống trạng thái & rủi ro (Design System §3)
 *
 * Đây là NGUỒN DUY NHẤT cho nhãn/tone/icon trạng thái: API · UI · Excel export ·
 * email đều import từ đây (ADR-09). Không tự đặt status mới ở bất kỳ tầng nào.
 *
 * Ba registry riêng, không trộn lẫn (DS §3):
 *  1. STATUS_REGISTRY — workflow status (hồ sơ đang ở đâu trong quy trình)
 *  2. ACCOUNT_STATUS_REGISTRY — trạng thái tài khoản nhân sự (blueprint §XXIX)
 *  3. maturity() — maturity ladder cho đáo hạn (DS §3.3)
 */

/** Tone semantic (DS §2.2). warning ≠ attention: warning = xử lý sớm (cam), attention = lưu ý (vàng). */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'attention' | 'danger';

export const TONES = ['neutral', 'info', 'success', 'warning', 'attention', 'danger'] as const;

/** Vai trò (blueprint §III). `KT`/`CV` là 2 bước luôn có ở mọi quy trình (blueprint §XX). */
export type Role = 'staff' | 'accountant' | 'chief_accountant' | 'deputy_director' | 'director' | 'chairman' | 'admin';

export const ROLES: readonly Role[] = [
  'staff',
  'accountant',
  'chief_accountant',
  'deputy_director',
  'director',
  'chairman',
  'admin',
] as const;

/** Cấp duyệt theo thứ tự quy trình (bước KT/CV kiểm tra nằm đầu, xem matrix resolver). */
export const APPROVAL_ORDER: readonly Role[] = [
  'accountant',
  'chief_accountant',
  'deputy_director',
  'director',
  'chairman',
] as const;

export type StatusKey =
  | 'draft'
  | 'pending.kt'
  | 'pending.cv'
  | 'pending.ktt'
  | 'pending.pgd'
  | 'pending.gd'
  | 'pending.chairman'
  | 'approved'
  | 'processing'
  | 'paid'
  | 'rejected'
  | 'changes_requested'
  | 'cancelled'
  | 'expired'
  | 'overdue';

export interface StatusDef {
  key: StatusKey;
  /** Nhãn tiếng Việt — exact wording DS §11, không TitleCase giữa câu. */
  labelVi: string;
  /** Icon luôn đi kèm màu (DS §3.4: màu không mang nghĩa một mình). */
  glyph: string;
  tone: Tone;
  /** Với pending.*, trạng thái phản ánh "đang nằm ở bàn của ai". */
  ownerRole?: Role;
  /** Trạng thái cuối — không còn chuyển tiếp trong quy trình thường. */
  terminal: boolean;
  /** pending.* — cần người xử lý. */
  pending?: boolean;
}

/** exact literal theo DS §3.1 + workflow (architecture §9.1). */
export const STATUS_REGISTRY: Record<StatusKey, StatusDef> = {
  draft: { key: 'draft', labelVi: 'Nháp', glyph: '○', tone: 'neutral', terminal: false },
  'pending.kt': {
    key: 'pending.kt',
    labelVi: 'Chờ kế toán kiểm tra',
    glyph: '◍',
    tone: 'info',
    ownerRole: 'accountant',
    terminal: false,
    pending: true,
  },
  'pending.cv': {
    key: 'pending.cv',
    labelVi: 'Chờ chuyên viên kiểm tra',
    glyph: '◍',
    tone: 'info',
    ownerRole: 'accountant',
    terminal: false,
    pending: true,
  },
  'pending.ktt': {
    key: 'pending.ktt',
    labelVi: 'Chờ Kế toán trưởng',
    glyph: '◍',
    tone: 'info',
    ownerRole: 'chief_accountant',
    terminal: false,
    pending: true,
  },
  'pending.pgd': {
    key: 'pending.pgd',
    labelVi: 'Chờ Phó Giám đốc',
    glyph: '◍',
    tone: 'warning',
    ownerRole: 'deputy_director',
    terminal: false,
    pending: true,
  },
  'pending.gd': {
    key: 'pending.gd',
    labelVi: 'Chờ Giám đốc',
    glyph: '◍',
    tone: 'warning',
    ownerRole: 'director',
    terminal: false,
    pending: true,
  },
  'pending.chairman': {
    key: 'pending.chairman',
    labelVi: 'Chờ Chủ tịch HĐQT',
    glyph: '◍',
    tone: 'warning',
    ownerRole: 'chairman',
    terminal: false,
    pending: true,
  },
  approved: { key: 'approved', labelVi: 'Đã duyệt', glyph: '✓', tone: 'success', terminal: false },
  processing: {
    key: 'processing',
    labelVi: 'Đang thanh toán',
    glyph: '↻',
    tone: 'info',
    ownerRole: 'accountant',
    terminal: false,
    pending: true,
  },
  paid: { key: 'paid', labelVi: 'Đã thanh toán', glyph: '✓', tone: 'success', terminal: true },
  rejected: { key: 'rejected', labelVi: 'Từ chối', glyph: '✕', tone: 'danger', terminal: true },
  changes_requested: {
    key: 'changes_requested',
    labelVi: 'Yêu cầu bổ sung',
    glyph: '✎',
    tone: 'attention',
    ownerRole: 'staff',
    terminal: false,
    pending: true,
  },
  cancelled: { key: 'cancelled', labelVi: 'Hủy', glyph: '⊘', tone: 'neutral', terminal: true },
  expired: { key: 'expired', labelVi: 'Hết hiệu lực', glyph: '⊘', tone: 'neutral', terminal: true },
  /** overdue được THÊM vào status gốc, không thay thế → hiển thị 2 chip (DS §3.1). */
  overdue: { key: 'overdue', labelVi: 'Quá hạn', glyph: '!', tone: 'danger', terminal: false },
};

export const STATUS_KEYS = Object.keys(STATUS_REGISTRY) as StatusKey[];

export const PENDING_STATUSES: StatusKey[] = STATUS_KEYS.filter((k) => STATUS_REGISTRY[k].pending);
export const WORKFLOW_STATUSES: StatusKey[] = STATUS_KEYS.filter((k) => k !== 'overdue');
export const TERMINAL_STATUSES: StatusKey[] = STATUS_KEYS.filter((k) => STATUS_REGISTRY[k].terminal);

export function isStatusKey(v: unknown): v is StatusKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(STATUS_REGISTRY, v);
}

export function statusLabel(key: string): string {
  return STATUS_REGISTRY[key as StatusKey]?.labelVi ?? key;
}

export function statusTone(key: string): Tone {
  return STATUS_REGISTRY[key as StatusKey]?.tone ?? 'neutral';
}

/** "Đang ở bàn của ai" (DS §1.5 Nothing is silent). */
export function statusOwnerRole(key: string): Role | undefined {
  return STATUS_REGISTRY[key as StatusKey]?.ownerRole;
}

/** Nhãn đầy đủ có owner: `● Chờ Giám đốc duyệt` (DS §3.1). */
export function statusChipLabel(key: string, opts: { withOwner?: boolean; waitingDays?: number } = {}): string {
  const def = STATUS_REGISTRY[key as StatusKey];
  if (!def) return key;
  let label = `${def.glyph} ${def.labelVi}`;
  if (opts.waitingDays !== undefined && def.pending) {
    label += ` · ${daysLabel(opts.waitingDays)}`;
  }
  return label;
}

/** pending.* theo cấp duyệt → status key (workflow §9.1). */
export function pendingStatusForRole(role: Role): StatusKey | undefined {
  switch (role) {
    case 'accountant':
      return 'pending.ktt';
    case 'chief_accountant':
      return 'pending.ktt';
    case 'deputy_director':
      return 'pending.pgd';
    case 'director':
      return 'pending.gd';
    case 'chairman':
      return 'pending.chairman';
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 2. Trạng thái tài khoản nhân sự (blueprint §XXIX.5) — registry riêng
 * ------------------------------------------------------------------ */

export type AccountStatusKey = 'invited' | 'active' | 'deactivated';

export interface AccountStatusDef {
  key: AccountStatusKey;
  labelVi: string;
  glyph: string;
  /** `deactivated` là trạng thái hành chính → neutral, không phải danger (DS §3.5). */
  tone: Tone;
}

export const ACCOUNT_STATUS_REGISTRY: Record<AccountStatusKey, AccountStatusDef> = {
  invited: { key: 'invited', labelVi: 'Chờ kích hoạt', glyph: '✉', tone: 'attention' },
  active: { key: 'active', labelVi: 'Đang hoạt động', glyph: '✓', tone: 'success' },
  deactivated: { key: 'deactivated', labelVi: 'Ngừng hoạt động', glyph: '⊘', tone: 'neutral' },
};

export const ACCOUNT_STATUS_KEYS = Object.keys(ACCOUNT_STATUS_REGISTRY) as AccountStatusKey[];

/** Trạng thái tài khoản → def (an toàn khi DB có giá trị lạ). */
export function accountStatusFor(v: unknown): AccountStatusDef {
  return ACCOUNT_STATUS_REGISTRY[v as AccountStatusKey] ?? ACCOUNT_STATUS_REGISTRY.deactivated;
}

/* ------------------------------------------------------------------ *
 * 3. Maturity ladder — đáo hạn / rủi ro theo ngày (DS §3.2, §3.3)
 * ------------------------------------------------------------------ */

export type SeverityLevel = 0 | 1 | 2 | 3;

export interface MaturityBand {
  level: SeverityLevel;
  tone: Tone;
  /** Icon severity (DS §3.2). */
  glyph: string;
  bucket: 'today' | '3d' | '7d' | '30d' | 'later';
}

/** Ánh xạ cố định DS §3.3. `days` = số ngày còn lại tới đáo hạn (0 = hôm nay, âm = quá hạn). */
export function maturity(days: number): MaturityBand {
  if (days <= 0) return { level: 3, tone: 'danger', glyph: '⛔', bucket: 'today' };
  if (days <= 3) return { level: 3, tone: 'danger', glyph: '⛔', bucket: '3d' };
  if (days <= 7) return { level: 2, tone: 'warning', glyph: '⚠', bucket: '7d' };
  if (days <= 30) return { level: 1, tone: 'attention', glyph: '▲', bucket: '30d' };
  return { level: 0, tone: 'neutral', glyph: '', bucket: 'later' };
}

export const MATURITY_BUCKETS = ['today', '3d', '7d', '30d', 'later'] as const;
export type MaturityBucket = (typeof MATURITY_BUCKETS)[number];

/** Nhãn ngày theo DS §4.1/§4.3: luôn kèm số ngày cụ thể, không chỉ màu. */
export function daysLabel(days: number): string {
  if (days === 0) return 'hôm nay';
  if (days === 1) return 'ngày mai';
  if (days === -1) return 'qua hạn 1 ngày';
  if (days < 0) return `qua hạn ${Math.abs(days)} ngày`;
  if (days <= 30) return `còn ${days} ngày`;
  return `còn ${Math.round(days / 30)} tháng`;
}

export function maturityLabel(days: number): string {
  const b = maturity(days);
  const label = daysLabel(days);
  return b.glyph ? `${b.glyph} ${label}` : label;
}

/* ------------------------------------------------------------------ *
 * Loại hồ sơ (architecture §8.1 — một collection `documents`)
 * ------------------------------------------------------------------ */

export const DOC_KINDS = ['spend', 'income', 'rollover', 'internal'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

export const DOC_KIND_LABEL: Record<DocKind, string> = {
  spend: 'Phiếu chi',
  income: 'Phiếu thu',
  rollover: 'Phương án đảo hạn',
  internal: 'Chuyển tiền nội bộ',
};

/** Mã phiếu: PC-2026-00123 (blueprint §XXX.1 — tự sinh, bất biến sau khi gửi). */
export const DOC_CODE_PREFIX: Record<DocKind, string> = {
  spend: 'PC',
  income: 'PT',
  rollover: 'DH',
  internal: 'CN',
};

/* ------------------------------------------------------------------ *
 * Hành động workflow (architecture §10 transition)
 * ------------------------------------------------------------------ */

export const ACTIONS = [
  'submit',
  'check',
  'approve',
  'approve_with_reason',
  'reject',
  'request_changes',
  'cancel',
  'queue_payment',
  'pay',
  'expire',
] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABEL: Record<Action, string> = {
  submit: 'Gửi',
  check: 'Kiểm tra',
  approve: 'Duyệt',
  approve_with_reason: 'Duyệt trước',
  reject: 'Từ chối',
  request_changes: 'Yêu cầu bổ sung',
  cancel: 'Hủy',
  queue_payment: 'Đưa vào thanh toán',
  pay: 'Ghi nhận đã thanh toán',
  expire: 'Hết hiệu lực',
};

/** Ý kiến bắt buộc khi Từ chối / Yêu cầu bổ sung (DS §7.14 rule 5). */
export const ACTION_REQUIRES_OPINION: Partial<Record<Action, boolean>> = {
  reject: true,
  request_changes: true,
  approve_with_reason: true,
  cancel: true,
};

/** Loại chứng từ, cấu hình được theo danh mục (blueprint §XXX.2, Q-04). */
export const EVIDENCE_TYPES = [
  'contract',
  'invoice',
  'acceptance',
  'payment_request',
  'quote',
  'goods_receipt',
  'bank_order',
  'loan_schedule',
  'minutes',
  'other',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export const EVIDENCE_LABEL: Record<EvidenceType, string> = {
  contract: 'Hợp đồng',
  invoice: 'Hóa đơn',
  acceptance: 'Nghiệm thu',
  payment_request: 'Đề nghị thanh toán',
  quote: 'Báo giá',
  goods_receipt: 'Phiếu nhập kho',
  bank_order: 'Ủy nhiệm chi',
  loan_schedule: 'Lịch trả nợ',
  minutes: 'Biên bản',
  other: 'Tài liệu khác',
};

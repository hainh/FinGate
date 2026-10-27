/**
 * FinGate web — kiểu dữ liệu trên WIRE (đã kiểm chứng với API đang chạy, handoff §3).
 *
 * Tiền trên wire là STRING minor units — mọi chỗ convert qua `money()` trước khi hiển thị.
 * Khi backend đổi: `pnpm api:types` sinh openapi-types; file này giữ các kiểu UI cần.
 */

import type {
  AutomationRunView,
  DocLink,
  DocLoanView,
  DocOffsetView,
  DocOrigin,
  DocTagRef,
  DocTransferView,
} from './v2/documents.ts';
import type { PartnerRef } from '@fingate/shared';

export interface MoneyWire {
  minor: string;
  currency: string;
  decimals: number;
}

/* ---------------- /me ---------------- */

export interface MeAssignment {
  company_id: string;
  company_name: string;
  company_code: string;
  department_id: string | null;
  department_name: string | null;
  role: string;
  role_label: string;
  amount_limit_minor: string;
  scope_all: boolean;
}

export interface MeCompany {
  company_id: string;
  company_name: string;
  company_code: string;
}

export interface Entitlements {
  role: string;
  company_id: string | null;
  permissions: string[];
  actions: Record<string, boolean>;
  amount_limit_minor: string;
  columns: { column: string; visible: boolean }[];
  mfa_required?: boolean;
  scope_all?: boolean;
}

export interface Prefs {
  theme: 'light' | 'dark' | 'system';
  density: 'comfortable' | 'compact';
  default_scope: string;
  auto_open_next: boolean;
  shortcuts: Record<string, string>;
  notify_channels: string[];
  quiet_hours: boolean;
}

export interface MeProfile {
  user_id: string;
  email: string;
  display_name: string;
  status: 'invited' | 'active' | 'deactivated';
  totp_enabled: boolean;
  mfa_required: boolean;
  last_login_at: string | null;
  assignments: MeAssignment[];
  companies: MeCompany[];
  scope: { company_ids: string[]; all: boolean; active_company_id: string | null };
  entitlements: Entitlements;
  prefs: Prefs;
}

export interface LoginResult {
  need_2fa: boolean;
  user_id?: string;
  challenge?: string;
  method?: string;
  resend_after_s?: number;
}

/* ---------------- dashboard ---------------- */

export interface KpiBlock {
  label: string;
  amount: MoneyWire;
  compact: string;
  breakdown?: { label: string; amount: MoneyWire; compact: string }[];
  delta_percent?: number | null;
  as_of?: string;
  href?: string;
}

export interface ExceptionItem {
  id: string;
  severity: 0 | 1 | 2 | 3;
  tone: string;
  glyph: string;
  text: string;
  amount?: MoneyWire | null;
  compact?: string | null;
  href?: string | null;
  cta?: string | null;
}

export interface AwaitingRow {
  document_id: string;
  code: string;
  kind: string;
  company_name: string;
  title: string;
  amount: MoneyWire;
  compact: string;
  created_by_name: string;
  status: string;
  waiting_days: number;
  next_role_label: string | null;
  overdue: boolean;
  href: string;
}

export interface DashboardOverview {
  scope: { all: boolean; company_ids: string[]; company_names: string[] };
  business_date: string;
  generated_at: string;
  stale: boolean;
  partial_companies?: { company_id: string; name: string; last_balance_date: string | null }[];
  kpi: Record<string, KpiBlock>;
  bank: {
    debt_total: MoneyWire;
    maturity_today: MoneyWire;
    maturity_3d: MoneyWire;
    maturity_7d: MoneyWire;
    maturity_30d: MoneyWire;
    /** v2: dư nợ theo ngân hàng — gộp theo ID đối tác (`bank_name` là tên đối tác). */
    by_bank: { partner_id?: string | null; bank_name: string; outstanding: MoneyWire; share_percent: number }[];
  };
  exceptions: ExceptionItem[];
  awaiting_me_rows: AwaitingRow[];
  forecast?: { horizon_days: number; first_breach_date: string | null; net_30d?: MoneyWire } | null;
  receivable_overdue?: MoneyWire | null;
  payable_due?: MoneyWire | null;
  counts: Record<string, number>;
  /** v2 (§12): top đối tác phải thu / phải trả. */
  partners?: DashboardPartnersWire | null;
  /** v2: khoản vay "Chờ giải ngân" (không tính vào dư nợ). */
  loans_pending?: DashboardLoansPendingWire | null;
  /** v2: lượt quy trình tự động đang lỗi. */
  automation?: DashboardAutomationWire | null;
}

/** Một dòng công nợ theo đối tác: còn lại, phần quá hạn, số ngày quá hạn lâu nhất. */
export interface PartnerExposureWire {
  partner_id: string | null;
  partner_name: string;
  partner_type: 'bank' | 'customer' | 'supplier' | null;
  direction: 'receivable' | 'payable';
  count: number;
  remaining: MoneyWire;
  overdue: MoneyWire;
  max_overdue_days: number;
}

export interface DashboardPartnersWire {
  top_receivable: PartnerExposureWire[];
  top_payable: PartnerExposureWire[];
  receivable_total: MoneyWire;
  payable_total: MoneyWire;
}

export interface DashboardLoansPendingWire {
  count: number;
  total: MoneyWire;
  items: { id: string; code: string; company_id: string; partner_id: string | null; partner_name: string; principal: MoneyWire; created_at: string | null; href: string }[];
}

export interface DashboardAutomationWire {
  failed_count: number;
  items: {
    id: string;
    rule_code: string;
    rule_name: string;
    company_name: string;
    source_id: string;
    source_code: string | null;
    error: string | null;
    updated_at: string | null;
    href: string | null;
  }[];
}

/* ---------------- hàng chờ / danh sách hồ sơ ---------------- */

export interface QueueRow {
  _id: string;
  code: string;
  kind: string;
  kind_label: string;
  company_id: string;
  company_name: string;
  department_name: string | null;
  created_by_name: string;
  title: string;
  status: string;
  status_label: string;
  overdue: boolean;
  waiting_days: number;
  current_owner: string | null;
  owner_name: string | null;
  fast_tracked_by: string | null;
  category_name: string | null;
  payee_name: string;
  /** [v2] đối tác theo ID + tên hiện tại; tag gọn (cột Đối tác / Tag). */
  partner_id?: string | null;
  partner_name?: string | null;
  tags?: DocTagRef[];
  amount: MoneyWire;
  compact: string;
  planned_date: string;
  /** Ngày tạo hồ sơ (ISO) — cột "Ngày tạo" ở màn Thu / Chi. */
  created_at?: string | null;
  version: number;
  missing_evidence_count: number;
  href: string;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  limit?: number;
  page?: number;
  next_cursor?: string | null;
  summary?: { count: number; amount: string; compact: string };
}

/* ---------------- hồ sơ chi tiết ---------------- */

export interface ApprovalStep {
  order: number;
  role: string;
  user_id: string | null;
  delegated_from?: string | null;
  state: 'waiting' | 'current' | 'done' | 'skipped' | 'rejected';
  action?: string | null;
  decided_at?: string | null;
  opinion?: string | null;
  reason?: string | null;
  sla_deadline?: string | null;
  amount_at_decision?: string | null;
  fast_tracked?: boolean;
}

export interface HistoryEntry {
  at: string;
  actor: { user_id: string | null; role?: string | null; name?: string };
  action: string;
  from?: string | null;
  to?: string | null;
  amount_at_decision?: string | null;
  opinion?: string | null;
  reason?: string | null;
  fields?: Record<string, unknown> | null;
}

export interface AttachmentRef {
  id: string;
  type: string;
  version: number;
  filename: string;
  size: number;
  mime: string;
  added_at: string;
  added_by?: string | null;
  download_href?: string;
  referenced?: boolean;
}

export interface DocumentDetail {
  _id: string;
  code: string;
  kind: string;
  kind_label: string;
  company_id: string;
  company_name?: string;
  department_id: string | null;
  created_by: string;
  created_by_name: string;
  status: string;
  status_label: string;
  tone?: string;
  overdue: boolean;
  waiting_days: number;
  current_owner: { role: string | null; name: string | null } | null;
  version: number;
  title: string;
  purpose: string;
  category_id: string | null;
  category_name?: string | null;
  payee: { name: string; tax_code: string | null; is_internal: boolean; bank_name?: string | null; bank_account?: string | null };
  /** [v2] đối tác theo ID (nạp sống từ danh bạ) — KHÔNG lưu bản sao trên phiếu. */
  partner_id?: string | null;
  partner?: PartnerRef | null;
  tag_ids?: string[];
  tags?: DocTagRef[];
  /** [v2] tuỳ chọn vay: `borrow` (phiếu thu đi vay) hoặc `fund` (phiếu chi vay để chi). */
  options?: { loan: DocLoanView | null; offset?: DocOffsetView | null } | null;
  /** [v2] chuyển nội bộ theo ID (đích nhận tiền). */
  transfer_target?: DocTransferView | null;
  /** [v2] nguồn gốc: thủ công / tự động (quy tắc + lượt chạy). */
  origin?: DocOrigin;
  /** [v2] liên kết hai chiều (đã gỡ vẫn có, `status: removed`). */
  links?: DocLink[];
  /** [v2] lượt quy trình tự động của phiếu (mới nhất trước, tối đa 20). */
  automation_runs?: AutomationRunView[];
  amount: MoneyWire;
  fx: { rate: string | null; at: string | null } | null;
  source: {
    fund: 'bank' | 'cash';
    account_id: string | null;
    group_account_id: string | null;
    group_managed: boolean;
    account_label: string | null;
    balance_available: MoneyWire | null;
  };
  planned_date: string;
  business_date: string;
  priority: string;
  contract: { code: string | null; value: MoneyWire | null; signed_at: string | null };
  loan_id: string | null;
  budget: { budget_id: string | null; line_id: string | null; in_plan: boolean };
  target: { company_id: string | null; company_name?: string; account_id: string | null } | null;
  rollover: {
    need_amount?: MoneyWire | null;
    plan?: string | null;
    /** Ngày đáo hạn mới đề xuất (YYYY-MM-DD). */
    new_maturity_date?: string | null;
    fee_estimate: MoneyWire | null;
    new_rate: string | null;
    collateral: string | null;
    proposal: string | null;
    result?: {
      done_at: string | null;
      new_contract_code: string | null;
      /** Ngày đáo hạn mới sau khi ngân hàng ký HĐ mới. */
      new_maturity_date?: string | null;
      new_limit: MoneyWire | null;
      new_rate: string | null;
      actual_fee: MoneyWire | null;
      note: string | null;
    } | null;
  } | null;
  note: string | null;
  approval: { matrix_id: string | null; matrix_version: number; matrix_label?: string; steps: ApprovalStep[] };
  evidence: { required: string[]; present: string[]; missing: string[] };
  attachments: AttachmentRef[];
  execution: {
    paid_at: string | null;
    bank_ref: string | null;
    executed_by: string | null;
    actual_amount: MoneyWire | null;
  } | null;
  override: { fast_tracked: boolean; reason: string | null };
  history: HistoryEntry[];
  href?: string;
  can: {
    read: boolean;
    edit: boolean;
    submit: boolean;
    approve: boolean;
    reject: boolean;
    request_changes: boolean;
    fast_track: boolean;
    pay: boolean;
    /** v2 §7.1: đưa phiếu đã duyệt vào hàng thanh toán (kế toán, payment:mark). */
    queue_payment?: boolean;
    /** RENEW-04 (v2 §7.3): ghi kết quả thực hiện phương án đảo hạn (rollover:act; đã duyệt / đã thực thi). */
    rollover_result?: boolean;
    /** Huỷ hồ sơ (người lập / approval:override; Nháp, Yêu cầu bổ sung, Đã duyệt). */
    cancel?: boolean;
    override: boolean;
    attach: boolean;
    export: boolean;
    delete: boolean;
    over_limit: boolean;
    step_order: number | null;
    reason?: string | null;
    /** [v2] sửa tag của phiếu (xem + doc:create / tag:create). */
    tag?: boolean;
    /** [v2] gán / gỡ liên kết thủ công (link:manage). */
    link?: boolean;
    /** [v2] Chủ tịch đổi đối tác (bên nộp / nhận) của phiếu thu/chi ở mọi trạng thái. */
    partner_change?: boolean;
  };
}

export interface DecisionPack {
  document_id: string;
  code: string;
  q1_payee: { name: string; tax_code: string | null; is_internal: boolean; bank: string | null };
  q2_amount: { amount: MoneyWire; amount_usd: MoneyWire | null; fx_rate: string | null };
  q3_purpose: { text: string; category: string | null; department: string | null };
  q4_basis: { contract_code: string | null; contract_value: MoneyWire | null };
  q5_source: { fund: string; account_label: string; group_account_label: string | null; group_managed: boolean };
  q6_impact: { balance_before: MoneyWire; balance_after: MoneyWire; min_balance: MoneyWire; breach: boolean };
  q7_plan: { in_plan: boolean; budget_line: string | null; used: MoneyWire | null; limit: MoneyWire | null; percent: number | null; period: string | null };
  evidence: { required: string[]; present: string[]; missing: string[] };
  matrix_label: string;
}

/* ---------------- báo cáo / forecast / các màn khác ---------------- */

export interface ReportColumn {
  key: string;
  label: string;
  type: 'money' | 'compact' | 'percent' | 'date' | 'number' | 'status' | 'days' | 'text';
  align: 'left' | 'right' | 'center';
  sortable?: boolean;
}

export interface ReportResult {
  preset: string;
  title: string;
  scope_label: string;
  as_of: string;
  generated_by: string;
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  totals?: Record<string, MoneyWire | number | string> | null;
  kpi?: { label: string; value: string; note?: string | null }[];
  chart?: { type: string; x_key: string; series: { key: string; label: string; values: number[] }[]; threshold?: number | null } | null;
  row_count: number;
  truncated: boolean;
}

export interface ReportPresetMeta {
  preset: string;
  label: string;
  href: string;
  exportable: boolean;
  /** v2: cần chọn đối tác trước (sổ chi tiết đối tác). */
  needs_partner?: boolean;
}

export interface MaturityRowWire {
  loan_id: string;
  contract_code: string;
  company_id: string;
  company_name: string;
  /** Ngân hàng cho vay (đối tác) — link tới trang đối tác. */
  partner_id: string | null;
  bank_name: string;
  outstanding: MoneyWire;
  interest_to_due: MoneyWire;
  fee_to_due: MoneyWire;
  maturity_date: string;
  days_to_due: number;
  need_prepare: MoneyWire;
  level: number;
  tone: string;
  label: string;
  rollover: { document_id: string | null; code: string | null; status: string | null; prepared: boolean } | null;
}

export interface RolloverResult {
  items: MaturityRowWire[];
  kpi: { today: MoneyWire; d3: MoneyWire; d7: MoneyWire; d30: MoneyWire };
  prepared_percent?: number;
}

export interface CashflowPoint {
  bucket: string;
  inflow: MoneyWire;
  outflow: MoneyWire;
  net: MoneyWire;
  cumulative: MoneyWire;
}

export interface CashflowLane {
  key: string;
  label: string;
  sub_label: string | null;
  company_id: string | null;
  account_id: string | null;
  points: CashflowPoint[];
  total_inflow: MoneyWire;
  total_outflow: MoneyWire;
  total_net: MoneyWire;
}

export type CashflowPeriod = '7d' | '30d' | '90d' | '6m' | '1y' | '2y';
export type CashflowGroup = 'none' | 'company' | 'account';
export type CashflowGranularity = 'day' | 'month';

export interface CashflowHistoryResult {
  period: CashflowPeriod;
  group: CashflowGroup;
  granularity: CashflowGranularity;
  from: string;
  to: string;
  buckets: string[];
  lanes: CashflowLane[];
  totals: { inflow: MoneyWire; outflow: MoneyWire; net: MoneyWire };
  scope_label: string;
  generated_at?: string;
}

export interface Newsletter {
  date: string;
  generated_at: string;
  company_names: string[];
  lines: Record<string, MoneyWire | number>;
  warnings: { tone: string; text: string; href?: string }[];
  sections: { key: string; title: string; items: { label: string; amount?: MoneyWire; note?: string | null, text?: string | null }[] }[];
  print_url?: string;
}

export interface BankAccountRow {
  _id: string;
  company_id: string | null;
  company_name: string | null;
  company_code?: string | null;
  is_group: boolean;
  label: string;
  bank_name: string;
  account_name: string;
  account_number_masked: string;
  kind: string;
  currency: string;
  status: string;
  /** Số dư thực tế = Σ sổ cái đến hôm nay (v2 §4.2). */
  balance: MoneyWire | null;
  /** Dự kiến = thực tế + phiếu đã duyệt chờ thực thi (30 ngày). */
  projected?: MoneyWire | null;
  planned_in?: MoneyWire | null;
  planned_out?: MoneyWire | null;
  min_balance: MoneyWire;
  /** Số dư thực tế dưới ngưỡng tối thiểu. */
  breach: boolean;
  /** Số dư dự kiến dưới ngưỡng tối thiểu. */
  breach_projected?: boolean;
  stale: boolean;
  balance_date: string | null;
  updated_at?: string | null;
}

/** GET /bank-accounts: `items` theo loại TK và trang (nếu có); `total` = số TK khớp loại; `totals` = trên mọi TK trong phạm vi. */
export interface BankAccountListResult {
  items: BankAccountRow[];
  total: number;
  totals?: { balance: MoneyWire; projected: MoneyWire };
}

export interface BankAccountDetail {
  _id: string;
  company_id: string | null;
  company_name: string | null;
  is_group: boolean;
  bank_name: string;
  account_name: string;
  account_number: string;
  branch: string | null;
  kind: string;
  currency: string;
  manager_user_id: string | null;
  limit_minor: string | null;
  min_balance_minor: string;
  show_on_dashboard: boolean;
  status: string;
  note: string | null;
  updated_at: string | null;
}

/** GET /bank-accounts/:id/transactions — một dòng lịch sử giao dịch. */
export interface BankTransactionRow {
  _id: string;
  at: string | null;
  date: string;
  direction: 'in' | 'out';
  kind: string;
  direction_label: string;
  direction_tone: string;
  opening: MoneyWire;
  amount: MoneyWire;
  closing: MoneyWire;
  currency: string;
  content: string;
  counterparty: string;
  /** Đối tác của phiếu (nếu có) — link tới trang đối tác. */
  partner_id: string | null;
  reason: string;
  document: { id: string; code: string; kind: string; href: string } | null;
}

export interface BankAccountTransactions {
  account: {
    _id: string;
    company_id: string | null;
    company_name: string | null;
    is_group: boolean;
    label: string;
    bank_name: string;
    account_number: string;
    account_name: string;
    kind: string;
    currency: string;
  };
  items: BankTransactionRow[];
}

export interface RolloverPreparation {
  horizon_days: number;
  /** v2: số dư sổ cái (server không còn trả `available`). */
  balance: MoneyWire;
  need: MoneyWire;
  maturity: MoneyWire;
  planned_spend: MoneyWire;
  gap: MoneyWire;
  breach: boolean;
  rows: { date: string; label: string; amount: MoneyWire; principal: MoneyWire; interest: MoneyWire; tone: string }[];
}

export interface OwnerAttachment {
  id: string;
  type: string;
  version: number;
  filename: string;
  size: number;
  mime: string;
  added_at: string | null;
  added_by: string | null;
  download_href: string;
  referenced: boolean;
}

export interface MatrixEntry {
  _id: string;
  company_id: string | null;
  company_name: string | null;
  doc_kind: string;
  category_id: string | null;
  amount_min_minor: string;
  amount_max_minor?: string | null;
  currency: string;
  steps: { order: number; role: string; role_label: string; sla_hours: number; mandatory: boolean }[];
  version: number;
  effective_from: string;
  label: string;
  active: boolean;
}

export interface ApprovalThresholdKindValues {
  spend?: string | null;
  income?: string | null;
  rollover?: string | null;
  internal?: string | null;
}

export interface ApprovalThresholdCompany {
  company_id: string;
  company_name: string;
  /** ngưỡng chung override cho công ty (null = kế thừa mặc định). */
  amount_minor: string | null;
  /** ngưỡng theo loại hồ sơ override cho công ty (null = kế thừa). */
  by_kind: ApprovalThresholdKindValues;
  /** ngưỡng hiệu lực từng loại sau khi kế thừa. */
  effective: Record<'spend' | 'income' | 'rollover' | 'internal', string>;
}

export interface ApprovalThresholdResult {
  default_minor: string;
  amount_minor: string | null;
  by_kind: ApprovalThresholdKindValues;
  companies: ApprovalThresholdCompany[];
}

export interface PersonnelCompany {
  company_id: string;
  company_name: string;
  department_id: string | null;
  department_name: string | null;
}

export interface PersonnelRow {
  user_id: string;
  display_name: string;
  email: string;
  email_masked: boolean;
  company_id: string;
  company_name: string;
  department_id: string | null;
  department_name: string | null;
  /** toàn bộ công ty nhân sự trực thuộc (công ty đầu là công ty chính). */
  companies: PersonnelCompany[];
  role: string;
  role_label: string;
  status: 'invited' | 'active' | 'deactivated';
  amount_limit_minor: string;
  mfa_enabled: boolean;
  last_login_at: string | null;
  invited_at: string | null;
  /** trạng thái link đã ký (invited = kích hoạt; active = link đổi mật khẩu do quản trị cấp). */
  invite_status: 'active' | 'expired' | 'revoked' | 'used' | 'none';
  invite_expires_at: string | null;
  invite_regenerate_count: number;
  started_at: string | null;
  holding_docs: number;
  extra_permissions: string[];
  denied_permissions: string[];
}

/** kết quả GET/POST /personnel/:id/invite-link — admin copy link gửi tay. */
export interface InviteLinkResult {
  user_id: string;
  email: string;
  /** activate = kích hoạt · reset = đặt lại mật khẩu cho tài khoản đã hoạt động · null = chưa có link. */
  mode: 'activate' | 'reset' | null;
  status: 'active' | 'expired' | 'revoked' | 'used' | 'none';
  invite_url: string | null;
  expires_at: string | null;
  invited_at: string | null;
  regenerate_count: number;
  send_count: number;
}

/** thông tin lời mời cho màn /kich-hoat (public). */
export interface InviteInfo {
  /** activate = kích hoạt lần đầu · reset = đặt lại mật khẩu. */
  mode: 'activate' | 'reset';
  email: string;
  display_name: string | null;
  company_name: string;
  role: string;
  role_label: string;
  department_name: string | null;
  invited_by_name: string | null;
  expires_at: string;
  mfa_required: boolean;
}

/** kết quả POST /activate — một bước, có phiên ngay. */
export interface ActivateResult {
  ok: boolean;
  user_id: string;
  /** vai trò nhóm bắt buộc 2FA → FE nhắc bật trong Cài đặt sau khi đăng nhập. */
  mfa_suggested?: boolean;
}

export interface AuditRow {
  _id: string;
  at: string;
  actor: { user_id: string; name: string; role: string | null };
  action: string;
  subject: { type: string; id: string; code: string | null };
  company_id: string | null;
  company_name: string | null;
  diff_fields: { field: string; before: unknown; after: unknown }[];
  ip: string | null;
  ua: string | null;
}

export interface NotificationRow {
  _id: string;
  type: string;
  title: string;
  body?: string;
  severity?: string;
  href?: string | null;
  read_at: string | null;
  created_at: string;
}

/** GET /alerts — một sự kiện cảnh báo. Server trả `_id` và nhãn `type_label` (đã gồm loại v2 mới). */
export interface AlertRow {
  _id: string;
  type: string;
  type_label: string;
  severity: number;
  tone: string;
  text: string;
  amount?: MoneyWire | null;
  company_id?: string | null;
  href?: string | null;
  created_at?: string | null;
  acknowledged_at?: string | null;
}

export interface CompanyRow {
  _id: string;
  name: string;
  code: string;
  tax_code?: string | null;
  address?: string | null;
  contact_email?: string | null;
  is_group?: boolean;
  status?: string;
  min_balance?: MoneyWire;
  working_calendar?: { workdays: number[]; holidays: string[] } | null;
}

export interface SearchHit {
  type: string;
  id: string;
  code?: string;
  title: string;
  subtitle?: string;
  amount?: MoneyWire | null;
  href: string;
}

export interface NeedsAttentionGroup {
  key: string;
  title: string;
  tone: string;
  items: QueueRow[];
}

/* ---------------- transition ---------------- */

export interface TransitionResult {
  data: { _id: string; code: string; status: string; version: number };
  transition: { action: string; from: string; to: string; next_role: string | null };
}

/* ---------------- sao lưu dữ liệu (ADM-14) ---------------- */

export interface BackupFile {
  file: string;
  size: number;
  created_at: string;
}


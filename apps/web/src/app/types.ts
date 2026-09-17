/**
 * FinGate web — kiểu dữ liệu trên WIRE (đã kiểm chứng với API đang chạy, handoff §3).
 *
 * Tiền trên wire là STRING minor units — mọi chỗ convert qua `money()` trước khi hiển thị.
 * Khi backend đổi: `pnpm api:types` sinh openapi-types; file này giữ các kiểu UI cần.
 */

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
    by_bank: { bank_name: string; outstanding: MoneyWire; share_percent: number }[];
  };
  exceptions: ExceptionItem[];
  awaiting_me_rows: AwaitingRow[];
  forecast?: { horizon_days: number; first_breach_date: string | null; net_30d?: MoneyWire } | null;
  receivable_overdue?: MoneyWire | null;
  payable_due?: MoneyWire | null;
  counts: Record<string, number>;
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
  amount: MoneyWire;
  compact: string;
  planned_date: string;
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
    fee_estimate: MoneyWire | null;
    new_rate: string | null;
    collateral: string | null;
    proposal: string | null;
    result?: { done_at: string | null; new_contract: string | null; actual_fee: MoneyWire | null; note: string | null } | null;
  } | null;
  debt_code: string | null;
  note: string | null;
  approval: { matrix_id: string | null; matrix_version: number; matrix_label?: string; steps: ApprovalStep[] };
  evidence: { required: string[]; present: string[]; missing: string[] };
  attachments: AttachmentRef[];
  execution: { paid_at: string | null; bank_ref: string | null; executed_by: string | null; actual_amount: MoneyWire | null } | null;
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
    override: boolean;
    attach: boolean;
    export: boolean;
    over_limit: boolean;
    step_order: number | null;
    reason?: string | null;
  };
}

export interface DecisionPack {
  document_id: string;
  code: string;
  q1_payee: { name: string; tax_code: string | null; is_internal: boolean; bank: string | null };
  q2_amount: { amount: MoneyWire; amount_usd: MoneyWire | null; fx_rate: string | null };
  q3_purpose: { text: string; category: string | null; department: string | null };
  q4_basis: { contract_code: string | null; contract_value: MoneyWire | null; invoice: string | null };
  q5_source: { fund: string; account_label: string; group_account_label: string | null; group_managed: boolean };
  q6_impact: { available_now: MoneyWire; balance_after: MoneyWire; min_balance: MoneyWire; breach: boolean };
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
}

export interface MaturityRowWire {
  loan_id: string;
  contract_code: string;
  company_id: string;
  company_name: string;
  bank_name: string;
  outstanding: MoneyWire;
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

export interface ForecastRow {
  date: string;
  weekday: string;
  opening: MoneyWire;
  inflow: MoneyWire;
  outflow: MoneyWire;
  net: MoneyWire;
  closing: MoneyWire;
  min_balance: MoneyWire;
  breach: boolean;
  drivers?: { kind: string; label: string; amount: MoneyWire; document_id: string | null }[];
}

export interface ForecastResult {
  rows: ForecastRow[];
  totals: { inflow: MoneyWire; outflow: MoneyWire; net: MoneyWire; min_closing: MoneyWire };
  first_breach_date: string | null;
  shortfall_by_company?: { company_id: string; company_name: string; date: string; amount: MoneyWire }[];
  generated_at?: string;
  stale?: boolean;
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
  is_group: boolean;
  label: string;
  bank_name: string;
  account_name: string;
  account_number_masked: string;
  kind: string;
  currency: string;
  status: string;
  balance: MoneyWire | null;
  available: MoneyWire | null;
  blocked: MoneyWire | null;
  min_balance: MoneyWire;
  breach: boolean;
  stale: boolean;
  balance_date: string | null;
  updated_at?: string | null;
}

export interface LoanRow {
  _id: string;
  company_id: string;
  company_name: string;
  bank_name: string;
  contract_code: string;
  limit: MoneyWire;
  outstanding: MoneyWire;
  currency: string;
  disbursed_at: string;
  maturity_date: string;
  next_due_date: string | null;
  days_to_due: number;
  interest_rate: string;
  interest_period: string;
  principal_period: string;
  collateral: string | null;
  manager_name: string | null;
  status: string;
  rollover_status: string | null;
  updated_at: string;
}

export interface DebtRowWire {
  _id: string;
  kind: 'receivable' | 'payable';
  company_id: string;
  company_name: string;
  counterparty_name: string;
  contract_code: string | null;
  value: MoneyWire;
  settled: MoneyWire;
  remaining: MoneyWire;
  due_date: string;
  days_overdue: number;
  aging_bucket: string;
  priority: string;
  progress_percent: number;
  open_document_id: string | null;
  updated_at: string;
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

export interface PersonnelRow {
  user_id: string;
  display_name: string;
  email: string;
  email_masked: boolean;
  company_id: string;
  company_name: string;
  department_name: string | null;
  role: string;
  role_label: string;
  status: 'invited' | 'active' | 'deactivated';
  amount_limit_minor: string;
  mfa_enabled: boolean;
  last_login_at: string | null;
  invited_at: string | null;
  /** trạng thái link kích hoạt đã ký (chỉ có nghĩa khi status = invited). */
  invite_status: 'active' | 'expired' | 'revoked' | 'none';
  invite_expires_at: string | null;
  invite_regenerate_count: number;
  started_at: string | null;
  holding_docs: number;
}

/** kết quả GET/POST /personnel/:id/invite-link — admin copy link gửi tay. */
export interface InviteLinkResult {
  user_id: string;
  email: string;
  status: 'active' | 'expired' | 'revoked' | 'used' | 'none';
  invite_url: string | null;
  expires_at: string | null;
  invited_at: string | null;
  regenerate_count: number;
  send_count: number;
}

/** thông tin lời mời cho màn /kich-hoat (public). */
export interface InviteInfo {
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
  diff_fields: string[];
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

export interface AlertRow {
  id: string;
  type: string;
  text: string;
  amount?: MoneyWire | null;
  tone: string;
  href?: string | null;
  created_at?: string;
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

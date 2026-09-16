/**
 * FinGate — hợp đồng dashboard · báo cáo · cảnh báo · danh mục · cài đặt · audit · tasks
 */

import { z } from 'zod';
import { MATURITY_BUCKETS, ROLES, STATUS_KEYS, DOC_KINDS } from '../status/index.js';
const lit = <T extends string>(arr: readonly T[]) => arr as unknown as [T, ...T[]];
import { businessDate, moneyWire, objectId, uuid } from './common.js';

/* ------------------------------------------------------------------ *
 * DASH-01 — một endpoint gộp, `Cache-Control: private, max-age=15` + ETag (§8.3)
 * ------------------------------------------------------------------ */

export const dashboardQuery = z.object({
  scope: z.string().max(64).optional(),
  date: businessDate.optional(),
});

export const kpiBlock = z.object({
  label: z.string(),
  amount: moneyWire,
  compact: z.string(),
  breakdown: z.array(z.object({ label: z.string(), amount: moneyWire, compact: z.string() })).default([]),
  /** delta so với kỳ trước — tone theo Ý NGHĨA (DS §7.22). */
  delta_percent: z.number().nullable().default(null),
  as_of: z.string(),
});

export const exceptionItem = z.object({
  id: z.string(),
  severity: z.number().int().min(0).max(3),
  tone: z.string(),
  glyph: z.string(),
  /** Câu hành động có số: "3 khoản chi > 1 tỷ chờ bạn duyệt" (DS §7.17). */
  text: z.string(),
  amount: moneyWire.nullable(),
  compact: z.string().nullable(),
  href: z.string(),
  cta: z.string(),
});

export const overviewResult = z.object({
  scope: z.object({ all: z.boolean(), company_ids: z.array(objectId), company_names: z.array(z.string()) }),
  business_date: businessDate,
  generated_at: z.string(),
  stale: z.boolean(),
  /** công ty chưa đồng bộ số dư hôm nay → FgAlert partial (§7.10). */
  partial_companies: z.array(z.object({ company_id: objectId, name: z.string(), last_balance_date: businessDate.nullable() })),
  kpi: z.object({
    cash_total: kpiBlock,
    income_today: kpiBlock,
    spend_today: kpiBlock,
    awaiting_me: kpiBlock,
  }),
  bank: z.object({
    debt_total: moneyWire,
    maturity_today: moneyWire,
    maturity_7d: moneyWire,
    maturity_30d: moneyWire,
    by_bank: z.array(z.object({ bank_name: z.string(), outstanding: moneyWire, share_percent: z.number() })),
  }),
  exceptions: z.array(exceptionItem).max(20),
  /** top 8 hồ sơ chờ tôi duyệt (DASH-01 tầng 05). */
  awaiting_me_rows: z
    .array(
      z.object({
        document_id: objectId,
        code: z.string(),
        kind: z.enum(lit(DOC_KINDS)),
        company_name: z.string(),
        title: z.string(),
        amount: moneyWire,
        compact: z.string(),
        created_by_name: z.string(),
        status: z.enum(lit(STATUS_KEYS)),
        waiting_days: z.number().int(),
        next_role_label: z.string().nullable(),
        overdue: z.boolean(),
      }),
    )
    .max(8),
  forecast: z
    .object({
      horizon_days: z.number().int(),
      rows: z.array(z.object({ date: businessDate, weekday: z.string(), closing: moneyWire, breach: z.boolean() })),
      min_closing: moneyWire,
      first_breach_date: businessDate.nullable(),
    })
    .nullable(),
  receivable_overdue: moneyWire,
  payable_due: moneyWire,
  counts: z.object({
    awaiting_me: z.number().int(),
    overdue_receivable: z.number().int(),
    maturity_7d_count: z.number().int(),
    missing_evidence: z.number().int(),
    notifications_unread: z.number().int(),
  }),
});

export type OverviewResult = z.infer<typeof overviewResult>;

/* ------------------------------------------------------------------ *
 * DASH-03 — bản tin tài chính hàng ngày (§XIV)
 * ------------------------------------------------------------------ */

export const newsletterQuery = z.object({ date: businessDate.optional(), scope: z.string().max(64).optional() });

export const newsletterResult = z.object({
  date: businessDate,
  generated_at: z.string(),
  company_names: z.array(z.string()),
  lines: z.object({
    total_cash: moneyWire,
    income_today: moneyWire,
    income_today_realized: moneyWire,
    spend_today: moneyWire,
    net_today: moneyWire,
    awaiting_me: moneyWire,
    awaiting_me_count: z.number().int(),
    receivable_overdue: moneyWire,
    maturity_today: moneyWire,
    maturity_3d: moneyWire,
    maturity_7d: moneyWire,
    maturity_30d: moneyWire,
  }),
  warnings: z.array(z.object({ tone: z.string(), text: z.string(), href: z.string().nullable() })),
  sections: z.array(
    z.object({
      key: z.string(),
      title: z.string(),
      items: z.array(z.object({ label: z.string(), amount: moneyWire.nullable(), note: z.string().nullable() })).default([]),
    }),
  ),
  print_url: z.string(),
});

/* ------------------------------------------------------------------ *
 * Báo cáo (§XXII) — 1 khung + preset
 * ------------------------------------------------------------------ */

export const REPORT_PRESETS = [
  'thu-chi-ngay',
  'thu-chi-thang',
  'so-du-ngan-hang',
  'cong-no-phai-thu',
  'cong-no-phai-tra',
  'vay-ngan-hang',
  'dao-han',
  'dong-tien',
  'chi-bo-phan',
  'chi-loai',
  'theo-cong-ty',
  'cho-duyet',
  'hs-ketoan',
] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const REPORT_LABEL: Record<ReportPreset, string> = {
  'thu-chi-ngay': 'Thu – chi ngày',
  'thu-chi-thang': 'Thu – chi tháng',
  'so-du-ngan-hang': 'Số dư ngân hàng',
  'cong-no-phai-thu': 'Công nợ phải thu',
  'cong-no-phai-tra': 'Công nợ phải trả',
  'vay-ngan-hang': 'Vay ngân hàng',
  'dao-han': 'Đáo hạn',
  'dong-tien': 'Dòng tiền',
  'chi-bo-phan': 'Chi theo bộ phận',
  'chi-loai': 'Chi theo loại',
  'theo-cong-ty': 'So sánh theo công ty',
  'cho-duyet': 'Khoản chờ duyệt',
  'hs-ketoan': 'Hiệu suất phòng kế toán',
};

export const reportQuery = z.object({
  scope: z.string().max(64).optional(),
  company_id: objectId.optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  period: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
  group_by: z.enum(['company', 'department', 'category', 'bank', 'status', 'creator']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const reportColumn = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(['text', 'money', 'compact', 'percent', 'date', 'number', 'status', 'days']),
  align: z.enum(['left', 'right', 'center']),
  sortable: z.boolean().default(false),
  /** cột cần quyền riêng — ẩn kèm lý do (§19.5-4). */
  permission: z.string().optional(),
});

export const reportResult = z.object({
  preset: z.enum(lit(REPORT_PRESETS)),
  title: z.string(),
  scope_label: z.string(),
  as_of: z.string(),
  generated_by: z.string(),
  columns: z.array(reportColumn),
  rows: z.array(z.record(z.string(), z.unknown())),
  totals: z.record(z.string(), z.unknown()).default({}),
  kpi: z.array(z.object({ label: z.string(), value: z.string(), note: z.string().nullable() })).default([]),
  chart: z
    .object({
      type: z.enum(['area', 'line', 'bar', 'stacked', 'donut']),
      x_key: z.string(),
      series: z.array(z.object({ key: z.string(), label: z.string(), values: z.array(z.number().nullable()) })).max(5),
      threshold: z.object({ value: z.number(), label: z.string() }).nullable().default(null),
    })
    .nullable(),
  truncated: z.boolean().default(false),
  row_count: z.number().int(),
});

export const exportRequestBody = z.object({
  kind: z.enum(['report', 'list']),
  preset: z.enum(lit(REPORT_PRESETS)).optional(),
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  query: z.record(z.string(), z.unknown()).default({}),
  request_id: uuid,
});

export const exportJobRow = z.object({
  job_id: objectId,
  state: z.enum(['queued', 'running', 'done', 'failed']),
  format: z.string(),
  created_at: z.string(),
  finished_at: z.string().nullable(),
  download_url: z.string().nullable(),
  error: z.string().nullable(),
  row_count: z.number().int().nullable(),
});

/* ------------------------------------------------------------------ *
 *ADM-08 — danh mục khoản chi/thu (§VI) + chứng từ bắt buộc theo loại (Q-04)
 * ------------------------------------------------------------------ */

export const CATEGORY_GROUPS = ['hoat_dong', 'dau_tu', 'tai_chinh', 'khac'] as const;
export type CategoryGroup = (typeof CATEGORY_GROUPS)[number];

export const CATEGORY_GROUP_LABEL: Record<CategoryGroup, string> = {
  hoat_dong: 'Chi hoạt động',
  dau_tu: 'Chi đầu tư',
  tai_chinh: 'Tài chính',
  khac: 'Khoản khác',
};

export const categoryUpsertBody = z.object({
  name: z.string().min(2).max(120),
  code: z.string().max(20).optional(),
  group: z.enum(lit(CATEGORY_GROUPS)).default('khac'),
  doc_kind: z.enum(lit(DOC_KINDS)).default('spend'),
  parent_id: objectId.nullable().optional(),
  /** chứng từ bắt buộc theo loại phiếu — cấu hình được, không hard-code (§XXX.2). */
  required_evidence: z.array(z.string().max(30)).default([]),
  requires_budget: z.boolean().default(false),
  /** ma trận duyệt riêng cho danh mục này (optional, §XX). */
  matrix_id: objectId.nullable().optional(),
  active: z.boolean().default(true),
  order: z.number().int().default(0),
});

export const categoryRow = z.object({
  _id: objectId,
  name: z.string(),
  code: z.string().nullable(),
  group: z.enum(lit(CATEGORY_GROUPS)),
  group_label: z.string(),
  doc_kind: z.enum(lit(DOC_KINDS)),
  doc_kind_label: z.string(),
  parent_id: objectId.nullable(),
  required_evidence: z.array(z.string()),
  requires_budget: z.boolean(),
  active: z.boolean(),
  order: z.number().int(),
  usage_count: z.number().int().default(0),
});

/* ------------------------------------------------------------------ *
 *ADM-10 — cảnh báo (§XVIII: 8 loại) + NOTI-01/02
 * ------------------------------------------------------------------ */

export const ALERT_TYPES = [
  'approval_overdue',
  'loan_maturity',
  'low_balance',
  'receivable_overdue',
  'budget_exceeded',
  'missing_evidence',
  'payment_due',
  'negative_cashflow',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_LABEL: Record<AlertType, string> = {
  approval_overdue: 'Khoản chi chờ duyệt quá lâu',
  loan_maturity: 'Khoản vay sắp đáo hạn',
  low_balance: 'Số dư ngân hàng thấp',
  receivable_overdue: 'Khoản phải thu quá hạn',
  budget_exceeded: 'Khoản chi vượt ngân sách',
  missing_evidence: 'Hồ sơ thiếu chứng từ',
  payment_due: 'Khoản thanh toán đến hạn',
  negative_cashflow: 'Dòng tiền âm',
};

export const alertRuleUpsertBody = z.object({
  type: z.enum(lit(ALERT_TYPES)),
  company_id: objectId.nullable().default(null),
  enabled: z.boolean().default(true),
  severity: z.number().int().min(0).max(3).default(2),
  /** ngưỡng cấu hình được (ngày, số tiền, %). */
  threshold: z.record(z.string(), z.unknown()).default({}),
  channels: z.array(z.enum(['web', 'email'])).default(['web']),
  to_roles: z.array(z.enum(lit(ROLES))).default(['chief_accountant', 'director']),
});

export const alertEventRow = z.object({
  _id: objectId,
  type: z.enum(lit(ALERT_TYPES)),
  severity: z.number().int(),
  tone: z.string(),
  text: z.string(),
  amount: moneyWire.nullable(),
  company_id: objectId.nullable(),
  company_name: z.string().nullable(),
  href: z.string().nullable(),
  created_at: z.string(),
  acknowledged_at: z.string().nullable(),
  acknowledged_by: z.string().nullable(),
  dedupe_key: z.string(),
});

export const notificationRow = z.object({
  _id: objectId,
  kind: z.enum(['approval', 'alert', 'system', 'newsletter', 'hr']),
  severity: z.number().int().min(0).max(3).default(1),
  title: z.string(),
  body: z.string(),
  href: z.string().nullable(),
  document_id: objectId.nullable(),
  created_at: z.string(),
  read_at: z.string().nullable(),
});

export const notificationListQuery = z.object({
  unread_only: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/* ------------------------------------------------------------------ *
 * ADM-12 audit log · ADM-13 phiên · ADM-13 db-stats · settings · search
 * ------------------------------------------------------------------ */

export const auditLogQuery = z.object({
  company_id: objectId.optional(),
  actor_user_id: objectId.optional(),
  action: z.string().max(60).optional(),
  subject_type: z.string().max(40).optional(),
  subject_id: z.string().max(64).optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  page: z.coerce.number().int().min(1).default(1),
});

export const auditLogRow = z.object({
  _id: objectId,
  at: z.string(),
  actor: z.object({ user_id: objectId.nullable(), name: z.string().nullable(), role: z.string().nullable() }),
  action: z.string(),
  subject: z.object({ type: z.string(), id: z.string().nullable(), code: z.string().nullable() }),
  company_id: objectId.nullable(),
  company_name: z.string().nullable(),
  diff_fields: z.array(z.object({ field: z.string(), before: z.unknown().nullable(), after: z.unknown().nullable() })).default([]),
  ip: z.string().nullable(),
  ua: z.string().nullable(),
  request_id: z.string().nullable(),
});

export const sessionRow = z.object({
  _id: objectId,
  user_id: objectId,
  user_name: z.string().nullable(),
  ip: z.string().nullable(),
  ua: z.string().nullable(),
  created_at: z.string(),
  last_seen: z.string(),
  expires_at: z.string(),
  current: z.boolean().default(false),
  abnormal: z.boolean().default(false),
});

export const dbStats = z.object({
  database: z.string(),
  storage_bytes: z.number(),
  index_bytes: z.number(),
  limit_bytes: z.number(),
  usage_percent: z.number(),
  collections: z.array(z.object({ name: z.string(), count: z.number(), storage_bytes: z.number(), indexes: z.number() })),
  at: z.string(),
});

export const settingUpsertBody = z.object({
  key: z.string().min(2).max(80),
  value: z.record(z.string(), z.unknown()),
  request_id: uuid,
});

export const searchQuery = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const searchHit = z.object({
  type: z.enum(['document', 'loan', 'counterparty', 'person', 'screen', 'account']),
  id: z.string(),
  code: z.string().nullable(),
  title: z.string(),
  subtitle: z.string().nullable(),
  amount: moneyWire.nullable(),
  href: z.string(),
});

export const searchResult = z.object({
  query: z.string(),
  hits: z.array(searchHit),
  /** số kết quả bị ẩn vì không có quyền — phân biệt "0 vì quyền" (§7.20). */
  hidden_by_permission: z.number().int(),
});

/* ------------------------------------------------------------------ *
 * Tasks (GH Actions → POST /v1/tasks/:name) + health
 * ------------------------------------------------------------------ */

export const TASK_NAMES = [
  'newsletter',
  'sla-scan',
  'alerts',
  'recurring',
  'maintenance',
  'reconcile',
  'rebuild-balances',
  'rebuild-audit',
  'check-tie',
  'archive',
  'cleanup',
] as const;
export type TaskName = (typeof TASK_NAMES)[number];

export const healthResult = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptime_s: z.number(),
  db: z.enum(['up', 'down']),
  memory_mb: z.number(),
  profile: z.enum(['cloud', 'onprem']),
});

/** CHI-08/09 — khoản chi định kỳ (§XVII). */
export const recurringUpsertBody = z.object({
  company_id: objectId,
  title: z.string().min(3).max(200),
  purpose: z.string().min(3).max(1000),
  category_id: objectId.nullable().optional(),
  department_id: objectId.nullable().optional(),
  payee: z.object({ name: z.string().min(2).max(200), tax_code: z.string().max(20).optional() }),
  amount: z.object({ amount_minor: z.string().regex(/^\d+$/), currency: z.string().length(3).default('VND') }),
  source: z.object({ fund: z.enum(['bank', 'cash']), account_id: objectId.nullable() }),
  cadence: z.enum(['monthly', 'quarterly', 'semi_annual', 'annual', 'weekly']),
  day_of_period: z.number().int().min(1).max(31).default(1),
  /** nhắc trước 7/3/1 ngày (§XVII). */
  remind_days: z.array(z.number().int().min(1).max(60)).default([7, 3, 1]),
  effective_from: businessDate,
  effective_to: businessDate.nullable().optional(),
  auto_create_draft: z.boolean().default(true),
  status: z.enum(['active', 'paused']).default('active'),
});

export const recurringRow = z.object({
  _id: objectId,
  company_id: objectId,
  company_name: z.string(),
  title: z.string(),
  category_name: z.string().nullable(),
  amount: moneyWire,
  cadence: z.string(),
  cadence_label: z.string(),
  next_date: businessDate,
  days_until: z.number().int(),
  remind_in: z.array(z.number().int()),
  last_document_code: z.string().nullable(),
  status: z.enum(['active', 'paused']),
  progress_percent: z.number().min(0).max(100),
});

export const DEBT_PRIORITY = ['low', 'normal', 'high', 'critical'] as const;

export const maturityBucketParam = z.enum(lit(MATURITY_BUCKETS));

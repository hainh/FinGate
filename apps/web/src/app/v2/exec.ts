/**
 * FinGate web — v2 điều hành & quản trị (v2/v2.md §11.7, §12, §13): kiểu trên WIRE + react-query hooks.
 *
 * Nguồn hợp đồng (đối chiếu đúng response):
 *   GET   /cashflow/forecast?horizon=&from=        dự báo 7/30/60/90 ngày  → { data: CashflowForecast }
 *   GET   /automation/rules?company_id=            quy tắc + hiệu lực      → { data: AutomationRule[] }
 *   PATCH /automation/rules/:id                    bật/tắt, tham số, ghi đè → { data: AutomationRule | null }
 *   GET   /automation/runs?…                       lượt chạy theo bộ lọc   → { data: AutomationRun[] }
 *   POST  /automation/runs/:id/rerun               chạy lại lượt lỗi       → { data: AutomationRun | null }
 *   GET   /admin/recurring                         khoản chi định kỳ       → { items: RecurringRow[] }
 *   POST  /admin/recurring                         tạo khoản định kỳ       → { data: { _id, preview } }
 *   PATCH /alerts/:id/ack                          đánh dấu đã xử lý       → { data: { ok } }
 *
 * Tiền trên wire là `MoneyWire` (minor = chuỗi). Mọi queryKey có `scope` → đổi công ty là tự refetch.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AutomationRuleUpdateBody, PartnerType } from '@fingate/shared';
import { apiCall, apiData } from '../api.ts';
import { useAuth } from '../store.tsx';
import type { MoneyWire } from '../types.ts';

/* ================= dự báo dòng tiền ================= */

export const FORECAST_HORIZON_OPTIONS = [7, 30, 60, 90] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZON_OPTIONS)[number];

export interface ForecastDayWire {
  date: string;
  weekday: string;
  opening: MoneyWire;
  operating_in: MoneyWire;
  disbursement_in: MoneyWire;
  internal_in: MoneyWire;
  operating_out: MoneyWire;
  internal_out: MoneyWire;
  loan_repayment_out: MoneyWire;
  inflow: MoneyWire;
  outflow: MoneyWire;
  net: MoneyWire;
  closing: MoneyWire;
  min_balance: MoneyWire;
  breach: boolean;
}

/** Giải ngân: `receipt` = phiếu thu vay đã có ngày; `pending_loan` = khoản chờ giải ngân chưa có phiếu (không ngày). */
export interface ForecastDisbursementItem {
  kind: 'receipt' | 'pending_loan';
  code: string;
  company_id: string;
  partner_id: string | null;
  partner_name: string;
  date: string | null;
  amount: MoneyWire;
  href: string | null;
}

export interface ForecastRepaymentItem {
  bank_debt_id: string;
  code: string;
  company_id: string;
  partner_id: string | null;
  partner_name: string;
  due_date: string;
  principal: MoneyWire;
  interest: MoneyWire;
  total: MoneyWire;
}

export interface CashflowForecast {
  horizon: number;
  from: string;
  to: string;
  opening: MoneyWire;
  min_balance: MoneyWire;
  totals: {
    operating_in: MoneyWire;
    disbursement_in: MoneyWire;
    internal_in: MoneyWire;
    operating_out: MoneyWire;
    internal_out: MoneyWire;
    loan_repayment_out: MoneyWire;
    inflow: MoneyWire;
    outflow: MoneyWire;
    net: MoneyWire;
    min_closing: MoneyWire;
    end_closing: MoneyWire;
  };
  first_breach_date: string | null;
  days: ForecastDayWire[];
  shortfall_by_company: { company_id: string; company_name: string; first_breach_date: string; min_closing: MoneyWire; amount: MoneyWire }[];
  disbursements: { dated: ForecastDisbursementItem[]; undated: ForecastDisbursementItem[]; undated_total: MoneyWire };
  repayments: ForecastRepaymentItem[];
  generated_at: string;
  horizons?: number[];
}

export function useCashflowForecast(horizon: ForecastHorizon) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['cashflow-forecast', scope, horizon],
    queryFn: () => apiData<CashflowForecast>('/cashflow/forecast', { query: { scope, horizon } }),
  });
}

/* ================= quy tắc tự động ================= */

export type AutomationRuleCodeText = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';

/** Ghi đè theo công ty: thay toàn bộ danh sách khi PATCH (server không gộp). */
export interface AutomationOverride {
  company_id: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface AutomationRule {
  _id: string;
  code: AutomationRuleCodeText;
  name: string;
  trigger_event: string;
  trigger_events: string[];
  condition: Record<string, unknown>;
  steps: string[];
  /** tham số mặc định toàn hệ thống. */
  params: Record<string, unknown>;
  /** công tắc tổng (mọi công ty). */
  enabled: boolean;
  /** rỗng = mọi công ty. */
  company_ids: string[];
  company_overrides: AutomationOverride[];
  /** hiệu lực tại công ty đang xem (null khi không chọn công ty). */
  effective: { company_id: string; enabled: boolean; params: Record<string, unknown> } | null;
  /** bộ xử lý đã đăng ký trong tiến trình (false ⇒ quy tắc bị bỏ qua dù đang bật). */
  handler_registered: boolean;
  updated_at: string;
}

export interface GeneratedObjectView {
  type: 'document' | 'bank_debt';
  id: string;
  code: string | null;
  status: string | null;
  /** phiếu: spend | income | rollover | internal; khoản vay: null. */
  kind: string | null;
  href: string | null;
}

export interface AutomationRunStep {
  name: string;
  status: 'pending' | 'done' | 'failed' | 'skipped';
  output_type: string | null;
  output_id: string | null;
  error: string | null;
  at: string | null;
  output: GeneratedObjectView | null;
}

export interface AutomationRun {
  _id: string;
  rule_code: string;
  rule_name: string;
  company_id: string | null;
  source_type: string;
  source_id: string;
  event_type: string;
  idem_key: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  steps: AutomationRunStep[];
  generated: GeneratedObjectView[];
}

export interface AutomationRunFilters {
  status?: string;
  rule_code?: string;
  company_id?: string;
  source_type?: string;
  source_id?: string;
  limit?: number;
}

export function useAutomationRules(companyId: string | null) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['automation-rules', scope, companyId ?? ''],
    queryFn: () => apiData<AutomationRule[]>('/automation/rules', { query: { scope, company_id: companyId ?? undefined } }),
  });
}

export function useUpdateAutomationRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AutomationRuleUpdateBody }) =>
      apiData<AutomationRule | null>(`/automation/rules/${id}`, { method: 'PATCH', body }),
    // lỗi (kể cả xung đột "đã được sửa bởi người khác") ⇒ tải lại danh sách để thấy cấu hình mới nhất
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['automation-rules'] });
    },
  });
}

export function useAutomationRuns(filters: AutomationRunFilters) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['automation-runs', scope, filters],
    queryFn: () => apiData<AutomationRun[]>('/automation/runs', { query: { scope, ...filters } }),
  });
}

export function useRerunAutomationRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData<AutomationRun | null>(`/automation/runs/${id}/rerun`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['automation-runs'] });
      void qc.invalidateQueries({ queryKey: ['automation-rules'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

/* ================= khoản chi định kỳ ================= */

export type RecurringCadence = 'weekly' | 'monthly' | 'quarterly' | 'semi_annual' | 'annual';

export interface RecurringRow {
  _id: string;
  company_id: string;
  company_name: string;
  title: string;
  category_name: string | null;
  amount: MoneyWire;
  cadence: string;
  cadence_label: string;
  next_date: string | null;
  days_until: number;
  remind_in: number[];
  last_document_code: string | null;
  status: string;
  progress_percent: number;
}

/**
 * Body tạo khoản định kỳ (contracts/admin.ts `recurringUpsertBody`). `partner_id` (bắt buộc) là đối tác
 * chọn từ PartnerPicker; không gửi tên người nhận nhập tay (v1 đã bỏ).
 */
export interface RecurringCreateInput {
  company_id: string;
  title: string;
  purpose: string;
  partner_id: string;
  amount: { amount_minor: string; currency: string };
  source: { fund: 'bank' | 'cash'; account_id: string | null };
  cadence: RecurringCadence;
  day_of_period: number;
  remind_days?: number[];
  effective_from: string;
  effective_to?: string | null;
  auto_create_draft: boolean;
  status: 'active' | 'paused';
}

export function useRecurringRules() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['recurring-rules', scope],
    queryFn: () => apiCall<{ items: RecurringRow[] }>('/admin/recurring', { query: { scope } }),
  });
}

export function useCreateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RecurringCreateInput) => apiData<{ _id: string; preview?: unknown }>('/admin/recurring', { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['recurring-rules'] });
    },
  });
}

/* ================= cảnh báo ================= */

export function useAckAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData<{ ok: boolean }>(`/alerts/${id}/ack`, { method: 'PATCH' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['alerts'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
}

/* ================= hàm thuần dùng chung ================= */

/**
 * Quyền xem / cấu hình / chạy lại quy trình tự động. Khớp server và route guard (`routes.tsx`):
 * - sửa quy tắc: `automation:config` (server kiểm PATCH);
 * - chạy lại lượt lỗi: kế toán trưởng hoặc `automation:config` (server kiểm rerun);
 * - vào màn hình: như route `/quantri/tu-dong` = `automation:config` hoặc `audit:read` (kế toán trưởng có).
 */
export function automationAccess(can: (permission: string) => boolean, role: string | null | undefined) {
  const configure = can('automation:config');
  const rerun = configure || role === 'chief_accountant';
  return { configure, rerun, view: rerun || can('audit:read') };
}

/** Nhãn sự kiện nghiệp vụ (trigger / event_type) để hiển thị thay mã kỹ thuật. */
export const AUTOMATION_EVENT_LABEL: Record<string, string> = {
  'voucher.created': 'Phiếu được tạo',
  'voucher.updated': 'Phiếu được sửa',
  'voucher.submitted': 'Phiếu được gửi duyệt',
  'voucher.approved': 'Phiếu đạt duyệt cuối',
  'voucher.paid': 'Phiếu đã thực thi',
  'voucher.cancelled': 'Phiếu bị huỷ',
  'voucher.rejected': 'Phiếu bị từ chối',
  'loan.settled': 'Khoản vay tất toán',
  'schedule.recurring': 'Đến kỳ khoản chi định kỳ',
};

/** Nhãn từng bước của quy tắc (tên bước lấy từ `domain/automation/rules`). */
export const AUTOMATION_STEP_LABEL: Record<string, string> = {
  create_voucher: 'Tạo phiếu đã duyệt',
  execute_voucher: 'Thực thi phiếu',
  link: 'Liên kết',
  create_loan: 'Tạo khoản vay',
  activate_loan: 'Kích hoạt khoản vay',
  notify: 'Nhắc kế toán trưởng',
  cancel_unpaid: 'Huỷ đối tượng chưa có tiền',
  alert: 'Cảnh báo kế toán trưởng',
};

/** Tham số cấu hình được của từng quy tắc (khớp `domain/automation/params.ts`). */
export interface RuleParamField {
  key: string;
  label: string;
  hint: string;
  kind: 'int' | 'choice';
  min?: number;
  max?: number;
  options?: { value: string; label: string }[];
}

export const RULE_PARAM_FIELDS: Record<string, RuleParamField[]> = {
  R2: [
    { key: 'term_months', label: 'Kỳ hạn khoản vay (tháng)', hint: 'Từ 1 đến 600 tháng. Mặc định 12.', kind: 'int', min: 1, max: 600 },
    {
      key: 'due_offset_months',
      label: 'Hạn thanh toán: ngày giải ngân + (tháng)',
      hint: 'Từ 0 đến 36 tháng. Mặc định 11.',
      kind: 'int',
      min: 0,
      max: 36,
    },
    {
      key: 'r2_create_at',
      label: 'Tạo khoản vay khi',
      hint: 'Lưu phiếu: khoản vay có ngay khi lưu phiếu thu (chờ giải ngân). Duyệt: khi phiếu đạt Đã duyệt.',
      kind: 'choice',
      options: [
        { value: 'save', label: 'Khi lưu phiếu thu' },
        { value: 'approve', label: 'Khi phiếu đạt Đã duyệt' },
      ],
    },
  ],
  R3: [
    { key: 'term_months', label: 'Kỳ hạn khoản vay (tháng)', hint: 'Từ 1 đến 600 tháng. Mặc định 12.', kind: 'int', min: 1, max: 600 },
    {
      key: 'due_offset_months',
      label: 'Hạn thanh toán: ngày giải ngân + (tháng)',
      hint: 'Từ 0 đến 36 tháng. Mặc định 11.',
      kind: 'int',
      min: 0,
      max: 36,
    },
  ],
};

/** Quy tắc có tham số cấu hình được (theo công ty). */
export const configurableRule = (code: string): boolean => (RULE_PARAM_FIELDS[code]?.length ?? 0) > 0;

/** Loại đối tác được chọn cho khoản chi định kỳ: mọi loại (v2 §5.2). */
export const RECURRING_PARTNER_TYPES: PartnerType[] = ['bank', 'customer', 'supplier'];

/** Số ngày quá hạn của một khoản công nợ (dashboard) → chuỗi hiển thị. */
export const overdueLabel = (days: number): string => (days > 0 ? `quá hạn ${days} ngày` : '');

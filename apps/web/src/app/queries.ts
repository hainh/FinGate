/**
 * FinGate web — react-query hooks, một nguồn cho mọi màn (handoff §4).
 *
 * Query key luôn có scope → đổi scope là tự refetch đúng dữ liệu.
 * `refetchInterval 30s` + `keepPreviousData` đã ở defaultOptions (store.tsx).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiCall, apiData, uuid } from './api.ts';
import { useAuth } from './store.tsx';
import type {
  AlertRow,
  BankAccountDetail,
  BankAccountRow,
  DashboardOverview,
  DecisionPack,
  DebtRowWire,
  DocumentDetail,
  ForecastResult,
  ListResult,
  LoanRow,
  MatrixEntry,
  NeedsAttentionGroup,
  Newsletter,
  NotificationRow,
  PersonnelRow,
  QueueRow,
  ReportPresetMeta,
  ReportResult,
  RolloverResult,
  SearchHit,
  TransitionResult,
} from './types.ts';

export function useOverview() {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['overview', scope],
    // Tài khoản quản lý thuần (không có doc:read) không gọi dashboard — tránh 403 vô nghĩa.
    enabled: can('doc:read'),
    queryFn: () => apiData<DashboardOverview>('/dashboard/overview', { query: { scope } }),
  });
}

export function useQueue(params: { limit?: number } = {}, enabled = true) {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['queue', scope, params],
    // Hàng chờ phục vụ cả người duyệt (approval:act) lẫn kế toán thực thi (payment:mark).
    enabled: enabled && (can('approval:act') || can('payment:mark')),
    queryFn: () => apiCall<ListResult<QueueRow>>('/queue', { query: { scope, ...params } }),
  });
}

export interface DocListFilters {
  kind?: string;
  status?: string | string[];
  mine?: 'created' | 'to_approve' | 'approved_by_me';
  q?: string;
  sort?: string;
  overdue_only?: 'true';
  missing_evidence?: 'true';
  page?: number;
  limit?: number;
}

export function useDocuments(filters: DocListFilters, enabled = true) {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['documents', scope, filters],
    enabled: enabled && can('doc:read'),
    queryFn: () => apiCall<ListResult<QueueRow>>('/documents', { query: { scope, ...filters } }),
  });
}

export function useDocument(id: string | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['document', scope, id],
    enabled: !!id,
    queryFn: () => apiData<DocumentDetail>(`/documents/${id}`),
  });
}

/** Gợi ý tên người nhận/khách hàng (distinct payee.name của mọi phiếu trong phạm vi). */
export function usePayeeNames() {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['payee-names', scope],
    enabled: can('doc:read'),
    staleTime: 300_000,
    queryFn: () => apiCall<{ items: string[] }>('/documents/payees').then((r) => r.items ?? []),
  });
}

export function useDecisionPack(id: string | undefined) {
  return useQuery({
    queryKey: ['decision-pack', id],
    enabled: !!id,
    staleTime: 60_000,
    queryFn: () => apiData<DecisionPack>(`/documents/${id}/decision-pack`),
  });
}

export function useProcessed(limit = 50, enabled = true) {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['queue-processed', scope, limit],
    enabled: enabled && can('approval:act'),
    queryFn: () => apiCall<ListResult<QueueRow>>('/queue/processed', { query: { scope, limit } }),
  });
}

export function useNeedsAttention() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['needs-attention', scope],
    queryFn: () => apiData<{ groups: NeedsAttentionGroup[] }>('/needs-attention', { query: { scope } }),
  });
}

/* ---------------- reports ---------------- */

export function useReportPresets() {
  return useQuery({
    queryKey: ['report-presets'],
    staleTime: 600_000,
    queryFn: () => apiData<{ presets: ReportPresetMeta[]; items?: ReportPresetMeta[] }>('/reports'),
  });
}

export function useReport(preset: string | undefined, query?: Record<string, string | undefined>) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['report', scope, preset, query],
    enabled: !!preset,
    queryFn: () => apiData<ReportResult>(`/reports/${preset}`, { query: { scope, ...query } }),
  });
}

/* ---------------- ngân hàng · vay · đảo hạn · nợ · dòng tiền ---------------- */

export function useBankAccounts() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['bank-accounts', scope],
    queryFn: () => apiCall<{ items: BankAccountRow[] }>('/bank-accounts', { query: { scope } }),
  });
}

export function useBankAccount(id: string | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['bank-account', scope, id],
    enabled: !!id,
    queryFn: () => apiData<BankAccountDetail>(`/bank-accounts/${id}`, { query: { scope } }),
  });
}

export function useBalancesHistory(date?: string) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['balances-history', scope, date],
    queryFn: () =>
      apiCall<{ items: Record<string, unknown>[] }>('/bank-accounts/balances/history', { query: { scope, date } }),
  });
}

export function useLoans() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['loans', scope],
    queryFn: () => apiCall<{ items: LoanRow[] }>('/loans', { query: { scope } }),
  });
}

export function useRollovers(bucket?: string) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['rollovers', scope, bucket],
    // shape đã kiểm chứng: { items: MaturityRow[], kpi: {today,d3,d7,d30}, prepared_percent }
    // server lọc theo *cửa sổ* bucket → UI bảng đáo hạn cần *lũy kế* (≤ N ngày), lọc lại client.
    queryFn: () => apiCall<RolloverResult>('/rollovers', { query: { scope } }).then((r) => {
      const cap: Record<string, number> = { today: 0, '3d': 3, '7d': 7, '30d': 30 };
      if (bucket && cap[bucket] !== undefined)
        return { ...r, items: r.items.filter((m) => m.days_to_due <= cap[bucket]) };
      return r;
    }),
  });
}

export function useDebts(kind: 'receivable' | 'payable', extra?: Record<string, string | undefined>) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['debts', scope, kind, extra],
    queryFn: () => apiCall<ListResult<DebtRowWire>>('/debts', { query: { scope, kind, ...extra } }),
  });
}

export function useForecast(horizon: string) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['forecast', scope, horizon],
    queryFn: () => apiData<ForecastResult>('/cashflow/forecast', { query: { scope, horizon } }),
  });
}

export function useNewsletter() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['newsletter', scope],
    queryFn: () => apiData<Newsletter>('/newsletter/daily'),
  });
}

/* ---------------- thông báo · cảnh báo · tìm kiếm ---------------- */

export function useNotifications(unreadOnly?: 'true') {
  return useQuery({
    queryKey: ['notifications', unreadOnly],
    queryFn: () => apiCall<{ items: NotificationRow[] }>('/notifications', { query: { limit: 50, unread_only: unreadOnly } }),
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: ['unread-count'],
    queryFn: () => apiData<{ count: number }>('/notifications/unread-count'),
  });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) => apiData('/notifications/read', { method: 'POST', body: { ...body, request_id: uuid() } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['unread-count'] });
    },
  });
}

export function useAlerts() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['alerts', scope],
    queryFn: () => apiCall<{ items: AlertRow[] }>('/alerts', { query: { scope } }),
  });
}

export function useSearch(q: string) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['search', scope, q],
    enabled: q.trim().length >= 2,
    queryFn: () => apiData<{ query: string; hits: SearchHit[] }>('/search', { query: { q } }),
  });
}

/* ---------------- quản trị ---------------- */

export function useMatrix() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['matrix', scope],
    queryFn: () => apiCall<{ items: MatrixEntry[] }>('/admin/matrix'),
  });
}

export interface MatrixUpsertInput {
  company_id: string | null;
  doc_kind: string;
  amount_min_minor: string;
  amount_max_minor?: string;
  steps: { order: number; role: string; sla_hours: number; mandatory: boolean }[];
  effective_from: string;
}

/** Lưu ma trận duyệt (ADM-04) — server upsert theo (công ty, loại phiếu, ngưỡng dưới) + version++. */
export function useMatrixUpsert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MatrixUpsertInput) =>
      apiData('/admin/matrix', { method: 'POST', body: { currency: 'VND', ...body } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['matrix'] });
    },
  });
}

export function usePersonnel(page = 1) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['personnel', scope, page],
    queryFn: () => apiCall<ListResult<PersonnelRow>>('/personnel', { query: { scope, page, limit: 50 } }),
  });
}

export function useAuditLog(page = 1, q?: string) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['audit-log', scope, page, q],
    queryFn: () => apiCall<ListResult<import('./types.ts').AuditRow>>('/audit-log', { query: { scope, page, limit: 50, q } }),
  });
}

export function useCompanies() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['companies', scope],
    staleTime: 600_000,
    queryFn: () => apiCall<{ items: import('./types.ts').CompanyRow[] }>('/companies'),
  });
}

/* ---------------- sao lưu dữ liệu (ADM-14) ---------------- */

export function useBackups(enabled = true) {
  const { can } = useAuth();
  return useQuery({
    queryKey: ['backups'],
    enabled: enabled && can('admin:backup'),
    queryFn: () => apiData<{ items: import('./types.ts').BackupFile[]; retain_days: number }>('/system/backups'),
  });
}

/** Tạo bản sao lưu ngay; trả metadata để FE mở link tải. */
export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiData<import('./types.ts').BackupFile>('/system/backups', { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['backups'] }),
  });
}

export interface DepartmentRow {
  _id: string;
  company_id: string;
  name: string;
  code?: string | null;
  parent_id?: string | null;
  active?: boolean;
}

export function useDepartments(companyId?: string) {
  return useQuery({
    queryKey: ['departments', companyId ?? 'all'],
    staleTime: 300_000,
    queryFn: () =>
      apiCall<{ items: DepartmentRow[] }>('/departments', companyId ? { query: { company_id: companyId } } : {}),
  });
}

/* ---------------- transition (duyệt / từ chối / submit / pay) ---------------- */

export interface TransitionInput {
  id: string;
  action: string;
  opinion?: string;
  reason?: string;
  verify?: { method: 'password' | 'otp'; value: string };
  confirm_amount_minor?: string;
  /** cấp duyệt đổi số tiền của phiếu chi ngay khi duyệt (tăng thì kèm confirm). */
  amount_minor?: string;
  /** cấp duyệt đổi tài khoản đích/nguồn của phiếu (trong phạm vi công ty). */
  source_account_id?: string;
  execution?: { paid_at: string; bank_ref?: string; actual_amount_minor?: string; account_id?: string };
  if_match: number;
}

export function useTransition() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TransitionInput) => {
      const { id, ...body } = input;
      return apiData<TransitionResult>(`/documents/${id}/transition`, {
        method: 'POST',
        body: { ...body, request_id: uuid() },
      });
    },
    onSuccess: (_r, input) => {
      qc.invalidateQueries({ queryKey: ['document'] });
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['queue'] });
      qc.invalidateQueries({ queryKey: ['overview'] });
      qc.invalidateQueries({ queryKey: ['queue-processed'] });
      qc.invalidateQueries({ queryKey: ['unread-count'] });
      // thực thi (pay) làm đổi số dư — làm tươi ngay tài khoản/dòng tiền, không đợi tải lại
      qc.invalidateQueries({ queryKey: ['bank-accounts'] });
      qc.invalidateQueries({ queryKey: ['bank-account'] });
      qc.invalidateQueries({ queryKey: ['balances-history'] });
      void input;
    },
  });
}

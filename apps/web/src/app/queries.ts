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
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['overview', scope],
    queryFn: () => apiData<DashboardOverview>('/dashboard/overview', { query: { scope } }),
  });
}

export function useQueue(params: { limit?: number } = {}) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['queue', scope, params],
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

export function useDocuments(filters: DocListFilters) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['documents', scope, filters],
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

export function useDecisionPack(id: string | undefined) {
  return useQuery({
    queryKey: ['decision-pack', id],
    enabled: !!id,
    staleTime: 60_000,
    queryFn: () => apiData<DecisionPack>(`/documents/${id}/decision-pack`),
  });
}

export function useProcessed(limit = 50) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['queue-processed', scope, limit],
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
  return useQuery({
    queryKey: ['newsletter'],
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
  return useQuery({
    queryKey: ['search', q],
    enabled: q.trim().length >= 2,
    queryFn: () => apiData<{ query: string; hits: SearchHit[] }>('/search', { query: { q } }),
  });
}

/* ---------------- quản trị ---------------- */

export function useMatrix() {
  return useQuery({
    queryKey: ['matrix'],
    queryFn: () => apiCall<{ items: MatrixEntry[] }>('/admin/matrix'),
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
  return useQuery({
    queryKey: ['companies'],
    staleTime: 600_000,
    queryFn: () => apiCall<{ items: import('./types.ts').CompanyRow[] }>('/companies'),
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
      void input;
    },
  });
}

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
  ApprovalThresholdResult,
  BankAccountDetail,
  BankAccountListResult,
  CashflowHistoryResult,
  DashboardOverview,
  DecisionPack,
  DocumentDetail,
  ListResult,
  MatrixEntry,
  NeedsAttentionGroup,
  Newsletter,
  NotificationRow,
  OwnerAttachment,
  PersonnelRow,
  QueueRow,
  ReportPresetMeta,
  ReportResult,
  RolloverPreparation,
  RolloverResult,
  SearchHit,
  TransitionResult,
} from './types.ts';

/**
 * Tổng quan dashboard. `tagIds` (v2 §6.2): lọc số liệu theo phiếu (dự kiến thu–chi hôm nay, chờ duyệt,
 * thiếu chứng từ); rỗng = không lọc. Đổi bộ lọc giữ dữ liệu cũ trong cùng phạm vi (keepDataWithinScope).
 */
export function useOverview(tagIds: string[] = []) {
  const { scope, can } = useAuth();
  const tagKey = tagIds.join(',');
  return useQuery({
    queryKey: ['overview', scope, tagKey],
    // Tài khoản quản lý thuần (không có doc:read) không gọi dashboard — tránh 403 vô nghĩa.
    enabled: can('doc:read'),
    queryFn: () => apiData<DashboardOverview>('/dashboard/overview', { query: { scope, tag_ids: tagKey || undefined } }),
  });
}

/**
 * Badge thanh điều hướng (shell, mọi màn): số "chờ tôi duyệt" + ngày nghiệp vụ. Key nằm dưới `['overview', …]`
 * nên `invalidateQueries({ queryKey: ['overview'] })` sẵn có vẫn làm tươi badge.
 */
export function useBadges() {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['overview', 'badges', scope],
    enabled: can('doc:read'),
    queryFn: () => apiData<{ business_date: string; counts: { awaiting_me: number } }>('/dashboard/badges', { query: { scope } }),
  });
}

/** Bộ lọc gửi lên hàng chờ "Chờ tôi duyệt" (GET /queue): ô tìm, trạng thái, đối tác, tag (v2 §5.2, §12). */
export interface QueueFilters {
  limit?: number;
  /** trang (đánh số từ 1) — FgPagination. */
  page?: number;
  q?: string;
  status?: string;
  partner_id?: string;
  tag_ids?: string[];
}

export function useQueue(params: QueueFilters = {}, enabled = true) {
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
  /** [v2] lọc theo đối tác (ID) và tag (phiếu có ÍT NHẤT MỘT tag trong danh sách). */
  partner_id?: string;
  tag_ids?: string[];
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

/**
 * Gói quyết định (7 câu hỏi). `sourceAccountId`: TK đang chọn ở cấp duyệt (đổi TK khi duyệt) — server tính q5/q6
 * theo TK này; khoá theo TK để đổi TK là tải lại đúng số liệu, không dùng số của TK cũ.
 */
export function useDecisionPack(id: string | undefined, sourceAccountId?: string) {
  return useQuery({
    queryKey: ['decision-pack', id, sourceAccountId ?? ''],
    enabled: !!id,
    staleTime: 60_000,
    queryFn: () => apiData<DecisionPack>(`/documents/${id}/decision-pack`, { query: { source_account_id: sourceAccountId || undefined } }),
  });
}

/** "Tôi đã duyệt" (APPR-02). `q`: ô tìm (mã, tiêu đề, đối tác, STK/MST, tag) — cùng cách khớp với hàng chờ. */
export function useProcessed(limit = 50, enabled = true, q?: string, page = 1) {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['queue-processed', scope, limit, q ?? '', page],
    enabled: enabled && can('approval:act'),
    queryFn: () => apiCall<ListResult<QueueRow>>('/queue/processed', { query: { scope, limit, page, q: q || undefined } }),
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

/**
 * Danh sách tài khoản tiền. `companyId` (công ty của phiếu) → server trả ĐÚNG tài
 * khoản của công ty đó — picker tạo/duyệt phiếu dùng để công ty con không chạm
 * quỹ Tập đoàn (§VIII). Bỏ trống → theo phạm vi (màn Ngân hàng).
 */
export function useBankAccounts(companyId?: string | null) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['bank-accounts', scope, companyId ?? null],
    queryFn: () =>
      apiCall<BankAccountListResult>('/bank-accounts', {
        query: companyId ? { scope, for_company: companyId } : { scope },
      }),
  });
}

/** BANK-01 — một trang tài khoản tiền: phân trang và lọc loại TK ở máy chủ (`totals` vẫn trên mọi tài khoản). */
export function useBankAccountsPage(filters: { page: number; limit: number; kind?: 'bank' | 'cash' }) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['bank-accounts', 'page', scope, filters],
    queryFn: () => apiCall<BankAccountListResult>('/bank-accounts', { query: { scope, ...filters } }),
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

/** BANK-05 — lịch sử giao dịch của một tài khoản tiền. `range` (YYYY-MM-DD, tuỳ chọn) — bỏ trống = toàn bộ thời gian. */
export function useBankAccountTransactions(id: string | undefined, range: { from?: string; to?: string } = {}) {
  const { scope } = useAuth();
  const { from, to } = range;
  return useQuery({
    queryKey: ['bank-account-transactions', scope, id, from ?? '', to ?? ''],
    enabled: !!id,
    queryFn: () =>
      apiData<import('./types.ts').BankAccountTransactions>(`/bank-accounts/${id}/transactions`, {
        query: { scope, ...(from ? { from } : {}), ...(to ? { to } : {}) },
      }),
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

/** RENEW-05 — tiền cần chuẩn bị cho 30 ngày tới. */
export function useRolloverPreparation() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['rollover-preparation', scope],
    queryFn: () => apiData<RolloverPreparation>('/rollovers/preparation', { query: { scope } }),
  });
}

/** RENEW-04 — cập nhật kết quả thực hiện đảo hạn. */
export function useRolloverResult(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => apiData(`/documents/${id}/rollover-result`, { method: 'POST', body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document'] });
      qc.invalidateQueries({ queryKey: ['rollovers'] });
      qc.invalidateQueries({ queryKey: ['bank-debt'] });
    },
  });
}

export type { OwnerAttachment };

export function useCashflowHistory(period: string, group: string) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['cashflow-history', scope, period, group],
    queryFn: () => apiData<CashflowHistoryResult>('/cashflow/history', { query: { scope, period, group } }),
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

/** Ngưỡng Chairman (ADM-04) — mặc định toàn tập đoàn + override theo công ty, tách theo loại hồ sơ. */
export function useApprovalThreshold() {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['approval-threshold', scope],
    queryFn: () => apiData<ApprovalThresholdResult>('/admin/approval-threshold'),
  });
}

export interface ApprovalThresholdUpsertInput {
  company_id: string | null;
  amount_minor: string | null;
  by_kind: { spend?: string | null; income?: string | null; rollover?: string | null; internal?: string | null };
}

export function useApprovalThresholdUpsert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ApprovalThresholdUpsertInput) => apiData('/admin/approval-threshold', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approval-threshold'] }),
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

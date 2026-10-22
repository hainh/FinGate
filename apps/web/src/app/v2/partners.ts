/**
 * FinGate web — v2 Đối tác (v2/v2.md §5): kiểu trên WIRE + react-query hooks.
 *
 * Nguồn hợp đồng: `packages/shared/src/contracts/partners.ts` (tạo / sửa / sao chép / ô chọn) và
 * `apps/api/src/routes/partners.ts` + `domain/partner/*` (danh sách có tóm tắt, tab, trả nợ).
 * Kiểu ở đây khớp đúng response của backend; tiền là `MoneyWire` (minor = chuỗi).
 *
 * Endpoint:
 *   GET    /partners/options              ô chọn đối tác → { items: PartnerRef[] }
 *   GET    /partners                      danh sách màn Đối tác → { items, total, limit, offset, period }
 *   GET    /partners/:id                  chi tiết + lịch sử (tóm tắt theo tháng hiện tại phía server)
 *   POST   /partners                      tạo → { partner, warnings }
 *   PATCH  /partners/:id                  sửa → { partner, warnings }
 *   POST   /partners/:id/deactivate|reactivate   ngừng / kích hoạt lại → { partner, warnings }
 *   DELETE /partners/:id                  xoá (chỉ khi chưa phát sinh)
 *   POST   /partners/check-duplicates     kiểm trùng trước khi lưu (chỉ đọc) → { warnings }
 *   POST   /partners/copy                 sao chép từ công ty khác → { created, warnings }
 *   POST   /partners/:id/settle           trả nợ → { partner_id, replayed, vouchers[] } (phiếu NHÁP)
 *   GET    /partners/:id/documents        tab Phiếu thu/chi → { items, total }
 *   GET    /partners/:id/debts            tab Công nợ (KH/NCC) → { items, total }
 *   GET    /partners/:id/loans            tab Nợ ngân hàng (NH) → { items, total }
 *
 * Mọi queryKey có `scope` → đổi công ty là tự refetch. Lỗi đi qua apiCall → ApiRequestError.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { DebtDirection, PartnerDuplicateCheckBody, PartnerDuplicateWarning, PartnerHistoryEntry, PartnerRef, PartnerStatus, PartnerType } from '@fingate/shared';
import { apiCall, apiData } from '../api.ts';
import { useAuth } from '../store.tsx';
import type { MoneyWire } from '../types.ts';

/* ================= kiểu trên wire ================= */

/** Dòng danh sách màn Đối tác: KH/NCC dùng còn phải thu/trả/quá hạn; NH dùng dư nợ/đáo hạn. */
export interface PartnerListRow extends PartnerRef {
  company_id: string;
  company_name: string | null;
  note: string | null;
  receivable_remaining: MoneyWire | null;
  payable_remaining: MoneyWire | null;
  overdue_amount: MoneyWire | null;
  outstanding: MoneyWire | null;
  next_maturity_date: string | null;
  /** Tổng thu / tổng chi ĐÃ THỰC THI trong kỳ (`period_from`–`period_to`). */
  paid_in_period: MoneyWire | null;
  paid_out_period: MoneyWire | null;
  /** Đã phát sinh (phiếu / công nợ / nợ NH) → không xoá được, chỉ ngừng giao dịch. */
  has_activity: boolean;
  updated_at: string;
}

export interface PartnerListResult {
  items: PartnerListRow[];
  total: number;
  limit: number;
  offset: number;
}

/** GET /partners/:id — tóm tắt (tháng hiện tại) + lịch sử thay đổi. */
export interface PartnerDetailData extends PartnerListRow {
  history: PartnerHistoryEntry[];
}

/** Body ghi đối tác. Tạo: `type` + `name` bắt buộc. Sửa: PATCH từng phần (gồm `status`). */
export interface PartnerWriteBody {
  type?: PartnerType;
  name?: string;
  bank_name?: string | null;
  account_number?: string | null;
  tax_code?: string | null;
  note?: string | null;
  status?: PartnerStatus;
  company_id?: string;
  /** Chống ghi đúp khi TẠO: một lần mở popup dùng MỘT request_id (bấm lặp / thử lại trả lại đối tác đã tạo). */
  request_id?: string;
}

/** Kết quả tạo / sửa / ngừng: đối tác + cảnh báo trùng (không chặn lưu). */
export interface PartnerSaveResult {
  partner: PartnerRef;
  warnings: PartnerDuplicateWarning[];
}

export interface PartnerCopyInput {
  source_company_id: string;
  partner_ids: string[];
  target_company_id?: string;
  /** Chống ghi đúp: một lần mở hộp thoại dùng MỘT request_id. */
  request_id?: string;
}

export interface PartnerCopyResult {
  created: { source_id: string; partner_id: string; code: string; name: string }[];
  warnings: PartnerDuplicateWarning[];
}

/** Trả khoản công nợ (KH/NCC): phân bổ `amount_minor` → phiếu thu (phải thu) hoặc phiếu chi (phải trả). */
export interface PartnerSettleDebtItem {
  debt_voucher_id: string;
  amount_minor: string;
}

/** Trả khoản vay NH: `split` gốc / lãi / phí, tổng phải bằng `amount_minor` → phiếu chi trả nợ vay. */
export interface PartnerSettleLoanItem {
  bank_debt_id: string;
  amount_minor: string;
  split?: { principal: string; interest: string; fee: string } | null;
}

export interface PartnerSettleBody {
  items: PartnerSettleDebtItem[];
  loans: PartnerSettleLoanItem[];
  note?: string | null;
  /** Chống bấm đúp: MỘT request_id cho mỗi lần mở hộp thoại Trả nợ (gửi lại sau lỗi dùng cùng mã). */
  request_id?: string;
}

/** Phiếu NHÁP vừa tạo khi trả nợ (mở phiếu đầu tiên; các phiếu còn lại báo ở thông báo). */
export interface PartnerSettleResult {
  partner_id: string;
  replayed: boolean;
  vouchers: {
    document_id: string;
    code: string;
    kind: 'income' | 'spend';
    status: string;
    amount_minor: string;
    title: string;
  }[];
}

/** Tab Phiếu thu/chi (GET /partners/:id/documents). */
export interface PartnerVoucherRow {
  _id: string;
  code: string;
  kind: 'spend' | 'income';
  status: string;
  title: string;
  business_date: string | null;
  planned_date: string | null;
  amount: MoneyWire;
  paid_at: string | null;
  tag_ids: string[];
}

/** Tab Công nợ (GET /partners/:id/debts). `applied` = đã cấn trừ; `overdue_days` = số ngày quá hạn. */
export interface PartnerDebtRow {
  _id: string;
  code: string;
  company_id: string;
  direction: DebtDirection;
  account_code: string | null;
  side: string | null;
  contract_code: string | null;
  priority: string | null;
  value: MoneyWire | null;
  applied: MoneyWire | null;
  remaining: MoneyWire | null;
  /** Còn CÓ THỂ TRẢ = giá trị − phần đã giữ chỗ bởi phiếu chưa huỷ (giới hạn của "Trả nợ"). */
  available: MoneyWire | null;
  due_date: string;
  overdue_days: number;
  status: 'open' | 'partial' | 'settled';
}

/** Tab Nợ ngân hàng (GET /partners/:id/loans). */
export interface PartnerLoanRow {
  _id: string;
  code: string;
  company_id: string;
  status: string;
  principal: MoneyWire | null;
  repaid_principal: MoneyWire | null;
  outstanding: MoneyWire | null;
  /** Gốc còn CÓ THỂ TRẢ (giới hạn "Trả nợ"; 0 nếu khoản không ở trạng thái đang vay / quá hạn). */
  available_principal: MoneyWire | null;
  maturity_date: string;
  days_to_maturity: number;
  maturity_tone: string;
  disbursed_at: string | null;
}

export interface PartnerOptionsParams {
  type?: PartnerType[];
  company_id?: string;
  q?: string;
  status?: PartnerStatus;
  limit?: number;
}

export interface PartnerListFilters {
  type?: PartnerType[];
  /** Bỏ trống = tất cả trạng thái (server mặc định `all`). */
  status?: PartnerStatus;
  q?: string;
  /** Kỳ tổng hợp thu/chi: ngày đầu / cuối kỳ (YYYY-MM-DD). */
  period_from?: string;
  period_to?: string;
  limit?: number;
  offset?: number;
}

/** Chiều của khoản công nợ: v2 `direction`, fallback từ v1 `side` (debit = phải thu). */
export function debtDirectionOf(row: { direction?: DebtDirection | null; side?: string | null }): DebtDirection {
  if (row.direction) return row.direction;
  return row.side === 'credit' ? 'payable' : 'receivable';
}

/**
 * Danh sách gợi ý của ô chọn đối tác đang trống vì: đang tải / LỖI tải / thật sự không có đối tác khớp.
 * Lỗi tải không được báo như "không có đối tác" (người dùng dễ tưởng chưa có đối tác rồi tạo trùng).
 */
export function partnerOptionsEmptyState(q: { isFetching: boolean; isError: boolean }): 'loading' | 'error' | 'none' {
  if (q.isFetching) return 'loading';
  if (q.isError) return 'error';
  return 'none';
}

/* ================= hooks ================= */

/** Ô chọn đối tác (PartnerPicker). Mặc định chỉ đối tác "Hoạt động". */
export function usePartnerOptions(params: PartnerOptionsParams, enabled = true) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['partner-options', scope, params],
    enabled,
    staleTime: 30_000,
    // Không giữ kết quả của chữ CŨ khi chữ mới đang tải (placeholder mặc định của app): danh sách phải trống
    // ("Đang tìm…") chứ không liệt kê đối tác không khớp chữ đang gõ (v2/v2.md §5.2). Cùng cách với tags.ts.
    placeholderData: undefined,
    queryFn: () => apiCall<{ items: PartnerRef[] }>('/partners/options', { query: { scope, ...params } }),
  });
}

/** Mỗi yêu cầu tra tối đa 100 mã (URL ngắn). */
const CODE_LOOKUP_CHUNK = 100;

/**
 * Kiểm mã ngân hàng đang hoạt động của một lô nhập (LOAN-05): tra ĐÚNG các mã được hỏi trên máy chủ.
 * Không dựa vào danh sách ngân hàng tải về (bị trần số dòng) — công ty có nhiều ngân hàng thì mã hợp lệ
 * ngoài danh sách đầu vẫn được nhận diện. Chỉ gọi khi có mã (`enabled`).
 */
export function useActiveBankCodes(codes: string[], companyId: string | null | undefined, enabled = true) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['partner-codes', scope, companyId ?? '', codes.join(',')],
    enabled: enabled && codes.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const requests: string[][] = [];
      for (let i = 0; i < codes.length; i += CODE_LOOKUP_CHUNK) requests.push(codes.slice(i, i + CODE_LOOKUP_CHUNK));
      const parts = await Promise.all(
        requests.map((chunk) =>
          apiCall<{ items: PartnerRef[] }>('/partners/options', {
            query: { scope, type: ['bank'], status: 'active', company_id: companyId ?? undefined, codes: chunk.join(',') },
          }),
        ),
      );
      return parts.flatMap((p) => p.items);
    },
  });
}

/** Một đối tác (tóm tắt + lịch sử). Dùng cho phần chỉ đọc dưới ô chọn và màn chi tiết. */
export function usePartner(id: string | null | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['partner', scope, id ?? ''],
    enabled: !!id,
    // Chi tiết của đối tác TRƯỚC không được thay cho đối tác mới khi đang tải (xem detailForValue ở ô chọn).
    placeholderData: undefined,
    queryFn: () => apiData<PartnerDetailData>(`/partners/${id}`, { query: { scope } }),
  });
}

/** Danh sách màn Đối tác (có tóm tắt theo kỳ, phân trang). */
export function usePartnerList(filters: PartnerListFilters) {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['partners', scope, filters],
    enabled: can('partner:read'),
    queryFn: () => apiCall<PartnerListResult>('/partners', { query: { scope, ...filters } }),
  });
}

export interface PartnerCopySourceFilters {
  /** tìm theo tên / STK / MST trong công ty nguồn */
  q?: string;
  offset?: number;
  limit?: number;
}

/**
 * Trang danh bạ MỘT công ty khác để sao chép (đang hoạt động; tìm + phân trang — server cho phép tới 200/trang).
 * Header scope = công ty nguồn + `company_id` để server kiểm quyền xem công ty đó (không có quyền → lỗi, hiển thị ở hộp thoại).
 */
export function usePartnerCopySource(companyId: string | null | undefined, filters: PartnerCopySourceFilters = {}) {
  const q = filters.q?.trim() || undefined;
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  return useQuery({
    queryKey: ['partners-copy-source', companyId ?? '', q ?? '', offset, limit],
    enabled: !!companyId,
    queryFn: () =>
      apiCall<PartnerListResult>('/partners', {
        scope: companyId ?? undefined,
        query: { company_id: companyId ?? undefined, status: 'active', q, offset, limit },
      }),
  });
}

/**
 * Kiểm trùng TRƯỚC khi lưu (popup đối tác gọi khi đang gõ; phía gọi debounce). Chỉ đọc — không chặn lưu.
 * `body` = null ⇒ không gọi.
 */
export function usePartnerDuplicateCheck(body: PartnerDuplicateCheckBody | null) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['partner-dup-check', scope, body],
    enabled: !!body,
    retry: false,
    staleTime: 0,
    // Cảnh báo của nội dung CŨ không được giữ khi đang kiểm nội dung mới (popup phải phản ánh tên hiện tại).
    placeholderData: undefined,
    queryFn: () => apiData<{ warnings: PartnerDuplicateWarning[] }>('/partners/check-duplicates', { method: 'POST', body: { ...body } }),
  });
}

/** Tab Phiếu thu/chi của đối tác. */
export function usePartnerVouchers(partnerId: string | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['partner-vouchers', scope, partnerId ?? ''],
    enabled: !!partnerId,
    // đổi đối tác: không hiện phiếu của đối tác trước trong lúc tải
    placeholderData: undefined,
    queryFn: () => apiCall<{ items: PartnerVoucherRow[]; total: number }>(`/partners/${partnerId}/documents`, { query: { scope, limit: 100 } }),
  });
}

/** Tab Công nợ của đối tác (KH/NCC) — cũng là nguồn các khoản còn dư cho "Trả nợ". */
export function usePartnerDebts(partnerId: string | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['partner-debts', scope, partnerId ?? ''],
    enabled: !!partnerId,
    // đổi đối tác: không hiện công nợ của đối tác trước trong lúc tải (hộp thoại "Trả nợ" dựa trên danh sách này)
    placeholderData: undefined,
    queryFn: () => apiCall<{ items: PartnerDebtRow[]; total: number }>(`/partners/${partnerId}/debts`, { query: { scope } }),
  });
}

/** Tab Nợ ngân hàng của đối tác (NH) — cũng là nguồn các khoản vay còn dư cho "Trả nợ". */
export function usePartnerLoans(partnerId: string | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['partner-loans', scope, partnerId ?? ''],
    enabled: !!partnerId,
    // đổi đối tác: không hiện khoản vay của đối tác trước trong lúc tải (hộp thoại "Trả nợ" dựa trên danh sách này)
    placeholderData: undefined,
    queryFn: () => apiCall<{ items: PartnerLoanRow[]; total: number }>(`/partners/${partnerId}/loans`, { query: { scope } }),
  });
}

/** Làm mới mọi dữ liệu đối tác sau khi ghi (danh sách, chi tiết, ô chọn, bản sao). */
function invalidatePartnerQueries(qc: QueryClient): void {
  for (const key of ['partners', 'partner', 'partner-options', 'partners-copy-source', 'partner-vouchers', 'partner-debts', 'partner-loans']) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

export function useCreatePartner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PartnerWriteBody) => apiData<PartnerSaveResult>('/partners', { method: 'POST', body }),
    onSuccess: () => invalidatePartnerQueries(qc),
  });
}

export function useUpdatePartner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PartnerWriteBody }) =>
      apiData<PartnerSaveResult>(`/partners/${id}`, { method: 'PATCH', body }),
    onSuccess: () => invalidatePartnerQueries(qc),
  });
}

/** Ngừng giao dịch (`inactive`) hoặc kích hoạt lại (`active`) — không xoá, giữ lịch sử phiếu. */
export function useSetPartnerStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: PartnerStatus }) =>
      apiData<PartnerSaveResult>(`/partners/${id}/${status === 'active' ? 'reactivate' : 'deactivate'}`, { method: 'POST' }),
    onSuccess: () => invalidatePartnerQueries(qc),
  });
}

export function useDeletePartner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData<{ ok: boolean }>(`/partners/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidatePartnerQueries(qc),
  });
}

export function useCopyPartners() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PartnerCopyInput) => apiData<PartnerCopyResult>('/partners/copy', { method: 'POST', body }),
    onSuccess: () => invalidatePartnerQueries(qc),
  });
}

/** Trả nợ: tạo phiếu nháp đã gắn liên kết. Làm mới cả phiếu, công nợ, nợ NH, tổng quan. */
export function useSettlePartner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ partnerId, body }: { partnerId: string; body: PartnerSettleBody }) =>
      apiData<PartnerSettleResult>(`/partners/${partnerId}/settle`, { method: 'POST', body }),
    onSuccess: () => {
      invalidatePartnerQueries(qc);
      for (const key of ['documents', 'document', 'queue', 'overview', 'debt-vouchers', 'debt-voucher', 'bank-debts', 'bank-debt']) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

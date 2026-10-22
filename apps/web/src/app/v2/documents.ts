/**
 * FinGate web — Phiếu thu/chi v2 (v2/v2.md §5.2, §6.1, §7.2, §11.4–11.6, US-AUTO-01..05): kiểu trên WIRE,
 * hook react-query và hàm thuần dùng chung cho form phiếu, hồ sơ chi tiết, modal duyệt và danh sách.
 *
 * Nguồn hợp đồng đã đối chiếu với server:
 *   - Phiếu: `packages/shared/src/contracts/documents.ts` · `apps/api/src/routes/documents.ts` (`detailOf`) ·
 *     `domain/vouchers/refs.ts` (`buildVoucherRefView`: partner, tags, options.loan, transfer_target, origin, links).
 *   - Gắn tag: PATCH `/documents/:id/tags` (`documentTagsBody`, cần `doc:create` hoặc `tag:create`).
 *   - Liên kết: POST `/documents/:id/links` (`documentLinkCreateBody`), DELETE `/documents/:id/links/:linkId` (`{reason}`).
 *   - Tự động: GET `/automation/runs/by-source` (RunView có `generated[]`, `steps[].output`), POST `/automation/runs/:id/rerun`.
 *
 * Tiền trên wire là chuỗi minor units; mọi hiển thị đi qua `money()`/`formatMoney()` của shared.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { bankDebtStatusLabel, ddmmyyyy, formatMoney, money, moneyFromWire, statusLabel, type PartnerRef } from '@fingate/shared';
import { apiData } from '../api.ts';
import { useAuth } from '../store.tsx';
import type { BankAccountRow, DocumentDetail } from '../types.ts';
import { interestRateText, type LoanRow } from './debts.ts';

/* ================= kiểu trên wire ================= */

/** Tag đã gắn trên phiếu (`documentDetail.tags`, `documentRow.tags`). */
export interface DocTagRef {
  _id: string;
  name: string;
  color: string;
}

/** Điều khoản khoản vay dự kiến trên phiếu (`options.loan.terms`). */
export interface LoanTermsWire {
  contract_no: string | null;
  interest_rate: string | null;
  term_months: number | null;
  due_date: string | null;
  repayment_period: string | null;
  repayment_method: string | null;
  collateral: string | null;
}

/** `options.loan` khi đọc phiếu: đã nạp ngân hàng, TK nhận, khoản vay có sẵn; `effective_amount_minor` = gốc hiệu lực. */
export interface DocLoanView {
  kind: 'borrow' | 'fund';
  mode: 'new' | 'existing' | 'later';
  lender_partner_id: string | null;
  lender: PartnerRef | null;
  receive_account_id: string | null;
  receive_account_label: string | null;
  /** null = gốc bằng số tiền phiếu (đi theo số tiền đã chốt khi duyệt). */
  amount_minor: string | null;
  effective_amount_minor: string;
  existing_loan_id: string | null;
  existing_loan: { _id: string; code: string; status: string } | null;
  terms: LoanTermsWire | null;
}

/** Chuyển tiền nội bộ theo ID (`transfer_target`, đã nạp tên công ty và TK). */
export interface DocTransferView {
  company_id: string;
  company_name: string | null;
  company_code: string | null;
  account_id: string | null;
  account_label: string | null;
}

export interface DocOrigin {
  kind: 'manual' | 'automation';
  run_id: string | null;
  rule_code: string | null;
}

export type LinkRelation = 'offset' | 'repayment' | 'disbursement' | 'funded_by' | 'generated' | 'internal_transfer';
export type LinkObjectType = 'document' | 'debt_voucher' | 'bank_debt';
/** Quan hệ gán thủ công từ phiếu (`documentLinkCreateBody`). */
export type ManualLinkRelation = 'offset' | 'repayment' | 'disbursement';

/** Đối tượng bên kia của liên kết. `visible: false` = ngoài phạm vi công ty người xem (không lộ mã / số tiền). */
export interface DocLinkCounterpart {
  type: LinkObjectType;
  id: string;
  code: string | null;
  status: string | null;
  total_minor: string | null;
  partner_id: string | null;
  partner_name: string | null;
  visible: boolean;
}

export interface DocLink {
  _id: string;
  company_id: string;
  from_type: LinkObjectType;
  from_id: string;
  from_code: string | null;
  to_type: LinkObjectType;
  to_id: string;
  to_code: string | null;
  relation: LinkRelation;
  amount_minor: string | null;
  split: { principal: string; interest: string; fee: string } | null;
  origin: 'manual' | 'automation';
  run_id: string | null;
  rule_code: string | null;
  status: 'active' | 'removed';
  note: string | null;
  created_by: string | null;
  created_at: string | null;
  removed_by: string | null;
  removed_at: string | null;
  removed_reason: string | null;
  /** `out` = phiếu này là đầu nguồn; `in` = phiếu này là đầu đích. */
  direction: 'out' | 'in';
  counterpart: DocLinkCounterpart;
}

/** Đối tượng do một bước sinh ra (phiếu hoặc khoản vay), kèm mã và trạng thái hiện tại. */
export interface DocGeneratedObject {
  type: 'document' | 'bank_debt';
  id: string;
  code: string | null;
  status: string | null;
  /** phiếu: spend | income | rollover | internal; khoản vay: null. */
  kind: string | null;
  href: string | null;
}

export interface AutomationRunStepView {
  name: string;
  status: 'pending' | 'done' | 'failed' | 'skipped' | string;
  output_type: string | null;
  output_id: string | null;
  error: string | null;
  at: string | null;
  output?: DocGeneratedObject | null;
}

/** Một lượt quy trình tự động. Từ `documentDetail.automation_runs` (không có `generated`) hoặc từ `/automation/runs/by-source`. */
export interface AutomationRunView {
  _id: string;
  rule_code: string;
  rule_name?: string;
  company_id: string | null;
  source_type: string;
  source_id: string;
  event_type: string;
  idem_key: string;
  status: 'pending' | 'running' | 'done' | 'failed' | string;
  error: string | null;
  attempts: number;
  created_at: string | null;
  updated_at: string | null;
  steps: AutomationRunStepView[];
  generated?: DocGeneratedObject[];
}

/* ================= hằng số nghiệp vụ ================= */

/** Kỳ hạn mặc định của khoản vay (§11.4, §11.5). */
export const LOAN_DEFAULT_TERM_MONTHS = 12;
/** Hạn thanh toán mặc định = ngày giải ngân + 11 tháng (như v1, sửa được). */
export const LOAN_DUE_OFFSET_MONTHS = 11;
/** Trạng thái khoản vay còn nhận được giải ngân / gắn phiếu thu đi vay (§11.4 (b)). */
export const LOAN_OPEN_STATUSES: readonly string[] = ['pending_disbursement', 'active'];

/* ================= hàm thuần (không gọi mạng) ================= */

/**
 * Hạn thanh toán mặc định (YYYY-MM-DD) từ ngày gốc; '' khi chưa có ngày. `offsetMonths` là tham số của công ty
 * (lấy từ `useLoanDefaults`); thiếu thì dùng hằng số mặc định của chính sách.
 */
export function defaultLoanDueDate(base: string | null | undefined, offsetMonths: number = LOAN_DUE_OFFSET_MONTHS): string {
  const day = (base ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const d = dayjs(day);
  return d.isValid() ? d.add(offsetMonths, 'month').format('YYYY-MM-DD') : '';
}

/**
 * Lãi suất gửi lên dạng hiển thị VN "9,5" (phân cách thập phân là dấu phẩy — docs/02_design_system.md), cùng quy ước
 * với nhập theo lô và kết quả đảo hạn (`interestRateText`). Gõ "9.5" cũng gửi "9,5". Rỗng ⇒ null. Không phải số thập
 * phân thuần (VD "9%", "1e3") ⇒ giữ nguyên để server báo lỗi đúng ô, không âm thầm đổi thành số khác.
 */
export function normalizeInterestRate(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  return /^\d+([.,]\d+)?$/.test(t) ? interestRateText(t) : t;
}

/** Quan hệ gán thủ công hợp lệ theo loại phiếu và loại đối tác (đối chiếu `RELATION_SPECS` của server). */
export function manualLinkRelationsFor(kind: string, partnerType: string | null | undefined): ManualLinkRelation[] {
  if (kind !== 'spend' && kind !== 'income') return [];
  if (partnerType === 'bank') return kind === 'spend' ? ['repayment'] : ['disbursement'];
  if (partnerType === 'customer' || partnerType === 'supplier') return ['offset'];
  return [];
}

/**
 * Hướng khoản công nợ mà phiếu được cấn trừ (§5.2): phiếu thu ↔ khoản phải thu, phiếu chi ↔ khoản phải trả.
 * Chỉ dùng để lọc gợi ý; server không chặn khác hướng.
 */
export function debtDirectionForVoucher(kind: string): 'receivable' | 'payable' | null {
  if (kind === 'income') return 'receivable';
  if (kind === 'spend') return 'payable';
  return null;
}

/** Tổng số tiền đã phân bổ từ phiếu (liên kết hiệu lực đi ra). Khớp `allocated_minor` của server. */
export function allocatedMinorOf(links: readonly DocLink[] | null | undefined): bigint {
  let total = 0n;
  for (const l of links ?? []) {
    if (l.status === 'active' && l.direction === 'out' && l.amount_minor) total += BigInt(l.amount_minor);
  }
  return total;
}

/** Đã có lượt R3 (vay để chi) ⇒ server khoá sửa số tiền ở cấp duyệt (§11.5, FG-WF-005). */
export function hasAutoLoanRun(runs: readonly { rule_code?: string | null }[] | null | undefined): boolean {
  return (runs ?? []).some((r) => r.rule_code === 'R3');
}

/** Nhãn một đối tượng sinh ra: "NHD-2026-0007 (chờ giải ngân)". */
export function generatedObjectText(g: { type: string; code: string | null; status: string | null }): string {
  const code = g.code ?? '—';
  if (!g.status) return code;
  const label = g.type === 'bank_debt' ? bankDebtStatusLabel(g.status) : statusLabel(g.status);
  return `${code} (${label.toLowerCase()})`;
}

/* ================= form → body (khớp `documentFields` / `loanOptions` / `loanTerms`) ================= */

export interface LoanTermsValues {
  contractNo: string;
  interestRate: string;
  termMonths: number | null;
  /** '' = để server đặt mặc định (ngày gốc + 11 tháng). */
  dueDate: string;
  repaymentPeriod: string;
  repaymentMethod: string;
  collateral: string;
}

export interface LoanFormValues {
  kind: 'borrow' | 'fund';
  mode: 'new' | 'existing' | 'later';
  lenderPartnerId: string | null;
  receiveAccountId: string | null;
  /** null = bằng số tiền phiếu. */
  amountMinor: string | null;
  existingLoanId: string | null;
  terms: LoanTermsValues;
}

export interface LoanTermsBody {
  contract_no: string | null;
  interest_rate: string | null;
  term_months: number | null;
  due_date: string | null;
  repayment_period: string | null;
  repayment_method: string | null;
  collateral: string | null;
}

export interface LoanOptionsBody {
  kind: 'borrow' | 'fund';
  mode: 'new' | 'existing' | 'later';
  lender_partner_id: string | null;
  receive_account_id: string | null;
  amount_minor: string | null;
  existing_loan_id: string | null;
  terms: LoanTermsBody | null;
}

const orNull = (s: string): string | null => {
  const t = s.trim();
  return t ? t : null;
};

/** Điều khoản → body; mọi ô trống thì null (cả khối null). */
export function loanTermsBody(t: LoanTermsValues): LoanTermsBody | null {
  const body: LoanTermsBody = {
    contract_no: orNull(t.contractNo),
    interest_rate: normalizeInterestRate(t.interestRate),
    term_months: t.termMonths,
    due_date: orNull(t.dueDate),
    repayment_period: orNull(t.repaymentPeriod),
    repayment_method: orNull(t.repaymentMethod),
    collateral: orNull(t.collateral),
  };
  return Object.values(body).every((v) => v === null) ? null : body;
}

/**
 * `options.loan` của phiếu. Phiếu thu đi vay (borrow): gốc = số tiền phiếu (không gửi số tiền);
 * mode `new` gửi điều khoản, `existing` gửi khoản có sẵn, `later` không gửi gì thêm.
 * Vay để chi (fund): luôn tạo khoản mới, cần ngân hàng + TK nhận giải ngân.
 */
export function loanOptionsBody(v: LoanFormValues | null): LoanOptionsBody | null {
  if (!v) return null;
  if (v.kind === 'borrow') {
    return {
      kind: 'borrow',
      mode: v.mode,
      lender_partner_id: v.lenderPartnerId,
      receive_account_id: null,
      amount_minor: null,
      existing_loan_id: v.mode === 'existing' ? v.existingLoanId : null,
      terms: v.mode === 'new' ? loanTermsBody(v.terms) : null,
    };
  }
  return {
    kind: 'fund',
    mode: 'new',
    lender_partner_id: v.lenderPartnerId,
    receive_account_id: v.receiveAccountId,
    amount_minor: v.amountMinor,
    existing_loan_id: null,
    terms: loanTermsBody(v.terms),
  };
}

/** `transfer_target` (chuyển nội bộ theo ID): cần công ty và (khuyến nghị) TK; không bật ⇒ null. */
export function transferTargetBody(on: boolean, companyId: string, accountId: string): { company_id: string; account_id: string | null } | null {
  if (!on || !companyId) return null;
  return { company_id: companyId, account_id: accountId || null };
}

/**
 * Nhãn một tài khoản trong ô chọn (tài khoản nguồn/đích, nhận giải ngân, TK đích chuyển nội bộ):
 * "Ngân hàng · số TK che · TÊN TK". Tên TK phải có trong nhãn để phân biệt các TK cùng ngân hàng (v2 §11.5, US-AUTO-03).
 * `withCompany`: thêm đầu nhãn tên công ty (hoặc "Tập đoàn") khi ô gộp TK của nhiều công ty.
 */
export function bankAccountOptionLabel(
  a: Pick<BankAccountRow, 'bank_name' | 'account_number_masked' | 'account_name' | 'is_group' | 'company_name'>,
  withCompany = false,
): string {
  const bank = `${a.bank_name} · ${a.account_number_masked}${a.account_name ? ` · ${a.account_name}` : ''}`;
  return withCompany ? `${a.is_group ? 'Tập đoàn' : (a.company_name ?? '—')} · ${bank}` : bank;
}

/**
 * Nhãn khoản vay trong ô "Khoản vay đang đảo hạn" (phương án đảo hạn): "mã · gốc (gọn) · đáo hạn DD/MM/YYYY".
 * Ngày hiển thị DD/MM/YYYY như các màn khác (docs/02_design_system.md §4.3), không để chuỗi ISO yyyy-mm-dd.
 */
export function rolloverLoanOptionLabel(l: Pick<LoanRow, 'code' | 'principal' | 'maturity_date'>): string {
  const due = l.maturity_date ? ddmmyyyy(l.maturity_date) : '—';
  return `${l.code} · gốc ${formatMoney(moneyFromWire(l.principal) ?? money('0'), { mode: 'compact' })} · đáo hạn ${due}`;
}

/* ================= hook (react-query) ================= */

/** Tham số vay mặc định của công ty (server: `GET /automation/loan-defaults`, US-AUTO-07). */
export interface LoanDefaults {
  company_id: string;
  /** phiếu thu đi vay (R2). */
  borrow: { term_months: number; due_offset_months: number };
  /** phiếu chi vay để chi (R3). */
  fund: { term_months: number; due_offset_months: number };
}

/** Tham số vay mặc định của công ty đang lập phiếu. Không có quyền / chưa chọn công ty ⇒ không có dữ liệu. */
export function useLoanDefaults(companyId: string | null | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['loan-defaults', scope, companyId ?? ''],
    enabled: !!companyId,
    staleTime: 5 * 60_000,
    queryFn: () => apiData<LoanDefaults>('/automation/loan-defaults', { query: { company_id: companyId ?? undefined } }),
  });
}

/** Làm tươi mọi nơi hiển thị phiếu sau khi đổi tag / liên kết / lượt tự động. */
function invalidateVoucherViews(qc: QueryClient): void {
  for (const key of ['document', 'documents', 'queue', 'overview', 'automation-runs']) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/** Liên kết đổi ⇒ công nợ, khoản nợ NH và đối tác đổi số dư. */
function invalidateLinkConsumers(qc: QueryClient): void {
  invalidateVoucherViews(qc);
  for (const key of [
    'partner-debts',
    'partner-loans',
    'partner-vouchers',
    'partner',
    'debt-vouchers',
    'debt-voucher',
    'debt-candidates',
    'bank-debts',
    'bank-debt',
    'bank-debt-candidates',
  ]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/**
 * Làm tươi sau khi LƯU hồ sơ từ form lập/sửa (PATCH/POST). Form chuyển ngay sang màn chi tiết: nếu không làm tươi,
 * màn chi tiết dùng bản đệm TRƯỚC khi sửa (staleTime 10 s, polling 30 s) ⇒ banner khoản vay cũ tới lần tải kế tiếp.
 * `saved` = chi tiết trả về cùng PATCH (cùng dạng GET) ⇒ đặt thẳng vào bản đệm. Lưu có thể gắn/gỡ khoản vay
 * (R2/R3, liên kết Thủ công) nên làm tươi cả công nợ, khoản nợ NH và đối tác như khi đổi liên kết.
 */
export function refreshDocumentAfterSave(qc: QueryClient, scope: string, documentId: string, saved: DocumentDetail | null): void {
  if (saved) qc.setQueryData<DocumentDetail>(['document', scope, documentId], saved);
  invalidateLinkConsumers(qc);
}

/** Làm tươi nhanh (ms) khi có lượt đang chờ / đang chạy — khớp chú thích của hook: 3 giây. */
export const AUTOMATION_FAST_POLL_MS = 3_000;
/** Polling mặc định của app (store.tsx). Không được trả `false` — `false` sẽ TẮT luôn polling mặc định. */
export const AUTOMATION_IDLE_POLL_MS = 30_000;
/**
 * Khoảng theo dõi sau khi mở hồ sơ: lượt do lần lưu / sự kiện vừa rồi có thể CHƯA kịp được bộ máy tạo
 * (xử lý bất đồng bộ, "vài giây" — v2/v2.md §11.2), nên vẫn làm tươi nhanh dù danh sách đang rỗng.
 */
export const AUTOMATION_WATCH_MS = 2 * 60_000;

/**
 * Chu kỳ làm tươi danh sách lượt tự động của phiếu (hàm thuần, dùng trong `useAutomationRuns`):
 * - có lượt đang chờ / đang chạy ⇒ nhanh;
 * - còn trong khoảng theo dõi sau khi mở hồ sơ (kể cả danh sách rỗng hoặc chỉ có lượt đã xong) ⇒ nhanh;
 * - còn lại ⇒ polling mặc định. Trước đây trả `false` ⇒ panel không bao giờ thấy lượt mới đến sau khi đã tải.
 */
export function automationRunsPollMs(runs: readonly Pick<AutomationRunView, 'status'>[] | undefined, watchSince: number, now: number): number {
  const inFlight = (runs ?? []).some((r) => r.status === 'pending' || r.status === 'running');
  return inFlight || now - watchSince < AUTOMATION_WATCH_MS ? AUTOMATION_FAST_POLL_MS : AUTOMATION_IDLE_POLL_MS;
}

/**
 * Lượt tự động của MỘT phiếu (cũ → mới, đã bỏ lượt mà mọi bước đều "bỏ qua").
 * Làm tươi theo `automationRunsPollMs` để panel tự hiện lượt mới sinh sau khi hồ sơ đã mở (kể cả lúc mở chưa có lượt).
 */
export function useAutomationRuns(documentId: string | undefined) {
  const { scope } = useAuth();
  // mốc bắt đầu khoảng theo dõi của phiếu đang mở: mỗi lần mở hồ sơ (hoặc đổi sang phiếu khác) là một khoảng mới
  const [watch, setWatch] = useState(() => ({ documentId, since: Date.now() }));
  if (watch.documentId !== documentId) setWatch({ documentId, since: Date.now() });
  return useQuery({
    queryKey: ['automation-runs', 'document', documentId ?? ''],
    enabled: !!documentId,
    queryFn: () =>
      apiData<AutomationRunView[]>('/automation/runs/by-source', {
        query: { scope, source_type: 'document', source_id: documentId ?? '' },
      }),
    refetchInterval: (q) => automationRunsPollMs(q.state.data, watch.since, Date.now()),
  });
}

/** Chạy lại lượt lỗi (chỉ các bước chưa xong). Quyền: KTT hoặc `automation:config` (server kiểm). */
export function useRerunAutomationRun(documentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) =>
      apiData<AutomationRunView | null>(`/automation/runs/${encodeURIComponent(runId)}/rerun`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['automation-runs', 'document', documentId] });
      invalidateVoucherViews(qc);
    },
  });
}

/** Sửa tag của phiếu (kể cả sau khi duyệt, không ảnh hưởng tiền). Server ghi lịch sử `tags_update`. */
export function useSetDocumentTags(documentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { tag_ids: string[]; if_match: number }) => apiData<unknown>(`/documents/${documentId}/tags`, { method: 'PATCH', body }),
    onSuccess: () => invalidateVoucherViews(qc),
  });
}

export interface DocumentLinkInput {
  relation: ManualLinkRelation;
  to_id: string;
  amount_minor?: string;
  split?: { principal: string; interest: string; fee: string };
  note?: string;
}

/** Gán liên kết thủ công từ phiếu (cần `link:manage`). Lỗi FG-LINK-001/002/003 hiển thị cho người dùng. */
export function useCreateDocumentLink(documentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DocumentLinkInput) => apiData<unknown>(`/documents/${documentId}/links`, { method: 'POST', body }),
    onSuccess: () => invalidateLinkConsumers(qc),
  });
}

/** Gỡ liên kết (đánh dấu, không xoá). Lý do bắt buộc ≥ 5 ký tự. */
export function useRemoveDocumentLink(documentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ linkId, reason }: { linkId: string; reason: string }) =>
      apiData<unknown>(`/documents/${documentId}/links/${encodeURIComponent(linkId)}`, { method: 'DELETE', body: { reason } }),
    onSuccess: () => invalidateLinkConsumers(qc),
  });
}

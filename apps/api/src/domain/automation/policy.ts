/**
 * Chính sách THUẦN của các quy tắc tự động R1–R6 (v2/v2.md §11.4–11.6, §10.1) — không chạm DB.
 *
 * Tách riêng để kiểm thử: điều khoản vay mặc định (kỳ hạn, hạn thanh toán), số tiền vay theo duyệt
 * cuối, ngày duyệt cuối, quyết định khi phiếu nguồn bị huỷ / từ chối (R6), và thời điểm R2 tạo /
 * đồng bộ / kích hoạt khoản vay.
 */

import { vnDate } from '@fingate/shared';
import { addMonths } from '../loan-schedule/index.ts';

/** Kỳ hạn mặc định (tháng) của khoản vay sinh tự động — §11.4 (a). */
export const DEFAULT_TERM_MONTHS = 12;
/** Lệch hạn thanh toán so với ngày giải ngân (tháng) — §11.4 (a): ngày giải ngân + 11 tháng. */
export const DEFAULT_DUE_OFFSET_MONTHS = 11;

/** R2 tạo khoản vay lúc nào: khi lưu phiếu (`save`) hoặc khi phiếu được duyệt (`approve`). */
export type R2CreateAt = 'save' | 'approve';

/** Phiếu còn trước duyệt cuối: được phép đồng bộ thông tin khoản vay theo mỗi lần sửa. */
export const PRE_APPROVAL_VOUCHER_STATUSES: readonly string[] = [
  'draft',
  'changes_requested',
  'rejected',
  'pending.ktt',
  'pending.pgd',
  'pending.gd',
  'pending.ptg',
  'pending.chairman',
];
/** Phiếu đã duyệt cuối (đã thực thi, hoặc đang chờ thanh toán). */
export const APPROVED_VOUCHER_STATUSES: readonly string[] = ['approved', 'processing', 'paid'];
/** Trạng thái huỷ hẳn của phiếu nguồn — R6 xử lý các đối tượng đã sinh ra. */
export const FINAL_CANCEL_VOUCHER_STATUSES: readonly string[] = ['cancelled', 'rejected'];
/** Khoản vay đã có tiền về (đã giải ngân). */
export const DISBURSED_LOAN_STATUSES: readonly string[] = ['active', 'overdue', 'settled', 'archived'];

/** Đọc tham số số nguyên từ cấu hình (JSON); giá trị sai hoặc ngoài khoảng ⇒ mặc định. */
export function intParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

/** `r2_create_at` (mặc định `save`). */
export function r2CreateAtOf(value: unknown): R2CreateAt {
  return value === 'approve' ? 'approve' : 'save';
}

/** Ngày dạng `YYYY-MM-DD` hợp lệ (đúng lịch: 30/02 không hợp lệ). */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v === '' ? null : v;
}

/** Điều khoản người dùng nhập trên phiếu (`options.loan.terms`), các trường có thể trống. */
export interface LoanTermsInput {
  contract_no?: string | null;
  interest_rate?: string | null;
  term_months?: number | null;
  due_date?: string | null;
  repayment_period?: string | null;
  repayment_method?: string | null;
  collateral?: string | null;
}

/** Điều khoản đã chốt để tạo / đồng bộ khoản vay. */
export interface ResolvedLoanTerms {
  contract_no: string | null;
  interest_rate: string;
  term_months: number;
  due_date: string;
  /** true = hạn thanh toán do hệ thống tính (ngày giải ngân + lệch tháng), chưa do người dùng nhập. */
  due_is_default: boolean;
  payment_frequency: 'monthly' | 'quarterly' | 'semiannual' | 'maturity';
  repayment_method: 'interest_only' | 'equal_principal';
  collateral: string | null;
}

/**
 * Điều khoản vay: người dùng nhập thì dùng, bỏ trống thì lấy mặc định của quy tắc.
 * - kỳ hạn: `term_months` của người dùng, không có ⇒ tham số `term_months` (mặc định 12);
 * - hạn thanh toán: người dùng nhập, không có ⇒ `baseDate` + `due_offset_months` (mặc định 11 tháng).
 * `baseDate` là ngày giải ngân (YYYY-MM-DD).
 */
export function resolveLoanTerms(input: {
  terms?: LoanTermsInput | null;
  baseDate: string;
  params?: Record<string, unknown> | null;
}): ResolvedLoanTerms {
  const params = input.params ?? {};
  const termMonths = intParam(input.terms?.term_months, intParam(params.term_months, DEFAULT_TERM_MONTHS, 1, 600), 1, 600);
  const offset = intParam(params.due_offset_months, DEFAULT_DUE_OFFSET_MONTHS, 0, 600);
  const userDue = isIsoDay(input.terms?.due_date) ? input.terms!.due_date! : null;
  return {
    contract_no: nonEmpty(input.terms?.contract_no),
    interest_rate: nonEmpty(input.terms?.interest_rate) ?? '0',
    term_months: termMonths,
    due_date: userDue ?? addMonths(input.baseDate, offset),
    due_is_default: userDue === null,
    payment_frequency: paymentFrequencyOf(input.terms?.repayment_period),
    repayment_method: input.terms?.repayment_method === 'equal_principal' ? 'equal_principal' : 'interest_only',
    collateral: nonEmpty(input.terms?.collateral),
  };
}

function paymentFrequencyOf(value: unknown): ResolvedLoanTerms['payment_frequency'] {
  return value === 'monthly' || value === 'quarterly' || value === 'semiannual' || value === 'maturity' ? value : 'maturity';
}

/**
 * Số tiền vay của R3 (§11.5): mặc định = số tiền phiếu chi. Nếu người lập để số tiền vay BẰNG số tiền
 * phiếu chi lúc gửi duyệt, thì số tiền vay đi theo số tiền cấp duyệt cuối đã chốt; nếu người lập nhập
 * số khác, giữ số đó. Số tiền vay không được vượt số tiền đã duyệt (phiếu chi có thể bị giảm khi duyệt).
 */
export function resolveLoanAmount(input: { requested: bigint | null; originalMinor: bigint; finalMinor: bigint }): {
  amount: bigint;
  followsFinal: boolean;
} {
  const followsFinal = input.requested === null || input.requested === input.originalMinor;
  const amount = followsFinal ? input.finalMinor : (input.requested as bigint);
  if (amount <= 0n) throw new Error('Số tiền vay phải lớn hơn 0');
  if (amount > input.finalMinor) throw new Error('Số tiền vay lớn hơn số tiền phiếu chi đã duyệt');
  return { amount, followsFinal };
}

/** Một dòng lịch sử (history) đọc được: chỉ cần hành động, thời điểm, số tiền tại quyết định. */
export interface HistoryLike {
  action?: string | null;
  at?: Date | string | null;
  amount_at_decision?: string | null;
}

/** Số tiền lúc người lập gửi duyệt (dòng `submit` đầu tiên), null nếu không có. */
export function submittedAmountOf(history: readonly HistoryLike[] | null | undefined): bigint | null {
  const entry = (history ?? []).find((h) => h.action === 'submit' && h.amount_at_decision);
  if (!entry?.amount_at_decision) return null;
  try {
    return BigInt(entry.amount_at_decision);
  } catch {
    return null;
  }
}

/** Ngày duyệt cuối (ngày VN) = thời điểm dòng duyệt cuối trong lịch sử; không có ⇒ `fallback`. */
export function finalApprovalDateOf(history: readonly HistoryLike[] | null | undefined, fallback: string): string {
  const approvals = (history ?? []).filter((h) => (h.action === 'approve' || h.action === 'approve_with_reason') && h.at);
  const last = approvals.at(-1);
  if (!last?.at) return fallback;
  return vnDate(last.at);
}

/** Có tiền đã về khoản vay chưa: đã giải ngân (trạng thái hoặc ngày giải ngân). */
export function moneyMoved(loan: { status: string | null; disbursed_at?: Date | string | null }): boolean {
  if (loan.disbursed_at) return true;
  return loan.status !== null && DISBURSED_LOAN_STATUSES.includes(loan.status);
}

/** Quyết định R6 cho một khoản vay gắn với phiếu nguồn bị huỷ / từ chối hẳn. */
export type SourceFinalDecision = 'cancel' | 'unlink' | 'alert' | 'none';

/** Nguồn gán của liên kết (`Thủ công` = người dùng chọn trên phiếu; `Tự động` = quy tắc tạo). */
export type SourceLinkOrigin = 'automation' | 'manual';

/**
 * Quyết định R6 cho MỘT khoản vay gắn với phiếu nguồn đã huỷ / từ chối hẳn (v2 §11.3 R6, §11.5, §14.3 (6)):
 * - không do phiếu này sinh ra, chỉ gắn bằng liên kết THỦ CÔNG (người dùng chọn trên phiếu) ⇒ chỉ GỠ liên kết: phiếu
 *   đã huỷ / từ chối thì liên kết không còn hiệu lực. Khoản vay KHÔNG bị huỷ và KHÔNG cảnh báo (R6 chỉ xử lý đối tượng
 *   tự sinh), dù khoản đã có tiền hay chưa;
 * - không liên kết và không do phiếu sinh ra ⇒ không làm gì (không thuộc phạm vi phiếu này);
 * - đã huỷ rồi ⇒ không làm gì;
 * - đã có tiền về ⇒ chỉ CẢNH BÁO KTT, không tự huỷ, giữ liên kết để người dùng quyết định (§11.5, §14.3 (6));
 * - chưa có tiền, do phiếu sinh ra hoặc gắn bằng liên kết tự động ⇒ HUỶ khoản vay.
 */
export function decideOnSourceFinal(input: {
  loanStatus: string | null;
  /** khoản do CHÍNH phiếu nguồn sinh ra (quy tắc tự động, `origin.source_document_id` trỏ tới phiếu này) */
  generated: boolean;
  /** nguồn của liên kết hiệu lực từ phiếu nguồn tới khoản vay; null nếu không có liên kết */
  linkOrigin: SourceLinkOrigin | null;
  disbursedAt?: Date | string | null;
}): SourceFinalDecision {
  if (!input.generated && input.linkOrigin === null) return 'none';
  if (!input.generated && input.linkOrigin === 'manual') return 'unlink';
  if (input.loanStatus === 'cancelled') return 'none';
  if (moneyMoved({ status: input.loanStatus, disbursed_at: input.disbursedAt ?? null })) return 'alert';
  if (input.loanStatus === 'pending_disbursement') return 'cancel';
  return 'none';
}

/**
 * R2: có được TẠO khoản vay ở sự kiện này không (mode `new`).
 * - `save`: tạo khi phiếu được lập / sửa / gửi duyệt, khi còn trước duyệt cuối (không tạo khi bị từ chối);
 * - `approve`: chỉ tạo khi phiếu đã duyệt;
 * - đã duyệt cuối mà chưa có khoản vay (VD quy tắc bật sau) ⇒ luôn được tạo bù.
 */
export function mayCreateLoan(input: { createAt: R2CreateAt; eventType: string; status: string }): boolean {
  if (APPROVED_VOUCHER_STATUSES.includes(input.status)) return true;
  if (input.createAt === 'approve') return false;
  const saveEvents = ['voucher.created', 'voucher.updated', 'voucher.submitted'];
  return saveEvents.includes(input.eventType) && PRE_APPROVAL_VOUCHER_STATUSES.includes(input.status) && input.status !== 'rejected';
}

/** R2: đồng bộ thông tin khoản vay (chưa giải ngân) theo sửa đổi khi phiếu còn trước duyệt cuối. */
export function mayFollowLoanEdits(status: string): boolean {
  return PRE_APPROVAL_VOUCHER_STATUSES.includes(status);
}

/**
 * R2: phục hồi khoản vay tự sinh đã huỷ (chưa có tiền) khi người dùng chọn lại "vay mới" trên phiếu còn trước
 * duyệt cuối — VD đổi sang "để sau" rồi quay lại "vay mới", hoặc gửi lại duyệt. Phiếu đã từ chối đứng yên và
 * phiếu đã duyệt cuối không phục hồi.
 */
export function mayReviveLoan(input: { eventType?: string; status: string }): boolean {
  return PRE_APPROVAL_VOUCHER_STATUSES.includes(input.status) && input.status !== 'rejected';
}

/**
 * R3 / duyệt phiếu chi vay để chi có SỐ TIỀN VAY RIÊNG (vay một phần): số tiền chi sau khi cấp duyệt đổi
 * không được nhỏ hơn số tiền vay (§6.3, §11.5). `loanMinor` = null ⇒ vay theo số tiền phiếu (luôn hợp lệ).
 */
export function loanExceedsSpend(input: { loanMinor: bigint | null; spendMinor: bigint }): boolean {
  return input.loanMinor !== null && input.loanMinor > input.spendMinor;
}

/** Ngày gốc để tính hạn thanh toán mặc định: ngày thực thi nếu đã có, không thì ngày dự kiến. */
export function loanBaseDate(input: { paidDate?: string | null; plannedDate?: string | null; fallback: string }): string {
  if (isIsoDay(input.paidDate)) return input.paidDate;
  const planned = typeof input.plannedDate === 'string' ? input.plannedDate.slice(0, 10) : '';
  return isIsoDay(planned) ? planned : input.fallback;
}

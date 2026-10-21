/**
 * FinGate web — v2 Công nợ & Nợ ngân hàng (v2/v2.md §9, §10, §11.4, US-AUTO-08): kiểu trên WIRE, hằng số,
 * hàm thuần và react-query hooks cho màn Công nợ (`screens/debt.tsx`), Nợ ngân hàng (`screens/bank-debt.tsx`)
 * và Bảng đáo hạn (`screens/loans.tsx`).
 *
 * Nguồn hợp đồng: `apps/api/src/routes/debt.ts`, `routes/bank-debt.ts`, `domain/debt/{debts,loans}.ts`.
 *   Công nợ:  GET /debts · /debts/aging · /debts/:id · /debts/:id/link-candidates
 *             POST /debts · /debts/:id/links · PATCH|DELETE /debts/:id · DELETE /debts/:id/links/:linkId
 *   Nợ NH:    GET /bank-debts · /bank-debts/:id · /bank-debts/:id/schedule · …/disbursement-candidates · …/repayment-candidates
 *             POST /bank-debts · /bank-debts/import · /bank-debts/:id/cancel|archive|disbursements|repayments
 *             PATCH|DELETE /bank-debts/:id · DELETE /bank-debts/:id/disbursements|repayments/:linkId
 * Tiền là MoneyWire (minor = chuỗi); server suy còn lại / quá hạn / dư nợ khi đọc, web không tự tính lại.
 * Query key giữ nguyên tên v1 (`debt-vouchers`, `debt-voucher`, `bank-debts`, `bank-debt`) để cache đối tác
 * (`app/v2/partners.ts`) làm mới đúng khi trả nợ.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_CODE_BY_PARTY,
  type BankDebtStatus,
  type BusinessLinkRelation,
  type DebtDirection,
  type LinkOrigin,
  type MoneyWire,
  type PartnerRef,
} from '@fingate/shared';
import { apiCall, apiData } from '../api.ts';
import { useAuth } from '../store.tsx';
import type { OwnerAttachment } from '../types.ts';

/* ================= hằng số & nhãn ================= */

/** Trạng thái tổng hợp của khoản công nợ (suy ra): chưa cấn trừ / cấn một phần / đã cấn đủ. */
export type DebtFillStatus = 'open' | 'partial' | 'settled';
export const DEBT_FILL_LABEL: Record<DebtFillStatus, { label: string; tone: string }> = {
  open: { label: 'Chưa cấn trừ', tone: 'neutral' },
  partial: { label: 'Cấn một phần', tone: 'info' },
  settled: { label: 'Đã cấn đủ', tone: 'success' },
};

/** Nhóm tuổi nợ theo số ngày quá hạn (0 = chưa đến hạn). */
export type AgingBucket = 'none' | 'lt30' | 'd30_60' | 'd60_90' | 'gt90';
export const AGING_BUCKETS: readonly AgingBucket[] = ['none', 'lt30', 'd30_60', 'd60_90', 'gt90'];
export const AGING_BUCKET_LABEL: Record<AgingBucket, string> = {
  none: 'Chưa đến hạn',
  lt30: 'Quá hạn < 30 ngày',
  d30_60: '30–60 ngày',
  d60_90: '60–90 ngày',
  gt90: '> 90 ngày',
};

/** Chiều hiển thị: phải thu = ghi Nợ (TK 131 / 331 theo loại đối tác), phải trả = ghi Có. */
export const DIRECTION_TONE: Record<DebtDirection, string> = { receivable: 'info', payable: 'attention' };

/** Đường dẫn chi tiết chứng từ theo loại (khớp `docHref` phía server: /ho-so/<chi|thu|dao-han|noi-bo>/:id). */
const DOC_SEGMENT: Record<string, string> = { spend: 'chi', income: 'thu', rollover: 'dao-han', internal: 'noi-bo' };
export function voucherHref(kind: string, id: string): string {
  return `/ho-so/${DOC_SEGMENT[kind] ?? 'chi'}/${id}`;
}

/* ================= kiểu trên wire: công nợ ================= */

/** Dòng công nợ (GET /debts → items). `partner` là đối tác hiện hành (tên, loại, ngân hàng, STK). */
export interface DebtRow {
  _id: string;
  company_id: string;
  company_name: string;
  code: string;
  partner_id: string | null;
  partner: PartnerRef | null;
  /** customer | supplier | employee (nhân viên v1: chỉ đọc). */
  party_type: string;
  party_name: string;
  direction: DebtDirection;
  account_code: string;
  side: 'debit' | 'credit';
  value: MoneyWire;
  /** Đã cấn trừ — chỉ tính phiếu ĐÃ THỰC THI. */
  offset_applied: MoneyWire;
  remaining: MoneyWire;
  currency: string;
  contract_code: string | null;
  due_date: string;
  days_overdue: number;
  aging_bucket: AgingBucket;
  priority: string;
  status: DebtFillStatus;
  note: string | null;
  attachment_count: number;
  link_count: number;
  read_only: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface DebtListResult {
  items: DebtRow[];
  total: number;
  page: number;
  limit: number;
  /** Chạm trần truy vấn server: KPI / tổng chỉ tính trên phần đã nạp — cần cảnh báo người dùng. */
  truncated?: boolean;
  totals: { remaining: MoneyWire; value: MoneyWire; offset_applied: MoneyWire };
}

/** Một cấn trừ (business_links · offset) của khoản công nợ. */
export interface OffsetLinkRow {
  _id: string;
  link_id: string;
  relation: BusinessLinkRelation;
  document_id: string;
  document_code: string;
  document_title: string;
  /** income = phiếu thu, spend = phiếu chi. */
  document_kind: string;
  document_status: string;
  /** Phiếu đã thực thi (paid) — chỉ khi true mới tính vào "Đã cấn trừ". */
  executed: boolean;
  amount: MoneyWire;
  linked_at: string | null;
  origin: LinkOrigin;
  rule_code: string | null;
  note: string | null;
}

export interface DebtDetail extends DebtRow {
  offset_links: OffsetLinkRow[];
  history: Record<string, unknown>[];
  attachments: OwnerAttachment[];
}

export interface DebtAgingCell {
  bucket: AgingBucket;
  amount: MoneyWire;
  count: number;
}

export interface DebtAgingRow {
  counterparty: string;
  partner_id: string | null;
  company_name: string;
  direction: DebtDirection;
  party_type: string;
  cells: DebtAgingCell[];
  total: MoneyWire;
}

/** Ma trận tuổi nợ theo đối tác & hướng (US-DEBT-03). Chỉ khoản còn dư. */
export interface DebtAgingResult {
  party_type: string | null;
  direction: DebtDirection | null;
  columns: { bucket: AgingBucket; label: string }[];
  rows: DebtAgingRow[];
  totals: { bucket: AgingBucket; amount: MoneyWire }[];
}

/** Chứng từ có thể gán (cấn trừ / giải ngân / trả nợ): cùng công ty, cùng đối tác, đúng loại. */
export interface DocCandidate {
  _id: string;
  code: string;
  title: string;
  kind: 'income' | 'spend';
  status: string;
  amount: MoneyWire;
  /** Đã phân bổ (mọi trạng thái phiếu). */
  allocated: MoneyWire;
  /** Còn có thể phân bổ, không âm. */
  unallocated: MoneyWire;
  already_linked: boolean;
}

/* ================= kiểu trên wire: nợ ngân hàng ================= */

export interface LoanWarning {
  level: number;
  tone: string;
  bucket: string;
  label: string;
  days_to_due: number;
}

export interface LoanOrigin {
  kind: string;
  run_id: string | null;
  rule_code: string | null;
}

/** Dòng nợ ngân hàng (GET /bank-debts → items). `status` là trạng thái vòng đời (BankDebtStatus). */
export interface LoanRow {
  _id: string;
  company_id: string;
  company_name: string;
  code: string;
  partner_id: string | null;
  partner: PartnerRef | null;
  bank_name: string;
  credit_limit: MoneyWire;
  principal: MoneyWire;
  outstanding: MoneyWire;
  repaid: MoneyWire;
  repaid_interest: MoneyWire;
  repaid_fee: MoneyWire;
  disbursed: MoneyWire;
  disbursement_planned: MoneyWire;
  undisbursed: MoneyWire;
  funded_by_total: MoneyWire;
  currency: string;
  interest_rate: string;
  term_months: number | null;
  payment_frequency: string;
  repayment_method: string;
  interest_to_maturity: MoneyWire;
  maturity_date: string;
  next_due_date: string | null;
  days_to_due: number;
  status: BankDebtStatus;
  /** Chỉ có khi khoản còn trên bảng đáo hạn (đang vay / quá hạn). */
  warning: LoanWarning | null;
  /** v2 §10.1: số HĐ tín dụng (đổi khi đảo hạn), TSĐB, người phụ trách. */
  contract_no: string | null;
  collateral: string | null;
  responsible: string | null;
  disbursed_at: string | null;
  origin: LoanOrigin;
  repayment_count: number;
  attachment_count: number;
  note: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface LoanListResult {
  items: LoanRow[];
  totals: {
    /** Dư nợ — chỉ khoản đang vay / quá hạn (không gồm chờ giải ngân). */
    outstanding: MoneyWire;
    count: number;
    pending_count: number;
    pending_amount: MoneyWire;
  };
}

/** Một liên kết của khoản nợ NH: giải ngân (disbursement), trả nợ (repayment) hoặc chi bằng vốn vay (funded_by). */
export interface LoanLinkRow {
  _id: string;
  link_id: string;
  relation: BusinessLinkRelation;
  document_id: string;
  document_code: string;
  document_title: string;
  /** income = phiếu thu giải ngân, spend = phiếu chi trả nợ / phiếu chi được tài trợ. */
  document_kind: string;
  document_status: string;
  executed: boolean;
  amount: MoneyWire;
  principal: MoneyWire;
  interest: MoneyWire;
  fee: MoneyWire;
  origin: LinkOrigin;
  rule_code: string | null;
  linked_at: string | null;
  note: string | null;
}

export interface LoanDetail extends LoanRow {
  funded_by_links: LoanLinkRow[];
  disbursement_links: LoanLinkRow[];
  chain: { funded_by: LoanLinkRow[]; disbursements: LoanLinkRow[]; repayments: LoanLinkRow[] };
  history: Record<string, unknown>[];
  attachments: OwnerAttachment[];
}

export interface LoanScheduleRow {
  period: number;
  due_date: string;
  days: number;
  principal: MoneyWire;
  interest: MoneyWire;
  fee: MoneyWire;
  total: MoneyWire;
  status: 'upcoming' | 'due' | 'overdue';
}

export interface LoanScheduleResult {
  loan_id: string;
  contract_code: string;
  bank_name: string;
  currency: string;
  interest_rate: string;
  term_months: number;
  payment_frequency: string;
  repayment_method: string;
  start_date: string;
  maturity_date: string;
  rows: LoanScheduleRow[];
  totals: { principal: MoneyWire; interest: MoneyWire; fee: MoneyWire; total: MoneyWire };
}

export interface LoanImportResult {
  inserted: number;
  failed: { row: number; error: string }[];
  total_rows: number;
  created: { code: string; bank_name: string }[];
}

/* ================= body ghi (khớp zod ở domain/debt/bodies.ts) ================= */

export interface DebtCreateInput {
  company_id?: string;
  partner_id: string;
  direction: DebtDirection;
  value: { amount_minor: string; currency: string };
  due_date: string;
  contract_code?: string;
  priority: string;
  note?: string;
  /** Chống gửi lặp (retry): cùng một mã cho cùng một lần lưu. */
  request_id?: string;
}

/** PATCH: chỉ gửi trường đổi. `null` = xoá giá trị (ghi chú, số HĐ). */
export interface DebtUpdateInput {
  partner_id?: string;
  direction?: DebtDirection;
  value?: { amount_minor: string; currency: string };
  due_date?: string;
  contract_code?: string | null;
  priority?: string;
  note?: string | null;
}

export interface LoanCreateInput {
  company_id?: string;
  partner_id: string;
  amount: { amount_minor: string; currency: string };
  credit_limit?: { amount_minor: string; currency: string };
  disbursed_date?: string;
  maturity_date: string;
  interest_rate: string;
  term_months?: number;
  payment_frequency: string;
  repayment_method: string;
  contract_no?: string;
  collateral?: string;
  responsible?: string;
  note?: string;
  request_id?: string;
}

export interface LoanUpdateInput {
  partner_id?: string;
  amount?: { amount_minor: string; currency: string };
  credit_limit?: { amount_minor: string; currency: string } | null;
  maturity_date?: string;
  interest_rate?: string;
  term_months?: number | null;
  payment_frequency?: string;
  repayment_method?: string;
  contract_no?: string | null;
  collateral?: string | null;
  responsible?: string | null;
  note?: string | null;
}

/** Tách phần của khoản trả nợ: gốc + lãi + phí. */
export interface RepaymentSplit {
  principal: string;
  interest: string;
  fee: string;
}

/* ================= hàm thuần (không gọi server) ================= */

/** Số tiền minor (BigInt) từ kiểu wire; thiếu hoặc sai định dạng ⇒ 0. */
export function minorOf(w: { minor?: unknown } | null | undefined): bigint {
  const s = String(w?.minor ?? '');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

export function parseDirection(v: string | null | undefined): DebtDirection | undefined {
  return v === 'receivable' || v === 'payable' ? v : undefined;
}

export function parseAgingBucket(v: string | null | undefined): AgingBucket | undefined {
  return AGING_BUCKETS.includes(v as AgingBucket) ? (v as AgingBucket) : undefined;
}

/** Hướng từ bút toán v1 (`side`): debit = phải thu, credit = phải trả. Dùng khi URL còn `side`. */
export function directionFromSide(side: string | null | undefined): DebtDirection {
  return side === 'credit' ? 'payable' : 'receivable';
}

/** Bút toán Nợ/Có tương ứng hướng (server suy giống hệt; gửi kèm chỉ để form v1 cũ vẫn đúng). */
export function sideOfDirection(direction: DebtDirection): 'debit' | 'credit' {
  return direction === 'receivable' ? 'debit' : 'credit';
}

/** TK kế toán theo loại đối tác: KH = 131, NCC = 331; loại khác (nhân viên 334) không suy ở form. */
export function accountCodeOf(partnerType: string | null | undefined): string | null {
  if (partnerType === 'customer' || partnerType === 'supplier') return ACCOUNT_CODE_BY_PARTY[partnerType];
  return null;
}

/** Loại chứng từ được phép cấn trừ theo hướng: phải thu ↔ phiếu thu; phải trả ↔ phiếu chi. */
export function docKindOfDirection(direction: DebtDirection): 'income' | 'spend' {
  return direction === 'receivable' ? 'income' : 'spend';
}

/**
 * Tách gốc / lãi / phí theo tổng đã nhập: gốc = tổng − lãi − phí. Trả về `null` khi gốc âm (không hợp lệ).
 * Dư nợ chỉ trừ phần GỐC (v2 §10.3).
 */
export function principalOfSplit(total: bigint, interest: bigint, fee: bigint): bigint | null {
  if (total <= 0n || interest < 0n || fee < 0n) return null;
  const principal = total - interest - fee;
  return principal >= 0n ? principal : null;
}

/** Khoản đang vay (còn trên bảng đáo hạn, còn tính vào dư nợ). */
export function isLoanOnBoard(status: string): boolean {
  return status === 'active' || status === 'overdue';
}

/** Gán phiếu thu giải ngân được khi khoản chưa huỷ / lưu trữ / tất toán (server kiểm lại). */
export function canAssignDisbursement(status: string): boolean {
  return status === 'pending_disbursement' || status === 'active' || status === 'overdue';
}

/** Gán phiếu chi trả nợ chỉ khi khoản đang vay (server kiểm lại). */
export function canAssignRepayment(status: string): boolean {
  return status === 'active' || status === 'overdue';
}

export function canCancelLoan(status: string): boolean {
  return status === 'pending_disbursement';
}

export function canArchiveLoan(status: string): boolean {
  return status === 'settled';
}

/** Sửa được khi chưa huỷ / lưu trữ. */
export function canEditLoan(status: string): boolean {
  return status !== 'cancelled' && status !== 'archived';
}

/** Nhãn tiếng Việt của trường ghi trong lịch sử công nợ / khoản vay (v2 §2.3: trước → sau). */
export const HISTORY_FIELD_LABEL: Record<string, string> = {
  partner_id: 'Đối tác',
  party_type: 'Loại đối tác',
  direction: 'Hướng',
  side: 'Bút toán',
  account_code: 'TK kế toán',
  value_minor: 'Giá trị',
  due_date: 'Hạn thanh toán',
  contract_code: 'Số hợp đồng',
  priority: 'Ưu tiên',
  note: 'Ghi chú',
  principal_minor: 'Gốc',
  credit_limit_minor: 'Hạn mức',
  interest_rate: 'Lãi suất',
  term_months: 'Kỳ hạn (tháng)',
  payment_frequency: 'Kỳ trả lãi/gốc',
  repayment_method: 'Phương thức trả',
  maturity_date: 'Hạn thanh toán (đáo hạn)',
  contract_no: 'Số HĐ tín dụng',
  collateral: 'Tài sản đảm bảo',
  responsible: 'Người phụ trách',
};

export interface HistoryChangeRow {
  field: string;
  label: string;
  from: string | null;
  to: string | null;
}

export interface HistoryRow {
  at: string | null;
  actor: string;
  action: string;
  ip: string | null;
  changes: HistoryChangeRow[];
}

/** Dòng lịch sử hiển thị: ai, khi nào, thao tác, và các trường đổi trước → sau (`fields.changes`). */
export function historyRowsOf(history: Record<string, unknown>[] | undefined | null): HistoryRow[] {
  return (history ?? []).map((raw) => {
    const e = raw as {
      at?: unknown;
      action?: unknown;
      ip?: unknown;
      actor?: { name?: unknown; role?: unknown } | null;
      fields?: { changes?: Record<string, { from?: unknown; to?: unknown }> } | null;
    };
    const changes = Object.entries(e.fields?.changes ?? {}).map(([field, v]) => ({
      field,
      label: HISTORY_FIELD_LABEL[field] ?? field,
      from: v?.from === null || v?.from === undefined ? null : String(v.from),
      to: v?.to === null || v?.to === undefined ? null : String(v.to),
    }));
    return {
      at: e.at ? String(e.at) : null,
      actor: String(e.actor?.name ?? '') || 'Hệ thống',
      action: String(e.action ?? ''),
      ip: e.ip ? String(e.ip) : null,
      changes,
    };
  });
}

/** Mã yêu cầu (chống gửi lặp): dùng cùng một mã cho mọi lần gửi lại của cùng một lần lưu. */
export function newRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface BankTotalRow {
  key: string;
  bank_name: string;
  count: number;
  /** Dư nợ (chỉ khoản đang vay / quá hạn). */
  outstanding: bigint;
  /** Dư nợ đáo hạn trong 7 ngày (gồm quá hạn). */
  due7: bigint;
  /** Dư nợ đáo hạn trong 30 ngày (gồm quá hạn). */
  due30: bigint;
}

/**
 * Tổng dư nợ theo từng ngân hàng (US-LOAN-02): số khoản, dư nợ, dư nợ đáo hạn trong 7 / 30 ngày.
 * Chỉ khoản đang vay / quá hạn; sắp theo dư nợ giảm dần. Hàm thuần — không gọi server.
 */
export function bankTotalsOf(items: LoanRow[]): BankTotalRow[] {
  const map = new Map<string, BankTotalRow>();
  for (const l of items) {
    if (!isLoanOnBoard(l.status)) continue;
    const key = l.partner_id ?? `name:${l.bank_name}`;
    const row = map.get(key) ?? { key, bank_name: l.partner?.name ?? l.bank_name, count: 0, outstanding: 0n, due7: 0n, due30: 0n };
    const out = minorOf(l.outstanding);
    row.count += 1;
    row.outstanding += out;
    if (l.days_to_due <= 7) row.due7 += out;
    if (l.days_to_due <= 30) row.due30 += out;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => (a.outstanding === b.outstanding ? 0 : a.outstanding > b.outstanding ? -1 : 1));
}

/** Liên kết tới phiếu đã huỷ / từ chối / hết hạn: không còn giữ sức chứa (cảnh báo trên chi tiết). */
export function hasDeadOffsetLink(links: { document_status: string }[]): boolean {
  return links.some((l) => ['cancelled', 'rejected', 'expired'].includes(l.document_status));
}

/** Nhãn nguồn gốc: "Tự động · R2" hoặc "Thủ công". */
export function originLabel(origin: { kind: string; rule_code: string | null } | null | undefined): string {
  if (origin?.kind === 'automation') return origin.rule_code ? `Tự động · ${origin.rule_code}` : 'Tự động';
  return 'Thủ công';
}

/* ================= react-query hooks ================= */

/** Khoá làm mới cho công nợ: danh sách, chi tiết, tuổi nợ, ứng viên, đối tác (tab Công nợ, cấn trừ). */
const DEBT_KEYS = ['debt-vouchers', 'debt-voucher', 'debt-aging', 'debt-candidates', 'partner-debts', 'partner', 'partners', 'partner-options', 'overview'];
/** Khoá làm mới cho nợ NH: danh sách, chi tiết, lịch, ứng viên, đáo hạn, đối tác (tab Nợ NH). */
const LOAN_KEYS = ['bank-debts', 'bank-debt', 'bank-debt-candidates', 'bank-debt-schedule', 'partner-loans', 'partner', 'partners', 'partner-options', 'rollovers', 'rollover-preparation', 'overview'];
/** Liên kết đổi ⇒ chứng từ (màn chi tiết phiếu hiển thị liên kết) và hàng chờ cũng đổi. */
const VOUCHER_KEYS = ['documents', 'document', 'queue'];

function invalidateKeys(qc: QueryClient, keys: readonly string[]): void {
  for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
}

export interface DebtListFilters {
  direction?: DebtDirection;
  partner_id?: string;
  q?: string;
  overdue_only?: 'true';
  bucket?: AgingBucket;
  limit?: number;
  page?: number;
}

/** Danh sách công nợ (lọc, phân trang, tổng hợp). */
export function useDebtList(filters: DebtListFilters) {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['debt-vouchers', scope, filters],
    enabled: can('debt:read'),
    queryFn: () => apiCall<DebtListResult>('/debts', { query: { scope, ...filters } }),
  });
}

/** Ma trận tuổi nợ theo đối tác & hướng (US-DEBT-03). */
export function useDebtAging(filters: { direction?: DebtDirection; party_type?: string }) {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['debt-aging', scope, filters],
    enabled: can('debt:read'),
    queryFn: () => apiData<DebtAgingResult>('/debts/aging', { query: { scope, ...filters } }),
  });
}

export function useDebt(id: string | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['debt-voucher', scope, id ?? ''],
    enabled: !!id,
    queryFn: () => apiData<DebtDetail>(`/debts/${id}`, { query: { scope } }),
  });
}

/** Phiếu thu/chi để cấn trừ khoản công nợ này. `q` tìm theo mã / nội dung. */
export function useDebtOffsetCandidates(id: string | undefined, q: string) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['debt-candidates', scope, id ?? '', q],
    enabled: !!id,
    queryFn: () => apiCall<{ items: DocCandidate[] }>(`/debts/${id}/link-candidates`, { query: { scope, q: q || undefined } }),
  });
}

export function useCreateDebt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DebtCreateInput) => apiData<{ _id: string; code: string }>('/debts', { method: 'POST', body }),
    onSuccess: () => invalidateKeys(qc, DEBT_KEYS),
  });
}

export function useUpdateDebt(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DebtUpdateInput) => apiData<{ ok: boolean }>(`/debts/${id}`, { method: 'PATCH', body }),
    onSuccess: () => invalidateKeys(qc, DEBT_KEYS),
  });
}

export function useDeleteDebt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData<{ ok: boolean }>(`/debts/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateKeys(qc, DEBT_KEYS),
  });
}

/** Gán phiếu thu/chi cấn trừ. Bỏ trống số tiền = phần còn lại có thể phân bổ (server tính). */
export function useAssignDebtOffset(debtId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { document_id: string; amount_minor?: string; note?: string }) =>
      apiData<{ _id: string }>(`/debts/${debtId}/links`, { method: 'POST', body }),
    onSuccess: () => {
      invalidateKeys(qc, DEBT_KEYS);
      invalidateKeys(qc, VOUCHER_KEYS);
    },
  });
}

/** Gỡ cấn trừ (đánh dấu đã gỡ, có lý do). */
export function useRemoveDebtOffset(debtId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ linkId, reason }: { linkId: string; reason: string }) =>
      apiData<{ ok: boolean }>(`/debts/${debtId}/links/${linkId}`, { method: 'DELETE', body: { reason } }),
    onSuccess: () => {
      invalidateKeys(qc, DEBT_KEYS);
      invalidateKeys(qc, VOUCHER_KEYS);
    },
  });
}

export interface LoanListFilters {
  status?: string;
  partner_id?: string;
  q?: string;
}

/** Danh sách nợ ngân hàng (có mục chờ giải ngân trong `totals`). `enabled: false` để không tải khi không cần. */
export function useLoanList(filters: LoanListFilters, opts?: { enabled?: boolean }) {
  const { scope, can } = useAuth();
  return useQuery({
    queryKey: ['bank-debts', scope, filters],
    enabled: can('loan:read') && (opts?.enabled ?? true),
    queryFn: () => apiCall<LoanListResult>('/bank-debts', { query: { scope, ...filters } }),
  });
}

export function useLoan(id: string | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['bank-debt', scope, id ?? ''],
    enabled: !!id,
    queryFn: () => apiData<LoanDetail>(`/bank-debts/${id}`, { query: { scope } }),
  });
}

/** Lịch trả nợ (gốc + lãi + phí) theo kỳ. */
export function useLoanSchedule(id: string | undefined) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['bank-debt-schedule', scope, id ?? ''],
    enabled: !!id,
    queryFn: () => apiData<LoanScheduleResult>(`/bank-debts/${id}/schedule`, { query: { scope } }),
  });
}

/** Phiếu khả dụng để gán: `disbursement` = phiếu thu cùng ngân hàng; `repayment` = phiếu chi cùng ngân hàng. */
export function useLoanCandidates(id: string | undefined, relation: 'disbursement' | 'repayment', q: string) {
  const { scope } = useAuth();
  return useQuery({
    queryKey: ['bank-debt-candidates', scope, id ?? '', relation, q],
    enabled: !!id,
    queryFn: () =>
      apiCall<{ items: DocCandidate[] }>(`/bank-debts/${id}/${relation}-candidates`, { query: { scope, q: q || undefined } }),
  });
}

export function useCreateLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoanCreateInput) => apiData<{ _id: string; code: string }>('/bank-debts', { method: 'POST', body }),
    onSuccess: () => invalidateKeys(qc, LOAN_KEYS),
  });
}

export function useUpdateLoan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoanUpdateInput) => apiData<{ changed?: string[] }>(`/bank-debts/${id}`, { method: 'PATCH', body }),
    onSuccess: () => invalidateKeys(qc, LOAN_KEYS),
  });
}

export function useDeleteLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiData<{ ok: boolean }>(`/bank-debts/${id}`, { method: 'DELETE' }),
    onSuccess: () => invalidateKeys(qc, LOAN_KEYS),
  });
}

/** Huỷ khoản đang chờ giải ngân (bắt buộc lý do ≥ 5 ký tự). */
export function useCancelLoan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) => apiData<{ ok: boolean; code: string }>(`/bank-debts/${id}/cancel`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      invalidateKeys(qc, LOAN_KEYS);
      invalidateKeys(qc, VOUCHER_KEYS);
    },
  });
}

export function useArchiveLoan(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiData<{ ok: boolean }>(`/bank-debts/${id}/archive`, { method: 'POST' }),
    onSuccess: () => invalidateKeys(qc, LOAN_KEYS),
  });
}

/** Gán phiếu thu giải ngân. Phiếu đã thực thi ⇒ khoản chuyển "Đang vay" (server). */
export function useAssignDisbursement(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { document_id: string; amount_minor?: string; note?: string }) =>
      apiData<{ _id: string }>(`/bank-debts/${id}/disbursements`, { method: 'POST', body }),
    onSuccess: () => {
      invalidateKeys(qc, LOAN_KEYS);
      invalidateKeys(qc, VOUCHER_KEYS);
    },
  });
}

/** Gán phiếu chi trả nợ, tách gốc / lãi / phí (tổng = số tiền). */
export function useAssignRepayment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { document_id: string; amount_minor: string; split: RepaymentSplit; note?: string }) =>
      apiData<{ _id: string }>(`/bank-debts/${id}/repayments`, { method: 'POST', body }),
    onSuccess: () => {
      invalidateKeys(qc, LOAN_KEYS);
      invalidateKeys(qc, VOUCHER_KEYS);
    },
  });
}

/** Gỡ liên kết giải ngân, trả nợ hoặc chi bằng vốn vay (đánh dấu đã gỡ, có lý do). */
export function useRemoveLoanLink(id: string, relation: 'disbursement' | 'repayment' | 'funded_by') {
  const qc = useQueryClient();
  const segment = relation === 'disbursement' ? 'disbursements' : relation === 'repayment' ? 'repayments' : 'funded-by';
  return useMutation({
    mutationFn: ({ linkId, reason }: { linkId: string; reason: string }) =>
      apiData<{ ok: boolean }>(`/bank-debts/${id}/${segment}/${linkId}`, { method: 'DELETE', body: { reason } }),
    onSuccess: () => {
      invalidateKeys(qc, LOAN_KEYS);
      invalidateKeys(qc, VOUCHER_KEYS);
    },
  });
}

/** Nhập khoản vay theo lô (đối tác chọn bằng mã DT-…; dòng lỗi báo riêng, không chặn cả lô). */
export function useImportLoans() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { company_id?: string; rows: Record<string, unknown>[] }) =>
      apiData<LoanImportResult>('/bank-debts/import', { method: 'POST', body }),
    onSuccess: () => invalidateKeys(qc, LOAN_KEYS),
  });
}

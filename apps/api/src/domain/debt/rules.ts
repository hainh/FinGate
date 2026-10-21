/**
 * Quy tắc THUẦN cho công nợ & nợ ngân hàng v2 (v2/v2.md §9, §10, §11.4) — không chạm DB.
 * Dùng chung cho route, luồng tự động (R2/R3/R6) và test.
 *
 * Quy ước:
 *  - Hướng khoản công nợ (`direction`) do người dùng chọn, KHÔNG suy ra từ loại đối tác.
 *    Phải thu ⇔ bút toán Nợ (`debit`); phải trả ⇔ Có (`credit`) — đúng cho cả TK 131 và 331 (M3b).
 *  - Cấn trừ: phiếu thu ↔ khoản phải thu; phiếu chi ↔ khoản phải trả.
 *  - Chỉ tiêu (đã cấn trừ / còn lại / quá hạn / trạng thái) luôn SUY RA, không lưu cứng.
 */

import { ACCOUNT_CODE_BY_PARTY, ApiError, daysBetween, maturity, maturityLabel, today } from '@fingate/shared';

export type DebtDirection = 'receivable' | 'payable';
export type DebtSide = 'debit' | 'credit';
export type DebtAgingBucket = 'none' | 'lt30' | 'd30_60' | 'd60_90' | 'gt90';
export type DebtFillStatus = 'open' | 'partial' | 'settled';
export type LoanStatus = 'pending_disbursement' | 'active' | 'overdue' | 'settled' | 'archived' | 'cancelled';

/** Loại đối tác hợp lệ cho khoản công nợ (v2 §5.1). */
export const DEBT_PARTNER_TYPES: readonly string[] = ['customer', 'supplier'];
/** Loại đối tác hợp lệ cho khoản nợ ngân hàng (v2 §5.1). */
export const LOAN_PARTNER_TYPES: readonly string[] = ['bank'];
/** Phiếu đã huỷ / hết hạn / từ chối: không cấn trừ, không trả nợ, không giải ngân. */
export const UNLINKABLE_DOC_STATUSES: readonly string[] = ['cancelled', 'expired', 'rejected'];

/** Hướng → bút toán Nợ/Có (phải thu = Nợ, phải trả = Có). */
export function sideForDirection(direction: DebtDirection): DebtSide {
  return direction === 'receivable' ? 'debit' : 'credit';
}

/**
 * Hướng hiệu lực của một khoản: ưu tiên `direction` (v2); bản ghi v1 chưa migrate (null) suy từ
 * bút toán (M3b: side = debit → phải thu, credit → phải trả).
 */
export function directionOf(d: { direction?: string | null; side?: string | null }): DebtDirection {
  if (d.direction === 'receivable' || d.direction === 'payable') return d.direction;
  return d.side === 'credit' ? 'payable' : 'receivable';
}

/**
 * Bút toán Nợ/Có hiệu lực. Bỏ trống ⇒ suy từ hướng; gửi lên mà lệch hướng ⇒ FG-VAL-001 (không âm thầm đổi).
 */
export function resolveSide(direction: DebtDirection, side?: string | null): DebtSide {
  const expected = sideForDirection(direction);
  if (side && side !== expected) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Bút toán Nợ/Có không khớp hướng khoản',
      errors: { side: direction === 'receivable' ? 'Phải thu ghi bên Nợ' : 'Phải trả ghi bên Có' },
    });
  }
  return expected;
}

/** Tài khoản kế toán tham chiếu theo loại đối tác: KH = 131, NCC = 331; loại khác = null. */
export function accountCodeOfPartnerType(partnerType: string): '131' | '331' | null {
  if (partnerType === 'customer' || partnerType === 'supplier') return ACCOUNT_CODE_BY_PARTY[partnerType] as '131' | '331';
  return null;
}

/** Khoản v1 của nhân viên (TK 334): chỉ đọc (v2 §9, M5). */
export function isReadOnlyDebt(partyType: string | null | undefined): boolean {
  return partyType === 'employee';
}

/** Loại phiếu được phép cấn trừ theo hướng: phải thu ↔ phiếu thu; phải trả ↔ phiếu chi. */
export function docKindForDirection(direction: DebtDirection): 'income' | 'spend' {
  return direction === 'receivable' ? 'income' : 'spend';
}

export function assertOffsetDirection(direction: DebtDirection, docKind: string | null | undefined): void {
  if (docKind === docKindForDirection(direction)) return;
  throw new ApiError({
    code: 'FG-LINK-001',
    detail: direction === 'receivable' ? 'Khoản phải thu chỉ cấn trừ bằng phiếu thu' : 'Khoản phải trả chỉ cấn trừ bằng phiếu chi',
  });
}

export function assertLinkableDocStatus(status: string | null | undefined): void {
  if (status && UNLINKABLE_DOC_STATUSES.includes(status)) {
    throw new ApiError({ code: 'FG-LINK-001', detail: 'Phiếu đã huỷ, từ chối hoặc hết hạn — không thể liên kết' });
  }
}

/** Nhóm tuổi nợ theo số ngày quá hạn (0 = chưa đến hạn). */
export function agingBucketOf(overdueDays: number): DebtAgingBucket {
  if (overdueDays <= 0) return 'none';
  if (overdueDays < 30) return 'lt30';
  if (overdueDays <= 60) return 'd30_60';
  if (overdueDays <= 90) return 'd60_90';
  return 'gt90';
}

export const AGING_BUCKET_LABEL: Record<DebtAgingBucket, string> = {
  none: 'Chưa đến hạn',
  lt30: 'Quá hạn < 30 ngày',
  d30_60: '30–60 ngày',
  d60_90: '60–90 ngày',
  gt90: '> 90 ngày',
};

export interface DebtFigures {
  value: bigint;
  /** Đã cấn trừ (chỉ phiếu đã thực thi). */
  applied: bigint;
  /** Còn phải thu / phải trả, không âm. */
  remaining: bigint;
  /** Số ngày quá hạn — chỉ khi còn dư và quá hạn; khoản đã tất toán không quá hạn. */
  overdue_days: number;
  aging_bucket: DebtAgingBucket;
  status: DebtFillStatus;
}

/** Chỉ tiêu suy ra của một khoản công nợ. `now` là ngày nghiệp vụ `YYYY-MM-DD` (mặc định: hôm nay VN). */
export function debtFigures(value: bigint, applied: bigint, dueDate: string, now: string = today()): DebtFigures {
  const remaining = value - applied > 0n ? value - applied : 0n;
  const overdue = remaining > 0n && dueDate < now ? daysBetween(dueDate, now) : 0;
  const status: DebtFillStatus = applied <= 0n ? 'open' : applied >= value ? 'settled' : 'partial';
  return { value, applied, remaining, overdue_days: overdue, aging_bucket: agingBucketOf(overdue), status };
}

/**
 * Trạng thái khoản nợ ngân hàng (v2 §10.2). Trạng thái vòng đời lưu trong DB (`pending_disbursement`,
 * `cancelled`, `archived`); `active` / `overdue` / `settled` suy ra từ dư nợ và hạn thanh toán.
 */
export function loanStatusOf(stored: string | null | undefined, outstanding: bigint, maturityDate: string, now: string = today()): LoanStatus {
  if (stored === 'cancelled') return 'cancelled';
  if (stored === 'pending_disbursement') return 'pending_disbursement';
  if (stored === 'archived') return 'archived';
  if (outstanding <= 0n) return 'settled';
  return maturityDate < now ? 'overdue' : 'active';
}

/** Chỉ khoản đang vay (đang hiệu lực) mới vào dư nợ và bảng đáo hạn (v2 §10.2). */
export function isLoanOnMaturityBoard(status: LoanStatus): boolean {
  return status === 'active' || status === 'overdue';
}

export interface LoanWarning {
  level: number;
  tone: string;
  bucket: string;
  label: string;
  days_to_due: number;
}

/** Mức cảnh báo đáo hạn (v2 §10.1: hôm nay / ≤3 ngày đỏ; 4–7 cam; 8–30 vàng) — dùng bảng `maturity()` chung. */
export function loanWarningOf(status: LoanStatus, maturityDate: string, now: string = today()): LoanWarning | null {
  if (!isLoanOnMaturityBoard(status)) return null;
  const days = daysBetween(now, maturityDate);
  const band = maturity(days);
  return { level: band.level, tone: band.tone, bucket: band.bucket, label: maturityLabel(days), days_to_due: days };
}

/** Ngày nghiệp vụ `YYYY-MM-DD` → mốc UTC đầu ngày theo giờ Việt Nam (UTC+7). */
export function businessDateStart(iso: string): Date {
  return new Date(`${iso}T00:00:00+07:00`);
}

/**
 * Số tiền phân bổ mặc định khi gán liên kết: không vượt phần còn lại của phiếu lẫn của đối tượng đích.
 * Không còn gì để phân bổ ⇒ FG-LINK-002.
 */
export function defaultAllocation(sourceRemaining: bigint, targetRemaining: bigint): bigint {
  const amount = sourceRemaining < targetRemaining ? sourceRemaining : targetRemaining;
  if (amount <= 0n) throw new ApiError({ code: 'FG-LINK-002', detail: 'Không còn số tiền để phân bổ' });
  return amount;
}

/** Tiền dạng wire (chuỗi minor units) — khớp `queries.wire`. */
export function wireMoney(minor: bigint, currency = 'VND'): { minor: string; currency: string; decimals: number } {
  return { minor: minor.toString(), currency, decimals: 0 };
}

/** Số tiền dương từ chuỗi minor units; sai định dạng hoặc ≤ 0 ⇒ FG-VAL-001. */
export function positiveMinor(raw: string | number | bigint, field: string, message = 'Số tiền phải lớn hơn 0'): bigint {
  let minor: bigint;
  try {
    minor = BigInt(String(raw));
  } catch {
    throw new ApiError({ code: 'FG-VAL-001', errors: { [field]: 'Số tiền không hợp lệ' } });
  }
  if (minor <= 0n) throw new ApiError({ code: 'FG-VAL-001', errors: { [field]: message } });
  return minor;
}

/** Mốc `*_at` (Date hoặc chuỗi) → ISO UTC; rỗng ⇒ null. */
export function isoOf(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Escape chuỗi cho biểu thức chính quy an toàn (tìm kiếm). */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Chỉ tiêu giải ngân của khoản vay (v2 §10.1–10.2), suy khi đọc:
 *  - Chờ giải ngân: đã giải ngân = tổng phiếu thu đã thực thi; chưa giải ngân = gốc − tổng đã gán.
 *  - Đang vay / quá hạn / tất toán / lưu trữ: không có liên kết giải ngân (khoản tạo tay, nhập lô) ⇒ đã giải ngân = gốc;
 *    có liên kết ⇒ đã giải ngân = tổng phiếu đã thực thi. Chưa giải ngân chỉ tính cho khoản chờ giải ngân.
 *  - Đã huỷ: không còn chỉ tiêu chưa giải ngân.
 */
export function disbursementFigures(input: {
  principal: bigint;
  status: string | null | undefined;
  /** Σ giải ngân đã thực thi (phiếu thu paid). */
  paid: bigint;
  /** Σ giải ngân đã gán (mọi trạng thái phiếu, liên kết hiệu lực). */
  planned: bigint;
  /** Số liên kết giải ngân hiệu lực. */
  linkCount: number;
}): { disbursed: bigint; undisbursed: bigint } {
  const { principal, status, paid, planned, linkCount } = input;
  if (status === 'pending_disbursement') {
    return { disbursed: paid, undisbursed: principal > planned ? principal - planned : 0n };
  }
  if (status === 'cancelled') return { disbursed: paid, undisbursed: 0n };
  return { disbursed: linkCount === 0 ? principal : paid, undisbursed: 0n };
}

/** Giá trị vô hướng để ghi lịch sử trước → sau (chuỗi; null = trống). */
export function scalarOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const s = String(v);
    return s === '[object Object]' ? JSON.stringify(v) : s;
  }
  return String(v);
}

/**
 * Các trường đổi giữa trước và sau (v2 §2.3: lịch sử ghi trước → sau). Chỉ so các khoá có trong `after`;
 * bỏ `updated_at`. Trả về `{ field: { from, to } }`.
 */
export function changesOf(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: string | null; to: string | null }> {
  const out: Record<string, { from: string | null; to: string | null }> = {};
  for (const key of Object.keys(after)) {
    if (key === 'updated_at') continue;
    const from = scalarOf(before[key]);
    const to = scalarOf(after[key]);
    if (from !== to) out[key] = { from, to };
  }
  return out;
}

/** Hạn thanh toán phải sau ngày giải ngân (ngày nghiệp vụ `YYYY-MM-DD`); bỏ qua khi chưa có ngày giải ngân. */
export function assertMaturityAfterDisbursement(maturityDate: string, disbursedDate: string | null | undefined): void {
  if (disbursedDate && maturityDate <= disbursedDate) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Hạn thanh toán phải sau ngày giải ngân',
      errors: { maturity_date: 'Phải sau ngày giải ngân' },
    });
  }
}

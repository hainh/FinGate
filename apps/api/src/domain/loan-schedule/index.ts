/**
 * Lịch nghĩa vụ trả nợ (LOAN-04) — suy từ lãi suất + kỳ hạn + kỳ trả (blueprint §IX).
 *
 * Lãi đơn, cơ sở 365 ngày (thông lệ khoản vay ngắn hạn VN). KHÔNG phải bút toán kế toán;
 * chỉ là kế hoạch dòng tiền để chuẩn bị nguồn trả nợ.
 *   · `interest_only`   — trả lãi định kỳ, gốc trả một lần cuối kỳ (mặc định).
 *   · `equal_principal` — chia đều gốc mỗi kỳ, lãi tính trên dư nợ còn lại.
 */

import { daysBetween } from '@fingate/shared';
import type { RepaymentFrequency, RepaymentMethod } from '@fingate/shared';

export interface ScheduleInput {
  principalMinor: bigint;
  rate: string | number | null | undefined;
  maturityDate: string;
  startDate: string;
  frequency: RepaymentFrequency;
  method: RepaymentMethod;
}

export interface ScheduleEntry {
  period: number;
  due_date: string;
  days: number;
  principal: bigint;
  interest: bigint;
  fee: bigint;
  total: bigint;
}

export interface ScheduleResult {
  rows: ScheduleEntry[];
  totals: { principal: bigint; interest: bigint; fee: bigint; total: bigint };
}

/** "9,5" | "9.5" → 9.5 (%/năm). */
export function parseRate(rate: string | number | null | undefined): number {
  const n = Number(String(rate ?? '0').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Cộng `months` tháng, kẹp ngày cuối tháng (31/01 + 1 → 28/02). */
export function addMonths(iso: string, months: number): string {
  const parts = iso.slice(0, 10).split('-');
  const y = Number(parts[0] ?? 1970);
  const m = Number(parts[1] ?? 1);
  const d = Number(parts[2] ?? 1);
  const base = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** Lãi đơn `principal × rate% × days/365`, làm tròn nửa lên. */
export function simpleInterest(principal: bigint, ratePct: number, days: number): bigint {
  if (principal <= 0n || ratePct <= 0 || days <= 0) return 0n;
  const num = principal * BigInt(Math.round(ratePct * 10_000)) * BigInt(days);
  const den = 100n * 10_000n * 365n;
  return (num + den / 2n) / den;
}

const FREQ_MONTHS: Record<RepaymentFrequency, number> = { monthly: 1, quarterly: 3, semiannual: 6, maturity: 0 };

/** Các ngày đến hạn của lịch gốc: đều theo tần suất từ ngày bắt đầu; kỳ cuối = ngày đáo hạn. */
function duesOf(input: Pick<ScheduleInput, 'frequency' | 'startDate' | 'maturityDate'>): string[] {
  const stepMonths = FREQ_MONTHS[input.frequency] ?? 0;
  const { maturityDate, startDate } = input;
  const dues: string[] = [];
  if (stepMonths === 0 || startDate >= maturityDate) {
    dues.push(maturityDate);
  } else {
    let cur = addMonths(startDate, stepMonths);
    let guard = 0;
    while (cur < maturityDate && guard++ < 600) {
      dues.push(cur);
      cur = addMonths(cur, stepMonths);
    }
    if (dues[dues.length - 1] !== maturityDate) dues.push(maturityDate);
  }
  return dues;
}

/** Dựng dòng lịch cho các kỳ `dues` với gốc `principal`; kỳ đầu tính lãi từ `prevDate`. */
function rowsFor(args: {
  dues: string[];
  prevDate: string;
  principal: bigint;
  rate: number;
  method: RepaymentMethod;
  firstPeriod: number;
}): ScheduleResult {
  const { dues, principal, rate, method, firstPeriod } = args;
  const periods = dues.length;
  const equalPrincipal = method === 'equal_principal' && periods > 0 ? principal / BigInt(periods) : 0n;
  const rows: ScheduleEntry[] = [];
  let remaining = principal;
  let allocated = 0n;
  let prev = args.prevDate;
  let totalInterest = 0n;
  let totalPrincipal = 0n;

  for (let i = 0; i < periods; i++) {
    const due = dues[i]!;
    const days = Math.max(0, daysBetween(prev, due));
    const interest = simpleInterest(remaining, rate, days);
    let principalDue: bigint;
    if (method === 'equal_principal') {
      principalDue = i === periods - 1 ? principal - allocated : equalPrincipal;
      allocated += principalDue;
    } else {
      principalDue = i === periods - 1 ? principal : 0n;
    }
    remaining = remaining - principalDue > 0n ? remaining - principalDue : 0n;
    rows.push({ period: firstPeriod + i, due_date: due, days, principal: principalDue, interest, fee: 0n, total: principalDue + interest });
    totalInterest += interest;
    totalPrincipal += principalDue;
    prev = due;
  }

  return {
    rows,
    totals: { principal: totalPrincipal, interest: totalInterest, fee: 0n, total: totalPrincipal + totalInterest },
  };
}

export function buildSchedule(input: ScheduleInput): ScheduleResult {
  return rowsFor({
    dues: duesOf(input),
    prevDate: input.startDate,
    principal: input.principalMinor,
    rate: typeof input.rate === 'number' ? input.rate : parseRate(input.rate),
    method: input.method,
    firstPeriod: 1,
  });
}

/** Đầu vào lịch còn lại: `principalMinor` là GỐC BAN ĐẦU, `repaidPrincipalMinor` là gốc đã trả. */
export interface RemainingScheduleInput extends ScheduleInput {
  repaidPrincipalMinor: bigint;
}

/**
 * Lịch CÒN LẠI sau khi đã trả một phần gốc — dự báo dòng tiền (v2 §12, §10.3).
 *  · `interest_only` (hoặc chưa trả gốc): dư nợ còn lại theo đúng các kỳ của lịch gốc.
 *  · `equal_principal`: kỳ đã trả = các kỳ mà gốc đã trả phủ hết theo lịch gốc. Phần gốc còn lại
 *    chia đều cho SỐ KỲ CÒN LẠI (không chia lại theo lịch gốc đầy đủ); kỳ đầu tính lãi từ kỳ đã trả gần nhất.
 */
export function buildRemainingSchedule(input: RemainingScheduleInput): ScheduleResult {
  const rate = typeof input.rate === 'number' ? input.rate : parseRate(input.rate);
  const repaid = input.repaidPrincipalMinor > 0n ? input.repaidPrincipalMinor : 0n;
  const outstanding = input.principalMinor > repaid ? input.principalMinor - repaid : 0n;
  if (outstanding <= 0n) return { rows: [], totals: { principal: 0n, interest: 0n, fee: 0n, total: 0n } };
  const dues = duesOf(input);
  if (input.method !== 'equal_principal' || repaid === 0n) {
    return rowsFor({ dues, prevDate: input.startDate, principal: outstanding, rate, method: input.method, firstPeriod: 1 });
  }
  const original = rowsFor({ dues, prevDate: input.startDate, principal: input.principalMinor, rate, method: 'equal_principal', firstPeriod: 1 });
  let paid = 0;
  let covered = 0n;
  for (const row of original.rows) {
    if (covered + row.principal > repaid) break;
    covered += row.principal;
    paid++;
  }
  // Gốc ban đầu luôn > gốc đã trả (outstanding > 0) nên luôn còn ít nhất một kỳ.
  const prevDate = paid > 0 ? dues[paid - 1]! : input.startDate;
  return rowsFor({ dues: dues.slice(paid), prevDate, principal: outstanding, rate, method: 'equal_principal', firstPeriod: paid + 1 });
}

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

export function buildSchedule(input: ScheduleInput): ScheduleResult {
  const rate = typeof input.rate === 'number' ? input.rate : parseRate(input.rate);
  const { principalMinor: principal, maturityDate, startDate } = input;
  const stepMonths = FREQ_MONTHS[input.frequency] ?? 0;

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

  const periods = dues.length;
  const equalPrincipal = input.method === 'equal_principal' && periods > 0 ? principal / BigInt(periods) : 0n;
  const rows: ScheduleEntry[] = [];
  let remaining = principal;
  let allocated = 0n;
  let prev = startDate;
  let totalInterest = 0n;
  let totalPrincipal = 0n;

  for (let i = 0; i < periods; i++) {
    const due = dues[i]!;
    const days = Math.max(0, daysBetween(prev, due));
    const interest = simpleInterest(remaining, rate, days);
    let principalDue: bigint;
    if (input.method === 'equal_principal') {
      principalDue = i === periods - 1 ? principal - allocated : equalPrincipal;
      allocated += principalDue;
    } else {
      principalDue = i === periods - 1 ? principal : 0n;
    }
    remaining = remaining - principalDue > 0n ? remaining - principalDue : 0n;
    rows.push({ period: i + 1, due_date: due, days, principal: principalDue, interest, fee: 0n, total: principalDue + interest });
    totalInterest += interest;
    totalPrincipal += principalDue;
    prev = due;
  }

  return {
    rows,
    totals: { principal: totalPrincipal, interest: totalInterest, fee: 0n, total: totalPrincipal + totalInterest },
  };
}

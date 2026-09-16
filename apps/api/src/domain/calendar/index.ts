/**
 * Lịch làm việc & SLA (architecture §9.1) — `sla_deadline = previous + sla_hours`
 * TRỪ ngày nghỉ theo `Company.working_calendar` (BA-6).
 *
 * Mọi phép tính ngày đi qua `vnDate` — không dùng `new Date().getDate()` (arch §16).
 */

import { addDays, daysBetween, vnDate } from '@fingate/shared';

export interface WorkingCalendar {
  /** 0 = CN … 6 = T7. Mặc định T2–T7 như công ty VN (T7 vẫn làm). */
  workdays: number[];
  /** `YYYY-MM-DD` — nghỉ lễ, Tết. */
  holidays: string[];
}

export const DEFAULT_CALENDAR: WorkingCalendar = { workdays: [1, 2, 3, 4, 5, 6], holidays: [] };

function dowOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

export function isWorkingDay(iso: string, cal: WorkingCalendar = DEFAULT_CALENDAR): boolean {
  if (cal.holidays.includes(iso)) return false;
  return (cal.workdays ?? DEFAULT_CALENDAR.workdays).includes(dowOf(iso));
}

/** Ngày làm việc kế tiếp >= `from` (nếu `from` là ngày nghỉ thì nhảy tới ngày làm việc đầu). */
export function nextWorkingDay(fromIso: string, cal: WorkingCalendar = DEFAULT_CALENDAR): string {
  let cursor = fromIso;
  for (let i = 0; i < 400; i++) {
    if (isWorkingDay(cursor, cal)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return fromIso;
}

export function addWorkingDays(fromIso: string, n: number, cal: WorkingCalendar = DEFAULT_CALENDAR): string {
  let cursor = fromIso;
  let left = n;
  while (left > 0) {
    cursor = addDays(cursor, 1);
    if (isWorkingDay(cursor, cal)) left--;
  }
  return cursor;
}

export function countWorkingDays(aIso: string, bIso: string, cal: WorkingCalendar = DEFAULT_CALENDAR): number {
  const total = daysBetween(aIso, bIso);
  let n = 0;
  for (let i = 1; i <= total; i++) if (isWorkingDay(addDays(aIso, i), cal)) n++;
  return n;
}

/**
 * Hạn SLA của một bước: `sla_hours` là giờ làm việc (8h/ngày làm việc).
 * Trả về Date UTC — dùng cho `approval.steps[].sla_deadline`.
 */
export function slaDeadline(from: Date, slaHours: number, cal: WorkingCalendar = DEFAULT_CALENDAR): Date {
  let remaining = Math.max(1, Math.round(slaHours));
  let day = vnDate(from);
  // giờ còn lại trong ngày làm việc hiện tại
  if (!isWorkingDay(day, cal)) day = nextWorkingDay(day, cal);
  const startOfBusiness = new Date(`${day}T02:00:00Z`); // 09:00 VN = 02:00 UTC
  let cursor = from < startOfBusiness ? startOfBusiness : from;
  while (remaining > 0) {
    const endOfDay = new Date(`${day}T09:00:00Z`); // 17:00 VN = 09:00 UTC
    const hoursLeftToday = (endOfDay.getTime() - cursor.getTime()) / 3_600_000;
    if (hoursLeftToday >= remaining) {
      return new Date(cursor.getTime() + remaining * 3_600_000);
    }
    remaining -= Math.max(0, hoursLeftToday);
    day = nextWorkingDay(addDays(day, 1), cal);
    cursor = new Date(`${day}T02:00:00Z`);
  }
  return cursor;
}

/** Số ngày một hồ sơ "nằm trên bàn" ai đó — luôn hiện trong UI (DS §1.5). */
export function waitingDays(since: Date | string | null | undefined, now: Date = new Date()): number {
  if (!since) return 0;
  const at = since instanceof Date ? since : new Date(since);
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 86_400_000));
}

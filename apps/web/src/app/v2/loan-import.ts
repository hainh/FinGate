/**
 * Nhập lô khoản vay (.tsv, v2 §10.3): đọc ngày dd/mm/yyyy hoặc yyyy-mm-dd — ngày không có thật trên lịch
 * (31/02, 31/13) là lỗi, không để JS tràn sang tháng sau (trước đây 31/13/2030 thành 31/01/2031).
 */

/** Ngày có thật trên lịch (31/02, 31/13 là KHÔNG hợp lệ — không để JS tràn sang tháng sau). */
export function isRealCalendarDate(y: number, mo: number, d: number): boolean {
  if (!Number.isInteger(y) || mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** `09/12/2027` (ng/th/năm) hoặc `2027-12-09` → `YYYY-MM-DD`; ngày không tồn tại → null. */
export function parseVnDate(text: string): string | null {
  const t = text.trim();
  let y: number;
  let mo: number;
  let d: number;
  let m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(t);
  if (m) {
    d = Number(m[1]);
    mo = Number(m[2]);
    y = Number(m[3]);
  } else {
    m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(t);
    if (!m) return null;
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
  }
  if (!isRealCalendarDate(y, mo, d)) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}


import { describe, expect, it } from 'vitest';
import { isRealCalendarDate, parseVnDate } from './loan-import.ts';

describe('parseVnDate — ngày nhập lô khoản vay (LOAN-05)', () => {
  it('dd/mm/yyyy và yyyy-mm-dd hợp lệ ⇒ YYYY-MM-DD', () => {
    expect(parseVnDate('09/12/2027')).toBe('2027-12-09');
    expect(parseVnDate('9-2-2028')).toBe('2028-02-09');
    expect(parseVnDate('2027-12-09')).toBe('2027-12-09');
    expect(parseVnDate('29/02/2028')).toBe('2028-02-29'); // năm nhuận
  });

  it('tháng 13 / ngày 31 của tháng 30 ngày / 29-02 năm thường ⇒ không hợp lệ (không tràn sang tháng sau)', () => {
    expect(parseVnDate('31/13/2030')).toBeNull();
    expect(parseVnDate('31/04/2030')).toBeNull();
    expect(parseVnDate('29/02/2027')).toBeNull();
    expect(parseVnDate('2030-13-31')).toBeNull();
  });

  it('chuỗi không phải ngày ⇒ null', () => {
    expect(parseVnDate('')).toBeNull();
    expect(parseVnDate('abc')).toBeNull();
    expect(parseVnDate('00/01/2030')).toBeNull();
  });
});

describe('isRealCalendarDate', () => {
  it('nhận đúng ngày có thật, từ chối ngày tràn', () => {
    expect(isRealCalendarDate(2028, 2, 29)).toBe(true);
    expect(isRealCalendarDate(2027, 2, 29)).toBe(false);
    expect(isRealCalendarDate(2030, 12, 31)).toBe(true);
    expect(isRealCalendarDate(2030, 0, 1)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { filterMaturityRows, type MaturityRow } from './index.ts';

/** Dòng bảng đáo hạn tối thiểu cho bộ lọc (các trường khác không dùng ở đây). */
const row = (bank: string, days: number): MaturityRow => ({ bank_name: bank, days_to_due: days }) as unknown as MaturityRow;

const rows = [row('NH Á Châu', -2), row('ACB', 2), row('Vietcombank', 5), row('BIDV', 20), row('Techcom', 60)];

describe('filterMaturityRows — bảng đáo hạn lọc trên MỘT lần dựng (KPI và bảng dùng chung, RENEW-01)', () => {
  it('không lọc ⇒ giữ nguyên mọi dòng', () => {
    expect(filterMaturityRows(rows)).toHaveLength(5);
    expect(filterMaturityRows(rows, {})).toHaveLength(5);
  });

  it('theo ngân hàng: chứa chuỗi, không phân biệt hoa thường', () => {
    expect(filterMaturityRows(rows, { bankName: 'acb' }).map((r) => r.bank_name)).toEqual(['ACB']);
    expect(filterMaturityRows(rows, { bankName: 'NH' }).map((r) => r.bank_name)).toEqual(['NH Á Châu']);
  });

  it('theo mức đáo hạn: hôm nay / 3 ngày / 7 ngày / 30 ngày / sau 30 ngày', () => {
    expect(filterMaturityRows(rows, { bucket: 'today' }).map((r) => r.bank_name)).toEqual(['NH Á Châu']);
    expect(filterMaturityRows(rows, { bucket: '3d' }).map((r) => r.bank_name)).toEqual(['ACB']);
    expect(filterMaturityRows(rows, { bucket: '7d' }).map((r) => r.bank_name)).toEqual(['Vietcombank']);
    expect(filterMaturityRows(rows, { bucket: '30d' }).map((r) => r.bank_name)).toEqual(['BIDV']);
    expect(filterMaturityRows(rows, { bucket: 'later' }).map((r) => r.bank_name)).toEqual(['Techcom']);
  });

  it('mức không xác định ⇒ không lọc theo mức; kết hợp ngân hàng + mức', () => {
    expect(filterMaturityRows(rows, { bucket: 'khong-co' })).toHaveLength(5);
    expect(filterMaturityRows(rows, { bankName: 'b', bucket: '30d' }).map((r) => r.bank_name)).toEqual(['BIDV']);
    expect(filterMaturityRows(rows, { bankName: 'acb', bucket: '30d' })).toEqual([]);
  });
});

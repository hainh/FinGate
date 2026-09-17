import { describe, expect, it } from 'vitest';
import {
  add,
  convert,
  daysBetween,
  divRound,
  formatMoney,
  formatMoneyOrMissing,
  formatMoneyTyping,
  MISSING,
  money,
  moneyAria,
  moneyInputValue,
  normalizeViNumber,
  num,
  parseMoneyInput,
  pct,
  percentOf,
  ratioOf,
  sum,
  sub,
  vnDate,
  weekdayDate,
  ddmmyyyy,
  addDays,
  shortDate,
} from '../src/money/index.js';

const VND = (minor: string | bigint | number) => money(minor, 'VND');

describe('money — minor units là số nguyên, không float', () => {
  it('accept string | bigint | safe integer', () => {
    expect(money('2500000000').minor).toBe(2500000000n);
    expect(money(2500000000).minor).toBe(2500000000n);
    expect(money(25n).minor).toBe(25n);
    expect(money({ minor: '100', currency: 'USD' }).decimals).toBe(2);
  });

  it('chối float và chuỗi lẻ', () => {
    expect(() => money(2.5)).toThrow(TypeError);
    expect(() => money('2,5 tỷ')).toThrow(TypeError);
    expect(() => money('1e9')).toThrow(TypeError);
  });

  it('cấm cộng trừ khác loại tiền', () => {
    expect(() => add(VND('1'), money('1', 'USD'))).toThrow(TypeError);
    expect(add(VND('1'), VND('2')).minor).toBe(3n);
    expect(sub(VND('1'), VND('2')).minor).toBe(-1n);
    expect(sum([VND('1'), VND('2'), VND('3')]).minor).toBe(6n);
  });

  it('BigInt math không sai số ở quy mô vượt Number.MAX_SAFE_INTEGER', () => {
    const odd = money(9007199254740993n); // 2^53 + 1 — float không biểu diễn được
    const doubled = add(odd, odd);
    expect(doubled.minor).toBe(18014398509481986n);
    // chứng minh lý do dùng BigInt: double sẽ làm tròn thành …984
    expect(Number(doubled.minor)).toBe(18014398509481984);
  });
});

describe('formatMoney — chuẩn vi-VN (DS §4.1)', () => {
  it('full: dấu chấm phân cách nghìn + ₫', () => {
    expect(formatMoney(VND('2500000000'), { mode: 'full' })).toBe('2.500.000.000\u00a0₫');
    expect(formatMoney(VND(0))).toBe('0\u00a0₫');
  });

  it('compact: tỷ / tr / nghìn tỷ, dấu phẩy thập phân', () => {
    expect(formatMoney(VND('2500000000'), { mode: 'compact' })).toBe('2,50\u00a0tỷ');
    expect(formatMoney(VND('850000000'), { mode: 'compact' })).toBe('850\u00a0tr');
    expect(formatMoney(VND('125600000000'), { mode: 'compact' })).toBe('125,60\u00a0tỷ');
    expect(formatMoney(VND('1500000000000'), { mode: 'compact' })).toBe('1,50\u00a0nghìn tỷ');
    expect(formatMoney(VND('999999'), { mode: 'compact' })).toBe('999.999\u00a0₫');
  });

  it('kpi: ≥100 tỷ còn 1 chữ số', () => {
    expect(formatMoney(VND('125600000000'), { mode: 'kpi' })).toBe('125,6\u00a0tỷ');
    expect(formatMoney(VND('12560000000'), { mode: 'kpi' })).toBe('12,56\u00a0tỷ');
  });

  it('số âm dùng U+2212, không dùng ASCII minus', () => {
    const out = formatMoney(VND('-4000000000'), { mode: 'compact' });
    expect(out).toBe('\u22124,00\u00a0tỷ');
    expect(out).not.toContain('-');
  });

  it('ngoại tệ giữ 2 chữ số + mã tiền tệ', () => {
    expect(formatMoney(money('2500000', 'USD'), { mode: 'full' })).toBe('25.000,00\u00a0USD');
    expect(formatMoney(money('2500000', 'USD'), { mode: 'compact' })).toBe('25.000,00\u00a0USD');
  });

  it('phân biệt 0 và chưa có dữ liệu', () => {
    expect(formatMoneyOrMissing(null)).toBe(MISSING);
    expect(formatMoneyOrMissing(VND(0), { mode: 'compact' })).toBe('0\u00a0₫');
  });

  it('screen reader đọc được', () => {
    expect(moneyAria(VND('2500000000'))).toContain('2.500.000.000');
  });
});

describe('parseMoneyInput — gõ tay & paste Excel (DS §7.6)', () => {
  const cases: [string, string][] = [
    ['2500000000', '2500000000'],
    ['2.500.000.000', '2500000000'],
    ['2,5 tỷ', '2500000000'],
    ['2,50tỷ', '2500000000'],
    ['850 tr', '850000000'],
    ['850triệu', '850000000'],
    ['1,2 nghìn tỷ', '1200000000000'],
    ['1.000', '1000'],
    ['123', '123'],
    ['0', '0'],
  ];
  it.each(cases)('%s → %s', (input, expected) => {
    expect(parseMoneyInput(input).minor).toBe(BigInt(expected));
  });

  it('giữ dấu âm', () => {
    expect(parseMoneyInput('\u22121,2 tỷ').minor).toBe(-1200000000n);
    expect(parseMoneyInput('-850 tr').minor).toBe(-850000000n);
  });

  it('roundtrip với formatMoney (compact → parse)', () => {
    for (const v of ['1', '999999', '1000000', '850000000', '2500000000', '125600000000']) {
      expect(parseMoneyInput(formatMoney(VND(v), { mode: 'compact' })).minor).toBe(BigInt(v));
    }
  });

  it('normalizeViNumber phân biệt đúng dấu', () => {
    expect(normalizeViNumber('2.500.000.000')).toBe('2500000000');
    expect(normalizeViNumber('2,5')).toBe('2.5');
    expect(normalizeViNumber('1.234,5')).toBe('1234.5');
    expect(normalizeViNumber('2.5')).toBe('2.5'); // không phải nhóm 3 → thập phân
  });

  it('báo lỗi rõ ràng khi không hiểu', () => {
    expect(() => parseMoneyInput('abc')).toThrow(TypeError);
  });
});

describe('formatMoneyTyping — nhóm nghìn ngay khi gõ (cho nhập số dài)', () => {
  it('nhóm chữ số thành từng cụm 3', () => {
    expect(formatMoneyTyping('2500')).toBe('2.500');
    expect(formatMoneyTyping('25000')).toBe('25.000');
    expect(formatMoneyTyping('2500000000')).toBe('2.500.000.000');
    expect(formatMoneyTyping('2.5000')).toBe('25.000'); // gõ nối tiếp sau khi đã nhóm
  });

  it('giữ nguyên khi có dấu phẩy thập phân hoặc đơn vị', () => {
    expect(formatMoneyTyping('2,5')).toBe('2,5');
    expect(formatMoneyTyping('2,5 tỷ')).toBe('2,5 tỷ');
    expect(formatMoneyTyping('850 tr')).toBe('850 tr');
  });

  it('roundtrip: gõ dài → nhóm → parse không mất giá trị', () => {
    for (const v of ['2500000000', '12345678901', '999999999999999999999']) {
      const grouped = formatMoneyTyping(v);
      expect(parseMoneyInput(grouped).minor).toBe(BigInt(v));
    }
  });

  it('chuỗi rỗng / không có chữ số trả nguyên văn', () => {
    expect(formatMoneyTyping('')).toBe('');
    expect(formatMoneyTyping('  ')).toBe('  ');
    expect(formatMoneyTyping('-')).toBe('-');
  });
});

describe('tỷ giá & phần trăm — không dùng float để tính tiền', () => {
  it('divRound half-up cho số dương và âm', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(4n, 2n)).toBe(2n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(1n, 3n)).toBe(0n);
  });

  it('convert USD→VND theo rate 26310.50', () => {
    const usd = money('2500000', 'USD'); // 25.000,00 USD
    const vnd = convert(usd, '26310.50', 'VND');
    expect(vnd.minor).toBe(657762500n);
    expect(vnd.currency).toBe('VND');
    expect(formatMoney(vnd, { mode: 'compact' })).toBe('657,76\u00a0tr');
    expect(formatMoney(vnd, { mode: 'full' })).toBe('657.762.500\u00a0₫');
  });

  it('percentOf làm tròn về minor unit', () => {
    expect(percentOf(VND('1000000000'), '7.5').minor).toBe(75000000n);
    expect(percentOf(VND('1'), '50').minor).toBe(1n); // 0.5 → half-up = 1
  });

  it('ratioOf chỉ để hiển thị', () => {
    expect(ratioOf(VND('2500000000'), VND('10000000000'))).toBe(25);
    expect(ratioOf(VND('1'), VND('0'))).toBe(0);
    expect(pct(8.39)).toBe('+8,4%');
    expect(pct(-8.39)).toBe('\u22128,4%');
  });
});

describe('ngày nghiệp vụ Asia/Ho_Chi_Minh (architecture §16)', () => {
  it('vnDate không dùng ngày của máy chủ UTC', () => {
    // 2026-09-07T18:00:00Z = 2026-09-08 01:00 VN
    expect(vnDate(new Date('2026-09-07T18:00:00Z'))).toBe('2026-09-08');
    expect(vnDate('2026-09-07T16:59:00Z')).toBe('2026-09-07');
    expect(ddmmyyyy('2026-09-07T18:00:00Z')).toBe('08/09/2026');
  });

  it('daysBetween / addDays theo ngày lịch', () => {
    expect(daysBetween('2026-09-08', '2026-09-10')).toBe(2);
    expect(daysBetween('2026-09-10', '2026-09-08')).toBe(-2);
    expect(addDays('2026-12-30', 5)).toBe('2027-01-04');
  });

  it('weekday Date cho bảng forecast', () => {
    expect(weekdayDate('2026-09-08')).toMatch(/^T\d{1,2}|CN \d{2}\/\d{2}$/);
    expect(shortDate('2026-09-08', new Date('2026-09-09T00:00:00Z'))).toBe('08/09');
    expect(shortDate('2025-09-08', new Date('2026-09-09T00:00:00Z'))).toBe('08/09/2025');
  });

  it('num() dùng phân cách nghìn kiểu Việt', () => {
    expect(num(1284)).toBe('1.284');
    expect(num(1234567n)).toBe('1.234.567');
  });

  it('moneyInputValue hiển thị theo nhóm', () => {
    expect(moneyInputValue(VND('2500000000'))).toBe('2.500.000.000');
  });
});

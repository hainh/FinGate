import { describe, expect, it } from 'vitest';
import { debtAgingBucket, debtStatus, toBigInt } from './index.ts';

describe('debt › chuẩn hoá & trạng thái', () => {
  it('chuẩn hoá số tiền từ Mongo (chuỗi/số) về BigInt', () => {
    expect(toBigInt('123')).toBe(123n);
    expect(toBigInt(45)).toBe(45n);
    expect(toBigInt('abc')).toBe(0n);
  });

  it('trạng thái công nợ theo mức đã cấn trừ', () => {
    expect(debtStatus(100n, 0n)).toBe('open');
    expect(debtStatus(100n, 40n)).toBe('partial');
    expect(debtStatus(100n, 100n)).toBe('settled');
  });

  it('tuổi nợ theo số ngày quá hạn', () => {
    expect(debtAgingBucket(0)).toBe('none');
    expect(debtAgingBucket(10)).toBe('lt30');
    expect(debtAgingBucket(45)).toBe('d30_60');
    expect(debtAgingBucket(75)).toBe('d60_90');
    expect(debtAgingBucket(120)).toBe('gt90');
  });
});

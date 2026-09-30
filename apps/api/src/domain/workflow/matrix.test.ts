import { describe, expect, it } from 'vitest';
import { resolveChairmanThreshold, type ChairmanThresholdConfig } from './matrix.ts';

const COMPANY_A = 'a'.repeat(24);
const COMPANY_B = 'b'.repeat(24);

describe('resolveChairmanThreshold — ngưỡng Chairman theo (công ty × loại hồ sơ)', () => {
  it('không có cấu hình → rơi về hằng số mặc định', () => {
    expect(resolveChairmanThreshold(null, COMPANY_A, 'spend')).toBe(5_000_000_000n);
    expect(resolveChairmanThreshold({}, null, 'income')).toBe(5_000_000_000n);
  });

  it('ngưỡng chung áp cho mọi công ty và mọi loại hồ sơ', () => {
    const cfg: ChairmanThresholdConfig = { amount_minor: '7000000000' };
    expect(resolveChairmanThreshold(cfg, COMPANY_A, 'spend')).toBe(7_000_000_000n);
    expect(resolveChairmanThreshold(cfg, COMPANY_B, 'internal')).toBe(7_000_000_000n);
  });

  it('ngưỡng theo loại hồ sơ thắng ngưỡng chung', () => {
    const cfg: ChairmanThresholdConfig = { amount_minor: '7000000000', by_kind: { spend: '9000000000' } };
    expect(resolveChairmanThreshold(cfg, COMPANY_A, 'spend')).toBe(9_000_000_000n);
    expect(resolveChairmanThreshold(cfg, COMPANY_A, 'income')).toBe(7_000_000_000n);
  });

  it('override công ty thắng ngưỡng chung theo loại', () => {
    const cfg: ChairmanThresholdConfig = {
      amount_minor: '7000000000',
      by_kind: { spend: '9000000000' },
      companies: { [COMPANY_A]: { amount_minor: '3000000000' } },
    };
    expect(resolveChairmanThreshold(cfg, COMPANY_A, 'spend')).toBe(3_000_000_000n);
    expect(resolveChairmanThreshold(cfg, COMPANY_B, 'spend')).toBe(9_000_000_000n);
  });

  it('override (công ty, loại) là cấp cụ thể nhất', () => {
    const cfg: ChairmanThresholdConfig = {
      amount_minor: '7000000000',
      by_kind: { spend: '9000000000' },
      companies: { [COMPANY_A]: { amount_minor: '3000000000', by_kind: { spend: '1500000000' } } },
    };
    expect(resolveChairmanThreshold(cfg, COMPANY_A, 'spend')).toBe(1_500_000_000n);
    expect(resolveChairmanThreshold(cfg, COMPANY_A, 'income')).toBe(3_000_000_000n);
  });

  it('giá trị null/"" = bỏ override, kế thừa cấp ngoài', () => {
    const cfg: ChairmanThresholdConfig = {
      amount_minor: '7000000000',
      companies: { [COMPANY_A]: { amount_minor: null, by_kind: { spend: '' } } },
    };
    expect(resolveChairmanThreshold(cfg, COMPANY_A, 'spend')).toBe(7_000_000_000n);
  });

  it('tương thích dữ liệu cũ: doc toàn cục khoá theo company_id chỉ áp đúng công ty đó', () => {
    const legacy: ChairmanThresholdConfig = { amount_minor: '2000000000', company_id: COMPANY_A };
    expect(resolveChairmanThreshold(legacy, COMPANY_A, 'spend')).toBe(2_000_000_000n);
    expect(resolveChairmanThreshold(legacy, COMPANY_B, 'spend')).toBe(5_000_000_000n);
  });
});

import { describe, expect, it } from 'vitest';
import { defaultStepsFor, resolveChairmanThreshold, type ChairmanThresholdConfig } from './matrix.ts';

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

describe('defaultStepsFor — chuỗi mặc định theo khoảng tiền (v2 §7.2)', () => {
  const roles = (kind: Parameters<typeof defaultStepsFor>[0], amount: bigint) =>
    defaultStepsFor(kind, amount).steps.map((s) => s.role);

  it('phiếu chi dưới 50 triệu: KTT → PGĐ', () => {
    expect(roles('spend', 49_999_999n)).toEqual(['chief_accountant', 'deputy_director']);
  });

  it('phiếu chi 50 triệu – 5 tỷ (gồm cận dưới và cận 5 tỷ): KTT → PGĐ → GĐ, không P.TGĐ', () => {
    expect(roles('spend', 50_000_000n)).toEqual(['chief_accountant', 'deputy_director', 'director']);
    expect(roles('spend', 5_000_000_000n)).toEqual(['chief_accountant', 'deputy_director', 'director']);
  });

  it('phiếu chi trên 5 tỷ: KTT → PGĐ → GĐ → P.TGĐ (Chủ tịch do withChairman thêm theo ngưỡng)', () => {
    expect(roles('spend', 5_000_000_001n)).toEqual(['chief_accountant', 'deputy_director', 'director', 'deputy_chairman']);
  });

  it('nhãn quy trình phản ánh đúng khoảng tiền', () => {
    expect(defaultStepsFor('spend', 1_000_000n).label).toContain('dưới 50 triệu');
    expect(defaultStepsFor('spend', 1_000_000_000n).label).toContain('50 triệu – 5 tỷ');
    expect(defaultStepsFor('spend', 6_000_000_000n).label).toContain('trên 5 tỷ');
  });

  it('loại hồ sơ khác giữ chuỗi cố định, không phụ thuộc số tiền', () => {
    expect(roles('income', 1n)).toEqual(['chief_accountant', 'director', 'deputy_chairman']);
    expect(roles('income', 9_000_000_000n)).toEqual(['chief_accountant', 'director', 'deputy_chairman']);
  });
});

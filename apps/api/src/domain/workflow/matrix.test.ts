import { describe, expect, it } from 'vitest';
import {
  amountInRange,
  applyCashPolicy,
  defaultStepsFor,
  matchSpecificity,
  resolveChairmanThreshold,
  type ChairmanThresholdConfig,
  type MatrixStep,
} from './matrix.ts';

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
    // phiếu thu có bước PGĐ như phiếu chi (yêu cầu nghiệp vụ), nhưng không chia khoảng tiền
    expect(roles('income', 1n)).toEqual(['chief_accountant', 'deputy_director', 'director', 'deputy_chairman']);
    expect(roles('income', 9_000_000_000n)).toEqual(['chief_accountant', 'deputy_director', 'director', 'deputy_chairman']);
  });

  it('phiếu thu đi qua PGĐ giống phiếu chi, ở ngay sau KTT', () => {
    // chuỗi cố định (không chia khoảng tiền) nên luôn có PGĐ; phiếu chi chỉ có PGĐ trong khoảng tiền riêng
    expect(roles('income', 20_000_000n)).toEqual(['chief_accountant', 'deputy_director', 'director', 'deputy_chairman']);
    expect(roles('income', 20_000_000n).slice(0, 2), 'KTT → PGĐ giống phiếu chi').toEqual(roles('spend', 20_000_000n).slice(0, 2));
  });
});

/**
 * Cài đặt "Duyệt tiền mặt" (ADM-04, tab "Duyệt tiền mặt"): phiếu thu/chi quỹ tiền mặt của công ty
 * CHƯA tick bỏ bước Kế toán trưởng; công ty đang tick giữ nguyên chuỗi ma trận.
 */
describe('applyCashPolicy — cài đặt "Duyệt tiền mặt" áp lên chuỗi bước', () => {
  const chain = (kind: Parameters<typeof defaultStepsFor>[0], amount: bigint): MatrixStep[] =>
    defaultStepsFor(kind, amount).steps;

  it('công ty ĐANG BẬT "qua KTT duyệt" → chuỗi giữ nguyên, không đánh dấu override', () => {
    const steps = chain('spend', 1_000_000n);
    const out = applyCashPolicy(steps, true);
    expect(out.steps).toEqual(steps);
    expect(out.cash_overridden).toBe(false);
  });

  it('công ty CHƯA tick → bỏ bước KTT và đánh số lại order từ 1', () => {
    const out = applyCashPolicy(chain('spend', 1_000_000n), false);
    expect(out.steps.map((s) => s.role)).toEqual(['deputy_director']);
    expect(out.steps.map((s) => s.order)).toEqual([1]);
    expect(out.cash_overridden).toBe(true);
    // chuỗi dài: PGĐ → GĐ → P.TGĐ vẫn đúng thứ tự và số thứ tự liên tục
    const long = applyCashPolicy(chain('spend', 100_000_000n), false);
    expect(long.steps.map((s) => `${s.order}:${s.role}`)).toEqual(['1:deputy_director', '2:director']);
    expect(long.cash_overridden).toBe(true);
  });

  it('phiếu thu cũng bỏ KTT, giữ PGĐ → GĐ → P.TGĐ', () => {
    const out = applyCashPolicy(chain('income', 1_000_000n), false);
    expect(out.steps.map((s) => s.role)).toEqual(['deputy_director', 'director', 'deputy_chairman']);
    expect(out.steps.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(out.cash_overridden).toBe(true);
  });

  it('chuỗi CHỈ có KTT → giữ nguyên (không tạo chuỗi rỗng gây FG-WF-006)', () => {
    const onlyKtt: MatrixStep[] = [{ order: 1, role: 'chief_accountant', sla_hours: 24, mandatory: true }];
    const out = applyCashPolicy(onlyKtt, false);
    expect(out.steps).toEqual(onlyKtt);
    expect(out.cash_overridden).toBe(false);
  });

  it('chuỗi vốn không có KTT → giữ nguyên, không báo override', () => {
    const noKtt: MatrixStep[] = [{ order: 1, role: 'director', sla_hours: 48, mandatory: true }];
    const out = applyCashPolicy(noKtt, false);
    expect(out.steps).toEqual(noKtt);
    expect(out.cash_overridden).toBe(false);
  });

  it('giữ nguyên SLA / bắt buộc của các bước còn lại', () => {
    const out = applyCashPolicy(chain('income', 1_000_000n), false);
    expect(out.steps.map((s) => s.sla_hours)).toEqual([24, 48, 48]);
    expect(out.steps.every((s) => s.mandatory)).toBe(true);
  });
});

/**
 * ADM-04 "Ngừng dùng quy trình": dòng ngừng hiệu lực bị resolver bỏ qua ⇒ dòng kế tiếp phải được
 * chọn theo ĐÚNG thứ tự ưu tiên của resolveMatrix (dải tiền + công ty cụ thể > dòng công ty,
 * dòng công ty > toàn tập đoàn). `nextMatrixInLine` chia sẻ nguyên các hàm chọn dòng với resolver.
 */
describe('matchSpecificity / amountInRange — tiêu chí chọn dòng của resolver', () => {
  const CTY = 'a'.repeat(24);

  it('dòng của công ty + có danh mục riêng > dòng của công ty > dòng toàn tập đoàn', () => {
    const base = { amount_min_minor: 0n, amount_max_minor: null };
    const company = { ...base, company_id: CTY, category_id: null };
    const group = { ...base, company_id: null, category_id: null };
    const cat = { ...base, company_id: CTY, category_id: 'c'.repeat(24) };
    expect(matchSpecificity(company, { company_id: CTY })).toBeGreaterThan(matchSpecificity(group, { company_id: CTY }));
    expect(matchSpecificity(cat, { company_id: CTY, category_id: 'c'.repeat(24) })).toBeGreaterThan(matchSpecificity(company, { company_id: CTY }));
    // danh mục của công ty khác không cộng điểm
    expect(matchSpecificity(cat, { company_id: CTY, category_id: 'd'.repeat(24) })).toBeLessThan(
      matchSpecificity(company, { company_id: CTY }),
    );
  });

  it('dải tiền nửa mở [min, max): cận dưới tính, cận trên KHÔNG tính, max null = không chặn', () => {
    expect(amountInRange({ company_id: null, category_id: null, amount_min_minor: '0', amount_max_minor: '50000000' }, 0n)).toBe(true);
    expect(amountInRange({ company_id: null, category_id: null, amount_min_minor: '0', amount_max_minor: '50000000' }, 49_999_999n)).toBe(true);
    expect(amountInRange({ company_id: null, category_id: null, amount_min_minor: '0', amount_max_minor: '50000000' }, 50_000_000n)).toBe(false);
    expect(amountInRange({ company_id: null, category_id: null, amount_min_minor: '50000000', amount_max_minor: null }, 9_000_000_000n)).toBe(true);
  });
});

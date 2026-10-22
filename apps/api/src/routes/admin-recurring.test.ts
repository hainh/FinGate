import { describe, expect, it } from 'vitest';
import { nextOccurrence, previewOccurrences } from './admin.ts';

/** Khoản chi định kỳ: kỳ kế tiếp không được bỏ sót khi cách hơn 9 ngày (trước đây quét tối đa n*3 ngày). */
describe('nextOccurrence / previewOccurrences — chu kỳ thưa', () => {
  it('hàng tháng ngày 1, hôm nay 22/10/2026 ⇒ 01/11/2026 (cách 10 ngày)', () => {
    expect(nextOccurrence({ cadence: 'monthly', day_of_period: 1, effective_from: '2026-10-22', effective_to: null }, '2026-10-22')).toBe('2026-11-01');
  });

  it('hàng tháng: preview 12 kỳ liên tiếp, mỗi kỳ đúng ngày 1', () => {
    const out = previewOccurrences({ cadence: 'monthly', day_of_period: 1, effective_from: '2026-10-22' }, 12);
    expect(out).toHaveLength(12);
    expect(out[0]).toBe('2026-11-01');
    expect(out[11]).toBe('2027-10-01');
  });

  it('hàng quý ngày 1 (tháng 1/4/7/10): kỳ kế tiếp từ 22/10/2026 ⇒ 01/01/2027', () => {
    expect(nextOccurrence({ cadence: 'quarterly', day_of_period: 1, effective_from: '2026-10-22' }, '2026-10-22')).toBe('2027-01-01');
  });

  it('nửa năm và năm: vẫn tìm được kỳ kế tiếp', () => {
    expect(nextOccurrence({ cadence: 'semi_annual', day_of_period: 1, effective_from: '2026-10-22' }, '2026-10-22')).toBe('2027-01-01');
    expect(nextOccurrence({ cadence: 'annual', day_of_period: 1, effective_from: '2026-10-22' }, '2026-10-22')).toBe('2027-01-01');
  });

  it('hết hiệu lực trước kỳ kế tiếp ⇒ null', () => {
    expect(nextOccurrence({ cadence: 'monthly', day_of_period: 1, effective_from: '2026-10-22', effective_to: '2026-10-30' }, '2026-10-22')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { composeAccountBalance } from './accounts.ts';

describe('composeAccountBalance — số dư = sổ cái + dự kiến (không phong toả)', () => {
  it('projected = thực tế + vào dự kiến − ra dự kiến', () => {
    const r = composeAccountBalance({ actual: 1000n, planned_in: 300n, planned_out: 500n, min_balance: 0n });
    expect(r.projected).toBe(800n);
  });

  it('vi phạm thực tế và vi phạm dự kiến tách bạch', () => {
    const r = composeAccountBalance({ actual: 1000n, planned_in: 0n, planned_out: 200n, min_balance: 900n });
    expect(r.breach).toBe(false); // sổ cái 1000 ≥ 900
    expect(r.breach_projected).toBe(true); // dự kiến 800 < 900
  });

  it('số dư âm vẫn được tính (không kẹp về 0)', () => {
    const r = composeAccountBalance({ actual: 100n, planned_in: 0n, planned_out: 250n, min_balance: 0n });
    expect(r.projected).toBe(-150n);
    expect(r.breach).toBe(false);
    expect(r.breach_projected).toBe(true);
  });
});

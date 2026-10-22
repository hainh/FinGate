import { describe, expect, it } from 'vitest';
import { sumDocumentMinor } from './index.ts';

describe('sumDocumentMinor — tổng "chờ tôi duyệt" cộng đủ mọi hồ sơ (US-APR-01, không cắt ở 500)', () => {
  it('nhiều hơn 500 hồ sơ: tổng bằng tổng của TẤT CẢ hồ sơ, không phải 500 hồ sơ đầu', async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ amount: { minor: BigInt(1_000_000 + i) } }));
    const expected = rows.reduce((a, r) => a + r.amount.minor, 0n);
    expect(await sumDocumentMinor(rows)).toBe(expected);
    // phần 500 hồ sơ cuối không được bỏ sót
    const tail = rows.slice(500).reduce((a, r) => a + r.amount.minor, 0n);
    expect(tail).toBeGreaterThan(0n);
    expect(await sumDocumentMinor(rows.slice(500))).toBe(tail);
  });

  it('nhận luồng bất đồng bộ (cursor MongoDB); hồ sơ thiếu số tiền tính 0; số dạng chuỗi/số đều đúng', async () => {
    async function* stream() {
      yield { amount: { minor: '250' } };
      yield {};
      yield { amount: { minor: 750n } };
      yield { amount: { minor: 1000 } };
    }
    expect(await sumDocumentMinor(stream())).toBe(2000n);
  });

  it('không có hồ sơ nào → 0', async () => {
    expect(await sumDocumentMinor([])).toBe(0n);
  });
});

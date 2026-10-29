import { describe, expect, it } from 'vitest';
import { storedTimeline } from './finance.ts';

/** Số dư tổng của giao dịch gắn tiền lưu trữ TẠI thời điểm giao dịch — sửa tiền lưu trữ không đổi giao dịch cũ. */
describe('storedTimeline', () => {
  const d = (s: string): Date => new Date(s);

  it('chưa từng sửa tiền lưu trữ ⇒ mọi giao dịch dùng giá trị hiện tại', () => {
    const at = storedTimeline({ stored_minor: 500n, history: [{ at: d('2026-10-01T00:00:00Z'), action: 'create', changes: {} }] });
    expect(at(d('2026-10-05T00:00:00Z'))).toBe(500n);
  });

  it('giao dịch trước / giữa / sau các lần sửa lấy đúng mức lúc đó', () => {
    const at = storedTimeline({
      stored_minor: 300n,
      history: [
        { at: d('2026-10-20T00:00:00Z'), changes: { stored_minor: { from: '100', to: '300' } } },
        { at: d('2026-10-10T00:00:00Z'), changes: { stored_minor: { from: null, to: '100' } } },
        { at: d('2026-10-15T00:00:00Z'), changes: { note: { from: null, to: 'x' } } },
      ],
    });
    expect(at(d('2026-10-01T00:00:00Z'))).toBe(0n);
    expect(at(d('2026-10-10T00:00:00Z'))).toBe(100n);
    expect(at(d('2026-10-19T23:59:59Z'))).toBe(100n);
    expect(at(d('2026-10-25T00:00:00Z'))).toBe(300n);
  });

  it('không có thời điểm ⇒ giá trị hiện tại', () => {
    const at = storedTimeline({ stored_minor: 42n, history: [{ at: d('2026-10-10T00:00:00Z'), changes: { stored_minor: { from: '0', to: '42' } } }] });
    expect(at(null)).toBe(42n);
  });
});

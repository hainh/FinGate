import { describe, expect, it } from 'vitest';
import { BADGE_CACHE_PREFIX, badgeCacheKey, scopeCacheKey } from './badge-cache.ts';

const CTA = '64b000000000000000000001';
const CTB = '64b000000000000000000002';
const U = '64c000000000000000000009';

describe('badgeCacheKey — badge "chờ tôi duyệt" phải khoá theo phạm vi công ty (US-APR-01)', () => {
  it('cùng người, khác công ty → khác khoá (không trả lại số đếm của công ty trước)', () => {
    const inA = badgeCacheKey({ userId: U, companyIds: [CTA], role: 'chief_accountant', canPay: false });
    const inB = badgeCacheKey({ userId: U, companyIds: [CTB], role: 'chief_accountant', canPay: false });
    expect(inA).not.toBe(inB);
  });

  it('toàn tập đoàn (null) khác với một công ty và khác với rỗng', () => {
    const all = badgeCacheKey({ userId: U, companyIds: null, canPay: false });
    const one = badgeCacheKey({ userId: U, companyIds: [CTA], canPay: false });
    const none = badgeCacheKey({ userId: U, companyIds: [], canPay: false });
    expect(new Set([all, one, none]).size).toBe(3);
  });

  it('cùng một tập công ty (bất kể thứ tự, trùng lặp) → cùng khoá', () => {
    expect(badgeCacheKey({ userId: U, companyIds: [CTB, CTA], canPay: false })).toBe(
      badgeCacheKey({ userId: U, companyIds: [CTA, CTB, CTA], canPay: false }),
    );
  });

  it('khác vai trò, quyền thanh toán, hoặc tập tag → khác khoá', () => {
    const base = { userId: U, companyIds: [CTA], canPay: false };
    const k = badgeCacheKey(base);
    expect(badgeCacheKey({ ...base, role: 'staff' })).not.toBe(k);
    expect(badgeCacheKey({ ...base, canPay: true })).not.toBe(k);
    expect(badgeCacheKey({ ...base, tagIds: ['64d000000000000000000001'] })).not.toBe(k);
  });

  it('mọi khoá bắt đầu bằng tiền tố theo người dùng để xoá đúng badge của người đó', () => {
    const k = badgeCacheKey({ userId: U, companyIds: [CTA], canPay: true, tagIds: [CTB] });
    expect(k.startsWith(`${BADGE_CACHE_PREFIX}${U}:`)).toBe(true);
    expect(k.startsWith(BADGE_CACHE_PREFIX)).toBe(true);
  });
});

describe('scopeCacheKey', () => {
  it('giá trị đặc biệt không đụng nhau và không trùng với id công ty', () => {
    expect(scopeCacheKey(null)).toBe('all');
    expect(scopeCacheKey([])).toBe('none');
    expect(scopeCacheKey([CTA])).toBe(CTA);
  });
});

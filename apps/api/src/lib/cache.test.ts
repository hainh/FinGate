import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheClear, cacheGet, cacheInvalidate, cacheSet, cacheThrough } from './cache.ts';

const TTL = 60_000;

beforeEach(() => {
  cacheClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('cacheThrough — đọc qua cache', () => {
  it('lần thứ hai cùng khoá lấy từ cache, không gọi load lại', async () => {
    let calls = 0;
    const load = async () => {
      calls++;
      return 7;
    };
    expect(await cacheThrough('k:a', load, TTL)).toBe(7);
    expect(await cacheThrough('k:a', load, TTL)).toBe(7);
    expect(calls).toBe(1);
  });

  it('hết TTL thì nạp lại', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-22T00:00:00Z') });
    let calls = 0;
    const load = async () => ++calls;
    await cacheThrough('k:ttl', load, 1_000);
    vi.advanceTimersByTime(1_001);
    expect(await cacheThrough('k:ttl', load, 1_000)).toBe(2);
  });
});

describe('cacheThrough — mutation xảy ra khi đang tính không được để lại số cũ', () => {
  it('xoá cache trong lúc load → người gọi nhận kết quả, nhưng kết quả KHÔNG được cache', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = cacheThrough(
      'badge:u1:all:',
      async () => {
        await gate; // đếm xong sau khi mutation đã xảy ra
        return 941;
      },
      TTL,
    );
    cacheInvalidate('badge:'); // phiếu vừa đổi: badge phải đếm lại
    release();
    expect(await pending).toBe(941);
    expect(cacheGet('badge:u1:all:')).toBeUndefined();

    let calls = 0;
    expect(
      await cacheThrough(
        'badge:u1:all:',
        async () => {
          calls++;
          return 944;
        },
        TTL,
      ),
    ).toBe(944);
    expect(calls).toBe(1);
  });

  it('cacheClear trong lúc load cũng không ghi kết quả cũ', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = cacheThrough(
      'k:clear',
      async () => {
        await gate;
        return 1;
      },
      TTL,
    );
    cacheClear();
    release();
    await pending;
    expect(cacheGet('k:clear')).toBeUndefined();
  });

  it('không có xoá trong lúc load → kết quả được cache bình thường', async () => {
    const pending = cacheThrough('k:normal', async () => 3, TTL);
    expect(await pending).toBe(3);
    expect(cacheGet('k:normal')).toBe(3);
  });
});

describe('cacheInvalidate — chỉ xoá đúng tiền tố', () => {
  it('xoá khoá có tiền tố, giữ các khoá khác', () => {
    cacheSet('badge:u1:all:', 1, TTL);
    cacheSet('badge:u2:CTA:', 2, TTL);
    cacheSet('overview:u1:', 3, TTL);
    cacheInvalidate('badge:');
    expect(cacheGet('badge:u1:all:')).toBeUndefined();
    expect(cacheGet('badge:u2:CTA:')).toBeUndefined();
    expect(cacheGet('overview:u1:')).toBe(3);
  });
});

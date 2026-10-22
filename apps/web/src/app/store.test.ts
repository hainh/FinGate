/**
 * Phân loại lỗi tải /me và lịch tự tải lại (store.tsx): chỉ 401 / FG-AUTH-001 mới là hết phiên.
 */

import { describe, expect, it } from 'vitest';
import type { ProblemJson } from '@fingate/shared';
import { ApiRequestError } from './api.ts';
import { isSessionEnded, meRetryDelayMs } from './store.tsx';

const apiError = (status: number, code: ProblemJson['code']): ApiRequestError =>
  new ApiRequestError({ type: 'about:blank', title: 'lỗi', status, code });

describe('isSessionEnded', () => {
  it('401 hoặc FG-AUTH-001 là hết phiên → đưa về màn đăng nhập', () => {
    expect(isSessionEnded(apiError(401, 'FG-AUTH-001'))).toBe(true);
    expect(isSessionEnded(apiError(401, 'FG-SYS-001'))).toBe(true);
    expect(isSessionEnded(apiError(403, 'FG-AUTH-001'))).toBe(true);
  });

  it('502/503, mất mạng hoặc lỗi khác KHÔNG phải hết phiên (giữ nguyên phiên)', () => {
    expect(isSessionEnded(apiError(502, 'FG-SYS-001'))).toBe(false);
    expect(isSessionEnded(apiError(503, 'FG-SYS-002'))).toBe(false);
    expect(isSessionEnded(apiError(0, 'FG-SYS-001'))).toBe(false);
    expect(isSessionEnded(apiError(403, 'FG-RBAC-001'))).toBe(false);
    expect(isSessionEnded(new TypeError('Failed to fetch'))).toBe(false);
    expect(isSessionEnded(undefined)).toBe(false);
  });
});

describe('meRetryDelayMs', () => {
  it('tăng gấp đôi từ 2s và dừng ở 30s', () => {
    expect([1, 2, 3, 4, 5, 9].map(meRetryDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });
});

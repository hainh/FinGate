/**
 * Màn Quản trị "Duyệt tiền mặt" (ADM-04b): tab phải nằm NGAY SAU "Ma trận duyệt" và route của tab
 * phải có entry quyền `admin:matrix` — gõ URL trực tiếp mà thiếu quyền thì bị đưa về trang phù hợp.
 */
import { describe, expect, it } from 'vitest';
import { ADMIN_TABS } from './admin.tsx';
import { PATH_PERMS, ROUTE_TITLES } from '../routes.tsx';

describe('ADMIN_TABS — tab "Duyệt tiền mặt"', () => {
  it('đứng ngay sau tab "Ma trận duyệt" và yêu cầu admin:matrix', () => {
    const tos = ADMIN_TABS.map((t) => t.to);
    expect(tos.indexOf('/quantri/duyet-tien-mat')).toBe(tos.indexOf('/quantri/quy-trinh-duyet') + 1);
    expect(ADMIN_TABS.find((t) => t.to === '/quantri/duyet-tien-mat')?.perm).toBe('admin:matrix');
  });
});

describe('route /quantri/duyet-tien-mat', () => {
  it('có quyền tối thiểu admin:matrix', () => {
    expect(PATH_PERMS.find((p) => p.prefix === '/quantri/duyet-tien-mat')?.perm).toBe('admin:matrix');
  });

  it('có tiêu đề tab trình duyệt riêng', () => {
    expect(ROUTE_TITLES.find(([pattern]) => pattern === '/quantri/duyet-tien-mat')?.[1]).toBe('Quản trị · Duyệt tiền mặt');
  });
});

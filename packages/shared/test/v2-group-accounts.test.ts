import { describe, expect, it } from 'vitest';
import { permissionsForRole } from '../src/permissions/index.js';

describe('v2 — tài khoản Tổng công ty chỉ Chủ tịch cấu hình (v2/v2.md §4.2, §3.2)', () => {
  it('chỉ chairman có admin:group_accounts mặc định', () => {
    expect(permissionsForRole('chairman')).toContain('admin:group_accounts');
    expect(permissionsForRole('deputy_chairman')).not.toContain('admin:group_accounts');
    expect(permissionsForRole('admin')).not.toContain('admin:group_accounts');
  });
});

import { describe, expect, it } from 'vitest';
import { documentPermissions } from './index.ts';

/** Quyền per-hồ sơ cho các cờ v2: `tag` (sửa tag sau duyệt) và `link` (gán/gỡ liên kết thủ công). */
function perms(permissions: string[], opts: { inCompany?: boolean; status?: string } = {}) {
  return documentPermissions(
    { user_id: 'u1', permissions, amount_limit_minor: 0n, role: 'staff' },
    {
      status: opts.status ?? 'paid',
      created_by: 'u2',
      amount_minor: 1_000n,
      steps: [],
      evidence_missing: [],
      company_id: 'A',
      actor_companies: opts.inCompany === false ? [] : ['A'],
      delegatedStepOrders: [],
      approved_from_ktt_up: false,
    },
  );
}

describe('documentPermissions — tag (v2 §6.2)', () => {
  it('kế toán viên (doc:create) sửa được tag, kể cả khi phiếu đã thực thi', () => {
    expect(perms(['doc:read', 'doc:create'], { status: 'paid' }).tag).toBe(true);
  });

  it('người chỉ có quyền tạo tag (tag:create) cũng sửa được tag', () => {
    expect(perms(['doc:read', 'tag:create']).tag).toBe(true);
  });

  it('chỉ xem (không doc:create / tag:create) ⇒ không sửa được tag', () => {
    expect(perms(['doc:read']).tag).toBe(false);
  });

  it('ngoài phạm vi công ty và không có doc:read ⇒ không sửa được tag', () => {
    expect(perms(['doc:create'], { inCompany: false }).tag).toBe(false);
  });
});

describe('documentPermissions — link (v2 §11.2)', () => {
  it('có link:manage ⇒ được gán/gỡ liên kết thủ công', () => {
    expect(perms(['doc:read', 'link:manage']).link).toBe(true);
  });

  it('thiếu link:manage ⇒ không', () => {
    expect(perms(['doc:read', 'doc:create']).link).toBe(false);
  });

  it('ngoài phạm vi công ty ⇒ không dù có quyền', () => {
    expect(perms(['link:manage'], { inCompany: false }).link).toBe(false);
  });
});

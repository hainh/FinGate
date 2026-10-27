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

describe('documentPermissions — đưa vào hàng thanh toán (v2 §7.1: DaDuyet → DangThanhToan)', () => {
  it('phiếu đã duyệt + payment:mark ⇒ được đưa vào hàng thanh toán', () => {
    expect(perms(['doc:read', 'payment:mark'], { status: 'approved' }).queue_payment).toBe(true);
  });

  it('thiếu payment:mark ⇒ không (cùng quyền với thực thi)', () => {
    expect(perms(['doc:read', 'doc:create'], { status: 'approved' }).queue_payment).toBe(false);
  });

  it('đang thanh toán (processing) ⇒ không đưa vào hàng nữa, nhưng vẫn được thực thi', () => {
    const p = perms(['doc:read', 'payment:mark'], { status: 'processing' });
    expect(p.queue_payment).toBe(false);
    expect(p.pay).toBe(true);
  });

  it('phiếu chưa duyệt / đã thực thi ⇒ không', () => {
    expect(perms(['doc:read', 'payment:mark'], { status: 'pending.ktt' }).queue_payment).toBe(false);
    expect(perms(['doc:read', 'payment:mark'], { status: 'paid' }).queue_payment).toBe(false);
  });
});

describe('documentPermissions — partner_change (đổi đối tác phiếu thu/chi)', () => {
  function partnerPerms(role: 'chairman' | 'chief_accountant', kind: string, opts: { status?: string; inCompany?: boolean } = {}) {
    // ngoài công ty: không có doc:read (doc:read tự cấp phạm vi xem mọi công ty)
    const permissions = opts.inCompany === false ? ['doc:create'] : ['doc:read', 'doc:create'];
    return documentPermissions(
      { user_id: 'u1', permissions, amount_limit_minor: 0n, role },
      {
        status: opts.status ?? 'paid',
        kind,
        created_by: 'u2',
        amount_minor: 1_000n,
        steps: [],
        evidence_missing: [],
        company_id: 'A',
        actor_companies: opts.inCompany === false ? [] : ['A'],
        delegatedStepOrders: [],
        approved_from_ktt_up: true,
      },
    );
  }

  it('Chủ tịch đổi được đối tác phiếu thu / chi ở mọi trạng thái, kể cả đã thực thi', () => {
    expect(partnerPerms('chairman', 'income', { status: 'paid' }).partner_change).toBe(true);
    expect(partnerPerms('chairman', 'spend', { status: 'draft' }).partner_change).toBe(true);
  });

  it('vai trò khác (kể cả kế toán trưởng) không đổi được đối tác', () => {
    expect(partnerPerms('chief_accountant', 'income').partner_change).toBe(false);
  });

  it('phiếu không phải thu / chi (đảo hạn) hoặc ngoài phạm vi công ty ⇒ không đổi được', () => {
    expect(partnerPerms('chairman', 'rollover').partner_change).toBe(false);
    expect(partnerPerms('chairman', 'spend', { inCompany: false }).partner_change).toBe(false);
  });
});

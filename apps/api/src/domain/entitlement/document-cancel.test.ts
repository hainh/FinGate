import { describe, expect, it } from 'vitest';
import { companyReachableByActor, documentPermissions } from './index.ts';

/** Cờ `cancel` (v2 §7.1: Nháp / Yêu cầu bổ sung / Đã duyệt → Huỷ) — khớp luật server (workflow.transition). */
function perms(opts: { status: string; mine?: boolean; permissions?: string[]; inCompany?: boolean }) {
  return documentPermissions(
    { user_id: 'u1', permissions: opts.permissions ?? ['doc:read', 'doc:create'], amount_limit_minor: 0n, role: 'staff' },
    {
      status: opts.status,
      created_by: opts.mine === false ? 'u2' : 'u1',
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

describe('documentPermissions — huỷ hồ sơ (v2 §7.1)', () => {
  it('người lập huỷ được phiếu Nháp, Yêu cầu bổ sung, Đã duyệt', () => {
    expect(perms({ status: 'draft' }).cancel).toBe(true);
    expect(perms({ status: 'changes_requested' }).cancel).toBe(true);
    expect(perms({ status: 'approved' }).cancel).toBe(true);
  });

  it('không phải người lập ⇒ không huỷ (trừ khi có approval:override)', () => {
    expect(perms({ status: 'draft', mine: false }).cancel).toBe(false);
    expect(perms({ status: 'approved', mine: false, permissions: ['doc:read', 'approval:override'] }).cancel).toBe(true);
  });

  it('trạng thái khác (đang duyệt, đã thanh toán, đã huỷ) ⇒ không huỷ', () => {
    expect(perms({ status: 'pending.ktt' }).cancel).toBe(false);
    expect(perms({ status: 'paid' }).cancel).toBe(false);
    expect(perms({ status: 'cancelled' }).cancel).toBe(false);
  });

  it('ngoài phạm vi công ty ⇒ không huỷ', () => {
    // không có doc:read và công ty phiếu không nằm trong phân công ⇒ ngoài phạm vi
    expect(perms({ status: 'draft', inCompany: false, permissions: ['doc:create'] }).cancel).toBe(false);
  });
});

describe('companyReachableByActor — công ty nhận chuyển nội bộ (§11.6, §7.5)', () => {
  const staffCTA = { scope_all: false, assignments: [{ company_id: 'CTA' }, { company_id: 'CTB' }] };

  it('công ty được gán (kể cả không phải công ty đang xem) ⇒ tham chiếu được', () => {
    expect(companyReachableByActor(staffCTA, 'CTB')).toBe(true);
  });

  it('công ty không được gán ⇒ không', () => {
    expect(companyReachableByActor(staffCTA, 'CTC')).toBe(false);
  });

  it('quyền toàn tập đoàn ⇒ mọi công ty', () => {
    expect(companyReachableByActor({ scope_all: true, assignments: [{ company_id: 'GROUP' }] }, 'CTZ')).toBe(true);
  });

  it('không có danh tính ⇒ không', () => {
    expect(companyReachableByActor(null, 'CTA')).toBe(false);
  });
});

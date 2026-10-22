import { describe, expect, it } from 'vitest';
import { documentPermissions } from './index.ts';

/**
 * Quyền per-hồ sơ cho phương án đảo hạn (v2 §7.3, RENEW-04): phương án KHÔNG có "Thực thi" và
 * "Đưa vào hàng thanh toán" (không phải dòng tiền); kết quả ghi qua `rollover_result` theo `rollover:act`.
 */
function perms(permissions: string[], opts: { kind?: string; status?: string; inCompany?: boolean } = {}) {
  return documentPermissions(
    { user_id: 'u1', permissions, amount_limit_minor: 0n, role: 'chief_accountant' },
    {
      status: opts.status ?? 'approved',
      kind: opts.kind ?? 'rollover',
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

describe('documentPermissions — phương án đảo hạn không có "Thực thi" / "Đưa vào hàng thanh toán"', () => {
  it('đã duyệt + payment:mark ⇒ KHÔNG pay, KHÔNG queue_payment', () => {
    const p = perms(['doc:read', 'payment:mark']);
    expect(p.pay).toBe(false);
    expect(p.queue_payment).toBe(false);
  });

  it('đang thanh toán (processing) + payment:mark ⇒ vẫn KHÔNG pay', () => {
    expect(perms(['doc:read', 'payment:mark'], { status: 'processing' }).pay).toBe(false);
  });

  it('thiếu kind (phiếu không khai loại) ⇒ coi như không phải đảo hạn, vẫn pay như phiếu chi', () => {
    const p = documentPermissions(
      { user_id: 'u1', permissions: ['doc:read', 'payment:mark'], amount_limit_minor: 0n, role: 'staff' },
      {
        status: 'approved',
        created_by: 'u2',
        amount_minor: 1_000n,
        steps: [],
        evidence_missing: [],
        company_id: 'A',
        actor_companies: ['A'],
        delegatedStepOrders: [],
        approved_from_ktt_up: false,
      },
    );
    expect(p.pay).toBe(true);
  });
});

describe('documentPermissions — RENEW-04 ghi kết quả đảo hạn (rollover_result)', () => {
  it('đã duyệt + rollover:act ⇒ được ghi kết quả', () => {
    expect(perms(['doc:read', 'rollover:act']).rollover_result).toBe(true);
  });

  it('đã thực thi (paid) + rollover:act ⇒ vẫn ghi kết quả (server chấp nhận approved/paid)', () => {
    expect(perms(['doc:read', 'rollover:act'], { status: 'paid' }).rollover_result).toBe(true);
  });

  it('chỉ payment:mark (kế toán viên, không có rollover:act) ⇒ không ghi kết quả — server chặn FG-RBAC-001', () => {
    expect(perms(['doc:read', 'payment:mark', 'doc:create']).rollover_result).toBe(false);
  });

  it('chưa duyệt (pending.ktt) ⇒ không ghi kết quả', () => {
    expect(perms(['doc:read', 'rollover:act'], { status: 'pending.ktt' }).rollover_result).toBe(false);
  });

  it('ngoài phạm vi công ty và không có doc:read ⇒ không', () => {
    expect(perms(['rollover:act'], { inCompany: false }).rollover_result).toBe(false);
  });

  it('phiếu chi không phải đảo hạn ⇒ rollover_result luôn false', () => {
    expect(perms(['doc:read', 'rollover:act'], { kind: 'spend' }).rollover_result).toBe(false);
  });
});

describe('documentPermissions — phiếu chi không đổi', () => {
  it('phiếu chi đã duyệt + payment:mark ⇒ pay và queue_payment đều true', () => {
    const p = perms(['doc:read', 'payment:mark'], { kind: 'spend' });
    expect(p.pay).toBe(true);
    expect(p.queue_payment).toBe(true);
    expect(p.rollover_result).toBe(false);
  });

  it('phiếu chi đang thanh toán (processing) + payment:mark ⇒ pay true, queue_payment false', () => {
    const p = perms(['doc:read', 'payment:mark'], { kind: 'spend', status: 'processing' });
    expect(p.pay).toBe(true);
    expect(p.queue_payment).toBe(false);
  });
});

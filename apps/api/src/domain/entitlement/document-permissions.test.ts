import { describe, expect, it } from 'vitest';
import { approvedFromChiefAccountantUp, documentPermissions } from './index.ts';

type History = { action?: string | null; actor?: { role?: string | null } | null }[];

function perms(status: string, opts: { mine?: boolean; history?: History } = {}) {
  const mine = opts.mine ?? true;
  return documentPermissions(
    {
      user_id: 'u1',
      permissions: ['doc:read', 'doc:create', 'doc:delete'],
      amount_limit_minor: 0n,
      role: 'staff',
    },
    {
      status,
      created_by: mine ? 'u1' : 'u2',
      amount_minor: 1_000_000n,
      steps: [],
      evidence_missing: [],
      company_id: 'A',
      actor_companies: ['A'],
      delegatedStepOrders: [],
      approved_from_ktt_up: approvedFromChiefAccountantUp(opts.history ?? []),
    },
  );
}

describe('approvedFromChiefAccountantUp', () => {
  it('false khi chưa ai duyệt', () => {
    expect(approvedFromChiefAccountantUp([])).toBe(false);
    expect(approvedFromChiefAccountantUp([{ action: 'submit', actor: { role: 'staff' } }])).toBe(false);
  });

  it('false khi chỉ có request_changes / reject của KTT+ (chưa duyệt)', () => {
    expect(approvedFromChiefAccountantUp([{ action: 'request_changes', actor: { role: 'chief_accountant' } }])).toBe(false);
    expect(approvedFromChiefAccountantUp([{ action: 'reject', actor: { role: 'deputy_director' } }])).toBe(false);
  });

  it('true khi có approve từ KTT trở lên', () => {
    for (const role of ['chief_accountant', 'deputy_director', 'director', 'chairman']) {
      expect(approvedFromChiefAccountantUp([{ action: 'approve', actor: { role } }])).toBe(true);
    }
    expect(approvedFromChiefAccountantUp([{ action: 'approve_with_reason', actor: { role: 'chief_accountant' } }])).toBe(true);
  });
});

describe('documentPermissions — xoá/sửa của người lập', () => {
  it('nháp của mình: sửa và xoá được', () => {
    const c = perms('draft');
    expect(c.edit).toBe(true);
    expect(c.delete).toBe(true);
  });

  it('yêu cầu bổ sung, chưa ai từ KTT trở lên duyệt: sửa và xoá được', () => {
    const c = perms('changes_requested', { history: [{ action: 'request_changes', actor: { role: 'chief_accountant' } }] });
    expect(c.edit).toBe(true);
    expect(c.delete).toBe(true);
  });

  it('yêu cầu bổ sung SAU khi KTT đã duyệt: KHÔNG sửa/xoá được', () => {
    const c = perms('changes_requested', {
      history: [
        { action: 'approve', actor: { role: 'chief_accountant' } },
        { action: 'request_changes', actor: { role: 'deputy_director' } },
      ],
    });
    expect(c.edit).toBe(false);
    expect(c.delete).toBe(false);
  });

  it('bị từ chối trước khi KTT duyệt: sửa/xoá được', () => {
    const c = perms('rejected', { history: [{ action: 'reject', actor: { role: 'chief_accountant' } }] });
    expect(c.edit).toBe(true);
    expect(c.delete).toBe(true);
  });

  it('bị từ chối sau khi KTT đã duyệt: KHÔNG sửa/xoá được', () => {
    const c = perms('rejected', {
      history: [
        { action: 'approve', actor: { role: 'chief_accountant' } },
        { action: 'reject', actor: { role: 'director' } },
      ],
    });
    expect(c.edit).toBe(false);
    expect(c.delete).toBe(false);
  });

  it('không phải người lập: KHÔNG sửa/xoá được', () => {
    const c = perms('draft', { mine: false });
    expect(c.edit).toBe(false);
    expect(c.delete).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { scopeFor, type ResolvedIdentity } from './index.ts';

function identity(companyIds: string[], scopeAll: boolean): ResolvedIdentity {
  return {
    user: {},
    assignments: companyIds.map((company_id) => ({
      _id: company_id,
      company_id,
      department_id: null,
      role: 'staff',
      amount_limit_minor: 0n,
      scope_all: scopeAll,
      extra_permissions: [],
      denied_permissions: [],
    })),
    role: 'staff',
    company_id: companyIds[0] ?? null,
    department_id: null,
    amount_limit_minor: 0n,
    scope_all: scopeAll,
    permissions: [],
    extra: [],
    denied: [],
  };
}

describe('scopeFor — phạm vi dữ liệu theo công ty', () => {
  it('người bị ghim công ty: chỉ thấy công ty được chọn', () => {
    expect(scopeFor(identity(['A', 'B'], false), 'B')).toEqual({ companyIds: ['B'] });
  });

  it('người bị ghim công ty: chọn công ty ngoài phạm vi → rỗng', () => {
    expect(scopeFor(identity(['A'], false), 'C')).toEqual({ companyIds: [] });
  });

  it('người bị ghim công ty: không chọn → mọi công ty được gán', () => {
    expect(scopeFor(identity(['A', 'B'], false), null)).toEqual({ companyIds: ['A', 'B'] });
  });

  it('scope_all: chọn 1 công ty → THU HẸP về đúng công ty đó (không rò dữ liệu chéo)', () => {
    expect(scopeFor(identity(['A', 'B'], true), 'B')).toEqual({ companyIds: ['B'] });
  });

  it('scope_all: không chọn hoặc chọn "all" → toàn tập đoàn', () => {
    expect(scopeFor(identity(['A', 'B'], true), null)).toEqual({ companyIds: null });
    expect(scopeFor(identity(['A', 'B'], true), 'all')).toEqual({ companyIds: null });
  });
});

/**
 * assignUsers — cấp khuyết chức danh bị bỏ khỏi chuỗi (v2 §7.2). Chỉ đẩy bước cao nhất lên cấp cao hơn
 * còn người khi cả chuỗi không còn ai có người phụ trách; Chủ tịch chỉ vào chuỗi khi hồ sơ vượt ngưỡng
 * (ma trận), KHÔNG vì cấp dưới khuyết.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainDoc, StepRow } from '../types.ts';

/* Tầng DB giả lập: phân công và người dùng đang hoạt động. */
const db = vi.hoisted(() => {
  const state = {
    assignments: [] as { user_id: string; role: string; company_id: string; status: string }[],
    users: [] as { _id: string; status: string }[],
  };
  const query = (rows: () => unknown[]) => {
    const q = { select: () => q, lean: async () => rows() };
    return q;
  };
  return { state, query };
});

vi.mock('../../db/models.ts', () => ({
  Models: {
    Assignment: { find: () => db.query(() => db.state.assignments) },
    User: { find: () => db.query(() => db.state.users) },
    Delegation: { find: () => ({ lean: async () => [] }) },
  },
}));

// Các module phụ trợ mà index.ts import nhưng assignUsers không dùng: thay bằng stub.
vi.mock('../../env.ts', () => ({ getEnv: () => ({ APPROVAL_STEP_UP: 'false' }) }));
vi.mock('../../db/cas.ts', () => ({ cas: vi.fn() }));
vi.mock('../../lib/password.ts', () => ({ verifyPassword: vi.fn(), hashToken: vi.fn() }));
vi.mock('../../lib/crypto.ts', () => ({ decryptField: vi.fn() }));
vi.mock('../../lib/totp.ts', () => ({ verifyTotp: vi.fn() }));
vi.mock('../audit/index.ts', () => ({ buildHistoryEntry: vi.fn(), diffFields: vi.fn(), mirrorAudit: vi.fn() }));
vi.mock('../calendar/index.ts', () => ({ DEFAULT_CALENDAR: { workdays: [1, 2, 3, 4, 5], holidays: [] }, slaDeadline: vi.fn() }));
vi.mock('../numbering/index.ts', () => ({ nextDocumentCode: vi.fn() }));
vi.mock('../side-effects.ts', () => ({ notifyNextApprover: vi.fn(), rebuildEvidence: vi.fn(), syncBalancesForDocument: vi.fn() }));
vi.mock('../automation/locks.ts', () => ({ amountLockedByAutomation: vi.fn() }));
vi.mock('../automation/policy.ts', () => ({ loanExceedsSpend: vi.fn() }));
vi.mock('../automation/actions/common.ts', () => ({ AUTOMATION_SESSION_ID: 'automation-session' }));
vi.mock('../ledger/index.ts', () => ({ bookedBalance: vi.fn() }));
vi.mock('../vouchers/lifecycle.ts', () => ({ actualAmountProblem: vi.fn() }));
vi.mock('../accounts.ts', () => ({ assertAccountAllowedForCompany: vi.fn(), assertGroupAccountForCompany: vi.fn() }));
vi.mock('../events/index.ts', () => ({ emitVoucherEvent: vi.fn() }));
vi.mock('../links/index.ts', () => ({ emitLoanSettledAfterPayment: vi.fn() }));

import { assignUsers, newStep } from './index.ts';
import { dropVacantSteps } from './state-machine.ts';

const CTA = 'a'.repeat(24);
const doc = { company_id: CTA, kind: 'spend' } as unknown as DomainDoc;

const chain = (roles: StepRow['role'][]): StepRow[] => roles.map((role, i) => newStep(i + 1, role, i === 0 ? 'current' : 'waiting'));
const assign = (user_id: string, role: StepRow['role']) => ({ user_id, role, company_id: CTA, status: 'active' });
const person = (id: string) => ({ _id: id, status: 'active' });
const roles = (steps: StepRow[]) => steps.map((s) => s.role);

describe('assignUsers — Chủ tịch chỉ vào chuỗi theo ngưỡng, không do đẩy cấp', () => {
  beforeEach(() => {
    // CTA có KTT và GĐ; không có PGĐ, P.TGĐ. Chủ tịch (cấp Tập đoàn) đang có người.
    db.state.assignments = [assign('u-ktt', 'chief_accountant'), assign('u-gd', 'director'), assign('u-ct', 'chairman')];
    db.state.users = [person('u-ktt'), person('u-gd'), person('u-ct')];
  });

  it('khoản dưới ngưỡng, P.TGĐ khuyết: chuỗi chỉ còn KTT → GĐ, không thêm Chủ tịch', async () => {
    const assigned = await assignUsers(chain(['chief_accountant', 'deputy_director', 'director', 'deputy_chairman']), doc);
    expect(roles(dropVacantSteps(assigned).steps)).toEqual(['chief_accountant', 'director']);
  });

  it('phiếu dưới 50 triệu (KTT → PGĐ), CTA khuyết PGĐ: KTT là cấp cuối, không thêm GĐ hay P.TGĐ', async () => {
    const assigned = await assignUsers(chain(['chief_accountant', 'deputy_director']), doc);
    expect(roles(dropVacantSteps(assigned).steps)).toEqual(['chief_accountant']);
  });

  it('bước cao nhất khuyết nhưng KTT còn người: chỉ bỏ bước khuyết, không đẩy lên P.TGĐ', async () => {
    db.state.assignments = [assign('u-ktt', 'chief_accountant'), assign('u-ptg', 'deputy_chairman'), assign('u-ct', 'chairman')];
    db.state.users = [person('u-ktt'), person('u-ptg'), person('u-ct')];
    const assigned = await assignUsers(chain(['chief_accountant', 'director']), doc);
    expect(roles(dropVacantSteps(assigned).steps)).toEqual(['chief_accountant']);
  });

  it('cả chuỗi không còn ai có người phụ trách: bước cao nhất khuyết đẩy lên cấp cao hơn còn người (P.TGĐ)', async () => {
    db.state.assignments = [assign('u-ptg', 'deputy_chairman'), assign('u-ct', 'chairman')];
    db.state.users = [person('u-ptg'), person('u-ct')];
    const assigned = await assignUsers(chain(['chief_accountant', 'director']), doc);
    expect(roles(dropVacantSteps(assigned).steps)).toEqual(['deputy_chairman']);
  });

  it('khoản vượt ngưỡng: bước Chủ tịch do ma trận thêm vào được giữ nguyên', async () => {
    const assigned = await assignUsers(chain(['chief_accountant', 'director', 'chairman']), doc);
    expect(roles(dropVacantSteps(assigned).steps)).toEqual(['chief_accountant', 'director', 'chairman']);
  });

  it('cả chuỗi không còn ai có người phụ trách: Chủ tịch là cấp cuối còn người (không duyệt xong khi gửi)', async () => {
    db.state.assignments = [assign('u-ct', 'chairman')];
    db.state.users = [person('u-ct')];
    const assigned = await assignUsers(chain(['chief_accountant', 'director', 'deputy_chairman']), doc);
    expect(roles(dropVacantSteps(assigned).steps)).toEqual(['chairman']);
  });

  it('chạy lại: chuỗi đã có cấp đã duyệt (bước done giữ nguyên) thì không đẩy lên Chủ tịch', async () => {
    db.state.assignments = [assign('u-ct', 'chairman')];
    db.state.users = [person('u-ct')];
    const assigned = await assignUsers(chain(['director', 'deputy_chairman']), doc, { decidedApprover: true });
    expect(dropVacantSteps(assigned).steps).toEqual([]);
  });
});

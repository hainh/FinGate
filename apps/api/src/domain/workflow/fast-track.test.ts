import { describe, expect, it } from 'vitest';
import { documentPermissions } from '../entitlement/index.ts';
import { applyDecision, recalcStatusFromSteps, type StepState } from './state-machine.ts';

/** Chuỗi duyệt mặc định: KTT (đang xử lý) → PGĐ → GĐ (đều đang chờ). */
function chain(): { order: number; role: 'chief_accountant' | 'deputy_director' | 'director'; state: string; user_id: string }[] {
  return [
    { order: 1, role: 'chief_accountant', state: 'current', user_id: 'u1' },
    { order: 2, role: 'deputy_director', state: 'waiting', user_id: 'u2' },
    { order: 3, role: 'director', state: 'waiting', user_id: 'u3' },
  ];
}

const states = (steps: StepState[]) => steps.map((s) => `${s.order}:${s.state}`);

describe('applyDecision — duyệt vượt cấp (v2 §7.2)', () => {
  it('PGĐ duyệt trước khi KTT xong: KTT vẫn đang xử lý, không có hai cấp `current`, không bỏ qua cấp nào', () => {
    const r = applyDecision(chain(), 2, 'approve', { fastTrack: true });
    expect(states(r.steps)).toEqual(['1:current', '2:done', '3:waiting']);
    expect(r.finished).toBe(false);
    expect(recalcStatusFromSteps(r.steps)).toBe('pending.ktt');
  });

  it('sau khi KTT duyệt, cấp thấp nhất còn chờ (GĐ) mới thành `current`', () => {
    const afterFastTrack = applyDecision(chain(), 2, 'approve', { fastTrack: true }).steps;
    const r = applyDecision(afterFastTrack, 1, 'approve');
    expect(states(r.steps)).toEqual(['1:done', '2:done', '3:current']);
    expect(r.finished).toBe(false);
    expect(recalcStatusFromSteps(r.steps)).toBe('pending.gd');
  });

  it('GĐ (cấp cuối) duyệt vượt cấp có lý do ⇒ cấp chưa xử lý thành `skipped`, phiếu đã duyệt', () => {
    const r = applyDecision(chain(), 3, 'approve', { fastTrack: true });
    expect(states(r.steps)).toEqual(['1:skipped', '2:skipped', '3:done']);
    expect(r.finished).toBe(true);
  });

  it('duyệt thường ở cấp cuối khi các cấp dưới đã xong ⇒ hoàn tất, không đánh dấu bỏ qua', () => {
    const steps = [
      { order: 1, role: 'chief_accountant' as const, state: 'done', user_id: 'u1' },
      { order: 2, role: 'deputy_director' as const, state: 'done', user_id: 'u2' },
      { order: 3, role: 'director' as const, state: 'current', user_id: 'u3' },
    ];
    const r = applyDecision(steps, 3, 'approve');
    expect(states(r.steps)).toEqual(['1:done', '2:done', '3:done']);
    expect(r.finished).toBe(true);
  });

  it('duyệt thường KHÔNG bỏ qua cấp chưa xử lý phía dưới (chỉ fast-track có lý do mới được)', () => {
    const steps = [
      { order: 1, role: 'chief_accountant' as const, state: 'done', user_id: 'u1' },
      { order: 2, role: 'deputy_director' as const, state: 'current', user_id: 'u2' },
      { order: 3, role: 'director' as const, state: 'waiting', user_id: 'u3' },
    ];
    const r = applyDecision(steps, 3, 'approve');
    expect(r.steps.some((s) => s.state === 'skipped')).toBe(false);
    expect(r.finished).toBe(false);
    expect(states(r.steps)).toEqual(['1:done', '2:current', '3:done']);
  });
});

describe('documentPermissions — approve chỉ cho bước đang xử lý; bước chờ chỉ duyệt vượt cấp', () => {
  const doc = (steps: ReturnType<typeof chain>) => ({
    status: 'pending.ktt',
    created_by: 'creator',
    amount_minor: 1_000_000n,
    steps,
    evidence_missing: [] as string[],
    company_id: 'A',
    actor_companies: ['A'],
    delegatedStepOrders: [] as number[],
    approved_from_ktt_up: false,
  });
  const actor = (user_id: string, role: 'chief_accountant' | 'deputy_director' | 'director') => ({
    user_id,
    permissions: ['doc:read', 'approval:act'],
    amount_limit_minor: 10n ** 12n,
    role,
  });

  it('KTT (đang xử lý): duyệt thường được, không có "Duyệt trước"', () => {
    const p = documentPermissions(actor('u1', 'chief_accountant'), doc(chain()));
    expect(p.approve).toBe(true);
    expect(p.fast_track).toBe(false);
  });

  it('PGĐ (đang chờ, cấp trên KTT): KHÔNG duyệt thường được, chỉ "Duyệt trước"', () => {
    const p = documentPermissions(actor('u2', 'deputy_director'), doc(chain()));
    expect(p.approve).toBe(false);
    expect(p.fast_track).toBe(true);
  });

  it('GĐ (đang chờ, cấp cuối): chỉ "Duyệt trước"', () => {
    const p = documentPermissions(actor('u3', 'director'), doc(chain()));
    expect(p.approve).toBe(false);
    expect(p.fast_track).toBe(true);
  });

  it('khi đã đến lượt PGĐ thì PGĐ duyệt thường được', () => {
    const steps = chain().map((s) => (s.order === 1 ? { ...s, state: 'done' } : s.order === 2 ? { ...s, state: 'current' } : s));
    const p = documentPermissions(actor('u2', 'deputy_director'), doc(steps));
    expect(p.approve).toBe(true);
    expect(p.fast_track).toBe(false);
  });
});

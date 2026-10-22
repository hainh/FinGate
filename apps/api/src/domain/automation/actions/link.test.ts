import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Mô hình hoá domain liên kết: danh sách liên kết hiện có, các lần tạo / gỡ được ghi nhận. */
const { links, created, removed } = vi.hoisted(() => ({
  links: [] as Record<string, unknown>[],
  created: [] as Record<string, unknown>[],
  removed: [] as Record<string, unknown>[],
}));

vi.mock('../../../db/models.ts', () => ({ Models: {} }));
vi.mock('../../links/index.ts', () => ({
  RELATION_SPECS: {
    disbursement: { amount: true },
    funded_by: { amount: true },
    generated: { amount: false },
    internal_transfer: { amount: false },
  },
  listLinksFor: vi.fn(async () => links),
  createLink: vi.fn(async (input: Record<string, unknown>) => {
    created.push(input);
    return { ...input, _id: `link-${created.length}` };
  }),
  removeLink: vi.fn(async (input: Record<string, unknown>) => {
    removed.push(input);
    return {};
  }),
}));

import { ensureAutomationLink, ensureManualLink } from './link.ts';

const actor = { user_id: 'u1', name: 'Kế toán trưởng', role: 'chief_accountant' };
const from = { type: 'document' as const, id: 'phieu-thu-1' };
const to = { type: 'bank_debt' as const, id: 'nhd-1' };
const amount = 50_000_000n;

/** Liên kết giải ngân đang hiệu lực từ phiếu thu tới khoản vay (mặc định số tiền 50 triệu). */
function existingLink(over: Record<string, unknown>): Record<string, unknown> {
  return {
    _id: 'old-1',
    status: 'active',
    relation: 'disbursement',
    from_type: 'document',
    from_id: 'phieu-thu-1',
    to_type: 'bank_debt',
    to_id: 'nhd-1',
    amount_minor: amount,
    origin: 'automation',
    ...over,
  };
}

beforeEach(() => {
  links.length = 0;
  created.length = 0;
  removed.length = 0;
});

describe('liên kết nghiệp vụ › nguồn Thủ công / Tự động (v2 §11.2)', () => {
  it('người dùng chọn khoản có sẵn ⇒ nguồn Thủ công, không có lượt chạy hay mã quy tắc', async () => {
    await ensureManualLink({ from, to, relation: 'disbursement', amountMinor: amount, actor, requestId: 'k1' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ origin: 'manual', run_id: null, rule_code: null });
  });

  it('quy tắc tạo liên kết ⇒ nguồn Tự động, ghi lượt chạy và mã quy tắc', async () => {
    await ensureAutomationLink({ from, to, relation: 'disbursement', amountMinor: amount, runId: 'run-1', ruleCode: 'R2', actor, requestId: 'k1' });
    expect(created[0]).toMatchObject({ origin: 'automation', run_id: 'run-1', rule_code: 'R2' });
  });

  it('liên kết Tự động cũ được ghi lại thành Thủ công khi người dùng chọn tay (cùng số tiền)', async () => {
    links.push(existingLink({ origin: 'automation' }));
    await ensureManualLink({ from, to, relation: 'disbursement', amountMinor: amount, actor, requestId: 'k1' });
    expect(removed).toHaveLength(1);
    expect(created[0]).toMatchObject({ origin: 'manual', run_id: null, rule_code: null });
  });

  it('quy tắc không hạ liên kết Thủ công xuống Tự động: cùng số tiền ⇒ giữ nguyên', async () => {
    links.push(existingLink({ origin: 'manual' }));
    const out = await ensureAutomationLink({ from, to, relation: 'disbursement', amountMinor: amount, runId: 'run-2', ruleCode: 'R2', actor, requestId: 'k2' });
    expect(out).toMatchObject({ origin: 'manual' });
    expect(removed).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it('quy tắc đổi số tiền trên liên kết Thủ công ⇒ gỡ rồi tạo lại, vẫn nguồn Thủ công', async () => {
    links.push(existingLink({ origin: 'manual', amount_minor: 30_000_000n }));
    await ensureAutomationLink({ from, to, relation: 'disbursement', amountMinor: amount, runId: 'run-3', ruleCode: 'R2', actor, requestId: 'k3' });
    expect(removed).toHaveLength(1);
    expect(created[0]).toMatchObject({ origin: 'manual', amount_minor: amount, run_id: null, rule_code: null });
  });

  it('đã có đúng số tiền và đúng nguồn ⇒ dùng lại, không gỡ / tạo thêm', async () => {
    links.push(existingLink({ origin: 'automation' }));
    const out = await ensureAutomationLink({ from, to, relation: 'disbursement', amountMinor: amount, runId: 'run-4', ruleCode: 'R2', actor, requestId: 'k4' });
    expect(out).toMatchObject({ _id: 'old-1', origin: 'automation' });
    expect(created).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });
});

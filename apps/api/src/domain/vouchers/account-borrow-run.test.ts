/**
 * R8 · đối tác của hai phiếu mượn tiền phát sinh (§29 — phiếu phát sinh phải có đối tác hợp lệ).
 *
 * Phiếu chi B → A và phiếu thu vào A (cùng công ty) mỗi phiếu mang đối tác "Công ty trong tập đoàn" trỏ
 * tài khoản NHẬN của chính phiếu đó — dùng đối tác đã có, thiếu thì tự tạo. Không ghi `transfer_target`
 * để R1 không sinh thêm phiếu thu đối ứng trùng với phiếu thu của R8.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const COMPANY = 'a'.repeat(24);
const ACCT_A = 'b'.repeat(24); // TK chi của phiếu gốc (nhận tiền mượn)
const ACCT_B = 'c'.repeat(24); // TK cho mượn
const PARTNER_TO_A = 'd'.repeat(24); // đối tác internal trỏ TK A
const PARTNER_TO_B = 'e'.repeat(24); // đối tác internal trỏ TK B

const state = vi.hoisted(() => ({
  /** `partner_id` trả theo từng tài khoản nguồn của đối tác. */
  partners: {} as Record<string, string | null>,
  ensureCalls: [] as Record<string, unknown>[],
  voucherSpecs: [] as Record<string, unknown>[],
}));

vi.mock('../partner/internal.ts', () => ({
  ensureInternalPartner: async (input: Record<string, unknown>) => {
    state.ensureCalls.push(input);
    const accountId = String(input.accountId);
    return { partner_id: state.partners[accountId] ?? null, created: false, skipped: state.partners[accountId] ? null : 'account-unusable' };
  },
}));

vi.mock('../../db/models.ts', () => ({
  Models: {
    BankAccount: { findById: () => ({ select: () => ({ lean: async () => ({ bank_name: 'Vietcombank', account_number: '0123456', account_name: 'TK' }) }) }) },
    Document: { findOne: () => ({ select: () => ({ lean: async () => null }) }) },
  },
}));

vi.mock('../automation/actions/voucher.ts', () => ({
  createAutoVoucher: async (spec: Record<string, unknown>) => {
    state.voucherSpecs.push(spec);
    return { id: `doc-${spec.kind}`, code: `PT-${state.voucherSpecs.length}` };
  },
  executeAutoVoucher: async () => 'paid',
}));

vi.mock('../automation/actions/lookup.ts', () => ({ fundOfAccount: async () => 'bank' }));

import { runAccountBorrowBeforePay } from './account-borrow-run.ts';

const doc = {
  _id: 'pc1',
  code: 'PC-2026-00001',
  company_id: COMPANY,
  created_by: 'u1',
  amount: { currency: 'VND', decimals: 0 },
  options: { account_borrow: { account_id: ACCT_B, amount_minor: null } },
  approval: { steps: [] },
};

const actor = { user_id: 'u1', name: 'KTV', role: 'staff' };

async function run(): Promise<void> {
  await runAccountBorrowBeforePay({ doc, payAccountId: ACCT_A, actualMinor: 2_000_000n, paidAt: '2026-11-26', actor, requestId: 'req-1' });
}

beforeEach(() => {
  state.partners = { [ACCT_A]: PARTNER_TO_A, [ACCT_B]: PARTNER_TO_B };
  state.ensureCalls = [];
  state.voucherSpecs = [];
});

describe('R8 · hai phiếu mượn tiền có đối tác "Công ty trong tập đoàn"', () => {
  it('phiếu chi B→A gắn đối tác trỏ TK A; phiếu thu vào A gắn đối tác trỏ TK B (cùng công ty của phiếu gốc)', async () => {
    await run();

    expect(state.ensureCalls.map((c) => c.accountId)).toEqual([ACCT_A, ACCT_B]);
    expect(state.ensureCalls.every((c) => String(c.ownerCompanyId) === COMPANY), 'đối tác quản lý theo công ty của phiếu').toBe(true);

    const [spend, receipt] = state.voucherSpecs;
    expect(spend).toMatchObject({ kind: 'spend', accountId: ACCT_B, partnerId: PARTNER_TO_A });
    expect(receipt).toMatchObject({ kind: 'income', accountId: ACCT_A, partnerId: PARTNER_TO_B });
  });

  it('không ghi transfer_target trên phiếu phát sinh (R1 sẽ sinh trùng phiếu thu)', async () => {
    await run();

    expect(state.voucherSpecs.every((s) => !('transfer_target' in s)), 'createAutoVoucher luôn ghi transfer_target = null').toBe(true);
  });

  it('tài khoản không tạo được đối tác ⇒ phiếu vẫn sinh và vẫn được thực thi (không chặn việc chi)', async () => {
    state.partners = {};
    await run();

    expect(state.voucherSpecs).toHaveLength(2);
    expect(state.voucherSpecs.every((s) => s.partnerId === null)).toBe(true);
  });
});

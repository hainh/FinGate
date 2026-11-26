/**
 * R1 · đối tác của phiếu thu đối ứng (§11.6 + yêu cầu "phiếu phát sinh phải có đối tác hợp lệ").
 *
 * Phiếu thu sinh ở công ty NHẬN phải mang đối tác "Công ty trong tập đoàn" trỏ tài khoản đã chuyển tiền đi,
 * quản lý tại công ty nhận — dùng đối tác đã có, chưa có thì rule tự tạo. Tài khoản nguồn không dùng được
 * (TK nhóm / đã đóng) ⇒ rule không chết, phiếu vẫn sinh với `partner_id = null` như trước.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const COMPANY_A = 'a'.repeat(24); // công ty chuyển tiền đi (công ty phiếu chi)
const COMPANY_B = 'b'.repeat(24); // công ty nhận
const ACCT_A = 'c'.repeat(24); // tài khoản nguồn của phiếu chi
const ACCT_B = 'd'.repeat(24); // tài khoản nhận của công ty B
const INTERNAL_PARTNER = 'e'.repeat(24);

const state = vi.hoisted(() => ({
  /** Đối tác nội bộ mà `ensureInternalPartner` trả (null = không tạo được, mô phỏng TK không dùng được). */
  ensuredPartnerId: 'e'.repeat(24) as string | null,
  /** Các lần gọi `ensureInternalPartner`. */
  ensureCalls: [] as Record<string, unknown>[],
  /** Các spec gửi xuống `createAutoVoucher`. */
  voucherSpecs: [] as Record<string, unknown>[],
  /** Bước của từng quy tắc đã đăng ký. */
  steps: {} as Record<string, { name: string; run: (ctx: never) => Promise<unknown> }[]>,
  /** `transfer_target` của phiếu nguồn cho từng ca (khác công ty / cùng công ty). */
  targetCompanyId: 'b'.repeat(24),
}));

vi.mock('../../partner/internal.ts', () => ({
  ensureInternalPartner: async (input: Record<string, unknown>) => {
    state.ensureCalls.push(input);
    return { partner_id: state.ensuredPartnerId, created: Boolean(state.ensuredPartnerId), skipped: state.ensuredPartnerId ? null : 'account-unusable' };
  },
}));

vi.mock('../../accounts.ts', () => ({ assertAccountAllowedForCompany: async () => undefined }));

vi.mock('../actions/voucher.ts', () => ({
  createAutoVoucher: async (spec: Record<string, unknown>) => {
    state.voucherSpecs.push(spec);
    return { id: 'receipt1', code: 'PT-2026-00001' };
  },
  executeAutoVoucher: async () => 'paid',
  findAutoVoucher: async () => null,
  todayVn: () => '2026-11-26',
}));

vi.mock('../actions/lookup.ts', () => ({
  loadVoucher: async () => ({
    _id: 'pc1',
    code: 'PC-2026-00001',
    kind: 'spend',
    company_id: 'a'.repeat(24),
    status: 'paid',
    version: 3,
    title: 'Chuyển sang CTB',
    purpose: 'Chuyển nội bộ',
    partner_id: 'e'.repeat(24),
    amount: { minor: '1500000', currency: 'VND', decimals: 0 },
    source: { fund: 'bank', account_id: 'c'.repeat(24) },
    transfer_target: { company_id: state.targetCompanyId, account_id: 'd'.repeat(24) },
    approval: { steps: [] },
    execution: { paid_at: '2026-11-25', actual_amount_minor: '1500000' },
    history: [],
  }),
  companyView: async () => ({ id: 'a'.repeat(24), name: 'Công ty A', code: 'CTA' }),
  fundOfAccount: async () => 'bank',
}));

vi.mock('../actions/common.ts', () => ({
  actorOfEvent: () => ({ user_id: 'u1', name: 'KTV', role: 'staff' }),
  big: (v: unknown) => BigInt(String(v ?? '0')),
}));

vi.mock('../actions/link.ts', () => ({ ensureAutomationLink: async () => ({ created: true }) }));

vi.mock('../engine.ts', () => ({
  registerRule: (code: string, def: { steps: { name: string; run: (ctx: never) => Promise<unknown> }[] }) => {
    state.steps[code] = def.steps;
  },
}));

import './r1-internal-transfer.ts';

const stepCtx = { event: { subject_id: 'pc1', type: 'voucher.paid', payload: {} }, outputs: {}, runId: 'run-1', stepKey: 'run-1:create_voucher', params: {} } as never;

async function runCreateVoucher(): Promise<void> {
  await (state.steps.R1 ?? []).find((s) => s.name === 'create_voucher')!.run(stepCtx);
}

beforeEach(() => {
  state.ensuredPartnerId = INTERNAL_PARTNER;
  state.ensureCalls = [];
  state.voucherSpecs = [];
  state.targetCompanyId = COMPANY_B;
});

describe('R1 · phiếu thu đối ứng mang đối tác "Công ty trong tập đoàn"', () => {
  it('đối tác nội bộ của tài khoản nguồn được gắn vào phiếu thu sinh ở công ty NHẬN', async () => {
    await runCreateVoucher();

    expect(state.ensureCalls).toHaveLength(1);
    expect(state.ensureCalls[0]).toMatchObject({ ownerCompanyId: COMPANY_B, accountId: ACCT_A, source: 'R1' });
    expect(state.voucherSpecs[0]).toMatchObject({ kind: 'income', companyId: COMPANY_B, accountId: ACCT_B, partnerId: INTERNAL_PARTNER });
  });

  it('tài khoản nguồn không dùng được (rule trả null) ⇒ phiếu vẫn sinh, đối tác trống như trước', async () => {
    state.ensuredPartnerId = null;
    await runCreateVoucher();

    expect(state.voucherSpecs[0]).toMatchObject({ kind: 'income', partnerId: null });
    expect(state.ensureCalls[0]).toMatchObject({ ownerCompanyId: COMPANY_B, accountId: ACCT_A });
  });

  it('chuyển giữa hai tài khoản CÙNG công ty: vẫn tra đối tác theo công ty của phiếu + TK nguồn', async () => {
    state.targetCompanyId = COMPANY_A; // đích trùng công ty phiếu
    await runCreateVoucher();

    expect(state.ensureCalls[0]).toMatchObject({ ownerCompanyId: COMPANY_A, accountId: ACCT_A });
    expect(state.voucherSpecs[0]).toMatchObject({ companyId: COMPANY_A, partnerId: INTERNAL_PARTNER });
  });
});

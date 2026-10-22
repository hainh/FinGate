import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Mô hình: liên kết hiệu lực từ phiếu nguồn tới khoản vay, khoản vay theo id; ghi nhận các lần huỷ / gỡ liên kết. */
const { model, cancelled, unlinked } = vi.hoisted(() => ({
  model: {
    links: [] as { source: string; relation: string; linkId: string; loanId: string; origin: 'automation' | 'manual' }[],
    loans: new Map<string, Record<string, unknown>>(),
  },
  cancelled: [] as string[],
  unlinked: [] as string[],
}));

vi.mock('./loan.ts', () => ({
  activeLoanLinks: async (source: string, relation: string) =>
    model.links
      .filter((l) => l.source === source && l.relation === relation)
      .map((l) => ({ linkId: l.linkId, loanId: l.loanId, amountMinor: null, origin: l.origin })),
  loadLoan: async (id: string) => model.loans.get(id) ?? null,
  automationLoansOfSource: async (source: string) => [...model.loans.values()].filter((l) => l.origin === 'automation' && l.source_document_id === source),
  cancelLoan: async ({ loanId }: { loanId: string }) => {
    cancelled.push(loanId);
    const loan = model.loans.get(loanId);
    if (!loan || loan.status !== 'pending_disbursement') return 'skipped';
    loan.status = 'cancelled';
    return 'cancelled';
  },
}));

vi.mock('./link.ts', () => ({
  unlinkAutomationLink: async ({ linkId }: { linkId: string }) => {
    unlinked.push(linkId);
    model.links = model.links.filter((l) => l.linkId !== linkId);
    return true;
  },
}));

import { alertLoansOfSource, loansFromSource, releaseLoansOfSource } from './source.ts';

const actor = { user_id: 'u1', name: 'Kế toán trưởng', role: 'chief_accountant' };
const disbursedAt = new Date('2026-10-01T03:00:00Z');

/** Khoản vay ở dạng đọc được cho bước (các trường R6 dùng). */
function loan(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    code: `NHD-${id}`,
    company_id: 'cty-a',
    partner_id: 'nh-1',
    bank_name: 'Ngân hàng A',
    status: 'pending_disbursement',
    currency: 'VND',
    principal_minor: 200_000_000n,
    disbursed_at: null,
    maturity_date: '2027-12-31',
    origin: 'manual',
    rule_code: null,
    run_id: null,
    source_document_id: null,
    ...over,
  };
}

function seed(loans: Record<string, unknown>[], links: typeof model.links = []): void {
  model.loans.clear();
  for (const l of loans) model.loans.set(String(l.id), l);
  model.links = links;
}

/** Yêu cầu R6 cho phiếu nguồn đã bị từ chối / huỷ. */
const finalised = (sourceId: string, reason = `Phiếu thu ${sourceId} bị từ chối`) => ({ sourceId, reason, actor, requestId: `r6#${sourceId}` });

beforeEach(() => {
  cancelled.length = 0;
  unlinked.length = 0;
  seed([]);
});

describe('actions/source › R6: khoản vay của phiếu nguồn đã huỷ / từ chối', () => {
  it('khoản TẠO TAY đã Đang vay, gắn thủ công vào phiếu thu bị từ chối ⇒ chỉ gỡ liên kết; khoản giữ nguyên, không huỷ, không cảnh báo (R2-50)', async () => {
    seed(
      [loan('K1', { status: 'active', disbursed_at: disbursedAt })],
      [{ source: 'PT-B', relation: 'disbursement', linkId: 'L1', loanId: 'K1', origin: 'manual' }],
    );
    expect(await releaseLoansOfSource(finalised('PT-B'))).toBeNull();
    expect(unlinked).toEqual(['L1']);
    expect(cancelled).toEqual([]);
    expect(model.loans.get('K1')?.status).toBe('active');
    expect(await alertLoansOfSource('PT-B')).toEqual([]);
  });

  it('khoản tạo tay chờ giải ngân, gắn thủ công vào phiếu đã từ chối ⇒ gỡ liên kết, không huỷ khoản vay', async () => {
    seed([loan('K2')], [{ source: 'PT-C', relation: 'disbursement', linkId: 'L2', loanId: 'K2', origin: 'manual' }]);
    expect(await releaseLoansOfSource(finalised('PT-C'))).toBeNull();
    expect(unlinked).toEqual(['L2']);
    expect(cancelled).toEqual([]);
    expect(model.loans.get('K2')?.status).toBe('pending_disbursement');
  });

  it('khoản do phiếu thu KHÁC sinh ra, phiếu này chỉ gắn thủ công vào ⇒ chỉ gỡ liên kết của phiếu này; khoản của phiếu kia không bị huỷ', async () => {
    seed(
      [loan('K3', { origin: 'automation', rule_code: 'R2', source_document_id: 'PT-A' })],
      [{ source: 'PT-B', relation: 'disbursement', linkId: 'L3', loanId: 'K3', origin: 'manual' }],
    );
    expect(await releaseLoansOfSource(finalised('PT-B'))).toBeNull();
    expect(unlinked).toEqual(['L3']);
    expect(cancelled).toEqual([]);
    expect(model.loans.get('K3')?.status).toBe('pending_disbursement');
  });

  it('khoản do quy tắc sinh từ phiếu chi, đã có tiền ⇒ chỉ cảnh báo, giữ liên kết, không huỷ (§11.5); khoản xuất hiện một lần dù có cả liên kết lẫn khoản tự sinh', async () => {
    seed(
      [loan('K4', { status: 'active', origin: 'automation', rule_code: 'R3', source_document_id: 'PC-S', disbursed_at: disbursedAt })],
      [{ source: 'PC-S', relation: 'funded_by', linkId: 'L4', loanId: 'K4', origin: 'automation' }],
    );
    const spend = finalised('PC-S', 'Phiếu chi PC-S bị huỷ');
    const found = await loansFromSource('PC-S');
    expect(found).toEqual([expect.objectContaining({ linkId: 'L4', linkOrigin: 'automation', generated: true })]);
    expect(await releaseLoansOfSource(spend)).toBeNull();
    expect(unlinked).toEqual([]);
    expect(cancelled).toEqual([]);
    expect((await alertLoansOfSource('PC-S')).map((s) => s.loan.id)).toEqual(['K4']);
  });

  it('khoản do quy tắc sinh từ phiếu, chưa có tiền, dù liên kết đã bị gỡ ⇒ vẫn HUỶ khoản vay; không cảnh báo', async () => {
    seed([loan('K5', { status: 'pending_disbursement', origin: 'automation', rule_code: 'R2', source_document_id: 'PT-E' })], []);
    expect(await releaseLoansOfSource(finalised('PT-E'))).toBe('K5');
    expect(cancelled).toEqual(['K5']);
    expect(model.loans.get('K5')?.status).toBe('cancelled');
    expect(await alertLoansOfSource('PT-E')).toEqual([]);
  });

  it('liên kết TỰ ĐỘNG từ phiếu không phải phiếu sinh ra (VD phiếu thu do R3 sinh, khoản do phiếu chi sinh) chưa có tiền ⇒ huỷ khoản vay như trước', async () => {
    seed(
      [loan('K6', { status: 'pending_disbursement', origin: 'automation', rule_code: 'R3', source_document_id: 'PC-F' })],
      [{ source: 'PT-G', relation: 'disbursement', linkId: 'L6', loanId: 'K6', origin: 'automation' }],
    );
    expect(await releaseLoansOfSource(finalised('PT-G'))).toBe('K6');
    expect(cancelled).toEqual(['K6']);
    expect(unlinked).toEqual([]);
  });
});

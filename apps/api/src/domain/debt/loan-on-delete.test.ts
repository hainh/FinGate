import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Mô hình: liên kết (phiếu → khoản vay), phiếu theo trạng thái, khoản vay theo id; ghi nhận cập nhật và audit. */
const { links, docs, loans, audits } = vi.hoisted(() => ({
  links: [] as { from_type: string; from_id: string; to_type: string; to_id: string; relation: string; status: string }[],
  docs: new Map<string, { status: string }>(),
  loans: new Map<string, Record<string, unknown>>(),
  audits: [] as Record<string, unknown>[],
}));

/** So khớp bộ lọc đơn giản: giá trị bằng nhau, hoặc `{ $ne }`. */
function matches(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([k, v]) => {
    if (v && typeof v === 'object' && '$ne' in (v as object)) return String(row[k]) !== String((v as { $ne: unknown }).$ne);
    return String(row[k]) === String(v);
  });
}

function query<T>(value: T) {
  return { select: () => query(value), lean: async () => value };
}

vi.mock('../../db/models.ts', () => ({
  Models: {
    BusinessLink: {
      find: (filter: Record<string, unknown>) => query(links.filter((l) => matches(l as never, filter))),
    },
    BankDebt: {
      findById: (id: string) => query(loans.get(id) ?? null),
      updateOne: (filter: Record<string, unknown>, update: { $set: Record<string, unknown>; $push: { history: unknown } }) => ({
        exec: async () => {
          const loan = loans.get(String(filter._id));
          if (!loan || loan.status !== filter.status) return { modifiedCount: 0 };
          Object.assign(loan, update.$set);
          (loan.history as unknown[]).push(update.$push.history);
          return { modifiedCount: 1 };
        },
      }),
    },
  },
}));

vi.mock('./loads.ts', () => ({
  loadDocs: async (ids: Iterable<unknown>) => {
    const out = new Map<string, { _id: string; status: string }>();
    for (const id of ids) {
      const key = String(id);
      const d = docs.get(key);
      if (d) out.set(key, { _id: key, ...d });
    }
    return out;
  },
}));

vi.mock('../audit/index.ts', () => ({
  buildHistoryEntry: (input: Record<string, unknown>) => ({ ...input }),
  mirrorAudit: async (entry: Record<string, unknown>) => {
    audits.push(entry);
  },
}));

import { loansToRevertOnDelete, revertLoansOnDelete } from './loan-on-delete.ts';

const actor = { user_id: 'u1', name: 'Chủ tịch', role: 'chairman' };

function link(from: string, to: string, relation: string, status = 'active'): void {
  links.push({ from_type: 'document', from_id: from, to_type: 'bank_debt', to_id: to, relation, status });
}

function loan(id: string, over: Record<string, unknown> = {}): void {
  loans.set(id, { code: `NHD-${id}`, company_id: 'cty-a', status: 'active', disbursed_at: new Date('2026-10-01'), outstanding_minor: 200n, history: [], ...over });
}

beforeEach(() => {
  links.length = 0;
  docs.clear();
  loans.clear();
  audits.length = 0;
});

describe('xoá phiếu giải ngân', () => {
  it('khoản active chỉ được giải ngân bởi phiếu này ⇒ về chờ giải ngân, có lịch sử và audit', async () => {
    docs.set('receipt', { status: 'paid' });
    loan('L1');
    link('receipt', 'L1', 'disbursement');

    const found = await loansToRevertOnDelete('receipt');
    expect(found).toEqual([{ _id: 'L1', code: 'NHD-L1', company_id: 'cty-a' }]);

    await revertLoansOnDelete(found, { actor, reason: 'Phiếu giải ngân DOC-1 đã bị xoá', requestId: 'req-1' });

    const after = loans.get('L1')!;
    expect(after.status).toBe('pending_disbursement');
    expect(after.disbursed_at).toBeNull();
    expect(after.outstanding_minor).toBe(0n);
    expect(after.history).toEqual([expect.objectContaining({ action: 'revert_disbursement', from: 'active', to: 'pending_disbursement', request_id: 'req-1' })]);
    expect(audits).toEqual([expect.objectContaining({ action: 'bank_debt.revert_disbursement', company_id: 'cty-a' })]);
  });

  it('khoản đã có phiếu trả nợ thực thi ⇒ chặn (FG-WF-001), không đổi gì', async () => {
    docs.set('receipt', { status: 'paid' });
    docs.set('repay', { status: 'paid' });
    loan('L1');
    link('receipt', 'L1', 'disbursement');
    link('repay', 'L1', 'repayment');

    await expect(loansToRevertOnDelete('receipt')).rejects.toMatchObject({ code: 'FG-WF-001' });
    expect(loans.get('L1')!.status).toBe('active');
  });

  it('phiếu trả nợ chưa thực thi không chặn', async () => {
    docs.set('receipt', { status: 'paid' });
    docs.set('repay', { status: 'approved' });
    loan('L1');
    link('receipt', 'L1', 'disbursement');
    link('repay', 'L1', 'repayment');

    expect(await loansToRevertOnDelete('receipt')).toHaveLength(1);
  });

  it('khoản còn phiếu giải ngân thực thi khác ⇒ giữ active', async () => {
    docs.set('receipt', { status: 'paid' });
    docs.set('receipt2', { status: 'paid' });
    loan('L1');
    link('receipt', 'L1', 'disbursement');
    link('receipt2', 'L1', 'disbursement');

    expect(await loansToRevertOnDelete('receipt')).toEqual([]);
  });

  it('phiếu chưa thực thi (không có tiền về) ⇒ không đụng khoản vay', async () => {
    docs.set('receipt', { status: 'approved' });
    loan('L1');
    link('receipt', 'L1', 'disbursement');

    expect(await loansToRevertOnDelete('receipt')).toEqual([]);
  });

  it('liên kết đã gỡ hoặc khoản không còn active ⇒ bỏ qua', async () => {
    docs.set('receipt', { status: 'paid' });
    loan('L1', { status: 'pending_disbursement' });
    loan('L2');
    link('receipt', 'L1', 'disbursement');
    link('receipt', 'L2', 'disbursement', 'removed');

    expect(await loansToRevertOnDelete('receipt')).toEqual([]);
  });

  it('chạy lại revert an toàn: khoản đã về chờ thì không ghi thêm', async () => {
    docs.set('receipt', { status: 'paid' });
    loan('L1');
    link('receipt', 'L1', 'disbursement');
    const found = await loansToRevertOnDelete('receipt');

    await revertLoansOnDelete(found, { actor, reason: 'xoá phiếu', requestId: null });
    await revertLoansOnDelete(found, { actor, reason: 'xoá phiếu', requestId: null });

    expect(loans.get('L1')!.history).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});

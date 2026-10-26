import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@fingate/shared';
import { deletePartner } from './index.ts';

/** Kho giả: chỉ các truy vấn mà `deletePartner` dùng để đếm tham chiếu và xoá. */
const db = vi.hoisted(() => ({
  partner: null as Record<string, unknown> | null,
  /** số phiếu có đối tác này làm NGƯỜI CHO VAY (`options.loan.lender_partner_id`) */
  lenderDocuments: 0,
  deletedIds: [] as string[],
}));

vi.mock('../../db/models.ts', () => {
  const zeroCount = () => ({ exec: async () => 0 });
  return {
    Models: {
      Partner: {
        findById: (id: string) => ({
          lean: async () => (db.partner && String(db.partner._id) === id ? db.partner : null),
        }),
        deleteOne: (filter: { _id: string }) => ({
          exec: async () => {
            db.deletedIds.push(String(filter._id));
            db.partner = null;
            return { deletedCount: 1 };
          },
        }),
        collection: { insertOne: async () => ({}) },
      },
      Document: {
        countDocuments: (filter: Record<string, unknown>) => ({
          exec: async () => ('options.loan.lender_partner_id' in filter ? db.lenderDocuments : 0),
        }),
      },
      DebtVoucher: { countDocuments: zeroCount },
      BankDebt: { countDocuments: zeroCount },
      RecurringRule: { countDocuments: zeroCount },
      BusinessLink: { countDocuments: zeroCount },
    },
  };
});

vi.mock('../audit/index.ts', () => ({ mirrorAudit: async () => undefined }));

const COMPANY = '6650a1b2c3d4e5f600000001';
const BANK = '6650a1b2c3d4e5f600000021';
const actor = { user_id: '6650a1b2c3d4e5f600000099', name: 'Tester', role: 'admin' };

beforeEach(() => {
  db.partner = {
    _id: BANK,
    company_id: COMPANY,
    code: 'DT-2026-00001',
    type: 'bank',
    status: 'active',
    name: 'NH Cho Vay',
    name_key: 'nh cho vay',
    history: [],
    updated_at: new Date(),
  };
  db.lenderDocuments = 0;
  db.deletedIds = [];
});

describe('deletePartner — ngân hàng chỉ là người cho vay trên phiếu vay', () => {
  it('còn phiếu vay ghi ngân hàng này làm người cho vay ⇒ không xoá (FG-PARTNER-002)', async () => {
    db.lenderDocuments = 1;

    const err = await deletePartner({ id: BANK, scopeCompanyIds: null, actor }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('FG-PARTNER-002');
    expect((err as ApiError).data).toMatchObject({ usage: { lender_documents: 1, documents: 0, links: 0 } });
    expect(db.deletedIds).toEqual([]);
    expect(db.partner).not.toBeNull();
  });

  it('không còn tham chiếu nào (kể cả người cho vay) ⇒ xoá được', async () => {
    await expect(deletePartner({ id: BANK, scopeCompanyIds: null, actor })).resolves.toBeUndefined();
    expect(db.deletedIds).toEqual([BANK]);
  });
});

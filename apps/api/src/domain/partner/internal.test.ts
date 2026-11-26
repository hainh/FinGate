import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Mô hình DB tối giản: đối tác (tra theo công ty + TK gốc), tài khoản gốc, công ty gốc. */
const db = vi.hoisted(() => ({
  partners: [] as Record<string, unknown>[],
  accounts: new Map<string, Record<string, unknown>>(),
  companies: new Map<string, Record<string, unknown>>(),
  created: [] as Record<string, unknown>[],
}));

vi.mock('../../db/models.ts', () => ({
  Models: {
    Partner: {
      findOne(filter: Record<string, unknown>) {
        return {
          select: () => ({
            lean: async () =>
              db.partners.find(
                (p) => String(p.company_id) === String(filter.company_id) && p.type === filter.type && String(p.internal_account_id) === String(filter.internal_account_id),
              ) ?? null,
          }),
        };
      },
      async create(doc: Record<string, unknown>) {
        const row = { _id: `partner${db.created.length + 1}`, ...doc };
        db.created.push(row);
        db.partners.push(row);
        return row;
      },
      find: () => ({ toArray: async () => db.partners }),
    },
    BankAccount: {
      findById(id: string) {
        const a = db.accounts.get(id) ?? null;
        return { select: () => ({ lean: async () => a }) };
      },
    },
    Company: {
      findById(id: string) {
        const c = db.companies.get(id) ?? null;
        return { select: () => ({ lean: async () => c }) };
      },
    },
    AuditLog: { create: async () => undefined },
  },
}));

vi.mock('../numbering/index.ts', () => ({ nextPartnerCode: async () => 'DT-2026-00001' }));

import { ensureInternalPartner, internalPartnerLookupFilter, internalPartnerName, internalSourceFilter, internalSyncSnapshot, type InternalSource } from './internal.ts';
import { snapshotOf } from './rules.ts';

const before = snapshotOf({ type: 'internal', name: 'Cty A · TK cũ', bank_name: 'VCB', account_number: '111', status: 'active' });
const usable: InternalSource = { company_id: 'c1', name: 'Cty A · TK VCB 2', bank_name: 'Techcombank', account_number: '222', usable: true };

describe('đối tác công ty trong tập đoàn', () => {
  it('tên hiển thị gộp công ty và tài khoản để phân biệt các TK cùng công ty', () => {
    expect(internalPartnerName('Công ty A', 'TK lương')).toBe('Công ty A · TK lương');
  });

  it('đồng bộ tên, ngân hàng, STK khi công ty / TK gốc đổi', () => {
    const next = internalSyncSnapshot(before, usable);
    expect(next).toMatchObject({ name: 'Cty A · TK VCB 2', bank_name: 'Techcombank', account_number: '222', status: 'active' });
  });

  it('TK gốc đóng ⇒ đối tác chuyển ngừng giao dịch', () => {
    const next = internalSyncSnapshot(before, { ...usable, usable: false });
    expect(next.status).toBe('inactive');
  });

  it('TK mở lại không tự bật lại đối tác đã ngừng', () => {
    const stopped = { ...before, status: 'inactive' as const };
    expect(internalSyncSnapshot(stopped, usable).status).toBe('inactive');
  });
});

describe('danh sách TK chọn làm nguồn — khớp tiêu chí khi tạo đối tác', () => {
  it('lấy cả TK ngân hàng lẫn tiền mặt, không lấy TK nhóm, chỉ TK đang hoạt động của đúng công ty đã chọn', () => {
    expect(internalSourceFilter('c1')).toEqual({ company_id: 'c1', is_group: { $ne: true }, status: 'active' });
  });
});

/* ============================ ensureInternalPartner (phiếu phát sinh) ============================ */

const OWNER = 'a'.repeat(24); // công ty quản lý đối tác = công ty của phiếu
const SRC_COMPANY = 'b'.repeat(24); // công ty gốc của tài khoản vừa chuyển tiền đi
const ACCT = 'c'.repeat(24);

function seedAccount(over: Record<string, unknown> = {}): void {
  db.accounts.set(ACCT, {
    company_id: SRC_COMPANY,
    is_group: false,
    kind: 'bank',
    status: 'active',
    bank_name: 'Vietcombank',
    account_name: 'TK thanh toán',
    account_number: '0123456789',
    ...over,
  });
  db.companies.set(SRC_COMPANY, { name: 'Công ty A' });
}

beforeEach(() => {
  db.partners.length = 0;
  db.created.length = 0;
  db.accounts.clear();
  db.companies.clear();
});

describe('internalPartnerLookupFilter — khoá dùng lại đối tác nội bộ', () => {
  it('khớp theo công ty QUẢN LÝ đối tác + loại internal + đúng tài khoản gốc', () => {
    expect(internalPartnerLookupFilter(OWNER, ACCT)).toEqual({ company_id: OWNER, type: 'internal', internal_account_id: ACCT });
  });
});

describe('ensureInternalPartner — phiếu phát sinh phải có đối tác "Công ty trong tập đoàn"', () => {
  it('ưu tiên DÙNG LẠI đối tác nội bộ đã có của tài khoản đó, không tạo thêm', async () => {
    seedAccount();
    db.partners.push({ _id: 'existing1', company_id: OWNER, type: 'internal', internal_account_id: ACCT });

    const out = await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: ACCT, actor: { user_id: 'u1', name: 'KTV' }, source: 'R1' });

    expect(out).toEqual({ partner_id: 'existing1', created: false, skipped: null });
    expect(db.created).toHaveLength(0);
  });

  it('chưa có đối tác ⇒ tạo mới theo TK gốc (tên "Công ty · Tên TK", NH/STK lấy từ TK, loại internal)', async () => {
    seedAccount();

    const out = await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: ACCT, actor: { user_id: 'u1', name: 'KTV' }, source: 'R1' });

    expect(out.created).toBe(true);
    expect(out.skipped).toBeNull();
    const created = db.created[0]!;
    expect(created).toMatchObject({
      company_id: OWNER,
      type: 'internal',
      internal_company_id: SRC_COMPANY,
      internal_account_id: ACCT,
      name: 'Công ty A · TK thanh toán',
      bank_name: 'Vietcombank',
      account_number: '0123456789',
      status: 'active',
      code: 'DT-2026-00001',
    });
    expect(String(created.name_key)).toBeTruthy();
    expect((created.history as unknown[]).length, 'có lịch sử như tạo bằng form').toBe(1);
  });

  it('hai phiếu phát sinh cùng một tài khoản đích ⇒ cùng MỘT đối tác (idempotent)', async () => {
    seedAccount();
    const first = await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: ACCT, actor: { user_id: 'u1' }, source: 'R1' });
    const second = await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: ACCT, actor: { user_id: 'u2' }, source: 'R8' });

    expect(second.partner_id).toBe(first.partner_id);
    expect(second.created, 'lần sau chỉ dùng lại').toBe(false);
    expect(db.created).toHaveLength(1);
  });

  it('đối tác nội bộ của CÔNG TY KHÁC không được dùng: tạo theo đúng công ty của phiếu', async () => {
    seedAccount();
    db.partners.push({ _id: 'otherCo', company_id: 'd'.repeat(24), type: 'internal', internal_account_id: ACCT });

    const out = await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: ACCT, actor: { user_id: 'u1' }, source: 'R1' });

    expect(out.created, 'không lấy đối tác của công ty khác').toBe(true);
    expect(db.created[0]).toMatchObject({ company_id: OWNER });
  });

  it('tài khoản nhóm (quỹ Tập đoàn) ⇒ không tạo, trả partner_id null để rule vẫn sinh phiếu', async () => {
    seedAccount({ is_group: true });

    const out = await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: ACCT, actor: { user_id: 'u1' }, source: 'R1' });

    expect(out).toEqual({ partner_id: null, created: false, skipped: 'account-unusable' });
    expect(db.created).toHaveLength(0);
  });

  it('tài khoản đã đóng ⇒ không tạo đối tác', async () => {
    seedAccount({ status: 'closed' });

    expect((await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: ACCT, actor: { user_id: 'u1' } })).skipped).toBe('account-unusable');
  });

  it('thiếu tài khoản / id không hợp lệ ⇒ null, không chạm DB', async () => {
    seedAccount();

    expect(await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: null, actor: {} })).toEqual({ partner_id: null, created: false, skipped: 'no-account' });
    expect(await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: 'not-an-oid', actor: {} })).toMatchObject({ skipped: 'no-account' });
    expect(db.created).toHaveLength(0);
  });

  it('ghi thất bại (đua tạo) mà đối tác đã tồn tại ⇒ dùng lại, không ném lỗi làm hỏng rule', async () => {
    seedAccount();
    const Partner = (await import('../../db/models.ts')).Models.Partner as unknown as {
      findOne: (f: Record<string, unknown>) => { select: () => { lean: () => Promise<Record<string, unknown> | null> } };
      create: (d: Record<string, unknown>) => Promise<{ _id: string }>;
    };
    let calls = 0;
    const origFind = Partner.findOne.bind(Partner);
    Partner.findOne = ((filter: Record<string, unknown>) => {
      calls++;
      if (calls === 1) return { select: () => ({ lean: async () => null }) }; // lần tra đầu: chưa có
      return origFind(filter); // lần tra sau khi ghi lỗi: đã có (bên khác tạo trước)
    }) as typeof Partner.findOne;
    const origCreate = Partner.create.bind(Partner);
    Partner.create = (async () => {
      db.partners.push({ _id: 'raced', company_id: OWNER, type: 'internal', internal_account_id: ACCT });
      throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
    }) as typeof Partner.create;

    const out = await ensureInternalPartner({ ownerCompanyId: OWNER, accountId: ACCT, actor: { user_id: 'u1' }, source: 'R8' });

    expect(out).toEqual({ partner_id: 'raced', created: false, skipped: null });
    Partner.findOne = origFind;
    Partner.create = origCreate;
  });
});

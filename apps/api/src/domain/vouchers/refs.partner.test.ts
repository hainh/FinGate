/**
 * Đối tác của phiếu + ràng buộc "Công ty trong tập đoàn" (v2 §5.1, §11.6) — `resolveVoucherPartner`.
 *
 * Nghiệp vụ mới: phiếu THU do quy tắc tự động sinh (R1 phiếu thu đối ứng, R8 nhận tiền mượn) mang đối tác
 * `internal` trỏ tài khoản đã chuyển tiền tới ⇒ chỉ chặn đối tác internal khi là LỰA CHỌN MỚI (requireActive).
 */

import { describe, expect, it, vi } from 'vitest';

const CO = 'a'.repeat(24);
const PARTNER = 'b'.repeat(24);

/** Đối tác "đọc từ DB" cho từng ca. */
let row: Record<string, unknown> | null = null;

vi.mock('../../db/models.ts', () => ({
  Models: {
    Partner: {
      findOne: () => ({ lean: async () => row }),
    },
  },
}));

import { resolveVoucherPartner } from './refs.ts';

const codeOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return '';
  } catch (err) {
    return String((err as { code?: string }).code ?? '');
  }
};

describe('resolveVoucherPartner — đối tác "Công ty trong tập đoàn" với phiếu thu', () => {
  it('chọn MỚI đối tác internal cho phiếu thu ⇒ vẫn chặn (form không cho chọn tay, §5.2)', async () => {
    row = { _id: PARTNER, company_id: CO, type: 'internal', status: 'active' };
    expect(await codeOf(() => resolveVoucherPartner({ companyId: CO, partnerId: PARTNER, kind: 'income', requireActive: true, loanKind: null }))).toBe('FG-VAL-001');
  });

  it('GIỮ đối tác internal đã có trên phiếu thu phát sinh (R1, R8) ⇒ không chặn', async () => {
    row = { _id: PARTNER, company_id: CO, type: 'internal', status: 'active' };
    const p = await resolveVoucherPartner({ companyId: CO, partnerId: PARTNER, kind: 'income', requireActive: false, loanKind: null });
    expect(p).toMatchObject({ type: 'internal' });
  });

  it('phiếu chi: đối tác internal dùng bình thường (chuyển nội bộ, §11.6)', async () => {
    row = { _id: PARTNER, company_id: CO, type: 'internal', internal_company_id: CO, internal_account_id: 'c'.repeat(24), status: 'active' };
    const p = await resolveVoucherPartner({ companyId: CO, partnerId: PARTNER, kind: 'spend', requireActive: true, loanKind: null });
    expect(p).toMatchObject({ type: 'internal' });
  });

  it('phiếu thu với đối tác Ngân hàng (R3 giải ngân) không ảnh hưởng', async () => {
    row = { _id: PARTNER, company_id: CO, type: 'bank', status: 'active' };
    const p = await resolveVoucherPartner({ companyId: CO, partnerId: PARTNER, kind: 'income', requireActive: true, loanKind: null });
    expect(p).toMatchObject({ type: 'bank' });
  });
});

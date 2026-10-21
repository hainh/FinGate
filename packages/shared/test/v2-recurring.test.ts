import { describe, expect, it } from 'vitest';
import { recurringUpsertBody } from '../src/contracts/admin.js';

const OID = 'a'.repeat(24);

/** Khoản chi định kỳ tối thiểu — bên nhận là đối tác theo ID (v2 §5.2, §14.2). */
const rule = {
  company_id: OID,
  title: 'Thuê văn phòng',
  purpose: 'Tiền thuê văn phòng hằng tháng',
  partner_id: OID,
  amount: { amount_minor: '1000000', currency: 'VND' },
  source: { fund: 'bank', account_id: OID },
  cadence: 'monthly',
  effective_from: '2026-10-01',
};

describe('v2 — khoản chi định kỳ: bên nhận là đối tác theo ID (bỏ nhập tự do)', () => {
  it('thiếu partner_id bị chặn, kể cả khi còn gửi payee tên tự do', () => {
    expect(recurringUpsertBody.safeParse({ ...rule, partner_id: undefined }).success).toBe(false);
    expect(recurringUpsertBody.safeParse({ ...rule, partner_id: null }).success).toBe(false);
    expect(recurringUpsertBody.safeParse({ ...rule, partner_id: undefined, payee: { name: 'Tự do' } }).success).toBe(false);
  });

  it('có partner_id là hợp lệ; payee v1 bị bỏ qua, không đi vào dữ liệu đã parse', () => {
    const parsed = recurringUpsertBody.parse({ ...rule, payee: { name: 'Tự do' } });
    expect(parsed.partner_id).toBe(OID);
    expect('payee' in parsed).toBe(false);
  });
});

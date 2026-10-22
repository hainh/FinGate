/**
 * Kiểm thử gõ lại số tiền để xác nhận (v2 §6.3, §7.2): chỉ số gõ KHỚP số cần xác nhận mới được gửi duyệt.
 */
import { describe, expect, it } from 'vitest';
import { money } from '@fingate/shared';
import { checkRetypedAmount } from './amount-retype.ts';

const NEW_62M = money('62000000');

describe('checkRetypedAmount — tăng số tiền phải gõ lại số mới (v2 §6.3)', () => {
  it('gõ đúng số mới → ok, trả chuỗi minor để gửi làm confirm_amount_minor', () => {
    expect(checkRetypedAmount('62000000', NEW_62M)).toEqual({ ok: true, minor: '62000000' });
  });

  it('chấp nhận các cách gõ cùng một số (dấu nhóm, đơn vị "tr", "tỷ")', () => {
    expect(checkRetypedAmount('62.000.000', NEW_62M)).toEqual({ ok: true, minor: '62000000' });
    expect(checkRetypedAmount('62,000,000', NEW_62M)).toEqual({ ok: true, minor: '62000000' });
    expect(checkRetypedAmount('62 tr', NEW_62M)).toEqual({ ok: true, minor: '62000000' });
    expect(checkRetypedAmount('2,5 tỷ', money('2500000000'))).toEqual({
      ok: true,
      minor: '2500000000',
    });
  });

  it('gõ lại số cũ (chưa đúng số mới) → KHÔNG duyệt, báo không khớp', () => {
    const r = checkRetypedAmount('60000000', NEW_62M);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/KHÔNG khớp/);
  });

  it('để trống hoặc không phải số → KHÔNG duyệt, có thông báo', () => {
    expect(checkRetypedAmount('   ', NEW_62M)).toEqual({
      ok: false,
      error: 'Nhập lại số tiền để xác nhận.',
    });
    expect(checkRetypedAmount('abc', NEW_62M)).toEqual({
      ok: false,
      error: 'Định dạng số tiền không hợp lệ.',
    });
  });
});

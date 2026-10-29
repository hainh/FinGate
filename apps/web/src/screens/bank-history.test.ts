/**
 * BANK-05 (màn lịch sử giao dịch của một tài khoản): tiêu đề "Lịch sử giao dịch · …" phải có TÊN TK
 * theo cùng quy ước nhãn với ô chọn TK, để các TK cùng ngân hàng phân biệt được (v2 §4.1, bug #6).
 */

import { describe, expect, it } from 'vitest';
import type { BankAccountDetail } from '../app/types.ts';
import { bankAccountTitleName } from './bank-history.tsx';

const acct = (patch: Partial<BankAccountDetail> = {}): BankAccountDetail => ({
  _id: 'acc-1',
  company_id: 'co-cta',
  company_name: 'CTA',
  is_group: false,
  bank_name: 'BIDV',
  account_name: 'TK lịch sử A',
  account_number: '122983878772',
  branch: null,
  kind: 'bank',
  currency: 'VND',
  manager_user_id: null,
  limit_minor: null,
  min_balance_minor: '0',
  stored_minor: '0',
  show_on_dashboard: true,
  status: 'active',
  note: null,
  updated_at: null,
  ...patch,
});

describe('bankAccountTitleName (BANK-05)', () => {
  it('ghép ngân hàng · số TK · TÊN TK (cùng nhãn với ô chọn TK)', () => {
    expect(bankAccountTitleName(acct())).toBe('BIDV · 122983878772 · TK lịch sử A');
  });

  it('TK cùng ngân hàng khác tên TK thì nhãn khác nhau', () => {
    const a = bankAccountTitleName(acct({ account_name: 'TK lịch sử A' }));
    const b = bankAccountTitleName(acct({ account_name: 'TK lịch sử B', account_number: '900000000001' }));
    expect(a).not.toBe(b);
    expect(a).toContain('TK lịch sử A');
    expect(b).toContain('TK lịch sử B');
  });

  it('thiếu tên TK thì vẫn hiện ngân hàng · số TK', () => {
    expect(bankAccountTitleName(acct({ account_name: '' }))).toBe('BIDV · 122983878772');
  });

  it('chưa tải xong tài khoản thì dùng nhãn mặc định', () => {
    expect(bankAccountTitleName(undefined)).toBe('Tài khoản tiền');
    expect(bankAccountTitleName(null)).toBe('Tài khoản tiền');
  });
});

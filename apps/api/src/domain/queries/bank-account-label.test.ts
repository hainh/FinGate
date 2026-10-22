import { describe, expect, it } from 'vitest';
import { bankAccountLabelOf } from './index.ts';

/** Nhãn TK trên phiếu / màn duyệt: phải có TÊN TK để phân biệt các TK cùng ngân hàng (bug #6). */
describe('bankAccountLabelOf', () => {
  it('có tên TK: "Ngân hàng · số TK · tên TK" (cùng quy ước bankAccountOptionLabel phía web)', () => {
    expect(bankAccountLabelOf({ bank_name: 'BIDV', account_number: '105461439723', account_name: 'TK giải ngân A' })).toBe(
      'BIDV · 105461439723 · TK giải ngân A',
    );
  });

  it('không có tên TK thì chỉ "Ngân hàng · số TK"', () => {
    expect(bankAccountLabelOf({ bank_name: 'BIDV', account_number: '105461439723', account_name: '' })).toBe('BIDV · 105461439723');
    expect(bankAccountLabelOf({ bank_name: 'BIDV', account_number: '105461439723' })).toBe('BIDV · 105461439723');
  });

  it('thiếu phần nào thì bỏ phần đó, không sinh dấu ngăn thừa', () => {
    expect(bankAccountLabelOf({ bank_name: null, account_number: '', account_name: 'TK B' })).toBe('TK B');
    expect(bankAccountLabelOf({})).toBe('');
  });
});

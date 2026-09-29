import { describe, expect, it } from 'vitest';
import { AUTO_INCOME_PREFIX, PAYEE_ACCOUNT_SEPARATOR, parsePayeeAccountLabel } from './auto-income.ts';

describe('parsePayeeAccountLabel', () => {
  it('cắt đúng "Mã công ty - Tên ngân hàng/quỹ - Số tài khoản/mã quỹ"', () => {
    expect(parsePayeeAccountLabel('MP - Vietcombank - 0071000452100')).toEqual({
      companyCode: 'MP',
      accountName: 'Vietcombank',
      accountNumber: '0071000452100',
    });
  });

  it('giữ nguyên phần có khoảng trắng bên trong từng phần', () => {
    expect(parsePayeeAccountLabel('AP - Quỹ tiền mặt công ty - CASH-AP')).toEqual({
      companyCode: 'AP',
      accountName: 'Quỹ tiền mặt công ty',
      accountNumber: 'CASH-AP',
    });
  });

  it('trả null khi không đúng 3 phần', () => {
    expect(parsePayeeAccountLabel('MP - Vietcombank')).toBeNull();
    expect(parsePayeeAccountLabel('a - b - c - d')).toBeNull();
    expect(parsePayeeAccountLabel('MP -Vietcombank - 123')).toBeNull();
    expect(parsePayeeAccountLabel('')).toBeNull();
    expect(parsePayeeAccountLabel(null)).toBeNull();
  });

  it('dùng đúng dấu phân tách " - "', () => {
    expect(PAYEE_ACCOUNT_SEPARATOR).toBe(' - ');
    expect(parsePayeeAccountLabel('MP -Vietcombank- 123')).toBeNull();
  });

  it('tiền tố nội dung tự động', () => {
    expect(AUTO_INCOME_PREFIX).toBe('(Tự động nhập) ');
  });
});

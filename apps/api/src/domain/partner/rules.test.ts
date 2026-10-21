import { describe, expect, it } from 'vitest';
import { ApiError } from '@fingate/shared';
import { assertValidPartnerRecord, cleanText, creationChanges, diffSnapshots, snapshotOf, validatePartnerRecord } from './rules.ts';

describe('snapshotOf / cleanText', () => {
  it('cắt khoảng trắng, chuỗi rỗng và thiếu ⇒ null', () => {
    expect(cleanText('  Abc  ')).toBe('Abc');
    expect(cleanText('   ')).toBeNull();
    expect(cleanText(undefined)).toBeNull();
    expect(cleanText(null)).toBeNull();
    const snap = snapshotOf({ type: 'customer', name: ' Cty A ', bank_name: '', account_number: ' 001 ', status: 'active' });
    expect(snap).toEqual({
      type: 'customer',
      name: 'Cty A',
      bank_name: null,
      account_number: '001',
      tax_code: null,
      note: null,
      status: 'active',
    });
  });
});

describe('diffSnapshots — lịch sử trước → sau', () => {
  const before = snapshotOf({ type: 'customer', name: 'Cty A', bank_name: 'VCB', account_number: '001', status: 'active' });

  it('chỉ ghi các trường thực sự đổi, với from/to', () => {
    const after = { ...before, name: 'Cty A đổi tên', note: 'Ghi chú mới' };
    expect(diffSnapshots(before, after)).toEqual({
      name: { from: 'Cty A', to: 'Cty A đổi tên' },
      note: { from: null, to: 'Ghi chú mới' },
    });
  });

  it('không đổi gì ⇒ rỗng (không ghi lịch sử)', () => {
    expect(diffSnapshots(before, { ...before })).toEqual({});
  });

  it('đổi trạng thái được theo dõi', () => {
    expect(diffSnapshots(before, { ...before, status: 'inactive' })).toEqual({ status: { from: 'active', to: 'inactive' } });
  });
});

describe('creationChanges', () => {
  it('khi tạo: mọi trường có giá trị đi từ null', () => {
    const snap = snapshotOf({ type: 'bank', name: 'BIDV – CN Đông Đô', status: 'active' });
    expect(creationChanges(snap)).toEqual({
      type: { from: null, to: 'bank' },
      name: { from: null, to: 'BIDV – CN Đông Đô' },
      status: { from: null, to: 'active' },
    });
  });
});

describe('validatePartnerRecord — kiểm tra bản ghi', () => {
  const base = snapshotOf({ type: 'customer', name: 'Khách hàng A', status: 'active' });

  it('bản ghi hợp lệ ⇒ null', () => {
    expect(validatePartnerRecord(base)).toBeNull();
  });

  it('tên dưới 2 ký tự bị báo', () => {
    expect(validatePartnerRecord({ ...base, name: 'A' })).toEqual({ name: 'Tên đối tác tối thiểu 2 ký tự' });
  });

  it('KH/NCC có số tài khoản thì bắt buộc có ngân hàng', () => {
    const errors = validatePartnerRecord({ ...base, account_number: '0123' });
    expect(errors).toEqual({ bank_name: 'Nhập ngân hàng khi có số tài khoản' });
    expect(validatePartnerRecord({ ...base, account_number: '0123', bank_name: 'VCB' })).toBeNull();
  });

  it('loại Ngân hàng không bắt buộc ngân hàng (tên đã là ngân hàng + chi nhánh)', () => {
    expect(validatePartnerRecord({ ...base, type: 'bank', name: 'BIDV – CN Đông Đô', account_number: '0123' })).toBeNull();
  });

  it('assertValidPartnerRecord ném FG-VAL-001 kèm lỗi theo trường', () => {
    let caught: ApiError | null = null;
    try {
      assertValidPartnerRecord({ ...base, account_number: '0123' });
    } catch (err) {
      caught = err as ApiError;
    }
    expect(caught?.code).toBe('FG-VAL-001');
    expect(caught?.errors).toEqual({ bank_name: 'Nhập ngân hàng khi có số tài khoản' });
  });
});

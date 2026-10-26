import { describe, expect, it } from 'vitest';
import { ApiError, partnerMergeBody } from '@fingate/shared';
import { assertMergeable, mergedMasterFields, mergeProblems, type MergeCandidate } from './merge.ts';
import type { PartnerSnapshot } from './rules.ts';

const CO = '6650a1b2c3d4e5f600000001';
const CO2 = '6650a1b2c3d4e5f600000002';
const A = '6650a1b2c3d4e5f600000011';
const B = '6650a1b2c3d4e5f600000012';
const UUID = '6b1c2a3e-1f2d-4c5e-8a9b-0d1e2f3a4b5c';

const cand = (over: Partial<MergeCandidate> = {}): MergeCandidate => ({ _id: A, company_id: CO, type: 'customer', status: 'active', ...over });
const other = (over: Partial<MergeCandidate> = {}): MergeCandidate => cand({ _id: B, ...over });

const snap = (over: Partial<PartnerSnapshot> = {}): PartnerSnapshot => ({
  type: 'customer',
  name: 'Công ty ABC',
  bank_name: null,
  account_number: null,
  tax_code: null,
  note: null,
  status: 'active',
  ...over,
});

describe('mergeProblems — điều kiện được gộp', () => {
  it('cùng công ty, cùng loại, đích đang hoạt động ⇒ gộp được', () => {
    expect(mergeProblems(cand(), other())).toBeNull();
  });

  it('nguồn đang ngừng giao dịch vẫn gộp được (thường là bản trùng cần dọn)', () => {
    expect(mergeProblems(cand({ status: 'inactive' }), other())).toBeNull();
  });

  it('khác loại ⇒ không gộp (kể cả hai đều là khách hàng / nhà cung cấp)', () => {
    expect(mergeProblems(cand({ type: 'customer' }), other({ type: 'supplier' }))).toEqual({ target_id: 'Chỉ gộp các đối tác cùng loại' });
    expect(mergeProblems(cand({ type: 'bank' }), other({ type: 'customer' }))).toEqual({ target_id: 'Chỉ gộp các đối tác cùng loại' });
  });

  it('khác công ty ⇒ không gộp', () => {
    expect(mergeProblems(cand(), other({ company_id: CO2 }))).toEqual({ target_id: 'Hai đối tác phải thuộc cùng một công ty' });
  });

  it('chọn chính đối tác đó làm đích ⇒ không gộp', () => {
    expect(mergeProblems(cand(), cand())).toEqual({ target_id: 'Chọn một đối tác khác để gộp vào' });
  });

  it('đích đang ngừng giao dịch ⇒ không gộp (đích sẽ nhận phiếu / công nợ mới)', () => {
    expect(mergeProblems(cand(), other({ status: 'inactive' }))).toEqual({
      target_id: 'Đối tác đích đang ngừng giao dịch — kích hoạt lại trước khi gộp',
    });
  });

  it('đối tác công ty trong tập đoàn (nguồn hoặc đích) không gộp', () => {
    expect(mergeProblems(cand({ type: 'internal' }), other({ type: 'internal' }))).toEqual({
      type: 'Đối tác công ty trong tập đoàn không gộp — mỗi tài khoản gốc là một đối tác',
    });
    expect(mergeProblems(cand({ type: 'supplier' }), other({ type: 'internal' }))?.type).toContain('không gộp');
  });
});

describe('assertMergeable', () => {
  it('ném FG-VAL-001 kèm chi tiết theo trường khi không gộp được', () => {
    let caught: unknown = null;
    try {
      assertMergeable(cand(), other({ type: 'supplier' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('FG-VAL-001');
    expect((caught as ApiError).detail).toBe('Chỉ gộp các đối tác cùng loại');
  });

  it('không ném khi gộp được', () => {
    expect(() => assertMergeable(cand(), other())).not.toThrow();
  });
});

describe('mergedMasterFields — thông tin danh bạ của đích sau gộp', () => {
  it('đích giữ tên, loại, trạng thái', () => {
    const out = mergedMasterFields(snap({ name: 'Công ty ABC' }), snap({ name: 'ABC Co., Ltd' }), 'DT-2026-00002 · ABC Co., Ltd');
    expect(out.name).toBe('Công ty ABC');
    expect(out.type).toBe('customer');
    expect(out.status).toBe('active');
  });

  it('MST trống ở đích lấy từ nguồn; đã có MST thì giữ của đích', () => {
    expect(mergedMasterFields(snap(), snap({ tax_code: '0101' }), 'x').tax_code).toBe('0101');
    expect(mergedMasterFields(snap({ tax_code: '0202' }), snap({ tax_code: '0101' }), 'x').tax_code).toBe('0202');
  });

  it('đích chưa có STK thì lấy cặp NH + STK của nguồn (không lấy lẻ NH)', () => {
    const out = mergedMasterFields(snap(), snap({ bank_name: 'Vietcombank', account_number: '0123456789' }), 'x');
    expect(out).toMatchObject({ bank_name: 'Vietcombank', account_number: '0123456789' });
  });

  it('đích đã có STK thì giữ NH + STK của đích', () => {
    const out = mergedMasterFields(
      snap({ bank_name: 'BIDV', account_number: '999' }),
      snap({ bank_name: 'Vietcombank', account_number: '0123456789' }),
      'x',
    );
    expect(out).toMatchObject({ bank_name: 'BIDV', account_number: '999' });
  });

  it('ghi chú: đích trống thì lấy ghi chú nguồn; cả hai có thì nối, không mất', () => {
    expect(mergedMasterFields(snap(), snap({ note: 'Khách sỉ' }), 'x').note).toBe('Khách sỉ');
    expect(mergedMasterFields(snap({ note: 'Khách lẻ' }), snap({ note: 'Khách sỉ' }), 'DT-1 · ABC').note).toBe(
      'Khách lẻ\nGộp từ DT-1 · ABC: Khách sỉ',
    );
  });

  it('nguồn không có thông tin gì thêm thì đích không đổi', () => {
    const target = snap({ tax_code: '0101', note: 'ghi chú', bank_name: 'BIDV', account_number: '999' });
    expect(mergedMasterFields(target, snap(), 'x')).toEqual(target);
  });
});

describe('partnerMergeBody — hợp đồng gộp', () => {
  it('cần đối tác đích hợp lệ; request_id (nếu có) phải là UUID', () => {
    expect(partnerMergeBody.safeParse({ target_id: B }).success).toBe(true);
    expect(partnerMergeBody.safeParse({ target_id: B, request_id: UUID }).success).toBe(true);
    expect(partnerMergeBody.safeParse({}).success).toBe(false);
    expect(partnerMergeBody.safeParse({ target_id: 'abc' }).success).toBe(false);
    expect(partnerMergeBody.safeParse({ target_id: B, request_id: 'không-phải-uuid' }).success).toBe(false);
  });
});

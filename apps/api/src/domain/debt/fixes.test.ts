/**
 * Kiểm thử hàm thuần của các sửa v2 công nợ / nợ ngân hàng (v2/v2.md §2.3, §10.1–10.3):
 * chỉ tiêu giải ngân (khoản tạo tay, nhập lô, chờ giải ngân), lịch sử trước → sau, kiểm hạn sau ngày giải ngân,
 * và hợp đồng vào (zod) cho số HĐ / TSĐB / người phụ trách / request_id.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '@fingate/shared';
import { loanCreateBody, loanImportRow, loanUpdateBody, unlinkBody } from './bodies.ts';
import { assertMaturityAfterDisbursement, changesOf, disbursementFigures, scalarOf } from './rules.ts';
import { debtAgingBucket, debtAgingLabel, debtStatus } from './index.ts';

describe('nợ NH › chỉ tiêu giải ngân (disbursementFigures)', () => {
  it('khoản tạo tay / nhập lô đang vay (không có liên kết giải ngân) ⇒ đã giải ngân = gốc, chưa giải ngân = 0', () => {
    const f = disbursementFigures({ principal: 100n, status: 'active', paid: 0n, planned: 0n, linkCount: 0 });
    expect(f).toEqual({ disbursed: 100n, undisbursed: 0n });
  });

  it('khoản quá hạn tạo tay cũng coi là đã giải ngân đủ', () => {
    const f = disbursementFigures({ principal: 250n, status: 'overdue', paid: 0n, planned: 0n, linkCount: 0 });
    expect(f).toEqual({ disbursed: 250n, undisbursed: 0n });
  });

  it('khoản đang vay có liên kết giải ngân ⇒ đã giải ngân = tổng phiếu đã thực thi', () => {
    const f = disbursementFigures({ principal: 100n, status: 'active', paid: 60n, planned: 100n, linkCount: 2 });
    expect(f).toEqual({ disbursed: 60n, undisbursed: 0n });
  });

  it('khoản chờ giải ngân ⇒ chưa giải ngân = gốc − đã gán; đã giải ngân = đã thực thi', () => {
    const f = disbursementFigures({ principal: 100n, status: 'pending_disbursement', paid: 0n, planned: 40n, linkCount: 1 });
    expect(f).toEqual({ disbursed: 0n, undisbursed: 60n });
  });

  it('khoản đã huỷ không còn chưa giải ngân', () => {
    const f = disbursementFigures({ principal: 100n, status: 'cancelled', paid: 0n, planned: 0n, linkCount: 0 });
    expect(f.undisbursed).toBe(0n);
  });
});

describe('nợ NH / công nợ › lịch sử trước → sau (changesOf)', () => {
  it('chỉ ghi trường thực sự đổi, bỏ updated_at, chuẩn hoá BigInt / Date / null', () => {
    const before = { principal_minor: 100n, note: null, maturity_date: '2027-12-31', updated_at: new Date('2026-01-01T00:00:00Z') };
    const after = { principal_minor: 120n, note: null, maturity_date: '2028-06-30', updated_at: new Date() };
    expect(changesOf(before, after)).toEqual({
      principal_minor: { from: '100', to: '120' },
      maturity_date: { from: '2027-12-31', to: '2028-06-30' },
    });
  });

  it('không đổi gì ⇒ rỗng', () => {
    expect(changesOf({ note: 'a' }, { note: 'a' })).toEqual({});
  });

  it('scalarOf: null / undefined / rỗng ⇒ null; Date ⇒ ISO', () => {
    expect(scalarOf(undefined)).toBeNull();
    expect(scalarOf('')).toBeNull();
    expect(scalarOf(new Date('2026-02-01T00:00:00Z'))).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('nợ NH › hạn thanh toán phải sau ngày giải ngân', () => {
  it('hạn trước hoặc bằng ngày giải ngân ⇒ FG-VAL-001', () => {
    expect(() => assertMaturityAfterDisbursement('2026-07-01', '2026-07-01')).toThrow(ApiError);
    expect(() => assertMaturityAfterDisbursement('2026-06-30', '2026-07-01')).toThrow(ApiError);
  });

  it('hạn sau ngày giải ngân, hoặc chưa có ngày giải ngân ⇒ hợp lệ', () => {
    expect(() => assertMaturityAfterDisbursement('2027-12-31', '2026-07-01')).not.toThrow();
    expect(() => assertMaturityAfterDisbursement('2027-12-31', null)).not.toThrow();
  });
});

describe('nợ NH › hợp đồng vào (zod) — HĐ tín dụng, TSĐB, người phụ trách, request_id', () => {
  const base = {
    partner_id: '64b000000000000000000001',
    amount: { amount_minor: '1000000000', currency: 'VND', decimals: 0 },
    maturity_date: '2027-12-31',
  };

  it('tạo khoản nhận số HĐ, TSĐB, người phụ trách và request_id', () => {
    const parsed = loanCreateBody.safeParse({
      ...base,
      contract_no: 'HĐTD/2026/MP-01',
      collateral: 'Quyền sử dụng đất 120m2',
      responsible: 'Nguyễn Văn A',
      request_id: 'req-20260721-0001',
    });
    expect(parsed.success).toBe(true);
  });

  it('request_id quá ngắn bị từ chối (chống gửi lặp cần khoá đủ dài)', () => {
    expect(loanCreateBody.safeParse({ ...base, request_id: 'abc' }).success).toBe(false);
  });

  it('PATCH cho phép xoá số HĐ / TSĐB / người phụ trách bằng null', () => {
    expect(loanUpdateBody.safeParse({ contract_no: null, collateral: null, responsible: null }).success).toBe(true);
  });

  it('dòng nhập lô nhận số HĐ / TSĐB / người phụ trách', () => {
    const parsed = loanImportRow.safeParse({
      partner_code: 'DT-2026-00001',
      amount: { amount_minor: '500000000', currency: 'VND', decimals: 0 },
      maturity_date: '2027-06-30',
      contract_no: 'HĐ-77',
      collateral: 'Sổ tiết kiệm',
      responsible: 'Trần B',
    });
    expect(parsed.success).toBe(true);
  });

  it('gỡ liên kết: lý do bắt buộc, không mặc định', () => {
    expect(unlinkBody.safeParse({}).success).toBe(false);
    expect(unlinkBody.safeParse({ reason: 'Gán nhầm phiếu' }).success).toBe(true);
  });
});

describe('công nợ › re-export từ rules (không còn bản trùng)', () => {
  it('tuổi nợ, trạng thái cấn trừ, nhãn tuổi nợ khớp rules', () => {
    expect(debtAgingBucket(0)).toBe('none');
    expect(debtAgingBucket(31)).toBe('d30_60');
    expect(debtStatus(100n, 100n)).toBe('settled');
    expect(debtAgingLabel('gt90')).toBe('> 90 ngày');
  });
});

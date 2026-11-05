/**
 * Kiểm thử phần THUẦN của R1 (chuyển tiền nội bộ → phiếu thu tự động): chọn liên kết cho cặp phiếu và nội dung ghi chú.
 *
 * Điểm nghiệp vụ quan trọng: cặp chuyển nội bộ KHÁC công ty dùng `internal_transfer`, nhưng cặp CÙNG công ty (chuyển
 * giữa hai tài khoản) phải dùng `generated` — `RELATION_SPECS.internal_transfer` bắt buộc hai công ty khác nhau.
 */

import { describe, expect, it, vi } from 'vitest';

// R1 kéo theo các bước dùng DB (phiếu, sổ cái). Test này chỉ kiểm hàm thuần ⇒ không cần kết nối.
vi.mock('../../db/models.ts', () => ({ Models: {} }));

import { transferLinkRelationOf, transferNoteOf } from './r1-internal-transfer.ts';

describe('transferLinkRelationOf — quan hệ liên kết của cặp phiếu chi → phiếu thu do R1 sinh', () => {
  it('khác công ty ⇒ internal_transfer (quan hệ cặp chuyển tiền giữa các công ty)', () => {
    expect(transferLinkRelationOf(false)).toBe('internal_transfer');
  });

  it('cùng công ty ⇒ generated (ràng buộc sameCompany của RELATION_SPECS)', () => {
    expect(transferLinkRelationOf(true)).toBe('generated');
  });
});

describe('transferNoteOf — ghi chú nguồn của phiếu thu tự động', () => {
  const company = { code: 'AP', name: 'Công ty A' };

  it('khác công ty: nêu nguồn chuyển đi (mã - tên công ty)', () => {
    expect(transferNoteOf({ sourceCode: 'PC-1', sameCompany: false, sourceCompany: company })).toBe(
      'Tự động tạo khi thực thi phiếu chi PC-1 · từ AP - Công ty A',
    );
  });

  it('cùng công ty: nêu rõ chuyển giữa hai tài khoản cùng công ty', () => {
    expect(transferNoteOf({ sourceCode: 'PC-1', sameCompany: true, sourceCompany: company })).toBe(
      'Tự động tạo khi thực thi phiếu chi PC-1 · chuyển giữa hai tài khoản cùng công ty AP - Công ty A',
    );
  });

  it('không đọc được công ty nguồn ⇒ ghi chú tối thiểu, không có chuỗi "undefined"', () => {
    expect(transferNoteOf({ sourceCode: 'PC-1', sameCompany: false, sourceCompany: null })).toBe(
      'Tự động tạo khi thực thi phiếu chi PC-1',
    );
    expect(transferNoteOf({ sourceCode: 'PC-1', sameCompany: true, sourceCompany: null })).toBe(
      'Tự động tạo khi thực thi phiếu chi PC-1 · chuyển giữa hai tài khoản cùng công ty',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { internalPartnerName, internalSourceFilter, internalSyncSnapshot, type InternalSource } from './internal.ts';
import { snapshotOf } from './rules.ts';

const before = snapshotOf({ type: 'internal', name: 'Cty A · TK cũ', bank_name: 'VCB', account_number: '111', status: 'active' });
const usable: InternalSource = { company_id: 'c1', name: 'Cty A · TK VCB 2', bank_name: 'Techcombank', account_number: '222', usable: true };

describe('đối tác công ty trong tập đoàn', () => {
  it('tên hiển thị gộp công ty và tài khoản để phân biệt các TK cùng công ty', () => {
    expect(internalPartnerName('Công ty A', 'TK lương')).toBe('Công ty A · TK lương');
  });

  it('đồng bộ tên, ngân hàng, STK khi công ty / TK gốc đổi', () => {
    const next = internalSyncSnapshot(before, usable);
    expect(next).toMatchObject({ name: 'Cty A · TK VCB 2', bank_name: 'Techcombank', account_number: '222', status: 'active' });
  });

  it('TK gốc đóng ⇒ đối tác chuyển ngừng giao dịch', () => {
    const next = internalSyncSnapshot(before, { ...usable, usable: false });
    expect(next.status).toBe('inactive');
  });

  it('TK mở lại không tự bật lại đối tác đã ngừng', () => {
    const stopped = { ...before, status: 'inactive' as const };
    expect(internalSyncSnapshot(stopped, usable).status).toBe('inactive');
  });
});

describe('danh sách TK chọn làm nguồn — khớp tiêu chí khi tạo đối tác', () => {
  it('lấy cả TK ngân hàng lẫn tiền mặt, không lấy TK nhóm, chỉ TK đang hoạt động của đúng công ty đã chọn', () => {
    expect(internalSourceFilter('c1')).toEqual({ company_id: 'c1', is_group: { $ne: true }, status: 'active' });
  });
});

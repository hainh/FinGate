import { describe, expect, it } from 'vitest';
import { ApiError, PROBLEM_CATALOG, toProblem } from '@fingate/shared';

describe('ApiError — tiêu đề theo tình huống (một mã dùng chung nhiều nguyên nhân)', () => {
  it('không truyền title ⇒ tiêu đề chung của mã trong danh mục', () => {
    const e = new ApiError({ code: 'FG-WF-007' });
    expect(e.title).toBe(PROBLEM_CATALOG['FG-WF-007'].titleVi);
    expect(toProblem(e).title).toBe(PROBLEM_CATALOG['FG-WF-007'].titleVi);
  });

  it('truyền title ⇒ RFC 7807 title và message nêu đúng nguyên nhân (tăng số tiền KHÔNG gọi là "ngoài ngân sách")', () => {
    const e = new ApiError({
      code: 'FG-WF-007',
      title: 'Số tiền duyệt tăng — cần xác nhận',
      detail: 'Số tiền duyệt tăng từ 5 tr lên 6 tr — cần xác nhận',
      data: { need_confirm_amount: true, previous_amount_minor: '5000000' },
    });
    const p = toProblem(e, 'trace-1');
    expect(p.code).toBe('FG-WF-007');
    expect(p.title).toBe('Số tiền duyệt tăng — cần xác nhận');
    expect(p.title).not.toContain('ngoài ngân sách');
    expect(p.detail).toBe('Số tiền duyệt tăng từ 5 tr lên 6 tr — cần xác nhận');
    expect(p.data).toEqual({ need_confirm_amount: true, previous_amount_minor: '5000000' });
    expect(e.message).toBe('Số tiền duyệt tăng — cần xác nhận');
    expect(p.trace_id).toBe('trace-1');
  });

  it('mã khác không đổi: FG-WF-005 vẫn dùng tiêu đề của danh mục', () => {
    expect(toProblem(new ApiError({ code: 'FG-WF-005', detail: 'x' })).title).toBe(PROBLEM_CATALOG['FG-WF-005'].titleVi);
  });
});

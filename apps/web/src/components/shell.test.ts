/**
 * Đổi phạm vi dữ liệu bỏ bộ lọc theo công ty trên URL (shell.tsx): tag và đối tác không dùng chung giữa
 * các công ty (v2 §6.2, §5). Hàm thuần, không gọi mạng.
 */
import { describe, expect, it } from 'vitest';
import { dropCompanyFilterParams } from './shell.tsx';

describe('dropCompanyFilterParams — đổi công ty thì bỏ tag và đối tác trên URL', () => {
  it('bỏ tag_ids và giữ nguyên các bộ lọc khác', () => {
    expect(dropCompanyFilterParams('?status=pending.gd&tag_ids=6aa,6bb&q=PC')).toBe('?status=pending.gd&q=PC');
  });

  it('bỏ cả đối tác; không còn tham số nào thì trả về chuỗi rỗng', () => {
    expect(dropCompanyFilterParams('?partner_id=6aa&tag_ids=6bb')).toBe('');
  });

  it('URL không có bộ lọc theo công ty thì trả về null (không cần đổi URL)', () => {
    expect(dropCompanyFilterParams('')).toBeNull();
    expect(dropCompanyFilterParams('?status=paid&sort=-waiting')).toBeNull();
  });
});

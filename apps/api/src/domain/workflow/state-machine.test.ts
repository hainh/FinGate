import { describe, expect, it } from 'vitest';
import { dropVacantSteps, escalatedTopRole, pendingRolesForRerun, resolveApprovalAmount } from './state-machine.ts';

describe('dropVacantSteps — khuyết chức danh thì bỏ bước, đẩy lên cấp cao hơn', () => {
  it('bỏ bước không có người phụ trách và đánh số lại liên tục', () => {
    const { steps, dropped } = dropVacantSteps([
      { order: 1, role: 'chief_accountant', user_id: 'u1' },
      { order: 2, role: 'deputy_director', user_id: null },
      { order: 3, role: 'director', user_id: 'u3' },
      { order: 4, role: 'deputy_chairman', user_id: 'u4' },
    ] as const);
    expect(steps.map((s) => s.role)).toEqual(['chief_accountant', 'director', 'deputy_chairman']);
    expect(steps.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(dropped).toEqual([{ order: 2, role: 'deputy_director' }]);
  });

  it('thiếu cả người phụ trách lẫn cấp cao hơn → chuỗi chỉ còn cấp thấp', () => {
    const { steps } = dropVacantSteps([
      { order: 1, role: 'chief_accountant', user_id: 'u1' },
      { order: 2, role: 'director', user_id: null },
      { order: 3, role: 'chairman', user_id: null },
    ]);
    expect(steps.map((s) => s.role)).toEqual(['chief_accountant']);
  });

  it('không có người phụ trách nào → chuỗi rỗng (workflow phải xử lý, KHÔNG tự duyệt)', () => {
    const { steps, dropped } = dropVacantSteps([
      { order: 1, role: 'chief_accountant', user_id: null },
      { order: 2, role: 'director', user_id: null },
    ]);
    expect(steps).toEqual([]);
    expect(dropped).toHaveLength(2);
  });
});

describe('escalatedTopRole — bước khuyết chức danh đẩy lên cấp cao hơn còn người', () => {
  it('PGĐ khuyết → đẩy lên GĐ', () => {
    expect(escalatedTopRole('deputy_director', ['chief_accountant', 'director'])).toBe('director');
  });

  it('bỏ qua cả những cấp cao hơn cũng khuyết', () => {
    expect(escalatedTopRole('deputy_director', ['chief_accountant', 'deputy_chairman'])).toBe('deputy_chairman');
    expect(escalatedTopRole('director', ['chief_accountant', 'chairman'])).toBe('chairman');
  });

  it('không còn cấp nào cao hơn có người → null', () => {
    expect(escalatedTopRole('chairman', ['director'])).toBeNull();
    expect(escalatedTopRole('chief_accountant', ['chief_accountant'])).toBeNull();
    expect(escalatedTopRole('chief_accountant', [])).toBeNull();
  });
});

describe('pendingRolesForRerun — chạy lại chuỗi duyệt theo ma trận mới', () => {
  it('chưa bước nào được quyết định → giữ nguyên toàn bộ ma trận', () => {
    expect(pendingRolesForRerun([], ['chief_accountant', 'deputy_director', 'director'])).toEqual([
      'chief_accountant',
      'deputy_director',
      'director',
    ]);
  });

  it('bỏ các bước đã done, giữ các bước còn lại của ma trận', () => {
    expect(pendingRolesForRerun(['chief_accountant', 'deputy_director'], ['chief_accountant', 'deputy_director', 'director'])).toEqual([
      'director',
    ]);
  });

  it('ma trận mới thêm cấp thấp hơn bước đã duyệt → cấp mới vẫn phải duyệt', () => {
    // director đã duyệt nhanh trước, giờ ma trận thêm PGĐ (chưa ai duyệt)
    expect(pendingRolesForRerun(['chief_accountant', 'director'], ['chief_accountant', 'deputy_director', 'director'])).toEqual([
      'deputy_director',
    ]);
  });

  it('cấp đã skipped (fast-track lên cấp cao nhất) không quay lại', () => {
    expect(pendingRolesForRerun(['chief_accountant', 'deputy_director'], ['chief_accountant', 'deputy_director', 'director'])).not.toContain(
      'chief_accountant',
    );
  });

  it('khử trùng lặp vai trò trong ma trận', () => {
    expect(pendingRolesForRerun([], ['chief_accountant', 'chief_accountant', 'director'])).toEqual(['chief_accountant', 'director']);
  });
});

describe('resolveApprovalAmount — cấp duyệt đổi số tiền phiếu chi', () => {
  it('không gửi số mới → giữ nguyên đề nghị ban đầu', () => {
    expect(resolveApprovalAmount(1_000n, null)).toEqual({ amount: 1_000n, changed: false, increased: false });
  });

  it('tăng số tiền → đánh dấu increased (cần confirm)', () => {
    expect(resolveApprovalAmount(1_000n, 1_500n)).toEqual({ amount: 1_500n, changed: true, increased: true });
  });

  it('giảm số tiền → changed nhưng không increased (không cần confirm)', () => {
    expect(resolveApprovalAmount(1_000n, 600n)).toEqual({ amount: 600n, changed: true, increased: false });
  });
});

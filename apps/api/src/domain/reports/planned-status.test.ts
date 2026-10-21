import { describe, expect, it } from 'vitest';
import { PLANNED_FLOW_STATUSES } from '../ledger/planned.ts';

describe('PLANNED_FLOW_STATUSES — trạng thái tính vào chỉ tiêu thu–chi (v2 §12)', () => {
  it('gồm chờ duyệt, đã duyệt, đang xử lý và đã thực thi', () => {
    for (const s of ['pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman', 'approved', 'processing', 'paid']) {
      expect(PLANNED_FLOW_STATUSES).toContain(s);
    }
  });

  it('không gồm nháp, trả về, từ chối, huỷ, hết hạn', () => {
    for (const s of ['draft', 'changes_requested', 'rejected', 'cancelled', 'expired', 'overdue']) {
      expect(PLANNED_FLOW_STATUSES).not.toContain(s);
    }
  });
});

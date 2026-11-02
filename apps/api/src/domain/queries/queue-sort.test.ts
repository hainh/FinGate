import { describe, expect, it } from 'vitest';
import { sortForQueue } from './index.ts';

describe('sortForQueue — sắp xếp phía máy chủ theo cột bảng', () => {
  it('mặc định / -waiting: chờ lâu nhất (hạn SLA sớm nhất) lên đầu', () => {
    expect(sortForQueue(undefined)).toEqual({ sla_deadline: 1, updated_at: 1 });
    expect(sortForQueue('-waiting')).toEqual({ sla_deadline: 1, updated_at: 1 });
    expect(sortForQueue('waiting')).toEqual({ sla_deadline: -1, updated_at: -1 });
  });
  it('ánh xạ cột → trường Mongo, tiền tố - là giảm dần', () => {
    expect(sortForQueue('amount')).toEqual({ 'amount.minor': 1 });
    expect(sortForQueue('-amount')).toEqual({ 'amount.minor': -1 });
    expect(sortForQueue('code')).toEqual({ code: 1 });
    expect(sortForQueue('-title')).toEqual({ title: -1 });
    expect(sortForQueue('-status')).toEqual({ status: -1 });
    expect(sortForQueue('planned_date')).toEqual({ planned_date: 1 });
    expect(sortForQueue('-created_at')).toEqual({ created_at: -1 });
  });
  it('trường lạ → thứ tự mặc định, không để lọt khoá tuỳ ý vào truy vấn', () => {
    expect(sortForQueue('-password_hash')).toEqual({ sla_deadline: 1, updated_at: 1 });
    expect(sortForQueue('$where')).toEqual({ sla_deadline: 1, updated_at: 1 });
  });
});

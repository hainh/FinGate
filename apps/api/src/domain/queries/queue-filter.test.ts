import { describe, expect, it } from 'vitest';
import { DECISION_STATUSES, EXECUTION_STATUSES, queueFilter, type QueueQuery } from './index.ts';

const scope = { companyIds: null };

function base(over: Partial<QueueQuery>): QueueQuery {
  return { scope, userId: 'u1', limit: 50, ...over };
}

describe('queueFilter — "chờ tôi duyệt" gồm cả việc thực thi cho kế toán', () => {
  it('không có payment:mark → chỉ hồ sơ tới lượt tôi duyệt', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'chief_accountant', canPay: false }));
    expect(f.$or).toBeUndefined();
    expect(f.$and).toBeUndefined();
    expect(f.$expr).toBeDefined();
    expect(f.status).toEqual({ $in: [...DECISION_STATUSES] });
  });

  it('có payment:mark → gồm thêm phiếu chi đã duyệt chờ thực thi', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'staff', canPay: true }));
    // gộp trong $and để không đè $or của ô tìm kiếm
    const and = f.$and as Record<string, unknown>[];
    expect(and).toHaveLength(1);
    const union = and[0]!.$or as Record<string, unknown>[];
    expect(union).toHaveLength(2);
    expect(union[1]).toEqual({ kind: 'spend', status: { $in: [...EXECUTION_STATUSES] } });
    expect(f.status).toEqual({ $in: [...DECISION_STATUSES, ...EXECUTION_STATUSES] });
  });

  it('ô tìm kiếm ($or) và điều kiện việc-của-tôi không đè nhau', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'staff', canPay: true, q: 'PC-1' }));
    expect(f.$or).toBeDefined(); // tìm kiếm
    expect(f.$and).toBeDefined(); // union việc của tôi
    expect(f.status).toEqual({ $in: [...DECISION_STATUSES, ...EXECUTION_STATUSES] });
  });

  it('mine=created giữ nguyên — không thêm việc thực thi', () => {
    const f = queueFilter(base({ mine: 'created', canPay: true }));
    expect(f.created_by).toBe('u1');
    expect(f.$and).toBeUndefined();
    expect(f.status).toBeUndefined();
  });
});

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

describe('queueFilter — đối tác & tag (v2)', () => {
  const P = 'a'.repeat(24);
  const T1 = 'b'.repeat(24);
  const T2 = 'c'.repeat(24);

  it('không lọc đối tác/tag khi không truyền', () => {
    const f = queueFilter(base({}));
    expect(f.partner_id).toBeUndefined();
    expect(f.tag_ids).toBeUndefined();
  });

  it('lọc đúng một đối tác theo ID', () => {
    expect(queueFilter(base({ partnerId: P })).partner_id).toBe(P);
  });

  it('tag: phiếu có ÍT NHẤT MỘT trong các tag ($in)', () => {
    expect(queueFilter(base({ tagIds: [T1, T2] })).tag_ids).toEqual({ $in: [T1, T2] });
    expect(queueFilter(base({ tagIds: [] })).tag_ids).toBeUndefined();
  });

  it('ô tìm kiếm cộng thêm đối tác khớp tên/STK và tag khớp tên (qua ID đã nạp)', () => {
    const f = queueFilter(base({ q: 'BIDV', qPartnerIds: [P], qTagIds: [T1] }));
    const or = f.$or as Record<string, unknown>[];
    expect(or).toHaveLength(4);
    expect(or).toContainEqual({ partner_id: { $in: [P] } });
    expect(or).toContainEqual({ tag_ids: { $in: [T1] } });
    // mã/tiêu đề vẫn là điều kiện text trực tiếp (không còn tìm text `payee.*` nhập tự do)
    expect(or).toContainEqual({ title: { $regex: 'BIDV', $options: 'i' } });
    expect(or.some((c) => 'payee.name' in c)).toBe(false);
  });

  it('tìm kiếm không khớp đối tác/tag thì chỉ còn mã và tiêu đề', () => {
    const f = queueFilter(base({ q: 'PC-1', qPartnerIds: [], qTagIds: [] }));
    expect(f.$or as Record<string, unknown>[]).toHaveLength(2);
  });
});

describe('queueFilter — lọc trạng thái (Chi chờ duyệt ghim mọi pending.*)', () => {
  const PENDING_STEPS = ['pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman'];

  it('status là mảng → $in gồm đủ các bước đã chọn (không rơi về một bước)', () => {
    expect(queueFilter(base({ kind: 'spend', status: PENDING_STEPS })).status).toEqual({ $in: PENDING_STEPS });
  });

  it('status là một chuỗi vẫn so khớp đúng trạng thái đó', () => {
    expect(queueFilter(base({ kind: 'spend', status: 'pending.gd' })).status).toBe('pending.gd');
  });
});

import { describe, expect, it } from 'vitest';
import { DECISION_STATUSES, EXECUTION_STATUSES, queueFilter, type QueueQuery } from './index.ts';

const scope = { companyIds: null };
const CTA = 'a'.repeat(24);
const CTB = 'b'.repeat(24);

function base(over: Partial<QueueQuery>): QueueQuery {
  return { scope, userId: 'u1', limit: 50, ...over };
}

/** `$nor` lưới an toàn: chỉ loại phiếu quỹ tiền mặt CÒN SÓT bước KTT chờ của công ty CHƯA bật "qua KTT duyệt". */
function cashNorCond(f: Record<string, unknown>): Record<string, unknown> | undefined {
  const guard = (f.$and as Record<string, unknown>[] | undefined)?.findLast((c) => '$nor' in c);
  const nor = guard?.$nor as Record<string, unknown>[] | undefined;
  return nor?.[0];
}

/** Điều kiện "chuỗi còn bước Kế toán trưởng đang chờ" — dấu hiệu snapshot cũ cần lưới an toàn. */
const STALE_KTT_STEP = { $elemMatch: { role: 'chief_accountant', state: { $in: ['current', 'waiting'] } } };

describe('queueFilter — "chờ tôi duyệt" gồm cả việc thực thi cho bàn kế toán (KTV/KTT)', () => {
  it('không có payment:mark → chỉ hồ sơ tới lượt tôi duyệt', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'chief_accountant', canPay: false }));
    // gộp trong $and: [lượt tôi duyệt, lưới an toàn "Duyệt tiền mặt"]
    const and = f.$and as Record<string, unknown>[];
    expect(and).toHaveLength(2);
    // KHÔNG còn nhánh đặc cách "phiếu quỹ tiền mặt hiện ở mọi cấp": chỉ còn đúng lượt tôi duyệt
    expect(and[0]!.$or).toBeUndefined();
    expect(and[0]).toHaveProperty('$expr');
    expect(cashNorCond(f)).toBeDefined();
    expect(f.status).toEqual({ $in: [...DECISION_STATUSES] });
  });

  it('KTV có payment:mark → gồm thêm phiếu chi đã duyệt chờ thực thi', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'staff', canPay: true }));
    // gộp trong $and để không đè $or của ô tìm kiếm
    const and = f.$and as Record<string, unknown>[];
    expect(and).toHaveLength(2);
    const union = and[0]!.$or as Record<string, unknown>[];
    expect(union).toHaveLength(2);
    expect(union[0]).toHaveProperty('$expr');
    expect(union[1]).toEqual({ kind: 'spend', status: { $in: [...EXECUTION_STATUSES] } });
    expect(f.status).toEqual({ $in: [...DECISION_STATUSES, ...EXECUTION_STATUSES] });
  });

  it('KTT có payment:mark → cũng thấy phiếu chi chờ thực thi', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'chief_accountant', canPay: true }));
    const union = (f.$and as Record<string, unknown>[])[0]!.$or as Record<string, unknown>[];
    expect(union).toHaveLength(2);
    expect(union[1]).toEqual({ kind: 'spend', status: { $in: [...EXECUTION_STATUSES] } });
    expect(f.status).toEqual({ $in: [...DECISION_STATUSES, ...EXECUTION_STATUSES] });
  });

  it('GĐ có payment:mark → hàng chờ KHÔNG gồm phiếu đã duyệt chờ thực thi (việc của bàn kế toán)', () => {
    // bug: phiếu "Đã duyệt" hiện trong "Chờ tôi duyệt" của tài khoản chức danh GĐ vì GĐ có
    // `payment:mark` — phiếu chờ chi không phải việc chờ duyệt của cấp duyệt (blueprint §IV).
    for (const role of ['director', 'deputy_director', 'chairman', 'deputy_chairman'] as const) {
      const f = queueFilter(base({ mine: 'to_approve', role, canPay: true }));
      const and = f.$and as Record<string, unknown>[];
      expect(and).toHaveLength(2);
      expect(and[0]!.$or).toBeUndefined(); // chỉ còn "đến lượt tôi duyệt"
      expect(and[0]).toHaveProperty('$expr');
      expect(f.status).toEqual({ $in: [...DECISION_STATUSES] });
    }
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

  it('awaiting=turn → đúng "đến lượt tôi": vẫn gồm việc chi chờ tôi thực thi', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'staff', canPay: true, awaiting: 'turn' }));
    const union = (f.$and as Record<string, unknown>[])[0]!.$or as Record<string, unknown>[];
    expect(union).toHaveLength(2);
    expect(union[1]).toEqual({ kind: 'spend', status: { $in: [...EXECUTION_STATUSES] } });
    expect(f.status).toEqual({ $in: [...DECISION_STATUSES, ...EXECUTION_STATUSES] });
  });

  it('awaiting=later → chỉ phiếu còn chờ cấp dưới: "có bước tôi chờ" VÀ "không phải cấp thấp nhất"', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'staff', canPay: true, awaiting: 'later' }));
    // toàn bộ điều kiện hàng chờ nằm trong một phần tử `$and` (không đè `$or` của ô tìm kiếm)
    const cond = (f.$and as Record<string, unknown>[])[0]!;
    // $nor phải ở cấp TRUY VẤN (toán tử so khớp), không phải biểu thức trong $expr
    expect(cond.$nor).toBeDefined();
    const [anyPending] = cond.$and as Record<string, unknown>[];
    expect(anyPending).toHaveProperty('$expr');
    // chỉ trừ đúng nhánh "đến lượt tôi" (cấp thấp nhất) — không còn nhánh đặc cách quỹ tiền mặt
    const nor = cond.$nor as Record<string, unknown>[];
    expect(nor).toHaveLength(1);
    expect(nor[0]).toHaveProperty('$expr');
    // chưa tới lượt ai làm được ⇒ không có trạng thái chờ thực thi
    expect(f.status).toEqual({ $in: [...DECISION_STATUSES] });
  });
});

/**
 * Cài đặt "Duyệt tiền mặt" (ADM-04): phiếu thu/chi quỹ tiền mặt vào "Chờ tôi duyệt" đúng như phiếu
 * thường; lưới an toàn CHỈ loại hồ sơ snapshot cũ còn sót bước KTT chờ (không loại phiếu đã bỏ KTT).
 */
describe('queueFilter — cài đặt "Duyệt tiền mặt" lọc phiếu quỹ tiền mặt', () => {
  it('không truyền danh sách công ty đang bật → chỉ loại phiếu còn SÓT bước KTT chờ', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'staff', canPay: false }));
    expect(cashNorCond(f)).toEqual({
      kind: { $in: ['spend', 'income'] },
      'source.fund': { $in: ['cash', 'fund'] },
      company_id: { $nin: [] },
      'approval.steps': STALE_KTT_STEP,
    });
  });

  it('phiếu quỹ tiền mặt đã bỏ KTT (chuỗi không còn bước KTT chờ) vẫn vào "Chờ tôi duyệt"', () => {
    // Bug PC-2026-00360: phiếu chi tiền mặt đang chờ PGĐ biến mất khỏi hàng chờ vì lưới an toàn loại
    // MỌI phiếu quỹ tiền mặt. Lưới an toàn phải khớp thêm điều kiện "còn bước KTT chờ" — hồ sơ đã bỏ
    // KTT theo cài đặt (chỉ còn PGĐ/GĐ/…) không khớp điều kiện đó nên không bị loại.
    const cond = cashNorCond(queueFilter(base({ mine: 'to_approve', role: 'deputy_director' })));
    expect(cond?.['approval.steps']).toEqual(STALE_KTT_STEP);
    expect(cond?.kind).toEqual({ $in: ['spend', 'income'] });
  });

  it('công ty đang bật "qua KTT duyệt" vẫn giữ phiếu quỹ tiền mặt của công ty đó', () => {
    const cond = cashNorCond(queueFilter(base({ mine: 'to_approve', role: 'staff', cashKttCompanyIds: [CTA] })));
    expect(cond?.company_id).toEqual({ $nin: [CTA] });
    // phiếu ngân hàng/loại khác và phiếu của công ty đang bật không bị loại
    expect(cond?.kind).toEqual({ $in: ['spend', 'income'] });
  });

  it('awaiting=later cũng không trả phiếu quỹ tiền mặt của công ty chưa bật (tab không lẫn)', () => {
    const f = queueFilter(base({ mine: 'to_approve', role: 'staff', awaiting: 'later', cashKttCompanyIds: [CTA, CTB] }));
    const guard = cashNorCond(f);
    expect(guard?.company_id).toEqual({ $nin: [CTA, CTB] });
    expect(guard?.['source.fund']).toEqual({ $in: ['cash', 'fund'] });
  });

  it('null rỗng = không công ty nào bật (mặc định)', () => {
    expect(cashNorCond(queueFilter(base({ mine: 'to_approve', cashKttCompanyIds: null })))?.company_id).toEqual({ $nin: [] });
    expect(cashNorCond(queueFilter(base({ mine: 'to_approve', cashKttCompanyIds: [] })))?.company_id).toEqual({ $nin: [] });
  });

  it('mine khác to_approve → không áp điều kiện "Duyệt tiền mặt"', () => {
    expect(cashNorCond(queueFilter(base({ mine: 'created' })))).toBeUndefined();
    expect(cashNorCond(queueFilter(base({ mine: 'approved_by_me' })))).toBeUndefined();
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

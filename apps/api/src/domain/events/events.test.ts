import { describe, expect, it } from 'vitest';
import { buildDomainEventDoc, isOutboxGap, RECONCILE_GRACE_MS, RECONCILE_WINDOW_MS, toEventPayload } from './index.ts';

describe('events › outbox (v2 §11.2)', () => {
  it('dựng bản ghi sự kiện chưa xử lý, BigInt trong payload đổi thành chuỗi', () => {
    const now = new Date('2026-10-21T03:00:00Z');
    const doc = buildDomainEventDoc(
      {
        type: 'voucher.approved',
        company_id: 'c1',
        subject_type: 'document',
        subject_id: 'd1',
        payload: { amount_minor: 1_500_000_000n, kind: 'spend', nested: { minor: 7n } },
        actor: { user_id: 'u1', name: 'Nguyễn A', role: 'chief_accountant' },
      },
      now,
    );
    expect(doc).toMatchObject({
      type: 'voucher.approved',
      company_id: 'c1',
      subject_type: 'document',
      subject_id: 'd1',
      processed_at: null,
      claimed_at: null,
      attempts: 0,
      last_error: null,
      created_at: now,
      actor: { user_id: 'u1', name: 'Nguyễn A', role: 'chief_accountant' },
    });
    expect(doc.payload).toEqual({ amount_minor: '1500000000', kind: 'spend', nested: { minor: '7' } });
  });

  it('chấp nhận tên sự kiện có gạch dưới; từ chối tên sai định dạng', () => {
    const base = { company_id: null, subject_type: 'document', subject_id: null };
    expect(() => buildDomainEventDoc({ ...base, type: 'voucher.step_approved' } as never)).not.toThrow();
    expect(() => buildDomainEventDoc({ ...base, type: 'schedule.recurring' } as never)).not.toThrow();
    expect(() => buildDomainEventDoc({ ...base, type: 'Voucher.Paid' } as never)).toThrow(TypeError);
    expect(() => buildDomainEventDoc({ ...base, type: 'paid' } as never)).toThrow(TypeError);
    expect(() => buildDomainEventDoc({ type: 'voucher.paid', company_id: null, subject_type: '', subject_id: null } as never)).toThrow(TypeError);
  });

  it('actor và payload mặc định an toàn khi thiếu', () => {
    const doc = buildDomainEventDoc({ type: 'loan.created', company_id: null, subject_type: 'bank_debt', subject_id: 'b1' } as never);
    expect(doc.actor).toEqual({ user_id: null, name: null, role: null });
    expect(doc.payload).toEqual({});
  });

  it('toEventPayload: ObjectId-like → hex, Date → ISO, mảng và object lồng nhau', () => {
    const oid = { toHexString: () => 'a'.repeat(24) };
    expect(toEventPayload(oid)).toBe('a'.repeat(24));
    expect(toEventPayload(new Date('2026-10-21T00:00:00Z'))).toBe('2026-10-21T00:00:00.000Z');
    expect(toEventPayload([1n, null, 'x'])).toEqual(['1', null, 'x']);
    expect(toEventPayload(undefined)).toBeNull();
  });
});

describe('events › đối chiếu outbox (thao tác thiếu sự kiện)', () => {
  const now = new Date('2026-10-21T03:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it('thao tác chuyển trạng thái đã đủ thời gian chờ mà chưa có sự kiện nào ⇒ khoảng trống', () => {
    expect(isOutboxGap({ action: 'approve', at: ago(RECONCILE_GRACE_MS + 60_000), now, eventsAfter: 0 })).toBe(true);
    expect(isOutboxGap({ action: 'pay', at: ago(10 * 60_000), now, eventsAfter: 0 })).toBe(true);
  });

  it('đã có sự kiện, còn trong thời gian chờ, hoặc quá cửa sổ đối chiếu ⇒ không phải khoảng trống', () => {
    expect(isOutboxGap({ action: 'approve', at: ago(10 * 60_000), now, eventsAfter: 1 })).toBe(false);
    expect(isOutboxGap({ action: 'approve', at: ago(10_000), now, eventsAfter: 0 })).toBe(false);
    expect(isOutboxGap({ action: 'approve', at: ago(RECONCILE_WINDOW_MS + 60_000), now, eventsAfter: 0 })).toBe(false);
  });

  it('hành động không phải chuyển trạng thái (VD cập nhật, gắn tag) không đối chiếu', () => {
    expect(isOutboxGap({ action: 'tags_update', at: ago(10 * 60_000), now, eventsAfter: 0 })).toBe(false);
    expect(isOutboxGap({ action: null, at: ago(10 * 60_000), now, eventsAfter: 0 })).toBe(false);
  });
});

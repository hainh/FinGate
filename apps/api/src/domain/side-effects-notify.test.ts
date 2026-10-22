/**
 * Người nhận thông báo "cấp kế tiếp" (v2 §7.2) tính trên hồ sơ SAU khi ghi:
 *  - bước đang chờ → người phụ trách bước đó (không phải cấp phía trên, không phải người vừa xử lý);
 *  - từ chối / yêu cầu bổ sung → người lập (KTV), không gửi lại cho người vừa từ chối / trả về;
 *  - duyệt xong → người có quyền thực thi thanh toán (payment:mark) trong công ty, trừ người vừa duyệt xong.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainDoc } from './types.ts';

const env = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const state = {
    users: [] as Row[],
    assignments: [] as Row[],
    notifications: [] as Row[],
    mails: [] as { to: string; subject: string; html: string }[],
  };
  /** So khớp tối giản cho các truy vấn của side-effects: bằng nhau hoặc `{ $in: [...] }`. */
  const matchField = (cond: unknown, value: unknown): boolean => {
    if (cond && typeof cond === 'object' && '$in' in cond) {
      return (cond as { $in: unknown[] }).$in.some((x) => String(x) === String(value));
    }
    return String(cond) === String(value);
  };
  const matches = (row: Row, filter: Row): boolean => {
    const { $or, ...fields } = filter;
    if (!Object.entries(fields).every(([k, v]) => matchField(v, row[k]))) return false;
    return Array.isArray($or) ? ($or as Row[]).some((clause) => matches(row, clause)) : true;
  };
  const query = (rows: () => Row[]) => {
    const q = { select: () => q, lean: async () => rows() };
    return q;
  };
  return { state, matches, query };
});

vi.mock('../db/models.ts', () => ({
  Models: {
    Assignment: { find: (filter: Record<string, unknown>) => env.query(() => env.state.assignments.filter((a) => env.matches(a, filter))) },
    User: {
      find: (filter: Record<string, unknown>) => env.query(() => env.state.users.filter((u) => env.matches(u, filter))),
      findById: (id: unknown) => ({ select: () => ({ lean: async () => env.state.users.find((u) => String(u._id) === String(id)) ?? null }) }),
    },
    Company: { findById: () => ({ select: () => ({ lean: async () => ({ name: 'Công ty CTA' }) }) }) },
    Notification: {
      create: async (row: Record<string, unknown>) => {
        env.state.notifications.push(row);
        return row;
      },
    },
  },
}));
vi.mock('./ledger/index.ts', () => ({
  entriesForPayment: vi.fn(),
  postCashEntries: vi.fn(),
  recomputeAccountBalances: vi.fn(),
  sourceAccountOf: vi.fn(),
}));
vi.mock('../lib/cache.ts', () => ({ cacheInvalidate: vi.fn() }));
vi.mock('./queries/badge-cache.ts', () => ({ BADGE_CACHE_PREFIX: 'badge:' }));
vi.mock('../mail/sender.ts', () => ({
  sendMail: vi.fn(async (mail: { to: string; subject: string; html: string }) => {
    env.state.mails.push(mail);
  }),
  mailTemplates: {
    approvalRequest: (i: { roleLabel: string }) => `approval|${i.roleLabel}`,
    docStatus: (i: { headline: string }) => `doc|${i.headline}`,
  },
}));

import { cacheInvalidate } from '../lib/cache.ts';
import { nextLevelRecipients, notifyNextApprover } from './side-effects.ts';

const CO = 'c1';
const OTHER_CO = 'c2';
const GROUP = 'g1';

const user = (id: string, display: string, extra: Record<string, unknown> = {}) => ({
  _id: id,
  email: `${id}@fingate.test`,
  display_name: display,
  status: 'active',
  prefs: { notify_channels: ['web'] },
  ...extra,
});

const assignment = (user_id: string, role: string, company_id = CO, extra: string[] = [], denied: string[] = []) => ({
  user_id,
  role,
  company_id,
  status: 'active',
  extra_permissions: extra,
  denied_permissions: denied,
});

const step = (order: number, role: string, user_id: string | null, state: string) => ({ order, role, user_id, state });

function docOf(over: Record<string, unknown>): DomainDoc {
  return {
    _id: 'd1',
    code: 'PC-2026-00001',
    kind: 'spend',
    company_id: CO,
    created_by: 'u-kt',
    status: 'pending.ktt',
    amount: { minor: 500000000n, currency: 'VND', decimals: 0 },
    approval: { steps: [] },
    ...over,
  } as unknown as DomainDoc;
}

const recipients = (): string[] => env.state.notifications.map((n) => String(n.user_id)).sort();
const titles = (): string[] => env.state.notifications.map((n) => String(n.title));

beforeEach(() => {
  vi.clearAllMocks();
  env.state.users = [
    user('u-kt', 'KTV A', { prefs: { notify_channels: ['web', 'email'] } }),
    user('u-kt2', 'KTV B'),
    user('u-ktb', 'KTV CTB'),
    user('u-ktt', 'KTT'),
    user('u-dd', 'PGĐ'),
    user('u-gd', 'GĐ'),
    user('u-ch', 'Chủ tịch'),
  ];
  env.state.assignments = [
    assignment('u-kt', 'staff'),
    // KTV bị thu quyền thanh toán riêng (ADM-03) → không nhận "cần thực hiện thanh toán"
    assignment('u-kt2', 'staff', CO, [], ['payment:mark']),
    // KTV công ty khác → không thuộc công ty của phiếu
    assignment('u-ktb', 'staff', OTHER_CO),
    assignment('u-ktt', 'chief_accountant'),
    assignment('u-dd', 'deputy_director'),
    assignment('u-gd', 'director'),
    // Chủ tịch (chức danh cấp Tập đoàn) được cấp thêm quyền thanh toán → thuộc nhóm thanh toán mọi công ty con
    assignment('u-ch', 'chairman', GROUP, ['payment:mark']),
  ];
  env.state.notifications = [];
  env.state.mails = [];
});

describe('notifyNextApprover — người nhận cấp kế tiếp (v2 §7.2)', () => {
  it('gửi phiếu: chỉ người phụ trách bước đang chờ, không gửi cho cấp phía trên', async () => {
    await notifyNextApprover({
      doc: docOf({ status: 'pending.ktt', approval: { steps: [step(1, 'chief_accountant', 'u-ktt', 'current'), step(2, 'director', 'u-gd', 'waiting')] } }),
      actorId: 'u-kt',
      actorName: 'KTV A',
      stepRole: 'chief_accountant',
      amountMinor: 500000000n,
      compact: '500 tr',
      status: 'pending.ktt',
    });
    expect(recipients()).toEqual(['u-ktt']);
    expect(titles()).toEqual(['500 tr đang chờ bạn duyệt']);
  });

  it('duyệt tới cấp tiếp theo: người vừa duyệt và cấp cao hơn còn chờ không nhận', async () => {
    await notifyNextApprover({
      doc: docOf({
        status: 'pending.pgd',
        approval: { steps: [step(1, 'chief_accountant', 'u-ktt', 'done'), step(2, 'deputy_director', 'u-dd', 'current'), step(3, 'director', 'u-gd', 'waiting')] },
      }),
      actorId: 'u-ktt',
      actorName: 'KTT',
      stepRole: 'deputy_director',
      amountMinor: 500000000n,
      compact: '500 tr',
      status: 'pending.pgd',
    });
    expect(recipients()).toEqual(['u-dd']);
  });

  it('từ chối: người lập nhận, người vừa từ chối không nhận "bị từ chối"', async () => {
    await notifyNextApprover({
      doc: docOf({ status: 'rejected', approval: { steps: [step(1, 'chief_accountant', 'u-ktt', 'rejected')] } }),
      actorId: 'u-ktt',
      actorName: 'KTT',
      stepRole: null,
      amountMinor: 500000000n,
      compact: '500 tr',
      status: 'rejected',
      statusLabel: 'Từ chối',
    });
    expect(recipients()).toEqual(['u-kt']);
    expect(titles()).toEqual(['PC-2026-00001 bị từ chối']);
    expect(env.state.notifications[0]!.body).toBe('PC-2026-00001 · 500 tr · từ chối bởi KTT');
    expect(env.state.mails).toEqual([
      { to: 'u-kt@fingate.test', subject: 'PC-2026-00001 bị từ chối · PC-2026-00001', html: 'doc|PC-2026-00001 bị từ chối' },
    ]);
  });

  it('yêu cầu bổ sung: người lập nhận, người vừa trả về không nhận "đang chờ bạn duyệt"', async () => {
    await notifyNextApprover({
      doc: docOf({ status: 'changes_requested', approval: { steps: [step(1, 'chief_accountant', 'u-ktt', 'waiting')] } }),
      actorId: 'u-ktt',
      actorName: 'KTT',
      stepRole: 'chief_accountant',
      amountMinor: 6000000n,
      compact: '6 tr',
      status: 'changes_requested',
    });
    expect(recipients()).toEqual(['u-kt']);
    expect(titles()).toEqual(['PC-2026-00001 bị yêu cầu bổ sung']);
  });

  it('duyệt xong: người có quyền thực thi (payment:mark) nhận, trừ người vừa duyệt xong', async () => {
    await notifyNextApprover({
      doc: docOf({ status: 'approved', approval: { steps: [step(1, 'chief_accountant', 'u-ktt', 'done')] } }),
      actorId: 'u-ktt',
      actorName: 'KTT',
      stepRole: null,
      amountMinor: 500000000n,
      compact: '500 tr',
      status: 'approved',
    });
    // KTV (có quyền), GĐ (có quyền), Chủ tịch (được cấp thêm); loại KTV bị thu quyền, PGĐ (không có quyền), KTT (người vừa duyệt)
    expect(recipients()).toEqual(['u-ch', 'u-gd', 'u-kt']);
    expect(titles().every((t) => t === 'PC-2026-00001 đã duyệt xong — cần thực hiện thanh toán')).toBe(true);
  });

  it('duyệt xong: người thanh toán không còn hoạt động không nhận', async () => {
    env.state.users.find((u) => u._id === 'u-gd')!.status = 'inactive';
    await notifyNextApprover({
      doc: docOf({ status: 'approved', approval: { steps: [step(1, 'chief_accountant', 'u-ktt', 'done')] } }),
      actorId: 'u-ktt',
      actorName: 'KTT',
      stepRole: null,
      amountMinor: 500000000n,
      compact: '500 tr',
      status: 'approved',
    });
    expect(recipients()).toEqual(['u-ch', 'u-kt']);
  });

  it('đưa vào hàng thanh toán / đã thực thi: không có cấp kế tiếp để báo, vẫn làm mới badge', async () => {
    for (const status of ['processing', 'paid'] as const) {
      await notifyNextApprover({
        doc: docOf({ status, approval: { steps: [step(1, 'chief_accountant', 'u-ktt', 'done')] } }),
        actorId: 'u-kt',
        actorName: 'KTV A',
        stepRole: null,
        amountMinor: 500000000n,
        compact: '500 tr',
        status,
      });
    }
    expect(env.state.notifications).toHaveLength(0);
    expect(cacheInvalidate).toHaveBeenCalled();
  });

  it('phương án đảo hạn đã duyệt xong: không gửi "cần thực hiện thanh toán" (không có bước thanh toán)', async () => {
    await notifyNextApprover({
      doc: docOf({ kind: 'rollover', status: 'approved', approval: { steps: [step(1, 'chief_accountant', 'u-ktt', 'done')] } }),
      actorId: 'u-ktt',
      actorName: 'KTT',
      stepRole: null,
      amountMinor: 500000000n,
      compact: '500 tr',
      status: 'approved',
    });
    expect(env.state.notifications).toHaveLength(0);
  });

  it('bước chưa gán người: thông báo người đúng chức danh trong công ty của phiếu', async () => {
    await notifyNextApprover({
      doc: docOf({ status: 'pending.ktt', approval: { steps: [step(1, 'chief_accountant', null, 'current')] } }),
      actorId: 'u-kt',
      actorName: 'KTV A',
      stepRole: 'chief_accountant',
      amountMinor: 500000000n,
      compact: '500 tr',
      status: 'pending.ktt',
    });
    expect(recipients()).toEqual(['u-ktt']);
  });
});

describe('nextLevelRecipients', () => {
  it('trạng thái nháp / không có cấp kế tiếp: không có người nhận', async () => {
    expect(await nextLevelRecipients({ doc: docOf({ status: 'draft', approval: { steps: [] } }), status: 'draft', actorId: 'u-kt' })).toEqual([]);
  });

  it('thanh toán chỉ tính trong công ty của phiếu (không lấy KTV công ty khác)', async () => {
    const ids = await nextLevelRecipients({
      doc: docOf({ status: 'approved', approval: { steps: [step(1, 'chief_accountant', 'u-ktt', 'done')] } }),
      status: 'approved',
      actorId: 'u-ktt',
    });
    expect(ids).not.toContain('u-ktb');
    expect(ids).toEqual(expect.arrayContaining(['u-kt', 'u-gd', 'u-ch']));
  });
});

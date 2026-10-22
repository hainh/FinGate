import { describe, expect, it } from 'vitest';
import { documentPermissions } from './index.ts';

type Step = { order: number; role: 'chief_accountant' | 'director'; user_id: string | null; state: string };

const APPROVER = ['doc:read', 'approval:act', 'payment:mark'];

/** Quyền của người dùng `u-actor` trên hồ sơ (mặc định: KTT, hạn mức đủ, đúng công ty, không phải người lập). */
function perms(opts: {
  status: string;
  permissions?: string[];
  role?: 'staff' | 'chief_accountant';
  amountLimit?: bigint;
  amountMinor?: bigint;
  steps?: Step[];
  evidenceMissing?: string[];
  mine?: boolean;
}) {
  return documentPermissions(
    {
      user_id: 'u-actor',
      permissions: opts.permissions ?? APPROVER,
      amount_limit_minor: opts.amountLimit ?? 10_000_000_000n,
      role: opts.role ?? 'chief_accountant',
    },
    {
      status: opts.status,
      created_by: opts.mine ? 'u-actor' : 'u-staff',
      amount_minor: opts.amountMinor ?? 5_000_000n,
      steps: opts.steps ?? [],
      evidence_missing: opts.evidenceMissing ?? [],
      company_id: 'A',
      actor_companies: ['A'],
      delegatedStepOrders: [],
      approved_from_ktt_up: true,
    },
  );
}

describe('documentPermissions — v2 §7.1 Đang thanh toán → Yêu cầu bổ sung (DangThanhToan --> YeuCauBoSung)', () => {
  it('KTT (approval:act, đủ hạn mức) đưa phiếu đang thanh toán về bổ sung; không duyệt / từ chối được', () => {
    const c = perms({ status: 'processing' });
    expect(c.request_changes).toBe(true);
    expect(c.reject).toBe(false);
    expect(c.approve).toBe(false);
  });

  it('kế toán viên (không có approval:act) không đưa về bổ sung được', () => {
    const c = perms({ status: 'processing', permissions: ['doc:read', 'doc:create', 'payment:mark'], role: 'staff', mine: true });
    expect(c.request_changes).toBe(false);
  });

  it('vượt hạn mức duyệt ⇒ không đưa về bổ sung; trong hạn mức ⇒ được', () => {
    expect(perms({ status: 'processing', amountLimit: 1_000_000n, amountMinor: 5_000_000n }).request_changes).toBe(false);
    expect(perms({ status: 'processing', amountLimit: 5_000_000n, amountMinor: 5_000_000n }).request_changes).toBe(true);
  });

  it('thiếu chứng từ bắt buộc: cần approval:override (cùng luật với duyệt)', () => {
    expect(perms({ status: 'processing', evidenceMissing: ['contract'] }).request_changes).toBe(false);
    expect(
      perms({ status: 'processing', evidenceMissing: ['contract'], permissions: [...APPROVER, 'approval:override'] }).request_changes,
    ).toBe(true);
  });

  it('không có cạnh này ở trạng thái khác: đã duyệt (chưa đưa vào hàng), đã thanh toán', () => {
    expect(perms({ status: 'approved' }).request_changes).toBe(false);
    expect(perms({ status: 'paid' }).request_changes).toBe(false);
  });
});

describe('documentPermissions — quyết định duyệt chỉ ở bước đang chờ (pending.*) — khớp máy trạng thái', () => {
  it('bước đang chờ của mình (đến lượt): duyệt / từ chối / yêu cầu bổ sung đều có', () => {
    const steps: Step[] = [{ order: 1, role: 'chief_accountant', user_id: 'u-actor', state: 'current' }];
    const c = perms({ status: 'pending.ktt', steps });
    expect(c.approve).toBe(true);
    expect(c.reject).toBe(true);
    expect(c.request_changes).toBe(true);
  });

  it('duyệt vượt cấp (bước của mình còn waiting, cấp dưới đang current): chỉ Duyệt trước, không Duyệt thường', () => {
    const steps: Step[] = [
      { order: 1, role: 'chief_accountant', user_id: 'u-other', state: 'current' },
      { order: 2, role: 'director', user_id: 'u-actor', state: 'waiting' },
    ];
    const c = perms({ status: 'pending.gd', steps });
    expect(c.fast_track).toBe(true);
    expect(c.approve).toBe(false);
  });

  it('đã trả về bổ sung (changes_requested): người từng giữ bước KHÔNG còn Duyệt / Từ chối / Yêu cầu bổ sung', () => {
    // sau khi trả về mọi bước về `waiting`, nhưng trạng thái này không có cạnh quyết định trong máy trạng thái
    const steps: Step[] = [{ order: 1, role: 'chief_accountant', user_id: 'u-actor', state: 'waiting' }];
    const c = perms({ status: 'changes_requested', steps });
    expect(c.approve).toBe(false);
    expect(c.reject).toBe(false);
    expect(c.request_changes).toBe(false);
  });
});

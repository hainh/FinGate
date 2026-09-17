import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_STATUS_REGISTRY,
  ACTIONS,
  DOC_CODE_PREFIX,
  EVIDENCE_LABEL,
  STATUS_KEYS,
  STATUS_REGISTRY,
  TERMINAL_STATUSES,
  accountStatusFor,
  daysLabel,
  maturity,
  maturityLabel,
  pendingStatusForRole,
  statusChipLabel,
  statusLabel,
  statusTone,
  TONES,
} from '../src/status/index.js';
import { APPROVER_ROLES, buildEntitlements, hasPermission, isSensitiveAction, MFA_REQUIRED_ROLES } from '../src/permissions/index.js';
import { PROBLEM_CATALOG, apiError, parseProblem, toProblem } from '../src/errors/index.js';
import { UI, docHref } from '../src/text/index.js';

describe('status/registry — nguồn duy nhất cho API · UI · Excel · email', () => {
  it('có đủ các key theo DS §3.1 + workflow arch §9.1', () => {
    for (const k of [
      'draft',
      'pending.kt',
      'pending.ktt',
      'pending.pgd',
      'pending.gd',
      'approved',
      'processing',
      'paid',
      'rejected',
      'changes_requested',
      'cancelled',
      'overdue',
    ]) {
      expect(STATUS_KEYS).toContain(k);
    }
  });

  it('mỗi status có đủ icon + nhãn + tone hợp lệ (DS §3.4: không chỉ màu)', () => {
    for (const key of STATUS_KEYS) {
      const def = STATUS_REGISTRY[key];
      expect(TONES).toContain(def.tone);
      expect(def.labelVi.length).toBeGreaterThan(0);
      expect(def.key).toBe(key);
      // nhãn tiếng Việt: không viết Hoa giữa câu, không phải key tiếng Anh
      expect(def.labelVi).not.toBe(key);
      expect(def.glyph.length).toBeGreaterThan(0);
    }
  });

  it('pending.* phải có ownerRole — "đang nằm ở bàn của ai" (DS §1.5)', () => {
    for (const key of STATUS_KEYS.filter((k) => k.startsWith('pending.'))) {
      expect(STATUS_REGISTRY[key].ownerRole).toBeTruthy();
      expect(STATUS_REGISTRY[key].pending).toBe(true);
    }
  });

  it('tone theo DS §3.1: pgd/gd = warning, ktt = info, rejected/overdue = danger', () => {
    expect(statusTone('pending.pgd')).toBe('warning');
    expect(statusTone('pending.gd')).toBe('warning');
    expect(statusTone('pending.ktt')).toBe('info');
    expect(statusTone('rejected')).toBe('danger');
    expect(statusTone('overdue')).toBe('danger');
    expect(statusTone('changes_requested')).toBe('attention');
    expect(statusTone('paid')).toBe('success');
    expect(statusTone('nope')).toBe('neutral'); // giá trị lạ không được ném lỗi
  });

  it('chip có owner + số ngày chờ', () => {
    expect(statusChipLabel('pending.gd')).toBe('◍ Chờ Giám đốc');
    expect(statusLabel('pending.ktt')).toBe('Chờ Kế toán trưởng');
    expect(statusChipLabel('pending.gd', { waitingDays: 3 })).toContain('còn 3 ngày');
  });

  it('trạng thái cuối không còn bước tiếp', () => {
    expect(TERMINAL_STATUSES).toEqual(expect.arrayContaining(['paid', 'rejected', 'cancelled', 'expired']));
    expect(TERMINAL_STATUSES).not.toContain('approved');
  });

  it('pendingStatusForRole khớp vai trò', () => {
    expect(pendingStatusForRole('director')).toBe('pending.gd');
    expect(pendingStatusForRole('chairman')).toBe('pending.chairman');
    expect(pendingStatusForRole('admin')).toBeUndefined();
  });

  it('mã phiếu theo loại (blueprint §XXX.1)', () => {
    expect(DOC_CODE_PREFIX.spend).toBe('PC');
    expect(DOC_CODE_PREFIX.income).toBe('PT');
    expect(DOC_CODE_PREFIX.rollover).toBe('DH');
    expect(docHref('spend', 'abc123')).toBe('/ho-so/chi/abc123');
  });

  it('action luôn có nhãn Việt + yêu cầu ý kiến khi từ chối', () => {
    expect(ACTIONS).toContain('approve_with_reason');
    expect(UI.action.approve).toBe('Duyệt');
    expect(UI.action.reject).toBe('Từ chối');
    for (const a of ['reject', 'request_changes', 'approve_with_reason'] as const) {
      expect(ACTIONS).toContain(a);
    }
  });

  it('mọi evidence type có nhãn', () => {
    expect(EVIDENCE_LABEL.contract).toBe('Hợp đồng');
  });
});

describe('maturity ladder — 4 mức đáo hạn (DS §3.3) luôn kèm số ngày', () => {
  it('ánh xạ ngưỡng', () => {
    expect(maturity(0)).toMatchObject({ level: 3, tone: 'danger', bucket: 'today' });
    expect(maturity(3)).toMatchObject({ level: 3, tone: 'danger', bucket: '3d' });
    expect(maturity(4)).toMatchObject({ level: 2, tone: 'warning', bucket: '7d' });
    expect(maturity(7)).toMatchObject({ level: 2, tone: 'warning', bucket: '7d' });
    expect(maturity(8)).toMatchObject({ level: 1, tone: 'attention', bucket: '30d' });
    expect(maturity(30)).toMatchObject({ level: 1, tone: 'attention', bucket: '30d' });
    expect(maturity(31)).toMatchObject({ level: 0, tone: 'neutral', bucket: 'later' });
    expect(maturity(-2).level).toBe(3);
  });

  it('luôn có số ngày cụ thể, không chỉ màu', () => {
    expect(maturityLabel(0)).toContain('hôm nay');
    expect(maturityLabel(2)).toContain('2 ngày');
    expect(maturityLabel(18)).toContain('18 ngày');
    expect(daysLabel(-5)).toContain('5 ngày');
    // level 0: không có glyph nhưng vẫn có số ngày
    expect(maturityLabel(90).length).toBeGreaterThan(0);
  });
});

describe('account status — registry riêng, không trộn workflow (DS §3.5)', () => {
  it('deactivated là trung tính, không phải danger', () => {
    expect(ACCOUNT_STATUS_REGISTRY.deactivated.tone).toBe('neutral');
    expect(ACCOUNT_STATUS_REGISTRY.invited.tone).toBe('attention');
    expect(STATUS_REGISTRY['pending.gd'].tone).not.toBe(ACCOUNT_STATUS_REGISTRY.invited.tone);
  });

  it('giá trị lạ không làm sập UI', () => {
    expect(accountStatusFor('weird').key).toBe('deactivated');
    expect(accountStatusFor('active').labelVi).toBe('Đang hoạt động');
  });
});

describe('entitlements — server trả quyền, UI chỉ ẩn nút (§19.5-4)', () => {
  it('nhân viên kế toán không tự duyệt', () => {
    const e = buildEntitlements({ role: 'staff', company_id: 'a'.repeat(24) });
    expect(e.permissions).toContain('doc:create');
    expect(e.permissions).not.toContain('approval:act');
    expect(e.actions['approval:act']).toBe(false);
  });

  it('chủ tịch HĐQT không nhập liệu nhưng quản lý nhân sự + tài khoản tập đoàn + ma trận duyệt', () => {
    const e = buildEntitlements({ role: 'chairman', company_id: 'a'.repeat(24) });
    expect(e.permissions).not.toContain('doc:create');
    expect(e.permissions).toContain('hr:disable');
    expect(e.permissions).toContain('admin:group_accounts');
    expect(e.permissions).toContain('admin:matrix');
    expect(e.scope_all).toBe(true);
  });

  it('kế toán trưởng không có quyền quản trị matrix; giám đốc và chủ tịch có', () => {
    expect(buildEntitlements({ role: 'chief_accountant', company_id: 'a'.repeat(24) }).actions['admin:matrix']).toBe(false);
    expect(buildEntitlements({ role: 'director', company_id: 'a'.repeat(24) }).actions['admin:matrix']).toBe(true);
    expect(buildEntitlements({ role: 'chairman', company_id: 'a'.repeat(24) }).actions['admin:matrix']).toBe(true);
  });

  it('cột nhạy cảm ẩn kèm lý do khi không có quyền', () => {
    const e = buildEntitlements({ role: 'staff', company_id: 'a'.repeat(24) });
    const email = e.columns.find((c) => c.column === 'user_email');
    expect(email?.visible).toBe(false);
    expect(email?.reason).toBeTruthy();
    // staff có bank:read → thấy số TK (blueprint §III: theo dõi số dư)
    expect(e.columns.find((c) => c.column === 'account_number')?.visible).toBe(true);
  });

  it('vai trò duyệt bắt buộc 2FA', () => {
    for (const r of MFA_REQUIRED_ROLES) {
      expect(buildEntitlements({ role: r, company_id: 'a'.repeat(24) }).mfa_required).toBe(true);
    }
    expect(APPROVER_ROLES).toContain('chief_accountant');
    expect(isSensitiveAction('report:export')).toBe(true);
    expect(isSensitiveAction('doc:read')).toBe(false);
    expect(hasPermission(['doc:read'], ['doc:read', 'audit:read'])).toBe(true);
    expect(hasPermission(['doc:read'], 'audit:read')).toBe(false);
  });

  it('denied gỡ được quyền của vai trò', () => {
    const e = buildEntitlements({ role: 'director', company_id: 'a'.repeat(24), denied: ['report:export'] });
    expect(e.permissions).not.toContain('report:export');
  });
});

describe('errors — problem+json với code FinGate (arch §6)', () => {
  it('mọi code có status + title tiếng Việt', () => {
    for (const code of Object.keys(PROBLEM_CATALOG) as (keyof typeof PROBLEM_CATALOG)[]) {
      const def = PROBLEM_CATALOG[code];
      // FG-WF-012 / FG-SYS-003 là mã thông báo, trả 200 có chủ đích
      expect([200, 400, 401, 403, 409, 410, 413, 422, 429, 500, 503]).toContain(def.status);
      expect(def.titleVi.length).toBeGreaterThan(3);
      // không lộ stack/kỹ thuật trong message
      expect(def.titleVi).not.toMatch(/Error|exception|null|undefined/i);
    }
  });

  it('CAS conflict → 409 kèm hint refetch', () => {
    const err = apiError('FG-WF-011', { data: { by: 'Nguyễn B', at: '09:15' } });
    expect(err.status).toBe(409);
    const p = toProblem(err, 'trace-1');
    expect(p.code).toBe('FG-WF-011');
    expect(p.trace_id).toBe('trace-1');
    expect(p.data).toMatchObject({ by: 'Nguyễn B' });
    expect(p.type).toContain('fingate.local');
  });

  it('sai credentials không tiết lộ field nào sai (AUTH-01)', () => {
    expect(PROBLEM_CATALOG['FG-AUTH-002'].titleVi).toBe('Email hoặc mật khẩu không đúng');
  });

  it('parseProblem chịu được body rác', () => {
    expect(parseProblem(403, 'oops').code).toBe('FG-RBAC-001');
    expect(parseProblem(401, null).code).toBe('FG-AUTH-001');
    expect(parseProblem(500, {}).code).toBe('FG-SYS-001');
    expect(parseProblem(422, { code: 'FG-VAL-001', detail: 'x' }).detail).toBe('x');
    expect(parseProblem(422, { code: 'NOT_A_CODE' }).code).toBe('FG-SYS-001');
  });
});

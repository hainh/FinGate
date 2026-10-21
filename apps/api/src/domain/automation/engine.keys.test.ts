import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/models.ts', () => ({ Models: {} }));

import {
  clearRuleHandlers,
  DEFAULT_AUTOMATION_RULES,
  getRuleHandler,
  idemKeyFor,
  registerRule,
  runFailureAlertKey,
  runKeyFor,
} from './engine.ts';

beforeEach(() => {
  clearRuleHandlers();
});

describe('engine › khoá lượt chạy theo sự kiện', () => {
  it('mặc định: rule:source:event_type (không gắn id sự kiện)', () => {
    expect(runKeyFor('R2', 'd1', 'voucher.updated', 'e9', undefined)).toBe('R2:d1:voucher.updated');
    expect(runKeyFor('R2', 'd1', 'voucher.updated', 'e9', { occurrenceEvents: [] })).toBe('R2:d1:voucher.updated');
  });

  it('sự kiện khai trong occurrenceEvents: mỗi lần xảy ra một khoá riêng (gắn id sự kiện)', () => {
    const handler = { occurrenceEvents: ['voucher.updated'] };
    expect(runKeyFor('R2', 'd1', 'voucher.updated', 'e1', handler)).toBe('R2:d1:voucher.updated#e1');
    expect(runKeyFor('R2', 'd1', 'voucher.updated', 'e2', handler)).toBe('R2:d1:voucher.updated#e2');
    // sự kiện không nằm trong danh sách vẫn theo khoá chuẩn
    expect(runKeyFor('R2', 'd1', 'voucher.approved', 'e3', handler)).toBe('R2:d1:voucher.approved');
  });

  it('không có id sự kiện ⇒ không thể tách lượt, dùng khoá chuẩn', () => {
    expect(runKeyFor('R5', 'r1', 'schedule.recurring', null, { occurrenceEvents: ['schedule.recurring'] })).toBe(
      idemKeyFor('R5', 'r1', 'schedule.recurring'),
    );
  });

  it('xử lý lại cùng một sự kiện cho cùng khoá (retry không sinh lượt thứ hai)', () => {
    const handler = { occurrenceEvents: ['voucher.submitted'] };
    expect(runKeyFor('R2', 'd1', 'voucher.submitted', 'same', handler)).toBe(runKeyFor('R2', 'd1', 'voucher.submitted', 'same', handler));
  });
});

describe('engine › đăng ký bộ xử lý', () => {
  it('lưu occurrenceEvents cùng các bước; thiếu thì là danh sách rỗng', () => {
    registerRule('R2', {
      occurrenceEvents: ['voucher.updated', 'voucher.submitted'],
      steps: [{ name: 'create_loan', run: async () => ({ skipped: true }) }],
    });
    registerRule('R3', { steps: [{ name: 'create_loan', run: async () => ({ skipped: true }) }] });
    expect(getRuleHandler('R2')?.occurrenceEvents).toEqual(['voucher.updated', 'voucher.submitted']);
    expect(getRuleHandler('R3')?.occurrenceEvents).toEqual([]);
  });

  it('từ chối tên bước không hợp lệ hoặc trùng', () => {
    expect(() => registerRule('RX', { steps: [{ name: 'Create-Loan', run: async () => undefined }] })).toThrow(/không hợp lệ/);
    expect(() =>
      registerRule('RX', {
        steps: [
          { name: 'link', run: async () => undefined },
          { name: 'link', run: async () => undefined },
        ],
      }),
    ).toThrow(/trùng/);
  });
});

describe('engine › định nghĩa quy tắc mặc định (v2 §11.3, §14.2)', () => {
  const def = (code: string) => DEFAULT_AUTOMATION_RULES.find((r) => r.code === code);

  it('có đủ R1…R6; R4 tắt mặc định, các quy tắc còn lại bật', () => {
    expect(DEFAULT_AUTOMATION_RULES.map((r) => r.code)).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    expect(def('R4')?.enabled).toBe(false);
    for (const code of ['R1', 'R2', 'R3', 'R5', 'R6']) expect(def(code)?.enabled).toBe(true);
  });

  it('R2 nghe đủ sự kiện tạo / sửa / gửi / duyệt / thực thi phiếu thu đi vay', () => {
    const r2 = def('R2');
    const types = [r2?.trigger_event, ...(r2?.trigger_events ?? [])];
    expect(types).toEqual(expect.arrayContaining(['voucher.created', 'voucher.updated', 'voucher.submitted', 'voucher.approved', 'voucher.paid']));
    // mọi phiếu thu: bước kích hoạt áp dụng cho mọi liên kết giải ngân (không chỉ phiếu có cờ vay)
    expect(r2?.condition).toEqual({ 'payload.kind': 'income' });
    expect(r2?.params).toMatchObject({ term_months: 12, due_offset_months: 11, r2_create_at: 'save' });
  });

  it('R3 chạy khi phiếu chi vay để chi được duyệt cuối, gồm bước kích hoạt khoản vay sau khi thực thi', () => {
    const r3 = def('R3');
    expect(r3?.trigger_event).toBe('voucher.approved');
    expect(r3?.condition).toEqual({ 'payload.kind': 'spend', 'payload.loan_kind': 'fund' });
    expect(r3?.steps).toEqual(['create_loan', 'create_voucher', 'link', 'execute_voucher', 'activate_loan']);
  });

  it('R6 nghe huỷ và từ chối, chỉ với phiếu có cờ vay; bước huỷ khoản chưa giải ngân đứng trước cảnh báo', () => {
    const r6 = def('R6');
    expect([r6?.trigger_event, ...(r6?.trigger_events ?? [])]).toEqual(['voucher.cancelled', 'voucher.rejected']);
    expect(r6?.condition).toEqual({ 'payload.loan_kind': { $ne: null } });
    expect(r6?.steps).toEqual(['cancel_unpaid', 'alert']);
  });

  it('R5 nghe lịch định kỳ', () => {
    expect(def('R5')?.trigger_event).toBe('schedule.recurring');
  });
});

describe('engine › cảnh báo lượt lỗi (khoá theo lần thử)', () => {
  it('cùng lượt, cùng lần thử ⇒ cùng khoá (không báo hai lần); lần thử mới ⇒ khoá mới (KTT được báo lại)', () => {
    expect(runFailureAlertKey('r1', 1)).toBe(runFailureAlertKey('r1', 1));
    expect(runFailureAlertKey('r1', 2)).not.toBe(runFailureAlertKey('r1', 1));
    expect(runFailureAlertKey('r1', 2)).toBe('automation_run_failed:r1:2');
  });
});

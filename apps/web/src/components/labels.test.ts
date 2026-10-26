import { describe, expect, it } from 'vitest';
import { auditActionLabel, debtHistoryActionLabel, documentHistoryActionLabel, loanHistoryActionLabel } from './labels.ts';

/** Mã audit do API ghi (mirrorAudit / rebuildAudit): mỗi mã phải có nhãn tiếng Việt, không hiện mã thô. */
const API_AUDIT_CODES = [
  'auth.login', 'auth.logout', 'auth.login_2fa', 'auth.2fa_enable', 'auth.step_up', 'auth.password_reset', 'auth.password_reset_by_admin',
  'session.revoke',
  'document.create', 'document.update', 'document.delete', 'document.opinion', 'document.auto_create', 'document.tags_update',
  'document.tag_merge', 'document.attachment_confirm', 'document.attachment_remove',
  'partner.create', 'partner.update', 'partner.delete', 'partner.settle', 'partner.copy', 'partner.merge', 'partner.deactivate', 'partner.reactivate',
  'debt.create', 'debt.update', 'debt.delete', 'debt.link', 'debt.unlink', 'debt.attachment_confirm', 'debt.attachment_remove',
  'link.create', 'link.remove',
  'bank_debt.create', 'bank_debt.update', 'bank_debt.delete', 'bank_debt.import', 'bank_debt.cancel', 'bank_debt.auto_create',
  'bank_debt.rollover_result', 'bank_debt.repay', 'bank_debt.unrepay', 'bank_debt.disburse_link', 'bank_debt.unlink',
  'bank_debt.archive', 'bank_debt.activate',
  'loan.attachment_confirm', 'loan.attachment_remove', 'rollover.result', 'recurring.materialize', 'revive', 'archive',
  'bank_account.create', 'bank_account.update', 'bank_account.active', 'bank_account.frozen', 'bank_account.closed',
  'bank.statement_import', 'internal_transfer.create',
  'tag.create', 'tag.update', 'tag.merge', 'tag.hide', 'tag.unhide',
  'hr.invite', 'hr.invite_resend', 'hr.invite_regenerate', 'hr.invite_revoke', 'hr.password_link_regenerate',
  'hr.password_link_revoke', 'hr.activate', 'hr.deactivate', 'hr.reactivate', 'hr.update', 'hr.transfer',
  'department.activate', 'department.deactivate', 'department.delete', 'delegation.create',
  'matrix.create', 'matrix.update', 'settings.update', 'setting.update', 'automation.update', 'alert_rule.upsert',
  'company.create', 'company.update', 'report.export', 'db.backup', 'db.archive', 'auto_sync',
  // mã lịch sử hồ sơ được rebuildAudit sao nguyên sang audit_log
  'create', 'update', 'submit', 'approve', 'approve_with_reason', 'reject', 'request_changes', 'cancel', 'pay', 'queue_payment',
  'expire', 'opinion', 'tags_update', 'tag_merge', 'attachment_add', 'attachment_remove', 'delete', 'auto_create', 'rerun',
  'rollover_result', 'recurring_materialize', 'migrate_v2',
];

/** Tab Audit trên chi tiết phiếu: mã lịch sử của hồ sơ → nhãn tiếng Việt (không hiện mã thô). */
describe('documentHistoryActionLabel', () => {
  it('nhãn các hành động lịch sử hồ sơ', () => {
    expect(documentHistoryActionLabel('create')).toBe('Tạo hồ sơ');
    expect(documentHistoryActionLabel('submit')).toBe('Gửi duyệt');
    expect(documentHistoryActionLabel('approve')).toBe('Duyệt');
    expect(documentHistoryActionLabel('request_changes')).toBe('Yêu cầu bổ sung');
    expect(documentHistoryActionLabel('tags_update')).toBe('Sửa tag');
    expect(documentHistoryActionLabel('tag_merge')).toBe('Gộp tag');
  });

  it('mã lạ giữ nguyên (không để trống)', () => {
    expect(documentHistoryActionLabel('some_future_action')).toBe('some_future_action');
  });

  it('lịch sử migrate từ v1 (migrate_v2) có nhãn tiếng Việt', () => {
    expect(documentHistoryActionLabel('migrate_v2')).toBe('Chuyển dữ liệu từ v1');
  });
});

/** Thẻ "Lịch sử thay đổi" của khoản vay ngân hàng / khoản công nợ: cột Thao tác hiện nhãn tiếng Việt. */
describe('loanHistoryActionLabel / debtHistoryActionLabel', () => {
  it('lịch sử khoản vay: mã thô → nhãn tiếng Việt (đúng các mã có trong DB)', () => {
    expect(loanHistoryActionLabel('create')).toBe('Tạo khoản vay');
    expect(loanHistoryActionLabel('activate')).toBe('Kích hoạt khoản vay');
    expect(loanHistoryActionLabel('rollover_result')).toBe('Kết quả đảo hạn');
    expect(loanHistoryActionLabel('auto_create')).toBe('Tự động tạo khoản vay');
    expect(loanHistoryActionLabel('migrate_v2')).toBe('Chuyển dữ liệu từ v1');
  });

  it('mọi mã lịch sử khoản vay đã ghi đều có nhãn (không trả về chính mã)', () => {
    const codes = ['create', 'update', 'activate', 'cancel', 'revive', 'archive', 'auto_create', 'auto_sync', 'rollover_result', 'repay_link', 'attachment_add', 'attachment_remove', 'migrate_v2'];
    expect(codes.filter((c) => loanHistoryActionLabel(c) === c)).toEqual([]);
  });

  it('lịch sử công nợ dùng nhãn riêng (Tạo / Sửa khoản công nợ); mã lạ giữ nguyên', () => {
    expect(debtHistoryActionLabel('create')).toBe('Tạo khoản công nợ');
    expect(debtHistoryActionLabel('update')).toBe('Sửa khoản công nợ');
    expect(debtHistoryActionLabel('some_future_action')).toBe('some_future_action');
  });

  it('lịch sử công nợ: mã v1 gán / gỡ phiếu cấn trừ (link_document / unlink_document) có nhãn tiếng Việt', () => {
    expect(debtHistoryActionLabel('link_document')).toBe('Cấn trừ phiếu');
    expect(debtHistoryActionLabel('unlink_document')).toBe('Gỡ cấn trừ phiếu');
  });

  it('mọi mã lịch sử công nợ đã ghi trong dữ liệu đều có nhãn (không trả về chính mã)', () => {
    const codes = ['create', 'update', 'attachment_add', 'link_document', 'unlink_document', 'migrate_v2'];
    expect(codes.filter((c) => debtHistoryActionLabel(c) === c)).toEqual([]);
  });
});

/** ADM-12 (Audit log): cột Hành động không hiện mã thô. */
describe('auditActionLabel', () => {
  it('nhãn tiếng Việt cho ẩn/hiện tag và các mã đã báo lỗi', () => {
    expect(auditActionLabel('tag.hide')).toBe('Ẩn tag');
    expect(auditActionLabel('tag.unhide')).toBe('Hiện lại tag');
    expect(auditActionLabel('tag.create')).toBe('Tạo tag');
    expect(auditActionLabel('approve')).toBe('Duyệt');
    expect(auditActionLabel('submit')).toBe('Gửi duyệt');
    expect(auditActionLabel('reject')).toBe('Từ chối');
    expect(auditActionLabel('document.create')).toBe('Tạo hồ sơ');
    expect(auditActionLabel('partner.create')).toBe('Tạo đối tác');
    expect(auditActionLabel('bank_debt.rollover_result')).toBe('Kết quả đảo hạn');
    expect(auditActionLabel('rollover.result')).toBe('Kết quả đảo hạn');
  });

  it('ngừng / kích hoạt lại đối tác và bật 2 lớp có nhãn tiếng Việt', () => {
    expect(auditActionLabel('partner.deactivate')).toBe('Ngừng giao dịch đối tác');
    expect(auditActionLabel('partner.reactivate')).toBe('Kích hoạt lại đối tác');
    expect(auditActionLabel('auth.2fa_enable')).toBe('Bật xác thực 2 lớp');
  });

  it('mã cũ còn trong audit_log (counterparty, auto_income) có nhãn tiếng Việt', () => {
    expect(auditActionLabel('counterparty.create')).toBe('Tạo đối tác');
    expect(auditActionLabel('counterparty.delete')).toBe('Xoá đối tác');
    expect(auditActionLabel('document.auto_income')).toBe('Tự động tạo phiếu thu');
  });

  it('mọi mã API ghi đều có nhãn tiếng Việt (không trả về chính mã)', () => {
    expect(API_AUDIT_CODES.filter((code) => auditActionLabel(code) === code)).toEqual([]);
  });

  it('mã lạ giữ nguyên (không để trống)', () => {
    expect(auditActionLabel('some.future_action')).toBe('some.future_action');
  });
});

/**
 * FinGate web — nhãn vai trò / hành động / chứng từ (đồng bộ registry shared).
 */

import { ACTION_LABEL, EVIDENCE_LABEL, type Action, type EvidenceType } from '@fingate/shared';

export const ROLES_LABEL: Record<string, string> = {
  staff: 'Kế toán viên',
  chief_accountant: 'Kế toán trưởng',
  deputy_director: 'Phó Giám đốc',
  director: 'Giám đốc',
  deputy_chairman: 'Phó Tổng Giám đốc (Phó Chủ tịch)',
  chairman: 'Tổng Giám đốc (Chủ tịch)',
  admin: 'Quản trị hệ thống',
};

export const actionLabel = (a: string): string => ACTION_LABEL[a as Action] ?? a;
export const evidenceLabel = (t: string): string => EVIDENCE_LABEL[t as EvidenceType] ?? t;

/**
 * Hành động trong LỊCH SỬ HỒ SƠ (`history[].action` của phiếu — mã ngắn, không có tiền tố `doc.`).
 * Tab Audit trên chi tiết phiếu tra bảng này. `rebuildAudit` (domain/audit) sao nguyên mã này sang
 * audit_log nên ADM-12 cũng dùng bảng này (qua AUDIT_ACTION_LABEL).
 */
export const DOC_HISTORY_ACTION_LABEL: Record<string, string> = {
  create: 'Tạo hồ sơ',
  update: 'Sửa hồ sơ',
  submit: 'Gửi duyệt',
  check: 'Kiểm tra',
  approve: 'Duyệt',
  approve_with_reason: 'Duyệt trước',
  reject: 'Từ chối',
  request_changes: 'Yêu cầu bổ sung',
  cancel: 'Hủy hồ sơ',
  pay: 'Thực thi',
  queue_payment: 'Đưa vào thanh toán',
  expire: 'Hết hiệu lực',
  opinion: 'Ghi ý kiến',
  tags_update: 'Sửa tag',
  partner_update: 'Đổi đối tác',
  tag_merge: 'Gộp tag',
  attachment_add: 'Thêm chứng từ',
  attachment_remove: 'Xoá chứng từ',
  delete: 'Xoá phiếu',
  auto_create: 'Tự động tạo',
  rerun: 'Chạy lại chuỗi duyệt',
  rollover_result: 'Kết quả đảo hạn',
  recurring_materialize: 'Sinh từ khoản chi định kỳ',
  migrate_v2: 'Chuyển dữ liệu từ v1',
};

/**
 * hành động audit → tiếng Việt (ADM-12, tab Audit). Gồm: mã lịch sử hồ sơ (sao sang audit_log),
 * mã cũ tiền tố `doc.`, và mã API ghi trực tiếp qua `mirrorAudit` (domain/audit) theo đối tượng.
 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  ...DOC_HISTORY_ACTION_LABEL,
  // xác thực & phiên
  'auth.login': 'Đăng nhập',
  'auth.logout': 'Đăng xuất',
  'auth.login_2fa': 'Đăng nhập 2 lớp',
  'auth.2fa_enable': 'Bật xác thực 2 lớp',
  'auth.step_up': 'Xác thực lại (step-up)',
  'auth.password_reset': 'Đặt lại mật khẩu',
  'auth.password_reset_by_admin': 'Đặt lại mật khẩu qua link quản trị',
  'session.revoke': 'Thu hồi phiên đăng nhập',
  // hồ sơ: mã cũ (tiền tố doc.) và mã hiện hành (tiền tố document.)
  'doc.create': 'Tạo hồ sơ',
  'doc.update': 'Sửa hồ sơ',
  'doc.submit': 'Gửi duyệt',
  'doc.approve': 'Duyệt',
  'doc.reject': 'Từ chối',
  'doc.request_changes': 'Yêu cầu bổ sung',
  'doc.fast_track': 'Duyệt trước',
  'doc.pay': 'Thực thi (ghi nhận dòng tiền)',
  'doc.cancel': 'Hủy hồ sơ',
  'doc.delete': 'Xoá phiếu thu/chi',
  'doc.override': 'Bước nhảy cấp',
  'document.create': 'Tạo hồ sơ',
  'document.update': 'Sửa hồ sơ',
  'document.delete': 'Xoá phiếu thu/chi',
  'document.opinion': 'Ghi ý kiến',
  'document.auto_create': 'Tự động tạo phiếu',
  // mã cũ (v1: `counterparty` là đối tác, `auto_income` là phiếu thu tự động) còn trong audit_log
  'document.auto_income': 'Tự động tạo phiếu thu',
  'document.tags_update': 'Sửa tag phiếu',
  'document.partner_update': 'Đổi đối tác phiếu',
  'document.tag_merge': 'Gộp tag phiếu',
  'document.attachment_confirm': 'Thêm chứng từ',
  'document.attachment_remove': 'Xoá chứng từ',
  'attach.add': 'Thêm chứng từ',
  // đối tác, công nợ, liên kết nghiệp vụ
  'partner.create': 'Tạo đối tác',
  'partner.update': 'Sửa đối tác',
  'partner.delete': 'Xoá đối tác',
  'partner.settle': 'Trả nợ đối tác',
  'partner.copy': 'Sao chép đối tác',
  'partner.merge': 'Gộp đối tác',
  'partner.deactivate': 'Ngừng giao dịch đối tác',
  'partner.reactivate': 'Kích hoạt lại đối tác',
  'counterparty.create': 'Tạo đối tác',
  'counterparty.delete': 'Xoá đối tác',
  'debt.create': 'Tạo khoản công nợ',
  'debt.update': 'Sửa khoản công nợ',
  'debt.delete': 'Xoá khoản công nợ',
  'debt.link': 'Cấn trừ công nợ',
  'debt.unlink': 'Gỡ cấn trừ công nợ',
  'debt.attachment_confirm': 'Thêm chứng từ',
  'debt.attachment_remove': 'Xoá chứng từ',
  'link.create': 'Tạo liên kết nghiệp vụ',
  'link.remove': 'Gỡ liên kết nghiệp vụ',
  // khoản vay ngân hàng, đảo hạn, khoản chi định kỳ
  'bank_debt.create': 'Tạo khoản vay',
  'bank_debt.update': 'Sửa khoản vay',
  'bank_debt.delete': 'Xoá khoản vay',
  'bank_debt.import': 'Nhập khoản vay từ Excel',
  'bank_debt.cancel': 'Hủy khoản vay',
  'bank_debt.auto_create': 'Tự động tạo khoản vay',
  'bank_debt.rollover_result': 'Kết quả đảo hạn',
  'bank_debt.repay': 'Trả nợ khoản vay',
  'bank_debt.unrepay': 'Hủy trả nợ khoản vay',
  'bank_debt.disburse_link': 'Gắn giải ngân',
  'bank_debt.unlink': 'Gỡ liên kết khoản vay',
  'bank_debt.archive': 'Lưu trữ khoản vay',
  'bank_debt.activate': 'Kích hoạt khoản vay',
  'loan.attachment_confirm': 'Thêm chứng từ',
  'loan.attachment_remove': 'Xoá chứng từ',
  'rollover.result': 'Kết quả đảo hạn',
  'recurring.materialize': 'Sinh phiếu từ khoản chi định kỳ',
  revive: 'Phục hồi khoản vay',
  archive: 'Lưu trữ',
  // tài khoản, chuyển nội bộ, sao kê
  'bank_account.create': 'Tạo tài khoản ngân hàng',
  'bank_account.update': 'Sửa tài khoản ngân hàng',
  'bank_account.active': 'Mở lại tài khoản ngân hàng',
  'bank_account.frozen': 'Khoá tài khoản ngân hàng',
  'bank_account.closed': 'Đóng tài khoản ngân hàng',
  'bank.statement_import': 'Nhập sao kê ngân hàng',
  'internal_transfer.create': 'Tạo chuyển nội bộ',
  // tag
  'tag.create': 'Tạo tag',
  'tag.update': 'Sửa tag',
  'tag.merge': 'Gộp tag',
  'tag.hide': 'Ẩn tag',
  'tag.unhide': 'Hiện lại tag',
  // nhân sự, bộ phận, uỷ quyền
  'hr.invite': 'Mời nhân sự',
  'hr.invite_regenerate': 'Cấp lại link kích hoạt',
  'hr.invite_revoke': 'Thu hồi link kích hoạt',
  'hr.invite_resend': 'Gửi lại email mời',
  'hr.password_link_regenerate': 'Cấp lại link đổi mật khẩu',
  'hr.password_link_revoke': 'Thu hồi link đổi mật khẩu',
  'hr.activate': 'Kích hoạt tài khoản',
  'hr.deactivate': 'Ngừng hoạt động nhân sự',
  'hr.reactivate': 'Kích hoạt lại nhân sự',
  'hr.update': 'Cập nhật hồ sơ nhân sự',
  'hr.transfer': 'Chuyển nhân sự',
  'department.activate': 'Dùng lại bộ phận',
  'department.deactivate': 'Ngừng dùng bộ phận',
  'department.delete': 'Xoá bộ phận',
  'delegation.create': 'Tạo uỷ quyền',
  // ma trận, cấu hình, công ty
  'matrix.create': 'Tạo ma trận duyệt',
  'matrix.update': 'Đổi ma trận duyệt',
  'matrix.upsert': 'Đổi ma trận duyệt',
  'settings.update': 'Đổi cấu hình',
  'setting.update': 'Đổi cấu hình',
  'automation.update': 'Đổi cấu hình tự động',
  'alert_rule.upsert': 'Đổi quy tắc cảnh báo',
  'company.create': 'Tạo công ty',
  'company.update': 'Sửa công ty',
  // hệ thống & báo cáo
  'report.export': 'Xuất báo cáo',
  'db.backup': 'Sao lưu dữ liệu',
  'db.archive': 'Lưu trữ dữ liệu',
  auto_sync: 'Đồng bộ tự động',
};

/** Nhãn một dòng Audit log (ADM-12): mã audit, rồi mã có tiền tố `doc.`; mã lạ giữ nguyên (không để trống). */
export function auditActionLabel(action: string): string {
  return AUDIT_ACTION_LABEL[action] ?? AUDIT_ACTION_LABEL[`doc.${action}`] ?? action;
}

/** Nhãn hành động của một dòng lịch sử hồ sơ; mã lạ giữ nguyên (không để trống). */
export function documentHistoryActionLabel(action: string): string {
  return DOC_HISTORY_ACTION_LABEL[action] ?? AUDIT_ACTION_LABEL[`doc.${action}`] ?? AUDIT_ACTION_LABEL[action] ?? action;
}

/**
 * Hành động trong LỊCH SỬ KHOẢN VAY NGÂN HÀNG (`bank_debts.history[].action`, card "Lịch sử thay đổi").
 * Cùng mã `create` / `update` với lịch sử hồ sơ nhưng nói về khoản vay nên dùng bảng riêng.
 */
export const LOAN_HISTORY_ACTION_LABEL: Record<string, string> = {
  create: 'Tạo khoản vay',
  update: 'Sửa khoản vay',
  activate: 'Kích hoạt khoản vay',
  cancel: 'Hủy khoản vay',
  revive: 'Phục hồi khoản vay',
  archive: 'Lưu trữ khoản vay',
  auto_create: 'Tự động tạo khoản vay',
  auto_sync: 'Đồng bộ tự động từ phiếu',
  rollover_result: 'Kết quả đảo hạn',
  repay_link: 'Liên kết trả nợ',
  attachment_add: 'Thêm chứng từ',
  attachment_remove: 'Xoá chứng từ',
  migrate_v2: 'Chuyển dữ liệu từ v1',
  'partner.merge': 'Gộp đối tác',
};

/** Hành động trong LỊCH SỬ KHOẢN CÔNG NỢ (`debt_vouchers.history[].action`, card "Lịch sử thay đổi"). */
export const DEBT_HISTORY_ACTION_LABEL: Record<string, string> = {
  create: 'Tạo khoản công nợ',
  update: 'Sửa khoản công nợ',
  'partner.merge': 'Gộp đối tác',
  cancel: 'Hủy khoản công nợ',
  attachment_add: 'Thêm chứng từ',
  attachment_remove: 'Xoá chứng từ',
  migrate_v2: 'Chuyển dữ liệu từ v1',
  // mã v1 (gán / gỡ phiếu cấn trừ, lưu ở document_links): dữ liệu cũ còn mã này; v2 chỉ ghi audit debt.link / debt.unlink
  link_document: 'Cấn trừ phiếu',
  unlink_document: 'Gỡ cấn trừ phiếu',
};

/** Nhãn một dòng lịch sử khoản vay ngân hàng; mã lạ giữ nguyên (không để trống). */
export function loanHistoryActionLabel(action: string): string {
  return LOAN_HISTORY_ACTION_LABEL[action] ?? action;
}

/** Nhãn một dòng lịch sử khoản công nợ; mã lạ giữ nguyên (không để trống). */
export function debtHistoryActionLabel(action: string): string {
  return DEBT_HISTORY_ACTION_LABEL[action] ?? action;
}

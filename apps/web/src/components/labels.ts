/**
 * FinGate web — nhãn vai trò / hành động / chứng từ (đồng bộ registry shared).
 */

import { ACTION_LABEL, EVIDENCE_LABEL, type Action, type EvidenceType } from '@fingate/shared';

export const ROLES_LABEL: Record<string, string> = {
  staff: 'Nhân viên kế toán',
  accountant: 'Chuyên viên kế toán',
  chief_accountant: 'Kế toán trưởng',
  deputy_director: 'Phó Giám đốc',
  director: 'Giám đốc / Tổng Giám đốc',
  chairman: 'Chủ tịch HĐQT',
  admin: 'Quản trị',
};

export const actionLabel = (a: string): string => ACTION_LABEL[a as Action] ?? a;
export const evidenceLabel = (t: string): string => EVIDENCE_LABEL[t as EvidenceType] ?? t;

/** hành động audit → tiếng Việt (ADM-12, tab Audit). */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'auth.login': 'Đăng nhập',
  'auth.logout': 'Đăng xuất',
  'auth.login_2fa': 'Đăng nhập 2 lớp',
  'auth.step_up': 'Xác thực lại (step-up)',
  'doc.create': 'Tạo hồ sơ',
  'doc.update': 'Sửa hồ sơ',
  'doc.submit': 'Gửi duyệt',
  'doc.approve': 'Duyệt',
  'doc.reject': 'Từ chối',
  'doc.request_changes': 'Yêu cầu bổ sung',
  'doc.fast_track': 'Duyệt trước',
  'doc.pay': 'Ghi nhận thanh toán',
  'doc.cancel': 'Hủy hồ sơ',
  'doc.override': 'Bước nhảy cấp',
  'attach.add': 'Thêm chứng từ',
  'balance.entry': 'Nhập số dư',
  'report.export': 'Xuất báo cáo',
  'hr.invite': 'Mời nhân sự',
  'hr.deactivate': 'Ngừng hoạt động nhân sự',
  'hr.transfer': 'Chuyển nhân sự',
  'matrix.upsert': 'Đổi ma trận duyệt',
  'settings.update': 'Đổi cấu hình',
};

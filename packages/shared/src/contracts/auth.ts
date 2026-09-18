/**
 * FinGate — hợp đồng phiên & nhân sự (architecture §7.2, blueprint §XXIX)
 *
 * Không có self-signup (K-18). Mọi user do người có quyền mời → `/kich-hoat`.
 */

import { z } from 'zod';
import { businessDate, idString, objectId, uuid } from './common.js';
import { PERMISSIONS } from '../permissions/index.js';

export const email = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .email('Email không hợp lệ');
// Server chuẩn hoá về chữ thường khi ghi & khi dò (FE không lower-case giùm).

/** Mật khẩu tối thiểu 12 ký tự, không chính sách "đặc ký bắt buộc" vô nghĩa. */
export const password = z.string().min(12, 'Mật khẩu tối thiểu 12 ký tự').max(200);

export const loginBody = z.object({
  email,
  password,
  /**
   * Mặc định `true` = tuỳ chọn "ghi nhớ đăng nhập". Phiên như vậy không bị giới hạn
   * bởi idle 15' / absolute 8h (§7.2); nó hết hạn sau `SESSION_REMEMBER_DAYS`
   * (mặc định 400 ngày — trần Max-Age của trình duyệt), hoặc bị thu hồi sớm hơn
   * bởi logout / đổi mật khẩu / admin thu hồi phiên.
   */
  remember: z.boolean().default(true),
  /** chống CSRF: FE gửi origin đã biết. */
  device_hint: z.string().max(40).optional(),
});

/**Bước 2 của đăng nhập với TOTP. */
export const twoFactorBody = z.object({
  /** challenge token trả về ở bước 1 (chưa phải session). */
  challenge: z.string().min(16).max(200),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$|^[A-Za-z0-9-]{10,16}$/, 'Mã gồm 6 chữ số hoặc recovery code'),
});

export const changePasswordBody = z.object({
  current_password: password,
  new_password: password,
  request_id: uuid,
});

export const forgotPasswordBody = z.object({ email });

export const resetPasswordBody = z.object({
  token: z.string().min(10).max(200),
  new_password: password,
});

export const activateBody = z.object({
  /** token ký trong link mời. */
  token: z.string().min(10).max(600),
  password,
  display_name: z.string().min(2).max(120),
});

export const totpEnableResult = z.object({
  secret: z.string().describe('Chỉ trả về MỘT LẦN khi đang setup'),
  otpauth_url: z.string(),
  qr_data_url: z.string().optional(),
  recovery_codes: z.array(z.string()).optional().describe('Chỉ trả về một lần'),
});

/** hồ sơ người dùng hiện tại cho `/me`. */
export const meProfile = z.object({
  user_id: objectId,
  email: z.string(),
  display_name: z.string(),
  status: z.enum(['invited', 'active', 'deactivated']),
  totp_enabled: z.boolean(),
  mfa_required: z.boolean(),
  last_login_at: z.string().nullable(),
  /** assignment theo công ty — vai trò hiện đang dùng. */
  assignments: z.array(
    z.object({
      company_id: objectId,
      company_name: z.string(),
      company_code: z.string(),
      department_id: objectId.nullable(),
      department_name: z.string().nullable(),
      role: idString,
      role_label: z.string(),
      amount_limit_minor: z.string(),
      scope_all: z.boolean(),
    }),
  ),
  scope: z.object({
    /** id các công ty được thấy; `all` = toàn tập đoàn. */
    company_ids: z.array(objectId),
    all: z.boolean(),
    active_company_id: objectId.nullable(),
  }),
  entitlements: z.record(z.string(), z.unknown()),
  prefs: z.object({
    theme: z.enum(['light', 'dark', 'system']).default('light'),
    density: z.enum(['comfortable', 'compact']).default('comfortable'),
    default_scope: z.string().default('all'),
    auto_open_next: z.boolean().default(false),
    shortcuts: z.record(z.string(), z.string()).default({}),
    notify_channels: z.array(z.enum(['web', 'email'])).default(['web']),
    quiet_hours: z.boolean().default(true),
  }),
});

/* ------------------------------------------------------------------ *
 * Nhân sự & tài khoản (blueprint §XXIX)
 * ------------------------------------------------------------------ */

export const personnelInviteBody = z
  .object({
    email,
    company_id: objectId.optional().describe('Giám đốc công ty con: server ghim vào công ty mình'),
    role: idString,
    department_id: objectId.nullable().optional(),
    amount_limit_minor: z.string().regex(/^\d+$/).optional(),
    note: z.string().max(500).optional(),
    /** số ngày link có hiệu lực — mặc định 1 ngày (admin tự copy link gửi, không qua mail). */
    valid_days: z.number().int().min(1).max(30).default(1),
    /** true = gửi email kèm (SMTP cấu hình); mặc định false: admin copy link ký sẵn gửi tay. */
    send_email: z.boolean().default(false),
    request_id: uuid,
  })
  .superRefine((v, ctx) => {
    if (!v.company_id) {
      ctx.addIssue({ code: 'custom', path: ['company_id'], message: 'Phải chọn công ty trực thuộc' });
    }
  });

/**
 * Kết quả cấp lại link mời — ADM-01. Token tự chứa chữ ký HMAC nên server
 * ký lại được từ (user, seed, expires_at) — link trả về LUÔN giống bản đã gửi
 * chừng nào chưa regenerate/revoke. `status`:
 *   active = còn hiệu lực · expired = hết hạn · revoked = admin thu hồi
 *   used   = tài khoản đã kích hoạt · none = chưa có link
 */
export const inviteLinkResult = z.object({
  user_id: objectId,
  email: z.string(),
  /**
   * mục đích link: `activate` = kích hoạt lần đầu · `reset` = quản trị cấp cho
   * tài khoản đã hoạt động để đặt lại mật khẩu · null = chưa/không còn link.
   */
  mode: z.enum(['activate', 'reset']).nullable().default(null),
  /** link tuyệt đối {PUBLIC_URL}/kich-hoat?token=… — null khi used/revoked/none. */
  invite_url: z.string().nullable(),
  status: z.enum(['active', 'expired', 'revoked', 'used', 'none']),
  expires_at: z.string().nullable(),
  invited_at: z.string().nullable(),
  regenerate_count: z.number().int().default(0),
  send_count: z.number().int().default(0),
});

/** body regenerate / đổi hạn link. */
export const inviteRegenerateBody = z
  .object({
    valid_days: z.number().int().min(1).max(30).default(1),
    /** true = gửi email kèm link mới (khi có SMTP). */
    send_email: z.boolean().default(false),
    request_id: uuid,
  })
  .passthrough();

/** Thông tin lời mời hiển thị trên màn kích hoạt (public — đọc từ link đã ký). */
export const inviteInfoResult = z.object({
  /** activate = kích hoạt lần đầu · reset = đặt lại mật khẩu cho tài khoản đã hoạt động. */
  mode: z.enum(['activate', 'reset']).default('activate'),
  email: z.string(),
  display_name: z.string().nullable(),
  company_name: z.string(),
  role: idString,
  role_label: z.string(),
  department_name: z.string().nullable(),
  invited_by_name: z.string().nullable(),
  expires_at: z.string(),
  /** vai trò bắt buộc 2FA → màn kích hoạt sẽ có bước quét QR + nhập OTP. */
  mfa_required: z.boolean(),
});

/** kết quả /activate — một bước: đặt mật khẩu là vào hệ thống. */
export const activateResult = z.object({
  ok: z.boolean(),
  user_id: z.string(),
  /** vai trò nằm trong nhóm bắt buộc 2FA → FE nhắc bật trong Cài đặt sau khi đăng nhập. */
  mfa_suggested: z.boolean().default(false),
});

export const personnelListQuery = z.object({
  company_id: objectId.optional(),
  status: z.enum(['invited', 'active', 'deactivated']).optional(),
  role: idString.optional(),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  page: z.coerce.number().int().min(1).default(1),
  sort: z.string().max(40).optional(),
});

export const personnelRow = z.object({
  user_id: objectId,
  display_name: z.string(),
  /** email đầy đủ (không còn che). */
  email: z.string(),
  email_masked: z.boolean().default(false),
  company_id: objectId,
  company_name: z.string(),
  department_id: objectId.nullable().default(null),
  department_name: z.string().nullable(),
  role: idString,
  role_label: z.string(),
  status: z.enum(['invited', 'active', 'deactivated']),
  amount_limit_minor: z.string(),
  mfa_enabled: z.boolean(),
  last_login_at: z.string().nullable(),
  invited_at: z.string().nullable(),
  /** trạng thái link mời hiện tại (chỉ có nghĩa với tài khoản `invited`). */
  invite_status: z.enum(['active', 'expired', 'revoked', 'none']).default('none'),
  invite_expires_at: z.string().nullable(),
  invite_regenerate_count: z.number().int().default(0),
  started_at: businessDate.nullable(),
  /** số hồ sơ người này đang giữ ở bước current — quyết định có phải chỉ định người thay (§XXIX.4). */
  holding_docs: z.number().int().default(0),
  /** quyền cấp thêm ngoài vai trò (bảng tick phân quyền ADM-01). */
  extra_permissions: z.array(z.enum(PERMISSIONS)).default([]),
  /** quyền thu hồi so với vai trò (bảng tick phân quyền ADM-01). */
  denied_permissions: z.array(z.enum(PERMISSIONS)).default([]),
});

export const personnelDeactivateBody = z.object({
  /** người được chỉ định tiếp nhận các hồ sơ đang giữ. */
  replacement_user_id: objectId.optional(),
  reason: z.string().min(5).max(500),
  request_id: uuid,
});

/**
 * ADM-01 — sửa hồ sơ tài khoản đã có (không đổi email — email là danh tính đăng nhập).
 * Chỉ gửi trường muốn đổi; `company_id` khác công ty hiện tại đòi quyền `hr:transfer`.
 */
export const personnelUpdateBody = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  company_id: objectId.optional(),
  role: idString.optional(),
  department_id: objectId.nullable().optional(),
  amount_limit_minor: z.string().regex(/^\d+$/).optional(),
  /** quyền cấp thêm / thu hồi so với vai trò — bảng tick phân quyền (ADM-01). */
  extra_permissions: z.array(z.enum(PERMISSIONS)).optional(),
  denied_permissions: z.array(z.enum(PERMISSIONS)).optional(),
  /** lý do sửa (audit) — tùy chọn. */
  reason: z.string().min(5).max(500).optional(),
  request_id: uuid,
});

export const personnelTransferBody = z.object({
  to_company_id: objectId,
  role: idString.optional(),
  department_id: objectId.nullable().optional(),
  effective_from: businessDate,
  replacement_user_id: objectId.optional(),
  reason: z.string().min(5).max(500),
  request_id: uuid,
});

export const delegationBody = z.object({
  to_user_id: objectId,
  role: idString.optional().describe('Bỏ trống = ủy quyền mọi vai trò duyệt hiện có'),
  valid_from: businessDate,
  valid_to: businessDate,
  reason: z.string().min(5).max(500),
  request_id: uuid,
});

export const delegationRow = z.object({
  _id: objectId,
  from_user_id: objectId,
  from_name: z.string(),
  to_user_id: objectId,
  to_name: z.string(),
  role: idString.nullable(),
  valid_from: businessDate,
  valid_to: businessDate,
  reason: z.string(),
  status: z.enum(['active', 'scheduled', 'expired', 'revoked']),
});

/** Công ty —ADM-06. */
export const companyUpsertBody = z.object({
  name: z.string().min(2).max(200),
  code: z
    .string()
    .min(1)
    .max(12)
    .regex(/^[A-Z0-9_.-]+$/, 'Mã công ty viết hoa, không dấu cách'),
  tax_code: z.string().max(20).optional(),
  address: z.string().max(300).optional(),
  contact_email: email.optional(),
  /** true = pháp nhân cấp Tập đoàn (nhóm), không phải công ty con (ADM-06). */
  is_group: z.boolean().default(false),
  min_balance_minor: z.string().regex(/^\d+$/).default('0').describe('Ngưỡng tiền tối thiểu — dưới ngưỡng là cảnh báo đỏ'),
  working_calendar: z
    .object({
      workdays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
      holidays: z.array(businessDate).default([]),
    })
    .default({ workdays: [1, 2, 3, 4, 5], holidays: [] }),
  status: z.enum(['active', 'suspended']).default('active'),
});

export const departmentUpsertBody = z.object({
  company_id: objectId,
  name: z.string().min(2).max(120),
  code: z.string().max(20).optional(),
  parent_id: objectId.nullable().optional(),
});

/** PREF-01. */
export const prefsUpdateBody = z.object({
  theme: z.enum(['light', 'dark', 'system']).optional(),
  density: z.enum(['comfortable', 'compact']).optional(),
  default_scope: z.string().max(64).optional(),
  auto_open_next: z.boolean().optional(),
  shortcuts: z.record(z.string(), z.string()).optional(),
  notify_channels: z.array(z.enum(['web', 'email'])).optional(),
  quiet_hours: z.boolean().optional(),
});

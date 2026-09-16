/**
 * FinGate — hợp đồng phiên & nhân sự (architecture §7.2, blueprint §XXIX)
 *
 * Không có self-signup (K-18). Mọi user do người có quyền mời → `/kich-hoat`.
 */

import { z } from 'zod';
import { businessDate, idString, objectId, uuid } from './common.js';

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
  token: z.string().min(10).max(200),
  password,
  display_name: z.string().min(2).max(120),
  /** người dùng xác nhận đã bật 2FA — server verify code trước khi active. */
  totp_code: z.string().regex(/^\d{6}$/).optional(),
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
    /** số ngày link có hiệu lực, mặc định 7 (blueprint §XXIX.2). */
    valid_days: z.number().int().min(1).max(30).default(7),
    request_id: uuid,
  })
  .superRefine((v, ctx) => {
    if (!v.company_id) {
      ctx.addIssue({ code: 'custom', path: ['company_id'], message: 'Phải chọn công ty trực thuộc' });
    }
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
  /** email bị mask khi người gọi không có quyền hr:* (blueprint §XXVI). */
  email: z.string(),
  email_masked: z.boolean().default(false),
  company_id: objectId,
  company_name: z.string(),
  department_name: z.string().nullable(),
  role: idString,
  role_label: z.string(),
  status: z.enum(['invited', 'active', 'deactivated']),
  amount_limit_minor: z.string(),
  mfa_enabled: z.boolean(),
  last_login_at: z.string().nullable(),
  invited_at: z.string().nullable(),
  started_at: businessDate.nullable(),
  /** số hồ sơ người này đang giữ ở bước current — quyết định có phải chỉ định người thay (§XXIX.4). */
  holding_docs: z.number().int().default(0),
});

export const personnelDeactivateBody = z.object({
  /** người được chỉ định tiếp nhận các hồ sơ đang giữ. */
  replacement_user_id: objectId.optional(),
  reason: z.string().min(5).max(500),
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

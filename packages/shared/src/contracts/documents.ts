/**
 * FinGate — hợp đồng hồ sơ thu/chi/đảo hạn/chuyển nội bộ (architecture §8.2, blueprint §XXX)
 */

import { z } from 'zod';
import { DOC_KINDS, ROLES } from '../status/index.js';
import { actionEnum, businessDate, businessDateTime, docKind, docVersion, evidenceType, moneyField, moneyWire, objectId, roleEnum, statusKey, uuid } from './common.js';

export const priority = z.enum(['low', 'normal', 'high', 'urgent']);
export type Priority = z.infer<typeof priority>;

export const fundKind = z.enum(['bank', 'cash']);

/** Nhóm trường "Nguồn và đích tiền" (blueprint §XXX.1). */
export const sourceField = z.object({
  fund: fundKind,
  account_id: objectId.nullable().optional(),
  group_account_id: objectId.nullable().optional().describe('Tài khoản tập đoàn phụ trách — bắt buộc nếu group_managed (blueprint §VIII)'),
  group_managed: z.boolean().default(false),
});

export const payeeField = z.object({
  name: z.string().min(1).max(200),
  tax_code: z.string().max(20).nullable().optional(),
  counterparty_id: objectId.nullable().optional(),
  is_internal: z.boolean().default(false),
  /** Nhận tiền qua tài khoản nào (mục V). */
  bank_name: z.string().max(120).optional(),
  bank_account: z.string().max(40).optional(),
});

export const contractField = z.object({
  code: z.string().max(80).optional(),
  value: moneyField.optional(),
  signed_at: businessDate.optional(),
});

export const budgetField = z.object({
  budget_id: objectId.nullable().optional(),
  line_id: objectId.nullable().optional(),
  in_plan: z.boolean().default(true),
});

/** Phần tử attachment — bản nhúng trong documents.attachments[] là nguồn sự thật (§8.2). */
export const attachmentRef = z.object({
  id: objectId,
  type: evidenceType,
  version: z.number().int().min(1),
  key: z.string(),
  sha256: z.string().length(64),
  size: z.number().int().nonnegative(),
  mime: z.string(),
  filename: z.string(),
  added_at: z.string(),
  added_by: objectId,
  referenced_by: z.array(objectId).default([]),
});

/** §V — thông tin chung của phiếu chi; các loại phiếu khác dùng chung phần lớn trường. */
const documentFields = z.object({
    kind: docKind,
    company_id: objectId.optional().describe('Mặc định theo phiên làm việc'),
    department_id: objectId.nullable().optional(),
    title: z.string().min(3).max(200),
    purpose: z.string().min(3).max(2000).describe('Nội dung chi / thu — câu hỏi 3 của 7'),
    category_id: objectId.nullable().optional(),
    payee: payeeField,
    amount: moneyField,
    fx: z
      .object({
        rate: z.string().regex(/^\d+(\.\d{1,6})?$/, 'Tỷ giá dạng số'),
        at: businessDate,
      })
      .nullable()
      .optional(),
    source: sourceField,
    planned_date: businessDateTime,
    business_date: businessDate.optional(),
    priority: priority.default('normal'),
    contract: contractField.default({}),
    loan_id: objectId.nullable().optional(),
    budget: budgetField.default({ in_plan: true }),
    note: z.string().max(2000).optional(),
    /** chuyển tiền nội bộ: công ty/TK nhận (blueprint §XXI). */
    target: z
      .object({
        company_id: objectId,
        account_id: objectId.nullable().optional(),
      })
      .nullable()
      .optional(),
    /** đảo hạn: phương án (blueprint §XI). */
    rollover: z
      .object({
        need_amount: moneyField,
        plan: z.string().min(3).max(2000),
        fee_estimate: moneyField.optional(),
        new_rate: z.string().max(20).optional(),
        collateral: z.string().max(1000).optional(),
        proposal: z.string().max(2000).optional(),
      })
      .nullable()
      .optional(),
    /** mã công nợ liên quan (§V). */
    debt_code: z.string().max(60).optional(),
    evidence_required: z
    .array(evidenceType)
    .optional()
    .describe('Bỏ trống → suy ra từ cấu hình danh mục (BA-3/Q-04)'),
});

export const documentCreateBody = documentFields.superRefine((v, ctx) => {
  if (v.source.group_managed && !v.source.group_account_id) {
    ctx.addIssue({
      code: 'custom',
      path: ['source', 'group_account_id'],
      message: 'Giao dịch qua tài khoản Tập đoàn — bắt buộc chọn tài khoản phụ trách',
    });
  }
  if (v.kind === 'internal' && !v.target) {
    ctx.addIssue({ code: 'custom', path: ['target'], message: 'Chuyển tiền nội bộ cần chỉ định công ty nhận' });
  }
  if (v.kind === 'rollover' && !v.rollover) {
    ctx.addIssue({ code: 'custom', path: ['rollover'], message: 'Phương án đảo hạn thiếu thông tin phương án' });
  }
  if (v.kind === 'internal' && v.target && v.company_id && v.target.company_id === v.company_id) {
    ctx.addIssue({ code: 'custom', path: ['target', 'company_id'], message: 'Công ty nguồn và nhận phải khác nhau' });
  }
});

export type DocumentCreateBody = z.infer<typeof documentCreateBody>;

/** PATCH — chỉ cho phép khi draft / changes_requested (workflow sẽ chặn). */
export const documentUpdateBody = documentFields
  .partial()
  .extend({ if_match: docVersion, request_id: uuid });

/** Lọc danh sách — URL là state của danh sách (architecture §5). */
export const documentListQuery = z.object({
  kind: docKind.optional(),
  status: z.union([statusKey, z.array(statusKey)]).optional(),
  company_id: objectId.optional(),
  scope: z.string().max(64).optional(),
  category_id: objectId.optional(),
  department_id: objectId.optional(),
  created_by: objectId.optional(),
  mine: z.enum(['created', 'to_approve', 'approved_by_me']).optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  amount_min: z.string().regex(/^\d+$/).optional(),
  amount_max: z.string().regex(/^\d+$/).optional(),
  overdue_only: z.enum(['true', 'false']).optional(),
  missing_evidence: z.enum(['true', 'false']).optional(),
  q: z.string().max(200).optional(),
  sort: z
    .string()
    .max(60)
    .default('-waiting')
    .describe('-waiting | -planned_date | -amount | -created_at | +created_at'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export type DocumentListQuery = z.infer<typeof documentListQuery>;

/** POST /documents/{id}/transition (architecture §9.1). */
export const transitionBody = z
  .object({
    action: actionEnum,
    opinion: z.string().max(2000).optional(),
    reason: z.string().max(2000).optional().describe('Bắt buộc với reject / request_changes / fast_track'),
    /** step-up verify: mật khẩu HOẶC OTP (ADR-14). */
    verify: z
      .object({
        method: z.enum(['password', 'otp']),
        value: z.string().min(1).max(200),
      })
      .optional(),
    /** gõ lại số tiền khi > ngưỡng hoặc ngoài ngân sách (DS §7.14 rule 4). */
    confirm_amount_minor: z.string().regex(/^\d+$/).optional(),
    /**
     * Cấp duyệt đổi tài khoản của phiếu ngay khi duyệt (blueprint §VIII/§XXX):
     * phiếu thu = tài khoản đích, phiếu chi = tài khoản nguồn. Chỉ được chọn tài
     * khoản trong phạm vi công ty của phiếu (kể cả tài khoản Tập đoàn).
     */
    source_account_id: objectId.optional(),
    if_match: docVersion,
    request_id: uuid,
    /** thanh toán: execution (§8.2). */
    execution: z
      .object({
        paid_at: businessDate,
        bank_ref: z.string().max(80).optional(),
        actual_amount_minor: z.string().regex(/^\d+$/).optional(),
        account_id: objectId.optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.action === 'reject' || v.action === 'request_changes') && !(v.reason && v.reason.trim().length >= 5)) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Bắt buộc nêu lý do' });
    }
    if (v.action === 'approve_with_reason' && !(v.reason && v.reason.trim().length >= 5)) {
      ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Duyệt trước cần nêu lý do' });
    }
  });

export type TransitionBody = z.infer<typeof transitionBody>;

/**
 * POST /documents/{id}/delete — xoá cứng phiếu thu/chi (ADM-01 phân quyền).
 * Cho phép: (a) kế toán xoá bản nháp do chính mình tạo; (b) KTT/kế toán xoá
 * phiếu đã bị Phó Giám đốc trả lại (từ chối / yêu cầu bổ sung).
 */
export const documentDeleteBody = z.object({
  reason: z.string().trim().min(5).max(500),
  /** step-up verify: mật khẩu HOẶC OTP (ADR-14). */
  verify: z
    .object({
      method: z.enum(['password', 'otp']),
      value: z.string().min(1).max(200),
    })
    .optional(),
  request_id: uuid,
});

export type DocumentDeleteBody = z.infer<typeof documentDeleteBody>;

export const opinionBody = z.object({
  body: z.string().min(1).max(2000),
  kind: z.enum(['advice', 'risk', 'discussion']).default('advice'),
  request_id: uuid,
});

/** approval.steps[] — snapshot từ Approval Matrix tại lúc submit (§9.1). */
export const approvalStep = z.object({
  order: z.number().int().min(1),
  role: roleEnum,
  user_id: objectId.nullable(),
  delegated_from: objectId.nullable().optional(),
  state: z.enum(['waiting', 'current', 'done', 'skipped', 'rejected']),
  action: z.string().nullable().optional(),
  decided_at: z.string().nullable().optional(),
  opinion: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  sla_deadline: z.string().nullable().optional(),
  amount_at_decision: z.string().nullable().optional(),
  fast_tracked: z.boolean().optional(),
});

/** Bản ghi audit nhúng trong document.history[] — chỉ thêm (§7.4). */
export const historyEntry = z.object({
  at: z.string(),
  actor: z.object({ user_id: objectId.nullable(), role: z.string().nullable().optional(), name: z.string().optional() }),
  action: z.string(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  amount_at_decision: z.string().nullable().optional(),
  opinion: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
  request_id: z.string().nullable().optional(),
  ip: z.string().nullable().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

export const decisionPack = z.object({
  document_id: objectId,
  code: z.string(),
  /** 7 câu hỏi kiểm soát — server tính, FE không có logic tiền (§9.2, §19.5-1). */
  q1_payee: z.object({ name: z.string(), tax_code: z.string().nullable(), is_internal: z.boolean(), bank: z.string().nullable() }),
  q2_amount: z.object({
    amount: moneyWire,
    amount_usd: moneyWire.nullable().optional(),
    fx_rate: z.string().nullable().optional(),
  }),
  q3_purpose: z.object({ text: z.string(), category: z.string().nullable(), department: z.string().nullable() }),
  q4_basis: z.object({ contract_code: z.string().nullable(), contract_value: moneyWire.nullable(), invoice: z.string().nullable() }),
  q5_source: z.object({
    fund: fundKind,
    account_label: z.string(),
    group_account_label: z.string().nullable(),
    group_managed: z.boolean(),
  }),
  q6_impact: z.object({
    available_now: moneyWire,
    balance_after: moneyWire,
    min_balance: moneyWire,
    breach: z.boolean(),
  }),
  q7_plan: z.object({
    in_plan: z.boolean(),
    budget_line: z.string().nullable(),
    used: moneyWire.nullable(),
    limit: moneyWire.nullable(),
    percent: z.number().nullable(),
    period: z.string().nullable(),
  }),
  evidence: z.object({ required: z.array(evidenceType), present: z.array(evidenceType), missing: z.array(evidenceType) }),
  matrix_label: z.string().describe('Ví dụ "Khoản > 5 tỷ — qua Chủ tịch HĐQT"'),
});

/** Đọc hồ sơ — chi tiết đầy đủ. */
export const documentDetail = z.object({
  _id: objectId,
  code: z.string(),
  kind: docKind,
  company_id: objectId,
  company_name: z.string().optional(),
  department_id: objectId.nullable(),
  department_name: z.string().nullable().optional(),
  created_by: objectId,
  created_by_name: z.string(),
  status: statusKey,
  overdue: z.boolean().default(false),
  waiting_days: z.number().int().min(0).default(0),
  current_owner: z
    .object({ role: z.enum(ROLES as unknown as [string, ...string[]]).nullable(), name: z.string().nullable() })
    .nullable()
    .optional(),
  version: docVersion,
  title: z.string(),
  purpose: z.string(),
  category_id: objectId.nullable(),
  category_name: z.string().nullable().optional(),
  payee: payeeField,
  amount: moneyWire,
  fx: z.object({ rate: z.string(), at: businessDate }).nullable(),
  source: sourceField.extend({ account_label: z.string().nullable(), balance_available: moneyWire.nullable() }),
  planned_date: businessDate,
  business_date: businessDate,
  priority,
  contract: contractField,
  loan_id: objectId.nullable(),
  budget: budgetField,
  target: z.object({ company_id: objectId, company_name: z.string().optional(), account_id: objectId.nullable() }).nullable(),
  rollover: z
    .object({
      need_amount: moneyWire,
      plan: z.string(),
      fee_estimate: moneyWire.nullable(),
      new_rate: z.string().nullable(),
      collateral: z.string().nullable(),
      proposal: z.string().nullable(),
      result: z
        .object({
          done_at: businessDate.nullable(),
          new_contract: z.string().nullable(),
          actual_fee: moneyWire.nullable(),
          note: z.string().nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  debt_code: z.string().nullable(),
  note: z.string().nullable(),
  approval: z.object({
    matrix_id: objectId.nullable(),
    matrix_version: z.number().int(),
    steps: z.array(approvalStep),
  }),
  evidence: z.object({ required: z.array(evidenceType), present: z.array(evidenceType), missing: z.array(evidenceType) }),
  attachments: z.array(attachmentRef),
  execution: z
    .object({
      paid_at: businessDate.nullable(),
      bank_ref: z.string().nullable(),
      executed_by: objectId.nullable(),
      actual_amount: moneyWire.nullable(),
    })
    .nullable(),
  override: z.object({ fast_tracked: z.boolean(), reason: z.string().nullable() }),
  history: z.array(historyEntry),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  archived_at: z.string().nullable(),
  /** quyền của người gọi trên hồ sơ này — server tính. */
  can: z.record(z.string(), z.boolean()),
});

/** Dòng trả về cho FgTable — projection, không chứa purpose/history/attachments (§8.7). */
export const documentRow = z.object({
  _id: objectId,
  code: z.string(),
  kind: docKind,
  company_id: objectId,
  company_name: z.string(),
  department_name: z.string().nullable().optional(),
  created_by_name: z.string(),
  title: z.string(),
  status: statusKey,
  overdue: z.boolean().default(false),
  waiting_days: z.number().int().default(0),
  current_owner: z.string().nullable().optional(),
  category_name: z.string().nullable().optional(),
  payee_name: z.string(),
  amount: moneyWire,
  planned_date: businessDate,
  version: docVersion,
  updated_at: z.string(),
  missing_evidence_count: z.number().int().default(0),
});

export type DocumentRow = z.infer<typeof documentRow>;

/* ------------------------------------------------------------------ *
 * Approval Matrix — "ma trận duyệt là dữ liệu", cấu hình được (§XX)
 * ------------------------------------------------------------------ */

export const matrixStep = z.object({
  order: z.number().int().min(1),
  role: roleEnum,
  sla_hours: z.number().int().min(1).max(24 * 30).default(24),
  mandatory: z.boolean().default(true),
});

const matrixFields = z.object({
  company_id: objectId.nullable().describe('null = áp dụng toàn tập đoàn'),
  doc_kind: docKind,
  category_id: objectId.nullable().optional(),
  amount_min_minor: z.string().regex(/^\d+$/).default('0'),
  amount_max_minor: z.string().regex(/^\d+$/).optional().describe('Bỏ trống = không chặn trên'),
  currency: z.string().length(3).default('VND'),
  steps: z.array(matrixStep).min(1).max(8),
  effective_from: businessDate,
});

export const matrixUpsertBody = matrixFields.superRefine((v, ctx) => {
  if (v.amount_max_minor && BigInt(v.amount_max_minor) <= BigInt(v.amount_min_minor)) {
    ctx.addIssue({ code: 'custom', path: ['amount_max_minor'], message: 'Ngưỡng trên phải lớn hơn ngưỡng dưới' });
  }
  const orders = v.steps.map((s) => s.order);
  if (new Set(orders).size !== orders.length) {
    ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Thứ tự bước bị trùng' });
  }
});

export type MatrixUpsertBody = z.infer<typeof matrixUpsertBody>;

export const matrixEntry = matrixFields.extend({
  _id: objectId,
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});

/* ------------------------------------------------------------------ *
 * Chứng từ: prepare / confirm (architecture §6, K-8)
 * ------------------------------------------------------------------ */

export const attachmentPrepareBody = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().min(1).max(25 * 1024 * 1024).describe('Tối đa 25 MB'),
  mime: z.string().max(120),
  sha256: z.string().length(64),
  type: evidenceType.default('other'),
  if_match: docVersion,
  request_id: uuid,
});

export const attachmentPrepareResult = z.object({
  upload_url: z.string(),
  key: z.string(),
  attachment_id: objectId,
  version: z.number().int(),
  method: z.literal('PUT'),
  required_headers: z.record(z.string(), z.string()),
  expires_in: z.number().int().default(300),
});

export const attachmentConfirmBody = z.object({
  attachment_id: objectId,
  if_match: docVersion,
  request_id: uuid,
});

/** POST /documents/{id}/attachments/{attachmentId}/remove — chỉ khi chưa bị tham chiếu (§7.9). */
export const attachmentRemoveBody = z.object({
  if_match: docVersion,
  request_id: uuid,
  reason: z.string().trim().max(500).optional(),
});

export const DOC_KIND_VALUES = DOC_KINDS;

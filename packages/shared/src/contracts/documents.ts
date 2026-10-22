/**
 * FinGate — hợp đồng hồ sơ thu/chi/đảo hạn/chuyển nội bộ (architecture §8.2, blueprint §XXX)
 */

import { z } from 'zod';
import { DOC_KINDS, ROLES } from '../status/index.js';
import { actionEnum, businessDate, businessDateTime, docKind, docVersion, evidenceType, minorNonNeg, moneyField, moneyWire, objectId, roleEnum, statusKey, uuid } from './common.js';
import { automationRuleCode, automationRunRow } from './automation.js';
import { partnerRef } from './partners.js';
import { linkObjectType, linkRow, linkSplit } from './links.js';

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

/* ------------------------------------------------------------------ *
 * v2 — đối tác, tag, tuỳ chọn vay, chuyển nội bộ, nguồn gốc (v2/v2.md §5.2, §6.2, §11.4–11.6)
 * ------------------------------------------------------------------ */

/** Thông tin khoản vay dự kiến gắn trên phiếu (R2 phiếu thu đi vay / R3 phiếu chi vay để chi). */
export const loanTerms = z.object({
  contract_no: z.string().max(80).nullable().optional().describe('Số HĐ tín dụng'),
  interest_rate: z.string().regex(/^\d+([.,]\d{1,4})?$/, 'Lãi suất dạng số').nullable().optional(),
  term_months: z.coerce.number().int().min(1).max(600).nullable().optional().describe('Kỳ hạn (tháng) — mặc định 12'),
  due_date: businessDate.nullable().optional().describe('Hạn thanh toán — mặc định giải ngân + 11 tháng'),
  repayment_period: z.enum(['monthly', 'quarterly', 'semiannual', 'maturity']).nullable().optional(),
  repayment_method: z.enum(['interest_only', 'equal_principal']).nullable().optional(),
  collateral: z.string().max(1000).nullable().optional().describe('Tài sản bảo đảm'),
});
export type LoanTerms = z.infer<typeof loanTerms>;

/**
 * `options.loan` — cờ "đi vay" (kind `borrow`, phiếu thu) hoặc "vay để chi" (kind `fund`, phiếu chi).
 * `mode`: `new` tạo khoản vay mới · `existing` gắn khoản có sẵn · `later` gán sau.
 */
export const loanOptions = z
  .object({
    kind: z.enum(['borrow', 'fund']),
    mode: z.enum(['new', 'existing', 'later']).default('later'),
    lender_partner_id: objectId.nullable().optional().describe('Ngân hàng cho vay — loại Ngân hàng'),
    receive_account_id: objectId.nullable().optional().describe('TK tiền loại ngân hàng nhận giải ngân'),
    amount_minor: minorNonNeg.nullable().optional().describe('Số tiền vay — mặc định = số tiền phiếu'),
    existing_loan_id: objectId.nullable().optional(),
    terms: loanTerms.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.mode !== 'later' && !v.lender_partner_id) {
      ctx.addIssue({ code: 'custom', path: ['lender_partner_id'], message: 'Chọn ngân hàng cho vay' });
    }
    if (v.kind === 'fund' && !v.receive_account_id) {
      ctx.addIssue({ code: 'custom', path: ['receive_account_id'], message: 'Chọn tài khoản nhận giải ngân của công ty' });
    }
    if (v.mode === 'existing' && !v.existing_loan_id) {
      ctx.addIssue({ code: 'custom', path: ['existing_loan_id'], message: 'Chọn khoản vay đã có' });
    }
  });
export type LoanOptions = z.infer<typeof loanOptions>;

/** Chuyển tiền nội bộ: công ty / tài khoản đích theo ID (v2 §11.6 — không nhận diện theo chuỗi). Dạng ĐỌC (dữ liệu cũ có thể thiếu TK). */
export const transferTarget = z.object({
  company_id: objectId,
  account_id: objectId.nullable().optional(),
});
export type TransferTarget = z.infer<typeof transferTarget>;

/**
 * Chuyển tiền nội bộ — dạng GHI (tạo / sửa phiếu): phải chọn cả công ty VÀ tài khoản đích (v2 §11.6). R1 ghi phiếu thu
 * vào đúng TK này sau khi phiếu chi thực thi, nên thiếu TK phải chặn ngay khi lưu (lúc đó tiền đã ra khỏi công ty nguồn).
 */
export const transferTargetInput = transferTarget.extend({
  account_id: z.string({ error: 'Chọn tài khoản nhận của công ty đích' }).regex(/^[0-9a-f]{24}$/, 'Chọn tài khoản nhận của công ty đích'),
});

/** Nguồn gốc hồ sơ: thủ công, hoặc tự động (lượt chạy + quy tắc đã sinh ra). Server ghi, không nhận từ client. */
export const documentOrigin = z.object({
  kind: z.enum(['manual', 'automation']),
  run_id: objectId.nullable().optional(),
  rule_code: automationRuleCode.nullable().optional(),
});
export type DocumentOrigin = z.infer<typeof documentOrigin>;

/**
 * Liên kết của phiếu (đọc): `direction` cho biết phiếu là đầu nguồn (`out`) hay đầu đích (`in`);
 * `counterpart` là đối tượng bên kia. Ngoài phạm vi công ty của người xem ⇒ `visible: false`, không lộ mã/số tiền.
 */
export const documentLinkItem = linkRow.extend({
  direction: z.enum(['out', 'in']),
  counterpart: z.object({
    type: linkObjectType,
    id: objectId,
    code: z.string().nullable(),
    status: z.string().nullable(),
    total_minor: minorNonNeg.nullable(),
    partner_id: objectId.nullable(),
    partner_name: z.string().nullable(),
    visible: z.boolean(),
  }),
});
export type DocumentLinkItem = z.infer<typeof documentLinkItem>;

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
    /** [v2] KHÔNG còn ghi — đối tác lấy qua `partner_id`; giữ tuỳ chọn để client v1 không vỡ (bị bỏ qua). */
    payee: payeeField.optional(),
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
        /** v2 §7.3/§10.3: ngày đáo hạn mới đề xuất (YYYY-MM-DD). */
        new_maturity_date: businessDate,
        fee_estimate: moneyField.optional(),
        new_rate: z.string().max(20).optional(),
        collateral: z.string().max(1000).optional(),
        proposal: z.string().max(2000).optional(),
      })
      .nullable()
      .optional(),
    /** mã công nợ liên quan (§V). */
    debt_code: z.string().max(60).optional(),
    /** ★ v2 [MỚI]: đối tác theo ID (bắt buộc từ bước migrate M2; tạm tuỳ chọn để không vỡ v1). */
    partner_id: objectId.nullable().optional().describe('Đối tác (danh bạ công ty) — v2'),
    /** ★ v2 [MỚI]: tag gắn phiếu (tối đa 50). */
    tag_ids: z.array(objectId).max(50).optional(),
    /** ★ v2 [MỚI]: tuỳ chọn tự động — `options.loan`. */
    options: z.object({ loan: loanOptions.nullable().optional() }).nullable().optional(),
    /** ★ v2 [MỚI]: chuyển tiền nội bộ theo ID — thay dần `target` (v1). */
    transfer_target: transferTargetInput.nullable().optional(),
    evidence_required: z
    .array(evidenceType)
    .optional()
    .describe('Bỏ trống → suy ra từ cấu hình danh mục (BA-3/Q-04)'),
});

export const documentCreateBody = documentFields.superRefine((v, ctx) => {
  // [v2] đối tác là trường bắt buộc của phiếu thu/chi (chọn theo ID, không nhập tự do).
  if ((v.kind === 'spend' || v.kind === 'income') && !v.partner_id) {
    ctx.addIssue({ code: 'custom', path: ['partner_id'], message: 'Chọn đối tác (bắt buộc với phiếu thu/chi)' });
  }
  if (v.source.group_managed && !v.source.group_account_id) {
    ctx.addIssue({
      code: 'custom',
      path: ['source', 'group_account_id'],
      message: 'Giao dịch qua tài khoản Tập đoàn — bắt buộc chọn tài khoản phụ trách',
    });
  }
  if (v.kind === 'internal' && !v.target && !v.transfer_target) {
    ctx.addIssue({ code: 'custom', path: ['transfer_target'], message: 'Chuyển tiền nội bộ cần chỉ định công ty nhận' });
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
  q: z.string().max(200).optional().describe('Tìm theo mã, tiêu đề, tên đối tác (và STK/MST), tên tag'),
  /** [v2] lọc theo đối tác (ID). */
  partner_id: objectId.optional(),
  /** [v2] lọc theo tag: phiếu có ÍT NHẤT MỘT trong các tag — tách bằng dấu phẩy hoặc lặp tham số `tag_ids`. */
  tag_ids: z.union([z.string().max(1000), z.array(z.string().max(64)).max(50)]).optional(),
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
     * Cấp duyệt đổi số tiền của phiếu chi ngay khi duyệt. Tăng so với đề nghị ban
     * đầu phải xác nhận lại (`confirm_amount_minor` = đúng số tiền mới).
     */
    amount_minor: z.string().regex(/^\d+$/).optional(),
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
    balance_before: moneyWire,
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
      new_maturity_date: businessDate.nullable().optional(),
      fee_estimate: moneyWire.nullable(),
      new_rate: z.string().nullable(),
      collateral: z.string().nullable(),
      proposal: z.string().nullable(),
      result: z
        .object({
          done_at: businessDate.nullable(),
          new_contract_code: z.string().nullable(),
          new_maturity_date: businessDate.nullable().optional(),
          new_limit: moneyWire.nullable(),
          new_rate: z.string().nullable(),
          actual_fee: moneyWire.nullable(),
          note: z.string().nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
  debt_code: z.string().nullable(),
  /** ★ v2: đối tác (chỉ đọc qua ID) + tham chiếu gọn để hiển thị. */
  partner_id: objectId.nullable().optional(),
  partner: partnerRef.nullable().optional(),
  /** ★ v2: tag gắn phiếu. */
  tag_ids: z.array(objectId).default([]),
  tags: z.array(z.object({ _id: objectId, name: z.string(), color: z.string() })).optional(),
  /** ★ v2: tuỳ chọn tự động (vay). */
  options: z.object({ loan: loanOptions.nullable().optional() }).nullable().optional(),
  /** ★ v2: chuyển nội bộ theo ID. */
  transfer_target: transferTarget.nullable().optional(),
  /** ★ v2: nguồn gốc — thủ công / tự động (quy tắc + lượt chạy). */
  origin: documentOrigin.optional(),
  /** ★ v2: liên kết nghiệp vụ hai chiều (đã gỡ vẫn trả về với `status: removed`). */
  links: z.array(documentLinkItem).optional(),
  /** ★ v2: lượt quy trình tự động đã chạy cho phiếu này (mới nhất trước). */
  automation_runs: z.array(automationRunRow).optional(),
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
  /** [v2] đối tác theo ID + tên hiển thị, và tag gọn. */
  partner_id: objectId.nullable().optional(),
  partner_name: z.string().nullable().optional(),
  tags: z.array(z.object({ _id: objectId, name: z.string(), color: z.string() })).optional(),
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

/** Chứng từ của phiếu công nợ / khoản vay ngân hàng (không có version/CAS theo hồ sơ). */
export const ownerAttachmentPrepareBody = z.object({
  filename: z.string().min(1).max(255),
  /** R2 cho phép tới 100 MB; driver fs bị chặn 25 MB ở tầng server. */
  size: z.number().int().min(1).max(100 * 1024 * 1024),
  mime: z.string().max(120),
  sha256: z.string().length(64),
  type: z.string().max(40).default('other'),
});

export const ownerAttachmentConfirmBody = z.object({
  attachment_id: objectId,
});

export const ownerAttachmentRemoveBody = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** POST /documents/{id}/attachments/{attachmentId}/remove — chỉ khi chưa bị tham chiếu (§7.9). */
export const attachmentRemoveBody = z.object({
  if_match: docVersion,
  request_id: uuid,
  reason: z.string().trim().max(500).optional(),
});

/* ------------------------------------------------------------------ *
 * v2 — tag & liên kết thủ công từ phiếu (v2/v2.md §6.2, §11.2)
 * ------------------------------------------------------------------ */

/** PATCH /documents/{id}/tags — sửa tag được cả sau khi duyệt (không ảnh hưởng tiền), ghi lịch sử `tags_update`. */
export const documentTagsBody = z.object({
  tag_ids: z.array(objectId).max(50),
  if_match: docVersion,
  request_id: uuid,
});
export type DocumentTagsBody = z.infer<typeof documentTagsBody>;

/**
 * POST /documents/{id}/links — gán liên kết thủ công từ PHIẾU (quyền `link:manage`):
 * `offset` → khoản công nợ · `repayment` (phiếu chi) / `disbursement` (phiếu thu) → khoản nợ ngân hàng.
 * Tách gốc/lãi/phí chỉ dùng cho trả nợ (`repayment`). Quy tắc cấu trúc & sức chứa nằm ở domain/links.
 */
export const documentLinkCreateBody = z
  .object({
    relation: z.enum(['offset', 'repayment', 'disbursement']),
    to_type: linkObjectType.optional().describe('Bỏ trống → suy ra từ quan hệ'),
    to_id: objectId,
    amount_minor: minorNonNeg.nullable().optional().describe('Số tiền phân bổ; bỏ trống nếu có `split`'),
    split: linkSplit.nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    request_id: uuid.optional(),
  })
  .superRefine((v, ctx) => {
    const expected = v.relation === 'offset' ? 'debt_voucher' : 'bank_debt';
    if (v.to_type && v.to_type !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['to_type'],
        message: v.relation === 'offset' ? 'Cấn trừ chỉ nối tới khoản công nợ' : 'Quan hệ này chỉ nối tới khoản nợ ngân hàng',
      });
    }
    if (v.split && v.relation !== 'repayment') {
      ctx.addIssue({ code: 'custom', path: ['split'], message: 'Chỉ tách gốc/lãi/phí khi trả nợ ngân hàng' });
    }
    if (v.split && v.amount_minor != null) {
      const sum = BigInt(v.split.principal) + BigInt(v.split.interest) + BigInt(v.split.fee);
      if (sum !== BigInt(v.amount_minor)) {
        ctx.addIssue({ code: 'custom', path: ['amount_minor'], message: 'Tổng gốc + lãi + phí phải bằng số tiền phân bổ' });
      }
    }
    if (!v.split && v.amount_minor == null) {
      ctx.addIssue({ code: 'custom', path: ['amount_minor'], message: 'Nhập số tiền phân bổ' });
    }
  });
export type DocumentLinkCreateBody = z.infer<typeof documentLinkCreateBody>;

export const DOC_KIND_VALUES = DOC_KINDS;

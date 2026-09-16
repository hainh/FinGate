/**
 * Mongoose schemas — 16 collection của architecture §8.1 (+ recurring_rules cho §XVII).
 *
 * Quy ước:
 *  - DB snake_case; tiền lưu `{ minor: BigInt, currency, decimals }` (arch §8.5)
 *  - `documents.history[]` là nguồn sự thật của audit (ADR-05)
 *  - `audit_log` insert-only ở tầng app
 *  - MỌI collection nghiệp vụ có `company_id` và mọi query phải có nó (§7.5)
 */

import { Schema, model, type InferSchemaType } from 'mongoose';

/** minor units: BigInt trong code, Int64 trong BSON. */
const moneySchema = new Schema(
  {
    minor: { type: BigInt, required: true },
    currency: { type: String, default: 'VND', maxlength: 3 },
    decimals: { type: Number, default: 0 },
  },
  { _id: false },
);

const historyEntry = new Schema(
  {
    at: { type: Date, required: true },
    actor: {
      user_id: { type: Schema.Types.ObjectId, default: null },
      role: { type: String, default: null },
      name: { type: String, default: null },
    },
    action: { type: String, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    amount_at_decision: { type: String, default: null },
    opinion: { type: String, default: null },
    reason: { type: String, default: null },
    request_id: { type: String, default: null },
    ip: { type: String, default: null },
    fields: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const approvalStep = new Schema(
  {
    order: Number,
    role: String,
    user_id: { type: Schema.Types.ObjectId, default: null },
    delegated_from: { type: Schema.Types.ObjectId, default: null },
    state: { type: String, enum: ['waiting', 'current', 'done', 'skipped', 'rejected'], default: 'waiting' },
    action: { type: String, default: null },
    decided_at: { type: Date, default: null },
    opinion: { type: String, default: null },
    reason: { type: String, default: null },
    sla_deadline: { type: Date, default: null },
    amount_at_decision: { type: String, default: null },
    fast_tracked: { type: Boolean, default: false },
  },
  { _id: false },
);

const attachmentEmbed = new Schema(
  {
    id: { type: Schema.Types.ObjectId, auto: true },
    type: { type: String, default: 'other' },
    version: { type: Number, default: 1 },
    key: String,
    sha256: String,
    size: Number,
    mime: String,
    filename: String,
    added_at: { type: Date, default: () => new Date() },
    added_by: { type: Schema.Types.ObjectId, default: null },
    referenced_by: { type: [Schema.Types.ObjectId], default: [] },
  },
  { _id: false },
);

/* ------------------------------------------------------------------ *
 * Tổ chức & người dùng
 * ------------------------------------------------------------------ */

export const CompanySchema = new Schema(
  {
    name: { type: String, required: true },
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    tax_code: { type: String, default: null },
    address: { type: String, default: null },
    contact_email: { type: String, default: null },
    is_group: { type: Boolean, default: false },
    min_balance_minor: { type: BigInt, default: 0n },
    working_calendar: {
      workdays: { type: [Number], default: [1, 2, 3, 4, 5] },
      holidays: { type: [String], default: [] },
    },
    storage_quota_bytes: { type: Number, default: 0 },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'companies', versionKey: false },
);

export const DepartmentSchema = new Schema(
  {
    company_id: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    code: { type: String, default: null },
    parent_id: { type: Schema.Types.ObjectId, default: null },
    active: { type: Boolean, default: true },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'departments', versionKey: false },
);

export const UserSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    display_name: { type: String, default: null },
    password: {
      kdf: { type: String, default: 'scrypt' },
      hash: { type: String, default: null },
      salt: { type: String, default: null },
    },
    /** invited | active | deactivated — DS §3.5, không xoá vật lý (§XXIX.4) */
    status: { type: String, enum: ['invited', 'active', 'deactivated'], default: 'invited', index: true },
    totp: {
      enabled: { type: Boolean, default: false },
      /** AES-256-GCM bằng FIELD_KEY; không bao giờ trả ra API */
      secret_enc: { type: String, default: null },
    },
    recovery_codes: { type: [{ hash: String, used_at: { type: Date, default: null } }], default: [] },
    mfa_required: { type: Boolean, default: false },
    invite: {
      token_hash: { type: String, default: null },
      expires_at: { type: Date, default: null },
      invited_by: { type: Schema.Types.ObjectId, default: null },
      sent_at: { type: Date, default: null },
      send_count: { type: Number, default: 0 },
      company_id: { type: Schema.Types.ObjectId, default: null },
      role: { type: String, default: null },
      department_id: { type: Schema.Types.ObjectId, default: null },
    },
    reset: { token_hash: String, expires_at: Date },
    last_login_at: { type: Date, default: null },
    last_login_ip: { type: String, default: null },
    failed_logins: { type: Number, default: 0 },
    locked_until: { type: Date, default: null },
    deactivated_at: { type: Date, default: null },
    deactivated_reason: { type: String, default: null },
    prefs: {
      theme: { type: String, enum: ['light', 'dark', 'system'], default: 'light' },
      density: { type: String, enum: ['comfortable', 'compact'], default: 'comfortable' },
      default_scope: { type: String, default: 'all' },
      active_company_id: { type: Schema.Types.ObjectId, default: null },
      auto_open_next: { type: Boolean, default: false },
      shortcuts: { type: Schema.Types.Mixed, default: {} },
      notify_channels: { type: [String], default: ['web'] },
      quiet_hours: { type: Boolean, default: true },
      saved_views: { type: Schema.Types.Mixed, default: {} },
    },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'users', versionKey: false },
);

export const AssignmentSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, required: true, index: true },
    company_id: { type: Schema.Types.ObjectId, required: true },
    department_id: { type: Schema.Types.ObjectId, default: null },
    /** 7 chức danh blueprint §III */
    role: { type: String, required: true },
    amount_limit_minor: { type: BigInt, default: 0n },
    scope_all: { type: Boolean, default: false },
    /** quyền riêng bù/trừ so với vai trò (ADM-03) */
    extra_permissions: { type: [String], default: [] },
    denied_permissions: { type: [String], default: [] },
    status: { type: String, enum: ['active', 'ended'], default: 'active' },
    valid_from: { type: Date, default: () => new Date() },
    valid_to: { type: Date, default: null },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'assignments', versionKey: false, timestamps: false },
);
AssignmentSchema.index({ user_id: 1, status: 1 });
AssignmentSchema.index({ company_id: 1, role: 1 });

export const SessionSchema = new Schema(
  {
    token_hash: { type: String, required: true, unique: true },
    user_id: { type: Schema.Types.ObjectId, required: true },
    company_scope: { type: [Schema.Types.ObjectId], default: [] },
    active_company_id: { type: Schema.Types.ObjectId, default: null },
    ip: { type: String, default: null },
    ua: { type: String, default: null },
    /** pending_2fa: sau bước 1, chưa xác minh OTP */
    state: { type: String, enum: ['pending_2fa', 'active'], default: 'active' },
    challenge_hash: { type: String, default: null },
    created_at: { type: Date, default: () => new Date() },
    last_seen: { type: Date, default: () => new Date() },
    expires_at: { type: Date, required: true },
    revoked_at: { type: Date, default: null },
  },
  { collection: 'sessions', versionKey: false },
);
SessionSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 }); // TTL — arch §8.4
SessionSchema.index({ user_id: 1 });

export const DelegationSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, required: true },
    to_user_id: { type: Schema.Types.ObjectId, required: true },
    company_id: { type: Schema.Types.ObjectId, default: null },
    role: { type: String, default: null },
    valid_from: { type: Date, required: true },
    valid_to: { type: Date, required: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ['active', 'revoked'], default: 'active' },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'delegations', versionKey: false },
);
DelegationSchema.index({ to_user_id: 1, status: 1, valid_from: 1, valid_to: 1 });

/** Approval Matrix — "ma trận duyệt là dữ liệu", cấu hình được (§XX). */
export const ApprovalMatrixSchema = new Schema(
  {
    company_id: { type: Schema.Types.ObjectId, default: null },
    doc_kind: { type: String, required: true },
    category_id: { type: Schema.Types.ObjectId, default: null },
    amount_min_minor: { type: BigInt, default: 0n },
    amount_max_minor: { type: BigInt, default: null },
    currency: { type: String, default: 'VND' },
    steps: [
      {
        order: Number,
        role: String,
        sla_hours: { type: Number, default: 24 },
        mandatory: { type: Boolean, default: true },
        _id: false,
      },
    ],
    version: { type: Number, default: 1 },
    effective_from: { type: Date, required: true },
    label: { type: String, default: null },
    active: { type: Boolean, default: true },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'approval_matrix', versionKey: false },
);
ApprovalMatrixSchema.index({ company_id: 1, doc_kind: 1, active: 1, effective_from: -1 });

/* ------------------------------------------------------------------ *
 * Hồ sơ — MỘT collection cho mọi loại phiếu (ADR-10)
 * ------------------------------------------------------------------ */

export const DocumentSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['spend', 'income', 'rollover', 'internal'], required: true },
    company_id: { type: Schema.Types.ObjectId, required: true },
    department_id: { type: Schema.Types.ObjectId, default: null },
    created_by: { type: Schema.Types.ObjectId, required: true },
    status: { type: String, required: true, default: 'draft' },
    /** dùng cho ETag / If-Match — CAS (§7.3) */
    version: { type: Number, default: 1 },

    title: { type: String, required: true },
    purpose: { type: String, default: null },
    category_id: { type: Schema.Types.ObjectId, default: null },

    payee: {
      name: String,
      tax_code: { type: String, default: null },
      counterparty_id: { type: Schema.Types.ObjectId, default: null },
      is_internal: { type: Boolean, default: false },
      bank_name: { type: String, default: null },
      bank_account: { type: String, default: null },
    },
    amount: { minor: { type: BigInt, required: true }, currency: { type: String, default: 'VND' }, decimals: { type: Number, default: 0 } },
    fx: { rate: { type: String, default: null }, at: { type: String, default: null } },

    source: {
      fund: { type: String, enum: ['bank', 'cash'], default: 'bank' },
      account_id: { type: Schema.Types.ObjectId, default: null },
      group_account_id: { type: Schema.Types.ObjectId, default: null },
      group_managed: { type: Boolean, default: false },
    },
    /** chuyển tiền nội bộ: công ty/TK nhận (blueprint §XXI) */
    target: {
      company_id: { type: Schema.Types.ObjectId, default: null },
      account_id: { type: Schema.Types.ObjectId, default: null },
    },

    planned_date: { type: String, required: true },
    business_date: { type: String, required: true },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    contract: {
      code: { type: String, default: null },
      value: { type: moneySchema, default: null },
      signed_at: { type: String, default: null },
    },
    loan_id: { type: Schema.Types.ObjectId, default: null },
    debt_code: { type: String, default: null },
    budget: {
      budget_id: { type: Schema.Types.ObjectId, default: null },
      line_id: { type: Schema.Types.ObjectId, default: null },
      in_plan: { type: Boolean, default: true },
    },
    note: { type: String, default: null },

    rollover: {
      need_amount: { minor: BigInt, currency: String, decimals: Number },
      plan: String,
      fee_estimate: { type: moneySchema, default: null },
      new_rate: { type: String, default: null },
      collateral: { type: String, default: null },
      proposal: { type: String, default: null },
      result: {
        type: new Schema(
          {
            done_at: { type: String, default: null },
            new_contract: { type: String, default: null },
            new_limit: { type: moneySchema, default: null },
            actual_fee: { type: moneySchema, default: null },
            note: { type: String, default: null },
          },
          { _id: false },
        ),
        default: null,
      },
    },

    approval: {
      matrix_id: { type: Schema.Types.ObjectId, default: null },
      matrix_version: { type: Number, default: 0 },
      matrix_label: { type: String, default: null },
      steps: [approvalStep],
    },

    evidence: {
      required: { type: [String], default: [] },
      present: { type: [String], default: [] },
      missing: { type: [String], default: [] },
    },

    /** bản nhúng là nguồn sự thật; `attachments` collection chỉ là mirror metadata */
    attachments: [attachmentEmbed],

    execution: {
      paid_at: { type: String, default: null },
      bank_ref: { type: String, default: null },
      executed_by: { type: Schema.Types.ObjectId, default: null },
      actual_amount_minor: { type: BigInt, default: null },
      actual_amount: { type: moneySchema, default: null },
    },

    override: {
      fast_tracked: { type: Boolean, default: false },
      reason: { type: String, default: null },
      by: { type: Schema.Types.ObjectId, default: null },
    },

    /** ★ audit nhúng, CHỈ THÊM (§7.4). Trần mềm 1000 phần tử (arch §8.2). */
    history: [historyEntry],

    /** các request_id đã xử lý — chặn double-click/retry tạo 2 bước (§6) */
    processed_requests: { type: [String], default: [] },

    /** SLA & overdue là dẫn xuất, lưu để query nhanh */
    sla_deadline: { type: Date, default: null },
    overdue: { type: Boolean, default: false },
    current_step_order: { type: Number, default: null },

    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
    submitted_at: { type: Date, default: null },
    closed_at: { type: Date, default: null },
    archived_at: { type: Date, default: null },
  },
  { collection: 'documents', versionKey: false },
);

export const AttachmentSchema = new Schema(
  {
    document_id: { type: Schema.Types.ObjectId, required: true },
    company_id: { type: Schema.Types.ObjectId, required: true },
    attachment_id: { type: Schema.Types.ObjectId, required: true },
    type: String,
    version: { type: Number, default: 1 },
    key: { type: String, required: true },
    sha256: String,
    size: Number,
    mime: String,
    filename: String,
    /** prepared → confirmed; quá 7 ngày chưa confirm = file mồ côi, `cleanup` dọn (arch §8.6) */
    state: { type: String, enum: ['prepared', 'confirmed', 'orphan'], default: 'prepared' },
    added_by: { type: Schema.Types.ObjectId, default: null },
    created_at: { type: Date, default: () => new Date() },
    confirmed_at: { type: Date, default: null },
  },
  { collection: 'attachments', versionKey: false },
);
AttachmentSchema.index({ document_id: 1, state: 1 });
AttachmentSchema.index({ company_id: 1, state: 1, created_at: 1 });

/* ------------------------------------------------------------------ *
 * Ngân hàng
 * ------------------------------------------------------------------ */

export const BankAccountSchema = new Schema(
  {
    /** null = tài khoản Tập đoàn, chỉ Chủ tịch HĐQT cấu hình (blueprint §VIII) */
    company_id: { type: Schema.Types.ObjectId, default: null },
    is_group: { type: Boolean, default: false },
    bank_name: { type: String, required: true },
    account_name: { type: String, required: true },
    account_number: { type: String, required: true },
    branch: { type: String, default: null },
    kind: { type: String, enum: ['bank', 'cash'], default: 'bank' },
    currency: { type: String, default: 'VND' },
    manager_user_id: { type: Schema.Types.ObjectId, default: null },
    limit_minor: { type: BigInt, default: null },
    min_balance_minor: { type: BigInt, default: 0n },
    show_on_dashboard: { type: Boolean, default: true },
    status: { type: String, enum: ['active', 'closed', 'frozen'], default: 'active' },
    note: { type: String, default: null },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'bank_accounts', versionKey: false },
);
BankAccountSchema.index({ company_id: 1, status: 1 });
BankAccountSchema.index({ account_number: 1, company_id: 1 }, { unique: true });

/** Read model đơn giản: MỘT document per (account, ngày) — CAS theo doc ngày (arch §8.3). */
export const BalanceDailySchema = new Schema(
  {
    company_id: { type: Schema.Types.ObjectId, required: true },
    account_id: { type: Schema.Types.ObjectId, required: true },
    date: { type: String, required: true },
    opening_minor: { type: BigInt, default: 0n },
    planned_in_minor: { type: BigInt, default: 0n },
    planned_out_minor: { type: BigInt, default: 0n },
    actual_in_minor: { type: BigInt, default: 0n },
    actual_out_minor: { type: BigInt, default: 0n },
    closing_minor: { type: BigInt, default: 0n },
    blocked_minor: { type: BigInt, default: 0n },
    min_balance_minor: { type: BigInt, default: 0n },
    breach: { type: Boolean, default: false },
    /** đã nhập sao kê / cash position tay chưa */
    source: { type: String, enum: ['manual', 'statement', 'system'], default: 'system' },
    version: { type: Number, default: 1 },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'balances_daily', versionKey: false },
);
BalanceDailySchema.index({ company_id: 1, account_id: 1, date: -1 }, { unique: true });

export const BankTransactionSchema = new Schema(
  {
    account_id: { type: Schema.Types.ObjectId, required: true },
    company_id: { type: Schema.Types.ObjectId, required: true },
    value_date: { type: String, required: true },
    booked_at: { type: String, default: null },
    ref: { type: String, required: true },
    description: { type: String, default: null },
    amount_minor: { type: BigInt, required: true },
    currency: { type: String, default: 'VND' },
    document_id: { type: Schema.Types.ObjectId, default: null },
    matched: { type: Boolean, default: false },
    import_batch: { type: String, default: null },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'bank_transactions', versionKey: false },
);
// chặn import trùng (arch §8.4)
BankTransactionSchema.index({ account_id: 1, value_date: 1, ref: 1 }, { unique: true });

export const LoanSchema = new Schema(
  {
    company_id: { type: Schema.Types.ObjectId, required: true },
    bank_name: { type: String, required: true },
    contract_code: { type: String, required: true },
    limit_minor: { type: BigInt, default: 0n },
    outstanding_minor: { type: BigInt, default: 0n },
    currency: { type: String, default: 'VND' },
    disbursed_at: { type: String, required: true },
    maturity_date: { type: String, required: true },
    next_due_date: { type: String, default: null },
    interest_rate: { type: String, default: '0' },
    interest_period: { type: String, default: 'end_of_term' },
    principal_period: { type: String, default: 'bullet' },
    collateral: { type: String, default: null },
    manager_user_id: { type: Schema.Types.ObjectId, default: null },
    status: { type: String, enum: ['active', 'renewed', 'settled', 'overdue', 'archived'], default: 'active' },
    obligations: {
      type: [
        new Schema(
          {
            due_date: String,
            kind: { type: String, enum: ['principal', 'interest', 'fee'], default: 'principal' },
            amount_minor: BigInt,
            paid_minor: { type: BigInt, default: 0n },
            document_id: { type: Schema.Types.ObjectId, default: null },
          },
        ),
      ],
      default: [],
    },
    note: { type: String, default: null },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'loans', versionKey: false },
);
LoanSchema.index({ company_id: 1, next_due_date: 1 });
LoanSchema.index({ company_id: 1, contract_code: 1 }, { unique: true });

/* ------------------------------------------------------------------ *
 * Công nợ · ngân sách · danh mục
 * ------------------------------------------------------------------ */

export const DebtItemSchema = new Schema(
  {
    kind: { type: String, enum: ['receivable', 'payable'], required: true },
    company_id: { type: Schema.Types.ObjectId, required: true },
    counterparty_name: { type: String, required: true },
    counterparty_tax_code: { type: String, default: null },
    contract_code: { type: String, default: null },
    value_minor: { type: BigInt, default: 0n },
    settled_minor: { type: BigInt, default: 0n },
    currency: { type: String, default: 'VND' },
    due_date: { type: String, required: true },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    document_ids: { type: [Schema.Types.ObjectId], default: [] },
    status: { type: String, enum: ['open', 'partial', 'settled'], default: 'open' },
    note: { type: String, default: null },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'debt_items', versionKey: false },
);
DebtItemSchema.index({ company_id: 1, kind: 1, due_date: 1 });

export const BudgetSchema = new Schema(
  {
    company_id: { type: Schema.Types.ObjectId, required: true },
    period: { type: String, enum: ['month', 'quarter', 'year'], required: true },
    period_start: { type: String, required: true },
    label: { type: String, default: null },
    limit_minor: { type: BigInt, default: 0n },
    lines: {
      type: [
        new Schema(
          {
            label: String,
            department_id: { type: Schema.Types.ObjectId, default: null },
            category_id: { type: Schema.Types.ObjectId, default: null },
            limit_minor: { type: BigInt, default: 0n },
            used_minor: { type: BigInt, default: 0n },
          },
        ),
      ],
      default: [],
    },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'budgets', versionKey: false },
);
BudgetSchema.index({ company_id: 1, period: 1, period_start: -1 });

/** `budget_lines` nằm lồng trong budgets.lines — giữ collection rỗng cho tương thích arch §8.1 */
export const BudgetLineSchema = new Schema(
  {
    budget_id: { type: Schema.Types.ObjectId, required: true },
    company_id: { type: Schema.Types.ObjectId, required: true },
    label: String,
    department_id: { type: Schema.Types.ObjectId, default: null },
    category_id: { type: Schema.Types.ObjectId, default: null },
    limit_minor: { type: BigInt, default: 0n },
    used_minor: { type: BigInt, default: 0n },
  },
  { collection: 'budget_lines', versionKey: false },
);
BudgetLineSchema.index({ budget_id: 1 });

export const CategorySchema = new Schema(
  {
    name: { type: String, required: true },
    code: { type: String, default: null },
    group: { type: String, enum: ['hoat_dong', 'dau_tu', 'tai_chinh', 'khac'], default: 'khac' },
    doc_kind: { type: String, enum: ['spend', 'income', 'rollover', 'internal'], default: 'spend' },
    parent_id: { type: Schema.Types.ObjectId, default: null },
    /** chứng từ bắt buộc theo loại phiếu — cấu hình được (§XXX.2, Q-04) */
    required_evidence: { type: [String], default: [] },
    requires_budget: { type: Boolean, default: false },
    matrix_id: { type: Schema.Types.ObjectId, default: null },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'categories', versionKey: false },
);
CategorySchema.index({ doc_kind: 1, active: 1, order: 1 });

/** §XVII — khoản chi định kỳ, task `recurring` vật thành phiếu nháp + nhắc 7/3/1 ngày. */
export const RecurringRuleSchema = new Schema(
  {
    company_id: { type: Schema.Types.ObjectId, required: true },
    title: { type: String, required: true },
    purpose: { type: String, default: null },
    category_id: { type: Schema.Types.ObjectId, default: null },
    department_id: { type: Schema.Types.ObjectId, default: null },
    payee: { name: String, tax_code: { type: String, default: null } },
    amount_minor: { type: BigInt, default: 0n },
    currency: { type: String, default: 'VND' },
    source: { fund: { type: String, default: 'bank' }, account_id: { type: Schema.Types.ObjectId, default: null } },
    cadence: { type: String, enum: ['weekly', 'monthly', 'quarterly', 'semi_annual', 'annual'], default: 'monthly' },
    day_of_period: { type: Number, default: 1 },
    remind_days: { type: [Number], default: [7, 3, 1] },
    effective_from: { type: String, required: true },
    effective_to: { type: String, default: null },
    auto_create_draft: { type: Boolean, default: true },
    last_run_period: { type: String, default: null },
    last_document_id: { type: Schema.Types.ObjectId, default: null },
    status: { type: String, enum: ['active', 'paused'], default: 'active' },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'recurring_rules', versionKey: false },
);
RecurringRuleSchema.index({ company_id: 1, status: 1 });

/* ------------------------------------------------------------------ *
 * Cảnh báo · thông báo · audit · jobs · settings
 * ------------------------------------------------------------------ */

/** `alerts` chứa cả rule lẫn event, phân bằng `type` (arch §8.1). */
export const AlertSchema = new Schema(
  {
    type: { type: String, enum: ['rule', 'event'], required: true },
    alert_type: { type: String, required: true },
    company_id: { type: Schema.Types.ObjectId, default: null },
    enabled: { type: Boolean, default: true },
    severity: { type: Number, default: 2, min: 0, max: 3 },
    threshold: { type: Schema.Types.Mixed, default: {} },
    channels: { type: [String], default: ['web'] },
    to_roles: { type: [String], default: [] },
    text: { type: String, default: null },
    amount_minor: { type: BigInt, default: null },
    currency: { type: String, default: 'VND' },
    href: { type: String, default: null },
    subject: { type: Schema.Types.Mixed, default: null },
    /** dedupe: rule_id + subject + period (arch §9.4) */
    dedupe_key: { type: String, default: null },
    acknowledged_at: { type: Date, default: null },
    acknowledged_by: { type: Schema.Types.ObjectId, default: null },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'alerts', versionKey: false },
);
AlertSchema.index({ dedupe_key: 1 }, { unique: true, partialFilterExpression: { dedupe_key: { $type: 'string' } } });
AlertSchema.index({ type: 1, company_id: 1, enabled: 1 });
AlertSchema.index({ type: 1, created_at: -1 });

export const NotificationSchema = new Schema(
  {
    user_id: { type: Schema.Types.ObjectId, required: true },
    company_id: { type: Schema.Types.ObjectId, default: null },
    kind: { type: String, enum: ['approval', 'alert', 'system', 'newsletter', 'hr'], default: 'system' },
    severity: { type: Number, default: 1, min: 0, max: 3 },
    title: { type: String, required: true },
    body: { type: String, default: null },
    href: { type: String, default: null },
    document_id: { type: Schema.Types.ObjectId, default: null },
    channels_sent: { type: [String], default: [] },
    read_at: { type: Date, default: null },
    created_at: { type: Date, default: () => new Date() },
  },
  { collection: 'notifications', versionKey: false },
);
NotificationSchema.index({ user_id: 1, read_at: 1, created_at: -1 });

/** Feed suy diễn từ `history[]` — tìm kiếm跨 hồ sơ; rebuild được bằng db:rebuild-audit (ADR-05). */
export const AuditLogSchema = new Schema(
  {
    at: { type: Date, required: true },
    actor: {
      user_id: { type: Schema.Types.ObjectId, default: null },
      name: { type: String, default: null },
      role: { type: String, default: null },
    },
    action: { type: String, required: true },
    subject: {
      type: { type: String, required: true },
      id: { type: String, default: null },
      code: { type: String, default: null },
    },
    company_id: { type: Schema.Types.ObjectId, default: null },
    diff_fields: { type: Schema.Types.Mixed, default: null },
    request_id: { type: String, default: null },
    ip: { type: String, default: null },
    ua: { type: String, default: null },
    document_id: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: 'audit_log', versionKey: false },
);
AuditLogSchema.index({ company_id: 1, at: -1 });
AuditLogSchema.index({ 'actor.user_id': 1, at: -1 });
AuditLogSchema.index({ 'subject.type': 1, 'subject.id': 1, at: -1 });

export const JobSchema = new Schema(
  {
    name: { type: String, required: true },
    state: { type: String, enum: ['queued', 'running', 'done', 'failed'], default: 'queued', index: true },
    run_at: { type: Date, default: () => new Date() },
    /** unique thay cho distributed lock (arch §8.6) */
    dedupe_key: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    result: { type: Schema.Types.Mixed, default: null },
    error: { type: String, default: null },
    /** file export lớn → đẩy lên R2, link hết hạn (arch §6) */
    artifact_key: { type: String, default: null },
    row_count: { type: Number, default: null },
    attempts: { type: Number, default: 0 },
    company_id: { type: Schema.Types.ObjectId, default: null },
    user_id: { type: Schema.Types.ObjectId, default: null },
    created_at: { type: Date, default: () => new Date() },
    started_at: { type: Date, default: null },
    finished_at: { type: Date, default: null },
  },
  { collection: 'jobs', versionKey: false },
);
JobSchema.index({ state: 1, run_at: 1 });
JobSchema.index({ dedupe_key: 1 }, { unique: true, partialFilterExpression: { dedupe_key: { $type: 'string' } } });

export const SettingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed, required: true },
    description: { type: String, default: null },
    updated_at: { type: Date, default: () => new Date() },
    updated_by: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: 'settings', versionKey: false },
);

/** Bộ đếm sinh mã phiếu `PC-2026-00123` — CAS `$inc` trên 1 document (domain/numbering). */
export const CounterSchema = new Schema(
  {
    _id: String,
    seq: { type: Number, default: 0 },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'counters', versionKey: false },
);

/* ------------------------------------------------------------------ *
 * Models
 * ------------------------------------------------------------------ */

export interface MoneyEmbedded {
  minor: bigint;
  currency: string;
  decimals: number;
}

export type CompanyDoc = InferSchemaType<typeof CompanySchema>;
export type DocumentDoc = InferSchemaType<typeof DocumentSchema>;


export const Models = {
  Company: model('Company', CompanySchema),
  Department: model('Department', DepartmentSchema),
  User: model('User', UserSchema),
  Assignment: model('Assignment', AssignmentSchema),
  Session: model('Session', SessionSchema),
  Delegation: model('Delegation', DelegationSchema),
  ApprovalMatrix: model('ApprovalMatrix', ApprovalMatrixSchema),
  Document: model('Document', DocumentSchema),
  Attachment: model('Attachment', AttachmentSchema),
  BankAccount: model('BankAccount', BankAccountSchema),
  BalanceDaily: model('BalanceDaily', BalanceDailySchema),
  BankTransaction: model('BankTransaction', BankTransactionSchema),
  Loan: model('Loan', LoanSchema),
  DebtItem: model('DebtItem', DebtItemSchema),
  Budget: model('Budget', BudgetSchema),
  BudgetLine: model('BudgetLine', BudgetLineSchema),
  Category: model('Category', CategorySchema),
  RecurringRule: model('RecurringRule', RecurringRuleSchema),
  Alert: model('Alert', AlertSchema),
  Notification: model('Notification', NotificationSchema),
  AuditLog: model('AuditLog', AuditLogSchema),
  Job: model('Job', JobSchema),
  Setting: model('Setting', SettingSchema),
  Counter: model('Counter', CounterSchema),
} as const;

export type ModelsKey = keyof typeof Models;

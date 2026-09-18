/**
 * FinGate — hợp đồng ngân hàng · vay · đảo hạn · công nợ · dòng tiền (blueprint §VIII–XVI)
 */

import { z } from 'zod';
import { MATURITY_BUCKETS } from '../status/index.js';
const lit = <T extends string>(arr: readonly T[]) => arr as unknown as [T, ...T[]];
import { businessDate, businessDateTime, moneyField, moneyWire, objectId, uuid } from './common.js';
import { priority } from './documents.js';

export const accountKind = z.enum(['bank', 'cash']);
export const accountStatus = z.enum(['active', 'closed', 'frozen']);

/** §VIII — ngân hàng của công ty + tài khoản tập đoàn (chỉ Chủ tịch HĐQT cấu hình). */
export const bankAccountUpsertBody = z.object({
  company_id: objectId.optional().describe('Bỏ trống = tài khoản Tập đoàn (quyền admin:group_accounts)'),
  is_group: z.boolean().default(false),
  bank_name: z.string().min(2).max(120),
  account_name: z.string().min(2).max(160),
  account_number: z.string().min(4).max(40),
  branch: z.string().max(160).optional(),
  currency: z.string().length(3).default('VND'),
  kind: accountKind.default('bank'),
  /** chủ tài khoản phụ trách (group account) / người quản lý. */
  manager_user_id: objectId.nullable().optional(),
  limit_minor: z.string().regex(/^\d+$/).optional(),
  min_balance_minor: z.string().regex(/^\d+$/).default('0'),
  show_on_dashboard: z.boolean().default(true),
  status: accountStatus.default('active'),
  note: z.string().max(500).optional(),
});

export const bankAccountRow = z.object({
  _id: objectId,
  company_id: objectId.nullable(),
  company_name: z.string().nullable(),
  is_group: z.boolean(),
  bank_name: z.string(),
  account_name: z.string(),
  /** số tài khoản đầy đủ (không còn che). */
  account_number_masked: z.string(),
  currency: z.string(),
  kind: accountKind,
  balance: moneyWire.nullable(),
  available: moneyWire.nullable(),
  frozen: moneyWire.nullable(),
  min_balance: moneyWire,
  limit: moneyWire.nullable(),
  status: accountStatus,
  stale: z.boolean().describe('Chưa có số dư cho ngày hôm nay'),
  open_docs_count: z.number().int().optional(),
  updated_at: z.string().nullable(),
});

/** BANK-04 — nhập số dư đầu ngày. Luật tự kiểm: opening + in − out = closing. */
export const balanceEntryBody = z.object({
  company_id: objectId,
  account_id: objectId,
  date: businessDate,
  opening: moneyField,
  inflow: moneyField,
  outflow: moneyField,
  closing: moneyField,
  blocked: moneyField,
  request_id: uuid,
});

export const balancesBulkBody = z.object({
  date: businessDate,
  entries: z
    .array(
      z.object({
        account_id: objectId,
        opening_minor: z.string().regex(/^-?\d+$/),
        inflow_minor: z.string().regex(/^\d+$/),
        outflow_minor: z.string().regex(/^\d+$/),
        closing_minor: z.string().regex(/^-?\d+$/),
        blocked_minor: z.string().regex(/^\d+$/),
      }),
    )
    .min(1)
    .max(200),
});

export const balanceRow = z.object({
  date: businessDate,
  company_id: objectId,
  company_name: z.string(),
  account_id: objectId,
  account_label: z.string(),
  opening: moneyWire,
  inflow: moneyWire,
  outflow: moneyWire,
  closing: moneyWire,
  blocked: moneyWire,
  available: moneyWire,
  min_balance: moneyWire,
  breach: z.boolean(),
  /** closing − (opening + inflow − outflow) — phải bằng 0 (blueprint §VIII). */
  diff_minor: z.string(),
});

/** BANK-09 — import sao kê (CSV/Excel, file nhỏ qua @fastify/multipart). */
export const statementImportBody = z.object({
  account_id: objectId,
  date: businessDate,
  rows: z
    .array(
      z.object({
        value_date: businessDate,
        ref: z.string().max(80),
        description: z.string().max(300),
        amount_minor: z.string().regex(/^-?\d+$/),
        matched_document_id: objectId.optional(),
      }),
    )
    .min(1)
    .max(5000),
});

/* ------------------------------------------------------------------ *
 * Vay ngân hàng (§IX) + đảo hạn (§X, §XI)
 * ------------------------------------------------------------------ */

export const loanStatus = z.enum(['active', 'renewed', 'settled', 'overdue', 'archived']);
export const interestPeriod = z.enum(['end_of_term', 'monthly', 'quarterly', 'semi_annual', 'annual']);
export const principalPeriod = z.enum(['bullet', 'monthly', 'quarterly', 'semi_annual', 'annual', 'custom']);

export const loanUpsertBody = z.object({
  company_id: objectId,
  bank_name: z.string().min(2).max(120),
  contract_code: z.string().min(2).max(80),
  limit: moneyField,
  outstanding: moneyField,
  currency: z.string().length(3).default('VND'),
  disbursed_at: businessDate,
  maturity_date: businessDate,
  next_due_date: businessDate.optional(),
  interest_rate: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Lãi suất tối đa 2 chữ số thập phân'),
  interest_period: interestPeriod.default('end_of_term'),
  principal_period: principalPeriod.default('bullet'),
  collateral: z.string().max(1000).optional(),
  manager_user_id: objectId.nullable().optional(),
  status: loanStatus.default('active'),
  note: z.string().max(1000).optional(),
});

export const loanRow = z.object({
  _id: objectId,
  company_id: objectId,
  company_name: z.string(),
  bank_name: z.string(),
  contract_code: z.string(),
  limit: moneyWire,
  outstanding: moneyWire,
  currency: z.string(),
  disbursed_at: businessDate,
  maturity_date: businessDate,
  next_due_date: businessDate.nullable(),
  days_to_due: z.number().int(),
  interest_rate: z.string(),
  interest_period: interestPeriod,
  principal_period: principalPeriod,
  collateral: z.string().nullable(),
  manager_name: z.string().nullable(),
  status: loanStatus,
  /** phương án đảo hạn đang mở cho khoản vay này. */
  rollover_status: z.string().nullable(),
  updated_at: z.string(),
});

export const obligationRow = z.object({
  loan_id: objectId,
  contract_code: z.string(),
  bank_name: z.string(),
  company_name: z.string(),
  due_date: businessDate,
  kind: z.enum(['principal', 'interest', 'fee']),
  amount: moneyWire,
  paid: moneyWire,
  remaining: moneyWire,
  status: z.enum(['due', 'paid', 'overdue', 'upcoming']),
});

export const rolloverListQuery = z.object({
  bucket: z.enum(lit(MATURITY_BUCKETS)).optional(),
  company_id: objectId.optional(),
  bank_name: z.string().max(120).optional(),
  scope: z.string().max(64).optional(),
});

/** RENEW-01 — FgMaturityTable. */
export const maturityRow = z.object({
  loan_id: objectId,
  contract_code: z.string(),
  company_id: objectId,
  company_name: z.string(),
  bank_name: z.string(),
  outstanding: moneyWire,
  maturity_date: businessDate,
  days_to_due: z.number().int(),
  need_prepare: moneyWire,
  level: z.number().int().min(0).max(3),
  tone: z.string(),
  label: z.string(),
  rollover: z
    .object({
      document_id: objectId.nullable(),
      code: z.string().nullable(),
      status: z.string().nullable(),
      prepared: z.boolean(),
    })
    .nullable(),
});

/** §XI — thông tin phương án đảo hạn (bổ sung cho document.kind = rollover). */
export const rolloverResultBody = z.object({
  done_at: businessDate,
  new_contract_code: z.string().max(80),
  new_limit: moneyField,
  new_rate: z.string().regex(/^\d+(\.\d{1,2})?$/),
  actual_fee: moneyField,
  note: z.string().max(1000).optional(),
  if_match: z.coerce.number().int().min(0),
  request_id: z.string().uuid(),
});

/* ------------------------------------------------------------------ *
 * Công nợ (§XVI)
 * ------------------------------------------------------------------ */

export const debtKind = z.enum(['receivable', 'payable']);

export const debtUpsertBody = z.object({
  kind: debtKind,
  company_id: objectId,
  counterparty_name: z.string().min(2).max(200),
  counterparty_tax_code: z.string().max(20).optional(),
  contract_code: z.string().max(80).optional(),
  contract_value: moneyField,
  received_or_paid: moneyField.optional(),
  due_date: businessDate,
  priority: priority.default('normal'),
  note: z.string().max(1000).optional(),
});

export const debtRow = z.object({
  _id: objectId,
  kind: debtKind,
  company_id: objectId,
  company_name: z.string(),
  counterparty_name: z.string(),
  contract_code: z.string().nullable(),
  value: moneyWire,
  settled: moneyWire,
  remaining: moneyWire,
  due_date: businessDate,
  days_overdue: z.number().int(),
  aging_bucket: z.enum(['none', 'lt30', 'd30_60', 'd60_90', 'gt90']),
  priority,
  progress_percent: z.number().min(0).max(100),
  open_document_id: objectId.nullable(),
  updated_at: z.string(),
});

export const debtListQuery = z.object({
  kind: debtKind.optional(),
  company_id: objectId.optional(),
  scope: z.string().max(64).optional(),
  bucket: z.enum(['none', 'lt30', 'd30_60', 'd60_90', 'gt90']).optional(),
  overdue_only: z.enum(['true', 'false']).optional(),
  counterparty: z.string().max(200).optional(),
  q: z.string().max(200).optional(),
  sort: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  page: z.coerce.number().int().min(1).default(1),
});

export const agingMatrix = z.object({
  kind: debtKind,
  columns: z.array(z.object({ bucket: z.string(), label: z.string() })),
  rows: z
    .array(
      z.object({
        counterparty: z.string(),
        company_name: z.string(),
        cells: z.array(z.object({ bucket: z.string(), amount: moneyWire, count: z.number().int() })),
        total: moneyWire,
      }),
    )
    .describe('DEBT-05 — ma trận tuổi nợ'),
  totals: z.array(z.object({ bucket: z.string(), amount: moneyWire })),
});

/* ------------------------------------------------------------------ *
 * Dòng tiền — forecast (§XV) + kế hoạch + ngân sách
 * ------------------------------------------------------------------ */

export const forecastQuery = z.object({
  horizon: z.enum(['7', '30', '60', '90']).default('30'),
  scope: z.string().max(64).optional(),
  company_id: objectId.optional(),
  from: businessDate.optional(),
});

export const forecastRow = z.object({
  date: businessDate,
  weekday: z.string(),
  opening: moneyWire,
  inflow: moneyWire,
  outflow: moneyWire,
  net: moneyWire,
  closing: moneyWire,
  min_balance: moneyWire,
  breach: z.boolean(),
  /** nguồn của dòng tiền: kế hoạch thu, phiếu chi đã duyệt, đáo hạn, chi định kỳ. */
  drivers: z
    .array(z.object({ kind: z.string(), label: z.string(), amount: moneyWire, document_id: objectId.nullable() }))
    .default([]),
});

export const forecastResult = z.object({
  from: businessDate,
  to: businessDate,
  rows: z.array(forecastRow),
  totals: z.object({ inflow: moneyWire, outflow: moneyWire, net: moneyWire, min_closing: moneyWire }),
  first_breach_date: businessDate.nullable(),
  /** "Công ty B có khả năng thiếu tiền 5 tỷ vào ngày 12/09" — bản tin §XIV. */
  shortfall_alerts: z
    .array(
      z.object({
        company_id: objectId,
        company_name: z.string(),
        date: businessDate,
        amount: moneyWire,
      }),
    )
    .default([]),
  generated_at: z.string(),
  stale: z.boolean(),
});

/** CASH-05 what-if — không ghi vào dữ liệu thật. */
export const scenarioBody = z.object({
  name: z.string().min(2).max(120),
  horizon: z.enum(['7', '30', '60', '90']).default('30'),
  scope: z.string().max(64).optional(),
  adjustments: z
    .array(
      z.object({
        date: businessDate,
        delta_minor: z.string().regex(/^-?\d+$/),
        label: z.string().max(120),
      }),
    )
    .min(1)
    .max(60),
});

export const budgetUpsertBody = z.object({
  company_id: objectId,
  department_id: objectId.nullable().optional(),
  category_id: objectId.nullable().optional(),
  period: z.enum(['month', 'quarter', 'year']),
  period_start: businessDate,
  limit: moneyField,
  lines: z
    .array(
      z.object({
        label: z.string().min(2).max(120),
        category_id: objectId.nullable().optional(),
        department_id: objectId.nullable().optional(),
        limit_minor: z.string().regex(/^\d+$/),
      }),
    )
    .optional(),
});

export const budgetRow = z.object({
  _id: objectId,
  company_id: objectId,
  company_name: z.string(),
  period: z.enum(['month', 'quarter', 'year']),
  period_start: businessDate,
  period_label: z.string(),
  limit: moneyWire,
  used: moneyWire,
  percent: z.number(),
  over: z.boolean(),
  lines: z.array(
    z.object({
      line_id: objectId,
      label: z.string(),
      department_name: z.string().nullable(),
      category_name: z.string().nullable(),
      limit: moneyWire,
      used: moneyWire,
      percent: z.number(),
      over: z.boolean(),
    }),
  ),
});

/** BANK-07/08 — chuyển tiền nội bộ, không tính doanh thu/chi phí (§XXI). */
export const internalTransferBody = z.object({
  from_company_id: objectId,
  from_account_id: objectId,
  to_company_id: objectId,
  to_account_id: objectId.nullable().optional(),
  amount: moneyField,
  planned_date: businessDateTime,
  purpose: z.string().min(3).max(1000),
  fee_minor: z.string().regex(/^\d+$/).default('0'),
  request_id: z.string().uuid(),
});

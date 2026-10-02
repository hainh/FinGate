/**
 * FinGate — hợp đồng ngân hàng · vay · đảo hạn · công nợ · dòng tiền (blueprint §VIII–XVI)
 */

import { z } from 'zod';
import { MATURITY_BUCKETS } from '../status/index.js';
const lit = <T extends string>(arr: readonly T[]) => arr as unknown as [T, ...T[]];
import { businessDate, businessDateTime, moneyField, moneyWire, objectId } from './common.js';
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

/** PATCH /bank-accounts/{id} — sửa tài khoản tiền. KHÔNG đổi công ty / tài khoản Tập đoàn. */
export const bankAccountUpdateBody = bankAccountUpsertBody.omit({ company_id: true, is_group: true }).partial();

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

/* ------------------------------------------------------------------ *
 * Nợ Ngân hàng (§IX) — thay module "Khoản vay" cũ nhưng vẫn cấp dữ liệu Đáo hạn.
 * ------------------------------------------------------------------ */

export const bankDebtStatus = z.enum(['active', 'overdue', 'settled', 'archived']);

/** Kỳ trả lãi/gốc — dùng sinh lịch nghĩa vụ trả nợ (LOAN-04). */
export const repaymentFrequency = z.enum(['monthly', 'quarterly', 'semiannual', 'maturity']);
export type RepaymentFrequency = z.infer<typeof repaymentFrequency>;

/** Cách trả gốc: chỉ trả lãi định kỳ + gốc cuối kỳ, hoặc chia đều gốc mỗi kỳ. */
export const repaymentMethod = z.enum(['interest_only', 'equal_principal']);
export type RepaymentMethod = z.infer<typeof repaymentMethod>;

export const bankDebtUpsertBody = z.object({
  company_id: objectId.optional().describe('Mặc định theo phiên làm việc'),
  bank_name: z.string().min(2).max(120),
  branch: z.string().max(160).optional(),
  /** Số tiền vay. */
  amount: moneyField,
  interest_rate: z.string().regex(/^\d+([.,]\d{1,2})?$/, 'Lãi suất tối đa 2 chữ số thập phân').default('0'),
  maturity_date: businessDate.describe('Hạn thanh toán'),
  currency: z.string().length(3).default('VND'),
  /** Kỳ hạn (tháng) — để sinh lịch; bỏ trống = suy từ ngày tạo → đáo hạn. */
  term_months: z.coerce.number().int().min(1).max(600).optional(),
  payment_frequency: repaymentFrequency.default('maturity'),
  repayment_method: repaymentMethod.default('interest_only'),
  note: z.string().max(1000).optional(),
});

export const bankDebtRow = z.object({
  _id: objectId,
  company_id: objectId,
  company_name: z.string(),
  code: z.string(),
  bank_name: z.string(),
  branch: z.string().nullable(),
  principal: moneyWire,
  outstanding: moneyWire,
  repaid: moneyWire,
  currency: z.string(),
  interest_rate: z.string(),
  term_months: z.number().int().nullable(),
  payment_frequency: repaymentFrequency,
  repayment_method: repaymentMethod,
  /** Lãi dự kiến còn phải trả tới kỳ đáo hạn kế tiếp (§IX). */
  interest_to_maturity: moneyWire,
  maturity_date: businessDate,
  next_due_date: businessDate.nullable(),
  days_to_due: z.number().int(),
  status: bankDebtStatus,
  attachment_count: z.number().int(),
  repayment_count: z.number().int(),
  updated_at: z.string(),
});

/** LOAN-04 — một kỳ nghĩa vụ trả nợ (gốc + lãi + phí). */
export const loanScheduleRow = z.object({
  period: z.number().int().min(1),
  due_date: businessDate,
  days: z.number().int(),
  principal: moneyWire,
  interest: moneyWire,
  fee: moneyWire,
  total: moneyWire,
  /** `upcoming` chưa tới hạn · `due` hôm nay · `overdue` đã qua. */
  status: z.enum(['upcoming', 'due', 'overdue']),
});

export const loanScheduleResult = z.object({
  loan_id: objectId,
  contract_code: z.string(),
  bank_name: z.string(),
  currency: z.string(),
  interest_rate: z.string(),
  term_months: z.number().int(),
  payment_frequency: repaymentFrequency,
  repayment_method: repaymentMethod,
  start_date: businessDate,
  maturity_date: businessDate,
  rows: z.array(loanScheduleRow),
  totals: z.object({
    principal: moneyWire,
    interest: moneyWire,
    fee: moneyWire,
    total: moneyWire,
  }),
});

/** Gán một phiếu chi vào khoản nợ ngân hàng để đánh dấu đã trả nợ. */
export const bankDebtRepayBody = z.object({
  document_id: objectId,
  /** phần số tiền phân bổ; bỏ trống = lấy số thực chi của phiếu. */
  amount_minor: z.string().regex(/^\d+$/).optional(),
  note: z.string().max(500).optional(),
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
  /** Lãi dự kiến tới kỳ đáo hạn kế tiếp (0 nếu chỉ trả lãi định kỳ). */
  interest_to_due: moneyWire,
  /** Phí dự kiến tới kỳ đáo hạn kế tiếp. */
  fee_to_due: moneyWire,
  maturity_date: businessDate,
  days_to_due: z.number().int(),
  /** Gốc + lãi + phí cần chuẩn bị cho kỳ kế tiếp. */
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
 * Công nợ (§XVI) — phiếu công nợ theo chuẩn kế toán VN
 * ------------------------------------------------------------------ */

export type DebtPartyType = 'customer' | 'supplier' | 'employee';
export type DebtSide = 'debit' | 'credit';
export type DebtAccountCode = '131' | '331' | '334';

export const DEBT_PARTY_TYPES = ['customer', 'supplier', 'employee'] as const;
export const DEBT_SIDES = ['debit', 'credit'] as const;
export const DEBT_ACCOUNT_CODES = ['131', '331', '334'] as const;

export const debtPartyType = z.enum(lit(DEBT_PARTY_TYPES));
export const debtSide = z.enum(lit(DEBT_SIDES));
export const debtAccountCode = z.enum(lit(DEBT_ACCOUNT_CODES));

export const DEBT_PARTY_LABEL: Record<DebtPartyType, string> = {
  customer: 'Khách hàng',
  supplier: 'Nhà cung cấp',
  employee: 'Nhân viên',
};

/** Mã tài khoản kế toán theo loại đối tượng: KH=131, NCC=331, NV=334. */
export const ACCOUNT_CODE_BY_PARTY: Record<DebtPartyType, DebtAccountCode> = {
  customer: '131',
  supplier: '331',
  employee: '334',
};

/** Nhãn bút toán: Nợ / Có (chuẩn VAS). */
export const DEBT_SIDE_LABEL: Record<DebtSide, string> = { debit: 'Nợ', credit: 'Có' };

export const debtVoucherUpsertBody = z.object({
  company_id: objectId.optional().describe('Mặc định theo phiên làm việc'),
  party_type: debtPartyType,
  /** Mã khách hàng / nhà cung cấp / nhân viên. */
  party_code: z.string().min(1).max(60),
  /** Tên công ty / đối tượng. */
  party_name: z.string().min(2).max(200),
  party_tax_code: z.string().max(20).optional(),
  /** STK của công ty đối tác. */
  party_bank_account: z.string().max(40).optional(),
  /** Nợ / Có. */
  side: debtSide,
  value: moneyField,
  due_date: businessDate,
  contract_code: z.string().max(80).optional(),
  priority: priority.default('normal'),
  note: z.string().max(1000).optional(),
});

export const debtVoucherRow = z.object({
  _id: objectId,
  company_id: objectId,
  company_name: z.string(),
  code: z.string(),
  party_type: debtPartyType,
  party_code: z.string(),
  party_name: z.string(),
  party_tax_code: z.string().nullable(),
  party_bank_account: z.string().nullable(),
  account_code: debtAccountCode,
  side: debtSide,
  value: moneyWire,
  settled: moneyWire.describe('Đã cấn trừ (từ phiếu thu/chi đã thực thi)'),
  remaining: moneyWire,
  currency: z.string(),
  contract_code: z.string().nullable(),
  due_date: businessDate,
  days_overdue: z.number().int(),
  aging_bucket: z.enum(['none', 'lt30', 'd30_60', 'd60_90', 'gt90']),
  priority,
  status: z.enum(['open', 'partial', 'settled']),
  attachment_count: z.number().int(),
  link_count: z.number().int(),
  updated_at: z.string(),
});

export const debtListQuery = z.object({
  party_type: debtPartyType.optional(),
  side: debtSide.optional(),
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

/** Liên kết một phiếu thu/chi để cấn trừ khoản công nợ. */
export const debtLinkBody = z.object({
  document_id: objectId,
  /** phần số tiền phân bổ; bỏ trống = lấy số tiền của phiếu. */
  amount_minor: z.string().regex(/^\d+$/).optional(),
  note: z.string().max(500).optional(),
});

export const agingMatrix = z.object({
  party_type: debtPartyType,
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
 * Dòng tiền — lịch sử (thực thu/chi) + kế hoạch + ngân sách
 * ------------------------------------------------------------------ */

/** CASH-01 — khoảng thời gian lịch sử dòng tiền (7/30/90 ngày theo ngày; 6m/1y/2y theo tháng). */
export const CASHFLOW_PERIODS = ['7d', '30d', '90d', '6m', '1y', '2y'] as const;
/** CASH-01 — cách chia swimlane. */
export const CASHFLOW_GROUPS = ['none', 'company', 'account'] as const;
/** CASH-01 — độ mịn gốc dữ liệu. */
export const CASHFLOW_GRANULARITIES = ['day', 'month'] as const;
export type CashflowPeriod = (typeof CASHFLOW_PERIODS)[number];
export type CashflowGroup = (typeof CASHFLOW_GROUPS)[number];
export type CashflowGranularity = (typeof CASHFLOW_GRANULARITIES)[number];

export const cashflowHistoryQuery = z.object({
  period: z.enum(lit(CASHFLOW_PERIODS)).default('1y'),
  group: z.enum(lit(CASHFLOW_GROUPS)).default('none'),
  scope: z.string().max(64).optional(),
});

export const cashflowPoint = z.object({
  /** `YYYY-MM-DD` (theo ngày) hoặc `YYYY-MM` (theo tháng). */
  bucket: z.string(),
  inflow: moneyWire,
  outflow: moneyWire,
  net: moneyWire,
  /** luỹ kế dòng tiền thuần trong kỳ (bắt đầu từ 0 tại mốc đầu). */
  cumulative: moneyWire,
});

export const cashflowLane = z.object({
  key: z.string(),
  label: z.string(),
  sub_label: z.string().nullable(),
  company_id: objectId.nullable(),
  account_id: objectId.nullable(),
  points: z.array(cashflowPoint),
  total_inflow: moneyWire,
  total_outflow: moneyWire,
  total_net: moneyWire,
});

export const cashflowHistoryResult = z.object({
  period: z.enum(lit(CASHFLOW_PERIODS)),
  group: z.enum(lit(CASHFLOW_GROUPS)),
  granularity: z.enum(lit(CASHFLOW_GRANULARITIES)),
  from: businessDate,
  to: businessDate,
  buckets: z.array(z.string()),
  lanes: z.array(cashflowLane),
  totals: z.object({ inflow: moneyWire, outflow: moneyWire, net: moneyWire }),
  scope_label: z.string(),
  generated_at: z.string(),
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

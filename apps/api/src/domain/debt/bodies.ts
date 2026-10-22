/**
 * Hợp đồng vào (zod) của công nợ & nợ ngân hàng v2 (v2/v2.md §5.2, §9, §10, §11.4).
 *
 * Thay cho các contract v1 ở chỗ v2 đổi: đối tác bắt buộc theo ID (`partner_id`), hướng khoản do người
 * dùng chọn (`direction`), KHÔNG còn tên / ngân hàng / STK nhập tự do (`party_*`, `bank_name`, `branch`).
 * Schema PATCH không dùng `.default()` để không ghi đè giá trị cũ khi thiếu trường.
 */

import { z } from 'zod';
import {
  businessDate,
  currencyCode,
  debtDirection,
  debtListQuery,
  debtSide,
  linkSplit,
  minorUnits,
  moneyField,
  objectId,
  priority,
  repaymentFrequency,
  repaymentMethod,
} from '@fingate/shared';

const minorText = z.string().regex(/^\d+$/, 'Số tiền phải là số nguyên không âm (minor units)');
/** Khoá chống gửi lặp (retry sau timeout): cùng `request_id` ⇒ trả lại bản ghi đã tạo, không tạo trùng. */
const requestId = z.string().trim().min(8, 'request_id tối thiểu 8 ký tự').max(80);
/**
 * Số tiền cho PATCH (có thể null): KHÔNG đặt `.default()` bên trong — schema JSON sinh ra có `anyOf`/null,
 * và Fastify (AJV strict) từ chối `default` trong trường như vậy. Thiếu tiền tệ ⇒ domain dùng VND.
 */
const moneyPatch = z.object({ amount_minor: minorUnits, currency: currencyCode.optional() });
const rateText = z.string().regex(/^\d+([.,]\d{1,2})?$/, 'Lãi suất tối đa 2 chữ số thập phân');
const termMonths = z.coerce.number().int().min(1, 'Kỳ hạn tối thiểu 1 tháng').max(600);

/* ------------------------------ Công nợ ------------------------------ */

/** POST /debts — đối tác + hướng bắt buộc. */
export const debtCreateBody = z.object({
  company_id: objectId.optional().describe('Mặc định theo phiên làm việc'),
  partner_id: objectId.describe('Khách hàng hoặc Nhà cung cấp đang hoạt động'),
  direction: debtDirection.describe('receivable = phải thu (đối tác nợ công ty) · payable = phải trả'),
  side: debtSide.optional().describe('Bỏ trống = suy từ hướng; nếu gửi lên phải khớp hướng'),
  value: moneyField,
  due_date: businessDate.describe('Hạn thanh toán'),
  contract_code: z.string().max(80).optional(),
  priority: priority.default('normal'),
  note: z.string().max(1000).optional(),
  request_id: requestId.optional(),
});

/** PATCH /debts/:id — mọi trường tuỳ chọn, không default. */
export const debtUpdateBody = z.object({
  partner_id: objectId.optional(),
  direction: debtDirection.optional(),
  side: debtSide.optional(),
  value: moneyPatch.optional(),
  due_date: businessDate.optional(),
  contract_code: z.string().max(80).nullable().optional(),
  priority: priority.optional(),
  note: z.string().max(1000).nullable().optional(),
});

/** POST /debts/:id/links — gán phiếu thu/chi để cấn trừ (một phiếu mỗi lần). */
export const debtOffsetBody = z.object({
  document_id: objectId,
  amount_minor: minorText.optional().describe('Bỏ trống = phần còn lại có thể phân bổ'),
  note: z.string().max(500).optional(),
});

/** Lý do gỡ liên kết — BẮT BUỘC (v2 §11.2: gỡ = đánh dấu, có người gỡ và lý do; tối thiểu 5 ký tự). */
export const unlinkBody = z.object({
  reason: z.string().trim().min(5, 'Nêu lý do gỡ liên kết (tối thiểu 5 ký tự)').max(500),
});

export const debtAgingQuery = z.object({
  party_type: z.enum(['customer', 'supplier', 'employee']).optional(),
  direction: debtDirection.optional(),
  company_id: objectId.optional(),
});

export const linkCandidatesQuery = z.object({
  q: z.string().max(200).optional(),
});

/** GET /debts — dùng lại contract danh sách của shared (đã có partner_id, direction, counterparty…). */
export { debtListQuery };

/* -------------------------- Nợ ngân hàng (khoản vay) -------------------------- */

const loanTerms = {
  maturity_date: businessDate.describe('Hạn thanh toán (đáo hạn)'),
  interest_rate: rateText.default('0'),
  currency: z.string().length(3).default('VND'),
  term_months: termMonths.optional(),
  payment_frequency: repaymentFrequency.default('maturity'),
  repayment_method: repaymentMethod.default('interest_only'),
  /** v2 §10.1: số HĐ tín dụng, TSĐB, người phụ trách (không còn ghi tạm vào ghi chú). */
  contract_no: z.string().trim().max(80).optional(),
  collateral: z.string().trim().max(1000).optional(),
  responsible: z.string().trim().max(120).optional(),
  note: z.string().max(1000).optional(),
};

/** POST /bank-debts — ngân hàng cho vay (đối tác loại Ngân hàng) bắt buộc; tạo thủ công = đã giải ngân. */
export const loanCreateBody = z.object({
  company_id: objectId.optional(),
  partner_id: objectId.describe('Ngân hàng cho vay (đối tác loại Ngân hàng)'),
  amount: moneyField.describe('Số tiền vay (gốc)'),
  credit_limit: moneyField.optional(),
  disbursed_date: businessDate.optional().describe('Ngày giải ngân (mặc định hôm nay)'),
  ...loanTerms,
  request_id: requestId.optional(),
});

/** PATCH /bank-debts/:id — không đổi trạng thái (dùng các thao tác vòng đời riêng). */
export const loanUpdateBody = z.object({
  partner_id: objectId.optional(),
  amount: moneyPatch.optional(),
  credit_limit: moneyPatch.nullable().optional(),
  maturity_date: businessDate.optional(),
  interest_rate: rateText.optional(),
  term_months: z.union([termMonths, z.null()]).optional(),
  payment_frequency: repaymentFrequency.optional(),
  repayment_method: repaymentMethod.optional(),
  contract_no: z.string().trim().max(80).nullable().optional(),
  collateral: z.string().trim().max(1000).nullable().optional(),
  responsible: z.string().trim().max(120).nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

/** Gán phiếu chi trả nợ (repayment) — tách gốc / lãi / phí tuỳ chọn. */
export const loanRepaymentBody = z.object({
  document_id: objectId,
  amount_minor: minorText.optional(),
  split: linkSplit.optional().describe('Gốc + lãi + phí = số tiền; dư nợ chỉ trừ phần gốc'),
  note: z.string().max(500).optional(),
});

/** Gán phiếu thu giải ngân (disbursement) từ phía khoản vay hoặc phía phiếu thu. */
export const loanDisbursementBody = z.object({
  document_id: objectId,
  amount_minor: minorText.optional(),
  note: z.string().max(500).optional(),
});

/** Huỷ khoản đang chờ giải ngân — bắt buộc lý do. */
export const loanCancelBody = z.object({
  reason: z.string().trim().min(5, 'Nêu lý do huỷ (tối thiểu 5 ký tự)').max(500),
});

export const loanListQuery = z.object({
  status: z.string().max(40).optional(),
  partner_id: objectId.optional(),
  company_id: objectId.optional(),
  q: z.string().max(200).optional(),
  /** `true` = chỉ tổng hợp (totals, by_bank), không trả `items`: màn đáo hạn không tải cả danh sách chỉ để cộng tổng. */
  summary: z.enum(['true', 'false']).optional(),
  /** Trang (đánh số từ 1): `items` chỉ gồm `limit` khoản của trang; `total`, `totals`, `by_bank` luôn tính trên mọi khoản khớp. */
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  /** Cỡ trang (trần 1.000: mục "Sắp giải ngân" và form đảo hạn cần đủ khoản của một lần tải, vẫn có trần). */
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});

/**
 * Một dòng nhập Excel (LOAN-05): đối tác ngân hàng chọn bằng ID hoặc MÃ (`DT-…`) — KHÔNG khớp theo tên.
 */
export const loanImportRow = z
  .object({
    partner_id: objectId.optional(),
    partner_code: z.string().trim().min(3).max(40).optional(),
    amount: moneyField,
    credit_limit: moneyField.optional(),
    ...loanTerms,
  })
  .refine((r) => Boolean(r.partner_id || r.partner_code), {
    message: 'Chọn đối tác ngân hàng: nhập partner_id hoặc partner_code (mã DT-…)',
    path: ['partner_code'],
  });

export type DebtCreateBody = z.infer<typeof debtCreateBody>;
export type DebtUpdateBody = z.infer<typeof debtUpdateBody>;
export type LoanCreateBody = z.infer<typeof loanCreateBody>;
export type LoanUpdateBody = z.infer<typeof loanUpdateBody>;
export type LoanImportRow = z.infer<typeof loanImportRow>;

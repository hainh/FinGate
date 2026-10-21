/**
 * FinGate v2 — hợp đồng Liên kết nghiệp vụ (`business_links`) — v2/v2.md §11.2, §14.2.
 *
 * Một bảng chung cho mọi quan hệ giữa hai đối tượng (phiếu, công nợ, khoản vay NH).
 * Chỉ tiêu "đã cấn trừ", "dư nợ", "còn lại" KHÔNG lưu: suy ra từ liên kết hiệu lực +
 * trạng thái phiếu (xem `linkMetrics*`).
 */

import { z } from 'zod';
import { BUSINESS_LINK_RELATIONS, LINK_OBJECT_TYPES, LINK_ORIGINS, LINK_STATUSES } from '../status/index.js';
import { minorNonNeg, objectId, uuid } from './common.js';
import { automationRuleCode } from './automation.js';

const lit = <T extends string>(arr: readonly T[]) => arr as unknown as [T, ...T[]];

export const linkObjectType = z.enum(lit(LINK_OBJECT_TYPES));
export const linkRelation = z.enum(lit(BUSINESS_LINK_RELATIONS));
export const linkOrigin = z.enum(lit(LINK_ORIGINS));
export const linkStatus = z.enum(lit(LINK_STATUSES));
export type LinkObjectTypeValue = z.infer<typeof linkObjectType>;
export type LinkRelationValue = z.infer<typeof linkRelation>;

/**
 * Tách gốc / lãi / phí trong một liên kết trả nợ (v2 §10.3). Tổng ba phần = số tiền phân bổ.
 * Dư nợ chỉ trừ phần `principal`.
 */
export const linkSplit = z.object({
  principal: minorNonNeg.default('0'),
  interest: minorNonNeg.default('0'),
  fee: minorNonNeg.default('0'),
});
export type LinkSplit = z.infer<typeof linkSplit>;

/**
 * POST /links — gán liên kết (thủ công: cần `link:manage`; tự động: do bộ máy gọi).
 * Quy tắc kiểm tra (công ty, đối tác, tổng phân bổ, trùng cặp) nằm ở domain/links.
 */
export const linkCreateBody = z
  .object({
    from_type: linkObjectType,
    from_id: objectId,
    to_type: linkObjectType,
    to_id: objectId,
    relation: linkRelation,
    amount_minor: minorNonNeg.nullable().optional().describe('Số tiền phân bổ; bỏ trống nếu có `split`'),
    split: linkSplit.nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    request_id: uuid.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.split && v.amount_minor != null) {
      const sum = BigInt(v.split.principal) + BigInt(v.split.interest) + BigInt(v.split.fee);
      if (sum !== BigInt(v.amount_minor)) {
        ctx.addIssue({ code: 'custom', path: ['amount_minor'], message: 'Tổng gốc + lãi + phí phải bằng số tiền phân bổ' });
      }
    }
    if (!v.split && v.amount_minor == null && (v.relation === 'offset' || v.relation === 'repayment' || v.relation === 'disbursement' || v.relation === 'funded_by')) {
      ctx.addIssue({ code: 'custom', path: ['amount_minor'], message: 'Quan hệ này cần số tiền phân bổ' });
    }
    if (v.from_type === v.to_type && v.from_id === v.to_id) {
      ctx.addIssue({ code: 'custom', path: ['to_id'], message: 'Không thể liên kết một đối tượng với chính nó' });
    }
  });
export type LinkCreateBody = z.infer<typeof linkCreateBody>;

/** POST /links/:id/remove — gỡ = đánh dấu, KHÔNG xoá; bắt buộc lý do. */
export const linkRemoveBody = z.object({
  reason: z.string().trim().min(5, 'Nêu lý do gỡ liên kết').max(500),
  request_id: uuid.optional(),
});
export type LinkRemoveBody = z.infer<typeof linkRemoveBody>;

/** Dòng liên kết (đọc). Tiền là chuỗi minor units. */
export const linkRow = z.object({
  _id: objectId,
  company_id: objectId,
  from_type: linkObjectType,
  from_id: objectId,
  from_code: z.string().nullable().optional(),
  to_type: linkObjectType,
  to_id: objectId,
  to_code: z.string().nullable().optional(),
  relation: linkRelation,
  amount_minor: minorNonNeg.nullable(),
  split: linkSplit.nullable(),
  origin: linkOrigin,
  run_id: objectId.nullable(),
  rule_code: automationRuleCode.nullable().optional(),
  status: linkStatus,
  note: z.string().nullable(),
  created_by: objectId.nullable(),
  created_at: z.string(),
  removed_by: objectId.nullable(),
  removed_at: z.string().nullable(),
  removed_reason: z.string().nullable(),
});
export type LinkRow = z.infer<typeof linkRow>;

/** GET /links?object_type=&object_id= — mọi liên kết có đối tượng ở một đầu. */
export const linkListQuery = z.object({
  object_type: linkObjectType,
  object_id: objectId,
  include_removed: z.enum(['true', 'false']).optional(),
  scope: z.string().max(64).optional(),
});
export type LinkListQuery = z.infer<typeof linkListQuery>;

/**
 * Chỉ tiêu suy ra (không lưu). `*_minor` là chuỗi minor units.
 * - phiếu: `allocated_minor` = Σ phân bổ liên kết hiệu lực từ phiếu; `remaining_minor` = số tiền − allocated.
 * - công nợ: `offset_applied_minor` = Σ cấn trừ từ phiếu đã thực thi; `remaining_minor` = giá trị − đã cấn trừ.
 * - khoản vay: `repaid_principal_minor` = Σ gốc trả từ phiếu đã thực thi; `outstanding_minor` = gốc − đã trả (0 nếu chờ giải ngân / đã huỷ).
 */
export const linkMetricsDocument = z.object({
  object_type: z.literal('document'),
  object_id: objectId,
  amount_minor: minorNonNeg,
  allocated_minor: minorNonNeg,
  remaining_minor: minorNonNeg,
});
export const linkMetricsDebt = z.object({
  object_type: z.literal('debt_voucher'),
  object_id: objectId,
  value_minor: minorNonNeg,
  offset_applied_minor: minorNonNeg,
  remaining_minor: minorNonNeg,
});
export const linkMetricsLoan = z.object({
  object_type: z.literal('bank_debt'),
  object_id: objectId,
  principal_minor: minorNonNeg,
  repaid_principal_minor: minorNonNeg,
  outstanding_minor: minorNonNeg,
});
export const linkMetrics = z.discriminatedUnion('object_type', [linkMetricsDocument, linkMetricsDebt, linkMetricsLoan]);
export type LinkMetrics = z.infer<typeof linkMetrics>;

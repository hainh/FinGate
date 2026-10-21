/**
 * Hợp đồng API của màn Đối tác KHÔNG có trong packages/shared: danh sách có tóm tắt + phân trang,
 * tham số các tab chi tiết, và body "Trả nợ". Hợp đồng dùng chung (tạo / sửa / sao chép / ô chọn)
 * nằm ở packages/shared/src/contracts/partners.ts và được dùng nguyên.
 */

import { z } from 'zod';
import { businessDate, businessDateTime, linkSplit, objectId, PARTNER_TYPES, uuid, type PartnerType } from '@fingate/shared';

const partnerType = z.enum(PARTNER_TYPES as unknown as [PartnerType, ...PartnerType[]]);

/**
 * Chuẩn hoá tham số loại từ query: `type=bank,customer` hoặc `type=bank&type=customer` → mảng.
 * Trả `undefined` khi không có tham số (không lọc).
 */
export function parseTypeParam(v: unknown): string[] | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const parts = (Array.isArray(v) ? v : [v])
    .flatMap((x) => String(x).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

/** GET /partners — danh sách màn Đối tác (lọc, tìm, phân trang, kỳ tính thu/chi). */
export const partnerDirectoryQuery = z
  .object({
    company_id: objectId.optional(),
    type: z.array(partnerType).min(1).optional(),
    status: z.enum(['active', 'inactive', 'all']).default('all'),
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
    period_from: businessDate.optional().describe('Đầu kỳ thu/chi (mặc định: ngày 1 tháng hiện tại)'),
    period_to: businessDate.optional().describe('Cuối kỳ thu/chi (mặc định: hôm nay)'),
  })
  .superRefine((v, ctx) => {
    if (v.period_from && v.period_to && v.period_from > v.period_to) {
      ctx.addIssue({ code: 'custom', path: ['period_to'], message: 'Cuối kỳ phải sau đầu kỳ' });
    }
  });
export type PartnerDirectoryQuery = z.infer<typeof partnerDirectoryQuery>;

/** GET /partners/:id/documents|debts|loans — lọc đơn giản theo trạng thái / loại phiếu. */
export const partnerTabQuery = z.object({
  status: z.string().trim().max(40).optional(),
  kind: z.enum(['spend', 'income']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type PartnerTabQuery = z.infer<typeof partnerTabQuery>;

const minorPositive = z.string().regex(/^[1-9]\d*$/, 'Số tiền phải là số nguyên lớn hơn 0 (minor units)');

export const settleDebtItem = z.object({
  debt_voucher_id: objectId,
  amount_minor: minorPositive,
});

export const settleLoanItem = z.object({
  bank_debt_id: objectId,
  amount_minor: minorPositive,
  /** tách gốc / lãi / phí (tổng = số tiền); bỏ trống ⇒ toàn bộ là gốc (dư nợ giảm đủ số tiền) */
  split: linkSplit.nullable().optional(),
});

/**
 * POST /partners/:id/settle — "Trả nợ": chọn khoản + số tiền phân bổ → phiếu nháp + liên kết.
 * KH/NCC dùng `items`; Ngân hàng dùng `loans`. Hai hướng ⇒ hai phiếu (thu + chi).
 */
export const partnerSettleBody = z
  .object({
    request_id: uuid.optional(),
    business_date: businessDate.optional(),
    planned_date: businessDateTime.optional(),
    receipt_account_id: objectId.nullable().optional().describe('Tài khoản nhận tiền của phiếu thu (nếu có)'),
    payment_account_id: objectId.nullable().optional().describe('Tài khoản chi của phiếu chi (nếu có)'),
    note: z.string().max(2000).nullable().optional(),
    items: z.array(settleDebtItem).max(100).default([]),
    loans: z.array(settleLoanItem).max(100).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.items.length + v.loans.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Chọn ít nhất một khoản để trả' });
    }
    const debtIds = v.items.map((i) => i.debt_voucher_id);
    if (new Set(debtIds).size !== debtIds.length) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Mỗi khoản công nợ chỉ chọn một lần' });
    }
    const loanIds = v.loans.map((i) => i.bank_debt_id);
    if (new Set(loanIds).size !== loanIds.length) {
      ctx.addIssue({ code: 'custom', path: ['loans'], message: 'Mỗi khoản vay chỉ chọn một lần' });
    }
    v.loans.forEach((l, idx) => {
      if (!l.split) return;
      const sum = BigInt(l.split.principal) + BigInt(l.split.interest) + BigInt(l.split.fee);
      if (sum !== BigInt(l.amount_minor)) {
        ctx.addIssue({ code: 'custom', path: ['loans', idx, 'split'], message: 'Tổng gốc + lãi + phí phải bằng số tiền trả' });
      }
    });
  });
export type PartnerSettleBody = z.infer<typeof partnerSettleBody>;

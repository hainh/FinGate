/**
 * FinGate v2 — hợp đồng Đối tác (danh bạ theo CÔNG TY) — v2/v2.md §5, §14.2.
 *
 * Định danh duy nhất là `_id` (mã `DT-…` tự sinh). Tên / ngân hàng / STK / MST chỉ là
 * thông tin hiển thị, KHÔNG dùng để nhận diện. Trùng tên hoặc (ngân hàng, STK) chỉ
 * CẢNH BÁO (`partnerDuplicateWarning`), không chặn lưu.
 */

import { z } from 'zod';
import { PARTNER_STATUSES, PARTNER_TYPES } from '../status/index.js';
import { businessDate, moneyWire, objectId, uuid } from './common.js';

const lit = <T extends string>(arr: readonly T[]) => arr as unknown as [T, ...T[]];

export const partnerType = z.enum(lit(PARTNER_TYPES));
export const partnerStatus = z.enum(lit(PARTNER_STATUSES));
export type PartnerTypeValue = z.infer<typeof partnerType>;
export type PartnerStatusValue = z.infer<typeof partnerStatus>;

/** Các trường nhập được của đối tác (v2 §5.1). Ngân hàng/STK/MST không bắt buộc với mọi loại. */
const partnerFields = z.object({
  type: partnerType,
  name: z.string().trim().min(2, 'Tên đối tác tối thiểu 2 ký tự').max(200),
  bank_name: z.string().trim().max(200).nullable().optional(),
  account_number: z.string().trim().max(40).nullable().optional(),
  tax_code: z.string().trim().max(20).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

/** POST /partners — tạo đối tác (popup "+ Tạo đối tác" dùng chung body này). `request_id`: chống ghi đúp (replay). */
export const partnerCreateBody = partnerFields.extend({
  company_id: objectId.optional().describe('Mặc định theo phiên làm việc'),
  status: partnerStatus.default('active'),
  /** Chỉ với loại `internal`: công ty trong tập đoàn và TK ngân hàng của công ty đó (tên/NH/STK lấy từ TK). */
  internal_company_id: objectId.nullable().optional(),
  internal_account_id: objectId.nullable().optional(),
  request_id: uuid.optional(),
});
export type PartnerCreateBody = z.infer<typeof partnerCreateBody>;

/**
 * POST /partners/check-duplicates — kiểm tra trùng TRƯỚC khi lưu (popup, debounce). Chỉ đọc, không chặn.
 * `exclude_id`: đối tác đang sửa (không tự báo trùng với chính nó).
 */
export const partnerDuplicateCheckBody = z.object({
  company_id: objectId.optional().describe('Mặc định theo phiên làm việc'),
  name: z.string().trim().max(200).default(''),
  bank_name: z.string().trim().max(200).nullable().optional(),
  account_number: z.string().trim().max(40).nullable().optional(),
  exclude_id: objectId.nullable().optional(),
});
export type PartnerDuplicateCheckBody = z.infer<typeof partnerDuplicateCheckBody>;

/** PATCH /partners/:id — sửa bất cứ lúc nào; đổi `type` có thể bị chặn (FG-PARTNER-003). */
export const partnerUpdateBody = partnerFields.partial().extend({
  status: partnerStatus.optional(),
  request_id: uuid.optional(),
});
export type PartnerUpdateBody = z.infer<typeof partnerUpdateBody>;

/** Cảnh báo trùng (không chặn) — trả kèm kết quả lưu. */
export const partnerDuplicateWarning = z.object({
  reason: z.enum(['name', 'bank_account']),
  partner_id: objectId,
  partner_code: z.string(),
  partner_name: z.string(),
  partner_type: partnerType,
  message: z.string(),
});
export type PartnerDuplicateWarning = z.infer<typeof partnerDuplicateWarning>;

/** Tham chiếu gọn để hiển thị chỉ đọc dưới ô chọn đối tác (v2 §5.2). */
export const partnerRef = z.object({
  _id: objectId,
  code: z.string(),
  type: partnerType,
  name: z.string(),
  bank_name: z.string().nullable(),
  account_number: z.string().nullable(),
  tax_code: z.string().nullable(),
  status: partnerStatus,
});
export type PartnerRef = z.infer<typeof partnerRef>;

/** Kết quả tạo/sửa: đối tác + cảnh báo trùng (có thể rỗng). */
export const partnerSaveResult = z.object({
  partner: partnerRef,
  warnings: z.array(partnerDuplicateWarning).default([]),
});

/**
 * GET /partners/options — ô chọn đối tác: tìm theo tên / STK / MST, lọc sẵn theo loại
 * hợp lệ của chỗ đang dùng (VD khoản nợ NH chỉ `bank`).
 */
export const partnerSearchQuery = z.object({
  company_id: objectId.optional(),
  scope: z.string().max(64).optional(),
  type: z.union([partnerType, z.array(partnerType).min(1)]).optional(),
  status: partnerStatus.optional(),
  q: z.string().max(200).optional(),
  // trần 1000: màn nhập lô khoản vay cần đủ mọi ngân hàng đang hoạt động để kiểm mã (không chỉ 200 đầu)
  limit: z.coerce.number().int().min(1).max(1000).default(20),
  /**
   * Tra ĐÚNG các mã đối tác (CSV, khớp mã chính xác): kiểm mã của một lô nhập mà không phụ thuộc trần `limit`
   * (công ty có hơn 1.000 ngân hàng thì mã ngoài 1.000 đầu vẫn tra được). Tối đa 1.000 mã.
   */
  codes: z.string().max(12_000).optional(),
});
export type PartnerSearchQuery = z.infer<typeof partnerSearchQuery>;

/**
 * Dòng danh sách màn Đối tác (v2 §5.3): KH/NCC → còn phải thu, còn phải trả, quá hạn;
 * NH → dư nợ, đáo hạn gần nhất; tổng thu/chi đã thực thi trong kỳ.
 */
export const partnerSummaryRow = partnerRef.extend({
  company_id: objectId,
  company_name: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  receivable_remaining: moneyWire.nullable().describe('KH/NCC — còn phải thu'),
  payable_remaining: moneyWire.nullable().describe('KH/NCC — còn phải trả'),
  overdue_amount: moneyWire.nullable().describe('KH/NCC — quá hạn'),
  outstanding: moneyWire.nullable().describe('NH — dư nợ'),
  next_maturity_date: businessDate.nullable().describe('NH — đáo hạn gần nhất'),
  paid_in_period: moneyWire.nullable().describe('Tổng thu đã thực thi trong kỳ'),
  paid_out_period: moneyWire.nullable().describe('Tổng chi đã thực thi trong kỳ'),
  /** Đã phát sinh (phiếu / công nợ / nợ NH) → không xoá được, chỉ ngừng giao dịch. */
  has_activity: z.boolean(),
  updated_at: z.string(),
});
export type PartnerSummaryRow = z.infer<typeof partnerSummaryRow>;

/** Một mục lịch sử đối tác: ai, khi nào, trước → sau từng trường (v2 §5.1). */
export const partnerHistoryEntry = z.object({
  at: z.string(),
  actor: z.object({ user_id: objectId.nullable(), name: z.string().nullable().optional() }),
  changes: z.record(z.string(), z.object({ from: z.unknown(), to: z.unknown() })),
});
export type PartnerHistoryEntry = z.infer<typeof partnerHistoryEntry>;

/** GET /partners/:id — chi tiết (tab Phiếu, Công nợ, Nợ NH, Lịch sử). */
export const partnerDetail = partnerSummaryRow.extend({
  history: z.array(partnerHistoryEntry),
});

/** POST /partners/copy — sao chép đối tác từ công ty khác (tạo bản sao MỚI, ID riêng). */
export const partnerCopyBody = z.object({
  source_company_id: objectId,
  partner_ids: z.array(objectId).min(1).max(200),
  target_company_id: objectId.optional().describe('Mặc định theo phiên làm việc'),
  request_id: uuid.optional(),
});
export type PartnerCopyBody = z.infer<typeof partnerCopyBody>;

export const partnerCopyResult = z.object({
  created: z.array(
    z.object({
      source_id: objectId,
      partner_id: objectId,
      code: z.string(),
      name: z.string(),
    }),
  ),
  warnings: z.array(partnerDuplicateWarning),
});

/** POST /partners/:id/merge — gộp đối tác `:id` (nguồn, bị xoá) vào `target_id` (đích, giữ lại). Cùng công ty, cùng loại. */
export const partnerMergeBody = z.object({
  target_id: objectId.describe('Đối tác đích — giữ lại; cùng công ty và cùng loại với đối tác nguồn'),
  /** Chống ghi đúp: một lần mở hộp thoại dùng MỘT request_id (bấm lặp / gửi lại trả lại kết quả cũ). */
  request_id: uuid.optional(),
});
export type PartnerMergeBody = z.infer<typeof partnerMergeBody>;

export const partnerMergeResult = z.object({
  partner: partnerRef,
  /** Số tham chiếu đã chuyển sang đối tác đích, theo loại. */
  moved: z.object({
    documents: z.number().int().nonnegative(),
    lender_documents: z.number().int().nonnegative(),
    debt_vouchers: z.number().int().nonnegative(),
    bank_debts: z.number().int().nonnegative(),
    recurring_rules: z.number().int().nonnegative(),
  }),
});
export type PartnerMergeResult = z.infer<typeof partnerMergeResult>;

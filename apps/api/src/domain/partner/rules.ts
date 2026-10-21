/**
 * Quy tắc THUẦN của đối tác (v2/v2.md §5.1, §14.3) — không chạm DB, kiểm thử được.
 *
 * - Ảnh chụp các trường theo dõi (`snapshotOf`) và so sánh trước → sau (`diffSnapshots`) để
 *   ghi `history[]`: mọi lần sửa ghi ai, khi nào, trường nào đổi từ đâu sang đâu.
 * - Kiểm tra bản ghi (`validatePartnerRecord`): KH/NCC có số tài khoản thì bắt buộc có ngân hàng.
 */

import { ApiError, PARTNER_TYPES, type PartnerType } from '@fingate/shared';

/** Các trường được ghi vào lịch sử khi đổi (định danh `_id`/`code` không đổi nên không theo dõi). */
export const PARTNER_TRACKED_FIELDS = ['type', 'name', 'bank_name', 'account_number', 'tax_code', 'note', 'status'] as const;
export type PartnerTrackedField = (typeof PARTNER_TRACKED_FIELDS)[number];

/** Ảnh chụp đã chuẩn hoá: chuỗi đã cắt khoảng trắng, rỗng ⇒ null. */
export type PartnerSnapshot = Record<PartnerTrackedField, string | null>;

export interface FieldChange {
  from: string | null;
  to: string | null;
}

/** `{ field: {from, to} }` — chỉ các trường thực sự đổi (v2 §5.1). */
export type PartnerChanges = Partial<Record<PartnerTrackedField, FieldChange>>;

/** Chuẩn hoá một trường văn bản: cắt khoảng trắng; chuỗi rỗng / null / undefined ⇒ null. */
export function cleanText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Ảnh chụp đã chuẩn hoá từ bản ghi (lean), dữ liệu nhập hoặc một phần dữ liệu. */
export function snapshotOf(src: Partial<Record<PartnerTrackedField, unknown>>): PartnerSnapshot {
  return {
    type: cleanText(src.type),
    name: cleanText(src.name),
    bank_name: cleanText(src.bank_name),
    account_number: cleanText(src.account_number),
    tax_code: cleanText(src.tax_code),
    note: cleanText(src.note),
    status: cleanText(src.status),
  };
}

/** So hai ảnh chụp, trả về các trường đổi `{field: {from, to}}`. Rỗng ⇒ không ghi lịch sử. */
export function diffSnapshots(before: PartnerSnapshot, after: PartnerSnapshot): PartnerChanges {
  const changes: PartnerChanges = {};
  for (const f of PARTNER_TRACKED_FIELDS) {
    if (before[f] !== after[f]) changes[f] = { from: before[f], to: after[f] };
  }
  return changes;
}

/** Ghi nhận khi TẠO: mọi trường có giá trị đi từ `null` → giá trị. */
export function creationChanges(after: PartnerSnapshot): PartnerChanges {
  const changes: PartnerChanges = {};
  for (const f of PARTNER_TRACKED_FIELDS) {
    if (after[f] !== null) changes[f] = { from: null, to: after[f] };
  }
  return changes;
}

/**
 * Kiểm tra bản ghi sau khi gộp (thuần). Trả về `{field: thông điệp}` hoặc null nếu hợp lệ.
 * - Tên tối thiểu 2 ký tự.
 * - Loại Khách hàng / Nhà cung cấp có số tài khoản ⇒ phải có ngân hàng (v2 §5.1: "Bắt buộc với KH/NCC khi có chuyển khoản").
 */
export function validatePartnerRecord(next: PartnerSnapshot): Record<string, string> | null {
  const errors: Record<string, string> = {};
  if (!next.name || next.name.length < 2) errors.name = 'Tên đối tác tối thiểu 2 ký tự';
  if (!next.type || !(PARTNER_TYPES as readonly string[]).includes(next.type)) errors.type = 'Chọn loại đối tác';
  if (next.type !== 'bank' && next.account_number && !next.bank_name) {
    errors.bank_name = 'Nhập ngân hàng khi có số tài khoản';
  }
  return Object.keys(errors).length ? errors : null;
}

/** Ném `FG-VAL-001` kèm chi tiết từng trường nếu bản ghi không hợp lệ. */
export function assertValidPartnerRecord(next: PartnerSnapshot): void {
  const errors = validatePartnerRecord(next);
  if (errors) {
    throw new ApiError({ code: 'FG-VAL-001', detail: Object.values(errors)[0], errors });
  }
}

/** Ép kiểu loại đối tác khi đã biết giá trị hợp lệ (dùng sau validate). */
export function asPartnerType(v: string | null): PartnerType {
  if (v && (PARTNER_TYPES as readonly string[]).includes(v)) return v as PartnerType;
  throw new ApiError({ code: 'FG-VAL-001', errors: { type: 'Chọn loại đối tác' } });
}

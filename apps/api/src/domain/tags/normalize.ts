/**
 * Tag — hàm THUẦN (không chạm DB): chuẩn hoá tên, thay id trong danh sách tag của phiếu,
 * diff trường để ghi audit, nhóm theo tên chuẩn hoá cho báo cáo hợp nhất (v2 §6.2).
 *
 * Tách riêng để test bằng vitest mà không cần MongoDB.
 */

import { ApiError, normalizeNameKey } from '@fingate/shared';

/** Độ dài tối đa tên tag (khớp `tagName` trong contracts/tags.ts). */
export const TAG_NAME_MAX = 40;

/** Số tag tối đa gắn một phiếu (khớp `documentFields.tag_ids`). */
export const TAG_MAX_PER_DOCUMENT = 50;

export const OBJECT_ID_RE = /^[0-9a-f]{24}$/;

/** Ký tự vô hình hay dính khi copy/paste (ZWSP, ZWNJ, ZWJ, BOM) — bỏ trước khi chuẩn hoá. */
const INVISIBLE_RE = /[\u200B-\u200D\uFEFF]/g;

export interface NormalizedTagName {
  /** Tên hiển thị: NFC, gộp khoảng trắng còn một, bỏ đầu/cuối. */
  name: string;
  /** Khoá chống trùng = `normalizeNameKey` (thêm lowercase). Giữ nguyên dấu tiếng Việt. */
  name_key: string;
}

/**
 * Chuẩn hoá tên tag nhập tay: bỏ ký tự vô hình, NFC, gộp khoảng trắng (kể cả NBSP),
 * trim, kiểm tra không rỗng & ≤ 40 ký tự. Không phân biệt hoa thường; KHÔNG bỏ dấu
 * (`Dự án` ≠ `Du an` vì là hai cụm từ khác nhau).
 */
export function normalizeTagName(raw: unknown): NormalizedTagName {
  const name = String(raw ?? '')
    .replace(INVISIBLE_RE, '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Tên tag không được để trống', errors: { name: 'Tên tag không được để trống' } });
  }
  if (name.length > TAG_NAME_MAX) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: `Tên tag tối đa ${TAG_NAME_MAX} ký tự`,
      errors: { name: `Tên tag tối đa ${TAG_NAME_MAX} ký tự` },
    });
  }
  return { name, name_key: normalizeNameKey(name) };
}

/**
 * Thay `fromId` bằng `toId` trong danh sách id, KHÔNG trùng lặp, giữ thứ tự.
 * Nếu `toId` đã có sẵn thì chỉ bỏ `fromId`. Danh sách trùng sẵn (dữ liệu cũ) cũng được gộp.
 */
export function replaceTagIds(ids: readonly string[], fromId: string, toId: string): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw === fromId ? toId : raw;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export interface FieldChange {
  from: unknown;
  to: unknown;
}

/**
 * Các trường thực sự đổi (`before` → `after`) để ghi audit / lịch sử. Bỏ qua khoá có giá trị
 * `undefined` trong `after` (không yêu cầu đổi).
 */
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, FieldChange> {
  const out: Record<string, FieldChange> = {};
  for (const [key, to] of Object.entries(after)) {
    if (to === undefined) continue;
    const from = before[key];
    if (from !== to) out[key] = { from: from ?? null, to };
  }
  return out;
}


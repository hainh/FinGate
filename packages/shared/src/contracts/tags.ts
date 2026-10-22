/**
 * FinGate v2 — hợp đồng Tag (nhãn tự do gắn phiếu thu/chi) — v2/v2.md §6.2, §14.2.
 *
 * Tag thuộc danh bạ TAG của từng công ty (không dùng chung tập đoàn). Chống trùng theo
 * `name_key` (bỏ khoảng trắng thừa, không phân biệt hoa thường). Khác "Danh mục": tag
 * không quyết định chứng từ bắt buộc hay ma trận duyệt.
 */

import { z } from 'zod';
import { objectId } from './common.js';

/** Màu tag dạng #RRGGBB (DS: token trung tính, không nhúng màu ngữ nghĩa). Mặc định: `TAG_COLOR_DEFAULT` (status/). */
export const TAG_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Tên tag: bỏ khoảng trắng đầu/cuối, tối đa 40 ký tự. */
export const tagName = z
  .string()
  .trim()
  .min(1, 'Tên tag không được để trống')
  .max(40, 'Tên tag tối đa 40 ký tự');

/** POST /tags — tạo tag (cần `tag:create`; cũng dùng cho "+ Tạo tag …" ngay trên phiếu). */
export const tagCreateBody = z.object({
  company_id: objectId.optional().describe('Mặc định theo phiên làm việc'),
  name: tagName,
  color: z.string().regex(TAG_COLOR_RE, 'Màu phải dạng #RRGGBB').optional(),
});
export type TagCreateBody = z.infer<typeof tagCreateBody>;

/** PATCH /tags/:id — đổi tên / màu / ẩn (cần `tag:manage`). Sửa được cả sau khi duyệt, có lịch sử. */
export const tagUpdateBody = z
  .object({
    name: tagName.optional(),
    color: z.string().regex(TAG_COLOR_RE, 'Màu phải dạng #RRGGBB').optional(),
    hidden: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined || v.hidden !== undefined, 'Không có trường nào để cập nhật');
export type TagUpdateBody = z.infer<typeof tagUpdateBody>;

/** POST /tags/merge — gộp `source` vào `target`: mọi phiếu có `source` chuyển sang `target` (cần `tag:manage`). */
export const tagMergeBody = z
  .object({
    source_id: objectId,
    target_id: objectId,
  })
  .refine((v) => v.source_id !== v.target_id, 'Phải chọn hai tag khác nhau');
export type TagMergeBody = z.infer<typeof tagMergeBody>;

/** Dòng tag: `usage_count` = số phiếu đang gắn tag. */
export const tagRow = z.object({
  _id: objectId,
  company_id: objectId,
  name: z.string(),
  color: z.string(),
  hidden: z.boolean(),
  usage_count: z.number().int().min(0),
  updated_at: z.string(),
});
export type TagRow = z.infer<typeof tagRow>;

/**
 * GET /tags — gợi ý khi gõ / danh bạ; mặc định ẩn tag đã ẩn. Sắp theo tên chuẩn hoá; trang tiếp theo
 * lấy bằng `offset` (+ `limit` ≤ 500). Phản hồi `total` = số dòng khớp bộ lọc (không tính phân trang).
 */
export const tagListQuery = z.object({
  company_id: objectId.optional(),
  scope: z.string().max(64).optional(),
  q: z.string().max(200).optional(),
  include_hidden: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
export type TagListQuery = z.infer<typeof tagListQuery>;

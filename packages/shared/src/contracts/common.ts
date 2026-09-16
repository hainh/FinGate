/**
 * FinGate — các schema chung (Zod 4 là nguồn duy nhất cho FE + BE + OpenAPI — ADR-08)
 */

import { z } from 'zod';
import { ACTIONS, DOC_KINDS, EVIDENCE_TYPES, ROLES, STATUS_KEYS } from '../status/index.js';
import { CURRENCY_CODES } from '../money/index.js';

/** ObjectId dạng hex 24. */
export const objectId = z.string().regex(/^[0-9a-f]{24}$/, 'Mã định dạng không hợp lệ');
export const idString = z.string().min(1).max(64);

/** UUID cho request_id (idempotency — architecture §6). */
export const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'request_id phải là UUID');

/** Ngày nghiệp vụ `YYYY-MM-DD` (giờ VN) — khác `*_at` UTC (architecture §16). */
export const businessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày phải theo định dạng YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Ngày không hợp lệ');

/** version của document, dùng cho ETag / If-Match. */
export const docVersion = z.coerce.number().int().min(0);

/** Tiền trên wire là STRING minor units (§8.5). Chấp nhận number nguyên cho tiện. */
export const minorUnits = z.union([z.string().regex(/^-?\d+$/), z.number().int()]);

const litCur = <T extends string>(arr: readonly T[]) => arr as unknown as [T, ...T[]];
export const currencyCode = z.enum(litCur(CURRENCY_CODES));

export const moneyWire = z
  .object({
    minor: minorUnits.describe('Minor units — trên wire là string'),
    currency: currencyCode.default('VND'),
    decimals: z.number().int().min(0).max(4).default(0),
  })
  .describe('Số tiền lưu theo minor units');

export type MoneyWire = z.infer<typeof moneyWire>;

/** Tiền dạng phẳng cho form tạo/sửa phiếu. */
export const moneyField = z.object({
  amount_minor: minorUnits.describe('Minor units, string'),
  currency: currencyCode.default('VND'),
});

/** z.enum cần mảng không rỗng; giữ literal type bằng cách cast sang tuple của chính T. */
const lit = <T extends string>(arr: readonly T[]) => arr as unknown as [T, ...T[]];

export const statusKey = z.enum(lit(STATUS_KEYS));
export const docKind = z.enum(lit(DOC_KINDS));
export const evidenceType = z.enum(lit(EVIDENCE_TYPES));
export const roleEnum = z.enum(lit(ROLES));
export const actionEnum = z.enum(lit(ACTIONS));

export const paginatedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  sort: z.string().max(60).optional(),
  q: z.string().max(200).optional(),
});

export type PaginatedQuery = z.infer<typeof paginatedQuery>;

export interface Page<T> {
  items: T[];
  total?: number;
  next_cursor?: string | null;
  limit: number;
  page?: number;
}

export const scopeQuery = z.object({
  /** `all` hoặc company id. Mặc định theo phiên làm việc (header `x-company-scope`). */
  scope: z.string().max(64).optional(),
});

export const idParam = z.object({ id: idString });

/** problem+json — khai báo cho OpenAPI (architecture §6). */
export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string().optional(),
  trace_id: z.string().optional(),
  errors: z.record(z.string(), z.string()).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Zod → JSON Schema draft-7 cho Fastify/AJV + @fastify/swagger.
 * `io: 'input'` để `.default()` được áp dụng khi validate request.
 */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

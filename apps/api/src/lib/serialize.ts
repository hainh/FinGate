/**
 * Trả lời HTTP an toàn cho tiền + cache (architecture §6, §8.3, §14).
 *
 * - `jsonSafe`: BigInt → string. Tiền trên wire LUÔN là string (§8.5) — hàm này là chỗ
 *   duy nhất chuyển đổi, để không có route nào quên và làm sập JSON.stringify.
 * - `ok`: LUÔN `Cache-Control: private, no-store` — cache HTTP bị TẮT toàn hệ thống để
 *   mọi màn hình đọc dữ liệu tươi ngay sau thao tác (tạo/sửa/xoá). Các option `maxAge`/
 *   `etag`/`staleWhileRevalidate` vẫn nhận cho tương thích nhưng KHÔNG còn tác dụng.
 * - `noValidator`: JSON Schema chỉ dùng cho OpenAPI; validation thật do zod đảm nhận
 *   (một nguồn schema — ADR-08).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ProblemJson } from '@fingate/shared';

export function jsonSafe<T>(value: T, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  // ObjectId (bson) từ `.lean()` — JSON.stringify mặc định sẽ thành {i0,i1,...}
  if (typeof (value as unknown as { toHexString?: unknown }).toHexString === 'function')
    return (value as unknown as { toHexString(): string }).toHexString();
  if (seen.has(value as object)) return null; // vòng lặp (mongoose) — cắt
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => jsonSafe(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === '__v' || k === '$session') continue;
    out[k] = jsonSafe(v, seen);
  }
  return out;
}

export interface OkOptions {
  /** @deprecated Cache HTTP đã tắt toàn hệ thống — không còn tác dụng. */
  etag?: string | number;
  /** @deprecated Cache HTTP đã tắt toàn hệ thống — không còn tác dụng. */
  maxAge?: number;
  status?: number;
  /** @deprecated Cache HTTP đã tắt toàn hệ thống — không còn tác dụng. */
  staleWhileRevalidate?: number;
}

export function ok(reply: FastifyReply, data: unknown, opts: OkOptions = {}): FastifyReply {
  // Cache HTTP TẮT toàn hệ thống: không để browser/proxy giữ dữ liệu tài chính cũ.
  reply.header('Cache-Control', 'private, no-store');
  return reply.code(opts.status ?? 200).send(jsonSafe(data));
}

export function problem(reply: FastifyReply, problem: ProblemJson): FastifyReply {
  return reply.header('Cache-Control', 'private, no-store').code(problem.status).type('application/problem+json').send(problem);
}

/** So `If-Match` với version hiện tại; thiếu header → 428-style 409 theo arch §6. */
export function checkIfMatch(ifMatch: string | undefined, version: number): void {
  if (!ifMatch) return; // FE luôn gửi; thiếu thì CAS vẫn chặn (if_match ở body là bắt buộc theo schema)
  const token = ifMatch.replace(/^W\//, '').replace(/"/g, '');
  if (token !== String(version)) {
    // để service ném FG-WF-011 thống nhất — chỉ log
    console.warn(`[etag] If-Match ${token} ≠ version ${version}`);
  }
}

export function noValidator(instance: FastifyInstance): void {
  // JSON Schema để cho @fastify/swagger; zod validate trong handler (validate())
  instance.setValidatorCompiler(() => {
    return (data: unknown) => ({ value: data });
  });
}

/** Đọc header scope của request (FgScopeSwitcher) — server vẫn kiểm tra quyền. */
export function scopeHeaderOf(headers: Record<string, unknown> | undefined): string | undefined {
  const h = headers?.['x-company-scope'];
  return typeof h === 'string' && h ? h : undefined;
}

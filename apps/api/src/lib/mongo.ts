/**
 * Kết nối MongoDB + helper query có tenant scope.
 *
 * `scoped*` là con ĐƯỜNG DUY NHẤT để query dữ liệu đa công ty: mọi helper tự thêm
 * `{ company_id: { $in: scope } }` (architecture §7.5). Model.find trực tiếp bị lint
 * `fg/no-raw-model-find` chặn ngoài file này.
 */

import mongoose, { type Model } from 'mongoose';

/** Filter theo kiểu của mongoose 9 — giữ `unknown` để không phụ thuộc tên type nội bộ. */
type AnyFilter = Record<string, unknown>;
import { getEnv } from '../env.ts';
import { ApiError } from '@fingate/shared';

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDb(uri?: string): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting) return connecting;
  const env = getEnv();
  const target = uri ?? env.MONGODB_URI;
  connecting = mongoose
    .connect(target, {
      maxPoolSize: 10, // trần connection của Atlas M0 — arch §3.3
      serverSelectionTimeoutMS: 8_000,
      socketTimeoutMS: 20_000,
      retryWrites: true,
      writeConcern: { w: 'majority' },
    })
    .then((m) => {
      connecting = null;
      return m;
    })
    .catch((err: unknown) => {
      connecting = null;
      throw err;
    });
  return connecting;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function dbUp(): boolean {
  return mongoose.connection.readyState === 1;
}

export function dbName(): string {
  return mongoose.connection.name || 'fingate';
}

/* ------------------------------------------------------------------ *
 * Tenant scope
 * ------------------------------------------------------------------ */

export interface Scope {
  /** null = toàn tập đoàn (chairman/admin hoặc `scope=all`). */
  companyIds: string[] | null;
}

export const ALL_COMPANIES: Scope = { companyIds: null };

export function scopeFilter(scope: Scope, field = 'company_id'): Record<string, unknown> {
  if (scope.companyIds === null) return {};
  if (scope.companyIds.length === 0) return { [field]: { $in: [] } }; // không có công ty nào → rỗng
  if (scope.companyIds.length === 1) return { [field]: scope.companyIds[0] };
  return { [field]: { $in: scope.companyIds } };
}

/** Ghép filter của caller với tenant scope. Caller KHÔNG thể vượt scope. */
export function withScope<T extends Record<string, unknown>>(scope: Scope, filter: T, field = 'company_id'): T & Record<string, unknown> {
  const sf = scopeFilter(scope, field);
  if (Object.keys(sf).length === 0) return { ...filter };
  // nếu caller đã chỉ định company_id thì phải nằm trong scope
  const requested = (filter as Record<string, unknown>)[field];
  if (requested !== undefined && scope.companyIds !== null) {
    const ids = scope.companyIds;
    const list = Array.isArray(requested) ? requested : [requested];
    for (const id of list) {
      if (!ids.includes(String(id))) throw new ApiError({ code: 'FG-RBAC-002' });
    }
  }
  return { ...filter, ...sf };
}

/* ------------------------------------------------------------------ *
 * Query helpers (duy nhất được phép chạm Model.*)
 * ------------------------------------------------------------------ */

export interface FindOptions {
  projection?: Record<string, 0 | 1>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

export async function scopedFind<T>(
  model: unknown,
  scope: Scope,
  filter: AnyFilter,
  opts: FindOptions = {},
): Promise<T[]> {
  const f = withScope(scope, filter) as unknown as Parameters<Model<T>['find']>[0];
  let q = (model as Model<T>).find(f);
  if (opts.projection) q = q.select(opts.projection);
  if (opts.sort) q = q.sort(opts.sort);
  if (opts.limit) q = q.limit(opts.limit);
  if (opts.skip) q = q.skip(opts.skip);
  return q.lean<T[]>().exec();
}

export async function scopedCount<T = unknown>(model: unknown, scope: Scope, filter: AnyFilter = {}): Promise<number> {
  const f = withScope(scope, filter) as unknown as Parameters<Model<T>['countDocuments']>[0];
  return (model as Model<T>).countDocuments(f).exec();
}

export async function scopedOne<T>(model: unknown, scope: Scope, filter: AnyFilter): Promise<T | null> {
  const f = withScope(scope, filter) as unknown as Parameters<Model<T>['findOne']>[0];
  return (model as Model<T>).findOne(f).lean<T | null>().exec();
}

/** FindById kèm kiểm tra scope — dùng cho mọi route `/xxx/:id`. */
export async function scopedById<T>(model: unknown, scope: Scope, id: string): Promise<T | null> {
  const f = { _id: id, ...scopeFilter(scope) } as unknown as Parameters<Model<T>['findOne']>[0];
  return (model as Model<T>).findOne(f).lean<T | null>().exec();
}

/**
 * Aggregate có `$match` scope được CHÈN VÀO ĐẦU pipeline — không aggregate nào
 * đọc chéo công ty được (arch §7.5: mọi query có company_id).
 */
export async function scopedAggregate<R>(
  model: unknown,
  scope: Scope,
  pipeline: unknown[],
  field = 'company_id',
): Promise<R[]> {
  const sf = scopeFilter(scope, field);
  const full = Object.keys(sf).length ? [{ $match: sf }, ...pipeline] : pipeline;
  // Aggregate của mongoose 9 là thenable — await trực tiếp (không có .lean())
  const agg = (model as { aggregate: (p: never[]) => Promise<R[]> }).aggregate;
  return agg.call(model as never, full as never[]);
}

export async function scopedInsertMany<T>(model: Model<T>, docs: Record<string, unknown>[]): Promise<T[]> {
  const created = await model.insertMany(docs as never);
  return created.map((d) => (d as unknown as { toObject: () => T }).toObject());
}

export async function updateScoped<T>(
  model: Model<T>,
  scope: Scope,
  filter: AnyFilter,
  update: Record<string, unknown>,
  opts: { upsert?: boolean } = {},
): Promise<number> {
  const f = withScope(scope, filter) as unknown as Parameters<Model<T>['updateMany']>[0];
  const r = await model.updateMany(f, update as never, opts).exec();
  return r.modifiedCount + r.upsertedCount;
}

export async function insertOne<T>(model: Model<T>, doc: Record<string, unknown>): Promise<T> {
  const created = await model.create(doc as never);
  return created.toObject() as unknown as T;
}

export function oid(v: string) {
  return new mongoose.Types.ObjectId(v);
}

export function isObjectId(v: unknown): boolean {
  return mongoose.Types.ObjectId.isValid(String(v));
}

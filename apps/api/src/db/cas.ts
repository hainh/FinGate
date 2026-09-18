/**
 * Compare-and-swap — cách DUY NHẤT để ghi khi không có transaction (ADR-03, arch §7.3).
 *
 * Mọi mutation = 1 conditional update trên 1 document:
 *   updateOne({_id, version}, { $set: {...}, $inc: { version: 1 }, $push: { history } })
 * matchedCount === 0 → 409 FG-WF-011, và KHÔNG có side effect nào đã xảy ra.
 */

import { Models } from './models.ts';
import { ApiError } from '@fingate/shared';

export interface CasInput<T> {
  model: keyof typeof Models;
  id: string;
  ifMatch: number;
  /** $set */
  set?: Record<string, unknown>;
  /** $inc (thường là version) */
  inc?: Record<string, number>;
  /** $push — history[] luôn push trong CÙNG update này (§7.3) */
  push?: Record<string, unknown>;
  /** $addToSet — dùng cho processed_requests */
  addToSet?: Record<string, unknown>;
  /** $pull */
  pull?: Record<string, unknown>;
  /** $unset */
  unset?: Record<string, unknown>;
  /** bộ lọc bổ sung ngoài version (ví dụ status còn đúng như đã đọc) */
  extraFilter?: Record<string, unknown>;
  /** projection trả về bản mới nhất */
  select?: Record<string, 0 | 1>;
  _type?: T;
}

export interface CasResult<T> {
  doc: T;
  version: number;
}

/**
 * Thực hiện CAS. Văng version → ApiError FG-WF-011 (409) kèm dữ liệu để UI hiển thị
 * "Hồ sơ đã được X cập nhật lúc Y. Tải lại." (DS §7.14 rule 7).
 */
export async function cas<T>(input: CasInput<T>): Promise<CasResult<T> | null> {
  const model = Models[input.model] as unknown as {
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      opts: Record<string, unknown>,
    ) => { lean<R>(): Promise<R | null> };
    findOne: (f: Record<string, unknown>) => { lean<R>(): Promise<R | null> };
  };

  const filter: Record<string, unknown> = { _id: input.id, version: input.ifMatch, ...(input.extraFilter ?? {}) };
  const update: Record<string, unknown> = {};
  if (input.set && Object.keys(input.set).length) update.$set = { ...input.set, updated_at: new Date() };
  else update.$set = { updated_at: new Date() };
  update.$inc = { version: 1, ...(input.inc ?? {}) };
  if (input.push && Object.keys(input.push).length) update.$push = input.push;
  if (input.addToSet && Object.keys(input.addToSet).length) update.$addToSet = input.addToSet;
  if (input.pull && Object.keys(input.pull).length) update.$pull = input.pull;
  if (input.unset && Object.keys(input.unset).length) update.$unset = input.unset;

  const doc = await model
    .findOneAndUpdate(filter, update, { returnDocument: 'after', ...(input.select ? { projection: input.select } : {}) })
    .lean<T | null>();

  if (doc) return { doc, version: Number((doc as { version?: number }).version ?? input.ifMatch + 1) };

  // CAS trượt: đọc bản hiện tại để đưa thông tin "ai vừa sửa" vào problem+json
  const current = await model.findOne({ _id: input.id }).lean<{ version?: number; status?: string } | null>();
  if (!current) return null; // hồ sơ không tồn tại → caller trả 404
  throw new ApiError({
    code: 'FG-WF-011',
    detail: 'Hồ sơ đã được người khác cập nhật. Tải lại để xem phiên bản mới nhất.',
    data: { current_version: current.version, current_status: current.status },
  });
}

/**
 * Idempotency theo `request_id` (arch §6): double-click / retry không tạo 2 bước duyệt.
 * Trả về true nếu request_id đã được xử lý.
 */
export async function alreadyProcessed(id: string, requestId: string): Promise<boolean> {
  const doc = await Models.Document.findOne({ _id: id, processed_requests: requestId })
    .select({ _id: 1 })
    .lean();
  return Boolean(doc);
}

/** Upsert một `balances_daily` theo (account, date) — CAS theo document ngày (arch §8.3). */
export async function bumpBalance(input: {
  company_id: string;
  account_id: string;
  date: string;
  min_balance_minor?: bigint;
  plannedIn?: bigint;
  plannedOut?: bigint;
  actualIn?: bigint;
  actualOut?: bigint;
}): Promise<void> {
  const { company_id, account_id, date } = input;
  const inc: Record<string, number | bigint> = {};
  if (input.plannedIn) inc.planned_in_minor = input.plannedIn;
  if (input.plannedOut) inc.planned_out_minor = input.plannedOut;
  if (input.actualIn) inc.actual_in_minor = input.actualIn;
  if (input.actualOut) inc.actual_out_minor = input.actualOut;

  // Số dư (closing) = opening + actual_in − actual_out → thực thi xong là số dư đổi NGAY
  // (opening không đổi nên chỉ cần cộng delta actual). rebuildBalances vẫn tính lại nhất quán.
  const closingDelta = (input.actualIn ?? 0n) - (input.actualOut ?? 0n);
  if (closingDelta !== 0n) inc.closing_minor = closingDelta;

  const set: Record<string, unknown> = { company_id, account_id, date, source: 'system' };
  if (input.min_balance_minor !== undefined) set.min_balance_minor = input.min_balance_minor;

  await Models.BalanceDaily.updateOne(
    { account_id, date },
    {
      $set: set,
      $inc: Object.keys(inc).length ? inc : { version: 1 },
      $setOnInsert: { version: 1 },
    },
    { upsert: true },
  ).exec();
}

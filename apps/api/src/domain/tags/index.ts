/**
 * Tag (nhãn tự do gắn phiếu thu/chi) — nghiệp vụ & truy vấn, v2/v2.md §6.2, §13, §14.2.
 *
 * · Danh bạ tag THEO TỪNG CÔNG TY. Mọi truy vấn đi qua `scoped*` (lib/mongo) để không đọc chéo công ty.
 * · Chống trùng theo (company_id, name_key) — unique index ở db/indexes.ts. Tạo trùng tên → trả tag đã có.
 * · Ẩn (`hidden`) = ngừng dùng: CHỈ ẩn được tag không còn phiếu nào gắn. Tag ẩn không gắn được vào phiếu
 *   mới (`resolveVoucherTagIds` ở `domain/vouchers/refs.ts` từ chối) và không hiện trong gợi ý.
 * · Kiểm tag khi gắn vào phiếu nằm ở `domain/vouchers` (một nguồn duy nhất); file này chỉ quản lý danh bạ.
 * · Gộp A → B: chuyển mọi phiếu A → B bằng CAS (tăng version, ghi history `tag_merge`), ẩn A, quét lại lần cuối.
 *   KHÔNG xoá tag để id còn tra cứu được trong audit.
 * · Mọi thay đổi ghi audit_log (`domain/audit`). Tag không đổi tiền nên KHÔNG phát domain event
 *   (tránh kích hoạt quy tắc tự động một cách vô nghĩa).
 */

import { randomUUID } from 'node:crypto';
import { ApiError, TAG_COLOR_DEFAULT, normalizeNameKey, type TagRow } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { cas } from '../../db/cas.ts';
import { oid, scopedAggregate, scopedById, scopedCount, scopedFind, scopedOne } from '../../lib/mongo.ts';
import { buildHistoryEntry, mirrorAudit } from '../audit/index.ts';
import type { ScopeLike } from '../types.ts';
import { OBJECT_ID_RE, changedFields, normalizeTagName, replaceTagIds } from './normalize.ts';

export { TAG_MAX_PER_DOCUMENT, TAG_NAME_MAX, changedFields, normalizeTagName, replaceTagIds } from './normalize.ts';
export type { FieldChange, NormalizedTagName } from './normalize.ts';

/** Người thực hiện thay đổi (lấy từ ActorInfo). */
export interface TagActor {
  user_id: string;
  name?: string | null;
  role?: string | null;
}

/** Ngữ cảnh gọi: người làm, phạm vi công ty của phiên, IP/UA cho audit. */
export interface TagCallCtx {
  actor: TagActor;
  scope: ScopeLike;
  ip?: string | null;
  ua?: string | null;
}

interface TagLean {
  _id: unknown;
  company_id: unknown;
  name: string;
  name_key: string;
  color?: string | null;
  hidden?: boolean | null;
  updated_at?: unknown;
}

interface DocLean {
  _id: unknown;
  code?: string | null;
  kind?: string | null;
  tag_ids?: unknown[] | null;
  version?: number | null;
}

/** Số phiếu tối đa mỗi lượt quét khi gộp (để không nạp cả công ty vào bộ nhớ). */
const MERGE_BATCH = 200;
/** Trần số lượt quét lô khi gộp — chặn vòng lặp vô hạn nếu dữ liệu đổi liên tục. */
const MERGE_MAX_ROUNDS = 50;
/** Số lần thử CAS cho mỗi phiếu khi bị tranh chấp version. */
const CAS_ATTEMPTS = 3;
/** Mã lỗi unique index của MongoDB. */
const DUPLICATE_KEY = 11000;

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === DUPLICATE_KEY;
}

function notFound(): ApiError {
  return new ApiError({ code: 'FG-VAL-001', status: 404, detail: 'Không tìm thấy tag' });
}

function assertInScope(scope: ScopeLike, companyId: string): void {
  if (scope.companyIds !== null && !scope.companyIds.includes(companyId)) throw new ApiError({ code: 'FG-RBAC-002' });
}

function toIso(v: unknown): string {
  return (v ? new Date(v as string | number | Date) : new Date()).toISOString();
}

function toTagRow(t: TagLean, usage: number): TagRow {
  return {
    _id: String(t._id),
    company_id: String(t.company_id),
    name: t.name,
    color: t.color ?? TAG_COLOR_DEFAULT,
    hidden: t.hidden === true,
    usage_count: usage,
    updated_at: toIso(t.updated_at),
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Tên đã có trong công ty: đang ẩn → cần KTT hiện lại; đang hiện → trả chính tag đó (xử lý ở chỗ gọi). */
function hiddenDuplicateError(name: string, tagId: string): ApiError {
  return new ApiError({
    code: 'FG-TAG-001',
    detail: `Tag "${name}" đã có nhưng đang bị ẩn. Nhờ kế toán trưởng hiện lại để dùng.`,
    data: { tag_id: tagId, hidden: true },
  });
}

/** Tải một tag trong phạm vi; sai định dạng hoặc ngoài phạm vi → 404 (không lộ tag công ty khác). */
async function loadTagInScope(scope: ScopeLike, id: string): Promise<TagLean> {
  if (!OBJECT_ID_RE.test(id)) throw notFound();
  const tag = await scopedById<TagLean>(Models.Tag, scope, id);
  if (!tag) throw notFound();
  return tag;
}

function findByKey(companyId: string, nameKey: string, exceptId?: string): Promise<TagLean | null> {
  const filter: Record<string, unknown> = { name_key: nameKey };
  if (exceptId) filter._id = { $ne: oid(exceptId) };
  return scopedOne<TagLean>(Models.Tag, { companyIds: [companyId] }, filter);
}

/** Số phiếu đang gắn một tag (phiếu thuộc cùng công ty với tag). */
export async function countTagUsage(companyId: string, tagId: string): Promise<number> {
  return scopedCount(Models.Document, { companyIds: [companyId] }, { tag_ids: oid(tagId) });
}

/**
 * Số phiếu đang gắn từng tag, một truy vấn gộp. Đếm theo phiếu (không đếm trùng nếu dữ liệu cũ
 * có tag lặp trong một phiếu).
 */
export async function tagUsageByIds(scope: ScopeLike, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const valid = ids.filter((id) => OBJECT_ID_RE.test(id));
  if (!valid.length) return out;
  const oids = valid.map((id) => oid(id));
  const rows = await scopedAggregate<{ _id: unknown; n: number }>(Models.Document, scope, [
    { $match: { tag_ids: { $in: oids } } },
    { $unwind: '$tag_ids' },
    { $match: { tag_ids: { $in: oids } } },
    { $group: { _id: { tag: '$tag_ids', doc: '$_id' } } },
    { $group: { _id: '$_id.tag', n: { $sum: 1 } } },
  ]);
  for (const r of rows) out.set(String(r._id), Number(r.n));
  return out;
}

export interface ListTagsOptions {
  companyId?: string | null;
  /** Gõ để tìm: khớp "chứa" trên tên chuẩn hoá. */
  q?: string | null;
  /** Mặc định false: tag đã ẩn không xuất hiện trong gợi ý. */
  includeHidden?: boolean;
  limit: number;
}

/** Danh sách / gợi ý tag (sắp theo tên chuẩn hoá) kèm số phiếu đang gắn. */
export async function listTags(scope: ScopeLike, opts: ListTagsOptions): Promise<TagRow[]> {
  const filter: Record<string, unknown> = {};
  if (opts.companyId) filter.company_id = oid(opts.companyId);
  if (!opts.includeHidden) filter.hidden = { $ne: true };
  const q = normalizeNameKey(opts.q ?? '');
  if (q) filter.name_key = { $regex: escapeRegex(q) };
  const rows = await scopedFind<TagLean>(Models.Tag, scope, filter, { sort: { name_key: 1 }, limit: opts.limit });
  const usage = await tagUsageByIds(scope, rows.map((r) => String(r._id)));
  return rows.map((r) => toTagRow(r, usage.get(String(r._id)) ?? 0));
}

/** Chi tiết một tag kèm số phiếu đang gắn. */
export async function getTagRow(scope: ScopeLike, id: string): Promise<TagRow> {
  const tag = await loadTagInScope(scope, id);
  return toTagRow(tag, await countTagUsage(String(tag.company_id), id));
}

export interface CreateTagInput {
  company_id: string;
  name: string;
  color?: string | null;
}

/**
 * Tạo tag trong danh bạ công ty (`tag:create`, cũng dùng cho "+ Tạo tag …" trên phiếu).
 * · Đã có cùng tên chuẩn hoá và đang hiện → trả tag đó, `created: false` (không tạo trùng).
 * · Đã có nhưng đang ẩn → FG-TAG-001 (cần kế toán trưởng hiện lại).
 */
export async function createTag(ctx: TagCallCtx, input: CreateTagInput): Promise<{ tag: TagRow; created: boolean }> {
  assertInScope(ctx.scope, input.company_id);
  const { name, name_key } = normalizeTagName(input.name);

  const existing = await findByKey(input.company_id, name_key);
  if (existing) {
    if (existing.hidden === true) throw hiddenDuplicateError(existing.name, String(existing._id));
    return { tag: toTagRow(existing, await countTagUsage(input.company_id, String(existing._id))), created: false };
  }

  const now = new Date();
  const color = input.color ?? TAG_COLOR_DEFAULT;
  let id: unknown;
  try {
    const doc = await Models.Tag.create({
      company_id: oid(input.company_id),
      name,
      name_key,
      color,
      hidden: false,
      created_by: oid(ctx.actor.user_id),
      created_at: now,
      updated_at: now,
    } as never);
    id = doc._id;
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    // Hai yêu cầu tạo cùng tên đồng thời: unique index chặn bản thứ hai → trả bản đã có.
    const again = await findByKey(input.company_id, name_key);
    if (!again) throw err;
    if (again.hidden === true) throw hiddenDuplicateError(again.name, String(again._id));
    return { tag: toTagRow(again, await countTagUsage(input.company_id, String(again._id))), created: false };
  }

  await mirrorAudit({
    at: now,
    actor: { user_id: ctx.actor.user_id, name: ctx.actor.name, role: ctx.actor.role },
    action: 'tag.create',
    subject: { type: 'tag', id: String(id), code: name },
    company_id: input.company_id,
    diff_fields: { name, color },
    ip: ctx.ip,
    ua: ctx.ua,
  });
  return {
    tag: toTagRow({ _id: id, company_id: oid(input.company_id), name, name_key, color, hidden: false, updated_at: now }, 0),
    created: true,
  };
}

export interface UpdateTagPatch {
  name?: string;
  color?: string;
  hidden?: boolean;
}

/**
 * Đổi tên / màu / ẩn-hiện (`tag:manage`). Ẩn chỉ khi tag không còn phiếu nào gắn; hiện lại luôn được.
 * Không có gì đổi → không ghi, không audit. Mỗi loại thay đổi (sửa / ẩn / hiện) có một dòng audit riêng.
 */
export async function updateTag(ctx: TagCallCtx, id: string, patch: UpdateTagPatch): Promise<TagRow> {
  const tag = await loadTagInScope(ctx.scope, id);
  const companyId = String(tag.company_id);
  const usage = await countTagUsage(companyId, id);

  const next: { name?: string; name_key?: string; color?: string; hidden?: boolean } = {};
  if (patch.name !== undefined) {
    const n = normalizeTagName(patch.name);
    const dup = await findByKey(companyId, n.name_key, id);
    if (dup) {
      throw new ApiError({
        code: 'FG-TAG-001',
        detail: `Đã có tag "${dup.name}". Muốn dùng chung thì gộp hai tag.`,
        data: { tag_id: String(dup._id) },
      });
    }
    next.name = n.name;
    next.name_key = n.name_key;
  }
  if (patch.color !== undefined) next.color = patch.color;
  if (patch.hidden !== undefined) {
    if (patch.hidden && usage > 0) {
      throw new ApiError({
        code: 'FG-VAL-001',
        detail: `Tag đang gắn ${usage} phiếu nên không thể ẩn. Hãy gộp vào tag khác.`,
        errors: { hidden: 'Tag đang được dùng, không thể ẩn' },
        data: { usage_count: usage },
      });
    }
    next.hidden = patch.hidden;
  }

  const before = { name: tag.name, color: tag.color ?? TAG_COLOR_DEFAULT, hidden: tag.hidden === true };
  const changes = changedFields(before, { name: next.name, color: next.color, hidden: next.hidden });
  if (!Object.keys(changes).length) return toTagRow(tag, usage);

  const now = new Date();
  try {
    await Models.Tag.updateOne({ _id: oid(id), company_id: oid(companyId) }, { $set: { ...next, updated_at: now } }).exec();
  } catch (err) {
    if (isDuplicateKey(err)) throw new ApiError({ code: 'FG-TAG-001', detail: 'Tên tag này đã tồn tại trong công ty' });
    throw err;
  }

  const { hidden: hiddenChange, ...rest } = changes;
  const audit = {
    at: now,
    actor: { user_id: ctx.actor.user_id, name: ctx.actor.name, role: ctx.actor.role },
    subject: { type: 'tag', id, code: next.name ?? tag.name },
    company_id: companyId,
    ip: ctx.ip,
    ua: ctx.ua,
  };
  if (Object.keys(rest).length) await mirrorAudit({ ...audit, action: 'tag.update', diff_fields: rest });
  if (hiddenChange) {
    await mirrorAudit({ ...audit, action: next.hidden ? 'tag.hide' : 'tag.unhide', diff_fields: { hidden: hiddenChange } });
  }

  return toTagRow({ ...tag, ...next, updated_at: now }, usage);
}

export interface MergeTagsInput {
  source_id: string;
  target_id: string;
}

export interface MergeTagsResult {
  source_id: string;
  target_id: string;
  documents_changed: number;
  target: TagRow;
}

interface MoveScan {
  companyId: string;
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  ctx: TagCallCtx;
  requestId: string;
}

/** Chuyển một phiếu từ `fromId` sang `toId` bằng CAS. Trả về 'moved' | 'skipped' (không còn gắn A) | 'conflict'. */
async function moveOneDocument(scan: MoveScan, first: DocLean): Promise<'moved' | 'skipped' | 'conflict'> {
  const docScope = { companyIds: [scan.companyId] };
  let current: DocLean | null = first;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    if (attempt > 0) current = await scopedById<DocLean>(Models.Document, docScope, String(first._id));
    if (!current) return 'skipped';

    const ids = (current.tag_ids ?? []).map((x) => String(x));
    if (!ids.includes(scan.fromId)) return 'skipped';
    const nextIds = replaceTagIds(ids, scan.fromId, scan.toId);

    const at = new Date();
    const entry = buildHistoryEntry({
      at,
      actor: { user_id: scan.ctx.actor.user_id, role: scan.ctx.actor.role ?? null, name: scan.ctx.actor.name ?? null },
      action: 'tag_merge',
      from: scan.fromName,
      to: scan.toName,
      request_id: scan.requestId,
      ip: scan.ctx.ip ?? null,
      fields: { changed: ['tag_ids'], from_tag_id: scan.fromId, to_tag_id: scan.toId, tag_ids_before: ids, tag_ids_after: nextIds },
    });
    try {
      const done = await cas<DocLean>({
        model: 'Document',
        id: String(current._id),
        ifMatch: Number(current.version ?? 1),
        extraFilter: { company_id: oid(scan.companyId), tag_ids: oid(scan.fromId) },
        set: { tag_ids: nextIds.map((x) => oid(x)) },
        push: { history: entry },
      });
      if (!done) return 'skipped';
      await mirrorAudit({
        at,
        actor: { user_id: scan.ctx.actor.user_id, name: scan.ctx.actor.name, role: scan.ctx.actor.role },
        action: 'document.tag_merge',
        subject: { type: String(current.kind ?? 'document'), id: String(current._id), code: current.code ?? null },
        company_id: scan.companyId,
        document_id: String(current._id),
        diff_fields: {
          changed: ['tag_ids'],
          from_tag: { id: scan.fromId, name: scan.fromName },
          to_tag: { id: scan.toId, name: scan.toName },
        },
        request_id: scan.requestId,
        ip: scan.ctx.ip,
        ua: scan.ctx.ua,
      });
      return 'moved';
    } catch (err) {
      // CAS trượt (version đổi hoặc phiếu vừa đổi tag): đọc lại rồi thử tiếp.
      if (err instanceof ApiError && err.code === 'FG-WF-011') continue;
      throw err;
    }
  }
  return 'conflict';
}

/** Chuyển mọi phiếu đang gắn `fromId` sang `toId` theo lô, đến khi không còn phiếu nào. */
async function moveDocuments(scan: MoveScan): Promise<number> {
  let total = 0;
  for (let round = 0; round < MERGE_MAX_ROUNDS; round++) {
    const batch = await scopedFind<DocLean>(
      Models.Document,
      { companyIds: [scan.companyId] },
      { tag_ids: oid(scan.fromId) },
      { projection: { _id: 1, code: 1, kind: 1, tag_ids: 1, version: 1 }, limit: MERGE_BATCH },
    );
    if (!batch.length) return total;

    let moved = 0;
    let conflicts = 0;
    for (const doc of batch) {
      const outcome = await moveOneDocument(scan, doc);
      if (outcome === 'moved') moved++;
      else if (outcome === 'conflict') conflicts++;
    }
    total += moved;
    if (moved === 0 && conflicts > 0) {
      throw new ApiError({ code: 'FG-WF-011', detail: 'Có phiếu đang được sửa đồng thời. Thử gộp lại sau ít giây.' });
    }
  }
  throw new ApiError({ code: 'FG-SYS-001', detail: 'Gộp quá nhiều phiếu trong một lần. Thử gộp lại để xử lý nốt.' });
}

/**
 * Gộp tag A (`source`) vào tag B (`target`) trong một công ty (`tag:manage`):
 * 1. chuyển mọi phiếu đang gắn A sang B (không trùng), mỗi phiếu CAS + history `tag_merge` + audit;
 * 2. ẩn A — từ đây không gắn A vào phiếu mới được;
 * 3. quét lại lần nữa để bắt phiếu vừa gắn A trước khi bị ẩn; còn sót → FG-WF-011 (gộp lại).
 * Chạy lại an toàn: phiếu đã chuyển sẽ được bỏ qua.
 */
export async function mergeTags(ctx: TagCallCtx, input: MergeTagsInput): Promise<MergeTagsResult> {
  if (input.source_id === input.target_id) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Phải chọn hai tag khác nhau', errors: { target_id: 'Trùng tag nguồn' } });
  }
  const source = await loadTagInScope(ctx.scope, input.source_id);
  const target = await loadTagInScope(ctx.scope, input.target_id);
  const companyId = String(source.company_id);
  if (String(target.company_id) !== companyId) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Chỉ gộp các tag cùng một công ty', errors: { target_id: 'Tag đích thuộc công ty khác' } });
  }
  if (target.hidden === true) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Tag đích đang bị ẩn. Hãy hiện lại trước khi gộp.', errors: { target_id: 'Tag đích đang bị ẩn' } });
  }

  const scan: MoveScan = {
    companyId,
    fromId: input.source_id,
    toId: input.target_id,
    fromName: source.name,
    toName: target.name,
    ctx,
    requestId: randomUUID(),
  };

  let changed = await moveDocuments(scan);
  const wasHidden = source.hidden === true;
  await Models.Tag.updateOne(
    { _id: oid(input.source_id), company_id: oid(companyId) },
    { $set: { hidden: true, updated_at: new Date() } },
  ).exec();
  changed += await moveDocuments(scan);

  const left = await countTagUsage(companyId, input.source_id);
  if (left > 0) {
    throw new ApiError({ code: 'FG-WF-011', detail: `Còn ${left} phiếu đang được sửa đồng thời. Gộp lại để chuyển nốt.` });
  }

  if (changed > 0 || !wasHidden) {
    await mirrorAudit({
      at: new Date(),
      actor: { user_id: ctx.actor.user_id, name: ctx.actor.name, role: ctx.actor.role },
      action: 'tag.merge',
      subject: { type: 'tag', id: input.target_id, code: target.name },
      company_id: companyId,
      diff_fields: {
        source: { id: input.source_id, name: source.name },
        target: { id: input.target_id, name: target.name },
        documents_changed: changed,
      },
      request_id: scan.requestId,
      ip: ctx.ip,
      ua: ctx.ua,
    });
  }

  const fresh = await loadTagInScope(ctx.scope, input.target_id);
  return {
    source_id: input.source_id,
    target_id: input.target_id,
    documents_changed: changed,
    target: toTagRow(fresh, await countTagUsage(companyId, input.target_id)),
  };
}

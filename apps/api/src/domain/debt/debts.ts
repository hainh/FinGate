/**
 * Công nợ phải thu / phải trả (v2/v2.md §9): tạo/sửa/xoá khoản, cấn trừ qua `business_links` (relation = offset),
 * chỉ tiêu suy ra khi đọc (đã cấn trừ, còn lại, quá hạn, tuổi nợ). Khoản nhân viên (TK 334) chỉ đọc.
 */

import { ApiError, today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { scopedFind } from '../../lib/mongo.ts';
import { buildHistoryEntry, mirrorAudit } from '../audit/index.ts';
import { emitDomainEvent } from '../events/index.ts';
import { nextSequentialCode } from '../numbering/index.ts';
import { createLink, documentAllocatedTotalOf, allocationOf, removeLink, reservingLinks, type LinkRecord } from '../links/index.ts';
import type { ScopeLike } from '../types.ts';
import type { DebtCreateBody, DebtUpdateBody } from './bodies.ts';
import {
  AGING_BUCKET_LABEL,
  DEBT_PARTNER_TYPES,
  accountCodeOfPartnerType,
  assertLinkableDocStatus,
  assertOffsetDirection,
  changesOf,
  defaultAllocation,
  debtFigures,
  directionOf,
  docKindForDirection,
  escapeRegex,
  isReadOnlyDebt,
  isoOf,
  positiveMinor,
  resolveSide,
  wireMoney,
  type DebtAgingBucket,
  type DebtDirection,
} from './rules.ts';
import { assertInScope, assertPartner, documentCandidates, isExecuted, loadCompanyNames, loadDocs, loadLinks, loadPartners, sumBy, validIds, type DocRef, type PartnerRef } from './loads.ts';

const DEBT_MAX_ROWS = 5000;
const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
/** Trường được ghi lịch sử trước → sau khi sửa công nợ (v2 §2.3). */
const DEBT_TRACKED = ['partner_id', 'party_type', 'direction', 'side', 'account_code', 'value_minor', 'due_date', 'contract_code', 'priority', 'note'] as const;

export interface DebtActor {
  user_id: string;
  name?: string | null;
  role?: string | null;
  company_id?: string | null;
}

export interface ReqMeta {
  ip?: string | null;
  request_id?: string | null;
}

/** Bản ghi phiếu công nợ (lean). Các trường v1 vẫn có trong DB; v2 chỉ dùng `partner_id`, `direction`. */
export interface DebtRaw {
  _id: unknown;
  company_id: unknown;
  code?: string;
  party_type: string;
  party_name?: string;
  party_bank_name?: string | null;
  party_bank_account?: string | null;
  partner_id?: unknown;
  direction?: string | null;
  account_code: string;
  side: string;
  value_minor?: unknown;
  currency?: string;
  contract_code?: string | null;
  due_date?: string;
  priority?: string;
  note?: string | null;
  attachments?: unknown[];
  history?: unknown[];
  created_at?: Date | string;
  updated_at?: Date | string;
}

interface DebtCtx {
  partners: Map<string, PartnerRef>;
  companies: Map<string, string>;
  /** Đã cấn trừ theo khoản (chỉ phiếu đã thực thi). */
  applied: Map<string, bigint>;
  /** Số liên kết cấn trừ hiệu lực theo khoản. */
  linkCounts: Map<string, number>;
}

function toBigSafe(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

export function readOnlyDebtError(): ApiError {
  return new ApiError({ code: 'FG-WF-001', detail: 'Công nợ nhân viên (TK 334) chỉ đọc' });
}

export async function loadDebtOrFail(id: string): Promise<DebtRaw> {
  const d = OBJECT_ID_RE.test(id) ? await Models.DebtVoucher.findById(id).lean<DebtRaw | null>() : null;
  if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy phiếu công nợ' });
  return d;
}

async function debtContext(rows: DebtRaw[]): Promise<DebtCtx> {
  const ids = rows.map((r) => String(r._id));
  const [partners, companies, links] = await Promise.all([
    loadPartners(rows.map((r) => r.partner_id)),
    loadCompanyNames(rows.map((r) => r.company_id)),
    loadLinks({ to_type: 'debt_voucher', to_ids: ids, relations: ['offset'] }),
  ]);
  const docs = await loadDocs(links.map((l) => l.from_id));
  const applied = sumBy(links, (l) => l.to_id, allocationOf, isExecuted(docs));
  const counts = sumBy(links, (l) => l.to_id, () => 1n);
  return { partners, companies, applied, linkCounts: new Map([...counts].map(([k, v]) => [k, Number(v)])) };
}

function buildDebt(d: DebtRaw, ctx: DebtCtx) {
  const id = String(d._id);
  const currency = String(d.currency ?? 'VND');
  const value = toBigSafe(d.value_minor);
  const applied = ctx.applied.get(id) ?? 0n;
  const dueDate = String(d.due_date ?? today());
  const figures = debtFigures(value, applied, dueDate);
  const partner = d.partner_id ? (ctx.partners.get(String(d.partner_id)) ?? null) : null;
  const item: Record<string, unknown> = {
    _id: id,
    company_id: String(d.company_id),
    company_name: ctx.companies.get(String(d.company_id)) ?? '',
    code: String(d.code ?? ''),
    partner_id: d.partner_id ? String(d.partner_id) : null,
    partner,
    party_type: d.party_type,
    party_name: partner?.name ?? d.party_name ?? '',
    party_bank_name: partner?.bank_name ?? d.party_bank_name ?? null,
    party_bank_account: partner?.account_number ?? d.party_bank_account ?? null,
    direction: directionOf(d),
    account_code: d.account_code,
    side: d.side,
    value: wireMoney(value, currency),
    settled: wireMoney(applied, currency),
    offset_applied: wireMoney(applied, currency),
    remaining: wireMoney(figures.remaining, currency),
    currency,
    contract_code: d.contract_code ?? null,
    due_date: dueDate,
    days_overdue: figures.overdue_days,
    aging_bucket: figures.aging_bucket,
    priority: String(d.priority ?? 'normal'),
    status: figures.status,
    note: d.note ?? null,
    attachment_count: Array.isArray(d.attachments) ? d.attachments.length : 0,
    link_count: ctx.linkCounts.get(id) ?? 0,
    read_only: isReadOnlyDebt(d.party_type),
    created_at: d.created_at ? isoOf(d.created_at) : null,
    updated_at: d.updated_at ? isoOf(d.updated_at) : null,
  };
  return { item, figures, value, applied };
}

/** Điều kiện lọc theo hướng; khoản v1 chưa migrate (direction null) suy từ bút toán Nợ/Có. */
function directionClause(direction: DebtDirection): Record<string, unknown> {
  return direction === 'receivable'
    ? { $or: [{ direction: 'receivable' }, { direction: null, side: 'debit' }] }
    : { $or: [{ direction: 'payable' }, { direction: null, side: 'credit' }] };
}

async function partnerIdsMatching(term: string, scope: ScopeLike): Promise<string[]> {
  const rx = { $regex: escapeRegex(term), $options: 'i' };
  const filter: Record<string, unknown> = { $or: [{ name: rx }, { account_number: rx }, { tax_code: rx }, { code: rx }] };
  if (scope.companyIds !== null) filter.company_id = { $in: scope.companyIds };
  const rows = await Models.Partner.find(filter as never).select({ _id: 1 }).limit(500).lean<{ _id: unknown }[]>();
  return rows.map((r) => String(r._id));
}

/** Điều kiện chung của danh sách & tuổi nợ (không gồm tìm kiếm tên). */
function baseClauses(scope: ScopeLike, f: { party_type?: string; direction?: DebtDirection; company_id?: string; side?: string; partner_id?: string }) {
  const clauses: Record<string, unknown>[] = [];
  if (f.party_type) clauses.push({ party_type: f.party_type });
  if (f.side) clauses.push({ side: f.side });
  if (f.direction) clauses.push(directionClause(f.direction));
  if (f.partner_id) clauses.push({ partner_id: f.partner_id });
  if (f.company_id) {
    assertInScope(scope.companyIds, f.company_id);
    clauses.push({ company_id: f.company_id });
  }
  return clauses;
}

async function fetchDebts(scope: ScopeLike, clauses: Record<string, unknown>[], sort: Record<string, 1 | -1>): Promise<DebtRaw[]> {
  const filter = clauses.length ? { $and: clauses } : {};
  return scopedFind<DebtRaw>(Models.DebtVoucher, { companyIds: scope.companyIds }, filter, { sort, limit: DEBT_MAX_ROWS });
}

export interface DebtListInput {
  party_type?: string;
  partner_id?: string;
  direction?: DebtDirection;
  side?: string;
  company_id?: string;
  counterparty?: string;
  q?: string;
  overdue_only?: 'true' | 'false';
  bucket?: DebtAgingBucket;
  sort?: string;
  limit: number;
  page: number;
}

/** Danh sách công nợ + tổng hợp; lọc quá hạn / tuổi nợ thực hiện sau khi suy chỉ tiêu. */
export async function listDebts(scope: ScopeLike, q: DebtListInput) {
  const clauses = baseClauses(scope, q);
  const term = (q.counterparty ?? q.q ?? '').trim();
  if (term) {
    // Tìm theo đối tác (tên / STK / MST / mã đối tác — qua partner_id), mã khoản (CN-…) và số hợp đồng.
    // Không khớp theo tên tự do v1 (party_name): đổi tên đối tác thì kết quả vẫn đúng.
    const ids = await partnerIdsMatching(term, scope);
    const rx = { $regex: escapeRegex(term), $options: 'i' };
    clauses.push({ $or: [{ partner_id: { $in: ids } }, { code: rx }, { contract_code: rx }] });
  }
  const rows = await fetchDebts(scope, clauses, q.sort === 'value' ? { value_minor: -1 } : { due_date: 1 });
  const ctx = await debtContext(rows);
  let built = rows.map((d) => buildDebt(d, ctx));
  if (q.overdue_only === 'true') built = built.filter((b) => b.figures.remaining > 0n && b.figures.overdue_days > 0);
  if (q.bucket) built = built.filter((b) => b.figures.aging_bucket === q.bucket);
  let remaining = 0n;
  let value = 0n;
  let applied = 0n;
  for (const b of built) {
    remaining += b.figures.remaining;
    value += b.value;
    applied += b.applied;
  }
  const start = (q.page - 1) * q.limit;
  return {
    items: built.slice(start, start + q.limit).map((b) => b.item),
    total: built.length,
    page: q.page,
    limit: q.limit,
    /** Chạm trần truy vấn (DEBT_MAX_ROWS): KPI và tổng chỉ tính trên phần đã nạp — UI cần cảnh báo. */
    truncated: rows.length >= DEBT_MAX_ROWS,
    totals: { remaining: wireMoney(remaining), value: wireMoney(value), offset_applied: wireMoney(applied) },
  };
}

export const AGING_COLUMNS: readonly DebtAgingBucket[] = ['none', 'lt30', 'd30_60', 'd60_90', 'gt90'];

/** Ma trận tuổi nợ theo đối tác & hướng (US-DEBT-03): chỉ khoản còn dư. */
export async function debtAgingMatrix(scope: ScopeLike, q: { party_type?: string; direction?: DebtDirection; company_id?: string }) {
  const rows = await fetchDebts(scope, baseClauses(scope, q), { due_date: 1 });
  const ctx = await debtContext(rows);
  const groups = new Map<string, { company: string; counterparty: string; partner_id: string | null; direction: DebtDirection; party_type: string; cells: Record<string, { amount: bigint; count: number }> }>();
  const totals = new Map<string, bigint>(AGING_COLUMNS.map((b) => [b, 0n]));
  for (const d of rows) {
    const b = buildDebt(d, ctx);
    if (b.figures.remaining <= 0n) continue;
    const company = String(d.company_id);
    const partnerKey = d.partner_id ? String(d.partner_id) : `name:${d.party_name ?? ''}`;
    const direction = directionOf(d);
    const key = `${company}|${partnerKey}|${direction}`;
    const bucket = b.figures.aging_bucket;
    const g = groups.get(key) ?? {
      company,
      counterparty: String(b.item.party_name ?? ''),
      partner_id: d.partner_id ? String(d.partner_id) : null,
      direction,
      party_type: d.party_type,
      cells: Object.fromEntries(AGING_COLUMNS.map((c) => [c, { amount: 0n, count: 0 }])),
    };
    const cell = g.cells[bucket] ?? { amount: 0n, count: 0 };
    g.cells[bucket] = { amount: cell.amount + b.figures.remaining, count: cell.count + 1 };
    groups.set(key, g);
    totals.set(bucket, (totals.get(bucket) ?? 0n) + b.figures.remaining);
  }
  const companyNames = await loadCompanyNames([...groups.values()].map((g) => g.company));
  return {
    party_type: q.party_type ?? null,
    direction: q.direction ?? null,
    columns: AGING_COLUMNS.map((b) => ({ bucket: b, label: AGING_BUCKET_LABEL[b] })),
    rows: [...groups.values()].map((g) => {
      const cells = AGING_COLUMNS.map((b) => ({ bucket: b, amount: wireMoney(g.cells[b]?.amount ?? 0n), count: g.cells[b]?.count ?? 0 }));
      return {
        counterparty: g.counterparty,
        partner_id: g.partner_id,
        company_name: companyNames.get(g.company) ?? '',
        direction: g.direction,
        party_type: g.party_type,
        cells,
        total: wireMoney(AGING_COLUMNS.reduce((a, b) => a + (g.cells[b]?.amount ?? 0n), 0n)),
      };
    }),
    totals: AGING_COLUMNS.map((b) => ({ bucket: b, amount: wireMoney(totals.get(b) ?? 0n) })),
  };
}

/** Chi tiết khoản: chỉ tiêu + danh sách cấn trừ hiệu lực (kèm trạng thái phiếu) + lịch sử. */
export async function getDebtDetail(scope: ScopeLike, id: string) {
  const d = await loadDebtOrFail(id);
  assertInScope(scope.companyIds, String(d.company_id));
  const ctx = await debtContext([d]);
  const { item } = buildDebt(d, ctx);
  const links = await loadLinks({ to_type: 'debt_voucher', to_ids: [id], relations: ['offset'] });
  const docs = await loadDocs(links.map((l) => l.from_id));
  const offsetLinks = links.map((l) => offsetLinkRow(l, docs));
  return {
    ...item,
    offset_links: offsetLinks,
    history: d.history ?? [],
    /** Chứng từ nhúng (route chuẩn hoá thành đường dẫn tải). */
    attachments: d.attachments ?? [],
  };
}

export function offsetLinkRow(l: LinkRecord, docs: Map<string, DocRef>) {
  const doc = docs.get(l.from_id);
  return {
    _id: l._id,
    link_id: l._id,
    relation: l.relation,
    document_id: l.from_id,
    document_code: doc?.code ?? '',
    document_title: doc?.title ?? '',
    document_kind: doc?.kind ?? '',
    document_status: doc?.status ?? 'unknown',
    executed: doc?.status === 'paid',
    amount: wireMoney(allocationOf(l)),
    linked_at: l.created_at ? isoOf(l.created_at) : null,
    origin: l.origin,
    rule_code: l.rule_code,
    note: l.note,
  };
}

/** Tạo khoản công nợ: đối tác KH/NCC + hướng bắt buộc; TK 131/331 suy từ loại đối tác. */
export async function createDebt(actor: DebtActor, scope: ScopeLike, body: DebtCreateBody, meta: ReqMeta): Promise<{ _id: string; code: string }> {
  const companyId = body.company_id ?? actor.company_id;
  if (!companyId) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Chưa chọn công ty' });
  assertInScope(scope.companyIds, companyId);
  // Idempotency: gửi lại cùng request_id (retry sau timeout) ⇒ trả lại khoản đã tạo, không tạo trùng.
  if (body.request_id) {
    const prev = await Models.DebtVoucher.findOne({ company_id: companyId, 'history.request_id': body.request_id } as never)
      .select({ _id: 1, code: 1 })
      .lean<{ _id: unknown; code?: string } | null>();
    if (prev) return { _id: String(prev._id), code: String(prev.code ?? '') };
  }
  const minor = positiveMinor(body.value.amount_minor, 'value');
  const partner = await assertPartner(body.partner_id, companyId, DEBT_PARTNER_TYPES, { usage: 'Khoản công nợ' });
  const accountCode = accountCodeOfPartnerType(partner.type);
  if (!accountCode) throw new ApiError({ code: 'FG-PARTNER-001', detail: 'Khoản công nợ chỉ dùng cho Khách hàng hoặc Nhà cung cấp' });
  const side = resolveSide(body.direction, body.side);
  const code = await nextSequentialCode('CN');
  const who = { user_id: actor.user_id, role: actor.role ?? null, name: actor.name ?? null };
  const history = buildHistoryEntry({
    action: 'create',
    actor: who,
    to: null,
    ip: meta.ip ?? null,
    request_id: body.request_id ?? null,
    fields: { account_code: accountCode, side, direction: body.direction, partner_id: partner._id },
  });
  const created = await Models.DebtVoucher.create({
    code,
    company_id: companyId,
    party_type: partner.type,
    /* Bản sao hiển thị do server điền từ đối tác (model còn bắt buộc v1); đọc luôn lấy theo partner_id. */
    party_name: partner.name,
    party_bank_name: null,
    party_bank_account: null,
    partner_id: partner._id,
    direction: body.direction,
    account_code: accountCode,
    side,
    value_minor: minor,
    value: { minor, currency: body.value.currency, decimals: 0 },
    currency: body.value.currency,
    contract_code: body.contract_code ?? null,
    due_date: body.due_date,
    priority: body.priority,
    note: body.note ?? null,
    created_by: actor.user_id,
    history: [history],
  } as never);
  await emitDomainEvent({
    type: 'debt.created',
    company_id: companyId,
    subject_type: 'debt_voucher',
    subject_id: String(created._id),
    payload: { code, party_type: partner.type, side, direction: body.direction, value_minor: minor, currency: body.value.currency, partner_id: partner._id },
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
  });
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'debt.create',
    subject: { type: 'debt', id: String(created._id), code },
    company_id: companyId,
    ip: meta.ip ?? null,
  });
  return { _id: String(created._id), code };
}

/**
 * Sửa khoản công nợ. Đổi đối tác / hướng bị chặn khi đã có phiếu cấn trừ; giá trị không được nhỏ hơn
 * tổng đã phân bổ (kể cả phiếu chưa thực thi, để không cấn trừ quá số).
 */
export async function updateDebt(actor: DebtActor, scope: ScopeLike, id: string, body: DebtUpdateBody, meta: ReqMeta): Promise<{ changed: string[] }> {
  const d = await loadDebtOrFail(id);
  assertInScope(scope.companyIds, String(d.company_id));
  if (isReadOnlyDebt(d.party_type)) throw readOnlyDebtError();
  const companyId = String(d.company_id);
  const links = await loadLinks({ to_type: 'debt_voucher', to_ids: [id], relations: ['offset'] });
  // Đã phân bổ còn giữ sức chứa (phiếu đã huỷ / từ chối không giữ — v2 §9.2).
  const committed = (await reservingLinks(links)).reduce((s, l) => s + allocationOf(l), 0n);
  const set: Record<string, unknown> = { updated_at: new Date() };

  if (body.partner_id !== undefined && body.partner_id !== String(d.partner_id ?? '')) {
    if (links.length) throw new ApiError({ code: 'FG-PARTNER-003', detail: 'Khoản đã có phiếu cấn trừ — không đổi đối tác' });
    const partner = await assertPartner(body.partner_id, companyId, DEBT_PARTNER_TYPES, { usage: 'Khoản công nợ' });
    set.partner_id = partner._id;
    set.party_type = partner.type;
    set.account_code = accountCodeOfPartnerType(partner.type);
    set.party_name = partner.name;
  }

  const currentDirection = directionOf(d);
  let direction = currentDirection;
  if (body.direction !== undefined && body.direction !== currentDirection) {
    if (links.length) throw new ApiError({ code: 'FG-VAL-001', detail: 'Khoản đã có phiếu cấn trừ — không đổi hướng', errors: { direction: 'Đã có phiếu cấn trừ' } });
    direction = body.direction;
  }
  if (direction !== currentDirection || body.side !== undefined || !d.direction) {
    set.direction = direction;
    set.side = resolveSide(direction, body.side);
  }

  if (body.value) {
    const minor = positiveMinor(body.value.amount_minor, 'value');
    if (committed > minor) {
      throw new ApiError({
        code: 'FG-LINK-002',
        detail: 'Giá trị không được nhỏ hơn số đã phân bổ cấn trừ',
        errors: { value: 'Nhỏ hơn số đã cấn trừ' },
        data: { committed_minor: committed.toString() },
      });
    }
    const currency = body.value.currency ?? 'VND';
    set.value_minor = minor;
    set.value = { minor, currency, decimals: 0 };
    set.currency = currency;
  }
  if (body.due_date !== undefined) set.due_date = body.due_date;
  if (body.contract_code !== undefined) set.contract_code = body.contract_code || null;
  if (body.priority !== undefined) set.priority = body.priority;
  if (body.note !== undefined) set.note = body.note || null;

  // Lịch sử trước → sau cho từng trường thực sự đổi (v2 §2.3).
  const rawD = d as unknown as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const k of DEBT_TRACKED) {
    before[k] = rawD[k];
    after[k] = k in set ? set[k] : rawD[k];
  }
  const changes = changesOf(before, after);
  const changed = Object.keys(changes);
  if (!changed.length) return { changed };
  const history = buildHistoryEntry({
    action: 'update',
    actor: { user_id: actor.user_id, role: actor.role ?? null, name: actor.name ?? null },
    to: null,
    ip: meta.ip ?? null,
    request_id: meta.request_id ?? null,
    fields: { changed, changes },
  });
  await Models.DebtVoucher.updateOne({ _id: id }, { $set: set, $push: { history } } as never).exec();
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'debt.update',
    subject: { type: 'debt', id, code: String(d.code ?? '') },
    company_id: companyId,
    diff_fields: { changes },
    ip: meta.ip ?? null,
  });
  return { changed };
}

/**
 * Điều kiện xoá (v2 §2.3: không xoá vật lý đối tượng đã phát sinh tiền / đã gắn cấn trừ): chỉ xoá khoản
 * CHƯA TỪNG có liên kết cấn trừ — kể cả liên kết đã gỡ (giữ làm lịch sử). Đã có liên kết ⇒ gỡ / giữ nguyên.
 */
export async function assertDebtDeletable(scope: ScopeLike, d: DebtRaw): Promise<void> {
  assertInScope(scope.companyIds, String(d.company_id));
  if (isReadOnlyDebt(d.party_type)) throw readOnlyDebtError();
  const linked = await Models.BusinessLink.exists({
    $or: [{ to_type: 'debt_voucher', to_id: d._id }, { from_type: 'debt_voucher', from_id: d._id }],
  } as never);
  if (linked) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Khoản đã từng có liên kết cấn trừ (kể cả đã gỡ) — không xoá, giữ làm lịch sử' });
  }
}

/** Xoá bản ghi khoản công nợ (sau khi `assertDebtDeletable`). Không có liên kết nào để xoá theo. */
export async function deleteDebtRecord(id: string): Promise<void> {
  await Models.DebtVoucher.deleteOne({ _id: id } as never).exec();
}

/** Gán một phiếu thu/chi để cấn trừ khoản công nợ (quan hệ `offset`, qua `createLink`). */
export async function assignOffset(
  actor: DebtActor,
  scope: ScopeLike,
  debtId: string,
  body: { document_id: string; amount_minor?: string; note?: string },
  meta: ReqMeta,
): Promise<{ _id: string }> {
  const d = await loadDebtOrFail(debtId);
  assertInScope(scope.companyIds, String(d.company_id));
  if (isReadOnlyDebt(d.party_type)) throw readOnlyDebtError();
  if (!d.partner_id) throw new ApiError({ code: 'FG-PARTNER-001', detail: 'Khoản công nợ chưa gắn đối tác' });
  const direction = directionOf(d);

  const doc = (await loadDocs([body.document_id])).get(body.document_id);
  if (!doc) throw new ApiError({ code: 'FG-VAL-001', errors: { document_id: 'Không tìm thấy hồ sơ' } });
  assertInScope(scope.companyIds, doc.company_id);
  assertOffsetDirection(direction, doc.kind);
  assertLinkableDocStatus(doc.status);
  if (doc.partner_id !== String(d.partner_id)) throw new ApiError({ code: 'FG-LINK-001', detail: 'Phiếu và khoản công nợ phải cùng đối tác' });

  let amount: bigint;
  if (body.amount_minor !== undefined) {
    amount = positiveMinor(body.amount_minor, 'amount_minor', 'Số tiền phân bổ phải lớn hơn 0');
  } else {
    const docUsed = await documentAllocatedTotalOf(doc._id);
    const debtLinks = await reservingLinks(await loadLinks({ to_type: 'debt_voucher', to_ids: [debtId], relations: ['offset'] }));
    const committed = debtLinks.reduce((s, l) => s + allocationOf(l), 0n);
    amount = defaultAllocation(doc.amount_minor - docUsed, toBigSafe(d.value_minor) - committed);
  }

  const link = await createLink({
    from: { type: 'document', id: doc._id },
    to: { type: 'debt_voucher', id: debtId },
    relation: 'offset',
    amount_minor: amount,
    note: body.note ?? null,
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    scopeCompanyIds: scope.companyIds,
    request_id: meta.request_id ?? null,
    ip: meta.ip ?? null,
  });
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'debt.link',
    subject: { type: 'debt', id: debtId, code: String(d.code ?? '') },
    company_id: String(d.company_id),
    diff_fields: { document_id: doc._id, amount_minor: amount.toString() },
    ip: meta.ip ?? null,
  });
  return { _id: link._id };
}

/** Gỡ một cấn trừ (đánh dấu removed, có người + lý do). Liên kết phải thuộc đúng khoản này. */
export async function unassignOffset(actor: DebtActor, scope: ScopeLike, debtId: string, linkId: string, reason: string, meta: ReqMeta): Promise<void> {
  const d = await loadDebtOrFail(debtId);
  assertInScope(scope.companyIds, String(d.company_id));
  const link = validIds([linkId]).length ? await Models.BusinessLink.findById(linkId).lean<Record<string, unknown> | null>() : null;
  if (!link || link.relation !== 'offset' || link.to_type !== 'debt_voucher' || String(link.to_id) !== debtId) {
    throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy liên kết' });
  }
  await removeLink({
    link_id: linkId,
    reason,
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    scopeCompanyIds: scope.companyIds,
    request_id: meta.request_id ?? null,
    ip: meta.ip ?? null,
  });
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null },
    action: 'debt.unlink',
    subject: { type: 'debt', id: debtId, code: String(d.code ?? '') },
    company_id: String(d.company_id),
    diff_fields: { link_id: linkId, reason },
    ip: meta.ip ?? null,
  });
}

/** Phiếu thu (phải thu) / phiếu chi (phải trả) cùng đối tác, còn có thể phân bổ. */
export async function offsetCandidates(scope: ScopeLike, debtId: string, q: string | undefined) {
  const d = await loadDebtOrFail(debtId);
  assertInScope(scope.companyIds, String(d.company_id));
  if (!d.partner_id) return [];
  return documentCandidates({
    companyId: String(d.company_id),
    partnerId: String(d.partner_id),
    kind: docKindForDirection(directionOf(d)),
    q,
    forType: 'debt_voucher',
    forId: debtId,
    relation: 'offset',
  });
}


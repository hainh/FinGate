/**
 * Nạp dữ liệu THEO LÔ cho công nợ & nợ ngân hàng (không N+1), kiểm tra đối tác và danh sách phiếu ứng viên.
 * Mọi truy vấn nghiệp vụ lọc theo công ty (qua phạm vi của người gọi hoặc `company_id` của bản ghi).
 */

import { ApiError, PARTNER_TYPE_LABEL, type PartnerType } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import {
  AMOUNT_RELATIONS,
  allocationOf,
  principalPartOf,
  toLinkRecord,
  type LinkObjectType,
  type LinkRecord,
  type LinkRelation,
} from '../links/index.ts';
import { UNLINKABLE_DOC_STATUSES, escapeRegex, wireMoney } from './rules.ts';

type RawLink = Parameters<typeof toLinkRecord>[0];

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** Danh sách ID hợp lệ, không trùng (bỏ giá trị lỗi thay vì ném — truy vấn sẽ không khớp gì). */
export function validIds(ids: Iterable<unknown>): string[] {
  const out = new Set<string>();
  for (const raw of ids) {
    const s = String(raw ?? '');
    if (OBJECT_ID_RE.test(s)) out.add(s);
  }
  return [...out];
}

/** Phạm vi công ty: null = toàn tập đoàn. */
export function inScope(scopeCompanyIds: string[] | null | undefined, companyId: string | null | undefined): boolean {
  if (scopeCompanyIds === null || scopeCompanyIds === undefined) return true;
  return Boolean(companyId) && scopeCompanyIds.includes(String(companyId));
}

export function assertInScope(scopeCompanyIds: string[] | null | undefined, companyId: string | null | undefined): void {
  if (!inScope(scopeCompanyIds, companyId)) throw new ApiError({ code: 'FG-RBAC-002' });
}

export interface PartnerRef {
  _id: string;
  company_id: string;
  code: string;
  name: string;
  type: string;
  status: string;
  bank_name: string | null;
  account_number: string | null;
  tax_code: string | null;
}

function toPartnerRef(p: Record<string, unknown>): PartnerRef {
  return {
    _id: String(p._id),
    company_id: String(p.company_id ?? ''),
    code: String(p.code ?? ''),
    name: String(p.name ?? ''),
    type: String(p.type ?? ''),
    status: String(p.status ?? 'active'),
    bank_name: (p.bank_name as string | null | undefined) ?? null,
    account_number: (p.account_number as string | null | undefined) ?? null,
    tax_code: (p.tax_code as string | null | undefined) ?? null,
  };
}

const PARTNER_FIELDS = { company_id: 1, code: 1, name: 1, type: 1, status: 1, bank_name: 1, account_number: 1, tax_code: 1 } as const;

export async function loadPartners(ids: Iterable<unknown>): Promise<Map<string, PartnerRef>> {
  const list = validIds(ids);
  if (!list.length) return new Map();
  const rows = await Models.Partner.find({ _id: { $in: list } } as never)
    .select(PARTNER_FIELDS)
    .lean<Record<string, unknown>[]>();
  return new Map(rows.map((p) => [String(p._id), toPartnerRef(p)]));
}

export async function loadCompanyNames(ids: Iterable<unknown>): Promise<Map<string, string>> {
  const list = validIds(ids);
  if (!list.length) return new Map();
  const companies = await Models.Company.find({ _id: { $in: list } } as never).select({ name: 1 }).lean<{ _id: unknown; name?: string }[]>();
  return new Map(companies.map((c) => [String(c._id), String(c.name ?? '')]));
}

/** Đối tác đúng công ty, đang hoạt động và đúng loại; sai ⇒ FG-PARTNER-001 (422). */
export async function assertPartner(
  partnerId: string,
  companyId: string,
  allowedTypes: readonly string[],
  opts: { usage: string; requireActive?: boolean } = { usage: 'khoản này' },
): Promise<PartnerRef> {
  const p = await Models.Partner.findOne({ _id: partnerId, company_id: companyId } as never).select(PARTNER_FIELDS).lean<Record<string, unknown> | null>();
  if (!p) {
    throw new ApiError({ code: 'FG-PARTNER-001', detail: 'Đối tác không tồn tại trong công ty này', errors: { partner_id: 'Không tìm thấy đối tác' } });
  }
  const ref = toPartnerRef(p);
  if ((opts.requireActive ?? true) && ref.status !== 'active') {
    throw new ApiError({ code: 'FG-PARTNER-001', detail: 'Đối tác đang ngừng giao dịch — không chọn cho khoản mới', errors: { partner_id: 'Ngừng giao dịch' } });
  }
  if (!allowedTypes.includes(ref.type)) {
    const want = allowedTypes.map((t) => PARTNER_TYPE_LABEL[t as PartnerType] ?? t).join(' hoặc ');
    const got = PARTNER_TYPE_LABEL[ref.type as PartnerType] ?? ref.type;
    throw new ApiError({
      code: 'FG-PARTNER-001',
      detail: `${opts.usage} chỉ dùng đối tác loại ${want} (đang chọn: ${got})`,
      errors: { partner_id: `Chọn đối tác loại ${want}` },
    });
  }
  return ref;
}

/** Phiếu nguồn (đã nạp các trường cần cho chỉ tiêu và kiểm tra quy tắc). */
export interface DocRef {
  _id: string;
  company_id: string;
  code: string;
  title: string;
  kind: string;
  status: string;
  partner_id: string | null;
  amount_minor: bigint;
  actual_minor: bigint | null;
  paid_at: string | null;
}

export async function loadDocs(ids: Iterable<unknown>): Promise<Map<string, DocRef>> {
  const list = validIds(ids);
  if (!list.length) return new Map();
  const rows = await Models.Document.find({ _id: { $in: list } } as never)
    .select({ code: 1, title: 1, kind: 1, status: 1, company_id: 1, partner_id: 1, amount: 1, 'execution.paid_at': 1, 'execution.actual_amount_minor': 1 })
    .lean<Record<string, unknown>[]>();
  const out = new Map<string, DocRef>();
  for (const d of rows) {
    const amount = (d.amount ?? {}) as { minor?: unknown };
    const exec = (d.execution ?? {}) as { paid_at?: string | null; actual_amount_minor?: unknown };
    out.set(String(d._id), {
      _id: String(d._id),
      company_id: String(d.company_id ?? ''),
      code: String(d.code ?? ''),
      title: String(d.title ?? ''),
      kind: String(d.kind ?? ''),
      status: String(d.status ?? ''),
      partner_id: d.partner_id ? String(d.partner_id) : null,
      amount_minor: toBigSafe(amount.minor),
      actual_minor: exec.actual_amount_minor === null || exec.actual_amount_minor === undefined ? null : toBigSafe(exec.actual_amount_minor),
      paid_at: exec.paid_at ?? null,
    });
  }
  return out;
}

function toBigSafe(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

/** Liên kết HIỆU LỰC (status = active) theo đầu đích và/hoặc đầu nguồn. */
export async function loadLinks(f: {
  to_type?: LinkObjectType;
  to_ids?: Iterable<unknown>;
  from_type?: LinkObjectType;
  from_ids?: Iterable<unknown>;
  relations?: readonly LinkRelation[];
  include_removed?: boolean;
}): Promise<LinkRecord[]> {
  const q: Record<string, unknown> = {};
  if (f.to_type) {
    const ids = validIds(f.to_ids ?? []);
    if (!ids.length) return [];
    q.to_type = f.to_type;
    q.to_id = { $in: ids };
  }
  if (f.from_type) {
    const ids = validIds(f.from_ids ?? []);
    if (!ids.length) return [];
    q.from_type = f.from_type;
    q.from_id = { $in: ids };
  }
  if (f.relations) q.relation = { $in: [...f.relations] };
  if (!f.include_removed) q.status = 'active';
  const rows = await Models.BusinessLink.find(q as never).sort({ created_at: 1 }).lean<RawLink[]>();
  return rows.map(toLinkRecord);
}

/** Σ theo khoá: `keyOf` (đầu đích/nguồn), `pick` (số tiền), `include` (lọc, vd phiếu đã thực thi). */
export function sumBy(
  links: readonly LinkRecord[],
  keyOf: (l: LinkRecord) => string,
  pick: (l: LinkRecord) => bigint,
  include: (l: LinkRecord) => boolean = () => true,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const l of links) {
    if (!include(l)) continue;
    const k = keyOf(l);
    out.set(k, (out.get(k) ?? 0n) + pick(l));
  }
  return out;
}

export const isExecuted = (docs: Map<string, DocRef>) => (l: LinkRecord) => docs.get(l.from_id)?.status === 'paid';

/** Phần GỐC / LÃI / PHÍ đã trả (chỉ phiếu chi đã thực thi) theo khoản vay. */
export function paidRepaymentParts(
  repayments: readonly LinkRecord[],
  docs: Map<string, DocRef>,
): { principal: Map<string, bigint>; interest: Map<string, bigint>; fee: Map<string, bigint> } {
  const paid = isExecuted(docs);
  return {
    principal: sumBy(repayments, (l) => l.to_id, principalPartOf, paid),
    interest: sumBy(repayments, (l) => l.to_id, (l) => l.split?.interest ?? 0n, paid),
    fee: sumBy(repayments, (l) => l.to_id, (l) => l.split?.fee ?? 0n, paid),
  };
}

export const lastPaidAt = (docs: Map<string, DocRef>, links: readonly LinkRecord[]): string | null => {
  let best: string | null = null;
  for (const l of links) {
    const d = docs.get(l.from_id);
    if (d?.status === 'paid' && d.paid_at && (!best || d.paid_at > best)) best = d.paid_at;
  }
  return best;
};

/** Hồ sơ ứng viên để cấn trừ / trả nợ / giải ngân — cùng công ty, cùng đối tác, đúng loại phiếu. */
export interface CandidateQuery {
  companyId: string;
  partnerId: string;
  kind: 'income' | 'spend';
  q?: string;
  forType: LinkObjectType;
  forId: string;
  relation: LinkRelation;
  limit?: number;
}

export async function documentCandidates(c: CandidateQuery) {
  const filter: Record<string, unknown> = {
    company_id: c.companyId,
    partner_id: c.partnerId,
    kind: c.kind,
    status: { $nin: [...UNLINKABLE_DOC_STATUSES] },
  };
  if (c.q) {
    const rx = { $regex: escapeRegex(c.q), $options: 'i' };
    filter.$or = [{ code: rx }, { title: rx }];
  }
  const rows = await Models.Document.find(filter as never)
    .sort({ updated_at: -1 })
    .limit(c.limit ?? 50)
    .select({ code: 1, title: 1, kind: 1, status: 1, amount: 1 })
    .lean<Record<string, unknown>[]>();
  const ids = rows.map((r) => String(r._id));
  const allocLinks = await loadLinks({ from_type: 'document', from_ids: ids, relations: AMOUNT_RELATIONS });
  const allocated = sumBy(allocLinks, (l) => l.from_id, allocationOf);
  const sameRelation = await loadLinks({ from_type: 'document', from_ids: ids, relations: [c.relation] });
  const linked = new Set(sameRelation.filter((l) => l.to_type === c.forType && l.to_id === c.forId).map((l) => l.from_id));
  return rows.map((r) => {
    const id = String(r._id);
    const amount = toBigSafe((r.amount as { minor?: unknown } | undefined)?.minor);
    const used = allocated.get(id) ?? 0n;
    const free = amount - used > 0n ? amount - used : 0n;
    return {
      _id: id,
      code: String(r.code ?? ''),
      title: String(r.title ?? ''),
      kind: String(r.kind ?? ''),
      status: String(r.status ?? ''),
      amount: wireMoney(amount),
      allocated: wireMoney(used),
      unallocated: wireMoney(free),
      already_linked: linked.has(id),
    };
  });
}

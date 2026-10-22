/**
 * Liên kết nghiệp vụ (v2/v2.md §11.2, §9.2, §10.3, §14.3 (5)) — bảng `business_links`.
 *
 * - `createLink` / `removeLink` / `listLinksFor`: thao tác có kiểm tra quy tắc (công ty, đối tác, loại,
 *   tổng phân bổ, trùng cặp). Gỡ = đánh dấu `removed` (không xoá), có người + lý do.
 * - Chỉ tiêu KHÔNG LƯU: `documentAllocatedTotal`, `debtOffsetApplied`, `debtRemaining`,
 *   `loanRepaidPrincipal`, `loanOutstanding` — tính từ liên kết HIỆU LỰC + trạng thái phiếu đã thực thi.
 * - Kiểm tra sức chứa (tổng phân bổ ≤ giới hạn) dùng liên kết HIỆU LỰC, KHÔNG phụ thuộc phiếu đã paid —
 *   để không cấn trừ quá số. Chỉ tiêu "đã cấn trừ / đã trả" mới chỉ tính khi phiếu paid.
 * - Phạm vi công ty: hàm nhận `scopeCompanyIds` (null = toàn tập đoàn). Quyền `link:manage` do tầng route kiểm.
 */

import {
  ApiError,
  BUSINESS_LINK_RELATION_LABEL,
  LINK_OBJECT_TYPE_LABEL,
  PARTNER_TYPE_LABEL,
  formatMoney,
  money,
  type PartnerType,
} from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { mirrorAudit } from '../audit/index.ts';
import { emitDomainEvent } from '../events/index.ts';
import { assertOffsetDirection, directionOf, type DebtDirection } from '../debt/rules.ts';

/* ================================================================== *
 * Kiểu
 * ================================================================== */

export type LinkObjectType = 'document' | 'debt_voucher' | 'bank_debt';
export type LinkRelation = 'offset' | 'repayment' | 'disbursement' | 'funded_by' | 'generated' | 'internal_transfer';
export type LinkOrigin = 'manual' | 'automation';
export type LinkStatus = 'active' | 'removed';

export interface LinkSplit {
  principal: bigint;
  interest: bigint;
  fee: bigint;
}

/** Liên kết ở dạng domain (BigInt đã chuẩn hoá). */
export interface LinkRecord {
  _id: string;
  company_id: string;
  from_type: LinkObjectType;
  from_id: string;
  to_type: LinkObjectType;
  to_id: string;
  relation: LinkRelation;
  amount_minor: bigint | null;
  split: LinkSplit | null;
  origin: LinkOrigin;
  run_id: string | null;
  rule_code: string | null;
  status: LinkStatus;
  note: string | null;
  created_by: string | null;
  created_at: Date;
  removed_by: string | null;
  removed_at: Date | null;
  removed_reason: string | null;
}

/** Đối tượng đầu liên kết, đã nạp đủ thông tin để kiểm tra quy tắc. */
export interface LinkEndpoint {
  type: LinkObjectType;
  id: string;
  company_id: string;
  code: string;
  partner_id: string | null;
  /** loại đối tác (`bank` | `customer` | `supplier`) — null nếu chưa có đối tác. */
  partner_type: string | null;
  /** Tổng tiền của đối tượng: phiếu = số tiền; công nợ = giá trị; khoản vay = gốc. */
  total_minor: bigint;
  /** Phiếu: `spend` | `income` | `rollover` | `internal`; đối tượng khác: null. */
  kind: string | null;
  /** Phiếu: trạng thái hồ sơ; khoản vay: trạng thái; công nợ: null. */
  status: string | null;
  /** Khoản công nợ: hướng (`receivable` phải thu / `payable` phải trả); đối tượng khác: không có. */
  direction?: DebtDirection | null;
}

export interface LinkActor {
  user_id: string | null;
  name?: string | null;
  role?: string | null;
}

export interface RelationSpec {
  from: LinkObjectType[];
  to: LinkObjectType[];
  fromKinds?: string[];
  toKinds?: string[];
  fromPartnerTypes?: string[];
  toPartnerTypes?: string[];
  /** quan hệ mang tiền (phân bổ). */
  amount: boolean;
  /** đối tác hai đầu phải có và trùng nhau. */
  partnerMatch: boolean;
  /** hai đầu cùng công ty (trừ chuyển nội bộ). */
  sameCompany: boolean;
}

/* ================================================================== *
 * Quy tắc theo quan hệ (v2 §11.2 bảng quan hệ + quy tắc kiểm tra khi gán)
 * ================================================================== */

/** Quan hệ mang tiền: đầu `from` là PHIẾU, số tiền phân bổ tính vào chỉ tiêu. */
export const AMOUNT_RELATIONS: readonly LinkRelation[] = ['offset', 'repayment', 'disbursement', 'funded_by'];

/** Phiếu đã thực thi — chỉ khi đó liên kết cấn trừ / trả nợ có hiệu lực (§11.2). */
export const EXECUTED_DOCUMENT_STATUSES: readonly string[] = ['paid'];

/**
 * Phiếu đã NHẢ sức chứa: huỷ / từ chối / hết hạn. Liên kết của phiếu này không còn giữ số tiền
 * công nợ / khoản vay (v2 §9.2 "huỷ phiếu → số còn lại tính lại ngay", §11.2 "chỉ tiêu tự đúng").
 */
export const RELEASED_DOCUMENT_STATUSES: readonly string[] = ['cancelled', 'rejected', 'expired'];

/** Khoản vay không tính vào dư nợ (§10.2). */
const NON_OUTSTANDING_LOAN_STATUSES: readonly string[] = ['pending_disbursement', 'cancelled'];

export const RELATION_SPECS: Record<LinkRelation, RelationSpec> = {
  offset: {
    from: ['document'],
    to: ['debt_voucher'],
    fromKinds: ['spend', 'income'],
    toPartnerTypes: ['customer', 'supplier'],
    amount: true,
    partnerMatch: true,
    sameCompany: true,
  },
  repayment: {
    from: ['document'],
    to: ['bank_debt'],
    fromKinds: ['spend'],
    fromPartnerTypes: ['bank'],
    toPartnerTypes: ['bank'],
    amount: true,
    partnerMatch: true,
    sameCompany: true,
  },
  disbursement: {
    from: ['document'],
    to: ['bank_debt'],
    fromKinds: ['income'],
    fromPartnerTypes: ['bank'],
    toPartnerTypes: ['bank'],
    amount: true,
    partnerMatch: true,
    sameCompany: true,
  },
  funded_by: {
    from: ['document'],
    to: ['bank_debt'],
    fromKinds: ['spend'],
    toPartnerTypes: ['bank'],
    amount: true,
    partnerMatch: false,
    sameCompany: true,
  },
  generated: {
    from: ['document', 'debt_voucher', 'bank_debt'],
    to: ['document', 'bank_debt', 'debt_voucher'],
    amount: false,
    partnerMatch: false,
    sameCompany: true,
  },
  internal_transfer: {
    from: ['document'],
    to: ['document'],
    fromKinds: ['spend'],
    toKinds: ['income'],
    amount: false,
    partnerMatch: false,
    sameCompany: false,
  },
};

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Chuyển giá trị Mongo (BigInt / số / chuỗi / null) sang bigint, an toàn. */
export function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (v === null || v === undefined || v === '') return 0n;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? BigInt(v) : 0n;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return 0n;
}

/** Nhãn tiếng Việt của danh sách loại đối tác: "Ngân hàng hoặc Khách hàng". */
function partnerTypeLabels(values: readonly string[]): string {
  return values.map((t) => PARTNER_TYPE_LABEL[t as PartnerType] ?? t).join(' hoặc ');
}

/**
 * Kiểm tra cấu trúc liên kết (thuần — không chạm DB): loại đối tượng, phiếu nguồn/đích,
 * cùng công ty, đối tác khớp và đúng loại. Ném `FG-LINK-001` nếu sai.
 */
export function assertRelationRules(relation: LinkRelation, from: LinkEndpoint, to: LinkEndpoint): void {
  const spec = RELATION_SPECS[relation];
  const rel = BUSINESS_LINK_RELATION_LABEL[relation];
  const fail = (detail: string): never => {
    throw new ApiError({ code: 'FG-LINK-001', detail });
  };
  if (from.type === to.type && from.id === to.id) fail('Không thể liên kết một đối tượng với chính nó');
  if (!spec.from.includes(from.type)) fail(`"${rel}" không áp dụng khi đầu nguồn là ${LINK_OBJECT_TYPE_LABEL[from.type]}`);
  if (!spec.to.includes(to.type)) fail(`"${rel}" không áp dụng khi đầu đích là ${LINK_OBJECT_TYPE_LABEL[to.type]}`);
  if (spec.fromKinds && !(from.kind && spec.fromKinds.includes(from.kind))) {
    fail(`"${rel}" chỉ áp dụng cho phiếu ${spec.fromKinds.join(' / ')} ở đầu nguồn`);
  }
  if (spec.toKinds && !(to.kind && spec.toKinds.includes(to.kind))) {
    fail(`"${rel}" chỉ áp dụng cho phiếu ${spec.toKinds.join(' / ')} ở đầu đích`);
  }
  if (spec.sameCompany && from.company_id !== to.company_id) fail('Hai đối tượng phải cùng công ty');
  if (!spec.sameCompany && from.company_id === to.company_id) fail('Chuyển nội bộ phải giữa hai công ty khác nhau');
  if (spec.fromPartnerTypes && !(from.partner_type && spec.fromPartnerTypes.includes(from.partner_type))) {
    fail(from.partner_type ? `Đối tác đầu nguồn phải là ${partnerTypeLabels(spec.fromPartnerTypes)}` : 'Đối tượng đầu nguồn chưa gắn đối tác');
  }
  if (spec.toPartnerTypes && !(to.partner_type && spec.toPartnerTypes.includes(to.partner_type))) {
    fail(to.partner_type ? `Đối tác đầu đích phải là ${partnerTypeLabels(spec.toPartnerTypes)}` : 'Đối tượng đầu đích chưa gắn đối tác');
  }
  if (spec.partnerMatch) {
    if (!from.partner_id || !to.partner_id) fail('Cả hai đối tượng phải đã gắn đối tác');
    if (from.partner_id !== to.partner_id) fail('Đối tác của hai đối tượng không khớp');
  }
  // cấn trừ đúng hướng từ CẢ HAI phía (v2 §9.2, §11.2): phiếu thu ↔ phải thu, phiếu chi ↔ phải trả
  if (relation === 'offset' && to.type === 'debt_voucher' && to.direction) assertOffsetDirection(to.direction, from.kind);
}

/* ================================================================== *
 * Tiền: phân bổ, gốc, tách
 * ================================================================== */

/** Số tiền phân bổ thực tế của một liên kết: tổng ba phần nếu có tách, không thì số tiền. */
export function allocationOf(link: { amount_minor: bigint | null; split: LinkSplit | null }): bigint {
  if (link.split) return link.split.principal + link.split.interest + link.split.fee;
  return link.amount_minor ?? 0n;
}

/** Phần GỐC của liên kết trả nợ (dư nợ chỉ trừ phần này): có tách thì lấy gốc, không thì cả số tiền. */
export function principalPartOf(link: { amount_minor: bigint | null; split: LinkSplit | null }): bigint {
  if (link.split) return link.split.principal;
  return link.amount_minor ?? 0n;
}

/** Chuẩn hoá số tiền đầu vào: tách → số tiền = tổng ba phần (phải khớp nếu có `amount_minor`). */
export function normalizeAmount(input: { amount_minor: bigint | null; split: LinkSplit | null }): {
  amount: bigint | null;
  split: LinkSplit | null;
} {
  if (input.split) {
    const sum = input.split.principal + input.split.interest + input.split.fee;
    if (input.amount_minor !== null && input.amount_minor !== sum) {
      throw new ApiError({ code: 'FG-VAL-001', detail: 'Tổng gốc + lãi + phí phải bằng số tiền phân bổ', errors: { split: 'Tổng không khớp' } });
    }
    return { amount: sum, split: input.split };
  }
  return { amount: input.amount_minor, split: null };
}

/** Kiểm tra sức chứa: tổng hiện có + phần thêm không được vượt giới hạn. Ném `FG-LINK-002`. */
export function assertWithinCapacity(params: { limit: bigint; committed: bigint; add: bigint; what: string; currency?: string }): void {
  const remaining = params.limit - params.committed > 0n ? params.limit - params.committed : 0n;
  if (params.add > remaining) {
    const cur = params.currency ?? 'VND';
    throw new ApiError({
      code: 'FG-LINK-002',
      detail: `${params.what} chỉ còn ${formatMoney(money(remaining, cur), { mode: 'compact' })} — không đủ cho ${formatMoney(money(params.add, cur), { mode: 'compact' })}`,
      data: { remaining_minor: remaining.toString(), add_minor: params.add.toString() },
    });
  }
}

/* ================================================================== *
 * Chỉ tiêu suy ra — thuần (nhận dữ liệu đã nạp)
 * ================================================================== */

/** Σ phân bổ HIỆU LỰC của mọi liên kết từ một phiếu (mọi trạng thái phiếu). */
export function documentAllocatedTotal(links: LinkRecord[], documentId: string): bigint {
  let sum = 0n;
  for (const l of links) {
    if (l.status !== 'active' || l.from_type !== 'document' || l.from_id !== documentId) continue;
    if (!AMOUNT_RELATIONS.includes(l.relation)) continue;
    sum += allocationOf(l);
  }
  return sum;
}

/** Đã cấn trừ (hiệu lực): Σ offset tới khoản công nợ mà PHIẾU NGUỒN đã thực thi. */
export function debtOffsetAppliedFrom(links: LinkRecord[], debtVoucherId: string, executedDocIds: ReadonlySet<string>): bigint {
  let sum = 0n;
  for (const l of links) {
    if (l.status !== 'active' || l.relation !== 'offset') continue;
    if (l.to_type !== 'debt_voucher' || l.to_id !== debtVoucherId) continue;
    if (!executedDocIds.has(l.from_id)) continue;
    sum += allocationOf(l);
  }
  return sum;
}

/** Còn phải thu / phải trả = giá trị − đã cấn trừ (hiệu lực), không âm. */
export function debtRemainingOf(valueMinor: bigint, appliedMinor: bigint): bigint {
  const r = valueMinor - appliedMinor;
  return r > 0n ? r : 0n;
}

/** Gốc đã trả (hiệu lực): Σ phần gốc của liên kết trả nợ từ phiếu đã thực thi. */
export function loanRepaidPrincipalFrom(links: LinkRecord[], bankDebtId: string, executedDocIds: ReadonlySet<string>): bigint {
  let sum = 0n;
  for (const l of links) {
    if (l.status !== 'active' || l.relation !== 'repayment') continue;
    if (l.to_type !== 'bank_debt' || l.to_id !== bankDebtId) continue;
    if (!executedDocIds.has(l.from_id)) continue;
    sum += principalPartOf(l);
  }
  return sum;
}

/** Dư nợ = gốc − gốc đã trả; khoản chờ giải ngân / đã huỷ = 0 (§10.2). Không âm. */
export function loanOutstandingOf(principalMinor: bigint, repaidPrincipalMinor: bigint, status: string | null): bigint {
  if (status && NON_OUTSTANDING_LOAN_STATUSES.includes(status)) return 0n;
  const r = principalMinor - repaidPrincipalMinor;
  return r > 0n ? r : 0n;
}

/* ================================================================== *
 * Nạp dữ liệu & truy vấn (có phạm vi công ty)
 * ================================================================== */

function assertScope(scopeCompanyIds: string[] | null | undefined, companyIds: string[]): void {
  if (scopeCompanyIds === null || scopeCompanyIds === undefined) return;
  for (const c of companyIds) {
    if (!scopeCompanyIds.includes(c)) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Đối tượng nằm ngoài phạm vi công ty của bạn' });
  }
}

async function partnerTypeOf(partnerId: unknown): Promise<string | null> {
  if (!partnerId) return null;
  const p = await Models.Partner.findById(String(partnerId)).select({ type: 1 }).lean<{ type?: string } | null>();
  return p?.type ?? null;
}

async function notFound(what: string): Promise<never> {
  throw new ApiError({ code: 'FG-VAL-001', status: 404, detail: `Không tìm thấy ${what}` });
}

/** Nạp một đầu liên kết theo loại + ID (kiểm tra định dạng ID trước). */
export async function loadEndpoint(type: LinkObjectType, id: string): Promise<LinkEndpoint> {
  if (!OBJECT_ID_RE.test(id)) return notFound('đối tượng');
  if (type === 'document') {
    const d = await Models.Document.findById(id)
      .select({ code: 1, kind: 1, status: 1, company_id: 1, partner_id: 1, amount: 1 })
      .lean<{ code?: string; kind?: string; status?: string; company_id: unknown; partner_id?: unknown; amount?: { minor?: unknown } } | null>();
    if (!d) return notFound('phiếu');
    return {
      type,
      id,
      company_id: String(d.company_id),
      code: String(d.code ?? id),
      partner_id: strOrNull(d.partner_id),
      partner_type: await partnerTypeOf(d.partner_id),
      total_minor: toBig(d.amount?.minor),
      kind: d.kind ?? null,
      status: d.status ?? null,
    };
  }
  if (type === 'debt_voucher') {
    const d = await Models.DebtVoucher.findById(id)
      .select({ code: 1, company_id: 1, partner_id: 1, value_minor: 1, direction: 1, side: 1 })
      .lean<{ code?: string; company_id: unknown; partner_id?: unknown; value_minor?: unknown; direction?: string | null; side?: string | null } | null>();
    if (!d) return notFound('khoản công nợ');
    return {
      type,
      id,
      company_id: String(d.company_id),
      code: String(d.code ?? id),
      partner_id: strOrNull(d.partner_id),
      partner_type: await partnerTypeOf(d.partner_id),
      total_minor: toBig(d.value_minor),
      kind: null,
      status: null,
      direction: directionOf(d),
    };
  }
  const b = await Models.BankDebt.findById(id)
    .select({ code: 1, company_id: 1, partner_id: 1, principal_minor: 1, status: 1 })
    .lean<{ code?: string; company_id: unknown; partner_id?: unknown; principal_minor?: unknown; status?: string } | null>();
  if (!b) return notFound('khoản nợ ngân hàng');
  return {
    type,
    id,
    company_id: String(b.company_id),
    code: String(b.code ?? id),
    partner_id: strOrNull(b.partner_id),
    partner_type: await partnerTypeOf(b.partner_id),
    total_minor: toBig(b.principal_minor),
    kind: null,
    status: b.status ?? null,
  };
}

interface RawLink {
  _id: unknown;
  company_id: unknown;
  from_type: LinkObjectType;
  from_id: unknown;
  to_type: LinkObjectType;
  to_id: unknown;
  relation: LinkRelation;
  amount_minor?: unknown;
  split?: { principal?: unknown; interest?: unknown; fee?: unknown } | null;
  origin?: LinkOrigin | null;
  run_id?: unknown;
  rule_code?: string | null;
  status: LinkStatus;
  note?: string | null;
  created_by?: unknown;
  created_at: Date;
  removed_by?: unknown;
  removed_at?: Date | null;
  removed_reason?: string | null;
}

/** Đổi bản ghi Mongo sang `LinkRecord`. */
export function toLinkRecord(raw: RawLink): LinkRecord {
  return {
    _id: String(raw._id),
    company_id: String(raw.company_id),
    from_type: raw.from_type,
    from_id: String(raw.from_id),
    to_type: raw.to_type,
    to_id: String(raw.to_id),
    relation: raw.relation,
    amount_minor: raw.amount_minor === null || raw.amount_minor === undefined ? null : toBig(raw.amount_minor),
    split: raw.split
      ? { principal: toBig(raw.split.principal), interest: toBig(raw.split.interest), fee: toBig(raw.split.fee) }
      : null,
    origin: raw.origin ?? 'manual',
    run_id: strOrNull(raw.run_id),
    rule_code: raw.rule_code ?? null,
    status: raw.status,
    note: raw.note ?? null,
    created_by: strOrNull(raw.created_by),
    created_at: raw.created_at,
    removed_by: strOrNull(raw.removed_by),
    removed_at: raw.removed_at ?? null,
    removed_reason: raw.removed_reason ?? null,
  };
}

/** Các phiếu trong danh sách đã ở trạng thái thực thi. */
async function executedDocumentIds(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter((id) => OBJECT_ID_RE.test(id));
  if (unique.length === 0) return new Set();
  const rows = await Models.Document.find({ _id: { $in: unique }, status: { $in: [...EXECUTED_DOCUMENT_STATUSES] } } as never)
    .select({ _id: 1 })
    .lean<{ _id: unknown }[]>();
  return new Set(rows.map((r) => String(r._id)));
}

/**
 * Liên kết liên quan đến một đối tượng (ở đầu nguồn hoặc đích). Mặc định chỉ liên kết HIỆU LỰC.
 * `scopeCompanyIds` bắt buộc: null = toàn tập đoàn, mảng = các công ty được xem.
 */
export async function listLinksFor(
  objectType: LinkObjectType,
  id: string,
  opts: { scopeCompanyIds: string[] | null; includeRemoved?: boolean },
): Promise<LinkRecord[]> {
  if (!OBJECT_ID_RE.test(id)) return [];
  const filter: Record<string, unknown> = {
    $or: [
      { from_type: objectType, from_id: id },
      { to_type: objectType, to_id: id },
    ],
  };
  if (!opts.includeRemoved) filter.status = 'active';
  if (opts.scopeCompanyIds !== null) filter.company_id = { $in: opts.scopeCompanyIds };
  const rows = await Models.BusinessLink.find(filter as never).sort({ created_at: 1 }).lean<RawLink[]>();
  return rows.map(toLinkRecord);
}

/** Liên kết hiệu lực của một đầu (đầu nguồn hoặc đích) — dùng để tính chỉ tiêu. */
async function activeLinksWhere(filter: Record<string, unknown>): Promise<LinkRecord[]> {
  const rows = await Models.BusinessLink.find({ ...filter, status: 'active' } as never).lean<RawLink[]>();
  return rows.map(toLinkRecord);
}

/**
 * Giữ lại các liên kết còn GIỮ sức chứa: liên kết có phiếu nguồn tồn tại và không ở trạng thái đã nhả
 * (`RELEASED_DOCUMENT_STATUSES`). Liên kết không xuất phát từ phiếu được giữ nguyên.
 */
export async function reservingLinks(links: LinkRecord[]): Promise<LinkRecord[]> {
  const docIds = [...new Set(links.filter((l) => l.from_type === 'document').map((l) => l.from_id))];
  if (!docIds.length) return links;
  const live = await Models.Document.find({ _id: { $in: docIds }, status: { $nin: [...RELEASED_DOCUMENT_STATUSES] } } as never)
    .select({ _id: 1 })
    .lean<{ _id: unknown }[]>();
  const liveIds = new Set(live.map((r) => String(r._id)));
  return links.filter((l) => l.from_type !== 'document' || liveIds.has(l.from_id));
}

/* ================================================================== *
 * Chỉ tiêu suy ra — truy vấn DB
 * ================================================================== */

/** Σ phân bổ hiệu lực từ một phiếu (không phụ thuộc trạng thái phiếu — dùng để kiểm sức chứa). */
export async function documentAllocatedTotalOf(documentId: string): Promise<bigint> {
  const links = await activeLinksWhere({ from_type: 'document', from_id: documentId, relation: { $in: [...AMOUNT_RELATIONS] } });
  return documentAllocatedTotal(links, documentId);
}

/** Đã cấn trừ (chỉ phiếu đã thực thi) của một khoản công nợ. */
export async function debtOffsetApplied(debtVoucherId: string): Promise<bigint> {
  const links = await activeLinksWhere({ to_type: 'debt_voucher', to_id: debtVoucherId, relation: 'offset' });
  const executed = await executedDocumentIds(links.map((l) => l.from_id));
  return debtOffsetAppliedFrom(links, debtVoucherId, executed);
}

/** Còn phải thu / phải trả của một khoản công nợ (giá trị − đã cấn trừ hiệu lực). */
export async function debtRemaining(debtVoucherId: string): Promise<bigint> {
  const d = await Models.DebtVoucher.findById(debtVoucherId).select({ value_minor: 1, company_id: 1 }).lean<{ value_minor?: unknown } | null>();
  if (!d) return notFound('khoản công nợ');
  return debtRemainingOf(toBig(d.value_minor), await debtOffsetApplied(debtVoucherId));
}

/** Gốc đã trả (chỉ phiếu chi đã thực thi) của một khoản nợ ngân hàng. */
export async function loanRepaidPrincipal(bankDebtId: string): Promise<bigint> {
  const links = await activeLinksWhere({ to_type: 'bank_debt', to_id: bankDebtId, relation: 'repayment' });
  const executed = await executedDocumentIds(links.map((l) => l.from_id));
  return loanRepaidPrincipalFrom(links, bankDebtId, executed);
}

/** Dư nợ của một khoản nợ ngân hàng (gốc − gốc đã trả; chờ giải ngân / đã huỷ ⇒ 0). */
export async function loanOutstanding(bankDebtId: string): Promise<bigint> {
  const b = await Models.BankDebt.findById(bankDebtId).select({ principal_minor: 1, status: 1 }).lean<{ principal_minor?: unknown; status?: string } | null>();
  if (!b) return notFound('khoản nợ ngân hàng');
  return loanOutstandingOf(toBig(b.principal_minor), await loanRepaidPrincipal(bankDebtId), b.status ?? null);
}

/* ================================================================== *
 * Tạo / gỡ liên kết
 * ================================================================== */

export interface CreateLinkInput {
  from: { type: LinkObjectType; id: string };
  to: { type: LinkObjectType; id: string };
  relation: LinkRelation;
  amount_minor?: string | bigint | null;
  split?: { principal?: string | bigint | null; interest?: string | bigint | null; fee?: string | bigint | null } | null;
  note?: string | null;
  origin?: LinkOrigin;
  run_id?: string | null;
  rule_code?: string | null;
  actor: LinkActor;
  /** Phạm vi công ty của người gọi (null = toàn tập đoàn). Mọi đầu liên kết phải nằm trong phạm vi. */
  scopeCompanyIds?: string[] | null;
  request_id?: string | null;
  ip?: string | null;
}

function toBigIntOrNull(v: string | bigint | null | undefined): bigint | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'bigint') return v;
  if (/^\d+$/.test(v)) return BigInt(v);
  throw new ApiError({ code: 'FG-VAL-001', detail: 'Số tiền phải là số nguyên không âm', errors: { amount_minor: 'Số tiền không hợp lệ' } });
}

function toSplitOrNull(input: CreateLinkInput['split']): LinkSplit | null {
  if (!input) return null;
  return {
    principal: toBigIntOrNull(input.principal) ?? 0n,
    interest: toBigIntOrNull(input.interest) ?? 0n,
    fee: toBigIntOrNull(input.fee) ?? 0n,
  };
}

/** Kiểm sức chứa theo từng đầu: phiếu nguồn, khoản công nợ, khoản vay (theo nhóm quan hệ). */
async function assertCapacity(
  relation: LinkRelation,
  from: LinkEndpoint,
  to: LinkEndpoint,
  amount: bigint,
  split: LinkSplit | null,
): Promise<void> {
  if (from.type === 'document') {
    assertWithinCapacity({
      limit: from.total_minor,
      committed: await documentAllocatedTotalOf(from.id),
      add: amount,
      what: `Phiếu ${from.code}`,
    });
  }
  // Liên kết từ phiếu huỷ / từ chối / hết hạn không giữ sức chứa (`reservingLinks`).
  if (to.type === 'debt_voucher') {
    const links = await reservingLinks(await activeLinksWhere({ to_type: 'debt_voucher', to_id: to.id, relation: 'offset' }));
    const committed = links.reduce((s, l) => s + allocationOf(l), 0n);
    assertWithinCapacity({ limit: to.total_minor, committed, add: amount, what: `Khoản công nợ ${to.code}` });
  }
  if (to.type === 'bank_debt' && (relation === 'disbursement' || relation === 'funded_by' || relation === 'repayment')) {
    // Mỗi nhóm (giải ngân / vay để chi / trả nợ) có sức chứa riêng = gốc khoản vay.
    // Trả nợ chỉ tính phần GỐC; giải ngân và vay để chi tính theo số tiền.
    const links = await reservingLinks(await activeLinksWhere({ to_type: 'bank_debt', to_id: to.id, relation }));
    const committed = links.reduce((s, l) => s + (relation === 'repayment' ? principalPartOf(l) : allocationOf(l)), 0n);
    const add = relation === 'repayment' ? (split ? split.principal : amount) : amount;
    assertWithinCapacity({ limit: to.total_minor, committed, add, what: `Khoản vay ${to.code}` });
  }
}

/**
 * Sức chứa GIẢI NGÂN của khoản vay (gốc) — kiểm TRƯỚC khi lưu phiếu thu gắn khoản có sẵn (v2 §11.4 (b):
 * tổng giải ngân không vượt gốc). Cùng quy tắc FG-LINK-002 như `createLink`; `excludeDocumentId` bỏ
 * giải ngân của chính phiếu đang sửa để không tính trùng.
 */
export async function assertLoanDisbursementCapacity(input: { loanId: string; amountMinor: bigint; excludeDocumentId?: string | null }): Promise<void> {
  const loan = await loadEndpoint('bank_debt', input.loanId);
  const links = await reservingLinks(await activeLinksWhere({ to_type: 'bank_debt', to_id: loan.id, relation: 'disbursement' }));
  const committed = disbursedExcludingDocument(links, input.excludeDocumentId ?? null);
  assertWithinCapacity({ limit: loan.total_minor, committed, add: input.amountMinor, what: `Khoản vay ${loan.code}` });
}

/** Σ giải ngân đang giữ sức chứa của khoản vay, BỎ giải ngân của phiếu `excludeDocumentId` (phiếu đang sửa). */
export function disbursedExcludingDocument(links: LinkRecord[], excludeDocumentId: string | null): bigint {
  return links
    .filter((l) => !(excludeDocumentId && l.from_type === 'document' && l.from_id === excludeDocumentId))
    .reduce((s, l) => s + allocationOf(l), 0n);
}

/**
 * Đổi số tiền phiếu (sửa hồ sơ): tổng phân bổ CÒN LẠI của phiếu không được vượt số tiền mới (v2 §9.2, §11.2).
 * Kiểm trên liên kết hiện có — `createLink` chỉ kiểm lúc tạo nên không bắt được việc hạ số tiền sau đó.
 * `willResync(l)` = liên kết mà chính lần lưu này (hoặc quy tắc tự động) sẽ gỡ / đồng bộ lại theo số tiền mới: không tính.
 */
export async function assertDocumentAmountCoversLinks(input: {
  documentId: string;
  amountMinor: bigint;
  currency?: string | null;
  willResync: (link: LinkRecord) => boolean;
}): Promise<void> {
  const links = await activeLinksWhere({ from_type: 'document', from_id: input.documentId, relation: { $in: [...AMOUNT_RELATIONS] } });
  const committed = links.filter((l) => !input.willResync(l)).reduce((s, l) => s + allocationOf(l), 0n);
  if (committed <= input.amountMinor) return;
  const cur = input.currency ?? 'VND';
  throw new ApiError({
    code: 'FG-LINK-002',
    detail: `Số tiền phiếu ${formatMoney(money(input.amountMinor, cur), { mode: 'compact' })} thấp hơn số đã phân bổ ${formatMoney(money(committed, cur), { mode: 'compact' })} (cấn trừ / trả nợ / giải ngân) — gỡ bớt liên kết trước`,
    data: { amount_minor: input.amountMinor.toString(), committed_minor: committed.toString() },
  });
}

/**
 * Phiếu thu sang "vay MỚI" (R2 `mode: new`, v2 §11.4 (a)): khoản vay tự sinh giải ngân TOÀN BỘ số tiền phiếu, nên phiếu
 * không được còn phân bổ nào khác (giải ngân gán tay tới khoản có sẵn, cấn trừ, trả nợ…). `willResync` = liên kết mà
 * chính lần lưu này gỡ / đồng bộ lại (không tính). Vi phạm ⇒ FG-LINK-002 CHẶN LƯU — không để lượt R2 sau lưu lỗi và
 * để lại khoản vay "Chờ giải ngân" thiếu liên kết (v2 §10.2, §11.2).
 */
export async function assertDocumentFreeForNewLoan(input: {
  documentId: string;
  amountMinor: bigint;
  currency?: string | null;
  willResync: (link: LinkRecord) => boolean;
}): Promise<void> {
  const links = await activeLinksWhere({ from_type: 'document', from_id: input.documentId, relation: { $in: [...AMOUNT_RELATIONS] } });
  const committed = documentAllocatedTotal(
    links.filter((l) => !input.willResync(l)),
    input.documentId,
  );
  if (committed <= 0n) return;
  const cur = input.currency ?? 'VND';
  throw new ApiError({
    code: 'FG-LINK-002',
    detail: `Phiếu đã phân bổ ${formatMoney(money(committed, cur), { mode: 'compact' })} cho liên kết khác (giải ngân thủ công / cấn trừ / trả nợ) — "Tạo khoản vay mới" cần giải ngân toàn bộ ${formatMoney(money(input.amountMinor, cur), { mode: 'compact' })}. Gỡ các liên kết đó trước, hoặc chọn "Gắn khoản vay đã có"`,
    data: { amount_minor: input.amountMinor.toString(), committed_minor: committed.toString() },
  });
}

/** Quan hệ mang kiểm khớp đối tác (cấn trừ, trả nợ, giải ngân). */
const PARTNER_MATCH_RELATIONS = (Object.keys(RELATION_SPECS) as LinkRelation[]).filter((r) => RELATION_SPECS[r].partnerMatch);

/**
 * Đổi đối tác của phiếu (sửa hồ sơ): mọi liên kết theo quan hệ khớp đối tác phải còn khớp đối tác MỚI, nếu không
 * phải gỡ trước (v2 §9.2, §11.2 — FG-LINK-001). Liên kết Tự động (quy tắc R2) được đồng bộ theo đối tác mới nên không chặn.
 */
export async function assertPartnerChangeKeepsLinks(input: {
  documentId: string;
  nextPartnerId: string | null;
  /** liên kết mà chính lần lưu này sẽ gỡ (đổi lựa chọn khoản vay trên phiếu): không chặn (v2 §11.2, §11.4 (b)). */
  willRelease?: (link: LinkRecord) => boolean;
}): Promise<void> {
  const links = await activeLinksWhere({ from_type: 'document', from_id: input.documentId, relation: { $in: PARTNER_MATCH_RELATIONS } });
  for (const link of links) {
    if (link.origin === 'automation') continue;
    if (input.willRelease?.(link)) continue;
    const other = await loadEndpoint(link.to_type, link.to_id);
    if (input.nextPartnerId && other.partner_id === input.nextPartnerId) continue;
    throw new ApiError({
      code: 'FG-LINK-001',
      detail: `Phiếu đang liên kết "${BUSINESS_LINK_RELATION_LABEL[link.relation]}" với ${LINK_OBJECT_TYPE_LABEL[link.to_type]} của đối tác khác — gỡ liên kết trước khi đổi đối tác`,
    });
  }
}

/**
 * Gán liên kết (thủ công hoặc do quy tắc tự động). Trả về bản ghi đã tạo.
 * Lỗi: FG-LINK-001 (cấu trúc/đối tác), FG-LINK-002 (vượt số tiền), FG-LINK-003 (trùng cặp), FG-VAL-001 (số tiền).
 */
export async function createLink(input: CreateLinkInput): Promise<LinkRecord> {
  const from = await loadEndpoint(input.from.type, input.from.id);
  const to = await loadEndpoint(input.to.type, input.to.id);
  assertScope(input.scopeCompanyIds, [from.company_id, to.company_id]);
  assertRelationRules(input.relation, from, to);

  const { amount, split } = normalizeAmount({ amount_minor: toBigIntOrNull(input.amount_minor), split: toSplitOrNull(input.split) });
  if (RELATION_SPECS[input.relation].amount) {
    if (amount === null || amount <= 0n) {
      throw new ApiError({ code: 'FG-VAL-001', errors: { amount_minor: 'Số tiền phân bổ phải lớn hơn 0' } });
    }
    await assertCapacity(input.relation, from, to, amount, split);
  }

  const duplicate = await Models.BusinessLink.findOne({ from_id: from.id, to_id: to.id, relation: input.relation, status: 'active' } as never)
    .select({ _id: 1 })
    .lean();
  if (duplicate) throw new ApiError({ code: 'FG-LINK-003' });

  const now = new Date();
  let created: RawLink;
  try {
    created = (await Models.BusinessLink.create({
      company_id: from.company_id,
      from_type: from.type,
      from_id: from.id,
      to_type: to.type,
      to_id: to.id,
      relation: input.relation,
      amount_minor: amount,
      split: split ? { principal: split.principal, interest: split.interest, fee: split.fee } : null,
      origin: input.origin ?? 'manual',
      run_id: input.run_id ?? null,
      rule_code: input.rule_code ?? null,
      status: 'active',
      note: input.note ?? null,
      created_by: input.actor.user_id,
      created_at: now,
    } as never)) as unknown as RawLink;
  } catch (err) {
    // va chạm unique partial (cùng cặp + quan hệ đang hiệu lực) — chống ghi trùng khi chạy song song
    if ((err as { code?: number }).code === 11000) throw new ApiError({ code: 'FG-LINK-003' });
    throw err;
  }

  await mirrorAudit({
    at: now,
    actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
    action: 'link.create',
    subject: { type: 'link', id: String(created._id), code: null },
    company_id: from.company_id,
    diff_fields: {
      relation: input.relation,
      from: `${from.type}:${from.code}`,
      to: `${to.type}:${to.code}`,
      amount_minor: amount === null ? null : amount.toString(),
      origin: input.origin ?? 'manual',
    },
    request_id: input.request_id ?? null,
    ip: input.ip ?? null,
  });
  return toLinkRecord(created);
}

export interface RemoveLinkInput {
  link_id: string;
  reason: string;
  actor: LinkActor;
  scopeCompanyIds?: string[] | null;
  request_id?: string | null;
  ip?: string | null;
}

/** Gỡ liên kết: đánh dấu `removed` (không xoá), ghi người gỡ + lý do. Chỉ liên kết đang hiệu lực. */
export async function removeLink(input: RemoveLinkInput): Promise<LinkRecord> {
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ApiError({ code: 'FG-VAL-001', errors: { reason: 'Nêu lý do gỡ liên kết (tối thiểu 5 ký tự)' } });
  if (!OBJECT_ID_RE.test(input.link_id)) return notFound('liên kết');
  const link = await Models.BusinessLink.findById(input.link_id).lean<RawLink | null>();
  if (!link) return notFound('liên kết');
  assertScope(input.scopeCompanyIds, [String(link.company_id)]);
  if (link.status !== 'active') throw new ApiError({ code: 'FG-VAL-001', detail: 'Liên kết đã được gỡ trước đó' });

  const now = new Date();
  const updated = await Models.BusinessLink.findOneAndUpdate(
    { _id: link._id, status: 'active' } as never,
    { $set: { status: 'removed', removed_by: input.actor.user_id, removed_at: now, removed_reason: reason } } as never,
    { returnDocument: 'after' },
  ).lean<RawLink | null>();
  if (!updated) throw new ApiError({ code: 'FG-VAL-001', detail: 'Liên kết đã được gỡ trước đó' });

  await mirrorAudit({
    at: now,
    actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
    action: 'link.remove',
    subject: { type: 'link', id: String(link._id), code: null },
    company_id: String(link.company_id),
    diff_fields: { relation: link.relation, from: `${link.from_type}:${String(link.from_id)}`, to: `${link.to_type}:${String(link.to_id)}`, reason },
    request_id: input.request_id ?? null,
    ip: input.ip ?? null,
  });
  return toLinkRecord(updated);
}

/* ================================================================== *
 * Khoản vay được thanh toán → sự kiện `loan.settled` (best-effort)
 * ================================================================== */

interface LoanRow {
  _id: unknown;
  code?: string;
  company_id: unknown;
  principal_minor?: unknown;
}

/**
 * Gọi SAU KHI một phiếu chi được thực thi (`paid`). Nếu lần thanh toán này đưa dư nợ về 0 (lần đầu
 * gốc đã trả đủ) thì phát `loan.settled`. Đọc liên kết `repayment` trong `business_links`.
 * Không ném lỗi — gọi trong khối try/catch hoặc chấp nhận log. Trả về danh sách khoản vay vừa tất toán.
 */
export async function emitLoanSettledAfterPayment(documentId: string, actor: LinkActor | null = null): Promise<string[]> {
  if (!OBJECT_ID_RE.test(documentId)) return [];
  const linked = await Models.BusinessLink.find({ from_id: documentId, relation: 'repayment', to_type: 'bank_debt', status: 'active' } as never)
    .select({ to_id: 1 })
    .lean<{ to_id: unknown }[]>();
  const loanIds = [...new Set(linked.map((r) => String(r.to_id)))];
  const settled: string[] = [];

  for (const loanId of loanIds) {
    const loan = await Models.BankDebt.findById(loanId)
      .select({ code: 1, company_id: 1, principal_minor: 1 })
      .lean<LoanRow | null>();
    if (!loan) continue;
    const principal = toBig(loan.principal_minor);
    const v2Links = await activeLinksWhere({ to_type: 'bank_debt', to_id: loanId, relation: 'repayment' });
    const executed = await executedDocumentIds(v2Links.map((l) => l.from_id));

    let before = 0n;
    let thisPayment = 0n;
    for (const l of v2Links) {
      if (!executed.has(l.from_id)) continue;
      if (l.from_id === documentId) thisPayment += principalPartOf(l);
      else before += principalPartOf(l);
    }
    if (thisPayment > 0n && before < principal && before + thisPayment >= principal) {
      await emitDomainEvent({
        type: 'loan.settled',
        company_id: String(loan.company_id),
        subject_type: 'bank_debt',
        subject_id: loanId,
        payload: { code: loan.code ?? null, principal_minor: principal.toString(), last_document_id: documentId },
        actor: actor ? { user_id: actor.user_id, name: actor.name ?? null, role: actor.role ?? null } : null,
      });
      settled.push(loanId);
    }
  }
  return settled;
}

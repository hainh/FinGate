/**
 * Nạp tham chiếu dùng chung cho báo cáo / cảnh báo / dashboard (đọc DB).
 *
 *   · Tên đối tác & tag ĐI QUA ID (`partner_id`, `tag_ids`) — không dùng text v1 (`payee.*`, `party_*`, `bank_name`).
 *   · Phân bổ công nợ / trả nợ: đọc từ `business_links` (v2).
 */

import { datePartOf, vnDate } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { allocationOf, principalPartOf, toBig } from '../links/index.ts';
import type { SettlementRow } from './aggregate.ts';

/* ------------------------------------------------------------------ *
 * Đối tác & tag
 * ------------------------------------------------------------------ */

export interface PartnerRef {
  id: string;
  company_id: string;
  code: string;
  name: string;
  type: 'bank' | 'customer' | 'supplier' | string;
  status: string;
  bank_name: string | null;
  account_number: string | null;
}

export async function loadPartnerRefs(ids: Iterable<string | null | undefined>): Promise<Map<string, PartnerRef>> {
  const uniq = [...new Set([...ids].filter((x): x is string => typeof x === 'string' && x.length > 0))];
  if (!uniq.length) return new Map();
  const rows = await Models.Partner.find({ _id: { $in: uniq } } as never)
    .select({ company_id: 1, code: 1, name: 1, type: 1, status: 1, bank_name: 1, account_number: 1 })
    .lean<Record<string, unknown>[]>();
  return new Map(
    rows.map((p) => [
      String(p._id),
      {
        id: String(p._id),
        company_id: String(p.company_id ?? ''),
        code: String(p.code ?? ''),
        name: String(p.name ?? ''),
        type: String(p.type ?? ''),
        status: String(p.status ?? 'active'),
        bank_name: (p.bank_name as string | null | undefined) ?? null,
        account_number: (p.account_number as string | null | undefined) ?? null,
      },
    ]),
  );
}

/** Tên hiển thị của đối tác theo ID; chưa gán / không tìm thấy → nhãn mặc định. */
export function partnerNameOf(map: ReadonlyMap<string, PartnerRef>, id: string | null | undefined, fallback = 'Chưa gán đối tác'): string {
  if (!id) return fallback;
  return map.get(String(id))?.name ?? fallback;
}

export interface TagRef {
  id: string;
  company_id: string;
  name: string;
  name_key: string;
  color: string;
}

export async function loadTagRefs(ids: Iterable<string>): Promise<Map<string, TagRef>> {
  const uniq = [...new Set([...ids].filter(Boolean))];
  if (!uniq.length) return new Map();
  const rows = await Models.Tag.find({ _id: { $in: uniq } } as never)
    .select({ company_id: 1, name: 1, name_key: 1, color: 1 })
    .lean<Record<string, unknown>[]>();
  return new Map(
    rows.map((t) => [
      String(t._id),
      {
        id: String(t._id),
        company_id: String(t.company_id ?? ''),
        name: String(t.name ?? ''),
        name_key: String(t.name_key ?? ''),
        color: String(t.color ?? '#64748b'),
      },
    ]),
  );
}

/* ------------------------------------------------------------------ *
 * Chuyển nội bộ
 * ------------------------------------------------------------------ */

/**
 * Id các phiếu thuộc chuyển nội bộ (loại khỏi doanh thu/chi phí) — v2:
 *   · phiếu kind `internal`, và phiếu thu do R1 sinh (`origin.rule_code = R1`);
 *   · hai đầu của liên kết `internal_transfer` còn hiệu lực.
 * Cờ v1 (`payee.is_internal`, `auto_source_document_id`) đã thay bằng các nguồn trên (migrate M-series).
 */
export async function loadInternalDocIds(): Promise<Set<string>> {
  const [docs, links] = await Promise.all([
    Models.Document.find({ $or: [{ kind: 'internal' }, { 'origin.rule_code': 'R1' }] } as never)
      .select({ _id: 1 })
      .lean<{ _id: unknown }[]>(),
    Models.BusinessLink.find({ relation: 'internal_transfer', status: 'active' } as never)
      .select({ from_id: 1, to_id: 1 })
      .lean<{ from_id: unknown; to_id: unknown }[]>(),
  ]);
  const ids = new Set<string>();
  for (const d of docs) ids.add(String(d._id));
  for (const l of links) {
    ids.add(String(l.from_id));
    ids.add(String(l.to_id));
  }
  return ids;
}

/* ------------------------------------------------------------------ *
 * Phân bổ (cấn trừ / trả nợ) — business_links (v2)
 * ------------------------------------------------------------------ */

interface MetaDoc {
  code: string;
  kind: string;
  status: string;
  date: string;
  company_id: string;
  partner_id: string | null;
  amount: bigint;
}

function dateOfDoc(d: { execution?: { paid_at?: unknown } | null; planned_date?: unknown }): string {
  const paid = d.execution?.paid_at;
  return datePartOf(String(paid ?? d.planned_date ?? ''));
}

/** Ngày (YYYY-MM-DD, giờ VN) của một mốc thời gian lưu dạng Date/chuỗi. */
export function dayOf(at: unknown): string {
  if (!at) return '';
  if (at instanceof Date) return vnDate(at);
  return datePartOf(String(at));
}

interface TargetInput {
  id: string;
}

async function loadSettlements(
  targetType: 'debt_voucher' | 'bank_debt',
  relation: 'offset' | 'repayment',
  targets: TargetInput[],
): Promise<SettlementRow[]> {
  const ids = [...new Set(targets.map((t) => t.id))];
  if (!ids.length) return [];

  const v2Raw = await Models.BusinessLink.find({ to_type: targetType, to_id: { $in: ids }, relation, status: 'active' } as never)
    .select({ _id: 1, to_id: 1, from_id: 1, amount_minor: 1, split: 1 })
    .lean<
      {
        _id: unknown;
        to_id: unknown;
        from_id: unknown;
        amount_minor?: unknown;
        split?: { principal?: unknown; interest?: unknown; fee?: unknown } | null;
      }[]
    >();
  const v2Links = v2Raw.map((l) => {
    const split = l.split
      ? { principal: toBig(l.split.principal), interest: toBig(l.split.interest), fee: toBig(l.split.fee) }
      : null;
    const amountMinor = l.amount_minor === null || l.amount_minor === undefined ? null : toBig(l.amount_minor);
    return {
      target_id: String(l.to_id),
      document_id: String(l.from_id),
      link_id: String(l._id),
      amount: allocationOf({ amount_minor: amountMinor, split }),
      principal: principalPartOf({ amount_minor: amountMinor, split }),
    };
  });

  const docIds = [...new Set(v2Links.map((r) => r.document_id).filter(Boolean))];
  const docMeta = new Map<string, MetaDoc>();
  if (docIds.length) {
    const docs = await Models.Document.find({ _id: { $in: docIds } } as never)
      .select({ code: 1, kind: 1, status: 1, planned_date: 1, 'execution.paid_at': 1, company_id: 1, partner_id: 1, amount: 1 })
      .lean<Record<string, unknown>[]>();
    for (const d of docs) {
      docMeta.set(String(d._id), {
        code: String(d.code ?? ''),
        kind: String(d.kind ?? ''),
        status: String(d.status ?? ''),
        date: dateOfDoc(d as never),
        company_id: String(d.company_id ?? ''),
        partner_id: d.partner_id ? String(d.partner_id) : null,
        amount: toBig((d.amount as { minor?: unknown } | undefined)?.minor),
      });
    }
  }

  const toRow = (
    r: { target_id: string; document_id: string; link_id: string | null; amount: bigint; principal: bigint; source: 'v2' },
  ): SettlementRow | null => {
    const m = docMeta.get(r.document_id);
    if (!m) return null; // phiếu đã xoá hẳn → bỏ qua (không có trạng thái để xét)
    return {
      target_id: r.target_id,
      document_id: r.document_id,
      source: r.source,
      link_id: r.link_id,
      amount: r.amount,
      principal: r.principal,
      doc_status: m.status,
      doc_kind: m.kind,
      doc_code: m.code,
      doc_date: m.date,
      doc_company_id: m.company_id,
      doc_partner_id: m.partner_id,
      doc_amount: m.amount,
    };
  };

  return v2Links.map((r) => toRow({ ...r, source: 'v2' })).filter((r): r is SettlementRow => r !== null);
}

/** Phân bổ của các phiếu công nợ (offset) — mọi trạng thái phiếu; lọc `paid` ở nơi dùng. */
export function loadDebtSettlements(debts: TargetInput[]): Promise<SettlementRow[]> {
  return loadSettlements('debt_voucher', 'offset', debts);
}

/** Trả nợ gốc của các khoản vay (repayment) — mọi trạng thái phiếu; lọc `paid` ở nơi dùng. */
export function loadLoanSettlements(loans: TargetInput[]): Promise<SettlementRow[]> {
  return loadSettlements('bank_debt', 'repayment', loans);
}

/** Nhóm phân bổ theo id đích. */
export function groupSettlements(rows: SettlementRow[]): Map<string, SettlementRow[]> {
  const out = new Map<string, SettlementRow[]>();
  for (const r of rows) {
    const list = out.get(r.target_id) ?? [];
    list.push(r);
    out.set(r.target_id, list);
  }
  return out;
}

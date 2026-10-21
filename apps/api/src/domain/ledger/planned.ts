/**
 * Dòng tiền DỰ KIẾN (pipeline) — phiếu đã gửi duyệt / đã duyệt nhưng CHƯA thực thi
 * (v2 §4.2 "Dự kiến vào / ra"). Không nằm trong sổ cái nên KHÔNG tính vào số dư thực tế;
 * chỉ dùng cho số dư dự kiến (`projected`) và dự báo dòng tiền.
 *
 * Phần thuần (`plannedFlowsOf`, `plannedFlowsByAccount`) tách khỏi phần đọc DB để test được.
 */

import { datePartOf } from '@fingate/shared';
import { Models } from '../../db/models.ts';

/** Trạng thái "đang chờ tiền": đã gửi duyệt hoặc đã duyệt, chưa thực thi. */
export const PIPELINE_STATUSES = [
  'pending.ktt',
  'pending.pgd',
  'pending.gd',
  'pending.ptg',
  'pending.chairman',
  'approved',
  'processing',
] as const;

/**
 * Trạng thái phiếu được tính vào CHỈ TIÊU thu–chi (dự kiến + đã thực thi): dashboard, bản tin,
 * báo cáo, ngân sách dùng chung (v2 §12). KHÔNG tính nháp, trả về, từ chối, huỷ, hết hạn.
 */
export const PLANNED_FLOW_STATUSES: readonly string[] = [...PIPELINE_STATUSES, 'paid'];

export type PlannedBucket = 'operating_in' | 'operating_out' | 'disbursement_in' | 'internal_in' | 'internal_out';

/** Phiếu pipeline đã rút gọn (số tiền = phần CHƯA thực thi). */
export interface PipelineDoc {
  id: string;
  code: string;
  kind: string;
  company_id: string;
  status: string;
  /** `YYYY-MM-DD` (đã cắt phần giờ). */
  planned_date: string;
  /** Số tiền còn phải thực thi = amount − paid_minor (không âm). */
  amount_minor: bigint;
  /** Tài khoản nguồn (chi/đảo hạn/chuyển) hoặc tài khoản nhận (thu). */
  source_account_id: string | null;
  /** Chuyển nội bộ: công ty & tài khoản đích. */
  target_company_id: string | null;
  target_account_id: string | null;
  /** Phiếu thu giải ngân vay (options.loan.kind = borrow, hoặc v1 create_bank_debt). */
  borrow: boolean;
  partner_id: string | null;
  tag_ids: string[];
}

/** Một dòng dự kiến đã gán bucket & ngày (ngày đã kẹp ≥ ngày bắt đầu dự báo). */
export interface PlannedFlow {
  doc_id: string;
  code: string;
  company_id: string;
  account_id: string | null;
  date: string;
  direction: 'in' | 'out';
  bucket: PlannedBucket;
  amount: bigint;
}

/** Kẹp ngày: phiếu quá hạn chưa thực thi được coi như đến hạn vào ngày `floor`. */
export function clampDay(day: string, floor: string): string {
  return day < floor ? floor : day;
}

/**
 * Chuyển một phiếu pipeline thành dòng dự kiến.
 *  · thu thường → operating_in; thu giải ngân vay → disbursement_in
 *  · chi / đảo hạn → operating_out
 *  · chuyển nội bộ → internal_out (công ty nguồn) + internal_in (công ty đích, nếu có)
 */
export function plannedFlowsOf(doc: PipelineDoc, floor: string): PlannedFlow[] {
  if (doc.amount_minor <= 0n || !doc.planned_date) return [];
  const date = clampDay(doc.planned_date, floor);
  const base = { doc_id: doc.id, code: doc.code, date, amount: doc.amount_minor };
  if (doc.kind === 'internal') {
    const out: PlannedFlow[] = [
      { ...base, company_id: doc.company_id, account_id: doc.source_account_id, direction: 'out', bucket: 'internal_out' },
    ];
    if (doc.target_company_id) {
      out.push({ ...base, company_id: doc.target_company_id, account_id: doc.target_account_id, direction: 'in', bucket: 'internal_in' });
    }
    return out;
  }
  if (doc.kind === 'income') {
    return [
      {
        ...base,
        company_id: doc.company_id,
        account_id: doc.source_account_id,
        direction: 'in',
        bucket: doc.borrow ? 'disbursement_in' : 'operating_in',
      },
    ];
  }
  // spend | rollover (ledger coi mọi kind không phải thu là chi)
  return [{ ...base, company_id: doc.company_id, account_id: doc.source_account_id, direction: 'out', bucket: 'operating_out' }];
}

/** Gộp dòng dự kiến theo tài khoản (chỉ tài khoản có trong `accountIds`, nếu truyền vào). */
export function plannedFlowsByAccount(
  flows: PlannedFlow[],
  accountIds?: ReadonlySet<string>,
): Map<string, { in: bigint; out: bigint }> {
  const out = new Map<string, { in: bigint; out: bigint }>();
  for (const f of flows) {
    if (!f.account_id) continue;
    if (accountIds && !accountIds.has(f.account_id)) continue;
    const cur = out.get(f.account_id) ?? { in: 0n, out: 0n };
    if (f.direction === 'in') cur.in += f.amount;
    else cur.out += f.amount;
    out.set(f.account_id, cur);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Đọc DB
 * ------------------------------------------------------------------ */

interface RawPipelineDoc {
  _id: unknown;
  code?: string;
  kind?: string;
  company_id?: unknown;
  status?: string;
  planned_date?: string;
  amount?: { minor?: unknown } | null;
  source?: { account_id?: unknown; group_account_id?: unknown } | null;
  target?: { company_id?: unknown; account_id?: unknown } | null;
  transfer_target?: { company_id?: unknown; account_id?: unknown } | null;
  execution?: { paid_minor?: unknown } | null;
  options?: { loan?: { kind?: string } | null } | null;
  create_bank_debt?: boolean;
  partner_id?: unknown;
  tag_ids?: unknown[];
}

const nul = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const big = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
};

export function toPipelineDoc(raw: RawPipelineDoc): PipelineDoc {
  const amount = big(raw.amount?.minor);
  const paid = big(raw.execution?.paid_minor);
  const remaining = amount - paid;
  const transferCompany = nul(raw.transfer_target?.company_id) ?? nul(raw.target?.company_id);
  const transferAccount = nul(raw.transfer_target?.account_id) ?? nul(raw.target?.account_id);
  return {
    id: String(raw._id),
    code: String(raw.code ?? ''),
    kind: String(raw.kind ?? ''),
    company_id: String(raw.company_id ?? ''),
    status: String(raw.status ?? ''),
    planned_date: datePartOf(String(raw.planned_date ?? '')),
    amount_minor: remaining > 0n ? remaining : 0n,
    source_account_id: nul(raw.source?.account_id) ?? nul(raw.source?.group_account_id),
    target_company_id: String(raw.kind) === 'internal' ? transferCompany : null,
    target_account_id: String(raw.kind) === 'internal' ? transferAccount : null,
    borrow: raw.options?.loan?.kind === 'borrow' || raw.create_bank_debt === true,
    partner_id: nul(raw.partner_id),
    tag_ids: (raw.tag_ids ?? []).map((t) => String(t)),
  };
}

/**
 * Nạp phiếu đang chờ thực thi theo bộ lọc Mongo do caller dựng (phạm vi công ty / tài khoản).
 * `plannedUpTo` = ngày cuối (YYYY-MM-DD) — lấy mọi phiếu có ngày dự kiến ≤ ngày này,
 * kể cả đã quá hạn (sẽ được kẹp vào ngày bắt đầu khi dựng dòng).
 */
export async function loadPipelineDocs(filter: Record<string, unknown>, plannedUpTo: string): Promise<PipelineDoc[]> {
  const rows = await Models.Document.find({
    status: { $in: [...PIPELINE_STATUSES] },
    planned_date: { $lte: `${plannedUpTo}T23:59` },
    ...filter,
  } as never)
    .select({
      code: 1,
      kind: 1,
      company_id: 1,
      status: 1,
      planned_date: 1,
      amount: 1,
      source: 1,
      target: 1,
      transfer_target: 1,
      execution: 1,
      options: 1,
      create_bank_debt: 1,
      partner_id: 1,
      tag_ids: 1,
    })
    .lean<RawPipelineDoc[]>();
  return rows.map((r) => toPipelineDoc({ ...r, _id: r._id }));
}

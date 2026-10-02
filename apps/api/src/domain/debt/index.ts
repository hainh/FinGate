/**
 * Công nợ & nợ ngân hàng — tính "đã cấn trừ / đã trả" ĐỘNG khi đọc.
 *
 * Liên kết lưu trên phiếu công nợ / khoản vay (`document_links` / `repayment_links`).
 * Một liên kết chỉ được tính khi hồ sơ thu/chi tương ứng đã ở trạng thái `paid`.
 * Vì vậy: phiếu thực thi ⇒ tự trừ; gỡ liên kết / huỷ phiếu ⇒ tính lại ngay, không cần
 * ghi ngược (single source of truth).
 */

import { Models } from '../../db/models.ts';

export interface OffsetLink {
  _id?: unknown;
  document_id: unknown;
  amount_minor?: unknown;
  linked_at?: Date | string | null;
  linked_by?: unknown;
  note?: string | null;
}

export interface LinkedDocInfo {
  _id: string;
  code: string;
  title: string;
  kind: string;
  status: string;
  amount_minor: bigint;
  currency: string;
}

export function toBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

/** Chuẩn hoá mảng liên kết từ document Mongo (lean hoặc mongoose doc) về OffsetLink[]. */
export function linkItems(v: unknown): OffsetLink[] {
  return Array.isArray(v) ? (v as OffsetLink[]) : [];
}

export function linkDocumentIds(v: unknown): string[] {
  return linkItems(v).map((l) => String(l.document_id));
}

/** Nạp thông tin các hồ sơ được liên kết (1 query, không N+1). */
export async function fetchLinkedDocs(ids: string[]): Promise<Map<string, LinkedDocInfo>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const docs = await Models.Document.find({ _id: { $in: uniq } } as never)
    .select({ code: 1, title: 1, kind: 1, status: 1, amount: 1 })
    .lean<Record<string, unknown>[]>();
  const out = new Map<string, LinkedDocInfo>();
  for (const d of docs) {
    const amount = (d.amount ?? {}) as { minor?: unknown; currency?: string };
    out.set(String(d._id), {
      _id: String(d._id),
      code: String(d.code ?? ''),
      title: String(d.title ?? ''),
      kind: String(d.kind ?? ''),
      status: String(d.status ?? ''),
      amount_minor: toBigInt(amount.minor),
      currency: String(amount.currency ?? 'VND'),
    });
  }
  return out;
}

/** Σ số tiền phân bổ của các liên kết có hồ sơ ở trạng thái `paid`. */
export function settledFromLinks(links: unknown, docs: Map<string, LinkedDocInfo>): bigint {
  let total = 0n;
  for (const link of linkItems(links)) {
    const info = docs.get(String(link.document_id));
    if (info?.status === 'paid') total += toBigInt(link.amount_minor);
  }
  return total;
}

export function debtAgingBucket(overdueDays: number): 'none' | 'lt30' | 'd30_60' | 'd60_90' | 'gt90' {
  if (overdueDays <= 0) return 'none';
  if (overdueDays < 30) return 'lt30';
  if (overdueDays <= 60) return 'd30_60';
  if (overdueDays <= 90) return 'd60_90';
  return 'gt90';
}

export function debtStatus(value: bigint, settled: bigint): 'open' | 'partial' | 'settled' {
  if (settled <= 0n) return 'open';
  if (settled >= value) return 'settled';
  return 'partial';
}

/** Nhãn tuổi nợ tiếng Việt. */
export function debtAgingLabel(b: string): string {
  return { none: 'Chưa đến hạn', lt30: 'Quá hạn < 30 ngày', d30_60: '30–60 ngày', d60_90: '60–90 ngày', gt90: '> 90 ngày' }[b] ?? b;
}

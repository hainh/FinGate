/**
 * Hàm THUẦN cho báo cáo & dashboard v2 — không đụng DB (test được bằng vitest).
 *
 * Quy ước v2:
 *   · Chuyển nội bộ KHÔNG tính doanh thu/chi phí (v2 §11.6): phiếu thuộc `internalIds` bị loại.
 *   · Công nợ: hướng lấy từ `direction` (v2); dữ liệu v1 chưa migrate suy từ `side` (M3b).
 *   · Chỉ số "đã cấn trừ / đã trả": chỉ tính phiếu ĐÃ THỰC THI (`paid`).
 *   · Báo cáo hợp nhất theo tag: gộp theo TÊN TAG CHUẨN HOÁ (`name_key`).
 */

import { normalizeNameKey } from '@fingate/shared';

export type DebtDirection = 'receivable' | 'payable';

/** Hướng công nợ: `direction` (v2) — dữ liệu v1 (chưa migrate) suy từ `side` (debit = phải thu). */
export function debtDirectionOf(v: { direction?: unknown; side?: unknown }): DebtDirection {
  if (v.direction === 'receivable' || v.direction === 'payable') return v.direction;
  return v.side === 'debit' ? 'receivable' : 'payable';
}

/** Phiếu đã rút gọn để tổng hợp báo cáo. */
export interface ReportDocLike {
  id: string;
  kind: string;
  company_id: string;
  amount: bigint;
  partner_id: string | null;
  tag_ids: string[];
}

/** Thu/chi (doanh thu/chi phí): chỉ `income` và `spend`, bỏ chuyển nội bộ. */
export function revenueExpenseOf(
  docs: { id: string; kind: string; amount: bigint }[],
  internalIds: ReadonlySet<string>,
): { income: bigint; expense: bigint; count: number } {
  let income = 0n;
  let expense = 0n;
  let count = 0;
  for (const d of docs) {
    if (internalIds.has(d.id)) continue;
    if (d.kind === 'income') income += d.amount;
    else if (d.kind === 'spend') expense += d.amount;
    else continue;
    count++;
  }
  return { income, expense, count };
}

/** Tổng thu/chi theo đối tác (bỏ chuyển nội bộ). Khoá = partner_id ('' nếu chưa gán). */
export function partnerActivityOf(
  docs: ReportDocLike[],
  internalIds: ReadonlySet<string>,
): Map<string, { income: bigint; expense: bigint; count: number }> {
  const out = new Map<string, { income: bigint; expense: bigint; count: number }>();
  for (const d of docs) {
    if (internalIds.has(d.id)) continue;
    if (d.kind !== 'income' && d.kind !== 'spend') continue;
    const key = d.partner_id ?? '';
    const cur = out.get(key) ?? { income: 0n, expense: 0n, count: 0 };
    if (d.kind === 'income') cur.income += d.amount;
    else cur.expense += d.amount;
    cur.count++;
    out.set(key, cur);
  }
  return out;
}

export interface TagGroup {
  /** khoá gộp = tên chuẩn hoá ('' = chưa gắn tag). */
  key: string;
  name: string;
  /** các tag gốc (id) đã được gộp vào nhóm này — nhiều công ty có thể có tag cùng tên. */
  tag_ids: string[];
  company_ids: string[];
  income: bigint;
  expense: bigint;
  count: number;
}

/**
 * Nhóm thu/chi theo tag, GỘP THEO TÊN CHUẨN HOÁ. Một phiếu có nhiều tag được tính cho từng tag
 * (không nhân đôi trong cùng nhóm). Phiếu không có tag → nhóm "Chưa gắn tag".
 */
export function groupByTagName(
  docs: ReportDocLike[],
  tags: ReadonlyMap<string, { name: string; name_key?: string }>,
  internalIds: ReadonlySet<string>,
): TagGroup[] {
  const groups = new Map<string, TagGroup>();
  for (const d of docs) {
    if (internalIds.has(d.id)) continue;
    if (d.kind !== 'income' && d.kind !== 'spend') continue;
    const seen = new Set<string>();
    // tag đã bị xoá khỏi danh bạ không làm mất số tiền: nếu không còn tag hợp lệ → "Chưa gắn tag"
    const known = d.tag_ids.filter((t) => tags.has(t));
    const ids = known.length ? known : [''];
    for (const tid of ids) {
      const tag = tid ? tags.get(tid) : undefined;
      const key = tag ? (tag.name_key ?? normalizeNameKey(tag.name)) : '';
      if (seen.has(key)) continue;
      seen.add(key);
      const g: TagGroup = groups.get(key) ?? {
        key,
        name: tag ? tag.name : 'Chưa gắn tag',
        tag_ids: [],
        company_ids: [],
        income: 0n,
        expense: 0n,
        count: 0,
      };
      if (tid && !g.tag_ids.includes(tid)) g.tag_ids.push(tid);
      if (!g.company_ids.includes(d.company_id)) g.company_ids.push(d.company_id);
      if (d.kind === 'income') g.income += d.amount;
      else g.expense += d.amount;
      g.count++;
      groups.set(key, g);
    }
  }
  return [...groups.values()].sort((a, b) => {
    const ta = a.income + a.expense;
    const tb = b.income + b.expense;
    if (ta !== tb) return tb > ta ? 1 : -1;
    return a.name.localeCompare(b.name, 'vi');
  });
}

/* ------------------------------------------------------------------ *
 * Phân bổ / cấn trừ (settlement)
 * ------------------------------------------------------------------ */

/** Một dòng phân bổ từ phiếu vào công nợ (`offset`) hoặc khoản vay (`repayment`). */
export interface SettlementRow {
  /** id công nợ / khoản vay đích. */
  target_id: string;
  document_id: string;
  /** nguồn: liên kết nghiệp vụ (`business_links`) — v1 nhúng đã bỏ. */
  source: 'v2';
  link_id: string | null;
  /** số tiền phân bổ (cả gốc + lãi + phí nếu có tách). */
  amount: bigint;
  /** phần GỐC (dư nợ chỉ trừ phần này); không tách thì = amount. */
  principal: bigint;
  doc_status: string;
  doc_kind: string;
  doc_code: string;
  /** ngày thực thi (paid_at) hoặc ngày dự kiến, YYYY-MM-DD. */
  doc_date: string;
  doc_company_id: string;
  doc_partner_id: string | null;
  doc_amount: bigint;
}

/** Tổng phân bổ từ các phiếu ĐÃ THỰC THI (`paid`); `principal` cho nợ vay. */
export function executedSum(rows: SettlementRow[], field: 'amount' | 'principal' = 'amount'): bigint {
  let total = 0n;
  for (const r of rows) {
    if (r.doc_status !== 'paid') continue;
    total += field === 'amount' ? r.amount : r.principal;
  }
  return total;
}

/** Còn phải thu / phải trả = giá trị − đã cấn trừ, không âm. */
export function remainingOf(value: bigint, applied: bigint): bigint {
  const r = value - applied;
  return r > 0n ? r : 0n;
}

/** Dư nợ vay = gốc − đã trả gốc; khoản chờ giải ngân / đã huỷ không tính dư nợ (v2 §10.2). */
export function outstandingLoanOf(principal: bigint, repaidPrincipal: bigint, status: string): bigint {
  if (status === 'pending_disbursement' || status === 'cancelled') return 0n;
  return remainingOf(principal, repaidPrincipal);
}

/** Số ngày quá hạn (dương) của khoản công nợ tính tới `today` (YYYY-MM-DD). */
export function overdueDaysOf(dueDate: string, today: string): number {
  if (!dueDate || dueDate >= today) return 0;
  const a = Date.parse(`${dueDate}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}

/** Tỷ trọng (%) của `part` trên `total`, làm tròn 2 số thập phân. */
export function percentOf(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  return Number((part * 10_000n) / total) / 100;
}

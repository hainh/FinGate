/**
 * Sổ chi tiết đối tác (v2 §5.3 / §9 / §10): công nợ + khoản vay + phiếu thu/chi của MỘT đối tác
 * trong một kỳ, có số dư lũy kế.
 *
 * Quy ước dấu của "Dư" (balance):
 *   · dương  = đối tác còn NỢ CÔNG TY (phải thu ròng);
 *   · âm     = công ty còn NỢ đối tác (phải trả ròng / nợ vay ngân hàng).
 * Tác động lên dư (`effect`):
 *   · công nợ phải thu: +giá trị; phải trả: −giá trị;
 *   · phiếu thu cấn trừ phải thu: −số phân bổ; phiếu chi cấn trừ phải trả: +số phân bổ;
 *   · khoản vay giải ngân: −gốc; phiếu chi trả nợ vay: +phần gốc đã trả;
 *   · phiếu thu/chi KHÔNG gắn công nợ/khoản vay: chỉ là dòng tiền (effect = 0).
 */

import { Models } from '../../db/models.ts';
import { docHref } from '../queries/index.ts';
import { toBig } from '../links/index.ts';
import { debtDirectionOf, type SettlementRow } from './aggregate.ts';
import { dayOf, loadDebtSettlements, loadLoanSettlements } from './refs.ts';

export type LedgerKind = 'cong_no' | 'khoan_vay' | 'phieu_thu' | 'phieu_chi';

export interface PartnerLedgerEvent {
  /** YYYY-MM-DD */
  date: string;
  kind: LedgerKind;
  code: string;
  description: string;
  cash_in: bigint;
  cash_out: bigint;
  effect: bigint;
  ref_id: string;
  href: string | null;
}

export interface PartnerLedgerRow extends PartnerLedgerEvent {
  balance: bigint;
}

export interface PartnerLedgerResult {
  opening: bigint;
  rows: PartnerLedgerRow[];
  totals: { cash_in: bigint; cash_out: bigint; effect: bigint; closing: bigint };
}

const KIND_ORDER: Record<LedgerKind, number> = { cong_no: 0, khoan_vay: 1, phieu_thu: 2, phieu_chi: 2 };

/**
 * Dựng sổ: `opening` = Σ tác động trước `from`; các dòng trong [from, to] có số dư lũy kế.
 * Sắp theo ngày → loại (công nợ, vay, chứng từ) → mã.
 */
export function buildPartnerLedger(events: PartnerLedgerEvent[], from: string, to: string): PartnerLedgerResult {
  const sorted = [...events].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.code.localeCompare(b.code) ||
      a.ref_id.localeCompare(b.ref_id),
  );
  let opening = 0n;
  for (const e of sorted) if (e.date < from) opening += e.effect;

  let running = opening;
  let cashIn = 0n;
  let cashOut = 0n;
  let effect = 0n;
  const rows: PartnerLedgerRow[] = [];
  for (const e of sorted) {
    if (e.date < from || e.date > to) continue;
    running += e.effect;
    cashIn += e.cash_in;
    cashOut += e.cash_out;
    effect += e.effect;
    rows.push({ ...e, balance: running });
  }
  return { opening, rows, totals: { cash_in: cashIn, cash_out: cashOut, effect, closing: running } };
}

/* ------------------------------------------------------------------ *
 * Nạp sự kiện từ DB
 * ------------------------------------------------------------------ */

interface DocEventMeta {
  kind: string;
  code: string;
  date: string;
  title: string;
  cash: bigint;
}

/**
 * Toàn bộ sự kiện của đối tác (mọi kỳ) — lọc theo kỳ ở `buildPartnerLedger`.
 * Phạm vi công ty do caller kiểm tra trên `partnerId` trước khi gọi.
 */
export async function loadPartnerLedgerEvents(partnerId: string): Promise<PartnerLedgerEvent[]> {
  const [debts, loans] = await Promise.all([
    Models.DebtVoucher.find({ partner_id: partnerId } as never)
      .select({ code: 1, direction: 1, side: 1, value_minor: 1, due_date: 1, created_at: 1, contract_code: 1 })
      .lean<Record<string, unknown>[]>(),
    Models.BankDebt.find({ partner_id: partnerId, status: { $in: ['active', 'overdue', 'settled', 'archived'] } } as never)
      .select({ code: 1, principal_minor: 1, disbursed_at: 1, created_at: 1, maturity_date: 1, status: 1 })
      .lean<Record<string, unknown>[]>(),
  ]);

  const direction = new Map<string, 'receivable' | 'payable'>();
  for (const d of debts) direction.set(String(d._id), debtDirectionOf(d as never));

  const [debtRows, loanRows] = await Promise.all([
    loadDebtSettlements(debts.map((d) => ({ id: String(d._id) }))),
    loadLoanSettlements(loans.map((l) => ({ id: String(l._id) }))),
  ]);
  const executedDebt = debtRows.filter((r) => r.doc_status === 'paid');
  const executedLoan = loanRows.filter((r) => r.doc_status === 'paid');

  const events: PartnerLedgerEvent[] = [];

  // 1 · công nợ ghi nhận
  for (const d of debts) {
    const id = String(d._id);
    const dir = direction.get(id) ?? 'payable';
    const value = toBig((d.value_minor as unknown) ?? 0);
    events.push({
      date: dayOf(d.created_at),
      kind: 'cong_no',
      code: String(d.code ?? ''),
      description: `${dir === 'receivable' ? 'Phải thu' : 'Phải trả'}${d.contract_code ? ` · HĐ ${String(d.contract_code)}` : ''} · hạn ${String(d.due_date ?? '')}`,
      cash_in: 0n,
      cash_out: 0n,
      effect: dir === 'receivable' ? value : -value,
      ref_id: id,
      href: `/cong-no/phieu/${id}`,
    });
  }

  // 2 · khoản vay ngân hàng (gốc giải ngân)
  for (const l of loans) {
    const id = String(l._id);
    const principal = toBig(l.principal_minor);
    events.push({
      date: dayOf(l.disbursed_at ?? l.created_at),
      kind: 'khoan_vay',
      code: String(l.code ?? ''),
      description: `Khoản vay · đáo hạn ${String(l.maturity_date ?? '')}`,
      cash_in: 0n,
      cash_out: 0n,
      effect: -principal,
      ref_id: id,
      href: `/ngan-hang/khoan-vay/${id}`,
    });
  }

  // 3 · phiếu đã thực thi: của đối tác + phiếu chỉ xuất hiện qua phân bổ
  const effectByDoc = effectsByDocument(executedDebt, executedLoan, direction);
  const partnerDocs = await Models.Document.find({ partner_id: partnerId, status: 'paid' } as never)
    .select({ code: 1, kind: 1, title: 1, amount: 1, execution: 1, planned_date: 1 })
    .lean<Record<string, unknown>[]>();
  const meta = new Map<string, DocEventMeta>();
  for (const d of partnerDocs) {
    const exec = (d.execution ?? {}) as { paid_at?: unknown; actual_amount_minor?: unknown };
    const amountMinor = toBig((d.amount as { minor?: unknown } | undefined)?.minor);
    meta.set(String(d._id), {
      kind: String(d.kind ?? ''),
      code: String(d.code ?? ''),
      date: dayOf(exec.paid_at ?? d.planned_date),
      title: String(d.title ?? ''),
      cash: exec.actual_amount_minor !== undefined && exec.actual_amount_minor !== null ? toBig(exec.actual_amount_minor) : amountMinor,
    });
  }
  for (const r of [...executedDebt, ...executedLoan]) {
    if (meta.has(r.document_id)) continue;
    meta.set(r.document_id, { kind: r.doc_kind, code: r.doc_code, date: r.doc_date, title: '', cash: r.doc_amount });
  }
  for (const [docId, m] of meta) {
    const isIncome = m.kind === 'income';
    const effect = effectByDoc.get(docId) ?? 0n;
    events.push({
      date: m.date,
      kind: isIncome ? 'phieu_thu' : 'phieu_chi',
      code: m.code,
      description: [m.title, effect !== 0n ? (isIncome ? 'cấn trừ công nợ' : 'trả công nợ / nợ vay') : ''].filter(Boolean).join(' · '),
      cash_in: isIncome ? m.cash : 0n,
      cash_out: isIncome ? 0n : m.cash,
      effect,
      ref_id: docId,
      href: docHref(m.kind, docId),
    });
  }

  return events;
}

/** Tác động lên dư của từng phiếu đã thực thi: cấn trừ công nợ + trả nợ vay (phần gốc). */
export function effectsByDocument(
  debtRows: SettlementRow[],
  loanRows: SettlementRow[],
  direction: ReadonlyMap<string, 'receivable' | 'payable'>,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (docId: string, v: bigint) => out.set(docId, (out.get(docId) ?? 0n) + v);
  for (const r of debtRows) {
    const dir = direction.get(r.target_id) ?? 'payable';
    add(r.document_id, dir === 'receivable' ? -r.amount : r.amount);
  }
  for (const r of loanRows) add(r.document_id, r.principal);
  return out;
}


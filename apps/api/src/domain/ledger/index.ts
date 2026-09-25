/**
 * Sổ cái dòng tiền — NGUỒN SỰ THẬT cho tiền đã thực sự dịch chuyển (actual).
 *
 * Nguyên tắc:
 *   · Append-only, insert-only: mỗi phát sinh = 1 entry bất biến, khoá idempotency `dedupe_key`.
 *   · Số dư (account, tới ngày D) = Σ entries có `date ≤ D` — liên tục, KHÔNG reset, KHÔNG rollover tay.
 *   · Không có số dư đầu ngày: ledger khởi tạo rỗng, chỉ tích luỹ từ thu/chi đã thực thi.
 *   · `bank_transactions` (sao kê) KHÔNG ghi vào đây — chỉ dùng để đối chiếu `check:tie`.
 *   · `balances_daily` là VIEW dẫn xuất từ ledger (`recomputeAccountBalances`).
 */

import { datePartOf } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { oid } from '../../lib/mongo.ts';
import type { DomainDoc } from '../types.ts';

export interface CashEntryInput {
  company_id: string;
  account_id: string;
  /** `YYYY-MM-DD` — ngày nghiệp vụ (ngày thực chi/thu). */
  date: string;
  direction: 'in' | 'out';
  /** luôn DƯƠNG; chiều nằm ở `direction`. */
  amount_minor: bigint;
  currency?: string;
  reason?: 'paid' | 'installment' | 'account_move' | 'mirror';
  document_id?: string | null;
  document_code?: string | null;
  mirror_of?: string | null;
  reverses?: string | null;
  dedupe_key: string;
  created_by?: string | null;
}

function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

/** Tài khoản nguồn thực nhận/chi: tài khoản công ty, fallback tài khoản Tập đoàn. */
export function sourceAccountOf(doc: {
  source?: { account_id?: string | null; group_account_id?: string | null } | null;
}): string | null {
  const direct = doc.source?.account_id ? String(doc.source.account_id) : null;
  if (direct) return direct;
  return doc.source?.group_account_id ? String(doc.source.group_account_id) : null;
}

/**
 * Ghi entries — idempotent theo `dedupe_key`. Trả về số entry MỚI được chèn.
 * Không bao giờ sửa/xoá entry cũ; điều chỉnh = entry mới có `reverses`.
 */
export async function postCashEntries(entries: CashEntryInput[]): Promise<number> {
  let posted = 0;
  for (const e of entries) {
    if (!e.account_id || !e.company_id || e.amount_minor <= 0n) continue;
    try {
      const res = await Models.CashEntry.updateOne(
        { dedupe_key: e.dedupe_key } as never,
        {
          $setOnInsert: {
            company_id: e.company_id,
            account_id: e.account_id,
            date: e.date,
            direction: e.direction,
            amount_minor: e.amount_minor,
            currency: e.currency ?? 'VND',
            reason: e.reason ?? 'paid',
            document_id: e.document_id ?? null,
            document_code: e.document_code ?? null,
            mirror_of: e.mirror_of ?? null,
            reverses: e.reverses ?? null,
            dedupe_key: e.dedupe_key,
            created_by: e.created_by ?? null,
            created_at: new Date(),
          },
        },
        { upsert: true },
      ).exec();
      if (res.upsertedCount) posted++;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err; // 11000 = đã có (đua) → bỏ qua
    }
  }
  return posted;
}

/** Entries cho MỘT khoản thực chi/thu (1 phiếu thường, hoặc 1 kỳ của phiếu từng phần). */
export function entriesForPayment(input: {
  doc: DomainDoc;
  accountId: string;
  amountMinor: bigint;
  date: string;
  installmentIndex: number;
  currency?: string;
  createdBy?: string | null;
}): CashEntryInput[] {
  const { doc } = input;
  const id = String(doc._id);
  const isIn = doc.kind === 'income';
  const day = datePartOf(input.date);
  const currency = input.currency ?? doc.amount?.currency ?? 'VND';
  const reason: CashEntryInput['reason'] = doc.execution?.allow_partial ? 'installment' : 'paid';

  const out: CashEntryInput[] = [
    {
      company_id: String(doc.company_id),
      account_id: input.accountId,
      date: day,
      direction: isIn ? 'in' : 'out',
      amount_minor: input.amountMinor,
      currency,
      reason,
      document_id: id,
      document_code: doc.code ?? null,
      dedupe_key: `doc:${id}:actual:${input.installmentIndex}`,
      created_by: input.createdBy ?? null,
    },
  ];

  // chuyển tiền nội bộ: đối ứng công ty đích (§XXI) — KHÔNG tính doanh thu/chi phí.
  if (doc.kind === 'internal' && doc.target?.account_id && doc.target?.company_id) {
    out.push({
      company_id: String(doc.target.company_id),
      account_id: String(doc.target.account_id),
      date: day,
      direction: 'in',
      amount_minor: input.amountMinor,
      currency,
      reason: 'mirror',
      document_id: id,
      document_code: doc.code ?? null,
      dedupe_key: `doc:${id}:actual:${input.installmentIndex}:mirror:${String(doc.target.account_id)}`,
      created_by: input.createdBy ?? null,
    });
  }
  return out;
}

/**
 * Backfill: dựng entries từ MỘT hồ sơ đã thực thi — `paid`, hoặc phiếu chi từng phần
 * đang mở (`approved`/`processing`) đã có kỳ `installments`. Dùng chung `dedupe_key`
 * với runtime → chạy lại không nhân đôi.
 */
export function entriesForExecutedDocument(doc: {
  _id: string;
  code: string;
  kind: string;
  company_id: string;
  amount: { minor: bigint; currency?: string };
  source?: { account_id?: string | null; group_account_id?: string | null } | null;
  target?: { company_id?: string | null; account_id?: string | null } | null;
  planned_date?: string;
  status?: string;
  execution?: {
    paid_at?: string | null;
    actual_amount_minor?: bigint | null;
    allow_partial?: boolean | null;
    installments?: { at?: string | null; amount_minor?: bigint | null; account_id?: string | null }[];
  } | null;
}): CashEntryInput[] {
  const status = String(doc.status ?? '');
  const allInstallments = Array.isArray(doc.execution?.installments) ? doc.execution!.installments! : [];
  const executed =
    status === 'paid' || ((status === 'approved' || status === 'processing') && allInstallments.length > 0);
  if (!executed) return [];
  const sourceAccount = sourceAccountOf(doc);
  if (!sourceAccount) return [];
  const isIn = doc.kind === 'income';
  const id = String(doc._id);
  const currency = doc.amount.currency ?? 'VND';
  const exec = doc.execution ?? {};
  const installments = Array.isArray(exec.installments) ? exec.installments : [];
  const partial = Boolean(exec.allow_partial) && installments.length > 0;

  const out: CashEntryInput[] = [];
  const push = (accountId: string, amountMinor: bigint, date: string, index: number, isMirror: boolean) => {
    if (amountMinor <= 0n || !date) return;
    out.push({
      company_id: isMirror ? String(doc.target?.company_id) : String(doc.company_id),
      account_id: accountId,
      date: datePartOf(date),
      direction: isMirror ? 'in' : isIn ? 'in' : 'out',
      amount_minor: amountMinor,
      currency,
      reason: isMirror ? 'mirror' : partial ? 'installment' : 'paid',
      document_id: id,
      document_code: doc.code,
      dedupe_key: isMirror
        ? `doc:${id}:actual:${index}:mirror:${accountId}`
        : `doc:${id}:actual:${index}`,
    });
  };

  if (partial) {
    installments.forEach((inst, idx) => {
      const acct = inst.account_id ? String(inst.account_id) : sourceAccount;
      push(acct, toBig(inst.amount_minor), String(inst.at ?? exec.paid_at ?? doc.planned_date ?? ''), idx, false);
    });
  } else {
    const amount = toBig(exec.actual_amount_minor ?? doc.amount.minor);
    push(sourceAccount, amount, String(exec.paid_at ?? doc.planned_date ?? ''), 0, false);
  }

  if (doc.kind === 'internal' && doc.target?.account_id && doc.target?.company_id) {
    if (partial) {
      installments.forEach((inst, idx) => {
        push(String(doc.target!.account_id), toBig(inst.amount_minor), String(inst.at ?? exec.paid_at ?? doc.planned_date ?? ''), idx, true);
      });
    } else {
      push(String(doc.target.account_id), toBig(exec.actual_amount_minor ?? doc.amount.minor), String(exec.paid_at ?? doc.planned_date ?? ''), 0, true);
    }
  }
  return out;
}

/** Số dư đã ghi sổ của tài khoản tính đến hết ngày `uptoDate` = Σ entries (in − out). */
export async function bookedBalance(accountId: string, uptoDate: string): Promise<bigint> {
  const rows = await Models.CashEntry.aggregate([
    { $match: { account_id: oid(accountId), date: { $lte: uptoDate } } },
    {
      $group: {
        _id: null,
        in_minor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount_minor', 0] } },
        out_minor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount_minor', 0] } },
      },
    },
  ] as never[]);
  const r = (rows as { in_minor?: unknown; out_minor?: unknown }[])[0];
  return toBig(r?.in_minor) - toBig(r?.out_minor);
}

/**
 * Materialize lại `balances_daily` cho các tài khoản bị ảnh hưởng, TỪ LEDGER.
 *
 * Vì ledger có thể nhận bút toán lùi ngày, recompute lại TOÀN BỘ chuỗi ngày của
 * tài khoản (cumulative `opening`/`closing`) — đúng và idempotent. `blocked_minor`
 * (nếu có) được giữ nguyên; `planned_*` không thuộc ledger nên chỉ đặt khi tạo mới.
 */
export async function recomputeAccountBalances(accountIds: string[]): Promise<{ accounts: number; rows: number }> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  let rows = 0;
  for (const accountId of ids) {
    const account = await Models.BankAccount.findById(accountId)
      .select({ company_id: 1, min_balance_minor: 1 })
      .lean<{ company_id?: unknown; min_balance_minor?: unknown } | null>();
    if (!account) continue;

    const agg = (await Models.CashEntry.aggregate([
      { $match: { account_id: oid(accountId) } },
      {
        $group: {
          _id: '$date',
          company_id: { $first: '$company_id' },
          in_minor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount_minor', 0] } },
          out_minor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount_minor', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ] as never[])) as { _id?: unknown; company_id?: unknown; in_minor?: unknown; out_minor?: unknown }[];

    const min = toBig(account.min_balance_minor);
    let running = 0n;
    for (const r of agg) {
      const date = String(r._id);
      const inMinor = toBig(r.in_minor);
      const outMinor = toBig(r.out_minor);
      const opening = running;
      const closing = opening + inMinor - outMinor;
      running = closing;

      const prev = await Models.BalanceDaily.findOne({ account_id: accountId, date } as never)
        .select({ blocked_minor: 1 })
        .lean<{ blocked_minor?: unknown } | null>();
      const blocked = toBig(prev?.blocked_minor);

      await Models.BalanceDaily.updateOne(
        { account_id: accountId, date } as never,
        {
          $set: {
            company_id: account.company_id ?? r.company_id ?? null,
            actual_in_minor: inMinor,
            actual_out_minor: outMinor,
            opening_minor: opening,
            closing_minor: closing,
            min_balance_minor: min,
            breach: closing - blocked < min,
            source: 'system',
            updated_at: new Date(),
          },
          $setOnInsert: { planned_in_minor: 0n, planned_out_minor: 0n, blocked_minor: blocked, version: 1 },
        },
        { upsert: true },
      ).exec();
      rows++;
    }
  }
  return { accounts: ids.length, rows };
}

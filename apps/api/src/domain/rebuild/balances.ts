/**
 * Dựng lại sổ cái + số dư — `pnpm db:rebuild-ledger` / `pnpm db:rebuild-balances`.
 *
 *   · `rebuildLedger()`   — hồ sơ đã `paid` → `cash_entries` (idempotent theo dedupe_key). Backfill/migration.
 *   · `rebuildBalances()` — `cash_entries` → `balances_daily` (opening/closing cumulative, liên tục).
 *
 * Không có số dư đầu ngày: ledger khởi tạo rỗng và chỉ tích luỹ từ thu/chi đã thực thi.
 */

import { Models } from '../../db/models.ts';
import { entriesForExecutedDocument, postCashEntries, recomputeAccountBalances } from '../ledger/index.ts';

/** Backfill ledger từ hồ sơ đã thực thi. Idempotent — chạy lại không nhân đôi. */
export async function rebuildLedger(): Promise<Record<string, unknown>> {
  const docs = await Models.Document.find({ status: { $in: ['paid', 'approved', 'processing'] } } as never)
    .select({ _id: 1, code: 1, kind: 1, company_id: 1, amount: 1, source: 1, target: 1, planned_date: 1, status: 1, execution: 1 })
    .lean();

  let inserted = 0;
  const touched = new Set<string>();
  for (const d of docs) {
    const built = entriesForExecutedDocument(d as never);
    if (!built.length) continue;
    for (const e of built) touched.add(e.account_id);
    inserted += await postCashEntries(built);
  }
  return { documents: docs.length, entries_inserted: inserted, accounts: touched.size, at: new Date().toISOString() };
}

/**
 * Dựng lại `balances_daily` từ ledger. Xoá sạch view cũ (kể cả dòng planned-only mồ côi)
 * rồi materialize lại — idempotent, `closing` = Σ entries ≤ ngày.
 */
export async function rebuildBalances(): Promise<Record<string, unknown>> {
  const accounts = await Models.BankAccount.find({} as never).select({ _id: 1 }).lean();
  const deleted = await Models.BalanceDaily.deleteMany({} as never).exec();
  const res = await recomputeAccountBalances(accounts.map((a) => String(a._id)));
  return {
    accounts: res.accounts,
    written: res.rows,
    deleted: deleted.deletedCount ?? 0,
    at: new Date().toISOString(),
  };
}

/** Tiện cho seed/maintenance: ledger trước, view sau. */
export async function rebuildLedgerAndBalances(): Promise<Record<string, unknown>> {
  const ledger = await rebuildLedger();
  const balances = await rebuildBalances();
  return { ledger, balances };
}

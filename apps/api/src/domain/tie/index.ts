/**
 * Đối chiếu tiền (§8.5) — Σ bank_transactions vs Σ execution thực nhận/trả vs balances_daily.
 * Lệch → alert danger + KHOÁ EXPORT + báo KTT. KHÔNG tự sửa số (red line §19.5-9).
 */

import { Models } from '../../db/models.ts';
import { scopedAggregate } from '../../lib/mongo.ts';
import { setTieLock } from '../tie-lock.ts';

export interface TieResult {
  ok: boolean;
  checked_accounts: number;
  mismatches: { account_id: string; statement: string; documents: string; balance: string }[];
  [k: string]: unknown;
}

const first = (rows: { total?: unknown }[]): bigint => {
  const v = rows[0]?.total;
  if (typeof v === 'bigint') return v;
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
};

export async function checkTie(): Promise<TieResult> {
  const accounts = await Models.BankAccount.find({ status: { $ne: 'closed' } }).select({ bank_name: 1, account_number: 1 }).lean();
  const mismatches: TieResult['mismatches'] = [];

  for (const a of accounts) {
    const accountId = String(a._id);
    const stmt = first(
      await scopedAggregate<{ total?: unknown }>(Models.BankTransaction, { companyIds: null }, [
        { $match: { account_id: accountId } },
        { $group: { _id: null, total: { $sum: '$amount_minor' } } },
      ]),
    );
    const docs = first(
      await scopedAggregate<{ total?: unknown }>(Models.Document, { companyIds: null }, [
        { $match: { status: 'paid' } },
        { $match: { 'source.account_id': accountId } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$execution.actual_amount.minor', '$amount.minor'] } } } },
      ]),
    );
    // Phiếu chi từng phần còn mở: các kỳ đã thực thi vẫn là dòng tiền thật đã ra/vào.
    const partial = first(
      await scopedAggregate<{ total?: unknown }>(Models.Document, { companyIds: null }, [
        { $match: { status: { $in: ['approved', 'processing'] } } },
        { $match: { 'source.account_id': accountId } },
        { $unwind: '$execution.installments' },
        { $group: { _id: null, total: { $sum: '$execution.installments.amount_minor' } } },
      ]),
    );
    const latest = await Models.BalanceDaily.find({ account_id: accountId }).sort({ date: -1 }).limit(2).select({ closing_minor: 1, date: 1 }).lean();
    const balance = latest.length ? first([{ total: latest[0]?.closing_minor }]) - first([{ total: latest.at(-1)?.closing_minor }]) : 0n;
    const ledger = docs + partial;

    // sai lệch giữa sao kê và sổ hồ sơ là lỗi; lệch với biến động số dư cho dung sai 1 triệu
    if (stmt !== ledger || (ledger !== 0n && balance !== 0n && ledger - balance > 1_000_000n)) {
      mismatches.push({ account_id: accountId, statement: stmt.toString(), documents: ledger.toString(), balance: balance.toString() });
    }
  }

  if (mismatches.length) {
    await setTieLock(mismatches);
    await Models.Alert.create({
      type: 'event',
      alert_type: 'low_balance',
      severity: 3,
      text: `Đối chiếu tiền lệch ở ${mismatches.length} tài khoản — đã khoá xuất dữ liệu, cần Kế toán trưởng kiểm tra`,
      dedupe_key: `tie:${new Date().toISOString().slice(0, 10)}`,
      subject: { mismatches },
    } as never).catch(() => undefined);
  } else {
    await setTieLock(null);
  }
  return { ok: mismatches.length === 0, checked_accounts: accounts.length, mismatches };
}

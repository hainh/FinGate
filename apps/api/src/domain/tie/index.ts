/**
 * Đối chiếu tiền (§8.5) — 3 chiều, cùng cơ sở NET (thu − chi):
 *   · Σ `bank_transactions` (sao kê, có dấu)
 *   · Σ chứng từ đã thực thi (`paid` + kỳ `installments` của phiếu chi từng phần còn mở)
 *   · Σ `cash_entries` (sổ cái)
 *
 * Lệch → alert danger + KHOÁ EXPORT + báo KTT. KHÔNG tự sửa số (red line §19.5-9).
 */

import { Models } from '../../db/models.ts';
import { oid, scopedAggregate } from '../../lib/mongo.ts';
import { setTieLock } from '../tie-lock.ts';

export interface TieResult {
  ok: boolean;
  checked_accounts: number;
  mismatches: { account_id: string; statement: string; documents: string; balance: string }[];
  [key: string]: unknown;
}

const firstBig = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
};

interface FlowRow {
  in_minor?: unknown;
  out_minor?: unknown;
}

const flow = (rows: FlowRow[]): bigint => firstBig(rows[0]?.in_minor) - firstBig(rows[0]?.out_minor);

export async function checkTie(): Promise<TieResult> {
  const accounts = await Models.BankAccount.find({ status: { $ne: 'closed' } }).select({ bank_name: 1, account_number: 1 }).lean();
  const mismatches: TieResult['mismatches'] = [];

  for (const a of accounts) {
    const accountId = String(a._id);

    // 1 · sao kê ngân hàng (đã có dấu: âm = chi)
    const statement = firstBig(
      (
        await scopedAggregate<{ total?: unknown }>(Models.BankTransaction, { companyIds: null }, [
          { $match: { account_id: oid(accountId) } },
          { $group: { _id: null, total: { $sum: '$amount_minor' } } },
        ])
      )[0]?.total,
    );

    // 2 · chứng từ đã thực thi — net theo chiều
    const paid = await scopedAggregate<FlowRow>(Models.Document, { companyIds: null }, [
      { $match: { status: 'paid', 'source.account_id': oid(accountId) } },
      {
        $group: {
          _id: null,
          in_minor: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, { $ifNull: ['$execution.actual_amount.minor', '$amount.minor'] }, 0] } },
          out_minor: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, 0, { $ifNull: ['$execution.actual_amount.minor', '$amount.minor'] }] } },
        },
      },
    ]);
    // phiếu chi từng phần còn mở: các kỳ đã thực thi vẫn là dòng tiền thật đã ra/vào
    const partial = await scopedAggregate<FlowRow>(Models.Document, { companyIds: null }, [
      { $match: { status: { $in: ['approved', 'processing'] }, 'source.account_id': oid(accountId) } },
      { $unwind: '$execution.installments' },
      {
        $group: {
          _id: null,
          in_minor: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, '$execution.installments.amount_minor', 0] } },
          out_minor: { $sum: { $cond: [{ $eq: ['$kind', 'income'] }, 0, '$execution.installments.amount_minor'] } },
        },
      },
    ]);
    const documents = flow(paid) + flow(partial);

    // 3 · sổ cái (in − out)
    const ledger = flow(
      await scopedAggregate<FlowRow>(Models.CashEntry, { companyIds: null }, [
        { $match: { account_id: oid(accountId) } },
        {
          $group: {
            _id: null,
            in_minor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount_minor', 0] } },
            out_minor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount_minor', 0] } },
          },
        },
      ]),
    );

    // sổ cái phải khớp chứng từ (cùng nguồn); sao kê ngân hàng phải khớp cả hai
    if (statement !== documents || ledger !== documents) {
      mismatches.push({ account_id: accountId, statement: statement.toString(), documents: documents.toString(), balance: ledger.toString() });
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

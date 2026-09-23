/**
 * `pnpm db:rebuild-balances` — dựng lại `balances_daily` từ hồ sơ (§8.3).
 * Idempotent; giữ `opening`/`blocked` đã ghi nhận trước đó để không mất dữ liệu thủ quỹ.
 */

import { datePartOf } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { asBigInt } from '../queries/index.ts';

interface Cell {
  company_id: string;
  date: string;
  planned_in: bigint;
  planned_out: bigint;
  actual_in: bigint;
  actual_out: bigint;
}

export async function rebuildBalances(): Promise<Record<string, unknown>> {
  const accounts = await Models.BankAccount.find({} as never).select({ company_id: 1, min_balance_minor: 1 }).lean();
  const accountById = new Map(accounts.map((a) => [String(a._id), a]));
  const docs = await Models.Document.find({ status: { $ne: 'draft' } } as never)
    .select({ company_id: 1, kind: 1, status: 1, planned_date: 1, amount: 1, source: 1, execution: 1, target: 1 })
    .lean();

  const cells = new Map<string, Cell>();
  const touch = (account: string, company: string, date: string): Cell => {
    const k = `${account}|${date}`;
    let c = cells.get(k);
    if (!c) {
      c = { company_id: company, date, planned_in: 0n, planned_out: 0n, actual_in: 0n, actual_out: 0n };
      cells.set(k, c);
    }
    return c;
  };

  for (const d of docs) {
    const company = String(d.company_id);
    const status = String(d.status);
    const minor = asBigInt((d.amount as { minor?: unknown } | undefined)?.minor);
    const isIn = String(d.kind) === 'income';
    const account = (d.source as { account_id?: unknown } | undefined)?.account_id;
    const exec = d.execution as
      | { paid_at?: string; actual_amount?: { minor?: unknown }; paid_minor?: unknown; installments?: { at?: string; amount_minor?: unknown }[] }
      | undefined;
    const installments = Array.isArray(exec?.installments) ? exec!.installments : [];
    const installmentSum = installments.reduce((a, i) => a + asBigInt(i.amount_minor), 0n);
    const paid = status === 'paid';
    const pendingStatuses = ['approved', 'processing', 'pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman'];
    const date = datePartOf(String(paid ? (exec?.paid_at ?? d.planned_date) : d.planned_date));

    if (account) {
      if (installments.length) {
        // phiếu chi từng phần: mỗi kỳ ghi actual đúng ngày phát sinh, phần chưa chi vẫn là dự toán
        for (const inst of installments) {
          const c = touch(String(account), company, datePartOf(String(inst.at ?? d.planned_date)));
          if (isIn) c.actual_in += asBigInt(inst.amount_minor);
          else c.actual_out += asBigInt(inst.amount_minor);
        }
        const remaining = minor - installmentSum;
        if (!paid && remaining > 0n && pendingStatuses.includes(status)) {
          const c = touch(String(account), company, datePartOf(String(d.planned_date)));
          if (isIn) c.planned_in += remaining;
          else c.planned_out += remaining;
        }
      } else if (paid) {
        const c = touch(String(account), company, date);
        const actual = asBigInt(exec?.actual_amount?.minor ?? 0n) || minor;
        if (isIn) c.actual_in += actual;
        else c.actual_out += actual;
      } else if (pendingStatuses.includes(status)) {
        const c = touch(String(account), company, date);
        if (isIn) c.planned_in += minor;
        else c.planned_out += minor;
      }
    }

    // phiếu thu/chi dùng nguồn Tập đoàn → ghi lên tài khoản tập đoàn
    const group = (d.source as { group_account_id?: unknown } | undefined)?.group_account_id;
    if (group && accountById.has(String(group))) {
      const c = touch(String(group), company, date);
      if (isIn) c.planned_in += minor;
      else c.planned_out += minor;
    }

    // chuyển tiền nội bộ: đối ứng ở công ty B, KHÔNG tính doanh thu/chi phí (§XXI)
    if (String(d.kind) === 'internal' && d.target) {
      const toAccount = (d.target as { account_id?: unknown } | undefined)?.account_id;
      const toCompany = (d.target as { company_id?: unknown } | undefined)?.company_id;
      if (toAccount && toCompany) {
        const c = touch(String(toAccount), String(toCompany), date);
        if (installments.length) for (const inst of installments) c.actual_in += asBigInt(inst.amount_minor);
        else if (paid) c.actual_in += asBigInt(exec?.actual_amount?.minor ?? 0n) || minor;
      }
    }
  }

  let written = 0;
  for (const [k, c] of cells) {
    const account_id = k.split('|')[0] as string;
    const account = accountById.get(account_id);
    if (!account) continue;
    const min = asBigInt((account as { min_balance_minor?: unknown }).min_balance_minor);
    const prev = await Models.BalanceDaily.findOne({ account_id, date: c.date } as never).lean();
    const opening = asBigInt((prev as { opening_minor?: unknown } | undefined)?.opening_minor ?? 0n);
    const blocked = asBigInt((prev as { blocked_minor?: unknown } | undefined)?.blocked_minor ?? 0n);
    const closing = opening + c.actual_in - c.actual_out;
    await Models.BalanceDaily.updateOne(
      { account_id, date: c.date } as never,
      {
        $set: {
          company_id: c.company_id,
          planned_in_minor: c.planned_in,
          planned_out_minor: c.planned_out,
          actual_in_minor: c.actual_in,
          actual_out_minor: c.actual_out,
          closing_minor: closing,
          min_balance_minor: min,
          breach: closing - blocked < min,
          source: 'system',
          updated_at: new Date(),
        },
        $inc: { version: 1 },
        $setOnInsert: { opening_minor: opening, blocked_minor: blocked },
      },
      { upsert: true },
    ).exec();
    written++;
  }
  return { accounts: accounts.length, documents: docs.length, cells: cells.size, written, at: new Date().toISOString() };
}

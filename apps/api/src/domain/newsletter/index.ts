/**
 * Bản tin tài chính hàng ngày (blueprint §XIV) — "tính khi đọc" + cache vào `settings`.
 *
 * Instance free ngủ nên cron có thể chạy muộn (§12.5): mở `/ban-tin` mà cache thiếu
 * thì hệ thống tự dựng lại — đó là lý do bản tin là HÀM THUẦN TÚC trên read path.
 */

import { addDays, formatMoney, money, today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import type { ScopeLike } from '../types.ts';
import { accountSnapshots, asBigInt, compact, forecast, maturityLadder, queryQueue, wire, type WireAmount } from '../queries/index.ts';

export interface Newsletter {
  date: string;
  generated_at: string;
  company_names: string[];
  lines: {
    total_cash: WireAmount;
    income_today: WireAmount;
    income_today_realized: WireAmount;
    spend_today: WireAmount;
    net_today: WireAmount;
    awaiting_me: WireAmount;
    awaiting_me_count: number;
    receivable_overdue: WireAmount;
    maturity_today: WireAmount;
    maturity_3d: WireAmount;
    maturity_7d: WireAmount;
    maturity_30d: WireAmount;
  };
  warnings: { tone: string; text: string; href: string | null }[];
  sections: { key: string; title: string; items: { label: string; amount: WireAmount | null; note: string | null }[] }[];
  print_url: string;
}

export async function buildNewsletter(scope: ScopeLike, date = today(), actorUserId?: string): Promise<Newsletter> {
  const horizon = await forecast(scope, { horizon: 30, from: date });
  const [accounts, mat, spendToday, incomeToday, overdue, awaiting] = await Promise.all([
    accountSnapshots(scope),
    maturityLadder(scope, { horizonDays: 30 }),
    sumToday(scope, 'spend', date),
    sumToday(scope, 'income', date),
    overdueReceivable(scope),
    actorUserId ? awaitingSum(scope, actorUserId) : Promise.resolve({ total: 0n, count: 0 }),
  ]);

  const cash = accounts.reduce((a, x) => a + x.available, 0n);
  const income = incomeToday.total;
  const spend = spendToday.total;
  const net = income - spend;
  const sumBucket = (days: number) => mat.filter((m) => m.days_to_due <= days).reduce((a, m) => a + asBigInt(m.outstanding.minor), 0n);

  const warnings: { tone: string; text: string; href: string | null }[] = [];
  for (const s of horizon.shortfall_by_company) {
    warnings.push({
      tone: 'danger',
      text: `${s.company_name} có khả năng thiếu ${compact(asBigInt(s.amount.minor))} vào ngày ${s.date}`,
      href: '/dong-tien',
    });
  }
  if (horizon.first_breach_date) {
    warnings.push({ tone: 'danger', text: `Dự kiến thủng ngưỡng tối thiểu vào ${horizon.first_breach_date}`, href: '/dong-tien' });
  }
  if (awaiting.count > 0) {
    warnings.push({ tone: 'warning', text: `${awaiting.count} khoản chờ duyệt · ${compact(awaiting.total)}`, href: '/cho-toi-duyet' });
  }
  const missing = await countMissingEvidence(scope);
  if (missing > 0) warnings.push({ tone: 'attention', text: `${missing} hồ sơ thiếu chứng từ`, href: '/can-xu-ly' });

  return {
    date,
    generated_at: new Date().toISOString(),
    company_names: accounts.map((a) => a.company_name).filter((v, i, arr) => arr.indexOf(v) === i),
    lines: {
      total_cash: wire(cash),
      income_today: wire(income),
      income_today_realized: wire(incomeToday.realized),
      spend_today: wire(spend),
      net_today: wire(net),
      awaiting_me: wire(awaiting.total),
      awaiting_me_count: awaiting.count,
      receivable_overdue: wire(overdue),
      maturity_today: wire(sumBucket(0)),
      maturity_3d: wire(sumBucket(3)),
      maturity_7d: wire(sumBucket(7)),
      maturity_30d: wire(sumBucket(30)),
    },
    warnings: warnings.slice(0, 8),
    sections: [
      {
        key: 'forecast',
        title: `Dòng tiền 30 ngày (${formatMoney(money(horizon.totals.net?.minor ?? '0'), { mode: 'compact' })} thuần)`,
        items: horizon.rows
          .filter((_, i) => i % 7 === 0)
          .slice(0, 6)
          .map((r) => ({ label: `${r.weekday} ${r.date}`, amount: r.closing, note: r.breach ? 'dưới ngưỡng' : null })),
      },
      {
        key: 'maturity',
        title: 'Đáo hạn',
        items: mat.slice(0, 6).map((m) => ({
          label: `${m.bank_name} ${m.contract_code}`,
          amount: m.outstanding,
          note: m.label,
        })),
      },
      {
        key: 'cash_by_account',
        title: 'Tiền theo tài khoản',
        items: accounts.slice(0, 8).map((a) => ({
          label: `${a.company_name} · ${a.label}`,
          amount: wire(a.available),
          note: a.stale ? 'chưa có số dư hôm nay' : a.breach ? 'dưới ngưỡng' : null,
        })),
      },
    ],
    print_url: `/in/ban-tin/${date}`,
  };
}

async function sumToday(scope: ScopeLike, kind: 'spend' | 'income', date: string) {
  const rows = await queryQueue({ scope, userId: '', kind, from: date, to: date, limit: 500 });
  let total = 0n;
  let realized = 0n;
  for (const r of rows.items) {
    const m = asBigInt(r.amount.minor);
    if (kind === 'spend' && ['draft'].includes(r.status)) continue;
    total += m;
    if (r.status === 'paid') realized += m;
  }
  return { total, realized };
}

async function awaitingSum(scope: ScopeLike, userId: string) {
  const rows = await queryQueue({ scope, userId, mine: 'to_approve', limit: 500 });
  return { total: rows.items.reduce((a, r) => a + asBigInt(r.amount.minor), 0n), count: rows.total };
}

async function overdueReceivable(scope: ScopeLike): Promise<bigint> {
  const items = await Models.DebtItem.find({
    kind: 'receivable',
    status: { $ne: 'settled' },
    due_date: { $lt: today() },
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds as never } }),
  })
    .select({ value_minor: 1, settled_minor: 1 })
    .limit(500)
    .lean();
  return items.reduce((a, d) => a + asBigInt(d.value_minor) - asBigInt(d.settled_minor), 0n);
}

async function countMissingEvidence(scope: ScopeLike): Promise<number> {
  return Models.Document.countDocuments({
    ...(scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds as never } }),
    'evidence.missing.0': { $exists: true },
    status: { $nin: ['paid', 'rejected', 'cancelled'] },
  } as never);
}

/* ------------------------------------------------------------------ *
 * Cache vào `settings` (không thêm collection — arch §8.1)
 * ------------------------------------------------------------------ */

export async function cachedNewsletter(key: string): Promise<Newsletter | null> {
  const doc = await Models.Setting.findOne({ key }).lean<{ value?: Newsletter } | null>();
  return (doc?.value as Newsletter | undefined) ?? null;
}

export async function storeNewsletter(key: string, data: Newsletter): Promise<void> {
  await Models.Setting.updateOne(
    { key },
    { $set: { key, value: data, updated_at: new Date() }, $setOnInsert: { description: 'Bản tin hàng ngày (cache)' } },
    { upsert: true },
  ).exec();
}

/** Ngày bản tin: hôm nay, và cho lịch sử DASH-04. */
export const newsletterDates = (n = 14, from = today()): string[] => Array.from({ length: n }, (_, i) => addDays(from, -i));

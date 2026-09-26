/**
 * Tầng đọc (architecture §8.3) — "tính khi đọc, cache khi cần".
 *
 *An toàn đa công ty: mọi câu query đi qua `withScope` / `scopedAggregate`
 * (lib/mongo.ts) — scope `$match` được ép vào ĐẦU pipeline, không đường nào đọc chéo
 * công ty (§7.5, §19.5-3).
 *
 * Projection ở mọi danh sách: không trả `purpose`, `history[]`, `attachments[]` (§8.7).
 */

import {
  DOC_KIND_LABEL,
  ROLE_LABEL,
  addDays,
  dayEndOf,
  dayStartOf,
  daysUntil,
  formatMoney,
  maturity,
  maturityLabel,
  money,
  statusLabel,
  today,
  type CashflowGroup,
  type CashflowPeriod,
  type DocKind,
  type Role,
} from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { cacheThrough } from '../../lib/cache.ts';
import { oid, scopedAggregate, scopedCount, withScope, type Scope } from '../../lib/mongo.ts';
import { waitingDays } from '../calendar/index.ts';
import type { ScopeLike } from '../types.ts';

/** Tiền trên wire: minor là STRING (arch §6). */
export interface WireAmount {
  minor: string;
  currency: string;
  decimals: number;
}

export const DECISION_STATUSES = [
  'pending.ktt',
  'pending.pgd',
  'pending.gd',
  'pending.ptg',
  'pending.chairman',
] as const;

/** Phiếu chi đã duyệt xong, đang nằm ở bàn kế toán chờ thực thi (chi). */
export const EXECUTION_STATUSES = ['approved', 'processing'] as const;

export const OPEN_STATUSES = [...DECISION_STATUSES, 'draft', 'changes_requested', 'approved', 'processing'];

export function wire(minor: bigint, currency = 'VND', decimals = 0): WireAmount {
  return { minor: minor.toString(), currency, decimals };
}

export function wireOf(m: unknown): WireAmount | null {
  if (!m || typeof m !== 'object') return null;
  const rec = m as Record<string, unknown>;
  if (rec.minor === undefined || rec.minor === null) return null;
  return wire(asBigInt(rec.minor), String(rec.currency ?? 'VND'), Number(rec.decimals ?? 0));
}

export function asBigInt(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

export function compact(minor: bigint, currency = 'VND'): string {
  return formatMoney(money(minor, currency), { mode: 'compact' });
}

export function scopeOf(scope: ScopeLike): Scope {
  return { companyIds: scope.companyIds };
}

/** Không còn che số tài khoản — trả về nguyên số đầy đủ. */
export function maskAccount(number: string): string {
  return String(number ?? '');
}

/* ================================================================== *
 * 1. Hàng chờ — APPR-01 / CHI-01 / THU-01 / DASH-01 (dùng chung khung List)
 * ================================================================== */

export interface QueueRow {
  _id: string;
  code: string;
  kind: DocKind;
  kind_label: string;
  company_id: string;
  company_name: string;
  department_name: string | null;
  created_by_name: string;
  title: string;
  status: string;
  status_label: string;
  overdue: boolean;
  waiting_days: number;
  current_owner: string | null;
  owner_name: string | null;
  fast_tracked_by: string | null;
  category_name: string | null;
  payee_name: string;
  amount: WireAmount;
  compact: string;
  planned_date: string;
  version: number;
  missing_evidence_count: number;
  href: string;
}

export interface QueueQuery {
  scope: ScopeLike;
  userId: string;
  /** vai trò đang hoạt động — dùng cho bước duyệt chưa gán người (`user_id: null`). */
  role?: Role;
  /**
   * Người gọi có quyền ghi nhận thanh toán (`payment:mark`) → hàng chờ "việc của tôi"
   * gồm thêm phiếu chi đã duyệt xong đang chờ thực thi (bàn kế toán viên/trưởng).
   */
  canPay?: boolean;
  kind?: DocKind;
  status?: string | string[];
  companyId?: string;
  mine?: 'created' | 'to_approve' | 'approved_by_me';
  from?: string;
  to?: string;
  q?: string;
  overdueOnly?: boolean;
  missingEvidenceOnly?: boolean;
  sort?: string;
  limit: number;
  page?: number;
}

const LIST_PROJECTION = {
  code: 1,
  kind: 1,
  company_id: 1,
  department_id: 1,
  created_by: 1,
  status: 1,
  title: 1,
  category_id: 1,
  payee: 1,
  amount: 1,
  planned_date: 1,
  version: 1,
  sla_deadline: 1,
  overdue: 1,
  submitted_at: 1,
  created_at: 1,
  updated_at: 1,
  'approval.steps': 1,
  'evidence.missing': 1,
} as const;

/**
 * "Chờ tôi duyệt" chỉ gồm hồ sơ mà bước của người gọi là cấp THẤP NHẤT còn chờ:
 * mọi cấp dưới trong ma trận duyệt của phiếu đó đã duyệt xong. Cấp cao hơn vẫn
 * thấy phiếu ở các danh sách khác (không truyền `mine`) để duyệt nhảy cấp (blueprint §IV).
 *
 * Bước chưa gán người (`user_id: null`) — xảy ra khi tài khoản/assignment của cấp
 * duyệt được tạo SAU khi hồ sơ đã gửi. Khi đó ai đúng vai trò cũng xử lý được.
 */
function lowestPendingOwnerFilter(userId: string, role?: Role): Record<string, unknown> {
  const owned = role
    ? {
        $or: [
          { $eq: [{ $toString: '$$s.user_id' }, userId] },
          { $and: [{ $eq: ['$$s.user_id', null] }, { $eq: ['$$s.role', role] }] },
        ],
      }
    : { $eq: [{ $toString: '$$s.user_id' }, userId] };
  return {
    $expr: {
      $let: {
        vars: {
          pending: {
            $filter: {
              input: '$approval.steps',
              as: 's',
              cond: { $in: ['$$s.state', ['current', 'waiting']] },
            },
          },
        },
        in: {
          $anyElementTrue: {
            $map: {
              input: '$$pending',
              as: 's',
              in: { $and: [{ $eq: ['$$s.order', { $min: '$$pending.order' }] }, owned] },
            },
          },
        },
      },
    },
  };
}

/** Phiếu chi đã duyệt xong đang chờ kế toán thực thi (không còn bước duyệt nào). */
function executionQueueFilter(): Record<string, unknown> {
  return { kind: 'spend', status: { $in: [...EXECUTION_STATUSES] } };
}

/** "Việc ở bàn tôi" = bước duyệt của tôi là cấp thấp nhất còn chờ, + (nếu được chi) phiếu chờ thực thi. */
function toApproveFilter(input: Pick<QueueQuery, 'userId' | 'role' | 'canPay'>): Record<string, unknown> {
  const parts: Record<string, unknown>[] = [lowestPendingOwnerFilter(input.userId, input.role)];
  if (input.canPay) parts.push(executionQueueFilter());
  return parts.length > 1 ? { $or: parts } : parts[0]!;
}

export function queueFilter(input: QueueQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (input.kind) filter.kind = input.kind;
  if (input.companyId) filter.company_id = input.companyId;
  if (input.status) filter.status = Array.isArray(input.status) ? { $in: input.status } : input.status;
  if (input.overdueOnly) filter.overdue = true;
  if (input.missingEvidenceOnly) filter['evidence.missing.0'] = { $exists: true };
  if (input.mine === 'created') filter.created_by = input.userId;
  if (input.mine === 'to_approve') {
    // gộp bằng `$and` để không đè lên `$or` của ô tìm kiếm (input.q) ở dưới.
    const cond = toApproveFilter(input);
    if ('$or' in cond) {
      const and = (filter.$and as Record<string, unknown>[] | undefined) ?? [];
      and.push(cond);
      filter.$and = and;
    } else {
      Object.assign(filter, cond);
    }
    if (!input.status) filter.status = { $in: [...DECISION_STATUSES, ...(input.canPay ? EXECUTION_STATUSES : [])] };
  }
  if (input.mine === 'approved_by_me') {
    filter['approval.steps'] = { $elemMatch: { user_id: input.userId, state: 'done' } };
  }
  if (input.from || input.to) {
    filter.planned_date = {
      ...(input.from ? { $gte: dayStartOf(input.from) } : {}),
      ...(input.to ? { $lte: dayEndOf(input.to) } : {}),
    };
  }
  if (input.q) {
    const rx = { $regex: escapeRegex(input.q), $options: 'i' };
    filter.$or = [{ code: rx }, { title: rx }, { 'payee.name': rx }];
  }
  return filter;
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sortForQueue(sort?: string): Record<string, 1 | -1> {
  switch (sort) {
    case '-amount':
      return { 'amount.minor': -1 };
    case '-planned_date':
      return { planned_date: -1 };
    case 'planned_date':
      return { planned_date: 1 };
    case 'created_at':
      return { created_at: 1 };
    case '-created_at':
      return { created_at: -1 };
    case 'waiting':
      return { sla_deadline: -1 };
    case '-waiting':
    default:
      // "chờ lâu nhất" lên đầu (screens §8.3 APPR-01)
      return { sla_deadline: 1, updated_at: 1 };
  }
}

export async function queryQueue(input: QueueQuery): Promise<{ items: QueueRow[]; total: number }> {
  const f = withScope(scopeOf(input.scope), queueFilter(input));
  const skip = ((input.page ?? 1) - 1) * input.limit;
  const [rows, total] = await Promise.all([
    Models.Document.find(f as never).select(LIST_PROJECTION as never).sort(sortForQueue(input.sort)).skip(skip).limit(input.limit).lean(),
    Models.Document.countDocuments(f as never),
  ]);
  const items = await decorateRows(rows as unknown as Record<string, unknown>[]);
  return { items, total };
}

interface StepLite {
  order: number;
  role: Role;
  user_id: string | null;
  state: string;
  decided_at?: Date | null;
  fast_tracked?: boolean;
}

async function decorateRows(rows: Record<string, unknown>[]): Promise<QueueRow[]> {
  const companies = await Models.Company.find({}).select({ name: 1 }).lean();
  const userIds = [
    ...new Set(rows.map((r) => String(r.created_by ?? '')).concat(rows.map((r) => currentStepOf(r)?.user_id ?? ''))),
  ].filter(Boolean);
  const catIds = rows.map((r) => r.category_id).filter(Boolean) as string[];
  const depIds = rows.map((r) => r.department_id).filter(Boolean) as string[];
  const [users, categories, departments] = await Promise.all([
    userIds.length
      ? Models.User.find({ _id: { $in: userIds } }).select({ display_name: 1, email: 1, status: 1 }).lean()
      : Promise.resolve([]),
    catIds.length ? Models.Category.find({ _id: { $in: catIds } }).select({ name: 1 }).lean() : Promise.resolve([]),
    depIds.length ? Models.Department.find({ _id: { $in: depIds } }).select({ name: 1 }).lean() : Promise.resolve([]),
  ]);

  const cname = new Map(companies.map((c) => [String(c._id), String(c.name)]));
  const uname = new Map(
    (users as { _id: unknown; display_name?: string; email?: string; status?: string }[]).map((u) => [
      String(u._id),
      `${u.display_name ?? u.email ?? '—'}${u.status === 'deactivated' ? ' (đã ngừng hoạt động)' : ''}`,
    ]),
  );
  const catname = new Map((categories as { _id: unknown; name?: string }[]).map((c) => [String(c._id), String(c.name)]));
  const depname = new Map((departments as { _id: unknown; name?: string }[]).map((d) => [String(d._id), String(d.name)]));

  return rows.map((r) => {
    const steps = stepsOf(r);
    const current = currentStepOf(r);
    const early = steps.filter((s) => s.state === 'done' && s.fast_tracked).map((s) => ROLE_LABEL[s.role] ?? s.role);
    const amount = wireOf(r.amount) ?? wire(0n);
    const status = String(r.status ?? 'draft');
    const evidence = r.evidence as { missing?: string[] } | undefined;
    const sla = r.sla_deadline ? new Date(String(r.sla_deadline)) : null;
    const submitted = r.submitted_at ?? r.created_at;
    return {
      _id: String(r._id),
      code: String(r.code ?? ''),
      kind: String(r.kind ?? 'spend') as DocKind,
      kind_label: DOC_KIND_LABEL[String(r.kind ?? 'spend') as DocKind] ?? '',
      company_id: String(r.company_id ?? ''),
      company_name: cname.get(String(r.company_id ?? '')) ?? '—',
      department_name: r.department_id ? (depname.get(String(r.department_id)) ?? null) : null,
      created_by_name: uname.get(String(r.created_by ?? '')) ?? '—',
      title: String(r.title ?? ''),
      status,
      status_label: statusLabel(status),
      overdue: Boolean(r.overdue) || (!!sla && sla < new Date() && DECISION_STATUSES.includes(status as never)),
      waiting_days: waitingDays(submitted ? new Date(String(submitted)) : null),
      // phiếu chi đã duyệt xong (không còn bước chờ) → đang ở bàn kế toán chờ thực thi
      current_owner: current
        ? (ROLE_LABEL[current.role] ?? current.role)
        : (EXECUTION_STATUSES as readonly string[]).includes(status)
          ? ROLE_LABEL.staff
          : null,
      owner_name: current?.user_id ? (uname.get(String(current.user_id)) ?? null) : null,
      fast_tracked_by: early.length ? early.join(', ') : null,
      category_name: r.category_id ? (catname.get(String(r.category_id)) ?? null) : null,
      payee_name: String((r.payee as { name?: string } | undefined)?.name ?? '—'),
      amount,
      compact: compact(asBigInt(amount.minor), amount.currency),
      planned_date: String(r.planned_date ?? ''),
      version: Number(r.version ?? 1),
      missing_evidence_count: evidence?.missing?.length ?? 0,
      href: docHref(String(r.kind ?? 'spend'), String(r._id)),
    };
  });
}

function stepsOf(r: Record<string, unknown>): StepLite[] {
  const approval = r.approval as { steps?: StepLite[] } | undefined;
  return approval?.steps ?? [];
}

/** "đang nằm ở bàn của ai" = cấp thấp nhất chưa duyệt (blueprint §IV). */
function currentStepOf(r: Record<string, unknown>): StepLite | null {
  const steps = stepsOf(r).filter((s) => s.state === 'current' || s.state === 'waiting');
  if (!steps.length) return null;
  return steps.sort((a, b) => a.order - b.order)[0] ?? null;
}

const KIND_SEGMENT: Record<string, string> = { spend: 'chi', income: 'thu', rollover: 'dao-han', internal: 'noi-bo' };

export function docHref(kind: string, id: string): string {
  return `/ho-so/${KIND_SEGMENT[kind] ?? kind}/${id}`;
}

/* ================================================================== *
 * 2. Badge & số dư
 * ================================================================== */

export async function awaitingBadge(
  scope: ScopeLike,
  userId: string,
  role?: Role,
  canPay = false,
): Promise<{ count: number; total_minor: bigint }> {
  return cacheThrough(`badge:${userId}:${role ?? ''}:${canPay ? 'pay' : ''}`, async () => {
    const f = withScope(scopeOf(scope), {
      ...toApproveFilter({ userId, role, canPay }),
      status: { $in: [...DECISION_STATUSES, ...(canPay ? EXECUTION_STATUSES : [])] },
    });
    const [count, rows] = await Promise.all([
      Models.Document.countDocuments(f as never),
      Models.Document.find(f as never).select({ 'amount.minor': 1, 'amount.currency': 1 }).limit(500).lean(),
    ]);
    const total = (rows as { amount?: { minor?: unknown } }[]).reduce((a, r) => a + asBigInt(r.amount?.minor ?? 0n), 0n);
    return { count, total_minor: total };
  });
}

export interface AccountSnapshot {
  account_id: string;
  company_id: string;
  company_name: string;
  label: string;
  account_number_masked: string;
  kind: string;
  currency: string;
  is_group: boolean;
  status: string;
  closing: bigint;
  blocked: bigint;
  available: bigint;
  min_balance: bigint;
  breach: boolean;
  stale: boolean;
  balance_date: string | null;
  open_docs: number;
}

/**
 * Số dư = bản `balances_daily` mới nhất mỗi tài khoản (không read model — §8.3).
 * `includeGroup`: công ty con vẫn thấy tài khoản Tập đoàn (company_id null, is_group)
 * bên cạnh tài khoản của chính mình — dùng cho danh sách/chọn nguồn tiền.
 */
export async function accountSnapshots(
  scope: ScopeLike,
  opts: { includeClosed?: boolean; includeGroup?: boolean } = {},
): Promise<AccountSnapshot[]> {
  const base = opts.includeClosed ? {} : { status: { $ne: 'closed' } };
  const filter: Record<string, unknown> =
    scope.companyIds === null
      ? base
      : opts.includeGroup
        ? { ...base, $or: [{ company_id: { $in: scope.companyIds } }, { is_group: true }] }
        : withScope(scopeOf(scope), base);
  const accounts = await Models.BankAccount.find(filter as never)
    .select({ company_id: 1, bank_name: 1, account_number: 1, account_name: 1, kind: 1, currency: 1, min_balance_minor: 1, is_group: 1, status: 1 })
    .lean();
  if (!accounts.length) return [];

  const ids = accounts.map((a) => String(a._id));
  // mongoose 9 aggregate $match KHÔNG cast string → ObjectId: phải tự cast (oid)
  const oidIds = ids.map((i) => oid(i));
  // Số dư hiện có = bản ghi cuối kỳ **tính đến hôm nay** — dòng planned ngày tương lai
  // (seed/jobs tạo trước) không được định nghĩa số dư hiện tại.
  const latest = await scopedAggregate<{ _id: string; date: string; closing: unknown; blocked: unknown }>(
    Models.BalanceDaily,
    scopeOf(scope),
    [{ $match: { account_id: { $in: oidIds as never }, date: { $lte: today() } } }, { $sort: { date: -1 } }, { $group: { _id: '$account_id', date: { $first: '$date' }, closing: { $first: '$closing_minor' }, blocked: { $first: '$blocked_minor' } } }],
    'company_id',
  );
  const byAccount = new Map(latest.map((l) => [String(l._id), l]));

  // TK tập đoàn có company_id = null → lọc rỗng để tránh CastError khi tra tên công ty
  const companyIds = [...new Set(accounts.map((a) => (a.company_id ? String(a.company_id) : '')))].filter(Boolean);
  const companies = await Models.Company.find({ _id: { $in: companyIds as never } }).select({ name: 1 }).lean();
  const cname = new Map(companies.map((c) => [String(c._id), String(c.name)]));

  return accounts.map((a) => {
    const rec = byAccount.get(String(a._id));
    const closing = asBigInt(rec?.closing ?? 0n);
    const blocked = asBigInt(rec?.blocked ?? 0n);
    const min = asBigInt(a.min_balance_minor ?? 0n);
    return {
      account_id: String(a._id),
      company_id: String(a.company_id ?? ''),
      company_name: cname.get(String(a.company_id ?? '')) ?? (a.is_group ? 'Tập đoàn' : '—'),
      label: `${a.bank_name} ${maskAccount(String(a.account_number ?? ''))}`,
      account_number_masked: maskAccount(String(a.account_number ?? '')),
      kind: String(a.kind ?? 'bank'),
      currency: String(a.currency ?? 'VND'),
      is_group: Boolean(a.is_group),
      status: String(a.status ?? 'active'),
      closing,
      blocked,
      available: closing - blocked,
      min_balance: min,
      breach: closing - blocked < min,
      // số dư liên tục theo sổ cái — không cần nhập tay hằng ngày nên không bao giờ "stale"
      stale: false,
      balance_date: rec ? String(rec.date) : null,
      open_docs: 0,
    };
  });
}

/* ================================================================== *
 * 3. RENEW-01 — maturity ladder 4 mức (§X, DS §3.3)
 * ================================================================== */

export interface MaturityRow {
  loan_id: string;
  contract_code: string;
  company_id: string;
  company_name: string;
  bank_name: string;
  outstanding: WireAmount;
  maturity_date: string;
  days_to_due: number;
  need_prepare: WireAmount;
  level: number;
  tone: string;
  label: string;
  rollover: { document_id: string; code: string; status: string; prepared: boolean } | null;
}

export async function maturityLadder(
  scope: ScopeLike,
  opts: { bucket?: string; bankName?: string; horizonDays?: number } = {},
): Promise<MaturityRow[]> {
  const horizon = opts.horizonDays ?? 90;
  const loans = await Models.Loan.find(
    withScope(scopeOf(scope), {
      status: { $in: ['active', 'overdue'] },
      maturity_date: { $lte: addDays(today(), horizon) },
    }) as never,
  )
    .select({ company_id: 1, bank_name: 1, contract_code: 1, outstanding_minor: 1, maturity_date: 1, next_due_date: 1, currency: 1 })
    .sort({ maturity_date: 1 })
    .lean();

  const companies = await Models.Company.find({ _id: { $in: [...new Set(loans.map((l) => String(l.company_id)))] } })
    .select({ name: 1 })
    .lean();
  const cname = new Map(companies.map((c) => [String(c._id), String(c.name)]));

  const loanIds = loans.map((l) => String(l._id));
  const rollovers = loanIds.length
    ? await Models.Document.find({ loan_id: { $in: loanIds as never }, kind: 'rollover' } as never)
        .select({ loan_id: 1, code: 1, status: 1 })
        .lean()
    : [];
  const byLoan = new Map(rollovers.map((r) => [String(r.loan_id), r]));

  const rows: MaturityRow[] = loans.map((l) => {
    const due = String(l.next_due_date || l.maturity_date || today());
    const days = daysUntil(due);
    const band = maturity(days);
    const outstanding = asBigInt(l.outstanding_minor);
    const ro = byLoan.get(String(l._id));
    return {
      loan_id: String(l._id),
      contract_code: String(l.contract_code),
      company_id: String(l.company_id),
      company_name: cname.get(String(l.company_id)) ?? '—',
      bank_name: String(l.bank_name),
      outstanding: wire(outstanding, String(l.currency ?? 'VND')),
      maturity_date: due,
      days_to_due: days,
      need_prepare: wire(outstanding, String(l.currency ?? 'VND')),
      level: band.level,
      tone: band.tone,
      label: maturityLabel(days),
      rollover: ro
        ? {
            document_id: String(ro._id),
            code: String(ro.code),
            status: String(ro.status),
            prepared: ['approved', 'processing', 'paid'].includes(String(ro.status)),
          }
        : null,
    };
  });

  const byBank = opts.bankName ? rows.filter((r) => r.bank_name.toLowerCase().includes(opts.bankName!.toLowerCase())) : rows;
  if (!opts.bucket) return byBank;
  const range: Record<string, [number, number]> = { today: [-99_999, 0], '3d': [1, 3], '7d': [4, 7], '30d': [8, 30], later: [31, 99_999] };
  const bounds = range[opts.bucket];
  if (!bounds) return byBank;
  return byBank.filter((r) => r.days_to_due >= bounds[0] && r.days_to_due <= bounds[1]);
}

/* ================================================================== *
 * 4. Decision-pack — 7 câu hỏi, server tính 100% (§9.2, §19.5-1)
 * ================================================================== */

/**
 * Số dư tài khoản ngay TRƯỚC và SAU khi phiếu đã thực thi ghi sổ — cộng dồn sổ cái
 * tới đúng bút toán của phiếu (theo `date` rồi `created_at`). Trả `null` nếu phiếu
 * chưa có bút toán (đồng bộ sổ cái best-effort lỗi, chờ reconcile).
 */
async function balanceAroundExecution(accountId: string, docId: string): Promise<{ before: bigint; after: bigint } | null> {
  const entry = await Models.CashEntry.findOne({ account_id: oid(accountId), document_id: oid(docId), mirror_of: null })
    .select({ date: 1, created_at: 1, direction: 1, amount_minor: 1 })
    .lean<{ date?: string; created_at?: Date; direction?: string; amount_minor?: unknown } | null>();
  if (!entry || !entry.date) return null;

  const rows = await Models.CashEntry.aggregate([
    {
      $match: {
        account_id: oid(accountId),
        $or: [
          { date: { $lt: String(entry.date) } },
          { date: String(entry.date), created_at: { $lte: entry.created_at ?? new Date(0) } },
        ],
      },
    },
    {
      $group: {
        _id: null,
        in_minor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount_minor', 0] } },
        out_minor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount_minor', 0] } },
      },
    },
  ] as never[]);
  const agg = (rows as { in_minor?: unknown; out_minor?: unknown }[])[0];
  const after = asBigInt(agg?.in_minor) - asBigInt(agg?.out_minor);
  const signed = (entry.direction === 'in' ? 1n : -1n) * asBigInt(entry.amount_minor);
  return { before: after - signed, after };
}

export async function decisionPack(doc: Record<string, unknown>, canReadTax: boolean): Promise<Record<string, unknown>> {
  const amount = wireOf(doc.amount) ?? wire(0n);
  const minor = asBigInt(amount.minor);
  const evidence = (doc.evidence ?? {}) as { required?: string[]; present?: string[]; missing?: string[] };
  const source = (doc.source ?? {}) as { fund?: string; account_id?: string | null; group_account_id?: string | null; group_managed?: boolean };

  const [account, balances, category, department, budget] = await Promise.all([
    source.account_id
      ? Models.BankAccount.findById(String(source.account_id)).select({ bank_name: 1, account_number: 1, min_balance_minor: 1 }).lean()
      : Promise.resolve(null),
    source.account_id
      ? Models.BalanceDaily.find({ account_id: String(source.account_id) }).sort({ date: -1 }).limit(1).select({ closing_minor: 1, blocked_minor: 1 }).lean()
      : Promise.resolve([]),
    doc.category_id ? Models.Category.findById(String(doc.category_id)).select({ name: 1 }).lean() : Promise.resolve(null),
    doc.department_id ? Models.Department.findById(String(doc.department_id)).select({ name: 1 }).lean() : Promise.resolve(null),
    (doc.budget as { budget_id?: string | null } | undefined)?.budget_id
      ? Models.Budget.findById(String((doc.budget as { budget_id: string }).budget_id)).select({ label: 1, limit_minor: 1, period: 1, period_start: 1 }).lean()
      : Promise.resolve(null),
  ]);

  const available = asBigInt(balances[0]?.closing_minor ?? 0n) - asBigInt(balances[0]?.blocked_minor ?? 0n);
  const minBalance = asBigInt(account?.min_balance_minor ?? 0n);
  // phiếu thu CỘNG tiền, phiếu chi / chuyển nội bộ TRỪ tiền vào tài khoản nguồn
  const isInflow = doc.kind === 'income';
  const delta = isInflow ? minor : -minor;
  // Số dư tại thời điểm TRƯỚC và SAU thực thi: phiếu đã ghi sổ (`paid`) → lấy đúng
  // bút toán trong sổ cái; còn lại → số dư khả dụng hiện tại + dự kiến sau thực thi.
  let balanceBefore = available;
  let after = available + delta;
  if (doc.status === 'paid' && source.account_id) {
    const around = await balanceAroundExecution(String(source.account_id), String(doc._id));
    if (around) {
      balanceBefore = around.before;
      after = around.after;
    } else {
      // chưa có bút toán (đồng bộ sổ cái best-effort lỗi) → suy từ số dư hiện tại
      balanceBefore = available - delta;
      after = available;
    }
  }
  const payee = (doc.payee ?? {}) as { name?: string; tax_code?: string | null; is_internal?: boolean; bank_name?: string | null };
  const contract = (doc.contract ?? {}) as { code?: string | null; value?: unknown };
  const limit = asBigInt(budget?.limit_minor ?? 0n);
  const used = budget ? await budgetUsed(String(budget._id)) : 0n;
  const approval = (doc.approval ?? {}) as { matrix_label?: string | null };

  return {
    document_id: String(doc._id),
    code: String(doc.code ?? ''),
    q1_payee: {
      name: payee.name ?? '—',
      tax_code: canReadTax ? (payee.tax_code ?? null) : null,
      is_internal: Boolean(payee.is_internal),
      bank: payee.bank_name ?? null,
    },
    q2_amount: { amount, amount_usd: null, fx_rate: (doc.fx as { rate?: string } | undefined)?.rate ?? null },
    q3_purpose: {
      text: String(doc.purpose ?? doc.title ?? ''),
      category: category?.name ? String(category.name) : null,
      department: department?.name ? String(department.name) : null,
    },
    q4_basis: {
      contract_code: contract.code ?? null,
      contract_value: wireOf(contract.value),
      invoice: (doc as { debt_code?: string }).debt_code ?? null,
    },
    q5_source: {
      fund: (source.fund as 'bank' | 'cash') ?? 'bank',
      account_label: account ? `${account.bank_name} ${maskAccount(String(account.account_number ?? ''))}` : 'Tiền mặt',
      group_account_label: source.group_account_id ? 'Tài khoản Tập đoàn' : null,
      group_managed: Boolean(source.group_managed),
    },
    q6_impact: {
      balance_before: wire(balanceBefore, amount.currency),
      balance_after: wire(after, amount.currency),
      min_balance: wire(minBalance, amount.currency),
      breach: !isInflow && after < minBalance,
    },
    q7_plan: {
      in_plan: (doc.budget as { in_plan?: boolean } | undefined)?.in_plan !== false,
      budget_line: budget?.label ? String(budget.label) : null,
      used: budget ? wire(used) : null,
      limit: budget ? wire(limit) : null,
      percent: limit > 0n ? Number((used * 10_000n) / limit) / 100 : null,
      period: budget ? `${budget.period} từ ${budget.period_start}` : null,
    },
    evidence: {
      required: evidence.required ?? [],
      present: evidence.present ?? [],
      missing: evidence.missing ?? [],
    },
    matrix_label: approval.matrix_label ?? 'Quy trình mặc định',
  };
}

async function budgetUsed(budgetId: string): Promise<bigint> {
  const rows = await scopedAggregate<{ total: unknown }>(Models.Document, { companyIds: null }, [
    { $match: { 'budget.budget_id': oid(budgetId) as never, kind: 'spend', status: { $ne: 'draft' } } },
    { $group: { _id: null, total: { $sum: '$amount.minor' } } },
  ]);
  return asBigInt(rows[0]?.total ?? 0n);
}

/* ================================================================== *
 * 5. Forecast (§XV) — đọc balances_daily + planned_date của hồ sơ
 * ================================================================== */

export interface ForecastRow {
  date: string;
  weekday: string;
  opening: WireAmount;
  inflow: WireAmount;
  outflow: WireAmount;
  net: WireAmount;
  closing: WireAmount;
  min_balance: WireAmount;
  breach: boolean;
}

export async function forecast(
  scope: ScopeLike,
  opts: { horizon?: number; from?: string } = {},
): Promise<{ rows: ForecastRow[]; totals: Record<string, WireAmount>; first_breach_date: string | null; shortfall_by_company: { company_id: string; company_name: string; date: string; amount: WireAmount }[] }> {
  const horizon = opts.horizon ?? 30;
  const from = opts.from ?? today();
  const to = addDays(from, horizon);

  const [opening, flows, thresholdRows, perCompany] = await Promise.all([
    scopedAggregate<{ _id: string; closing: unknown }>(Models.BalanceDaily, scopeOf(scope), [
      { $match: { date: { $lte: from } } },
      { $sort: { date: -1 } },
      { $group: { _id: '$account_id', closing: { $first: '$closing_minor' } } },
    ]),
    scopedAggregate<{ _id: { date: string; kind: string }; total: unknown }>(Models.Document, scopeOf(scope), [
      { $match: { planned_date: { $gte: dayStartOf(from), $lte: dayEndOf(to) }, status: { $nin: ['draft', 'rejected', 'cancelled'] } } },
      { $group: { _id: { date: { $substr: ['$planned_date', 0, 10] }, kind: '$kind' }, total: { $sum: '$amount.minor' } } },
    ]),
    Models.Company.find(scope.companyIds === null ? {} : { _id: { $in: scope.companyIds as never } }).select({ name: 1, min_balance_minor: 1 }).lean(),
    scopedAggregate<{ _id: string; closing: unknown }>(Models.BalanceDaily, scopeOf(scope), [
      { $match: { date: { $lte: from } } },
      { $sort: { date: -1 } },
      { $group: { _id: '$company_id', closing: { $first: '$closing_minor' } } },
    ]),
  ]);

  const start = opening.reduce((a, o) => a + asBigInt(o.closing), 0n);
  const threshold = thresholdRows.reduce((a, c) => a + asBigInt(c.min_balance_minor), 0n);
  const byDate = new Map<string, { in: bigint; out: bigint }>();
  for (const f of flows) {
    const date = String(f._id.date);
    const cur = byDate.get(date) ?? { in: 0n, out: 0n };
    if (f._id.kind === 'income') cur.in += asBigInt(f.total);
    else cur.out += asBigInt(f.total);
    byDate.set(date, cur);
  }

  const rows: ForecastRow[] = [];
  let running = start;
  let firstBreach: string | null = null;
  for (let i = 0; i <= horizon; i++) {
    const date = addDays(from, i);
    const f = byDate.get(date) ?? { in: 0n, out: 0n };
    const openingDay = running;
    running = openingDay + f.in - f.out;
    const breach = running < threshold;
    if (breach && !firstBreach) firstBreach = date;
    rows.push({
      date,
      weekday: weekdayVi(date),
      opening: wire(openingDay),
      inflow: wire(f.in),
      outflow: wire(f.out),
      net: wire(f.in - f.out),
      closing: wire(running),
      min_balance: wire(threshold),
      breach,
    });
  }

  const totalIn = rows.reduce((a, r) => a + asBigInt(r.inflow.minor), 0n);
  const totalOut = rows.reduce((a, r) => a + asBigInt(r.outflow.minor), 0n);
  const minClosing = rows.reduce((min, r) => (asBigInt(r.closing.minor) < min ? asBigInt(r.closing.minor) : min), running);

  // "Công ty B có khả năng thiếu 5 tỷ ngày 12/09" — bản tin §XIV
  const shortfalls: { company_id: string; company_name: string; date: string; amount: WireAmount }[] = [];
  const cmin = new Map(thresholdRows.map((c) => [String(c._id), asBigInt(c.min_balance_minor)]));
  const cname = new Map(thresholdRows.map((c) => [String(c._id), String(c.name)]));
  for (const p of perCompany) {
    const min = cmin.get(String(p._id)) ?? 0n;
    const closing = asBigInt(p.closing);
    if (closing < min) {
      shortfalls.push({ company_id: String(p._id), company_name: cname.get(String(p._id)) ?? '—', date: from, amount: wire(min - closing) });
    }
  }

  return {
    rows,
    totals: { inflow: wire(totalIn), outflow: wire(totalOut), net: wire(totalIn - totalOut), min_closing: wire(minClosing) },
    first_breach_date: firstBreach,
    shortfall_by_company: shortfalls,
  };
}

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
export function weekdayVi(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? '';
}

/* ================================================================== *
 * 5b. CASH-01 — lịch sử dòng tiền từ sổ cái `cash_entries`
 * (thực thu/chi đã dịch chuyển; scope ép ở đầu mọi query)
 * ================================================================== */

const MONTHS_BACK: Record<CashflowPeriod, number> = { '6m': 6, '1y': 12, '2y': 24 };

export interface CashflowPoint {
  /** `YYYY-MM`. */
  month: string;
  inflow: WireAmount;
  outflow: WireAmount;
  net: WireAmount;
  /** luỹ kế dòng tiền thuần trong kỳ (0 tại tháng đầu). */
  cumulative: WireAmount;
}

export interface CashflowLane {
  key: string;
  label: string;
  sub_label: string | null;
  company_id: string | null;
  account_id: string | null;
  points: CashflowPoint[];
  total_inflow: WireAmount;
  total_outflow: WireAmount;
  total_net: WireAmount;
}

export interface CashflowHistoryResult {
  period: CashflowPeriod;
  group: CashflowGroup;
  from: string;
  to: string;
  months: string[];
  lanes: CashflowLane[];
  totals: { inflow: WireAmount; outflow: WireAmount; net: WireAmount };
  scope_label: string;
}

/** `count` tháng gần nhất (tăng dần) — gồm cả tháng hiện tại. */
function lastMonths(count: number): string[] {
  const [y, m] = today().split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  return out;
}

export async function cashflowHistory(
  scope: ScopeLike,
  opts: { period?: CashflowPeriod; group?: CashflowGroup; from?: string; to?: string } = {},
): Promise<CashflowHistoryResult> {
  const period = opts.period ?? '1y';
  const group = opts.group ?? 'none';
  const months = lastMonths(MONTHS_BACK[period]);
  const from = opts.from ?? `${months[0]}-01`;
  const to = opts.to ?? dayEndOf(today());

  const rows = await scopedAggregate<{
    _id: { month: string; company_id: unknown; account_id: unknown };
    in_minor: unknown;
    out_minor: unknown;
  }>(Models.CashEntry, scopeOf(scope), [
    { $match: { date: { $gte: from, $lte: to } } },
    {
      $group: {
        _id: { month: { $substr: ['$date', 0, 7] }, company_id: '$company_id', account_id: '$account_id' },
        in_minor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount_minor', 0] } },
        out_minor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount_minor', 0] } },
      },
    },
  ]);

  const companyIds = [...new Set(rows.map((r) => String(r._id.company_id)))];
  const accountIds = [...new Set(rows.map((r) => String(r._id.account_id)))];
  const companies = companyIds.length
    ? await Models.Company.find({ _id: { $in: companyIds as never } })
        .select({ name: 1 })
        .lean<{ _id: unknown; name?: string }[]>()
    : [];
  const accounts = accountIds.length
    ? await Models.BankAccount.find({ _id: { $in: accountIds as never } })
        .select({ bank_name: 1, account_number: 1, company_id: 1 })
        .lean<{ _id: unknown; bank_name?: string; account_number?: string; company_id?: unknown }[]>()
    : [];
  const cname = new Map(companies.map((c) => [String(c._id), String(c.name ?? '—')]));
  const amap = new Map(accounts.map((a) => [String(a._id), a]));

  interface LaneAcc {
    key: string;
    label: string;
    sub_label: string | null;
    company_id: string | null;
    account_id: string | null;
    byMonth: Map<string, { in: bigint; out: bigint }>;
  }
  const lanes = new Map<string, LaneAcc>();
  const fresh = (l: LaneAcc): LaneAcc => {
    lanes.set(l.key, l);
    return l;
  };

  for (const r of rows) {
    let lane: LaneAcc;
    if (group === 'none') {
      lane = lanes.get('all') ?? fresh({ key: 'all', label: 'Toàn phạm vi', sub_label: null, company_id: null, account_id: null, byMonth: new Map() });
    } else if (group === 'company') {
      const cid = String(r._id.company_id);
      lane = lanes.get(`c:${cid}`) ?? fresh({ key: `c:${cid}`, label: cname.get(cid) ?? '—', sub_label: null, company_id: cid, account_id: null, byMonth: new Map() });
    } else {
      const aid = String(r._id.account_id);
      const existing = lanes.get(`a:${aid}`);
      if (existing) {
        lane = existing;
      } else {
        const a = amap.get(aid);
        const cid = a?.company_id ? String(a.company_id) : null;
        lane = fresh({
          key: `a:${aid}`,
          label: a ? `${a.bank_name ?? '—'} · ${a.account_number ?? ''}` : '—',
          sub_label: cid ? cname.get(cid) ?? null : null,
          company_id: cid,
          account_id: aid,
          byMonth: new Map(),
        });
      }
    }
    const month = String(r._id.month);
    const cur = lane.byMonth.get(month) ?? { in: 0n, out: 0n };
    cur.in += asBigInt(r.in_minor);
    cur.out += asBigInt(r.out_minor);
    lane.byMonth.set(month, cur);
  }

  const toLane = (l: LaneAcc): CashflowLane => {
    let cumulative = 0n;
    const points = months.map((month) => {
      const v = l.byMonth.get(month) ?? { in: 0n, out: 0n };
      cumulative += v.in - v.out;
      return { month, inflow: wire(v.in), outflow: wire(v.out), net: wire(v.in - v.out), cumulative: wire(cumulative) };
    });
    const totalIn = points.reduce((a, p) => a + asBigInt(p.inflow.minor), 0n);
    const totalOut = points.reduce((a, p) => a + asBigInt(p.outflow.minor), 0n);
    return {
      key: l.key,
      label: l.label,
      sub_label: l.sub_label,
      company_id: l.company_id,
      account_id: l.account_id,
      points,
      total_inflow: wire(totalIn),
      total_outflow: wire(totalOut),
      total_net: wire(totalIn - totalOut),
    };
  };

  const outLanes = [...lanes.values()]
    .map(toLane)
    .sort((a, b) => {
      const av = asBigInt(a.total_inflow.minor) + asBigInt(a.total_outflow.minor);
      const bv = asBigInt(b.total_inflow.minor) + asBigInt(b.total_outflow.minor);
      return av < bv ? 1 : av > bv ? -1 : 0;
    });

  const totalIn = outLanes.reduce((a, l) => a + asBigInt(l.total_inflow.minor), 0n);
  const totalOut = outLanes.reduce((a, l) => a + asBigInt(l.total_outflow.minor), 0n);
  const scope_label =
    scope.companyIds === null
      ? 'Toàn tập đoàn'
      : (await Models.Company.find({ _id: { $in: scope.companyIds as never } })
          .select({ name: 1 })
          .lean<{ name?: string }[]>()).map((c) => String(c.name ?? '—')).join(' · ') || '—';

  return {
    period,
    group,
    from,
    to,
    months,
    lanes: outLanes,
    totals: { inflow: wire(totalIn), outflow: wire(totalOut), net: wire(totalIn - totalOut) },
    scope_label,
  };
}

/* ================================================================== *
 * 6. DASH-01 — overview: MỘT endpoint gộp, Promise.all, ETag ở route (§8.3)
 * ================================================================== */

export async function dashboardOverview(scope: ScopeLike, userId: string, role?: Role, canPay = false): Promise<Record<string, unknown>> {
  const scopeKey = scope.companyIds === null ? 'all' : scope.companyIds.join(',');
  return cacheThrough(
    `overview:${userId}:${role ?? ''}:${scopeKey}:${today()}:${canPay ? 'pay' : ''}`,
    () => buildOverview(scope, userId, role, canPay),
    20_000,
  );
}

async function buildOverview(scope: ScopeLike, userId: string, role?: Role, canPay = false): Promise<Record<string, unknown>> {
  const day = today();
  const [accounts, awaiting, queue, income, spend, overdue, maturities, missing, unread] = await Promise.all([
    accountSnapshots(scope),
    awaitingBadge(scope, userId, role, canPay),
    queryQueue({ scope, userId, role, canPay, mine: 'to_approve', limit: 8, sort: '-waiting' }),
    sumByDateAndKind(scope, 'income', day),
    sumByDateAndKind(scope, 'spend', day),
    overdueReceivable(scope),
    maturityLadder(scope, { horizonDays: 30 }),
    scopedCount(Models.Document, scopeOf(scope), {
      'evidence.missing.0': { $exists: true },
      status: { $in: [...OPEN_STATUSES] },
    }),
    Models.Notification.countDocuments({ user_id: userId, read_at: null }).exec(),
  ]);

  const cashAvailable = accounts.reduce((a, x) => a + x.available, 0n);
  const blocked = accounts.reduce((a, x) => a + x.blocked, 0n);
  const cashOnHand = accounts.filter((a) => a.kind === 'cash').reduce((a, x) => a + x.available, 0n);
  const bankMoney = cashAvailable - cashOnHand;
  const debt = await sumOutstanding(scope);
  const matToday = maturities.filter((m) => m.days_to_due <= 0).reduce((a, m) => a + asBigInt(m.outstanding.minor), 0n);
  const mat3 = maturities.filter((m) => m.days_to_due <= 3).reduce((a, m) => a + asBigInt(m.outstanding.minor), 0n);
  const mat7 = maturities.filter((m) => m.days_to_due <= 7).reduce((a, m) => a + asBigInt(m.outstanding.minor), 0n);
  const mat30 = maturities.reduce((a, m) => a + asBigInt(m.outstanding.minor), 0n);
  const awaitingTotal = awaiting.total_minor;

  const exceptions = buildExceptions({
    awaitingCount: awaiting.count,
    awaitingTotal,
    matToday,
    mat7,
    mat7Count: maturities.filter((m) => m.days_to_due <= 7).length,
    overdueCount: overdue.count,
    overdueTotal: overdue.total,
    missing,
    breachAccounts: accounts.filter((a) => a.breach).slice(0, 3),
  });

  const byBankAgg = new Map<string, bigint>();
  const loanRows = await Models.Loan.find(withScope(scopeOf(scope), { status: { $in: ['active', 'overdue'] } }) as never)
    .select({ bank_name: 1, outstanding_minor: 1 })
    .lean();
  for (const l of loanRows) byBankAgg.set(String(l.bank_name), (byBankAgg.get(String(l.bank_name)) ?? 0n) + asBigInt(l.outstanding_minor));

  return {
    scope: {
      all: scope.companyIds === null,
      company_ids: scope.companyIds ?? [],
      company_names: await namesForScope(scope),
    },
    business_date: day,
    generated_at: new Date().toISOString(),
    stale: false,
    partial_companies: [...new Set(accounts.filter((a) => a.stale).map((a) => ({ company_id: a.company_id, name: a.company_name, last_balance_date: a.balance_date })))],
    kpi: {
      cash_total: {
        label: 'Tổng tiền hiện có',
        amount: wire(cashAvailable),
        compact: formatMoney(money(cashAvailable), { mode: 'kpi' }),
        breakdown: [
          { label: 'Tiền mặt', amount: wire(cashOnHand), compact: compact(cashOnHand) },
          { label: 'Tiền ngân hàng', amount: wire(bankMoney), compact: compact(bankMoney) },
          { label: 'Bị hạn chế', amount: wire(blocked), compact: compact(blocked) },
        ],
        delta_percent: null,
        as_of: new Date().toISOString(),
      },
      income_today: {
        label: 'Dự kiến thu hôm nay',
        amount: wire(income),
        compact: formatMoney(money(income), { mode: 'kpi' }),
        breakdown: [],
        delta_percent: null,
        as_of: new Date().toISOString(),
      },
      spend_today: {
        label: 'Cần chi hôm nay',
        amount: wire(spend),
        compact: formatMoney(money(spend), { mode: 'kpi' }),
        breakdown: [],
        delta_percent: null,
        as_of: new Date().toISOString(),
      },
      awaiting_me: {
        label: 'Chờ tôi duyệt',
        amount: wire(awaitingTotal),
        compact: formatMoney(money(awaitingTotal), { mode: 'kpi' }),
        breakdown: [{ label: `${awaiting.count} khoản`, amount: wire(awaitingTotal), compact: compact(awaitingTotal) }],
        delta_percent: null,
        as_of: new Date().toISOString(),
      },
    },
    bank: {
      debt_total: wire(debt),
      maturity_today: wire(matToday),
      maturity_3d: wire(mat3),
      maturity_7d: wire(mat7),
      maturity_30d: wire(mat30),
      by_bank: [...byBankAgg.entries()]
        .sort((a, b) => Number(b[1] - a[1]))
        .map(([bank_name, outstanding]) => ({
          bank_name,
          outstanding: wire(outstanding),
          share_percent: debt > 0n ? Number((outstanding * 10_000n) / debt) / 100 : 0,
        })),
    },
    exceptions: exceptions.slice(0, 6),
    awaiting_me_rows: queue.items.map((r) => ({
      document_id: r._id,
      code: r.code,
      kind: r.kind,
      company_name: r.company_name,
      title: r.title,
      amount: r.amount,
      compact: r.compact,
      created_by_name: r.created_by_name,
      status: r.status,
      waiting_days: r.waiting_days,
      next_role_label: r.current_owner,
      overdue: r.overdue,
      href: r.href,
    })),
    forecast: null,
    receivable_overdue: wire(overdue.total),
    payable_due: wire(await sumPayableDue(scope)),
    counts: {
      awaiting_me: awaiting.count,
      overdue_receivable: overdue.count,
      maturity_7d_count: maturities.filter((m) => m.days_to_due <= 7).length,
      missing_evidence: missing,
      notifications_unread: unread,
    },
  };
}

function buildExceptions(input: {
  awaitingCount: number;
  awaitingTotal: bigint;
  matToday: bigint;
  mat7: bigint;
  mat7Count: number;
  overdueCount: number;
  overdueTotal: bigint;
  missing: number;
  breachAccounts: AccountSnapshot[];
}): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  if (input.matToday > 0n) {
    items.push({ id: 'mat-today', severity: 3, tone: 'danger', glyph: '⛔', text: 'Đáo hạn hôm nay', amount: wire(input.matToday), compact: compact(input.matToday), href: '/ngan-hang/dao-han', cta: 'Xem' });
  }
  for (const a of input.breachAccounts) {
    items.push({
      id: `breach-${a.account_id}`,
      severity: 3,
      tone: 'danger',
      glyph: '⛔',
      text: `${a.label} dưới ngưỡng tối thiểu`,
      amount: wire(a.available),
      compact: compact(a.available),
      href: `/ngan-hang/taikhoan/${a.account_id}`,
      cta: 'Xem',
    });
  }
  if (input.awaitingCount > 0) {
    items.push({
      id: 'awaiting',
      severity: 2,
      tone: 'warning',
      glyph: '⚠',
      text: `${input.awaitingCount} khoản đang chờ bạn duyệt`,
      amount: wire(input.awaitingTotal),
      compact: compact(input.awaitingTotal),
      href: '/cho-toi-duyet',
      cta: 'Duyệt',
    });
  }
  if (input.mat7Count > 0) {
    items.push({
      id: 'mat-7',
      severity: 2,
      tone: 'warning',
      glyph: '⚠',
      text: `${input.mat7Count} khoản đáo hạn trong 7 ngày tới`,
      amount: wire(input.mat7),
      compact: compact(input.mat7),
      href: '/ngan-hang/dao-han',
      cta: 'Xem',
    });
  }
  if (input.overdueCount > 0) {
    items.push({
      id: 'receivable',
      severity: 1,
      tone: 'info',
      glyph: '●',
      text: `${input.overdueCount} khoản phải thu quá hạn`,
      amount: wire(input.overdueTotal),
      compact: compact(input.overdueTotal),
      href: '/thu/qua-han',
      cta: 'Đôn đốc',
    });
  }
  if (input.missing > 0) {
    items.push({ id: 'evidence', severity: 1, tone: 'attention', glyph: '▲', text: `${input.missing} hồ sơ thiếu chứng từ`, amount: null, compact: null, href: '/can-xu-ly', cta: 'Bổ sung' });
  }
  return items.sort((a, b) => Number(b.severity) - Number(a.severity));
}

async function sumByDateAndKind(scope: ScopeLike, kind: DocKind, date: string): Promise<bigint> {
  const rows = await scopedAggregate<{ total: unknown }>(Models.Document, scopeOf(scope), [
    { $match: { kind, planned_date: { $gte: dayStartOf(date), $lte: dayEndOf(date) }, status: { $ne: 'draft' } } },
    { $group: { _id: null, total: { $sum: '$amount.minor' } } },
  ]);
  return asBigInt(rows[0]?.total ?? 0n);
}

async function overdueReceivable(scope: ScopeLike): Promise<{ count: number; total: bigint }> {
  const f = withScope(scopeOf(scope), { kind: 'receivable', status: { $ne: 'settled' }, due_date: { $lt: today() } });
  const [count, rows] = await Promise.all([
    Models.DebtItem.countDocuments(f as never),
    Models.DebtItem.find(f as never).select({ value_minor: 1, settled_minor: 1 }).limit(500).lean(),
  ]);
  const total = (rows as { value_minor?: unknown; settled_minor?: unknown }[]).reduce(
    (a, r) => a + asBigInt(r.value_minor ?? 0n) - asBigInt(r.settled_minor ?? 0n),
    0n,
  );
  return { count, total };
}

async function sumOutstanding(scope: ScopeLike): Promise<bigint> {
  const rows = await scopedAggregate<{ total: unknown }>(Models.Loan, scopeOf(scope), [
    { $match: { status: { $in: ['active', 'overdue'] } } },
    { $group: { _id: null, total: { $sum: '$outstanding_minor' } } },
  ]);
  return asBigInt(rows[0]?.total ?? 0n);
}

async function sumPayableDue(scope: ScopeLike): Promise<bigint> {
  const rows = await scopedAggregate<{ total: unknown }>(Models.DebtItem, scopeOf(scope), [
    { $match: { kind: 'payable', status: { $ne: 'settled' }, due_date: { $lte: addDays(today(), 7) } } },
    { $project: { remaining: { $subtract: ['$value_minor', '$settled_minor'] } } },
    { $group: { _id: null, total: { $sum: '$remaining' } } },
  ]);
  return asBigInt(rows[0]?.total ?? 0n);
}

async function namesForScope(scope: ScopeLike): Promise<string[]> {
  if (scope.companyIds === null) {
    const all = await Models.Company.find({ status: 'active' }).select({ name: 1 }).lean();
    return ['Tất cả công ty', ...all.map((c) => String(c.name))];
  }
  const cs = await Models.Company.find({ _id: { $in: scope.companyIds as never } }).select({ name: 1 }).lean();
  return cs.map((c) => String(c.name));
}

export { wire as toWire };

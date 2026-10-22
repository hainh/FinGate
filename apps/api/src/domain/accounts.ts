/**
 * Kiểm tra tài khoản tiền hợp lệ cho phiếu — dùng chung giữa route tạo/sửa hồ sơ
 * và workflow duyệt (cấp duyệt được đổi tài khoản trong phạm vi công ty — §VIII).
 */

import { ApiError, addDays, today } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { oid } from '../lib/mongo.ts';
import { loadPipelineDocs, plannedFlowsByAccount, plannedFlowsOf } from './ledger/planned.ts';
import { bankAccountLabelOf, maskAccount } from './queries/index.ts';

/**
 * Số dư tài khoản (v2 §4.2) — CHỈ từ sổ cái + phiếu chờ thực thi:
 *   · `actual`    = Σ bút toán sổ cái (vào − ra) đến `asOf` (mặc định hôm nay);
 *   · `projected` = `actual` + phiếu đã duyệt/đã gửi duyệt chưa thực thi, theo ngày dự kiến, đến `asOf + horizonDays`.
 * KHÔNG còn "tiền bị phong toả" / "số dư khả dụng" (v2 BỎ). Trường `blocked_minor` cũ trong
 * `balances_daily` chỉ đọc-chịu-được, không dùng để tính.
 */
export interface LedgerAccountView {
  account_id: string;
  company_id: string;
  company_name: string;
  company_code: string;
  label: string;
  bank_name: string;
  /** tên tài khoản (để phân biệt các TK cùng ngân hàng trong ô chọn). */
  account_name: string;
  account_number_masked: string;
  kind: string;
  currency: string;
  is_group: boolean;
  status: string;
  actual: bigint;
  planned_in: bigint;
  planned_out: bigint;
  projected: bigint;
  min_balance: bigint;
  /** thực tế < số dư tối thiểu. */
  breach: boolean;
  /** dự kiến (cuối kỳ dự báo) < số dư tối thiểu. */
  breach_projected: boolean;
  /** ngày bút toán gần nhất trong sổ cái (YYYY-MM-DD) — null nếu chưa có. */
  balance_date: string | null;
}

export interface LedgerAccountOptions {
  includeClosed?: boolean;
  /** công ty con vẫn thấy tài khoản Tập đoàn (màn BANK-01). */
  includeGroup?: boolean;
  /** công ty của phiếu (picker nguồn tiền) — §VIII. */
  forCompany?: { id: string; isGroup: boolean };
  asOf?: string;
  horizonDays?: number;
}

/** Hàm thuần: ghép số dư sổ cái + dòng dự kiến thành số dư và cờ vi phạm. */
export function composeAccountBalance(input: {
  actual: bigint;
  planned_in: bigint;
  planned_out: bigint;
  min_balance: bigint;
}): { projected: bigint; breach: boolean; breach_projected: boolean } {
  const projected = input.actual + input.planned_in - input.planned_out;
  return {
    projected,
    breach: input.actual < input.min_balance,
    breach_projected: projected < input.min_balance,
  };
}

export async function ledgerAccountViews(
  scope: { companyIds: string[] | null },
  opts: LedgerAccountOptions = {},
): Promise<LedgerAccountView[]> {
  const asOf = opts.asOf ?? today();
  const horizonEnd = addDays(asOf, opts.horizonDays ?? 30);
  const base = opts.includeClosed ? {} : { status: { $ne: 'closed' } };
  const filter: Record<string, unknown> = opts.forCompany
    ? opts.forCompany.isGroup
      ? { ...base, is_group: true }
      : { ...base, company_id: opts.forCompany.id }
    : scope.companyIds === null
      ? base
      : opts.includeGroup
        ? { ...base, $or: [{ company_id: { $in: scope.companyIds } }, { is_group: true }] }
        : { ...base, company_id: { $in: scope.companyIds } };
  const accounts = await Models.BankAccount.find(filter as never)
    .select({ company_id: 1, bank_name: 1, account_name: 1, account_number: 1, kind: 1, currency: 1, min_balance_minor: 1, is_group: 1, status: 1 })
    .lean();
  if (!accounts.length) return [];

  const ids = accounts.map((a) => String(a._id));
  const idSet = new Set(ids);
  const oidIds = ids.map((i) => oid(i));
  // mongoose aggregate KHÔNG cast string → ObjectId: tự cast (oid)
  const [ledgerRows, pipelineDocs] = await Promise.all([
    Models.CashEntry.aggregate([
      { $match: { account_id: { $in: oidIds }, date: { $lte: asOf } } },
      {
        $group: {
          _id: '$account_id',
          in_minor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, '$amount_minor', 0] } },
          out_minor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amount_minor', 0] } },
          last_date: { $max: '$date' },
        },
      },
    ] as never[]),
    loadPipelineDocs(
      {
        $or: [
          { 'source.account_id': { $in: ids } },
          { 'source.group_account_id': { $in: ids } },
          { 'target.account_id': { $in: ids } },
          { 'transfer_target.account_id': { $in: ids } },
        ],
      },
      horizonEnd,
    ),
  ]);
  const ledger = ledgerRows as unknown as { _id: unknown; in_minor: unknown; out_minor: unknown; last_date: unknown }[];
  const planned = pipelineDocs.flatMap((d) => plannedFlowsOf(d, asOf));

  const ledgerBy = new Map(ledger.map((l) => [String(l._id), l]));
  const plannedBy = plannedFlowsByAccount(planned, idSet);

  const companyIds = [...new Set(accounts.map((a) => (a.company_id ? String(a.company_id) : '')))].filter(Boolean);
  const companies = await Models.Company.find({ _id: { $in: companyIds as never } }).select({ name: 1, code: 1 }).lean();
  const cname = new Map(companies.map((c) => [String(c._id), String(c.name)]));
  const ccode = new Map(companies.map((c) => [String(c._id), String(c.code ?? '')]));
  const groupCompany = await Models.Company.findOne({ is_group: true }).select({ code: 1 }).lean<{ code?: string } | null>();
  const groupCode = String(groupCompany?.code ?? 'GROUP');

  return accounts.map((a) => {
    const id = String(a._id);
    const l = ledgerBy.get(id);
    const actual = big(l?.in_minor) - big(l?.out_minor);
    const p = plannedBy.get(id) ?? { in: 0n, out: 0n };
    const min = big(a.min_balance_minor ?? 0n);
    const companyId = String(a.company_id ?? '');
    const composed = composeAccountBalance({ actual, planned_in: p.in, planned_out: p.out, min_balance: min });
    const masked = maskAccount(String(a.account_number ?? ''));
    return {
      account_id: id,
      company_id: companyId,
      company_name: cname.get(companyId) ?? (a.is_group ? 'Tập đoàn' : '—'),
      company_code: a.is_group ? groupCode : (ccode.get(companyId) ?? ''),
      label: bankAccountLabelOf({ bank_name: a.bank_name, account_number: a.account_number, account_name: a.account_name }),
      bank_name: String(a.bank_name ?? ''),
      account_name: String(a.account_name ?? ''),
      account_number_masked: masked,
      kind: String(a.kind ?? 'bank'),
      currency: String(a.currency ?? 'VND'),
      is_group: Boolean(a.is_group),
      status: String(a.status ?? 'active'),
      actual,
      planned_in: p.in,
      planned_out: p.out,
      projected: composed.projected,
      min_balance: min,
      breach: composed.breach,
      breach_projected: composed.breach_projected,
      balance_date: l?.last_date ? String(l.last_date) : null,
    };
  });
}

/** Ép kiểu an toàn BigInt từ kết quả Mongo (lean/aggregate). */
function big(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  const s = String(v ?? '0');
  return /^-?\d+$/.test(s) ? BigInt(s) : 0n;
}

/** Id pháp nhân cấp Tập đoàn (`companies.is_group = true`) — null nếu chưa có. */
async function groupCompanyId(): Promise<string | null> {
  const c = await Models.Company.findOne({ is_group: true } as never).select({ _id: 1 }).lean();
  return c ? String((c as { _id: unknown })._id) : null;
}

/**
 * Tài khoản nguồn/đích chỉ được chọn từ tài khoản của **công ty của phiếu**.
 * Tài khoản Tập đoàn (`company_id` null, `is_group`) — gồm Quỹ tiền mặt Tập đoàn —
 * CHỈ dùng cho phiếu thuộc pháp nhân Tập đoàn; phiếu của công ty con không được
 * động vào quỹ/tài khoản Tập đoàn (sửa lỗi: công ty con từng chọn được nguồn này).
 * Chặn ở server, không tin UI (§VIII).
 * Lỗi trả về key theo `field` để UI hiển thị inline đúng field.
 */
export async function assertAccountAllowedForCompany(
  companyId: string,
  accountId: string | null | undefined,
  field = 'source.account_id',
): Promise<void> {
  if (!accountId) return;
  const acct = await Models.BankAccount.findOne({ _id: accountId })
    .select({ company_id: 1, is_group: 1, status: 1 })
    .lean();
  if (!acct || acct.status !== 'active') {
    throw new ApiError({
      code: 'FG-VAL-001',
      errors: { [field]: 'Tài khoản không tồn tại hoặc đã đóng/phong tỏa' },
    });
  }
  const owner = acct.company_id ? String(acct.company_id) : null;
  if (owner === companyId) return;
  if (acct.is_group) {
    const gid = await groupCompanyId();
    if (gid && companyId === gid) return;
    throw new ApiError({
      code: 'FG-RBAC-002',
      detail: 'Không dùng được quỹ/tài khoản Tập đoàn cho phiếu của công ty con',
      errors: { [field]: 'Tài khoản Tập đoàn — chỉ dùng cho phiếu cấp Tập đoàn' },
    });
  }
  throw new ApiError({
    code: 'FG-RBAC-002',
    detail: 'Tài khoản không thuộc công ty của phiếu',
    errors: { [field]: 'Tài khoản không thuộc công ty của phiếu' },
  });
}

/**
 * Trường "Tài khoản tập đoàn phụ trách" (§VIII, áp dụng khi `group_managed`):
 * chỉ nhận tài khoản Tập đoàn, và chỉ với phiếu thuộc pháp nhân Tập đoàn —
 * phiếu công ty con không được đi qua quỹ Tập đoàn kể cả qua trường này.
 */
export async function assertGroupAccountForCompany(
  companyId: string,
  accountId: string | null | undefined,
): Promise<void> {
  if (!accountId) return;
  const acct = await Models.BankAccount.findOne({ _id: accountId }).select({ is_group: 1 }).lean();
  if (!acct || !acct.is_group) {
    throw new ApiError({
      code: 'FG-VAL-001',
      errors: { 'source.group_account_id': 'Chỉ chọn được tài khoản Tập đoàn cho trường này' },
    });
  }
  await assertAccountAllowedForCompany(companyId, accountId, 'source.group_account_id');
}

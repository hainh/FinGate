/**
 * Mượn tiền từ tài khoản khác CÙNG CÔNG TY trên phiếu chi (`options.account_borrow`, quy tắc R8).
 *
 * Phiếu chi từ tài khoản A cho đối tác X có thể đánh dấu "mượn tiền từ tài khoản B". Khi phiếu được duyệt và THỰC THI,
 * R8 tự sinh hai phiếu đã duyệt và thực thi ngay: phiếu chi B → A và phiếu thu vào A từ B (tổng cộng 3 phiếu).
 * File này là phần kiểm khi lưu / thực thi và dạng đọc; các bước tự động nằm ở `automation/rules/r8-account-borrow.ts`.
 */

import { ApiError } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { assertAccountAllowedForCompany } from '../accounts.ts';
import { bankAccountLabelOf } from '../queries/index.ts';

export const ACCOUNT_BORROW_FIELD = 'options.account_borrow.account_id';

export interface AccountBorrowPlan {
  account_id: string;
  /** null = toàn bộ số tiền thực chi của phiếu. */
  amount_minor: bigint | null;
}

export interface AccountBorrowInput {
  account_id: string;
  amount_minor?: string | null;
}

/** Dạng đọc: tài khoản cho mượn (nhãn) và số tiền hiệu lực. */
export interface AccountBorrowView {
  account_id: string;
  account_label: string | null;
  amount_minor: string | null;
  effective_amount_minor: string;
}

const toBigOrNull = (v: unknown): bigint | null => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'bigint') return v;
  const s = String(v).trim();
  return /^\d+$/.test(s) ? BigInt(s) : null;
};

export function storedAccountBorrowToPlan(stored: Record<string, unknown> | null | undefined): AccountBorrowPlan | null {
  if (!stored?.account_id) return null;
  return { account_id: String(stored.account_id), amount_minor: toBigOrNull(stored.amount_minor) };
}

export function planToStoredAccountBorrow(plan: AccountBorrowPlan | null): Record<string, unknown> | null {
  return plan ? { account_id: plan.account_id, amount_minor: plan.amount_minor } : null;
}

export function planToAccountBorrowInput(plan: AccountBorrowPlan): AccountBorrowInput {
  return { account_id: plan.account_id, amount_minor: plan.amount_minor === null ? null : plan.amount_minor.toString() };
}

/** Số tiền mượn hiệu lực: đã ghi (không vượt số chi) hoặc toàn bộ số chi. */
export function effectiveBorrowAmount(plan: AccountBorrowPlan, spendMinor: bigint): bigint {
  if (plan.amount_minor === null || plan.amount_minor > spendMinor) return spendMinor;
  return plan.amount_minor;
}

const fail = (field: string, message: string): never => {
  throw new ApiError({ code: 'FG-VAL-001', detail: message, errors: { [field]: message } });
};

/**
 * Kiểm lựa chọn mượn tiền khi lưu phiếu: chỉ phiếu chi, tài khoản cho mượn cùng công ty, đang hoạt động, khác tài
 * khoản chi; số tiền mượn > 0 và không vượt số tiền phiếu; không dùng cùng "Vay ngân hàng để chi" (R3).
 */
export async function resolveAccountBorrow(input: {
  companyId: string;
  voucherKind: string;
  voucherAmountMinor: bigint;
  sourceAccountId: string | null;
  loanKind: string | null;
  borrow: AccountBorrowInput | null;
}): Promise<AccountBorrowPlan | null> {
  const b = input.borrow;
  if (!b) return null;
  if (input.voucherKind !== 'spend') fail(ACCOUNT_BORROW_FIELD, 'Chỉ phiếu chi mới mượn tiền từ tài khoản khác');
  if (input.loanKind === 'fund') fail(ACCOUNT_BORROW_FIELD, 'Không dùng cùng lúc với "Vay ngân hàng để chi"');
  const accountId = String(b.account_id ?? '');
  if (!/^[0-9a-f]{24}$/i.test(accountId)) fail(ACCOUNT_BORROW_FIELD, 'Chọn tài khoản cho mượn');
  if (input.sourceAccountId && accountId === input.sourceAccountId) fail(ACCOUNT_BORROW_FIELD, 'Tài khoản cho mượn phải khác tài khoản chi');
  await assertAccountAllowedForCompany(input.companyId, accountId, ACCOUNT_BORROW_FIELD);
  const acct = await Models.BankAccount.findById(accountId).select({ company_id: 1, is_group: 1 }).lean<{ company_id?: unknown; is_group?: boolean } | null>();
  if (!acct || String(acct.company_id ?? '') !== input.companyId) fail(ACCOUNT_BORROW_FIELD, 'Tài khoản cho mượn phải thuộc cùng công ty với phiếu');
  const amount = toBigOrNull(b.amount_minor);
  if (amount !== null) {
    if (amount <= 0n) fail('options.account_borrow.amount_minor', 'Số tiền mượn phải lớn hơn 0');
    if (amount > input.voucherAmountMinor) fail('options.account_borrow.amount_minor', 'Số tiền mượn không được vượt số tiền phiếu chi');
  }
  return { account_id: accountId, amount_minor: amount };
}

/**
 * Trước khi thực thi phiếu chi có mượn tiền: tài khoản cho mượn còn hoạt động, cùng công ty và khác tài khoản thực chi.
 * R8 chỉ chạy SAU thực thi — lỗi lúc đó để phiếu chi đã ra tiền mà không có tiền mượn về.
 */
export async function assertAccountBorrowLive(doc: { company_id: unknown; options?: { account_borrow?: unknown } | null }, paidAccountId: string | null): Promise<void> {
  const plan = storedAccountBorrowToPlan((doc.options?.account_borrow ?? null) as Record<string, unknown> | null);
  if (!plan) return;
  if (paidAccountId && paidAccountId === plan.account_id) fail(ACCOUNT_BORROW_FIELD, 'Tài khoản thực chi trùng tài khoản cho mượn — chọn tài khoản chi khác');
  const acct = await Models.BankAccount.findById(plan.account_id).select({ company_id: 1, status: 1 }).lean<{ company_id?: unknown; status?: string } | null>();
  if (!acct || acct.status !== 'active' || String(acct.company_id ?? '') !== String(doc.company_id)) {
    fail(ACCOUNT_BORROW_FIELD, 'Tài khoản cho mượn không thuộc công ty hoặc đã đóng');
  }
}

/** Dạng đọc của lựa chọn mượn tiền (nạp sống nhãn tài khoản theo ID, trong công ty của phiếu). */
export async function accountBorrowViewOf(stored: Record<string, unknown> | null | undefined, companyId: string, spendMinor: bigint): Promise<AccountBorrowView | null> {
  const plan = storedAccountBorrowToPlan(stored);
  if (!plan) return null;
  const acct = /^[0-9a-f]{24}$/i.test(plan.account_id)
    ? await Models.BankAccount.findOne({ _id: plan.account_id, company_id: companyId } as never)
        .select({ bank_name: 1, account_number: 1, account_name: 1 })
        .lean<{ bank_name?: string; account_number?: string; account_name?: string } | null>()
    : null;
  return {
    account_id: plan.account_id,
    account_label: acct ? bankAccountLabelOf(acct) : null,
    amount_minor: plan.amount_minor === null ? null : plan.amount_minor.toString(),
    effective_amount_minor: effectiveBorrowAmount(plan, spendMinor).toString(),
  };
}

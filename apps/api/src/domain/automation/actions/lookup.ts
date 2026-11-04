/**
 * Đọc dữ liệu tham chiếu cho các quy tắc (đối tác, công ty, tài khoản, phiếu nguồn) — chỉ đọc.
 * Mọi tham chiếu là ID (v2 §14.3 (0)): không tra theo tên / số tài khoản.
 */

import { isCashLikeAccountKind, type FundKind } from '@fingate/shared';
import { Models } from '../../../db/models.ts';
import type { HistoryLike } from '../policy.ts';

export interface PartnerView {
  id: string;
  company_id: string;
  name: string;
  type: 'bank' | 'customer' | 'supplier';
  status: string;
}

/** Đối tác theo ID (null nếu không có / không cùng công ty không kiểm ở đây — người gọi kiểm). */
export async function partnerView(id: unknown): Promise<PartnerView | null> {
  if (!id) return null;
  const p = await Models.Partner.findById(String(id))
    .select({ company_id: 1, name: 1, type: 1, status: 1 })
    .lean<{ _id: unknown; company_id: unknown; name: string; type: PartnerView['type']; status: string } | null>();
  if (!p) return null;
  return { id: String(p._id), company_id: String(p.company_id), name: p.name, type: p.type, status: p.status };
}

/** Ngân hàng cho vay: đối tác loại `bank` bắt buộc; sai ⇒ lỗi (bước thất bại, KTT xử lý). */
export async function bankPartnerOrThrow(id: unknown, what: string): Promise<PartnerView> {
  const p = await partnerView(id);
  if (!p) throw new Error(`${what}: chưa chọn đối tác`);
  if (p.type !== 'bank') throw new Error(`${what}: đối tác "${p.name}" không phải ngân hàng`);
  return p;
}

/** Công ty (tên + mã) — dùng cho nội dung và nhãn nguồn. */
export async function companyView(id: unknown): Promise<{ id: string; name: string; code: string } | null> {
  if (!id) return null;
  const c = await Models.Company.findById(String(id)).select({ name: 1, code: 1 }).lean<{ _id: unknown; name?: string; code?: string } | null>();
  if (!c) return null;
  return { id: String(c._id), name: String(c.name ?? ''), code: String(c.code ?? '') };
}

/**
 * Loại tài khoản tiền của tài khoản nguồn/đích — để ghi `source.fund` của phiếu tự động.
 * Quỹ phụ (`fund`) chứa tiền thật, hoạt động GIỐNG quỹ tiền mặt (`cash`), KHÔNG phải ngân hàng:
 * `cashLike` dùng cho các luật gộp nhóm quỹ (vd "Chờ tôi duyệt" của phiếu quỹ tiền mặt).
 * `raw` = loại gốc trong bảng `bank_accounts` (null nếu không đọc được tài khoản).
 */
export interface AccountKindView {
  /** loại ghi lên `source.fund` của phiếu. */
  fund: FundKind;
  /** loại gốc của tài khoản (`bank` | `cash` | `fund`). */
  raw: string | null;
  /** tài khoản thuộc nhóm tiền mặt / quỹ (`cash` + `fund`). */
  cashLike: boolean;
}

/** Quỹ của tài khoản đích/nguồn theo loại tài khoản; thiếu tài khoản ⇒ `bank` (như trước). */
export async function accountKindOf(accountId: unknown): Promise<AccountKindView> {
  if (!accountId) return { fund: 'bank', raw: null, cashLike: false };
  const a = await Models.BankAccount.findById(String(accountId)).select({ kind: 1 }).lean<{ kind?: string } | null>();
  const raw = a?.kind ?? null;
  const fund: FundKind = raw === 'cash' || raw === 'fund' ? raw : 'bank';
  return { fund, raw, cashLike: isCashLikeAccountKind(raw) };
}

/** Quỹ của tài khoản đích/nguồn (`bank` | `cash` | `fund`), theo loại tài khoản. */
export async function fundOfAccount(accountId: unknown): Promise<FundKind> {
  return (await accountKindOf(accountId)).fund;
}

/** Phiếu (thu / chi / …) ở dạng đọc được cho bước tự động. */
export interface VoucherRow {
  _id: unknown;
  code: string;
  kind: 'spend' | 'income' | 'rollover' | 'internal';
  company_id: unknown;
  created_by?: unknown;
  status: string;
  version: number;
  title: string;
  purpose?: string | null;
  partner_id?: unknown;
  amount: { minor: unknown; currency?: string | null; decimals?: number | null };
  source?: { fund?: string | null; account_id?: unknown } | null;
  planned_date: string;
  business_date: string;
  options?: {
    loan?: {
      kind?: string | null;
      mode?: string | null;
      lender_partner_id?: unknown;
      receive_account_id?: unknown;
      amount_minor?: unknown;
      existing_loan_id?: unknown;
      terms?: { due_date?: string | null; term_months?: number | null; interest_rate?: string | null; repayment_period?: string | null; repayment_method?: string | null; contract_no?: string | null; collateral?: string | null } | null;
    } | null;
    /** cấn trừ khoản vay (R7): khoản nợ ngân hàng hoặc công nợ phải trả. */
    offset?: {
      target?: string | null;
      target_id?: unknown;
      amount_minor?: unknown;
      interest_minor?: unknown;
      fee_minor?: unknown;
    } | null;
  } | null;
  transfer_target?: { company_id?: unknown; account_id?: unknown } | null;
  approval?: { steps?: StepLike[] | null } | null;
  execution?: { paid_at?: string | null; actual_amount_minor?: unknown } | null;
  history?: (HistoryLike & { actor?: { user_id?: unknown } | null })[] | null;
  origin?: { kind?: string | null; run_id?: unknown; rule_code?: string | null } | null;
}

/** Dòng bước duyệt đọc từ DB (chỉ các trường cần để kế thừa). */
export interface StepLike {
  order: number;
  role: string;
  user_id?: unknown;
  delegated_from?: unknown;
  state: string;
  decided_at?: Date | null;
  opinion?: string | null;
  reason?: string | null;
  fast_tracked?: boolean | null;
}

/** Đọc phiếu theo ID (null nếu không có). */
export async function loadVoucher(id: string | null): Promise<VoucherRow | null> {
  if (!id) return null;
  return Models.Document.findById(id).lean<VoucherRow | null>();
}

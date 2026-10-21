/**
 * Quy tắc VÒNG ĐỜI phiếu thu/chi (v2/v2.md §6.2, §6.3, §8, US-VOU-02, US-VOU-05, US-VOU-06) — hàm THUẦN, không DB.
 *
 * Route (`routes/documents.ts`) và bộ máy duyệt (`domain/workflow`) gọi vào đây để quy tắc có test đơn vị;
 * phần đọc/ghi DB vẫn nằm ở nơi gọi (đảo bút toán: `reversal.ts`).
 */

import { currencyDecimals } from '@fingate/shared';
import type { CashEntryInput } from '../ledger/index.ts';

/**
 * US-VOU-05 — vòng duyệt hiện tại có KHOÁ sửa/xoá của người lập không.
 * Đã có Kế toán trưởng trở lên duyệt trong vòng này ⇒ khoá. NGOẠI LỆ: phiếu đang bị yêu cầu bổ sung
 * (`changes_requested`) được trả về để người lập sửa và gửi lại, nên không khoá; vòng mới bắt đầu từ lần gửi lại.
 */
export function roundLocksEdit(status: string, approvedFromKttUp: boolean): boolean {
  return approvedFromKttUp && status !== 'changes_requested';
}

/**
 * §6.2 — ai được đổi tag của phiếu: người lập phiếu, hoặc người có `tag:manage` (kế toán trưởng).
 * Tag không ảnh hưởng tiền nên đổi được cả sau khi duyệt (phải ghi lịch sử ở nơi gọi).
 */
export function mayChangeVoucherTags(actor: { user_id: string; permissions: readonly string[] }, doc: { created_by: string }): boolean {
  return String(doc.created_by) === actor.user_id || actor.permissions.includes('tag:manage');
}

/** Trường tiền của phiếu: minor-unit BigInt, số thập phân theo tiền tệ (không hard-code 0). */
export function voucherAmountField(currency: string, minor: bigint): { minor: bigint; currency: string; decimals: number } {
  return { minor, currency, decimals: currencyDecimals(currency) };
}

export type ActualAmountProblem = 'over_approved' | 'short_needs_reason';

/**
 * §6.1 / §8 — số thực chi khi thực thi phiếu chi:
 *   · KHÔNG được vượt số tiền đã chốt khi duyệt (`over_approved`);
 *   · thấp hơn thì bắt buộc nêu lý do ≥ 5 ký tự, lý do được ghi vào lịch sử (`short_needs_reason`).
 * Trả về lỗi, hoặc `null` khi hợp lệ.
 */
export function actualAmountProblem(approvedMinor: bigint, actualMinor: bigint, reason: string | null | undefined): ActualAmountProblem | null {
  if (actualMinor > approvedMinor) return 'over_approved';
  if (actualMinor < approvedMinor && (reason ?? '').trim().length < 5) return 'short_needs_reason';
  return null;
}

/** Loại chứng từ UNC trong danh mục bằng chứng (`bank_order` = "Ủy nhiệm chi"). */
export const UNC_EVIDENCE_TYPE = 'bank_order';

/**
 * §8 / US-EXE-01 — thiếu gì để đánh dấu phiếu chi ĐÃ CHI: số tham chiếu ngân hàng và chứng từ UNC.
 * Chỉ áp dụng cho phiếu chi. Trả về danh sách thiếu (rỗng = đủ).
 */
export function missingPaymentEvidence(input: {
  kind: string;
  bankRef?: string | null;
  attachmentTypes: readonly string[];
}): Array<'bank_ref' | 'unc'> {
  if (input.kind !== 'spend') return [];
  const missing: Array<'bank_ref' | 'unc'> = [];
  if (!(input.bankRef ?? '').trim()) missing.push('bank_ref');
  if (!input.attachmentTypes.includes(UNC_EVIDENCE_TYPE)) missing.push('unc');
  return missing;
}

/** Bản ghi sổ cái tối thiểu để dựng bút toán đảo (khớp model `CashEntry`, đọc bằng `lean`). */
export interface LedgerEntryForReversal {
  _id: unknown;
  company_id: unknown;
  account_id: unknown;
  direction: string;
  amount_minor: unknown;
  currency?: string | null;
  document_id?: unknown;
  document_code?: string | null;
  dedupe_key: string;
  reverses?: unknown;
}

/**
 * §8 — huỷ/xoá phiếu đã thực thi ⇒ sinh bút toán ĐẢO cho từng bút toán GỐC (sổ cái chỉ thêm, không sửa/xoá entry cũ).
 * · Chỉ đảo bút toán gốc (`reverses` rỗng); bút toán đảo có `reverses` = id bút toán gốc.
 * · Chiều ngược lại, cùng số tiền và tài khoản; `dedupe_key` = `rev:<khoá gốc>` ⇒ chạy lại không đảo trùng.
 */
export function reversalEntriesFor(entries: readonly LedgerEntryForReversal[], opts: { date: string; createdBy: string | null }): CashEntryInput[] {
  return entries
    .filter((e) => e.reverses == null)
    .map((e) => ({
      company_id: String(e.company_id),
      account_id: String(e.account_id),
      date: opts.date,
      direction: e.direction === 'in' ? 'out' : 'in',
      amount_minor: BigInt(String(e.amount_minor)),
      currency: e.currency ?? 'VND',
      reason: 'paid' as const,
      document_id: e.document_id == null ? null : String(e.document_id),
      document_code: e.document_code ?? null,
      reverses: String(e._id),
      dedupe_key: `rev:${e.dedupe_key}`,
      created_by: opts.createdBy,
    }));
}

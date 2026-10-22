/**
 * Cảnh báo trùng đối tác (v2/v2.md §5.1) — KHÔNG chặn lưu.
 *
 * Trùng khi, trong CÙNG công ty và KỂ CẢ đối tác khác loại:
 *  - `name`: cùng tên chuẩn hoá (`normalizeNameKey`: gộp khoảng trắng, không phân biệt hoa thường);
 *  - `bank_account`: cùng cặp (Ngân hàng, Số tài khoản) — cả hai đều có giá trị và khớp sau chuẩn hoá.
 * Một đối tác khớp cả hai lý do ⇒ hai cảnh báo.
 *
 * Phần thuần (`findDuplicateHits`) tách khỏi phần truy vấn (`findDuplicatePartners`) để kiểm thử.
 */

import { PARTNER_TYPE_LABEL, normalizeNameKey, type PartnerType } from '@fingate/shared';
import { Models } from '../../db/models.ts';

export type DuplicateReason = 'name' | 'bank_account';

/** Một cảnh báo trùng — khớp `partnerDuplicateWarning` trong packages/shared. */
export interface DuplicateHit {
  reason: DuplicateReason;
  partner_id: string;
  partner_code: string;
  partner_name: string;
  partner_type: PartnerType;
  message: string;
}

/** Đối tác đem đi so khớp (đã nạp đủ trường). */
export interface DuplicateCandidate {
  _id: string;
  code: string;
  name: string;
  type: PartnerType;
  bank_name: string | null;
  account_number: string | null;
}

export interface DuplicateInput {
  name: string;
  bank_name?: string | null;
  account_number?: string | null;
  /** Loại trừ chính đối tác đang sửa. */
  exclude_id?: string | null;
}

/** Chuẩn hoá số tài khoản để so khớp: bỏ khoảng trắng, gạch, chấm, gạch dưới, gạch chéo; không phân biệt hoa thường. */
export function normalizeAccountNumber(v: string | null | undefined): string | null {
  const s = String(v ?? '').replace(/[\s.\-_/]/g, '').toLowerCase();
  return s === '' ? null : s;
}

/** Chuẩn hoá tên ngân hàng để so khớp (cùng quy tắc tên đối tác). */
export function normalizeBankName(v: string | null | undefined): string | null {
  const s = normalizeNameKey(String(v ?? ''));
  return s === '' ? null : s;
}

/** Khoá cặp (Ngân hàng, STK) — null nếu thiếu một trong hai. */
export function bankAccountKeyOf(bankName: string | null | undefined, accountNumber: string | null | undefined): string | null {
  const bank = normalizeBankName(bankName);
  const account = normalizeAccountNumber(accountNumber);
  if (!bank || !account) return null;
  return `${bank}|${account}`;
}

function hitOf(reason: DuplicateReason, c: DuplicateCandidate): DuplicateHit {
  const typeLabel = PARTNER_TYPE_LABEL[c.type] ?? c.type;
  const who = `${c.code} — ${c.name} (${typeLabel})`;
  return {
    reason,
    partner_id: c._id,
    partner_code: c.code,
    partner_name: c.name,
    partner_type: c.type,
    message:
      reason === 'name'
        ? `Trùng tên với đối tác ${who}. Vẫn có thể lưu.`
        : `Trùng ngân hàng và số tài khoản với đối tác ${who}. Vẫn có thể lưu.`,
  };
}

/** Thuần: so khớp đầu vào với danh sách ứng viên, trả về các cảnh báo (rỗng nếu không trùng). */
export function findDuplicateHits(input: DuplicateInput, candidates: readonly DuplicateCandidate[]): DuplicateHit[] {
  const nameKey = normalizeNameKey(input.name ?? '');
  const accountKey = bankAccountKeyOf(input.bank_name, input.account_number);
  const hits: DuplicateHit[] = [];
  for (const c of candidates) {
    if (input.exclude_id && c._id === input.exclude_id) continue;
    if (nameKey && normalizeNameKey(c.name) === nameKey) hits.push(hitOf('name', c));
    if (accountKey && bankAccountKeyOf(c.bank_name, c.account_number) === accountKey) hits.push(hitOf('bank_account', c));
  }
  return hits;
}

const escapeRegexChar = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Dãy phân cách được bỏ qua giữa các ký tự khi so khớp số — cùng tập ký tự với `normalizeAccountNumber`
 * (`\s` của JS gồm cả khoảng trắng không ngắt như NBSP ⇒ thêm `\p{Zs}` cho PCRE; cần cờ `u` khi thử trong JS).
 */
const SEPARATOR_RUN = '[\\s\\p{Zs}._/-]*';

/** Ghép từng ký tự của khoá đã chuẩn hoá, cho phép một dãy phân cách giữa hai ký tự liền nhau. */
const separatedPattern = (key: string): string => [...key].map(escapeRegexChar).join(SEPARATOR_RUN);

/**
 * Regex (PCRE, dùng với `$options: 'i'`) khớp MỌI cách ghi cùng một số TK đã lưu: có hoặc không có
 * khoảng trắng / gạch / chấm / gạch dưới / gạch chéo xen giữa, không phân biệt hoa thường — đúng với
 * `normalizeAccountNumber`, nên bộ lọc DB không bỏ sót ứng viên mà bước so khớp trong bộ nhớ sẽ nhận.
 */
export function accountSearchPattern(accountNumber: string | null | undefined): string | null {
  const key = normalizeAccountNumber(accountNumber);
  if (!key) return null;
  return `^${SEPARATOR_RUN}${separatedPattern(key)}${SEPARATOR_RUN}$`;
}

/**
 * Regex (PCRE, `$options: 'i'`) cho ô gõ tìm STK / MST (§5.2 "Gõ để tìm"): khớp ĐOẠN BẤT KỲ của giá trị đã
 * lưu và bỏ qua phân cách giữa các ký tự — gõ `123456789012` tìm thấy `123-456 789 012`, gõ `0101234567001`
 * tìm thấy MST `0101234567-001`. Dùng cùng quy tắc chuẩn hoá với cảnh báo trùng (MST cũng hay có gạch).
 * Trả về null khi chữ gõ không còn ký tự nào sau chuẩn hoá (vd. chỉ gõ dấu gạch).
 */
export function identifierSearchPattern(query: string | null | undefined): string | null {
  const key = normalizeAccountNumber(query);
  return key ? separatedPattern(key) : null;
}

/**
 * Truy vấn trong công ty: đối tác cùng tên chuẩn hoá HOẶC cùng số tài khoản (sau đó so khớp
 * đầy đủ bằng `findDuplicateHits`). Không lọc theo loại.
 */
export async function findDuplicatePartners(input: DuplicateInput & { companyId: string }): Promise<DuplicateHit[]> {
  const nameKey = normalizeNameKey(input.name ?? '');
  const or: Record<string, unknown>[] = [];
  if (nameKey) or.push({ name_key: nameKey });
  const pattern = accountSearchPattern(input.account_number);
  if (pattern && normalizeBankName(input.bank_name)) or.push({ account_number: { $regex: pattern, $options: 'i' } });
  if (!or.length) return [];
  const filter: Record<string, unknown> = { company_id: input.companyId, $or: or };
  if (input.exclude_id) filter._id = { $ne: input.exclude_id };
  const rows = await Models.Partner.find(filter as never)
    .select({ code: 1, name: 1, type: 1, bank_name: 1, account_number: 1 })
    .lean<{ _id: unknown; code: string; name: string; type: PartnerType; bank_name?: string | null; account_number?: string | null }[]>();
  return findDuplicateHits(
    input,
    rows.map((r) => ({
      _id: String(r._id),
      code: String(r.code),
      name: String(r.name),
      type: r.type,
      bank_name: r.bank_name ?? null,
      account_number: r.account_number ?? null,
    })),
  );
}

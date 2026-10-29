/**
 * Đối tác loại "Công ty trong tập đoàn" (v2 §5.1, §11.6): mỗi TK (ngân hàng hoặc tiền mặt) của một công ty khác trong tập đoàn
 * là MỘT đối tác riêng. Tên / ngân hàng / STK lấy từ công ty & TK gốc và đồng bộ mỗi khi gốc đổi; không sửa tay.
 * Đối tác nội bộ là nguồn duy nhất của chuyển nội bộ phiếu chi (xem resolveTransferTarget).
 */

import { ApiError, normalizeNameKey } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { maskAccount } from '../queries/index.ts';
import { diffSnapshots, snapshotOf, type PartnerSnapshot } from './rules.ts';

/** Tên hiển thị: "Tên công ty · Tên tài khoản" — để phân biệt các TK cùng một công ty. */
export function internalPartnerName(companyName: string, accountName: string): string {
  return `${companyName} · ${accountName}`;
}

/** Nguồn của một đối tác nội bộ. `usable` = TK (ngân hàng hoặc tiền mặt), không phải TK nhóm, đang hoạt động. */
export interface InternalSource {
  company_id: string;
  name: string;
  bank_name: string;
  account_number: string;
  usable: boolean;
}

/** Nạp công ty + TK gốc; null nếu một trong hai không còn tồn tại. */
export async function loadInternalSource(accountId: string): Promise<InternalSource | null> {
  const acct = await Models.BankAccount.findById(accountId)
    .select({ company_id: 1, is_group: 1, kind: 1, status: 1, bank_name: 1, account_name: 1, account_number: 1 })
    .lean<{ company_id?: unknown; is_group?: boolean; kind?: string; status?: string; bank_name?: string; account_name?: string; account_number?: string } | null>();
  if (!acct || !acct.company_id) return null;
  const companyId = String(acct.company_id);
  const company = await Models.Company.findById(companyId).select({ name: 1 }).lean<{ name?: string } | null>();
  if (!company) return null;
  return {
    company_id: companyId,
    name: internalPartnerName(String(company.name ?? ''), String(acct.account_name ?? '')),
    bank_name: String(acct.bank_name ?? ''),
    account_number: String(acct.account_number ?? ''),
    usable: !acct.is_group && acct.status === 'active',
  };
}

/** Các trường lưu cho đối tác nội bộ khi TẠO (lấy từ TK gốc, bỏ qua giá trị người dùng gửi lên). Ném lỗi nếu không hợp lệ. */
export async function internalPartnerFieldsFor(input: {
  ownerCompanyId: string;
  internalCompanyId: string | null | undefined;
  internalAccountId: string | null | undefined;
}): Promise<{ name: string; bank_name: string; account_number: string; internal_company_id: string; internal_account_id: string }> {
  if (!input.internalCompanyId || !input.internalAccountId) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Chọn công ty và tài khoản của công ty trong tập đoàn',
      errors: { internal_account_id: 'Chọn tài khoản của công ty trong tập đoàn' },
    });
  }
  if (input.internalCompanyId === input.ownerCompanyId) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Công ty trong tập đoàn phải khác công ty đang tạo đối tác',
      errors: { internal_company_id: 'Chọn công ty khác công ty đang làm việc' },
    });
  }
  const src = await loadInternalSource(input.internalAccountId);
  if (!src || src.company_id !== input.internalCompanyId || !src.usable) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Tài khoản không thuộc công ty đã chọn, là tài khoản nhóm, hoặc đã đóng',
      errors: { internal_account_id: 'Tài khoản không thuộc công ty đã chọn, là tài khoản nhóm, hoặc đã đóng' },
    });
  }
  const existed = await Models.Partner.exists({ company_id: input.ownerCompanyId, type: 'internal', internal_account_id: input.internalAccountId } as never);
  if (existed) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Đã có đối tác cho tài khoản này',
      errors: { internal_account_id: 'Đã có đối tác cho tài khoản này' },
    });
  }
  return {
    name: src.name,
    bank_name: src.bank_name,
    account_number: src.account_number,
    internal_company_id: src.company_id,
    internal_account_id: input.internalAccountId,
  };
}

/** Ảnh chụp sau đồng bộ (thuần): tên / NH / STK theo nguồn; trạng thái chỉ bị hạ xuống, không tự bật lại. */
export function internalSyncSnapshot(before: PartnerSnapshot, src: InternalSource): PartnerSnapshot {
  return {
    ...before,
    name: src.name,
    bank_name: src.bank_name,
    account_number: src.account_number,
    status: !src.usable && before.status === 'active' ? 'inactive' : before.status,
  };
}

/**
 * Đồng bộ đối tác nội bộ theo công ty gốc hoặc TK gốc vừa đổi. Ghi lịch sử (không có người thực hiện).
 * TK gốc không còn dùng được ⇒ đối tác chuyển Ngừng giao dịch; không tự bật lại khi TK mở lại.
 * Trả về số đối tác đã đổi.
 */
export async function syncInternalPartners(by: { companyId?: string; accountId?: string }): Promise<number> {
  const filter = by.accountId ? { type: 'internal', internal_account_id: by.accountId } : { type: 'internal', internal_company_id: by.companyId };
  const partners = await Models.Partner.find(filter as never).lean<Array<Record<string, unknown>>>();
  let changed = 0;
  for (const p of partners) {
    const src = await loadInternalSource(String(p.internal_account_id));
    if (!src) continue;
    const before = snapshotOf({
      type: 'internal',
      name: p.name as string,
      bank_name: (p.bank_name as string | null) ?? null,
      account_number: (p.account_number as string | null) ?? null,
      tax_code: null,
      note: null,
      status: p.status as string,
    });
    const next = internalSyncSnapshot(before, src);
    const changes = diffSnapshots(before, next);
    if (Object.keys(changes).length === 0) continue;
    const now = new Date();
    await Models.Partner.updateOne(
      { _id: p._id } as never,
      {
        $set: {
          updated_at: now,
          name: next.name,
          name_key: normalizeNameKey(next.name ?? ''),
          bank_name: next.bank_name,
          account_number: next.account_number,
          status: next.status,
        },
        $push: { history: { at: now, actor: { user_id: null, name: 'Đồng bộ từ công ty / tài khoản' }, changes } },
      } as never,
    ).exec();
    changed++;
  }
  return changed;
}

/**
 * Điều kiện TK gốc dùng được làm đối tác nội bộ — cùng tiêu chí với `usable` ở `loadInternalSource`, nên mọi TK
 * hiện trong danh sách chọn đều tạo được đối tác.
 */
export function internalSourceFilter(companyId: string): Record<string, unknown> {
  return { company_id: companyId, is_group: { $ne: true }, status: 'active' };
}

/** TK (ngân hàng hoặc tiền mặt) của một công ty để chọn làm nguồn đối tác nội bộ. STK đã che; không có số dư. */
export interface InternalSourceAccountView {
  _id: string;
  bank_name: string;
  account_name: string;
  account_number_masked: string;
}

export async function internalSourceAccounts(companyId: string): Promise<InternalSourceAccountView[]> {
  const rows = await Models.BankAccount.find(internalSourceFilter(companyId) as never)
    .select({ bank_name: 1, account_name: 1, account_number: 1 })
    .sort({ bank_name: 1, account_name: 1 })
    .lean<{ _id: unknown; bank_name?: string; account_name?: string; account_number?: string }[]>();
  return rows.map((a) => ({
    _id: String(a._id),
    bank_name: String(a.bank_name ?? ''),
    account_name: String(a.account_name ?? ''),
    account_number_masked: maskAccount(String(a.account_number ?? '')),
  }));
}

/** Công ty trong tập đoàn để chọn làm đối tác nội bộ. */
export interface InternalCompanyView {
  _id: string;
  name: string;
  code: string;
  is_group: boolean;
}

/** Mọi công ty đang hoạt động trong tập đoàn — không theo phân công của người tạo đối tác. */
export async function internalCompanyChoices(): Promise<InternalCompanyView[]> {
  const rows = await Models.Company.find({ status: 'active' } as never)
    .select({ name: 1, code: 1, is_group: 1 })
    .sort({ is_group: -1, code: 1 })
    .lean<{ _id: unknown; name?: string; code?: string; is_group?: boolean }[]>();
  return rows.map((c) => ({ _id: String(c._id), name: String(c.name ?? ''), code: String(c.code ?? ''), is_group: Boolean(c.is_group) }));
}

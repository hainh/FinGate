/**
 * Đối tác loại "Công ty trong tập đoàn" (v2 §5.1, §11.6): mỗi TK (ngân hàng hoặc tiền mặt) là MỘT đối tác riêng.
 * Tên / ngân hàng / STK lấy từ công ty & TK gốc và đồng bộ mỗi khi gốc đổi; không sửa tay.
 * Công ty gốc có thể là công ty KHÁC trong tập đoàn (chuyển tiền giữa các công ty) hoặc CHÍNH công ty đang lập phiếu
 * (chuyển tiền giữa hai tài khoản của cùng một công ty — TK nhận phải khác TK nguồn, kiểm trên phiếu chi).
 * Đối tác nội bộ là nguồn duy nhất của chuyển nội bộ phiếu chi (xem resolveTransferTarget).
 */

import { ApiError, normalizeNameKey } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { mirrorAudit } from '../audit/index.ts';
import { nextPartnerCode } from '../numbering/index.ts';
import { maskAccount } from '../queries/index.ts';
import { creationChanges, diffSnapshots, snapshotOf, type PartnerSnapshot } from './rules.ts';

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

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

/**
 * Các trường lưu cho đối tác nội bộ khi TẠO (lấy từ TK gốc, bỏ qua giá trị người dùng gửi lên). Ném lỗi nếu không hợp lệ.
 * Công ty gốc được phép TRÙNG công ty đang tạo đối tác: đối tác trỏ tới một TK khác CỦA CHÍNH công ty đó (chuyển tiền
 * giữa hai tài khoản cùng công ty). TK nhận trùng TK nguồn do phiếu chi chặn (`assertTransferTargetFits`), vì lúc tạo
 * đối tác chưa biết phiếu nào sẽ dùng.
 */
export async function internalPartnerFieldsFor(input: {
  ownerCompanyId: string;
  internalCompanyId: string | null | undefined;
  internalAccountId: string | null | undefined;
  /** Khi SỬA đối tác nội bộ chưa liên kết: bỏ qua chính đối tác này khi kiểm trùng tài khoản. */
  excludePartnerId?: string | null;
}): Promise<{ name: string; bank_name: string; account_number: string; internal_company_id: string; internal_account_id: string }> {
  if (!input.internalCompanyId || !input.internalAccountId) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Chọn công ty và tài khoản của công ty trong tập đoàn',
      errors: { internal_account_id: 'Chọn tài khoản của công ty trong tập đoàn' },
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
  const existed = await Models.Partner.exists({
    company_id: input.ownerCompanyId,
    type: 'internal',
    internal_account_id: input.internalAccountId,
    ...(input.excludePartnerId ? { _id: { $ne: input.excludePartnerId } } : {}),
  } as never);
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

/** Bộ lọc tra đối tác nội bộ của MỘT tài khoản trong một công ty — khoá chống trùng khi tạo. */
export function internalPartnerLookupFilter(ownerCompanyId: string, accountId: string): Record<string, unknown> {
  return { company_id: ownerCompanyId, type: 'internal', internal_account_id: accountId };
}

/**
 * Bảo đảm danh bạ công ty `ownerCompanyId` có đối tác "Công ty trong tập đoàn" trỏ tới tài khoản `accountId`.
 *
 * **Thứ tự bắt buộc (yêu cầu nghiệp vụ):** tìm đối tác nội bộ ĐÃ CÓ của đúng tài khoản đó trong công ty rồi dùng lại —
 * chỉ tạo mới khi danh bạ chưa có. Nhờ vậy nhiều phiếu phát sinh cùng một tài khoản đích chỉ dùng MỘT đối tác.
 *
 * Dùng cho phiếu phát sinh do quy tắc tự động (R1 phiếu thu đối ứng, R8 mượn tiền giữa hai tài khoản): rule cần có
 * đối tác để gắn vào phiếu, không bắt kế toán tạo tay trước. Đối tác tạo ở đây đúng như tạo bằng form — tên / NH / STK
 * lấy từ tài khoản gốc (`loadInternalSource`), loại `internal`, mã `DT-…` cùng bộ đếm, có `history` + audit.
 *
 * Không ném lỗi nghiệp vụ: tài khoản không dùng được (TK nhóm, đã đóng, không đọc được) hoặc ghi thất bại ⇒
 * trả `partner_id = null` để rule vẫn sinh được phiếu như trước, kèm `skipped` cho log.
 */
export async function ensureInternalPartner(input: {
  /** Công ty QUẢN LÝ đối tác = công ty của phiếu sắp gắn đối tác (không phải công ty gốc của tài khoản). */
  ownerCompanyId: string;
  accountId: string | null | undefined;
  actor: { user_id?: string | null; name?: string | null; role?: string | null };
  requestId?: string | null;
  /** Nêu trong lịch sử / audit vì sao tự tạo (VD `R1`, `R8`). */
  source?: string | null;
}): Promise<{ partner_id: string | null; created: boolean; skipped: string | null }> {
  const accountId = input.accountId ? String(input.accountId) : null;
  if (!accountId || !OBJECT_ID_RE.test(accountId) || !OBJECT_ID_RE.test(input.ownerCompanyId)) {
    return { partner_id: null, created: false, skipped: 'no-account' };
  }
  const existing = await Models.Partner.findOne(internalPartnerLookupFilter(input.ownerCompanyId, accountId) as never)
    .select({ _id: 1 })
    .lean<{ _id: unknown } | null>();
  if (existing) return { partner_id: String(existing._id), created: false, skipped: null };

  const src = await loadInternalSource(accountId);
  if (!src || !src.usable) return { partner_id: null, created: false, skipped: 'account-unusable' };

  try {
    const code = await nextPartnerCode();
    const now = new Date();
    const snap = snapshotOf({ type: 'internal', name: src.name, bank_name: src.bank_name, account_number: src.account_number, tax_code: null, note: null, status: 'active' });
    const created = await Models.Partner.create({
      company_id: input.ownerCompanyId,
      code,
      type: 'internal',
      internal_company_id: src.company_id,
      internal_account_id: accountId,
      status: 'active',
      name: snap.name ?? '',
      name_key: normalizeNameKey(snap.name ?? ''),
      bank_name: snap.bank_name,
      account_number: snap.account_number,
      tax_code: null,
      note: null,
      history: [{ at: now, actor: { user_id: input.actor.user_id ?? null, name: input.actor.name ?? null }, changes: creationChanges(snap) }],
      created_by: input.actor.user_id ?? null,
      created_at: now,
      updated_at: now,
    } as never);
    const id = String((created as unknown as { _id: unknown })._id);
    await mirrorAudit({
      at: now,
      actor: { user_id: input.actor.user_id ?? null, name: input.actor.name ?? null, role: input.actor.role ?? null },
      action: 'partner.create',
      subject: { type: 'partner', id, code },
      company_id: input.ownerCompanyId,
      diff_fields: { type: 'internal', name: snap.name, status: 'active', auto: true, rule_code: input.source ?? null },
      request_id: input.requestId ?? null,
    });
    return { partner_id: id, created: true, skipped: null };
  } catch (err) {
    // Hai phiếu cùng lúc có thể đua tạo: nếu bản ghi đã tồn tại (lần tạo kia thắng) thì dùng lại, không coi là lỗi.
    const raced = await Models.Partner.findOne(internalPartnerLookupFilter(input.ownerCompanyId, accountId) as never)
      .select({ _id: 1 })
      .lean<{ _id: unknown } | null>();
    if (raced) return { partner_id: String(raced._id), created: false, skipped: null };
    console.warn(`[partner] không tự tạo đối tác nội bộ cho TK ${accountId}: ${(err as Error).message}`);
    return { partner_id: null, created: false, skipped: 'create-failed' };
  }
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

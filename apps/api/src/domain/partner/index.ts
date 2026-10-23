/**
 * Đối tác — danh bạ THEO CÔNG TY (v2/v2.md §5, §14.2).
 *
 * Dịch vụ: tạo / sửa (có lịch sử + cảnh báo trùng không chặn) · ngừng / kích hoạt lại · xoá khi
 * chưa phát sinh · sao chép từ công ty khác · danh sách có số liệu tóm tắt · chi tiết và dữ liệu
 * các tab. Route (routes/partners.ts) chỉ kiểm quyền / phạm vi / zod rồi gọi các hàm ở đây.
 *
 * Định danh = `_id` (mã `DT-…`). Tên / ngân hàng / STK / MST chỉ là thông tin hiển thị.
 */

import { ApiError, normalizeNameKey, PARTNER_TYPE_LABEL, type PartnerCreateBody, type PartnerType, type PartnerUpdateBody, vnDate } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { mirrorAudit } from '../audit/index.ts';
import { toBig } from '../links/index.ts';
import { nextPartnerCode } from '../numbering/index.ts';
import { acquireClaim, claimKeyOf, completeClaim, releaseClaim, type ClaimHandle } from './claims.ts';
import { findDuplicatePartners, identifierSearchPattern, type DuplicateHit } from './duplicates.ts';
import { defaultPeriod, loadPartnerLedgers, maturityInfo, numbersOf, type LedgerPartner, type LoanView, type DebtView, type Period, type PartnerLedger, type SummaryVisibility } from './summary.ts';
import { accountCodeOfPartnerType } from '../debt/rules.ts';
import { assertPartnerTypeChange, loadPartnerTypeUsage } from './type-guard.ts';
import { internalPartnerFieldsFor } from './internal.ts';
import {
  asPartnerType,
  assertValidPartnerRecord,
  cleanText,
  creationChanges,
  diffSnapshots,
  snapshotOf,
  type PartnerChanges,
  type PartnerSnapshot,
  type PartnerTrackedField,
} from './rules.ts';

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

export interface PartnerActor {
  user_id: string;
  name?: string | null;
  role?: string | null;
}

/** Bản ghi đối tác đã đọc (lean). */
export interface PartnerLean {
  _id: unknown;
  company_id: unknown;
  code: string;
  type: PartnerType;
  status: 'active' | 'inactive';
  name: string;
  name_key: string;
  bank_name?: string | null;
  account_number?: string | null;
  tax_code?: string | null;
  note?: string | null;
  history?: { at: Date; actor?: { user_id?: unknown; name?: string | null } | null; changes?: Record<string, unknown> | null }[];
  created_by?: unknown;
  created_at?: Date;
  updated_at?: Date;
}

export interface SaveOutput {
  partner: PartnerLean;
  warnings: DuplicateHit[];
}

/* ================================================================== *
 * Tiện ích
 * ================================================================== */

const idOf = (v: unknown): string => String(v);

function notFound(what = 'đối tác'): never {
  throw new ApiError({ code: 'FG-VAL-001', status: 404, detail: `Không tìm thấy ${what}` });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Số tiền trên wire: `{minor, currency, decimals}` (chuỗi minor units). */
export function moneyOf(v: bigint, currency = 'VND'): { minor: string; currency: string; decimals: number } {
  return { minor: v.toString(), currency, decimals: 0 };
}

export function moneyWireOf(v: bigint | null): { minor: string; currency: string; decimals: number } | null {
  return v === null ? null : moneyOf(v);
}

export async function loadPartner(id: string): Promise<PartnerLean> {
  if (!OBJECT_ID_RE.test(id)) notFound();
  const p = await Models.Partner.findById(id).lean<PartnerLean | null>();
  if (!p) notFound();
  return p;
}

/** Đối tác có nằm trong phạm vi công ty của người gọi không (null = toàn tập đoàn). */
export function assertPartnerInScope(companyId: unknown, scopeCompanyIds: string[] | null): void {
  if (scopeCompanyIds === null) return;
  if (!scopeCompanyIds.includes(idOf(companyId))) throw new ApiError({ code: 'FG-RBAC-002' });
}

/** Khoá so sánh/lưu cho trường đối tác khi lưu: chuỗi đã chuẩn hoá. */
function snapshotOfLean(p: PartnerLean): PartnerSnapshot {
  return snapshotOf({
    type: p.type,
    name: p.name,
    bank_name: p.bank_name ?? null,
    account_number: p.account_number ?? null,
    tax_code: p.tax_code ?? null,
    note: p.note ?? null,
    status: p.status,
  });
}

/* ================================================================== *
 * Tạo / sửa / trạng thái / xoá
 * ================================================================== */

/** Kết quả tạo: đối tác dạng tham chiếu + cảnh báo trùng. `replayed` = trả lại kết quả lần đầu (cùng request_id). */
export interface CreateOutput {
  partner: PartnerRefView;
  warnings: DuplicateHit[];
  replayed: boolean;
}

export async function createPartner(input: {
  companyId: string;
  body: PartnerCreateBody;
  actor: PartnerActor;
  ip?: string | null;
  requestId?: string | null;
}): Promise<CreateOutput> {
  // Loại nội bộ: tên / NH / STK lấy từ TK gốc (bỏ giá trị người dùng gửi lên), không cảnh báo trùng.
  const isInternal = input.body.type === 'internal';
  const snap = snapshotOf({
    type: input.body.type,
    name: input.body.name,
    bank_name: input.body.bank_name,
    account_number: input.body.account_number,
    tax_code: input.body.tax_code,
    note: input.body.note,
    status: input.body.status ?? 'active',
  });
  if (!isInternal) assertValidPartnerRecord(snap);

  // Chống ghi đúp: cùng request_id (bấm lặp / thử lại mạng) ⇒ trả lại đúng đối tác đã tạo, không tạo thêm.
  let claim: ClaimHandle | null = null;
  if (input.requestId) {
    const outcome = await acquireClaim<{ partner: PartnerRefView; warnings: DuplicateHit[] }>(
      claimKeyOf('partner.create', input.companyId, input.requestId),
      'partner.create',
      input.companyId,
    );
    if (outcome.replayed) return { ...outcome.result, replayed: true };
    claim = outcome.handle;
  }
  try {
    const internal = isInternal
      ? await internalPartnerFieldsFor({
          ownerCompanyId: input.companyId,
          internalCompanyId: input.body.internal_company_id,
          internalAccountId: input.body.internal_account_id,
        })
      : null;
    const final = internal
      ? snapshotOf({ type: 'internal', name: internal.name, bank_name: internal.bank_name, account_number: internal.account_number, tax_code: null, note: null, status: snap.status })
      : snap;
    const type = asPartnerType(final.type);
    const name = final.name ?? '';
    const warnings = internal
      ? []
      : await findDuplicatePartners({
          companyId: input.companyId,
          name,
          bank_name: final.bank_name,
          account_number: final.account_number,
        });

    const code = await nextPartnerCode();
    const now = new Date();
    const created = await Models.Partner.create({
      company_id: input.companyId,
      code,
      type,
      internal_company_id: internal?.internal_company_id ?? null,
      internal_account_id: internal?.internal_account_id ?? null,
      status: final.status ?? 'active',
      name,
      name_key: normalizeNameKey(name),
      bank_name: final.bank_name,
      account_number: final.account_number,
      tax_code: final.tax_code,
      note: final.note,
      history: [{ at: now, actor: { user_id: input.actor.user_id, name: input.actor.name ?? null }, changes: creationChanges(final) }],
      created_by: input.actor.user_id,
      created_at: now,
      updated_at: now,
    } as never);
    const partner = partnerRefOf(created.toObject() as unknown as PartnerLean);
    // Ghi kết quả NGAY sau khi đã tạo (trước audit): lỗi audit sau đó không làm mất khả năng replay.
    if (claim) await completeClaim(claim, { partner, warnings });

    await mirrorAudit({
      at: now,
      actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
      action: 'partner.create',
      subject: { type: 'partner', id: partner._id, code },
      company_id: input.companyId,
      diff_fields: { type, name, status: final.status ?? 'active' },
      request_id: input.requestId ?? null,
      ip: input.ip ?? null,
    });
    return { partner, warnings, replayed: false };
  } catch (err) {
    if (claim) await releaseClaim(claim); // chưa tạo gì (lỗi trước khi ghi) ⇒ cho phép gửi lại
    throw err;
  }
}

export async function updatePartner(input: {
  id: string;
  scopeCompanyIds: string[] | null;
  body: PartnerUpdateBody;
  actor: PartnerActor;
  ip?: string | null;
  requestId?: string | null;
}): Promise<SaveOutput> {
  const prev = await loadPartner(input.id);
  assertPartnerInScope(prev.company_id, input.scopeCompanyIds);
  const companyId = idOf(prev.company_id);
  const before = snapshotOfLean(prev);

  // Gộp: chỉ các trường CÓ MẶT trong body mới đổi.
  const b = input.body;
  const next: PartnerSnapshot = { ...before };
  if (b.type !== undefined) next.type = cleanText(b.type);
  if (b.name !== undefined) next.name = cleanText(b.name);
  if (b.bank_name !== undefined) next.bank_name = cleanText(b.bank_name);
  if (b.account_number !== undefined) next.account_number = cleanText(b.account_number);
  if (b.tax_code !== undefined) next.tax_code = cleanText(b.tax_code);
  if (b.note !== undefined) next.note = cleanText(b.note);
  if (b.status !== undefined) next.status = cleanText(b.status);
  assertValidPartnerRecord(next);

  // Đối tác nội bộ: thông tin lấy từ công ty / TK gốc nên không sửa tay (chỉ đổi trạng thái); không đổi sang loại này.
  const infoFields = ['type', 'name', 'bank_name', 'account_number', 'tax_code', 'note'] as const;
  if (before.type === 'internal' && infoFields.some((f) => before[f] !== next[f])) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Đối tác công ty trong tập đoàn không sửa thông tin — thông tin lấy từ công ty / tài khoản gốc',
      errors: { name: 'Thông tin lấy từ công ty / tài khoản gốc, không sửa tay' },
    });
  }
  if (before.type !== 'internal' && next.type === 'internal') {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Không đổi sang "Công ty trong tập đoàn" — tạo đối tác mới',
      errors: { type: 'Tạo đối tác mới để chọn công ty trong tập đoàn' },
    });
  }

  if (before.type !== next.type) {
    const usage = await loadPartnerTypeUsage(companyId, input.id);
    assertPartnerTypeChange(asPartnerType(before.type), asPartnerType(next.type), usage);
  }

  const changes = diffSnapshots(before, next);
  if (Object.keys(changes).length === 0) return { partner: prev, warnings: [] };

  const warnings = await findDuplicatePartners({
    companyId,
    name: next.name ?? '',
    bank_name: next.bank_name,
    account_number: next.account_number,
    exclude_id: input.id,
  });

  const now = new Date();
  const set: Record<string, unknown> = { updated_at: now };
  for (const f of Object.keys(changes) as PartnerTrackedField[]) set[f] = next[f];
  if (changes.name) set.name_key = normalizeNameKey(next.name ?? '');
  const result = await Models.Partner.updateOne(
    { _id: input.id, updated_at: prev.updated_at } as never,
    {
      $set: set,
      $push: { history: { at: now, actor: { user_id: input.actor.user_id, name: input.actor.name ?? null }, changes } },
    } as never,
  ).exec();
  if (result.matchedCount === 0) throw new ApiError({ code: 'FG-WF-011' });
  // khoản công nợ lưu loại / TK kế toán lúc lập: đổi KH ↔ NCC thì đồng bộ lại để lọc & báo cáo đúng (v2 §5.1, §9.1)
  const debtAccountCode = next.type ? accountCodeOfPartnerType(next.type) : null;
  if (changes.type && next.type && debtAccountCode) {
    await Models.DebtVoucher.updateMany(
      { partner_id: input.id } as never,
      { $set: { party_type: next.type, account_code: debtAccountCode } } as never,
    ).exec();
  }

  await mirrorAudit({
    at: now,
    actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
    action: 'partner.update',
    subject: { type: 'partner', id: input.id, code: prev.code },
    company_id: companyId,
    diff_fields: changes as Record<string, unknown>,
    request_id: input.requestId ?? null,
    ip: input.ip ?? null,
  });
  return { partner: await loadPartner(input.id), warnings };
}

/** Ngừng giao dịch / kích hoạt lại (không xoá, lịch sử giữ nguyên). */
export async function setPartnerStatus(input: {
  id: string;
  status: 'active' | 'inactive';
  scopeCompanyIds: string[] | null;
  actor: PartnerActor;
  ip?: string | null;
  requestId?: string | null;
}): Promise<SaveOutput> {
  const prev = await loadPartner(input.id);
  assertPartnerInScope(prev.company_id, input.scopeCompanyIds);
  if (prev.status === input.status) return { partner: prev, warnings: [] };
  const now = new Date();
  const changes: PartnerChanges = { status: { from: prev.status, to: input.status } };
  const result = await Models.Partner.updateOne(
    { _id: input.id, updated_at: prev.updated_at } as never,
    {
      $set: { status: input.status, updated_at: now },
      $push: { history: { at: now, actor: { user_id: input.actor.user_id, name: input.actor.name ?? null }, changes } },
    } as never,
  ).exec();
  if (result.matchedCount === 0) throw new ApiError({ code: 'FG-WF-011' });
  await mirrorAudit({
    at: now,
    actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
    action: input.status === 'inactive' ? 'partner.deactivate' : 'partner.reactivate',
    subject: { type: 'partner', id: input.id, code: prev.code },
    company_id: idOf(prev.company_id),
    diff_fields: { status: input.status },
    request_id: input.requestId ?? null,
    ip: input.ip ?? null,
  });
  return { partner: await loadPartner(input.id), warnings: [] };
}

/** Số lượng phiếu / công nợ / nợ NH / khoản chi định kỳ / liên kết đang tham chiếu đối tác. */
export interface PartnerUsageCounts {
  documents: number;
  debt_vouchers: number;
  bank_debts: number;
  recurring_rules: number;
  links: number;
}

export async function partnerUsageCounts(companyId: string, partnerId: string): Promise<PartnerUsageCounts> {
  const [documents, debt_vouchers, bank_debts, recurring_rules] = await Promise.all([
    Models.Document.countDocuments({ company_id: companyId, partner_id: partnerId } as never).exec(),
    Models.DebtVoucher.countDocuments({ company_id: companyId, partner_id: partnerId } as never).exec(),
    Models.BankDebt.countDocuments({ company_id: companyId, partner_id: partnerId } as never).exec(),
    Models.RecurringRule.countDocuments({ company_id: companyId, partner_id: partnerId } as never).exec(),
  ]);
  let links = 0;
  if (documents + debt_vouchers + bank_debts > 0) {
    const docIds = documents ? await Models.Document.distinct('_id', { company_id: companyId, partner_id: partnerId } as never).exec() : [];
    const debtIds = debt_vouchers ? await Models.DebtVoucher.distinct('_id', { company_id: companyId, partner_id: partnerId } as never).exec() : [];
    const loanIds = bank_debts ? await Models.BankDebt.distinct('_id', { company_id: companyId, partner_id: partnerId } as never).exec() : [];
    const refs = [...docIds, ...debtIds, ...loanIds];
    if (refs.length) {
      links = await Models.BusinessLink.countDocuments({
        company_id: companyId,
        $or: [{ from_id: { $in: refs } }, { to_id: { $in: refs } }],
      } as never).exec();
    }
  }
  return { documents, debt_vouchers, bank_debts, recurring_rules, links };
}

const usageTotal = (u: PartnerUsageCounts): number => u.documents + u.debt_vouchers + u.bank_debts + u.recurring_rules + u.links;

function inUseError(usage: PartnerUsageCounts): ApiError {
  return new ApiError({
    code: 'FG-PARTNER-002',
    detail: `Đối tác đã có phát sinh (${usage.documents} phiếu, ${usage.debt_vouchers} công nợ, ${usage.bank_debts} khoản vay, ${usage.recurring_rules} khoản chi định kỳ) — chỉ ngừng giao dịch`,
    data: { usage },
  });
}

/**
 * Xoá đối tác CHỈ khi chưa được dùng ở đâu (v2 §5.1). Đã phát sinh ⇒ FG-PARTNER-002 (chỉ ngừng giao dịch).
 * Kiểm lại SAU khi xoá: nếu có phiếu / công nợ / khoản vay vừa ghi (đua với lượt ghi khác) thì khôi phục
 * đúng bản ghi cũ và báo lỗi — không để lại tham chiếu treo.
 */
export async function deletePartner(input: {
  id: string;
  scopeCompanyIds: string[] | null;
  actor: PartnerActor;
  ip?: string | null;
  requestId?: string | null;
}): Promise<void> {
  const prev = await loadPartner(input.id);
  assertPartnerInScope(prev.company_id, input.scopeCompanyIds);
  const companyId = idOf(prev.company_id);
  const usage = await partnerUsageCounts(companyId, input.id);
  if (usageTotal(usage) > 0) throw inUseError(usage);
  await Models.Partner.deleteOne({ _id: input.id, company_id: companyId } as never).exec();
  const after = await partnerUsageCounts(companyId, input.id);
  if (usageTotal(after) > 0) {
    await Models.Partner.collection.insertOne(prev as never); // khôi phục đúng bản ghi cũ (cùng _id, lịch sử)
    throw inUseError(after);
  }
  await mirrorAudit({
    at: new Date(),
    actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
    action: 'partner.delete',
    subject: { type: 'partner', id: input.id, code: prev.code },
    company_id: companyId,
    request_id: input.requestId ?? null,
    ip: input.ip ?? null,
  });
}

/** Kết quả sao chép: bản sao đã tạo (theo thứ tự chọn) + cảnh báo trùng; `replayed` khi trả lại kết quả cũ. */
export interface CopyOutput {
  created: { source_id: string; partner_id: string; code: string; name: string }[];
  warnings: DuplicateHit[];
  replayed: boolean;
}

/**
 * Sao chép đối tác từ công ty khác (v2 §5.3): bản sao MỚI, ID riêng, độc lập; vẫn cảnh báo trùng.
 * Người gọi phải xem được công ty nguồn (`readableCompanyIds`: null = toàn tập đoàn).
 * Chống ghi đúp theo `requestId`: lặp lại ⇒ trả lại đúng các bản sao đã tạo.
 */
export async function copyPartners(input: {
  sourceCompanyId: string;
  targetCompanyId: string;
  partnerIds: string[];
  readableCompanyIds: string[] | null;
  actor: PartnerActor;
  ip?: string | null;
  requestId?: string | null;
}): Promise<CopyOutput> {
  if (input.readableCompanyIds !== null && !input.readableCompanyIds.includes(input.sourceCompanyId)) {
    throw new ApiError({ code: 'FG-RBAC-002', detail: 'Bạn không có quyền xem công ty nguồn' });
  }
  if (input.sourceCompanyId === input.targetCompanyId) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Công ty nguồn và công ty đích phải khác nhau', errors: { source_company_id: 'Trùng công ty đích' } });
  }
  const ids = [...new Set(input.partnerIds)];
  const sources = await Models.Partner.find({ _id: { $in: ids }, company_id: input.sourceCompanyId } as never).lean<PartnerLean[]>();
  if (sources.length !== ids.length) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Có đối tác không thuộc công ty nguồn', errors: { partner_ids: 'Đối tác không thuộc công ty nguồn' } });
  }
  // đối tác nội bộ trỏ tới TK của một công ty cụ thể — không sao chép sang công ty khác
  if (sources.some((s) => s.type === 'internal')) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Đối tác công ty trong tập đoàn không sao chép — tạo mới trong công ty cần',
      errors: { partner_ids: 'Bỏ chọn đối tác công ty trong tập đoàn' },
    });
  }

  let claim: ClaimHandle | null = null;
  if (input.requestId) {
    const outcome = await acquireClaim<Omit<CopyOutput, 'replayed'>>(
      claimKeyOf('partner.copy', input.targetCompanyId, input.requestId),
      'partner.copy',
      input.targetCompanyId,
    );
    if (outcome.replayed) return { ...outcome.result, replayed: true };
    claim = outcome.handle;
  }

  const byId = new Map(sources.map((s) => [idOf(s._id), s] as const));
  const created: CopyOutput['created'] = [];
  const warnings: DuplicateHit[] = [];
  try {
    for (const id of ids) {
      const src = byId.get(id);
      if (!src) continue;
      const snap = snapshotOfLean({ ...src, status: 'active' });
      const hits = await findDuplicatePartners({
        companyId: input.targetCompanyId,
        name: snap.name ?? '',
        bank_name: snap.bank_name,
        account_number: snap.account_number,
      });
      warnings.push(...hits);
      const code = await nextPartnerCode();
      const now = new Date();
      const changes = {
        ...creationChanges(snap),
        copied_from: { from: null, to: { company_id: input.sourceCompanyId, partner_id: id, code: src.code } },
      };
      const doc = await Models.Partner.create({
        company_id: input.targetCompanyId,
        code,
        type: src.type,
        status: 'active',
        name: src.name,
        name_key: normalizeNameKey(src.name),
        bank_name: snap.bank_name,
        account_number: snap.account_number,
        tax_code: snap.tax_code,
        note: snap.note,
        history: [{ at: now, actor: { user_id: input.actor.user_id, name: input.actor.name ?? null }, changes }],
        created_by: input.actor.user_id,
        created_at: now,
        updated_at: now,
      } as never);
      const newId = idOf(doc._id);
      created.push({ source_id: id, partner_id: newId, code, name: src.name });
      await mirrorAudit({
        at: now,
        actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
        action: 'partner.copy',
        subject: { type: 'partner', id: newId, code },
        company_id: input.targetCompanyId,
        diff_fields: { source_company_id: input.sourceCompanyId, source_partner_id: id, source_code: src.code },
        request_id: input.requestId ?? null,
        ip: input.ip ?? null,
      });
    }
  } catch (err) {
    // Đã tạo một phần ⇒ GHI phần đã tạo (replay không tạo đôi); chưa tạo gì ⇒ nhả khoá để gửi lại.
    if (claim) {
      if (created.length) await completeClaim(claim, { created, warnings });
      else await releaseClaim(claim);
    }
    throw err;
  }
  if (claim) await completeClaim(claim, { created, warnings });
  return { created, warnings, replayed: false };
}

/* ================================================================== *
 * Kiểm trùng trước khi lưu (chỉ đọc, không chặn)
 * ================================================================== */

/** Đối tác trùng tên / (ngân hàng, STK) với đối tác khác trong công ty — popup gọi khi đang gõ. */
export async function checkPartnerDuplicates(input: {
  companyId: string;
  name: string;
  bank_name?: string | null;
  account_number?: string | null;
  exclude_id?: string | null;
}): Promise<DuplicateHit[]> {
  return findDuplicatePartners({
    companyId: input.companyId,
    name: input.name,
    bank_name: input.bank_name ?? null,
    account_number: input.account_number ?? null,
    exclude_id: input.exclude_id ?? null,
  });
}

/* ================================================================== *
 * Đọc: danh sách có tóm tắt, chi tiết, các tab
 * ================================================================== */

export interface PartnerSummaryView {
  _id: string;
  code: string;
  type: PartnerType;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  tax_code: string | null;
  status: 'active' | 'inactive';
  company_id: string;
  company_name: string | null;
  note: string | null;
  receivable_remaining: ReturnType<typeof moneyWireOf>;
  payable_remaining: ReturnType<typeof moneyWireOf>;
  overdue_amount: ReturnType<typeof moneyWireOf>;
  outstanding: ReturnType<typeof moneyWireOf>;
  next_maturity_date: string | null;
  paid_in_period: ReturnType<typeof moneyWireOf>;
  paid_out_period: ReturnType<typeof moneyWireOf>;
  has_activity: boolean;
  updated_at: string;
}

async function companyNamesOf(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids)].filter((x) => OBJECT_ID_RE.test(x));
  if (!uniq.length) return new Map();
  const rows = await Models.Company.find({ _id: { $in: uniq } } as never).select({ name: 1 }).lean<{ _id: unknown; name?: string }[]>();
  return new Map(rows.map((r) => [idOf(r._id), String(r.name ?? '')] as const));
}

/** Số liệu tóm tắt; nhóm không đủ quyền xem (`visible`) ⇒ null (không rò rỉ). */
function summaryOf(
  p: PartnerLean,
  ledger: PartnerLedger,
  period: Period,
  today: string,
  companyName: string | null,
  visible: SummaryVisibility,
): PartnerSummaryView {
  const n = numbersOf(p.type, ledger, period, today);
  return {
    _id: idOf(p._id),
    code: p.code,
    type: p.type,
    name: p.name,
    bank_name: p.bank_name ?? null,
    account_number: p.account_number ?? null,
    tax_code: p.tax_code ?? null,
    status: p.status,
    company_id: idOf(p.company_id),
    company_name: companyName,
    note: p.note ?? null,
    receivable_remaining: visible.debt ? moneyWireOf(n.receivable_remaining) : null,
    payable_remaining: visible.debt ? moneyWireOf(n.payable_remaining) : null,
    overdue_amount: visible.debt ? moneyWireOf(n.overdue_amount) : null,
    outstanding: visible.loan ? moneyWireOf(n.outstanding) : null,
    next_maturity_date: visible.loan ? n.next_maturity_date : null,
    paid_in_period: visible.cash ? moneyWireOf(n.paid_in_period) : null,
    paid_out_period: visible.cash ? moneyWireOf(n.paid_out_period) : null,
    has_activity: n.has_activity,
    updated_at: (p.updated_at ?? p.created_at ?? new Date(0)).toISOString(),
  };
}

export interface PartnerListInput {
  companyIds: string[] | null;
  type?: PartnerType[];
  status?: 'active' | 'inactive' | 'all';
  q?: string;
  limit: number;
  offset: number;
  period?: Period;
  /** quyền xem số liệu công nợ / khoản vay / thu chi của người gọi */
  visible: SummaryVisibility;
}

export async function listPartners(input: PartnerListInput): Promise<{
  items: PartnerSummaryView[];
  total: number;
  limit: number;
  offset: number;
  period: Period;
}> {
  const filter = partnerFilter(input);
  const today = vnDate();
  const period = input.period ?? defaultPeriod(today);
  const [total, rows] = await Promise.all([
    Models.Partner.countDocuments(filter as never).exec(),
    Models.Partner.find(filter as never)
      .sort({ name_key: 1, _id: 1 })
      .skip(input.offset)
      .limit(input.limit)
      .lean<PartnerLean[]>(),
  ]);
  const ledgers = await loadPartnerLedgers(rows.map(toLedgerPartner));
  const names = await companyNamesOf(rows.map((r) => idOf(r.company_id)));
  const items = rows.map((r) =>
    summaryOf(r, ledgers.get(idOf(r._id)) ?? { debts: [], loans: [], paid: [], has_activity: false }, period, today, names.get(idOf(r.company_id)) ?? null, input.visible),
  );
  return { items, total, limit: input.limit, offset: input.offset, period };
}

function toLedgerPartner(p: PartnerLean): LedgerPartner {
  return { _id: idOf(p._id), company_id: idOf(p.company_id), type: p.type };
}

/** Điều kiện lọc chung: công ty (null = toàn tập đoàn), loại, trạng thái, từ khoá (tên / STK / MST). */
function partnerFilter(input: { companyIds: string[] | null; type?: PartnerType[]; status?: 'active' | 'inactive' | 'all'; q?: string }): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (input.companyIds !== null) filter.company_id = { $in: input.companyIds };
  if (input.type?.length) filter.type = { $in: input.type };
  if (input.status && input.status !== 'all') filter.status = input.status;
  const q = input.q?.trim();
  if (q) {
    const rx = { $regex: escapeRegex(q), $options: 'i' };
    // STK / MST: gõ có hoặc không có dấu cách / gạch / chấm đều tìm thấy (cùng quy tắc với cảnh báo trùng §5.1).
    // Chữ gõ không còn ký tự nào sau chuẩn hoá (vd. chỉ dấu gạch) ⇒ giữ nguyên khớp chuỗi thường.
    const idPattern = identifierSearchPattern(q);
    const idRx = idPattern ? { $regex: idPattern, $options: 'i' } : rx;
    filter.$or = [{ name: rx }, { account_number: idRx }, { tax_code: idRx }];
  }
  return filter;
}

export interface PartnerRefView {
  _id: string;
  code: string;
  type: PartnerType;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  tax_code: string | null;
  status: 'active' | 'inactive';
}

export function partnerRefOf(p: PartnerLean): PartnerRefView {
  return {
    _id: idOf(p._id),
    code: p.code,
    type: p.type,
    name: p.name,
    bank_name: p.bank_name ?? null,
    account_number: p.account_number ?? null,
    tax_code: p.tax_code ?? null,
    status: p.status,
  };
}

/** Ô chọn đối tác (tìm theo tên / STK / MST, lọc loại). Mặc định chỉ đối tác đang hoạt động. */
export async function partnerOptions(input: {
  companyIds: string[] | null;
  type?: PartnerType[];
  status?: 'active' | 'inactive';
  q?: string;
  limit: number;
  /** Tra đúng các mã (khớp chính xác) — không áp trần `limit`: số bản ghi tối đa = số mã. */
  codes?: string[];
}): Promise<PartnerRefView[]> {
  const filter = partnerFilter({ ...input, status: input.status ?? 'active' });
  if (input.codes) filter.code = { $in: input.codes };
  const limit = input.codes ? Math.max(1, input.codes.length) : input.limit;
  const rows = await Models.Partner.find(filter as never).sort({ name_key: 1 }).limit(limit).lean<PartnerLean[]>();
  return rows.map(partnerRefOf);
}

/** Chi tiết: tóm tắt + lịch sử (mới nhất trước). */
export async function partnerDetail(
  id: string,
  scopeCompanyIds: string[] | null,
  visible: SummaryVisibility,
): Promise<PartnerSummaryView & { history: unknown[] }> {
  const p = await loadPartner(id);
  assertPartnerInScope(p.company_id, scopeCompanyIds);
  const today = vnDate();
  const ledgers = await loadPartnerLedgers([toLedgerPartner(p)]);
  const names = await companyNamesOf([idOf(p.company_id)]);
  const summary = summaryOf(
    p,
    ledgers.get(id) ?? { debts: [], loans: [], paid: [], has_activity: false },
    defaultPeriod(today),
    today,
    names.get(idOf(p.company_id)) ?? null,
    visible,
  );
  return { ...summary, history: historyOf(p) };
}

export function historyOf(p: PartnerLean): { at: string; actor: { user_id: string | null; name: string | null }; changes: Record<string, unknown> }[] {
  return [...(p.history ?? [])]
    .map((h) => ({
      at: new Date(h.at).toISOString(),
      actor: { user_id: h.actor?.user_id ? idOf(h.actor.user_id) : null, name: h.actor?.name ?? null },
      changes: (h.changes ?? {}) as Record<string, unknown>,
    }))
    .reverse();
}

/** Tab "Công nợ": các khoản KH/NCC của đối tác (còn dư + đã cấn trừ + quá hạn), tiền dạng wire. */
export async function partnerDebts(p: PartnerLean): Promise<DebtOut[]> {
  const ledgers = await loadPartnerLedgers([toLedgerPartner(p)]);
  const ledger = ledgers.get(idOf(p._id));
  return (ledger?.debts ?? [])
    .map(debtOutOf)
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
}

export interface DebtOut {
  _id: string;
  code: string;
  company_id: string;
  direction: 'receivable' | 'payable';
  account_code: string | null;
  side: string | null;
  contract_code: string | null;
  priority: string | null;
  value: ReturnType<typeof moneyWireOf>;
  applied: ReturnType<typeof moneyWireOf>;
  remaining: ReturnType<typeof moneyWireOf>;
  /** còn có thể trả (trừ phần đã giữ chỗ bởi phiếu chưa huỷ) — giới hạn của "Trả nợ" */
  available: ReturnType<typeof moneyWireOf>;
  due_date: string;
  overdue_days: number;
  status: 'open' | 'partial' | 'settled';
}

function debtOutOf(d: DebtView): DebtOut {
  return {
    _id: d._id,
    code: d.code,
    company_id: d.company_id,
    direction: d.direction,
    account_code: d.account_code,
    side: d.side,
    contract_code: d.contract_code,
    priority: d.priority,
    value: moneyWireOf(d.value),
    applied: moneyWireOf(d.applied),
    remaining: moneyWireOf(d.remaining),
    available: moneyWireOf(d.available),
    due_date: d.due_date,
    overdue_days: d.overdue_days,
    status: d.remaining === 0n ? 'settled' : d.applied > 0n ? 'partial' : 'open',
  };
}

/** Tab "Phiếu thu/chi": phiếu có `partner_id` = đối tác (cùng công ty), mới nhất trước. */
export async function partnerDocuments(p: PartnerLean, q: { status?: string; kind?: 'spend' | 'income'; limit: number }): Promise<DocumentRowOut[]> {
  const filter: Record<string, unknown> = { company_id: p.company_id, partner_id: p._id };
  if (q.status) filter.status = q.status;
  if (q.kind) filter.kind = q.kind;
  const rows = await Models.Document.find(filter as never)
    .sort({ business_date: -1, _id: -1 })
    .limit(q.limit)
    .select({ code: 1, kind: 1, status: 1, title: 1, business_date: 1, planned_date: 1, amount: 1, execution: 1, tag_ids: 1 })
    .lean<
      {
        _id: unknown;
        code?: string;
        kind: string;
        status?: string;
        title?: string;
        business_date?: string;
        planned_date?: string;
        amount?: { minor?: unknown; currency?: string | null } | null;
        execution?: { paid_at?: string | null } | null;
        tag_ids?: unknown[];
      }[]
    >();
  return rows.map((d) => ({
    _id: idOf(d._id),
    code: String(d.code ?? ''),
    kind: d.kind === 'income' ? 'income' : 'spend',
    status: String(d.status ?? ''),
    title: String(d.title ?? ''),
    business_date: d.business_date ?? null,
    planned_date: d.planned_date ?? null,
    amount: moneyOf(toBig(d.amount?.minor), d.amount?.currency ?? 'VND'),
    paid_at: d.execution?.paid_at ?? null,
    tag_ids: (d.tag_ids ?? []).map((t) => idOf(t)),
  }));
}

export interface DocumentRowOut {
  _id: string;
  code: string;
  kind: 'spend' | 'income';
  status: string;
  title: string;
  business_date: string | null;
  planned_date: string | null;
  amount: { minor: string; currency: string; decimals: number };
  paid_at: string | null;
  tag_ids: string[];
}

/** Tab "Nợ ngân hàng": các khoản vay của đối tác ngân hàng, kèm mức cảnh báo đáo hạn. */
export async function partnerLoans(p: PartnerLean): Promise<ReturnType<typeof loanViewOf>[]> {
  const ledgers = await loadPartnerLedgers([toLedgerPartner(p)]);
  const ledger = ledgers.get(idOf(p._id));
  return (ledger?.loans ?? []).map(loanViewOf).sort((a, b) => (a.maturity_date < b.maturity_date ? -1 : a.maturity_date > b.maturity_date ? 1 : 0));
}

function loanViewOf(l: LoanView) {
  const m = maturityInfo(l.maturity_date);
  return {
    _id: l._id,
    code: l.code,
    company_id: l.company_id,
    status: l.status,
    principal: moneyWireOf(l.principal),
    repaid_principal: moneyWireOf(l.repaid),
    outstanding: moneyWireOf(l.outstanding),
    /** gốc còn có thể trả — giới hạn của "Trả nợ" (0 nếu không ở trạng thái đang vay / quá hạn) */
    available_principal: moneyWireOf(l.available_principal),
    maturity_date: l.maturity_date,
    days_to_maturity: m.days,
    maturity_level: m.level,
    maturity_tone: m.tone,
    maturity_bucket: m.bucket,
    disbursed_at: l.disbursed_at ? l.disbursed_at.toISOString() : null,
    interest_rate: l.interest_rate,
    term_months: l.term_months,
    repayment_method: l.repayment_method,
    payment_frequency: l.payment_frequency,
  };
}

/** Nhãn loại (tiếng Việt) cho thông báo. */
export function partnerTypeLabel(t: PartnerType): string {
  return PARTNER_TYPE_LABEL[t] ?? t;
}

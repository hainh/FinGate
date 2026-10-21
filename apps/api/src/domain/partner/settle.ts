/**
 * "Trả nợ" theo đối tác (v2/v2.md §5.2–5.3, §9.2, §10.3).
 *
 * - KH / NCC: chọn các khoản công nợ + số tiền phân bổ →
 *     khoản PHẢI THU → một phiếu THU nháp, liên kết `offset` (phiếu → khoản);
 *     khoản PHẢI TRẢ  → một phiếu CHI nháp, liên kết `offset`;
 *   (cả hai hướng ⇒ hai phiếu). Liên kết tạo ở trạng thái hiệu lực, chỉ tính khi phiếu được thực thi.
 * - Ngân hàng: chọn các khoản vay + số tiền (có thể tách gốc / lãi / phí) → một phiếu CHI nháp,
 *   liên kết `repayment` tới từng khoản vay.
 *
 * Quy trình: (1) PLAN thuần — kiểm loại / trạng thái / thuộc đối tác / sức chứa, không ghi gì;
 * (2) tạo phiếu nháp qua `createDraftVoucher`; (3) tạo liên kết qua `createLink` (đúng quy tắc
 * liên kết). Nếu bước (2)/(3) lỗi giữa chừng: gỡ các liên kết vừa tạo và xoá các phiếu NHÁP vừa tạo
 * (chưa có tiền, chưa ai thấy) rồi ném lại lỗi — không có transaction (ADR-03). Việc gỡ KHÔNG hết
 * được báo cho kế toán trưởng (cảnh báo), không nuốt lỗi im lặng.
 *
 * Chống bấm đúp: `request_id` ⇒ khoá `request_claims` (domain/partner/claims.ts). Lần gọi lặp lại với
 * cùng `request_id` sau khi thành công trả về đúng các phiếu đã tạo (replayed = true), không tạo thêm;
 * lỗi ⇒ nhả khoá để sửa và gửi lại cùng `request_id`.
 */

import { ApiError, PARTNER_TYPE_LABEL, type PartnerType, vnDate } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { raiseAlert } from '../alerts/index.ts';
import { assertAccountAllowedForCompany } from '../accounts.ts';
import { mirrorAudit } from '../audit/index.ts';
import {
  allocationOf,
  createLink,
  principalPartOf,
  removeLink,
  reservingLinks,
  toBig,
  toLinkRecord,
  type LinkRecord,
  type LinkSplit,
} from '../links/index.ts';
import { acquireClaim, claimKeyOf, completeClaim, releaseClaim, type ClaimHandle } from './claims.ts';
import { resolveDebtDirection, type DebtDirection } from './summary.ts';
import { createDraftVoucher, type CreatedDraft, type DraftActor } from './voucher-draft.ts';

/** Khoản vay còn nhận trả nợ (đang vay / quá hạn). Chờ giải ngân, đã huỷ, đã tất toán, lưu trữ: không. */
export const SETTLEABLE_LOAN_STATUSES: readonly string[] = ['active', 'overdue'];

export interface SettlePartnerFact {
  _id: string;
  company_id: string;
  type: PartnerType;
  status: string;
  name: string;
}

export interface SettleDebtFact {
  _id: string;
  code: string;
  company_id: string;
  partner_id: string | null;
  direction: DebtDirection;
  /** giá trị khoản công nợ */
  value: bigint;
  /** đã phân bổ (mọi liên kết còn GIỮ sức chứa — phiếu chưa thực thi tính, phiếu huỷ / từ chối không tính) — dùng cho sức chứa */
  committed: bigint;
}

export interface SettleLoanFact {
  _id: string;
  code: string;
  company_id: string;
  partner_id: string | null;
  status: string | null;
  principal: bigint;
  /** đã phân bổ phần GỐC (mọi liên kết còn GIỮ sức chứa) — dùng cho sức chứa */
  committed_principal: bigint;
}

export interface SettleDebtItem {
  id: string;
  amount: bigint;
}

export interface SettleLoanItem {
  id: string;
  amount: bigint;
  split: LinkSplit | null;
}

export interface SettleAllocation {
  relation: 'offset' | 'repayment';
  target_type: 'debt_voucher' | 'bank_debt';
  target_id: string;
  target_code: string;
  amount: bigint;
  split: LinkSplit | null;
}

export interface SettlePlan {
  /** khoản phải thu → phiếu thu nháp */
  receivable: SettleAllocation[];
  /** khoản phải trả → phiếu chi nháp */
  payable: SettleAllocation[];
  /** khoản vay → phiếu chi nháp */
  loans: SettleAllocation[];
}

/** Ném lỗi nghiệp vụ (khai báo `never` để TypeScript thu hẹp kiểu sau mỗi lệnh kiểm tra). */
function fail(code: 'FG-PARTNER-001' | 'FG-VAL-001' | 'FG-LINK-002', detail: string, errors?: Record<string, string>): never {
  throw new ApiError({ code, detail, errors });
}

/** Số tiền gốc/lãi/phí của một liên kết tách: tổng phải bằng số tiền phân bổ. */
function checkSplit(split: LinkSplit, amount: bigint, code: string): void {
  if (split.principal + split.interest + split.fee !== amount) {
    fail('FG-VAL-001', `Tổng gốc + lãi + phí của ${code} phải bằng số tiền phân bổ`, { split: 'Tổng không khớp' });
  }
}

/**
 * PLAN thuần: kiểm tra toàn bộ điều kiện trước khi ghi gì. Ném ApiError nếu sai.
 * - Đối tác đang hoạt động; loại Ngân hàng chỉ trả bằng khoản vay, KH/NCC chỉ trả bằng công nợ.
 * - Mỗi khoản một lần; số tiền > 0; khoản thuộc đúng đối tác và đúng công ty.
 * - Sức chứa: công nợ ≤ giá trị − đã phân bổ; khoản vay ≤ gốc − gốc đã phân bổ (cùng quy tắc `createLink`).
 * - Khoản vay phải đang vay / quá hạn.
 */
export function planSettlement(
  partner: SettlePartnerFact,
  debtItems: readonly SettleDebtItem[],
  loanItems: readonly SettleLoanItem[],
  debts: readonly SettleDebtFact[],
  loans: readonly SettleLoanFact[],
): SettlePlan {
  const label = PARTNER_TYPE_LABEL[partner.type] ?? partner.type;
  if (partner.status !== 'active') fail('FG-PARTNER-001', 'Đối tác đã ngừng giao dịch — không trả nợ');
  if (debtItems.length + loanItems.length === 0) fail('FG-VAL-001', 'Chọn ít nhất một khoản để trả', { items: 'Chưa chọn khoản nào' });
  if (partner.type === 'bank' && debtItems.length) fail('FG-PARTNER-001', `${label} chỉ trả nợ bằng khoản vay ngân hàng`);
  if (partner.type !== 'bank' && loanItems.length) fail('FG-PARTNER-001', `${label} không có khoản vay ngân hàng để trả`);

  const debtIds = debtItems.map((i) => i.id);
  const loanIds = loanItems.map((i) => i.id);
  if (new Set(debtIds).size !== debtIds.length || new Set(loanIds).size !== loanIds.length) {
    fail('FG-VAL-001', 'Mỗi khoản chỉ chọn một lần', { items: 'Khoản bị chọn trùng' });
  }

  const debtById = new Map(debts.map((d) => [d._id, d] as const));
  const loanById = new Map(loans.map((l) => [l._id, l] as const));
  const plan: SettlePlan = { receivable: [], payable: [], loans: [] };

  for (const item of debtItems) {
    if (item.amount <= 0n) fail('FG-VAL-001', 'Số tiền trả phải lớn hơn 0', { amount_minor: 'Số tiền không hợp lệ' });
    const d = debtById.get(item.id);
    if (!d) fail('FG-PARTNER-001', 'Không tìm thấy khoản công nợ đã chọn');
    if (d.partner_id !== partner._id || d.company_id !== partner.company_id) {
      fail('FG-PARTNER-001', `Khoản ${d.code} không thuộc đối tác này`);
    }
    const capacity = d.value > d.committed ? d.value - d.committed : 0n;
    if (item.amount > capacity) {
      fail('FG-LINK-002', `Khoản ${d.code} chỉ còn ${capacity.toString()} để trả, không đủ cho ${item.amount.toString()}`);
    }
    const alloc: SettleAllocation = {
      relation: 'offset',
      target_type: 'debt_voucher',
      target_id: d._id,
      target_code: d.code,
      amount: item.amount,
      split: null,
    };
    if (d.direction === 'receivable') plan.receivable.push(alloc);
    else plan.payable.push(alloc);
  }

  for (const item of loanItems) {
    if (item.amount <= 0n) fail('FG-VAL-001', 'Số tiền trả phải lớn hơn 0', { amount_minor: 'Số tiền không hợp lệ' });
    const l = loanById.get(item.id);
    if (!l) fail('FG-PARTNER-001', 'Không tìm thấy khoản vay đã chọn');
    if (l.partner_id !== partner._id || l.company_id !== partner.company_id) {
      fail('FG-PARTNER-001', `Khoản vay ${l.code} không thuộc ngân hàng này`);
    }
    if (!l.status || !SETTLEABLE_LOAN_STATUSES.includes(l.status)) {
      fail('FG-PARTNER-001', `Khoản vay ${l.code} không ở trạng thái đang vay — không trả nợ được`);
    }
    if (item.split) checkSplit(item.split, item.amount, l.code);
    const add = item.split ? item.split.principal : item.amount;
    const capacity = l.principal > l.committed_principal ? l.principal - l.committed_principal : 0n;
    if (add > capacity) {
      fail('FG-LINK-002', `Khoản vay ${l.code} chỉ còn ${capacity.toString()} gốc chưa trả, không đủ cho ${add.toString()}`);
    }
    plan.loans.push({
      relation: 'repayment',
      target_type: 'bank_debt',
      target_id: l._id,
      target_code: l.code,
      amount: item.amount,
      split: item.split,
    });
  }
  return plan;
}

/** Tổng số tiền một nhóm phân bổ. */
export function totalOf(allocs: readonly SettleAllocation[]): bigint {
  return allocs.reduce((s, a) => s + a.amount, 0n);
}

/* ================================================================== *
 * Thực thi
 * ================================================================== */

export interface SettleCommand {
  partnerId: string;
  items: { debt_voucher_id: string; amount_minor: string }[];
  loans: { bank_debt_id: string; amount_minor: string; split?: { principal: string; interest: string; fee: string } | null }[];
  business_date?: string | null;
  planned_date?: string | null;
  receipt_account_id?: string | null;
  payment_account_id?: string | null;
  note?: string | null;
  request_id?: string | null;
}

export interface SettleContext {
  actor: DraftActor & { user_id: string };
  /** phạm vi công ty của người gọi (null = toàn tập đoàn) */
  scopeCompanyIds: string[] | null;
  ip?: string | null;
}

export interface SettledVoucher {
  document_id: string;
  code: string;
  kind: 'income' | 'spend';
  /** trạng thái HIỆN TẠI của phiếu (lúc tạo: `draft`; khi replay: trạng thái mới nhất) */
  status: string;
  amount_minor: string;
  title: string;
  links: { link_id: string; relation: string; to_type: string; to_id: string; amount_minor: string | null }[];
}

export interface SettleResult {
  partner_id: string;
  replayed: boolean;
  vouchers: SettledVoucher[];
}

interface Group {
  kind: 'income' | 'spend';
  allocations: SettleAllocation[];
  title: string;
  purpose: string;
  accountId: string | null;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function groupsOf(plan: SettlePlan, partnerName: string, cmd: SettleCommand): Group[] {
  const groups: Group[] = [];
  if (plan.receivable.length) {
    const codes = plan.receivable.map((a) => a.target_code).join(', ');
    groups.push({
      kind: 'income',
      allocations: plan.receivable,
      title: clip(`Thu nợ phải thu — ${partnerName}`, 200),
      purpose: clip(`Cấn trừ công nợ phải thu: ${codes}`, 2000),
      accountId: cmd.receipt_account_id ?? null,
    });
  }
  if (plan.payable.length) {
    const codes = plan.payable.map((a) => a.target_code).join(', ');
    groups.push({
      kind: 'spend',
      allocations: plan.payable,
      title: clip(`Trả nợ phải trả — ${partnerName}`, 200),
      purpose: clip(`Cấn trừ công nợ phải trả: ${codes}`, 2000),
      accountId: cmd.payment_account_id ?? null,
    });
  }
  if (plan.loans.length) {
    const codes = plan.loans.map((a) => a.target_code).join(', ');
    groups.push({
      kind: 'spend',
      allocations: plan.loans,
      title: clip(`Trả nợ vay — ${partnerName}`, 200),
      purpose: clip(`Trả gốc / lãi khoản vay: ${codes}`, 2000),
      accountId: cmd.payment_account_id ?? null,
    });
  }
  return groups;
}

/**
 * Tổng `committed` (sức chứa) của công nợ / khoản vay: liên kết còn GIỮ sức chứa trong `business_links`
 * (phiếu nguồn không huỷ / từ chối / hết hạn — v2 §9.2: huỷ phiếu ⇒ số còn lại tính lại ngay).
 */
async function committedFor(companyIds: string[], debtIds: string[], loanIds: string[]): Promise<{
  debtCommitted: Map<string, bigint>;
  loanCommitted: Map<string, bigint>;
}> {
  const [offsetRaw, repayRaw] = await Promise.all([
    debtIds.length
      ? Models.BusinessLink.find({ company_id: { $in: companyIds }, status: 'active', relation: 'offset', to_type: 'debt_voucher', to_id: { $in: debtIds } } as never).lean<Parameters<typeof toLinkRecord>[0][]>()
      : Promise.resolve([] as Parameters<typeof toLinkRecord>[0][]),
    loanIds.length
      ? Models.BusinessLink.find({ company_id: { $in: companyIds }, status: 'active', relation: 'repayment', to_type: 'bank_debt', to_id: { $in: loanIds } } as never).lean<Parameters<typeof toLinkRecord>[0][]>()
      : Promise.resolve([] as Parameters<typeof toLinkRecord>[0][]),
  ]);
  const offset: LinkRecord[] = await reservingLinks(offsetRaw.map(toLinkRecord));
  const repay: LinkRecord[] = await reservingLinks(repayRaw.map(toLinkRecord));
  const debtCommitted = new Map<string, bigint>();
  for (const l of offset) debtCommitted.set(l.to_id, (debtCommitted.get(l.to_id) ?? 0n) + allocationOf(l));
  const loanCommitted = new Map<string, bigint>();
  for (const l of repay) loanCommitted.set(l.to_id, (loanCommitted.get(l.to_id) ?? 0n) + principalPartOf(l));
  return { debtCommitted, loanCommitted };
}

/** Gỡ MỘT liên kết khi hoàn tác: thử hai lần; đã gỡ từ trước thì coi là xong. Trả false nếu không gỡ được. */
async function undoLink(linkId: string, ctx: SettleContext): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await removeLink({
        link_id: linkId,
        reason: 'Hoàn tác: trả nợ không hoàn tất',
        actor: { user_id: ctx.actor.user_id, name: ctx.actor.name ?? null, role: ctx.actor.role ?? null },
        scopeCompanyIds: ctx.scopeCompanyIds,
        ip: ctx.ip ?? null,
      });
      return true;
    } catch (err) {
      const current = await Models.BusinessLink.findById(linkId).select({ status: 1 }).lean<{ status?: string } | null>();
      if (current?.status === 'removed') return true;
      if (attempt === 2) console.error(`[partner.settle] không gỡ được liên kết ${linkId}: ${(err as Error).message}`);
    }
  }
  return false;
}

/**
 * Hoàn tác khi trả nợ lỗi giữa chừng: (1) gỡ từng liên kết vừa tạo; (2) chỉ xoá phiếu NHÁP mà mọi liên kết
 * của nó đã gỡ được; (3) phần KHÔNG hoàn tác được ⇒ cảnh báo cho kế toán trưởng (không nuốt lỗi).
 */
async function rollback(
  links: LinkRecord[],
  docIds: string[],
  ctx: SettleContext,
  partner: { id: string; name: string; companyId: string },
  claimKey: string | null,
): Promise<void> {
  const stuckLinks: string[] = [];
  const keptDocs = new Set<string>();
  for (const l of [...links].reverse()) {
    if (!(await undoLink(l._id, ctx))) {
      stuckLinks.push(l._id);
      keptDocs.add(l.from_id);
    }
  }
  const stuckDocs: string[] = [];
  for (const id of docIds) {
    if (keptDocs.has(id)) {
      stuckDocs.push(id); // còn liên kết hiệu lực trỏ tới phiếu ⇒ giữ phiếu nháp để kế toán thấy và gỡ
      continue;
    }
    // chỉ xoá phiếu NHÁP vừa tạo trong lượt này — chưa có tiền, chưa được gửi duyệt
    const res = await Models.Document.deleteOne({ _id: id, status: 'draft' } as never)
      .exec()
      .catch((err: unknown) => {
        console.error(`[partner.settle] không xoá được phiếu nháp ${id}: ${(err as Error).message}`);
        return null;
      });
    if (!res || res.deletedCount === 0) stuckDocs.push(id);
  }
  if (stuckLinks.length || stuckDocs.length) {
    await raiseAlert({
      alert_type: 'partner_settle_rollback_failed',
      company_id: partner.companyId,
      severity: 3,
      text: `Trả nợ ${partner.name} hoàn tác chưa hết: ${stuckLinks.length} liên kết và ${stuckDocs.length} phiếu nháp còn lại — kế toán trưởng kiểm tra và gỡ thủ công`,
      href: `/doi-tac/${partner.id}`,
      dedupe_key: `partner_settle_rollback:${claimKey ?? `${partner.id}:${Date.now()}`}`,
      subject: { partner_id: partner.id, link_ids: stuckLinks, document_ids: stuckDocs },
    });
  }
}

interface DocRow {
  _id: unknown;
  code?: string;
  kind: string;
  status?: string;
  amount?: { minor?: unknown };
  title?: string;
}

/** Dựng kết quả từ các phiếu đã tạo (replay theo request_id): trạng thái và liên kết lấy MỚI NHẤT từ DB. */
async function replayResult(partnerId: string, companyId: string, documentIds: string[]): Promise<SettleResult> {
  const rows = documentIds.length
    ? await Models.Document.find({ _id: { $in: documentIds }, company_id: companyId } as never)
        .select({ code: 1, kind: 1, status: 1, amount: 1, title: 1 })
        .lean<DocRow[]>()
    : [];
  const order = new Map(documentIds.map((id, i) => [id, i] as const));
  const docs = [...rows].sort((a, b) => (order.get(String(a._id)) ?? 0) - (order.get(String(b._id)) ?? 0));
  const ids = docs.map((d) => String(d._id));
  const links = ids.length
    ? await Models.BusinessLink.find({ company_id: companyId, from_id: { $in: ids }, status: 'active' } as never).lean<Parameters<typeof toLinkRecord>[0][]>()
    : [];
  return {
    partner_id: partnerId,
    replayed: true,
    vouchers: docs.map((d) => ({
      document_id: String(d._id),
      code: String(d.code ?? ''),
      kind: d.kind === 'income' ? 'income' : 'spend',
      status: String(d.status ?? ''),
      amount_minor: toBig(d.amount?.minor).toString(),
      title: String(d.title ?? ''),
      links: links
        .filter((l) => String(l.from_id) === String(d._id))
        .map((l) => ({
          link_id: String(l._id),
          relation: String(l.relation),
          to_type: String(l.to_type),
          to_id: String(l.to_id),
          amount_minor: l.amount_minor === null || l.amount_minor === undefined ? null : toBig(l.amount_minor).toString(),
        })),
    })),
  };
}

export async function settlePartner(cmd: SettleCommand, ctx: SettleContext): Promise<SettleResult> {
  const partner = await Models.Partner.findById(cmd.partnerId).lean<{
    _id: unknown;
    company_id: unknown;
    type: PartnerType;
    status: string;
    name: string;
    code: string;
  } | null>();
  if (!partner) throw new ApiError({ code: 'FG-VAL-001', status: 404, detail: 'Không tìm thấy đối tác' });
  const companyId = String(partner.company_id);
  if (ctx.scopeCompanyIds !== null && !ctx.scopeCompanyIds.includes(companyId)) {
    throw new ApiError({ code: 'FG-RBAC-002' });
  }
  const partnerId = String(partner._id);

  // Chống bấm đúp: giành khoá theo request_id TRƯỚC khi ghi. Lặp lại sau khi xong ⇒ trả lại đúng các phiếu cũ.
  let claim: ClaimHandle | null = null;
  const claimKey = cmd.request_id ? claimKeyOf('partner.settle', `${companyId}:${partnerId}`, cmd.request_id) : null;
  if (claimKey) {
    const outcome = await acquireClaim<{ document_ids: string[] }>(claimKey, 'partner.settle', companyId);
    if (outcome.replayed) return replayResult(partnerId, companyId, outcome.result.document_ids);
    claim = outcome.handle;
  }

  try {
    const result = await settleOnce(cmd, ctx, { partnerId, companyId, partnerName: partner.name, partnerCode: partner.code, type: partner.type, status: partner.status }, claimKey);
    if (claim) await completeClaim(claim, { document_ids: result.vouchers.map((v) => v.document_id) });
    return result;
  } catch (err) {
    if (claim) await releaseClaim(claim);
    throw err;
  }
}

/** Thân trả nợ (sau khi đã giành khoá): PLAN → kiểm tài khoản → tạo phiếu nháp + liên kết → audit. */
async function settleOnce(
  cmd: SettleCommand,
  ctx: SettleContext,
  partner: { partnerId: string; companyId: string; partnerName: string; partnerCode: string; type: PartnerType; status: string },
  claimKey: string | null,
): Promise<SettleResult> {
  const { partnerId, companyId } = partner;
  const debtIds = cmd.items.map((i) => i.debt_voucher_id);
  const loanIds = cmd.loans.map((i) => i.bank_debt_id);
  const [debtRows, loanRows] = await Promise.all([
    debtIds.length
      ? Models.DebtVoucher.find({ _id: { $in: debtIds }, company_id: companyId } as never)
          .select({ code: 1, company_id: 1, partner_id: 1, direction: 1, side: 1, value_minor: 1 })
          .lean<{ _id: unknown; code?: string; company_id: unknown; partner_id?: unknown; direction?: string | null; side?: string | null; value_minor?: unknown }[]>()
      : Promise.resolve([]),
    loanIds.length
      ? Models.BankDebt.find({ _id: { $in: loanIds }, company_id: companyId } as never)
          .select({ code: 1, company_id: 1, partner_id: 1, status: 1, principal_minor: 1 })
          .lean<{ _id: unknown; code?: string; company_id: unknown; partner_id?: unknown; status?: string; principal_minor?: unknown }[]>()
      : Promise.resolve([]),
  ]);
  const capacity = await committedFor([companyId], debtIds, loanIds);

  const debts: SettleDebtFact[] = debtRows.map((d) => {
    const id = String(d._id);
    const committed = capacity.debtCommitted.get(id) ?? 0n;
    return {
      _id: id,
      code: String(d.code ?? id),
      company_id: String(d.company_id),
      partner_id: d.partner_id ? String(d.partner_id) : null,
      direction: resolveDebtDirection(d.direction, d.side),
      value: toBig(d.value_minor),
      committed,
    };
  });
  const loans: SettleLoanFact[] = loanRows.map((l) => {
    const id = String(l._id);
    const committed = capacity.loanCommitted.get(id) ?? 0n;
    return {
      _id: id,
      code: String(l.code ?? id),
      company_id: String(l.company_id),
      partner_id: l.partner_id ? String(l.partner_id) : null,
      status: l.status ?? null,
      principal: toBig(l.principal_minor),
      committed_principal: committed,
    };
  });

  const plan = planSettlement(
    { _id: partnerId, company_id: companyId, type: partner.type, status: partner.status, name: partner.partnerName },
    cmd.items.map((i) => ({ id: i.debt_voucher_id, amount: toBig(i.amount_minor) })),
    cmd.loans.map((i) => ({
      id: i.bank_debt_id,
      amount: toBig(i.amount_minor),
      split: i.split
        ? { principal: toBig(i.split.principal), interest: toBig(i.split.interest), fee: toBig(i.split.fee) }
        : null,
    })),
    debts,
    loans,
  );

  const groups = groupsOf(plan, partner.partnerName, cmd);
  for (const g of groups) {
    if (g.kind === 'income') await assertAccountAllowedForCompany(companyId, g.accountId, 'receipt_account_id');
    else await assertAccountAllowedForCompany(companyId, g.accountId, 'payment_account_id');
  }

  const today = vnDate();
  const businessDate = cmd.business_date ?? today;
  const plannedDate = cmd.planned_date ?? businessDate;
  const actor = { user_id: ctx.actor.user_id, name: ctx.actor.name ?? null, role: ctx.actor.role ?? null };
  const createdDocs: CreatedDraft[] = [];
  const createdLinks: LinkRecord[] = [];
  const linksByDoc = new Map<string, LinkRecord[]>();

  try {
    for (const g of groups) {
      const draft = await createDraftVoucher({
        kind: g.kind,
        company_id: companyId,
        partner_id: partnerId,
        title: g.title,
        purpose: g.purpose.length >= 3 ? g.purpose : `Trả nợ ${partner.partnerName}`,
        amount_minor: totalOf(g.allocations),
        account_id: g.accountId,
        business_date: businessDate,
        planned_date: plannedDate,
        note: cmd.note ?? null,
        request_id: cmd.request_id ?? null,
        ip: ctx.ip ?? null,
        actor: { user_id: ctx.actor.user_id, name: ctx.actor.name ?? null, role: ctx.actor.role ?? null, department_id: ctx.actor.department_id ?? null },
        via: 'partner_settle',
      });
      createdDocs.push(draft);
      linksByDoc.set(draft._id, []);
      for (const a of g.allocations) {
        const link = await createLink({
          from: { type: 'document', id: draft._id },
          to: { type: a.target_type, id: a.target_id },
          relation: a.relation,
          amount_minor: a.amount,
          split: a.split,
          note: 'Trả nợ từ màn Đối tác',
          origin: 'manual',
          actor,
          scopeCompanyIds: ctx.scopeCompanyIds,
          request_id: cmd.request_id ?? null,
          ip: ctx.ip ?? null,
        });
        createdLinks.push(link);
        linksByDoc.get(draft._id)?.push(link);
      }
    }
  } catch (err) {
    await rollback(createdLinks, createdDocs.map((d) => d._id), ctx, { id: partnerId, name: partner.partnerName, companyId }, claimKey);
    throw err;
  }

  await mirrorAudit({
    at: new Date(),
    actor,
    action: 'partner.settle',
    subject: { type: 'partner', id: partnerId, code: partner.partnerCode },
    company_id: companyId,
    diff_fields: {
      vouchers: createdDocs.map((d) => `${d.kind}:${d.code}`),
      links: createdLinks.length,
      amount_minor: createdDocs.map((d) => d.amount_minor.toString()),
    },
    request_id: cmd.request_id ?? null,
    ip: ctx.ip ?? null,
  });

  return {
    partner_id: partnerId,
    replayed: false,
    vouchers: createdDocs.map((d, i) => ({
      document_id: d._id,
      code: d.code,
      kind: d.kind,
      status: d.status,
      amount_minor: d.amount_minor.toString(),
      title: groups[i]?.title ?? '',
      links: (linksByDoc.get(d._id) ?? []).map((l) => ({
        link_id: l._id,
        relation: l.relation,
        to_type: l.to_type,
        to_id: l.to_id,
        amount_minor: l.amount_minor === null ? null : l.amount_minor.toString(),
      })),
    })),
  };
}

/**
 * Tham chiếu theo bản ghi của phiếu thu/chi v2 (v2/v2.md §5.2, §6.2, §11.4–11.6, §14.3 (0)).
 *
 * Hai việc:
 *  1. KIỂM & CHUẨN HOÁ khi ghi: đối tác, tag, tuỳ chọn vay, chuyển nội bộ — mọi truy vấn lọc theo công ty
 *     của phiếu. Quy tắc thuần nằm ở `rules.ts`.
 *  2. DỰNG phần tham chiếu khi đọc: đối tác (nạp sống từ ID), tag, tuỳ chọn vay, chuyển nội bộ, nguồn gốc,
 *     liên kết hai chiều, lượt tự động. Phiếu KHÔNG lưu bản sao thông tin đối tác.
 *
 * Partner/tag là danh bạ theo công ty; `domain/tags` hiện chỉ có chuẩn hoá tên, nên việc kiểm tra ID tag
 * làm trực tiếp trên collection `tags` theo `company_id`.
 */

import { ApiError, AUTOMATION_RULE_LABEL, formatMoney, money, type AutomationRuleCode } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import {
  allocationOf,
  assertDebtOffsetCapacity,
  assertDocumentFreeForNewLoan,
  assertLoanDisbursementCapacity,
  assertLoanRepaymentCapacity,
  documentAllocatedTotalOf,
  listLinksFor,
  removeLink,
  type LinkActor,
  type LinkRecord,
  type LinkObjectType,
} from '../links/index.ts';
import { ensureManualLink } from '../automation/actions/link.ts';
import { assertOffsetDirection, directionOf, isReadOnlyDebt } from '../debt/rules.ts';
import { bankAccountLabelOf } from '../queries/index.ts';
import { loanOpenForRepayment, offsetRuleLinksOf } from './offset.ts';
import { accountBorrowViewOf, type AccountBorrowView } from './account-borrow.ts';
import {
  assertAmountEditAllowed,
  assertLenderBank,
  assertTagSelection,
  assertTransferTargetAccount,
  assertTransferTargetFits,
  assertVoucherPartner,
  dedupeIds,
  effectiveLoanAmount,
  effectiveOffsetAmount,
  LOAN_ATTACHABLE_STATUSES,
  MAX_TAGS_PER_VOUCHER,
  offsetError,
  offsetLinkSpecOf,
  planLoanOptions,
  planOffsetOptions,
  sameOffsetPlan,
  storedOffsetToPlan,
  type LoanInput,
  type LoanKind,
  type LoanMode,
  type LoanPlan,
  type LoanTermsPlan,
  type OffsetInput,
  type OffsetPlan,
  type OffsetTarget,
  type PartnerFacts,
  type VoucherKind,
} from './rules.ts';

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined || v === '' ? null : String(v);
}

function iso(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* ================================================================== *
 * 1. Kiểm tra & chuẩn hoá khi ghi
 * ================================================================== */

/** Đối tác trong công ty (null nếu không có / khác công ty). */
export async function loadPartnerInCompany(companyId: string, partnerId: string): Promise<Record<string, unknown> | null> {
  if (!OBJECT_ID_RE.test(partnerId)) return null;
  return Models.Partner.findOne({ _id: partnerId, company_id: companyId } as never).lean<Record<string, unknown> | null>();
}

/**
 * Đối tác của phiếu. `requireActive` = true khi đây là LỰA CHỌN MỚI (tạo, hoặc đổi sang đối tác khác) —
 * đối tác đã ngừng giao dịch chỉ bị từ chối khi chọn mới (§5.1: dữ liệu cũ giữ nguyên).
 */
export async function resolveVoucherPartner(input: {
  companyId: string;
  partnerId: string;
  kind: VoucherKind;
  requireActive: boolean;
  loanKind: LoanKind | null;
}): Promise<Record<string, unknown>> {
  const partner = await loadPartnerInCompany(input.companyId, input.partnerId);
  assertVoucherPartner(partner as PartnerFacts | null, {
    companyId: input.companyId,
    loanKind: input.loanKind,
    requireActive: input.requireActive,
  });
  // đối tác "Công ty trong tập đoàn" chỉ dùng cho phiếu chi (chuyển nội bộ, §11.6)
  if (input.kind !== 'spend' && partner!.type === 'internal') {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Đối tác công ty trong tập đoàn chỉ dùng cho phiếu chi',
      errors: { partner_id: 'Đối tác công ty trong tập đoàn chỉ dùng cho phiếu chi' },
    });
  }
  return partner!;
}

/**
 * Tag gắn phiếu: phải thuộc công ty của phiếu; tag đã ẩn chỉ được GIỮ (đã có trên phiếu), không gắn thêm.
 * Trả về danh sách ID đã khử trùng, giữ thứ tự nhập.
 */
export async function resolveVoucherTagIds(input: {
  companyId: string;
  requested: readonly string[];
  previous: readonly string[];
}): Promise<string[]> {
  const ids = dedupeIds(input.requested);
  if (ids.length > MAX_TAGS_PER_VOUCHER) {
    throw new ApiError({ code: 'FG-VAL-001', detail: `Tối đa ${MAX_TAGS_PER_VOUCHER} tag cho một phiếu`, errors: { tag_ids: 'Quá nhiều tag' } });
  }
  if (ids.length === 0) return [];
  if (ids.some((id) => !OBJECT_ID_RE.test(id))) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Mã tag không hợp lệ', errors: { tag_ids: 'Mã tag không hợp lệ' } });
  }
  const rows = await Models.Tag.find({ company_id: input.companyId, _id: { $in: ids } } as never)
    .select({ hidden: 1 })
    .lean<{ _id: unknown; hidden?: boolean }[]>();
  assertTagSelection(
    ids,
    rows.map((r) => ({ id: String(r._id), hidden: Boolean(r.hidden) })),
    input.previous,
  );
  return ids;
}

/** Biểu diễn đã lưu của `options.loan` → kế hoạch (BigInt, chuỗi ID). */
export function storedLoanToPlan(stored: Record<string, unknown> | null | undefined): LoanPlan | null {
  if (!stored || !stored.kind) return null;
  const t = stored.terms as Record<string, unknown> | null | undefined;
  return {
    kind: String(stored.kind) as LoanKind,
    mode: (String(stored.mode ?? 'later') as LoanMode),
    lender_partner_id: strOrNull(stored.lender_partner_id),
    receive_account_id: strOrNull(stored.receive_account_id),
    amount_minor: stored.amount_minor === null || stored.amount_minor === undefined ? null : BigInt(String(stored.amount_minor)),
    existing_loan_id: strOrNull(stored.existing_loan_id),
    terms: t
      ? {
          contract_no: strOrNull(t.contract_no),
          interest_rate: strOrNull(t.interest_rate),
          term_months: t.term_months === null || t.term_months === undefined ? null : Number(t.term_months),
          due_date: strOrNull(t.due_date),
          repayment_period: strOrNull(t.repayment_period),
          repayment_method: strOrNull(t.repayment_method),
          collateral: strOrNull(t.collateral),
        }
      : null,
  };
}

/** Kế hoạch → đầu vào (chuỗi) để chạy lại kiểm tra khi phiếu đổi đối tác/số tiền. */
export function planToLoanInput(plan: LoanPlan): LoanInput {
  return {
    kind: plan.kind,
    mode: plan.mode,
    lender_partner_id: plan.lender_partner_id,
    receive_account_id: plan.receive_account_id,
    amount_minor: plan.amount_minor === null ? null : plan.amount_minor.toString(),
    existing_loan_id: plan.existing_loan_id,
    terms: plan.terms,
  };
}

/** Kế hoạch → subdocument `options.loan` để ghi (Mongoose ép chuỗi ID → ObjectId, BigInt giữ nguyên). */
export function planToStoredLoan(plan: LoanPlan | null): Record<string, unknown> | null {
  if (!plan) return null;
  return {
    kind: plan.kind,
    mode: plan.mode,
    lender_partner_id: plan.lender_partner_id,
    receive_account_id: plan.receive_account_id,
    amount_minor: plan.amount_minor,
    existing_loan_id: plan.existing_loan_id,
    terms: plan.terms,
  };
}

/**
 * "Gắn khoản vay đã có" (v2 §11.4 (b)): liên kết giải ngân do NGƯỜI DÙNG chọn được ghi NGAY khi lưu phiếu
 * (nguồn Thủ công), không phụ thuộc quy tắc R2 đang bật/tắt. Đồng bộ theo lựa chọn ĐÃ LƯU TRƯỚC (`previous`)
 * và lựa chọn MỚI (`plan`):
 *  - chọn khoản có sẵn L ⇒ mọi giải ngân của phiếu tới khoản khác L bị gỡ (có lý do); ghi / đồng bộ số tiền tới L;
 *  - không còn chọn khoản có sẵn (đổi sang "vay mới", "để sau", bỏ cờ vay) ⇒ gỡ liên kết Thủ công tới khoản có sẵn
 *    đã chọn trước đó, để khoản vay không còn bị chiếm sức chứa (R2-20/21/22). Liên kết gán tay từ tab Liên kết
 *    (không do lựa chọn này tạo ra) giữ nguyên.
 * Khoản "vay mới" do R2 (quy tắc tự động) tạo và đồng bộ như trước.
 */
/** Khoản có sẵn đang được chọn trên kế hoạch vay (null nếu không phải "vay — gắn khoản có sẵn"). */
function existingLoanIdOf(plan: LoanPlan | null | undefined): string | null {
  return plan?.kind === 'borrow' && plan.mode === 'existing' ? plan.existing_loan_id : null;
}

/**
 * Liên kết giải ngân mà lần lưu đổi lựa chọn khoản vay từ `previous` sang `next` sẽ GỠ (v2 §11.4 (b)):
 *  - chọn khoản có sẵn khác ⇒ gỡ mọi giải ngân tới khoản khác;
 *  - không chọn nữa ⇒ chỉ gỡ liên kết Thủ công tới khoản đã chọn trước đó.
 * Dùng chung cho việc gỡ thật (`linkChosenLoanOnSave`) và kiểm đổi đối tác (PATCH /documents/:id): liên kết sắp được gỡ
 * không được coi là "liên kết tới đối tác khác" (FG-LINK-001) — đổi đối tác + chọn khoản của ngân hàng mới trong MỘT lần lưu.
 */
export function disbursementReleasedByLoanChoice(
  link: Pick<LinkRecord, 'relation' | 'to_type' | 'to_id' | 'origin'>,
  previous: LoanPlan | null | undefined,
  next: LoanPlan | null | undefined,
): boolean {
  if (link.relation !== 'disbursement' || link.to_type !== 'bank_debt') return false;
  const nextLoanId = existingLoanIdOf(next);
  if (link.to_id === nextLoanId) return false;
  return nextLoanId !== null || (link.origin === 'manual' && link.to_id === existingLoanIdOf(previous));
}

export async function linkChosenLoanOnSave(input: {
  documentId: string;
  /** kế hoạch đã lưu TRƯỚC lần lưu này (null khi lập mới). */
  previous: LoanPlan | null;
  plan: LoanPlan | null;
  amountMinor: bigint;
  actor: LinkActor;
  requestId: string | null;
}): Promise<void> {
  const nextLoanId = existingLoanIdOf(input.plan);
  for (const link of await listLinksFor('document', input.documentId, { scopeCompanyIds: null })) {
    if (link.from_type !== 'document' || link.from_id !== input.documentId) continue;
    if (!disbursementReleasedByLoanChoice(link, input.previous, input.plan)) continue;
    await removeLink({
      link_id: link._id,
      reason: nextLoanId ? 'Phiếu thu đổi khoản vay giải ngân' : 'Phiếu thu không còn gắn khoản vay có sẵn',
      actor: input.actor,
      scopeCompanyIds: null,
      request_id: input.requestId,
    });
  }
  if (!nextLoanId) return;
  await ensureManualLink({
    from: { type: 'document', id: input.documentId },
    to: { type: 'bank_debt', id: nextLoanId },
    relation: 'disbursement',
    amountMinor: input.amountMinor,
    actor: { user_id: input.actor.user_id, name: input.actor.name ?? null, role: input.actor.role ?? null },
    requestId: input.requestId,
  });
}

/**
 * Tuỳ chọn vay: kiểm quy tắc thuần (`planLoanOptions`) rồi kiểm bản ghi MỚI/ĐỔI — ngân hàng cho vay,
 * TK nhận giải ngân (phải là TK NGÂN HÀNG của công ty), khoản vay có sẵn (cùng ngân hàng, còn nhận giải ngân).
 * Chỉ kiểm bản ghi khi tham chiếu khác với `previous` (đã từng được chấp nhận). Sức chứa của khoản vay có sẵn
 * kiểm MỖI lần lưu (FG-LINK-002), giải ngân của chính phiếu đang sửa (`voucherId`) không tính trùng.
 */
export async function resolveLoanPlan(input: {
  companyId: string;
  voucherKind: VoucherKind;
  voucherPartnerId: string | null;
  voucherAmountMinor: bigint;
  loan: LoanInput | null;
  previous: LoanPlan | null;
  /** phiếu đang sửa (null khi lập mới). */
  voucherId?: string | null;
}): Promise<LoanPlan | null> {
  const plan = planLoanOptions(input.loan, {
    voucherKind: input.voucherKind,
    voucherPartnerId: input.voucherPartnerId,
    voucherAmountMinor: input.voucherAmountMinor,
  });
  if (!plan) return null;
  const prev = input.previous;

  if (plan.kind === 'borrow' && plan.mode === 'existing' && plan.existing_loan_id && plan.existing_loan_id !== prev?.existing_loan_id) {
    const loan = OBJECT_ID_RE.test(plan.existing_loan_id)
      ? await Models.BankDebt.findOne({ _id: plan.existing_loan_id, company_id: input.companyId } as never)
          .select({ partner_id: 1, status: 1 })
          .lean<{ partner_id?: unknown; status?: string } | null>()
      : null;
    if (!loan || String(loan.partner_id ?? '') !== String(input.voucherPartnerId) || !LOAN_ATTACHABLE_STATUSES.includes(String(loan.status))) {
      throw new ApiError({
        code: 'FG-VAL-001',
        detail: 'Khoản vay không thuộc ngân hàng này hoặc không còn nhận giải ngân',
        errors: { 'options.loan.existing_loan_id': 'Chọn khoản vay của cùng ngân hàng đang chờ giải ngân hoặc đang vay' },
      });
    }
  }
  // Sức chứa khi LƯU (§11.4 (b), FG-LINK-002 như gán thủ công): giải ngân của khoản vay + số tiền phiếu ≤ gốc.
  // Kiểm mọi lần lưu (số tiền phiếu có thể đổi), giải ngân của chính phiếu đang sửa không tính trùng.
  if (plan.kind === 'borrow' && plan.mode === 'existing' && plan.existing_loan_id) {
    await assertLoanDisbursementCapacity({
      loanId: plan.existing_loan_id,
      amountMinor: input.voucherAmountMinor,
      excludeDocumentId: input.voucherId ?? null,
    });
  }
  // Vay MỚI: khoản tự sinh (R2) giải ngân TOÀN BỘ số tiền phiếu ⇒ phiếu không được còn phân bổ khác (gán tay tới
  // khoản có sẵn, cấn trừ…). Chặn ngay khi LƯU; nếu không lượt R2 sau lưu lỗi FG-LINK-002 và để lại khoản mồ côi.
  // Không tính: liên kết giải ngân tự động (R2 đồng bộ lại) và liên kết gán tay tới khoản có sẵn CŨ (linkChosenLoanOnSave gỡ).
  if (plan.kind === 'borrow' && plan.mode === 'new' && input.voucherId) {
    const prevExistingLoanId = prev?.kind === 'borrow' && prev.mode === 'existing' ? prev.existing_loan_id : null;
    await assertDocumentFreeForNewLoan({
      documentId: input.voucherId,
      amountMinor: input.voucherAmountMinor,
      willResync: (l) => (l.origin === 'automation' && l.relation === 'disbursement') || (l.relation === 'disbursement' && l.origin === 'manual' && l.to_id === prevExistingLoanId),
    });
  }

  if (plan.kind === 'fund') {
    if (plan.lender_partner_id !== prev?.lender_partner_id) {
      const lender = await loadPartnerInCompany(input.companyId, plan.lender_partner_id!);
      assertLenderBank(lender as PartnerFacts | null, {
        companyId: input.companyId,
        requireActive: true,
        field: 'options.loan.lender_partner_id',
      });
    }
    if (plan.receive_account_id !== prev?.receive_account_id) {
      const acct = OBJECT_ID_RE.test(plan.receive_account_id!)
        ? await Models.BankAccount.findOne({ _id: plan.receive_account_id, company_id: input.companyId } as never)
            .select({ kind: 1, status: 1 })
            .lean<{ kind?: string; status?: string } | null>()
        : null;
      if (!acct || acct.kind !== 'bank' || acct.status !== 'active') {
        throw new ApiError({
          code: 'FG-VAL-001',
          detail: 'Tài khoản nhận giải ngân phải là tài khoản ngân hàng đang hoạt động của công ty',
          errors: { 'options.loan.receive_account_id': 'Chọn tài khoản ngân hàng của công ty' },
        });
      }
    }
  }
  return plan;
}

/**
 * Cấn trừ khoản vay (R7): kiểm quy tắc thuần (`planOffsetOptions`) rồi kiểm BẢN GHI khi lưu — khoản nợ ngân hàng / công nợ
 * thuộc công ty và ĐÚNG đối tác của phiếu, khoản vay còn đang vay, công nợ (phải trả với phiếu chi, phải thu với phiếu thu) còn dư, và phiếu còn đủ số tiền sau
 * các liên kết KHÁC của chính phiếu. Sức chứa không tính liên kết R7 của chính phiếu (sẽ được thay khi duyệt).
 * Lần lưu không đổi cấn trừ so với `previous` thì bỏ qua kiểm bản ghi (như vay): sửa phiếu khác không bị chặn vì khoản cũ.
 */
export async function resolveOffsetPlan(input: {
  companyId: string;
  voucherId: string | null;
  voucherKind: VoucherKind;
  voucherPartnerId: string | null;
  /** loại đối tác của phiếu (`bank` / `customer` / `supplier`…) — quyết định khoản nào được cấn trừ. */
  voucherPartnerType: string | null;
  voucherAmountMinor: bigint;
  /** tuỳ chọn vay cùng phiếu (vay để chi không được cấn trừ cùng lúc). */
  voucherLoanKind?: LoanKind | null;
  offset: OffsetInput | null;
  previous: OffsetPlan | null;
  /** số tiền phiếu ở lần lưu trước (để nhận ra cấn trừ theo phiếu vừa đổi số tiền). */
  previousVoucherAmountMinor?: bigint | null;
}): Promise<OffsetPlan | null> {
  const plan = planOffsetOptions(input.offset, {
    voucherKind: input.voucherKind,
    voucherPartnerId: input.voucherPartnerId,
    voucherAmountMinor: input.voucherAmountMinor,
    voucherLoanKind: input.voucherLoanKind ?? null,
  });
  if (!plan || !input.voucherPartnerId) return plan;
  const spec = offsetLinkSpecOf(plan, input.voucherAmountMinor);

  // phần phân bổ KHÁC của phiếu (gán tay) + số tiền cấn trừ không được vượt số tiền phiếu
  const ruleLinks = input.voucherId ? await offsetRuleLinksOf(input.voucherId) : [];
  const allocatedTotal = input.voucherId ? await documentAllocatedTotalOf(input.voucherId) : 0n;
  const otherAllocated = allocatedTotal - ruleLinks.reduce((s, l) => s + allocationOf(l), 0n);
  if (otherAllocated + spec.amount_minor > input.voucherAmountMinor) {
    throw offsetError(
      'amount_minor',
      `Phiếu đã phân bổ ${formatMoney(money(otherAllocated, 'VND'), { mode: 'compact' })} cho liên kết khác — không đủ để cấn trừ ${formatMoney(money(spec.amount_minor, 'VND'), { mode: 'compact' })}`,
    );
  }

  const unchanged = sameOffsetPlan(input.previous, input.previousVoucherAmountMinor ?? input.voucherAmountMinor, plan, input.voucherAmountMinor);
  if (!unchanged) {
    const partner = { companyId: input.companyId, voucherId: input.voucherId, partnerId: input.voucherPartnerId, partnerType: input.voucherPartnerType };
    if (plan.target === 'bank_debt') {
      await assertLoanOffset({ ...partner, loanId: plan.target_id, principalMinor: spec.split?.principal ?? 0n });
    } else {
      await assertDebtOffset({ ...partner, voucherKind: input.voucherKind, debtId: plan.target_id, amountMinor: spec.amount_minor });
    }
  }
  return plan;
}

/** Khoản vay được cấn trừ: thuộc công ty, đúng ngân hàng của phiếu, còn đang vay, còn sức chứa trả nợ. */
async function assertLoanOffset(input: {
  companyId: string;
  voucherId: string | null;
  partnerId: string;
  partnerType: string | null;
  loanId: string;
  principalMinor: bigint;
}): Promise<void> {
  const loan = OBJECT_ID_RE.test(input.loanId)
    ? await Models.BankDebt.findOne({ _id: input.loanId, company_id: input.companyId } as never)
        .select({ code: 1, partner_id: 1 })
        .lean<{ code?: string; partner_id?: unknown } | null>()
    : null;
  if (!loan || String(loan.partner_id ?? '') !== input.partnerId) {
    throw offsetError('target_id', 'Khoản vay không thuộc ngân hàng của phiếu');
  }
  if (input.partnerType !== 'bank') throw offsetError('target_id', 'Cấn trừ khoản vay ngân hàng: đối tác của phiếu phải là Ngân hàng');
  if (!(await loanOpenForRepayment(input.loanId))) {
    throw offsetError('target_id', `Khoản vay ${loan.code ?? ''} không còn đang vay — không cấn trừ được`);
  }
  await assertLoanRepaymentCapacity({ loanId: input.loanId, principalMinor: input.principalMinor, excludeDocumentId: input.voucherId });
}

/** Công nợ được cấn trừ: thuộc công ty, đúng đối tác (KH / NCC) của phiếu, đúng hướng với phiếu (thu ↔ phải thu, chi ↔ phải trả), còn dư. */
async function assertDebtOffset(input: {
  companyId: string;
  voucherId: string | null;
  voucherKind: VoucherKind;
  partnerId: string;
  partnerType: string | null;
  debtId: string;
  amountMinor: bigint;
}): Promise<void> {
  const debt = OBJECT_ID_RE.test(input.debtId)
    ? await Models.DebtVoucher.findOne({ _id: input.debtId, company_id: input.companyId } as never)
        .select({ partner_id: 1, party_type: 1, direction: 1, side: 1 })
        .lean<{ partner_id?: unknown; party_type?: string | null; direction?: string | null; side?: string | null } | null>()
    : null;
  if (!debt || String(debt.partner_id ?? '') !== input.partnerId) throw offsetError('target_id', 'Công nợ không thuộc đối tác của phiếu');
  if (input.partnerType !== 'customer' && input.partnerType !== 'supplier') {
    throw offsetError('target_id', 'Cấn trừ công nợ: đối tác của phiếu phải là khách hàng hoặc nhà cung cấp');
  }
  if (isReadOnlyDebt(debt.party_type)) throw offsetError('target_id', 'Công nợ nhân viên (TK 334) chỉ đọc — không cấn trừ được');
  assertOffsetDirection(directionOf(debt), input.voucherKind);
  await assertDebtOffsetCapacity({ debtVoucherId: input.debtId, amountMinor: input.amountMinor, excludeDocumentId: input.voucherId });
}

/** Mã khoản được cấn trừ (trong công ty của phiếu) — để hiển thị; không có ⇒ null. */
async function offsetTargetCodeOf(plan: OffsetPlan, companyId: string): Promise<string | null> {
  if (!OBJECT_ID_RE.test(plan.target_id)) return null;
  const filter = { _id: plan.target_id, company_id: companyId } as never;
  const row =
    plan.target === 'bank_debt'
      ? await Models.BankDebt.findOne(filter).select({ code: 1 }).lean<{ code?: string } | null>()
      : await Models.DebtVoucher.findOne(filter).select({ code: 1 }).lean<{ code?: string } | null>();
  return row?.code ? String(row.code) : null;
}

export interface TransferTargetPlan {
  company_id: string;
  account_id: string | null;
}

/**
 * Chuyển nội bộ theo ID (§11.6): công ty nhận khác công ty phiếu và tồn tại; TK đích BẮT BUỘC và là TK
 * đang hoạt động của CHÍNH công ty nhận. Trả về null nếu phiếu không có đích nội bộ.
 */
export async function resolveTransferTarget(input: {
  companyId: string;
  kind: VoucherKind;
  /** Đối tác của phiếu: với phiếu chi, đối tác "Công ty trong tập đoàn" quyết định đích chuyển nội bộ. */
  partnerId: string | null;
  target: { company_id: string; account_id?: string | null } | null;
  previous: TransferTargetPlan | null;
}): Promise<TransferTargetPlan | null> {
  let input_target = input.target;
  if (input.kind === 'spend') {
    const partner = input.partnerId && OBJECT_ID_RE.test(input.partnerId)
      ? await Models.Partner.findOne({ _id: input.partnerId, company_id: input.companyId } as never)
          .select({ type: 1, internal_company_id: 1, internal_account_id: 1 })
          .lean<{ type?: string; internal_company_id?: unknown; internal_account_id?: unknown } | null>()
      : null;
    const derived = partner?.type === 'internal'
      ? { company_id: String(partner.internal_company_id), account_id: String(partner.internal_account_id) }
      : null;
    // Không còn chọn đích tay: đích chỉ đến từ đối tác nội bộ, nên mọi phiếu chi chuyển nội bộ đều có đối tác đi kèm
    if (input_target && !derived) {
      throw new ApiError({
        code: 'FG-VAL-001',
        detail: 'Chuyển nội bộ: chọn đối tác là công ty trong tập đoàn',
        errors: { transfer_target: 'Chọn đối tác là công ty trong tập đoàn để chuyển nội bộ' },
      });
    }
    if (input_target && derived && (String(input_target.company_id) !== derived.company_id || (input_target.account_id ?? null) !== derived.account_id)) {
      throw new ApiError({
        code: 'FG-VAL-001',
        detail: 'Tài khoản nhận lấy từ đối tác công ty trong tập đoàn',
        errors: { transfer_target: 'Tài khoản nhận lấy từ đối tác công ty trong tập đoàn' },
      });
    }
    input_target = derived;
  }
  if (!input_target) return null;
  const t: TransferTargetPlan = {
    company_id: String(input_target.company_id),
    account_id: strOrNull(input_target.account_id),
  };
  assertTransferTargetFits(input.kind, t, input.companyId);
  // kiểm trước nhánh "không đổi": phiếu cũ thiếu TK cũng phải chọn TK khi lưu lại
  assertTransferTargetAccount(t);
  const unchanged = Boolean(input.previous && input.previous.company_id === t.company_id && input.previous.account_id === t.account_id);
  if (unchanged) return t;

  const company = OBJECT_ID_RE.test(t.company_id)
    ? await Models.Company.findById(t.company_id).select({ _id: 1 }).lean()
    : null;
  if (!company) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Công ty nhận không tồn tại',
      errors: { 'transfer_target.company_id': 'Công ty nhận không tồn tại' },
    });
  }
  if (t.account_id) {
    const acct = OBJECT_ID_RE.test(t.account_id)
      ? await Models.BankAccount.findById(t.account_id).select({ company_id: 1, status: 1 }).lean<{ company_id?: unknown; status?: string } | null>()
      : null;
    if (!acct || acct.status !== 'active' || String(acct.company_id ?? '') !== t.company_id) {
      throw new ApiError({
        code: 'FG-VAL-001',
        detail: 'Tài khoản nhận không thuộc công ty nhận hoặc đã đóng',
        errors: { 'transfer_target.account_id': 'Tài khoản nhận không thuộc công ty nhận hoặc đã đóng' },
      });
    }
  }
  return t;
}

/** Đã có lượt R3 (vay để chi) cho phiếu này — khoá sửa số tiền ở cấp duyệt (§11.5). */
export async function hasAutoLoanRun(documentId: string, ruleCode: string = 'R3'): Promise<boolean> {
  if (!OBJECT_ID_RE.test(documentId)) return false;
  return Boolean(await Models.AutomationRun.exists({ source_type: 'document', source_id: documentId, rule_code: ruleCode } as never));
}

/** Gỡ mềm mọi liên kết đang hiệu lực của một phiếu sắp bị xoá cứng (không để dung lượng hạn mức treo). */
export async function softRemoveLinksOfDocument(input: {
  documentId: string;
  companyId: string;
  actorId: string | null;
  reason: string;
}): Promise<number> {
  const res = await Models.BusinessLink.updateMany(
    {
      company_id: input.companyId,
      status: 'active',
      $or: [
        { from_type: 'document', from_id: input.documentId },
        { to_type: 'document', to_id: input.documentId },
      ],
    } as never,
    { $set: { status: 'removed', removed_by: input.actorId, removed_at: new Date(), removed_reason: input.reason } } as never,
  ).exec();
  return res.modifiedCount ?? 0;
}

/** Kiểm tra sửa số tiền ở cấp duyệt: chỉ khi đổi thật và đã có R3 thì chặn. */
export async function assertApprovalAmountEditable(documentId: string, currentMinor: bigint, requestedMinor: bigint | null): Promise<void> {
  if (requestedMinor === null || requestedMinor === currentMinor) return;
  assertAmountEditAllowed(currentMinor, requestedMinor, await hasAutoLoanRun(documentId));
}

/* ================================================================== *
 * 2. Tham chiếu khi đọc (chi tiết phiếu)
 * ================================================================== */

export interface PartnerRefView {
  _id: string;
  code: string;
  type: string;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  tax_code: string | null;
  status: string;
}

export function partnerRefView(p: Record<string, unknown> | null | undefined): PartnerRefView | null {
  if (!p) return null;
  return {
    _id: String(p._id),
    code: String(p.code ?? ''),
    type: String(p.type ?? 'customer'),
    name: String(p.name ?? ''),
    bank_name: strOrNull(p.bank_name),
    account_number: strOrNull(p.account_number),
    tax_code: strOrNull(p.tax_code),
    status: String(p.status ?? 'active'),
  };
}

export interface LoanView {
  kind: LoanKind;
  mode: LoanMode;
  lender_partner_id: string | null;
  lender: PartnerRefView | null;
  receive_account_id: string | null;
  receive_account_label: string | null;
  /** Số tiền đã ghi trên tuỳ chọn (null = theo số tiền phiếu). */
  amount_minor: string | null;
  /** Số tiền vay hiệu lực (đã ghi, hoặc số tiền phiếu). */
  effective_amount_minor: string;
  existing_loan_id: string | null;
  existing_loan: { _id: string; code: string; status: string } | null;
  terms: LoanTermsPlan | null;
}

/** Cấn trừ khoản vay đã lưu trên phiếu chi (`options.offset`), kèm mã khoản và số tiền hiệu lực. */
export interface OffsetView {
  target: OffsetTarget;
  target_id: string;
  target_code: string | null;
  /** Số tiền đã ghi (null = toàn bộ số tiền phiếu). */
  amount_minor: string | null;
  /** Số tiền cấn trừ hiệu lực (đã ghi, hoặc số tiền phiếu hiện tại). */
  effective_amount_minor: string;
  interest_minor: string | null;
  fee_minor: string | null;
}

export interface TransferView {
  company_id: string;
  company_name: string | null;
  company_code: string | null;
  account_id: string | null;
  account_label: string | null;
}

export interface OriginView {
  kind: 'manual' | 'automation';
  run_id: string | null;
  rule_code: string | null;
}

export interface TagView {
  _id: string;
  name: string;
  color: string;
}

export interface CounterpartView {
  type: LinkObjectType;
  id: string;
  code: string | null;
  status: string | null;
  total_minor: string | null;
  partner_id: string | null;
  partner_name: string | null;
  /** false: đối tượng ngoài phạm vi công ty của người xem (hoặc đã xoá) — không lộ mã/số tiền. */
  visible: boolean;
}

export interface LinkView {
  _id: string;
  company_id: string;
  from_type: LinkObjectType;
  from_id: string;
  from_code: string | null;
  to_type: LinkObjectType;
  to_id: string;
  to_code: string | null;
  relation: LinkRecord['relation'];
  amount_minor: string | null;
  split: { principal: string; interest: string; fee: string } | null;
  origin: LinkRecord['origin'];
  run_id: string | null;
  rule_code: string | null;
  status: LinkRecord['status'];
  note: string | null;
  created_by: string | null;
  created_at: string | null;
  removed_by: string | null;
  removed_at: string | null;
  removed_reason: string | null;
  direction: 'out' | 'in';
  counterpart: CounterpartView;
}

export interface AutomationRunView {
  _id: string;
  rule_code: string;
  rule_name: string;
  company_id: string | null;
  source_type: string;
  source_id: string;
  event_type: string;
  idem_key: string;
  status: string;
  steps: { name: string; status: string; output_type: string | null; output_id: string | null; error: string | null; at: string | null }[];
  error: string | null;
  attempts: number;
  created_at: string | null;
  updated_at: string | null;
}

/** Phần tham chiếu của phiếu khi đọc — `detailOf` ghép vào payload. */
export interface VoucherRefView {
  partner_id: string | null;
  partner: PartnerRefView | null;
  /** Bên nhận/nộp tiền dạng cũ (`payee.*`) — DẪN XUẤT từ đối tác; dữ liệu v1 chưa migrate thì giữ nguyên. */
  payee: Record<string, unknown>;
  tag_ids: string[];
  tags: TagView[];
  options: { loan: LoanView | null; offset: OffsetView | null; account_borrow: AccountBorrowView | null };
  transfer_target: TransferView | null;
  origin: OriginView;
  links: LinkView[];
  automation_runs: AutomationRunView[];
}

/** Nạp hàng loạt tên/mã phục vụ hiển thị (theo công ty của từng đối tượng). */
async function companyNames(ids: string[]): Promise<Map<string, { name: string; code: string }>> {
  const unique = dedupeIds(ids).filter((id) => OBJECT_ID_RE.test(id));
  if (!unique.length) return new Map();
  const rows = await Models.Company.find({ _id: { $in: unique } } as never).select({ name: 1, code: 1 }).lean<{ _id: unknown; name?: string; code?: string }[]>();
  return new Map(rows.map((c) => [String(c._id), { name: String(c.name ?? ''), code: String(c.code ?? '') }]));
}

async function partnerNames(ids: string[], companyIds: string[] | null): Promise<Map<string, string>> {
  const unique = dedupeIds(ids).filter((id) => OBJECT_ID_RE.test(id));
  if (!unique.length) return new Map();
  const filter: Record<string, unknown> = { _id: { $in: unique } };
  if (companyIds !== null) filter.company_id = { $in: companyIds };
  const rows = await Models.Partner.find(filter as never).select({ name: 1 }).lean<{ _id: unknown; name?: string }[]>();
  return new Map(rows.map((p) => [String(p._id), String(p.name ?? '')]));
}

interface CounterpartRaw {
  code: string | null;
  status: string | null;
  total_minor: bigint | null;
  partner_id: string | null;
  company_id: string;
}

/** Đối tượng đầu bên kia của liên kết, lọc theo phạm vi công ty của người xem. */
async function loadCounterparts(
  refs: { type: LinkObjectType; id: string }[],
  scopeCompanyIds: string[] | null,
): Promise<Map<string, CounterpartRaw>> {
  const out = new Map<string, CounterpartRaw>();
  const scopeFilter = scopeCompanyIds === null ? {} : { company_id: { $in: scopeCompanyIds } };
  const byType = (type: LinkObjectType) => dedupeIds(refs.filter((r) => r.type === type).map((r) => r.id)).filter((id) => OBJECT_ID_RE.test(id));

  const docIds = byType('document');
  if (docIds.length) {
    const rows = await Models.Document.find({ _id: { $in: docIds }, ...scopeFilter } as never)
      .select({ code: 1, status: 1, amount: 1, partner_id: 1, company_id: 1 })
      .lean<{ _id: unknown; code?: string; status?: string; amount?: { minor?: unknown }; partner_id?: unknown; company_id: unknown }[]>();
    for (const r of rows) {
      out.set(`document:${String(r._id)}`, {
        code: String(r.code ?? ''),
        status: String(r.status ?? ''),
        total_minor: r.amount?.minor === undefined || r.amount?.minor === null ? null : BigInt(String(r.amount.minor)),
        partner_id: strOrNull(r.partner_id),
        company_id: String(r.company_id),
      });
    }
  }
  const debtIds = byType('debt_voucher');
  if (debtIds.length) {
    const rows = await Models.DebtVoucher.find({ _id: { $in: debtIds }, ...scopeFilter } as never)
      .select({ code: 1, value_minor: 1, partner_id: 1, company_id: 1 })
      .lean<{ _id: unknown; code?: string; value_minor?: unknown; partner_id?: unknown; company_id: unknown }[]>();
    for (const r of rows) {
      out.set(`debt_voucher:${String(r._id)}`, {
        code: String(r.code ?? ''),
        status: null,
        total_minor: r.value_minor === undefined || r.value_minor === null ? null : BigInt(String(r.value_minor)),
        partner_id: strOrNull(r.partner_id),
        company_id: String(r.company_id),
      });
    }
  }
  const loanIds = byType('bank_debt');
  if (loanIds.length) {
    const rows = await Models.BankDebt.find({ _id: { $in: loanIds }, ...scopeFilter } as never)
      .select({ code: 1, status: 1, principal_minor: 1, partner_id: 1, company_id: 1 })
      .lean<{ _id: unknown; code?: string; status?: string; principal_minor?: unknown; partner_id?: unknown; company_id: unknown }[]>();
    for (const r of rows) {
      out.set(`bank_debt:${String(r._id)}`, {
        code: String(r.code ?? ''),
        status: String(r.status ?? ''),
        total_minor: r.principal_minor === undefined || r.principal_minor === null ? null : BigInt(String(r.principal_minor)),
        partner_id: strOrNull(r.partner_id),
        company_id: String(r.company_id),
      });
    }
  }
  return out;
}

/** Liên kết hai chiều của phiếu + đối tượng bên kia (mã, trạng thái, số tiền, đối tác). */
async function linksViewOf(doc: { _id: unknown; code: string }, scopeCompanyIds: string[] | null): Promise<LinkView[]> {
  const docId = String(doc._id);
  const links = await listLinksFor('document', docId, { scopeCompanyIds, includeRemoved: true });
  if (!links.length) return [];

  const refs: { type: LinkObjectType; id: string }[] = links.map((l) =>
    l.from_type === 'document' && l.from_id === docId ? { type: l.to_type, id: l.to_id } : { type: l.from_type, id: l.from_id },
  );
  const counterparts = await loadCounterparts(refs, scopeCompanyIds);
  const partners = await partnerNames(
    [...counterparts.values()].map((c) => c.partner_id).filter((x): x is string => Boolean(x)),
    scopeCompanyIds,
  );

  return links.map((l) => {
    const outgoing = l.from_type === 'document' && l.from_id === docId;
    const cp = outgoing ? { type: l.to_type, id: l.to_id } : { type: l.from_type, id: l.from_id };
    const raw = counterparts.get(`${cp.type}:${cp.id}`);
    const counterpart: CounterpartView = raw
      ? {
          type: cp.type,
          id: cp.id,
          code: raw.code,
          status: raw.status,
          total_minor: raw.total_minor === null ? null : raw.total_minor.toString(),
          partner_id: raw.partner_id,
          partner_name: raw.partner_id ? (partners.get(raw.partner_id) ?? null) : null,
          visible: true,
        }
      : { type: cp.type, id: cp.id, code: null, status: null, total_minor: null, partner_id: null, partner_name: null, visible: false };
    const fromCode = outgoing ? doc.code : (counterpart.visible ? counterpart.code : null);
    const toCode = outgoing ? (counterpart.visible ? counterpart.code : null) : doc.code;
    return {
      _id: l._id,
      company_id: l.company_id,
      from_type: l.from_type,
      from_id: l.from_id,
      from_code: fromCode,
      to_type: l.to_type,
      to_id: l.to_id,
      to_code: toCode,
      relation: l.relation,
      amount_minor: l.amount_minor === null ? null : l.amount_minor.toString(),
      split: l.split ? { principal: l.split.principal.toString(), interest: l.split.interest.toString(), fee: l.split.fee.toString() } : null,
      origin: l.origin,
      run_id: l.run_id,
      rule_code: l.rule_code,
      status: l.status,
      note: l.note,
      created_by: l.created_by,
      created_at: iso(l.created_at),
      removed_by: l.removed_by,
      removed_at: iso(l.removed_at),
      removed_reason: l.removed_reason,
      direction: outgoing ? 'out' : 'in',
      counterpart,
    };
  });
}

/** Lượt quy trình tự động đã chạy cho phiếu (mới nhất trước) — để hiển thị "Quy trình tự động: R3 ✔". */
async function automationRunsOf(documentId: string, companyId: string): Promise<AutomationRunView[]> {
  const rows = await Models.AutomationRun.find({ source_type: 'document', source_id: documentId, company_id: companyId } as never)
    .sort({ created_at: -1 })
    .limit(20)
    .lean<Record<string, unknown>[]>();
  return rows.map((r) => {
    const code = String(r.rule_code ?? '');
    const steps = (r.steps ?? []) as Record<string, unknown>[];
    return {
      _id: String(r._id),
      rule_code: code,
      rule_name: AUTOMATION_RULE_LABEL[code as AutomationRuleCode] ?? code,
      company_id: strOrNull(r.company_id),
      source_type: String(r.source_type ?? 'document'),
      source_id: String(r.source_id ?? documentId),
      event_type: String(r.event_type ?? ''),
      idem_key: String(r.idem_key ?? ''),
      status: String(r.status ?? 'pending'),
      steps: steps.map((s) => ({
        name: String(s.name ?? ''),
        status: String(s.status ?? 'pending'),
        output_type: strOrNull(s.output_type),
        output_id: strOrNull(s.output_id),
        error: strOrNull(s.error),
        at: iso(s.at),
      })),
      error: strOrNull(r.error),
      attempts: Number(r.attempts ?? 0),
      created_at: iso(r.created_at),
      updated_at: iso(r.updated_at),
    };
  });
}

/**
 * Dựng toàn bộ phần tham chiếu của một phiếu (lean). `scopeCompanyIds` = null nếu xem toàn tập đoàn.
 * Đối tác / tag / TK / khoản vay được nạp SỐNG theo ID trong công ty của phiếu.
 */
export async function buildVoucherRefView(doc: Record<string, unknown>, scopeCompanyIds: string[] | null): Promise<VoucherRefView> {
  const docId = String(doc._id);
  const companyId = String(doc.company_id);
  const partnerId = strOrNull(doc.partner_id);
  const tagIds = ((doc.tag_ids ?? []) as unknown[]).map(String);
  const loanStored = ((doc.options as { loan?: Record<string, unknown> | null } | null | undefined)?.loan ?? null) as Record<string, unknown> | null;
  const loanPlan = storedLoanToPlan(loanStored);
  const offsetStored = ((doc.options as { offset?: Record<string, unknown> | null } | null | undefined)?.offset ?? null) as Record<string, unknown> | null;
  const offsetPlan = storedOffsetToPlan(offsetStored);
  const legacyTarget = (doc.target ?? null) as { company_id?: unknown; account_id?: unknown } | null;
  const v2Target = (doc.transfer_target ?? null) as { company_id?: unknown; account_id?: unknown } | null;
  const targetRaw = v2Target?.company_id ? v2Target : legacyTarget?.company_id ? legacyTarget : null;
  const amountMinor = BigInt(String((doc.amount as { minor?: unknown } | undefined)?.minor ?? '0'));

  const [partnerRaw, tagRows, lenderRaw, accountRaw, existingRaw, targetCompanyMap, targetAccountRaw, links, runs] = await Promise.all([
    partnerId ? Models.Partner.findOne({ _id: partnerId, company_id: companyId } as never).lean<Record<string, unknown> | null>() : Promise.resolve(null),
    tagIds.length
      ? Models.Tag.find({ _id: { $in: tagIds.filter((id) => OBJECT_ID_RE.test(id)) }, company_id: companyId } as never).select({ name: 1, color: 1 }).lean<{ _id: unknown; name?: string; color?: string }[]>()
      : Promise.resolve([]),
    loanPlan?.lender_partner_id && loanPlan.kind === 'fund'
      ? Models.Partner.findOne({ _id: loanPlan.lender_partner_id, company_id: companyId } as never).lean<Record<string, unknown> | null>()
      : Promise.resolve(null),
    loanPlan?.receive_account_id
      ? Models.BankAccount.findOne({ _id: loanPlan.receive_account_id, company_id: companyId } as never)
          .select({ bank_name: 1, account_number: 1, account_name: 1 })
          .lean<{ bank_name?: string; account_number?: string; account_name?: string } | null>()
      : Promise.resolve(null),
    loanPlan?.existing_loan_id
      ? Models.BankDebt.findOne({ _id: loanPlan.existing_loan_id, company_id: companyId } as never).select({ code: 1, status: 1 }).lean<{ code?: string; status?: string } | null>()
      : Promise.resolve(null),
    targetRaw?.company_id ? companyNames([String(targetRaw.company_id)]) : Promise.resolve(new Map<string, { name: string; code: string }>()),
    targetRaw?.account_id && OBJECT_ID_RE.test(String(targetRaw.account_id))
      ? Models.BankAccount.findById(String(targetRaw.account_id)).select({ bank_name: 1, account_number: 1, account_name: 1 }).lean<{ bank_name?: string; account_number?: string; account_name?: string } | null>()
      : Promise.resolve(null),
    linksViewOf({ _id: doc._id, code: String(doc.code ?? '') }, scopeCompanyIds),
    automationRunsOf(docId, companyId),
  ]);

  const partner = partnerRefView(partnerRaw);
  const tagById = new Map(tagRows.map((t) => [String(t._id), t] as const));
  const tags: TagView[] = tagIds
    .map((id) => tagById.get(id))
    .filter((t): t is NonNullable<typeof t> => Boolean(t))
    .map((t) => ({ _id: String(t._id), name: String(t.name ?? ''), color: String(t.color ?? '#64748b') }));

  const isInternal = Boolean(targetRaw?.company_id);
  const legacy = (doc.payee ?? {}) as { name?: string; tax_code?: string | null; counterparty_id?: unknown; is_internal?: boolean; bank_name?: string | null; bank_account?: string | null };
  const payee: Record<string, unknown> = partner
    ? {
        name: partner.name,
        tax_code: partner.tax_code,
        counterparty_id: partner._id,
        is_internal: isInternal,
        bank_name: partner.bank_name,
        bank_account: partner.account_number,
      }
    : {
        name: legacy.name ?? '',
        tax_code: legacy.tax_code ?? null,
        counterparty_id: strOrNull(legacy.counterparty_id),
        is_internal: Boolean(legacy.is_internal) || isInternal,
        bank_name: legacy.bank_name ?? null,
        bank_account: legacy.bank_account ?? null,
      };

  const loan: LoanView | null = loanPlan
    ? {
        kind: loanPlan.kind,
        mode: loanPlan.mode,
        lender_partner_id: loanPlan.lender_partner_id,
        // vay đi thu (borrow): ngân hàng cho vay CHÍNH LÀ đối tác của phiếu
        lender: loanPlan.kind === 'borrow' ? partner : partnerRefView(lenderRaw),
        receive_account_id: loanPlan.receive_account_id,
        receive_account_label: accountRaw ? bankAccountLabelOf(accountRaw) : null,
        amount_minor: loanPlan.amount_minor === null ? null : loanPlan.amount_minor.toString(),
        effective_amount_minor: effectiveLoanAmount(loanPlan, amountMinor).toString(),
        existing_loan_id: loanPlan.existing_loan_id,
        existing_loan: existingRaw ? { _id: loanPlan.existing_loan_id!, code: String(existingRaw.code ?? ''), status: String(existingRaw.status ?? '') } : null,
        terms: loanPlan.terms,
      }
    : null;

  const offset: OffsetView | null = offsetPlan
    ? {
        target: offsetPlan.target,
        target_id: offsetPlan.target_id,
        target_code: await offsetTargetCodeOf(offsetPlan, companyId),
        amount_minor: offsetPlan.amount_minor === null ? null : offsetPlan.amount_minor.toString(),
        effective_amount_minor: effectiveOffsetAmount(offsetPlan, amountMinor).toString(),
        interest_minor: offsetPlan.interest_minor === null ? null : offsetPlan.interest_minor.toString(),
        fee_minor: offsetPlan.fee_minor === null ? null : offsetPlan.fee_minor.toString(),
      }
    : null;

  const targetCompany = targetRaw?.company_id ? targetCompanyMap.get(String(targetRaw.company_id)) : undefined;
  const transfer_target: TransferView | null = targetRaw?.company_id
    ? {
        company_id: String(targetRaw.company_id),
        company_name: targetCompany?.name || null,
        company_code: targetCompany?.code || null,
        account_id: strOrNull(targetRaw.account_id),
        account_label: targetAccountRaw ? bankAccountLabelOf(targetAccountRaw) : null,
      }
    : null;

  const origin = (doc.origin ?? {}) as { kind?: string; run_id?: unknown; rule_code?: unknown };
  return {
    partner_id: partnerId,
    partner,
    payee,
    tag_ids: tags.map((t) => t._id),
    tags,
    options: {
      loan,
      offset,
      account_borrow: await accountBorrowViewOf(
        (doc.options as { account_borrow?: Record<string, unknown> | null } | null | undefined)?.account_borrow ?? null,
        companyId,
        amountMinor,
      ),
    },
    transfer_target,
    origin: {
      kind: origin.kind === 'automation' ? 'automation' : 'manual',
      run_id: strOrNull(origin.run_id),
      rule_code: strOrNull(origin.rule_code),
    },
    links,
    automation_runs: runs,
  };
}

/** Đích nội bộ đã lưu: `transfer_target` (v2), hoặc `target` (v1) với dữ liệu cũ. */
export function storedTransferOf(doc: Record<string, unknown>): TransferTargetPlan | null {
  const v2 = doc.transfer_target as { company_id?: unknown; account_id?: unknown } | null | undefined;
  const v1 = doc.target as { company_id?: unknown; account_id?: unknown } | null | undefined;
  const src = v2?.company_id ? v2 : v1?.company_id ? v1 : null;
  return src ? { company_id: String(src.company_id), account_id: strOrNull(src.account_id) } : null;
}

/** Tên tag theo ID (trong công ty) — ghi vào lịch sử `tags_update`. */
export async function tagNamesOf(ids: string[], companyId: string): Promise<Map<string, string>> {
  const unique = dedupeIds(ids).filter((id) => OBJECT_ID_RE.test(id));
  if (!unique.length) return new Map();
  const rows = await Models.Tag.find({ _id: { $in: unique }, company_id: companyId } as never)
    .select({ name: 1 })
    .lean<{ _id: unknown; name?: string }[]>();
  return new Map(rows.map((t) => [String(t._id), String(t.name ?? '')]));
}

/** Đối tác của phiếu cho bộ lọc / hiển thị hàng — dùng chung với `buildVoucherRefView` qua `partnerRefView`. */
export async function partnerNameOf(partnerId: string | null | undefined, companyId: string): Promise<string | null> {
  if (!partnerId || !OBJECT_ID_RE.test(String(partnerId))) return null;
  const p = await Models.Partner.findOne({ _id: partnerId, company_id: companyId } as never).select({ name: 1 }).lean<{ name?: string } | null>();
  return p?.name ? String(p.name) : null;
}

/**
 * Quy tắc THUẦN cho phiếu thu/chi v2 (v2/v2.md §5.2, §6.2, §6.3, §11.4–11.6) — không chạm DB, có test.
 *
 * Kiểm tra theo bản ghi (đối tác, tag, tài khoản, khoản vay đã có) nằm ở `refs.ts`; file này chỉ
 * quyết định hình dạng dữ liệu hợp lệ và chuẩn hoá đầu vào (ID, số tiền, điều khoản vay).
 *
 * Quy ước lỗi: đối tác sai ⇒ `FG-PARTNER-001` (422); còn lại ⇒ `FG-VAL-001` kèm `errors` theo field
 * (khoá `options.loan.<field>` để UI gắn lỗi đúng chỗ).
 */

import { ApiError } from '@fingate/shared';

export type VoucherKind = 'spend' | 'income' | 'rollover' | 'internal';
export type LoanKind = 'borrow' | 'fund';
export type LoanMode = 'new' | 'existing' | 'later';

/** Tối đa số tag trên một phiếu (khớp contract `documentTagsBody` / `documentFields`). */
export const MAX_TAGS_PER_VOUCHER = 50;

/** Trạng thái khoản vay còn nhận được giải ngân — gắn phiếu thu đi vay vào khoản có sẵn (§11.4 (b)). */
export const LOAN_ATTACHABLE_STATUSES: readonly string[] = ['pending_disbursement', 'active'];

/** Phiếu đã đóng không gắn liên kết thủ công nữa (không còn tiền sẽ phát sinh). */
export const LINK_CLOSED_DOCUMENT_STATUSES: readonly string[] = ['rejected', 'cancelled'];

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/* ================================================================== *
 * Tiện ích ID
 * ================================================================== */

/** Khử trùng và giữ thứ tự xuất hiện; mọi phần tử đưa về chuỗi. */
export function dedupeIds(ids: readonly unknown[]): string[] {
  return [...new Set(ids.map((id) => String(id)))];
}

export interface IdDiff {
  added: string[];
  removed: string[];
}

/** So hai tập ID (chuỗi): phần thêm mới và phần bị bỏ. */
export function diffIds(prev: readonly unknown[], next: readonly unknown[]): IdDiff {
  const p = new Set(prev.map((id) => String(id)));
  const n = new Set(next.map((id) => String(id)));
  return {
    added: [...n].filter((id) => !p.has(id)),
    removed: [...p].filter((id) => !n.has(id)),
  };
}

/**
 * Đọc danh sách ID từ query string: `a,b` hoặc lặp tham số `tag_ids=a&tag_ids=b`.
 * ID sai định dạng ⇒ FG-VAL-001 (không để Mongo ném lỗi cast ra 500).
 */
export function parseIdList(value: unknown): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.flatMap((v) => String(v).split(','))
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const ids = dedupeIds(raw.map((s) => s.trim()).filter(Boolean));
  const bad = ids.filter((id) => !OBJECT_ID_RE.test(id));
  if (bad.length) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Mã tag không hợp lệ', errors: { tag_ids: 'Mã tag không hợp lệ' } });
  }
  return ids;
}

/* ================================================================== *
 * Đối tác (§5.2): một ô chọn, lưu ID; loại theo ngữ cảnh
 * ================================================================== */

export interface PartnerFacts {
  company_id: unknown;
  type: string;
  status: string;
}

function partnerError(detail: string, field: string): ApiError {
  return new ApiError({ code: 'FG-PARTNER-001', detail, errors: { [field]: detail } });
}

/**
 * Đối tác gắn vào phiếu: cùng công ty; nếu là lựa chọn MỚI thì phải đang hoạt động;
 * phiếu thu "đi vay" (§11.4) bắt buộc bên nộp tiền là Ngân hàng. Phiếu thu/chi còn lại: mọi loại.
 */
export function assertVoucherPartner(
  partner: PartnerFacts | null | undefined,
  ctx: { companyId: string; loanKind: LoanKind | null; requireActive: boolean; field?: string },
): void {
  const field = ctx.field ?? 'partner_id';
  if (!partner || String(partner.company_id) !== ctx.companyId) {
    throw partnerError('Đối tác không thuộc công ty của phiếu', field);
  }
  if (ctx.requireActive && partner.status !== 'active') {
    throw partnerError('Đối tác đã ngừng giao dịch — chỉ chọn đối tác đang hoạt động cho phiếu mới', field);
  }
  if (ctx.loanKind === 'borrow' && partner.type !== 'bank') {
    throw partnerError('Phiếu thu đi vay: bên nộp tiền phải là đối tác Ngân hàng', field);
  }
}

/** Ngân hàng cho vay (lender) của phiếu chi "vay để chi" — loại Ngân hàng, cùng công ty, đang hoạt động. */
export function assertLenderBank(
  partner: PartnerFacts | null | undefined,
  ctx: { companyId: string; requireActive: boolean; field: string },
): void {
  if (!partner || String(partner.company_id) !== ctx.companyId) {
    throw partnerError('Ngân hàng cho vay không thuộc công ty của phiếu', ctx.field);
  }
  if (partner.type !== 'bank') throw partnerError('Ngân hàng cho vay phải là đối tác loại Ngân hàng', ctx.field);
  if (ctx.requireActive && partner.status !== 'active') {
    throw partnerError('Ngân hàng cho vay đã ngừng giao dịch', ctx.field);
  }
}

/* ================================================================== *
 * Tag (§6.2): thuộc công ty; tag đã ẩn chỉ giữ lại, không gắn thêm
 * ================================================================== */

export function assertTagSelection(
  requested: readonly string[],
  rows: readonly { id: string; hidden: boolean }[],
  previous: readonly string[],
): void {
  if (requested.length > MAX_TAGS_PER_VOUCHER) {
    throw new ApiError({ code: 'FG-VAL-001', detail: `Tối đa ${MAX_TAGS_PER_VOUCHER} tag cho một phiếu`, errors: { tag_ids: 'Quá nhiều tag' } });
  }
  const found = new Map(rows.map((r) => [String(r.id), r] as const));
  if (requested.some((id) => !found.has(id))) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Có tag không thuộc công ty của phiếu', errors: { tag_ids: 'Tag không hợp lệ' } });
  }
  const before = new Set(previous.map(String));
  if (requested.some((id) => found.get(id)!.hidden && !before.has(id))) {
    throw new ApiError({ code: 'FG-VAL-001', detail: 'Tag đã ẩn — không gắn thêm vào phiếu', errors: { tag_ids: 'Tag đã ẩn' } });
  }
}

/* ================================================================== *
 * Tuỳ chọn vay (§11.4 phiếu thu đi vay · §11.5 phiếu chi vay để chi)
 * ================================================================== */

export interface LoanTermsPlan {
  contract_no: string | null;
  interest_rate: string | null;
  term_months: number | null;
  due_date: string | null;
  repayment_period: string | null;
  repayment_method: string | null;
  collateral: string | null;
}

/** Kế hoạch khoản vay đã chuẩn hoá (lưu vào `documents.options.loan`). */
export interface LoanPlan {
  kind: LoanKind;
  mode: LoanMode;
  lender_partner_id: string | null;
  receive_account_id: string | null;
  /** null = theo số tiền phiếu (sẽ đi theo số tiền đã chốt khi duyệt). */
  amount_minor: bigint | null;
  existing_loan_id: string | null;
  terms: LoanTermsPlan | null;
}

/** Đầu vào (từ contract hoặc từ bản đã lưu). */
export interface LoanInput {
  kind: LoanKind;
  mode?: LoanMode | null;
  lender_partner_id?: string | null;
  receive_account_id?: string | null;
  amount_minor?: string | bigint | null;
  existing_loan_id?: string | null;
  terms?: Partial<LoanTermsPlan> | null;
}

export interface LoanContext {
  voucherKind: VoucherKind;
  /** Đối tác của phiếu (bên nộp tiền / người nhận). */
  voucherPartnerId: string | null;
  /** Số tiền phiếu (minor). */
  voucherAmountMinor: bigint;
}

function loanFail(field: string, detail: string): never {
  throw new ApiError({ code: 'FG-VAL-001', detail, errors: { [`options.loan.${field}`]: detail } });
}

function toBigOrNull(value: string | bigint | null | undefined, field: string): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'bigint') return value;
  if (/^\d+$/.test(value)) return BigInt(value);
  return loanFail(field, 'Số tiền phải là số nguyên không âm');
}

function planTerms(t: Partial<LoanTermsPlan> | null | undefined): LoanTermsPlan | null {
  if (!t) return null;
  const plan: LoanTermsPlan = {
    contract_no: t.contract_no ?? null,
    interest_rate: t.interest_rate ?? null,
    term_months: t.term_months ?? null,
    due_date: t.due_date ?? null,
    repayment_period: t.repayment_period ?? null,
    repayment_method: t.repayment_method ?? null,
    collateral: t.collateral ?? null,
  };
  return Object.values(plan).every((v) => v === null) ? null : plan;
}

/**
 * Chuẩn hoá & kiểm tra tuỳ chọn vay theo loại phiếu. Thuần — việc kiểm tra bản ghi (ngân hàng,
 * tài khoản, khoản vay có sẵn) làm ở `refs.resolveLoanPlan`.
 *
 * - `borrow` (phiếu thu): chỉ phiếu thu; đối tác phiếu là Ngân hàng (kiểm ở assertVoucherPartner);
 *   gốc = số tiền phiếu (lưu null để đi theo phiếu); `mode` mặc định `later`; `existing` cần khoản có sẵn.
 * - `fund` (phiếu chi): chỉ phiếu chi; cần ngân hàng cho vay + TK nhận giải ngân; luôn tạo khoản vay mới
 *   (`mode` = `new`); số tiền vay tuỳ chọn, phải > 0 và ≤ số tiền phiếu; bằng đúng số tiền phiếu ⇒ lưu null.
 */
export function planLoanOptions(input: LoanInput | null | undefined, ctx: LoanContext): LoanPlan | null {
  if (!input) return null;
  const terms = planTerms(input.terms ?? null);

  if (input.kind === 'borrow') {
    if (ctx.voucherKind !== 'income') loanFail('kind', 'Chỉ phiếu thu mới đánh dấu "đi vay"');
    if (!ctx.voucherPartnerId) loanFail('lender_partner_id', 'Chọn đối tác (ngân hàng cho vay) trên phiếu');
    if (input.lender_partner_id && input.lender_partner_id !== ctx.voucherPartnerId) {
      loanFail('lender_partner_id', 'Ngân hàng cho vay phải là đối tác của phiếu');
    }
    const amount = toBigOrNull(input.amount_minor, 'amount_minor');
    if (amount !== null && amount !== ctx.voucherAmountMinor) loanFail('amount_minor', 'Gốc khoản vay bằng số tiền phiếu thu');
    const mode: LoanMode = input.mode ?? 'later';
    if (mode === 'existing' && !input.existing_loan_id) loanFail('existing_loan_id', 'Chọn khoản vay đã có');
    return {
      kind: 'borrow',
      mode,
      lender_partner_id: ctx.voucherPartnerId,
      receive_account_id: null,
      amount_minor: null,
      existing_loan_id: mode === 'existing' ? (input.existing_loan_id ?? null) : null,
      terms,
    };
  }

  // fund — phiếu chi vay để chi (R3)
  if (ctx.voucherKind !== 'spend') loanFail('kind', 'Chỉ phiếu chi mới "vay ngân hàng để chi"');
  if (!input.lender_partner_id) loanFail('lender_partner_id', 'Chọn ngân hàng cho vay');
  if (!input.receive_account_id) loanFail('receive_account_id', 'Chọn tài khoản nhận giải ngân của công ty');
  if (input.mode === 'existing') loanFail('mode', 'Vay để chi luôn tạo khoản vay mới');
  const amount = toBigOrNull(input.amount_minor, 'amount_minor');
  if (amount !== null && (amount <= 0n || amount > ctx.voucherAmountMinor)) {
    loanFail('amount_minor', 'Số tiền vay phải lớn hơn 0 và không vượt số tiền phiếu chi');
  }
  return {
    kind: 'fund',
    mode: 'new',
    lender_partner_id: input.lender_partner_id,
    receive_account_id: input.receive_account_id,
    // bằng đúng số tiền phiếu ⇒ để null để đi theo số tiền đã chốt khi duyệt (§11.5 ngoại lệ)
    amount_minor: amount === null || amount === ctx.voucherAmountMinor ? null : amount,
    existing_loan_id: null,
    terms,
  };
}

/** Số tiền vay hiệu lực: số tiền đã ghi, hoặc số tiền phiếu nếu để theo phiếu. */
export function effectiveLoanAmount(plan: { amount_minor: bigint | null }, voucherAmountMinor: bigint): bigint {
  return plan.amount_minor ?? voucherAmountMinor;
}

/* ================================================================== *
 * Chuyển nội bộ theo ID (§11.6)
 * ================================================================== */

/** Tài khoản nội bộ nhận chỉ dùng cho phiếu chi (và phiếu chuyển nội bộ v1); công ty nhận phải khác công ty phiếu. */
export function assertTransferTargetFits(
  kind: VoucherKind,
  target: { company_id: string } | null,
  companyId: string,
): void {
  if (!target) return;
  if (kind !== 'spend' && kind !== 'internal') {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Chỉ phiếu chi mới có đối tác công ty trong tập đoàn',
      errors: { transfer_target: 'Chỉ phiếu chi mới có tài khoản nội bộ nhận' },
    });
  }
  if (String(target.company_id) === companyId) {
    throw new ApiError({
      code: 'FG-VAL-001',
      detail: 'Công ty nhận phải khác công ty lập phiếu',
      errors: { 'transfer_target.company_id': 'Công ty nhận phải khác công ty lập phiếu' },
    });
  }
}

/**
 * Đích chuyển nội bộ có công ty nhận thì phải có TK đích theo ID (§11.6). Thiếu TK ⇒ R1 sau này không có nơi ghi
 * phiếu thu, trong khi tiền của phiếu chi đã ra khỏi công ty nguồn lúc thực thi — nên chặn ngay khi lưu.
 * `target` = null (không có chuyển nội bộ) ⇒ không kiểm.
 */
export function assertTransferTargetAccount(target: { account_id?: string | null } | null): void {
  if (!target || target.account_id) return;
  throw new ApiError({
    code: 'FG-VAL-001',
    detail: 'Chọn tài khoản nhận của công ty đích',
    errors: { 'transfer_target.account_id': 'Chọn tài khoản nhận của công ty đích' },
  });
}

/**
 * Đích chuyển nội bộ khi GỬI DUYỆT (§11.6): đúng loại phiếu, công ty nhận khác công ty phiếu và có TK đích theo ID.
 * Chỉ kiểm lại điều đã kiểm khi lưu (`resolveTransferTarget`) — để nháp lưu trước đó không lọt vào duyệt/thực thi.
 * Không có công ty nhận ⇒ không phải chuyển nội bộ ⇒ không kiểm.
 */
export function assertTransferTargetSubmittable(
  kind: VoucherKind,
  companyId: string,
  target: { company_id?: string | null; account_id?: string | null } | null | undefined,
): void {
  if (!target?.company_id) return;
  assertTransferTargetFits(kind, { company_id: String(target.company_id) }, companyId);
  assertTransferTargetAccount(target);
}

/* ================================================================== *
 * Sửa số tiền sau khi đã sinh khoản vay tự động (§11.5 — ngoại lệ)
 * ================================================================== */

/**
 * Cấp duyệt chỉ được đổi số tiền của phiếu CHI khi chưa có lượt R3 cho phiếu này.
 * `requested` = null hoặc bằng số tiền hiện tại ⇒ không phải sửa, luôn cho qua.
 */
export function assertAmountEditAllowed(current: bigint, requested: bigint | null, hasAutoLoanRun: boolean): void {
  if (requested === null || requested === current) return;
  if (hasAutoLoanRun) {
    throw new ApiError({
      code: 'FG-WF-005',
      detail: 'Phiếu đã tạo khoản vay tự động (R3) — không đổi số tiền được nữa',
    });
  }
}

/** Phiếu đã đóng thì không gắn liên kết thủ công. */
export function assertDocumentLinkable(status: string): void {
  if (LINK_CLOSED_DOCUMENT_STATUSES.includes(status)) {
    throw new ApiError({ code: 'FG-WF-005', detail: 'Phiếu đã đóng — không gán liên kết' });
  }
}

/* ================================================================== *
 * Liên kết thủ công từ phiếu (§11.2): quan hệ ⇒ loại đối tượng đích
 * ================================================================== */

export type ManualRelation = 'offset' | 'repayment' | 'disbursement';

/** Cấn trừ → khoản công nợ; trả nợ / giải ngân → khoản nợ ngân hàng. */
export function manualLinkTargetType(relation: ManualRelation): 'debt_voucher' | 'bank_debt' {
  return relation === 'offset' ? 'debt_voucher' : 'bank_debt';
}

/* ================================================================== *
 * Gỡ liên kết giải ngân theo lựa chọn vay trên phiếu (§11.2, §11.4 (b))
 * ================================================================== */

/** Lựa chọn vay đã lưu trên phiếu (`options.loan`) — chỉ các trường cần để kiểm. */
export interface StoredLoanChoice {
  kind?: unknown;
  mode?: unknown;
  existing_loan_id?: unknown;
}

/**
 * Liên kết giải ngân thủ công tới khoản vay ĐANG CHỌN trên phiếu thu ("Gắn khoản vay đã có") không gỡ tay, từ phiếu lẫn
 * từ màn khoản vay (cùng quy tắc FG-WF-005 như liên kết tự động): lần lưu phiếu sau gán lại theo lựa chọn, nên gỡ là vô
 * nghĩa và lựa chọn vay sẽ lệch với liên kết. Muốn gỡ thì đổi lựa chọn vay trên phiếu. Liên kết khác ⇒ không chặn.
 */
export function assertDisbursementNotChosenLoan(
  link: { origin?: unknown; relation?: unknown; to_type?: unknown; to_id?: unknown },
  storedLoan: StoredLoanChoice | null | undefined,
): void {
  if (link.origin !== 'manual' || link.relation !== 'disbursement' || link.to_type !== 'bank_debt') return;
  if (storedLoan?.kind !== 'borrow' || storedLoan.mode !== 'existing') return;
  if (storedLoan.existing_loan_id === null || storedLoan.existing_loan_id === undefined) return;
  if (String(storedLoan.existing_loan_id) !== String(link.to_id)) return;
  throw new ApiError({
    code: 'FG-WF-005',
    title: 'Khoản vay đang được chọn trên phiếu — không gỡ tay',
    detail: 'Liên kết giải ngân này theo lựa chọn "Gắn khoản vay đã có" của phiếu. Đổi lựa chọn vay trên phiếu để gỡ liên kết.',
  });
}

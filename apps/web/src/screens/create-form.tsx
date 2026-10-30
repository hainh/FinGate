/**
 * Khung "Hồ sơ form (create/edit)" — CHI-02 · THU-02 · RENEW-02 · NOI-BO (v2).
 *
 * v2 (v2/v2.md §5.2, §6.2, §11.4–11.6):
 * - Đối tác: ô chọn theo ID (PartnerPicker), không nhập tự do / không gõ "Tên - NH - STK". Lọc theo loại hợp lệ.
 *   "+ Tạo đối tác" mở popup NGAY trên form. Phiếu thu đi vay: bên nộp tiền bắt buộc là Ngân hàng.
 * - Tag: TagInput (gõ để tìm; "+ Tạo tag" nếu có quyền).
 * - Phiếu thu đi vay (R2): khối khoản vay — tạo mới / gắn khoản có sẵn / để sau.
 * - Phiếu chi vay để chi (R3): ngân hàng cho vay + TK nhận giải ngân (mặc định = TK nguồn) + số tiền vay + điều khoản.
 * - Phiếu chi có đối tác "Công ty trong tập đoàn" (R1) suy ra chuyển nội bộ; phiếu chuyển nội bộ chọn công ty + TK đích theo ID.
 * - Prefill từ query: ?partner_id (đối tác), ?kind (thu|chi, phải khớp form), ?loan=borrow (phiếu thu đi vay).
 *
 * Tiền nhập bằng parseMoneyInput (hỗ trợ "2,5 tỷ"); lỗi field hiển thị inline từ `problem.errors` (server).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import {
  DOC_KIND_LABEL,
  LOAN_MODE_LABEL,
  LOAN_MODES,
  REPAYMENT_METHODS,
  REPAYMENT_METHOD_LABEL,
  REPAYMENT_PERIODS,
  REPAYMENT_PERIOD_LABEL,
  bankDebtStatusLabel,
  formatMoney,
  moneyFromWire,
  money,
  normalizePlannedDate,
  statusLabel,
  type Money,
  type PartnerType,
} from '@fingate/shared';
import { ApiRequestError, apiCall, apiData } from '../app/api.ts';
import { SCOPE_ALL, useAuth, useCurrentCompanyId } from '../app/store.tsx';
import { useBankAccounts, useDocument } from '../app/queries.ts';
import type { DocumentDetail } from '../app/types.ts';
import { usePartner, usePartnerDebts, usePartnerLoans } from '../app/v2/partners.ts';
import { budgetLineLabel, useBudgetLineOptions, useVoucherCategories } from '../app/v2/vouchers.ts';
import { canAssignRepayment, interestRateText, principalOfSplit, useLoanList } from '../app/v2/debts.ts';
import {
  LOAN_OPEN_STATUSES,
  bankAccountOptionLabel,
  defaultLoanDueDate,
  loanOptionsBody,
  offsetDebtOptionLabel,
  offsetLoanOptionLabel,
  offsetOptionsBody,
  refreshDocumentAfterSave,
  rolloverLoanOptionLabel,
  useLoanDefaults,
  transferTargetBody,
  type LoanTermsValues,
  accountBorrowBody,
} from '../app/v2/documents.ts';
import { FgAlert, FgButton, FgField, FgInput, FgMoneyInput, FgNumber, FgSelect, FgTextarea, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgSegmented } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
import { PartnerPicker, partnerTypesFor } from '../components/partner-picker.tsx';
import { TagInput } from '../components/tag-input.tsx';

type PageKind = 'spend' | 'income' | 'rollover' | 'internal';

/** Tạm tắt ô Danh mục và Ngân sách / dòng ngân sách trên form phiếu (đặt true để bật lại). */
const SHOW_CATEGORY_BUDGET = false;

/** Khối khoản vay trên phiếu: thu đi vay (R2, `on` = "Đây là khoản vay ngân hàng") hoặc chi vay để chi (R3). */
interface LoanState {
  on: boolean;
  /** Phiếu thu đi vay: new | existing | later. Vay để chi luôn `new`. */
  mode: 'new' | 'existing' | 'later';
  existingLoanId: string;
  /** Vay để chi: ngân hàng cho vay (đối tác loại Ngân hàng). */
  lenderId: string | null;
  /** Vay để chi: TK ngân hàng của công ty nhận giải ngân. */
  receiveAccountId: string;
  /** Vay để chi: số tiền vay; null = bằng số tiền phiếu chi. */
  amount: Money | null;
  contractNo: string;
  interestRate: string;
  /** null = theo tham số kỳ hạn của công ty (không gửi số cứng). */
  termMonths: number | null;
  /** '' = theo tham số của công ty (ngày giải ngân + lệch tháng). */
  dueDate: string;
  repaymentPeriod: string;
  repaymentMethod: string;
  collateral: string;
}

/** Cấn trừ khoản vay trên phiếu chi (R7): khi duyệt xong, phiếu tự gán vào khoản đã chọn. */
interface OffsetState {
  on: boolean;
  /** Nợ ngân hàng (trả nợ, tách lãi / phí — chỉ phiếu chi) hoặc công nợ của KH/NCC: phải trả (phiếu chi), phải thu (phiếu thu). */
  target: 'bank_debt' | 'debt_voucher';
  targetId: string;
  /** null = toàn bộ số tiền phiếu. */
  amount: Money | null;
  /** Chỉ khoản vay ngân hàng. */
  interest: Money | null;
  fee: Money | null;
}

export interface FormState {
  title: string;
  purpose: string;
  partnerId: string | null;
  amount: Money | null;
  plannedDate: string;
  fund: 'bank' | 'cash';
  accountId: string;
  /** Danh mục thu/chi (US-VOU-01): quyết định chứng từ bắt buộc & matrix. */
  categoryId: string | null;
  /** Ngân sách / dòng ngân sách (§6.1). `inPlan = false` ⇒ khoản ngoài kế hoạch (người duyệt gõ lại số tiền). */
  budgetId: string | null;
  budgetLineId: string | null;
  inPlan: boolean;
  contractCode: string;
  /** Giá trị hợp đồng (§6.1) và ngày ký. */
  contractValue: Money | null;
  contractSignedAt: string;
  priority: string;
  note: string;
  tagIds: string[];
  loan: LoanState;
  /** Cấn trừ khoản vay (phiếu chi; phiếu thu chỉ cấn trừ công nợ phải thu). */
  offset: OffsetState;
  /** Phiếu chi mượn tiền từ TK khác cùng công ty (R8): thực thi xong tự sinh phiếu chi B → A + phiếu thu A ← B. */
  borrowOn: boolean;
  borrowAccountId: string;
  /** null = toàn bộ số tiền thực chi. */
  borrowAmount: Money | null;
  /** Chuyển nội bộ theo ID (luôn bật với phiếu chuyển nội bộ; phiếu chi suy từ đối tác). */
  transferOn: boolean;
  transferCompanyId: string;
  transferAccountId: string;
  /* đảo hạn */
  plan: string;
  newRate: string;
  rolloverCollateral: string;
  /** Khoản vay đang đảo hạn (v2 §10.3) — bắt buộc với phương án; cùng ngân hàng, đang vay / quá hạn. */
  rolloverLoanId: string;
  /** Ngày đáo hạn mới đề xuất (YYYY-MM-DD). */
  rolloverMaturity: string;
}

const emptyLoan = (): LoanState => ({
  on: false,
  mode: 'new',
  existingLoanId: '',
  lenderId: null,
  receiveAccountId: '',
  amount: null,
  contractNo: '',
  interestRate: '',
  termMonths: null,
  dueDate: '',
  repaymentPeriod: '',
  repaymentMethod: '',
  collateral: '',
});

const emptyOffset = (): OffsetState => ({ on: false, target: 'bank_debt', targetId: '', amount: null, interest: null, fee: null });

/** Hạn mặc định: 17:00 hôm nay; nếu đã qua thì 09:00 hôm sau. */
function defaultDeadline(): string {
  const now = dayjs();
  const todayEnd = now.hour(17).minute(0).second(0).millisecond(0);
  return (todayEnd.isAfter(now) ? todayEnd : todayEnd.add(1, 'day').hour(9)).format('YYYY-MM-DDTHH:mm');
}

const initial = (kind: PageKind): FormState => ({
  title: '',
  purpose: '',
  partnerId: null,
  amount: null,
  plannedDate: defaultDeadline(),
  fund: 'bank',
  accountId: '',
  categoryId: null,
  budgetId: null,
  budgetLineId: null,
  inPlan: true,
  contractCode: '',
  contractValue: null,
  contractSignedAt: '',
  priority: 'normal',
  note: '',
  tagIds: [],
  loan: emptyLoan(),
  offset: emptyOffset(),
  borrowOn: false,
  borrowAccountId: '',
  borrowAmount: null,
  transferOn: kind === 'internal',
  transferCompanyId: '',
  transferAccountId: '',
  plan: '',
  newRate: '',
  rolloverCollateral: '',
  rolloverLoanId: '',
  rolloverMaturity: '',
});

/** Cấn trừ đã lưu trên phiếu (sửa): số tiền / lãi / phí đi qua cùng kiểu với lúc nhập. */
function offsetFromDocument(doc: DocumentDetail): OffsetState {
  const o = doc.options?.offset ?? null;
  if (!o) return emptyOffset();
  const wire = (minor: string | null) => (minor ? moneyFromWire({ minor, currency: doc.amount.currency, decimals: 0 }) : null);
  return { on: true, target: o.target, targetId: o.target_id, amount: wire(o.amount_minor), interest: wire(o.interest_minor), fee: wire(o.fee_minor) };
}

/** Điền form từ hồ sơ đã lưu (sửa). Tiền/ngày/điều khoản đi qua cùng kiểu với lúc nhập. */
function formFromDocument(doc: DocumentDetail, kind: PageKind): FormState {
  const loan = doc.options?.loan ?? null;
  const loanKind = kind === 'income' ? 'borrow' : 'fund';
  const terms = loan?.terms ?? null;
  const loanAmount = loan?.amount_minor ? moneyFromWire({ minor: loan.amount_minor, currency: doc.amount.currency, decimals: 0 }) : null;
  return {
    title: doc.title,
    purpose: doc.purpose,
    partnerId: doc.partner_id ?? null,
    amount: moneyFromWire(doc.amount),
    plannedDate: normalizePlannedDate(doc.planned_date),
    fund: doc.source.fund,
    accountId: doc.source.account_id ?? '',
    categoryId: doc.category_id ?? null,
    budgetId: doc.budget?.budget_id ?? null,
    budgetLineId: doc.budget?.line_id ?? null,
    inPlan: doc.budget?.in_plan !== false,
    contractCode: doc.contract.code ?? '',
    contractValue: doc.contract.value ? moneyFromWire(doc.contract.value) : null,
    contractSignedAt: doc.contract.signed_at ?? '',
    priority: doc.priority,
    note: doc.note ?? '',
    tagIds: doc.tag_ids ?? [],
    loan:
      loan && loan.kind === loanKind
        ? {
            on: true,
            mode: loan.mode,
            existingLoanId: loan.existing_loan_id ?? '',
            lenderId: loan.lender_partner_id,
            receiveAccountId: loan.receive_account_id ?? '',
            amount: loanAmount,
            contractNo: terms?.contract_no ?? '',
            // hiển thị theo dấu phẩy VN như lúc nhập (dữ liệu lưu trước đây có thể là "9.5")
            interestRate: interestRateText(terms?.interest_rate),
            termMonths: terms?.term_months ?? null,
            dueDate: terms?.due_date ?? '',
            repaymentPeriod: terms?.repayment_period ?? '',
            repaymentMethod: terms?.repayment_method ?? '',
            collateral: terms?.collateral ?? '',
          }
        : emptyLoan(),
    offset: offsetFromDocument(doc),
    borrowOn: Boolean(doc.options?.account_borrow),
    borrowAccountId: doc.options?.account_borrow?.account_id ?? '',
    borrowAmount: doc.options?.account_borrow?.amount_minor
      ? moneyFromWire({ minor: doc.options.account_borrow.amount_minor, currency: doc.amount.currency, decimals: 0 })
      : null,
    transferOn: kind === 'internal',
    transferCompanyId: doc.transfer_target?.company_id ?? doc.target?.company_id ?? '',
    transferAccountId: doc.transfer_target?.account_id ?? doc.target?.account_id ?? '',
    plan: doc.rollover?.plan ?? '',
    newRate: doc.rollover?.new_rate ?? '',
    rolloverCollateral: doc.rollover?.collateral ?? '',
    rolloverLoanId: doc.loan_id ?? '',
    rolloverMaturity: doc.rollover?.new_maturity_date ?? '',
  };
}

/** Lãi suất nhập tay: số, dấu phẩy hoặc chấm, tối đa 2 chữ số thập phân — cùng quy tắc server (documents.ts, finance.ts). */
const RATE_TEXT_RE = /^\d+([.,]\d{1,2})?$/;

/** Lỗi của ô lãi suất nhập tay (trống = không có lỗi). */
export function rateTextError(raw: string): string | null {
  const s = raw.trim();
  return !s || RATE_TEXT_RE.test(s) ? null : 'Lãi suất dạng số, tối đa 2 chữ số thập phân';
}

/**
 * Đổi đối tác trên form (kể cả bỏ chọn). Khoản vay đã chọn — gắn có sẵn (R2) hoặc đảo hạn — thuộc ngân hàng cũ
 * ⇒ bỏ theo, để ô khoản vay không còn giữ khoản của ngân hàng khác (v2 §5.2, §10.3, §11.4). Chọn lại đúng đối tác đó ⇒ giữ nguyên.
 */
export function withPartner(f: FormState, partnerId: string | null): FormState {
  if (f.partnerId === partnerId) return f;
  // khoản cấn trừ thuộc đối tác cũ ⇒ bỏ theo (chọn lại khoản của đối tác mới)
  return { ...f, partnerId, loan: { ...f.loan, existingLoanId: '' }, rolloverLoanId: '', offset: { ...f.offset, targetId: '' } };
}

export function DocumentFormScreen({ kind }: { kind: PageKind }): ReactNode {
  const { id } = useParams<{ id?: string }>();
  const [query] = useSearchParams();
  const navigate = useNavigate();
  const currentCompany = useCurrentCompanyId();
  const { me, scope } = useAuth();
  const scopeAll = scope === SCOPE_ALL;
  const companyName = me?.companies.find((c) => c.company_id === currentCompany)?.company_name ?? null;
  const { message } = useToast();
  const qc = useQueryClient();
  const existing = useDocument(id);
  const accounts = useBankAccounts(currentCompany);
  const [f, setF] = useState<FormState>(() => initial(kind));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitAsDraft, setSubmitAsDraft] = useState(true);
  const prefilled = useRef(false);
  /** Nháp vừa tạo ở lượt lưu trước (gửi duyệt lỗi): lượt sau sửa phiếu này, không tạo nháp trùng. */
  const draftRef = useRef<{ id: string; version: number } | null>(null);

  const partnerQ = usePartner(f.partnerId);
  const partnerName = partnerQ.data?.name ?? '';
  /** Loại đối tác vừa chọn từ ô (có ngay, không chờ chi tiết tải xong). */
  const [pickedPartner, setPickedPartner] = useState<{ id: string; type: PartnerType } | null>(null);
  /** Loại của đối tác đang chọn: từ lựa chọn vừa rồi, hoặc từ chi tiết đã tải (đến sau). */
  const partnerType: PartnerType | null = !f.partnerId
    ? null
    : pickedPartner?.id === f.partnerId
      ? pickedPartner.type
      : partnerQ.data?._id === f.partnerId
        ? partnerQ.data.type
        : null;
  const isBorrow = kind === 'income' && f.loan.on;
  const isFund = kind === 'spend' && f.loan.on;
  const hasPartnerField = kind === 'spend' || kind === 'income' || kind === 'rollover';
  // Phiếu thu đi vay: bên nộp tiền chỉ là Ngân hàng (§11.4). Đảo hạn: ngân hàng (tuỳ chọn).
  // "Công ty trong tập đoàn" chỉ là bên nhận của phiếu chi (chuyển nội bộ suy từ đối tác)
  const partnerAllowed: PartnerType[] = isBorrow || kind === 'rollover' ? ['bank'] : partnerTypesFor(kind === 'income' ? ['bank', 'customer', 'supplier', 'other'] : null);
  const partnerDefault: PartnerType = isBorrow || kind === 'rollover' ? 'bank' : kind === 'income' ? 'customer' : 'supplier';
  const partnerLabel = kind === 'income' ? 'Bên nộp tiền' : kind === 'spend' ? 'Bên nhận tiền' : 'Ngân hàng';
  const partnerRequired = kind === 'spend' || kind === 'income';

  // §6.1 — danh mục, ngân sách, công nợ, hợp đồng: chỉ phiếu thu/chi (đảo hạn & chuyển nội bộ không dùng).
  const hasVoucherFinance = kind === 'spend' || kind === 'income';
  const categoriesQ = useVoucherCategories();
  const categoryOptions = (categoriesQ.data?.items ?? [])
    .filter((c) => c.active && c.doc_kind === kind)
    .map((c) => ({ value: c._id, label: c.code ? `${c.code} · ${c.name}` : c.name }));
  // danh mục bắt buộc khi GỬI DUYỆT (nháp thì chưa); chỉ đòi khi đã cấu hình danh mục cho loại phiếu này
  const categoryRequired = SHOW_CATEGORY_BUDGET && hasVoucherFinance && categoryOptions.length > 0;
  const budgetLinesQ = useBudgetLineOptions(currentCompany);
  const budgetLineOptions = (budgetLinesQ.data ?? []).map((o) => ({ value: `${o.budget_id}|${o.line_id}`, label: budgetLineLabel(o) }));
  /** Tạo mới và gửi duyệt ngay (không phải nháp, không phải sửa). */
  const submitNow = !id && !submitAsDraft;

  // Khoản vay có sẵn (phiếu thu đi vay, chế độ "gắn khoản đã có"): cùng ngân hàng, đang chờ giải ngân hoặc đang vay.
  const loansQ = usePartnerLoans(isBorrow && f.partnerId ? f.partnerId : undefined);
  // tham số vay mặc định của công ty đang lập phiếu (US-AUTO-07): hiển thị và tính hạn xem trước
  const loanDefaults = useLoanDefaults(currentCompany);
  // Khoản vay cho phương án đảo hạn: cùng ngân hàng (đối tác đã chọn), cùng công ty, đang vay / quá hạn (v2 §10.3).
  // chỉ tải khi ĐÃ chọn ngân hàng (không tải toàn bộ khoản vay của công ty rồi lọc trên trình duyệt)
  const rolloverLoans = useLoanList({ partner_id: f.partnerId || undefined, limit: 1000 }, { enabled: kind === 'rollover' && !!f.partnerId });
  const rolloverLoanOptions = (rolloverLoans.data?.items ?? []).filter(
    (l) => (l.status === 'active' || l.status === 'overdue') && l.company_id === currentCompany && (!f.partnerId || l.partner_id === f.partnerId),
  );
  const openLoans = (loansQ.data?.items ?? []).filter((l) => LOAN_OPEN_STATUSES.includes(l.status));

  // Cấn trừ khoản vay: phiếu chi — khoản còn trả được của ngân hàng đối tác, hoặc công nợ phải trả của KH/NCC;
  // phiếu thu — chỉ công nợ phải thu của KH/NCC (không có khoản vay ngân hàng để trả).
  const offsetEnabled = kind === 'spend' || kind === 'income';
  const offsetDirection = kind === 'income' ? 'receivable' : 'payable';
  const offsetPartnerId = offsetEnabled && f.offset.on && f.partnerId ? f.partnerId : undefined;
  const offsetLoansQ = usePartnerLoans(f.offset.target === 'bank_debt' ? offsetPartnerId : undefined);
  const offsetDebtsQ = usePartnerDebts(f.offset.target === 'debt_voucher' ? offsetPartnerId : undefined);
  const offsetCandidates: { value: string; label: string }[] =
    f.offset.target === 'bank_debt'
      ? (offsetLoansQ.data?.items ?? [])
          .filter((l) => canAssignRepayment(l.status) && l.company_id === currentCompany)
          .map((l) => ({ value: l._id, label: offsetLoanOptionLabel(l) }))
      : (offsetDebtsQ.data?.items ?? [])
          .filter((d) => d.direction === offsetDirection && d.status !== 'settled' && d.company_id === currentCompany)
          .map((d) => ({ value: d._id, label: offsetDebtOptionLabel(d) }));
  // sửa phiếu: khoản đã chọn không còn trong danh sách (đã tất toán, huỷ…) vẫn hiện tên để thấy lý do khi lưu
  const savedOffset = existing.data?.options?.offset ?? null;
  const offsetOptions =
    f.offset.targetId && savedOffset && savedOffset.target_id === f.offset.targetId && !offsetCandidates.some((o) => o.value === f.offset.targetId)
      ? [...offsetCandidates, { value: f.offset.targetId, label: `${savedOffset.target_code ?? 'Khoản đã chọn'} · không còn trong danh sách` }]
      : offsetCandidates;

  // Tài khoản: nguồn (theo hình thức tiền của phiếu) — ô này cũng là TK đích của phiếu thu; nhận giải ngân = TK ngân hàng của công ty lập phiếu.
  // Mọi nhãn đều có TÊN TK (phân biệt các TK cùng ngân hàng); ô nguồn gộp cả Tập đoàn nên thêm tên công ty đầu nhãn.
  const sourceAccountOptions = (accounts.data?.items ?? [])
    .filter((a) => a.status === 'active' && a.kind === f.fund)
    .map((a) => ({ value: a._id, label: bankAccountOptionLabel(a, true) }));
  const receiveAccountOptions = (accounts.data?.items ?? [])
    .filter((a) => a.status === 'active' && a.kind === 'bank' && !a.is_group && a.company_id === currentCompany)
    .map((a) => ({ value: a._id, label: bankAccountOptionLabel(a) }));

  // Mượn tiền: TK đang hoạt động khác của CHÍNH công ty lập phiếu (ngân hàng hoặc tiền mặt), trừ TK chi.
  const borrowAccountOptions = (accounts.data?.items ?? [])
    .filter((a) => a.status === 'active' && !a.is_group && a.company_id === currentCompany && a._id !== f.accountId)
    .map((a) => ({ value: a._id, label: bankAccountOptionLabel(a) }));

  // Chuyển nội bộ: công ty khác (trong danh bạ phạm vi) + TK đang hoạt động của công ty đó.
  const targetAccounts = useBankAccounts(f.transferCompanyId || null);
  // Công ty nhận: mọi công ty NGƯỜI DÙNG ĐƯỢC GÁN (me.companies), không chỉ công ty đang xem ở bộ chuyển phạm vi.
  const companyOptions = (me?.companies ?? [])
    .filter((c) => c.company_id !== currentCompany)
    .map((c) => ({ value: c.company_id, label: `${c.company_name} (${c.company_code})` }));
  const transferAccountOptions = (targetAccounts.data?.items ?? [])
    .filter((a) => a.status === 'active' && a.company_id === f.transferCompanyId)
    .map((a) => ({ value: a._id, label: bankAccountOptionLabel(a) }));

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));
  const setLoan = (patch: Partial<LoanState>) => setF((s) => ({ ...s, loan: { ...s.loan, ...patch } }));
  const setOffset = (patch: Partial<OffsetState>) => setF((s) => ({ ...s, offset: { ...s.offset, ...patch } }));
  // gốc tự tính = số tiền cấn trừ (hoặc cả phiếu) − lãi − phí; null khi lãi + phí vượt số tiền
  const offsetTotal = f.offset.amount?.minor ?? f.amount?.minor ?? 0n;
  const offsetPrincipal = principalOfSplit(offsetTotal, f.offset.interest?.minor ?? 0n, f.offset.fee?.minor ?? 0n);

  // Prefill: sửa (từ hồ sơ đã lưu) hoặc tạo mới với query (?partner_id, ?kind, ?loan=borrow). Một lần duy nhất.
  useEffect(() => {
    if (prefilled.current) return;
    if (id) {
      if (!existing.data) return;
      prefilled.current = true;
      setF(formFromDocument(existing.data, kind));
      return;
    }
    prefilled.current = true;
    const kindParam = query.get('kind');
    if (kindParam && kindParam !== kind) return; // link sai form: bỏ qua prefill
    const pid = query.get('partner_id');
    const borrow = kind === 'income' && query.get('loan') === 'borrow';
    // Lập phương án đảo hạn từ chi tiết khoản vay: ?loan_id= (+ partner_id ngân hàng) gắn sẵn khoản.
    const loanParam = kind === 'rollover' ? query.get('loan_id') : null;
    setF((s) => ({
      ...s,
      partnerId: pid || s.partnerId,
      loan: borrow ? { ...s.loan, on: true } : s.loan,
      rolloverLoanId: loanParam || s.rolloverLoanId,
    }));
  }, [id, existing.data, kind, query]);

  // Phiếu thu đi vay: bên nộp tiền chỉ là Ngân hàng (§11.4). Kiểm lại MỖI KHI loại đối tác biết được — kể cả
  // chi tiết đối tác tải xong sau khi đã bật "đi vay" hoặc người dùng chọn đối tác ngay sau khi bật.
  useEffect(() => {
    if (kind !== 'income' || !f.loan.on || !f.partnerId || !partnerType || partnerType === 'bank') return;
    message.info('Phiếu thu đi vay: bên nộp tiền phải là Ngân hàng — chọn lại đối tác');
    setF((s) => withPartner(s, null));
  }, [kind, f.loan.on, f.partnerId, partnerType, message]);

  /**
   * Điều khoản vay gửi lên: ô để trống ⇒ KHÔNG gửi số mặc định cứng. Server dùng tham số của công ty và tính lại
   * hạn theo ngày giải ngân thực tế (§11.4 (a)); chỉ ô người dùng đã nhập mới là điều khoản riêng.
   */
  const termsOf = (loan: LoanState): LoanTermsValues => ({
    contractNo: loan.contractNo,
    interestRate: loan.interestRate,
    termMonths: loan.termMonths,
    dueDate: loan.dueDate,
    repaymentPeriod: loan.repaymentPeriod,
    repaymentMethod: loan.repaymentMethod,
    collateral: loan.collateral,
  });

  const buildBody = (): Record<string, unknown> => {
    // Hồ sơ thuộc công ty đang chọn ở bộ chuyển phạm vi (§7.5), không phải công ty "active" của phiên.
    const company = currentCompany;
    const loanBody =
      kind === 'income' && f.loan.on
        ? loanOptionsBody({
            kind: 'borrow',
            mode: f.loan.mode,
            lenderPartnerId: f.partnerId,
            receiveAccountId: null,
            amountMinor: null,
            existingLoanId: f.loan.existingLoanId || null,
            terms: termsOf(f.loan),
          })
        : kind === 'spend' && f.loan.on
          ? loanOptionsBody({
              kind: 'fund',
              mode: 'new',
              lenderPartnerId: f.loan.lenderId,
              receiveAccountId: f.loan.receiveAccountId || null,
              amountMinor: f.loan.amount ? f.loan.amount.minor.toString() : null,
              existingLoanId: null,
              terms: termsOf(f.loan),
            })
          : null;
    // cấn trừ khoản vay chỉ phiếu thu / chi; luôn gửi (kể cả null) để sửa phiếu bỏ được cấn trừ đã lưu
    const offsetBody =
      offsetEnabled
        ? offsetOptionsBody({
            on: f.offset.on,
            target: f.offset.target,
            targetId: f.offset.targetId,
            amountMinor: f.offset.amount ? f.offset.amount.minor.toString() : null,
            interestMinor: f.offset.interest ? f.offset.interest.minor.toString() : null,
            feeMinor: f.offset.fee ? f.offset.fee.minor.toString() : null,
          })
        : null;
    const transfer = transferTargetBody(f.transferOn, f.transferCompanyId, f.transferAccountId);
    const body: Record<string, unknown> = {
      kind,
      company_id: company,
      title: f.title || defaultTitle(kind, partnerName, f.amount),
      purpose: f.purpose,
      partner_id: f.partnerId,
      amount: f.amount ? { amount_minor: f.amount.minor.toString(), currency: f.amount.currency } : undefined,
      source: { fund: f.fund, account_id: f.accountId || null, group_managed: false },
      planned_date: f.plannedDate,
      priority: f.priority,
      category_id: f.categoryId,
      budget: { budget_id: f.budgetId, line_id: f.budgetLineId, in_plan: f.inPlan },
      contract: {
        code: f.contractCode || undefined,
        value: f.contractValue ? { amount_minor: f.contractValue.minor.toString(), currency: f.contractValue.currency } : undefined,
        signed_at: f.contractSignedAt || undefined,
      },
      note: f.note || undefined,
      tag_ids: f.tagIds,
      options: {
        loan: loanBody,
        offset: offsetBody,
        // luôn gửi với phiếu chi (kể cả null) để sửa phiếu bỏ được lựa chọn mượn tiền đã lưu
        account_borrow: kind === 'spend' ? accountBorrowBody(f.borrowOn, f.borrowAccountId, f.borrowAmount ? f.borrowAmount.minor.toString() : null) : null,
      },
      transfer_target: transfer,
    };
    if (kind === 'rollover') {
      // Phương án gắn khoản vay (server kiểm công ty, ngân hàng, trạng thái) và ngày đáo hạn mới đề xuất.
      body.loan_id = f.rolloverLoanId || null;
      body.rollover = {
        need_amount: f.amount ? { amount_minor: f.amount.minor.toString(), currency: f.amount.currency } : undefined,
        plan: f.plan,
        new_maturity_date: f.rolloverMaturity || undefined,
        new_rate: f.newRate.trim() || undefined,
        collateral: f.rolloverCollateral || undefined,
      };
    }
    return body;
  };

  const save = async () => {
    if (scopeAll) {
      message.error('Chưa chọn công ty — chọn công ty ở bộ chuyển phạm vi (góc trên) trước khi lưu phiếu');
      return;
    }
    // Sửa phiếu: chỉ lưu khi đã tải được hồ sơ (phiên bản để kiểm xung đột lấy từ hồ sơ đó, không đoán).
    const loadedVersion = id ? existing.data?.version : undefined;
    if (id && typeof loadedVersion !== 'number') {
      message.error('Chưa tải xong hồ sơ — chưa thể lưu');
      return;
    }
    // Kiểm tra nhanh các trường v2 bắt buộc; server vẫn kiểm lần cuối và trả lỗi theo field.
    const clientErrors: Record<string, string> = {};
    if (!f.amount) clientErrors.amount = 'Nhập số tiền';
    if (partnerRequired && !f.partnerId) clientErrors.partner_id = 'Chọn đối tác';
    if (kind === 'rollover') {
      if (!f.rolloverLoanId) clientErrors.loan_id = 'Chọn khoản vay đang đảo hạn (cùng ngân hàng)';
      if (!f.rolloverMaturity) clientErrors['rollover.new_maturity_date'] = 'Chọn ngày đáo hạn mới';
      const newRateErr = rateTextError(f.newRate);
      if (newRateErr) clientErrors['rollover.new_rate'] = newRateErr;
    }
    if (isBorrow && f.loan.mode === 'existing' && !f.loan.existingLoanId) clientErrors['options.loan.existing_loan_id'] = 'Chọn khoản vay đã có';
    // điều khoản vay hiện trên form (vay để chi, hoặc thu đi vay tạo mới): lãi suất cùng quy tắc 2 chữ số thập phân
    if ((isFund || (isBorrow && f.loan.mode === 'new')) && rateTextError(f.loan.interestRate)) {
      clientErrors['options.loan.terms.interest_rate'] = 'Lãi suất dạng số, tối đa 2 chữ số thập phân';
    }
    if (isFund && !f.loan.lenderId) clientErrors['options.loan.lender_partner_id'] = 'Chọn ngân hàng cho vay';
    if (isFund && !f.loan.receiveAccountId) clientErrors['options.loan.receive_account_id'] = 'Chọn tài khoản nhận giải ngân';
    if (offsetEnabled && f.offset.on) {
      if (!f.offset.targetId) clientErrors['options.offset.target_id'] = 'Chọn khoản vay hoặc công nợ cần cấn trừ';
      if (f.offset.target === 'bank_debt' && offsetTotal > 0n && offsetPrincipal === null) {
        clientErrors['options.offset.interest_minor'] = 'Lãi + phí không được vượt số tiền cấn trừ';
      }
    }
    if (kind === 'spend' && f.borrowOn) {
      if (!f.borrowAccountId) clientErrors['options.account_borrow.account_id'] = 'Chọn tài khoản cho mượn';
      else if (f.borrowAccountId === f.accountId) clientErrors['options.account_borrow.account_id'] = 'Tài khoản cho mượn phải khác tài khoản chi';
      if (f.borrowAmount && f.amount && f.borrowAmount.minor > f.amount.minor) clientErrors['options.account_borrow.amount_minor'] = 'Số tiền mượn không được vượt số tiền phiếu chi';
    }
    if (f.transferOn && !f.transferCompanyId) clientErrors['transfer_target.company_id'] = 'Chọn công ty nhận';
    if (f.transferOn && f.transferCompanyId && !f.transferAccountId) clientErrors['transfer_target.account_id'] = 'Chọn tài khoản nhận';
    // Gửi duyệt cần tài khoản nguồn (server: FG-WF-008) và danh mục (US-VOU-01): chặn ngay ở client, không tạo nháp rồi mới lỗi.
    if (submitNow) {
      if (!f.accountId) clientErrors['source.account_id'] = 'Chọn tài khoản trước khi gửi duyệt';
      if (categoryRequired && !f.categoryId) clientErrors.category_id = 'Chọn danh mục trước khi gửi duyệt';
    }
    if (Object.keys(clientErrors).length) {
      setErrors(clientErrors);
      message.error('Kiểm tra lại các trường còn thiếu');
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const body = buildBody();
      // Đã có phiếu (sửa) hoặc nháp vừa tạo ở lượt trước (gửi duyệt lỗi): SỬA phiếu đó, KHÔNG tạo nháp thứ hai.
      const knownId = id ?? draftRef.current?.id ?? null;
      let docId: string;
      let version: number;
      /** Chi tiết vừa lưu (PATCH trả về cùng dạng GET): đặt vào bản đệm để màn chi tiết không hiện bản trước khi sửa. */
      let saved: DocumentDetail | null = null;
      if (knownId) {
        const ifMatch = typeof loadedVersion === 'number' ? loadedVersion : (draftRef.current?.version ?? 1);
        const res = await apiCall<{ version?: number; data?: DocumentDetail }>(`/documents/${knownId}`, { method: 'PATCH', body: { ...body, if_match: ifMatch } });
        docId = knownId;
        version = res.version ?? ifMatch;
        saved = res.data ?? null;
      } else {
        const created = await apiData<{ _id: string; version: number }>('/documents', { method: 'POST', body });
        docId = created._id;
        version = created.version;
      }
      if (!id) draftRef.current = { id: docId, version };
      // Làm tươi trước khi sang màn chi tiết (kể cả khi bước gửi duyệt sau đó lỗi: hồ sơ đã được lưu).
      // Lượt gửi duyệt đổi trạng thái sau PATCH ⇒ không đặt bản PATCH vào bản đệm.
      refreshDocumentAfterSave(qc, scope, docId, submitNow ? null : saved);
      if (submitNow) {
        // gửi duyệt: lỗi ở đây giữ nguyên nháp (draftRef) để lần bấm sau không tạo trùng
        await apiData(`/documents/${docId}/transition`, { method: 'POST', body: { action: 'submit', if_match: version } });
        draftRef.current = null;
        message.success('Đã gửi duyệt');
      } else {
        message.success(id ? 'Đã lưu bản nháp' : 'Đã tạo nháp');
      }
      navigate(`/ho-so/${pathKind(kind)}/${docId}`);
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setErrors(e.problem.errors ?? {});
        message.error(e.problem.title + (e.problem.detail ? ` — ${e.problem.detail}` : ''));
      } else message.error('Không lưu được');
      if (submitNow && draftRef.current) {
        message.warning('Phiếu đã lưu thành nháp nhưng chưa gửi duyệt — sửa theo thông báo rồi bấm lại (không tạo thêm nháp)');
      }
    } finally {
      setBusy(false);
    }
  };

  const loaded = id ? existing.data : null;
  // Sửa: chỉ sửa được khi đã tải hồ sơ và hồ sơ cho phép sửa (đang tải ⇒ khoá, không lưu theo phiên bản đoán).
  const canEdit = id ? (loaded?.can.edit ?? false) : true;
  const lockedAfterApproval = !!loaded && !loaded.can.edit;
  const titlePrefix = `${id ? 'Sửa' : 'Tạo mới'} ${DOC_KIND_LABEL[kind].toLowerCase()}`;
  const pageTitle = !scopeAll && companyName ? `${titlePrefix} cho ${companyName}` : titlePrefix;

  // Không tải được hồ sơ (vd. 403 ngoài phạm vi): hiện trạng thái lỗi như màn chi tiết (ERR-01), không hiện form trống.
  // Lỗi tải lại nền sau khi đã có hồ sơ không thay form đang sửa.
  if (id && existing.isError && !existing.data) {
    return (
      <>
        <FgPageHeader title={pageTitle} />
        <FgQuery query={existing} skeleton={null}>
          {() => null}
        </FgQuery>
      </>
    );
  }

  /** Phiếu chi vay để chi: TK nguồn và TK nhận giải ngân luôn là một — đổi ô nào cũng ghi cả hai (§11.5). */
  const pickLinkedAccount = (accountId: string) =>
    setF((s) => ({
      ...s,
      accountId,
      loan: { ...s.loan, receiveAccountId: accountId },
      fund: 'bank',
    }));

  return (
    <>
      <FgPageHeader title={pageTitle} meta="Nháp tự lưu trên máy — gửi duyệt khi đủ chứng từ" />
      {lockedAfterApproval ? (
        <FgAlert tone="warning" title="Hồ sơ đã qua cấp duyệt, không sửa được nữa" description="Chỉ người tạo có thể sửa khi còn Nháp / Yêu cầu bổ sung." style={{ marginBottom: 16 }} />
      ) : null}
      {scopeAll ? (
        <FgAlert
          tone="warning"
          title="Chưa chọn công ty"
          description="Phiếu phải thuộc một công ty cụ thể. Đang để “Toàn tập đoàn” — chọn công ty ở bộ chuyển phạm vi (góc trên bên phải) trước khi lưu."
          style={{ marginBottom: 16 }}
        />
      ) : null}
      <div className="fg-form-grid">
        <FgCard>
          <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Nội dung / mục đích *" error={errors.purpose ?? (f.purpose && f.purpose.length < 3 ? 'Tối thiểu 3 ký tự' : null)}>
                <FgTextarea value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="VD: Thanh toán đợt 2 hợp đồng 45/2026 theo biên bản nghiệm thu" disabled={!canEdit} />
              </FgField>
            </div>
            <FgField label="Tiêu đề (bỏ trống sẽ tự sinh)" error={errors.title}>
              <FgInput value={f.title} onChange={(e) => set('title', e.target.value)} disabled={!canEdit} />
            </FgField>
            {hasPartnerField ? (
              <div style={{ gridColumn: 'span 1' }}>
                <PartnerPicker
                  label={partnerLabel}
                  required={partnerRequired}
                  value={f.partnerId}
                  onChange={(id, p) => {
                    // đổi đối tác ⇒ bỏ khoản vay đã chọn của ngân hàng cũ (withPartner)
                    setF((s) => withPartner(s, id));
                    setPickedPartner(id && p ? { id, type: p.type } : null);
                  }}
                  allowedTypes={partnerAllowed}
                  defaultType={partnerDefault}
                  companyId={currentCompany}
                  disabled={!canEdit || scopeAll || !currentCompany}
                  error={errors.partner_id ?? null}
                  placeholder={kind === 'income' ? 'Tìm khách hàng / ngân hàng…' : kind === 'spend' ? 'Tìm nhà cung cấp / đối tác…' : 'Tìm ngân hàng…'}
                />
              </div>
            ) : null}
            <FgField label="Số tiền *" error={errors.amount ?? (f.amount === null ? 'Chưa nhập' : null)} help={f.amount ? formatMoney(f.amount, { mode: 'full' }) : 'Gõ "2,5 tỷ" hoặc "850 tr" — hệ thống hiểu cả hai'}>
              <FgMoneyInput value={f.amount} onChange={(m) => set('amount', m)} disabled={!canEdit} />
            </FgField>
            <FgField label="Hạn thanh toán (deadline) *" error={errors.planned_date}>
              <DatePicker
                showTime={{ format: 'HH:mm' }}
                format="DD/MM/YYYY HH:mm"
                value={f.plannedDate ? dayjs(f.plannedDate) : null}
                onChange={(v) => set('plannedDate', v ? v.format('YYYY-MM-DDTHH:mm') : '')}
                disabled={!canEdit}
                style={{ width: '100%' }}
                placeholder="Chọn ngày giờ"
              />
            </FgField>
            <FgField label={kind === 'income' ? 'Hình thức nhận tiền *' : 'Nguồn tiền *'}>
              <FgSelect
                options={[
                  { value: 'bank', label: 'Tài khoản ngân hàng' },
                  { value: 'cash', label: 'Quỹ tiền mặt' },
                ]}
                value={f.fund}
                onChange={(v) => {
                  set('fund', v === 'cash' ? 'cash' : 'bank');
                  set('accountId', '');
                }}
                style={{ width: '100%' }}
                disabled={!canEdit || isFund}
              />
            </FgField>
            <FgField
              label={kind === 'income' ? 'Tài khoản đích *' : 'Tài khoản nguồn *'}
              error={errors['source.account_id'] ?? null}
              help={kind === 'income' ? 'Tiền thu về tài khoản của công ty lập phiếu' : 'Chỉ tài khoản của công ty lập phiếu'}
            >
              <FgSelect
                options={isFund ? receiveAccountOptions : sourceAccountOptions}
                value={f.accountId}
                onChange={(v) => (isFund ? pickLinkedAccount(v ?? '') : set('accountId', v ?? ''))}
                placeholder={f.fund === 'cash' ? 'Chọn quỹ tiền mặt' : 'Chọn tài khoản ngân hàng'}
                allowClear
                style={{ width: '100%' }}
                disabled={!canEdit}
              />
            </FgField>
            <FgField label="Hợp đồng / căn cứ" error={errors['contract.code']}>
              <FgInput value={f.contractCode} onChange={(e) => set('contractCode', e.target.value)} placeholder="HĐ 45/2026" disabled={!canEdit} />
            </FgField>
            {hasVoucherFinance ? (
              <>
                <FgField label="Giá trị hợp đồng" error={errors['contract.value'] ?? null} help={f.contractValue ? formatMoney(f.contractValue, { mode: 'full' }) : 'Bỏ trống nếu không có hợp đồng'}>
                  <FgMoneyInput value={f.contractValue} onChange={(m) => set('contractValue', m)} disabled={!canEdit} placeholder="Giá trị HĐ" ariaLabel="Giá trị hợp đồng" />
                </FgField>
                <FgField label="Ngày ký hợp đồng" error={errors['contract.signed_at'] ?? null}>
                  <DatePicker
                    value={f.contractSignedAt ? dayjs(f.contractSignedAt) : null}
                    onChange={(d) => set('contractSignedAt', d ? d.format('YYYY-MM-DD') : '')}
                    format="DD/MM/YYYY"
                    style={{ width: '100%' }}
                    disabled={!canEdit}
                    placeholder="Chọn ngày"
                  />
                </FgField>
              </>
            ) : null}
            <FgField label="Mức ưu tiên">
              <FgSelect
                options={[
                  { value: 'low', label: 'Thấp' },
                  { value: 'normal', label: 'Thường' },
                  { value: 'high', label: 'Cao' },
                  { value: 'urgent', label: 'Khẩn' },
                ]}
                value={f.priority}
                onChange={(v) => set('priority', v ?? 'normal')}
                style={{ width: '100%' }}
                disabled={!canEdit}
              />
            </FgField>
            {hasVoucherFinance ? (
              <>
                {SHOW_CATEGORY_BUDGET ? (
                  <>
                  <FgField
                    label={categoryRequired ? 'Danh mục *' : 'Danh mục'}
                    error={errors.category_id ?? null}
                    help={categoryOptions.length ? 'Quyết định chứng từ bắt buộc và cấp duyệt' : 'Chưa cấu hình danh mục cho loại phiếu này'}
                  >
                    <FgSelect
                      options={categoryOptions}
                      value={f.categoryId ?? undefined}
                      onChange={(v) => set('categoryId', v ?? null)}
                      placeholder="Chọn danh mục"
                      allowClear
                      style={{ width: '100%' }}
                      disabled={!canEdit}
                    />
                  </FgField>
                  <FgField
                    label="Ngân sách / dòng ngân sách"
                    error={errors['budget.line_id'] ?? errors['budget.budget_id'] ?? null}
                    help={budgetLineOptions.length ? undefined : 'Không có dòng ngân sách trong phạm vi (cần quyền xem ngân sách)'}
                  >
                    <FgSelect
                      options={budgetLineOptions}
                      value={f.budgetId && f.budgetLineId ? `${f.budgetId}|${f.budgetLineId}` : undefined}
                      onChange={(v) => {
                        const [budgetId, lineId] = (v ?? '').split('|');
                        setF((s) => ({ ...s, budgetId: budgetId || null, budgetLineId: lineId || null }));
                      }}
                      placeholder="Chọn dòng ngân sách"
                      allowClear
                      style={{ width: '100%' }}
                      disabled={!canEdit}
                    />
                  </FgField>
                  </>
                ) : null}
                <FgField label="Trong kế hoạch" help={f.inPlan ? 'Khoản trong kế hoạch ngân sách' : 'Ngoài kế hoạch: người duyệt phải gõ lại số tiền để xác nhận'}>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, cursor: canEdit ? 'pointer' : 'not-allowed' }}>
                    <input type="checkbox" checked={f.inPlan} onChange={(e) => set('inPlan', e.target.checked)} style={{ width: 18, height: 18 }} disabled={!canEdit} />
                    Khoản trong kế hoạch
                  </label>
                </FgField>
              </>
            ) : null}
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Tag" help="Gõ để tìm tag có sẵn hoặc tạo tag mới (nhãn tự do: dự án, công trình, đợt…)" error={errors.tag_ids}>
                <TagInput value={f.tagIds} onChange={(ids) => set('tagIds', ids)} companyId={currentCompany} disabled={!canEdit || scopeAll} knownTags={loaded?.tags} />
              </FgField>
            </div>
            {kind === 'rollover' ? (
              <>
                <FgField label="Khoản vay đang đảo hạn *" error={errors.loan_id} help="Chỉ khoản đang vay / quá hạn của ngân hàng đã chọn">
                  <FgSelect
                    value={f.rolloverLoanId || undefined}
                    onChange={(v) => {
                      const picked = rolloverLoanOptions.find((l) => l._id === v);
                      setF((s) => ({ ...s, rolloverLoanId: String(v ?? ''), partnerId: picked?.partner_id ?? s.partnerId }));
                    }}
                    options={rolloverLoanOptions.map((l) => ({ value: l._id, label: rolloverLoanOptionLabel(l) }))}
                    placeholder={f.partnerId ? 'Chọn khoản vay của ngân hàng này' : 'Chọn ngân hàng cho vay trước'}
                    disabled={!canEdit || !f.partnerId}
                    style={{ width: '100%' }}
                  />
                </FgField>
                <FgField label="Ngày đáo hạn mới *" error={errors['rollover.new_maturity_date']} help="Ngày đáo hạn sau khi ngân hàng gia hạn">
                  <DatePicker
                    value={f.rolloverMaturity ? dayjs(f.rolloverMaturity) : null}
                    onChange={(d) => set('rolloverMaturity', d ? d.format('YYYY-MM-DD') : '')}
                    format="DD/MM/YYYY"
                    style={{ width: '100%' }}
                    disabled={!canEdit}
                  />
                </FgField>
                <div style={{ gridColumn: '1/-1' }}>
                  <FgField label="Phương án đảo hạn *" error={errors['rollover.plan']}>
                    <FgTextarea value={f.plan} onChange={(e) => set('plan', e.target.value)} placeholder="VD: Gia hạn 12 tháng tại BIDV, tài sản đảm bảo giữ nguyên, phí 0,3%" disabled={!canEdit} />
                  </FgField>
                </div>
                <FgField label="Lãi suất mới (%/năm)" error={errors['rollover.new_rate'] ?? null}>
                  <FgInput value={f.newRate} onChange={(e) => set('newRate', e.target.value)} placeholder="9,50" disabled={!canEdit} />
                </FgField>
                <FgField label="Tài sản đảm bảo">
                  <FgInput value={f.rolloverCollateral} onChange={(e) => set('rolloverCollateral', e.target.value)} disabled={!canEdit} />
                </FgField>
              </>
            ) : null}
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Ghi chú">
                <FgTextarea value={f.note} onChange={(e) => set('note', e.target.value)} disabled={!canEdit} />
              </FgField>
            </div>
          </div>

          {/* ---------- Phiếu thu: đi vay ngân hàng (R2) ---------- */}
          {kind === 'income' ? (
            <Section title="Khoản vay ngân hàng">
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: canEdit ? 'pointer' : 'not-allowed' }}>
                <input
                  type="checkbox"
                  checked={f.loan.on}
                  // bật "đi vay" ⇒ bên nộp tiền phải là Ngân hàng: effect ở trên bỏ đối tác không phải ngân hàng
                  // đi vay và cấn trừ khoản phải thu không đi cùng nhau: bật đi vay thì tắt cấn trừ
                  onChange={(e) => {
                    const on = e.target.checked;
                    setF((s) => ({ ...s, loan: { ...s.loan, on }, offset: on && s.offset.on ? { ...s.offset, on: false } : s.offset }));
                  }}
                  style={{ width: 18, height: 18, marginTop: 1 }}
                  disabled={!canEdit}
                />
                <span>
                  Đây là khoản vay ngân hàng (đi vay)
                  <br />
                  <span style={{ color: 'var(--fg-text-muted)' }}>
                    Bên nộp tiền là Ngân hàng cho vay. Khi phiếu được duyệt &amp; thực thi, khoản nợ ngân hàng được tạo hoặc kích hoạt (gốc = số tiền thu).
                  </span>
                </span>
              </label>
              {f.loan.on ? (
                <div style={{ display: 'grid', gap: 'var(--fg-space-3)', marginTop: 'var(--fg-space-3)' }}>
                  <FgSegmented
                    value={f.loan.mode}
                    onChange={(v) => setLoan({ mode: v as LoanState['mode'] })}
                    options={LOAN_MODES.map((m) => ({ value: m, label: LOAN_MODE_LABEL[m] }))}
                    disabled={!canEdit}
                  />
                  {f.loan.mode === 'new' ? (
                    <FgText style="caption" color="muted">
                      Gốc khoản vay = số tiền phiếu thu{f.amount ? ` (${formatMoney(f.amount, { mode: 'full' })})` : ''}. Hạn thanh toán mặc định = ngày giải ngân
                      {loanDefaults.data ? ` + ${loanDefaults.data.borrow.due_offset_months} tháng` : ' + theo cấu hình công ty'}; sửa được.
                    </FgText>
                  ) : null}
                  {f.loan.mode === 'new' ? (
                    <LoanTermsFields
                      value={f.loan}
                      onChange={setLoan}
                      baseDate={f.plannedDate}
                      disabled={!canEdit}
                      errors={errors}
                      defaults={loanDefaults.data?.borrow ?? null}
                    />
                  ) : null}
                  {f.loan.mode === 'existing' ? (
                    <FgField
                      label="Khoản vay có sẵn *"
                      error={errors['options.loan.existing_loan_id'] ?? null}
                      help={
                        !f.partnerId
                          ? 'Chọn ngân hàng cho vay trước'
                          : openLoans.length
                            ? 'Khoản của cùng ngân hàng, đang chờ giải ngân hoặc đang vay'
                            : 'Ngân hàng này chưa có khoản vay chờ giải ngân / đang vay'
                      }
                    >
                      <FgSelect
                        options={openLoans.map((l) => ({
                          value: l._id,
                          label: `${l.code} · ${bankDebtStatusLabel(l.status)} · gốc ${formatMoney(moneyFromWire(l.principal) ?? money('0'), { mode: 'compact' })}`,
                        }))}
                        value={f.loan.existingLoanId || undefined}
                        onChange={(v) => setLoan({ existingLoanId: v ?? '' })}
                        placeholder="Chọn khoản vay"
                        style={{ width: '100%' }}
                        disabled={!canEdit || !f.partnerId}
                      />
                    </FgField>
                  ) : null}
                  {f.loan.mode === 'later' ? (
                    <FgText style="caption" color="muted">
                      Phiếu chỉ mang cờ. Gán khoản vay sau từ tab Liên kết của phiếu hoặc từ khoản vay.
                    </FgText>
                  ) : null}
                </div>
              ) : null}
            </Section>
          ) : null}

          {/* ---------- Phiếu chi: vay ngân hàng để chi (R3) ---------- */}
          {kind === 'spend' ? (
            <Section title="Vay ngân hàng để chi">
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: canEdit ? 'pointer' : 'not-allowed' }}>
                <input
                  type="checkbox"
                  checked={f.loan.on}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setF((s) => {
                      // vay để chi: TK nguồn và TK nhận giải ngân dùng chung một giá trị (ưu tiên TK đã chọn sẵn)
                      const linked = on ? s.loan.receiveAccountId || s.accountId : null;
                      return {
                        ...s,
                        loan: { ...s.loan, on, ...(linked !== null ? { receiveAccountId: linked } : {}) },
                        fund: on ? 'bank' : s.fund,
                        // vay để chi và cấn trừ khoản vay không đi cùng nhau: bật vay thì tắt cấn trừ
                        offset: on && s.offset.on ? { ...s.offset, on: false } : s.offset,
                        // vay để chi và mượn tiền TK khác không đi cùng nhau
                        borrowOn: on ? false : s.borrowOn,
                        accountId: linked !== null ? linked : s.accountId,
                      };
                    });
                  }}
                  style={{ width: 18, height: 18, marginTop: 1 }}
                  disabled={!canEdit}
                />
                <span>
                  Vay ngân hàng để chi
                  <br />
                  <span style={{ color: 'var(--fg-text-muted)' }}>
                    Tiền do ngân hàng giải ngân về tài khoản của công ty, rồi công ty chi từ tài khoản đó. Khoản vay được tạo khi phiếu được duyệt.
                  </span>
                </span>
              </label>
              {f.loan.on ? (
                <div style={{ display: 'grid', gap: 'var(--fg-space-3)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', marginTop: 'var(--fg-space-3)' }}>
                  <PartnerPicker
                    label="Ngân hàng cho vay"
                    required
                    value={f.loan.lenderId}
                    onChange={(id) => setLoan({ lenderId: id })}
                    allowedTypes={['bank']}
                    defaultType="bank"
                    companyId={currentCompany}
                    disabled={!canEdit || scopeAll || !currentCompany}
                    error={errors['options.loan.lender_partner_id'] ?? null}
                    placeholder="Chỉ chọn đối tác Ngân hàng…"
                  />
                  <FgField
                    label="Tài khoản nhận giải ngân *"
                    error={errors['options.loan.receive_account_id'] ?? null}
                    help="Tài khoản ngân hàng của công ty. Mặc định cũng là tài khoản nguồn của phiếu chi."
                  >
                    <FgSelect
                      options={receiveAccountOptions}
                      value={f.loan.receiveAccountId || undefined}
                      onChange={(v) => pickLinkedAccount(v ?? '')}
                      placeholder="Chọn tài khoản ngân hàng"
                      style={{ width: '100%' }}
                      disabled={!canEdit}
                    />
                  </FgField>
                  <FgField
                    label="Số tiền vay"
                    error={errors['options.loan.amount_minor'] ?? null}
                    help={f.amount ? `Bỏ trống = bằng số tiền phiếu chi (${formatMoney(f.amount, { mode: 'compact' })})` : 'Bỏ trống = bằng số tiền phiếu chi'}
                  >
                    <FgMoneyInput value={f.loan.amount} onChange={(m) => setLoan({ amount: m })} disabled={!canEdit} placeholder="Bằng số tiền phiếu chi" />
                  </FgField>
                  <div style={{ gridColumn: '1/-1' }}>
                    <LoanTermsFields value={f.loan} onChange={setLoan} baseDate={f.plannedDate} disabled={!canEdit} errors={errors} defaults={loanDefaults.data?.fund ?? null} />
                  </div>
                </div>
              ) : null}
            </Section>
          ) : null}

          {/* ---------- Phiếu chi: mượn tiền từ tài khoản khác cùng công ty (R8) ---------- */}
          {kind === 'spend' ? (
            <Section title="Mượn tiền từ tài khoản khác">
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: canEdit && !f.loan.on ? 'pointer' : 'not-allowed' }}>
                <input
                  type="checkbox"
                  checked={f.borrowOn}
                  onChange={(e) => set('borrowOn', e.target.checked)}
                  style={{ width: 18, height: 18, marginTop: 1 }}
                  disabled={!canEdit || f.loan.on}
                />
                <span>
                  Mượn tiền từ tài khoản khác của công ty
                  <br />
                  <span style={{ color: 'var(--fg-text-muted)' }}>
                    Khi phiếu được duyệt và thực thi, hệ thống tự tạo phiếu chi từ tài khoản cho mượn sang tài khoản chi của phiếu này và phiếu thu tương ứng (đã
                    duyệt, đã thực thi) — tổng cộng 3 phiếu.
                    {f.loan.on ? ' Không dùng cùng lúc với "Vay ngân hàng để chi".' : ''}
                  </span>
                </span>
              </label>
              {f.borrowOn ? (
                <div style={{ display: 'grid', gap: 'var(--fg-space-3)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', marginTop: 'var(--fg-space-3)' }}>
                  <FgField
                    label="Tài khoản cho mượn *"
                    error={errors['options.account_borrow.account_id'] ?? null}
                    help="Tài khoản khác của cùng công ty, khác tài khoản chi"
                  >
                    <FgSelect
                      options={borrowAccountOptions}
                      value={f.borrowAccountId || undefined}
                      onChange={(v) => set('borrowAccountId', v ?? '')}
                      placeholder="Chọn tài khoản cho mượn"
                      style={{ width: '100%' }}
                      disabled={!canEdit}
                    />
                  </FgField>
                  <FgField
                    label="Số tiền mượn"
                    error={errors['options.account_borrow.amount_minor'] ?? null}
                    help={f.amount ? `Bỏ trống = toàn bộ số thực chi (${formatMoney(f.amount, { mode: 'compact' })})` : 'Bỏ trống = toàn bộ số thực chi'}
                  >
                    <FgMoneyInput value={f.borrowAmount} onChange={(m) => set('borrowAmount', m)} disabled={!canEdit} placeholder="Bằng số thực chi" />
                  </FgField>
                </div>
              ) : null}
            </Section>
          ) : null}

          {/* ---------- Phiếu thu / chi: cấn trừ khoản vay (R7 — gán tự động khi duyệt xong) ---------- */}
          {offsetEnabled ? (
            <Section title="Cấn trừ khoản vay">
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, cursor: canEdit && !f.loan.on ? 'pointer' : 'not-allowed' }}>
                <input
                  type="checkbox"
                  checked={f.offset.on}
                  // phiếu thu chỉ cấn trừ công nợ phải thu: bật thì đích là công nợ
                  onChange={(e) => setOffset({ on: e.target.checked, ...(kind === 'income' ? { target: 'debt_voucher' as const } : {}) })}
                  style={{ width: 18, height: 18, marginTop: 1 }}
                  disabled={!canEdit || f.loan.on}
                />
                <span>
                  {kind === 'income' ? 'Phiếu này cấn trừ khoản vay phải thu' : 'Phiếu này cấn trừ khoản vay'}
                  <br />
                  <span style={{ color: 'var(--fg-text-muted)' }}>
                    {kind === 'income'
                      ? 'Khi phiếu được duyệt xong, hệ thống tự gán phiếu vào khoản phải thu (công nợ) của đối tác đã chọn: khách hàng trả bằng cách cấn trừ vào khoản đang nợ công ty.'
                      : 'Khi phiếu được duyệt xong, hệ thống tự gán phiếu vào khoản đã chọn: trả nợ ngân hàng (có thể tách lãi, phí) hoặc cấn trừ công nợ phải trả.'}
                    {f.loan.on ? (kind === 'income' ? ' Không dùng cùng lúc với "Đây là khoản vay ngân hàng (đi vay)".' : ' Không dùng cùng lúc với "Vay ngân hàng để chi".') : ''}
                  </span>
                </span>
              </label>
              {f.offset.on ? (
                <div style={{ display: 'grid', gap: 'var(--fg-space-3)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', marginTop: 'var(--fg-space-3)' }}>
                  {kind === 'spend' ? (
                    <FgField label="Cấn trừ với">
                      <FgSelect
                        options={[
                          { value: 'bank_debt', label: 'Khoản vay ngân hàng' },
                          { value: 'debt_voucher', label: 'Công nợ phải trả' },
                        ]}
                        value={f.offset.target}
                        onChange={(v) => setOffset({ target: v === 'debt_voucher' ? 'debt_voucher' : 'bank_debt', targetId: '', interest: null, fee: null })}
                        style={{ width: '100%' }}
                        disabled={!canEdit}
                      />
                    </FgField>
                  ) : null}
                  <FgField
                    label={kind === 'income' ? 'Khoản phải thu *' : 'Khoản vay / công nợ *'}
                    error={errors['options.offset.target_id'] ?? null}
                    help={
                      !f.partnerId
                        ? 'Chọn đối tác trước'
                        : f.offset.target === 'bank_debt'
                          ? 'Khoản vay của ngân hàng này, còn đang vay'
                          : kind === 'income'
                            ? 'Công nợ phải thu của đối tác này, còn dư'
                            : 'Công nợ phải trả của đối tác này, còn dư'
                    }
                  >
                    <FgSelect
                      options={offsetOptions}
                      value={f.offset.targetId || undefined}
                      onChange={(v) => setOffset({ targetId: String(v ?? '') })}
                      placeholder={f.partnerId ? 'Chọn khoản cần cấn trừ' : 'Chọn đối tác trước'}
                      style={{ width: '100%' }}
                      disabled={!canEdit || !f.partnerId}
                    />
                  </FgField>
                  <FgField
                    label="Số tiền cấn trừ"
                    error={errors['options.offset.amount_minor'] ?? null}
                    help={f.amount ? `Bỏ trống = toàn bộ số tiền phiếu (${formatMoney(f.amount, { mode: 'compact' })})` : 'Bỏ trống = toàn bộ số tiền phiếu'}
                  >
                    <FgMoneyInput value={f.offset.amount} onChange={(m) => setOffset({ amount: m })} disabled={!canEdit} placeholder="Bằng số tiền phiếu" />
                  </FgField>
                  {f.offset.target === 'bank_debt' ? (
                    <>
                      <FgField label="Trong đó: lãi" error={errors['options.offset.interest_minor'] ?? null}>
                        <FgMoneyInput value={f.offset.interest} onChange={(m) => setOffset({ interest: m })} disabled={!canEdit} placeholder="0" />
                      </FgField>
                      <FgField label="Trong đó: phí" error={errors['options.offset.fee_minor'] ?? null}>
                        <FgMoneyInput value={f.offset.fee} onChange={(m) => setOffset({ fee: m })} disabled={!canEdit} placeholder="0" />
                      </FgField>
                      <FgField label="Gốc (tự tính)" help="Chỉ phần gốc làm giảm dư nợ">
                        <FgText style="body" strong>
                          {offsetPrincipal === null ? '—' : formatMoney(money(offsetPrincipal), { mode: 'full' })}
                        </FgText>
                      </FgField>
                    </>
                  ) : null}
                </div>
              ) : null}
            </Section>
          ) : null}

          {/* ---------- Chuyển tiền nội bộ theo ID (phiếu chuyển nội bộ) ---------- */}
          {kind === 'internal' ? (
            <Section title="Chuyển tiền nội bộ">
              <FgText style="caption" color="muted">
                Chọn công ty và tài khoản nhận. Khi thực thi, hai bên ghi sổ đối ứng (ra/vào), không tính vào chi phí/doanh thu. Công ty nhận KHÔNG tự sinh phiếu thu: muốn
                bên nhận có phiếu thu tự động, lập phiếu chi với đối tác là “Công ty trong tập đoàn”.
              </FgText>
              {f.transferOn ? (
                <div style={{ display: 'grid', gap: 'var(--fg-space-3)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', marginTop: 'var(--fg-space-3)' }}>
                  <FgField
                    label="Công ty nhận *"
                    error={errors['transfer_target.company_id'] ?? null}
                    help={companyOptions.length ? undefined : 'Bạn chưa được gán công ty nào khác — chuyển nội bộ cần công ty nhận mà bạn được gán'}
                  >
                    <FgSelect
                      options={companyOptions}
                      value={f.transferCompanyId || undefined}
                      onChange={(v) => setF((s) => ({ ...s, transferCompanyId: v ?? '', transferAccountId: '' }))}
                      placeholder="Chọn công ty"
                      style={{ width: '100%' }}
                      disabled={!canEdit}
                    />
                  </FgField>
                  <FgField label="Tài khoản nhận *" error={errors['transfer_target.account_id'] ?? null} help={f.transferCompanyId ? undefined : 'Chọn công ty nhận trước'}>
                    <FgSelect
                      options={transferAccountOptions}
                      value={f.transferAccountId || undefined}
                      onChange={(v) => set('transferAccountId', v ?? '')}
                      placeholder="Chọn tài khoản nhận"
                      style={{ width: '100%' }}
                      disabled={!canEdit || !f.transferCompanyId}
                    />
                  </FgField>
                </div>
              ) : null}
            </Section>
          ) : null}
        </FgCard>
        <div className="fg-form-side" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}>
          <FgCard title="Trạng thái">
            <FgText style="bodyS" color="muted">
              {id && loaded ? `Hồ sơ ${loaded.code} · ${statusLabel(loaded.status)}` : id ? 'Đang tải hồ sơ…' : 'Phiếu mới — chưa gửi duyệt'}
            </FgText>
            {f.amount ? (
              <div className="fg-stat-row" style={{ marginTop: 8 }}>
                <span className="fg-stat-label">Số tiền</span>
                <span>{formatMoney(f.amount, { mode: 'full' })}</span>
              </div>
            ) : null}
          </FgCard>
          <FgCard title="Nộp">
            {!id ? (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
                <input type="checkbox" checked={!submitAsDraft} onChange={(e) => setSubmitAsDraft(!e.target.checked)} style={{ width: 18, height: 18 }} />
                Gửi duyệt ngay sau khi tạo
              </label>
            ) : null}
            <FgButton variant="primary" block loading={busy} disabled={!canEdit} onClick={() => void save()}>
              {id ? 'Lưu thay đổi' : submitAsDraft ? 'Lưu nháp' : 'Tạo & gửi duyệt'}
            </FgButton>
            <div style={{ marginTop: 8 }}>
              <FgButton block onClick={() => navigate(-1)}>
                Hủy
              </FgButton>
            </div>
            <FgText style="caption" color="muted">
              Cần đủ chứng từ bắt buộc trước khi gửi (FG-WF-003).
            </FgText>
          </FgCard>
        </div>
      </div>
    </>
  );
}

/** Tiêu đề khối phụ trong thẻ form (tách bằng đường kẻ). */
function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section style={{ marginTop: 'var(--fg-space-5)', paddingTop: 'var(--fg-space-4)', borderTop: '1px solid var(--fg-border-subtle)', display: 'grid', gap: 'var(--fg-space-3)' }}>
      <FgText style="h4">{title}</FgText>
      {children}
    </section>
  );
}

/**
 * Điều khoản khoản vay (contract `loanTerms`). Trống ⇒ theo tham số của công ty (`defaults`, từ server);
 * chưa tải được tham số thì không hiện số cụ thể.
 */
function LoanTermsFields({
  value,
  onChange,
  baseDate,
  disabled,
  errors,
  defaults,
}: {
  value: LoanState;
  onChange: (patch: Partial<LoanState>) => void;
  baseDate: string;
  disabled?: boolean;
  errors: Record<string, string>;
  defaults: { term_months: number; due_offset_months: number } | null;
}): ReactNode {
  const defaultDue = defaults ? defaultLoanDueDate(baseDate, defaults.due_offset_months) : '';
  const shownDue = value.dueDate || defaultDue;
  const err = (k: string): string | null => errors[`options.loan.terms.${k}`] ?? errors[`options.loan.${k}`] ?? null;
  return (
    <div style={{ display: 'grid', gap: 'var(--fg-space-3)', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
      <FgField label="Số HĐ tín dụng" error={err('contract_no')}>
        <FgInput value={value.contractNo} onChange={(e) => onChange({ contractNo: e.target.value })} placeholder="VD: HĐTD 123/2026" maxLength={80} disabled={disabled} />
      </FgField>
      <FgField label="Lãi suất (%/năm)" error={err('interest_rate')}>
        <FgInput value={value.interestRate} onChange={(e) => onChange({ interestRate: e.target.value })} placeholder="9,5" disabled={disabled} />
      </FgField>
      <FgField label="Kỳ hạn (tháng)" help={defaults ? `Mặc định của công ty: ${defaults.term_months} tháng` : 'Mặc định theo cấu hình công ty'} error={err('term_months')}>
        <FgNumber
          min={1}
          max={600}
          precision={0}
          value={value.termMonths ?? undefined}
          placeholder={defaults ? String(defaults.term_months) : undefined}
          onChange={(v) => onChange({ termMonths: typeof v === 'number' ? v : null })}
          disabled={disabled}
          style={{ width: '100%' }}
        />
      </FgField>
      <FgField
        label="Hạn thanh toán"
        help={
          value.dueDate
            ? 'Đã sửa — xoá ngày để về mặc định'
            : defaults
              ? `Mặc định: ${defaultDue ? dayjs(defaultDue).format('DD/MM/YYYY') : '—'} (ngày gốc + ${defaults.due_offset_months} tháng)`
              : 'Mặc định theo cấu hình công ty'
        }
        error={err('due_date')}
      >
        <DatePicker
          value={shownDue ? dayjs(shownDue) : null}
          onChange={(d) => onChange({ dueDate: d ? d.format('YYYY-MM-DD') : '' })}
          format="DD/MM/YYYY"
          style={{ width: '100%' }}
          disabled={disabled}
          placeholder="Chọn ngày"
        />
      </FgField>
      <FgField label="Kỳ trả lãi / gốc" error={err('repayment_period')}>
        <FgSelect
          options={REPAYMENT_PERIODS.map((p) => ({ value: p, label: REPAYMENT_PERIOD_LABEL[p] }))}
          value={value.repaymentPeriod || undefined}
          onChange={(v) => onChange({ repaymentPeriod: v ?? '' })}
          placeholder="Chọn kỳ trả"
          allowClear
          style={{ width: '100%' }}
          disabled={disabled}
        />
      </FgField>
      <FgField label="Phương thức trả nợ gốc" error={err('repayment_method')}>
        <FgSelect
          options={REPAYMENT_METHODS.map((m) => ({ value: m, label: REPAYMENT_METHOD_LABEL[m] }))}
          value={value.repaymentMethod || undefined}
          onChange={(v) => onChange({ repaymentMethod: v ?? '' })}
          placeholder="Chọn phương thức"
          allowClear
          style={{ width: '100%' }}
          disabled={disabled}
        />
      </FgField>
      <div style={{ gridColumn: '1/-1' }}>
        <FgField label="Tài sản bảo đảm (TSĐB)" error={err('collateral')}>
          <FgInput value={value.collateral} onChange={(e) => onChange({ collateral: e.target.value })} maxLength={1000} disabled={disabled} />
        </FgField>
      </div>
    </div>
  );
}

function pathKind(kind: string): string {
  return { spend: 'chi', income: 'thu', rollover: 'dao-han', internal: 'noi-bo' }[kind] ?? 'chi';
}

function defaultTitle(kind: string, payee: string, amount: Money | null): string {
  const a = amount ? formatMoney(amount, { mode: 'compact' }) : '';
  const label = { spend: 'Chi', income: 'Thu', rollover: 'Đảo hạn', internal: 'Chuyển nội bộ' }[kind] ?? 'Hồ sơ';
  return `${label} ${payee || '…'} ${a}`.trim();
}

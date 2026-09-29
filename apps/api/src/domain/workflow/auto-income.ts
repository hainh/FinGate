/**
 * Phiếu thu TỰ ĐỘNG khi thực thi phiếu chi (yêu cầu nghiệp vụ).
 *
 * Khi một phiếu chi được duyệt và thực thi (pay), nếu "Đơn vị nhận tiền" (`payee.name`)
 * có dạng `Mã công ty - Tên ngân hàng hoặc tên quỹ - Số tài khoản hoặc mã quỹ` (đúng
 * 3 phần, phân tách chính xác bởi ` - `) và khớp một tài khoản tiền trong hệ thống thì:
 *   · tạo một phiếu THU cho công ty sở hữu tài khoản nhận, cùng số tiền;
 *   · nội dung thêm tiền tố `(Tự động nhập) `;
 *   · đánh dấu đã duyệt bằng các user đã duyệt phiếu chi;
 *   · thực thi luôn (ghi sổ cái cộng tiền vào tài khoản nhận).
 */

import { vnDate, type Role } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { nextDocumentCode } from '../numbering/index.ts';
import { buildHistoryEntry, mirrorAudit } from '../audit/index.ts';
import { syncBalancesForDocument } from '../side-effects.ts';
import type { ActorInfo, DomainDoc, StepRow } from '../types.ts';

/** dấu phân tách CHÍNH XÁC giữa các phần của "Đơn vị nhận tiền". */
export const PAYEE_ACCOUNT_SEPARATOR = ' - ';
export const AUTO_INCOME_PREFIX = '(Tự động nhập) ';

export interface ParsedPayeeAccount {
  companyCode: string;
  accountName: string;
  accountNumber: string;
}

/** Cắt chuỗi "Mã công ty - Tên ngân hàng/quỹ - Số tài khoản/mã quỹ" (đúng 3 phần). */
export function parsePayeeAccountLabel(label: string | null | undefined): ParsedPayeeAccount | null {
  const raw = String(label ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(PAYEE_ACCOUNT_SEPARATOR);
  if (parts.length !== 3) return null;
  const [companyCode, accountName, accountNumber] = parts.map((p) => p.trim());
  if (!companyCode || !accountName || !accountNumber) return null;
  return { companyCode, accountName, accountNumber };
}

/** Tìm tài khoản tiền khớp với mô tả trong "Đơn vị nhận tiền" (null = không khớp). */
export async function resolvePayeeAccount(
  parsed: ParsedPayeeAccount,
): Promise<{ accountId: string; companyId: string; isGroup: boolean; kind: string } | null> {
  const company = await Models.Company.findOne({ code: parsed.companyCode.toUpperCase() })
    .select({ _id: 1, is_group: 1 })
    .lean<{ _id: unknown; is_group?: boolean } | null>();
  if (!company) return null;
  const filter = company.is_group
    ? { is_group: true, bank_name: parsed.accountName, account_number: parsed.accountNumber }
    : { company_id: company._id, bank_name: parsed.accountName, account_number: parsed.accountNumber };
  const account = await Models.BankAccount.findOne(filter as never)
    .select({ _id: 1, company_id: 1, is_group: 1, kind: 1, status: 1 })
    .lean<{ _id: unknown; company_id?: unknown; is_group?: boolean; kind?: string; status?: string } | null>();
  if (!account) return null;
  return {
    accountId: String(account._id),
    companyId: String(company._id),
    isGroup: Boolean(account.is_group),
    kind: String(account.kind ?? 'bank'),
  };
}

/**
 * Sinh phiếu thu tự động cho phiếu chi vừa thực thi. Trả về id phiếu thu mới (hoặc null
 * nếu "Đơn vị nhận tiền" không khớp tài khoản nào / đã có phiếu thu tự động cho phiếu chi này).
 */
export async function createAutoIncomeForSpend(input: {
  spend: DomainDoc;
  actor: ActorInfo;
  paidAt: string;
  amountMinor: bigint;
  requestId: string;
  ip: string | null;
}): Promise<string | null> {
  const { spend, actor } = input;
  if (spend.kind !== 'spend') return null;
  if (input.amountMinor <= 0n) return null;

  const parsed = parsePayeeAccountLabel(spend.payee?.name);
  if (!parsed) return null;
  const matched = await resolvePayeeAccount(parsed);
  if (!matched) return null;

  // chống tạo trùng: mỗi phiếu chi chỉ sinh tối đa một phiếu thu tự động.
  const existing = await Models.Document.findOne({ auto_source_document_id: spend._id })
    .select({ _id: 1 })
    .lean<{ _id: unknown } | null>();
  if (existing) return String(existing._id);

  const now = new Date();
  const paidDate = input.paidAt && input.paidAt.length >= 10 ? input.paidAt : vnDate(now);
  const code = await nextDocumentCode('income', now);

  const approvedSteps: StepRow[] = ((spend.approval?.steps ?? []) as StepRow[]).map((s) => ({
    order: s.order,
    role: s.role as Role,
    user_id: s.user_id ? String(s.user_id) : null,
    delegated_from: s.delegated_from ? String(s.delegated_from) : null,
    state: 'done',
    action: 'approve',
    decided_at: s.decided_at ?? now,
    opinion: s.opinion ?? null,
    reason: s.reason ?? null,
    sla_deadline: null,
    amount_at_decision: input.amountMinor.toString(),
    fast_tracked: Boolean(s.fast_tracked),
  }));

  const sourceCompany = await Models.Company.findById(spend.company_id).select({ name: 1, code: 1 }).lean<{ name?: string; code?: string } | null>();
  const sourceLabel = sourceCompany ? `${sourceCompany.code ?? ''} - ${sourceCompany.name ?? ''}`.trim() : 'nội bộ';

  const history = [
    buildHistoryEntry({
      at: now,
      action: 'auto_create',
      actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
      from: null,
      to: 'draft',
      request_id: input.requestId,
      ip: input.ip,
      fields: { auto: true, source_document_id: String(spend._id), source_code: spend.code },
    }),
    buildHistoryEntry({
      at: now,
      action: 'pay',
      actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
      from: 'approved',
      to: 'paid',
      amount_at_decision: input.amountMinor.toString(),
      request_id: input.requestId,
      ip: input.ip,
      fields: { auto: true, source_document_id: String(spend._id), source_code: spend.code, account_id: matched.accountId },
    }),
  ];

  const created = await Models.Document.create({
    code,
    kind: 'income',
    company_id: matched.companyId,
    department_id: null,
    created_by: actor.user_id,
    status: 'paid',
    version: 1,
    title: `Thu tự động từ phiếu chi ${spend.code}`,
    purpose: `${AUTO_INCOME_PREFIX}${spend.purpose || spend.title || ''}`.trim(),
    category_id: null,
    payee: { name: sourceLabel, is_internal: true },
    amount: { minor: input.amountMinor, currency: spend.amount?.currency ?? 'VND', decimals: spend.amount?.decimals ?? 0 },
    source: { fund: matched.kind === 'cash' ? 'cash' : 'bank', account_id: matched.accountId, group_account_id: null, group_managed: false },
    target: null,
    planned_date: paidDate,
    business_date: paidDate,
    priority: 'normal',
    contract: { code: spend.contract?.code ?? null, value: null },
    loan_id: null,
    budget: { budget_id: null, line_id: null, in_plan: true },
    note: `Tự động tạo khi thực thi phiếu chi ${spend.code}`,
    approval: { matrix_id: null, matrix_version: 0, matrix_label: 'Tự động (theo phiếu chi)', steps: approvedSteps },
    evidence: { required: [], present: [], missing: [] },
    execution: {
      paid_at: paidDate,
      bank_ref: null,
      executed_by: actor.user_id,
      actual_amount_minor: input.amountMinor,
      actual_amount: { minor: input.amountMinor, currency: spend.amount?.currency ?? 'VND', decimals: spend.amount?.decimals ?? 0 },
    },
    history,
    auto_source_document_id: spend._id,
    auto_created: true,
    created_at: now,
    updated_at: now,
    submitted_at: now,
    closed_at: now,
  } as never);

  const incomeId = String(created._id);

  // ghi sổ cái: cộng tiền vào tài khoản nhận (actual, idempotent theo doc).
  await syncBalancesForDocument({
    doc: created as unknown as DomainDoc,
    from: 'approved',
    to: 'paid',
    execution: created.execution as never,
    newAccountId: null,
    installmentIndex: 0,
  });

  await mirrorAudit({
    at: now,
    actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
    action: 'document.auto_income',
    subject: { type: 'income', id: incomeId, code },
    company_id: matched.companyId,
    document_id: incomeId,
    diff_fields: { auto: true, source_document_id: String(spend._id), source_code: spend.code, amount_minor: input.amountMinor.toString() },
    request_id: input.requestId,
    ip: input.ip,
  });

  return incomeId;
}

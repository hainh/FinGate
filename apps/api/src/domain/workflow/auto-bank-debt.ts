/**
 * Phiếu nợ ngân hàng TỰ ĐỘNG khi thực thi phiếu thu (yêu cầu nghiệp vụ).
 *
 * Khi một phiếu thu được lập kèm cờ `create_bank_debt` và được duyệt & thực thi
 * (thu tiền về tài khoản), hệ thống tự sinh một khoản nợ ngân hàng tương ứng:
 *   · tên ngân hàng = "Khách hàng trả tiền" (`payee.name`);
 *   · số tiền vay = số tiền thu thực tế;
 *   · kỳ hạn 12 tháng, hạn thanh toán = ngày tạo phiếu vay + 11 tháng;
 *   · các trường còn lại dùng mặc định (lãi suất 0, trả gốc cuối kỳ…).
 */

import { vnDate } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { nextSequentialCode } from '../numbering/index.ts';
import { addMonths } from '../loan-schedule/index.ts';
import { buildHistoryEntry, mirrorAudit } from '../audit/index.ts';
import type { ActorInfo, DomainDoc } from '../types.ts';

/** Kỳ hạn mặc định của khoản nợ tự sinh (tháng). */
export const AUTO_BANK_DEBT_TERM_MONTHS = 12;
/** Hạn thanh toán = ngày tạo phiếu vay + 11 tháng. */
export const AUTO_BANK_DEBT_MATURITY_OFFSET_MONTHS = 11;

/**
 * Sinh khoản nợ ngân hàng cho phiếu thu vừa thực thi. Trả về id khoản nợ mới (hoặc
 * null nếu phiếu không bật cờ / thiếu ngân hàng / đã có khoản nợ cho phiếu thu này).
 */
export async function createAutoBankDebtForIncome(input: {
  income: DomainDoc;
  actor: ActorInfo;
  amountMinor: bigint;
  requestId: string;
  ip: string | null;
}): Promise<string | null> {
  const { income, actor } = input;
  if (income.kind !== 'income') return null;
  if (!income.create_bank_debt) return null;
  if (input.amountMinor <= 0n) return null;

  const bankName = String(income.payee?.name ?? '').trim();
  if (bankName.length < 2) return null;

  // chống tạo trùng: mỗi phiếu thu chỉ sinh tối đa một khoản nợ tự động.
  const existing = await Models.BankDebt.findOne({ auto_source_document_id: income._id })
    .select({ _id: 1 })
    .lean<{ _id: unknown } | null>();
  if (existing) return String(existing._id);

  const now = new Date();
  const createdDate = vnDate(now);
  const maturityDate = addMonths(createdDate, AUTO_BANK_DEBT_MATURITY_OFFSET_MONTHS);
  const currency = income.amount?.currency ?? 'VND';
  const code = await nextSequentialCode('NHD', now);

  const history = buildHistoryEntry({
    action: 'auto_create',
    actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
    to: null,
    request_id: input.requestId,
    ip: input.ip,
    fields: { auto: true, source_document_id: String(income._id), source_code: income.code },
  });

  const created = await Models.BankDebt.create({
    code,
    company_id: income.company_id,
    bank_name: bankName,
    principal_minor: input.amountMinor,
    credit_limit_minor: 0n,
    outstanding_minor: input.amountMinor,
    amount: { minor: input.amountMinor, currency, decimals: income.amount?.decimals ?? 0 },
    currency,
    interest_rate: '0',
    term_months: AUTO_BANK_DEBT_TERM_MONTHS,
    payment_frequency: 'maturity',
    repayment_method: 'interest_only',
    maturity_date: maturityDate,
    next_due_date: maturityDate,
    status: 'active',
    note: `Tự động tạo khi thực thi phiếu thu ${income.code}`,
    created_by: actor.user_id,
    history: [history],
    auto_source_document_id: income._id,
    created_at: now,
    updated_at: now,
  } as never);

  const debtId = String(created._id);

  await mirrorAudit({
    at: now,
    actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
    action: 'bank_debt.auto_create',
    subject: { type: 'bank_debt', id: debtId, code },
    company_id: String(income.company_id),
    document_id: String(income._id),
    diff_fields: { auto: true, source_document_id: String(income._id), source_code: income.code, amount_minor: input.amountMinor.toString() },
    request_id: input.requestId,
    ip: input.ip,
  });

  return debtId;
}

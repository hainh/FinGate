/**
 * Mượn tiền TK khác (R8) — chạy NGAY TRONG bước thực thi phiếu chi gốc, TRƯỚC khi phiếu gốc ra tiền:
 *  1. phiếu chi TK cho mượn B → TK chi A (đã duyệt, kế thừa người duyệt) — thực thi qua `transition()` (kiểm số dư B
 *     như mọi phiếu chi ⇒ B không âm);
 *  2. phiếu thu vào A từ B — thực thi ⇒ A có tiền;
 * rồi phiếu gốc mới kiểm số dư A và chi. Hai phiếu nhận diện theo phiếu nguồn (`origin.source_document_id`, R8) nên
 * lần thực thi lại (lỗi giữa chừng) dùng lại, không sinh trùng. Liên kết do quy tắc R8 gán sau sự kiện `voucher.paid`.
 *
 * Tách khỏi `account-borrow.ts` vì phụ thuộc `automation/actions/voucher.ts` (vốn gọi `workflow.transition`):
 * workflow nạp module này động để không tạo vòng import.
 */

import { Models } from '../../db/models.ts';
import { bankAccountLabelOf } from '../queries/index.ts';
import { createAutoVoucher, executeAutoVoucher } from '../automation/actions/voucher.ts';
import type { AutoActor } from '../automation/actions/common.ts';
import type { StepLike } from '../automation/actions/lookup.ts';
import { fundOfAccount } from '../automation/actions/lookup.ts';
import { effectiveBorrowAmount, storedAccountBorrowToPlan } from './account-borrow.ts';

export const ACCOUNT_BORROW_RULE = 'R8';

/** Phiếu mượn tiền (chi B → A hoặc thu A ← B) đã sinh cho phiếu chi gốc — bỏ qua phiếu đã huỷ / từ chối. */
export async function findBorrowVoucher(sourceId: string, kind: 'spend' | 'income'): Promise<{ id: string; code: string; status: string } | null> {
  const row = await Models.Document.findOne({
    kind,
    'origin.rule_code': ACCOUNT_BORROW_RULE,
    'origin.source_document_id': sourceId,
    status: { $nin: ['cancelled', 'rejected', 'expired'] },
  } as never)
    .select({ _id: 1, code: 1, status: 1 })
    .lean<{ _id: unknown; code: string; status: string } | null>();
  return row ? { id: String(row._id), code: row.code, status: row.status } : null;
}

async function accountLabel(id: string): Promise<string> {
  const a = await Models.BankAccount.findById(id).select({ bank_name: 1, account_number: 1, account_name: 1 }).lean<{ bank_name?: string; account_number?: string; account_name?: string } | null>();
  return a ? bankAccountLabelOf(a) : id;
}

export interface BorrowSource {
  _id: unknown;
  code: string;
  company_id: unknown;
  created_by?: unknown;
  amount: { currency?: string | null; decimals?: number | null };
  options?: { account_borrow?: unknown } | null;
  approval?: { steps?: StepLike[] | null } | null;
}

/**
 * Sinh (nếu chưa có) và thực thi hai phiếu mượn tiền trước khi chi phiếu gốc. Không có cờ mượn tiền ⇒ không làm gì.
 * Lỗi (VD TK cho mượn không đủ số dư — FG-WF-010 từ `transition`) ném ra để chặn việc chi phiếu gốc.
 */
export async function runAccountBorrowBeforePay(input: {
  doc: BorrowSource;
  /** TK thực chi của phiếu gốc (nhận tiền mượn). */
  payAccountId: string;
  actualMinor: bigint;
  paidAt: string;
  actor: AutoActor;
  requestId: string;
}): Promise<void> {
  const { doc } = input;
  const plan = storedAccountBorrowToPlan((doc.options?.account_borrow ?? null) as Record<string, unknown> | null);
  if (!plan) return;
  const amountMinor = effectiveBorrowAmount(plan, input.actualMinor);
  if (amountMinor <= 0n) return;
  const sourceId = String(doc._id);
  const [toLabel, fromLabel] = await Promise.all([accountLabel(input.payAccountId), accountLabel(plan.account_id)]);
  const common = {
    companyId: String(doc.company_id),
    amountMinor,
    currency: doc.amount.currency ?? 'VND',
    decimals: doc.amount.decimals ?? 0,
    partnerId: null,
    plannedDate: input.paidAt,
    businessDate: input.paidAt,
    approvalSteps: doc.approval?.steps,
    matrixLabel: 'Tự động (theo phiếu chi)',
    createdBy: input.actor.user_id ?? String(doc.created_by ?? ''),
    source: { id: sourceId, code: doc.code },
    ruleCode: ACCOUNT_BORROW_RULE,
    runId: null,
    eventType: 'voucher.pay',
    actor: input.actor,
  };

  const spend =
    (await findBorrowVoucher(sourceId, 'spend')) ??
    (await createAutoVoucher({
      ...common,
      kind: 'spend',
      title: `Cho mượn tiền để chi phiếu ${doc.code}`,
      purpose: `(Tự động) Chuyển tiền sang TK ${toLabel} để chi phiếu ${doc.code}`,
      note: `Tự động tạo khi thực thi phiếu chi ${doc.code} · chuyển sang ${toLabel}`,
      fund: await fundOfAccount(plan.account_id),
      accountId: plan.account_id,
      requestId: `${input.requestId}#borrow-spend`,
    }));
  const receipt =
    (await findBorrowVoucher(sourceId, 'income')) ??
    (await createAutoVoucher({
      ...common,
      kind: 'income',
      title: `Nhận tiền mượn để chi phiếu ${doc.code}`,
      purpose: `(Tự động) Nhận tiền từ TK ${fromLabel} để chi phiếu ${doc.code}`,
      note: `Tự động tạo khi thực thi phiếu chi ${doc.code} · từ ${fromLabel}`,
      fund: await fundOfAccount(input.payAccountId),
      accountId: input.payAccountId,
      requestId: `${input.requestId}#borrow-receipt`,
    }));

  // thứ tự: B ra tiền trước (kiểm số dư B), rồi A nhận — sau đó phiếu gốc mới chi
  await executeAutoVoucher({ docId: spend.id, paidAt: input.paidAt, actor: input.actor, requestId: `${input.requestId}#borrow-spend-pay` });
  await executeAutoVoucher({ docId: receipt.id, paidAt: input.paidAt, actor: input.actor, requestId: `${input.requestId}#borrow-receipt-pay` });
}

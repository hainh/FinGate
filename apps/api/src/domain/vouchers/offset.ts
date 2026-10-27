/**
 * Cấn trừ khoản vay trên phiếu thu / phiếu chi — phần ĐỌC / GHI DB dùng chung cho lưu phiếu (`refs.ts`) và quy tắc R7.
 *
 * Liên kết cấn trừ do R7 gán khi duyệt mang nguồn `Tự động` + mã `R7`, nên phân biệt được với liên kết người dùng
 * gán tay trên tab Liên kết của phiếu (nguồn `Thủ công`, không bị R7 gỡ).
 */

import { today } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { listLinksFor, loanOutstanding, removeLink, type LinkActor, type LinkRecord } from '../links/index.ts';
import { loanStatusOf } from '../debt/rules.ts';

/** Mã quy tắc gán liên kết cấn trừ khi phiếu chi được duyệt xong. */
export const OFFSET_RULE_CODE = 'R7';

/** Liên kết cấn trừ do R7 gán (trả nợ khoản vay hoặc cấn trừ công nợ) — phân biệt với liên kết gán tay. */
export function isOffsetRuleLink(l: Pick<LinkRecord, 'relation' | 'origin' | 'rule_code'>): boolean {
  return (l.relation === 'repayment' || l.relation === 'offset') && l.origin === 'automation' && l.rule_code === OFFSET_RULE_CODE;
}

/** Liên kết cấn trừ R7 còn hiệu lực của một phiếu. */
export async function offsetRuleLinksOf(documentId: string): Promise<LinkRecord[]> {
  const links = await listLinksFor('document', documentId, { scopeCompanyIds: null });
  return links.filter((l) => l.from_type === 'document' && l.from_id === documentId && isOffsetRuleLink(l));
}

/**
 * Gỡ mọi liên kết cấn trừ R7 của phiếu (đánh dấu gỡ, có lý do). Dùng khi phiếu ĐỔI cấn trừ sau lần duyệt trước: phiếu
 * quay lại chờ duyệt, liên kết cũ không được giữ sức chứa của khoản cũ; duyệt lại sẽ gán theo lựa chọn mới.
 */
export async function releaseOffsetRuleLinks(input: { documentId: string; reason: string; actor: LinkActor; requestId: string | null }): Promise<void> {
  for (const link of await offsetRuleLinksOf(input.documentId)) {
    await removeLink({ link_id: link._id, reason: input.reason, actor: input.actor, scopeCompanyIds: null, request_id: input.requestId });
  }
}

/**
 * Khoản vay còn ĐANG VAY (đang vay / quá hạn — cùng quy tắc với trả nợ thủ công): mới được nhận trả nợ / cấn trừ.
 * Trạng thái suy ra từ dư nợ và hạn nên đọc lại dư nợ.
 */
export async function loanOpenForRepayment(loanId: string): Promise<boolean> {
  const b = await Models.BankDebt.findById(loanId).select({ status: 1, maturity_date: 1 }).lean<{ status?: string; maturity_date?: string | null } | null>();
  if (!b) return false;
  const status = loanStatusOf(b.status, await loanOutstanding(loanId), String(b.maturity_date ?? today()));
  return status === 'active' || status === 'overdue';
}

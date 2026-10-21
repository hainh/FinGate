/**
 * Bước LIÊN KẾT (v2/v2.md §11.2, §14.3 (3)): gán / gỡ liên kết nghiệp vụ do quy tắc tự động tạo.
 *
 * Đi qua `createLink` / `removeLink` của domain links (kiểm tra cùng công ty, đối tác, sức chứa, trùng cặp) —
 * không ghi `business_links` trực tiếp. Idempotent: cặp + quan hệ đã có hiệu lực ⇒ dùng lại.
 */

import { ApiError } from '@fingate/shared';
import { Models } from '../../../db/models.ts';
import { createLink, listLinksFor, removeLink, RELATION_SPECS, type LinkObjectType, type LinkRecord, type LinkRelation } from '../../links/index.ts';
import type { AutoActor } from './common.ts';

/** Phiếu được phiếu nguồn sinh ra theo liên kết `generated` còn hiệu lực (VD R3: phiếu chi → phiếu thu giải ngân). */
export async function generatedDocumentIds(sourceDocId: string): Promise<string[]> {
  const rows = await Models.BusinessLink.find({
    from_type: 'document',
    from_id: sourceDocId,
    to_type: 'document',
    relation: 'generated',
    status: 'active',
  } as never)
    .select({ to_id: 1 })
    .lean<{ to_id: unknown }[]>();
  return [...new Set(rows.map((r) => String(r.to_id)))];
}

export interface EnsureLinkInput {
  from: { type: LinkObjectType; id: string };
  to: { type: LinkObjectType; id: string };
  relation: LinkRelation;
  /** Số tiền phân bổ (quan hệ có tiền); null cho `generated` / `internal_transfer`. */
  amountMinor: bigint | null;
  runId: string;
  ruleCode: string;
  actor: AutoActor;
  requestId: string | null;
}

/**
 * Bảo đảm có liên kết hiệu lực `from → to` với quan hệ `relation`:
 * - đã có đúng số tiền ⇒ trả về liên kết đó;
 * - đã có nhưng khác số tiền (phiếu đổi số tiền trước duyệt) ⇒ gỡ (có lý do) rồi tạo lại;
 * - chưa có ⇒ tạo; va chạm trùng cặp (chạy song song) ⇒ đọc lại.
 */
export async function ensureAutomationLink(input: EnsureLinkInput): Promise<LinkRecord> {
  const findActive = async (): Promise<LinkRecord | undefined> =>
    (await listLinksFor(input.from.type, input.from.id, { scopeCompanyIds: null })).find(
      (l) =>
        l.status === 'active' &&
        l.relation === input.relation &&
        l.from_type === input.from.type &&
        l.from_id === input.from.id &&
        l.to_type === input.to.type &&
        l.to_id === input.to.id,
    );

  const existing = await findActive();
  if (existing) {
    const sameAmount = !RELATION_SPECS[input.relation].amount || existing.amount_minor === input.amountMinor;
    if (sameAmount) return existing;
    await removeLink({
      link_id: existing._id,
      reason: 'Đồng bộ số tiền theo phiếu (quy trình tự động)',
      actor: input.actor,
      scopeCompanyIds: null,
      request_id: input.requestId,
    });
  }

  try {
    return await createLink({
      from: input.from,
      to: input.to,
      relation: input.relation,
      amount_minor: input.amountMinor,
      origin: 'automation',
      run_id: input.runId,
      rule_code: input.ruleCode,
      actor: input.actor,
      scopeCompanyIds: null,
      request_id: input.requestId,
    });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'FG-LINK-003') {
      const again = await findActive();
      if (again) return again;
    }
    throw err;
  }
}

/** Gỡ một liên kết (có lý do). Đã gỡ trước đó ⇒ bỏ qua, không lỗi. */
export async function unlinkAutomationLink(input: { linkId: string; reason: string; actor: AutoActor; requestId: string | null }): Promise<boolean> {
  try {
    await removeLink({ link_id: input.linkId, reason: input.reason, actor: input.actor, scopeCompanyIds: null, request_id: input.requestId });
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'FG-VAL-001') return false;
    throw err;
  }
}

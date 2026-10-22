/**
 * Bước LIÊN KẾT (v2/v2.md §11.2, §14.3 (3)): gán / gỡ liên kết nghiệp vụ do quy tắc tự động tạo.
 *
 * Đi qua `createLink` / `removeLink` của domain links (kiểm tra cùng công ty, đối tác, sức chứa, trùng cặp) —
 * không ghi `business_links` trực tiếp. Idempotent: cặp + quan hệ đã có hiệu lực ⇒ dùng lại.
 */

import { ApiError } from '@fingate/shared';
import { Models } from '../../../db/models.ts';
import { createLink, listLinksFor, removeLink, RELATION_SPECS, type LinkObjectType, type LinkOrigin, type LinkRecord, type LinkRelation } from '../../links/index.ts';
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

/** Đầu vào chung khi gán liên kết (nguồn ghi trên liên kết do hàm gọi quyết định). */
interface EnsureLinkBase {
  from: { type: LinkObjectType; id: string };
  to: { type: LinkObjectType; id: string };
  relation: LinkRelation;
  /** Số tiền phân bổ (quan hệ có tiền); null cho `generated` / `internal_transfer`. */
  amountMinor: bigint | null;
  actor: AutoActor;
  requestId: string | null;
}

/** Liên kết do quy tắc tự động tạo: ghi lượt chạy và mã quy tắc (nguồn `Tự động`). */
export interface EnsureLinkInput extends EnsureLinkBase {
  runId: string;
  ruleCode: string;
}

/** Nguồn đề xuất khi gán: quy tắc (lượt chạy + mã) hoặc người dùng tự chọn trên phiếu (`Thủ công`). */
type LinkSource = { origin: 'automation'; runId: string; ruleCode: string } | { origin: 'manual' };

/** Bảo đảm liên kết hiệu lực do quy tắc tự động tạo (nguồn `Tự động`). Xử lý khi đã có: xem `ensureLink`. */
export async function ensureAutomationLink(input: EnsureLinkInput): Promise<LinkRecord> {
  return ensureLink(input, { origin: 'automation', runId: input.runId, ruleCode: input.ruleCode });
}

/**
 * Liên kết do NGƯỜI DÙNG chọn trên phiếu (VD "Gắn khoản vay đã có", v2 §11.4 (b)): nguồn `Thủ công` (ai gán),
 * không có lượt chạy / mã quy tắc. Vẫn đi qua `createLink` (kiểm công ty, đối tác, sức chứa), idempotent.
 */
export async function ensureManualLink(input: EnsureLinkBase): Promise<LinkRecord> {
  return ensureLink(input, { origin: 'manual' });
}

/**
 * Bảo đảm có liên kết hiệu lực `from → to` với quan hệ `relation`:
 * - nguồn: liên kết đã do người dùng gán (`manual`) GIỮ nguồn Thủ công — quy tắc không hạ xuống Tự động; còn khi
 *   người dùng tự chọn thì liên kết Tự động cũ được ghi lại thành Thủ công;
 * - đã có đúng số tiền và đúng nguồn ⇒ trả về liên kết đó;
 * - đã có nhưng khác số tiền / khác nguồn ⇒ gỡ (có lý do) rồi tạo lại;
 * - chưa có ⇒ tạo; va chạm trùng cặp (chạy song song) ⇒ đọc lại.
 */
async function ensureLink(input: EnsureLinkBase, source: LinkSource): Promise<LinkRecord> {
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
  const origin: LinkOrigin = source.origin === 'manual' || existing?.origin === 'manual' ? 'manual' : 'automation';
  if (existing) {
    const sameAmount = !RELATION_SPECS[input.relation].amount || existing.amount_minor === input.amountMinor;
    if (sameAmount && existing.origin === origin) return existing;
    await removeLink({
      link_id: existing._id,
      reason: sameAmount ? 'Ghi nguồn Thủ công theo lựa chọn của người dùng trên phiếu' : 'Đồng bộ số tiền theo phiếu (quy trình tự động)',
      actor: input.actor,
      scopeCompanyIds: null,
      request_id: input.requestId,
    });
  }
  // lượt chạy / mã quy tắc chỉ ghi cho liên kết nguồn Tự động
  const run = origin === 'automation' && source.origin === 'automation' ? { run_id: source.runId, rule_code: source.ruleCode } : { run_id: null, rule_code: null };

  try {
    return await createLink({
      from: input.from,
      to: input.to,
      relation: input.relation,
      amount_minor: input.amountMinor,
      origin,
      ...run,
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

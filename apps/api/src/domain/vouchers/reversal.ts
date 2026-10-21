/**
 * Đảo sổ cái khi xoá phiếu đã thực thi (v2/v2.md §8: "huỷ/xoá phiếu đã thực thi → sinh bút toán đảo và dựng lại số dư").
 *
 * Thay cho `purgeLedgerForDocuments` (chỉ dành cho job dọn bút toán mồ côi): bút toán gốc được GIỮ NGUYÊN,
 * chỉ thêm bút toán đảo. Idempotent: gọi lại không đảo trùng (khoá `rev:<dedupe_key gốc>`).
 */

import { vnDate } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { oid } from '../../lib/mongo.ts';
import { postCashEntries, recomputeAccountBalances } from '../ledger/index.ts';
import { reversalEntriesFor, type LedgerEntryForReversal } from './lifecycle.ts';

/** Đảo mọi bút toán gốc của một phiếu rồi dựng lại số dư các tài khoản bị ảnh hưởng. */
export async function reverseLedgerForDocument(
  documentId: string,
  actor: { user_id: string },
): Promise<{ reversed: number; accounts: string[] }> {
  const originals = await Models.CashEntry.find({ document_id: oid(documentId), reverses: null } as never).lean<
    LedgerEntryForReversal[]
  >();
  if (!originals.length) return { reversed: 0, accounts: [] };

  const inputs = reversalEntriesFor(originals, { date: vnDate(), createdBy: actor.user_id });
  const reversed = await postCashEntries(inputs);
  const accounts = [...new Set(inputs.map((i) => i.account_id))];
  await recomputeAccountBalances(accounts);
  return { reversed, accounts };
}

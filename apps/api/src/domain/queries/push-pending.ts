/**
 * FinGate â€” "phiáº¿u má»›i chá» tÃ´i duyá»‡t/thanh toÃ¡n" Ä‘á»ƒ BÃO TRÃŠN THIáº¾T Bá»Š (NOTI-03 tá»‘i giáº£n).
 *
 * VÃ¬ sao khÃ´ng dÃ¹ng Web Push ngay: Web Push cáº§n cáº·p khoÃ¡ VAPID + báº£ng `push_subscriptions` + job Ä‘áº©y
 * theo lá»‹ch, tá»©c lÃ  háº¡ táº§ng má»›i. Trong khi Ä‘Ã³ server ÄÃƒ táº¡o sáºµn má»™t báº£n ghi `Notification` cho Ä‘Ãºng
 * ngÆ°á»i duyá»‡t má»—i khi phiáº¿u tá»›i lÆ°á»£t há» (`notifyNextApprover`, domain/side-effects.ts) â€” chá»‰ lÃ  chÆ°a
 * cÃ³ ai "rung chuÃ´ng". á»ž Ä‘Ã¢y táº­n dá»¥ng chÃ­nh báº£n ghi Ä‘Ã³: cá» `push_seen_at` = Ä‘Ã£ báº¯n cho ngÆ°á»i dÃ¹ng trÃªn
 * thiáº¿t bá»‹ nÃ o Ä‘Ã³ chÆ°a. KhÃ´ng sá»­a, khÃ´ng Ä‘á»c láº¡i ma tráº­n duyá»‡t, khÃ´ng Ä‘á»¥ng dá»¯ liá»‡u tiá»n.
 *
 * TÃNH IDEMPOTENT (báº¯t buá»™c, vÃ¬ react-query cÃ³ thá»ƒ gá»i song song/retry):
 *  - Lá»c theo má»‘c thá»i gian lÃ  Ä‘iá»u kiá»‡n Cáº¦N nhÆ°ng chÆ°a Äá»¦: hai request Ä‘á»“ng thá»i cÃ¹ng `since` sáº½ cÃ¹ng
 *    tháº¥y má»™t báº£n ghi. VÃ¬ váº­y dÃ¹ng `findOneAndUpdate({push_seen_at: null})` â€” nguyÃªn tá»­ theo tá»«ng báº£n
 *    ghi: chá»‰ request nÃ o "giÃ nh" Ä‘Æ°á»£c má»›i nháº­n báº£n ghi Ä‘Ã³. Báº£n ghi cá»§a ngÆ°á»i khÃ¡c thÃ¬ bá» qua.
 *  - KhÃ´ng bao giá» tráº£ vá» báº£n ghi cÅ© Ä‘Ã£ báº¯n (`push_seen_at != null`).
 */

import { Models } from '../../db/models.ts';

/** Sá»‘ báº£n ghi giÃ nh tá»‘i Ä‘a má»—i láº§n gá»i â€” giá»¯ truy váº¥n nhá» vÃ  trÃ¡nh báº¯n 50 thÃ´ng bÃ¡o cÃ¹ng lÃºc. */
export const PUSH_PENDING_LIMIT = 5;

/** Chá»‰ bÃ¡o nhá»¯ng loáº¡i thÃ´ng bÃ¡o cÃ³ Ã½ nghÄ©a "cÃ³ viá»‡c ngay": duyá»‡t + cáº£nh bÃ¡o. Bá» thÃ´ng tin há»‡ thá»‘ng. */
const PUSH_KINDS = ['approval'] as const;

export interface PushPendingRow {
  _id: string;
  title: string;
  body: string | null;
  href: string | null;
  created_at: Date;
}

export interface PushPendingResult {
  /** Má»‘c chá»‘t Ä‘á»ƒ client lÆ°u: má»i thá»© TRÆ¯á»šC má»‘c nÃ y Ä‘Ã£ Ä‘Æ°á»£c xá»­ lÃ½ (nháº·t Ä‘i hoáº·c bá» qua vÃ¬ cÅ©). */
  cutoff: Date;
  rows: PushPendingRow[];
}

/**
 * Nháº·t nhá»¯ng thÃ´ng bÃ¡o duyá»‡t CHÆ¯A báº¯n, táº¡o ra sau `since`, vÃ  Ä‘Ã¡nh dáº¥u chÃºng lÃ  Ä‘Ã£ báº¯n.
 *
 * @param userId ngÆ°á»i dÃ¹ng Ä‘ang há»i
 * @param since  má»‘c client Ä‘Ã£ bÃ¡o láº§n cuá»‘i (UTC)
 * @param limit  sá»‘ tá»‘i Ä‘a má»—i láº§n (máº·c Ä‘á»‹nh `PUSH_PENDING_LIMIT`)
 */
export async function collectPushPending(
  userId: string,
  since: Date,
  limit = PUSH_PENDING_LIMIT,
): Promise<PushPendingResult> {
  // Chá»‘t má»‘c NGAY khi báº¯t Ä‘áº§u: báº£n ghi táº¡o sau thá»i Ä‘iá»ƒm nÃ y lÃ  "má»›i Ä‘áº¿n trong lÃºc Ä‘ang tráº£ lá»i" nÃªn
  // pháº£i Ä‘á»ƒ láº¡i cho láº§n gá»i sau, náº¿u khÃ´ng nÃ³ sáº½ rÆ¡i vÃ o khoáº£ng trá»‘ng giá»¯a `since` vÃ  láº§n poll sau.
  const cutoff = new Date();

  // á»¨ng viÃªn: chÆ°a báº¯n + táº¡o sau má»‘c client + Ä‘Ãºng loáº¡i. Giá»›i háº¡n Ä‘á»ƒ khÃ´ng kÃ©o cáº£ lá»‹ch sá»­.
  const candidates = await Models.Notification.find({
    user_id: userId,
    push_seen_at: null,
    kind: { $in: PUSH_KINDS },
    created_at: { $gt: since, $lte: cutoff },
  })
    .sort({ created_at: 1 })
    .limit(limit)
    .select({ _id: 1 })
    .lean<{ _id: unknown }[]>();

  if (!candidates.length) return { cutoff, rows: [] };

  // GiÃ nh tá»«ng báº£n ghi; request thua (push_seen_at Ä‘Ã£ khÃ¡c null) thÃ¬ khÃ´ng nháº­n.
  const claimed: PushPendingRow[] = [];
  for (const c of candidates) {
    const row = await Models.Notification.findOneAndUpdate(
      { _id: c._id, user_id: userId, push_seen_at: null },
      { $set: { push_seen_at: cutoff } },
      { new: true, projection: { title: 1, body: 1, href: 1, created_at: 1 } },
    ).lean<PushPendingRow | null>();
    if (row) claimed.push(row);
  }

  // Tráº£ vá» theo thá»© tá»± thá»i gian tÄƒng dáº§n Ä‘á»ƒ thÃ´ng bÃ¡o hiá»‡n ra Ä‘Ãºng thá»© tá»± phiáº¿u Ä‘áº¿n.
  claimed.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return { cutoff, rows: claimed };
}

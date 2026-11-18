/**
 * Cảnh báo "phiếu tương tự" (DOC-01/DOC-02, cùng nguyên tắc v2 §5.1) — KHÔNG chặn lưu.
 *
 * Một phiếu ứng viên bị coi là tương tự khi: CÙNG loại (thu/chi) · CÙNG công ty ·
 * CÙNG đối tác · CÙNG tiền tệ · số tiền lệch trong ±5% so với số tiền đưa vào.
 * Đối tác khớp theo `partner_id`, HOẶC theo tên người thụ nộp tự do (`payee.name`,
 * chuẩn hoá bằng `normalizeNameKey`) với phiếu cũ chưa có `partner_id`.
 * Phiếu đã huỷ / bị từ chối không tham gia so khớp.
 *
 * Phần thuần (`scoreSimilarDocuments`) tách khỏi phần truy vấn (`findSimilarDocuments`)
 * để kiểm thử — giống `domain/partner/duplicates.ts`.
 */

import { DOC_KIND_LABEL, SIMILAR_AMOUNT_TOLERANCE_PERCENT, normalizeNameKey, statusLabel, type DocKind, type SimilarDocumentRow } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { escapeRegex, wireOf } from '../queries/index.ts';

/** Dung sai số tiền (%) — lấy từ hợp đồng chung để bộ lọc DB và bộ chấm điểm dùng cùng một ngưỡng. */
const TOLERANCE_PERCENT = BigInt(SIMILAR_AMOUNT_TOLERANCE_PERCENT);

/** Bản ghi gọn của một phiếu ứng viên (đã nạp + trang trí tên, BigInt đã chuẩn hoá). */
export interface SimilarCandidate {
  _id: string;
  code: string;
  kind: DocKind;
  status: string;
  title: string;
  amount: { minor: bigint; currency: string; decimals: number };
  partner_id: string | null;
  /** Tên người thụ nộp tự do trên phiếu (`payee.name`) — đường khớp cho phiếu cũ. */
  payee_name: string | null;
  /** Tên đối tác để hiển thị: phiếu có `partner_id` ⇒ tên đối tác đã nạp; phiếu cũ ⇒ `payee.name`. */
  partner_name: string | null;
  created_by_name: string;
  created_at: string | null;
  planned_date: string;
}

/** Phiếu đang nhập / đang mở — mang đi so khớp. */
export interface SimilarInput {
  /** Số tiền của phiếu đang nhập (minor units). */
  amountMinor: bigint;
  currency: string;
  partnerId: string;
  partnerName: string;
  /** Số dòng tối đa trả về (cắt SAU khi sắp xếp theo mức nghi ngờ). */
  limit: number;
}

/**
 * Thuần: lọc ±5% theo tiền tệ, xác định `matched_by`, tính độ lệch có dấu và %,
 * sắp xếp (đúng tiền trước → lệch ít hơn trước → mới hơn trước → `_id`) rồi cắt theo `limit`.
 *
 * So sánh ±5% bằng số nguyên: `|diff| * 100 <= amount * 5` ⇒ ngưỡng CHẶN 5% được giữ
 * (làm tròn theo hướng bao gồm), không dùng số thực để tránh sai lệch dấu phẩy động.
 */
export function scoreSimilarDocuments(input: SimilarInput, candidates: readonly SimilarCandidate[]): SimilarDocumentRow[] {
  const amount = input.amountMinor;
  if (amount <= 0n) return [];
  const partnerKey = normalizeNameKey(input.partnerName ?? '');

  interface Scored {
    row: SimilarDocumentRow;
    diffAbs: bigint;
    createdMs: number;
  }
  const scored: Scored[] = [];

  for (const c of candidates) {
    // Chỉ so với phiếu CÙNG tiền tệ — 5% của 100 USD không có nghĩa gì với 100 tỷ VND.
    if (c.amount.currency !== input.currency) continue;
    const diff = c.amount.minor - amount;
    const diffAbs = diff < 0n ? -diff : diff;
    if (diffAbs * 100n > amount * TOLERANCE_PERCENT) continue;

    // `partner_id` thắng; chỉ phiếu CHƯA có đối tác (dữ liệu cũ) mới được khớp theo tên tự do.
    let matchedBy: SimilarDocumentRow['matched_by'];
    if (c.partner_id && c.partner_id === input.partnerId) matchedBy = 'partner_id';
    else if (!c.partner_id && partnerKey && normalizeNameKey(c.payee_name ?? '') === partnerKey) matchedBy = 'payee_name';
    else continue;

    // % làm tròn 1 chữ số thập phân: round(|diff| * 1000 / amount) / 10 (số nguyên, nửa lên).
    const num = diffAbs * 1000n;
    const tenths = (2n * num + amount) / (2n * amount);

    scored.push({
      row: {
        _id: c._id,
        code: c.code,
        kind: c.kind,
        kind_label: DOC_KIND_LABEL[c.kind] ?? '',
        status: c.status,
        status_label: statusLabel(c.status),
        title: c.title,
        amount: { minor: c.amount.minor.toString(), currency: c.amount.currency as SimilarDocumentRow['amount']['currency'], decimals: c.amount.decimals },
        partner_id: c.partner_id,
        partner_name: c.partner_name,
        created_by_name: c.created_by_name,
        created_at: c.created_at,
        planned_date: c.planned_date,
        matched_by: matchedBy,
        exact_amount: diff === 0n,
        // Hiệu có dấu: phiếu ứng viên − số tiền đưa vào.
        amount_diff_minor: diff.toString(),
        amount_diff_percent: Number(tenths) / 10,
      },
      diffAbs,
      createdMs: c.created_at ? new Date(c.created_at).getTime() : 0,
    });
  }

  scored.sort((a, b) => {
    if (a.row.exact_amount !== b.row.exact_amount) return a.row.exact_amount ? -1 : 1;
    if (a.diffAbs !== b.diffAbs) return a.diffAbs < b.diffAbs ? -1 : 1;
    if (a.createdMs !== b.createdMs) return b.createdMs - a.createdMs; // mới hơn trước
    return a.row._id < b.row._id ? -1 : a.row._id > b.row._id ? 1 : 0; // tie-break ổn định
  });

  return scored.slice(0, Math.max(0, input.limit)).map((s) => s.row);
}

/** Đầu vào truy vấn phiếu tương tự trong một công ty (route đã kiểm phạm vi + zod). */
export interface FindSimilarInput {
  companyId: string;
  kind: DocKind;
  partnerId: string;
  amountMinor: bigint;
  currency: string;
  /** Sửa phiếu: loại trừ chính phiếu đang mở. */
  excludeId?: string | null;
  limit: number;
}

/**
 * Tải đối tác, lấy ứng viên trong ±5% (bộ lọc DB rộng, so khớp chặt do `scoreSimilarDocuments`),
 * trang trí tên đối tác / tên người tạo rồi chấm điểm.
 *
 * Đây là tính năng CẢNH BÁO: đối tác không tồn tại trong công ty ⇒ trả `[]`, không ném lỗi.
 */
export async function findSimilarDocuments(input: FindSimilarInput): Promise<SimilarDocumentRow[]> {
  const partner = await Models.Partner.findOne({ _id: input.partnerId, company_id: input.companyId })
    .select({ name: 1 })
    .lean<{ _id: unknown; name?: string }>();
  if (!partner) return [];
  const partnerName = String(partner.name ?? '');

  // Dải tiền ±5% làm nguyên: dưới = floor(a*0.95) = (19a)/20; trên = ceil(a*1.05) = (21a+19)/20.
  const a = input.amountMinor;
  const lo = (19n * a) / 20n;
  const hi = (21n * a + 19n) / 20n;

  const filter: Record<string, unknown> = {
    kind: input.kind,
    company_id: input.companyId,
    // Phiếu đã huỷ / bị từ chối không phải khả năng trùng.
    status: { $nin: ['cancelled', 'rejected'] },
    'amount.currency': input.currency,
    'amount.minor': { $gte: lo, $lte: hi },
    $or: [{ partner_id: input.partnerId }, { 'payee.name': { $regex: escapeRegex(partnerName), $options: 'i' } }],
  };
  if (input.excludeId) filter._id = { $ne: input.excludeId };

  // Trần cứng 100 ứng viên cho bộ lọc DB: đủ rộng cho ±5%, không nạp vô hạn vào bộ nhớ.
  const rows = await Models.Document.find(filter as never)
    .select({ code: 1, title: 1, kind: 1, status: 1, amount: 1, partner_id: 1, 'payee.name': 1, created_by: 1, created_at: 1, planned_date: 1 })
    .sort({ created_at: -1 })
    .limit(100)
    .lean<Record<string, unknown>[]>();

  // Tên người tạo — cùng quy tắc `decorateRows` (queries): `display_name ?? email`.
  const userIds = [...new Set(rows.map((r) => String(r.created_by ?? '')).filter(Boolean))];
  const users = userIds.length
    ? await Models.User.find({ _id: { $in: userIds } }).select({ display_name: 1, email: 1 }).lean<{ _id: unknown; display_name?: string; email?: string }[]>()
    : [];
  const uname = new Map(users.map((u) => [String(u._id), String(u.display_name ?? u.email ?? '—')]));

  const candidates: SimilarCandidate[] = rows.map((r) => {
    const amount = wireOf(r.amount);
    const partnerId = r.partner_id ? String(r.partner_id) : null;
    const payeeName = String((r.payee as { name?: string } | undefined)?.name ?? '') || null;
    return {
      _id: String(r._id),
      code: String(r.code ?? ''),
      kind: String(r.kind ?? input.kind) as DocKind,
      status: String(r.status ?? 'draft'),
      title: String(r.title ?? ''),
      amount: { minor: amount ? BigInt(amount.minor) : 0n, currency: amount?.currency ?? input.currency, decimals: amount?.decimals ?? 0 },
      partner_id: partnerId,
      payee_name: payeeName,
      // Chỉ một đối tác được so khớp: phiếu có partner_id ⇒ tên đối tác đã nạp; phiếu cũ ⇒ tên thụ nộp.
      partner_name: partnerId ? partnerName : payeeName,
      created_by_name: uname.get(String(r.created_by ?? '')) ?? '—',
      created_at: r.created_at ? new Date(r.created_at as string | Date).toISOString() : null,
      planned_date: String(r.planned_date ?? ''),
    };
  });

  return scoreSimilarDocuments(
    { amountMinor: input.amountMinor, currency: input.currency, partnerId: input.partnerId, partnerName, limit: input.limit },
    candidates,
  );
}

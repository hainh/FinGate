/**
 * 0007 — sửa đối tác của chuyển tiền nội bộ sau migration 0004 (v2/v2.md §5.1, §11.6).
 *
 * Lỗi của 0004: mọi phiếu chuyển nội bộ (phiếu chi có đích, phiếu thu tự sinh từ R1) bị xếp vào đối tác
 * "Chưa xác định" loại NCC. Sai với v2: phiếu chi chuyển nội bộ phải gán đối tác LOẠI `internal`
 * (công ty trong tập đoàn + TK đích), vì đích chuyển lấy từ đối tác đó (resolveTransferTarget).
 *
 * Việc làm — chỉ trên phiếu đang trỏ tới đối tác "Chưa xác định" do 0004 tạo (không đụng phiếu đã gán tay):
 *  1. Phiếu có đích chuyển nội bộ (công ty khác công ty phiếu + TK đích thuộc công ty đó) ⇒ gán đối tác
 *     `internal` của công ty phiếu trỏ tới TK đích. Dùng lại nếu đã có; chưa có thì tạo (tên/NH/STK lấy từ TK đích).
 *  2. Phiếu thu tự sinh từ chuyển nội bộ (auto_created / auto_source_document_id) không có đích ⇒ bỏ đối tác
 *     "Chưa xác định": R1 v2 tạo phiếu thu không đối tác ("công ty chuyển đi là ngoại lệ không đối tác").
 *  3. Đánh dấu đã xử lý các mục rà soát `unassigned_internal_transfer` của phiếu đã sửa.
 *  4. Xoá đối tác "Chưa xác định" do 0004 tạo mà không còn phiếu / công nợ / khoản vay / khoản chi định kỳ nào trỏ tới.
 *
 * Phiếu không xác định được đích (thiếu TK, TK không thuộc công ty đích) để nguyên và được báo cáo.
 *
 * Nguyên tắc:
 *  - Idempotent: chạy lại không đổi gì. Ghi có điều kiện (CAS) trên `partner_id` cũ — sửa đồng thời thì bỏ qua và báo.
 *  - Phiếu tăng `version` (CAS của API) và ghi `history` (action `migrate_v2`) để truy vết.
 *  - Không đổi cấu trúc trường, không xoá phiếu. Chỉ xoá đối tác tạm do chính migration 0004 tạo và không còn được dùng.
 *  - Không dùng transaction (ADR-03) — runner chỉ ghi "đã áp dụng" khi `up()` không ném lỗi.
 *
 * Chạy: `pnpm db:migrate` (runner chạy theo thứ tự tên file, sau 0004).
 */

export const MIGRATION_ID = '0007';
/** Đối tác tạm do 0004 tạo cho phiếu chưa xác định (name_key = chuẩn hoá của "Chưa xác định"). */
export const UNASSIGNED_NAME_KEY = 'chưa xác định';
const PARTNER_CODE_PREFIX = 'DT';
const REVIEW_COLLECTION = 'migration_reviews';
const REVIEW_REASON = 'unassigned_internal_transfer';

/* ------------------------------------------------------------------ *
 * Tiện ích thuần (không chạm DB)
 * ------------------------------------------------------------------ */

/** Gộp khoảng trắng, NFC, trim (giống migration 0004). */
export function cleanName(v) {
  return String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Khoá chống trùng tên — giống `normalizeNameKey` ở @fingate/shared. */
export function nameKeyOf(v) {
  return cleanName(v).toLowerCase();
}

/** Tên đối tác công ty trong tập đoàn: "Tên công ty · Tên tài khoản" (giống `internalPartnerName` ở apps/api). */
export function internalPartnerName(companyName, accountName) {
  return `${companyName} · ${accountName}`;
}

/** Nhãn "Mã công ty - Tên NH/quỹ - STK" trỏ tới công ty trong hệ thống (cùng quy tắc 0004). */
export function isInternalLabel(label, companyCodes) {
  const parts = cleanName(label).split(' - ');
  if (parts.length !== 3 || parts.some((p) => !p.trim())) return false;
  return companyCodes.has(parts[0].trim().toUpperCase());
}

const idOf = (v) => (v === null || v === undefined ? null : String(v));

/**
 * Đích chuyển nội bộ của phiếu: ưu tiên `transfer_target` (v2), rơi về `target` (v1). Chỉ nhận khi có công ty
 * và TK đích, và công ty đích khác công ty phiếu. Trả null nếu không có đích hợp lệ.
 */
export function internalDestOf(doc) {
  const pick = (v) => {
    if (!v || !v.company_id || !v.account_id) return null;
    return { company_id: v.company_id, account_id: v.account_id };
  };
  const dest = pick(doc.transfer_target) ?? pick(doc.target);
  if (!dest) return null;
  if (idOf(dest.company_id) === idOf(doc.company_id)) return null;
  return dest;
}

/**
 * Phiếu thuộc diện chuyển nội bộ — cùng điều kiện mà 0004 dùng để xếp "Chưa xác định" (internal_transfer).
 */
export function isInternalTransfer(doc, companyCodes) {
  return (
    doc.kind === 'internal' ||
    doc.payee?.is_internal === true ||
    doc.auto_created === true ||
    (doc.auto_source_document_id !== null && doc.auto_source_document_id !== undefined) ||
    isInternalLabel(doc.payee?.name, companyCodes)
  );
}

/** Phiếu thu do R1 tự sinh từ chuyển nội bộ (không có đích, không có đối tác). */
export function isAutoMirror(doc) {
  return doc.auto_created === true || (doc.auto_source_document_id !== null && doc.auto_source_document_id !== undefined);
}

/** Trạng thái đối tác nội bộ theo TK đích — cùng quy tắc `loadInternalSource` (usable). */
export function internalPartnerStatus(acct) {
  return acct.is_group !== true && acct.status === 'active' ? 'active' : 'inactive';
}

/* ------------------------------------------------------------------ *
 * Ghi dữ liệu
 * ------------------------------------------------------------------ */

const historyEntry = (now, fields) => ({
  at: now,
  actor: { user_id: null, role: null, name: `Migration ${MIGRATION_ID}` },
  action: 'migrate_v2',
  from: null,
  to: null,
  reason: null,
  request_id: `migration-${MIGRATION_ID}`,
  fields,
});

/** Mã đối tác `DT-YYYY-NNNNN` — cùng bộ đếm `counters` với nextPartnerCode (apps/api). */
async function nextPartnerCode(conn, at) {
  const year = at.getUTCFullYear();
  const res = await conn.collection('counters').findOneAndUpdate(
    { _id: `${PARTNER_CODE_PREFIX}-${year}` },
    { $inc: { seq: 1 }, $set: { updated_at: new Date() } },
    { upsert: true, returnDocument: 'after' },
  );
  const doc = res && Object.prototype.hasOwnProperty.call(res, 'value') ? res.value : res;
  const seq = Number(doc?.seq ?? 1);
  return `${PARTNER_CODE_PREFIX}-${year}-${String(seq).padStart(5, '0')}`;
}

/**
 * Chạy sửa. Trả về thống kê: { assigned, unlinked, created, deleted, unresolved: [{ code, reason }] }.
 */
export async function up(conn) {
  const now = new Date();
  const OID = conn.base?.Types?.ObjectId;
  if (typeof OID !== 'function') throw new Error(`[${MIGRATION_ID}] không lấy được ObjectId từ kết nối (conn.base.Types)`);
  const col = (name) => conn.collection(name);

  const companies = await col('companies').find({}).toArray();
  const companyName = new Map(companies.map((c) => [idOf(c._id), cleanName(c.name)]));
  const companyCodes = new Set(companies.map((c) => cleanName(c.code).toUpperCase()).filter(Boolean));

  const accounts = new Map((await col('bank_accounts').find({}).toArray()).map((a) => [idOf(a._id), a]));

  // Đối tác nội bộ đã có: tra theo (công ty, TK đích) để dùng lại, không tạo trùng.
  const internalByKey = new Map();
  for (const p of await col('partners').find({ type: 'internal' }).toArray()) {
    internalByKey.set(`${idOf(p.company_id)}|${idOf(p.internal_account_id)}`, p);
  }

  const unassigned = await col('partners')
    .find({ 'migration.migration': '0004', type: 'supplier', name_key: UNASSIGNED_NAME_KEY })
    .toArray();
  const unassignedIds = unassigned.map((p) => p._id);

  const stats = { assigned: 0, unlinked: 0, created: 0, deleted: 0, unresolved: [] };
  const fixedDocIds = [];

  if (unassignedIds.length) {
    const docs = await col('documents').find({ partner_id: { $in: unassignedIds } }).toArray();

    for (const d of docs) {
      if (!isInternalTransfer(d, companyCodes)) continue;
      const oldPid = d.partner_id;
      const dest = internalDestOf(d);

      if (dest) {
        const acct = accounts.get(idOf(dest.account_id));
        if (!acct || idOf(acct.company_id) !== idOf(dest.company_id)) {
          stats.unresolved.push({ code: d.code ?? idOf(d._id), reason: 'TK đích không thuộc công ty đích' });
          continue;
        }
        const key = `${idOf(d.company_id)}|${idOf(dest.account_id)}`;
        let partner = internalByKey.get(key);
        if (!partner) {
          const name = internalPartnerName(companyName.get(idOf(dest.company_id)) ?? '', cleanName(acct.account_name));
          partner = {
            _id: new OID(),
            company_id: d.company_id,
            code: await nextPartnerCode(conn, now),
            type: 'internal',
            status: internalPartnerStatus(acct),
            name,
            name_key: nameKeyOf(name),
            bank_name: cleanName(acct.bank_name) || null,
            account_number: String(acct.account_number ?? '') || null,
            tax_code: null,
            internal_company_id: dest.company_id,
            internal_account_id: dest.account_id,
            note: `Đối tác công ty trong tập đoàn tạo khi chuyển đổi v2 (migration ${MIGRATION_ID}).`,
            history: [historyEntry(now, { created: { from: null, to: 'migrate_v2' } })],
            created_by: null,
            created_at: now,
            updated_at: now,
            migration: { source: 'v1', migration: MIGRATION_ID, key },
          };
          await col('partners').insertOne(partner);
          internalByKey.set(key, partner);
          stats.created += 1;
        }
        const res = await col('documents').updateOne(
          { _id: d._id, partner_id: oldPid },
          {
            $set: { partner_id: partner._id },
            $inc: { version: 1 },
            $push: { history: historyEntry(now, { partner_id: { from: idOf(oldPid), to: idOf(partner._id) } }) },
          },
        );
        if (res.matchedCount === 1) {
          stats.assigned += 1;
          fixedDocIds.push(idOf(d._id));
          console.log(`  · documents ${d.code ?? d._id}: "Chưa xác định" → ${partner.name} (internal)`);
        } else {
          console.log(`  · documents ${d.code ?? d._id}: đã sửa đồng thời — bỏ qua`);
        }
      } else if (isAutoMirror(d)) {
        const res = await col('documents').updateOne(
          { _id: d._id, partner_id: oldPid },
          {
            $set: { partner_id: null },
            $inc: { version: 1 },
            $push: { history: historyEntry(now, { partner_id: { from: idOf(oldPid), to: null } }) },
          },
        );
        if (res.matchedCount === 1) {
          stats.unlinked += 1;
          fixedDocIds.push(idOf(d._id));
          console.log(`  · documents ${d.code ?? d._id}: bỏ "Chưa xác định" (phiếu thu tự sinh từ chuyển nội bộ)`);
        }
      } else {
        stats.unresolved.push({ code: d.code ?? idOf(d._id), reason: 'chưa xác định được công ty / TK đích' });
      }
    }

    if (fixedDocIds.length) {
      await col(REVIEW_COLLECTION).updateMany(
        { migration: '0004', collection: 'documents', reason: REVIEW_REASON, ref_id: { $in: fixedDocIds } },
        { $set: { resolved: true, resolved_at: now, resolved_by: MIGRATION_ID } },
      );
    }

    // Dọn đối tác tạm của 0004 không còn được tham chiếu.
    for (const p of unassigned) {
      const refs = await Promise.all(
        ['documents', 'debt_vouchers', 'bank_debts', 'recurring_rules'].map((c) => col(c).countDocuments({ partner_id: p._id })),
      );
      if (refs.some((n) => n > 0)) continue;
      await col('partners').deleteOne({ _id: p._id });
      await col(REVIEW_COLLECTION).updateMany(
        { migration: '0004', collection: 'partners', ref_id: idOf(p._id) },
        { $set: { resolved: true, resolved_at: now, resolved_by: MIGRATION_ID } },
      );
      stats.deleted += 1;
      console.log(`  · partners ${p.code ?? p._id}: xoá "Chưa xác định" tạm (không còn được dùng)`);
    }
  }

  console.log(
    `· ${MIGRATION_ID}: gán đối tác nội bộ ${stats.assigned} (đối tác mới ${stats.created}), bỏ đối tác ở phiếu thu tự sinh ${stats.unlinked}, ` +
      `xoá đối tác tạm ${stats.deleted}, chưa xử lý ${stats.unresolved.length}`,
  );
  for (const u of stats.unresolved) console.log(`  · cần rà soát tay: ${u.code} — ${u.reason}`);
  return stats;
}

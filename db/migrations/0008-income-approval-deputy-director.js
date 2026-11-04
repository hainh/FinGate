/**
 * 0008 — thêm bước PGĐ vào chuỗi duyệt mặc định của PHIẾU THU.
 *
 * Trước đây dòng `ApprovalMatrix` của `income` do seed tạo là KTT → GĐ → P.TGĐ, KHÔNG có PGĐ.
 * Ma trận là DỮ LIỆU và được resolve trước `DEFAULT_STEPS` (`domain/workflow/matrix.ts`), nên sửa
 * default trong mã KHÔNG đủ: DB cũ vẫn dùng dòng cũ. Migration chèn PGĐ vào đúng các dòng
 * `income` khớp hình dạng chuỗi mặc định cũ — tức chuỗi KTT → GĐ (→ P.TGĐ) đúng thứ tự đó.
 *
 * Không đụng dòng ma trận do người dùng tự cấu hình khác hình dạng này (vd đã có PGĐ, hoặc thứ tự
 * khác): nội dung cấu hình tay là ý nguyện của quản trị, migration không ghi đè. Hồ sơ đang đi dở
 * KHÔNG bị ảnh hưởng: chuỗi duyệt đã SNAPSHOT vào `documents.approval.steps` lúc gửi (§19.5-7).
 *
 * Chạy lại vô hại: dòng đã có PGĐ không còn khớp hình dạng cũ nên không bị chèn lần hai.
 */

/** Hình dạng chuỗi mặc định CŨ của phiếu thu (trước khi có PGĐ). */
const OLD_INCOME_ROLES = ['chief_accountant', 'director', 'deputy_chairman'];

/** Vị trí chèn PGĐ: ngay sau KTT (giống phiếu chi). */
const DEPUTY_DIRECTOR = { role: 'deputy_director', sla_hours: 24, mandatory: true };

/** Nhãn cũ (seed) — chỉ đổi khi nhãn vẫn là nhãn mặc định, giữ nguyên nhãn người dùng tự đặt. */
const OLD_LABEL = 'Khoản thu — KTT → GĐ → P.TGĐ';
const NEW_LABEL = 'Khoản thu — KTT → PGĐ → GĐ → P.TGĐ';

/**
 * Dòng này có đúng là chuỗi mặc định CŨ của phiếu thu không?
 * So theo TẬP vai trò + thứ tự (bỏ qua order/sla trong dữ liệu cũ) để chấp nhận cả dòng seed
 * lẫn dòng nhập tay y hệt hình dạng đó.
 */
export function isLegacyIncomeChain(steps) {
  if (!Array.isArray(steps)) return false;
  const roles = steps.map((s) => s?.role);
  return roles.length === OLD_INCOME_ROLES.length && roles.every((r, i) => r === OLD_INCOME_ROLES[i]);
}

/** Chèn bước PGĐ ngay sau KTT rồi đánh số lại liên tục từ 1. */
export function withDeputyDirector(steps) {
  const out = steps.map((s) => ({ order: s.order, role: s.role, sla_hours: s.sla_hours ?? 24, mandatory: s.mandatory !== false }));
  const at = out.findIndex((s) => s.role === 'chief_accountant');
  out.splice(at + 1, 0, { ...DEPUTY_DIRECTOR });
  return out.map((s, i) => ({ ...s, order: i + 1 }));
}

export async function up(conn) {
  const coll = conn.collection('approval_matrix');
  const rows = await coll.find({ doc_kind: 'income' }).toArray();
  let updated = 0;
  for (const row of rows) {
    if (!isLegacyIncomeChain(row.steps)) continue;
    const $set = { steps: withDeputyDirector(row.steps), updated_at: new Date() };
    if (row.label === OLD_LABEL) $set.label = NEW_LABEL;
    // CAS trên `steps` cũ: người dùng có thể vừa sửa ma trận (ADM-04) trong lúc migration chạy.
    const r = await coll.updateOne({ _id: row._id, steps: row.steps }, { $set });
    updated += r.modifiedCount ?? 0;
  }
  console.log(`· thêm bước PGĐ vào ${updated}/${rows.length} dòng ma trận phiếu thu`);
}

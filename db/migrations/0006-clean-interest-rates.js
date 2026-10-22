/**
 * 0006 — làm sạch lãi suất cũ về quy tắc hiện hành: tối đa 2 chữ số thập phân
 * (v2/v2.md §10.1; docs/02_design_system.md §4.3 "Lãi suất: 2 thập phân + %/năm").
 *
 * Số 0005 để dành cho bước bỏ trường v1 (docs/v2-implementation.md §15.4).
 *
 * Contract mới (apps/api/src/domain/debt/bodies.ts, packages/shared/src/contracts/*) chỉ CHẶN ghi mới;
 * bản ghi tạo trước đó vẫn giữ giá trị vi phạm. Migration này dọn đúng các trường lãi suất còn vi phạm:
 *
 *   bank_debts.interest_rate                     "9,555" → "9,56" (làm tròn nửa lên); không phải số → "0" (mặc định của trường)
 *   documents.rollover.new_rate                  "abc"   → null   (phương án đảo hạn: người dùng nhập lại)
 *   documents.rollover.result.new_rate           như trên
 *   documents.options.loan.terms.interest_rate   "9,555" → "9,56" (điều khoản vay gắn trên phiếu — nguồn của quy tắc R2
 *                                                                  sinh khoản vay, nên giữ khớp với bank_debts)
 *
 * Nguyên tắc:
 *  - Chỉ đụng bản ghi vi phạm. Giá trị đã đúng ("9,5", "9.50") giữ nguyên ⇒ chạy lại không làm gì (idempotent).
 *  - Ghi có điều kiện (CAS): chỉ cập nhật khi trường vẫn mang đúng giá trị cũ đã đọc; sửa đồng thời thì bỏ qua và báo.
 *  - Mỗi thay đổi ghi `history` trước → sau (action `update`, fields.changes) để truy vết được; phiếu tăng `version`
 *    (CAS của API) để ETag/If-Match cũ bị từ chối.
 *  - Không đổi cấu trúc trường, không xoá bản ghi (tương thích lùi, docs/04_architecture.md §12.4).
 */

export const MIGRATION_ID = '0006';

/** Quy tắc lãi suất: số, tối đa 2 chữ số thập phân, dấu phẩy hoặc chấm (cùng regex của contract). */
export const RATE_RE = /^\d+([.,]\d{1,2})?$/;

/**
 * Trường lãi suất cần làm sạch. `unreadable` = giá trị thay khi không đọc được thành số
 * (bank_debts: mặc định của trường là '0'; trường trên phiếu: mặc định là null).
 */
export const RATE_PATHS = [
  { collection: 'bank_debts', path: 'interest_rate', unreadable: '0' },
  { collection: 'documents', path: 'rollover.new_rate', unreadable: null },
  { collection: 'documents', path: 'rollover.result.new_rate', unreadable: null },
  { collection: 'documents', path: 'options.loan.terms.interest_rate', unreadable: null },
];

const REASON = {
  normalized: `Chuẩn hoá lãi suất về dạng số (bỏ ký hiệu thừa, dấu phẩy thập phân) — migration ${MIGRATION_ID}`,
  rounded: `Làm tròn lãi suất về 2 chữ số thập phân — migration ${MIGRATION_ID}`,
  unreadable: `Lãi suất không phải số, đã đặt về giá trị mặc định — cần nhập lại — migration ${MIGRATION_ID}`,
};

/**
 * Đưa một lãi suất về quy tắc hiện hành. Trả `{ value, status }`:
 *  - 'ok'         đã đúng (giữ nguyên; null/undefined = chưa có lãi suất, không phải vi phạm);
 *  - 'normalized' là số nhưng có ký hiệu thừa hoặc kiểu không phải chuỗi ("9,5 %" → "9,5", 9.5 → "9,5");
 *  - 'rounded'    quá 2 chữ số thập phân → làm tròn nửa lên bằng số học thập phân, không qua float
 *                 ("9,555" → "9,56", "9,999" → "10", "12,350" → "12,35");
 *  - 'unreadable' không đọc được thành số ("abc", "1e3", "-2", "") → `unreadable`.
 */
export function cleanRate(raw, unreadable) {
  if (raw === null || raw === undefined) return { value: null, status: 'ok' };
  const s = String(raw).trim();
  if (RATE_RE.test(s))
    return typeof raw === 'string'
      ? { value: s, status: 'ok' }
      : { value: s.replace('.', ','), status: 'normalized' };

  const m = /^(\d*)(?:[.,](\d+))?\s*%?$/.exec(s);
  if (!m || (m[1] === '' && m[2] === undefined)) return { value: unreadable, status: 'unreadable' };
  const whole = m[1] || '0';
  const frac = m[2] ?? '';
  if (frac.length <= 2) return { value: frac ? `${whole},${frac}` : whole, status: 'normalized' };

  // Làm tròn nửa lên trên BigInt (đơn vị: phần trăm). Chữ số thập phân thứ 3 ≥ 5 ⇒ cộng thêm 1 phần trăm.
  const hundredths = BigInt(whole + frac.slice(0, 2)) + (frac.charCodeAt(2) >= 0x35 ? 1n : 0n);
  const cents = String(hundredths % 100n)
    .padStart(2, '0')
    .replace(/0+$/, '');
  const int = hundredths / 100n;
  return { value: cents ? `${int},${cents}` : String(int), status: 'rounded' };
}

/** Đường dẫn lồng nhau ("a.b.c") trên bản ghi thô. */
const getPath = (doc, path) =>
  path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), doc);

const asText = (v) => (v === null || v === undefined ? null : String(v));

/** Mục lịch sử trước → sau (cùng dạng với lịch sử khoản vay / phiếu; actor là hệ thống). */
function historyEntry(now, path, from, to, status) {
  return {
    at: now,
    actor: { user_id: null, role: null, name: `Migration ${MIGRATION_ID}` },
    action: 'update',
    from: null,
    to: null,
    amount_at_decision: null,
    opinion: null,
    reason: REASON[status],
    request_id: `migration-${MIGRATION_ID}`,
    ip: null,
    fields: {
      changed: [path],
      changes: { [path]: { from: asText(from), to: asText(to) } },
      migration: MIGRATION_ID,
    },
  };
}

/**
 * Chạy làm sạch. Trả về thống kê theo từng trường: { 'bank_debts.interest_rate': { rounded, normalized, unreadable, conflict } }.
 */
export async function up(conn) {
  const now = new Date();
  const totals = {};

  for (const { collection, path, unreadable } of RATE_PATHS) {
    const col = conn.collection(collection);
    // Vi phạm = có giá trị và (không phải chuỗi khớp quy tắc). `$not` cũng bắt cả kiểu không phải chuỗi.
    const rows = await col
      .find(
        { [path]: { $ne: null, $not: RATE_RE } },
        { projection: { _id: 1, code: 1, [path]: 1 } },
      )
      .toArray();

    const stat = { rounded: 0, normalized: 0, unreadable: 0, conflict: 0 };
    for (const row of rows) {
      const old = getPath(row, path);
      const { value, status } = cleanRate(old, unreadable);
      if (status === 'ok') continue;

      const update = {
        $set: { [path]: value, updated_at: now },
        $push: { history: historyEntry(now, path, old, value, status) },
      };
      if (collection === 'documents') update.$inc = { version: 1 };
      // CAS: chỉ ghi khi trường còn đúng giá trị cũ đã đọc (không ghi đè sửa đổi đồng thời).
      const res = await col.updateOne({ _id: row._id, [path]: old }, update);
      if (res.matchedCount === 1) {
        stat[status] += 1;
        console.log(
          `  · ${collection} ${row.code ?? row._id} ${path}: "${asText(old)}" → "${asText(value)}" (${status})`,
        );
      } else {
        stat.conflict += 1;
        console.log(`  · ${collection} ${row.code ?? row._id} ${path}: đã sửa đồng thời — bỏ qua`);
      }
    }

    totals[`${collection}.${path}`] = stat;
    console.log(
      `· ${collection}.${path}: ${rows.length} vi phạm — làm tròn ${stat.rounded}, chuẩn hoá ${stat.normalized}, không đọc được ${stat.unreadable}` +
        (stat.conflict ? `, bỏ qua ${stat.conflict} (sửa đồng thời)` : ''),
    );
  }
  return totals;
}

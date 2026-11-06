#!/usr/bin/env node
/**
 * Sửa dữ liệu tồn đọng của lỗi "phiếu quỹ tiền mặt bị dựng lại bước Kế toán trưởng".
 *
 * BỐI CẢNH: trước bản fix 6a5d7ba, `rerunPendingApprovals` nạp hồ sơ thiếu `source` nên
 * `resolveMatrix` coi phiếu quỹ tiền mặt là phiếu ngân hàng và gán LẠI bước `chief_accountant`.
 * Hồ sơ như vậy không thuộc "Chờ tôi duyệt" của ai (lưới an toàn ẩn đi), chỉ nằm ở tab
 * "Chờ đến lượt tôi duyệt" — coi như kẹt cho tới khi được chạy lại chuỗi.
 *
 * Script CHỈ đụng đúng các hồ sơ còn `chief_accountant` ở trạng thái `current/waiting` của công ty
 * KHÔNG bật "Qua KTT duyệt"; mỗi hồ sơ được chạy lại bằng chính `rerunPendingApprovals` (giữ nguyên
 * lịch sử, chỉ thay chuỗi bước còn phải duyệt). Mặc định CHỈ ĐỌC; thêm `--apply` mới ghi.
 *
 * CÁCH DÙNG (sau khi đã deploy bản fix và build):
 *   pnpm -F @fingate/shared build && pnpm -F @fingate/api build
 *   MONGODB_URI='<uri>' node apps/api/scripts/repair-cash-approval-chains.mjs           # xem trước
 *   MONGODB_URI='<uri>' node apps/api/scripts/repair-cash-approval-chains.mjs --apply   # sửa
 *
 * Chạy được nhiều lần (idempotent): lần sau không còn hồ sơ nào thì thoát.
 */
import { writeFileSync } from 'node:fs';

process.env.MONGODB_URI = (process.env.MONGODB_URI ?? '').trim();
if (!process.env.MONGODB_URI) {
  console.error(
    'Thiếu MONGODB_URI. Ví dụ: MONGODB_URI=\'mongodb+srv://...\' node apps/api/scripts/repair-cash-approval-chains.mjs',
  );
  process.exit(1);
}
// `getEnv()` của API đòi 3 secret này; script chỉ đọc/ghi DB nên giá trị giả là đủ.
process.env.SESSION_SECRET ||= 'repair-cash-chains-session-secret-32b';
process.env.FIELD_KEY ||= '0'.repeat(64);
process.env.TASK_TOKEN ||= 'repair-cash-chains';

const { connectDb, disconnectDb } = await import('../dist/lib/mongo.js');
const { Models } = await import('../dist/db/models.js');
const { DECISION_STATUSES } = await import('../dist/domain/queries/index.js');
const { cashRequiresKttForMany } = await import('../dist/domain/workflow/cash-approval.js');
const { rerunPendingApprovals } = await import('../dist/domain/workflow/rerun.js');

const apply = process.argv.includes('--apply');

await connectDb();

// Ứng viên: phiếu thu/chi quỹ tiền mặt còn bước KTT chờ trong chuỗi snapshot.
const candidates = await Models.Document.find({
  kind: { $in: ['spend', 'income'] },
  'source.fund': { $in: ['cash', 'fund'] },
  status: { $in: [...DECISION_STATUSES] },
  'approval.steps': { $elemMatch: { role: 'chief_accountant', state: { $in: ['current', 'waiting'] } } },
})
  .select({ code: 1, kind: 1, company_id: 1, status: 1, 'approval.steps': 1 })
  .lean();

if (!candidates.length) {
  console.log('✅ Không còn hồ sơ quỹ tiền mặt nào sót bước KTT chờ — không cần sửa.');
  await disconnectDb();
  process.exit(0);
}

// Chỉ hồ sơ của công ty KHÔNG bật "Qua KTT duyệt" mới là dữ liệu cũ sai; công ty đang bật thì bước KTT là đúng.
const companyIds = [...new Set(candidates.map((d) => String(d.company_id)))];
const enabled = await cashRequiresKttForMany(companyIds);
const stale = candidates.filter((d) => !enabled.get(String(d.company_id)));

if (!stale.length) {
  console.log(`✅ ${candidates.length} hồ sơ có bước KTT chờ nhưng đều thuộc công ty ĐANG bật "Qua KTT duyệt" — không cần sửa.`);
  await disconnectDb();
  process.exit(0);
}

console.log(`Tìm thấy ${stale.length} hồ sơ cần chạy lại chuỗi duyệt:`);
for (const d of stale) {
  const ktt = (d.approval?.steps ?? []).find((s) => s.role === 'chief_accountant');
  console.log(`  ${d.code}  ${d.status}  · công ty ${String(d.company_id)} · bước KTT ${ktt?.state ?? '?'}`);
}

// Sao lưu (chỉ đọc) đúng các hồ sơ sẽ bị sửa — để đối chiếu/khôi phục nếu cần.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupFile = `repair-cash-chains-backup-${stamp}.json`;
writeFileSync(backupFile, JSON.stringify(stale, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
console.log(`\nĐã lưu bản sao hồ sơ trước khi sửa: ${backupFile}`);

if (!apply) {
  console.log('\nCHỈ ĐỌC — chưa ghi gì. Thêm --apply để chạy lại chuỗi cho các hồ sơ trên.');
  await disconnectDb();
  process.exit(0);
}

const result = await rerunPendingApprovals({
  reason: 'Sửa chuỗi duyệt phiếu quỹ tiền mặt bị dựng lại bước Kế toán trưởng',
  documentIds: stale.map((d) => String(d._id)),
});
console.log('\nKết quả:', JSON.stringify(result, null, 2));

await disconnectDb();

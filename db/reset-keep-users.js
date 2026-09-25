#!/usr/bin/env node
/**
 * `pnpm db:reset-keep-users` — reset dữ liệu nghiệp vụ nhưng GIỮ tài khoản người dùng
 * và cấu hình tổ chức (khác `db:reset` là xoá sạch mọi collection).
 *
 * Giữ: users · companies · departments · assignments · bank_accounts ·
 *       approval_matrix · categories · settings
 * Xoá: hồ sơ, số dư, giao dịch, khoản vay, công nợ, ngân sách, khoản định kỳ,
 *      cảnh báo, thông báo, audit, job, phiên đăng nhập, bộ đếm...
 *
 * Số dư ngân hàng về 0 vì `balances_daily` bị xoá (số dư suy ra từ bản ghi mới nhất,
 * không có bản ghi ⇒ 0). Yêu cầu cờ `--yes`; không có cờ thì chỉ in thống kê rồi dừng.
 */
import { withDb } from './_common.js';

const yes = process.argv.includes('--yes') || process.argv.includes('-y');

/** Model giữ nguyên khi reset. */
const KEEP = new Set([
  'Company',        // companies
  'Department',     // departments
  'User',           // users
  'Assignment',     // assignments
  'ApprovalMatrix', // approval_matrix
  'BankAccount',    // bank_accounts (số dư đưa về 0)
  'Category',       // categories
  'Setting',        // settings
]);

await withDb(async (_env, log) => {
  const { Models } = await import('../apps/api/dist/db/models.js');
  const purge = Object.keys(Models).filter((name) => !KEEP.has(name));

  const before = {};
  let total = 0;
  for (const name of purge) {
    before[name] = await Models[name].countDocuments({}).exec();
    total += before[name];
  }

  if (!yes) {
    log(`! Sẽ xoá ${total} document trong ${purge.length} collection, giữ ${KEEP.size} collection: ${[...KEEP].join(', ')}.`);
    log(`  ${purge.map((n) => `${n}=${before[n]}`).join(' · ')}`);
    log('  ⚠ CHƯA xoá gì cả. Thêm --yes để xác nhận.');
    return { aborted: true, documents: total };
  }

  for (const name of purge) await Models[name].deleteMany({}).exec().catch(() => undefined);
  const accounts = await Models.BankAccount.countDocuments({}).exec();
  log(`✓ đã xoá ${total} document trong ${purge.length} collection · giữ ${KEEP.size} collection`);
  log(`✓ ${accounts} tài khoản ngân hàng đặt số dư về 0 (đã xoá balances_daily)`);
  return { deleted: total, collections: purge.length, kept: [...KEEP], bank_accounts: accounts };
});

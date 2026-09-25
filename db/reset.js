#!/usr/bin/env node
/**
 * `pnpm db:reset` — XOÁ SẠCH toàn bộ dữ liệu app (mọi collection), giữ schema/index.
 *
 * Dùng trước `pnpm db:bootstrap` để có DB trắng + tài khoản quản trị đầu tiên.
 * Yêu cầu cờ `--yes` để tránh xoá nhầm (không có cờ thì chỉ in thống kê rồi dừng).
 */
import { withDb } from './_common.js';

const yes = process.argv.includes('--yes') || process.argv.includes('-y');

await withDb(async (_env, log) => {
  const { Models } = await import('../apps/api/dist/db/models.js');
  const names = Object.keys(Models);

  const before = {};
  for (const name of names) before[name] = await Models[name].countDocuments({}).exec();
  const total = Object.values(before).reduce((a, b) => a + b, 0);

  if (!yes) {
    log(`! Sẽ xoá ${total} document trong ${names.length} collection.`);
    log(`  ${names.map((n) => `${n}=${before[n]}`).join(' · ')}`);
    log('  ⚠ CHƯA xoá gì cả. Thêm --yes để xác nhận.');
    return { aborted: true, documents: total };
  }

  for (const name of names) await Models[name].deleteMany({}).exec().catch(() => undefined);
  log(`✓ đã xoá sạch ${total} document trong ${names.length} collection`);
  return { deleted: total, collections: names.length };
});

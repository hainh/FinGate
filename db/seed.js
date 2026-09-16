#!/usr/bin/env node
/**
 * `pnpm db:seed` — dữ liệu demo ĐÚNG NGHIỆP VỤ (DS §13.4, Phụ lục B), ẩn danh (BA-11).
 *   --force  : seed đè (xoá trắng dữ liệu nghiệp vụ trước)
 * mặc định: chỉ seed khi users rỗng.
 */
import { withDb } from './_common.js';

const force = process.argv.includes('--force');

await withDb(async (env, log) => {
  const { Models } = await import('../apps/api/dist/db/models.js');
  const { seedAll, seedIfEmpty } = await import('../apps/api/dist/db/seed.js');
  if (force) {
    log('! --force: xoá dữ liệu cũ');
    for (const name of Object.keys(Models)) await Models[name].deleteMany({}).exec().catch(() => undefined);
    return seedAll(log);
  }
  void env;
  return seedIfEmpty(log);
});

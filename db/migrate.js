#!/usr/bin/env node
/**
 * `pnpm db:migrate` — chạy tuần tự db/migrations/NNNN-*.js (arch §12.2).
 * Migration BẮT BUỘC tương thích lùi (thêm trước, bỏ sau — §12.4) nên không có "down".
 * Bảng trạng thái ở collection `settings` key `migrations.applied` → chạy lại vô hại.
 */

import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withDb } from './_common.js';
// 'mongoose' không resolve được từ db/ (pnpm node_modules nghiêm ngặt) → lấy qua
// module đã dùng ở apps/api/dist (đã được connectDb() kết nối trong withDb).
import { connectDb } from '../apps/api/dist/lib/mongo.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

await withDb(async () => {
  const { Models } = await import('../apps/api/dist/db/models.js');
  const applied = new Set(
    (await Models.Setting.findOne({ key: 'migrations.applied' }).lean())?.value?.applied ?? [],
  );

  let files = [];
  try {
    files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{4}-.+\.js$/.test(f)).sort();
  } catch {
    console.log('· chưa có thư mục migrations — bỏ qua');
    return { applied: 0, pending: 0 };
  }

  const pending = files.filter((f) => !applied.has(f));
  if (!pending.length) {
    console.log(`· ${files.length} migration đã áp dụng, không có gì chờ`);
    return { applied: applied.size, pending: 0 };
  }

  for (const file of pending) {
    const mod = await import(pathToFileURL(resolve(MIGRATIONS_DIR, file)).href);
    if (typeof mod.up !== 'function') throw new Error(`${file} thiếu export up(db)`);
    process.stdout.write(`→ ${file} `);
    const mongoose = await connectDb();
    await mod.up(mongoose.connection);
    applied.add(file);
    await Models.Setting.updateOne(
      { key: 'migrations.applied' },
      { $set: { key: 'migrations.applied', value: { applied: [...applied], at: new Date().toISOString() }, updated_at: new Date() } },
      { upsert: true },
    ).exec();
    console.log('ok');
  }
  return { applied: applied.size, newly: pending.length };
});

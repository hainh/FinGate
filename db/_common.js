/**
 * Hạ tầng chung cho các script `db/*` (architecture §12.2 preDeployCommand).
 * Chạy sau `pnpm build` vì import từ apps/api/dist — Node 24 + ESM thuần, không dep thêm.
 *
 * Nạp `.env` ở gốc repo TRƯỚC `loadEnv()` để script dùng đúng MONGODB_URI / secret /
 * BOOTSTRAP_ADMIN_* — tránh chạy nhầm DB local khi `.env` trỏ Atlas (Node ≥ 20.12 có
 * `process.loadEnvFile`). Biến đã có trong môi trường sẽ được giữ nguyên.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connectDb, disconnectDb } from '../apps/api/dist/lib/mongo.js';
import { loadEnv } from '../apps/api/dist/env.js';

const envFile = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    console.warn(`[db] không nạp được ${envFile} — dùng biến môi trường hiện có`);
  }
}

export async function withDb(fn) {
  const env = loadEnv();
  await connectDb();
  // log vừa gọi như hàm, vừa có mặt gọi của Fastify logger (domain code nhận log)
  const log = (msg) => console.log(String(msg).replace(/^"|"$/g, ''));
  log.info = log;
  log.warn = log;
  log.debug = () => {};
  log.trace = () => {};
  log.fatal = log;
  log.error = (obj, msg) => console.error(typeof obj === 'string' ? obj : (msg ?? ''));
  log.child = () => log;

  try {
    const result = await fn(env, log);
    if (result && typeof result === 'object' && result.aborted) {
      process.exitCode = 1;
      return result;
    }
    log(`✓ xong${result ? ': ' + JSON.stringify(result) : ''}`);
    return result;
  } finally {
    await disconnectDb();
  }
}

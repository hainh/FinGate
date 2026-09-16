/**
 * Hạ tầng chung cho các script `db/*` (architecture §12.2 preDeployCommand).
 * Chạy sau `pnpm build` vì import từ apps/api/dist — Node 24 + ESM thuần, không dep thêm.
 */

import { connectDb, disconnectDb } from '../apps/api/dist/lib/mongo.js';
import { loadEnv } from '../apps/api/dist/env.js';

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
    log(`✓ xong${result ? ': ' + JSON.stringify(result) : ''}`);
    return result;
  } finally {
    await disconnectDb();
  }
}

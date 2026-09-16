/**
 * Entrypoint — `node apps/api/dist/server.js` (Render startCommand) hoặc
 * `node --watch src/server.ts` (dev, Node 24 type-stripping).
 *
 * Graceful shutdown theo SIGTERM của Render: ngừng nhận request, để reply xong
 * (timeout 10s < grace mặc định), đóng mongoose. Không có queue cần drain (K-7).
 */

import { build } from './app.ts';
import { loadEnv } from './env.ts';
import { connectDb, disconnectDb, dbUp } from './lib/mongo.ts';
import { applyIndexes } from './db/indexes.ts';
import { seedIfEmpty } from './db/seed.ts';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await build();

  try {
    await connectDb();
    await applyIndexes((msg) => app.log.info(msg));
    if (env.SEED_ON_BOOT === 'true') await seedIfEmpty(app.log);
  } catch (err) {
    // DB chưa lên (Atlas M0 bị pause / mongo container chưa ready) → vẫn boot để
    // /healthz trả về degraded, Render không kill loop vô hạn
    app.log.error({ err }, 'không kết nối được MongoDB — tiếp tục với db: down');
  }

  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info(
    { version: env.VERSION, profile: env.PROFILE, storage: env.STORAGE_DRIVER, db: dbUp() ? 'up' : 'down' },
    `FinGate sẵn sàng tại ${env.PUBLIC_URL}`,
  );

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal}: đang đóng`);
    const timer = setTimeout(() => {
      app.log.error('quá 10s, buộc thoát');
      process.exit(1);
    }, 10_000);
    timer.unref();
    void app
      .close()
      .then(() => disconnectDb())
      .then(() => {
        clearTimeout(timer);
        process.exit(0);
      })
      .catch((err: unknown) => {
        app.log.error({ err }, 'lỗi khi đóng');
        process.exit(1);
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => app.log.error({ reason }, 'unhandledRejection'));
}

void main().catch((err: unknown) => {
  console.error('[fingate] không khởi động được:', err instanceof Error ? err.message : err);
  process.exit(1);
});

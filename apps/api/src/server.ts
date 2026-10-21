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
import { bootstrapAdminIfEmpty, ensureGroupCompany } from './db/bootstrap.ts';
import { ensureAutomationRules } from './domain/automation/engine.ts';
import './domain/automation/rules/index.ts'; // đăng ký bộ xử lý R1–R6 (trước khi chu kỳ tự động chạy)
import { startAutomationLoop } from './jobs/index.ts';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await build();

  try {
    await connectDb();
    await applyIndexes((msg) => app.log.info(msg));
    // Hệ thống chỉ có MỘT pháp nhân Tập đoàn — tạo sẵn (idempotent) cho mọi DB.
    await ensureGroupCompany();
    // v2: quy tắc tự động mặc định (chỉ thêm quy tắc còn thiếu, không ghi đè chỉnh sửa).
    await ensureAutomationRules();
    if (env.SEED_ON_BOOT === 'true') await seedIfEmpty(app.log);
    // DB trắng (chưa seed demo) → luôn có tài khoản quản trị đầu tiên để đăng nhập.
    else if (env.BOOTSTRAP_ON_BOOT === 'true') await bootstrapAdminIfEmpty(app.log);
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
  // v2: xử lý hàng sự kiện → quy tắc tự động mỗi vài giây (bỏ qua khi DB chưa lên).
  const stopAutomation = startAutomationLoop(app.log);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    stopAutomation();
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

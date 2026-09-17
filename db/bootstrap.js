#!/usr/bin/env node
/**
 * `pnpm db:bootstrap` — tạo tài khoản quản trị ĐẦU TIÊN nếu DB chưa có người dùng.
 *
 * Vai trò `admin` = quản lý thuần (nhân sự · công ty/bộ phận · ma trận · cấu hình ·
 * tài khoản tập đoàn · audit), KHÔNG có quyền trên hồ sơ/hoá đơn/phiếu thu chi.
 * Tự tạo pháp nhân Tập đoàn (mã GROUP, is_group=true) làm gốc để gắn assignment.
 *
 * Email/mật khẩu lấy từ BOOTSTRAP_ADMIN_EMAIL / BOOTSTRAP_ADMIN_PASSWORD
 * (mặc định: admin@fingate.local / fingate-demo-2026 — ĐỔI ngay sau khi đăng nhập).
 */
import { withDb } from './_common.js';

await withDb(async (_env, log) => {
  const { bootstrapAdminIfEmpty } = await import('../apps/api/dist/db/bootstrap.js');
  return bootstrapAdminIfEmpty(log);
});

#!/usr/bin/env node
/**
 * `pnpm db:cleanup-orphan-entries` — dọn bút toán MỒ CÔI: `cash_entries` trỏ tới hồ sơ
 * đã bị xoá cứng (không còn trong `documents`), rồi dựng lại `balances_daily` các tài
 * khoản bị ảnh hưởng. Chạy `--dry-run` (hoặc DRY_RUN=1) để chỉ xem, không ghi.
 *
 * Chạy sau `pnpm build` (script import từ apps/api/dist).
 */
import { withDb } from './_common.js';

const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

await withDb(async () => {
  const { purgeOrphanLedgerEntries } = await import('../apps/api/dist/domain/rebuild/balances.js');
  return purgeOrphanLedgerEntries({ dryRun });
});

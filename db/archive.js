#!/usr/bin/env node
/**
 * `pnpm db:archive` — hồ sơ đóng > N tháng → NDJSON sang kho lưu,unset history,set archived_at (§8.7).
 * verify file archive xong mới đụng vào doc gốc. Mặc định dry-run, cần --apply để ghi.
 */
import { withDb } from './_common.js';

const apply = process.argv.includes('--apply');
const monthsIdx = process.argv.indexOf('--months');
const months = monthsIdx > -1 ? Number(process.argv[monthsIdx + 1]) : 24;

await withDb(async (env, log) => {
  void env;
  const { Models } = await import('../apps/api/dist/db/models.js');
  const cutoff = new Date(Date.now() - months * 30 * 86_400_000);
  const candidates = await Models.Document.find({ closed_at: { $lt: cutoff }, archived_at: null }).select({ code: 1, closed_at: 1 }).limit(1000).lean();
  log(`· ${candidates.length} hồ sơ đóng từ trước ${cutoff.toISOString().slice(0, 10)} (tháng = ${months})`);
  for (const c of candidates.slice(0, 20)) log(`  · ${c.code} · đóng ${String(c.closed_at).slice(0, 10)}`);
  if (!candidates.length) return { archived: 0 };
  if (!apply) {
    log('· DRY-RUN — thêm --apply để archive thật');
    return { would_archive: candidates.length };
  }
  const { runTask } = await import('../apps/api/dist/jobs/index.js');
  return runTask('archive');
});

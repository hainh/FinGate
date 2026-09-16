#!/usr/bin/env node
/**
 * `pnpm check:tie` — đối chiếu Σ sao kê vs Σ chứng từ đã trả vs biến động số dư (§8.5).
 * Lệch → tạo alert danger + KHOÁ EXPORT + báo KTT.Script KHÔNG tự sửa số.
 * Exit code 1 khi lệch để CI/block deploy có tín hiệu.
 */
import { withDb } from './_common.js';

try {
  const result = await withDb(async () => {
    const { checkTie } = await import('../apps/api/dist/domain/tie/index.js');
    return checkTie();
  });
  if (result && result.ok === false) {
    console.error(`✗ đối chiếu LỆCH ở ${result.mismatches.length} tài khoản — export đang bị khoá`);
    for (const m of result.mismatches.slice(0, 10)) console.error(`  · ${m.account_id}: sao_kê=${m.statement} chứng_từ=${m.documents} số_dư=${m.balance}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('✗ check:tie lỗi:', err.message);
  process.exitCode = 1;
}

#!/usr/bin/env node
/** `pnpm db:rebuild-balances` — dựng lại balances_daily từ hồ sơ (§8.3, idempotent). */
import { withDb } from './_common.js';

await withDb(async () => {
  const { rebuildBalances } = await import('../apps/api/dist/domain/rebuild/balances.js');
  return rebuildBalances();
});

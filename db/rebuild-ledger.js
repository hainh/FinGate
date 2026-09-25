#!/usr/bin/env node
/** `pnpm db:rebuild-ledger` — backfill `cash_entries` từ hồ sơ đã thực thi (idempotent). */
import { withDb } from './_common.js';

await withDb(async () => {
  const { rebuildLedger } = await import('../apps/api/dist/domain/rebuild/balances.js');
  return rebuildLedger();
});

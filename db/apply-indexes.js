#!/usr/bin/env node
/** `pnpm db:indexes` — áp bộ index ở apps/api/src/db/indexes.ts (§8.4). */
import { withDb } from './_common.js';

await withDb(async () => {
  const { applyIndexes, applyValidators } = await import('../apps/api/dist/db/indexes.js');
  const n = await applyIndexes((m) => console.log(String(m).replace(/^"|"$/g, '')));
  try {
    await applyValidators((m) => console.log(String(m).replace(/^"|"$/g, '')));
  } catch (err) {
    console.warn('! validator: ' + err.message.split('\n')[0]);
  }
  return { indexes: n };
});

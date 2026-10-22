#!/usr/bin/env node
/** `pnpm db:indexes` — áp bộ index ở apps/api/src/db/indexes.ts (§8.4). */
import { withDb } from './_common.js';

await withDb(async () => {
  const { applyIndexes, applyValidators, INDEXES } = await import('../apps/api/dist/db/indexes.js');
  const declared = Object.values(INDEXES).reduce((sum, defs) => sum + defs.length, 0);
  const n = await applyIndexes((m) => console.log(String(m).replace(/^"|"$/g, '')));
  try {
    await applyValidators((m) => console.log(String(m).replace(/^"|"$/g, '')));
  } catch (err) {
    console.warn('! validator: ' + err.message.split('\n')[0]);
  }
  // Thiếu index → thoát lỗi (không in "xong" như thành công); dòng "!" phía trên cho biết index nào.
  if (n < declared) {
    console.warn(`! chỉ tạo được ${n}/${declared} index — xem các dòng "!" ở trên`);
    return { indexes: n, declared, aborted: true };
  }
  return { indexes: n };
});

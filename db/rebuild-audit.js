#!/usr/bin/env node
/**
 * `pnpm db:rebuild-audit` — dựng lại feed `audit_log` từ `documents.history[]` (§7.4, ADR-05).
 * history[] là nguồn sự thật → audit_log có thể rebuild bất cứ lúc nào.
 */
import { withDb } from './_common.js';

const sinceIdx = process.argv.indexOf('--since');
const since = sinceIdx > -1 ? new Date(process.argv[sinceIdx + 1]) : undefined;

await withDb(async (env, log) => {
  const { rebuildAudit } = await import('../apps/api/dist/domain/audit/index.js');
  const { Models } = await import('../apps/api/dist/db/models.js');
  void env;
  if (since) {
    log(`· xoá audit_log sau ${since.toISOString()} rồi dựng lại`);
    await Models.AuditLog.deleteMany({ at: { $gte: since } }).exec();
  } else {
    await Models.AuditLog.deleteMany({}).exec();
  }
  return rebuildAudit({ companyIds: null }, { after: since }, (m) => log(m));
});

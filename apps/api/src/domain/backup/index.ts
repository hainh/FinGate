/**
 * Sao lưu dữ liệu (logical dump) — job `backup` chạy mỗi 30', giữ 30 ngày.
 *
 * Xuất toàn bộ collection ra một file EJSON (canonical — giữ nguyên ObjectId/Date/Int64)
 * nén gzip rồi ghi qua StorageAdapter (`backups/fingate-YYYYMMDD-HHmmss.json.gz`).
 * Dùng chung hạ tầng chứng từ nên chạy được cả Profile O (fs) lẫn cloud (R2/S3).
 */

import { gzipSync } from 'node:zlib';
import { BSON } from 'mongodb';
import { Models } from '../../db/models.ts';
import { storage } from '../../storage/index.ts';
import { getEnv } from '../../env.ts';

const PREFIX = 'backups/';

/** Giữ bản sao lưu trong 30 ngày (yêu cầu vận hành). */
export const BACKUP_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** `fingate-YYYYMMDD-HHmmss[-mmm].json.gz` — chặn path traversal ở route tải về. */
export const BACKUP_FILE_RE = /^fingate-\d{8}-\d{6}(-\d{3})?\.json\.gz$/;

export interface BackupFile {
  file: string;
  key: string;
  size: number;
  created_at: string;
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds())}`
  );
}

/** Dump MỌI collection (nguyên trạng BSON qua EJSON) → gzip → lưu storage. */
export async function createBackup(): Promise<BackupFile> {
  const created = new Date();
  const data: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  let totalDocs = 0;
  for (const model of Object.values(Models)) {
    const name = model.collection.collectionName;
    const docs = await model.collection.find({}).toArray();
    data[name] = docs;
    counts[name] = docs.length;
    totalDocs += docs.length;
  }
  const payload = {
    meta: {
      created_at: created.toISOString(),
      app_version: getEnv().VERSION,
      profile: getEnv().PROFILE,
      total_docs: totalDocs,
      collections: counts,
    },
    data,
  };
  const ejson = BSON.EJSON.stringify(payload as never, { relaxed: false });
  const gz = gzipSync(Buffer.from(ejson, 'utf8'), { level: 9 });
  const file = `fingate-${stamp(created)}.json.gz`;
  const key = `${PREFIX}${file}`;
  const adapter = storage();
  if (!adapter.putBytes) throw new Error('Storage driver không hỗ trợ ghi sao lưu');
  await adapter.putBytes(key, gz, 'application/gzip');
  return { file, key, size: gz.length, created_at: created.toISOString() };
}

/** Danh sách bản sao lưu còn giữ (mới nhất trước). */
export async function listBackups(): Promise<BackupFile[]> {
  const items = await storage().list(PREFIX);
  return items
    .filter((i) => BACKUP_FILE_RE.test(i.key.slice(PREFIX.length)))
    .map((i) => ({
      file: i.key.slice(PREFIX.length),
      key: i.key,
      size: i.size,
      created_at: i.lastModified.toISOString(),
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Xoá bản cũ hơn `retainMs` (mặc định 30 ngày). */
export async function pruneBackups(retainMs = BACKUP_RETAIN_MS): Promise<{ removed: number }> {
  const cutoff = Date.now() - retainMs;
  const adapter = storage();
  const items = await adapter.list(PREFIX);
  let removed = 0;
  for (const i of items) {
    if (!BACKUP_FILE_RE.test(i.key.slice(PREFIX.length))) continue;
    if (i.lastModified.getTime() < cutoff) {
      await adapter.remove(i.key);
      removed++;
    }
  }
  return { removed };
}

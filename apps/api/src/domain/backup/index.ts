/**
 * Sao lưu dữ liệu (ADM-14) — `mongodump` chạy mỗi 30', giữ 30 ngày.
 *
 * Ghi THẲNG ra file storage NGOÀI app (`BACKUP_DIR`, mặc định `~/FinGateBackups`) để người
 * vận hành truy cập trực tiếp — KHÔNG đi qua StorageAdapter/chứng từ, KHÔNG lên cloud.
 * Mỗi bản là một archive gzip của `mongodump` (`fingate-YYYYMMDD-HHmmss.archive.gz`).
 *
 * Yêu cầu: `mongodump` (MongoDB Database Tools) có trên PATH của máy chủ chạy API.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ApiError } from '@fingate/shared';
import { getEnv } from '../../env.ts';

const execFileAsync = promisify(execFile);

/** Giữ bản sao lưu trong 30 ngày (yêu cầu vận hành). */
export const BACKUP_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;

/** `fingate-YYYYMMDD-HHmmss.archive.gz` — chặn path traversal ở route tải về. */
export const BACKUP_FILE_RE = /^fingate-\d{8}-\d{6}\.archive\.gz$/;

export interface BackupFile {
  file: string;
  size: number;
  created_at: string;
}

/** Thư mục chứa bản sao lưu (ngoài app); `BACKUP_DIR` rỗng → `~/FinGateBackups`. */
export function backupDir(): string {
  const dir = getEnv().BACKUP_DIR.trim();
  return resolve(dir || join(homedir(), 'FinGateBackups'));
}

/** Đường dẫn tuyệt đối của một bản (tên đã qua kiểm tra `BACKUP_FILE_RE` ở route). */
export function backupPath(file: string): string {
  return join(backupDir(), file);
}

function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** `mongodump --gzip --archive=<BACKUP_DIR>/fingate-<stamp>.archive.gz`. */
export async function createBackup(): Promise<BackupFile> {
  const created = new Date();
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const file = `fingate-${stamp(created)}.archive.gz`;
  const path = join(dir, file);

  try {
    await execFileAsync(
      'mongodump',
      [`--uri=${getEnv().MONGODB_URI}`, '--gzip', `--archive=${path}`],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') {
      throw new ApiError({
        code: 'FG-SYS-001',
        detail: 'Không tìm thấy `mongodump` trên máy chủ — cài MongoDB Database Tools để bật sao lưu.',
      });
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError({ code: 'FG-SYS-001', detail: `Sao lưu thất bại: ${msg}` });
  }

  const info = await stat(path).catch(() => null);
  return { file, size: info?.size ?? 0, created_at: created.toISOString() };
}

/** Danh sách bản sao lưu còn giữ (mới nhất trước). */
export async function listBackups(): Promise<BackupFile[]> {
  const dir = backupDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: BackupFile[] = [];
  for (const name of names) {
    if (!BACKUP_FILE_RE.test(name)) continue;
    const info = await stat(join(dir, name)).catch(() => null);
    if (!info?.isFile()) continue;
    out.push({ file: name, size: info.size, created_at: info.mtime.toISOString() });
  }
  return out.sort((a, b) => b.file.localeCompare(a.file));
}

/** Xoá bản cũ hơn `retainMs` (mặc định 30 ngày). */
export async function pruneBackups(retainMs = BACKUP_RETAIN_MS): Promise<{ removed: number }> {
  const cutoff = Date.now() - retainMs;
  const dir = backupDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!BACKUP_FILE_RE.test(name)) continue;
    const full = join(dir, name);
    const info = await stat(full).catch(() => null);
    if (!info || info.mtimeMs >= cutoff) continue;
    await rm(full, { force: true });
    removed++;
  }
  return { removed };
}

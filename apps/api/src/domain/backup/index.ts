/**
 * Sao lưu dữ liệu (ADM-14) — `mongodump` chạy mỗi 30', giữ 30 ngày.
 *
 * Ghi THẲNG ra file storage NGOÀI app (`BACKUP_DIR`, mặc định `~/FinGateBackups`) để người
 * vận hành truy cập trực tiếp — KHÔNG đi qua StorageAdapter/chứng từ, KHÔNG lên cloud.
 * Mỗi bản là một archive gzip của `mongodump` (`fingate-YYYYMMDD-HHmmss.archive.gz`).
 *
 * Ưu tiên `mongodump` trên PATH của máy chủ chạy API. Nếu dev Windows chưa cài Database Tools,
 * tự chạy `mongodump` trong container MongoDB đang ánh xạ đúng cổng của `MONGODB_URI`.
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

interface SpawnError extends Error {
  code?: string | number;
  killed?: boolean;
  stdout?: string;
  stderr?: string;
}

function isCommandNotFound(err: unknown): boolean {
  const e = err as SpawnError;
  return e.code === 'ENOENT' || /not recognized|no such file|executable file not found/i.test(e.stderr ?? '');
}

function commandDetail(err: unknown): string {
  const e = err as SpawnError;
  const raw = e.stderr || e.stdout || e.message || String(err);
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? 'Lỗi không xác định';
}

async function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function internalMongoUri(uri: string, port: string): string {
  try {
    const parsed = new URL(uri);
    parsed.hostname = '127.0.0.1';
    parsed.port = port;
    parsed.searchParams.delete('replicaSet');
    parsed.searchParams.set('directConnection', 'true');
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return `mongodb://127.0.0.1:${port}/fingate?directConnection=true`;
  }
}

interface ContainerRow {
  name: string;
  ports: string;
}

interface DockerTarget {
  container: string;
  uri: string;
}

function publishedPort(row: ContainerRow, hostPort: string): string | null {
  const match = row.ports.match(new RegExp(`:${escapeRegExp(hostPort)}->(\\d+)/tcp`));
  return match?.[1] ?? null;
}

async function dockerTargets(): Promise<DockerTarget[]> {
  const env = getEnv();
  let rows: ContainerRow[];
  try {
    const { stdout } = await run('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}']);
    rows = stdout
      .split(/\r?\n/)
      .flatMap((line) => {
        const [name, ports = ''] = line.split('\t');
        return name ? [{ name, ports }] : [];
      });
  } catch (err) {
    if (isCommandNotFound(err)) return [];
    throw new ApiError({
      code: 'FG-SYS-001',
      detail: `Không kiểm tra được container MongoDB qua Docker: ${commandDetail(err)}`,
    });
  }

  let mongoUri: URL;
  try {
    mongoUri = new URL(env.MONGODB_URI);
  } catch {
    return [];
  }
  const host = mongoUri.hostname.toLowerCase();
  const hostPort = mongoUri.port || '27017';
  const dbPort = hostPort === '27117' ? '27017' : hostPort;
  const preferred = [
    env.BACKUP_MONGO_CONTAINER.trim(),
    'fingate-mongo',
    'deploy-mongo-1',
  ].filter(Boolean);

  const candidates: DockerTarget[] = [];
  const seen = new Set<string>();
  const addCandidate = (row: ContainerRow): void => {
    if (seen.has(row.name)) return;
    const internalPort = publishedPort(row, hostPort) ?? (host === 'localhost' || host === '127.0.0.1' ? dbPort : '27017');
    candidates.push({ container: row.name, uri: internalMongoUri(env.MONGODB_URI, internalPort) });
    seen.add(row.name);
  };

  for (const name of preferred) {
    const row = rows.find((r) => r.name === name);
    if (row) addCandidate(row);
  }
  if (host === 'localhost' || host === '127.0.0.1') {
    for (const row of rows) {
      if (publishedPort(row, hostPort)) addCandidate(row);
    }
  }

  const available: DockerTarget[] = [];
  for (const candidate of candidates) {
    try {
      await run('docker', ['exec', candidate.container, 'sh', '-lc', 'command -v mongodump']);
      available.push(candidate);
    } catch {
      /* bỏ qua container không có mongodump hoặc không exec được */
    }
  }
  return available;
}

async function createBackupViaDocker(file: string, path: string, createdAt: Date): Promise<BackupFile> {
  const targets = await dockerTargets();
  if (!targets.length) {
    throw new ApiError({
      code: 'FG-SYS-001',
      detail:
        'Không tìm thấy `mongodump` trên máy chủ. Hãy cài MongoDB Database Tools hoặc chạy API trong container có `mongodump`.',
    });
  }

  const tmpPath = `/tmp/${file}`;
  let lastDetail = 'Không chạy được `mongodump` trong container MongoDB.';
  for (const target of targets) {
    try {
      await run('docker', [
        'exec',
        target.container,
        'mongodump',
        `--uri=${target.uri}`,
        '--gzip',
        `--archive=${tmpPath}`,
      ]);
      await run('docker', ['cp', `${target.container}:${tmpPath}`, path]);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || info.size === 0) throw new Error('File sao lưu rỗng sau khi chạy mongodump trong container.');
      return { file, size: info.size, created_at: createdAt.toISOString() };
    } catch (err) {
      lastDetail = commandDetail(err);
      await rm(path, { force: true }).catch(() => undefined);
    } finally {
      await run('docker', ['exec', target.container, 'rm', '-f', tmpPath]).catch(() => undefined);
    }
  }

  throw new ApiError({ code: 'FG-SYS-001', detail: `Sao lưu qua Docker thất bại: ${lastDetail}` });
}

/** `mongodump --gzip --archive=<BACKUP_DIR>/fingate-<stamp>.archive.gz`. */
export async function createBackup(): Promise<BackupFile> {
  const created = new Date();
  const dir = backupDir();
  await mkdir(dir, { recursive: true });
  const file = `fingate-${stamp(created)}.archive.gz`;
  const path = join(dir, file);

  try {
    await run('mongodump', [`--uri=${getEnv().MONGODB_URI}`, '--gzip', `--archive=${path}`]);
  } catch (err) {
    if (isCommandNotFound(err)) {
      return createBackupViaDocker(file, path, created);
    }
    await rm(path, { force: true }).catch(() => undefined);
    throw new ApiError({ code: 'FG-SYS-001', detail: `Sao lưu thất bại: ${commandDetail(err)}` });
  }

  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    await rm(path, { force: true }).catch(() => undefined);
    throw new ApiError({ code: 'FG-SYS-001', detail: 'Sao lưu thất bại: mongodump không tạo ra file archive.' });
  }
  return { file, size: info.size, created_at: created.toISOString() };
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

/** Một lượt sao lưu định kỳ: tạo bản mới rồi dọn bản quá 30 ngày. */
export async function runScheduledBackup(): Promise<{ created: string; bytes: number; pruned: number }> {
  const created = await createBackup();
  const pruned = await pruneBackups();
  return { created: created.file, bytes: created.size, pruned: pruned.removed };
}

/** Chu kỳ sao lưu mỗi 30' (ADM-14) chạy trong tiến trình API. Trả về hàm dừng. */
export function startBackupLoop(
  log: { info: (obj: unknown, msg?: string) => void; error: (obj: unknown, msg?: string) => void },
  opts: { ready: () => boolean; intervalMs?: number; task?: () => Promise<unknown> },
): () => void {
  const { ready, intervalMs = 30 * 60_000, task = runScheduledBackup } = opts;
  let running = false;
  const timer = setInterval(() => {
    // Lượt trước chưa xong (mongodump chậm) hoặc DB chưa lên → bỏ qua, không chồng lượt.
    if (running || !ready()) return;
    running = true;
    task()
      .then((result) => log.info({ result }, 'sao lưu định kỳ xong'))
      .catch((err: unknown) => log.error({ err }, 'sao lưu định kỳ lỗi'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
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

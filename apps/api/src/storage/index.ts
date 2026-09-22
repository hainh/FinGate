/**
 * StorageAdapter (ADR-05, K-8/K-9) — chứng từ KHÔNG đi qua RAM/đĩa của app.
 *
 *   s3  → Cloudflare R2 / B2 / S3 qua presigned PUT/GET (Profile C — filesystem ephemeral)
 *   fs  → thư mục đĩa (Profile O / dev)
 *
 * Key: `uploads/{companyCode}/{docCode}/{attachmentId}_v{n}_{sha8}.{ext}`
 * → "chỉ thêm, không xóa" (DS §7.9) được bảo đảm bằng CẤU TRÚC KEY, không phải API.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { getEnv } from '../env.ts';

export interface PreparedUpload {
  upload_url: string;
  key: string;
  method: 'PUT';
  required_headers: Record<string, string>;
  expires_in: number;
}

export interface StorageAdapter {
  readonly driver: 's3' | 'fs';
  /** presigned PUT (s3) hoặc URL POST-through-app (fs/dev). */
  preparePut(key: string, mime: string, size: number): Promise<PreparedUpload>;
  /** HeadObject: tồn tại? đúng size? đúng sha256? (arch §6 bước confirm) */
  head(key: string): Promise<{ exists: boolean; size?: number; sha256?: string }>;
  /** URL tải về ngắn hạn (60s) — cấp SAU khi check quyền từng lần. */
  presignGet(key: string, expiresInSec?: number): Promise<string>;
  /** chỉ dùng cho fs/dev: nhận stream rồi ghi đĩa. */
  writeStream?(key: string): NodeJS.WritableStream;
  /** ghi file từ buffer/stream — đường vòng cho dev khi không có presigned. */
  putBytes?(key: string, bytes: Buffer, mime: string): Promise<void>;
  /** chỉ dùng cho fs/dev: đọc bytes để phục vụ trực tiếp (không có presigned GET). */
  readBytes?(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  usedBytes(prefix: string): Promise<number>;
}

export function attachmentKey(input: {
  companyCode: string;
  docCode: string;
  attachmentId: string;
  version: number;
  sha256: string;
  filename: string;
}): string {
  const ext = (extname(input.filename).replace('.', '').toLowerCase().slice(0, 8) || 'bin').replace(/[^a-z0-9]/g, '');
  return `uploads/${input.companyCode}/${input.docCode}/${input.attachmentId}_v${input.version}_${input.sha256.slice(0, 8)}.${ext}`;
}

/** Magic bytes — chặn file đổi đuôi (PDF/DOCX/XLSX/JPG/PNG — blueprint §V). */
const MAGIC: { ext: string; mime: string; test: (b: Uint8Array) => boolean }[] = [
  { ext: 'pdf', mime: 'application/pdf', test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { ext: 'png', mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: 'jpg', mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // zip container: docx/xlsx/pptx
  { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', test: (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 },
  // OLE2 cũ: doc/xls
  { ext: 'doc', mime: 'application/msword', test: (b) => b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 },
];

export function detectMagic(head: Uint8Array): { ok: boolean; kind?: string; mime?: string } {
  for (const m of MAGIC) if (m.test(head)) return { ok: true, kind: m.ext, mime: m.mime };
  return { ok: false };
}

export function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

let adapter: StorageAdapter | null = null;

export function storage(): StorageAdapter {
  adapter ??= getEnv().STORAGE_DRIVER === 's3' ? createS3Adapter() : createFsAdapter();
  return adapter;
}

/** chỉ cho test */
export function setStorageAdapter(a: StorageAdapter | null): void {
  adapter = a;
}

/* ------------------------------------------------------------------ *
 * fs — dev + Profile O
 * ------------------------------------------------------------------ */

function createFsAdapter(): StorageAdapter {
  const root = resolve(getEnv().UPLOAD_DIR);
  const pathOf = (key: string) => join(root, key.replace(/^[/\\]+/, ''));

  return {
    driver: 'fs',
    async preparePut(key, mime) {
      // dev: browser PUT vào chính API (route /api/v1/storage/put) — URL tương đối để
      // đi đúng origin đang mở, không phụ thuộc PUBLIC_URL (hay lệch khi reverse proxy).
      await mkdir(dirname(pathOf(key)), { recursive: true });
      const url = `/api/v1/storage/put?key=${encodeURIComponent(key)}`;
      return { upload_url: url, key, method: 'PUT', required_headers: { 'content-type': mime }, expires_in: 300 };
    },
    async head(key) {
      try {
        const st = await stat(pathOf(key));
        return { exists: st.size > 0, size: st.size };
      } catch {
        return { exists: false };
      }
    },
    async presignGet(key) {
      return `/api/v1/storage/get?key=${encodeURIComponent(key)}`;
    },
    writeStream(key) {
      return createWriteStream(pathOf(key));
    },
    async putBytes(key, bytes) {
      await mkdir(dirname(pathOf(key)), { recursive: true });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(pathOf(key), bytes);
    },
    async readBytes(key) {
      const { readFile } = await import('node:fs/promises');
      return readFile(pathOf(key));
    },
    async remove(key) {
      await unlink(pathOf(key)).catch(() => undefined);
    },
    async usedBytes(prefix) {
      const { readdir, stat: st } = await import('node:fs/promises');
      let total = 0;
      const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir).catch(() => [] as string[]);
        for (const e of entries) {
          const full = join(dir, e);
          const info = await st(full).catch(() => null);
          if (!info) continue;
          if (info.isDirectory()) await walk(full);
          else total += info.size;
        }
      };
      await walk(resolve(root, prefix.replace(/^[/\\]+/, '') || '.'));
      return total;
    },
  };
}

/* ------------------------------------------------------------------ *
 * s3 — R2/B2/S3 (chỉ import AWS SDK khi thật sự dùng — arch §3.3)
 * ------------------------------------------------------------------ */

function createS3Adapter(): StorageAdapter {
  const env = getEnv();
  // dynamic import: giữ RAM/build nhẹ cho Profile O và test, và không fail khi thiếu key
  const clientPromise = (async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    return new S3Client({
      region: 'auto',
      endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    });
  })();

  return {
    driver: 's3',
    async preparePut(key, mime) {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const client = await clientPromise;
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, ContentType: mime }),
        { expiresIn: 300 },
      );
      return { upload_url: url, key, method: 'PUT', required_headers: { 'content-type': mime }, expires_in: 300 };
    },
    async head(key) {
      const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await clientPromise;
      try {
        const r = await client.send(
          new HeadObjectCommand({ Bucket: env.R2_BUCKET, Key: key }),
        );
        return { exists: true, size: r.ContentLength ?? 0 };
      } catch {
        return { exists: false };
      }
    },
    async presignGet(key, expiresInSec = 60) {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const client = await clientPromise;
      return getSignedUrl(client, new GetObjectCommand({ Bucket: env.R2_BUCKET, Key: key }), { expiresIn: expiresInSec });
    },
    async putBytes(key, bytes, mime) {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await clientPromise;
      await client.send(new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: key, Body: bytes, ContentType: mime }));
    },
    async remove(key) {
      const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const client = await clientPromise;
      await client.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: key })).catch(() => undefined);
    },
    async usedBytes(prefix) {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const client = await clientPromise;
      let token: string | undefined;
      let total = 0;
      do {
        const r = await client.send(
          new ListObjectsV2Command({ Bucket: env.R2_BUCKET, Prefix: prefix, ContinuationToken: token }),
        );
        for (const o of r.Contents ?? []) total += o.Size ?? 0;
        token = r.NextContinuationToken;
      } while (token);
      return total;
    },
  };
}


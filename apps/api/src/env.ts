/**
 * Env — zod validated, fail-fast (architecture §16: một file duy nhất, mọi key khai ở .env.example).
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('0.0.0.0'),
  TZ: z.string().default('UTC'),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  WEB_DIST: z.string().default(''),

  MONGODB_URI: z.string().min(5, 'MONGODB_URI là bắt buộc').default('mongodb://localhost:27017/fingate?replicaSet=rs0'),

  SESSION_SECRET: z
    .string()
    .min(32, 'SESSION_SECRET phải >= 32 byte')
    .default(''),
  /** 32 byte hex = 64 ký tự — khoá AES-256-GCM cho field nhạy cảm (totp secret). */
  FIELD_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'FIELD_KEY phải là 64 ký tự hex (32 byte)')
    .default(''),
  TASK_TOKEN: z.string().min(8, 'TASK_TOKEN phải >= 8 ký tự').default(''),

  /** cloud = Render/PaaS (filesystem mất khi restart) · onprem = VPS/VM có đĩa bền */
  PROFILE: z.enum(['cloud', 'onprem']).default('cloud'),
  STORAGE_DRIVER: z.enum(['s3', 'fs']).default('fs'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  R2_ACCOUNT_ID: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET: z.string().default('fingate-docs'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().default(25 * 1024 * 1024),
  /** hạn mức dung lượng chứng từ per company (mặc định 5 GB — trần R2 free 10 GB, arch §19.2-7) */
  COMPANY_STORAGE_BYTES: z.coerce.number().int().default(5 * 1024 * 1024 * 1024),

  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('fingate@company.com'),
  /** bỏ qua mail ở dev/test: log ra console thay vì gửi */
  MAIL_MODE: z.enum(['smtp', 'log', 'off']).default('log'),

  /** phiên thường (không chọn "ghi nhớ"): idle 15', absolute 8h (arch §7.2) */
  SESSION_IDLE_MINUTES: z.coerce.number().int().default(15),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().default(8),
  /**
   * Phiên "ghi nhớ đăng nhập" (mặc định BẬT — yêu cầu: giữ đăng nhập lâu nhất có thể).
   * Đây là hạn CUỘN: mỗi lần có hoạt động (tối đa 1 write/ngày/phiên) hạn được nạp lại,
   * nên người dùng hoạt động định kỳ không bao giờ phải đăng nhập lại.
   * 400 = trần Max-Age mà trình duyệt cho phép (Chrome/Firefox/Edge cắt xuống 400),
   * đặt lớn hơn cũng vô nghĩa. Giảm xuống nếu muốn phiên chết hẳn sau N ngày bỏ không.
   */
  SESSION_REMEMBER_DAYS: z.coerce.number().int().min(1).max(400).default(400),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().default(8),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().default(15),

  /** export trực tiếp quá số dòng này sẽ chạy thành job (arch §14) */
  EXPORT_ROW_LIMIT: z.coerce.number().int().default(50_000),
  /** cache in-memory TTL cho badge/dashboard (arch §8.3) */
  CACHE_TTL_MS: z.coerce.number().int().default(60_000),

  SEED_ON_BOOT: z.enum(['true', 'false']).default('false'),
  LOG_LEVEL: z.string().default('info'),
  VERSION: z.string().default('0.1.0'),
});

export type Env = z.infer<typeof envSchema> & { isProd: boolean; isTest: boolean; isDev: boolean };

let cached: Env | undefined;

export function loadEnv(overrides: Record<string, string | undefined> = {}): Env {
  const merged = { ...process.env, ...overrides };
  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    // fail-fast, không để app chạy với secret rỗng
    throw new Error(`Env không hợp lệ:\n${lines.join('\n')}\nXem .env.example`);
  }
  const env = parsed.data as Env;
  env.isProd = env.NODE_ENV === 'production';
  env.isTest = env.NODE_ENV === 'test';
  env.isDev = env.NODE_ENV === 'development';

  if (!env.SESSION_SECRET || !env.FIELD_KEY || !env.TASK_TOKEN) {
    if (env.isProd) {
      throw new Error(
        'Thiếu secret bắt buộc ở production: SESSION_SECRET (>=32B), FIELD_KEY (64 hex), TASK_TOKEN. ' +
          'Render tự sinh SESSION_SECRET; hai key còn lại phải điền trong dashboard (arch §11 Secret).',
      );
    }
    // dev/test: tự sinh để `pnpm dev` chạy được ngay, nhưng cảnh báo rõ
    if (!env.SESSION_SECRET) env.SESSION_SECRET = randomBytes(32).toString('hex');
    if (!env.FIELD_KEY) env.FIELD_KEY = randomBytes(32).toString('hex');
    if (!env.TASK_TOKEN) env.TASK_TOKEN = randomBytes(16).toString('hex');
    console.warn(
      '[fingate] dev mode: SESSION_SECRET/FIELD_KEY/TASK_TOKEN tự sinh — TOTP và session sẽ mất sau khi restart.',
    );
  }
  cached = env;
  return env;
}

export function getEnv(): Env {
  return cached ?? loadEnv();
}

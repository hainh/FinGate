/**
 * Wiring của service duy nhất: Fastify vừa serve API vừa serve SPA (K-1, ADR-01).
 * Toàn bộ cấu hình ở một chỗ — không DI, không tầng trung gian (architecture §6).
 */

import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, type Env } from './env.ts';
import { installHttpLayer } from './lib/http.ts';
import { noValidator } from './lib/serialize.ts';
import { apiRoutes } from './routes/index.ts';
import { systemRoutes } from './routes/system.ts';

/** Không bao giờ ghi vào log: mật khẩu, OTP, token, số TK NH, MST (§7.4). */
const REDACT = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-task-token"]',
  'req.body.password',
  'req.body.current_password',
  'req.body.new_password',
  'req.body.verify.value',
  'req.body.otp',
  'req.body.code',
  'req.body.totp_code',
  'req.body.token',
  '*.account_number',
  '*.tax_code',
  '*.secret',
  '*.secret_enc',
];

function csp(env: Env): Record<string, unknown> {
  return {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      // antd dùng <style> runtime (cssVar) → cần unsafe-inline cho style
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': env.isDev ? ["'self'", 'ws:', 'http:'] : ["'self'"],
      'frame-ancestors': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
    },
  };
}

export async function build(overrides: Record<string, string | undefined> = {}): Promise<FastifyInstance> {
  const env = loadEnv(overrides);

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Render đọc stdout → có log UI; pino-pretty chỉ khi dev (K-10)
      transport: env.isDev
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
      redact: { paths: REDACT, censor: '[redacted]' },
    },
    bodyLimit: 8 * 1024 * 1024, // JSON; chứng từ đi presigned thẳng lên R2 (K-8)
    trustProxy: true,
    genReqId: () => randomBytes(6).toString('hex'),
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });
  await app.register(helmet, { contentSecurityPolicy: csp(env), global: true });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // store in-memory: 1 instance (K-6)
    errorResponseBuilder: (_req, ctx) => ({
      type: 'about:blank',
      title: 'Quá nhiều yêu cầu',
      status: 429,
      code: 'FG-AUTH-007',
      detail: `Thử lại sau ${Math.max(1, Math.ceil(((ctx as { ttl?: number }).ttl ?? 60_000) / 1000))} giây`,
    }),
  });
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'FinGate API',
        version: env.VERSION,
        description: 'Điều hành dòng tiền & phê duyệt tài chính — API-first (blueprint §XXV).',
      },
      servers: [{ url: env.PUBLIC_URL }],
      tags: [
        { name: 'auth', description: 'Phiên & 2FA' },
        { name: 'documents', description: 'Hồ sơ thu/chi/đảo hạn/chuyển nội bộ' },
        { name: 'bank', description: 'Tài khoản, số dư, sao kê, chuyển nội bộ' },
        { name: 'loans', description: 'Vay ngân hàng & đáo hạn' },
        { name: 'debt', description: 'Công nợ phải thu / phải trả' },
        { name: 'admin', description: 'Quản trị: nhân sự, matrix, audit' },
      ],
    },
    // JSON Schema do Zod sinh ra ở routes/schemas.ts (một nguồn — ADR-08)
    transform: (schema) => schema,
  });
  // @fastify/multipart CHỈ cho import Excel/CSV nhỏ; presigned upload không đi qua app
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 5 } });

  // JSON Schema chỉ để tài liệu hoá — validation thật do zod trong handler (§6)
  noValidator(app);
  installHttpLayer(app);

  // API dưới /api/v1 (version trong path — §10)
  await app.register(apiRoutes, { prefix: '/api/v1' });
  // /healthz + /api/v1/tasks/:name đăng ký ở gốc (§12.3)
  systemRoutes(app);

  const dist = webDist(env);
  if (dist) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', index: false, wildcard: false });
    app.setNotFoundHandler((req, reply) => spaFallback(req.url, dist, reply));
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return api404(reply);
      return reply
        .type('text/html')
        .send('<h1>FinGate API</h1><p>Chưa có bản build web. Chạy <code>pnpm -F @fingate/web build</code> hoặc <code>pnpm dev</code>.</p>');
    });
  }

  return app;
}

function api404(reply: import('fastify').FastifyReply) {
  return reply.code(404).type('application/problem+json').send({
    type: 'about:blank',
    title: 'Không tìm thấy tài nguyên',
    status: 404,
    code: 'FG-WF-001',
  });
}

/** SPA fallback: mọi route không phải API trả index.html để deep-link hoạt động. */
function spaFallback(url: string, dist: string, reply: import('fastify').FastifyReply) {
  if (url.startsWith('/api/')) return api404(reply);
  try {
    return reply.type('text/html').send(readFileSync(resolve(dist, 'index.html'), 'utf8'));
  } catch {
    return reply.code(500).type('text/plain').send('index.html không tồn tại');
  }
}

/** WEB_DIST tuyệt đối hoặc tương đối so với cwd; mặc định tìm apps/web/dist. */
export function webDist(env: Env): string | null {
  const candidates = [
    env.WEB_DIST ? resolve(process.cwd(), env.WEB_DIST) : null,
    resolve(process.cwd(), 'apps/web/dist'),
    resolve(process.cwd(), '../web/dist'),
    resolve(process.cwd(), '../../apps/web/dist'),
  ].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(resolve(c, 'index.html'))) return c;
  return null;
}

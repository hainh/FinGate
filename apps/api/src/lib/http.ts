/**
 * Tầng HTTP (architecture §6, §7.2) — một request đi qua:
 *   cookie → session doc (cache in-memory 60s) → tenant scope → perms → zod → service
 *
 * Ghi chú hiện thực: context được gắn lên `request` (`req.fg`) và truyền tường minh
 * xuống service thay vì AsyncLocalStorage — Fastify không cho phép một preHandler
 * bọc phần còn lại của pipeline trong `als.run()`, và truyền tường minh test dễ hơn.
 * `scopedFind/scopedCount` (lib/mongo.ts) nhận `Scope` làm tham số, vẫn bảo đảm
 * mọi query có `company_id` (§7.5).
 */

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify';
import type { ZodType } from 'zod';
import { ApiError, parseProblem, type Permission, type ProblemJson } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { cacheGet, cacheInvalidate, cacheSet } from './cache.ts';
import { hashToken, randomToken } from './password.ts';
import { actorInfoFrom, resolveIdentity, scopeFor, type ResolvedIdentity } from '../domain/entitlement/index.ts';
import type { ActorInfo, ScopeLike } from '../domain/types.ts';
import { getEnv } from '../env.ts';

export const COOKIE = 'fgs';

export interface RequestContext {
  actor: ActorInfo | null;
  identity: ResolvedIdentity | null;
  scope: ScopeLike;
  sessionId: string | null;
  ip: string | null;
  ua: string | null;
  traceId: string;
}

const EMPTY: RequestContext = {
  actor: null,
  identity: null,
  scope: { companyIds: [] },
  sessionId: null,
  ip: null,
  ua: null,
  traceId: '',
};

type CtxRequest = FastifyRequest & { fg?: RequestContext };

export function requestCtx(req: FastifyRequest): RequestContext {
  return (req as CtxRequest).fg ?? EMPTY;
}

export function requireActor(req: FastifyRequest): ActorInfo {
  const { actor } = requestCtx(req);
  if (!actor) throw new ApiError({ code: 'FG-AUTH-001' });
  return actor;
}

export function requireScope(req: FastifyRequest): ScopeLike {
  const { scope } = requestCtx(req);
  if (scope.companyIds !== null && scope.companyIds.length === 0) {
    throw new ApiError({ code: 'FG-RBAC-002', detail: 'Bạn chưa được gán vào công ty nào' });
  }
  return scope;
}

export function requirePerm(req: FastifyRequest, ...perms: Permission[]): ActorInfo {
  const actor = requireActor(req);
  for (const p of perms) {
    if (!actor.permissions.includes(p)) throw new ApiError({ code: 'FG-RBAC-001', detail: `Cần quyền ${p}` });
  }
  return actor;
}

/** Cần MỘT TRONG các quyền (ví dụ xem số TK: bank:read HOẶC doc:read). */
export function requirePermAny(req: FastifyRequest, ...perms: Permission[]): ActorInfo {
  const actor = requireActor(req);
  if (!perms.some((p) => actor.permissions.includes(p))) {
    throw new ApiError({ code: 'FG-RBAC-001', detail: `Cần một trong các quyền: ${perms.join(', ')}` });
  }
  return actor;
}

export function clientIp(req: FastifyRequest): string | null {
  // trustProxy = true: Render/Cloudflare đứng trước (arch §11 HTTPS)
  return req.ip ?? req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ?? null;
}

/* ------------------------------------------------------------------ *
 * Session — cookie `fgs` = random id, doc nằm trong Mongo (K-6, không JWT)
 * ------------------------------------------------------------------ */

export interface SessionData {
  session_id: string;
  user_id: string;
  company_scope: string[];
  active_company_id: string | null;
  state: 'pending_2fa' | 'active';
  /** true = "ghi nhớ đăng nhập": phiên cuộn (rolling), không trôi theo idle */
  persistent: boolean;
  /** epoch ms — mốc hết hạn của phiên (với persistent: mốc CUỘN, được đẩy lại mỗi lần gia hạn) */
  absolute_expires_at: number;
  /**
   * true khi lần đọc này vừa gia hạn phiên persistent → hook phát lại `Set-Cookie`
   * để trình duyệt đếm lại Max-Age (không có bước này thì cookie chết đúng 400 ngày
   * sau lần đăng nhập, bất kể DB còn hạn).
   */
  renewed: boolean;
}

/**
 * Hạn của một phiên loại "ghi nhớ", tính bằng ms. 400 ngày là trần Max-Age mà
 * trình duyệt chấp nhận — đặt lớn hơn cũng bị cắt, nên muốn "lâu nhất có thể"
 * phải dùng chiến lược CUỘN (re-arm mỗi lần có hoạt động) chứ không phải một trần dài.
 */
function rememberTtlMs(): number {
  return getEnv().SESSION_REMEMBER_DAYS * 86_400_000;
}

/** Trần tuyệt đối của một phiên thường (không remember). */
function sessionTtlMs(persistent: boolean): number {
  return persistent ? rememberTtlMs() : getEnv().SESSION_ABSOLUTE_HOURS * 3_600_000;
}

/**
 * Ngưỡng gia hạn cuộn: chỉ viết DB khi không còn dùng quá `RENEW_SLACK_MS`.
 * 1 ngày → người dùng hoạt động hằng ngày gần như KHÔNG BAO GIỜ hết phiên,
 * đồng thời không nhân số write lên mỗi 30s (frontend đang poll 30s).
 */
const RENEW_SLACK_MS = 86_400_000;

export async function createSession(input: {
  user_id: string;
  company_scope: string[];
  active_company_id: string | null;
  state?: 'pending_2fa' | 'active';
  ip: string | null;
  ua: string | null;
  /** "ghi nhớ đăng nhập" — mặc định false; route auth truyền theo loginBody.remember */
  persistent?: boolean;
  /** ghi đè TTL của chính session doc (vd. pending_2fa 5'); không đổi mốc cuộn */
  ttlMs?: number;
}): Promise<{ raw: string; session_id: string }> {
  const { raw, hash } = randomToken(32);
  const now = Date.now();
  const state = input.state ?? 'active';
  const persistent = input.persistent ?? false;
  const absoluteMs = sessionTtlMs(persistent);
  const ttl = input.ttlMs ?? (state === 'pending_2fa' ? 5 * 60_000 : absoluteMs);
  const doc = await Models.Session.create({
    token_hash: hash,
    user_id: input.user_id,
    company_scope: input.company_scope,
    active_company_id: input.active_company_id,
    state,
    persistent,
    absolute_expires_at: new Date(now + absoluteMs),
    ip: input.ip,
    ua: input.ua,
    created_at: new Date(now),
    last_seen: new Date(now),
    expires_at: new Date(now + ttl),
  });
  return { raw, session_id: String(doc._id) };
}

export async function readSession(raw: string): Promise<SessionData | null> {
  const key = `sess:${raw}`;
  const cached = cacheGet<SessionData | null>(key);
  if (cached !== undefined) return cached;

  const s = await Models.Session.findOne({ token_hash: hashToken(raw), revoked_at: null })
    .select({ user_id: 1, company_scope: 1, active_company_id: 1, state: 1, persistent: 1, expires_at: 1, absolute_expires_at: 1, created_at: 1 })
    .lean<{
      _id: unknown;
      user_id: unknown;
      company_scope?: unknown[];
      active_company_id?: unknown;
      state?: string;
      persistent?: boolean;
      expires_at?: Date;
      absolute_expires_at?: Date;
      created_at?: Date;
    } | null>();

  if (!s || !s.expires_at || s.expires_at.getTime() < Date.now()) {
    cacheSet(key, null, 10_000);
    return null;
  }

  const data: SessionData = {
    session_id: String(s._id),
    user_id: String(s.user_id),
    company_scope: (s.company_scope ?? []).map(String),
    active_company_id: s.active_company_id ? String(s.active_company_id) : null,
    state: s.state === 'pending_2fa' ? 'pending_2fa' : 'active',
    persistent: Boolean(s.persistent),
    // doc cũ (trước khi có cột này) → coi expires_at hiện hành là mốc
    absolute_expires_at: (s.absolute_expires_at ?? s.expires_at).getTime(),
    renewed: false,
  };
  // Cập nhật không chờ, không chặn response.
  const set: Record<string, unknown> = { last_seen: new Date() };
  const now = Date.now();
  if (data.persistent) {
    // CUỘN: mỗi lần dùng lại nạp hạn 400 ngày → không có trần tuyệt đối.
    // Người dùng quay lại trước khi hết 400 ngày thì về thực tế là vĩnh viễn.
    // chỉ viết khi còn dưới 400 ngày - 1 ngày để không nhân write theo nhịp poll 30s.
    const rollTo = now + rememberTtlMs();
    if (data.absolute_expires_at < rollTo - RENEW_SLACK_MS) {
      data.absolute_expires_at = rollTo;
      data.renewed = true;
      set.expires_at = new Date(rollTo);
      set.absolute_expires_at = new Date(rollTo);
    }
  } else {
    // sliding idle (15'), bị chặn bởi trần absolute 8h
    const idleDeadline = now + getEnv().SESSION_IDLE_MINUTES * 60_000;
    set.expires_at = new Date(Math.min(idleDeadline, data.absolute_expires_at));
  }
  void Models.Session.updateOne({ _id: s._id }, { $set: set }).exec();
  cacheSet(key, data, 60_000);
  return data;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await Models.Session.updateOne({ _id: sessionId }, { $set: { revoked_at: new Date() } }).exec();
  cacheInvalidate('sess:');
}

/** Thu hồi tức thì: disabled / đổi vai trò / đổi mật khẩu (§7.2). */
export async function revokeAllUserSessions(userId: string, reason: string): Promise<void> {
  await Models.Session.updateMany({ user_id: userId, revoked_at: null }, { $set: { revoked_at: new Date() } }).exec();
  cacheInvalidate('sess:');
  console.log(`[session] thu hồi mọi phiên của ${userId}: ${reason}`);
}

/** Sau khi 2FA đạt → nâng session pending_2fa thành active. */
export async function activateSession(
  sessionId: string,
  companyScope: string[],
  activeCompanyId: string | null,
  persistent = false,
): Promise<void> {
  const until = Date.now() + sessionTtlMs(persistent);
  await Models.Session.updateOne(
    { _id: sessionId },
    {
      $set: {
        state: 'active',
        persistent,
        company_scope: companyScope,
        active_company_id: activeCompanyId,
        expires_at: new Date(until),
        absolute_expires_at: new Date(until),
      },
    },
  ).exec();
  cacheInvalidate('sess:');
}

/* ------------------------------------------------------------------ *
 * Hooks + error handler
 * ------------------------------------------------------------------ */

const PUBLIC_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/2fa',
  '/api/v1/auth/logout',
  '/api/v1/auth/password-forgot',
  '/api/v1/auth/password-reset',
  '/api/v1/activate',
  '/api/v1/activate/info',
  '/api/v1/openapi.json',
  '/healthz',
]);

export function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return PUBLIC_PATHS.has(path) || path.startsWith('/api/v1/tasks/');
}

/** đường không cần session nhưng cũng không phải API (static, /in/*) */
export function isNonApiPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return !path.startsWith('/api/');
}

export function installHttpLayer(app: FastifyInstance): void {
  app.addHook('onRequest', async (req) => {
    (req as CtxRequest).fg = { ...EMPTY, traceId: traceIdOf(req), ip: clientIp(req), ua: (req.headers['user-agent'] as string) ?? null };
  });

  app.addHook('preHandler', async (req, reply) => {
    const base = requestCtx(req);
    if (isPublicPath(req.url) || isNonApiPath(req.url)) return;

    const raw = readCookie(req.headers.cookie, COOKIE);
    const session = raw ? await readSession(raw) : null;
    if (!session) throw new ApiError({ code: 'FG-AUTH-001' });
    if (session.state === 'pending_2fa') throw new ApiError({ code: 'FG-AUTH-005', data: { need_2fa: true } });
    // phiên "ghi nhớ" vừa cuộn hạn → Max-Age trình duyệt phải đếm lại
    if (session.renewed) reply.header('set-cookie', cookieHeader(raw!, { persistent: true }));

    const requested = scopeHeader(req);
    const identity = await resolveIdentity(session.user_id, {
      activeCompanyId: requested && requested !== 'all' ? requested : session.active_company_id,
    });
    if (!identity) {
      await revokeSession(session.session_id);
      throw new ApiError({ code: 'FG-AUTH-004' });
    }

    const scope = scopeFor(identity, requested && requested !== 'all' ? requested : null);
    (req as CtxRequest).fg = {
      actor: actorInfoFrom(identity, session.session_id),
      identity,
      scope,
      sessionId: session.session_id,
      ip: base.ip,
      ua: base.ua,
      traceId: base.traceId,
    };
  });

  /** Guard đọc `config.perms` của route — route nghiệp vụ nào cũng phải khai. */
  app.addHook('preHandler', async (req) => {
    const config = (req.routeOptions as unknown as { config?: RouteConfig }).config;
    if (!config || config.perms === undefined || config.perms === 'public') return;
    if (isNonApiPath(req.url)) return;
    if (!config.perms.length) return;
    requirePerm(req, ...config.perms);
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    const traceId = requestCtx(req).traceId;
    let problem: ProblemJson;
    if (err instanceof ApiError) {
      problem = toProblem(err, traceId);
    } else if (Array.isArray((err as { validation?: unknown[] }).validation)) {
      const e = err as { validation?: { key?: string; message?: string }[] };
      problem = toProblem(
        new ApiError({
          code: 'FG-VAL-001',
          detail: 'Dữ liệu gửi lên không hợp lệ',
          errors: Object.fromEntries((e.validation ?? []).map((v) => [v.key ?? 'body', v.message ?? 'Không hợp lệ'])),
        }),
        traceId,
      );
    } else if ((err as { statusCode?: number }).statusCode === 429) {
      problem = toProblem(new ApiError({ code: 'FG-AUTH-007' }), traceId);
    } else {
      req.log.error({ err }, 'lỗi chưa xử lý');
      problem = toProblem(new ApiError({ code: 'FG-SYS-001' }), traceId);
    }
    void reply.code(problem.status).type('application/problem+json').send(problem);
  });
}

function toProblem(err: ApiError, traceId: string): ProblemJson {
  const problem = parseProblem(err.status, { code: err.code, detail: err.detail, errors: err.errors, data: err.data });
  if (traceId) problem.trace_id = traceId;
  return problem;
}

/** Đọc cookie thủ công — không phụ thuộc type augmentation của @fastify/cookie. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const v = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return undefined;
}

export function cookieHeader(
  raw: string,
  opts: { maxAgeSec?: number; clear?: boolean; persistent?: boolean } = {},
): string {
  const env = getEnv();
  const defaultMaxAge = opts.persistent ? env.SESSION_REMEMBER_DAYS * 86_400 : env.SESSION_ABSOLUTE_HOURS * 3600;
  const parts = [
    `${COOKIE}=${raw}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    env.isProd ? 'Secure' : '',
    `Max-Age=${opts.clear ? 0 : (opts.maxAgeSec ?? defaultMaxAge)}`,
  ].filter(Boolean);
  return parts.join('; ');
}

function scopeHeader(req: FastifyRequest): string | undefined {
  const h = req.headers['x-company-scope'];
  if (typeof h === 'string' && h) return h;
  const q = (req.query as { scope?: unknown } | undefined)?.scope;
  return typeof q === 'string' && q ? q : undefined;
}

export function requestedScope(req: FastifyRequest): string | undefined {
  return scopeHeader(req);
}

function traceIdOf(req: FastifyRequest): string {
  const incoming = req.headers['x-trace-id'];
  if (typeof incoming === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(incoming)) return incoming;
  return randomBytes(6).toString('hex');
}

/* ------------------------------------------------------------------ *
 * defineRoute — khai báo `perms` tại route (CI script kiểm tra)
 * ------------------------------------------------------------------ */

export interface RouteConfig {
  perms: Permission[] | 'public';
  screen?: string;
  summary?: string;
  /** hành động nhạy cảm → bắt buộc step-up trong body.verify (arch §7.2) */
  stepUp?: boolean;
}

export type DefinedRoute = RouteOptions & { config: RouteConfig };

export function defineRoute(def: DefinedRoute): DefinedRoute {
  if (!def.config || def.config.perms === undefined) {
    throw new Error(`Route ${String(def.method)} ${def.url} thiếu config.perms — CI chặn (arch §15)`);
  }
  return def;
}

/** parse qua zod, biến ZodError thành FG-VAL-001 kèm thông điệp từng field. */
export function validate<T>(schema: ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issues = r.error.issues ?? [];
  throw new ApiError({
    code: 'FG-VAL-001',
    detail: issues[0]?.message ?? 'Dữ liệu không hợp lệ',
    errors: Object.fromEntries(issues.map((i) => [i.path.join('.') || 'body', i.message])),
  });
}

export function newRequestId(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

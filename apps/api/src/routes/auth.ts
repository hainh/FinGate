/**
 * Nhóm route xác thực & phiên (blueprint §XXVI, architecture §7.2, screens AUTH-01→06).
 *
 * - Không có self-signup (K-18) — chỉ login + kích hoạt qua invite.
 * - Chống dò: rate-limit theo IP+email, thông điệp LUÔN "Email hoặc mật khẩu không đúng".
 * - 2FA bắt buộc cho KTT/PGĐ/GĐ/Chairman/Admin; step-up verify cho hành động nhạy cảm.
 */

import type { FastifyInstance } from 'fastify';
import {
  ApiError,
  MFA_REQUIRED_ROLES,
  ROLE_LABEL,
  buildEntitlements,
  type Role,
} from '@fingate/shared';
import { loginBodySchema, twoFactorBodySchema, forgotBodySchema, resetBodySchema, activateBodySchema, prefsBodySchema } from './schemas.ts';
import { loginBody, twoFactorBody, forgotPasswordBody, resetPasswordBody, activateBody, prefsUpdateBody } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { getEnv } from '../env.ts';
import {
  COOKIE,
  readCookie,
  activateSession,
  cookieHeader,
  createSession,
  defineRoute,
  readSession,
  requestCtx,
  requireActor,
  revokeAllUserSessions,
  revokeSession,
  validate,
} from '../lib/http.ts';
import { generateRecoveryCodes, hashToken, hashPassword, randomToken, verifyPassword } from '../lib/password.ts';
import { decryptField, encryptField } from '../lib/crypto.ts';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp.ts';
import { inviteLinkStatus, seedMatches, verifyInviteToken, type InviteShape } from '../lib/invite.ts';
import { mirrorAudit } from '../domain/audit/index.ts';
import { resolveIdentity } from '../domain/entitlement/index.ts';
import { mailTemplates, sendMail } from '../mail/sender.ts';

const LOCK_KEY = (ip: string, email: string) => `lock:${ip}:${email}`;

export function authRoutes(app: FastifyInstance): void {
  /**
   * Bước 1 — email + mật khẩu. Trả `challenge` nếu tài khoản bật 2FA.
   * rate-limit 5/giờ/IP+email, khoá 15 phút sau 8 lần (§7.2) — đặt ở server.ts qua @fastify/rate-limit.
   */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/auth/login',
      config: { perms: 'public', screen: 'AUTH-01', summary: 'Đăng nhập (bước 1)' },
      schema: { tags: ['auth'], body: loginBodySchema, description: 'Đăng nhập bước 1 — cần 2FA thì trả challenge' },
      handler: async (req, reply) => {
        const body = validate(loginBody, req.body);
        const email = body.email.trim().toLowerCase();
        const ip = requestCtx(req).ip ?? 'unknown';
        const lock = cacheInvalidateAndCheckLock(ip, email);
        if (lock.locked) throw new ApiError({ code: 'FG-AUTH-007', data: { retry_after_s: lock.retryAfter } });

        const user = await Models.User.findOne({ email }).lean();
        // KHÔNG tách nhánh "không tồn tại" / "sai mật khẩu" → cùng một thông điệp (chống dò email)
        if (!user) {
          noteFailed(ip, email);
          throw new ApiError({ code: 'FG-AUTH-002' });
        }
        if (user.status === 'invited') {
          throw new ApiError({ code: 'FG-AUTH-003', detail: 'Tài khoản đang chờ kích hoạt — kiểm tra email mời' });
        }
        if (user.status === 'deactivated') throw new ApiError({ code: 'FG-AUTH-004' });
        if (user.locked_until && new Date(user.locked_until) > new Date()) {
          throw new ApiError({ code: 'FG-AUTH-007', data: { retry_after_s: Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 1000) } });
        }

        const ok = await verifyPassword(body.password, {
          kdf: 'scrypt',
          hash: user.password?.hash ?? undefined,
          salt: user.password?.salt ?? undefined,
        });
        if (!ok) {
          noteFailed(ip, email);
          throw new ApiError({ code: 'FG-AUTH-002' });
        }
        clearFailed(ip, email);

        const identity = await resolveIdentity(String(user._id), {});
        const needs2fa =
          Boolean(user.totp?.enabled) &&
          (MFA_REQUIRED_ROLES.includes(identity?.role ?? 'staff') || Boolean(user.mfa_required));
        // loginBody.remember mặc định true → "đăng nhập vĩnh viễn" (§7.2, SESSION_REMEMBER_DAYS)
        const remember = body.remember;

        await Models.User.updateOne(
          { _id: user._id },
          { $set: { last_login_at: new Date(), last_login_ip: ip, failed_logins: 0, locked_until: null } },
        ).exec();

        if (needs2fa) {
          const { raw, hash } = randomToken(24);
          const s = await createSession({
            user_id: String(user._id),
            company_scope: identity?.assignments.map((a) => a.company_id) ?? [],
            active_company_id: identity?.company_id ?? null,
            state: 'pending_2fa',
            persistent: remember,
            ip,
            ua: requestCtx(req).ua,
            ttlMs: 5 * 60_000,
          });
          await Models.Session.updateOne(
            { _id: s.session_id },
            { $set: { token_hash: hash, challenge_hash: hash } },
          ).exec();
          reply.header('set-cookie', cookieHeader(raw, { maxAgeSec: 300 }));
          return {
            data: {
              need_2fa: true,
              challenge: raw,
              method: 'totp',
              hint: 'Nhập mã 6 chữ số từ ứng dụng xác thực',
              resend_after_s: 30,
            },
          };
        }

        const scopeIds = identity?.assignments.map((a) => a.company_id) ?? [];
        const { raw, session_id } = await createSession({
          user_id: String(user._id),
          company_scope: scopeIds,
          active_company_id: pickActive(user.prefs?.active_company_id, scopeIds),
          persistent: remember,
          ip,
          ua: requestCtx(req).ua,
        });
        reply.header('set-cookie', cookieHeader(raw, { persistent: remember }));
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: String(user._id), name: String(user.display_name ?? email), role: identity?.role ?? null },
          action: 'auth.login',
          subject: { type: 'session', id: session_id, code: null },
          company_id: identity?.company_id ?? null,
          ip,
          ua: requestCtx(req).ua,
        });
        return reply.code(200).send({ data: { need_2fa: false, user_id: String(user._id) } });
      },
    }),
  );

  /** Bước 2 — OTP / recovery code (AUTH-02). */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/auth/2fa',
      config: { perms: 'public', screen: 'AUTH-02', summary: 'Xác thực 2 lớp' },
      schema: { tags: ['auth'], body: twoFactorBodySchema },
      handler: async (req, reply) => {
        const body = validate(twoFactorBody, req.body);
        const { raw } = parseChallenge(body.challenge);
        const session = await readSession(raw);
        if (!session) throw new ApiError({ code: 'FG-AUTH-001' });
        if (session.state !== 'pending_2fa') throw new ApiError({ code: 'FG-AUTH-001', detail: 'Phiên đã kích hoạt' });

        const user = await Models.User.findById(session.user_id).lean<{
          _id: unknown;
          email: string;
          display_name?: string;
          totp?: { enabled?: boolean; secret_enc?: string | null };
          recovery_codes?: { hash?: string; used_at?: Date | null }[];
        } | null>();
        if (!user) throw new ApiError({ code: 'FG-AUTH-001' });

        const secret = decryptField(user.totp?.secret_enc);
        let verified = false;
        if (secret && /^\d{6}$/.test(body.code)) verified = verifyTotp(body.code, secret);
        if (!verified) verified = consumeRecoveryCode(String(user._id), user.recovery_codes ?? [], body.code);
        if (!verified) throw new ApiError({ code: 'FG-AUTH-006' });

        await activateSession(session.session_id, session.company_scope, session.active_company_id, session.persistent);
        reply.header('set-cookie', cookieHeader(raw, { persistent: session.persistent }));
        return { data: { ok: true, user_id: String(user._id) } };
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/auth/logout',
      config: { perms: 'public', screen: 'AUTH-01', summary: 'Đăng xuất' },
      handler: async (req, reply) => {
        const raw = readCookieValue(req);
        const session = raw ? await readSession(raw) : null;
        if (session) await revokeSession(session.session_id);
        reply.header('set-cookie', cookieHeader('', { clear: true }));
        return { data: { ok: true } };
      },
    }),
  );

  /** AUTH-03 — luôn trả CÙNG thông điệp bất kể email có tồn tại (chống dò). */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/auth/password-forgot',
      config: { perms: 'public', screen: 'AUTH-03', summary: 'Quên mật khẩu' },
      schema: { tags: ['auth'], body: forgotBodySchema },
      handler: async (req) => {
        const body = validate(forgotPasswordBody, req.body);
        const email = body.email.trim().toLowerCase();
        const user = await Models.User.findOne({ email, status: 'active' }).select({ _id: 1 }).lean();
        if (user) {
          const { raw, hash } = randomToken(24);
          await Models.User.updateOne(
            { _id: user._id },
            { $set: { reset: { token_hash: hash, expires_at: new Date(Date.now() + 30 * 60_000) } } },
          ).exec();
          void sendMail({
            to: email,
            subject: 'Đặt lại mật khẩu FinGate',
            html: mailTemplates.resetPassword({ href: `/mat-khau/dat-lai?token=${raw}`, minutes: 30 }),
            urgent: true,
          });
        }
        return {
          data: {
            ok: true,
            message: 'Nếu email này có trong hệ thống, chúng tôi đã gửi liên kết đặt lại mật khẩu.',
          },
        };
      },
    }),
  );

  /** AUTH-04 — đặt lại mật khẩu bằng token, thu hồi mọi phiên cũ. */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/auth/password-reset',
      config: { perms: 'public', screen: 'AUTH-04', summary: 'Đặt lại mật khẩu' },
      schema: { tags: ['auth'], body: resetBodySchema },
      handler: async (req) => {
        const body = validate(resetPasswordBody, req.body);
        const hash = hashToken(body.token);
        const user = await Models.User.findOne({ 'reset.token_hash': hash, 'reset.expires_at': { $gt: new Date() } })
          .select({ _id: 1, email: 1 })
          .lean();
        if (!user) throw new ApiError({ code: 'FG-AUTH-009' });
        const pw = await hashPassword(body.new_password);
        await Models.User.updateOne(
          { _id: user._id },
          { $set: { password: pw, reset: null, updated_at: new Date() } },
        ).exec();
        await revokeAllUserSessions(String(user._id), 'đổi mật khẩu');
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: String(user._id), name: String(user.email), role: null },
          action: 'auth.password_reset',
          subject: { type: 'user', id: String(user._id), code: null },
          ip: requestCtx(req).ip,
          ua: requestCtx(req).ua,
        });
        return { data: { ok: true, message: 'Mật khẩu đã đổi. Đăng nhập lại để tiếp tục.' } };
      },
    }),
  );

  /**
   * AUTH-05 (public) — xác minh chữ ký link và trả thông tin lời mời để màn
   * kích hoạt hiển thị "bạn được mời vào công ty X, chức danh Y" trước khi đặt mật khẩu.
   */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/activate/info',
      config: { perms: 'public', screen: 'AUTH-05', summary: 'Thông tin lời mời (theo link ký)' },
      handler: async (req) => {
        const token = (req.query as { token?: string } | undefined)?.token ?? '';
        const payload = verifyInviteToken(token); // sai chữ ký/hết hạn → FG-AUTH-009
        const user = await Models.User.findById(payload.user_id)
          .select({ email: 1, display_name: 1, status: 1, invite: 1 })
          .lean<{ _id: unknown; email: string; display_name?: string | null; status: string; invite?: InviteShape } | null>();
        if (!user || !seedMatches(user.invite?.seed, payload.seed)) throw new ApiError({ code: 'FG-AUTH-009' });
        if (user.status !== 'invited') throw new ApiError({ code: 'FG-AUTH-009', detail: 'Tài khoản đã được kích hoạt' });

        const inv = user.invite ?? {};
        const company = inv.company_id ? await Models.Company.findById(inv.company_id).select({ name: 1 }).lean() : null;
        const dept = inv.department_id ? await Models.Department.findById(inv.department_id).select({ name: 1 }).lean() : null;
        const inviter = inv.invited_by ? await Models.User.findById(inv.invited_by).select({ display_name: 1, email: 1 }).lean() : null;
        const role = (inv.role ?? 'staff') as Role;
        return {
          data: {
            email: String(user.email),
            display_name: user.display_name ?? null,
            company_name: String(company?.name ?? ''),
            role,
            role_label: ROLE_LABEL[role] ?? role,
            department_name: dept ? String(dept.name) : null,
            invited_by_name: inviter ? String(inviter.display_name ?? inviter.email) : null,
            expires_at: payload.exp ? new Date(payload.exp).toISOString() : new Date().toISOString(),
            mfa_required: MFA_REQUIRED_ROLES.includes(role),
          },
        };
      },
    }),
  );

  /**
   * AUTH-05 — người nhận link ĐẶT MẬT KHẨU + họ tên → kích hoạt (một bước).
   * Công ty/chức danh đã gắn sẵn từ lúc mời (§XXIX.3) — link chỉ để chứng minh
   * "đúng người được admin cấp" và để giao mật khẩu.
   * Vai trò bắt buộc 2FA: người dùng tự bật trong Cài đặt (PREF-01) sau khi đăng nhập.
   */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/activate',
      config: { perms: 'public', screen: 'AUTH-05', summary: 'Kích hoạt tài khoản (đặt mật khẩu)' },
      schema: { tags: ['auth'], body: activateBodySchema },
      handler: async (req, reply) => {
        const body = validate(activateBody, req.body);

        const payload = verifyInviteToken(body.token);
        const user = await Models.User.findById(payload.user_id).lean();
        const inv = (user as { invite?: InviteShape } | null)?.invite;
        if (!user || !seedMatches(inv?.seed, payload.seed)) throw new ApiError({ code: 'FG-AUTH-009' });
        if (inviteLinkStatus(String(user.status), inv) !== 'active') throw new ApiError({ code: 'FG-AUTH-009' });
        if (user.status === 'active') throw new ApiError({ code: 'FG-HR-001', detail: 'Tài khoản đã được kích hoạt' });
        if (user.status === 'deactivated') throw new ApiError({ code: 'FG-AUTH-004' });

        const pw = await hashPassword(body.password);
        const role = (inv?.role ?? 'staff') as Role;
        await Models.User.updateOne(
          { _id: user._id },
          {
            $set: {
              display_name: body.display_name,
              password: pw,
              mfa_required: MFA_REQUIRED_ROLES.includes(role),
              updated_at: new Date(),
            },
          },
        ).exec();

        const done = await finishActivation(user, { ip: requestCtx(req).ip, ua: requestCtx(req).ua });
        reply.header('set-cookie', cookieHeader(done.raw, { persistent: true }));
        return { data: { ok: true, user_id: done.user_id, mfa_suggested: MFA_REQUIRED_ROLES.includes(role) } };
      },
    }),
  );

  /* ---------------------------- /me ---------------------------- */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/me',
      config: { perms: [], screen: 'AUTH-01', summary: 'Hồ sơ + phạm vi + entitlements' },
      handler: async (req) => {
        const { actor, identity } = requestCtx(req);
        if (!actor || !identity) throw new ApiError({ code: 'FG-AUTH-001' });
        const u = identity.user as { _id?: unknown; email?: string; display_name?: string; status?: string; last_login_at?: Date; prefs?: Record<string, unknown>; totp?: { enabled?: boolean } };
        const companies = await Models.Company.find({ _id: { $in: identity.assignments.map((a) => a.company_id) } }).select({ name: 1, code: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), c]));
        const user = await Models.User.findById(actor.user_id)
          .select({ email: 1, display_name: 1, status: 1, prefs: 1, totp: 1, last_login_at: 1 })
          .lean();
        const assignments = identity.assignments.map((a) => ({
          company_id: a.company_id,
          company_name: String(cmap.get(a.company_id)?.name ?? ''),
          company_code: String(cmap.get(a.company_id)?.code ?? ''),
          department_id: a.department_id,
          department_name: null as string | null,
          role: a.role,
          role_label: ROLE_LABEL[a.role] ?? a.role,
          amount_limit_minor: a.amount_limit_minor.toString(),
          scope_all: a.scope_all,
        }));
        void u;
        return {
          data: {
            user_id: actor.user_id,
            email: String(user?.email ?? ''),
            display_name: String(user?.display_name ?? actor.name),
            status: String(user?.status ?? 'active'),
            totp_enabled: Boolean(user?.totp?.enabled),
            mfa_required: MFA_REQUIRED_ROLES.includes(actor.role),
            last_login_at: user?.last_login_at ? new Date(user.last_login_at).toISOString() : null,
            assignments,
            scope: {
              company_ids: assignments.map((a) => a.company_id),
              all: actor.scope_all,
              active_company_id: identity.company_id,
            },
            entitlements: buildEntitlements({
              role: actor.role,
              company_id: identity.company_id ?? '',
              amount_limit_minor: actor.amount_limit_minor.toString(),
              scope_all: actor.scope_all,
              extra: identity.extra,
              denied: identity.denied,
            }),
            prefs: {
              theme: 'light',
              density: 'comfortable',
              default_scope: 'all',
              auto_open_next: false,
              shortcuts: {},
              notify_channels: ['web'],
              quiet_hours: true,
              ...((user?.prefs as Record<string, unknown> | undefined) ?? {}),
            },
          },
        };
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/me/entitlements',
      config: { perms: [], screen: 'AUTH-01', summary: 'Quyền + cột bị ẩn cho phạm vi hiện tại' },
      handler: async (req) => {
        const { actor, identity } = requestCtx(req);
        if (!actor || !identity) throw new ApiError({ code: 'FG-AUTH-001' });
        return {
          data: buildEntitlements({
            role: actor.role,
            company_id: identity.company_id ?? '',
            amount_limit_minor: actor.amount_limit_minor.toString(),
            scope_all: actor.scope_all,
            extra: identity.extra,
            denied: identity.denied,
          }),
        };
      },
    }),
  );

  /** PREF-01 — theme/density/scope mặc định/shortcut/kênh nhận thông báo. */
  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/me/prefs',
      config: { perms: [], screen: 'PREF-01', summary: 'Cài đặt cá nhân' },
      schema: { tags: ['me'], body: prefsBodySchema },
      handler: async (req) => {
        const actor = requireActor(req);
        const body = validate(prefsUpdateBody, req.body);
        const set: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(body)) if (v !== undefined) set[`prefs.${k}`] = v;
        if (Object.keys(set).length) {
          await Models.User.updateOne({ _id: actor.user_id }, { $set: { ...set, updated_at: new Date() } }).exec();
        }
        const user = await Models.User.findById(actor.user_id).select({ prefs: 1 }).lean();
        return { data: user?.prefs ?? {} };
      },
    }),
  );

  /** Bật 2FA: trả secret + recovery codes MỘT LẦN, verify code trước khi bật. */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/me/2fa/enable',
      config: { perms: [], screen: 'PREF-01', summary: 'Bật xác thực 2 lớp' },
      handler: async (req) => {
        const actor = requireActor(req);
        const body = (req.body ?? {}) as { code?: string };
        const user = await Models.User.findById(actor.user_id).select({ email: 1, totp: 1 }).lean();
        if (!user) throw new ApiError({ code: 'FG-AUTH-001' });

        const pending = decryptField(user.totp?.secret_enc) ?? newTotpSecret();
        if (!body.code) {
          await Models.User.updateOne(
            { _id: user._id },
            { $set: { 'totp.secret_enc': encryptField(pending), 'totp.enabled': false } },
          ).exec();
          return { data: { secret: pending, otpauth_url: otpauthUrl({ secret: pending, account: String(user.email) }) } };
        }
        if (!verifyTotp(body.code, pending)) throw new ApiError({ code: 'FG-AUTH-006' });
        const codes = generateRecoveryCodes();
        await Models.User.updateOne(
          { _id: user._id },
          {
            $set: {
              'totp.enabled': true,
              'totp.secret_enc': encryptField(pending),
              recovery_codes: codes.map((c) => ({ hash: hashToken(c), used_at: null })),
              mfa_required: true,
              updated_at: new Date(),
            },
          },
        ).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'auth.2fa_enable',
          subject: { type: 'user', id: actor.user_id, code: null },
          ip: requestCtx(req).ip,
        });
        return { data: { ok: true, recovery_codes: codes } };
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/me/change-password',
      config: { perms: [], screen: 'PREF-01', summary: 'Đổi mật khẩu (thu hồi mọi phiên)' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = (req.body ?? {}) as { current_password?: string; new_password?: string };
        if (!body.current_password || !body.new_password || body.new_password.length < 12) {
          throw new ApiError({ code: 'FG-VAL-001', errors: { new_password: 'Mật khẩu tối thiểu 12 ký tự' } });
        }
        const user = await Models.User.findById(actor.user_id).select({ password: 1 }).lean();
        if (!(await verifyPassword(body.current_password, user?.password))) throw new ApiError({ code: 'FG-AUTH-008' });
        const pw = await hashPassword(body.new_password);
        await Models.User.updateOne({ _id: actor.user_id }, { $set: { password: pw, updated_at: new Date() } }).exec();
        const { sessionId } = requestCtx(req);
        await revokeAllUserSessions(actor.user_id, 'đổi mật khẩu');
        // giữ phiên hiện tại
        const raw = readCookieValue(req);
        if (raw && sessionId) {
          const kept = await Models.Session.findById(sessionId).select({ persistent: 1 }).lean<{ persistent?: boolean } | null>();
          await Models.Session.updateOne({ _id: sessionId }, { $set: { revoked_at: null } }).exec();
          reply.header('set-cookie', cookieHeader(raw, { persistent: Boolean(kept?.persistent) }));
        }
        return { data: { ok: true } };
      },
    }),
  );

  /** AUTH-06 — giữ draft: client hỏi còn phiên không trước khi hiện màn hình khoá. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/me/session',
      config: { perms: [], screen: 'AUTH-06', summary: 'Kiểm tra phiên (heartbeat 5 phút)' },
      handler: async (req) => {
        const { actor, sessionId } = requestCtx(req);
        const env = getEnv();
        const raw = readCookieValue(req);
        const session = raw ? await readSession(raw) : null;
        return {
          data: {
            alive: Boolean(actor),
            session_id: sessionId,
            /** phiên "ghi nhớ" → không có hạn idle; client khỏi hiện đồng hồ đếm ngược */
            persistent: session?.persistent ?? false,
            idle_limit_s: session?.persistent ? null : env.SESSION_IDLE_MINUTES * 60,
            absolute_expires_at: session ? new Date(session.absolute_expires_at).toISOString() : null,
          },
        };
      },
    }),
  );
}

/* ------------------------------------------------------------------ *
 * chống dò email: khoá theo IP + email
 * ------------------------------------------------------------------ */

const attempts = new Map<string, { count: number; until: number }>();

function cacheInvalidateAndCheckLock(ip: string, email: string): { locked: boolean; retryAfter?: number } {
  const e = attempts.get(LOCK_KEY(ip, email));
  if (!e) return { locked: false };
  if (e.until > Date.now()) return { locked: true, retryAfter: Math.ceil((e.until - Date.now()) / 1000) };
  if (e.until && e.until <= Date.now()) attempts.delete(LOCK_KEY(ip, email));
  return { locked: false };
}

function noteFailed(ip: string, email: string): void {
  const key = LOCK_KEY(ip, email);
  const e = attempts.get(key) ?? { count: 0, until: 0 };
  e.count += 1;
  if (e.count >= 8) e.until = Date.now() + 15 * 60_000;
  attempts.set(key, e);
}

function clearFailed(ip: string, email: string): void {
  attempts.delete(LOCK_KEY(ip, email));
}

function readCookieValue(req: { headers: { cookie?: string } }): string | undefined {
  return readCookie(req.headers.cookie, COOKIE);
}

function parseChallenge(challenge: string): { raw: string } {
  const raw = challenge.trim();
  if (raw.length < 16) throw new ApiError({ code: 'FG-AUTH-001' });
  return { raw };
}

function consumeRecoveryCode(userId: string, codes: { hash?: string; used_at?: Date | null }[], input: string): boolean {
  const h = hashToken(input.trim().toUpperCase());
  const match = codes.find((c) => c.hash === h && !c.used_at);
  if (!match) return false;
  void Models.User.updateOne({ _id: userId, 'recovery_codes.hash': h }, { $set: { 'recovery_codes.$.used_at': new Date() } }).exec();
  return true;
}

function pickActive(activeCompanyId: unknown, scopeIds: string[]): string | null {
  const pref = activeCompanyId ? String(activeCompanyId) : null;
  if (pref && scopeIds.includes(pref)) return pref;
  return scopeIds[0] ?? null;
}

/**
 * Bước cuối kích hoạt: status=active, xoá link (seed null ⇒ mọi link cũ chết),
 * báo người mời, mở phiên. Assignment đã tạo từ lúc mời — không tạo lại (§XXIX.3).
 */
async function finishActivation(
  user: { _id: unknown; email: unknown; display_name?: string | null; invite?: InviteShape | null },
  ctx: { ip: string | null; ua: string | null },
): Promise<{ raw: string; user_id: string }> {
  const inv = user.invite ?? {};
  const role = (inv.role ?? 'staff') as Role;
  const displayName = String(user.display_name ?? String(user.email).split('@')[0]);

  const set: Record<string, unknown> = {
    status: 'active',
    invite: null,
    updated_at: new Date(),
  };
  await Models.User.updateOne({ _id: user._id }, { $set: set }).exec();

  // bảo đảm Assignment đúng cấu hình mời (phòng user bị xoá assignment giữa chừng)
  if (inv.company_id) {
    const existing = await Models.Assignment.findOne({ user_id: user._id, company_id: inv.company_id } as never).lean();
    if (!existing) {
      await Models.Assignment.create({
        user_id: user._id,
        company_id: inv.company_id,
        department_id: inv.department_id ?? null,
        role,
        amount_limit_minor: 0n,
      } as never);
    }
  }

  // báo cho người mời (§XXIX.3) — best-effort, không chặn luồng
  const inviterId = inv.invited_by ? String(inv.invited_by) : '';
  const inviter = inviterId ? await Models.User.findById(inviterId).select({ email: 1 }).lean() : null;
  if (inviter) {
    void sendMail({
      to: String(inviter.email),
      subject: `${displayName} đã kích hoạt tài khoản`,
      html: `<p>${displayName} (${String(user.email)}) đã hoàn tất đặt mật khẩu và vào đúng công ty được chỉ định.</p>`,
    });
  }

  await mirrorAudit({
    at: new Date(),
    actor: { user_id: String(user._id), name: displayName, role },
    action: 'hr.activate',
    subject: { type: 'user', id: String(user._id), code: String(user.email) },
    company_id: inv.company_id ? String(inv.company_id) : null,
    ip: ctx.ip,
    ua: ctx.ua,
  });

  const scopeIds = inv.company_id ? [String(inv.company_id)] : [];
  const { raw } = await createSession({
    user_id: String(user._id),
    company_scope: scopeIds,
    active_company_id: scopeIds[0] ?? null,
    // kích hoạt tài khoản là lần đăng nhập chủ động → giữ phiên dài như "ghi nhớ"
    persistent: true,
    ip: ctx.ip,
    ua: ctx.ua,
  });
  return { raw, user_id: String(user._id) };
}

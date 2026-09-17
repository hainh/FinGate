/**
 * Nhóm route quản trị: ADM-01→13 · PREF · IMP-01 (nhân sự §XXIX, matrix §XX, audit §XIX).
 *
 * MỜI NHÂN SỰ (blueprint §XXIX.2): không tạo tài khoản ngay — lưu `invited` + email mời
 * có token hết hạn; khi kích hoạt, tự gắn đúng công ty + chức danh (§XXIX.3).
 * XOÁ = NGỪNG HOẠT ĐỘNG, không xoá vật lý, bảo toàn audit (§XXIX.4).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import ExcelJS from 'exceljs';
import {
  ApiError,
  MFA_REQUIRED_ROLES,
  ROLE_LABEL,
  today,
  type Permission,
  type Role,
} from '@fingate/shared';
import { Models } from '../db/models.ts';
import { defineRoute, requestCtx, requireActor, requireScope, validate, revokeAllUserSessions } from '../lib/http.ts';
import { ok, jsonSafe } from '../lib/serialize.ts';
import {
  companyUpsertBody,
  delegationBody,
  departmentUpsertBody,
  categoryUpsertBody,
  matrixUpsertBody,
  personnelDeactivateBody,
  personnelInviteBody,
  personnelTransferBody,
  recurringUpsertBody,
  settingUpsertBody,
  auditLogQuery,
  budgetUpsertBody,
  alertRuleUpsertBody,
  inviteRegenerateBody,
} from '@fingate/shared';
import {
  categoryUpsertBodySchema,
  companyUpsertBodySchema,
  delegationBodySchema,
  departmentUpsertBodySchema,
  inviteRegenerateBodySchema,
  matrixUpsertBodySchema,
  personnelDeactivateBodySchema,
  personnelInviteBodySchema,
  personnelTransferBodySchema,
  recurringUpsertBodySchema,
  settingUpsertBodySchema,
} from './schemas.ts';
import {
  DEFAULT_INVITE_DAYS,
  inviteExpiresAt,
  inviteLinkStatus,
  newInviteSeed,
  currentInviteLink,
  type InviteShape,
} from '../lib/invite.ts';
import { mirrorAudit } from '../domain/audit/index.ts';
import { scopedAggregate } from '../lib/mongo.ts';
import { assertMatrixSteps } from '../domain/workflow/matrix.ts';
import { DECISION_STATUSES, asBigInt, wire } from '../domain/queries/index.ts';
import { mailTemplates, sendMail } from '../mail/sender.ts';
import { reportPreset } from '../domain/reports/index.ts';
import { exportRequestBody } from '@fingate/shared';
import { getEnv } from '../env.ts';

export function adminRoutes(app: FastifyInstance): void {
  /* ============================ NHÂN SỰ (§XXIX) ============================ */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/personnel',
      config: { perms: ['hr:invite'] as Permission[], screen: 'ADM-01', summary: 'Danh sách nhân sự' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const q = (req.query ?? {}) as { company_id?: string; status?: string; q?: string; limit?: string };
        // scope_all (chairman/admin): mặc định xem MỌI công ty; truyền company_id mới lọc 1 công ty.
        // Người bị ghim công ty: mặc định công ty mình.
        const companyId = q.company_id ?? (scope.companyIds === null ? undefined : actor.company_id);
        if (scope.companyIds !== null && companyId && !scope.companyIds.includes(companyId)) {
          throw new ApiError({ code: 'FG-HR-002' });
        }
        const filter: Record<string, unknown> = {};
        if (companyId) filter.company_id = companyId;
        // status tài khoản (invited/active/deactivated) nằm ở User, không phải Assignment
        const userStatus = q.status;

        const assignments = await Models.Assignment.find(filter as never).select({ user_id: 1, company_id: 1, department_id: 1, role: 1, amount_limit_minor: 1, status: 1 }).lean();
        const userIds = [...new Set(assignments.map((a) => String(a.user_id)))];
        const userFilter: Record<string, unknown> = { _id: { $in: userIds } };
        if (userStatus) userFilter.status = userStatus;
        if (q.q) userFilter.$or = [{ display_name: rx(q.q) }, { email: rx(q.q) }];
        const users = await Models.User.find(userFilter as never)
          .select({ email: 1, display_name: 1, status: 1, last_login_at: 1, totp: 1, created_at: 1, invite: 1 })
          .limit(Number(q.limit ?? 100))
          .lean();
      const departments = await Models.Department.find({}).select({ name: 1, company_id: 1 }).lean();
      const companies = await Models.Company.find({}).select({ name: 1 }).lean();
      const dmap = new Map(departments.map((d) => [String(d._id), String(d.name)]));
      const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));

      // người đang giữ node `current` → phải chỉ định người thay thế trước khi khoá (§XXIX.4)
      const holding = await scopedAggregate<{ _id: unknown; n: number }>(Models.Document, scope, [
        { $match: { status: { $in: [...DECISION_STATUSES] }, 'approval.steps': { $elemMatch: { state: 'current' } } } },
        { $unwind: '$approval.steps' },
        { $match: { 'approval.steps.state': 'current' } },
        { $group: { _id: '$approval.steps.user_id', n: { $sum: 1 } } },
      ]);
      const holdMap = new Map(holding.map((h) => [String(h._id), Number(h.n)]));

        const showEmail = actor.permissions.includes('hr:invite');
        const now = new Date();
        const items = users.map((u) => {
          const a = assignments.find((x) => String(x.user_id) === String(u._id));
          const email = String(u.email ?? '');
          const inv = (u as { invite?: InviteShape }).invite;
          const inviteStatus = inviteLinkStatus(String(u.status), inv, now);
          return {
            user_id: String(u._id),
            display_name: String(u.display_name ?? email.split('@')[0]),
            email: showEmail ? email : maskEmail(email),
            email_masked: !showEmail,
            company_id: a ? String(a.company_id) : '',
            company_name: a ? (cmap.get(String(a.company_id)) ?? '') : '',
            department_name: a?.department_id ? (dmap.get(String(a.department_id)) ?? null) : null,
            role: String(a?.role ?? 'staff'),
            role_label: ROLE_LABEL[String(a?.role ?? 'staff') as Role] ?? '',
            status: String(u.status ?? 'invited'),
            amount_limit_minor: String(a?.amount_limit_minor ?? '0'),
            mfa_enabled: Boolean((u as { totp?: { enabled?: boolean } }).totp?.enabled),
            last_login_at: u.last_login_at ? new Date(u.last_login_at).toISOString() : null,
            invited_at: inv?.sent_at ? new Date(String(inv.sent_at)).toISOString() : null,
            invite_status: inviteStatus,
            invite_expires_at: inviteStatus === 'active' && inv?.expires_at ? new Date(inv.expires_at).toISOString() : null,
            invite_regenerate_count: Number(inv?.regenerate_count ?? 0),
            started_at: u.created_at ? new Date(String(u.created_at)).toISOString().slice(0, 10) : null,
            holding_docs: holdMap.get(String(u._id)) ?? 0,
          };
        });
      return ok(reply, { items, total: items.length }, { maxAge: 15 });
      },
    }),
  );

  /**
   * Tạo tài khoản mời — admin nhận về LINK KÝ (HMAC, hạn mặc định 1 ngày) để tự
   * copy gửi cho người được mời, KHÔNG cần gửi email (§XXIX.2 sửa đổi).
   * Send mail vẫn tùy chọn qua `send_email` khi hạ tầng SMTP có sẵn.
   */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/personnel/invite',
      config: { perms: ['hr:invite'] as Permission[], screen: 'ADM-01', summary: 'Tạo tài khoản + link kích hoạt (ký, 1 ngày)' },
      schema: { tags: ['personnel'], body: personnelInviteBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(personnelInviteBody, req.body);
        // Giám đốc công ty con: company KHÓA cứng vào công ty mình (§XXIX.1)
        let companyId = body.company_id ?? actor.company_id;
        if (!actor.scope_all) {
          if (body.company_id && body.company_id !== actor.company_id) {
            throw new ApiError({ code: 'FG-HR-002', detail: 'Bạn chỉ mời được nhân sự cho công ty của mình' });
          }
          companyId = actor.company_id;
        }
        if (!companyId) throw new ApiError({ code: 'FG-HR-002', detail: 'Chưa xác định công ty' });

        const email = body.email.trim().toLowerCase();
        const existing = await Models.User.findOne({ email }).lean();
        if (existing) {
          const st = String(existing.status);
          if (st === 'invited') {
            // đang có lời mời dở — trả chính link hiện hành (FE cho phép copy/regenerate)
            const link = currentInviteLink(String(existing._id), (existing as { invite?: InviteShape }).invite);
            throw new ApiError({
              code: 'FG-HR-001',
              detail: link
                ? 'Email đang chờ kích hoạt — liên kết hiện hành đã được tải lại.'
                : 'Email đã được mời nhưng liên kết đã hết hạn/thu hồi — tạo liên kết mới.',
              data: {
                user_id: String(existing._id),
                invite_url: link?.url ?? null,
                expires_at: link?.expires_at ?? null,
                can_regenerate: true,
              },
            });
          }
          throw new ApiError({ code: 'FG-HR-001', detail: st === 'deactivated' ? 'Email đã tồn tại (tài khoản ngừng hoạt động — cần admin xử lý lại)' : 'Email đã tồn tại trong hệ thống' });
        }

        const seed = newInviteSeed();
        const expires = inviteExpiresAt(body.valid_days ?? DEFAULT_INVITE_DAYS);
        const created = await Models.User.create({
          email,
          display_name: null,
          status: 'invited',
          mfa_required: MFA_REQUIRED_ROLES.includes(body.role as Role),
          invite: {
            seed,
            expires_at: expires,
            invited_by: actor.user_id,
            sent_at: new Date(),
            send_count: 0,
            regenerate_count: 0,
            company_id: companyId,
            role: body.role,
            department_id: body.department_id ?? null,
          },
        } as never);

        // gán công ty + chức danh NGAY từ lúc mời — hết hạn/thu hồi thì Assignment vẫn còn,
        // link mới regenerate dùng lại đúng cấu hình này (§XXIX.3).
        await Models.Assignment.create({
          user_id: created._id,
          company_id: companyId,
          department_id: body.department_id ?? null,
          role: body.role,
          amount_limit_minor: body.amount_limit_minor ? BigInt(body.amount_limit_minor) : 0n,
          status: 'active',
        } as never);

        const link = currentInviteLink(String(created._id), { seed, expires_at: expires, sent_at: new Date() })!;

        if (body.send_email) {
          const company = await Models.Company.findById(companyId).select({ name: 1 }).lean();
          const sent = await sendMail({
            to: email,
            subject: `Mời bạn tham gia ${company?.name ?? 'FinGate'}`,
            html: mailTemplates.invite({
              name: email.split('@')[0] ?? '',
              company: String(company?.name ?? ''),
              roleLabel: ROLE_LABEL[body.role as Role] ?? body.role,
              href: link.url.replace(getEnv().PUBLIC_URL.replace(/\/$/, ''), ''),
              inviter: actor.name,
              days: body.valid_days ?? DEFAULT_INVITE_DAYS,
            }),
            urgent: true,
          });
          if (sent) {
            await Models.User.updateOne({ _id: created._id }, { $set: { 'invite.send_count': 1 } }).exec();
          }
        }

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'hr.invite',
          subject: { type: 'user', id: String(created._id), code: maskEmail(email) },
          company_id: companyId,
          ip: requestCtx(req).ip,
        });
        return ok(
          reply,
          {
            data: {
              user_id: String(created._id),
              email,
              // status = trạng thái LINK (khớp inviteLinkResult), không phải status tài khoản
              status: 'active' as const,
              mode: 'activate' as const,
              invite_url: link.url,
              expires_at: link.expires_at,
              invited_at: new Date().toISOString(),
              regenerate_count: 0,
              send_count: body.send_email ? 1 : 0,
            },
          },
          { status: 201 },
        );
      },
    }),
  );

  /** ADM-01 — lấy lại link kích hoạt hiện hành để copy (HMAC tất định → đúng link đã phát). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/personnel/:id/invite-link',
      config: { perms: ['hr:invite'] as Permission[], screen: 'ADM-01', summary: 'Link kích hoạt hiện hành' },
      handler: async (req) => {
        const { id } = req.params as { id: string };
        await assertManages(req, id);
        const user = await Models.User.findById(id).select({ email: 1, status: 1, invite: 1 }).lean();
        if (!user) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        const inv = (user as { invite?: InviteShape }).invite;
        const status = inviteLinkStatus(String(user.status), inv);
        const link = status === 'active' || status === 'expired' ? currentInviteLink(id, inv) : null;
        return {
          data: {
            user_id: id,
            email: String(user.email),
            status,
            mode: inv && inv.seed ? (inv.mode === 'reset' ? 'reset' : 'activate') : null,
            invite_url: status === 'active' ? (link?.url ?? null) : null,
            expires_at: inv?.expires_at ? new Date(inv.expires_at).toISOString() : null,
            invited_at: inv?.sent_at ? new Date(inv.sent_at).toISOString() : null,
            regenerate_count: Number(inv?.regenerate_count ?? 0),
            send_count: Number(inv?.send_count ?? 0),
          },
        };
      },
    }),
  );

  /**
   * ADM-01 — cấp link MỚI: seed đổi ⇒ MỌI link cũ mất hiệu lực tức thì
   * (kể cả link cũ còn hạn), hạn mới tính lại từ bây giờ.
   *
   * Tài khoản `invited` → link kích hoạt (mode activate). Tài khoản đã `active` →
   * quản trị nhân sự vẫn cấp được link ĐẶT LẠI MẬT KHẨU (mode reset) như lúc mới
   * kích hoạt; dùng xong link chết, mọi phiên cũ bị thu hồi. Ngừng hoạt động thì không.
   */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/personnel/:id/invite-link',
      config: { perms: ['hr:invite'] as Permission[], screen: 'ADM-01', summary: 'Regenerate link kích hoạt/đổi mật khẩu (vô hiệu link cũ)' },
      schema: { tags: ['personnel'], body: inviteRegenerateBodySchema },
      handler: async (req) => {
        const actor = requireActor(req);
        const body = validate(inviteRegenerateBody, req.body);
        const { id } = req.params as { id: string };
        await assertManages(req, id);
        const user = await Models.User.findById(id).select({ email: 1, status: 1, invite: 1 }).lean();
        if (!user) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        if (user.status === 'deactivated') throw new ApiError({ code: 'FG-HR-001', detail: 'Tài khoản đã ngừng hoạt động' });

        // Đã kích hoạt → đây là link đổi mật khẩu: lấy lại công ty/vai trò từ Assignment
        // (bản ghi invite bị xoá lúc activate) để thông tin/mail vẫn đúng phạm vi.
        const isReset = user.status === 'active';
        const inv = (user as { invite?: InviteShape }).invite ?? {};
        let companyId = inv.company_id ?? null;
        let role = inv.role ?? null;
        let departmentId = inv.department_id ?? null;
        let invitedBy = inv.invited_by ?? null;
        if (isReset) {
          const assignment = await Models.Assignment.findOne({ user_id: id, status: 'active' } as never)
            .select({ company_id: 1, role: 1, department_id: 1 })
            .lean<{ company_id?: unknown; role?: string | null; department_id?: unknown } | null>();
          companyId = companyId ?? assignment?.company_id ?? null;
          role = role ?? assignment?.role ?? 'staff';
          departmentId = departmentId ?? assignment?.department_id ?? null;
          invitedBy = invitedBy ?? actor.user_id;
        }

        const seed = newInviteSeed();
        const expires = inviteExpiresAt(body.valid_days ?? DEFAULT_INVITE_DAYS);
        const regenerateCount = Number(inv.regenerate_count ?? 0) + 1;
        await Models.User.updateOne(
          { _id: id },
          {
            $set: {
              'invite.mode': isReset ? 'reset' : 'activate',
              'invite.seed': seed,
              'invite.expires_at': expires,
              'invite.revoked_at': null,
              'invite.sent_at': new Date(),
              'invite.company_id': companyId,
              'invite.role': role,
              'invite.department_id': departmentId,
              'invite.invited_by': invitedBy,
              'invite.regenerate_count': regenerateCount,
              updated_at: new Date(),
            },
          },
        ).exec();

        const link = currentInviteLink(id, { seed, expires_at: expires })!;
        let sendCount = Number(inv.send_count ?? 0);
        if (body.send_email) {
          const company = await Models.Company.findById(String(companyId ?? '')).select({ name: 1 }).lean();
          const href = link.url.replace(getEnv().PUBLIC_URL.replace(/\/$/, ''), '');
          const mail = isReset
            ? mailTemplates.adminResetPassword({
                name: String(user.email).split('@')[0] ?? '',
                company: String(company?.name ?? 'FinGate'),
                roleLabel: ROLE_LABEL[(role ?? 'staff') as Role] ?? '',
                href,
                inviter: actor.name,
                days: body.valid_days ?? DEFAULT_INVITE_DAYS,
              })
            : mailTemplates.invite({
                name: String(user.email).split('@')[0] ?? '',
                company: String(company?.name ?? 'FinGate'),
                roleLabel: ROLE_LABEL[(role ?? 'staff') as Role] ?? '',
                href,
                inviter: actor.name,
                days: body.valid_days ?? DEFAULT_INVITE_DAYS,
              });
          const sent = await sendMail({
            to: String(user.email),
            subject: isReset ? 'Liên kết đặt lại mật khẩu FinGate (link cũ đã vô hiệu)' : 'Liên kết kích hoạt FinGate mới (link cũ đã vô hiệu)',
            html: mail,
            urgent: true,
          });
          if (sent) {
            sendCount += 1;
            await Models.User.updateOne({ _id: id }, { $set: { 'invite.send_count': sendCount } }).exec();
          }
        }

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: isReset ? 'hr.password_link_regenerate' : 'hr.invite_regenerate',
          subject: { type: 'user', id, code: maskEmail(String(user.email)) },
          company_id: companyId ? String(companyId) : null,
          ip: requestCtx(req).ip,
        });
        return {
          data: {
            user_id: id,
            email: String(user.email),
            status: 'active' as const,
            mode: isReset ? ('reset' as const) : ('activate' as const),
            invite_url: link.url,
            expires_at: link.expires_at,
            invited_at: new Date().toISOString(),
            regenerate_count: regenerateCount,
            send_count: sendCount,
          },
        };
      },
    }),
  );

  /** ADM-01 — vô hiệu link ngay lập tức (giữ nguyên tài khoản `invited`). */
  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/personnel/:id/invite-link',
      config: { perms: ['hr:invite'] as Permission[], screen: 'ADM-01', summary: 'Thu hồi link kích hoạt' },
      handler: async (req) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        await assertManages(req, id);
        const user = await Models.User.findById(id).select({ email: 1, status: 1, invite: 1 }).lean();
        if (!user) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        const inv = (user as { invite?: InviteShape }).invite ?? {};
        // thu hồi được link kích hoạt (invited) hoặc link đổi mật khẩu do quản trị cấp (active)
        const canRevoke = user.status === 'invited' || (user.status === 'active' && Boolean(inv.seed));
        if (!canRevoke) throw new ApiError({ code: 'FG-HR-001', detail: 'Chỉ thu hồi được link kích hoạt/đổi mật khẩu đang tồn tại' });
        if (!inv.seed) throw new ApiError({ code: 'FG-HR-001', detail: 'Tài khoản chưa có liên kết để thu hồi' });

        await Models.User.updateOne(
          { _id: id },
          {
            $set: {
              // xoá seed ⇒ token cũ không còn khớp bản ghi nào; giữ expires_at để đối chiếu audit
              'invite.seed': null,
              'invite.revoked_at': new Date(),
              updated_at: new Date(),
            },
          },
        ).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: inv.mode === 'reset' ? 'hr.password_link_revoke' : 'hr.invite_revoke',
          subject: { type: 'user', id, code: maskEmail(String(user.email)) },
          company_id: inv.company_id ? String(inv.company_id) : null,
          ip: requestCtx(req).ip,
        });
        return { data: { user_id: id, status: 'revoked' as const, mode: inv.mode === 'reset' ? ('reset' as const) : ('activate' as const), invite_url: null, expires_at: inv.expires_at ? new Date(String(inv.expires_at)).toISOString() : null, invited_at: inv.sent_at ? new Date(String(inv.sent_at)).toISOString() : null, regenerate_count: Number(inv.regenerate_count ?? 0), send_count: Number(inv.send_count ?? 0), email: String(user.email) } };
      },
    }),
  );

  /** @deprecated giữ hành vi cũ: gửi lại email — này cũng regenerate seed. */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/personnel/:id/resend',
      config: { perms: ['hr:invite'] as Permission[], screen: 'ADM-01', summary: 'Gửi lại email mời' },
      handler: async (req) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        await assertManages(req, id);
        const user = await Models.User.findById(id).select({ email: 1, status: 1, invite: 1 }).lean();
        if (!user) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        const inv = (user as { invite?: InviteShape }).invite ?? {};
        const seed = newInviteSeed();
        const expires = inviteExpiresAt(DEFAULT_INVITE_DAYS);
        await Models.User.updateOne(
          { _id: id },
          {
            $set: {
              'invite.seed': seed,
              'invite.expires_at': expires,
              'invite.revoked_at': null,
              'invite.sent_at': new Date(),
              'invite.send_count': Number(inv.send_count ?? 0) + 1,
              'invite.regenerate_count': Number(inv.regenerate_count ?? 0) + 1,
            },
          },
        ).exec();
        const link = currentInviteLink(id, { seed, expires_at: expires })!;
        const company = await Models.Company.findById(String(inv.company_id ?? '')).select({ name: 1 }).lean();
        void sendMail({
          to: String(user.email),
          subject: `Gửi lại: mời bạn tham gia ${company?.name ?? 'FinGate'}`,
          html: mailTemplates.invite({
            name: String(user.email).split('@')[0] ?? '',
            company: String(company?.name ?? ''),
            roleLabel: ROLE_LABEL[(inv.role ?? 'staff') as Role] ?? '',
            href: link.url.replace(getEnv().PUBLIC_URL.replace(/\/$/, ''), ''),
            inviter: actor.name,
            days: DEFAULT_INVITE_DAYS,
          }),
          urgent: true,
        });
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'hr.invite_resend',
          subject: { type: 'user', id, code: maskEmail(String(user.email)) },
          company_id: inv.company_id ? String(inv.company_id) : null,
          ip: requestCtx(req).ip,
        });
        return { data: { ok: true, send_count: Number(inv.send_count ?? 0) + 1, invite_url: link.url, expires_at: link.expires_at } };
      },
    }),
  );

  /** Ngừng hoạt động = khoá + thu hồi phiên NGAY, không xoá vật lý (§XXIX.4). */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/personnel/:id/deactivate',
      config: { perms: ['hr:disable'] as Permission[], screen: 'ADM-01', stepUp: true, summary: 'Ngừng hoạt động nhân sự' },
      schema: { tags: ['personnel'], body: personnelDeactivateBodySchema },
      handler: async (req) => {
        const actor = requireActor(req);
        const body = validate(personnelDeactivateBody, req.body);
        const { id } = req.params as { id: string };
        if (id === actor.user_id) throw new ApiError({ code: 'FG-RBAC-001', detail: 'Không thể tự ngừng hoạt động tài khoản của mình' });

        const held = await Models.Document.countDocuments({
          status: { $in: [...DECISION_STATUSES] },
          'approval.steps': { $elemMatch: { user_id: id, state: { $in: ['current', 'waiting'] } } },
        } as never);
        if (held > 0 && !body.replacement_user_id) {
          throw new ApiError({
            code: 'FG-HR-003',
            detail: `${held} hồ sơ đang chờ người này duyệt — chỉ định người thay thế trước khi ngừng hoạt động`,
            data: { holding_docs: held, need_replacement: true },
          });
        }
        if (body.replacement_user_id) {
          const repl = await Models.User.findOne({ _id: body.replacement_user_id, status: 'active' }).lean();
          if (!repl) throw new ApiError({ code: 'FG-VAL-001', errors: { replacement_user_id: 'Người thay thế không hợp lệ' } });
          await Models.Document.updateMany(
            { status: { $in: [...DECISION_STATUSES] }, 'approval.steps.user_id': id } as never,
            { $set: { 'approval.steps.$[s].user_id': body.replacement_user_id } },
            { arrayFilters: [{ 's.user_id': id, 's.state': { $in: ['current', 'waiting'] } }] } as never,
          ).exec();
        }

        await Models.User.updateOne(
          { _id: id },
          { $set: { status: 'deactivated', deactivated_at: new Date(), deactivated_reason: body.reason, updated_at: new Date() } },
        ).exec();
        await Models.Assignment.updateMany({ user_id: id, status: 'active' } as never, { $set: { status: 'ended', valid_to: new Date() } }).exec();
        await revokeAllUserSessions(id, 'ngừng hoạt động nhân sự');
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'hr.deactivate',
          subject: { type: 'user', id, code: null },
          company_id: actor.company_id,
          diff_fields: { reason: body.reason, replacement: body.replacement_user_id ?? null, reassigned: held },
          ip: requestCtx(req).ip,
        });
        return { data: { ok: true, reassigned_documents: held } };
      },
    }),
  );

  /** Chuyển công ty: quyền ở A chấm dứt từ thời điểm hiệu lực, lịch sử ở A bảo toàn (§XXIX.4). */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/personnel/:id/transfer',
      config: { perms: ['hr:transfer'] as Permission[], screen: 'ADM-01', summary: 'Chuyển nhân sự giữa công ty' },
      schema: { tags: ['personnel'], body: personnelTransferBodySchema },
      handler: async (req) => {
        const actor = requireActor(req);
        const body = validate(personnelTransferBody, req.body);
        const { id } = req.params as { id: string };
        await assertManages(req, id);
        const held = await Models.Document.countDocuments({
          status: { $in: [...DECISION_STATUSES] },
          'approval.steps': { $elemMatch: { user_id: id, state: { $in: ['current', 'waiting'] } } },
        } as never);
        if (held > 0 && !body.replacement_user_id) {
          throw new ApiError({ code: 'FG-HR-003', detail: `${held} hồ sơ đang chờ người này — chỉ định người thay thế trước khi chuyển`, data: { holding_docs: held } });
        }
        if (body.replacement_user_id) {
          await Models.Document.updateMany(
            { status: { $in: [...DECISION_STATUSES] }, 'approval.steps.user_id': id } as never,
            { $set: { 'approval.steps.$[s].user_id': body.replacement_user_id } },
            { arrayFilters: [{ 's.user_id': id }] } as never,
          ).exec();
        }
        const effectiveAt = new Date(`${body.effective_from}T00:00:00Z`);
        await Models.Assignment.updateMany({ user_id: id, status: 'active' } as never, { $set: { status: 'ended', valid_to: effectiveAt } }).exec();
        await Models.Assignment.create({
          user_id: id,
          company_id: body.to_company_id,
          department_id: body.department_id ?? null,
          role: body.role ?? actor.role,
          amount_limit_minor: 0n,
          valid_from: effectiveAt,
        } as never);
        await revokeAllUserSessions(id, 'chuyển công ty');
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'hr.transfer',
          subject: { type: 'user', id, code: null },
          company_id: body.to_company_id,
          diff_fields: { to_company_id: body.to_company_id, effective_from: body.effective_from, reason: body.reason },
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        return { data: { ok: true, effective_from: body.effective_from } };
      },
    }),
  );

  /** APPR-04 — ủy quyền phê duyệt (Giám đốc đi công tác). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/delegations',
      config: { perms: ['doc:read'] as Permission[], screen: 'APPR-04', summary: 'Danh sách ủy quyền' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const rows = await Models.Delegation.find({
          $or: [{ user_id: actor.user_id }, { to_user_id: actor.user_id }],
        } as never)
          .sort({ valid_from: -1 })
          .limit(100)
          .lean();
        const ids = [...new Set(rows.flatMap((r) => [String(r.user_id), String(r.to_user_id)]))];
        const users = await Models.User.find({ _id: { $in: ids } as never }).select({ display_name: 1, email: 1 }).lean();
        const umap = new Map(users.map((u) => [String(u._id), String(u.display_name ?? u.email)]));
        const now = new Date();
        return ok(
          reply,
          {
            items: rows.map((r) => ({
              _id: String(r._id),
              from_user_id: String(r.user_id),
              from_name: umap.get(String(r.user_id)) ?? '',
              to_user_id: String(r.to_user_id),
              to_name: umap.get(String(r.to_user_id)) ?? '',
              role: (r as { role?: string | null }).role ?? null,
              valid_from: String((r as { valid_from?: Date }).valid_from ?? '').slice(0, 10),
              valid_to: String((r as { valid_to?: Date }).valid_to ?? '').slice(0, 10),
              reason: String((r as { reason?: string }).reason ?? ''),
              status: (r as { status?: string }).status === 'revoked' ? 'revoked' : now > new Date(String((r as { valid_to?: Date }).valid_to)) ? 'expired' : now < new Date(String((r as { valid_from?: Date }).valid_from)) ? 'scheduled' : 'active',
            })),
          },
          { maxAge: 15 },
        );
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/delegations',
      config: { perms: ['approval:act'] as Permission[], screen: 'APPR-04', summary: 'Tạo ủy quyền' },
      schema: { tags: ['personnel'], body: delegationBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(delegationBody, req.body);
        if (body.to_user_id === actor.user_id) throw new ApiError({ code: 'FG-VAL-001', errors: { to_user_id: 'Không thể ủy quyền cho chính mình' } });
        if (body.valid_to < body.valid_from) throw new ApiError({ code: 'FG-VAL-001', errors: { valid_to: 'Ngày kết thúc phải sau ngày bắt đầu' } });
        const to = await Models.User.findOne({ _id: body.to_user_id, status: 'active' }).lean();
        if (!to) throw new ApiError({ code: 'FG-VAL-001', errors: { to_user_id: 'Người nhận không hợp lệ' } });

        // không cho trùng khoảng ủy quyền của cùng cặp + vai trò
        const overlap = await Models.Delegation.findOne({
          user_id: actor.user_id,
          to_user_id: body.to_user_id,
          status: 'active',
          valid_from: { $lte: new Date(`${body.valid_to}T23:59:59Z`) },
          valid_to: { $gte: new Date(`${body.valid_from}T00:00:00Z`) },
        } as never).lean();
        if (overlap) throw new ApiError({ code: 'FG-VAL-001', errors: { valid_from: 'Đã có ủy quyền trùng khoảng thời gian này' } });

        // người được ủy phải là cấp duyệt có hạn mức phù hợp (§XXIX)
        const toAssignments = await Models.Assignment.find({ user_id: body.to_user_id, status: 'active' } as never).select({ role: 1, amount_limit_minor: 1 }).lean();
        const role = body.role ?? actor.role;
        const qualified = toAssignments.find((a) => String(a.role) === role);
        if (!qualified) throw new ApiError({ code: 'FG-VAL-001', errors: { role: 'Người được ủy không giữ chức danh này trong cùng công ty' } });
        if (BigInt(String(qualified.amount_limit_minor ?? '0')) < actor.amount_limit_minor) {
          throw new ApiError({ code: 'FG-RBAC-012', detail: 'Không ủy quyền được cấp duyệt vượt hạn mức của người nhận' });
        }

        const created = await Models.Delegation.create({
          user_id: actor.user_id,
          to_user_id: body.to_user_id,
          company_id: actor.company_id,
          role: body.role ?? null,
          valid_from: new Date(`${body.valid_from}T00:00:00Z`),
          valid_to: new Date(`${body.valid_to}T23:59:59Z`),
          reason: body.reason,
        } as never);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'delegation.create',
          subject: { type: 'delegation', id: String(created._id), code: null },
          company_id: actor.company_id,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { _id: String(created._id) } }, { status: 201 });
      },
    }),
  );

  /* ============================== ADM-04: MATRIX ============================== */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/admin/matrix',
      config: { perms: ['admin:matrix'] as Permission[], screen: 'ADM-04', summary: 'Approval Matrix' },
      handler: async (_req, reply) => {
        const rows = await Models.ApprovalMatrix.find({}).sort({ doc_kind: 1, amount_min_minor: 1 }).lean();
        const companies = await Models.Company.find({}).select({ name: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
        return ok(
          reply,
          {
            items: rows.map((r) => ({
              _id: String(r._id),
              company_id: r.company_id ? String(r.company_id) : null,
              company_name: r.company_id ? (cmap.get(String(r.company_id)) ?? '') : 'Toàn tập đoàn',
              doc_kind: String((r as { doc_kind?: string }).doc_kind),
              category_id: (r as { category_id?: unknown }).category_id ? String((r as { category_id: unknown }).category_id) : null,
              amount_min_minor: String((r as { amount_min_minor?: unknown }).amount_min_minor ?? '0'),
              amount_max_minor: (r as { amount_max_minor?: unknown }).amount_max_minor ? String((r as { amount_max_minor: unknown }).amount_max_minor) : null,
              currency: String((r as { currency?: string }).currency ?? 'VND'),
              steps: ((r as { steps?: { order: number; role: string; sla_hours?: number; mandatory?: boolean }[] }).steps ?? []).map((s) => ({
                order: s.order,
                role: s.role,
                role_label: ROLE_LABEL[s.role as Role] ?? s.role,
                sla_hours: s.sla_hours ?? 24,
                mandatory: s.mandatory !== false,
              })),
              version: Number((r as { version?: number }).version ?? 1),
              effective_from: String((r as { effective_from?: Date }).effective_from ?? '').slice(0, 10),
              label: (r as { label?: string | null }).label ?? null,
              active: Boolean((r as { active?: boolean }).active),
            })),
          },
          { maxAge: 30 },
        );
      },
    }),
  );

  /** Lưu matrix: version++, snapshot cũ vẫn nằm trong hồ sơ đang đi dở (§9.1). */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/matrix',
      config: { perms: ['admin:matrix'] as Permission[], screen: 'ADM-04', summary: 'Tạo/cập nhật ngưỡng duyệt' },
      schema: { tags: ['admin'], body: matrixUpsertBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(matrixUpsertBody, req.body);
        assertMatrixSteps(body.steps.map((s) => ({ order: s.order, role: s.role as Role, sla_hours: s.sla_hours, mandatory: s.mandatory })));
        if (body.company_id) await assertCompanyAccess(req, body.company_id);

        const existing = await Models.ApprovalMatrix.findOne({
          company_id: body.company_id ?? null,
          doc_kind: body.doc_kind,
          category_id: body.category_id ?? null,
          amount_min_minor: BigInt(body.amount_min_minor) as never,
          active: true,
        } as never).lean();

        if (existing) {
          await Models.ApprovalMatrix.updateOne(
            { _id: String((existing as { _id: unknown })._id) },
            {
              $set: {
                steps: body.steps,
                amount_max_minor: body.amount_max_minor ? BigInt(body.amount_max_minor) : null,
                currency: body.currency,
                effective_from: new Date(`${body.effective_from}T00:00:00Z`),
                updated_at: new Date(),
              },
              $inc: { version: 1 },
            },
          ).exec();
          await mirrorAudit({
            at: new Date(),
            actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
            action: 'matrix.update',
            subject: { type: 'approval_matrix', id: String((existing as { _id: unknown })._id), code: body.doc_kind },
            company_id: body.company_id ?? null,
            diff_fields: { steps: body.steps.map((s) => s.role).join(' → ') },
            ip: requestCtx(req).ip,
          });
          return { data: { _id: String((existing as { _id: unknown })._id), version: Number((existing as { version?: number }).version ?? 1) + 1, updated: true } };
        }

        const created = await Models.ApprovalMatrix.create({
          company_id: body.company_id ?? null,
          doc_kind: body.doc_kind,
          category_id: body.category_id ?? null,
          amount_min_minor: BigInt(body.amount_min_minor),
          amount_max_minor: body.amount_max_minor ? BigInt(body.amount_max_minor) : null,
          currency: body.currency,
          steps: body.steps,
          version: 1,
          effective_from: new Date(`${body.effective_from}T00:00:00Z`),
        } as never);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'matrix.create',
          subject: { type: 'approval_matrix', id: String(created._id), code: body.doc_kind },
          company_id: body.company_id ?? null,
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { _id: String(created._id), version: 1 } }, { status: 201 });
      },
    }),
  );

  /* ============================== ADM-06/07/08 ============================== */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/companies',
      config: { perms: 'public', screen: 'ADM-06', summary: 'Danh sách công ty trong phạm vi' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const rows = scope.companyIds === null
          ? await Models.Company.find({}).sort({ code: 1 }).lean()
          : await Models.Company.find({ _id: { $in: scope.companyIds as never } }).sort({ code: 1 }).lean();
        return ok(
          reply,
          {
            items: rows.map((c) => ({
              _id: String(c._id),
              name: String(c.name),
              code: String(c.code),
              tax_code: actorCanSeeTax(req) ? ((c as { tax_code?: string | null }).tax_code ?? null) : null,
              is_group: Boolean((c as { is_group?: boolean }).is_group),
              min_balance: wire(asBigInt((c as { min_balance_minor?: unknown }).min_balance_minor)),
              status: String((c as { status?: string }).status ?? 'active'),
              working_calendar: (c as { working_calendar?: unknown }).working_calendar ?? null,
            })),
          },
        );
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/companies',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-06', summary: 'Tạo/sửa công ty' },
      schema: { tags: ['admin'], body: companyUpsertBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(companyUpsertBody, req.body);
        const minBalance = BigInt(body.min_balance_minor);
        const existing = await Models.Company.findOne({ code: body.code }).lean();
        if (existing && minBalance !== asBigInt((existing as { min_balance_minor?: unknown }).min_balance_minor)) {
          // đổi ngưỡng min balance là hành động nhạy cảm — ảnh hưởng mọi cảnh báo dòng tiền (Q-02)
          if (!actor.permissions.includes('admin:settings')) throw new ApiError({ code: 'FG-RBAC-001' });
        }
        if (existing) {
          await Models.Company.updateOne(
            { _id: String((existing as { _id: unknown })._id) },
            { $set: { ...body, min_balance_minor: minBalance, updated_at: new Date() } },
          ).exec();
          await mirrorAudit({
            at: new Date(),
            actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
            action: 'company.update',
            subject: { type: 'company', id: String((existing as { _id: unknown })._id), code: body.code },
            company_id: String((existing as { _id: unknown })._id),
            diff_fields: { min_balance_minor: minBalance.toString(), status: body.status },
            ip: requestCtx(req).ip,
          });
          return { data: { _id: String((existing as { _id: unknown })._id), updated: true } };
        }
        const created = await Models.Company.create({ ...body, min_balance_minor: minBalance } as never);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'company.create',
          subject: { type: 'company', id: String(created._id), code: body.code },
          company_id: String(created._id),
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { _id: String(created._id) } }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/departments',
      config: { perms: 'public', screen: 'ADM-07', summary: 'Bộ phận theo công ty' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = (req.query ?? {}) as { company_id?: string };
        // scope_all (chairman/admin): mặc định xem MỌI công ty; truyền company_id mới lọc 1 công ty.
        if (q.company_id && scope.companyIds !== null && !scope.companyIds.includes(q.company_id)) {
          throw new ApiError({ code: 'FG-RBAC-002' });
        }
        const filter = q.company_id ? { company_id: q.company_id } : withScopeFilter(scope);
        const rows = await Models.Department.find(filter as never).sort({ name: 1 }).lean();
        return ok(reply, { items: rows.map((d) => ({ _id: String(d._id), company_id: String(d.company_id), name: String(d.name), code: (d as { code?: string | null }).code ?? null, parent_id: (d as { parent_id?: unknown }).parent_id ? String((d as { parent_id: unknown }).parent_id) : null, active: Boolean((d as { active?: boolean }).active) })) });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/departments',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-07', summary: 'Tạo/sửa bộ phận' },
      schema: { tags: ['admin'], body: departmentUpsertBodySchema },
      handler: async (req, reply) => {
        const body = validate(departmentUpsertBody, req.body);
        await assertCompanyAccess(req, body.company_id);
        const created = await Models.Department.create(body as never);
        return ok(reply, { data: { _id: String(created._id) } }, { status: 201 });
      },
    }),
  );

  /** ADM-07 — ngừng dùng bộ phận: ẩn khỏi danh sách chọn khi mời nhân sự, giữ nguyên hồ sơ cũ. */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/departments/:id/deactivate',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-07', summary: 'Ngừng dùng bộ phận' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const dept = await Models.Department.findById(id).lean();
        if (!dept) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy bộ phận' });
        await assertCompanyAccess(req, String((dept as { company_id: unknown }).company_id));
        await Models.Department.updateOne({ _id: id }, { $set: { active: false } } as never).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'department.deactivate',
          subject: { type: 'department', id, code: String((dept as { name?: unknown }).name ?? '') },
          company_id: String((dept as { company_id: unknown }).company_id),
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /** ADM-07 — dùng lại bộ phận đã ngừng. */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/departments/:id/activate',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-07', summary: 'Dùng lại bộ phận' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const dept = await Models.Department.findById(id).lean();
        if (!dept) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy bộ phận' });
        await assertCompanyAccess(req, String((dept as { company_id: unknown }).company_id));
        await Models.Department.updateOne({ _id: id }, { $set: { active: true } } as never).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'department.activate',
          subject: { type: 'department', id, code: String((dept as { name?: unknown }).name ?? '') },
          company_id: String((dept as { company_id: unknown }).company_id),
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /**
   * ADM-07 — xoá bộ phận: chỉ xoá vật lý khi CHƯA từng được tham chiếu; nếu đã có
   * nhân sự/hồ sơ/ngân sách/khoản định kỳ/lời mời/danh mục con thì trả FG-ORG-001 (§XXIX.4).
   */
  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/admin/departments/:id',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-07', summary: 'Xoá bộ phận chưa dùng' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        if (!mongoose.isValidObjectId(id)) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy bộ phận' });
        const dept = await Models.Department.findById(id).lean();
        if (!dept) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy bộ phận' });
        const companyId = String((dept as { company_id: unknown }).company_id);
        await assertCompanyAccess(req, companyId);

        const eid = new mongoose.Types.ObjectId(id);
        const [personnel, documents, budgets, recurring, invites, children] = await Promise.all([
          Models.Assignment.countDocuments({ department_id: eid } as never),
          Models.Document.countDocuments({ department_id: eid } as never),
          Models.Budget.countDocuments({ 'lines.department_id': eid } as never),
          Models.RecurringRule.countDocuments({ department_id: eid } as never),
          Models.User.countDocuments({ 'invite.department_id': eid } as never),
          Models.Department.countDocuments({ parent_id: eid } as never),
        ]);
        const used = personnel + documents + budgets + recurring + invites + children;
        if (used > 0) {
          throw new ApiError({
            code: 'FG-ORG-001',
            detail: 'Bộ phận đã được dùng — hãy "Ngừng dùng" thay vì xoá để bảo toàn hồ sơ cũ',
            data: { personnel, documents, budgets, recurring, invites, children },
          });
        }

        await Models.Department.deleteOne({ _id: id } as never).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'department.delete',
          subject: { type: 'department', id, code: String((dept as { name?: unknown }).name ?? '') },
          company_id: companyId,
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /** ADM-08 — danh mục + chứng từ bắt buộc theo loại (Q-04). Đang dùng cho hồ sơ → chỉ ẩn, không xóa. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/admin/categories',
      config: { perms: 'public', screen: 'ADM-08', summary: 'Danh mục khoản chi/thu' },
      handler: async (_req, reply) => {
        const rows = await Models.Category.find({}).sort({ doc_kind: 1, order: 1 }).lean();
        const usage = await Models.Document.aggregate([{ $match: { category_id: { $exists: true, $ne: null } } }, { $group: { _id: '$category_id', n: { $sum: 1 } } }]) as unknown as { _id: unknown; n: number }[];
        const umap = new Map(usage.map((u) => [String(u._id), Number(u.n)]));
        return ok(
          reply,
          {
            items: rows.map((c) => ({
              _id: String(c._id),
              name: String(c.name),
              code: (c as { code?: string | null }).code ?? null,
              group: String((c as { group?: string }).group ?? 'khac'),
              doc_kind: String((c as { doc_kind?: string }).doc_kind ?? 'spend'),
              required_evidence: ((c as { required_evidence?: string[] }).required_evidence ?? []) as string[],
              requires_budget: Boolean((c as { requires_budget?: boolean }).requires_budget),
              active: Boolean((c as { active?: boolean }).active),
              order: Number((c as { order?: number }).order ?? 0),
              usage_count: umap.get(String(c._id)) ?? 0,
            })),
          },
        );
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/categories',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-08', summary: 'Tạo/sửa danh mục' },
      schema: { tags: ['admin'], body: categoryUpsertBodySchema },
      handler: async (req, reply) => {
        const body = validate(categoryUpsertBody, req.body);
        const created = await Models.Category.create(body as never);
        return ok(reply, { data: { _id: String(created._id) } }, { status: 201 });
      },
    }),
  );

  /** Chỉ ẩn, không xoá khi đã có hồ sơ tham chiếu. */
  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/admin/categories/:id',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-08', summary: 'Ẩn/cập nhật danh mục' },
      handler: async (req) => {
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as Record<string, unknown>;
        if (body.active === false) {
          const used = await Models.Document.countDocuments({ category_id: id } as never);
          if (used > 0) {
            // cho phép ẩn (không phá lịch sử) nhưng không cho xoá
            delete body.name;
          }
        }
        await Models.Category.updateOne({ _id: id } as never, { $set: body }).exec();
        return { data: { ok: true } };
      },
    }),
  );

  /* ============================ CHI ĐỊNH KỲ (§XVII) ============================ */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/admin/recurring',
      config: { perms: ['doc:read'] as Permission[], screen: 'CHI-08', summary: 'Khoản chi định kỳ' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const rows = await Models.RecurringRule.find(withScopeFilter(scope) as never).select({ company_id: 1, title: 1, category_id: 1, amount_minor: 1, cadence: 1, day_of_period: 1, remind_days: 1, next_date: 1, last_document_id: 1, status: 1 }).lean();
        const companies = await Models.Company.find({}).select({ name: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
        const cats = await Models.Category.find({}).select({ name: 1 }).lean();
        const catmap = new Map(cats.map((c) => [String(c._id), String(c.name)]));
        const items = rows.map((r) => {
          const next = nextOccurrence(r as unknown as RecurringShape);
          const days = next ? Math.ceil((new Date(`${next}T00:00:00Z`).getTime() - Date.now()) / 86_400_000) : 999;
          return {
            _id: String(r._id),
            company_id: String(r.company_id),
            company_name: cmap.get(String(r.company_id)) ?? '',
            title: String(r.title),
            category_name: r.category_id ? (catmap.get(String(r.category_id)) ?? null) : null,
            amount: wire(asBigInt(r.amount_minor)),
            cadence: String(r.cadence),
            cadence_label: cadenceLabel(String(r.cadence)),
            next_date: next,
            days_until: days,
            remind_in: (r.remind_days as number[] | undefined) ?? [7, 3, 1],
            last_document_code: null as string | null,
            status: String(r.status ?? 'active'),
            progress_percent: next && days <= 7 ? Math.max(0, Math.min(100, 100 - Math.round((days / 7) * 100))) : 0,
          };
        });
        return ok(reply, { items }, { maxAge: 30 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/recurring',
      config: { perms: ['doc:create'] as Permission[], screen: 'CHI-09', summary: 'Tạo/sửa khoản chi định kỳ' },
      schema: { tags: ['admin'], body: recurringUpsertBodySchema },
      handler: async (req, reply) => {
        const body = validate(recurringUpsertBody, req.body);
        await assertCompanyAccess(req, body.company_id);
        const payload = {
          company_id: body.company_id,
          title: body.title,
          purpose: body.purpose,
          category_id: body.category_id ?? null,
          department_id: body.department_id ?? null,
          payee: body.payee,
          amount_minor: BigInt(body.amount.amount_minor),
          currency: body.amount.currency,
          source: { fund: body.source.fund, account_id: body.source.account_id ?? null },
          cadence: body.cadence,
          day_of_period: body.day_of_period,
          remind_days: body.remind_days,
          effective_from: body.effective_from,
          effective_to: body.effective_to ?? null,
          auto_create_draft: body.auto_create_draft,
          status: body.status,
        };
        const created = await Models.RecurringRule.create(payload as never);
        return ok(reply, { data: { _id: String(created._id), preview: previewOccurrences(payload, 12) } }, { status: 201 });
      },
    }),
  );

  /* ============================== CASH-04: BUDGET ============================== */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/admin/budgets',
      config: { perms: ['budget:read'] as Permission[], screen: 'CASH-04', summary: 'Ngân sách theo bộ phận/loại' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const rows = await Models.Budget.find(withScopeFilter(scope) as never).sort({ period_start: -1 }).limit(100).lean();
        const companies = await Models.Company.find({}).select({ name: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
        const depts = await Models.Department.find({}).select({ name: 1 }).lean();
        const dmap = new Map(depts.map((d) => [String(d._id), String(d.name)]));
        const cats = await Models.Category.find({}).select({ name: 1 }).lean();
        const catmap = new Map(cats.map((c) => [String(c._id), String(c.name)]));
        const items = [];
        for (const b of rows) {
          const used = await budgetUsed(String(b._id));
          const limit = asBigInt(b.limit_minor);
          items.push({
            _id: String(b._id),
            company_id: String(b.company_id),
            company_name: cmap.get(String(b.company_id)) ?? '',
            period: String(b.period),
            period_start: String(b.period_start),
            period_label: periodLabel(String(b.period), String(b.period_start)),
            limit: wire(limit),
            used: wire(used),
            percent: limit > 0n ? Number((used * 10_000n) / limit) / 100 : 0,
            over: limit > 0n && used > limit,
            lines: ((b.lines as { _id?: unknown; label?: string; limit_minor?: unknown; used_minor?: unknown; department_id?: unknown; category_id?: unknown }[] | undefined) ?? []).map((l) => ({
              line_id: String(l._id ?? ''),
              label: String(l.label ?? ''),
              department_name: l.department_id ? (dmap.get(String(l.department_id)) ?? null) : null,
              category_name: l.category_id ? (catmap.get(String(l.category_id)) ?? null) : null,
              limit: wire(asBigInt(l.limit_minor)),
              used: wire(asBigInt(l.used_minor)),
              percent: asBigInt(l.limit_minor) > 0n ? Number((asBigInt(l.used_minor) * 10_000n) / asBigInt(l.limit_minor)) / 100 : 0,
              over: asBigInt(l.limit_minor) > 0n && asBigInt(l.used_minor) > asBigInt(l.limit_minor),
            })),
          });
        }
        return ok(reply, { items }, { maxAge: 30 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/budgets',
      config: { perms: ['budget:write'] as Permission[], screen: 'CASH-04', summary: 'Tạo/sửa ngân sách' },
      schema: { tags: ['admin'], body: { type: 'object' } },
      handler: async (req, reply) => {
        const body = validate(budgetUpsertBody, req.body);
        await assertCompanyAccess(req, body.company_id);
        const created = await Models.Budget.create({
          company_id: body.company_id,
          period: body.period,
          period_start: body.period_start,
          limit_minor: BigInt(body.limit.amount_minor),
          lines: (body.lines ?? []).map((l) => ({
            label: l.label,
            category_id: l.category_id ?? null,
            department_id: l.department_id ?? null,
            limit_minor: BigInt(l.limit_minor),
            used_minor: 0n,
          })),
        } as never);
        return ok(reply, { data: { _id: String(created._id) } }, { status: 201 });
      },
    }),
  );

  /* ============================== ADM-12/13: AUDIT ============================== */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/audit-log',
      config: { perms: ['audit:read'] as Permission[], screen: 'ADM-12', summary: 'Audit log toàn hệ thống (không có nút xóa)' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(auditLogQuery, req.query);
        const filter: Record<string, unknown> = {};
        if (q.company_id) filter.company_id = q.company_id;
        if (q.actor_user_id) filter['actor.user_id'] = q.actor_user_id;
        if (q.action) filter.action = q.action;
        if (q.subject_type) filter['subject.type'] = q.subject_type;
        if (q.subject_id) filter['subject.id'] = q.subject_id;
        if (q.from || q.to) {
          filter.at = { ...(q.from ? { $gte: new Date(`${q.from}T00:00:00Z`) } : {}), ...(q.to ? { $lte: new Date(`${q.to}T23:59:59Z`) } : {}) };
        }
        if (scope.companyIds !== null) {
          filter.$or = [{ company_id: { $in: scope.companyIds } }, { company_id: null }];
        }
        const rows = await Models.AuditLog.find(filter as never).sort({ at: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean();
        const total = await Models.AuditLog.countDocuments(filter as never);
        return ok(
          reply,
          {
            items: rows.map((r) => ({
              _id: String(r._id),
              at: new Date(String((r as { at?: Date }).at)).toISOString(),
              actor: {
                user_id: (r as { actor?: { user_id?: unknown } }).actor?.user_id ? String((r as { actor: { user_id: unknown } }).actor.user_id) : null,
                name: ((r as { actor?: { name?: string | null } }).actor?.name as string | null) ?? null,
                role: ((r as { actor?: { role?: string | null } }).actor?.role as string | null) ?? null,
              },
              action: String((r as { action?: string }).action),
              subject: {
                type: String((r as { subject?: { type?: string } }).subject?.type),
                id: ((r as { subject?: { id?: string | null } }).subject?.id as string | null) ?? null,
                code: ((r as { subject?: { code?: string | null } }).subject?.code as string | null) ?? null,
              },
              company_id: (r as { company_id?: unknown }).company_id ? String((r as { company_id: unknown }).company_id) : null,
              company_name: null as string | null,
              diff_fields: normaliseDiff((r as { diff_fields?: unknown }).diff_fields),
              ip: ((r as { ip?: string | null }).ip as string | null) ?? null,
              ua: ((r as { ua?: string | null }).ua as string | null) ?? null,
              request_id: ((r as { request_id?: string | null }).request_id as string | null) ?? null,
            })),
            total,
            limit: q.limit,
            page: q.page,
          },
          { maxAge: 0 },
        );
      },
    }),
  );

  /** ADM-13 — phiên đang hoạt động + thu hồi từ xa. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/admin/sessions',
      config: { perms: ['audit:read'] as Permission[], screen: 'ADM-13', summary: 'Log đăng nhập & phiên' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { sessionId } = requestCtx(req);
        const rows = await Models.Session.find({ revoked_at: null, expires_at: { $gt: new Date() } } as never)
          .select({ user_id: 1, ip: 1, ua: 1, created_at: 1, last_seen: 1, expires_at: 1 })
          .sort({ last_seen: -1 })
          .limit(200)
          .lean();
        const users = await Models.User.find({ _id: { $in: [...new Set(rows.map((r) => String(r.user_id)))] } as never }).select({ display_name: 1, email: 1 }).lean();
        const umap = new Map(users.map((u) => [String(u._id), String(u.display_name ?? u.email)]));
        const myIps = new Set(rows.filter((r) => String(r._id) === sessionId).map((r) => String(r.ip)));
        return ok(
          reply,
          {
            items: rows.map((r) => ({
              _id: String(r._id),
              user_id: String(r.user_id),
              user_name: umap.get(String(r.user_id)) ?? '—',
              ip: (r as { ip?: string | null }).ip ?? null,
              ua: ((r as { ua?: string | null }).ua as string | null) ?? null,
              created_at: new Date(String((r as { created_at?: Date }).created_at)).toISOString(),
              last_seen: new Date(String((r as { last_seen?: Date }).last_seen)).toISOString(),
              expires_at: new Date(String((r as { expires_at?: Date }).expires_at)).toISOString(),
              current: String(r._id) === sessionId,
              // phiên bất thường: IP khác với IP hiện tại của chính người xem
              abnormal: Boolean((r as { ip?: string | null }).ip) && !myIps.has(String((r as { ip?: string | null }).ip)) && String(r.user_id) === actor.user_id,
            })),
          },
          { maxAge: 0 },
        );
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/admin/sessions/:id',
      config: { perms: ['hr:disable'] as Permission[], screen: 'ADM-13', stepUp: true, summary: 'Thu hồi phiên từ xa' },
      handler: async (req) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        await Models.Session.updateOne({ _id: id } as never, { $set: { revoked_at: new Date() } }).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'session.revoke',
          subject: { type: 'session', id, code: null },
          ip: requestCtx(req).ip,
        });
        return { data: { ok: true } };
      },
    }),
  );

  /** ADM-13 db-stats — sống với trần 512 MB (§8.7). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/admin/db-stats',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-13', summary: 'Dung lượng DB theo collection' },
      handler: async (_req, reply) => {
        const db = mongoose.connection.db!;
        const stats = (await db.command({ dbStats: 1, scale: 1 })) as { storageSize?: number; indexSize?: number };
        const info = await db.listCollections().toArray();
        const collections: { name: string; count: number; storage_bytes: number; indexes: number }[] = [];
        for (const c of info.slice(0, 30)) {
          const name = String(c.name);
          const count = await db.collection(name).estimatedDocumentCount();
          const cs = (await db.command({ collStats: name })) as { storageSize?: number; numIndexes?: number };
          collections.push({ name, count, storage_bytes: Number(cs.storageSize ?? 0), indexes: Number(cs.numIndexes ?? 0) });
        }
        collections.sort((a, b) => b.storage_bytes - a.storage_bytes);
        const limit = 512 * 1024 * 1024; // trần Atlas M0 — arch §3.4
        const used = Number(stats.storageSize ?? 0) + Number(stats.indexSize ?? 0);
        return ok(
          reply,
          {
            data: {
              database: db.databaseName,
              storage_bytes: Number(stats.storageSize ?? 0),
              index_bytes: Number(stats.indexSize ?? 0),
              limit_bytes: limit,
              usage_percent: Math.round((used / limit) * 1000) / 10,
              collections,
              at: new Date().toISOString(),
            },
          },
          { maxAge: 30 },
        );
      },
    }),
  );

  /* ============================== ADM-10: ALERT RULES ============================== */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/admin/alert-rules',
      config: { perms: ['alert:config'] as Permission[], screen: 'ADM-10', summary: 'Cấu hình 8 loại cảnh báo' },
      handler: async (_req, reply) => {
        const rows = await Models.Alert.find({ type: 'rule' } as never).lean();
        return ok(reply, { items: rows.map(ruleView) }, { maxAge: 30 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/alert-rules',
      config: { perms: ['alert:config'] as Permission[], screen: 'ADM-10', summary: 'Bật/ngưỡng/kênh cảnh báo' },
      schema: { tags: ['admin'], body: { type: 'object' } },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(alertRuleUpsertBody, req.body);
        const created = await Models.Alert.updateOne(
          { type: 'rule', alert_type: body.type, company_id: body.company_id ?? null },
          {
            $set: {
              type: 'rule',
              alert_type: body.type,
              company_id: body.company_id ?? null,
              enabled: body.enabled,
              severity: body.severity,
              threshold: body.threshold,
              channels: body.channels,
              to_roles: body.to_roles,
            },
          },
          { upsert: true },
        ).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'alert_rule.upsert',
          subject: { type: 'alert_rule', id: body.type, code: null },
          company_id: body.company_id ?? null,
          diff_fields: body.threshold,
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true, upserted: created.upsertedCount } }, { status: 201 });
      },
    }),
  );

  /* ============================== ADM-02/11: SETTINGS ============================== */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/admin/settings',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-02', summary: 'Cấu hình hệ thống' },
      handler: async (_req, reply) => {
        const rows = await Models.Setting.find({}).lean();
        return ok(
          reply,
          {
            items: rows
              .filter((r) => !String(r.key).startsWith('newsletter:'))
              .map((r) => ({ key: String(r.key), value: (r as { value?: unknown }).value, description: ((r as { description?: string | null }).description as string | null) ?? null, updated_at: (r as { updated_at?: Date }).updated_at ? new Date(String((r as { updated_at: Date }).updated_at)).toISOString() : null })),
          },
          { maxAge: 30 },
        );
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/admin/settings',
      config: { perms: ['admin:settings'] as Permission[], screen: 'ADM-02', stepUp: true, summary: 'Đổi cấu hình (audit)' },
      schema: { tags: ['admin'], body: settingUpsertBodySchema },
      handler: async (req) => {
        const actor = requireActor(req);
        const body = validate(settingUpsertBody, req.body);
        const before = await Models.Setting.findOne({ key: body.key }).lean();
        await Models.Setting.updateOne(
          { key: body.key },
          { $set: { key: body.key, value: body.value, updated_at: new Date(), updated_by: actor.user_id } },
          { upsert: true },
        ).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'setting.update',
          subject: { type: 'setting', id: body.key, code: null },
          company_id: null,
          diff_fields: { before: (before as { value?: unknown } | null)?.value ?? null, after: body.value },
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        return { data: { ok: true } };
      },
    }),
  );

  /* ============================== EXPORT EXCEL ============================== */

  /** exceljs stream trực tiếp response (K-12) + watermark người xuất; quá trần → job. */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/exports',
      config: { perms: ['report:export'] as Permission[], screen: 'RPT-14', stepUp: true, summary: 'Xuất Excel/CSV' },
      handler: async (req, reply: FastifyReply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const body = validate(exportRequestBody, req.body);
        const preset = body.preset ?? 'thu-chi-ngay';
        const result = await reportPreset(preset, {
          scope,
          from: typeof body.query?.from === 'string' ? body.query.from : undefined,
          to: typeof body.query?.to === 'string' ? body.query.to : undefined,
          groupBy: typeof body.query?.group_by === 'string' ? body.query.group_by : undefined,
          limit: 50_000,
          canExport: true,
        });
        if (result.row_count > getEnv().EXPORT_ROW_LIMIT) {
          // chạy thành job, trả link trên R2 (§6)
          const job = await Models.Job.create({
            name: 'export',
            state: 'queued',
            dedupe_key: `export:${body.request_id}`,
            payload: { preset, query: body.query },
            user_id: actor.user_id,
            company_id: actor.company_id,
          } as never);
          return ok(reply, { data: { job_id: String(job._id), queued: true, rows: result.row_count } }, { status: 202 });
        }

        const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: 'export.xlsx', stream: reply.raw, useSharedStrings: true });
        const ws = wb.addWorksheet(result.title);
        ws.columns = result.columns.map((c) => ({ header: c.label, key: c.key, width: 22 }));
        for (const row of result.rows) ws.addRow(jsonSafe(row) as Record<string, unknown>);
        ws.addRow({});
        ws.addRow({ [result.columns[0]?.key ?? 'note']: `Xuất bởi ${actor.name} · ${new Date().toLocaleString('vi-VN')} · ${result.scope_label}` });
        ws.commit();
        await wb.commit();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'report.export',
          subject: { type: 'report', id: preset, code: `${result.row_count} dòng` },
          company_id: actor.company_id,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        return reply;
      },
    }),
  );
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function withScopeFilter(scope: { companyIds: string[] | null }): Record<string, unknown> {
  return scope.companyIds === null ? {} : { company_id: { $in: scope.companyIds } };
}

function rx(s: string): RegExp {
  return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

function maskEmail(email: string): string {
  const [user, domain] = String(email).split('@');
  if (!domain) return '•••';
  const head = (user ?? '').slice(0, 2);
  return `${head}${'•'.repeat(Math.max(1, (user ?? '').length - 2))}@${domain}`;
}

function actorCanSeeTax(req: FastifyRequest): boolean {
  return requestCtx(req).actor?.permissions.includes('doc:read') ?? false;
}

async function assertManages(req: FastifyRequest, userId: string): Promise<void> {
  const actor = requireActor(req);
  if (actor.scope_all) return;
  const target = await Models.Assignment.findOne({ user_id: userId, company_id: actor.company_id } as never).lean();
  if (!target) throw new ApiError({ code: 'FG-HR-002' });
}

async function assertCompanyAccess(req: FastifyRequest, companyId: string): Promise<void> {
  const { scope } = requestCtx(req);
  if (scope.companyIds === null) return;
  if (!scope.companyIds.includes(companyId)) throw new ApiError({ code: 'FG-RBAC-002' });
}

function normaliseDiff(v: unknown): { field: string; before: unknown; after: unknown }[] {
  if (!v || typeof v !== 'object') return [];
  const out: { field: string; before: unknown; after: unknown }[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val && typeof val === 'object' && ('before' in (val as object) || 'after' in (val as object))) {
      const o = val as { before?: unknown; after?: unknown };
      out.push({ field: k, before: o.before ?? null, after: o.after ?? null });
    } else {
      out.push({ field: k, before: null, after: val });
    }
  }
  return out;
}

function ruleView(r: Record<string, unknown>) {
  return {
    _id: String(r._id),
    type: String(r.alert_type ?? ''),
    type_label: alertLabel(String(r.alert_type ?? '')),
    company_id: r.company_id ? String(r.company_id) : null,
    enabled: Boolean(r.enabled),
    severity: Number(r.severity ?? 2),
    threshold: (r.threshold as Record<string, unknown> | undefined) ?? {},
    channels: (r.channels as string[] | undefined) ?? ['web'],
    to_roles: ((r.to_roles as string[] | undefined) ?? []).map((x) => ROLE_LABEL[x as Role] ?? x),
  };
}

function alertLabel(t: string): string {
  const map: Record<string, string> = {
    approval_overdue: 'Khoản chi chờ duyệt quá lâu',
    loan_maturity: 'Khoản vay sắp đáo hạn',
    low_balance: 'Số dư ngân hàng thấp',
    receivable_overdue: 'Khoản phải thu quá hạn',
    budget_exceeded: 'Khoản chi vượt ngân sách',
    missing_evidence: 'Hồ sơ thiếu chứng từ',
    payment_due: 'Khoản thanh toán đến hạn',
    negative_cashflow: 'Dòng tiền âm',
  };
  return map[t] ?? t;
}

async function budgetUsed(budgetId: string): Promise<bigint> {
  const rows = await Models.Document.aggregate<{ total: unknown }[]>([
    { $match: { 'budget.budget_id': budgetId, kind: 'spend', status: { $ne: 'draft' } } } as never,
    { $group: { _id: null, total: { $sum: '$amount.minor' } } } as never,
  ]);
  return asBigInt((rows as unknown as { total?: unknown }[])[0]?.total ?? 0n);
}

function periodLabel(period: string, start: string): string {
  const [y, m] = start.split('-');
  if (period === 'month') return `Tháng ${m}/${y}`;
  if (period === 'quarter') return `Quý ${Math.ceil(Number(m) / 3)}/${y}`;
  return `Năm ${y}`;
}

interface RecurringShape {
  cadence?: string;
  day_of_period?: number;
  effective_from?: string;
  effective_to?: string | null;
  last_run_period?: string | null;
}

/** Kỳ kế tiếp theo chu kỳ — task `recurring` dùng cùng hàm này để vật phiếu nháp. */
export function nextOccurrence(rule: RecurringShape, from = today()): string | null {
  for (const d of previewOccurrences({ ...rule, effective_from: from } as never, 3)) return d;
  return null;
}

export function previewOccurrences(rule: RecurringShape & { effective_from: string }, n = 12): string[] {
  const out: string[] = [];
  let cursor = new Date(`${rule.effective_from}T00:00:00Z`);
  const day = rule.day_of_period ?? 1;
  const cadence = rule.cadence ?? 'monthly';
  for (let i = 0; i < n * 3 && out.length < n; i++) {
    const iso = cursor.toISOString().slice(0, 10);
    const [, month, dom] = iso.split('-');
    const hit =
      cadence === 'weekly' ? cursor.getUTCDay() === (day % 7) : cadence === 'monthly' ? Number(dom) === Math.min(day, daysInMonth(cursor)) : cadence === 'quarterly' ? Number(dom) === Math.min(day, daysInMonth(cursor)) && (Number(month) - 1) % 3 === 0 : cadence === 'semi_annual' ? Number(dom) === Math.min(day, daysInMonth(cursor)) && (Number(month) - 1) % 6 === 0 : Number(dom) === Math.min(day, daysInMonth(cursor)) && Number(month) === 1;
    if (hit && iso >= rule.effective_from && (!rule.effective_to || iso <= rule.effective_to)) out.push(iso);
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return out;
}

function daysInMonth(d: Date): number {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function cadenceLabel(c: string): string {
  return { weekly: 'Hàng tuần', monthly: 'Hàng tháng', quarterly: 'Hàng quý', semi_annual: 'Nửa năm', annual: 'Hàng năm' }[c] ?? c;
}


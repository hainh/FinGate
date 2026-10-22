/**
 * Nhóm route ĐỐI TÁC — danh bạ theo công ty (v2/v2.md §5, màn PARTNER-01).
 *
 * Route là lớp MỎNG: quyền (config.perms) → phạm vi công ty → zod → domain/partner.
 * · `partner:read` xem danh sách / chi tiết / các tab (kèm quyền của module tương ứng: phiếu, công nợ, nợ NH).
 * · `partner:write` tạo / sửa / ngừng / kích hoạt / xoá / sao chép.
 * · Trả nợ thêm `doc:create` (tạo phiếu nháp) và `link:manage` (tạo liên kết cấn trừ / trả nợ).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ApiError,
  partnerCopyBody,
  partnerCreateBody,
  partnerDuplicateCheckBody,
  partnerSearchQuery,
  partnerUpdateBody,
  type PartnerType,
  type Permission,
} from '@fingate/shared';
import { assertCompanyScope, defineRoute, requestCtx, requireActor, requirePerm, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import {
  partnerCopyBodySchema,
  partnerCreateBodySchema,
  partnerDirectoryQuerySchema,
  partnerDuplicateCheckBodySchema,
  partnerSettleBodySchema,
  partnerTabQuerySchema,
  partnerUpdateBodySchema,
} from './schemas.ts';
import { parseTypeParam, partnerDirectoryQuery, partnerSettleBody, partnerTabQuery } from '../domain/partner/contracts.ts';
import {
  checkPartnerDuplicates,
  copyPartners,
  createPartner,
  deletePartner,
  loadPartner,
  listPartners,
  partnerDebts,
  partnerDetail,
  partnerDocuments,
  partnerLoans,
  partnerOptions,
  partnerRefOf,
  assertPartnerInScope,
  historyOf,
  setPartnerStatus,
  updatePartner,
} from '../domain/partner/index.ts';
import { settlePartner } from '../domain/partner/settle.ts';
import { resolvePeriod, summaryVisibilityOf } from '../domain/partner/summary.ts';

const SCREEN = 'PARTNER-01';

/** Công ty để ĐỌC: `company_id` (phải trong phạm vi) hoặc phạm vi hiện tại (null = toàn tập đoàn). */
export function readCompanyIds(req: FastifyRequest, companyId: string | undefined): string[] | null {
  if (companyId) {
    assertCompanyScope(req, companyId);
    return [companyId];
  }
  return requireScope(req).companyIds;
}

/** Công ty để GHI: `company_id` của body hoặc công ty đang làm việc; phải nằm trong phạm vi. */
export function writeCompanyId(req: FastifyRequest, bodyCompanyId: string | undefined): string {
  const companyId = bodyCompanyId ?? requireActor(req).company_id;
  if (!companyId) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Chưa chọn công ty' });
  assertCompanyScope(req, companyId);
  return companyId;
}

function actorOf(req: FastifyRequest) {
  const a = requireActor(req);
  return { user_id: a.user_id, name: a.name ?? null, role: a.role ?? null, department_id: a.department_id ?? null };
}

export function partnerRoutes(app: FastifyInstance): void {
  /* ------------------------------ danh sách / chọn ------------------------------ */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/partners',
      config: { perms: ['partner:read'] as Permission[], screen: SCREEN, summary: 'Danh bạ đối tác + số liệu tóm tắt (phân trang, kỳ thu/chi)' },
      schema: { tags: ['partners'], querystring: partnerDirectoryQuerySchema },
      handler: async (req, reply) => {
        const raw = (req.query ?? {}) as Record<string, unknown>;
        const q = validate(partnerDirectoryQuery, { ...raw, type: parseTypeParam(raw.type) });
        const companyIds = readCompanyIds(req, q.company_id);
        const period = resolvePeriod(q.period_from ?? null, q.period_to ?? null);
        const result = await listPartners({
          companyIds,
          type: q.type as PartnerType[] | undefined,
          status: q.status,
          q: q.q,
          limit: q.limit,
          offset: q.offset,
          period,
          visible: summaryVisibilityOf(requireActor(req).permissions),
        });
        return ok(reply, result);
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/partners/options',
      config: {
        perms: [] as Permission[],
        permsAny: ['partner:read', 'doc:read', 'doc:create'] as Permission[],
        screen: SCREEN,
        summary: 'Ô chọn đối tác (tìm theo tên / STK / MST, lọc loại; mặc định đang hoạt động)',
      },
      schema: { tags: ['partners'] },
      handler: async (req, reply) => {
        const raw = (req.query ?? {}) as Record<string, unknown>;
        const q = validate(partnerSearchQuery, { ...raw, type: parseTypeParam(raw.type) });
        const companyId = writeCompanyId(req, q.company_id);
        const type = q.type === undefined ? undefined : Array.isArray(q.type) ? q.type : [q.type];
        const codes = q.codes
          ? q.codes
              .split(',')
              .map((c) => c.trim().toUpperCase())
              .filter(Boolean)
              .slice(0, 1000)
          : undefined;
        const items = await partnerOptions({ companyIds: [companyId], type, status: q.status, q: q.q, limit: q.limit, codes });
        return ok(reply, { items });
      },
    }),
  );

  /* ------------------------------ kiểm trùng trước khi lưu ------------------------------ */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/partners/check-duplicates',
      config: { perms: ['partner:write'] as Permission[], screen: SCREEN, summary: 'Kiểm trùng tên / (NH, STK) trước khi lưu — chỉ đọc, không chặn' },
      schema: { tags: ['partners'], body: partnerDuplicateCheckBodySchema },
      handler: async (req, reply) => {
        const body = validate(partnerDuplicateCheckBody, req.body);
        const companyId = writeCompanyId(req, body.company_id);
        const warnings = await checkPartnerDuplicates({
          companyId,
          name: body.name,
          bank_name: body.bank_name ?? null,
          account_number: body.account_number ?? null,
          exclude_id: body.exclude_id ?? null,
        });
        return ok(reply, { data: { warnings } });
      },
    }),
  );

  /* ------------------------------ tạo / sao chép / sửa / xoá ------------------------------ */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/partners',
      config: { perms: ['partner:write'] as Permission[], screen: SCREEN, summary: 'Tạo đối tác (cảnh báo trùng, không chặn)' },
      schema: { tags: ['partners'], body: partnerCreateBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(partnerCreateBody, req.body);
        const companyId = writeCompanyId(req, body.company_id);
        const { partner, warnings, replayed } = await createPartner({
          companyId,
          body,
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          ip: requestCtx(req).ip,
          requestId: body.request_id ?? null,
        });
        // replay (cùng request_id): trả lại đúng đối tác đã tạo lần đầu, không tạo thêm
        return ok(reply, { data: { partner, warnings } }, { status: replayed ? 200 : 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/partners/copy',
      config: { perms: ['partner:write'] as Permission[], screen: SCREEN, summary: 'Sao chép đối tác từ công ty khác (bản sao mới, ID riêng)' },
      schema: { tags: ['partners'], body: partnerCopyBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const ctx = requestCtx(req);
        const body = validate(partnerCopyBody, req.body);
        const targetCompanyId = writeCompanyId(req, body.target_company_id);
        // Người dùng chỉ sao chép từ công ty MÌNH xem được: toàn tập đoàn, hoặc công ty được gán.
        const readable = ctx.identity?.scope_all ? null : (ctx.identity?.assignments.map((a) => a.company_id) ?? []);
        const { replayed, ...result } = await copyPartners({
          sourceCompanyId: body.source_company_id,
          targetCompanyId,
          partnerIds: body.partner_ids,
          readableCompanyIds: readable,
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          ip: ctx.ip,
          requestId: body.request_id ?? null,
        });
        return ok(reply, { data: result }, { status: replayed ? 200 : 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/partners/:id',
      config: { perms: ['partner:read'] as Permission[], screen: SCREEN, summary: 'Chi tiết đối tác (tóm tắt + lịch sử)' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const scope = requireScope(req);
        const visible = summaryVisibilityOf(requireActor(req).permissions);
        return ok(reply, { data: await partnerDetail(id, scope.companyIds, visible) });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/partners/:id',
      config: { perms: ['partner:write'] as Permission[], screen: SCREEN, summary: 'Sửa đối tác (ghi lịch sử, chặn đổi loại làm vỡ ràng buộc)' },
      schema: { tags: ['partners'], body: partnerUpdateBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        const body = validate(partnerUpdateBody, req.body);
        const { partner, warnings } = await updatePartner({
          id,
          scopeCompanyIds: scope.companyIds,
          body,
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          ip: requestCtx(req).ip,
          requestId: body.request_id ?? null,
        });
        return ok(reply, { data: { partner: partnerRefOf(partner), warnings } });
      },
    }),
  );

  for (const [suffix, status, summary] of [
    ['deactivate', 'inactive', 'Ngừng giao dịch đối tác (không xoá, giữ lịch sử phiếu)'],
    ['reactivate', 'active', 'Kích hoạt lại đối tác'],
  ] as const) {
    app.route(
      defineRoute({
        method: 'POST',
        url: `/partners/:id/${suffix}`,
        config: { perms: ['partner:write'] as Permission[], screen: SCREEN, summary },
        handler: async (req, reply) => {
          const actor = requireActor(req);
          const scope = requireScope(req);
          const { id } = req.params as { id: string };
          const { partner } = await setPartnerStatus({
            id,
            status,
            scopeCompanyIds: scope.companyIds,
            actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
            ip: requestCtx(req).ip,
          });
          return ok(reply, { data: { partner: partnerRefOf(partner), warnings: [] } });
        },
      }),
    );
  }

  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/partners/:id',
      config: { perms: ['partner:write'] as Permission[], screen: SCREEN, summary: 'Xoá đối tác (chỉ khi chưa phát sinh)' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        await deletePartner({
          id,
          scopeCompanyIds: scope.companyIds,
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /* ------------------------------ tab chi tiết ------------------------------ */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/partners/:id/documents',
      config: { perms: ['partner:read', 'doc:read'] as Permission[], screen: SCREEN, summary: 'Tab Phiếu thu/chi của đối tác' },
      schema: { tags: ['partners'], querystring: partnerTabQuerySchema },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        const p = await loadPartner(id);
        assertPartnerInScope(p.company_id, scope.companyIds);
        const q = validate(partnerTabQuery, req.query ?? {});
        const items = await partnerDocuments(p, { status: q.status, kind: q.kind, limit: q.limit });
        return ok(reply, { items, total: items.length });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/partners/:id/debts',
      config: { perms: ['partner:read', 'debt:read'] as Permission[], screen: SCREEN, summary: 'Tab Công nợ của đối tác (phải thu / phải trả)' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        const p = await loadPartner(id);
        assertPartnerInScope(p.company_id, scope.companyIds);
        const items = await partnerDebts(p);
        return ok(reply, { items, total: items.length });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/partners/:id/loans',
      config: {
        perms: ['partner:read'] as Permission[],
        permsAny: ['loan:read', 'bank:read'] as Permission[],
        screen: SCREEN,
        summary: 'Tab Nợ ngân hàng của đối tác (dư nợ, đáo hạn)',
      },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        const p = await loadPartner(id);
        assertPartnerInScope(p.company_id, scope.companyIds);
        const items = await partnerLoans(p);
        return ok(reply, { items, total: items.length });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/partners/:id/history',
      config: { perms: ['partner:read'] as Permission[], screen: SCREEN, summary: 'Tab Lịch sử đối tác (ai, khi nào, trước → sau)' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        const p = await loadPartner(id);
        assertPartnerInScope(p.company_id, scope.companyIds);
        const items = historyOf(p);
        return ok(reply, { items, total: items.length });
      },
    }),
  );

  /* ------------------------------ trả nợ ------------------------------ */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/partners/:id/settle',
      config: {
        perms: ['partner:write', 'doc:create', 'link:manage'] as Permission[],
        screen: SCREEN,
        summary: 'Trả nợ: chọn khoản + số tiền → phiếu thu/chi nháp đã gắn liên kết cấn trừ / trả nợ',
      },
      schema: { tags: ['partners'], body: partnerSettleBodySchema },
      handler: async (req, reply) => {
        const actor = actorOf(req);
        const scope = requireScope(req);
        const ctx = requestCtx(req);
        const { id } = req.params as { id: string };
        const body = validate(partnerSettleBody, req.body);
        // Trả nợ ghi công nợ (KH/NCC) hoặc khoản vay NH (ngân hàng): phải có đúng quyền của phần đó (v2 §3.2).
        if (body.items.length) requirePerm(req, 'debt:write');
        if (body.loans.length) requirePerm(req, 'loan:read', 'loan:write');
        const result = await settlePartner(
          {
            partnerId: id,
            items: body.items.map((i) => ({ debt_voucher_id: i.debt_voucher_id, amount_minor: i.amount_minor })),
            loans: body.loans.map((l) => ({ bank_debt_id: l.bank_debt_id, amount_minor: l.amount_minor, split: l.split ?? null })),
            business_date: body.business_date ?? null,
            planned_date: body.planned_date ?? null,
            receipt_account_id: body.receipt_account_id ?? null,
            payment_account_id: body.payment_account_id ?? null,
            note: body.note ?? null,
            request_id: body.request_id ?? null,
          },
          { actor: { ...actor, user_id: actor.user_id }, scopeCompanyIds: scope.companyIds, ip: ctx.ip },
        );
        return ok(reply, { data: result }, { status: result.replayed ? 200 : 201 });
      },
    }),
  );
}

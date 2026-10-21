/**
 * Phiếu công nợ (DEBT) — v2 (v2/v2.md §9):
 *   · Đối tác KH/NCC bắt buộc theo ID; hướng phải thu / phải trả do người dùng chọn.
 *   · TK kế toán suy từ loại đối tác (KH 131, NCC 331). Nhân viên (334) v1: chỉ đọc.
 *   · Cấn trừ = liên kết `offset` trong business_links (phiếu thu ↔ phải thu, phiếu chi ↔ phải trả).
 *   · Đã cấn trừ / còn lại / quá hạn / tuổi nợ: tính khi đọc từ liên kết HIỆU LỰC + trạng thái phiếu.
 * Logic nằm ở `domain/debt/*`; file này chỉ nối HTTP ↔ domain.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { debtListQuery, toJsonSchema, type Permission } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { defineRoute, requestCtx, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { storage } from '../storage/index.ts';
import { mirrorAudit } from '../domain/audit/index.ts';
import { registerOwnerAttachmentRoutes } from './attachment-owner.ts';
import {
  assertDebtDeletable,
  assignOffset,
  createDebt,
  debtAgingMatrix,
  deleteDebtRecord,
  getDebtDetail,
  listDebts,
  loadDebtOrFail,
  offsetCandidates,
  unassignOffset,
  updateDebt,
  type DebtActor,
} from '../domain/debt/debts.ts';
import { debtAgingQuery, debtCreateBody, debtOffsetBody, debtUpdateBody, linkCandidatesQuery, unlinkBody } from '../domain/debt/bodies.ts';

const j = toJsonSchema;

/** Đường dẫn tải chứng từ + cờ đã dẫn chiếu — dùng chung cho công nợ và nợ ngân hàng. */
export function mapOwnerAttachments(list: unknown[] | undefined): Record<string, unknown>[] {
  return (list ?? []).map((raw) => {
    const a = raw as Record<string, unknown>;
    return {
      id: String(a.id),
      type: String(a.type ?? 'other'),
      version: Number(a.version ?? 1),
      filename: String(a.filename ?? ''),
      size: Number(a.size ?? 0),
      mime: String(a.mime ?? ''),
      added_at: a.added_at ? new Date(String(a.added_at)).toISOString() : null,
      added_by: a.added_by ? String(a.added_by) : null,
      download_href: `/api/v1/attachments/${String(a.id)}`,
      referenced: Array.isArray(a.referenced_by) && a.referenced_by.length > 0,
    };
  });
}

function actorOf(req: FastifyRequest): DebtActor {
  const a = requireActor(req);
  return { user_id: a.user_id, name: a.name, role: a.role, company_id: a.company_id };
}

function metaOf(req: FastifyRequest): { ip: string | null; request_id: null } {
  return { ip: requestCtx(req).ip, request_id: null };
}

/** Quyền gán / gỡ cấn trừ: cần quyền ghi công nợ VÀ quyền quản lý liên kết (v2 §3.2). */
const LINK_PERMS: Permission[] = ['debt:write', 'link:manage'];

export function debtRoutes(app: FastifyInstance): void {
  app.route(
    defineRoute({
      method: 'GET',
      url: '/debts',
      config: { perms: ['debt:read'] as Permission[], screen: 'DEBT-01', summary: 'Danh sách phiếu công nợ' },
      schema: { tags: ['debt'], querystring: j(debtListQuery) },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(debtListQuery, req.query);
        const data = await listDebts(scope, {
          party_type: q.party_type,
          partner_id: q.partner_id,
          direction: q.direction,
          side: q.side,
          company_id: q.company_id,
          counterparty: q.counterparty,
          q: q.q,
          overdue_only: q.overdue_only,
          bucket: q.bucket,
          sort: q.sort,
          limit: q.limit,
          page: q.page,
        });
        return ok(reply, data, { maxAge: 15 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/debts/aging',
      config: { perms: ['debt:read'] as Permission[], screen: 'DEBT-05', summary: 'Ma trận tuổi nợ theo đối tác & hướng' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(debtAgingQuery, req.query);
        const data = await debtAgingMatrix(scope, { party_type: q.party_type, direction: q.direction, company_id: q.company_id });
        return ok(reply, { data }, { maxAge: 60 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/debts',
      config: { perms: ['debt:write'] as Permission[], screen: 'DEBT-01', summary: 'Tạo phiếu công nợ (đối tác + hướng bắt buộc)' },
      schema: { tags: ['debt'], body: j(debtCreateBody) },
      handler: async (req, reply) => {
        const body = validate(debtCreateBody, req.body);
        const created = await createDebt(actorOf(req), requireScope(req), body, metaOf(req));
        return ok(reply, { data: created }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/debts/:id',
      config: { perms: ['debt:read'] as Permission[], screen: 'DEBT-02', summary: 'Chi tiết phiếu công nợ' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const detail = await getDebtDetail(requireScope(req), id);
        const { attachments, ...rest } = detail;
        return ok(reply, { data: { ...rest, attachments: mapOwnerAttachments(attachments as unknown[]) } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/debts/:id',
      config: { perms: ['debt:update'] as Permission[], screen: 'DEBT-02', summary: 'Sửa phiếu công nợ' },
      schema: { tags: ['debt'], body: j(debtUpdateBody) },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = validate(debtUpdateBody, req.body);
        await updateDebt(actorOf(req), requireScope(req), id, body, metaOf(req));
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /** Xoá phiếu công nợ (quyền `debt:delete`). Không xoá khoản đã có liên kết cấn trừ hiệu lực. */
  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/debts/:id',
      config: { perms: ['debt:delete'] as Permission[], screen: 'DEBT-02', summary: 'Xoá phiếu công nợ' },
      handler: async (req, reply) => {
        const actor = actorOf(req);
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        const d = await loadDebtOrFail(id);
        await assertDebtDeletable(scope, d);

        // Xoá chứng từ đính kèm (best-effort) — file trên storage + metadata mirror.
        for (const raw of (d.attachments ?? []) as Record<string, unknown>[]) {
          const key = raw.key ? String(raw.key) : '';
          if (key) await storage().remove(key).catch(() => undefined);
        }
        await Models.Attachment.deleteMany({ owner_type: 'debt', owner_id: d._id } as never).exec();
        await deleteDebtRecord(id);

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'debt.delete',
          subject: { type: 'debt', id, code: String(d.code ?? '') },
          company_id: String(d.company_id),
          diff_fields: { party_name: d.party_name ?? null, value_minor: String(d.value_minor ?? '0') },
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /* --------------------------- cấn trừ (business_links · offset) --------------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/debts/:id/links',
      config: { perms: LINK_PERMS, screen: 'DEBT-02', summary: 'Gán phiếu thu/chi để cấn trừ khoản công nợ' },
      schema: { tags: ['debt'], body: j(debtOffsetBody) },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = validate(debtOffsetBody, req.body);
        const link = await assignOffset(actorOf(req), requireScope(req), id, body, metaOf(req));
        return ok(reply, { data: link }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/debts/:id/links/:linkId',
      config: { perms: LINK_PERMS, screen: 'DEBT-02', summary: 'Gỡ liên kết cấn trừ (có lý do)' },
      handler: async (req, reply) => {
        const { id, linkId } = req.params as { id: string; linkId: string };
        // Lý do gỡ BẮT BUỘC (v2 §11.2): lấy từ body đã kiểm (không mặc định do server điền).
        const body = validate(unlinkBody, req.body ?? {});
        await unassignOffset(actorOf(req), requireScope(req), id, linkId, body.reason, metaOf(req));
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/debts/:id/link-candidates',
      config: { perms: ['debt:read'] as Permission[], screen: 'DEBT-02', summary: 'Phiếu thu/chi khả dụng để cấn trừ (cùng đối tác)' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const q = validate(linkCandidatesQuery, req.query);
        const items = await offsetCandidates(requireScope(req), id, q.q);
        return ok(reply, { items }, { maxAge: 0 });
      },
    }),
  );

  registerOwnerAttachmentRoutes(app, {
    kind: 'debt',
    model: 'DebtVoucher',
    base: '/debts',
    permWrite: 'debt:write',
    screen: 'DEBT-02',
    subjectType: 'debt',
    label: 'phiếu công nợ',
  });
}

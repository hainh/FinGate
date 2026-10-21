/**
 * Tag — nhãn tự do gắn phiếu, danh bạ theo công ty (v2/v2.md §6.2, §13).
 *
 * GET    /tags         danh sách / gợi ý (mặc định ẩn tag đã ẩn; include_hidden cần tag:manage)
 * GET    /tags/:id     chi tiết + số phiếu đang gắn
 * POST   /tags         tạo (tag:create) — trùng tên đang hiện → trả tag đã có (200)
 * PATCH  /tags/:id     đổi tên / màu / ẩn-hiện (tag:manage)
 * POST   /tags/merge   gộp tag A vào tag B, cập nhật mọi phiếu (tag:manage)
 *
 * Nghiệp vụ & kiểm tra nằm ở domain/tags; route chỉ kiểm quyền, phạm vi công ty và định dạng.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError, tagCreateBody, tagListQuery, tagMergeBody, tagUpdateBody, type Permission } from '@fingate/shared';
import { assertCompanyScope, defineRoute, requestCtx, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { createTag, getTagRow, listTags, mergeTags, updateTag, type TagCallCtx } from '../domain/tags/index.ts';

/** Ngữ cảnh gọi domain: người làm + phạm vi công ty của phiên + IP/UA cho audit. */
function callCtx(req: FastifyRequest): TagCallCtx {
  const actor = requireActor(req);
  const rc = requestCtx(req);
  return { actor, scope: requireScope(req), ip: rc.ip, ua: rc.ua };
}

/** Quyền xem tag: người xem/tạo phiếu hoặc người quản lý tag (form phiếu cần gợi ý tag). */
const TAG_READ_ANY: Permission[] = ['doc:read', 'tag:create', 'tag:manage'];

export function tagRoutes(app: FastifyInstance): void {
  /** Danh sách / gợi ý tag. Tag đã ẩn chỉ hiện khi người gọi có `tag:manage` và truyền include_hidden=true. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/tags',
      config: { perms: [] as Permission[], permsAny: TAG_READ_ANY, screen: 'TAG-01', summary: 'Danh sách / gợi ý tag của công ty' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const q = validate(tagListQuery, req.query);
        const items = await listTags(scope, {
          companyId: q.company_id ?? null,
          q: q.q ?? null,
          includeHidden: q.include_hidden === 'true' && actor.permissions.includes('tag:manage'),
          limit: q.limit,
        });
        return ok(reply, { items, total: items.length });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/tags/:id',
      config: { perms: [] as Permission[], permsAny: TAG_READ_ANY, screen: 'TAG-01', summary: 'Chi tiết tag và số phiếu đang gắn' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const data = await getTagRow(requireScope(req), id);
        return ok(reply, { data });
      },
    }),
  );

  /**
   * Tạo tag. Công ty = `company_id` trong body, mặc định công ty của phiên; phải nằm trong phạm vi.
   * Trả 201 khi tạo mới, 200 khi trùng tên đang hiện (trả tag đã có).
   */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/tags',
      config: { perms: ['tag:create'] as Permission[], screen: 'TAG-01', summary: 'Tạo tag (trùng tên thì trả tag đã có)' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(tagCreateBody, req.body);
        const companyId = body.company_id ?? actor.company_id;
        if (!companyId) throw new ApiError({ code: 'FG-VAL-001', errors: { company_id: 'Chưa xác định công ty' } });
        assertCompanyScope(req, companyId);
        const { tag, created } = await createTag(callCtx(req), {
          company_id: companyId,
          name: body.name,
          color: body.color ?? null,
        });
        return ok(reply, { data: tag, created }, { status: created ? 201 : 200 });
      },
    }),
  );

  /** Đổi tên / màu / ẩn-hiện. Sửa được cả sau khi duyệt phiếu (không đổi tiền) — mọi thay đổi có audit. */
  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/tags/:id',
      config: { perms: ['tag:manage'] as Permission[], screen: 'TAG-01', summary: 'Đổi tên / màu / ẩn-hiện tag' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = validate(tagUpdateBody, req.body);
        const data = await updateTag(callCtx(req), id, body);
        return ok(reply, { data });
      },
    }),
  );

  /** Gộp tag nguồn vào tag đích: chuyển mọi phiếu của công ty, ẩn tag nguồn. Chạy lại an toàn. */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/tags/merge',
      config: { perms: ['tag:manage'] as Permission[], screen: 'TAG-01', summary: 'Gộp tag nguồn vào tag đích (cập nhật mọi phiếu)' },
      handler: async (req, reply) => {
        const body = validate(tagMergeBody, req.body);
        const data = await mergeTags(callCtx(req), body);
        return ok(reply, { data });
      },
    }),
  );
}

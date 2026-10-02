/**
 * Chứng từ đính kèm cho các "owner" ngoài hồ sơ thu/chi (phiếu công nợ, khoản vay
 * ngân hàng). Dùng chung luồng prepare → PUT (presigned) → confirm.
 *
 * R2 (STORAGE_DRIVER=s3) cho phép tới 100 MB; fs/dev-onprem giới hạn 25 MB
 * (route /storage/put cũng chặn 25 MB nên không có đường vòng).
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Types } from 'mongoose';
import { ApiError, type Permission } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { defineRoute, requestCtx, requireActor, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import {
  ownerAttachmentConfirmBody,
  ownerAttachmentPrepareBody,
  ownerAttachmentRemoveBody,
} from '@fingate/shared';
import {
  ownerAttachmentConfirmBodySchema,
  ownerAttachmentPrepareBodySchema,
  ownerAttachmentRemoveBodySchema,
} from './schemas.ts';
import { ownerAttachmentKey, storage } from '../storage/index.ts';
import { buildHistoryEntry, mirrorAudit } from '../domain/audit/index.ts';

export type OwnerKind = 'debt' | 'loan';

export interface OwnerSpec {
  kind: OwnerKind;
  model: 'DebtVoucher' | 'BankDebt';
  /** route base, vd '/debts' */
  base: string;
  permWrite: Permission;
  screen: string;
  subjectType: string;
  /** nhãn hiển thị của owner trong thông điệp lỗi. */
  label: string;
}

const ALLOWED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);
const FS_MAX = 25 * 1024 * 1024;
const S3_MAX = 100 * 1024 * 1024;

interface OwnerDoc {
  _id: unknown;
  company_id: unknown;
  code?: string;
  attachments?: { id: unknown; type: string; key: string; version?: number; filename?: string; referenced_by?: unknown[] }[];
}

export function registerOwnerAttachmentRoutes(app: FastifyInstance, spec: OwnerSpec): void {
  app.route(
    defineRoute({
      method: 'POST',
      url: `${spec.base}/:id/attachments/prepare`,
      config: { perms: [spec.permWrite], screen: spec.screen, summary: `Xin URL upload chứng từ ${spec.label}` },
      schema: { tags: [spec.kind], body: ownerAttachmentPrepareBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(ownerAttachmentPrepareBody, req.body);
        const owner = await findOwner(spec, req, id);
        if (!body.mime || !ALLOWED_MIME.has(body.mime)) {
          throw new ApiError({ code: 'FG-VAL-002', detail: 'Chỉ nhận tệp PDF hoặc ảnh PNG/JPG' });
        }
        const cap = storage().driver === 's3' ? S3_MAX : FS_MAX;
        if (body.size > cap) {
          throw new ApiError({ code: 'FG-VAL-003', detail: `Tệp vượt ${Math.round(cap / 1024 / 1024)} MB` });
        }

        const company = await Models.Company.findById(owner.company_id).select({ code: 1, storage_quota_bytes: 1 }).lean<{
          code?: string;
          storage_quota_bytes?: number;
        } | null>();
        const code = String(owner.code ?? id);
        const used = await storage().usedBytes(`uploads/${company?.code ?? 'CO'}/${spec.kind}/${code}`);
        const quota = Number(company?.storage_quota_bytes ?? 0) || undefined;
        if (quota && used + body.size > quota) {
          throw new ApiError({ code: 'FG-VAL-004', detail: 'Vượt hạn mức dung lượng chứng từ của công ty' });
        }

        const attachmentId = new Types.ObjectId();
        const version =
          (owner.attachments?.length ? Math.max(...owner.attachments.map((a) => Number(a.version ?? 1))) : 0) + 1;
        const key = ownerAttachmentKey({
          companyCode: String(company?.code ?? 'CO'),
          ownerType: spec.kind,
          code,
          attachmentId: String(attachmentId),
          version,
          sha256: body.sha256,
          filename: body.filename,
        });
        const prepared = await storage().preparePut(key, body.mime, body.size);
        await Models.Attachment.create({
          owner_type: spec.kind,
          owner_id: owner._id,
          company_id: owner.company_id,
          attachment_id: attachmentId,
          type: body.type,
          version,
          key,
          sha256: body.sha256,
          size: body.size,
          mime: body.mime,
          filename: body.filename,
          state: 'prepared',
          added_by: actor.user_id,
        } as never);
        return ok(reply, { data: { ...prepared, attachment_id: String(attachmentId), version } }, { status: 202 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: `${spec.base}/:id/attachments/confirm`,
      config: { perms: [spec.permWrite], screen: spec.screen, summary: `Xác nhận upload chứng từ ${spec.label}` },
      schema: { tags: [spec.kind], body: ownerAttachmentConfirmBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(ownerAttachmentConfirmBody, req.body);
        const owner = await findOwner(spec, req, id);

        const meta = await Models.Attachment.findOne({
          owner_type: spec.kind,
          owner_id: owner._id,
          attachment_id: body.attachment_id,
        } as never).lean<{
          _id: unknown;
          attachment_id: unknown;
          key: string;
          sha256?: string;
          size?: number;
          mime?: string;
          filename?: string;
          type?: string;
          version?: number;
          state?: string;
        } | null>();
        if (!meta) throw new ApiError({ code: 'FG-VAL-001', detail: 'Không tìm thấy lần upload' });
        if (meta.state === 'confirmed') return ok(reply, { data: { already: true } });

        const head = await storage().head(String(meta.key));
        if (!head.exists) throw new ApiError({ code: 'FG-VAL-005', detail: 'File chưa lên tới nơi lưu' });
        if (meta.size && head.size && Number(head.size) !== Number(meta.size)) {
          throw new ApiError({ code: 'FG-VAL-005', detail: `Kích thước khớp không đúng (${head.size} ≠ ${meta.size})` });
        }

        const embed = {
          id: meta.attachment_id,
          type: meta.type,
          version: meta.version,
          key: meta.key,
          sha256: meta.sha256,
          size: meta.size,
          mime: meta.mime,
          filename: meta.filename,
          added_at: new Date(),
          added_by: actor.user_id,
          referenced_by: [] as string[],
        };
        const entry = buildHistoryEntry({
          action: 'attachment_add',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: null,
          ip: requestCtx(req).ip,
          fields: { file: meta.filename, version: meta.version },
        });
        await updateOwner(spec, id, {
          $push: { attachments: embed, history: entry },
        });
        await Models.Attachment.updateOne({ _id: meta._id }, { $set: { state: 'confirmed', confirmed_at: new Date() } }).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: `${spec.kind}.attachment_confirm`,
          subject: { type: spec.subjectType, id, code: String(owner.code ?? '') },
          company_id: String(owner.company_id),
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { attachment: embed } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: `${spec.base}/:id/attachments/:attachmentId/remove`,
      config: { perms: [spec.permWrite], screen: spec.screen, summary: `Xoá chứng từ ${spec.label}` },
      schema: { tags: [spec.kind], body: ownerAttachmentRemoveBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id, attachmentId } = req.params as { id: string; attachmentId: string };
        const body = validate(ownerAttachmentRemoveBody, req.body);
        const owner = await findOwner(spec, req, id);
        const att = (owner.attachments ?? []).find((a) => String(a.id) === attachmentId);
        if (!att) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy chứng từ' });
        if (Array.isArray(att.referenced_by) && att.referenced_by.length > 0) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chứng từ đã được tham chiếu — chỉ thêm, không xoá (audit)' });
        }
        await updateOwner(spec, id, { $pull: { attachments: { id: att.id } } });
        await Models.Attachment.deleteOne({ owner_type: spec.kind, owner_id: owner._id, attachment_id: attachmentId } as never).exec();
        await storage().remove(String(att.key)).catch(() => undefined);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: `${spec.kind}.attachment_remove`,
          subject: { type: spec.subjectType, id, code: String(owner.code ?? '') },
          company_id: String(owner.company_id),
          diff_fields: { file: att.filename, reason: body.reason ?? null },
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );
}

/** fs/dev: PUT /storage/put đã dùng chung `assertUploadKeyVisible` — metadata đã có nên scope vẫn kiểm đúng. */
type OwnerQueryable = {
  findById: (id: string) => { lean: () => Promise<OwnerDoc | null> };
};
function ownerModel(spec: OwnerSpec): OwnerQueryable {
  return Models[spec.model] as unknown as OwnerQueryable;
}

async function findOwner(spec: OwnerSpec, req: FastifyRequest, id: string): Promise<OwnerDoc> {
  const owner = await ownerModel(spec).findById(id).lean();
  if (!owner) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: `Không tìm thấy ${spec.label}` });
  const { scope } = requestCtx(req);
  if (scope.companyIds !== null && !scope.companyIds.includes(String(owner.company_id))) {
    throw new ApiError({ code: 'FG-RBAC-002' });
  }
  return owner;
}

async function updateOwner(spec: OwnerSpec, id: string, update: Record<string, unknown>): Promise<void> {
  await (Models[spec.model] as unknown as { updateOne: (f: unknown, u: unknown) => { exec: () => Promise<unknown> } })
    .updateOne({ _id: id }, { $set: { updated_at: new Date() }, ...update })
    .exec();
}

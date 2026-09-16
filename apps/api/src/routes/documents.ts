/**
 * Nhóm route hồ sơ thu/chi/đảo hạn/chuyển nội bộ (screens DOC-01, CHI-0x, THU-0x).
 *
 * Route là lớp MỎNG: check quyền → zod → service → trả `can` để UI dựng action bar.
 * Không có logic tiền/trạng thái ở đây (§19.5-2: workflow là writer duy nhất).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ApiError,
  currencyDecimals,
  DOC_KIND_LABEL,
  permissionsForRole,
  ROLE_LABEL,
  STATUS_REGISTRY,
  formatMoney,
  money,
  statusLabel,
  today,
  vnDate,
  type DocKind,
  type Permission,
  type Role,
  type StatusKey,
} from '@fingate/shared';
import { Models } from '../db/models.ts';
import { cas, alreadyProcessed } from '../db/cas.ts';
import { defineRoute, requestCtx, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import {
  attachmentConfirmBodySchema,
  attachmentPrepareBodySchema,
  documentCreateBodySchema,
  documentListQuerySchema,
  documentUpdateBodySchema,
  opinionBodySchema,
  transitionBodySchema,
} from './schemas.ts';
import {
  documentCreateBody,
  documentListQuery,
  documentUpdateBody,
  opinionBody,
  transitionBody,
  attachmentPrepareBody,
  attachmentConfirmBody,
} from '@fingate/shared';
import { loadDoc, transition } from '../domain/workflow/index.ts';
import { documentPermissions } from '../domain/entitlement/index.ts';
import { awaitingBadge, decisionPack, docHref, queryQueue } from '../domain/queries/index.ts';
import { mirrorAudit, buildHistoryEntry } from '../domain/audit/index.ts';
import { invalidateFor, rebuildEvidence } from '../domain/side-effects.ts';
import { attachmentKey, detectMagic, sha256hex, storage } from '../storage/index.ts';
import { newRequestId } from '../lib/http.ts';

/**
 * `/api/v1/documents` + `/api/v1/queue*`.
 * Kiến trúc ghi `attachments:prepare`; ở đây dùng `/attachments/prepare` vì
 * path-to-regexp coi `:` là dấu hiệu tham số — cùng hành vi, khác ký tự.
 */
export function documentRoutes(app: FastifyInstance): void {
  /* ------------------------------ danh sách ------------------------------ */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/documents',
      config: { perms: ['doc:read'] as Permission[], screen: 'CHI-01', summary: 'Danh sách hồ sơ (URL = state)' },
      schema: { tags: ['documents'], querystring: documentListQuerySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const q = validate(documentListQuery, req.query);
        const { items, total } = await queryQueue({
          scope,
          userId: actor.user_id,
          kind: q.kind,
          status: q.status as string[] | string | undefined,
          companyId: q.company_id,
          mine: q.mine,
          from: q.from,
          to: q.to,
          q: q.q,
          overdueOnly: q.overdue_only === 'true',
          missingEvidenceOnly: q.missing_evidence === 'true',
          sort: q.sort,
          limit: q.limit,
        });
        return ok(reply, { items, total, limit: q.limit }, { maxAge: 15 });
      },
    }),
  );

  /** APPR-01 — hàng chờ của chính tôi. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/queue',
      config: { perms: ['approval:act'] as Permission[], screen: 'APPR-01', summary: 'Chờ tôi duyệt' },
      schema: { tags: ['documents'], querystring: documentListQuerySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const q = validate(documentListQuery, req.query);
        const [{ items, total }, badge] = await Promise.all([
          queryQueue({
            scope,
            userId: actor.user_id,
            mine: 'to_approve',
            kind: q.kind,
            companyId: q.company_id,
            q: q.q,
            overdueOnly: q.overdue_only === 'true',
            sort: q.sort ?? '-waiting',
            limit: q.limit,
          }),
          awaitingBadge(scope, actor.user_id),
        ]);
        return ok(
          reply,
          {
            items,
            total,
            summary: {
              count: badge.count,
              amount: badge.total_minor.toString(),
              compact: formatMoney(money(badge.total_minor), { mode: 'compact' }),
            },
            limit: q.limit,
          },
          { maxAge: 15 },
        );
      },
    }),
  );

  /** APPR-02 — tôi đã duyệt. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/queue/processed',
      config: { perms: ['approval:act'] as Permission[], screen: 'APPR-02', summary: 'Tôi đã duyệt' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const { items, total } = await queryQueue({ scope, userId: actor.user_id, mine: 'approved_by_me', limit: 50, sort: '-created_at' });
        return ok(reply, { items, total }, { maxAge: 15 });
      },
    }),
  );

  /** DASH-05 — trung tâm "Cần xử lý": thiếu chứng từ + quá hạn + chờ lâu. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/needs-attention',
      config: { perms: ['doc:read'] as Permission[], screen: 'DASH-05', summary: 'Cần xử lý' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const [missing, overdue, awaiting] = await Promise.all([
          queryQueue({ scope, userId: actor.user_id, missingEvidenceOnly: true, limit: 50, sort: '-created_at' }),
          queryQueue({ scope, userId: actor.user_id, overdueOnly: true, limit: 50 }),
          queryQueue({ scope, userId: actor.user_id, mine: 'to_approve', limit: 50, sort: '-waiting' }),
        ]);
        const groups = [
          { key: 'missing_evidence', title: 'Hồ sơ thiếu chứng từ', tone: 'attention', ...missing },
          { key: 'overdue', title: 'Quá hạn xử lý', tone: 'danger', ...overdue },
          { key: 'awaiting', title: 'Đang chờ bạn duyệt', tone: 'warning', ...awaiting },
        ].filter((g) => g.items.length);
        return ok(reply, { groups, empty: groups.length === 0 }, { maxAge: 15 });
      },
    }),
  );

  /* ------------------------------ tạo / sửa ------------------------------ */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/documents',
      config: { perms: ['doc:create'] as Permission[], screen: 'CHI-02', summary: 'Tạo hồ sơ (nháp)' },
      schema: { tags: ['documents'], body: documentCreateBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const body = validate(documentCreateBody, req.body);
        const companyId = body.company_id ?? actor.company_id;
        if (!companyId) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Chưa chọn công ty' });
        if (scope.companyIds !== null && !scope.companyIds.includes(companyId)) {
          throw new ApiError({ code: 'FG-RBAC-002' });
        }

        const kind = body.kind;
        const amountMinor = BigInt(body.amount.amount_minor);
        const evidence = await rebuildEvidence({
          kind,
          category_id: body.category_id ?? null,
          company_id: companyId,
        } as never);
        const required = body.evidence_required ?? evidence.required;
        const draftCode = `DRAFT-${Date.now().toString(36).toUpperCase()}`;

        const created = await Models.Document.create({
          code: draftCode,
          kind,
          company_id: companyId,
          department_id: body.department_id ?? actor.department_id ?? null,
          created_by: actor.user_id,
          status: 'draft',
          version: 1,
          title: body.title,
          purpose: body.purpose,
          category_id: body.category_id ?? null,
          payee: {
            name: body.payee.name,
            tax_code: body.payee.tax_code ?? null,
            counterparty_id: body.payee.counterparty_id ?? null,
            is_internal: Boolean(body.payee.is_internal),
            bank_name: body.payee.bank_name ?? null,
            bank_account: body.payee.bank_account ?? null,
          },
          amount: { minor: amountMinor, currency: body.amount.currency, decimals: currencyDecimals(body.amount.currency) },
          fx: body.fx ? { rate: body.fx.rate, at: body.fx.at } : null,
          source: {
            fund: body.source.fund,
            account_id: body.source.account_id ?? null,
            group_account_id: body.source.group_account_id ?? null,
            group_managed: Boolean(body.source.group_managed),
          },
          target: body.target ? { company_id: body.target.company_id, account_id: body.target.account_id ?? null } : null,
          planned_date: body.planned_date,
          business_date: body.business_date ?? vnDate(),
          priority: body.priority,
          contract: { code: body.contract.code ?? null, value: body.contract.value ? { minor: BigInt(body.contract.value.amount_minor), currency: body.contract.value.currency, decimals: 0 } : null },
          loan_id: body.loan_id ?? null,
          debt_code: body.debt_code ?? null,
          budget: { budget_id: body.budget.budget_id ?? null, line_id: body.budget.line_id ?? null, in_plan: body.budget.in_plan },
          note: body.note ?? null,
          rollover: body.rollover
            ? {
                need_amount: { minor: BigInt(body.rollover.need_amount.amount_minor), currency: body.rollover.need_amount.currency, decimals: 0 },
                plan: body.rollover.plan,
                fee_estimate: body.rollover.fee_estimate ? { minor: BigInt(body.rollover.fee_estimate.amount_minor), currency: body.rollover.fee_estimate.currency, decimals: 0 } : null,
                new_rate: body.rollover.new_rate ?? null,
                collateral: body.rollover.collateral ?? null,
                proposal: body.rollover.proposal ?? null,
              }
            : null,
          evidence: { required, present: [], missing: required },
          approval: { matrix_id: null, matrix_version: 0, matrix_label: null, steps: [] },
          history: [
            buildHistoryEntry({
              action: 'create',
              actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
              to: 'draft',
              request_id: newRequestId(),
              ip: requestCtx(req).ip,
            }),
          ],
        });

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'document.create',
          subject: { type: kind, id: String(created._id), code: created.code },
          company_id: companyId,
          document_id: String(created._id),
          ip: requestCtx(req).ip,
          ua: requestCtx(req).ua,
        });
        invalidateFor(companyId, actor.user_id);
        return ok(reply, { data: await detailOf(String(created._id), actor.user_id) }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/documents/:id',
      config: { perms: ['doc:create'] as Permission[], screen: 'CHI-03', summary: 'Sửa hồ sơ (chỉ khi nháp/trả về)' },
      schema: { tags: ['documents'], body: documentUpdateBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const body = validate(documentUpdateBody, req.body);
        const doc = await loadDoc(params.id);
        if (doc.created_by !== actor.user_id && !actor.permissions.includes('approval:override')) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ người lập mới sửa được hồ sơ' });
        }
        if (!['draft', 'changes_requested'].includes(doc.status)) {
          throw new ApiError({ code: 'FG-WF-005', detail: 'Hồ sơ đã qua cấp duyệt, chỉ thêm chứng từ được' });
        }
        if (doc.processed_requests?.includes(body.request_id)) {
          return ok(reply, { data: await detailOf(params.id, actor.user_id), idempotent: true });
        }

        const set: Record<string, unknown> = {};
        for (const key of ['title', 'purpose', 'note', 'priority', 'planned_date', 'business_date', 'debt_code', 'category_id', 'department_id', 'loan_id'] as const) {
          if (body[key] !== undefined) set[key] = body[key];
        }
        if (body.payee) set.payee = { ...doc.payee, ...body.payee };
        if (body.source) set.source = { ...doc.source, ...body.source };
        if (body.contract) set.contract = { ...doc.contract, ...body.contract };
        if (body.budget) set.budget = { ...doc.budget, ...body.budget };
        if (body.target) set.target = body.target;
        if (body.rollover) set.rollover = body.rollover;
        if (body.amount) {
          set.amount = { minor: BigInt(body.amount.amount_minor), currency: body.amount.currency, decimals: 0 };
        }

        const entry = buildHistoryEntry({
          action: 'update',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          from: doc.status,
          to: doc.status,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
          fields: { changed: Object.keys(set) },
        });

        const result = await cas<Record<string, unknown>>({
          model: 'Document',
          id: params.id,
          ifMatch: body.if_match,
          extraFilter: { status: { $in: ['draft', 'changes_requested'] } },
          set,
          push: { history: entry },
          addToSet: { processed_requests: body.request_id },
        });
        if (!result) throw new ApiError({ code: 'FG-WF-011' });
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'document.update',
          subject: { type: doc.kind, id: params.id, code: doc.code },
          company_id: String(doc.company_id),
          document_id: params.id,
          diff_fields: { changed: Object.keys(set) },
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        invalidateFor(String(doc.company_id), actor.user_id);
        return ok(reply, { data: await detailOf(params.id, actor.user_id), version: result.version });
      },
    }),
  );

  /* ------------------------------- chi tiết ------------------------------ */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/documents/:id',
      config: { perms: ['doc:read'] as Permission[], screen: 'DOC-01', summary: 'Hồ sơ chi tiết (5 tab)' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const query = req.query as { archived?: string };
        if (query.archived === 'true') {
          // hồ sơ đã archive → đọc từ R2 (§8.7)
          throw new ApiError({ code: 'FG-SYS-003', detail: 'Hồ sơ lưu trữ — đang đọc từ kho' });
        }
        return ok(reply, { data: await detailOf(params.id, actor.user_id) }, { maxAge: 0 });
      },
    }),
  );

  /** §9.2 — 7 câu hỏi kiểm soát, server tính 100%. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/documents/:id/decision-pack',
      config: { perms: ['doc:read'] as Permission[], screen: 'DOC-01', summary: 'Decision-pack (7 câu hỏi)' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const doc = await Models.Document.findById(params.id).lean<Record<string, unknown> | null>();
        if (!doc) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        await assertVisible(req, String(doc.company_id));
        const pack = await decisionPack(doc, actor.permissions.includes('doc:read'));
        return ok(reply, { data: pack }, { etag: `dp-${doc.version}`, maxAge: 15 });
      },
    }),
  );

  /** tab Lịch sử phê duyệt + Audit. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/documents/:id/history',
      config: { perms: ['doc:read'] as Permission[], screen: 'DOC-01', summary: 'history[] của hồ sơ' },
      handler: async (req) => {
        const params = req.params as { id: string };
        const doc = await Models.Document.findById(params.id).select({ history: 1, company_id: 1, code: 1, kind: 1, approval: 1 }).lean();
        if (!doc) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        await assertVisible(req, String(doc.company_id));
        return { data: { code: doc.code, steps: (doc.approval as { steps?: unknown })?.steps ?? [], history: doc.history ?? [] } };
      },
    }),
  );

  /* ----------------------------- workflow -------------------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/documents/:id/transition',
      config: { perms: 'public', stepUp: true, screen: 'DOC-01', summary: 'submit/approve/reject/changes/pay/cancel' },
      schema: { tags: ['documents'], body: transitionBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const body = validate(transitionBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));

        if (body.action === 'submit' && !(actor.permissions.includes('doc:submit') || actor.permissions.includes('doc:create'))) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Bạn không có quyền gửi hồ sơ' });
        }
        if (await alreadyProcessed(params.id, body.request_id)) {
          const fresh = await detailOf(params.id, actor.user_id);
          return ok(reply, { data: fresh, idempotent: true });
        }

        const result = await transition({ doc, actor, body, ip: requestCtx(req).ip });
        const fresh = await detailOf(params.id, actor.user_id);
        return ok(reply, { data: fresh, transition: result }, { etag: result.version });
      },
    }),
  );

  /** FgOpinion — ý kiến không đổi trạng thái, chỉ thêm (không sửa được ý kiến đã vào audit). */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/documents/:id/opinions',
      config: { perms: ['doc:read'] as Permission[], screen: 'DOC-01', summary: 'Gửi ý kiến' },
      schema: { tags: ['documents'], body: opinionBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const body = validate(opinionBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));
        const entry = buildHistoryEntry({
          action: 'opinion',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          opinion: body.body,
          reason: body.kind,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        const r = await cas<Record<string, unknown>>({
          model: 'Document',
          id: params.id,
          ifMatch: doc.version,
          push: { history: entry },
          addToSet: { processed_requests: body.request_id },
        });
        if (!r) throw new ApiError({ code: 'FG-WF-011' });
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'document.opinion',
          subject: { type: doc.kind, id: params.id, code: doc.code },
          company_id: String(doc.company_id),
          document_id: params.id,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true, version: r.version } }, { status: 201 });
      },
    }),
  );

  /* ---------------------- chứng từ: prepare / confirm --------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/documents/:id/attachments/prepare',
      config: { perms: ['doc:create'] as Permission[], screen: 'DOC-01', summary: 'Xin URL upload (presigned PUT)' },
      schema: { tags: ['documents'], body: attachmentPrepareBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const body = validate(attachmentPrepareBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));
        if (['paid', 'rejected', 'cancelled'].includes(doc.status)) {
          throw new ApiError({ code: 'FG-WF-005', detail: 'Hồ sơ đã đóng — không thêm chứng từ' });
        }

        const company = await Models.Company.findById(doc.company_id).select({ code: 1 }).lean();
        const used = await storage().usedBytes(`uploads/${company?.code ?? 'CO'}/${doc.code}`);
        const quota = Number(company?.storage_quota_bytes ?? 0) || undefined;
        if (quota && used + body.size > quota) {
          throw new ApiError({ code: 'FG-VAL-004', detail: 'Vượt hạn mức dung lượng chứng từ của công ty' });
        }

        const attachmentId = new (await import('mongoose')).Types.ObjectId();
        const version = (doc.attachments?.length ? Math.max(...(doc.attachments as unknown as { version: number }[]).map((a) => a.version)) : 0) + 1;
        const key = attachmentKey({
          companyCode: String(company?.code ?? 'CO'),
          docCode: doc.code,
          attachmentId: String(attachmentId),
          version,
          sha256: body.sha256,
          filename: body.filename,
        });
        const prepared = await storage().preparePut(key, body.mime, body.size);
        await Models.Attachment.create({
          document_id: params.id,
          company_id: doc.company_id,
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
        });
        return ok(reply, { data: { ...prepared, attachment_id: String(attachmentId), version } }, { status: 202 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/documents/:id/attachments/confirm',
      config: { perms: ['doc:create'] as Permission[], screen: 'DOC-01', summary: 'Xác nhận đã upload (HeadObject + CAS)' },
      schema: { tags: ['documents'], body: attachmentConfirmBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const body = validate(attachmentConfirmBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));

        const meta = await Models.Attachment.findOne({ document_id: params.id, attachment_id: body.attachment_id }).lean();
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
          referenced_by: [],
        };
        const evidence = await rebuildEvidenceForDoc(params.id, doc);
        const entry = buildHistoryEntry({
          action: 'attachment_add',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          from: doc.status,
          to: doc.status,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
          fields: { file: meta.filename, version: meta.version },
        });
        const r = await cas<Record<string, unknown>>({
          model: 'Document',
          id: params.id,
          ifMatch: body.if_match,
          set: { evidence },
          push: { attachments: embed, history: entry },
          addToSet: { processed_requests: body.request_id },
        });
        if (!r) throw new ApiError({ code: 'FG-WF-011' });
        await Models.Attachment.updateOne({ _id: meta._id }, { $set: { state: 'confirmed', confirmed_at: new Date() } }).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'document.attachment_confirm',
          subject: { type: doc.kind, id: params.id, code: doc.code },
          company_id: String(doc.company_id),
          document_id: params.id,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        invalidateFor(String(doc.company_id), actor.user_id);
        return ok(reply, { data: { attachment: embed, evidence, version: r.version } });
      },
    }),
  );

  /** Tải chứng từ: check quyền TỪNG LẦN rồi 302 sang URL ngắn hạn (§11). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/attachments/:id',
      config: { perms: ['doc:read'] as Permission[], screen: 'DOC-01', summary: 'Tải chứng từ' },
      handler: async (req, reply: FastifyReply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const att = await Models.Attachment.findOne({ attachment_id: params.id, state: 'confirmed' }).lean();
        if (!att) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy chứng từ' });
        await assertVisible(req, String(att.company_id));
        // đánh dấu hồ sơ đã tham chiếu file này → từ đó KHÔNG xoá được (DS §7.9)
        void Models.Document.updateOne(
          { _id: att.document_id, 'attachments.id': att.attachment_id },
          { $addToSet: { 'attachments.$.referenced_by': actor.user_id } },
        ).exec();
        const url = await storage().presignGet(String(att.key), 60);
        return reply.code(302).header('location', url).header('cache-control', 'private, no-store').send();
      },
    }),
  );

  /** fs/dev: nhận PUT trực tiếp byte (khi STORAGE_DRIVER=fs không có presign). */
  app.route(
    defineRoute({
      method: 'PUT',
      url: '/storage/put',
      config: { perms: 'public', screen: 'DOC-01', summary: 'Upload cho STORAGE_DRIVER=fs (dev/Profile O)' },
      handler: async (req, reply) => {
        const key = (req.query as { key?: string }).key ?? '';
        if (!/^uploads\/[\w./-]+$/.test(key)) throw new ApiError({ code: 'FG-VAL-001', detail: 'Key không hợp lệ' });
        const actor = requireActor(req);
        const chunks: Buffer[] = [];
        for await (const c of req.raw) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
        const buf = Buffer.concat(chunks);
        if (buf.length > 25 * 1024 * 1024) throw new ApiError({ code: 'FG-VAL-003' });
        const magic = detectMagic(new Uint8Array(buf.subarray(0, 8)));
        if (!magic.ok) throw new ApiError({ code: 'FG-VAL-002', detail: 'Định dạng file không được hỗ trợ' });
        const adapter = storage();
        if (adapter.putBytes) await adapter.putBytes(key, buf, magic.mime ?? 'application/octet-stream');
        else throw new ApiError({ code: 'FG-SYS-001', detail: 'Storage driver không hỗ trợ upload trực tiếp' });
        void actor;
        return ok(reply, { data: { ok: true, size: buf.length, sha256: sha256hex(buf) } }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/storage/get',
      config: { perms: ['doc:read'] as Permission[], screen: 'DOC-01', summary: 'Tải file (STORAGE_DRIVER=fs)' },
      handler: async (req, reply) => {
        const key = (req.query as { key?: string }).key ?? '';
        if (!/^uploads\/[\w./-]+$/.test(key)) throw new ApiError({ code: 'FG-VAL-001' });
        const url = await storage().presignGet(key, 60);
        return reply.code(302).header('location', url).send();
      },
    }),
  );
}

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

/** Chặn đọc chéo công ty: company_id của hồ sơ phải nằm trong scope (§7.5). */
async function assertVisible(req: FastifyRequest, companyId: string): Promise<void> {
  const { scope } = requestCtx(req);
  if (scope.companyIds === null) return;
  if (!scope.companyIds.includes(companyId)) throw new ApiError({ code: 'FG-RBAC-002' });
}

async function rebuildEvidenceForDoc(id: string, doc: { kind: DocKind; category_id?: string | null; company_id: string }): Promise<{ required: string[]; present: string[]; missing: string[] }> {
  const fresh = await Models.Document.findById(id).select({ attachments: 1 }).lean<{ attachments?: { type: string }[] } | null>();
  const base = await rebuildEvidence({ kind: doc.kind, category_id: doc.category_id ?? null, company_id: String(doc.company_id) } as never);
  const present = [...new Set((fresh?.attachments ?? []).map((a) => String(a.type)))];
  return { required: base.required, present, missing: base.required.filter((t) => !present.includes(t)) };
}

/** Bản chi tiết + `can` (quền của người gọi trên CHÍNH hồ sơ này). */
export async function detailOf(id: string, userId: string): Promise<Record<string, unknown>> {
  const doc = await Models.Document.findById(id).lean<Record<string, unknown> | null>();
  if (!doc) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy hồ sơ' });

  const [user, company, assignments, delegated] = await Promise.all([
    Models.User.findById(userId).select({ display_name: 1, email: 1 }).lean(),
    Models.Company.findById(doc.company_id).select({ name: 1, code: 1 }).lean(),
    Models.Assignment.find({ user_id: userId, status: 'active' }).select({ company_id: 1, role: 1, amount_limit_minor: 1, extra_permissions: 1, denied_permissions: 1, scope_all: 1 }).lean(),
    Models.Delegation.find({ to_user_id: userId, status: 'active', valid_from: { $lte: new Date() }, valid_to: { $gte: new Date() } }).select({ user_id: 1, role: 1 }).lean(),
  ]);

  const actorCompany = assignments.find((a) => String(a.company_id) === String(doc.company_id)) ?? assignments[0];
  const rawSteps = ((doc.approval as { steps?: { order: number; role: Role; user_id: unknown; state: string }[] }) ?? { steps: [] }).steps ?? [];
  // `.lean()` trả ObjectId cho user_id nhúng trong steps → so sánh với string luôn sai (bug can.approve).
  const steps = rawSteps.map((s) => ({ ...s, user_id: s.user_id == null ? null : String(s.user_id) }));
  const evidence = (doc.evidence ?? { required: [], present: [], missing: [] }) as { required: string[]; present: string[]; missing: string[] };
  const amountMinor = BigInt(String((doc.amount as { minor?: unknown })?.minor ?? '0'));
  const permissions = new Set<string>();
  let limit = 0n;
  for (const a of assignments) {
    const e = entitlementsForRole(String(a.role ?? 'staff'), a.extra_permissions as string[], a.denied_permissions as string[]);
    for (const p of e) permissions.add(p);
    const al = BigInt(String(a.amount_limit_minor ?? '0'));
    if (al > limit) limit = al;
  }

  const can = documentPermissions(
    {
      user_id: userId,
      permissions: [...permissions],
      amount_limit_minor: limit,
      role: (actorCompany?.role ?? 'staff') as Role,
    },
    {
      status: String(doc.status),
      created_by: String(doc.created_by),
      amount_minor: amountMinor,
      steps,
      evidence_missing: evidence.missing ?? [],
      company_id: String(doc.company_id),
      actor_companies: assignments.map((a) => String(a.company_id)),
      delegatedStepOrders: delegated.map((d) => steps.find((s) => String(s.user_id) === String(d.user_id))?.order ?? -1).filter((o) => o >= 0),
    },
  );

  const currentStep = steps.find((s) => s.state === 'current') ?? steps.find((s) => s.state === 'waiting') ?? null;
  const owner = currentStep?.user_id ? await Models.User.findById(currentStep.user_id).select({ display_name: 1 }).lean() : null;

  return {
    _id: String(doc._id),
    code: String(doc.code),
    kind: String(doc.kind) as DocKind,
    kind_label: DOC_KIND_LABEL[String(doc.kind) as DocKind] ?? '',
    company_id: String(doc.company_id),
    company_name: String(company?.name ?? ''),
    department_id: doc.department_id ? String(doc.department_id) : null,
    created_by: String(doc.created_by),
    created_by_name: String(user?.display_name ?? user?.email ?? ''),
    status: String(doc.status) as StatusKey,
    status_label: statusLabel(String(doc.status)),
    tone: STATUS_REGISTRY[String(doc.status) as StatusKey]?.tone ?? 'neutral',
    overdue: Boolean(doc.overdue),
    waiting_days: waitingDaysOf(doc),
    current_owner: currentStep ? { role: ROLE_LABEL[currentStep.role] ?? currentStep.role, name: owner?.display_name ? String(owner.display_name) : null } : null,
    version: Number(doc.version ?? 1),
    title: String(doc.title ?? ''),
    purpose: String(doc.purpose ?? ''),
    category_id: doc.category_id ? String(doc.category_id) : null,
    payee: doc.payee ?? {},
    amount: wireAmount(doc.amount),
    fx: doc.fx ?? null,
    source: { ...(doc.source as object), account_label: null, balance_available: null },
    planned_date: String(doc.planned_date ?? ''),
    business_date: String(doc.business_date ?? today()),
    priority: String(doc.priority ?? 'normal'),
    contract: doc.contract ?? {},
    loan_id: doc.loan_id ? String(doc.loan_id) : null,
    budget: doc.budget ?? { in_plan: true },
    target: doc.target ?? null,
    rollover: doc.rollover ?? null,
    debt_code: doc.debt_code ?? null,
    note: doc.note ?? null,
    approval: {
      matrix_id: (doc.approval as { matrix_id?: unknown })?.matrix_id ? String((doc.approval as { matrix_id: unknown }).matrix_id) : null,
      matrix_version: Number((doc.approval as { matrix_version?: number })?.matrix_version ?? 0),
      matrix_label: (doc.approval as { matrix_label?: string })?.matrix_label ?? null,
      steps,
    },
    evidence,
    attachments: ((doc.attachments ?? []) as unknown as Record<string, unknown>[]).map((a) => ({
      id: String(a.id),
      type: String(a.type),
      version: Number(a.version),
      filename: String(a.filename),
      size: Number(a.size ?? 0),
      mime: String(a.mime),
      added_at: a.added_at ? new Date(String(a.added_at)).toISOString() : null,
      added_by: a.added_by ? String(a.added_by) : null,
      download_href: `/api/v1/attachments/${String(a.id)}`,
      referenced: Array.isArray(a.referenced_by) && a.referenced_by.length > 0,
    })),
    execution: doc.execution
      ? {
          paid_at: (doc.execution as { paid_at?: string }).paid_at ?? null,
          bank_ref: (doc.execution as { bank_ref?: string }).bank_ref ?? null,
          executed_by: (doc.execution as { executed_by?: unknown }).executed_by ? String((doc.execution as { executed_by: unknown }).executed_by) : null,
          actual_amount: wireAmount((doc.execution as { actual_amount?: unknown }).actual_amount),
        }
      : null,
    override: (doc.override as { fast_tracked?: boolean; reason?: string | null }) ?? { fast_tracked: false, reason: null },
    history: ((doc.history ?? []) as unknown as Record<string, unknown>[]).map((h) => ({
      at: h.at ? new Date(String(h.at)).toISOString() : null,
      actor: h.actor ?? {},
      action: String(h.action),
      from: (h.from as string | null) ?? null,
      to: (h.to as string | null) ?? null,
      opinion: (h.opinion as string | null) ?? null,
      reason: (h.reason as string | null) ?? null,
      request_id: (h.request_id as string | null) ?? null,
      ip: (h.ip as string | null) ?? null,
      fields: (h.fields as Record<string, unknown> | null) ?? null,
    })),
    href: docHref(String(doc.kind), String(doc._id)),
    can,
  };
}

function wireAmount(m: unknown): { minor: string; currency: string; decimals: number } {
  const rec = (m ?? { minor: 0n }) as Record<string, unknown>;
  return { minor: String(rec.minor ?? '0'), currency: String(rec.currency ?? 'VND'), decimals: Number(rec.decimals ?? 0) };
}

function waitingDaysOf(doc: Record<string, unknown>): number {
  const raw = (doc.submitted_at ?? doc.created_at) as Date | string | undefined;
  if (!raw) return 0;
  const at = raw instanceof Date ? raw : new Date(String(raw));
  return Math.max(0, Math.floor((Date.now() - at.getTime()) / 86_400_000));
}

/** entitlement theo vai trò — dùng cho `can` per hồ sơ. */
function entitlementsForRole(role: string, extra: string[] = [], denied: string[] = []): string[] {
  const base = new Set(permissionsForRole(role as Role));
  for (const p of extra) base.add(p as Permission);
  for (const p of denied) base.delete(p as Permission);
  return [...base];
}

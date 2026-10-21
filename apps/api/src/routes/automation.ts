/**
 * Quy trình tự động (v2/v2.md §11.2–11.3, §11.7 US-AUTO-05/07): cấu hình quy tắc theo công ty, lượt chạy, chạy lại.
 *
 * - GET   /automation/rules            — danh sách quy tắc + hiệu lực theo công ty (automation:config | audit:read)
 * - PATCH /automation/rules/:id        — bật/tắt, tham số, phạm vi, ghi đè theo công ty (automation:config)
 * - GET   /automation/runs             — lượt chạy theo bộ lọc: trạng thái, quy tắc, công ty, nguồn
 * - GET   /automation/runs/by-source   — lượt chạy của MỘT phiếu / khoản vay (panel "Quy trình tự động")
 * - POST  /automation/runs/:id/rerun   — chạy lại lượt lỗi, chỉ các bước chưa xong (kế toán trưởng | automation:config)
 *
 * Phạm vi công ty: mọi truy vấn lọc theo phạm vi của người gọi; đối tượng ngoài phạm vi ⇒ FG-RBAC-002.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError, automationRuleCode, automationRuleUpdateBody, automationRunStatus, type Permission } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { assertCompanyScope, defineRoute, newRequestId, requestCtx, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { mirrorAudit } from '../domain/audit/index.ts';
import { getRuleParams, rerunRun } from '../domain/automation/engine.ts';
import { checkRuleParams } from '../domain/automation/params.ts';
import { DEFAULT_DUE_OFFSET_MONTHS, DEFAULT_TERM_MONTHS, intParam } from '../domain/automation/policy.ts';
import { listRules, listRuns, runsForSource } from '../domain/automation/queries.ts';

const oid = z.string().regex(/^[0-9a-f]{24}$/i, 'Mã định dạng không hợp lệ');

/** Ghi đè theo công ty như đang lưu trong DB. */
interface StoredOverride {
  company_id: unknown;
  enabled?: boolean | null;
  params?: Record<string, unknown> | null;
}

/** JSON với khoá sắp xếp — so sánh tham số không phụ thuộc thứ tự khoá. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

/** Quy tắc theo ID (24 ký tự hex) hoặc mã R1…R6. */
async function findRule(idOrCode: string) {
  const byId = oid.safeParse(idOrCode).success ? await Models.AutomationRule.findById(idOrCode).lean<Record<string, unknown> | null>() : null;
  return byId ?? (await Models.AutomationRule.findOne({ code: idOrCode } as never).lean<Record<string, unknown> | null>());
}

/** Công ty của đối tượng nguồn (phiếu / khoản vay), null nếu không tồn tại. */
async function sourceCompanyId(sourceType: string, sourceId: string): Promise<string | null> {
  if (sourceType === 'document') {
    const d = await Models.Document.findById(sourceId).select({ company_id: 1 }).lean<{ company_id: unknown } | null>();
    return d ? String(d.company_id) : null;
  }
  if (sourceType === 'bank_debt') {
    const b = await Models.BankDebt.findById(sourceId).select({ company_id: 1 }).lean<{ company_id: unknown } | null>();
    return b ? String(b.company_id) : null;
  }
  return null;
}

export function automationRoutes(app: FastifyInstance): void {
  /* --------------------------- danh sách quy tắc --------------------------- */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/automation/rules',
      config: {
        perms: [] as Permission[],
        permsAny: ['automation:config', 'audit:read'] as Permission[],
        screen: 'AUTO-01',
        summary: 'Danh sách quy trình tự động và hiệu lực theo công ty',
      },
      schema: { tags: ['automation'] },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const q = validate(z.object({ company_id: oid.optional() }), req.query ?? {});
        const companyId = q.company_id ?? actor.company_id ?? null;
        if (companyId) assertCompanyScope(req, companyId);
        return ok(reply, { data: await listRules(companyId) });
      },
    }),
  );

  /* --------------------------- cấu hình quy tắc --------------------------- */

  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/automation/rules/:id',
      config: { perms: ['automation:config'] as Permission[], screen: 'AUTO-01', summary: 'Bật/tắt, chỉnh tham số và phạm vi quy tắc tự động' },
      schema: { tags: ['automation'] },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(automationRuleUpdateBody, req.body);
        const rule = await findRule(id);
        if (!rule) throw new ApiError({ code: 'FG-VAL-001', status: 404, detail: 'Không tìm thấy quy tắc' });
        const code = String(rule.code);
        const scope = requireScope(req);
        // Cấu hình TOÀN CỤC (công tắc tổng, tham số mặc định, phạm vi công ty) chỉ của người thấy toàn tập đoàn.
        const globalScope = scope.companyIds === null;
        if (!globalScope && (body.enabled !== undefined || body.params !== undefined || body.company_ids !== undefined)) {
          throw new ApiError({
            code: 'FG-RBAC-002',
            detail: 'Chỉ người có phạm vi toàn tập đoàn mới đổi công tắc tổng, tham số mặc định hoặc phạm vi công ty quy tắc',
          });
        }
        const params = body.params !== undefined ? checkRuleParams(code, body.params) : undefined;
        const inScope = (companyId: string): boolean => globalScope || (scope.companyIds ?? []).includes(companyId);
        const stored = (rule.company_overrides as StoredOverride[] | null | undefined) ?? [];

        // Ghi đè: chỉ thay ghi đè của công ty TRONG phạm vi; ghi đè công ty ngoài phạm vi được giữ nguyên
        // (gửi lại đúng như đang lưu thì chấp nhận, đổi thì FG-RBAC-002).
        let overrides: { company_id: string; enabled: boolean; params: Record<string, unknown> }[] | undefined;
        if (body.company_overrides !== undefined) {
          const incoming = new Map<string, { company_id: string; enabled: boolean; params: Record<string, unknown> }>();
          for (const o of body.company_overrides) {
            const entry = { company_id: String(o.company_id), enabled: o.enabled, params: checkRuleParams(code, o.params ?? {}) };
            if (!inScope(entry.company_id)) {
              const prev = stored.find((s) => String(s.company_id) === entry.company_id);
              const unchanged = !!prev && (prev.enabled !== false) === entry.enabled && stableJson(prev.params ?? {}) === stableJson(entry.params);
              if (!unchanged) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Không đổi được cấu hình của công ty ngoài phạm vi của bạn' });
              continue;
            }
            incoming.set(entry.company_id, entry);
          }
          const kept = stored
            .filter((s) => !inScope(String(s.company_id)))
            .map((s) => ({ company_id: String(s.company_id), enabled: s.enabled !== false, params: s.params ?? {} }));
          overrides = [...kept, ...incoming.values()];
        }

        const now = new Date();
        const set: Record<string, unknown> = { updated_at: now };
        const diff: Record<string, unknown> = {};
        if (body.enabled !== undefined) {
          set.enabled = body.enabled;
          diff.enabled = { before: rule.enabled ?? null, after: body.enabled };
        }
        if (params !== undefined) {
          set.params = { ...((rule.params as Record<string, unknown> | undefined) ?? {}), ...params };
          diff.params = params;
        }
        if (body.company_ids !== undefined) {
          set.company_ids = body.company_ids;
          diff.company_ids = body.company_ids;
        }
        if (overrides !== undefined) {
          set.company_overrides = overrides;
          diff.company_overrides = overrides.map((o) => o.company_id);
        }

        // Chống ghi đè mất cập nhật: `if_updated_at` (người dùng đọc) và `updated_at` đọc lúc này phải còn khớp.
        const seenAt = rule.updated_at ? new Date(rule.updated_at as Date) : null;
        if (body.if_updated_at !== undefined && seenAt && new Date(body.if_updated_at).getTime() !== seenAt.getTime()) {
          throw new ApiError({ code: 'FG-WF-011', detail: 'Quy tắc vừa được người khác sửa. Tải lại để xem cấu hình mới nhất.' });
        }
        const res = await Models.AutomationRule.updateOne(
          (seenAt ? { _id: rule._id, updated_at: seenAt } : { _id: rule._id }) as never,
          { $set: set } as never,
        ).exec();
        if (!res.matchedCount) {
          throw new ApiError({ code: 'FG-WF-011', detail: 'Quy tắc vừa được người khác sửa. Tải lại để xem cấu hình mới nhất.' });
        }

        const ctx = requestCtx(req);
        await mirrorAudit({
          at: now,
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'automation.update',
          subject: { type: 'automation_rule', id: String(rule._id), code },
          company_id: null,
          diff_fields: diff,
          request_id: newRequestId(),
          ip: ctx.ip,
        });
        const [view] = (await listRules(actor.company_id ?? null)).filter((r) => r.code === code);
        return ok(reply, { data: view ?? null });
      },
    }),
  );

  /* ------------------ tham số vay mặc định của công ty (form phiếu) ------------------ */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/automation/loan-defaults',
      config: {
        perms: [] as Permission[],
        permsAny: ['doc:create', 'doc:read'] as Permission[],
        screen: 'DOC-01',
        summary: 'Tham số vay mặc định của công ty (kỳ hạn, lệch hạn thanh toán) cho form phiếu thu / chi vay',
      },
      schema: { tags: ['automation'] },
      handler: async (req, reply) => {
        const q = validate(z.object({ company_id: oid }), req.query ?? {});
        assertCompanyScope(req, q.company_id);
        const rows = await Models.AutomationRule.find({ code: { $in: ['R2', 'R3'] } } as never).lean<Record<string, unknown>[]>();
        const paramsOf = (code: string): { term_months: number; due_offset_months: number } => {
          const row = rows.find((r) => r.code === code);
          const params = row ? getRuleParams(row as never, q.company_id) : {};
          return {
            term_months: intParam(params.term_months, DEFAULT_TERM_MONTHS, 1, 600),
            due_offset_months: intParam(params.due_offset_months, DEFAULT_DUE_OFFSET_MONTHS, 0, 600),
          };
        };
        // phiếu thu đi vay (R2) và phiếu chi vay để chi (R3) có tham số riêng theo công ty
        return ok(reply, { data: { company_id: q.company_id, borrow: paramsOf('R2'), fund: paramsOf('R3') } });
      },
    }),
  );

  /* --------------------------- lượt chạy --------------------------- */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/automation/runs',
      config: {
        perms: [] as Permission[],
        permsAny: ['automation:config', 'audit:read'] as Permission[],
        screen: 'AUTO-02',
        summary: 'Lượt chạy quy trình tự động (lọc theo trạng thái, quy tắc, công ty, nguồn)',
      },
      schema: { tags: ['automation'] },
      handler: async (req, reply) => {
        const q = validate(
          z.object({
            status: automationRunStatus.optional(),
            rule_code: automationRuleCode.optional(),
            company_id: oid.optional(),
            source_type: z.string().max(40).optional(),
            source_id: oid.optional(),
            include_skipped: z.enum(['true', 'false']).optional(),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          req.query ?? {},
        );
        const scope = requireScope(req);
        const filter: Record<string, unknown> = {};
        if (q.status) filter.status = q.status;
        if (q.rule_code) filter.rule_code = q.rule_code;
        if (q.source_type) filter.source_type = q.source_type;
        if (q.source_id) filter.source_id = q.source_id;
        // mặc định ẩn lượt mà mọi bước đều "bỏ qua" (quy tắc được kiểm tra nhưng không áp dụng cho đối tượng này)
        if (q.include_skipped !== 'true') filter.steps = { $elemMatch: { status: { $ne: 'skipped' } } };
        if (q.company_id) {
          assertCompanyScope(req, q.company_id);
          filter.company_id = q.company_id;
        } else if (scope.companyIds !== null) {
          filter.company_id = { $in: scope.companyIds };
        }
        return ok(reply, { data: await listRuns(filter, q.limit) });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/automation/runs/by-source',
      config: {
        perms: [] as Permission[],
        permsAny: ['doc:read', 'loan:read'] as Permission[],
        screen: 'AUTO-02',
        summary: 'Quy trình tự động đã chạy cho một phiếu hoặc khoản vay (panel trên hồ sơ)',
      },
      schema: { tags: ['automation'] },
      handler: async (req, reply) => {
        const q = validate(
          z.object({
            source_type: z.enum(['document', 'bank_debt']),
            source_id: oid,
            include_skipped: z.enum(['true', 'false']).optional(),
          }),
          req.query ?? {},
        );
        const companyId = await sourceCompanyId(q.source_type, q.source_id);
        if (!companyId) throw new ApiError({ code: 'FG-VAL-001', status: 404, detail: 'Không tìm thấy đối tượng' });
        assertCompanyScope(req, companyId);
        return ok(reply, { data: await runsForSource(q.source_type, q.source_id, { includeSkipped: q.include_skipped === 'true' }) });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/automation/runs/:id/rerun',
      config: {
        perms: [] as Permission[],
        permsAny: ['doc:read'] as Permission[],
        screen: 'AUTO-02',
        summary: 'Chạy lại lượt tự động bị lỗi (chỉ các bước chưa xong)',
      },
      schema: { tags: ['automation'] },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        if (!oid.safeParse(id).success) throw new ApiError({ code: 'FG-VAL-001', status: 404, detail: 'Không tìm thấy lượt chạy' });
        const run = await Models.AutomationRun.findById(id).select({ company_id: 1 }).lean<{ company_id: unknown } | null>();
        if (!run) throw new ApiError({ code: 'FG-VAL-001', status: 404, detail: 'Không tìm thấy lượt chạy' });
        const canRerun = actor.role === 'chief_accountant' || actor.permissions.includes('automation:config');
        if (!canRerun) throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ kế toán trưởng hoặc người cấu hình tự động được chạy lại' });
        if (run.company_id) assertCompanyScope(req, String(run.company_id));

        await rerunRun(id);
        const [view] = await listRuns({ _id: id }, 1);
        return ok(reply, { data: view ?? null });
      },
    }),
  );
}

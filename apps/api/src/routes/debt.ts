/**
 * Phiếu công nợ (DEBT) — theo chuẩn kế toán VN:
 *   Khách hàng = TK 131 · Nhà cung cấp = TK 331 · Nhân viên = TK 334.
 * Bút toán Nợ/Có chọn tự do (2 chiều). Cấn trừ với phiếu thu/chi TÍNH KHI ĐỌC:
 * một liên kết chỉ được tính khi hồ sơ ở trạng thái `paid` ⇒ phiếu thực thi tự trừ,
 * gỡ liên kết tính lại ngay.
 */

import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import {
  ACCOUNT_CODE_BY_PARTY,
  ApiError,
  daysUntil,
  today,
  type DebtAccountCode,
  type DebtPartyType,
  type Permission,
} from '@fingate/shared';
import { Models } from '../db/models.ts';
import { defineRoute, assertCompanyScope, requestCtx, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { debtLinkBody, debtListQuery, debtVoucherUpsertBody } from '@fingate/shared';
import { debtLinkBodySchema, debtListQuerySchema, debtVoucherUpsertBodySchema } from './schemas.ts';
import { scopedFind } from '../lib/mongo.ts';
import { asBigInt, wire } from '../domain/queries/index.ts';
import { buildHistoryEntry, mirrorAudit } from '../domain/audit/index.ts';
import { nextSequentialCode } from '../domain/numbering/index.ts';
import { storage } from '../storage/index.ts';
import { registerOwnerAttachmentRoutes } from './attachment-owner.ts';
import { ensureCounterparty } from '../domain/counterparty/index.ts';
import { debtAgingBucket, debtStatus, fetchLinkedDocs, settledFromLinks, type LinkedDocInfo, type OffsetLink } from '../domain/debt/index.ts';

interface DebtDoc {
  _id: unknown;
  company_id: unknown;
  code?: string;
  party_type: string;
  party_name: string;
  party_bank_name?: string | null;
  party_bank_account?: string | null;
  account_code: string;
  side: string;
  value_minor?: unknown;
  currency?: string;
  contract_code?: string | null;
  due_date?: string;
  priority?: string;
  note?: string | null;
  document_links?: OffsetLink[];
  attachments?: unknown[];
  history?: unknown[];
  updated_at?: Date | string;
}

function accountCodeFor(partyType: DebtPartyType): DebtAccountCode {
  return ACCOUNT_CODE_BY_PARTY[partyType];
}

function serializeDebt(
  d: DebtDoc,
  opts: { companyName?: string; docs: Map<string, LinkedDocInfo> },
): Record<string, unknown> {
  const value = asBigInt(d.value_minor);
  const links = d.document_links ?? [];
  const settled = settledFromLinks(links, opts.docs);
  const remaining = value - settled;
  const due = String(d.due_date ?? today());
  const overdue = due < today() ? -daysUntil(due) : 0;
  return {
    _id: String(d._id),
    company_id: String(d.company_id),
    company_name: opts.companyName ?? '',
    code: String(d.code ?? ''),
    party_type: d.party_type,
    party_name: d.party_name,
    party_bank_name: d.party_bank_name ?? null,
    party_bank_account: d.party_bank_account ?? null,
    account_code: d.account_code,
    side: d.side,
    value: wire(value, String(d.currency ?? 'VND')),
    settled: wire(settled, String(d.currency ?? 'VND')),
    remaining: wire(remaining, String(d.currency ?? 'VND')),
    currency: String(d.currency ?? 'VND'),
    contract_code: d.contract_code ?? null,
    due_date: due,
    days_overdue: overdue,
    aging_bucket: debtAgingBucket(overdue),
    priority: String(d.priority ?? 'normal'),
    status: debtStatus(value, settled),
    note: d.note ?? null,
    attachment_count: Array.isArray(d.attachments) ? d.attachments.length : 0,
    link_count: links.length,
    updated_at: d.updated_at ? new Date(String(d.updated_at)).toISOString() : null,
  };
}

async function companyNames(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const companies = await Models.Company.find({ _id: { $in: uniq } } as never).select({ name: 1 }).lean();
  return new Map(companies.map((c) => [String(c._id), String(c.name)]));
}

export function debtRoutes(app: FastifyInstance): void {
  app.route(
    defineRoute({
      method: 'GET',
      url: '/debts',
      config: { perms: ['debt:read'] as Permission[], screen: 'DEBT-01', summary: 'Danh sách phiếu công nợ' },
      schema: { tags: ['debt'], querystring: debtListQuerySchema },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(debtListQuery, req.query);
        const filter: Record<string, unknown> = {};
        if (q.party_type) filter.party_type = q.party_type;
        if (q.side) filter.side = q.side;
        if (q.company_id) filter.company_id = q.company_id;
        if (q.counterparty) {
          const rx = { $regex: q.counterparty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
          filter.$or = [{ party_name: rx }, { party_bank_name: rx }, { party_bank_account: rx }];
        }
        if (q.overdue_only === 'true') filter.due_date = { $lt: today() };
        const rows = await scopedFind<Record<string, unknown>>(Models.DebtVoucher, scope, filter, {
          sort: q.sort === 'value' ? { value_minor: -1 } : { due_date: 1 },
          limit: q.limit,
        });
        const withLinks = rows as unknown as DebtDoc[];
        const docMap = await fetchLinkedDocs(withLinks.flatMap((d) => (d.document_links ?? []).map((l) => String(l.document_id))));
        const cnames = await companyNames(withLinks.map((d) => String(d.company_id)));
        let items = withLinks.map((d) => serializeDebt(d, { companyName: cnames.get(String(d.company_id)), docs: docMap }));
        if (q.overdue_only === 'true') items = items.filter((r) => asBigInt((r.value as { minor: string }).minor) - asBigInt((r.settled as { minor: string }).minor) > 0n);
        const total = items.reduce((a, r) => a + asBigInt((r.remaining as { minor: string }).minor), 0n);
        return ok(reply, { items, total: items.length, totals: { remaining: wire(total) } }, { maxAge: 15 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/debts/aging',
      config: { perms: ['debt:read'] as Permission[], screen: 'DEBT-05', summary: 'Ma trận tuổi nợ' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const partyType = (req.query as { party_type?: string }).party_type as DebtPartyType | undefined;
        const filter: Record<string, unknown> = {};
        if (partyType) filter.party_type = partyType;
        const rows = (await scopedFind<Record<string, unknown>>(Models.DebtVoucher, scope, filter, { limit: 1000 })) as unknown as DebtDoc[];
        const docMap = await fetchLinkedDocs(rows.flatMap((d) => (d.document_links ?? []).map((l) => String(l.document_id))));
        const cnames = await companyNames(rows.map((d) => String(d.company_id)));
        const buckets = ['none', 'lt30', 'd30_60', 'd60_90', 'gt90'] as const;
        const byParty = new Map<string, { company: string; cells: Record<string, { amount: bigint; count: number }> }>();
        for (const d of rows) {
          const value = asBigInt(d.value_minor);
          const settled = settledFromLinks(d.document_links, docMap);
          const remaining = value - settled;
          if (remaining <= 0n) continue;
          const overdue = d.due_date && String(d.due_date) < today() ? -daysUntil(String(d.due_date)) : 0;
          const b = debtAgingBucket(overdue);
          const key = `${String(d.company_id)}|${d.party_name}`;
          const cur = byParty.get(key) ?? { company: String(d.company_id), cells: Object.fromEntries(buckets.map((x) => [x, { amount: 0n, count: 0 }])) };
          const cell = cur.cells[b] ?? { amount: 0n, count: 0 };
          cur.cells[b] = { amount: cell.amount + remaining, count: cell.count + 1 };
          byParty.set(key, cur);
        }
        const totals = Object.fromEntries(buckets.map((b) => [b, [...byParty.values()].reduce((a, p) => a + (p.cells[b]?.amount ?? 0n), 0n)]));
        return ok(
          reply,
          {
            data: {
              party_type: partyType ?? null,
              columns: buckets.map((b) => ({ bucket: b, label: debtAgingBucketLabel(b) })),
              rows: [...byParty.entries()].map(([key, p]) => ({
                counterparty: key.split('|')[1] ?? '',
                company_name: cnames.get(p.company) ?? '',
                cells: buckets.map((b) => ({ bucket: b, amount: wire(p.cells[b]?.amount ?? 0n), count: p.cells[b]?.count ?? 0 })),
                total: wire(buckets.reduce((a, b) => a + (p.cells[b]?.amount ?? 0n), 0n)),
              })),
              totals: buckets.map((b) => ({ bucket: b, amount: wire(totals[b] ?? 0n) })),
            },
          },
          { maxAge: 60 },
        );
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/debts',
      config: { perms: ['debt:write'] as Permission[], screen: 'DEBT-01', summary: 'Tạo phiếu công nợ' },
      schema: { tags: ['debt'], body: debtVoucherUpsertBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(debtVoucherUpsertBody, req.body);
        const companyId = body.company_id ?? actor.company_id;
        if (!companyId) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Chưa chọn công ty' });
        assertCompanyScope(req, companyId);
        const minor = BigInt(body.value.amount_minor);
        if (minor <= 0n) throw new ApiError({ code: 'FG-VAL-001', errors: { value: 'Số tiền phải lớn hơn 0' } });
        const code = await nextSequentialCode('CN');
        const accountCode = accountCodeFor(body.party_type);
        const history = buildHistoryEntry({
          action: 'create',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: null,
          ip: requestCtx(req).ip,
          fields: { account_code: accountCode, side: body.side },
        });
        const created = await Models.DebtVoucher.create({
          code,
          company_id: companyId,
          party_type: body.party_type,
          party_name: body.party_name,
          party_bank_name: body.party_bank_name ?? null,
          party_bank_account: body.party_bank_account ?? null,
          counterparty_id: await ensureCounterparty({
            name: body.party_name,
            bank_name: body.party_bank_name ?? null,
            account_number: body.party_bank_account ?? null,
            created_by: actor.user_id,
          }),
          account_code: accountCode,
          side: body.side,
          value_minor: minor,
          value: { minor, currency: body.value.currency, decimals: 0 },
          currency: body.value.currency,
          contract_code: body.contract_code ?? null,
          due_date: body.due_date,
          priority: body.priority,
          note: body.note ?? null,
          created_by: actor.user_id,
          history: [history],
        } as never);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'debt.create',
          subject: { type: 'debt', id: String(created._id), code },
          company_id: companyId,
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { _id: String(created._id), code } }, { status: 201 });
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
        const d = await Models.DebtVoucher.findById(id).lean<DebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy phiếu công nợ' });
        assertCompanyScope(req, String(d.company_id));
        const docMap = await fetchLinkedDocs((d.document_links ?? []).map((l) => String(l.document_id)));
        const cnames = await companyNames([String(d.company_id)]);
        const data = serializeDebt(d, { companyName: cnames.get(String(d.company_id)), docs: docMap });
        data.document_links = (d.document_links ?? []).map((l) => {
          const info = docMap.get(String(l.document_id));
          return {
            _id: String(l._id ?? ''),
            document_id: String(l.document_id),
            document_code: info?.code ?? '',
            document_title: info?.title ?? '',
            document_kind: info?.kind ?? '',
            document_status: info?.status ?? 'unknown',
            amount: wire(asBigInt(l.amount_minor)),
            linked_at: l.linked_at ? new Date(String(l.linked_at)).toISOString() : null,
            note: l.note ?? null,
          };
        });
        data.history = (d.history ?? []) as unknown[];
        data.note = d.note ?? null;
        data.attachments = mapOwnerAttachments(d.attachments);
        return ok(reply, { data });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/debts/:id',
      config: { perms: ['debt:update'] as Permission[], screen: 'DEBT-02', summary: 'Sửa phiếu công nợ' },
      schema: { tags: ['debt'], body: debtVoucherUpsertBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(debtVoucherUpsertBody.partial(), req.body);
        const d = await Models.DebtVoucher.findById(id).lean<DebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        assertCompanyScope(req, String(d.company_id));
        const set: Record<string, unknown> = { updated_at: new Date() };
        if (body.party_type) {
          set.party_type = body.party_type;
          set.account_code = accountCodeFor(body.party_type);
        }
        if (body.party_name !== undefined) set.party_name = body.party_name;
        if (body.party_bank_name !== undefined) set.party_bank_name = body.party_bank_name || null;
        if (body.party_bank_account !== undefined) set.party_bank_account = body.party_bank_account || null;
        if (body.party_name !== undefined || body.party_bank_name !== undefined || body.party_bank_account !== undefined) {
          set.counterparty_id = await ensureCounterparty({
            name: body.party_name ?? d.party_name,
            bank_name: (body.party_bank_name !== undefined ? body.party_bank_name : d.party_bank_name) ?? null,
            account_number: (body.party_bank_account !== undefined ? body.party_bank_account : d.party_bank_account) ?? null,
            created_by: actor.user_id,
          });
        }
        if (body.side !== undefined) set.side = body.side;
        if (body.value) {
          const minor = BigInt(body.value.amount_minor);
          if (minor <= 0n) throw new ApiError({ code: 'FG-VAL-001', errors: { value: 'Số tiền phải lớn hơn 0' } });
          set.value_minor = minor;
          set.value = { minor, currency: body.value.currency, decimals: 0 };
          set.currency = body.value.currency;
        }
        if (body.due_date !== undefined) set.due_date = body.due_date;
        if (body.contract_code !== undefined) set.contract_code = body.contract_code || null;
        if (body.priority !== undefined) set.priority = body.priority;
        if (body.note !== undefined) set.note = body.note || null;
        const history = buildHistoryEntry({
          action: 'update',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: null,
          ip: requestCtx(req).ip,
          fields: { changed: Object.keys(set).filter((k) => k !== 'updated_at') },
        });
        await Models.DebtVoucher.updateOne({ _id: id }, { $set: set, $push: { history } }).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'debt.update',
          subject: { type: 'debt', id, code: String(d.code ?? '') },
          company_id: String(d.company_id),
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /** Xoá phiếu công nợ (chỉ KTT trở lên — quyền `debt:delete`, thu hồi được per-user). */
  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/debts/:id',
      config: { perms: ['debt:delete'] as Permission[], screen: 'DEBT-02', summary: 'Xoá phiếu công nợ' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const d = await Models.DebtVoucher.findById(id).lean<DebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy phiếu công nợ' });
        assertCompanyScope(req, String(d.company_id));

        // Xoá chứng từ đính kèm (best-effort) — metadata mirror + file trên storage.
        for (const raw of (d.attachments ?? []) as Record<string, unknown>[]) {
          const key = raw.key ? String(raw.key) : '';
          if (key) await storage().remove(key).catch(() => undefined);
        }
        await Models.Attachment.deleteMany({ owner_type: 'debt', owner_id: d._id } as never).exec();
        await Models.DebtVoucher.deleteOne({ _id: id }).exec();

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'debt.delete',
          subject: { type: 'debt', id, code: String(d.code ?? '') },
          company_id: String(d.company_id),
          diff_fields: { party_name: d.party_name, value_minor: asBigInt(d.value_minor).toString(), links: (d.document_links ?? []).length },
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /* --------------------------- liên kết cấn trừ --------------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/debts/:id/links',
      config: { perms: ['debt:write'] as Permission[], screen: 'DEBT-02', summary: 'Liên kết phiếu thu/chi để cấn trừ' },
      schema: { tags: ['debt'], body: debtLinkBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(debtLinkBody, req.body);
        const d = await Models.DebtVoucher.findById(id).lean<DebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        assertCompanyScope(req, String(d.company_id));
        const doc = await Models.Document.findById(body.document_id).select({ amount: 1, code: 1, status: 1, company_id: 1 }).lean<{
          amount?: { minor?: unknown };
          code?: string;
          company_id?: unknown;
        } | null>();
        if (!doc) throw new ApiError({ code: 'FG-VAL-001', errors: { document_id: 'Không tìm thấy hồ sơ' } });
        assertCompanyScope(req, doc.company_id ? String(doc.company_id) : null);
        if ((d.document_links ?? []).some((l) => String(l.document_id) === body.document_id)) {
          throw new ApiError({ code: 'FG-VAL-001', errors: { document_id: 'Hồ sơ này đã được liên kết' } });
        }
        const amount = body.amount_minor ? BigInt(body.amount_minor) : asBigInt(doc.amount?.minor);
        if (amount <= 0n) throw new ApiError({ code: 'FG-VAL-001', errors: { amount_minor: 'Số tiền phải lớn hơn 0' } });
        const linkId = new Types.ObjectId();
        const history = buildHistoryEntry({
          action: 'link_document',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: null,
          ip: requestCtx(req).ip,
          fields: { document_id: body.document_id, document_code: doc.code, amount_minor: amount.toString() },
        });
        await Models.DebtVoucher.updateOne(
          { _id: id },
          {
            $push: {
              document_links: { _id: linkId, document_id: body.document_id, amount_minor: amount, linked_by: actor.user_id, note: body.note ?? null },
              history,
            },
            $set: { updated_at: new Date() },
          },
        ).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'debt.link',
          subject: { type: 'debt', id, code: String(d.code ?? '') },
          company_id: String(d.company_id),
          diff_fields: { document_id: body.document_id, amount_minor: amount.toString() },
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { _id: String(linkId) } }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/debts/:id/links/:linkId',
      config: { perms: ['debt:write'] as Permission[], screen: 'DEBT-02', summary: 'Gỡ liên kết cấn trừ' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id, linkId } = req.params as { id: string; linkId: string };
        const d = await Models.DebtVoucher.findById(id).lean<DebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        assertCompanyScope(req, String(d.company_id));
        const link = (d.document_links ?? []).find((l) => String(l._id) === linkId);
        if (!link) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy liên kết' });
        const history = buildHistoryEntry({
          action: 'unlink_document',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: null,
          ip: requestCtx(req).ip,
          fields: { document_id: String(link.document_id) },
        });
        await Models.DebtVoucher.updateOne(
          { _id: id },
          { $pull: { document_links: { _id: new Types.ObjectId(linkId) } }, $push: { history }, $set: { updated_at: new Date() } },
        ).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'debt.unlink',
          subject: { type: 'debt', id, code: String(d.code ?? '') },
          company_id: String(d.company_id),
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/debts/:id/link-candidates',
      config: { perms: ['debt:read'] as Permission[], screen: 'DEBT-02', summary: 'Hồ sơ thu/chi khả dụng để cấn trừ' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        const d = await Models.DebtVoucher.findById(id).select({ company_id: 1, document_links: 1 }).lean<DebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        assertCompanyScope(req, String(d.company_id));
        const linked = new Set((d.document_links ?? []).map((l) => String(l.document_id)));
        const q = (req.query as { q?: string }).q;
        const filter: Record<string, unknown> = { kind: { $in: ['income', 'spend'] } };
        if (q) filter.$or = [{ code: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { title: { $regex: q, $options: 'i' } }];
        const rows = await scopedFind<Record<string, unknown>>(Models.Document, scope, filter, { sort: { updated_at: -1 }, limit: 50 });
        return ok(
          reply,
          {
            items: rows.map((r) => ({
              _id: String(r._id),
              code: String(r.code ?? ''),
              title: String(r.title ?? ''),
              kind: String(r.kind ?? ''),
              status: String(r.status ?? ''),
              amount: wire(asBigInt((r.amount as { minor?: unknown } | undefined)?.minor)),
              already_linked: linked.has(String(r._id)),
            })),
          },
          { maxAge: 0 },
        );
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

function debtAgingBucketLabel(b: string): string {
  return { none: 'Chưa đến hạn', lt30: 'Quá hạn < 30 ngày', d30_60: '30–60 ngày', d60_90: '60–90 ngày', gt90: '> 90 ngày' }[b] ?? b;
}

/** Chuẩn hoá mảng attachment nhúng để FE hiển thị + tải. */
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

/**
 * Nợ Ngân hàng — phiếu nợ gồm ngân hàng, chi nhánh, số tiền vay, lãi suất, hạn thanh toán,
 * hợp đồng đính kèm (PDF/ảnh ≤100MB). Gán phiếu chi để đánh dấu đã trả nợ.
 *
 * Dư nợ = số tiền vay − Σ(phiếu chi đã trả) — tính khi đọc, cấp dữ liệu cho Đáo hạn.
 */

import type { FastifyInstance } from 'fastify';
import { Types } from 'mongoose';
import { ApiError, daysBetween, daysUntil, today, vnDate, type Permission, type RepaymentFrequency, type RepaymentMethod } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { assertCompanyScope, defineRoute, requestCtx, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { bankDebtRepayBody, bankDebtUpsertBody } from '@fingate/shared';
import { bankDebtRepayBodySchema, bankDebtUpsertBodySchema } from './schemas.ts';
import { scopedFind } from '../lib/mongo.ts';
import { asBigInt, wire } from '../domain/queries/index.ts';
import { buildHistoryEntry, mirrorAudit } from '../domain/audit/index.ts';
import { nextSequentialCode } from '../domain/numbering/index.ts';
import { storage } from '../storage/index.ts';
import { registerOwnerAttachmentRoutes } from './attachment-owner.ts';
import { mapOwnerAttachments } from './debt.ts';
import { fetchLinkedDocs, settledFromLinks, type LinkedDocInfo, type OffsetLink } from '../domain/debt/index.ts';
import { addMonths, buildSchedule, parseRate, simpleInterest } from '../domain/loan-schedule/index.ts';

interface BankDebtDoc {
  _id: unknown;
  company_id: unknown;
  code?: string;
  bank_name: string;
  credit_limit_minor?: unknown;
  principal_minor?: unknown;
  outstanding_minor?: unknown;
  currency?: string;
  interest_rate?: string;
  term_months?: number | null;
  payment_frequency?: string;
  repayment_method?: string;
  maturity_date?: string;
  next_due_date?: string | null;
  status?: string;
  repayment_links?: OffsetLink[];
  attachments?: unknown[];
  history?: unknown[];
  note?: string | null;
  created_at?: Date | string;
  updated_at?: Date | string;
}

function derivedOutstanding(d: BankDebtDoc, docs: Map<string, LinkedDocInfo>): { principal: bigint; repaid: bigint; outstanding: bigint } {
  const principal = asBigInt(d.principal_minor);
  const repaid = settledFromLinks(d.repayment_links, docs);
  const outstanding = principal - repaid > 0n ? principal - repaid : 0n;
  return { principal, repaid, outstanding };
}

function derivedStatus(d: BankDebtDoc, outstanding: bigint): 'active' | 'overdue' | 'settled' | 'archived' {
  if (d.status === 'archived') return 'archived';
  if (outstanding <= 0n) return 'settled';
  const due = String(d.next_due_date || d.maturity_date || today());
  return due < today() ? 'overdue' : 'active';
}

function serializeBankDebt(
  d: BankDebtDoc,
  opts: { companyName?: string; docs: Map<string, LinkedDocInfo> },
): Record<string, unknown> {
  const { principal, repaid, outstanding } = derivedOutstanding(d, opts.docs);
  const due = String(d.maturity_date ?? today());
  const nextDue = d.next_due_date ? String(d.next_due_date) : null;
  const interest = simpleInterest(outstanding, parseRate(d.interest_rate), Math.max(0, daysUntil(nextDue || due)));
  return {
    _id: String(d._id),
    company_id: String(d.company_id),
    company_name: opts.companyName ?? '',
    code: String(d.code ?? ''),
    bank_name: d.bank_name,
    credit_limit: wire(asBigInt(d.credit_limit_minor), String(d.currency ?? 'VND')),
    principal: wire(principal, String(d.currency ?? 'VND')),
    outstanding: wire(outstanding, String(d.currency ?? 'VND')),
    repaid: wire(repaid, String(d.currency ?? 'VND')),
    currency: String(d.currency ?? 'VND'),
    interest_rate: String(d.interest_rate ?? '0'),
    term_months: d.term_months ?? null,
    payment_frequency: String(d.payment_frequency ?? 'maturity'),
    repayment_method: String(d.repayment_method ?? 'interest_only'),
    interest_to_maturity: wire(interest, String(d.currency ?? 'VND')),
    maturity_date: due,
    next_due_date: nextDue,
    days_to_due: daysUntil(nextDue || due),
    status: derivedStatus(d, outstanding),
    note: d.note ?? null,
    attachment_count: Array.isArray(d.attachments) ? d.attachments.length : 0,
    repayment_count: (d.repayment_links ?? []).length,
    updated_at: d.updated_at ? new Date(String(d.updated_at)).toISOString() : null,
  };
}

async function companyNames(ids: string[]): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const companies = await Models.Company.find({ _id: { $in: uniq } } as never).select({ name: 1 }).lean();
  return new Map(companies.map((c) => [String(c._id), String(c.name)]));
}

export function bankDebtRoutes(app: FastifyInstance): void {
  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-debts',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-01', summary: 'Danh sách nợ ngân hàng' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const status = (req.query as { status?: string }).status;
        const filter: Record<string, unknown> = {};
        const rows = (await scopedFind<Record<string, unknown>>(Models.BankDebt, scope, filter, {
          sort: { maturity_date: 1 },
          limit: 200,
        })) as unknown as BankDebtDoc[];
        const docMap = await fetchLinkedDocs(rows.flatMap((d) => (d.repayment_links ?? []).map((l) => String(l.document_id))));
        const cnames = await companyNames(rows.map((d) => String(d.company_id)));
        let items = rows.map((d) => serializeBankDebt(d, { companyName: cnames.get(String(d.company_id)), docs: docMap }));
        if (status) items = items.filter((r) => r.status === status);
        const total = items.reduce((a, r) => a + asBigInt((r.outstanding as { minor: string }).minor), 0n);
        return ok(reply, { items, totals: { outstanding: wire(total), count: items.length } }, { maxAge: 15 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-debts',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-03', summary: 'Tạo phiếu nợ ngân hàng' },
      schema: { tags: ['bank-debts'], body: bankDebtUpsertBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(bankDebtUpsertBody, req.body);
        const companyId = body.company_id ?? actor.company_id;
        if (!companyId) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Chưa chọn công ty' });
        assertCompanyScope(req, companyId);
        const minor = BigInt(body.amount.amount_minor);
        if (minor <= 0n) throw new ApiError({ code: 'FG-VAL-001', errors: { amount: 'Số tiền vay phải lớn hơn 0' } });
        const code = await nextSequentialCode('NHD');
        const history = buildHistoryEntry({
          action: 'create',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: null,
          ip: requestCtx(req).ip,
          fields: { bank_name: body.bank_name, amount_minor: minor.toString() },
        });
        const creditLimit = body.credit_limit ? BigInt(body.credit_limit.amount_minor) : 0n;
        const created = await Models.BankDebt.create({
          code,
          company_id: companyId,
          bank_name: body.bank_name,
          principal_minor: minor,
          credit_limit_minor: creditLimit,
          outstanding_minor: minor,
          amount: { minor, currency: body.currency, decimals: 0 },
          currency: body.currency,
          interest_rate: body.interest_rate,
          term_months: body.term_months ?? null,
          payment_frequency: body.payment_frequency,
          repayment_method: body.repayment_method,
          maturity_date: body.maturity_date,
          next_due_date: body.maturity_date,
          status: 'active',
          note: body.note ?? null,
          created_by: actor.user_id,
          history: [history],
        } as never);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'bank_debt.create',
          subject: { type: 'bank_debt', id: String(created._id), code },
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
      url: '/bank-debts/:id',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-02', summary: 'Chi tiết khoản nợ ngân hàng' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const d = await Models.BankDebt.findById(id).lean<BankDebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy khoản nợ' });
        assertCompanyScope(req, String(d.company_id));
        const docMap = await fetchLinkedDocs((d.repayment_links ?? []).map((l) => String(l.document_id)));
        const cnames = await companyNames([String(d.company_id)]);
        const data = serializeBankDebt(d, { companyName: cnames.get(String(d.company_id)), docs: docMap });
        data.repayment_links = (d.repayment_links ?? []).map((l) => {
          const info = docMap.get(String(l.document_id));
          return {
            _id: String(l._id ?? ''),
            document_id: String(l.document_id),
            document_code: info?.code ?? '',
            document_title: info?.title ?? '',
            document_status: info?.status ?? 'unknown',
            amount: wire(asBigInt(l.amount_minor)),
            linked_at: l.linked_at ? new Date(String(l.linked_at)).toISOString() : null,
            note: l.note ?? null,
          };
        });
        data.history = (d.history ?? []) as unknown[];
        data.attachments = mapOwnerAttachments(d.attachments);
        return ok(reply, { data });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/bank-debts/:id',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-02', summary: 'Sửa khoản nợ ngân hàng' },
      schema: { tags: ['bank-debts'], body: bankDebtUpsertBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(bankDebtUpsertBody.partial(), req.body);
        const d = await Models.BankDebt.findById(id).lean<BankDebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        assertCompanyScope(req, String(d.company_id));
        const set: Record<string, unknown> = { updated_at: new Date() };
        if (body.bank_name !== undefined) set.bank_name = body.bank_name;
        if (body.credit_limit !== undefined) set.credit_limit_minor = BigInt(body.credit_limit?.amount_minor ?? 0);
        if (body.amount) {
          const minor = BigInt(body.amount.amount_minor);
          if (minor <= 0n) throw new ApiError({ code: 'FG-VAL-001', errors: { amount: 'Số tiền vay phải lớn hơn 0' } });
          set.principal_minor = minor;
          set.amount = { minor, currency: body.amount.currency, decimals: 0 };
          set.currency = body.amount.currency;
        }
        if (body.interest_rate !== undefined) set.interest_rate = body.interest_rate;
        if (body.term_months !== undefined) set.term_months = body.term_months ?? null;
        if (body.payment_frequency !== undefined) set.payment_frequency = body.payment_frequency;
        if (body.repayment_method !== undefined) set.repayment_method = body.repayment_method;
        if (body.maturity_date !== undefined) set.maturity_date = body.maturity_date;
        if (body.note !== undefined) set.note = body.note || null;
        const history = buildHistoryEntry({
          action: 'update',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: null,
          ip: requestCtx(req).ip,
          fields: { changed: Object.keys(set).filter((k) => k !== 'updated_at') },
        });
        await Models.BankDebt.updateOne({ _id: id }, { $set: set, $push: { history } }).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'bank_debt.update',
          subject: { type: 'bank_debt', id, code: String(d.code ?? '') },
          company_id: String(d.company_id),
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /* ------------------------ LOAN-04 · lịch nghĩa vụ trả nợ ------------------------ */

  /** Xoá khoản nợ ngân hàng (KTT trở lên — quyền `loan:write`). */
  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/bank-debts/:id',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-02', summary: 'Xoá khoản nợ ngân hàng' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const d = await Models.BankDebt.findById(id).lean<BankDebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy khoản nợ' });
        assertCompanyScope(req, String(d.company_id));

        // Xoá chứng từ đính kèm (best-effort) — file trên storage + metadata mirror.
        for (const raw of (d.attachments ?? []) as Record<string, unknown>[]) {
          const key = raw.key ? String(raw.key) : '';
          if (key) await storage().remove(key).catch(() => undefined);
        }
        await Models.Attachment.deleteMany({ owner_type: 'loan', owner_id: d._id } as never).exec();
        await Models.BankDebt.deleteOne({ _id: id }).exec();

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'bank_debt.delete',
          subject: { type: 'bank_debt', id, code: String(d.code ?? '') },
          company_id: String(d.company_id),
          diff_fields: { bank_name: d.bank_name, principal_minor: asBigInt(d.principal_minor).toString(), repayments: (d.repayment_links ?? []).length },
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-debts/:id/schedule',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-04', summary: 'Lịch nghĩa vụ trả nợ (gốc + lãi + phí)' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const d = await Models.BankDebt.findById(id).lean<BankDebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy khoản nợ' });
        assertCompanyScope(req, String(d.company_id));
        const currency = String(d.currency ?? 'VND');
        const maturity = String(d.maturity_date ?? today());
        const start = d.term_months
          ? addMonths(maturity, -d.term_months)
          : d.created_at
            ? vnDate(d.created_at)
            : maturity;
        const termMonths = d.term_months ?? Math.max(1, Math.round(daysBetween(start, maturity) / 30));
        const frequency = (d.payment_frequency ?? 'maturity') as RepaymentFrequency;
        const method = (d.repayment_method ?? 'interest_only') as RepaymentMethod;
        const sched = buildSchedule({
          principalMinor: asBigInt(d.principal_minor),
          rate: d.interest_rate,
          maturityDate: maturity,
          startDate: start,
          frequency,
          method,
        });
        const rows = sched.rows.map((r) => ({
          period: r.period,
          due_date: r.due_date,
          days: r.days,
          principal: wire(r.principal, currency),
          interest: wire(r.interest, currency),
          fee: wire(r.fee, currency),
          total: wire(r.total, currency),
          status: r.due_date < today() ? 'overdue' : r.due_date === today() ? 'due' : 'upcoming',
        }));
        return ok(
          reply,
          {
            data: {
              loan_id: String(d._id),
              contract_code: String(d.code ?? ''),
              bank_name: String(d.bank_name),
              currency,
              interest_rate: String(d.interest_rate ?? '0'),
              term_months: termMonths,
              payment_frequency: frequency,
              repayment_method: method,
              start_date: start,
              maturity_date: maturity,
              rows,
              totals: {
                principal: wire(sched.totals.principal, currency),
                interest: wire(sched.totals.interest, currency),
                fee: wire(sched.totals.fee, currency),
                total: wire(sched.totals.total, currency),
              },
            },
          },
          { maxAge: 30 },
        );
      },
    }),
  );

  /* --------------------------- gán phiếu chi trả nợ --------------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-debts/:id/repayments',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-02', summary: 'Gán phiếu chi để đánh dấu đã trả nợ' },
      schema: { tags: ['bank-debts'], body: bankDebtRepayBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(bankDebtRepayBody, req.body);
        const d = await Models.BankDebt.findById(id).lean<BankDebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        assertCompanyScope(req, String(d.company_id));
        const doc = await Models.Document.findById(body.document_id)
          .select({ amount: 1, execution: 1, code: 1, kind: 1, company_id: 1 })
          .lean<{ amount?: { minor?: unknown }; execution?: { actual_amount_minor?: unknown; actual_amount?: { minor?: unknown } } | null; code?: string; kind?: string; company_id?: unknown } | null>();
        if (!doc) throw new ApiError({ code: 'FG-VAL-001', errors: { document_id: 'Không tìm thấy hồ sơ' } });
        if (String(doc.kind) !== 'spend') throw new ApiError({ code: 'FG-VAL-001', errors: { document_id: 'Chỉ gán được phiếu chi' } });
        assertCompanyScope(req, doc.company_id ? String(doc.company_id) : null);
        if ((d.repayment_links ?? []).some((l) => String(l.document_id) === body.document_id)) {
          throw new ApiError({ code: 'FG-VAL-001', errors: { document_id: 'Phiếu này đã được gán' } });
        }
        const actual = asBigInt(doc.execution?.actual_amount_minor ?? doc.execution?.actual_amount?.minor ?? 0n);
        const amount = body.amount_minor ? BigInt(body.amount_minor) : actual > 0n ? actual : asBigInt(doc.amount?.minor);
        if (amount <= 0n) throw new ApiError({ code: 'FG-VAL-001', errors: { amount_minor: 'Số tiền phải lớn hơn 0' } });
        const linkId = new Types.ObjectId();
        const history = buildHistoryEntry({
          action: 'repay_link',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: null,
          ip: requestCtx(req).ip,
          fields: { document_id: body.document_id, document_code: doc.code, amount_minor: amount.toString() },
        });
        await Models.BankDebt.updateOne(
          { _id: id },
          {
            $push: {
              repayment_links: { _id: linkId, document_id: body.document_id, amount_minor: amount, linked_by: actor.user_id, note: body.note ?? null },
              history,
            },
            $set: { updated_at: new Date() },
          },
        ).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'bank_debt.repay',
          subject: { type: 'bank_debt', id, code: String(d.code ?? '') },
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
      url: '/bank-debts/:id/repayments/:linkId',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-02', summary: 'Gỡ phiếu chi trả nợ' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id, linkId } = req.params as { id: string; linkId: string };
        const d = await Models.BankDebt.findById(id).lean<BankDebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        assertCompanyScope(req, String(d.company_id));
        const link = (d.repayment_links ?? []).find((l) => String(l._id) === linkId);
        if (!link) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy liên kết' });
        const history = buildHistoryEntry({
          action: 'repay_unlink',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: null,
          ip: requestCtx(req).ip,
          fields: { document_id: String(link.document_id) },
        });
        await Models.BankDebt.updateOne(
          { _id: id },
          { $pull: { repayment_links: { _id: new Types.ObjectId(linkId) } }, $push: { history }, $set: { updated_at: new Date() } },
        ).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'bank_debt.unrepay',
          subject: { type: 'bank_debt', id, code: String(d.code ?? '') },
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
      url: '/bank-debts/:id/repayment-candidates',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-02', summary: 'Phiếu chi khả dụng để gán trả nợ' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        const d = await Models.BankDebt.findById(id).select({ company_id: 1, repayment_links: 1 }).lean<BankDebtDoc | null>();
        if (!d) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        assertCompanyScope(req, String(d.company_id));
        const linked = new Set((d.repayment_links ?? []).map((l) => String(l.document_id)));
        const q = (req.query as { q?: string }).q;
        const filter: Record<string, unknown> = { kind: 'spend' };
        if (q) filter.$or = [{ code: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }, { title: { $regex: q, $options: 'i' } }];
        const rows = await scopedFind<Record<string, unknown>>(Models.Document, scope, filter, { sort: { updated_at: -1 }, limit: 50 });
        return ok(
          reply,
          {
            items: rows.map((r) => ({
              _id: String(r._id),
              code: String(r.code ?? ''),
              title: String(r.title ?? ''),
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
    kind: 'loan',
    model: 'BankDebt',
    base: '/bank-debts',
    permWrite: 'loan:write',
    screen: 'LOAN-02',
    subjectType: 'bank_debt',
    label: 'khoản nợ ngân hàng',
  });
}

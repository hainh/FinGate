/**
 * Nợ Ngân hàng (v2/v2.md §10, §11.4–11.5, US-AUTO-08) — khoản vay gắn ĐỐI TÁC ngân hàng (không nhập tên tự do):
 *   · Vòng đời: chờ giải ngân → đang vay → quá hạn / tất toán; huỷ (khi chờ giải ngân); lưu trữ (đã tất toán).
 *   · Giải ngân = liên kết `disbursement` (phiếu thu cùng ngân hàng); trả nợ = `repayment` (phiếu chi, tách gốc/lãi/phí).
 *   · Dư nợ = gốc − Σ phần GỐC của phiếu chi đã thực thi (suy ra khi đọc). Khoản chờ giải ngân không vào dư nợ.
 * Logic nằm ở `domain/debt/loans.ts`; file này chỉ nối HTTP ↔ domain.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { bankDebtImportBody, daysBetween, today, toJsonSchema, vnDate, type Permission, type RepaymentFrequency, type RepaymentMethod } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { defineRoute, requestCtx, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { storage } from '../storage/index.ts';
import { mirrorAudit } from '../domain/audit/index.ts';
import { registerOwnerAttachmentRoutes } from './attachment-owner.ts';
import { mapOwnerAttachments } from './debt.ts';
import { toBigInt } from '../domain/debt/index.ts';
import { assertInScope, loadPartners } from '../domain/debt/loads.ts';
import { wireMoney } from '../domain/debt/rules.ts';
import type { DebtActor, ReqMeta } from '../domain/debt/debts.ts';
import {
  archiveLoan,
  assertLoanDeletable,
  assignDisbursement,
  assignRepayment,
  cancelPendingLoan,
  createLoan,
  deleteLoanRecord,
  getLoanDetail,
  importLoans,
  listLoans,
  loadLoanOrFail,
  loanCandidates,
  unassignLoanLink,
  updateLoan,
} from '../domain/debt/loans.ts';
import { linkCandidatesQuery, loanCancelBody, loanCreateBody, loanDisbursementBody, loanListQuery, loanRepaymentBody, loanUpdateBody, unlinkBody } from '../domain/debt/bodies.ts';
import { addMonths, buildSchedule } from '../domain/loan-schedule/index.ts';
import { bankDebtImportBodySchema } from './schemas.ts';

const j = toJsonSchema;

function actorOf(req: FastifyRequest): DebtActor {
  const a = requireActor(req);
  return { user_id: a.user_id, name: a.name, role: a.role, company_id: a.company_id };
}

function metaOf(req: FastifyRequest): ReqMeta {
  return { ip: requestCtx(req).ip, request_id: null };
}

/** Quyền gán / gỡ liên kết giải ngân & trả nợ: quyền ghi khoản vay + quản lý liên kết (v2 §3.2). */
const LINK_PERMS: Permission[] = ['loan:write', 'link:manage'];

/** Lý do gỡ: BẮT BUỘC trong body (v2 §11.2 — không mặc định do server điền). */
function reasonOf(req: FastifyRequest): string {
  return validate(unlinkBody, req.body ?? {}).reason;
}

export function bankDebtRoutes(app: FastifyInstance): void {
  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-debts',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-01', summary: 'Danh sách nợ ngân hàng (kèm mục Sắp giải ngân)' },
      schema: { tags: ['bank-debts'], querystring: j(loanListQuery) },
      handler: async (req, reply) => {
        const q = validate(loanListQuery, req.query);
        const data = await listLoans(requireScope(req), q);
        return ok(reply, data, { maxAge: 15 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-debts',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-03', summary: 'Tạo khoản nợ ngân hàng (đối tác Ngân hàng, đã giải ngân)' },
      schema: { tags: ['bank-debts'], body: j(loanCreateBody) },
      handler: async (req, reply) => {
        const body = validate(loanCreateBody, req.body);
        const created = await createLoan(actorOf(req), requireScope(req), body, metaOf(req));
        return ok(reply, { data: created }, { status: 201 });
      },
    }),
  );

  /* --------------------------- LOAN-05 · import theo lô --------------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-debts/import',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-05', summary: 'Nhập nợ ngân hàng theo lô (đối tác chọn theo mã DT-…)' },
      schema: { tags: ['bank-debts'], body: bankDebtImportBodySchema },
      handler: async (req, reply) => {
        const body = validate(bankDebtImportBody, req.body);
        const result = await importLoans(actorOf(req), requireScope(req), body.company_id, body.rows, metaOf(req));
        return ok(reply, { data: result }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-debts/:id',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-02', summary: 'Chi tiết khoản nợ ngân hàng và chuỗi liên quan' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const detail = await getLoanDetail(requireScope(req), id);
        const { attachments, ...rest } = detail;
        return ok(reply, { data: { ...rest, attachments: mapOwnerAttachments(attachments as unknown[]) } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/bank-debts/:id',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-02', summary: 'Sửa khoản nợ ngân hàng' },
      schema: { tags: ['bank-debts'], body: j(loanUpdateBody) },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = validate(loanUpdateBody, req.body);
        await updateLoan(actorOf(req), requireScope(req), id, body, metaOf(req));
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /** Xoá khoản vay: chỉ khoản chờ giải ngân CHƯA có liên kết nào (đã có ⇒ Huỷ, giữ lịch sử). Quyền `loan:delete`. */
  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/bank-debts/:id',
      config: { perms: ['loan:delete'] as Permission[], screen: 'LOAN-02', summary: 'Xoá khoản nợ ngân hàng (chưa phát sinh tiền)' },
      handler: async (req, reply) => {
        const actor = actorOf(req);
        const { id } = req.params as { id: string };
        const b = await loadLoanOrFail(id);
        await assertLoanDeletable(requireScope(req), b);

        // Xoá chứng từ đính kèm (best-effort) — file trên storage + metadata mirror.
        for (const raw of (b.attachments ?? []) as Record<string, unknown>[]) {
          const key = raw.key ? String(raw.key) : '';
          if (key) await storage().remove(key).catch(() => undefined);
        }
        await Models.Attachment.deleteMany({ owner_type: 'loan', owner_id: b._id } as never).exec();
        await deleteLoanRecord(id);

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'bank_debt.delete',
          subject: { type: 'bank_debt', id, code: String(b.code ?? '') },
          company_id: String(b.company_id),
          diff_fields: { principal_minor: toBigInt(b.principal_minor).toString() },
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /* ------------------------ LOAN-04 · lịch nghĩa vụ trả nợ ------------------------ */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-debts/:id/schedule',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-04', summary: 'Lịch nghĩa vụ trả nợ (gốc + lãi + phí)' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const b = await loadLoanOrFail(id);
        assertInScope(requireScope(req).companyIds, String(b.company_id));
        const partner = b.partner_id ? (await loadPartners([b.partner_id])).get(String(b.partner_id)) : undefined;
        const currency = String(b.currency ?? 'VND');
        const maturity = String(b.maturity_date ?? today());
        // Lịch bắt đầu từ NGÀY GIẢI NGÂN thực tế (v2 §10.1); chưa giải ngân ⇒ ngày lập khoản. Kỳ hạn chỉ để hiển thị.
        const candidate = b.disbursed_at ? vnDate(b.disbursed_at) : b.created_at ? vnDate(b.created_at) : maturity;
        const start = candidate < maturity ? candidate : addMonths(maturity, -1);
        const termMonths = b.term_months ?? Math.max(1, Math.round(daysBetween(start, maturity) / 30));
        const frequency = (b.payment_frequency ?? 'maturity') as RepaymentFrequency;
        const method = (b.repayment_method ?? 'interest_only') as RepaymentMethod;
        const sched = buildSchedule({
          principalMinor: toBigInt(b.principal_minor),
          rate: b.interest_rate,
          maturityDate: maturity,
          startDate: start,
          frequency,
          method,
        });
        const rows = sched.rows.map((r) => ({
          period: r.period,
          due_date: r.due_date,
          days: r.days,
          principal: wireMoney(r.principal, currency),
          interest: wireMoney(r.interest, currency),
          fee: wireMoney(r.fee, currency),
          total: wireMoney(r.total, currency),
          status: r.due_date < today() ? 'overdue' : r.due_date === today() ? 'due' : 'upcoming',
        }));
        return ok(
          reply,
          {
            data: {
              loan_id: String(b._id),
              contract_code: String(b.code ?? ''),
              bank_name: partner?.name ?? '',
              currency,
              interest_rate: String(b.interest_rate ?? '0'),
              term_months: termMonths,
              payment_frequency: frequency,
              repayment_method: method,
              start_date: start,
              maturity_date: maturity,
              rows,
              totals: {
                principal: wireMoney(sched.totals.principal, currency),
                interest: wireMoney(sched.totals.interest, currency),
                fee: wireMoney(sched.totals.fee, currency),
                total: wireMoney(sched.totals.total, currency),
              },
            },
          },
          { maxAge: 30 },
        );
      },
    }),
  );

  /* ----------------------------- vòng đời khoản vay ----------------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-debts/:id/cancel',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-02', summary: 'Huỷ khoản đang chờ giải ngân (có lý do)' },
      schema: { tags: ['bank-debts'], body: j(loanCancelBody) },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = validate(loanCancelBody, req.body);
        const result = await cancelPendingLoan(actorOf(req), requireScope(req), id, body.reason, metaOf(req));
        return ok(reply, { data: { ok: true, code: result.code } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-debts/:id/archive',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-02', summary: 'Lưu trữ khoản đã tất toán' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        await archiveLoan(actorOf(req), requireScope(req), id, metaOf(req));
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  /* ----------------------- giải ngân (liên kết disbursement) ----------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-debts/:id/disbursements',
      config: { perms: LINK_PERMS, screen: 'LOAN-02', summary: 'Gán phiếu thu giải ngân vào khoản vay' },
      schema: { tags: ['bank-debts'], body: j(loanDisbursementBody) },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = validate(loanDisbursementBody, req.body);
        const link = await assignDisbursement(actorOf(req), requireScope(req), id, body, metaOf(req));
        return ok(reply, { data: link }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/bank-debts/:id/disbursements/:linkId',
      config: { perms: LINK_PERMS, screen: 'LOAN-02', summary: 'Gỡ phiếu thu giải ngân (có lý do)' },
      handler: async (req, reply) => {
        const { id, linkId } = req.params as { id: string; linkId: string };
        await unassignLoanLink(actorOf(req), requireScope(req), id, linkId, 'disbursement', reasonOf(req), metaOf(req));
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-debts/:id/disbursement-candidates',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-02', summary: 'Phiếu thu khả dụng để gán giải ngân (cùng ngân hàng)' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const q = validate(linkCandidatesQuery, req.query);
        const items = await loanCandidates(requireScope(req), id, 'disbursement', q.q);
        return ok(reply, { items }, { maxAge: 0 });
      },
    }),
  );

  /* ------------------------- trả nợ (liên kết repayment) ------------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-debts/:id/repayments',
      config: { perms: LINK_PERMS, screen: 'LOAN-02', summary: 'Gán phiếu chi trả nợ (tách gốc / lãi / phí tuỳ chọn)' },
      schema: { tags: ['bank-debts'], body: j(loanRepaymentBody) },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const body = validate(loanRepaymentBody, req.body);
        const link = await assignRepayment(actorOf(req), requireScope(req), id, body, metaOf(req));
        return ok(reply, { data: link }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/bank-debts/:id/repayments/:linkId',
      config: { perms: LINK_PERMS, screen: 'LOAN-02', summary: 'Gỡ phiếu chi trả nợ (có lý do)' },
      handler: async (req, reply) => {
        const { id, linkId } = req.params as { id: string; linkId: string };
        await unassignLoanLink(actorOf(req), requireScope(req), id, linkId, 'repayment', reasonOf(req), metaOf(req));
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-debts/:id/repayment-candidates',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-02', summary: 'Phiếu chi khả dụng để gán trả nợ (cùng ngân hàng)' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const q = validate(linkCandidatesQuery, req.query);
        const items = await loanCandidates(requireScope(req), id, 'repayment', q.q);
        return ok(reply, { items }, { maxAge: 0 });
      },
    }),
  );

  /* ----------------- chi bằng vốn vay (funded_by): gỡ thủ công có lý do (v2 §11.5 ngoại lệ) ----------------- */

  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/bank-debts/:id/funded-by/:linkId',
      config: { perms: LINK_PERMS, screen: 'LOAN-02', summary: 'Gỡ liên kết phiếu chi được tài trợ bằng khoản vay (có lý do)' },
      handler: async (req, reply) => {
        const { id, linkId } = req.params as { id: string; linkId: string };
        await unassignLoanLink(actorOf(req), requireScope(req), id, linkId, 'funded_by', reasonOf(req), metaOf(req));
        return ok(reply, { data: { ok: true } });
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

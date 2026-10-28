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
  effectivePermissions,
  ROLE_LABEL,
  STATUS_REGISTRY,
  formatMoney,
  money,
  normalizePlannedDate,
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
  attachmentRemoveBodySchema,
  documentCreateBodySchema,
  documentDeleteBodySchema,
  documentListQuerySchema,
  documentUpdateBodySchema,
  opinionBodySchema,
  rolloverResultBodySchema,
  transitionBodySchema,
} from './schemas.ts';
import {
  documentCreateBody,
  documentDeleteBody,
  documentListQuery,
  queueProcessedQuery,
  documentUpdateBody,
  documentTagsBody,
  documentPartnerBody,
  documentLinkCreateBody,
  linkRemoveBody,
  opinionBody,
  rolloverResultBody,
  transitionBody,
  attachmentPrepareBody,
  attachmentConfirmBody,
  attachmentRemoveBody,
  decisionPackQuery,
  toJsonSchema,
} from '@fingate/shared';
import { loadDoc, transition, assertStepUp } from '../domain/workflow/index.ts';
import { emitVoucherEvent, type VoucherEventSubject } from '../domain/events/index.ts';
import {
  companyReachableByActor,
  documentPermissions,
  approvedFromChiefAccountantUp,
  PARTNER_REASSIGN_ROLES,
  UNRESTRICTED_DELETE_ROLES,
} from '../domain/entitlement/index.ts';
import { awaitingBadge, decisionPack, docHref, queryQueue } from '../domain/queries/index.ts';
import { mirrorAudit, buildHistoryEntry } from '../domain/audit/index.ts';
import { assertAccountAllowedForCompany, assertGroupAccountForCompany } from '../domain/accounts.ts';
import { invalidateFor, rebuildEvidence } from '../domain/side-effects.ts';
import { attachmentKey, detectMagic, sha256hex, storage } from '../storage/index.ts';
import { newRequestId } from '../lib/http.ts';
import { assertDocumentAmountCoversLinks, assertPartnerChangeKeepsLinks, createLink, emitLoanSettledAfterPayment, removeLink } from '../domain/links/index.ts';
import { activateLoanOnDisbursement, applyRolloverResultToLoan, assertLoanForRollover, assertRolloverResultForLoan } from '../domain/debt/loans.ts';
import { releaseLoansOfSource } from '../domain/automation/actions/source.ts';
import { loansToRevertOnDelete, revertLoansOnDelete } from '../domain/debt/loan-on-delete.ts';
import {
  assertDisbursementNotChosenLoan,
  assertDocumentLinkable,
  diffIds,
  manualLinkTargetType,
  parseIdList,
  planToOffsetInput,
  planToStoredOffset,
  sameOffsetPlan,
  storedOffsetToPlan,
  type StoredLoanChoice,
  type VoucherKind,
} from '../domain/vouchers/rules.ts';
import { isOffsetRuleLink, releaseOffsetRuleLinks } from '../domain/vouchers/offset.ts';
import {
  mayChangeVoucherTags,
  roundLocksEdit,
  voucherAmountField,
} from '../domain/vouchers/lifecycle.ts';
import { reverseLedgerForDocument } from '../domain/vouchers/reversal.ts';
import {
  assertApprovalAmountEditable,
  buildVoucherRefView,
  disbursementReleasedByLoanChoice,
  linkChosenLoanOnSave,
  loadPartnerInCompany,
  planToLoanInput,
  planToStoredLoan,
  resolveLoanPlan,
  resolveOffsetPlan,
  resolveTransferTarget,
  resolveVoucherPartner,
  resolveVoucherTagIds,
  softRemoveLinksOfDocument,
  storedLoanToPlan,
  storedTransferOf,
  tagNamesOf,
  type TransferTargetPlan,
} from '../domain/vouchers/refs.ts';

/* Nguồn/đích tiền chặn ở server theo công ty của phiếu — logic dùng chung với workflow
 * (cấp duyệt đổi tài khoản) ở `domain/accounts.ts` (§VIII). */

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
          role: actor.role,
          canPay: actor.permissions.includes('payment:mark'),
          kind: q.kind,
          status: q.status as string[] | string | undefined,
          companyId: q.company_id,
          mine: q.mine,
          from: q.from,
          to: q.to,
          q: q.q,
          partnerId: q.partner_id ?? null,
          tagIds: parseIdList(q.tag_ids),
          overdueOnly: q.overdue_only === 'true',
          missingEvidenceOnly: q.missing_evidence === 'true',
          sort: q.sort,
          limit: q.limit,
          page: q.page,
        });
        return ok(reply, { items, total, limit: q.limit, page: q.page }, { maxAge: 15 });
      },
    }),
  );

  /**
   * APPR-01 — hàng chờ của chính tôi: hồ sơ tới lượt tôi duyệt, VÀ (với kế toán có
   * `payment:mark`) phiếu chi đã duyệt xong đang chờ thực thi.
   */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/queue',
      config: {
        perms: [] as Permission[],
        permsAny: ['approval:act', 'payment:mark'] as Permission[],
        screen: 'APPR-01',
        summary: 'Chờ tôi duyệt / chờ tôi thực thi',
      },
      schema: { tags: ['documents'], querystring: documentListQuerySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const q = validate(documentListQuery, req.query);
        const canPay = actor.permissions.includes('payment:mark');
        const [{ items, total }, badge] = await Promise.all([
          queryQueue({
            scope,
            userId: actor.user_id,
            role: actor.role,
            canPay,
            mine: 'to_approve',
            kind: q.kind,
            status: q.status,
            companyId: q.company_id,
            q: q.q,
            partnerId: q.partner_id ?? null,
            tagIds: parseIdList(q.tag_ids),
            overdueOnly: q.overdue_only === 'true',
            sort: q.sort ?? '-waiting',
            limit: q.limit,
            page: q.page,
          }),
          awaitingBadge(scope, actor.user_id, actor.role, canPay),
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
            page: q.page,
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
        // ô tìm (q) của "Tôi đã duyệt": cùng cách khớp với hàng chờ (mã, tiêu đề, đối tác, STK/MST, tag); có phân trang
        const q = validate(queueProcessedQuery, req.query);
        const { items, total } = await queryQueue({
          scope,
          userId: actor.user_id,
          mine: 'approved_by_me',
          q: q.q?.trim() || undefined,
          limit: q.limit,
          page: q.page,
          sort: '-created_at',
        });
        return ok(reply, { items, total, limit: q.limit, page: q.page }, { maxAge: 15 });
      },
    }),
  );

  /** DASH-05 — trung tâm "Cần xử lý": hồ sơ bị trả về + thiếu chứng từ + quá hạn + chờ duyệt. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/needs-attention',
      config: { perms: ['doc:read'] as Permission[], screen: 'DASH-05', summary: 'Cần xử lý' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const [missing, overdue, changes, awaiting] = await Promise.all([
          queryQueue({ scope, userId: actor.user_id, missingEvidenceOnly: true, limit: 50, sort: '-created_at' }),
          queryQueue({ scope, userId: actor.user_id, overdueOnly: true, limit: 50 }),
          // bị cấp trên yêu cầu bổ sung → người lập (kế toán viên) phải sửa & gửi lại
          queryQueue({ scope, userId: actor.user_id, mine: 'created', status: 'changes_requested', limit: 50, sort: '-created_at' }),
          queryQueue({
            scope,
            userId: actor.user_id,
            role: actor.role,
            canPay: actor.permissions.includes('payment:mark'),
            mine: 'to_approve',
            limit: 50,
            sort: '-waiting',
          }),
        ]);
        const groups = [
          { key: 'changes_requested', title: 'Cần bổ sung (bị trả về)', tone: 'attention', ...changes },
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
        // Công ty nhận của chuyển nội bộ: phải là công ty người dùng được gán (không chỉ công ty đang xem) — §7.5, §11.6.
        const transferInput = body.transfer_target ?? body.target ?? null;
        if (transferInput?.company_id && !companyReachableByActor(requestCtx(req).identity, String(transferInput.company_id))) {
          throw new ApiError({ code: 'FG-RBAC-002', detail: 'Công ty nhận không nằm trong phạm vi của bạn' });
        }
        await assertAccountAllowedForCompany(companyId, body.source.account_id);
        await assertGroupAccountForCompany(companyId, body.source.group_account_id);

        const kind = body.kind;
        const amountMinor = BigInt(body.amount.amount_minor);
        // [v2] đối tác CHỌN THEO ID (không nhập tự do, không tự tạo từ chuỗi). Phiếu thu/chi bắt buộc.
        const loanInput = body.options?.loan ?? null;
        const offsetInput = body.options?.offset ?? null;
        if (!body.partner_id && (kind === 'spend' || kind === 'income')) {
          throw new ApiError({ code: 'FG-VAL-001', detail: 'Chọn đối tác', errors: { partner_id: 'Chọn đối tác (bắt buộc với phiếu thu/chi)' } });
        }
        const partner = body.partner_id
          ? await resolveVoucherPartner({ companyId, partnerId: String(body.partner_id), kind, requireActive: true, loanKind: loanInput?.kind ?? null })
          : null;
        // Phương án đảo hạn phải gắn khoản vay: cùng công ty, cùng ngân hàng (đối tác), đang vay / quá hạn (v2 §10.3).
        if (kind === 'rollover') {
          if (!partner) throw new ApiError({ code: 'FG-VAL-001', detail: 'Chọn ngân hàng cho vay', errors: { partner_id: 'Chọn ngân hàng cho vay' } });
          if (!body.loan_id) throw new ApiError({ code: 'FG-VAL-001', detail: 'Chọn khoản vay đang đảo hạn', errors: { loan_id: 'Chọn khoản vay đang đảo hạn' } });
          await assertLoanForRollover(String(body.loan_id), companyId, String(partner._id));
        }
        const tagIds = await resolveVoucherTagIds({ companyId, requested: body.tag_ids ?? [], previous: [] });
        const loan = await resolveLoanPlan({
          companyId,
          voucherKind: kind as VoucherKind,
          voucherPartnerId: partner ? String(partner._id) : null,
          voucherAmountMinor: amountMinor,
          loan: loanInput,
          previous: null,
        });
        // Cấn trừ khoản vay (R7): kiểm đối tác, khoản vay / công nợ và sức chứa ngay khi lưu — duyệt xong mới gán tự động.
        const offset = await resolveOffsetPlan({
          companyId,
          voucherId: null,
          voucherKind: kind as VoucherKind,
          voucherPartnerId: partner ? String(partner._id) : null,
          voucherPartnerType: partner ? String(partner.type) : null,
          voucherAmountMinor: amountMinor,
          voucherLoanKind: loanInput?.kind ?? null,
          offset: offsetInput,
          previous: null,
        });
        // Chuyển nội bộ theo ID (§11.6): thay cho nhận diện theo chuỗi "Tên - NH - STK" (đã bỏ).
        const transfer = await resolveTransferTarget({
          companyId,
          kind: kind as VoucherKind,
          partnerId: body.partner_id ? String(body.partner_id) : null,
          target: transferInput ? { company_id: String(transferInput.company_id), account_id: transferInput.account_id ?? null } : null,
          previous: null,
        });
        // "Vay để chi" (R3): tài khoản nguồn mặc định = tài khoản nhận giải ngân (vẫn sửa được).
        const sourceAccountId = body.source.account_id ?? (loan?.kind === 'fund' ? loan.receive_account_id : null) ?? null;
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
          // [v2] không ghi payee.* (nhập tự do đã bỏ) — đối tác theo ID, tag, tuỳ chọn vay, chuyển nội bộ theo ID
          partner_id: partner ? String(partner._id) : null,
          tag_ids: tagIds,
          options: { loan: planToStoredLoan(loan), offset: planToStoredOffset(offset) },
          transfer_target: transfer,
          target: transfer, // v1 song song: bộ máy/ sổ cái v1 còn đọc `target` (sẽ bỏ khi migrate)
          amount: { minor: amountMinor, currency: body.amount.currency, decimals: currencyDecimals(body.amount.currency) },
          fx: body.fx ? { rate: body.fx.rate, at: body.fx.at } : null,
          source: {
            fund: body.source.fund,
            account_id: sourceAccountId,
            group_account_id: body.source.group_account_id ?? null,
            group_managed: Boolean(body.source.group_managed),
          },
          planned_date: normalizePlannedDate(body.planned_date),
          business_date: body.business_date ?? vnDate(),
          priority: body.priority,
          contract: {
            code: body.contract.code ?? null,
            value: body.contract.value ? voucherAmountField(body.contract.value.currency, BigInt(body.contract.value.amount_minor)) : null,
            signed_at: body.contract.signed_at ?? null,
          },
          loan_id: body.loan_id ?? null,
          budget: { budget_id: body.budget.budget_id ?? null, line_id: body.budget.line_id ?? null, in_plan: body.budget.in_plan },
          note: body.note ?? null,
          rollover: body.rollover
            ? {
                need_amount: { minor: BigInt(body.rollover.need_amount.amount_minor), currency: body.rollover.need_amount.currency, decimals: 0 },
                plan: body.rollover.plan,
                new_maturity_date: body.rollover.new_maturity_date,
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

        // "Gắn khoản vay đã có" (§11.4 (b)): liên kết giải ngân Thủ công ghi ngay khi lưu, không chờ quy tắc R2
        await linkChosenLoanOnSave({
          documentId: String(created._id),
          previous: null,
          plan: loan,
          amountMinor,
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          requestId: null,
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
        // v2: sự kiện tạo phiếu (outbox, best-effort)
        await emitVoucherEvent(
          'voucher.created',
          created as unknown as VoucherEventSubject,
          { user_id: actor.user_id, name: actor.name, role: actor.role },
          { from: null, to: 'draft', action: 'create' },
        );
        invalidateFor(companyId, actor.user_id);
        return ok(reply, { data: await detailOf(String(created._id), actor.user_id, scope.companyIds) }, { status: 201 });
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
        requireScope(req); // phạm vi bắt buộc có (công ty nhận chuyển nội bộ kiểm riêng bằng companyReachableByActor)
        const params = req.params as { id: string };
        const body = validate(documentUpdateBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));
        if (String(doc.created_by) !== actor.user_id) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ người lập mới sửa được hồ sơ' });
        }
        if (!['draft', 'pending.ktt', 'changes_requested', 'rejected'].includes(doc.status)) {
          throw new ApiError({ code: 'FG-WF-005', detail: 'Hồ sơ đã qua cấp duyệt, chỉ thêm chứng từ được' });
        }
        // US-VOU-05: phiếu bị yêu cầu bổ sung được sửa lại dù cấp trên đã duyệt ở vòng trước (vòng mới bắt đầu khi gửi lại)
        if (roundLocksEdit(String(doc.status), approvedFromChiefAccountantUp((doc.history ?? []) as { action?: string | null; actor?: { role?: string | null } | null }[]))) {
          throw new ApiError({ code: 'FG-WF-005', detail: 'Hồ sơ đã được cấp từ Kế toán trưởng trở lên duyệt ở vòng này — không sửa được nữa' });
        }
        if (doc.processed_requests?.includes(body.request_id)) {
          return ok(reply, { data: await detailOf(params.id, actor.user_id, requireScope(req).companyIds), idempotent: true });
        }

        const set: Record<string, unknown> = {};
        for (const key of ['title', 'purpose', 'note', 'priority', 'business_date', 'category_id', 'department_id', 'loan_id'] as const) {
          if (body[key] !== undefined) set[key] = body[key];
        }
        if (body.planned_date !== undefined) set.planned_date = normalizePlannedDate(body.planned_date);
        // [v2] đối tác / tuỳ chọn vay / chuyển nội bộ / tag: kiểm trên trạng thái SAU KHI GỘP.
        // Không ghi `payee.*` (nhập tự do đã bỏ), không nhận diện theo chuỗi, không tự tạo đối tác.
        const kind = String(doc.kind) as VoucherKind;
        const companyId = String(doc.company_id);
        const amountMinorNext = body.amount ? BigInt(body.amount.amount_minor) : BigInt(String(doc.amount.minor));
        const currentPartnerId = doc.partner_id ? String(doc.partner_id) : null;
        const nextPartnerId = body.partner_id !== undefined ? body.partner_id : currentPartnerId;
        const partnerChanged = nextPartnerId !== currentPartnerId;
        if (!nextPartnerId && (kind === 'spend' || kind === 'income')) {
          throw new ApiError({ code: 'FG-VAL-001', detail: 'Chọn đối tác', errors: { partner_id: 'Chọn đối tác (bắt buộc với phiếu thu/chi)' } });
        }
        const previousLoan = storedLoanToPlan(doc.options?.loan as unknown as Record<string, unknown> | null | undefined);
        const loanInput = body.options !== undefined ? (body.options?.loan ?? null) : previousLoan ? planToLoanInput(previousLoan) : null;
        const previousOffset = storedOffsetToPlan(doc.options?.offset as unknown as Record<string, unknown> | null | undefined);
        const offsetInput = body.options !== undefined ? (body.options?.offset ?? null) : previousOffset ? planToOffsetInput(previousOffset) : null;
        let nextPartnerType: string | null = null;
        if (nextPartnerId) {
          // đối tác đã ngừng giao dịch chỉ bị chặn khi CHỌN MỚI; giữ nguyên thì dữ liệu cũ vẫn sửa được
          const nextPartner = await resolveVoucherPartner({ companyId, partnerId: nextPartnerId, kind, requireActive: partnerChanged, loanKind: loanInput?.kind ?? null });
          nextPartnerType = String(nextPartner.type);
        }
        if (kind === 'rollover') {
          // Phương án đảo hạn: khoản vay gắn (mới hoặc giữ nguyên) phải hợp lệ với công ty và ngân hàng đang chọn (v2 §10.3).
          if (!nextPartnerId) throw new ApiError({ code: 'FG-VAL-001', detail: 'Chọn ngân hàng cho vay', errors: { partner_id: 'Chọn ngân hàng cho vay' } });
          const nextLoanId = body.loan_id !== undefined ? body.loan_id : doc.loan_id ? String(doc.loan_id) : null;
          if (!nextLoanId) throw new ApiError({ code: 'FG-VAL-001', detail: 'Chọn khoản vay đang đảo hạn', errors: { loan_id: 'Chọn khoản vay đang đảo hạn' } });
          if (body.loan_id !== undefined || partnerChanged) await assertLoanForRollover(nextLoanId, companyId, nextPartnerId);
        }
        const loan = await resolveLoanPlan({
          companyId,
          voucherKind: kind,
          voucherPartnerId: nextPartnerId,
          voucherAmountMinor: amountMinorNext,
          loan: loanInput,
          // đổi đối tác ⇒ kiểm lại mọi tham chiếu của khoản vay (khoản vay có sẵn thuộc ngân hàng cũ không còn hợp lệ)
          previous: partnerChanged ? null : previousLoan,
          voucherId: params.id,
        });
        const offset = await resolveOffsetPlan({
          companyId,
          voucherId: params.id,
          voucherKind: kind,
          voucherPartnerId: nextPartnerId,
          voucherPartnerType: nextPartnerType,
          voucherAmountMinor: amountMinorNext,
          voucherLoanKind: loanInput?.kind ?? null,
          offset: offsetInput,
          // đổi đối tác ⇒ kiểm lại mọi tham chiếu cấn trừ (khoản cũ có thể thuộc ngân hàng / đối tác cũ)
          previous: partnerChanged ? null : previousOffset,
          previousVoucherAmountMinor: BigInt(String(doc.amount.minor)),
        });
        const offsetChanged = !sameOffsetPlan(previousOffset, BigInt(String(doc.amount.minor)), offset, amountMinorNext);
        // đổi đối tác: liên kết cấn trừ / trả nợ / giải ngân đang có phải còn khớp đối tác mới (v2 §9.2, §11.2).
        // Giải ngân tới khoản đã chọn trước đó sẽ được gỡ khi lưu này (linkChosenLoanOnSave) ⇒ không chặn.
        if (partnerChanged)
          await assertPartnerChangeKeepsLinks({
            documentId: params.id,
            nextPartnerId,
            // liên kết cấn trừ R7 cũ được gỡ ngay trong lần lưu này khi cấn trừ đổi (xem releaseOffsetRuleLinks)
            willRelease: (l) => disbursementReleasedByLoanChoice(l, previousLoan, loan) || (offsetChanged && isOffsetRuleLink(l)),
          });
        // đổi số tiền: tổng phân bổ còn lại không được vượt số tiền mới (v2 §9.2). Giải ngân theo khoản vay đã chọn
        // và liên kết tự động của R2 được đồng bộ theo số tiền mới (linkChosenLoanOnSave / R2), nên không tính ở đây.
        if (amountMinorNext !== BigInt(String(doc.amount.minor))) {
          const nextExistingLoanId = loan?.kind === 'borrow' && loan.mode === 'existing' ? loan.existing_loan_id : null;
          const prevExistingLoanId = previousLoan?.kind === 'borrow' && previousLoan.mode === 'existing' ? previousLoan.existing_loan_id : null;
          await assertDocumentAmountCoversLinks({
            documentId: params.id,
            amountMinor: amountMinorNext,
            currency: doc.amount.currency,
            willResync: (l) =>
              l.origin === 'automation' ||
              (l.relation === 'disbursement' && (nextExistingLoanId !== null || (l.origin === 'manual' && l.to_id === prevExistingLoanId))),
          });
        }
        const transferIn = body.transfer_target !== undefined ? body.transfer_target : body.target;
        let transfer: TransferTargetPlan | null | undefined; // undefined = không đổi
        // phiếu chi: đích suy từ đối tác nên đổi đối tác là phải tính lại
        if (transferIn !== undefined || (partnerChanged && kind === 'spend')) {
          if (transferIn?.company_id && !companyReachableByActor(requestCtx(req).identity, String(transferIn.company_id))) {
            throw new ApiError({ code: 'FG-RBAC-002', detail: 'Công ty nhận không nằm trong phạm vi của bạn' });
          }
          transfer = await resolveTransferTarget({
            companyId,
            kind,
            partnerId: nextPartnerId ? String(nextPartnerId) : null,
            target: transferIn ? { company_id: String(transferIn.company_id), account_id: transferIn.account_id ?? null } : null,
            previous: storedTransferOf(doc as unknown as Record<string, unknown>),
          });
        }
        if (body.tag_ids !== undefined) {
          set.tag_ids = await resolveVoucherTagIds({ companyId, requested: body.tag_ids, previous: (doc.tag_ids ?? []).map(String) });
        }
        if (body.partner_id !== undefined) set.partner_id = nextPartnerId;
        // lãi/gốc của khoản vay dự kiến đi theo đối tác (vay đi thu: NH cho vay = đối tác phiếu) và số tiền phiếu
        if (body.options !== undefined || partnerChanged || body.amount !== undefined) {
          set.options = { loan: planToStoredLoan(loan), offset: planToStoredOffset(offset) };
        }
        if (transfer !== undefined) {
          set.transfer_target = transfer;
          set.target = transfer; // v1 song song
        }
        if (body.source) {
          // validate trên BẢN MERGE để không lọt tổ hợp account_id/group_account_id
          // tham chiếu tài khoản Tập đoàn khi phiếu thuộc công ty con (§VIII).
          const mergedSource = { ...(doc.source as Record<string, unknown>), ...body.source } as {
            account_id?: string | null;
            group_account_id?: string | null;
          };
          await assertAccountAllowedForCompany(String(doc.company_id), mergedSource.account_id);
          await assertGroupAccountForCompany(String(doc.company_id), mergedSource.group_account_id);
          set.source = mergedSource;
        }
        if (body.contract) {
          // giá trị HĐ: đổi sang dạng lưu (minor BigInt) — không ghi thẳng dạng wire `amount_minor`
          const { value: contractValue, ...contractRest } = body.contract;
          set.contract = {
            ...doc.contract,
            ...contractRest,
            ...(contractValue !== undefined
              ? { value: contractValue ? voucherAmountField(contractValue.currency, BigInt(contractValue.amount_minor)) : null }
              : {}),
          };
        }
        if (body.budget) set.budget = { ...doc.budget, ...body.budget };
        // merge (không ghi đè) để giữ `rollover.result` (RENEW-04) khi sửa lại phương án.
        if (body.rollover) set.rollover = { ...((doc.rollover ?? {}) as Record<string, unknown>), ...body.rollover };
        if (body.amount) {
          // số thập phân theo tiền tệ (USD/EUR/CNY = 2), khớp POST /documents
          set.amount = voucherAmountField(body.amount.currency, BigInt(body.amount.amount_minor));
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
          extraFilter: { status: { $in: ['draft', 'pending.ktt', 'changes_requested', 'rejected'] } },
          set,
          push: { history: entry },
          addToSet: { processed_requests: body.request_id },
        });
        if (!result) throw new ApiError({ code: 'FG-WF-011' });
        // "Gắn khoản vay đã có" (§11.4 (b)): đồng bộ liên kết giải ngân Thủ công theo lựa chọn trước và sau khi lưu
        await linkChosenLoanOnSave({
          documentId: params.id,
          previous: previousLoan,
          plan: loan,
          amountMinor: amountMinorNext,
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          requestId: body.request_id,
        });
        // cấn trừ đổi ⇒ liên kết R7 đã gán khi duyệt trước đó được gỡ; duyệt lại sẽ gán theo lựa chọn mới
        if (offsetChanged) {
          await releaseOffsetRuleLinks({
            documentId: params.id,
            reason: 'Phiếu đổi cấn trừ khoản vay — sẽ gán lại khi duyệt',
            actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
            requestId: body.request_id,
          });
        }
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
        // v2: sự kiện sửa phiếu (outbox, best-effort) — trạng thái không đổi
        await emitVoucherEvent(
          'voucher.updated',
          result.doc as unknown as VoucherEventSubject,
          { user_id: actor.user_id, name: actor.name, role: actor.role },
          { from: doc.status, to: doc.status, action: 'update', changed: Object.keys(set) },
        );
        invalidateFor(String(doc.company_id), actor.user_id);
        return ok(reply, { data: await detailOf(params.id, actor.user_id, requireScope(req).companyIds), version: result.version });
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
        await assertDocVisible(req, params.id);
        return ok(reply, { data: await detailOf(params.id, actor.user_id, requireScope(req).companyIds) }, { maxAge: 0 });
      },
    }),
  );

  /* ------------------------------ tag (v2) ------------------------------- */

  /**
   * v2 §6.2 — sửa tag của phiếu, KỂ CẢ SAU KHI DUYỆT (tag không ảnh hưởng tiền), có lịch sử `tags_update`.
   * Quyền: xem được phiếu + `doc:create` hoặc `tag:create`. Tag phải thuộc công ty của phiếu.
   */
  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/documents/:id/tags',
      config: {
        perms: [] as Permission[],
        permsAny: ['doc:create', 'tag:create'] as Permission[],
        screen: 'DOC-01',
        summary: 'Sửa tag của phiếu (kể cả sau khi duyệt; ghi lịch sử tags_update)',
      },
      schema: { tags: ['documents'], body: toJsonSchema(documentTagsBody) },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const body = validate(documentTagsBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));
        // §6.2 — sửa được cả sau khi duyệt, nhưng chỉ NGƯỜI LẬP hoặc kế toán trưởng (tag:manage); KTV khác không đổi tag phiếu của người khác.
        if (!mayChangeVoucherTags(actor, { created_by: String(doc.created_by) })) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ người lập phiếu hoặc kế toán trưởng mới sửa được tag của phiếu này' });
        }
        if (doc.processed_requests?.includes(body.request_id)) {
          return ok(reply, { data: await detailOf(params.id, actor.user_id, requireScope(req).companyIds), idempotent: true });
        }
        const companyId = String(doc.company_id);
        const prev = (doc.tag_ids ?? []).map(String);
        const next = await resolveVoucherTagIds({ companyId, requested: body.tag_ids, previous: prev });
        const diff = diffIds(prev, next);
        if (diff.added.length === 0 && diff.removed.length === 0) {
          return ok(reply, { data: await detailOf(params.id, actor.user_id, requireScope(req).companyIds), version: doc.version, unchanged: true });
        }
        const names = await tagNamesOf([...diff.added, ...diff.removed], companyId);
        const nameOf = (id: string): string => names.get(id) || 'tag không rõ tên';
        const entry = buildHistoryEntry({
          action: 'tags_update',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          from: doc.status,
          to: doc.status,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
          fields: {
            added: diff.added.map((id) => ({ id, name: nameOf(id) })),
            removed: diff.removed.map((id) => ({ id, name: nameOf(id) })),
          },
        });
        const r = await cas<Record<string, unknown>>({
          model: 'Document',
          id: params.id,
          ifMatch: body.if_match,
          set: { tag_ids: next },
          push: { history: entry },
          addToSet: { processed_requests: body.request_id },
        });
        if (!r) throw new ApiError({ code: 'FG-WF-011' });
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'document.tags_update',
          subject: { type: doc.kind, id: params.id, code: doc.code },
          company_id: companyId,
          document_id: params.id,
          // ADM-12 nêu TÊN tag được thêm / bỏ (không đưa id thô ra cột "Trường thay đổi"); id vẫn còn trong history[].
          diff_fields: {
            ...(diff.added.length ? { added: diff.added.map(nameOf) } : {}),
            ...(diff.removed.length ? { removed: diff.removed.map(nameOf) } : {}),
          },
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        invalidateFor(companyId, actor.user_id);
        return ok(reply, { data: await detailOf(params.id, actor.user_id, requireScope(req).companyIds), version: r.version });
      },
    }),
  );

  /* ---------------------------- đối tác của phiếu (Chủ tịch) ---------------------------- */

  /**
   * Chủ tịch đổi lại đối tác của phiếu thu/chi (bên nộp tiền / bên nhận tiền) ở MỌI trạng thái, kể cả đã thực thi.
   * Không đụng số tiền hay sổ cái (sổ không lưu đối tác); số liệu công nợ / đối tác tính sống theo `partner_id`.
   * Chặn: phiếu đang gắn khoản vay / cấn trừ (gỡ trước), liên kết khớp đối tác cũ (FG-LINK-001), đối tác ngừng giao dịch,
   * và phiếu chuyển nội bộ đã thực thi (đổi sang / khỏi đối tác "Công ty trong tập đoàn").
   * Ghi lịch sử `partner_update` và audit `document.partner_update`.
   */
  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/documents/:id/partner',
      config: {
        perms: ['doc:read'] as Permission[],
        screen: 'DOC-01',
        summary: 'Chủ tịch đổi đối tác của phiếu thu/chi (mọi trạng thái; ghi lịch sử partner_update)',
      },
      schema: { tags: ['documents'], body: toJsonSchema(documentPartnerBody) },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        if (!PARTNER_REASSIGN_ROLES.includes(actor.role)) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ Chủ tịch được đổi đối tác của phiếu' });
        }
        const params = req.params as { id: string };
        const body = validate(documentPartnerBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));
        const kind = String(doc.kind) as VoucherKind;
        if (kind !== 'income' && kind !== 'spend') {
          throw new ApiError({ code: 'FG-VAL-001', detail: 'Chỉ đổi đối tác của phiếu thu / phiếu chi' });
        }
        if (doc.processed_requests?.includes(body.request_id)) {
          return ok(reply, { data: await detailOf(params.id, actor.user_id, requireScope(req).companyIds), idempotent: true });
        }
        const companyId = String(doc.company_id);
        const prevId = doc.partner_id ? String(doc.partner_id) : null;
        if (body.partner_id === prevId) {
          return ok(reply, { data: await detailOf(params.id, actor.user_id, requireScope(req).companyIds), version: doc.version, unchanged: true });
        }
        if (doc.options?.loan || doc.options?.offset) {
          throw new ApiError({
            code: 'FG-VAL-001',
            detail: 'Phiếu đang gắn khoản vay hoặc cấn trừ — gỡ trước khi đổi đối tác',
            errors: { partner_id: 'Phiếu đang gắn khoản vay / cấn trừ — gỡ trước khi đổi đối tác' },
          });
        }
        const next = await resolveVoucherPartner({ companyId, partnerId: body.partner_id, kind, requireActive: true, loanKind: null });
        const prev = prevId ? await loadPartnerInCompany(companyId, prevId) : null;
        const nextType = String(next.type);
        const prevType = prev ? String(prev.type) : null;
        if (doc.status === 'paid' && kind === 'spend' && (prevType === 'internal' || nextType === 'internal')) {
          throw new ApiError({
            code: 'FG-VAL-001',
            detail: 'Phiếu chuyển nội bộ đã thực thi — không đổi sang / khỏi đối tác "Công ty trong tập đoàn"',
            errors: { partner_id: 'Phiếu chuyển nội bộ đã thực thi — không đổi sang / khỏi đối tác "Công ty trong tập đoàn"' },
          });
        }
        await assertPartnerChangeKeepsLinks({ documentId: params.id, nextPartnerId: body.partner_id });
        // phiếu chi: đích chuyển nội bộ suy từ đối tác nên phải tính lại theo đối tác mới
        const transfer =
          kind === 'spend'
            ? await resolveTransferTarget({
                companyId,
                kind,
                partnerId: body.partner_id,
                target: null,
                previous: storedTransferOf(doc as unknown as Record<string, unknown>),
              })
            : undefined;

        const fromName = prev && prevId ? String(prev.name ?? '') : null;
        const toName = String(next.name ?? '');
        const entry = buildHistoryEntry({
          action: 'partner_update',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          from: doc.status,
          to: doc.status,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
          fields: {
            from: fromName !== null && prevId ? { id: prevId, name: fromName } : null,
            to: { id: body.partner_id, name: toName },
          },
        });
        const set: Record<string, unknown> = { partner_id: body.partner_id };
        if (transfer !== undefined) {
          set.transfer_target = transfer;
          set.target = transfer; // v1 song song
        }
        const r = await cas<Record<string, unknown>>({
          model: 'Document',
          id: params.id,
          ifMatch: body.if_match,
          set,
          push: { history: entry },
          addToSet: { processed_requests: body.request_id },
        });
        if (!r) throw new ApiError({ code: 'FG-WF-011' });
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'document.partner_update',
          subject: { type: doc.kind, id: params.id, code: doc.code },
          company_id: companyId,
          document_id: params.id,
          diff_fields: { from: fromName ?? '—', to: toName },
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        invalidateFor(companyId, actor.user_id);
        return ok(reply, { data: await detailOf(params.id, actor.user_id, requireScope(req).companyIds), version: r.version });
      },
    }),
  );

  /* ---------------------------- liên kết (v2) ---------------------------- */

  /**
   * v2 §11.2 — gán liên kết THỦ CÔNG từ phiếu (quyền `link:manage`):
   *  - `offset` (phiếu thu/chi → khoản công nợ): cấn trừ phải thu / phải trả;
   *  - `repayment` (phiếu chi → khoản nợ NH): trả nợ, có thể tách gốc / lãi / phí;
   *  - `disbursement` (phiếu thu → khoản nợ NH): tiền giải ngân.
   * Cấu trúc, đối tác, sức chứa, trùng cặp kiểm ở domain/links (FG-LINK-*).
   */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/documents/:id/links',
      config: { perms: ['link:manage'] as Permission[], screen: 'DOC-01', summary: 'Gán liên kết thủ công (cấn trừ / trả nợ / giải ngân)' },
      schema: { tags: ['documents'], body: toJsonSchema(documentLinkCreateBody) },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const params = req.params as { id: string };
        const body = validate(documentLinkCreateBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));
        assertDocumentLinkable(String(doc.status));
        const linkActor = { user_id: actor.user_id, name: actor.name, role: actor.role };
        await createLink({
          from: { type: 'document', id: params.id },
          to: { type: manualLinkTargetType(body.relation), id: body.to_id },
          relation: body.relation,
          amount_minor: body.amount_minor ?? null,
          split: body.split ?? null,
          note: body.note ?? null,
          origin: 'manual',
          actor: linkActor,
          scopeCompanyIds: scope.companyIds,
          request_id: body.request_id ?? null,
          ip: requestCtx(req).ip,
        });
        // v2 §10.2 / §14.2: phiếu ĐÃ THỰC THI gán làm giải ngân ⇒ khoản vay "Đang vay" ngay; phiếu đã trả gán làm
        // trả nợ ⇒ kiểm tất toán (loan.settled). Phiếu chưa thực thi: chuyển khi thực thi (bộ máy tự động).
        if (doc.status === 'paid' && body.relation === 'disbursement') await activateLoanOnDisbursement(body.to_id, linkActor);
        if (doc.status === 'paid' && body.relation === 'repayment') await emitLoanSettledAfterPayment(params.id, linkActor).catch(() => []);
        invalidateFor(String(doc.company_id), actor.user_id);
        return ok(reply, { data: await detailOf(params.id, actor.user_id, scope.companyIds) }, { status: 201 });
      },
    }),
  );

  /**
   * v2 §11.2 — gỡ liên kết: đánh dấu `removed` (không xoá), bắt buộc lý do. Chỉ gỡ liên kết NỐI VỚI phiếu này.
   */
  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/documents/:id/links/:linkId',
      config: { perms: ['link:manage'] as Permission[], screen: 'DOC-01', summary: 'Gỡ liên kết (đánh dấu, có lý do; không xoá)' },
      schema: { tags: ['documents'], body: toJsonSchema(linkRemoveBody) },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const params = req.params as { id: string; linkId: string };
        const body = validate(linkRemoveBody, req.body ?? {});
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));
        const owned = /^[0-9a-f]{24}$/i.test(params.linkId)
          ? await Models.BusinessLink.findOne({
              _id: params.linkId,
              company_id: doc.company_id,
              $or: [
                { from_type: 'document', from_id: params.id },
                { to_type: 'document', to_id: params.id },
              ],
            } as never)
              .select({ origin: 1, relation: 1, to_type: 1, to_id: 1 })
              .lean<{ origin?: string | null; relation?: string | null; to_type?: string | null; to_id?: unknown } | null>()
          : null;
        if (!owned) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy liên kết của phiếu này' });
        // v2 §11.2: liên kết do quy trình tự động tạo không gỡ tay — đổi lựa chọn vay trên phiếu để quy trình tự cập nhật.
        // Ngoại lệ `funded_by` (§11.5): gỡ tay để giữ khoản vay cho mục đích khác khi phiếu chi bị huỷ sau khi đã có tiền.
        if (owned.origin === 'automation' && owned.relation !== 'funded_by') {
          throw new ApiError({ code: 'FG-WF-005', detail: 'Liên kết do quy trình tự động tạo — không gỡ tay. Đổi lựa chọn vay trên phiếu để quy trình cập nhật liên kết và khoản vay.' });
        }
        // v2 §11.4 (b): giải ngân tới khoản vay ĐANG CHỌN trên phiếu — cùng quy tắc ở màn khoản vay (`unassignLoanLink`).
        assertDisbursementNotChosenLoan(owned, (doc.options as unknown as { loan?: StoredLoanChoice | null } | null | undefined)?.loan);
        await removeLink({
          link_id: params.linkId,
          reason: body.reason,
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          scopeCompanyIds: scope.companyIds,
          request_id: body.request_id ?? null,
          ip: requestCtx(req).ip,
        });
        invalidateFor(String(doc.company_id), actor.user_id);
        return ok(reply, { data: await detailOf(params.id, actor.user_id, scope.companyIds) });
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
        const query = validate(decisionPackQuery, req.query);
        const doc = await Models.Document.findById(params.id).lean<Record<string, unknown> | null>();
        if (!doc) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        await assertVisible(req, String(doc.company_id));
        // TK đang chọn ở cấp duyệt: phải là TK của công ty phiếu (hoặc TK Tập đoàn cho phiếu Tập đoàn) — như khi duyệt
        if (query.source_account_id) await assertAccountAllowedForCompany(String(doc.company_id), query.source_account_id);
        const pack = await decisionPack(doc, actor.permissions.includes('doc:read'), { sourceAccountId: query.source_account_id ?? null });
        const etagTag = query.source_account_id ? `-${query.source_account_id}` : '';
        return ok(reply, { data: pack }, { etag: `dp-${doc.version}${etagTag}`, maxAge: 15 });
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

  /**
   * Xoá cứng phiếu thu/chi (yêu cầu ADM-01). Cho phép khi:
   *  - actor là Chủ tịch / Tổng Giám đốc (`UNRESTRICTED_DELETE_ROLES`) — xoá được ở bất kỳ
   *    thời điểm & trạng thái nào, không giới hạn phiếu phải còn nháp hay chưa ai duyệt; HOẶC
   *  - phiếu đã BỊ TỪ CHỐI — bất kỳ ai có `doc:delete` (mặc định KTT / Kế toán viên) đều xoá được; HOẶC
   *  - CHÍNH người lập xoá phiếu còn nháp / đang chờ Kế toán trưởng / bị trả về bổ sung, và
   *    chưa có ai từ Kế toán trưởng trở lên duyệt.
   * Mirror audit TRƯỚC khi xoá để còn dấu vết, nhưng KHÔNG ghi vào history hồ sơ
   * (bản ghi sắp bị xoá). Bắt buộc step-up (ADR-14) vì là thao tác phá huỷ —
   * NGOẠI TRỪ Chủ tịch / Tổng Giám đốc (`UNRESTRICTED_DELETE_ROLES`), những tài khoản này
   * xoá được ở mọi trạng thái mà KHÔNG cần xác thực lại mật khẩu / OTP.
   */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/documents/:id/delete',
      config: { perms: ['doc:delete'] as Permission[], stepUp: true, screen: 'DOC-01', summary: 'Xoá phiếu thu/chi (Chủ tịch/TGĐ: mọi trạng thái, bỏ step-up; từ chối: mọi người có quyền xoá; còn lại: người lập, chưa qua KTT ở vòng này)' },
      schema: { tags: ['documents'], body: documentDeleteBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const body = validate(documentDeleteBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));

        const history = (doc.history ?? []) as { action?: string | null; actor?: { role?: string | null } | null }[];
        // Chủ tịch / Tổng Giám đốc: xoá được ở bất kỳ thời điểm & trạng thái nào, không vướng
        // gate người lập hay "chưa ai từ KTT trở lên duyệt", và KHÔNG cần step-up (mật khẩu/OTP).
        // Phiếu đã bị từ chối là trạng thái kết thúc: mọi người có `doc:delete` được xoá.
        // Các trạng thái còn lại vẫn chỉ cho người lập và khi chưa qua cấp KTT trở lên.
        const unrestricted = UNRESTRICTED_DELETE_ROLES.includes(actor.role);
        const allowed =
          unrestricted ||
          doc.status === 'rejected' ||
          (String(doc.created_by) === actor.user_id &&
            ['draft', 'pending.ktt', 'changes_requested'].includes(doc.status) &&
            !roundLocksEdit(String(doc.status), approvedFromChiefAccountantUp(history)));
        if (!allowed) {
          throw new ApiError({
            code: 'FG-RBAC-001',
            detail: 'Phiếu đã bị từ chối thì ai có quyền xoá cũng xoá được; các trạng thái khác chỉ người lập xoá được (phiếu còn nháp / đang chờ Kế toán trưởng / bị trả về bổ sung) và chưa qua cấp Kế toán trưởng trở lên ở vòng này — trừ tài khoản Chủ tịch / Tổng Giám đốc xoá được ở mọi trạng thái',
          });
        }

        // Step-up (ADR-14) cho thao tác phá huỷ — bỏ qua với Chủ tịch / Tổng Giám đốc.
        if (!unrestricted) await assertStepUp(actor.user_id, body.verify);

        // [v2] khoản vay mà phiếu giải ngân này đã đưa về `active`: kiểm TRƯỚC khi đảo sổ (chặn nếu đã có phiếu trả nợ thực thi).
        const loansToRevert = await loansToRevertOnDelete(params.id);

        // §8 — sổ cái CHỈ THÊM: phiếu đã thực thi được ĐẢO từng bút toán (không xoá entry cũ) rồi mới xoá hồ sơ.
        // Làm TRƯỚC khi xoá: nếu đảo lỗi thì phiếu còn nguyên và thao tác thử lại được (đảo idempotent).
        const reversal = await reverseLedgerForDocument(params.id, actor);

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'document.delete',
          subject: { type: doc.kind, id: params.id, code: doc.code },
          company_id: String(doc.company_id),
          document_id: params.id,
          diff_fields: { reason: body.reason, status: doc.status, amount_minor: doc.amount.minor.toString(), reversed_entries: reversal.reversed },
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });

        await Models.Attachment.deleteMany({ document_id: params.id } as never).exec();
        // [v2] khoản vay do phiếu giải ngân đã thực thi làm `active` ⇒ về `Chờ giải ngân` (tiền đã đảo ở trên). Chạy trước
        // R6 để khoản tự sinh còn chờ giải ngân được huỷ theo cùng quyết định.
        await revertLoansOnDelete(loansToRevert, {
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          reason: `Phiếu giải ngân ${doc.code} đã bị xoá`,
          requestId: body.request_id ?? null,
        });
        // [v2] khoản vay do quy trình tự động sinh từ phiếu sắp xoá: khoản CHƯA có tiền được huỷ (không để treo trong
        // dự báo dòng tiền); khoản đã có tiền không tự huỷ (§11.5, §14.3 (6))
        await releaseLoansOfSource({
          sourceId: params.id,
          reason: 'Phiếu nguồn đã bị xoá',
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          requestId: body.request_id,
        });
        // [v2] liên kết còn hiệu lực của phiếu sắp xoá được GỠ MỀM (có lý do) — không để sức chứa công nợ/khoản vay treo
        await softRemoveLinksOfDocument({
          documentId: params.id,
          companyId: String(doc.company_id),
          actorId: actor.user_id,
          reason: 'Phiếu nguồn đã bị xoá',
        });
        const r = await Models.Document.deleteOne({ _id: params.id } as never).exec();
        if (!r.deletedCount) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy hồ sơ' });
        invalidateFor(String(doc.company_id));
        return ok(reply, { data: { ok: true, deleted_id: params.id, reversed_entries: reversal.reversed } });
      },
    }),
  );

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
          const fresh = await detailOf(params.id, actor.user_id, requireScope(req).companyIds);
          return ok(reply, { data: fresh, idempotent: true });
        }

        // §11.5 — cấp duyệt đổi số tiền phiếu chi chỉ trước khi R3 đã tạo khoản vay cho phiếu này.
        if ((body.action === 'approve' || body.action === 'approve_with_reason') && body.amount_minor !== undefined) {
          await assertApprovalAmountEditable(params.id, BigInt(String(doc.amount.minor)), BigInt(body.amount_minor));
        }
        const result = await transition({ doc, actor, body, ip: requestCtx(req).ip });
        // Đổi trạng thái duyệt → số "Chờ tôi duyệt" (badge) và overview đổi ngay;
        // không xoá cache thì badge giữ số cũ tới hết TTL (60s) dù danh sách đã tươi.
        invalidateFor(String(doc.company_id), actor.user_id);
        const fresh = await detailOf(params.id, actor.user_id, requireScope(req).companyIds);
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

  /**
   * Xoá chứng từ chưa bị cấp duyệt tham chiếu (DS §7.9). Khi `referenced_by` còn rỗng
   * thì file chưa được dùng làm căn cứ ở bất kỳ cấp nào → được phép xoá; ngược lại giữ
   * nguyên (chỉ thêm, không xoá) để bảo toàn audit.
   */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/documents/:id/attachments/:attachmentId/remove',
      config: { perms: ['doc:create'] as Permission[], screen: 'DOC-01', summary: 'Xoá chứng từ chưa bị tham chiếu' },
      schema: { tags: ['documents'], body: attachmentRemoveBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string; attachmentId: string };
        const body = validate(attachmentRemoveBody, req.body);
        const doc = await loadDoc(params.id);
        await assertVisible(req, String(doc.company_id));
        if (['paid', 'rejected', 'cancelled'].includes(doc.status)) {
          throw new ApiError({ code: 'FG-WF-005', detail: 'Hồ sơ đã đóng — không xoá chứng từ' });
        }

        const attachments = (doc.attachments ?? []) as unknown as {
          id: unknown;
          type: string;
          key: string;
          version?: number;
          filename?: string;
          referenced_by?: unknown[];
        }[];
        const att = attachments.find((a) => String(a.id) === params.attachmentId);
        if (!att) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy chứng từ' });
        if (Array.isArray(att.referenced_by) && att.referenced_by.length > 0) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chứng từ đã được cấp duyệt tham chiếu — chỉ thêm, không xoá (audit)' });
        }

        const remaining = attachments.filter((a) => String(a.id) !== params.attachmentId);
        const base = await rebuildEvidence({ kind: doc.kind, category_id: doc.category_id ?? null, company_id: String(doc.company_id) } as never);
        const present = [...new Set(remaining.map((a) => String(a.type)))];
        const evidence = { required: base.required, present, missing: base.required.filter((t) => !present.includes(t)) };

        const entry = buildHistoryEntry({
          action: 'attachment_remove',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          from: doc.status,
          to: doc.status,
          reason: body.reason ?? null,
          request_id: body.request_id,
          ip: requestCtx(req).ip,
          fields: { file: att.filename, version: att.version },
        });
        const r = await cas<Record<string, unknown>>({
          model: 'Document',
          id: params.id,
          ifMatch: body.if_match,
          set: { evidence },
          pull: { attachments: { id: att.id } },
          push: { history: entry },
          addToSet: { processed_requests: body.request_id },
        });
        if (!r) throw new ApiError({ code: 'FG-WF-011' });
        await Models.Attachment.deleteOne({ document_id: params.id, attachment_id: att.id } as never).exec();
        await storage().remove(String(att.key)).catch(() => undefined);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'document.attachment_remove',
          subject: { type: doc.kind, id: params.id, code: doc.code },
          company_id: String(doc.company_id),
          document_id: params.id,
          diff_fields: { file: att.filename, reason: body.reason ?? null },
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        invalidateFor(String(doc.company_id), actor.user_id);
        return ok(reply, { data: { ok: true, evidence, version: r.version } });
      },
    }),
  );

  /** Tải chứng từ: check quyền TỪNG LẦN rồi 302 sang URL ngắn hạn (§11). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/attachments/:id',
      config: { perms: [], permsAny: ['doc:read', 'debt:read', 'loan:read'] as Permission[], screen: 'DOC-01', summary: 'Tải chứng từ' },
      handler: async (req, reply: FastifyReply) => {
        const actor = requireActor(req);
        const params = req.params as { id: string };
        const att = await Models.Attachment.findOne({ attachment_id: params.id, state: 'confirmed' } as never).lean<
          { _id: unknown; owner_type?: string; owner_id?: unknown; document_id?: unknown; attachment_id: unknown; company_id: unknown; key: unknown; filename?: unknown; mime?: unknown } | null
        >();
        if (!att) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy chứng từ' });
        await assertVisible(req, String(att.company_id));
        // Chỉ TẢI VỀ đích danh mới tính là "tham chiếu" và khoá xoá (DS §7.9);
        // xem trước inline (thumbnail/lightbox) không khoá file.
        const isDownload = String((req.query as { download?: unknown }).download ?? '') === '1';
        if (isDownload) {
          const ownerType = String(att.owner_type ?? 'document');
          const model = ownerType === 'debt' ? Models.DebtVoucher : ownerType === 'loan' ? Models.BankDebt : Models.Document;
          void (model as unknown as { updateOne: (f: unknown, u: unknown) => { exec: () => Promise<unknown> } })
            .updateOne(
              { _id: att.owner_id ?? att.document_id, 'attachments.id': att.attachment_id },
              { $addToSet: { 'attachments.$.referenced_by': actor.user_id } },
            )
            .exec();
        }
        const adapter = storage();
        const disposition = isDownload ? `attachment; filename="${encodeURIComponent(String(att.filename ?? 'file'))}"` : 'inline';
        // fs/dev: không có presigned → phục vụ bytes trực tiếp (đúng mime để xem inline).
        if (adapter.readBytes) {
          const bytes = await adapter.readBytes(String(att.key)).catch(() => null);
          if (!bytes) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy tệp' });
          return reply
            .header('cache-control', 'private, no-store')
            .header('content-security-policy', "frame-ancestors 'self'")
            .header('content-disposition', disposition)
            .type(String(att.mime ?? 'application/octet-stream'))
            .send(bytes);
        }
        const url = await adapter.presignGet(String(att.key), 60);
        reply.header('content-disposition', disposition);
        return reply.code(302).header('location', url).header('cache-control', 'private, no-store').send();
      },
    }),
  );

  /** fs/dev: nhận PUT trực tiếp byte (khi STORAGE_DRIVER=fs không có presign). */
  app.route(
    defineRoute({
      method: 'PUT',
      url: '/storage/put',
      bodyLimit: 26 * 1024 * 1024,
      config: { perms: 'public', screen: 'DOC-01', summary: 'Upload cho STORAGE_DRIVER=fs (dev/Profile O)' },
      handler: async (req, reply) => {
        const key = (req.query as { key?: string }).key ?? '';
        if (!/^uploads\/[\w./-]+$/.test(key)) throw new ApiError({ code: 'FG-VAL-001', detail: 'Key không hợp lệ' });
        const actor = requireActor(req);
        await assertUploadKeyVisible(req, key);
        const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        if (!buf.length) throw new ApiError({ code: 'FG-VAL-003', detail: 'Không nhận được nội dung tệp' });
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
        await assertUploadKeyVisible(req, key);
        const adapter = storage();
        if (adapter.readBytes) {
          const bytes = await adapter.readBytes(key).catch(() => null);
          if (!bytes) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy tệp' });
          const ext = key.split('.').pop()?.toLowerCase();
          const mime =
            ext === 'pdf' ? 'application/pdf' : ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
          return reply
            .header('cache-control', 'private, no-store')
            .header('content-security-policy', "frame-ancestors 'self'")
            .type(mime)
            .send(bytes);
        }
        const url = await adapter.presignGet(key, 60);
        return reply.code(302).header('location', url).header('cache-control', 'private, no-store').send();
      },
    }),
  );

  /* -------------------- RENEW-04 · kết quả thực hiện đảo hạn -------------------- */

  app.route(
    defineRoute({
      method: 'POST',
      url: '/documents/:id/rollover-result',
      config: { perms: ['rollover:act'] as Permission[], screen: 'RENEW-04', summary: 'Cập nhật kết quả thực hiện đảo hạn' },
      schema: { tags: ['documents'], body: rolloverResultBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(rolloverResultBody, req.body);
        const doc = await loadDoc(id);
        if (String(doc.kind) !== 'rollover') {
          throw new ApiError({ code: 'FG-VAL-001', errors: { kind: 'Hồ sơ không phải phương án đảo hạn' } });
        }
        await assertVisible(req, String(doc.company_id));
        if (!['approved', 'paid'].includes(String(doc.status))) {
          throw new ApiError({ code: 'FG-WF-005', detail: 'Chỉ cập nhật kết quả sau khi phương án được duyệt' });
        }
        if (doc.processed_requests?.includes(body.request_id)) {
          return ok(reply, { data: await detailOf(id, actor.user_id, requireScope(req).companyIds), idempotent: true });
        }

        // Kết quả chỉ ghi khi cập nhật được khoản vay (v2 §10.3) — kiểm TRƯỚC khi đổi trạng thái phiếu.
        if (!doc.loan_id) {
          throw new ApiError({ code: 'FG-VAL-001', detail: 'Phương án chưa gắn khoản vay — gắn khoản vay trước khi ghi kết quả', errors: { loan_id: 'Phương án chưa gắn khoản vay' } });
        }
        await assertRolloverResultForLoan(String(doc.loan_id), body.new_maturity_date);

        const result = {
          done_at: body.done_at,
          new_contract_code: body.new_contract_code,
          new_maturity_date: body.new_maturity_date,
          new_limit: { minor: BigInt(body.new_limit.amount_minor), currency: body.new_limit.currency, decimals: 0 },
          new_rate: body.new_rate,
          actual_fee: { minor: BigInt(body.actual_fee.amount_minor), currency: body.actual_fee.currency, decimals: 0 },
          note: body.note ?? null,
        };
        const entry = buildHistoryEntry({
          action: 'rollover_result',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          from: String(doc.status),
          to: String(doc.status),
          request_id: body.request_id,
          ip: requestCtx(req).ip,
          fields: { new_contract_code: body.new_contract_code, new_rate: body.new_rate },
        });
        const saved = await cas<Record<string, unknown>>({
          model: 'Document',
          id,
          ifMatch: body.if_match,
          extraFilter: { status: { $in: ['approved', 'paid'] } },
          set: { 'rollover.result': result, updated_at: new Date() },
          push: { history: entry },
          addToSet: { processed_requests: body.request_id },
        });
        if (!saved) throw new ApiError({ code: 'FG-WF-011', detail: 'Hồ sơ vừa được cập nhật bởi người khác' });

        // Cập nhật khoản vay (v2 §10.3): hạn thanh toán, kỳ kế tiếp, hạn mức, lãi suất, số HĐ — KHÔNG tự tất toán / tạo khoản mới.
        if (doc.loan_id) {
          await applyRolloverResultToLoan(
            String(doc.loan_id),
            {
              document_id: id,
              document_code: String(doc.code ?? ''),
              new_maturity_date: body.new_maturity_date,
              new_contract_code: body.new_contract_code,
              new_limit_minor: BigInt(body.new_limit.amount_minor),
              new_rate: body.new_rate,
              actual_fee_minor: BigInt(body.actual_fee.amount_minor),
            },
            { user_id: actor.user_id, name: actor.name, role: actor.role },
            requestCtx(req).ip,
          );
        }
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'rollover.result',
          subject: { type: doc.kind, id, code: doc.code },
          company_id: String(doc.company_id),
          document_id: id,
          diff_fields: { new_contract_code: body.new_contract_code, new_rate: body.new_rate },
          request_id: body.request_id,
          ip: requestCtx(req).ip,
        });
        invalidateFor(String(doc.company_id), actor.user_id);
        return ok(reply, { data: await detailOf(id, actor.user_id, requireScope(req).companyIds), version: saved.version });
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

/** `findById` KHÔNG kèm scope → tra company_id rồi kiểm tra trước khi trả chi tiết. */
async function assertDocVisible(req: FastifyRequest, id: string): Promise<void> {
  const doc = await Models.Document.findById(id).select({ company_id: 1 }).lean<{ company_id?: unknown } | null>();
  if (!doc) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy hồ sơ' });
  await assertVisible(req, String(doc.company_id));
}

/** Key `uploads/{companyCode}/{docCode}/{attachmentId}_v{n}_...` → chứng từ phải thuộc phạm vi (§7.5). */
async function assertUploadKeyVisible(req: FastifyRequest, key: string): Promise<void> {
  const file = key.split('/').pop() ?? '';
  const attachmentId = file.split('_')[0] ?? '';
  const att = await Models.Attachment.findOne({ attachment_id: attachmentId }).select({ company_id: 1 }).lean<{ company_id?: unknown } | null>();
  if (!att) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy chứng từ' });
  await assertVisible(req, String(att.company_id));
}

async function rebuildEvidenceForDoc(id: string, doc: { kind: DocKind; category_id?: string | null; company_id: string }): Promise<{ required: string[]; present: string[]; missing: string[] }> {
  const fresh = await Models.Document.findById(id).select({ attachments: 1 }).lean<{ attachments?: { type: string }[] } | null>();
  const base = await rebuildEvidence({ kind: doc.kind, category_id: doc.category_id ?? null, company_id: String(doc.company_id) } as never);
  const present = [...new Set((fresh?.attachments ?? []).map((a) => String(a.type)))];
  return { required: base.required, present, missing: base.required.filter((t) => !present.includes(t)) };
}

/** Bản chi tiết + `can` (quền của người gọi trên CHÍNH hồ sơ này). */
export async function detailOf(id: string, userId: string, scopeCompanyIds: string[] | null): Promise<Record<string, unknown>> {
  const doc = await Models.Document.findById(id).lean<Record<string, unknown> | null>();
  if (!doc) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy hồ sơ' });

  const [creator, company, assignments, delegated] = await Promise.all([
    Models.User.findById(doc.created_by).select({ display_name: 1, email: 1 }).lean(),
    Models.Company.findById(doc.company_id).select({ name: 1, code: 1 }).lean(),
    Models.Assignment.find({ user_id: userId, status: 'active' }).select({ company_id: 1, role: 1, amount_limit_minor: 1, extra_permissions: 1, denied_permissions: 1, scope_all: 1 }).lean(),
    Models.Delegation.find({ to_user_id: userId, status: 'active', valid_from: { $lte: new Date() }, valid_to: { $gte: new Date() } }).select({ user_id: 1, role: 1 }).lean(),
  ]);

  const actorCompany = assignments.find((a) => String(a.company_id) === String(doc.company_id)) ?? assignments[0];
  // Nhân sự có thể trực thuộc nhiều công ty → thấy hồ sơ của mọi công ty mình được gán.
  const actorCompanies = assignments.map((a) => String(a.company_id)).filter(Boolean);
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

  const history = (doc.history ?? []) as { action?: string | null; actor?: { role?: string | null } | null }[];

  const can = documentPermissions(
    {
      user_id: userId,
      permissions: [...permissions],
      amount_limit_minor: limit,
      role: (actorCompany?.role ?? 'staff') as Role,
    },
    {
      status: String(doc.status),
      kind: String(doc.kind),
      created_by: String(doc.created_by),
      amount_minor: amountMinor,
      steps,
      evidence_missing: evidence.missing ?? [],
      company_id: String(doc.company_id),
      actor_companies: actorCompanies,
      delegatedStepOrders: delegated.map((d) => steps.find((s) => String(s.user_id) === String(d.user_id))?.order ?? -1).filter((o) => o >= 0),
      approved_from_ktt_up: roundLocksEdit(String(doc.status), approvedFromChiefAccountantUp(history)),
    },
  );

  const currentStep = steps.find((s) => s.state === 'current') ?? steps.find((s) => s.state === 'waiting') ?? null;
  const owner = currentStep?.user_id ? await Models.User.findById(currentStep.user_id).select({ display_name: 1 }).lean() : null;

  // công ty đích (chuyển nội bộ / phiếu chi trả tài khoản nội bộ) — để UI hiện "A → B".
  const targetRaw = (doc.target ?? null) as { company_id?: unknown; account_id?: unknown } | null;
  const targetCompany = targetRaw?.company_id
    ? await Models.Company.findById(String(targetRaw.company_id)).select({ name: 1, code: 1 }).lean<{ name?: string; code?: string } | null>()
    : null;
  const target = targetRaw
    ? { ...targetRaw, company_name: targetCompany?.name ? String(targetCompany.name) : null, company_code: targetCompany?.code ? String(targetCompany.code) : null }
    : null;

  // [v2] đối tác / tag / tuỳ chọn vay / chuyển nội bộ / nguồn gốc / liên kết / lượt tự động — nạp sống theo ID
  const refs = await buildVoucherRefView(doc, scopeCompanyIds);
  return {
    _id: String(doc._id),
    code: String(doc.code),
    kind: String(doc.kind) as DocKind,
    kind_label: DOC_KIND_LABEL[String(doc.kind) as DocKind] ?? '',
    company_id: String(doc.company_id),
    company_name: String(company?.name ?? ''),
    department_id: doc.department_id ? String(doc.department_id) : null,
    created_by: String(doc.created_by),
    created_by_name: String(creator?.display_name ?? creator?.email ?? ''),
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
    // [v2] dẫn xuất từ đối tác (dữ liệu v1 chưa migrate giữ nguyên `payee`)
    payee: refs.payee,
    amount: wireAmount(doc.amount),
    fx: doc.fx ?? null,
    source: { ...(doc.source as object), account_label: null, balance_available: null },
    planned_date: String(doc.planned_date ?? ''),
    business_date: String(doc.business_date ?? today()),
    priority: String(doc.priority ?? 'normal'),
    contract: doc.contract ?? {},
    loan_id: doc.loan_id ? String(doc.loan_id) : null,
    budget: doc.budget ?? { in_plan: true },
    target,
    transfer_target: refs.transfer_target,
    partner_id: refs.partner_id,
    partner: refs.partner,
    tag_ids: refs.tag_ids,
    tags: refs.tags,
    options: refs.options,
    origin: refs.origin,
    links: refs.links,
    automation_runs: refs.automation_runs,
    rollover: doc.rollover ?? null,
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
    execution: (() => {
      const ex = doc.execution as
        | { paid_at?: string | null; bank_ref?: string | null; executed_by?: unknown; actual_amount?: unknown }
        | null
        | undefined;
      if (!ex) return null;
      return {
        paid_at: ex.paid_at ?? null,
        bank_ref: ex.bank_ref ?? null,
        executed_by: ex.executed_by ? String(ex.executed_by) : null,
        actual_amount: wireAmount(ex.actual_amount),
      };
    })(),
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
    // §6.2 — nút sửa tag chỉ hiện cho người lập / kế toán trưởng (khớp rule của PATCH /documents/:id/tags)
    can: {
      ...can,
      tag: can.tag && mayChangeVoucherTags({ user_id: userId, permissions: [...permissions] }, { created_by: String(doc.created_by) }),
    },
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
  return effectivePermissions(role as Role, extra as Permission[], denied as Permission[]);
}

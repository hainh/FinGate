/**
 * Nhóm route tài chính: BANK-0x · LOAN-0x · RENEW-0x · DEBT-0x · chuyển tiền nội bộ (§XXI).
 *
 * Số dư KHÔNG sửa trực tiếp ở đây — mọi thay đổi đi qua `balances_daily` (CAS theo doc ngày)
 * và `check:tie` đối chiếu hằng đêm (§8.5).
 */

import type { FastifyInstance } from 'fastify';
import {
  ApiError,
  addDays,
  dayEndOf,
  dayStartOf,
  daysUntil,
  formatMoney,
  money,
  normalizePlannedDate,
  today,
  type Permission,
} from '@fingate/shared';
import { Models } from '../db/models.ts';
import { assertCompanyScope, defineRoute, requestCtx, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import {
  bankAccountUpsertBody,
  balancesBulkBody,
  debtListQuery,
  debtUpsertBody,
  internalTransferBody,
  loanUpsertBody,
  rolloverListQuery,
  statementImportBody,
} from '@fingate/shared';
import { bankAccountUpsertBodySchema, balancesBulkBodySchema, debtUpsertBodySchema, internalTransferBodySchema, loanUpsertBodySchema, statementImportBodySchema } from './schemas.ts';
import { accountSnapshots, asBigInt, maskAccount, maturityLadder, wire} from '../domain/queries/index.ts';
import { scopedFind } from '../lib/mongo.ts';
import { mirrorAudit, buildHistoryEntry } from '../domain/audit/index.ts';
import { nextDocumentCode } from '../domain/numbering/index.ts';
import { invalidateFor } from '../domain/side-effects.ts';

export function financeRoutes(app: FastifyInstance): void {
  /* ------------------------------- BANK ------------------------------- */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-accounts',
      config: { perms: ['doc:read'] as Permission[], screen: 'BANK-01', summary: 'Tài khoản ngân hàng + số dư' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const rows = await accountSnapshots(scope, {
          includeClosed: (req.query as { include_closed?: string }).include_closed === 'true',
          // Công ty con thấy tài khoản Tập đoàn để chọn nguồn tiền (§VIII).
          includeGroup: true,
        });
        return ok(
          reply,
          {
            items: rows.map((r) => ({
              _id: r.account_id,
              company_id: r.company_id,
              company_name: r.company_name,
              is_group: r.is_group,
              label: r.label,
              bank_name: r.label.split(' ')[0] ?? '',
              account_number_masked: r.account_number_masked,
              account_number: r.account_number_masked,
              kind: r.kind,
              currency: r.currency,
              status: r.status,
              balance: wire(r.closing, r.currency),
              available: wire(r.available, r.currency),
              blocked: wire(r.blocked, r.currency),
              min_balance: wire(r.min_balance, r.currency),
              breach: r.breach,
              stale: r.stale,
              balance_date: r.balance_date,
            })),
            totals: {
              available: wire(rows.reduce((a, r) => a + r.available, 0n)),
              blocked: wire(rows.reduce((a, r) => a + r.blocked, 0n)),
            },
          },
          { maxAge: 15 },
        );
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-accounts',
      config: { perms: ['bank:write'] as Permission[], screen: 'BANK-02', summary: 'Tạo/sửa tài khoản' },
      schema: { tags: ['bank'], body: bankAccountUpsertBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const body = validate(bankAccountUpsertBody, req.body);
        if (body.is_group && !actor.permissions.includes('admin:group_accounts')) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ Chủ tịch HĐQT cấu hình tài khoản Tập đoàn (§VIII)' });
        }
        // Tài khoản Tập đoàn chỉ tạo từ tầm nhìn toàn tập đoàn (chairman/admin).
        if (body.is_group && scope.companyIds !== null) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ cấp Tập đoàn mới tạo được tài khoản Tập đoàn' });
        }
        const companyId = body.is_group ? null : (body.company_id ?? actor.company_id);
        if (!body.is_group && !companyId) throw new ApiError({ code: 'FG-RBAC-002', detail: 'Chưa chọn công ty' });
        // Giám đốc chỉ tạo tài khoản cho công ty trong phạm vi của mình; Chủ tịch tạo được mọi công ty con.
        if (companyId && scope.companyIds !== null && !scope.companyIds.includes(companyId)) {
          throw new ApiError({ code: 'FG-RBAC-002', detail: 'Chỉ được tạo tài khoản cho công ty trong phạm vi của bạn' });
        }

        const dup = await Models.BankAccount.findOne({ account_number: body.account_number, company_id: companyId }).lean();
        if (dup) throw new ApiError({ code: 'FG-VAL-001', errors: { account_number: 'Số tài khoản này đã tồn tại trong công ty' } });

        const created = await Models.BankAccount.create({
          company_id: companyId,
          is_group: body.is_group,
          bank_name: body.bank_name,
          account_name: body.account_name,
          account_number: body.account_number,
          branch: body.branch ?? null,
          kind: body.kind,
          currency: body.currency,
          manager_user_id: body.manager_user_id ?? null,
          limit_minor: body.limit_minor ? BigInt(body.limit_minor) : null,
          min_balance_minor: BigInt(body.min_balance_minor),
          show_on_dashboard: body.show_on_dashboard,
          status: body.status,
          note: body.note ?? null,
        } as never);

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'bank_account.create',
          subject: { type: 'bank_account', id: String(created._id), code: maskAccount(body.account_number) },
          company_id: companyId,
          ip: requestCtx(req).ip,
        });
        invalidateFor(companyId);
        return ok(reply, { data: { _id: String(created._id), account_number_masked: maskAccount(body.account_number) } }, { status: 201 });
      },
    }),
  );

  /** Khoá tài khoản Tập đoàn → cảnh báo hồ sơ đang tham chiếu (§VIII). */
  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/bank-accounts/:id/status',
      config: { perms: ['bank:write'] as Permission[], screen: 'BANK-02', summary: 'Đóng/khoá/mở tài khoản' },
      handler: async (req) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = (req.body ?? {}) as { status?: string };
        const status = body.status === 'closed' || body.status === 'frozen' || body.status === 'active' ? body.status : null;
        if (!status) throw new ApiError({ code: 'FG-VAL-001', errors: { status: 'Trạng thái không hợp lệ' } });
        const acct = await Models.BankAccount.findById(id).lean();
        if (!acct) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        if (acct.is_group && !actor.permissions.includes('admin:group_accounts')) throw new ApiError({ code: 'FG-RBAC-001' });
        // Tài khoản thường phải thuộc công ty trong phạm vi hiện tại.
        if (!acct.is_group) assertCompanyScope(req, acct.company_id ? String(acct.company_id) : null);
        if (status !== 'active') {
          const referencing = await Models.Document.countDocuments({
            status: { $in: ['draft', 'pending.ktt', 'pending.pgd', 'pending.gd', 'pending.chairman', 'approved', 'processing'] },
            $or: [{ 'source.account_id': id }, { 'source.group_account_id': id }],
          } as never);
          if (referencing > 0) {
            throw new ApiError({
              code: 'FG-SYS-003',
              status: 409,
              detail: `${referencing} hồ sơ đang chờ xử lý tham chiếu tài khoản này. Chuyển nguồn tiền trước khi khoá.`,
              data: { referencing_documents: referencing },
            });
          }
        }
        await Models.BankAccount.updateOne({ _id: id }, { $set: { status, updated_at: new Date() } }).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: `bank_account.${status}`,
          subject: { type: 'bank_account', id, code: maskAccount(String(acct.account_number ?? '')) },
          company_id: acct.company_id ? String(acct.company_id) : null,
          ip: requestCtx(req).ip,
        });
        invalidateFor(acct.company_id ? String(acct.company_id) : null);
        return { data: { ok: true, status } };
      },
    }),
  );

  /** BANK-04 — nhập số dư đầu ngày. Tự kiểm `đầu + vào − ra = cuối`, lỗi inline per dòng. */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-accounts/balances',
      config: { perms: ['bank:write'] as Permission[], screen: 'BANK-04', summary: 'Nhập số dư theo ngày' },
      schema: { tags: ['bank'], body: balancesBulkBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const body = validate(balancesBulkBody, req.body);
        const errors: { index: number; field: string; message: string }[] = [];
        const accountIds = body.entries.map((e) => e.account_id);
        const accounts = await Models.BankAccount.find({ _id: { $in: accountIds } as never }).select({ company_id: 1, min_balance_minor: 1 }).lean();
        const byId = new Map(accounts.map((a) => [String(a._id), a]));

        body.entries.forEach((e, i) => {
          const opening = BigInt(e.opening_minor);
          const inflow = BigInt(e.inflow_minor);
          const outflow = BigInt(e.outflow_minor);
          const closing = BigInt(e.closing_minor);
          if (opening + inflow - outflow !== closing) {
            errors.push({ index: i, field: 'closing_minor', message: `Không khớp: ${formatMoney(money(opening + inflow - outflow), { mode: 'compact' })} ≠ ${formatMoney(money(closing), { mode: 'compact' })}` });
          }
        });
        if (errors.length) {
          throw new ApiError({
            code: 'FG-VAL-001',
            detail: 'Một số dòng không cân đối đầu + vào − ra = cuối',
            errors: Object.fromEntries(errors.map((e) => [`entries.${e.index}.${e.field}`, e.message])),
            data: { row_errors: errors },
          });
        }

        let saved = 0;
        for (const e of body.entries) {
          const acct = byId.get(e.account_id);
          if (!acct?.company_id) continue;
          if (scope.companyIds !== null && !scope.companyIds.includes(String(acct.company_id))) {
            throw new ApiError({ code: 'FG-RBAC-002' });
          }
          const blocked = BigInt(e.blocked_minor);
          const closing = BigInt(e.closing_minor);
          const min = BigInt(acct.min_balance_minor ?? 0);
          await Models.BalanceDaily.updateOne(
            { account_id: e.account_id, date: body.date },
            {
              $set: {
                company_id: acct.company_id,
                account_id: e.account_id,
                date: body.date,
                opening_minor: BigInt(e.opening_minor),
                actual_in_minor: BigInt(e.inflow_minor),
                actual_out_minor: BigInt(e.outflow_minor),
                closing_minor: closing,
                blocked_minor: blocked,
                min_balance_minor: min,
                breach: closing - blocked < min,
                source: 'manual',
                updated_at: new Date(),
              },
              $inc: { version: 1 },
            },
            { upsert: true },
          ).exec();
          saved++;
        }
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'balances.enter',
          subject: { type: 'balances_daily', id: body.date, code: `${saved} tài khoản` },
          company_id: null,
          ip: requestCtx(req).ip,
        });
        invalidateFor(null, actor.user_id);
        return ok(reply, { data: { saved, date: body.date } }, { status: 201 });
      },
    }),
  );

  /** BANK-05 — lịch sử số dư theo ngày. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-accounts/balances/history',
      config: { perms: ['bank:read'] as Permission[], screen: 'BANK-05', summary: 'Lịch sử số dư theo ngày' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = req.query as { from?: string; to?: string; account_id?: string };
        const filter: Record<string, unknown> = {};
        if (q.from || q.to) filter.date = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
        if (q.account_id) filter.account_id = q.account_id;
        const rows = await scopedFind<Record<string, unknown>>(Models.BalanceDaily, scope, filter, { sort: { date: -1 }, limit: 500 });
        const accounts = await Models.BankAccount.find({}).select({ bank_name: 1, account_number: 1 }).lean();
        const amap = new Map(accounts.map((a) => [String(a._id), `${a.bank_name} ${maskAccount(String(a.account_number))}`]));
        const companies = await Models.Company.find({}).select({ name: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
        return ok(
          reply,
          {
            items: rows.map((r) => {
              const closing = asBigInt(r.closing_minor);
              const blocked = asBigInt(r.blocked_minor);
              const min = asBigInt(r.min_balance_minor);
              return {
                date: String(r.date),
                company_id: String(r.company_id),
                company_name: cmap.get(String(r.company_id)) ?? '',
                account_id: String(r.account_id),
                account_label: amap.get(String(r.account_id)) ?? '',
                opening: wire(asBigInt(r.opening_minor)),
                inflow: wire(asBigInt(r.actual_in_minor)),
                outflow: wire(asBigInt(r.actual_out_minor)),
                closing: wire(closing),
                blocked: wire(blocked),
                available: wire(closing - blocked),
                min_balance: wire(min),
                breach: closing - blocked < min,
                diff_minor: (closing - (asBigInt(r.opening_minor) + asBigInt(r.actual_in_minor) - asBigInt(r.actual_out_minor))).toString(),
              };
            }),
          },
          { maxAge: 30 },
        );
      },
    }),
  );

  /** BANK-09 — import sao kê (CSV/xlsx đã parse ở FE) — chặn trùng theo (account,date,ref). */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/bank-accounts/:id/statement-import',
      config: { perms: ['bank:write'] as Permission[], screen: 'BANK-09', summary: 'Nhập khẩu sao kê' },
      schema: { tags: ['bank'], body: statementImportBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(statementImportBody, req.body);
        const account = await Models.BankAccount.findById(id).lean();
        if (!account) throw new ApiError({ code: 'FG-WF-001', status: 404 });
        assertCompanyScope(req, account.company_id ? String(account.company_id) : null);
        let inserted = 0;
        const duplicates: string[] = [];
        for (const row of body.rows) {
          try {
            await Models.BankTransaction.create({
              account_id: id,
              company_id: account.company_id,
              value_date: row.value_date,
              ref: row.ref,
              description: row.description,
              amount_minor: BigInt(row.amount_minor),
              document_id: row.matched_document_id ?? null,
              matched: Boolean(row.matched_document_id),
              import_batch: body.date,
            } as never);
            inserted++;
          } catch (err) {
            if ((err as { code?: number }).code === 11000) duplicates.push(row.ref);
            else throw err;
          }
        }
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'bank.statement_import',
          subject: { type: 'bank_account', id, code: `${inserted} dòng` },
          company_id: String(account.company_id),
          ip: requestCtx(req).ip,
        });
        invalidateFor(String(account.company_id));
        return ok(reply, { data: { inserted, duplicates, total_rows: body.rows.length } }, { status: 201 });
      },
    }),
  );

  /* ------------------------------- LOAN ------------------------------- */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/loans',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-01', summary: 'Danh sách khoản vay' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const rows = await scopedFind<Record<string, unknown>>(Models.Loan, scope, (req.query as { status?: string }).status ? { status: (req.query as { status: string }).status } : {},
                    { sort: { maturity_date: 1 }, limit: 200 },
        );
        const companies = await Models.Company.find({}).select({ name: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
        const items = rows.map((l) => {
          const due = String(l.next_due_date || l.maturity_date || today());
          return {
            _id: String(l._id),
            company_id: String(l.company_id),
            company_name: cmap.get(String(l.company_id)) ?? '',
            bank_name: String(l.bank_name),
            contract_code: String(l.contract_code),
            limit: wire(asBigInt(l.limit_minor), String(l.currency ?? 'VND')),
            outstanding: wire(asBigInt(l.outstanding_minor), String(l.currency ?? 'VND')),
            currency: String(l.currency ?? 'VND'),
            disbursed_at: String(l.disbursed_at),
            maturity_date: String(l.maturity_date),
            next_due_date: l.next_due_date ? String(l.next_due_date) : null,
            days_to_due: daysUntil(due),
            interest_rate: String(l.interest_rate),
            interest_period: String(l.interest_period),
            principal_period: String(l.principal_period),
            collateral: (l.collateral as string | null) ?? null,
            manager_name: null as string | null,
            status: String(l.status),
            rollover_status: null as string | null,
            updated_at: l.updated_at ? new Date(String(l.updated_at)).toISOString() : null,
          };
        });
        const total = items.reduce((a, r) => a + asBigInt(r.outstanding.minor), 0n);
        return ok(reply, { items, totals: { outstanding: wire(total), count: items.length } }, { maxAge: 30 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/loans',
      config: { perms: ['loan:write'] as Permission[], screen: 'LOAN-03', summary: 'Tạo/sửa khoản vay' },
      schema: { tags: ['loans'], body: loanUpsertBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(loanUpsertBody, req.body);
        if (body.disbursed_at > body.maturity_date) {
          throw new ApiError({ code: 'FG-VAL-001', errors: { maturity_date: 'Ngày đáo hạn phải sau ngày giải ngân' } });
        }
        const companyId = body.company_id ?? actor.company_id;
        if (!companyId) throw new ApiError({ code: 'FG-RBAC-002' });
        assertCompanyScope(req, companyId);
        const dup = await Models.Loan.findOne({ company_id: companyId, contract_code: body.contract_code }).lean();
        if (dup) throw new ApiError({ code: 'FG-VAL-001', errors: { contract_code: 'Hợp đồng tín dụng này đã có' } });
        const created = await Models.Loan.create({
          company_id: companyId,
          bank_name: body.bank_name,
          contract_code: body.contract_code,
          limit_minor: BigInt(body.limit.amount_minor),
          outstanding_minor: BigInt(body.outstanding.amount_minor),
          currency: body.currency,
          disbursed_at: body.disbursed_at,
          maturity_date: body.maturity_date,
          next_due_date: body.next_due_date ?? body.maturity_date,
          interest_rate: body.interest_rate,
          interest_period: body.interest_period,
          principal_period: body.principal_period,
          collateral: body.collateral ?? null,
          manager_user_id: body.manager_user_id ?? null,
          status: body.status,
          note: body.note ?? null,
        } as never);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'loan.create',
          subject: { type: 'loan', id: String(created._id), code: body.contract_code },
          company_id: companyId,
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { _id: String(created._id) } }, { status: 201 });
      },
    }),
  );

  /** LOAN-04 — lịch nghĩa vụ trả nợ (gốc + lãi + phí). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/loans/obligations',
      config: { perms: ['loan:read'] as Permission[], screen: 'LOAN-04', summary: 'Lịch trả gốc + lãi' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const loans = await scopedFind<Record<string, unknown>>(Models.Loan, scope, { status: { $in: ['active', 'overdue'] } }, { limit: 300 });
        const companies = await Models.Company.find({}).select({ name: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
        const day = today();
        const items: Record<string, unknown>[] = [];
        for (const l of loans) {
          const obligations = (l.obligations as { due_date?: string; kind?: string; amount_minor?: unknown; paid_minor?: unknown }[] | undefined) ?? [];
          const generated = obligations.length
            ? obligations
            : [{ due_date: String(l.next_due_date ?? l.maturity_date ?? day), kind: 'principal', amount_minor: l.outstanding_minor, paid_minor: 0n }];
          for (const o of generated) {
            const amount = asBigInt(o.amount_minor);
            const paid = asBigInt(o.paid_minor ?? 0n);
            const dueDate = String(o.due_date ?? day);
            items.push({
              loan_id: String(l._id),
              contract_code: String(l.contract_code),
              bank_name: String(l.bank_name),
              company_name: cmap.get(String(l.company_id)) ?? '',
              due_date: dueDate,
              kind: o.kind ?? 'principal',
              amount: wire(amount, String(l.currency ?? 'VND')),
              paid: wire(paid, String(l.currency ?? 'VND')),
              remaining: wire(amount - paid, String(l.currency ?? 'VND')),
              status: dueDate < day ? 'overdue' : paid >= amount && amount > 0n ? 'paid' : dueDate <= addDays(day, 30) ? 'due' : 'upcoming',
            });
          }
        }
        items.sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
        return ok(reply, { items }, { maxAge: 30 });
      },
    }),
  );

  /* ------------------------------ RENEW ------------------------------ */

  /** RENEW-01 — bảng đảo hạn + KPI 4 ngưỡng. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/rollovers',
      config: { perms: ['loan:read'] as Permission[], screen: 'RENEW-01', summary: 'Bảng đáo hạn 4 mức' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(rolloverListQuery, req.query);
        const rows = await maturityLadder(scope, { bucket: q.bucket, bankName: q.bank_name });
        const all = await maturityLadder(scope, {});
        const sum = (list: typeof all) => list.reduce((a, r) => a + asBigInt(r.outstanding.minor), 0n);
        return ok(
          reply,
          {
            items: rows,
            kpi: {
              today: wire(sum(all.filter((r) => r.days_to_due <= 0))),
              d3: wire(sum(all.filter((r) => r.days_to_due <= 3))),
              d7: wire(sum(all.filter((r) => r.days_to_due <= 7))),
              d30: wire(sum(all.filter((r) => r.days_to_due <= 30))),
            },
            prepared_percent: all.length ? Math.round((all.filter((r) => r.rollover?.prepared).length / all.length) * 100) : 100,
          },
          { maxAge: 30 },
        );
      },
    }),
  );

  /* ------------------------------- DEBT ------------------------------- */

  app.route(
    defineRoute({
      method: 'GET',
      url: '/debts',
      config: { perms: ['debt:read'] as Permission[], screen: 'DEBT-01', summary: 'Công nợ phải thu / phải trả' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(debtListQuery, req.query);
        const filter: Record<string, unknown> = {};
        if (q.kind) filter.kind = q.kind;
        if (q.company_id) filter.company_id = q.company_id;
        if (q.counterparty) filter.counterparty_name = { $regex: q.counterparty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
        if (q.overdue_only === 'true') {
          filter.due_date = { $lt: today() };
          filter.status = { $ne: 'settled' };
        }
        const rows = await scopedFind<Record<string, unknown>>(Models.DebtItem, scope, filter, {
          sort: q.sort === 'value' ? { value_minor: -1 } : { due_date: 1 },
          limit: q.limit,
        });
        const companies = await Models.Company.find({}).select({ name: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
        const day = today();
        const items = rows.map((d) => {
          const value = asBigInt(d.value_minor);
          const settled = asBigInt(d.settled_minor);
          const due = String(d.due_date);
          const overdueDays = due < day ? -daysUntil(due) : 0;
          return {
            _id: String(d._id),
            kind: String(d.kind),
            company_id: String(d.company_id),
            company_name: cmap.get(String(d.company_id)) ?? '',
            counterparty_name: String(d.counterparty_name),
            contract_code: (d.contract_code as string | null) ?? null,
            value: wire(value),
            settled: wire(settled),
            remaining: wire(value - settled),
            due_date: due,
            days_overdue: overdueDays,
            aging_bucket: bucketOf(overdueDays),
            priority: String(d.priority ?? 'normal'),
            progress_percent: value > 0n ? Number((settled * 10000n) / value) / 100 : 0,
            open_document_id: Array.isArray(d.document_ids) && d.document_ids.length ? String(d.document_ids.at(-1)) : null,
            updated_at: d.updated_at ? new Date(String(d.updated_at)).toISOString() : null,
          };
        });
        return ok(reply, { items, total: items.length }, { maxAge: 30 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/debts',
      config: { perms: ['debt:write'] as Permission[], screen: 'DEBT-01', summary: 'Nhập khoản công nợ' },
      schema: { tags: ['debt'], body: debtUpsertBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(debtUpsertBody, req.body);
        const companyId = body.company_id ?? actor.company_id;
        if (!companyId) throw new ApiError({ code: 'FG-RBAC-002' });
        assertCompanyScope(req, companyId);
        const created = await Models.DebtItem.create({
          kind: body.kind,
          company_id: companyId,
          counterparty_name: body.counterparty_name,
          counterparty_tax_code: body.counterparty_tax_code ?? null,
          contract_code: body.contract_code ?? null,
          value_minor: BigInt(body.contract_value.amount_minor),
          settled_minor: body.received_or_paid ? BigInt(body.received_or_paid.amount_minor) : 0n,
          due_date: body.due_date,
          priority: body.priority,
          status: body.received_or_paid && BigInt(body.received_or_paid.amount_minor) >= BigInt(body.contract_value.amount_minor) ? 'settled' : 'open',
          note: body.note ?? null,
        } as never);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'debt.create',
          subject: { type: 'debt', id: String(created._id), code: body.counterparty_name },
          company_id: companyId,
          ip: requestCtx(req).ip,
        });
        return ok(reply, { data: { _id: String(created._id) } }, { status: 201 });
      },
    }),
  );

  /** DEBT-05 — ma trận tuổi nợ. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/debts/aging',
      config: { perms: ['debt:read'] as Permission[], screen: 'DEBT-05', summary: 'Đối chiếu công nợ / tuổi nợ' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const kind = (req.query as { kind?: string }).kind === 'payable' ? 'payable' : 'receivable';
        const rows = await scopedFind<Record<string, unknown>>(Models.DebtItem, scope, { kind, status: { $ne: 'settled' } }, { limit: 1000 });
        const day = today();
        const buckets = ['none', 'lt30', 'd30_60', 'd60_90', 'gt90'] as const;
        const byParty = new Map<string, { company: string; cells: Record<string, { amount: bigint; count: number }> }>();
        for (const d of rows) {
          const overdue = d.due_date && String(d.due_date) < day ? -daysUntil(String(d.due_date)) : 0;
          const b = bucketOf(overdue);
          const key = `${String(d.company_id)}|${String(d.counterparty_name)}`;
          const cur = byParty.get(key) ?? { company: String(d.company_id), cells: Object.fromEntries(buckets.map((x) => [x, { amount: 0n, count: 0 }])) };
          const remaining = asBigInt(d.value_minor) - asBigInt(d.settled_minor);
          const cell = cur.cells[b] ?? { amount: 0n, count: 0 };
          cur.cells[b] = { amount: cell.amount + remaining, count: cell.count + 1 };
          byParty.set(key, cur);
        }
        const companies = await Models.Company.find({}).select({ name: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), String(c.name)]));
        const totals = Object.fromEntries(buckets.map((b) => [b, [...byParty.values()].reduce((a, p) => a + (p.cells[b]?.amount ?? 0n), 0n)])) as Record<string, bigint>;
        return ok(
          reply,
          {
            data: {
              kind,
              columns: buckets.map((b) => ({ bucket: b, label: bucketLabel(b) })),
              rows: [...byParty.entries()].map(([key, p]) => ({
                counterparty: key.split('|')[1] ?? '',
                company_name: cmap.get(p.company) ?? '',
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

  /* -------------------------- INTERNAL TRANSFER -------------------------- */

  /** BANK-08 — ghi nhận đồng thời A: tiền ra / B: tiền vào, không tính doanh thu/chi phí (§XXI). */
  app.route(
    defineRoute({
      method: 'POST',
      url: '/internal-transfers',
      config: { perms: ['bank:transfer'] as Permission[], screen: 'BANK-08', summary: 'Chuyển tiền giữa công ty' },
      schema: { tags: ['bank'], body: internalTransferBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(internalTransferBody, req.body);
        if (body.from_company_id === body.to_company_id) {
          throw new ApiError({ code: 'FG-VAL-001', errors: { to_company_id: 'Công ty nguồn và nhận phải khác nhau' } });
        }
        const [fromAcct, toAcct] = await Promise.all([
          Models.BankAccount.findById(body.from_account_id).lean(),
          body.to_account_id ? Models.BankAccount.findById(body.to_account_id).lean() : Promise.resolve(null),
        ]);
        if (!fromAcct || !toAcct) throw new ApiError({ code: 'FG-VAL-001', errors: { to_account_id: 'Không tìm thấy tài khoản nhận' } });
        if (String(fromAcct.company_id) !== body.from_company_id) {
          throw new ApiError({ code: 'FG-RBAC-002', detail: 'Tài khoản nguồn không thuộc công ty nguồn' });
        }
        if (String(toAcct.company_id) !== body.to_company_id) {
          throw new ApiError({ code: 'FG-RBAC-002', detail: 'Tài khoản nhận không thuộc công ty nhận' });
        }
        // Cả công ty nguồn và nhận phải nằm trong phạm vi hiện tại (chuyển nội bộ là thao tác cấp tập đoàn).
        assertCompanyScope(req, body.from_company_id);
        assertCompanyScope(req, body.to_company_id);

        const minor = BigInt(body.amount.amount_minor);
        const code = await nextDocumentCode('internal');
        const history = buildHistoryEntry({
          action: 'create',
          actor: { user_id: actor.user_id, role: actor.role, name: actor.name },
          to: 'draft',
          ip: requestCtx(req).ip,
          fields: { from_company: body.from_company_id, to_company: body.to_company_id, amount_minor: minor.toString() },
        });
        const created = await Models.Document.create({
          code,
          kind: 'internal',
          company_id: body.from_company_id,
          created_by: actor.user_id,
          status: 'draft',
          version: 1,
          title: `Chuyển nội bộ → ${toAcct.bank_name}`,
          purpose: body.purpose,
          payee: { name: 'Nội bộ tập đoàn', is_internal: true },
          amount: { minor, currency: body.amount.currency, decimals: 0 },
          source: { fund: 'bank', account_id: body.from_account_id },
          target: { company_id: body.to_company_id, account_id: body.to_account_id },
          planned_date: normalizePlannedDate(body.planned_date),
          business_date: today(),
          history: [history],
          evidence: { required: ['bank_order'], present: [], missing: ['bank_order'] },
        } as never);

        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'internal_transfer.create',
          subject: { type: 'internal', id: String(created._id), code: String((created as unknown as { code: string }).code) },
          company_id: body.from_company_id,
          document_id: String(created._id),
          ip: requestCtx(req).ip,
        });
        invalidateFor(body.from_company_id, actor.user_id);
        return ok(reply, { data: { document_id: String(created._id), code, note: 'Không tính vào chi phí/doanh thu' } }, { status: 201 });
      },
    }),
  );

  /** RENEW-05 — "tiền cần chuẩn bị cho 30 ngày tới": đáo hạn + chi định kỳ vs số dư. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/rollovers/preparation',
      config: { perms: ['loan:read'] as Permission[], screen: 'RENEW-05', summary: 'Tiền cần chuẩn bị 30 ngày tới' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const [accounts, mat, spend] = await Promise.all([
          accountSnapshots(scope),
          maturityLadder(scope, { horizonDays: 30 }),
          scopedFind<Record<string, unknown>>(
            Models.Document,
            scope,
            { kind: 'spend', planned_date: { $gte: dayStartOf(today()), $lte: dayEndOf(addDays(today(), 30)) }, status: { $ne: 'draft' } },
            { limit: 500 },
          ),
        ]);
        const available = accounts.reduce((a, r) => a + r.available, 0n);
        const maturityTotal = mat.reduce((a, m) => a + asBigInt(m.outstanding.minor), 0n);
        const spendTotal = spend.reduce((a, d) => a + asBigInt((d.amount as { minor?: unknown } | undefined)?.minor ?? 0n), 0n);
        const need = maturityTotal + spendTotal;
        return ok(
          reply,
          {
            data: {
              horizon_days: 30,
              available: wire(available),
              need: wire(need),
              maturity: wire(maturityTotal),
              planned_spend: wire(spendTotal),
              gap: wire(available - need),
              breach: available - need < 0n,
              rows: mat.map((m) => ({ date: m.maturity_date, label: `${m.bank_name} ${m.contract_code}`, amount: m.outstanding, tone: m.tone })),
            },
          },
          { maxAge: 30 },
        );
      },
    }),
  );
}

function bucketOf(overdueDays: number): 'none' | 'lt30' | 'd30_60' | 'd60_90' | 'gt90' {
  if (overdueDays <= 0) return 'none';
  if (overdueDays < 30) return 'lt30';
  if (overdueDays <= 60) return 'd30_60';
  if (overdueDays <= 90) return 'd60_90';
  return 'gt90';
}

function bucketLabel(b: string): string {
  return { none: 'Chưa đến hạn', lt30: 'Quá hạn < 30 ngày', d30_60: '30–60 ngày', d60_90: '60–90 ngày', gt90: '> 90 ngày' }[b] ?? b;
}

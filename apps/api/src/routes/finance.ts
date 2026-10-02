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
  normalizePlannedDate,
  today,
  type Permission,
} from '@fingate/shared';
import { Models } from '../db/models.ts';
import { assertCompanyScope, defineRoute, requestCtx, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import {
  bankAccountUpdateBody,
  bankAccountUpsertBody,
  internalTransferBody,
  rolloverListQuery,
  statementImportBody,
} from '@fingate/shared';
import { bankAccountUpdateBodySchema, bankAccountUpsertBodySchema, internalTransferBodySchema, statementImportBodySchema } from './schemas.ts';
import { accountSnapshots, asBigInt, docHref, maskAccount, maturityLadder, wire} from '../domain/queries/index.ts';
import { scopedFind } from '../lib/mongo.ts';
import { mirrorAudit, buildHistoryEntry } from '../domain/audit/index.ts';
import { nextDocumentCode } from '../domain/numbering/index.ts';
import { invalidateFor } from '../domain/side-effects.ts';

/** Chi tiết tài khoản tiền cho form sửa (BANK-02) — trả số TK đầy đủ (đã kiểm quyền ở route). */
async function bankAccountDetail(id: string): Promise<Record<string, unknown>> {
  const acct = await Models.BankAccount.findById(id).lean<Record<string, unknown> | null>();
  if (!acct) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy tài khoản tiền' });
  const company = acct.company_id ? await Models.Company.findById(acct.company_id).select({ name: 1 }).lean() : null;
  return {
    _id: String(acct._id),
    company_id: acct.company_id ? String(acct.company_id) : null,
    company_name: company ? String((company as { name?: unknown }).name ?? '') : null,
    is_group: Boolean(acct.is_group),
    bank_name: String(acct.bank_name ?? ''),
    account_name: String(acct.account_name ?? ''),
    account_number: String(acct.account_number ?? ''),
    branch: acct.branch ? String(acct.branch) : null,
    kind: String(acct.kind ?? 'bank'),
    currency: String(acct.currency ?? 'VND'),
    manager_user_id: acct.manager_user_id ? String(acct.manager_user_id) : null,
    limit_minor: acct.limit_minor == null ? null : String(acct.limit_minor),
    min_balance_minor: String(acct.min_balance_minor ?? '0'),
    show_on_dashboard: acct.show_on_dashboard !== false,
    status: String(acct.status ?? 'active'),
    note: acct.note ? String(acct.note) : null,
    updated_at: acct.updated_at ? new Date(acct.updated_at as string | Date).toISOString() : null,
  };
}

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
              company_code: r.company_code,
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
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ cấp Tập đoàn (P.TGĐ/TGĐ) cấu hình tài khoản Tập đoàn (§VIII)' });
        }
        // Tài khoản Tập đoàn chỉ tạo từ tầm nhìn toàn tập đoàn (P.TGĐ/TGĐ/admin).
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

  /** BANK-02 — chi tiết tài khoản tiền để sửa (trả số TK đầy đủ; đã kiểm phạm vi). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-accounts/:id',
      config: { perms: ['bank:read'] as Permission[], screen: 'BANK-02', summary: 'Chi tiết tài khoản tiền (form sửa)' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const acct = await Models.BankAccount.findById(id).select({ is_group: 1, company_id: 1 }).lean();
        if (!acct) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy tài khoản tiền' });
        // Tài khoản Tập đoàn thấy được ở mọi phạm vi (như danh sách); tài khoản công ty phải trong phạm vi.
        if (!acct.is_group) assertCompanyScope(req, acct.company_id ? String(acct.company_id) : null);
        return ok(reply, { data: await bankAccountDetail(id) });
      },
    }),
  );

  /**
   * BANK-02 — sửa tài khoản tiền. KHÔNG đổi công ty / cờ Tập đoàn (tránh di chuyển
   * tài khoản giữa các công ty). Khoá tài khoản (status ≠ active) vẫn kiểm tra hồ sơ
   * đang tham chiếu như route `/status`.
   */
  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/bank-accounts/:id',
      config: { perms: ['bank:write'] as Permission[], screen: 'BANK-02', summary: 'Sửa tài khoản tiền' },
      schema: { tags: ['bank'], body: bankAccountUpdateBodySchema },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(bankAccountUpdateBody, req.body);
        const acct = await Models.BankAccount.findById(id).lean<Record<string, unknown> | null>();
        if (!acct) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy tài khoản tiền' });
        if (acct.is_group && !actor.permissions.includes('admin:group_accounts')) {
          throw new ApiError({ code: 'FG-RBAC-001', detail: 'Chỉ cấp Tập đoàn (P.TGĐ/TGĐ) cấu hình tài khoản Tập đoàn (§VIII)' });
        }
        if (!acct.is_group) assertCompanyScope(req, acct.company_id ? String(acct.company_id) : null);
        const companyId = acct.company_id ? String(acct.company_id) : null;

        if (body.account_number !== undefined && body.account_number !== String(acct.account_number ?? '')) {
          const dup = await Models.BankAccount.findOne({ account_number: body.account_number, company_id: acct.company_id ?? null, _id: { $ne: id } }).lean();
          if (dup) throw new ApiError({ code: 'FG-VAL-001', errors: { account_number: 'Số tài khoản này đã tồn tại trong công ty' } });
        }

        if (body.status !== undefined && body.status !== 'active' && String(acct.status) === 'active') {
          const referencing = await Models.Document.countDocuments({
            status: { $in: ['draft', 'pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman', 'approved', 'processing'] },
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

        const set: Record<string, unknown> = { updated_at: new Date() };
        const changed: string[] = [];
        const assign = (key: string, value: unknown) => {
          set[key] = value;
          changed.push(key);
        };
        if (body.bank_name !== undefined) assign('bank_name', body.bank_name);
        if (body.account_name !== undefined) assign('account_name', body.account_name);
        if (body.account_number !== undefined) assign('account_number', body.account_number);
        if (body.branch !== undefined) assign('branch', body.branch || null);
        if (body.currency !== undefined) assign('currency', body.currency);
        if (body.kind !== undefined) assign('kind', body.kind);
        if (body.manager_user_id !== undefined) assign('manager_user_id', body.manager_user_id ?? null);
        if (body.limit_minor !== undefined) assign('limit_minor', body.limit_minor ? BigInt(body.limit_minor) : null);
        if (body.min_balance_minor !== undefined) assign('min_balance_minor', BigInt(body.min_balance_minor));
        if (body.show_on_dashboard !== undefined) assign('show_on_dashboard', body.show_on_dashboard);
        if (body.status !== undefined) assign('status', body.status);
        if (body.note !== undefined) assign('note', body.note || null);

        await Models.BankAccount.updateOne({ _id: id }, { $set: set }).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'bank_account.update',
          subject: { type: 'bank_account', id, code: maskAccount(String(body.account_number ?? acct.account_number ?? '')) },
          company_id: companyId,
          diff_fields: { changed },
          ip: requestCtx(req).ip,
        });
        invalidateFor(companyId);
        return ok(reply, { data: await bankAccountDetail(id) });
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
            status: { $in: ['draft', 'pending.ktt', 'pending.pgd', 'pending.gd', 'pending.ptg', 'pending.chairman', 'approved', 'processing'] },
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

  /**
   * CHI-02 — "Đơn vị nhận tiền": danh sách MỌI tài khoản tiền toàn tập đoàn dưới dạng
   * `Mã công ty - Tên ngân hàng hoặc tên quỹ - Số tài khoản hoặc mã quỹ` (phân tách ` - `).
   * Server là nguồn chuẩn để FE prefill + để parser khi thực thi đối chiếu.
   */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-accounts/payee-options',
      config: { perms: ['doc:read'] as Permission[], screen: 'CHI-02', summary: 'Tài khoản tiền toàn tập đoàn (gợi ý Đơn vị nhận tiền)' },
      handler: async (_req, reply) => {
        const accounts = await Models.BankAccount.find({ status: 'active' } as never)
          .select({ company_id: 1, is_group: 1, bank_name: 1, account_number: 1, account_name: 1, kind: 1 })
          .lean();
        const companies = await Models.Company.find({}).select({ code: 1, is_group: 1 }).lean();
        const cmap = new Map(companies.map((c) => [String(c._id), String(c.code ?? '')]));
        const groupCode = String(companies.find((c) => c.is_group)?.code ?? 'GROUP');
        const items = accounts
          .map((a) => {
            const code = a.is_group ? groupCode : (cmap.get(String(a.company_id ?? '')) ?? '');
            if (!code) return null;
            const bankName = String(a.bank_name ?? '');
            const number = String(a.account_number ?? '');
            if (!bankName || !number) return null;
            return {
              _id: String(a._id),
              value: `${code} - ${bankName} - ${number}`,
              label: `${code} - ${bankName} - ${number}`,
              company_id: a.company_id ? String(a.company_id) : null,
              company_code: code,
              is_group: Boolean(a.is_group),
              kind: String(a.kind ?? 'bank'),
              bank_name: bankName,
              account_number: number,
            };
          })
          .filter((x): x is NonNullable<typeof x> => Boolean(x));
        return ok(reply, { items }, { maxAge: 60 });
      },
    }),
  );

  /** BANK-05 — lịch sử giao dịch (sổ cái) của MỘT tài khoản, kèm số dư đầu/cuối từng dòng. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/bank-accounts/:id/transactions',
      config: { perms: ['bank:read'] as Permission[], screen: 'BANK-05', summary: 'Lịch sử giao dịch của tài khoản' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const account = await Models.BankAccount.findById(id)
          .select({ company_id: 1, is_group: 1, bank_name: 1, account_number: 1, account_name: 1, kind: 1, currency: 1 })
          .lean<Record<string, unknown> | null>();
        if (!account) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy tài khoản tiền' });
        const isGroup = Boolean(account.is_group);
        if (!isGroup) assertCompanyScope(req, account.company_id ? String(account.company_id) : null);

        const limitRaw = Number((req.query as { limit?: string }).limit ?? 500);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 2000) : 500;
        const entries = await Models.CashEntry.find({ account_id: id } as never)
          .sort({ date: 1, created_at: 1 })
          .limit(limit)
          .lean<Record<string, unknown>[]>();

        // số dư đầu/cuối chạy dồn theo thời gian (in = +, out = −)
        let running = 0n;
        const withBalance = entries.map((e) => {
          const amount = asBigInt(e.amount_minor);
          const direction = String(e.direction ?? 'in');
          const opening = running;
          running = direction === 'in' ? running + amount : running - amount;
          return { entry: e, direction, amount, opening, closing: running };
        });

        const docIds = [...new Set(entries.map((e) => (e.document_id ? String(e.document_id) : '')).filter(Boolean))];
        const docs = docIds.length
          ? await Models.Document.find({ _id: { $in: docIds } } as never)
              .select({ code: 1, kind: 1, title: 1, purpose: 1, payee: 1, execution: 1 })
              .lean<Record<string, unknown>[]>()
          : [];
        const dmap = new Map(docs.map((d) => [String(d._id), d]));
        const company = account.company_id ? await Models.Company.findById(account.company_id).select({ name: 1 }).lean<{ name?: string } | null>() : null;

        const money = (v: bigint): { minor: string; currency: string; decimals: number } => ({
          minor: v.toString(),
          currency: String(account.currency ?? 'VND'),
          decimals: 0,
        });

        const items = withBalance
          .reverse() // mới nhất lên trước
          .map(({ entry, direction, amount, opening, closing }) => {
            const doc = entry.document_id ? dmap.get(String(entry.document_id)) : undefined;
            const exec = (doc?.execution ?? null) as { paid_at?: string | null } | null;
            const createdAt = entry.created_at ? new Date(String(entry.created_at)).toISOString() : null;
            // ưu tiên mốc thực thi (nếu có giờ), còn lại dùng created_at (đủ giây).
            const at = exec?.paid_at && exec.paid_at.length > 10 ? exec.paid_at : createdAt;
            const payee = (doc?.payee ?? null) as { name?: string } | null;
            const kind = doc?.kind ? String(doc.kind) : '';
            const counterparty = payee?.name ? String(payee.name) : direction === 'in' ? '—' : '—';
            return {
              _id: String(entry._id),
              at,
              date: String(entry.date ?? ''),
              direction,
              kind,
              direction_label: direction === 'in' ? 'Thu' : 'Chi',
              direction_tone: direction === 'in' ? 'success' : 'attention',
              opening: money(opening),
              amount: money(amount),
              closing: money(closing),
              currency: String(account.currency ?? 'VND'),
              content: doc ? String(doc.purpose ?? doc.title ?? '') : '',
              counterparty,
              reason: String(entry.reason ?? 'paid'),
              document: doc
                ? {
                    id: String(doc._id),
                    code: String(doc.code ?? ''),
                    kind,
                    href: docHref(kind, String(doc._id)),
                  }
                : null,
            };
          });

        return ok(
          reply,
          {
            data: {
              account: {
                _id: String(account._id),
                company_id: account.company_id ? String(account.company_id) : null,
                company_name: company?.name ? String(company.name) : isGroup ? 'Tập đoàn' : null,
                is_group: isGroup,
                label: `${String(account.bank_name ?? '')} ${String(account.account_number ?? '')}`.trim(),
                bank_name: String(account.bank_name ?? ''),
                account_number: String(account.account_number ?? ''),
                account_name: String(account.account_name ?? ''),
                kind: String(account.kind ?? 'bank'),
                currency: String(account.currency ?? 'VND'),
              },
              items,
            },
          },
          { maxAge: 15 },
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
        const maturityTotal = mat.reduce((a, m) => a + asBigInt(m.need_prepare.minor), 0n);
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
              rows: mat.map((m) => ({ date: m.maturity_date, label: `${m.bank_name} ${m.contract_code}`, amount: m.need_prepare, principal: m.outstanding, interest: m.interest_to_due, tone: m.tone })),
            },
          },
          { maxAge: 30 },
        );
      },
    }    ),
  );
}

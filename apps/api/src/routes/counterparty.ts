/**
 * Danh bạ Đối tác / Khách hàng (dùng chung toàn tập đoàn).
 *
 * CRUD đơn giản: đối tác có nhiều tài khoản ngân hàng (doc con trong `banks[]`).
 * Quyền: `partner:read` (xem) · `partner:write` (tạo/sửa/xoá) — mặc định kế toán
 * và kế toán trưởng có.
 */

import type { FastifyInstance } from 'fastify';
import { ApiError, counterpartyListQuery, counterpartyUpsertBody, type Permission } from '@fingate/shared';
import { Models } from '../db/models.ts';
import { defineRoute, requireActor, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { mirrorAudit } from '../domain/audit/index.ts';
import { formatCounterpartyLabel, normalizeCounterpartyName } from '../domain/counterparty/index.ts';

interface BankLean {
  _id?: unknown;
  bank_name?: string;
  account_number?: string;
  branch?: string | null;
  account_name?: string | null;
}

interface CounterpartyLean {
  _id: unknown;
  name?: string;
  banks?: BankLean[];
  note?: string | null;
  updated_at?: Date | string;
}

function serialize(cp: CounterpartyLean): Record<string, unknown> {
  return {
    _id: String(cp._id),
    name: String(cp.name ?? ''),
    banks: (cp.banks ?? []).map((b, i) => ({
      _id: String(b._id ?? `${String(cp._id)}-${i}`),
      bank_name: String(b.bank_name ?? ''),
      account_number: String(b.account_number ?? ''),
      branch: b.branch ?? null,
      account_name: b.account_name ?? null,
    })),
    note: cp.note ?? null,
    updated_at: cp.updated_at ? new Date(String(cp.updated_at)).toISOString() : null,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function counterpartyRoutes(app: FastifyInstance): void {
  /** Danh sách đối tác (dùng chung toàn tập đoàn). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/counterparties',
      config: { perms: ['partner:read'] as Permission[], screen: 'PARTNER-01', summary: 'Danh bạ đối tác / khách hàng' },
      handler: async (req, reply) => {
        const q = validate(counterpartyListQuery, req.query);
        const filter: Record<string, unknown> = {};
        if (q.q && q.q.trim()) {
          const rx = { $regex: escapeRegex(q.q.trim()), $options: 'i' };
          filter.$or = [{ name: rx }, { 'banks.bank_name': rx }, { 'banks.account_number': rx }];
        }
        const rows = await Models.Counterparty.find(filter as never)
          .sort({ name: 1 })
          .limit(q.limit)
          .lean<CounterpartyLean[]>();
        return ok(reply, { items: rows.map(serialize), total: rows.length }, { maxAge: 15 });
      },
    }),
  );

  /**
   * Gợi ý cho select box "Khách hàng trả tiền"/"Đơn vị nhận tiền" — mỗi tài khoản
   * ngân hàng của đối tác thành 1 entry `Tên công ty - Ngân hàng - Số tài khoản`.
   */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/counterparties/options',
      config: {
        perms: [] as Permission[],
        permsAny: ['partner:read', 'doc:read'] as Permission[],
        screen: 'CHI-02',
        summary: 'Đối tác & tài khoản ngân hàng (gợi ý select box)',
      },
      handler: async (_req, reply) => {
        const rows = await Models.Counterparty.find({}).sort({ name: 1 }).limit(2000).lean<CounterpartyLean[]>();
        const items: Record<string, unknown>[] = [];
        for (const cp of rows) {
          const id = String(cp._id);
          const name = String(cp.name ?? '');
          const banks = cp.banks ?? [];
          if (!banks.length) {
            items.push({ _id: id, counterparty_id: id, name, bank_name: '', account_number: '', value: name, label: name });
            continue;
          }
          for (const b of banks) {
            const bankName = String(b.bank_name ?? '');
            const account = String(b.account_number ?? '');
            const value = formatCounterpartyLabel(name, bankName, account);
            items.push({ _id: String(b._id ?? id), counterparty_id: id, name, bank_name: bankName, account_number: account, value, label: value });
          }
        }
        return ok(reply, { items }, { maxAge: 60 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/counterparties/:id',
      config: { perms: ['partner:read'] as Permission[], screen: 'PARTNER-01', summary: 'Chi tiết đối tác' },
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const cp = await Models.Counterparty.findById(id).lean<CounterpartyLean | null>();
        if (!cp) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy đối tác' });
        return ok(reply, { data: serialize(cp) });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/counterparties',
      config: { perms: ['partner:write'] as Permission[], screen: 'PARTNER-01', summary: 'Tạo đối tác' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const body = validate(counterpartyUpsertBody, req.body);
        const name = body.name.trim();
        if (!name) throw new ApiError({ code: 'FG-VAL-001', errors: { name: 'Thiếu tên đối tác' } });
        const nameKey = normalizeCounterpartyName(name);
        const dup = await Models.Counterparty.findOne({ name_key: nameKey }).select({ _id: 1 }).lean();
        if (dup) throw new ApiError({ code: 'FG-VAL-001', errors: { name: 'Đối tác này đã có trong danh bạ' } });
        const banks = (body.banks ?? []).map((b) => ({
          bank_name: b.bank_name.trim(),
          account_number: b.account_number.trim(),
          branch: b.branch ?? null,
          account_name: b.account_name ?? null,
        }));
        const created = await Models.Counterparty.create({
          name,
          name_key: nameKey,
          banks,
          note: body.note ?? null,
          created_by: actor.user_id,
        } as never);
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'counterparty.create',
          subject: { type: 'counterparty', id: String(created._id), code: name },
          company_id: null,
        });
        return ok(reply, { data: { _id: String(created._id), name } }, { status: 201 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/counterparties/:id',
      config: { perms: ['partner:write'] as Permission[], screen: 'PARTNER-01', summary: 'Sửa đối tác' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const body = validate(counterpartyUpsertBody.partial(), req.body);
        const cp = await Models.Counterparty.findById(id).lean<CounterpartyLean | null>();
        if (!cp) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy đối tác' });
        const set: Record<string, unknown> = { updated_at: new Date() };
        if (body.name !== undefined) {
          const name = body.name.trim();
          const nameKey = normalizeCounterpartyName(name);
          const dup = await Models.Counterparty.findOne({ name_key: nameKey, _id: { $ne: id } } as never).select({ _id: 1 }).lean();
          if (dup) throw new ApiError({ code: 'FG-VAL-001', errors: { name: 'Đối tác này đã có trong danh bạ' } });
          set.name = name;
          set.name_key = nameKey;
        }
        if (body.note !== undefined) set.note = body.note ?? null;
        if (body.banks !== undefined) {
          set.banks = body.banks.map((b) => ({
            bank_name: b.bank_name.trim(),
            account_number: b.account_number.trim(),
            branch: b.branch ?? null,
            account_name: b.account_name ?? null,
          }));
        }
        await Models.Counterparty.updateOne({ _id: id }, { $set: set }).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'counterparty.update',
          subject: { type: 'counterparty', id, code: String(cp.name ?? '') },
          company_id: null,
          diff_fields: { changed: Object.keys(set).filter((k) => k !== 'updated_at') },
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'DELETE',
      url: '/counterparties/:id',
      config: { perms: ['partner:write'] as Permission[], screen: 'PARTNER-01', summary: 'Xoá đối tác' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        const cp = await Models.Counterparty.findById(id).lean<CounterpartyLean | null>();
        if (!cp) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy đối tác' });
        await Models.Counterparty.deleteOne({ _id: id }).exec();
        await mirrorAudit({
          at: new Date(),
          actor: { user_id: actor.user_id, name: actor.name, role: actor.role },
          action: 'counterparty.delete',
          subject: { type: 'counterparty', id, code: String(cp.name ?? '') },
          company_id: null,
        });
        return ok(reply, { data: { ok: true } });
      },
    }),
  );
}

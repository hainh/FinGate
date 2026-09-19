/**
 * Nhóm route điều hành: DASH-01 · DASH-03/04 (bản tin) · CASH-01 (forecast) ·
 * RPT-00→13 (báo cáo) · NOTI-01 · SRCH-02.
 *
 * Dashboard là MỘT endpoint gộp (`Promise.all`, query có index) + `max-age=15` + ETag
 * — cơ chế chính để nền 0.1 CPU không bị đánh sập khi 20 người cùng mở (§8.3, §14).
 */

import type { FastifyInstance } from 'fastify';
import {
  ALERT_LABEL,
  ApiError,
  REPORT_LABEL,
  REPORT_PRESETS,
  today,
  type Permission,
} from '@fingate/shared';
import { Models } from '../db/models.ts';
import { defineRoute, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { dashboardQuery, forecastQuery, reportQuery, searchQuery, newsletterQuery, notificationListQuery } from '@fingate/shared';
import { accountSnapshots, asBigInt, awaitingBadge, compact, dashboardOverview, forecast, maturityLadder, wire } from '../domain/queries/index.ts';
import { buildNewsletter, cachedNewsletter, storeNewsletter } from '../domain/newsletter/index.ts';
import { reportPreset } from '../domain/reports/index.ts';
import { scopedFind } from '../lib/mongo.ts';

export function dashboardRoutes(app: FastifyInstance): void {
  /** DASH-01 — 5 tầng, exception-first. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/dashboard/overview',
      config: { perms: ['doc:read'] as Permission[], screen: 'DASH-01', summary: 'Tổng quan tài chính' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        validate(dashboardQuery, req.query);
        const data = await dashboardOverview(scope, actor.user_id, actor.role);
        return ok(reply, { data }, { maxAge: 15, etag: `ov-${actor.user_id}-${today()}`, staleWhileRevalidate: 30 });
      },
    }),
  );

  /** DASH-08 / "/hom-nay" — bản mobile rút gọn: cùng data contract. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/dashboard/today',
      config: { perms: ['doc:read'] as Permission[], screen: 'DASH-08', summary: 'Tiền hôm nay (mobile)' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const [accounts, awaiting, mat] = await Promise.all([
          accountSnapshots(scope),
          awaitingBadge(scope, actor.user_id, actor.role),
          maturityLadder(scope, { horizonDays: 30 }),
        ]);
        const total = accounts.reduce((a, x) => a + x.available, 0n);
        return ok(
          reply,
          {
            data: {
              business_date: today(),
              cash: { amount: wire(total), compact: compact(total) },
              awaiting: { count: awaiting.count, amount: wire(awaiting.total_minor), compact: compact(awaiting.total_minor) },
              alerts: mat.filter((m) => m.level >= 2).slice(0, 5),
              maturity: {
                today: wire(mat.filter((m) => m.days_to_due <= 0).reduce((a, m) => a + asBigInt(m.outstanding.minor), 0n)),
                d7: wire(mat.filter((m) => m.days_to_due <= 7).reduce((a, m) => a + asBigInt(m.outstanding.minor), 0n)),
              },
            },
          },
          { maxAge: 15 },
        );
      },
    }),
  );

  /** DASH-03 — bản tin hàng ngày; "tính khi đọc" nếu chưa có (instance ngủ — arch §9.3). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/newsletter/daily',
      config: { perms: ['report:view'] as Permission[], screen: 'DASH-03', summary: 'Bản tin tài chính hàng ngày' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(newsletterQuery, req.query);
        const date = q.date ?? today();
        const key = `newsletter:${date}:${scope.companyIds === null ? 'all' : scope.companyIds.join(',')}`;
        const cached = await cachedNewsletter(key);
        if (cached) return ok(reply, { data: cached }, { maxAge: 300, etag: key });
        const built = await buildNewsletter(scope, date);
        void storeNewsletter(key, built);
        return ok(reply, { data: built, generated_now: true }, { maxAge: 300 });
      },
    }),
  );

  /** DASH-04 — lịch sử bản tin. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/newsletter',
      config: { perms: ['report:view'] as Permission[], screen: 'DASH-04', summary: 'Lịch sử bản tin' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        // bản tin lưu theo key `newsletter:<date>:<scope>` — chỉ trả đúng phạm vi hiện tại,
        // không để công ty B đọc bản tin tổng hợp của công ty A (§7.5).
        const scopeKey = scope.companyIds === null ? 'all' : scope.companyIds.join(',');
        const rx = new RegExp(`^newsletter:[^:]*:${scopeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
        const rows = await Models.Setting.find({ key: rx })
          .sort({ key: -1 })
          .limit(60)
          .select({ key: 1, value: 1, updated_at: 1 })
          .lean();
        return ok(
          reply,
          {
            items: rows.map((r) => {
              const parts = String(r.key).split(':');
              const v = r.value as { lines?: Record<string, unknown> };
              return { date: parts[1], scope: parts[2] ?? 'all', updated_at: r.updated_at, lines: v?.lines ?? null };
            }),
          },
          { maxAge: 60 },
        );
      },
    }),
  );

  /** CASH-01 — dự báo dòng tiền 7/30/60/90. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/cashflow/forecast',
      config: { perms: ['forecast:read'] as Permission[], screen: 'CASH-01', summary: 'Cash flow forecast' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(forecastQuery, req.query);
        const data = await forecast(scope, { horizon: Number(q.horizon), from: q.from });
        return ok(reply, { data: { ...data, horizon: q.horizon }, generated_at: new Date().toISOString() }, { maxAge: 30, etag: `fc-${q.horizon}-${today()}` });
      },
    }),
  );

  /** RPT-00 — thư viện preset theo quyền. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/reports',
      config: { perms: ['report:view'] as Permission[], screen: 'RPT-00', summary: 'Danh mục báo cáo' },
      handler: async (_req, reply) => {
        return ok(
          reply,
          {
            items: REPORT_PRESETS.map((p) => ({
              preset: p,
              label: REPORT_LABEL[p],
              href: `/baocao/${p}`,
              exportable: true,
            })),
          },
          { maxAge: 300 },
        );
      },
    }),
  );

  /** RPT-01→13 — MỘT khung runner cho mọi preset. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/reports/:preset',
      config: { perms: ['report:view'] as Permission[], screen: 'RPT-01', summary: 'Báo cáo theo preset' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const scope = requireScope(req);
        const preset = (req.params as { preset: string }).preset;
        if (!(REPORT_PRESETS as readonly string[]).includes(preset)) {
          throw new ApiError({ code: 'FG-VAL-001', detail: 'Preset báo cáo không tồn tại' });
        }
        const q = validate(reportQuery, req.query);
        const data = await reportPreset(preset, {
          scope,
          from: q.from,
          to: q.to,
          groupBy: q.group_by,
          limit: q.limit,
          canExport: actor.permissions.includes('report:export'),
        });
        return ok(reply, { data }, { maxAge: 60, etag: `rpt-${preset}-${actor.user_id}-${today()}` });
      },
    }),
  );

  /** NOTI-01 — thông báo + unread-count (poll 30s, không WebSocket — K-7/ADR-07). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/notifications',
      config: { perms: [] as Permission[], screen: 'NOTI-01', summary: 'Danh sách thông báo' },
      handler: async (req, reply) => {
        const actor = requireActor(req);
        const q = validate(notificationListQuery, req.query);
        const filter: Record<string, unknown> = { user_id: actor.user_id };
        if (q.unread_only === 'true') filter.read_at = null;
        const items = await Models.Notification.find(filter).sort({ created_at: -1 }).limit(q.limit).lean();
        return ok(reply, { items }, { maxAge: 0 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'GET',
      url: '/notifications/unread-count',
      config: { perms: [] as Permission[], screen: 'NOTI-01', summary: 'Badge số chưa đọc' },
      handler: async (req) => {
        const actor = requireActor(req);
        const count = await Models.Notification.countDocuments({ user_id: actor.user_id, read_at: null }).exec();
        return { data: { count } };
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'POST',
      url: '/notifications/read',
      config: { perms: [] as Permission[], screen: 'NOTI-01', summary: 'Đánh dấu đã đọc' },
      handler: async (req) => {
        const actor = requireActor(req);
        const body = (req.body ?? {}) as { ids?: string[]; all?: boolean };
        const filter: Record<string, unknown> = { user_id: actor.user_id };
        if (!body.all && body.ids?.length) filter._id = { $in: body.ids };
        await Models.Notification.updateMany(filter as never, { $set: { read_at: new Date() } }).exec();
        return { data: { ok: true } };
      },
    }),
  );

  /** ADM-10 / alert events cho FgExceptionList đầy đủ. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/alerts',
      config: { perms: ['doc:read'] as Permission[], screen: 'ADM-10', summary: 'Danh sách cảnh báo' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const events = await scopedFind<Record<string, unknown>>(Models.Alert, scope, { type: 'event' }, {
          sort: { created_at: -1 },
          limit: 50,
        } as never).catch(() => [] as Record<string, unknown>[]);
        const rows = events.map((e) => ({
          _id: String(e._id),
          type: String(e.alert_type),
          type_label: ALERT_LABEL[String(e.alert_type) as keyof typeof ALERT_LABEL] ?? String(e.alert_type),
          severity: Number(e.severity ?? 1),
          tone: Number(e.severity ?? 1) >= 3 ? 'danger' : Number(e.severity ?? 1) === 2 ? 'warning' : 'attention',
          text: String(e.text ?? ''),
          amount: e.amount_minor !== null && e.amount_minor !== undefined ? wire(asBigInt(e.amount_minor)) : null,
          company_id: e.company_id ? String(e.company_id) : null,
          href: (e.href as string | null) ?? null,
          created_at: e.created_at ? new Date(String(e.created_at)).toISOString() : null,
          acknowledged_at: e.acknowledged_at ? new Date(String(e.acknowledged_at)).toISOString() : null,
        }));
        return ok(reply, { items: rows }, { maxAge: 30 });
      },
    }),
  );

  app.route(
    defineRoute({
      method: 'PATCH',
      url: '/alerts/:id/ack',
      config: { perms: ['alert:config'] as Permission[], screen: 'ADM-10', summary: 'Đã xử lý cảnh báo' },
      handler: async (req) => {
        const actor = requireActor(req);
        const { id } = req.params as { id: string };
        await Models.Alert.updateOne(
          { _id: id, type: 'event' },
          { $set: { acknowledged_at: new Date(), acknowledged_by: actor.user_id } },
        ).exec();
        return { data: { ok: true } };
      },
    }),
  );

  /** SRCH-02 — tìm kiếm qua index + regex (K-14: không search engine). */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/search',
      config: { perms: ['doc:read'] as Permission[], screen: 'SRCH-02', summary: 'Tìm kiếm toàn cục' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(searchQuery, req.query);
        const rx = { $regex: q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
        const [docs, loans, debts] = await Promise.all([
          scopedFind<Record<string, unknown>>(Models.Document, scope, { $or: [{ code: rx }, { title: rx }, { 'payee.name': rx }] }, { limit: q.limit, sort: { updated_at: -1 } } as never).catch(() => []),
          scopedFind<Record<string, unknown>>(Models.Loan, scope, { $or: [{ contract_code: rx }, { bank_name: rx }] }, { limit: 10 } as never).catch(() => []),
          scopedFind<Record<string, unknown>>(Models.DebtItem, scope, { counterparty_name: rx }, { limit: 10 } as never).catch(() => []),
        ]);
        const hits = [
          ...docs.map((d) => ({
            type: 'document' as const,
            id: String(d._id),
            code: String(d.code ?? ''),
            title: String(d.title ?? ''),
            subtitle: String(d.kind ?? ''),
            amount: d.amount ? wire(asBigInt((d.amount as { minor?: unknown }).minor)) : null,
            href: `/ho-so/${kindSegment(String(d.kind))}/${String(d._id)}`,
          })),
          ...loans.map((l) => ({
            type: 'loan' as const,
            id: String(l._id),
            code: String(l.contract_code ?? ''),
            title: `${l.bank_name} · ${l.contract_code}`,
            subtitle: 'Khoản vay',
            amount: wire(asBigInt(l.outstanding_minor)),
            href: `/ngan-hang/khoan-vay/${String(l._id)}`,
          })),
          ...debts.map((d) => ({
            type: 'counterparty' as const,
            id: String(d._id),
            code: null,
            title: String(d.counterparty_name ?? ''),
            subtitle: d.kind === 'receivable' ? 'Phải thu' : 'Phải trả',
            amount: wire(asBigInt(d.value_minor) - asBigInt(d.settled_minor)),
            href: d.kind === 'receivable' ? '/cong-no/phai-thu' : '/cong-no/phai-tra',
          })),
        ];
        return ok(reply, { data: { query: q.q, hits, hidden_by_permission: 0 } }, { maxAge: 0 });
      },
    }),
  );
}

function kindSegment(kind: string): string {
  return { spend: 'chi', income: 'thu', rollover: 'dao-han', internal: 'noi-bo' }[kind] ?? kind;
}

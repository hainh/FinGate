/**
 * Nhóm route điều hành: DASH-01 · DASH-03/04 (bản tin) · CASH-01 (lịch sử & dự báo dòng tiền) ·
 * RPT-00→16 (báo cáo) · NOTI-01 · SRCH-02.
 *
 * Dashboard là MỘT endpoint gộp (`Promise.all`, query có index) + `max-age=15` + ETag
 * — cơ chế chính để nền 0.1 CPU không bị đánh sập khi 20 người cùng mở (§8.3, §14).
 *
 * v2: `/dashboard/overview` lấy bản cache của `dashboardOverview` rồi GHI ĐÈ bằng số liệu sổ cái
 * và phần bổ sung (top đối tác, khoản vay chờ giải ngân, lượt tự động lỗi) — không sửa bản cache.
 * `?tag_ids=a,b` (v2 §6.2) lọc số liệu theo phiếu; nhóm "theo tag" dùng `/reports/theo-tag`.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ALERT_LABEL,
  ApiError,
  REPORT_LABEL,
  REPORT_PRESETS,
  formatMoney,
  money,
  today,
  type Permission,
} from '@fingate/shared';
import { Models } from '../db/models.ts';
import { defineRoute, requireActor, requireScope, validate } from '../lib/http.ts';
import { ok } from '../lib/serialize.ts';
import { scopedFind, scopedOne } from '../lib/mongo.ts';
import { cashflowHistoryQuery, dashboardQuery, reportQuery, searchQuery, newsletterQuery, notificationListQuery } from '@fingate/shared';
import { asBigInt, awaitingBadge, cashflowHistory, compact, dashboardOverview, docHref, maturityLadder, scopeOf, wire } from '../domain/queries/index.ts';
import { tagFilterSuffix } from '../domain/queries/dashboard-tags.ts';
import { parseIdList } from '../domain/vouchers/rules.ts';
import { buildNewsletter, cachedNewsletter, storeNewsletter } from '../domain/newsletter/index.ts';
import { reportPreset } from '../domain/reports/index.ts';
import { cashflowForecast, parseHorizon, FORECAST_HORIZONS } from '../domain/reports/cashflow.ts';
import { dashboardExtras, type DashboardExtras } from '../domain/reports/dashboard.ts';
import { loadPartnerRefs, partnerNameOf } from '../domain/reports/refs.ts';
import { ledgerAccountViews } from '../domain/accounts.ts';
import { toBig } from '../domain/links/index.ts';
import { cacheThrough } from '../lib/cache.ts';
import { LEGACY_AUTOMATION_ALERTS } from '../domain/alerts/index.ts';

/** Nhãn cảnh báo kiểu cũ (bộ máy tự động v1) — để danh sách không hiện mã thô. */
const LEGACY_ALERT_LABEL: Record<string, string> = {
  automation_failed: 'Quy trình tự động lỗi',
  automation_event_failed: 'Sự kiện tự động lỗi',
  // bản ghi R6 cũ (trước khi chuyển sang source_cancelled_with_money)
  automation_money_moved: 'Phiếu nguồn huỷ khi đối tượng sinh đã có tiền',
};

const forecastQuery = z.object({
  horizon: z.coerce.number().int().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

const compactOf = (minor: bigint): string => formatMoney(money(minor), { mode: 'compact' });

/** Ghi đè các trường v1 (tiền khả dụng, ngân hàng theo chữ) bằng số liệu sổ cái + đối tác. */
function overlayOverview(base: Record<string, unknown>, x: DashboardExtras): Record<string, unknown> {
  const kpi = (base.kpi ?? {}) as Record<string, unknown>;
  const cashPrev = (kpi.cash_total ?? {}) as Record<string, unknown>;
  const actual = toBig(x.cash.actual.minor);
  const cashTotal = {
    ...cashPrev,
    label: 'Tổng tiền hiện có (sổ cái)',
    amount: x.cash.actual,
    compact: compactOf(actual),
    breakdown: [
      { label: 'Tiền mặt', amount: x.cash.cash_on_hand, compact: compactOf(toBig(x.cash.cash_on_hand.minor)) },
      { label: 'Tiền ngân hàng', amount: x.cash.bank_money, compact: compactOf(toBig(x.cash.bank_money.minor)) },
      { label: 'Dự kiến sau 30 ngày', amount: x.cash.projected, compact: compactOf(toBig(x.cash.projected.minor)) },
    ],
  };

  // Phải thu quá hạn: MỘT con số theo HƯỚNG công nợ (v2 §9.1), thay cho mục 'receivable' đếm theo side v1.
  const baseExceptions = (Array.isArray(base.exceptions) ? base.exceptions : []) as Record<string, unknown>[];
  const kept = baseExceptions.filter((e) => !String(e.id ?? '').startsWith('breach-') && e.id !== 'receivable');
  const overdueCount = x.partners.receivable_overdue_count;
  const overdueTotal = toBig(x.partners.receivable_overdue_total.minor);
  const overdueItem =
    overdueCount > 0
      ? [
          {
            id: 'receivable',
            severity: 1,
            tone: 'info',
            glyph: '●',
            text: `${overdueCount} khoản phải thu quá hạn`,
            amount: x.partners.receivable_overdue_total,
            compact: compactOf(overdueTotal),
            href: '/cong-no?direction=receivable&overdue_only=true',
            cta: 'Đôn đốc',
          },
        ]
      : [];
  const breach = x.cash.accounts_below_min.map((a) => ({
    id: `breach-${a.account_id}`,
    severity: 3,
    tone: 'danger',
    glyph: '⛔',
    text: `${a.label} dưới ngưỡng tối thiểu`,
    amount: a.actual,
    compact: compactOf(toBig(a.actual.minor)),
    href: `/ngan-hang/taikhoan/${a.account_id}`,
    cta: 'Xem',
  }));
  const exceptions = [...kept, ...breach, ...overdueItem].sort((a, b) => Number(b.severity ?? 0) - Number(a.severity ?? 0)).slice(0, 6);

  const bank = (base.bank ?? {}) as Record<string, unknown>;
  return {
    ...base,
    kpi: { ...kpi, cash_total: cashTotal },
    counts: { ...((base.counts ?? {}) as Record<string, unknown>), overdue_receivable: overdueCount },
    bank: {
      ...bank,
      by_bank: x.bank_by_partner.map((b) => ({
        partner_id: b.partner_id,
        bank_name: b.partner_name,
        outstanding: b.outstanding,
        share_percent: b.share_percent,
      })),
    },
    receivable_overdue: x.partners.receivable_overdue_total,
    exceptions,
    partners: {
      top_receivable: x.partners.top_receivable,
      top_payable: x.partners.top_payable,
      receivable_total: x.partners.receivable_total,
      payable_total: x.partners.payable_total,
    },
    loans_pending: x.loans_pending,
    automation: x.automation,
  };
}

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
        const q = validate(dashboardQuery, req.query);
        // v2 §6.2: lọc theo tag — ID sai định dạng → FG-VAL-001 (422), không lặng lẽ trả số liệu không lọc
        const tagIds = parseIdList(q.tag_ids);
        const [base, extras] = await Promise.all([
          dashboardOverview(scope, actor.user_id, actor.role, actor.permissions.includes('payment:mark'), tagIds),
          // phần bổ sung không phụ thuộc người xem: cache 20 giây như phần cơ sở (máy 0.1 CPU, §8.3)
          cacheThrough(`dash-extras:${JSON.stringify(scope.companyIds)}:${today()}`, () => dashboardExtras(scope, today()), 20_000),
        ]);
        // không sửa `base` (bản cache của queries) — dựng object mới
        const data = overlayOverview(base, extras);
        return ok(reply, { data }, { maxAge: 15, etag: `ov-${actor.user_id}-${today()}${tagFilterSuffix(tagIds)}`, staleWhileRevalidate: 30 });
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
          ledgerAccountViews(scope),
          awaitingBadge(scope, actor.user_id, actor.role, actor.permissions.includes('payment:mark')),
          maturityLadder(scope, { horizonDays: 30 }),
        ]);
        // số dư = sổ cái (thực tế); không còn "khả dụng" (v2 BỎ phong toả)
        const total = accounts.reduce((a, x) => a + x.actual, 0n);
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

  /** CASH-01 — lịch sử dòng tiền 6 tháng / 1 năm / 2 năm, chia swimlane theo công ty / tài khoản. */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/cashflow/history',
      config: { perms: ['forecast:read'] as Permission[], screen: 'CASH-01', summary: 'Cash flow history' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(cashflowHistoryQuery, req.query);
        const data = await cashflowHistory(scope, { period: q.period, group: q.group });
        return ok(reply, { data: { ...data, generated_at: new Date().toISOString() } }, { maxAge: 30, etag: `cf-${q.period}-${q.group}-${today()}` });
      },
    }),
  );

  /**
   * CASH-02 (v2) — dự báo dòng tiền 7 / 30 / 60 / 90 ngày: đầu kỳ, thu, chi dự kiến, cuối kỳ;
   * gồm giải ngân sắp tới và lịch trả nợ vay. Dưới số dư tối thiểu → `breach` (đỏ).
   */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/cashflow/forecast',
      config: { perms: ['forecast:read'] as Permission[], screen: 'CASH-02', summary: 'Dự báo dòng tiền 7/30/60/90 ngày' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(forecastQuery, req.query);
        const horizon = parseHorizon(q.horizon ?? 30);
        const data = await cashflowForecast(scope, { horizon, from: q.from ?? today() });
        return ok(reply, { data: { ...data, horizons: FORECAST_HORIZONS } }, { maxAge: 60, etag: `fc-${horizon}-${q.from ?? today()}-${scope.companyIds?.join(',') ?? 'all'}` });
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
              needs_partner: p === 'so-chi-tiet-doi-tac',
            })),
          },
          { maxAge: 300 },
        );
      },
    }),
  );

  /** RPT-01→16 — MỘT khung runner cho mọi preset (lọc đối tác / tag). */
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
          partnerId: q.partner_id ?? null,
          tagIds: q.tag_ids ? q.tag_ids.split(',').map((s) => s.trim()).filter(Boolean) : [],
        });
        return ok(reply, { data }, { maxAge: 60, etag: `rpt-${preset}-${actor.user_id}-${today()}-${q.partner_id ?? ''}-${q.tag_ids ?? ''}` });
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
        const actor = requireActor(req);
        const scope = requireScope(req);
        // Chỉ hiện cảnh báo gửi đúng vai trò nhận (to_roles); bản ghi cũ không có to_roles thì ai có quyền xem cũng thấy.
        const forRole = { $or: [{ to_roles: { $in: [actor.role] } }, { to_roles: { $size: 0 } }] };
        const events = await scopedFind<Record<string, unknown>>(Models.Alert, scope, { type: 'event', ...forRole }, {
          sort: { created_at: -1 },
          limit: 50,
        } as never).catch(() => [] as Record<string, unknown>[]);
        const rows = events.map((e) => {
          const kind = String(e.alert_type);
          const label =
            (ALERT_LABEL as Record<string, string>)[kind] ??
            LEGACY_ALERT_LABEL[kind] ??
            (LEGACY_AUTOMATION_ALERTS.includes(kind as never) ? 'Quy trình tự động lỗi' : kind);
          return {
            _id: String(e._id),
            type: kind,
            type_label: label,
            severity: Number(e.severity ?? 1),
            tone: Number(e.severity ?? 1) >= 3 ? 'danger' : Number(e.severity ?? 1) === 2 ? 'warning' : 'attention',
            text: String(e.text ?? ''),
            amount: e.amount_minor !== null && e.amount_minor !== undefined ? wire(asBigInt(e.amount_minor)) : null,
            company_id: e.company_id ? String(e.company_id) : null,
            href: (e.href as string | null) ?? null,
            created_at: e.created_at ? new Date(String(e.created_at)).toISOString() : null,
            acknowledged_at: e.acknowledged_at ? new Date(String(e.acknowledged_at)).toISOString() : null,
          };
        });
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
        const scope = requireScope(req);
        const { id } = req.params as { id: string };
        // Chỉ xác nhận cảnh báo thuộc công ty trong phạm vi hiện tại (§7.5).
        const alert = await scopedOne<Record<string, unknown>>(Models.Alert, scopeOf(scope), { _id: id, type: 'event' });
        if (!alert) throw new ApiError({ code: 'FG-WF-001', status: 404, detail: 'Không tìm thấy cảnh báo' });
        await Models.Alert.updateOne(
          { _id: id, type: 'event' },
          { $set: { acknowledged_at: new Date(), acknowledged_by: actor.user_id } },
        ).exec();
        return { data: { ok: true } };
      },
    }),
  );

  /**
   * SRCH-02 — tìm kiếm qua index + regex (K-14: không search engine).
   * v2: khớp ĐỐI TÁC theo tên/STK/MST (qua `partner_id`), khớp TAG theo tên; không đọc text v1.
   */
  app.route(
    defineRoute({
      method: 'GET',
      url: '/search',
      config: { perms: ['doc:read'] as Permission[], screen: 'SRCH-02', summary: 'Tìm kiếm toàn cục' },
      handler: async (req, reply) => {
        const scope = requireScope(req);
        const q = validate(searchQuery, req.query);
        const esc = q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx = { $regex: esc, $options: 'i' };
        const [partners, tags] = await Promise.all([
          scopedFind<Record<string, unknown>>(Models.Partner, scope, { $or: [{ name: rx }, { code: rx }, { bank_name: rx }, { account_number: rx }, { tax_code: rx }] }, { limit: 50 } as never).catch(() => []),
          scopedFind<Record<string, unknown>>(Models.Tag, scope, { name: rx, hidden: { $ne: true } }, { limit: 50 } as never).catch(() => []),
        ]);
        const partnerIds = partners.map((p) => p._id);
        const tagIds = tags.map((t) => t._id);
        const docs: Record<string, unknown>[] = await scopedFind<Record<string, unknown>>(
          Models.Document,
          scope,
          { $or: [{ code: rx }, { title: rx }, ...(partnerIds.length ? [{ partner_id: { $in: partnerIds } }] : []), ...(tagIds.length ? [{ tag_ids: { $in: tagIds } }] : [])] },
          { limit: q.limit, sort: { updated_at: -1 } } as never,
        ).catch(() => []);
        const loans: Record<string, unknown>[] = await scopedFind<Record<string, unknown>>(
          Models.BankDebt,
          scope,
          { $or: [{ code: rx }, ...(partnerIds.length ? [{ partner_id: { $in: partnerIds } }] : [])] },
          { limit: 10 } as never,
        ).catch(() => []);
        const debts: Record<string, unknown>[] = await scopedFind<Record<string, unknown>>(
          Models.DebtVoucher,
          scope,
          { $or: [{ code: rx }, ...(partnerIds.length ? [{ partner_id: { $in: partnerIds } }] : [])] },
          { limit: 10 } as never,
        ).catch(() => []);
        const partnerNames = await loadPartnerRefs([
          ...docs.map((d) => (d.partner_id ? String(d.partner_id) : null)),
          ...loans.map((l) => (l.partner_id ? String(l.partner_id) : null)),
          ...debts.map((d) => (d.partner_id ? String(d.partner_id) : null)),
          ...partners.map((p) => String(p._id)),
        ]);
        const hits = [
          ...partners.map((p) => ({
            type: 'counterparty' as const,
            id: String(p._id),
            code: String(p.code ?? ''),
            title: String(p.name ?? ''),
            subtitle: String(p.type ?? '') === 'bank' ? 'Ngân hàng' : String(p.type ?? '') === 'customer' ? 'Khách hàng' : 'Nhà cung cấp',
            amount: null,
            href: `/doi-tac/${String(p._id)}`,
          })),
          ...docs.map((d) => ({
            type: 'document' as const,
            id: String(d._id),
            code: String(d.code ?? ''),
            title: String(d.title ?? ''),
            subtitle: partnerNameOf(partnerNames, d.partner_id ? String(d.partner_id) : null, 'Chưa gán đối tác'),
            amount: d.amount ? wire(asBigInt((d.amount as { minor?: unknown }).minor)) : null,
            href: docHref(String(d.kind), String(d._id)),
          })),
          ...loans.map((l) => ({
            type: 'loan' as const,
            id: String(l._id),
            code: String(l.code ?? ''),
            title: `${partnerNameOf(partnerNames, l.partner_id ? String(l.partner_id) : null, 'Chưa gán ngân hàng')} · ${l.code}`,
            subtitle: 'Nợ ngân hàng',
            amount: wire(asBigInt(l.principal_minor)),
            href: `/ngan-hang/khoan-vay/${String(l._id)}`,
          })),
          ...debts.map((d) => ({
            type: 'counterparty' as const,
            id: String(d._id),
            code: null,
            title: partnerNameOf(partnerNames, d.partner_id ? String(d.partner_id) : null, 'Chưa gán đối tác'),
            subtitle: debtSubtitle(d),
            amount: wire(asBigInt(d.value_minor)),
            href: `/cong-no/phieu/${String(d._id)}`,
          })),
        ].slice(0, q.limit);
        return ok(reply, { data: { query: q.q, hits, hidden_by_permission: 0 } }, { maxAge: 0 });
      },
    }),
  );
}

function debtSubtitle(d: Record<string, unknown>): string {
  return d.direction === 'receivable' || d.side === 'debit' ? 'Phải thu' : 'Phải trả';
}

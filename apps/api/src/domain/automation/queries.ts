/**
 * Đọc dữ liệu cho màn hình quy trình tự động (v2/v2.md §11.2 (3), §11.7 US-AUTO-05/07/08): danh sách quy tắc
 * với hiệu lực theo công ty, lượt chạy theo bộ lọc, lượt chạy của một đối tượng nguồn (panel trên phiếu),
 * và đối tượng đã sinh ra (mã, trạng thái) của từng bước.
 */

import { AUTOMATION_RULE_LABEL, docHref } from '@fingate/shared';
import { Models } from '../../db/models.ts';
import { getRuleHandler, getRuleParams, isRuleEnabledFor } from './engine.ts';

/** Đối tượng do một bước sinh ra, kèm mã và trạng thái hiện tại. */
export interface GeneratedObjectView {
  type: 'document' | 'bank_debt';
  id: string;
  code: string | null;
  status: string | null;
  /** phiếu: `spend` | `income` | `rollover` | `internal`; khoản vay: null. */
  kind: string | null;
  href: string | null;
}

export interface RunStepView {
  name: string;
  status: string;
  output_type: string | null;
  output_id: string | null;
  error: string | null;
  at: string | null;
  output: GeneratedObjectView | null;
}

export interface RunView {
  _id: string;
  rule_code: string;
  rule_name: string;
  company_id: string | null;
  source_type: string;
  source_id: string;
  event_type: string;
  idem_key: string;
  status: string;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
  steps: RunStepView[];
  /** đối tượng đã sinh ra (bước hoàn tất có đầu ra), không trùng lặp. */
  generated: GeneratedObjectView[];
}

export interface RuleView {
  _id: string;
  code: string;
  name: string;
  trigger_event: string;
  trigger_events: string[];
  condition: Record<string, unknown>;
  steps: string[];
  /** tham số mặc định toàn hệ thống. */
  params: Record<string, unknown>;
  /** bật toàn cục. */
  enabled: boolean;
  company_ids: string[];
  company_overrides: { company_id: string; enabled: boolean; params: Record<string, unknown> }[];
  /** hiệu lực cho công ty đang xem (null nếu không chọn công ty). */
  effective: { company_id: string; enabled: boolean; params: Record<string, unknown> } | null;
  /** bộ xử lý đã đăng ký trong tiến trình này. */
  handler_registered: boolean;
  updated_at: string;
}

interface RuleRow {
  _id: unknown;
  code: string;
  name: string;
  trigger_event: string;
  trigger_events?: string[] | null;
  condition?: Record<string, unknown> | null;
  steps?: string[] | null;
  params?: Record<string, unknown> | null;
  enabled?: boolean;
  company_ids?: unknown[] | null;
  company_overrides?: { company_id: unknown; enabled?: boolean; params?: Record<string, unknown> | null }[] | null;
  updated_at?: Date | null;
}

interface RunRow {
  _id: unknown;
  rule_code: string;
  company_id: unknown;
  source_type: string;
  source_id: unknown;
  event_type: string;
  idem_key: string;
  status: string;
  error?: string | null;
  attempts?: number;
  steps?: { name: string; status: string; output_type?: string | null; output_id?: unknown; error?: string | null; at?: Date | null }[] | null;
  created_at?: Date | null;
  updated_at?: Date | null;
}

const iso = (d: Date | null | undefined): string => (d ? new Date(d).toISOString() : '');

/** Đối tượng đã sinh ra: nạp mã / trạng thái / loại theo lô (ít truy vấn). */
async function resolveOutputs(refs: { type: string; id: string }[]): Promise<Map<string, GeneratedObjectView>> {
  const docIds = [...new Set(refs.filter((r) => r.type === 'document').map((r) => r.id))];
  const debtIds = [...new Set(refs.filter((r) => r.type === 'bank_debt').map((r) => r.id))];
  const map = new Map<string, GeneratedObjectView>();
  if (docIds.length) {
    const rows = await Models.Document.find({ _id: { $in: docIds } } as never)
      .select({ code: 1, status: 1, kind: 1 })
      .lean<{ _id: unknown; code: string; status: string; kind: string }[]>();
    for (const r of rows) {
      const id = String(r._id);
      map.set(`document:${id}`, { type: 'document', id, code: r.code, status: r.status, kind: r.kind, href: docHref(r.kind, id) });
    }
  }
  if (debtIds.length) {
    const rows = await Models.BankDebt.find({ _id: { $in: debtIds } } as never)
      .select({ code: 1, status: 1 })
      .lean<{ _id: unknown; code: string; status: string }[]>();
    for (const r of rows) {
      const id = String(r._id);
      map.set(`bank_debt:${id}`, { type: 'bank_debt', id, code: r.code, status: r.status, kind: null, href: `/ngan-hang/khoan-vay/${id}` });
    }
  }
  return map;
}

/** Lượt chạy → dạng hiển thị (có đối tượng sinh ra đã nạp). */
export async function runViews(runs: RunRow[]): Promise<RunView[]> {
  const refs: { type: string; id: string }[] = [];
  for (const run of runs) {
    for (const s of run.steps ?? []) {
      if (s.output_type && s.output_id && (s.output_type === 'document' || s.output_type === 'bank_debt')) {
        refs.push({ type: s.output_type, id: String(s.output_id) });
      }
    }
  }
  const outputs = await resolveOutputs(refs);
  const ruleNames = new Map<string, string>(Object.entries(AUTOMATION_RULE_LABEL));

  return runs.map((run) => {
    const generated = new Map<string, GeneratedObjectView>();
    const steps: RunStepView[] = (run.steps ?? []).map((s) => {
      const key = s.output_type && s.output_id ? `${s.output_type}:${String(s.output_id)}` : null;
      const output = key ? (outputs.get(key) ?? null) : null;
      if (output && s.status === 'done') generated.set(key as string, output);
      return {
        name: s.name,
        status: s.status,
        output_type: s.output_type ?? null,
        output_id: s.output_id ? String(s.output_id) : null,
        error: s.error ?? null,
        at: s.at ? iso(s.at) : null,
        output,
      };
    });
    return {
      _id: String(run._id),
      rule_code: run.rule_code,
      rule_name: ruleNames.get(run.rule_code) ?? run.rule_code,
      company_id: run.company_id ? String(run.company_id) : null,
      source_type: run.source_type,
      source_id: String(run.source_id),
      event_type: run.event_type,
      idem_key: run.idem_key,
      status: run.status,
      error: run.error ?? null,
      attempts: run.attempts ?? 0,
      created_at: iso(run.created_at),
      updated_at: iso(run.updated_at),
      steps,
      generated: [...generated.values()],
    };
  });
}

/** Danh sách lượt chạy theo bộ lọc (đã giới hạn phạm vi công ty bởi người gọi). */
export async function listRuns(filter: Record<string, unknown>, limit: number): Promise<RunView[]> {
  const rows = await Models.AutomationRun.find(filter as never)
    .sort({ created_at: -1 })
    .limit(limit)
    .lean<RunRow[]>();
  return runViews(rows);
}

/**
 * Lượt chạy của MỘT đối tượng nguồn (phiếu / khoản vay), cũ → mới. Mặc định bỏ lượt mà mọi bước đều
 * "bỏ qua" (quy tắc được kiểm tra nhưng không áp dụng cho phiếu này).
 */
export async function runsForSource(sourceType: string, sourceId: string, opts: { includeSkipped?: boolean; limit?: number } = {}): Promise<RunView[]> {
  const rows = await Models.AutomationRun.find({ source_type: sourceType, source_id: sourceId } as never)
    .sort({ created_at: 1 })
    .limit(opts.limit ?? 100)
    .lean<RunRow[]>();
  const visible = opts.includeSkipped ? rows : rows.filter((r) => (r.steps ?? []).some((s) => s.status !== 'skipped'));
  return runViews(visible);
}

/** Danh sách quy tắc. Với `companyId`: trả thêm hiệu lực (bật/tắt, tham số) của công ty đó. */
export async function listRules(companyId: string | null): Promise<RuleView[]> {
  const rows = await Models.AutomationRule.find({} as never).sort({ code: 1 }).lean<RuleRow[]>();
  return rows.map((r) => {
    const rule = {
      code: r.code,
      enabled: r.enabled,
      params: r.params ?? {},
      company_ids: r.company_ids ?? [],
      company_overrides: r.company_overrides ?? [],
      trigger_event: r.trigger_event,
      trigger_events: r.trigger_events ?? [],
    };
    return {
      _id: String(r._id),
      code: r.code,
      name: r.name,
      trigger_event: r.trigger_event,
      trigger_events: r.trigger_events ?? [],
      condition: r.condition ?? {},
      steps: r.steps ?? [],
      params: r.params ?? {},
      enabled: r.enabled !== false,
      company_ids: (r.company_ids ?? []).map(String),
      company_overrides: (r.company_overrides ?? []).map((o) => ({
        company_id: String(o.company_id),
        enabled: o.enabled !== false,
        params: o.params ?? {},
      })),
      effective: companyId
        ? { company_id: companyId, enabled: isRuleEnabledFor(rule, companyId), params: getRuleParams(rule, companyId) }
        : null,
      handler_registered: Boolean(getRuleHandler(r.code)),
      updated_at: iso(r.updated_at),
    } satisfies RuleView;
  });
}

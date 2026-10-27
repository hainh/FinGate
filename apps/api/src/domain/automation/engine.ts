/**
 * Bộ máy quy trình tự động (v2/v2.md §11.2, §14.3).
 *
 * Mô hình:
 *  - QUY TẮC (AutomationRule, DB) = trigger + điều kiện + tham số + phạm vi công ty. Bật/tắt và tham số
 *    ghi đè theo công ty ở DB. BỘ XỬ LÝ (các bước) đăng ký trong code bằng `registerRule(code, { steps })`.
 *    Quy tắc chưa có bộ xử lý trong tiến trình ⇒ bị bỏ qua (không tạo lượt chạy, sự kiện vẫn được đánh dấu xử lý).
 *  - SỰ KIỆN (DomainEvent, outbox) ⇒ `processPendingEvents()` nhận từng sự kiện bằng LEASE nguyên tử,
 *    khớp quy tắc, nhận/tạo LƯỢT CHẠY theo khoá idem `${rule}:${source}:${event}`, rồi chạy các bước chưa xong.
 *    Lượt đang chạy trong lease ⇒ sự kiện CHỜ (chưa đánh dấu xử lý), được tiếp quản khi lượt quá lease.
 *  - BƯỚC là hàm idempotent: nhận `ctx.stepKey` (= `${idem_key}#${tên bước}`). Gọi lại không sinh trùng.
 *  - LỖI ⇒ lượt chạy `failed` + cảnh báo cho KTT. `rerunRun()` chỉ chạy các bước chưa xong.
 *  - AN TOÀN KHI CHẠY SONG SONG: nhận sự kiện và nhận lượt chạy đều là findOneAndUpdate có điều kiện;
 *    `automation_runs.idem_key` là unique. Nhiều tiến trình / nhiều lần kick vẫn không xử lý trùng.
 *
 * File này KHÔNG chứa nghiệp vụ R1…R6 (các bước cụ thể do module riêng đăng ký).
 */

import { ApiError, AUTOMATION_RULE_LABEL, docHref } from '@fingate/shared';
import { Models } from '../../db/models.ts';

/* ================================================================== *
 * Kiểu
 * ================================================================== */

/** Kết quả một bước: đối tượng đã sinh/cập nhật (nếu có). `skipped: true` = bước không cần làm. */
export type StepOutput = { output_type?: string | null; output_id?: string | null; skipped?: boolean } | void;

/** Sự kiện đang xử lý, dạng đọc được cho bước và điều kiện. */
export interface AutomationEventView {
  id: string | null;
  type: string;
  company_id: string | null;
  subject_type: string;
  subject_id: string | null;
  payload: Record<string, unknown>;
  actor: { user_id: string | null; name: string | null; role: string | null };
}

/** Ngữ cảnh truyền vào MỖI bước. */
export interface StepContext {
  /** Mã quy tắc (R1…R6). */
  ruleCode: string;
  /** Tham số hiệu lực = mặc định của quy tắc + ghi đè của công ty (ghi đè thắng). */
  params: Record<string, unknown>;
  /** Công ty của lượt chạy (null nếu sự kiện không thuộc công ty). */
  companyId: string | null;
  /** `_id` của lượt chạy. */
  runId: string;
  /** Khoá idempotency của LƯỢT: `${rule}:${source}:${event}`. */
  runIdemKey: string;
  /**
   * Khoá idempotency của BƯỚC NÀY: `${runIdemKey}#${stepName}`. Mọi hàm bước (create_voucher,
   * execute_voucher, create_loan, activate_loan, link, notify, alert…) PHẢI nhận khoá này và
   * dùng để nhận biết đã làm rồi (VD tra `origin` / `business_links` theo khoá trước khi tạo).
   */
  stepKey: string;
  /** Tên bước đang chạy. */
  stepName: string;
  /** Sự kiện kích hoạt. */
  event: AutomationEventView;
  /** Kết quả các bước ĐÃ XONG trong lượt này, theo tên bước. */
  outputs: Record<string, { output_type: string | null; output_id: string | null }>;
}

export interface StepDef {
  /** Tên bước: chữ thường và `_`, duy nhất trong quy tắc (VD `create_loan`). */
  name: string;
  run: (ctx: StepContext) => Promise<StepOutput>;
}

/** Bộ xử lý của một quy tắc: danh sách bước theo thứ tự thực hiện. */
export interface RuleHandler {
  steps: StepDef[];
  /**
   * Sự kiện mà MỖI LẦN xảy ra tạo một lượt chạy riêng: khoá idem = `rule:source:event#<id sự kiện>`.
   * Dùng khi quy tắc phải phản ứng với từng lần sửa / gửi lại (VD R2 đồng bộ khoản vay mỗi lần sửa phiếu).
   * Không khai báo ⇒ khoá chuẩn `rule:source:event_type` (v2 §14.2). Lần xử lý lại CÙNG sự kiện vẫn
   * cùng khoá, nên vẫn không sinh trùng.
   */
  occurrenceEvents?: string[];
}

export type StepStatus = 'pending' | 'done' | 'failed' | 'skipped';

export interface StepRecord {
  name: string;
  status: StepStatus;
  output_type: string | null;
  output_id: string | null;
  error: string | null;
  at: Date | null;
}

/** Hình dạng quy tắc tối thiểu cho các hàm thuần (không cần Mongoose doc). */
export interface RuleLike {
  code?: string;
  enabled?: boolean;
  trigger_event?: string;
  trigger_events?: string[] | null;
  condition?: Record<string, unknown> | null;
  params?: Record<string, unknown> | null;
  company_ids?: unknown[] | null;
  company_overrides?: { company_id: unknown; enabled?: boolean; params?: Record<string, unknown> | null }[] | null;
}

export interface ProcessSummary {
  events: number;
  runs_done: number;
  runs_failed: number;
  runs_skipped: number;
  rules_without_handler: number;
  /** lượt 'running' đã quá lease (tiến trình trước dừng giữa chừng) được đánh dấu lỗi để chạy lại. */
  runs_swept: number;
  /** thao tác chuyển trạng thái thiếu sự kiện (đối chiếu outbox) — đã cảnh báo KTT. */
  outbox_gaps: number;
  errors: number;
}

/* ================================================================== *
 * Hằng số vận hành
 * ================================================================== */

/** Lease của sự kiện: quá thời gian này mà chưa xử lý xong thì tiến trình khác được nhận. */
export const EVENT_LEASE_MS = 2 * 60_000;
/** Lease của lượt chạy: quá thời gian này coi như tiến trình đã chết, lượt được nhận lại. */
export const RUN_LEASE_MS = 5 * 60_000;
/** Số lần nhận sự kiện tối đa khi lỗi ngoài dự kiến; quá thì bỏ qua và cảnh báo. */
export const MAX_EVENT_ATTEMPTS = 5;
/** Số sự kiện nhận mỗi vòng. */
const BATCH_SIZE = 100;

/* ================================================================== *
 * Registry bộ xử lý (trong tiến trình)
 * ================================================================== */

const RULE_HANDLERS = new Map<string, RuleHandler>();

/**
 * Đăng ký bộ xử lý cho một quy tắc. Gọi một lần lúc khởi động (module của quy tắc).
 * Đăng ký lại cùng mã ⇒ ghi đè (lần sau thắng). Tên bước phải duy nhất.
 */
export function registerRule(code: string, handler: RuleHandler): void {
  if (!code || !code.trim()) throw new Error('registerRule: thiếu mã quy tắc');
  const names = handler.steps.map((s) => s.name);
  if (new Set(names).size !== names.length) throw new Error(`Quy tắc ${code}: tên bước bị trùng`);
  for (const step of handler.steps) {
    if (!/^[a-z_]+$/.test(step.name)) throw new Error(`Quy tắc ${code}: tên bước "${step.name}" không hợp lệ (chỉ a-z và _)`);
    if (typeof step.run !== 'function') throw new Error(`Quy tắc ${code}: bước "${step.name}" thiếu hàm run`);
  }
  RULE_HANDLERS.set(code, { steps: [...handler.steps], occurrenceEvents: [...(handler.occurrenceEvents ?? [])] });
}

export function getRuleHandler(code: string): RuleHandler | undefined {
  return RULE_HANDLERS.get(code);
}

export function registeredRuleCodes(): string[] {
  return [...RULE_HANDLERS.keys()];
}

/** Chỉ dùng trong test. */
export function clearRuleHandlers(): void {
  RULE_HANDLERS.clear();
}

/* ================================================================== *
 * Hàm thuần: khoá, tham số, phạm vi, điều kiện, kế hoạch bước
 * ================================================================== */

/** Khoá idempotency của lượt chạy (unique trong `automation_runs.idem_key`). */
export function idemKeyFor(ruleCode: string, sourceId: string, eventType: string): string {
  return `${ruleCode}:${sourceId}:${eventType}`;
}

/** Khoá idempotency của một bước trong lượt. */
export function stepKeyFor(runIdemKey: string, stepName: string): string {
  return `${runIdemKey}#${stepName}`;
}

/**
 * Khoá lượt chạy cho một sự kiện: chuẩn `rule:source:event_type`; với các sự kiện khai trong
 * `occurrenceEvents` của bộ xử lý thì gắn thêm `#<id sự kiện>` (mỗi lần xảy ra = một lượt).
 */
export function runKeyFor(
  ruleCode: string,
  sourceId: string,
  eventType: string,
  eventId: string | null,
  handler: Pick<RuleHandler, 'occurrenceEvents'> | undefined,
): string {
  const base = idemKeyFor(ruleCode, sourceId, eventType);
  if (eventId && handler?.occurrenceEvents?.includes(eventType)) return `${base}#${eventId}`;
  return base;
}

/** Quy tắc có nghe sự kiện này không (trigger chính hoặc trigger bổ sung). */
export function ruleListensTo(rule: RuleLike, eventType: string): boolean {
  return rule.trigger_event === eventType || (rule.trigger_events ?? []).includes(eventType);
}

function overrideFor(rule: RuleLike, companyId: string | null) {
  if (!companyId) return undefined;
  return (rule.company_overrides ?? []).find((o) => String(o.company_id) === companyId);
}

/** Tham số hiệu lực cho một công ty: mặc định của quy tắc, ghi đè bằng tham số của công ty. */
export function getRuleParams(rule: RuleLike, companyId: string | null): Record<string, unknown> {
  const override = overrideFor(rule, companyId);
  return { ...(rule.params ?? {}), ...(override?.params ?? {}) };
}

/**
 * Quy tắc có áp dụng cho công ty không: bật toàn cục + phạm vi `company_ids` (rỗng = mọi công ty)
 * + ghi đè `enabled: false` của công ty.
 */
export function isRuleEnabledFor(rule: RuleLike, companyId: string | null): boolean {
  if (rule.enabled === false) return false;
  const override = overrideFor(rule, companyId);
  if (override && override.enabled === false) return false;
  const scope = (rule.company_ids ?? []).map(String);
  if (scope.length > 0 && (!companyId || !scope.includes(companyId))) return false;
  return true;
}

function readPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** So sánh lỏng: id / số / chuỗi so theo chuỗi; null và undefined coi như nhau. */
function sameValue(actual: unknown, expected: unknown): boolean {
  const aNil = actual === null || actual === undefined;
  const eNil = expected === null || expected === undefined;
  if (aNil || eNil) return aNil && eNil;
  if (typeof actual === 'object' || typeof expected === 'object') return JSON.stringify(actual) === JSON.stringify(expected);
  return String(actual) === String(expected);
}

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

function applyOperator(op: string, actual: unknown, arg: unknown): boolean {
  switch (op) {
    case '$eq':
      return sameValue(actual, arg);
    case '$ne':
      return !sameValue(actual, arg);
    case '$in':
      return Array.isArray(arg) && arg.some((v) => sameValue(actual, v));
    case '$nin':
      return Array.isArray(arg) && !arg.some((v) => sameValue(actual, v));
    case '$exists':
      return (actual !== undefined && actual !== null) === Boolean(arg);
    default:
      // toán tử lạ: không khớp (an toàn) — không làm sập bộ máy
      console.warn(`[automation] toán tử điều kiện không hỗ trợ: ${op}`);
      return false;
  }
}

/**
 * Khớp điều kiện với sự kiện. Khoá là đường dẫn trong đối tượng sự kiện
 * (`type`, `company_id`, `subject_type`, `subject_id`, `payload.*`, `actor.*`); giá trị là so sánh
 * lỏng, hoặc toán tử `$eq $ne $in $nin $exists`. Điều kiện rỗng/null = luôn khớp.
 */
export function matchCondition(condition: Record<string, unknown> | null | undefined, view: Record<string, unknown>): boolean {
  if (!condition) return true;
  for (const [path, expected] of Object.entries(condition)) {
    const actual = readPath(view, path);
    if (isOperatorObject(expected)) {
      for (const [op, arg] of Object.entries(expected)) {
        if (!applyOperator(op, actual, arg)) return false;
      }
    } else if (!sameValue(actual, expected)) {
      return false;
    }
  }
  return true;
}

/** Bản ghi bước đã có trạng thái (giữ nguyên bản ghi cũ theo tên, thiếu thì thêm `pending`). */
export function mergeStepRecords(declared: string[], existing: StepRecord[] | null | undefined): StepRecord[] {
  return declared.map(
    (name) =>
      existing?.find((r) => r.name === name) ?? {
        name,
        status: 'pending' as const,
        output_type: null,
        output_id: null,
        error: null,
        at: null,
      },
  );
}

/** Các bước còn phải chạy, theo đúng thứ tự khai báo (bỏ qua bước đã `done` hoặc `skipped`). */
export function pendingStepNames(declared: string[], records: { name: string; status: string }[]): string[] {
  const finished = new Set(records.filter((r) => r.status === 'done' || r.status === 'skipped').map((r) => r.name));
  return declared.filter((name) => !finished.has(name));
}

/** Kết quả các bước đã xong, dùng làm `ctx.outputs`. */
export function outputsOf(records: StepRecord[]): StepContext['outputs'] {
  const out: StepContext['outputs'] = {};
  for (const r of records) {
    if (r.status === 'done') out[r.name] = { output_type: r.output_type, output_id: r.output_id };
  }
  return out;
}

/**
 * Nguyên nhân cụ thể của lỗi. `ApiError` có tiêu đề chung (VD "Dữ liệu không hợp lệ") còn nguyên nhân nằm ở
 * `detail` / `errors` ⇒ ghi các nguyên nhân đó (bỏ trùng) để KTT biết cần làm gì; không có thì giữ tiêu đề.
 */
function errorCause(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  const fieldErrors: string[] = Object.values(err.errors ?? {});
  const causes = [err.detail, ...fieldErrors].filter((c): c is string => typeof c === 'string' && c.trim() !== '');
  return causes.length ? [...new Set(causes)].join('; ') : err.message;
}

function errorMessage(err: unknown): string {
  const msg = errorCause(err);
  return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
}

/* ================================================================== *
 * Ghi lượt chạy & chạy các bước
 * ================================================================== */

interface RuleRow extends RuleLike {
  _id: unknown;
  code: string;
  name: string;
  trigger_event: string;
  trigger_events?: string[] | null;
  condition?: Record<string, unknown> | null;
  params?: Record<string, unknown> | null;
  company_overrides?: { company_id: unknown; enabled?: boolean; params?: Record<string, unknown> | null }[] | null;
  company_ids?: unknown[] | null;
  enabled?: boolean;
}

interface EventRow {
  _id: unknown;
  type: string;
  company_id: unknown;
  subject_type: string;
  subject_id: unknown;
  payload?: Record<string, unknown> | null;
  actor?: { user_id?: unknown; name?: string | null; role?: string | null } | null;
  attempts?: number;
}

interface RunRow {
  _id: unknown;
  rule_id: unknown;
  rule_code: string;
  company_id: unknown;
  source_type: string;
  source_id: unknown;
  event_id: unknown;
  event_type: string;
  idem_key: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  steps: StepRecord[];
  error: string | null;
  attempts: number;
  claimed_at: Date | null;
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** Đọc sự kiện thành hình dạng cho bước / điều kiện. */
export function eventView(ev: EventRow): AutomationEventView {
  return {
    id: strOrNull(ev._id),
    type: ev.type,
    company_id: strOrNull(ev.company_id),
    subject_type: ev.subject_type,
    subject_id: strOrNull(ev.subject_id),
    payload: ev.payload ?? {},
    actor: {
      user_id: strOrNull(ev.actor?.user_id),
      name: ev.actor?.name ?? null,
      role: ev.actor?.role ?? null,
    },
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/** Nhận lượt chạy bằng lease: chỉ khi trạng thái thuộc `from` hoặc đang chạy nhưng đã quá hạn lease. */
async function claimRun(runId: unknown, from: ('pending' | 'failed')[], now: Date): Promise<RunRow | null> {
  const staleBefore = new Date(now.getTime() - RUN_LEASE_MS);
  return Models.AutomationRun.findOneAndUpdate(
    { _id: runId, $or: [{ status: { $in: from } }, { status: 'running', claimed_at: { $lt: staleBefore } }] },
    { $set: { status: 'running', claimed_at: now, updated_at: now, error: null }, $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).lean<RunRow | null>();
}

/** Lượt đang do một tiến trình giữ lease còn hiệu lực tại `now` (chưa quá `RUN_LEASE_MS` kể từ lúc nhận). */
async function isRunLeased(runId: unknown, now: Date): Promise<boolean> {
  const run = await Models.AutomationRun.findById(runId)
    .select({ status: 1, claimed_at: 1 })
    .lean<{ status: RunRow['status']; claimed_at: Date | null } | null>();
  if (!run || run.status !== 'running' || !run.claimed_at) return false;
  return new Date(run.claimed_at).getTime() > now.getTime() - RUN_LEASE_MS;
}

/** Lấy lượt chạy theo khoá idem; chưa có thì tạo (upsert). Va chạm unique ⇒ đọc lại. */
async function getOrCreateRun(
  rule: RuleRow,
  declaredSteps: string[],
  ev: EventRow,
  view: AutomationEventView,
  idemKey: string,
): Promise<RunRow> {
  const now = new Date();
  try {
    const doc = await Models.AutomationRun.findOneAndUpdate(
      { idem_key: idemKey },
      {
        $setOnInsert: {
          rule_id: rule._id,
          rule_code: rule.code,
          company_id: ev.company_id ?? null,
          source_type: view.subject_type,
          source_id: view.subject_id,
          event_id: ev._id,
          event_type: ev.type,
          status: 'pending',
          steps: mergeStepRecords(declaredSteps, []),
          error: null,
          attempts: 0,
          claimed_at: null,
          created_at: now,
          updated_at: now,
        },
      } as never,
      { upsert: true, returnDocument: 'after' },
    ).lean<RunRow | null>();
    if (!doc) throw new Error(`không tạo được lượt chạy ${idemKey}`);
    return doc;
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    const existing = await Models.AutomationRun.findOne({ idem_key: idemKey }).lean<RunRow | null>();
    if (!existing) throw err;
    return existing;
  }
}

/** Href đến hồ sơ nguồn (chỉ khi là phiếu thu/chi đã biết loại). */
function sourceHref(view: AutomationEventView): string | null {
  const kind = typeof view.payload.kind === 'string' ? view.payload.kind : null;
  if (!view.subject_id || !kind) return null;
  if (!['spend', 'income', 'rollover', 'internal'].includes(kind)) return null;
  return docHref(kind, view.subject_id);
}

/**
 * Khoá chống lặp cảnh báo lượt lỗi: theo lượt VÀ số lần thử (`attempts`). Lượt lỗi, chạy lại, lỗi tiếp
 * thì mỗi lần thử một cảnh báo mới (KTT được báo lại); cùng một lần thử không báo hai lần.
 */
export function runFailureAlertKey(runId: unknown, attempts: number | undefined): string {
  return `automation_run_failed:${String(runId)}:${attempts ?? 0}`;
}

/** Cảnh báo cho KTT khi lượt chạy lỗi (dedupe theo lượt + lần thử). */
async function raiseRunFailureAlert(run: { _id: unknown; attempts?: number }, ruleCode: string, view: AutomationEventView, error: string): Promise<void> {
  // v2: cảnh báo chuẩn `automation_run_failed` qua raiseAlert (không ghi Alert trực tiếp; lỗi thông báo không làm hỏng lượt).
  // Import động: alerts → queries → links → events → engine là chuỗi phụ thuộc, tránh vòng lặp khi nạp module.
  const { raiseAlert } = await import('../alerts/index.ts');
  await raiseAlert({
    alert_type: 'automation_run_failed',
    company_id: view.company_id,
    severity: 2,
    text: `${AUTOMATION_RULE_LABEL[ruleCode as keyof typeof AUTOMATION_RULE_LABEL] ?? ruleCode}: quy trình tự động lỗi — cần chạy lại`,
    href: sourceHref(view),
    subject: { type: view.subject_type, id: view.subject_id, run_id: String(run._id), rule_code: ruleCode, error },
    to_roles: ['chief_accountant'],
    channels: ['web'],
    dedupe_key: runFailureAlertKey(run._id, run.attempts),
  });
}

/**
 * Chạy các bước CHƯA XONG của một lượt đã nhận (lease). Bước lỗi ⇒ dừng, lượt `failed`, cảnh báo KTT.
 * Mỗi bước xong được ghi ngay vào `steps` (để lần chạy lại không làm lại bước đã xong).
 * Trả về trạng thái cuối của lượt.
 */
export async function executeRunSteps(
  run: RunRow,
  rule: RuleLike & { code: string },
  handler: RuleHandler,
  view: AutomationEventView,
): Promise<'done' | 'failed'> {
  const declared = handler.steps.map((s) => s.name);
  const records = mergeStepRecords(declared, run.steps);
  const params = getRuleParams(rule, view.company_id);
  let failure: string | null = null;

  for (const step of handler.steps) {
    const record = records.find((r) => r.name === step.name);
    if (!record || record.status === 'done' || record.status === 'skipped') continue;
    const ctx: StepContext = {
      ruleCode: rule.code,
      params,
      companyId: view.company_id,
      runId: String(run._id),
      runIdemKey: run.idem_key,
      stepKey: stepKeyFor(run.idem_key, step.name),
      stepName: step.name,
      event: view,
      outputs: outputsOf(records),
    };
    try {
      const out = (await step.run(ctx)) ?? {};
      record.status = out.skipped ? 'skipped' : 'done';
      record.output_type = out.output_type ?? null;
      record.output_id = out.output_id ?? null;
      record.error = null;
      record.at = new Date();
    } catch (err) {
      record.status = 'failed';
      record.error = errorMessage(err);
      record.at = new Date();
      failure = `${step.name}: ${record.error}`;
    }
    await Models.AutomationRun.updateOne({ _id: run._id } as never, { $set: { steps: records, updated_at: new Date() } } as never).exec();
    if (failure) break;
  }

  const status: 'done' | 'failed' = failure ? 'failed' : 'done';
  await Models.AutomationRun.updateOne(
    { _id: run._id } as never,
    { $set: { status, error: failure, claimed_at: null, steps: records, updated_at: new Date() } } as never,
  ).exec();
  if (failure) await raiseRunFailureAlert(run, rule.code, view, failure);
  return status;
}

/* ================================================================== *
 * Xử lý sự kiện
 * ================================================================== */

/**
 * Nhận MỘT sự kiện chưa xử lý bằng lease (nguyên tử; hai tiến trình không nhận trùng).
 * `exclude`: các sự kiện đang chờ lượt chạy trong vòng này — không nhận lại trong cùng vòng.
 */
async function claimNextEvent(now: Date, exclude: unknown[]): Promise<EventRow | null> {
  const staleBefore = new Date(now.getTime() - EVENT_LEASE_MS);
  const filter = {
    processed_at: null,
    $or: [{ claimed_at: null }, { claimed_at: { $lt: staleBefore } }],
    ...(exclude.length > 0 ? { _id: { $nin: exclude } } : {}),
  };
  return Models.DomainEvent.findOneAndUpdate(
    filter as never,
    { $set: { claimed_at: now }, $inc: { attempts: 1 } },
    { sort: { created_at: 1 }, returnDocument: 'after' },
  ).lean<EventRow | null>();
}

interface EventCounters {
  runs_done: number;
  runs_failed: number;
  runs_skipped: number;
  rules_without_handler: number;
  /** Có lượt của quy tắc khớp đang chạy trong lease của tiến trình khác ⇒ sự kiện CHƯA xử lý xong, phải chờ. */
  waiting: boolean;
}

/** Khớp quy tắc với một sự kiện và chạy từng quy tắc phù hợp. */
async function processEvent(ev: EventRow): Promise<EventCounters> {
  const counters: EventCounters = { runs_done: 0, runs_failed: 0, runs_skipped: 0, rules_without_handler: 0, waiting: false };
  const view = eventView(ev);
  const rules = await Models.AutomationRule.find({
    enabled: true,
    $or: [{ trigger_event: ev.type }, { trigger_events: ev.type }],
  }).lean<RuleRow[]>();

  for (const rule of rules) {
    if (!ruleListensTo(rule, ev.type)) continue;
    const handler = getRuleHandler(rule.code);
    if (!handler) {
      counters.rules_without_handler++;
      continue;
    }
    if (!isRuleEnabledFor(rule, view.company_id)) continue;
    if (!matchCondition(rule.condition, view as unknown as Record<string, unknown>)) continue;
    if (!view.subject_id) {
      // quy tắc cần đối tượng nguồn để khoá idempotency — sự kiện toàn hệ thống không đủ điều kiện
      counters.runs_skipped++;
      continue;
    }

    const idemKey = runKeyFor(rule.code, view.subject_id, ev.type, view.id, handler);
    const run = await getOrCreateRun(rule, handler.steps.map((s) => s.name), ev, view, idemKey);
    const now = new Date();
    const claimed = await claimRun(run._id, ['pending'], now);
    if (!claimed) {
      // Lượt đã xong, hoặc đã lỗi (có cảnh báo, chờ "Chạy lại") ⇒ không còn việc tự động cho quy tắc này.
      // Lượt đang nằm trong lease của một tiến trình khác ⇒ sự kiện CHƯA xong: không được đánh dấu xử lý,
      // phải chờ để nhận lại khi lượt quá lease (nhánh tiếp quản của claimRun). Không chạy lại lượt lỗi tự động.
      if (await isRunLeased(run._id, now)) counters.waiting = true;
      counters.runs_skipped++;
      continue;
    }
    const status = await executeRunSteps(claimed, rule, handler, view);
    if (status === 'done') counters.runs_done++;
    else counters.runs_failed++;
  }
  return counters;
}

/** Sự kiện lỗi ngoài dự kiến: nhả lease; quá số lần thì bỏ qua và cảnh báo KTT. */
async function releaseEventAfterError(ev: EventRow, err: unknown): Promise<void> {
  const message = errorMessage(err);
  const giveUp = (ev.attempts ?? 0) >= MAX_EVENT_ATTEMPTS;
  await Models.DomainEvent.updateOne(
    { _id: ev._id } as never,
    { $set: { claimed_at: null, last_error: message, ...(giveUp ? { processed_at: new Date() } : {}) } } as never,
  ).exec();
  if (!giveUp) return;
  try {
    await Models.Alert.create({
      type: 'event',
      alert_type: 'automation_event_failed',
      company_id: ev.company_id ?? null,
      severity: 2,
      text: `Sự kiện ${ev.type} không xử lý được sau ${MAX_EVENT_ATTEMPTS} lần thử — cần kiểm tra`,
      to_roles: ['chief_accountant'],
      subject: { type: ev.subject_type, id: strOrNull(ev.subject_id), event_id: String(ev._id), error: message },
      channels: ['web'],
      dedupe_key: `automation_event_failed:${String(ev._id)}`,
    } as never);
  } catch (alertErr) {
    if (!isDuplicateKeyError(alertErr)) console.error(`[automation] không ghi được cảnh báo sự kiện: ${(alertErr as Error).message}`);
  }
}

/**
 * Xử lý tối đa `limit` sự kiện chưa xử lý. An toàn khi gọi song song (cron + kick + HTTP).
 * Mỗi sự kiện được đánh dấu `processed_at` SAU KHI mọi quy tắc khớp đã xử lý xong (hoặc đã lỗi
 * có cảnh báo). Sự kiện còn lượt đang chạy trong lease thì CHƯA đánh dấu: nhả lease và được xét lại
 * ở vòng sau; khi lượt quá lease, bộ máy tiếp quản lượt và chạy tiếp các bước còn lại. Lượt lỗi không
 * tự chạy lại — dùng `rerunRun`.
 */
export async function processPendingEvents(opts: { limit?: number; now?: Date } = {}): Promise<ProcessSummary> {
  const limit = opts.limit ?? BATCH_SIZE;
  const summary: ProcessSummary = emptySummary();
  /** Sự kiện đang chờ lượt chạy — không nhận lại trong chính vòng này. */
  const deferred: unknown[] = [];
  for (let i = 0; i < limit; i++) {
    const ev = await claimNextEvent(opts.now ?? new Date(), deferred);
    if (!ev) break;
    summary.events++;
    try {
      const c = await processEvent(ev);
      summary.runs_done += c.runs_done;
      summary.runs_failed += c.runs_failed;
      summary.runs_skipped += c.runs_skipped;
      summary.rules_without_handler += c.rules_without_handler;
      if (c.waiting) {
        // Chưa xong: giữ "chưa xử lý" và nhả lease. Chờ lượt không phải là một lần thử lỗi ⇒ hoàn lại lần nhận.
        deferred.push(ev._id);
        await Models.DomainEvent.updateOne(
          { _id: ev._id } as never,
          { $set: { claimed_at: null }, $inc: { attempts: -1 } } as never,
        ).exec();
      } else {
        await Models.DomainEvent.updateOne({ _id: ev._id } as never, { $set: { processed_at: new Date(), claimed_at: null } } as never).exec();
      }
    } catch (err) {
      summary.errors++;
      console.error(`[automation] lỗi xử lý sự kiện ${ev.type}: ${errorMessage(err)}`);
      await releaseEventAfterError(ev, err);
    }
  }
  // Khi hàng sự kiện rảnh (kể cả sự kiện đang chờ lượt — chúng vẫn được đếm trong `events`, nên lượt đang
  // chờ tiếp quản KHÔNG bị dọn trước): dọn lượt bị treo (tiến trình chết giữa chừng) để KTT chạy lại;
  // đối chiếu outbox (thao tác thiếu sự kiện) định kỳ, không quá một lần mỗi RECONCILE_EVERY_MS.
  if (summary.events === 0) {
    const now = opts.now ?? new Date();
    summary.runs_swept = await sweepStaleRuns(now);
    if (now.getTime() - lastReconcileAt >= RECONCILE_EVERY_MS) {
      lastReconcileAt = now.getTime();
      try {
        const { reconcileTransitionEvents } = await import('../events/index.ts');
        summary.outbox_gaps = await reconcileTransitionEvents({ now });
      } catch (err) {
        console.error(`[automation] đối chiếu outbox lỗi: ${errorMessage(err)}`);
      }
    }
  }
  return summary;
}

/** Chu kỳ đối chiếu outbox (khi hàng sự kiện rảnh). */
export const RECONCILE_EVERY_MS = 5 * 60_000;
let lastReconcileAt = 0;

/**
 * Lượt 'running' đã quá lease (tiến trình trước dừng giữa chừng) ⇒ đánh dấu `failed` với lý do rõ ràng
 * và cảnh báo KTT (dedupe theo `run._id`). Sau đó "Chạy lại" (`rerunRun`) làm tiếp phần chưa xong.
 * Ngoại lệ: lượt có sự kiện nguồn CHƯA xử lý được bỏ qua — sự kiện đó sẽ tiếp quản lượt (processPendingEvents).
 */
export async function sweepStaleRuns(now: Date = new Date(), limit = 50): Promise<number> {
  const staleBefore = new Date(now.getTime() - RUN_LEASE_MS);
  const stale = await Models.AutomationRun.find({ status: 'running', claimed_at: { $lt: staleBefore } } as never)
    .limit(limit)
    .lean<RunRow[]>();
  let swept = 0;
  for (const run of stale) {
    // Sự kiện nguồn còn CHƯA xử lý ⇒ bộ máy sẽ nhận lại sự kiện và tiếp quản lượt này (processEvent → claimRun),
    // nên không đánh dấu Lỗi sớm. Chỉ lượt mồ côi (sự kiện đã xử lý mà lượt vẫn treo) mới bị đánh dấu Lỗi.
    if (run.event_id && (await Models.DomainEvent.exists({ _id: run.event_id, processed_at: null } as never))) continue;
    const res = await Models.AutomationRun.updateOne(
      { _id: run._id, status: 'running', claimed_at: { $lt: staleBefore } } as never,
      { $set: { status: 'failed', error: 'Lượt bị gián đoạn giữa chừng — cần chạy lại', claimed_at: null, updated_at: now } } as never,
    ).exec();
    if (!res.modifiedCount) continue;
    swept++;
    const { raiseAlert } = await import('../alerts/index.ts');
    await raiseAlert({
      alert_type: 'automation_run_failed',
      company_id: strOrNull(run.company_id),
      severity: 2,
      text: `${AUTOMATION_RULE_LABEL[run.rule_code as keyof typeof AUTOMATION_RULE_LABEL] ?? run.rule_code}: lượt bị gián đoạn — cần chạy lại`,
      subject: { type: run.source_type, id: strOrNull(run.source_id), run_id: String(run._id), rule_code: run.rule_code },
      to_roles: ['chief_accountant'],
      channels: ['web'],
      dedupe_key: runFailureAlertKey(run._id, run.attempts),
    });
  }
  return swept;
}

/* ------------------------------------------------------------------ *
 * Gộp các lần gọi trong cùng tiến trình (kick sau khi ghi sự kiện + chu kỳ job).
 * Không chạy chồng: lời gọi đến lúc đang chạy ⇒ vòng lặp chạy thêm một lượt.
 * ------------------------------------------------------------------ */

let draining: Promise<ProcessSummary> | null = null;
let drainAgain = false;

function emptySummary(): ProcessSummary {
  return { events: 0, runs_done: 0, runs_failed: 0, runs_skipped: 0, rules_without_handler: 0, runs_swept: 0, outbox_gaps: 0, errors: 0 };
}

export function drainAutomation(): Promise<ProcessSummary> {
  if (draining) {
    drainAgain = true;
    return draining;
  }
  draining = (async () => {
    const total = emptySummary();
    for (;;) {
      drainAgain = false;
      const s = await processPendingEvents({ limit: BATCH_SIZE });
      total.events += s.events;
      total.runs_done += s.runs_done;
      total.runs_failed += s.runs_failed;
      total.runs_skipped += s.runs_skipped;
      total.rules_without_handler += s.rules_without_handler;
      total.runs_swept += s.runs_swept;
      total.outbox_gaps += s.outbox_gaps;
      total.errors += s.errors;
      if (s.events < BATCH_SIZE && !drainAgain) break;
    }
    return total;
  })().finally(() => {
    draining = null;
  });
  return draining;
}

let kickQueued = false;

/** Xử lý ngay ở vòng lặp kế tiếp (setImmediate). Gọi sau mỗi lần ghi sự kiện — rẻ, gộp nhiều lần gọi. */
export function kickAutomation(): void {
  if (kickQueued) return;
  kickQueued = true;
  setImmediate(() => {
    kickQueued = false;
    drainAutomation().catch((err: unknown) => console.error(`[automation] lỗi xử lý nền: ${errorMessage(err)}`));
  });
}

/* ================================================================== *
 * Chạy lại lượt lỗi
 * ================================================================== */

/**
 * "Chạy lại" (v2 §11.2 (3)): chỉ chạy các bước CHƯA XONG của lượt đang `failed` (hoặc đang chạy
 * nhưng đã quá lease — tiến trình trước đã chết). Lượt không ở trạng thái đó ⇒ FG-AUTO-001.
 * Không kiểm tra quyền/phạm vi — tầng route phải kiểm tra trước (`automation:config` hoặc KTT).
 */
export async function rerunRun(runId: string, opts: { now?: Date } = {}): Promise<RunRow> {
  const now = opts.now ?? new Date();
  const run = await Models.AutomationRun.findById(runId).lean<RunRow | null>();
  if (!run) throw new ApiError({ code: 'FG-VAL-001', status: 404, detail: 'Không tìm thấy lượt chạy' });
  const handler = getRuleHandler(run.rule_code);
  if (!handler) throw new ApiError({ code: 'FG-AUTO-001', detail: `Quy tắc ${run.rule_code} chưa có bộ xử lý trên máy chủ` });

  const claimed = await claimRun(run._id, ['failed'], now);
  if (!claimed) {
    const why =
      run.status === 'done'
        ? 'Lượt đã hoàn tất, không cần chạy lại'
        : run.status === 'running'
          ? 'Lượt đang được xử lý'
          : 'Lượt chưa bắt đầu, hệ thống sẽ tự chạy';
    throw new ApiError({ code: 'FG-AUTO-001', detail: why });
  }

  const rule = await Models.AutomationRule.findOne({ code: run.rule_code }).lean<RuleRow | null>();
  const ev = run.event_id ? await Models.DomainEvent.findById(run.event_id).lean<EventRow | null>() : null;
  const view: AutomationEventView = ev
    ? eventView(ev)
    : {
        id: null,
        type: run.event_type,
        company_id: strOrNull(run.company_id),
        subject_type: run.source_type,
        subject_id: strOrNull(run.source_id),
        payload: {},
        actor: { user_id: null, name: null, role: null },
      };
  const ruleForParams: RuleLike & { code: string } = rule ?? { code: run.rule_code, params: {}, company_overrides: [], company_ids: [], enabled: true };
  await executeRunSteps(claimed, ruleForParams, handler, view);
  return (await Models.AutomationRun.findById(runId).lean<RunRow | null>()) ?? claimed;
}

/* ================================================================== *
 * Quy tắc mặc định (seed) — v2/v2.md §11.3, §14.2
 * ================================================================== */

export interface DefaultRuleDef {
  code: string;
  name: string;
  trigger_event: string;
  trigger_events: string[];
  condition: Record<string, unknown>;
  steps: string[];
  params: Record<string, unknown>;
  enabled: boolean;
}

/**
 * Quy tắc seed. Tên bước khớp §14.3 (create_voucher, execute_voucher, create_loan, activate_loan,
 * link, notify, alert…). Bộ xử lý do module của từng quy tắc đăng ký; chưa có bộ xử lý ⇒ quy tắc
 * không chạy. R4 tắt mặc định.
 */
export const DEFAULT_AUTOMATION_RULES: readonly DefaultRuleDef[] = [
  {
    code: 'R1',
    name: AUTOMATION_RULE_LABEL.R1,
    trigger_event: 'voucher.paid',
    trigger_events: [],
    condition: { 'payload.kind': 'spend' },
    steps: ['create_voucher', 'execute_voucher', 'link'],
    params: {},
    enabled: true,
  },
  {
    code: 'R2',
    name: AUTOMATION_RULE_LABEL.R2,
    trigger_event: 'voucher.created',
    trigger_events: ['voucher.updated', 'voucher.submitted', 'voucher.approved', 'voucher.paid'],
    // mọi phiếu thu: bước tạo / liên kết chỉ làm với phiếu đi vay (cờ borrow); bước kích hoạt áp dụng cho
    // MỌI liên kết giải ngân hiệu lực khi phiếu đã thực thi (liên kết gán tay cũng được kích hoạt — §10.2)
    condition: { 'payload.kind': 'income' },
    steps: ['create_loan', 'activate_loan', 'link'],
    params: { term_months: 12, due_offset_months: 11, r2_create_at: 'save' },
    enabled: true,
  },
  {
    code: 'R3',
    name: AUTOMATION_RULE_LABEL.R3,
    trigger_event: 'voucher.approved',
    trigger_events: [],
    condition: { 'payload.kind': 'spend', 'payload.loan_kind': 'fund' },
    steps: ['create_loan', 'create_voucher', 'link', 'execute_voucher', 'activate_loan'],
    params: { term_months: 12, due_offset_months: 11 },
    enabled: true,
  },
  {
    code: 'R4',
    name: AUTOMATION_RULE_LABEL.R4,
    trigger_event: 'loan.settled',
    trigger_events: [],
    condition: {},
    steps: ['notify'],
    params: {},
    enabled: false,
  },
  {
    code: 'R5',
    name: AUTOMATION_RULE_LABEL.R5,
    trigger_event: 'schedule.recurring',
    trigger_events: [],
    condition: {},
    steps: ['create_voucher'],
    params: {},
    enabled: true,
  },
  {
    code: 'R6',
    name: AUTOMATION_RULE_LABEL.R6,
    trigger_event: 'voucher.cancelled',
    trigger_events: ['voucher.rejected'],
    condition: { 'payload.loan_kind': { $ne: null } },
    steps: ['cancel_unpaid', 'alert'],
    params: {},
    enabled: true,
  },
  {
    code: 'R7',
    name: AUTOMATION_RULE_LABEL.R7,
    trigger_event: 'voucher.approved',
    trigger_events: [],
    // mọi phiếu thu / chi duyệt xong: bước gán chỉ làm với phiếu có cấn trừ khoản vay (còn lại là lượt bỏ qua, như R1)
    condition: { 'payload.kind': { $in: ['spend', 'income'] } },
    steps: ['link'],
    params: {},
    enabled: true,
  },
];

/**
 * Tạo quy tắc mặc định còn thiếu (idempotent). Quy tắc đã có: KHÔNG ghi đè các trường người dùng chỉnh
 * (bật/tắt, tham số, phạm vi, ghi đè theo công ty). Riêng phần ĐỊNH NGHĨA do code quản lý (tên, sự kiện
 * kích hoạt, điều kiện, danh sách bước) được cập nhật lại mỗi lần khởi động — để một quy tắc được mở
 * rộng (VD thêm sự kiện) lên được cả cơ sở dữ liệu đã có sẵn.
 */
export async function ensureAutomationRules(now: Date = new Date()): Promise<{ inserted: string[] }> {
  const inserted: string[] = [];
  for (const def of DEFAULT_AUTOMATION_RULES) {
    const { code, name, trigger_event, trigger_events, condition, steps, params, enabled } = def;
    try {
      const res = await Models.AutomationRule.updateOne(
        { code } as never,
        {
          $setOnInsert: { code, params, enabled, company_overrides: [], company_ids: [], created_at: now, updated_at: now },
          $set: { name, trigger_event, trigger_events, condition, steps },
        } as never,
        { upsert: true },
      ).exec();
      if (res.upsertedCount) inserted.push(code);
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
    }
  }
  return { inserted };
}

/* ================================================================== *
 * Tham số & phạm vi đọc cho module khác
 * ================================================================== */

/** Đọc quy tắc đang bật theo mã (nếu có) — tiện cho màn cấu hình. */
export async function findRuleByCode(code: string): Promise<RuleRow | null> {
  return Models.AutomationRule.findOne({ code } as never).lean<RuleRow | null>();
}

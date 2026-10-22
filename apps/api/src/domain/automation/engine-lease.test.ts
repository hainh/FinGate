import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Bộ nhớ giả cho các collection mà bộ máy tự động dùng (domain_events, automation_rules, automation_runs, alerts),
 * đủ để chạy thật processPendingEvents / sweepStaleRuns: đọc theo điều kiện, nhận bằng findOneAndUpdate,
 * cập nhật $set / $inc / $setOnInsert, upsert. Thời gian được giả lập qua Date.
 */
const mem = vi.hoisted(() => {
  type Doc = Record<string, unknown>;

  const collections: Record<string, Doc[]> = { domain_events: [], automation_rules: [], automation_runs: [], alerts: [] };
  const alertsRaised: Doc[] = [];
  let seq = 0;

  const rows = (name: string): Doc[] => {
    const list = collections[name];
    if (!list) throw new Error(`không có collection ${name}`);
    return list;
  };

  const isNil = (v: unknown): boolean => v === null || v === undefined;
  const isOpsObject = (v: unknown): v is Doc =>
    v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && Object.keys(v).some((k) => k.startsWith('$'));

  /** So khớp giá trị: null khớp null/thiếu; mảng khớp nếu chứa; id / chuỗi / số so theo chuỗi; Date theo thời điểm. */
  const eq = (actual: unknown, expected: unknown): boolean => {
    if (isNil(expected)) return isNil(actual);
    if (Array.isArray(actual)) return actual.some((v) => eq(v, expected));
    if (isNil(actual)) return false;
    if (actual instanceof Date || expected instanceof Date) return new Date(actual as Date).getTime() === new Date(expected as Date).getTime();
    return String(actual) === String(expected);
  };

  const matchField = (actual: unknown, cond: unknown): boolean => {
    if (!isOpsObject(cond)) return eq(actual, cond);
    return Object.entries(cond).every(([op, arg]) => {
      if (op === '$in') return (arg as unknown[]).some((v) => eq(actual, v));
      if (op === '$nin') return !(arg as unknown[]).some((v) => eq(actual, v));
      if (op === '$lt') return !isNil(actual) && new Date(actual as Date).getTime() < new Date(arg as Date).getTime();
      throw new Error(`bộ nhớ giả chưa hỗ trợ toán tử ${op}`);
    });
  };

  const matches = (doc: Doc, filter: Doc): boolean =>
    Object.entries(filter).every(([key, cond]) => (key === '$or' ? (cond as Doc[]).some((f) => matches(doc, f)) : matchField(doc[key], cond)));

  const copy = <T>(v: T): T => (isNil(v) ? v : (structuredClone(v) as T));

  const applyUpdate = (doc: Doc, update: Doc, inserting: boolean): void => {
    for (const [k, v] of Object.entries((update.$set ?? {}) as Doc)) doc[k] = v;
    for (const [k, v] of Object.entries((update.$inc ?? {}) as Doc)) doc[k] = Number(doc[k] ?? 0) + Number(v);
    if (inserting) for (const [k, v] of Object.entries((update.$setOnInsert ?? {}) as Doc)) doc[k] = v;
  };

  const sortRows = (list: Doc[], sort: Doc | undefined): Doc[] => {
    const entry = sort ? Object.entries(sort)[0] : undefined;
    if (!entry) return list;
    const [key, dir] = entry;
    const sign = Number(dir) < 0 ? -1 : 1;
    return [...list].sort((a, b) => sign * (new Date(a[key] as Date).getTime() - new Date(b[key] as Date).getTime()));
  };

  const insert = (name: string, doc: Doc): Doc => {
    const row: Doc = { _id: `mem-${++seq}`, ...doc };
    rows(name).push(row);
    return row;
  };

  /** Truy vấn giả: lean() / exec() trả Promise; limit() cắt kết quả mảng. */
  class Query {
    private readonly run: (limit: number | null) => unknown;
    private limitTo: number | null = null;
    constructor(run: (limit: number | null) => unknown) {
      this.run = run;
    }
    select(): this {
      return this;
    }
    sort(): this {
      return this;
    }
    limit(n: number): this {
      this.limitTo = n;
      return this;
    }
    lean<T = unknown>(): Promise<T> {
      return Promise.resolve(this.run(this.limitTo) as T);
    }
    exec<T = unknown>(): Promise<T> {
      return Promise.resolve(this.run(this.limitTo) as T);
    }
  }

  const model = (name: string) => ({
    find: (filter: Doc) =>
      new Query((limit) => {
        const hits = rows(name)
          .filter((d) => matches(d, filter))
          .map((d) => copy(d));
        return limit === null ? hits : hits.slice(0, limit);
      }),
    findOne: (filter: Doc) => new Query(() => copy(rows(name).find((d) => matches(d, filter)) ?? null)),
    findById: (id: unknown) => new Query(() => copy(rows(name).find((d) => eq(d._id, id)) ?? null)),
    findOneAndUpdate: (filter: Doc, update: Doc, opts: { sort?: Doc; upsert?: boolean } = {}) =>
      new Query(() => {
        const hit = sortRows(
          rows(name).filter((d) => matches(d, filter)),
          opts.sort,
        )[0];
        if (hit) {
          applyUpdate(hit, update, false);
          return copy(hit);
        }
        if (!opts.upsert) return null;
        const created: Doc = { _id: `mem-${++seq}` };
        for (const [k, v] of Object.entries(filter)) if (!k.startsWith('$') && !isOpsObject(v)) created[k] = v;
        applyUpdate(created, update, true);
        rows(name).push(created);
        return copy(created);
      }),
    updateOne: (filter: Doc, update: Doc) =>
      new Query(() => {
        const hit = rows(name).find((d) => matches(d, filter));
        if (!hit) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
        applyUpdate(hit, update, false);
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
      }),
    exists: async (filter: Doc) => {
      const hit = rows(name).find((d) => matches(d, filter));
      return hit ? { _id: hit._id } : null;
    },
    create: async (doc: Doc) => copy(insert(name, doc)),
  });

  const Models = {
    DomainEvent: model('domain_events'),
    AutomationRule: model('automation_rules'),
    AutomationRun: model('automation_runs'),
    Alert: model('alerts'),
  };

  return { collections, alertsRaised, insert, rows, Models };
});

vi.mock('../../db/models.ts', () => ({ Models: mem.Models }));

/* Cảnh báo đi qua raiseAlert (domain/alerts): ghi nhận đầu vào để kiểm tra. */
vi.mock('../alerts/index.ts', () => ({
  raiseAlert: vi.fn(async (input: Record<string, unknown>) => {
    mem.alertsRaised.push(input);
    return true;
  }),
}));

/* Đối chiếu outbox không thuộc phạm vi kiểm thử này. */
vi.mock('../events/index.ts', () => ({
  reconcileTransitionEvents: vi.fn(async () => 0),
}));

import { clearRuleHandlers, processPendingEvents, registerRule, sweepStaleRuns } from './engine.ts';

const MIN = 60_000;
const T0 = new Date('2026-10-22T10:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/** Các bước đã thực hiện, theo thứ tự (bộ xử lý R2 giả). */
const calls: string[] = [];
/** Bước được cho lỗi giả lập (null = không lỗi). */
let failStep: string | null = null;

function registerR2(): void {
  const step = (name: string) => ({
    name,
    run: async () => {
      calls.push(name);
      if (failStep === name) throw new Error(`bước ${name} lỗi giả lập`);
      return { output_type: 'bank_debt', output_id: `${name}-out` };
    },
  });
  registerRule('R2', { steps: [step('create_loan'), step('activate_loan'), step('link')] });
}

function seedRuleR2(): void {
  mem.insert('automation_rules', {
    code: 'R2',
    name: 'R2 — Phiếu thu đi vay',
    enabled: true,
    trigger_event: 'voucher.created',
    trigger_events: [],
    condition: { 'payload.kind': 'income' },
    params: {},
    company_overrides: [],
    company_ids: [],
  });
}

function seedEvent(id: string, subject: string, createdAt: Date, extra: Record<string, unknown> = {}): void {
  mem.insert('domain_events', {
    _id: id,
    type: 'voucher.created',
    company_id: 'c1',
    subject_type: 'document',
    subject_id: subject,
    payload: { kind: 'income' },
    actor: { user_id: 'u1', name: 'Kế toán', role: 'staff' },
    created_at: createdAt,
    processed_at: null,
    claimed_at: null,
    attempts: 0,
    last_error: null,
    ...extra,
  });
}

/** Lượt R2 của phiếu đang ở trạng thái "running" (tiến trình trước giữ lease từ `claimedAt`), các bước chưa xong. */
function seedRunningRun(id: string, subject: string, eventId: string, claimedAt: Date): void {
  mem.insert('automation_runs', {
    _id: id,
    rule_id: 'rule-r2',
    rule_code: 'R2',
    company_id: 'c1',
    source_type: 'document',
    source_id: subject,
    event_id: eventId,
    event_type: 'voucher.created',
    idem_key: `R2:${subject}:voucher.created`,
    status: 'running',
    steps: ['create_loan', 'activate_loan', 'link'].map((name) => ({
      name,
      status: 'pending',
      output_type: null,
      output_id: null,
      error: null,
      at: null,
    })),
    error: null,
    attempts: 1,
    claimed_at: claimedAt,
    created_at: claimedAt,
    updated_at: claimedAt,
  });
}

function row(collection: string, id: string): Record<string, unknown> {
  const hit = mem.rows(collection).find((d) => d._id === id);
  if (!hit) throw new Error(`không thấy ${collection}/${id}`);
  return hit;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  for (const name of Object.keys(mem.collections)) mem.rows(name).length = 0;
  mem.alertsRaised.length = 0;
  calls.length = 0;
  failStep = null;
  clearRuleHandlers();
  registerR2();
  seedRuleR2();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('automation › sự kiện chờ lượt đang chạy trong lease (processPendingEvents)', () => {
  it('lượt bị bỏ dở còn lease: sự kiện KHÔNG bị đánh dấu xử lý; quá lease thì tiếp quản và chạy tiếp các bước còn lại', async () => {
    // tiến trình trước nhận sự kiện và lượt lúc T0 rồi dừng giữa chừng (chưa bước nào xong)
    seedEvent('ev1', 'd1', T0, { claimed_at: T0, attempts: 1 });
    seedRunningRun('run1', 'd1', 'ev1', T0);

    // T0 + 3 phút: lease của sự kiện đã hết nhưng lượt còn lease ⇒ phải chờ, không đánh dấu, không tính là lần thử lỗi
    vi.setSystemTime(at(3 * MIN));
    const first = await processPendingEvents();
    expect(first.events).toBe(1);
    expect(row('domain_events', 'ev1')).toMatchObject({ processed_at: null, claimed_at: null, attempts: 1 });
    expect(row('automation_runs', 'run1')).toMatchObject({ status: 'running', attempts: 1 });
    expect(calls).toEqual([]);

    // T0 + 4 phút: vẫn chờ, không chạy bước nào
    vi.setSystemTime(at(4 * MIN));
    await processPendingEvents();
    expect(row('domain_events', 'ev1').processed_at).toBeNull();
    expect(calls).toEqual([]);

    // T0 + 5 phút 1 giây: lượt quá lease ⇒ tiếp quản, chạy các bước còn lại, rồi mới đánh dấu sự kiện
    vi.setSystemTime(at(5 * MIN + 1000));
    const takeover = await processPendingEvents();
    expect(calls).toEqual(['create_loan', 'activate_loan', 'link']);
    expect(takeover.runs_done).toBe(1);
    expect(row('automation_runs', 'run1')).toMatchObject({ status: 'done', error: null });
    expect(row('domain_events', 'ev1').processed_at).not.toBeNull();
    expect(mem.alertsRaised).toEqual([]);
  });

  it('sự kiện đang chờ không bị nhận lại trong cùng vòng; sự kiện khác vẫn được xử lý bình thường', async () => {
    seedEvent('ev1', 'd1', T0, { claimed_at: T0, attempts: 1 });
    seedRunningRun('run1', 'd1', 'ev1', T0);
    seedEvent('ev2', 'd2', at(1000));

    vi.setSystemTime(at(3 * MIN));
    const s = await processPendingEvents();
    expect(s.events).toBe(2); // ev1 chỉ được nhận một lần trong vòng, ev2 một lần
    expect(row('domain_events', 'ev2').processed_at).not.toBeNull();
    expect(row('domain_events', 'ev1').processed_at).toBeNull();
    expect(calls).toEqual(['create_loan', 'activate_loan', 'link']); // chỉ phiếu d2 chạy
  });

  it('lượt lỗi (đã có cảnh báo) không giữ sự kiện: sự kiện được đánh dấu xử lý và KTT được cảnh báo đúng một lần', async () => {
    failStep = 'activate_loan';
    seedEvent('ev1', 'd1', T0);

    const s = await processPendingEvents();
    expect(s.runs_failed).toBe(1);
    expect(row('domain_events', 'ev1').processed_at).not.toBeNull();
    const run = mem.rows('automation_runs').find((d) => d.idem_key === 'R2:d1:voucher.created');
    expect(run).toMatchObject({ status: 'failed' });
    expect(mem.alertsRaised).toHaveLength(1);
    expect(mem.alertsRaised[0]).toMatchObject({ alert_type: 'automation_run_failed', to_roles: ['chief_accountant'] });
  });

  it('sự kiện đang được tiến trình khác nhận (chưa quá lease): lượt quá lease KHÔNG bị dọn trong vòng này', async () => {
    seedEvent('ev1', 'd1', T0, { claimed_at: at(5 * MIN), attempts: 1 });
    seedRunningRun('run1', 'd1', 'ev1', T0);

    vi.setSystemTime(at(5 * MIN + 1000));
    const s = await processPendingEvents();
    expect(s.events).toBe(0);
    expect(s.runs_swept).toBe(0);
    expect(row('automation_runs', 'run1').status).toBe('running');
  });
});

describe('automation › dọn lượt treo (sweepStaleRuns)', () => {
  it('không đánh dấu Lỗi khi sự kiện nguồn còn chưa xử lý; lượt mồ côi (sự kiện đã xong) mới bị Lỗi kèm cảnh báo KTT', async () => {
    seedEvent('ev1', 'd1', T0, { claimed_at: T0, attempts: 1 });
    seedRunningRun('run1', 'd1', 'ev1', T0);
    const later = at(5 * MIN + 1000);

    expect(await sweepStaleRuns(later)).toBe(0);
    expect(row('automation_runs', 'run1').status).toBe('running');

    // sự kiện đã được đánh dấu xử lý ⇒ không còn ai tiếp quản: lượt treo là mồ côi
    row('domain_events', 'ev1').processed_at = later;
    expect(await sweepStaleRuns(later)).toBe(1);
    expect(row('automation_runs', 'run1')).toMatchObject({ status: 'failed', error: 'Lượt bị gián đoạn giữa chừng — cần chạy lại' });
    expect(mem.alertsRaised).toHaveLength(1);
    expect(mem.alertsRaised[0]).toMatchObject({ alert_type: 'automation_run_failed', to_roles: ['chief_accountant'] });
  });
});

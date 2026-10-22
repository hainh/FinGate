import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@fingate/shared';

/* Mô hình hoá tầng DB: ghi nhận các lần cập nhật lượt chạy và cảnh báo. */
const { updates, alerts } = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
  alerts: [] as Record<string, unknown>[],
}));

vi.mock('../../db/models.ts', () => ({
  Models: {
    AutomationRun: {
      updateOne: vi.fn((_filter: unknown, update: Record<string, unknown>) => {
        updates.push(update);
        return { exec: async () => ({ acknowledged: true, modifiedCount: 1 }) };
      }),
    },
  },
}));

/* Cảnh báo đi qua raiseAlert (domain/alerts): ghi nhận đầu vào để kiểm tra. */
vi.mock('../alerts/index.ts', () => ({
  raiseAlert: vi.fn(async (input: Record<string, unknown>) => {
    alerts.push(input);
    return true;
  }),
}));

import {
  DEFAULT_AUTOMATION_RULES,
  clearRuleHandlers,
  executeRunSteps,
  getRuleHandler,
  getRuleParams,
  idemKeyFor,
  isRuleEnabledFor,
  matchCondition,
  mergeStepRecords,
  pendingStepNames,
  registerRule,
  registeredRuleCodes,
  ruleListensTo,
  stepKeyFor,
  type AutomationEventView,
  type RuleHandler,
  type StepRecord,
} from './engine.ts';

const view: AutomationEventView = {
  id: 'e1',
  type: 'voucher.approved',
  company_id: 'c1',
  subject_type: 'document',
  subject_id: 'd1',
  payload: { kind: 'spend', loan_kind: 'fund', amount_minor: '100', partner_id: null },
  actor: { user_id: 'u1', name: 'Nguyễn A', role: 'chief_accountant' },
};

const rule = {
  code: 'R3',
  params: { term_months: 12 },
  company_overrides: [{ company_id: 'c1', params: { term_months: 24 } }],
  company_ids: [],
  enabled: true,
};

function makeRun(steps: StepRecord[]) {
  return {
    _id: 'run1',
    rule_id: 'rule1',
    rule_code: 'R3',
    company_id: 'c1',
    source_type: 'document',
    source_id: 'd1',
    event_id: 'e1',
    event_type: 'voucher.approved',
    idem_key: idemKeyFor('R3', 'd1', 'voucher.approved'),
    status: 'running',
    steps,
    error: null,
    attempts: 1,
    claimed_at: new Date(),
  } as never;
}

/** Bản `steps` gần nhất được ghi xuống DB. */
function lastSavedSteps(): StepRecord[] {
  const withSteps = updates.filter((u) => (u.$set as Record<string, unknown> | undefined)?.steps !== undefined);
  return ((withSteps.at(-1)?.$set as Record<string, unknown>).steps ?? []) as StepRecord[];
}

beforeEach(() => {
  updates.length = 0;
  alerts.length = 0;
  clearRuleHandlers();
});

describe('automation › khoá, tham số, phạm vi (thuần)', () => {
  it('khoá idempotency: lượt = rule:source:event, bước = lượt#bước', () => {
    expect(idemKeyFor('R3', 'd1', 'voucher.approved')).toBe('R3:d1:voucher.approved');
    expect(stepKeyFor('R3:d1:voucher.approved', 'create_loan')).toBe('R3:d1:voucher.approved#create_loan');
  });

  it('tham số: ghi đè của công ty thắng mặc định; công ty khác dùng mặc định', () => {
    expect(getRuleParams(rule, 'c1').term_months).toBe(24);
    expect(getRuleParams(rule, 'c2').term_months).toBe(12);
    expect(getRuleParams(rule, null).term_months).toBe(12);
  });

  it('bật/tắt theo công ty: tắt toàn cục, ghi đè tắt, phạm vi company_ids', () => {
    expect(isRuleEnabledFor({ enabled: false }, 'c1')).toBe(false);
    expect(isRuleEnabledFor({ enabled: true, company_overrides: [{ company_id: 'c1', enabled: false }] }, 'c1')).toBe(false);
    expect(isRuleEnabledFor({ enabled: true, company_overrides: [{ company_id: 'c1', enabled: false }] }, 'c2')).toBe(true);
    expect(isRuleEnabledFor({ enabled: true, company_ids: ['c2'] }, 'c1')).toBe(false);
    expect(isRuleEnabledFor({ enabled: true, company_ids: ['c2'] }, 'c2')).toBe(true);
    expect(isRuleEnabledFor({ enabled: true, company_ids: ['c2'] }, null)).toBe(false);
    expect(isRuleEnabledFor({ enabled: true, company_ids: [] }, null)).toBe(true);
  });

  it('trigger chính hoặc trigger bổ sung đều kích hoạt quy tắc', () => {
    const r2 = { trigger_event: 'voucher.created', trigger_events: ['voucher.updated'] };
    expect(ruleListensTo(r2, 'voucher.created')).toBe(true);
    expect(ruleListensTo(r2, 'voucher.updated')).toBe(true);
    expect(ruleListensTo(r2, 'voucher.paid')).toBe(false);
  });
});

describe('automation › điều kiện (matchCondition)', () => {
  const v = { ...view } as unknown as Record<string, unknown>;

  it('so sánh lỏng theo chuỗi; điều kiện rỗng luôn khớp', () => {
    expect(matchCondition({}, v)).toBe(true);
    expect(matchCondition(null, v)).toBe(true);
    expect(matchCondition({ 'payload.kind': 'spend', 'payload.loan_kind': 'fund' }, v)).toBe(true);
    expect(matchCondition({ 'payload.kind': 'income' }, v)).toBe(false);
    expect(matchCondition({ 'payload.amount_minor': 100 }, v)).toBe(true);
    expect(matchCondition({ company_id: 'c1' }, v)).toBe(true);
  });

  it('toán tử $in / $nin / $ne / $exists', () => {
    expect(matchCondition({ 'payload.kind': { $in: ['spend', 'income'] } }, v)).toBe(true);
    expect(matchCondition({ 'payload.kind': { $nin: ['spend'] } }, v)).toBe(false);
    expect(matchCondition({ 'payload.loan_kind': { $ne: null } }, v)).toBe(true);
    expect(matchCondition({ 'payload.partner_id': { $ne: null } }, v)).toBe(false);
    expect(matchCondition({ 'payload.missing': { $exists: true } }, v)).toBe(false);
    expect(matchCondition({ 'payload.missing': { $exists: false } }, v)).toBe(true);
  });

  it('đường dẫn thiếu không khớp; toán tử lạ không khớp (không làm sập)', () => {
    expect(matchCondition({ 'payload.kind.deeper': 'x' }, v)).toBe(false);
    expect(matchCondition({ 'payload.kind': { $weird: 1 } }, v)).toBe(false);
  });
});

describe('automation › kế hoạch bước (thuần)', () => {
  it('bỏ qua bước đã xong / bỏ qua, giữ thứ tự khai báo', () => {
    const declared = ['a', 'b', 'c', 'd'];
    const records = mergeStepRecords(declared, [
      { name: 'a', status: 'done', output_type: 'document', output_id: 'x', error: null, at: null },
      { name: 'b', status: 'failed', output_type: null, output_id: null, error: 'lỗi', at: null },
      { name: 'c', status: 'skipped', output_type: null, output_id: null, error: null, at: null },
    ]);
    expect(pendingStepNames(declared, records)).toEqual(['b', 'd']);
    expect(records.map((r) => r.name)).toEqual(declared);
  });
});

describe('automation › đăng ký bộ xử lý (registerRule)', () => {
  it('từ chối tên bước trùng / sai định dạng; đăng ký hợp lệ tra được', () => {
    const noop = async () => undefined;
    expect(() => registerRule('R9', { steps: [{ name: 'a', run: noop }, { name: 'a', run: noop }] })).toThrow();
    expect(() => registerRule('R9', { steps: [{ name: 'Bad Name', run: noop }] })).toThrow();
    expect(() => registerRule('', { steps: [] })).toThrow();
    registerRule('R9', { steps: [{ name: 'create_voucher', run: noop }] });
    expect(getRuleHandler('R9')?.steps.map((s) => s.name)).toEqual(['create_voucher']);
    expect(registeredRuleCodes()).toContain('R9');
  });
});

describe('automation › quy tắc mặc định (seed)', () => {
  it('R1,R2,R3,R5,R6 bật; R4 tắt; tham số R2/R3 đúng v2 §11', () => {
    const byCode = Object.fromEntries(DEFAULT_AUTOMATION_RULES.map((r) => [r.code, r]));
    expect(Object.keys(byCode).sort()).toEqual(['R1', 'R2', 'R3', 'R4', 'R5', 'R6']);
    expect(byCode.R4?.enabled).toBe(false);
    for (const code of ['R1', 'R2', 'R3', 'R5', 'R6']) expect(byCode[code]?.enabled).toBe(true);
    expect(byCode.R2?.params).toMatchObject({ term_months: 12, due_offset_months: 11, r2_create_at: 'save' });
    expect(byCode.R3?.params).toMatchObject({ term_months: 12, due_offset_months: 11 });
    expect(byCode.R3?.trigger_event).toBe('voucher.approved');
    expect(byCode.R6?.trigger_events).toContain('voucher.rejected');
  });
});

describe('automation › chạy các bước của lượt (executeRunSteps)', () => {
  it('bước lỗi dừng lượt, cảnh báo KTT; chạy lại chỉ làm các bước chưa xong, không tạo trùng', async () => {
    const calls: string[] = [];
    let failExecute = true;
    const handler: RuleHandler = {
      steps: [
        {
          name: 'create_loan',
          run: async (ctx) => {
            calls.push(`create_loan:${ctx.stepKey}`);
            return { output_type: 'bank_debt', output_id: 'b1' };
          },
        },
        {
          name: 'create_voucher',
          run: async (ctx) => {
            calls.push('create_voucher');
            if (ctx.outputs.create_loan?.output_id !== 'b1') throw new Error('thiếu kết quả bước trước');
            return { output_type: 'document', output_id: 'd9' };
          },
        },
        {
          name: 'execute_voucher',
          run: async () => {
            calls.push('execute_voucher');
            if (failExecute) throw new Error('Số dư không đủ');
            return { output_type: 'document', output_id: 'd9' };
          },
        },
        {
          name: 'link',
          run: async () => {
            calls.push('link');
            return {};
          },
        },
      ],
    };
    registerRule('R3', handler);

    const declared = ['create_loan', 'create_voucher', 'execute_voucher', 'link'];
    const first = await executeRunSteps(makeRun(mergeStepRecords(declared, [])), rule, getRuleHandler('R3')!, view);

    expect(first).toBe('failed');
    expect(calls).toEqual([
      'create_loan:R3:d1:voucher.approved#create_loan',
      'create_voucher',
      'execute_voucher',
    ]);
    const afterFirst = lastSavedSteps();
    expect(afterFirst.find((s) => s.name === 'execute_voucher')).toMatchObject({ status: 'failed', error: 'Số dư không đủ' });
    expect(afterFirst.find((s) => s.name === 'link')?.status).toBe('pending');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ alert_type: 'automation_run_failed', to_roles: ['chief_accountant'], company_id: 'c1' });
    expect(String(alerts[0]?.dedupe_key)).toBe('automation_run_failed:run1:1');

    // Chạy lại sau khi sửa nguyên nhân: bước xong không chạy lại; chỉ chạy execute_voucher và link.
    failExecute = false;
    const second = await executeRunSteps(makeRun(afterFirst), rule, getRuleHandler('R3')!, view);

    expect(second).toBe('done');
    expect(calls).toEqual([
      'create_loan:R3:d1:voucher.approved#create_loan',
      'create_voucher',
      'execute_voucher',
      'execute_voucher',
      'link',
    ]);
    expect(lastSavedSteps().every((s) => s.status === 'done')).toBe(true);
    expect(alerts).toHaveLength(1);
  });

  it('bước trả về skipped được ghi nhận và không chạy lại', async () => {
    const calls: string[] = [];
    registerRule('R5', {
      steps: [
        {
          name: 'create_voucher',
          run: async () => {
            calls.push('create_voucher');
            return { skipped: true };
          },
        },
      ],
    });
    const status = await executeRunSteps(makeRun(mergeStepRecords(['create_voucher'], [])), { code: 'R5' }, getRuleHandler('R5')!, view);
    expect(status).toBe('done');
    expect(lastSavedSteps()[0]?.status).toBe('skipped');
    expect(calls).toHaveLength(1);
  });
});

describe('automation › nguyên nhân lỗi của bước (ApiError)', () => {
  /** Chạy một bước ném `err` rồi trả về `error` đã ghi vào bước. */
  async function savedErrorOf(err: unknown): Promise<string | null> {
    registerRule('R3', {
      steps: [
        {
          name: 'create_voucher',
          run: async () => {
            throw err;
          },
        },
      ],
    });
    const status = await executeRunSteps(makeRun(mergeStepRecords(['create_voucher'], [])), rule, getRuleHandler('R3')!, view);
    expect(status).toBe('failed');
    return lastSavedSteps().find((s) => s.name === 'create_voucher')?.error ?? null;
  }

  it('lỗi có errors: ghi nguyên nhân (không chỉ tiêu đề "Dữ liệu không hợp lệ"), cảnh báo KTT cũng mang nguyên nhân', async () => {
    const cause = 'Tài khoản không tồn tại hoặc đã đóng/phong tỏa';
    expect(await savedErrorOf(new ApiError({ code: 'FG-VAL-001', errors: { 'source.account_id': cause } }))).toBe(cause);

    const subject = alerts.at(-1)?.subject as { error?: string } | undefined;
    expect(subject?.error).toContain(cause);
  });

  it('có cả detail và errors: ghi cả hai, bỏ trùng; không có nguyên nhân thì giữ tiêu đề', async () => {
    const dup = 'Tài khoản không thuộc công ty của phiếu';
    expect(await savedErrorOf(new ApiError({ code: 'FG-RBAC-002', detail: dup, errors: { 'source.account_id': dup } }))).toBe(dup);
    expect(
      await savedErrorOf(
        new ApiError({
          code: 'FG-RBAC-002',
          detail: 'Không dùng được quỹ Tập đoàn cho phiếu công ty con',
          errors: { 'source.account_id': 'Tài khoản Tập đoàn — chỉ dùng cho phiếu cấp Tập đoàn' },
        }),
      ),
    ).toBe('Không dùng được quỹ Tập đoàn cho phiếu công ty con; Tài khoản Tập đoàn — chỉ dùng cho phiếu cấp Tập đoàn');
    expect(await savedErrorOf(new ApiError({ code: 'FG-VAL-001' }))).toBe('Dữ liệu không hợp lệ');
  });

  it('lỗi thường giữ nguyên thông điệp; thông điệp quá dài bị cắt còn 500 ký tự', async () => {
    expect(await savedErrorOf(new Error('Chưa có khoản vay để giải ngân'))).toBe('Chưa có khoản vay để giải ngân');
    const long = await savedErrorOf(new Error('x'.repeat(600)));
    expect(long).toHaveLength(500);
    expect(long?.endsWith('...')).toBe(true);
  });
});

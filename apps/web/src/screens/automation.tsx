/**
 * AUTO-01/02 — Quy trình tự động (v2/v2.md §11.2–11.3, §11.7 US-AUTO-05/07, §13 Quản trị).
 *
 * Ba tab (đường dẫn `/quantri/tu-dong?tab=rules|runs|links`):
 *  - Quy tắc: R1…R6, bật/tắt THEO CÔNG TY, tham số (kỳ hạn, lệch hạn thanh toán, thời điểm tạo khoản vay R2).
 *    Sửa cần `automation:config` (Chủ tịch, Admin); người khác chỉ xem.
 *  - Lượt chạy: lọc trạng thái / quy tắc / công ty; chi tiết từng bước và đối tượng đã sinh.
 *    Chạy lại lượt lỗi: kế toán trưởng hoặc `automation:config`; chỉ chạy các bước chưa xong.
 *  - Loại liên kết (chỉ đọc): quan hệ, từ → đến, điều kiện hiệu lực, ràng buộc khi gán (v2 §11.2).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Switch } from 'antd';
import dayjs from 'dayjs';
import {
  AUTOMATION_RULE_CODES,
  AUTOMATION_RULE_LABEL,
  AUTOMATION_RUN_STATUSES,
  AUTOMATION_RUN_STATUS_REGISTRY,
  AUTOMATION_STEP_STATUS_LABEL,
  BUSINESS_LINK_RELATIONS,
  BUSINESS_LINK_RELATION_LABEL,
  LINK_OBJECT_TYPE_LABEL,
  LINK_ORIGIN_LABEL,
  LINK_STATUS_LABEL,
  type BusinessLinkRelation,
} from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useCompanies } from '../app/queries.ts';
import { SCOPE_ALL, useAuth, useCurrentCompanyId } from '../app/store.tsx';
import {
  AUTOMATION_EVENT_LABEL,
  AUTOMATION_STEP_LABEL,
  RULE_PARAM_FIELDS,
  automationAccess,
  configurableRule,
  useAutomationRuns,
  useAutomationRules,
  useRerunAutomationRun,
  useUpdateAutomationRule,
  type AutomationOverride,
  type AutomationRule,
  type AutomationRun,
  type RuleParamField,
} from '../app/v2/exec.ts';
import { FgAlert, FgButton, FgField, FgInput, FgSelect, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgDrawer, FgEmptyState, FgModal, FgSkeletonTable, FgTable, FgTabs, FgTag } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, toastOk, useToast } from '../components/pagekit.tsx';
import { AdminNav } from './admin.tsx';

type Access = ReturnType<typeof automationAccess>;
type TabKey = 'rules' | 'runs' | 'links';

const TAB_ITEMS: { key: TabKey; label: string }[] = [
  { key: 'rules', label: 'Quy tắc' },
  { key: 'runs', label: 'Lượt chạy' },
  { key: 'links', label: 'Loại liên kết' },
];

const errText = (e: unknown, fallback: string): string => (e instanceof ApiRequestError ? (e.problem.detail ?? e.problem.title) : fallback);
const dateTimeOf = (iso: string | null | undefined): string => (iso && dayjs(iso).isValid() ? dayjs(iso).format('DD/MM/YYYY HH:mm') : '—');

/** Tóm tắt tham số để hiện trong bảng (ví dụ "12 tháng vay · hạn +11 tháng · tạo khi lưu"). */
function summarizeParams(code: string, p: Record<string, unknown>): string {
  if (!configurableRule(code)) return '—';
  const parts: string[] = [];
  if (p.term_months !== undefined) parts.push(`${String(p.term_months)} tháng vay`);
  if (p.due_offset_months !== undefined) parts.push(`hạn +${String(p.due_offset_months)} tháng`);
  if (p.r2_create_at !== undefined) parts.push(p.r2_create_at === 'approve' ? 'tạo khi duyệt' : 'tạo khi lưu');
  return parts.join(' · ') || 'mặc định';
}

export function AutomationScreen(): ReactNode {
  const { can, me } = useAuth();
  const access = automationAccess(can, me?.entitlements.role);
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: TabKey = requested === 'runs' || requested === 'links' ? requested : params.get('status') ? 'runs' : 'rules';
  const setTab = (key: string): void => {
    const p = new URLSearchParams(params);
    p.set('tab', key);
    if (key !== 'runs') p.delete('status');
    setParams(p, { replace: true });
  };

  if (!access.view) {
    return (
      <>
        <AdminNav />
        <FgEmptyState glyph="⚿" title="Không có quyền xem quy trình tự động" description="Cần quyền cấu hình tự động hoặc vai trò kế toán trưởng." />
      </>
    );
  }

  return (
    <>
      <AdminNav />
      <FgPageHeader title="Quy trình tự động" meta="Quy tắc R1–R6 theo công ty · lượt chạy và đối tượng đã sinh · loại liên kết nghiệp vụ (v2 §11)" />
      <div style={{ marginBottom: 'var(--fg-space-4)' }}>
        <FgTabs activeKey={tab} onChange={setTab} items={TAB_ITEMS} />
      </div>
      {tab === 'rules' ? <RulesTab access={access} /> : tab === 'runs' ? <RunsTab access={access} /> : <LinkTypesTab />}
    </>
  );
}

/* ================= Tab 1 · Quy tắc ================= */

function RulesTab({ access }: { access: Access }): ReactNode {
  const companies = useCompanies();
  const currentCompanyId = useCurrentCompanyId();
  const { scope } = useAuth();
  /** Công tắc tổng và tham số mặc định chỉ đổi được khi xem TẤT CẢ công ty (server kiểm phạm vi). */
  const globalScope = scope === SCOPE_ALL;
  const { message } = useToast();
  const companyList = companies.data?.items ?? [];
  const [pick, setPick] = useState<string | null>(null);
  const companyId = pick ?? currentCompanyId ?? companyList[0]?._id ?? null;
  const companyName = companyList.find((c) => c._id === companyId)?.name ?? '';
  const rules = useAutomationRules(companyId);
  const update = useUpdateAutomationRule();
  const [editing, setEditing] = useState<AutomationRule | null>(null);
  const [globalChange, setGlobalChange] = useState<{ rule: AutomationRule; enabled: boolean } | null>(null);

  /** Ghi đè của công ty đang chọn. PATCH thay TOÀN BỘ danh sách ghi đè nên phải gửi lại các công ty khác. */
  const saveOverride = (rule: AutomationRule, change: { enabled?: boolean; params?: Record<string, unknown> }): void => {
    if (!companyId) return;
    const current = rule.company_overrides.find((o) => o.company_id === companyId);
    const entry: AutomationOverride = {
      company_id: companyId,
      enabled: change.enabled ?? current?.enabled ?? true,
      params: change.params ?? current?.params ?? {},
    };
    const others = rule.company_overrides.filter((o) => o.company_id !== companyId);
    // if_updated_at: server từ chối nếu quy tắc đã được người khác sửa sau khi màn hình tải (không ghi đè mất cập nhật)
    update.mutate(
      { id: rule._id, body: { company_overrides: [...others, entry], if_updated_at: rule.updated_at } },
      {
        onSuccess: () => {
          setEditing(null);
          toastOk(`Đã lưu ${rule.code} cho ${companyName || 'công ty'}`);
        },
        onError: (e) => message.error(errText(e, 'Không lưu được cấu hình quy tắc')),
      },
    );
  };

  const confirmGlobal = (): void => {
    if (!globalChange) return;
    const { rule, enabled } = globalChange;
    update.mutate(
      { id: rule._id, body: { enabled, if_updated_at: rule.updated_at } },
      {
        onSuccess: () => {
          setGlobalChange(null);
          toastOk(enabled ? `Đã bật ${rule.code} toàn hệ thống` : `Đã tắt ${rule.code} toàn hệ thống`);
        },
        onError: (e) => {
          setGlobalChange(null);
          message.error(errText(e, 'Không đổi được công tắc tổng'));
        },
      },
    );
  };

  return (
    <>
      <div className="fg-filterbar" style={{ alignItems: 'flex-end' }}>
        <div style={{ minWidth: 320 }}>
          <FgField label="Công ty áp dụng" help="Bật/tắt và tham số được cấu hình theo từng công ty.">
            <FgSelect
              options={companyList.map((c) => ({ value: c._id, label: `${c.code} · ${c.name}` }))}
              value={companyId ?? undefined}
              onChange={(v) => setPick(v ?? null)}
              style={{ width: '100%' }}
              ariaLabel="Công ty áp dụng quy tắc"
            />
          </FgField>
        </div>
        {!access.configure ? <FgText style="caption" color="muted">Chỉ xem — cần quyền cấu hình quy trình tự động để sửa.</FgText> : null}
      </div>

      <FgQuery query={rules} skeleton={<FgSkeletonTable rows={6} cols={5} />}>
        {(list) => (
          <div className="fg-card" style={{ padding: 0 }}>
            <FgTable<AutomationRule>
              rowKey="_id"
              dataSource={list}
              pagination={false}
              columns={[
                {
                  title: 'Quy tắc',
                  key: 'rule',
                  render: (_v, r) => (
                    <div style={{ minWidth: 0 }}>
                      <FgText strong>{r.code}</FgText> <FgText style="bodyS">{r.name || AUTOMATION_RULE_LABEL[r.code]}</FgText>
                      <br />
                      <FgText style="caption" color="muted">
                        Các bước: {r.steps.map((s) => AUTOMATION_STEP_LABEL[s] ?? s).join(' → ') || '—'}
                      </FgText>
                      {!r.handler_registered ? (
                        <>
                          <br />
                          <FgText style="caption" color="danger">
                            Chưa có bộ xử lý trong tiến trình — quy tắc bị bỏ qua
                          </FgText>
                        </>
                      ) : null}
                    </div>
                  ),
                },
                {
                  title: 'Kích hoạt khi',
                  key: 'trigger',
                  render: (_v, r) => {
                    const events = [...new Set([r.trigger_event, ...r.trigger_events])].filter(Boolean);
                    return (
                      <div>
                        <FgText style="bodyS">{events.map((e) => AUTOMATION_EVENT_LABEL[e] ?? e).join(' · ') || '—'}</FgText>
                        <br />
                        <FgText style="caption" color="muted">
                          {r.company_ids.length ? `Phạm vi: ${r.company_ids.length} công ty` : 'Phạm vi: mọi công ty'}
                        </FgText>
                      </div>
                    );
                  },
                },
                {
                  title: companyName ? `Tại ${companyName}` : 'Tại công ty',
                  key: 'eff',
                  render: (_v, r) => {
                    const outOfScope = !!companyId && r.company_ids.length > 0 && !r.company_ids.includes(companyId);
                    const on = !!r.effective?.enabled;
                    return (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <Switch
                          size="small"
                          checked={on}
                          disabled={!access.configure || !companyId || !r.enabled || outOfScope}
                          onChange={(v) => saveOverride(r, { enabled: v })}
                          aria-label={`Bật ${r.code} cho ${companyName || 'công ty'}`}
                        />
                        <FgTag tone={on ? 'success' : 'neutral'}>
                          {!r.enabled ? 'Tắt toàn hệ thống' : outOfScope ? 'Ngoài phạm vi' : on ? 'Đang bật' : 'Đang tắt'}
                        </FgTag>
                      </span>
                    );
                  },
                },
                {
                  title: 'Tham số',
                  key: 'params',
                  render: (_v, r) => (
                    <div>
                      <FgText style="caption">{summarizeParams(r.code, r.effective?.params ?? r.params)}</FgText>
                      {access.configure && configurableRule(r.code) && companyId ? (
                        <>
                          <br />
                          <FgButton size="small" onClick={() => setEditing(r)} disabled={!r.effective}>
                            Sửa tham số
                          </FgButton>
                        </>
                      ) : null}
                    </div>
                  ),
                },
                {
                  title: 'Toàn hệ thống',
                  key: 'global',
                  render: (_v, r) =>
                    access.configure && globalScope ? (
                      <FgButton size="small" onClick={() => setGlobalChange({ rule: r, enabled: !r.enabled })}>
                        {r.enabled ? 'Tắt toàn hệ thống' : 'Bật toàn hệ thống'}
                      </FgButton>
                    ) : access.configure ? (
                      <FgText style="caption" color="muted">
                        {r.enabled ? 'Đang bật' : 'Đang tắt'} · đổi ở chế độ "Tất cả công ty"
                      </FgText>
                    ) : (
                      <FgText style="caption" color="muted">
                        {r.enabled ? 'Đang bật' : 'Đang tắt'}
                      </FgText>
                    ),
                },
              ]}
            />
          </div>
        )}
      </FgQuery>

      <div style={{ marginTop: 'var(--fg-space-3)' }}>
        <FgText style="caption" color="muted">
          Tắt "toàn hệ thống" thì quy tắc không chạy ở bất kỳ công ty nào. Tham số chỉ áp dụng cho khoản vay được tạo từ lúc lưu; khoản đã tạo giữ nguyên.
        </FgText>
      </div>

      <RuleParamsModal
        rule={editing}
        companyName={companyName}
        busy={update.isPending}
        onClose={() => setEditing(null)}
        onSave={(p) => editing && saveOverride(editing, { params: p })}
      />

      <FgModal
        open={!!globalChange}
        title={globalChange?.enabled ? 'Bật quy tắc toàn hệ thống?' : 'Tắt quy tắc toàn hệ thống?'}
        onCancel={() => setGlobalChange(null)}
        onOk={confirmGlobal}
        okText={globalChange?.enabled ? 'Bật' : 'Tắt'}
        danger={!globalChange?.enabled}
        confirmLoading={update.isPending}
        width={480}
      >
        <FgText>
          {globalChange ? `${globalChange.rule.code} · ${globalChange.rule.name || AUTOMATION_RULE_LABEL[globalChange.rule.code]}` : ''}
        </FgText>
        <br />
        <FgText style="caption" color="muted">
          Công tắc tổng áp dụng cho mọi công ty. Lượt đang lỗi không tự chạy lại — dùng nút "Chạy lại" ở tab Lượt chạy.
        </FgText>
      </FgModal>
    </>
  );
}

/** Sửa tham số của MỘT quy tắc cho công ty đang chọn (ghi đè theo công ty). */
function RuleParamsModal({
  rule,
  companyName,
  busy,
  onClose,
  onSave,
}: {
  rule: AutomationRule | null;
  companyName: string;
  busy: boolean;
  onClose: () => void;
  onSave: (params: Record<string, unknown>) => void;
}): ReactNode {
  const fields: RuleParamField[] = rule ? (RULE_PARAM_FIELDS[rule.code] ?? []) : [];
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rule) return;
    const init: Record<string, string> = {};
    for (const f of RULE_PARAM_FIELDS[rule.code] ?? []) init[f.key] = String(rule.effective?.params[f.key] ?? '');
    setValues(init);
    setError(null);
  }, [rule]);

  const submit = (): void => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = (values[f.key] ?? '').trim();
      if (f.kind === 'int') {
        const n = Number(raw);
        if (raw === '' || !Number.isInteger(n) || n < (f.min ?? 0) || n > (f.max ?? Number.MAX_SAFE_INTEGER)) {
          setError(`${f.label}: nhập số nguyên từ ${f.min ?? 0} đến ${f.max ?? '—'}`);
          return;
        }
        out[f.key] = n;
      } else {
        out[f.key] = raw;
      }
    }
    setError(null);
    onSave(out);
  };

  return (
    <FgModal
      open={!!rule}
      title={rule ? `Tham số ${rule.code} · ${companyName || 'công ty'}` : ''}
      onCancel={onClose}
      onOk={submit}
      okText="Lưu cho công ty"
      confirmLoading={busy}
      width={560}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)', paddingTop: 8 }}>
        {fields.map((f) => (
          <FgField key={f.key} label={f.label} help={f.hint}>
            {f.kind === 'int' ? (
              <FgInput
                type="number"
                min={f.min}
                max={f.max}
                step={1}
                value={values[f.key] ?? ''}
                onChange={(e: { target: { value: string } }) => setValues((prev) => ({ ...prev, [f.key]: e.target.value }))}
              />
            ) : (
              <FgSelect
                options={f.options ?? []}
                value={values[f.key] ?? ''}
                onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v ?? '' }))}
                style={{ width: '100%' }}
              />
            )}
          </FgField>
        ))}
        {error ? <FgAlert tone="danger" title={error} /> : null}
      </div>
    </FgModal>
  );
}

/* ================= Tab 2 · Lượt chạy ================= */

function RunsTab({ access }: { access: Access }): ReactNode {
  const [params] = useSearchParams();
  const companies = useCompanies();
  const { message } = useToast();
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [ruleCode, setRuleCode] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [openRun, setOpenRun] = useState<AutomationRun | null>(null);
  const [confirmRun, setConfirmRun] = useState<AutomationRun | null>(null);
  const runs = useAutomationRuns({
    status: status || undefined,
    rule_code: ruleCode || undefined,
    company_id: companyId || undefined,
    limit: 100,
  });
  const rerun = useRerunAutomationRun();

  const doRerun = (run: AutomationRun): void => {
    rerun.mutate(run._id, {
      onSuccess: (view) => {
        setConfirmRun(null);
        setOpenRun(view ?? null);
        toastOk(view?.status === 'done' ? 'Chạy lại xong: lượt đã hoàn tất' : 'Đã chạy lại lượt');
      },
      onError: (e) => {
        setConfirmRun(null);
        message.error(errText(e, 'Không chạy lại được lượt này'));
      },
    });
  };

  return (
    <>
      <div className="fg-filterbar" style={{ alignItems: 'flex-end' }}>
        <div style={{ minWidth: 200 }}>
          <FgField label="Trạng thái">
            <FgSelect
              options={[{ value: '', label: 'Tất cả' }, ...AUTOMATION_RUN_STATUSES.map((s) => ({ value: s, label: AUTOMATION_RUN_STATUS_REGISTRY[s].labelVi }))]}
              value={status}
              onChange={(v) => setStatus(v ?? '')}
              style={{ width: '100%' }}
            />
          </FgField>
        </div>
        <div style={{ minWidth: 260 }}>
          <FgField label="Quy tắc">
            <FgSelect
              options={[{ value: '', label: 'Tất cả quy tắc' }, ...AUTOMATION_RULE_CODES.map((c) => ({ value: c, label: `${c} · ${AUTOMATION_RULE_LABEL[c]}` }))]}
              value={ruleCode}
              onChange={(v) => setRuleCode(v ?? '')}
              style={{ width: '100%' }}
            />
          </FgField>
        </div>
        <div style={{ minWidth: 240 }}>
          <FgField label="Công ty">
            <FgSelect
              options={[{ value: '', label: 'Tất cả trong phạm vi' }, ...(companies.data?.items ?? []).map((c) => ({ value: c._id, label: `${c.code} · ${c.name}` }))]}
              value={companyId}
              onChange={(v) => setCompanyId(v ?? '')}
              style={{ width: '100%' }}
            />
          </FgField>
        </div>
      </div>

      <FgQuery query={runs} skeleton={<FgSkeletonTable rows={6} cols={6} />}>
        {(list) =>
          !list.length ? (
            <div className="fg-card">
              <FgEmptyState glyph="↻" title="Chưa có lượt chạy" description="Lượt chạy xuất hiện khi có sự kiện nghiệp vụ khớp một quy tắc đang bật." />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable<AutomationRun>
                rowKey="_id"
                dataSource={list}
                pagination={list.length > 25 ? { pageSize: 25, size: 'small' } : false}
                columns={[
                  { title: 'Thời điểm', dataIndex: 'created_at', key: 'at', render: (v: string) => <span className="fg-num">{dateTimeOf(v)}</span> },
                  {
                    title: 'Quy tắc',
                    key: 'rule',
                    render: (_v, r) => (
                      <div>
                        <FgText strong>{r.rule_code}</FgText>
                        <br />
                        <FgText style="caption" color="muted">
                          {r.rule_name}
                        </FgText>
                      </div>
                    ),
                  },
                  { title: 'Sự kiện', dataIndex: 'event_type', key: 'ev', render: (v: string) => <FgText style="bodyS">{AUTOMATION_EVENT_LABEL[v] ?? v}</FgText> },
                  {
                    title: 'Nguồn',
                    key: 'src',
                    render: (_v, r) => (
                      <FgText style="caption" color="muted">
                        {r.source_type === 'document' ? 'Phiếu' : 'Khoản vay'} <span className="fg-mono">…{r.source_id.slice(-6)}</span>
                      </FgText>
                    ),
                  },
                  {
                    title: 'Trạng thái',
                    key: 'st',
                    render: (_v, r) => {
                      const def = AUTOMATION_RUN_STATUS_REGISTRY[r.status];
                      return <FgTag tone={def.tone}>{def.labelVi}</FgTag>;
                    },
                  },
                  {
                    title: 'Bước',
                    key: 'steps',
                    render: (_v, r) => {
                      const done = r.steps.filter((s) => s.status === 'done').length;
                      const skipped = r.steps.filter((s) => s.status === 'skipped').length;
                      return (
                        <FgText style="caption">
                          {done}/{r.steps.length - skipped} xong
                          {skipped ? ` · ${skipped} bỏ qua` : ''}
                        </FgText>
                      );
                    },
                  },
                  {
                    title: 'Lỗi',
                    key: 'err',
                    render: (_v, r) =>
                      r.error ? (
                        <FgText style="caption" color="danger">
                          {r.error.length > 90 ? `${r.error.slice(0, 90)}…` : r.error}
                        </FgText>
                      ) : (
                        <FgText style="caption" color="muted">
                          —
                        </FgText>
                      ),
                  },
                  {
                    title: '',
                    key: 'act',
                    render: (_v, r) => (
                      <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                        <FgButton size="small" onClick={() => setOpenRun(r)}>
                          Chi tiết
                        </FgButton>
                        {access.rerun && r.status === 'failed' ? (
                          <FgButton size="small" variant="primary" onClick={() => setConfirmRun(r)}>
                            Chạy lại
                          </FgButton>
                        ) : null}
                      </span>
                    ),
                  },
                ]}
              />
            </div>
          )
        }
      </FgQuery>

      <RunDrawer run={openRun} canRerun={access.rerun} onClose={() => setOpenRun(null)} onRerun={(r) => setConfirmRun(r)} />

      <FgModal
        open={!!confirmRun}
        title="Chạy lại lượt tự động?"
        onCancel={() => setConfirmRun(null)}
        onOk={() => confirmRun && doRerun(confirmRun)}
        okText="Chạy lại"
        confirmLoading={rerun.isPending}
        width={480}
      >
        <FgText>{confirmRun ? `${confirmRun.rule_code} · ${confirmRun.rule_name}` : ''}</FgText>
        <br />
        <FgText style="caption" color="muted">
          Chỉ các bước chưa xong được thực hiện lại; bước đã xong không tạo thêm đối tượng. Phiếu và khoản vay đã sinh giữ nguyên.
        </FgText>
      </FgModal>
    </>
  );
}

const stepTone = (s: string): string => (s === 'done' ? 'success' : s === 'failed' ? 'danger' : 'neutral');

/** Chi tiết một lượt: trạng thái, lỗi, từng bước và đối tượng đã sinh (có liên kết tới hồ sơ). */
function RunDrawer({ run, canRerun, onClose, onRerun }: { run: AutomationRun | null; canRerun: boolean; onClose: () => void; onRerun: (r: AutomationRun) => void }): ReactNode {
  const def = run ? AUTOMATION_RUN_STATUS_REGISTRY[run.status] : null;
  return (
    <FgDrawer
      open={!!run}
      title={run ? `${run.rule_code} · ${run.rule_name}` : ''}
      onClose={onClose}
      width={640}
      extra={run && canRerun && run.status === 'failed' ? <FgButton variant="primary" onClick={() => onRerun(run)}>Chạy lại</FgButton> : null}
    >
      {run && def ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
            <FgTag tone={def.tone}>{def.labelVi}</FgTag>
            <FgText style="caption" color="muted">
              Sự kiện: {AUTOMATION_EVENT_LABEL[run.event_type] ?? run.event_type}
            </FgText>
            <FgText style="caption" color="muted">
              Bắt đầu {dateTimeOf(run.created_at)} · cập nhật {dateTimeOf(run.updated_at)} · lần thử {run.attempts}
            </FgText>
          </div>
          {run.error ? <FgAlert tone="danger" title="Lượt chạy lỗi" description={run.error} /> : null}
          {run.generated.length ? (
            <FgCard title="Đối tượng đã sinh">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {run.generated.map((g) => (
                  <div key={`${g.type}-${g.id}`} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <FgText style="bodyS" strong>
                      {g.code ?? g.id}
                    </FgText>
                    <FgText style="caption" color="muted">
                      {g.type === 'document' ? 'Phiếu' : 'Khoản vay'}
                      {g.status ? ` · ${g.status}` : ''}
                    </FgText>
                    <span style={{ flex: 1 }} />
                    {g.href ? (
                      <Link to={g.href} className="fg-link">
                        Mở
                      </Link>
                    ) : null}
                  </div>
                ))}
              </div>
            </FgCard>
          ) : null}
          <FgCard title="Các bước">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {run.steps.map((s, i) => (
                <div key={`${s.name}-${i}`} className="fg-stat-row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <FgText strong>
                      {i + 1}. {AUTOMATION_STEP_LABEL[s.name] ?? s.name}
                    </FgText>
                    <br />
                    <FgText style="caption" color="muted">
                      {s.at ? dateTimeOf(s.at) : 'chưa chạy'}
                    </FgText>
                    {s.error ? (
                      <>
                        <br />
                        <FgText style="caption" color="danger">
                          {s.error}
                        </FgText>
                      </>
                    ) : null}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <FgTag tone={stepTone(s.status)}>{AUTOMATION_STEP_STATUS_LABEL[s.status]}</FgTag>
                    {s.output ? (
                      s.output.href ? (
                        <Link to={s.output.href} className="fg-link" style={{ fontSize: 12 }}>
                          {s.output.code ?? s.output.id}
                        </Link>
                      ) : (
                        <FgText style="caption">{s.output.code ?? s.output.id}</FgText>
                      )
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </FgCard>
          <FgText style="caption" color="muted">
            Khoá lượt: <span className="fg-mono">{run.idem_key}</span>
          </FgText>
        </div>
      ) : null}
    </FgDrawer>
  );
}

/* ================= Tab 3 · Loại liên kết (chỉ đọc) ================= */

/** Mô tả quan hệ theo v2 §11.2 và ràng buộc kiểm khi gán (domain/links: RELATION_SPECS). */
const RELATION_ROWS: Record<BusinessLinkRelation, { from: string; to: string; when: string; rules: string[] }> = {
  offset: {
    from: 'Phiếu thu / chi',
    to: 'Khoản công nợ',
    when: 'Phiếu đã thực thi',
    rules: ['Cùng đối tác với khoản công nợ', 'Đối tác của khoản là khách hàng hoặc nhà cung cấp', 'Cùng công ty', 'Có số tiền; tổng cấn trừ không vượt giá trị khoản'],
  },
  repayment: {
    from: 'Phiếu chi',
    to: 'Khoản nợ ngân hàng',
    when: 'Phiếu đã thực thi',
    rules: ['Đối tác phiếu và khoản vay đều là ngân hàng, khớp nhau', 'Cùng công ty', 'Có số tiền; có thể tách gốc / lãi / phí', 'Tổng gốc trả không vượt gốc khoản vay'],
  },
  disbursement: {
    from: 'Phiếu thu',
    to: 'Khoản nợ ngân hàng',
    when: 'Phiếu đã thực thi ⇒ khoản vay chuyển "Đang vay"',
    rules: ['Đối tác phiếu là ngân hàng, khớp khoản vay', 'Cùng công ty', 'Có số tiền; tổng giải ngân không vượt gốc'],
  },
  funded_by: {
    from: 'Phiếu chi',
    to: 'Khoản nợ ngân hàng',
    when: 'Ngay khi tạo',
    rules: ['Ngân hàng cho vay là đối tác loại Ngân hàng', 'Không yêu cầu khớp đối tác với phiếu chi', 'Cùng công ty', 'Có số tiền'],
  },
  generated: {
    from: 'Đối tượng nguồn (phiếu, công nợ, khoản vay)',
    to: 'Đối tượng tự sinh (phiếu, khoản vay, công nợ)',
    when: 'Ngay khi tạo',
    rules: ['Cùng công ty', 'Không có số tiền'],
  },
  internal_transfer: {
    from: 'Phiếu chi (công ty A)',
    to: 'Phiếu thu (công ty B)',
    when: 'Phiếu chi đã thực thi',
    rules: ['Khác công ty', 'Phiếu chi → phiếu thu', 'Không có số tiền', 'Báo cáo thu–chi loại trừ cặp này khỏi doanh thu / chi phí'],
  },
};

function LinkTypesTab(): ReactNode {
  return (
    <>
      <FgCard title="Loại liên kết nghiệp vụ" padded={false} style={{ marginBottom: 'var(--fg-space-4)' }}>
        <FgTable<{ relation: BusinessLinkRelation }>
          rowKey="relation"
          size="small"
          mobileCards={false}
          pagination={false}
          dataSource={BUSINESS_LINK_RELATIONS.map((relation) => ({ relation }))}
          columns={[
            {
              title: 'Quan hệ',
              key: 'rel',
              render: (_v, r) => (
                <div>
                  <FgText strong>{BUSINESS_LINK_RELATION_LABEL[r.relation]}</FgText>
                  <br />
                  <span className="fg-mono" style={{ fontSize: 12, color: 'var(--fg-text-muted)' }}>
                    {r.relation}
                  </span>
                </div>
              ),
            },
            {
              title: 'Từ → đến',
              key: 'ft',
              render: (_v, r) => (
                <FgText style="bodyS">
                  {RELATION_ROWS[r.relation].from} → {RELATION_ROWS[r.relation].to}
                </FgText>
              ),
            },
            { title: 'Có hiệu lực khi', key: 'when', render: (_v, r) => <FgText style="bodyS">{RELATION_ROWS[r.relation].when}</FgText> },
            {
              title: 'Ràng buộc khi gán',
              key: 'rules',
              render: (_v, r) => (
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                  {RELATION_ROWS[r.relation].rules.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ),
            },
          ]}
        />
      </FgCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 'var(--fg-space-4)' }}>
        <FgCard title="Đối tượng ở hai đầu">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            {(['document', 'debt_voucher', 'bank_debt'] as const).map((t) => (
              <li key={t}>{LINK_OBJECT_TYPE_LABEL[t]}</li>
            ))}
          </ul>
        </FgCard>
        <FgCard title="Nguồn và trạng thái">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            <li>
              Nguồn: {LINK_ORIGIN_LABEL.manual} (người gán) / {LINK_ORIGIN_LABEL.automation} (lượt chạy nào)
            </li>
            <li>
              Trạng thái: {LINK_STATUS_LABEL.active} / {LINK_STATUS_LABEL.removed} — gỡ là đánh dấu (có người gỡ và lý do), không xoá
            </li>
          </ul>
        </FgCard>
        <FgCard title="Quy tắc chung">
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
            <li>Gán thủ công hay tự động đều kiểm: đối tác khớp và đúng loại; tổng phân bổ không vượt số tiền phiếu / giá trị khoản.</li>
            <li>Không tạo trùng cùng cặp và cùng quan hệ khi đang hiệu lực.</li>
            <li>"Đã cấn trừ", "đã trả", "dư nợ" tính từ liên kết hiệu lực và trạng thái phiếu, không lưu cứng.</li>
          </ul>
        </FgCard>
      </div>
    </>
  );
}

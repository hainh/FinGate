/**
 * RPT-00 Thư viện báo cáo · RPT-01→13 — 1 khung REPORT RUNNER (arch §12.5, handoff §6).
 *
 * Server trả `columns[].type` quyết định cách render — KHÔNG design 14 layout.
 * KPI + chart + bảng + export cùng số liệu (một nguồn format — shared).
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { downloadFile } from '../app/api.ts';
import { useReport, useReportPresets } from '../app/queries.ts';
import { useAuth } from '../app/store.tsx';
import { FgAlert, FgButton, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgSkeletonTable, FgTable, renderCellByType } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
import type { ReportResult } from '../app/types.ts';

export function ReportLibraryScreen(): ReactNode {
  const query = useReportPresets();
  const { can } = useAuth();
  return (
    <>
      <FgPageHeader title="Báo cáo" meta="Mẫu báo cáo dựng sẵn — cùng số liệu với bản tin và dashboard" />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={3} cols={3} />}>
        {(data) => {
          const presets = data.presets ?? data.items ?? [];
          return (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))', gap: 'var(--fg-space-4)' }}>
              {presets.map((p) => (
                <Link key={p.preset} to={`/baocao/${p.preset}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <FgCard className="fg-kpi" style={{ height: '100%' }}>
                    <FgText style="h4">{p.label}</FgText>
                    <FgText style="caption" color="muted">
                      {p.exportable && can('report:export') ? 'Excel · PDF' : 'Chỉ xem'}
                    </FgText>
                  </FgCard>
                </Link>
              ))}
            </div>
          );
        }}
      </FgQuery>
    </>
  );
}

/** runner chung cho MỌI preset. */
export function ReportRunnerScreen(): ReactNode {
  const { preset } = useParams<{ preset: string }>();
  const { can } = useAuth();
  const { message } = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = useReport(preset, { from: from || undefined, to: to || undefined });

  return (
    <>
      <FgPageHeader
        title="Báo cáo"
        meta={query.data ? `${query.data.title} · ${query.data.scope_label} · số liệu lúc ${new Date(query.data.as_of).toLocaleString('vi-VN')}` : undefined}
        actions={
          <FgButton
            variant="primary"
            disabled={!can('report:export')}
            onClick={async () => {
              try {
                await downloadFile('/exports', { preset, query: { from: from || undefined, to: to || undefined } }, `${preset}.xlsx`);
                message.success('Đang tải Excel…');
              } catch {
                message.error('Không xuất được — thử lại hoặc thu hẹp phạm vi');
              }
            }}
          >
            ⤓ Xuất Excel{can('report:export') ? '' : ' (không có quyền)'}
          </FgButton>
        }
      />
      {!can('report:export') ? (
        <FgAlert
          tone="neutral"
          title="Nút Xuất Excel bị ẩn vì bạn không có quyền report:export"
          description="Ẩn ở đây chỉ là mỹ thuật — server đã chặn trước đó."
          style={{ marginBottom: 'var(--fg-space-4)' }}
        />
      ) : null}

      <div className="fg-filterbar">
        <FgInputDate value={from} onChange={setFrom} label="Từ ngày" />
        <FgInputDate value={to} onChange={setTo} label="Đến ngày" />
        {(from || to) && (
          <FgButton size="small" variant="ghost" onClick={() => { setFrom(''); setTo(''); }}>
            Xóa lọc kỳ
          </FgButton>
        )}
      </div>

      <FgQuery query={query} skeleton={<FgSkeletonTable rows={10} cols={6} />}>
        {(r) => <ReportView r={r} />}
      </FgQuery>
    </>
  );
}

function FgInputDate({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }): ReactNode {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, color: 'var(--fg-text-muted)' }}>
      {label}
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ height: 34, padding: '0 8px', borderRadius: 'var(--fg-radius-md)', border: '1px solid var(--fg-border-default)', background: 'var(--fg-bg-surface)', color: 'var(--fg-text-primary)' }}
      />
    </label>
  );
}

export function ReportView({ r }: { r: ReportResult }): ReactNode {
  const columns = useMemo(
    () =>
      r.columns.map((c) => ({
        title: c.label,
        dataIndex: c.key,
        key: c.key,
        align: c.align === 'right' ? ('right' as const) : c.align === 'center' ? ('center' as const) : ('left' as const),
        sorter: c.sortable
          ? (a: Record<string, unknown>, b: Record<string, unknown>) => {
              const av = a[c.key];
              const bv = b[c.key];
              if (av && typeof av === 'object' && 'minor' in av) return Number(BigInt(String((av as { minor: string }).minor)) - BigInt(String((bv as { minor: string }).minor)));
              return String(av ?? '').localeCompare(String(bv ?? ''));
            }
          : undefined,
        render: (v: unknown, row: Record<string, unknown>) => renderCellByType(v, c.type as never, row),
      })),
    [r.columns],
  );

  return (
    <>
      {r.truncated ? <FgAlert tone="warning" title="Kết quả bị cắt — thu hẹp kỳ hoặc phạm vi để thấy đủ dòng" style={{ marginBottom: 'var(--fg-space-3)' }} /> : null}
      {r.kpi?.length ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
          {r.kpi.map((k) => (
            <FgCard key={k.label} className="fg-kpi">
              <FgText style="caption" color="muted">{k.label}</FgText>
              <div className="fg-kpi-value">{k.value}</div>
              {k.note ? <FgText style="caption" color="muted">{k.note}</FgText> : null}
            </FgCard>
          ))}
        </div>
      ) : null}
      {r.chart ? (
        <FgCard title={`${r.title} — biểu đồ`} style={{ marginBottom: 'var(--fg-space-4)' }}>
          <ReportChart r={r} />
        </FgCard>
      ) : null}
      <div className="fg-card" style={{ padding: 0 }}>
        <FgTable
          rowKey={(_row: unknown, i?: number) => String(i)}
          dataSource={r.rows as never[]}
          columns={columns as never}
          pagination={{ pageSize: 25, showSizeChanger: true, size: 'small' }}
        />
        <div style={{ padding: '8px 16px', borderTop: '1px solid var(--fg-border-subtle)', display: 'flex', justifyContent: 'space-between' }}>
          <FgText style="caption" color="muted">{r.row_count} dòng · phạm vi {r.scope_label}</FgText>
          <FgText style="caption" color="muted">Xuất lúc {new Date(r.as_of).toLocaleString('vi-VN')}{r.generated_by ? ` · ${r.generated_by}` : ''}</FgText>
        </div>
      </div>
    </>
  );
}

/** chart khai báo — cùng renderer cho mọi preset (bar/line/area/donut bằng SVG nhẹ). */
function ReportChart({ r }: { r: ReportResult }): ReactNode {
  const chart = r.chart!;
  const max = Math.max(1, ...chart.series.flatMap((s) => s.values.map((v) => Math.abs(v))));
  const n = chart.series[0]?.values.length ?? 0;
  if (!n) return null;
  if (chart.type === 'donut') {
    const total = chart.series[0].values.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    return (
      <div style={{ display: 'flex', gap: 'var(--fg-space-5)', alignItems: 'center', flexWrap: 'wrap' }}>
        <svg width="160" height="160" viewBox="0 0 42 42" role="img" aria-label={chart.series.map((s) => s.label).join(', ')}>
          {chart.series[0].values.slice(0, 4).map((v, i) => {
            const frac = v / total;
            const dash = frac * 40;
            const off = 25 - acc;
            acc += dash;
            return <circle key={i} cx="21" cy="21" r="15.915" fill="none" stroke={`var(--fg-chart-${(i % 10) + 1})`} strokeWidth="6" strokeDasharray={`${dash} ${40 - dash}`} strokeDashoffset={off} />;
          })}
        </svg>
        <div>
          {chart.series[0].values.slice(0, 4).map((v, i) => (
            <div key={i}>
              <FgText style="bodyS">
                <span style={{ display: 'inline-block', width: 10, height: 10, background: `var(--fg-chart-${(i % 10) + 1})`, borderRadius: 2, marginRight: 6 }} aria-hidden />
                {String(r.rows[i]?.[chart.x_key] ?? chart.series[0].label)}: <span className="fg-num">{v}</span>
              </FgText>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 160 }} role="img" aria-label="Biểu đồ báo cáo">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', gap: 1, alignItems: 'flex-end', height: '100%' }}>
          {chart.series.map((s, si) => {
            const v = s.values[i] ?? 0;
            const h = Math.max(2, Math.round((Math.abs(v) / max) * 150));
            return <div key={s.key} title={`${s.label}: ${v}`} style={{ flex: 1, height: h, background: `var(--fg-chart-${(si % 10) + 1})`, borderRadius: '2px 2px 0 0' }} />;
          })}
        </div>
      ))}
    </div>
  );
}

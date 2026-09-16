/**
 * DASH-01 — Dashboard tổng quan tài chính, 5 tầng (blueprint §XII/§XXVIII).
 *
 * Tầng 01 Exception · 02 KPI · 03 biểu đồ thu-chi · 04 đáo hạn + dòng tiền · 05 hàng chờ của tôi.
 * Số liệu 100% từ `/dashboard/overview` — FE zero logic tiền.
 */

import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { moneyFromWire } from '@fingate/shared';
import { useOverview, useReport, useRollovers } from '../app/queries.ts';
import { useAuth } from '../app/store.tsx';
import { FgButton, FgMoney, FgStatusChip, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSkeletonKpi, FgSkeletonTable } from '../components/uitk.tsx';
import { FgExceptionList, FgKpiCard, OwnerLine } from '../components/finance.tsx';
import { FgAlert } from '../components/primitives.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import { relativeTime } from '@fingate/shared';

/* chart tối giản bằng SVG — không kéo lib plots vào initial bundle (budget 350KB) */
function MiniBarChart({ chart }: { chart: NonNullable<import('../app/types.ts').ReportResult['chart']> }): ReactNode {
  const max = Math.max(1, ...chart.series.flatMap((s) => s.values.map((v) => Math.abs(v))));
  const n = chart.series[0]?.values.length ?? 0;
  if (!n) return <div style={{ padding: 'var(--fg-space-6)', textAlign: 'center', color: 'var(--fg-text-muted)', fontSize: 13 }}>Chưa có dữ liệu thu chi trong kỳ</div>;
  return (
    <div role="img" aria-label={`Biểu đồ ${chart.series.map((s) => s.label).join(', ')}`} style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 140 }}>
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', gap: 1, alignItems: 'stretch' }}>
          {chart.series.map((s, si) => {
            const v = s.values[i] ?? 0;
            const h = Math.round((Math.abs(v) / max) * 120);
            return (
              <div
                key={s.key}
                title={`${chart.x_key} ${i}: ${s.label} ${v} tỷ`}
                style={{ height: Math.max(2, h), background: `var(--fg-chart-${si + 1})`, opacity: v === 0 ? 0.15 : 1, borderRadius: 2 }}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function DashboardScreen(): ReactNode {
  const { me } = useAuth();
  const overview = useOverview();
  const report = useReport('thu-chi-ngay');
  const rollovers = useRollovers('30d');

  return (
    <FgQuery
      query={overview}
      skeleton={
        <>
          <div className="fg-card" style={{ minHeight: 120, marginBottom: 16 }} aria-busy="true" />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 16, marginBottom: 16 }}>
            {[0, 1, 2, 3].map((i) => (
              <FgSkeletonKpi key={i} />
            ))}
          </div>
          <FgSkeletonTable rows={5} cols={6} />
        </>
      }
    >
      {(ov) => {
        const kpis = ['cash_total', 'income_today', 'spend_today', 'awaiting_me'].map((k) => ov.kpi[k]).filter(Boolean);
        const staleLong = Date.now() - Date.parse(ov.generated_at) > 24 * 3600_000;
        return (
          <>
            <FgPageHeader
              title="Tổng quan dòng tiền"
              meta={
                <>
                  {ov.scope.all ? 'Toàn tập đoàn' : 'Theo công ty'} · Ngày nghiệp vụ {ov.business_date} · cập nhật {relativeTime(ov.generated_at)}
                </>
              }
              actions={
                <Link to="/cho-toi-duyet">
                  <FgButton variant="primary">Mở hàng chờ của tôi ({ov.counts.awaiting_me})</FgButton>
                </Link>
              }
            />

            {staleLong ? <FgAlert tone="attention" title={`Số liệu có thể cũ — cập nhật lúc ${new Date(ov.generated_at).toLocaleString('vi-VN')}`} /> : null}
            {ov.partial_companies?.length ? (
              <FgAlert
                tone="warning"
                title="Một phần dữ liệu chưa đồng bộ"
                description={`Chưa có số dư hôm nay: ${[...new Set(ov.partial_companies.map((p) => p.name))].join(', ')} — vào Ngân hàng → Nhập số dư (BANK-04) để cập nhật.`}
                action={
                  <Link to="/ngan-hang/so-du">
                    <FgButton size="small">Nhập số dư</FgButton>
                  </Link>
                }
              />
            ) : null}

            {/* tầng 01 — cần xử lý ngay */}
            <FgCard title={`Cần xử lý ngay${ov.exceptions.length ? ` (${ov.exceptions.length})` : ''}`} style={{ marginBottom: 'var(--fg-space-4)' }}>
              <FgExceptionList items={ov.exceptions.slice(0, 6)} />
              {ov.exceptions.length > 6 ? (
                <div style={{ marginTop: 8 }}>
                  <Link to="/can-xu-ly" className="fg-link">
                    Xem tất cả {ov.exceptions.length} mục
                  </Link>
                </div>
              ) : null}
            </FgCard>

            {/* tầng 02 — KPI */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 'var(--fg-space-4)', marginBottom: 'var(--fg-space-4)' }}>
              {kpis.map((k) => (
                <FgKpiCard key={k.label} kpi={k} href={k.label.includes('duyệt') ? '/cho-toi-duyet' : undefined} />
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 'var(--fg-space-4)' }}>
              {/* tầng 03 — thu chi ngày */}
              <FgCard title="Thu – chi 30 ngày (tỷ ₫)" extra={<Link to="/baocao/thu-chi-ngay" className="fg-link" style={{ fontSize: 12 }}>Báo cáo</Link>}>
                <FgQuery query={report} skeleton={<FgSkeletonTable rows={3} cols={4} />}>
                  {(r) =>
                    r.chart ? (
                      <>
                        <MiniBarChart chart={r.chart} />
                        <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                          {r.chart.series.map((s, i) => (
                            <FgText key={s.key} style="caption" color="muted">
                              <span style={{ display: 'inline-block', width: 10, height: 10, background: `var(--fg-chart-${i + 1})`, borderRadius: 2, marginRight: 4 }} aria-hidden />
                              {s.label}
                            </FgText>
                          ))}
                        </div>
                      </>
                    ) : (
                      <FgEmptyState glyph="∅" title="Chưa có dữ liệu thu chi" />
                    )
                  }
                </FgQuery>
              </FgCard>

              {/* tầng 04 — đáo hạn 30 ngày */}
              <FgCard
                title="Đáo hạn 30 ngày tới"
                extra={
                  <Link to="/ngan-hang/dao-han" className="fg-link" style={{ fontSize: 12 }}>
                    Bảng đảo hạn
                  </Link>
                }
              >
                <FgQuery query={rollovers} skeleton={<FgSkeletonTable rows={3} cols={4} />}>
                  {(ro) =>
                    !ro.items.length ? (
                      <FgEmptyState glyph="✓" tone="success" title="Không có khoản đáo hạn trong 30 ngày" />
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {ro.items.slice(0, 5).map((m) => (
                          <div key={m.loan_id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <FgText style="bodyS" color="muted">
                              {m.bank_name}
                            </FgText>
                            <span className="fg-chip" style={{ color: `var(--fg-status-${m.tone}-text)`, borderColor: `var(--fg-status-${m.tone}-border)`, background: `var(--fg-status-${m.tone}-bg)` }}>
                              {m.label}
                            </span>
                            <span style={{ flex: 1 }} />
                            <FgMoney value={moneyFromWire(m.outstanding)} mode="compact" />
                          </div>
                        ))}
                        {ro.kpi ? (
                          <FgText style="caption" color="muted">
                            Hôm nay <FgMoney value={moneyFromWire(ro.kpi.today)} mode="compact" /> · 7 ngày <FgMoney value={moneyFromWire(ro.kpi.d7)} mode="compact" />
                          </FgText>
                        ) : null}
                      </div>
                    )
                  }
                </FgQuery>
              </FgCard>
            </div>

            {/* tầng 05 — chờ tôi duyệt */}
            <FgCard
              title={`Chờ ${me?.display_name?.split(' ').slice(-1)[0] ?? 'bạn'} duyệt`}
              style={{ marginTop: 'var(--fg-space-4)' }}
              extra={
                <Link to="/cho-toi-duyet" className="fg-link" style={{ fontSize: 12 }}>
                  Xem tất cả ({ov.counts.awaiting_me})
                </Link>
              }
            >
              {!ov.awaiting_me_rows.length ? (
                <FgEmptyState glyph="✓" tone="success" title="Hàng chờ trống" description="Không có hồ sơ nào đang chờ bạn hôm nay." />
              ) : (
                <div>
                  {ov.awaiting_me_rows.slice(0, 8).map((row) => (
                    <div key={row.document_id} className="fg-stat-row" style={{ alignItems: 'center' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Link to={row.href} className="fg-link" style={{ fontWeight: 500 }}>
                          {row.code}
                        </Link>{' '}
                        <FgText style="bodyS" color="secondary">
                          {row.title}
                        </FgText>
                        <br />
                        <OwnerLine owner={row.next_role_label} roleLabel={row.next_role_label} waitingDays={row.waiting_days} />
                      </div>
                      <FgStatusChip status={row.status} overdue={row.overdue} size="small" />
                      <FgMoney value={moneyFromWire(row.amount)} mode="compact" emphasis />
                    </div>
                  ))}
                </div>
              )}
            </FgCard>

            {/*快捷 xem nhanh — counts */}
            <div style={{ display: 'flex', gap: 'var(--fg-space-4)', flexWrap: 'wrap', marginTop: 'var(--fg-space-4)' }}>
              {[
                { label: 'Công nợ quá hạn', n: ov.counts.overdue_receivable, href: '/cong-no/phai-thu?overdue=true' },
                { label: 'Thiếu chứng từ', n: ov.counts.missing_evidence, href: '/can-xu-ly' },
                { label: 'Đáo hạn 7 ngày', n: ov.counts.maturity_7d_count, href: '/ngan-hang/dao-han?bucket=7d' },
              ].map((c) => (
                <Link key={c.label} to={c.href} className="fg-link" style={{ fontSize: 13 }}>
                  {c.label}: <strong>{c.n}</strong>
                </Link>
              ))}
            </div>
          </>
        );
      }}
    </FgQuery>
  );
}

/** DASH-05 — xem screens/attention.tsx */

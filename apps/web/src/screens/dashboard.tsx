/**
 * DASH-01 — Dashboard tổng quan tài chính, 5 tầng (blueprint §XII/§XXVIII).
 *
 * Tầng 01 Exception · 02 KPI · 03 biểu đồ thu-chi · 04 đáo hạn + dư nợ NH · 05 hàng chờ của tôi.
 * v2 (v2/v2.md §12): thêm top đối tác phải thu / phải trả, khoản vay "Chờ giải ngân",
 * lượt quy trình tự động lỗi. Số liệu 100% từ `/dashboard/overview` — FE zero logic tiền.
 * v2 (§6.2): lọc theo tag (`?tag_ids=`) cho số liệu theo phiếu và thẻ "Theo tag" (nhóm theo tag).
 */

import { Link, useSearchParams } from 'react-router';
import { useMemo, type ReactNode } from 'react';
import { addDays, moneyFromWire, relativeTime, today } from '@fingate/shared';
import { useOverview, useReport, useRollovers } from '../app/queries.ts';
import { SCOPE_ALL, useAuth } from '../app/store.tsx';
import { automationAccess, overdueLabel, useCashflowForecast } from '../app/v2/exec.ts';
import type { DashboardAutomationWire, DashboardLoansPendingWire, DashboardOverview, MoneyWire, PartnerExposureWire } from '../app/types.ts';
import { FgAlert, FgButton, FgMoney, FgMoneyStack, FgStatusChip, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSkeletonKpi, FgSkeletonTable } from '../components/uitk.tsx';
import { FgExceptionList, FgKpiCard, OwnerLine } from '../components/finance.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import { TagFilter } from '../components/tag-input.tsx';

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

/** Top đối tác phải thu / phải trả (v2 §12) — bấm tên để mở hồ sơ đối tác. */
function PartnerExposureCard({
  title,
  rows,
  total,
  overdue,
  empty,
}: {
  title: string;
  rows: PartnerExposureWire[];
  total?: MoneyWire | null;
  overdue?: MoneyWire | null;
  empty: string;
}): ReactNode {
  const overdueMoney = moneyFromWire(overdue);
  return (
    <FgCard title={title} extra={<Link to="/doi-tac" className="fg-link" style={{ fontSize: 12 }}>Danh bạ đối tác</Link>}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
        <FgText style="caption" color="muted">
          Còn lại <FgMoney value={moneyFromWire(total)} mode="compact" />
        </FgText>
        {overdueMoney && overdueMoney.minor > 0n ? (
          <FgText style="caption" color="danger">
            Quá hạn <FgMoney value={overdueMoney} mode="compact" />
          </FgText>
        ) : null}
      </div>
      {!rows.length ? (
        <FgText style="bodyS" color="muted">
          {empty}
        </FgText>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((r) => (
            <div key={`${r.direction}-${r.partner_id ?? r.partner_name}`} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                {r.partner_id ? (
                  <Link to={`/doi-tac/${r.partner_id}`} className="fg-link" style={{ fontWeight: 500 }}>
                    {r.partner_name}
                  </Link>
                ) : (
                  <FgText style="bodyS">{r.partner_name}</FgText>
                )}
                <br />
                <FgText style="caption" color="muted">
                  {r.count} khoản{BigInt(r.overdue.minor) > 0n ? ` · ${overdueLabel(r.max_overdue_days)}` : ''}
                </FgText>
              </div>
              <FgMoneyStack value={moneyFromWire(r.remaining)} />
            </div>
          ))}
        </div>
      )}
    </FgCard>
  );
}

/** Dư nợ theo ngân hàng — gộp theo đối tác Ngân hàng (v2: theo ID, không theo tên chữ). */
function BankDebtCard({ bank }: { bank: DashboardOverview['bank'] }): ReactNode {
  const rows = bank.by_bank.slice(0, 5);
  return (
    <FgCard title="Dư nợ theo ngân hàng" extra={<Link to="/ngan-hang/khoan-vay" className="fg-link" style={{ fontSize: 12 }}>Khoản vay</Link>}>
      <FgText style="caption" color="muted">
        Tổng dư nợ <FgMoney value={moneyFromWire(bank.debt_total)} mode="compact" />
      </FgText>
      {!rows.length ? (
        <div style={{ marginTop: 8 }}>
          <FgEmptyState glyph="✓" tone="success" title="Không có dư nợ ngân hàng" />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          {rows.map((b) => (
            <div key={b.partner_id ?? b.bank_name} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                {b.partner_id ? (
                  <Link to={`/doi-tac/${b.partner_id}`} className="fg-link" style={{ fontWeight: 500 }}>
                    {b.bank_name}
                  </Link>
                ) : (
                  <FgText style="bodyS">{b.bank_name}</FgText>
                )}
                <br />
                <FgText style="caption" color="muted">
                  {b.share_percent}% tổng dư nợ
                </FgText>
              </div>
              <FgMoneyStack value={moneyFromWire(b.outstanding)} />
            </div>
          ))}
        </div>
      )}
    </FgCard>
  );
}

/** Khoản vay "Chờ giải ngân" — không vào dư nợ, chờ phiếu thu giải ngân thực thi (v2 §10.2). */
function LoansPendingCard({ data }: { data: DashboardLoansPendingWire | null | undefined }): ReactNode {
  const count = data?.count ?? 0;
  return (
    <FgCard title={`Khoản vay chờ giải ngân${count ? ` (${count})` : ''}`} extra={<Link to="/ngan-hang/khoan-vay" className="fg-link" style={{ fontSize: 12 }}>Tất cả khoản vay</Link>}>
      {!data || !data.items.length ? (
        <FgEmptyState glyph="✓" tone="success" title="Không có khoản vay chờ giải ngân" />
      ) : (
        <>
          <FgText style="caption" color="muted">
            Gốc chờ về <FgMoney value={moneyFromWire(data.total)} mode="compact" /> · không tính vào dư nợ
          </FgText>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
            {data.items.slice(0, 5).map((l) => (
              <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <Link to={l.href} className="fg-link" style={{ fontWeight: 500 }}>
                    {l.code}
                  </Link>
                  <br />
                  <FgText style="caption" color="muted">
                    {l.partner_id ? (
                      <Link to={`/doi-tac/${l.partner_id}`} className="fg-link">
                        {l.partner_name}
                      </Link>
                    ) : (
                      l.partner_name
                    )}
                  </FgText>
                </div>
                <FgMoneyStack value={moneyFromWire(l.principal)} />
              </div>
            ))}
          </div>
        </>
      )}
    </FgCard>
  );
}

/** Lượt quy trình tự động đang lỗi (v2 §11.2) — KTT xử lý và chạy lại ở màn Tự động hoá. */
function AutomationFailedCard({ data, canOpen }: { data: DashboardAutomationWire | null | undefined; canOpen: boolean }): ReactNode {
  const count = data?.failed_count ?? 0;
  return (
    <FgCard
      title={`Quy trình tự động lỗi${count ? ` (${count})` : ''}`}
      extra={canOpen ? <Link to="/quantri/tu-dong?status=failed" className="fg-link" style={{ fontSize: 12 }}>Lượt chạy</Link> : null}
    >
      {!data || !data.items.length ? (
        <FgEmptyState glyph="✓" tone="success" title="Không có lượt tự động lỗi" description="Các quy tắc đang chạy bình thường." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {data.items.slice(0, 5).map((a) => (
            <div key={a.id} style={{ minWidth: 0 }}>
              <FgText style="bodyS" strong>
                {a.rule_code} · {a.rule_name}
              </FgText>
              <br />
              <FgText style="caption" color="muted">
                {a.company_name}
                {a.source_code ? ` · ${a.source_code}` : ''}
                {a.updated_at ? ` · ${relativeTime(a.updated_at)}` : ''}
              </FgText>
              {a.error ? (
                <>
                  <br />
                  <FgText style="caption" color="danger">
                    {a.error}
                  </FgText>
                </>
              ) : null}
              {a.href ? (
                <>
                  {' '}
                  <Link to={a.href} className="fg-link" style={{ fontSize: 12 }}>
                    Mở phiếu nguồn
                  </Link>
                </>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </FgCard>
  );
}

/**
 * `tag_ids` trên URL: chuỗi CSV → mảng ID (bỏ rỗng, bỏ trùng, bỏ mã sai định dạng). Lọc ở đây để một
 * đường dẫn hỏng không làm API trả 422 và ẩn luôn thanh lọc (người dùng không còn cách bỏ lọc).
 * Chuẩn hoá chữ thường như máy chủ (`OBJECT_ID_RE` chỉ nhận chữ thường).
 */
const parseTagParam = (value: string): string[] => [
  ...new Set(
    value
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[0-9a-f]{24}$/.test(s)),
  ),
];

/** Một nhóm của báo cáo "Theo tag" (`GET /reports/theo-tag`, v2 §12). */
interface TagGroupWire {
  tag: string;
  companies: string;
  company_count: number;
  income: MoneyWire;
  expense: MoneyWire;
  documents: number;
}

/**
 * Thẻ "Theo tag" (v2 §6.2, §12): thu – chi 30 ngày nhóm theo tag. Đang lọc → chỉ các tag đã chọn
 * (phiếu có ít nhất một tag đã chọn). "Toàn tập đoàn" gộp các tag cùng tên đã chuẩn hoá.
 */
function TagBreakdownCard({ from, to, tagKey, filtered }: { from: string; to: string; tagKey: string | undefined; filtered: boolean }): ReactNode {
  const report = useReport('theo-tag', { from, to, tag_ids: tagKey, limit: '8' });
  return (
    <FgCard title="Theo tag" extra={<Link to="/baocao/theo-tag" className="fg-link" style={{ fontSize: 12 }}>Báo cáo</Link>}>
      <FgText style="caption" color="muted">
        30 ngày tới · không gồm chuyển nội bộ
      </FgText>
      <FgQuery query={report} skeleton={<FgSkeletonTable rows={3} cols={3} />}>
        {(r) => {
          const groups = r.rows as unknown as TagGroupWire[];
          if (!groups.length) {
            return (
              <FgEmptyState
                glyph="◇"
                title={filtered ? 'Chưa có phiếu gắn tag đã chọn' : 'Chưa có phiếu gắn tag'}
                description="Gắn tag khi lập phiếu thu/chi để xem thu – chi theo tag."
              />
            );
          }
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {groups.map((g) => (
                <div key={g.tag} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <FgText style="bodyS" strong>
                      {g.tag}
                    </FgText>
                    <br />
                    <FgText style="caption" color="muted">
                      {g.documents} phiếu{g.company_count > 1 ? ` · ${g.company_count} công ty` : ''}
                    </FgText>
                  </div>
                  <FgText style="caption" color="muted">
                    Thu <FgMoney value={moneyFromWire(g.income)} mode="compact" /> · Chi <FgMoney value={moneyFromWire(g.expense)} mode="compact" />
                  </FgText>
                </div>
              ))}
            </div>
          );
        }}
      </FgQuery>
    </FgCard>
  );
}

export function DashboardScreen(): ReactNode {
  const { me, can, scope } = useAuth();
  const [params, setParams] = useSearchParams();
  // v2 §6.2: lọc theo tag. Tag thuộc từng công ty → ô chỉ mở khi chọn một công ty ("Toàn tập đoàn" khoá).
  const tagCompanyId = scope === SCOPE_ALL ? null : scope;
  const tagIds = useMemo(() => (tagCompanyId ? parseTagParam(params.get('tag_ids') ?? '') : []), [params, tagCompanyId]);
  const tagKey = tagIds.length ? tagIds.join(',') : undefined;
  const setTagIds = (ids: string[]) => {
    const next = new URLSearchParams(params);
    if (ids.length) next.set('tag_ids', ids.join(','));
    else next.delete('tag_ids');
    setParams(next);
  };
  const overview = useOverview(tagIds);
  // cửa sổ đúng 30 ngày (hôm nay → +29), khớp tiêu đề thẻ
  const windowFrom = today();
  const windowTo = addDays(today(), 29);
  const report = useReport('thu-chi-ngay', { from: windowFrom, to: windowTo, tag_ids: tagKey });
  const forecast = useCashflowForecast(30);
  const rollovers = useRollovers('30d');
  const access = automationAccess(can, me?.entitlements.role);

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
                <>
                  <Link to="/dong-tien?view=forecast">
                    <FgButton>Dự báo dòng tiền</FgButton>
                  </Link>
                  {can('approval:act') ? (
                    <Link to="/cho-toi-duyet">
                      <FgButton variant="primary">Mở hàng chờ của tôi ({ov.counts.awaiting_me})</FgButton>
                    </Link>
                  ) : null}
                </>
              }
            />

            {staleLong ? <FgAlert tone="attention" title={`Số liệu có thể cũ — cập nhật lúc ${new Date(ov.generated_at).toLocaleString('vi-VN')}`} /> : null}

            {/* bộ lọc tag (v2 §6.2) — số liệu theo phiếu; tiền, công nợ, vay, đáo hạn không theo tag */}
            <div className="fg-filterbar" style={{ alignItems: 'flex-end' }}>
              <div style={{ minWidth: 260 }}>
                <FgText style="caption" color="muted">
                  Tag
                </FgText>
                <TagFilter value={tagIds} onChange={setTagIds} companyId={tagCompanyId} />
              </div>
              {tagIds.length ? (
                <FgButton size="small" variant="ghost" onClick={() => setTagIds([])}>
                  Bỏ lọc tag
                </FgButton>
              ) : null}
            </div>
            {tagIds.length ? (
              <FgAlert
                tone="neutral"
                title="Số liệu theo phiếu đang lọc theo tag"
                description="Áp dụng cho: dự kiến thu – chi hôm nay, chờ tôi duyệt, thiếu chứng từ, biểu đồ thu – chi và thẻ Theo tag. Tiền hiện có, dự báo, công nợ, vay ngân hàng và đáo hạn vẫn tính theo toàn công ty."
                style={{ marginBottom: 'var(--fg-space-4)' }}
              />
            ) : tagCompanyId === null ? (
              <FgText style="caption" color="muted">
                Chọn một công ty để lọc theo tag (tag thuộc từng công ty). Thẻ “Theo tag” vẫn gộp các công ty theo tên tag.
              </FgText>
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
                <FgKpiCard key={k.label} kpi={k} href={k.label.includes('duyệt') && can('approval:act') ? '/cho-toi-duyet' : undefined} />
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

              {/* tầng 03a — nhóm theo tag (v2 §6.2, §12) */}
              {can('report:view') ? <TagBreakdownCard from={windowFrom} to={windowTo} tagKey={tagKey} filtered={tagIds.length > 0} /> : null}

              {/* tầng 03b — tóm tắt dự báo 30 ngày (chi tiết ở /dong-tien?view=forecast) */}
              <FgCard title="Dự báo 30 ngày" extra={<Link to="/dong-tien?view=forecast" className="fg-link" style={{ fontSize: 12 }}>Chi tiết</Link>}>
                <FgQuery query={forecast} skeleton={<FgSkeletonTable rows={3} cols={2} />}>
                  {(f) => (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                      <div>
                        <FgText style="caption" color="muted">Thu – chi thuần</FgText>
                        <div><FgMoney value={moneyFromWire(f.totals.net)} mode="compact" /></div>
                      </div>
                      <div>
                        <FgText style="caption" color="muted">Số dư cuối kỳ dự kiến</FgText>
                        <div><FgMoney value={moneyFromWire(f.totals.end_closing)} mode="compact" /></div>
                      </div>
                      <div>
                        <FgText style="caption" color="muted">Thấp nhất trong kỳ</FgText>
                        <div><FgMoney value={moneyFromWire(f.totals.min_closing)} mode="compact" /></div>
                      </div>
                      <div>
                        <FgText style="caption" color="muted">Dưới ngưỡng từ</FgText>
                        <div>{f.first_breach_date ?? 'Không có'}</div>
                      </div>
                    </div>
                  )}
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
                              {m.partner_id ? (
                                <Link to={`/doi-tac/${m.partner_id}`} className="fg-link">
                                  {m.bank_name}
                                </Link>
                              ) : (
                                m.bank_name
                              )}
                            </FgText>
                            <span className="fg-chip" style={{ color: `var(--fg-status-${m.tone}-text)`, borderColor: `var(--fg-status-${m.tone}-border)`, background: `var(--fg-status-${m.tone}-bg)` }}>
                              {m.label}
                            </span>
                            <span style={{ flex: 1 }} />
                            <FgMoneyStack value={moneyFromWire(m.outstanding)} />
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

              <BankDebtCard bank={ov.bank} />
            </div>

            {/* tầng 04b — đối tác, khoản vay chờ giải ngân, lượt tự động lỗi (v2 §12) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 'var(--fg-space-4)', marginTop: 'var(--fg-space-4)' }}>
              <PartnerExposureCard
                title="Phải thu theo đối tác"
                rows={ov.partners?.top_receivable ?? []}
                total={ov.partners?.receivable_total}
                overdue={ov.receivable_overdue}
                empty="Không có khoản phải thu còn dư"
              />
              <PartnerExposureCard title="Phải trả theo đối tác" rows={ov.partners?.top_payable ?? []} total={ov.partners?.payable_total} empty="Không có khoản phải trả còn dư" />
              <LoansPendingCard data={ov.loans_pending} />
              <AutomationFailedCard data={ov.automation} canOpen={access.view} />
            </div>

            {/* tầng 05 — chờ tôi duyệt */}
            <FgCard
              title={`Chờ ${me?.display_name?.split(' ').slice(-1)[0] ?? 'bạn'} duyệt`}
              style={{ marginTop: 'var(--fg-space-4)' }}
              extra={
                can('approval:act') ? (
                  <Link to="/cho-toi-duyet" className="fg-link" style={{ fontSize: 12 }}>
                    Xem tất cả ({ov.counts.awaiting_me})
                  </Link>
                ) : null
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
                      <FgMoneyStack value={moneyFromWire(row.amount)} emphasis />
                    </div>
                  ))}
                </div>
              )}
            </FgCard>

            {/*快捷 xem nhanh — counts */}
            <div style={{ display: 'flex', gap: 'var(--fg-space-4)', flexWrap: 'wrap', marginTop: 'var(--fg-space-4)' }}>
              {[
                { label: 'Công nợ quá hạn', n: ov.counts.overdue_receivable, href: '/cong-no?direction=receivable&overdue_only=true' },
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

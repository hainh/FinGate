/**
 * CASH-01 Lịch sử dòng tiền · CASH-02 Dự báo dòng tiền (v2 §12).
 *
 * - Lịch sử: thực thu/chi theo sổ cái append-only. Kỳ 7/30/90 ngày theo NGÀY; 6 tháng / 1 năm / 2 năm theo THÁNG.
 * - Dự báo (v2): 7/30/60/90 ngày — đầu kỳ, thu/chi dự kiến, cuối kỳ; dưới số dư tối thiểu → đỏ;
 *   gồm GIẢI NGÂN sắp tới (phiếu thu vay có ngày + khoản chờ giải ngân chưa có ngày) và LỊCH TRẢ NỢ VAY.
 * Dữ liệu luôn theo phạm vi đang chọn (toàn tập đoàn hay công ty). Chuyển tab lưu trên URL `?view=forecast`.
 */

import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Table } from 'antd';
import dayjs from 'dayjs';
import { moneyFromWire } from '@fingate/shared';
import { useCashflowHistory } from '../app/queries.ts';
import { FORECAST_HORIZON_OPTIONS, useCashflowForecast, type CashflowForecast, type ForecastDayWire, type ForecastDisbursementItem, type ForecastHorizon, type ForecastRepaymentItem } from '../app/v2/exec.ts';
import { FgAlert, FgButton, FgMoney, FgMoneyStack, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSegmented, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import type {
  CashflowGranularity,
  CashflowGroup,
  CashflowHistoryResult,
  CashflowLane,
  CashflowPeriod,
  MoneyWire,
} from '../app/types.ts';

const PERIODS: { key: CashflowPeriod; label: string }[] = [
  { key: '7d', label: '7 ngày' },
  { key: '30d', label: '30 ngày' },
  { key: '90d', label: '90 ngày' },
  { key: '6m', label: '6 tháng' },
  { key: '1y', label: '1 năm' },
  { key: '2y', label: '2 năm' },
];

const GROUPS: { key: CashflowGroup; label: string }[] = [
  { key: 'none', label: 'Không chia' },
  { key: 'company', label: 'Theo công ty' },
  { key: 'account', label: 'Theo tài khoản' },
];

/** `YYYY-MM` → `MM/YYYY`; `YYYY-MM-DD` → `DD/MM`. */
const bucketLabel = (b: string): string => (b.length === 7 ? `${b.slice(5)}/${b.slice(0, 4)}` : `${b.slice(8)}/${b.slice(5, 7)}`);
const laneTotal = (l: CashflowLane): bigint => BigInt(l.total_inflow.minor) + BigInt(l.total_outflow.minor);
const dayMonth = (iso: string): string => dayjs(iso).format('DD/MM');
const dayMonthYear = (iso: string): string => dayjs(iso).format('DD/MM/YYYY');

/** Bảng chi tiết từng kỳ của một làn (ngày/tháng). */
function LaneTable({ lane, granularity }: { lane: CashflowLane; granularity: CashflowGranularity }): ReactNode {
  return (
    <FgTable
      rowKey="bucket"
      size="small"
      mobileCards={false}
      dataSource={lane.points}
      pagination={lane.points.length > 31 ? { pageSize: 31, size: 'small' } : false}
      columns={[
        { title: granularity === 'day' ? 'Ngày' : 'Tháng', dataIndex: 'bucket', render: (v: string) => <span className="fg-num">{bucketLabel(v)}</span> },
        { title: 'Thu', dataIndex: 'inflow', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="full" /> },
        { title: 'Chi', dataIndex: 'outflow', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="full" /> },
        { title: 'Thuần', dataIndex: 'net', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="full" /> },
        { title: 'Luỹ kế', dataIndex: 'cumulative', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="full" emphasis /> },
      ]}
      summary={() => (
        <Table.Summary.Row>
          <Table.Summary.Cell index={0}>
            <FgText style="bodyS" strong>Tổng</FgText>
          </Table.Summary.Cell>
          <Table.Summary.Cell index={1} align="right"><FgMoney value={moneyFromWire(lane.total_inflow)} mode="full" /></Table.Summary.Cell>
          <Table.Summary.Cell index={2} align="right"><FgMoney value={moneyFromWire(lane.total_outflow)} mode="full" /></Table.Summary.Cell>
          <Table.Summary.Cell index={3} align="right"><FgMoney value={moneyFromWire(lane.total_net)} mode="full" /></Table.Summary.Cell>
          <Table.Summary.Cell index={4} />
        </Table.Summary.Row>
      )}
    />
  );
}

function KpiRow({ items }: { items: { label: string; value: MoneyWire | null | undefined; tone?: 'danger' }[] }): ReactNode {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
      {items.map((k) => (
        <FgCard key={k.label} className="fg-kpi">
          <FgText style="caption" color="muted">{k.label}</FgText>
          <div className="fg-kpi-value" style={k.tone === 'danger' ? { color: 'var(--fg-status-danger-text)' } : undefined}>
            <FgMoney value={moneyFromWire(k.value)} mode="full" emphasis />
          </div>
        </FgCard>
      ))}
    </div>
  );
}

/* ================= Lịch sử (CASH-01, v1) ================= */

function HistoryView(): ReactNode {
  const [period, setPeriod] = useState<CashflowPeriod>('1y');
  const [group, setGroup] = useState<CashflowGroup>('none');
  const query = useCashflowHistory(period, group);
  return (
    <>
      <div className="fg-filterbar" role="group" aria-label="Khoảng thời gian">
        {PERIODS.map((p) => (
          <FgButton key={p.key} size="small" variant={p.key === period ? 'primary' : 'secondary'} onClick={() => setPeriod(p.key)}>
            {p.label}
          </FgButton>
        ))}
      </div>
      <div className="fg-filterbar" role="group" aria-label="Chia swimlane">
        {GROUPS.map((g) => (
          <FgButton key={g.key} size="small" variant={g.key === group ? 'primary' : 'secondary'} onClick={() => setGroup(g.key)}>
            {g.label}
          </FgButton>
        ))}
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={10} cols={5} />}>
        {(data: CashflowHistoryResult) => {
          if (!data.lanes.length) {
            return (
              <div className="fg-card">
                <FgEmptyState glyph="∿" title="Chưa có dòng tiền phát sinh" description="Kỳ này chưa ghi nhận khoản thu/chi nào trong phạm vi đang chọn." />
              </div>
            );
          }
          const lanes = [...data.lanes].sort((a, b) => (laneTotal(b) > laneTotal(a) ? 1 : -1));
          // Ngày gần nhất lên trước (luỹ kế vẫn tính theo thứ tự thời gian).
          const viewLanes = lanes.map((l) => ({ ...l, points: [...l.points].reverse() }));
          return (
            <>
              <KpiRow items={[{ label: 'Tổng thu', value: data.totals.inflow }, { label: 'Tổng chi', value: data.totals.outflow }, { label: 'Dòng tiền thuần', value: data.totals.net }]} />
              {viewLanes.map((lane) => (
                <FgCard
                  key={lane.key}
                  collapsible
                  title={<span>{lane.label}{lane.sub_label ? <span style={{ color: 'var(--fg-text-muted)', fontWeight: 400 }}> · {lane.sub_label}</span> : null}</span>}
                  style={{ marginTop: 'var(--fg-space-4)' }}
                  padded={false}
                >
                  <LaneTable lane={lane} granularity={data.granularity} />
                </FgCard>
              ))}
            </>
          );
        }}
      </FgQuery>
    </>
  );
}

/* ================= Dự báo (CASH-02, v2) ================= */

function ForecastView(): ReactNode {
  const [horizon, setHorizon] = useState<ForecastHorizon>(30);
  const query = useCashflowForecast(horizon);
  return (
    <>
      <div className="fg-filterbar" role="group" aria-label="Số ngày dự báo">
        {FORECAST_HORIZON_OPTIONS.map((h) => (
          <FgButton key={h} size="small" variant={h === horizon ? 'primary' : 'secondary'} onClick={() => setHorizon(h)}>
            {h} ngày
          </FgButton>
        ))}
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={8} cols={6} />}>
        {(f) => <ForecastBody f={f} />}
      </FgQuery>
    </>
  );
}

function ForecastBody({ f }: { f: CashflowForecast }): ReactNode {
  const minBalance = moneyFromWire(f.min_balance);
  const repaymentTotal = f.repayments.reduce((a, r) => a + BigInt(r.total.minor), 0n);
  return (
    <>
      <FgText style="caption" color="muted">
        {dayMonthYear(f.from)} → {dayMonthYear(f.to)} · số dư tối thiểu toàn phạm vi{' '}
        <FgMoney value={minBalance} mode="full" missingLabel="chưa đặt" />
      </FgText>

      {f.first_breach_date ? (
        <div style={{ marginTop: 'var(--fg-space-3)' }}>
          <FgAlert tone="danger" title={`Dự kiến xuống dưới số dư tối thiểu từ ngày ${dayMonthYear(f.first_breach_date)}`} description="Các ngày đỏ trong bảng dưới đây đang thấp hơn ngưỡng của công ty." />
        </div>
      ) : null}
      {f.shortfall_by_company.length ? (
        <div style={{ marginTop: 'var(--fg-space-3)' }}>
          <FgAlert
            tone="attention"
            title="Thiếu tiền theo công ty"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {f.shortfall_by_company.map((s) => (
                  <li key={s.company_id}>
                    {s.company_name}: dưới ngưỡng từ {dayMonthYear(s.first_breach_date)} · thấp nhất <FgMoney value={moneyFromWire(s.min_closing)} mode="full" />
                  </li>
                ))}
              </ul>
            }
          />
        </div>
      ) : null}

      <div style={{ height: 'var(--fg-space-4)' }} />
      <KpiRow
        items={[
          { label: 'Đầu kỳ', value: f.opening },
          { label: 'Thu dự kiến', value: f.totals.inflow },
          { label: 'Chi dự kiến', value: f.totals.outflow },
          { label: 'Thuần dự kiến', value: f.totals.net },
          { label: 'Cuối kỳ', value: f.totals.end_closing },
          { label: 'Thấp nhất trong kỳ', value: f.totals.min_closing, tone: f.first_breach_date ? 'danger' : undefined },
        ]}
      />

      <FgCard title="Chi tiết theo ngày" padded={false}>
        <FgTable
          rowKey="date"
          size="small"
          mobileCards={false}
          dataSource={f.days}
          pagination={f.days.length > 31 ? { pageSize: 31, size: 'small' } : false}
          columns={[
            {
              title: 'Ngày',
              dataIndex: 'date',
              render: (v: string, r: ForecastDayWire) => (
                <span>
                  <span className="fg-num">{dayMonth(v)}</span> <FgText style="caption" color="muted">{r.weekday}</FgText>
                </span>
              ),
            },
            { title: 'Đầu ngày', dataIndex: 'opening', align: 'right', render: (v: MoneyWire) => <FgMoney value={moneyFromWire(v)} mode="full" /> },
            { title: 'Thu', dataIndex: 'inflow', align: 'right', render: (v: MoneyWire) => <FgMoney value={moneyFromWire(v)} mode="full" /> },
            { title: 'Chi', dataIndex: 'outflow', align: 'right', render: (v: MoneyWire) => <FgMoney value={moneyFromWire(v)} mode="full" /> },
            {
              title: 'Cuối ngày',
              dataIndex: 'closing',
              align: 'right',
              render: (v: MoneyWire, r: ForecastDayWire) => (
                <span style={r.breach ? { color: 'var(--fg-status-danger-text)', fontWeight: 600 } : undefined}>
                  {r.breach ? '⛔ ' : ''}
                  <FgMoney value={moneyFromWire(v)} mode="full" />
                </span>
              ),
            },
            { title: 'Tối thiểu', dataIndex: 'min_balance', align: 'right', render: (v: MoneyWire) => <FgMoney value={moneyFromWire(v)} mode="full" missingLabel="—" /> },
          ]}
        />
      </FgCard>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 'var(--fg-space-4)', marginTop: 'var(--fg-space-4)' }}>
        <DisbursementCard dated={f.disbursements.dated} undated={f.disbursements.undated} undatedTotal={f.disbursements.undated_total} />
        <RepaymentCard rows={f.repayments} total={repaymentTotal} />
      </div>
    </>
  );
}

function DisbursementRow({ item }: { item: ForecastDisbursementItem }): ReactNode {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        {item.href ? (
          <Link to={item.href} className="fg-link" style={{ fontWeight: 500 }}>
            {item.code}
          </Link>
        ) : (
          <FgText strong>{item.code}</FgText>
        )}
        <br />
        <FgText style="caption" color="muted">
          {item.partner_id ? (
            <Link to={`/doi-tac/${item.partner_id}`} className="fg-link">
              {item.partner_name}
            </Link>
          ) : (
            item.partner_name
          )}
          {item.date ? ` · ${dayMonthYear(item.date)}` : ''}
        </FgText>
      </div>
      <FgMoneyStack value={moneyFromWire(item.amount)} />
    </div>
  );
}

/** Giải ngân: phiếu thu vay có ngày trong kỳ + khoản chờ giải ngân chưa có ngày (không cộng vào dòng tiền). */
function DisbursementCard({ dated, undated, undatedTotal }: { dated: ForecastDisbursementItem[]; undated: ForecastDisbursementItem[]; undatedTotal: MoneyWire }): ReactNode {
  const none = !dated.length && !undated.length;
  return (
    <FgCard title="Giải ngân sắp tới">
      {none ? (
        <FgEmptyState glyph="✓" tone="neutral" title="Không có giải ngân trong kỳ" description="Khoản vay chờ giải ngân sẽ hiện ở đây khi có phiếu thu giải ngân." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {dated.map((d) => (
            <DisbursementRow key={`d-${d.code}-${d.date}`} item={d} />
          ))}
          {undated.length ? (
            <>
              <FgText style="caption" color="muted">
                Chờ giải ngân, chưa có ngày: <FgMoney value={moneyFromWire(undatedTotal)} mode="full" /> · không tính vào dòng tiền
              </FgText>
              {undated.map((u) => (
                <DisbursementRow key={`u-${u.code}`} item={u} />
              ))}
            </>
          ) : null}
        </div>
      )}
    </FgCard>
  );
}

/** Lịch trả nợ vay trong kỳ (kỳ chưa đến hạn, đã trừ phần đã có phiếu trả nợ trong pipeline). */
function RepaymentCard({ rows, total }: { rows: ForecastRepaymentItem[]; total: bigint }): ReactNode {
  return (
    <FgCard title="Lịch trả nợ vay">
      {!rows.length ? (
        <FgEmptyState glyph="✓" tone="success" title="Không có kỳ trả nợ vay trong kỳ" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((r) => (
            <div key={`${r.bank_debt_id}-${r.due_date}`} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <Link to={`/ngan-hang/khoan-vay/${r.bank_debt_id}/lich-tra`} className="fg-link" style={{ fontWeight: 500 }}>
                  {r.code}
                </Link>
                <br />
                <FgText style="caption" color="muted">
                  {r.partner_id ? (
                    <Link to={`/doi-tac/${r.partner_id}`} className="fg-link">
                      {r.partner_name}
                    </Link>
                  ) : (
                    r.partner_name
                  )}{' '}
                  · đến hạn {dayMonthYear(r.due_date)} · gốc <FgMoney value={moneyFromWire(r.principal)} mode="compact" /> · lãi{' '}
                  <FgMoney value={moneyFromWire(r.interest)} mode="compact" />
                </FgText>
              </div>
              <FgMoneyStack value={moneyFromWire(r.total)} />
            </div>
          ))}
          <FgText style="caption" color="muted">
            Tổng phải trả trong kỳ: <FgMoney value={{ minor: total.toString(), currency: 'VND', decimals: 0 }} mode="full" />
          </FgText>
        </div>
      )}
    </FgCard>
  );
}

/* ================= màn chính ================= */

export function CashflowHistoryScreen(): ReactNode {
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'forecast' ? 'forecast' : 'history';
  const switchView = (next: string): void => {
    const p = new URLSearchParams(params);
    if (next === 'history') p.delete('view');
    else p.set('view', next);
    setParams(p, { replace: true });
  };
  return (
    <>
      <FgPageHeader
        title={view === 'forecast' ? 'Dự báo dòng tiền' : 'Lịch sử dòng tiền'}
        meta={
          view === 'forecast'
            ? 'Dự kiến thu – chi – số dư theo ngày, giải ngân và lịch trả nợ vay — theo phạm vi dữ liệu đang chọn'
            : 'Thực thu · thực chi theo sổ cái — theo phạm vi dữ liệu đang chọn'
        }
      />
      <div style={{ marginBottom: 'var(--fg-space-3)' }}>
        <FgSegmented
          value={view}
          onChange={(v) => switchView(String(v))}
          options={[
            { label: 'Dự báo', value: 'forecast' },
            { label: 'Lịch sử', value: 'history' },
          ]}
        />
      </div>
      {view === 'forecast' ? <ForecastView /> : <HistoryView />}
    </>
  );
}

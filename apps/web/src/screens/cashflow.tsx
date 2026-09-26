/**
 * CASH-01 Lịch sử dòng tiền — thực thu/chi theo tháng (sổ cái append-only).
 *
 * Lựa chọn kỳ 6 tháng / 1 năm / 2 năm + chia swimlane (không chia · theo công ty ·
 * theo tài khoản). Dữ liệu luôn theo phạm vi đang chọn (toàn tập đoàn hay công ty).
 */

import { useState, type ReactNode } from 'react';
import { Table } from 'antd';
import { formatMoney, moneyFromWire } from '@fingate/shared';
import { useCashflowHistory } from '../app/queries.ts';
import { FgButton, FgMoney, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import type { CashflowGroup, CashflowHistoryResult, CashflowLane, CashflowPeriod, MoneyWire } from '../app/types.ts';

const PERIODS: { key: CashflowPeriod; label: string }[] = [
  { key: '6m', label: '6 tháng' },
  { key: '1y', label: '1 năm' },
  { key: '2y', label: '2 năm' },
];

const GROUPS: { key: CashflowGroup; label: string }[] = [
  { key: 'none', label: 'Không chia' },
  { key: 'company', label: 'Theo công ty' },
  { key: 'account', label: 'Theo tài khoản' },
];

const toTy = (m: MoneyWire): number => Number(BigInt(m.minor)) / 1e9;
const monthLabel = (m: string): string => `${m.slice(5)}/${m.slice(0, 4)}`;
const laneTotal = (l: CashflowLane): bigint => BigInt(l.total_inflow.minor) + BigInt(l.total_outflow.minor);

/** Swimlane — mỗi làn một hàng, trục thời gian chung, cột thu xanh · chi đỏ. */
function SwimlaneChart({ months, lanes }: { months: string[]; lanes: CashflowLane[] }): ReactNode {
  const n = months.length;
  const H = 46;
  const max = Math.max(1, ...lanes.flatMap((l) => l.points.flatMap((p) => [toTy(p.inflow), toTy(p.outflow)])));
  const slot = 100 / Math.max(1, n);
  const barW = slot * 0.34;
  return (
    <div>
      {lanes.map((lane) => (
        <div
          key={lane.key}
          style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: '1px solid var(--fg-border-subtle)', padding: '6px 0' }}
        >
          <div style={{ flex: '0 0 190px', maxWidth: 190 }}>
            <div style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={lane.label}>
              {lane.label}
            </div>
            {lane.sub_label ? <FgText style="caption" color="muted">{lane.sub_label}</FgText> : null}
          </div>
          <svg
            viewBox={`0 0 100 ${H}`}
            preserveAspectRatio="none"
            style={{ flex: 1, height: H, minWidth: 0 }}
            role="img"
            aria-label={`${lane.label}: thu ${formatMoney(moneyFromWire(lane.total_inflow)!, { mode: 'compact' })} · chi ${formatMoney(moneyFromWire(lane.total_outflow)!, { mode: 'compact' })}`}
          >
            {lane.points.map((p, i) => {
              const x = i * slot;
              const hi = (toTy(p.inflow) / max) * H;
              const ho = (toTy(p.outflow) / max) * H;
              return (
                <g key={p.month}>
                  <rect x={x + slot * 0.1} y={H - hi} width={barW} height={Math.max(0.6, hi)} fill="var(--fg-chart-2)" />
                  <rect x={x + slot * 0.1 + barW + slot * 0.06} y={H - ho} width={barW} height={Math.max(0.6, ho)} fill="var(--fg-chart-9)" />
                </g>
              );
            })}
          </svg>
        </div>
      ))}
      <div style={{ display: 'flex', gap: 10, paddingTop: 4 }}>
        <div style={{ flex: '0 0 190px', maxWidth: 190 }} />
        <div style={{ flex: 1, display: 'flex' }}>
          {months.map((m, i) => (
            <span
              key={m}
              className="fg-num"
              style={{ flex: 1, textAlign: 'center', fontSize: 10, color: 'var(--fg-text-muted)', whiteSpace: 'nowrap' }}
            >
              {n <= 12 || i % 2 === 0 ? monthLabel(m) : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function LaneTable({ lane }: { lane: CashflowLane }): ReactNode {
  return (
    <FgTable
      rowKey="month"
      size="small"
      dataSource={lane.points}
      columns={[
        { title: 'Tháng', dataIndex: 'month', render: (v: string) => <span className="fg-num">{monthLabel(v)}</span> },
        { title: 'Thu', dataIndex: 'inflow', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
        { title: 'Chi', dataIndex: 'outflow', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
        { title: 'Thuần', dataIndex: 'net', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
        { title: 'Luỹ kế', dataIndex: 'cumulative', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" emphasis /> },
      ]}
      summary={() => (
        <Table.Summary.Row>
          <Table.Summary.Cell index={0}>
            <FgText style="bodyS" strong>Tổng</FgText>
          </Table.Summary.Cell>
          <Table.Summary.Cell index={1} align="right"><FgMoney value={moneyFromWire(lane.total_inflow)} mode="compact" /></Table.Summary.Cell>
          <Table.Summary.Cell index={2} align="right"><FgMoney value={moneyFromWire(lane.total_outflow)} mode="compact" /></Table.Summary.Cell>
          <Table.Summary.Cell index={3} align="right"><FgMoney value={moneyFromWire(lane.total_net)} mode="compact" /></Table.Summary.Cell>
          <Table.Summary.Cell index={4} />
        </Table.Summary.Row>
      )}
    />
  );
}

function KpiRow({ totals }: { totals: CashflowHistoryResult['totals'] }): ReactNode {
  const items = [
    { label: 'Tổng thu', value: moneyFromWire(totals.inflow) },
    { label: 'Tổng chi', value: moneyFromWire(totals.outflow) },
    { label: 'Dòng tiền thuần', value: moneyFromWire(totals.net) },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
      {items.map((k) => (
        <FgCard key={k.label} className="fg-kpi">
          <FgText style="caption" color="muted">{k.label}</FgText>
          <div className="fg-kpi-value">
            <FgMoney value={k.value} mode="kpi" emphasis />
          </div>
        </FgCard>
      ))}
    </div>
  );
}

export function CashflowHistoryScreen(): ReactNode {
  const [period, setPeriod] = useState<CashflowPeriod>('1y');
  const [group, setGroup] = useState<CashflowGroup>('none');
  const query = useCashflowHistory(period, group);
  return (
    <>
      <FgPageHeader title="Lịch sử dòng tiền" meta="Thực thu · thực chi theo sổ cái — theo phạm vi dữ liệu đang chọn" />
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
        {(data) => {
          if (!data.lanes.length) {
            return (
              <div className="fg-card">
                <FgEmptyState glyph="∿" title="Chưa có dòng tiền phát sinh" description="Kỳ này chưa ghi nhận khoản thu/chi nào trong phạm vi đang chọn." />
              </div>
            );
          }
          const lanes = [...data.lanes].sort((a, b) => (laneTotal(b) > laneTotal(a) ? 1 : -1));
          return (
            <>
              <KpiRow totals={data.totals} />
              <FgCard
                title={`Dòng tiền theo tháng (${PERIODS.find((p) => p.key === period)?.label} · ${GROUPS.find((g) => g.key === group)?.label.toLowerCase()})`}
                extra={
                  <span style={{ display: 'flex', gap: 12 }}>
                    <FgText style="caption" color="muted">
                      <span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--fg-chart-2)', borderRadius: 2, marginRight: 4 }} aria-hidden />
                      Thu
                    </FgText>
                    <FgText style="caption" color="muted">
                      <span style={{ display: 'inline-block', width: 10, height: 10, background: 'var(--fg-chart-9)', borderRadius: 2, marginRight: 4 }} aria-hidden />
                      Chi
                    </FgText>
                  </span>
                }
              >
                <SwimlaneChart months={data.months} lanes={lanes} />
              </FgCard>
              {lanes.map((lane) => (
                <FgCard
                  key={lane.key}
                  collapsible
                  title={<span>{lane.label}{lane.sub_label ? <span style={{ color: 'var(--fg-text-muted)', fontWeight: 400 }}> · {lane.sub_label}</span> : null}</span>}
                  style={{ marginTop: 'var(--fg-space-4)' }}
                  padded={false}
                >
                  <LaneTable lane={lane} />
                </FgCard>
              ))}
            </>
          );
        }}
      </FgQuery>
    </>
  );
}

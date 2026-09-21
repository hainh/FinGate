/**
 * CASH-01 Dự báo dòng tiền (blueprint §XV) + SVG area chart — ngưỡng đỏ nét đứt.
 * Ô dưới ngưỡng → ô đỏ + stripe (DS §3.2).
 */

import { useState, type ReactNode } from 'react';
import { Table } from 'antd';
import { formatMoney, moneyFromWire } from '@fingate/shared';
import { useForecast } from '../app/queries.ts';
import { FgAlert, FgButton, FgMoney, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';

const HORIZONS = ['7', '30', '60', '90'] as const;

function ForecastChart({ rows }: { rows: import('../app/types.ts').ForecastRow[] }): ReactNode {
  if (!rows.length) return null;
  const vals = rows.map((r) => Number(BigInt(r.closing.minor)) / 1e9);
  const mins = rows.map((r) => Number(BigInt(r.min_balance.minor)) / 1e9);
  const max = Math.max(...vals, ...mins, 1);
  const min = Math.min(...vals, ...mins, 0);
  const H = 160;
  const span = max - min || 1;
  const y = (v: number) => H - ((v - min) / span) * (H - 10) - 5;
  const pts = vals.map((v, i) => `${(i / Math.max(1, vals.length - 1)) * 100},${y(v)}`).join(' ');
  const area = `0,${H} ${pts} 100,${H}`;
  const breach = rows.findIndex((r) => r.breach);
  let lowest = rows[0]!.closing;
  for (const r of rows) if (BigInt(r.closing.minor) < BigInt(lowest.minor)) lowest = r.closing;
  return (
    <div role="img" aria-label={`Dự báo số dư đóng thấp nhất ${formatMoney(moneyFromWire(lowest)!, { mode: 'compact' })}`}>
      <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: H, display: 'block' }}>
        <polygon points={area} fill="var(--fg-chart-1)" opacity="0.12" />
        <polyline points={pts} fill="none" stroke="var(--fg-chart-1)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {mins.map((m, i) => (
          <line
            key={i}
            x1={`${(i / Math.max(1, vals.length - 1)) * 100}%`}
            x2={`${((i + 1) / Math.max(1, vals.length - 1)) * 100}%`}
            y1={y(m)}
            y2={y(mins[i + 1] ?? m)}
            stroke="var(--fg-chart-9)"
            strokeWidth="1"
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {breach >= 0 ? <line x1={`${(breach / Math.max(1, vals.length - 1)) * 100}%`} x2={`${(breach / Math.max(1, vals.length - 1)) * 100}%`} y1="0" y2={H} stroke="var(--fg-chart-9)" strokeWidth="1" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
    </div>
  );
}

export function ForecastScreen(): ReactNode {
  const [horizon, setHorizon] = useState<string>('30');
  const query = useForecast(horizon);
  return (
    <>
      <FgPageHeader title="Dự báo dòng tiền" meta="Kế hoạch thu · phiếu chi đã duyệt · đáo hạn · chi định kỳ → số dư cuối kỳ" />
      <div className="fg-filterbar" role="group" aria-label="Tầm nhìn dự báo">
        {HORIZONS.map((h) => (
          <FgButton key={h} size="small" variant={h === horizon ? 'primary' : 'secondary'} onClick={() => setHorizon(h)}>
            {h} ngày
          </FgButton>
        ))}
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={10} cols={7} />}>
        {(data) => {
          const rows = data.rows ?? [];
          if (!rows.length) return <div className="fg-card"><FgEmptyState glyph="◇" title="Chưa đủ nguồn để dự báo" description="Cần có số dư ngân hàng và kế hoạch thu/chi." /></div>;
          return (
            <>
              {data.first_breach_date ? (
                <FgAlert tone="danger" title={`⛔ Dự kiến thủng ngưỡng tối thiểu ngày ${data.first_breach_date}`} description="Xem nguyên nhân trong bảng — cân nhắc đảo hạn hoặc dồn lịch chi." />
              ) : null}
              <FgCard title={`Đường số dư cuối kỳ (${horizon} ngày)`}>
                <ForecastChart rows={rows} />
                <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                  <FgText style="caption" color="muted">— Số dư cuối kỳ dự kiến</FgText>
                  <FgText style="caption" color="muted" >- - Ngưỡng tối thiểu</FgText>
                </div>
              </FgCard>
              <div className="fg-card" style={{ padding: 0, marginTop: 'var(--fg-space-4)' }}>
                <FgTable
                  rowKey="date"
                  dataSource={rows}
                  pagination={{ pageSize: 15, size: 'small' }}
                  columns={[
                    { title: 'Ngày', key: 'd', render: (_v, r) => <span className="fg-num">{r.weekday} {r.date.slice(8)}/{r.date.slice(5, 7)}</span> },
                    { title: 'Đầu kỳ', dataIndex: 'opening', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                    { title: 'Thu', dataIndex: 'inflow', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                    { title: 'Chi', dataIndex: 'outflow', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                    { title: 'Thuần', dataIndex: 'net', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                    {
                      title: 'Cuối kỳ',
                      dataIndex: 'closing',
                      align: 'right',
                      render: (v, r) => (
                        <span className={r.breach ? 'fg-cell-breach' : undefined} style={{ padding: r.breach ? '2px 6px' : undefined, borderRadius: 6 }}>
                          <FgMoney value={moneyFromWire(v)} mode="compact" emphasis /> {r.breach ? '⛔' : ''}
                        </span>
                      ),
                    },
                  ]}
                  summary={(pageData) => {
                    const f = pageData.reduce(
                      (acc, r) => ({
                        inflow: acc.inflow + BigInt(r.inflow.minor),
                        outflow: acc.outflow + BigInt(r.outflow.minor),
                        net: acc.net + BigInt(r.net.minor),
                      }),
                      { inflow: 0n, outflow: 0n, net: 0n },
                    );
                    return (
                      <Table.Summary.Row>
                        <Table.Summary.Cell index={0} colSpan={2}>
                          <FgText style="bodyS" strong>Tổng trong kỳ</FgText>
                        </Table.Summary.Cell>
                        <Table.Summary.Cell index={2} align="right"><FgMoney value={moneyFromWire({ minor: f.inflow.toString(), currency: 'VND', decimals: 0 })} mode="compact" /></Table.Summary.Cell>
                        <Table.Summary.Cell index={3} align="right"><FgMoney value={moneyFromWire({ minor: f.outflow.toString(), currency: 'VND', decimals: 0 })} mode="compact" /></Table.Summary.Cell>
                        <Table.Summary.Cell index={4} align="right"><FgMoney value={moneyFromWire({ minor: f.net.toString(), currency: 'VND', decimals: 0 })} mode="compact" /></Table.Summary.Cell>
                        <Table.Summary.Cell index={5} />
                      </Table.Summary.Row>
                    );
                  }}
                />
              </div>
            </>
          );
        }}
      </FgQuery>
    </>
  );
}

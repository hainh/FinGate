/**
 * RENEW-01 Bảng đáo hạn (FgMaturityTable) · LOAN-01 Danh sách khoản vay · DEBT-01/03 công nợ.
 *
 * Maturity ladder DS §3.3: 4 mức, LUÔN hiện số ngày cụ thể (không chỉ màu).
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { moneyFromWire } from '@fingate/shared';
import { useDebts, useLoans, useRollovers } from '../app/queries.ts';
import { FgButton, FgMoney, FgSelect, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgMaturityCell } from '../components/finance.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';

const BUCKETS = [
  { value: '', label: 'Mọi kỳ' },
  { value: 'today', label: 'Hôm nay' },
  { value: '3d', label: '3 ngày' },
  { value: '7d', label: '7 ngày' },
  { value: '30d', label: '30 ngày' },
];

export function RolloversScreen(): ReactNode {
  const [bucket, setBucket] = useState('30d');
  const query = useRollovers(bucket || undefined);
  return (
    <>
      <FgPageHeader
        title="Bảng đáo hạn"
        meta="Khoản vay sắp tới hạn trả nợ gốc — 4 mức rủi ro, luôn kèm số ngày cụ thể"
        actions={
          <Link to="/ngan-hang/dao-han/phuong-an/moi">
            <FgButton variant="primary">+ Lập phương án đảo hạn</FgButton>
          </Link>
        }
      />
      <div className="fg-filterbar">
        <FgSelect ariaLabel="Kỳ đáo hạn" options={BUCKETS} value={bucket} onChange={(v) => setBucket(v ?? '')} style={{ width: 160 }} />
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={5} cols={6} />}>
        {(data) => (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
              {[
                ['Hôm nay', data.kpi?.today],
                ['3 ngày', data.kpi?.d3],
                ['7 ngày', data.kpi?.d7],
                ['30 ngày', data.kpi?.d30],
              ].map(([label, m]) => (
                <FgCard key={String(label)} className="fg-kpi">
                  <FgText style="caption" color="muted">
                    Đáo hạn {String(label)}
                  </FgText>
                  <div className="fg-kpi-value" style={{ fontSize: 'var(--fg-font-number-m-size)' }}>
                    <FgMoney value={moneyFromWire(m as never)} mode="compact" />
                  </div>
                </FgCard>
              ))}
            </div>
            {!data.items.length ? (
              <div className="fg-card">
                <FgEmptyState glyph="✓" tone="success" title="Không có khoản đáo hạn nào trong kỳ đã chọn" />
              </div>
            ) : (
              <div className="fg-card" style={{ padding: 0 }}>
                <FgTable
                  rowKey="loan_id"
                  dataSource={data.items}
                  columns={[
                    { title: 'Hợp đồng', dataIndex: 'contract_code', key: 'cc' },
                    { title: 'Công ty', dataIndex: 'company_name', key: 'co' },
                    { title: 'Ngân hàng', dataIndex: 'bank_name', key: 'bn' },
                    { title: 'Dư nợ', dataIndex: 'outstanding', key: 'od', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" emphasis /> },
                    { title: 'Cần chuẩn bị', dataIndex: 'need_prepare', key: 'np', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                    {
                      title: 'Đáo hạn',
                      key: 'due',
                      render: (_v, r) => <FgMaturityCell days={r.days_to_due} tone={r.tone} label={r.label} />,
                    },
                    {
                      title: 'Phương án đảo hạn',
                      key: 'ro',
                      render: (_v, r) =>
                        r.rollover?.document_id ? (
                          <Link to={`/ho-so/dao-han/${r.rollover.document_id}?from=${encodeURIComponent(location.pathname)}`} className="fg-link">
                            {r.rollover.code ?? 'Phương án'} · {r.rollover.prepared ? '✓ đã chuẩn bị' : 'đang xử lý'}
                          </Link>
                        ) : r.level >= 2 ? (
                          <FgText style="bodyS" strong>
                            ▲ chưa lập phương án
                          </FgText>
                        ) : (
                          <FgText style="caption" color="muted">—</FgText>
                        ),
                    },
                  ]}
                />
              </div>
            )}
          </>
        )}
      </FgQuery>
    </>
  );
}

export function LoansScreen(): ReactNode {
  const query = useLoans();
  return (
    <>
      <FgPageHeader title="Vay ngân hàng" />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={5} cols={7} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState glyph="◇" title="Chưa có khoản vay nào trong phạm vi" />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable
                rowKey="_id"
                dataSource={data.items}
                columns={[
                  { title: 'HĐTD', dataIndex: 'contract_code', key: 'cc' },
                  { title: 'Ngân hàng', dataIndex: 'bank_name', key: 'bn' },
                  { title: 'Công ty', dataIndex: 'company_name', key: 'co' },
                  { title: 'Hạn mức', dataIndex: 'limit', key: 'lm', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                  { title: 'Dư nợ', dataIndex: 'outstanding', key: 'os', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" emphasis /> },
                  { title: 'Lãi suất', dataIndex: 'interest_rate', key: 'ir', render: (v: string) => `${v} %/năm` },
                  {
                    title: 'Đáo hạn',
                    key: 'md',
                    render: (_v, r) => <FgMaturityCell days={r.days_to_due} />,
                  },
                  {
                    title: 'Phương án',
                    key: 'rs',
                    render: (_v, r) => (r.rollover_status ? <FgText style="bodyS">{r.rollover_status}</FgText> : <FgText style="caption" color="muted">—</FgText>),
                  },
                ]}
              />
            </div>
          )
        }
      </FgQuery>
    </>
  );
}

export function DebtsScreen({ kind, title }: { kind: 'receivable' | 'payable'; title: string }): ReactNode {
  const [overdueOnly, setOverdueOnly] = useState(false);
  const query = useDebts(kind, overdueOnly ? { overdue_only: 'true' } : undefined);
  return (
    <>
      <FgPageHeader title={title} />
      <div className="fg-filterbar">
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} style={{ width: 18, height: 18 }} />
          Chỉ quá hạn
        </label>
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={6} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState glyph={overdueOnly ? '✓' : '◇'} tone={overdueOnly ? 'success' : 'neutral'} title={overdueOnly ? 'Không có khoản quá hạn nào' : 'Chưa có công nợ nào'} />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable
                rowKey="_id"
                dataSource={data.items}
                columns={[
                  { title: 'Đối tượng', dataIndex: 'counterparty_name', key: 'cp' },
                  { title: 'Công ty', dataIndex: 'company_name', key: 'co' },
                  { title: 'Hợp đồng', dataIndex: 'contract_code', key: 'cc', render: (v: string | null) => v ?? '—' },
                  { title: 'Giá trị', dataIndex: 'value', key: 'vl', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                  { title: 'Còn lại', dataIndex: 'remaining', key: 'rm', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" emphasis /> },
                  { title: 'Đến hạn', dataIndex: 'due_date', key: 'dd' },
                  {
                    title: 'Quá hạn',
                    key: 'ov',
                    render: (_v, r) =>
                      r.days_overdue > 0 ? (
                        <span className="fg-chip" style={{ borderColor: 'var(--fg-status-danger-border)', color: 'var(--fg-status-danger-text)', background: 'var(--fg-status-danger-bg)' }}>
                          ⛔ qua hạn {r.days_overdue} ngày
                        </span>
                      ) : (
                        <FgText style="caption" color="muted">đúng hạn</FgText>
                      ),
                  },
                ]}
              />
            </div>
          )
        }
      </FgQuery>
    </>
  );
}

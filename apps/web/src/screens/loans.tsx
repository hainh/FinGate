/**
 * Bảng đáo hạn (RENEW-01) và tiền cần chuẩn bị (RENEW-05) — v2/v2.md §10.2–10.3, §11.4.
 *  · Chỉ khoản ĐANG VAY / QUÁ HẠN vào dư nợ và bảng đáo hạn (server lọc theo trạng thái).
 *  · Khoản CHỜ GIẢI NGÂN không vào dư nợ: hiện riêng ở mục "Sắp giải ngân" (US-LOAN-02).
 *  · Số dư là số dư sổ cái hiện tại (không còn "khả dụng" / "bị hạn chế" như v1).
 * Nguồn: `/rollovers`, `/rollovers/preparation` (routes/finance.ts) và `/bank-debts?status=pending_disbursement`.
 */

import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { ddmmyyyy, moneyFromWire } from '@fingate/shared';
import { useRolloverPreparation, useRollovers } from '../app/queries.ts';
import { bankTotalsFromWire, originLabel, useLoanList, type BankTotalRow, type LoanRow } from '../app/v2/debts.ts';
import { FgButton, FgInput, FgMoneyStack, FgSelect, FgText, FgToneChip } from '../components/primitives.tsx';
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

/** Dư nợ theo từng ngân hàng + đáo hạn trong 7 / 30 ngày (US-LOAN-02, không giới hạn top 5). */
function BankTotalsSection(): ReactNode {
  // chỉ cần số liệu tổng hợp (server tính trên mọi khoản): không tải cả danh sách khoản vay
  const query = useLoanList({ summary: 'true' });
  const [bankSearch, setBankSearch] = useState('');
  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={3} cols={5} />}>
      {(d) => {
        const all: BankTotalRow[] = bankTotalsFromWire(d.by_bank);
        if (!all.length) return null;
        // lọc trên TOÀN BỘ ngân hàng (không chỉ trang đang xem) rồi mới phân trang bảng
        const needle = bankSearch.trim().toLowerCase();
        const rows = needle ? all.filter((r) => r.bank_name.toLowerCase().includes(needle)) : all;
        return (
          <div style={{ marginBottom: 'var(--fg-space-4)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--fg-space-3)', flexWrap: 'wrap', margin: '0 0 var(--fg-space-2)' }}>
              <h2 className="fg-page-title" style={{ fontSize: 'var(--fg-font-title-s-size, 16px)', margin: 0 }}>
                Dư nợ theo ngân hàng
              </h2>
              <FgInput
                allowClear
                placeholder="Tìm ngân hàng trong bảng"
                aria-label="Tìm ngân hàng trong bảng dư nợ"
                value={bankSearch}
                onChange={(e) => setBankSearch(e.target.value)}
                style={{ width: 240 }}
              />
            </div>
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable<BankTotalRow>
                rowKey="key"
                dataSource={rows}
                // hàng nhiều ngân hàng: phân trang bảng (không render cả danh sách một lượt)
                pagination={{ pageSize: 20, size: 'small', hideOnSinglePage: true }}
                columns={[
                  {
                    title: 'Ngân hàng',
                    key: 'bn',
                    render: (_v, r: BankTotalRow) =>
                      r.partner_id ? (
                        <Link className="fg-link" to={`/doi-tac/${r.partner_id}`}>
                          {r.bank_name}
                        </Link>
                      ) : (
                        r.bank_name
                      ),
                  },
                  { title: 'Số khoản', key: 'cnt', align: 'right', render: (_v, r: BankTotalRow) => r.count },
                  { title: 'Dư nợ', key: 'od', align: 'right', render: (_v, r: BankTotalRow) => <FgMoneyStack value={moneyOf(r.outstanding)} emphasis /> },
                  { title: 'Đáo hạn ≤ 7 ngày', key: 'd7', align: 'right', render: (_v, r: BankTotalRow) => <FgMoneyStack value={moneyOf(r.due7)} /> },
                  { title: 'Đáo hạn ≤ 30 ngày', key: 'd30', align: 'right', render: (_v, r: BankTotalRow) => <FgMoneyStack value={moneyOf(r.due30)} /> },
                ]}
              />
            </div>
          </div>
        );
      }}
    </FgQuery>
  );
}

/** Số tiền minor (BigInt) → kiểu Money cho ô hiển thị. */
function moneyOf(v: bigint): ReturnType<typeof moneyFromWire> {
  return moneyFromWire({ minor: v.toString(), currency: 'VND', decimals: 0 });
}

/** Khoản chờ giải ngân: tổng và danh sách — tách khỏi dư nợ và bảng đáo hạn. */
function PendingDisbursementSection(): ReactNode {
  // khoản chờ giải ngân: danh sách đầy đủ trong một lần tải (trần 1.000 của máy chủ), không phân trang —
  // để khoản vừa lập luôn thấy được trong mục này
  const query = useLoanList({ status: 'pending_disbursement', limit: 1000 });
  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={3} cols={6} />}>
      {(d) => (
        <div style={{ marginTop: 'var(--fg-space-5)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--fg-space-3)', flexWrap: 'wrap' }}>
            <h2 className="fg-page-title" style={{ fontSize: 'var(--fg-font-title-s-size, 16px)', margin: 0 }}>
              Sắp giải ngân
            </h2>
            <FgText style="caption" color="muted">
              Khoản chờ phiếu thu giải ngân về tài khoản — không tính vào dư nợ và bảng đáo hạn; vào bảng khi phiếu được thực thi.
            </FgText>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', margin: 'var(--fg-space-3) 0' }}>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">
                Tổng sắp giải ngân
              </FgText>
              <div className="fg-kpi-value" style={{ fontSize: 'var(--fg-font-number-m-size)' }}>
                <FgMoneyStack value={moneyFromWire(d.totals.pending_amount)} />
              </div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">
                Số khoản chờ
              </FgText>
              <div className="fg-kpi-value" style={{ fontSize: 'var(--fg-font-number-m-size)' }}>
                {d.totals.pending_count}
              </div>
            </FgCard>
          </div>
          {!d.items.length ? (
            <div className="fg-card">
              <FgEmptyState glyph="✓" title="Không có khoản nào đang chờ giải ngân" />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable<LoanRow>
                rowKey="_id"
                dataSource={d.items}
                columns={[
                  {
                    title: 'Mã khoản',
                    dataIndex: 'code',
                    key: 'code',
                    render: (v: string, r: LoanRow) => (
                      <Link className="fg-link" to={`/ngan-hang/khoan-vay/${r._id}`}>
                        {v}
                      </Link>
                    ),
                  },
                  { title: 'Công ty', dataIndex: 'company_name', key: 'co' },
                  {
                    title: 'Ngân hàng',
                    key: 'bn',
                    render: (_v, r: LoanRow) =>
                      r.partner_id ? (
                        <Link className="fg-link" to={`/doi-tac/${r.partner_id}`}>
                          {r.partner?.name ?? r.bank_name}
                        </Link>
                      ) : (
                        (r.partner?.name ?? r.bank_name)
                      ),
                  },
                  { title: 'Gốc', dataIndex: 'principal', key: 'pr', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                  { title: 'Đã gán giải ngân', dataIndex: 'disbursement_planned', key: 'dp', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                  { title: 'Chưa gán', dataIndex: 'undisbursed', key: 'ud', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} emphasis /> },
                  { title: 'Hạn thanh toán', dataIndex: 'maturity_date', key: 'md', render: (v: string | null) => (v ? <span className="fg-num">{ddmmyyyy(v)}</span> : '—') },
                  {
                    title: 'Nguồn',
                    key: 'origin',
                    render: (_v, r: LoanRow) =>
                      r.origin.kind === 'automation' ? <FgToneChip tone="info">{originLabel(r.origin)}</FgToneChip> : <FgText style="caption" color="muted">Thủ công</FgText>,
                  },
                ]}
              />
            </div>
          )}
        </div>
      )}
    </FgQuery>
  );
}

export function RolloversScreen(): ReactNode {
  const location = useLocation();
  const [bucket, setBucket] = useState('30d');
  const query = useRollovers(bucket || undefined);
  return (
    <>
      <FgPageHeader
        title="Bảng đáo hạn"
        meta="Khoản nợ ngân hàng đang vay sắp tới hạn trả nợ gốc — 4 mức rủi ro, luôn kèm số ngày cụ thể"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/ngan-hang/dao-han/chuan-bi">
              <FgButton>Tiền cần chuẩn bị 30 ngày</FgButton>
            </Link>
            <Link to="/ngan-hang/dao-han/phuong-an/moi">
              <FgButton variant="primary">+ Lập phương án đảo hạn</FgButton>
            </Link>
          </div>
        }
      />
      <div className="fg-filterbar">
        <FgSelect ariaLabel="Kỳ đáo hạn" options={BUCKETS} value={bucket} onChange={(v) => setBucket(v ?? '')} style={{ width: 160 }} />
      </div>
      <BankTotalsSection />
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
                    Dư nợ đáo hạn {String(label)}
                  </FgText>
                  <div className="fg-kpi-value" style={{ fontSize: 'var(--fg-font-number-m-size)' }}>
                    <FgMoneyStack value={moneyFromWire(m as never)} />
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
                    { title: 'Mã khoản', dataIndex: 'contract_code', key: 'cc' },
                    { title: 'Công ty', dataIndex: 'company_name', key: 'co' },
                    {
                      title: 'Ngân hàng',
                      key: 'bn',
                      render: (_v, r) =>
                        r.partner_id ? (
                          <Link className="fg-link" to={`/doi-tac/${r.partner_id}`}>
                            {r.bank_name}
                          </Link>
                        ) : (
                          r.bank_name
                        ),
                    },
                    { title: 'Dư nợ', dataIndex: 'outstanding', key: 'od', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} emphasis /> },
                    { title: 'Lãi dự kiến', dataIndex: 'interest_to_due', key: 'int', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                    { title: 'Cần chuẩn bị', dataIndex: 'need_prepare', key: 'np', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
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
                          // Mở chi tiết khoản vay: nút "+ Lập phương án đảo hạn" gắn sẵn khoản và ngân hàng.
                          <Link to={`/ngan-hang/khoan-vay/${r.loan_id}`} className="fg-link">
                            <FgText style="bodyS" strong>
                              ▲ chưa lập phương án — lập ngay
                            </FgText>
                          </Link>
                        ) : (
                          <FgText style="caption" color="muted">
                            —
                          </FgText>
                        ),
                    },
                  ]}
                />
              </div>
            )}
          </>
        )}
      </FgQuery>
      <PendingDisbursementSection />
    </>
  );
}

/* ====================== RENEW-05 · tiền cần chuẩn bị 30 ngày tới ====================== */

export function RolloverPreparationScreen(): ReactNode {
  const query = useRolloverPreparation();
  return (
    <>
      <FgPageHeader
        title="Tiền cần chuẩn bị cho 30 ngày tới"
        meta="Đáo hạn (gốc + lãi) cộng chi định kỳ, so với số dư sổ cái hiện tại — chỉ ra chỗ thiếu"
      />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={5} cols={4} />}>
        {(d) => (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
              {[
                ['Số dư sổ cái', d.balance],
                ['Cần chuẩn bị', d.need],
                ['Trong đó · đáo hạn', d.maturity],
                ['Trong đó · chi định kỳ', d.planned_spend],
              ].map(([label, m]) => (
                <FgCard key={String(label)} className="fg-kpi">
                  <FgText style="caption" color="muted">
                    {String(label)}
                  </FgText>
                  <div className="fg-kpi-value" style={{ fontSize: 'var(--fg-font-number-m-size)' }}>
                    <FgMoneyStack value={moneyFromWire(m as never)} />
                  </div>
                </FgCard>
              ))}
            </div>
            <FgCard className="fg-kpi" style={{ marginBottom: 'var(--fg-space-4)' }}>
              <FgText style="caption" color="muted">
                {d.breach ? 'Thiếu tiền' : 'Đủ tiền'}
              </FgText>
              <div className="fg-kpi-value" style={{ fontSize: 'var(--fg-font-number-m-size)', color: d.breach ? 'var(--fg-tone-danger-text)' : undefined }}>
                <FgMoneyStack value={moneyFromWire(d.gap)} emphasis />
              </div>
            </FgCard>
            {!d.rows.length ? (
              <div className="fg-card">
                <FgEmptyState glyph="✓" tone="success" title="Không có nghĩa vụ đáo hạn nào trong 30 ngày tới" />
              </div>
            ) : (
              <div className="fg-card" style={{ padding: 0 }}>
                <FgTable
                  rowKey={(r) => `${r.date}-${r.label}`}
                  dataSource={d.rows}
                  columns={[
                    { title: 'Ngày', dataIndex: 'date', key: 'date', render: (v: string | null) => (v ? <span className="fg-num">{ddmmyyyy(v)}</span> : '—') },
                    { title: 'Khoản', dataIndex: 'label', key: 'label' },
                    { title: 'Gốc', dataIndex: 'principal', key: 'p', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                    { title: 'Lãi', dataIndex: 'interest', key: 'i', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                    { title: 'Cần chuẩn bị', dataIndex: 'amount', key: 'a', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} emphasis /> },
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

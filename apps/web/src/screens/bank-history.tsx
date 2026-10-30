/**
 * BANK-05 — Lịch sử giao dịch của một tài khoản tiền (sổ cái).
 *
 * Mỗi dòng là một bút toán thực tế (thu/chi) với số dư đầu/cuối chạy dồn, nội dung,
 * đơn vị nhận/nộp và link tới phiếu gốc. Lọc theo kỳ (từ ngày – đến ngày, mặc định toàn bộ thời gian)
 * kèm 2 thẻ tổng thu / tổng chi của kỳ.
 */

import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { DatePicker, Select } from 'antd';
import dayjs from 'dayjs';
import { useBankAccount, useBankAccountTransactions } from '../app/queries.ts';
import { FgButton, FgDateTime, FgMoney, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSegmented, FgSkeletonTable, FgTable, FgTag } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import type { BankAccountDetail, BankPartnerStat, BankTransactionRow } from '../app/types.ts';
import { bankAccountOptionLabel } from '../app/v2/documents.ts';

/**
 * Tên TK trong tiêu đề BANK-05, ví dụ "BIDV · 122983878772 · TK lịch sử A": CÓ TÊN TK theo cùng quy ước
 * nhãn với ô chọn TK (`bankAccountOptionLabel`) để các TK cùng ngân hàng vẫn phân biệt được (v2 §4.1, bug #6).
 */
export function bankAccountTitleName(a: BankAccountDetail | null | undefined): string {
  if (!a) return 'Tài khoản tiền';
  return bankAccountOptionLabel({
    bank_name: a.bank_name,
    // màn chi tiết trả đủ số TK (API không che số), nên đưa thẳng vào trường số TK của nhãn
    account_number_masked: a.account_number,
    account_name: a.account_name,
    is_group: a.is_group,
    company_name: a.company_name,
  });
}

/** Chọn nhanh N tháng gần nhất, tính từ ngày đầu tháng: 1 tháng = từ 01 tháng này; 3 tháng = từ 01 của 2 tháng trước… */
const QUICK_RANGES: { months: number; label: string }[] = [
  { months: 1, label: '1 tháng' },
  { months: 3, label: '3 tháng' },
  { months: 6, label: '6 tháng' },
];

const DAY = 'YYYY-MM-DD';

function monthsRange(months: number): { from: string; to: string } {
  const now = dayjs();
  return { from: now.subtract(months - 1, 'month').startOf('month').format(DAY), to: now.format(DAY) };
}

type ScreenTab = 'history' | 'stats';

/** Bảng thống kê theo đối tác của kỳ; bấm tên đối tác để lọc lịch sử (bấm lại để bỏ lọc). */
function PartnerStatsCard({
  partners,
  selected,
  currency,
  onPick,
}: {
  partners: BankPartnerStat[];
  selected: string;
  currency: string;
  onPick: (key: string) => void;
}): ReactNode {
  return (
    <FgTable<BankPartnerStat>
      rowKey="key"
      dataSource={partners}
      columns={[
        {
          title: 'Đối tác',
          key: 'name',
          render: (_v, r) => (
            <button
              type="button"
              className="fg-link"
              aria-pressed={selected === r.key}
              onClick={() => onPick(r.key)}
              style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left', fontWeight: selected === r.key ? 700 : 400 }}
            >
              {r.name}
            </button>
          ),
        },
        { title: 'Số giao dịch', key: 'count', align: 'right', render: (_v, r) => r.count },
        { title: 'Tổng thu', key: 'in', align: 'right', render: (_v, r) => <FgMoney value={r.in} mode="full" /> },
        { title: 'Tổng chi', key: 'out', align: 'right', render: (_v, r) => <FgMoney value={r.out} mode="full" /> },
        {
          title: 'Chênh lệch (thu − chi)',
          key: 'net',
          align: 'right',
          render: (_v, r) => <FgMoney value={{ minor: (BigInt(r.in.minor) - BigInt(r.out.minor)).toString(), currency, decimals: 0 }} mode="full" />,
        },
      ]}
    />
  );
}

export function BankAccountHistoryScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const account = useBankAccount(id);
  // '' = không giới hạn (mặc định toàn bộ thời gian)
  const [range, setRange] = useState<{ from: string; to: string }>({ from: '', to: '' });
  // '' = tất cả đối tác; giá trị là khoá của thống kê theo đối tác (`BankPartnerStat.key`)
  const [partner, setPartner] = useState<string>('');
  // tab hiển thị: lịch sử giao dịch (mặc định) hoặc thống kê theo đối tác
  const [tab, setTab] = useState<ScreenTab>('history');
  const query = useBankAccountTransactions(id, { ...range, partner });
  const activeQuick = QUICK_RANGES.find((q) => {
    const r = monthsRange(q.months);
    return r.from === range.from && r.to === range.to;
  })?.months;
  const isAll = !range.from && !range.to;
  const isFiltered = !isAll || !!partner;
  const totals = query.data?.totals;
  const partners = query.data?.partners ?? [];
  const currency = query.data?.account.currency ?? 'VND';
  const name = bankAccountTitleName(account.data);
  return (
    <>
      <FgPageHeader
        title={`Lịch sử giao dịch · ${name}`}
        meta={
          account.data
            ? `${account.data.is_group ? 'Tài khoản Tập đoàn' : (account.data.company_name ?? '—')} · ${account.data.kind === 'cash' ? 'Tiền mặt' : 'Ngân hàng'}`
            : 'Sổ cái giao dịch của tài khoản tiền'
        }
        actions={
          <>
            <FgButton onClick={() => navigate('/ngan-hang/taikhoan')}>← Danh sách tài khoản</FgButton>
            {account.data ? (
              <Link to={`/ngan-hang/taikhoan/${id}/sua`}>
                <FgButton>Sửa tài khoản</FgButton>
              </Link>
            ) : null}
          </>
        }
      />
      <div className="fg-filterbar" role="group" aria-label="Khoảng thời gian" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <FgButton size="small" variant={isAll ? 'primary' : 'secondary'} onClick={() => setRange({ from: '', to: '' })}>
          Toàn bộ
        </FgButton>
        {QUICK_RANGES.map((q) => (
          <FgButton key={q.months} size="small" variant={activeQuick === q.months ? 'primary' : 'secondary'} onClick={() => setRange(monthsRange(q.months))}>
            {q.label}
          </FgButton>
        ))}
        <DatePicker
          placeholder="Từ ngày"
          format="DD/MM/YYYY"
          value={range.from ? dayjs(range.from) : null}
          maxDate={range.to ? dayjs(range.to) : dayjs()}
          onChange={(d) => setRange((r) => ({ ...r, from: d ? d.format(DAY) : '' }))}
          aria-label="Từ ngày"
        />
        <span className="fg-muted">–</span>
        <DatePicker
          placeholder="Đến ngày"
          format="DD/MM/YYYY"
          value={range.to ? dayjs(range.to) : null}
          minDate={range.from ? dayjs(range.from) : undefined}
          maxDate={dayjs()}
          onChange={(d) => setRange((r) => ({ ...r, to: d ? d.format(DAY) : '' }))}
          aria-label="Đến ngày"
        />
        <Select
          allowClear
          showSearch
          placeholder="Tìm theo đối tác"
          value={partner || undefined}
          onChange={(v) => setPartner(v ?? '')}
          optionFilterProp="label"
          style={{ minWidth: 260 }}
          options={partners.map((p) => ({ value: p.key, label: p.name }))}
          aria-label="Lọc theo đối tác"
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
        {[
          { label: 'Tổng thu', value: totals?.in, color: 'var(--fg-status-success-text)' },
          { label: 'Tổng chi', value: totals?.out, color: 'var(--fg-status-danger-text)' },
        ].map((k) => (
          <FgCard key={k.label} className="fg-kpi">
            <FgText style="caption" color="muted">
              {k.label}
            </FgText>
            <div className="fg-kpi-value" style={{ color: k.color }}>
              <FgMoney value={k.value} mode="full" emphasis />
            </div>
          </FgCard>
        ))}
      </div>
      <FgSegmented<ScreenTab>
        value={tab}
        onChange={setTab}
        options={[
          { value: 'history', label: 'Lịch sử giao dịch' },
          { value: 'stats', label: 'Thống kê theo đối tác' },
        ]}
        style={{ marginBottom: 'var(--fg-space-4)' }}
      />
      {tab === 'stats' ? (
        query.isPending ? (
          <FgSkeletonTable rows={4} cols={5} />
        ) : partners.length ? (
          <PartnerStatsCard partners={partners} selected={partner} currency={currency} onPick={(key) => setPartner((cur) => (cur === key ? '' : key))} />
        ) : (
          <div className="fg-card">
            <FgEmptyState glyph="≡" title="Chưa có đối tác" description="Kỳ này chưa có giao dịch nào để thống kê." />
          </div>
        )
      ) : (
      <FgQuery
        query={query}
        skeleton={<FgSkeletonTable rows={8} cols={8} />}
        empty={<div className="fg-card"><FgEmptyState glyph="≡" title="Chưa có giao dịch" description={isFiltered ? 'Không có giao dịch phù hợp với bộ lọc đã chọn.' : 'Tài khoản chưa ghi nhận phiếu thu/chi nào đã thực thi.'} /></div>}
      >
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState
                glyph="≡"
                title="Chưa có giao dịch"
                description={isFiltered ? 'Không có giao dịch phù hợp với bộ lọc đã chọn.' : 'Tài khoản chưa ghi nhận phiếu thu/chi nào đã thực thi.'}
              />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable<BankTransactionRow>
                rowKey="_id"
                dataSource={data.items}
                columns={[
                  {
                    title: 'Thời điểm',
                    dataIndex: 'at',
                    key: 'at',
                    align: 'right',
                    render: (v: string | null) => <FgDateTime value={v} seconds />,
                  },
                  {
                    title: 'Loại',
                    key: 'dir',
                    render: (_v, r) => <FgTag tone={r.direction_tone}>{r.direction_label}</FgTag>,
                  },
                  {
                    title: 'Số dư đầu',
                    key: 'opening',
                    align: 'right',
                    render: (_v, r) => <FgMoney value={r.opening} mode="full" missingLabel="—" />,
                  },
                  {
                    title: 'Số tiền',
                    key: 'amount',
                    align: 'right',
                    render: (_v, r) => (
                      <span style={{ color: r.direction === 'in' ? 'var(--fg-status-success-text)' : 'var(--fg-status-danger-text)', fontWeight: 600 }}>
                        {r.direction === 'in' ? '+' : '−'}
                        <FgMoney value={r.amount} mode="full" />
                      </span>
                    ),
                  },
                  {
                    title: 'Số dư cuối',
                    key: 'closing',
                    align: 'right',
                    render: (_v, r) => <FgMoney value={r.closing} mode="full" missingLabel="—" />,
                  },
                  // Số dư tổng (số dư cuối + tiền lưu trữ lúc giao dịch) — ẩn với tài khoản ngân hàng
                  ...(data.account.kind === 'bank'
                    ? []
                    : [
                        {
                          title: 'Số dư tổng',
                          key: 'total',
                          align: 'right' as const,
                          render: (_v: unknown, r: BankTransactionRow) => <FgMoney value={r.total} mode="full" missingLabel="—" emphasis />,
                        },
                      ]),
                  {
                    title: 'Nội dung',
                    key: 'content',
                    render: (_v, r) => <span>{r.content || '—'}</span>,
                  },
                  {
                    title: 'Đơn vị (nhận/nộp)',
                    key: 'cp',
                    render: (_v, r) => (
                      <span>
                        {r.partner_id ? (
                          <Link to={`/doi-tac/${r.partner_id}`} className="fg-link">
                            {r.counterparty}
                          </Link>
                        ) : (
                          r.counterparty || '—'
                        )}
                      </span>
                    ),
                  },
                  {
                    title: 'Chi tiết',
                    key: 'doc',
                    render: (_v, r) =>
                      r.document ? (
                        <Link to={r.document.href}>
                          <span className="fg-mono" style={{ fontWeight: 600 }}>
                            {r.document.code}
                          </span>
                        </Link>
                      ) : (
                        <span className="fg-muted">—</span>
                      ),
                  },
                ]}
              />
            </div>
          )
        }
      </FgQuery>
      )}
    </>
  );
}

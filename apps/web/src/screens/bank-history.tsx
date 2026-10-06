/**
 * BANK-05 — Lịch sử giao dịch của một tài khoản tiền (sổ cái).
 *
 * Mỗi dòng là một bút toán thực tế (thu/chi) với số dư đầu/cuối chạy dồn, nội dung,
 * đơn vị nhận/nộp và link tới phiếu gốc.
 */

import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import dayjs from 'dayjs';
import { useBankAccount, useBankAccountTransactions } from '../app/queries.ts';
import { FgButton, FgMoney } from '../components/primitives.tsx';
import { FgEmptyState, FgSkeletonTable, FgTable, FgTag } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import type { BankTransactionRow } from '../app/types.ts';

/** Ngày giờ chính xác tới giây (giờ địa phương). */
function atLabel(at: string | null): string {
  if (!at) return '—';
  const d = dayjs(at);
  return d.isValid() ? d.format('DD/MM/YYYY HH:mm:ss') : '—';
}

export function BankAccountHistoryScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const account = useBankAccount(id);
  const query = useBankAccountTransactions(id);
  const name = account.data ? `${account.data.bank_name} ${account.data.account_number}` : 'Tài khoản tiền';
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
      <FgQuery
        query={query}
        skeleton={<FgSkeletonTable rows={8} cols={8} />}
        empty={<div className="fg-card"><FgEmptyState glyph="≡" title="Chưa có giao dịch" description="Tài khoản chưa ghi nhận phiếu thu/chi nào đã thực thi." /></div>}
      >
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState glyph="≡" title="Chưa có giao dịch" description="Tài khoản chưa ghi nhận phiếu thu/chi nào đã thực thi." />
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
                    render: (v: string | null) => <span className="fg-num">{atLabel(v)}</span>,
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
                  {
                    title: 'Nội dung',
                    key: 'content',
                    render: (_v, r) => <span>{r.content || '—'}</span>,
                  },
                  {
                    title: 'Đơn vị (nhận/nộp)',
                    key: 'cp',
                    render: (_v, r) => <span>{r.counterparty || '—'}</span>,
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
    </>
  );
}

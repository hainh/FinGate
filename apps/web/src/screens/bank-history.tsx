/**
 * BANK-05 — Lịch sử giao dịch của một tài khoản tiền (sổ cái).
 *
 * Mỗi dòng là một bút toán thực tế (thu/chi) với số dư đầu/cuối chạy dồn, nội dung,
 * đơn vị nhận/nộp và link tới phiếu gốc.
 */

import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useBankAccount, useBankAccountTransactions } from '../app/queries.ts';
import { FgButton, FgDateTime, FgMoney } from '../components/primitives.tsx';
import { FgEmptyState, FgSkeletonTable, FgTable, FgTag } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import type { BankAccountDetail, BankTransactionRow } from '../app/types.ts';
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

export function BankAccountHistoryScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const account = useBankAccount(id);
  const query = useBankAccountTransactions(id);
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
    </>
  );
}

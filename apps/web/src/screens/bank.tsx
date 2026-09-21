/**
 * BANK-01 Tài khoản NH (blueprint §VIII).
 */

import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { moneyFromWire } from '@fingate/shared';
import { useBankAccounts } from '../app/queries.ts';
import { useAuth } from '../app/store.tsx';
import { FgButton, FgMoney, FgText } from '../components/primitives.tsx';
import { FgSegmented, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import type { BankAccountRow } from '../app/types.ts';

export function BankAccountsScreen(): ReactNode {
  const query = useBankAccounts();
  const { can } = useAuth();
  const [kindFilter, setKindFilter] = useState<'all' | 'cash' | 'bank'>('all');
  const canEdit = (r: BankAccountRow) => can('bank:write') && (!r.is_group || can('admin:group_accounts'));
  return (
    <>
      <FgPageHeader
        title="Tài khoản tiền"
        meta="Quản lý tài khoản tiền mặt và tài khoản ngân hàng — của công ty và Tập đoàn"
        actions={
          can('bank:write') ? (
            <FgTooltipNew />
          ) : undefined
        }
      />
      <div style={{ marginBottom: 'var(--fg-space-3)' }}>
        <FgSegmented
          value={kindFilter}
          onChange={(v) => setKindFilter(v as 'all' | 'cash' | 'bank')}
          options={[
            { label: 'Tất cả', value: 'all' },
            { label: 'Tiền mặt', value: 'cash' },
            { label: 'Ngân hàng', value: 'bank' },
          ]}
        />
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={7} />}>
        {(data) => {
          const items = kindFilter === 'all' ? data.items : data.items.filter((a) => a.kind === kindFilter);
          return (
          <div className="fg-card" style={{ padding: 0 }}>
            <FgTable<BankAccountRow>
              rowKey="_id"
              dataSource={items}
              columns={[
                {
                  title: 'Tài khoản',
                  key: 'tk',
                  render: (_v, r) => (
                    <div>
                      <FgText strong>{r.label}</FgText>
                      <br />
                      <FgText style="caption" color="muted">
                        {r.is_group ? 'Tài khoản Tập đoàn' : r.company_name} · {r.account_name}
                      </FgText>
                    </div>
                  ),
                },
                {
                  title: 'Hình thức',
                  key: 'kind',
                  width: 110,
                  render: (_v, r) =>
                    r.kind === 'cash' ? (
                      <span className="fg-chip" style={{ borderColor: 'var(--fg-status-attention-border)', color: 'var(--fg-status-attention-text)', background: 'var(--fg-status-attention-bg)' }}>
                        Tiền mặt
                      </span>
                    ) : (
                      <span className="fg-chip" style={{ borderColor: 'var(--fg-status-neutral-border)', color: 'var(--fg-status-neutral-text)' }}>
                        Ngân hàng
                      </span>
                    ),
                },
                { title: 'Số TK / Mã quỹ', dataIndex: 'account_number_masked', key: 'num', render: (v: string) => <span className="fg-mono">{v}</span> },
                { title: 'Loại tiền', dataIndex: 'currency', key: 'cur', width: 90 },
                {
                  title: 'Số dư',
                  key: 'bal',
                  align: 'right',
                  render: (_v, r) => <FgMoney value={moneyFromWire(r.balance)} mode="compact" missingLabel="—" />,
                },
                {
                  title: 'Khả dụng',
                  key: 'avail',
                  align: 'right',
                  render: (_v, r) => (
                    <span className={r.breach ? 'fg-cell-breach' : undefined} style={{ padding: r.breach ? '2px 6px' : undefined, borderRadius: 'var(--fg-radius-sm)' }}>
                      <FgMoney value={moneyFromWire(r.available)} mode="compact" />
                      {r.breach ? ' ⛔' : ''}
                    </span>
                  ),
                },
                {
                  title: 'Ngưỡng tối thiểu',
                  key: 'min',
                  align: 'right',
                  render: (_v, r) => <FgMoney value={moneyFromWire(r.min_balance)} mode="compact" />,
                },
                {
                  title: 'Trạng thái',
                  key: 'st',
                  render: (_v, r) =>
                    r.status !== 'active' ? (
                      <span className="fg-chip" style={{ borderColor: 'var(--fg-status-neutral-border)', color: 'var(--fg-status-neutral-text)' }}>
                        {r.status === 'closed' ? 'Đã đóng' : 'Bị phong tỏa'}
                      </span>
                    ) : r.stale ? (
                      <span className="fg-chip" style={{ borderColor: 'var(--fg-status-attention-border)', color: 'var(--fg-status-attention-text)', background: 'var(--fg-status-attention-bg)' }}>
                        ▲ Chưa có số dư hôm nay
                      </span>
                    ) : (
                      <span className="fg-chip" style={{ borderColor: 'var(--fg-status-success-border)', color: 'var(--fg-status-success-text)', background: 'var(--fg-status-success-bg)' }}>
                        ✓ Hoạt động
                      </span>
                    ),
                },
                {
                  title: '',
                  key: 'act',
                  width: 90,
                  render: (_v, r) =>
                    canEdit(r) ? (
                      <Link to={`/ngan-hang/taikhoan/${r._id}/sua`}>
                        <FgButton size="small">Sửa</FgButton>
                      </Link>
                    ) : null,
                },
              ]}
            />
          </div>
          );
        }}
      </FgQuery>
    </>
  );
}

function FgTooltipNew(): ReactNode {
  return (
    <Link to="/ngan-hang/taikhoan/moi">
      <FgButton variant="primary">+ Thêm tài khoản</FgButton>
    </Link>
  );
}


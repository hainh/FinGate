/**
 * BANK-01 Tài khoản tiền (blueprint §VIII · v2 §4.2).
 *
 * v2: số dư = sổ cái (thực tế) + dự kiến (phiếu đã duyệt chờ thực thi). Không còn "khả dụng" / "bị phong toả"
 * nhập tay. Trạng thái `Phong toả` vẫn là trạng thái của TÀI KHOẢN (khoá không chọn cho phiếu mới).
 */

import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { moneyFromWire } from '@fingate/shared';
import { useBankAccountsPage } from '../app/queries.ts';
import { useAuth } from '../app/store.tsx';
import { FgButton, FgMoney, FgMoneyStack, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgPagination, FgSegmented, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import type { BankAccountRow } from '../app/types.ts';

/** Cỡ trang danh sách tài khoản (phân trang phía máy chủ — `items` chỉ gồm một trang). */
const BANK_ACCOUNT_PAGE_SIZE = 50;

export function BankAccountsScreen(): ReactNode {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [kindFilter, setKindFilter] = useState<'all' | 'cash' | 'bank'>('all');
  const [page, setPage] = useState(1);
  const query = useBankAccountsPage({
    page,
    limit: BANK_ACCOUNT_PAGE_SIZE,
    kind: kindFilter === 'all' ? undefined : kindFilter,
  });
  const canEdit = (r: BankAccountRow) => can('bank:write') && (!r.is_group || can('admin:group_accounts'));
  return (
    <>
      <FgPageHeader
        title="Tài khoản tiền"
        meta="Số dư lấy từ sổ cái và phiếu chờ thực thi — không nhập tay. Tiền mặt & ngân hàng của công ty và Tập đoàn"
        actions={can('bank:write') ? <FgTooltipNew /> : undefined}
      />
      <div style={{ marginBottom: 'var(--fg-space-3)' }}>
        <FgSegmented
          value={kindFilter}
          onChange={(v) => {
            setKindFilter(v as 'all' | 'cash' | 'bank');
            setPage(1);
          }}
          options={[
            { label: 'Tất cả', value: 'all' },
            { label: 'Tiền mặt', value: 'cash' },
            { label: 'Ngân hàng', value: 'bank' },
          ]}
        />
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={7} />}>
        {(data) => {
          return (
            <>
              {data.totals ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
                  <FgCard className="fg-kpi">
                    <FgText style="caption" color="muted">Tổng số dư sổ cái</FgText>
                    <div className="fg-kpi-value">
                      <FgMoney value={moneyFromWire(data.totals.balance)} mode="full" emphasis />
                    </div>
                  </FgCard>
                  <FgCard className="fg-kpi">
                    <FgText style="caption" color="muted">Dự kiến sau 30 ngày</FgText>
                    <div className="fg-kpi-value">
                      <FgMoney value={moneyFromWire(data.totals.projected)} mode="full" emphasis />
                    </div>
                  </FgCard>
                </div>
              ) : null}
              {!data.items.length && page > 1 ? (
                <div className="fg-card">
                  <FgEmptyState glyph="◇" title="Trang này không còn tài khoản nào" action={<FgButton onClick={() => setPage(1)}>Về trang 1</FgButton>} />
                </div>
              ) : (
                <div className="fg-card" style={{ padding: 0 }}>
                  <FgTable<BankAccountRow>
                    rowKey="_id"
                    dataSource={data.items}
                    onRow={(r) => ({
                      onClick: () => navigate(`/ngan-hang/taikhoan/${r._id}`),
                      style: { cursor: 'pointer' },
                      title: 'Xem lịch sử giao dịch',
                    })}
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
                      { title: 'Loại tiền', dataIndex: 'currency', key: 'cur' },
                      {
                        title: 'Số dư sổ cái',
                        key: 'bal',
                        align: 'right',
                        render: (_v, r) => (
                          <span className={r.breach ? 'fg-cell-breach' : undefined} style={{ padding: r.breach ? '2px 6px' : undefined, borderRadius: 'var(--fg-radius-sm)' }}>
                            <FgMoneyStack value={r.balance} missingLabel="—" />
                            {r.breach ? ' ⛔' : ''}
                          </span>
                        ),
                      },
                      {
                        title: 'Dự kiến 30 ngày',
                        key: 'proj',
                        align: 'right',
                        render: (_v, r) => (
                          <span className={r.breach_projected ? 'fg-cell-breach' : undefined} style={{ padding: r.breach_projected ? '2px 6px' : undefined, borderRadius: 'var(--fg-radius-sm)' }}>
                            <FgMoneyStack value={r.projected} missingLabel="—" />
                            {r.breach_projected ? ' ▲' : ''}
                          </span>
                        ),
                      },
                      {
                        title: 'Ngưỡng tối thiểu',
                        key: 'min',
                        align: 'right',
                        render: (_v, r) => <FgMoneyStack value={r.min_balance} />,
                      },
                      {
                        title: 'Trạng thái',
                        key: 'st',
                        render: (_v, r) =>
                          r.status !== 'active' ? (
                            <span className="fg-chip" style={{ borderColor: 'var(--fg-status-neutral-border)', color: 'var(--fg-status-neutral-text)' }}>
                              {r.status === 'closed' ? 'Đã đóng' : 'Phong toả'}
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
                        render: (_v, r) =>
                          canEdit(r) ? (
                            <span onClick={(e) => e.stopPropagation()}>
                              <Link to={`/ngan-hang/taikhoan/${r._id}/sua`}>
                                <FgButton size="small">Sửa</FgButton>
                              </Link>
                            </span>
                          ) : null,
                      },
                    ]}
                  />
                  {data.total > BANK_ACCOUNT_PAGE_SIZE ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--fg-space-2)', padding: 'var(--fg-space-4) 0' }}>
                      <FgText style="caption" color="muted">
                        {`Hiển thị ${(page - 1) * BANK_ACCOUNT_PAGE_SIZE + 1}–${Math.min(page * BANK_ACCOUNT_PAGE_SIZE, data.total)} / ${data.total} tài khoản`}
                      </FgText>
                      <FgPagination current={page} pageSize={BANK_ACCOUNT_PAGE_SIZE} total={data.total} showSizeChanger={false} onChange={(p) => setPage(p)} />
                    </div>
                  ) : null}
                </div>
              )}
            </>
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

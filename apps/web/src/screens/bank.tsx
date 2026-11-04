/**
 * BANK-01 Tài khoản tiền (blueprint §VIII · v2 §4.2).
 *
 * v2: số dư = sổ cái (thực tế) + dự kiến (phiếu đã duyệt chờ thực thi). Không còn "khả dụng" / "bị phong toả"
 * nhập tay. Trạng thái `Phong toả` vẫn là trạng thái của TÀI KHOẢN (khoá không chọn cho phiếu mới).
 *
 * Bộ lọc loại TK (Tất cả / Tiền mặt / Ngân hàng / Quỹ phụ): `kind` gửi xuống server, và server trả
 * `totals` ĐÃ tính trên tập đã lọc ⇒ KPI đổi theo nút lọc đang chọn (không tự cộng từ `items`).
 *
 * Phạm vi công ty con: khi bộ chuyển phạm vi đang chọn MỘT công ty con (`scope` ≠ 'all'), màn này chỉ hiện
 * tài khoản / quỹ của công ty con đó — KHÔNG hiện tài khoản của Tập đoàn nữa (`group=subsidiary`, KPI cũng
 * tính lại trên tập đó). Ở "Tất cả công ty" thì vẫn thấy TK Tập đoàn để theo dõi số dư như trước.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { moneyFromWire } from '@fingate/shared';
import { useBankAccountsPage, useCompanies } from '../app/queries.ts';
import { SCOPE_ALL, useAuth } from '../app/store.tsx';
import { FgButton, FgMoney, FgMoneyStack, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgPagination, FgSegmented, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import type { BankAccountRow } from '../app/types.ts';
import { onSortChange, withServerSort } from '../app/table-sort.ts';

/** Cỡ trang danh sách tài khoản (phân trang phía máy chủ — `items` chỉ gồm một trang). */
const BANK_ACCOUNT_PAGE_SIZE = 50;

/** Loại TK cho bộ lọc màn danh sách — khớp `kind` của API (`fund` = Quỹ phụ, giống quỹ tiền mặt). */
type KindFilter = 'all' | 'cash' | 'bank' | 'fund';
const KIND_FILTER_OPTIONS: { label: string; value: KindFilter }[] = [
  { label: 'Tất cả', value: 'all' },
  { label: 'Tiền mặt', value: 'cash' },
  { label: 'Ngân hàng', value: 'bank' },
  { label: 'Quỹ phụ', value: 'fund' },
];

/** Chip cột "Hình thức": mỗi loại TK một màu để quét nhanh (quỹ phụ khác cả tiền mặt lẫn ngân hàng). */
const KIND_CHIP: Record<string, { label: string; style: CSSProperties }> = {
  cash: { label: 'Tiền mặt', style: { borderColor: 'var(--fg-status-attention-border)', color: 'var(--fg-status-attention-text)', background: 'var(--fg-status-attention-bg)' } },
  fund: { label: 'Quỹ phụ', style: { borderColor: 'var(--fg-status-info-border)', color: 'var(--fg-status-info-text)', background: 'var(--fg-status-info-bg)' } },
  bank: { label: 'Ngân hàng', style: { borderColor: 'var(--fg-status-neutral-border)', color: 'var(--fg-status-neutral-text)' } },
};

export function BankAccountsScreen(): ReactNode {
  const { can, scope } = useAuth();
  const navigate = useNavigate();
  const companies = useCompanies();
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('');
  // Phạm vi là MỘT công ty (≠ "Tất cả công ty") ⇒ chỉ xem tài khoản của công ty con đó: server bỏ hẳn
  // tài khoản / quỹ của Tập đoàn. Chức danh cấp Tập đoàn chọn pháp nhân Tập đoàn thì vẫn xem TK Tập đoàn
  // (đó là công ty của chính họ). Chưa tải xong danh sách công ty ⇒ chưa gửi cờ (server trả như cũ).
  const scopedCompany = scope === SCOPE_ALL ? null : (companies.data?.items ?? []).find((c) => c._id === scope);
  const viewingSubsidiary = scopedCompany ? !scopedCompany.is_group : false;
  // Chưa tải xong danh sách công ty: chưa biết phạm vi là công ty con hay pháp nhân Tập đoàn ⇒ hiện như cũ.
  const scopeKnown = scope === SCOPE_ALL || !!scopedCompany;
  const query = useBankAccountsPage({
    page,
    limit: BANK_ACCOUNT_PAGE_SIZE,
    kind: kindFilter === 'all' ? undefined : kindFilter,
    group: viewingSubsidiary ? 'subsidiary' : undefined,
    sort,
  });
  const canEdit = (r: BankAccountRow) => can('bank:write') && (!r.is_group || can('admin:group_accounts'));
  // Nhãn KPI theo bộ lọc đang chọn — totals do server tính trên ĐÚNG tập đã lọc (kể cả phạm vi công ty con).
  const filterLabel = KIND_FILTER_OPTIONS.find((o) => o.value === kindFilter)?.label ?? 'Tất cả';
  return (
    <>
      <FgPageHeader
        title="Tài khoản tiền"
        meta={
          viewingSubsidiary && scopedCompany
            ? `Số dư lấy từ sổ cái và phiếu chờ thực thi — không nhập tay. Chỉ tài khoản của ${scopedCompany.name} (không gồm tài khoản Tập đoàn)`
            : 'Số dư lấy từ sổ cái và phiếu chờ thực thi — không nhập tay. Tiền mặt, quỹ phụ & ngân hàng của công ty và Tập đoàn'
        }
        actions={can('bank:write') ? <FgTooltipNew /> : undefined}
      />
      <div style={{ marginBottom: 'var(--fg-space-3)' }}>
        <FgSegmented
          value={kindFilter}
          onChange={(v) => {
            setKindFilter(v as KindFilter);
            setPage(1);
          }}
          options={KIND_FILTER_OPTIONS}
        />
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={7} />}>
        {(data) => {
          // Phạm vi chưa rõ (đang tải danh sách công ty): lọc thêm ở client để không nháy TK Tập đoàn.
          const rows = scopeKnown ? data.items : data.items.filter((r) => !r.is_group);
          return (
            <>
              {data.totals ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
                  <FgCard className="fg-kpi">
                    <FgText style="caption" color="muted">
                      {`Tổng số dư sổ cái${kindFilter === 'all' ? '' : ` · ${filterLabel}`}`}
                    </FgText>
                    <div className="fg-kpi-value">
                      <FgMoney value={moneyFromWire(data.totals.balance)} mode="full" emphasis />
                    </div>
                  </FgCard>
                  <FgCard className="fg-kpi">
                    <FgText style="caption" color="muted">
                      {`Dự kiến sau 30 ngày${kindFilter === 'all' ? '' : ` · ${filterLabel}`}`}
                    </FgText>
                    <div className="fg-kpi-value">
                      <FgMoney value={moneyFromWire(data.totals.projected)} mode="full" emphasis />
                    </div>
                  </FgCard>
                </div>
              ) : null}
              {!rows.length && page > 1 ? (
                <div className="fg-card">
                  <FgEmptyState glyph="◇" title="Trang này không còn tài khoản nào" action={<FgButton onClick={() => setPage(1)}>Về trang 1</FgButton>} />
                </div>
              ) : (
                <div className="fg-card" style={{ padding: 0 }}>
                  <FgTable<BankAccountRow>
                    rowKey="_id"
                    dataSource={rows}
                    onRow={(r) => ({
                      onClick: () => navigate(`/ngan-hang/taikhoan/${r._id}`),
                      style: { cursor: 'pointer' },
                      title: 'Xem lịch sử giao dịch',
                    })}
                    onChange={onSortChange((s) => {
                      setSort(s);
                      setPage(1);
                    })}
                    columns={withServerSort<BankAccountRow>([
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
                        render: (_v, r) => {
                          const chip = KIND_CHIP[r.kind] ?? { label: r.kind, style: KIND_CHIP.bank.style };
                          return (
                            <span className="fg-chip" style={chip.style}>
                              {chip.label}
                            </span>
                          );
                        },
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
                    ], ['tk', 'kind', 'num', 'cur', 'bal', 'proj', 'min', 'st'], sort)}
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

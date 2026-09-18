/**
 * Khung "List + FilterBar + Table" (screens §21) dùng cho:
 * APPR-01 Chờ tôi duyệt (/queue) · APPR-02 · APPR-03 · CHI-01/04/07 · THU-01/04.
 *
 * URL là state của danh sách: /chi?status=pending.gd&q=ABC&sort=-waiting —
 * deep-link từ notification mở đúng hồ sơ và QUAY LẠI vẫn giữ bộ lọc (?from=).
 * Bulk bar hiển thị TỔNG TIỀN tính qua shared `sum()` (BigInt minor units, không Number()).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  STATUS_KEYS,
  daysBetween,
  deadlineLabel,
  formatMoney,
  isDeadlinePast,
  money,
  moneyFromWire,
  statusLabel,
  sum,
  today,
} from '@fingate/shared';
import { useDocuments, useProcessed, useQueue, type DocListFilters } from '../app/queries.ts';
import type { QueueRow } from '../app/types.ts';
import { FgButton, FgMoney, FgSelect, FgStatusChip, FgText } from '../components/primitives.tsx';
import { FgEmptyState, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import type { TableColumnsType } from 'antd';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useDebounced } from '../components/pagekit.tsx';
import { useAuth } from '../app/store.tsx';
import { OwnerLine } from '../components/finance.tsx';
import { BulkApproveModal } from './approve-modal.tsx';
import { FgTooltip } from '../components/primitives.tsx';

const STATUS_OPTIONS = [
  { value: '', label: 'Mọi trạng thái' },
  ...STATUS_KEYS.filter((k) => k !== 'overdue').map((k) => ({ value: k, label: statusLabel(k) })),
];

const SORTS = [
  { value: '-waiting', label: 'Chờ lâu nhất' },
  { value: '-amount', label: 'Số tiền lớn nhất' },
  { value: '-planned_date', label: 'Hạn thanh toán gần nhất' },
  { value: '-created_at', label: 'Mới tạo trước' },
];

const MINE_OPTIONS = [
  { value: '', label: 'Mọi hồ sơ' },
  { value: 'created', label: 'Do tôi tạo' },
  { value: 'to_approve', label: 'Chờ tôi duyệt' },
  { value: 'approved_by_me', label: 'Tôi đã duyệt' },
];

export function useDocColumns(sortable = false): TableColumnsType<QueueRow> {
  return useMemo(
    () =>
      [
        {
          title: 'Mã / loại',
          dataIndex: 'code',
          key: 'code',
          sorter: sortable ? (a: QueueRow, b: QueueRow) => a.code.localeCompare(b.code) : undefined,
          render: (_v: unknown, r: QueueRow) => (
            <div>
              <Link to={deepLink(r)} className="fg-link" style={{ fontWeight: 500 }}>
                {r.code}
              </Link>
              <br />
              <FgText style="caption" color="muted">
                {r.kind_label}
                {r.fast_tracked_by ? ' · ⚡ duyệt trước' : ''}
              </FgText>
            </div>
          ),
        },
        {
          title: 'Nội dung',
          dataIndex: 'title',
          key: 'title',
          ellipsis: true,
          render: (_v: unknown, r: QueueRow) => (
            <div>
              <FgText style="bodyS">{r.title}</FgText>
              <br />
              <FgText style="caption" color="muted">
                {r.company_name} · {r.payee_name}
                {r.missing_evidence_count ? (
                  <span style={{ color: 'var(--fg-status-attention-text)' }}> · ⚠ thiếu {r.missing_evidence_count} chứng từ</span>
                ) : null}
              </FgText>
            </div>
          ),
        },
        {
          title: 'Số tiền',
          dataIndex: 'amount',
          key: 'amount',
          align: 'right',
          sorter: (a: QueueRow, b: QueueRow) => Number(BigInt(a.amount.minor) - BigInt(b.amount.minor)),
          render: (_v: unknown, r: QueueRow) => (
            <FgTooltip title={formatMoney(moneyFromWire(r.amount)!, { mode: 'full' })}>
              <span>
                <FgMoney value={moneyFromWire(r.amount)} mode="compact" emphasis />
              </span>
            </FgTooltip>
          ),
        },
        {
          title: 'Trạng thái',
          dataIndex: 'status',
          key: 'status',
          render: (_v: unknown, r: QueueRow) => <FgStatusChip status={r.status} overdue={r.overdue} waitingDays={r.waiting_days} />,
        },
        {
          title: 'Bàn xử lý',
          key: 'owner',
          render: (_v: unknown, r: QueueRow) =>
            r.current_owner ? (
              <OwnerLine owner={r.owner_name ?? r.current_owner} roleLabel={r.current_owner} waitingDays={r.waiting_days} />
            ) : (
              <FgText style="caption" color="muted">
                —
              </FgText>
            ),
        },
        {
          title: 'Hạn thanh toán',
          dataIndex: 'planned_date',
          key: 'planned_date',
          sorter: sortable ? (a: QueueRow, b: QueueRow) => (a.planned_date ?? '').localeCompare(b.planned_date ?? '') : undefined,
          render: (v: string, r: QueueRow) => {
            const late = isDeadlinePast(v) && !['paid', 'cancelled', 'rejected'].includes(r.status);
            return (
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <span className="fg-num">{deadlineLabel(v)}</span>
                {late ? (
                  <span className="fg-chip" style={{ borderColor: 'var(--fg-status-danger-border)', color: 'var(--fg-status-danger-text)', background: 'var(--fg-status-danger-bg)' }}>
                    Quá hạn
                  </span>
                ) : null}
              </span>
            );
          },
        },
      ] as TableColumnsType<QueueRow>,
    [sortable],
  );
}

/** giữ bộ lọc nguồn trong URL khi mở hồ sơ (DoD deep-link). */
function deepLink(r: QueueRow): string {
  const from = encodeURIComponent(window.location.pathname + window.location.search);
  return `${r.href}?from=${from}`;
}

export interface DocListConfig {
  title: string;
  source: 'queue' | 'documents' | 'processed';
  fixed?: Partial<DocListFilters>;
  /** chọn nhiều + duyệt hàng loạt (APPR-01). */
  bulk?: boolean;
  createHref?: string;
  createLabel?: string;
  /** sắp xếp trực tiếp trên cột bảng (ẩn dropdown "Sắp xếp" ở thanh lọc). */
  sortOnTable?: boolean;
}

export function DocListScreen({ title, source, fixed = {}, bulk, createHref, createLabel, sortOnTable = false }: DocListConfig): ReactNode {
  const { can } = useAuth();
  const canCreate = can('doc:create');
  const [params, setParams] = useUrlSearchParamsShim();
  const get = (k: string) => params.get(k) ?? '';
  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete('page');
    setParams(next);
  };

  const [qText, setQText] = useState(get('q'));
  const qDebounced = useDebounced(qText, 300);
  useEffect(() => {
    // URL đổi từ ngoài (nút Xóa lọc, deep-link) → ô tìm theo
    if (get('q') !== qText) setQText(get('q'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get('q')]);
  useEffect(() => {
    if (qDebounced !== get('q')) setFilter('q', qDebounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDebounced]);

  const filters: DocListFilters = useMemo(
    () => ({
      ...fixed,
      q: qDebounced || undefined,
      status: get('status') || (fixed.status as DocListFilters['status']) || undefined,
      mine: (get('mine') as DocListFilters['mine']) || fixed.mine,
      sort: get('sort') || fixed.sort || '-waiting',
      overdue_only: fixed.overdue_only,
      limit: 100,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qDebounced, get('status'), get('mine'), get('sort'), fixed],
  );

  const queue = useQueue({ limit: 100 });
  const docs = useDocuments(filters);
  const processed = useProcessed(100);
  const query = source === 'queue' ? queue : source === 'processed' ? processed : docs;

  const [selected, setSelected] = useState<Record<string, QueueRow>>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const anyFilter = Boolean(qDebounced || get('status') || get('mine'));
  const columns = useDocColumns(sortOnTable);
  const selectable = Boolean(bulk);

  const selectedList = Object.values(selected);
  const selectedTotal = useMemo(
    () => sum(selectedList.map((r) => money(r.amount as { minor: unknown; currency?: string })), 'VND'),
    [selectedList],
  );

  return (
    <>
      <FgPageHeader
        title={title}
        actions={
          createHref && canCreate ? (
            <Link to={createHref}>
              <FgButton variant="primary">{createLabel}</FgButton>
            </Link>
          ) : undefined
        }
      />

      <div className="fg-filterbar">
        <FgSelect ariaLabel="Lọc theo trạng thái" options={STATUS_OPTIONS} value={get('status')} onChange={(v) => setFilter('status', v ?? '')} style={{ width: 220 }} />
        {source === 'documents' ? (
          <FgSelect ariaLabel="Phạm vi hồ sơ" options={MINE_OPTIONS} value={get('mine')} onChange={(v) => setFilter('mine', v ?? '')} style={{ width: 170 }} />
        ) : null}
        {sortOnTable ? null : (
          <FgSelect ariaLabel="Sắp xếp" options={SORTS} value={get('sort') || '-waiting'} onChange={(v) => setFilter('sort', v ?? '')} style={{ width: 180 }} />
        )}
        <FgSearchInput value={qText} onChange={setQText} />
        {anyFilter ? (
          <FgButton
            size="small"
            variant="ghost"
            onClick={() => {
              setQText('');
              setFilter('q', '');
              setFilter('status', '');
              setFilter('mine', '');
            }}
          >
            Xóa lọc
          </FgButton>
        ) : null}
      </div>

      <FgQuery
        query={query}
        skeleton={
          <div className="fg-card" style={{ padding: 'var(--fg-space-5)' }}>
            <FgSkeletonTable rows={8} cols={6} />
          </div>
        }
      >
        {(data) => {
          const rows = data.items ?? [];
          const clearFilters = () => {
            setQText('');
            setFilter('q', '');
            setFilter('status', '');
            setFilter('mine', '');
          };
          if (!rows.length)
            return anyFilter ? (
              <div className="fg-card">
                <FgEmptyState
                  glyph="⌕"
                  title="Không có kết quả với bộ lọc hiện tại"
                  description="Thử bỏ bớt bộ lọc hoặc tìm bằng mã hồ sơ (PC-2026-…)."
                  action={<FgButton onClick={clearFilters}>Xóa toàn bộ bộ lọc</FgButton>}
                />
              </div>
            ) : (
              <div className="fg-card">
                <FgEmptyState
                  glyph="✓"
                  tone="success"
                  title={source === 'queue' ? 'Không có hồ sơ nào chờ bạn' : 'Chưa có hồ sơ nào'}
                  description={source === 'queue' ? 'Hàng chờ trống — mọi khoản đã được xử lý.' : undefined}
                  action={createHref && canCreate ? <Link to={createHref}><FgButton variant="primary">{createLabel}</FgButton></Link> : undefined}
                />
              </div>
            );
          return (
            <>
              <div className="fg-card" style={{ padding: 0, overflow: 'hidden' }}>
                <FgTable<QueueRow>
                  rowKey="_id"
                  columns={
                    selectable
                      ? ([
                          {
                            key: 'sel',
                            width: 44,
                            render: (_v: unknown, r: QueueRow) => (
                              <input
                                type="checkbox"
                                aria-label={`Chọn ${r.code}`}
                                style={{ width: 18, height: 18, accentColor: 'var(--fg-action-primary)', cursor: 'pointer' }}
                                checked={!!selected[r._id]}
                                onChange={(e) =>
                                  setSelected((s) => {
                                    const n = { ...s };
                                    if (e.target.checked) n[r._id] = r;
                                    else delete n[r._id];
                                    return n;
                                  })
                                }
                              />
                            ),
                          },
                          ...columns,
                        ] as TableColumnsType<QueueRow>)
                      : columns
                  }
                  dataSource={rows}
                  onRow={(r) => ({
                    onClick: (e) => {
                      if ((e.target as HTMLElement).closest('a,input,button')) return;
                      window.location.href = deepLink(r);
                    },
                    style: { cursor: 'pointer' },
                  })}
                />
                {data.summary ? (
                  <div style={{ padding: 'var(--fg-space-3) var(--fg-space-5)', borderTop: '1px solid var(--fg-border-subtle)' }}>
                    <FgText style="bodyS" color="muted">
                      {data.summary.count} hồ sơ · tổng <span className="fg-num">{data.summary.compact}</span> đang chờ
                    </FgText>
                  </div>
                ) : null}
              </div>

              {selectable && selectedList.length ? (
                <div className="fg-bulkbar" role="region" aria-label="Thao tác hàng loạt">
                  <span>Đã chọn {selectedList.length}</span>
                  <strong>Tổng {formatMoney(selectedTotal, { mode: 'compact' })}</strong>
                  <button type="button" style={{ all: 'unset', cursor: 'pointer', fontWeight: 600 }} onClick={() => setBulkOpen(true)}>
                    Duyệt hàng loạt →
                  </button>
                  <button type="button" style={{ all: 'unset', cursor: 'pointer', opacity: 0.7 }} onClick={() => setSelected({})}>
                    Bỏ chọn
                  </button>
                </div>
              ) : null}

              {bulkOpen ? (
                <BulkApproveModal
                  rows={selectedList}
                  onClose={() => setBulkOpen(false)}
                  onDone={() => {
                    setSelected({});
                    setBulkOpen(false);
                    void query.refetch();
                  }}
                />
              ) : null}
            </>
          );
        }}
      </FgQuery>
    </>
  );
}

function FgSearchInput({ value, onChange }: { value: string; onChange: (v: string) => void }): ReactNode {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Tìm mã, nội dung, đối tượng…"
      aria-label="Tìm kiếm trong danh sách"
      style={{
        flex: '1 1 220px',
        maxWidth: 360,
        height: 36,
        padding: '0 12px',
        borderRadius: 'var(--fg-radius-md)',
        border: '1px solid var(--fg-border-default)',
        background: 'var(--fg-bg-surface)',
        color: 'var(--fg-text-primary)',
      }}
    />
  );
}

/** URLSearchParams qua react-router (không import trực tiếp để giữ 1 nơi). */
import { useSearchParams } from 'react-router';
function useUrlSearchParamsShim(): [URLSearchParams, (p: URLSearchParams) => void] {
  const [params, setParams] = useSearchParams();
  return [params, (p: URLSearchParams) => setParams(p, { replace: true })];
}

/* --------- các route cụ thể chỉ là config của khung --------- */

/** APPR-01 — sort mặc định chờ lâu nhất, bulk bật. */
export function ApprovalQueueScreen(): ReactNode {
  return <DocListScreen title="Chờ tôi duyệt" source="queue" bulk />;
}

/** APPR-02 — đã duyệt. */
export function ProcessedScreen(): ReactNode {
  return <DocListScreen title="Tôi đã duyệt" source="processed" />;
}

/** APPR-03 — bị trả về / cần bổ sung. */
export function ChangesRequestedScreen(): ReactNode {
  return <DocListScreen title="Hồ sơ cần bổ sung" source="documents" fixed={{ status: 'changes_requested' }} />;
}

/** CHI-01 — danh sách chi. */
export function SpendListScreen(): ReactNode {
  return <DocListScreen title="Phiếu chi" source="documents" fixed={{ kind: 'spend' }} createHref="/chi/moi" createLabel="+ Đề nghị chi" sortOnTable />;
}

/** CHI-04 — ghim pending.* (cùng khung, filter ghim qua URL mặc định). */
export function SpendPendingScreen(): ReactNode {
  return <DocListScreen title="Chi chờ duyệt" source="documents" fixed={{ kind: 'spend', status: 'pending.gd' }} sortOnTable />;
}

/** CHI-07 — đã thanh toán. */
export function SpendPaidScreen(): ReactNode {
  return <DocListScreen title="Chi đã thanh toán" source="documents" fixed={{ kind: 'spend', status: 'paid' }} sortOnTable />;
}

/** THU-01. */
export function IncomeListScreen(): ReactNode {
  return <DocListScreen title="Phiếu thu" source="documents" fixed={{ kind: 'income' }} createHref="/thu/moi" createLabel="+ Khoản thu" sortOnTable />;
}

/** THU-04 — thu quá hạn. */
export function IncomeOverdueScreen(): ReactNode {
  return <DocListScreen title="Thu quá hạn" source="documents" fixed={{ kind: 'income', overdue_only: 'true' }} sortOnTable />;
}

/** DANH MỤC — chuyển tiền nội bộ + đảo hạn mở (link DOC-01). */
export function InternalListScreen(): ReactNode {
  return <DocListScreen title="Chuyển tiền nội bộ" source="documents" fixed={{ kind: 'internal' }} createHref="/ngan-hang/chuyen-noi-bo/moi" createLabel="+ Chuyển nội bộ" />;
}

/** tiện ích dùng chung: quá 7 ngày chờ → nổi bật ở bảng aging. */
export const isStaleRow = (waitingDays: number): boolean => waitingDays > 7;
export const daysFrom = (iso: string): number => daysBetween(iso, today());

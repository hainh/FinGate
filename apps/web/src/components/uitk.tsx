/**
 * FinGate web — Fg* UI kit: bảng, phản hồi, overlay, cell renderer theo `columns[].type`.
 *
 * antd là engine — screen không import antd trực tiếp (DS §12.3).
 */

import { useEffect, useState, type CSSProperties, type MouseEventHandler, type ReactNode } from 'react';
import {
  Collapse,
  Descriptions,
  Divider,
  Drawer,
  Dropdown,
  Modal,
  Pagination,
  Popover,
  Progress,
  Segmented,
  Skeleton,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
} from 'antd';
import type { TableColumnsType, TableProps } from 'antd';
import {
  ddmmyyyy,
  num,
  pct,
  statusLabel,
  type Money,
} from '@fingate/shared';
import { FgMoney, FgStatusChip, FgText } from './primitives.tsx';
import { toneStyle } from '../app/theme.ts';
import { useUi } from '../app/store.tsx';

/* ---------------- re-export có kiểm soát (API là Fg*) ---------------- */

export const FgSpace = Space;
export const FgDivider = Divider;
export const FgTabs = Tabs;
export const FgSegmented = Segmented;
export const FgDescriptions = Descriptions;
export const FgDropdown = Dropdown;
export const FgPopover = Popover;
export const FgCollapse = Collapse;
export const FgPagination = Pagination;

export function FgModal({
  open,
  title,
  children,
  footer,
  onCancel,
  onOk,
  okText,
  cancelText,
  width = 560,
  danger,
  confirmLoading,
  keyboard = true,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onCancel?: () => void;
  onOk?: () => void;
  okText?: ReactNode;
  cancelText?: ReactNode;
  width?: number | string;
  danger?: boolean;
  confirmLoading?: boolean;
  keyboard?: boolean;
}): ReactNode {
  return (
    <Modal
      open={open}
      title={title}
      onCancel={onCancel}
      onOk={onOk}
      footer={footer}
      width={width}
      okText={okText}
      cancelText={cancelText ?? 'Hủy'}
      centered
      keyboard={keyboard}
      maskClosable={false}
      destroyOnHidden
      confirmLoading={confirmLoading}
      okButtonProps={danger ? { danger: true } : undefined}
    >
      {children}
    </Modal>
  );
}

export function FgDrawer({
  open,
  title,
  children,
  onClose,
  width = 720,
  extra,
  footer,
}: {
  open: boolean;
  title: ReactNode;
  children: ReactNode;
  onClose: () => void;
  width?: number | string;
  extra?: ReactNode;
  footer?: ReactNode;
}): ReactNode {
  return (
    <Drawer
      open={open}
      title={title}
      extra={extra}
      footer={footer}
      onClose={onClose}
      width={typeof width === 'number' && window.innerWidth < 768 ? '100%' : width}
      destroyOnHidden
      styles={{ body: { background: 'var(--fg-bg-page)' } }}
    >
      {children}
    </Drawer>
  );
}

export function FgSpinner({ center, tip }: { center?: boolean; tip?: string }): ReactNode {
  const s = <Spin tip={tip}>{tip ? <div style={{ minHeight: 60 }} /> : null}</Spin>;
  return center ? <div style={{ display: 'grid', placeItems: 'center', padding: 'var(--fg-space-12)' }}>{s}</div> : s;
}

/* ---------------- skeleton ĐÚNG HÌNH (DoD: loading skeleton giống layout thật) ---------------- */

export function FgSkeletonParagraphs({ rows = 3 }: { rows?: number }): ReactNode {
  return <Skeleton active title={false} paragraph={{ rows }} />;
}

/** skeleton bảng: header + N dòng — dùng cho mọi màn danh sách. */
export function FgSkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }): ReactNode {
  const widths = ['18%', '28%', '14%', '16%', '14%', '10%'];
  return (
    <div aria-busy="true" aria-label="Đang tải dữ liệu">
      <div style={{ display: 'flex', gap: 16, padding: '10px 12px', background: 'var(--fg-bg-subtle)', borderRadius: 'var(--fg-radius-sm)' }}>
        {Array.from({ length: Math.min(cols, widths.length) }).map((_, i) => (
          <Skeleton.Button key={i} size="small" style={{ width: 60, minWidth: 60, visibility: 'hidden' }} active={false} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: 16, alignItems: 'center', minHeight: 'var(--fg-row-h)', borderBottom: '1px solid var(--fg-border-subtle)', paddingRight: 12 }}>
          {Array.from({ length: Math.min(cols, widths.length) }).map((_, c) => (
            <Skeleton key={c} active title={false} paragraph={{ rows: 1, width: widths[c % widths.length] }} style={{ flex: 1, margin: 0 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** skeleton KPI card — đúng hình FgKpiCard. */
export function FgSkeletonKpi(): ReactNode {
  return (
    <div className="fg-card fg-kpi" aria-busy="true">
      <Skeleton active title={{ width: '55%' }} paragraph={{ rows: 1, width: ['80%'] }} />
    </div>
  );
}

/* ---------------- empty / no-results / partial (DS §7.20 — khác nhau) ---------------- */

export function FgEmptyState({
  glyph = '◇',
  title,
  description,
  action,
  tone = 'neutral',
}: {
  glyph?: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'success' | 'info' | 'warning' | 'danger' | 'attention';
}): ReactNode {
  const t = toneStyle(tone);
  return (
    <div style={{ textAlign: 'center', padding: 'var(--fg-space-12) var(--fg-space-4)' }} role="status">
      <div
        style={{
          width: 48,
          height: 48,
          margin: '0 auto var(--fg-space-3)',
          borderRadius: 'var(--fg-radius-full)',
          display: 'grid',
          placeItems: 'center',
          fontSize: 20,
          background: t.background,
          border: `1px solid var(--fg-border-default)`,
          color: t.color,
        }}
        aria-hidden
      >
        {glyph}
      </div>
      <FgText style="h4">{title}</FgText>
      {description ? (
        <div style={{ marginTop: 4 }}>
          <FgText style="bodyS" color="muted">
            {description}
          </FgText>
        </div>
      ) : null}
      {action ? <div style={{ marginTop: 'var(--fg-space-4)' }}>{action}</div> : null}
    </div>
  );
}

/* ---------------- cell renderer — `columns[].type` quyết định (report runner) ---------------- */

export type FgCellType = 'money' | 'compact' | 'percent' | 'date' | 'number' | 'status' | 'days' | 'text' | 'moneyOrMissing';

export function renderCellByType(value: unknown, type: FgCellType, row?: Record<string, unknown>): ReactNode {
  switch (type) {
    case 'money': {
      const wire = value as Money | { minor: string } | string | null;
      return <FgMoney value={wire as never} mode="full" />;
    }
    case 'moneyOrMissing':
      return <FgMoney value={value as never} mode="full" missingLabel="—" />;
    case 'compact': {
      // server gửi compact đã format ("2,50 tỷ"); nếu chạm money wire object (cột không hậu tố _compact)
      // → format qua shared. KHÔNG truyền nguyên `row` vào money() — sẽ ném TypeError.
      if (typeof value === 'string') return <span className="fg-money">{value}</span>;
      if (value && typeof value === 'object' && 'minor' in (value as object)) return <FgMoney value={value as never} mode="compact" />;
      return <span className="fg-money">{String(value ?? '—')}</span>;
    }
    case 'percent':
      return typeof value === 'number' ? <span className="fg-num">{pct(value)}</span> : <span className="fg-num">{String(value ?? '—')}</span>;
    case 'date':
      return typeof value === 'string' && value ? <span className="fg-num">{ddmmyyyy(value)}</span> : '—';
    case 'days':
      return typeof value === 'number' ? <span className="fg-num">{num(value)} ngày</span> : '—';
    case 'status':
      return <FgStatusChip status={String(value ?? '')} waitingDays={(row?.waiting_days as number) ?? undefined} overdue={Boolean(row?.overdue)} />;
    case 'number':
      return <span className="fg-num">{typeof value === 'number' ? num(value) : String(value ?? '—')}</span>;
    default:
      return value === null || value === undefined || value === '' ? '—' : String(value);
  }
}

/** nhãn status an toàn cho mọi chỗ cần text (registry — không tự dịch). */
export const statusText = (s: string): string => statusLabel(s);

/* ---------------- FgTable (DS §7.10) — bảng desktop, card list <768px ---------------- */

export interface FgTableProps<T> extends TableProps<T> {
  /** cao hàng theo density — antd size "small" khi compact. */
  dense?: boolean;
  /**
   * ≤767px: đổi mỗi dòng thành 1 card dọc (mặc định bật, DS §5.4).
   * Tắt cho bảng nhiều cột cần giữ dạng lưới (vd Dòng tiền).
   */
  mobileCards?: boolean;
}

const XS_BREAKPOINT = 767;

/** true khi viewport ≤767px (khớp token `--fg-bp-xs` và `@media max-width:767`). */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => (typeof window !== 'undefined' ? window.innerWidth <= XS_BREAKPOINT : false));
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${XS_BREAKPOINT}px)`);
    const onChange = (): void => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isMobile;
}

export function FgTable<T extends object>({ size, mobileCards = true, dataSource, ...props }: FgTableProps<T>): ReactNode {
  const density = useUi()?.density;
  const isMobile = useIsMobile();
  const rows = dataSource ?? [];
  if (isMobile && mobileCards && rows.length > 0) {
    return (
      <FgMobileCardList<T>
        columns={props.columns}
        dataSource={rows as T[]}
        rowKey={props.rowKey}
        onRow={props.onRow}
        expandable={props.expandable}
        pagination={props.pagination}
      />
    );
  }
  return (
    <Table<T>
      size={size ?? (density === 'compact' ? 'small' : 'middle')}
      pagination={false}
      scroll={{ x: 'max-content' }}
      dataSource={dataSource}
      {...props}
    />
  );
}

/* ---------------- mobile card list — mỗi dòng 1 card dọc, nhãn cột bên trái ---------------- */

interface FgMobileColumn<T> {
  title?: ReactNode;
  dataIndex?: unknown;
  key?: string | number;
  render?: (value: unknown, record: T, index: number) => ReactNode;
  hidden?: boolean;
  children?: FgMobileColumn<T>[];
}

function flattenMobileColumns<T>(cols: FgMobileColumn<T>[], out: FgMobileColumn<T>[] = []): FgMobileColumn<T>[] {
  for (const col of cols) {
    if (col.hidden) continue;
    if (col.children?.length) flattenMobileColumns(col.children, out);
    else out.push(col);
  }
  return out;
}

function mobileCellValue(row: Record<string, unknown>, dataIndex: unknown): unknown {
  if (typeof dataIndex === 'string') return row[dataIndex];
  if (Array.isArray(dataIndex)) {
    return dataIndex.reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[String(k)] : undefined),
      row,
    );
  }
  return undefined;
}

function renderMobileCell<T>(col: FgMobileColumn<T>, row: T, index: number): ReactNode {
  const record = row as unknown as Record<string, unknown>;
  if (col.render) return col.render(mobileCellValue(record, col.dataIndex), row, index);
  const value = mobileCellValue(record, col.dataIndex);
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  return value as ReactNode;
}

/** bỏ dòng nhãn không có thông tin để card gọn (—, rỗng, false). */
function isBlankCell(node: ReactNode): boolean {
  return node === null || node === undefined || node === '' || node === false || node === '—' || node === '-';
}

function FgMobileCardList<T extends object>({
  columns,
  dataSource,
  rowKey,
  onRow,
  expandable,
  pagination,
}: {
  columns?: TableColumnsType<T>;
  dataSource: T[];
  rowKey?: TableProps<T>['rowKey'];
  onRow?: TableProps<T>['onRow'];
  expandable?: TableProps<T>['expandable'];
  pagination?: TableProps<T>['pagination'];
}): ReactNode {
  const flat = flattenMobileColumns((columns ?? []) as unknown as FgMobileColumn<T>[]);
  const untitled = flat.filter((c) => c.title === undefined || c.title === null || c.title === '');
  const titled = flat.filter((c) => !(c.title === undefined || c.title === null || c.title === ''));
  const primary = titled[0];
  const rest = titled.slice(1);

  const pageCfg = pagination && typeof pagination === 'object' ? pagination : null;
  const pageSize = pageCfg?.pageSize ?? 25;
  const [page, setPage] = useState(1);
  const total = dataSource.length;
  const rows = pageCfg ? dataSource.slice((page - 1) * pageSize, page * pageSize) : dataSource;

  const keyOf = (row: T, index: number): string => {
    if (typeof rowKey === 'function') return String(rowKey(row, index));
    const k = (rowKey ?? 'key') as string;
    return String((row as unknown as Record<string, unknown>)[k] ?? index);
  };

  const expandedKeys = expandable?.expandedRowKeys ? expandable.expandedRowKeys.map(String) : null;
  const expandedRender = expandable?.expandedRowRender;

  return (
    <div className="fg-mcards">
      {rows.map((row, index) => {
        const key = keyOf(row, index);
        const source = onRow?.(row, index) as
          | { onClick?: MouseEventHandler<HTMLDivElement>; title?: string; style?: CSSProperties }
          | undefined;
        const canExpand = !!expandedRender && (expandable?.rowExpandable ? expandable.rowExpandable(row) : true);
        const isExpanded = !!expandedKeys?.includes(key);
        return (
          <div
            key={key}
            className="fg-mcard"
            data-clickable={source?.onClick ? 'true' : undefined}
            onClick={source?.onClick}
            title={source?.title}
            style={source?.style}
          >
            {primary || untitled.length ? (
              <div className="fg-mcard-head">
                <div className="fg-mcard-head-main">{primary ? renderMobileCell(primary, row, index) : null}</div>
                {untitled.length ? (
                  <div className="fg-mcard-head-extra">
                    {untitled.map((col, i) => (
                      <span key={col.key ?? i}>{renderMobileCell(col, row, index)}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {rest.length ? (
              <div className="fg-mcard-body">
                {rest.map((col, i) => {
                  const node = renderMobileCell(col, row, index);
                  return isBlankCell(node) ? null : (
                    <div className="fg-mcard-row" key={col.key ?? i}>
                      <span className="fg-mcard-label">{col.title}</span>
                      <span className="fg-mcard-value">{node}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
            {isExpanded && canExpand && expandedRender ? <div className="fg-mcard-expand">{expandedRender(row, index, 0, true)}</div> : null}
          </div>
        );
      })}
      {pageCfg && total > pageSize ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--fg-space-4) 0' }}>
          <FgPagination size="small" current={page} pageSize={pageSize} total={total} showSizeChanger={false} onChange={setPage} />
        </div>
      ) : null}
    </div>
  );
}

export type { TableColumnsType };

export function FgTag({ tone = 'neutral', children }: { tone?: string; children: ReactNode }): ReactNode {
  return (
    <Tag style={{ ...toneStyle(tone), borderStyle: 'solid' }} bordered>
      {children}
    </Tag>
  );
}

export function FgProgressBar({
  percent,
  tone = 'info',
  label,
}: {
  percent: number;
  tone?: string;
  label?: ReactNode;
}): ReactNode {
  const t = toneStyle(tone);
  return (
    <div>
      <Progress percent={Math.min(100, Math.round(percent))} showInfo={false} strokeColor={t.color} size="small" />
      {label ? (
        <FgText style="caption" color="muted">
          {label}
        </FgText>
      ) : null}
    </div>
  );
}

/**
 * FinGate web — Fg* UI kit: bảng, phản hồi, overlay, cell renderer theo `columns[].type`.
 *
 * antd là engine — screen không import antd trực tiếp (DS §12.3).
 */

import type { ReactNode } from 'react';
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

/* ---------------- FgTable (DS §7.10) ---------------- */

export interface FgTableProps<T> extends TableProps<T> {
  /** cao hàng theo density — antd size "small" khi compact. */
  dense?: boolean;
}

export function FgTable<T extends object>({ size, ...props }: FgTableProps<T>): ReactNode {
  const density = useUi()?.density;
  return (
    <Table<T>
      size={size ?? (density === 'compact' ? 'small' : 'middle')}
      pagination={false}
      scroll={{ x: 'max-content' }}
      {...props}
    />
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

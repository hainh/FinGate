/**
 * Lịch sử thay đổi của khoản công nợ / khoản vay (v2/v2.md §2.3): ai, khi nào, các trường đổi TRƯỚC → SAU, IP.
 * Dữ liệu lấy từ `history[]` của chi tiết (server ghi `fields.changes` cho từng lần sửa / đảo hạn / kích hoạt).
 */

import type { ReactNode } from 'react';
import dayjs from 'dayjs';
import { historyRowsOf, historyValueText, type HistoryRow } from '../app/v2/debts.ts';
import { debtHistoryActionLabel, loanHistoryActionLabel } from './labels.ts';
import { FgCard } from './cards.tsx';
import { FgText } from './primitives.tsx';
import { FgEmptyState, FgTable, type TableColumnsType } from './uitk.tsx';

function changeColumns(): TableColumnsType<HistoryRow> {
  return [
    {
      title: 'Thời điểm',
      key: 'at',
      width: 150,
      render: (_v, r: HistoryRow) => (r.at ? dayjs(r.at).format('DD/MM/YYYY HH:mm') : '—'),
    },
    {
      title: 'Người thực hiện',
      key: 'actor',
      render: (_v, r: HistoryRow) => (
        <div>
          <div>{r.actor}</div>
          {r.ip ? (
            <FgText style="caption" color="muted">
              IP {r.ip}
            </FgText>
          ) : null}
        </div>
      ),
    },
    {
      title: 'Thao tác',
      key: 'action',
      render: (_v, r: HistoryRow) => r.actionLabel,
    },
    {
      title: 'Thay đổi (trước → sau)',
      key: 'changes',
      render: (_v, r: HistoryRow) =>
        r.changes.length ? (
          <div style={{ display: 'grid', gap: 2 }}>
            {r.changes.map((c) => (
              <FgText key={c.field} style="bodyS">
                <strong>{c.label}:</strong> {historyValueText(c.field, c.from)} → {historyValueText(c.field, c.to)}
              </FgText>
            ))}
          </div>
        ) : (
          '—'
        ),
    },
  ];
}

/** `kind`: khoản vay ngân hàng (`loan`, mặc định) hoặc khoản công nợ (`debt`) — mỗi loại có bảng nhãn thao tác riêng. */
export function ChangeHistoryCard({
  history,
  title = 'Lịch sử thay đổi',
  kind = 'loan',
}: {
  history: Record<string, unknown>[] | undefined;
  title?: string;
  kind?: 'loan' | 'debt';
}): ReactNode {
  // Mới nhất trước.
  const labelOf = kind === 'debt' ? debtHistoryActionLabel : loanHistoryActionLabel;
  const rows = historyRowsOf(history, labelOf).slice().reverse();
  return (
    <FgCard title={title} style={{ marginBottom: 'var(--fg-space-4)' }}>
      {rows.length ? (
        <FgTable<HistoryRow> rowKey={(r) => `${r.at ?? ''}|${r.action}|${r.changes.map((c) => c.field).join(',')}`} dataSource={rows} columns={changeColumns()} size="small" pagination={false} />
      ) : (
        <FgEmptyState glyph="◇" title="Chưa có lịch sử thay đổi" />
      )}
    </FgCard>
  );
}

/**
 * DASH-03 Bản tin tài chính hàng ngày (§XIV) — bản CHỈ ĐỌC, in ra PDF bằng Ctrl+P (K-12).
 * DASH-05 Cần xử lý · NOTI-01 Thông báo · SRCH-02 Kết quả tìm kiếm.
 */

import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ALERT_LABEL, ALERT_TYPES, dateTimeLabel, formatMoney, moneyFromWire, relativeTime } from '@fingate/shared';
import { useAlerts, useNeedsAttention, useNewsletter, useNotifications, useSearch, useMarkRead, useUnreadCount } from '../app/queries.ts';
import { useAuth } from '../app/store.tsx';
import { useAckAlert } from '../app/v2/exec.ts';
import type { AlertRow, MoneyWire } from '../app/types.ts';
import { FgAlert, FgButton, FgSelect, FgText, FgMoneyStack } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSegmented, FgSkeletonTable } from '../components/uitk.tsx';
import { FgExceptionList } from '../components/finance.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, toastOk } from '../components/pagekit.tsx';
import { toneStyle } from '../app/theme.ts';

/* ================= DASH-03 ================= */

const LINE_LABELS: [string, string][] = [
  ['total_cash', 'Tổng tiền hiện có'],
  ['income_today', 'Dự kiến thu hôm nay'],
  ['income_today_realized', 'Đã thu thực tế'],
  ['spend_today', 'Cần chi hôm nay'],
  ['net_today', 'Chênh lệch hôm nay'],
  ['awaiting_me', 'Chờ duyệt'],
  ['receivable_overdue', 'Phải thu quá hạn'],
  ['maturity_today', 'Đáo hạn hôm nay'],
  ['maturity_7d', 'Đáo hạn 7 ngày'],
  ['maturity_30d', 'Đáo hạn 30 ngày'],
];

export function NewsletterScreen(): ReactNode {
  const query = useNewsletter();
  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={8} cols={3} />}>
      {(n) => (
        <article aria-label="Bản tin tài chính hàng ngày">
          <FgPageHeader
            title={`Bản tin ${dateTimeLabel(n.date).slice(0, 10)}`}
            meta={`Phạm vi: ${n.company_names.join(' · ')} — generated ${relativeTime(n.generated_at)}`}
            actions={
              <FgButton onClick={() => window.print()}>🖨 In / Xuất PDF</FgButton>
            }
          />
          {n.warnings.map((w, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <FgAlert tone={w.tone as 'danger'} title={w.text} action={w.href ? <Link to={w.href}><FgButton size="small">Xem</FgButton></Link> : undefined} />
            </div>
          ))}
          <FgCard title="Các chỉ tiêu chính" style={{ marginBottom: 'var(--fg-space-4)' }}>
            {LINE_LABELS.map(([k, label]) => {
              const v = n.lines[k] as MoneyWire | number | undefined;
              if (v === undefined) return null;
              return (
                <div className="fg-stat-row" key={k}>
                  <span className="fg-stat-label">{label}</span>
                  {typeof v === 'object' ? <FgMoneyStack value={moneyFromWire(v)} emphasis /> : <span className="fg-num">{v}</span>}
                </div>
              );
            })}
          </FgCard>
          {n.sections.map((sec) => (
            <FgCard key={sec.key} title={sec.title} style={{ marginBottom: 'var(--fg-space-4)' }}>
              {sec.items.map((it, i) => (
                <div className="fg-stat-row" key={i}>
                  <span className="fg-stat-label">
                    {it.label}
                    {it.note ? <span style={{ color: 'var(--fg-status-danger-text)' }}> · {it.note}</span> : null}
                  </span>
                  {it.amount ? <FgMoneyStack value={moneyFromWire(it.amount)} /> : <span>{it.text ?? '—'}</span>}
                </div>
              ))}
            </FgCard>
          ))}
          <FgText style="caption" color="muted">
            Bản tin tự động sinh lúc 07:00 hằng ngày · Chỉ đọc — mọi chỉnh sửa phải qua hồ sơ gốc.
          </FgText>
        </article>
      )}
    </FgQuery>
  );
}

/* ================= DASH-05 Cần xử lý ================= */

export function NeedsAttentionScreen(): ReactNode {
  const query = useNeedsAttention();
  return (
    <>
      <FgPageHeader title="Cần xử lý" meta="Toàn bộ ngoại lệ, nhóm theo loại — không giới hạn 6 như dashboard" />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={8} cols={4} />}>
        {(data) => {
          const groups = data.groups ?? [];
          if (!groups.length)
            return (
              <div className="fg-card">
                <FgEmptyState glyph="✓" tone="success" title="Không có mục nào cần xử lý" description="Mọi hồ sơ, chứng từ và nghĩa vụ đều đang đúng hạn." />
              </div>
            );
          return (
            <>
              {groups.map((g) => (
                <FgCard
                  key={g.key}
                  title={
                    <span>
                      <span style={{ color: toneStyle(g.tone).color }} aria-hidden>
                        ●
                      </span>{' '}
                      {g.title} <FgText style="caption" color="muted">({g.items.length})</FgText>
                    </span>
                  }
                  style={{ marginBottom: 'var(--fg-space-4)' }}
                >
                  {g.key === 'exceptions' ? (
                    <FgExceptionList items={g.items as never} />
                  ) : (
                    <div>
                      {g.items.slice(0, 15).map((r) => (
                        <div className="fg-stat-row" key={r._id} style={{ alignItems: 'center' }}>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <Link to={`${r.href}?from=${encodeURIComponent('/can-xu-ly')}`} className="fg-link" style={{ fontWeight: 500 }}>
                              {r.code}
                            </Link>{' '}
                            <FgText style="bodyS" color="secondary">
                              {' '}
                              {r.title}
                            </FgText>
                            <br />
                            <FgText style="caption" color="muted">
                              {r.company_name} · chờ {r.waiting_days} ngày
                            </FgText>
                          </div>
                          <FgMoneyStack value={moneyFromWire(r.amount)} emphasis />
                        </div>
                      ))}
                      {g.items.length > 15 ? (
                        <FgText style="caption" color="muted">
                          … còn {g.items.length - 15} mục nữa — lọc trong danh sách Chi/Thu
                        </FgText>
                      ) : null}
                    </div>
                  )}
                </FgCard>
              ))}
            </>
          );
        }}
      </FgQuery>
    </>
  );
}

/* ================= NOTI-01 ================= */

export function NotificationsScreen(): ReactNode {
  const [unreadOnly, setUnreadOnly] = useState<undefined | 'true'>('true');
  const query = useNotifications(unreadOnly);
  const markRead = useMarkRead();
  const unread = useUnreadCount();
  return (
    <>
      <FgPageHeader
        title="Thông báo"
        meta={unread.data?.count ? `${unread.data.count} chưa đọc` : 'Đã đọc hết'}
        actions={
          <>
            <FgButton size="small" variant={unreadOnly === 'true' ? 'primary' : 'secondary'} onClick={() => setUnreadOnly(unreadOnly === 'true' ? undefined : 'true')}>
              Chỉ chưa đọc
            </FgButton>
            <FgButton
              size="small"
              onClick={() =>
                markRead.mutate(
                  { all: true },
                  { onSuccess: () => toastOk('Đã đánh dấu tất cả là đã đọc') },
                )
              }
            >
              Đánh dấu tất cả đã đọc
            </FgButton>
          </>
        }
      />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={5} cols={2} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState glyph="✓" tone="success" title="Không có thông báo nào" description={unreadOnly === 'true' ? 'Bạn đã đọc hết — bỏ lọc để xem lịch sử.' : undefined} />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              {data.items.map((n) => (
                <div
                  key={n._id}
                  className="fg-stat-row"
                  style={{ padding: 'var(--fg-space-3) var(--fg-space-5)', alignItems: 'flex-start', borderLeft: n.read_at ? undefined : '3px solid var(--fg-border-selected)' }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <FgText style="bodyS" strong={!n.read_at}>
                      {n.title}
                    </FgText>
                    {n.body ? (
                      <FgText style="caption" color="muted">
                        {' '}
                        — {n.body}
                      </FgText>
                    ) : null}
                    <br />
                    <FgText style="caption" color="muted">
                      {relativeTime(n.created_at)}
                    </FgText>
                  </div>
                  {n.href ? (
                    <Link to={n.href} className="fg-link" onClick={() => markRead.mutate({ ids: [n._id] })}>
                      Mở hồ sơ →
                    </Link>
                  ) : null}
                </div>
              ))}
            </div>
          )
        }
      </FgQuery>
    </>
  );
}

/* ================= SRCH-02 ================= */

export function SearchScreen(): ReactNode {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const query = useSearch(q);
  return (
    <>
      <FgPageHeader title={`Tìm kiếm: “${q}”`} />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={4} cols={3} />}>
        {(data) =>
          !data.hits.length ? (
            <div className="fg-card">
              <FgEmptyState
                glyph="⌕"
                title="Không có kết quả"
                description={`Không tìm thấy gì khớp “${q}". Kết quả bị lọc theo quyền của bạn — có thể hồ sơ tồn tại nhưng ngoài phạm vi.`}
              />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              {data.hits.map((h) => (
                <div className="fg-stat-row" key={`${h.type}-${h.id}`} style={{ padding: '12px 20px', alignItems: 'center' }}>
                  <div style={{ flex: 1 }}>
                    <Link to={`${h.href}?from=${encodeURIComponent(location.pathname + location.search)}`} className="fg-link" style={{ fontWeight: 500 }}>
                      {h.code ?? h.type}
                    </Link>{' '}
                    <FgText style="bodyS">{h.title}</FgText>
                    <br />
                    <FgText style="caption" color="muted">
                      {h.subtitle}
                    </FgText>
                  </div>
                  {h.amount ? <FgMoneyStack value={moneyFromWire(h.amount)} /> : null}
                </div>
              ))}
            </div>
          )
        }
      </FgQuery>
    </>
  );
}

/* ================= cảnh báo (v2 §12): sự kiện gần nhất, lọc theo loại, đánh dấu đã xử lý ================= */

const alertTone = (t: string): 'danger' | 'warning' | 'attention' => (t === 'danger' || t === 'warning' ? t : 'attention');

export function AlertsScreen(): ReactNode {
  const { can } = useAuth();
  const query = useAlerts();
  const ack = useAckAlert();
  const [state, setState] = useState<'open' | 'all'>('open');
  const [typeFilter, setTypeFilter] = useState('');
  // Đánh dấu đã xử lý cần alert:config (server kiểm lại).
  const canAck = can('alert:config');
  return (
    <>
      <FgPageHeader title="Cảnh báo" meta="Sự kiện cảnh báo gần nhất (tối đa 50). Loại mới: quy trình tự động lỗi, phiếu nguồn đã huỷ khi đối tượng sinh đã có tiền." />
      <div className="fg-filterbar" style={{ alignItems: 'center' }}>
        <FgSegmented value={state} onChange={(v) => setState(v as 'open' | 'all')} options={[{ label: 'Chưa xử lý', value: 'open' }, { label: 'Tất cả', value: 'all' }]} />
        <div style={{ minWidth: 280 }}>
          <FgSelect
            options={[{ value: '', label: 'Tất cả loại cảnh báo' }, ...ALERT_TYPES.map((t) => ({ value: t, label: ALERT_LABEL[t] }))]}
            value={typeFilter}
            onChange={(v) => setTypeFilter(v ?? '')}
            style={{ width: '100%' }}
            ariaLabel="Lọc theo loại cảnh báo"
          />
        </div>
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={3} cols={2} />}>
        {(data) => {
          const rows: AlertRow[] = data.items.filter((a) => (state === 'open' ? !a.acknowledged_at : true) && (!typeFilter || a.type === typeFilter));
          if (!rows.length)
            return (
              <div className="fg-card">
                <FgEmptyState glyph="✓" tone="success" title="Không có cảnh báo" description={state === 'open' ? 'Mọi cảnh báo đã được xử lý hoặc không có cảnh báo nào.' : undefined} />
              </div>
            );
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {rows.map((a) => {
                const amount = a.amount ? moneyFromWire(a.amount) : null;
                return (
                  <FgAlert
                    key={a._id}
                    tone={alertTone(a.tone)}
                    title={a.text}
                    description={
                      <span>
                        <FgText style="caption" color="muted">
                          {a.type_label}
                          {amount ? ` · ${formatMoney(amount, { mode: 'compact' })}` : ''}
                          {a.created_at ? ` · ${relativeTime(a.created_at)}` : ''}
                          {a.acknowledged_at ? ' · đã xử lý' : ''}
                        </FgText>
                      </span>
                    }
                    action={
                      <span style={{ display: 'flex', gap: 8 }}>
                        {a.href ? (
                          <Link to={a.href}>
                            <FgButton size="small">Mở</FgButton>
                          </Link>
                        ) : null}
                        {canAck && !a.acknowledged_at ? (
                          <FgButton
                            size="small"
                            loading={ack.isPending && ack.variables === a._id}
                            onClick={() => ack.mutate(a._id, { onSuccess: () => toastOk('Đã đánh dấu đã xử lý') })}
                          >
                            Đã xử lý
                          </FgButton>
                        ) : null}
                      </span>
                    }
                  />
                );
              })}
            </div>
          );
        }}
      </FgQuery>
    </>
  );
}

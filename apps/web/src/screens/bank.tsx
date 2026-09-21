/**
 * BANK-01 Tài khoản NH · BANK-04 Nhập số dư đầu ngày (blueprint §VIII).
 *
 * BANK-04: bảng nhập dày — tự kiểm `đầu + vào − ra = cuối`, lỗi inline per dòng;
 * server trả {data:{ok,bad[]}} nếu 1 dòng lệch → đánh dấu đúng dòng.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { formatMoney, money, moneyFromWire, parseMoneyInput, type Money } from '@fingate/shared';
import { useBankAccounts } from '../app/queries.ts';
import { apiCall } from '../app/api.ts';
import { useAuth } from '../app/store.tsx';
import { FgButton, FgField, FgInput, FgMoney, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSegmented, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
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

/* ================= BANK-04 — nhập số dư ================= */

interface EntryRow {
  account: BankAccountRow;
  opening: Money | null;
  inflow: Money | null;
  outflow: Money | null;
  closing: Money | null;
  blocked: Money | null;
}

export function BalanceEntryScreen(): ReactNode {
  const query = useBankAccounts();
  const { message } = useToast();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rows, setRows] = useState<Record<string, EntryRow>>({});
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedCount, setSavedCount] = useState<number | null>(null);

  const entries = useMemo(() => {
    const items = query.data?.items ?? [];
    return items
      .filter((a) => a.status === 'active')
      .map((a) => {
        const r: EntryRow = rows[a._id] ?? { account: a, opening: moneyFromWire(a.balance), inflow: null, outflow: null, closing: null, blocked: null };
        const open = r.opening?.minor ?? 0n;
        const inp = r.inflow?.minor ?? 0n;
        const out = r.outflow?.minor ?? 0n;
        const close = r.closing?.minor;
        const calc = open + inp - out;
        const diff = close !== undefined ? close - calc : null;
        return { ...r, diff, calc, complete: r.opening !== null && r.closing !== null };
      });
  }, [query.data, rows]);

  const set = (id: string, field: keyof EntryRow, text: string) => {
    setRows((s) => {
      const base = s[id] ?? { account: entries.find((e) => e.account._id === id)!.account, opening: null, inflow: null, outflow: null, closing: null, blocked: null };
      let m: Money | null;
      try {
        m = text.trim() ? parseMoneyInput(text) : null;
      } catch {
        m = null;
      }
      return { ...s, [id]: { ...base, [field]: m } };
    });
  };

  const save = async () => {
    const entriesFilled = entries.filter((e) => e.opening && e.closing);
    if (!entriesFilled.length) {
      message.warning('Chưa có dòng nào để lưu');
      return;
    }
    const bad = Object.fromEntries(
      entriesFilled.filter((e) => e.diff !== 0n && e.diff !== null).map((e) => [e.account._id, 'Đầu + vào − ra ≠ Cuối — kiểm tra lại']),
    );
    setErrors(bad);
    if (Object.keys(bad).length) {
      message.error('Một vài dòng chưa khớp công thức kiểm tra');
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      const res = await apiCall<{ data?: { ok: boolean; saved: number } }>('/bank-accounts/balances', {
        method: 'POST',
        body: {
          date,
          entries: entriesFilled.map((e) => ({
            account_id: e.account._id,
            opening_minor: e.opening!.minor.toString(),
            inflow_minor: (e.inflow?.minor ?? 0n).toString(),
            outflow_minor: (e.outflow?.minor ?? 0n).toString(),
            closing_minor: e.closing!.minor.toString(),
            blocked_minor: (e.blocked?.minor ?? 0n).toString(),
          })),
        },
      });
      const r = (res as { data?: { ok: boolean; saved: number } }).data ?? (res as { ok?: boolean; saved?: number });
      setSavedCount((r as { saved?: number }).saved ?? entriesFilled.length);
      message.success(`Đã ghi nhận số dư ${entriesFilled.length} tài khoản — dashboard vừa tải lại`);
      query.refetch();
    } catch (e) {
      const err = e as { problem?: { title: string; code: string; errors?: Record<string, string>; data?: { bad?: { account_id: string; reason: string }[] } } };
      if (err.problem?.data?.bad) {
        setErrors(Object.fromEntries(err.problem.data.bad.map((b) => [b.account_id, b.reason])));
      }
      message.error(err.problem?.title ?? 'Không lưu được số dư');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <FgPageHeader title="Nhập số dư đầu ngày" meta="Số dư là nền của mọi cảnh báo dòng tiền — hệ thống tự kiểm Đầu + Vào − Ra = Cuối" />
      <FgCard>
        <div style={{ display: 'flex', gap: 'var(--fg-space-4)', alignItems: 'flex-end', marginBottom: 'var(--fg-space-4)', flexWrap: 'wrap' }}>
          <FgField label="Ngày nghiệp vụ">
            <FgInput type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 170 }} />
          </FgField>
          <FgButton variant="primary" loading={saving} onClick={() => void save()}>
            Ghi nhận {entries.filter((e) => e.opening && e.closing).length} dòng
          </FgButton>
          {savedCount !== null ? <FgText style="bodyS" color="success">Đã lưu {savedCount} dòng ✓</FgText> : null}
        </div>

        <FgQuery query={query} skeleton={<FgSkeletonTable rows={7} cols={6} />}>
          {() =>
            !entries.length ? (
              <FgEmptyState glyph="◇" title="Chưa có tài khoản nào trong phạm vi" />
            ) : (
              <FgTable
                rowKey={(_r, i) => String(i)}
                dataSource={entries}
                pagination={false}
                columns={[
                  {
                    title: 'Tài khoản',
                    key: 'tk',
                    render: (_v, e) => (
                      <div>
                        <FgText strong>{e.account.label}</FgText>
                        <br />
                        <FgText style="caption" color="muted">
                          {e.account.is_group ? 'Tập đoàn' : e.account.company_name}
                          {e.account.stale ? ' · chưa có số dư hôm nay' : e.account.balance ? ` · dư hiện tại ${formatMoney(moneyFromWire(e.account.balance)!, { mode: 'compact' })}` : ''}
                        </FgText>
                      </div>
                    ),
                  },
                  ...(['opening', 'inflow', 'outflow', 'closing', 'blocked'] as const).map((f) => ({
                    title: ({ opening: 'Đầu ngày', inflow: 'Vào', outflow: 'Ra', closing: 'Cuối ngày', blocked: 'Phong tỏa' } as Record<string, string>)[f],
                    key: f,
                    align: 'right' as const,
                    width: 150,
                    render: (_v: unknown, e: (typeof entries)[number]) => (
                      <FgInput
                        inputMode="numeric"
                        aria-label={`${f} của ${e.account.label}`}
                        placeholder="0"
                        status={errors[e.account._id] && (f === 'closing' || f === 'opening') ? 'error' : undefined}
                        defaultValue={e[f] ? formatMoney(e[f]!, { mode: 'full', showCurrency: false }).replace(/\s|₫/g, '') : ''}
                        onBlur={(ev) => set(e.account._id, f, (ev.target as HTMLInputElement).value)}
                      />
                    ),
                  })),
                  {
                    title: 'Kiểm tra',
                    key: 'check',
                    width: 200,
                    render: (_v, e) => {
                      if (errors[e.account._id]) return <FgText style="bodyS" color="danger">✕ {errors[e.account._id]}</FgText>;
                      if (e.complete && e.diff === 0n) return <FgText style="bodyS" color="success">✓ Khớp</FgText>;
                      if (e.complete && e.diff !== null) return <FgText style="bodyS" color="danger">Lệch {formatMoney(money(e.diff), { mode: 'compact' })}</FgText>;
                      return <FgText style="bodyS" color="muted">Chưa nhập đủ</FgText>;
                    },
                  },
                ]}
              />
            )
          }
        </FgQuery>
      </FgCard>
    </>
  );
}

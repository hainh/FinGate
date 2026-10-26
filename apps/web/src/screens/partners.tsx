/**
 * PARTNER-01/02 — Màn Đối tác (v2/v2.md §5.3).
 *
 * - Danh sách `/doi-tac`: lọc loại / trạng thái / tìm (tên, STK, MST) / kỳ tổng hợp; cột tóm tắt theo loại
 *   (KH/NCC: còn phải thu, còn phải trả, quá hạn · NH: dư nợ, đáo hạn gần nhất · tổng thu/chi đã thực thi
 *   trong kỳ); thêm, sửa, ngừng/kích hoạt, xoá khi chưa phát sinh, sao chép từ công ty khác.
 * - Chi tiết `/doi-tac/:id`: thông tin, tóm tắt, nút Thu · Chi · Ghi nợ · Trả nợ, các tab
 *   Phiếu thu/chi · Công nợ (KH/NCC) · Nợ ngân hàng (NH) · Lịch sử.
 * URL là state của bộ lọc (`?type=&status=&q=&period=YYYY-MM&page=`).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import dayjs from 'dayjs';
import type { MenuProps } from 'antd';
import {
  DEBT_DIRECTION_LABEL,
  PARTNER_STATUS_LABEL,
  PARTNER_TYPE_LABEL,
  PARTNER_TYPES,
  bankDebtStatusLabel,
  bankDebtStatusTone,
  countUnit,
  dateTimeLabel,
  ddmmyyyy,
  docHref,
  type PartnerHistoryEntry,
  type PartnerStatus,
  type PartnerType,
} from '@fingate/shared';
import { SCOPE_ALL, useAuth, useCurrentCompanyId } from '../app/store.tsx';
import {
  debtDirectionOf,
  usePartner,
  usePartnerDebts,
  usePartnerList,
  usePartnerLoans,
  usePartnerVouchers,
  type PartnerDebtRow,
  type PartnerDetailData,
  type PartnerListFilters,
  type PartnerListRow,
  type PartnerLoanRow,
  type PartnerVoucherRow,
} from '../app/v2/partners.ts';
import { FgCard } from '../components/cards.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useDebounced, useToast } from '../components/pagekit.tsx';
import { PartnerFormModal, notifyPartnerWarnings } from '../components/partner-picker.tsx';
import { FgAlert, FgButton, FgInput, FgMoney, FgSelect, FgStatusChip, FgText } from '../components/primitives.tsx';
import {
  FgDescriptions,
  FgDropdown,
  FgEmptyState,
  FgPagination,
  FgSkeletonParagraphs,
  FgSkeletonTable,
  FgTable,
  FgTabs,
  FgTag,
  type TableColumnsType,
} from '../components/uitk.tsx';
import {
  CopyPartnersDialog,
  DebtDirectionDialog,
  DeletePartnerDialog,
  MergePartnerDialog,
  SettlePartnerDialog,
  TogglePartnerStatusDialog,
  partnerLoanHref,
  partnerVoucherHref,
} from './partner-dialogs.tsx';

/* ================= helper dùng chung ================= */

const PAGE_SIZE = 50;

/**
 * Được "Trả nợ" đối tác này? Server (routes/partners.ts) yêu cầu partner:write + doc:create + link:manage,
 * và thêm debt:write cho KH/NCC hoặc loan:read + loan:write cho Ngân hàng (v2 §3.2, §5.3).
 */
function canSettleOf(can: (permission: string) => boolean, bank: boolean): boolean {
  if (!(can('partner:write') && can('doc:create') && can('link:manage'))) return false;
  return bank ? can('loan:read') && can('loan:write') : can('debt:write');
}

/** Đối tác đã ngừng giao dịch: không thu / chi / ghi nợ / trả nợ được (server cũng từ chối). */
const INACTIVE_REASON = 'đang ngừng giao dịch';

/** Kỳ tổng hợp mặc định: tháng hiện tại (YYYY-MM). */
const currentPeriod = (): string => dayjs().format('YYYY-MM');

/** 12 tháng gần nhất để chọn kỳ tổng hợp. */
const periodOptions = (): { value: string; label: string }[] =>
  Array.from({ length: 12 }, (_x, i) => {
    const d = dayjs().subtract(i, 'month');
    return { value: d.format('YYYY-MM'), label: `Tháng ${d.format('MM/YYYY')}` };
  });

const periodLabel = (period: string): string => `Tháng ${period.slice(5, 7)}/${period.slice(0, 4)}`;

/** Khoảng ngày của kỳ `YYYY-MM` (đầu → cuối tháng), gửi cho `GET /partners`. */
const periodRange = (period: string): { from: string; to: string } => {
  const start = dayjs(`${period}-01`);
  return { from: start.format('YYYY-MM-DD'), to: start.endOf('month').format('YYYY-MM-DD') };
};

const TYPE_OPTIONS = PARTNER_TYPES.map((t) => ({ value: t, label: PARTNER_TYPE_LABEL[t] }));
const STATUS_OPTIONS: { value: PartnerStatus; label: string }[] = [
  { value: 'active', label: PARTNER_STATUS_LABEL.active },
  { value: 'inactive', label: PARTNER_STATUS_LABEL.inactive },
];
const TYPE_TONE: Record<PartnerType, string> = { bank: 'info', customer: 'success', supplier: 'neutral', internal: 'attention' };
const DEBT_STATUS_TEXT: Record<string, string> = {
  open: 'Chưa cấn trừ',
  partial: 'Cấn trừ một phần',
  settled: 'Đã cấn trừ đủ',
};

/** Ô số liệu ngắn trên màn chi tiết. */
function PartnerKpi({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <FgCard padded style={{ height: '100%' }}>
      <FgText style="caption" color="muted">
        {label}
      </FgText>
      <div style={{ marginTop: 4, fontSize: 'var(--fg-font-number-m-size)', lineHeight: 'var(--fg-font-number-m-line)' }}>{children}</div>
    </FgCard>
  );
}

/* ================= danh sách ================= */

type ListDialog =
  | { kind: 'create' }
  | { kind: 'copy' }
  | { kind: 'edit'; partner: PartnerListRow }
  | { kind: 'settle'; partner: PartnerListRow }
  | { kind: 'direction'; partner: PartnerListRow }
  | { kind: 'toggle'; partner: PartnerListRow }
  | { kind: 'merge'; partner: PartnerListRow }
  | { kind: 'delete'; partner: PartnerListRow };

export function PartnersScreen(): ReactNode {
  const { can, scope } = useAuth();
  const currentCompanyId = useCurrentCompanyId();
  const navigate = useNavigate();
  const { notification } = useToast();
  const [params, setParams] = useSearchParams();
  const get = (k: string): string => params.get(k) ?? '';
  const setFilter = (k: string, v: string): void => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete('page'); // đổi bộ lọc → về trang 1
    setParams(next, { replace: true });
  };

  const [qText, setQText] = useState(get('q'));
  const qDebounced = useDebounced(qText.trim(), 300);
  useEffect(() => {
    if (qDebounced !== get('q')) setFilter('q', qDebounced);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDebounced]);

  const type = get('type') as PartnerType | '';
  const status = get('status') as PartnerStatus | '';
  const rawPeriod = get('period');
  const period = /^\d{4}-\d{2}$/.test(rawPeriod) ? rawPeriod : currentPeriod();
  const page = Math.max(1, Number(get('page')) || 1);
  const range = periodRange(period);
  const filters = useMemo<PartnerListFilters>(
    () => ({
      type: type ? [type] : undefined,
      status: status || undefined,
      q: qDebounced || undefined,
      period_from: range.from,
      period_to: range.to,
      limit: PAGE_SIZE,
      offset: (page - 1) * PAGE_SIZE,
    }),
    [type, status, qDebounced, range.from, range.to, page],
  );
  const list = usePartnerList(filters);

  const canWrite = can('partner:write');
  const canVoucher = can('doc:create');
  const canDebt = can('debt:write');
  const canLoan = can('loan:write');
  // Toàn tập đoàn: danh bạ gộp nhiều công ty → hiện cột công ty; thao tác chỉ với đối tác của công ty đang làm việc.
  const showCompany = scope === SCOPE_ALL;
  const anyFilter = Boolean(type || status || qDebounced);
  const [dialog, setDialog] = useState<ListDialog | null>(null);
  const close = (): void => setDialog(null);

  const rowMenu = (r: PartnerListRow): NonNullable<MenuProps['items']> => {
    const mine = !showCompany || r.company_id === currentCompanyId;
    const isBank = r.type === 'bank';
    // đối tác ngừng giao dịch: thao tác phát sinh phiếu / công nợ bị khoá, lý do ghi ngay trên nhãn
    const active = r.status === 'active';
    const act = (label: string): string => (active ? label : `${label} (${INACTIVE_REASON})`);
    const items: NonNullable<MenuProps['items']> = [
      { key: 'view', label: 'Xem chi tiết', onClick: () => navigate(`/doi-tac/${r._id}`) },
    ];
    if (mine && canVoucher) {
      items.push(
        { key: 'thu', label: act('Thu'), disabled: !active, onClick: () => navigate(partnerVoucherHref(r._id, 'income', isBank)) },
        { key: 'chi', label: act('Chi'), disabled: !active, onClick: () => navigate(partnerVoucherHref(r._id, 'spend', isBank)) },
      );
    }
    if (mine && (isBank ? canLoan : canDebt)) {
      items.push({
        key: 'ghi-no',
        label: act('Ghi nợ'),
        disabled: !active,
        onClick: () => (isBank ? navigate(partnerLoanHref(r._id)) : setDialog({ kind: 'direction', partner: r })),
      });
    }
    if (mine && canSettleOf(can, isBank)) {
      items.push({ key: 'tra-no', label: act('Trả nợ'), disabled: !active, onClick: () => setDialog({ kind: 'settle', partner: r }) });
    }
    if (mine && canWrite) {
      items.push(
        { type: 'divider', key: 'divider' },
        { key: 'edit', label: 'Sửa', onClick: () => setDialog({ kind: 'edit', partner: r }) },
        {
          key: 'toggle',
          label: r.status === 'active' ? 'Ngừng giao dịch' : 'Kích hoạt lại',
          onClick: () => setDialog({ kind: 'toggle', partner: r }),
        },
        // đối tác công ty trong tập đoàn không gộp: mỗi TK gốc là một đối tác riêng
        ...(r.type === 'internal' ? [] : [{ key: 'merge', label: 'Gộp vào…', onClick: () => setDialog({ kind: 'merge', partner: r }) }]),
        {
          key: 'delete',
          label: r.has_activity ? 'Xoá (đã phát sinh)' : 'Xoá',
          danger: true,
          disabled: r.has_activity,
          onClick: () => setDialog({ kind: 'delete', partner: r }),
        },
      );
    }
    return items;
  };

  const columns: TableColumnsType<PartnerListRow> = [
    {
      title: 'Đối tác',
      key: 'name',
      width: 240,
      render: (_v, r: PartnerListRow) => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Link className="fg-link" to={`/doi-tac/${r._id}`} style={{ fontWeight: 500 }}>
            {r.name}
          </Link>
          <span className="fg-num" style={{ fontSize: 'var(--fg-font-caption-size)', color: 'var(--fg-text-muted)' }}>
            {r.code}
          </span>
        </div>
      ),
    },
    ...(showCompany
      ? [
          {
            title: 'Công ty',
            key: 'company',
            render: (_v: unknown, r: PartnerListRow) => r.company_name ?? '—',
          },
        ]
      : []),
    {
      title: 'Loại',
      key: 'type',
      width: 130,
      render: (_v, r: PartnerListRow) => <FgTag tone={TYPE_TONE[r.type]}>{PARTNER_TYPE_LABEL[r.type]}</FgTag>,
    },
    {
      title: 'Ngân hàng · STK · MST',
      key: 'bank',
      render: (_v, r: PartnerListRow) =>
        [r.bank_name, r.account_number ? `STK ${r.account_number}` : null, r.tax_code ? `MST ${r.tax_code}` : null]
          .filter(Boolean)
          .join(' · ') || '—',
    },
    {
      title: 'Khách hàng / Nhà cung cấp',
      children: [
        {
          title: 'Còn phải thu',
          key: 'receivable',
          align: 'right',
          render: (_v, r: PartnerListRow) => <FgMoney value={r.type === 'bank' ? null : r.receivable_remaining} />,
        },
        {
          title: 'Còn phải trả',
          key: 'payable',
          align: 'right',
          render: (_v, r: PartnerListRow) => <FgMoney value={r.type === 'bank' ? null : r.payable_remaining} />,
        },
        {
          title: 'Quá hạn',
          key: 'overdue',
          align: 'right',
          render: (_v, r: PartnerListRow) => <FgMoney value={r.type === 'bank' ? null : r.overdue_amount} />,
        },
      ],
    },
    {
      title: 'Ngân hàng',
      children: [
        {
          title: 'Dư nợ',
          key: 'outstanding',
          align: 'right',
          render: (_v, r: PartnerListRow) => <FgMoney value={r.type === 'bank' ? r.outstanding : null} />,
        },
        {
          title: 'Đáo hạn gần nhất',
          key: 'maturity',
          render: (_v, r: PartnerListRow) =>
            r.type === 'bank' && r.next_maturity_date ? <span className="fg-num">{ddmmyyyy(r.next_maturity_date)}</span> : '—',
        },
      ],
    },
    {
      title: `Đã thực thi · ${periodLabel(period)}`,
      children: [
        {
          title: 'Tổng thu',
          key: 'paid_in',
          align: 'right',
          render: (_v, r: PartnerListRow) => <FgMoney value={r.paid_in_period} />,
        },
        {
          title: 'Tổng chi',
          key: 'paid_out',
          align: 'right',
          render: (_v, r: PartnerListRow) => <FgMoney value={r.paid_out_period} />,
        },
      ],
    },
    {
      title: 'Trạng thái',
      key: 'status',
      render: (_v, r: PartnerListRow) => (
        <FgTag tone={r.status === 'active' ? 'success' : 'neutral'}>{PARTNER_STATUS_LABEL[r.status]}</FgTag>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 120,
      align: 'right',
      render: (_v, r: PartnerListRow) => (
        <FgDropdown menu={{ items: rowMenu(r) }} trigger={['click']}>
          <FgButton size="small" aria-label={`Thao tác với ${r.name}`}>
            Thao tác ▾
          </FgButton>
        </FgDropdown>
      ),
    },
  ];

  return (
    <>
      <FgPageHeader
        title="Đối tác"
        meta="Danh bạ đối tác theo từng công ty · dùng cho phiếu thu/chi, công nợ và nợ ngân hàng"
        actions={
          canWrite ? (
            <>
              <FgButton onClick={() => setDialog({ kind: 'copy' })}>Sao chép từ công ty khác</FgButton>
              <FgButton variant="primary" onClick={() => setDialog({ kind: 'create' })}>
                + Tạo đối tác
              </FgButton>
            </>
          ) : null
        }
      />

      <div className="fg-filterbar">
        <FgInput
          value={qText}
          onChange={(e) => setQText(e.target.value)}
          placeholder="Tìm theo tên, số tài khoản, MST…"
          aria-label="Tìm đối tác"
          allowClear
          style={{ width: 300, maxWidth: '100%' }}
        />
        <FgSelect
          ariaLabel="Lọc theo loại đối tác"
          value={type || undefined}
          onChange={(v) => setFilter('type', v ?? '')}
          options={TYPE_OPTIONS}
          placeholder="Mọi loại"
          allowClear
        />
        <FgSelect
          ariaLabel="Lọc theo trạng thái"
          value={status || undefined}
          onChange={(v) => setFilter('status', v ?? '')}
          options={STATUS_OPTIONS}
          placeholder="Mọi trạng thái"
          allowClear
        />
        <FgSelect
          ariaLabel="Kỳ tổng hợp thu/chi"
          value={period}
          onChange={(v) => setFilter('period', v && v !== currentPeriod() ? v : '')}
          options={periodOptions()}
        />
      </div>

      <FgQuery query={list} skeleton={<FgSkeletonTable rows={6} cols={6} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              {anyFilter ? (
                <FgEmptyState
                  glyph="◇"
                  title="Không có đối tác với bộ lọc này"
                  description="Thử bỏ bớt bộ lọc hoặc đổi từ khoá tìm kiếm."
                  action={
                    <FgButton
                      onClick={() => {
                        setQText('');
                        setParams(new URLSearchParams(), { replace: true });
                      }}
                    >
                      Xoá lọc
                    </FgButton>
                  }
                />
              ) : (
                <FgEmptyState
                  glyph="⚭"
                  title="Chưa có đối tác nào"
                  description="Đối tác là bên ngoài công ty mà công ty thu tiền, chi tiền, ghi nợ hoặc vay. Tạo đối tác để chọn nhanh khi lập phiếu."
                  action={
                    canWrite ? (
                      <FgButton variant="primary" onClick={() => setDialog({ kind: 'create' })}>
                        + Tạo đối tác
                      </FgButton>
                    ) : null
                  }
                />
              )}
            </div>
          ) : (
            <>
              <FgText style="bodyS" color="muted">
                {countUnit(data.total, 'đối tác')}
              </FgText>
              <div className="fg-card" style={{ padding: 0 }}>
                <FgTable<PartnerListRow> rowKey="_id" dataSource={data.items} columns={columns} pagination={false} scroll={{ x: 1280 }} />
              </div>
              {data.total > PAGE_SIZE ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 'var(--fg-space-4) 0' }}>
                  <FgPagination
                    current={page}
                    pageSize={PAGE_SIZE}
                    total={data.total}
                    showSizeChanger={false}
                    onChange={(p) => {
                      const next = new URLSearchParams(params);
                      next.set('page', String(p));
                      setParams(next, { replace: true });
                    }}
                  />
                </div>
              ) : null}
            </>
          )
        }
      </FgQuery>

      {dialog?.kind === 'create' ? (
        <PartnerFormModal
          companyId={currentCompanyId}
          onClose={close}
          onSaved={(r) => {
            close();
            notifyPartnerWarnings(notification, r.warnings);
          }}
        />
      ) : null}
      {dialog?.kind === 'edit' ? (
        <PartnerFormModal
          editing={dialog.partner}
          companyId={currentCompanyId}
          onClose={close}
          onSaved={(r) => {
            close();
            notifyPartnerWarnings(notification, r.warnings);
          }}
        />
      ) : null}
      {dialog?.kind === 'copy' ? <CopyPartnersDialog onClose={close} /> : null}
      {dialog?.kind === 'settle' ? <SettlePartnerDialog partner={dialog.partner} onClose={close} /> : null}
      {dialog?.kind === 'direction' ? <DebtDirectionDialog partnerId={dialog.partner._id} onClose={close} /> : null}
      {dialog?.kind === 'toggle' ? <TogglePartnerStatusDialog partner={dialog.partner} onClose={close} /> : null}
      {dialog?.kind === 'merge' ? <MergePartnerDialog partner={dialog.partner} onClose={close} /> : null}
      {dialog?.kind === 'delete' ? <DeletePartnerDialog partner={dialog.partner} onClose={close} /> : null}
    </>
  );
}

/* ================= chi tiết ================= */

type DetailDialog = 'edit' | 'settle' | 'direction' | 'toggle' | 'merge' | 'delete';

export function PartnerDetailScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can, scope } = useAuth();
  const currentCompanyId = useCurrentCompanyId();
  const { notification } = useToast();
  const query = usePartner(id);
  const [dialog, setDialog] = useState<DetailDialog | null>(null);
  const [tab, setTab] = useState<string>('vouchers');
  const close = (): void => setDialog(null);
  const canWrite = can('partner:write');
  const canVoucher = can('doc:create');
  const canDebt = can('debt:write');
  const canLoan = can('loan:write');

  const p: PartnerDetailData | undefined = query.data;
  const sameCompany = !p || scope !== SCOPE_ALL || p.company_id === currentCompanyId;
  // Tóm tắt trên màn chi tiết do server tính theo tháng hiện tại.
  const thisMonth = periodLabel(currentPeriod());

  return (
    <>
      <Link to="/doi-tac" className="fg-link" style={{ display: 'inline-block', marginBottom: 8 }}>
        ← Danh sách đối tác
      </Link>

      <FgQuery
        query={query}
        skeleton={
          <>
            <FgSkeletonParagraphs rows={2} />
            <div style={{ height: 'var(--fg-space-4)' }} />
            <FgSkeletonTable rows={4} cols={3} />
          </>
        }
      >
        {(d) => {
          const bank = d.type === 'bank';
          const detailMenu: MenuProps['items'] = [
            { key: 'edit', label: 'Sửa đối tác', disabled: !canWrite, onClick: () => setDialog('edit') },
            {
              key: 'toggle',
              label: d.status === 'active' ? 'Ngừng giao dịch' : 'Kích hoạt lại',
              disabled: !canWrite,
              onClick: () => setDialog('toggle'),
            },
            ...(d.type === 'internal' ? [] : [{ key: 'merge', label: 'Gộp vào…', disabled: !canWrite, onClick: () => setDialog('merge') }]),
            { type: 'divider', key: 'divider' },
            {
              key: 'delete',
              label: d.has_activity ? 'Xoá (đã phát sinh — chỉ ngừng giao dịch)' : 'Xoá đối tác',
              danger: true,
              disabled: !canWrite || d.has_activity,
              onClick: () => setDialog('delete'),
            },
          ];
          // đối tác ngừng giao dịch: không phát sinh phiếu / công nợ / khoản vay mới (banner ở trên nêu lý do)
          const active = d.status === 'active';
          const actions = sameCompany ? (
            <>
              {canVoucher ? (
                <FgButton disabled={!active} onClick={() => navigate(partnerVoucherHref(d._id, 'income', bank))}>
                  Thu
                </FgButton>
              ) : null}
              {canVoucher ? (
                <FgButton disabled={!active} onClick={() => navigate(partnerVoucherHref(d._id, 'spend', bank))}>
                  Chi
                </FgButton>
              ) : null}
              {bank ? (
                canLoan ? (
                  <FgButton disabled={!active} onClick={() => navigate(partnerLoanHref(d._id))}>
                    Ghi nợ
                  </FgButton>
                ) : null
              ) : canDebt ? (
                <FgButton disabled={!active} onClick={() => setDialog('direction')}>
                  Ghi nợ
                </FgButton>
              ) : null}
              {canSettleOf(can, bank) ? (
                <FgButton disabled={!active} onClick={() => setDialog('settle')}>
                  Trả nợ
                </FgButton>
              ) : null}
              {canWrite ? (
                <FgDropdown menu={{ items: detailMenu }} trigger={['click']}>
                  <FgButton>Khác ▾</FgButton>
                </FgDropdown>
              ) : null}
            </>
          ) : null;

          const tabs = [
            { key: 'vouchers', label: 'Phiếu thu/chi', children: <VouchersTab partnerId={d._id} /> },
            { key: 'debts', label: 'Công nợ', children: <DebtsTab partnerId={d._id} isBank={bank} /> },
            { key: 'loans', label: 'Nợ ngân hàng', children: <LoansTab partnerId={d._id} isBank={bank} /> },
            { key: 'history', label: 'Lịch sử', children: <HistoryTab history={d.history} /> },
          ];

          return (
            <>
              {!sameCompany ? (
                <div style={{ marginBottom: 'var(--fg-space-3)' }}>
                  <FgAlert
                    tone="info"
                    title="Đối tác thuộc công ty khác"
                    description="Chuyển sang công ty đó (phạm vi làm việc) để thu, chi, ghi nợ, trả nợ hoặc sửa."
                  />
                </div>
              ) : null}
              {d.status === 'inactive' ? (
                <div style={{ marginBottom: 'var(--fg-space-3)' }}>
                  <FgAlert
                    tone="attention"
                    title="Đối tác đang ngừng giao dịch"
                    description="Không chọn được cho phiếu, công nợ hoặc khoản vay mới. Dữ liệu cũ vẫn giữ nguyên."
                  />
                </div>
              ) : null}

              <FgPageHeader
                title={d.name}
                meta={
                  <>
                    <span className="fg-num">{d.code}</span> · {PARTNER_TYPE_LABEL[d.type]} · {PARTNER_STATUS_LABEL[d.status]}
                    {d.company_name ? ` · ${d.company_name}` : ''}
                  </>
                }
                actions={actions}
              />

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                  gap: 'var(--fg-space-4)',
                  marginBottom: 'var(--fg-space-4)',
                }}
              >
                {bank ? (
                  <>
                    <PartnerKpi label="Dư nợ">
                      <FgMoney value={d.outstanding} emphasis />
                    </PartnerKpi>
                    <PartnerKpi label="Đáo hạn gần nhất">
                      {d.next_maturity_date ? <span className="fg-num">{ddmmyyyy(d.next_maturity_date)}</span> : '—'}
                    </PartnerKpi>
                  </>
                ) : (
                  <>
                    <PartnerKpi label="Còn phải thu">
                      <FgMoney value={d.receivable_remaining} emphasis />
                    </PartnerKpi>
                    <PartnerKpi label="Còn phải trả">
                      <FgMoney value={d.payable_remaining} emphasis />
                    </PartnerKpi>
                    <PartnerKpi label="Quá hạn">
                      <FgMoney value={d.overdue_amount} emphasis />
                    </PartnerKpi>
                  </>
                )}
                <PartnerKpi label={`Tổng thu đã thực thi · ${thisMonth}`}>
                  <FgMoney value={d.paid_in_period} emphasis />
                </PartnerKpi>
                <PartnerKpi label={`Tổng chi đã thực thi · ${thisMonth}`}>
                  <FgMoney value={d.paid_out_period} emphasis />
                </PartnerKpi>
              </div>

              <FgCard title="Thông tin đối tác" style={{ marginBottom: 'var(--fg-space-4)' }}>
                <FgDescriptions
                  size="small"
                  column={{ xs: 1, sm: 2, lg: 3 }}
                  items={[
                    { key: 'type', label: 'Loại', children: PARTNER_TYPE_LABEL[d.type] },
                    { key: 'bank', label: 'Ngân hàng', children: d.bank_name ?? '—' },
                    { key: 'account', label: 'Số tài khoản', children: <span className="fg-num">{d.account_number ?? '—'}</span> },
                    { key: 'tax', label: 'Mã số thuế', children: <span className="fg-num">{d.tax_code ?? '—'}</span> },
                    { key: 'note', label: 'Ghi chú', children: d.note || '—' },
                    { key: 'updated', label: 'Cập nhật', children: dateTimeLabel(d.updated_at) },
                  ]}
                />
              </FgCard>

              <FgTabs activeKey={tab} onChange={setTab} items={tabs} />
            </>
          );
        }}
      </FgQuery>

      {p && dialog === 'edit' ? (
        <PartnerFormModal
          editing={p}
          companyId={currentCompanyId}
          onClose={close}
          onSaved={(r) => {
            close();
            notifyPartnerWarnings(notification, r.warnings);
          }}
        />
      ) : null}
      {p && dialog === 'settle' ? <SettlePartnerDialog partner={p} onClose={close} /> : null}
      {p && dialog === 'direction' ? <DebtDirectionDialog partnerId={p._id} onClose={close} /> : null}
      {p && dialog === 'toggle' ? <TogglePartnerStatusDialog partner={p} onClose={close} /> : null}
      {p && dialog === 'merge' ? (
        <MergePartnerDialog partner={p} onClose={close} onMerged={(targetId) => navigate(`/doi-tac/${targetId}`)} />
      ) : null}
      {p && dialog === 'delete' ? <DeletePartnerDialog partner={p} onClose={close} onDeleted={() => navigate('/doi-tac')} /> : null}
    </>
  );
}

/* ================= tab chi tiết ================= */

function VouchersTab({ partnerId }: { partnerId: string }): ReactNode {
  const q = usePartnerVouchers(partnerId);
  return (
    <FgQuery query={q} skeleton={<FgSkeletonTable rows={4} cols={5} />}>
      {(data) =>
        !data.items.length ? (
          <FgEmptyState
            glyph="↕"
            title="Chưa có phiếu thu/chi"
            description="Phiếu của đối tác này sẽ hiện ở đây sau khi lập bằng nút Thu hoặc Chi."
          />
        ) : (
          <FgTable<PartnerVoucherRow>
            rowKey="_id"
            dataSource={data.items}
            pagination={false}
            columns={[
              {
                title: 'Mã',
                key: 'code',
                render: (_v, r: PartnerVoucherRow) => (
                  <Link className="fg-link" to={docHref(r.kind, r._id)}>
                    {r.code}
                  </Link>
                ),
              },
              {
                title: 'Loại',
                key: 'kind',
                render: (_v, r: PartnerVoucherRow) => (r.kind === 'income' ? 'Phiếu thu' : 'Phiếu chi'),
              },
              { title: 'Nội dung', key: 'title', render: (_v, r: PartnerVoucherRow) => r.title || '—' },
              { title: 'Số tiền', key: 'amount', align: 'right', render: (_v, r: PartnerVoucherRow) => <FgMoney value={r.amount} /> },
              {
                title: 'Ngày',
                key: 'date',
                render: (_v, r: PartnerVoucherRow) => {
                  const d = r.planned_date ?? r.business_date;
                  return d ? <span className="fg-num">{ddmmyyyy(d)}</span> : '—';
                },
              },
              {
                title: 'Trạng thái',
                key: 'status',
                render: (_v, r: PartnerVoucherRow) => <FgStatusChip status={r.status} />,
              },
            ]}
          />
        )
      }
    </FgQuery>
  );
}

function DebtsTab({ partnerId, isBank }: { partnerId: string; isBank: boolean }): ReactNode {
  const q = usePartnerDebts(isBank ? undefined : partnerId);
  if (isBank) {
    return (
      <FgEmptyState
        glyph="≡"
        title="Không áp dụng cho Ngân hàng"
        description="Công nợ phải thu / phải trả chỉ dùng cho khách hàng và nhà cung cấp. Khoản vay với ngân hàng xem ở tab Nợ ngân hàng."
      />
    );
  }
  return (
    <FgQuery query={q} skeleton={<FgSkeletonTable rows={4} cols={5} />}>
      {(data) =>
        !data.items.length ? (
          <FgEmptyState
            glyph="≡"
            title="Chưa có khoản công nợ"
            description="Khoản phải thu / phải trả với đối tác này tạo bằng nút Ghi nợ ở trên."
          />
        ) : (
          <FgTable<PartnerDebtRow>
            rowKey="_id"
            dataSource={data.items}
            pagination={false}
            columns={[
              {
                title: 'Mã',
                key: 'code',
                render: (_v, r: PartnerDebtRow) => (
                  <Link className="fg-link" to={`/cong-no/phieu/${r._id}`}>
                    {r.code}
                  </Link>
                ),
              },
              {
                title: 'Hướng',
                key: 'direction',
                render: (_v, r: PartnerDebtRow) => DEBT_DIRECTION_LABEL[debtDirectionOf(r)],
              },
              { title: 'Giá trị', key: 'value', align: 'right', render: (_v, r: PartnerDebtRow) => <FgMoney value={r.value} /> },
              { title: 'Đã cấn trừ', key: 'applied', align: 'right', render: (_v, r: PartnerDebtRow) => <FgMoney value={r.applied} /> },
              { title: 'Còn lại', key: 'remaining', align: 'right', render: (_v, r: PartnerDebtRow) => <FgMoney value={r.remaining} /> },
              {
                title: 'Còn có thể trả',
                key: 'available',
                align: 'right',
                render: (_v, r: PartnerDebtRow) => <FgMoney value={r.available} />,
              },
              {
                title: 'Đến hạn',
                key: 'due',
                render: (_v, r: PartnerDebtRow) => (
                  <span className="fg-num">
                    {ddmmyyyy(r.due_date)}
                    {r.overdue_days > 0 ? ` · quá ${r.overdue_days} ngày` : ''}
                  </span>
                ),
              },
              { title: 'Trạng thái', key: 'status', render: (_v, r: PartnerDebtRow) => DEBT_STATUS_TEXT[r.status] ?? r.status },
            ]}
          />
        )
      }
    </FgQuery>
  );
}

function LoansTab({ partnerId, isBank }: { partnerId: string; isBank: boolean }): ReactNode {
  const q = usePartnerLoans(isBank ? partnerId : undefined);
  if (!isBank) {
    return (
      <FgEmptyState
        glyph="⌂"
        title="Không áp dụng cho khách hàng / nhà cung cấp"
        description="Nợ ngân hàng chỉ gắn với đối tác loại Ngân hàng. Công nợ phải thu / phải trả xem ở tab Công nợ."
      />
    );
  }
  return (
    <FgQuery query={q} skeleton={<FgSkeletonTable rows={4} cols={5} />}>
      {(data) =>
        !data.items.length ? (
          <FgEmptyState
            glyph="⌂"
            title="Chưa có khoản nợ ngân hàng"
            description="Khoản vay với ngân hàng này tạo bằng nút Ghi nợ ở trên."
          />
        ) : (
          <FgTable<PartnerLoanRow>
            rowKey="_id"
            dataSource={data.items}
            pagination={false}
            columns={[
              {
                title: 'Mã',
                key: 'code',
                render: (_v, r: PartnerLoanRow) => (
                  <Link className="fg-link" to={`/ngan-hang/khoan-vay/${r._id}`}>
                    {r.code}
                  </Link>
                ),
              },
              { title: 'Gốc', key: 'principal', align: 'right', render: (_v, r: PartnerLoanRow) => <FgMoney value={r.principal} /> },
              { title: 'Dư nợ', key: 'outstanding', align: 'right', render: (_v, r: PartnerLoanRow) => <FgMoney value={r.outstanding} /> },
              { title: 'Đã trả gốc', key: 'repaid', align: 'right', render: (_v, r: PartnerLoanRow) => <FgMoney value={r.repaid_principal} /> },
              {
                title: 'Gốc có thể trả',
                key: 'available',
                align: 'right',
                render: (_v, r: PartnerLoanRow) => <FgMoney value={r.available_principal} />,
              },
              {
                title: 'Đáo hạn',
                key: 'maturity',
                render: (_v, r: PartnerLoanRow) => <span className="fg-num">{ddmmyyyy(r.maturity_date)}</span>,
              },
              {
                title: 'Trạng thái',
                key: 'status',
                render: (_v, r: PartnerLoanRow) => <FgTag tone={bankDebtStatusTone(r.status)}>{bankDebtStatusLabel(r.status)}</FgTag>,
              },
            ]}
          />
        )
      }
    </FgQuery>
  );
}

/** Nhãn trường đối tác trong lịch sử (v2 §5.1). */
const HISTORY_FIELD_LABEL: Record<string, string> = {
  type: 'Loại',
  name: 'Tên',
  bank_name: 'Ngân hàng',
  account_number: 'Số tài khoản',
  tax_code: 'Mã số thuế',
  note: 'Ghi chú',
  status: 'Trạng thái',
  copied_from: 'Sao chép từ công ty khác',
  merged_from: 'Gộp từ đối tác',
};

function historyValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'type' && typeof v === 'string') return PARTNER_TYPE_LABEL[v as PartnerType] ?? v;
  if (field === 'status' && typeof v === 'string') return PARTNER_STATUS_LABEL[v as PartnerStatus] ?? v;
  // giá trị đối tượng (vd. nguồn sao chép) → hiện mã, không hiện "[object Object]"
  if (typeof v === 'object') {
    const code = (v as { code?: unknown }).code;
    return typeof code === 'string' ? code : '—';
  }
  return String(v);
}

interface HistoryRow {
  key: string;
  at: string;
  actor: string;
  field: string;
  from: unknown;
  to: unknown;
}

function HistoryTab({ history }: { history: PartnerHistoryEntry[] }): ReactNode {
  const rows: HistoryRow[] = history.flatMap((h, i) =>
    Object.entries(h.changes).map(([field, ch]) => ({
      key: `${i}-${field}`,
      at: h.at,
      actor: h.actor?.name ?? '—',
      field,
      from: ch.from,
      to: ch.to,
    })),
  );
  if (!rows.length) {
    return (
      <FgEmptyState
        glyph="↺"
        title="Chưa có thay đổi nào"
        description="Mọi lần sửa đối tác sẽ được ghi lại tại đây: ai sửa, khi nào, trước → sau."
      />
    );
  }
  return (
    <FgTable<HistoryRow>
      rowKey="key"
      dataSource={rows}
      pagination={false}
      columns={[
        { title: 'Thời điểm', key: 'at', render: (_v, r: HistoryRow) => <span className="fg-num">{dateTimeLabel(r.at)}</span> },
        { title: 'Người sửa', key: 'actor', render: (_v, r: HistoryRow) => r.actor },
        { title: 'Trường', key: 'field', render: (_v, r: HistoryRow) => HISTORY_FIELD_LABEL[r.field] ?? r.field },
        { title: 'Trước', key: 'from', render: (_v, r: HistoryRow) => historyValue(r.field, r.from) },
        { title: 'Sau', key: 'to', render: (_v, r: HistoryRow) => historyValue(r.field, r.to) },
      ]}
    />
  );
}

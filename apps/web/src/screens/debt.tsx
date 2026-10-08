/**
 * Công nợ — phiếu công nợ theo chuẩn kế toán VN (KH=131, NCC=331, NV=334; Nợ/Có).
 * Cấn trừ với phiếu thu/chi — liên kết bất kỳ lúc nào, hiệu lực khi phiếu ở trạng thái "Đã thanh toán".
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { ACCOUNT_CODE_BY_PARTY, DEBT_PARTY_LABEL, DEBT_SIDE_LABEL, formatMoney, moneyFromWire, type DebtPartyType, type DebtSide, type Money, type MoneyWire } from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useAuth, useCurrentCompanyId } from '../app/store.tsx';
import { useBankDebtCandidates, useCounterparties, useCreateDebtVoucher, useDebtCandidates, useDebtVoucher, useDebtVouchers, useDeleteDebtVoucher, useLinkDebt, useUnlinkDebt, useUpdateDebtVoucher } from '../app/queries.ts';
import { FgAlert, FgButton, FgField, FgFreeSelect, FgInput, FgMoney, FgMoneyInput, FgSelect, FgText, FgTextarea } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgModal, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
import { acceptOwnerFile, attachmentHref, AttachmentPreviewModal, isImage, problemText, uploadOwnerAttachment } from '../components/attachments.tsx';
import type { DebtVoucherRow, OwnerAttachment } from '../app/types.ts';
import { STATUS_REGISTRY, type StatusKey } from '@fingate/shared';

const PARTY_OPTIONS = (Object.keys(DEBT_PARTY_LABEL) as DebtPartyType[]).map((v) => ({ value: v, label: `${DEBT_PARTY_LABEL[v]} (TK ${ACCOUNT_CODE_BY_PARTY[v]})` }));

function statusLabelVi(s: string): string {
  return STATUS_REGISTRY[s as StatusKey]?.labelVi ?? s;
}

/* ============================== DEBT-01/03 list — gộp Nợ + Có ============================== */

const SIDE_OPTIONS = [
  { value: 'debit', label: 'Phải thu (ghi Nợ)' },
  { value: 'credit', label: 'Phải trả (ghi Có)' },
];

function minorOf(w: { minor: string }): bigint {
  return BigInt(w.minor);
}
function cmpBig(a: bigint, b: bigint): number {
  return a === b ? 0 : a > b ? 1 : -1;
}
/** So sánh ổn định: tie-break theo due_date rồi mã phiếu để thứ tự không đổi mỗi lần render. */
function tieBreak(a: DebtVoucherRow, b: DebtVoucherRow, primary: number): number {
  if (primary !== 0) return primary;
  return a.due_date.localeCompare(b.due_date) || a.code.localeCompare(b.code);
}

type SortState = { key?: string; order?: 'ascend' | 'descend' };

export function DebtListScreen(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const partyType = searchParams.get('party_type') ?? undefined;
  const side = searchParams.get('side') ?? undefined;
  const overdueOnly = searchParams.get('overdue_only') === 'true';
  const [showSettled, setShowSettled] = useState(false);
  const [sort, setSort] = useState<SortState>({});

  const setParam = (key: string, value?: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next, { replace: true });
  };

  const query = useDebtVouchers({
    side,
    party_type: partyType,
    overdue_only: overdueOnly ? 'true' : undefined,
    limit: '200',
  });

  return (
    <>
      <FgPageHeader
        title="Công nợ"
        meta="Phiếu công nợ ghi Nợ/Có gộp chung — đã cấn trừ tính từ các phiếu thu/chi đã thực thi"
        actions={
          <Link to="/cong-no/moi">
            <FgButton variant="primary">+ Tạo phiếu công nợ</FgButton>
          </Link>
        }
      />
      <div className="fg-filterbar">
        <FgSelect
          ariaLabel="Phân loại"
          placeholder="Mọi phân loại"
          allowClear
          options={SIDE_OPTIONS}
          value={side}
          onChange={(v) => setParam('side', v)}
          style={{ width: 200 }}
        />
        <FgSelect
          ariaLabel="Loại đối tượng"
          placeholder="Mọi đối tượng"
          allowClear
          options={PARTY_OPTIONS}
          value={partyType}
          onChange={(v) => setParam('party_type', v)}
          style={{ width: 220 }}
        />
        <FgSelect
          ariaLabel="Quá hạn"
          placeholder="Mọi hạn"
          allowClear
          options={[{ value: 'overdue', label: 'Chỉ quá hạn còn lại' }]}
          value={overdueOnly ? 'overdue' : undefined}
          onChange={(v) => setParam('overdue_only', v ? 'true' : undefined)}
          style={{ width: 200 }}
        />
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={7} />}>
        {(data) => {
          const items = data.items as DebtVoucherRow[];
          const open = items.filter((r) => minorOf(r.remaining) > 0n);
          const settled = items.filter((r) => minorOf(r.remaining) <= 0n);
          if (!items.length) {
            return (
              <div className="fg-card">
                <FgEmptyState glyph="◇" title="Chưa có phiếu công nợ nào" />
              </div>
            );
          }
          const rawColumns = [
            { title: 'Mã', dataIndex: 'code', key: 'code', render: (v: string, r: DebtVoucherRow) => <Link className="fg-link" to={`/cong-no/phieu/${r._id}`}>{v}</Link>, sorter: (a: DebtVoucherRow, b: DebtVoucherRow) => tieBreak(a, b, a.code.localeCompare(b.code)) },
            { title: 'Đối tượng', dataIndex: 'party_name', key: 'party', sorter: (a: DebtVoucherRow, b: DebtVoucherRow) => tieBreak(a, b, a.party_name.localeCompare(b.party_name)) },
            { title: 'TK', dataIndex: 'account_code', key: 'acct', sorter: (a: DebtVoucherRow, b: DebtVoucherRow) => tieBreak(a, b, a.account_code.localeCompare(b.account_code)) },
            { title: 'Nợ/Có', dataIndex: 'side', key: 'side', render: (v: DebtSide) => DEBT_SIDE_LABEL[v], sorter: (a: DebtVoucherRow, b: DebtVoucherRow) => tieBreak(a, b, a.side.localeCompare(b.side)) },
            { title: 'Giá trị', dataIndex: 'value', key: 'value', align: 'right' as const, render: (v: MoneyWire) => <FgMoney value={moneyFromWire(v)} mode="compact" />, sorter: (a: DebtVoucherRow, b: DebtVoucherRow) => tieBreak(a, b, cmpBig(minorOf(a.value), minorOf(b.value))) },
            { title: 'Đã cấn trừ', dataIndex: 'settled', key: 'settled', align: 'right' as const, render: (v: MoneyWire) => <FgMoney value={moneyFromWire(v)} mode="compact" />, sorter: (a: DebtVoucherRow, b: DebtVoucherRow) => tieBreak(a, b, cmpBig(minorOf(a.settled), minorOf(b.settled))) },
            { title: 'Còn lại', dataIndex: 'remaining', key: 'remaining', align: 'right' as const, render: (v: MoneyWire) => <FgMoney value={moneyFromWire(v)} mode="compact" emphasis />, sorter: (a: DebtVoucherRow, b: DebtVoucherRow) => tieBreak(a, b, cmpBig(minorOf(a.remaining), minorOf(b.remaining))) },
            { title: 'Hạn', dataIndex: 'due_date', key: 'due', sorter: (a: DebtVoucherRow, b: DebtVoucherRow) => tieBreak(a, b, a.due_date.localeCompare(b.due_date)) },
            {
              title: 'Quá hạn',
              key: 'ov',
              render: (_v: unknown, r: DebtVoucherRow) =>
                r.days_overdue > 0 ? (
                  <span className="fg-chip" style={{ borderColor: 'var(--fg-status-danger-border)', color: 'var(--fg-status-danger-text)', background: 'var(--fg-status-danger-bg)' }}>
                    ⛔ {r.days_overdue} ngày
                  </span>
                ) : (
                  <FgText style="caption" color="muted">đúng hạn</FgText>
                ),
              sorter: (a: DebtVoucherRow, b: DebtVoucherRow) => tieBreak(a, b, a.days_overdue - b.days_overdue),
            },
          ];
          const columns = rawColumns.map((c) => ({ ...c, sortOrder: sort.key === c.key ? sort.order : null }));
          const onSortChange = (_p: unknown, _f: unknown, sorter: unknown): void => {
            const s = sorter as { columnKey?: unknown; order?: 'ascend' | 'descend' | null };
            setSort({ key: s.columnKey != null ? String(s.columnKey) : undefined, order: s.order ?? undefined });
          };
          return (
            <>
              <div className="fg-card" style={{ padding: 0 }}>
                <FgTable rowKey="_id" dataSource={open} columns={columns} onChange={onSortChange} />
              </div>
              {settled.length ? (
                <div style={{ marginTop: 'var(--fg-space-4)' }}>
                  <FgButton size="small" onClick={() => setShowSettled((s) => !s)}>
                    {showSettled ? '▲ Ẩn' : '▼ Hiện'} các khoản đã trả hết ({settled.length})
                  </FgButton>
                  {showSettled ? (
                    <div className="fg-card" style={{ padding: 0, marginTop: 'var(--fg-space-2)' }}>
                      <FgTable rowKey="_id" size="small" dataSource={settled} columns={columns} onChange={onSortChange} />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          );
        }}
      </FgQuery>
    </>
  );
}

/* ===================== DEBT-01/DEBT-02 create + edit ===================== */

export function DebtVoucherFormScreen(): ReactNode {
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const company = useCurrentCompanyId();
  const existing = useDebtVoucher(id);
  const create = useCreateDebtVoucher();
  const update = useUpdateDebtVoucher(id ?? '');
  const counterparties = useCounterparties();
  const { message } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [prefilled, setPrefilled] = useState(false);
  const [f, setF] = useState<{
    party_type: DebtPartyType;
    party_name: string;
    party_bank_name: string;
    party_bank_account: string;
    side: DebtSide;
    value: Money | null;
    due_date: string;
    priority: string;
    note: string;
  }>({ party_type: 'customer', party_name: '', party_bank_name: '', party_bank_account: '', side: searchParams.get('side') === 'credit' ? 'credit' : 'debit', value: null, due_date: dayjs().add(7, 'day').format('YYYY-MM-DD'), priority: 'normal', note: '' });

  const editMode = !!id;

  useEffect(() => {
    const d = existing.data;
    if (!d || prefilled) return;
    setF({
      party_type: d.party_type,
      party_name: d.party_name,
      party_bank_name: d.party_bank_name ?? '',
      party_bank_account: d.party_bank_account ?? '',
      side: d.side,
      value: moneyFromWire(d.value),
      due_date: d.due_date,
      priority: d.priority,
      note: d.note ?? '',
    });
    setPrefilled(true);
  }, [existing.data, prefilled]);

  // Chọn tên trong danh bạ Đối tác / Khách hàng → gợi ý sẵn ngân hàng + số tài khoản của đối tác đó.
  const cpList = counterparties.data?.items ?? [];
  const nameOptions = cpList.map((c) => ({ value: c.name, label: c.name }));
  const selectedCp = cpList.find((c) => c.name === f.party_name);
  const bankOptions = [...new Set((selectedCp?.banks ?? []).map((b) => b.bank_name).filter(Boolean))].map((b) => ({ value: b, label: b }));
  const accountOptions = (selectedCp?.banks ?? [])
    .filter((b) => !f.party_bank_name || b.bank_name === f.party_bank_name)
    .map((b) => ({ value: b.account_number, label: b.account_number }));

  const onNameChange = (v: string): void => {
    const cp = cpList.find((c) => c.name === v);
    const first = cp?.banks?.[0];
    setF((s) => ({ ...s, party_name: v, party_bank_name: first?.bank_name ?? '', party_bank_account: first?.account_number ?? '' }));
  };

  const submit = async (): Promise<void> => {
    setErrors({});
    if (!f.party_name.trim()) {
      message.error('Nhập tên công ty / đối tượng');
      return;
    }
    if (!f.value || f.value.minor <= 0n) {
      message.error('Nhập số tiền');
      return;
    }
    const body: Record<string, unknown> = {
      party_type: f.party_type,
      party_name: f.party_name.trim(),
      party_bank_name: f.party_bank_name.trim() || undefined,
      party_bank_account: f.party_bank_account.trim() || undefined,
      side: f.side,
      value: { amount_minor: f.value.minor.toString(), currency: f.value.currency },
      due_date: f.due_date,
      priority: f.priority,
      note: f.note.trim() || undefined,
    };
    try {
      if (editMode) {
        await update.mutateAsync(body);
        message.success('Đã cập nhật phiếu công nợ');
        navigate(`/cong-no/phieu/${id}`);
        return;
      }
      if (!company) {
        message.error('Chưa chọn công ty');
        return;
      }
      const r = await create.mutateAsync({ company_id: company, ...body });
      message.success('Đã lưu phiếu công nợ');
      navigate(`/cong-no/phieu/${r._id}`);
    } catch (e) {
      if (e instanceof ApiRequestError && e.problem.errors) setErrors(e.problem.errors);
      message.error(problemText(e, 'Không lưu được phiếu công nợ'));
    }
  };

  return (
    <>
      <FgPageHeader
        title={editMode ? `Sửa phiếu công nợ ${existing.data?.code ?? ''}` : 'Tạo phiếu công nợ'}
        meta={`TK tự suy theo loại đối tượng: KH 131 · NCC 331 · NV 334`}
      />
      <div className="fg-form-grid">
        <FgCard>
          <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
            <FgField label="Loại đối tượng *" error={errors['party_type']}>
              <FgSelect options={PARTY_OPTIONS} value={f.party_type} onChange={(v) => setF((s) => ({ ...s, party_type: (v as DebtPartyType) ?? 'customer' }))} style={{ width: '100%' }} />
            </FgField>
            <FgField label="Phân loại *">
              <FgSelect
                options={[
                  { value: 'debit', label: 'Nợ' },
                  { value: 'credit', label: 'Có' },
                ]}
                value={f.side}
                onChange={(v) => setF((s) => ({ ...s, side: (v as DebtSide) ?? 'debit' }))}
                style={{ width: '100%' }}
              />
            </FgField>
            <FgField label="Số tiền *" error={errors['value']} help={f.value ? formatMoney(f.value, { mode: 'full' }) : 'Gõ "2,5 tỷ" hoặc "850 tr"'}>
              <FgMoneyInput value={f.value} onChange={(v) => setF((s) => ({ ...s, value: v }))} />
            </FgField>
            <FgField label="Tên công ty / đối tượng *" error={errors['party_name']} help={selectedCp ? undefined : 'Chọn trong danh bạ hoặc nhập mới — sẽ tự tạo đối tác khi lưu'}>
              <FgFreeSelect options={nameOptions} value={f.party_name} onChange={onNameChange} placeholder="Chọn trong danh bạ hoặc nhập mới" style={{ width: '100%' }} />
            </FgField>
            <FgField label="Ngân hàng của công ty đối tác">
              <FgFreeSelect options={bankOptions} value={f.party_bank_name} onChange={(v) => setF((s) => ({ ...s, party_bank_name: v }))} placeholder="Chọn hoặc nhập mới" style={{ width: '100%' }} />
            </FgField>
            <FgField label="Số tài khoản của công ty đối tác">
              <FgFreeSelect options={accountOptions} value={f.party_bank_account} onChange={(v) => setF((s) => ({ ...s, party_bank_account: v }))} placeholder="Chọn hoặc nhập mới" style={{ width: '100%' }} />
            </FgField>
            <FgField label="Hạn thanh toán *" error={errors['due_date']}>
              <DatePicker value={f.due_date ? dayjs(f.due_date) : null} onChange={(d) => setF((s) => ({ ...s, due_date: d ? d.format('YYYY-MM-DD') : '' }))} format="DD/MM/YYYY" style={{ width: '100%' }} />
            </FgField>
            <FgField label="Mức ưu tiên">
              <FgSelect
                options={[
                  { value: 'low', label: 'Thấp' },
                  { value: 'normal', label: 'Bình thường' },
                  { value: 'high', label: 'Cao' },
                  { value: 'urgent', label: 'Khẩn' },
                ]}
                value={f.priority}
                onChange={(v) => setF((s) => ({ ...s, priority: v ?? 'normal' }))}
                style={{ width: '100%' }}
              />
            </FgField>
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Ghi chú">
                <FgTextarea rows={3} value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} />
              </FgField>
            </div>
          </div>
        </FgCard>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}>
          <FgCard title="Tóm tắt">
            <FgText style="bodyS" color="muted">
              {editMode && existing.data ? `Phiếu ${existing.data.code} · ghi ${DEBT_SIDE_LABEL[f.side]}` : `Phiếu mới · ghi ${DEBT_SIDE_LABEL[f.side]}`}
            </FgText>
            <div className="fg-stat-row" style={{ marginTop: 8 }}>
              <span className="fg-stat-label">Tài khoản kế toán</span>
              <span>TK {ACCOUNT_CODE_BY_PARTY[f.party_type]}</span>
            </div>
            {f.value ? (
              <div className="fg-stat-row">
                <span className="fg-stat-label">Số tiền</span>
                <span>{formatMoney(f.value, { mode: 'full' })}</span>
              </div>
            ) : null}
          </FgCard>
          <FgCard title={editMode ? 'Cập nhật' : 'Lưu'}>
            <FgButton variant="primary" block loading={create.isPending || update.isPending} onClick={() => void submit()}>
              {editMode ? 'Lưu thay đổi' : 'Lưu phiếu công nợ'}
            </FgButton>
            <div style={{ marginTop: 8 }}>
              <FgButton block onClick={() => navigate(-1)}>Hủy</FgButton>
            </div>
            <FgText style="caption" color="muted">Có thể liên kết phiếu thu/chi và đính kèm chứng từ sau khi lưu.</FgText>
          </FgCard>
        </div>
      </div>
    </>
  );
}

/* ============================== DEBT-02 detail ============================== */

export function DebtDetailScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDebtVoucher(id);
  const link = useLinkDebt(id ?? '');
  const unlink = useUnlinkDebt(id ?? '');
  const del = useDeleteDebtVoucher();
  const { message } = useToast();
  const [linkOpen, setLinkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={3} />}>
      {(d) => (
        <>
          <FgPageHeader
            title={`${d.code} · ${d.party_name}`}
            meta={`${DEBT_PARTY_LABEL[d.party_type]} · TK ${d.account_code} · ghi ${DEBT_SIDE_LABEL[d.side]}`}
            actions={
              <>
                <FgButton variant="primary" onClick={() => setLinkOpen(true)}>
                  + Liên kết phiếu thu/chi
                </FgButton>
                {can('debt:update') ? <FgButton onClick={() => navigate(`/cong-no/phieu/${id}/sua`)}>Sửa</FgButton> : null}
                {can('debt:delete') ? (
                  <FgButton variant="danger" onClick={() => setDeleteOpen(true)}>
                    Xoá
                  </FgButton>
                ) : null}
              </>
            }
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Giá trị</FgText>
              <div className="fg-kpi-value"><FgMoney value={moneyFromWire(d.value)} mode="compact" /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Đã cấn trừ</FgText>
              <div className="fg-kpi-value"><FgMoney value={moneyFromWire(d.settled)} mode="compact" /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Còn lại</FgText>
              <div className="fg-kpi-value"><FgMoney value={moneyFromWire(d.remaining)} mode="compact" emphasis /></div>
            </FgCard>
          </div>

          <FgCard title="Liên kết cấn trừ" style={{ marginBottom: 'var(--fg-space-4)' }}>
            <div style={{ marginBottom: 8 }}>
              <FgText style="caption" color="muted">
                Chỉ phiếu thu/chi ở trạng thái <strong>Đã thanh toán</strong> mới được cấn trừ. Phiếu còn chờ duyệt/thực thi sẽ <strong>tự động trừ</strong> khi thực thi — không cần gán lại.
              </FgText>
            </div>
            {!d.document_links.length ? (
              <FgEmptyState glyph="◇" title="Chưa liên kết phiếu nào" description="Liên kết phiếu thu/chi — khi phiếu được thực thi, công nợ tự trừ." />
            ) : (
              <FgTable
                rowKey="_id"
                dataSource={d.document_links}
                columns={[
                  { title: 'Phiếu', key: 'doc', render: (_v, r) => `${r.document_code} · ${r.document_title}` },
                  {
                    title: 'Trạng thái',
                    dataIndex: 'document_status',
                    key: 'st',
                    render: (v: string) =>
                      v === 'paid' ? (
                        statusLabelVi(v)
                      ) : (
                        <span className="fg-chip" style={{ borderColor: 'var(--fg-status-warning-border)', color: 'var(--fg-status-warning-text)', background: 'var(--fg-status-warning-bg)' }}>
                          ⏳ {statusLabelVi(v)} — chưa cấn trừ
                        </span>
                      ),
                  },
                  { title: 'Số tiền', dataIndex: 'amount', key: 'amount', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                  {
                    title: '',
                    key: 'act',
                    render: (_v, r) => (
                      <FgButton size="small" variant="danger" onClick={() => unlink.mutate(r._id, { onSuccess: () => message.success('Đã gỡ liên kết') })}>
                        Gỡ
                      </FgButton>
                    ),
                  },
                ]}
              />
            )}
          </FgCard>

          <OwnerAttachmentSection base="/debts" ownerId={d._id} attachments={d.attachments} onChanged={() => query.refetch()} />

          {linkOpen && id ? (
            <LinkPickerModal
              title="Liên kết phiếu thu/chi"
              kind="debt"
              ownerId={id}
              onClose={() => setLinkOpen(false)}
              onPick={(document_id, amount_minor) =>
                link.mutate(
                  { document_id, amount_minor },
                  {
                    onSuccess: () => {
                      message.success('Đã liên kết');
                      setLinkOpen(false);
                    },
                  },
                )
              }
            />
          ) : null}

          {deleteOpen && id ? (
            <FgModal
              open
              title="Xoá phiếu công nợ"
              onCancel={() => setDeleteOpen(false)}
              width={480}
              footer={
                <>
                  <FgButton onClick={() => setDeleteOpen(false)} disabled={del.isPending}>
                    Hủy
                  </FgButton>
                  <FgButton
                    variant="danger"
                    loading={del.isPending}
                    onClick={() =>
                      del.mutate(id, {
                        onSuccess: () => {
                          message.success('Đã xoá phiếu công nợ');
                          navigate('/cong-no');
                        },
                      })
                    }
                  >
                    Xoá
                  </FgButton>
                </>
              }
            >
              <FgText style="body">
                Xoá vĩnh viễn phiếu <strong>{d.code}</strong> · {d.party_name}? Thao tác ghi audit và không thể hoàn tác.
              </FgText>
            </FgModal>
          ) : null}
        </>
      )}
    </FgQuery>
  );
}

/* ====================== shared: owner attachments + link picker ====================== */

export function OwnerAttachmentSection({
  base,
  ownerId,
  attachments,
  onChanged,
}: {
  base: string;
  ownerId: string;
  attachments: OwnerAttachment[];
  onChanged: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<OwnerAttachment | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { message } = useToast();
  const list = attachments ?? [];

  const onPick = async (file: File | null): Promise<void> => {
    if (!file) return;
    setError(null);
    if (!acceptOwnerFile(file)) return setError('Chỉ nhận tệp PDF hoặc ảnh PNG/JPG');
    setBusy(true);
    try {
      await uploadOwnerAttachment({ base, ownerId, file });
      message.success('Đã tải chứng từ lên');
      onChanged();
    } catch (e) {
      setError(problemText(e, 'Không tải được chứng từ'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FgCard title="Chứng từ đính kèm">
      {list.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
          {list.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setPreview(a)}
              title={a.filename}
              aria-label={`Xem ${a.filename}`}
              style={{
                width: 160,
                padding: 0,
                border: 'var(--fg-border-w-1) solid var(--fg-border-default)',
                borderRadius: 'var(--fg-radius-sm)',
                background: 'var(--fg-bg-subtle)',
                cursor: 'pointer',
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                textAlign: 'left',
              }}
            >
              <div style={{ width: '100%', height: 120, display: 'grid', placeItems: 'center', overflow: 'hidden' }}>
                {isImage(a) ? (
                  <img src={attachmentHref(a)} alt={a.filename} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <FgText style="caption" strong color="secondary">
                    {a.mime === 'application/pdf' || /\.pdf$/i.test(a.filename) ? 'PDF' : 'TỆP'}
                  </FgText>
                )}
              </div>
              <div
                style={{
                  padding: 'var(--fg-space-1) var(--fg-space-2)',
                  fontSize: 'var(--fg-font-caption-size)',
                  color: 'var(--fg-text-secondary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {a.filename}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <FgText style="caption" color="muted">Chưa có chứng từ. Tải lên ảnh/PDF bên dưới để xem ngay tại đây.</FgText>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*"
        style={{ display: 'none' }}
        disabled={busy}
        onChange={(e) => {
          void onPick(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
      <FgButton variant="primary" loading={busy} onClick={() => fileRef.current?.click()}>
        + Thêm chứng từ (PDF/ảnh, tối đa 100MB)
      </FgButton>
      {error ? <div style={{ marginTop: 8 }}><FgAlert tone="danger" title={error} /></div> : null}
      {preview ? <AttachmentPreviewModal att={preview} onClose={() => setPreview(null)} /> : null}
    </FgCard>
  );
}

export function LinkPickerModal({
  title,
  kind,
  ownerId,
  onClose,
  onPick,
}: {
  title: string;
  kind: 'debt' | 'bank';
  ownerId: string;
  onClose: () => void;
  onPick: (document_id: string, amount_minor?: string) => void;
}): ReactNode {
  const [q, setQ] = useState('');
  const debtCandidates = useDebtCandidates(kind === 'debt' ? ownerId : undefined, q || undefined);
  const bankCandidates = useBankDebtCandidates(kind === 'bank' ? ownerId : undefined, q || undefined);
  const candidates = kind === 'debt' ? debtCandidates : bankCandidates;
  return (
    <FgModal open title={title} onCancel={onClose} width={680} footer={<FgButton onClick={onClose}>Đóng</FgButton>}>
      <FgField label="Tìm theo mã / nội dung">
        <FgInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="VD: PC-2026 hoặc tên" />
      </FgField>
      <div style={{ marginBottom: 4 }}>
        <FgText style="caption" color="muted">
          Gán được phiếu ở mọi trạng thái — chỉ phiếu <strong>Đã thanh toán</strong> mới cấn trừ ngay, phiếu chờ thực thi sẽ tự trừ khi thực thi.
        </FgText>
      </div>
      <div style={{ marginTop: 12 }}>
        {candidates.isLoading ? (
          <FgSkeletonTable rows={4} cols={3} />
        ) : !candidates.data?.items.length ? (
          <FgEmptyState glyph="◇" title="Không có phiếu phù hợp" />
        ) : (
          <FgTable
            rowKey="_id"
            size="small"
            dataSource={candidates.data.items}
            columns={[
              { title: 'Mã', dataIndex: 'code', key: 'code' },
              { title: 'Nội dung', dataIndex: 'title', key: 'title' },
              { title: 'Trạng thái', dataIndex: 'status', key: 'st', render: (v: string) => statusLabelVi(v) },
              { title: 'Số tiền', dataIndex: 'amount', key: 'amount', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
              {
                title: '',
                key: 'act',
                render: (_v, r) => (
                  <FgButton size="small" disabled={r.already_linked} onClick={() => onPick(r._id)}>
                    Liên kết
                  </FgButton>
                ),
              },
            ]}
          />
        )}
      </div>
    </FgModal>
  );
}

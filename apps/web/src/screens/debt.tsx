/**
 * Công nợ (v2/v2.md §9, US-DEBT-01…04) — khoản phải thu / phải trả theo ĐỐI TÁC (KH / NCC) chọn bằng ID.
 *  · Hướng do người dùng chọn, không suy từ loại đối tác. TK kế toán theo loại đối tác: KH 131, NCC 331.
 *  · Nhân viên (TK 334, v1) chỉ đọc. Cấn trừ = liên kết `offset` với phiếu thu (phải thu) / phiếu chi (phải trả)
 *    cùng đối tác; chỉ phiếu ĐÃ THỰC THI mới tính vào "Đã cấn trừ" (phiếu chờ thực thi tự trừ khi thực thi).
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { DatePicker, type TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import {
  DEBT_DIRECTION_LABEL,
  DEBT_DIRECTIONS,
  DEBT_PARTY_LABEL,
  LINK_ORIGIN_LABEL,
  PARTNER_TYPE_LABEL,
  STATUS_REGISTRY,
  formatMoney,
  moneyFromWire,
  type DebtDirection,
  type Money,
  type MoneyWire,
  type PartnerRef,
  type StatusKey,
} from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useAuth, useCurrentCompanyId } from '../app/store.tsx';
import { usePartner } from '../app/v2/partners.ts';
import {
  AGING_BUCKET_LABEL,
  DEBT_FILL_LABEL,
  DIRECTION_TONE,
  OFFSET_EFFECT_LABEL,
  accountCodeOf,
  directionFromSide,
  docKindOfDirection,
  hasDeadOffsetLink,
  minorOf,
  newRequestId,
  offsetEffectOf,
  parseAgingBucket,
  parseDirection,
  sideOfDirection,
  useAssignDebtOffset,
  useCreateDebt,
  useDebt,
  useDebtAging,
  useDebtList,
  useDebtOffsetCandidates,
  useDeleteDebt,
  useRemoveDebtOffset,
  useUpdateDebt,
  voucherHref,
  type DebtAgingRow,
  type DebtDetail,
  type DebtRow,
  type DebtUpdateInput,
  type DocCandidate,
  type OffsetLinkRow,
} from '../app/v2/debts.ts';
import { PartnerPicker } from '../components/partner-picker.tsx';
import { FgAlert, FgButton, FgDateTime, FgField, FgInput, FgMoneyInput, FgMoneyStack, FgSelect, FgText, FgTextarea, FgToneChip } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgDescriptions, FgEmptyState, FgModal, FgPagination, FgSegmented, FgSkeletonTable, FgTable, FgTag } from '../components/uitk.tsx';
import { ChangeHistoryCard } from '../components/change-history.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useDebounced, useToast } from '../components/pagekit.tsx';
import {
  acceptOwnerFile,
  attachmentHref,
  AttachmentPreviewModal,
  isImage,
  problemText,
  removeOwnerAttachment,
  uploadOwnerAttachment,
} from '../components/attachments.tsx';
import type { OwnerAttachment } from '../app/types.ts';

/* ================= nhãn & tiện ích màn ================= */

const DIRECTION_OPTIONS = DEBT_DIRECTIONS.map((d) => ({ value: d, label: DEBT_DIRECTION_LABEL[d] }));
const PARTY_LABEL: Record<string, string> = DEBT_PARTY_LABEL;
const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Thấp' },
  { value: 'normal', label: 'Bình thường' },
  { value: 'high', label: 'Cao' },
  { value: 'urgent', label: 'Khẩn' },
];
const PRIORITY_LABEL: Record<string, string> = Object.fromEntries(PRIORITY_OPTIONS.map((o) => [o.value, o.label]));
/** Số dòng mỗi trang danh sách công nợ (server phân trang). */
const DEBT_PAGE_SIZE = 50;
/** Trần số dòng server nạp cho một truy vấn công nợ (khớp `DEBT_MAX_ROWS` ở server). */
const DEBT_MAX_ROWS_UI = 5000;

function statusLabelVi(s: string): string {
  return STATUS_REGISTRY[s as StatusKey]?.labelVi ?? s;
}

const ddmmyyyy = (iso: string): string => dayjs(iso).format('DD/MM/YYYY');

function partnerNameOf(r: { partner: PartnerRef | null; party_name: string }): string {
  return r.partner?.name ?? r.party_name;
}

/** Nhãn loại đối tượng + TK để hiển thị (nhân viên 334 không có TK suy từ đối tác). */
function accountLabelOf(partnerType: string | null): string {
  const acct = accountCodeOf(partnerType);
  return acct ? `TK ${acct} · ${PARTY_LABEL[partnerType ?? ''] ?? partnerType}` : 'Chọn đối tác để suy TK';
}

const cmpBig = (a: bigint, b: bigint): number => (a === b ? 0 : a > b ? 1 : -1);

function KpiCard({ label, value, emphasis }: { label: string; value: MoneyWire; emphasis?: boolean }): ReactNode {
  return (
    <FgCard className="fg-kpi">
      <FgText style="caption" color="muted">
        {label}
      </FgText>
      <div className="fg-kpi-value">
        <FgMoneyStack value={moneyFromWire(value)} emphasis={emphasis} />
      </div>
    </FgCard>
  );
}

/* ============================== danh sách công nợ (DEBT-01 / DEBT-03) ============================== */

function debtColumns(): TableColumnsType<DebtRow> {
  return [
    {
      title: 'Mã',
      dataIndex: 'code',
      key: 'code',
      sorter: (a, b) => a.code.localeCompare(b.code),
      render: (v: string, r: DebtRow) => (
        <Link className="fg-link" to={`/cong-no/phieu/${r._id}`} style={{ whiteSpace: 'nowrap' }}>
          {v}
        </Link>
      ),
    },
    {
      title: 'Đối tác',
      key: 'partner',
      sorter: (a, b) => partnerNameOf(a).localeCompare(partnerNameOf(b), 'vi'),
      render: (_v, r: DebtRow) => (
        <div>
          <div>{partnerNameOf(r)}</div>
          <FgText style="caption" color="muted">
            {PARTY_LABEL[r.party_type] ?? r.party_type}
            {r.company_name ? ` · ${r.company_name}` : ''}
          </FgText>
        </div>
      ),
    },
    {
      title: 'Hướng',
      dataIndex: 'direction',
      key: 'direction',
      sorter: (a, b) => a.direction.localeCompare(b.direction),
      render: (v: DebtDirection) => <FgToneChip tone={DIRECTION_TONE[v]}>{DEBT_DIRECTION_LABEL[v]}</FgToneChip>,
    },
    { title: 'TK', dataIndex: 'account_code', key: 'acct', width: 90, sorter: (a, b) => a.account_code.localeCompare(b.account_code) },
    {
      title: 'Giá trị',
      dataIndex: 'value',
      key: 'value',
      align: 'right',
      sorter: (a, b) => cmpBig(minorOf(a.value), minorOf(b.value)),
      render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} style={{ whiteSpace: 'nowrap' }} />,
    },
    {
      title: 'Đã cấn trừ',
      dataIndex: 'offset_applied',
      key: 'applied',
      align: 'right',
      sorter: (a, b) => cmpBig(minorOf(a.offset_applied), minorOf(b.offset_applied)),
      render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} style={{ whiteSpace: 'nowrap' }} />,
    },
    {
      title: 'Còn lại',
      dataIndex: 'remaining',
      key: 'remaining',
      align: 'right',
      sorter: (a, b) => cmpBig(minorOf(a.remaining), minorOf(b.remaining)),
      render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} emphasis style={{ whiteSpace: 'nowrap' }} />,
    },
    {
      // hạn và số ngày quá hạn gộp một cột; badge quá hạn nằm dòng dưới ngày
      title: 'Hạn',
      dataIndex: 'due_date',
      key: 'due',
      width: 140,
      sorter: (a, b) => a.due_date.localeCompare(b.due_date),
      render: (v: string, r: DebtRow) => (
        <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, whiteSpace: 'nowrap' }}>
          <span className="fg-num">{ddmmyyyy(v)}</span>
          {r.days_overdue > 0 ? (
            <FgToneChip tone="danger">⛔ {r.days_overdue} ngày</FgToneChip>
          ) : (
            <FgText style="caption" color="muted">
              đúng hạn
            </FgText>
          )}
        </span>
      ),
    },
    {
      title: 'Ngày tạo',
      dataIndex: 'created_at',
      key: 'created_at',
      align: 'right',
      sorter: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      render: (v: string | null) => <FgDateTime value={v} />,
    },
  ];
}

/** Ma trận tuổi nợ theo đối tác & hướng (US-DEBT-03): chỉ khoản còn dư. */
function DebtAgingPanel({ direction }: { direction?: DebtDirection }): ReactNode {
  const query = useDebtAging({ direction });
  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={5} cols={7} />}>
      {(d) => {
        if (!d.rows.length) {
          return (
            <div className="fg-card">
              <FgEmptyState glyph="✓" tone="success" title="Không còn khoản công nợ nào chưa cấn trừ đủ" />
            </div>
          );
        }
        const columns: TableColumnsType<DebtAgingRow> = [
          {
            title: 'Đối tác',
            key: 'cp',
            render: (_v, r: DebtAgingRow) => (
              <div>
                <div>
                  {r.partner_id ? (
                    <Link className="fg-link" to={`/doi-tac/${r.partner_id}`}>
                      {r.counterparty || '—'}
                    </Link>
                  ) : (
                    r.counterparty || '—'
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <FgText style="caption" color="muted">
                    {r.company_name}
                  </FgText>
                  <FgToneChip tone={DIRECTION_TONE[r.direction]}>{DEBT_DIRECTION_LABEL[r.direction]}</FgToneChip>
                </div>
              </div>
            ),
          },
          ...d.columns.map((c) => ({
            title: c.label,
            key: c.bucket,
            align: 'right' as const,
            render: (_v: unknown, r: DebtAgingRow) => {
              const cell = r.cells.find((x) => x.bucket === c.bucket);
              return cell && cell.count > 0 ? <FgMoneyStack value={moneyFromWire(cell.amount)} /> : <FgText style="caption" color="muted">—</FgText>;
            },
          })),
          {
            title: 'Tổng',
            key: 'total',
            align: 'right' as const,
            render: (_v: unknown, r: DebtAgingRow) => <FgMoneyStack value={moneyFromWire(r.total)} emphasis />,
          },
        ];
        return (
          <>
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable rowKey={(r) => `${r.company_name}|${r.partner_id ?? r.counterparty}|${r.direction}`} dataSource={d.rows} columns={columns} pagination={false} />
            </div>
            <div className="fg-card" style={{ marginTop: 'var(--fg-space-3)' }}>
              <FgText style="caption" color="muted">
                Tổng theo nhóm tuổi nợ
              </FgText>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--fg-space-4)', marginTop: 4 }}>
                {d.totals.map((t) => (
                  <span key={t.bucket} style={{ display: 'inline-flex', gap: 6, alignItems: 'baseline' }}>
                    <FgText style="bodyS">{AGING_BUCKET_LABEL[t.bucket]}:</FgText>
                    <FgMoneyStack value={moneyFromWire(t.amount)} />
                  </span>
                ))}
              </div>
            </div>
          </>
        );
      }}
    </FgQuery>
  );
}

export function DebtListScreen(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const { can } = useAuth();
  const view = searchParams.get('view') === 'aging' ? 'aging' : 'list';
  // `side` là đường dẫn v1 (/cong-no/phai-thu → ?side=debit): vẫn đọc được, quy về hướng.
  const sideParam = searchParams.get('side');
  const direction = parseDirection(searchParams.get('direction')) ?? (sideParam ? directionFromSide(sideParam) : undefined);
  const bucket = parseAgingBucket(searchParams.get('bucket'));
  const overdueOnly = searchParams.get('overdue_only') === 'true';
  const partnerId = searchParams.get('partner_id') ?? '';
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [showSettled, setShowSettled] = useState(false);
  const partner = usePartner(partnerId || null);
  /* Phân trang phía server (tham số `page` trên URL); KPI tính trên toàn bộ dòng khớp. */
  const page = Math.max(1, Number(searchParams.get('page')) || 1);

  const setParam = (key: string, value?: string): void => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    // Đổi bộ lọc ⇒ quay về trang 1.
    if (key !== 'page') next.delete('page');
    setSearchParams(next, { replace: true });
  };

  const query = useDebtList({
    direction,
    bucket,
    overdue_only: overdueOnly ? 'true' : undefined,
    partner_id: partnerId || undefined,
    q: q || undefined,
    limit: DEBT_PAGE_SIZE,
    page,
  });

  return (
    <>
      <FgPageHeader
        title="Công nợ"
        meta="Khoản phải thu / phải trả theo đối tác — đã cấn trừ tính từ phiếu thu/chi đã thực thi"
        actions={
          can('debt:write') ? (
            <Link to="/cong-no/moi">
              <FgButton variant="primary">+ Tạo khoản công nợ</FgButton>
            </Link>
          ) : null
        }
      />
      <div className="fg-filterbar">
        <FgSegmented
          value={view}
          onChange={(v) => setParam('view', String(v) === 'aging' ? 'aging' : undefined)}
          options={[
            { value: 'list', label: 'Danh sách' },
            { value: 'aging', label: 'Tuổi nợ theo đối tác' },
          ]}
        />
        <FgSelect
          ariaLabel="Hướng"
          placeholder="Mọi hướng"
          allowClear
          options={DIRECTION_OPTIONS}
          value={direction}
          onChange={(v) => setParam('direction', v)}
          style={{ width: 170 }}
        />
        {view === 'list' ? (
          <>
            <FgSelect
              ariaLabel="Nhóm tuổi nợ"
              placeholder="Mọi nhóm tuổi nợ"
              allowClear
              options={Object.entries(AGING_BUCKET_LABEL).map(([value, label]) => ({ value, label }))}
              value={bucket}
              onChange={(v) => setParam('bucket', v)}
              style={{ width: 190 }}
            />
            <FgSelect
              ariaLabel="Quá hạn"
              placeholder="Mọi hạn"
              allowClear
              options={[{ value: 'true', label: 'Chỉ quá hạn còn lại' }]}
              value={overdueOnly ? 'true' : undefined}
              onChange={(v) => setParam('overdue_only', v ? 'true' : undefined)}
              style={{ width: 190 }}
            />
            <FgInput
              allowClear
              placeholder="Tìm theo đối tác, mã, số hợp đồng"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setParam('page');
              }}
              style={{ width: 260 }}
            />
          </>
        ) : null}
        {partnerId ? (
          <FgToneChip tone="info">
            Đối tác: {partner.data?.name ?? '…'}{' '}
            <button type="button" aria-label="Bỏ lọc đối tác" onClick={() => setParam('partner_id')} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'inherit' }}>
              ×
            </button>
          </FgToneChip>
        ) : null}
      </div>

      {view === 'aging' ? (
        <DebtAgingPanel direction={direction} />
      ) : (
        <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={8} />}>
          {(data) => {
            if (!data.items.length) {
              return (
                <div className="fg-card">
                  <FgEmptyState glyph="◇" title="Chưa có khoản công nợ nào" description="Tạo khoản phải thu hoặc phải trả cho khách hàng / nhà cung cấp." />
                </div>
              );
            }
            const open = data.items.filter((r) => minorOf(r.remaining) > 0n);
            const settled = data.items.filter((r) => minorOf(r.remaining) <= 0n);
            return (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
                  <KpiCard label="Tổng giá trị" value={data.totals.value} />
                  <KpiCard label="Đã cấn trừ" value={data.totals.offset_applied} />
                  <KpiCard label="Còn lại" value={data.totals.remaining} emphasis />
                </div>
                <div className="fg-card" style={{ padding: 0 }}>
                  <FgTable rowKey="_id" tableLayout="auto" dataSource={open} columns={debtColumns()} />
                </div>
                {settled.length ? (
                  <div style={{ marginTop: 'var(--fg-space-4)' }}>
                    <FgButton size="small" onClick={() => setShowSettled((s) => !s)}>
                      {showSettled ? '▲ Ẩn' : '▼ Hiện'} các khoản đã cấn trừ đủ ({settled.length})
                    </FgButton>
                    {showSettled ? (
                      <div className="fg-card" style={{ padding: 0, marginTop: 'var(--fg-space-2)' }}>
                        <FgTable rowKey="_id" size="small" tableLayout="auto" dataSource={settled} columns={debtColumns()} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {data.truncated ? (
                  <FgAlert
                    tone="warning"
                    title={`Danh sách đã chạm giới hạn ${DEBT_MAX_ROWS_UI} dòng — tổng và KPI chỉ tính trên phần đã nạp; hãy thu hẹp bộ lọc`}
                    style={{ marginTop: 'var(--fg-space-3)' }}
                  />
                ) : null}
                {data.total > data.limit ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--fg-space-2)', padding: 'var(--fg-space-4) 0' }}>
                    <FgText style="caption" color="muted">
                      {`Hiển thị ${(page - 1) * data.limit + 1}–${Math.min(page * data.limit, data.total)} / ${data.total} khoản`}
                    </FgText>
                    <FgPagination current={page} pageSize={data.limit} total={data.total} showSizeChanger={false} onChange={(p) => setParam('page', String(p))} />
                  </div>
                ) : null}
              </>
            );
          }}
        </FgQuery>
      )}
    </>
  );
}

/* ============================== tạo / sửa khoản công nợ (DEBT-01 / DEBT-04) ============================== */

interface DebtFormState {
  partner_id: string | null;
  /** Người dùng tự chọn hướng (v2 §9.1) — chưa chọn thì để trống, không suy từ loại đối tác. */
  direction: DebtDirection | null;
  value: Money | null;
  due_date: string;
  contract_code: string;
  priority: string;
  note: string;
}

export function DebtVoucherFormScreen(): ReactNode {
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const company = useCurrentCompanyId();
  const existing = useDebt(id);
  const create = useCreateDebt();
  const update = useUpdateDebt(id ?? '');
  const { message } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [prefilled, setPrefilled] = useState(false);
  const editMode = !!id;
  const detail = existing.data;
  // Mã chống gửi lặp: giữ nguyên qua các lần bấm lưu lại (retry) của cùng một form.
  const requestIdRef = useRef<string>(newRequestId());
  const [f, setF] = useState<DebtFormState>(() => ({
    partner_id: searchParams.get('partner_id') || null,
    // Không có tham số ⇒ để trống (KHÔNG mặc định phải thu). `?side` chỉ là đường dẫn v1 (debit/credit).
    direction: parseDirection(searchParams.get('direction')) ?? (searchParams.get('side') ? directionFromSide(searchParams.get('side')) : null),
    value: null,
    due_date: dayjs().add(7, 'day').format('YYYY-MM-DD'),
    contract_code: '',
    priority: 'normal',
    note: '',
  }));

  useEffect(() => {
    if (!detail || prefilled) return;
    setF({
      partner_id: detail.partner_id,
      direction: detail.direction,
      value: moneyFromWire(detail.value),
      due_date: detail.due_date,
      contract_code: detail.contract_code ?? '',
      priority: detail.priority,
      note: detail.note ?? '',
    });
    setPrefilled(true);
  }, [detail, prefilled]);

  const readOnly = !!detail?.read_only;
  const locked = !!detail && detail.offset_links.length > 0;
  const selectedPartner = usePartner(f.partner_id);
  const partnerType = selectedPartner.data?.type ?? detail?.partner?.type ?? null;
  const busy = create.isPending || update.isPending;

  const submit = async (): Promise<void> => {
    setErrors({});
    if (!f.partner_id) {
      setErrors({ partner_id: 'Chọn khách hàng hoặc nhà cung cấp' });
      return;
    }
    if (!f.value || f.value.minor <= 0n) {
      setErrors({ value: 'Nhập số tiền lớn hơn 0' });
      return;
    }
    if (!f.due_date) {
      setErrors({ due_date: 'Chọn hạn thanh toán' });
      return;
    }
    // Hướng do người dùng chọn — bắt buộc (không suy từ loại đối tác).
    if (!f.direction) {
      setErrors({ direction: 'Chọn hướng: phải thu (đối tác nợ công ty) hoặc phải trả (công ty nợ đối tác)' });
      return;
    }
    const direction = f.direction;
    const value = { amount_minor: f.value.minor.toString(), currency: f.value.currency };
    try {
      if (editMode) {
        if (!detail) {
          message.error('Chưa tải được khoản công nợ');
          return;
        }
        // Đổi đối tác / hướng chỉ gửi khi thực sự đổi (server chặn khi đã có cấn trừ).
        const body: DebtUpdateInput = {
          value,
          due_date: f.due_date,
          contract_code: f.contract_code.trim() || null,
          priority: f.priority,
          note: f.note.trim() || null,
        };
        if (f.partner_id !== detail.partner_id) body.partner_id = f.partner_id;
        if (direction !== detail.direction) body.direction = direction;
        await update.mutateAsync(body);
        message.success('Đã cập nhật khoản công nợ');
        navigate(`/cong-no/phieu/${id}`);
        return;
      }
      if (!company) {
        message.error('Chưa chọn công ty');
        return;
      }
      const r = await create.mutateAsync({
        company_id: company,
        partner_id: f.partner_id,
        direction,
        value,
        due_date: f.due_date,
        priority: f.priority,
        request_id: requestIdRef.current,
        ...(f.contract_code.trim() ? { contract_code: f.contract_code.trim() } : {}),
        ...(f.note.trim() ? { note: f.note.trim() } : {}),
      });
      message.success('Đã lưu khoản công nợ');
      navigate(`/cong-no/phieu/${r._id}`);
    } catch (e) {
      if (e instanceof ApiRequestError && e.problem.errors) setErrors(e.problem.errors);
      message.error(problemText(e, 'Không lưu được khoản công nợ'));
    }
  };

  if (editMode && !detail) {
    return (
      <>
        <FgPageHeader title="Sửa khoản công nợ" />
        <FgSkeletonTable rows={4} cols={3} />
      </>
    );
  }

  return (
    <>
      <FgPageHeader
        title={editMode && detail ? `Sửa khoản công nợ ${detail.code}` : 'Tạo khoản công nợ'}
        meta="Chọn đối tác (KH / NCC) và hướng — TK kế toán tự suy theo loại đối tác"
      />
      {readOnly ? <FgAlert tone="warning" title="Khoản của nhân viên (TK 334) chỉ đọc — không sửa trên màn này" style={{ marginBottom: 'var(--fg-space-4)' }} /> : null}
      {locked ? (
        <FgAlert
          tone="info"
          title="Đã có phiếu cấn trừ: không đổi đối tác hoặc hướng. Gỡ cấn trừ trước nếu cần đổi."
          style={{ marginBottom: 'var(--fg-space-4)' }}
        />
      ) : null}
      <div className="fg-form-grid">
        <FgCard>
          <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
            <PartnerPicker
              value={f.partner_id}
              onChange={(pid) => setF((s) => ({ ...s, partner_id: pid }))}
              allowedTypes={['customer', 'supplier']}
              companyId={editMode ? detail?.company_id : company}
              label="Khách hàng / Nhà cung cấp"
              required
              error={errors['partner_id']}
              disabled={readOnly}
              lockSelection={locked}
            />
            <FgField label="Hướng công nợ *" error={errors['direction']} help="Phải thu: đối tác nợ công ty · Phải trả: công ty nợ đối tác">
              <FgSegmented
                // `null` = chưa chọn (không truyền `undefined`: antd sẽ hiển thị mục đầu như đã chọn).
                value={f.direction}
                onChange={(v) => setF((s) => ({ ...s, direction: String(v) as DebtDirection }))}
                options={DIRECTION_OPTIONS}
                disabled={locked || readOnly}
              />
            </FgField>
            <FgField label="Số tiền *" error={errors['value']} help={f.value ? formatMoney(f.value, { mode: 'full' }) : 'Gõ "2,5 tỷ" hoặc "850 tr"'}>
              <FgMoneyInput value={f.value} onChange={(v) => setF((s) => ({ ...s, value: v }))} disabled={readOnly} />
            </FgField>
            <FgField label="Hạn thanh toán *" error={errors['due_date']}>
              <DatePicker
                value={f.due_date ? dayjs(f.due_date) : null}
                onChange={(d) => setF((s) => ({ ...s, due_date: d ? d.format('YYYY-MM-DD') : '' }))}
                format="DD/MM/YYYY"
                style={{ width: '100%' }}
                disabled={readOnly}
              />
            </FgField>
            <FgField label="Số hợp đồng" error={errors['contract_code']}>
              <FgInput
                value={f.contract_code}
                onChange={(e) => setF((s) => ({ ...s, contract_code: e.target.value }))}
                placeholder="Nếu có"
                maxLength={80}
                disabled={readOnly}
              />
            </FgField>
            <FgField label="Mức ưu tiên">
              <FgSelect options={PRIORITY_OPTIONS} value={f.priority} onChange={(v) => setF((s) => ({ ...s, priority: v ?? 'normal' }))} style={{ width: '100%' }} disabled={readOnly} />
            </FgField>
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Ghi chú" error={errors['note']}>
                <FgTextarea rows={3} value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} disabled={readOnly} />
              </FgField>
            </div>
          </div>
        </FgCard>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}>
          <FgCard title="Tóm tắt">
            <div className="fg-stat-row">
              <span className="fg-stat-label">Tài khoản kế toán</span>
              <span>{accountLabelOf(partnerType)}</span>
            </div>
            <div className="fg-stat-row">
              <span className="fg-stat-label">Hướng</span>
              <span>
                {f.direction ? `${DEBT_DIRECTION_LABEL[f.direction]} · ghi ${sideOfDirection(f.direction) === 'debit' ? 'Nợ' : 'Có'}` : 'Chưa chọn'}
              </span>
            </div>
            {f.value ? (
              <div className="fg-stat-row">
                <span className="fg-stat-label">Số tiền</span>
                <span>{formatMoney(f.value, { mode: 'full' })}</span>
              </div>
            ) : null}
          </FgCard>
          <FgCard title={editMode ? 'Cập nhật' : 'Lưu'}>
            <FgButton variant="primary" block loading={busy} disabled={readOnly} onClick={() => void submit()}>
              {editMode ? 'Lưu thay đổi' : 'Lưu khoản công nợ'}
            </FgButton>
            <div style={{ marginTop: 8 }}>
              <FgButton block onClick={() => navigate(-1)}>
                Hủy
              </FgButton>
            </div>
            <FgText style="caption" color="muted">
              Sau khi lưu: gán phiếu thu/chi cấn trừ và đính kèm chứng từ ngay trong chi tiết khoản.
            </FgText>
          </FgCard>
        </div>
      </div>
    </>
  );
}

/* ============================== chi tiết công nợ (DEBT-02 / DEBT-04) ============================== */

function offsetColumns(onRemove: ((row: OffsetLinkRow) => void) | null): TableColumnsType<OffsetLinkRow> {
  const cols: TableColumnsType<OffsetLinkRow> = [
    {
      title: 'Phiếu',
      key: 'doc',
      render: (_v, r: OffsetLinkRow) => (
        <div>
          <Link className="fg-link" to={voucherHref(r.document_kind, r.document_id)}>
            {r.document_code}
          </Link>
          <FgText style="caption" color="muted">
            {' '}
            · {r.document_title || (r.document_kind === 'income' ? 'Phiếu thu' : 'Phiếu chi')}
          </FgText>
        </div>
      ),
    },
    { title: 'Loại', key: 'kind', render: (_v, r: OffsetLinkRow) => (r.document_kind === 'income' ? 'Phiếu thu' : 'Phiếu chi') },
    {
      title: 'Trạng thái phiếu',
      key: 'status',
      render: (_v, r: OffsetLinkRow) => <FgToneChip tone={r.executed ? 'success' : 'neutral'}>{statusLabelVi(r.document_status)}</FgToneChip>,
    },
    {
      title: 'Hiệu lực',
      key: 'effective',
      // Phiếu đã huỷ / từ chối / hết hạn không bao giờ trừ — không ghi "Chờ thực thi" (v2 §9.2).
      render: (_v, r: OffsetLinkRow) => {
        const eff = OFFSET_EFFECT_LABEL[offsetEffectOf(r)];
        return <FgToneChip tone={eff.tone}>{eff.label}</FgToneChip>;
      },
    },
    {
      title: 'Số tiền phân bổ',
      key: 'amount',
      align: 'right',
      render: (_v, r: OffsetLinkRow) => <FgMoneyStack value={moneyFromWire(r.amount)} />,
    },
    {
      title: 'Nguồn',
      key: 'origin',
      render: (_v, r: OffsetLinkRow) => (
        <FgTag tone={r.origin === 'automation' ? 'info' : 'neutral'}>
          {LINK_ORIGIN_LABEL[r.origin] ?? r.origin}
          {r.rule_code ? ` · ${r.rule_code}` : ''}
        </FgTag>
      ),
    },
  ];
  if (onRemove) {
    cols.push({
      title: '',
      key: 'act',
      render: (_v, r: OffsetLinkRow) => (
        <FgButton size="small" variant="danger" onClick={() => onRemove(r)}>
          Gỡ
        </FgButton>
      ),
    });
  }
  return cols;
}

export function DebtDetailScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useDebt(id);
  const unlink = useRemoveDebtOffset(id ?? '');
  const del = useDeleteDebt();
  const { message } = useToast();
  const [linkOpen, setLinkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<OffsetLinkRow | null>(null);

  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={3} />}>
      {(d: DebtDetail) => {
        const editable = !d.read_only;
        const remaining = minorOf(d.remaining);
        return (
          <>
            <FgPageHeader
              title={`${d.code} · ${partnerNameOf(d)}`}
              meta={`${PARTY_LABEL[d.party_type] ?? d.party_type} · TK ${d.account_code} · ${DEBT_DIRECTION_LABEL[d.direction]} (ghi ${d.side === 'debit' ? 'Nợ' : 'Có'})`}
              actions={
                <>
                  {editable && can('debt:write') && can('link:manage') ? (
                    <FgButton variant="primary" onClick={() => setLinkOpen(true)}>
                      + Gán phiếu cấn trừ
                    </FgButton>
                  ) : null}
                  {editable && can('debt:update') ? <FgButton onClick={() => navigate(`/cong-no/phieu/${d._id}/sua`)}>Sửa</FgButton> : null}
                  {editable && can('debt:delete') && d.link_count === 0 ? (
                    <FgButton variant="danger" onClick={() => setDeleteOpen(true)}>
                      Xoá
                    </FgButton>
                  ) : null}
                </>
              }
            />

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 'var(--fg-space-4)' }}>
              <FgToneChip tone={DEBT_FILL_LABEL[d.status].tone}>{DEBT_FILL_LABEL[d.status].label}</FgToneChip>
              {remaining > 0n ? (
                d.days_overdue > 0 ? (
                  <FgToneChip tone="danger">
                    ⛔ Quá hạn {d.days_overdue} ngày · {AGING_BUCKET_LABEL[d.aging_bucket]}
                  </FgToneChip>
                ) : (
                  <FgToneChip tone="info">Chưa đến hạn</FgToneChip>
                )
              ) : (
                <FgToneChip tone="success">Đã thanh toán đủ</FgToneChip>
              )}
              {d.read_only ? <FgToneChip tone="neutral">Chỉ đọc (TK 334)</FgToneChip> : null}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
              <KpiCard label="Giá trị" value={d.value} />
              <KpiCard label="Đã cấn trừ" value={d.offset_applied} />
              <KpiCard label="Còn lại" value={d.remaining} emphasis />
              <FgCard className="fg-kpi">
                <FgText style="caption" color="muted">
                  Hạn thanh toán
                </FgText>
                <div className="fg-kpi-value" style={{ fontSize: 'var(--fg-font-number-m-size)' }}>
                  {ddmmyyyy(d.due_date)}
                </div>
                <FgText style="caption" color="muted">
                  {remaining > 0n ? (d.days_overdue > 0 ? `Quá ${d.days_overdue} ngày` : 'Chưa quá hạn') : 'Không còn dư'}
                </FgText>
              </FgCard>
            </div>

            <FgCard title="Thông tin" style={{ marginBottom: 'var(--fg-space-4)' }}>
              <FgDescriptions
                size="small"
                column={{ xs: 1, sm: 2, lg: 3 }}
                items={[
                  {
                    key: 'partner',
                    label: 'Đối tác',
                    children: d.partner_id ? (
                      <Link className="fg-link" to={`/doi-tac/${d.partner_id}`}>
                        {partnerNameOf(d)}
                      </Link>
                    ) : (
                      partnerNameOf(d)
                    ),
                  },
                  { key: 'type', label: 'Loại đối tác', children: d.partner ? PARTNER_TYPE_LABEL[d.partner.type as keyof typeof PARTNER_TYPE_LABEL] ?? d.partner.type : '—' },
                  { key: 'contract', label: 'Số hợp đồng', children: d.contract_code ?? '—' },
                  { key: 'priority', label: 'Ưu tiên', children: PRIORITY_LABEL[d.priority] ?? d.priority },
                  { key: 'company', label: 'Công ty', children: d.company_name || '—' },
                  { key: 'note', label: 'Ghi chú', children: d.note || '—' },
                ]}
              />
            </FgCard>

            <FgCard title="Cấn trừ bằng phiếu" style={{ marginBottom: 'var(--fg-space-4)' }}>
              <div style={{ marginBottom: 8 }}>
                <FgText style="caption" color="muted">
                  {d.direction === 'receivable' ? 'Phiếu thu' : 'Phiếu chi'} cùng đối tác. Chỉ phiếu <strong>đã thực thi</strong> mới tính vào "Đã cấn trừ"; phiếu
                  chờ thực thi sẽ tự trừ khi thực thi — không cần gán lại.
                </FgText>
              </div>
              {hasDeadOffsetLink(d.offset_links) ? (
                <FgAlert
                  tone="warning"
                  title="Có liên kết tới phiếu đã huỷ / từ chối / hết hạn — không còn tính vào sức chứa. Nên gỡ liên kết đó để sổ sạch."
                  style={{ marginBottom: 'var(--fg-space-3)' }}
                />
              ) : null}
              {!d.offset_links.length ? (
                <FgEmptyState glyph="◇" title="Chưa cấn trừ phiếu nào" description="Gán phiếu đã có để giảm số còn phải thu / phải trả." />
              ) : (
                <FgTable
                  rowKey="_id"
                  dataSource={d.offset_links}
                  columns={offsetColumns(editable && can('debt:write') && can('link:manage') ? (r) => setUnlinking(r) : null)}
                />
              )}
            </FgCard>

            <OwnerAttachmentSection base="/debts" ownerId={d._id} attachments={d.attachments} onChanged={() => void query.refetch()} />

            <ChangeHistoryCard history={d.history} kind="debt" />

            {linkOpen && id ? <OffsetPickerModal debtId={id} direction={d.direction} onClose={() => setLinkOpen(false)} /> : null}

            {unlinking && id ? (
              <RemoveLinkModal
                title="Gỡ cấn trừ"
                target={`Gỡ phiếu ${unlinking.document_code} khỏi khoản ${d.code}. Liên kết được đánh dấu đã gỡ, không xoá.`}
                loading={unlink.isPending}
                onCancel={() => setUnlinking(null)}
                onConfirm={(reason) =>
                  unlink.mutate(
                    { linkId: unlinking.link_id, reason },
                    {
                      onSuccess: () => {
                        message.success('Đã gỡ cấn trừ');
                        setUnlinking(null);
                      },
                      onError: (e) => message.error(problemText(e, 'Không gỡ được cấn trừ')),
                    },
                  )
                }
              />
            ) : null}

            {deleteOpen && id ? (
              <FgModal
                open
                title="Xoá khoản công nợ"
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
                            message.success('Đã xoá khoản công nợ');
                            navigate('/cong-no');
                          },
                          onError: (e) => message.error(problemText(e, 'Không xoá được khoản công nợ')),
                        })
                      }
                    >
                      Xoá
                    </FgButton>
                  </>
                }
              >
                <FgText style="body">
                  Xoá khoản <strong>{d.code}</strong> · {partnerNameOf(d)}? Không xoá được khi còn phiếu cấn trừ — gỡ cấn trừ trước. Thao tác ghi audit.
                </FgText>
              </FgModal>
            ) : null}
          </>
        );
      }}
    </FgQuery>
  );
}

/* ============================== gán phiếu cấn trừ (US-DEBT-02) ============================== */

/** Phiếu thu (phải thu) / phiếu chi (phải trả) cùng đối tác, còn có thể phân bổ. Số tiền tuỳ chọn. */
function OffsetPickerModal({ debtId, direction, onClose }: { debtId: string; direction: DebtDirection; onClose: () => void }): ReactNode {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [amount, setAmount] = useState<Money | null>(null);
  const candidates = useDebtOffsetCandidates(debtId, q);
  const assign = useAssignDebtOffset(debtId);
  const { message } = useToast();
  const kindLabel = docKindOfDirection(direction) === 'income' ? 'phiếu thu' : 'phiếu chi';

  const pick = (documentId: string): void => {
    assign.mutate(
      { document_id: documentId, ...(amount ? { amount_minor: amount.minor.toString() } : {}) },
      {
        onSuccess: () => {
          message.success('Đã gán phiếu cấn trừ');
          onClose();
        },
        onError: (e) => message.error(problemText(e, 'Không gán được phiếu')),
      },
    );
  };

  const columns: TableColumnsType<DocCandidate> = [
    { title: 'Mã', dataIndex: 'code', key: 'code' },
    { title: 'Nội dung', dataIndex: 'title', key: 'title', render: (v: string) => v || '—' },
    { title: 'Trạng thái', dataIndex: 'status', key: 'st', render: (v: string) => statusLabelVi(v) },
    { title: 'Số tiền', dataIndex: 'amount', key: 'amount', align: 'right', render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} /> },
    { title: 'Còn phân bổ', dataIndex: 'unallocated', key: 'free', align: 'right', render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} /> },
    {
      title: '',
      key: 'act',
      render: (_v, r: DocCandidate) =>
        r.already_linked ? (
          <FgTag tone="info">Đã gán</FgTag>
        ) : (
          <FgButton size="small" disabled={minorOf(r.unallocated) <= 0n} loading={assign.isPending} onClick={() => pick(r._id)}>
            Gán
          </FgButton>
        ),
    },
  ];

  return (
    <FgModal open title="Gán phiếu cấn trừ" onCancel={onClose} width={760} footer={<FgButton onClick={onClose}>Đóng</FgButton>}>
      <FgText style="caption" color="muted">
        {direction === 'receivable' ? 'Khoản phải thu: chỉ gán phiếu thu' : 'Khoản phải trả: chỉ gán phiếu chi'} cùng đối tác, chưa huỷ. Chỉ phiếu đã thực thi mới trừ
        ngay; phiếu chờ thực thi sẽ tự trừ khi thực thi.
      </FgText>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px,1fr) minmax(180px,220px)', gap: 'var(--fg-space-3)', margin: '12px 0' }}>
        <FgField label="Tìm theo mã / nội dung">
          <FgInput allowClear value={search} onChange={(e) => setSearch(e.target.value)} placeholder="VD: PT-2026 hoặc nội dung" />
        </FgField>
        <FgField label="Số tiền cấn trừ" help="Bỏ trống = phần còn lại có thể phân bổ">
          <FgMoneyInput value={amount} onChange={setAmount} />
        </FgField>
      </div>
      {candidates.isLoading ? (
        <FgSkeletonTable rows={4} cols={4} />
      ) : !candidates.data?.items.length ? (
        <FgEmptyState glyph="◇" title={`Không có ${kindLabel} phù hợp`} description="Phiếu phải cùng đối tác và chưa huỷ." />
      ) : (
        <FgTable rowKey="_id" size="small" dataSource={candidates.data.items} columns={columns} />
      )}
    </FgModal>
  );
}

/** Xác nhận gỡ liên kết: bắt buộc lý do ≥ 5 ký tự (server ghi vào lịch sử). */
export function RemoveLinkModal({
  title,
  target,
  loading,
  onCancel,
  onConfirm,
}: {
  title: string;
  target: string;
  loading?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}): ReactNode {
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= 5;
  return (
    <FgModal
      open
      title={title}
      onCancel={onCancel}
      width={480}
      footer={
        <>
          <FgButton onClick={onCancel} disabled={loading}>
            Hủy
          </FgButton>
          <FgButton variant="danger" loading={loading} disabled={!valid} onClick={() => onConfirm(reason.trim())}>
            Gỡ liên kết
          </FgButton>
        </>
      }
    >
      <FgText style="body">{target}</FgText>
      <FgField label="Lý do gỡ liên kết *" help="Tối thiểu 5 ký tự — ghi vào lịch sử" error={reason && !valid ? 'Nêu lý do (tối thiểu 5 ký tự)' : null}>
        <FgInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </FgField>
    </FgModal>
  );
}

/* ====================== dùng chung: chứng từ đính kèm ====================== */

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
  const [toRemove, setToRemove] = useState<OwnerAttachment | null>(null);
  const [removing, setRemoving] = useState(false);
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

  const onRemove = async (): Promise<void> => {
    if (!toRemove) return;
    setError(null);
    setRemoving(true);
    try {
      await removeOwnerAttachment({ base, ownerId, attachmentId: toRemove.id });
      message.success('Đã xoá chứng từ');
      setToRemove(null);
      onChanged();
    } catch (e) {
      setError(problemText(e, 'Không xoá được chứng từ'));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <FgCard
      title="Chứng từ đính kèm"
      extra={
        <FgButton variant="primary" size="small" loading={busy} onClick={() => fileRef.current?.click()}
        >
          + Thêm chứng từ (PDF/ảnh, tối đa 100MB)
        </FgButton>
      }
    >
      {list.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
          {list.map((a) => (
            <div key={a.id} style={{ position: 'relative', width: 160 }}>
              <button
                type="button"
                onClick={() => setPreview(a)}
                title={a.filename}
                aria-label={`Xem ${a.filename}`}
                style={{
                  width: '100%',
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
              {a.referenced ? null : (
                <button
                  type="button"
                  onClick={() => setToRemove(a)}
                  title="Xoá chứng từ"
                  aria-label={`Xoá ${a.filename}`}
                  style={{
                    position: 'absolute',
                    top: 4,
                    right: 4,
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    border: 'none',
                    background: 'var(--fg-bg-surface)',
                    color: 'var(--fg-status-danger-text)',
                    cursor: 'pointer',
                    lineHeight: '24px',
                    padding: 0,
                    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <FgText style="caption" color="muted">
          Chưa có chứng từ. Tải lên ảnh/PDF bên dưới để xem ngay tại đây.
        </FgText>
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
      {error ? (
        <div style={{ marginTop: 8 }}>
          <FgAlert tone="danger" title={error} />
        </div>
      ) : null}
      {preview ? <AttachmentPreviewModal att={preview} onClose={() => setPreview(null)} /> : null}
      {toRemove ? (
        <FgModal
          open
          title="Xoá chứng từ"
          onCancel={() => setToRemove(null)}
          width={480}
          footer={
            <>
              <FgButton onClick={() => setToRemove(null)} disabled={removing}>
                Hủy
              </FgButton>
              <FgButton variant="danger" loading={removing} onClick={() => void onRemove()}>
                Xoá
              </FgButton>
            </>
          }
        >
          <FgText style="body">
            Xoá chứng từ <strong>{toRemove.filename}</strong>? Thao tác ghi audit.
          </FgText>
        </FgModal>
      ) : null}
    </FgCard>
  );
}

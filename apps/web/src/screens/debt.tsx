/**
 * Công nợ — phiếu công nợ theo chuẩn kế toán VN (KH=131, NCC=331, NV=334; Nợ/Có).
 * Cấn trừ với phiếu thu/chi — liên kết bất kỳ lúc nào, hiệu lực khi phiếu ở trạng thái "Đã thanh toán".
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { ACCOUNT_CODE_BY_PARTY, DEBT_PARTY_LABEL, DEBT_SIDE_LABEL, formatMoney, moneyFromWire, type DebtPartyType, type Money } from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useAuth, useCurrentCompanyId } from '../app/store.tsx';
import { useBankDebtCandidates, useCreateDebtVoucher, useDebtCandidates, useDebtVoucher, useDebtVouchers, useDeleteDebtVoucher, useLinkDebt, useUnlinkDebt, useUpdateDebtVoucher } from '../app/queries.ts';
import { FgAlert, FgButton, FgField, FgInput, FgMoney, FgMoneyInput, FgSelect, FgText, FgTextarea } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgModal, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
import { acceptOwnerFile, attachmentHref, AttachmentPreviewModal, isImage, problemText, uploadOwnerAttachment } from '../components/attachments.tsx';
import type { OwnerAttachment } from '../app/types.ts';
import { STATUS_REGISTRY, type StatusKey } from '@fingate/shared';

const PARTY_OPTIONS = (Object.keys(DEBT_PARTY_LABEL) as DebtPartyType[]).map((v) => ({ value: v, label: `${DEBT_PARTY_LABEL[v]} (TK ${ACCOUNT_CODE_BY_PARTY[v]})` }));

function statusLabelVi(s: string): string {
  return STATUS_REGISTRY[s as StatusKey]?.labelVi ?? s;
}

/* ============================== DEBT-01/03 list ============================== */

export function DebtListScreen({ side, title }: { side: 'debit' | 'credit'; title: string }): ReactNode {
  const [partyType, setPartyType] = useState<string | undefined>();
  const query = useDebtVouchers({ side, party_type: partyType });
  return (
    <>
      <FgPageHeader
        title={title}
        meta="Công nợ ghi Nợ/Có — đã cấn trừ tính từ các phiếu thu/chi đã thực thi"
        actions={
          <Link to={`/cong-no/${side === 'debit' ? 'phai-thu' : 'phai-tra'}/moi`}>
            <FgButton variant="primary">+ Tạo phiếu công nợ</FgButton>
          </Link>
        }
      />
      <div className="fg-filterbar">
        <FgSelect
          ariaLabel="Loại đối tượng"
          placeholder="Mọi đối tượng"
          allowClear
          options={PARTY_OPTIONS}
          value={partyType}
          onChange={(v) => setPartyType(v)}
          style={{ width: 220 }}
        />
      </div>
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={7} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState glyph="◇" title="Chưa có phiếu công nợ nào" />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable
                rowKey="_id"
                dataSource={data.items}
                columns={[
                  { title: 'Mã', dataIndex: 'code', key: 'code', render: (v, r) => <Link className="fg-link" to={`/cong-no/phieu/${r._id}`}>{v}</Link> },
                  { title: 'Đối tượng', key: 'party', render: (_v, r) => `${r.party_code} · ${r.party_name}` },
                  { title: 'TK', dataIndex: 'account_code', key: 'acct' },
                  { title: 'Nợ/Có', dataIndex: 'side', key: 'side', render: (v: 'debit' | 'credit') => DEBT_SIDE_LABEL[v] },
                  { title: 'Giá trị', dataIndex: 'value', key: 'value', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                  { title: 'Đã cấn trừ', dataIndex: 'settled', key: 'settled', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                  { title: 'Còn lại', dataIndex: 'remaining', key: 'remaining', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" emphasis /> },
                  { title: 'Hạn', dataIndex: 'due_date', key: 'due' },
                  {
                    title: 'Quá hạn',
                    key: 'ov',
                    render: (_v, r) =>
                      r.days_overdue > 0 ? (
                        <span className="fg-chip" style={{ borderColor: 'var(--fg-status-danger-border)', color: 'var(--fg-status-danger-text)', background: 'var(--fg-status-danger-bg)' }}>
                          ⛔ {r.days_overdue} ngày
                        </span>
                      ) : (
                        <FgText style="caption" color="muted">đúng hạn</FgText>
                      ),
                  },
                ]}
              />
            </div>
          )
        }
      </FgQuery>
    </>
  );
}

/* ===================== DEBT-01/DEBT-02 create + edit ===================== */

export function DebtVoucherFormScreen({ side }: { side?: 'debit' | 'credit' }): ReactNode {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const company = useCurrentCompanyId();
  const existing = useDebtVoucher(id);
  const create = useCreateDebtVoucher();
  const update = useUpdateDebtVoucher(id ?? '');
  const { message } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [prefilled, setPrefilled] = useState(false);
  const [f, setF] = useState<{
    party_type: DebtPartyType;
    party_code: string;
    party_name: string;
    party_tax_code: string;
    party_bank_account: string;
    value: Money | null;
    due_date: string;
    priority: string;
    note: string;
  }>({ party_type: 'customer', party_code: '', party_name: '', party_tax_code: '', party_bank_account: '', value: null, due_date: dayjs().add(7, 'day').format('YYYY-MM-DD'), priority: 'normal', note: '' });

  const editMode = !!id;
  const effectiveSide: 'debit' | 'credit' = editMode ? (existing.data?.side ?? 'debit') : (side ?? 'debit');

  useEffect(() => {
    const d = existing.data;
    if (!d || prefilled) return;
    setF({
      party_type: d.party_type,
      party_code: d.party_code,
      party_name: d.party_name,
      party_tax_code: d.party_tax_code ?? '',
      party_bank_account: d.party_bank_account ?? '',
      value: moneyFromWire(d.value),
      due_date: d.due_date,
      priority: d.priority,
      note: d.note ?? '',
    });
    setPrefilled(true);
  }, [existing.data, prefilled]);

  const submit = async (): Promise<void> => {
    setErrors({});
    if (!f.party_code.trim() || !f.party_name.trim()) {
      message.error('Nhập mã và tên đối tượng');
      return;
    }
    if (!f.value || f.value.minor <= 0n) {
      message.error('Nhập số tiền');
      return;
    }
    const body: Record<string, unknown> = {
      party_type: f.party_type,
      party_code: f.party_code.trim(),
      party_name: f.party_name.trim(),
      party_tax_code: f.party_tax_code.trim() || undefined,
      party_bank_account: f.party_bank_account.trim() || undefined,
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
      const r = await create.mutateAsync({ company_id: company, side: effectiveSide, ...body });
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
        title={editMode ? `Sửa phiếu công nợ ${existing.data?.code ?? ''}` : `Tạo phiếu công nợ — ${DEBT_SIDE_LABEL[effectiveSide]}`}
        meta={`TK tự suy theo loại đối tượng: KH 131 · NCC 331 · NV 334`}
      />
      <div className="fg-form-grid">
        <FgCard>
          <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
            <FgField label="Loại đối tượng *" error={errors['party_type']}>
              <FgSelect options={PARTY_OPTIONS} value={f.party_type} onChange={(v) => setF((s) => ({ ...s, party_type: (v as DebtPartyType) ?? 'customer' }))} style={{ width: '100%' }} />
            </FgField>
            <FgField label="Mã đối tượng *" error={errors['party_code']}>
              <FgInput value={f.party_code} onChange={(e) => setF((s) => ({ ...s, party_code: e.target.value }))} placeholder="VD: KH-001 / NCC-010 / NV-001" />
            </FgField>
            <FgField label="Tên công ty / đối tượng *" error={errors['party_name']}>
              <FgInput value={f.party_name} onChange={(e) => setF((s) => ({ ...s, party_name: e.target.value }))} />
            </FgField>
            <FgField label="Mã số thuế">
              <FgInput value={f.party_tax_code} onChange={(e) => setF((s) => ({ ...s, party_tax_code: e.target.value }))} />
            </FgField>
            <FgField label="STK của công ty đối tác">
              <FgInput value={f.party_bank_account} onChange={(e) => setF((s) => ({ ...s, party_bank_account: e.target.value }))} />
            </FgField>
            <FgField label="Số tiền *" error={errors['value']} help={f.value ? formatMoney(f.value, { mode: 'full' }) : 'Gõ "2,5 tỷ" hoặc "850 tr"'}>
              <FgMoneyInput value={f.value} onChange={(v) => setF((s) => ({ ...s, value: v }))} />
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
              {editMode && existing.data ? `Phiếu ${existing.data.code} · ghi ${DEBT_SIDE_LABEL[existing.data.side]}` : `Phiếu mới — ghi ${DEBT_SIDE_LABEL[effectiveSide]}`}
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
            {!d.document_links.length ? (
              <FgEmptyState glyph="◇" title="Chưa liên kết phiếu nào" description="Liên kết phiếu thu/chi — khi phiếu được thực thi, công nợ tự trừ." />
            ) : (
              <FgTable
                rowKey="_id"
                dataSource={d.document_links}
                columns={[
                  { title: 'Phiếu', key: 'doc', render: (_v, r) => `${r.document_code} · ${r.document_title}` },
                  { title: 'Trạng thái', dataIndex: 'document_status', key: 'st', render: (v: string) => statusLabelVi(v) },
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
                          navigate('/cong-no/phai-thu');
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

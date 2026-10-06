/**
 * Nợ Ngân hàng — phiếu nợ gồm ngân hàng, chi nhánh, số tiền vay, lãi suất, hạn thanh toán,
 * hợp đồng đính kèm (PDF/ảnh ≤100MB) và gán phiếu chi để đánh dấu đã trả nợ.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { formatMoney, moneyFromWire, type Money } from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useAuth, useCurrentCompanyId } from '../app/store.tsx';
import { useBankDebt, useBankDebts, useCreateBankDebt, useDeleteBankDebt, useLoanSchedule, useRepayBankDebt, useUnrepayBankDebt, useUpdateBankDebt } from '../app/queries.ts';
import { FgButton, FgField, FgInput, FgMoney, FgMoneyInput, FgSelect, FgText, FgTextarea } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgModal, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
import { problemText } from '../components/attachments.tsx';
import { OwnerAttachmentSection, LinkPickerModal } from './debt.tsx';
import { STATUS_REGISTRY, type StatusKey } from '@fingate/shared';

const BANK_STATUS_LABEL: Record<string, string> = { active: 'Đang vay', overdue: 'Quá hạn', settled: 'Đã tất toán', archived: 'Lưu trữ' };

function docStatus(s: string): string {
  return STATUS_REGISTRY[s as StatusKey]?.labelVi ?? s;
}

/* ============================== LOAN-01 list ============================== */

export function BankDebtListScreen(): ReactNode {
  const query = useBankDebts();
  return (
    <>
      <FgPageHeader
        title="Nợ ngân hàng"
        meta="Khoản vay — dư nợ tự trừ khi phiếu chi trả nợ được thực thi"
        actions={
          <Link to="/ngan-hang/khoan-vay/moi">
            <FgButton variant="primary">+ Tạo phiếu nợ</FgButton>
          </Link>
        }
      />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={5} cols={7} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState glyph="◇" title="Chưa có khoản nợ ngân hàng nào" />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable
                rowKey="_id"
                dataSource={data.items}
                columns={[
                  { title: 'Mã', dataIndex: 'code', key: 'code', render: (v, r) => <Link className="fg-link" to={`/ngan-hang/khoan-vay/${r._id}`}>{v}</Link> },
                  { title: 'Ngân hàng', dataIndex: 'bank_name', key: 'bn', render: (v: string, r) => (r.branch ? `${v} — ${r.branch}` : v) },
                  { title: 'Công ty', dataIndex: 'company_name', key: 'co' },
                  { title: 'Số tiền vay', dataIndex: 'principal', key: 'principal', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                  { title: 'Dư nợ', dataIndex: 'outstanding', key: 'os', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" emphasis /> },
                  { title: 'Lãi suất', dataIndex: 'interest_rate', key: 'ir', render: (v: string) => `${v} %/năm` },
                  { title: 'Hạn trả', dataIndex: 'maturity_date', key: 'md' },
                  { title: 'Trạng thái', dataIndex: 'status', key: 'st', render: (v: string) => BANK_STATUS_LABEL[v] ?? v },
                ]}
              />
            </div>
          )
        }
      </FgQuery>
    </>
  );
}

/* ============================== LOAN-03 create ============================== */

export function BankDebtFormScreen(): ReactNode {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const company = useCurrentCompanyId();
  const existing = useBankDebt(id);
  const create = useCreateBankDebt();
  const update = useUpdateBankDebt(id ?? '');
  const { message } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [prefilled, setPrefilled] = useState(false);
  const [f, setF] = useState<{
    bank_name: string;
    branch: string;
    amount: Money | null;
    interest_rate: string;
    maturity_date: string;
    term_months: string;
    payment_frequency: string;
    repayment_method: string;
    note: string;
  }>({
    bank_name: '',
    branch: '',
    amount: null,
    interest_rate: '0',
    maturity_date: dayjs().add(30, 'day').format('YYYY-MM-DD'),
    term_months: '12',
    payment_frequency: 'maturity',
    repayment_method: 'interest_only',
    note: '',
  });

  const editMode = !!id;

  useEffect(() => {
    const d = existing.data;
    if (!d || prefilled) return;
    setF({
      bank_name: d.bank_name,
      branch: d.branch ?? '',
      amount: moneyFromWire(d.principal),
      interest_rate: d.interest_rate,
      maturity_date: d.maturity_date,
      term_months: d.term_months != null ? String(d.term_months) : '',
      payment_frequency: d.payment_frequency,
      repayment_method: d.repayment_method,
      note: d.note ?? '',
    });
    setPrefilled(true);
  }, [existing.data, prefilled]);

  const submit = async (): Promise<void> => {
    setErrors({});
    if (!editMode && !company) {
      message.error('Chưa chọn công ty');
      return;
    }
    if (f.bank_name.trim().length < 2) {
      message.error('Nhập tên ngân hàng');
      return;
    }
    if (!f.amount || f.amount.minor <= 0n) {
      message.error('Nhập số tiền vay');
      return;
    }
    const body: Record<string, unknown> = {
      bank_name: f.bank_name.trim(),
      branch: f.branch.trim() || undefined,
      amount: { amount_minor: f.amount.minor.toString(), currency: f.amount.currency },
      interest_rate: f.interest_rate.trim() || '0',
      maturity_date: f.maturity_date,
      term_months: f.term_months ? Number(f.term_months) : undefined,
      payment_frequency: f.payment_frequency,
      repayment_method: f.repayment_method,
      note: f.note.trim() || undefined,
    };
    try {
      if (editMode) {
        await update.mutateAsync(body);
        message.success('Đã cập nhật phiếu nợ ngân hàng');
        navigate(`/ngan-hang/khoan-vay/${id}`);
        return;
      }
      const r = await create.mutateAsync({ company_id: company, ...body });
      message.success('Đã lưu phiếu nợ ngân hàng');
      navigate(`/ngan-hang/khoan-vay/${r._id}`);
    } catch (e) {
      if (e instanceof ApiRequestError && e.problem.errors) setErrors(e.problem.errors);
      message.error(problemText(e, 'Không lưu được phiếu nợ'));
    }
  };

  const busy = create.isPending || update.isPending;

  return (
    <>
      <FgPageHeader
        title={editMode ? `Sửa phiếu nợ ngân hàng ${existing.data?.code ?? ''}` : 'Tạo phiếu nợ ngân hàng'}
        meta="Khoản vay — dư nợ tự trừ khi phiếu chi trả nợ được thực thi"
      />
      <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'minmax(0,2fr) minmax(240px,1fr)' }}>
        <FgCard>
          <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
            <FgField label="Tên ngân hàng *" error={errors['bank_name']}>
              <FgInput value={f.bank_name} onChange={(e) => setF((s) => ({ ...s, bank_name: e.target.value }))} placeholder="VD: BIDV" />
            </FgField>
            <FgField label="Chi nhánh ngân hàng">
              <FgInput value={f.branch} onChange={(e) => setF((s) => ({ ...s, branch: e.target.value }))} placeholder="VD: Chi nhánh TP.HCM" />
            </FgField>
            <FgField label="Số tiền vay *" error={errors['amount']} help={f.amount ? formatMoney(f.amount, { mode: 'full' }) : 'Gõ "2,5 tỷ" hoặc "850 tr"'}>
              <FgMoneyInput value={f.amount} onChange={(v) => setF((s) => ({ ...s, amount: v }))} />
            </FgField>
            <FgField label="Lãi suất vay (%/năm)" error={errors['interest_rate']}>
              <FgInput value={f.interest_rate} onChange={(e) => setF((s) => ({ ...s, interest_rate: e.target.value }))} placeholder="VD: 9,5" />
            </FgField>
            <FgField label="Hạn thanh toán *" error={errors['maturity_date']}>
              <DatePicker value={f.maturity_date ? dayjs(f.maturity_date) : null} onChange={(d) => setF((s) => ({ ...s, maturity_date: d ? d.format('YYYY-MM-DD') : '' }))} format="DD/MM/YYYY" style={{ width: '100%' }} />
            </FgField>
            <FgField label="Kỳ hạn (tháng)">
              <FgInput value={f.term_months} onChange={(e) => setF((s) => ({ ...s, term_months: e.target.value.replace(/\D/g, '') }))} placeholder="VD: 12" />
            </FgField>
            <FgField label="Kỳ trả lãi/gốc">
              <FgSelect
                options={[
                  { value: 'maturity', label: 'Một lần khi đáo hạn' },
                  { value: 'monthly', label: 'Hàng tháng' },
                  { value: 'quarterly', label: 'Hàng quý' },
                  { value: 'semiannual', label: 'Nửa năm' },
                ]}
                value={f.payment_frequency}
                onChange={(v) => setF((s) => ({ ...s, payment_frequency: v ?? 'maturity' }))}
                style={{ width: '100%' }}
              />
            </FgField>
            <FgField label="Cách trả gốc">
              <FgSelect
                options={[
                  { value: 'interest_only', label: 'Trả lãi định kỳ, gốc cuối kỳ' },
                  { value: 'equal_principal', label: 'Chia đều gốc mỗi kỳ' },
                ]}
                value={f.repayment_method}
                onChange={(v) => setF((s) => ({ ...s, repayment_method: v ?? 'interest_only' }))}
                style={{ width: '100%' }}
              />
            </FgField>
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Ghi chú">
                <FgTextarea value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} />
              </FgField>
            </div>
          </div>
        </FgCard>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}>
          <FgCard title="Tóm tắt">
            <FgText style="bodyS" color="muted">
              {editMode && existing.data ? `Phiếu ${existing.data.code} · ${BANK_STATUS_LABEL[existing.data.status] ?? existing.data.status}` : 'Phiếu mới — chưa lưu'}
            </FgText>
            {f.amount ? (
              <div className="fg-stat-row" style={{ marginTop: 8 }}>
                <span className="fg-stat-label">Số tiền vay</span>
                <span>{formatMoney(f.amount, { mode: 'full' })}</span>
              </div>
            ) : null}
          </FgCard>
          <FgCard title={editMode ? 'Cập nhật' : 'Lưu'}>
            <FgButton variant="primary" block loading={busy} onClick={() => void submit()}>
              {editMode ? 'Lưu thay đổi' : 'Lưu phiếu nợ'}
            </FgButton>
            <div style={{ marginTop: 8 }}>
              <FgButton block onClick={() => navigate(-1)}>Hủy</FgButton>
            </div>
            <FgText style="caption" color="muted">Sau khi lưu, mở chi tiết để đính kèm hợp đồng (PDF/ảnh ≤100MB) và gán phiếu chi trả nợ.</FgText>
          </FgCard>
        </div>
      </div>
    </>
  );
}

/* ============================== LOAN-02 detail ============================== */

export function BankDebtDetailScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useBankDebt(id);
  const repay = useRepayBankDebt(id ?? '');
  const unrepay = useUnrepayBankDebt(id ?? '');
  const del = useDeleteBankDebt();
  const { message } = useToast();
  const [linkOpen, setLinkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={3} />}>
      {(d) => (
        <>
          <FgPageHeader
            title={`${d.code} · ${d.bank_name}${d.branch ? ` — ${d.branch}` : ''}`}
            meta={`Hạn thanh toán ${d.maturity_date} · lãi suất ${d.interest_rate}%/năm`}
            actions={
              <div style={{ display: 'flex', gap: 8 }}>
                <Link to={`/ngan-hang/khoan-vay/${d._id}/lich-tra`}>
                  <FgButton>Lịch trả nợ</FgButton>
                </Link>
                <FgButton variant="primary" onClick={() => setLinkOpen(true)}>
                  + Gán phiếu chi trả nợ
                </FgButton>
                {can('loan:write') ? <FgButton onClick={() => navigate(`/ngan-hang/khoan-vay/${d._id}/sua`)}>Sửa</FgButton> : null}
                {can('loan:write') ? (
                  <FgButton variant="danger" onClick={() => setDeleteOpen(true)}>
                    Xoá
                  </FgButton>
                ) : null}
              </div>
            }
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Số tiền vay</FgText>
              <div className="fg-kpi-value"><FgMoney value={moneyFromWire(d.principal)} mode="compact" /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Đã trả</FgText>
              <div className="fg-kpi-value"><FgMoney value={moneyFromWire(d.repaid)} mode="compact" /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Dư nợ</FgText>
              <div className="fg-kpi-value"><FgMoney value={moneyFromWire(d.outstanding)} mode="compact" emphasis /></div>
            </FgCard>
          </div>

          <FgCard title="Phiếu chi trả nợ" style={{ marginBottom: 'var(--fg-space-4)' }}>
            {!d.repayment_links.length ? (
              <FgEmptyState glyph="◇" title="Chưa gán phiếu chi nào" description="Khi phiếu chi được thực thi, dư nợ tự trừ." />
            ) : (
              <FgTable
                rowKey="_id"
                dataSource={d.repayment_links}
                columns={[
                  { title: 'Phiếu chi', key: 'doc', render: (_v, r) => `${r.document_code} · ${r.document_title}` },
                  { title: 'Trạng thái', dataIndex: 'document_status', key: 'st', render: (v: string) => docStatus(v) },
                  { title: 'Số tiền', dataIndex: 'amount', key: 'amount', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                  {
                    title: '',
                    key: 'act',
                    render: (_v, r) => (
                      <FgButton size="small" variant="danger" onClick={() => unrepay.mutate(r._id, { onSuccess: () => message.success('Đã gỡ') })}>
                        Gỡ
                      </FgButton>
                    ),
                  },
                ]}
              />
            )}
          </FgCard>

          <OwnerAttachmentSection base="/bank-debts" ownerId={d._id} attachments={d.attachments} onChanged={() => query.refetch()} />

          {linkOpen && id ? (
            <LinkPickerModal
              title="Gán phiếu chi trả nợ"
              kind="bank"
              ownerId={id}
              onClose={() => setLinkOpen(false)}
              onPick={(document_id, amount_minor) =>
                repay.mutate(
                  { document_id, amount_minor },
                  {
                    onSuccess: () => {
                      message.success('Đã gán phiếu chi');
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
              title="Xoá khoản nợ ngân hàng"
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
                          message.success('Đã xoá khoản nợ ngân hàng');
                          navigate('/ngan-hang/khoan-vay');
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
                Xoá khoản nợ <strong>{d.code} · {d.bank_name}</strong>? Thao tác này cũng gỡ mọi phiếu chi trả nợ đã gán và chứng từ đính kèm.
              </FgText>
            </FgModal>
          ) : null}
        </>
      )}
    </FgQuery>
  );
}

/* ============================== LOAN-04 · lịch trả nợ ============================== */

const SCHEDULE_STATUS_LABEL: Record<string, string> = { upcoming: 'Sắp tới', due: 'Hôm nay', overdue: 'Quá hạn' };

export function LoanScheduleScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const query = useLoanSchedule(id);
  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={5} />}>
      {(d) => (
        <>
          <FgPageHeader
            title={`Lịch trả nợ · ${d.contract_code} — ${d.bank_name}`}
            meta={`Kỳ hạn ${d.term_months} tháng · lãi suất ${d.interest_rate}%/năm · ${
              d.payment_frequency === 'monthly'
                ? 'trả hàng tháng'
                : d.payment_frequency === 'quarterly'
                  ? 'trả hàng quý'
                  : d.payment_frequency === 'semiannual'
                    ? 'trả nửa năm'
                    : 'trả khi đáo hạn'
            } · ${d.repayment_method === 'equal_principal' ? 'gốc chia đều' : 'gốc cuối kỳ'}`}
            actions={
              <Link to={`/ngan-hang/khoan-vay/${d.loan_id}`}>
                <FgButton>← Chi tiết khoản vay</FgButton>
              </Link>
            }
          />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Tổng gốc</FgText>
              <div className="fg-kpi-value"><FgMoney value={moneyFromWire(d.totals.principal)} mode="compact" /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Tổng lãi</FgText>
              <div className="fg-kpi-value"><FgMoney value={moneyFromWire(d.totals.interest)} mode="compact" /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Tổng phải trả</FgText>
              <div className="fg-kpi-value"><FgMoney value={moneyFromWire(d.totals.total)} mode="compact" emphasis /></div>
            </FgCard>
          </div>
          <div className="fg-card" style={{ padding: 0 }}>
            <FgTable
              rowKey="period"
              dataSource={d.rows}
              columns={[
                { title: 'Kỳ', dataIndex: 'period', key: 'p' },
                { title: 'Ngày đến hạn', dataIndex: 'due_date', key: 'd' },
                { title: 'Số ngày', dataIndex: 'days', key: 'days', align: 'right' },
                { title: 'Gốc', dataIndex: 'principal', key: 'pr', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                { title: 'Lãi', dataIndex: 'interest', key: 'in', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                { title: 'Phí', dataIndex: 'fee', key: 'fe', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" /> },
                { title: 'Cộng', dataIndex: 'total', key: 'to', align: 'right', render: (v) => <FgMoney value={moneyFromWire(v)} mode="compact" emphasis /> },
                { title: 'Trạng thái', dataIndex: 'status', key: 'st', render: (v: string) => SCHEDULE_STATUS_LABEL[v] ?? v },
              ]}
            />
          </div>
        </>
      )}
    </FgQuery>
  );
}

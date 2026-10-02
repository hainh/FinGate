/**
 * Nợ Ngân hàng — phiếu nợ gồm ngân hàng, chi nhánh, số tiền vay, lãi suất, hạn thanh toán,
 * hợp đồng đính kèm (PDF/ảnh ≤100MB) và gán phiếu chi để đánh dấu đã trả nợ.
 */

import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { moneyFromWire, type Money } from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useCurrentCompanyId } from '../app/store.tsx';
import { useBankDebt, useBankDebts, useCreateBankDebt, useRepayBankDebt, useUnrepayBankDebt } from '../app/queries.ts';
import { FgButton, FgField, FgInput, FgMoney, FgMoneyInput, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
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
  const navigate = useNavigate();
  const company = useCurrentCompanyId();
  const create = useCreateBankDebt();
  const { message } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [f, setF] = useState<{ bank_name: string; branch: string; amount: Money | null; interest_rate: string; maturity_date: string; note: string }>({
    bank_name: '',
    branch: '',
    amount: null,
    interest_rate: '0',
    maturity_date: dayjs().add(30, 'day').format('YYYY-MM-DD'),
    note: '',
  });

  const submit = async (): Promise<void> => {
    setErrors({});
    if (!company) {
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
    try {
      const r = await create.mutateAsync({
        company_id: company,
        bank_name: f.bank_name.trim(),
        branch: f.branch.trim() || undefined,
        amount: { amount_minor: f.amount.minor.toString(), currency: f.amount.currency },
        interest_rate: f.interest_rate.trim() || '0',
        maturity_date: f.maturity_date,
        note: f.note.trim() || undefined,
      });
      message.success('Đã lưu phiếu nợ ngân hàng');
      navigate(`/ngan-hang/khoan-vay/${r._id}`);
    } catch (e) {
      if (e instanceof ApiRequestError && e.problem.errors) setErrors(e.problem.errors);
      message.error(problemText(e, 'Không lưu được phiếu nợ'));
    }
  };

  return (
    <>
      <FgPageHeader title="Tạo phiếu nợ ngân hàng" />
      <FgCard>
        <FgField label="Tên ngân hàng *" error={errors['bank_name']}>
          <FgInput value={f.bank_name} onChange={(e) => setF((s) => ({ ...s, bank_name: e.target.value }))} placeholder="VD: BIDV" />
        </FgField>
        <FgField label="Chi nhánh ngân hàng">
          <FgInput value={f.branch} onChange={(e) => setF((s) => ({ ...s, branch: e.target.value }))} placeholder="VD: Chi nhánh TP.HCM" />
        </FgField>
        <FgField label="Số tiền vay *" error={errors['amount']}>
          <FgMoneyInput value={f.amount} onChange={(v) => setF((s) => ({ ...s, amount: v }))} />
        </FgField>
        <FgField label="Lãi suất vay (%/năm)" error={errors['interest_rate']}>
          <FgInput value={f.interest_rate} onChange={(e) => setF((s) => ({ ...s, interest_rate: e.target.value }))} placeholder="VD: 9,5" />
        </FgField>
        <FgField label="Hạn thanh toán *" error={errors['maturity_date']}>
          <DatePicker value={f.maturity_date ? dayjs(f.maturity_date) : null} onChange={(d) => setF((s) => ({ ...s, maturity_date: d ? d.format('YYYY-MM-DD') : '' }))} format="DD/MM/YYYY" style={{ width: '100%' }} />
        </FgField>
        <FgField label="Ghi chú">
          <FgInput value={f.note} onChange={(e) => setF((s) => ({ ...s, note: e.target.value }))} />
        </FgField>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <FgButton variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Lưu phiếu nợ
          </FgButton>
          <FgButton onClick={() => navigate(-1)}>Hủy</FgButton>
        </div>
        <FgText style="caption" color="muted">Sau khi lưu, mở chi tiết để đính kèm hợp đồng (PDF/ảnh ≤100MB) và gán phiếu chi trả nợ.</FgText>
      </FgCard>
    </>
  );
}

/* ============================== LOAN-02 detail ============================== */

export function BankDebtDetailScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const query = useBankDebt(id);
  const repay = useRepayBankDebt(id ?? '');
  const unrepay = useUnrepayBankDebt(id ?? '');
  const { message } = useToast();
  const [linkOpen, setLinkOpen] = useState(false);

  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={3} />}>
      {(d) => (
        <>
          <FgPageHeader
            title={`${d.code} · ${d.bank_name}${d.branch ? ` — ${d.branch}` : ''}`}
            meta={`Hạn thanh toán ${d.maturity_date} · lãi suất ${d.interest_rate}%/năm`}
            actions={
              <FgButton variant="primary" onClick={() => setLinkOpen(true)}>
                + Gán phiếu chi trả nợ
              </FgButton>
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
        </>
      )}
    </FgQuery>
  );
}

/**
 * Khung "Hồ sơ form (create/edit)" — CHI-02 · THU-02 · RENEW-02 · NOI-BO.
 *
 * Tiền nhập bằng parseMoneyInput (hỗ trợ "2,5 tỷ"); validate theo zod contract phía
 * server — lỗi field hiển thị inline từ `problem.errors`.
 */

import { useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { DOC_KIND_LABEL, formatMoney, moneyFromWire, statusLabel, type Money } from '@fingate/shared';
import { ApiRequestError, apiData } from '../app/api.ts';
import { useAuth } from '../app/store.tsx';
import { useBankAccounts, useDocument } from '../app/queries.ts';
import { FgAlert, FgButton, FgField, FgInput, FgMoneyInput, FgSelect, FgTextarea, FgText } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { useToast } from '../components/pagekit.tsx';

interface FormState {
  title: string;
  purpose: string;
  payee_name: string;
  payee_bank: string;
  amount: Money | null;
  planned_date: string;
  fund: 'bank' | 'cash';
  account_id: string;
  contract_code: string;
  priority: string;
  note: string;
  /* rollover */
  plan: string;
  new_rate: string;
  collateral: string;
}

const initial = (): FormState => ({
  title: '',
  purpose: '',
  payee_name: '',
  payee_bank: '',
  amount: null,
  planned_date: new Date().toISOString().slice(0, 10),
  fund: 'bank',
  account_id: '',
  contract_code: '',
  priority: 'normal',
  note: '',
  plan: '',
  new_rate: '',
  collateral: '',
});

export function DocumentFormScreen({ kind }: { kind: 'spend' | 'income' | 'rollover' | 'internal' }): ReactNode {
  const { id } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const { me } = useAuth();
  const { message } = useToast();
  const existing = useDocument(id);
  const accounts = useBankAccounts();
  const [f, setF] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [submitAsDraft, setSubmitAsDraft] = useState(true);

  const set = (k: keyof FormState, v: string | Money | null) => setF((s) => ({ ...s, [k]: v }));

  // Nguồn tiền: chỉ tài khoản công ty mình hoặc Tập đoàn, đúng loại tiền mặt/ngân hàng.
  const accountOptions = (accounts.data?.items ?? [])
    .filter((a) => a.status === 'active' && a.kind === f.fund)
    .map((a) => ({
      value: a._id,
      label: `${a.is_group ? 'Tập đoàn' : (a.company_name ?? '—')} · ${a.bank_name} ${a.account_number_masked}`,
    }));


  const buildBody = () => {
    const company = me?.scope.active_company_id ?? me?.assignments[0]?.company_id;
    const body: Record<string, unknown> = {
      kind,
      company_id: company,
      title: f.title || defaultTitle(kind, f.payee_name, f.amount),
      purpose: f.purpose,
      payee:
        kind === 'rollover'
          ? { name: f.payee_name || 'Ngân hàng', is_internal: false }
          : { name: f.payee_name, is_internal: false, bank_name: f.payee_bank || undefined },
      amount: f.amount ? { amount_minor: f.amount.minor.toString(), currency: f.amount.currency } : undefined,
      source: { fund: f.fund, account_id: f.account_id || null, group_managed: false },
      planned_date: f.planned_date,
      priority: f.priority,
      contract: { code: f.contract_code || undefined },
      note: f.note || undefined,
    };
    if (kind === 'rollover') {
      body.rollover = {
        need_amount: f.amount ? { amount_minor: f.amount.minor.toString(), currency: f.amount.currency } : undefined,
        plan: f.plan,
        new_rate: f.new_rate || undefined,
        collateral: f.collateral || undefined,
      };
    }
    return body;
  };

  const save = async () => {
    setBusy(true);
    setErrors({});
    try {
      const body = buildBody();
      if (id && existing.data) {
        await apiData(`/documents/${id}`, { method: 'PATCH', body: { ...body, if_match: existing.data.version } });
        message.success('Đã lưu bản nháp');
        navigate(`/ho-so/${pathKind(kind)}/${id}`);
      } else {
        const created = await apiData<{ _id: string; version: number }>('/documents', { method: 'POST', body });
        message.success(submitAsDraft ? `Đã tạo nháp ${created._id ? '' : ''}` : 'Đã gửi duyệt');
        if (!submitAsDraft) {
          await apiData(`/documents/${created._id}/transition`, {
            method: 'POST',
            body: { action: 'submit', if_match: created.version },
          });
        }
        navigate(`/ho-so/${pathKind(kind)}/${created._id}`);
      }
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setErrors(e.problem.errors ?? {});
        message.error(e.problem.title + (e.problem.detail ? ` — ${e.problem.detail}` : ''));
      } else message.error('Không lưu được');
    } finally {
      setBusy(false);
    }
  };

  // prefill khi sửa
  const loaded = id ? existing.data : null;
  if (loaded && !f.payee_name && loaded.payee?.name) {
    setF({
      ...f,
      title: loaded.title,
      purpose: loaded.purpose,
      payee_name: loaded.payee.name,
      amount: moneyFromWire(loaded.amount),
      planned_date: loaded.planned_date,
      fund: loaded.source.fund,
      account_id: loaded.source.account_id ?? '',
      contract_code: loaded.contract.code ?? '',
      note: loaded.note ?? '',
      plan: loaded.rollover?.plan ?? '',
    });
  }

  const canEdit = !id || loaded ? (loaded?.can.edit ?? true) : true;

  return (
    <>
      <FgPageHeader title={`${id ? 'Sửa' : 'Tạo mới'} ${DOC_KIND_LABEL[kind].toLowerCase()}`} meta="Nháp tự lưu trên máy — gửi duyệt khi đủ chứng từ" />
      {!canEdit ? (
        <FgAlert tone="warning" title="Hồ sơ đã qua cấp duyệt, không sửa được nữa" description="Chỉ người tạo có thể sửa khi còn Nháp / Yêu cầu bổ sung." style={{ marginBottom: 16 }} />
      ) : null}
      <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'minmax(0,2fr) minmax(240px,1fr)' }}>
        <FgCard>
          <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Nội dung / mục đích *" error={errors.purpose ?? (f.purpose && f.purpose.length < 3 ? 'Tối thiểu 3 ký tự' : null)}>
                <FgTextarea value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="VD: Thanh toán đợt 2 hợp đồng 45/2026 theo biên bản nghiệm thu" disabled={!canEdit} />
              </FgField>
            </div>
            <FgField label={`Tiêu đề (bỏ trống sẽ tự sinh)`} error={errors.title}>
              <FgInput value={f.title} onChange={(e) => set('title', e.target.value)} disabled={!canEdit} />
            </FgField>
            <FgField label={kind === 'income' ? 'Khách hàng trả tiền *' : 'Đơn vị nhận tiền *'} error={errors['payee.name']}>
              <FgInput value={f.payee_name} onChange={(e) => set('payee_name', e.target.value)} placeholder="Công ty TNHH …" disabled={!canEdit} />
            </FgField>
            <FgField label="Số tiền *" error={errors.amount ?? (f.amount === null ? 'Chưa nhập' : null)} help={f.amount ? formatMoney(f.amount, { mode: 'full' }) : 'Gõ "2,5 tỷ" hoặc "850 tr" — hệ thống hiểu cả hai'}>
              <FgMoneyInput value={f.amount} onChange={(m) => set('amount', m)} disabled={!canEdit} />
            </FgField>
            <FgField label="Ngày dự kiến *" error={errors.planned_date}>
              <FgInput type="date" value={f.planned_date} onChange={(e) => set('planned_date', e.target.value)} disabled={!canEdit} />
            </FgField>
            <FgField label="Nguồn tiền *">
              <FgSelect
                options={[
                  { value: 'bank', label: 'Tài khoản ngân hàng' },
                  { value: 'cash', label: 'Quỹ tiền mặt' },
                ]}
                value={f.fund}
                onChange={(v) => {
                  set('fund', v ?? 'bank');
                  set('account_id', '');
                }}
                style={{ width: '100%' }}
                disabled={!canEdit}
              />
            </FgField>
            <FgField
              label="Tài khoản nguồn *"
              error={errors['source.account_id'] ?? null}
              help="Chỉ tài khoản của công ty bạn và tài khoản Tập đoàn"
            >
              <FgSelect
                options={accountOptions}
                value={f.account_id}
                onChange={(v) => set('account_id', v ?? '')}
                placeholder={f.fund === 'cash' ? 'Chọn quỹ tiền mặt' : 'Chọn tài khoản ngân hàng'}
                allowClear
                style={{ width: '100%' }}
                disabled={!canEdit}
              />
            </FgField>
            <FgField label="Hợp đồng / căn cứ" error={errors['contract.code']}>
              <FgInput value={f.contract_code} onChange={(e) => set('contract_code', e.target.value)} placeholder="HĐ 45/2026" disabled={!canEdit} />
            </FgField>
            <FgField label="Độ khẩn">
              <FgSelect
                options={[
                  { value: 'normal', label: 'Thường' },
                  { value: 'high', label: 'Cao' },
                  { value: 'urgent', label: 'Khẩn' },
                ]}
                value={f.priority}
                onChange={(v) => set('priority', v ?? 'normal')}
                style={{ width: '100%' }}
                disabled={!canEdit}
              />
            </FgField>
            {kind === 'rollover' ? (
              <>
                <div style={{ gridColumn: '1/-1' }}>
                  <FgField label="Phương án đảo hạn *" error={errors['rollover.plan']}>
                    <FgTextarea value={f.plan} onChange={(e) => set('plan', e.target.value)} placeholder="VD: Gia hạn 12 tháng tại BIDV, tài sản đảm bảo giữ nguyên, phí 0,3%" disabled={!canEdit} />
                  </FgField>
                </div>
                <FgField label="Lãi suất mới (%/năm)">
                  <FgInput value={f.new_rate} onChange={(e) => set('new_rate', e.target.value)} placeholder="9,50" disabled={!canEdit} />
                </FgField>
                <FgField label="Tài sản đảm bảo">
                  <FgInput value={f.collateral} onChange={(e) => set('collateral', e.target.value)} disabled={!canEdit} />
                </FgField>
              </>
            ) : null}
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Ghi chú">
                <FgTextarea value={f.note} onChange={(e) => set('note', e.target.value)} disabled={!canEdit} />
              </FgField>
            </div>
          </div>
        </FgCard>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}>
          <FgCard title="Trạng thái">
            <FgText style="bodyS" color="muted">
              {id && loaded ? `Hồ sơ ${loaded.code} · ${statusLabel(loaded.status)}` : 'Phiếu mới — chưa gửi duyệt'}
            </FgText>
            {f.amount ? (
              <div className="fg-stat-row" style={{ marginTop: 8 }}>
                <span className="fg-stat-label">Số tiền</span>
                <span>{formatMoney(f.amount, { mode: 'full' })}</span>
              </div>
            ) : null}
          </FgCard>
          <FgCard title="Nộp">
            {!id ? (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, fontSize: 13 }}>
                <input type="checkbox" checked={!submitAsDraft} onChange={(e) => setSubmitAsDraft(!e.target.checked)} style={{ width: 18, height: 18 }} />
                Gửi duyệt ngay sau khi tạo
              </label>
            ) : null}
            <FgButton variant="primary" block loading={busy} disabled={!canEdit} onClick={() => void save()}>
              {id ? 'Lưu thay đổi' : submitAsDraft ? 'Lưu nháp' : 'Tạo & gửi duyệt'}
            </FgButton>
            <div style={{ marginTop: 8 }}>
              <FgButton block onClick={() => navigate(-1)}>
                Hủy
              </FgButton>
            </div>
            <FgText style="caption" color="muted">
              Cần đủ chứng từ bắt buộc trước khi gửi (FG-WF-003).
            </FgText>
          </FgCard>
        </div>
      </div>
    </>
  );
}

function pathKind(kind: string): string {
  return { spend: 'chi', income: 'thu', rollover: 'dao-han', internal: 'noi-bo' }[kind] ?? 'chi';
}

function defaultTitle(kind: string, payee: string, amount: Money | null): string {
  const a = amount ? formatMoney(amount, { mode: 'compact' }) : '';
  const label = { spend: 'Chi', income: 'Thu', rollover: 'Đảo hạn', internal: 'Chuyển nội bộ' }[kind] ?? 'Hồ sơ';
  return `${label} ${payee || '…'} ${a}`.trim();
}

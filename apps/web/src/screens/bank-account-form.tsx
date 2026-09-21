/**
 * BANK-02 — tạo / sửa tài khoản tiền (tiền mặt / ngân hàng).
 *
 * Phân quyền (§VIII): Chủ tịch HĐQT tạo/sửa tài khoản Tập đoàn và tài khoản cho
 * mọi công ty con; Giám đốc chỉ tài khoản cho công ty của mình. Server kiểm tra lại
 * toàn bộ — UI ẩn lựa chọn chỉ là mỹ thuật. Công ty / cờ Tập đoàn KHÔNG đổi được khi sửa.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CURRENCY_CODES, money, moneyToWire, type Money } from '@fingate/shared';
import { ApiRequestError, apiCall } from '../app/api.ts';
import { useAuth, useCurrentCompanyId } from '../app/store.tsx';
import { useBankAccount, useCompanies } from '../app/queries.ts';
import { FgAlert, FgButton, FgField, FgInput, FgMoneyInput, FgSelect, FgTextarea } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgSkeletonTable } from '../components/uitk.tsx';
import { useToast } from '../components/pagekit.tsx';

const GROUP = 'group';

export function BankAccountFormScreen(): ReactNode {
  const { id } = useParams<{ id?: string }>();
  const isEdit = !!id;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = useToast();
  const { me, can } = useAuth();
  const companies = useCompanies();
  const existing = useBankAccount(id);
  const loaded = existing.data;

  const canGroup = can('admin:group_accounts');
  // Công ty đích = phạm vi đang chọn (xem useCurrentCompanyId).
  const ownCompany = useCurrentCompanyId() ?? me?.assignments[0]?.company_id ?? '';

  const [target, setTarget] = useState<string>(canGroup ? GROUP : ownCompany);
  const [kind, setKind] = useState<'bank' | 'cash'>('bank');
  const [bankName, setBankName] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [branch, setBranch] = useState('');
  const [currency, setCurrency] = useState('VND');
  const [minBalance, setMinBalance] = useState<Money | null>(null);
  const [showOnDashboard, setShowOnDashboard] = useState(true);
  const [status, setStatus] = useState('active');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(!isEdit);

  // prefill khi sửa (chờ tải xong mới render form — tránh nháy giá trị rỗng)
  useEffect(() => {
    if (!loaded) return;
    setTarget(loaded.is_group ? GROUP : (loaded.company_id ?? ownCompany));
    setKind(loaded.kind === 'cash' ? 'cash' : 'bank');
    setBankName(loaded.bank_name);
    setAccountName(loaded.account_name);
    setAccountNumber(loaded.account_number);
    setBranch(loaded.branch ?? '');
    setCurrency(loaded.currency);
    setMinBalance(money(BigInt(loaded.min_balance_minor || '0'), loaded.currency));
    setShowOnDashboard(loaded.show_on_dashboard);
    setStatus(loaded.status);
    setNote(loaded.note ?? '');
    setReady(true);
  }, [loaded, ownCompany]);

  const isGroup = target === GROUP;
  const scopeOptions = canGroup
    ? [{ value: GROUP, label: 'Tập đoàn (toàn hệ thống)' }, ...(companies.data?.items ?? []).map((c) => ({ value: c._id, label: `${c.name} (${c.code})` }))]
    : (companies.data?.items ?? [])
        .filter((c) => c._id === ownCompany)
        .map((c) => ({ value: c._id, label: `${c.name} (${c.code})` }));

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const detail = {
        bank_name: bankName.trim(),
        account_name: accountName.trim(),
        account_number: accountNumber.trim(),
        branch: branch.trim() || undefined,
        currency,
        kind,
        min_balance_minor: moneyToWire(minBalance ?? money(0n, currency)).minor,
        show_on_dashboard: showOnDashboard,
        status,
        note: note.trim() || undefined,
      };
      if (isEdit && id) {
        await apiCall(`/bank-accounts/${id}`, { method: 'PATCH', body: detail });
      } else {
        await apiCall('/bank-accounts', {
          method: 'POST',
          body: { ...detail, company_id: isGroup ? undefined : target, is_group: isGroup },
        });
      }
      await qc.invalidateQueries({ queryKey: ['bank-accounts'] });
      await qc.invalidateQueries({ queryKey: ['bank-account'] });
      message.success(isEdit ? 'Đã lưu thay đổi' : 'Đã tạo tài khoản tiền');
      navigate('/ngan-hang/taikhoan');
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setError(e.problem.detail ?? e.problem.title);
        setFieldErrors(e.problem.errors ?? {});
      } else setError(isEdit ? 'Không lưu được tài khoản' : 'Không tạo được tài khoản');
    } finally {
      setBusy(false);
    }
  };

  if (!ready) {
    return (
      <>
        <FgPageHeader title="Sửa tài khoản tiền" meta="Đang tải thông tin tài khoản…" />
        <FgSkeletonTable rows={6} cols={2} />
      </>
    );
  }

  return (
    <>
      <FgPageHeader title={isEdit ? 'Sửa tài khoản tiền' : 'Thêm tài khoản tiền'} meta="Tài khoản Tập đoàn hoặc tài khoản thuộc công ty — dùng làm tài khoản nguồn (phiếu chi) hoặc tài khoản đích (phiếu thu)" />
      <div style={{ maxWidth: 720 }}>
        <FgCard>
          <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Thuộc phạm vi *" help={isEdit ? 'Không đổi được công ty / tài khoản Tập đoàn sau khi tạo.' : canGroup ? 'Tập đoàn: mọi công ty con thấy để chọn nguồn tiền. Công ty: chỉ công ty đó dùng.' : 'Bạn chỉ tạo được tài khoản cho công ty của mình.'}>
                <FgSelect
                  options={scopeOptions}
                  value={target}
                  onChange={(v) => setTarget(v ?? '')}
                  style={{ width: '100%' }}
                  disabled={isEdit || !canGroup}
                />
              </FgField>
            </div>
            <FgField label="Loại tài khoản *">
              <FgSelect
                options={[
                  { value: 'bank', label: 'Ngân hàng' },
                  { value: 'cash', label: 'Tiền mặt (quỹ)' },
                ]}
                value={kind}
                onChange={(v) => setKind(v === 'cash' ? 'cash' : 'bank')}
                style={{ width: '100%' }}
              />
            </FgField>
            <FgField label={kind === 'cash' ? 'Tên quỹ *' : 'Ngân hàng *'} error={fieldErrors.bank_name ?? null}>
              <FgInput value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder={kind === 'cash' ? 'Quỹ tiền mặt' : 'Vietcombank'} />
            </FgField>
            <FgField label="Chủ tài khoản *" error={fieldErrors.account_name ?? null}>
              <FgInput value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Công ty TNHH …" />
            </FgField>
            <FgField label={kind === 'cash' ? 'Mã quỹ *' : 'Số tài khoản *'} error={fieldErrors.account_number ?? null}>
              <FgInput value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder={kind === 'cash' ? 'CASH-…' : '0123456789'} />
            </FgField>
            <FgField label="Chi nhánh" error={fieldErrors.branch ?? null}>
              <FgInput value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Chi nhánh TP.HCM" />
            </FgField>
            <FgField label="Loại tiền">
              <FgSelect
                options={CURRENCY_CODES.map((c) => ({ value: c, label: c }))}
                value={currency}
                onChange={(v) => setCurrency(v ?? 'VND')}
                style={{ width: '100%' }}
              />
            </FgField>
            <FgField label="Ngưỡng tối thiểu" help="Dưới ngưỡng sẽ cảnh báo trên danh sách/số dư">
              <FgMoneyInput value={minBalance} onChange={setMinBalance} ariaLabel="Ngưỡng tối thiểu" />
            </FgField>
            <FgField label="Trạng thái" help={isEdit ? 'Khoá/đóng tài khoản sẽ chặn nếu còn hồ sơ đang tham chiếu.' : undefined}>
              <FgSelect
                options={[
                  { value: 'active', label: 'Đang hoạt động' },
                  { value: 'frozen', label: 'Phong tỏa' },
                  { value: 'closed', label: 'Đã đóng' },
                ]}
                value={status}
                onChange={(v) => setStatus(v ?? 'active')}
                style={{ width: '100%' }}
              />
            </FgField>
            <div style={{ gridColumn: '1/-1' }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input type="checkbox" checked={showOnDashboard} onChange={(e) => setShowOnDashboard(e.target.checked)} style={{ width: 18, height: 18 }} />
                Hiển thị trên dashboard
              </label>
            </div>
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Ghi chú">
                <FgTextarea value={note} onChange={(e) => setNote(e.target.value)} />
              </FgField>
            </div>
            {error ? (
              <div style={{ gridColumn: '1/-1' }}>
                <FgAlert tone="danger" title={error} />
              </div>
            ) : null}
            <div style={{ gridColumn: '1/-1', display: 'flex', gap: 8 }}>
              <FgButton variant="primary" loading={busy} onClick={() => void submit()}>
                {isEdit ? 'Lưu thay đổi' : 'Tạo tài khoản'}
              </FgButton>
              <FgButton onClick={() => navigate(-1)}>Hủy</FgButton>
            </div>
          </div>
        </FgCard>
      </div>
    </>
  );
}

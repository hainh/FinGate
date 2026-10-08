/**
 * Nợ Ngân hàng — phiếu nợ gồm ngân hàng, chi nhánh, số tiền vay, lãi suất, hạn thanh toán,
 * hợp đồng đính kèm (PDF/ảnh ≤100MB) và gán phiếu chi để đánh dấu đã trả nợ.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import { formatMoney, money, moneyFromWire, parseMoneyInput, type Money } from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useAuth, useCurrentCompanyId } from '../app/store.tsx';
import { useBankDebt, useBankDebts, useCreateBankDebt, useDeleteBankDebt, useImportBankDebts, useLoanSchedule, useRepayBankDebt, useUnrepayBankDebt, useUpdateBankDebt } from '../app/queries.ts';
import { FgAlert, FgButton, FgField, FgFreeSelect, FgInput, FgMoneyStack, FgMoneyInput, FgSelect, FgText, FgTextarea } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgModal, FgSkeletonTable, FgTable } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
import { problemText } from '../components/attachments.tsx';
import { OwnerAttachmentSection, LinkPickerModal } from './debt.tsx';
import { STATUS_REGISTRY, type StatusKey } from '@fingate/shared';

const BANK_STATUS_LABEL: Record<string, string> = { active: 'Đang vay', overdue: 'Quá hạn', settled: 'Đã tất toán', archived: 'Lưu trữ' };

/** Bảng mẫu để nhập nợ ngân hàng theo lô (Google Sheets) — người dùng điền rồi tải .tsv. */
const SHEETS_IMPORT_URL = 'https://docs.google.com/spreadsheets/d/1CsgfK4J17nxxWXR2NDOdrM5NzSW3ltI7jKpwYIN-UkM/edit?gid=0#gid=0';

function docStatus(s: string): string {
  return STATUS_REGISTRY[s as StatusKey]?.labelVi ?? s;
}

/* ============================== LOAN-05 · import theo lô (.tsv) ============================== */

interface ImportPreviewRow {
  line: number;
  bank_name: string;
  amount_minor: string;
  credit_limit_minor: string;
  interest_rate: string;
  maturity_date: string;
  term_months: string;
  note: string;
  errors: string[];
}

/** Giải mã .tsv — chấp nhận UTF-8 (BOM) và UTF-16LE/BE (Excel "Unicode Text"). */
function decodeTsvBuffer(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

/** `09/12/2027` (ng/th/năm) hoặc `2027-12-09` → `YYYY-MM-DD`. */
function parseVnDate(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  m = /^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
  return null;
}

function parseImportTsv(text: string): ImportPreviewRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  const rows: ImportPreviewRow[] = [];
  if (!lines.length) return rows;
  const firstCells = lines[0]!.split('\t');
  const header = !/^\d[\d.,\s]*$/.test((firstCells[1] ?? '').trim());
  for (let i = header ? 1 : 0; i < lines.length; i++) {
    const cells = lines[i]!.split('\t');
    const errors: string[] = [];

    const bank_name = (cells[0] ?? '').trim();
    if (bank_name.length < 2) errors.push('Thiếu tên ngân hàng');

    const amountRaw = (cells[1] ?? '').trim();
    const amount = amountRaw ? parseMoneyInput(amountRaw).minor : 0n;
    if (amount <= 0n) errors.push('Số tiền vay không hợp lệ');

    const limitRaw = (cells[2] ?? '').trim();
    const limit = limitRaw ? parseMoneyInput(limitRaw).minor : 0n;

    const interest_rate = (cells[3] ?? '').trim().replace(',', '.') || '0';
    if (!/^\d+(\.\d{1,2})?$/.test(interest_rate)) errors.push('Lãi suất không hợp lệ');

    const maturity_date = parseVnDate((cells[4] ?? '').trim()) ?? '';
    if (!maturity_date) errors.push('Hạn thanh toán không hợp lệ');

    const termRaw = (cells[5] ?? '').trim().replace(/\D/g, '');
    const term = termRaw ? Number(termRaw) : null;
    if (termRaw && (term === null || term < 1 || term > 600)) errors.push('Kỳ hạn phải 1–600 tháng');

    rows.push({
      line: i + 1,
      bank_name,
      amount_minor: amount.toString(),
      credit_limit_minor: limit > 0n ? limit.toString() : '',
      interest_rate,
      maturity_date,
      term_months: term ? String(term) : '',
      note: (cells[6] ?? '').trim(),
      errors,
    });
  }
  return rows;
}

function BankDebtImportModal({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: () => void }): ReactNode {
  const company = useCurrentCompanyId();
  const imp = useImportBankDebts();
  const { message } = useToast();
  const [rows, setRows] = useState<ImportPreviewRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [parseError, setParseError] = useState('');
  const [result, setResult] = useState<{ inserted: number; failed: { row: number; error: string }[] } | null>(null);

  const validRows = rows.filter((r) => !r.errors.length);
  const invalidCount = rows.length - validRows.length;

  const onFile = async (file: File | undefined): Promise<void> => {
    setRows([]);
    setFileName('');
    setParseError('');
    setResult(null);
    if (!file) return;
    setFileName(file.name);
    const parsed = parseImportTsv(decodeTsvBuffer(await file.arrayBuffer()));
    if (!parsed.length) {
      setParseError('File không có dòng dữ liệu nào — dòng 1 là tiêu đề, từ dòng 2 trở đi là dữ liệu.');
      return;
    }
    setRows(parsed);
  };

  const submit = async (): Promise<void> => {
    if (!validRows.length) {
      message.error('Không có dòng hợp lệ để nhập');
      return;
    }
    try {
      const r = await imp.mutateAsync({
        ...(company ? { company_id: company } : {}),
        rows: validRows.map((row) => ({
          bank_name: row.bank_name,
          amount: { amount_minor: row.amount_minor, currency: 'VND' },
          ...(row.credit_limit_minor ? { credit_limit: { amount_minor: row.credit_limit_minor, currency: 'VND' } } : {}),
          interest_rate: row.interest_rate,
          maturity_date: row.maturity_date,
          ...(row.term_months ? { term_months: Number(row.term_months) } : {}),
          ...(row.note ? { note: row.note } : {}),
        })),
      });
      setResult({ inserted: r.inserted, failed: r.failed });
      message.success(`Đã nhập ${r.inserted} khoản nợ`);
      onImported();
    } catch (e) {
      message.error(problemText(e, 'Không nhập được nợ ngân hàng'));
    }
  };

  return (
    <FgModal
      open={open}
      title="Nhập nợ ngân hàng theo lô (.tsv)"
      width={1024}
      onCancel={onClose}
      footer={
        <>
          <FgButton onClick={onClose} disabled={imp.isPending}>
            {result ? 'Đóng' : 'Hủy'}
          </FgButton>
          {!result ? (
            <FgButton variant="primary" loading={imp.isPending} disabled={!validRows.length} onClick={() => void submit()}>
              Nhập{validRows.length ? ` ${validRows.length} dòng` : ''}
            </FgButton>
          ) : null}
        </>
      }
    >
      <FgAlert
        tone="info"
        title="Cách nhập theo lô"
        description={
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li style={{ marginBottom: 4 }}>
              Mở{' '}
              <a href={SHEETS_IMPORT_URL} target="_blank" rel="noopener noreferrer">
                bảng mẫu trên Google Sheets
              </a>
              , điền mỗi dòng một khoản vay theo 7 cột:{' '}
              <strong>Tên NH - Chi nhánh · Số tiền vay · Hạn mức vay · Lãi suất % · Hạn thanh toán (ng/th/năm) · Kỳ hạn (tháng) · Ghi chú</strong>. Dòng 1 là tiêu đề, từ dòng 2 trở đi là dữ liệu. Các field còn lại dùng mặc định (VND, trả khi đáo hạn, gốc cuối kỳ).
            </li>
            <li style={{ marginBottom: 4 }}>
              Trong Google Sheets: <strong>Tệp → Tải xuống → Giá trị được phân tách bằng tab (.tsv)</strong> để lưu file <code>.tsv</code>.
            </li>
            <li>Chọn file vừa tải ở dưới, xem trước rồi bấm <strong>Nhập</strong> — dòng lỗi sẽ bị bỏ qua và báo riêng.</li>
          </ol>
        }
        style={{ marginBottom: 'var(--fg-space-4)' }}
      />
      {!rows.length && !result ? (
        <figure style={{ margin: 0, marginBottom: 'var(--fg-space-4)' }}>
          <a href="/hd-nhap-no.png" target="_blank" rel="noopener noreferrer" title="Bấm để phóng to">
            <img
              src="/hd-nhap-no.png"
              alt="Hướng dẫn cấu trúc file nhập nợ ngân hàng theo lô"
              style={{ width: '100%', maxWidth: 640, display: 'block', border: '1px solid var(--fg-border-subtle)', borderRadius: 'var(--fg-radius-md)' }}
            />
          </a>
          <FgText style="caption" color="muted" as="div">
            Ví dụ cấu trúc file .tsv (bấm ảnh để phóng to).
          </FgText>
        </figure>
      ) : null}
      <FgField label="Chọn file .tsv" help={fileName ? `Đã chọn: ${fileName}` : 'Tải từ Google Sheets: Tệp → Tải xuống → Giá trị được phân tách bằng tab (.tsv)'}>
        <input type="file" accept=".tsv,.txt,text/tab-separated-values,text/plain" onChange={(e) => void onFile(e.target.files?.[0])} />
      </FgField>

      {parseError ? <FgAlert tone="warning" title={parseError} style={{ marginTop: 'var(--fg-space-3)' }} /> : null}

      {result ? (
        <FgAlert
          tone={result.failed.length ? 'warning' : 'success'}
          title={`Đã nhập ${result.inserted} khoản nợ${result.failed.length ? `, ${result.failed.length} dòng lỗi` : ''}`}
          description={result.failed.length ? result.failed.map((f) => `Dòng ${f.row}: ${f.error}`).join(' · ') : undefined}
          style={{ marginTop: 'var(--fg-space-4)' }}
        />
      ) : null}

      {rows.length ? (
        <>
          {invalidCount ? (
            <FgAlert tone="warning" title={`${invalidCount} dòng không hợp lệ sẽ bị bỏ qua`} style={{ marginTop: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-3)' }} />
          ) : null}
          <FgTable<ImportPreviewRow>
            rowKey="line"
            dataSource={rows}
            columns={[
              { title: 'Dòng', dataIndex: 'line', key: 'line', width: 60 },
              { title: 'Ngân hàng', dataIndex: 'bank_name', key: 'bn', render: (v: string) => v || '—' },
              { title: 'Số tiền vay', key: 'amt', align: 'right', render: (_v, r) => (r.amount_minor && r.amount_minor !== '0' ? formatMoney(money(r.amount_minor), { mode: 'full' }) : '—') },
              { title: 'Hạn mức', key: 'cl', align: 'right', render: (_v, r) => (r.credit_limit_minor ? formatMoney(money(r.credit_limit_minor), { mode: 'full' }) : '—') },
              { title: 'Lãi suất', dataIndex: 'interest_rate', key: 'ir', render: (v: string) => `${v} %` },
              { title: 'Hạn TT', dataIndex: 'maturity_date', key: 'md', render: (v: string) => (v ? dayjs(v).format('DD/MM/YYYY') : '—') },
              { title: 'Kỳ hạn', dataIndex: 'term_months', key: 'tm', render: (v: string) => (v ? `${v} tháng` : '—') },
              { title: 'Ghi chú', dataIndex: 'note', key: 'nt', render: (v: string) => v || '—' },
              {
                title: 'Trạng thái',
                key: 'st',
                render: (_v, r) => (r.errors.length ? <FgText style="caption" color="danger">{r.errors.join('; ')}</FgText> : <FgText style="caption" color="success">Hợp lệ</FgText>),
              },
            ]}
          />
        </>
      ) : null}
    </FgModal>
  );
}

/* ============================== LOAN-01 list ============================== */

export function BankDebtListScreen(): ReactNode {
  const query = useBankDebts();
  const { can } = useAuth();
  const [importOpen, setImportOpen] = useState(false);
  return (
    <>
      <FgPageHeader
        title="Nợ ngân hàng"
        meta="Khoản vay — dư nợ tự trừ khi phiếu chi trả nợ được thực thi"
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            {can('loan:write') ? (
              <FgButton onClick={() => setImportOpen(true)}>Nhập theo lô (.tsv)</FgButton>
            ) : null}
            <Link to="/ngan-hang/khoan-vay/moi">
              <FgButton variant="primary">+ Tạo phiếu nợ</FgButton>
            </Link>
          </div>
        }
      />
      {importOpen ? (
        <BankDebtImportModal
          open
          onClose={() => setImportOpen(false)}
          onImported={() => void query.refetch()}
        />
      ) : null}
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={5} cols={8} />}>
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
                  { title: 'Ngân hàng', dataIndex: 'bank_name', key: 'bn' },
                  { title: 'Công ty', dataIndex: 'company_name', key: 'co' },
                  { title: 'Số tiền vay', dataIndex: 'principal', key: 'principal', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                  { title: 'Hạn mức vay', dataIndex: 'credit_limit', key: 'credit_limit', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                  { title: 'Dư nợ', dataIndex: 'outstanding', key: 'os', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} emphasis /> },
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
  const bankDebts = useBankDebts();
  const create = useCreateBankDebt();
  const update = useUpdateBankDebt(id ?? '');
  const { message } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [prefilled, setPrefilled] = useState(false);
  const [f, setF] = useState<{
    bank_name: string;
    amount: Money | null;
    credit_limit: Money | null;
    interest_rate: string;
    maturity_date: string;
    term_months: string;
    payment_frequency: string;
    repayment_method: string;
    note: string;
  }>({
    bank_name: '',
    amount: null,
    credit_limit: null,
    interest_rate: '0',
    maturity_date: dayjs().add(30, 'day').format('YYYY-MM-DD'),
    term_months: '12',
    payment_frequency: 'maturity',
    repayment_method: 'interest_only',
    note: '',
  });

  const editMode = !!id;

  /** Tên ngân hàng đã có trong các phiếu nợ — chọn nhanh hoặc nhập mới. */
  const bankNameOptions = useMemo(() => {
    const names = new Set<string>();
    for (const it of bankDebts.data?.items ?? []) {
      if (it.bank_name) names.add(it.bank_name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'vi')).map((n) => ({ value: n, label: n }));
  }, [bankDebts.data]);

  useEffect(() => {
    const d = existing.data;
    if (!d || prefilled) return;
    setF({
      bank_name: d.bank_name,
      amount: moneyFromWire(d.principal),
      credit_limit: d.credit_limit ? moneyFromWire(d.credit_limit) : null,
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
      amount: { amount_minor: f.amount.minor.toString(), currency: f.amount.currency },
      credit_limit: f.credit_limit ? { amount_minor: f.credit_limit.minor.toString(), currency: f.credit_limit.currency } : undefined,
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
      <div className="fg-form-grid">
        <FgCard>
          <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
            <FgField label="Tên ngân hàng *" error={errors['bank_name']} help="Chọn ngân hàng đã có hoặc gõ tên mới">
              <FgFreeSelect
                options={bankNameOptions}
                value={f.bank_name}
                onChange={(v) => setF((s) => ({ ...s, bank_name: v }))}
                placeholder="VD: BIDV — chọn hoặc nhập mới"
                allowClear
                loading={bankDebts.isLoading}
                style={{ width: '100%' }}
              />
            </FgField>
            <FgField label="Số tiền vay *" error={errors['amount']} help={f.amount ? formatMoney(f.amount, { mode: 'full' }) : 'Gõ "2,5 tỷ" hoặc "850 tr"'}>
              <FgMoneyInput value={f.amount} onChange={(v) => setF((s) => ({ ...s, amount: v }))} />
            </FgField>
            <FgField label="Hạn mức vay" error={errors['credit_limit']} help={f.credit_limit ? formatMoney(f.credit_limit, { mode: 'full' }) : 'Hạn mức tín dụng được cấp (nếu có)'}>
              <FgMoneyInput value={f.credit_limit} onChange={(v) => setF((s) => ({ ...s, credit_limit: v }))} />
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
            title={`${d.code} · ${d.bank_name}`}
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
              <div className="fg-kpi-value"><FgMoneyStack value={moneyFromWire(d.principal)} /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Hạn mức vay</FgText>
              <div className="fg-kpi-value"><FgMoneyStack value={moneyFromWire(d.credit_limit)} /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Đã trả</FgText>
              <div className="fg-kpi-value"><FgMoneyStack value={moneyFromWire(d.repaid)} /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Dư nợ</FgText>
              <div className="fg-kpi-value"><FgMoneyStack value={moneyFromWire(d.outstanding)} emphasis /></div>
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
                  { title: 'Số tiền', dataIndex: 'amount', key: 'amount', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
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
              <div className="fg-kpi-value"><FgMoneyStack value={moneyFromWire(d.totals.principal)} /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Tổng lãi</FgText>
              <div className="fg-kpi-value"><FgMoneyStack value={moneyFromWire(d.totals.interest)} /></div>
            </FgCard>
            <FgCard className="fg-kpi">
              <FgText style="caption" color="muted">Tổng phải trả</FgText>
              <div className="fg-kpi-value"><FgMoneyStack value={moneyFromWire(d.totals.total)} emphasis /></div>
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
                { title: 'Gốc', dataIndex: 'principal', key: 'pr', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                { title: 'Lãi', dataIndex: 'interest', key: 'in', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                { title: 'Phí', dataIndex: 'fee', key: 'fe', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} /> },
                { title: 'Cộng', dataIndex: 'total', key: 'to', align: 'right', render: (v) => <FgMoneyStack value={moneyFromWire(v)} emphasis /> },
                { title: 'Trạng thái', dataIndex: 'status', key: 'st', render: (v: string) => SCHEDULE_STATUS_LABEL[v] ?? v },
              ]}
            />
          </div>
        </>
      )}
    </FgQuery>
  );
}

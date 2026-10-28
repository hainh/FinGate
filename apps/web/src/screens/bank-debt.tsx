/**
 * Nợ ngân hàng (v2/v2.md §10, §11.4–11.5, US-LOAN-01…03, US-AUTO-01…03, US-AUTO-08).
 *  · Khoản gắn ĐỐI TÁC ngân hàng theo ID (không nhập tên tự do). Tạo tay = khoản đang vay (đã giải ngân).
 *  · Khoản chờ giải ngân do quy tắc tự động tạo (R2 phiếu thu đi vay, R3 phiếu chi vay để chi); không tính dư nợ.
 *  · Giải ngân = liên kết `disbursement` (phiếu thu cùng ngân hàng); trả nợ = `repayment` (phiếu chi, tách gốc / lãi / phí).
 *    Dư nợ do server tính: gốc − Σ phần GỐC của phiếu chi đã thực thi.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Checkbox, DatePicker, type TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import {
  BANK_DEBT_STATUS_KEYS,
  BANK_DEBT_STATUS_REGISTRY,
  REPAYMENT_METHODS,
  REPAYMENT_METHOD_LABEL,
  REPAYMENT_PERIODS,
  REPAYMENT_PERIOD_LABEL,
  STATUS_REGISTRY,
  bankDebtStatusLabel,
  bankDebtStatusTone,
  formatMoney,
  money,
  moneyFromWire,
  parseMoneyInput,
  type Money,
  type MoneyWire,
  type StatusKey,
} from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useAuth, useCurrentCompanyId } from '../app/store.tsx';
import { useActiveBankCodes } from '../app/v2/partners.ts';
import {
  canArchiveLoan,
  canAssignDisbursement,
  canAssignRepayment,
  canCancelLoan,
  canEditLoan,
  hasDeadOffsetLink,
  interestRateText,
  minorOf,
  newRequestId,
  originLabel,
  principalOfSplit,
  useArchiveLoan,
  useAssignDisbursement,
  useAssignRepayment,
  useCancelLoan,
  useCreateLoan,
  useDeleteLoan,
  useImportLoans,
  useLoan,
  useLoanCandidates,
  useLoanList,
  useLoanSchedule,
  useRemoveLoanLink,
  useUpdateLoan,
  voucherHref,
  type DocCandidate,
  type LoanDetail,
  type LoanLinkRow,
  type LoanRow,
  type LoanCreateInput,
  type LoanUpdateInput,
} from '../app/v2/debts.ts';
import { PartnerPicker } from '../components/partner-picker.tsx';
import { FgMaturityCell } from '../components/finance.tsx';
import { FgAlert, FgButton, FgDateTime, FgField, FgInput, FgMoneyInput, FgMoneyStack, FgSelect, FgText, FgTextarea, FgToneChip } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgDescriptions, FgEmptyState, FgModal, FgPagination, FgSkeletonTable, FgTable, FgTag } from '../components/uitk.tsx';
import { ChangeHistoryCard } from '../components/change-history.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useDebounced, useToast } from '../components/pagekit.tsx';
import { problemText } from '../components/attachments.tsx';
import { OwnerAttachmentSection, RemoveLinkModal } from './debt.tsx';
import { parseVnDate } from '../app/v2/loan-import.ts';

/* ================= nhãn & tiện ích ================= */

const STATUS_OPTIONS = BANK_DEBT_STATUS_KEYS.map((k) => ({ value: k, label: bankDebtStatusLabel(k) }));
const RATE_RE = /^\d+([.,]\d{1,2})?$/;

function statusLabelVi(s: string): string {
  return STATUS_REGISTRY[s as StatusKey]?.labelVi ?? s;
}

const ddmmyyyy = (iso: string): string => dayjs(iso).format('DD/MM/YYYY');
const bankNameOf = (r: { partner: { name: string } | null; bank_name: string }): string => r.partner?.name ?? r.bank_name;
const cmpBig = (a: bigint, b: bigint): number => (a === b ? 0 : a > b ? 1 : -1);

/** Trạng thái khoản nợ NH: nhãn + màu từ registry (không tự đặt màu). */
function StatusTag({ status }: { status: string }): ReactNode {
  const glyph = BANK_DEBT_STATUS_REGISTRY[status as keyof typeof BANK_DEBT_STATUS_REGISTRY]?.glyph ?? '';
  return (
    <FgToneChip tone={bankDebtStatusTone(status)}>
      {glyph ? `${glyph} ` : ''}
      {bankDebtStatusLabel(status)}
    </FgToneChip>
  );
}

function OriginTag({ origin }: { origin: { kind: string; rule_code: string | null } }): ReactNode {
  if (origin.kind === 'automation') return <FgToneChip tone="info">{originLabel(origin)}</FgToneChip>;
  return <FgText style="caption" color="muted">Thủ công</FgText>;
}

function KpiCard({ label, value, emphasis, sub }: { label: string; value: MoneyWire; emphasis?: boolean; sub?: ReactNode }): ReactNode {
  return (
    <FgCard className="fg-kpi">
      <FgText style="caption" color="muted">
        {label}
      </FgText>
      <div className="fg-kpi-value">
        <FgMoneyStack value={moneyFromWire(value)} emphasis={emphasis} />
      </div>
      {sub ? <FgText style="caption" color="muted">{sub}</FgText> : null}
    </FgCard>
  );
}

/* ============================== danh sách (LOAN-01) ============================== */

function loanColumns(): TableColumnsType<LoanRow> {
  return [
    {
      title: 'Mã',
      dataIndex: 'code',
      key: 'code',
      sorter: (a, b) => a.code.localeCompare(b.code),
      render: (v: string, r: LoanRow) => (
        <Link className="fg-link" to={`/ngan-hang/khoan-vay/${r._id}`}>
          {v}
        </Link>
      ),
    },
    {
      title: 'Ngân hàng',
      key: 'bank',
      sorter: (a, b) => bankNameOf(a).localeCompare(bankNameOf(b), 'vi'),
      render: (_v, r: LoanRow) =>
        r.partner_id ? (
          <Link className="fg-link" to={`/doi-tac/${r.partner_id}`}>
            {bankNameOf(r)}
          </Link>
        ) : (
          bankNameOf(r)
        ),
    },
    { title: 'Công ty', dataIndex: 'company_name', key: 'co', sorter: (a, b) => a.company_name.localeCompare(b.company_name, 'vi') },
    {
      title: 'Số tiền vay',
      dataIndex: 'principal',
      key: 'principal',
      align: 'right',
      sorter: (a, b) => cmpBig(minorOf(a.principal), minorOf(b.principal)),
      render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} />,
    },
    {
      title: 'Đã trả gốc',
      dataIndex: 'repaid',
      key: 'repaid',
      align: 'right',
      sorter: (a, b) => cmpBig(minorOf(a.repaid), minorOf(b.repaid)),
      render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} />,
    },
    {
      title: 'Dư nợ',
      dataIndex: 'outstanding',
      key: 'outstanding',
      align: 'right',
      sorter: (a, b) => cmpBig(minorOf(a.outstanding), minorOf(b.outstanding)),
      render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} emphasis />,
    },
    {
      title: 'Lãi suất',
      dataIndex: 'interest_rate',
      key: 'ir',
      sorter: (a, b) => Number(a.interest_rate.replace(',', '.')) - Number(b.interest_rate.replace(',', '.')),
      render: (v: string) => `${interestRateText(v)} %/năm`,
    },
    {
      title: 'Hạn thanh toán',
      dataIndex: 'maturity_date',
      key: 'md',
      sorter: (a, b) => a.maturity_date.localeCompare(b.maturity_date),
      render: (_v, r: LoanRow) => (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
          <span className="fg-num">{ddmmyyyy(r.maturity_date)}</span>
          {r.warning ? <FgMaturityCell days={r.days_to_due} tone={r.warning.tone} label={r.warning.label} /> : null}
        </span>
      ),
    },
    {
      title: 'Trạng thái',
      dataIndex: 'status',
      key: 'st',
      sorter: (a, b) => bankDebtStatusLabel(a.status).localeCompare(bankDebtStatusLabel(b.status), 'vi'),
      render: (v: string) => <StatusTag status={v} />,
    },
    { title: 'Nguồn', key: 'origin', render: (_v, r: LoanRow) => <OriginTag origin={r.origin} /> },
    {
      title: 'Ngày tạo',
      dataIndex: 'created_at',
      key: 'created_at',
      defaultSortOrder: 'descend',
      align: 'right',
      sorter: (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''),
      render: (v: string | null) => <FgDateTime value={v} />,
    },
  ];
}

/** Bảng mẫu nhập theo lô (Google Sheets) — cột 1 là MÃ đối tác ngân hàng (DT-…), không phải tên. */
const SHEETS_IMPORT_URL = 'https://docs.google.com/spreadsheets/d/1CsgfK4J17nxxWXR2NDOdrM5NzSW3ltI7jKpwYIN-UkM/edit?gid=0#gid=0';

interface ImportPreviewRow {
  line: number;
  partner_code: string;
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

/** Mã đối tác (cột 1, DT-…) của các dòng trong file — để tra đúng các mã này trên máy chủ. */
function bankCodesOf(text: string): string[] {
  const codes = new Set<string>();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const code = (line.split('\t')[0] ?? '').trim().toUpperCase();
    if (/^DT-/.test(code)) codes.add(code);
  }
  return [...codes];
}

/**
 * Phân tích .tsv: cột 1 = mã đối tác ngân hàng (DT-…). `bankByCode` = kết quả tra mã trên máy chủ (null = chưa
 * kiểm mã, không báo lỗi "sai mã"). Không khớp theo tên — server cũng chỉ nhận mã.
 */
function parseImportTsv(text: string, bankByCode: Map<string, string> | null): ImportPreviewRow[] {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim().length > 0);
  const rows: ImportPreviewRow[] = [];
  if (!lines.length) return rows;
  const firstCells = lines[0]!.split('\t');
  const header = !/^\d[\d.,\s]*$/.test((firstCells[1] ?? '').trim());
  for (let i = header ? 1 : 0; i < lines.length; i++) {
    const cells = lines[i]!.split('\t');
    const errors: string[] = [];

    const partner_code = (cells[0] ?? '').trim().toUpperCase();
    if (!/^DT-/.test(partner_code)) errors.push('Cột 1 phải là mã đối tác ngân hàng (DT-…)');
    else if (bankByCode && !bankByCode.has(partner_code)) errors.push('Không có ngân hàng đang hoạt động với mã này');

    const amountRaw = (cells[1] ?? '').trim();
    const amount = amountRaw ? parseMoneyInput(amountRaw).minor : 0n;
    if (amount <= 0n) errors.push('Số tiền vay không hợp lệ');

    const limitRaw = (cells[2] ?? '').trim();
    const limit = limitRaw ? parseMoneyInput(limitRaw).minor : 0n;

    // giữ quy ước VN "9,5" như người nhập (không đổi thành "9.5"); rỗng ⇒ 0
    const interest_rate = interestRateText(cells[3]) || '0';
    if (!/^\d+([.,]\d{1,2})?$/.test(interest_rate)) errors.push('Lãi suất không hợp lệ');

    const maturity_date = parseVnDate((cells[4] ?? '').trim()) ?? '';
    if (!maturity_date) errors.push('Hạn thanh toán không hợp lệ');

    const termRaw = (cells[5] ?? '').trim().replace(/\D/g, '');
    const term = termRaw ? Number(termRaw) : null;
    if (termRaw && (term === null || term < 1 || term > 600)) errors.push('Kỳ hạn phải 1–600 tháng');

    rows.push({
      line: i + 1,
      partner_code,
      bank_name: bankByCode?.get(partner_code) ?? '',
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
  const imp = useImportLoans();
  const { message } = useToast();
  const [fileName, setFileName] = useState('');
  const [fileText, setFileText] = useState<string | null>(null);
  const [parseError, setParseError] = useState('');
  const [result, setResult] = useState<{ inserted: number; failed: { row: number; error: string }[] } | null>(null);

  // Mã ngân hàng trong file được TRA ĐÚNG trên máy chủ (không qua danh sách ngân hàng đã tải — danh sách bị trần
  // số dòng, nên mã hợp lệ ngoài phần đầu bị báo sai "không có ngân hàng").
  const fileCodes = useMemo(() => (fileText === null ? [] : bankCodesOf(fileText)), [fileText]);
  const lookup = useActiveBankCodes(fileCodes, company, open);
  // chưa tra xong thì không nút nhập (tránh nhập mã chưa kiểm); lỗi tra cứu ⇒ vẫn cho nhập, máy chủ kiểm từng dòng
  const lookupDone = fileCodes.length === 0 || lookup.isSuccess || lookup.isError;
  const bankByCode = useMemo(() => new Map<string, string>((lookup.data ?? []).map((b) => [b.code.toUpperCase(), b.name])), [lookup.data]);
  // Xem trước tính lại khi đổi file hoặc khi mã đã được tra xong (khi chưa tra xong không kết luận "sai mã").
  const bankCheck = lookup.isSuccess ? bankByCode : null;
  const rows = useMemo(() => (fileText === null ? [] : parseImportTsv(fileText, bankCheck)), [fileText, bankCheck]);

  const validRows = rows.filter((r) => !r.errors.length);
  const invalidCount = rows.length - validRows.length;

  const onFile = async (file: File | undefined): Promise<void> => {
    setFileName('');
    setParseError('');
    setResult(null);
    setFileText(null);
    if (!file) return;
    setFileName(file.name);
    const text = decodeTsvBuffer(await file.arrayBuffer());
    if (!parseImportTsv(text, null).length) {
      setParseError('File không có dòng dữ liệu nào — dòng 1 là tiêu đề, từ dòng 2 trở đi là dữ liệu.');
      return;
    }
    setFileText(text);
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
          partner_code: row.partner_code,
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
            <FgButton variant="primary" loading={imp.isPending} disabled={!validRows.length || !lookupDone} onClick={() => void submit()}>
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
              Điền mỗi dòng một khoản vay (từ dòng 2 trở đi, dòng 1 là tiêu đề) theo 7 cột:{' '}
              <strong>Mã đối tác ngân hàng (DT-…) · Số tiền vay · Hạn mức vay · Lãi suất % · Hạn thanh toán (ng/th/năm) · Kỳ hạn (tháng) · Ghi chú</strong>.
              Mã lấy ở màn <Link to="/doi-tac">Đối tác</Link> (cột Mã của ngân hàng). Không nhập tên ngân hàng — tên không được dùng để khớp.
            </li>
            <li style={{ marginBottom: 4 }}>
              Bảng mẫu:{' '}
              <a href={SHEETS_IMPORT_URL} target="_blank" rel="noopener noreferrer">
                Google Sheets
              </a>{' '}
              (nếu bảng mẫu còn cột tên ngân hàng ở cột 1, hãy đổi sang mã DT-…). Tải về: <strong>Tệp → Tải xuống → Giá trị được phân tách bằng tab (.tsv)</strong>.
            </li>
            <li>Chọn file dưới đây, xem trước rồi bấm <strong>Nhập</strong> — dòng lỗi bị bỏ qua và báo riêng.</li>
          </ol>
        }
        style={{ marginBottom: 'var(--fg-space-4)' }}
      />
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
              { title: 'Mã đối tác', dataIndex: 'partner_code', key: 'pc', render: (v: string) => <span className="fg-num">{v || '—'}</span> },
              { title: 'Ngân hàng', dataIndex: 'bank_name', key: 'bn', render: (v: string) => v || '—' },
              { title: 'Số tiền vay', key: 'amt', align: 'right', render: (_v, r) => (r.amount_minor && r.amount_minor !== '0' ? formatMoney(money(r.amount_minor), { mode: 'full' }) : '—') },
              { title: 'Hạn mức', key: 'cl', align: 'right', render: (_v, r) => (r.credit_limit_minor ? formatMoney(money(r.credit_limit_minor), { mode: 'full' }) : '—') },
              { title: 'Lãi suất', dataIndex: 'interest_rate', key: 'ir', render: (v: string) => `${interestRateText(v)} %` },
              { title: 'Hạn TT', dataIndex: 'maturity_date', key: 'md', render: (v: string) => (v ? dayjs(v).format('DD/MM/YYYY') : '—') },
              { title: 'Kỳ hạn', dataIndex: 'term_months', key: 'tm', render: (v: string) => (v ? `${v} tháng` : '—') },
              {
                title: 'Trạng thái',
                key: 'st',
                render: (_v, r) =>
                  r.errors.length ? (
                    <FgText style="caption" color="danger">
                      {r.errors.join('; ')}
                    </FgText>
                  ) : (
                    <FgText style="caption" color="success">
                      Hợp lệ
                    </FgText>
                  ),
              },
            ]}
          />
        </>
      ) : null}
    </FgModal>
  );
}

/** Cỡ trang danh sách khoản vay (phân trang phía máy chủ — `items` chỉ gồm một trang). */
const LOAN_PAGE_SIZE = 50;

export function BankDebtListScreen(): ReactNode {
  const [searchParams, setSearchParams] = useSearchParams();
  const { can } = useAuth();
  const status = searchParams.get('status') || undefined;
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [page, setPage] = useState(1);
  const query = useLoanList({ status, q: q || undefined, page, limit: LOAN_PAGE_SIZE });
  const [importOpen, setImportOpen] = useState(false);

  const setStatus = (v?: string): void => {
    setPage(1);
    const next = new URLSearchParams(searchParams);
    if (v) next.set('status', v);
    else next.delete('status');
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <FgPageHeader
        title="Nợ ngân hàng"
        meta="Khoản vay — dư nợ tự trừ khi phiếu chi trả nợ được thực thi. Khoản chờ giải ngân không tính vào dư nợ."
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            {can('loan:write') ? <FgButton onClick={() => setImportOpen(true)}>Nhập theo lô (.tsv)</FgButton> : null}
            {can('loan:write') ? (
              <Link to="/ngan-hang/khoan-vay/moi">
                <FgButton variant="primary">+ Tạo khoản vay</FgButton>
              </Link>
            ) : null}
          </div>
        }
      />
      {importOpen ? <BankDebtImportModal open onClose={() => setImportOpen(false)} onImported={() => void query.refetch()} /> : null}

      <div className="fg-filterbar">
        <FgSelect ariaLabel="Trạng thái" placeholder="Mọi trạng thái" allowClear options={STATUS_OPTIONS} value={status} onChange={(v) => setStatus(v)} style={{ width: 200 }} />
        <FgInput
          allowClear
          placeholder="Tìm theo mã hoặc tên ngân hàng"
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          style={{ width: 260 }}
        />
      </div>

      <FgQuery query={query} skeleton={<FgSkeletonTable rows={5} cols={8} />}>
        {(data) => (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
              <KpiCard label="Dư nợ đang vay" value={data.totals.outstanding} emphasis sub="Đang vay + quá hạn" />
              <FgCard className="fg-kpi">
                <FgText style="caption" color="muted">
                  Số khoản
                </FgText>
                <div className="fg-kpi-value">{data.totals.count}</div>
                <FgText style="caption" color="muted">
                  trong danh sách đang lọc
                </FgText>
              </FgCard>
              <FgCard className="fg-kpi">
                <FgText style="caption" color="muted">
                  Chờ giải ngân
                </FgText>
                <div className="fg-kpi-value">
                  <FgMoneyStack value={moneyFromWire(data.totals.pending_amount)} />
                </div>
                <FgText style="caption" color="muted">
                  {data.totals.pending_count} khoản · không tính vào dư nợ{' '}
                  {status !== 'pending_disbursement' ? (
                    <FgButton size="small" variant="text" onClick={() => setStatus('pending_disbursement')}>
                      Xem
                    </FgButton>
                  ) : null}
                </FgText>
              </FgCard>
            </div>
            {!data.items.length && page > 1 ? (
              <div className="fg-card">
                <FgEmptyState glyph="◇" title="Trang này không còn khoản nào" action={<FgButton onClick={() => setPage(1)}>Về trang 1</FgButton>} />
              </div>
            ) : !data.items.length ? (
              <div className="fg-card">
                <FgEmptyState glyph="◇" title="Chưa có khoản nợ ngân hàng nào" description="Tạo khoản vay tay, nhập theo lô, hoặc lập phiếu thu đi vay để tự sinh khoản chờ giải ngân." />
              </div>
            ) : (
              <div className="fg-card" style={{ padding: 0 }}>
                <FgTable rowKey="_id" dataSource={data.items} columns={loanColumns()} />
                {data.total > LOAN_PAGE_SIZE ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--fg-space-2)', padding: 'var(--fg-space-4) 0' }}>
                    <FgText style="caption" color="muted">
                      {`Hiển thị ${(page - 1) * LOAN_PAGE_SIZE + 1}–${Math.min(page * LOAN_PAGE_SIZE, data.total)} / ${data.total} khoản`}
                    </FgText>
                    <FgPagination current={page} pageSize={LOAN_PAGE_SIZE} total={data.total} showSizeChanger={false} onChange={(p) => setPage(p)} />
                  </div>
                ) : null}
              </div>
            )}
          </>
        )}
      </FgQuery>
    </>
  );
}

/* ============================== tạo / sửa khoản vay (LOAN-03) ============================== */

interface LoanFormState {
  partner_id: string | null;
  amount: Money | null;
  credit_limit: Money | null;
  disbursed_date: string;
  /** Tạo khoản chờ giải ngân (chưa có tiền về): không gửi ngày giải ngân. */
  awaiting_disbursement: boolean;
  maturity_date: string;
  interest_rate: string;
  term_months: string;
  payment_frequency: string;
  repayment_method: string;
  /** v2 §10.1: số HĐ tín dụng, TSĐB, người phụ trách (trường riêng, không còn ghi vào ghi chú). */
  contract_no: string;
  collateral: string;
  responsible: string;
  note: string;
}

export function BankDebtFormScreen(): ReactNode {
  const { id } = useParams<{ id?: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const company = useCurrentCompanyId();
  const existing = useLoan(id);
  const create = useCreateLoan();
  const update = useUpdateLoan(id ?? '');
  const { message } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [prefilled, setPrefilled] = useState(false);
  const editMode = !!id;
  const detail = existing.data;
  // Mã chống gửi lặp: giữ nguyên qua các lần lưu lại (retry) của cùng một form.
  const requestIdRef = useRef<string>(newRequestId());
  const [f, setF] = useState<LoanFormState>(() => ({
    partner_id: searchParams.get('partner_id') || null,
    amount: null,
    credit_limit: null,
    disbursed_date: dayjs().format('YYYY-MM-DD'),
    awaiting_disbursement: false,
    maturity_date: dayjs().add(12, 'month').subtract(1, 'day').format('YYYY-MM-DD'),
    interest_rate: '0',
    term_months: '12',
    payment_frequency: 'maturity',
    repayment_method: 'interest_only',
    contract_no: '',
    collateral: '',
    responsible: '',
    note: '',
  }));

  useEffect(() => {
    if (!detail || prefilled) return;
    setF({
      partner_id: detail.partner_id,
      amount: moneyFromWire(detail.principal),
      credit_limit: minorOf(detail.credit_limit) > 0n ? moneyFromWire(detail.credit_limit) : null,
      disbursed_date: detail.disbursed_at ? dayjs(detail.disbursed_at).format('YYYY-MM-DD') : dayjs().format('YYYY-MM-DD'),
      awaiting_disbursement: detail.status === 'pending_disbursement',
      maturity_date: detail.maturity_date,
      interest_rate: interestRateText(detail.interest_rate) || '0',
      term_months: detail.term_months != null ? String(detail.term_months) : '',
      payment_frequency: detail.payment_frequency,
      repayment_method: detail.repayment_method,
      contract_no: detail.contract_no ?? '',
      collateral: detail.collateral ?? '',
      responsible: detail.responsible ?? '',
      note: detail.note ?? '',
    });
    setPrefilled(true);
  }, [detail, prefilled]);

  const chainCount = detail ? withChainDefaults(detail).chain.funded_by.length + (detail.chain?.disbursements?.length ?? 0) + (detail.chain?.repayments?.length ?? 0) : 0;
  const locked = chainCount > 0;
  const busy = create.isPending || update.isPending;

  const submit = async (): Promise<void> => {
    setErrors({});
    if (!f.partner_id) {
      setErrors({ partner_id: 'Chọn ngân hàng cho vay' });
      return;
    }
    if (!f.amount || f.amount.minor <= 0n) {
      setErrors({ amount: 'Nhập số tiền vay lớn hơn 0' });
      return;
    }
    if (!f.maturity_date) {
      setErrors({ maturity_date: 'Chọn hạn thanh toán' });
      return;
    }
    // Hạn thanh toán phải sau ngày giải ngân (server kiểm lại).
    if (!editMode && !f.awaiting_disbursement && f.disbursed_date && f.maturity_date <= f.disbursed_date) {
      setErrors({ maturity_date: 'Hạn thanh toán phải sau ngày giải ngân' });
      return;
    }
    const rate = f.interest_rate.trim() || '0';
    if (!RATE_RE.test(rate)) {
      setErrors({ interest_rate: 'Lãi suất tối đa 2 chữ số thập phân' });
      return;
    }
    const term = f.term_months ? Number(f.term_months) : undefined;
    const amount = { amount_minor: f.amount.minor.toString(), currency: f.amount.currency };
    const credit = f.credit_limit ? { amount_minor: f.credit_limit.minor.toString(), currency: f.credit_limit.currency } : undefined;
    try {
      if (editMode) {
        if (!detail) {
          message.error('Chưa tải được khoản nợ');
          return;
        }
        const body: LoanUpdateInput = {
          amount,
          credit_limit: credit ?? null,
          maturity_date: f.maturity_date,
          interest_rate: rate,
          term_months: term ?? null,
          payment_frequency: f.payment_frequency,
          repayment_method: f.repayment_method,
          contract_no: f.contract_no.trim() || null,
          collateral: f.collateral.trim() || null,
          responsible: f.responsible.trim() || null,
          note: f.note.trim() || null,
        };
        if (f.partner_id !== detail.partner_id) body.partner_id = f.partner_id;
        // Đổi giải ngân tay (chỉ gửi khi tích/bỏ tích khác trạng thái đang lưu).
        if (f.awaiting_disbursement !== (detail.status === 'pending_disbursement')) {
          body.disbursed = !f.awaiting_disbursement;
          if (!f.awaiting_disbursement) body.disbursed_date = f.disbursed_date || undefined;
        }
        await update.mutateAsync(body);
        message.success('Đã cập nhật khoản nợ ngân hàng');
        navigate(`/ngan-hang/khoan-vay/${id}`);
        return;
      }
      if (!company) {
        message.error('Chưa chọn công ty');
        return;
      }
      const body: LoanCreateInput = {
        company_id: company,
        partner_id: f.partner_id,
        amount,
        ...(credit ? { credit_limit: credit } : {}),
        disbursed: !f.awaiting_disbursement,
        disbursed_date: f.awaiting_disbursement ? undefined : f.disbursed_date || undefined,
        maturity_date: f.maturity_date,
        interest_rate: rate,
        ...(term ? { term_months: term } : {}),
        payment_frequency: f.payment_frequency,
        repayment_method: f.repayment_method,
        request_id: requestIdRef.current,
        ...(f.contract_no.trim() ? { contract_no: f.contract_no.trim() } : {}),
        ...(f.collateral.trim() ? { collateral: f.collateral.trim() } : {}),
        ...(f.responsible.trim() ? { responsible: f.responsible.trim() } : {}),
        ...(f.note.trim() ? { note: f.note.trim() } : {}),
      };
      const r = await create.mutateAsync(body);
      message.success('Đã lưu khoản nợ ngân hàng');
      navigate(`/ngan-hang/khoan-vay/${r._id}`);
    } catch (e) {
      if (e instanceof ApiRequestError && e.problem.errors) setErrors(e.problem.errors);
      message.error(problemText(e, 'Không lưu được khoản nợ'));
    }
  };

  if (editMode && !detail) {
    return (
      <>
        <FgPageHeader title="Sửa khoản nợ ngân hàng" />
        <FgSkeletonTable rows={4} cols={3} />
      </>
    );
  }

  return (
    <>
      <FgPageHeader
        title={editMode && detail ? `Sửa khoản nợ ${detail.code}` : 'Tạo khoản nợ ngân hàng'}
        meta="Khoản vay tạo tay là khoản đang vay (đã giải ngân). Khoản chờ giải ngân được tạo từ phiếu thu đi vay hoặc phiếu chi vay để chi."
      />
      {locked ? (
        <FgAlert tone="info" title="Đã có phiếu giải ngân / trả nợ / chi bằng vốn vay: không đổi ngân hàng. Gỡ liên kết trước nếu cần." style={{ marginBottom: 'var(--fg-space-4)' }} />
      ) : null}
      <div className="fg-form-grid">
        <FgCard>
          <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}>
            <PartnerPicker
              value={f.partner_id}
              onChange={(pid) => setF((s) => ({ ...s, partner_id: pid }))}
              allowedTypes={['bank']}
              defaultType="bank"
              companyId={editMode ? detail?.company_id : company}
              label="Ngân hàng cho vay"
              required
              error={errors['partner_id']}
              lockSelection={locked}
              placeholder="Chọn ngân hàng (đối tác loại Ngân hàng)"
            />
            <FgField label="Số tiền vay (gốc) *" error={errors['amount']} help={f.amount ? formatMoney(f.amount, { mode: 'full' }) : 'Gõ "2,5 tỷ" hoặc "850 tr"'}>
              <FgMoneyInput value={f.amount} onChange={(v) => setF((s) => ({ ...s, amount: v }))} />
            </FgField>
            <FgField label="Hạn mức tín dụng" error={errors['credit_limit']} help={f.credit_limit ? formatMoney(f.credit_limit, { mode: 'full' }) : 'Hạn mức được cấp (nếu có)'}>
              <FgMoneyInput value={f.credit_limit} onChange={(v) => setF((s) => ({ ...s, credit_limit: v }))} />
            </FgField>
            <FgField
              label="Giải ngân"
              help={
                editMode
                  ? 'Bỏ tích để đánh dấu đã giải ngân (không được đã gán phiếu thu giải ngân vào khoản).'
                  : 'Đánh dấu nếu khoản chưa có tiền về. Tiền về sau được gán bằng phiếu thu giải ngân.'
              }
            >
              <Checkbox checked={f.awaiting_disbursement} onChange={(e) => setF((s) => ({ ...s, awaiting_disbursement: e.target.checked }))}>
                Chờ giải ngân (chưa có tiền về)
              </Checkbox>
            </FgField>
            {!f.awaiting_disbursement && (!editMode || detail?.status === 'pending_disbursement') ? (
              <FgField label="Ngày giải ngân" error={errors['disbursed_date']} help="Mặc định hôm nay">
                <DatePicker
                  value={f.disbursed_date ? dayjs(f.disbursed_date) : null}
                  onChange={(d) => setF((s) => ({ ...s, disbursed_date: d ? d.format('YYYY-MM-DD') : '' }))}
                  format="DD/MM/YYYY"
                  style={{ width: '100%' }}
                />
              </FgField>
            ) : null}
            <FgField label="Hạn thanh toán (đáo hạn) *" error={errors['maturity_date']}>
              <DatePicker
                value={f.maturity_date ? dayjs(f.maturity_date) : null}
                onChange={(d) => setF((s) => ({ ...s, maturity_date: d ? d.format('YYYY-MM-DD') : '' }))}
                format="DD/MM/YYYY"
                style={{ width: '100%' }}
              />
            </FgField>
            <FgField label="Lãi suất (%/năm)" error={errors['interest_rate']}>
              <FgInput value={f.interest_rate} onChange={(e) => setF((s) => ({ ...s, interest_rate: e.target.value }))} placeholder="VD: 9,5" />
            </FgField>
            <FgField label="Kỳ hạn (tháng)" error={errors['term_months']}>
              <FgInput value={f.term_months} onChange={(e) => setF((s) => ({ ...s, term_months: e.target.value.replace(/\D/g, '') }))} placeholder="VD: 12" />
            </FgField>
            <FgField label="Kỳ trả lãi / gốc">
              <FgSelect
                options={REPAYMENT_PERIODS.map((p) => ({ value: p, label: REPAYMENT_PERIOD_LABEL[p] }))}
                value={f.payment_frequency}
                onChange={(v) => setF((s) => ({ ...s, payment_frequency: v ?? 'maturity' }))}
                style={{ width: '100%' }}
              />
            </FgField>
            <FgField label="Cách trả gốc">
              <FgSelect
                options={REPAYMENT_METHODS.map((m) => ({ value: m, label: REPAYMENT_METHOD_LABEL[m] }))}
                value={f.repayment_method}
                onChange={(v) => setF((s) => ({ ...s, repayment_method: v ?? 'interest_only' }))}
                style={{ width: '100%' }}
              />
            </FgField>
            <FgField label="Số HĐ tín dụng" error={errors['contract_no']}>
              <FgInput value={f.contract_no} onChange={(e) => setF((s) => ({ ...s, contract_no: e.target.value }))} placeholder="Số hợp đồng tín dụng" maxLength={80} />
            </FgField>
            <FgField label="Người phụ trách" error={errors['responsible']}>
              <FgInput value={f.responsible} onChange={(e) => setF((s) => ({ ...s, responsible: e.target.value }))} placeholder="Họ tên" maxLength={120} />
            </FgField>
            <div style={{ gridColumn: '1/-1' }}>
              <FgField label="Tài sản đảm bảo (TSĐB)" error={errors['collateral']}>
                <FgTextarea rows={2} value={f.collateral} onChange={(e) => setF((s) => ({ ...s, collateral: e.target.value }))} placeholder="Mô tả tài sản đảm bảo" />
              </FgField>
            </div>
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
              {editMode && detail ? `Khoản ${detail.code} · ${bankDebtStatusLabel(detail.status)}` : 'Khoản mới — chưa lưu'}
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
              {editMode ? 'Lưu thay đổi' : 'Lưu khoản vay'}
            </FgButton>
            <div style={{ marginTop: 8 }}>
              <FgButton block onClick={() => navigate(-1)}>
                Hủy
              </FgButton>
            </div>
            <FgText style="caption" color="muted">
              Sau khi lưu, mở chi tiết để gán phiếu giải ngân, phiếu chi trả nợ và đính kèm hợp đồng (PDF/ảnh ≤100MB).
            </FgText>
          </FgCard>
        </div>
      </div>
    </>
  );
}

/* ============================== chi tiết khoản vay (LOAN-02 · US-AUTO-08) ============================== */

/** Phiếu thu giải ngân / phiếu chi trả nợ: chọn phiếu (cùng ngân hàng). Trả nợ có tách gốc / lãi / phí. */
function LoanCandidateModal({ loanId, relation, onClose }: { loanId: string; relation: 'disbursement' | 'repayment'; onClose: () => void }): ReactNode {
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const [amount, setAmount] = useState<Money | null>(null);
  const [picked, setPicked] = useState<DocCandidate | null>(null);
  const [interest, setInterest] = useState<Money | null>(null);
  const [fee, setFee] = useState<Money | null>(null);
  const candidates = useLoanCandidates(loanId, relation, q);
  const assignDisb = useAssignDisbursement(loanId);
  const assignRepay = useAssignRepayment(loanId);
  const { message } = useToast();
  const isRepay = relation === 'repayment';
  const busy = assignDisb.isPending || assignRepay.isPending;

  const total = amount?.minor ?? 0n;
  const interestMinor = interest?.minor ?? 0n;
  const feeMinor = fee?.minor ?? 0n;
  const principal = principalOfSplit(total, interestMinor, feeMinor);

  const pick = (row: DocCandidate): void => {
    setPicked(row);
    setAmount(minorOf(row.unallocated) > 0n ? moneyFromWire(row.unallocated) : null);
    setInterest(null);
    setFee(null);
  };

  const confirmDisbursement = (documentId: string): void => {
    assignDisb.mutate(
      { document_id: documentId, ...(amount ? { amount_minor: amount.minor.toString() } : {}) },
      {
        onSuccess: () => {
          message.success('Đã gán phiếu giải ngân');
          onClose();
        },
        onError: (e) => message.error(problemText(e, 'Không gán được phiếu giải ngân')),
      },
    );
  };

  const confirmRepayment = (): void => {
    if (!picked) return;
    if (total <= 0n) {
      message.error('Nhập số tiền trả nợ lớn hơn 0');
      return;
    }
    if (principal === null) {
      message.error('Lãi và phí không được vượt số tiền trả nợ');
      return;
    }
    assignRepay.mutate(
      {
        document_id: picked._id,
        amount_minor: total.toString(),
        split: { principal: principal.toString(), interest: interestMinor.toString(), fee: feeMinor.toString() },
      },
      {
        onSuccess: () => {
          message.success('Đã gán phiếu chi trả nợ');
          onClose();
        },
        onError: (e) => message.error(problemText(e, 'Không gán được phiếu trả nợ')),
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
        ) : isRepay ? (
          <FgButton size="small" disabled={minorOf(r.unallocated) <= 0n} onClick={() => pick(r)}>
            Chọn
          </FgButton>
        ) : (
          <FgButton size="small" disabled={minorOf(r.unallocated) <= 0n} loading={assignDisb.isPending} onClick={() => confirmDisbursement(r._id)}>
            Gán
          </FgButton>
        ),
    },
  ];

  if (isRepay && picked) {
    return (
      <FgModal
        open
        title="Gán phiếu chi trả nợ"
        onCancel={onClose}
        width={560}
        footer={
          <>
            <FgButton onClick={() => setPicked(null)} disabled={busy}>
              ← Chọn phiếu khác
            </FgButton>
            <FgButton variant="primary" loading={busy} disabled={principal === null || total <= 0n} onClick={confirmRepayment}>
              Gán phiếu trả nợ
            </FgButton>
          </>
        }
      >
        <FgText style="bodyS">
          Phiếu <strong>{picked.code}</strong> · {picked.title || 'Phiếu chi'} · còn phân bổ{' '}
          {formatMoney(moneyFromWire(picked.unallocated) ?? money(0n), { mode: 'full' })}
        </FgText>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 'var(--fg-space-3)', marginTop: 12 }}>
          <FgField label="Số tiền trả nợ *" help="Tổng = gốc + lãi + phí">
            <FgMoneyInput value={amount} onChange={setAmount} />
          </FgField>
          <FgField label="Trong đó: lãi">
            <FgMoneyInput value={interest} onChange={setInterest} />
          </FgField>
          <FgField label="Trong đó: phí">
            <FgMoneyInput value={fee} onChange={setFee} />
          </FgField>
          <FgField label="Gốc (tự tính)" error={principal === null && total > 0n ? 'Lãi + phí vượt tổng' : null} help="Chỉ phần gốc làm giảm dư nợ">
            <FgText style="body" strong>
              {principal === null ? '—' : formatMoney(money(principal), { mode: 'full' })}
            </FgText>
          </FgField>
        </div>
        <FgText style="caption" color="muted">
          Phiếu chỉ tính vào dư nợ khi đã thực thi. Không tách: để lãi và phí bằng 0 — toàn bộ là gốc.
        </FgText>
      </FgModal>
    );
  }

  return (
    <FgModal open title={isRepay ? 'Gán phiếu chi trả nợ' : 'Gán phiếu thu giải ngân'} onCancel={onClose} width={760} footer={<FgButton onClick={onClose}>Đóng</FgButton>}>
      <FgText style="caption" color="muted">
        {isRepay
          ? 'Phiếu chi cùng ngân hàng, chưa huỷ. Chỉ phiếu đã thực thi mới trừ dư nợ.'
          : 'Phiếu thu cùng ngân hàng (tiền giải ngân). Phiếu đã thực thi chuyển khoản sang "Đang vay".'}
      </FgText>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(200px,1fr) minmax(180px,220px)', gap: 'var(--fg-space-3)', margin: '12px 0' }}>
        <FgField label="Tìm theo mã / nội dung">
          <FgInput allowClear value={search} onChange={(e) => setSearch(e.target.value)} placeholder="VD: PC-2026 hoặc nội dung" />
        </FgField>
        {!isRepay ? (
          <FgField label="Số tiền giải ngân" help="Bỏ trống = phần còn lại có thể phân bổ">
            <FgMoneyInput value={amount} onChange={setAmount} />
          </FgField>
        ) : null}
      </div>
      {candidates.isLoading ? (
        <FgSkeletonTable rows={4} cols={4} />
      ) : !candidates.data?.items.length ? (
        <FgEmptyState glyph="◇" title={isRepay ? 'Không có phiếu chi phù hợp' : 'Không có phiếu thu phù hợp'} description="Phiếu phải cùng ngân hàng và chưa huỷ." />
      ) : (
        <FgTable rowKey="_id" size="small" dataSource={candidates.data.items} columns={columns} />
      )}
    </FgModal>
  );
}

/** Huỷ khoản đang chờ giải ngân: bắt buộc lý do. Chỉ khi chưa có tiền giải ngân về (server kiểm). */
function CancelLoanModal({ loanId, code, onClose }: { loanId: string; code: string; onClose: () => void }): ReactNode {
  const [reason, setReason] = useState('');
  const cancel = useCancelLoan(loanId);
  const { message } = useToast();
  const valid = reason.trim().length >= 5;
  return (
    <FgModal
      open
      title="Huỷ khoản chờ giải ngân"
      onCancel={onClose}
      width={480}
      footer={
        <>
          <FgButton onClick={onClose} disabled={cancel.isPending}>
            Hủy
          </FgButton>
          <FgButton
            variant="danger"
            loading={cancel.isPending}
            disabled={!valid}
            onClick={() =>
              cancel.mutate(reason.trim(), {
                onSuccess: () => {
                  message.success('Đã huỷ khoản chờ giải ngân');
                  onClose();
                },
                onError: (e) => message.error(problemText(e, 'Không huỷ được khoản')),
              })
            }
          >
            Huỷ khoản
          </FgButton>
        </>
      }
    >
      <FgText style="body">
        Huỷ khoản <strong>{code}</strong>. Chỉ huỷ được khi mọi phiếu đang liên kết đã huỷ hoặc từ chối (các liên kết đó được đánh dấu gỡ, giữ lịch sử).
        Nếu còn phiếu giải ngân chưa huỷ, hãy gỡ liên kết hoặc huỷ phiếu đó trước. Không huỷ được khi đã có tiền giải ngân về.
      </FgText>
      <FgField label="Lý do huỷ *" help="Tối thiểu 5 ký tự" error={reason && !valid ? 'Nêu lý do (tối thiểu 5 ký tự)' : null}>
        <FgInput value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </FgField>
    </FgModal>
  );
}

/** Chuỗi khoản vay luôn là MẢNG (phản hồi thiếu/null không được làm sập màn chi tiết khi đọc `[0]`, `.length`). */
function withChainDefaults(d: LoanDetail): LoanDetail {
  const c = (d.chain ?? {}) as Partial<LoanDetail['chain']>;
  return { ...d, chain: { funded_by: c.funded_by ?? [], disbursements: c.disbursements ?? [], repayments: c.repayments ?? [] } };
}

function ChainTable({
  rows,
  columns,
}: {
  rows: LoanLinkRow[];
  columns: TableColumnsType<LoanLinkRow>;
}): ReactNode {
  return <FgTable rowKey="_id" size="small" dataSource={rows} columns={columns} pagination={false} />;
}

function docLinkCell(r: LoanLinkRow): ReactNode {
  return (
    <div>
      <Link className="fg-link" to={voucherHref(r.document_kind, r.document_id)}>
        {r.document_code}
      </Link>
      <FgText style="caption" color="muted">
        {' '}
        · {r.document_title || (r.document_kind === 'income' ? 'Phiếu thu' : 'Phiếu chi')}
      </FgText>
    </div>
  );
}

export function BankDebtDetailScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { can } = useAuth();
  const query = useLoan(id);
  const unlinkDisb = useRemoveLoanLink(id ?? '', 'disbursement');
  const unlinkRepay = useRemoveLoanLink(id ?? '', 'repayment');
  const unlinkFunded = useRemoveLoanLink(id ?? '', 'funded_by');
  const archive = useArchiveLoan(id ?? '');
  const del = useDeleteLoan();
  const { message } = useToast();
  const [picker, setPicker] = useState<'disbursement' | 'repayment' | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<{ relation: 'disbursement' | 'repayment' | 'funded_by'; row: LoanLinkRow } | null>(null);
  const linkPerms = can('loan:write') && can('link:manage');

  return (
    <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={3} />}>
      {(raw: LoanDetail) => {
        const d = withChainDefaults(raw);
        const status = d.status;
        const source = d.chain.funded_by[0] ?? d.chain.disbursements.find((l) => l.origin === 'automation') ?? null;
        const chainTotal = d.chain.funded_by.length + d.chain.disbursements.length + d.chain.repayments.length;
        const remove = (relation: 'disbursement' | 'repayment' | 'funded_by') => (row: LoanLinkRow) => setUnlinking({ relation, row });
        const rolloverHref = `/ngan-hang/dao-han/phuong-an/moi?kind=rollover&loan_id=${d._id}${d.partner_id ? `&partner_id=${d.partner_id}` : ''}`;
        return (
          <>
            <FgPageHeader
              title={`${d.code} · ${bankNameOf(d)}`}
              meta={`Hạn thanh toán ${ddmmyyyy(d.maturity_date)} · lãi suất ${interestRateText(d.interest_rate)}%/năm`}
              actions={
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <Link to={`/ngan-hang/khoan-vay/${d._id}/lich-tra`}>
                    <FgButton>Lịch trả nợ</FgButton>
                  </Link>
                  {canEditLoan(status) && can('loan:write') ? <FgButton onClick={() => navigate(`/ngan-hang/khoan-vay/${d._id}/sua`)}>Sửa</FgButton> : null}
                  {canCancelLoan(status) && can('loan:write') ? (
                    <FgButton variant="danger" onClick={() => setCancelOpen(true)}>
                      Huỷ khoản
                    </FgButton>
                  ) : null}
                  {canArchiveLoan(status) && can('loan:write') ? (
                    <FgButton
                      loading={archive.isPending}
                      onClick={() =>
                        archive.mutate(undefined, {
                          onSuccess: () => message.success('Đã lưu trữ khoản vay'),
                          onError: (e) => message.error(problemText(e, 'Không lưu trữ được')),
                        })
                      }
                    >
                      Lưu trữ
                    </FgButton>
                  ) : null}
                  {(status === 'active' || status === 'overdue') && can('doc:create') ? (
                    <Link to={rolloverHref}>
                      <FgButton>+ Lập phương án đảo hạn</FgButton>
                    </Link>
                  ) : null}
                  {/* Chỉ xoá khoản chờ giải ngân chưa có liên kết nào (v2 §2.3); còn lại dùng Huỷ / Lưu trữ. */}
                  {status === 'pending_disbursement' && chainTotal === 0 && can('loan:delete') ? (
                    <FgButton variant="danger" onClick={() => setDeleteOpen(true)}>
                      Xoá
                    </FgButton>
                  ) : null}
                </div>
              }
            />

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 'var(--fg-space-4)' }}>
              <StatusTag status={status} />
              <OriginTag origin={d.origin} />
              {d.warning && d.days_to_due !== undefined ? <FgMaturityCell days={d.days_to_due} tone={d.warning.tone} label={d.warning.label} /> : null}
            </div>

            {status === 'pending_disbursement' ? (
              <FgAlert
                tone="info"
                title="Khoản chờ giải ngân — chưa tính vào dư nợ"
                description="Chuyển sang Đang vay khi phiếu thu giải ngân được thực thi (tiền về tài khoản). Có thể gán thêm phiếu thu giải ngân bên dưới."
                style={{ marginBottom: 'var(--fg-space-4)' }}
              />
            ) : null}
            {status === 'cancelled' ? (
              <FgAlert tone="neutral" title="Khoản đã huỷ" description="Không còn tính vào dư nợ hay đáo hạn." style={{ marginBottom: 'var(--fg-space-4)' }} />
            ) : null}
            {hasDeadOffsetLink([...d.chain.funded_by, ...d.chain.disbursements, ...d.chain.repayments]) ? (
              <FgAlert
                tone="warning"
                title="Có liên kết tới phiếu đã huỷ / từ chối / hết hạn — không còn tính vào sức chứa. Nên gỡ liên kết đó để sổ sạch."
                style={{ marginBottom: 'var(--fg-space-4)' }}
              />
            ) : null}
            {d.origin.kind === 'automation' && source ? (
              <FgAlert
                tone="info"
                title={`Tự động sinh từ quy trình ${d.origin.rule_code ?? ''}`.trim()}
                description={
                  <span>
                    Phiếu nguồn: <Link className="fg-link" to={voucherHref(source.document_kind, source.document_id)}>{source.document_code}</Link>
                  </span>
                }
                style={{ marginBottom: 'var(--fg-space-4)' }}
              />
            ) : null}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 'var(--fg-space-3)', marginBottom: 'var(--fg-space-4)' }}>
              <KpiCard label="Số tiền vay (gốc)" value={d.principal} sub={d.credit_limit && minorOf(d.credit_limit) > 0n ? `Hạn mức ${formatMoney(moneyFromWire(d.credit_limit) ?? money(0n), { mode: 'compact' })}` : undefined} />
              <KpiCard label="Đã giải ngân" value={d.disbursed} sub={`Chưa giải ngân ${formatMoney(moneyFromWire(d.undisbursed) ?? money(0n), { mode: 'compact' })}`} />
              <KpiCard
                label="Đã trả gốc"
                value={d.repaid}
                sub={`Lãi ${formatMoney(moneyFromWire(d.repaid_interest) ?? money(0n), { mode: 'compact' })} · phí ${formatMoney(moneyFromWire(d.repaid_fee) ?? money(0n), { mode: 'compact' })}`}
              />
              <KpiCard label="Dư nợ" value={d.outstanding} emphasis sub={`Lãi dự kiến tới đáo hạn ${formatMoney(moneyFromWire(d.interest_to_maturity) ?? money(0n), { mode: 'compact' })}`} />
            </div>

            <FgCard title="Thông tin khoản vay" style={{ marginBottom: 'var(--fg-space-4)' }}>
              <FgDescriptions
                size="small"
                column={{ xs: 1, sm: 2, lg: 3 }}
                items={[
                  {
                    key: 'bank',
                    label: 'Ngân hàng cho vay',
                    children: d.partner_id ? (
                      <Link className="fg-link" to={`/doi-tac/${d.partner_id}`}>
                        {bankNameOf(d)}
                      </Link>
                    ) : (
                      bankNameOf(d)
                    ),
                  },
                  { key: 'company', label: 'Công ty', children: d.company_name || '—' },
                  { key: 'term', label: 'Kỳ hạn', children: d.term_months ? `${d.term_months} tháng` : '—' },
                  { key: 'period', label: 'Kỳ trả lãi / gốc', children: REPAYMENT_PERIOD_LABEL[d.payment_frequency as keyof typeof REPAYMENT_PERIOD_LABEL] ?? d.payment_frequency },
                  { key: 'method', label: 'Cách trả gốc', children: REPAYMENT_METHOD_LABEL[d.repayment_method as keyof typeof REPAYMENT_METHOD_LABEL] ?? d.repayment_method },
                  { key: 'disbursed', label: 'Ngày giải ngân', children: d.disbursed_at ? ddmmyyyy(d.disbursed_at) : '—' },
                  { key: 'contract', label: 'Số HĐ tín dụng', children: d.contract_no || '—' },
                  { key: 'collateral', label: 'Tài sản đảm bảo', children: d.collateral || '—' },
                  { key: 'responsible', label: 'Người phụ trách', children: d.responsible || '—' },
                  { key: 'note', label: 'Ghi chú', children: d.note || '—' },
                ]}
              />
            </FgCard>

            <FgCard
              title="Phiếu chi được tài trợ (chi bằng vốn vay)"
              style={{ marginBottom: 'var(--fg-space-4)' }}
            >
              {!d.chain.funded_by.length ? (
                <FgText style="caption" color="muted">
                  Khoản này không tài trợ phiếu chi nào.
                </FgText>
              ) : (
                <ChainTable
                  rows={d.chain.funded_by}
                  columns={[
                    { title: 'Phiếu chi', key: 'doc', render: (_v, r: LoanLinkRow) => docLinkCell(r) },
                    { title: 'Trạng thái', key: 'st', render: (_v, r: LoanLinkRow) => <FgToneChip tone={r.executed ? 'success' : 'neutral'}>{statusLabelVi(r.document_status)}</FgToneChip> },
                    { title: 'Số tiền', key: 'amount', align: 'right', render: (_v, r: LoanLinkRow) => <FgMoneyStack value={moneyFromWire(r.amount)} /> },
                    { title: 'Nguồn', key: 'origin', render: (_v, r: LoanLinkRow) => <OriginTag origin={{ kind: r.origin, rule_code: r.rule_code }} /> },
                    ...(canEditLoan(status) && linkPerms
                      ? [
                          {
                            title: '',
                            key: 'act',
                            render: (_v: unknown, r: LoanLinkRow) => (
                              <FgButton size="small" variant="danger" onClick={() => remove('funded_by')(r)}>
                                Gỡ
                              </FgButton>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              )}
            </FgCard>

            <FgCard
              title="Phiếu thu giải ngân"
              extra={
                canAssignDisbursement(status) && linkPerms ? (
                  <FgButton size="small" variant="primary" onClick={() => setPicker('disbursement')}>
                    + Gán phiếu giải ngân
                  </FgButton>
                ) : null
              }
              style={{ marginBottom: 'var(--fg-space-4)' }}
            >
              <div style={{ marginBottom: 8 }}>
                <FgText style="caption" color="muted">
                  Tiền giải ngân về tài khoản công ty. Phiếu đã thực thi ⇒ đã giải ngân; phiếu chờ thực thi chưa tính.
                </FgText>
              </div>
              {!d.chain.disbursements.length ? (
                <FgEmptyState glyph="◇" title="Chưa gán phiếu giải ngân" description="Gán phiếu thu cùng ngân hàng đã lập (hoặc tạo phiếu thu đi vay)." />
              ) : (
                <ChainTable
                  rows={d.chain.disbursements}
                  columns={[
                    { title: 'Phiếu thu', key: 'doc', render: (_v, r: LoanLinkRow) => docLinkCell(r) },
                    {
                      title: 'Hiệu lực',
                      key: 'eff',
                      render: (_v, r: LoanLinkRow) => (r.executed ? <FgToneChip tone="success">Đã giải ngân</FgToneChip> : <FgToneChip tone="warning">Chờ thực thi</FgToneChip>),
                    },
                    { title: 'Số tiền', key: 'amount', align: 'right', render: (_v, r: LoanLinkRow) => <FgMoneyStack value={moneyFromWire(r.amount)} /> },
                    { title: 'Nguồn', key: 'origin', render: (_v, r: LoanLinkRow) => <OriginTag origin={{ kind: r.origin, rule_code: r.rule_code }} /> },
                    ...(canEditLoan(status) && linkPerms
                      ? [
                          {
                            title: '',
                            key: 'act',
                            render: (_v: unknown, r: LoanLinkRow) => (
                              <FgButton size="small" variant="danger" onClick={() => remove('disbursement')(r)}>
                                Gỡ
                              </FgButton>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              )}
            </FgCard>

            <FgCard
              title="Phiếu chi trả nợ"
              extra={
                canAssignRepayment(status) && linkPerms ? (
                  <FgButton size="small" variant="primary" onClick={() => setPicker('repayment')}>
                    + Gán phiếu chi trả nợ
                  </FgButton>
                ) : null
              }
              style={{ marginBottom: 'var(--fg-space-4)' }}
            >
              <div style={{ marginBottom: 8 }}>
                <FgText style="caption" color="muted">
                  Chỉ phần GỐC làm giảm dư nợ; lãi và phí ghi nhận riêng. Phiếu đã thực thi mới tính.
                </FgText>
              </div>
              {!d.chain.repayments.length ? (
                <FgEmptyState glyph="◇" title="Chưa gán phiếu trả nợ nào" description="Khi phiếu chi trả nợ được thực thi, dư nợ tự trừ phần gốc." />
              ) : (
                <ChainTable
                  rows={d.chain.repayments}
                  columns={[
                    { title: 'Phiếu chi', key: 'doc', render: (_v, r: LoanLinkRow) => docLinkCell(r) },
                    {
                      title: 'Hiệu lực',
                      key: 'eff',
                      render: (_v, r: LoanLinkRow) => (r.executed ? <FgToneChip tone="success">Đã trừ dư nợ</FgToneChip> : <FgToneChip tone="warning">Chờ thực thi</FgToneChip>),
                    },
                    { title: 'Tổng', key: 'amount', align: 'right', render: (_v, r: LoanLinkRow) => <FgMoneyStack value={moneyFromWire(r.amount)} /> },
                    { title: 'Gốc', key: 'principal', align: 'right', render: (_v, r: LoanLinkRow) => <FgMoneyStack value={moneyFromWire(r.principal)} emphasis /> },
                    { title: 'Lãi', key: 'interest', align: 'right', render: (_v, r: LoanLinkRow) => <FgMoneyStack value={moneyFromWire(r.interest)} /> },
                    { title: 'Phí', key: 'fee', align: 'right', render: (_v, r: LoanLinkRow) => <FgMoneyStack value={moneyFromWire(r.fee)} /> },
                    ...(canEditLoan(status) && linkPerms
                      ? [
                          {
                            title: '',
                            key: 'act',
                            render: (_v: unknown, r: LoanLinkRow) => (
                              <FgButton size="small" variant="danger" onClick={() => remove('repayment')(r)}>
                                Gỡ
                              </FgButton>
                            ),
                          },
                        ]
                      : []),
                  ]}
                />
              )}
            </FgCard>

            <OwnerAttachmentSection base="/bank-debts" ownerId={d._id} attachments={d.attachments} onChanged={() => void query.refetch()} />

            <ChangeHistoryCard history={d.history} />

            {picker && id ? <LoanCandidateModal loanId={id} relation={picker} onClose={() => setPicker(null)} /> : null}

            {cancelOpen && id ? <CancelLoanModal loanId={id} code={d.code} onClose={() => setCancelOpen(false)} /> : null}

            {unlinking && id ? (
              <RemoveLinkModal
                title={
                  unlinking.relation === 'disbursement' ? 'Gỡ phiếu giải ngân' : unlinking.relation === 'repayment' ? 'Gỡ phiếu trả nợ' : 'Gỡ phiếu chi được tài trợ'
                }
                target={`Gỡ phiếu ${unlinking.row.document_code} khỏi khoản ${d.code}. Liên kết được đánh dấu đã gỡ, không xoá.`}
                loading={unlinking.relation === 'disbursement' ? unlinkDisb.isPending : unlinking.relation === 'repayment' ? unlinkRepay.isPending : unlinkFunded.isPending}
                onCancel={() => setUnlinking(null)}
                onConfirm={(reason) => {
                  const mut = unlinking.relation === 'disbursement' ? unlinkDisb : unlinking.relation === 'repayment' ? unlinkRepay : unlinkFunded;
                  mut.mutate(
                    { linkId: unlinking.row.link_id, reason },
                    {
                      onSuccess: () => {
                        message.success('Đã gỡ liên kết');
                        setUnlinking(null);
                      },
                      onError: (e) => message.error(problemText(e, 'Không gỡ được liên kết')),
                    },
                  );
                }}
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
                          onError: (e) => message.error(problemText(e, 'Không xoá được khoản nợ')),
                        })
                      }
                    >
                      Xoá
                    </FgButton>
                  </>
                }
              >
                <FgText style="body">
                  Xoá khoản <strong>{d.code} · {bankNameOf(d)}</strong>? Chỉ xoá được khoản chờ giải ngân chưa có liên kết nào. Khoản đã đang vay hoặc đã có liên kết
                  thì không xoá (dùng Huỷ khi chờ giải ngân, hoặc Lưu trữ khi đã tất toán).
                </FgText>
              </FgModal>
            ) : null}
          </>
        );
      }}
    </FgQuery>
  );
}

/* ============================== lịch trả nợ (LOAN-04) ============================== */

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
            meta={`Kỳ hạn ${d.term_months} tháng · lãi suất ${interestRateText(d.interest_rate)}%/năm · ${
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
            <KpiCard label="Tổng gốc" value={d.totals.principal} />
            <KpiCard label="Tổng lãi" value={d.totals.interest} />
            <KpiCard label="Tổng phải trả" value={d.totals.total} emphasis />
          </div>
          <div className="fg-card" style={{ padding: 0 }}>
            <FgTable
              rowKey="period"
              dataSource={d.rows}
              columns={[
                { title: 'Kỳ', dataIndex: 'period', key: 'p' },
                { title: 'Ngày đến hạn', dataIndex: 'due_date', key: 'd', render: (v: string) => ddmmyyyy(v) },
                { title: 'Số ngày', dataIndex: 'days', key: 'days', align: 'right' },
                { title: 'Gốc', dataIndex: 'principal', key: 'pr', align: 'right', render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} /> },
                { title: 'Lãi', dataIndex: 'interest', key: 'in', align: 'right', render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} /> },
                { title: 'Phí', dataIndex: 'fee', key: 'fe', align: 'right', render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} /> },
                { title: 'Cộng', dataIndex: 'total', key: 'to', align: 'right', render: (v: MoneyWire) => <FgMoneyStack value={moneyFromWire(v)} emphasis /> },
                { title: 'Trạng thái', dataIndex: 'status', key: 'st', render: (v: string) => SCHEDULE_STATUS_LABEL[v] ?? v },
              ]}
            />
          </div>
        </>
      )}
    </FgQuery>
  );
}

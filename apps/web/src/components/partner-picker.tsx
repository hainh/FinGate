/**
 * FinGate web — ô chọn đối tác dùng chung (v2/v2.md §5.2) + popup tạo/sửa đối tác (§5.1, §5.3).
 *
 * - Ô chỉ nhận MỘT đối tác đã tồn tại (lưu `partner_id`). Gõ để tìm theo tên / STK / MST; lọc sẵn theo
 *   `allowedTypes` và công ty; chỉ đối tác "Hoạt động" được chọn.
 * - "+ Tạo đối tác": popup mở NGAY trên form (portal antd, không điều hướng, không mất dữ liệu form cha).
 *   Loại điền sẵn theo ngữ cảnh (nhiều loại → người dùng chọn); chữ đang gõ điền sẵn vào Tên.
 *   Lưu xong → đối tác được chọn sẵn. Huỷ → ô giữ nguyên (thường là trống).
 * - Cảnh báo trùng (tên / ngân hàng + STK) KHÔNG chặn lưu: hiện thông báo sau khi lưu (notifyPartnerWarnings).
 * - Ngân hàng / STK / MST hiển thị CHỈ ĐỌC bên dưới ô; "Sửa đối tác" mở popup sửa (áp dụng cho mọi nơi dùng).
 */

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Divider, Select } from 'antd';
import {
  PARTNER_STATUSES,
  PARTNER_STATUS_LABEL,
  PARTNER_TYPE_LABEL,
  PARTNER_TYPES,
  UI,
  type PartnerDuplicateCheckBody,
  type PartnerDuplicateWarning,
  type PartnerRef,
  type PartnerStatus,
  type PartnerType,
} from '@fingate/shared';
import { ApiRequestError, uuid } from '../app/api.ts';
import { useAuth } from '../app/store.tsx';
import {
  partnerOptionsEmptyState,
  useCreatePartner,
  usePartner,
  usePartnerDuplicateCheck,
  usePartnerOptions,
  useUpdatePartner,
  type PartnerDetailData,
  type PartnerSaveResult,
  type PartnerWriteBody,
} from '../app/v2/partners.ts';
import { useDebounced, useToast } from './pagekit.tsx';
import { detailForValue, isSearchSettled, needsSelectedOption } from './partner-picker-options.ts';
import { FgAlert, FgButton, FgField, FgInput, FgText, FgTextarea, FgTooltip } from './primitives.tsx';
import { FgModal, FgSegmented } from './uitk.tsx';

const ALL_TYPES: PartnerType[] = [...PARTNER_TYPES];

/** Các loại được phép theo ngữ cảnh (rỗng = mọi loại), giữ thứ tự Ngân hàng · Khách hàng · NCC. */
export function partnerTypesFor(allowed?: PartnerType[] | null): PartnerType[] {
  return ALL_TYPES.filter((t) => !allowed || allowed.length === 0 || allowed.includes(t));
}

/* ================= thông báo cảnh báo trùng ================= */

/** Cảnh báo trùng KHÔNG chặn: sau khi lưu thành công, liệt kê đối tác trùng để người dùng xem lại. */
export function notifyPartnerWarnings(notification: ReturnType<typeof useToast>['notification'], warnings: PartnerDuplicateWarning[]): void {
  if (!warnings.length) return;
  notification.warning({
    message: 'Cảnh báo trùng đối tác — đối tác vẫn đã được lưu',
    description: (
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {warnings.map((w) => (
          <li key={`${w.reason}-${w.partner_id}`}>
            {w.message}: {w.partner_code} · {w.partner_name} ({PARTNER_TYPE_LABEL[w.partner_type]})
          </li>
        ))}
      </ul>
    ),
    duration: 10,
  });
}

/* ================= popup tạo / sửa đối tác ================= */

/** Dạng đối tác đã có để sửa (khớp PartnerListRow / PartnerDetailData). */
export interface PartnerFormEditing {
  _id: string;
  type: PartnerType;
  name: string;
  bank_name: string | null;
  account_number: string | null;
  tax_code: string | null;
  note?: string | null;
  status: PartnerStatus;
}

export interface PartnerFormModalProps {
  /** Đối tác đang sửa; bỏ trống = tạo mới. */
  editing?: PartnerFormEditing | null;
  /** Loại được phép khi TẠO: một loại → cố định; nhiều loại → người dùng chọn. Bỏ trống = mọi loại. */
  allowedTypes?: PartnerType[];
  /** Loại điền sẵn khi tạo (mặc định: loại đầu tiên được phép). */
  defaultType?: PartnerType;
  /** Tên điền sẵn khi tạo (chữ đang gõ trong ô tìm). */
  initialName?: string;
  /** Công ty tạo đối tác (bỏ trống = công ty đang làm việc). */
  companyId?: string | null;
  title?: string;
  onClose: () => void;
  /** Lưu thành công: đối tác (đã có ID) + cảnh báo trùng (không chặn). */
  onSaved: (result: PartnerSaveResult) => void;
}

/**
 * Popup tạo / sửa đối tác. Dùng lại được ở mọi nơi (ô chọn, màn Đối tác).
 * Antd Modal render qua portal nên form cha không bị mất trạng thái.
 */
export function PartnerFormModal({
  editing,
  allowedTypes,
  defaultType,
  initialName,
  companyId,
  title,
  onClose,
  onSaved,
}: PartnerFormModalProps): ReactNode {
  const isEdit = !!editing;
  const types = isEdit ? ALL_TYPES : partnerTypesFor(allowedTypes);
  // loại điền sẵn: theo ngữ cảnh; không có → Khách hàng (nếu được phép), rồi loại đầu tiên
  const fallbackType: PartnerType = types.includes('customer') ? 'customer' : (types[0] ?? 'customer');
  const [type, setType] = useState<PartnerType>(editing?.type ?? (defaultType && types.includes(defaultType) ? defaultType : fallbackType));
  const [name, setName] = useState(editing?.name ?? initialName ?? '');
  const [bankName, setBankName] = useState(editing?.bank_name ?? '');
  const [accountNumber, setAccountNumber] = useState(editing?.account_number ?? '');
  const [taxCode, setTaxCode] = useState(editing?.tax_code ?? '');
  const [note, setNote] = useState(editing?.note ?? '');
  const [status, setStatus] = useState<PartnerStatus>(editing?.status ?? 'active');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ title: string; detail?: string } | null>(null);
  const create = useCreatePartner();
  const update = useUpdatePartner();
  const { message } = useToast();
  const busy = create.isPending || update.isPending;
  // một lần mở popup = một request_id: bấm lặp / gửi lại sau lỗi mạng không tạo đối tác thứ hai
  const [requestId] = useState(() => uuid());
  // kiểm trùng TRƯỚC khi lưu (không chặn): debounce khi đang gõ, loại trừ chính đối tác đang sửa
  const dupText = JSON.stringify({ name: name.trim(), bank: bankName.trim(), account: accountNumber.trim() });
  const dupTextDebounced = useDebounced(dupText, 500);
  const dupInput = useMemo<PartnerDuplicateCheckBody | null>(() => {
    const t = JSON.parse(dupTextDebounced) as { name: string; bank: string; account: string };
    if (t.name.length < 2 && !(t.bank && t.account)) return null;
    return {
      company_id: companyId ?? undefined,
      name: t.name,
      bank_name: t.bank || null,
      account_number: t.account || null,
      exclude_id: editing?._id ?? null,
    };
  }, [dupTextDebounced, companyId, editing?._id]);
  const dupCheck = usePartnerDuplicateCheck(dupInput);
  // cảnh báo chỉ hiện khi đã kiểm ĐÚNG nội dung đang có: đang chờ debounce / đang kiểm tên mới ⇒ không hiện cảnh báo của chữ cũ
  const dupWarnings = dupText === dupTextDebounced ? (dupCheck.data?.warnings ?? []) : [];

  const submit = async (): Promise<void> => {
    const trimmedName = name.trim();
    const errs: Record<string, string> = {};
    if (trimmedName.length < 2) errs.name = 'Tên đối tác tối thiểu 2 ký tự';
    else if (trimmedName.length > 200) errs.name = 'Tên đối tác tối đa 200 ký tự';
    if (bankName.trim().length > 200) errs.bank_name = 'Tên ngân hàng tối đa 200 ký tự';
    if (accountNumber.trim().length > 40) errs.account_number = 'Số tài khoản tối đa 40 ký tự';
    if (taxCode.trim().length > 20) errs.tax_code = 'Mã số thuế tối đa 20 ký tự';
    if (note.length > 2000) errs.note = 'Ghi chú tối đa 2000 ký tự';
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;

    const body: PartnerWriteBody = {
      type,
      name: trimmedName,
      bank_name: bankName.trim() || null,
      account_number: accountNumber.trim() || null,
      tax_code: taxCode.trim() || null,
      note: note.trim() || null,
    };
    try {
      const result = editing
        ? await update.mutateAsync({ id: editing._id, body: { ...body, status } })
        : await create.mutateAsync({ ...body, company_id: companyId ?? undefined, request_id: requestId });
      message.success(editing ? 'Đã lưu đối tác' : 'Đã tạo đối tác');
      onSaved(result);
    } catch (e) {
      if (e instanceof ApiRequestError) {
        if (e.problem.errors) setErrors(e.problem.errors);
        setFormError({ title: e.problem.title, detail: e.problem.detail });
      } else {
        setFormError({ title: 'Không lưu được đối tác' });
      }
    }
  };

  return (
    <FgModal
      open
      title={title ?? (editing ? `Sửa đối tác — ${editing.name}` : 'Tạo đối tác')}
      onCancel={busy ? undefined : onClose}
      width={640}
      footer={
        <>
          <FgButton onClick={onClose} disabled={busy}>
            Hủy
          </FgButton>
          <FgButton variant="primary" loading={busy} onClick={() => void submit()}>
            {editing ? 'Lưu thay đổi' : 'Tạo đối tác'}
          </FgButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--fg-space-4)' }}>
        {formError ? <FgAlert tone="danger" title={formError.title} description={formError.detail} /> : null}

        {dupWarnings.length ? (
          <FgAlert
            tone="attention"
            title="Có thể trùng với đối tác đã có — vẫn lưu được"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {dupWarnings.map((w) => (
                  <li key={`${w.reason}-${w.partner_id}`}>
                    {w.message}: {w.partner_code} · {w.partner_name} ({PARTNER_TYPE_LABEL[w.partner_type]})
                  </li>
                ))}
              </ul>
            }
          />
        ) : null}

        <FgField
          label="Loại đối tác"
          required
          help={isEdit ? 'Đổi loại bị chặn nếu đối tác đã có khoản liên quan làm vỡ ràng buộc (VD khoản nợ NH).' : undefined}
        >
          {types.length > 1 ? (
            <FgSegmented
              value={type}
              onChange={(v) => setType(v as PartnerType)}
              options={types.map((t) => ({ value: t, label: PARTNER_TYPE_LABEL[t] }))}
            />
          ) : (
            <FgText style="body" strong>
              {PARTNER_TYPE_LABEL[type]}
            </FgText>
          )}
        </FgField>

        <FgField
          label="Tên đối tác"
          required
          error={errors.name}
          help={type === 'bank' ? 'Với Ngân hàng: tên ngân hàng + chi nhánh cho vay, VD “BIDV – CN Đông Đô”.' : undefined}
        >
          <FgInput
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={type === 'bank' ? 'VD: BIDV – CN Đông Đô' : 'VD: Công ty TNHH ABC'}
            maxLength={200}
            autoFocus
          />
        </FgField>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 'var(--fg-space-4)' }}>
          <FgField
            label="Ngân hàng"
            error={errors.bank_name}
            help={type === 'bank' ? 'Có thể bỏ trống nếu đã ghi trong tên đối tác.' : 'Ngân hàng nơi đối tác nhận / chuyển tiền.'}
          >
            <FgInput value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="VD: Vietcombank" />
          </FgField>
          <FgField label="Số tài khoản" error={errors.account_number}>
            <FgInput value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="VD: 0123456789" />
          </FgField>
          <FgField label="Mã số thuế" error={errors.tax_code}>
            <FgInput value={taxCode} onChange={(e) => setTaxCode(e.target.value)} placeholder="VD: 0101234567" />
          </FgField>
          {isEdit ? (
            <FgField label="Trạng thái" help="Ngừng giao dịch: không chọn được cho phiếu mới; dữ liệu cũ giữ nguyên.">
              <FgSegmented
                value={status}
                onChange={(v) => setStatus(v as PartnerStatus)}
                options={PARTNER_STATUSES.map((s) => ({ value: s, label: PARTNER_STATUS_LABEL[s] }))}
              />
            </FgField>
          ) : null}
        </div>

        <FgField label="Ghi chú" error={errors.note}>
          <FgTextarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        </FgField>
      </div>
    </FgModal>
  );
}

/* ================= ô chọn đối tác ================= */

type PickerOption = {
  value: string;
  label: ReactNode;
  /** Nhãn ngắn hiển thị trong ô khi đã chọn (optionLabelProp). */
  displayLabel: string;
  partner?: PartnerRef;
};

function PartnerOptionLabel({ p }: { p: PartnerRef }): ReactNode {
  const sub = [PARTNER_TYPE_LABEL[p.type], p.bank_name, p.account_number, p.tax_code ? `MST ${p.tax_code}` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.35 }}>
      <span>
        {p.name}
        {p.status === 'inactive' ? ' (ngừng giao dịch)' : ''}
      </span>
      <span style={{ fontSize: 12, color: 'var(--fg-text-muted)' }}>{sub}</span>
    </span>
  );
}

/** Thông tin ngân hàng / STK / MST — CHỈ ĐỌC, lấy từ đối tác hiện tại (v2 §5.2). */
function PartnerReadonly({ p }: { p: PartnerRef }): ReactNode {
  // gộp "Ngân hàng - Số tài khoản" thành một mục; MST không hiện ở đây
  const account = [p.bank_name, p.account_number].filter(Boolean).join(' - ');
  const parts: ReactNode[] = account ? [<span key="acc" className="fg-num">Tài khoản: {account}</span>] : [];
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 'var(--fg-space-3)',
        fontSize: 'var(--fg-font-caption-size)',
        lineHeight: 'var(--fg-font-caption-line)',
        color: 'var(--fg-text-secondary)',
      }}
    >
      {parts.length ? parts : <span>Chưa có tài khoản ngân hàng</span>}
      {p.status === 'inactive' ? (
        <span style={{ color: 'var(--fg-status-danger-text)' }}>{PARTNER_STATUS_LABEL.inactive} — không dùng cho phiếu mới</span>
      ) : null}
    </div>
  );
}

/** Lỗi tải danh sách gợi ý (thay cho "Không có đối tác phù hợp" trong dropdown) + nút thử lại. */
function PartnerOptionsError({ onRetry }: { onRetry: () => void }): ReactNode {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--fg-space-2)', padding: '8px 12px' }}>
      <span style={{ color: 'var(--fg-status-danger-text)' }}>Không tải được danh sách đối tác.</span>
      <FgButton
        size="small"
        variant="text"
        // giữ focus ở ô tìm (cùng lý do với nút trong chân dropdown)
        onMouseDown={(e) => e.preventDefault()}
        onClick={onRetry}
      >
        Thử lại
      </FgButton>
    </div>
  );
}

export interface PartnerPickerProps {
  /** partner_id đang chọn (null = chưa chọn). */
  value: string | null;
  /**
   * Chọn / bỏ chọn. `partner` có khi vừa chọn từ danh sách, vừa tạo mới, hoặc vừa sửa (bản mới nhất của đối tác,
   * gọi với cùng `id` để form cha cập nhật loại / tên / NH / STK đang hiển thị).
   */
  onChange: (id: string | null, partner?: PartnerRef) => void;
  /** Loại hợp lệ của chỗ đang dùng (VD khoản nợ NH chỉ `['bank']`). */
  allowedTypes: PartnerType[];
  /** Công ty của chứng từ — chỉ tìm và tạo trong công ty này. */
  companyId: string | null | undefined;
  /** Khoá toàn bộ (chọn, tạo, sửa). */
  disabled?: boolean;
  /**
   * Chỉ khoá việc CHỌN đối tác (VD khoản đã có cấn trừ / giải ngân không đổi đối tác);
   * vẫn cho "Sửa đối tác" / "+ Tạo đối tác" nếu người dùng có `partner:write` (v2 §5.1).
   */
  lockSelection?: boolean;
  required?: boolean;
  label?: string;
  /** Lỗi do form cha kiểm tra (hiển thị dưới ô). */
  error?: string | null;
  /** Loại điền sẵn khi tạo (mặc định: loại đầu tiên trong allowedTypes). */
  defaultType?: PartnerType;
  placeholder?: string;
}

/**
 * Ô chọn đối tác. Chỉ chọn đối tác đã có; tạo / sửa qua popup ngay trên form.
 */
export function PartnerPicker({
  value,
  onChange,
  allowedTypes,
  companyId,
  disabled,
  lockSelection,
  required,
  label = 'Đối tác',
  error,
  defaultType,
  placeholder,
}: PartnerPickerProps): ReactNode {
  const types = partnerTypesFor(allowedTypes);
  const { can } = useAuth();
  const canWritePartner = can('partner:write');
  const { notification } = useToast();
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 300);
  const options = usePartnerOptions({
    type: types,
    company_id: companyId ?? undefined,
    q: q || undefined,
    status: 'active',
    limit: 20,
  });
  const current = usePartner(value);
  // chi tiết CỦA đối tác đang chọn (không phải của đối tác trước còn trong bộ nhớ khi đang tải đối tác mới)
  const selected: PartnerDetailData | undefined = detailForValue(value, current.data);
  const [dialog, setDialog] = useState<'create' | 'edit' | null>(null);
  const [createName, setCreateName] = useState('');
  // chữ đang gõ được chụp khi người dùng chuyển sang nút "+ Tạo đối tác" (xem rememberTyped)
  const typedForCreate = useRef('');
  // dropdown do ta điều khiển: mở popup tạo/sửa thì phải đóng dropdown (không được đè lên popup)
  const [open, setOpen] = useState(false);
  // đối tác vừa chọn / vừa tạo: hiển thị ngay, không chờ tải chi tiết
  const [known, setKnown] = useState<PartnerRef | null>(null);
  const cached = known && known._id === value ? known : undefined;
  const shown: PartnerRef | undefined = selected ?? cached;

  // chữ đang gõ. Kết quả server chỉ đúng với chữ này khi đã qua debounce; trước đó là kết quả của chữ cũ ⇒ không hiện
  const typed = search.trim();
  const settled = isSearchSettled(typed, q);
  const results = settled ? (options.data?.items ?? []) : [];
  const listed: PickerOption[] = results.map((p) => ({
    value: p._id,
    label: <PartnerOptionLabel p={p} />,
    displayLabel: p.name,
    partner: p,
  }));
  // đối tác đang chọn → vẫn có nhãn khi KHÔNG gõ mà chưa có trong kết quả (vd. form mở sẵn partner_id).
  // Đang gõ thì không thêm, để không đứng đầu / được tô sáng khi không khớp chữ gõ (xem needsSelectedOption)
  const missingLabel = current.isError ? 'Không tải được đối tác' : 'Đang tải…';
  const missing: PickerOption[] =
    value && needsSelectedOption(typed, value, results.map((p) => p._id))
      ? [
          {
            value,
            label: shown ? <PartnerOptionLabel p={shown} /> : <span>{missingLabel}</span>,
            displayLabel: shown?.name ?? missingLabel,
            partner: shown,
          },
        ]
      : [];
  const allOptions: PickerOption[] = [...missing, ...listed];
  // danh sách trống: đang chờ debounce / đang tải ⇒ "Đang tìm…"; LỖI tải (không báo là "không có đối tác"); thật sự không khớp
  const emptyState = settled ? partnerOptionsEmptyState(options) : 'loading';
  const emptyContent: ReactNode =
    emptyState === 'loading' ? (
      'Đang tìm…'
    ) : emptyState === 'error' ? (
      <PartnerOptionsError onRetry={() => void options.refetch()} />
    ) : (
      'Không có đối tác phù hợp'
    );

  // Chọn / bỏ chọn: xoá chữ đang gõ trong ô tìm. Ô tìm do `search` điều khiển (searchValue), nên xoá state
  // là xoá luôn chữ hiển thị — và "+ Tạo đối tác" không còn điền lại tên đối tác vừa bỏ.
  const handleChange = (v: string | undefined): void => {
    setSearch('');
    if (!v) {
      setKnown(null);
      onChange(null);
      return;
    }
    const hit = allOptions.find((o) => o.value === v);
    setKnown(hit?.partner ?? null);
    onChange(v, hit?.partner);
  };

  // Nhấn chuột (hoặc Tab tới) nút "+ Tạo đối tác" ⇒ chụp chữ đang gõ NGAY, trước khi ô tìm mất focus.
  // Lý do: nút nằm ngoài ô chọn nên rc-select đóng dropdown rồi XOÁ ô tìm (search = '') sau một macrotask;
  // đọc `search` lúc click (sau khi nhấn giữ chuột) sẽ rỗng và Tên popup trống (v2/v2.md §5.2).
  const rememberTyped = (): void => {
    typedForCreate.current = search.trim();
  };

  const openCreate = (): void => {
    setCreateName(typedForCreate.current);
    typedForCreate.current = '';
    // mở popup: đóng dropdown và xoá chữ trong ô tìm (đã chuyển thành Tên ở trên)
    setSearch('');
    setOpen(false);
    setDialog('create');
  };

  const closeDialog = (): void => setDialog(null);

  return (
    <FgField label={label} required={required} error={error}>
      <div style={{ display: 'flex', gap: 'var(--fg-space-2)', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Select
            showSearch
            allowClear
            filterOption={false}
            optionLabelProp="displayLabel"
            value={value ?? undefined}
            placeholder={placeholder ?? UI.partner.pickPlaceholder}
            options={allOptions}
            // ô tìm do state này giữ (không để rc-select tự giữ): khớp với chữ dùng cho "+ Tạo đối tác"
            searchValue={search}
            onSearch={setSearch}
            onChange={handleChange}
            // Enter khi KHÔNG có dòng nào để chọn (đang tìm / không khớp / lỗi tải): rc-select sẽ đóng danh sách và xoá
            // chữ đang gõ. Giữ lại để kết quả về sau đó, Enter chọn đúng dòng được tô sáng (v2/v2.md §5.2 "Gõ để tìm").
            onInputKeyDown={(e) => {
              if (e.key === 'Enter' && open && allOptions.length === 0 && !e.nativeEvent.isComposing) {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
            // đóng dropdown khi popup tạo/sửa đang mở (dropdown không được đè lên popup)
            open={open && dialog === null}
            onOpenChange={setOpen}
            loading={options.isFetching}
            disabled={disabled || lockSelection}
            status={error ? 'error' : undefined}
            notFoundContent={emptyContent}
            popupRender={(menu) => (
              <>
                {menu}
                <Divider style={{ margin: '4px 0' }} />
                <div style={{ padding: 4 }}>
                  <FgButton
                    variant="text"
                    block
                    disabled={disabled || !canWritePartner}
                    // giữ focus ở ô tìm để không mất chữ đang gõ khi bấm nút; chụp chữ trước khi click
                    onMouseDown={(e) => {
                      e.preventDefault();
                      rememberTyped();
                    }}
                    onClick={openCreate}
                  >
                    {search.trim() ? UI.partner.addNew(search.trim()) : '+ Tạo đối tác'}
                  </FgButton>
                </div>
              </>
            )}
            style={{ width: '100%' }}
          />
        </div>
        {/* nút chỉ có icon; nhãn hiện ở tooltip (span bọc để tooltip vẫn hiện khi nút bị khoá) */}
        {value ? (
          <FgTooltip title="Sửa đối tác">
            <span style={{ display: 'inline-flex' }}>
              <FgButton
                icon={<EditOutlined />}
                aria-label="Sửa đối tác"
                disabled={disabled || !selected || !canWritePartner}
                onClick={() => setDialog('edit')}
              />
            </span>
          </FgTooltip>
        ) : (
          <FgTooltip title="Tạo đối tác">
            <span style={{ display: 'inline-flex' }}>
              <FgButton
                icon={<PlusOutlined />}
                aria-label="Tạo đối tác"
                disabled={disabled || !canWritePartner}
                // chụp chữ đang gõ khi nhấn chuột / Tab tới nút — trước khi rc-select xoá ô tìm (xem rememberTyped)
                onMouseDown={rememberTyped}
                onFocus={rememberTyped}
                onClick={openCreate}
              />
            </span>
          </FgTooltip>
        )}
      </div>

      {value ? (
        <div style={{ marginTop: 6 }}>
          {shown ? (
            <PartnerReadonly p={shown} />
          ) : (
            <FgText style="caption" color="muted">
              {current.isError ? 'Không tải được thông tin đối tác.' : 'Đang tải thông tin đối tác…'}
            </FgText>
          )}
        </div>
      ) : null}

      {dialog === 'create' ? (
        <PartnerFormModal
          allowedTypes={types}
          defaultType={defaultType}
          initialName={createName}
          companyId={companyId}
          onClose={closeDialog}
          onSaved={(r) => {
            setDialog(null);
            notifyPartnerWarnings(notification, r.warnings);
            setKnown(r.partner);
            onChange(r.partner._id, r.partner);
          }}
        />
      ) : null}
      {dialog === 'edit' && selected ? (
        <PartnerFormModal
          editing={selected}
          companyId={companyId}
          onClose={closeDialog}
          onSaved={(r) => {
            setDialog(null);
            notifyPartnerWarnings(notification, r.warnings);
            // Đối tác vừa sửa áp dụng cho mọi nơi đang dùng (v2 §5.1): bản chụp ở ô và form cha phải nhận bản mới
            // (loại / tên / NH / STK). Không báo cho form cha thì loại cũ còn được dùng (VD quy tắc đi vay, §11.4).
            setKnown(r.partner);
            onChange(r.partner._id, r.partner);
          }}
        />
      ) : null}
    </FgField>
  );
}

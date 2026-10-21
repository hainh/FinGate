/**
 * FinGate web — ô tag v2 (v2/v2.md §6.2). Dùng chung:
 * - TagInput: gắn nhiều tag lên phiếu. Gõ để tìm; chưa có tên → dòng "+ Tạo tag “…”" (cần `tag:create`).
 * - TagFilter: lọc danh sách / báo cáo theo tag của một công ty (chỉ chọn, không tạo).
 * - TagPicker: chọn đúng một tag (vd tag đích khi gộp).
 * - TagChips: hiển thị chỉ đọc (tên + màu). TagChip: một chip, dùng lại ở mọi nơi.
 *
 * Tag không dùng chung giữa các công ty: mọi thành phần nhận `companyId`.
 * Màu chỉ là gợi ý thị giác: chip luôn kèm tên, không dùng màu làm dấu hiệu duy nhất (DS §3.4).
 */

import { useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Select } from 'antd';
import { UI, tagName, type TagRow } from '@fingate/shared';
import { useAuth } from '../app/store.tsx';
import {
  CREATE_TAG_TOKEN,
  findTagByName,
  problemOf,
  tagColorOf,
  tagMatchesSearch,
  useCompanyTags,
  useCreateTag,
  type TagRef,
} from '../app/v2/tags.ts';
import { useToast } from './pagekit.tsx';

/* ================= chip ================= */

export interface TagChipProps {
  name: string;
  color?: string | null;
  /** Tag đã ẩn: thêm nhãn "Đã ẩn" (phiếu cũ vẫn giữ tag). */
  hidden?: boolean;
  /** Không tra được trong danh bạ (đang tải hoặc đã xoá). */
  muted?: boolean;
  /** Có nút ✕ (ô chọn). */
  onClose?: (e?: ReactMouseEvent<HTMLElement>) => void;
}

export function TagChip({ name, color, hidden, muted, onClose }: TagChipProps): ReactNode {
  const c = tagColorOf(color);
  const style: CSSProperties = muted
    ? { background: 'var(--fg-bg-subtle)', borderColor: 'var(--fg-border-default)', color: 'var(--fg-text-muted)' }
    : { background: `${c}1f`, borderColor: c, color: 'var(--fg-text-primary)' };
  return (
    <span className="fg-chip" style={{ ...style, maxWidth: '100%' }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: muted ? 'var(--fg-border-strong)' : c, flex: 'none' }} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {hidden ? <span style={{ color: 'var(--fg-text-muted)', flex: 'none' }}>· Đã ẩn</span> : null}
      {onClose ? (
        <button
          type="button"
          aria-label={`Bỏ tag ${name}`}
          // giữ focus trong ô chọn, không mở lại danh sách khi bấm ✕
          onMouseDown={(e) => e.preventDefault()}
          onClick={onClose}
          style={{ all: 'unset', cursor: 'pointer', color: 'var(--fg-text-muted)', lineHeight: 1, paddingInline: 2, flex: 'none' }}
        >
          ✕
        </button>
      ) : null}
    </span>
  );
}

/** Nhãn cho tag không tra được trong danh bạ: rõ lý do (chưa chọn công ty / lỗi tải / đang tải / đã xoá). */
function missingTagLabel(companyId: string | null, isPending: boolean, isError: boolean): string {
  if (!companyId) return 'Chưa chọn công ty';
  if (isError) return 'Không tải được tag';
  if (isPending) return 'Đang tải…';
  return 'Tag không còn tồn tại';
}

/* ================= ô chọn nhiều (nền chung) ================= */

interface TagOption {
  value: string;
  label: string;
  /** Tag thật trong danh bạ. */
  tag?: TagRow;
  /** Tên sẽ tạo (dòng "+ Tạo tag …"). */
  create?: string;
}

/** Một dòng gợi ý: chấm màu + tên + (đã ẩn) + số phiếu đang gắn. */
function renderTagOption(d: TagOption): ReactNode {
  if (d.create !== undefined) {
    return <span style={{ color: 'var(--fg-action-primary)', fontWeight: 500 }}>{UI.tag.create(d.create)}</span>;
  }
  const t = d.tag;
  if (!t) return d.label;
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
      <span aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', background: tagColorOf(t.color), flex: 'none' }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{t.name}</span>
      {t.hidden ? <span style={{ color: 'var(--fg-text-muted)', flex: 'none' }}>· Đã ẩn</span> : null}
      <span style={{ marginLeft: 'auto', color: 'var(--fg-text-muted)', fontSize: 'var(--fg-font-caption-size)', flex: 'none', fontVariantNumeric: 'tabular-nums' }}>
        {t.usage_count} phiếu
      </span>
    </span>
  );
}

interface TagSelectProps {
  companyId: string | null;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  maxCount?: number;
  maxTagCount?: number | 'responsive';
  /** Cho phép "+ Tạo tag" (bên gọi quyết định theo quyền `tag:create`). */
  allowCreate: boolean;
  /** Gợi ý cả tag đã ẩn. TagInput mặc định ẩn; tag đã gắn vẫn hiện để không mất nhãn. */
  includeHidden: boolean;
  /** Tag đã gắn trên phiếu (vd `documentDetail.tags`): nguồn tên/màu phụ khi danh bạ không trả tag đó. */
  knownTags?: readonly TagRef[];
  style?: CSSProperties;
}

function TagSelect({
  companyId,
  value,
  onChange,
  disabled,
  placeholder,
  ariaLabel,
  maxCount,
  maxTagCount,
  allowCreate,
  includeHidden,
  knownTags,
  style,
}: TagSelectProps): ReactNode {
  const { message } = useToast();
  const tagsQ = useCompanyTags(companyId);
  const createTag = useCreateTag(companyId);
  const [search, setSearch] = useState('');
  // Giá trị MỚI NHẤT của ô: lúc tạo tag xong (POST đang chạy) người dùng có thể đã chọn thêm tag khác.
  const valueRef = useRef(value);
  valueRef.current = value;
  const tags = tagsQ.data;
  // Gõ thừa khoảng trắng: bỏ đầu/cuối và gộp khoảng trắng giữa các từ.
  const typed = search.trim().replace(/\s+/g, ' ');
  const exact = tags && typed ? findTagByName(tags, typed) : undefined;
  const nameCheck = tagName.safeParse(typed);
  const canCreate = allowCreate && !!companyId && !!tags && !exact && nameCheck.success;
  // Tra tên/màu của tag đã gắn: danh bạ (mới nhất) trước, rồi tag trên phiếu. Người không có
  // quyền quản lý tag không thấy tag đã ẩn trong danh bạ nên cần nguồn thứ hai.
  const byId = useMemo(() => {
    const m = new Map<string, TagRef>();
    for (const t of knownTags ?? []) m.set(t._id, t);
    for (const t of tags ?? []) m.set(t._id, t);
    return m;
  }, [tags, knownTags]);

  const options = useMemo<TagOption[]>(() => {
    const list: TagOption[] = (tags ?? [])
      .filter((t) => includeHidden || !t.hidden || value.includes(t._id))
      .filter((t) => tagMatchesSearch(t, typed))
      .map((t) => ({ value: t._id, label: t.name, tag: t }));
    if (canCreate) list.push({ value: CREATE_TAG_TOKEN + typed, label: UI.tag.create(typed), create: typed });
    return list;
  }, [tags, includeHidden, value, typed, canCreate]);

  const handleChange = (vals: string[]) => {
    const token = vals.find((v) => v.startsWith(CREATE_TAG_TOKEN));
    const ids = vals.filter((v) => !v.startsWith(CREATE_TAG_TOKEN));
    if (!token) {
      onChange(ids);
      return;
    }
    const name = token.slice(CREATE_TAG_TOKEN.length);
    setSearch('');
    if (maxCount !== undefined && ids.length >= maxCount) {
      message.warning(`Tối đa ${maxCount} tag cho mỗi phiếu`);
      return;
    }
    createTag.mutate(
      { name },
      {
        onSuccess: ({ tag }) => {
          // Đọc danh sách hiện tại (KHÔNG dùng `ids` chụp lúc chọn) để không ghi đè tag vừa chọn trong lúc chờ.
          // Trùng tên đang hiện → server trả chính tag đó (created = false): không thêm trùng id.
          if (!tag?._id) return;
          const latest = valueRef.current.filter((v) => !v.startsWith(CREATE_TAG_TOKEN));
          if (!latest.includes(tag._id)) onChange([...latest, tag._id]);
        },
        onError: (e) => {
          // Tên đã có nhưng đang ẩn (FG-TAG-001): server đã nói rõ cần kế toán trưởng hiện lại.
          // (Tên đang hiện thì server trả chính tag đó — không vào nhánh lỗi.)
          const p = problemOf(e);
          if (p?.code === 'FG-TAG-001') message.warning(p.detail ?? 'Tag này đã có nhưng đang ẩn');
          else message.error(p?.detail ?? p?.title ?? 'Không tạo được tag');
        },
      },
    );
  };

  const notFound = (() => {
    if (!companyId) return 'Chọn công ty trước';
    if (tagsQ.isError) return 'Không tải được danh sách tag';
    if (!tags) return 'Đang tải tag…';
    if (typed && !nameCheck.success) return nameCheck.error.issues[0]?.message ?? 'Tên tag không hợp lệ';
    if (exact?.hidden && !value.includes(exact._id)) return `Tag “${exact.name}” đã ẩn — nhờ Kế toán trưởng hiện lại nếu cần dùng`;
    if (typed) return 'Không có tag phù hợp';
    return allowCreate ? 'Chưa có tag nào — gõ tên để tạo' : 'Chưa có tag nào';
  })();

  return (
    <Select<string[], TagOption>
      mode="multiple"
      aria-label={ariaLabel}
      value={value}
      onChange={handleChange}
      options={options}
      optionRender={(opt) => renderTagOption(opt.data)}
      tagRender={({ value: v, closable, onClose, disabled: off }) => {
        const t = byId.get(String(v));
        return (
          <span style={{ display: 'inline-flex', margin: '2px 4px 2px 0', maxWidth: '100%' }}>
            <TagChip
              name={t ? t.name : missingTagLabel(companyId, tagsQ.isPending, tagsQ.isError)}
              color={t?.color}
              hidden={t?.hidden}
              muted={!t}
              onClose={closable && !off ? onClose : undefined}
            />
          </span>
        );
      }}
      showSearch
      onSearch={setSearch}
      filterOption={false}
      notFoundContent={notFound}
      placeholder={placeholder}
      disabled={disabled || !companyId}
      maxCount={maxCount}
      maxTagCount={maxTagCount}
      loading={tagsQ.isFetching && !tags}
      style={{ width: '100%', minWidth: 200, ...style }}
    />
  );
}

/* ================= TagInput — gắn tag lên phiếu ================= */

export interface TagInputProps {
  /** `tag_ids` của phiếu. */
  value: string[];
  onChange: (ids: string[]) => void;
  /** Công ty của phiếu: tag thuộc danh bạ công ty này. Chưa có công ty → ô bị khoá. */
  companyId: string | null;
  disabled?: boolean;
  /** Tối đa số tag trên một phiếu (contract `documentFields.tag_ids` ≤ 50). */
  maxCount?: number;
  /**
   * Tag đã gắn trên phiếu (`documentDetail.tags`). Truyền vào để hiện đúng tên các tag đã ẩn
   * mà người dùng không có `tag:manage` (danh bạ không trả tag đã ẩn cho họ).
   */
  knownTags?: readonly TagRef[];
  placeholder?: string;
  ariaLabel?: string;
}

export function TagInput({
  value,
  onChange,
  companyId,
  disabled,
  maxCount = 50,
  knownTags,
  placeholder = 'Gõ để tìm hoặc tạo tag…',
  ariaLabel = 'Tag',
}: TagInputProps): ReactNode {
  const { can } = useAuth();
  return (
    <TagSelect
      companyId={companyId}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      maxCount={maxCount}
      allowCreate={can('tag:create')}
      includeHidden={false}
      knownTags={knownTags}
    />
  );
}

/* ================= TagFilter — lọc danh sách / báo cáo ================= */

export interface TagFilterProps {
  value: string[];
  onChange: (ids: string[]) => void;
  /**
   * Công ty đang lọc. Phạm vi "Toàn tập đoàn" không có công ty cụ thể → ô bị khoá, vì tag id
   * không dùng chung giữa các công ty (báo cáo hợp nhất theo tên tag đã chuẩn hoá).
   */
  companyId: string | null;
  placeholder?: string;
  ariaLabel?: string;
  style?: CSSProperties;
}

export function TagFilter({ value, onChange, companyId, placeholder = 'Lọc theo tag', ariaLabel = 'Lọc theo tag', style }: TagFilterProps): ReactNode {
  return (
    <TagSelect
      companyId={companyId}
      value={value}
      onChange={onChange}
      placeholder={companyId ? placeholder : 'Chọn một công ty để lọc theo tag'}
      ariaLabel={ariaLabel}
      allowCreate={false}
      includeHidden
      maxTagCount="responsive"
      style={{ minWidth: 220, maxWidth: '100%', ...style }}
    />
  );
}

/* ================= TagPicker — chọn đúng một tag ================= */

export interface TagPickerProps {
  companyId: string | null;
  value?: string;
  onChange: (id: string | undefined) => void;
  /** Ẩn một tag khỏi danh sách (vd tag nguồn khi gộp). */
  exclude?: string;
  /** Mặc định chỉ tag đang hiện (tag đích khi gộp phải đang hiện). */
  includeHidden?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}

export function TagPicker({
  companyId,
  value,
  onChange,
  exclude,
  includeHidden = false,
  placeholder = 'Chọn tag…',
  ariaLabel,
}: TagPickerProps): ReactNode {
  const tagsQ = useCompanyTags(companyId);
  const options = useMemo<TagOption[]>(
    () =>
      (tagsQ.data ?? [])
        .filter((t) => t._id !== exclude && (includeHidden || !t.hidden))
        // tag đang dùng lên trước, tag đã ẩn xuống sau
        .sort((a, b) => Number(!!a.hidden) - Number(!!b.hidden) || a.name.localeCompare(b.name, 'vi'))
        .map((t) => ({ value: t._id, label: t.name, tag: t })),
    [tagsQ.data, exclude, includeHidden],
  );
  return (
    <Select<string, TagOption>
      aria-label={ariaLabel}
      value={value ?? null}
      onChange={(v) => onChange(v ?? undefined)}
      options={options}
      optionRender={(opt) => renderTagOption(opt.data)}
      showSearch
      filterOption={(input, opt) => (opt?.tag ? tagMatchesSearch(opt.tag, input) : false)}
      notFoundContent={!companyId ? 'Chọn công ty trước' : tagsQ.isPending ? 'Đang tải tag…' : 'Không có tag phù hợp'}
      placeholder={placeholder}
      allowClear
      disabled={!companyId}
      style={{ width: '100%', minWidth: 200 }}
    />
  );
}

/* ================= TagChips — chỉ hiển thị ================= */

export interface TagChipsProps {
  /** Tag đã có dữ liệu (vd `documentDetail.tags`): không gọi API. */
  tags?: readonly TagRef[] | null;
  /** Hoặc chỉ có id: tên và màu được tra trong danh bạ của `companyId`. */
  ids?: readonly string[] | null;
  companyId?: string | null;
  /** Nội dung khi không có tag (mặc định "—"). */
  emptyText?: ReactNode;
}

export function TagChips({ tags, ids, companyId, emptyText = '—' }: TagChipsProps): ReactNode {
  const needLookup = !tags && !!ids?.length;
  const tagsQ = useCompanyTags(needLookup ? (companyId ?? null) : null);
  const byId = useMemo(() => new Map((tagsQ.data ?? []).map((t) => [t._id, t] as const)), [tagsQ.data]);

  const items: { key: string; name: string; color?: string | null; hidden?: boolean; muted?: boolean }[] = tags
    ? tags.map((t) => ({ key: t._id, name: t.name, color: t.color, hidden: t.hidden }))
    : (ids ?? []).map((id) => {
        const t = byId.get(id);
        if (t) return { key: id, name: t.name, color: t.color, hidden: t.hidden };
        return { key: id, name: missingTagLabel(companyId ?? null, tagsQ.isPending, tagsQ.isError), muted: true };
      });

  if (!items.length) return <span style={{ color: 'var(--fg-text-muted)' }}>{emptyText}</span>;
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
      {items.map((it) => (
        <TagChip key={it.key} name={it.name} color={it.color} hidden={it.hidden} muted={it.muted} />
      ))}
    </span>
  );
}

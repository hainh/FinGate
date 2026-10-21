/**
 * v2 — Quản lý tag của công ty (v2/v2.md §6.2, §13). Dành cho KTT (`tag:manage`):
 * đổi tên, đổi màu, gộp hai tag (mọi phiếu của tag nguồn chuyển sang tag đích), ẩn / hiện tag.
 * Tag thuộc từng công ty: màn này làm việc với công ty đang chọn ở bộ chọn phạm vi.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { tagName, UI, type TagRow, type TagUpdateBody } from '@fingate/shared';
import { SCOPE_ALL, useAuth, useCurrentCompanyId } from '../app/store.tsx';
import {
  TAG_COLOR_PRESETS,
  tagColorOf,
  tagErrorMessage,
  tagMatchesSearch,
  useCompanyTags,
  useCreateTag,
  useMergeTags,
  useUpdateTag,
} from '../app/v2/tags.ts';
import { FgButton, FgField, FgInput, FgText, FgTooltip } from '../components/primitives.tsx';
import { FgEmptyState, FgModal, FgSegmented, FgSkeletonTable, FgTable, type TableColumnsType } from '../components/uitk.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
import { TagChip, TagPicker } from '../components/tag-input.tsx';

type TagView = 'all' | 'active' | 'hidden';

const VIEW_OPTIONS: { label: string; value: TagView }[] = [
  { label: 'Tất cả', value: 'all' },
  { label: 'Đang dùng', value: 'active' },
  { label: 'Đã ẩn', value: 'hidden' },
];

/** Server chỉ cho ẩn tag KHÔNG còn phiếu nào gắn (hiện lại thì luôn được). */
const hideBlocked = (t: TagRow): boolean => !t.hidden && t.usage_count > 0;

export function TagsScreen(): ReactNode {
  const { can, me, scope } = useAuth();
  const companyId = useCurrentCompanyId();
  const companyName = me?.companies.find((c) => c.company_id === companyId)?.company_name ?? null;
  const query = useCompanyTags(companyId);
  const update = useUpdateTag(companyId);
  const { message } = useToast();
  const [q, setQ] = useState('');
  const [view, setView] = useState<TagView>('all');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TagRow | null>(null);
  const [merging, setMerging] = useState<TagRow | null>(null);

  const tags = useMemo<TagRow[]>(() => query.data ?? [], [query.data]);
  // Danh sách: lọc theo trạng thái + từ khoá (chuẩn hoá), tag dùng nhiều lên đầu.
  const rows = useMemo(
    () =>
      tags
        .filter((t) => view === 'all' || (view === 'hidden' ? t.hidden : !t.hidden))
        .filter((t) => tagMatchesSearch(t, q))
        .sort((a, b) => b.usage_count - a.usage_count || a.name.localeCompare(b.name, 'vi')),
    [tags, view, q],
  );

  const toggleHidden = (t: TagRow) =>
    update.mutate(
      { id: t._id, body: { hidden: !t.hidden } },
      {
        onSuccess: () => message.success(t.hidden ? `Đã hiện lại tag “${t.name}”` : `Đã ẩn tag “${t.name}”`),
        onError: (e) => message.error(tagErrorMessage(e, 'Không cập nhật được tag')),
      },
    );

  const columns: TableColumnsType<TagRow> = [
    {
      title: 'Tag',
      key: 'name',
      render: (_v, t) => <TagChip name={t.name} color={t.color} hidden={t.hidden} />,
    },
    {
      title: 'Số phiếu',
      key: 'usage',
      align: 'right',
      width: 120,
      render: (_v, t) => <span className="fg-num">{t.usage_count}</span>,
    },
    {
      title: 'Màu',
      key: 'color',
      width: 150,
      render: (_v, t) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            aria-hidden
            style={{ width: 16, height: 16, borderRadius: 4, background: tagColorOf(t.color), border: '1px solid var(--fg-border-default)' }}
          />
          <span className="fg-num" style={{ color: 'var(--fg-text-muted)' }}>
            {tagColorOf(t.color)}
          </span>
        </span>
      ),
    },
    {
      title: 'Trạng thái',
      key: 'state',
      width: 130,
      render: (_v, t) => (t.hidden ? <FgText style="bodyS" color="muted">Đã ẩn</FgText> : <FgText style="bodyS">Đang dùng</FgText>),
    },
    {
      title: 'Thao tác',
      key: 'actions',
      width: 280,
      render: (_v, t) => (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <FgButton size="small" onClick={() => setEditing(t)} aria-label={`Sửa tag ${t.name}`}>
            Sửa
          </FgButton>
          <FgButton size="small" onClick={() => setMerging(t)} aria-label={`Gộp tag ${t.name}`}>
            Gộp…
          </FgButton>
          {hideBlocked(t) ? (
            <FgTooltip title={`Tag đang gắn ${t.usage_count} phiếu nên chưa ẩn được — gộp vào tag khác trước`}>
              <span>
                <FgButton size="small" disabled aria-label={`Ẩn tag ${t.name}`}>
                  {UI.tag.hide}
                </FgButton>
              </span>
            </FgTooltip>
          ) : (
            <FgButton size="small" onClick={() => toggleHidden(t)} aria-label={`${t.hidden ? 'Hiện lại' : 'Ẩn'} tag ${t.name}`}>
              {t.hidden ? 'Hiện lại' : UI.tag.hide}
            </FgButton>
          )}
        </div>
      ),
    },
  ];

  if (!companyId) {
    return (
      <>
        <FgPageHeader title="Quản lý tag" />
        <div className="fg-card">
          <FgEmptyState
            glyph="◇"
            title="Chưa có công ty đang làm việc"
            description="Chọn một công ty ở bộ chọn phạm vi trên đầu trang để quản lý tag của công ty đó."
          />
        </div>
      </>
    );
  }

  return (
    <>
      <FgPageHeader
        title="Quản lý tag"
        meta={`Công ty: ${companyName ?? '—'} · ${UI.tag.separateFromCategory}`}
        actions={
          can('tag:create') ? (
            <FgButton variant="primary" onClick={() => setCreating(true)}>
              + Tạo tag
            </FgButton>
          ) : null
        }
      />
      {scope === SCOPE_ALL ? (
        <FgText style="bodyS" color="muted">
          Tag thuộc từng công ty — đang xem danh bạ của “{companyName ?? '—'}”. Đổi công ty ở bộ chọn phạm vi trên đầu trang để xem công ty khác.
        </FgText>
      ) : null}
      <div className="fg-filterbar">
        <FgInput
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Tìm tag theo tên…"
          aria-label="Tìm tag theo tên"
          allowClear
          style={{ width: 280, maxWidth: '100%' }}
        />
        <FgSegmented value={view} onChange={(v) => setView(v as TagView)} options={VIEW_OPTIONS} />
      </div>
      <FgText style="caption" color="muted">
        {UI.tag.hiddenNote}. Gộp tag: mọi phiếu đang gắn tag nguồn sẽ chuyển sang tag đích.
      </FgText>

      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={4} />}>
        {() =>
          !tags.length ? (
            <div className="fg-card">
              <FgEmptyState
                glyph="◇"
                title="Chưa có tag nào"
                description="Tag được tạo ngay trên phiếu thu/chi (gõ “+ Tạo tag …”) hoặc bằng nút “+ Tạo tag”."
              />
            </div>
          ) : !rows.length ? (
            <div className="fg-card">
              <FgEmptyState glyph="◇" title="Không có tag phù hợp" description="Thử từ khoá khác hoặc đổi bộ lọc Tất cả / Đang dùng / Đã ẩn." />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable<TagRow> rowKey="_id" dataSource={rows} pagination={false} columns={columns} />
            </div>
          )
        }
      </FgQuery>

      {creating ? <TagFormModal companyId={companyId} onClose={() => setCreating(false)} /> : null}
      {editing ? <TagFormModal companyId={companyId} editing={editing} onClose={() => setEditing(null)} /> : null}
      {merging ? <MergeTagModal companyId={companyId} source={merging} onClose={() => setMerging(null)} /> : null}
    </>
  );
}

/** Tạo mới hoặc đổi tên / màu. Chỉ gửi trường đã đổi (PATCH). */
function TagFormModal({ companyId, editing, onClose }: { companyId: string; editing?: TagRow; onClose: () => void }): ReactNode {
  const create = useCreateTag(companyId);
  const update = useUpdateTag(companyId);
  const { message } = useToast();
  const [name, setName] = useState(editing?.name ?? '');
  const [color, setColor] = useState(tagColorOf(editing?.color));
  const [error, setError] = useState<string | null>(null);
  const busy = create.isPending || update.isPending;

  const submit = async (): Promise<void> => {
    const parsed = tagName.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Tên tag không hợp lệ');
      return;
    }
    setError(null);
    try {
      if (editing) {
        const body: TagUpdateBody = {};
        if (parsed.data !== editing.name) body.name = parsed.data;
        if (color !== tagColorOf(editing.color)) body.color = color;
        if (!Object.keys(body).length) {
          onClose();
          return;
        }
        await update.mutateAsync({ id: editing._id, body });
        message.success('Đã lưu tag');
      } else {
        const res = await create.mutateAsync({ name: parsed.data, color });
        message.success(res.created ? `Đã tạo tag “${parsed.data}”` : `Tag “${res.tag.name}” đã có sẵn — không tạo trùng`);
      }
      onClose();
    } catch (e) {
      setError(tagErrorMessage(e, 'Không lưu được tag'));
    }
  };

  return (
    <FgModal
      open
      title={editing ? `Sửa tag “${editing.name}”` : 'Tạo tag'}
      onCancel={onClose}
      width={480}
      footer={
        <>
          <FgButton onClick={onClose} disabled={busy}>
            Hủy
          </FgButton>
          <FgButton variant="primary" loading={busy} onClick={() => void submit()}>
            {editing ? 'Lưu thay đổi' : 'Tạo tag'}
          </FgButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--fg-space-4)' }}>
        <FgField
          label="Tên tag"
          labelFor="tag-name"
          required
          error={error}
          help="Tối đa 40 ký tự. Không phân biệt hoa thường; khoảng trắng thừa được bỏ."
        >
          <FgInput
            id="tag-name"
            value={name}
            maxLength={40}
            placeholder="VD: Dự án X"
            onChange={(e) => setName(e.target.value)}
            onPressEnter={() => void submit()}
            autoFocus
          />
        </FgField>
        <ColorField value={color} onChange={setColor} />
        {editing ? (
          <FgText style="caption" color="muted">
            Đổi tên hoặc màu không ảnh hưởng số tiền. Mọi phiếu đang gắn tag sẽ hiển thị theo tên và màu mới.
          </FgText>
        ) : null}
      </div>
    </FgModal>
  );
}

/** Bảng màu gợi ý + màu tuỳ chọn (native). Mỗi ô có nhãn đọc được, không chỉ dựa vào màu. */
function ColorField({ value, onChange }: { value: string; onChange: (c: string) => void }): ReactNode {
  return (
    <FgField label="Màu">
      <div role="radiogroup" aria-label="Chọn màu tag" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        {TAG_COLOR_PRESETS.map((c) => {
          const on = c === value;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`Màu ${c}`}
              title={c}
              onClick={() => onChange(c)}
              style={{
                width: 26,
                height: 26,
                padding: 0,
                borderRadius: '50%',
                cursor: 'pointer',
                background: c,
                border: on ? '2px solid var(--fg-text-primary)' : '1px solid var(--fg-border-default)',
              }}
            />
          );
        })}
        <input
          type="color"
          aria-label="Màu khác"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ width: 32, height: 32, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
        />
      </div>
    </FgField>
  );
}

/**
 * Gộp hai tag, 2 bước: (1) chọn tag đích; (2) xác nhận — giải thích phiếu nào sẽ bị đổi
 * trước khi gửi. Không đổi số tiền hay trạng thái phiếu.
 */
function MergeTagModal({ companyId, source, onClose }: { companyId: string; source: TagRow; onClose: () => void }): ReactNode {
  const merge = useMergeTags(companyId);
  const tagsQ = useCompanyTags(companyId);
  const { message } = useToast();
  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const target = (tagsQ.data ?? []).find((t) => t._id === targetId);

  const submit = () => {
    if (!target) return;
    merge.mutate(
      { source_id: source._id, target_id: target._id },
      {
        onSuccess: (res) => {
          const moved = res?.documents_changed ?? 0;
          message.success(`Đã gộp “${source.name}” vào “${target.name}”${moved ? ` · đã chuyển ${moved} phiếu` : ''}`);
          onClose();
        },
        onError: (e) => message.error(tagErrorMessage(e, 'Không gộp được tag')),
      },
    );
  };

  return (
    <FgModal
      open
      title={confirming ? 'Xác nhận gộp tag' : `Gộp tag “${source.name}”`}
      onCancel={onClose}
      width={520}
      footer={
        confirming ? (
          <>
            <FgButton onClick={() => setConfirming(false)} disabled={merge.isPending}>
              Quay lại
            </FgButton>
            <FgButton variant="danger" loading={merge.isPending} onClick={submit}>
              Gộp tag
            </FgButton>
          </>
        ) : (
          <>
            <FgButton onClick={onClose}>Hủy</FgButton>
            <FgButton variant="primary" disabled={!target} onClick={() => setConfirming(true)}>
              Tiếp tục
            </FgButton>
          </>
        )
      }
    >
      {confirming && target ? (
        <div style={{ display: 'grid', gap: 'var(--fg-space-3)' }}>
          <FgText style="body">
            {source.usage_count > 0
              ? `Mọi phiếu đang gắn “${source.name}” (${source.usage_count} phiếu) sẽ được chuyển sang “${target.name}”.`
              : `“${source.name}” chưa gắn phiếu nào — chỉ gỡ tag khỏi danh bạ.`}
          </FgText>
          <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
            <li>
              <FgText style="bodyS" color="secondary">
                Tag “{source.name}” sẽ được ẩn khỏi danh bạ (không còn gợi ý khi gõ tìm). Có thể hiện lại sau nếu cần.
              </FgText>
            </li>
            <li>
              <FgText style="bodyS" color="secondary">
                Tag đích “{target.name}” vẫn hiện và giữ nguyên màu.
              </FgText>
            </li>
            <li>
              <FgText style="bodyS" color="secondary">
                Số tiền và trạng thái phiếu không thay đổi. Sau khi gộp, không tách lại được các phiếu đã chuyển.
              </FgText>
            </li>
          </ul>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 'var(--fg-space-3)' }}>
          <FgText style="body" color="secondary">
            Chọn tag đích. Mọi phiếu đang gắn “{source.name}” sẽ được chuyển sang tag đích.
          </FgText>
          <FgField label="Tag đích" required>
            <TagPicker
              companyId={companyId}
              value={targetId}
              onChange={setTargetId}
              exclude={source._id}
              placeholder="Chọn tag đích…"
              ariaLabel="Tag đích"
            />
          </FgField>
        </div>
      )}
    </FgModal>
  );
}

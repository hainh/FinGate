/**
 * M — Quản trị: ADM-01 Người dùng · ADM-04 Approval Matrix · ADM-12 Audit log.
 * + PREF-01 Cài đặt cá nhân.
 *
 * "Ma trận duyệt là dữ liệu" — editor theo dải tiền + preview timeline (không hard-code).
 * Audit log KHÔNG có nút xóa (blueprint §XIX).
 */

import { useState, type ReactNode } from 'react';
import {
  accountStatusFor,
  formatMoney,
  money,
  ddmmyyyy,
  dateTimeLabel,
} from '@fingate/shared';
import { useAuditLog, useMatrix, usePersonnel } from '../app/queries.ts';
import { useAuth, useUi } from '../app/store.tsx';
import { FgButton, FgMoney, FgSelect, FgText, FgTooltip } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgSkeletonTable, FgTable, FgTabs, FgTag } from '../components/uitk.tsx';
import { FgApprovalTimeline } from '../components/finance.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import { AUDIT_ACTION_LABEL, ROLES_LABEL } from '../components/labels.ts';
import { apiCall } from '../app/api.ts';
import { DOC_KIND_LABEL } from '@fingate/shared';

/* ================= ADM-01 ================= */

export function PersonnelScreen(): ReactNode {
  const { can } = useAuth();
  const query = usePersonnel(1);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <>
      <FgPageHeader title="Nhân sự" meta="Mời người dùng mới, đổi vai trò, ngừng hoạt động — mọi thao tác có audit" />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={6} />}>
        {(data) => (
          <div className="fg-card" style={{ padding: 0 }}>
            <FgTable
              rowKey="user_id"
              dataSource={data.items}
              columns={[
                { title: 'Họ tên', dataIndex: 'display_name', key: 'n', render: (v: string) => <FgText strong>{v}</FgText> },
                {
                  title: 'Email',
                  key: 'e',
                  render: (_v, r) =>
                    r.email_masked ? (
                      <FgTooltip title="Email bị ẩn vì bạn không có quyền quản lý nhân sự">
                        <span className="fg-muted">đã ẩn</span>
                      </FgTooltip>
                    ) : (
                      r.email
                    ),
                },
                { title: 'Công ty', dataIndex: 'company_name', key: 'c' },
                { title: 'Vai trò', dataIndex: 'role_label', key: 'r' },
                {
                  title: 'Hạn mức duyệt',
                  dataIndex: 'amount_limit_minor',
                  key: 'lim',
                  align: 'right',
                  render: (v: string) => <FgMoney value={money(v)} mode="compact" />,
                },
                {
                  title: 'Trạng thái',
                  key: 'st',
                  render: (_v, r) => {
                    const def = accountStatusFor(r.status);
                    return <FgTag tone={def.tone}>{`${def.glyph} ${def.labelVi}`}</FgTag>;
                  },
                },
                {
                  title: '2FA',
                  key: 'mfa',
                  render: (_v, r) => (r.mfa_enabled ? <span style={{ color: 'var(--fg-status-success-text)' }}>✓ bật</span> : <span className="fg-muted">chưa</span>),
                },
                { title: 'Đăng nhập cuối', key: 'll', render: (_v, r) => (r.last_login_at ? dateTimeLabel(r.last_login_at) : '—') },
                {
                  title: '',
                  key: 'act',
                  render: (_v, r) =>
                    can('hr:disable') && r.status === 'active' ? (
                      <FgButton
                        size="small"
                        variant="danger"
                        loading={busy === r.user_id}
                        onClick={async () => {
                          const reason = window.prompt(`Ngừng hoạt động ${r.display_name}? Nêu lý do (bắt buộc, có audit):`);
                          if (!reason || reason.trim().length < 5) return;
                          if (r.holding_docs > 0) {
                            window.alert(`${r.display_name} đang giữ ${r.holding_docs} hồ sơ chờ duyệt — phải chỉ định người thay thế (FG-HR-003). Vào hồ sơ để chuyển bàn.`);
                            return;
                          }
                          setBusy(r.user_id);
                          try {
                            await apiCall(`/personnel/${r.user_id}/deactivate`, { method: 'POST', body: { reason } });
                            void query.refetch();
                          } catch (e) {
                            window.alert((e as { problem?: { title: string } }).problem?.title ?? 'Không thực hiện được');
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Ngừng hoạt động
                      </FgButton>
                    ) : null,
                },
              ]}
            />
          </div>
        )}
      </FgQuery>
    </>
  );
}

/* ================= ADM-04 ================= */

export function MatrixScreen(): ReactNode {
  const query = useMatrix();
  const [preview, setPreview] = useState<string | null>(null);
  return (
    <>
      <FgPageHeader title="Ma trận duyệt" meta="Ngưỡng tiền → chuỗi cấp duyệt — cấu hình được, thay đổi luôn vào audit" />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={5} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState glyph="◇" title="Chưa cấu hình quy trình nào" description="Bạn không có quyền admin:matrix hoặc hệ thống chưa có ma trận — liên hệ Quản trị." />
            </div>
          ) : (
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable
                rowKey="_id"
                dataSource={data.items}
                columns={[
                  { title: 'Quy trình', dataIndex: 'label', key: 'l', render: (v: string) => <FgText strong>{v}</FgText> },
                  {
                    title: 'Công ty',
                    key: 'c',
                    render: (_v, r) => (r.company_id ? r.company_name : <FgTag tone="info">Toàn tập đoàn</FgTag>),
                  },
                  { title: 'Loại phiếu', key: 'k', render: (_v, r) => DOC_KIND_LABEL[r.doc_kind as keyof typeof DOC_KIND_LABEL] ?? r.doc_kind },
                  {
                    title: 'Từ',
                    dataIndex: 'amount_min_minor',
                    key: 'mn',
                    align: 'right',
                    render: (v: string) => <FgMoney value={money(v)} mode="compact" />,
                  },
                  {
                    title: 'Đến',
                    key: 'mx',
                    align: 'right',
                    render: (_v, r) => (r.amount_max_minor ? <FgMoney value={money(r.amount_max_minor)} mode="compact" /> : <span className="fg-muted">∞</span>),
                  },
                  {
                    title: 'Chuỗi duyệt',
                    key: 's',
                    render: (_v, r) => (
                      <span>
                        {r.steps.map((s, i) => (
                          <span key={s.order}>
                            {i ? ' → ' : ''}
                            <span style={{ fontWeight: 500 }}>{ROLES_LABEL[s.role] ?? s.role_label}</span>
                            <span className="fg-muted"> ({s.sla_hours}h)</span>
                          </span>
                        ))}
                      </span>
                    ),
                  },
                  {
                    title: '',
                    key: 'p',
                    render: (_v, r) => (
                      <FgButton size="small" onClick={() => setPreview(preview === r._id ? null : r._id)}>
                        {preview === r._id ? 'Đóng' : 'Xem trước'}
                      </FgButton>
                    ),
                  },
                  { title: 'Hiệu lực từ', dataIndex: 'effective_from', key: 'ef' },
                ]}
                expandable={{
                  expandedRowRender: (r) => (
                    <div style={{ padding: '12px 0' }}>
                      <FgText style="bodyS" color="muted">
                        Preview timeline — một hồ sơ rơi vào dải {formatMoney(money(r.amount_min_minor), { mode: 'compact' })}
                        {r.amount_max_minor ? ` → ${formatMoney(money(r.amount_max_minor), { mode: 'compact' })}` : ''}:
                      </FgText>
                      <div style={{ marginTop: 8 }}>
                        <FgApprovalTimeline
                          steps={r.steps.map((s, i) => ({
                            order: s.order,
                            role: s.role,
                            user_id: null,
                            state: i === 0 ? 'current' : 'waiting',
                          }))}
                        />
                      </div>
                    </div>
                  ),
                  rowExpandable: () => true,
                  expandedRowKeys: preview ? [preview] : [],
                  onExpand: (expanded, r) => setPreview(expanded ? r._id : null),
                }}
              />
            </div>
          )
        }
      </FgQuery>
    </>
  );
}

/* ================= ADM-12 ================= */

export function AuditLogScreen(): ReactNode {
  const [page, setPage] = useState(1);
  const query = useAuditLog(page);
  return (
    <>
      <FgPageHeader title="Audit log" meta="Ai · làm gì · lúc nào · từ IP nào — chỉ thêm, không sửa, KHÔNG có nút xóa (blueprint §XIX)" />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={10} cols={6} />}>
        {(data) => (
          <>
            <div className="fg-card" style={{ padding: 0 }}>
              <FgTable
                rowKey="_id"
                dataSource={data.items}
                columns={[
                  { title: 'Thời gian', dataIndex: 'at', key: 'at', render: (v: string) => dateTimeLabel(v), width: 160 },
                  {
                    title: 'Người',
                    key: 'actor',
                    render: (_v, r) => (
                      <span>
                        <FgText strong>{r.actor.name}</FgText>
                        <br />
                        <FgText style="caption" color="muted">
                          {ROLES_LABEL[r.actor.role ?? ''] ?? r.actor.role ?? '—'}
                        </FgText>
                      </span>
                    ),
                  },
                  { title: 'Hành động', dataIndex: 'action', key: 'act', render: (v: string) => AUDIT_ACTION_LABEL[v] ?? v },
                  {
                    title: 'Đối tượng',
                    key: 'subj',
                    render: (_v, r) => `${r.subject.type}${r.subject.code ? ` · ${r.subject.code}` : ''}`,
                  },
                  {
                    title: 'Trường thay đổi',
                    key: 'diff',
                    render: (_v, r) => (r.diff_fields?.length ? r.diff_fields.join(', ') : '—'),
                  },
                  { title: 'IP', key: 'ip', render: (_v, r) => <span className="fg-mono">{r.ip ?? '—'}</span> },
                ]}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <FgButton size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                ← Trước
              </FgButton>
              <FgText style="bodyS" color="muted">
                Trang {page}
              </FgText>
              <FgButton size="small" disabled={(data.total ?? 0) <= page * 50} onClick={() => setPage((p) => p + 1)}>
                Sau →
              </FgButton>
            </div>
          </>
        )}
      </FgQuery>
    </>
  );
}

/* ================= PREF-01 ================= */

export function SettingsScreen(): ReactNode {
  const { me } = useAuth();
  const { theme, density, setTheme, setDensity } = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  if (!me) return null;
  return (
    <>
      <FgPageHeader title="Cá nhân & cài đặt" />
      <FgTabs
        items={[
          {
            key: 'hien-thi',
            label: 'Hiển thị',
            children: (
              <FgCard style={{ maxWidth: 520 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)' }}>
                  <FgTooltip title="Theme lưu trên thiết bị này, đồng bộ vào server khi bạn đổi">
                    <FgSelect
                      ariaLabel="Chủ đề"
                      options={[
                        { value: 'light', label: 'Sáng' },
                        { value: 'dark', label: 'Tối' },
                        { value: 'system', label: 'Theo hệ thống' },
                      ]}
                      value={theme}
                      onChange={async (v) => {
                        if (!v) return;
                        setTheme(v as 'light');
                        setBusy('theme');
                        try {
                          await apiCall('/me/prefs', { method: 'PATCH', body: { theme: v } });
                        } finally {
                          setBusy(null);
                        }
                      }}
                    />
                  </FgTooltip>
                  <FgSelect
                    ariaLabel="Độ đặc bảng"
                    options={[
                      { value: 'comfortable', label: 'Thoáng (44px/dòng)' },
                      { value: 'compact', label: 'Dày (34px/dòng)' },
                    ]}
                    value={density}
                    onChange={async (v) => {
                      if (!v) return;
                      setDensity(v as 'comfortable');
                      setBusy('density');
                      try {
                        await apiCall('/me/prefs', { method: 'PATCH', body: { density: v } });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  />
                  {busy ? <FgText style="caption" color="muted">Đang lưu…</FgText> : null}
                </div>
              </FgCard>
            ),
          },
          {
            key: 'bao-mat',
            label: 'Bảo mật',
            children: (
              <FgCard style={{ maxWidth: 520 }}>
                <div className="fg-stat-row">
                  <span className="fg-stat-label">Xác thực 2 lớp (TOTP)</span>
                  <FgTag tone={me.totp_enabled ? 'success' : 'attention'}>{me.totp_enabled ? '✓ Đã bật' : 'Chưa bật'}</FgTag>
                </div>
                <div className="fg-stat-row">
                  <span className="fg-stat-label">Yêu cầu 2FA khi hành động nhạy cảm</span>
                  <span>{me.mfa_required ? 'Bắt buộc (theo vai trò)' : 'Không'}</span>
                </div>
                <div className="fg-stat-row">
                  <span className="fg-stat-label">Phiên đăng nhập gần nhất</span>
                  <span className="fg-num">{me.last_login_at ? dateTimeLabel(me.last_login_at) : '—'}</span>
                </div>
                <div style={{ marginTop: 'var(--fg-space-4)' }}>
                  <FgButton
                    onClick={async () => {
                      const cur = window.prompt('Mật khẩu hiện tại:');
                      if (!cur) return;
                      const np = window.prompt('Mật khẩu mới (tối thiểu 12 ký tự):');
                      if (!np) return;
                      try {
                        await apiCall('/me/change-password', { method: 'POST', body: { current_password: cur, new_password: np } });
                        window.alert('Đã đổi mật khẩu.');
                      } catch (e) {
                        window.alert((e as { problem?: { title: string } }).problem?.title ?? 'Không đổi được');
                      }
                    }}
                  >
                    Đổi mật khẩu
                  </FgButton>
                </div>
              </FgCard>
            ),
          },
          {
            key: 'pham-vi',
            label: 'Phạm vi & vai trò',
            children: (
              <FgCard style={{ maxWidth: 620 }}>
                {me.assignments.map((a) => (
                  <div className="fg-stat-row" key={`${a.company_id}-${a.role}`}>
                    <span className="fg-stat-label">{a.company_name}</span>
                    <span>
                      <FgText strong>{a.role_label}</FgText>
                      <br />
                      <FgText style="caption" color="muted">
                        Hạn mức duyệt: {formatMoney(money(a.amount_limit_minor), { mode: 'compact' })}
                        {a.scope_all ? ' · toàn tập đoàn' : ''}
                      </FgText>
                    </span>
                  </div>
                ))}
                <FgText style="caption" color="muted">
                  Vai trò do Quản trị gán — không tự đổi. Ngày {ddmmyyyy(new Date())}.
                </FgText>
              </FgCard>
            ),
          },
        ]}
      />
    </>
  );
}

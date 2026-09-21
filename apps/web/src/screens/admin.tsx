/**
 * M — Quản trị: ADM-01 Người dùng · ADM-04 Approval Matrix · ADM-12 Audit log.
 * + PREF-01 Cài đặt cá nhân.
 *
 * "Ma trận duyệt là dữ liệu" — editor theo dải tiền + preview timeline (không hard-code).
 * Audit log KHÔNG có nút xóa (blueprint §XIX).
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Checkbox } from 'antd';
import {
  accountStatusFor,
  formatMoney,
  money,
  ddmmyyyy,
  dateTimeLabel,
  moneyToWire,
  PERMISSION_GROUPS,
  PERMISSION_LABEL,
  permissionsForRole,
  type Permission,
  type Role,
  type Money,
} from '@fingate/shared';
import { useAuditLog, useCompanies, useDepartments, useMatrix, useMatrixUpsert, usePersonnel, type DepartmentRow } from '../app/queries.ts';
import { useAuth, useUi } from '../app/store.tsx';
import { FgAlert, FgButton, FgField, FgInput, FgMoney, FgMoneyInput, FgMultiSelect, FgSelect, FgText, FgTooltip } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgModal, FgSkeletonTable, FgTable, FgTabs, FgTag } from '../components/uitk.tsx';
import { FgApprovalTimeline } from '../components/finance.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, toastOk } from '../components/pagekit.tsx';
import { AUDIT_ACTION_LABEL, ROLES_LABEL } from '../components/labels.ts';
import { ApiRequestError, apiCall } from '../app/api.ts';
import { APPROVAL_ORDER, DOC_KIND_LABEL, DOC_KINDS, type DocKind } from '@fingate/shared';
import type { CompanyRow, InviteLinkResult, MatrixEntry, PersonnelRow } from '../app/types.ts';

/* ================= Khu Quản trị — điều hướng chung ================= */

/** Các tab trong khu Quản trị; chỉ tab người dùng có quyền mới hiện. */
const ADMIN_TABS: { to: string; label: string; perm: string }[] = [
  { to: '/quantri/nguoidung', label: 'Nhân sự', perm: 'hr:invite' },
  { to: '/quantri/cong-ty', label: 'Công ty & bộ phận', perm: 'admin:settings' },
  { to: '/quantri/quy-trinh-duyet', label: 'Ma trận duyệt', perm: 'admin:matrix' },
  { to: '/quantri/audit', label: 'Audit log', perm: 'audit:read' },
];

function AdminNav(): ReactNode {
  const { can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const items = ADMIN_TABS.filter((t) => can(t.perm)).map((t) => ({ key: t.to, label: t.label }));
  // Người chỉ có 1 mục (VD KTT) → không cần thanh tab.
  if (items.length <= 1) return null;
  const active = ADMIN_TABS.find((t) => location.pathname.startsWith(t.to))?.to ?? items[0]?.key ?? '';
  return (
    <div style={{ marginBottom: 'var(--fg-space-4)' }}>
      <FgTabs activeKey={active} onChange={(k: string) => navigate(k)} items={items} />
    </div>
  );
}

/* ================= ADM-01 ================= */

const VALID_DAY_OPTIONS = [
  { label: '1 ngày', value: '1' },
  { label: '3 ngày', value: '3' },
  { label: '7 ngày', value: '7' },
];

export function PersonnelScreen(): ReactNode {
  const { can, me } = useAuth();
  const query = usePersonnel(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<PersonnelRow | null>(null);
  const [editTarget, setEditTarget] = useState<PersonnelRow | null>(null);
  const [linkResult, setLinkResult] = useState<LinkSeed | null>(null);
  return (
    <>
      <AdminNav />
      <FgPageHeader
        title="Nhân sự"
        meta="Tạo tài khoản, phân công ty + vai trò, cấp link kích hoạt có chữ ký (hạn 1 ngày) để gửi tay — mọi thao tác có audit"
        actions={
          can('hr:invite') ? (
            <FgButton variant="primary" onClick={() => setInviteOpen(true)}>
              + Mời nhân sự
            </FgButton>
          ) : null
        }
      />
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
                  dataIndex: 'email',
                  key: 'e',
                },
                {
                  title: 'Công ty',
                  key: 'c',
                  render: (_v, r) => {
                    const names = r.companies?.length ? r.companies.map((c) => c.company_name) : [r.company_name];
                    return <span>{names.filter(Boolean).join(', ') || '—'}</span>;
                  },
                },
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
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <FgTag tone={def.tone}>{`${def.glyph} ${def.labelVi}`}</FgTag>
                        {r.status === 'invited' || (r.status === 'active' && r.invite_status !== 'none' && r.invite_status !== 'used') ? (
                          r.invite_status === 'active' ? (
                            <FgTooltip title={`Link hết hạn ${dateTimeLabel(r.invite_expires_at ?? '')}`}>
                              <FgTag tone="info">{r.status === 'active' ? 'link đổi mật khẩu còn hạn' : 'link còn hạn'}</FgTag>
                            </FgTooltip>
                          ) : r.invite_status === 'expired' ? (
                            <FgTag tone="warning">{r.status === 'active' ? 'link đổi mật khẩu hết hạn' : 'link hết hạn'}</FgTag>
                          ) : r.invite_status === 'revoked' ? (
                            <FgTag tone="neutral">link đã thu hồi</FgTag>
                          ) : null
                        ) : null}
                      </div>
                    );
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
                  render: (_v, r) => (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {can('hr:invite') && r.status !== 'deactivated' ? (
                        <FgButton size="small" onClick={() => setEditTarget(r)}>
                          Sửa
                        </FgButton>
                      ) : null}
                      {can('hr:invite') && (r.status === 'invited' || r.status === 'active') ? (
                        <FgButton size="small" onClick={() => setLinkTarget(r)}>
                          {r.status === 'active' ? 'Link đổi mật khẩu' : 'Link kích hoạt'}
                        </FgButton>
                      ) : null}
                      {can('hr:disable') && r.status === 'active' && r.user_id !== me?.user_id ? (
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
                      ) : null}
                      {can('hr:disable') && r.status === 'deactivated' ? (
                        <FgButton
                          size="small"
                          loading={busy === r.user_id}
                          onClick={async () => {
                            if (!window.confirm(`Kích hoạt lại tài khoản ${r.display_name}?`)) return;
                            setBusy(r.user_id);
                            try {
                              await apiCall(`/personnel/${r.user_id}/activate`, { method: 'POST' });
                              void query.refetch();
                            } catch (e) {
                              window.alert((e as { problem?: { title: string } }).problem?.title ?? 'Không thực hiện được');
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          Kích hoạt lại
                        </FgButton>
                      ) : null}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}
      </FgQuery>
      <InviteModal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onDone={(link) => {
          setInviteOpen(false);
          void query.refetch();
          // mở ngay hộp link để admin copy gửi — không bắt phải tìm lại trong bảng
          if (link) setLinkResult(link);
        }}
      />
      {linkTarget ? (
        <InviteLinkModal
          row={linkTarget}
          onClose={() => setLinkTarget(null)}
          onChanged={() => void query.refetch()}
        />
      ) : null}
      {linkResult ? <InviteLinkModal link={linkResult} onClose={() => setLinkResult(null)} onChanged={() => void query.refetch()} /> : null}
      {editTarget ? <EditPersonnelModal row={editTarget} onClose={() => setEditTarget(null)} onDone={() => void query.refetch()} /> : null}
    </>
  );
}

/** kết quả vừa tạo (sau mời) — hiển thị luôn để copy. */
type LinkSeed = InviteLinkResult;

function InviteLinkBanner({ link }: { link: LinkSeed }): ReactNode {
  const isReset = link.mode === 'reset';
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    if (!link.invite_url) return;
    try {
      await navigator.clipboard.writeText(link.invite_url);
    } catch {
      // fallback môi trường không có clipboard API (http nội bộ)
      const el = document.createElement('textarea');
      el.value = link.invite_url;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      el.remove();
    }
    setCopied(true);
    toastOk('Đã copy liên kết kích hoạt');
    setTimeout(() => setCopied(false), 2500);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-3)' }}>
      <FgAlert
        tone={link.status === 'active' ? 'success' : link.status === 'used' ? 'info' : 'warning'}
        title={
          link.status === 'active'
            ? `${isReset ? 'Liên kết đổi mật khẩu' : 'Liên kết'} còn hiệu lực tới ${dateTimeLabel(link.expires_at ?? '')}`
            : link.status === 'used'
              ? 'Chưa có liên kết đang hiệu lực — bấm "Tạo link mới" để cấp'
              : link.status === 'expired'
                ? `${isReset ? 'Liên kết đổi mật khẩu' : 'Liên kết'} đã hết hạn — tạo liên kết mới`
                : link.status === 'revoked'
                  ? 'Liên kết đã bị thu hồi — tạo liên kết mới'
                  : 'Chưa có liên kết'
        }
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <FgInput
          readOnly
          value={link.invite_url ?? '(không còn liên kết để hiển thị)'}
          style={{ fontFamily: 'var(--fg-font-mono)', fontSize: 12 }}
          onFocus={(e: { target: { select: () => void } }) => e.target.select()}
        />
        <FgButton variant="primary" disabled={!link.invite_url} onClick={() => void copy()}>
          {copied ? '✓ Đã copy' : 'Copy link'}
        </FgButton>
      </div>
      <FgText style="caption" color="muted">
        {isReset
          ? 'Người nhận mở liên kết sẽ đặt lại mật khẩu (tối thiểu 12 ký tự); mọi phiên đăng nhập cũ bị thu hồi. '
          : 'Người nhận mở liên kết sẽ tự đặt mật khẩu (tối thiểu 12 ký tự). '}
        Link mang chữ ký server, sửa bất kỳ đâu sẽ bị từ chối.
        {link.regenerate_count > 0 ? ` Đã cấp lại ${link.regenerate_count} lần.` : ''}
      </FgText>
    </div>
  );
}

/** Modal quản lý link: xem lại / copy / regenerate / revoke cho một hàng nhân sự. */
function InviteLinkModal({
  row,
  link: initial,
  onClose,
  onChanged,
}: {
  row?: PersonnelRow;
  link?: LinkSeed;
  onClose: () => void;
  onChanged: () => void;
}): ReactNode {
  const [data, setData] = useState<LinkSeed | null>(initial ?? null);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initial || !row) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiCall<{ data: LinkSeed }>(`/personnel/${row.user_id}/invite-link`);
        if (!cancelled) setData(r.data);
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiRequestError ? e.problem.title : 'Không tải được liên kết');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row, initial]);

  const regenerate = async (): Promise<void> => {
    if (!row && !data) return;
    setBusy('regen');
    setError(null);
    try {
      const r = await apiCall<{ data: LinkSeed }>(`/personnel/${data?.user_id ?? row?.user_id}/invite-link`, { method: 'POST', body: { valid_days: 1 } });
      setData(r.data);
      onChanged();
      toastOk(r.data.mode === 'reset' ? 'Đã tạo liên kết đổi mật khẩu — liên kết cũ không còn hiệu lực' : 'Đã tạo liên kết mới — liên kết cũ không còn hiệu lực');
    } catch (e) {
      setError(e instanceof ApiRequestError ? `${e.problem.title}${e.problem.detail ? ` — ${e.problem.detail}` : ''}` : 'Không tạo được liên kết');
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (): Promise<void> => {
    if (!data || !window.confirm('Thu hồi liên kết? Người nhận sẽ không dùng liên kết cũ được nữa.')) return;
    setBusy('revoke');
    setError(null);
    try {
      const r = await apiCall<{ data: LinkSeed }>(`/personnel/${data.user_id}/invite-link`, { method: 'DELETE' });
      setData(r.data);
      onChanged();
      toastOk('Đã thu hồi liên kết');
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.problem.title : 'Không thu hồi được');
    } finally {
      setBusy(null);
    }
  };

  const target = row?.display_name || row?.email || data?.email || '';
  // tài khoản đã hoạt động → link cấp mới là link ĐỔI MẬT KHẨU (mode reset)
  const accountActive = row?.status === 'active' || data?.mode === 'reset';
  const isReset = data?.mode === 'reset' || (!data && row?.status === 'active');
  return (
    <FgModal
      open
      title={`${isReset ? 'Liên kết đổi mật khẩu' : 'Liên kết kích hoạt'} · ${target}`}
      onCancel={onClose}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <FgButton loading={busy === 'regen'} onClick={() => void regenerate()} disabled={!data || (data.status === 'used' && !accountActive)}>
              {isReset ? 'Tạo link đổi mật khẩu mới' : 'Tạo link mới (vô hiệu link cũ)'}
            </FgButton>
            <FgButton
              variant="danger"
              loading={busy === 'revoke'}
              disabled={!data || data.status !== 'active'}
              onClick={() => void revoke()}
            >
              Thu hồi link
            </FgButton>
          </div>
          <FgButton onClick={onClose}>Đóng</FgButton>
        </div>
      }
    >
      {loading ? <FgText color="muted">Đang tải liên kết…</FgText> : null}
      {error ? <FgAlert tone="danger" title={error} /> : null}
      {data ? <InviteLinkBanner link={data} /> : null}
    </FgModal>
  );
}

/** Modal tạo tài khoản: email + công ty + vai trò + hạn mức → trả link ký để copy. */
function InviteModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (link: LinkSeed | null) => void;
}): ReactNode {
  const { me, can } = useAuth();
  const companies = useCompanies();
  const [email, setEmail] = useState('');
  const [companyIds, setCompanyIds] = useState<string[]>(me?.scope.active_company_id ? [me.scope.active_company_id] : []);
  const [deptByCompany, setDeptByCompany] = useState<Record<string, string | undefined>>({});
  const [role, setRole] = useState<string>('staff');
  const [limit, setLimit] = useState<Money | null>(null);
  const [validDays, setValidDays] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [allDepts, setAllDepts] = useState<{ _id: string; name: string; company_id: string }[]>([]);

  const lockedToOwnCompany = !me?.scope.all;
  useEffect(() => {
    if (lockedToOwnCompany && me?.scope.active_company_id) setCompanyIds([me.scope.active_company_id]);
  }, [lockedToOwnCompany, me?.scope.active_company_id]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiCall<{ items: { _id: string; name: string; company_id: string; active?: boolean }[] }>('/departments');
        if (!cancelled) setAllDepts(r.items.filter((d) => d.active !== false).map((d) => ({ _id: d._id, name: d.name, company_id: String(d.company_id) })));
      } catch {
        if (!cancelled) setAllDepts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const companyOptions = useMemo(
    () => (companies.data?.items ?? []).map((c) => ({ label: c.name, value: c._id })),
    [companies.data],
  );
  const companyLabel = (cid: string): string => companyOptions.find((o) => o.value === cid)?.label ?? cid;
  const deptOptionsFor = (cid: string): { label: string; value: string }[] =>
    allDepts.filter((d) => d.company_id === cid).map((d) => ({ label: d.name, value: d._id }));

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const r = await apiCall<{ data: LinkSeed }>('/personnel/invite', {
        method: 'POST',
        body: {
          email: email.trim(),
          company_ids: companyIds,
          departments: Object.fromEntries(companyIds.map((cid) => [cid, deptByCompany[cid] ?? null])),
          role,
          amount_limit_minor: limit ? moneyToWire(limit).minor : undefined,
          valid_days: Number(validDays),
        },
      });
      onDone(r.data);
    } catch (e) {
      if (e instanceof ApiRequestError) {
        const d = e.problem.data as Partial<LinkSeed> | undefined;
        if (e.problem.code === 'FG-HR-001' && d?.user_id) {
          // email đang chờ — mở hộp link của tài khoản cũ để admin copy/regenerate
          setError(null);
          onDone({
            user_id: String(d.user_id),
            email: email.trim(),
            mode: 'activate',
            status: d.invite_url ? 'active' : 'expired',
            invite_url: (d.invite_url as string | null) ?? null,
            expires_at: (d.expires_at as string | null) ?? null,
            invited_at: null,
            regenerate_count: 0,
            send_count: 0,
          });
          return;
        }
        setError(e.problem.detail ?? e.problem.title);
        setFieldErrors(e.problem.errors ?? {});
      } else setError('Không tạo được tài khoản mời');
    } finally {
      setBusy(false);
    }
  };

  return (
    <FgModal
      open={open}
      title="Mời nhân sự mới"
      onCancel={onClose}
      onOk={() => void submit()}
      okText="Tạo tài khoản + link"
      confirmLoading={busy}
      width={520}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)', paddingTop: 8 }}>
        <FgText style="bodyS" color="muted">
          Hệ thống KHÔNG gửi email. Sau khi tạo, bạn nhận về một liên kết có chữ ký (mặc định còn hiệu lực 1 ngày) để tự gửi cho người qua Zalo/email nội bộ.
        </FgText>
        <FgField label="Email người được mời" required error={fieldErrors.email ?? null}>
          <FgInput type="email" value={email} onChange={(e: { target: { value: string } }) => setEmail(e.target.value)} placeholder="ban@congty.vn" />
        </FgField>
        <FgField label="Công ty" required error={fieldErrors.company_ids ?? fieldErrors.company_id ?? null}>
          <FgMultiSelect
            options={companyOptions}
            value={companyIds}
            onChange={(v) => {
              setCompanyIds(v);
              setDeptByCompany((prev) => {
                const next: Record<string, string | undefined> = {};
                for (const cid of v) next[cid] = prev[cid];
                return next;
              });
            }}
            placeholder="Chọn một hoặc nhiều công ty"
            disabled={lockedToOwnCompany}
            style={{ width: '100%' }}
          />
          {lockedToOwnCompany ? (
            <FgText style="caption" color="muted">
              Bạn chỉ mời được nhân sự cho công ty của mình
            </FgText>
          ) : null}
        </FgField>
        <FgField label="Vai trò (phân quyền)" required>
          <FgSelect
            options={Object.entries(ROLES_LABEL).map(([value, label]) => ({ label, value }))}
            value={role}
            onChange={(v) => setRole(v ?? 'staff')}
            style={{ width: '100%' }}
          />
          {['chief_accountant', 'deputy_director', 'director', 'chairman', 'admin'].includes(role) ? (
            <FgText style="caption" color="muted">
              Vai trò này thuộc nhóm bắt buộc 2FA — người nhận tự bật Xác thực 2 lớp trong Cài đặt sau khi kích hoạt.
            </FgText>
          ) : null}
        </FgField>
        {companyIds.map((cid) => (
          <FgField key={cid} label={`Bộ phận · ${companyLabel(cid)} (tùy chọn)`}>
            <FgSelect
              options={deptOptionsFor(cid)}
              value={deptByCompany[cid]}
              onChange={(v) => setDeptByCompany((prev) => ({ ...prev, [cid]: v }))}
              placeholder="Chọn bộ phận"
              allowClear
              style={{ width: '100%' }}
            />
          </FgField>
        ))}
        <FgField label="Hạn mức duyệt (VND, tùy chọn)">
          <FgMoneyInput value={limit} onChange={setLimit} ariaLabel="Hạn mức duyệt" />
        </FgField>
        <FgField label="Link có hiệu lực trong">
          <FgSelect options={VALID_DAY_OPTIONS} value={validDays} onChange={(v) => setValidDays(v ?? '1')} style={{ width: 160 }} />
        </FgField>
        {!can('hr:invite') ? <FgAlert tone="warning" title="Bạn không có quyền mời nhân sự" /> : null}
        {error ? <FgAlert tone="danger" title={error} /> : null}
      </div>
    </FgModal>
  );
}

/**
 * ADM-01 — sửa hồ sơ tài khoản: họ tên · công ty/bộ phận · vai trò · hạn mức duyệt.
 * Email là danh tính đăng nhập nên không đổi được. Đổi công ty cần quyền `hr:transfer`.
 */
function EditPersonnelModal({ row, onClose, onDone }: { row: PersonnelRow; onClose: () => void; onDone: () => void }): ReactNode {
  const { can } = useAuth();
  const companies = useCompanies();
  const canMoveCompany = can('hr:transfer');
  const [name, setName] = useState(row.display_name);
  const [companyIds, setCompanyIds] = useState<string[]>(row.companies?.length ? row.companies.map((c) => c.company_id) : row.company_id ? [row.company_id] : []);
  const [role, setRole] = useState<string>(row.role || 'staff');
  const [deptByCompany, setDeptByCompany] = useState<Record<string, string | undefined>>(() => {
    const map: Record<string, string | undefined> = {};
    for (const c of row.companies ?? []) if (c.department_id) map[c.company_id] = c.department_id;
    if (!row.companies?.length && row.company_id && row.department_id) map[row.company_id] = row.department_id;
    return map;
  });
  const [limit, setLimit] = useState<Money | null>(row.amount_limit_minor && row.amount_limit_minor !== '0' ? money(row.amount_limit_minor) : null);
  const [extraPerms, setExtraPerms] = useState<Permission[]>((row.extra_permissions ?? []) as Permission[]);
  const [deniedPerms, setDeniedPerms] = useState<Permission[]>((row.denied_permissions ?? []) as Permission[]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [allDepts, setAllDepts] = useState<{ _id: string; name: string; company_id: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await apiCall<{ items: { _id: string; name: string; company_id: string; active?: boolean }[] }>('/departments');
        if (!cancelled) setAllDepts(r.items.filter((d) => d.active !== false).map((d) => ({ _id: d._id, name: d.name, company_id: String(d.company_id) })));
      } catch {
        if (!cancelled) setAllDepts([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const companyOptions = useMemo(() => (companies.data?.items ?? []).map((c) => ({ label: c.name, value: c._id })), [companies.data]);
  const companyLabel = (cid: string): string => companyOptions.find((o) => o.value === cid)?.label ?? cid;
  const deptOptionsFor = (cid: string): { label: string; value: string }[] =>
    allDepts.filter((d) => d.company_id === cid).map((d) => ({ label: d.name, value: d._id }));

  const roleDefaults = useMemo(() => permissionsForRole((role || 'staff') as Role), [role]);

  const permissionState = (p: Permission): { checked: boolean; override: 'extra' | 'denied' | null } => {
    const isDefault = roleDefaults.includes(p);
    const isChecked = isDefault ? !deniedPerms.includes(p) : extraPerms.includes(p);
    const override = isChecked === isDefault ? null : isChecked ? 'extra' : 'denied';
    return { checked: isChecked, override };
  };

  const togglePermission = (p: Permission): void => {
    const isDefault = roleDefaults.includes(p);
    const { checked } = permissionState(p);
    if (checked) {
      if (isDefault) setDeniedPerms((d) => [...d, p]);
      else setExtraPerms((e) => e.filter((x) => x !== p));
    } else {
      if (isDefault) setDeniedPerms((d) => d.filter((x) => x !== p));
      else setExtraPerms((e) => [...e, p]);
    }
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await apiCall(`/personnel/${row.user_id}`, {
        method: 'PATCH',
        body: {
          display_name: name.trim(),
          company_ids: companyIds,
          departments: Object.fromEntries(companyIds.map((cid) => [cid, deptByCompany[cid] ?? null])),
          role,
          amount_limit_minor: limit ? moneyToWire(limit).minor : '0',
          extra_permissions: extraPerms,
          denied_permissions: deniedPerms,
        },
      });
      toastOk('Đã cập nhật hồ sơ nhân sự');
      onDone();
      onClose();
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setError(e.problem.detail ?? e.problem.title);
        setFieldErrors(e.problem.errors ?? {});
      } else setError('Không lưu được hồ sơ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <FgModal open title={`Sửa hồ sơ · ${row.display_name}`} onCancel={onClose} onOk={() => void submit()} okText="Lưu" confirmLoading={busy} width={640}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)', paddingTop: 8 }}>
        <FgField label="Họ tên" required error={fieldErrors.display_name ?? null}>
          <FgInput value={name} onChange={(e: { target: { value: string } }) => setName(e.target.value)} placeholder="Nguyễn Văn A" />
        </FgField>
        <FgField label="Email (định danh đăng nhập — không đổi được)">
          <FgInput value={row.email} readOnly disabled />
        </FgField>
        <FgField label="Công ty" required error={fieldErrors.company_ids ?? fieldErrors.company_id ?? null}>
          <FgMultiSelect
            options={companyOptions}
            value={companyIds}
            onChange={(v) => {
              setCompanyIds(v);
              setDeptByCompany((prev) => {
                const next: Record<string, string | undefined> = {};
                for (const cid of v) next[cid] = prev[cid];
                return next;
              });
            }}
            placeholder="Chọn một hoặc nhiều công ty"
            disabled={!canMoveCompany}
            style={{ width: '100%' }}
          />
          {!canMoveCompany ? (
            <FgText style="caption" color="muted">
              Bạn không có quyền chuyển công ty — liên hệ Chủ tịch/Quản trị hệ thống
            </FgText>
          ) : null}
        </FgField>
        <FgField label="Vai trò (phân quyền)" required>
          <FgSelect
            options={Object.entries(ROLES_LABEL).map(([value, label]) => ({ label, value }))}
            value={role}
            onChange={(v) => {
              const next = v ?? 'staff';
              if (next !== role) {
                setExtraPerms([]);
                setDeniedPerms([]);
              }
              setRole(next);
            }}
            style={{ width: '100%' }}
          />
          {['chief_accountant', 'deputy_director', 'director', 'chairman', 'admin'].includes(role) ? (
            <FgText style="caption" color="muted">
              Vai trò này thuộc nhóm bắt buộc 2FA — người dùng tự bật Xác thực 2 lớp trong Cài đặt.
            </FgText>
          ) : null}
        </FgField>
        {companyIds.map((cid) => (
          <FgField key={cid} label={`Bộ phận · ${companyLabel(cid)} (tùy chọn)`}>
            <FgSelect
              options={deptOptionsFor(cid)}
              value={deptByCompany[cid]}
              onChange={(v) => setDeptByCompany((prev) => ({ ...prev, [cid]: v }))}
              placeholder="Chọn bộ phận"
              allowClear
              disabled={!canMoveCompany}
              style={{ width: '100%' }}
            />
          </FgField>
        ))}
        <FgField label="Hạn mức duyệt (VND, tùy chọn)">
          <FgMoneyInput value={limit} onChange={setLimit} ariaLabel="Hạn mức duyệt" />
        </FgField>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 'var(--fg-font-body-s-size)', color: 'var(--fg-text-secondary)', fontWeight: 500 }}>
            Phân quyền chi tiết
          </label>
          <FgText style="caption" color="muted">
            Tick sẵn theo vai trò. Tick thêm = cấp quyền ngoài vai trò; bỏ tick = thu hồi quyền của vai trò.
          </FgText>
          <div
            style={{
              display: 'grid',
              gap: 'var(--fg-space-3)',
              maxHeight: 320,
              overflowY: 'auto',
              border: '1px solid var(--fg-border-subtle)',
              borderRadius: 'var(--fg-radius-md)',
              padding: 'var(--fg-space-3)',
              marginTop: 8,
            }}
          >
            {PERMISSION_GROUPS.map((group) => (
              <div key={group.key}>
                <FgText style="bodyS" strong>
                  {group.label}
                </FgText>
                <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
                  {group.permissions.map((p) => {
                    const { checked, override } = permissionState(p);
                    return (
                      <div key={p} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Checkbox checked={checked} onChange={() => togglePermission(p)}>
                          <span style={{ fontSize: 'var(--fg-font-body-s-size)' }}>{PERMISSION_LABEL[p]}</span>
                        </Checkbox>
                        {override === 'extra' ? <FgTag tone="info">cấp thêm</FgTag> : null}
                        {override === 'denied' ? <FgTag tone="attention">thu hồi</FgTag> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        {error ? <FgAlert tone="danger" title={error} /> : null}
      </div>
    </FgModal>
  );
}

/* ================= ADM-06/07 ================= */

/** Màn "Công ty & bộ phận" — tạo/sửa công ty con + pháp nhân Tập đoàn, quản bộ phận. */
export function CompaniesScreen(): ReactNode {
  const { can } = useAuth();
  const query = useCompanies();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<CompanyRow | null>(null);

  return (
    <>
      <AdminNav />
      <FgPageHeader
        title="Công ty & bộ phận"
        meta="1 Tập đoàn → nhiều công ty con · ngưỡng tiền tối thiểu · bộ phận dùng khi mời nhân sự"
        actions={
          can('admin:settings') ? (
            <FgButton
              variant="primary"
              onClick={() => {
                setEditing(null);
                setModalOpen(true);
              }}
            >
              + Thêm công ty
            </FgButton>
          ) : null
        }
      />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={4} cols={6} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState
                glyph="▤"
                title="Chưa có công ty nào"
                description="Tạo pháp nhân Tập đoàn và các công ty con để bắt đầu mời nhân sự."
              />
            </div>
          ) : (
            <>
              <div className="fg-card" style={{ padding: 0 }}>
                <FgTable
                  rowKey="_id"
                  dataSource={data.items}
                  columns={[
                    { title: 'Mã', dataIndex: 'code', key: 'code', render: (v: string) => <span className="fg-mono">{v}</span> },
                    {
                      title: 'Tên',
                      dataIndex: 'name',
                      key: 'name',
                      render: (v: string, r: CompanyRow) => (
                        <span>
                          <FgText strong>{v}</FgText>
                          {r.is_group ? <> <FgTag tone="info">Tập đoàn</FgTag></> : null}
                        </span>
                      ),
                    },
                    { title: 'MST', dataIndex: 'tax_code', key: 'tax', render: (v: string | null) => v ?? '—' },
                    {
                      title: 'Ngưỡng tiền tối thiểu',
                      dataIndex: 'min_balance',
                      key: 'mb',
                      align: 'right',
                      render: (v: string | undefined) => <FgMoney value={v ?? '0'} mode="compact" />,
                    },
                    {
                      title: 'Trạng thái',
                      dataIndex: 'status',
                      key: 'st',
                      render: (v: string) => (
                        <FgTag tone={v === 'active' ? 'success' : 'attention'}>{v === 'active' ? 'Đang hoạt động' : 'Tạm dừng'}</FgTag>
                      ),
                    },
                    {
                      title: '',
                      key: 'act',
                      render: (_v: unknown, r: CompanyRow) =>
                        can('admin:settings') ? (
                          <FgButton
                            size="small"
                            onClick={() => {
                              setEditing(r);
                              setModalOpen(true);
                            }}
                          >
                            Sửa
                          </FgButton>
                        ) : null,
                    },
                  ]}
                />
              </div>
              <DepartmentsCard companies={data.items} />
            </>
          )
        }
      </FgQuery>
      <CompanyModal open={modalOpen} editing={editing} onClose={() => setModalOpen(false)} />
    </>
  );
}

/** Modal thêm/sửa công ty — upsert theo `code` (mã bất biến sau khi tạo). */
function CompanyModal({ open, editing, onClose }: { open: boolean; editing: CompanyRow | null; onClose: () => void }): ReactNode {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [taxCode, setTaxCode] = useState('');
  const [address, setAddress] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [isGroup, setIsGroup] = useState('false');
  const [minBalance, setMinBalance] = useState<Money | null>(null);
  const [status, setStatus] = useState('active');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? '');
    setCode(editing?.code ?? '');
    setTaxCode(editing?.tax_code ?? '');
    setAddress(editing?.address ?? '');
    setContactEmail(editing?.contact_email ?? '');
    setIsGroup(editing?.is_group ? 'true' : 'false');
    setMinBalance(editing?.min_balance ? money(editing.min_balance) : null);
    setStatus(editing?.status ?? 'active');
    setError(null);
    setFieldErrors({});
  }, [open, editing]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await apiCall('/admin/companies', {
        method: 'POST',
        body: {
          name: name.trim(),
          code: code.trim().toUpperCase(),
          tax_code: taxCode.trim() || undefined,
          address: address.trim() || undefined,
          contact_email: contactEmail.trim() || undefined,
          is_group: isGroup === 'true',
          min_balance_minor: minBalance ? moneyToWire(minBalance).minor : '0',
          status,
        },
      });
      await qc.invalidateQueries({ queryKey: ['companies'] });
      toastOk(editing ? 'Đã cập nhật công ty' : 'Đã tạo công ty');
      onClose();
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setError(e.problem.detail ?? e.problem.title);
        setFieldErrors(e.problem.errors ?? {});
      } else setError('Không lưu được công ty');
    } finally {
      setBusy(false);
    }
  };

  return (
    <FgModal
      open={open}
      title={editing ? `Sửa công ty · ${editing.code}` : 'Thêm công ty'}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={editing ? 'Lưu' : 'Tạo công ty'}
      confirmLoading={busy}
      width={560}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)', paddingTop: 8 }}>
        <FgField label="Tên công ty" required error={fieldErrors.name ?? null}>
          <FgInput value={name} onChange={(e: { target: { value: string } }) => setName(e.target.value)} placeholder="Công ty TNHH …" />
        </FgField>
        <FgField label="Mã công ty" required error={fieldErrors.code ?? null} hint="Viết HOA, không dấu cách, tối đa 12 ký tự (VD: MP, AP, HH)">
          <FgInput
            value={code}
            onChange={(e: { target: { value: string } }) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC"
            disabled={Boolean(editing)}
          />
        </FgField>
        <FgField label="Mã số thuế" error={fieldErrors.tax_code ?? null}>
          <FgInput value={taxCode} onChange={(e: { target: { value: string } }) => setTaxCode(e.target.value)} placeholder="0301234567" />
        </FgField>
        <FgField label="Địa chỉ">
          <FgInput value={address} onChange={(e: { target: { value: string } }) => setAddress(e.target.value)} placeholder="Số … đường …" />
        </FgField>
        <FgField label="Email liên hệ" error={fieldErrors.contact_email ?? null}>
          <FgInput value={contactEmail} onChange={(e: { target: { value: string } }) => setContactEmail(e.target.value)} placeholder="info@congty.vn" />
        </FgField>
        <FgField label="Pháp nhân cấp Tập đoàn (nhóm)">
          <FgSelect
            options={[
              { label: 'Không — đây là công ty con', value: 'false' },
              { label: 'Có — pháp nhân Tập đoàn', value: 'true' },
            ]}
            value={isGroup}
            onChange={(v) => setIsGroup(v ?? 'false')}
            style={{ width: '100%' }}
          />
        </FgField>
        <FgField label="Ngưỡng tiền tối thiểu (VND)" help="Dưới ngưỡng → cảnh báo đỏ trên dashboard/dòng tiền">
          <FgMoneyInput value={minBalance} onChange={setMinBalance} ariaLabel="Ngưỡng tiền tối thiểu" />
        </FgField>
        <FgField label="Trạng thái">
          <FgSelect
            options={[
              { label: 'Đang hoạt động', value: 'active' },
              { label: 'Tạm dừng', value: 'suspended' },
            ]}
            value={status}
            onChange={(v) => setStatus(v ?? 'active')}
            style={{ width: '100%' }}
          />
        </FgField>
        {error ? <FgAlert tone="danger" title={error} /> : null}
      </div>
    </FgModal>
  );
}

/** ADM-07 — bộ phận theo công ty (dùng khi mời nhân sự). */
function DepartmentsCard({ companies }: { companies: CompanyRow[] }): ReactNode {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [companyId, setCompanyId] = useState<string | undefined>(companies[0]?._id);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useDepartments(companyId);

  useEffect(() => {
    if (!companyId && companies[0]) setCompanyId(companies[0]._id);
  }, [companies, companyId]);

  const add = async (): Promise<void> => {
    if (!companyId || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiCall('/admin/departments', {
        method: 'POST',
        body: { company_id: companyId, name: name.trim(), code: code.trim() || undefined },
      });
      setName('');
      setCode('');
      await qc.invalidateQueries({ queryKey: ['departments'] });
      toastOk('Đã tạo bộ phận');
    } catch (e) {
      setError(e instanceof ApiRequestError ? (e.problem.detail ?? e.problem.title) : 'Không tạo được bộ phận');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (row: DepartmentRow, active: boolean): Promise<void> => {
    setRowBusy(row._id);
    setError(null);
    try {
      await apiCall(`/admin/departments/${row._id}/${active ? 'activate' : 'deactivate'}`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['departments'] });
      toastOk(active ? 'Đã dùng lại bộ phận' : 'Đã ngừng dùng bộ phận');
    } catch (e) {
      setError(e instanceof ApiRequestError ? (e.problem.detail ?? e.problem.title) : 'Không cập nhật được bộ phận');
    } finally {
      setRowBusy(null);
    }
  };

  const remove = async (row: DepartmentRow): Promise<void> => {
    if (!window.confirm(`Xoá bộ phận "${row.name}"? Chỉ xoá được khi bộ phận chưa từng được dùng.`)) return;
    setRowBusy(row._id);
    setError(null);
    try {
      await apiCall(`/admin/departments/${row._id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['departments'] });
      toastOk('Đã xoá bộ phận');
    } catch (e) {
      setError(e instanceof ApiRequestError ? (e.problem.detail ?? e.problem.title) : 'Không xoá được bộ phận');
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <FgCard style={{ marginTop: 'var(--fg-space-4)' }}>
      <FgText style="body" strong as="div">
        Bộ phận theo công ty
      </FgText>
      <FgText style="caption" color="muted">
        Bộ phận dùng để phân nhóm nhân sự khi mời tài khoản.
      </FgText>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 'var(--fg-space-3)' }}>
        <FgField label="Công ty">
          <FgSelect
            options={companies.map((c) => ({ label: `${c.code} · ${c.name}`, value: c._id }))}
            value={companyId}
            onChange={setCompanyId}
            style={{ width: 280 }}
          />
        </FgField>
        <FgField label="Tên bộ phận" required>
          <FgInput value={name} onChange={(e: { target: { value: string } }) => setName(e.target.value)} placeholder="Kế toán" />
        </FgField>
        <FgField label="Mã (tùy chọn)">
          <FgInput value={code} onChange={(e: { target: { value: string } }) => setCode(e.target.value)} placeholder="KT" />
        </FgField>
        <FgButton variant="primary" disabled={!can('admin:settings') || busy || !companyId || !name.trim()} onClick={() => void add()}>
          + Thêm bộ phận
        </FgButton>
      </div>
      {error ? <FgAlert tone="danger" title={error} /> : null}
      <div style={{ marginTop: 'var(--fg-space-3)' }}>
        <FgQuery query={query} skeleton={<FgSkeletonTable rows={3} cols={3} />}>
          {(data) =>
            !data.items.length ? (
              <FgEmptyState glyph="◇" title="Công ty chưa có bộ phận" description="Thêm bộ phận để phân nhóm nhân sự." />
            ) : (
              <div className="fg-card" style={{ padding: 0 }}>
                <FgTable
                  rowKey="_id"
                  dataSource={data.items}
                  pagination={false}
                  columns={[
                    { title: 'Tên', dataIndex: 'name', key: 'n', render: (v: string) => <FgText strong>{v}</FgText> },
                    { title: 'Mã', dataIndex: 'code', key: 'c', render: (v: string | null) => v ?? '—' },
                    { title: 'Trạng thái', dataIndex: 'active', key: 'a', render: (v: boolean | undefined) => (v === false ? 'Ngừng' : 'Đang dùng') },
                    {
                      title: '',
                      key: 'act',
                      render: (_v, r) => (
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {can('admin:settings') ? (
                            <FgButton size="small" loading={rowBusy === r._id} onClick={() => void setActive(r, r.active === false)}>
                              {r.active === false ? 'Dùng lại' : 'Ngừng dùng'}
                            </FgButton>
                          ) : null}
                          {can('admin:settings') ? (
                            <FgButton size="small" variant="danger" loading={rowBusy === r._id} onClick={() => void remove(r)}>
                              Xoá
                            </FgButton>
                          ) : null}
                        </div>
                      ),
                    },
                  ]}
                />
              </div>
            )
          }
        </FgQuery>
      </div>
    </FgCard>
  );
}

/* ================= ADM-04 ================= */

/** Cấp duyệt hợp lệ trong ma trận (bỏ `staff`/`admin` — không phải cấp duyệt). */
const MATRIX_ROLE_OPTIONS = APPROVAL_ORDER.map((r) => ({ value: r, label: ROLES_LABEL[r] ?? r }));

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function MatrixScreen(): ReactNode {
  const { can } = useAuth();
  const query = useMatrix();
  const companies = useCompanies();
  const [preview, setPreview] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<MatrixEntry | null>(null);
  const canEdit = can('admin:matrix');
  const openNew = (): void => {
    setEditing(null);
    setModalOpen(true);
  };
  return (
    <>
      <AdminNav />
      <FgPageHeader
        title="Ma trận duyệt"
        meta="Ngưỡng tiền → chuỗi cấp duyệt — cấu hình được, thay đổi luôn vào audit"
        actions={canEdit ? <FgButton variant="primary" onClick={openNew}>+ Thêm quy trình</FgButton> : null}
      />
      <FgQuery query={query} skeleton={<FgSkeletonTable rows={6} cols={5} />}>
        {(data) =>
          !data.items.length ? (
            <div className="fg-card">
              <FgEmptyState
                glyph="◇"
                title="Chưa cấu hình quy trình nào"
                description={
                  canEdit
                    ? 'Thêm một dải ngưỡng tiền → chuỗi cấp duyệt. Khi không cấu hình, hệ thống dùng quy trình mặc định.'
                    : 'Bạn không có quyền admin:matrix — liên hệ Quản trị.'
                }
              />
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
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <FgButton size="small" onClick={() => setPreview(preview === r._id ? null : r._id)}>
                          {preview === r._id ? 'Đóng' : 'Xem trước'}
                        </FgButton>
                        {canEdit ? (
                          <FgButton
                            size="small"
                            variant="primary"
                            onClick={() => {
                              setEditing(r);
                              setModalOpen(true);
                            }}
                          >
                            Sửa
                          </FgButton>
                        ) : null}
                      </div>
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
      <MatrixModal open={modalOpen} editing={editing} companies={companies.data?.items ?? []} onClose={() => setModalOpen(false)} />
    </>
  );
}

/** ADM-04 — thêm/sửa một dải ngưỡng tiền → chuỗi cấp duyệt (upsert theo công ty + loại phiếu + ngưỡng dưới). */
function MatrixModal({
  open,
  editing,
  companies,
  onClose,
}: {
  open: boolean;
  editing: MatrixEntry | null;
  companies: CompanyRow[];
  onClose: () => void;
}): ReactNode {
  const save = useMatrixUpsert();
  const [companyId, setCompanyId] = useState('');
  const [docKinds, setDocKinds] = useState<DocKind[]>(['spend']);
  const [amountMin, setAmountMin] = useState<Money | null>(null);
  const [amountMax, setAmountMax] = useState<Money | null>(null);
  const [effectiveFrom, setEffectiveFrom] = useState(todayISO());
  const [steps, setSteps] = useState<{ role: string; sla_hours: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    setCompanyId(editing?.company_id ?? '');
    setDocKinds(editing ? [editing.doc_kind as DocKind] : ['spend']);
    setAmountMin(editing ? money(editing.amount_min_minor) : null);
    setAmountMax(editing?.amount_max_minor ? money(editing.amount_max_minor) : null);
    setEffectiveFrom(editing?.effective_from ? editing.effective_from.slice(0, 10) : todayISO());
    setSteps(
      editing
        ? editing.steps.map((s) => ({ role: s.role, sla_hours: s.sla_hours }))
        : [
            { role: 'chief_accountant', sla_hours: 24 },
            { role: 'deputy_director', sla_hours: 24 },
          ],
    );
    setError(null);
    setFieldErrors({});
  }, [open, editing]);

  const usedRoles = steps.map((s) => s.role);
  const addStep = (): void => {
    const next = APPROVAL_ORDER.find((r) => !usedRoles.includes(r));
    if (next) setSteps([...steps, { role: next, sla_hours: 24 }]);
  };
  const removeStep = (i: number): void => setSteps(steps.filter((_s, idx) => idx !== i));
  const setStep = (i: number, patch: Partial<{ role: string; sla_hours: number }>): void =>
    setSteps(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

  const submit = async (): Promise<void> => {
    setError(null);
    setFieldErrors({});
    if (!editing && !docKinds.length) {
      setError('Chọn ít nhất một loại phiếu');
      return;
    }
    if (!steps.length) {
      setError('Quy trình phải có ít nhất một cấp duyệt');
      return;
    }
    if (new Set(usedRoles).size !== usedRoles.length) {
      setError('Mỗi cấp chỉ được xuất hiện một lần trong quy trình');
      return;
    }
    const minMinor = amountMin ? moneyToWire(amountMin).minor : '0';
    const maxMinor = amountMax ? moneyToWire(amountMax).minor : undefined;
    if (maxMinor && BigInt(maxMinor) <= BigInt(minMinor)) {
      setFieldErrors({ amount_max_minor: 'Ngưỡng trên phải lớn hơn ngưỡng dưới' });
      return;
    }
    const kinds: DocKind[] = editing ? [editing.doc_kind as DocKind] : docKinds;
    const body = {
      company_id: companyId || null,
      amount_min_minor: minMinor,
      amount_max_minor: maxMinor,
      steps: steps.map((s, i) => ({ order: i + 1, role: s.role, sla_hours: s.sla_hours, mandatory: true })),
      effective_from: effectiveFrom,
    };
    setBusy(true);
    try {
      for (const doc_kind of kinds) {
        await save.mutateAsync({ ...body, doc_kind });
      }
      toastOk(editing ? 'Đã cập nhật ma trận duyệt' : `Đã tạo ${kinds.length} quy trình`);
      onClose();
    } catch (e) {
      if (e instanceof ApiRequestError) {
        setError(e.problem.detail ?? e.problem.title);
        setFieldErrors(e.problem.errors ?? {});
      } else setError('Không lưu được ma trận duyệt');
    } finally {
      setBusy(false);
    }
  };

  return (
    <FgModal
      open={open}
      title={editing ? 'Sửa quy trình duyệt' : 'Thêm quy trình duyệt'}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={editing ? 'Lưu' : 'Tạo quy trình'}
      confirmLoading={busy}
      width={640}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--fg-space-4)', paddingTop: 8 }}>
        <FgField label="Áp dụng cho" hint="Để trống = áp dụng toàn tập đoàn">
          <FgSelect
            options={companies.map((c) => ({ label: `${c.code} · ${c.name}`, value: c._id }))}
            value={companyId || undefined}
            onChange={(v) => setCompanyId(v ?? '')}
            placeholder="Toàn tập đoàn"
            allowClear
            style={{ width: '100%' }}
          />
        </FgField>
        <FgField
          label="Loại phiếu"
          required
          error={fieldErrors.doc_kind ?? null}
          help={editing ? 'Loại phiếu không đổi khi sửa — tạo quy trình mới nếu cần đổi.' : 'Chọn một hoặc nhiều loại — mỗi loại tạo một dòng ma trận.'}
        >
          {editing ? (
            <FgText strong>{DOC_KIND_LABEL[editing.doc_kind as DocKind] ?? editing.doc_kind}</FgText>
          ) : (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {DOC_KINDS.map((k) => (
                <Checkbox
                  key={k}
                  checked={docKinds.includes(k)}
                  onChange={(e) =>
                    setDocKinds(e.target.checked ? [...docKinds, k] : docKinds.filter((x) => x !== k))
                  }
                >
                  {DOC_KIND_LABEL[k]}
                </Checkbox>
              ))}
            </div>
          )}
        </FgField>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1 }}>
            <FgField label="Ngưỡng dưới (VND)" hint="Từ mức này trở lên">
              <FgMoneyInput value={amountMin} onChange={setAmountMin} ariaLabel="Ngưỡng dưới" />
            </FgField>
          </div>
          <div style={{ flex: 1 }}>
            <FgField label="Ngưỡng trên (VND)" error={fieldErrors.amount_max_minor ?? null} hint="Bỏ trống = không chặn trên">
              <FgMoneyInput value={amountMax} onChange={setAmountMax} ariaLabel="Ngưỡng trên" />
            </FgField>
          </div>
        </div>
        <FgField label="Hiệu lực từ" required>
          <FgInput
            type="date"
            value={effectiveFrom}
            onChange={(e: { target: { value: string } }) => setEffectiveFrom(e.target.value)}
            style={{ width: 200 }}
          />
        </FgField>
        <FgField
          label="Chuỗi cấp duyệt"
          required
          error={fieldErrors.steps ?? null}
          help="Từ cấp thấp đến cấp cao — hai bước KT nội bộ (lập → kiểm tra) luôn có sẵn ở mọi quy trình."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {steps.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="fg-muted" style={{ width: 18, textAlign: 'right' }}>
                  {i + 1}.
                </span>
                <FgSelect
                  options={MATRIX_ROLE_OPTIONS}
                  value={s.role}
                  onChange={(v) => setStep(i, { role: v ?? s.role })}
                  style={{ flex: 1 }}
                />
                <FgInput
                  type="number"
                  min={1}
                  max={720}
                  value={String(s.sla_hours)}
                  onChange={(e: { target: { value: string } }) => setStep(i, { sla_hours: Math.max(1, Number(e.target.value) || 1) })}
                  style={{ width: 100 }}
                  addonAfter="giờ"
                />
                <FgButton size="small" variant="danger" disabled={steps.length <= 1} onClick={() => removeStep(i)}>
                  Xoá
                </FgButton>
              </div>
            ))}
            <div>
              <FgButton size="small" disabled={steps.length >= APPROVAL_ORDER.length} onClick={addStep}>
                + Thêm cấp
              </FgButton>
            </div>
          </div>
        </FgField>
        {error ? <FgAlert tone="danger" title={error} /> : null}
      </div>
    </FgModal>
  );
}

/* ================= ADM-12 ================= */

export function AuditLogScreen(): ReactNode {
  const [page, setPage] = useState(1);
  const query = useAuditLog(page);
  return (
    <>
      <AdminNav />
      <FgPageHeader title="Audit log" meta="" />
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

/**
 * DOC-01 — Hồ sơ chi tiết (drawer desktop / trang mobile). Route /ho-so/{chi|thu|dao-han|noi-bo}/:id
 *
 * - Header: FgMoney full + FgStatusChip (bàn ai + chờ N ngày) + overdue chip.
 * - 5 tab: Tóm tắt (decision-pack) · Chứng từ · Lịch sử duyệt · Dòng tiền liên quan · Audit.
 * - Action bar CUỐI trang chứa số tiền trong nhãn nút; chỉ hiện khi `can.approve`… (server tính).
 * - 409 → modal "ai vừa duyệt lúc nào" (approve-modal). Thiếu chứng từ → FG-WF-003 alert.
 * - Keyboard-only: Tab tới nút; Alt+D duyệt · Alt+X từ chối · Ctrl+Enter gửi confirm (DS §10).
 * - Read-only khi đã qua cấp (`can.edit=false`) — hiện lý do bị chặn (`can.reason`).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  EVIDENCE_LABEL,
  ACTION_LABEL,
  dateTimeLabel,
  deadlineLabel,
  formatMoney,
  isDeadlinePast,
  money,
  moneyFromWire,
  type EvidenceType,
} from '@fingate/shared';
import { useDecisionPack, useDocument } from '../app/queries.ts';
import type { DocumentDetail } from '../app/types.ts';
import { FgAlert, FgButton, FgField, FgInput, FgMoney, FgPassword, FgStatusChip, FgText, FgTooltip } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgModal, FgSkeletonParagraphs, FgSkeletonTable, FgTable, FgTabs } from '../components/uitk.tsx';
import { FgApprovalTimeline, FgDecisionPack, OwnerLine, directionOf } from '../components/finance.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery } from '../components/pagekit.tsx';
import { useAuth } from '../app/store.tsx';
import { ApprovalConfirmModal, useTransitionRunner } from './approve-modal.tsx';
import { AUDIT_ACTION_LABEL, ROLES_LABEL } from '../components/labels.ts';
import { ApiRequestError, apiCall } from '../app/api.ts';

const KIND_PATH: Record<string, string> = { spend: 'chi', income: 'thu', rollover: 'dao-han', internal: 'noi-bo' };
const KIND_LIST_PATH: Record<string, string> = { spend: '/chi', income: '/thu', rollover: '/ngan-hang/dao-han', internal: '/ngan-hang/chuyen-noi-bo' };
const KIND_EDIT_PATH: Record<string, string> = { spend: '/chi', income: '/thu', rollover: '/ngan-hang/dao-han/phuong-an', internal: '/ngan-hang/chuyen-noi-bo' };

export function DocumentDetailScreen(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const back = params.get('from');
  const query = useDocument(id);
  const runner = useTransitionRunner();
  const [confirmAction, setConfirmAction] = useState<null | string>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const doc = query.data;

  /* shortcuts duyệt (DS §10) — chỉ khi có quyền approve */
  useEffect(() => {
    if (!doc?.can.approve) return;
    const h = (e: KeyboardEvent) => {
      if (e.altKey && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        setConfirmAction('approve');
      }
      if (e.altKey && (e.key === 'x' || e.key === 'X')) {
        e.preventDefault();
        setConfirmAction('reject');
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [doc?.can.approve, doc?._id]);

  return (
    <FgQuery
      query={query}
      skeleton={
        <>
          <FgSkeletonParagraphs rows={2} />
          <div style={{ height: 'var(--fg-space-4)' }} />
          <FgSkeletonTable rows={4} cols={3} />
        </>
      }
    >
      {(d) => {
        const amount = moneyFromWire(d.amount)!;
        const canAct = d.can.approve || d.can.reject || d.can.request_changes || d.can.submit || d.can.pay || d.can.fast_track;
        const canMaintain = d.can.edit || d.can.delete;
        const showBar = canAct || canMaintain;
        return (
          <>
            {back ? (
              <button
                type="button"
                className="fg-link"
                style={{ all: 'unset', cursor: 'pointer', color: 'var(--fg-text-link)', display: 'inline-block', marginBottom: 8 }}
                onClick={() => navigate(decodeURIComponent(back))}
              >
                ← Quay lại danh sách (giữ nguyên bộ lọc)
              </button>
            ) : null}

            {d.override.fast_tracked ? (
              <div style={{ marginBottom: 'var(--fg-space-3)' }}>
                <div className="fg-stripe-fast">⚡ Hồ sơ được duyệt trước (fast-track) — cấp dưới chưa duyệt đủ. Lý do: {d.override.reason ?? '—'}</div>
              </div>
            ) : null}

            <FgPageHeader
              title={`${d.kind_label} ${d.code}`}
              meta={
                <>
                  {d.company_name} · Tạo bởi {d.created_by_name} · Hạn thanh toán {deadlineLabel(d.planned_date)}
                  {isDeadlinePast(d.planned_date) && !['paid', 'cancelled', 'rejected'].includes(d.status) ? (
                    <span
                      className="fg-chip"
                      style={{ marginLeft: 6, borderColor: 'var(--fg-status-danger-border)', color: 'var(--fg-status-danger-text)', background: 'var(--fg-status-danger-bg)' }}
                    >
                      Quá hạn
                    </span>
                  ) : null}
                  {d.current_owner ? (
                    <>
                      {' '}
                      · <OwnerLine owner={d.current_owner.name} roleLabel={ROLES_LABEL[d.current_owner.role ?? ''] ?? d.current_owner.role} waitingDays={d.waiting_days} />
                    </>
                  ) : null}
                </>
              }
              actions={
                <FgTooltip title={d.can.export ? 'Xuất hồ sơ có watermark' : 'Bạn không có quyền xuất hồ sơ này'}>
                  <FgButton
                    disabled={!d.can.export}
                    onClick={() =>
                      void apiCall('/exports', { method: 'POST', body: { preset: 'ho-so', document_id: d._id } }).catch(() => undefined)
                    }
                  >
                    ⤓ Xuất
                  </FgButton>
                </FgTooltip>
              }
            />

            {/* header hồ sơ: số tiền FULL + status + overdue chip */}
            <FgCard style={{ marginBottom: 'var(--fg-space-4)' }}>
              <div style={{ display: 'flex', gap: 'var(--fg-space-5)', alignItems: 'center', flexWrap: 'wrap' }}>
                <FgMoney value={amount} mode="full" emphasis style={{ fontSize: 'var(--fg-font-number-l-size)', lineHeight: 'var(--fg-font-number-l-line)' }} />
                <FgStatusChip status={d.status} overdue={d.overdue} withOwner waitingDays={d.waiting_days} />
                {d.priority === 'urgent' ? <span className="fg-chip" style={{ borderColor: 'var(--fg-status-danger-border)', color: 'var(--fg-status-danger-text)' }}>Khẩn</span> : null}
                <span style={{ flex: 1 }} />
                <FgText style="bodyS" color="muted">
                  {d.title}
                </FgText>
              </div>
            </FgCard>

            <FgTabs
              items={[
                {
                  key: 'tom-tat',
                  label: 'Tóm tắt',
                  children: <SummaryTab doc={d} />,
                },
                {
                  key: 'chung-tu',
                  label: `Chứng từ (${d.attachments.length}/${d.evidence.required.length})`,
                  children: <EvidenceTab doc={d} />,
                },
                {
                  key: 'lich-su',
                  label: 'Lịch sử phê duyệt',
                  children: <HistoryTab doc={d} />,
                },
                {
                  key: 'dong-tien',
                  label: 'Dòng tiền liên quan',
                  children: <CashTab doc={d} />,
                },
                {
                  key: 'audit',
                  label: 'Audit log',
                  children: <AuditTab doc={d} />,
                },
              ]}
            />

            {/* action bar — hiện khi người dùng là cấp xử lý hiện tại */}
            {showBar ? (
              <div className="fg-action-bar fg-no-print" role="toolbar" aria-label="Hành động phê duyệt">
                <FgText style="bodyS" color="muted" >
                  {canAct ? `Bạn xử lý bước ${d.can.step_order ?? ''} · phím tắt: Alt+D duyệt, Alt+X từ chối` : 'Bản nháp / hồ sơ bạn được phép xử lý'}
                </FgText>
                <span style={{ flex: 1 }} />
                {d.can.delete ? (
                  <FgButton variant="danger" onClick={() => setDeleteOpen(true)}>
                    Xoá phiếu
                  </FgButton>
                ) : null}
                {d.can.request_changes ? (
                  <FgButton onClick={() => setConfirmAction('request_changes')}>{ACTION_LABEL.request_changes}</FgButton>
                ) : null}
                {d.can.reject ? (
                  <FgButton variant="danger" onClick={() => setConfirmAction('reject')}>
                    Từ chối
                  </FgButton>
                ) : null}
                {d.can.edit ? (
                  <FgButton onClick={() => navigate(`${KIND_EDIT_PATH[d.kind] ?? '/ho-so'}/${d._id}/sua`)}>Sửa</FgButton>
                ) : null}
                {d.can.submit ? (
                  <FgButton variant="primary" onClick={() => setConfirmAction('submit')}>
                    Gửi duyệt
                  </FgButton>
                ) : null}
                {d.can.pay ? (
                  <FgButton variant="primary" onClick={() => setConfirmAction('pay')}>
                    Thực thi
                  </FgButton>
                ) : null}
                {d.can.fast_track && !d.can.approve ? (
                  <FgButton variant="primary" onClick={() => setConfirmAction('approve_with_reason')}>
                    Duyệt trước {formatMoney(amount, { mode: 'compact' })}
                  </FgButton>
                ) : null}
                {d.can.approve ? (
                  <FgButton variant="primary" onClick={() => setConfirmAction('approve')}>
                    Duyệt khoản {formatMoney(amount, { mode: 'compact' })}
                  </FgButton>
                ) : null}
              </div>
            ) : d.can.reason ? (
              <div style={{ marginTop: 'var(--fg-space-4)' }}>
                <FgAlert tone="neutral" title="Bạn không có hành động nào trên hồ sơ này" description={`${d.can.reason} — hồ sơ đang ở bàn ${d.current_owner?.name ?? d.current_owner?.role ?? 'khác'}.`} />
              </div>
            ) : null}

            {confirmAction && doc ? (
              <ApprovalConfirmModal
                doc={doc}
                action={confirmAction as never}
                onClose={() => setConfirmAction(null)}
                onDone={() => {
                  setConfirmAction(null);
                  void query.refetch();
                }}
              />
            ) : null}
            {deleteOpen && doc ? (
              <DeleteDocumentModal
                doc={doc}
                onClose={() => setDeleteOpen(false)}
                onDone={() => navigate(KIND_LIST_PATH[d.kind] ?? '/chi')}
              />
            ) : null}
            {runner.modals}
          </>
        );
      }}
    </FgQuery>
  );
}

/* ---------------- tabs ---------------- */

function SummaryTab({ doc }: { doc: DocumentDetail }): ReactNode {
  const pack = useDecisionPack(doc._id);
  return (
    <FgQuery query={pack} skeleton={<FgSkeletonTable rows={5} cols={3} />}>
      {(p) => (
        <>
          {doc.kind === 'internal' && doc.target ? (
            <FgAlert
              tone="info"
              title="Chuyển tiền nội bộ — KHÔNG tính vào chi phí / doanh thu"
              description={`Đối ứng: ${doc.company_name} −${formatMoney(moneyFromWire(doc.amount)!, { mode: 'compact' })} → ${doc.target.company_name ?? 'công ty nhận'} +${formatMoney(moneyFromWire(doc.amount)!, { mode: 'compact' })}`}
              style={{ marginBottom: 'var(--fg-space-4)' }}
            />
          ) : null}
          <FgDecisionPack pack={p} direction={directionOf(doc.kind)} />
        </>
      )}
    </FgQuery>
  );
}

function EvidenceTab({ doc }: { doc: DocumentDetail }): ReactNode {
  const { can } = useAuth();
  return (
    <FgCard>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--fg-space-3)' }}>
        <FgText style="h4">Chứng từ bắt buộc: {doc.evidence.required.length}</FgText>
        <FgTooltip title={doc.can.attach ? 'Tải lên: prepare → PUT → confirm' : 'Bạn không có quyền thêm chứng từ vào hồ sơ đã qua bước của mình'}>
          <FgButton size="small" disabled={!doc.can.attach} onClick={() => undefined}>
            + Tải chứng từ lên
          </FgButton>
        </FgTooltip>
      </div>
      {doc.evidence.missing.length ? (
        <FgAlert tone="attention" title={`Thiếu ${doc.evidence.missing.length} chứng từ bắt buộc`} description={doc.evidence.missing.map((t) => EVIDENCE_LABEL[t as EvidenceType] ?? t).join(' · ')} style={{ marginBottom: 12 }} />
      ) : null}
      {doc.attachments.length ? (
        <FgTable
          rowKey="id"
          dataSource={doc.attachments}
          columns={[
            { title: 'Tệp', dataIndex: 'filename', key: 'f' },
            { title: 'Loại', dataIndex: 'type', key: 't', render: (v: string) => EVIDENCE_LABEL[v as EvidenceType] ?? v },
            { title: 'Kích thước', dataIndex: 'size', key: 's', render: (v: number) => `${Math.round(v / 1024)} KB` },
            { title: 'Thêm lúc', dataIndex: 'added_at', key: 'a', render: (v: string) => dateTimeLabel(v) },
            {
              title: '',
              key: 'dl',
              render: (_v: unknown, r: { id: string }) => (
                <FgTooltip title={doc.can.attach || can('doc:read') ? 'Tải về (watermark theo phiên)' : 'Không có quyền tải'}>
                  <FgButton size="small" disabled={!doc.can.export} onClick={() => window.open(`/api/v1/attachments/${r.id}`, '_blank')}>
                    ⤓
                  </FgButton>
                </FgTooltip>
              ),
            },
          ]}
        />
      ) : (
        <FgEmptyState glyph="◇" title="Chưa có chứng từ nào" description="Hồ sơ chỉ chuyển bước khi đủ chứng từ bắt buộc (FG-WF-003)." />
      )}
    </FgCard>
  );
}

function HistoryTab({ doc }: { doc: DocumentDetail }): ReactNode {
  return (
    <div className="fg-card">
      <FgText style="h4">
        Quy trình: {doc.approval.matrix_label ?? 'ma trận duyệt'} · <FgText style="caption" color="muted">bản v{doc.approval.matrix_version}</FgText>
      </FgText>
      <div style={{ marginTop: 'var(--fg-space-4)' }}>
        <FgApprovalTimeline steps={doc.approval.steps} currentRoleLabel={doc.current_owner?.role ?? undefined} />
      </div>
    </div>
  );
}

function CashTab({ doc }: { doc: DocumentDetail }): ReactNode {
  const bal = doc.source.balance_available;
  const amt = moneyFromWire(doc.amount)!;
  // phiếu thu CỘNG tiền, phiếu chi TRỪ tiền vào tài khoản nguồn
  const after = bal ? (doc.kind === 'income' ? money(bal).minor + amt.minor : money(bal).minor - amt.minor) : null;
  return (
    <FgCard>
      <FgText style="h4">Ảnh hưởng số dư</FgText>
      <div style={{ marginTop: 12, maxWidth: 480 }}>
        <div className="fg-stat-row">
          <span className="fg-stat-label">Tài khoản nguồn</span>
          <span>{doc.source.account_label ?? (doc.source.fund === 'cash' ? 'Quỹ tiền mặt' : '—')}</span>
        </div>
        <div className="fg-stat-row">
          <span className="fg-stat-label">Số dư khả dụng</span>
          <FgMoney value={moneyFromWire(bal)} mode="full" missingLabel="Chưa có số dư hôm nay" />
        </div>
        <div className="fg-stat-row">
          <span className="fg-stat-label">Sau giao dịch</span>
          {after !== null ? (
            <FgMoney value={money(after, doc.amount.currency)} mode="full" emphasis />
          ) : (
            '—'
          )}
        </div>
        {doc.kind === 'internal' && doc.target?.company_name ? (
          <div className="fg-stat-row">
            <span className="fg-stat-label">Công ty đối ứng</span>
            <span>{doc.target.company_name}: +{formatMoney(amt, { mode: 'compact' })}</span>
          </div>
        ) : null}
      </div>
    </FgCard>
  );
}

function AuditTab({ doc }: { doc: DocumentDetail }): ReactNode {
  return (
    <FgCard padded={false}>
      <FgTable
        rowKey={(_r, i) => String(i)}
        dataSource={doc.history}
        columns={[
          { title: 'Thời gian', dataIndex: 'at', key: 'at', render: (v: string) => dateTimeLabel(v), width: 170 },
          { title: 'Người', key: 'actor', render: (_v: unknown, r: DocumentDetail['history'][number]) => `${r.actor.name ?? r.actor.role ?? '—'}` },
          { title: 'Hành động', dataIndex: 'action', key: 'action', render: (v: string) => AUDIT_ACTION_LABEL[v] ?? v },
          { title: 'Chuyển trạng thái', key: 'st', render: (_v: unknown, r: DocumentDetail['history'][number]) => (r.from || r.to ? `${r.from ?? ''} → ${r.to ?? ''}` : '—') },
          { title: 'Ý kiến', dataIndex: 'opinion', key: 'op', ellipsis: true, render: (v: string | null) => v ?? '—' },
        ]}
        pagination={false}
      />
    </FgCard>
  );
}

export { KIND_PATH };

/**
 * Modal xoá cứng phiếu thu/chi (yêu cầu ADM-01). Bắt buộc lý do; khi server đòi
 * step-up (FG-AUTH-008) thì hiện ô mật khẩu/OTP và gửi lại kèm `verify`.
 */
function DeleteDocumentModal({ doc, onClose, onDone }: { doc: DocumentDetail; onClose: () => void; onDone: () => void }): ReactNode {
  const [reason, setReason] = useState('');
  const [needVerify, setNeedVerify] = useState(false);
  const [method, setMethod] = useState<'password' | 'otp'>('password');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = reason.trim().length >= 5 && (!needVerify || value.length >= 4);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiCall(`/documents/${doc._id}/delete`, {
        method: 'POST',
        body: {
          reason: reason.trim(),
          ...(needVerify ? { verify: { method, value } } : {}),
        },
      });
      onDone();
    } catch (e) {
      if (e instanceof ApiRequestError) {
        const p = e.problem;
        if ((p.code === 'FG-AUTH-008' || p.data?.need_verify === true) && !needVerify) {
          setNeedVerify(true);
        } else if (p.code === 'FG-AUTH-008') {
          setError('Xác thực không đúng — thử lại.');
        } else {
          setError(p.detail ?? p.title);
        }
      } else {
        setError('Không xoá được phiếu');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <FgModal
      open
      title={`Xoá phiếu ${doc.code}`}
      onCancel={onClose}
      footer={
        <>
          <FgButton onClick={onClose}>Hủy</FgButton>
          <FgButton variant="danger" loading={busy} disabled={!canSubmit} onClick={() => void submit()}>
            Xoá vĩnh viễn
          </FgButton>
        </>
      }
    >
      <FgAlert
        tone="danger"
        title="Xoá vĩnh viễn — không thể khôi phục"
        description="Bản ghi phiếu bị xoá khỏi hệ thống; một dòng audit vẫn được lưu lại. Chỉ xoá được bản nháp của bạn hoặc phiếu đã bị Phó Giám đốc trả lại."
      />
      <div style={{ marginTop: 16 }}>
        <FgField label="Lý do xoá (bắt buộc, vào audit)" error={reason && reason.trim().length < 5 ? 'Tối thiểu 5 ký tự' : null}>
          <FgInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="VD: Nhập trùng, đã tạo phiếu thay thế" />
        </FgField>
      </div>
      {needVerify ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <FgButton size="small" variant={method === 'password' ? 'primary' : 'secondary'} onClick={() => setMethod('password')}>
              Mật khẩu
            </FgButton>
            <FgButton size="small" variant={method === 'otp' ? 'primary' : 'secondary'} onClick={() => setMethod('otp')}>
              OTP 6 số
            </FgButton>
          </div>
          <FgField label={method === 'password' ? 'Mật khẩu' : 'Mã OTP'} error={error}>
            {method === 'password' ? (
              <FgPassword autoFocus value={value} onChange={(e) => setValue(e.target.value)} autoComplete="current-password" />
            ) : (
              <FgInput
                autoFocus
                inputMode="numeric"
                maxLength={6}
                value={value}
                onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
                style={{ letterSpacing: 8, textAlign: 'center', fontFamily: 'var(--fg-font-mono)' }}
              />
            )}
          </FgField>
        </div>
      ) : error ? (
        <div style={{ marginTop: 12 }}>
          <FgAlert tone="danger" title={error} />
        </div>
      ) : null}
    </FgModal>
  );
}

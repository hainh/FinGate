/**
 * DOC-01 — Hồ sơ chi tiết (drawer desktop / trang mobile). Route /ho-so/{chi|thu|dao-han|noi-bo}/:id
 *
 * - Header: FgMoney full + FgStatusChip (bàn ai + chờ N ngày) + overdue chip + badge "Tự động" (phiếu do quy tắc sinh).
 * - Khối v2 (components/voucher-v2): quy trình tự động (lượt, đối tượng sinh ra, chạy lại), đối tác, tag, liên kết.
 * - 6 tab: Tóm tắt (đối tác · tag · 7 câu hỏi) · Chứng từ · Liên kết · Lịch sử duyệt · Dòng tiền liên quan · Audit.
 * - Action bar CUỐI trang chứa số tiền trong nhãn nút; chỉ hiện khi `can.approve`… (server tính).
 * - 409 → modal "ai vừa duyệt lúc nào" (approve-modal). Thiếu chứng từ → FG-WF-003 alert.
 * - Keyboard-only: Tab tới nút; Alt+D duyệt · Alt+X từ chối · Ctrl+Enter gửi confirm (DS §10).
 * - Read-only khi đã qua cấp (`can.edit=false`) — hiện lý do bị chặn (`can.reason`).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import {
  EVIDENCE_LABEL,
  ACTION_LABEL,
  UI,
  dateTimeLabel,
  ddmmyyyy,
  deadlineLabel,
  formatMoney,
  isDeadlinePast,
  moneyFromWire,
  statusLabel,
  type EvidenceType,
  type Money,
} from '@fingate/shared';
import { useBankAccounts, useDecisionPack, useDocument, useRolloverResult } from '../app/queries.ts';
import { interestRateText } from '../app/v2/debts.ts';
import type { DocumentDetail, AttachmentRef } from '../app/types.ts';
import { FgAlert, FgButton, FgField, FgInput, FgMoney, FgMoneyInput, FgPassword, FgStatusChip, FgText, FgTextarea, FgTooltip } from '../components/primitives.tsx';
import { FgCard } from '../components/cards.tsx';
import { FgEmptyState, FgModal, FgSkeletonParagraphs, FgSkeletonTable, FgTable, FgTabs } from '../components/uitk.tsx';
import { AttachmentDeleteModal, AttachmentPreviewModal, AttachmentRow, AttachmentUploadModal, problemText } from '../components/attachments.tsx';
import { FgApprovalTimeline, FgDecisionPack, OwnerLine, directionOf } from '../components/finance.tsx';
import { AutomationPanel, LinksTab, LoanBanner, OffsetBanner, PartnerCard, TagsCard } from '../components/voucher-v2.tsx';
import { FgPageHeader } from '../components/shell.tsx';
import { FgQuery, useToast } from '../components/pagekit.tsx';
import { ApprovalConfirmModal, useTransitionRunner } from './approve-modal.tsx';
import { ROLES_LABEL, documentHistoryActionLabel } from '../components/labels.ts';
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
        const canAct = d.can.approve || d.can.reject || d.can.request_changes || d.can.submit || d.can.pay || d.can.fast_track || !!d.can.queue_payment;
        const canMaintain = d.can.edit || d.can.delete || !!d.can.cancel;
        const showBar = canAct || canMaintain;
        const activeLinks = (d.links ?? []).filter((l) => l.status === 'active').length;
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
                <div className="fg-stripe-fast">
                  ⚡{' '}
                  {(() => {
                    // v2 §7.2: nhãn "Đã duyệt trước bởi <vai trò>" — lấy từ bước đã duyệt vượt cấp
                    const by = (d.approval?.steps ?? []).filter((s) => s.state === 'done' && s.fast_tracked).map((s) => ROLES_LABEL[s.role] ?? s.role);
                    return by.length ? `Đã duyệt trước bởi ${by.join(', ')}` : 'Hồ sơ được duyệt trước (vượt cấp)';
                  })()}{' '}
                  — cấp dưới chưa duyệt đủ. Lý do: {d.override.reason ?? '—'}
                </div>
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
            />

            {/* header hồ sơ: số tiền FULL + status + overdue chip + nguồn gốc (thủ công / tự động) */}
            <FgCard style={{ marginBottom: 'var(--fg-space-4)' }}>
              <div style={{ display: 'flex', gap: 'var(--fg-space-5)', alignItems: 'center', flexWrap: 'wrap' }}>
                <FgMoney value={amount} mode="full" emphasis style={{ fontSize: 'var(--fg-font-number-l-size)', lineHeight: 'var(--fg-font-number-l-line)' }} />
                <FgStatusChip status={d.status} overdue={d.overdue} withOwner waitingDays={d.waiting_days} />
                {d.origin?.kind === 'automation' ? (
                  <span className="fg-chip" aria-label="Phiếu do quy trình tự động sinh ra">
                    {UI.link.autoBy(d.origin.rule_code ?? 'tự động')}
                  </span>
                ) : null}
                {d.priority === 'urgent' ? <span className="fg-chip" style={{ borderColor: 'var(--fg-status-danger-border)', color: 'var(--fg-status-danger-text)' }}>Khẩn</span> : null}
                <span style={{ flex: 1 }} />
                <FgText style="bodyS" color="muted">
                  {d.title}
                </FgText>
              </div>
            </FgCard>

            <AutomationPanel doc={d} />

            {d.kind === 'rollover' ? <RolloverResultCard doc={d} onChanged={() => void query.refetch()} /> : null}

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
                  children: <EvidenceTab doc={d} onChanged={() => void query.refetch()} />,
                },
                {
                  key: 'lien-ket',
                  label: `Liên kết (${activeLinks})`,
                  children: <LinksTab doc={d} />,
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
                  {canAct
                    ? `${d.can.step_order != null ? `Bạn xử lý bước ${d.can.step_order}` : 'Bạn xử lý hồ sơ này'} · phím tắt: Alt+D duyệt, Alt+X từ chối`
                    : 'Bản nháp / hồ sơ bạn được phép xử lý'}
                </FgText>
                <span style={{ flex: 1 }} />
                {d.can.delete ? (
                  <FgButton variant="danger" onClick={() => setDeleteOpen(true)}>
                    Xoá phiếu
                  </FgButton>
                ) : null}
                {d.can.cancel ? (
                  // v2 §7.1: Nháp / Yêu cầu bổ sung / Đã duyệt → Huỷ (lý do bắt buộc, xem ApprovalConfirmModal)
                  <FgButton variant="danger" onClick={() => setConfirmAction('cancel')}>
                    Hủy hồ sơ
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
                {d.can.queue_payment ? (
                  // v2 §7.1: DaDuyet → DangThanhToan; sau đó "Thực thi" (DangThanhToan → DaThanhToan)
                  <FgButton onClick={() => setConfirmAction('queue_payment')}>Đưa vào hàng thanh toán</FgButton>
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

/** Chuyển tiền nội bộ: đích theo ID (`transfer_target`); phiếu cũ còn `target` (v1). Null nếu không có. */
function transferInfo(doc: DocumentDetail): { name: string } | null {
  if (!doc.transfer_target && !doc.target) return null;
  return { name: doc.transfer_target?.company_name ?? doc.target?.company_name ?? 'công ty nhận' };
}

function SummaryTab({ doc }: { doc: DocumentDetail }): ReactNode {
  const pack = useDecisionPack(doc._id);
  const transfer = transferInfo(doc);
  const amountMoney = moneyFromWire(doc.amount)!;
  return (
    <>
      {doc.options?.loan ? <LoanBanner loan={doc.options.loan} style={{ marginBottom: 'var(--fg-space-4)' }} /> : null}
      {doc.options?.offset ? <OffsetBanner offset={doc.options.offset} status={doc.status} style={{ marginBottom: 'var(--fg-space-4)' }} /> : null}
      {doc.kind === 'internal' && transfer ? (
        <FgAlert
          tone="info"
          title="Chuyển tiền nội bộ — KHÔNG tính vào chi phí / doanh thu"
          description={`Đối ứng: ${doc.company_name} −${formatMoney(amountMoney, { mode: 'compact' })} → ${transfer.name} +${formatMoney(amountMoney, { mode: 'compact' })}`}
          style={{ marginBottom: 'var(--fg-space-4)' }}
        />
      ) : doc.kind === 'spend' && transfer ? (
        <FgAlert
          tone="info"
          title="Chuyển tiền nội bộ trong tập đoàn"
          description={`Từ ${doc.company_name} → ${transfer.name}: ${formatMoney(amountMoney, { mode: 'full' })}. Khi phiếu chi được duyệt xong và thực thi, hệ thống tự động tạo phiếu thu tương ứng tại công ty nhận và tự duyệt — KHÔNG tính vào chi phí / doanh thu.`}
          style={{ marginBottom: 'var(--fg-space-4)' }}
        />
      ) : null}
      <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', marginBottom: 'var(--fg-space-4)' }}>
        <PartnerCard doc={doc} />
        <TagsCard doc={doc} />
      </div>
      <FgQuery query={pack} skeleton={<FgSkeletonTable rows={5} cols={3} />}>
        {(p) => <FgDecisionPack pack={p} direction={directionOf(doc.kind)} />}
      </FgQuery>
    </>
  );
}

function EvidenceTab({ doc, onChanged }: { doc: DocumentDetail; onChanged: () => void }): ReactNode {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [preview, setPreview] = useState<AttachmentRef | null>(null);
  const [remove, setRemove] = useState<AttachmentRef | null>(null);
  return (
    <FgCard>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 'var(--fg-space-3)' }}>
        <FgText style="h4">Chứng từ bắt buộc: {doc.evidence.required.length}</FgText>
        <FgTooltip title={doc.can.attach ? 'Tải lên ảnh hoặc PDF (tối đa 25 MB)' : 'Bạn không có quyền thêm chứng từ vào hồ sơ đã qua bước của mình'}>
          <FgButton size="small" disabled={!doc.can.attach} onClick={() => setUploadOpen(true)}>
            + Tải chứng từ lên
          </FgButton>
        </FgTooltip>
      </div>
      {doc.evidence.missing.length ? (
        <FgAlert tone="attention" title={`Thiếu ${doc.evidence.missing.length} chứng từ bắt buộc`} description={doc.evidence.missing.map((t) => EVIDENCE_LABEL[t as EvidenceType] ?? t).join(' · ')} style={{ marginBottom: 12 }} />
      ) : null}
      {doc.attachments.length ? (
        <div role="list" aria-label="Danh sách chứng từ">
          {doc.attachments.map((a) => (
            <AttachmentRow
              key={a.id}
              att={a}
              canAttach={doc.can.attach}
              onPreview={() => setPreview(a)}
              onRemove={() => setRemove(a)}
            />
          ))}
        </div>
      ) : (
        <FgEmptyState glyph="◇" title="Chưa có chứng từ nào" description="Hồ sơ chỉ chuyển bước khi đủ chứng từ bắt buộc (FG-WF-003)." />
      )}
      {uploadOpen ? (
        <AttachmentUploadModal
          doc={doc}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            setUploadOpen(false);
            onChanged();
          }}
        />
      ) : null}
      {preview ? <AttachmentPreviewModal att={preview} onClose={() => setPreview(null)} /> : null}
      {remove ? (
        <AttachmentDeleteModal
          doc={doc}
          att={remove}
          onClose={() => setRemove(null)}
          onDone={() => {
            setRemove(null);
            onChanged();
          }}
        />
      ) : null}
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
  const pack = useDecisionPack(doc._id);
  const accounts = useBankAccounts();
  const acc = (accounts.data?.items ?? []).find((a) => a._id === (doc.source.account_id ?? ''));
  const amt = moneyFromWire(doc.amount)!;
  // số dư sổ cái hiện tại của tài khoản nguồn/đích (v2 bỏ "khả dụng" — dùng `balance`)
  const available = moneyFromWire(acc?.balance);
  // sau giao dịch: server tính theo sổ cái (đã xử lý phiếu đã thực thi, không đếm trùng)
  const after = pack.data ? moneyFromWire(pack.data.q6_impact.balance_after) : null;
  const transfer = transferInfo(doc);
  return (
    <FgCard>
      <FgText style="h4">Ảnh hưởng số dư</FgText>
      <div style={{ marginTop: 12, maxWidth: 480 }}>
        <div className="fg-stat-row">
          <span className="fg-stat-label">{doc.kind === 'income' ? 'Tài khoản đích' : 'Tài khoản nguồn'}</span>
          <span>{acc?.label ?? (doc.source.fund === 'cash' ? 'Quỹ tiền mặt' : '—')}</span>
        </div>
        <div className="fg-stat-row">
          <span className="fg-stat-label">Số dư hiện có</span>
          <FgMoney value={available} mode="full" missingLabel="Chưa có số dư" />
        </div>
        <div className="fg-stat-row">
          <span className="fg-stat-label">Sau giao dịch</span>
          {after !== null ? (
            <FgMoney value={after} mode="full" emphasis />
          ) : (
            '—'
          )}
        </div>
        {transfer && (doc.kind === 'internal' || doc.kind === 'spend') ? (
          <div className="fg-stat-row">
            <span className="fg-stat-label">Công ty đối ứng</span>
            <span>{transfer.name}: +{formatMoney(amt, { mode: 'compact' })}</span>
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
          { title: 'Thời gian', dataIndex: 'at', key: 'at', render: (v: string) => dateTimeLabel(v) },
          { title: 'Người', key: 'actor', render: (_v: unknown, r: DocumentDetail['history'][number]) => `${r.actor.name ?? r.actor.role ?? '—'}` },
          { title: 'Hành động', dataIndex: 'action', key: 'action', render: (v: string) => documentHistoryActionLabel(v) },
          {
            title: 'Chuyển trạng thái',
            key: 'st',
            // trạng thái lưu dạng mã (pending.ktt, changes_requested…) → nhãn tiếng Việt
            render: (_v: unknown, r: DocumentDetail['history'][number]) =>
              r.from || r.to ? `${r.from ? statusLabel(r.from) : ''} → ${r.to ? statusLabel(r.to) : ''}` : '—',
          },
          {
            title: 'Chi tiết',
            key: 'detail',
            // "Sửa tag": nêu tên tag được thêm / bỏ (fields.added / fields.removed, v2 §6.2)
            render: (_v: unknown, r: DocumentDetail['history'][number]) => historyDetailText(r),
          },
          { title: 'Ý kiến', dataIndex: 'opinion', key: 'op', ellipsis: true, render: (v: string | null) => v ?? '—' },
        ]}
        pagination={false}
      />
    </FgCard>
  );
}

/** Tên các tag trong `fields.added` / `fields.removed` của lịch sử `tags_update` (mỗi phần tử `{ id, name }`). */
function tagNamesIn(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => {
    if (x && typeof x === 'object') return String((x as { name?: unknown }).name ?? '').trim() || 'tag không rõ tên';
    return String(x);
  });
}

/** Chi tiết một dòng lịch sử hồ sơ: với "Sửa tag" nêu tên tag thêm / bỏ; các dòng khác để trống ("—"). */
function historyDetailText(entry: Pick<DocumentDetail['history'][number], 'action' | 'fields'>): string {
  // gộp đối tác: đổi đối tác của phiếu (fields.changes.<trường> = {from, to} là nhãn "mã · tên" của hai đối tác)
  if (entry.action === 'partner.merge') {
    const change = Object.values((entry.fields?.changes ?? {}) as Record<string, { from?: unknown; to?: unknown }>)[0];
    return typeof change?.from === 'string' && typeof change?.to === 'string' ? `Đối tác: ${change.from} → ${change.to}` : '—';
  }
  if (entry.action !== 'tags_update') return '—';
  const added = tagNamesIn(entry.fields?.added);
  const removed = tagNamesIn(entry.fields?.removed);
  const parts: string[] = [];
  if (added.length) parts.push(`Thêm: ${added.join(', ')}`);
  if (removed.length) parts.push(`Bỏ: ${removed.join(', ')}`);
  return parts.join(' · ') || '—';
}

export { KIND_PATH };

/**
 * Tác động của việc xoá phiếu, hiển thị trong modal (server vẫn là nguồn thật, §8 & §14.3):
 * phiếu đã thực thi ⇒ sổ cái không mất mà được ĐẢO; phiếu đối ứng / đối tượng tự động không tự xoá.
 */
function deleteImpactLines(doc: DocumentDetail): string[] {
  const out: string[] = [];
  if (doc.status === 'paid') {
    out.push('Phiếu đã thực thi: sổ cái KHÔNG bị xoá — hệ thống thêm bút toán đảo cho từng bút toán của phiếu rồi dựng lại số dư tài khoản (sổ cái chỉ thêm, có vết).');
  }
  if (doc.transfer_target) {
    out.push(`Chuyển nội bộ sang ${doc.transfer_target.company_name ?? 'công ty nhận'}: phiếu thu đối ứng ở công ty nhận (nếu đã sinh) KHÔNG tự xoá — cần xử lý riêng.`);
  }
  const generated = (doc.automation_runs ?? []).reduce((n, r) => n + (r.generated?.length ?? 0), 0);
  if (generated) {
    out.push(`Quy trình tự động đã sinh ${generated} đối tượng liên quan (phiếu / khoản vay / nợ): các đối tượng này KHÔNG tự xoá — cần xử lý riêng.`);
  }
  const activeLinks = (doc.links ?? []).filter((l) => l.status === 'active').length;
  if (activeLinks) out.push(`${activeLinks} liên kết còn hiệu lực sẽ được gỡ (ghi lý do “Phiếu nguồn đã bị xoá”).`);
  return out;
}

/**
 * Modal xoá cứng phiếu thu/chi (yêu cầu ADM-01). Bắt buộc lý do; khi server đòi
 * step-up (FG-AUTH-008) thì hiện ô mật khẩu/OTP và gửi lại kèm `verify`.
 */
function DeleteDocumentModal({ doc, onClose, onDone }: { doc: DocumentDetail; onClose: () => void; onDone: () => void }): ReactNode {
  const impact = deleteImpactLines(doc);
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
        description="Bản ghi phiếu bị xoá khỏi hệ thống; một dòng audit vẫn được lưu lại. Chủ tịch / Tổng Giám đốc xoá được ở bất kỳ trạng thái nào, không giới hạn phiếu còn nháp hay chưa ai duyệt. Phiếu đã bị từ chối thì Kế toán trưởng / Kế toán viên đều xoá được; các trạng thái khác chỉ người lập xoá được khi phiếu còn nháp, đang chờ Kế toán trưởng hoặc bị trả về bổ sung — và chưa qua cấp Kế toán trưởng trở lên ở vòng duyệt này."
      />
      {impact.length ? (
        <ul style={{ marginTop: 12, paddingLeft: 18, display: 'grid', gap: 6, fontSize: 13 }} aria-label="Tác động của việc xoá phiếu">
          {impact.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
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

/* ======================= RENEW-04 · kết quả thực hiện đảo hạn ======================= */

function RolloverResultCard({ doc, onChanged }: { doc: DocumentDetail; onChanged: () => void }): ReactNode {
  const mutation = useRolloverResult(doc._id);
  const { message } = useToast();
  const existing = doc.rollover?.result ?? null;
  const [doneAt, setDoneAt] = useState(existing?.done_at ?? '');
  // Ngày đáo hạn mới: hạn thanh toán của khoản vay được cập nhật theo (v2 §10.3).
  const [newMaturity, setNewMaturity] = useState(existing?.new_maturity_date ?? doc.rollover?.new_maturity_date ?? '');
  const [contract, setContract] = useState(existing?.new_contract_code ?? '');
  const [limit, setLimit] = useState<Money | null>(existing?.new_limit ? moneyFromWire(existing.new_limit) : null);
  // lãi suất hiển thị theo dấu phẩy (9,5); gửi đi đổi lại dấu chấm (contract new_rate chỉ nhận dấu chấm)
  const [rate, setRate] = useState(interestRateText(existing?.new_rate));
  const [fee, setFee] = useState<Money | null>(existing?.actual_fee ? moneyFromWire(existing.actual_fee) : null);
  const [note, setNote] = useState(existing?.note ?? '');
  // đúng quyền của server (POST /documents/:id/rollover-result): rollover:act, phiếu đã duyệt / đã thực thi
  const canSubmit = doc.can.rollover_result === true;

  const submit = async (): Promise<void> => {
    if (!doneAt) {
      message.error('Nhập ngày thực hiện');
      return;
    }
    if (!newMaturity) {
      message.error('Nhập ngày đáo hạn mới');
      return;
    }
    if (!contract.trim()) {
      message.error('Nhập số hợp đồng mới');
      return;
    }
    if (!limit || limit.minor <= 0n) {
      message.error('Nhập hạn mức mới');
      return;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(rate.replace(',', '.'))) {
      message.error('Lãi suất mới không hợp lệ');
      return;
    }
    try {
      await mutation.mutateAsync({
        done_at: doneAt,
        new_maturity_date: newMaturity,
        new_contract_code: contract.trim(),
        new_limit: { amount_minor: limit.minor.toString(), currency: limit.currency },
        new_rate: interestRateText(rate),
        actual_fee: { amount_minor: (fee?.minor ?? 0n).toString(), currency: fee?.currency ?? limit.currency },
        note: note.trim() || undefined,
        if_match: doc.version,
        request_id: crypto.randomUUID(),
      });
      message.success('Đã cập nhật kết quả đảo hạn');
      onChanged();
    } catch (e) {
      message.error(problemText(e, 'Không cập nhật được kết quả'));
    }
  };

  return (
    <FgCard title="Phương án đảo hạn" style={{ marginBottom: 'var(--fg-space-4)' }}>
      <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
        <FgText style="bodyS" color="muted">Phương án: {doc.rollover?.plan ?? '—'}</FgText>
        {doc.rollover?.fee_estimate ? (
          <FgText style="bodyS" color="muted">Phí dự kiến: {formatMoney(moneyFromWire(doc.rollover.fee_estimate) ?? 0n, { mode: 'full' })}</FgText>
        ) : null}
        {existing && !canSubmit ? (
          <>
            <FgText style="bodyS">
              ✓ Đã thực hiện {existing.done_at ? ddmmyyyy(existing.done_at) : '—'} · đáo hạn mới{' '}
              {existing.new_maturity_date ? ddmmyyyy(existing.new_maturity_date) : '—'} · HĐ {existing.new_contract_code ?? '—'} · LS{' '}
              {interestRateText(existing.new_rate) || '—'}%/năm
            </FgText>
            {existing.new_limit ? (
              <FgText style="bodyS" color="muted">Hạn mức mới: {formatMoney(moneyFromWire(existing.new_limit) ?? 0n, { mode: 'full' })}</FgText>
            ) : null}
            {existing.note ? <FgText style="caption" color="muted">{existing.note}</FgText> : null}
          </>
        ) : null}
      </div>
      {canSubmit ? (
        <div style={{ display: 'grid', gap: 'var(--fg-space-3)', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          {/* ngày theo DS §7.8: hiển thị / nhập DD/MM/YYYY; state và gửi đi là YYYY-MM-DD (businessDate) */}
          <FgField label="Ngày thực hiện *">
            <DatePicker
              value={doneAt ? dayjs(doneAt) : null}
              onChange={(d) => setDoneAt(d ? d.format('YYYY-MM-DD') : '')}
              format="DD/MM/YYYY"
              placeholder="DD/MM/YYYY"
              style={{ width: '100%' }}
            />
          </FgField>
          <FgField label="Ngày đáo hạn mới *" help="Hạn thanh toán mới của khoản vay (DD/MM/YYYY)">
            <DatePicker
              value={newMaturity ? dayjs(newMaturity) : null}
              onChange={(d) => setNewMaturity(d ? d.format('YYYY-MM-DD') : '')}
              format="DD/MM/YYYY"
              placeholder="DD/MM/YYYY"
              style={{ width: '100%' }}
            />
          </FgField>
          <FgField label="Số hợp đồng mới *">
            <FgInput value={contract} onChange={(e) => setContract(e.target.value)} placeholder="HĐTD/2026/..." />
          </FgField>
          <FgField label="Hạn mức mới *">
            <FgMoneyInput value={limit} onChange={setLimit} />
          </FgField>
          <FgField label="Lãi suất mới (%/năm) *">
            <FgInput value={rate} onChange={(e) => setRate(e.target.value)} placeholder="9,5" />
          </FgField>
          <FgField label="Phí thực tế">
            <FgMoneyInput value={fee} onChange={setFee} />
          </FgField>
          <div style={{ gridColumn: '1/-1' }}>
            <FgField label="Ghi chú">
              <FgTextarea value={note} onChange={(e) => setNote(e.target.value)} />
            </FgField>
          </div>
          <div style={{ gridColumn: '1/-1' }}>
            <FgButton variant="primary" loading={mutation.isPending} onClick={() => void submit()}>
              Lưu kết quả thực hiện
            </FgButton>
          </div>
        </div>
      ) : null}
    </FgCard>
  );
}

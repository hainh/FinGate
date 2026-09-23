/**
 * Bộ máy DUYỆT (handoff §4 P1/P2, DS §7.14, OVL-02/03/04/13):
 *
 * - Nhút duyệt LUÔN chứa số tiền: "Duyệt khoản 4,80 tỷ".
 * - Confirm 7 câu hỏi (decision-pack — FE zero logic tiền).
 * - Step-up: FG-AUTH-008 / data.need_verify → mật khẩu hoặc OTP → retry kèm verify.
 * - FG-WF-007 → gõ lại đúng số tiền → retry kèm confirm_amount_minor.
 * - 409 FG-WF-011 → hiện "ai vừa sửa lúc nào" + refetch, KHÔNG ghi đè im lặng.
 * - Mutation luôn kèm request_id (idempotency) — api.ts tự thêm.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  formatMoney,
  money,
  moneyFromWire,
  parseMoneyInput,
  cmp,
  statusLabel,
  today,
  ZERO,
} from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useBankAccounts, useDecisionPack, useTransition, type TransitionInput } from '../app/queries.ts';
import type { DocumentDetail, QueueRow } from '../app/types.ts';
import { FgAlert, FgButton, FgField, FgInput, FgMoney, FgPassword, FgSelect, FgStatusChip, FgTextarea, FgText } from '../components/primitives.tsx';
import { FgModal } from '../components/uitk.tsx';
import { FgDecisionPack, directionOf } from '../components/finance.tsx';

/* ================= step-up ================= */

function StepUpModal({
  open,
  onCancel,
  onSubmit,
  busy,
  error,
}: {
  open: boolean;
  onCancel: () => void;
  onSubmit: (v: { method: 'password' | 'otp'; value: string }) => void;
  busy?: boolean;
  error?: string | null;
}): ReactNode {
  const [method, setMethod] = useState<'password' | 'otp'>('password');
  const [value, setValue] = useState('');
  return (
    <FgModal
      open={open}
      title="Xác thực lại để tiếp tục"
      onCancel={onCancel}
      footer={
        <>
          <FgButton onClick={onCancel}>Hủy</FgButton>
          <FgButton variant="primary" loading={busy} disabled={value.length < 4} onClick={() => onSubmit({ method, value })}>
            Xác thực
          </FgButton>
        </>
      }
    >
      <FgAlert tone="info" title="Đây là hành động nhạy cảm — xác minh lại danh tính của bạn." description="Nhập mật khẩu tài khoản hoặc mã OTP từ ứng dụng xác thực." />
      <div style={{ display: 'flex', gap: 8, margin: '16px 0 8px' }}>
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
            autoComplete="one-time-code"
          />
        )}
      </FgField>
    </FgModal>
  );
}

/* ================= runner xử lý error ladder ================= */

export interface RunExtra {
  verify?: { method: 'password' | 'otp'; value: string };
  confirm_amount_minor?: string;
}

export function useTransitionRunner() {
  const transition = useTransition();
  const [stepUp, setStepUp] = useState<null | { input: TransitionInput; extra: RunExtra }>(null);
  const [retype, setRetype] = useState<null | { input: TransitionInput; extra: RunExtra; expected: string }>(null);
  const [conflict, setConflict] = useState<null | { message: string }>(null);
  const [hardError, setHardError] = useState<null | { title: string; detail?: string; code: string }>(null);
  const [stepErr, setStepErr] = useState<string | null>(null);
  // thành công có thể đến MUỘN (sau step-up/gõ lại số tiền) → cờ để caller đóng modal/bước tiếp
  const [success, setSuccess] = useState(0);

  const attempt = async (input: TransitionInput, extra: RunExtra): Promise<boolean> => {
    try {
      await transition.mutateAsync({ ...input, ...extra });
      setSuccess((n) => n + 1);
      return true;
    } catch (e) {
      if (!(e instanceof ApiRequestError)) {
        setHardError({ title: 'Lỗi không xác định', code: 'FG-SYS-001' });
        return false;
      }
      const p = e.problem;
      const needVerify = p.code === 'FG-AUTH-008' || p.data?.need_verify === true;
      if (needVerify && !extra.verify) {
        setStepErr(null);
        setStepUp({ input, extra });
        return false;
      }
      if (needVerify && extra.verify) {
        setStepErr(p.detail ?? 'Xác thực không đúng — thử lại.');
        return false;
      }
      if (p.code === 'FG-WF-007' && !extra.confirm_amount_minor) {
        setRetype({ input, extra, expected: String(p.data?.amount_minor ?? input.confirm_amount_minor ?? '') });
        return false;
      }
      if (p.code === 'FG-WF-011') {
        setConflict({ message: p.detail ?? 'Một người khác vừa cập nhật hồ sơ này.' });
        return false;
      }
      setHardError({ title: p.title, detail: p.detail, code: p.code });
      return false;
    }
  };

  const run = (input: TransitionInput) => void attempt(input, {});
  /** cho bulk: chờ kết quả thật, chỉ tiến bước khi thành công. */
  const runAsync = (input: TransitionInput) => attempt(input, {});

  const modals: ReactNode = (
    <>
      {stepUp ? (
        <StepUpModal
          open
          busy={transition.isPending}
          error={stepErr}
          onCancel={() => setStepUp(null)}
          onSubmit={async (verify) => {
            const okDone = await attempt(stepUp.input, { ...stepUp.extra, verify });
            if (okDone) setStepUp(null);
          }}
        />
      ) : null}
      {retype ? <RetypeAmountModal expected={retype.expected} busy={transition.isPending} onCancel={() => setRetype(null)} onConfirm={async (m) => {
        const okDone = await attempt(retype.input, { ...retype.extra, confirm_amount_minor: m });
        if (okDone) setRetype(null);
      }} /> : null}
      {conflict ? (
        <FgModal
          open
          title="Hồ sơ đã thay đổi"
          okText="Tải lại hồ sơ"
          onOk={() => {
            setConflict(null);
            window.location.reload();
          }}
          onCancel={() => setConflict(null)}
        >
          <FgAlert tone="warning" title="Xung đột phiên bản (FG-WF-011)" description={`${conflict.message} Vui lòng tải lại để xem trạng thái mới nhất — bạn KHÔNG ghi đè lên người đã duyệt.`} />
        </FgModal>
      ) : null}
      {hardError ? (
        <FgModal open title="Không thực hiện được" onCancel={() => setHardError(null)} onOk={() => setHardError(null)} okText="Đã hiểu">
          <FgAlert tone="danger" title={`${hardError.title}`} description={<>{hardError.detail}<div style={{ marginTop: 4, fontFamily: 'var(--fg-font-mono)', fontSize: 11 }}>{hardError.code}</div></>} />
        </FgModal>
      ) : null}
    </>
  );

  return { run, runAsync, success, busy: transition.isPending, modals, conflict };
}

function RetypeAmountModal({
  expected,
  onConfirm,
  onCancel,
  busy,
}: {
  expected: string;
  onConfirm: (minor: string) => void;
  onCancel: () => void;
  busy?: boolean;
}): ReactNode {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const expectedMoney = expected ? money(expected) : ZERO();
  return (
    <FgModal
      open
      title="Xác nhận số tiền"
      onCancel={onCancel}
      okText="Xác nhận"
      onOk={() => {
        try {
          const typed = parseMoneyInput(text);
          if (cmp(typed, expectedMoney) !== 0) {
            setErr('Số tiền nhập lại KHÔNG khớp — đọc kỹ và nhập lại.');
            return;
          }
          onConfirm(typed.minor.toString());
        } catch {
          setErr('Định dạng số tiền không hợp lệ.');
        }
      }}
      confirmLoading={busy}
    >
      <FgAlert
        tone="warning"
        title="Khoản này ngoài ngân sách / vượt ngưỡng — xác nhận có chủ đích."
        description={<>Gõ lại đúng số tiền <strong>{formatMoney(expectedMoney, { mode: 'full' })}</strong> để tiếp tục.</>}
      />
      <div style={{ marginTop: 16 }}>
        <FgField label="Nhập lại số tiền" error={err}>
          <FgInput autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="2,5 tỷ" inputMode="numeric" />
        </FgField>
      </div>
    </FgModal>
  );
}

/* ================= modal xác nhận 7 câu hỏi (OVL-02) ================= */

export function ApprovalConfirmModal({
  doc,
  action,
  onClose,
  onDone,
}: {
  doc: DocumentDetail;
  action: 'approve' | 'reject' | 'request_changes' | 'submit' | 'pay' | 'approve_with_reason' | 'cancel';
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const pack = useDecisionPack(doc._id);
  const runner = useTransitionRunner();
  const [opinion, setOpinion] = useState('');
  const accounts = useBankAccounts();
  // cấp duyệt được đổi tài khoản đích (phiếu thu) / nguồn (phiếu chi) trong phạm vi
  // công ty của phiếu (kể cả tài khoản Tập đoàn) — §VIII/§XXX.
  const canChangeAccount = action === 'approve' || action === 'approve_with_reason';
  const accountOptions = (accounts.data?.items ?? [])
    .filter((a) => a.status === 'active' && a.kind === doc.source.fund && (a.is_group || a.company_id === doc.company_id))
    .map((a) => ({ value: a._id, label: `${a.is_group ? 'Tập đoàn' : (a.company_name ?? '—')} · ${a.bank_name} ${a.account_number_masked}` }));
  const [accountId, setAccountId] = useState<string>(doc.source.account_id ?? '');
  const accountChanged = accountId !== (doc.source.account_id ?? '');
  // "Phiếu chi từng phần": cấp duyệt cuối bật cho phép chi nhiều lần; khi thực thi thì
  // nhập số tiền của kỳ này (mặc định = phần còn lại).
  const [allowPartial, setAllowPartial] = useState(false);
  const [payAmountText, setPayAmountText] = useState('');
  const [payErr, setPayErr] = useState<string | null>(null);
  const partialEnabled = Boolean(doc.execution?.allow_partial);
  const remaining = moneyFromWire(doc.execution?.remaining ?? doc.amount) ?? moneyFromWire(doc.amount)!;
  const pendingOrders = doc.approval.steps.filter((s) => s.state === 'current' || s.state === 'waiting').map((s) => s.order);
  const maxPending = pendingOrders.length ? Math.max(...pendingOrders) : 0;
  const isFinalApprove = doc.can.step_order != null && doc.can.step_order === maxPending;
  // thành công (cả khi retry sau step-up/gõ lại tiền) → đóng confirm
  useEffect(() => {
    if (runner.success > 0) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.success]);
  const needsReason = action === 'reject' || action === 'request_changes' || action === 'approve_with_reason' || action === 'cancel';
  const amount = moneyFromWire(doc.amount)!;
  const label: Record<string, string> = {
    approve: `Duyệt khoản ${formatMoney(amount, { mode: 'compact' })}`,
    approve_with_reason: `Duyệt trước ${formatMoney(amount, { mode: 'compact' })}`,
    reject: 'Từ chối',
    request_changes: 'Yêu cầu bổ sung',
    submit: 'Gửi duyệt',
    pay: `Thực thi ${formatMoney(amount, { mode: 'compact' })}`,
    cancel: 'Hủy hồ sơ',
  };
  const danger = action === 'reject' || action === 'cancel';

  const submit = async () => {
    let execution: TransitionInput['execution'];
    if (action === 'pay') {
      if (partialEnabled) {
        let minorStr = remaining.minor.toString();
        if (payAmountText.trim()) {
          try {
            const typed = parseMoneyInput(payAmountText);
            if (typed.minor <= 0n) {
              setPayErr('Số tiền chi phải lớn hơn 0.');
              return;
            }
            if (typed.minor > remaining.minor) {
              setPayErr('Số tiền chi vượt phần còn lại của phiếu.');
              return;
            }
            minorStr = typed.minor.toString();
          } catch {
            setPayErr('Định dạng số tiền không hợp lệ.');
            return;
          }
        }
        setPayErr(null);
        // thực thi ghi nhận dòng tiền NGAY hôm nay (ngày nghiệp vụ VN)
        execution = { paid_at: today(), actual_amount_minor: minorStr };
      } else {
        execution = { paid_at: today() };
      }
    }
    await runner.runAsync({
      id: doc._id,
      action,
      if_match: doc.version,
      opinion: opinion || undefined,
      // cấp duyệt đổi tài khoản đích/nguồn của phiếu ngay khi duyệt
      source_account_id: canChangeAccount && accountChanged && accountId ? accountId : undefined,
      // approve thường không bắt buộc ý kiến, nhưng khi thiếu chứng từ server
      // cần `reason` >=20 ký tự (FG-WF-004) → gửi kèm để user không phải làm lại.
      reason: needsReason ? opinion : opinion && opinion.trim().length >= 20 ? opinion : undefined,
      allow_partial: action === 'approve' && isFinalApprove && allowPartial ? true : undefined,
      execution,
    });
    // onDone sẽ chạy qua useEffect(runner.success) — kể cả retry muộn
  };

  return (
    <FgModal
      open
      width={860}
      title={
        <span>
          {doc.code} · {statusLabel(doc.status)} — <FgMoney value={amount} mode="compact" />
        </span>
      }
      onCancel={onClose}
      footer={
        <>
          <FgButton onClick={onClose}>Hủy bỏ</FgButton>
          <FgButton
            variant={danger ? 'danger' : 'primary'}
            onClick={submit}
            loading={runner.busy}
            disabled={needsReason && opinion.trim().length < 5}
          >
            {label[action]}
          </FgButton>
        </>
      }
    >
      {action === 'approve_with_reason' ? (
        <div style={{ marginBottom: 12 }}>
          <div className="fg-stripe-fast">⚡ Bạn đang duyệt TRƯỚC cấp dưới chưa xong — lý do sẽ vào audit log và hiển thị cho mọi người.</div>
        </div>
      ) : null}
      {pack.data ? <FgDecisionPack pack={pack.data} direction={directionOf(doc.kind)} /> : <FgText style="bodyS" color="muted">Đang tải 7 câu hỏi kiểm soát…</FgText>}
      {pack.data?.evidence.missing.length ? (
        <div style={{ marginBottom: 12 }}>
          <FgAlert
            tone="warning"
            title={`Thiếu ${pack.data.evidence.missing.length} chứng từ — duyệt cần lý do ≥20 ký tự (bỏ qua có audit)`}
            description="Server chặn FG-WF-003/004 nếu ý kiến quá ngắn hoặc thiếu."
          />
        </div>
      ) : null}
      {canChangeAccount && accountOptions.length ? (
        <div style={{ marginTop: 16 }}>
          <FgField
            label={doc.kind === 'income' ? 'Tài khoản đích' : 'Tài khoản nguồn'}
            help="Đổi ngay khi duyệt — chỉ trong phạm vi công ty của phiếu và tài khoản Tập đoàn"
          >
            <FgSelect
              options={accountOptions}
              value={accountId || undefined}
              onChange={(v) => setAccountId(v ?? '')}
              placeholder="Chọn tài khoản"
              allowClear
              style={{ width: '100%' }}
            />
          </FgField>
        </div>
      ) : null}
      {partialEnabled ? (
        <div style={{ marginTop: 16 }}>
          <FgAlert
            tone="info"
            title="Phiếu chi từng phần — kế toán thực thi nhiều lần tới khi hết"
            description={`Đã chi ${formatMoney(moneyFromWire(doc.execution?.paid ?? doc.amount)!, { mode: 'full' })} · còn ${formatMoney(remaining, { mode: 'full' })}. Mỗi lần thực thi ghi một kỳ vào lịch sử; phiếu chỉ đóng khi chi hết.`}
          />
        </div>
      ) : null}
      {action === 'approve' && isFinalApprove ? (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, fontSize: 13 }}>
          <input type="checkbox" checked={allowPartial} onChange={(e) => setAllowPartial(e.target.checked)} style={{ width: 18, height: 18 }} />
          Cho phép chi từng phần (kế toán thực thi nhiều lần, phiếu chỉ đóng khi chi hết)
        </label>
      ) : null}
      {action === 'pay' && partialEnabled ? (
        <div style={{ marginTop: 16 }}>
          <FgField label="Số tiền chi kỳ này" error={payErr} help={`Bỏ trống = chi hết phần còn lại (${formatMoney(remaining, { mode: 'full' })})`}>
            <FgInput
              autoFocus
              value={payAmountText}
              onChange={(e) => setPayAmountText(e.target.value)}
              placeholder={formatMoney(remaining, { mode: 'compact' })}
              inputMode="numeric"
            />
          </FgField>
        </div>
      ) : null}
      <div style={{ marginTop: 16 }}>
        <FgField
          label={needsReason || pack.data?.evidence.missing.length ? 'Ý kiến / lý do (bắt buộc khi thiếu chứng từ hoặc từ chối — tối thiểu 20 ký tự khi override)' : 'Ý kiến (không bắt buộc)'}
          error={needsReason && opinion && opinion.trim().length < 5 ? 'Cần nêu rõ lý do.' : null}
        >
          <FgTextarea value={opinion} onChange={(e) => setOpinion(e.target.value)} placeholder="VD: Đã đối chiếu hợp đồng 45/2026, phụ lục 1 đầy đủ." />
        </FgField>
      </div>
      {runner.modals}
    </FgModal>
  );
}

/** dùng chung để hiển thị ladder modals ngoài confirm (bulk). */
export function TransitionModals({ runner }: { runner: ReturnType<typeof useTransitionRunner> }): ReactNode {
  return runner.modals;
}

/* ================= duyệt hàng loạt (OVL-03) ================= */

export function BulkApproveModal({ rows, onClose, onDone }: { rows: QueueRow[]; onClose: () => void; onDone: () => void }): ReactNode {
  const runner = useTransitionRunner();
  const [idx, setIdx] = useState(0);
  const [doneCount, setDoneCount] = useState(0);
  const [opinion, setOpinion] = useState('');
  // mọi thành công (kể cả sau step-up/gõ lại tiền) đều tiến qua đây — KHÔNG đếm 2 lần
  useEffect(() => {
    if (runner.success > 0) {
      setDoneCount((c) => c + 1);
      setIdx((i) => (i + 1 < rows.length ? i + 1 : i));
      if (idx + 1 >= rows.length) onDone();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.success]);
  const row = rows[idx];
  if (!row) return null;
  const amount = moneyFromWire(row.amount)!;

  return (
    <FgModal
      open
      title={`Duyệt hàng loạt — hồ sơ ${idx + 1}/${rows.length}`}
      onCancel={onClose}
      footer={
        <>
          <FgButton onClick={onClose}>Dừng</FgButton>
          <FgButton
            variant="primary"
            loading={runner.busy}
            onClick={async () => {
              // không tự tiến — useEffect(runner.success) xử lý khi attempt thành công thật
              await runner.runAsync({ id: row._id, action: 'approve', if_match: row.version, opinion: opinion || undefined });
            }}
          >
            Duyệt {formatMoney(amount, { mode: 'compact' })} · còn {rows.length - idx} hồ sơ
          </FgButton>
        </>
      }
    >
      <div className="fg-stat-row">
        <span className="fg-stat-label">Hồ sơ</span>
        <span>
          <strong>{row.code}</strong> · {row.title} <FgStatusChip status={row.status} />
        </span>
      </div>
      <div className="fg-stat-row">
        <span className="fg-stat-label">Nhận tiền</span>
        <span>{row.payee_name}</span>
      </div>
      <div className="fg-stat-row">
        <span className="fg-stat-label">Số tiền</span>
        <FgMoney value={amount} mode="full" emphasis />
      </div>
      <div className="fg-stat-row">
        <span className="fg-stat-label">Đã duyệt trong phiên</span>
        <span className="fg-num">{doneCount} hồ sơ</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <FgField label="Ý kiến chung (áp dụng cho tất cả)">
          <FgInput value={opinion} onChange={(e) => setOpinion(e.target.value)} placeholder="VD: Đối chiếu hợp đồng ngày 15/8, đủ hồ sơ." />
        </FgField>
      </div>
      <FgText style="caption" color="muted">
        Nếu một hồ sơ cần bước xác thực (OTP / gõ lại số tiền) hoặc bị người khác duyệt trước, quá trình dừng lại để bạn xử lý từng cái — không ghi đè im lặng.
      </FgText>
      {runner.modals}
    </FgModal>
  );
}

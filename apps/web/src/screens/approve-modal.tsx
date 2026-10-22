/**
 * Bộ máy DUYỆT (handoff §4 P1/P2, DS §7.14, OVL-02/03/04/13):
 *
 * - Nhút duyệt LUÔN chứa số tiền: "Duyệt khoản 4,80 tỷ".
 * - Confirm 7 câu hỏi (decision-pack — FE zero logic tiền).
 * - Step-up: FG-AUTH-008 / data.need_verify → mật khẩu hoặc OTP → retry kèm verify.
 * - FG-WF-007 → gõ lại đúng số tiền → retry kèm confirm_amount_minor (khoản lớn / ngoài ngân sách,
 *   hoặc tăng số tiền phiếu chi — v2 §6.3). confirm_amount_minor CHỈ gửi sau khi người duyệt đã gõ lại.
 * - 409 FG-WF-011 → hiện "ai vừa sửa lúc nào" + refetch, KHÔNG ghi đè im lặng.
 * - Mutation luôn kèm request_id (idempotency) — api.ts tự thêm.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { DatePicker } from 'antd';
import dayjs from 'dayjs';
import {
  formatMoney,
  money,
  moneyFromWire,
  parseMoneyInput,
  statusLabel,
  today,
  ZERO,
  type Money,
} from '@fingate/shared';
import { ApiRequestError } from '../app/api.ts';
import { useBankAccounts, useDecisionPack, useTransition, type TransitionInput } from '../app/queries.ts';
import type { DocumentDetail, QueueRow } from '../app/types.ts';
import { FgAlert, FgButton, FgField, FgInput, FgMoney, FgPassword, FgSelect, FgStatusChip, FgTextarea, FgText } from '../components/primitives.tsx';
import { FgModal } from '../components/uitk.tsx';
import { FgDecisionPack, directionOf } from '../components/finance.tsx';
import { LoanBanner } from '../components/voucher-v2.tsx';
import { bankAccountOptionLabel, hasAutoLoanRun } from '../app/v2/documents.ts';
import { checkRetypedAmount } from '../app/v2/amount-retype.ts';

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
  const [retype, setRetype] = useState<null | { input: TransitionInput; extra: RunExtra; expected: string; increaseFrom: string | null }>(null);
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
      // FG-WF-007: khoản lớn / ngoài ngân sách, hoặc TĂNG số tiền (server kèm previous_amount_minor) → gõ lại trước khi gửi lại
      if (p.code === 'FG-WF-007' && !(extra.confirm_amount_minor ?? input.confirm_amount_minor)) {
        setRetype({
          input,
          extra,
          expected: String(p.data?.amount_minor ?? ''),
          increaseFrom: p.data?.previous_amount_minor != null ? String(p.data.previous_amount_minor) : null,
        });
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
      {retype ? (
        <RetypeAmountModal
          expected={retype.expected ? money(retype.expected) : ZERO()}
          increaseFrom={retype.increaseFrom ? money(retype.increaseFrom) : null}
          busy={transition.isPending}
          onCancel={() => setRetype(null)}
          onConfirm={async (m) => {
            const okDone = await attempt(retype.input, { ...retype.extra, confirm_amount_minor: m });
            if (okDone) setRetype(null);
          }}
        />
      ) : null}
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

/**
 * Gõ lại đúng số tiền để xác nhận. Hai trường hợp dùng chung một modal:
 * - `increaseFrom` có giá trị: người duyệt TĂNG số tiền phiếu chi (v2 §6.3, §7.2);
 * - không có: khoản lớn > 5 tỷ / ngoài ngân sách (DS §7.14 rule 4, server FG-WF-007).
 * Chỉ gọi `onConfirm` khi số gõ KHỚP `expected`; chưa khớp thì modal giữ nguyên và chưa gửi gì lên server.
 */
function RetypeAmountModal({
  expected,
  increaseFrom,
  onConfirm,
  onCancel,
  busy,
}: {
  /** số tiền phải gõ lại (đúng số tiền hiệu lực sau khi duyệt) */
  expected: Money;
  /** số tiền cũ khi đang tăng số tiền; null/undefined = khoản lớn / ngoài ngân sách */
  increaseFrom?: Money | null;
  onConfirm: (minor: string) => void;
  onCancel: () => void;
  busy?: boolean;
}): ReactNode {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <FgModal
      open
      title={increaseFrom ? 'Xác nhận tăng số tiền' : 'Xác nhận số tiền'}
      onCancel={onCancel}
      okText={increaseFrom ? 'Xác nhận duyệt' : 'Xác nhận'}
      onOk={() => {
        const checked = checkRetypedAmount(text, expected);
        if (!checked.ok) {
          setErr(checked.error);
          return;
        }
        onConfirm(checked.minor);
      }}
      confirmLoading={busy}
    >
      {increaseFrom ? (
        <FgAlert
          tone="warning"
          title="Bạn đang tăng số tiền của phiếu chi"
          description={
            <>
              Từ <strong>{formatMoney(increaseFrom, { mode: 'full' })}</strong> lên <strong>{formatMoney(expected, { mode: 'full' })}</strong>. Gõ lại đúng số tiền
              mới để xác nhận. Thao tác được ghi vào lịch sử phê duyệt và audit log.
            </>
          }
        />
      ) : (
        <FgAlert
          tone="warning"
          title="Khoản này ngoài ngân sách / vượt ngưỡng — xác nhận có chủ đích."
          description={<>Gõ lại đúng số tiền <strong>{formatMoney(expected, { mode: 'full' })}</strong> để tiếp tục.</>}
        />
      )}
      <div style={{ marginTop: 16 }}>
        <FgField label="Nhập lại số tiền" error={err}>
          <FgInput
            autoFocus
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setErr(null);
            }}
            placeholder="2,5 tỷ"
            inputMode="numeric"
          />
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
  action: 'approve' | 'reject' | 'request_changes' | 'submit' | 'pay' | 'queue_payment' | 'approve_with_reason' | 'cancel';
  onClose: () => void;
  onDone: () => void;
}): ReactNode {
  const pack = useDecisionPack(doc._id);
  const runner = useTransitionRunner();
  const [opinion, setOpinion] = useState('');
  const accounts = useBankAccounts(doc.company_id);
  // cấp duyệt được đổi tài khoản đích (phiếu thu) / nguồn (phiếu chi) trong phạm vi
  // công ty của phiếu (server lọc theo for_company — công ty con không dùng được
  // tài khoản Tập đoàn) — §VIII/§XXX.
  const canChangeAccount = action === 'approve' || action === 'approve_with_reason';
  const accountOptions = (accounts.data?.items ?? [])
    .filter((a) => a.status === 'active' && a.kind === doc.source.fund)
    .map((a) => ({ value: a._id, label: bankAccountOptionLabel(a, true) }));
  const [accountId, setAccountId] = useState<string>(doc.source.account_id ?? '');
  const accountChanged = accountId !== (doc.source.account_id ?? '');
  const amount = moneyFromWire(doc.amount)!;
  // Cấp duyệt phiếu chi có thể đổi số tiền; TĂNG so với đề nghị ban đầu phải xác nhận lại.
  // §11.5: đã có lượt R3 (vay để chi) ⇒ số tiền đã khoá; server trả FG-WF-005 nếu vẫn đổi.
  const amountLocked = hasAutoLoanRun(doc.automation_runs);
  const canEditAmount = (action === 'approve' || action === 'approve_with_reason') && doc.kind === 'spend' && !amountLocked;
  const [amountText, setAmountText] = useState('');
  const [amountErr, setAmountErr] = useState<string | null>(null);
  const [amountConfirm, setAmountConfirm] = useState<null | { nextMinor: bigint }>(null);
  // §8 / US-EXE-01 — thực thi phiếu chi: ngày thực tế (mặc định hôm nay, không quá hôm nay), số tham chiếu NH, UNC đính kèm
  const isPay = action === 'pay';
  const [paidAt, setPaidAt] = useState<string>(() => today());
  const [bankRef, setBankRef] = useState('');
  const hasUnc = (doc.attachments ?? []).some((a) => a.type === 'bank_order');
  const payMissing = isPay && doc.kind === 'spend' ? [...(bankRef.trim() ? [] : ['số tham chiếu ngân hàng']), ...(hasUnc ? [] : ['chứng từ UNC (Ủy nhiệm chi)'])] : [];
  // thành công (cả khi retry sau step-up/gõ lại tiền) → đóng confirm
  useEffect(() => {
    if (runner.success > 0) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner.success]);
  const needsReason = action === 'reject' || action === 'request_changes' || action === 'approve_with_reason' || action === 'cancel';
  const label: Record<string, string> = {
    approve: `Duyệt khoản ${formatMoney(amount, { mode: 'compact' })}`,
    approve_with_reason: `Duyệt trước ${formatMoney(amount, { mode: 'compact' })}`,
    reject: 'Từ chối',
    request_changes: 'Yêu cầu bổ sung',
    submit: 'Gửi duyệt',
    pay: `Thực thi ${formatMoney(amount, { mode: 'compact' })}`,
    queue_payment: 'Đưa vào hàng thanh toán',
    cancel: 'Hủy hồ sơ',
  };
  const danger = action === 'reject' || action === 'cancel';

  /** `confirmMinor` chỉ truyền khi người duyệt ĐÃ GÕ LẠI số tiền (tăng số tiền / khoản lớn) — tuyệt đối không echo tự động. */
  const send = async (amountMinor?: string, confirmMinor?: string) => {
    const execution: TransitionInput['execution'] = isPay ? { paid_at: paidAt, bank_ref: bankRef.trim() || undefined } : undefined;
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
      amount_minor: amountMinor,
      // v2 §6.3: xác nhận do người duyệt tự gõ lại (tăng số tiền / khoản lớn), không phải số tự echo
      confirm_amount_minor: confirmMinor,
      execution,
    });
    // onDone sẽ chạy qua useEffect(runner.success) — kể cả retry muộn
  };

  const submit = async () => {
    let amountMinor: string | undefined;
    if (canEditAmount && amountText.trim()) {
      let typed: ReturnType<typeof parseMoneyInput>;
      try {
        typed = parseMoneyInput(amountText);
      } catch {
        setAmountErr('Định dạng số tiền không hợp lệ.');
        return;
      }
      if (typed.minor <= 0n) {
        setAmountErr('Số tiền phải lớn hơn 0.');
        return;
      }
      setAmountErr(null);
      if (typed.minor !== amount.minor) amountMinor = typed.minor.toString();
      if (typed.minor > amount.minor) {
        setAmountConfirm({ nextMinor: typed.minor });
        return;
      }
    }
    await send(amountMinor);
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
            disabled={(needsReason && opinion.trim().length < 5) || payMissing.length > 0}
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
      {/* US-AUTO-04: duyệt phiếu chi vốn vay phải thấy rõ ngân hàng, số tiền và kỳ hạn */}
      {doc.options?.loan ? (
        <div style={{ marginBottom: 12 }}>
          <LoanBanner loan={doc.options.loan} />
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
      {amountLocked && doc.kind === 'spend' && (action === 'approve' || action === 'approve_with_reason') ? (
        <div style={{ marginTop: 16 }}>
          <FgAlert
            tone="attention"
            title="Số tiền đã khoá"
            description="Phiếu này đã sinh khoản vay tự động (R3): số tiền không đổi được khi duyệt. Muốn đổi số tiền phải xử lý khoản vay trước."
          />
        </div>
      ) : null}
      {isPay ? (
        <div style={{ marginTop: 16, display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          <FgField label="Ngày thực chi *" help="Mặc định hôm nay; không chọn ngày sau hôm nay">
            <DatePicker
              value={dayjs(paidAt)}
              onChange={(d) => {
                if (d) setPaidAt(d.format('YYYY-MM-DD'));
              }}
              disabledDate={(d) => d.isAfter(dayjs(), 'day')}
              format="DD/MM/YYYY"
              allowClear={false}
              style={{ width: '100%' }}
            />
          </FgField>
          {doc.kind === 'spend' ? (
            <FgField label="Số tham chiếu ngân hàng *" help="Mã giao dịch trên UNC / sao kê ngân hàng">
              <FgInput value={bankRef} onChange={(e) => setBankRef(e.target.value)} maxLength={80} placeholder="VD: FT26294xxxx" />
            </FgField>
          ) : null}
        </div>
      ) : null}
      {isPay && doc.kind === 'spend' && !hasUnc ? (
        <div style={{ marginTop: 12 }}>
          <FgAlert tone="warning" title="Chưa có chứng từ UNC" description="Đính kèm ủy nhiệm chi (UNC) ở tab Chứng từ của hồ sơ trước khi đánh dấu đã chi." />
        </div>
      ) : null}
      {canEditAmount ? (
        <div style={{ marginTop: 16 }}>
          <FgField
            label="Số tiền duyệt"
            error={amountErr}
            help={`Đề nghị ban đầu: ${formatMoney(amount, { mode: 'full' })}. Bỏ trống = giữ nguyên; tăng số tiền phải gõ lại số mới để xác nhận.`}
          >
            <FgInput
              value={amountText}
              onChange={(e) => {
                setAmountText(e.target.value);
                setAmountErr(null);
              }}
              placeholder={formatMoney(amount, { mode: 'full' })}
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
      {amountConfirm ? (
        <RetypeAmountModal
          expected={money(amountConfirm.nextMinor.toString(), amount.currency)}
          increaseFrom={amount}
          onCancel={() => setAmountConfirm(null)}
          onConfirm={(minor) => {
            // đã gõ lại đúng số mới → gửi số tiền mới kèm đúng số vừa gõ (server đối chiếu cả hai)
            setAmountConfirm(null);
            void send(minor, minor);
          }}
        />
      ) : null}
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

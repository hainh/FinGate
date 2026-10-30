/**
 * FinGate web — khối v2 trên hồ sơ phiếu thu/chi (v2/v2.md §5.2, §6.2, §11.2–11.5, US-AUTO-04/05, §11.2 (3)):
 *
 * - LoanBanner: tuỳ chọn vay trên phiếu ("Chi bằng vốn vay BIDV 2,5 tỷ, kỳ hạn 12 tháng") — dùng ở modal duyệt và hồ sơ.
 * - PartnerCard: đối tác hiện tại (dữ liệu sống theo ID) + "Sửa đối tác" (áp dụng cho mọi nơi đang hiện nó).
 * - TagsCard: tag của phiếu, sửa được cả sau khi duyệt (PATCH /documents/:id/tags, ghi lịch sử).
 * - AutomationPanel: "Quy trình tự động: R3 ✔ — đã tạo NHD-…, PT-… (đã thực thi)"; lượt lỗi có "Chạy lại".
 * - LinksTab: liên kết hai chiều (cấn trừ / trả nợ / giải ngân), gỡ với lý do, gán thêm khi có quyền `link:manage`.
 *
 * Quyền đọc từ hồ sơ (`doc.can.*`, server tính); các nút chỉ hiện khi server cho phép.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  BUSINESS_LINK_RELATION_LABEL,
  LINK_OBJECT_TYPE_LABEL,
  LINK_ORIGIN_LABEL,
  LINK_STATUS_LABEL,
  PARTNER_STATUS_LABEL,
  PARTNER_TYPE_LABEL,
  AUTOMATION_RUN_STATUS_REGISTRY,
  REPAYMENT_METHOD_LABEL,
  REPAYMENT_PERIOD_LABEL,
  UI,
  bankDebtStatusLabel,
  docHref,
  formatMoney,
  money,
  moneyFromWire,
  statusLabel,
  type Money,
  type RepaymentMethodKey,
  type RepaymentPeriod,
} from '@fingate/shared';
import type { DocumentDetail } from '../app/types.ts';
import { useAuth } from '../app/store.tsx';
import { usePartner, usePartnerDebts, usePartnerLoans, debtDirectionOf, type PartnerDebtRow, type PartnerLoanRow } from '../app/v2/partners.ts';
import { interestRateText } from '../app/v2/debts.ts';
import {
  LOAN_DEFAULT_TERM_MONTHS,
  LOAN_OPEN_STATUSES,
  allocatedMinorOf,
  debtDirectionForVoucher,
  generatedObjectText,
  manualLinkRelationsFor,
  useAutomationRuns,
  useCreateDocumentLink,
  useRemoveDocumentLink,
  useRerunAutomationRun,
  useChangeDocumentPartner,
  useSetDocumentTags,
  type AutomationRunView,
  type DocLink,
  type DocLinkCounterpart,
  type DocLoanView,
  type DocOffsetView,
  type DocAccountBorrowView,
  type ManualLinkRelation,
} from '../app/v2/documents.ts';
import { FgAlert, FgButton, FgField, FgInput, FgMoney, FgMoneyInput, FgSelect, FgText, FgToneChip } from './primitives.tsx';
import { FgCard } from './cards.tsx';
import { FgEmptyState, FgModal, FgTable, type TableColumnsType } from './uitk.tsx';
import { PartnerFormModal, PartnerPicker, notifyPartnerWarnings, partnerTypesFor } from './partner-picker.tsx';
import { TagInput } from './tag-input.tsx';
import { problemText } from './attachments.tsx';
import { useToast } from './pagekit.tsx';

/* ================= tuỳ chọn vay ================= */

const periodLabel = (v: string | null): string | null => (v && v in REPAYMENT_PERIOD_LABEL ? REPAYMENT_PERIOD_LABEL[v as RepaymentPeriod] : null);
const methodLabel = (v: string | null): string | null => (v && v in REPAYMENT_METHOD_LABEL ? REPAYMENT_METHOD_LABEL[v as RepaymentMethodKey] : null);
const dayLabel = (v: string | null | undefined): string | null => (v && dayjs(v).isValid() ? dayjs(v).format('DD/MM/YYYY') : null);

/**
 * Tóm tắt khoản vay gắn trên phiếu. Chi bằng vốn vay (R3): "Chi bằng vốn vay <bank> <số tiền>, kỳ hạn <n> tháng".
 * Thu đi vay (R2): khoản nợ ngân hàng là chính phiếu thu này.
 */
export function LoanBanner({ loan, style }: { loan: DocLoanView; style?: CSSProperties }): ReactNode {
  const lender = loan.lender?.name ?? 'ngân hàng';
  const amount = money(loan.effective_amount_minor);
  const term = loan.terms?.term_months ?? LOAN_DEFAULT_TERM_MONTHS;
  const headline =
    loan.kind === 'fund'
      ? `Chi bằng vốn vay ${lender} ${formatMoney(amount, { mode: 'compact' })}, kỳ hạn ${term} tháng`
      : `Phiếu thu đi vay ${lender} — gốc ${formatMoney(amount, { mode: 'compact' })}, kỳ hạn ${term} tháng`;
  const lines: string[] = [];
  if (loan.kind === 'fund') {
    lines.push(`Giải ngân vào: ${loan.receive_account_label ?? 'tài khoản nhận giải ngân'} — khoản vay mới tạo khi phiếu được duyệt`);
  } else if (loan.mode === 'new') {
    lines.push('Khoản vay mới — tạo khi lưu phiếu (chờ giải ngân)');
  } else if (loan.mode === 'existing') {
    lines.push(`Gắn vào khoản vay ${loan.existing_loan?.code ?? ''}${loan.existing_loan ? ` (${bankDebtStatusLabel(loan.existing_loan.status)})` : ''}`.trim());
  } else {
    lines.push('Chưa gắn khoản vay — gán sau từ khoản vay hoặc từ phiếu');
  }
  if (loan.amount_minor === null && loan.kind === 'fund') lines.push('Số tiền vay = số tiền phiếu chi');
  const due = dayLabel(loan.terms?.due_date);
  if (due) lines.push(`Hạn thanh toán: ${due}`);
  if (loan.terms?.contract_no) lines.push(`Số HĐ tín dụng: ${loan.terms.contract_no}`);
  if (loan.terms?.interest_rate) lines.push(`Lãi suất: ${interestRateText(loan.terms.interest_rate)}%/năm`);
  const period = periodLabel(loan.terms?.repayment_period ?? null);
  const method = methodLabel(loan.terms?.repayment_method ?? null);
  if (period || method) lines.push(`Trả nợ: ${[period, method].filter(Boolean).join(' · ')}`);
  if (loan.terms?.collateral) lines.push(`Tài sản bảo đảm: ${loan.terms.collateral}`);
  return (
    <FgAlert
      tone="info"
      title={headline}
      description={
        <span style={{ display: 'grid', gap: 2 }}>
          {lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
      }
      style={style}
    />
  );
}

/* ================= đối tác ================= */

/** Phiếu đã duyệt xong (hoặc sau đó): cấn trừ đã được gán. */
const OFFSET_ASSIGNED_STATUSES: readonly string[] = ['approved', 'processing', 'paid'];
/** Phiếu đã huỷ / từ chối / hết hạn: cấn trừ không còn hiệu lực. */
const OFFSET_RELEASED_STATUSES: readonly string[] = ['cancelled', 'rejected', 'expired'];

/**
 * Phiếu thu / chi cấn trừ khoản vay (R7): khoản đã đánh dấu khi lập phiếu. Trước khi duyệt: sẽ tự gán khi duyệt xong;
 * đã duyệt: đã gán (xem tab Liên kết); huỷ / từ chối: không còn hiệu lực.
 */
export function OffsetBanner({ offset, status, style }: { offset: DocOffsetView; status: string; style?: CSSProperties }): ReactNode {
  const isLoan = offset.target === 'bank_debt';
  const effective = BigInt(offset.effective_amount_minor);
  const interest = BigInt(offset.interest_minor ?? '0');
  const fee = BigInt(offset.fee_minor ?? '0');
  const headline = `Cấn trừ ${isLoan ? 'khoản vay' : 'công nợ'} ${offset.target_code ?? ''} — ${formatMoney(money(effective), { mode: 'compact' })}`;
  const lines: string[] = [];
  if (isLoan && (interest > 0n || fee > 0n)) {
    lines.push(
      `Gốc ${formatMoney(money(effective - interest - fee), { mode: 'compact' })} · lãi ${formatMoney(money(interest), { mode: 'compact' })} · phí ${formatMoney(money(fee), { mode: 'compact' })}`,
    );
  }
  if (OFFSET_RELEASED_STATUSES.includes(status)) lines.push('Phiếu đã huỷ hoặc từ chối — cấn trừ không còn hiệu lực');
  else if (OFFSET_ASSIGNED_STATUSES.includes(status)) lines.push('Đã gán vào khoản này khi phiếu được duyệt xong — xem tab Liên kết');
  else lines.push('Sẽ tự gán vào khoản này khi phiếu được duyệt xong');
  return (
    <FgAlert
      tone={OFFSET_RELEASED_STATUSES.includes(status) ? 'neutral' : 'info'}
      title={headline}
      description={
        <span style={{ display: 'grid', gap: 2 }}>
          {lines.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </span>
      }
      style={style}
    />
  );
}

/**
 * Phiếu chi mượn tiền từ tài khoản khác cùng công ty (R8): khi phiếu được duyệt và thực thi, hệ thống tự sinh phiếu chi
 * từ tài khoản cho mượn sang tài khoản chi và phiếu thu tương ứng (xem tab Liên kết).
 */
export function AccountBorrowBanner({ borrow, status, style }: { borrow: DocAccountBorrowView; status: string; style?: CSSProperties }): ReactNode {
  const released = OFFSET_RELEASED_STATUSES.includes(status);
  const headline = `Mượn tiền từ TK ${borrow.account_label ?? 'khác'} — ${borrow.amount_minor ? formatMoney(money(BigInt(borrow.effective_amount_minor)), { mode: 'compact' }) : 'toàn bộ số thực chi'}`;
  const line = released
    ? 'Phiếu đã huỷ hoặc từ chối — không mượn tiền'
    : status === 'paid'
      ? 'Đã tự tạo phiếu chi từ tài khoản cho mượn và phiếu thu vào tài khoản chi — xem tab Liên kết'
      : 'Khi thực thi, hệ thống tự tạo và thực thi TRƯỚC phiếu chi từ tài khoản cho mượn sang tài khoản chi và phiếu thu tương ứng, rồi mới chi phiếu này. Tài khoản cho mượn phải đủ số tiền mượn (không được âm).';
  return <FgAlert tone={released ? 'neutral' : 'info'} title={headline} description={line} style={style} />;
}

/** Thẻ đối tác: thông tin lấy từ đối tác hiện tại (không lưu bản sao trên phiếu). */
export function PartnerCard({ doc }: { doc: DocumentDetail }): ReactNode {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { notification } = useToast();
  const [editing, setEditing] = useState(false);
  const [changing, setChanging] = useState(false);
  // Bản đầy đủ (có ghi chú) chỉ tải khi mở popup sửa — tránh ghi đè ghi chú bằng rỗng.
  const full = usePartner(editing ? doc.partner_id : null);
  const p = doc.partner ?? null;
  const canEdit = can('partner:write') && !!p;
  const canChange = !!doc.can.partner_change;

  return (
    <FgCard
      title={UI.partner.title}
      extra={
        canEdit || canChange ? (
          <div style={{ display: 'flex', gap: 'var(--fg-space-2)' }}>
            {canChange ? (
              <FgButton size="small" onClick={() => setChanging(true)}>
                Đổi đối tác
              </FgButton>
            ) : null}
            {canEdit ? (
              <FgButton size="small" onClick={() => setEditing(true)}>
                {UI.partner.edit}
              </FgButton>
            ) : null}
          </div>
        ) : null
      }
    >
      {p ? (
        <div style={{ display: 'grid', gap: 'var(--fg-space-2)' }}>
          <FgText style="h4">{p.name}</FgText>
          <FgText style="caption" color="muted">
            {PARTNER_TYPE_LABEL[p.type]} · {p.code}
            {p.status === 'inactive' ? ` · ${PARTNER_STATUS_LABEL.inactive}` : ''}
          </FgText>
          {p.bank_name ? <FgText style="bodyS">Ngân hàng: {p.bank_name}</FgText> : null}
          {p.account_number ? (
            <FgText style="bodyS">
              <span className="fg-num">STK: {p.account_number}</span>
            </FgText>
          ) : null}
          {p.tax_code ? (
            <FgText style="bodyS">
              <span className="fg-num">MST: {p.tax_code}</span>
            </FgText>
          ) : null}
        </div>
      ) : (
        <FgText style="bodyS" color="muted">
          {UI.partner.none} — phiếu cũ chưa gắn đối tác; chọn đối tác trước khi gửi duyệt.
        </FgText>
      )}
      {editing && p && full.data ? (
        <PartnerFormModal
          editing={full.data}
          companyId={doc.company_id}
          onClose={() => setEditing(false)}
          onSaved={(r) => {
            setEditing(false);
            notifyPartnerWarnings(notification, r.warnings);
            void qc.invalidateQueries({ queryKey: ['document'] });
            void qc.invalidateQueries({ queryKey: ['partner'] });
            void qc.invalidateQueries({ queryKey: ['partners'] });
            void qc.invalidateQueries({ queryKey: ['partner-options'] });
          }}
        />
      ) : null}
      {changing ? <ChangePartnerModal doc={doc} onClose={() => setChanging(false)} /> : null}
    </FgCard>
  );
}

/**
 * Chủ tịch đổi lại đối tác (bên nộp tiền của phiếu thu / bên nhận tiền của phiếu chi) — mọi trạng thái, kể cả đã thực thi.
 * Số tiền và sổ cái không đổi; công nợ, số liệu đối tác tính theo đối tác mới. Server kiểm các điều kiện chặn.
 */
function ChangePartnerModal({ doc, onClose }: { doc: DocumentDetail; onClose: () => void }): ReactNode {
  const { message } = useToast();
  const change = useChangeDocumentPartner(doc._id);
  const [picked, setPicked] = useState<string | null>(doc.partner_id ?? null);
  const unchanged = !picked || picked === (doc.partner_id ?? null);

  const save = async (): Promise<void> => {
    if (!picked) return;
    try {
      await change.mutateAsync({ partner_id: picked, if_match: doc.version });
      message.success('Đã đổi đối tác của phiếu');
      onClose();
    } catch (e) {
      message.error(problemText(e, 'Không đổi được đối tác'));
    }
  };

  return (
    <FgModal
      open
      title={`Đổi đối tác — ${doc.code}`}
      onCancel={onClose}
      footer={
        <>
          <FgButton onClick={onClose}>Hủy</FgButton>
          <FgButton variant="primary" loading={change.isPending} disabled={unchanged} onClick={() => void save()}>
            Lưu đối tác
          </FgButton>
        </>
      }
    >
      <FgAlert
        tone="info"
        title="Đổi đối tác không đổi số tiền hay sổ cái"
        description="Công nợ và số liệu của đối tác sẽ tính theo đối tác mới. Phiếu đang gắn khoản vay / cấn trừ hoặc liên kết với đối tác cũ phải gỡ trước."
      />
      <div style={{ marginTop: 16 }}>
        <PartnerPicker
          value={picked}
          onChange={(id) => setPicked(id)}
          allowedTypes={partnerTypesFor(doc.kind === 'income' ? ['bank', 'customer', 'supplier', 'other'] : null)}
          companyId={doc.company_id}
          label={doc.kind === 'income' ? 'Bên nộp tiền' : 'Bên nhận tiền'}
          required
        />
      </div>
    </FgModal>
  );
}

/* ================= tag ================= */

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

/** Tag của phiếu: sửa được cả sau khi duyệt (không ảnh hưởng tiền). Chỉ lưu khi bấm "Lưu tag". */
export function TagsCard({ doc }: { doc: DocumentDetail }): ReactNode {
  const { message } = useToast();
  const setTags = useSetDocumentTags(doc._id);
  const initial = doc.tag_ids ?? [];
  const [draft, setDraft] = useState<string[] | null>(null);
  const value = draft ?? initial;
  const dirty = draft !== null && !sameIds(draft, initial);
  const canTag = !!doc.can.tag;

  const save = async (): Promise<void> => {
    try {
      await setTags.mutateAsync({ tag_ids: value, if_match: doc.version });
      message.success('Đã cập nhật tag của phiếu');
      setDraft(null);
    } catch (e) {
      message.error(problemText(e, 'Không cập nhật được tag'));
    }
  };

  return (
    <FgCard
      title={UI.tag.title}
      extra={
        dirty ? (
          <FgButton size="small" variant="primary" loading={setTags.isPending} onClick={() => void save()}>
            Lưu tag
          </FgButton>
        ) : null
      }
    >
      <TagInput value={value} onChange={(ids) => setDraft(ids)} companyId={doc.company_id} disabled={!canTag} knownTags={doc.tags} ariaLabel="Tag của phiếu" />
      <FgText style="caption" color="muted">
        {canTag
          ? 'Tag là nhãn tự do (dự án, công trình, đợt…).'
          : 'Bạn không có quyền sửa tag của phiếu này.'}
      </FgText>
    </FgCard>
  );
}

/* ================= quy trình tự động ================= */

const RUN_GLYPH: Record<string, string> = { done: '✔', failed: '✕', running: '↻', pending: '○' };

function RunLine({ run, canRerun, onRerun, busy }: { run: AutomationRunView; canRerun: boolean; onRerun: (id: string) => void; busy: boolean }): ReactNode {
  const def = AUTOMATION_RUN_STATUS_REGISTRY[run.status as keyof typeof AUTOMATION_RUN_STATUS_REGISTRY];
  // mục null (phản hồi cũ) bị bỏ: không để một mục hỏng làm sập panel quy trình tự động
  const generated = (run.generated ?? []).filter((g): g is NonNullable<typeof g> => !!g);
  const failedSteps = run.steps.filter((s) => s.status === 'failed');
  const glyph = RUN_GLYPH[run.status] ?? '○';
  return (
    <div style={{ display: 'grid', gap: 4, paddingBottom: 'var(--fg-space-3)', borderBottom: '1px solid var(--fg-border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--fg-space-2)', flexWrap: 'wrap' }}>
        <FgText style="bodyS" strong>
          {UI.automation.title}: {run.rule_code} {glyph}
        </FgText>
        {def ? <FgToneChip tone={def.tone}>{def.labelVi}</FgToneChip> : null}
        <FgText style="caption" color="muted">
          {run.rule_name ?? ''}
        </FgText>
      </div>
      {generated.length ? (
        <FgText style="bodyS">{UI.automation.created(generated.map(generatedObjectText).join(', '))}</FgText>
      ) : run.status === 'done' ? (
        <FgText style="caption" color="muted">
          Không sinh đối tượng mới (lượt đã xử lý trước đó hoặc quy tắc không áp dụng).
        </FgText>
      ) : null}
      {run.status === 'failed' ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <FgAlert
            tone="danger"
            title={UI.automation.failed}
            description={
              <span style={{ display: 'grid', gap: 2 }}>
                {failedSteps.length
                  ? failedSteps.map((s) => (
                      <span key={s.name}>
                        {s.name}: {s.error ?? 'lỗi không rõ'}
                      </span>
                    ))
                  : (run.error ?? 'Lượt chạy lỗi')}
                <span style={{ color: 'var(--fg-text-muted)' }}>{UI.automation.rerunHint}</span>
              </span>
            }
          />
          {canRerun ? (
            <div>
              <FgButton size="small" variant="primary" loading={busy} onClick={() => onRerun(run._id)}>
                {UI.automation.rerun}
              </FgButton>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Panel "Quy trình tự động" trên phiếu: các lượt đã chạy, đối tượng đã sinh (mã + trạng thái), lượt lỗi và nút chạy lại.
 * Không có lượt nào thì không hiện gì.
 */
export function AutomationPanel({ doc }: { doc: DocumentDetail }): ReactNode {
  const { me, can } = useAuth();
  const runs = useAutomationRuns(doc._id);
  const rerun = useRerunAutomationRun(doc._id);
  const { message } = useToast();
  const list = runs.data ?? [];
  if (!list.length) return null;
  const canRerun = me?.entitlements.role === 'chief_accountant' || can('automation:config');
  return (
    <FgCard title={UI.automation.title} style={{ marginBottom: 'var(--fg-space-4)' }}>
      <div style={{ display: 'grid', gap: 'var(--fg-space-3)' }}>
        {list.map((run) => (
          <RunLine
            key={run._id}
            run={run}
            canRerun={canRerun && run.status === 'failed'}
            busy={rerun.isPending && rerun.variables === run._id}
            onRerun={(id) =>
              rerun.mutate(id, {
                onSuccess: () => message.success('Đã chạy lại quy trình'),
                onError: (e) => message.error(problemText(e, 'Không chạy lại được')),
              })
            }
          />
        ))}
      </div>
    </FgCard>
  );
}

/* ================= liên kết ================= */

const DEBT_STATUS_LABEL: Record<string, string> = { open: 'Còn dư', partial: 'Trả một phần', settled: 'Đã tất toán' };

function counterpartHref(cp: DocLinkCounterpart): string | null {
  if (!cp.visible) return null;
  if (cp.type === 'document') return docHref('spend', cp.id); // trang hồ sơ dùng chung, không phụ thuộc loại
  if (cp.type === 'debt_voucher') return `/cong-no/phieu/${cp.id}`;
  return `/ngan-hang/khoan-vay/${cp.id}`;
}

function counterpartStatus(cp: DocLinkCounterpart): string | null {
  if (!cp.visible || !cp.status) return null;
  if (cp.type === 'bank_debt') return bankDebtStatusLabel(cp.status);
  if (cp.type === 'document') return statusLabel(cp.status);
  return DEBT_STATUS_LABEL[cp.status] ?? cp.status;
}

function splitText(l: DocLink): string | null {
  if (!l.split) return null;
  const p = (v: string): string => formatMoney(money(v), { mode: 'compact' });
  return `Gốc ${p(l.split.principal)} · Lãi ${p(l.split.interest)} · Phí ${p(l.split.fee)}`;
}

/** Liên kết hai chiều của phiếu. Gỡ = đánh dấu (có lý do), không xoá. Gán thêm khi có `link:manage`. */
export function LinksTab({ doc }: { doc: DocumentDetail }): ReactNode {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<DocLink | null>(null);
  const links = doc.links ?? [];
  const relations = manualLinkRelationsFor(doc.kind, doc.partner?.type ?? null);
  const closed = doc.status === 'rejected' || doc.status === 'cancelled';
  const canAdd = !!doc.can.link && !!doc.partner_id && relations.length > 0 && !closed;

  const columns: TableColumnsType<DocLink> = [
    {
      title: 'Quan hệ',
      key: 'relation',
      render: (_v: unknown, l: DocLink) => (
        <div>
          <FgText style="bodyS" strong>
            {BUSINESS_LINK_RELATION_LABEL[l.relation]}
          </FgText>
          <br />
          <FgText style="caption" color="muted">
            {l.direction === 'out' ? 'từ phiếu này' : 'đến phiếu này'} ·{' '}
            {l.origin === 'automation' ? UI.link.autoBy(l.rule_code ?? '') : LINK_ORIGIN_LABEL.manual}
          </FgText>
        </div>
      ),
    },
    {
      title: 'Đối ứng',
      key: 'counterpart',
      render: (_v: unknown, l: DocLink) => {
        const cp = l.counterpart;
        if (!cp.visible) {
          return <FgText style="caption" color="muted">Ngoài phạm vi công ty của bạn</FgText>;
        }
        const href = counterpartHref(cp);
        const st = counterpartStatus(cp);
        return (
          <div>
            {href ? (
              <Link to={href} className="fg-link" style={{ fontWeight: 500 }}>
                {LINK_OBJECT_TYPE_LABEL[cp.type]} {cp.code ?? ''}
              </Link>
            ) : (
              <FgText style="bodyS">{LINK_OBJECT_TYPE_LABEL[cp.type]} {cp.code ?? ''}</FgText>
            )}
            <br />
            <FgText style="caption" color="muted">
              {cp.partner_id && cp.partner_name ? (
                <Link to={`/doi-tac/${cp.partner_id}`} className="fg-link">
                  {cp.partner_name}
                </Link>
              ) : (
                cp.partner_name
              )}
              {cp.partner_name && st ? ' · ' : ''}
              {st}
              {!cp.partner_name && !st ? '—' : null}
            </FgText>
          </div>
        );
      },
    },
    {
      title: 'Số tiền phân bổ',
      key: 'amount',
      align: 'right',
      render: (_v: unknown, l: DocLink) => (
        <div>
          <FgMoney value={l.amount_minor ? money(l.amount_minor) : null} mode="full" />
          {splitText(l) ? (
            <div>
              <FgText style="caption" color="muted">
                {splitText(l)}
              </FgText>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: 'Trạng thái',
      key: 'status',
      render: (_v: unknown, l: DocLink) => (
        <div>
          <FgToneChip tone={l.status === 'active' ? 'success' : 'neutral'}>{LINK_STATUS_LABEL[l.status]}</FgToneChip>
          {l.status === 'removed' && l.removed_reason ? (
            <div>
              <FgText style="caption" color="muted">
                Lý do gỡ: {l.removed_reason}
              </FgText>
            </div>
          ) : null}
        </div>
      ),
    },
    {
      title: '',
      key: 'act',
      width: 90,
      render: (_v: unknown, l: DocLink) =>
        doc.can.link && l.status === 'active' ? (
          <FgButton size="small" variant="ghost" onClick={() => setRemoving(l)}>
            Gỡ
          </FgButton>
        ) : null,
    },
  ];

  return (
    <FgCard
      title={UI.link.title}
      padded={false}
      extra={
        canAdd ? (
          <FgButton size="small" onClick={() => setAdding(true)}>
            + Gán liên kết
          </FgButton>
        ) : null
      }
    >
      {links.length ? (
        <FgTable<DocLink> rowKey="_id" columns={columns} dataSource={links} pagination={false} />
      ) : (
        <div style={{ padding: 'var(--fg-space-4)' }}>
          <FgEmptyState
            glyph="◇"
            title="Chưa có liên kết nghiệp vụ"
            description={
              doc.partner_id
                ? 'Cấn trừ công nợ, trả nợ vay hoặc giải ngân sẽ hiện ở đây.'
                : 'Gắn đối tác cho phiếu trước để liên kết với công nợ hoặc khoản vay.'
            }
          />
        </div>
      )}
      {adding ? <AddLinkModal doc={doc} relations={relations} onClose={() => setAdding(false)} /> : null}
      {removing ? <RemoveLinkModal doc={doc} link={removing} onClose={() => setRemoving(null)} /> : null}
    </FgCard>
  );
}

function RemoveLinkModal({ doc, link, onClose }: { doc: DocumentDetail; link: DocLink; onClose: () => void }): ReactNode {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const remove = useRemoveDocumentLink(doc._id);
  const { message } = useToast();
  const ok = reason.trim().length >= 5;
  return (
    <FgModal
      open
      title="Gỡ liên kết"
      onCancel={onClose}
      footer={
        <>
          <FgButton onClick={onClose}>Hủy</FgButton>
          <FgButton
            variant="danger"
            loading={remove.isPending}
            disabled={!ok}
            onClick={async () => {
              setError(null);
              try {
                await remove.mutateAsync({ linkId: link._id, reason: reason.trim() });
                message.success('Đã gỡ liên kết');
                onClose();
              } catch (e) {
                setError(problemText(e, 'Không gỡ được liên kết'));
              }
            }}
          >
            Gỡ liên kết
          </FgButton>
        </>
      }
    >
      <FgText style="bodyS">
        {BUSINESS_LINK_RELATION_LABEL[link.relation]} · {link.counterpart.code ?? '—'}
        {link.amount_minor ? ` · ${formatMoney(money(link.amount_minor), { mode: 'full' })}` : ''}
      </FgText>
      <div style={{ marginTop: 12 }}>
        <FgField label={UI.link.removeReason + ' *'} error={error ?? (reason && !ok ? 'Tối thiểu 5 ký tự' : null)} help="Gỡ là đánh dấu, không xoá; lý do được ghi vào lịch sử.">
          <FgInput autoFocus value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </FgField>
      </div>
    </FgModal>
  );
}

/** Quan hệ + khoản đích (cùng đối tác của phiếu) + số tiền. Repayment có thể tách gốc / lãi / phí. */
function AddLinkModal({ doc, relations, onClose }: { doc: DocumentDetail; relations: ManualLinkRelation[]; onClose: () => void }): ReactNode {
  const { message } = useToast();
  const partnerId = doc.partner_id ?? undefined;
  const [relation, setRelation] = useState<ManualLinkRelation>(relations[0] ?? 'offset');
  const [targetId, setTargetId] = useState('');
  const [amount, setAmount] = useState<Money | null>(null);
  const [split, setSplit] = useState(false);
  const [parts, setParts] = useState<{ principal: Money | null; interest: Money | null; fee: Money | null }>({ principal: null, interest: null, fee: null });
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const debts = usePartnerDebts(relation === 'offset' ? partnerId : undefined);
  const loans = usePartnerLoans(relation === 'offset' ? undefined : partnerId);
  const create = useCreateDocumentLink(doc._id);

  const docAmount = moneyFromWire(doc.amount)?.minor ?? 0n;
  const voucherRemaining = (() => {
    const rem = docAmount - allocatedMinorOf(doc.links);
    return rem > 0n ? rem : 0n;
  })();

  // Ứng viên: cấn trừ → khoản công nợ cùng hướng với phiếu; trả nợ / giải ngân → khoản vay ngân hàng đang mở.
  const direction = debtDirectionForVoucher(doc.kind);
  const debtOptions = (debts.data?.items ?? [])
    .filter((d: PartnerDebtRow) => (direction ? debtDirectionOf(d) === direction : true) && d.status !== 'settled')
    .map((d) => ({ value: d._id, label: `${d.code} · ${debtDirectionOf(d) === 'receivable' ? 'phải thu' : 'phải trả'} · còn ${formatMoney(moneyFromWire(d.remaining) ?? money('0'), { mode: 'compact' })}`, remaining: d.remaining ? BigInt(d.remaining.minor) : 0n }));
  const loanOptions = (loans.data?.items ?? [])
    .filter((l: PartnerLoanRow) => (relation === 'repayment' ? l.status === 'active' || l.status === 'overdue' : LOAN_OPEN_STATUSES.includes(l.status)))
    .map((l) => ({
      value: l._id,
      label: `${l.code} · ${bankDebtStatusLabel(l.status)} · ${relation === 'repayment' ? `còn gốc ${formatMoney(moneyFromWire(l.outstanding) ?? money('0'), { mode: 'compact' })}` : `gốc ${formatMoney(moneyFromWire(l.principal) ?? money('0'), { mode: 'compact' })}`}`,
      remaining: BigInt((relation === 'repayment' ? l.outstanding?.minor : l.principal?.minor) ?? '0'),
    }));
  const options = relation === 'offset' ? debtOptions : loanOptions;

  const pickTarget = (id: string) => {
    setTargetId(id);
    const hit = options.find((o) => o.value === id);
    // gợi ý số tiền: nhỏ hơn giữa phần còn lại của phiếu và dư của khoản đích (sửa được)
    if (hit && !amount) {
      const suggest = hit.remaining < voucherRemaining ? hit.remaining : voucherRemaining;
      if (suggest > 0n) setAmount(money(suggest.toString()));
    }
  };

  const submit = async (): Promise<void> => {
    setError(null);
    if (!targetId) {
      setError(relation === 'offset' ? 'Chọn khoản công nợ' : 'Chọn khoản vay');
      return;
    }
    try {
      if (split && relation === 'repayment') {
        const p = { principal: parts.principal?.minor ?? 0n, interest: parts.interest?.minor ?? 0n, fee: parts.fee?.minor ?? 0n };
        const total = p.principal + p.interest + p.fee;
        if (total <= 0n) {
          setError('Nhập số tiền gốc, lãi hoặc phí');
          return;
        }
        await create.mutateAsync({
          relation,
          to_id: targetId,
          amount_minor: total.toString(),
          split: { principal: p.principal.toString(), interest: p.interest.toString(), fee: p.fee.toString() },
          note: note.trim() || undefined,
        });
      } else {
        if (!amount || amount.minor <= 0n) {
          setError('Nhập số tiền phân bổ (lớn hơn 0)');
          return;
        }
        await create.mutateAsync({ relation, to_id: targetId, amount_minor: amount.minor.toString(), note: note.trim() || undefined });
      }
      message.success('Đã gán liên kết');
      onClose();
    } catch (e) {
      setError(problemText(e, 'Không gán được liên kết'));
    }
  };

  return (
    <FgModal
      open
      title="Gán liên kết nghiệp vụ"
      width={640}
      onCancel={onClose}
      footer={
        <>
          <FgButton onClick={onClose}>Hủy</FgButton>
          <FgButton variant="primary" loading={create.isPending} onClick={() => void submit()}>
            Gán liên kết
          </FgButton>
        </>
      }
    >
      <div style={{ display: 'grid', gap: 'var(--fg-space-4)' }}>
        {error ? <FgAlert tone="danger" title={error} /> : null}
        <FgField label="Quan hệ *">
          <FgSelect
            options={relations.map((r) => ({ value: r, label: BUSINESS_LINK_RELATION_LABEL[r] }))}
            value={relation}
            onChange={(v) => {
              setRelation((v as ManualLinkRelation) ?? relations[0] ?? 'offset');
              setTargetId('');
              setAmount(null);
            }}
            style={{ width: '100%' }}
          />
        </FgField>
        <FgField
          label={relation === 'offset' ? 'Khoản công nợ *' : 'Khoản vay ngân hàng *'}
          help={
            relation === 'offset'
              ? `Chỉ hiện khoản cùng đối tác ${doc.partner?.name ?? ''}${direction ? ` và đúng hướng (${direction === 'receivable' ? 'phải thu' : 'phải trả'})` : ''}`
              : `Khoản vay của ${doc.partner?.name ?? 'ngân hàng'}${relation === 'repayment' ? ' đang vay' : ' chờ giải ngân hoặc đang vay'}`
          }
        >
          <FgSelect
            options={options.map((o) => ({ value: o.value, label: o.label }))}
            value={targetId || undefined}
            onChange={(v) => pickTarget(v ?? '')}
            placeholder={options.length ? 'Chọn…' : 'Không có khoản phù hợp'}
            style={{ width: '100%' }}
          />
        </FgField>
        {relation === 'repayment' ? (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} style={{ width: 18, height: 18 }} />
            Tách gốc / lãi / phí
          </label>
        ) : null}
        {relation === 'repayment' && split ? (
          <div style={{ display: 'grid', gap: 'var(--fg-space-3)', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))' }}>
            <FgField label="Gốc">
              <FgMoneyInput value={parts.principal} onChange={(m) => setParts((s) => ({ ...s, principal: m }))} />
            </FgField>
            <FgField label="Lãi">
              <FgMoneyInput value={parts.interest} onChange={(m) => setParts((s) => ({ ...s, interest: m }))} />
            </FgField>
            <FgField label="Phí">
              <FgMoneyInput value={parts.fee} onChange={(m) => setParts((s) => ({ ...s, fee: m }))} />
            </FgField>
          </div>
        ) : (
          <FgField
            label="Số tiền phân bổ *"
            help={`Phần còn lại của phiếu: ${formatMoney(money(voucherRemaining.toString()), { mode: 'full' })}`}
          >
            <FgMoneyInput value={amount} onChange={setAmount} />
          </FgField>
        )}
        <FgField label="Ghi chú">
          <FgInput value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </FgField>
      </div>
    </FgModal>
  );
}

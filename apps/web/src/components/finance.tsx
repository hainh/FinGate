/**
 * FinGate web — Fg* khối nghiệp vụ tài chính (DS §7.2, §7.13, §7.17).
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EVIDENCE_LABEL, daysLabel, formatMoney, maturity, maturityLabel, money, moneyFromWire, pct, type Money } from '@fingate/shared';
import type {
  ApprovalStep,
  DecisionPack,
  ExceptionItem,
  KpiBlock,
  MoneyWire,
} from '../app/types.ts';
import { FgButton, FgMoney, FgText, FgTooltip } from './primitives.tsx';
import { FgCard } from './cards.tsx';
import { toneStyle } from '../app/theme.ts';
import { ROLES_LABEL } from './labels.ts';

/* ================= FgKpiCard (DS §7.2) ================= */

export function FgKpiCard({
  kpi,
  href,
  onClick,
  loading,
  size = 'm',
}: {
  kpi: KpiBlock;
  href?: string;
  onClick?: () => void;
  loading?: boolean;
  size?: 'm' | 'l';
}): ReactNode {
  const body = (
    <FgCard style={{ height: '100%' }} className="fg-kpi">
      <FgText style="bodyS" color="muted">
        {kpi.label}
      </FgText>
      <div className="fg-kpi-value" style={{ fontSize: size === 'l' ? 'var(--fg-font-number-xl-size)' : undefined }}>
        {kpi.compact}
      </div>
      {kpi.delta_percent !== null && kpi.delta_percent !== undefined ? (
        <div className="fg-kpi-delta" style={{ color: kpi.delta_percent >= 0 ? 'var(--fg-text-success)' : 'var(--fg-text-danger)' }}>
          {pct(kpi.delta_percent)} so với hôm qua
        </div>
      ) : null}
      {kpi.breakdown?.length ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 12px', marginTop: 4 }}>
          {kpi.breakdown.map((b, i) => (
            <FgText key={i} style="caption" color="muted">
              {b.label}: <span className="fg-num">{b.compact}</span>
            </FgText>
          ))}
        </div>
      ) : null}
    </FgCard>
  );
  if (loading) return <div className="fg-card fg-kpi" aria-busy="true" style={{ minHeight: 96 }} />;
  const aria = `${kpi.label}: ${kpi.compact}`;
  if (href)
    return (
      <Link to={href} style={{ textDecoration: 'none', color: 'inherit' }} aria-label={aria}>
        {body}
      </Link>
    );
  if (onClick)
    return (
      <button type="button" onClick={onClick} style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%' }} aria-label={aria}>
        {body}
      </button>
    );
  return body;
}

/* ================= FgExceptionList (DS §7.17) ================= */

export function FgExceptionList({ items, dense }: { items: ExceptionItem[]; dense?: boolean }): ReactNode {
  if (!items.length)
    return (
      <FgText style="bodyS" color="muted">
        Không có khoản nào cần xử lý hôm nay ✓
      </FgText>
    );
  return (
    <div className="fg-exceptions">
      {items.map((e) => {
        const t = toneStyle(e.tone);
        const inner = (
          <div className="fg-exception" style={{ ...t }} data-dense={dense ? 'true' : undefined}>
            <span aria-hidden style={{ width: 18, textAlign: 'center', color: t.color }}>
              {e.glyph}
            </span>
            <span className="fg-exception-text">{e.text}</span>
            {e.compact ? (
              <span className="fg-exception-amount" style={{ color: t.color }}>
                {e.compact}
              </span>
            ) : null}
            {e.cta ? (
              <FgButton size="small" variant="secondary" tabIndex={-1}>
                {e.cta}
              </FgButton>
            ) : null}
          </div>
        );
        return e.href ? (
          <Link key={e.id} to={e.href} style={{ textDecoration: 'none', color: 'inherit' }} aria-label={`${e.text}${e.compact ? ` ${e.compact}` : ''}`}>
            {inner}
          </Link>
        ) : (
          <span key={e.id}>{inner}</span>
        );
      })}
    </div>
  );
}

/* ================= maturity ladder (DS §3.3) ================= */

export function FgMaturityCell({ days, tone, label }: { days: number; tone?: string; label?: string }): ReactNode {
  const band = maturity(days);
  const t = toneStyle(tone ?? band.tone);
  return (
    <span className="fg-chip" style={{ ...t, background: 'transparent' }} role="status" aria-label={label ?? maturityLabel(days)}>
      <span aria-hidden style={{ color: t.color }}>
        {band.glyph || '·'}
      </span>
      {label ?? daysLabel(days)}
    </span>
  );
}

/* ================= FgApprovalTimeline (DS §7.13) ================= */

const STEP_STATE_LABEL: Record<string, string> = {
  waiting: 'Chưa tới lượt',
  current: 'Đang chờ ở đây',
  done: 'Đã xong',
  skipped: 'Được bỏ qua',
  rejected: 'Từ chối tại đây',
};

export function FgApprovalTimeline({
  steps,
  currentRoleLabel,
  compact,
}: {
  steps: ApprovalStep[];
  /** nhãn role của người đang xử lý để highlight "bàn của bạn". */
  currentRoleLabel?: string;
  compact?: boolean;
}): ReactNode {
  return (
    <div className="fg-timeline" aria-label="Quy trình duyệt">
      {steps.map((s, i) => {
        const mineNow = s.state === 'current' && !!currentRoleLabel && (ROLES_LABEL[s.role] === currentRoleLabel || s.role === currentRoleLabel);
        return (
          <div className="fg-tl-step" key={`${s.order}-${s.role}`}>
            <div className="fg-tl-node">
              <span className="fg-tl-dot" data-state={s.state} aria-hidden />
              {i < steps.length - 1 ? <span className="fg-tl-line" aria-hidden /> : null}
            </div>
            <div className="fg-tl-body">
              <FgText style="bodyS" strong={s.state === 'current'}>
                {s.order}. {ROLES_LABEL[s.role] ?? s.role}
                {mineNow ? <span style={{ color: 'var(--fg-text-link)' }}> · bàn của bạn</span> : null}
              </FgText>{' '}
              <FgText style="caption" color={s.state === 'rejected' ? 'danger' : 'muted'}>
                {STEP_STATE_LABEL[s.state] ?? s.state}
                {s.decided_at ? ` · ${new Date(s.decided_at).toLocaleString('vi-VN')}` : ''}
              </FgText>
              {s.fast_tracked ? (
                <div style={{ marginTop: 4 }}>
                  <FgText style="caption" color="muted">
                    <span className="fg-stripe-fast" style={{ display: 'inline-block' }}>
                      Duyệt trước (fast-track) — cấp dưới chưa duyệt đủ
                    </span>
                  </FgText>
                </div>
              ) : null}
              {!compact && s.amount_at_decision ? (
                <div>
                  <FgText style="caption" color="muted">
                    Số tại lúc duyệt: <FgMoney value={s.amount_at_decision} mode="compact" />
                  </FgText>
                </div>
              ) : null}
              {!compact && (s.opinion || s.reason) ? (
                <div className="fg-tl-opinion">
                  <span aria-hidden style={{ color: 'var(--fg-text-muted)' }}>
                    Ý kiến:{' '}
                  </span>
                  {s.opinion || s.reason}
                </div>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ================= 7 câu hỏi — decision pack (OVL-02 / tab Tóm tắt) ================= */

/**
 * Hướng dòng tiền → màu nhấn phân chia các khối: vào = xanh lá, ra = cam (nóng),
 * nội bộ = xanh dương (trung tính).
 */
export type DecisionDirection = 'in' | 'out' | 'neutral';

const DIRECTION_TONE: Record<DecisionDirection, string> = {
  in: 'success',
  out: 'warning',
  neutral: 'info',
};

export const directionOf = (kind: string): DecisionDirection =>
  kind === 'income' ? 'in' : kind === 'spend' ? 'out' : 'neutral';

function SumSection({ tone, title, children }: { tone: string; title: string; children: ReactNode }): ReactNode {
  const t = toneStyle(tone);
  return (
    <section className="fg-sum-section" style={{ borderInlineStartColor: t.borderColor as string }}>
      <div className="fg-sum-title" style={{ color: t.color }}>
        {title}
      </div>
      <div className="fg-sum-body">{children}</div>
    </section>
  );
}

const SumRow = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="fg-sum-row">
    <span className="fg-sum-label">{label}</span>
    <span className="fg-sum-value">{children}</span>
  </div>
);

export function FgDecisionPack({
  pack,
  direction = 'out',
}: {
  pack: DecisionPack;
  direction?: DecisionDirection;
}): ReactNode {
  const w = (m: MoneyWire | null | undefined): Money | null => moneyFromWire(m);
  const bal = w(pack.q6_impact.balance_after);
  const min = w(pack.q6_impact.min_balance);
  const accent = DIRECTION_TONE[direction] ?? 'info';
  const isInflow = direction === 'in';
  return (
    <div className="fg-sum">
      <SumSection tone={accent} title={isInflow ? 'Đơn vị nộp' : 'Đơn vị nhận'}>
        <FgText style="body" strong as="div">
          {pack.q1_payee.name}
        </FgText>
        {pack.q1_payee.tax_code ? <SumRow label="MST">{pack.q1_payee.tax_code}</SumRow> : null}
        {pack.q1_payee.bank ? <SumRow label={isInflow ? 'TK nộp' : 'TK nhận'}>{pack.q1_payee.bank}</SumRow> : null}
        {pack.q1_payee.is_internal ? (
          <SumRow label="Loại">
            <FgTooltip title="Chuyển nội bộ — không tính vào chi phí/doanh thu">
              <span>Nội bộ tập đoàn</span>
            </FgTooltip>
          </SumRow>
        ) : null}
      </SumSection>

      <SumSection tone={accent} title="Số tiền">
        <div style={{ marginBottom: 'var(--fg-space-1)' }}>
          <FgMoney value={w(pack.q2_amount.amount)} mode="full" emphasis />
        </div>
        {pack.q2_amount.amount_usd ? (
          <SumRow label="Quy USD">
            <FgMoney value={w(pack.q2_amount.amount_usd)} mode="full" />
          </SumRow>
        ) : null}
        {pack.q2_amount.fx_rate ? <SumRow label="Tỷ giá">{pack.q2_amount.fx_rate}</SumRow> : null}
      </SumSection>

      <SumSection tone={accent} title="Mục đích">
        <FgText style="bodyS" as="div">
          {pack.q3_purpose.text}
        </FgText>
        <div style={{ marginTop: 'var(--fg-space-1)' }}>
          <FgText style="caption" color="muted">
            {pack.q3_purpose.category ?? 'Chưa phân loại'}
            {pack.q3_purpose.department ? ` · ${pack.q3_purpose.department}` : ''}
          </FgText>
        </div>
      </SumSection>

      <SumSection tone={accent} title="Căn cứ">
        <SumRow label="Hợp đồng">{pack.q4_basis.contract_code ?? '—'}</SumRow>
        {pack.q4_basis.contract_value ? (
          <SumRow label="Giá trị HĐ">
            <FgMoney value={w(pack.q4_basis.contract_value)} mode="compact" />
          </SumRow>
        ) : null}
        <SumRow label="Hóa đơn">{pack.q4_basis.invoice ?? '—'}</SumRow>
        <div className="fg-sum-note">
          {pack.evidence.missing.length ? (
            <FgText style="bodyS" color="danger">
              Thiếu chứng từ: {pack.evidence.missing.map((t) => EVIDENCE_LABEL[t as keyof typeof EVIDENCE_LABEL] ?? t).join(', ')}
            </FgText>
          ) : (
            <FgText style="bodyS" color="success">
              Đủ {pack.evidence.required.length} chứng từ bắt buộc ✓
            </FgText>
          )}
        </div>
      </SumSection>

      <SumSection tone={pack.q6_impact.breach ? 'danger' : accent} title={isInflow ? 'Nơi nhận tiền & ảnh hưởng số dư' : 'Nguồn tiền & ảnh hưởng số dư'}>
        <SumRow label={pack.q5_source.fund === 'bank' ? (isInflow ? 'Tài khoản nhận' : 'Tài khoản') : isInflow ? 'Quỹ nhận' : 'Quỹ'}>
          {pack.q5_source.account_label ?? '—'}
        </SumRow>
        {pack.q5_source.group_account_label ? <SumRow label="TK Tập đoàn phụ trách">{pack.q5_source.group_account_label}</SumRow> : null}
        <SumRow label="Số dư khả dụng ngay">
          <FgMoney value={w(pack.q6_impact.available_now)} mode="full" />
        </SumRow>
        <SumRow label="Sau giao dịch">
          <FgMoney value={bal} mode="full" style={{ color: pack.q6_impact.breach ? 'var(--fg-status-danger-text)' : isInflow ? 'var(--fg-status-success-text)' : undefined, fontWeight: 500 }} />
        </SumRow>
        <SumRow label="Ngưỡng tối thiểu">
          <FgMoney value={min} mode="compact" />
        </SumRow>
        {pack.q6_impact.breach ? (
          <div className="fg-sum-note">
            <FgText style="bodyS" color="danger">
              ⛔ Sau giao dịch sẽ dưới ngưỡng tối thiểu
            </FgText>
          </div>
        ) : null}
      </SumSection>

      <SumSection tone={pack.q7_plan.in_plan ? 'success' : 'danger'} title="Ngân sách / kế hoạch">
        <SumRow label="Trạng thái">
          {pack.q7_plan.in_plan ? (
            <FgText color="success">Trong kế hoạch</FgText>
          ) : (
            <FgText color="danger">NGOÀI NGÂN SÁCH</FgText>
          )}
        </SumRow>
        {pack.q7_plan.budget_line ? <SumRow label="Dòng ngân sách">{pack.q7_plan.budget_line}</SumRow> : null}
        {pack.q7_plan.used && pack.q7_plan.limit ? (
          <SumRow label="Đã dùng / giới hạn">
            <FgMoney value={w(pack.q7_plan.used)} mode="compact" /> / <FgMoney value={w(pack.q7_plan.limit)} mode="compact" />
          </SumRow>
        ) : null}
        {pack.q7_plan.percent !== null && pack.q7_plan.percent !== undefined ? (
          <SumRow label="Tỷ lệ đã dùng">{pct(pack.q7_plan.percent, 0)}</SumRow>
        ) : null}
        <div className="fg-sum-note">
          <FgText style="caption" color="muted">
            Quy trình: {pack.matrix_label}
          </FgText>
        </div>
      </SumSection>
    </div>
  );
}

/** hàng "đang ở bàn của ai + chờ N ngày" — mọi pending phải hiện thế này (luật 4). */
export function OwnerLine({ owner, roleLabel, waitingDays }: { owner: string | null; roleLabel: string | null; waitingDays: number }): ReactNode {
  return (
    <span className="fg-row-waiting">
      {owner ? `Ở bàn ${owner}` : roleLabel ? `Ở bàn: ${roleLabel}` : ''}
      {waitingDays > 0 ? ` · đã chờ ${waitingDays} ngày` : ''}
    </span>
  );
}

export const moneyOf = (v: MoneyWire | string): Money => (typeof v === 'string' ? money(v) : money(v as { minor: string; currency?: string }));
export const fmtCompact = (v: MoneyWire): string => formatMoney(moneyFromWire(v)!, { mode: 'compact' });

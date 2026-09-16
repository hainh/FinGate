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

const StatRow = ({ label, children }: { label: ReactNode; children: ReactNode }) => (
  <div className="fg-stat-row">
    <span className="fg-stat-label">{label}</span>
    <span style={{ textAlign: 'end' }}>{children}</span>
  </div>
);

export function FgDecisionPack({ pack }: { pack: DecisionPack }): ReactNode {
  const w = (m: MoneyWire | null | undefined): Money | null => moneyFromWire(m);
  const bal = w(pack.q6_impact.balance_after);
  const min = w(pack.q6_impact.min_balance);
  return (
    <div style={{ display: 'grid', gap: 'var(--fg-space-4)', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
      <FgCard>
        <FgText style="overline" color="muted">
          1 · Chi cho ai
        </FgText>
        <StatRow label="Đơn vị nhận">{pack.q1_payee.name}</StatRow>
        {pack.q1_payee.tax_code ? <StatRow label="MST">{pack.q1_payee.tax_code}</StatRow> : null}
        {pack.q1_payee.bank ? <StatRow label="TK nhận">{pack.q1_payee.bank}</StatRow> : null}
        {pack.q1_payee.is_internal ? (
          <StatRow label="Loại">
            <FgTooltip title="Chuyển nội bộ — không tính vào chi phí/doanh thu">
              <span>Nội bộ tập đoàn</span>
            </FgTooltip>
          </StatRow>
        ) : null}
      </FgCard>
      <FgCard>
        <FgText style="overline" color="muted">
          2 · Bao nhiêu
        </FgText>
        <StatRow label="Số tiền">
          <FgMoney value={w(pack.q2_amount.amount)} mode="full" emphasis />
        </StatRow>
        {pack.q2_amount.amount_usd ? (
          <StatRow label="Quy USD">
            <FgMoney value={w(pack.q2_amount.amount_usd)} mode="full" />
          </StatRow>
        ) : null}
        {pack.q2_amount.fx_rate ? <StatRow label="Tỷ giá">{pack.q2_amount.fx_rate}</StatRow> : null}
      </FgCard>
      <FgCard>
        <div style={{ display: 'block', marginBottom: 8 }}>
          <FgText style="overline" color="muted">
            3 · Để làm gì
          </FgText>
        </div>
        <FgText style="bodyS">{pack.q3_purpose.text}</FgText>
        <div style={{ marginTop: 8 }}>
          <FgText style="caption" color="muted">
            {pack.q3_purpose.category ?? 'Chưa phân loại'}
            {pack.q3_purpose.department ? ` · ${pack.q3_purpose.department}` : ''}
          </FgText>
        </div>
      </FgCard>
      <FgCard>
        <FgText style="overline" color="muted">
          4 · Căn cứ
        </FgText>
        <StatRow label="Hợp đồng">{pack.q4_basis.contract_code ?? '—'}</StatRow>
        {pack.q4_basis.contract_value ? (
          <StatRow label="Giá trị HĐ">
            <FgMoney value={w(pack.q4_basis.contract_value)} mode="compact" />
          </StatRow>
        ) : null}
        <StatRow label="Hóa đơn">{pack.q4_basis.invoice ?? '—'}</StatRow>
        <div style={{ marginTop: 8 }}>
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
      </FgCard>
      <FgCard>
        <FgText style="overline" color="muted">
          5 · Nguồn tiền & ảnh hưởng số dư
        </FgText>
        <StatRow label={pack.q5_source.fund === 'bank' ? 'Tài khoản' : 'Quỹ'}>
          {pack.q5_source.account_label ?? '—'}
        </StatRow>
        {pack.q5_source.group_account_label ? <StatRow label="TK Tập đoàn phụ trách">{pack.q5_source.group_account_label}</StatRow> : null}
        <StatRow label="Số dư khả dụng ngay">
          <FgMoney value={w(pack.q6_impact.available_now)} mode="full" />
        </StatRow>
        <StatRow label="Sau giao dịch">
          <FgMoney value={bal} mode="full" style={{ color: pack.q6_impact.breach ? 'var(--fg-status-danger-text)' : undefined, fontWeight: 500 }} />
        </StatRow>
        <StatRow label="Ngưỡng tối thiểu">
          <FgMoney value={min} mode="compact" />
        </StatRow>
        {pack.q6_impact.breach ? (
          <FgText style="bodyS" color="danger">
            ⛔ Sau giao dịch sẽ dưới ngưỡng tối thiểu
          </FgText>
        ) : null}
      </FgCard>
      <FgCard>
        <FgText style="overline" color="muted">
          6 · Trong kế hoạch / ngân sách?
        </FgText>
        <StatRow label="Trạng thái">
          {pack.q7_plan.in_plan ? (
            <FgText color="success">Trong kế hoạch</FgText>
          ) : (
            <FgText color="danger">NGOÀI NGÂN SÁCH</FgText>
          )}
        </StatRow>
        {pack.q7_plan.budget_line ? <StatRow label="Dòng ngân sách">{pack.q7_plan.budget_line}</StatRow> : null}
        {pack.q7_plan.used && pack.q7_plan.limit ? (
          <StatRow label="Đã dùng / giới hạn">
            <FgMoney value={w(pack.q7_plan.used)} mode="compact" /> / <FgMoney value={w(pack.q7_plan.limit)} mode="compact" />
          </StatRow>
        ) : null}
        {pack.q7_plan.percent !== null && pack.q7_plan.percent !== undefined ? (
          <StatRow label="Tỷ lệ đã dùng">{pct(pack.q7_plan.percent, 0)}</StatRow>
        ) : null}
        <div style={{ marginTop: 8 }}>
          <FgText style="caption" color="muted">
            Quy trình: {pack.matrix_label}
          </FgText>
        </div>
      </FgCard>
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

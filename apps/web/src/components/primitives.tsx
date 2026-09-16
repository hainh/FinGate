/**
 * FinGate web — Fg* primitives (DS §6–7).
 *
 * Screen CHỈ import `Fg*` — không raw antd (antd là engine, Fg* là API — DS §12.3).
 * Mọi số tiền đi qua formatMoney/money (shared); mọi status qua STATUS_REGISTRY.
 */

import type { CSSProperties, ReactNode } from 'react';
import { useRef, useState } from 'react';
import { Alert, Button, Input, InputNumber, Select, Tooltip, Typography } from 'antd';
import type { ButtonProps } from 'antd';
import {
  STATUS_REGISTRY,
  formatMoney,
  isStatusKey,
  money,
  moneyInputValue,
  parseMoneyInput,
  statusTone,
  type Money,
} from '@fingate/shared';
import { toneStyle } from '../app/theme.ts';
import { useUi } from '../app/store.tsx';

const { Text, Paragraph } = Typography;

/* ================= FgText (DS §6.2) ================= */

export type FgTextStyle =
  | 'display'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'body'
  | 'bodyS'
  | 'caption'
  | 'overline'
  | 'numXl'
  | 'numL'
  | 'numM'
  | 'numS';

const styleVars: Record<FgTextStyle, CSSProperties> = {
  display: { fontSize: 'var(--fg-font-display-size)', lineHeight: 'var(--fg-font-display-line)', letterSpacing: 'var(--fg-tracking-display)', fontWeight: 600 },
  h1: { fontSize: 'var(--fg-font-h1-size)', lineHeight: 'var(--fg-font-h1-line)', letterSpacing: 'var(--fg-tracking-h2)', fontWeight: 600 },
  h2: { fontSize: 'var(--fg-font-h2-size)', lineHeight: 'var(--fg-font-h2-line)', letterSpacing: 'var(--fg-tracking-h2)', fontWeight: 600 },
  h3: { fontSize: 'var(--fg-font-h3-size)', lineHeight: 'var(--fg-font-h3-line)', fontWeight: 600 },
  h4: { fontSize: 'var(--fg-font-h4-size)', lineHeight: 'var(--fg-font-h4-line)', fontWeight: 600 },
  body: { fontSize: 'var(--fg-font-body-size)', lineHeight: 'var(--fg-font-body-line)' },
  bodyS: { fontSize: 'var(--fg-font-body-s-size)', lineHeight: 'var(--fg-font-body-s-line)' },
  caption: { fontSize: 'var(--fg-font-caption-size)', lineHeight: 'var(--fg-font-caption-line)' },
  overline: { fontSize: 'var(--fg-font-overline-size)', lineHeight: 'var(--fg-font-overline-line)', letterSpacing: 'var(--fg-tracking-overline)', textTransform: 'uppercase' },
  numXl: { fontSize: 'var(--fg-font-number-xl-size)', lineHeight: 'var(--fg-font-number-xl-line)', fontVariantNumeric: 'tabular-nums', fontWeight: 500 },
  numL: { fontSize: 'var(--fg-font-number-l-size)', lineHeight: 'var(--fg-font-number-l-line)', fontVariantNumeric: 'tabular-nums', fontWeight: 500 },
  numM: { fontSize: 'var(--fg-font-number-m-size)', lineHeight: 'var(--fg-font-number-m-line)', fontVariantNumeric: 'tabular-nums', fontWeight: 500 },
  numS: { fontSize: 'var(--fg-font-number-s-size)', lineHeight: 'var(--fg-font-number-s-line)', fontVariantNumeric: 'tabular-nums', fontWeight: 500 },
};

export type FgTextColor = 'primary' | 'secondary' | 'muted' | 'danger' | 'success' | 'link';

const colorVars: Record<FgTextColor, string> = {
  primary: 'var(--fg-text-primary)',
  secondary: 'var(--fg-text-secondary)',
  muted: 'var(--fg-text-muted)',
  danger: 'var(--fg-text-danger)',
  success: 'var(--fg-text-success)',
  link: 'var(--fg-text-link)',
};

export function FgText({
  style = 'body',
  color,
  strong,
  children,
  ellipsis,
  as,
}: {
  style?: FgTextStyle;
  color?: FgTextColor;
  strong?: boolean;
  children: ReactNode;
  ellipsis?: boolean;
  as?: 'span' | 'div';
}): ReactNode {
  const s: CSSProperties = { ...styleVars[style] };
  if (color) s.color = colorVars[color];
  if (strong) s.fontWeight = 600;
  const Comp = as === 'div' ? 'div' : 'span';
  return (
    <Comp style={s}>
      <Text ellipsis={ellipsis ? { tooltip: false } : undefined} style={{ color: 'inherit' }}>
        {children}
      </Text>
    </Comp>
  );
}

export function FgTitle({ level, children }: { level: 1 | 2 | 3 | 4; children: ReactNode }) {
  const style = (['h1', 'h2', 'h3', 'h4'] as FgTextStyle[])[level - 1];
  return (
    <div style={styleVars[style]} aria-level={level} role={level === 1 ? 'heading' : undefined}>
      {children}
    </div>
  );
}

export { Paragraph };

/* ================= FgButton (DS §6.1) ================= */

export type FgButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'text' | 'soft';

export type FgButtonExtra = { variant?: FgButtonVariant; touch?: boolean };

export function FgButton({
  variant = 'secondary',
  size,
  touch,
  ...props
}: Omit<ButtonProps, 'variant' | 'color'> & FgButtonExtra): ReactNode {
  // defensive: lazy chunk + HMR có thể tách bản store.tsx (dev) → context null, KHÔNG được sập cả cây
  const density = useUi()?.density;
  const map: Record<FgButtonVariant, Pick<ButtonProps, 'type' | 'danger' | 'htmlType'>> = {
    primary: { type: 'primary' },
    secondary: {},
    ghost: { type: 'text' },
    danger: { type: 'primary', danger: true },
    text: { type: 'link' },
    soft: { type: 'default' },
  };
  const style: CSSProperties = {};
  if (variant === 'soft') {
    style.background = 'var(--fg-action-soft-bg)';
    style.color = 'var(--fg-action-soft-text)';
    style.borderColor = 'var(--fg-action-soft-bg)';
  }
  if (touch) style.minHeight = 'var(--fg-touch-min)';
  return (
    <Button
      size={size ?? (density === 'compact' ? 'middle' : undefined)}
      style={style}
      {...map[variant]}
      {...props}
    />
  );
}

/* ================= FgField / FgInput (DS §7.5) ================= */

export function FgField({
  label,
  help,
  error,
  required,
  hint,
  children,
  labelFor,
}: {
  label: ReactNode;
  help?: ReactNode;
  error?: string | null;
  required?: boolean;
  hint?: ReactNode;
  children: ReactNode;
  labelFor?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label
        htmlFor={labelFor}
        style={{ fontSize: 'var(--fg-font-body-s-size)', color: 'var(--fg-text-secondary)', fontWeight: 500 }}
      >
        {label}
        {required ? ' *' : ''}
      </label>
      {children}
      {error ? (
        <span role="alert" style={{ fontSize: 'var(--fg-font-caption-size)', color: 'var(--fg-status-danger-text)' }}>
          {error}
        </span>
      ) : help ? (
        <span style={{ fontSize: 'var(--fg-font-caption-size)', color: 'var(--fg-text-muted)' }}>{help}</span>
      ) : hint ? (
        <span style={{ fontSize: 'var(--fg-font-caption-size)', color: 'var(--fg-text-muted)' }}>{hint}</span>
      ) : null}
    </div>
  );
}

export function FgInput(props: React.ComponentProps<typeof Input>): ReactNode {
  return <Input {...props} />;
}

export function FgPassword(props: React.ComponentProps<typeof Input.Password>): ReactNode {
  return <Input.Password {...props} />;
}

export function FgTextarea(props: React.ComponentProps<typeof Input.TextArea>): ReactNode {
  return <Input.TextArea autoSize={{ minRows: 2 }} {...props} />;
}

export interface FgSelectOption {
  value: string;
  label: ReactNode;
}

export function FgSelect({
  options,
  value,
  onChange,
  placeholder,
  allowClear,
  style,
  ariaLabel,
  size,
  disabled,
}: {
  options: FgSelectOption[];
  value?: string;
  onChange?: (v?: string) => void;
  placeholder?: string;
  allowClear?: boolean;
  style?: CSSProperties;
  ariaLabel?: string;
  size?: 'small' | 'middle' | 'large';
  disabled?: boolean;
}): ReactNode {
  return (
    <Select
      aria-label={ariaLabel}
      options={options}
      value={value || undefined}
      onChange={(v) => onChange?.(v)}
      placeholder={placeholder}
      allowClear={allowClear}
      style={{ minWidth: 140, ...style }}
      size={size}
      disabled={disabled}
    />
  );
}

export function FgNumber(props: React.ComponentProps<typeof InputNumber>): ReactNode {
  return <InputNumber {...props} />;
}

/* ================= FgMoney (DS §7.1 — mọi số qua shared formatter) ================= */

function toMoney(v: Money | string | number | bigint | null | undefined): Money | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && 'minor' in v) return money(v as { minor: unknown; currency?: string });
  return money(v as never);
}

/**
 * Hiển thị tiền ĐÚNG NGUYÊN TẮC: `—` khi thiếu (khác `0 ₫`), `−` U+2212 khi âm,
 * aria-label đọc được ("hai tỷ năm trăm... đồng" qua moneyAria đơn giản hoá).
 */
export function FgMoney({
  value,
  mode = 'full',
  signed,
  missingLabel = '—',
  style,
  className,
  emphasis,
  ariaLabel,
}: {
  value: Money | { minor: string; currency?: string; decimals?: number } | string | number | bigint | null | undefined;
  mode?: 'full' | 'compact' | 'kpi';
  signed?: boolean;
  missingLabel?: string;
  style?: CSSProperties;
  className?: string;
  /** chữ số làm nổi bật (KPI, header hồ sơ). */
  emphasis?: boolean;
  ariaLabel?: string;
}): ReactNode {
  const m = toMoney(value as never);
  const text = m === null ? missingLabel : formatMoney(m, { mode, signed });
  return (
    <span
      className={`fg-money ${emphasis ? 'fg-num' : ''} ${className ?? ''}`}
      style={{ ...style, fontWeight: emphasis ? 500 : undefined }}
      aria-label={ariaLabel ?? (m === null ? 'chưa có dữ liệu' : undefined)}
    >
      {text}
    </span>
  );
}

/** Input số tiền: hiển thị theo vi-VN, parse qua `parseMoneyInput` (cấm Number()/parseFloat). */
export function FgMoneyInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
  status,
}: {
  value?: Money | null;
  onChange?: (m: Money | null) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  status?: 'error' | undefined;
}): ReactNode {
  const initial = value ? moneyInputValue(value) : '';
  const [text, setText] = useState(initial);
  const lastInitial = useRef(initial);
  // đồng bộ khi value đổi từ ngoài (reset form) — chỉ khi không phải do chính ta gõ
  if (lastInitial.current !== initial) {
    lastInitial.current = initial;
    setText(initial);
  }
  return (
    <Input
      inputMode="numeric"
      aria-label={ariaLabel ?? 'Số tiền'}
      placeholder={placeholder ?? '0 ₫ · hoặc 2,5 tỷ'}
      value={text}
      disabled={disabled}
      status={status}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        const trimmed = t.trim();
        if (!trimmed) onChange?.(null);
        else {
          try {
            onChange?.(parseMoneyInput(trimmed));
          } catch {
            /* chưa hợp lệ — giữ text, chưa báo có giá trị */
          }
        }
      }}
    />
  );
}


/* ================= FgStatusChip (DS §7.3, registry là nguồn duy nhất) ================= */

export function FgStatusChip({
  status,
  waitingDays,
  overdue,
  withOwner,
  size = 'default',
}: {
  status: string;
  waitingDays?: number;
  overdue?: boolean;
  /** thêm "· chờ N ngày" vào nhãn pending. */
  withOwner?: boolean;
  size?: 'default' | 'small';
}): ReactNode {
  const key = isStatusKey(status) ? status : null;
  const def = key ? STATUS_REGISTRY[key] : null;
  const tone = key ? statusTone(status) : 'neutral';
  const t = toneStyle(tone);
  const label = def ? `${def.glyph} ${def.labelVi}` : status;
  return (
    <>
      <span
        className="fg-chip"
        style={{ ...t, padding: size === 'small' ? '0 6px' : undefined }}
        role="status"
        aria-label={
          def
            ? `Trạng thái: ${def.labelVi}${key && def.pending && waitingDays !== undefined ? `, đã chờ ${waitingDays} ngày` : ''}`
            : `Trạng thái: ${status}`
        }
      >
        {label}
        {withOwner && key && def?.pending && waitingDays !== undefined ? (
          <span style={{ fontWeight: 400, opacity: 0.85 }}>· chờ {waitingDays} ngày</span>
        ) : null}
      </span>
      {/* overdue là chip THÊM VÀO, không thay status gốc (DS §3.1) */}
      {overdue ? (
        <span className="fg-chip" style={{ ...toneStyle('danger'), marginInlineStart: 6 }} role="status" aria-label="Quá hạn">
          ! Quá hạn
        </span>
      ) : null}
    </>
  );
}

/** chip tone tự do (severity/maturity/alert) — vẫn registry-driven, không hex. */
export function FgToneChip({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="fg-chip" style={toneStyle(tone)} role="status">
      {children}
    </span>
  );
}

/* ================= FgAlert (DS §7.8) ================= */

export function FgAlert({
  tone = 'info',
  title,
  description,
  action,
  closable,
  style,
}: {
  tone?: 'info' | 'success' | 'warning' | 'attention' | 'danger' | 'neutral';
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  closable?: boolean;
  style?: CSSProperties;
}): ReactNode {
  const type = tone === 'danger' ? 'error' : tone === 'attention' ? 'warning' : tone === 'warning' ? 'warning' : tone === 'success' ? 'success' : 'info';
  return (
    <Alert
      type={type}
      showIcon
      closable={closable}
      action={action}
      message={title}
      description={description}
      style={{ borderRadius: 'var(--fg-radius-md)', ...style }}
      banner={false}
    />
  );
}

/* ================= FgTooltip / FgBadge ================= */

export function FgTooltip({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <Tooltip title={title}>{children}</Tooltip>;
}

export function FgDot({ tone }: { tone: string }) {
  const t = toneStyle(tone);
  return (
    <span
      style={{ width: 8, height: 8, borderRadius: 'var(--fg-radius-full)', background: t.color, display: 'inline-block', flex: 'none' }}
      aria-hidden
    />
  );
}

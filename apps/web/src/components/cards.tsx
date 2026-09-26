/**
 * FinGate web — FgCard & layout blocks (DS §7.4 card: border, KHÔNG shadow ở mức thường).
 */

import { useState, type ReactNode, type CSSProperties } from 'react';
import { Card } from 'antd';
import { FgText } from './primitives.tsx';

export function FgCard({
  children,
  title,
  extra,
  style,
  className,
  padded = true,
  collapsible = false,
  defaultCollapsed = false,
}: {
  children: ReactNode;
  title?: ReactNode;
  extra?: ReactNode;
  style?: CSSProperties;
  className?: string;
  padded?: boolean;
  /** cho phép ấn vào tiêu đề để thu gọn / mở rộng nội dung. */
  collapsible?: boolean;
  defaultCollapsed?: boolean;
}): ReactNode {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const head = title ? (
    collapsible ? (
      <button type="button" className="fg-collapse-head" aria-expanded={!collapsed} onClick={() => setCollapsed((c) => !c)}>
        <span className="fg-card-title">{title}</span>
        <span className="fg-collapse-caret" aria-hidden>
          {collapsed ? '▸' : '▾'}
        </span>
      </button>
    ) : (
      <span className="fg-card-title">{title}</span>
    )
  ) : undefined;
  return (
    <Card
      variant="borderless"
      className={className}
      style={{ border: '1px solid var(--fg-border-default)', boxShadow: 'none', ...style }}
      styles={{ body: { padding: padded ? 'var(--fg-space-5)' : 0 } }}
      title={head}
      extra={extra}
    >
      {collapsed ? null : children}
    </Card>
  );
}

export function FgSectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--fg-space-3)' }}>
      <FgText style="h4">{children}</FgText>
      {right}
    </div>
  );
}

/**
 * FinGate web — FgCard & layout blocks (DS §7.4 card: border, KHÔNG shadow ở mức thường).
 */

import { Card } from 'antd';
import type { ReactNode, CSSProperties } from 'react';
import { FgText } from './primitives.tsx';

export function FgCard({
  children,
  title,
  extra,
  style,
  className,
  padded = true,
}: {
  children: ReactNode;
  title?: ReactNode;
  extra?: ReactNode;
  style?: CSSProperties;
  className?: string;
  padded?: boolean;
}): ReactNode {
  return (
    <Card
      variant="borderless"
      className={className}
      style={{ border: '1px solid var(--fg-border-default)', boxShadow: 'none', ...style }}
      styles={{ body: { padding: padded ? 'var(--fg-space-5)' : 0 } }}
      title={title ? <span className="fg-card-title">{title}</span> : undefined}
      extra={extra}
    >
      {children}
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

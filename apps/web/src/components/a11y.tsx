/**
 * a11y: skip-link tới nội dung chính (DS §10 — keyboard-only).
 */

import type { ReactNode } from 'react';

export function SkipLink(): ReactNode {
  return (
    <a
      href="#fg-main"
      style={{
        position: 'absolute',
        left: -9999,
        top: 0,
        zIndex: 9999,
        background: 'var(--fg-action-primary)',
        color: 'var(--fg-action-primary-text)',
        padding: '8px 16px',
        borderRadius: '0 0 var(--fg-radius-md) 0',
      }}
      onFocus={(e) => (e.currentTarget.style.left = '0')}
      onBlur={(e) => (e.currentTarget.style.left = '-9999px')}
    >
      Bỏ qua điều hướng, tới nội dung chính
    </a>
  );
}

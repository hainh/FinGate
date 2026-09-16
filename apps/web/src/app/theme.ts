/**
 * FinGate web — ThemeConfig antd 6 map 1-1 token DS §12.3.
 *
 * File DUY NHẤT được phép chứa hex (lint `fg/no-raw-color` loại trừ file này).
 * Screen không override CSS — chỉ dùng semantic token qua class `fg-*` và Fg* props.
 */

import { theme as antdTheme, type ThemeConfig } from 'antd';
import type { CSSProperties } from 'react';

/** token → CSS var: screen đọc `var(--fg-*)`; antd cũng bật cssVar nên cùng nguồn khi override. */

const base = {
  borderRadius: 8,
  controlHeight: 40,
  fontSize: 14,
  fontFamily: "Inter, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  fontSizeSM: 13,
  fontSizeLG: 15,
  wireframe: false,
};

const componentsLight: ThemeConfig['components'] = {
  Table: { headerBg: '#F2F4F7', rowHoverBg: '#F7F8FA', cellPaddingBlock: 12, cellFontSize: 14, borderColor: '#EAECF0' },
  Button: { fontWeight: 500, primaryShadow: 'none', dangerShadow: 'none' },
  Card: { boxShadow: 'none', borderRadiusLG: 12 },
  Tag: { borderRadiusSM: 6 },
  Layout: { headerBg: '#FFFFFF', bodyBg: '#F7F8FA', siderBg: '#262B34' },
  Menu: {},
  Input: { activeShadow: 'none' },
  Select: {},
  Tabs: {},
  Modal: { borderRadiusLG: 12 },
  Drawer: {},
  Alert: { borderRadiusLG: 8 },
  Notification: {},
};

export const fgThemeLight: ThemeConfig = {
  token: {
    ...base,
    colorPrimary: '#3445C4',
    colorInfo: '#1B5FAA',
    colorSuccess: '#157F44',
    colorWarning: '#B84E0D',
    colorError: '#A81E2B',
    colorText: '#3D4451',
    colorTextHeading: '#171A1F',
    colorTextDescription: '#5D6673',
    colorBorder: '#E1E5EB',
    colorBorderSecondary: '#EAECF0',
    colorBgLayout: '#F7F8FA',
    colorBgContainer: '#FFFFFF',
    boxShadowTertiary: '0 4px 12px rgba(23,26,31,.10)',
  },
  components: componentsLight,
};

export const fgThemeDark: ThemeConfig = {
  algorithm: antdTheme.darkAlgorithm,
  token: {
    ...base,
    colorPrimary: '#6B80F0',
    colorInfo: '#7FC0FF',
    colorSuccess: '#5CCB8A',
    colorWarning: '#FFB877',
    colorError: '#FF9AA6',
    colorText: '#C3CAD4',
    colorTextHeading: '#E6E9EF',
    colorTextDescription: '#9AA4B2',
    colorBorder: '#2A313B',
    colorBorderSecondary: '#222831',
    colorBgLayout: '#0E1116',
    colorBgContainer: '#171A1F',
    boxShadowTertiary: '0 4px 12px rgba(0,0,0,.16)',
  },
  components: {
    ...componentsLight,
    Table: { ...componentsLight?.Table, headerBg: '#12161C', rowHoverBg: '#1E232B', borderColor: '#222831' },
    Layout: { headerBg: '#171A1F', bodyBg: '#0E1116', siderBg: '#0B0E12' },
    Card: { colorBgContainer: '#171A1F' },
  },
};

export function fgThemeFor(mode: 'light' | 'dark'): ThemeConfig {
  return mode === 'dark' ? fgThemeDark : fgThemeLight;
}

/** ánh xạ Tone registry → cặp token nền/border/chữ (DS §2.3). Dùng nội bộ Fg* — không phải hex. */
export const toneStyleVars: Record<string, { bg: string; border: string; text: string; icon: string }> = {
  neutral: { bg: 'var(--fg-status-neutral-bg)', border: 'var(--fg-status-neutral-border)', text: 'var(--fg-status-neutral-text)', icon: 'var(--fg-status-neutral-icon)' },
  info: { bg: 'var(--fg-status-info-bg)', border: 'var(--fg-status-info-border)', text: 'var(--fg-status-info-text)', icon: 'var(--fg-status-info-icon)' },
  success: { bg: 'var(--fg-status-success-bg)', border: 'var(--fg-status-success-border)', text: 'var(--fg-status-success-text)', icon: 'var(--fg-status-success-icon)' },
  warning: { bg: 'var(--fg-status-warning-bg)', border: 'var(--fg-status-warning-border)', text: 'var(--fg-status-warning-text)', icon: 'var(--fg-status-warning-icon)' },
  attention: { bg: 'var(--fg-status-attention-bg)', border: 'var(--fg-status-attention-border)', text: 'var(--fg-status-attention-text)', icon: 'var(--fg-status-attention-icon)' },
  danger: { bg: 'var(--fg-status-danger-bg)', border: 'var(--fg-status-danger-border)', text: 'var(--fg-status-danger-text)', icon: 'var(--fg-status-danger-icon)' },
};

export const toneStyle = (tone: string): CSSProperties => {
  const t = toneStyleVars[tone] ?? toneStyleVars.neutral;
  return { background: t.bg, borderColor: t.border, color: t.text };
};

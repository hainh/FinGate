/**
 * FinGate web — FgAppShell (DS §5.1 rail 240/72 + header 64; §5.4 mobile).
 *
 * Mobile <768: rail chỉ còn 5 mục approval-first (Tiền · Cần duyệt · Cảnh báo · Đáo hạn · Dòng tiền).
 * Rail là vùng điều khiển chính; nội dung cuộn độc lập.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { useIsFetching } from '@tanstack/react-query';
import { LoadingOutlined } from '@ant-design/icons';
import { Badge, Dropdown, Input } from 'antd';
import { useAuth, useUi, SCOPE_ALL } from '../app/store.tsx';
import { useOverview, useUnreadCount } from '../app/queries.ts';
import { FgButton, FgText } from './primitives.tsx';
import { useToast } from './pagekit.tsx';

interface NavItem {
  to: string;
  label: string;
  glyph: string;
  perm?: string;
  badge?: 'awaiting' | 'unread';
  mobile?: boolean;
  match?: string[]; // đường dẫn con cùng nhóm
}

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Tổng quan', glyph: '◧', mobile: true, perm: 'doc:read', match: ['/dashboard', '/hom-nay'] },
  { to: '/cho-toi-duyet', label: 'Chờ tôi duyệt', glyph: '✍', badge: 'awaiting', mobile: true, perm: 'approval:act', match: ['/cho-toi-duyet', '/toi-da-duyet', '/can-bo-sung'] },
  { to: '/can-xu-ly', label: 'Cần xử lý', glyph: '⚑', badge: 'unread', mobile: true, perm: 'doc:read', match: ['/can-xu-ly'] },
  { to: '/chi', label: 'Chi', glyph: '↗', perm: 'doc:read', match: ['/chi'] },
  { to: '/thu', label: 'Thu', glyph: '↙', perm: 'doc:read', match: ['/thu'] },
  { to: '/ngan-hang/taikhoan', label: 'Ngân hàng', glyph: '▤', perm: 'bank:read', match: ['/ngan-hang', '/ngan-hang/khoan-vay'] },
  { to: '/ngan-hang/dao-han', label: 'Đáo hạn', glyph: '⧗', mobile: true, perm: 'loan:read', match: ['/ngan-hang/dao-han'] },
  { to: '/cong-no/phai-thu', label: 'Công nợ', glyph: '≡', perm: 'debt:read', match: ['/cong-no'] },
  { to: '/dong-tien', label: 'Dòng tiền', glyph: '∿', mobile: true, perm: 'forecast:read', match: ['/dong-tien'] },
  { to: '/baocao', label: 'Báo cáo', glyph: '☰', perm: 'report:view', match: ['/baocao'] },
  { to: '/ban-tin/ngay', label: 'Bản tin', glyph: '✉', perm: 'report:view', match: ['/ban-tin'] },
  // Người có quyền mời/điều phối nhân sự (Chủ tịch · GĐ · KTT · Quản trị) — không chỉ admin:matrix.
  { to: '/quantri/nguoidung', label: 'Quản trị', glyph: '⚙', perm: 'hr:invite', match: ['/quantri'] },
];

/**
 * true sau khi `active` giữ nguyên liên tục `delay` ms — dùng để tránh nhấp nháy
 * chỉ báo khi request ngắn.
 */
function useDelayedFlag(active: boolean, delay = 500): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!active) {
      setOn(false);
      return;
    }
    const t = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(t);
  }, [active, delay]);
  return on;
}

/** chỉ báo tải toàn cục trên header — ô kích thước cố định nên không đẩy layout. */
function FgFetchIndicator(): ReactNode {
  const fetching = useIsFetching();
  const show = useDelayedFlag(fetching > 0, 500);
  return (
    <span
      aria-live="polite"
      aria-label={show ? 'Đang cập nhật dữ liệu' : undefined}
      style={{ width: 20, height: 20, display: 'grid', placeItems: 'center', color: 'var(--fg-text-muted)', flex: 'none' }}
    >
      {show ? <LoadingOutlined spin aria-hidden /> : null}
    </span>
  );
}

export function FgAppShell({ children }: { children: ReactNode }): ReactNode {
  const { me, can, logout, scope, setScope } = useAuth();
  const { theme, setTheme, resolved, density, setDensity } = useUi();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { data: overview } = useOverview();
  const { data: unread } = useUnreadCount();
  const { message } = useToast();

  useEffect(() => setMobileOpen(false), [location.pathname]);

  const [viewportW, setViewportW] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1440));
  useEffect(() => {
    const h = () => setViewportW(window.innerWidth);
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  }, []);
  const isMobile = viewportW < 768;
  const items = useMemo(() => {
    const visible = NAV.filter((n) => !n.perm || can(n.perm));
    if (!isMobile) return visible;
    return visible.filter((n) => n.mobile);
  }, [isMobile, location.pathname, can]);

  const badgeCount = (b?: string): number =>
    b === 'awaiting' ? (overview?.counts?.awaiting_me ?? 0) : b === 'unread' ? (unread?.count ?? 0) : 0;

  const companies = me?.assignments ?? [];

  return (
    <div className="fg-shell">
      <aside className="fg-rail" data-collapsed={collapsed ? 'true' : 'false'} data-mobile-open={mobileOpen ? 'true' : 'false'} aria-label="Điều hướng chính">
        <div className="fg-rail-logo">
          <span className="fg-rail-mark" aria-hidden>F</span>
          <span style={{ display: collapsed ? 'none' : undefined }}>FinGate</span>
        </div>
        <nav className="fg-rail-nav">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => 'fg-rail-item' + (isActive ? ' fg-rail-item-active' : '')}
              aria-current={(n.match ?? [n.to]).some((m) => location.pathname.startsWith(m)) ? 'page' : undefined}
              title={collapsed ? n.label : undefined}
            >
              <span className="fg-rail-icon" aria-hidden>
                {n.glyph}
              </span>
              <span style={{ display: collapsed && !isMobile ? 'none' : undefined }}>{n.label}</span>
              {badgeCount(n.badge) > 0 ? (
                <span className="fg-rail-badge" aria-label={`${badgeCount(n.badge)} mục chờ`}>
                  {badgeCount(n.badge)}
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div style={{ padding: 'var(--fg-space-3)', display: collapsed && !isMobile ? 'none' : undefined }}>
          <FgText style="caption" color="muted">
            Nghiệp vụ {overview?.business_date ?? '—'}
          </FgText>
        </div>
      </aside>

      <div className="fg-main-wrap" data-collapsed={collapsed ? 'true' : 'false'}>
        <header className="fg-header" data-fg="header">
          <FgButton
            variant="ghost"
            aria-label={isMobile ? 'Mở menu' : 'Thu gọn menu'}
            onClick={() => (isMobile ? setMobileOpen((v) => !v) : setCollapsed((v) => !v))}
          >
            ☰
          </FgButton>

          {/* FgScopeSwitcher (OVL-10) */}
          <Dropdown
            menu={{
              items: [
                { key: SCOPE_ALL, label: 'Toàn tập đoàn' },
                ...companies.map((c) => ({ key: c.company_id, label: `${c.company_code} · ${c.company_name}` })),
              ],
              selectable: true,
              selectedKeys: [scope],
              onSelect: ({ key }) => {
                setScope(key);
                message.info('Đã đổi phạm vi dữ liệu — mọi số liệu vừa tải lại');
              },
            }}
            trigger={['click']}
          >
            <button
              type="button"
              style={{
                all: 'unset',
                cursor: 'pointer',
                padding: '6px 12px',
                borderRadius: 'var(--fg-radius-md)',
                border: '1px solid var(--fg-border-default)',
                fontWeight: 500,
              }}
              aria-label="Phạm vi dữ liệu"
            >
              <span aria-hidden style={{ marginRight: 6 }}>▣</span>
              {scope === SCOPE_ALL ? 'Toàn tập đoàn' : companies.find((c) => c.company_id === scope)?.company_code ?? 'Công ty'}
            </button>
          </Dropdown>

          <span style={{ flex: 1 }} />

          <Input.Search
            placeholder="Tìm mã hồ sơ, nội dung…"
            style={{ width: 220 }}
            className="fg-hide-mobile"
            aria-label="Tìm kiếm toàn cục"
            onSearch={(q) => q.trim() && navigate(`/tim-kiem?q=${encodeURIComponent(q)}`)}
          />

          <FgFetchIndicator />

          <Link to="/thong-bao" aria-label="Thông báo" style={{ color: 'var(--fg-text-secondary)' }}>
            <Badge count={unread?.count ?? 0} size="small" offset={[2, -2]}>
              <span style={{ fontSize: 18 }}>✉</span>
            </Badge>
          </Link>

          <FgButton
            variant="ghost"
            aria-label={resolved === 'dark' ? 'Chuyển nền sáng' : 'Chuyển nền tối'}
            onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
          >
            {resolved === 'dark' ? '☀' : '☾'}
          </FgButton>
          <Dropdown
            menu={{
              items: [
                { key: 'p', label: 'Cá nhân & cài đặt', onClick: () => navigate('/ca-nhan') },
                {
                  key: 'd',
                  label: `Độ đặc: ${density === 'compact' ? 'Dày' : 'Thoáng'}`,
                  onClick: () => setDensity(density === 'compact' ? 'comfortable' : 'compact'),
                },
                { key: 't', label: `Chủ đề: ${theme === 'system' ? 'Theo hệ thống' : theme === 'dark' ? 'Tối' : 'Sáng'}`, onClick: () => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light') },
                { type: 'divider' as const },
                { key: 'o', label: 'Đăng xuất', onClick: () => void logout() },
              ],
            }}
          >
            <button type="button" style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }} aria-label="Tài khoản">
              <span
                aria-hidden
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 'var(--fg-radius-full)',
                  background: 'var(--fg-action-soft-bg)',
                  color: 'var(--fg-action-soft-text)',
                  display: 'grid',
                  placeItems: 'center',
                  fontWeight: 600,
                }}
              >
                {me?.display_name?.[0] ?? '?'}
              </span>
              <span className="fg-hide-mobile" style={{ textAlign: 'start' }}>
                <FgText style="bodyS" strong>
                  {me?.display_name}
                </FgText>
                <br />
                <FgText style="caption" color="muted">
                  {companies.find((c) => c.company_id === (scope === SCOPE_ALL ? me?.scope.active_company_id : scope))?.role_label ?? me?.entitlements.role}
                </FgText>
              </span>
            </button>
          </Dropdown>
        </header>

        <main className="fg-content" data-fg="content" id="fg-main">
          {children}
        </main>
      </div>
    </div>
  );
}

/** tiêu đề trang chuẩn §5.3 + meta scope/thời điểm. */
export function FgPageHeader({ title, meta, actions }: { title: string; meta?: ReactNode; actions?: ReactNode }): ReactNode {
  const { me } = useAuth();
  return (
    <div className="fg-page-head">
      <div>
        <h1 className="fg-page-title">{title}</h1>
        <div className="fg-page-meta">
          {meta ?? (
            <>
              Phạm vi: {me?.scope.all ? 'Toàn tập đoàn' : 'Công ty hiện tại'} · Ngày nghiệp vụ {new Date().toLocaleDateString('vi-VN')}
            </>
          )}
        </div>
      </div>
      {actions ? <div style={{ display: 'flex', gap: 'var(--fg-space-3)' }}>{actions}</div> : null}
    </div>
  );
}

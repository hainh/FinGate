/**
 * FinGate web — AppContext (theme/density/scope) + AuthContext (phiên + quyền).
 *
 * - Theme/density persist localStorage `fg.ui`; sync prefs lên server khi đăng nhập.
 * - Đổi scope công ty: header `x-company-scope` (api.ts đọc từ đây) → invalidate MỌI query,
 *   giữ nguyên bộ lọc (DS §7.7).
 * - `can(permission)` đọc `entitlements.permissions` — server là nguồn, UI chỉ ẩn nút/cột.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import viVN from 'antd/locale/vi_VN';
import dayjs from 'dayjs';
import 'dayjs/locale/vi';
import { fgThemeFor } from './theme.ts';
import { apiCall, apiData, markSignedOut, setScopeProvider, setUnauthorizedHandler, ApiRequestError } from './api.ts';
import type { LoginResult, MeProfile } from './types.ts';

dayjs.locale('vi');

/* ================= UI (theme · density) ================= */

export type ThemeMode = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';

interface UiState {
  theme: ThemeMode;
  density: Density;
}

const LS_KEY = 'fg.ui';

function readUi(): UiState {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}') as Partial<UiState>;
    return { theme: s.theme ?? 'light', density: s.density ?? 'comfortable' };
  } catch {
    return { theme: 'light', density: 'comfortable' };
  }
}

export function resolvedTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return mode;
}

interface UiContextValue extends UiState {
  setTheme: (t: ThemeMode) => void;
  setDensity: (d: Density) => void;
  resolved: 'light' | 'dark';
}

const UiContext = createContext<UiContextValue | null>(null);
export const useUi = (): UiContextValue => useContext(UiContext)!;

/* ================= Auth + scope ================= */

export const SCOPE_ALL = 'all';

/**
 * Phạm vi đang chọn, giữ ở module để placeholderData đọc được (queryClient ở ngoài React).
 * Cập nhật đồng bộ trong setScope/loadMe, song song với scopeProvider.
 */
let activeScope: string = SCOPE_ALL;

/**
 * Giữ dữ liệu của query cũ khi đổi filter trong CÙNG phạm vi, nhưng KHÔNG bắc cầu sang
 * phạm vi công ty khác — tránh hiện nhầm phiếu công ty A khi vừa chuyển sang B. Mọi query
 * phụ thuộc phạm vi đều đặt scope ở queryKey[1].
 */
function keepDataWithinScope(prevData: unknown, prevQuery: { queryKey: readonly unknown[] } | undefined): unknown {
  return prevQuery && prevQuery.queryKey[1] === activeScope ? prevData : undefined;
}

interface AuthContextValue {
  status: 'loading' | 'anon' | 'authed';
  me: MeProfile | null;
  /** 'all' hoặc company_id — scope đang hoạt động. */
  scope: string;
  setScope: (s: string) => void;
  login: (email: string, password: string, remember?: boolean) => Promise<LoginResult>;
  login2fa: (challenge: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<MeProfile | null>;
  /** quyền nghiệp vụ từ entitlements. */
  can: (permission: string) => boolean;
  canAction: (action: string) => boolean;
  columnVisible: (column: string) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);
export const useAuth = (): AuthContextValue => useContext(AuthContext)!;

/**
 * Công ty đang làm việc = phạm vi đang chọn ở bộ chuyển phạm vi (không phải
 * `me.scope.active_company_id` — công ty "active" của phiên, chốt lúc đăng nhập
 * và không đổi khi người dùng chuyển phạm vi). Chỉ khi xem "Toàn tập đoàn" mới
 * dùng công ty mặc định của phiên. Dùng cho mọi form ghi dữ liệu theo công ty.
 */
export function useCurrentCompanyId(): string | null {
  const { me, scope } = useAuth();
  if (scope !== SCOPE_ALL) return scope;
  return me?.scope.active_company_id ?? me?.assignments[0]?.company_id ?? null;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // handoff §4: polling 30s, không WebSocket; giữ dữ liệu khi đổi filter.
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
      placeholderData: keepDataWithinScope,
      retry: 0, // retry nằm ở api.ts (GET only, backoff 2s)
      staleTime: 10_000,
    },
    mutations: { retry: 0 },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<UiState>(readUi);
  const [me, setMe] = useState<MeProfile | null>(null);
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [scope, setScopeState] = useState<string>(SCOPE_ALL);

  const resolved = resolvedTheme(ui.theme);

  useEffect(() => {
    document.documentElement.dataset.fgTheme = resolved;
    document.documentElement.dataset.fgDensity = ui.density;
    localStorage.setItem(LS_KEY, JSON.stringify(ui));
  }, [ui, resolved]);

  useEffect(() => {
    setScopeProvider(() => (scope && scope !== SCOPE_ALL ? scope : null));
    activeScope = scope;
  }, [scope]);

  const loadMe = useCallback(async (): Promise<MeProfile | null> => {
    try {
      const profile = await apiData<MeProfile>('/me');
      setMe(profile);
      setStatus('authed');
      const active = profile.scope?.active_company_id;
      const def = profile.prefs?.default_scope;
      const next = def === 'all' || !def ? SCOPE_ALL : active && profile.scope.company_ids.includes(def) ? def : SCOPE_ALL;
      // Đặt provider đồng bộ TRƯỚC khi setState để các query mount sau đó gửi đúng
      // phạm vi (effect cập nhật provider chạy sau con của nó → dễ lệch ở lần tải đầu).
      setScopeProvider(() => (next !== SCOPE_ALL ? next : null));
      activeScope = next;
      setScopeState(next);
      return profile;
    } catch (e) {
      if (e instanceof ApiRequestError && (e.status === 401 || e.code === 'FG-AUTH-001')) setStatus('anon');
      else setStatus('anon');
      return null;
    }
  }, []);

  /**
   * Trang đích sau đăng nhập: tôn trọng `fg.returnTo` cho người xem nghiệp vụ, nhưng
   * tài khoản quản lý thuần (không `doc:read`) về thẳng khu Quản trị thay vì dashboard 403.
   */
  const homeFor = useCallback((profile: MeProfile | null): string => {
    const back = sessionStorage.getItem('fg.returnTo');
    sessionStorage.removeItem('fg.returnTo');
    const canDoc = Boolean(profile?.entitlements?.permissions?.includes('doc:read'));
    const fallback = canDoc ? '/dashboard' : '/quantri';
    if (!back || back.startsWith('/dang-nhap') || back.startsWith('/kich-hoat') || back.startsWith('/mat-khau')) return fallback;
    if (!canDoc && !back.startsWith('/quantri') && back !== '/') return fallback;
    return back;
  }, []);

  const go = useCallback((target: string): void => {
    window.history.replaceState(null, '', target);
    setTimeout(() => window.dispatchEvent(new PopStateEvent('popstate')), 0);
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      // chỉ đá về login khi ĐÃ có phiên (401 giữa-cau-thi). 401 của /me lúc mới mở máy = anon bình thường.
      if (status !== 'authed') return;
      // giữ draft + ngữ cảnh: lưu URL hiện tại để quay lại sau khi đăng nhập.
      const here = window.location.pathname + window.location.search;
      if (!here.startsWith('/dang-nhap')) sessionStorage.setItem('fg.returnTo', here);
      markSignedOut(true);
      setStatus('anon');
      setMe(null);
      window.history.replaceState(null, '', '/dang-nhap');
      setTimeout(() => window.dispatchEvent(new PopStateEvent('popstate')), 0);
    });
  }, [status]);

  const login = useCallback(async (email: string, password: string, remember = true): Promise<LoginResult> => {
    const r = await apiData<LoginResult>('/auth/login', { method: 'POST', body: { email, password, remember } });
    if (!r.need_2fa) {
      markSignedOut(false);
      const profile = await loadMe();
      go(homeFor(profile));
    }
    return r;
  }, [loadMe, homeFor, go]);

  const login2fa = useCallback(async (challenge: string, code: string) => {
    await apiData('/auth/2fa', { method: 'POST', body: { challenge, code } });
    markSignedOut(false);
    const profile = await loadMe();
    go(homeFor(profile));
  }, [loadMe, homeFor, go]);

  const logout = useCallback(async () => {
    try {
      await apiCall('/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* phiên có thể đã hết hạn — vẫn về login */
    }
    markSignedOut(true);
    setMe(null);
    setStatus('anon');
    queryClient.clear();
  }, []);

  const setScope = useCallback((s: string) => {
    // Cập nhật provider NGAY (đồng bộ), không chờ effect — request phát sinh ngay sau
    // khi đổi phạm vi (invalidate + query key mới) phải gửi đúng header công ty.
    setScopeProvider(() => (s && s !== SCOPE_ALL ? s : null));
    activeScope = s;
    setScopeState(s);
    // đổi scope → refetch mọi số liệu, giữ nguyên filter (URL không đổi).
    queryClient.invalidateQueries();
    // báo server biết scope hoạt động mới (không chặn UI nếu lỗi)
    void apiCall('/me/prefs', { method: 'PATCH', body: { default_scope: s } }).catch(() => undefined);
  }, []);

  // sync prefs người dùng từ server khi đăng nhập (theme/density ưu tiên thiết bị nếu đã chọn)
  useEffect(() => {
    if (!me?.prefs) return;
    const local = readUi();
    const next: Partial<UiState> = {};
    if (!localStorage.getItem(LS_KEY)) {
      if (me.prefs.theme) next.theme = me.prefs.theme;
      if (me.prefs.density) next.density = me.prefs.density;
    } else {
      void local;
    }
    if (Object.keys(next).length) setUi((u) => ({ ...u, ...next }));
  }, [me]);

  const auth = useMemo<AuthContextValue>(
    () => ({
      status,
      me,
      scope,
      setScope,
      login,
      login2fa,
      logout,
      refreshMe: loadMe,
      can: (permission: string) => !!me?.entitlements?.permissions?.includes(permission),
      canAction: (action: string) => me?.entitlements?.actions?.[action] !== false,
      columnVisible: (column: string) =>
        (me?.entitlements?.columns ?? []).find((c) => c.column === column)?.visible ?? true,
    }),
    [status, me, scope, setScope, login, login2fa, logout, loadMe],
  );

  const uiValue = useMemo<UiContextValue>(
    () => ({
      ...ui,
      resolved,
      setTheme: (theme) => setUi((s) => ({ ...s, theme })),
      setDensity: (density) => setUi((s) => ({ ...s, density })),
    }),
    [ui, resolved],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <UiContext.Provider value={uiValue}>
        <AuthContext.Provider value={auth}>
          <ConfigProvider
            locale={viVN}
            theme={fgThemeFor(resolved)}
            button={{ autoInsertSpace: false }}
          >
            <AntdApp component={false}>{children}</AntdApp>
          </ConfigProvider>
        </AuthContext.Provider>
      </UiContext.Provider>
    </QueryClientProvider>
  );
}

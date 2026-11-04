/**
 * FinGate web — entry React (React 19 + Vite + antd 6 engine, Fg* API).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';
import { App as AntdApp } from 'antd';
import { AppProviders, useAuth } from './app/store.tsx';
import { AppRoutes } from './routes.tsx';
import { FgErrorBoundary } from './screens/errors.tsx';
import { SkipLink } from './components/a11y.tsx';
import {
  subscribeCurrentDevice,
  useApprovalNotifications,
  usePushPermission,
  usePushStatus,
} from './app/push-notifications.ts';

function ToastBridge(): ReactNode {
  // toastOk() dispatch event → antd message (một nơi duy nhất, không static API)
  const { message } = AntdApp.useApp();
  useEffect(() => {
    const h = (e: Event) => {
      const { msg, type } = (e as CustomEvent).detail as { msg: string; type?: string };
      if (type === 'error') message.error(msg);
      else message.success(msg);
    };
    document.addEventListener('fg:toast', h);
    return () => document.removeEventListener('fg:toast', h);
  }, [message]);
  return null;
}

/**
 * Chọn ĐƯỜNG thông báo và bật nó (xem ghi chú đầu app/push-notifications.ts):
 *  - chưa đăng nhập hoặc chưa cấp quyền            → tắt
 *  - server có VAPID + thiết bị đã đăng ký được    → 'push'  (server đẩy, báo cả khi app đóng)
 *  - còn lại                                        → 'local' (chuông poll khi app đang mở)
 * Tự đăng ký lại thiết bị mỗi lần đăng nhập để endpoint mới (trình duyệt đổi endpoint định kỳ) được
 * cập nhật lên server mà người dùng không phải bấm gì.
 */
function ApprovalNotificationsBridge(): ReactNode {
  const { status } = useAuth();
  const permission = usePushPermission();
  const pushStatus = usePushStatus();
  const [registered, setRegistered] = useState<'unknown' | 'yes' | 'no'>('unknown');

  useEffect(() => {
    if (status !== 'authed' || permission !== 'granted' || !pushStatus) return;
    if (!pushStatus.enabled || !pushStatus.public_key) {
      setRegistered('no');
      return;
    }
    let alive = true;
    void subscribeCurrentDevice().then((ok) => {
      if (alive) setRegistered(ok ? 'yes' : 'no');
    });
    return () => {
      alive = false;
    };
  }, [status, permission, pushStatus]);

  const mode: 'push' | 'local' | 'off' =
    status !== 'authed' || permission !== 'granted'
      ? 'off'
      : registered === 'yes'
        ? 'push'
        : 'local';
  useApprovalNotifications(status === 'authed', mode);
  return null;
}

export default function App(): ReactNode {
  return (
    <BrowserRouter>
      {/* Boundary BÊN TRONG router: fallback ServerErrorScreen chứa <Link>, đặt ngoài router sẽ crash 'basename of null' khi catch. */}
      <FgErrorBoundary>
        <AppProviders>
          <ToastBridge />
          <ApprovalNotificationsBridge />
          <SkipLink />
          <AppRoutes />
        </AppProviders>
      </FgErrorBoundary>
    </BrowserRouter>
  );
}

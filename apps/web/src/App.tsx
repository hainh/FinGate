/**
 * FinGate web — entry React (React 19 + Vite + antd 6 engine, Fg* API).
 */

import { useEffect, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';
import { App as AntdApp } from 'antd';
import { AppProviders, useAuth } from './app/store.tsx';
import { AppRoutes } from './routes.tsx';
import { FgErrorBoundary } from './screens/errors.tsx';
import { SkipLink } from './components/a11y.tsx';
import { useApprovalNotifications } from './app/push-notifications.ts';

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

/** Bật thông báo "phiếu mới chờ tôi duyệt" khi đã đăng nhập (poll 30s, chỉ khi người dùng đã cấp quyền). */
function ApprovalNotificationsBridge(): ReactNode {
  const { status } = useAuth();
  useApprovalNotifications(status === 'authed');
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

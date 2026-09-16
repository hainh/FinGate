/**
 * FinGate web — entry React (React 19 + Vite + antd 6 engine, Fg* API).
 */

import { useEffect, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router';
import { App as AntdApp } from 'antd';
import { AppProviders } from './app/store.tsx';
import { AppRoutes } from './routes.tsx';
import { FgErrorBoundary } from './screens/errors.tsx';
import { SkipLink } from './components/a11y.tsx';

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

export default function App(): ReactNode {
  return (
    <BrowserRouter>
      {/* Boundary BÊN TRONG router: fallback ServerErrorScreen chứa <Link>, đặt ngoài router sẽ crash 'basename of null' khi catch. */}
      <FgErrorBoundary>
        <AppProviders>
          <ToastBridge />
          <SkipLink />
          <AppRoutes />
        </AppProviders>
      </FgErrorBoundary>
    </BrowserRouter>
  );
}

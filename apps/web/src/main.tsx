import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fingate/shared/tokens.css';
import './styles.css';
import App from './App.tsx';
import { registerServiceWorker } from './lib/pwa.ts';
import { startInstallCapture } from './lib/pwa-install.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: nghe `beforeinstallprompt` TRƯỚC khi mount — sự kiện có thể bắn sớm hơn lần render đầu,
// đăng ký muộn thì mất, nút "Cài ứng dụng" chỉ còn hướng dẫn thủ công.
startInstallCapture();
// ...còn SW đăng ký SAU khi React mount để không tranh băng thông với bundle đầu tiên.
registerServiceWorker();

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fingate/shared/tokens.css';
import './styles.css';
import App from './App.tsx';
import { registerServiceWorker } from './lib/pwa.ts';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// PWA: sau khi React mount mới đăng ký SW để không tranh băng thông với bundle đầu tiên.
registerServiceWorker();

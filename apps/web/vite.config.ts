import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// FinGate web — K-1: production được API serve same-origin (không CORS).
// Dev: proxy /api → api:8080 để cookie same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  // Khai báo dep sớm để Vite không re-optimize giữa session (tách bản react-router khi lazy).
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-router', 'antd', '@ant-design/icons', 'dayjs', '@fingate/shared'],
  },
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        // manualChunks theo API rolldown (Vite 8): tách engine nặng khỏi initial chunk.
        advancedChunks: {
          groups: [
            { name: 'antd', test: /node_modules[\\/](\.pnpm[\\/])?(antd|@ant-design|rc-|@rc-component)/ },
            { name: 'charts', test: /node_modules[\\/](\.pnpm[\\/])?@ant-design[\\/]plots/ },
            { name: 'react', test: /node_modules[\\/](\.pnpm[\\/])?(react|react-dom|react-router|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});

import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: {
      // 开发时把 /ws 代理到后端，避免跨域与端口差异
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: { outDir: 'dist' },
});

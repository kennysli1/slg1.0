import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  base: '/dice-lab/',
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    port: 5191,
    proxy: { '/dice-lab/api': { target: 'http://localhost:8091' } },
  },
});

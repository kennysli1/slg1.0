import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const buildId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const releaseCommit = process.env.KOW_RELEASE_COMMIT ?? 'development';
const releaseBranch = process.env.KOW_RELEASE_BRANCH ?? 'development';

export default defineConfig({
  plugins: [
    preact(),
    {
      name: 'build-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ buildId, releaseCommit, releaseBranch }),
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      // 开发时把 /ws 代理到后端，避免跨域与端口差异
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  build: { outDir: 'dist' },
  define: {
    __BUILD_ID__: JSON.stringify(buildId),
  },
});

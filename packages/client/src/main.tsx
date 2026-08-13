import { render } from 'preact';
import './styles/index.css';
import { App } from './shell/App.js';
import { startVersionMonitor } from './version.js';

render(<App />, document.getElementById('app')!);
startVersionMonitor();

// 生产环境注册 Service Worker（离线壳 + 静态资源缓存）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* SW 注册失败不影响游戏本体，静默忽略 */
    });
  });
}

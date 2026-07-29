import './style.css';
import { bootstrap } from './app/bootstrap.js';

/**
 * KOW（世界之王）前端入口。
 * 职责仅"启动" —— 实际编排在 app/bootstrap.ts，页面在 features/*，
 * 共享原子在 shared/*，配置缓存在 app/config.ts（消费服务端 GetGameConfig）。
 */
bootstrap();

// PWA：仅生产构建注册 Service Worker（dev 下注册会缓存模块、干扰 Vite HMR）。
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 注册失败不影响游戏运行，静默忽略 */
    });
  });
}

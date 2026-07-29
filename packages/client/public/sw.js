/* eslint-disable */
/**
 * 世界之王 PWA Service Worker（极简、稳妥）
 * - 导航请求(HTML)：network-first，离线回退到缓存的应用壳，保证部署后能拿到引用新 hash 资源的新 index.html
 * - 同源静态资源(JS/CSS/字体/美术)：stale-while-revalidate，秒开且后台静默更新
 * - WebSocket / 非 GET / 跨域：完全不拦截，直接放行（游戏实时通信不受影响）
 */
const CACHE = 'kow-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // 只处理同源 GET；WS 升级、POST、跨域一律放行
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 导航（HTML）：优先网络，离线回退壳
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))),
    );
    return;
  }

  // 静态资源：stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

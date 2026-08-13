declare const __BUILD_ID__: string;

const CHECK_INTERVAL_MS = 60_000;
const RELOAD_GUARD_KEY = 'kow.version-reload';
let checking = false;

/**
 * 拉取不经缓存的服务端构建指纹。检测到新部署时，先更新 SW，再只刷新一次页面。
 */
export async function checkForUpdate(): Promise<void> {
  if (!import.meta.env.PROD || checking) return;
  checking = true;
  try {
    const res = await fetch(`/version?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json() as { buildId?: unknown };
    if (typeof data.buildId !== 'string' || !data.buildId || data.buildId === __BUILD_ID__) return;

    const guard = sessionStorage.getItem(RELOAD_GUARD_KEY);
    if (guard === data.buildId) return;
    sessionStorage.setItem(RELOAD_GUARD_KEY, data.buildId);
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update().catch(() => undefined);
    location.reload();
  } catch {
    // 离线/部署切换窗口稍后重试，不干扰游戏。
  } finally {
    checking = false;
  }
}

export function startVersionMonitor(): void {
  if (!import.meta.env.PROD) return;
  window.setInterval(() => { void checkForUpdate(); }, CHECK_INTERVAL_MS);
  window.addEventListener('focus', () => { void checkForUpdate(); });
  window.addEventListener('online', () => { void checkForUpdate(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForUpdate();
  });
  void checkForUpdate();
}

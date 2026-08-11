/**
 * 应用根组件：连接生命周期、登录/游戏分流、1 秒心跳、页签路由。
 * 这里只做装配，不含任何业务渲染——各页面在 features/* 内自成一体。
 */
import { useEffect, useState } from 'preact/hooks';
import { connect, onPush, me, getProtocolError } from '../api.js';
import { loadGameConfig } from '../app/config.js';
import { tab, tick, sessionVersion } from '../app/store.js';
import { refreshAll, handlePush, hydrateReports, setSessionLostHandler } from '../app/refresh.js';
import { ModalHost, ToastHost } from '../ui/index.js';
import { TopBar } from './TopBar.js';
import { TabBar } from './TabBar.js';
import { LoginScreen } from '../features/login/LoginScreen.js';
import { VillageScreen } from '../features/village/VillageScreen.js';
import { ArmyScreen } from '../features/army/ArmyScreen.js';
import { MapScreen } from '../features/map/MapScreen.js';
import { ReportsScreen } from '../features/reports/ReportsScreen.js';

type Phase = 'boot' | 'login' | 'game';

export function App() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [notice, setNotice] = useState('连接服务器中…');

  // ---- 启动：连 WS → 拉配置 → 分流 ----
  useEffect(() => {
    setSessionLostHandler((msg) => { setNotice(msg); setPhase('login'); });
    onPush(handlePush);

    connect(
      () => {
        void (async () => {
          await loadGameConfig();
          if (!me) { setNotice(''); setPhase('login'); } else { startGame(); }
        })();
      },
      () => {
        setNotice(getProtocolError() ?? '连接已断开，正在重连…');
        setPhase('login');
      },
    );
    // connect/onPush 是模块级单例，只装一次
  }, []);

  // ---- 1 秒心跳：驱动资源外插、倒计时、进度条 ----
  useEffect(() => {
    const id = window.setInterval(() => { tick.value++; }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // ---- 标签页从后台切回：补一次刷新（WS 可能重连过、定时器被节流） ----
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible' && me) void refreshAll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  function startGame() {
    setPhase('game');
    sessionVersion.value++;
    void hydrateReports();
    void refreshAll();
  }

  if (phase !== 'game') {
    return (
      <>
        <LoginScreen booting={phase === 'boot'} notice={notice} onSuccess={startGame} />
        <ToastHost />
      </>
    );
  }

  return (
    <>
      <div class="shell">
        <TopBar />
        <TabBar />
        <Page />
      </div>
      <ModalHost />
      <ToastHost />
    </>
  );
}

function Page() {
  const t = tab.value;
  // key 让切页时整块重挂载 → 触发入场动效，同时丢弃上一页的局部状态
  return (
    <main class={`page${t === 'map' ? ' page--full' : ''} page-enter`} key={t}>
      {t === 'village' && <VillageScreen />}
      {t === 'army' && <ArmyScreen />}
      {t === 'map' && <MapScreen />}
      {t === 'reports' && <ReportsScreen />}
    </main>
  );
}

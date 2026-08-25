/** 应用装配与生命周期；具体页面渲染留在各 feature 内。 */
import { useEffect, useState } from 'preact/hooks';
import { connect, onPush, me, getProtocolError } from '../api.js';
import { loadGameConfig } from '../app/config.js';
import { tab, tick, sessionVersion, villageSwitching } from '../app/store.js';
import { refreshAll, handlePush, hydrateReports, setSessionLostHandler } from '../app/refresh.js';
import { ModalHost, ToastHost } from '../ui/index.js';
import { TopBar } from './TopBar.js';
import { TabBar } from './TabBar.js';
import { LoginScreen } from '../features/login/LoginScreen.js';
import { VillageScreen } from '../features/village/VillageScreen.js';
import { ArmyScreen } from '../features/army/ArmyScreen.js';
import { MapScreen } from '../features/map/MapScreen.js';
import { TechTreeScreen } from '../features/research/TechTreeScreen.js';
import { ReportsScreen } from '../features/reports/ReportsScreen.js';
import { TasksScreen } from '../features/village/TaskBar.js';

type Phase = 'boot' | 'login' | 'game';

export function App() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [notice, setNotice] = useState('连接服务器中…');

  useEffect(() => {
    setSessionLostHandler((message) => { setNotice(message); setPhase('login'); });
    onPush(handlePush);
    connect(
      () => {
        void (async () => {
          await loadGameConfig();
          if (!me) {
            setNotice('');
            setPhase('login');
          } else {
            startGame();
          }
        })();
      },
      () => {
        setNotice(getProtocolError() ?? '连接已断开，正在重连…');
        // 短暂断线/服务器部署时保留当前游戏画面；重连后会用持久会话自动恢复。
        if (!me) setPhase('login');
      },
    );
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => { tick.value++; }, 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible' && me) void refreshAll(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  function startGame() {
    setPhase('game');
    sessionVersion.value++;
    // 保留原先的首屏行为：报告在登录后播种，核心村庄快照立即加载；
    // refreshAll 已拆成“核心先返回、地图/次级数据后台补齐”，因此不会再堵住切村。
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
  const currentTab = tab.value;
  return (
    <>
      <div class={`shell${currentTab === 'map' ? ' shell--map' : ''}`}>
        <TopBar />
        <TabBar />
        <Page />
      </div>
      <VillageSwitchOverlay />
      <ModalHost />
      <ToastHost />
    </>
  );
}

function VillageSwitchOverlay() {
  const switching = villageSwitching.value;
  if (!switching) return null;
  return (
    <div class="village-switch-overlay" role="status" aria-live="polite" aria-busy="true">
      <div class="village-switch-card">
        <span class="village-switch-spinner" aria-hidden="true" />
        <strong>正在切换村庄…</strong>
        <span>正在加载「{switching.targetVillageName}」的数据，请稍候</span>
      </div>
    </div>
  );
}

function Page() {
  const currentTab = tab.value;
  return (
    <main
      id="main-content"
      class={`page${currentTab === 'map' ? ' page--full' : currentTab === 'village' ? ' page--village' : ''} page-enter`}
      key={currentTab}
      tabIndex={-1}
    >
      {currentTab === 'village' && <VillageScreen />}
      {currentTab === 'army' && <ArmyScreen />}
      {currentTab === 'map' && <MapScreen />}
      {currentTab === 'tech' && <TechTreeScreen />}
      {currentTab === 'tasks' && <TasksScreen />}
      {currentTab === 'reports' && <ReportsScreen />}
    </main>
  );
}

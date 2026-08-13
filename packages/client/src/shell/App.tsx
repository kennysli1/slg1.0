/** 应用装配与生命周期；具体页面渲染留在各 feature 内。 */
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
import { TechTreeScreen } from '../features/research/TechTreeScreen.js';
import { ReportsScreen } from '../features/reports/ReportsScreen.js';

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
        setPhase('login');
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
      {currentTab === 'reports' && <ReportsScreen />}
    </main>
  );
}

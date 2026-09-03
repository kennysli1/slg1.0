/** 应用装配与生命周期；具体页面渲染留在各 feature 内。 */
import { useEffect, useState } from 'preact/hooks';
import { connect, onPush, me, getProtocolError } from '../api.js';
import { loadGameConfig } from '../app/config.js';
import { tab, tick, sessionVersion, villageSwitching, allianceTargetPicker, allianceWarTarget, allianceWarFocus, selected, showToast } from '../app/store.js';
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
import { TaskDialogueHost } from '../features/village/TaskDialogueHost.js';
import { BattleSimulatorScreen } from '../features/simulator/BattleSimulatorScreen.js';
import { AllianceScreen } from '../features/alliance/AllianceScreen.js';

type Phase = 'boot' | 'login' | 'game' | 'simulator';

export function App() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [notice, setNotice] = useState('连接服务器中…');
  const simulatorMode = typeof window !== 'undefined' && window.location.pathname === '/battle-simulator';

  useEffect(() => {
    setSessionLostHandler((message) => { setNotice(message); setPhase('login'); });
    onPush(handlePush);
    connect(
      () => {
        void (async () => {
          if (simulatorMode) {
            setPhase('simulator');
            return;
          }
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
    void hydrateReports();
    void refreshAll();
  }

  if (phase === 'simulator') return <BattleSimulatorScreen />;
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
      <TaskDialogueHost />
      <ModalHost />
      <AllianceTargetCapture />
      <ToastHost />
    </>
  );
}

function AllianceTargetCapture() {
  const picking = allianceTargetPicker.value;
  const target = selected.value;
  useEffect(() => {
    if (!picking || !target || !['village', 'pve'].includes(target.kind)) return;
    if (target.taskInfo && target.taskInfo.scope !== 'global') {
      // 任务营地只属于当前玩家的任务流程，不能把个人可见目标泄露给联盟集结。
      selected.value = null;
      showToast('个人任务营地不能作为联盟战事目标', 'bad');
      return;
    }
    allianceWarTarget.value = target;
    allianceTargetPicker.value = false;
    allianceWarFocus.value = true;
    selected.value = null;
    tab.value = 'alliance';
    showToast(`已选择联盟目标：${target.name}`);
  }, [picking, target]);
  return null;
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
      {currentTab === 'alliance' && <AllianceScreen />}
    </main>
  );
}

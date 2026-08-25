/** 主导航：桌面顶部战术栏，移动端底部导航栏。 */
import { tab, dataVersion, reportsVersion, playerTaskState, type TabKey } from '../app/store.js';
import { getCache, getPendingTreasures } from '../app/state.js';
import { Icon } from '../ui/index.js';

const tabs: { key: TabKey; name: string; icon: string }[] = [
  { key: 'village', name: '村庄', icon: 'ui_tab_village' },
  { key: 'army', name: '军队', icon: 'ui_tab_army' },
  { key: 'map', name: '地图', icon: 'ui_tab_map' },
  { key: 'tech', name: '科技', icon: 'bld_academy' },
  { key: 'tasks', name: '任务', icon: 'ui_tab_reports' },
  { key: 'reports', name: '报告', icon: 'ui_tab_reports' },
];

export function TabBar() {
  const active = tab.value;
  dataVersion.value;
  reportsVersion.value;
  playerTaskState.value;
  const pending = getPendingTreasures().length;
  const marching = (getCache().moves?.movements ?? []).length;
  const taskOffers = [
    ...(playerTaskState.value?.offeredMain ?? []),
    ...(playerTaskState.value?.offeredSide ?? []),
    ...(playerTaskState.value?.offered ?? []).filter((task: any) => task?.type !== 'daily'),
  ].filter((task: any) => task?.type !== 'daily').length;
  return (
    <nav class="tabbar" aria-label="主要功能">
      {tabs.map((item) => {
        const badge = item.key === 'reports' ? pending
          : item.key === 'map' ? marching
            : item.key === 'tasks' ? taskOffers : 0;
        return (
          <button
            key={item.key}
            type="button"
            aria-current={active === item.key ? 'page' : undefined}
            class={active === item.key ? 'active' : ''}
            onClick={() => { tab.value = item.key; }}
          >
            <Icon icon={item.icon} label="" decorative size="sm" />
            <span>{item.name}</span>
            {badge > 0 && <span class="tab-badge" aria-label={item.key === 'tasks' ? `${badge} 个可接受任务` : `${badge} 条待处理信息`}>{badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}

/** 页签栏：桌面在顶部、手机贴底。报告页有未读时显示红点计数。 */
import { tab, dataVersion, reportsVersion, type TabKey } from '../app/store.js';
import { getCache, getPendingTreasures } from '../app/state.js';
import { Icon } from '../ui/index.js';

const TABS: { key: TabKey; name: string; icon: string }[] = [
  { key: 'village', name: '村庄', icon: 'ui_tab_village' },
  { key: 'army', name: '军队', icon: 'ui_tab_army' },
  { key: 'map', name: '地图', icon: 'ui_tab_map' },
  { key: 'tech', name: '科技', icon: 'bld_academy' },
  { key: 'reports', name: '报告', icon: 'ui_tab_reports' },
];

export function TabBar() {
  const active = tab.value;
  dataVersion.value; reportsVersion.value;

  // 徽标：报告页=待领取宝物数；军队页=在途部队数
  const pending = getPendingTreasures().length;
  const marching = (getCache().moves?.movements ?? []).length;

  return (
    <nav class="tabbar" role="tablist">
      {TABS.map((t) => {
        const badge = t.key === 'reports' ? pending : t.key === 'map' ? marching : 0;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active === t.key}
            class={active === t.key ? 'active' : ''}
            onClick={() => { tab.value = t.key; }}
          >
            <Icon icon={t.icon} label={t.name} size="sm" />
            <span>{t.name}</span>
            {badge > 0 && <span class="tab-badge">{badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}

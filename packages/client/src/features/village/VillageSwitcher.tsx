import { dataVersion, sessionVersion, villageSwitching } from '../../app/store.js';
import { me } from '../../api.js';
import { switchVillage } from '../../app/refresh.js';

/** 村庄页专用的紧凑切村器；完整村庄列表仍由任务页等入口保留。 */
export function VillageSwitcher() {
  sessionVersion.value;
  dataVersion.value;

  const villages = me?.villages?.length
    ? me.villages
    : me
      ? [{ id: me.villageId, q: me.q, r: me.r, name: '当前村庄', isCapital: true }]
      : [];
  const current = villages.find((v) => v.id === me?.villageId) ?? villages[0];
  const switching = villageSwitching.value;

  if (!current) return null;

  async function pick(villageId: string) {
    if (switching || villageId === me?.villageId) return;
    await switchVillage(villageId);
  }

  return (
    <details class="vil-switcher">
      <summary class="vil-switcher-trigger" aria-label="展开村庄切换器">
        <span class="vil-switcher-mark" aria-hidden="true">⌂</span>
        <span class="vil-switcher-copy">
          <span class="vil-switcher-label">当前村庄</span>
          <strong>{current.name}{current.isCapital ? ' · 主城' : ''}</strong>
          <small>X {current.q} · Y {current.r}</small>
        </span>
        <span class="vil-switcher-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div class="vil-switcher-menu" role="listbox" aria-label="选择村庄">
        <div class="vil-switcher-menu-head">
          <span>切换操作村</span>
          <small>{villages.length} 座村庄</small>
        </div>
        {villages.map((village) => (
          <button
            key={village.id}
            type="button"
            role="option"
            aria-selected={village.id === me?.villageId}
            class={`vil-switcher-option${village.id === me?.villageId ? ' is-current' : ''}`}
            disabled={!!switching}
            onClick={() => void pick(village.id)}
          >
            <span class="vil-switcher-option-icon" aria-hidden="true">
              {village.id === me?.villageId ? '◆' : '◇'}
            </span>
            <span class="vil-switcher-option-copy">
              <strong>{village.name}{village.isCapital ? '（主城）' : ''}</strong>
              <small>X {village.q} · Y {village.r}</small>
            </span>
            {village.id === me?.villageId && <span class="vil-switcher-current">当前</span>}
          </button>
        ))}
        {switching && <div class="vil-switcher-loading">正在加载「{switching.targetVillageName}」…</div>}
      </div>
    </details>
  );
}

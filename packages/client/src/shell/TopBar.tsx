/** 常驻战场 HUD：玩家身份、当前村庄与资源概况。 */
import { me, selectVillage } from '../api.js';
import { sessionVersion, showToast } from '../app/store.js';
import { refreshAll } from '../app/refresh.js';
import { errText } from '../shared/ui/text.js';
import { Icon } from '../ui/index.js';
import { ResourceBar } from './ResourceBar.js';

export function TopBar() {
  sessionVersion.value;
  const villages = me?.villages ?? [];
  const current = villages.find((v) => v.id === me?.villageId);

  async function onPick(e: Event) {
    const select = e.currentTarget as HTMLSelectElement;
    const id = select.value;
    if (!id || id === me?.villageId) return;
    const result = await selectVillage(id);
    if (!result.ok) {
      showToast(`切换村庄失败：${errText(result.error)}`, 'bad');
      select.value = me?.villageId ?? '';
      return;
    }
    sessionVersion.value++;
    await refreshAll();
  }

  return (
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><Icon icon="ui_logo" label="" decorative size="md" /></span>
        <div class="brand-copy">
          <div class="brand-title">世界之王</div>
          <div class="brand-sub">
            <span title={me?.name}>{me?.name}</span>
            {villages.length > 1 ? (
              <select class="village-pick" value={me?.villageId} onChange={onPick} aria-label="切换当前村庄">
                {villages.map((village) => (
                  <option key={village.id} value={village.id}>
                    {village.name}{village.isCapital ? '（主城）' : ''} ({village.q},{village.r})
                  </option>
                ))}
              </select>
            ) : <span title={current?.name}>{current?.name ?? `(${me?.q},${me?.r})`}</span>}
          </div>
        </div>
      </div>
      <ResourceBar />
    </header>
  );
}

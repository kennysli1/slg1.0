import { me, selectVillage } from '../../api.js';
import { refreshAll } from '../../app/refresh.js';
import { dataVersion, sessionVersion, showToast } from '../../app/store.js';
import { Panel } from '../../ui/index.js';

/** 村庄工作区切换器：村庄、军队、科技页共用，明确当前数据所属村庄。 */
export function VillageList() {
  sessionVersion.value;
  dataVersion.value;
  const villages = me?.villages ?? [];
  if (villages.length <= 1) return null;

  async function pick(villageId: string) {
    if (!villageId || villageId === me?.villageId) return;
    const result = await selectVillage(villageId);
    if (!result.ok) {
      showToast('切换村庄失败，请稍后重试', 'bad');
      return;
    }
    sessionVersion.value++;
    await refreshAll();
  }

  return (
    <Panel variant="flat" pad class="village-list-panel">
      <div class="village-list-title">我的村庄</div>
      <div class="village-list" role="list" aria-label="切换村庄">
        {villages.map((village) => (
          <button
            key={village.id}
            type="button"
            role="listitem"
            class={`village-list-item${village.id === me?.villageId ? ' active' : ''}`}
            aria-current={village.id === me?.villageId ? 'page' : undefined}
            onClick={() => void pick(village.id)}
          >
            <span class="village-list-name">{village.name}{village.isCapital ? '（主城）' : ''}</span>
            <span class="village-list-coords">X {village.q} · Y {village.r}</span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

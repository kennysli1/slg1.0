/** 地图页的己方村庄空间索引：定位、切换操作上下文，但不离开地图。 */
import { dataVersion, selected, showToast } from '../../app/store.js';
import { getCache } from '../../app/state.js';
import { me } from '../../api.js';
import { switchVillage, setMapCenter } from '../../app/refresh.js';
import { fmt } from '../../shared/utils/format.js';
import { Panel, SectionHead, Tag } from '../../ui/index.js';

export function MapVillageIndex() {
  dataVersion.value;
  const overview = getCache().kingdomOverview as any;
  const villages = overview?.villages ?? me?.villages ?? [];
  if (!villages.length) return null;

  async function focus(village: any) {
    const villageId = village.villageId ?? village.id;
    if (!villageId) return;
    setMapCenter({ q: village.q, r: village.r });
    selected.value = { refId: villageId, kind: 'own_village', q: village.q, r: village.r, name: village.name };
    if (villageId === me?.villageId) return;
    const result = await switchVillage(villageId);
    if (!result.ok) showToast('切换村庄失败，请稍后重试', 'bad');
  }

  return (
    <Panel pad class="map-village-index">
      <SectionHead sub="选择后留在地图，并切换当前操作村">己方村庄</SectionHead>
      <div class="map-village-index-list" role="list">
        {villages.map((village: any) => {
          const villageId = village.villageId ?? village.id;
          const isCurrent = villageId === me?.villageId;
          const resources = village.resources;
          return (
            <button key={villageId} type="button" role="listitem" class={`map-village-index-item${isCurrent ? ' is-current' : ''}`} onClick={() => void focus(village)}>
              <span class="map-village-index-marker" aria-hidden="true">{isCurrent ? '◆' : '◇'}</span>
              <span class="map-village-index-copy">
                <strong>{village.name}</strong><small>X {village.q} · Y {village.r}</small>
                {resources && <em>库存 {fmt(Number(resources.wood ?? 0) + Number(resources.clay ?? 0) + Number(resources.iron ?? 0) + Number(resources.crop ?? 0) + Number(resources.gold ?? 0))}</em>}
              </span>
              {village.isCapital && <Tag kind="gold">主城</Tag>}
              {isCurrent && <Tag kind="jade">当前</Tag>}
            </button>
          );
        })}
      </div>
    </Panel>
  );
}

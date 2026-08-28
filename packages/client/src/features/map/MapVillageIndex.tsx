/** 地图页的己方村庄空间索引：定位、切换操作上下文，但不离开地图。 */
import { dataVersion, selected } from '../../app/store.js';
import { me } from '../../api.js';
import { setMapCenter } from '../../app/refresh.js';
import { Panel, SectionHead, Tag } from '../../ui/index.js';
import { inspectOwnedVillage } from './owned-village-selection.js';

export function MapVillageIndex() {
  dataVersion.value;
  const villages = me?.villages ?? [];
  if (!villages.length) return null;

  function focus(village: any) {
    const villageId = village.villageId ?? village.id;
    if (!villageId) return;
    inspectOwnedVillage({ id: villageId, q: village.q, r: village.r, name: village.name }, setMapCenter, (target) => { selected.value = target; });
  }

  return (
    <Panel pad class="map-village-index">
      <SectionHead sub="选择只定位；在目标卡确认后才切换">己方村庄</SectionHead>
      <div class="map-village-index-list" role="list">
        {villages.map((village: any) => {
          const villageId = village.villageId ?? village.id;
          const isCurrent = villageId === me?.villageId;
          return (
            <button key={villageId} type="button" role="listitem" class={`map-village-index-item${isCurrent ? ' is-current' : ''}`} onClick={() => focus(village)}>
              <span class="map-village-index-marker" aria-hidden="true">{isCurrent ? '◆' : '◇'}</span>
              <span class="map-village-index-copy">
                <strong>{village.name}</strong><small>X {village.q} · Y {village.r}</small>
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

/**
 * MapScreen — 地图页顶层容器。
 * 布局：全屏 SVG 地图 + 桌面右侧战术栏（目标工作流与行军态势）。
 * 手机上目标工作流变为贴底抽屉，避免把表单和地图控件挤在同一视野内。
 */
import { useEffect } from 'preact/hooks';
import { selected, garrisonContinue, mapAreaStale } from '../../app/store.js';
import { HexMap } from './HexMap.js';
import { TargetPanel } from './TargetPanel.js';
import { MarchList } from './MarchList.js';
import { refreshMapArea } from '../../app/refresh.js';
import { IncomingWarnings } from '../../shared/ui/IncomingWarnings.js';
import { MapVillageIndex } from './MapVillageIndex.js';

export function MapScreen() {
  void selected.value;
  void garrisonContinue.value;
  const areaStale = mapAreaStale.value;
  useEffect(() => {
    if (areaStale) void refreshMapArea();
  }, [areaStale]);
  const showPanel = !!selected.value || !!garrisonContinue.value;
  return (
    <div class="map-screen">
      {/* 全屏 SVG 地图（含浮层导航控件和图例） */}
      <HexMap />

      <aside class="map-tactical-stack" aria-label="地图战术面板">
        <IncomingWarnings />
        <MapVillageIndex />
        {showPanel && <TargetPanel />}
        <MarchList />
      </aside>
    </div>
  );
}

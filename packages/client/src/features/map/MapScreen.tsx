/**
 * MapScreen — 地图页顶层容器。
 * 布局：全屏 SVG 地图（HexMap）+ 目标动作面板（TargetPanel，浮层）+ 行军列表（MarchList）。
 * 当无选中目标时，MarchList 占据右下角；有选中时，目标面板占据右侧，MarchList 随之向下移动。
 * 手机端：目标面板变贴底抽屉，MarchList 隐藏（行军信息集成在目标面板或 overlay 中）。
 */
import { selected } from '../../app/store.js';
import { HexMap } from './HexMap.js';
import { TargetPanel } from './TargetPanel.js';
import { MarchList } from './MarchList.js';

export function MapScreen() {
  const hasSel = !!selected.value;
  return (
    <div class="map-screen">
      {/* 全屏 SVG 地图（含浮层导航控件和图例） */}
      <HexMap />

      {/* 目标动作面板：右侧浮层（桌面）/ 贴底抽屉（手机） */}
      {hasSel && <TargetPanel />}

      {/* 行军中列表：右下角浮层（桌面），有目标时在目标面板下方 */}
      {!hasSel && <MarchList />}
    </div>
  );
}

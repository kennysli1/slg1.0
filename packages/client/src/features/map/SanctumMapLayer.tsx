/**
 * 圣地地图覆盖层与图例。
 *
 * 必须保持为 HexMap 的独立子组件：圣地状态更新只能重绘这层，不能让基础
 * 地形、地块剔除、行军路径和命中层重新计算。dormant 时直接返回 null，
 * 不向基础地图树注入空的 SVG 图层。
 */
import { sanctumMapState } from '../../app/store.js';
import { HEX_SIZE, hexCorners } from '../../shared/utils/hex.js';
import { sanctumMapMarkersFromState } from './sanctum-map.js';

const HEX_CORNER_STR = hexCorners()
  .map((corner) => `${corner.x.toFixed(2)},${corner.y.toFixed(2)}`)
  .join(' ');

export function SanctumMapLayer({
  markerPixel,
}: {
  markerPixel: (q: number, r: number) => { x: number; y: number };
}) {
  const snapshot = sanctumMapState.value;
  if (!snapshot) return null;
  const markers = sanctumMapMarkersFromState(snapshot);
  if (markers.length === 0) return null;

  return <>
    {markers.map((marker) => {
      const point = markerPixel(marker.q, marker.r);
      return (
        <g
          key={`sanctum-${marker.kind}-${marker.id}`}
          class={`sanctum-map-marker sanctum-map-marker--${marker.kind}`}
          transform={`translate(${point.x.toFixed(1)},${point.y.toFixed(1)})`}
        >
          <title>{marker.kind === 'sanctum' ? `已发现：${marker.name}` : `远弦公共条件：${marker.name}`}</title>
          <polygon class={`hex-ring hex-ring--sanctum-${marker.kind}`} points={HEX_CORNER_STR} />
          <text class="sanctum-map-marker-glyph" textAnchor="middle" dy={HEX_SIZE * 0.32}>{marker.kind === 'sanctum' ? '✧' : '✦'}</text>
        </g>
      );
    })}
  </>;
}

/** dormant 阶段不渲染圣地图例，保持基础地图的浮层布局不变。 */
export function SanctumMapLegend() {
  if (!sanctumMapState.value) return null;
  return <div class="map-legend-row"><span class="map-legend-sanctum">✦</span>远弦条件 / 已发现圣地</div>;
}

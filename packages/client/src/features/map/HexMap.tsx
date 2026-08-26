/**
 * HexMap — SVG 六边形地图渲染器。
 * 职责：相机（平移/缩放/复位）、视口剔除、连续地貌、行军路径动画、悬停提示、点击选格。
 * 状态规则：相机值存 useRef（避免拖拽重渲），只在需要重算剔除时 bump cullVer 触发渲染。
 */
import * as preact from 'preact';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { hexToPixel, hexCorners, HEX_SIZE, type Hex } from '../../shared/utils/hex.js';
import { worldW, worldH, pveInfoByType } from '../../app/config.js';
import { getCache } from '../../app/state.js';
import { dataVersion, selected, tick, taskMarkers, findTaskCampMarker, foreignMoves, tab } from '../../app/store.js';
import { getMapCenter, setMapCenter, refreshForeignMoves } from '../../app/refresh.js';
import type { ForeignArmy } from '@slg/shared';
import { me, ownVillageAt } from '../../api.js';
import { artPath, Btn } from '../../ui/index.js';
import { capitalCoordinate, currentVillageCoordinate, currentVillageName, parseMapCoordinate } from './map-navigation.js';
import { foreignArmyAt, foreignArmyName } from './map-target-helpers.js';

// ─── constants ───────────────────────────────────────────────────────────────
const ZOOM_MIN = 0.8;
const ZOOM_MAX = 1.2;
const INITIAL_ZOOM = 1;
const PAD = HEX_SIZE * 1.4;
const DRAG_THRESHOLD = 8; // 超过此像素视为拖拽，不触发点击
const TIP_ABOVE = 72; // tooltip 锚定在格心上方时的上移量

/** pointy-top 六边形六个顶点字符串（模块级常量，避免每帧重建） */
const HEX_CORNER_STR = hexCorners()
  .map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`)
  .join(' ');

// ─── terrain helpers ─────────────────────────────────────────────────────────

export type Terrain = 'plain' | 'forest' | 'hills';
type Visibility = 'unexplored' | 'explored' | 'visible';

/**
 * 地形只认服务端事实；旧响应缺字段时安全降级平原，未探索格不读取也不保留地形。
 * 导出纯函数供协议兼容回归测试使用。
 */
export function terrainFromTile(tile: { terrain?: unknown } | undefined, visibility: Visibility): Terrain | null {
  if (visibility === 'unexplored') return null;
  return tile?.terrain === 'forest' || tile?.terrain === 'hills' || tile?.terrain === 'plain'
    ? tile.terrain
    : 'plain';
}

/** 地形是空闲格的地貌名称，不改变其可驻扎/拓荒的玩法 kind。 */
export function terrainDisplayName(terrain: Terrain | null): string {
  if (terrain === 'forest') return '森林';
  if (terrain === 'hills') return '丘陵';
  if (terrain === 'plain') return '平原';
  return '未探索区域';
}

/**
 * 路线只代表“正在行军”的计划；抵达后服务端会保留 path 供召回/续行，
 * 但地图上不应继续把它当成活动路线绘制。
 */
export function shouldRenderMarchPath(movement: { status?: unknown; path?: unknown }): boolean {
  return movement.status === 'marching' && Array.isArray(movement.path) && movement.path.length >= 2;
}

/** 仅用于地貌装饰的稳定世界坐标散点，不参与决定地形类型。 */
function terrainNoise(q: number, r: number, salt: number): number {
  return (Math.imul((q + 97) * 73856093 ^ (r + 193) * 19349663 ^ salt, 0x45d9f3b) >>> 0) / 0xffffffff;
}

/** 已占据格根据 tile.kind + 是否是自己，确定描边颜色 key。 */
function ringKind(kind: string, isSelf: boolean): string {
  if (kind === 'own_village') return isSelf ? 'self' : 'own';
  if (kind === 'village') return 'enemy';
  if (kind === 'pve') return 'pve';
  return '';
}

// ─── hex math ────────────────────────────────────────────────────────────────
function hexDistance(a: Hex, b: Hex): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}
function hexDistanceWrapped(a: Hex, b: Hex, W: number, H: number): number {
  let best = hexDistance(a, b);
  for (let dq = -W; dq <= W; dq += W) {
    for (let dr = -H; dr <= H; dr += H) {
      if (dq === 0 && dr === 0) continue;
      const d = hexDistance(a, { q: b.q + dq, r: b.r + dr });
      if (d < best) best = d;
    }
  }
  return best;
}
function wrapCoord(q: number, r: number, W: number, H: number) {
  return { q: ((q % W) + W) % W, r: ((r % H) + H) % H };
}

/** 当前视口中心在相机坐标系下的像素位置（与 hex-cell 的 camX/camY 同系）。 */
function viewRefCamera(
  panX: number, panY: number, zoom: number, cw: number, ch: number,
): { x: number; y: number } {
  return { x: (cw / 2 - panX) / zoom, y: (ch / 2 - panY) / zoom };
}

/** 把六边形基准像素对齐到距 ref 最近的环面副本。 */
function wrapPixelNearRef(
  x: number, y: number, refX: number, refY: number, W: number, H: number,
): { x: number; y: number } {
  const Vx = hexToPixel({ q: W, r: 0 });
  const Vy = hexToPixel({ q: 0, r: H });
  if (Math.abs(Vx.x) < 1e-6 || Math.abs(Vy.y) < 1e-6) return { x, y };
  const v = (refY - y) / Vy.y;
  const u = (refX - x - v * Vy.x) / Vx.x;
  const i = Math.round(u);
  const j = Math.round(v);
  return { x: x + i * Vx.x + j * Vy.x, y: y + j * Vy.y };
}

/**
 * 行军路径在环面地图上展开：首点对齐视口，后续每格选与上一格相邻的最近副本，
 * 避免折线画到屏幕外或跨图断线。
 */
function unwrapPathPixels(
  path: Hex[], ox: number, oy: number, refX: number, refY: number, W: number, H: number,
): { x: number; y: number }[] {
  const Vx = hexToPixel({ q: W, r: 0 });
  const Vy = hexToPixel({ q: 0, r: H });
  const out: { x: number; y: number }[] = [];
  for (let idx = 0; idx < path.length; idx++) {
    const p = hexToPixel(path[idx]);
    let x = p.x + ox;
    let y = p.y + oy;
    if (idx === 0) {
      ({ x, y } = wrapPixelNearRef(x, y, refX, refY, W, H));
    } else {
      const prev = out[idx - 1];
      let bestX = x, bestY = y, bestD = Infinity;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const tx = x + di * Vx.x + dj * Vy.x;
          const ty = y + dj * Vy.y;
          const d = Math.hypot(tx - prev.x, ty - prev.y);
          if (d < bestD) { bestD = d; bestX = tx; bestY = ty; }
        }
      }
      x = bestX;
      y = bestY;
    }
    out.push({ x, y });
  }
  return out;
}

/** 单格对齐视口最近副本（部队标记/悬停用）。 */
function cameraPixelForHex(
  q: number, r: number, ox: number, oy: number, refX: number, refY: number, W: number, H: number,
): { x: number; y: number } {
  const p = hexToPixel({ q, r });
  return wrapPixelNearRef(p.x + ox, p.y + oy, refX, refY, W, H);
}

// ─── tile index ──────────────────────────────────────────────────────────────
let _tilesRef: any = null;
let _tileIndex: Map<string, any> | null = null;
function getTileIndex(): Map<string, any> | null {
  const tiles = getCache().area?.tiles;
  if (!tiles) return null;
  if (_tilesRef !== tiles) {
    _tileIndex = new Map<string, any>();
    for (const t of tiles) _tileIndex.set(`${t.q},${t.r}`, t);
    _tilesRef = tiles;
  }
  return _tileIndex;
}
function tileAt(q: number, r: number): any {
  return getTileIndex()?.get(`${q},${r}`);
}

// ─── PvE icon helper ─────────────────────────────────────────────────────────
function pveIcon(name?: string): string {
  const type = name?.includes('鼠') ? 'rats'
    : name?.includes('狼') ? 'wolves'
    : 'bandits';
  return pveInfoByType(type)?.icon ?? 'pve_bandits';
}

// ─── component ───────────────────────────────────────────────────────────────
export function HexMap() {
  // 订阅服务端数据（dataVersion 变化时整组件重渲，重算可见格）
  const _dv = dataVersion.value;
  const _tk = tick.value; // 订阅心跳：行军 ETA 文案每秒刷新
  void selected.value;
  void foreignMoves.value;

  const W = worldW(), H = worldH();

  // ── 相机状态（ref，避免拖拽重渲）──
  const zoom   = useRef(INITIAL_ZOOM);
  const panX   = useRef(0);
  const panY   = useRef(0);
  const ox     = useRef(PAD);  // 世界原点偏移（中心副本）
  const oy     = useRef(PAD);
  const cw     = useRef(1000);
  const ch     = useRef(700);

  // ── DOM refs ──
  const svgEl    = useRef<SVGSVGElement>(null);
  const camEl    = useRef<SVGGElement>(null);
  const markerEl = useRef<SVGGElement>(null);
  const foreignEl = useRef<SVGGElement>(null);

  // ── 视口剔除触发器 ──
  const [_cullVer, setCullVer] = useState(0);
  const scheduleCull = useCallback(() => setCullVer((v) => v + 1), []);

  // ── 导航 UI 状态 ──
  const centeredKey  = useRef('');
  const [homeCentered, setHomeCentered] = useState(true);
  const [navCoord,     setNavCoord]     = useState({ q: me?.q ?? 0, r: me?.r ?? 0 });
  const [jumpQ, setJumpQ] = useState(String(me?.q ?? 0));
  const [jumpR, setJumpR] = useState(String(me?.r ?? 0));
  const [jumpError, setJumpError] = useState('');
  const jumpEditing = useRef(false);
  const [zoomUi, setZoomUi] = useState(INITIAL_ZOOM);

  // ── Tooltip ──
  type TipState = { q: number; r: number; kind: string; name: string; dist: number; anchorX: number; anchorY: number } | null;
  const [tooltip, setTooltip] = useState<TipState>(null);
  const hovKey = useRef('');

  /** 相机坐标系下的格心 → 屏幕 client 坐标（与 wheel 缩放同一套 pan/zoom）。 */
  function cameraToScreen(camX: number, camY: number): { x: number; y: number } {
    const rect = svgEl.current?.getBoundingClientRect();
    if (!rect) return { x: camX, y: camY };
    return {
      x: rect.left + panX.current + zoom.current * camX,
      y: rect.top + panY.current + zoom.current * camY,
    };
  }

  // ── 拖拽状态 ──
  const dragging    = useRef(false);
  const dragMoved   = useRef(false);
  const dragSX      = useRef(0);
  const dragSY      = useRef(0);
  const dragPX      = useRef(0);
  const dragPY      = useRef(0);
  const suppress    = useRef(false);
  const pinchDist   = useRef(0);
  const pinchZoom   = useRef(1);
  const pinchMidX   = useRef(0);
  const pinchMidY   = useRef(0);
  const pinchPX     = useRef(0);
  const pinchPY     = useRef(0);

  // ── rAF ──
  const rafRef = useRef<number | null>(null);

  // ─── camera helpers ────────────────────────────────────────────────────────
  function clampZoom(z: number): number {
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  }

  function applyTransform() {
    camEl.current?.setAttribute(
      'transform',
      `translate(${panX.current.toFixed(2)},${panY.current.toFixed(2)}) scale(${zoom.current.toFixed(4)})`,
    );
  }

  function syncZoomUi() {
    setZoomUi(zoom.current);
  }

  function adjustZoom(factor: number, anchorSx?: number, anchorSy?: number) {
    const rect = svgEl.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = anchorSx ?? rect.width / 2;
    const sy = anchorSy ?? rect.height / 2;
    const prev = zoom.current;
    const fw = (sx - panX.current) / zoom.current;
    const fh = (sy - panY.current) / zoom.current;
    zoom.current = clampZoom(zoom.current * factor);
    if (zoom.current === prev) return;
    panX.current = sx - zoom.current * fw;
    panY.current = sy - zoom.current * fh;
    reducePanToLattice();
    applyTransform();
    scheduleCull();
    syncNavUI();
    syncZoomUi();
  }

  function viewRef(): { x: number; y: number } {
    return viewRefCamera(panX.current, panY.current, zoom.current, cw.current, ch.current);
  }

  function reducePanToLattice() {
    const { x: Vxx } = hexToPixel({ q: W, r: 0 });
    const Vy = hexToPixel({ q: 0, r: H });
    if (Math.abs(Vxx) < 1e-6 || Math.abs(Vy.y) < 1e-6) return;
    const bx = ox.current, by = oy.current;
    const cx = (cw.current / 2 - panX.current) / zoom.current;
    const cy = (ch.current / 2 - panY.current) / zoom.current;
    const v = (cy - by) / Vy.y;
    const u = (cx - bx - v * Vy.x) / Vxx;
    const uR = u - Math.round(u);
    const vR = v - Math.round(v);
    const cxR = bx + uR * Vxx + vR * Vy.x;
    const cyR = by + vR * Vy.y;
    panX.current = cw.current / 2 - zoom.current * cxR;
    panY.current = ch.current / 2 - zoom.current * cyR;
  }

  const centerViewOn = useCallback((q: number, r: number) => {
    const p = hexToPixel({ q, r });
    const wx = p.x + ox.current;
    const wy = p.y + oy.current;
    panX.current = cw.current / 2 - zoom.current * wx;
    panY.current = ch.current / 2 - zoom.current * wy;
    reducePanToLattice();
    applyTransform();
    centeredKey.current = `${q},${r}`;
    scheduleCull();
  }, []); // intentional empty deps: uses only refs

  function viewCenter(): { q: number; r: number } {
    return getMapCenter() ?? { q: me?.q ?? 0, r: me?.r ?? 0 };
  }

  function cameraCenter(): { q: number; r: number } {
    const x = (cw.current / 2 - panX.current) / zoom.current - ox.current;
    const y = (ch.current / 2 - panY.current) / zoom.current - oy.current;
    const fractionalR = (2 / 3 * y) / HEX_SIZE;
    const fractionalQ = (Math.sqrt(3) / 3 * x - y / 3) / HEX_SIZE;

    // axial → cube 后取最近六边形。
    let q = Math.round(fractionalQ);
    let r = Math.round(fractionalR);
    const s = Math.round(-fractionalQ - fractionalR);
    const qDiff = Math.abs(q - fractionalQ);
    const rDiff = Math.abs(r - fractionalR);
    const sDiff = Math.abs(s + fractionalQ + fractionalR);
    if (qDiff > rDiff && qDiff > sDiff) q = -r - s;
    else if (rDiff > sDiff) r = -q - s;
    return wrapCoord(q, r, W, H);
  }

  function isHomeCentered(): boolean {
    const current = currentVillageCoordinate(me) ?? capitalCoordinate(me);
    if (!current || zoom.current <= 0 || cw.current <= 0) return true;
    const hp = hexToPixel(current);
    const hx = hp.x + ox.current, hy = hp.y + oy.current;
    const cx = (cw.current / 2 - panX.current) / zoom.current;
    const cy = (ch.current / 2 - panY.current) / zoom.current;
    const Vx = hexToPixel({ q: W, r: 0 });
    const Vy = hexToPixel({ q: 0, r: H });
    if (Math.abs(Vx.x) < 1e-6 || Math.abs(Vy.y) < 1e-6) return true;
    const v = (cy - hy) / Vy.y;
    const u = (cx - hx - v * Vy.x) / Vx.x;
    const dx = (u - Math.round(u)) * Vx.x + (v - Math.round(v)) * Vy.x;
    const dy = (v - Math.round(v)) * Vy.y;
    return Math.hypot(dx, dy) * zoom.current <= 2;
  }

  function syncNavUI() {
    const c = cameraCenter();
    setMapCenter(c);
    setNavCoord(c);
    setHomeCentered(isHomeCentered());
  }

  function resetView() {
    zoom.current = clampZoom(INITIAL_ZOOM);
    centerViewOn(viewCenter().q, viewCenter().r);
    syncNavUI();
    syncZoomUi();
  }

  // ─── viewport culling ──────────────────────────────────────────────────────
  interface HexCell {
    q: number; r: number;
    camX: number; camY: number;
    kind: string;
    refId: string;
    name: string;
    icon: string | null;
    terrain: Terrain | null;
    visibility: Visibility;
    isSelected: boolean;
    isSelf: boolean;
  }

  function buildVisibleHexes(): HexCell[] {
    const Vx = hexToPixel({ q: W, r: 0 });
    const Vy = hexToPixel({ q: 0, r: H });
    const Vsx = { x: zoom.current * Vx.x, y: 0 };
    const Vsy = { x: zoom.current * Vy.x, y: zoom.current * Vy.y };
    const margin = HEX_SIZE * zoom.current * 0.8;
    const x0 = -margin, x1 = cw.current + margin;
    const y0 = -margin, y1 = ch.current + margin;
    if (Vsy.y === 0 || Vsx.x === 0) return [];

    const sel = selected.value;
    const cells: HexCell[] = [];

    for (let r = 0; r < H; r++) {
      for (let q = 0; q < W; q++) {
        const p = hexToPixel({ q, r });
        const baseX = ox.current + p.x;
        const baseY = oy.current + p.y;
        const bx = panX.current + zoom.current * baseX;
        const by = panY.current + zoom.current * baseY;
        const jMin = Math.floor((y0 - by) / Vsy.y) - 1;
        const jMax = Math.ceil((y1 - by) / Vsy.y) + 1;

        for (let j = jMin; j <= jMax; j++) {
          const xBase = bx + j * Vsy.x;
          const iMin = Math.floor((x0 - xBase) / Vsx.x) - 1;
          const iMax = Math.ceil((x1 - xBase) / Vsx.x) + 1;
          for (let i = iMin; i <= iMax; i++) {
            const sx = bx + i * Vsx.x + j * Vsy.x;
            const sy = by + j * Vsy.y;
            if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue;
            const camX = baseX + i * Vx.x + j * Vy.x;
            const camY = baseY + j * Vy.y;

            // Determine tile kind/name/icon
            const isSelf = !!(me && me.q === q && me.r === r);
            const ownV = ownVillageAt(q, r);
            const t = tileAt(q, r);
            const visibility = (t?.visibility ?? 'visible') as Visibility;
            // 任务营地（taskMarkers 提供，不在 area.tiles 里）：当作可掠夺的 pve 目标
            const taskCamp = visibility === 'unexplored'
              ? undefined
              : (taskMarkers.value[me?.villageId ?? ''] ?? []).find((c: any) => c.q === q && c.r === r && !c.cleared);
            let kind = 'empty', refId = `empty-${q},${r}`, name = '空地', icon: string | null = null;
            const terrain = terrainFromTile(t, visibility);

            if (visibility !== 'unexplored') name = terrainDisplayName(terrain);
            if (visibility === 'unexplored') {
              name = '未探索区域'; // 未探索格不能通过名称泄露地貌。
            } else if (isSelf) {
              // me.name 是玩家名，不是村庄名；当前村标签必须来自 villages 快照。
              kind = 'own_village'; refId = me!.villageId; name = currentVillageName(me) ?? me!.name;
              icon = 'bld_main';
            } else if (ownV) {
              kind = 'own_village'; refId = ownV.id; name = ownV.name;
              icon = 'bld_main';
            } else if (taskCamp) {
              kind = 'pve'; refId = taskCamp.id; name = '任务营地';
              icon = pveIcon('任务营地');
            } else if (t?.kind === 'village') {
              kind = 'village'; refId = t.refId; name = t.name;
              icon = 'bld_main';
            } else if (t?.kind === 'pve') {
              kind = 'pve'; refId = t.refId; name = t.name;
              icon = t.icon ?? pveIcon(t.name);
            } else if (t?.kind === 'taskcamp') {
              // 任务营地通常由 taskMarkers 注入；保留真实地块兜底，避免详情丢失时退化为空地。
              kind = 'pve'; refId = t.refId; name = t.name ?? '任务营地';
              icon = t.icon ?? pveIcon('任务营地');
            }

            cells.push({
              q, r, camX, camY, kind, refId, name, icon, terrain, visibility,
              isSelf,
              isSelected: !!(sel && sel.q === q && sel.r === r),
            });
          }
        }
      }
    }
    return cells;
  }

  function hexPath(c: HexCell, scale = 1.02): string {
    const points = hexCorners().map((corner) => ({
      x: c.camX + corner.x * scale,
      y: c.camY + corner.y * scale,
    }));
    return `M${points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join('L')}Z`;
  }

  function circlePath(cx: number, cy: number, radius: number): string {
    return `M${(cx - radius).toFixed(1)},${cy.toFixed(1)}a${radius},${radius} 0 1,0 ${(radius * 2).toFixed(1)},0a${radius},${radius} 0 1,0 ${(-radius * 2).toFixed(1)},0`;
  }

  /**
   * 地形按种类与视野态聚合成少量 path。相邻同类六边形因轻微重叠自然合并，
   * 交互格仍独立存在，但不再为每格创建贴图或常驻描边。
   */
  function buildTerrainLayers(cells: HexCell[]) {
    const surfaces = new Map<string, string[]>();
    const plainTexture = new Map<Visibility, string[]>();
    const forestCanopy = new Map<Visibility, string[]>();
    const hillRidges = new Map<Visibility, string[]>();
    const fog = new Map<'unexplored', string[]>();
    const cellsByWorldCoordinate = new Map<string, HexCell[]>();

    for (const c of cells) {
      const coordinateKey = `${c.q},${c.r}`;
      const coordinateCells = cellsByWorldCoordinate.get(coordinateKey) ?? [];
      coordinateCells.push(c);
      cellsByWorldCoordinate.set(coordinateKey, coordinateCells);

      if (c.terrain) {
        const surfaceKey = `${c.terrain}-${c.visibility}`;
        const surface = surfaces.get(surfaceKey) ?? [];
        surface.push(hexPath(c));
        surfaces.set(surfaceKey, surface);

        if (c.terrain === 'plain') {
          const texture = plainTexture.get(c.visibility) ?? [];
          texture.push(hexPath(c, 1));
          plainTexture.set(c.visibility, texture);
        }

        if (c.terrain === 'forest') {
          const canopy = forestCanopy.get(c.visibility) ?? [];
          const offsetX = (terrainNoise(c.q, c.r, 17) - 0.5) * HEX_SIZE * 0.42;
          const offsetY = (terrainNoise(c.q, c.r, 31) - 0.5) * HEX_SIZE * 0.34;
          const radius = HEX_SIZE * (0.48 + terrainNoise(c.q, c.r, 47) * 0.12);
          canopy.push(circlePath(c.camX + offsetX, c.camY + offsetY, radius));
          canopy.push(circlePath(c.camX - offsetX * 0.72, c.camY - offsetY * 0.55, radius * 0.72));
          forestCanopy.set(c.visibility, canopy);
        }
      }

      // 已探索地块仍然显示完整地貌；只有未探索区域需要遮罩，避免“记忆中的地形”
      // 被黑雾压成无法辨认的色块，同时不泄露服务器没有下发的地貌事实。
      if (c.visibility === 'unexplored') {
        const paths = fog.get('unexplored') ?? [];
        paths.push(hexPath(c, 1.025));
        fog.set('unexplored', paths);
      }
    }

    // 只沿相邻丘陵格中心连线；同一视觉副本的线段会跨过格边形成连续山脊。
    const ridgeDirections = [{ q: 1, r: 0 }, { q: 0, r: 1 }, { q: 1, r: -1 }];
    for (const c of cells) {
      if (c.terrain !== 'hills') continue;
      for (const direction of ridgeDirections) {
        const target = wrapCoord(c.q + direction.q, c.r + direction.r, W, H);
        let neighbor: HexCell | undefined;
        let nearest = Infinity;
        for (const candidate of cellsByWorldCoordinate.get(`${target.q},${target.r}`) ?? []) {
          if (candidate.terrain !== 'hills') continue;
          const distance = Math.hypot(candidate.camX - c.camX, candidate.camY - c.camY);
          if (distance < nearest) { neighbor = candidate; nearest = distance; }
        }
        if (!neighbor || nearest > HEX_SIZE * 2) continue;
        const visibility: Visibility = c.visibility === 'explored' || neighbor.visibility === 'explored'
          ? 'explored'
          : 'visible';
        const paths = hillRidges.get(visibility) ?? [];
        paths.push(`M${c.camX.toFixed(1)},${c.camY.toFixed(1)}L${neighbor.camX.toFixed(1)},${neighbor.camY.toFixed(1)}`);
        hillRidges.set(visibility, paths);
      }
    }

    return { surfaces, plainTexture, forestCanopy, hillRidges, fog };
  }

  // ─── march path + marker rendering ────────────────────────────────────────
  function buildMarchPaths() {
    const ownMoves: any[] = getCache().playerMoves?.movements ?? getCache().moves?.movements ?? [];
    const incoming = (getCache().playerMoves?.incomingWarnings ?? getCache().moves?.incomingWarnings ?? []).map((warning: any) => ({
      ...warning,
      type: 'incoming_warning',
      status: 'marching',
    }));
    const moves: any[] = [...ownMoves, ...incoming];
    const paths: preact.VNode[] = [];
    const ref = viewRef();
    moves.forEach((m, i) => {
      if (!shouldRenderMarchPath(m)) return;
      const pts = unwrapPathPixels(m.path, ox.current, oy.current, ref.x, ref.y, W, H)
        .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
        .join(' ');
      const t = m.type === 'return' ? 'return'
        : m.type === 'transport' ? 'transport'
        : m.type === 'found'     ? 'found'
        : m.type === 'caravan'   ? 'caravan'
        : m.type === 'garrison'  ? 'garrison'
        : m.type === 'ambush'    ? 'ambush'
        : m.type === 'explore'   ? 'explore'
        : m.type === 'auto_explore' ? 'explore'
        : m.type === 'incoming_scout' ? 'incoming-scout'
        : m.type === 'incoming_warning' ? 'incoming-warning'
        : m.type === 'attack'    ? 'attack'
        : m.type === 'raid'      ? 'raid'
        : 'return';
      paths.push(
        <polyline
          key={`path-${i}`}
          class={`march-path march-path--${t}`}
          points={pts}
        />,
      );
    });
    return paths;
  }

  function buildMarchMarkers() {
    const moves: any[] = getCache().playerMoves?.movements ?? getCache().moves?.movements ?? [];
    const markers: preact.VNode[] = [];
    const ref = viewRef();
    moves.forEach((m, i) => {
      if (!m.pos) return;
      const p = cameraPixelForHex(m.pos.q, m.pos.r, ox.current, oy.current, ref.x, ref.y, W, H);
      const t = m.type ?? 'return';
      markers.push(
        <g
          key={`mk-${i}`}
          id={`march-mk-${i}`}
          data-own-move-id={m.id}
          class="own-march-mk"
          transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}
        >
          <title>{m.type ?? 'return'} · {m.status === 'stationed' ? '驻扎中' : '行军中'}</title>
          <image
            class={`march-marker-art march-marker-art--${t}`}
            href={artPath('map_marker_own')}
            x={-16}
            y={-30}
            width={32}
            height={42}
            preserveAspectRatio="xMidYMid meet"
          />
        </g>,
      );
    });
    return markers;
  }

  // ─── foreign march markers（视野内其他玩家的脱敏军队，增量推送驱动）──────────
  function buildForeignMarkers() {
    const armies: ForeignArmy[] = foreignMoves.value?.movements ?? [];
    const markers: preact.VNode[] = [];
    const ref = viewRef();
    armies.forEach((m) => {
      if (!m.pos || !m.id) return;
      const p = cameraPixelForHex(m.pos.q, m.pos.r, ox.current, oy.current, ref.x, ref.y, W, H);
      const t = m.type ?? 'return';

      // 朝向箭头：heading 指向下一格，计算像素方向后绘制小三角
      let arrowEl: preact.VNode | null = null;
      if (m.heading && m.status === 'marching') {
        const dir = hexToPixel(m.heading);
        const len = Math.hypot(dir.x, dir.y);
        if (len > 0.01) {
          const ux = dir.x / len, uy = dir.y / len;
          const px = -uy, py = ux;
          const tip = { x: ux * 15, y: uy * 15 };
          const b1  = { x: px * 3.5, y: py * 3.5 };
          const b2  = { x: -px * 3.5, y: -py * 3.5 };
          arrowEl = (
            <polygon
              class="foreign-march-arrow"
              points={`${tip.x.toFixed(1)},${tip.y.toFixed(1)} ${b1.x.toFixed(1)},${b1.y.toFixed(1)} ${b2.x.toFixed(1)},${b2.y.toFixed(1)}`}
            />
          );
        }
      }

      markers.push(
        <g
          key={`fmk-${m.id}`}
          id={`foreign-mk-${m.id}`}
          data-move-id={m.id}
          class={`enemy-march-mk enemy-march-mk--${t}`}
          transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}
        >
          <title>敌方军队 · {m.type ?? 'return'}</title>
          <image
            class={`enemy-march-art enemy-march-art--${t}`}
            href={artPath('map_marker_enemy')}
            x={-16}
            y={-30}
            width={32}
            height={42}
            preserveAspectRatio="xMidYMid meet"
          />
          {arrowEl}
        </g>,
      );
    });
    return markers;
  }

  // ─── task camp markers（任务营地：真实 pve 地块 + 🎯 高亮）──────────────
  function buildTaskMarkers() {
    const camps: any[] = (taskMarkers.value[me?.villageId ?? ''] ?? []).filter((camp: any) => !camp?.cleared);
    const markers: preact.VNode[] = [];
    const ref = viewRef();
    camps.forEach((c) => {
      const t = tileAt(c.q, c.r);
      const visibility = (t?.visibility ?? 'visible') as string;
      if (visibility === 'unexplored') return;
      const p = cameraPixelForHex(c.q, c.r, ox.current, oy.current, ref.x, ref.y, W, H);
      markers.push(
        <g
          key={`taskcamp-${c.id ?? `${c.q},${c.r}`}`}
          class="task-camp-marker"
          transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}
        >
          <polygon class="hex-ring hex-ring--task" points={HEX_CORNER_STR} />
          <text class="task-camp-emoji" textAnchor="middle" dy={HEX_SIZE * 0.32}>🎯</text>
        </g>,
      );
    });
    return markers;
  }

  // ─── rAF march animation ───────────────────────────────────────────────────
  function setMarkerTransform(el: SVGGElement, x: number, y: number) {
    const key = `${x.toFixed(1)},${y.toFixed(1)}`;
    if (el.dataset.pos === key) return;
    el.dataset.pos = key;
    el.setAttribute('transform', `translate(${key})`);
  }

  function updateHoverTip(clientX: number, clientY: number) {
    const hit = document.elementFromPoint(clientX, clientY);
    const cell = hit?.closest?.('.hex-cell') as Element | null;
    if (!cell) { setTooltip(null); hovKey.current = ''; return; }

    const q = Number(cell.getAttribute('data-tq'));
    const r = Number(cell.getAttribute('data-tr'));
    const camX = Number(cell.getAttribute('data-cam-x'));
    const camY = Number(cell.getAttribute('data-cam-y'));
    const anchor = cameraToScreen(camX, camY);

    // 同格有他国军队时，优先展示军队信息（底层格可能是 empty）
    const army = foreignArmyAt(q, r);
    if (army?.pos) {
      const name = foreignArmyName(army);
      const key = `enemy:${army.id ?? `${q},${r}`}`;
      const dist = me ? hexDistanceWrapped({ q: me.q, r: me.r }, army.pos, W, H) : 0;
      if (key !== hovKey.current) {
        hovKey.current = key;
        setTooltip({ q, r, kind: 'enemy_army', name, dist, anchorX: anchor.x, anchorY: anchor.y });
      } else {
        setTooltip((t) => t ? { ...t, anchorX: anchor.x, anchorY: anchor.y } : t);
      }
      return;
    }

    const kind = cell.getAttribute('data-kind') ?? 'empty';
    const name = cell.getAttribute('data-name') ?? '空地';
    const key = `${kind}:${q},${r}`;
    const dist = me ? hexDistanceWrapped({ q: me.q, r: me.r }, { q, r }, W, H) : 0;
    if (key === hovKey.current) {
      setTooltip((t) => t ? { ...t, anchorX: anchor.x, anchorY: anchor.y } : t);
      return;
    }
    hovKey.current = key;
    setTooltip({ q, r, kind, name, dist, anchorX: anchor.x, anchorY: anchor.y });
  }

  function marchMarkerPixel(m: any, now: number, refX: number, refY: number): { x: number; y: number } | null {
    if (!m.path || m.stepIndex == null) return null;
    const cur = m.path[m.stepIndex];
    if (!cur) return null;
    const unwrapped = unwrapPathPixels(m.path, ox.current, oy.current, refX, refY, W, H);
    let px = unwrapped[m.stepIndex];
    if (!px) return null;
    if (m.status === 'marching' && m.stepIndex < m.path.length - 1 && m.nextStepAt && m.perStepMs) {
      const t = Math.max(0, Math.min(1, 1 - (m.nextStepAt - now) / m.perStepMs));
      const nxt = unwrapped[m.stepIndex + 1];
      if (nxt) {
        px = { x: px.x + (nxt.x - px.x) * t, y: px.y + (nxt.y - px.y) * t };
      }
    }
    return px;
  }

  /** 外国军队位置插值：pos → pos+heading 单段（无完整 path）。 */
  function foreignMarkerPixel(m: ForeignArmy, now: number, refX: number, refY: number): { x: number; y: number } | null {
    if (!m.pos) return null;
    const p = cameraPixelForHex(m.pos.q, m.pos.r, ox.current, oy.current, refX, refY, W, H);
    if (m.status === 'marching' && m.heading && m.nextStepAt && m.perStepMs) {
      const t = Math.max(0, Math.min(1, 1 - (m.nextStepAt - now) / m.perStepMs));
      const nextHex = { q: m.pos.q + m.heading.q, r: m.pos.r + m.heading.r };
      const np = cameraPixelForHex(nextHex.q, nextHex.r, ox.current, oy.current, refX, refY, W, H);
      return { x: p.x + (np.x - p.x) * t, y: p.y + (np.y - p.y) * t };
    }
    return p;
  }

  function startMarchAnimation() {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const frame = () => {
      if (!markerEl.current) return;
      const ref = viewRef();
      const moves: any[] = getCache().playerMoves?.movements ?? getCache().moves?.movements ?? [];
      const now = Date.now();
      moves.forEach((m, i) => {
        const el = markerEl.current?.querySelector(`#march-mk-${i}`) as SVGGElement | null;
        const px = marchMarkerPixel(m, now, ref.x, ref.y);
        if (!el || !px) return;
        setMarkerTransform(el, px.x, px.y);
      });
      // 外国军队：pos+heading 单段插值（无 path），读数来自 foreignMoves 信号。
      const foeArmies: ForeignArmy[] = foreignMoves.value?.movements ?? [];
      foeArmies.forEach((m) => {
        if (!m.id) return;
        const el = foreignEl.current?.querySelector(`#foreign-mk-${m.id}`) as SVGGElement | null;
        const px = foreignMarkerPixel(m, now, ref.x, ref.y);
        if (!el || !px) return;
        setMarkerTransform(el, px.x, px.y);
      });
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
  }

  function handleMapTap(clientX: number, clientY: number) {
    const hit = document.elementFromPoint(clientX, clientY);
    const ownMarker = hit?.closest?.('[data-own-move-id]') as Element | null;
    if (ownMarker) {
      const movementId = ownMarker.getAttribute('data-own-move-id');
      const listed = movementId
        ? (getCache().playerMoves?.movements ?? []).find((m: any) => m.id === movementId)
        : undefined;
      if (listed?.pos) {
        selected.value = { refId: listed.id, kind: 'own_army', q: listed.pos.q, r: listed.pos.r, name: '己方军队' };
        return;
      }
    }
    let cell = hit?.closest?.('.hex-cell') as Element | null;
    if (!cell) {
      // 可能点在外军标记层之上：暂时隐藏后回落到底层格
      const foreignLayer = foreignEl.current;
      if (foreignLayer) {
        foreignLayer.style.pointerEvents = 'none';
        foreignLayer.style.visibility = 'hidden';
        cell = document.elementFromPoint(clientX, clientY)?.closest?.('.hex-cell') as Element | null;
        foreignLayer.style.pointerEvents = '';
        foreignLayer.style.visibility = '';
      }
    }
    if (!cell) return;
    const q = Number(cell.getAttribute('data-tq'));
    const r = Number(cell.getAttribute('data-tr'));
    const kind = cell.getAttribute('data-kind') ?? 'empty';
    const refId = cell.getAttribute('data-ref') ?? `empty-${q},${r}`;
    const name = cell.getAttribute('data-name') ?? '空地';
    const icon = cell.getAttribute('data-icon') ?? undefined;
    const visibility = cell.getAttribute('data-visibility') as 'unexplored' | 'explored' | 'visible' | null;
    const taskCamp = findTaskCampMarker(refId, q, r);
    selected.value = {
      refId, kind, q, r, name,
      ...(icon ? { icon } : {}),
      ...(visibility ? { visibility } : {}),
      ...(taskCamp?.taskInfo ? { taskInfo: taskCamp.taskInfo } : {}),
    };
  }

  // ─── event handlers ────────────────────────────────────────────────────────
  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    dragging.current = true;
    dragMoved.current = false;
    dragSX.current = e.clientX; dragSY.current = e.clientY;
    dragPX.current = panX.current; dragPY.current = panY.current;
    svgEl.current?.classList.add('grabbing');
    setTooltip(null);
  }

  function onMouseMove(e: MouseEvent) {
    if (dragging.current) {
      const dx = e.clientX - dragSX.current, dy = e.clientY - dragSY.current;
      if (!dragMoved.current && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      dragMoved.current = true;
      panX.current = dragPX.current + dx;
      panY.current = dragPY.current + dy;
      reducePanToLattice();
      applyTransform();
      scheduleCull();
      return;
    }
    updateHoverTip(e.clientX, e.clientY);
  }

  function onMouseUp(e: MouseEvent) {
    if (!dragging.current) return;
    dragging.current = false;
    svgEl.current?.classList.remove('grabbing');
    const moved = Math.hypot(e.clientX - dragSX.current, e.clientY - dragSY.current) > DRAG_THRESHOLD;
    if (moved) {
      suppress.current = true;
      scheduleCull();
      syncNavUI();
    }
    dragMoved.current = false;
    if (!moved) updateHoverTip(e.clientX, e.clientY);
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = svgEl.current!.getBoundingClientRect();
    adjustZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
  }

  function onDblClick(e: MouseEvent) {
    if ((e.target as Element)?.closest?.('.hex-cell')) return;
    resetView();
    syncNavUI();
  }

  function onTouchStart(e: TouchEvent) {
    if (e.touches.length === 2) {
      const t = e.touches;
      pinchDist.current = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      pinchZoom.current = zoom.current;
      const mx = (t[0].clientX + t[1].clientX) / 2;
      const my = (t[0].clientY + t[1].clientY) / 2;
      pinchMidX.current = mx; pinchMidY.current = my;
      pinchPX.current = panX.current; pinchPY.current = panY.current;
    } else if (e.touches.length === 1) {
      dragging.current = true;
      dragMoved.current = false;
      const t = e.touches[0];
      dragSX.current = t.clientX; dragSY.current = t.clientY;
      dragPX.current = panX.current; dragPY.current = panY.current;
    }
  }

  function onTouchMove(e: TouchEvent) {
    if (e.touches.length === 2 && pinchDist.current > 0) {
      e.preventDefault();
      const t = e.touches;
      const dist = Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
      const scale = dist / pinchDist.current;
      const rect = svgEl.current!.getBoundingClientRect();
      const mx = (t[0].clientX + t[1].clientX) / 2;
      const my = (t[0].clientY + t[1].clientY) / 2;
      zoom.current = clampZoom(pinchZoom.current * scale);
      const sx = mx - rect.left, sy = my - rect.top;
      const fw = (sx - pinchPX.current) / pinchZoom.current;
      const fh = (sy - pinchPY.current) / pinchZoom.current;
      panX.current = sx - zoom.current * fw + (mx - pinchMidX.current);
      panY.current = sy - zoom.current * fh + (my - pinchMidY.current);
      reducePanToLattice();
      applyTransform();
      scheduleCull();
    } else if (e.touches.length === 1 && dragging.current) {
      const t = e.touches[0];
      const dx = t.clientX - dragSX.current, dy = t.clientY - dragSY.current;
      if (!dragMoved.current && Math.hypot(dx, dy) <= DRAG_THRESHOLD) return;
      dragMoved.current = true;
      panX.current = dragPX.current + dx;
      panY.current = dragPY.current + dy;
      reducePanToLattice();
      applyTransform();
      scheduleCull();
    }
  }

  function onTouchEnd(e: TouchEvent) {
    if (e.touches.length < 2) {
      if (pinchDist.current > 0) syncZoomUi();
      pinchDist.current = 0;
      syncNavUI();
    }
    if (e.touches.length === 0) {
      const wasDrag = dragMoved.current;
      if (wasDrag) suppress.current = true;
      dragging.current = false;
      if (!wasDrag && e.changedTouches[0]) {
        suppress.current = true;
        const t = e.changedTouches[0];
        handleMapTap(t.clientX, t.clientY);
      }
      dragMoved.current = false;
    }
  }

  function onSvgClick(e: MouseEvent) {
    if (suppress.current) { suppress.current = false; return; }
    handleMapTap(e.clientX, e.clientY);
  }

  function doHome() {
    // 地图视角跟随当前操作村，而不是固定跳回主城。
    const current = currentVillageCoordinate(me) ?? capitalCoordinate(me);
    if (!current) return;
    setMapCenter(current);
    centerViewOn(current.q, current.r);
    syncNavUI();
  }
  function doJump() {
    const parsed = parseMapCoordinate(jumpQ, jumpR, W, H);
    if (!parsed.ok) {
      setJumpError(parsed.error);
      return;
    }
    setJumpError('');
    jumpEditing.current = false;
    setMapCenter(parsed.coordinate);
    centerViewOn(parsed.coordinate.q, parsed.coordinate.r);
    syncNavUI();
    setJumpQ(String(parsed.coordinate.q));
    setJumpR(String(parsed.coordinate.r));
  }

  // ─── initial center & resize ───────────────────────────────────────────────
  useEffect(() => {
    if (!svgEl.current) return;
    const svg = svgEl.current;

    // Measure container
    const rect = svg.getBoundingClientRect();
    cw.current = rect.width || 1000;
    ch.current = rect.height || 700;
    svg.setAttribute('viewBox', `0 0 ${cw.current} ${ch.current}`);

    // Initial center — 每次打开地图默认居中主城
    if (centeredKey.current === '') {
      const c = { q: me?.q ?? 0, r: me?.r ?? 0 };
      zoom.current = clampZoom(INITIAL_ZOOM);
      const p = hexToPixel(c);
      const wx = p.x + ox.current, wy = p.y + oy.current;
      panX.current = cw.current / 2 - zoom.current * wx;
      panY.current = ch.current / 2 - zoom.current * wy;
      reducePanToLattice();
      applyTransform();
      centeredKey.current = `${c.q},${c.r}`;
      syncNavUI();
      syncZoomUi();
    } else {
      applyTransform();
    }
    scheduleCull();

    // Resize observer
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      cw.current = r.width;
      ch.current = r.height;
      svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
      reducePanToLattice();
      applyTransform();
      scheduleCull();
    });
    ro.observe(svg);

    // Scroll event (wheel needs passive:false on the svg)
    svg.addEventListener('wheel', onWheel, { passive: false });

    // Start march animation
    startMarchAnimation();

    // 首次加载：全量拉取外国军队
    void refreshForeignMoves();

    // 30s 兜底刷新（增量推送可能漏推）
    const fallbackTimer = window.setInterval(() => {
      if (tab.value === 'map') void refreshForeignMoves();
    }, 30_000);

    // 切换回地图标签时补一次全量拉取
    const unsubTab = tab.subscribe((t) => {
      if (t === 'map') void refreshForeignMoves();
    });

    return () => {
      ro.disconnect();
      svg.removeEventListener('wheel', onWheel);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      window.clearInterval(fallbackTimer);
      unsubTab();
    };
  }, []); // intentional: one-time mount effect, only refs are used inside

  // Re-trigger march animation when data changes
  useEffect(() => {
    startMarchAnimation();
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [_dv]); // intentional: _dv is the data dependency

  useEffect(() => {
    if (jumpEditing.current) return;
    setJumpQ(String(navCoord.q));
    setJumpR(String(navCoord.r));
  }, [navCoord.q, navCoord.r]);

  // ─── render ────────────────────────────────────────────────────────────────
  const visibleCells = buildVisibleHexes();
  const terrainLayers = buildTerrainLayers(visibleCells);
  const marchPaths   = buildMarchPaths();
  const marchMarkers = buildMarchMarkers();
  const foreignMarkers = buildForeignMarkers();
  const taskMarkersEls = buildTaskMarkers();

  return (
    <>
      {/* SVG map canvas */}
      <svg
        ref={svgEl}
        class="map-svg"
        viewBox={`0 0 ${cw.current} ${ch.current}`}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={(e) => {
          if (dragging.current) onMouseUp(e);
          setTooltip(null);
          hovKey.current = '';
        }}
        onDblClick={onDblClick}
        onClick={onSvgClick}
        onTouchStart={onTouchStart as any}
        onTouchMove={onTouchMove as any}
        onTouchEnd={onTouchEnd as any}
      >
        <defs>
          <pattern id="plain-contours" width="180" height="140" patternUnits="userSpaceOnUse">
            <path class="terrain-plain-contour" d="M-24 36 C18 10 52 12 94 34 S166 62 206 28" />
            <path class="terrain-plain-contour terrain-plain-contour--soft" d="M-18 104 C30 78 74 84 112 106 S174 128 204 98" />
          </pattern>
        </defs>

        <rect class="map-bg" x="0" y="0" width="100%" height="100%" />

        <g ref={camEl} class="layer-camera">
          {/* ── 连续地貌：同类地块聚合为 path，装饰由世界坐标稳定生成 ── */}
          <g class="layer-terrain" aria-hidden="true">
            {Array.from(terrainLayers.surfaces.entries()).map(([key, paths]) => {
              const [terrain, visibility] = key.split('-') as [Terrain, Visibility];
              return <path key={key} class={`terrain-surface terrain-surface--${terrain} terrain-surface--${visibility}`} d={paths.join('')} />;
            })}
            {Array.from(terrainLayers.plainTexture.entries()).map(([visibility, paths]) => (
              <path key={`plain-${visibility}`} class={`terrain-plain-texture terrain-detail--${visibility}`} d={paths.join('')} />
            ))}
            {Array.from(terrainLayers.forestCanopy.entries()).map(([visibility, paths]) => (
              <path key={`forest-${visibility}`} class={`terrain-forest-canopy terrain-detail--${visibility}`} d={paths.join('')} />
            ))}
            {Array.from(terrainLayers.hillRidges.entries()).map(([visibility, paths]) => (
              <path key={`hills-${visibility}`} class={`terrain-hill-ridge terrain-detail--${visibility}`} d={paths.join('')} />
            ))}
          </g>

          {/* ── POI 与地貌解耦，不再改写底层 terrain ── */}
          <g class="layer-pois">
            {visibleCells.map((c) => {
              const rk = ringKind(c.kind, c.isSelf);
              if (c.visibility === 'unexplored' || (c.kind === 'empty' && !c.isSelected)) return null;
              return (
                <g
                  key={`poi-${c.q},${c.r},${c.camX.toFixed(0)},${c.camY.toFixed(0)}`}
                  class={`hex-poi hex-cell--${c.visibility}${c.isSelf ? ' hex-cell--self' : ''}${c.kind !== 'empty' ? ' hex-cell--occupied' : ''}`}
                  transform={`translate(${c.camX.toFixed(1)},${c.camY.toFixed(1)})`}
                >
                  {/* Entity ring */}
                  {rk && <polygon class={`hex-ring hex-ring--${rk}`} points={HEX_CORNER_STR} />}
                  {/* 实体图标（村庄/野怪）：占满六边形内切圆，缩略图下也认得出是什么 */}
                  {c.icon && (
                    <image
                      class="hex-entity-img"
                      href={artPath(c.icon)}
                      x={-HEX_SIZE * 0.62}
                      y={-HEX_SIZE * 0.66}
                      width={HEX_SIZE * 1.24}
                      height={HEX_SIZE * 1.24}
                      preserveAspectRatio="xMidYMid meet"
                    />
                  )}
                  {/* 名称必须留在所属六边形内；放到格外会被后绘制的相邻地形遮住。 */}
                  {c.kind !== 'empty' && (
                    <text class="hex-label" textAnchor="middle" dominantBaseline="middle" y={HEX_SIZE * 0.62}>
                      {c.name.slice(0, 5)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>

          {/* 服务器权威迷雾只覆盖未探索格；已探索地形保持可辨识，快照 POI 仍单独降级。 */}
          <g class="layer-fog" aria-hidden="true">
            {terrainLayers.fog.get('unexplored') && <path class="terrain-fog terrain-fog--unexplored" d={terrainLayers.fog.get('unexplored')!.join('')} />}
          </g>

          {/* 独立透明命中层：默认不画格线，只在 hover / 选中时显出六边边界。 */}
          <g class="layer-hexes">
            {visibleCells.map((c) => (
              <g
                key={`hit-${c.q},${c.r},${c.camX.toFixed(0)},${c.camY.toFixed(0)}`}
                class={`hex-cell hex-cell--${c.visibility}${c.isSelected ? ' hex-cell--selected' : ''}`}
                transform={`translate(${c.camX.toFixed(1)},${c.camY.toFixed(1)})`}
                {...({ 'data-tq': String(c.q), 'data-tr': String(c.r), 'data-cam-x': String(c.camX), 'data-cam-y': String(c.camY), 'data-kind': c.kind, 'data-ref': c.refId, 'data-name': c.name, 'data-visibility': c.visibility, ...(c.icon ? { 'data-icon': c.icon } : {}) } as any)}
              >
                <polygon class="hex-hit" points={HEX_CORNER_STR} />
                {c.isSelected && <polygon class="hex-sel-ring" points={HEX_CORNER_STR} />}
              </g>
            ))}
          </g>

          {/* ── March paths ── */}
          <g class="layer-paths">{marchPaths}</g>

          {/* ── March markers (animated via rAF) ── */}
          <g ref={markerEl} class="layer-markers">{marchMarkers}</g>

          {/* ── Foreign army markers (other players' desensitized armies, animated via rAF) ── */}
          <g ref={foreignEl} class="layer-foreign-markers">{foreignMarkers}</g>

          {/* ── Task camp markers (static) ── */}
          <g class="layer-taskmarkers">{taskMarkersEls}</g>
        </g>
      </svg>

      {/* ── Floating overlays ── */}
      <div class="map-overlay">
        {/* Top info bar */}
        <InfoBar
          navCoord={navCoord}
          homeCentered={homeCentered}
          onGoHome={doHome}
        />

        {/* 坐标跳转 */}
        <div class="map-nav">
          <form class="map-locator" noValidate onSubmit={(e) => { e.preventDefault(); doJump(); }}>
            <span class="map-locator-title">坐标跳转</span>
            <div class="map-locator-row">
              <label class="map-coordinate-field">
                <span>X</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={W - 1}
                  step={1}
                  value={jumpQ}
                  onFocus={() => { jumpEditing.current = true; }}
                  onBlur={() => { jumpEditing.current = false; }}
                  onInput={(e) => { jumpEditing.current = true; setJumpQ(e.currentTarget.value); setJumpError(''); }}
                  aria-label="地图 X 坐标"
                />
              </label>
              <label class="map-coordinate-field">
                <span>Y</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={H - 1}
                  step={1}
                  value={jumpR}
                  onFocus={() => { jumpEditing.current = true; }}
                  onBlur={() => { jumpEditing.current = false; }}
                  onInput={(e) => { jumpEditing.current = true; setJumpR(e.currentTarget.value); setJumpError(''); }}
                  aria-label="地图 Y 坐标"
                />
              </label>
              <Btn type="submit" size="sm" variant="primary" class="map-locator-jump">跳转</Btn>
              <Btn size="sm" class="map-locator-home" onClick={doHome} title="将地图回正并居中到当前操作村">
                <span aria-hidden="true">◎</span> 回正并回当前村
              </Btn>
            </div>
            {jumpError
              ? <span class="map-locator-error" role="alert">{jumpError}</span>
              : <span class="map-locator-hint">输入 X 0–{W - 1}、Y 0–{H - 1} 后点跳转</span>}
          </form>
          <div class="map-zoom" aria-label="地图缩放">
            <button
              type="button"
              class="map-zoom-btn"
              title="缩小"
              disabled={zoomUi <= ZOOM_MIN + 0.001}
              onClick={() => adjustZoom(1 / 1.15)}
            >−</button>
            <span class="map-zoom-label">{Math.round(zoomUi * 100)}%</span>
            <button
              type="button"
              class="map-zoom-btn"
              title="放大"
              disabled={zoomUi >= ZOOM_MAX - 0.001}
              onClick={() => adjustZoom(1.15)}
            >+</button>
          </div>
        </div>

        {/* Legend */}
        <div class="map-legend">
          <div class="map-legend-row"><span class="map-legend-dot map-legend-dot--self" />本城</div>
          <div class="map-legend-row"><span class="map-legend-dot map-legend-dot--own" />己方村庄</div>
          <div class="map-legend-row"><span class="map-legend-dot map-legend-dot--enemy" />玩家(可进攻)</div>
          <div class="map-legend-row"><span class="map-legend-dot map-legend-dot--pve" />野怪(可掠夺)</div>
          <div class="map-legend-row"><span class="map-legend-line map-legend-line--attack" />进攻 / 来袭</div>
          <div class="map-legend-row"><span class="map-legend-line map-legend-line--raid" />掠夺</div>
          <div class="map-legend-row"><span class="map-legend-line map-legend-line--return" />返程</div>
          <div class="map-legend-row"><span class="map-legend-line map-legend-line--transport" />运输</div>
          <div class="map-legend-row"><span class="map-legend-dot map-legend-dot--enemy" style="opacity:.7" />敌方军队</div>
          <div class="map-legend-row"><span>🎯</span>任务营地</div>
        </div>
      </div>

      {/* Hover tooltip */}
      {tooltip && (
        <HexTooltip tip={tooltip} />
      )}
    </>
  );
}

// ─── sub-components ────────────────────────────────────────────────────────

function InfoBar({ navCoord, homeCentered, onGoHome }: {
  navCoord: { q: number; r: number };
  homeCentered: boolean;
  onGoHome: () => void;
}) {
  const current = currentVillageCoordinate(me) ?? capitalCoordinate(me);
  if (!current) return null;
  const atHome = homeCentered || (navCoord.q === current.q && navCoord.r === current.r);
  return (
    <div class="map-infobar">
      {!homeCentered && !atHome ? (
        <>全图模式 · 视角偏离当前村 · <a onClick={onGoHome}>回正并回当前村</a></>
      ) : homeCentered && (navCoord.q === current.q && navCoord.r === current.r) ? (
        <>全图模式 · 当前村 <b>X={current.q} Y={current.r}</b>（已居中）</>
      ) : (
        <>全图模式 · 查看 <b>X={navCoord.q} Y={navCoord.r}</b> · <a onClick={onGoHome}>回正并回当前村</a></>
      )}
    </div>
  );
}

function tileKindLabel(kind: string, isSelf: boolean, emptyName = '空地'): string {
  if (kind === 'own_village') return isSelf ? '本城（己方）' : '己方村庄';
  if (kind === 'village') return '玩家村庄（可进攻）';
  if (kind === 'pve') return '野怪据点（可掠夺）';
  if (kind === 'enemy_army') return '敌方军队';
  return `${emptyName}（可拓荒）`;
}

function HexTooltip({ tip }: {
  tip: { q: number; r: number; kind: string; name: string; dist: number; anchorX: number; anchorY: number };
}) {
  const isSelf = !!(me && me.q === tip.q && me.r === tip.r);
  const label = tileKindLabel(tip.kind, isSelf, tip.name);

  const left = Math.min(Math.max(130, tip.anchorX), window.innerWidth - 130);
  const top = Math.min(Math.max(8, tip.anchorY - TIP_ABOVE), window.innerHeight - 120);

  const style = {
    left: `${left}px`,
    top: `${top}px`,
    transform: 'translateX(-50%)',
  };

  return (
    <div class="map-tooltip" style={style}>
      <div class="map-tooltip-kind">{label}</div>
      <div class="map-tooltip-row">
        <span>坐标</span><b>X={tip.q} · Y={tip.r}</b>
      </div>
      {tip.kind !== 'empty' && (
        <div class="map-tooltip-row">
          <span>名称</span><b>{tip.name}</b>
        </div>
      )}
      <div class="map-tooltip-row">
        <span>距离</span><b>{tip.dist} 格</b>
      </div>
      {tip.kind === 'empty' && (
        <div class="map-tooltip-hint">点击可拓荒建村</div>
      )}
      {tip.kind === 'enemy_army' && (
        <div class="map-tooltip-hint">点击查看脱敏军情</div>
      )}
    </div>
  );
}

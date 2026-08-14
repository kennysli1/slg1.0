/**
 * HexMap — SVG 六边形地图渲染器。
 * 职责：相机（平移/缩放/复位）、视口剔除、地形纹理、行军路径动画、悬停提示、点击选格。
 * 状态规则：相机值存 useRef（避免拖拽重渲），只在需要重算剔除时 bump cullVer 触发渲染。
 */
import * as preact from 'preact';
import { useEffect, useRef, useState, useCallback } from 'preact/hooks';
import { hexToPixel, hexCorners, lerpPixel, HEX_SIZE, type Hex } from '../../shared/utils/hex.js';
import { worldW, worldH, pveInfoByType } from '../../app/config.js';
import { getCache } from '../../app/state.js';
import { dataVersion, selected, tick, taskMarkers } from '../../app/store.js';
import { getMapCenter, setMapCenter } from '../../app/refresh.js';
import { me, ownVillageAt } from '../../api.js';
import { artPath, Btn } from '../../ui/index.js';
import { capitalCoordinate, parseMapCoordinate } from './map-navigation.js';

// ─── constants ───────────────────────────────────────────────────────────────
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 2.2;
const INITIAL_ZOOM = 1.6;
const PAD = HEX_SIZE * 1.4;
const STEP = 4; // D-pad 每次移动格数

/** pointy-top 六边形六个顶点字符串（模块级常量，避免每帧重建） */
const HEX_CORNER_STR = hexCorners()
  .map((c) => `${c.x.toFixed(2)},${c.y.toFixed(2)}`)
  .join(' ');

const SCREEN_DIRS: Record<string, { dq: number; dr: number }> = {
  up: { dq: 0, dr: -1 }, down: { dq: 0, dr: 1 },
  left: { dq: -1, dr: 0 }, right: { dq: 1, dr: 0 },
};

// ─── terrain helpers ─────────────────────────────────────────────────────────

/** 按坐标做确定性哈希，返回 0-3 号地形变体（空地格区分草地纹理）。 */
function terrainVariant(q: number, r: number): number {
  return ((Math.imul(q * 73856093 ^ r * 19349663, 0x45d9f3b)) >>> 0) % 4;
}

/**
 * 按坐标确定性生成地形类型（有聚类效果：大块森林/水域/丘陵，而非均匀噪声）。
 * PvE / 村庄格由服务端数据决定，此函数只用于空地格的美术背景。
 */
function terrainFor(q: number, r: number): string {
  // 粗粒度生物群系（每 5 格一块）
  const bq = ((q >> 2) + 128) & 0xff;
  const br = ((r >> 2) + 128) & 0xff;
  const biome = ((Math.imul(bq * 73856093 ^ br * 83492791, 0x45d9f3b)) >>> 0) % 100;
  // 细粒度变体
  const fine = ((Math.imul(q * 17364091 ^ r * 83492791, 0x9c4f6b3)) >>> 0) % 100;

  if (biome < 9)  return 'water';
  if (biome < 18) return 'hills';
  if (biome < 32) return fine < 65 ? 'forest' : 'grass3';
  if (biome < 42) return fine < 45 ? 'ruins'  : 'grass2';
  // 大多数是草地
  return fine < 58 ? 'grass2' : 'grass3';
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

  // ── Tooltip ──
  type TipState = { q: number; r: number; kind: string; name: string; dist: number; x: number; y: number } | null;
  const [tooltip, setTooltip] = useState<TipState>(null);
  const hovKey = useRef('');

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
  function applyTransform() {
    camEl.current?.setAttribute(
      'transform',
      `translate(${panX.current.toFixed(2)},${panY.current.toFixed(2)}) scale(${zoom.current.toFixed(4)})`,
    );
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
    const capital = capitalCoordinate(me);
    if (!capital || zoom.current <= 0 || cw.current <= 0) return true;
    const hp = hexToPixel(capital);
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
    zoom.current = 1;
    centerViewOn(viewCenter().q, viewCenter().r);
    syncNavUI();
  }

  // ─── viewport culling ──────────────────────────────────────────────────────
  interface HexCell {
    q: number; r: number;
    camX: number; camY: number;
    kind: string;
    refId: string;
    name: string;
    icon: string | null;
    terrain: string;
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
            // 任务营地（taskMarkers 提供，不在 area.tiles 里）：当作可掠夺的 pve 目标
            const taskCamp = (taskMarkers.value[me?.villageId ?? ''] ?? []).find((c: any) => c.q === q && c.r === r && !c.cleared);
            let kind = 'empty', refId = `empty-${q},${r}`, name = '空地', icon: string | null = null;
            let terrain = terrainFor(q, r);

            if (isSelf) {
              kind = 'own_village'; refId = me!.id; name = me!.name;
              icon = 'bld_main'; terrain = 'village';
            } else if (ownV) {
              kind = 'own_village'; refId = ownV.id; name = ownV.name;
              icon = 'bld_main'; terrain = 'village';
            } else if (taskCamp) {
              kind = 'pve'; refId = taskCamp.id; name = '任务营地';
              icon = pveIcon('任务营地'); terrain = 'ruins';
            } else if (t?.kind === 'village') {
              kind = 'village'; refId = t.refId; name = t.name;
              icon = 'bld_main'; terrain = 'village';
            } else if (t?.kind === 'pve') {
              kind = 'pve'; refId = t.refId; name = t.name;
              icon = t.icon ?? pveIcon(t.name); terrain = 'ruins';
            } else if (t?.kind === 'empty') {
              // server says empty with variant
              const v = terrainVariant(q, r);
              terrain = v < 2 ? 'grass2' : v === 2 ? 'grass3' : 'forest';
            }

            cells.push({
              q, r, camX, camY, kind, refId, name, icon, terrain,
              isSelf,
              isSelected: !!(sel && sel.q === q && sel.r === r),
            });
          }
        }
      }
    }
    return cells;
  }

  // ─── march path + marker rendering ────────────────────────────────────────
  function buildMarchPaths() {
    const moves: any[] = getCache().moves?.movements ?? [];
    const paths: preact.VNode[] = [];
    moves.forEach((m, i) => {
      if (!m.path || m.path.length < 2) return;
      const pts = m.path
        .map((h: Hex) => { const p = hexToPixel(h); return `${(p.x + ox.current).toFixed(1)},${(p.y + oy.current).toFixed(1)}`; })
        .join(' ');
      const t = m.type === 'return' ? 'return'
        : m.type === 'transport' ? 'transport'
        : m.type === 'found'     ? 'found'
        : m.type === 'caravan'   ? 'caravan'
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
    const moves: any[] = getCache().moves?.movements ?? [];
    const markers: preact.VNode[] = [];
    moves.forEach((m, i) => {
      if (!m.pos) return;
      const p = hexToPixel(m.pos);
      const emoji = m.type === 'attack' ? '⚔'
        : m.type === 'raid'      ? '⚡'
        : m.type === 'found'     ? '🚩'
        : m.type === 'transport' ? '📦'
        : m.type === 'caravan'   ? '💰'
        : '🏠';
      const t = m.type ?? 'return';
      markers.push(
        <g
          key={`mk-${i}`}
          id={`march-mk-${i}`}
          transform={`translate(${(p.x + ox.current).toFixed(1)},${(p.y + oy.current).toFixed(1)})`}
        >
          <circle r={10} class={`march-dot march-dot--${t}${m.status === 'paused' ? ' paused' : ''}`} />
          <text class="march-emoji" textAnchor="middle" dy={4}>{emoji}</text>
        </g>,
      );
    });
    return markers;
  }

  // ─── task camp markers（任务营地：真实 pve 地块 + 🎯 高亮）──────────────
  function buildTaskMarkers() {
    // store 已过滤，但渲染层再守一次：地图上绝不画已清理的任务营地。
    const camps: any[] = (taskMarkers.value[me?.villageId ?? ''] ?? []).filter((camp: any) => !camp?.cleared);
    const markers: preact.VNode[] = [];
    camps.forEach((c, i) => {
      const p = hexToPixel({ q: c.q, r: c.r });
      markers.push(
        <g
          key={`taskcamp-${i}`}
          class="task-camp-marker"
          transform={`translate(${(p.x + ox.current).toFixed(1)},${(p.y + oy.current).toFixed(1)})`}
        >
          <polygon class="hex-ring hex-ring--task" points={HEX_CORNER_STR} />
          <text class="task-camp-emoji" textAnchor="middle" dy={HEX_SIZE * 0.32}>🎯</text>
        </g>,
      );
    });
    return markers;
  }

  // ─── rAF march animation ───────────────────────────────────────────────────
  function startMarchAnimation() {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    const frame = () => {
      if (!markerEl.current) return;
      const moves: any[] = getCache().moves?.movements ?? [];
      const now = Date.now();
      moves.forEach((m, i) => {
        const el = markerEl.current?.querySelector(`#march-mk-${i}`) as SVGGElement | null;
        if (!el || !m.path || m.stepIndex == null) return;
        const cur = m.path[m.stepIndex];
        if (!cur) return;
        let px = hexToPixel(cur);
        if (m.status === 'marching' && m.stepIndex < m.path.length - 1 && m.nextStepAt && m.perStepMs) {
          const t = Math.max(0, Math.min(1, 1 - (m.nextStepAt - now) / m.perStepMs));
          px = lerpPixel(hexToPixel(cur), hexToPixel(m.path[m.stepIndex + 1]), t);
        }
        el.setAttribute('transform', `translate(${(px.x + ox.current).toFixed(1)},${(px.y + oy.current).toFixed(1)})`);
      });
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
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
      if (!dragMoved.current && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
      dragMoved.current = true;
      panX.current = dragPX.current + dx;
      panY.current = dragPY.current + dy;
      reducePanToLattice();
      applyTransform();
      scheduleCull();
      return;
    }
    // hover tooltip
    const cell = (e.target as Element)?.closest?.('.hex-cell') as Element | null;
    if (!cell) { setTooltip(null); hovKey.current = ''; return; }
    const q = Number(cell.getAttribute('data-tq'));
    const r = Number(cell.getAttribute('data-tr'));
    const kind = cell.getAttribute('data-kind') ?? 'empty';
    const name = cell.getAttribute('data-name') ?? '空地';
    const key = `${kind}:${q},${r}`;
    if (key === hovKey.current) {
      // just update position
      setTooltip((t) => t ? { ...t, x: e.clientX, y: e.clientY } : t);
      return;
    }
    hovKey.current = key;
    const dist = me ? hexDistanceWrapped({ q: me.q, r: me.r }, { q, r }, W, H) : 0;
    setTooltip({ q, r, kind, name, dist, x: e.clientX, y: e.clientY });
  }

  function onMouseUp() {
    if (!dragging.current) return;
    dragging.current = false;
    svgEl.current?.classList.remove('grabbing');
    if (dragMoved.current) {
      suppress.current = true;
      scheduleCull();
      syncNavUI();
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = svgEl.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    const fw = (sx - panX.current) / zoom.current;
    const fh = (sy - panY.current) / zoom.current;
    zoom.current = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    panX.current = sx - zoom.current * fw;
    panY.current = sy - zoom.current * fh;
    reducePanToLattice();
    applyTransform();
    scheduleCull();
    syncNavUI();
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
      zoom.current = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, pinchZoom.current * scale));
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
      if (!dragMoved.current && Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
      dragMoved.current = true;
      panX.current = dragPX.current + dx;
      panY.current = dragPY.current + dy;
      reducePanToLattice();
      applyTransform();
      scheduleCull();
    }
  }

  function onTouchEnd(e: TouchEvent) {
    if (e.touches.length < 2) { pinchDist.current = 0; syncNavUI(); }
    if (e.touches.length === 0) {
      if (dragMoved.current) suppress.current = true;
      dragging.current = false;
      dragMoved.current = false;
    }
  }

  function onSvgClick(e: MouseEvent) {
    if (suppress.current) { suppress.current = false; return; }
    const cell = (e.target as Element)?.closest?.('.hex-cell') as Element | null;
    if (!cell) return;
    const q = Number(cell.getAttribute('data-tq'));
    const r = Number(cell.getAttribute('data-tr'));
    const kind = cell.getAttribute('data-kind') ?? 'empty';
    const refId = cell.getAttribute('data-ref') ?? `empty-${q},${r}`;
    const name = cell.getAttribute('data-name') ?? '空地';
    const icon = cell.getAttribute('data-icon') ?? undefined;
    selected.value = { refId, kind, q, r, name, ...(icon ? { icon } : {}) };
  }

  // ─── D-pad handlers ────────────────────────────────────────────────────────
  function doDir(dir: string) {
    const d = SCREEN_DIRS[dir];
    const cur = viewCenter();
    const w = wrapCoord(cur.q + d.dq * STEP, cur.r + d.dr * STEP, W, H);
    setMapCenter(w);
    centerViewOn(w.q, w.r);
    syncNavUI();
  }
  function doHome() {
    const capital = capitalCoordinate(me);
    if (!capital) return;
    setMapCenter(capital);
    centerViewOn(capital.q, capital.r);
    syncNavUI();
  }
  function doJump() {
    const parsed = parseMapCoordinate(jumpQ, jumpR, W, H);
    if (!parsed.ok) {
      setJumpError(parsed.error);
      return;
    }
    setJumpError('');
    setMapCenter(parsed.coordinate);
    centerViewOn(parsed.coordinate.q, parsed.coordinate.r);
    syncNavUI();
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

    // Initial center
    if (centeredKey.current === '') {
      const c = getMapCenter() ?? { q: me?.q ?? 0, r: me?.r ?? 0 };
      zoom.current = INITIAL_ZOOM;
      const p = hexToPixel(c);
      const wx = p.x + ox.current, wy = p.y + oy.current;
      panX.current = cw.current / 2 - zoom.current * wx;
      panY.current = ch.current / 2 - zoom.current * wy;
      reducePanToLattice();
      applyTransform();
      centeredKey.current = `${c.q},${c.r}`;
      syncNavUI();
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

    return () => {
      ro.disconnect();
      svg.removeEventListener('wheel', onWheel);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
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
    setJumpQ(String(navCoord.q));
    setJumpR(String(navCoord.r));
  }, [navCoord.q, navCoord.r]);

  // ─── render ────────────────────────────────────────────────────────────────
  const visibleCells = buildVisibleHexes();
  const marchPaths   = buildMarchPaths();
  const marchMarkers = buildMarchMarkers();
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
        onMouseLeave={() => { onMouseUp(); setTooltip(null); hovKey.current = ''; }}
        onDblClick={onDblClick}
        onClick={onSvgClick}
        onTouchStart={onTouchStart as any}
        onTouchMove={onTouchMove as any}
        onTouchEnd={onTouchEnd as any}
      >
        {/* Clip path: one hex at origin, used by all terrain images */}
        <defs>
          <clipPath id="hex-clip">
            <polygon points={HEX_CORNER_STR} />
          </clipPath>
          {/* Fallback colour rect for the clip mask */}
        </defs>

        <rect class="map-bg" x="0" y="0" width="100%" height="100%" />

        <g ref={camEl} class="layer-camera">
          {/* ── Terrain + entity cells ── */}
          <g class="layer-hexes">
            {visibleCells.map((c) => {
              const rk = ringKind(c.kind, c.isSelf);
              return (
                <g
                  key={`${c.q},${c.r},${c.camX.toFixed(0)},${c.camY.toFixed(0)}`}
                  class={`hex-cell${c.isSelf ? ' hex-cell--self' : ''}${c.isSelected ? ' hex-cell--selected' : ''}${c.kind !== 'empty' ? ' hex-cell--occupied' : ''}`}
                  transform={`translate(${c.camX.toFixed(1)},${c.camY.toFixed(1)})`}
                  {...({ 'data-tq': String(c.q), 'data-tr': String(c.r), 'data-kind': c.kind, 'data-ref': c.refId, 'data-name': c.name, ...(c.icon ? { 'data-icon': c.icon } : {}) } as any)}
                >
                  {/* Base fill (token-derived, always visible) */}
                  <polygon class={`hex-base hex-fill-${c.terrain}`} points={HEX_CORNER_STR} />
                  {/* Terrain texture (PNG, clipped to hex shape) */}
                  <image
                    href={artPath(`map_tile_${c.terrain}`)}
                    x={-HEX_SIZE}
                    y={-HEX_SIZE}
                    width={HEX_SIZE * 2}
                    height={HEX_SIZE * 2}
                    class="hex-terrain-img"
                    preserveAspectRatio="xMidYMid slice"
                  />
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
                  {/* Occupied village name */}
                  {c.kind !== 'empty' && (
                    <text class="hex-label" textAnchor="middle" dy={HEX_SIZE * 1.2}>
                      {c.name.slice(0, 5)}
                    </text>
                  )}
                  {/* Selection ring */}
                  {c.isSelected && <polygon class="hex-sel-ring" points={HEX_CORNER_STR} />}
                </g>
              );
            })}
          </g>

          {/* ── March paths ── */}
          <g class="layer-paths">{marchPaths}</g>

          {/* ── March markers (animated via rAF) ── */}
          <g ref={markerEl} class="layer-markers">{marchMarkers}</g>

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

        {/* D-pad + jump nav */}
        <div class="map-nav">
          <div class="map-dpad">
            <span />
            <button class="map-dpad-btn" onClick={() => doDir('up')} title="向上" aria-label="向上">▲</button>
            <span />
            <button class="map-dpad-btn" onClick={() => doDir('left')} title="向左" aria-label="向左">◀</button>
            <button class="map-dpad-btn map-dpad-btn--home" onClick={doHome} disabled={homeCentered} title="回到本城" aria-label="回到本城">⌂</button>
            <button class="map-dpad-btn" onClick={() => doDir('right')} title="向右" aria-label="向右">▶</button>
            <span />
            <button class="map-dpad-btn" onClick={() => doDir('down')} title="向下" aria-label="向下">▼</button>
            <span />
          </div>
          <form class="map-locator" noValidate onSubmit={(e) => { e.preventDefault(); doJump(); }}>
            <span class="map-locator-title">战术定位</span>
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
                  onInput={(e) => { setJumpQ(e.currentTarget.value); setJumpError(''); }}
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
                  onInput={(e) => { setJumpR(e.currentTarget.value); setJumpError(''); }}
                  aria-label="地图 Y 坐标"
                />
              </label>
              <Btn type="submit" size="sm" variant="primary" class="map-locator-jump">跳转</Btn>
              <Btn size="sm" class="map-locator-home" onClick={doHome} title="将地图居中到自己的主城">
                <span aria-hidden="true">◎</span> 回主城
              </Btn>
            </div>
            {jumpError
              ? <span class="map-locator-error" role="alert">{jumpError}</span>
              : <span class="map-locator-hint">可输入 X 0–{W - 1}，Y 0–{H - 1}</span>}
          </form>
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
  const capital = capitalCoordinate(me);
  if (!capital) return null;
  const atHome = navCoord.q === capital.q && navCoord.r === capital.r;
  return (
    <div class="map-infobar">
      {!homeCentered && !atHome ? (
        <>全图模式 · 视角偏离主城 · <a onClick={onGoHome}>回主城</a></>
      ) : atHome ? (
        <>全图模式 · 主城 <b>X={capital.q} Y={capital.r}</b>（已居中）</>
      ) : (
        <>全图模式 · 查看 <b>X={navCoord.q} Y={navCoord.r}</b> · <a onClick={onGoHome}>回主城</a></>
      )}
    </div>
  );
}

function tileKindLabel(kind: string, isSelf: boolean): string {
  if (kind === 'own_village') return isSelf ? '本城（己方）' : '己方村庄';
  if (kind === 'village') return '玩家村庄（可进攻）';
  if (kind === 'pve') return '野怪据点（可掠夺）';
  return '空地（可拓荒）';
}

function HexTooltip({ tip }: {
  tip: { q: number; r: number; kind: string; name: string; dist: number; x: number; y: number };
}) {
  const pad = 14;
  const isSelf = !!(me && me.q === tip.q && me.r === tip.r);
  const label = tileKindLabel(tip.kind, isSelf);

  // Position calculation: rough estimate, will be slightly off on first render but that's fine
  const style = {
    left: Math.min(tip.x + pad, window.innerWidth - 260),
    top:  Math.min(tip.y + pad, window.innerHeight - 120),
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
    </div>
  );
}

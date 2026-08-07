/** 地图页：六边形网格 + 行军路径与实时部队位置 + 目标选中面板 + 出征。 */
import { art, escapeAttr, escapeHtml, unitArt, unitArtFallback } from '../../shared/ui/widgets.js';
import { secStr } from '../../shared/utils/format.js';
import { hexToPixel, hexCorners, lerpPixel, HEX_SIZE, type Hex } from '../../shared/utils/hex.js';
import { worldW, worldH, pveInfoByType } from '../../app/config.js';
import { getCache, getSelected, setSelected, addReport, getMapCenter, setMapCenter } from '../../app/state.js';
import { unitName } from '../army/army.js';
import { req, me, ownVillageAt, isOwnVillageId, selectVillage, abandonVillage } from '../../api.js';
import { errText } from '../../shared/ui/text.js';

function hexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

/** 环面最短距离：考虑 (q±W, r±H) 各 8 个镜像副本，取最小。 */
function hexDistanceWrapped(a: { q: number; r: number }, b: { q: number; r: number }, W: number, H: number): number {
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

/** 坐标取模回 [0,W)×[0,H)（环面归一）。 */
function wrapCoord(q: number, r: number, W: number, H: number): { q: number; r: number } {
  const wq = ((q % W) + W) % W;
  const wr = ((r % H) + H) % H;
  return { q: wq, r: wr };
}

/** 当前地图视野中心（未设置时默认为自己）。 */
function viewCenter(): { q: number; r: number } {
  return getMapCenter() ?? { q: me!.q, r: me!.r };
}

/** pointy-top 六边形的六个轴向邻居方向向量。 */

/**
 * pointy-top axial 坐标中：
 *   屏幕上   → r 减小（q 不变）
 *   屏幕下   → r 增大（q 不变）
 *   屏幕左   → q 减小（r 不变）
 *   屏幕右   → q 增大（r 不变）
 */
const SCREEN_DIRS: Record<string, { dq: number; dr: number }> = {
  up:    { dq: 0,  dr: -1 },
  down:  { dq: 0,  dr:  1 },
  left:  { dq: -1, dr:  0 },
  right: { dq:  1, dr:  0 },
};

/** 环面世界无边界：任意坐标都合法（跨边界即环绕到对侧）。 */
function inBounds(_q: number, _r: number): boolean {
  return true;
}

/** 空地块地形着色：按坐标做确定性哈希，分 4 档极淡色相，让地图不再死平且稳定不闪。 */
function terrainVariant(q: number, r: number): number {
  const h = Math.imul(q * 73856093 ^ r * 19349663, 0x45d9f3b) >>> 0;
  return h % 4;
}

// 格子索引：用 Map 缓存，避免每次渲染对 tiles 做线性查找（视口剔除每帧会查上千次）。
let _tileIndex: Map<string, any> | null = null;
let _tileIndexRef: any = null;
function tileAt(q: number, r: number): any {
  const tiles = getCache().area?.tiles;
  if (!tiles) return undefined;
  if (_tileIndexRef !== tiles) {
    _tileIndex = new Map<string, any>();
    for (const t of tiles) _tileIndex.set(`${t.q},${t.r}`, t);
    _tileIndexRef = tiles;
  }
  return _tileIndex!.get(`${q},${r}`);
}

/** 地图 tile 仅有展示名时，按关键字猜测 PvE 图标（回退用）。 */
function pveIconByName(name?: string): string {
  const type = name?.includes('鼠') ? 'rats' : name?.includes('狼') ? 'wolves' : 'bandits';
  return pveInfoByType(type)?.icon ?? 'pve_bandits';
}

/** 六边形顶点字符串（模块级常量，避免每帧重建）。 */
const HEX_CORNER_STR = hexCorners().map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');

/** 生成单个格子标记：坐标为相机内坐标 (camX,camY)，由外层 <g class="camera"> 统一平移/缩放。
 *  内容取自已缓存的 area.tiles，无需任何服务端请求——平移/缩放时调用即可让新进入视野的格子立刻带内容显示。 */
function hexCellMarkup(q: number, r: number, camX: number, camY: number): string {
  const ownHere = ownVillageAt(q, r);
  const isCurrent = q === me!.q && r === me!.r;
  const t = tileAt(q, r);
  let cls = 'hex', inner = '', clickable = '';
  if (isCurrent) {
    cls += ' hex-self';
    inner = art('bld_main', '本城', 'sm');
    // 本城也要带坐标属性：否则悬停/点击读到 null→坐标显示为 0,0。
    clickable = `data-tq="${q}" data-tr="${r}" data-kind="own_village" data-ref="${escapeAttr(me!.id)}" data-name="${escapeAttr(me!.name)}"`;
  } else if (ownHere) {
    cls += ' hex-own';
    inner = art('bld_main', ownHere.name, 'sm');
    clickable = `data-tq="${q}" data-tr="${r}" data-kind="own_village" data-ref="${escapeAttr(ownHere.id)}" data-name="${escapeAttr(ownHere.name)}"`;
  } else if (t?.kind === 'village') {
    cls += ' hex-enemy';
    inner = art('bld_main', t.name, 'sm');
    clickable = `data-tq="${q}" data-tr="${r}" data-kind="village" data-ref="${escapeAttr(t.refId)}" data-name="${escapeAttr(t.name)}"`;
  } else if (t?.kind === 'pve') {
    cls += ' hex-pve';
    const picon = t.icon ?? pveIconByName(t.name);
    inner = art(picon, t.name, 'sm');
    clickable = `data-tq="${q}" data-tr="${r}" data-kind="pve" data-ref="${escapeAttr(t.refId)}" data-name="${escapeAttr(t.name)}" data-icon="${escapeAttr(picon)}"`;
  } else {
    // 空地块：可点选拓荒
    cls += ` hex-grass-${terrainVariant(q, r)}`;
    clickable = `data-tq="${q}" data-tr="${r}" data-kind="empty" data-ref="empty-${q},${r}" data-name="空地"`;
  }
  const sel = getSelected();
  const selCls = sel && sel.q === q && sel.r === r ? ' hex-selected' : '';
  return `<g class="hex-cell${selCls}" transform="translate(${camX.toFixed(1)},${camY.toFixed(1)})" ${clickable}>
      <polygon class="${cls}" points="${HEX_CORNER_STR}"></polygon>
      ${inner ? `<foreignObject x="-24" y="-24" width="48" height="48"><div class="hex-icon">${inner}</div></foreignObject>` : ''}
    </g>`;
}

/** 视口剔除：依据当前相机（mapPanX/Y、mapZoom、mapCw/Ch）只渲染真正落在视野内（含少量余量）的格子。
 *  关键：环面世界很小（41×41），若用"离屏幕中心最近的副本"会令每块格子都找到一份落在中心附近，
 *  导致整张地图被全量渲染（即用户看到的"外围格子没移过去就先画出来"）。因此这里直接由【视口边界】
 *  反解每块格子"可能落入视口的副本 (i,j) 区间"，只渲染确实进入视口的副本——平移时新格子才会被画出来。 */
function buildHexLayer(): string {
  const W = worldW(), H = worldH();
  const Vx = hexToPixel({ q: W, r: 0 }); // (Vx.x, 0)
  const Vy = hexToPixel({ q: 0, r: H }); // (Vy.x, Vy.y)
  const Vsx = { x: mapZoom * Vx.x, y: 0 };
  const Vsy = { x: mapZoom * Vy.x, y: mapZoom * Vy.y };
  const margin = HEX_SIZE * mapZoom * 0.8;
  const x0 = -margin, x1 = mapCw + margin;
  const y0 = -margin, y1 = mapCh + margin;
  const parts: string[] = [];
  for (let r = 0; r < H; r++) {
    for (let q = 0; q < W; q++) {
      const p = hexToPixel({ q, r });
      const baseX = mapOx + p.x;
      const baseY = mapOy + p.y;
      // 该格在中心副本 (i=0,j=0) 的屏幕位置
      const bx = mapPanX + mapZoom * baseX;
      const by = mapPanY + mapZoom * baseY;
      if (Vsy.y === 0 || Vsx.x === 0) continue;
      // 由视口边界反解 (i,j) 区间：只遍历"可能落入视口"的副本，而非整圈副本
      const jMin = Math.floor((y0 - by) / Vsy.y) - 1;
      const jMax = Math.ceil((y1 - by) / Vsy.y) + 1;
      for (let j = jMin; j <= jMax; j++) {
        const xBase = bx + j * Vsy.x;
        const iMin = Math.floor((x0 - xBase) / Vsx.x) - 1;
        const iMax = Math.ceil((x1 - xBase) / Vsx.x) + 1;
        for (let i = iMin; i <= iMax; i++) {
          const sx = bx + i * Vsx.x + j * Vsy.x;
          const sy = by + j * Vsy.y;
          if (sx < x0 || sx > x1 || sy < y0 || sy > y1) continue; // 最终边界校验，杜绝越界渲染
          const camX = baseX + i * Vx.x + j * Vy.x;
          const camY = baseY + j * Vy.y;
          parts.push(hexCellMarkup(q, r, camX, camY));
        }
      }
    }
  }
  return parts.join('');
}

/** 用当前相机状态重算并刷新"六边形图层"：平移或缩放后，新进入视野的格子会立即带内容绘制出来。 */
function renderVisibleTiles(): void {
  if (!mapCamera) return;
  const layer = mapCamera.querySelector<SVGGElement>('.layer-hexes');
  if (!layer) return;
  layer.innerHTML = buildHexLayer();
}

/** 平移/缩放后立即重算并刷新"六边形图层"：屏幕出现哪个格子就渲染哪个格子，
 *  不等下次自动刷新。改为同步即时渲染（不再经 rAF 节流），确保每次拖拽/缩放事件都立刻生效。
 * 视口剔除后单次重绘约数百个格子节点，开销很小，直接同步足够流畅。 */
function scheduleCull(): void {
  renderVisibleTiles();
}

export function renderMap(): string {
  const area = getCache().area;
  if (!area || !me) return '<div class="loading">加载中…</div>';
  const center = viewCenter();
  const selected = getSelected();
  if (selected && !tileAt(selected.q, selected.r)) setSelected(null);

  // 全图渲染：环面世界（0<=q<W,0<=r<H）。六边形采用"视口剔除"动态渲染——
  // 只绘制当前视野内的格子，平移/缩放时由 renderVisibleTiles() 实时重算，
  // 保证新进入画面的格子立刻带内容显示（无需等 5s 重拉）；
  // 副本平铺份数按当前视口动态计算，故放大/缩小都不会出现边缘空白或重复副本。

  const pad = HEX_SIZE * 1.4;
  const ox = pad; // 中心副本原点（相机坐标系）：六边形像素坐标恒 >=0，故原点 = pad
  const oy = pad;
  mapOx = ox;
  mapOy = oy;

  // 仅渲染当前视野内的格子（视口剔除），详见模块级 buildHexLayer()。
  const cells = buildHexLayer();

  // 行军路径（自己部队）：折线 + 起终点
  const moves = getCache().moves?.movements || [];
  let paths = '';
  for (const m of moves) {
    if (!m.path || m.path.length < 2) continue;
    const pts = m.path
      .map((h: Hex) => { const p = hexToPixel(h); return `${(p.x + ox).toFixed(1)},${(p.y + oy).toFixed(1)}`; })
      .join(' ');
    const cls = m.type === 'return' ? 'march-path march-return'
      : m.type === 'transport' ? 'march-path march-transport'
      : m.type === 'found' ? 'march-path march-found'
      : 'march-path';
    paths += `<polyline class="${cls}" points="${pts}"></polyline>`;
  }

  // 部队标记（<use>/<g>，位置由动画每秒更新；初始放在 pos）
  let markers = '';
  moves.forEach((m: any, i: number) => {
    if (!m.pos) return;
    const p = hexToPixel(m.pos);
    const label = m.type === 'attack' ? '⚔️'
      : m.type === 'raid' ? '🏇'
      : m.type === 'found' ? '🚩'
      : m.type === 'transport' ? '📦'
      : '🏠';
    markers += `<g class="march-marker" id="march-mk-${i}" data-mvidx="${i}" transform="translate(${(p.x + ox).toFixed(1)},${(p.y + oy).toFixed(1)})">
        <circle r="10" class="march-dot ${m.status === 'paused' ? 'paused' : ''}"></circle>
        <text class="march-emoji" text-anchor="middle" dy="4">${label}</text>
      </g>`;
  });

  const svg = `<svg class="map-svg" id="mapSvg" data-ox="${ox.toFixed(1)}" data-oy="${oy.toFixed(1)}" viewBox="0 0 1000 700" preserveAspectRatio="xMidYMid meet">
      <rect class="map-bg" x="0" y="0" width="100%" height="100%"></rect>
      <g class="camera" id="mapCamera" transform="translate(0,0) scale(1)">
        <g class="layer-hexes">${cells}</g>
        <g class="layer-paths">${paths}</g>
        <g class="layer-markers">${markers}</g>
      </g>
    </svg>`;

  const movesList = moves.map((m: any) => {
    const kind = m.type === 'attack' ? '⚔️ 进攻'
      : m.type === 'raid' ? '🏇 掠夺'
      : m.type === 'found' ? '🚩 拓荒'
      : m.type === 'transport' ? '📦 运输'
      : '🏠 返程';
    const loot = m.loot || m.cargo
      ? ` · 货物 ${Object.values(m.loot || m.cargo).reduce((a: any, b: any) => a + (b as number), 0)}`
      : '';
    const st = m.status === 'paused' ? ' · <b>交战中</b>' : '';
    return `<div class="banner banner-move">${kind} → (${m.to.q},${m.to.r}) 抵达 <b>${secStr(m.arriveAt)}</b>${st}${loot}</div>`;
  }).join('');

  // 导航控件：方向键 + 坐标跳转（环面世界无边界，方向键始终可用）
  const size = Math.max(worldW(), worldH());
  const STEP = 4;
  const canUp    = inBounds(center.q, center.r - STEP);
  const canDown  = inBounds(center.q, center.r + STEP);
  const canLeft  = inBounds(center.q - STEP, center.r);
  const canRight = inBounds(center.q + STEP, center.r);
  const isHome = center.q === me.q && center.r === me.r;

  // 玩家看到的是 X,Y（X=q, Y=r，显示层映射）
  const nav = `<div class="map-nav">
    <div class="map-nav-dpad">
      <button class="map-dpad-btn map-dpad-up" id="mapDirUp" title="向上" ${canUp ? '' : 'disabled'}>▲</button>
      <div class="map-dpad-mid">
        <button class="map-dpad-btn map-dpad-left" id="mapDirLeft" title="向左" ${canLeft ? '' : 'disabled'}>◀</button>
        <button class="map-dpad-btn map-dpad-home" id="mapDirHome" title="回到本城" ${isHome ? 'disabled' : ''}>⌂</button>
        <button class="map-dpad-btn map-dpad-right" id="mapDirRight" title="向右" ${canRight ? '' : 'disabled'}>▶</button>
      </div>
      <button class="map-dpad-btn map-dpad-down" id="mapDirDown" title="向下" ${canDown ? '' : 'disabled'}>▼</button>
    </div>
    <div class="map-nav-jump">
      <label class="map-jump-label">跳转坐标</label>
      <div class="map-jump-row">
        <span class="map-jump-axis">X</span><input type="number" id="mapJumpX" class="map-jump-input" value="${center.q}" min="${-size}" max="${size}" />
        <span class="map-jump-axis">Y</span><input type="number" id="mapJumpY" class="map-jump-input" value="${center.r}" min="${-size}" max="${size}" />
        <button class="map-jump-btn" id="mapJumpGo">跳转</button>
      </div>
      <div class="map-jump-hint">环面世界 · 坐标范围 X∈[0,${worldW()}) Y∈[0,${worldH()})，跨边界自动环绕 · 拖拽平移 / 滚轮缩放 / 双击空白复位 · 当前中心 X=${center.q} Y=${center.r}</div>
    </div>
  </div>`;

  const isViewing = center.q !== me.q || center.r !== me.r;
  const viewLabel = isViewing
    ? `全图模式 · 正在查看 (X=${center.q}, Y=${center.r})，<a href="#" id="mapReturnHome">回到本城</a>`
    : `全图模式 · 你在 X=${me.q}, Y=${me.r}（已居中）`;

  return `<h3>世界地图 <small id="mapViewLabel">（${viewLabel}）</small></h3>
    ${nav}
    <div class="map-wrap">
      ${svg}
      <div class="map-legend">
        <span><i class="dot dot-self"></i>本城</span>
        <span><i class="dot dot-enemy"></i>玩家村(可进攻)</span>
        <span><i class="dot dot-pve"></i>野怪(可掠夺)</span>
        <span><i class="dot dot-march"></i>行军部队</span>
      </div>
    </div>
    <div id="targetPanel">${renderTargetPanel()}</div>
    <h3>行军中</h3>${movesList || '<small class="muted">无</small>'}`;
}

function renderTargetPanel(): string {
  const selected = getSelected();
  if (!selected || !me) return '<div class="empty">点击地图上的目标：野怪掠夺、玩家进攻、空地拓荒、己方运输。</div>';
  const army = getCache().army;
  const dist = hexDistanceWrapped({ q: selected.q, r: selected.r }, { q: me.q, r: me.r }, worldW(), worldH());

  if (selected.kind === 'empty') {
    return `<div class="target-panel target">
      <div class="target-head">${art('bld_main', '空地', 'md')}
        <div><div class="card-title">空地</div>
          <small class="coord">坐标 (${selected.q},${selected.r}) · 距离 ${dist} 格 · 可拓荒建村</small></div>
        <button class="target-close" id="closeTarget">✕</button>
      </div>
      <p class="muted">需主基地与人口规模达标，并备齐 3 名拓荒者与开城资源。失败不退开城包。</p>
      <div class="target-actions"><button class="btn-sm btn-raid" id="doFound">🚩 拓荒建村</button></div>
    </div>`;
  }

  if (selected.kind === 'own_village' || isOwnVillageId(selected.refId)) {
    const isCapital = !!me.villages?.find((v) => v.id === selected.refId)?.isCapital
      || selected.refId === me.capitalVillageId;
    const myTroops = Object.entries(army?.troops || {}).filter(([, n]: any) => n > 0);
    const inputs = myTroops.length
      ? myTroops.map(([u, n]: any) => `<label class="raid-input">${art(unitArt(u), unitName(u), 'sm', unitArtFallback(u))}<span class="raid-name">${unitName(u)}</span><input type="number" min="0" max="${n}" value="0" id="raid-${u}" /><small>/${n}</small></label>`).join('')
      : '<small class="muted">无可用兵力</small>';
    const res = getCache().res?.resources ?? {};
    const cargoInputs = ['wood', 'clay', 'iron', 'crop'].map((t) =>
      `<label class="raid-input"><span class="raid-name">${t}</span><input type="number" min="0" max="${Math.floor(res[t] ?? 0)}" value="0" id="cargo-${t}" /><small>/${Math.floor(res[t] ?? 0)}</small></label>`).join('');
    const abandonBtn = isCapital
      ? ''
      : `<button class="btn-sm btn-danger" id="doAbandonVillage" title="放弃分城（驻军与资源清空）">放弃此村</button>`;
    return `<div class="target-panel target">
      <div class="target-head">${art('bld_main', selected.name, 'md')}
        <div><div class="card-title">${escapeHtml(selected.name)}${isCapital ? '（主城）' : ''}</div>
          <small class="coord">己方村庄 · (${selected.q},${selected.r}) · 距离 ${dist} 格</small></div>
        <button class="target-close" id="closeTarget">✕</button>
      </div>
      <div class="target-actions">
        <button class="btn-sm" id="doSwitchVillage">切换到此村</button>
        ${abandonBtn}
      </div>
      <div class="raidbox-title">运输部队（运力=负重）</div>
      <div class="raid-inputs">${inputs}</div>
      <div class="raidbox-title">运输货物</div>
      <div class="raid-inputs">${cargoInputs}</div>
      ${myTroops.length ? `<div class="target-actions"><button class="btn-sm btn-raid" id="doTransport">📦 运输</button></div>` : ''}
    </div>`;
  }

  const myTroops = Object.entries(army?.troops || {}).filter(([, n]: any) => n > 0);
  const inputs = myTroops.length
    ? myTroops.map(([u, n]: any) => `<label class="raid-input">${art(unitArt(u), unitName(u), 'sm', unitArtFallback(u))}<span class="raid-name">${unitName(u)}</span><input type="number" min="0" max="${n}" value="${n}" id="raid-${u}" /><small>/${n}</small></label>`).join('')
    : '<small class="muted">无可用兵力，先去军队页训练</small>';
  const isPve = selected.kind === 'pve';
  const action = isPve
    ? `<button class="btn-sm btn-raid" id="doRaid">🏇 掠夺</button>`
    : `<button class="btn-sm btn-attack" id="doAttack">⚔️ 进攻</button>`;
  const icon = isPve ? (selected.icon ?? pveIconByName(selected.name)) : 'bld_main';
  return `<div class="target-panel ${isPve ? 'target' : 'enemy'}">
    <div class="target-head">${art(icon, selected.name, 'md')}
      <div><div class="card-title">${escapeHtml(selected.name)}</div>
        <small class="coord">坐标 (${selected.q},${selected.r}) · 距离 ${dist} 格 · ${isPve ? '野怪据点' : '玩家村庄'}</small></div>
      <button class="target-close" id="closeTarget">✕</button>
    </div>
    <div class="raidbox-title">出征兵力</div>
    <div class="raid-inputs">${inputs}</div>
    ${myTroops.length ? `<div class="target-actions">${action}</div>` : ''}
  </div>`;
}

// unitArt 依赖循环规避：从 widgets 引入

function collectTroops(): Record<string, number> {
  const troops: Record<string, number> = {};
  Object.keys(getCache().army?.troops || {}).forEach((u) => {
    const el = document.getElementById(`raid-${u}`) as HTMLInputElement;
    if (el && Number(el.value) > 0) troops[u] = Number(el.value);
  });
  return troops;
}

/** 部队沿路径的实时插值动画（每帧调，无需重渲染整张地图）。 */
let animTimer: number | null = null;function startMarchAnimation(ox: number, oy: number): void {
  if (animTimer !== null) { cancelAnimationFrame(animTimer); animTimer = null; }
  const tick = () => {
    const moves = getCache().moves?.movements || [];
    const now = Date.now();
    moves.forEach((m: any, i: number) => {
      const g = document.getElementById(`march-mk-${i}`);
      if (!g || !m.path || m.stepIndex == null) return;
      const cur = m.path[m.stepIndex];
      if (!cur) return;
      let px = hexToPixel(cur);
      // marching 且有下一格 → 在当前格与下一格间按剩余时间插值
      if (m.status === 'marching' && m.stepIndex < m.path.length - 1 && m.nextStepAt && m.perStepMs) {
        const next = m.path[m.stepIndex + 1];
        const remain = m.nextStepAt - now;
        const t = Math.max(0, Math.min(1, 1 - remain / m.perStepMs));
        px = lerpPixel(hexToPixel(cur), hexToPixel(next), t);
      }
      g.setAttribute('transform', `translate(${(px.x + ox).toFixed(1)},${(px.y + oy).toFixed(1)})`);
    });
    animTimer = requestAnimationFrame(tick);
  };
  animTimer = requestAnimationFrame(tick);
}

/* ============================================================
   地图缩放/平移（整图视觉变换，不重拉数据）
   - 整张地图（半径 mapSize 的全部六边形）一次性渲染进 SVG，viewBox 覆盖全图
   - 桌面：左键拖拽平移 + 滚轮缩放；移动端：双指捏合缩放 + 双指拖拽平移
   - 状态存模块级：每 5s 重渲后 bindMap 重新 applyMapTransform，缩放/平移不丢失
   - D-pad / 跳转 / 回城 = centerViewOn() 视觉居中（仅改 transform），双击空白处 resetMapView() 复位
   ============================================================ */
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 2;
let mapZoom = 1;
let mapPanX = 0;   // 相机 <g> 平移 x（viewBox px = 容器 px）
let mapPanY = 0;   // 相机 <g> 平移 y
let mapOx = 0;     // 中心副本原点 x（世界像素），renderMap 写入
let mapOy = 0;     // 中心副本原点 y
let mapCw = 1000;  // 容器宽（px），bindMap 按实际写入
let mapCh = 700;   // 容器高（px）
let mapCamera: SVGGElement | null = null;

function resetMapView(): void {
  // 双击空白：以当前视野中心、zoom=1 重新居中（而非归零，避免跳变）。
  mapZoom = 1;
  centerViewOn(viewCenter());
}

/** 进地图页时重置居中状态：下次 bindMap 会以本城为心、INITIAL_ZOOM 重新居中。 */
export function resetMapCenter(): void {
  mapCenteredKey = '';
  mapZoom = 1;
  mapPanX = 0;
  mapPanY = 0;
}

/**
 * 环面无缝环绕：把"视野中心"约束在中心副本邻域内。
 * 相机把世界点 P 映射到屏幕：screen = pan + zoom·P。
 * 视野中心世界点 C = (cw/2 - panX)/zoom, (ch/2 - panY)/zoom。
 * 将 C 写成 base + u·Vx + v·Vy（base=中心副本原点），把 (u,v) 约化到 [-0.5,0.5)，
 * 再反推 pan，使相机中心始终落在中心副本 ±½ 晶格内 —— 9 份副本必覆盖视野，
 * 既无边缘留白，也不会出现"两份地图"；整圈平移跨边界时无缝环绕到对侧。
 */
function reducePanToLattice(): void {
  if (mapCw <= 0 || mapCh <= 0 || mapZoom <= 0) return;
  const W = worldW(), H = worldH();
  const Vx = hexToPixel({ q: W, r: 0 }); // (Vx.x, 0)
  const Vy = hexToPixel({ q: 0, r: H }); // (Vy.x, Vy.y)
  if (Math.abs(Vx.x) < 1e-6 || Math.abs(Vy.y) < 1e-6) return;
  const bx = mapOx, by = mapOy;
  const cx = (mapCw / 2 - mapPanX) / mapZoom;
  const cy = (mapCh / 2 - mapPanY) / mapZoom;
  // 解 (u, v): C = base + u·Vx + v·Vy
  const v = (cy - by) / Vy.y;                 // Vx.y === 0
  const u = (cx - bx - v * Vy.x) / Vx.x;
  const uR = u - Math.round(u);
  const vR = v - Math.round(v);
  const cxR = bx + uR * Vx.x + vR * Vy.x;
  const cyR = by + vR * Vy.y;
  mapPanX = mapCw / 2 - mapZoom * cxR;
  mapPanY = mapCh / 2 - mapZoom * cyR;
}

function applyMapTransform(_svg?: SVGSVGElement): void {
  if (!mapCamera) return;
  mapCamera.setAttribute(
    'transform',
    `translate(${mapPanX.toFixed(2)},${mapPanY.toFixed(2)}) scale(${mapZoom.toFixed(4)})`,
  );
}

/** 进入全图模式时的初始缩放（让本城周围有可读细节，而非整图缩成微缩）。 */
const INITIAL_ZOOM = 1.6;
/** 记录已居中过的坐标，避免每次 5s 重渲把视角硬拉回中心。 */
let mapCenteredKey = '';

/**
 * 视觉居中：把指定 (q,r) 格平移到容器正中。
 * 直接由坐标算世界像素位置，不依赖 DOM 查询（避免命中 9 份副本中的错误一份），
 * 再用 reducePanToLattice 约化到环面晶格内，保证跨边界无缝、无重复副本。
 */
function centerViewOn(target: { q: number; r: number }): void {
  const p = hexToPixel({ q: target.q, r: target.r });
  const wx = p.x + mapOx; // 中心副本内该格的世界像素坐标
  const wy = p.y + mapOy;
  mapPanX = mapCw / 2 - mapZoom * wx;
  mapPanY = mapCh / 2 - mapZoom * wy;
  reducePanToLattice();
  applyMapTransform(mapSvg ?? undefined);
  renderVisibleTiles(); // 居中后立即重算视野内格子，确保新进入画面的格子带内容显示
  mapCenteredKey = `${target.q},${target.r}`;
}

/** 双指手势：捏合缩放 + 双指拖拽平移。绑定标记避免同一元素重复绑定。 */
function bindMapGestures(svg: SVGSVGElement): void {
  if ((svg as any)._gesturesBound) return;
  (svg as any)._gesturesBound = true;

  let startDist = 0;      // 双指起始间距
  let startZoom = 1;      // 手势开始时的缩放
  let startMidX = 0;      // 双指中点（起始）
  let startMidY = 0;
  let startPanX = 0;
  let startPanY = 0;

  const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const mid = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });

  svg.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 2) return;
    startDist = dist(e.touches);
    startZoom = mapZoom;
    const m = mid(e.touches);
    startMidX = m.x; startMidY = m.y;
    startPanX = mapPanX; startPanY = mapPanY;
  }, { passive: true });

  svg.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || startDist === 0) return;
    e.preventDefault(); // 阻止浏览器整页缩放，改由我们控制地图缩放
    const scale = dist(e.touches) / startDist;
    mapZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, startZoom * scale));
    const m = mid(e.touches);
    mapPanX = startPanX + (m.x - startMidX);
    mapPanY = startPanY + (m.y - startMidY);
    // 双指缩放围绕中点锚定：保持中点处世界点不动
    const rect = svg.getBoundingClientRect();
    const sx = m.x - rect.left, sy = m.y - rect.top;
    const fw = (sx - mapPanX) / mapZoom;
    const fh = (sy - mapPanY) / mapZoom;
    mapPanX = sx - mapZoom * fw;
    mapPanY = sy - mapZoom * fh;
    reducePanToLattice(); // 双指拖拽到边缘无缝环绕到对侧
    applyMapTransform(svg);
    scheduleCull(); // 双指缩放/拖拽后重算视野内格子
  }, { passive: false });

  svg.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) startDist = 0;
  }, { passive: true });
}

/* ============================================================
   地图鼠标交互（桌面端）：拖拽平移 + 滚轮缩放 + 悬停信息浮层
   - 复用既有 mapZoom / mapPanX / mapPanY 与 applyMapTransform，属于纯视觉变换：
     只改 SVG 的 CSS transform，不改视野中心，因此不会触发重新拉取地图数据。
   - 与手机双指手势（bindMapGestures）并存：桌面用左键拖拽、滚轮缩放。
   - 监听统一挂在 window 上，且只绑定一次（_kowMapMouseBound 标记），跨 5s 重渲不重复绑定；
     当前 SVG 引用存模块级 mapSvg，每帧 renderMap/bindMap 刷新，旧元素自然丢弃。
   - 拖拽与点击互斥：拖动超过 3px 阈值即视为平移，抬手后吞掉随后触发的 click，避免误选中地块。
   - 悬停 <g class="hex-cell">（自带 data-tq/tr/kind/name/ref/icon）显示信息浮层：
     坐标(X/Y) / 类型 / 名称 / 与你的距离，全部客户端可得，无需改动服务端契约。
   ============================================================ */
let mapSvg: SVGSVGElement | null = null;
let mapSuppressClick = false;
let mapDragging = false;
let mapDragMoved = false;
let mapDragStartX = 0;
let mapDragStartY = 0;
let mapDragPanX = 0;
let mapDragPanY = 0;
let mapHoverKey = '';

/** 拖动后吞掉一次 click，防止误选中。 */
function swallowClick(): boolean {
  if (mapSuppressClick) { mapSuppressClick = false; return true; }
  return false;
}

/** 悬停信息浮层：首次创建后常驻 body，按光标定位（fixed，不被 .map-wrap overflow 裁剪）。 */
function ensureTooltip(): HTMLElement {
  let el = document.getElementById('mapTooltip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mapTooltip';
    el.className = 'map-tooltip';
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  return el;
}

function tileKindLabel(kind: string, isSelf: boolean): string {
  if (kind === 'empty') return '空地';
  if (kind === 'own_village') return isSelf ? '本城（己方）' : '己方村庄';
  if (kind === 'village') return '玩家村庄（可进攻）';
  if (kind === 'pve') return '野怪据点（可掠夺）';
  return kind;
}

function showTileTooltip(cell: Element, clientX: number, clientY: number): void {
  const q = Number(cell.getAttribute('data-tq'));
  const r = Number(cell.getAttribute('data-tr'));
  const kind = cell.getAttribute('data-kind') || 'empty';
  const name = cell.getAttribute('data-name') || '空地';
  const isSelf = kind === 'own_village' && !!me && me.q === q && me.r === r;
  const dist = me ? hexDistanceWrapped({ q: me.q, r: me.r }, { q, r }, worldW(), worldH()) : 0;
  const key = `${kind}:${q},${r}:${name}`;
  const tip = ensureTooltip();
  if (key !== mapHoverKey || tip.style.display !== 'block') {
    mapHoverKey = key;
    const label = tileKindLabel(kind, isSelf);
    tip.innerHTML = `<div class="mt-title">${escapeHtml(label)}</div>`
      + `<div class="mt-row"><span>坐标</span><b>X=${q} · Y=${r}</b></div>`
      + `<div class="mt-row"><span>名称</span><b>${escapeHtml(name)}</b></div>`
      + `<div class="mt-row"><span>距离</span><b>${dist} 格</b></div>`
      + (kind === 'empty' ? '<div class="mt-hint">悬停预览 · 点击可拓荒建村</div>' : '');
  }
  tip.style.display = 'block';
  const pad = 14;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = clientX + pad;
  let y = clientY + pad;
  if (x + w > window.innerWidth - 8) x = clientX - pad - w;
  if (y + h > window.innerHeight - 8) y = clientY - pad - h;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

function hideTileTooltip(): void {
  const el = document.getElementById('mapTooltip');
  if (el) el.style.display = 'none';
}

/** 桌面鼠标交互：拖拽平移 + 滚轮缩放 + 悬停浮层。window 级监听只绑一次。 */
function bindMapMouse(): void {
  if ((window as any)._kowMapMouseBound) return;
  (window as any)._kowMapMouseBound = true;

  window.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0 || !mapSvg) return;
    if (!(e.target as Element)?.closest?.('.map-svg')) return;
    mapDragging = true;
    mapDragMoved = false;
    mapDragStartX = e.clientX;
    mapDragStartY = e.clientY;
    mapDragPanX = mapPanX;
    mapDragPanY = mapPanY;
    mapSvg.classList.add('grabbing');
    hideTileTooltip();
  });

  window.addEventListener('mousemove', (e: MouseEvent) => {
    if (mapDragging && mapSvg) {
      const dx = e.clientX - mapDragStartX;
      const dy = e.clientY - mapDragStartY;
      // 仅在超过拖拽阈值（>3px）后才真正平移/重绘：避免"点击时轻微抖动"也触发
      // 视口剔除重建 DOM，导致随后的 click 事件被重定向到 <g.layer-hexes> 而丢失 target，
      // 进而使 cell = e.target.closest('.hex-cell') 为 null、点击选中/派兵失效。
      const moved = Math.abs(dx) > 3 || Math.abs(dy) > 3;
      if (!moved) return;
      mapDragMoved = true;
      mapPanX = mapDragPanX + dx;
      mapPanY = mapDragPanY + dy;
      reducePanToLattice(); // 拖到边缘无缝环绕到对侧
      applyMapTransform(mapSvg);
      scheduleCull(); // 拖动让新格子进入画面时重算，确保立刻看到格子上的内容
      return;
    }
    const cell = (e.target as Element)?.closest?.('.hex-cell');
    if (cell) showTileTooltip(cell, e.clientX, e.clientY);
    else hideTileTooltip();
  });

  window.addEventListener('mouseup', () => {
    if (!mapDragging) return;
    mapDragging = false;
    mapSvg?.classList.remove('grabbing');
    if (mapDragMoved) {
      mapSuppressClick = true; // 吞掉随后触发的 click，避免误选中地块
      renderVisibleTiles(); // 拖拽结束再确保一次：把松手瞬间视野内的格子都渲染出来
    }
  });

  window.addEventListener('wheel', (e: WheelEvent) => {
    if (!mapSvg) return;
    if (!(e.target as Element)?.closest?.('.map-svg')) return;
    e.preventDefault(); // 阻止页面滚动
    const rect = mapSvg.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const fw = (sx - mapPanX) / mapZoom; // 光标处世界点（缩放前）
    const fh = (sy - mapPanY) / mapZoom;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    mapZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, mapZoom * factor));
    mapPanX = sx - mapZoom * fw; // 保持光标处世界点不动
    mapPanY = sy - mapZoom * fh;
    reducePanToLattice();
    applyMapTransform(mapSvg);
    scheduleCull(); // 缩放后重算视野内格子（含副本份数随缩放变化）
  }, { passive: false });
}

/** 同步导航控件 UI（方向键可用态 / 跳转输入值 / 标题行视图标签），不触发整页重渲。 */
function syncNavUI(center: { q: number; r: number }): void {
  const STEP = 4;
  const setDis = (id: string, dis: boolean) => {
    const b = document.getElementById(id);
    if (b) (b as HTMLButtonElement).disabled = dis;
  };
  setDis('mapDirUp', !inBounds(center.q, center.r - STEP));
  setDis('mapDirDown', !inBounds(center.q, center.r + STEP));
  setDis('mapDirLeft', !inBounds(center.q - STEP, center.r));
  setDis('mapDirRight', !inBounds(center.q + STEP, center.r));
  setDis('mapDirHome', center.q === me!.q && center.r === me!.r);
  const xEl = document.getElementById('mapJumpX') as HTMLInputElement | null;
  const yEl = document.getElementById('mapJumpY') as HTMLInputElement | null;
  if (xEl) xEl.value = String(center.q);
  if (yEl) yEl.value = String(center.r);
  const label = document.getElementById('mapViewLabel');
  if (label) {
    const isViewing = center.q !== me!.q || center.r !== me!.r;
    label.innerHTML = isViewing
      ? `全图模式 · 正在查看 (X=${center.q}, Y=${center.r})，<a href="#" id="mapReturnHome">回到本城</a>`
      : `全图模式 · 你在 X=${center.q}, Y=${center.r}（已居中）`;
    const ret = document.getElementById('mapReturnHome');
    if (ret) ret.onclick = (e: Event) => {
      e.preventDefault();
      setMapCenter(null);
      centerViewOn({ q: me!.q, r: me!.r });
      syncNavUI({ q: me!.q, r: me!.r });
    };
  }
}

/** 绑定地图页交互（选格 + 出征 + 启动行军动画 + 导航控件）。 */
export function bindMap(act: (p: Promise<any>) => void): void {
  const svg = document.querySelector<SVGSVGElement>('.map-svg');
  mapSvg = svg;
  if (svg) {
    mapCamera = svg.querySelector<SVGGElement>('#mapCamera');
    mapCw = svg.clientWidth || mapCw;
    mapCh = svg.clientHeight || mapCh;
    svg.setAttribute('viewBox', `0 0 ${mapCw} ${mapCh}`);
    const ox = Number(svg.dataset.ox || 0);
    const oy = Number(svg.dataset.oy || 0);
    mapOx = ox; mapOy = oy;
    startMarchAnimation(ox, oy);
    bindMapGestures(svg); // 手机双指缩放/平移（增强，不替代 D-pad）
    bindMapMouse();       // 桌面鼠标：拖拽平移 + 滚轮缩放 + 悬停信息浮层
    svg.addEventListener('mouseleave', hideTileTooltip);
    svg.addEventListener('dblclick', (e: MouseEvent) => {
      if ((e.target as Element)?.closest?.('.hex-cell')) return; // 点到地块不复位
      resetMapView();
    });
    // 首次绑定：以本城为初始中心、适度放大，进入全图可拖拽/缩放模式。
    if (mapCenteredKey === '') {
      mapZoom = INITIAL_ZOOM;
      centerViewOn(viewCenter());
      syncNavUI(viewCenter());
    } else {
      applyMapTransform(); // 跨 5s 重渲保留缩放/平移态
      renderVisibleTiles(); // 重渲后按当前相机重算视野内格子
    }
  }

  // 点击格子：事件委托到 svg（格子会在平移/缩放时频繁重建，委托避免丢失 handler）。
  if (svg) {
    svg.addEventListener('click', (e: MouseEvent) => {
      if (swallowClick()) return; // 刚发生过拖拽平移，吞掉误触的选中
      const cell = (e.target as Element)?.closest?.('.hex-cell');
      if (!cell) return;
      const dq = cell.getAttribute('data-tq'), dr = cell.getAttribute('data-tr');
      if (dq == null || dr == null) return;
      setSelected({
        refId: cell.getAttribute('data-ref') || `empty-${dq},${dr}`,
        kind: cell.getAttribute('data-kind')!,
        q: Number(dq), r: Number(dr),
        name: cell.getAttribute('data-name') || '空地',
        icon: cell.getAttribute('data-icon') ?? undefined,
      });
      const panel = document.getElementById('targetPanel');
      if (panel) { panel.innerHTML = renderTargetPanel(); bindTargetEvents(act); }
      document.querySelectorAll('.hex-selected').forEach((t) => t.classList.remove('hex-selected'));
      cell.classList.add('hex-selected');
    });
  }
  bindTargetEvents(act);

  // 方向键（全图模式下 = 视觉平移到相邻区域中心，不重拉数据）
  const STEP = 4;
  const bindDir = (id: string, dir: string) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.onclick = () => {
      const d = SCREEN_DIRS[dir];
      const cur = viewCenter();
      const nq = cur.q + d.dq * STEP;
      const nr = cur.r + d.dr * STEP;
      // 环面世界：方向键始终可用，跨边界即环绕到对侧。
      const w = wrapCoord(nq, nr, worldW(), worldH());
      setMapCenter({ q: w.q, r: w.r });
      centerViewOn({ q: w.q, r: w.r });
      syncNavUI({ q: w.q, r: w.r });
    };
  };
  bindDir('mapDirUp', 'up');
  bindDir('mapDirDown', 'down');
  bindDir('mapDirLeft', 'left');
  bindDir('mapDirRight', 'right');

  // 回到本城（方向键盘中心的 ⌂）
  const homeBtn = document.getElementById('mapDirHome');
  if (homeBtn) homeBtn.onclick = () => {
    setMapCenter(null);
    centerViewOn({ q: me!.q, r: me!.r });
    syncNavUI({ q: me!.q, r: me!.r });
  };

  // 标题行内联"回到本城"链接
  const retHome = document.getElementById('mapReturnHome');
  if (retHome) retHome.onclick = (e) => {
    e.preventDefault();
    setMapCenter(null);
    centerViewOn({ q: me!.q, r: me!.r });
    syncNavUI({ q: me!.q, r: me!.r });
  };

  // 坐标跳转（X=q, Y=r）
  const jumpGo = document.getElementById('mapJumpGo');
  if (jumpGo) jumpGo.onclick = () => {
    const xEl = document.getElementById('mapJumpX') as HTMLInputElement;
    const yEl = document.getElementById('mapJumpY') as HTMLInputElement;
    const q = parseInt(xEl.value, 10);
    const r = parseInt(yEl.value, 10);
    if (isNaN(q) || isNaN(r)) { addReport('请输入有效坐标'); return; }
    // 环面世界：接受任意整数坐标，自动取模归一到 [0,W)×[0,H)。
    const w = wrapCoord(q, r, worldW(), worldH());
    setMapCenter({ q: w.q, r: w.r });
    centerViewOn({ q: w.q, r: w.r });
    syncNavUI({ q: w.q, r: w.r });
  };
  // 按 Enter 也触发跳转
  [document.getElementById('mapJumpX'), document.getElementById('mapJumpY')].forEach((el) => {
    if (el) el.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') jumpGo?.click(); });
  });
}

function bindTargetEvents(act: (p: Promise<any>) => void) {
  const close = document.getElementById('closeTarget');
  if (close) close.onclick = () => {
    setSelected(null);
    const p = document.getElementById('targetPanel');
    if (p) p.innerHTML = renderTargetPanel();
    document.querySelectorAll('.hex-selected').forEach((t) => t.classList.remove('hex-selected'));
  };
  const raid = document.getElementById('doRaid');
  if (raid) raid.onclick = () => {
    const troops = collectTroops();
    if (!Object.keys(troops).length) { addReport('请先设置出征兵力'); return; }
    act(req('SendRaid', { targetId: getSelected()!.refId, troops }));
  };
  const atk = document.getElementById('doAttack');
  if (atk) atk.onclick = () => {
    const troops = collectTroops();
    if (!Object.keys(troops).length) { addReport('请先设置出征兵力'); return; }
    const sel = getSelected()!;
    act(req('SendAttack', { targetVillage: sel.refId, troops }));
  };
  const found = document.getElementById('doFound');
  if (found) found.onclick = () => {
    const sel = getSelected()!;
    act(req('FoundVillage', { q: sel.q, r: sel.r }));
  };
  const sw = document.getElementById('doSwitchVillage');
  if (sw) sw.onclick = async () => {
    const sel = getSelected()!;
    const r = await selectVillage(sel.refId);
    if (!r.ok) { addReport(`切村失败：${errText(r.error)}`); return; }
    addReport(`已切换到 ${sel.name}`);
    act(Promise.resolve({ ok: true }));
  };
  const abd = document.getElementById('doAbandonVillage');
  if (abd) abd.onclick = async () => {
    const sel = getSelected()!;
    const ok = window.confirm(
      `确认放弃「${sel.name}」？\n驻军将就地解散，资源清空，地块变回空地。此操作不可撤销。`,
    );
    if (!ok) return;
    const r = await abandonVillage(sel.refId);
    if (!r.ok) { addReport(`放弃失败：${errText(r.error)}`); return; }
    setSelected(null);
    addReport(`已放弃 ${sel.name}`);
    act(Promise.resolve({ ok: true }));
  };
  const tr = document.getElementById('doTransport');
  if (tr) tr.onclick = () => {
    const troops = collectTroops();
    if (!Object.keys(troops).length) { addReport('请先设置运输部队'); return; }
    const cargo: Record<string, number> = {};
    for (const t of ['wood', 'clay', 'iron', 'crop']) {
      const el = document.getElementById(`cargo-${t}`) as HTMLInputElement;
      const n = el ? Number(el.value) : 0;
      if (n > 0) cargo[t] = n;
    }
    if (!Object.keys(cargo).length) { addReport('请填写运输货物'); return; }
    act(req('SendTransport', { targetVillage: getSelected()!.refId, troops, cargo }));
  };
}

/** 地图页：六边形网格 + 行军路径与实时部队位置 + 目标选中面板 + 出征。 */
import { art, escapeAttr, escapeHtml, unitArt, unitArtFallback } from '../../shared/ui/widgets.js';
import { secStr } from '../../shared/utils/format.js';
import { hexToPixel, hexCorners, lerpPixel, HEX_SIZE, type Hex } from '../../shared/utils/hex.js';
import { mapViewRadius, mapSize, pveInfoByType } from '../../app/config.js';
import { getCache, getSelected, setSelected, addReport } from '../../app/state.js';
import { getMapCenter, setMapCenter } from '../../app/refresh.js';
import { unitName } from '../army/army.js';
import { req, me, ownVillageAt, isOwnVillageId, selectVillage } from '../../api.js';
import { errText } from '../../shared/ui/text.js';

function hexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
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

/** 检查坐标是否在地图边界内。 */
function inBounds(q: number, r: number): boolean {
  return hexDistance({ q: 0, r: 0 }, { q, r }) <= mapSize();
}

function dirLabel(dir: string): string {
  return { up: '上', down: '下', left: '左', right: '右' }[dir] ?? dir;
}

/** 空地块地形着色：按坐标做确定性哈希，分 4 档极淡色相，让地图不再死平且稳定不闪。 */
function terrainVariant(q: number, r: number): number {
  const h = Math.imul(q * 73856093 ^ r * 19349663, 0x45d9f3b) >>> 0;
  return h % 4;
}

function tileAt(q: number, r: number): any {
  return (getCache().area?.tiles || []).find((t: any) => t.q === q && t.r === r);
}

/** 地图 tile 仅有展示名时，按关键字猜测 PvE 图标（回退用）。 */
function pveIconByName(name?: string): string {
  const type = name?.includes('鼠') ? 'rats' : name?.includes('狼') ? 'wolves' : 'bandits';
  return pveInfoByType(type)?.icon ?? 'pve_bandits';
}

/** 收集视野内所有格坐标（六边形半径 R，以 center 为中心）。 */
function viewHexes(center: { q: number; r: number }, R: number): Hex[] {
  const out: Hex[] = [];
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = Math.max(-R, -dq - R); dr <= Math.min(R, -dq + R); dr++) {
      out.push({ q: center.q + dq, r: center.r + dr });
    }
  }
  return out;
}

export function renderMap(): string {
  const area = getCache().area;
  if (!area || !me) return '<div class="loading">加载中…</div>';
  const R = mapViewRadius();
  const center = viewCenter();
  const selected = getSelected();
  if (selected && !tileAt(selected.q, selected.r)) setSelected(null);

  const hexes = viewHexes(center, R);
  // 画布尺寸：取视野内像素范围。
  const pad = HEX_SIZE * 1.4;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const h of hexes) {
    const p = hexToPixel(h);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const width = maxX - minX + pad * 2;
  const height = maxY - minY + pad * 2;
  const ox = -minX + pad; // 画布偏移：把像素坐标平移到正区间
  const oy = -minY + pad;

  const corners = hexCorners();
  const cornerStr = corners.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');

  // 地块多边形
  let cells = '';
  for (const h of hexes) {
    const p = hexToPixel(h);
    const cx = p.x + ox, cy = p.y + oy;
    const ownHere = ownVillageAt(h.q, h.r);
    const isCurrent = h.q === me.q && h.r === me.r;
    const t = tileAt(h.q, h.r);
    let cls = 'hex', inner = '', clickable = '';
    if (isCurrent) {
      cls += ' hex-self';
      inner = art(t?.icon ?? 'bld_main', '本城', 'sm');
    } else if (ownHere) {
      cls += ' hex-own';
      inner = art(t?.icon ?? 'bld_main', ownHere.name, 'sm');
      clickable = `data-tq="${h.q}" data-tr="${h.r}" data-kind="own_village" data-ref="${escapeAttr(ownHere.id)}" data-name="${escapeAttr(ownHere.name)}" data-icon="${escapeAttr(t?.icon ?? 'bld_main')}"`;
    } else if (t?.kind === 'village') {
      cls += ' hex-enemy';
      inner = art(t.icon ?? 'bld_main', t.name, 'sm');
      clickable = `data-tq="${h.q}" data-tr="${h.r}" data-kind="village" data-ref="${escapeAttr(t.refId)}" data-name="${escapeAttr(t.name)}" data-icon="${escapeAttr(t.icon ?? 'bld_main')}"`;
    } else if (t?.kind === 'pve') {
      cls += ' hex-pve';
      const picon = t.icon ?? pveIconByName(t.name);
      inner = art(picon, t.name, 'sm');
      clickable = `data-tq="${h.q}" data-tr="${h.r}" data-kind="pve" data-ref="${escapeAttr(t.refId)}" data-name="${escapeAttr(t.name)}" data-icon="${escapeAttr(picon)}"`;
    } else {
      // 空地块：可点选拓荒
      cls += ` hex-grass-${terrainVariant(h.q, h.r)}`;
      clickable = `data-tq="${h.q}" data-tr="${h.r}" data-kind="empty" data-ref="empty-${h.q},${h.r}" data-name="空地"`;
    }
    const sel = getSelected();
    const selCls = sel && sel.q === h.q && sel.r === h.r ? ' hex-selected' : '';
    // 用 <g> 承载多边形 + 图标，transform 定位
    cells += `<g class="hex-cell${selCls}" transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})" ${clickable} title="(${h.q},${h.r})">
        <polygon class="${cls}" points="${cornerStr}"></polygon>
        ${inner ? `<foreignObject x="-24" y="-24" width="48" height="48"><div class="hex-icon">${inner}</div></foreignObject>` : ''}
      </g>`;
  }

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

  const svg = `<svg class="map-svg" data-ox="${ox.toFixed(1)}" data-oy="${oy.toFixed(1)}" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" width="100%" preserveAspectRatio="xMidYMid meet">
      <g class="layer-hexes">${cells}</g>
      <g class="layer-paths">${paths}</g>
      <g class="layer-markers">${markers}</g>
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

  // 导航控件：方向键 + 坐标跳转
  const size = mapSize();
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
      <div class="map-jump-hint">地图范围 ±${size}，当前视野中心 X=${center.q} Y=${center.r}</div>
    </div>
  </div>`;

  const isViewing = center.q !== me.q || center.r !== me.r;
  const viewLabel = isViewing
    ? `正在查看 (X=${center.q}, Y=${center.r})，<a href="#" id="mapReturnHome">回到本城</a>`
    : `你在 X=${me.q}, Y=${me.r}，视野 ${R} 格`;

  return `<h3>周边地图 <small>（${viewLabel}）</small></h3>
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
  const dist = hexDistance({ q: selected.q, r: selected.r }, { q: me.q, r: me.r });

  if (selected.kind === 'empty') {
    return `<div class="target-panel target">
      <div class="target-head">${art('bld_main', '空地', 'md')}
        <div><div class="card-title">空地</div>
          <small class="coord">坐标 (${selected.q},${selected.r}) · 距离 ${dist} 格 · 可拓荒建村</small></div>
        <button class="target-close" id="closeTarget">✕</button>
      </div>
      <p class="muted">需主基地与人口规模达标，并备齐配置数量的拓荒者与开城资源。具体成本由服务器 GM 参数决定；失败不退开城包。</p>
      <div class="target-actions"><button class="btn-sm btn-raid" id="doFound">🚩 拓荒建村</button></div>
    </div>`;
  }

  if (selected.kind === 'own_village' || isOwnVillageId(selected.refId)) {
    const isCapital = !!me.villages?.find((v) => v.id === selected.refId)?.isCapital
      || selected.refId === me.capitalVillageId;
    const isCurrentVillage = selected.refId === me.villageId;
    if (isCurrentVillage) {
      return `<div class="target-panel target">
        <div class="target-head">${art(selected.icon ?? 'bld_main', selected.name, 'md')}
          <div><div class="card-title">${escapeHtml(selected.name)}${isCapital ? '（主城）' : ''}</div>
            <small class="coord">当前操作村庄 · (${selected.q},${selected.r}) · 距离 ${dist} 格</small></div>
          <button class="target-close" id="closeTarget">✕</button>
        </div>
        <p class="muted">当前已处于此村，没有可执行的转移或切换操作。</p>
      </div>`;
    }
    const myTroops = Object.entries(army?.troops || {}).filter(([, n]: any) => n > 0);
    const inputs = myTroops.length
      ? myTroops.map(([u, n]: any) => `<label class="raid-input">${art(unitArt(u), unitName(u), 'sm', unitArtFallback(u))}<span class="raid-name">${unitName(u)}</span><input type="number" min="0" max="${n}" value="0" id="raid-${u}" /><small>/${n}</small></label>`).join('')
      : '<small class="muted">无可用兵力</small>';
    const res = getCache().res?.resources ?? {};
    const cargoInputs = ['wood', 'clay', 'iron', 'crop'].map((t) =>
      `<label class="raid-input"><span class="raid-name">${t}</span><input type="number" min="0" max="${Math.floor(res[t] ?? 0)}" value="0" id="cargo-${t}" /><small>/${Math.floor(res[t] ?? 0)}</small></label>`).join('');
    return `<div class="target-panel target">
      <div class="target-head">${art(selected.icon ?? 'bld_main', selected.name, 'md')}
        <div><div class="card-title">${escapeHtml(selected.name)}${isCapital ? '（主城）' : ''}</div>
          <small class="coord">己方村庄 · (${selected.q},${selected.r}) · 距离 ${dist} 格</small></div>
        <button class="target-close" id="closeTarget">✕</button>
      </div>
      <div class="target-actions">
        <button class="btn-sm" id="doSwitchVillage">切换到此村</button>
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
   地图缩放/平移（移动端手势增强）
   - 单指：保留原生行为（点击选格 / 竖向滚动页面）
   - 双指：捏合缩放 + 拖拽平移，familiar 的地图手势，零冲突
   - 状态存模块级：每 5s 重渲后 bindMap 重新 applyMapTransform，缩放不丢失
   - D-pad / 跳转 / 回城会切换视野中心并重拉数据 → resetMapView() 归位
   ============================================================ */
const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;

function resetMapView(): void {
  mapZoom = 1;
  mapPanX = 0;
  mapPanY = 0;
}

function applyMapTransform(svg: SVGSVGElement): void {
  svg.style.transformOrigin = 'center center';
  svg.style.transform = `translate(${mapPanX.toFixed(1)}px, ${mapPanY.toFixed(1)}px) scale(${mapZoom.toFixed(3)})`;
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
    if (mapZoom <= ZOOM_MIN + 0.01) { mapPanX = 0; mapPanY = 0; } // 回到 1x 时归中，避免漂移
    applyMapTransform(svg);
  }, { passive: false });

  svg.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) startDist = 0;
  }, { passive: true });
}

/** 绑定地图页交互（选格 + 出征 + 启动行军动画 + 导航控件）。 */
export function bindMap(act: (p: Promise<any>) => void, navigate?: (center: { q: number; r: number }) => void): void {
  const svg = document.querySelector<SVGSVGElement>('.map-svg');
  if (svg) {
    const ox = Number(svg.dataset.ox || 0);
    const oy = Number(svg.dataset.oy || 0);
    startMarchAnimation(ox, oy);
    bindMapGestures(svg); // 手机双指缩放/平移（增强，不替代 D-pad）
    applyMapTransform(svg); // 跨 5s 重渲保留缩放态
  }

  document.querySelectorAll<SVGGElement>('.hex-cell[data-tq]').forEach((el) =>
    el.onclick = () => {
      setSelected({
        refId: el.dataset.ref || `empty-${el.dataset.tq},${el.dataset.tr}`,
        kind: el.dataset.kind!,
        q: Number(el.dataset.tq), r: Number(el.dataset.tr),
        name: el.dataset.name || '空地', icon: el.dataset.icon,
      });
      const panel = document.getElementById('targetPanel');
      if (panel) { panel.innerHTML = renderTargetPanel(); bindTargetEvents(act); }
      document.querySelectorAll('.hex-selected').forEach((t) => t.classList.remove('hex-selected'));
      el.classList.add('hex-selected');
    });
  bindTargetEvents(act);

  // 方向键
  const STEP = 4;
  const bindDir = (id: string, dir: string) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.onclick = () => {
      const d = SCREEN_DIRS[dir];
      const cur = viewCenter();
      const nq = cur.q + d.dq * STEP;
      const nr = cur.r + d.dr * STEP;
      if (!inBounds(nq, nr)) {
        addReport(`已到达地图边界，无法继续向${dirLabel(dir)}移动`);
        return;
      }
      setMapCenter({ q: nq, r: nr });
      resetMapView();
      navigate?.({ q: nq, r: nr });
    };
  };
  bindDir('mapDirUp', 'up');
  bindDir('mapDirDown', 'down');
  bindDir('mapDirLeft', 'left');
  bindDir('mapDirRight', 'right');

  // 回到本城（方向键盘中心的 ⌂）
  const homeBtn = document.getElementById('mapDirHome');
  if (homeBtn) homeBtn.onclick = () => { setMapCenter(null); resetMapView(); navigate?.({ q: me!.q, r: me!.r }); };

  // 标题行内联"回到本城"链接
  const retHome = document.getElementById('mapReturnHome');
  if (retHome) retHome.onclick = (e) => { e.preventDefault(); setMapCenter(null); resetMapView(); navigate?.({ q: me!.q, r: me!.r }); };

  // 坐标跳转（X=q, Y=r）
  const jumpGo = document.getElementById('mapJumpGo');
  if (jumpGo) jumpGo.onclick = () => {
    const xEl = document.getElementById('mapJumpX') as HTMLInputElement;
    const yEl = document.getElementById('mapJumpY') as HTMLInputElement;
    const q = parseInt(xEl.value, 10);
    const r = parseInt(yEl.value, 10);
    if (isNaN(q) || isNaN(r)) { addReport('请输入有效坐标'); return; }
    if (!inBounds(q, r)) { addReport(`坐标 (X=${q}, Y=${r}) 超出地图范围 ±${mapSize()}`); return; }
    setMapCenter({ q, r });
    resetMapView();
    navigate?.({ q, r });
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

/** 地图页：六边形网格 + 行军路径与实时部队位置 + 目标选中面板 + 出征。 */
import { art, unitArt } from '../../shared/ui/widgets.js';
import { secStr } from '../../shared/utils/format.js';
import { hexToPixel, hexCorners, lerpPixel, HEX_SIZE, type Hex } from '../../shared/utils/hex.js';
import { mapViewRadius, mapSize, pveInfoByType } from '../../app/config.js';
import { getCache, getSelected, setSelected, addReport, getMapCenter, setMapCenter } from '../../app/state.js';
import { unitName } from '../army/army.js';
import { req, me } from '../../api.js';

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
    const isSelf = h.q === me.q && h.r === me.r;
    const isCenter = !isSelf && h.q === center.q && h.r === center.r;
    const t = tileAt(h.q, h.r);
    let cls = 'hex', inner = '', clickable = '';
    if (isSelf) {
      cls += ' hex-self';
      inner = art('bld_main', '本城', 'sm');
    } else if (isCenter) {
      cls += ' hex-view-center';
    } else if (t?.kind === 'village') {
      cls += ' hex-enemy';
      inner = art('bld_main', t.name, 'sm');
      clickable = `data-tq="${h.q}" data-tr="${h.r}" data-kind="village" data-ref="${t.refId}" data-name="${t.name}"`;
    } else if (t?.kind === 'pve') {
      cls += ' hex-pve';
      const picon = t.icon ?? pveIconByName(t.name);
      inner = art(picon, t.name, 'sm');
      clickable = `data-tq="${h.q}" data-tr="${h.r}" data-kind="pve" data-ref="${t.refId}" data-name="${t.name}" data-icon="${picon}"`;
    }
    const sel = getSelected();
    const selCls = sel && sel.q === h.q && sel.r === h.r ? ' hex-selected' : '';
    // 用 <g> 承载多边形 + 图标，transform 定位
    cells += `<g class="hex-cell${selCls}" transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})" ${clickable} title="(${h.q},${h.r})">
        <polygon class="${cls}" points="${cornerStr}"></polygon>
        ${inner ? `<foreignObject x="-16" y="-16" width="32" height="32"><div class="hex-icon">${inner}</div></foreignObject>` : ''}
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
    const cls = m.type === 'return' ? 'march-path march-return' : 'march-path';
    paths += `<polyline class="${cls}" points="${pts}"></polyline>`;
  }

  // 部队标记（<use>/<g>，位置由动画每秒更新；初始放在 pos）
  let markers = '';
  moves.forEach((m: any, i: number) => {
    if (!m.pos) return;
    const p = hexToPixel(m.pos);
    const label = m.type === 'attack' ? '⚔️' : m.type === 'raid' ? '🏇' : '🏠';
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
    const kind = m.type === 'attack' ? '⚔️ 进攻' : m.type === 'raid' ? '🏇 掠夺' : '🏠 返程';
    const loot = m.loot ? ` · 战利品 ${Object.values(m.loot).reduce((a: any, b: any) => a + b, 0)}` : '';
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
  if (!selected) return '<div class="empty">点击地图上的目标，选择出征兵力。</div>';
  const army = getCache().army;
  const dist = hexDistance({ q: selected.q, r: selected.r }, { q: me!.q, r: me!.r });
  const myTroops = Object.entries(army?.troops || {}).filter(([, n]: any) => n > 0);
  const inputs = myTroops.length
    ? myTroops.map(([u, n]: any) => `<label class="raid-input">${art(unitArt(u), unitName(u), 'sm')}<input type="number" min="0" max="${n}" value="${n}" id="raid-${u}" /><small>/${n}</small></label>`).join('')
    : '<small class="muted">无可用兵力，先去军队页训练</small>';
  const isPve = selected.kind === 'pve';
  const action = isPve
    ? `<button class="btn-sm btn-raid" id="doRaid">🏇 掠夺</button>`
    : `<button class="btn-sm btn-attack" id="doAttack">⚔️ 进攻</button>`;
  const icon = isPve ? (selected.icon ?? pveIconByName(selected.name)) : 'bld_main';
  return `<div class="target-panel ${isPve ? 'target' : 'enemy'}">
    <div class="target-head">${art(icon, selected.name, 'md')}
      <div><div class="card-title">${selected.name}</div>
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
let animTimer: number | null = null;
function startMarchAnimation(ox: number, oy: number): void {
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

/** 绑定地图页交互（选格 + 出征 + 启动行军动画 + 导航控件）。 */
export function bindMap(act: (p: Promise<any>) => void, navigate?: (center: { q: number; r: number }) => void): void {
  const svg = document.querySelector<SVGSVGElement>('.map-svg');
  if (svg) {
    const ox = Number(svg.dataset.ox || 0);
    const oy = Number(svg.dataset.oy || 0);
    startMarchAnimation(ox, oy);
  }

  document.querySelectorAll<SVGGElement>('.hex-cell[data-ref]').forEach((el) =>
    el.onclick = () => {
      setSelected({
        refId: el.dataset.ref!, kind: el.dataset.kind!,
        q: Number(el.dataset.tq), r: Number(el.dataset.tr),
        name: el.dataset.name!, icon: el.dataset.icon,
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
      navigate?.({ q: nq, r: nr });
    };
  };
  bindDir('mapDirUp', 'up');
  bindDir('mapDirDown', 'down');
  bindDir('mapDirLeft', 'left');
  bindDir('mapDirRight', 'right');

  // 回到本城（方向键盘中心的 ⌂）
  const homeBtn = document.getElementById('mapDirHome');
  if (homeBtn) homeBtn.onclick = () => { setMapCenter(null); navigate?.({ q: me!.q, r: me!.r }); };

  // 标题行内联"回到本城"链接
  const retHome = document.getElementById('mapReturnHome');
  if (retHome) retHome.onclick = (e) => { e.preventDefault(); setMapCenter(null); navigate?.({ q: me!.q, r: me!.r }); };

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
    act(req('SendRaid', { fromXY: { q: me!.q, r: me!.r }, targetId: getSelected()!.refId, troops }));
  };
  const atk = document.getElementById('doAttack');
  if (atk) atk.onclick = () => {
    const troops = collectTroops();
    if (!Object.keys(troops).length) { addReport('请先设置出征兵力'); return; }
    const sel = getSelected()!;
    act(req('SendAttack', { fromXY: { q: me!.q, r: me!.r }, targetVillage: sel.refId, toXY: { q: sel.q, r: sel.r }, troops }));
  };
}

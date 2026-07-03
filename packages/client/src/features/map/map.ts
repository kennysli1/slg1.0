/** 地图页：六边形网格 + 行军路径与实时部队位置 + 目标选中面板 + 出征。 */
import { art, unitArt } from '../../shared/ui/widgets.js';
import { secStr } from '../../shared/utils/format.js';
import { hexToPixel, hexCorners, lerpPixel, HEX_SIZE, type Hex } from '../../shared/utils/hex.js';
import { mapViewRadius, pveInfoByType } from '../../app/config.js';
import { getCache, getSelected, setSelected, addReport } from '../../app/state.js';
import { unitName } from '../army/army.js';
import { req, me } from '../../api.js';

function hexDistance(a: { q: number; r: number }, b: { q: number; r: number }): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

function tileAt(q: number, r: number): any {
  return (getCache().area?.tiles || []).find((t: any) => t.q === q && t.r === r);
}

/** 地图 tile 仅有展示名时，按关键字猜测 PvE 图标（回退用）。 */
function pveIconByName(name?: string): string {
  const type = name?.includes('鼠') ? 'rats' : name?.includes('狼') ? 'wolves' : 'bandits';
  return pveInfoByType(type)?.icon ?? 'pve_bandits';
}

/** 收集视野内所有格坐标（六边形半径 R）。 */
function viewHexes(R: number): Hex[] {
  const out: Hex[] = [];
  for (let dq = -R; dq <= R; dq++) {
    for (let dr = Math.max(-R, -dq - R); dr <= Math.min(R, -dq + R); dr++) {
      out.push({ q: me!.q + dq, r: me!.r + dr });
    }
  }
  return out;
}

export function renderMap(): string {
  const area = getCache().area;
  if (!area || !me) return '<div class="loading">加载中…</div>';
  const R = mapViewRadius();
  const selected = getSelected();
  if (selected && !tileAt(selected.q, selected.r)) setSelected(null);

  const hexes = viewHexes(R);
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
    const t = tileAt(h.q, h.r);
    let cls = 'hex', inner = '', clickable = '';
    if (isSelf) {
      cls += ' hex-self';
      inner = art('bld_main', '本城', 'sm');
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

  return `<h3>周边地图 <small>（你在 ${me.q},${me.r}，视野 ${R} 格）</small></h3>
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

/** 绑定地图页交互（选格 + 出征 + 启动行军动画）。 */
export function bindMap(act: (p: Promise<any>) => void): void {
  const svg = document.querySelector<SVGSVGElement>('.map-svg');
  // 画布偏移由渲染时决定；这里从 marker 初始 transform 反推不可靠，改为动画内直接用 hexToPixel + 统一偏移。
  // 偏移已内嵌进 marker/path 的绝对坐标，动画需同一 ox/oy —— 用 data 属性传递。
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

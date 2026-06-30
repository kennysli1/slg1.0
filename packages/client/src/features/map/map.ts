/** 地图页：周边网格 + 目标选中面板 + 出征。 */
import { art, unitArt } from '../../shared/ui/widgets.js';
import { secStr } from '../../shared/utils/format.js';
import { mapViewRadius, pveInfoByType } from '../../app/config.js';
import { getCache, getSelected, setSelected, addReport } from '../../app/state.js';
import { unitName } from '../army/army.js';
import { req, me } from '../../api.js';

function tileAt(x: number, y: number): any {
  return (getCache().area?.tiles || []).find((t: any) => t.x === x && t.y === y);
}
/** 地图 tile 仅有展示名时，按关键字猜测 PvE 图标（回退用）。 */
function pveIconByName(name?: string): string {
  const type = name?.includes('鼠') ? 'rats' : name?.includes('狼') ? 'wolves' : 'bandits';
  return pveInfoByType(type)?.icon ?? 'pve_bandits';
}

export function renderMap(): string {
  const area = getCache().area;
  if (!area || !me) return '<div class="loading">加载中…</div>';
  const R = mapViewRadius();
  const selected = getSelected();
  if (selected && !tileAt(selected.x, selected.y)) setSelected(null);

  let cells = '';
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const x = me.x + dx, y = me.y + dy;
      const isSelf = dx === 0 && dy === 0;
      const t = tileAt(x, y);
      let cls = 'tile', inner = '', clickable = '';
      if (isSelf) {
        cls += ' tile-self';
        inner = art('bld_main', '本城', 'sm');
      } else if (t?.kind === 'village') {
        cls += ' tile-enemy';
        inner = art('bld_main', t.name, 'sm');
        clickable = `data-tx="${x}" data-ty="${y}" data-kind="village" data-ref="${t.refId}" data-name="${t.name}"`;
      } else if (t?.kind === 'pve') {
        cls += ' tile-pve';
        const picon = t.icon ?? pveIconByName(t.name);
        inner = art(picon, t.name, 'sm');
        clickable = `data-tx="${x}" data-ty="${y}" data-kind="pve" data-ref="${t.refId}" data-name="${t.name}" data-icon="${picon}"`;
      }
      const sel = getSelected();
      if (sel && sel.x === x && sel.y === y) cls += ' tile-selected';
      cells += `<div class="${cls}" ${clickable} title="(${x},${y})${t?.name ? ' ' + t.name : ''}">${inner}</div>`;
    }
  }

  const moves = (getCache().moves?.movements || []).map((m: any) => {
    const kind = m.type === 'attack' ? '⚔️ 进攻' : m.type === 'raid' ? '🏇 掠夺' : '🏠 返程';
    const loot = m.loot ? ` · 战利品 ${Object.values(m.loot).reduce((a: any, b: any) => a + b, 0)}` : '';
    return `<div class="banner banner-move">${kind} → (${m.toXY.x},${m.toXY.y}) 抵达 <b>${secStr(m.arriveAt)}</b>${loot}</div>`;
  }).join('');

  return `<h3>周边地图 <small>（你在 ${me.x},${me.y}，视野 ${R} 格）</small></h3>
    <div class="map-wrap">
      <div class="map-grid" style="grid-template-columns:repeat(${R * 2 + 1},1fr)">${cells}</div>
      <div class="map-legend">
        <span><i class="dot dot-self"></i>本城</span>
        <span><i class="dot dot-enemy"></i>玩家村(可进攻)</span>
        <span><i class="dot dot-pve"></i>野怪(可掠夺)</span>
      </div>
    </div>
    <div id="targetPanel">${renderTargetPanel()}</div>
    <h3>行军中</h3>${moves || '<small class="muted">无</small>'}`;
}

function renderTargetPanel(): string {
  const selected = getSelected();
  if (!selected) return '<div class="empty">点击地图上的目标，选择出征兵力。</div>';
  const army = getCache().army;
  const dist = Math.hypot(selected.x - me!.x, selected.y - me!.y).toFixed(1);
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
        <small class="coord">坐标 (${selected.x},${selected.y}) · 距离 ${dist} 格 · ${isPve ? '野怪据点' : '玩家村庄'}</small></div>
      <button class="target-close" id="closeTarget">✕</button>
    </div>
    <div class="raidbox-title">出征兵力</div>
    <div class="raid-inputs">${inputs}</div>
    ${myTroops.length ? `<div class="target-actions">${action}</div>` : ''}
  </div>`;
}

function collectTroops(): Record<string, number> {
  const troops: Record<string, number> = {};
  Object.keys(getCache().army?.troops || {}).forEach((u) => {
    const el = document.getElementById(`raid-${u}`) as HTMLInputElement;
    if (el && Number(el.value) > 0) troops[u] = Number(el.value);
  });
  return troops;
}

/** 绑定地图页交互（选格 + 出征）。 */
export function bindMap(act: (p: Promise<any>) => void): void {
  document.querySelectorAll<HTMLElement>('.tile[data-ref]').forEach((el) =>
    el.onclick = () => {
      setSelected({ refId: el.dataset.ref!, kind: el.dataset.kind!, x: Number(el.dataset.tx), y: Number(el.dataset.ty), name: el.dataset.name!, icon: el.dataset.icon });
      const panel = document.getElementById('targetPanel');
      if (panel) { panel.innerHTML = renderTargetPanel(); bindTargetEvents(act); }
      document.querySelectorAll('.tile-selected').forEach((t) => t.classList.remove('tile-selected'));
      el.classList.add('tile-selected');
    });
  bindTargetEvents(act);
}

function bindTargetEvents(act: (p: Promise<any>) => void) {
  const close = document.getElementById('closeTarget');
  if (close) close.onclick = () => {
    setSelected(null);
    const p = document.getElementById('targetPanel');
    if (p) p.innerHTML = renderTargetPanel();
    document.querySelectorAll('.tile-selected').forEach((t) => t.classList.remove('tile-selected'));
  };
  const raid = document.getElementById('doRaid');
  if (raid) raid.onclick = () => {
    const troops = collectTroops();
    if (!Object.keys(troops).length) { addReport('请先设置出征兵力'); return; }
    act(req('SendRaid', { fromXY: { x: me!.x, y: me!.y }, targetId: getSelected()!.refId, troops }));
  };
  const atk = document.getElementById('doAttack');
  if (atk) atk.onclick = () => {
    const troops = collectTroops();
    if (!Object.keys(troops).length) { addReport('请先设置出征兵力'); return; }
    const sel = getSelected()!;
    act(req('SendAttack', { fromXY: { x: me!.x, y: me!.y }, targetVillage: sel.refId, toXY: { x: sel.x, y: sel.y }, troops }));
  };
}

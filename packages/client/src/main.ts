import './style.css';
import { connect, req, login, register, onPush, me } from './api.js';
import { RES_INFO, FIELD_INFO, BUILDING_INFO, UNIT_INFO, PVE_INFO } from './info.js';

/**
 * 文字版 Travian 前端（多人版）：登录 → 村庄/军队/地图/报告。
 * 地图：以玩家为中心的坐标网格，点击目标选中后在面板派兵。
 * 图标用美术占位图，统一走 art() 渲染（吃**基名**，由 artPath 拼成 /art/<基名>.png），加载失败回退文字。
 */

let cache: any = {};
const reports: string[] = [];
let currentTab = 'village';
let connected = false;
const MAP_R = 6; // 地图视野半径（格），渲染 (2R+1)² 网格
let selected: { refId: string; kind: string; x: number; y: number; name: string; icon?: string } | null = null;

const fmt = (n: number) => Math.floor(n).toLocaleString();
const secStr = (ms: number) => {
  const s = Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`;
};
const RES_KEYS = ['wood', 'clay', 'iron', 'crop'] as const;

/** 美术资源根路径；图标列只存基名，渲染时拼 ART_BASE + 基名 + .png。 */
const ART_BASE = '/art/';
const artPath = (base: string) => `${ART_BASE}${base}.png`;

/** 统一图标渲染：传图标**基名**，输出 <img>，加载失败回退为文字徽标。size: xs|sm|md|lg */
function art(icon: string, label: string, size: 'xs' | 'sm' | 'md' | 'lg' = 'md'): string {
  const safe = label.replace(/'/g, '');
  const src = artPath(icon);
  return `<img class="icon icon-${size}" src="${src}" alt="${safe}" title="${safe}" loading="lazy"
    onerror="this.outerHTML='<span class=\\'icon icon-${size} icon-fallback\\'>${safe}</span>'" />`;
}
/** 兵种图标基名：服务器若下发 icon 基名优先用，否则按 code 约定拼 unit_<code>。 */
const unitArt = (code: string) => `unit_${code}`;

/** 是否买得起。 */
function canAfford(cost: Record<string, number> | null): boolean {
  if (!cost) return false;
  const have = cache.res?.resources;
  if (!have) return false;
  return RES_KEYS.every((r) => (have[r] ?? 0) >= (cost[r] ?? 0));
}
/** 消耗预览：带资源图标，买不起的项标红。 */
function costPreview(cost: Record<string, number> | null, timeSec?: number | null): string {
  if (!cost) return '';
  const have = cache.res?.resources ?? {};
  const items = RES_KEYS.filter((r) => (cost[r] ?? 0) > 0).map((r) => {
    const lack = (have[r] ?? 0) < (cost[r] ?? 0);
    return `<span class="cost-item${lack ? ' cost-lack' : ''}">${art(RES_INFO[r].icon, RES_INFO[r].name, 'xs')}${fmt(cost[r])}</span>`;
  }).join('');
  const time = timeSec ? `<span class="cost-time">⏱ ${secStr(Date.now() + timeSec * 1000)}</span>` : '';
  return `<div class="cost">${items}${time}</div>`;
}
/** 训练数量变化时，按总价重算某兵种卡片的消耗预览与按钮可用性。 */
function updateTrainCost(unitKey: string) {
  const u = (cache.army?.trainable || []).find((x: any) => x.key === unitKey);
  if (!u) return;
  const inp = document.getElementById(`cnt-${unitKey}`) as HTMLInputElement;
  const cnt = Math.max(1, Math.floor(Number(inp?.value) || 1));
  const total: Record<string, number> = {};
  for (const r of RES_KEYS) total[r] = (u.cost[r] ?? 0) * cnt;
  const slot = document.getElementById(`cost-${unitKey}`);
  if (slot) slot.innerHTML = costPreview(total, u.trainSec * cnt);
  const btn = document.getElementById(`btn-${unitKey}`) as HTMLButtonElement;
  if (btn && !cache.army?.training) btn.disabled = !canAfford(total);
}
/** 进度条 HTML（用 data 属性记录起止，由计时器更新宽度与剩余文字）。 */
function progressBar(startAt: number, finishAt: number, label: string): string {
  const pct = Math.min(100, Math.max(0, ((Date.now() - startAt) / (finishAt - startAt)) * 100));
  return `<div class="progress" data-start="${startAt}" data-finish="${finishAt}">
    <i class="progress-fill" style="width:${pct}%"></i>
    <span class="progress-label">${label} · 剩 <b class="progress-time">${secStr(finishAt)}</b></span></div>`;
}

const app = document.getElementById('app')!;

const TRIBES = [
  { key: 'romans', name: '罗马', desc: '均衡全能，后期强力' },
  { key: 'gauls', name: '高卢', desc: '防守与速度见长' },
  { key: 'teutons', name: '条顿', desc: '便宜量大，掠夺凶猛' },
];
const ERR_MSG: Record<string, string> = {
  name_taken: '该名字已被注册',
  no_such_user: '用户不存在',
  wrong_password: '密码错误',
  password_too_short: '密码至少4位',
  empty_name: '请输入名字',
  name_too_long: '名字太长(≤16)',
  queue_busy: '已有建造/训练在进行，请等当前完成',
  requires_not_met: '前置建筑不满足，尚未解锁',
  max_level: '已达最高等级',
  spend_failed: '资源不足',
  bad_count: '数量不合法',
  bad_field: '资源田不存在',
  wrong_tribe_unit: '该兵种不属于你的部族',
  no_troops: '没有可派出的兵力',
  target_not_found: '目标不存在或已消失',
  cannot_attack_self: '不能攻击自己的村庄',
  village_not_found: '村庄不存在',
};
/** 把服务器错误码翻译成中文，处理带后缀的码（insufficient:wood、insufficient_troops:xx）。 */
function errText(code?: string): string {
  if (!code) return '操作失败';
  if (ERR_MSG[code]) return ERR_MSG[code];
  if (code.startsWith('insufficient_troops')) return '兵力不足';
  if (code.startsWith('insufficient:')) {
    const r = code.split(':')[1];
    return `${RES_INFO[r]?.name ?? r}不足`;
  }
  if (code.startsWith('unknown_')) return '目标不存在';
  return code;
}

let loginMode: 'login' | 'register' = 'register';
let pickedTribe = 'romans';

// ---------- 登录界面 ----------
function renderLogin(msg = '') {
  const tribeBtns = TRIBES.map((t) =>
    `<button class="tribe ${pickedTribe === t.key ? 'picked' : ''}" data-tribe="${t.key}">
      <b>${t.name}</b><small>${t.desc}</small></button>`).join('');
  app.innerHTML = `
    <div class="login">
      <div class="login-logo">${art('ui_logo', 'Travian 2.0', 'lg')}</div>
      <h1>Travian 2.0</h1>
      <p class="login-sub">罗马·高卢·条顿 — 在同一张地图上称雄</p>
      <div class="logintabs">
        <button class="${loginMode === 'register' ? 'on' : ''}" id="toReg">注册</button>
        <button class="${loginMode === 'login' ? 'on' : ''}" id="toLogin">登录</button>
      </div>
      <input id="name" placeholder="用户名（≤16字）" maxlength="16" />
      <input id="pwd" type="password" placeholder="密码（≥4位）" />
      ${loginMode === 'register' ? `<div class="field-label">选择部族</div><div class="tribes">${tribeBtns}</div>` : ''}
      <button id="goBtn" class="btn-primary">${loginMode === 'register' ? '注册并进入' : '登录'}</button>
      <div class="loginmsg">${msg}</div>
    </div>`;

  document.getElementById('toReg')!.onclick = () => { loginMode = 'register'; renderLogin(); };
  document.getElementById('toLogin')!.onclick = () => { loginMode = 'login'; renderLogin(); };
  document.querySelectorAll<HTMLButtonElement>('[data-tribe]').forEach((b) =>
    b.onclick = () => { pickedTribe = b.dataset.tribe!; renderLogin(); });

  const go = async () => {
    const name = (document.getElementById('name') as HTMLInputElement).value.trim();
    const pwd = (document.getElementById('pwd') as HTMLInputElement).value;
    if (!name || !pwd) return renderLogin('请输入用户名和密码');
    const res = loginMode === 'register' ? await register(name, pwd, pickedTribe) : await login(name, pwd);
    if (res.ok) startGame();
    else renderLogin(errText(res.error));
  };
  document.getElementById('goBtn')!.onclick = go;
  document.getElementById('pwd')!.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') go(); });
}

// ---------- 游戏主界面 ----------
const TABS = [
  { key: 'village', name: '村庄', icon: 'ui_tab_village' },
  { key: 'army', name: '军队', icon: 'ui_tab_army' },
  { key: 'map', name: '地图', icon: 'ui_tab_map' },
  { key: 'reports', name: '报告', icon: 'ui_tab_reports' },
];

function renderShell() {
  const tabBtns = TABS.map((t) =>
    `<button data-tab="${t.key}">${art(t.icon, t.name, 'sm')}<span>${t.name}</span></button>`).join('');
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">${art('ui_logo', 'LOGO', 'md')}
        <div class="brand-text">
          <div class="title">Travian 2.0</div>
          <div class="subtitle">${me?.name ?? ''} 的村庄 · 坐标 (${me?.x},${me?.y})</div>
        </div>
      </div>
      <div id="resbar" class="resbar"></div>
    </header>
    <nav class="tabs">${tabBtns}</nav>
    <main id="page" class="page"></main>`;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => {
    b.onclick = () => { currentTab = b.dataset.tab!; renderPage(); };
  });
}

async function refreshAll() {
  if (!me) return;
  const [res, vil, army, area, moves] = await Promise.all([
    req('GetResources'), req('GetVillage'), req('GetArmy'),
    req('GetArea', { cx: me.x, cy: me.y, r: 25 }), req('ListMovements'),
  ]);
  cache = { res: res.payload, vil: vil.payload, army: army.payload, area: area.payload, moves: moves.payload };
  renderResBar();
  renderPage();
}

function renderResBar() {
  const r = cache.res;
  if (!r) return;
  const cells = RES_KEYS.map((t) => {
    const rate = r.netRate[t] * 3600;
    const low = t === 'crop' && rate < 0 ? ' res-low' : '';
    const pct = Math.min(100, (r.resources[t] / r.capacity[t]) * 100);
    return `<span class="res${low}">${art(RES_INFO[t].icon, RES_INFO[t].name, 'sm')}
      <span class="res-num">${fmt(r.resources[t])}<small>/${fmt(r.capacity[t])}</small></span>
      <span class="res-rate">${rate >= 0 ? '+' : ''}${rate.toFixed(0)}/h</span>
      <span class="res-bar"><i style="width:${pct}%"></i></span></span>`;
  }).join('');
  const rb = document.getElementById('resbar');
  if (rb) rb.innerHTML = cells +
    `<span class="res res-upkeep"><span class="res-num">耗粮 ${fmt(r.cropUpkeep)}/h</span></span>`;
}

function renderPage() {
  const page = document.getElementById('page');
  if (!page) return;
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.classList.toggle('active', (b as HTMLButtonElement).dataset.tab === currentTab));
  if (currentTab === 'village') page.innerHTML = renderVillage();
  else if (currentTab === 'army') page.innerHTML = renderArmy();
  else if (currentTab === 'map') page.innerHTML = renderMap();
  else page.innerHTML = renderReports();
  bindPageEvents();
  syncTimers();
}

function renderVillage(): string {
  const vil = cache.vil;
  if (!vil) return '<div class="loading">加载中…</div>';
  const q = vil.queue;
  const banner = q
    ? `<div class="banner banner-build">🔨 建造中：<b>${FIELD_INFO[q.target]?.name ?? BUILDING_INFO[q.target]?.name ?? q.target}</b> → ${q.toLevel} 级
        ${progressBar(q.startAt, q.finishAt, '建造')}</div>`
    : '';

  const fields = vil.fields.map((f: any, i: number) => {
    const max = f.level >= f.maxLevel;
    const afford = canAfford(f.nextCost);
    const fname = f.name ?? FIELD_INFO[f.type]?.name ?? f.type;
    const ficon = f.icon ?? FIELD_INFO[f.type]?.icon ?? 'field_woodcutter';
    const btn = max ? '<small class="tag">已满级</small>'
      : `<button class="btn-sm" data-field="${i}" ${q || !afford ? 'disabled' : ''}>升级</button>`;
    return `<div class="card">${art(ficon, fname, 'md')}
      <div class="cardbody"><div class="card-title">${fname} <b class="lv">Lv${f.level}</b></div>
        ${max ? '' : costPreview(f.nextCost, f.nextTimeSec)}${btn}</div></div>`;
  }).join('');

  const blds = Object.entries(vil.defs).map(([kind, d]: any) => {
    const max = d.level >= d.maxLevel;
    const afford = canAfford(d.nextCost);
    let btn: string;
    let reqHint = '';
    if (max) btn = '<small class="tag">已满级</small>';
    else if (!d.unlocked) {
      btn = '<small class="tag tag-lock">未解锁</small>';
      const reqs = (d.requires || []).map((r: any) => `${BUILDING_INFO[r.kind]?.name ?? r.kind} Lv${r.level}`).join('、');
      if (reqs) reqHint = `<div class="req-hint">需先建：${reqs}</div>`;
    } else btn = `<button class="btn-sm" data-bld="${kind}" ${q || !afford ? 'disabled' : ''}>升级</button>`;
    return `<div class="card ${d.unlocked ? '' : 'locked'}">${art(d.icon ?? BUILDING_INFO[kind]?.icon ?? 'bld_main', d.name, 'md')}
      <div class="cardbody"><div class="card-title">${d.name} <b class="lv">Lv${d.level}</b></div>
        ${max || !d.unlocked ? reqHint : costPreview(d.nextCost, d.nextTimeSec)}${btn}</div></div>`;
  }).join('');

  return `${banner}
    <h3>资源田 <small>（18）</small></h3><div class="grid">${fields}</div>
    <h3>中心建筑</h3><div class="grid">${blds}</div>`;
}

function unitName(key: string): string {
  const t = (cache.army?.trainable || []).find((u: any) => u.key === key);
  return t?.name ?? UNIT_INFO[key]?.name ?? key;
}
function unitTrainSec(key: string): number {
  return (cache.army?.trainable || []).find((u: any) => u.key === key)?.trainSec ?? 30;
}

function renderArmy(): string {
  const army = cache.army;
  if (!army) return '<div class="loading">加载中…</div>';
  const troops = Object.entries(army.troops || {});
  const troopList = troops.length
    ? troops.map(([u, n]: any) => `<span class="troop">${art(unitArt(u), unitName(u), 'sm')}<span>${unitName(u)} <b>×${n}</b></span></span>`).join('')
    : '<small class="muted">暂无驻军</small>';
  const tr = army.training;
  const training = tr
    ? `<div class="banner banner-train">🎯 训练中：<b>${unitName(tr.unit)}</b> ×${tr.remaining}
        ${progressBar(tr.nextDoneAt - unitTrainSec(tr.unit) * 1000, tr.nextDoneAt, '下一个')}</div>` : '';
  const trainCards = (army.trainable || []).map((u: any) => {
    return `<div class="card">${art(unitArt(u.key), u.name, 'md')}
      <div class="cardbody"><div class="card-title">${u.name} <small class="tag">${catName(u.cat)}</small></div>
        <div class="cost-slot" id="cost-${u.key}">${costPreview(u.cost, u.trainSec)}</div>
        <div class="train-row"><input type="number" min="1" value="1" id="cnt-${u.key}" data-unit="${u.key}" />
          <button class="btn-sm" id="btn-${u.key}" data-train="${u.key}" ${army.training ? 'disabled' : ''}>训练</button></div></div></div>`;
  }).join('');
  return `<h3>驻军 <small>（${tribeName(army.tribe)}族）</small></h3><div class="troopbar">${troopList}</div>${training}
    <h3>训练</h3><div class="grid">${trainCards}</div>`;
}

function catName(c: string): string {
  return { infantry: '步兵', cavalry: '骑兵', scout: '侦察', siege: '攻城', admin: '行政', settler: '拓荒' }[c] ?? c;
}
function tribeName(t: string): string {
  return { romans: '罗马', gauls: '高卢', teutons: '条顿' }[t] ?? t;
}

// ---------- 地图 ----------
function tileAt(x: number, y: number): any {
  return (cache.area?.tiles || []).find((t: any) => t.x === x && t.y === y);
}
function pveType(name?: string): string {
  return name?.includes('鼠') ? 'rats' : name?.includes('狼') ? 'wolves' : 'bandits';
}

function renderMap(): string {
  const area = cache.area;
  if (!area || !me) return '<div class="loading">加载中…</div>';
  // 若选中目标已不在视野（被打掉/刷新），清除
  if (selected && !tileAt(selected.x, selected.y)) selected = null;

  let cells = '';
  for (let dy = -MAP_R; dy <= MAP_R; dy++) {
    for (let dx = -MAP_R; dx <= MAP_R; dx++) {
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
        const picon = t.icon ?? PVE_INFO[pveType(t.name)]?.icon ?? 'pve_bandits';
        inner = art(picon, t.name, 'sm');
        clickable = `data-tx="${x}" data-ty="${y}" data-kind="pve" data-ref="${t.refId}" data-name="${t.name}" data-icon="${picon}"`;
      }
      if (selected && selected.x === x && selected.y === y) cls += ' tile-selected';
      cells += `<div class="${cls}" ${clickable} title="(${x},${y})${t?.name ? ' ' + t.name : ''}">${inner}</div>`;
    }
  }

  const moves = (cache.moves?.movements || []).map((m: any) => {
    const kind = m.type === 'attack' ? '⚔️ 进攻' : m.type === 'raid' ? '🏇 掠夺' : '🏠 返程';
    const loot = m.loot ? ` · 战利品 ${Object.values(m.loot).reduce((a: any, b: any) => a + b, 0)}` : '';
    return `<div class="banner banner-move">${kind} → (${m.toXY.x},${m.toXY.y}) 抵达 <b>${secStr(m.arriveAt)}</b>${loot}</div>`;
  }).join('');

  return `<h3>周边地图 <small>（你在 ${me.x},${me.y}，视野 ${MAP_R} 格）</small></h3>
    <div class="map-wrap">
      <div class="map-grid" style="grid-template-columns:repeat(${MAP_R * 2 + 1},1fr)">${cells}</div>
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
  if (!selected) return '<div class="empty">点击地图上的目标，选择出征兵力。</div>';
  const army = cache.army;
  const dist = Math.hypot(selected.x - me!.x, selected.y - me!.y).toFixed(1);
  const myTroops = Object.entries(army?.troops || {}).filter(([, n]: any) => n > 0);
  const inputs = myTroops.length
    ? myTroops.map(([u, n]: any) => `<label class="raid-input">${art(unitArt(u), unitName(u), 'sm')}<input type="number" min="0" max="${n}" value="${n}" id="raid-${u}" /><small>/${n}</small></label>`).join('')
    : '<small class="muted">无可用兵力，先去军队页训练</small>';
  const isPve = selected.kind === 'pve';
  const action = isPve
    ? `<button class="btn-sm btn-raid" id="doRaid">🏇 掠夺</button>`
    : `<button class="btn-sm btn-attack" id="doAttack">⚔️ 进攻</button>`;
  const icon = isPve ? (selected.icon ?? PVE_INFO[pveType(selected.name)]?.icon ?? 'pve_bandits') : 'bld_main';
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

function renderReports(): string {
  if (!reports.length) return '<div class="empty">暂无战报。去地图掠夺野怪或进攻其他玩家！</div>';
  return reports.map((r) => `<div class="report">${r}</div>`).join('');
}

function collectTroops(): Record<string, number> {
  const troops: Record<string, number> = {};
  Object.keys(cache.army?.troops || {}).forEach((u) => {
    const el = document.getElementById(`raid-${u}`) as HTMLInputElement;
    if (el && Number(el.value) > 0) troops[u] = Number(el.value);
  });
  return troops;
}

function bindPageEvents() {
  document.querySelectorAll<HTMLButtonElement>('[data-field]').forEach((b) =>
    b.onclick = () => act(req('UpgradeField', { fieldIndex: Number(b.dataset.field) })));
  document.querySelectorAll<HTMLButtonElement>('[data-bld]').forEach((b) =>
    b.onclick = () => act(req('UpgradeBuilding', { kind: b.dataset.bld })));
  document.querySelectorAll<HTMLButtonElement>('[data-train]').forEach((b) =>
    b.onclick = () => {
      const u = b.dataset.train!;
      const cnt = Number((document.getElementById(`cnt-${u}`) as HTMLInputElement)?.value || 1);
      act(req('TrainTroops', { unit: u, count: cnt }));
    });
  // 训练数量框：实时重算消耗预览 + 按钮可用性（按选定数量算总价）
  document.querySelectorAll<HTMLInputElement>('input[data-unit]').forEach((inp) => {
    inp.oninput = () => updateTrainCost(inp.dataset.unit!);
    updateTrainCost(inp.dataset.unit!); // 初次渲染按当前值校正
  });

  // 地图：点击目标地块 → 选中
  document.querySelectorAll<HTMLElement>('.tile[data-ref]').forEach((el) =>
    el.onclick = () => {
      selected = { refId: el.dataset.ref!, kind: el.dataset.kind!, x: Number(el.dataset.tx), y: Number(el.dataset.ty), name: el.dataset.name!, icon: el.dataset.icon };
      const panel = document.getElementById('targetPanel');
      if (panel) { panel.innerHTML = renderTargetPanel(); bindTargetEvents(); }
      document.querySelectorAll('.tile-selected').forEach((t) => t.classList.remove('tile-selected'));
      el.classList.add('tile-selected');
    });
  bindTargetEvents();
}

function bindTargetEvents() {
  const close = document.getElementById('closeTarget');
  if (close) close.onclick = () => { selected = null; const p = document.getElementById('targetPanel'); if (p) p.innerHTML = renderTargetPanel(); document.querySelectorAll('.tile-selected').forEach((t) => t.classList.remove('tile-selected')); };
  const raid = document.getElementById('doRaid');
  if (raid) raid.onclick = () => {
    const troops = collectTroops();
    if (!Object.keys(troops).length) { addReport('请先设置出征兵力'); return; }
    act(req('SendRaid', { fromXY: { x: me!.x, y: me!.y }, targetId: selected!.refId, troops }));
  };
  const atk = document.getElementById('doAttack');
  if (atk) atk.onclick = () => {
    const troops = collectTroops();
    if (!Object.keys(troops).length) { addReport('请先设置出征兵力'); return; }
    act(req('SendAttack', { fromXY: { x: me!.x, y: me!.y }, targetVillage: selected!.refId, toXY: { x: selected!.x, y: selected!.y }, troops }));
  };
}

async function act(p: Promise<any>) {
  const res = await p;
  if (!res.ok) addReport(`操作失败：${errText(res.error?.code)}`);
  await refreshAll();
}

function addReport(line: string) {
  reports.unshift(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (reports.length > 60) reports.pop();
}

/** 刷新所有进度条的宽度与剩余时间文字（每秒调用）。 */
function syncTimers() {
  document.querySelectorAll<HTMLElement>('.progress').forEach((el) => {
    const start = Number(el.dataset.start), finish = Number(el.dataset.finish);
    const pct = Math.min(100, Math.max(0, ((Date.now() - start) / (finish - start)) * 100));
    const fill = el.querySelector<HTMLElement>('.progress-fill');
    const time = el.querySelector<HTMLElement>('.progress-time');
    if (fill) fill.style.width = `${pct}%`;
    if (time) time.textContent = secStr(finish);
  });
}

// ---------- 推送 ----------
onPush((event, payload) => {
  if (event === 'BuildingUpgraded') addReport(`✅ 建造完成：${FIELD_INFO[payload.kind]?.name ?? BUILDING_INFO[payload.kind]?.name ?? payload.kind} → ${payload.level}级`);
  else if (event === 'TroopTrained') addReport(`🎯 训练出 ${unitName(payload.unit)}（共${payload.total}）`);
  else if (event === 'MarchSent') addReport(`🏃 出征已派出`);
  else if (event === 'RaidResolved') {
    const win = payload.attackerWins ? '🎉 胜利' : '💀 失败';
    const loot = Object.entries(payload.looted || {}).map(([t, n]: any) => `${RES_INFO[t]?.name}${n}`).join(' ');
    addReport(`掠夺${win}！攻${payload.attackPower} vs 防${payload.defensePower}｜战利品：${loot || '无'}`);
  } else if (event === 'AttackResolved') {
    const win = payload.attackerWins ? '攻方胜' : '守方胜';
    const loot = Object.entries(payload.looted || {}).map(([t, n]: any) => `${RES_INFO[t]?.name}${n}`).join(' ');
    if (payload.side === 'attacker') addReport(`⚔️ 进攻结算（${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜抢得：${loot || '无'}`);
    else addReport(`🛡️ 被进攻（${win}）！攻${payload.attackPower} vs 防${payload.defensePower}｜被抢：${loot || '无'}`);
  } else if (event === 'IncomingAttack') {
    addReport(`🚨 警报！有敌军来袭，预计 ${secStr(payload.arriveAt)} 后抵达！`);
  } else if (event === 'MarchReturned') {
    const loot = Object.entries(payload.loot || {}).map(([t, n]: any) => `${RES_INFO[t]?.name}${n}`).join(' ');
    addReport(`🏠 部队返回，带回：${loot || '无'}`);
  } else if (event === 'CropDeficit') addReport('⚠️ 粮食告急！军队可能逃亡');
  refreshAll();
});

// ---------- 启动 ----------
function startGame() {
  renderShell();
  refreshAll();
}

connect(
  () => { connected = true; if (!me) renderLogin(); else startGame(); },
  () => { connected = false; },
);
renderLogin('连接服务器中…');

setInterval(() => {
  if (!me) return;
  renderResBar();
  syncTimers();
  // 资源每秒增长，军队页训练按钮的"买得起"状态随之实时刷新
  if (currentTab === 'army') {
    document.querySelectorAll<HTMLInputElement>('input[data-unit]').forEach((inp) => updateTrainCost(inp.dataset.unit!));
  }
}, 1000);
setInterval(() => { if (me) refreshAll(); }, 5000);

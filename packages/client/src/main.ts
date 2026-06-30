import './style.css';
import { connect, req, login, register, onPush, me } from './api.js';
import { RES_INFO, FIELD_INFO, BUILDING_INFO, UNIT_INFO, PVE_INFO } from './info.js';

/**
 * 文字版 Travian 前端（多人版）：登录 → 村庄/军队/地图/报告。
 * 地图区分：自己村 / 他人村(可攻击) / 野怪(可掠夺)。
 * 所有图标用美术占位图（/art/*.png），统一走 art() 渲染，加载失败回退文字。
 */

let cache: any = {};
const reports: string[] = [];
let currentTab = 'village';
let connected = false;

const fmt = (n: number) => Math.floor(n).toLocaleString();
const secStr = (ms: number) => {
  const s = Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}分${s % 60}秒` : `${s}秒`;
};

/** 统一图标渲染：输出 <img>，加载失败回退为文字徽标。size: sm|md|lg */
function art(src: string, label: string, size: 'sm' | 'md' | 'lg' = 'md'): string {
  const safe = label.replace(/'/g, '');
  return `<img class="icon icon-${size}" src="${src}" alt="${safe}" title="${safe}" loading="lazy"
    onerror="this.outerHTML='<span class=\\'icon icon-${size} icon-fallback\\'>${safe}</span>'" />`;
}
/** 兵种图标：由 key 确定性映射到美术文件，不依赖服务器 emoji。 */
const unitArt = (key: string) => `/art/unit_${key}.png`;

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
};

let loginMode: 'login' | 'register' = 'register';
let pickedTribe = 'romans';

// ---------- 登录界面 ----------
function renderLogin(msg = '') {
  const tribeBtns = TRIBES.map((t) =>
    `<button class="tribe ${pickedTribe === t.key ? 'picked' : ''}" data-tribe="${t.key}">
      <b>${t.name}</b><small>${t.desc}</small></button>`).join('');
  app.innerHTML = `
    <div class="login">
      <div class="login-logo">${art('/art/ui_logo.png', 'Travian 2.0', 'lg')}</div>
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
    else renderLogin(ERR_MSG[res.error ?? ''] ?? `失败：${res.error}`);
  };
  document.getElementById('goBtn')!.onclick = go;
  document.getElementById('pwd')!.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') go(); });
}

// ---------- 游戏主界面 ----------
const TABS = [
  { key: 'village', name: '村庄', icon: '/art/ui_tab_village.png' },
  { key: 'army', name: '军队', icon: '/art/ui_tab_army.png' },
  { key: 'map', name: '地图', icon: '/art/ui_tab_map.png' },
  { key: 'reports', name: '报告', icon: '/art/ui_tab_reports.png' },
];

function renderShell() {
  const tabBtns = TABS.map((t) =>
    `<button data-tab="${t.key}">${art(t.icon, t.name, 'sm')}<span>${t.name}</span></button>`).join('');
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">${art('/art/ui_logo.png', 'LOGO', 'md')}
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
  const cells = ['wood', 'clay', 'iron', 'crop'].map((t) => {
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
}

function queueBanner(): string {
  const q = cache.vil?.queue;
  if (!q) return '';
  const label = FIELD_INFO[q.target]?.name ?? BUILDING_INFO[q.target]?.name ?? q.target;
  return `<div class="banner banner-build">建造中：<b>${label}</b> → ${q.toLevel} 级（剩 <b id="qtimer">${secStr(q.finishAt)}</b>）</div>`;
}

function renderVillage(): string {
  const vil = cache.vil;
  if (!vil) return '<div class="loading">加载中…</div>';
  const fields = vil.fields.map((f: any, i: number) => `
    <div class="card">${art(FIELD_INFO[f.type].icon, FIELD_INFO[f.type].name, 'md')}
      <div class="cardbody"><div class="card-title">${FIELD_INFO[f.type].name} <b class="lv">Lv${f.level}</b></div>
        <button class="btn-sm" data-field="${i}" ${vil.queue ? 'disabled' : ''}>升级</button></div></div>`).join('');
  const blds = Object.entries(vil.defs).map(([kind, d]: any) => `
    <div class="card ${d.unlocked ? '' : 'locked'}">${art(BUILDING_INFO[kind]?.icon ?? '/art/bld_main.png', d.name, 'md')}
      <div class="cardbody"><div class="card-title">${d.name} <b class="lv">Lv${d.level}</b></div>
        ${d.level >= d.maxLevel ? '<small class="tag">已满级</small>' : !d.unlocked ? '<small class="tag tag-lock">未解锁</small>'
          : `<button class="btn-sm" data-bld="${kind}" ${vil.queue ? 'disabled' : ''}>升级</button>`}</div></div>`).join('');
  return `${queueBanner()}
    <h3>资源田 <small>（18）</small></h3><div class="grid">${fields}</div>
    <h3>中心建筑</h3><div class="grid">${blds}</div>`;
}

function unitName(key: string): string {
  const t = (cache.army?.trainable || []).find((u: any) => u.key === key);
  return t?.name ?? UNIT_INFO[key]?.name ?? key;
}

function renderArmy(): string {
  const army = cache.army;
  if (!army) return '<div class="loading">加载中…</div>';
  const troops = Object.entries(army.troops || {});
  const troopList = troops.length
    ? troops.map(([u, n]: any) => `<span class="troop">${art(unitArt(u), unitName(u), 'sm')}<span>${unitName(u)} <b>×${n}</b></span></span>`).join('')
    : '<small class="muted">暂无驻军</small>';
  const training = army.training
    ? `<div class="banner banner-train">训练中：<b>${unitName(army.training.unit)}</b> ×${army.training.remaining}（下一个 <b id="ttimer">${secStr(army.training.nextDoneAt)}</b>）</div>` : '';
  const trainCards = (army.trainable || []).map((u: any) => `
    <div class="card">${art(unitArt(u.key), u.name, 'md')}
      <div class="cardbody"><div class="card-title">${u.name} <small class="tag">${catName(u.cat)}</small></div>
        <div class="train-row"><input type="number" min="1" value="1" id="cnt-${u.key}" />
          <button class="btn-sm" data-train="${u.key}" ${army.training ? 'disabled' : ''}>训练</button></div></div></div>`).join('');
  return `<h3>驻军 <small>（${tribeName(army.tribe)}族）</small></h3><div class="troopbar">${troopList}</div>${training}
    <h3>训练</h3><div class="grid">${trainCards}</div>`;
}

function catName(c: string): string {
  return { infantry: '步兵', cavalry: '骑兵', scout: '侦察', siege: '攻城', admin: '行政', settler: '拓荒' }[c] ?? c;
}
function tribeName(t: string): string {
  return { romans: '罗马', gauls: '高卢', teutons: '条顿' }[t] ?? t;
}

function renderMap(): string {
  const area = cache.area, army = cache.army;
  if (!area) return '<div class="loading">加载中…</div>';
  const myTroops = Object.entries(army?.troops || {}).filter(([, n]: any) => n > 0);
  const troopInputs = myTroops.length
    ? myTroops.map(([u, n]: any) => `<label class="raid-input">${art(unitArt(u), unitName(u), 'sm')}<input type="number" min="0" max="${n}" value="${n}" id="raid-${u}" /></label>`).join('')
    : '<small class="muted">无可用兵力，先去军队页训练</small>';

  const tiles = area.tiles.filter((t: any) => t.refId !== me?.villageId);
  const list = tiles.map((t: any) => {
    if (t.kind === 'pve') {
      const ty = t.name?.includes('鼠') ? 'rats' : t.name?.includes('狼') ? 'wolves' : 'bandits';
      return `<div class="card target">${art(PVE_INFO[ty]?.icon ?? '/art/pve_bandits.png', t.name, 'md')}
        <div class="cardbody"><div class="card-title">${t.name} <small class="coord">(${t.x},${t.y})</small></div>
          <button class="btn-sm btn-raid" data-raid="${t.refId}">掠夺</button></div></div>`;
    }
    if (t.kind === 'village') {
      return `<div class="card enemy">${art('/art/bld_main.png', t.name, 'md')}
        <div class="cardbody"><div class="card-title">${t.name} <small class="coord">(${t.x},${t.y})</small></div>
          <button class="btn-sm btn-attack" data-attack="${t.refId}" data-x="${t.x}" data-y="${t.y}">进攻</button></div></div>`;
    }
    return '';
  }).join('');

  const moves = (cache.moves?.movements || []).map((m: any) => {
    const kind = m.type === 'attack' ? '进攻' : m.type === 'raid' ? '掠夺' : '返程';
    return `<div class="banner banner-move">${kind} → (${m.toXY.x},${m.toXY.y}) 抵达 <b>${secStr(m.arriveAt)}</b>${m.loot ? ` · 战利品 ${Object.values(m.loot).reduce((a: any, b: any) => a + b, 0)}` : ''}</div>`;
  }).join('');

  return `<h3>周边地图 <small>（你在 ${me?.x},${me?.y}）</small></h3>
    <div class="raidbox"><div class="raidbox-title">出征兵力</div><div class="raid-inputs">${troopInputs}</div></div>
    <div class="grid">${list || '<small class="muted">周边暂无目标</small>'}</div>
    <h3>行军中</h3>${moves || '<small class="muted">无</small>'}`;
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
  document.querySelectorAll<HTMLButtonElement>('[data-raid]').forEach((b) =>
    b.onclick = () => {
      const troops = collectTroops();
      if (!Object.keys(troops).length) { addReport('请先设置出征兵力'); renderPage(); return; }
      act(req('SendRaid', { fromXY: { x: me!.x, y: me!.y }, targetId: b.dataset.raid, troops }));
    });
  document.querySelectorAll<HTMLButtonElement>('[data-attack]').forEach((b) =>
    b.onclick = () => {
      const troops = collectTroops();
      if (!Object.keys(troops).length) { addReport('请先设置出征兵力'); renderPage(); return; }
      act(req('SendAttack', {
        fromXY: { x: me!.x, y: me!.y },
        targetVillage: b.dataset.attack,
        toXY: { x: Number(b.dataset.x), y: Number(b.dataset.y) },
        troops,
      }));
    });
}

async function act(p: Promise<any>) {
  const res = await p;
  if (!res.ok) addReport(`操作失败：${res.error?.msg ?? res.error?.code}`);
  await refreshAll();
}

function addReport(line: string) {
  reports.unshift(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (reports.length > 60) reports.pop();
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
  const qt = document.getElementById('qtimer'); if (qt && cache.vil?.queue) qt.textContent = secStr(cache.vil.queue.finishAt);
  const tt = document.getElementById('ttimer'); if (tt && cache.army?.training) tt.textContent = secStr(cache.army.training.nextDoneAt);
}, 1000);
setInterval(() => { if (me) refreshAll(); }, 5000);

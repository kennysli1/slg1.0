import { connect, req, login, register, onPush, me } from './api.js';
import { RES_INFO, FIELD_INFO, BUILDING_INFO, UNIT_INFO, PVE_INFO } from './info.js';

/**
 * 文字版 Travian 前端（多人版）：登录 → 村庄/军队/地图/报告。
 * 地图区分：🏠自己村 / 🏰他人村(可攻击) / 野怪(可掠夺)。
 * 所有图标 emoji 占位，后续按美术清单替换。
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
      <h1>⚔️ Travian 2.0</h1>
      <div class="logintabs">
        <button class="${loginMode === 'register' ? 'on' : ''}" id="toReg">注册</button>
        <button class="${loginMode === 'login' ? 'on' : ''}" id="toLogin">登录</button>
      </div>
      <input id="name" placeholder="用户名(≤16)" maxlength="16" />
      <input id="pwd" type="password" placeholder="密码(≥4位)" />
      ${loginMode === 'register' ? `<div class="tribes">${tribeBtns}</div>` : ''}
      <button id="goBtn">${loginMode === 'register' ? '注册并进入' : '登录'}</button>
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
function renderShell() {
  app.innerHTML = `
    <div class="topbar">
      <div class="title">⚔️ Travian 2.0 · ${me?.name ?? ''}的村庄 <small>(${me?.x},${me?.y})</small></div>
      <div id="resbar" class="resbar"></div>
    </div>
    <div class="tabs">
      <button data-tab="village">🏠 村庄</button>
      <button data-tab="army">⚔️ 军队</button>
      <button data-tab="map">🗺️ 地图</button>
      <button data-tab="reports">📜 报告</button>
    </div>
    <div id="page" class="page"></div>`;
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
    const warn = t === 'crop' && rate < 0 ? ' style="color:#c00"' : '';
    return `<span class="res"${warn}>${RES_INFO[t].icon} ${fmt(r.resources[t])}/${fmt(r.capacity[t])} <small>(${rate >= 0 ? '+' : ''}${rate.toFixed(0)}/h)</small></span>`;
  }).join('');
  const rb = document.getElementById('resbar');
  if (rb) rb.innerHTML = cells + `<span class="res">👥 耗粮 ${fmt(r.cropUpkeep)}/h</span>`;
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
  return `<div class="banner">🔨 建造中：${label} → ${q.toLevel}级（剩 <b id="qtimer">${secStr(q.finishAt)}</b>）</div>`;
}

function renderVillage(): string {
  const vil = cache.vil;
  if (!vil) return '加载中…';
  const fields = vil.fields.map((f: any, i: number) => `
    <div class="card"><div class="ic">${FIELD_INFO[f.type].icon}</div>
      <div class="cardbody"><div>${FIELD_INFO[f.type].name} <b>Lv${f.level}</b></div>
        <button data-field="${i}" ${vil.queue ? 'disabled' : ''}>升级</button></div></div>`).join('');
  const blds = Object.entries(vil.defs).map(([kind, d]: any) => `
    <div class="card ${d.unlocked ? '' : 'locked'}"><div class="ic">${BUILDING_INFO[kind]?.icon ?? '🏠'}</div>
      <div class="cardbody"><div>${d.name} <b>Lv${d.level}</b></div>
        ${d.level >= d.maxLevel ? '<small>已满级</small>' : !d.unlocked ? '<small>未解锁</small>'
          : `<button data-bld="${kind}" ${vil.queue ? 'disabled' : ''}>升级</button>`}</div></div>`).join('');
  return `${queueBanner()}<h3>🌾 资源田（18）</h3><div class="grid">${fields}</div>
    <h3>🏛️ 中心建筑</h3><div class="grid">${blds}</div>`;
}

function unitName(key: string): string {
  // 优先用服务器返回的本族兵种名，回退到 UNIT_INFO 或 key
  const t = (cache.army?.trainable || []).find((u: any) => u.key === key);
  return t?.name ?? UNIT_INFO[key]?.name ?? key;
}
function unitIcon(key: string): string {
  const t = (cache.army?.trainable || []).find((u: any) => u.key === key);
  return t?.icon ?? UNIT_INFO[key]?.icon ?? '🪖';
}

function renderArmy(): string {
  const army = cache.army;
  if (!army) return '加载中…';
  const troops = Object.entries(army.troops || {});
  const troopList = troops.length
    ? troops.map(([u, n]: any) => `<span class="res">${unitIcon(u)} ${unitName(u)} ×${n}</span>`).join('')
    : '<small>暂无驻军</small>';
  const training = army.training
    ? `<div class="banner">🎯 训练中：${unitName(army.training.unit)} ×${army.training.remaining}（下个 <b id="ttimer">${secStr(army.training.nextDoneAt)}</b>）</div>` : '';
  const trainCards = (army.trainable || []).map((u: any) => `
    <div class="card"><div class="ic">${u.icon}</div>
      <div class="cardbody"><div>${u.name} <small>(${catName(u.cat)})</small></div>
        <div class="train-row"><input type="number" min="1" value="1" id="cnt-${u.key}" style="width:46px"/>
          <button data-train="${u.key}" ${army.training ? 'disabled' : ''}>训练</button></div></div></div>`).join('');
  return `<h3>🛡️ 驻军（${tribeName(army.tribe)}族）</h3><div class="troopbar">${troopList}</div>${training}
    <h3>⚔️ 训练</h3><div class="grid">${trainCards}</div>`;
}

function catName(c: string): string {
  return { infantry: '步兵', cavalry: '骑兵', scout: '侦察', siege: '攻城', admin: '行政', settler: '拓荒' }[c] ?? c;
}
function tribeName(t: string): string {
  return { romans: '罗马', gauls: '高卢', teutons: '条顿' }[t] ?? t;
}

function renderMap(): string {
  const area = cache.area, army = cache.army;
  if (!area) return '加载中…';
  const myTroops = Object.entries(army?.troops || {}).filter(([, n]: any) => n > 0);
  const troopInputs = myTroops.length
    ? myTroops.map(([u, n]: any) => `${unitName(u)}: <input type="number" min="0" max="${n}" value="${n}" id="raid-${u}" style="width:46px"/>`).join(' ')
    : '<small>无可用兵力，先去军队页训练</small>';

  const tiles = area.tiles.filter((t: any) => t.refId !== me?.villageId);
  const list = tiles.map((t: any) => {
    if (t.kind === 'pve') {
      const ty = t.name?.includes('鼠') ? 'rats' : t.name?.includes('狼') ? 'wolves' : 'bandits';
      return `<div class="card target"><div class="ic">${PVE_INFO[ty]?.icon ?? '👹'}</div>
        <div class="cardbody"><div><b>${t.name}</b> <small>(${t.x},${t.y})</small></div>
          <button data-raid="${t.refId}">⚔️ 掠夺</button></div></div>`;
    }
    if (t.kind === 'village') {
      return `<div class="card enemy"><div class="ic">🏰</div>
        <div class="cardbody"><div><b>${t.name}</b> <small>(${t.x},${t.y})</small></div>
          <button data-attack="${t.refId}" data-x="${t.x}" data-y="${t.y}">🗡️ 进攻</button></div></div>`;
    }
    return '';
  }).join('');

  const moves = (cache.moves?.movements || []).map((m: any) => {
    const kind = m.type === 'attack' ? '进攻' : m.type === 'raid' ? '掠夺' : '返程';
    return `<div class="banner">🏃 ${kind} → (${m.toXY.x},${m.toXY.y}) 抵达 <b>${secStr(m.arriveAt)}</b>${m.loot ? ` 📦${Object.values(m.loot).reduce((a: any, b: any) => a + b, 0)}` : ''}</div>`;
  }).join('');

  return `<h3>🗺️ 周边（你在 ${me?.x},${me?.y}）</h3>
    <div class="raidbox">出征兵力 → ${troopInputs}</div>
    <div class="grid">${list || '<small>周边暂无目标</small>'}</div>
    <h3>🏃 行军中</h3>${moves || '<small>无</small>'}`;
}

function renderReports(): string {
  if (!reports.length) return '<small>暂无战报。去地图掠夺野怪或进攻其他玩家！</small>';
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
      if (!Object.keys(troops).length) { addReport('❌ 请先设置出征兵力'); renderPage(); return; }
      act(req('SendRaid', { fromXY: { x: me!.x, y: me!.y }, targetId: b.dataset.raid, troops }));
    });
  document.querySelectorAll<HTMLButtonElement>('[data-attack]').forEach((b) =>
    b.onclick = () => {
      const troops = collectTroops();
      if (!Object.keys(troops).length) { addReport('❌ 请先设置出征兵力'); renderPage(); return; }
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
  if (!res.ok) addReport(`❌ 操作失败：${res.error?.msg ?? res.error?.code}`);
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
    const loot = Object.entries(payload.looted || {}).map(([t, n]: any) => `${RES_INFO[t]?.icon}${n}`).join(' ');
    addReport(`掠夺${win}！攻${payload.attackPower} vs 防${payload.defensePower}｜战利品：${loot || '无'}`);
  } else if (event === 'AttackResolved') {
    const win = payload.attackerWins ? '攻方胜' : '守方胜';
    const loot = Object.entries(payload.looted || {}).map(([t, n]: any) => `${RES_INFO[t]?.icon}${n}`).join(' ');
    if (payload.side === 'attacker') addReport(`⚔️ 进攻结算（${win}）攻${payload.attackPower} vs 防${payload.defensePower}｜抢得：${loot || '无'}`);
    else addReport(`🛡️ 被进攻（${win}）！攻${payload.attackPower} vs 防${payload.defensePower}｜被抢：${loot || '无'}`);
  } else if (event === 'IncomingAttack') {
    addReport(`🚨 警报！有敌军来袭，预计 ${secStr(payload.arriveAt)} 后抵达！`);
  } else if (event === 'MarchReturned') {
    const loot = Object.entries(payload.loot || {}).map(([t, n]: any) => `${RES_INFO[t]?.icon}${n}`).join(' ');
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

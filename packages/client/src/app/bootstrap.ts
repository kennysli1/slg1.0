/**
 * 应用启动与编排壳：shell/资源条/页签路由/刷新循环/推送分发。
 * 不含具体页面渲染逻辑——各页面在 features/* 内自描述，这里只负责装配。
 */
import { connect, req, onPush, me } from '../api.js';
import { art } from '../shared/ui/widgets.js';
import { errText } from '../shared/ui/text.js';
import { fmt } from '../shared/utils/format.js';
import { syncTimers } from '../shared/ui/widgets.js';
import { resInfo, resourceKeys, loadGameConfig } from './config.js';
import { getCache, setCache, getTab, setTab, addReport } from './state.js';
import { renderLogin } from '../features/login/login.js';
import { renderVillage, bindVillage } from '../features/village/village.js';
import { renderArmy, bindArmy, updateTrainCost } from '../features/army/army.js';
import { renderMap, bindMap } from '../features/map/map.js';
import { renderReports, handlePush, hydrateReports } from '../features/reports/reports.js';

const app = document.getElementById('app')!;

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
          <div class="subtitle">${me?.name ?? ''} 的村庄 · 坐标 (${me?.q},${me?.r})</div>
        </div>
      </div>
      <div id="resbar" class="resbar"></div>
    </header>
    <nav class="tabs">${tabBtns}</nav>
    <main id="page" class="page"></main>`;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => {
    b.onclick = () => { setTab(b.dataset.tab!); renderPage(); };
  });
}

async function refreshAll() {
  if (!me) return;
  const [res, vil, army, area, moves] = await Promise.all([
    req('GetResources'), req('GetVillage'), req('GetArmy'),
    req('GetArea', { cq: me.q, cr: me.r, r: 25 }), req('ListMovements'),
  ]);
  setCache({ res: res.payload, vil: vil.payload, army: army.payload, area: area.payload, moves: moves.payload });
  renderResBar();
  renderPage();
}

function renderResBar() {
  const r = getCache().res;
  if (!r) return;
  const cells = resourceKeys().map((t) => {
    const rate = r.netRate[t] * 3600;
    const low = t === 'crop' && rate < 0 ? ' res-low' : '';
    const pct = Math.min(100, (r.resources[t] / r.capacity[t]) * 100);
    const info = resInfo(t);
    return `<span class="res${low}">${art(info.icon, info.name, 'sm')}
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
  const tab = getTab();
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.classList.toggle('active', (b as HTMLButtonElement).dataset.tab === tab));
  if (tab === 'village') page.innerHTML = renderVillage();
  else if (tab === 'army') page.innerHTML = renderArmy();
  else if (tab === 'map') page.innerHTML = renderMap();
  else page.innerHTML = renderReports();
  bindPageEvents();
  syncTimers();
}

function bindPageEvents() {
  bindVillage(act);
  bindArmy(act);
  bindMap(act);
}

/** 统一"发请求并刷新"：失败转中文战报。 */
async function act(p: Promise<any>) {
  const res = await p;
  if (!res.ok) addReport(`操作失败：${errText(res.error?.code)}`);
  await refreshAll();
}

function startGame() {
  renderShell();
  // 登录后拉一次历史通知，播种战报列表（只拉一次，后续靠 live Push 追加）
  req('GetNotifications').then((res) => {
    if (res.ok) hydrateReports((res.payload as any).notifications ?? []);
  });
  refreshAll();
}

// ---------- 推送分发 ----------
onPush((event, payload) => {
  handlePush(event, payload);
  refreshAll();
});

/** 应用入口：先拉配置 → 连接 WS → 据登录态进入登录页或游戏。 */
export async function bootstrap() {
  await loadGameConfig(); // 拉服务端配置（名称/图标/分类/白名单常量）
  connect(
    () => { if (!me) renderLogin(app, startGame); else startGame(); },
    () => { /* 断线：connect 内部会自动重连 */ },
  );
  renderLogin(app, startGame, '连接服务器中…');

  setInterval(() => {
    if (!me) return;
    renderResBar();
    syncTimers();
    // 资源每秒增长，军队页训练按钮的"买得起"状态随之实时刷新
    if (getTab() === 'army') {
      document.querySelectorAll<HTMLInputElement>('input[data-unit]').forEach((inp) => updateTrainCost(inp.dataset.unit!));
    }
  }, 1000);
  setInterval(() => { if (me) refreshAll(); }, 5000);
}

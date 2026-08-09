/**
 * 应用启动与编排壳：shell/资源条/页签路由/刷新循环/推送分发。
 * 不含具体页面渲染逻辑——各页面在 features/* 内自描述，这里只负责装配。
 */
import { connect, req, onPush, me, getProtocolError, selectVillage } from '../api.js';
import { art, escapeHtml } from '../shared/ui/widgets.js';
import { errText } from '../shared/ui/text.js';
import { fmt } from '../shared/utils/format.js';
import { syncTimers, installIconFallback } from '../shared/ui/widgets.js';
import { showToast } from '../shared/ui/toast.js';
import { resInfo, resourceKeys, loadGameConfig, worldW, worldH } from './config.js';
import { getCache, setCache, getTab, setTab, addReport, getMapCenter, setPopState, getPopState, interpolatePop, interpolateTotalPop } from './state.js';
import { renderLogin } from '../features/login/login.js';
import { renderVillage, bindVillage, refreshTrainingIfOpen } from '../features/village/village.js';
import { syncPopDisplay } from '../features/village/population.js';
import { renderArmy, bindArmy, updateTrainCost } from '../features/army/army.js';
import { refreshMercCampIfOpen } from '../features/army/mercenary.js';
import { renderMap, bindMap, resetMapCenter } from '../features/map/map.js';
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
  const villages = me?.villages ?? [];
  const villageSwitch = villages.length > 1
    ? `<select id="villageSwitch" class="village-switch" title="切换当前操作村">
        ${villages.map((v) =>
          `<option value="${v.id}" ${v.id === me?.villageId ? 'selected' : ''}>${escapeHtml(v.name)}${v.isCapital ? '（主）' : ''} (${v.q},${v.r})</option>`).join('')}
      </select>`
    : '';
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">${art('ui_logo', 'LOGO', 'md')}
        <div class="brand-text">
          <div class="title">世界之王</div>
          <div class="subtitle">${escapeHtml(me?.name ?? '')} · (${me?.q},${me?.r}) ${villageSwitch}</div>
        </div>
      </div>
      <div id="resbar" class="resbar"></div>
    </header>
    <nav class="tabs">${tabBtns}</nav>
    <main id="page" class="page"></main>`;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => {
    b.onclick = () => { setTab(b.dataset.tab!); renderPage(); };
  });
  const sw = document.getElementById('villageSwitch') as HTMLSelectElement | null;
  if (sw) {
    sw.onchange = async () => {
      const id = sw.value;
      if (!id || id === me?.villageId) return;
      const r = await selectVillage(id);
      if (!r.ok) {
        addReport(`切村失败：${errText(r.error)}`);
        sw.value = me?.villageId ?? '';
        return;
      }
      renderShell();
      await refreshAll();
    };
  }
}

async function refreshAll() {
  if (!me) return;
  try {
    const center = getMapCenter() ?? { q: me.q, r: me.r };
    // 全图模式：一次性拉取整张地图的全部非空地块（full=true 忽略半径上限），
    // 后续拖拽/缩放/跳转均为纯视觉变换，不再按视野重拉数据。
    const [res, vil, army, area, moves, pop] = await Promise.all([
      req('GetResources'), req('GetVillageLayout'), req('GetArmy'),
      req('GetArea', { cq: center.q, cr: center.r, r: Math.max(worldW(), worldH()), full: true }), req('ListMovements'),
      req('GetPopulation').catch(() => ({ ok: false } as any)),
    ]);
    const failed = [res, vil, army, area, moves].find((x) => !x.ok);
    if (failed) {
      const code = failed.error?.code ?? 'failed';
      if (code === 'not_logged_in') renderLogin(app, startGame, '连接已断开，请重新登录');
      else addReport(`刷新失败：${errText(code)}`);
      return;
    }
    setCache({ res: res.payload, vil: vil.payload, army: army.payload, area: area.payload, moves: moves.payload });
    resFetchedAt = Date.now(); // 资源快照时刻：之后 1s 定时器据此本地外插资源数字，无需再访问服务器
    // 更新人口快照（GetPopulation 失败时静默忽略，旧快照保留）
    if (pop.ok) {
      const p = pop.payload as any;
      // GetPopulation 返回 v3 硬上限快照 + 劳动→士兵转化模型：
      // currentPop(平民)/soldierPop(驻军+在途)/totalPop(总人口)/trainingPop(训练中)/hardCap/
      // availableLabor(=平民)/popCeiling(平民增长上限)/laborRatio/prosperityBonus/prosperityMult/
      // growthPerHour/mobilizeCap/mainLevel/inFamine/civilianCropPerHour + softLimit=availableLabor + laborMults(五轴)。
      const currentPop: number = p.currentPop ?? 0;
      const soldierPop: number = p.soldierPop ?? 0;
      const totalPop: number = p.totalPop ?? (currentPop + soldierPop);
      const trainingPop: number = p.trainingPop ?? 0;
      const hardCap: number = p.hardCap ?? 0;
      const availableLabor: number = p.availableLabor ?? currentPop;
      const popCeiling: number = p.popCeiling ?? hardCap;
      const prosperityMult: number = p.prosperityMult ?? 1;
      setPopState({
        currentPop,
        soldierPop,
        totalPop,
        trainingPop,
        hardCap,
        availableLabor,
        popCeiling,
        laborRatio: p.laborRatio ?? 0,
        prosperityBonus: p.prosperityBonus ?? 0,
        prosperityMult,
        growthPerHour: p.growthPerHour ?? 0,
        potentialGrowthPerHour: p.potentialGrowthPerHour ?? 0,
        mobilizeCap: p.mobilizeCap ?? 0,
        mainLevel: p.mainLevel ?? 1,
        inFamine: !!p.inFamine,
        goldPerHour: p.goldPerHour ?? 0,
        civilianCropPerHour: p.civilianCropPerHour ?? 0,
        laborMults: p.laborMults ?? {
          production: prosperityMult, build: prosperityMult, train: prosperityMult,
          research: prosperityMult, smithy: prosperityMult,
        },
        softLimit: p.softLimit ?? availableLabor,
        lastTick: p.lastTick ?? Date.now(),
        fetchedAt: Date.now(),
      });
    }
    renderResBar();
    if (isInteracting()) pendingRender = true;        // 玩家正在操作：只更缓存与资源条，不重建 #page，避免打断
    else { renderPage(); pendingRender = false; }      // 空闲：正常整页重渲（同步最新数据）
  } catch {
    addReport('刷新失败：网络连接异常');
  }
}

/**
 * 资源"实时"量：用缓存快照 + 净速率按经过时间本地外插，使资源条每秒平滑增长，无需访问服务器。
 * 仅用于展示；真实值以 refreshAll 拉取的快照为准（每次 act/onPush/可见性刷新都会把 resFetchedAt 校正回 now）。
 * 与人口外插（interpolatePop）同理，但资源是纯本地计算——这就是"纯 UI 更新"那层。
 */
let resFetchedAt = 0;
function liveResource(t: string): number {
  const r = getCache().res;
  if (!r || !r.resources) return 0;
  const base = r.resources[t] ?? 0;
  if (!resFetchedAt) return base;
  const elapsedSec = (Date.now() - resFetchedAt) / 1000;
  let ratePerSec: number;
  if (t === 'gold') ratePerSec = (getPopState()?.goldPerHour ?? 0) / 3600;
  else ratePerSec = r.netRate?.[t] ?? 0;
  let v = base + ratePerSec * elapsedSec;
  if (t !== 'gold') {
    const cap = r.capacity?.[t] ?? Infinity;
    v = Math.min(cap, Math.max(0, v)); // 不超仓、不为负（速率本身已含停产/负产）
  }
  return v;
}

function renderResBar() {
  const r = getCache().res;
  if (!r) return;
  const cells = resourceKeys().map((t) => {
    // 金币：无上限、无产能条、速率来自人口交税（goldPerHour，非 economy.netRate）
    if (t === 'gold') {
      const info = resInfo(t);
      const gold = liveResource(t);
      const rate = getPopState()?.goldPerHour ?? 0;
      return `<span class="res res-gold" title="${info.name}（无上限 · 由劳动人口交税获得 · 用于雇佣雇佣兵）">${art(info.icon, info.name, 'sm')}
        <span class="res-num">${fmt(gold)}</span>
        <span class="res-rate">${rate >= 0 ? '+' : ''}${rate.toFixed(0)}/h</span></span>`;
    }
    const rate = r.netRate[t] * 3600;
    const over = !!(r.productionPaused?.[t] || (r.overCapacity?.[t] > 0));
    const low = t === 'crop' && rate < 0 ? ' res-low' : '';
    const overCls = over ? ' res-over' : '';
    const pct = Math.min(100, (r.resources[t] / Math.max(1, r.capacity[t])) * 100);
    const info = resInfo(t);
    const overTip = over ? ' · 超额·停产' : '';
    return `<span class="res${low}${overCls}" title="${info.name}${overTip}">${art(info.icon, info.name, 'sm')}
      <span class="res-num">${fmt(liveResource(t))}<small>/${fmt(r.capacity[t])}</small>${over ? '<small class="res-over-tag">超额</small>' : ''}</span>
      <span class="res-rate">${over ? '停产' : `${rate >= 0 ? '+' : ''}${rate.toFixed(0)}/h`}</span>
      <span class="res-bar"><i style="width:${pct}%"></i></span></span>`;
  }).join('');
  const rb = document.getElementById('resbar');
  if (rb) rb.innerHTML = cells +
    `<span class="res res-upkeep"><span class="res-num">耗粮 ${fmt(r.cropUpkeep)}/h</span></span>` +
    renderPopCell();
}

/** 右上角人口速览单元格（与资源同排常驻）；详情仍在村庄页人口面板。 */
function renderPopCell(): string {
  const ps = getPopState();
  if (!ps) return '';
  const pop = interpolateTotalPop(); // 总人口 = 平民 + 士兵(驻军+在途) + 训练中，训练守恒不闪烁
  const atCap = !ps.inFamine && ps.hardCap > 0 && pop / ps.hardCap >= 1.0;
  // 达上限展示原始增长潜力（被锁），否则展示真实增长
  const growth = atCap ? Math.round(ps.potentialGrowthPerHour ?? 0) : Math.round(ps.growthPerHour);
  const sign = growth >= 0 ? '+' : '';
  const capTag = atCap ? ' 上限' : '';
  // 饥荒优先显示红色，接近硬上限显示橙色
  const famineClass = ps.inFamine ? ' res-famine' : (ps.hardCap > 0 && pop / ps.hardCap >= 0.95 ? ' res-low' : '');
  const famineIcon = ps.inFamine ? '🚨' : '👥';
  const trainingStr = (ps.trainingPop ?? 0) > 0 ? ` · 训练中 ${fmt(ps.trainingPop)}` : '';
  const title = ps.inFamine
    ? `人口 ${fmt(pop)}/${fmt(ps.hardCap)}（饥荒！人口正在减少）· 增长 ${sign}${growth}/h`
    : `人口 ${fmt(pop)}/${fmt(ps.hardCap)} · 平民 ${fmt(Math.round(interpolatePop()))} · 军队 ${fmt(ps.soldierPop)}${trainingStr}（训练=劳动人口转化，总人数守恒）· 增长 ${sign}${growth}/h${atCap ? '（已达上限，实际不增长）' : ''}`;
  return `<span class="res res-pop${famineClass}" title="${title}">
    <span class="res-pop-icon">${famineIcon}</span>
    <span class="res-num">${fmt(pop)}<small>/${fmt(ps.hardCap)}</small></span>
    <span class="res-rate">${sign}${growth}/h${capTag}</span></span>`;
}

let lastRenderedTab: string | null = null;
/** 交互中推迟的整页重渲标记：refreshAll 在玩家操作时只更新缓存与资源条，置此位，待操作结束后由 1s tick 补渲。 */
let pendingRender = false;

/**
 * 是否处于"会被整页重渲打断"的进行中交互。为真时 refreshAll 不重建 #page：
 *  - 地图拖拽中（map.ts 在 mousedown/mouseup 间置位 body[data-dragging]）；
 *  - #page 内有 INPUT/TEXTAREA/SELECT 获得焦点（如军队页正在填训练数量）；
 *  - body 挂着抽屉/对话框（详情/招募等，避免重建其背后 #page 的竞态）。
 */
function isInteracting(): boolean {
  if (document.body.dataset.dragging === '1') return true;
  const a = document.activeElement as HTMLElement | null;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && a.closest('#page')) return true;
  if (document.querySelector('.drawer[role="dialog"], [role="dialog"]')) return true;
  return false;
}

function renderPage() {
  const page = document.getElementById('page');
  if (!page) return;
  const tab = getTab();
  const entering = tab !== lastRenderedTab; // 仅在切换页签时播放入场动效，5s 刷新/局部重渲不重放
  lastRenderedTab = tab;
  document.querySelectorAll('.tabs button').forEach((b) =>
    b.classList.toggle('active', (b as HTMLButtonElement).dataset.tab === tab));
  page.classList.remove('page--enter');
  if (tab === 'village') page.innerHTML = renderVillage();
  else if (tab === 'army') page.innerHTML = renderArmy();
  else if (tab === 'map') page.innerHTML = renderMap();
  else page.innerHTML = renderReports();
  if (entering) {
    void page.offsetWidth; // 强制回流，确保重加 class 能重新触发动画
    page.classList.add('page--enter');
    window.setTimeout(() => page.classList.remove('page--enter'), 650);
  }
  // 进入地图页时（非 5s 刷新）重置居中状态：以本城为心、INITIAL_ZOOM 重新居中。
  if (entering && tab === 'map') resetMapCenter();
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
  try {
    const res = await p;
    if (!res.ok) {
      const code = res.error?.code;
      // 队列相关的"当下拦截"用 toast 即时反馈；其余仍进报告流水
      if (code === 'queue_full' || code === 'queue_busy') showToast(errText(code));
      else addReport(`操作失败：${errText(code)}`);
    }
    await refreshAll();
  } catch {
    addReport('操作失败：网络连接异常');
  }
}

function startGame() {
  renderShell();
  // 登录后拉一次历史通知，播种战报列表（只拉一次，后续靠 live Push 追加）
  req('GetNotifications')
    .then((res) => {
      if (res.ok) hydrateReports((res.payload as any).notifications ?? []);
    })
    .catch(() => addReport('历史战报加载失败：网络连接异常'));
  refreshAll();
}

// ---------- 推送分发 ----------
onPush((event, payload) => {
  handlePush(event, payload);
  // 拓荒成功：刷新村列表（SelectVillage 回当前村即可拿完整 villages）
  if (event === 'VillageFounded' && me?.villageId) {
    void selectVillage(me.villageId).then((r) => {
      if (r.ok) renderShell();
    });
  }
  // PopulationChanged 由 handlePush 完成快照校正 + 局部 DOM 更新（rerenderPopPanel），
  // 严禁在此触发 refreshAll/GetPopulation，防止 push→refresh→settle→emit 正反馈死循环。
  if (event !== 'PopulationChanged') {
    // 雇佣兵营地抽屉打开时，由营地模块自行刷新（避免整页刷新关掉抽屉）
    if (event === 'MercenaryCampUpdated') refreshMercCampIfOpen();
    else void refreshAll();
  } else {
    // 人口变化频繁：不整页刷新（避免抢焦点）；训练抽屉打开时仅刷新其人口提示
    refreshTrainingIfOpen();
  }
  // 训练完成 / 建筑升级影响本建筑训练队列与提速降费，抽屉打开时刷新内容
  if (event === 'TroopTrained' || event === 'BuildingUpgraded') refreshTrainingIfOpen();
});

/** 应用入口：先拉配置 → 连接 WS → 据登录态进入登录页或游戏。 */
export async function bootstrap() {
  installIconFallback(); // 图标加载失败 → 文字徽标（覆盖未就位的美术占位）
  connect(
    () => {
      void (async () => {
        await loadGameConfig(); // WS 建立后拉服务端配置（名称/图标/分类/白名单常量）
        if (!me) renderLogin(app, startGame);
        else startGame();
      })();
    },
    () => {
      const pe = getProtocolError();
      renderLogin(app, startGame, pe ?? '连接已断开，正在重连…');
    },
  );
  renderLogin(app, startGame, '连接服务器中…');

  setInterval(() => {
    if (!me) return;
    renderResBar();
    syncTimers();
    syncPopDisplay(); // 人口本地外插：每秒平滑更新显示值
    // 交互中推迟的整页重渲：玩家操作结束（失焦/关弹窗/停拖）后补一次，避免打断进行中的操作
    if (pendingRender && !isInteracting()) { pendingRender = false; renderPage(); }
    // 资源每秒增长，军队页训练按钮的"买得起"状态随之实时刷新
    if (getTab() === 'army') {
      document.querySelectorAll<HTMLInputElement>('input[data-unit]').forEach((inp) => updateTrainCost(inp.dataset.unit!));
    }
  }, 1000);
  // 不再使用周期性盲轮询：强制刷新只发生在两处——
  //   (1) 客户端发起实质操作（act：建造/升级/购买）→ 操作后 refreshAll；
  //   (2) 服务器推送确认（onPush：升级完成/进攻/报告等）→ refreshAll。
  // 纯 UI（资源数字、建造倒计时、人口外插）由上面 1s 定时器本地更新，完全不访问服务器。
  // 唯一例外：标签页被后台挂起后切回（setInterval 被浏览器节流、WS 可能重连），此时补一次刷新拉取最新真相（事件驱动，非轮询）。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && me) void refreshAll();
  });
}

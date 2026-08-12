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
import { resInfo, resourceKeys, loadGameConfig, mapViewRadius } from './config.js';
import { getCache, setCache, getTab, setTab, addReport, getMapCenter, setPopState, getPopState, interpolatePop } from './state.js';
import { render } from 'preact';
import { LoginScreen } from '../features/login/LoginScreen.js';
import { renderVillage, bindVillage } from '../features/village/village.js';
import { syncPopDisplay } from '../features/village/population.js';
import { renderArmy, bindArmy, updateTrainCost } from '../features/army/army.js';
import { renderMap, bindMap } from '../features/map/map.js';
import { renderReports, handlePush, hydrateReports } from '../features/reports/reports.js';

const app = document.getElementById('app')!;

/**
 * 渲染登录/注册界面（Preact 组件）。保留旧的调用签名 (root, onSuccess, notice?)，
 * 以兼容 bootstrap 各处的 renderLogin(app, startGame, msg) 调用。
 */
function renderLogin(root: HTMLElement, onSuccess: () => void, notice?: string): void {
  render(LoginScreen({ booting: false, notice: notice ?? '', onSuccess }), root);
}

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
    const R = mapViewRadius();
    const fetchR = R + 6; // 拉取比视野稍大一圈，方向键移动后无需等待
    const [res, vil, army, area, moves, pop] = await Promise.all([
      req('GetResources'), req('GetVillageLayout'), req('GetArmy'),
      req('GetArea', { cq: center.q, cr: center.r, r: fetchR }), req('ListMovements'),
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
    // 更新人口快照（GetPopulation 失败时静默忽略，旧快照保留）
    if (pop.ok) {
      // GetPopulation 返回 v3 完整快照（publicPayload）：currentPop/soldierPop/totalPop/trainingPop/
      // hardCap/availableLabor/softLimit(=hardCap)/popCeiling/laborRatio/prosperityBonus/
      // prosperityMult/growthPerHour/potentialGrowthPerHour/mobilizeCap/popProsperityFullRatio/
      // mainLevel/inFamine/civilianCropPerHour/goldPerHour。
      // 下列字段快照不携带，用安全默认值兜底（push 事件会持续校正）：
      //   laborMults(五轴繁荣乘数) / garrisonPop(驻军展示) / lambdaRatio(充裕比) /
      //   wounded(伤兵池) / cropDeficitRate(粮食赤字速率)。
      const p = pop.payload as any;
      setPopState({
        currentPop: p.currentPop ?? 0,
        soldierPop: p.soldierPop ?? 0,
        totalPop: p.totalPop ?? 0,
        trainingPop: p.trainingPop ?? 0,
        hardCap: p.hardCap ?? 0,
        availableLabor: p.availableLabor ?? p.currentPop ?? 0,
        popCeiling: p.popCeiling ?? 0,
        laborRatio: p.laborRatio ?? 1,
        prosperityBonus: p.prosperityBonus ?? 0,
        prosperityMult: p.prosperityMult ?? 1,
        growthPerHour: p.growthPerHour ?? 0,
        potentialGrowthPerHour: p.potentialGrowthPerHour ?? 0,
        mobilizeCap: p.mobilizeCap ?? 0.7,
        popProsperityFullRatio: p.popProsperityFullRatio ?? 0.7,
        mainLevel: p.mainLevel ?? 1,
        inFamine: !!p.inFamine,
        civilianCropPerHour: p.civilianCropPerHour ?? 0,
        goldPerHour: p.goldPerHour ?? 0,
        softLimit: p.softLimit ?? p.hardCap ?? 0,
        garrisonPop: p.soldierPop ?? 0,
        lambdaRatio: p.lambdaRatio ?? 0,
        wounded: {
          total: p.wounded?.total ?? 0,
          entries: p.wounded?.entries ?? [],
        },
        cropDeficitRate: 0,
        laborMults: p.laborMults ?? {
          production: 1, build: 1, train: 1, research: 1, smithy: 1,
        },
        lastTick: p.lastTick ?? Date.now(),
        fetchedAt: Date.now(),
      });
    }
    renderResBar();
    renderPage();
  } catch {
    addReport('刷新失败：网络连接异常');
  }
}

function renderResBar() {
  const r = getCache().res;
  if (!r) return;
  const cells = resourceKeys().map((t) => {
    const rate = r.netRate[t] * 3600;
    const over = !!(r.productionPaused?.[t] || (r.overCapacity?.[t] > 0));
    const low = t === 'crop' && rate < 0 ? ' res-low' : '';
    const overCls = over ? ' res-over' : '';
    const pct = Math.min(100, (r.resources[t] / Math.max(1, r.capacity[t])) * 100);
    const info = resInfo(t);
    const overTip = over ? ' · 超额·停产' : '';
    return `<span class="res${low}${overCls}" title="${info.name}${overTip}">${art(info.icon, info.name, 'sm')}
      <span class="res-num">${fmt(r.resources[t])}<small>/${fmt(r.capacity[t])}</small>${over ? '<small class="res-over-tag">超额</small>' : ''}</span>
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
  const pop = interpolatePop();
  const growth = Math.round(ps.growthPerHour);
  const sign = growth >= 0 ? '+' : '';
  // 饥荒优先显示红色，接近饱和显示橙色
  const famineClass = ps.inFamine ? ' res-famine' : (ps.softLimit > 0 && pop / ps.softLimit >= 0.95 ? ' res-low' : '');
  const famineIcon = ps.inFamine ? '🚨' : '👥';
  const titleSuffix = ps.inFamine
    ? `（饥荒！赤字 ${Math.round(ps.cropDeficitRate)}/h）`
    : ps.garrisonPop > 0
      ? `· 驻军 ${fmt(ps.garrisonPop)} 人`
      : '';
  return `<span class="res res-pop${famineClass}" title="平民 ${fmt(pop)}/${fmt(ps.softLimit)}（软上限）· 增长 ${sign}${growth}/h${titleSuffix}">
    <span class="res-pop-icon">${famineIcon}</span>
    <span class="res-num">${fmt(pop)}<small>/${fmt(ps.softLimit)}</small></span>
    <span class="res-rate">${sign}${growth}/h</span></span>`;
}

let lastRenderedTab: string | null = null;

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
  bindPageEvents();
  syncTimers();
}

function bindPageEvents() {
  bindVillage(act);
  bindArmy(act);
  bindMap(act, async (center) => {
    // 导航后立即用新中心刷新地图数据
    const R = mapViewRadius();
    const fetchR = R + 6;
    try {
      const area = await req('GetArea', { cq: center.q, cr: center.r, r: fetchR });
      if (area.ok) {
        setCache({ ...getCache(), area: area.payload });
        renderPage();
      } else {
        addReport(`地图刷新失败：${errText(area.error?.code)}`);
      }
    } catch {
      addReport('地图刷新失败：网络连接异常');
    }
  });
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
    void refreshAll();
  }
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
    // 资源每秒增长，军队页训练按钮的"买得起"状态随之实时刷新
    if (getTab() === 'army') {
      document.querySelectorAll<HTMLInputElement>('input[data-unit]').forEach((inp) => updateTrainCost(inp.dataset.unit!));
    }
  }, 1000);
  setInterval(() => { if (me) refreshAll(); }, 5000);
}

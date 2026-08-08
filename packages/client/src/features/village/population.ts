/**
 * 人口面板：劳动人口 / 硬上限 / 劳动占比 / 繁荣度系数 / 五轴速率 / 增长。
 * v3 硬上限模型（对应设计文档 13/14）：
 *   硬上限由建筑提供；士兵占用人口；劳动占比决定五轴繁荣度系数（资源/建造/练兵/研究/锻造）。
 * 本地外插：renderPopPanel() 生成含 id="pop-current"/"pop-bar-fill" 的 DOM；
 * bootstrap 的 1s 定时器调 syncPopDisplay() 按 growthPerHour 线性更新显示值，不发请求。
 * PopulationChanged push 到达时，由 handlePush 调 rerenderPopPanel() 局部刷新，禁止整页回环。
 */
import { fmt } from '../../shared/utils/format.js';
import { getPopState, interpolatePop } from '../../app/state.js';

/** 速率类 mult → "XX%" */
function multPct(mult: number): string {
  return `${Math.round(mult * 100)}%`;
}

/**
 * 生成状态标签区的 HTML（饥荒 / 接近饱和 / 满员）。
 * 每个标签仅在满足条件时出现；均不满足则返回空字符串。
 */
function renderStatusLabels(ps: NonNullable<ReturnType<typeof getPopState>>, pop: number): string {
  const labels: string[] = [];
  const ratio = ps.hardCap > 0 ? pop / ps.hardCap : 0;

  // 🚨 饥荒中（服务端权威标记）
  if (ps.inFamine) {
    labels.push(`<div class="pop-status pop-status--famine">
      🚨 饥荒中，人口正在减少
    </div>`);
  }

  // ⚠️ 接近饱和（85%–100% 但未满）
  if (!ps.inFamine && ratio >= 0.85 && ratio < 1.0) {
    const pct = Math.round(ratio * 100);
    labels.push(`<div class="pop-status pop-status--near">
      ⚠️ 接近硬上限（${pct}%），宜扩建建筑或结束征战
    </div>`);
  }

  // ✅ 满员（已达硬上限，停止增长）
  if (!ps.inFamine && ratio >= 1.0) {
    labels.push(`<div class="pop-status pop-status--full">
      ✅ 已达硬上限，人口停止增长
    </div>`);
  }

  if (!labels.length) return '';
  return `<div class="pop-statuses">${labels.join('')}</div>`;
}

/**
 * 渲染人口面板 HTML。
 * 仅在 getPopState() 非空时渲染；否则返回空字符串（Bootstrap 确保登录后已拉取）。
 */
export function renderPopPanel(): string {
  const ps = getPopState();
  if (!ps) return '';

  const pop = interpolatePop();
  const ratio = ps.hardCap > 0 ? Math.min(1, pop / ps.hardCap) : 0;
  const ratioPct = (ratio * 100).toFixed(1);
  const prosperityPct = Math.round(ps.prosperityMult * 100);
  const growthSign = ps.growthPerHour >= 0 ? '+' : '';

  // 进度条颜色类
  const barClass = ps.inFamine
    ? ' pop-bar-fill--famine'
    : (ratio >= 0.85 ? ' pop-bar-fill--near' : '');

  // 五轴繁荣度系数（全 = prosperityMult）
  const lm = ps.laborMults;
  const laborGrid = `
    <div class="pop-labor-grid">
      <span class="pop-labor-item"><i>资源产率</i><b>${multPct(lm.production)}</b></span>
      <span class="pop-labor-item pop-labor-build"><i>建造速度</i><b>${multPct(lm.build)}</b></span>
      <span class="pop-labor-item"><i>练兵速率</i><b>${multPct(lm.train)}</b></span>
      <span class="pop-labor-item"><i>研究速率</i><b>${multPct(lm.research)}</b></span>
      <span class="pop-labor-item"><i>锻造速率</i><b>${multPct(lm.smithy)}</b></span>
    </div>`;

  // 人口构成（硬上限 = 平民 + 士兵）
  let popBreakHtml = '';
  if (ps.soldierPop > 0) {
    popBreakHtml = `<div class="pop-breakdown hint-sm">
      硬上限 ${fmt(ps.hardCap)}
      = 平民 ${fmt(ps.currentPop)} + 士兵 ${fmt(ps.soldierPop)}
    </div>`;
  }

  const statusLabels = renderStatusLabels(ps, pop);

  return `<div class="pop-panel">
    <div class="pop-head">
      <span class="pop-current" id="pop-current">${fmt(pop)}</span>
      <span class="pop-slash">/</span>
      <span class="pop-limit">${fmt(ps.hardCap)}</span>
      <small class="hint-sm pop-pct">${ratioPct}%</small>
    </div>
    <div class="pop-bar-wrap" title="劳动人口占硬上限 ${ratioPct}%">
      <div class="pop-bar-fill${barClass}" id="pop-bar-fill" style="width:${ratioPct}%"></div>
    </div>
    <div class="pop-meta">
      <span class="pop-stat"><i>增长</i><b>${growthSign}${Math.round(ps.growthPerHour)}/h</b></span>
      <span class="pop-stat"><i>劳动占比</i><b>${Math.round(ratio * 100)}%</b></span>
      <span class="pop-stat"><i>士兵</i><b>${fmt(ps.soldierPop)}</b></span>
      <span class="pop-stat"><i>繁荣系数</i><b>${prosperityPct}%</b></span>
    </div>
    ${popBreakHtml}
    ${statusLabels}
    <div class="pop-labor">
      <div class="pop-labor-title">繁荣度系数（劳动占比 ≥${Math.round(ps.raceMin * 100)}% 时满值 100%）</div>
      ${laborGrid}
    </div>
  </div>`;
}

/**
 * 每秒调用：用本地外插值更新人口数字和进度条，不重建 DOM。
 * 仅当村庄页在渲染时才有效（#pop-current 存在）。
 */
export function syncPopDisplay(): void {
  const numEl = document.getElementById('pop-current') as HTMLElement | null;
  const barEl = document.getElementById('pop-bar-fill') as HTMLElement | null;
  if (!numEl) return;

  const ps = getPopState();
  if (!ps) return;

  const pop = interpolatePop();
  numEl.textContent = fmt(pop);

  if (barEl && ps.hardCap > 0) {
    const pct = Math.min(100, (pop / ps.hardCap) * 100);
    barEl.style.width = `${pct.toFixed(1)}%`;
  }
}

/**
 * PopulationChanged push 到达后，局部替换人口面板 DOM。
 * 仅当村庄页可见（.pop-panel 存在）时生效；不触发整页重渲，无 refreshAll 回环。
 */
export function rerenderPopPanel(): void {
  const el = document.querySelector<HTMLElement>('.pop-panel');
  if (!el) return;
  const newHtml = renderPopPanel();
  if (!newHtml) return;
  const temp = document.createElement('div');
  temp.innerHTML = newHtml;
  const newEl = temp.firstElementChild;
  if (newEl) el.replaceWith(newEl);
}

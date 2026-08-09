/**
 * 人口面板：劳动人口 / 硬上限 / 平民占比 / 繁荣度系数 / 五轴速率 / 增长。
 * v3 硬上限模型（对应设计文档 13/14）：
 *   硬上限由建筑提供；士兵占用人口；平民占总人口比例决定五轴繁荣度系数（资源/建造/练兵/研究/锻造）。
 *   繁荣度与硬上限解耦：建造/升级抬高硬上限不再降低繁荣度（否则「升级得负收益」）。
 * 本地外插：renderPopPanel() 生成含 id="pop-current"/"pop-bar-fill" 的 DOM；
 * bootstrap 的 1s 定时器调 syncPopDisplay() 按 growthPerHour 线性更新显示值，不发请求。
 * PopulationChanged push 到达时，由 handlePush 调 rerenderPopPanel() 局部刷新，禁止整页回环。
 */
import { fmt } from '../../shared/utils/format.js';
import { getPopState, interpolatePop, interpolateTotalPop } from '../../app/state.js';

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

  // ✅ 满员（已达硬上限，停止增长，但仍展示人口流动潜力）
  if (!ps.inFamine && ratio >= 1.0) {
    const capVal = fmt(ps.hardCap);
    const pot = ps.potentialGrowthPerHour ?? 0;
    const potStr = pot > 0 ? `（本可 +${pot}/h 增长，已被上限锁住）` : '';
    labels.push(`<div class="pop-status pop-status--full">
      ✅ 已达人口硬上限（${capVal}），人口停止增长${potStr}
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

  const pop = interpolateTotalPop(); // v4 解耦：占用人口 = 劳动人口（士兵不计入人口上限）
  const rawRatio = ps.hardCap > 0 ? pop / ps.hardCap : 0;
  const ratio = Math.min(1, rawRatio);
  const atCap = !ps.inFamine && rawRatio >= 1.0;
  const ratioPct = (ratio * 100).toFixed(1);
  const prosperityPct = Math.round(ps.prosperityMult * 100);
  // 达上限时展示原始增长潜力（被上限锁住），否则展示真实增长
  const growthDisplay = atCap ? (ps.potentialGrowthPerHour ?? 0) : ps.growthPerHour;
  const growthSign = growthDisplay >= 0 ? '+' : '';
  const growthNote = atCap ? ' <small class="hint-sm pop-capped">上限·不增长</small>' : '';
  // 劳动人口 = 占用人口（v4 解耦：士兵不占人口，故劳动人口即为 pop 本身）
  const laborPop = Math.round(pop);
  // 平民占比（驱动繁荣度）= 劳动人口 / 总人口（服务端口径 ps.laborRatio，已与硬上限解耦）
  const laborRatioPct = Math.round((ps.laborRatio ?? 0) * 100);

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

  // 人口构成明细：默认隐藏，hover 人口数字时展开（平民 + 军队；军队不占人口上限）
  const popBreakHtml = `<div class="pop-breakdown">平民(劳动) ${fmt(laborPop)} · 军队 ${fmt(ps.soldierPop)}（不占人口）</div>`;

  const statusLabels = renderStatusLabels(ps, pop);

  return `<div class="pop-panel">
    <div class="pop-head" title="人口 ${fmt(pop)} / ${fmt(ps.hardCap)}（平民）· 军队 ${fmt(ps.soldierPop)}（不占人口上限）">
      <span class="pop-current" id="pop-current">${fmt(pop)}</span>
      <span class="pop-slash">/</span>
      <span class="pop-limit">${fmt(ps.hardCap)}</span>
      <small class="hint-sm pop-pct">${ratioPct}%</small>
      ${popBreakHtml}
    </div>
    <div class="pop-bar-wrap" title="人口占用 ${ratioPct}%（${fmt(pop)}/${fmt(ps.hardCap)}）">
      <div class="pop-bar-fill${barClass}" id="pop-bar-fill" style="width:${ratioPct}%"></div>
    </div>
    <div class="pop-meta">
      <span class="pop-stat"><i>增长</i><b>${growthSign}${Math.round(growthDisplay)}/h${growthNote}</b></span>
      <span class="pop-stat"><i>平民占比</i><b>${laborRatioPct}%</b></span>
      <span class="pop-stat"><i>士兵</i><b>${fmt(ps.soldierPop)}</b></span>
      <span class="pop-stat"><i>繁荣系数</i><b>${prosperityPct}%</b></span>
    </div>
    ${statusLabels}
    <div class="pop-labor">
      <div class="pop-labor-title">繁荣度系数（平民占总人口比例 currentPop/(currentPop+soldierPop) ≥${Math.round((ps.popProsperityFullRatio ?? 0.7) * 100)}% 时满值 100%；v4 解耦后士兵不再占用人口上限/不再先扣后补人口，但军队规模仍影响繁荣度与动员上限，士兵只额外增加军晌耗粮）</div>
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

  const pop = interpolateTotalPop();
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

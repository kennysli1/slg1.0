/**
 * 人口面板：当前人口 / 软上限 / 增长率 / 充裕比 / 伤兵 / 劳动力加成。
 * v2 新增：totalPop、garrisonPop、laborRatio、cropDeficitRate、inFamine 展示；
 *         4 个状态标签区（饥荒 / 接近饱和 / 重伤 / 满员）。
 *
 * 本地外插：renderPopPanel() 生成含 id="pop-current"/"pop-bar-fill" 的 DOM；
 * bootstrap 的 1s 定时器调 syncPopDisplay() 按 growthPerHour 线性更新显示值，
 * 不发请求。服务端每 5s refreshAll() 校正权威值。
 * PopulationChanged push 到达时，由 handlePush 调 rerenderPopPanel() 局部刷新，
 * 禁止触发 refreshAll/GetPopulation 回环。
 */
import { fmt } from '../../shared/utils/format.js';
import { secStr } from '../../shared/utils/format.js';
import { escapeHtml } from '../../shared/ui/widgets.js';
import { getPopState, interpolatePop } from '../../app/state.js';

/** 速率类 mult → 额外加成 "±XX%" */
function multPct(mult: number): string {
  const extra = Math.round((mult - 1) * 100);
  return `${extra >= 0 ? '+' : ''}${extra}%`;
}

/** time_mult（建造） → 节省百分比文字。0.80 → "节省 20%" */
function buildSaveStr(timeMult: number): string {
  const save = Math.round((1 - (1 / Math.max(1, timeMult))) * 100);
  return save > 0 ? `节省 ${save}%` : '无额外加速';
}

/**
 * 生成 4 个可选状态标签区的 HTML（饥荒/接近饱和/重伤/满员）。
 * 每个标签仅在满足条件时出现；均不满足则返回空字符串。
 */
function renderStatusLabels(ps: NonNullable<ReturnType<typeof getPopState>>, pop: number): string {
  const labels: string[] = [];

  // 🚨 饥荒中（currentPop > softLimit 且服务端已触发 famine_reduction 事件）
  if (ps.inFamine) {
    const excess = ps.softLimit > 0 ? Math.max(0, Math.round(ps.currentPop - ps.softLimit)) : 0;
    const excessStr = excess > 0 ? `，超出软上限 ${escapeHtml(String(excess))} 人` : '';
    labels.push(`<div class="pop-status pop-status--famine">
      🚨 饥荒中${excessStr}，人口正在减少
    </div>`);
  }

  // ⚠️ 接近饱和（85%–100% 但未超限）
  if (!ps.inFamine && ps.softLimit > 0 && pop / ps.softLimit >= 0.85 && pop < ps.softLimit) {
    const pct = Math.round((pop / ps.softLimit) * 100);
    labels.push(`<div class="pop-status pop-status--near">
      ⚠️ 接近饱和（${pct}%），宜扩建农业或结束征战
    </div>`);
  }

  // ✅ 满员（已达软上限，停止增长）
  if (!ps.inFamine && ps.softLimit > 0 && pop >= ps.softLimit) {
    labels.push(`<div class="pop-status pop-status--full">
      ✅ 已达软上限，人口停止增长
    </div>`);
  }

  // 🩹 重伤（伤兵占总人口 ≥ 20%）
  const totalForRatio = ps.totalPop > 0 ? ps.totalPop : ps.currentPop + ps.wounded.total;
  if (totalForRatio > 0 && ps.wounded.total / totalForRatio >= 0.2) {
    const wPct = Math.round((ps.wounded.total / totalForRatio) * 100);
    labels.push(`<div class="pop-status pop-status--wound">
      🩹 重伤：伤兵占 ${wPct}%，暂无法参战
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
  const pct = ps.softLimit > 0
    ? Math.min(100, (pop / ps.softLimit) * 100).toFixed(1)
    : '0';
  const lambdaPct = Math.round(ps.lambdaRatio * 100);
  const growthSign = ps.growthPerHour >= 0 ? '+' : '';

  // 进度条颜色类
  const barClass = ps.inFamine
    ? ' pop-bar-fill--famine'
    : (ps.softLimit > 0 && pop / ps.softLimit >= 0.85 ? ' pop-bar-fill--near' : '');

  // 劳动力加成显示
  const lm = ps.laborMults;
  const prodAvg = lm.production;
  const trainMin = lm.train;

  // 伤兵信息（带占比 & 治愈倒计时）
  let woundedHtml = '';
  if (ps.wounded.total > 0) {
    const totalForRatio = ps.totalPop > 0 ? ps.totalPop : ps.currentPop + ps.wounded.total;
    const wPct = totalForRatio > 0 ? Math.round((ps.wounded.total / totalForRatio) * 100) : 0;
    let healInfo = '';
    if (ps.wounded.entries?.length) {
      const soonestHealAt = Math.min(...ps.wounded.entries.map((e) => e.healAt));
      healInfo = `，<b class="progress-time" data-pop-heal="${soonestHealAt}">${secStr(soonestHealAt)}</b>后首批归队`;
    }
    woundedHtml = `<div class="pop-wounded">
      <span class="pop-wounded-icon">🩹</span>
      <span>伤兵 <b class="pop-wounded-count">${fmt(ps.wounded.total)}</b> 人（占 ${wPct}%）正在休养${healInfo}</span>
    </div>`;
  }

  // 总人口分类行（totalPop / garrisonPop 展示）
  const totalPop = ps.totalPop > 0 ? ps.totalPop : (ps.currentPop + ps.garrisonPop + ps.wounded.total);
  let popBreakHtml = '';
  if (ps.garrisonPop > 0 || ps.wounded.total > 0) {
    popBreakHtml = `<div class="pop-breakdown hint-sm">
      总 ${fmt(totalPop)}
      ${ps.garrisonPop > 0 ? `= 平民 ${fmt(ps.currentPop)} + 驻军 ${fmt(ps.garrisonPop)}${ps.wounded.total > 0 ? ` + 伤兵 ${fmt(ps.wounded.total)}` : ''}` : ''}
    </div>`;
  }

  // 劳动力比展示
  const laborRatioPct = Math.round(ps.laborRatio * 100);
  const laborRatioHtml = ps.laborRatio > 0
    ? `<span class="pop-stat"><i>劳动比</i><b>${laborRatioPct}%</b></span>`
    : '';

  // 饥荒中：显示超出软上限的人口数（赤字速率需粮食数据，快照无此字段）
  const excessPop = ps.inFamine && ps.softLimit > 0 ? Math.max(0, Math.round(ps.currentPop - ps.softLimit)) : 0;
  const deficitHtml = excessPop > 0
    ? `<span class="pop-stat pop-stat-deficit"><i>超限</i><b class="pop-deficit">+${excessPop}</b></span>`
    : '';

  const statusLabels = renderStatusLabels(ps, pop);

  return `<div class="pop-panel">
    <div class="pop-head">
      <span class="pop-current" id="pop-current">${fmt(pop)}</span>
      <span class="pop-slash">/</span>
      <span class="pop-limit">${fmt(ps.softLimit)}</span>
      <small class="hint-sm pop-pct">${pct}%</small>
    </div>
    <div class="pop-bar-wrap" title="平民占软上限 ${pct}%">
      <div class="pop-bar-fill${barClass}" id="pop-bar-fill" style="width:${pct}%"></div>
    </div>
    <div class="pop-meta">
      <span class="pop-stat"><i>增长</i><b>${growthSign}${Math.round(ps.growthPerHour)}/h</b></span>
      <span class="pop-stat"><i>充裕比</i><b>${lambdaPct}%</b></span>
      ${laborRatioHtml}
      ${deficitHtml}
      ${ps.wounded.total > 0
        ? `<span class="pop-stat pop-stat-wound"><i>伤兵</i><b>${fmt(ps.wounded.total)}</b></span>`
        : ''}
    </div>
    ${popBreakHtml}
    ${woundedHtml}
    ${statusLabels}
    <div class="pop-labor">
      <div class="pop-labor-title">繁荣度额外加成</div>
      <div class="pop-labor-grid">
        <span class="pop-labor-item"><i>资源产率</i><b>${multPct(prodAvg)}</b></span>
        <span class="pop-labor-item pop-labor-build"><i>建造</i><b>${buildSaveStr(lm.build)}</b></span>
        <span class="pop-labor-item"><i>练兵速率</i><b>${multPct(trainMin)}</b></span>
      </div>
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

  if (barEl && ps.softLimit > 0) {
    const pct = Math.min(100, (pop / ps.softLimit) * 100);
    barEl.style.width = `${pct.toFixed(1)}%`;
  }

  // 同步伤兵治愈倒计时
  document.querySelectorAll<HTMLElement>('[data-pop-heal]').forEach((el) => {
    const healAt = Number(el.dataset.popHeal);
    if (healAt) el.textContent = secStr(healAt);
  });
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

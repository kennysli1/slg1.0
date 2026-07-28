/**
 * 人口面板：当前人口 / 软上限 / 增长率 / 充裕比 / 伤兵 / 劳动力加成。
 *
 * 本地外插：renderPopPanel() 生成含 id="pop-current"/"pop-bar-fill" 的 DOM；
 * bootstrap 的 1s 定时器调 syncPopDisplay() 按 growthPerHour 线性更新显示值，
 * 不发请求。服务端每 5s refreshAll() 校正权威值。
 */
import { fmt } from '../../shared/utils/format.js';
import { secStr } from '../../shared/utils/format.js';
import { getPopState, interpolatePop } from '../../app/state.js';

/** 速率类 mult → "XX%" */
function multPct(mult: number): string {
  return `${Math.round(mult * 100)}%`;
}

/** time_mult（建造） → 节省百分比文字。0.80 → "节省 20%" */
function buildSaveStr(timeMult: number): string {
  const save = Math.round((1 - timeMult) * 100);
  return save > 0 ? `节省 ${save}%` : '无加速';
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

  // 劳动力加成显示
  const lm = ps.laborMults;
  // 产率：四种资源的简单平均（对玩家最直观）
  const prodAvg = (lm.production.wood + lm.production.clay + lm.production.iron + lm.production.crop) / 4;
  // 练兵：取三个军事建筑的最小值（展示最弱短板）
  const trainMin = Math.min(lm.train.barracks, lm.train.stable, lm.train.workshop);

  // 伤兵信息
  let woundedHtml = '';
  if (ps.wounded.total > 0) {
    let healInfo = '';
    if (ps.wounded.entries?.length) {
      const soonestHealAt = Math.min(...ps.wounded.entries.map((e) => e.healAt));
      healInfo = `，<b class="progress-time" data-pop-heal="${soonestHealAt}">${secStr(soonestHealAt)}</b>后首批归队`;
    }
    woundedHtml = `<div class="pop-wounded">
      <span class="pop-wounded-icon">🩹</span>
      <span>伤兵 <b class="pop-wounded-count">${fmt(ps.wounded.total)}</b> 人正在休养${healInfo}</span>
    </div>`;
  }

  return `<div class="pop-panel">
    <div class="pop-head">
      <span class="pop-current" id="pop-current">${fmt(pop)}</span>
      <span class="pop-slash">/</span>
      <span class="pop-limit">${fmt(ps.softLimit)}</span>
      <small class="hint-sm pop-pct">${pct}%</small>
    </div>
    <div class="pop-bar-wrap" title="人口占软上限 ${pct}%">
      <div class="pop-bar-fill" id="pop-bar-fill" style="width:${pct}%"></div>
    </div>
    <div class="pop-meta">
      <span class="pop-stat"><i>增长</i><b>${growthSign}${Math.round(ps.growthPerHour)}/h</b></span>
      <span class="pop-stat"><i>充裕比</i><b>${lambdaPct}%</b></span>
      ${ps.wounded.total > 0
        ? `<span class="pop-stat pop-stat-wound"><i>伤兵</i><b>${fmt(ps.wounded.total)}</b></span>`
        : ''}
    </div>
    ${woundedHtml}
    <div class="pop-labor">
      <div class="pop-labor-title">劳动力加成</div>
      <div class="pop-labor-grid">
        <span class="pop-labor-item"><i>资源产率</i><b>${multPct(prodAvg)}</b></span>
        <span class="pop-labor-item pop-labor-build"><i>建造</i><b>${buildSaveStr(lm.build)}</b></span>
        <span class="pop-labor-item"><i>练兵速率</i><b>${multPct(trainMin)}</b></span>
        <span class="pop-labor-item"><i>锻造速率</i><b>${multPct(lm.smithy)}</b></span>
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

  // 同步伤兵治愈倒计时（progress-time 类节点由 syncTimers 处理，但 data-pop-heal 也需更新）
  document.querySelectorAll<HTMLElement>('[data-pop-heal]').forEach((el) => {
    const healAt = Number(el.dataset.popHeal);
    if (healAt) el.textContent = secStr(healAt);
  });
}

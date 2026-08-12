/** 通用格式化助手（纯函数）。 */

export const fmt = (n: number) => Math.floor(n).toLocaleString();

/**
 * 把**时长**（毫秒）渲染成「X时Y分Z秒」。
 *
 * 注意与 `secLeft` 的区别：本函数收的是**间隔**，不是时刻。
 * 曾经只有一个收「目标时刻」的函数，调用方普遍误传时长，
 * 于是 `ms - Date.now()` 变成大负数被夹到 0，界面上耗时一律显示「0秒」。
 * 现在把时长格式化拆成独立原语，时刻类只是它的一层包装。
 */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}时${m}分`;
  return m > 0 ? `${m}分${sec}秒` : `${sec}秒`;
}

/** 把「目标时刻(ms)」渲染成剩余时长。内部就是 fmtDur(目标时刻 − 现在)。 */
export function secLeft(untilMs: number): string {
  return fmtDur(untilMs - Date.now());
}

/**
 * 同 `secLeft`（语义上偏"战场/事件倒计时"，如 IncomingAttack 的预计抵达）。
 * 单独导出一份，方便旧调用点 `import { secStr } from '../shared/utils/format.js'` 继续可用。
 */
export const secStr = secLeft;

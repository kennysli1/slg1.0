/**
 * 轻量全局 Toast：非阻塞提示（如"队列已满"）。
 * 纯前端、无依赖：往 body 注入 .toast 元素，短暂停留后淡出移除。
 * 与"报告"区分工——报告是可回溯的历史流水，toast 是当下的即时反馈。
 */

const STAY_MS = 2400; // 完整显示时长
const FADE_MS = 260; // 淡出动画时长（与 style.css 的 .toast--out 过渡一致）

/** 弹出一条即时提示。多条会纵向堆叠（后进在下）。 */
export function showToast(msg: string): void {
  if (typeof document === 'undefined') return;
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  host.appendChild(el);

  window.setTimeout(() => {
    el.classList.add('toast--out');
    window.setTimeout(() => el.remove(), FADE_MS);
  }, STAY_MS);
}

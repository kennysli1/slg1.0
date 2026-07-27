/**
 * 共享 UI 原子：图标渲染、消耗预览、进度条。
 * 图标列只存**基名**；这里统一拼成 /art/<基名>.png，加载失败回退文字徽标。
 */
import { fmt, secStr } from '../utils/format.js';
import { resInfo, resourceKeys } from '../../app/config.js';
import { getCache } from '../../app/state.js';

const ART_BASE = '/art/';
export const artPath = (base: string) => `${ART_BASE}${base}.png`;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escapeAttr(value: unknown): string {
  return escapeHtml(value);
}

/** 统一图标渲染：传图标基名，输出 <img>，加载失败由 installIconFallback 就地换成文字徽标。size: xs|sm|md|lg|xl */
export function art(icon: string, label: string, size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' = 'md'): string {
  const safe = escapeAttr(label);
  const src = escapeAttr(artPath(icon));
  return `<img class="icon icon-${size}" src="${src}" alt="${safe}" title="${safe}" loading="lazy" />`;
}

/**
 * 全局图标兜底：任何 <img class="icon"> 加载失败（美术未就位/404）时，就地替换为
 * .icon-fallback 文字徽标（显示 alt 文本，沿用原尺寸类）。
 * 实现 style.css 与美术清单声明的"加载失败回退文字徽标"规范——此前只有 CSS/规范、无 JS 接线。
 * img 的 error 事件不冒泡，故用捕获阶段在 document 上统一监听；启动时装一次即覆盖全部（含后续动态渲染）。
 */
export function installIconFallback(): void {
  document.addEventListener('error', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLImageElement) || !el.classList.contains('icon')) return;
    const label = el.getAttribute('alt') ?? '';
    const span = document.createElement('span');
    span.className = `${el.className} icon-fallback`;
    span.textContent = label;
    span.title = label;
    el.replaceWith(span);
  }, true);
}

/** 兵种图标基名：服务器若下发 icon 基名优先用，否则按 code 约定拼 unit_<code>。 */
export const unitArt = (code: string) => `unit_${code}`;

/** 是否买得起。 */
export function canAfford(cost: Record<string, number> | null): boolean {
  if (!cost) return false;
  const have = getCache().res?.resources;
  if (!have) return false;
  return resourceKeys().every((r) => (have[r] ?? 0) >= (cost[r] ?? 0));
}

/** 消耗预览：带资源图标，买不起的项标红。 */
export function costPreview(cost: Record<string, number> | null, timeSec?: number | null): string {
  if (!cost) return '';
  const have = getCache().res?.resources ?? {};
  const items = resourceKeys().filter((r) => (cost[r] ?? 0) > 0).map((r) => {
    const lack = (have[r] ?? 0) < (cost[r] ?? 0);
    const info = resInfo(r);
    return `<span class="cost-item${lack ? ' cost-lack' : ''}">${art(info.icon, info.name, 'xs')}${fmt(cost[r])}</span>`;
  }).join('');
  const time = timeSec ? `<span class="cost-time">⏱ ${secStr(Date.now() + timeSec * 1000)}</span>` : '';
  return `<div class="cost">${items}${time}</div>`;
}

/** 进度条 HTML（用 data 属性记录起止，由计时器更新宽度与剩余文字）。 */
export function progressBar(startAt: number, finishAt: number, label: string): string {
  const total = Math.max(1, finishAt - startAt);
  const pct = Math.min(100, Math.max(0, ((Date.now() - startAt) / total) * 100));
  return `<div class="progress" data-start="${startAt}" data-finish="${finishAt}">
    <i class="progress-fill" style="width:${pct}%"></i>
    <span class="progress-label">${escapeHtml(label)} · 剩 <b class="progress-time">${secStr(finishAt)}</b></span></div>`;
}

/** 刷新所有进度条的宽度与剩余时间文字（每秒调用）。 */
export function syncTimers() {
  document.querySelectorAll<HTMLElement>('.progress').forEach((el) => {
    const start = Number(el.dataset.start), finish = Number(el.dataset.finish);
    const total = Math.max(1, finish - start);
    const pct = Math.min(100, Math.max(0, ((Date.now() - start) / total) * 100));
    const fill = el.querySelector<HTMLElement>('.progress-fill');
    const time = el.querySelector<HTMLElement>('.progress-time');
    if (fill) fill.style.width = `${pct}%`;
    if (time) time.textContent = secStr(finish);
  });
}

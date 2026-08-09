/**
 * 共享 UI 原子：图标渲染、消耗预览、进度条。
 * 图标列只存**基名**；这里统一拼成 /art/<基名>.png，加载失败回退文字徽标。
 */
import { fmt, secStr } from '../utils/format.js';
import { resInfo, resourceKeys, unitInfo } from '../../app/config.js';
import { liveResources } from '../../app/state.js';
import { escapeHtml, escapeAttr } from '../utils/escape.js';
export { escapeHtml, escapeAttr };

const ART_BASE = '/art/';
export const artPath = (base: string) => `${ART_BASE}${base}.png`;

const UNIT_ART_FALLBACKS: Record<string, string> = {
  phalanx: 'unit_praetorian',
  swordsman: 'unit_imperian',
  pathfinder: 'unit_equlegati',
  theutates: 'unit_equimperatoris',
  druidrider: 'unit_equimperatoris',
  haeduan: 'unit_equcaesaris',
  gaulram: 'unit_ram',
  gcaultrebuchet: 'unit_catapult',
  gaulchief: 'unit_senator',
  gaulsettler: 'unit_settler',
  clubswinger: 'unit_legionnaire',
  spearman: 'unit_praetorian',
  axeman: 'unit_imperian',
  teuscout: 'unit_equlegati',
  paladin: 'unit_equimperatoris',
  teutonknight: 'unit_equcaesaris',
  teuram: 'unit_ram',
  teucatapult: 'unit_catapult',
  teuchief: 'unit_senator',
  teusettler: 'unit_settler',
};


/** 统一图标渲染：传图标基名，输出 <img>，加载失败由 installIconFallback 就地换成文字徽标。size: xs|sm|md|lg|xl */
export function art(icon: string, label: string, size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' = 'md', fallbackIcon?: string): string {
  const safe = escapeAttr(label);
  const src = escapeAttr(artPath(icon));
  const fallback = fallbackIcon ? ` data-fallback-src="${escapeAttr(artPath(fallbackIcon))}"` : '';
  return `<img class="icon icon-${size}" src="${src}" alt="${safe}" title="${safe}" loading="lazy"${fallback} />`;
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
    const fallbackSrc = el.dataset.fallbackSrc;
    if (fallbackSrc && el.src !== fallbackSrc) {
      delete el.dataset.fallbackSrc;
      el.src = fallbackSrc;
      return;
    }
    const label = el.getAttribute('alt') ?? '';
    const span = document.createElement('span');
    span.className = `${el.className} icon-fallback`;
    span.textContent = label;
    span.title = label;
    el.replaceWith(span);
  }, true);
}

/** 兵种图标基名：服务器若下发 icon 基名优先用，否则按 code 约定拼 unit_<code>。 */
export const unitArt = (code: string) => unitInfo(code).icon ?? `unit_${code}`;
export const unitArtFallback = (code: string) => UNIT_ART_FALLBACKS[code];

/** 是否买得起。读 liveResources()（与资源条同源外插），避免资源条显示充足但快照为旧值/缺键误报「资源不足」。 */
export function canAfford(cost: Record<string, number> | null): boolean {
  if (!cost) return false;
  const have = liveResources();
  return resourceKeys().every((r) => (have[r] ?? 0) >= (cost[r] ?? 0));
}

/** 消耗预览：带资源图标，买不起的项标红。popCap>0 时在资源末尾追加一个人口项（图标+数字，与资源同形）。 */
export function costPreview(cost: Record<string, number> | null, timeSec?: number | null, popCap?: number): string {
  if (!cost) return '';
  const have = liveResources();
  const items = resourceKeys().filter((r) => (cost[r] ?? 0) > 0).map((r) => {
    const lack = (have[r] ?? 0) < (cost[r] ?? 0);
    const info = resInfo(r);
    return `<span class="cost-item${lack ? ' cost-lack' : ''}">${art(info.icon, info.name, 'xs')}${fmt(cost[r])}</span>`;
  });
  if (popCap && popCap > 0) {
    items.push(`<span class="cost-item cost-pop" title="每级人口上限">👥+${popCap}</span>`);
  }
  const time = timeSec ? `<span class="cost-time">⏱ ${secStr(Date.now() + timeSec * 1000)}</span>` : '';
  return `<div class="cost">${items.join('')}${time}</div>`;
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

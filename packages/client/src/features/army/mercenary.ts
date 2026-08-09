/**
 * 雇佣兵营地招募 UI（右侧抽屉）。
 * 点击村庄里已建好的「雇佣兵营地」建筑卡打开。展示当前可雇佣名单、持有金币、刷新进度，
 * 并提供「雇佣（花金币）」与「手动刷新（消耗存储次数）」操作。
 * 所有交互经传入的 act() 执行（act 负责发请求 + 刷新资源条 + 战报），抽屉本身额外 re-render 以刷新名单。
 */
import { req } from '../../api.js';
import { art, escapeHtml, escapeAttr } from '../../shared/ui/widgets.js';
import { resInfo } from '../../app/config.js';
import { fmt } from '../../shared/utils/format.js';

/** 抽屉是否打开（供全局 push 触发刷新）。 */
let campWrap: HTMLElement | null = null;
/** 统一的「发请求并刷新」回调（由 village.bindVillage 注入）。 */
let actFn: ((p: Promise<any>) => void) | null = null;

export function closeMercenaryCamp(): void {
  campWrap?.remove();
  campWrap = null;
}

/** 由全局 push（MercenaryCampUpdated）触发：营地抽屉打开时刷新内容。 */
export function refreshMercCampIfOpen(): void {
  if (campWrap) void renderCamp();
}

/** 打开雇佣兵营地抽屉。 */
export function openMercenaryCamp(act: (p: Promise<any>) => void): void {
  actFn = act;
  closeMercenaryCamp();
  const wrap = document.createElement('div');
  wrap.id = 'merc-camp-modal';
  wrap.innerHTML = `<div class="drawer-mask" data-close-merc="1"></div>
    <aside class="drawer drawer--opening merc-drawer drawer--center" role="dialog" aria-modal="true">
      <div class="drawer-head"><span class="merc-drawer-title">雇佣兵营地</span><button class="drawer-close" data-close-merc="1" aria-label="关闭">✕</button></div>
      <div class="drawer-body"><div class="loading">加载中…</div></div>
    </aside>`;
  document.body.appendChild(wrap);
  campWrap = wrap;
  wrap.querySelectorAll<HTMLElement>('[data-close-merc]').forEach((el) => el.onclick = () => closeMercenaryCamp());
  void renderCamp();
}

/** 拉取营地状态并渲染抽屉内容。 */
async function renderCamp(): Promise<void> {
  if (!campWrap) return;
  const aside = campWrap.querySelector<HTMLElement>('.merc-drawer');
  if (!aside) return;
  const body = aside.querySelector<HTMLElement>('.drawer-body');
  if (!body) return;

  const res = await req('GetMercCamp');
  if (!res.ok) {
    body.innerHTML = `<div class="hint-sm">加载失败：${escapeHtml(res.error?.code ?? '未知')}</div>`;
    return;
  }
  const c = res.payload as any;
  if (!c.built) {
    body.innerHTML = `<div class="hint-sm">尚未建造雇佣兵营地。请到「城外」空槽建造后，再来此招募。</div>`;
    return;
  }

  const gold = c.gold ?? 0;
  const goldInfo = resInfo('gold');
  const nextIn = Math.max(0, Math.ceil((c.nextRefreshAt - Date.now()) / 1000));

  // 可雇佣名单：每个名额一张卡，带雇佣按钮（金币不足置灰）
  const offersHtml = (c.offers || []).map((o: any) => {
    const afford = gold >= (o.goldCost ?? 0);
    const formLabel = o.form === 'ranged' ? '远程' : '近战';
    return `<div class="merc-offer">
      ${art(o.icon, o.name, 'md')}
      <div class="merc-offer-body">
        <div class="merc-offer-title">${escapeHtml(o.name)} <small class="tag">${formLabel}</small></div>
        <div class="merc-stats">近攻 ${o.meleeAtk} · 近防 ${o.meleeDef} · 远攻 ${o.rangedAtk} · 速 ${o.speed}</div>
        <button class="btn-sm" data-hire="${escapeAttr(o.code)}" ${!afford ? 'disabled' : ''}>雇佣 · ${o.goldCost}金</button>
      </div>
    </div>`;
  }).join('') || '<div class="hint-sm">当前无可雇佣名额。点「手动刷新」或等待自动刷新。</div>';

  const refreshBtn = c.storedRefreshes > 0
    ? `<button class="btn-sm" data-merc-refresh>手动刷新 (${c.storedRefreshes}/${c.maxStored})</button>`
    : '<small class="tag">无存储刷新次数</small>';

  body.innerHTML = `
    <div class="merc-gold">${art(goldInfo.icon, goldInfo.name, 'xs')} 持有金币 <b>${fmt(gold)}</b></div>
    <div class="merc-refresh-row">${refreshBtn}<small class="hint-sm">每 ${c.refreshSec}s 自动刷新一批（囤积上限 ${c.maxStored}）</small></div>
    <div class="merc-next">下次自动刷新：约 ${nextIn}s</div>
    <div class="drawer-sec-title">可雇佣 <small>（金币购买 · 永久持有 · 不耗粮不占人口）</small></div>
    <div class="merc-offers">${offersHtml}</div>`;

  aside.querySelectorAll<HTMLElement>('[data-close-merc]').forEach((el) => el.onclick = () => closeMercenaryCamp());

  aside.querySelectorAll<HTMLButtonElement>('[data-hire]').forEach((b) => b.onclick = async () => {
    if (!actFn) return;
    const code = b.dataset.hire!;
    await actFn(req('HireMerc', { code }));
    void renderCamp(); // 招募后重拉名单（该名额已消费）
  });

  const rb = aside.querySelector<HTMLButtonElement>('[data-merc-refresh]');
  if (rb) rb.onclick = async () => {
    if (!actFn) return;
    await actFn(req('RefreshMercCamp'));
    void renderCamp(); // 重roll 名单
  };
}

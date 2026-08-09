/**
 * 贸易中心 UI（右侧抽屉）。
 * 点击村庄里已建好的「贸易中心」建筑卡打开。展示：
 *  - NPC 订单池（用金币买资源 / 卖资源换金币，即时交付，无需等待商队）。
 *  - 附近玩家挂单（视野半径内），可接单（双方各派商队，消耗贸易路线，返程回收）。
 *  - 我的挂单（可撤销），以及创建新订单的表单。
 * 所有交互经传入的 act() 执行（act 负责发请求 + 刷新资源条 + 战报），抽屉本身额外 re-render 以刷新内容。
 */
import { req } from '../../api.js';
import { art, escapeHtml, escapeAttr } from '../../shared/ui/widgets.js';
import { resInfo } from '../../app/config.js';
import { fmt } from '../../shared/utils/format.js';
import { tradeRouteCapacity, tradeCaravanSpeed } from '../../app/config.js';

/** 贸易涉及的全部资源（含金币；resources.csv 不登记 gold，故此处显式列出）。 */
const TRADE_RES = ['wood', 'clay', 'iron', 'crop', 'gold'] as const;

/** 抽屉是否打开（供全局 push 触发刷新）。 */
let wrap: HTMLElement | null = null;
/** 统一的「发请求并刷新」回调（由 village.bindVillage 注入）。 */
let actFn: ((p: Promise<any>) => void) | null = null;

export function closeTradeCenter(): void {
  wrap?.remove();
  wrap = null;
}

/** 由全局 push（TradeCenterUpdated）触发：抽屉打开时刷新内容。 */
export function refreshTradeIfOpen(): void {
  if (wrap) void render();
}

/** 打开贸易中心抽屉。 */
export function openTradeCenter(act: (p: Promise<any>) => void): void {
  actFn = act;
  closeTradeCenter();
  const el = document.createElement('div');
  el.id = 'trade-center-modal';
  el.innerHTML = `<div class="drawer-mask" data-close-trade="1"></div>
    <aside class="drawer drawer--opening trade-drawer drawer--center" role="dialog" aria-modal="true">
      <div class="drawer-head"><span class="trade-drawer-title">贸易中心</span><button class="drawer-close" data-close-trade="1" aria-label="关闭">✕</button></div>
      <div class="drawer-body"><div class="loading">加载中…</div></div>
    </aside>`;
  document.body.appendChild(el);
  wrap = el;
  el.querySelectorAll<HTMLElement>('[data-close-trade]').forEach((e) => e.onclick = () => closeTradeCenter());
  void render();
}

/** 把资源 map 渲染为展示片段（give=你获得 / want=你支付）。 */
function resChips(map: Record<string, number>, sign: '+' | '-'): string {
  const parts = TRADE_RES
    .filter((k) => (map[k] ?? 0) > 0)
    .map((k) => {
      const info = resInfo(k);
      return `<span class="chip ${sign === '-' ? 'chip--pay' : 'chip--get'}">${art(info.icon, info.name, 'xs')}${sign}${fmt(map[k])}</span>`;
    });
  return parts.length ? parts.join('') : '<span class="hint-sm">无</span>';
}

/** 拉取贸易中心状态并渲染抽屉内容。 */
async function render(): Promise<void> {
  if (!wrap) return;
  const aside = wrap.querySelector<HTMLElement>('.trade-drawer');
  if (!aside) return;
  const body = aside.querySelector<HTMLElement>('.drawer-body');
  if (!body) return;

  const res = await req('GetTradeCenter');
  if (!res.ok) {
    body.innerHTML = `<div class="hint-sm">加载失败：${escapeHtml(res.error?.code ?? '未知')}</div>`;
    return;
  }
  const c = res.payload as any;
  if (!c.built) {
    body.innerHTML = `<div class="hint-sm">尚未建造贸易中心。请到「城外」空槽建造后，再来此贸易。</div>`;
    return;
  }

  const gold = c.gold ?? 0;
  const goldInfo = resInfo('gold');
  const cap = tradeRouteCapacity();
  const nextIn = Math.max(0, Math.ceil((c.npcNextRefreshAt - Date.now()) / 1000));
  const refreshBtn = c.npcStoredRefreshes > 0
    ? `<button class="btn-sm" data-trade-refresh>手动刷新 (${c.npcStoredRefreshes}/${c.npcMaxStored})</button>`
    : '<small class="tag">无存储刷新次数</small>';

  // NPC 订单
  const npcHtml = (c.npcOrders || []).map((o: any) => {
    const canPay = TRADE_RES.every((k) => (gold >= (o.want[k] ?? 0)));
    const sellSide = (o.give.gold ?? 0) > 0; // 玩家卖出资源换金币
    const tag = sellSide ? '卖' : '买';
    return `<div class="trade-offer">
      <div class="trade-offer-head"><span class="tag">NPC·${tag}</span><small class="hint-sm">来源 ${o.distance}格</small></div>
      <div class="trade-line"><small>获得</small>${resChips(o.give, '+')}</div>
      <div class="trade-line"><small>支付</small>${resChips(o.want, '-')}</div>
      <button class="btn-sm" data-accept-npc="${escapeAttr(o.id)}" ${!canPay ? 'disabled' : ''}>成交（即时交付）</button>
    </div>`;
  }).join('') || '<div class="hint-sm">暂无可交易 NPC 订单。</div>';

  // 附近玩家挂单
  const playerHtml = (c.playerOrders || []).map((o: any) => {
    const canRoutes = o.routesNeeded <= c.availableRoutes;
    const owner = o.ownerName ? escapeHtml(o.ownerName) : '玩家';
    return `<div class="trade-offer">
      <div class="trade-offer-head"><span class="tag tag--player">玩家 · ${owner}</span><small class="hint-sm">${o.distance}格 · 需 ${o.routesNeeded} 路线</small></div>
      <div class="trade-line"><small>提供</small>${resChips(o.give, '+')}</div>
      <div class="trade-line"><small>求购</small>${resChips(o.want, '-')}</div>
      <button class="btn-sm" data-accept-player="${escapeAttr(o.id)}" ${!canRoutes ? 'disabled' : ''}>接单（派商队）</button>
    </div>`;
  }).join('') || '<div class="hint-sm">视野内暂无其他玩家的贸易订单。</div>';

  // 我的挂单
  const myHtml = (c.myOrders || []).map((o: any) => {
    const ttlMin = Math.max(0, Math.ceil((o.ttlAt - Date.now()) / 60000));
    return `<div class="trade-offer trade-offer--mine">
      <div class="trade-offer-head"><span class="tag tag--mine">我的</span><small class="hint-sm">${ttlMin}分钟后续期</small></div>
      <div class="trade-line"><small>提供</small>${resChips(o.give, '+')}</div>
      <div class="trade-line"><small>求购</small>${resChips(o.want, '-')}</div>
      <button class="btn-sm btn-ghost" data-cancel-order="${escapeAttr(o.id)}">撤销</button>
    </div>`;
  }).join('') || '<div class="hint-sm">你还没有挂出订单。</div>';

  const orderLimit = c.playerOrderCurrent >= c.playerOrderMax;

  body.innerHTML = `
    <div class="trade-gold">${art(goldInfo.icon, goldInfo.name, 'xs')} 持有金币 <b>${fmt(gold)}</b></div>
    <div class="trade-routes">贸易路线 <b>${c.availableRoutes}/${c.tradeRoutes}</b> 可用 · 商队速度 ${tradeCaravanSpeed()} 格/时 · 每条运力 ${fmt(cap)}</div>
    <div class="trade-refresh-row">${refreshBtn}<small class="hint-sm">每 ${c.npcRefreshSec}s 自动刷新（囤积上限 ${c.npcMaxStored}）</small></div>
    <div class="trade-next">下次自动刷新：约 ${nextIn}s</div>

    <div class="drawer-sec-title">NPC 订单 <small>（即时交付）</small></div>
    <div class="trade-offers">${npcHtml}</div>

    <div class="drawer-sec-title">附近玩家订单 <small>（视野半径 ${c.viewRadius} 格内）</small></div>
    <div class="trade-offers">${playerHtml}</div>

    <div class="drawer-sec-title">我的挂单 <small>(${c.playerOrderCurrent}/${c.playerOrderMax})</small></div>
    <div class="trade-offers">${myHtml}</div>

    <div class="drawer-sec-title">创建订单</div>
    <div class="trade-create">
      ${TRADE_RES.map((k) => {
        const info = resInfo(k);
        return `<div class="trade-create-row">
          ${art(info.icon, info.name, 'xs')}<span class="trade-res-name">${escapeHtml(info.name)}</span>
          <label>提供<input type="number" min="0" step="1" data-give="${k}" placeholder="0"></label>
          <label>求购<input type="number" min="0" step="1" data-want="${k}" placeholder="0"></label>
        </div>`;
      }).join('')}
      <div class="trade-create-route">将占用路线：<b id="routeNeed">0</b> / 可用 ${c.availableRoutes}</div>
      <button class="btn-sm btn-primary" data-create-order ${orderLimit ? 'disabled' : ''}>${orderLimit ? '已达挂单上限' : '挂出订单'}</button>
    </div>`;

  wrap.querySelectorAll<HTMLElement>('[data-close-trade]').forEach((e) => e.onclick = () => closeTradeCenter());

  // 创建表单：实时预估路线占用
  const inputs = Array.from(wrap.querySelectorAll<HTMLInputElement>('input[data-give], input[data-want]'));
  const routeNeed = wrap.querySelector<HTMLElement>('#routeNeed');
  const computeRoutes = () => {
    let units = 0;
    inputs.forEach((i) => { units += Math.max(0, Math.floor(Number(i.value) || 0)); });
    const need = Math.ceil(units / Math.max(1, cap));
    if (routeNeed) routeNeed.textContent = String(need);
    return need;
  };
  inputs.forEach((i) => i.oninput = computeRoutes);
  computeRoutes();

  // NPC 成交（即时）
  wrap.querySelectorAll<HTMLButtonElement>('[data-accept-npc]').forEach((b) => b.onclick = async () => {
    if (!actFn) return;
    await actFn(req('AcceptNpcOrder', { orderId: b.dataset.acceptNpc }));
    void render();
  });
  // 接玩家单（派商队）
  wrap.querySelectorAll<HTMLButtonElement>('[data-accept-player]').forEach((b) => b.onclick = async () => {
    if (!actFn) return;
    await actFn(req('AcceptPlayerOrder', { orderId: b.dataset.acceptPlayer }));
    void render();
  });
  // 撤销我的挂单
  wrap.querySelectorAll<HTMLButtonElement>('[data-cancel-order]').forEach((b) => b.onclick = async () => {
    if (!actFn) return;
    await actFn(req('CancelTradeOrder', { orderId: b.dataset.cancelOrder }));
    void render();
  });
  // 手动刷新 NPC
  const rb = wrap.querySelector<HTMLButtonElement>('[data-trade-refresh]');
  if (rb) rb.onclick = async () => {
    if (!actFn) return;
    await actFn(req('RefreshTrade'));
    void render();
  };
  // 挂出新订单
  const cb = wrap.querySelector<HTMLButtonElement>('[data-create-order]');
  if (cb) cb.onclick = async () => {
    if (!actFn) return;
    const give: Record<string, number> = {};
    const want: Record<string, number> = {};
    TRADE_RES.forEach((k) => {
      const g = Math.floor(Number(wrap!.querySelector<HTMLInputElement>(`input[data-give="${k}"]`)?.value) || 0);
      const w = Math.floor(Number(wrap!.querySelector<HTMLInputElement>(`input[data-want="${k}"]`)?.value) || 0);
      if (g > 0) give[k] = g;
      if (w > 0) want[k] = w;
    });
    if (Object.keys(give).length === 0 || Object.keys(want).length === 0) {
      showTradeHint(body, '请提供与求购都不能为空');
      return;
    }
    await actFn(req('CreateTradeOrder', { give, want }));
    void render();
  };
}

function showTradeHint(body: HTMLElement, msg: string): void {
  const el = body.querySelector<HTMLElement>('.trade-create-route');
  if (el) { el.textContent = msg; el.style.color = 'var(--bad,#c0392b)'; }
}

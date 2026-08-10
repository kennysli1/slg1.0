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
import { resInfo, treasureInfo, treasureCategoryName, treasureRarityName, treasureEffectText } from '../../app/config.js';
import { fmt } from '../../shared/utils/format.js';
import { errText } from '../../shared/ui/text.js';
import { showToast } from '../../shared/ui/toast.js';
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

  // 宝物出售订单（NPC 卖宝物给玩家，金币买；栏满时可替换/卖给NPC/放弃）
  const npcTreasureHtml = (c.npcTreasureOffers || []).map((o: any) => {
    const info = treasureInfo(o.code) ?? o;
    const cat = treasureCategoryName(o.category ?? '');
    const rar = treasureRarityName(o.rarity ?? '');
    const effectTxt = treasureEffectText(info as any);
    const canPay = gold >= (o.buyPrice ?? 0);
    return `<div class="treasure-card rarity-${escapeAttr(o.rarity ?? 'common')}">
      ${art(o.icon, o.name, 'md')}
      <div class="treasure-body">
        <div class="treasure-title">${escapeHtml(o.name)}
          <small class="treasure-cat cat-${escapeAttr(o.category ?? '')}">${escapeHtml(cat)}</small>
          <small class="treasure-rar rar-${escapeAttr(o.rarity ?? '')}">${escapeHtml(rar)}</small>
        </div>
        <div class="treasure-effect">${escapeHtml(effectTxt)}</div>
        <div class="treasure-actions">
          <button class="btn-sm treasure-sell trade-treasure-buy" data-accept-npc-treasure="${escapeAttr(o.id)}" ${!canPay ? 'disabled' : ''}>
            ${art(resInfo('gold').icon, '金币', 'xs')}<span class="gold-amt">${fmt(o.buyPrice ?? 0)}</span> 购买
          </button>
        </div>
      </div>
    </div>`;
  }).join('') || '';

  // 附近玩家挂单（接单方视角）：只显示「你自己」为运出「求购」要占的路线，
  // 不显示对方的运力占用（与服务端 acceptPlayer 按 sum(want) 算 acceptorRoutes 一致）
  const playerHtml = (c.playerOrders || []).map((o: any) => {
    const wantUnits = TRADE_RES.reduce((s: number, k: any) => s + Math.max(0, Math.floor(o.want[k] ?? 0)), 0);
    const ownRoutes = Math.ceil(wantUnits / Math.max(1, cap));
    const canRoutes = ownRoutes <= c.availableRoutes;
    const owner = o.ownerName ? escapeHtml(o.ownerName) : '玩家';
    return `<div class="trade-offer">
      <div class="trade-offer-head"><span class="tag tag--player">玩家 · ${owner}</span><small class="hint-sm">${o.distance}格 · 你需 ${ownRoutes} 路线</small></div>
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

    ${npcTreasureHtml ? `<div class="drawer-sec-title">宝物出售 <small>（金币购买 · 栏满可替换/转卖）</small></div>
    <div class="trade-offers">${npcTreasureHtml}</div>` : ''}

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
      <button class="btn-sm btn-primary" data-create-order id="createOrderBtn" ${orderLimit ? 'disabled' : ''}>${orderLimit ? '已达挂单上限' : '挂出订单'}</button>
    </div>`;

  wrap.querySelectorAll<HTMLElement>('[data-close-trade]').forEach((e) => e.onclick = () => closeTradeCenter());

  // 创建表单：实时预估路线占用（仅「提供」方由本村商队运出；
  //   「求购」由接单方商队送到本村，不计本方路线占用——与服务端 createTradeOrder 一致）
  const giveInputs = Array.from(wrap.querySelectorAll<HTMLInputElement>('input[data-give]'));
  const routeNeed = wrap.querySelector<HTMLElement>('#routeNeed');
  const computeRoutes = () => {
    let units = 0;
    giveInputs.forEach((i) => { units += Math.max(0, Math.floor(Number(i.value) || 0)); });
    const need = Math.ceil(units / Math.max(1, cap));
    if (routeNeed) routeNeed.textContent = String(need);
    // 实时联动挂单按钮：路线不足时禁用并提示（创建即预占路线，故需大于可用即不可挂）
    const btn = wrap!.querySelector<HTMLButtonElement>('#createOrderBtn');
    if (btn && !orderLimit) {
      const noRoute = need > c.availableRoutes;
      btn.disabled = noRoute;
      btn.textContent = noRoute ? '路线不足' : '挂出订单';
    }
    return need;
  };
  giveInputs.forEach((i) => i.oninput = computeRoutes);
  computeRoutes();

  // NPC 成交（即时）
  wrap.querySelectorAll<HTMLButtonElement>('[data-accept-npc]').forEach((b) => b.onclick = async () => {
    if (!actFn) return;
    await actFn(req('AcceptNpcOrder', { orderId: b.dataset.acceptNpc }));
    void render();
  });
  // 宝物购买：能存则直接入栏；栏满则服务端回 overflow，弹「替换/卖给NPC/放弃」选择
  wrap.querySelectorAll<HTMLButtonElement>('[data-accept-npc-treasure]').forEach((b) => b.onclick = async () => {
    if (!actFn) return;
    const orderId = b.dataset.acceptNpcTreasure!;
    const res = await req('AcceptNpcTreasure', { orderId });
    if (!res.ok) {
      showToast(errText(res.error?.code));
      void render();
      return;
    }
    const p = res.payload as any;
    if (p?.overflow) { showTreasureOverflow(p, orderId); return; }
    await actFn(Promise.resolve(res));
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

/**
 * 宝物栏满时的「替换/卖给NPC/放弃购买」选择弹层。
 *  - 替换：丢弃下拉框中选中的已持有宝物，并入新宝物（新宝物占格）。
 *  - 卖给NPC：新宝物直接转卖回收 sellPrice 金币（不占格，净亏 buyPrice - sellPrice）。
 *  - 放弃：不花钱，订单保留。
 */
function showTreasureOverflow(p: any, orderId: string): void {
  if (!wrap) return;
  wrap.querySelector('.trade-overflow')?.remove();
  const t = p.treasure ?? {};
  const codes: string[] = p.codes ?? [];
  const slots: number = p.slots ?? 1;
  const info = treasureInfo(t.code) ?? t;
  const effectTxt = treasureEffectText(info as any);
  const cat = treasureCategoryName(t.category ?? '');
  const rar = treasureRarityName(t.rarity ?? '');
  const options = codes.map((c) => {
    const oi = treasureInfo(c);
    const label = oi ? `${oi.name}（${treasureRarityName(oi.rarity)}）` : c;
    return `<option value="${escapeAttr(c)}">${escapeHtml(label)}</option>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'trade-overflow';
  overlay.innerHTML = `
    <div class="trade-overflow-mask" data-of-close="1"></div>
    <div class="trade-overflow-card">
      <div class="drawer-head"><span class="trade-overflow-title">宝物栏已满（${codes.length}/${slots}）</span>
        <button class="drawer-close" data-of-close="1" aria-label="关闭">✕</button></div>
      <div class="treasure-card rarity-${escapeAttr(t.rarity ?? 'common')}">
        ${art(t.icon, t.name, 'md')}
        <div class="treasure-body">
          <div class="treasure-title">${escapeHtml(t.name)}
            <small class="treasure-cat cat-${escapeAttr(t.category ?? '')}">${escapeHtml(cat)}</small>
            <small class="treasure-rar rar-${escapeAttr(t.rarity ?? '')}">${escapeHtml(rar)}</small>
          </div>
          <div class="treasure-effect">${escapeHtml(effectTxt)}</div>
        </div>
      </div>
      <div class="trade-overflow-hint">购买需 ${fmt(t.buyPrice ?? 0)} 金币。栏位已满，请选择处理方式：</div>
      <div class="trade-overflow-actions">
        <div class="trade-overflow-row">
          <select id="of-replace-sel" aria-label="选择要替换掉的宝物">${options}</select>
          <button class="btn-sm" data-of-replace="1" ${codes.length ? '' : 'disabled'}>替换选中宝物</button>
        </div>
        <div class="trade-overflow-row">
          <button class="btn-sm treasure-sell" data-of-sell="1">卖给 NPC（回收 ${fmt(t.sellPrice ?? 0)} 金币）</button>
        </div>
        <div class="trade-overflow-row">
          <button class="btn-sm btn-ghost" data-of-discard="1">放弃购买（不花钱）</button>
        </div>
      </div>
    </div>`;
  wrap.appendChild(overlay);
  overlay.querySelectorAll<HTMLElement>('[data-of-close]').forEach((e) => e.onclick = () => overlay.remove());

  const runAction = async (action: string, replaceCode?: string) => {
    overlay.remove();
    const res = await req('AcceptNpcTreasure', { orderId, action, ...(replaceCode ? { replaceCode } : {}) });
    if (!res.ok) {
      showToast(errText(res.error?.code));
      void render();
      return;
    }
    if (actFn) actFn(Promise.resolve(res));
    void render();
  };
  overlay.querySelector<HTMLElement>('[data-of-replace]')!.onclick = () => {
    const sel = overlay.querySelector<HTMLSelectElement>('#of-replace-sel');
    const replaceCode = sel?.value;
    if (!replaceCode) { showToast('请先选择要替换的宝物'); return; }
    void runAction('replace', replaceCode);
  };
  overlay.querySelector<HTMLElement>('[data-of-sell]')!.onclick = () => void runAction('sell');
  overlay.querySelector<HTMLElement>('[data-of-discard]')!.onclick = () => void runAction('discard');
}

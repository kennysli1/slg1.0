/**
 * 贸易中心弹窗（Preact + signals）。
 *
 * 对外只暴露 openTradeCenter(): void，签名固定，由村庄建筑弹窗调用。
 * 内部订阅 tradeCenter 信号，服务端 push（TradeCenterUpdated）自动触发
 * reloadTrade() → 信号更新 → 弹窗局部重渲，无需手动刷新。
 */
import { useState, useEffect } from 'preact/hooks';
import { openModal, tradeCenter, tick, showToast } from '../../app/store.js';
import { act, reloadTrade } from '../../app/refresh.js';
import { req } from '../../api.js';
import {
  resInfo, treasureInfo, treasureCategoryName, treasureRarityName, treasureEffectText,
  tradeRouteCapacity, tradeCaravanSpeed,
} from '../../app/config.js';
import { fmt, fmtDur } from '../../shared/utils/format.js';
import { errText } from '../../shared/ui/text.js';
import {
  Modal, Panel, SectionHead, Empty, Btn, Tag, Icon, IconPlate, Bar,
} from '../../ui/index.js';
import '../../styles/trade.css';

// ---- 常量 ----

const TRADE_RES = ['wood', 'clay', 'iron', 'crop', 'gold'] as const;
type TradeRes = typeof TRADE_RES[number];

/** 剩余时长格式化统一走 fmtDur（时长语义），别再各页自己实现一份。 */
const fmtRemaining = fmtDur;

// ---- 公共入口 ----

/** 打开贸易中心弹窗（供村庄建筑弹窗调用，签名固定）。 */
export function openTradeCenter(): void {
  void reloadTrade();
  openModal((close) => <TradeCenterModal onClose={close} />, 'trade-center');
}

// ---- 主组件 ----

function TradeCenterModal({ onClose }: { onClose: () => void }) {
  // 订阅 tradeCenter 信号（push 后自动重渲）
  const c = tradeCenter.value as any;

  useEffect(() => {
    void reloadTrade();
  }, []);

  // 创建订单表单的受控状态（与服务端数据刷新解耦，防止用户输入被清空）
  const emptyAmounts = () =>
    Object.fromEntries(TRADE_RES.map((k) => [k, ''])) as Record<TradeRes, string>;
  const [give, setGive] = useState<Record<TradeRes, string>>(emptyAmounts);
  const [want, setWant] = useState<Record<TradeRes, string>>(emptyAmounts);
  const [createBusy, setCreateBusy] = useState(false);

  // 宝物栏满时的溢出对话状态（内嵌 sub-panel 方案）
  const [overflow, setOverflow] = useState<{
    orderId: string;
    treasure: any;
    codes: string[];
    slots: number;
  } | null>(null);
  const [overflowReplace, setOverflowReplace] = useState('');
  const [overflowBusy, setOverflowBusy] = useState(false);

  if (!c) {
    return (
      <Modal title="贸易中心" icon={<IconPlate icon="bld_tradecenter" label="贸易中心" size="sm" plate="gold" />} wide onClose={onClose}>
        <div class="empty"><h4>加载中…</h4></div>
      </Modal>
    );
  }

  if (!c.built) {
    return (
      <Modal title="贸易中心" icon={<IconPlate icon="bld_tradecenter" label="贸易中心" size="sm" plate="gold" />} wide onClose={onClose}>
        <Empty icon="🏛️" title="尚未建造">
          请到「城外」空槽建造贸易中心后，再来此交易。
        </Empty>
      </Modal>
    );
  }

  // ---- 派生数据 ----
  const cap = tradeRouteCapacity();
  const speed = tradeCaravanSpeed();
  const gold = c.gold ?? 0;
  const routeTotal: number = c.tradeRoutes ?? 0;
  const routeAvail: number = c.availableRoutes ?? 0;
  const routeUsed = routeTotal - routeAvail;
  const routePct = routeTotal > 0 ? (routeUsed / routeTotal) * 100 : 0;

  const npcStoredRefreshes: number = c.npcStoredRefreshes ?? 0;
  const npcMaxStored: number = c.npcMaxStored ?? 0;
  const npcRefreshSec: number = c.npcRefreshSec ?? 3600;
  const npcNextRefreshAt: number = c.npcNextRefreshAt ?? 0;

  const playerOrderCurrent: number = c.playerOrderCurrent ?? 0;
  const playerOrderMax: number = c.playerOrderMax ?? 5;
  const orderAtLimit = playerOrderCurrent >= playerOrderMax;

  // 创建订单：路线需求计算（仅「提供」一侧由本村商队运出，消耗路线）
  const giveUnits = TRADE_RES.reduce(
    (s, k) => s + Math.max(0, Math.floor(Number(give[k]) || 0)),
    0,
  );
  const routesNeeded = Math.ceil(giveUnits / Math.max(1, cap));
  const routeOver = routesNeeded > routeAvail;
  const giveEmpty = TRADE_RES.every((k) => !(Number(give[k]) > 0));
  const wantEmpty = TRADE_RES.every((k) => !(Number(want[k]) > 0));

  // ---- 动作 ----

  async function handleAcceptNpc(orderId: string) {
    const ok = await act(req('AcceptNpcOrder', { orderId }), { okToast: '交易成功' });
    if (ok) void reloadTrade();
  }

  async function handleAcceptNpcDelivery(orderId: string) {
    const ok = await act(req('AcceptNpcDelivery', { orderId }), {
      okToast: '已派商队将粮食送往幸福村',
    });
    if (ok) void reloadTrade();
  }

  async function handleAcceptNpcTreasure(orderId: string) {
    const r = await req('AcceptNpcTreasure', { orderId });
    if (!r.ok) {
      showToast(errText(r.error?.code), 'bad');
      void reloadTrade();
      return;
    }
    const p = r.payload as any;
    if (p?.overflow) {
      setOverflow({ orderId, treasure: p.treasure ?? {}, codes: p.codes ?? [], slots: p.slots ?? 1 });
      setOverflowReplace(p.codes?.[0] ?? '');
      return;
    }
    // 正常成功
    await act(Promise.resolve(r), { okToast: '宝物已入栏' });
    void reloadTrade();
  }

  async function handleOverflowAction(action: string) {
    if (!overflow || overflowBusy) return;
    setOverflowBusy(true);
    const params: Record<string, string> = {
      orderId: overflow.orderId,
      action,
      ...(action === 'replace' ? { replaceCode: overflowReplace } : {}),
    };
    const r = await req('AcceptNpcTreasure', params as any);
    setOverflowBusy(false);
    if (!r.ok) {
      showToast(errText(r.error?.code), 'bad');
    } else {
      await act(Promise.resolve(r), {
        okToast: action === 'sell' ? '宝物已出售' : action === 'replace' ? '宝物已替换' : '已放弃购买',
      });
    }
    setOverflow(null);
    void reloadTrade();
  }

  async function handleAcceptPlayer(orderId: string) {
    const ok = await act(req('AcceptPlayerOrder', { orderId }), { okToast: '已派商队' });
    if (ok) void reloadTrade();
  }

  async function handleCancelOrder(orderId: string) {
    const ok = await act(req('CancelTradeOrder', { orderId }), { okToast: '挂单已撤销' });
    if (ok) void reloadTrade();
  }

  async function handleRefresh() {
    const ok = await act(req('RefreshTrade'), { okToast: 'NPC 订单已刷新' });
    if (ok) void reloadTrade();
  }

  async function handleCreateOrder() {
    if (createBusy) return;
    const giveMap: Record<string, number> = {};
    const wantMap: Record<string, number> = {};
    TRADE_RES.forEach((k) => {
      const g = Math.floor(Number(give[k]) || 0);
      const w = Math.floor(Number(want[k]) || 0);
      if (g > 0) giveMap[k] = g;
      if (w > 0) wantMap[k] = w;
    });
    if (Object.keys(giveMap).length === 0 || Object.keys(wantMap).length === 0) {
      showToast('提供和求购都不能为空', 'bad');
      return;
    }
    setCreateBusy(true);
    const ok = await act(req('CreateTradeOrder', { give: giveMap, want: wantMap }), {
      okToast: '挂单已挂出',
    });
    setCreateBusy(false);
    if (ok) {
      setGive(emptyAmounts());
      setWant(emptyAmounts());
      void reloadTrade();
    }
  }

  // ---- 渲染 ----

  return (
    <Modal
      title="贸易中心"
      sub={`路线 ${routeAvail}/${routeTotal} · 商队速度 ${speed} 格/时`}
      icon={<IconPlate icon="bld_tradecenter" label="贸易中心" size="sm" plate="gold" />}
      wide
      onClose={onClose}
    >
      {/* 溢出对话框（宝物栏满）*/}
      {overflow && (
        <TreasureOverflowPanel
          overflow={overflow}
          replaceCode={overflowReplace}
          onReplaceCodeChange={setOverflowReplace}
          busy={overflowBusy}
          onAction={handleOverflowAction}
          onCancel={() => setOverflow(null)}
        />
      )}

      {/* 顶部信息 */}
      <div class="trade-header">
        <div class="trade-header-row">
          <Icon icon={resInfo('gold').icon} label="金币" size="sm" />
          <span class="trade-gold-label">持有金币</span>
          <span class="trade-gold-num">{fmt(gold)}</span>
          <span class="trade-route-info">
            路线占用
            <span class="trade-route-num">{routeUsed}/{routeTotal}</span>
          </span>
        </div>
        <div class="trade-route-bar">
          <Bar pct={routePct} kind={routePct >= 90 ? 'crimson' : routePct >= 60 ? 'ember' : 'jade'} thin />
        </div>
        <div class="trade-refresh-row">
          {npcStoredRefreshes > 0
            ? (
              <Btn size="sm" onClick={handleRefresh}>
                手动刷新 ({npcStoredRefreshes}/{npcMaxStored})
              </Btn>
            )
            : <span>无存储刷新次数</span>}
          <span>
            每 {npcRefreshSec}s 自动刷新（上限 {npcMaxStored} 次）
          </span>
          {npcNextRefreshAt > 0 && (
            <NpcRefreshCountdown nextAt={npcNextRefreshAt} />
          )}
        </div>
      </div>

      {/* NPC 订单 */}
      <SectionHead sub="即时交付 · 含宝物出售">NPC 订单</SectionHead>
      <NpcOrderList
        orders={c.npcOrders ?? []}
        gold={gold}
        onAccept={handleAcceptNpc}
        onAcceptTreasure={handleAcceptNpcTreasure}
      />

      {/* 幸福村送达订单（支线任务：村民的请求）*/}
      {Array.isArray(c.npcDeliveryOrders) && c.npcDeliveryOrders.length > 0 && (
        <>
          <SectionHead sub="支线任务 · 村民的请求">幸福村订单</SectionHead>
          <NpcDeliveryOrderList
            orders={c.npcDeliveryOrders}
            availableRoutes={routeAvail}
            onAccept={handleAcceptNpcDelivery}
          />
        </>
      )}

      {/* 附近玩家挂单 */}
      <SectionHead sub={`视野半径 ${c.viewRadius ?? '?'} 格内`}>附近玩家挂单</SectionHead>
      <PlayerOrderList
        orders={c.playerOrders ?? []}
        availableRoutes={routeAvail}
        cap={cap}
        speed={speed}
        onAccept={handleAcceptPlayer}
      />

      {/* 我的挂单 */}
      <SectionHead
        sub={`${playerOrderCurrent}/${playerOrderMax}`}
        actions={<span class={`num ${orderAtLimit ? 'text-warn' : ''}`}>{orderAtLimit ? '已达上限' : ''}</span>}
      >
        我的挂单
      </SectionHead>
      <MyOrderList orders={c.myOrders ?? []} onCancel={handleCancelOrder} />

      {/* 创建挂单 */}
      <SectionHead>创建挂单</SectionHead>
      <CreateOrderForm
        give={give}
        want={want}
        onGiveChange={(k, v) => setGive((prev) => ({ ...prev, [k]: v }))}
        onWantChange={(k, v) => setWant((prev) => ({ ...prev, [k]: v }))}
        routesNeeded={routesNeeded}
        availableRoutes={routeAvail}
        cap={cap}
        disabled={orderAtLimit || giveEmpty || wantEmpty || routeOver || createBusy}
        disabledReason={
          orderAtLimit ? '已达挂单上限'
            : giveEmpty ? '请填写提供数量'
              : wantEmpty ? '请填写求购数量'
                : routeOver ? `路线不足（需 ${routesNeeded}，可用 ${routeAvail}）`
                  : undefined
        }
        onSubmit={handleCreateOrder}
      />
    </Modal>
  );
}

// ---- NPC 刷新倒计时（每秒订阅 tick）----

function NpcRefreshCountdown({ nextAt }: { nextAt: number }) {
  tick.value;
  const rem = Math.max(0, nextAt - Date.now());
  return <span>下次自动刷新：约 {fmtRemaining(rem)}</span>;
}

// ---- NPC 订单列表 ----

function NpcOrderList({
  orders,
  gold,
  onAccept,
  onAcceptTreasure,
}: {
  orders: any[];
  gold: number;
  onAccept: (id: string) => void;
  onAcceptTreasure: (id: string) => void;
}) {
  if (!orders.length) {
    return <Empty icon="🤝" title="暂无 NPC 订单">等待自动刷新或消耗刷新次数。</Empty>;
  }
  return (
    <div class="trade-offer-list">
      {orders.map((o: any) => {
        if (o.treasure) {
          return <NpcTreasureOffer key={o.id} order={o} gold={gold} onBuy={onAcceptTreasure} />;
        }
        return <NpcResourceOffer key={o.id} order={o} gold={gold} onAccept={onAccept} />;
      })}
    </div>
  );
}

function NpcResourceOffer({
  order: o,
  gold,
  onAccept,
}: {
  order: any;
  gold: number;
  onAccept: (id: string) => void;
}) {
  const canPay = TRADE_RES.every((k) => {
    const w = o.want[k] ?? 0;
    if (k === 'gold') return gold >= w;
    return true; // 非金币由服务端校验
  });
  const isSell = (o.give?.gold ?? 0) > 0; // 玩家卖出资源换金币

  return (
    <div class="trade-offer">
      <div class="trade-offer-head">
        <Tag kind="gold">NPC · {isSell ? '收购' : '出售'}</Tag>
        <span class="trade-offer-meta">来源 {o.distance} 格</span>
      </div>
      <ExchangeDisplay pay={o.want} get={o.give} />
      <div class="trade-offer-foot">
        <Btn
          size="sm"
          variant="primary"
          disabled={!canPay}
          onClick={() => onAccept(o.id)}
        >
          成交（即时交付）
        </Btn>
        {!canPay && <span class="trade-disable-reason">金币不足</span>}
      </div>
    </div>
  );
}

function NpcTreasureOffer({
  order: o,
  gold,
  onBuy,
}: {
  order: any;
  gold: number;
  onBuy: (id: string) => void;
}) {
  const t = o.treasure;
  const info = treasureInfo(t.code) ?? t;
  const cat = treasureCategoryName(t.category ?? '');
  const rar = treasureRarityName(t.rarity ?? '');
  const effectTxt = treasureEffectText(info as any);
  const buyPrice: number = t.buyPrice ?? 0;
  const canPay = gold >= buyPrice;
  const rarCls = `rarity-${t.rarity ?? 'common'}`;

  return (
    <div class="trade-offer">
      <div class="trade-offer-head">
        <Tag kind="gold">NPC · 宝物</Tag>
      </div>
      <div class={`trade-treasure-card ${rarCls}`}>
        <IconPlate icon={t.icon} label={t.name} size="md" plate={t.rarity === 'legend' ? 'gold' : 'stone'} />
        <div class="trade-treasure-body">
          <div class="trade-treasure-name">{t.name}</div>
          <div class="trade-treasure-tags">
            <Tag>{cat}</Tag>
            <span class={`tag tag--rarity-${t.rarity ?? 'common'}`}>{rar}</span>
          </div>
          <div class="trade-treasure-effect">{effectTxt}</div>
          <div class="trade-treasure-footer">
            <span class="chip">
              <Icon icon={resInfo('gold').icon} label="金币" size="xs" />
              {fmt(buyPrice)}
            </span>
            <Btn
              size="sm"
              variant="primary"
              disabled={!canPay}
              onClick={() => onBuy(o.id)}
            >
              购买
            </Btn>
            {!canPay && <span class="trade-disable-reason">金币不足（差 {fmt(buyPrice - gold)}）</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 幸福村送达订单列表（村民的请求）----

function NpcDeliveryOrderList({
  orders,
  availableRoutes,
  onAccept,
}: {
  orders: any[];
  availableRoutes: number;
  onAccept: (id: string) => void;
}) {
  return (
    <div class="trade-offer-list">
      {orders.map((o: any) => {
        const wantUnits = TRADE_RES.reduce(
          (s, k) => s + Math.max(0, Math.floor(o.want[k] ?? 0)),
          0,
        );
        const needRoutes = Math.max(1, Math.ceil(wantUnits / Math.max(1, tradeRouteCapacity())));
        const canAccept = needRoutes <= availableRoutes;
        return (
          <div key={o.id} class="trade-offer trade-offer--npc-delivery">
            <div class="trade-offer-head">
              <Tag kind="ember">幸福村 · {o.ownerName ?? '幸福村'}</Tag>
              {o.npcXY && (
                <span class="trade-offer-meta">
                  坐标 ({o.npcXY.q}, {o.npcXY.r})
                </span>
              )}
            </div>
            <ExchangeDisplay pay={o.want} get={{}} />
            <div class="trade-offer-foot">
              <Btn
                size="sm"
                variant="primary"
                disabled={!canAccept}
                onClick={() => onAccept(o.id)}
              >
                接单（派商队送粮）
              </Btn>
              {!canAccept && (
                <span class="trade-disable-reason">
                  路线不足（需 {needRoutes}，可用 {availableRoutes}）
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- 玩家挂单列表 ----

function PlayerOrderList({
  orders,
  availableRoutes,
  cap,
  speed,
  onAccept,
}: {
  orders: any[];
  availableRoutes: number;
  cap: number;
  speed: number;
  onAccept: (id: string) => void;
}) {
  if (!orders.length) {
    return <Empty icon="📜" title="暂无附近玩家挂单">扩大贸易中心等级可提升视野半径。</Empty>;
  }
  return (
    <div class="trade-offer-list">
      {orders.map((o: any) => {
        // 接单方（本村）需发商队运走 want 数量，占用的路线数
        const wantUnits = TRADE_RES.reduce(
          (s, k) => s + Math.max(0, Math.floor(o.want[k] ?? 0)),
          0,
        );
        const ownRoutes = Math.ceil(wantUnits / Math.max(1, cap));
        const canAccept = ownRoutes <= availableRoutes;
        // 按距离估算商队旅行时间
        const travelHours = speed > 0 ? (o.distance ?? 0) / speed : 0;
        const travelMin = Math.round(travelHours * 60);

        return (
          <div key={o.id} class="trade-offer">
            <div class="trade-offer-head">
              <Tag kind="steel">玩家 · {o.ownerName ?? '未知'}</Tag>
              <span class="trade-offer-meta">
                {o.distance} 格 · 约 {travelMin}分 · 你需 {ownRoutes} 条路线
              </span>
            </div>
            <ExchangeDisplay pay={o.want} get={o.give} />
            <div class="trade-offer-foot">
              <Btn
                size="sm"
                variant="primary"
                disabled={!canAccept}
                onClick={() => onAccept(o.id)}
              >
                接单（派商队）
              </Btn>
              {!canAccept && (
                <span class="trade-disable-reason">
                  路线不足（需 {ownRoutes}，可用 {availableRoutes}）
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---- 我的挂单 ----

function MyOrderList({
  orders,
  onCancel,
}: {
  orders: any[];
  onCancel: (id: string) => void;
}) {
  if (!orders.length) {
    return <Empty icon="📋" title="还没有挂单">在下方创建挂单，让附近玩家来接。</Empty>;
  }
  return (
    <div class="trade-offer-list">
      {orders.map((o: any) => (
        <MyOrderItem key={o.id} order={o} onCancel={onCancel} />
      ))}
    </div>
  );
}

function MyOrderItem({ order: o, onCancel }: { order: any; onCancel: (id: string) => void }) {
  tick.value;
  const rem = Math.max(0, (o.ttlAt ?? 0) - Date.now());

  return (
    <div class="trade-offer">
      <div class="trade-offer-head">
        <Tag kind="jade">我的</Tag>
        <span class="trade-offer-meta">
          {rem > 0 ? `${fmtRemaining(rem)} 后过期` : '即将过期'}
        </span>
      </div>
      <ExchangeDisplay pay={o.give} get={o.want} />
      <div class="trade-offer-foot">
        <Btn size="sm" variant="danger" onClick={() => onCancel(o.id)}>
          撤销挂单
        </Btn>
      </div>
    </div>
  );
}

// ---- 创建挂单表单 ----

function CreateOrderForm({
  give,
  want,
  onGiveChange,
  onWantChange,
  routesNeeded,
  availableRoutes,
  cap,
  disabled,
  disabledReason,
  onSubmit,
}: {
  give: Record<TradeRes, string>;
  want: Record<TradeRes, string>;
  onGiveChange: (k: TradeRes, v: string) => void;
  onWantChange: (k: TradeRes, v: string) => void;
  routesNeeded: number;
  availableRoutes: number;
  cap: number;
  disabled: boolean;
  disabledReason?: string;
  onSubmit: () => void;
}) {
  const routeOver = routesNeeded > availableRoutes;

  return (
    <div class="trade-create">
      <div class="trade-create-grid-header">
        <span></span>
        <span>提供（你送出）</span>
        <span>求购（你想要）</span>
      </div>
      <div class="trade-create-grid">
        {TRADE_RES.map((k) => {
          const info = resInfo(k);
          return (
            <>
              <label key={`label-${k}`} class="trade-res-label" for={`give-${k}`}>
                <Icon icon={info.icon} label={info.name} size="xs" />
                {info.name}
              </label>
              <input
                key={`give-${k}`}
                id={`give-${k}`}
                class="trade-create-input"
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={give[k]}
                onInput={(e) => onGiveChange(k, (e.currentTarget as HTMLInputElement).value)}
                aria-label={`提供 ${info.name}`}
              />
              <input
                key={`want-${k}`}
                class="trade-create-input"
                type="number"
                min="0"
                step="1"
                placeholder="0"
                value={want[k]}
                onInput={(e) => onWantChange(k, (e.currentTarget as HTMLInputElement).value)}
                aria-label={`求购 ${info.name}`}
              />
            </>
          );
        })}
      </div>

      <div class={`trade-route-feedback${routeOver ? ' over' : ''}`}>
        将占用路线：
        <span class="trade-route-feedback-num">{routesNeeded}</span>
        &nbsp;/ 可用 {availableRoutes}（每条运力 {fmt(cap)}）
      </div>

      <Btn
        variant="primary"
        block
        disabled={disabled}
        onClick={onSubmit}
      >
        {disabledReason ?? '挂出订单'}
      </Btn>
    </div>
  );
}

// ---- 宝物溢出处理面板 ----

function TreasureOverflowPanel({
  overflow,
  replaceCode,
  onReplaceCodeChange,
  busy,
  onAction,
  onCancel,
}: {
  overflow: { orderId: string; treasure: any; codes: string[]; slots: number };
  replaceCode: string;
  onReplaceCodeChange: (v: string) => void;
  busy: boolean;
  onAction: (action: string) => void;
  onCancel: () => void;
}) {
  const t = overflow.treasure;
  const info = treasureInfo(t.code) ?? t;
  const cat = treasureCategoryName(t.category ?? '');
  const rar = treasureRarityName(t.rarity ?? '');
  const effectTxt = treasureEffectText(info as any);
  const rarCls = `rarity-${t.rarity ?? 'common'}`;

  return (
    <div class="trade-overflow-wrap" role="alertdialog" aria-modal="true">
      <Panel variant="gold" corners pad class="trade-overflow-card">
        <div class="trade-overflow-title">
          宝物栏已满（{overflow.codes.length}/{overflow.slots}）
        </div>

        {/* 要购买的宝物信息 */}
        <div class={`trade-treasure-card ${rarCls}`}>
          <IconPlate icon={t.icon} label={t.name} size="md" plate={t.rarity === 'legend' ? 'gold' : 'stone'} />
          <div class="trade-treasure-body">
            <div class="trade-treasure-name">{t.name}</div>
            <div class="trade-treasure-tags">
              <Tag>{cat}</Tag>
              <span class={`tag tag--rarity-${t.rarity ?? 'common'}`}>{rar}</span>
            </div>
            <div class="trade-treasure-effect">{effectTxt}</div>
          </div>
        </div>

        <div class="trade-overflow-hint">
          栏位已满。请选择处理方式：
        </div>

        <div class="trade-overflow-actions">
          {/* 替换 */}
          {overflow.codes.length > 0 && (
            <div class="trade-overflow-row">
              <select
                class="trade-overflow-select"
                value={replaceCode}
                onChange={(e) => onReplaceCodeChange((e.currentTarget as HTMLSelectElement).value)}
                aria-label="选择要替换的宝物"
              >
                {overflow.codes.map((c) => {
                  const oi = treasureInfo(c);
                  const label = oi ? `${oi.name}（${treasureRarityName(oi.rarity)}，出售 +${fmt(oi.priceGold ?? 0)} 金）` : c;
                  return <option key={c} value={c}>{label}</option>;
                })}
              </select>
              <Btn
                variant="danger"
                size="sm"
                disabled={!replaceCode || busy}
                onClick={() => onAction('replace')}
              >
                替换并出售（+{fmt(treasureInfo(replaceCode)?.priceGold ?? 0)} 金）
              </Btn>
            </div>
          )}

          {/* 卖给 NPC */}
          <div class="trade-overflow-row">
            <Btn
              block
              disabled={busy}
              onClick={() => onAction('sell')}
            >
              卖给 NPC（回收 {fmt(t.sellPrice ?? 0)} 金币）
            </Btn>
          </div>

          {/* 放弃 */}
          <div class="trade-overflow-row">
            <Btn
              variant="ghost"
              block
              disabled={busy}
              onClick={() => onAction('discard')}
            >
              放弃购买（不花钱）
            </Btn>
          </div>

          <Btn variant="ghost" size="sm" onClick={onCancel} disabled={busy}>取消</Btn>
        </div>
      </Panel>
    </div>
  );
}

// ---- 付出 → 得到 交换展示（两列布局） ----

function ExchangeDisplay({ pay, get }: {
  pay: Record<string, number>;
  get: Record<string, number>;
}) {
  const payChips = TRADE_RES.filter((k) => (pay[k] ?? 0) > 0);
  const getChips = TRADE_RES.filter((k) => (get[k] ?? 0) > 0);

  return (
    <div class="trade-exchange">
      <div class="trade-exchange-side">
        <div class="trade-exchange-label">你付出</div>
        <div class="trade-exchange-chips">
          {payChips.length > 0
            ? payChips.map((k) => (
              <span key={k} class="chip">
                <Icon icon={resInfo(k).icon} label={resInfo(k).name} size="xs" />
                {fmt(pay[k])}
              </span>
            ))
            : <span class="num" style="color:var(--c-ink-dim)">—</span>}
        </div>
      </div>
      <div class="trade-exchange-arrow">→</div>
      <div class="trade-exchange-side">
        <div class="trade-exchange-label">你得到</div>
        <div class="trade-exchange-chips">
          {getChips.length > 0
            ? getChips.map((k) => (
              <span key={k} class="chip" style="border-color:rgba(95,156,98,.40)">
                <Icon icon={resInfo(k).icon} label={resInfo(k).name} size="xs" />
                +{fmt(get[k])}
              </span>
            ))
            : <span class="num" style="color:var(--c-ink-dim)">—</span>}
        </div>
      </div>
    </div>
  );
}

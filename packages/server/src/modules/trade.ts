import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';
import { type Hex, hexDistanceWrapped } from '../infra/hex.js';
import { makeLogger } from '../infra/logger.js';

const log = makeLogger('trade');

const RES_KEYS = ['wood', 'clay', 'iron', 'crop', 'gold'] as const;
type ResKey = (typeof RES_KEYS)[number];
const TRADE_RES = ['wood', 'clay', 'iron', 'crop'];

/**
 * 领域模块 · Trade（贸易中心）
 *
 * 职责：管理每个村庄的一处贸易中心（tradecenter 建筑）。中心提供：
 *  - NPC 订单池：玩家用金币买资源 / 卖资源换金币，即时交付，无需等待商队。
 *  - 玩家挂单：玩家创建贸易订单（提供资源 + 想要资源，含金币）供附近城市接受。
 *  - 玩家接单：接受他人订单 → 双方各派商队运送货物，消耗各自贸易路线，商队返回后回收路线。
 *
 * 设计要点（镜像 mercenary 模块模式）：
 *  - 中心等级决定：贸易路线数(tradeRoutes)、可见交易距离(tradeViewRadius)、NPC 订单数(npcOrderCount)、
 *    NPC 自动刷新间隔(npcRefreshSec)、可囤积的手动刷新次数(npcStoredRefreshes)。
 *  - 自动刷新：到 nextRefreshAt 时重roll NPC 订单池 + 存储次数 +1（存满为止）。
 *  - 手动刷新：消耗一次 storedRefreshes，立即重roll NPC 订单池。
 *  - 贸易路线：每条路线可运 tradeRouteCapacity 单位货物；派商队时即时消耗，商队返回家园时回收。
 *    「己方需提供的货物单位 > 可用路线运力」→ 无法创建/接受订单。
 *  - 玩家挂单在 tradeOrderTtlSec 后过期自动下架；仅本村可见自己挂的单（含撤销）。
 */

interface NpcTreasureOffer {
  code: string;
  name: string;
  icon: string;
  category: string;
  rarity: string;
  effectType: string;
  effectValue: number;
  applyType: string;
  /** 玩家买下需支付的金币。 */
  buyPrice: number;
  /** 溢出时卖给 NPC 回收的金币（≤ buyPrice）。 */
  sellPrice: number;
}

interface NpcOrder {
  id: string;
  /** 村庄可获得的资源（NPC 给玩家）。 */
  give: Record<string, number>;
  /** 村庄需支付的资源（玩家付 NPC，含 gold）。 */
  want: Record<string, number>;
  /** 该 NPC 商队来源距离（格），受贸易中心 viewRadius 限制。 */
  distance: number;
  /** 随下次自动刷新失效。 */
  expiresAt: number;
  /** 若为宝物出售订单，则带此字段（give/want 同时为空）。 */
  treasure?: NpcTreasureOffer;
}

interface PlayerOrder {
  id: string;
  /** 创建者村庄。 */
  villageId: string;
  /** 创建者坐标快照（接受方测距用）。 */
  fromXY: Hex;
  /** 创建者提供的资源（含金币）。 */
  give: Record<string, number>;
  /** 创建者想要的资源（含金币）。 */
  want: Record<string, number>;
  /** 创建者所需贸易路线数（按 give 单位数 / 路线运力 向上取整）。 */
  routesNeeded: number;
  createdAt: number;
  ttlAt: number;
}

interface TradeCenterState {
  villageId: string;
  /** 中心等级（缓存自 building.GetBuildingLevel；升级时刷新）。 */
  level: number;
  /** 当前 NPC 订单池。 */
  npcOrderPool: NpcOrder[];
  /** 已存储的手动刷新次数。 */
  storedRefreshes: number;
  /** 下次自动刷新时刻（ms）。 */
  nextRefreshAt: number;
  /** 已占用（在途商队消耗）的贸易路线数。 */
  tradeRoutesUsed: number;
  /** 本村挂出的玩家订单。 */
  createdOrders: PlayerOrder[];
  taskId?: string;
}

const COLLECTION = 'trade';

export class TradeModule {
  static readonly NAME = 'trade';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'trade',
    publicActions: {
      GetTradeCenter: { command: 'trade.GetCenter', ownVillage: true, needAuth: true, schema: {} },
      RefreshTrade: { command: 'trade.Refresh', ownVillage: true, needAuth: true, schema: {} },
      AcceptNpcOrder: {
        command: 'trade.AcceptNpc', ownVillage: true, needAuth: true,
        schema: { orderId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      // 购买 NPC 出售的宝物；宝物栏满时经 action 选择 替换(replace)/卖给NPC(sell)/放弃(discard)。
      AcceptNpcTreasure: {
        command: 'trade.AcceptNpcTreasure', ownVillage: true, needAuth: true,
        schema: {
          orderId: { type: 'string', minLen: 1, maxLen: 64 },
          action: { type: 'enum', values: ['store', 'replace', 'sell', 'discard'], optional: true },
          replaceCode: { type: 'string', minLen: 1, maxLen: 64, optional: true },
        },
      },
      CreateTradeOrder: {
        command: 'trade.CreateOrder', ownVillage: true, needAuth: true,
        schema: {
          give: { type: 'record_int', maxKeys: 5, minVal: 0, maxVal: 10_000_000 },
          want: { type: 'record_int', maxKeys: 5, minVal: 0, maxVal: 10_000_000 },
        },
      },
      AcceptPlayerOrder: {
        command: 'trade.AcceptPlayer', ownVillage: true, needAuth: true,
        schema: { orderId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
      CancelTradeOrder: {
        command: 'trade.CancelOrder', ownVillage: true, needAuth: true,
        schema: { orderId: { type: 'string', minLen: 1, maxLen: 64 } },
      },
    },
    eventPushMap: {
      'trade.CenterUpdated': 'TradeCenterUpdated',
    },
  };

  /** 全局玩家挂单索引（orderId → PlayerOrder），用于快速可见性查询与生命周期管理。 */
  private orders = new Map<string, PlayerOrder>();

  /** 可交易宝物清单（priceGold>0），按稀有度加权抽取，热重载时刷新。 */
  private tradeableTreasures: Array<{ code: string; priceGold: number; rarity: string }> = [];

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
  ) {
    this.refreshTradeable();
  }

  setConfig(config: GameConfig): void {
    this.config = config;
    this.refreshTradeable();
    // GM 热重载后重定刷新间隔：取消旧定时器，用新参数立即重排
    for (const s of this.store.all<TradeCenterState>(COLLECTION)) {
      if (s.level > 0 && s.taskId) {
        this.scheduler.cancelByOwner(`trade:${s.villageId}`);
        const tc = this.config.tradeCenter[s.level] ?? { npcRefreshSec: 3600, npcStoredRefreshes: 1, tradeViewRadius: 5, npcOrderCount: 3, tradeRoutes: 2 };
        s.nextRefreshAt = this.now() + tc.npcRefreshSec * 1000;
        s.taskId = this.scheduleRefresh(s.villageId, s.nextRefreshAt);
        this.store.set(COLLECTION, s.villageId, s);
      }
    }
  }

  /** 重算可交易宝物清单（priceGold>0 才有 NPC 出售意义）。 */
  private refreshTradeable(): void {
    this.tradeableTreasures = Object.values(this.config.treasures)
      .filter((t) => (t.priceGold ?? 0) > 0)
      .map((t) => ({ code: t.code, priceGold: t.priceGold, rarity: t.rarity }));
  }

  init(): void {
    this.commands.register('trade.GetCenter', (c) => this.getCenter(c));
    this.commands.register('trade.Refresh', (c) => this.refresh(c));
    this.commands.register('trade.AcceptNpc', (c) => this.acceptNpc(c));
    this.commands.register('trade.AcceptNpcTreasure', (c) => this.acceptNpcTreasure(c));
    this.commands.register('trade.CreateOrder', (c) => this.createOrder(c));
    this.commands.register('trade.AcceptPlayer', (c) => this.acceptPlayer(c));
    this.commands.register('trade.CancelOrder', (c) => this.cancelOrder(c));

    // 中心建成/升级 → 确保中心状态存在并刷新参数。
    this.bus.on('building.Built', (evt: DomainEvent) => {
      const { villageId, kind } = evt.payload as { villageId: string; kind: string };
      if (kind === 'tradecenter') void this.ensureCenter(villageId);
    });
    this.bus.on('building.Upgraded', (evt: DomainEvent) => {
      const { villageId, kind } = evt.payload as { villageId: string; kind: string };
      if (kind === 'tradecenter') void this.ensureCenter(villageId);
    });
    // 商队返回家园 → 回收该村贸易路线。
    this.bus.on('movement.CaravanReturned', (evt: DomainEvent) => {
      const { villageId, routesFreed } = evt.payload as { villageId: string; routesFreed: number };
      void this.recoverRoutes(villageId, Number(routesFreed) || 0);
    });
  }

  resume(): void {
    for (const s of this.store.all<TradeCenterState>(COLLECTION)) {
      // 重建全局挂单索引
      for (const o of s.createdOrders) this.orders.set(o.id, o);
      // 过期挂单清理
      const before = s.createdOrders.length;
      s.createdOrders = s.createdOrders.filter((o) => o.ttlAt > this.now());
      if (s.createdOrders.length !== before) this.store.set(COLLECTION, s.villageId, s);
      // 重排自动刷新：用当前配置间隔重算 nextRefreshAt（覆盖旧存档遗留的过期时间戳）
      if (s.level > 0) {
        const tc = this.config.tradeCenter[s.level] ?? { npcRefreshSec: 3600, npcStoredRefreshes: 1, tradeViewRadius: 5, npcOrderCount: 3, tradeRoutes: 2 };
        s.nextRefreshAt = this.now() + tc.npcRefreshSec * 1000;
      }
      const delay = Math.max(0, s.nextRefreshAt - this.now());
      s.taskId = this.scheduler.schedule(
        delay,
        () => this.refreshTick(s.villageId),
        `trade:${s.villageId}`,
        `village:${s.villageId}`,
      );
      this.store.set(COLLECTION, s.villageId, s);
    }
  }

  // ── 内部辅助 ─────────────────────────────────────────────────────────────

  private load(villageId: string): TradeCenterState | undefined {
    return this.store.get<TradeCenterState>(COLLECTION, villageId);
  }

  private worldSize(): { W: number; H: number } {
    return { W: this.config.constants.worldW ?? 41, H: this.config.constants.worldH ?? 41 };
  }

  /** 读贸易中心建筑等级（口径唯一）。 */
  private async getCenterLevel(villageId: string): Promise<number> {
    const res = await this.commands.send({
      name: 'building.GetBuildingLevel', from: TradeModule.NAME,
      payload: { villageId, kind: 'tradecenter' },
    });
    return (res.payload as any)?.level ?? 0;
  }

  /** 取村庄地图坐标。 */
  private async villageXY(villageId: string): Promise<Hex | null> {
    const res = await this.commands.send({
      name: 'world.GetTileByRef', from: TradeModule.NAME,
      payload: { refId: villageId, kind: 'village' },
    });
    const tile = (res.payload as any)?.tile;
    return res.ok && tile ? { q: tile.q, r: tile.r } : null;
  }

  /** 资源记录求和（单位数，含 gold）。 */
  private sumUnits(rec: Record<string, number>): number {
    let t = 0;
    for (const k of RES_KEYS) t += Math.max(0, Math.floor(Number(rec[k]) || 0));
    return t;
  }

  /** 把资源记录清洗为仅含合法 key 的正整数。 */
  private cleanRes(rec: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of RES_KEYS) {
      const v = Math.floor(Number(rec[k]));
      if (v > 0) out[k] = v;
    }
    return out;
  }

  /** 每条贸易路线的运力（单位）。 */
  private routeCapacity(): number {
    return Math.max(1, this.config.constants.tradeRouteCapacity ?? 500);
  }

  /** 生成单条 NPC 资源订单：随机选资源，随机买卖双方，按金币基准价值计价。 */
  private rollNpcOrder(level: number, viewRadius: number, expiresAt: number): NpcOrder {
    const c = this.config.constants;
    const res = TRADE_RES[Math.floor(Math.random() * TRADE_RES.length)];
    // 交易量随等级温和放大
    const qty = 200 + Math.floor(Math.random() * (400 + level * 120));
    const value = qty * (c.tradeNpcGoldPerResource ?? 0.5);
    const sellSide = Math.random() < 0.5; // true=玩家卖给NPC(拿折价金币)；false=玩家向NPC买(付全额金币)
    const give: Record<string, number> = {};
    const want: Record<string, number> = {};
    if (sellSide) {
      give.gold = Math.max(1, Math.round(value * (c.tradeNpcSellMargin ?? 0.8)));
      want[res] = qty;
    } else {
      give[res] = qty;
      want.gold = Math.max(1, Math.round(value));
    }
    const distance = 1 + Math.floor(Math.random() * Math.max(1, viewRadius));
    return { id: this.nextId(), give, want, distance, expiresAt };
  }

  /** 生成一条「NPC 出售宝物」订单：用 dropRate 统一控制野外掉落与贸易中心出现概率，买价=目录价×加价倍率，卖出回收价=目录价。 */
  private rollTreasureOffer(expiresAt: number): NpcOrder {
    const c = this.config.constants;
    // 用 dropRate 统一控制野外掉落和贸易中心出现概率
    const pool = this.tradeableTreasures;
    const weights = pool.map((t) => this.config.treasures[t.code]?.dropRate ?? 0);
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return this.rollNpcOrder(1, 5, expiresAt);
    let r = Math.random() * total;
    let chosen = pool[0];
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) { chosen = pool[i]; break; }
    }
    const def = this.config.treasures[chosen.code];
    if (!def) return this.rollNpcOrder(1, 5, expiresAt); // 兜底：理论上不会触发
    const buyPrice = Math.max(1, Math.round((def.priceGold ?? 0) * (c.treasureNpcBuyMarkup ?? 1.6)));
    const sellPrice = def.priceGold ?? 0;
    const treasure: NpcTreasureOffer = {
      code: def.code, name: def.name, icon: def.icon, category: def.category,
      rarity: def.rarity, effectType: def.effectType, effectValue: def.effectValue,
      applyType: def.applyType, buyPrice, sellPrice,
    };
    return { id: this.nextId(), give: {}, want: { gold: buyPrice }, distance: 0, expiresAt, treasure };
  }

  /**
   * 生成整池 NPC 订单：先铺满 npcOrderCount 条普通资源订单，
   * 再以 treasureNpcOfferChance 概率「覆盖其中一条」普通订单为宝物出售订单
   * （而非在普通订单之外额外多塞一条）。宝物出售订单在数量上始终占用一个普通订单名额。
   */
  private buildPool(tc: { npcOrderCount: number; tradeViewRadius: number }, level: number, expiresAt: number): NpcOrder[] {
    const pool = Array.from({ length: tc.npcOrderCount }, () => this.rollNpcOrder(level, tc.tradeViewRadius, expiresAt));
    if (this.tradeableTreasures.length > 0 && Math.random() < this.config.constants.treasureNpcOfferChance) {
      const idx = Math.floor(Math.random() * pool.length);
      pool[idx] = this.rollTreasureOffer(expiresAt);
    }
    return pool;
  }

  private nextId(): string {
    return `tc_${this.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /** 取消并重新登记自动刷新定时。 */
  private scheduleRefresh(villageId: string, at: number): string {
    this.scheduler.cancelByOwner(`trade:${villageId}`);
    const delay = Math.max(0, at - this.now());
    return this.scheduler.schedule(
      delay,
      () => this.refreshTick(villageId),
      `trade:${villageId}`,
      `village:${villageId}`,
    );
  }

  // ── 中心生命周期 ─────────────────────────────────────────────────────────

  private async ensureCenter(villageId: string): Promise<void> {
    const level = await this.getCenterLevel(villageId);
    if (level <= 0) return; // 中心尚未建成
    const tc = this.config.tradeCenter[level] ?? { tradeRoutes: 2, tradeViewRadius: 5, npcOrderCount: 3, npcRefreshSec: 3600, npcStoredRefreshes: 1 };

    const existing = this.load(villageId);
    if (!existing) {
      const expiresAt = this.now() + tc.npcRefreshSec * 1000;
      const pool = this.buildPool(tc, level, expiresAt);
      const nextRefreshAt = expiresAt;
      const s: TradeCenterState = {
        villageId, level, npcOrderPool: pool, storedRefreshes: 0,
        nextRefreshAt, tradeRoutesUsed: 0, createdOrders: [],
      };
      s.taskId = this.scheduleRefresh(villageId, nextRefreshAt);
      this.store.set(COLLECTION, villageId, s);
      await this.emitUpdated(villageId);
      return;
    }
    // 升级：更新等级、按新间隔重排自动刷新；保留订单池与已存储次数。
    existing.level = level;
    existing.nextRefreshAt = this.now() + tc.npcRefreshSec * 1000;
    existing.taskId = this.scheduleRefresh(villageId, existing.nextRefreshAt);
    this.store.set(COLLECTION, villageId, existing);
    await this.emitUpdated(villageId);
  }

  /** 自动刷新 tick：重roll NPC 订单池 + 存储次数 +1 + 重排程。 */
  private async refreshTick(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const tc = this.config.tradeCenter[s.level] ?? { tradeRoutes: 2, tradeViewRadius: 5, npcOrderCount: 3, npcRefreshSec: 3600, npcStoredRefreshes: 1 };
    const expiresAt = this.now() + tc.npcRefreshSec * 1000;
    s.npcOrderPool = this.buildPool(tc, s.level, expiresAt);
    s.storedRefreshes = Math.min(tc.npcStoredRefreshes, s.storedRefreshes + 1);
    s.nextRefreshAt = expiresAt;
    s.taskId = this.scheduleRefresh(villageId, expiresAt);
    this.store.set(COLLECTION, s.villageId, s);
    await this.emitUpdated(villageId);
    log('NPC 订单自动刷新', { village: villageId, level: s.level, stored: s.storedRefreshes });
  }

  private async recoverRoutes(villageId: string, routes: number): Promise<void> {
    if (routes <= 0) return;
    const s = this.load(villageId);
    if (!s) return;
    s.tradeRoutesUsed = Math.max(0, s.tradeRoutesUsed - routes);
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);
  }

  private async emitUpdated(villageId: string): Promise<void> {
    await this.bus.emit({
      name: 'trade.CenterUpdated', source: TradeModule.NAME, ts: this.now(),
      payload: { villageId },
    } as DomainEvent);
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  private async getCenter(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    const level = await this.getCenterLevel(villageId);
    if (!s || level <= 0) {
      return { ok: true, payload: { built: false, level: 0, tradeRoutes: 0, tradeRoutesUsed: 0, availableRoutes: 0, viewRadius: 0, npcOrders: [], npcStoredRefreshes: 0, npcMaxStored: 0, npcRefreshSec: 0, npcNextRefreshAt: 0, playerOrders: [], myOrders: [], playerOrderMax: 0, playerOrderCurrent: 0, gold: 0 } };
    }
    const tc = this.config.tradeCenter[level] ?? { tradeRoutes: 2, tradeViewRadius: 5, npcOrderCount: 3, npcRefreshSec: 3600, npcStoredRefreshes: 1 };
    const available = Math.max(0, tc.tradeRoutes - s.tradeRoutesUsed);

    // 本村坐标（用于计算可见玩家订单距离）
    const myXY = await this.villageXY(villageId);
    const { W, H } = this.worldSize();

    // 可见玩家订单：在视野半径内且非本村挂单
    let playerOrders: Array<Record<string, any>> = [];
    if (myXY) {
      const raw = [...this.orders.values()]
        .filter((o) => o.villageId !== villageId && o.ttlAt > this.now())
        .map((o) => ({
          id: o.id, villageId: o.villageId, give: o.give, want: o.want,
          routesNeeded: o.routesNeeded,
          distance: hexDistanceWrapped(myXY, o.fromXY, W, H),
          ttlAt: o.ttlAt,
        }))
        .filter((o) => o.distance <= tc.tradeViewRadius);
      // 解析每条订单对应玩家名字（经 village→player 反查），供贸易中心展示归属
      const nameByVillage = new Map<string, string>();
      for (const o of raw) {
        if (nameByVillage.has(o.villageId)) continue;
        const r = await this.commands.send({ name: 'player.GetByVillage', from: TradeModule.NAME, payload: { villageId: o.villageId } });
        nameByVillage.set(o.villageId, r.ok ? ((r.payload as any).player?.name ?? '玩家') : '玩家');
      }
      playerOrders = raw.map((o) => ({ ...o, ownerName: nameByVillage.get(o.villageId) ?? '玩家' }));
    }

    const myOrders = s.createdOrders.map((o) => ({
      id: o.id, villageId: o.villageId, give: o.give, want: o.want,
      routesNeeded: o.routesNeeded, distance: 0, ttlAt: o.ttlAt,
    }));

    const goldRes = await this.commands.send({ name: 'economy.GetResources', from: TradeModule.NAME, payload: { villageId } });
    const gold = (goldRes.payload as any)?.resources?.gold ?? 0;

    return {
      ok: true,
      payload: {
        built: true,
        level,
        tradeRoutes: tc.tradeRoutes,
        tradeRoutesUsed: s.tradeRoutesUsed,
        availableRoutes: available,
        viewRadius: tc.tradeViewRadius,
        // NPC 订单池：普通资源订单 + 宝物出售订单（宝物出售按概率覆盖其中一条普通订单，随 normal 一起在此展示）
        npcOrders: s.npcOrderPool.map((o) => ({
          id: o.id, give: o.give, want: o.want, distance: o.distance, expiresAt: o.expiresAt,
          treasure: o.treasure
            ? {
                code: o.treasure.code, name: o.treasure.name, icon: o.treasure.icon,
                category: o.treasure.category, rarity: o.treasure.rarity,
                effectType: o.treasure.effectType, effectValue: o.treasure.effectValue,
                applyType: o.treasure.applyType, buyPrice: o.treasure.buyPrice, sellPrice: o.treasure.sellPrice,
              }
            : undefined,
        })),
        npcStoredRefreshes: s.storedRefreshes,
        npcMaxStored: tc.npcStoredRefreshes,
        npcRefreshSec: tc.npcRefreshSec,
        npcNextRefreshAt: s.nextRefreshAt,
        playerOrders,
        myOrders,
        playerOrderMax: this.config.constants.tradeOrderMaxPerVillage ?? 5,
        playerOrderCurrent: s.createdOrders.length,
        gold,
      },
    };
  }

  private async refresh(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'no_center' };
    if (s.storedRefreshes <= 0) return { ok: false, payload: {}, reason: 'no_stored_refresh' };
    s.storedRefreshes -= 1;
    const tc = this.config.tradeCenter[s.level] ?? { tradeRoutes: 2, tradeViewRadius: 5, npcOrderCount: 3, npcRefreshSec: 3600, npcStoredRefreshes: 1 };
    const expiresAt = s.nextRefreshAt;
    s.npcOrderPool = this.buildPool(tc, s.level, expiresAt);
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);
    const base = await this.getCenter({ name: 'trade.GetCenter', from: 'trade', payload: { villageId } });
    return { ok: true, payload: (base.payload as any) };
  }

  private async acceptNpc(cmd: Command): Promise<CommandResult> {
    const { villageId, orderId } = cmd.payload as { villageId: string; orderId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'no_center' };
    const idx = s.npcOrderPool.findIndex((o) => o.id === orderId);
    if (idx < 0) return { ok: false, payload: {}, reason: 'order_not_found' };
    const order = s.npcOrderPool[idx];
    // 宝物出售订单必须经 AcceptNpcTreasure 处理（需扣金币+入栏/替换）；误走普通成交会扣金却不给宝物
    if (order.treasure) return { ok: false, payload: {}, reason: 'treasure_offer_use_special' };

    // 即时交付：先扣后给，NPC 订单无需等待商队。
    const spend = await this.commands.send({
      name: 'economy.TrySpend', from: TradeModule.NAME,
      payload: { villageId, cost: order.want },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };
    await this.commands.send({
      name: 'economy.Grant', from: TradeModule.NAME,
      payload: { villageId, gain: order.give },
    });

    // 从池中移除该笔订单；不立即补新单，腾出的槽位留空，
    // 直到下一次自动刷新（npcRefreshSec）或手动刷新（消耗存储次数）。
    s.npcOrderPool.splice(idx, 1);
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);

    const base = await this.getCenter({ name: 'trade.GetCenter', from: 'trade', payload: { villageId } });
    return { ok: true, payload: (base.payload as any) };
  }

  /**
   * 购买 NPC 出售的宝物。
   * 流程：未传 action 时，宝物栏有空位 → 直接买入储存；栏满 → 返回 overflow 让客户端弹「替换/卖给NPC/放弃」。
   *  - store：   扣 buyPrice，treasure.Grant 入栏。
   *  - replace： 扣 buyPrice，treasure.Replace 丢弃 replaceCode 并入新宝物。
   *  - sell：    扣 buyPrice 后把新宝物卖给 NPC 回收 sellPrice（净亏 buyPrice - sellPrice），不占格。
   *  - discard： 不扣金、不消费订单（放弃购买）。
   */
  private async acceptNpcTreasure(cmd: Command): Promise<CommandResult> {
    const { villageId, orderId, action, replaceCode } = cmd.payload as {
      villageId: string; orderId: string; action?: 'store' | 'replace' | 'sell' | 'discard'; replaceCode?: string;
    };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'no_center' };
    const idx = s.npcOrderPool.findIndex((o) => o.id === orderId);
    if (idx < 0) return { ok: false, payload: {}, reason: 'order_not_found' };
    const order = s.npcOrderPool[idx];
    if (!order.treasure) return { ok: false, payload: {}, reason: 'not_treasure_offer' };
    const t = this.config.treasures[order.treasure.code];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    const buyPrice = order.treasure.buyPrice;
    const sellPrice = order.treasure.sellPrice;

    // 当前宝物栏状态（treasure 模块拥有，仅经命令查询；铁律#2：不 import、不回查 store）
    const listRes = await this.commands.send({ name: 'treasure.List', from: TradeModule.NAME, payload: { villageId } });
    const slots = (listRes.payload as any)?.slots ?? 1;
    const codes: string[] = (listRes.payload as any)?.codes ?? [];
    const hasRoom = codes.length < slots;

    // 未指定 action：能存则直接存；满了回 overflow 让客户端弹选择
    const act = action ?? (hasRoom ? 'store' : undefined);
    const treasureInfo = {
      code: t.code, name: t.name, icon: t.icon, category: t.category, rarity: t.rarity,
      effectType: t.effectType, effectValue: t.effectValue, applyType: t.applyType,
      buyPrice, sellPrice,
    };
    if (!act) {
      return { ok: true, payload: { overflow: true, reason: 'treasure_slots_full', treasure: treasureInfo, slots, codes } };
    }
    if (act === 'discard') {
      // 放弃购买：不扣金、不消费订单
      return { ok: true, payload: { discarded: true } };
    }

    // store/replace/sell 均需先扣金币
    const spend = await this.commands.send({
      name: 'economy.TrySpend', from: TradeModule.NAME,
      payload: { villageId, cost: { gold: buyPrice } },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };
    const refund = async () => {
      await this.commands.send({ name: 'economy.Grant', from: TradeModule.NAME, payload: { villageId, gain: { gold: buyPrice } } });
    };

    if (act === 'store') {
      const res = await this.commands.send({ name: 'treasure.Grant', from: TradeModule.NAME, payload: { villageId, code: t.code } });
      if (!res.ok) {
        // 竞态：查询后槽位被占满 → 退款并回 overflow
        await refund();
        return { ok: true, payload: { overflow: true, reason: 'treasure_slots_full', treasure: treasureInfo, slots, codes } };
      }
    } else if (act === 'replace') {
      if (!replaceCode || !codes.includes(replaceCode)) {
        await refund();
        return { ok: false, payload: { codes }, reason: 'bad_replace' };
      }
      const res = await this.commands.send({ name: 'treasure.Replace', from: TradeModule.NAME, payload: { villageId, oldCode: replaceCode, newCode: t.code } });
      if (!res.ok) {
        await refund();
        return { ok: false, payload: res.payload, reason: res.reason ?? 'replace_failed' };
      }
    } else if (act === 'sell') {
      // 买下后立即卖给 NPC 回收 sellPrice，不占格
      await this.commands.send({ name: 'economy.Grant', from: TradeModule.NAME, payload: { villageId, gain: { gold: sellPrice } } });
    }

    // 成功消费订单（store/replace/sell 都消费；discard 已提前返回）
    s.npcOrderPool.splice(idx, 1);
    this.store.set(COLLECTION, villageId, s);
    await this.emitUpdated(villageId);

    const base = await this.getCenter({ name: 'trade.GetCenter', from: 'trade', payload: { villageId } });
    return { ok: true, payload: (base.payload as any) };
  }

  private async createOrder(cmd: Command): Promise<CommandResult> {
    const { villageId, give, want } = cmd.payload as { villageId: string; give?: Record<string, number>; want?: Record<string, number> };
    const s = this.load(villageId);
    const level = await this.getCenterLevel(villageId);
    if (!s || level <= 0) return { ok: false, payload: {}, reason: 'no_center' };
    const cleanGive = this.cleanRes(give ?? {});
    const cleanWant = this.cleanRes(want ?? {});
    if (Object.keys(cleanGive).length === 0 || Object.keys(cleanWant).length === 0) {
      return { ok: false, payload: {}, reason: 'empty_payload' };
    }
    const tc = this.config.tradeCenter[level] ?? { tradeRoutes: 2, tradeViewRadius: 5, npcOrderCount: 3, npcRefreshSec: 3600, npcStoredRefreshes: 1 };
    const available = Math.max(0, tc.tradeRoutes - s.tradeRoutesUsed);

    // 路线运力校验：己方提供的货物单位数须可由可用路线运完。
    const giveUnits = this.sumUnits(cleanGive);
    const routesNeeded = Math.ceil(giveUnits / this.routeCapacity());
    if (routesNeeded > available) return { ok: false, payload: { routesNeeded, available }, reason: 'insufficient_routes' };

    // 挂单数量上限
    const maxOrders = this.config.constants.tradeOrderMaxPerVillage ?? 5;
    if (s.createdOrders.length >= maxOrders) return { ok: false, payload: {}, reason: 'order_limit' };

    const xy = await this.villageXY(villageId);
    if (!xy) return { ok: false, payload: {}, reason: 'village_not_found' };

    const order: PlayerOrder = {
      id: this.nextId(), villageId, fromXY: xy, give: cleanGive, want: cleanWant,
      routesNeeded, createdAt: this.now(),
      ttlAt: this.now() + (this.config.constants.tradeOrderTtlSec ?? 86400) * 1000,
    };
    s.createdOrders.push(order);
    s.tradeRoutesUsed += routesNeeded; // 创建即预占路线：避免仅 1 条路线时重复挂多单
    this.store.set(COLLECTION, villageId, s);
    this.orders.set(order.id, order);
    await this.emitUpdated(villageId);

    const base = await this.getCenter({ name: 'trade.GetCenter', from: 'trade', payload: { villageId } });
    return { ok: true, payload: (base.payload as any) };
  }

  private async acceptPlayer(cmd: Command): Promise<CommandResult> {
    const { villageId, orderId } = cmd.payload as { villageId: string; orderId: string };
    const order = this.orders.get(orderId);
    if (!order) return { ok: false, payload: {}, reason: 'order_not_found' };
    if (order.villageId === villageId) return { ok: false, payload: {}, reason: 'own_order' };
    if (order.ttlAt <= this.now()) { this.removeOrder(order); return { ok: false, payload: {}, reason: 'order_expired' }; }

    const acceptorLevel = await this.getCenterLevel(villageId);
    if (acceptorLevel <= 0) return { ok: false, payload: {}, reason: 'no_center' };
    const aTc = this.config.tradeCenter[acceptorLevel] ?? { tradeRoutes: 2, tradeViewRadius: 5, npcOrderCount: 3, npcRefreshSec: 3600, npcStoredRefreshes: 1 };

    // 距离校验
    const accXY = await this.villageXY(villageId);
    if (!accXY) return { ok: false, payload: {}, reason: 'village_not_found' };
    const { W, H } = this.worldSize();
    const dist = hexDistanceWrapped(accXY, order.fromXY, W, H);
    if (dist > aTc.tradeViewRadius) return { ok: false, payload: { distance: dist, viewRadius: aTc.tradeViewRadius }, reason: 'too_far' };

    // 创建者状态与路线校验
    const creator = this.load(order.villageId);
    if (!creator) return { ok: false, payload: {}, reason: 'creator_gone' };
    const cTc = this.config.tradeCenter[creator.level] ?? { tradeRoutes: 2, tradeViewRadius: 5, npcOrderCount: 3, npcRefreshSec: 3600, npcStoredRefreshes: 1 };
    const creatorAvailable = Math.max(0, cTc.tradeRoutes - creator.tradeRoutesUsed);
    if (order.routesNeeded > creatorAvailable) return { ok: false, payload: {}, reason: 'creator_insufficient_routes' };

    // 接受方路线校验：接受方需运出 order.want
    let acceptor = this.load(villageId);
    if (!acceptor) { await this.ensureCenter(villageId); acceptor = this.load(villageId); }
    if (!acceptor) return { ok: false, payload: {}, reason: 'no_center' };
    const acceptorRoutes = Math.ceil(this.sumUnits(order.want) / this.routeCapacity());
    const acceptorAvailable = Math.max(0, aTc.tradeRoutes - acceptor.tradeRoutesUsed);
    if (acceptorRoutes > acceptorAvailable) return { ok: false, payload: { routesNeeded: acceptorRoutes, available: acceptorAvailable }, reason: 'insufficient_routes' };

    // 资源可用性预检（避免半扣）
    const cRes = await this.commands.send({ name: 'economy.GetResources', from: TradeModule.NAME, payload: { villageId: order.villageId } });
    const aRes = await this.commands.send({ name: 'economy.GetResources', from: TradeModule.NAME, payload: { villageId } });
    const cResources = (cRes.payload as any)?.resources ?? {};
    const aResources = (aRes.payload as any)?.resources ?? {};
    for (const k of RES_KEYS) {
      if ((order.give[k] ?? 0) > (cResources[k] ?? 0)) return { ok: false, payload: { res: k }, reason: 'creator_insufficient_resource' };
      if ((order.want[k] ?? 0) > (aResources[k] ?? 0)) return { ok: false, payload: { res: k }, reason: 'acceptor_insufficient_resource' };
    }

    // 扣资源（先创建者后接受者；任一失败退款）
    const cSpend = await this.commands.send({ name: 'economy.TrySpend', from: TradeModule.NAME, payload: { villageId: order.villageId, cost: order.give } });
    if (!cSpend.ok) return { ok: false, payload: {}, reason: cSpend.reason ?? 'spend_failed' };
    const aSpend = await this.commands.send({ name: 'economy.TrySpend', from: TradeModule.NAME, payload: { villageId, cost: order.want } });
    if (!aSpend.ok) {
      await this.commands.send({ name: 'economy.Grant', from: TradeModule.NAME, payload: { villageId: order.villageId, gain: order.give } });
      return { ok: false, payload: {}, reason: aSpend.reason ?? 'spend_failed' };
    }

    // 派双向商队
    const cCaravan = await this.commands.send({
      name: 'movement.SendCaravan', from: TradeModule.NAME,
      payload: { fromVillage: order.villageId, targetVillage: villageId, cargo: order.give, homeVillage: order.villageId, routesFreed: order.routesNeeded },
    });
    if (!cCaravan.ok) {
      await this.commands.send({ name: 'economy.Grant', from: TradeModule.NAME, payload: { villageId: order.villageId, gain: order.give } });
      await this.commands.send({ name: 'economy.Grant', from: TradeModule.NAME, payload: { villageId, gain: order.want } });
      return { ok: false, payload: {}, reason: cCaravan.reason ?? 'caravan_failed' };
    }
    const aCaravan = await this.commands.send({
      name: 'movement.SendCaravan', from: TradeModule.NAME,
      payload: { fromVillage: villageId, targetVillage: order.villageId, cargo: order.want, homeVillage: villageId, routesFreed: acceptorRoutes },
    });
    if (!aCaravan.ok) {
      await this.commands.send({ name: 'economy.Grant', from: TradeModule.NAME, payload: { villageId: order.villageId, gain: order.give } });
      await this.commands.send({ name: 'economy.Grant', from: TradeModule.NAME, payload: { villageId, gain: order.want } });
      return { ok: false, payload: {}, reason: aCaravan.reason ?? 'caravan_failed' };
    }

    // 移除订单；创建方路线已在挂单时预占（createOrder 已 +routesNeeded），此处不再重复累加。
    // 接单方路线在此预占（其送出 want 的运力）。
    acceptor.tradeRoutesUsed += acceptorRoutes;
    this.store.set(COLLECTION, villageId, acceptor);
    this.removeOrder(order);

    await this.emitUpdated(order.villageId);
    await this.emitUpdated(villageId);

    const base = await this.getCenter({ name: 'trade.GetCenter', from: 'trade', payload: { villageId } });
    return { ok: true, payload: (base.payload as any) };
  }

  private async cancelOrder(cmd: Command): Promise<CommandResult> {
    const { villageId, orderId } = cmd.payload as { villageId: string; orderId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'no_center' };
    const order = s.createdOrders.find((o) => o.id === orderId);
    if (!order) return { ok: false, payload: {}, reason: 'order_not_found' };
    s.tradeRoutesUsed = Math.max(0, s.tradeRoutesUsed - order.routesNeeded); // 撤销挂单释放预占路线
    this.removeOrder(order);
    await this.emitUpdated(villageId);
    const base = await this.getCenter({ name: 'trade.GetCenter', from: 'trade', payload: { villageId } });
    return { ok: true, payload: (base.payload as any) };
  }

  /** 从全局索引与本村状态中移除一条玩家挂单。 */
  private removeOrder(order: PlayerOrder): void {
    this.orders.delete(order.id);
    const s = this.load(order.villageId);
    if (s) {
      s.createdOrders = s.createdOrders.filter((o) => o.id !== order.id);
      this.store.set(COLLECTION, order.villageId, s);
    }
  }

  // ── 运维钩子（app.ts 调用） ────────────────────────────────────────────────

  /** 单村 wipe：清空贸易状态与挂单索引中该村条目（app.ts 在丢村/删号时按村调用）。 */
  wipeSingleVillage(villageId: string): void {
    const s = this.load(villageId);
    if (s) for (const o of s.createdOrders) this.orders.delete(o.id);
    this.store.delete(COLLECTION, villageId);
  }
}

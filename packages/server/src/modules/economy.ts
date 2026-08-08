import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { ModuleManifest } from '../gateway/manifest.js';
import { makeLogger } from '../infra/logger.js';

const log = makeLogger('economy');

/**
 * 领域模块 · Economy（经济）
 * 对应设计文档 02_系统清单A组、03_架构总览(派生属性管线)
 *
 * 职责：每村资源存量/产率/上限的唯一 owner。所有花资源/给资源的裁判。
 *
 * 4 资源：wood/clay/iron/crop。crop 特殊——有净消耗（建筑人口+军队耗粮）：
 *   crop净产率 = 农田产出 - Σupkeep。可为负，触底发 CropDeficit（Military 据此逃兵）。
 * upkeep 由各模块算好后经 SetUpkeep 上报（Economy 不懂建筑/兵种细节，派生管线对内口径）。
 *
 * 惰性结算：资源不每秒写，读/写前按 (now-lastTick)*rate 补算。
 * 仓储超额：强制入库（Grant）可超过 capacity；超额资源生产暂停，口粮消耗仍生效；
 *           自然产出顶到 capacity，不会自行超额。
 * 扩展点：资源种类来自 config.resources（resources.csv），初始量/容量/成长来自 config.constants。
 */

export const RESOURCE_TYPES = ['wood', 'clay', 'iron', 'crop', 'gold'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type ResMap = Record<ResourceType, number>;
/** 金币无上限：用有限大值代替 Infinity（避免 JSON 序列化变 null 后客户端读到 null）。 */
export const GOLD_CAP = Number.MAX_SAFE_INTEGER;

interface EconomyState {
  villageId: string;
  resources: ResMap;
  lastTick: number;
  /** 各资源基础每秒产率（资源田等级决定，building 事件更新） */
  baseRate: ResMap;
  /** 产率加成层（派生管线：建筑强化/英雄/工会…每个一层） */
  rateModifiers: { source: string; mult: Partial<ResMap> }[];
  /** crop 每小时消耗，按来源记（building 人口 / military 耗粮） */
  cropUpkeep: Record<string, number>;
  capacity: ResMap;
  /**
   * 上次 settle 时是否处于粮食赤字（crop<=0 且净产率<0）。
   * 用于边沿触发：只在从 false→true 时才 emit CropDeficit，避免每次 settle 都触发。
   * 旧存档无此字段，默认 false（视为非赤字状态，下次 settle 若赤字则正常触发）。
   */
  wasCropDeficit?: boolean;
}

const COLLECTION = 'economy';

function zero(): ResMap {
  return { wood: 0, clay: 0, iron: 0, crop: 0, gold: 0 };
}

export class EconomyModule {
  static readonly NAME = 'economy';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'economy',
    publicActions: {
      GetResources: { command: 'economy.GetResources', ownVillage: true, needAuth: true, schema: {} },
    },
    eventPushMap: {
      'economy.CropDeficit': 'CropDeficit',
    },
  };

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private now: () => number,
    private config: import('../infra/config.js').GameConfig,
  ) {}

  /** 热重载配置（改 CSV 后调用）。 */
  setConfig(config: import('../infra/config.js').GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.commands.register('economy.GetResources', (c) => this.getResources(c));
    this.commands.register('economy.TrySpend', (c) => this.trySpend(c));
    this.commands.register('economy.Grant', (c) => this.grant(c));
    this.commands.register('economy.GetLootable', (c) => this.getLootable(c));
    this.commands.register('economy.TakeLoot', (c) => this.takeLoot(c));
    this.commands.register('economy.SetUpkeep', (c) => this.setUpkeep(c));
    this.commands.register('economy.SetBaseRate', (c) => this.setBaseRate(c));
    this.commands.register('economy.SetCapacity', (c) => this.setCapacity(c));
    this.commands.register('economy.SetRateModifier', (c) => this.setRateModifier(c));
    this.commands.register('economy.GetCropContext', (c) => this.getCropContext(c));
  }

  createVillage(villageId: string): void {
    const c = this.config.constants;
    const start = c.startResourceAmount;
    const cap = c.storageBase;
    const baseRatePerSec = c.baseProductionPerHour / 3600;
    const s: EconomyState = {
      villageId,
      resources: { wood: start, clay: start, iron: start, crop: start, gold: c.startGoldAmount },
      lastTick: this.now(),
      // 初始每小时各产约 baseProductionPerHour（来自 config），换算到每秒；金币无基础产出（靠人口交税 Grant）
      baseRate: { wood: baseRatePerSec, clay: baseRatePerSec, iron: baseRatePerSec, crop: baseRatePerSec, gold: 0 },
      rateModifiers: [],
      cropUpkeep: {},
      capacity: { wood: cap, clay: cap, iron: cap, crop: cap, gold: GOLD_CAP },
    };
    this.store.set(COLLECTION, villageId, s);
  }

  // ---- 惰性结算 ----
  /**
   * 仓储超额规则（分城/运输/掠夺通用）：
   * - 允许 resources > capacity（由 Grant 等强制入库产生）
   * - 超额时该资源**生产**暂停；crop 口粮消耗仍生效
   * - 自然产出不得把存量推过 capacity（只有强制入库可超额）
   */
  private settle(s: EconomyState): void {
    const now = this.now();
    const elapsed = (now - s.lastTick) / 1000;
    // 迁移兜底：旧存档（新增 gold 前）缺 gold 字段 → 补初始金币存量与无限容量；避免 NaN 且不让老玩家被 +1 建造费卡死。
    for (const t of RESOURCE_TYPES) {
      if (s.resources[t] === undefined) s.resources[t] = t === 'gold' ? this.config.constants.startGoldAmount : 0;
      if (s.capacity[t] === undefined) s.capacity[t] = t === 'gold' ? GOLD_CAP : 0;
    }
    if (elapsed <= 0) return;
    for (const t of RESOURCE_TYPES) {
      const wasOver = s.resources[t] > s.capacity[t];
      const rate = this.netRate(s, t);
      let next = s.resources[t] + rate * elapsed;
      next = Math.max(0, next);
      // 未超额时，自然产出顶到容量为止；金币容量=MAX 永不触发（无上限）
      if (!wasOver && next > s.capacity[t]) next = s.capacity[t];
      s.resources[t] = next;
    }
    s.lastTick = now;
    // 边沿触发 CropDeficit：仅在从非赤字→赤字时 emit 一次，避免每次 settle 都触发。
    // 旧存档 wasCropDeficit 未定义时视为 false（不改变触发语义）。
    const nowInDeficit = this.netRate(s, 'crop') < 0 && s.resources.crop <= 0;
    if (nowInDeficit && !s.wasCropDeficit) {
      s.wasCropDeficit = true;
      void this.bus.emit({
        name: 'economy.CropDeficit',
        source: EconomyModule.NAME,
        ts: now,
        payload: { villageId: s.villageId },
      } as DomainEvent);
    } else if (!nowInDeficit) {
      s.wasCropDeficit = false;
    }
  }

  /** 毛产率（派生管线叠加加成层）。 */
  private grossRate(s: EconomyState, t: ResourceType): number {
    let mult = 1;
    for (const m of s.rateModifiers) mult += m.mult[t] ?? 0;
    return s.baseRate[t] * mult;
  }

  /** 净产率：超额时毛产=0；crop 仍减每秒消耗。 */
  private netRate(s: EconomyState, t: ResourceType): number {
    const over = s.resources[t] > s.capacity[t];
    const gross = over ? 0 : this.grossRate(s, t);
    if (t !== 'crop') return gross;
    const upkeepPerHour = Object.values(s.cropUpkeep).reduce((a, b) => a + b, 0);
    return gross - upkeepPerHour / 3600;
  }

  private load(villageId: string): EconomyState | undefined {
    return this.store.get<EconomyState>(COLLECTION, villageId);
  }

  // ---- Commands ----

  private getResources(cmd: Command): CommandResult {
    const s = this.load((cmd.payload as any).villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.stripBuildingUpkeep(s); // v3：剔除历史残留的建筑耗粮，避免影响结算/净产率
    this.settle(s);
    this.store.set(COLLECTION, s.villageId, s);
    const netRate = zero();
    const overCapacity: ResMap = zero();
    const productionPaused: Record<ResourceType, boolean> = {
      wood: false, clay: false, iron: false, crop: false, gold: false,
    };
    for (const t of RESOURCE_TYPES) {
      netRate[t] = this.netRate(s, t);
      overCapacity[t] = Math.max(0, s.resources[t] - s.capacity[t]);
      productionPaused[t] = s.resources[t] > s.capacity[t];
    }
    const upkeep = Object.values(s.cropUpkeep).reduce((a, b) => a + b, 0);
    return {
      ok: true,
      payload: {
        resources: { ...s.resources },
        capacity: { ...s.capacity },
        netRate, // 每秒
        cropUpkeep: upkeep, // 每小时
        overCapacity,       // 各资源超出容量的量（0=未超额）
        productionPaused,   // 超额则该资源生产暂停
      },
    };
  }

  private trySpend(cmd: Command): CommandResult {
    const { villageId, cost } = cmd.payload as { villageId: string; cost: Partial<ResMap> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s);
    for (const t of RESOURCE_TYPES) {
      if (s.resources[t] < (cost[t] ?? 0)) return { ok: false, payload: {}, reason: `insufficient:${t}` };
    }
    for (const t of RESOURCE_TYPES) s.resources[t] -= cost[t] ?? 0;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { resources: { ...s.resources } } };
  }

  /**
   * 强制入库：全额加上，允许超过 capacity。
   * overflow[t] = 本次入库后该资源超出容量的量（兼容字段；不再表示「未入账」）。
   */
  private grant(cmd: Command): CommandResult {
    const { villageId, gain } = cmd.payload as { villageId: string; gain: Partial<ResMap> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s);
    const applied = zero();
    const overflow = zero();
    for (const t of RESOURCE_TYPES) {
      const add = Math.max(0, gain[t] ?? 0);
      s.resources[t] += add;
      applied[t] = add;
      overflow[t] = Math.max(0, s.resources[t] - s.capacity[t]);
    }
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { applied, overflow } };
  }

  /** 可掠夺量（骨架阶段无地窖，等于全部存量）。 */
  private getLootable(cmd: Command): CommandResult {
    const s = this.load((cmd.payload as any).villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s);
    this.store.set(COLLECTION, s.villageId, s);
    return { ok: true, payload: { lootable: { ...s.resources } } };
  }

  /** 实际扣走战利品。 */
  private takeLoot(cmd: Command): CommandResult {
    const { villageId, amount } = cmd.payload as { villageId: string; amount: Partial<ResMap> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s);
    const before = { ...s.resources };
    const taken = zero();
    for (const t of RESOURCE_TYPES) {
      const want = amount[t] ?? 0;
      const t2 = Math.min(want, s.resources[t]);
      s.resources[t] -= t2;
      taken[t] = t2;
    }
    this.store.set(COLLECTION, villageId, s);
    log('掠夺', { village: villageId, before, want: amount, taken, after: { ...s.resources } });
    return { ok: true, payload: { taken } };
  }

  /**
   * 上报某来源的 crop 每小时消耗（population/military 耗粮算好后调用）。
   * v3 人口模型：建筑不再耗粮（建筑只提供人口上限），故 source='building' 直接忽略；
   * 旧版本残留的 'building' 条目也会在此统一剔除并写回，确保口径干净。
   */
  private setUpkeep(cmd: Command): CommandResult {
    const { villageId, source, cropPerHour } = cmd.payload as {
      villageId: string;
      source: string;
      cropPerHour: number;
    };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s); // 改消耗前先按旧消耗结算
    if (source === 'building') {
      this.stripBuildingUpkeep(s);
      return { ok: true, payload: {} };
    }
    s.cropUpkeep[source] = cropPerHour;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /** v3：剔除历史残留的 'building' 耗粮来源（建筑不再耗粮）。存在则删并写回。 */
  private stripBuildingUpkeep(s: EconomyState): void {
    if ('building' in s.cropUpkeep) {
      delete s.cropUpkeep['building'];
      this.store.set(COLLECTION, s.villageId, s);
    }
  }

  /** Building 上报某资源类型的全村总产率（每小时），Economy 换算后更新 baseRate。 */
  private setBaseRate(cmd: Command): CommandResult {
    const { villageId, resource, ratePerHour } = cmd.payload as {
      villageId: string;
      resource: string;
      ratePerHour: number;
    };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s);
    if (RESOURCE_TYPES.includes(resource as ResourceType)) {
      s.baseRate[resource as ResourceType] = ratePerHour / 3600;
    }
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /** Building 上报全村仓储总容量（已算好，Economy 只存不算，铁律#4）。 */
  private setCapacity(cmd: Command): CommandResult {
    const { villageId, capacity } = cmd.payload as { villageId: string; capacity: Partial<ResMap> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s); // 改容量前先按旧容量结算（避免溢出判定错位）
    for (const t of RESOURCE_TYPES) {
      if (capacity[t] !== undefined) s.capacity[t] = capacity[t]!;
    }
    // 容量变化不砍库存：仍超额则继续停产，容量抬高后自动恢复产出
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /**
   * 注入产率修正器（覆盖式：同 source 层的修正器只存一条）。
   * population 把劳动力增幅 effMult-1 推进来，economy 产率管线叠加后真实生效（铁律#4）。
   * economy 只存不回调 population，无环（见架构文档§二·2.4）。
   */
  private setRateModifier(cmd: Command): CommandResult {
    const { villageId, source, mult } = cmd.payload as {
      villageId: string;
      source: string;
      mult: Partial<ResMap>;
    };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s); // 改修正器前先结算，避免旧倍率被新值覆盖后多算
    // 覆盖式：移除同 source 旧层，追加新层
    s.rateModifiers = s.rateModifiers.filter((m) => m.source !== source);
    s.rateModifiers.push({ source, mult });
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /**
   * 只读查询「粮食上下文」（供 population 模块计算软上限，无回调，无环）。
   * 返回：
   *  - baseCropPerHour：农田原始产率×3600（不含劳动力修正的裸值，pop 自己算 effMult）
   *  - buildingUpkeepPerHour：建筑维护耗粮（v3 人口模型已移除：建筑只提供人口上限，不耗粮；恒为 0）
   *  - troopUpkeepPerHour：军队维护耗粮（source='troops'）
   *  - nonCivilianUpkeep：所有非 civilian_pop 来源的 crop 每小时总消耗（含 building/troops/
   *    soldier_pool/wounded_pool/enroute_pop 等全部来源；供 v2 软上限一步算出，省去逐条手算）
   *  - currentCrop：当前粮食存量
   *  - cropCapacity：粮仓容量
   * 注意：civilian_pop 这条不纳入（那是软上限要衡量的容量），见架构§二·2.4 口径锁定。
   */
  private getCropContext(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.stripBuildingUpkeep(s); // v3：剔除历史残留的建筑耗粮
    // 不 settle（纯读，不产生副作用；population 只需要 baseRate/cropUpkeep 的快照）
    const nonCivilianUpkeep = Object.entries(s.cropUpkeep)
      .filter(([src]) => src !== 'civilian_pop')
      .reduce((sum, [, v]) => sum + v, 0);
    return {
      ok: true,
      payload: {
        baseCropPerHour: s.baseRate.crop * 3600,
        buildingUpkeepPerHour: s.cropUpkeep['building'] ?? 0,
        troopUpkeepPerHour: s.cropUpkeep['troops'] ?? 0,
        nonCivilianUpkeep,
        currentCrop: s.resources.crop,
        cropCapacity: s.capacity.crop,
      },
    };
  }
}

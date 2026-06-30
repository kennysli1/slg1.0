import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Economy（经济）
 * 对应设计文档 02_系统清单A组、1_原版拆解/02资源建筑、03_架构总览(派生属性管线)
 *
 * 职责：每村资源存量/产率/上限的唯一 owner。所有花资源/给资源的裁判。
 *
 * 4 资源：wood/clay/iron/crop。crop 特殊——有净消耗（建筑人口+军队耗粮）：
 *   crop净产率 = 农田产出 - Σupkeep。可为负，触底发 CropDeficit（Military 据此逃兵）。
 * upkeep 由各模块算好后经 SetUpkeep 上报（Economy 不懂建筑/兵种细节，派生管线对内口径）。
 *
 * 惰性结算：资源不每秒写，读/写前按 (now-lastTick)*rate 补算。
 * 扩展点：资源种类来自 config.resources（resources.csv），初始量/容量/成长来自 config.constants。
 */

export const RESOURCE_TYPES = ['wood', 'clay', 'iron', 'crop'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];
export type ResMap = Record<ResourceType, number>;

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
}

const COLLECTION = 'economy';

function zero(): ResMap {
  return { wood: 0, clay: 0, iron: 0, crop: 0 };
}

export class EconomyModule {
  static readonly NAME = 'economy';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'economy',
    publicActions: {
      GetResources: { command: 'economy.GetResources', ownVillage: true, needAuth: true },
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

  init(): void {
    this.commands.register('economy.GetResources', (c) => this.getResources(c));
    this.commands.register('economy.TrySpend', (c) => this.trySpend(c));
    this.commands.register('economy.Grant', (c) => this.grant(c));
    this.commands.register('economy.GetLootable', (c) => this.getLootable(c));
    this.commands.register('economy.TakeLoot', (c) => this.takeLoot(c));
    this.commands.register('economy.SetUpkeep', (c) => this.setUpkeep(c));

    this.bus.on('building.Upgraded', (evt) => {
      const { villageId, kind, level } = evt.payload as { villageId: string; kind: string; level: number };
      this.onBuildingUpgraded(villageId, kind, level);
    });
  }

  createVillage(villageId: string): void {
    const c = this.config.constants;
    const start = c.startResourceAmount;
    const cap = c.storageBase;
    const baseRatePerSec = c.baseProductionPerHour / 3600;
    const s: EconomyState = {
      villageId,
      resources: { wood: start, clay: start, iron: start, crop: start },
      lastTick: this.now(),
      // 初始每小时各产约 baseProductionPerHour（来自 config），换算到每秒
      baseRate: { wood: baseRatePerSec, clay: baseRatePerSec, iron: baseRatePerSec, crop: baseRatePerSec },
      rateModifiers: [],
      cropUpkeep: {},
      capacity: { wood: cap, clay: cap, iron: cap, crop: cap },
    };
    this.store.set(COLLECTION, villageId, s);
  }

  // ---- 惰性结算 ----
  private settle(s: EconomyState): void {
    const now = this.now();
    const elapsed = (now - s.lastTick) / 1000;
    if (elapsed <= 0) return;
    for (const t of RESOURCE_TYPES) {
      const rate = this.netRate(s, t);
      const next = s.resources[t] + rate * elapsed;
      // crop 可因净消耗下降，下限0；其余上限截断
      s.resources[t] = Math.max(0, Math.min(s.capacity[t], next));
    }
    s.lastTick = now;
    if (this.netRate(s, 'crop') < 0 && s.resources.crop <= 0) {
      void this.bus.emit({
        name: 'economy.CropDeficit',
        source: EconomyModule.NAME,
        ts: now,
        payload: { villageId: s.villageId },
      } as DomainEvent);
    }
  }

  /** 毛产率（派生管线叠加加成层）。 */
  private grossRate(s: EconomyState, t: ResourceType): number {
    let mult = 1;
    for (const m of s.rateModifiers) mult += m.mult[t] ?? 0;
    return s.baseRate[t] * mult;
  }

  /** 净产率：crop 要减去每秒消耗，其余=毛产率。 */
  private netRate(s: EconomyState, t: ResourceType): number {
    const gross = this.grossRate(s, t);
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
    this.settle(s);
    this.store.set(COLLECTION, s.villageId, s);
    const netRate = zero();
    for (const t of RESOURCE_TYPES) netRate[t] = this.netRate(s, t);
    const upkeep = Object.values(s.cropUpkeep).reduce((a, b) => a + b, 0);
    return {
      ok: true,
      payload: {
        resources: { ...s.resources },
        capacity: { ...s.capacity },
        netRate, // 每秒
        cropUpkeep: upkeep, // 每小时
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

  private grant(cmd: Command): CommandResult {
    const { villageId, gain } = cmd.payload as { villageId: string; gain: Partial<ResMap> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s);
    const applied = zero();
    const overflow = zero();
    for (const t of RESOURCE_TYPES) {
      const add = gain[t] ?? 0;
      const room = s.capacity[t] - s.resources[t];
      const take = Math.min(add, room);
      s.resources[t] += take;
      applied[t] = take;
      overflow[t] = add - take;
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
    const taken = zero();
    for (const t of RESOURCE_TYPES) {
      const want = amount[t] ?? 0;
      const t2 = Math.min(want, s.resources[t]);
      s.resources[t] -= t2;
      taken[t] = t2;
    }
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { taken } };
  }

  /** 上报某来源的 crop 每小时消耗（building 人口/military 耗粮算好后调用）。 */
  private setUpkeep(cmd: Command): CommandResult {
    const { villageId, source, cropPerHour } = cmd.payload as {
      villageId: string;
      source: string;
      cropPerHour: number;
    };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    this.settle(s); // 改消耗前先按旧消耗结算
    s.cropUpkeep[source] = cropPerHour;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  // ---- Event 反应 ----
  private onBuildingUpgraded(villageId: string, kind: string, level: number): void {
    const s = this.load(villageId);
    if (!s) return;
    this.settle(s);
    // 资源田 → 用 config 里该田的产出公式更新基础产率
    const field = this.config.fields[kind];
    if (field) {
      const t = field.resource as ResourceType;
      // 产量(每小时) = prodBase × prodGrowth^level，换算每秒
      s.baseRate[t] = (field.prodBase * Math.pow(field.prodGrowth, level)) / 3600;
    } else if (kind === 'warehouse') {
      const c = this.config.constants;
      const cap = c.storageBase * (1 + level * c.storageGrowthPerLevel);
      s.capacity.wood = cap;
      s.capacity.clay = cap;
      s.capacity.iron = cap;
    } else if (kind === 'granary') {
      const c = this.config.constants;
      s.capacity.crop = c.storageBase * (1 + level * c.storageGrowthPerLevel);
    }
    this.store.set(COLLECTION, villageId, s);
  }
}

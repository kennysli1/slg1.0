import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Population（人口）
 * 对应设计文档 13_人口系统设计.md / 14_人口系统架构规划.md
 *
 * 职责：每村「当前人口(currentPop)、伤兵队列(woundedPool)」这一块状态的唯一 owner。
 *
 * 核心机制（惰性结算）：
 *  - 增长：Δt × 繁荣度 × pop_growth_per_prosperity，不超软上限。
 *  - 软上限：L = (粮食产率×劳动加成 − 建筑维护 − 军队维护) / pop_per_capita_crop
 *    （从 economy.GetCropContext 拿裸产率，自算 effMult；口径见架构§二·2.4）。
 *  - 超限减员：粮仓触底(economy.CropDeficit) 触发；以 deathRateFactor 为比例按赤字减员。
 *  - 伤兵治愈：走 Scheduler（禁 setTimeout，铁律#3）；healAt 到点回补 currentPop。
 *
 * 无环数据流（architecture§二·2.4）：
 *  - economy.GetCropContext / building.GetLaborContext：纯只读，不回调本模块。
 *  - economy.SetUpkeep(civilian_pop) / economy.SetRateModifier(pop_labor)：单向写，economy 只存。
 *  - economy.CropDeficit 事件：被动订阅，处理时只读/自算，不同步回调 economy。
 */

/** 一批伤兵的恢复记录（Scheduler 到点回补 currentPop）。 */
interface WoundEntry {
  count: number;      // 这批伤兵的人口数
  healAt: number;     // 治愈时刻(ms)，Scheduler 触发
  taskId: string;     // Scheduler 句柄（resume 重登记）
}

/** building.GetLaborContext 拉来的快照，只读缓存（真源在 Building）。 */
interface LaborBuilding {
  kind: string;         // main/barracks/.../woodcutter/...
  level: number;
  resource?: string;    // 仅资源田：wood/clay/iron/crop
}

interface PopulationState {
  villageId: string;
  currentPop: number;
  woundedPool: WoundEntry[];
  lastTick: number;               // 惰性结算基准(ms)
  prosperity: number;             // building.GetLaborContext 算好的繁荣度快照
  laborBuildings: LaborBuilding[]; // laborAmplified 建筑快照
}

const COLLECTION = 'population';

export class PopulationModule {
  static readonly NAME = 'population';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'population',
    publicActions: {
      GetPopulation: { command: 'population.GetSnapshot', ownVillage: true, needAuth: true },
    },
    eventPushMap: {
      'population.Changed': 'PopulationChanged',
    },
  };

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
  ) {}

  init(): void {
    // 对外 Command
    this.commands.register('population.GetSnapshot', (c) => this.getSnapshot(c));
    this.commands.register('population.GetLaborMult', (c) => this.getLaborMult(c));
    this.commands.register('population.ConsumePop', (c) => this.consumePop(c));
    this.commands.register('population.ReturnPop', (c) => this.returnPop(c));
    this.commands.register('population.AddWounded', (c) => this.addWounded(c));

    // 订阅 building 完工/升级事件：拉 GetLaborContext 重算繁荣度+劳动力
    this.bus.on('building.Built', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.refreshLaborContext(villageId);
    });
    this.bus.on('building.Upgraded', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.refreshLaborContext(villageId);
    });

    // 订阅 economy.CropDeficit：粮仓触底时触发减员结算
    this.bus.on('economy.CropDeficit', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.onCropDeficit(villageId);
    });
  }

  /** 重启恢复：为每个伤兵批次重新登记 Scheduler 任务（依 healAt 时间戳）。 */
  resume(): void {
    for (const s of this.store.all<PopulationState>(COLLECTION)) {
      if (!s.woundedPool?.length) continue;
      for (const entry of s.woundedPool) {
        const delay = Math.max(0, entry.healAt - this.now());
        entry.taskId = this.scheduler.schedule(delay, () => this.healWounded(s.villageId, entry.healAt));
      }
      this.store.set(COLLECTION, s.villageId, s);
    }
  }

  /**
   * 新村创建（必须在 economy/building/military 之后调用，确保产率/维护已上报）。
   * currentPop 初始化为软上限（新村开局满员，设计 B-1）。
   */
  async createVillage(villageId: string): Promise<void> {
    // 先拉劳动力上下文（建筑已就绪）
    const laborRes = await this.commands.send({
      name: 'building.GetLaborContext',
      from: PopulationModule.NAME,
      payload: { villageId },
    });
    const prosperity: number = (laborRes.payload as any)?.prosperity ?? 0;
    const laborBuildings: LaborBuilding[] = (laborRes.payload as any)?.buildings ?? [];

    // 计算初始 effMult[crop]（新村 P=0，但 floor=0.75 保底）
    const effMultCrop = this.calcEffMultCrop(laborBuildings, 0);

    // 拉粮食上下文
    const cropRes = await this.commands.send({
      name: 'economy.GetCropContext',
      from: PopulationModule.NAME,
      payload: { villageId },
    });
    const baseCropPerHour: number = (cropRes.payload as any)?.baseCropPerHour ?? 0;
    const buildingUpkeep: number = (cropRes.payload as any)?.buildingUpkeepPerHour ?? 0;
    const troopUpkeep: number = (cropRes.payload as any)?.troopUpkeepPerHour ?? 0;

    const c = this.config.constants;
    const softLimit = Math.max(0,
      (baseCropPerHour * effMultCrop - buildingUpkeep - troopUpkeep) / c.popPerCapitaCrop,
    );
    // 新村满员开局
    const initPop = Math.floor(softLimit);

    const s: PopulationState = {
      villageId,
      currentPop: initPop,
      woundedPool: [],
      lastTick: this.now(),
      prosperity,
      laborBuildings,
    };
    this.store.set(COLLECTION, villageId, s);

    // 开局上报民用人口维护 + 劳动力修正器
    await this.reportToEconomy(s, softLimit, effMultCrop);
  }

  private load(villageId: string): PopulationState | undefined {
    return this.store.get<PopulationState>(COLLECTION, villageId);
  }

  // ── 惰性结算 ──────────────────────────────────────────────────────────────

  /**
   * 惰性结算（读写前按 Δt 补算）。
   * 增长不越过软上限；粮仓触底时按赤字速率减员（超出软上限且 currentCrop<=0）。
   * 每次结算后若 effMult/upkeep 变化超阈值则推送到 economy，并 emit population.Changed。
   */
  private async settle(s: PopulationState): Promise<void> {
    const now = this.now();
    const dtHours = (now - s.lastTick) / 3600_000;
    if (dtHours <= 0) return;

    const c = this.config.constants;

    // 拉粮食上下文（纯只读，无回调）
    const cropRes = await this.commands.send({
      name: 'economy.GetCropContext',
      from: PopulationModule.NAME,
      payload: { villageId: s.villageId },
    });
    const baseCropPerHour: number = (cropRes.payload as any)?.baseCropPerHour ?? 0;
    const buildingUpkeep: number = (cropRes.payload as any)?.buildingUpkeepPerHour ?? 0;
    const troopUpkeep: number = (cropRes.payload as any)?.troopUpkeepPerHour ?? 0;
    const currentCrop: number = (cropRes.payload as any)?.currentCrop ?? 0;

    // 算 effMult[crop]
    const effMultCrop = this.calcEffMultCrop(s.laborBuildings, s.currentPop);

    // 软上限
    const softLimit = Math.max(0,
      (baseCropPerHour * effMultCrop - buildingUpkeep - troopUpkeep) / c.popPerCapitaCrop,
    );

    const p = s.currentPop;
    const growthPerHour = s.prosperity * c.popGrowthPerProsperity;

    if (p < softLimit) {
      // 增长，不越过软上限
      s.currentPop = Math.min(softLimit, p + growthPerHour * dtHours);
    } else if (p > softLimit && currentCrop <= 0) {
      // 超限 + 粮仓已空 → 减员（越赤字越快）
      // pop_death_rate_factor：净粮赤字(人口超限折算)→减员速率比例
      const deathRate = (p - softLimit) * c.popDeathRateFactor;
      s.currentPop = Math.max(softLimit, p - deathRate * dtHours);
    }
    s.currentPop = Math.max(0, s.currentPop);
    s.lastTick = now;

    // 上报到 economy（民用人口维护 + 劳动力修正器）。这是纯命令(idempotent)，不产生客户端推送。
    await this.reportToEconomy(s, softLimit, effMultCrop);
    // 注意：settle 是"读写前惰性补算"，会被 getSnapshot(读) 触发。
    // 绝不能在此 emit population.Changed —— 否则 客户端 GetPopulation → settle → emit
    // → 网关推 PopulationChanged → 客户端 onPush→refreshAll→再 GetPopulation 形成正反馈死循环，
    // 页面被每秒重渲成百次，用户点击的 DOM 节点被反复销毁重建 → "点了没反应"。
    // 增长是平滑的、客户端本地外插(syncPopDisplay)+5s轮询已足够；离散变更(建造/征兵/解散/伤兵)
    // 各自在其命令处理器里显式 emit。读路径必须对推送零副作用。
  }

  // ── 派生计算（全在模块内部，对外只给快照，铁律#4）──────────────────────

  /** 计算农田加权平均产率修正系数（effMult[crop]）。 */
  private calcEffMultCrop(laborBuildings: LaborBuilding[], currentPop: number): number {
    const c = this.config.constants;
    const cropFields = laborBuildings.filter((b) => b.resource === 'crop');
    if (cropFields.length === 0) return c.popLaborFloor; // 无农田退化到 floor

    let weightedMult = 0;
    let totalWeight = 0;
    for (const b of cropFields) {
      const def = this.config.buildings[b.kind];
      if (!def?.prodBase || !def.prodGrowth) continue;
      const f0 = def.prodBase * Math.pow(def.prodGrowth, b.level - 1); // 裸产量 F0(L)
      const saturation = this.saturationThreshold(def, b.level);
      const r = Math.min(1.0, currentPop / Math.max(1, saturation));
      const mult = c.popLaborFloor + def.laborBonusMax * r;
      weightedMult += f0 * mult;
      totalWeight += f0;
    }
    return totalWeight > 0 ? weightedMult / totalWeight : c.popLaborFloor;
  }

  /**
   * 计算某建筑在某等级的劳动力饱和阈值 S_b(L)。
   * 资源田用指数曲线（与产量曲线同步），其余建筑用线性曲线（S=laborSaturation×L）。
   */
  private saturationThreshold(def: import('../infra/config.js').BuildingDef, level: number): number {
    if (def.resource && def.prodGrowth) {
      // 资源田：S(L) = laborSaturation × prodGrowth^(L-1)
      return def.laborSaturation * Math.pow(def.prodGrowth, level - 1);
    }
    // 其他：S(L) = laborSaturation × L
    return def.laborSaturation * level;
  }

  /**
   * 计算某建筑（按 kind）在当前人口下的速率倍率。
   * 速率类建筑：rate_mult = popLaborFloor + laborBonusMax × min(1, P/S(L))
   * 城镇中心（建造）：time_mult = 1 − laborBonusMax × min(1, P/S(L))
   */
  private calcLaborMult(s: PopulationState, buildingKind: string): number {
    const c = this.config.constants;
    // 找该建筑实例（取最高等级，通常城内同类只一座）
    const inst = s.laborBuildings
      .filter((b) => b.kind === buildingKind)
      .sort((a, b) => b.level - a.level)[0];
    if (!inst) return buildingKind === 'main' ? 1.0 : c.popLaborFloor;

    const def = this.config.buildings[inst.kind];
    if (!def?.laborAmplified) return buildingKind === 'main' ? 1.0 : 1.0;

    const saturation = this.saturationThreshold(def, inst.level);
    const r = Math.min(1.0, s.currentPop / Math.max(1, saturation));

    if (buildingKind === 'main') {
      // 建造时间倍率（越小越快）
      return 1 - def.laborBonusMax * r;
    }
    // 速率类（产出/练兵/锻造/研究）
    return c.popLaborFloor + def.laborBonusMax * r;
  }

  /**
   * 上报到 economy 的两条数据：
   * 1. SetUpkeep(civilian_pop)：当前人口 × popPerCapitaCrop（真实扣粮，决策 C1）
   * 2. SetRateModifier(pop_labor)：各资源田 effMult−1，注入 economy 产率管线
   */
  private async reportToEconomy(s: PopulationState, _softLimit: number, effMultCrop: number): Promise<void> {
    const c = this.config.constants;
    // 民用人口粮食维护
    void this.commands.send({
      name: 'economy.SetUpkeep',
      from: PopulationModule.NAME,
      payload: {
        villageId: s.villageId,
        source: 'civilian_pop',
        cropPerHour: s.currentPop * c.popPerCapitaCrop,
      },
    });

    // 各资源产率的劳动力修正器（effMult - 1，范围约 −0.25..0）
    // 对各资源田分别计算加权倍率
    const mult: Record<string, number> = {};
    for (const res of ['wood', 'clay', 'iron', 'crop']) {
      const fields = s.laborBuildings.filter((b) => b.resource === res);
      if (fields.length === 0) {
        mult[res] = c.popLaborFloor - 1; // 无对应田：用 floor-1
        continue;
      }
      let weightedMult = 0;
      let totalWeight = 0;
      for (const b of fields) {
        const def = this.config.buildings[b.kind];
        if (!def?.prodBase || !def.prodGrowth) continue;
        const f0 = def.prodBase * Math.pow(def.prodGrowth, b.level - 1);
        const saturation = this.saturationThreshold(def, b.level);
        const r = Math.min(1.0, s.currentPop / Math.max(1, saturation));
        const m = c.popLaborFloor + def.laborBonusMax * r;
        weightedMult += f0 * m;
        totalWeight += f0;
      }
      const eff = totalWeight > 0 ? weightedMult / totalWeight : c.popLaborFloor;
      mult[res] = eff - 1; // 修正量（相对 1.0 的增减，约 −0.25..0）
    }
    // 覆盖 crop 修正器用统一算好的 effMult（保持一致）
    mult.crop = effMultCrop - 1;

    void this.commands.send({
      name: 'economy.SetRateModifier',
      from: PopulationModule.NAME,
      payload: {
        villageId: s.villageId,
        source: 'pop_labor',
        mult,
      },
    });
  }

  // ── 订阅处理 ─────────────────────────────────────────────────────────────

  /** 建筑完工/升级后拉 GetLaborContext 更新缓存，然后结算一次 settle。 */
  private async refreshLaborContext(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const res = await this.commands.send({
      name: 'building.GetLaborContext',
      from: PopulationModule.NAME,
      payload: { villageId },
    });
    if (!res.ok) return;
    s.prosperity = (res.payload as any).prosperity ?? s.prosperity;
    s.laborBuildings = (res.payload as any).buildings ?? s.laborBuildings;
    this.store.set(COLLECTION, villageId, s);
    await this.settle(s);
    this.store.set(COLLECTION, villageId, s);
  }

  /** CropDeficit 事件处理：粮仓触底，触发减员结算。 */
  private async onCropDeficit(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    // settle 会检测 currentCrop<=0 并进入减员分支
    await this.settle(s);
    this.store.set(COLLECTION, villageId, s);
    // 如果人口仍超软上限，注册一个粗粒度的后续减员任务（约 5 分钟后再结算）
    // 避免在减员期间人口反复触发重排，以稀疏方式收敛
    if (s.currentPop > 0) {
      this.scheduler.schedule(5 * 60_000, () => void this.onCropDeficit(villageId));
    }
  }

  // ── 伤兵治愈 ─────────────────────────────────────────────────────────────

  /** Scheduler 回调：healAt 到点，将该批次伤兵回补到 currentPop。 */
  private healWounded(villageId: string, healAt: number): void {
    const s = this.load(villageId);
    if (!s) return;
    const idx = s.woundedPool.findIndex((e) => e.healAt === healAt);
    if (idx === -1) return;
    const entry = s.woundedPool[idx];
    s.currentPop += entry.count;
    s.woundedPool.splice(idx, 1);
    this.store.set(COLLECTION, villageId, s);

    // 触发变化事件（不重算 settle，heal 是离散回补）
    const lambda = 0; // 简化：heal 事件只需告知人口变化，不需精确 lambda
    void this.bus.emit({
      name: 'population.Changed',
      source: PopulationModule.NAME,
      ts: this.now(),
      payload: {
        villageId,
        currentPop: Math.floor(s.currentPop),
        woundedTotal: s.woundedPool.reduce((sum, e) => sum + e.count, 0),
        event: 'healed',
        healed: entry.count,
        lambdaRatio: lambda,
      },
    } as DomainEvent);
  }

  /** 计算伤兵治愈时长（依据充裕比 λ）。 */
  private healTimeSec(s: PopulationState, softLimit: number): number {
    const c = this.config.constants;
    const lambda = softLimit > 0 ? Math.min(1, s.currentPop / softLimit) : 0;
    return c.popHealTime / (1 + c.popHealBonus * lambda);
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  /** 获取人口面板快照（派生全给结果，不泄漏公式，铁律#4）。 */
  private async getSnapshot(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    // 先 settle 补算最新状态
    await this.settle(s);
    this.store.set(COLLECTION, villageId, s);

    const c = this.config.constants;
    // 拉粮食上下文计算软上限
    const cropRes = await this.commands.send({
      name: 'economy.GetCropContext',
      from: PopulationModule.NAME,
      payload: { villageId },
    });
    const baseCropPerHour: number = (cropRes.payload as any)?.baseCropPerHour ?? 0;
    const buildingUpkeep: number = (cropRes.payload as any)?.buildingUpkeepPerHour ?? 0;
    const troopUpkeep: number = (cropRes.payload as any)?.troopUpkeepPerHour ?? 0;

    const effMultCrop = this.calcEffMultCrop(s.laborBuildings, s.currentPop);
    const softLimit = Math.max(0,
      (baseCropPerHour * effMultCrop - buildingUpkeep - troopUpkeep) / c.popPerCapitaCrop,
    );
    const growthPerHour = s.prosperity * c.popGrowthPerProsperity;
    const lambda = softLimit > 0 ? Math.min(1, s.currentPop / softLimit) : 0;

    // 各轴劳动倍率快照（对外只给结果）
    const trainMults: Record<string, number> = {};
    for (const bk of ['barracks', 'stable', 'workshop']) {
      trainMults[bk] = this.calcLaborMult(s, bk);
    }
    const prodMults: Record<string, number> = {};
    for (const res of ['wood', 'clay', 'iron', 'crop']) {
      const fields = s.laborBuildings.filter((b) => b.resource === res);
      if (fields.length === 0) { prodMults[res] = c.popLaborFloor; continue; }
      let wMult = 0, wTotal = 0;
      for (const b of fields) {
        const def = this.config.buildings[b.kind];
        if (!def?.prodBase || !def.prodGrowth) continue;
        const f0 = def.prodBase * Math.pow(def.prodGrowth, b.level - 1);
        const sat = this.saturationThreshold(def, b.level);
        const r = Math.min(1.0, s.currentPop / Math.max(1, sat));
        wMult += f0 * (c.popLaborFloor + def.laborBonusMax * r);
        wTotal += f0;
      }
      prodMults[res] = wTotal > 0 ? wMult / wTotal : c.popLaborFloor;
    }

    return {
      ok: true,
      payload: {
        currentPop: Math.floor(s.currentPop),
        softLimit: Math.floor(softLimit),
        growthPerHour: Math.round(growthPerHour),
        lambdaRatio: Math.round(lambda * 100) / 100,
        wounded: {
          total: s.woundedPool.reduce((sum, e) => sum + e.count, 0),
          entries: s.woundedPool.map((e) => ({ count: e.count, healAt: e.healAt })),
        },
        laborMults: {
          production: prodMults,
          build: this.calcLaborMult(s, 'main'),
          train: trainMults,
          smithy: this.calcLaborMult(s, 'smithy'),
          // academy: 预留，暂无模块
        },
        lastTick: s.lastTick,
      },
    };
  }

  /**
   * 读取某建筑种类对应的劳动倍率。
   * building/military 调用，读当前快照（settle 只在写前调用，此处纯读）。
   */
  private getLaborMult(cmd: Command): CommandResult {
    const { villageId, buildingKind } = cmd.payload as { villageId: string; buildingKind: string };
    const s = this.load(villageId);
    if (!s) {
      // population 未就绪时回退默认值（1.0=无加速，铁律#4 兜底）
      const def = this.config.buildings[buildingKind];
      const fallback = buildingKind === 'main' ? 1.0 : (def?.laborAmplified ? this.config.constants.popLaborFloor : 1.0);
      return { ok: true, payload: { mult: fallback } };
    }
    return { ok: true, payload: { mult: this.calcLaborMult(s, buildingKind) } };
  }

  /**
   * 训练时扣除人口（ConsumePop）。
   * 拓荒者 popPermanent=true 时正常扣除，只是后续解散/死亡不返还。
   * 若人口不足返回 insufficient_population。
   */
  private async consumePop(cmd: Command): Promise<CommandResult> {
    const { villageId, unit, count } = cmd.payload as { villageId: string; unit: string; count: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    const def = this.config.units[unit];
    if (!def) return { ok: false, payload: {}, reason: `unknown_unit:${unit}` };

    // 先 settle（保证 currentPop 是最新值）
    await this.settle(s);

    const totalCost = def.popCost * count;
    if (s.currentPop < totalCost) {
      this.store.set(COLLECTION, villageId, s);
      return { ok: false, payload: {}, reason: 'insufficient_population' };
    }

    s.currentPop -= totalCost;
    this.store.set(COLLECTION, villageId, s);

    // 发出变化事件
    void this.bus.emit({
      name: 'population.Changed',
      source: PopulationModule.NAME,
      ts: this.now(),
      payload: {
        villageId,
        currentPop: Math.floor(s.currentPop),
        woundedTotal: s.woundedPool.reduce((sum, e) => sum + e.count, 0),
        event: 'consumed',
        consumed: totalCost,
      },
    } as DomainEvent);

    return { ok: true, payload: { ok: true, consumed: totalCost } };
  }

  /**
   * 返还人口（ReturnPop）：解散/训练回滚时调用。
   * 跳过 popPermanent=true 的单位（拓荒者永久消耗不返还）。
   */
  private returnPop(cmd: Command): CommandResult {
    const { villageId, units } = cmd.payload as { villageId: string; units: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    let returned = 0;
    for (const [unit, cnt] of Object.entries(units)) {
      if (cnt <= 0) continue;
      const def = this.config.units[unit];
      if (!def || def.popPermanent) continue; // 跳过永久消耗单位
      returned += def.popCost * cnt;
    }
    s.currentPop += returned;
    this.store.set(COLLECTION, villageId, s);

    if (returned > 0) {
      void this.bus.emit({
        name: 'population.Changed',
        source: PopulationModule.NAME,
        ts: this.now(),
        payload: {
          villageId,
          currentPop: Math.floor(s.currentPop),
          woundedTotal: s.woundedPool.reduce((sum, e) => sum + e.count, 0),
          event: 'returned',
          returned,
        },
      } as DomainEvent);
    }

    return { ok: true, payload: { ok: true, returned } };
  }

  /**
   * 登记伤兵（AddWounded）：战斗结束后 combat 传来各兵种原始损失。
   * population 用 config 算伤兵数（popCost × recovery_ratio），跳过 popPermanent 单位。
   * 伤兵不计入 currentPop，也不占软上限；治愈走 Scheduler。
   */
  private async addWounded(cmd: Command): Promise<CommandResult> {
    const { villageId, losses } = cmd.payload as { villageId: string; losses: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    const c = this.config.constants;

    // 先 settle 获取当前软上限（用于计算治愈时长）
    await this.settle(s);

    // 重新计算软上限（settle 已更新 lastTick）
    const cropRes = await this.commands.send({
      name: 'economy.GetCropContext',
      from: PopulationModule.NAME,
      payload: { villageId },
    });
    const baseCropPerHour: number = (cropRes.payload as any)?.baseCropPerHour ?? 0;
    const buildingUpkeep: number = (cropRes.payload as any)?.buildingUpkeepPerHour ?? 0;
    const troopUpkeep: number = (cropRes.payload as any)?.troopUpkeepPerHour ?? 0;
    const effMultCrop = this.calcEffMultCrop(s.laborBuildings, s.currentPop);
    const softLimit = Math.max(0,
      (baseCropPerHour * effMultCrop - buildingUpkeep - troopUpkeep) / c.popPerCapitaCrop,
    );

    let totalWounded = 0;
    let permanentDead = 0;

    for (const [unit, lostCount] of Object.entries(losses)) {
      if (lostCount <= 0) continue;
      const def = this.config.units[unit];
      if (!def) continue;
      if (def.popPermanent) {
        // 拓荒者：永久消耗，不生成伤兵（训练时已永久扣除）
        permanentDead += def.popCost * lostCount;
        continue;
      }
      // 普通兵：部分转为伤兵（popCost × recovery_ratio）
      const wounded = Math.floor(lostCount * def.popCost * c.popDeathRecoveryRatio);
      const dead = lostCount * def.popCost - wounded;
      permanentDead += dead;
      if (wounded <= 0) continue;

      totalWounded += wounded;
      const healSec = this.healTimeSec(s, softLimit);
      const healAt = this.now() + healSec * 1000;
      const taskId = this.scheduler.schedule(healSec * 1000, () => this.healWounded(villageId, healAt));
      s.woundedPool.push({ count: wounded, healAt, taskId });
    }

    this.store.set(COLLECTION, villageId, s);

    if (totalWounded > 0 || permanentDead > 0) {
      void this.bus.emit({
        name: 'population.Changed',
        source: PopulationModule.NAME,
        ts: this.now(),
        payload: {
          villageId,
          currentPop: Math.floor(s.currentPop),
          woundedTotal: s.woundedPool.reduce((sum, e) => sum + e.count, 0),
          event: 'wounded',
          wounded: totalWounded,
          permanentDead,
        },
      } as DomainEvent);
    }

    return { ok: true, payload: { ok: true, wounded: totalWounded, permanentDead } };
  }
}

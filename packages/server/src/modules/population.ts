import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Population（人口）v2
 * 对应设计文档 13_人口系统设计.md / 14_人口系统架构规划.md
 *
 * v2 核心机制：
 *  A. 三池口粮：
 *     - 民用：currentPop × popPerCapitaCrop /hr
 *     - 士兵：(garrisonPopCost + enRoutePopCost) × popPerCapitaCrop × popSoldierCropRatio /hr
 *     - 伤兵：totalWounded × popPerCapitaCrop × popWoundedCropRatio /hr
 *  B. 全城共享劳动力 ω：D=Σ saturationThreshold；ω=min(1,P/D)；所有速率轴共用
 *  C. 阶段递减增长：scale=(ref/(ref+L))^exp，L=softLimit
 *  D. 新村固定点：createVillage 迭代至 P≈L（≥0.99）
 *  E. 饥荒状态机：减员=gap×(1-exp(-k·dt))；仅超限且粮仓见底时续排
 *  F. PopulationChanged 统一公共字段 + 事件专属字段
 *  G. 每次离散写后 await reportToEconomy
 */

interface WoundEntry {
  id: string;
  count: number;
  healAt: number;
  taskId: string;
}

interface LaborBuilding {
  kind: string;
  level: number;
  resource?: string;
}

/** 从 economy 读回的作物上下文 + 本模块推算的派生值。 */
interface PopulationContext {
  omega: number;
  effMultCrop: number;
  rawSoftLimit: number;        // 未 clamp，可为负（军费超产出时）
  baseCropPerHour: number;
  nonCivilianUpkeep: number;
  currentCrop?: number;
}

interface PopulationState {
  villageId: string;
  currentPop: number;
  woundedPool: WoundEntry[];
  lastTick: number;
  prosperity: number;
  laborBuildings: LaborBuilding[];
  garrisonPopCost: number;
  enRoutePopCost: number;
  deficitTaskId?: string;
  /** 当前是否处于饥荒状态（v2 状态机标志）。旧存档默认 false?*/
  inFamine: boolean;
}

const COLLECTION = 'population';

export class PopulationModule {
  static readonly NAME = 'population';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'population',
    publicActions: {
      GetPopulation: { command: 'population.GetSnapshot', ownVillage: true, needAuth: true, schema: {} },
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
    this.commands.register('population.GetSnapshot', (c) => this.getSnapshot(c));
    this.commands.register('population.GetLaborMult', (c) => this.getLaborMult(c));
    this.commands.register('population.ConsumePop', (c) => this.consumePop(c));
    this.commands.register('population.ReturnPop', (c) => this.returnPop(c));
    this.commands.register('population.AddWounded', (c) => this.addWounded(c));
    this.commands.register('population.SetGarrisonPop', (c) => this.setGarrisonPop(c));
    this.commands.register('population.SetEnRoutePop', (c) => this.setEnRoutePop(c));

    this.bus.on('building.Built', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.refreshLaborContext(villageId);
    });
    this.bus.on('building.Upgraded', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.refreshLaborContext(villageId);
    });

    this.bus.on('economy.CropDeficit', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.onCropDeficit(villageId);
    });
  }

  resume(): void {
    for (const s of this.store.all<PopulationState>(COLLECTION)) {
      // 旧存档兼?      if (s.garrisonPopCost === undefined) s.garrisonPopCost = 0;
      if (s.enRoutePopCost === undefined) s.enRoutePopCost = 0;
      if (s.inFamine === undefined) s.inFamine = false;

      // 若重启前处于饥荒但任务丢失，重新调度
      if (s.inFamine && !s.deficitTaskId) {
        const c = this.config.constants;
        s.deficitTaskId = this.scheduler.schedule(
          c.popFamineTickSec * 1000,
          () => this.runFamineTick(s.villageId),
          `population:deficit:${s.villageId}`,
          `village:${s.villageId}`,
        );
      }

      // 重新登记伤兵 heal 任务
      for (const entry of s.woundedPool ?? []) {
        if (!entry.id) {
          entry.id = `w-${s.villageId}-${entry.healAt}-${Math.random().toString(36).slice(2, 8)}`;
        }
        const delay = Math.max(0, entry.healAt - this.now());
        entry.taskId = this.scheduler.schedule(
          delay,
          () => this.healWounded(s.villageId, entry.id),
          `population:heal:${s.villageId}`,
          `village:${s.villageId}`,
        );
      }
      this.store.set(COLLECTION, s.villageId, s);
    }
  }

  /**
   * 新村创建?0 次迭代固定点，确?currentPop/softLimit ?0.99?   * 依赖 economy/building/military 已初始化完毕?   */
  async createVillage(villageId: string): Promise<void> {
    const laborRes = await this.commands.send({
      name: 'building.GetLaborContext',
      from: PopulationModule.NAME,
      payload: { villageId },
    });
    const prosperity: number = (laborRes.payload as any)?.prosperity ?? 0;
    const laborBuildings: LaborBuilding[] = (laborRes.payload as any)?.buildings ?? [];

    const cropRes = await this.commands.send({
      name: 'economy.GetCropContext',
      from: PopulationModule.NAME,
      payload: { villageId },
    });
    const baseCropPerHour: number = (cropRes.payload as any)?.baseCropPerHour ?? 0;
    const nonCivilianUpkeep: number = (cropRes.payload as any)?.nonCivilianUpkeep ?? 0;
    const c = this.config.constants;

    // 迭代固定点：P_{n+1} = max(0, rawSoftLimit(ω(P_n)))
    let P = 0;
    for (let iter = 0; iter < 15; iter++) {
      const omega = this.calcLaborOmega(laborBuildings, P);
      const effMult = this.calcEffMultForResource(laborBuildings, omega, 'crop');
      const rawL = (baseCropPerHour * effMult - nonCivilianUpkeep) / c.popPerCapitaCrop;
      const L = Math.max(0, rawL);
      if (Math.abs(L - P) < 0.5) { P = L; break; }
      P = L;
    }
    const initPop = Math.max(0, P);

    const s: PopulationState = {
      villageId,
      currentPop: initPop,
      woundedPool: [],
      lastTick: this.now(),
      prosperity,
      laborBuildings,
      garrisonPopCost: 0,
      enRoutePopCost: 0,
      inFamine: false,
    };
    this.store.set(COLLECTION, villageId, s);

    // ?economy 上报初始三池口粮 + 劳动力修?    await this.reportToEconomy(s);
  }

  private load(villageId: string): PopulationState | undefined {
    return this.store.get<PopulationState>(COLLECTION, villageId);
  }

  // ── 派生计算（全城共?ω，铁?4）────────────────────────────────────────

  /**
   * 全城共享劳动力利用率：D = Σ saturationThreshold 对所?laborAmplified 建筑?   * ω = min(1, P/D)。所有倍率统一用此 ω?   */
  private calcLaborOmega(laborBuildings: LaborBuilding[], currentPop: number): number {
    let D = 0;
    for (const b of laborBuildings) {
      const def = this.config.buildings[b.kind];
      if (!def?.laborAmplified) continue;
      D += this.saturationThreshold(def, b.level);
    }
    if (D <= 0) return 1.0; // no labor buildings, omega=1
    return Math.min(1.0, currentPop / D);
  }

  /** 资源产田的效率倍率：effMult = popLaborFloor + laborBonusMax_weighted × ω */
  private calcEffMultForResource(laborBuildings: LaborBuilding[], omega: number, resource: string): number {
    const c = this.config.constants;
    const fields = laborBuildings.filter((b) => b.resource === resource);
    if (fields.length === 0) return c.popLaborFloor;

    let weightedBonus = 0;
    let totalWeight = 0;
    for (const b of fields) {
      const def = this.config.buildings[b.kind];
      if (!def?.prodBase || !def.prodGrowth) continue;
      const f0 = def.prodBase * Math.pow(def.prodGrowth, b.level - 1);
      weightedBonus += f0 * (def.laborBonusMax ?? 0);
      totalWeight += f0;
    }
    const avgBonusMax = totalWeight > 0 ? weightedBonus / totalWeight : 0;
    return c.popLaborFloor + avgBonusMax * omega;
  }

  /**
   * 训练/建?铁匠建筑的劳动力倍率（统一?ω）：
   * - main（主城堡，缩减建造时间）: mult = 1 - laborBonusMax × ω
   * - 其他（barracks/stable/workshop/smithy? mult = popLaborFloor + laborBonusMax × ω
   */
  private calcBuildingLaborMult(laborBuildings: LaborBuilding[], omega: number, buildingKind: string): number {
    const c = this.config.constants;
    const inst = laborBuildings
      .filter((b) => b.kind === buildingKind)
      .sort((a, b) => b.level - a.level)[0];
    if (!inst) return buildingKind === 'main' ? 1.0 : c.popLaborFloor;
    const def = this.config.buildings[inst.kind];
    if (!def?.laborAmplified) return buildingKind === 'main' ? 1.0 : 1.0;
    if (buildingKind === 'main') {
      return 1 - (def.laborBonusMax ?? 0) * omega;
    }
    return c.popLaborFloor + (def.laborBonusMax ?? 0) * omega;
  }

  private saturationThreshold(def: import('../infra/config.js').BuildingDef, level: number): number {
    if (def.resource && def.prodGrowth) {
      return def.laborSaturation * Math.pow(def.prodGrowth, level - 1);
    }
    return def.laborSaturation * level;
  }

  /** 阶段递减增长 scale = (ref/(ref+L))^exp（L=softLimit，settle ?snapshot 同一 helper）?*/
  private calcGrowthScale(softLimit: number): number {
    const c = this.config.constants;
    const ref = c.popGrowthScaleRef;
    return Math.pow(ref / (ref + softLimit), c.popGrowthScaleExp);
  }

  /**
   * 构建事件公共 payload（所?population.Changed 事件必须包含的字段）?   * 加上事件专属字段后一?emit?   */
  private buildPublicPayload(
    s: PopulationState,
    ctx: PopulationContext,
  ): Record<string, unknown> {
    const c = this.config.constants;
    const softLimit = Math.max(0, ctx.rawSoftLimit);
    const woundedTotal = s.woundedPool.reduce((sum, e) => sum + e.count, 0);
    const lambdaRatio = softLimit > 0 ? Math.min(1, s.currentPop / softLimit) : 0;
    const scale = this.calcGrowthScale(softLimit);
    const growthPerHour = s.prosperity * c.popGrowthPerProsperity * scale;
    const cropDeficitRate = Math.max(0, (s.currentPop - ctx.rawSoftLimit) * c.popPerCapitaCrop);
    return {
      villageId: s.villageId,
      currentPop: Math.floor(s.currentPop),
      woundedTotal,
      totalPop: Math.floor(s.currentPop) + woundedTotal,
      garrisonPop: s.garrisonPopCost,
      softLimit: Math.floor(softLimit),
      growthPerHour: Math.round(growthPerHour),
      lambdaRatio: Math.round(lambdaRatio * 100) / 100,
      cropDeficitRate: Math.round(cropDeficitRate * 10) / 10,
      inFamine: s.inFamine,
      laborRatio: Math.round(ctx.omega * 100) / 100,
    };
  }

  // ── Economy 同步（设?F/G）──────────────────────────────────────────────

  /**
   * ?economy 同步三池口粮 + 劳动力修正器，并返回当前作物上下文?   * 所有离散写路径（consume/return/heal/wound/garrison/enRoute）在 emit 前必?await 此函数?   *
   * 三池口粮口径（已修正）：
   *   civilian_pop  = currentPop × c（c = popPerCapitaCrop?   *   soldier_pool  = (garrisonPopCost + enRoutePopCost) × c × popSoldierCropRatio
   *   wounded_pool  = totalWounded × c × popWoundedCropRatio
   * ratio=1.0 表示与平民相同基础口粮（已在公式中乘入 c）?   */
  private async reportToEconomy(s: PopulationState): Promise<PopulationContext> {
    const c = this.config.constants;
    const omega = this.calcLaborOmega(s.laborBuildings, s.currentPop);
    const effMultCrop = this.calcEffMultForResource(s.laborBuildings, omega, 'crop');
    const totalWounded = s.woundedPool.reduce((sum, e) => sum + e.count, 0);

    await this.commands.send({
      name: 'economy.SetUpkeep', from: PopulationModule.NAME,
      payload: { villageId: s.villageId, source: 'civilian_pop', cropPerHour: s.currentPop * c.popPerCapitaCrop },
    });
    await this.commands.send({
      name: 'economy.SetUpkeep', from: PopulationModule.NAME,
      payload: {
        villageId: s.villageId, source: 'soldier_pool',
        cropPerHour: (s.garrisonPopCost + s.enRoutePopCost) * c.popPerCapitaCrop * c.popSoldierCropRatio,
      },
    });
    await this.commands.send({
      name: 'economy.SetUpkeep', from: PopulationModule.NAME,
      payload: {
        villageId: s.villageId, source: 'wounded_pool',
        cropPerHour: totalWounded * c.popPerCapitaCrop * c.popWoundedCropRatio,
      },
    });

    // 劳动力修正器：所有资源类型统一?ω
    const mult: Record<string, number> = {};
    for (const res of ['wood', 'clay', 'iron', 'crop']) {
      mult[res] = this.calcEffMultForResource(s.laborBuildings, omega, res) - 1;
    }
    await this.commands.send({
      name: 'economy.SetRateModifier', from: PopulationModule.NAME,
      payload: { villageId: s.villageId, source: 'pop_labor', mult },
    });

    // await economy to get accurate nonCivilianUpkeep
    const cropRes = await this.commands.send({
      name: 'economy.GetCropContext', from: PopulationModule.NAME,
      payload: { villageId: s.villageId },
    });
    const baseCropPerHour: number = (cropRes.payload as any)?.baseCropPerHour ?? 0;
    const nonCivilianUpkeep: number = (cropRes.payload as any)?.nonCivilianUpkeep ?? 0;
    const currentCrop: number = (cropRes.payload as any)?.currentCrop ?? 0;
    const rawSoftLimit = (baseCropPerHour * effMultCrop - nonCivilianUpkeep) / c.popPerCapitaCrop;

    return { omega, effMultCrop, rawSoftLimit, baseCropPerHour, nonCivilianUpkeep, currentCrop };
  }

  // ── 惰性结算（只处理增长，settle 永不 emit）──────────────────────────────

  /**
   * 惰性结算：?Δt 补算人口增长（P < softLimit 时）?   * 不调 reportToEconomy：由调用方负责在写入??await reportToEconomy?   * settle 永不 emit（铁律：减员只在 Scheduler famine tick emit）?   */
  private async settle(s: PopulationState): Promise<PopulationContext> {
    const now = this.now();
    const dtHours = (now - s.lastTick) / 3600_000;
    s.lastTick = now;

    // ?economy 用于增长计算
    const cropRes = await this.commands.send({
      name: 'economy.GetCropContext', from: PopulationModule.NAME,
      payload: { villageId: s.villageId },
    });
    const baseCropPerHour: number = (cropRes.payload as any)?.baseCropPerHour ?? 0;
    const nonCivilianUpkeep: number = (cropRes.payload as any)?.nonCivilianUpkeep ?? 0;
    const currentCrop: number = (cropRes.payload as any)?.currentCrop ?? 0;

    const cc = this.config.constants;
    const omega = this.calcLaborOmega(s.laborBuildings, s.currentPop);
    const effMultCrop = this.calcEffMultForResource(s.laborBuildings, omega, 'crop');
    const rawSoftLimit = (baseCropPerHour * effMultCrop - nonCivilianUpkeep) / cc.popPerCapitaCrop;
    const softLimit = Math.max(0, rawSoftLimit);

    if (dtHours > 0 && s.currentPop < softLimit) {
      const scale = this.calcGrowthScale(softLimit);
      const growthPerHour = s.prosperity * cc.popGrowthPerProsperity * scale;
      s.currentPop = Math.min(softLimit, s.currentPop + growthPerHour * dtHours);
    }
    s.currentPop = Math.max(0, s.currentPop);

    return { omega, effMultCrop, rawSoftLimit, baseCropPerHour, nonCivilianUpkeep, currentCrop };
  }

  // ── 饥荒状态机（设?E）──────────────────────────────────────────────────

  /** CropDeficit 边沿触发：注册第一?famine tick（每村只允许一个活跃任务）?*/
  private async onCropDeficit(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s || s.deficitTaskId) return;

    const c = this.config.constants;
    s.deficitTaskId = this.scheduler.schedule(
      c.popFamineTickSec * 1000,
      () => this.runFamineTick(villageId),   // 返回 Promise，由 Scheduler 正确 await
      `population:deficit:${villageId}`,
      `village:${villageId}`,
    );
    this.store.set(COLLECTION, villageId, s);
  }

  /**
   * 饥荒减员 tick。唯一可执行减员并 emit 的路径（铁律：settle 永不 emit）?   *
   * 减员公式（指数解析）：reduced = gap × (1 - exp(-k × dtHours))
   *   gap = currentPop - rawSoftLimit（rawSoftLimit 可为负；极端赤字?gap > currentPop?   *   k = popDeathRateFactor
   * P ?0 时取消所?heal task，清空伤兵队列?   * 事件：首次进入发 'famine'，后?tick ?'death'，退出发 'recovery'?   */
  private async runFamineTick(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    s.deficitTaskId = undefined;

    const c = this.config.constants;
    const ctx = await this.reportToEconomy(s);

    const inDeficit = (ctx.currentCrop ?? 0) <= 0 && s.currentPop > ctx.rawSoftLimit;

    if (!inDeficit) {
      // 不再赤字：发 recovery（若曾在 famine）并停止
      const wasInFamine = s.inFamine;
      s.inFamine = false;
      this.store.set(COLLECTION, villageId, s);
      if (wasInFamine) {
        await this.bus.emit({
          name: 'population.Changed',
          source: PopulationModule.NAME,
          ts: this.now(),
          payload: { ...this.buildPublicPayload(s, ctx), event: 'recovery' },
        } as DomainEvent);
      }
      return;
    }

    // 指数解析减员
    const tickHours = c.popFamineTickSec / 3600;
    const gap = s.currentPop - ctx.rawSoftLimit;  // rawSoftLimit can be negative; gap can exceed currentPop
    const reduced = Math.min(s.currentPop, Math.max(0, gap * (1 - Math.exp(-c.popDeathRateFactor * tickHours))));
    s.currentPop = Math.max(0, s.currentPop - reduced);

    // P <= 0: cancel heal tasks, clear wounded pool
    if (s.currentPop <= 0 && s.woundedPool.length > 0) {
      for (const entry of s.woundedPool) {
        this.scheduler.cancel(entry.taskId);
      }
      s.woundedPool = [];
      s.currentPop = 0;
    }

    const wasInFamine = s.inFamine;
    s.inFamine = true;
    // reportToEconomy with updated pop
    const ctxAfter = await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    const eventKind = wasInFamine ? 'death' : 'famine';
    await this.bus.emit({
      name: 'population.Changed',
      source: PopulationModule.NAME,
      ts: this.now(),
      payload: {
        ...this.buildPublicPayload(s, ctxAfter),
        event: eventKind,
        reduced: Math.round(reduced),
        rawSoftLimit: Math.round(ctx.rawSoftLimit * 10) / 10,
      },
    } as DomainEvent);

    // 若仍超软上限且粮仓见底，续排下一 tick；已回落到 L 以下则停（避免永久空转）
    const continueNeeded =
      s.currentPop > 0 &&
      (ctxAfter.currentCrop ?? 0) <= 0 &&
      s.currentPop > ctxAfter.rawSoftLimit;
    if (continueNeeded) {
      s.deficitTaskId = this.scheduler.schedule(
        c.popFamineTickSec * 1000,
        () => this.runFamineTick(villageId),  // 返回 Promise，由 Scheduler 正确 await
        `population:deficit:${villageId}`,
        `village:${villageId}`,
      );
      this.store.set(COLLECTION, villageId, s);
    }
  }

  // ── 订阅处理 ─────────────────────────────────────────────────────────────

  private async refreshLaborContext(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const res = await this.commands.send({
      name: 'building.GetLaborContext', from: PopulationModule.NAME,
      payload: { villageId },
    });
    if (!res.ok) return;
    s.prosperity = (res.payload as any).prosperity ?? s.prosperity;
    s.laborBuildings = (res.payload as any).buildings ?? s.laborBuildings;
    await this.settle(s);
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);
  }

  // ── 伤兵治愈 ─────────────────────────────────────────────────────────────

  private async healWounded(villageId: string, entryId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const idx = s.woundedPool.findIndex((e) => e.id === entryId);
    if (idx === -1) return;
    const entry = s.woundedPool[idx];

    // settle 补算增长
    await this.settle(s);

    s.currentPop += entry.count;
    s.woundedPool.splice(idx, 1);

    // await economy to sync upkeep, get accurate context
    const ctx = await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    await this.bus.emit({
      name: 'population.Changed',
      source: PopulationModule.NAME,
      ts: this.now(),
      payload: {
        ...this.buildPublicPayload(s, ctx),
        event: 'healed',
        healed: entry.count,
      },
    } as DomainEvent);
  }

  private healTimeSec(s: PopulationState, softLimit: number): number {
    const c = this.config.constants;
    const lambda = softLimit > 0 ? Math.min(1, s.currentPop / softLimit) : 0;
    return c.popHealTime / (1 + c.popHealBonus * lambda);
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  /** 获取人口面板快照（直接包含所有公共字段，客户端不需猜测 laborRatio/inFamine）?*/
  private async getSnapshot(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    await this.settle(s);
    const ctx = await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    const cc = this.config.constants;
    const omega = ctx.omega;
    const softLimit = Math.max(0, ctx.rawSoftLimit);
    const woundedTotal = s.woundedPool.reduce((sum, e) => sum + e.count, 0);
    const lambdaRatio = softLimit > 0 ? Math.min(1, s.currentPop / softLimit) : 0;
    const scale = this.calcGrowthScale(softLimit);
    const growthPerHour = s.prosperity * cc.popGrowthPerProsperity * scale;
    const cropDeficitRate = Math.max(0, (s.currentPop - ctx.rawSoftLimit) * cc.popPerCapitaCrop);

    // training/building labor mults
    const trainMults: Record<string, number> = {};
    for (const bk of ['barracks', 'stable', 'workshop', 'smithy']) {
      trainMults[bk] = this.calcBuildingLaborMult(s.laborBuildings, omega, bk);
    }
    const prodMults: Record<string, number> = {};
    for (const res of ['wood', 'clay', 'iron', 'crop']) {
      prodMults[res] = this.calcEffMultForResource(s.laborBuildings, omega, res);
    }

    return {
      ok: true,
      payload: {
        // 公共字段（事件同款）
        currentPop: Math.floor(s.currentPop),
        woundedTotal,
        totalPop: Math.floor(s.currentPop) + woundedTotal,
        garrisonPop: s.garrisonPopCost,
        softLimit: Math.floor(softLimit),
        growthPerHour: Math.round(growthPerHour),
        lambdaRatio: Math.round(lambdaRatio * 100) / 100,
        cropDeficitRate: Math.round(cropDeficitRate * 10) / 10,
        inFamine: s.inFamine,
        laborRatio: Math.round(omega * 100) / 100,
        laborDemand: this.calcLaborDemandTotal(s.laborBuildings),
        // 扩展字段
        wounded: {
          total: woundedTotal,
          entries: s.woundedPool.map((e) => ({ count: e.count, healAt: e.healAt })),
        },
        pools: {
          garrisonPopCost: s.garrisonPopCost,
          enRoutePopCost: s.enRoutePopCost,
          woundedTotal,
        },
        laborMults: {
          production: prodMults,
          build: this.calcBuildingLaborMult(s.laborBuildings, omega, 'main'),
          train: trainMults,
          smithy: this.calcBuildingLaborMult(s.laborBuildings, omega, 'smithy'),
        },
        lastTick: s.lastTick,
      },
    };
  }

  private calcLaborDemandTotal(laborBuildings: LaborBuilding[]): number {
    let D = 0;
    for (const b of laborBuildings) {
      const def = this.config.buildings[b.kind];
      if (!def?.laborAmplified) continue;
      D += this.saturationThreshold(def, b.level);
    }
    return Math.round(D);
  }

  private getLaborMult(cmd: Command): CommandResult {
    const { villageId, buildingKind } = cmd.payload as { villageId: string; buildingKind: string };
    const s = this.load(villageId);
    if (!s) {
      const fallback = buildingKind === 'main' ? 1.0 : this.config.constants.popLaborFloor;
      return { ok: true, payload: { mult: fallback } };
    }
    const omega = this.calcLaborOmega(s.laborBuildings, s.currentPop);
    return { ok: true, payload: { mult: this.calcBuildingLaborMult(s.laborBuildings, omega, buildingKind) } };
  }

  private async consumePop(cmd: Command): Promise<CommandResult> {
    const { villageId, unit, count } = cmd.payload as { villageId: string; unit: string; count: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    const def = this.config.units[unit];
    if (!def) return { ok: false, payload: {}, reason: `unknown_unit:${unit}` };

    await this.settle(s);

    const totalCost = def.popCost * count;
    if (s.currentPop < totalCost) {
      this.store.set(COLLECTION, villageId, s);
      return { ok: false, payload: {}, reason: 'insufficient_population' };
    }

    s.currentPop -= totalCost;

    const ctx = await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    await this.bus.emit({
      name: 'population.Changed',
      source: PopulationModule.NAME,
      ts: this.now(),
      payload: {
        ...this.buildPublicPayload(s, ctx),
        event: 'consumed',
        consumed: totalCost,
      },
    } as DomainEvent);

    return { ok: true, payload: { ok: true, consumed: totalCost } };
  }

  private async returnPop(cmd: Command): Promise<CommandResult> {
    const { villageId, units } = cmd.payload as { villageId: string; units: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    // settle 补算增长（returnPop 也需补算，避免与 consumePop 错位?    await this.settle(s);

    let returned = 0;
    for (const [unit, cnt] of Object.entries(units)) {
      if (cnt <= 0) continue;
      const udef = this.config.units[unit];
      if (!udef || udef.popPermanent) continue;
      returned += udef.popCost * cnt;
    }
    s.currentPop += returned;

    const ctx = await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    if (returned > 0) {
      await this.bus.emit({
        name: 'population.Changed',
        source: PopulationModule.NAME,
        ts: this.now(),
        payload: {
          ...this.buildPublicPayload(s, ctx),
          event: 'returned',
          returned,
        },
      } as DomainEvent);
    }

    return { ok: true, payload: { ok: true, returned } };
  }

  private async addWounded(cmd: Command): Promise<CommandResult> {
    const { villageId, losses } = cmd.payload as { villageId: string; losses: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    const cc = this.config.constants;

    await this.settle(s);

    // get economy context for soft limit calculation
    const cropCtx = await this.commands.send({
      name: 'economy.GetCropContext', from: PopulationModule.NAME,
      payload: { villageId },
    });
    const base: number = (cropCtx.payload as any)?.baseCropPerHour ?? 0;
    const nonCiv: number = (cropCtx.payload as any)?.nonCivilianUpkeep ?? 0;
    const omega = this.calcLaborOmega(s.laborBuildings, s.currentPop);
    const effMult = this.calcEffMultForResource(s.laborBuildings, omega, 'crop');
    const softLimit = Math.max(0, (base * effMult - nonCiv) / cc.popPerCapitaCrop);

    let totalWounded = 0;
    let permanentDead = 0;

    for (const [unit, lostCount] of Object.entries(losses)) {
      if (lostCount <= 0) continue;
      const udef = this.config.units[unit];
      if (!udef) continue;
      if (udef.popPermanent) {
        permanentDead += udef.popCost * lostCount;
        continue;
      }
      const wounded = Math.floor(lostCount * udef.popCost * cc.popDeathRecoveryRatio);
      const dead = lostCount * udef.popCost - wounded;
      permanentDead += dead;
      if (wounded <= 0) continue;

      totalWounded += wounded;
      const healSec = this.healTimeSec(s, softLimit);
      const healAt = this.now() + healSec * 1000;
      const entryId = `w-${villageId}-${healAt}-${s.woundedPool.length}-${Math.random().toString(36).slice(2, 6)}`;
      const taskId = this.scheduler.schedule(
        healSec * 1000,
        () => this.healWounded(villageId, entryId),
        `population:heal:${villageId}`,
        `village:${villageId}`,
      );
      s.woundedPool.push({ id: entryId, count: wounded, healAt, taskId });
    }

    const ctx = await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    if (totalWounded > 0 || permanentDead > 0) {
      await this.bus.emit({
        name: 'population.Changed',
        source: PopulationModule.NAME,
        ts: this.now(),
        payload: {
          ...this.buildPublicPayload(s, ctx),
          event: 'wounded',
          wounded: totalWounded,
          permanentDead,
        },
      } as DomainEvent);
    }

    return { ok: true, payload: { ok: true, wounded: totalWounded, permanentDead } };
  }

  private async setGarrisonPop(cmd: Command): Promise<CommandResult> {
    const { villageId, popCostSum } = cmd.payload as { villageId: string; popCostSum: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    s.garrisonPopCost = Math.max(0, popCostSum);

    // await 同步到 economy
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    return { ok: true, payload: {} };
  }

  private async setEnRoutePop(cmd: Command): Promise<CommandResult> {
    const { villageId, popCostSum } = cmd.payload as { villageId: string; popCostSum: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    s.enRoutePopCost = Math.max(0, popCostSum);

    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    return { ok: true, payload: {} };
  }
}


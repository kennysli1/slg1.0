import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';

/**
 * 领域模块 · Population（人口）v3 — 硬上限模型
 * 对应设计文档 13/14（「硬上限重做」章节）
 *
 * v3 核心机制：
 *  A. 硬上限 hardCap = Σ 建筑 popCapPerLevel × level（由 building.GetPopCap 提供，缓存到 state）。
 *  B. 劳动人口 currentPop（平民）；士兵足迹 = garrisonPopCost + enRoutePopCost + trainingPopCost（军事/行军上报 + 训练预留）。
 *     训练士兵 = 劳动人口→士兵的原子转化：currentPop 即时扣减、trainingPopCost 即时增加，totalPop = currentPop + 足迹 全程守恒，无"先扣后补"闪烁。
 *     availableLabor = currentPop（平民即劳动人口）；popCeiling = hardCap − 足迹（平民增长上限）。
 *  C. 繁荣度由「平民占总人口比例」驱动（与硬上限解耦，建造/升级不再造成负收益）：
 *       civilFrac = currentPop / (currentPop + soldierPop)   // 平民(劳动)占总人口比例，∈[0,1]
 *       prosperityBonus = clamp((civilFrac − minLaborRatio) / (fullRatio − minLaborRatio), 0, 1)
 *         // minLaborRatio = 1 − 本族动员上限；达到动员上限时为 0，劳动人口占比达到 fullRatio 时为 1
 *       prosperityMult  = 1 + popProsperityMaxBonus × prosperityBonus   // ∈ [1.0, 1.0 + maxBonus]
 *     四条速率轴（资源产出 / 研究 / 练兵 / 建造）统一消费 prosperityMult；繁荣度只增加额外加成，不降低基础值。
 *  D. 增长 growthPerHour = main.popGrowthPerLevel × mainLevel，朝 popCeiling（硬上限−士兵足迹）收敛（currentPop 已达则不再增长）。
 *     速率绑在城镇中心上（GM 面板可调）；旧版全局常数 popGrowthPerHour 已废弃。
 *  E. 开局人口：currentPop = 城镇中心当前等级贡献的 popCap 之和（mainPopCap），其他默认建筑只贡献 hardCap 不贡献人口。
 *  F. 口粮：平民 currentPop × popCropPerLabor /h（source='civilian_pop'）；士兵由 military 以 popCost×(popCropPerLabor+upkeep) 上报（source='troops'，默认口粮 + 军晌）。
 *  G. 战死回收：RecoverCasualties 按医院等级比例把死亡士兵人口（deadPop）的一部分回收为平民(currentPop)，其余计为永久损失；totalPop 净降 permanentDead。
 *  H. 粮荒保留士兵逃兵 + 人口死亡（减员状态机重写，脱离软上限）。
 */

interface PopulationState {
  villageId: string;
  /** 劳动人口（平民）。 */
  currentPop: number;
  /** 人口硬上限（缓存，由 building.GetPopCap 提供）。 */
  hardCap: number;
  /** 城镇中心等级（缓存，用于增长速率）。 */
  mainLevel: number;
  /** 驻军人口权重（military 经 SetGarrisonPop 上报）。 */
  garrisonPopCost: number;
  /** 在途部队人口权重（movement 经 SetEnRoutePop 上报）。 */
  enRoutePopCost: number;
  /** 训练中预留人口（military 经 ConsumePop 预留、逐兵 ReleaseTrainingPop 释放）。使训练全程总人口守恒，消除"先扣后补"闪烁。 */
  trainingPopCost: number;
  /** 部族（决定各部族最大动员比例 popRaceMobilizeMax，用于限制士兵占总人口上限；不再参与繁荣度计算，繁荣度由平民占比驱动）。 */
  tribe: string;
  /** 饥荒减员任务 id（运行中非空）。 */
  starveTaskId?: string;
  /** 是否处于饥荒（用于快照/事件展示）。 */
  inFamine?: boolean;
  /** 宝物人口增长倍率（乘数，默认 1；由 treasure 模块推送，无环）。 */
  treasureGrowthMult?: number;
  /** 声望人口增长倍率（乘数，默认 1；由 reputation 模块推送，无环）。 */
  reputationGrowthMult?: number;
  /** 科技人口增长倍率（乘数，默认 1；由 research 模块推送，无环）。 */
  techGrowthMult?: number;
  /** 任务奖励提供的临时人口增长倍率（乘数，默认 1）。 */
  taskGrowthMult?: number;
  /** 任务人口增长倍率到期时间（epoch ms）；空值表示没有临时任务加成。 */
  taskGrowthBuffExpiresAt?: number;
  /** 人口/金币增长明细的来源；只存派生快照，不改变结算口径。 */
  treasureGrowthSources?: GrowthSource[];
  treasureGoldSources?: GrowthSource[];
  techGrowthSources?: GrowthSource[];
  reputationGrowthSources?: GrowthSource[];
  reputationGoldSources?: GrowthSource[];
  /** 宝物金币税倍率（乘数，默认 1；goldRate 类宝物推送，无环）。 */
  treasureGoldMult?: number;
  /** 正负声望对金币税的最终倍率（正声望会降低税收，默认 1）。 */
  reputationGoldTaxMult?: number;
  /** 存储溢出扣减系数（0=无溢出；1=全部100%溢出），由 settle 更新后供 publicPayload 显示用。旧存档无此字段默认 0。 */
  storedOverflowRatio?: number;
  /** 动员加成（默认 0；全民皆兵 +0.15）。mobilizeCap = base + conscriptionBonus。旧存档无此字段默认 0。 */
  conscriptionBonus?: number;
  lastTick: number;
}

interface GrowthSource {
  label: string;
  /** 加性倍率（0.2 = +20%）。 */
  delta: number;
  expiresAt?: number;
}

interface GrowthBreakdownItem {
  source: string;
  label: string;
  ratePerHour: number;
  percent?: number;
  expiresAt?: number;
}

const COLLECTION = 'population';

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export class PopulationModule {
  static readonly NAME = 'population';



  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
  ) {}

  /** 周期结算是否已调度（防止 resume 重复注册）。 */
  private settleAllScheduled = false;

  /** 热重载配置（改 CSV 后调用）。 */
  setConfig(config: GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.commands.register('population.GetSnapshot', (c) => this.getSnapshot(c));
    this.commands.register('population.GetLaborMult', (c) => this.getLaborMult(c));
    this.commands.register('population.ConsumePop', (c) => this.consumePop(c));
    this.commands.register('population.ConsumeLabor', (c) => this.consumeLabor(c));
    this.commands.register('population.ConvertPopToGarrison', (c) => this.convertPopToGarrison(c));
    this.commands.register('population.ReturnPop', (c) => this.returnPop(c));
    this.commands.register('population.RecoverCasualties', (c) => this.recoverCasualties(c));
    this.commands.register('population.ReleaseTrainingPop', (c) => this.releaseTrainingPop(c));
    this.commands.register('population.SetGarrisonPop', (c) => this.setGarrisonPop(c));
    this.commands.register('population.SetEnRoutePop', (c) => this.setEnRoutePop(c));
    // 宝物模块推送的人口增长倍率（乘数），无环（treasure 只发命令，不回查）
    this.commands.register('population.SetTreasureGrowthMult', (c) => this.setTreasureGrowthMult(c));
    this.commands.register('population.SetTechGrowthMult', (c) => this.setTechGrowthMult(c));
    this.commands.register('population.SetReputationGrowthMult', (c) => this.setReputationGrowthMult(c));
    this.commands.register('population.SetReputationGoldTaxMult', (c) => this.setReputationGoldTaxMult(c));
    this.commands.register('population.SetConscriptionMult', (c) => this.setConscriptionMult(c));
    this.commands.register('population.GrantPopulation', (c) => this.grantPopulation(c));
    this.commands.register('population.ApplyTaskGrowthBuff', (c) => this.applyTaskGrowthBuff(c));

    // 建筑建造/升级 → 硬上限或主城等级可能变化 → 重算繁荣度并广播
    this.bus.on('building.Built', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.refreshHardCap(villageId);
    });
    this.bus.on('building.Upgraded', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.refreshHardCap(villageId);
    });
    // 拆除开始即置 level=0，硬上限须同步重算（否则拆除期间仍按旧上限计，违反"期间无加成"）
    this.bus.on('building.Demolishing', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.refreshHardCap(villageId);
    });
    // 战斗损坏会把建筑等级降到 0（或降低到更低等级），修复完成会通过
    // building.Repaired 恢复目标等级。两者都必须重算缓存硬上限，否则
    // 破坏/修复后 population.hardCap 会与 building.GetPopCap 脱节。
    this.bus.on('building.BattleDamaged', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      if (villageId) void this.refreshHardCap(villageId);
    });
    this.bus.on('building.Repaired', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      if (villageId) void this.refreshHardCap(villageId);
    });

    // 经济进入粮食赤字 → 启动饥荒减员（若未在运行）
    this.bus.on('economy.CropDeficit', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.onCropDeficit(villageId);
    });
  }

  resume(): void {
    for (const s of this.store.all<PopulationState>(COLLECTION)) {
      // 旧存档兼容字段
      if (s.garrisonPopCost === undefined) s.garrisonPopCost = 0;
      if (s.enRoutePopCost === undefined) s.enRoutePopCost = 0;
      if (s.trainingPopCost === undefined) s.trainingPopCost = 0;
      if (s.inFamine === undefined) s.inFamine = false;
      if (s.treasureGrowthMult === undefined) s.treasureGrowthMult = 1;
      if (s.reputationGrowthMult === undefined) s.reputationGrowthMult = 1;
      if (s.techGrowthMult === undefined) s.techGrowthMult = 1;
      if (s.taskGrowthMult === undefined) s.taskGrowthMult = 1;
      if (s.treasureGoldMult === undefined) s.treasureGoldMult = 1;
      if (s.reputationGoldTaxMult === undefined) s.reputationGoldTaxMult = 1;
      if (s.tribe === undefined) s.tribe = 'romans';
      if (s.mainLevel === undefined) s.mainLevel = 1;
      if (s.hardCap === undefined) s.hardCap = 0;
      if (!Array.isArray(s.treasureGrowthSources)) s.treasureGrowthSources = [];
      if (!Array.isArray(s.treasureGoldSources)) s.treasureGoldSources = [];
      if (!Array.isArray(s.techGrowthSources)) s.techGrowthSources = [];
      if (!Array.isArray(s.reputationGrowthSources)) s.reputationGrowthSources = [];
      if (!Array.isArray(s.reputationGoldSources)) s.reputationGoldSources = [];

      // Scheduler 任务仅存在于当前进程；存档中的编号不能证明任务仍在运行。
      // 按 owner 去重，立即复核恢复状态；仍缺粮时等完整减员间隔，不在重启时额外扣人口。
      const needsFamineCheck = s.inFamine || !!s.starveTaskId;
      this.scheduler.cancelByOwner(`population:starve:${s.villageId}`);
      s.starveTaskId = undefined;
      if (needsFamineCheck) {
        s.starveTaskId = this.scheduler.schedule(
          0,
          () => this.runStarveTick(s.villageId, false),
          `population:starve:${s.villageId}`,
          `village:${s.villageId}`,
        );
      }
      this.store.set(COLLECTION, s.villageId, s);
      if (s.taskGrowthBuffExpiresAt && s.taskGrowthBuffExpiresAt > this.now()) {
        this.scheduleTaskGrowthExpiry(s.villageId, s.taskGrowthBuffExpiresAt);
      } else if (s.taskGrowthBuffExpiresAt) {
        s.taskGrowthBuffExpiresAt = undefined;
        s.taskGrowthMult = 1;
        this.store.set(COLLECTION, s.villageId, s);
      }
      // 派生硬上限是建筑等级的纯函数，重启时一律从 building 重算（旧存档缺字段也能补全）
      void this.refreshHardCap(s.villageId);
    }
    // 周期结算：金币税与人口增长持续累加，不依赖客户端是否在线轮询（否则离线/未开面板时金币显示 +X/时却不涨）。
    this.scheduleSettleAll();
  }

  /**
   * 周期结算全部村庄（金币税 + 人口增长），使产出持续累加，离线也生效。
   * 每 INTERVAL_MS 触发一次，回调内再次 schedule 形成循环。settle 基于 lastTick 计算 Δt，
   * 与客户端轮询触发的 getSnapshot/consumePop 等结算互不重复计数（后者会把 lastTick 推前，本 tick 见到的 Δt 自然变小）。
   * 注意：settle 永不 emit，故周期 tick 不会产生 PopulationChanged 推送（避免刷屏）。
   */
  private scheduleSettleAll(): void {
    if (this.settleAllScheduled) return;
    this.settleAllScheduled = true;
    const INTERVAL_MS = 30_000;
    const tick = () => {
      for (const s of this.store.all<PopulationState>(COLLECTION)) {
        void this.settleAndPersist(s);
      }
      this.scheduler.schedule(INTERVAL_MS, tick, 'population:settleAll');
    };
    this.scheduler.schedule(INTERVAL_MS, tick, 'population:settleAll');
  }

  /** 结算并持久化单个村庄状态（供周期 tick 复用；命令路径各自在结算后自行 store.set）。 */
  private async settleAndPersist(s: PopulationState): Promise<void> {
    await this.settle(s);
    // 恢复不依赖减员任务是否仍存在（例如零人口、旧任务编号或减员后刚好收支平衡）。
    // GetSnapshot/settle 仍不发事件；恢复事件只由 Scheduler 周期路径发出。
    if (s.inFamine && (await this.computeDeficit(s)) === false) await this.recoverFromFamine(s);
    this.store.set(COLLECTION, s.villageId, s);
  }

  /**
   * 新村创建：查 building.GetPopCap 得 hardCap + mainLevel + mainPopCap；
   * 开局人口 = 城镇中心当前等级贡献的 popCap 之和（= mainPopCap），其他默认建筑只贡献 hardCap 不贡献人口。
   * 人口随后按 main.popGrowthPerLevel × mainLevel /h 慢慢增长至 hardCap。
   * 必须在 economy/building/military 已初始化之后调用。
   */
  async createVillage(villageId: string, tribe = 'romans', initialPop?: number): Promise<void> {
    const capRes = await this.commands.send({
      name: 'building.GetPopCap',
      from: PopulationModule.NAME,
      payload: { villageId },
    });
    const hardCap: number = (capRes.payload as any)?.hardCap ?? 0;
    const mainLevel: number = (capRes.payload as any)?.mainLevel ?? 1;
    const mainPopCap: number = (capRes.payload as any)?.mainPopCap ?? 0;

    const s: PopulationState = {
      villageId,
      currentPop: Math.min(hardCap, Math.max(0, initialPop ?? mainPopCap)),
      hardCap,
      mainLevel,
      garrisonPopCost: 0,
      enRoutePopCost: 0,
      trainingPopCost: 0,
      tribe,
      inFamine: false,
      lastTick: this.now(),
    };
    this.store.set(COLLECTION, villageId, s);
    await this.reportToEconomy(s);
  }

  private load(villageId: string): PopulationState | undefined {
    return this.store.get<PopulationState>(COLLECTION, villageId);
  }

  // ── 派生计算（纯函数，无副作用）──────────────────────────────────────────

  /** 实际驻军人口权重 = 驻军 + 在途（不含训练中预留）。 */
  private soldierPop(s: PopulationState): number {
    return s.garrisonPopCost + s.enRoutePopCost;
  }

  /**
   * 士兵人口足迹 = 驻军 + 在途 + 训练中预留。
   * 训练时即时把劳动人口转为"训练中"预留（trainingPopCost 即时增加、currentPop 即时减少），
   * 故 总人口 = currentPop + 足迹 在训练全程守恒，绝不出现"先扣后补"闪烁。
   * 士兵逐兵产出后 trainingPopCost 释放、garrisonPopCost 同步增加，足迹保持不变。
   */
  private soldierFootprint(s: PopulationState): number {
    return s.garrisonPopCost + s.enRoutePopCost + (s.trainingPopCost ?? 0);
  }

  /** 总人口 = 劳动人口(currentPop) + 士兵足迹（驻军+在途+训练中）。训练/战死回收守恒，仅增长/饥荒/永久战损改变。 */
  private totalPop(s: PopulationState): number {
    return s.currentPop + this.soldierFootprint(s);
  }

  /** 可用劳动人口 = 平民(currentPop)。士兵由劳动人口转化而来，故劳动人口即平民数；增长目标见 popCeiling。 */
  private availableLabor(s: PopulationState): number {
    return Math.max(0, s.currentPop);
  }

  /** 平民增长上限（占 housing 余量）= 硬上限 − 士兵足迹。士兵越多，平民可增长空间越小。 */
  private popCeiling(s: PopulationState): number {
    return Math.max(0, s.hardCap - this.soldierFootprint(s));
  }

  /** 本部族最大动员比例（士兵占总人口上限）：条顿0.80/高卢0.70/罗马0.75 + 全民皆兵加成。 */
  private mobilizeCap(s: PopulationState): number {
    const rm = this.config.constants.popRaceMobilizeMax;
    const base = (rm as Record<string, number>)[s.tribe] ?? rm.romans;
    const bonus = s.conscriptionBonus ?? 0;
    return base + bonus;
  }

  /**
   * 平民占总人口比例 = currentPop / totalPop（与 prosperityBonus 同口径）。
   * 训练士兵把劳动人口转为士兵足迹，totalPop 不变、currentPop 下降 → 平民占比下降 → 繁荣度下降（经济效率惩罚）。
   * 军队规模同时限制动员上限(popRaceMobilizeMax)与耗粮，士兵只额外增加军晌耗粮。
   */
  private laborRatio(s: PopulationState): number {
    const total = this.totalPop(s);
    return total > 0 ? Math.min(1, s.currentPop / total) : 0;
  }

  /**
   * 繁荣度加成 ∈ [0,1]，由「劳动人口占总人口比例」驱动：
   *  - civilFrac = currentPop / totalPop（laborRatio），∈ [0,1]。
   *  - minLaborRatio = 1 − 本族动员上限；达到动员上限或更高时加成为 0。
   *  - 达到 popProsperityFullRatio（默认 0.70）为满值，区间内线性插值。
   *  - 拥挤惩罚（保底）：平民实际超过硬上限（人口超 housing，多在拆房/减员回补瞬态）时，
   *    按 popOvercapPenaltyFullRatio 在 1→2 倍间线性降到 0。正常稳态 currentPop ≤ hardCap，不触发。
   */
  private prosperityBonus(s: PopulationState): number {
    const c = this.config.constants;
    const total = this.totalPop(s);
    const civilFrac = total > 0 ? s.currentPop / total : 0;
    const minLaborRatio = clamp(1 - this.mobilizeCap(s), 0, 1);
    const threshold = c.popProsperityFullRatio;
    const fillBonus = civilFrac <= minLaborRatio
      ? 0
      : threshold <= minLaborRatio
        ? 1
        : clamp((civilFrac - minLaborRatio) / (threshold - minLaborRatio), 0, 1);
    let overcrowd = 1;
    if (s.hardCap > 0 && total > s.hardCap) {
      const overRatio = total / s.hardCap;
      const over = clamp((overRatio - 1) / (c.popOvercapPenaltyFullRatio - 1), 0, 1);
      overcrowd = 1 - over;
    }
    return fillBonus * overcrowd;
  }

  /** 四轴统一的繁荣度倍率 ∈ [1.0, 1.0 + popProsperityMaxBonus]；低繁荣度不低于基础产值。 */
  private prosperityMult(s: PopulationState): number {
    const c = this.config.constants;
    return 1 + Math.max(0, c.popProsperityMaxBonus) * this.prosperityBonus(s);
  }

  /** 原始增长速率（每小时，未夹紧到缺口）。速率绑在城镇中心上：main.popGrowthPerLevel × mainLevel（GM 面板可调）。再乘宝物人口增长倍率。 */
  private growthRateRaw(s: PopulationState): number {
    const base = (this.config.buildings.main?.popGrowthPerLevel ?? 0) * s.mainLevel;
    return base * (s.treasureGrowthMult ?? 1) * (s.techGrowthMult ?? 1) * (s.reputationGrowthMult ?? 1) * (s.taskGrowthMult ?? 1);
  }

  /** 每小时有效增长速率（不按 popCeiling 剩余缺口截断）。粮荒期间不增长（否则会与减员相互抵消）。 */
  private growthPerHour(s: PopulationState): number {
    if (s.inFamine) return 0;
    return Math.max(0, this.growthRateRaw(s));
  }

  /** 将人口增长倍率按来源拆解；各来源贡献之和严格等于最终理论增长。 */
  private growthBreakdown(s: PopulationState): GrowthBreakdownItem[] {
    const base = Math.max(0, (this.config.buildings.main?.popGrowthPerLevel ?? 0) * s.mainLevel);
    const entries: GrowthBreakdownItem[] = [{ source: 'main', label: `主基地基础人口增长（Lv${s.mainLevel}）`, ratePerHour: base }];
    let current = base;
    const applyGroup = (source: string, sources: GrowthSource[] | undefined, aggregateDelta: number): void => {
      const valid = (sources ?? []).filter((item) => Number.isFinite(item.delta) && item.delta !== 0);
      const total = Number.isFinite(aggregateDelta) ? aggregateDelta : valid.reduce((sum, item) => sum + item.delta, 0);
      if (valid.length) {
        const groupBase = current;
        for (const item of valid) entries.push({ source, label: item.label, ratePerHour: groupBase * item.delta, percent: item.delta * 100, ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}) });
        current = groupBase * (1 + total);
      } else if (total !== 0) {
        entries.push({ source, label: source, ratePerHour: current * total, percent: total * 100 });
        current *= 1 + total;
      }
    };
    applyGroup('treasure', s.treasureGrowthSources, (s.treasureGrowthMult ?? 1) - 1);
    applyGroup('technology', s.techGrowthSources, (s.techGrowthMult ?? 1) - 1);
    applyGroup('reputation', s.reputationGrowthSources, (s.reputationGrowthMult ?? 1) - 1);
    const taskDelta = s.taskGrowthBuffExpiresAt && s.taskGrowthBuffExpiresAt > this.now() ? (s.taskGrowthMult ?? 1) - 1 : 0;
    applyGroup('task', taskDelta ? [{ label: '任务临时加成', delta: taskDelta, expiresAt: s.taskGrowthBuffExpiresAt }] : [], taskDelta);
    return entries.filter((entry, index) => index === 0 || entry.ratePerHour !== 0);
  }

  /** 将金币税按宝物/声望来源拆解；金币没有资源田，基础项为劳动人口税基。 */
  private goldBreakdown(s: PopulationState): GrowthBreakdownItem[] {
    const base = Math.max(0, s.currentPop * this.config.constants.goldTaxPerCivilianPerHour);
    const entries: GrowthBreakdownItem[] = [{ source: 'gold_tax', label: '劳动人口基础税收', ratePerHour: base }];
    let current = base;
    const applyGroup = (source: string, sources: GrowthSource[] | undefined, aggregateDelta: number): void => {
      const valid = (sources ?? []).filter((item) => Number.isFinite(item.delta) && item.delta !== 0);
      const total = Number.isFinite(aggregateDelta) ? aggregateDelta : valid.reduce((sum, item) => sum + item.delta, 0);
      if (!valid.length && total === 0) return;
      const groupBase = current;
      if (valid.length) for (const item of valid) entries.push({ source, label: item.label, ratePerHour: groupBase * item.delta, percent: item.delta * 100, ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}) });
      else entries.push({ source, label: source, ratePerHour: groupBase * total, percent: total * 100 });
      current = groupBase * (1 + total);
    };
    applyGroup('treasure', s.treasureGoldSources, (s.treasureGoldMult ?? 1) - 1);
    applyGroup('reputation', s.reputationGoldSources, (s.reputationGoldTaxMult ?? 1) - 1);
    return entries;
  }

  // ── Economy 同步（铁律#4：只上报，不回查软上限）──────────────────────────

  /**
   * 向 economy 上报：① 平民口粮 currentPop × popCropPerLabor（source='civilian_pop'）；
   * ② 四轴繁荣度额外加成（source='pop_labor'，mult[res] = prosperityMult − 1）。
   * 士兵口粮（source='troops'）由 military 自行上报，此处不重复。
   */
  private async reportToEconomy(s: PopulationState): Promise<void> {
    const c = this.config.constants;
    const mult = this.prosperityMult(s);
    await this.commands.send({
      name: 'economy.SetUpkeep', from: PopulationModule.NAME,
      payload: { villageId: s.villageId, source: 'civilian_pop', cropPerHour: s.currentPop * c.popCropPerLabor },
    });
    const rateMult: Record<string, number> = {};
    for (const res of ['wood', 'clay', 'iron', 'crop']) rateMult[res] = mult - 1;
    await this.commands.send({
      name: 'economy.SetRateModifier', from: PopulationModule.NAME,
      payload: {
        villageId: s.villageId,
        source: 'pop_labor',
        mult: rateMult,
        details: [{ source: 'pop_labor', label: '繁荣度（劳动人口比例）', mult: rateMult }],
      },
    });
  }

  // ── 惰性结算（只补算增长，永不 emit）────────────────────────────────────

  /**
   * 按 Δt 补算人口增长（朝 popCeiling 收敛）。不返回 context、不 emit
   * （铁律：减员只在 starve tick emit；其余离散写各自 emit）。
   * 增长后即时同步 cropUpkeep + pop_labor mult 给 economy（铁律#4），
   * 否则 civilian_pop 停在最后一次离散动作时刻 → UI 用外插值与服务端真实值脱节（耗粮低估）。
   */
  private async settle(s: PopulationState): Promise<void> {
    const now = this.now();
    const dtHours = (now - s.lastTick) / 3600_000;
    s.lastTick = now;
    if (dtHours <= 0) return;
    const c = this.config.constants;

    const ceiling = this.popCeiling(s);
    // 存储溢出惩罚：查询 economy 是否有资源超出容量（露天仓库科技相关）
    let overflowRatio = 0;
    try {
      const ctxRes = await this.commands.send({ name: 'economy.GetCropContext', from: PopulationModule.NAME, payload: { villageId: s.villageId } });
      if (ctxRes.ok) { overflowRatio = Math.min(1, (ctxRes.payload as any).overflowRatio ?? 0); }
    } catch { /* 查询失败不阻塞 */ }
    s.storedOverflowRatio = overflowRatio;
    // 粮荒期间不增长（减员路径由 runStarveTick 独占），避免与减员相互抵消导致人口卡在平衡点。
    // 增长目标 = 增长上限 popCeiling（硬上限 − 士兵足迹）：平民(劳动人口)朝它收敛，士兵足迹不占增长空间。
    if (!s.inFamine && s.currentPop < ceiling) {
      const grow = Math.min(ceiling - s.currentPop, this.growthRateRaw(s) * dtHours * (1 - overflowRatio));
      s.currentPop = Math.min(ceiling, s.currentPop + grow);
    }
    s.currentPop = Math.max(0, s.currentPop);

    // 交税：仅劳动人口(currentPop)按税率交金币，绑定城镇中心，不受繁荣度影响但受宝物/声望税收倍率影响。
    // 单向 Grant 到 economy（不读回，无环）；与资源惰性结算同节奏，按 Δt 累加。
    const goldGained = s.currentPop * c.goldTaxPerCivilianPerHour * dtHours * (s.treasureGoldMult ?? 1) * (s.reputationGoldTaxMult ?? 1);
    if (goldGained > 0) {
      await this.commands.send({
        name: 'economy.Grant', from: PopulationModule.NAME,
        payload: { villageId: s.villageId, gain: { gold: goldGained } },
      });
    }

    // 增长结束后即时上报 civilian_pop + pop_labor mult，使 economy 的 cropUpkeep 与服务端 currentPop 同步
    await this.reportToEconomy(s);
  }

  // ── 公共 payload（快照与事件共用字段）────────────────────────────────────

  private publicPayload(s: PopulationState): Record<string, unknown> {
    const c = this.config.constants;
    const soldierPop = this.soldierPop(s);
    const footprint = this.soldierFootprint(s);
    const total = this.totalPop(s);
    const avail = this.availableLabor(s);
    const ceiling = this.popCeiling(s);
    const ratio = this.laborRatio(s);
    const bonus = this.prosperityBonus(s);
    const mult = this.prosperityMult(s);
    const growth = this.growthPerHour(s);
    return {
      villageId: s.villageId,
      /** 劳动人口（平民）。训练士兵即时转出，故为可转化为士兵的池子。 */
      currentPop: Math.floor(s.currentPop),
      /** 实际驻军人口权重（驻军 + 在途）。 */
      soldierPop: Math.floor(soldierPop),
      /** 总人口 = 平民 + 士兵足迹（驻军+在途+训练中）。训练/战死回收守恒，是面板大数字。 */
      totalPop: Math.floor(total),
      /** 训练中预留人口（已转出劳动人口、尚未产出为驻军）。 */
      trainingPop: Math.floor(s.trainingPopCost ?? 0),
      hardCap: Math.floor(s.hardCap),
      /** 可用劳动人口 = 平民(currentPop)，用于生产/建造/练兵。 */
      availableLabor: Math.floor(avail),
      // 兼容旧客户端的 softLimit 字段：人口饥荒/容量展示仍以硬上限为基准。
      softLimit: Math.floor(s.hardCap),
      /** 平民增长上限（占 housing 余量）= 硬上限 − 士兵足迹；客户端外插增长用。 */
      popCeiling: Math.floor(ceiling),
      laborRatio: Math.round(ratio * 100) / 100,
      prosperityBonus: Math.round(bonus * 100) / 100,
      prosperityMult: Math.round(mult * 100) / 100,
      growthPerHour: Math.max(0, Math.round(growth * (1 - (s.storedOverflowRatio ?? 0)))),
      /** 原始增长速率（未夹紧到硬上限缺口）：达上限时仍展示人口流动潜力。 */
      potentialGrowthPerHour: Math.round(this.growthRateRaw(s) * (1 - (s.storedOverflowRatio ?? 0))),
      /** 任务提供的临时人口增长奖励；仅在有效期内显示。 */
      taskGrowthBuff: s.taskGrowthBuffExpiresAt && s.taskGrowthBuffExpiresAt > this.now()
        ? { mult: s.taskGrowthMult ?? 1, expiresAt: s.taskGrowthBuffExpiresAt }
        : null,
      /** 本部族最大动员比例（士兵占总人口上限）；用于前端展示/校验。 */
      mobilizeCap: this.mobilizeCap(s),
      /** 繁荣度满值阈值（劳动人口占总人口比例 ≥此值时 prosperityBonus=1）；面板文案使用。 */
      popProsperityFullRatio: c.popProsperityFullRatio,
      /** 繁荣度满值时的额外速率加成（默认 +30%）。 */
      popProsperityMaxBonus: c.popProsperityMaxBonus,
      /** 人口达到硬上限几倍时，繁荣额外加成降为 0（默认 2 倍）。 */
      popOvercapPenaltyFullRatio: c.popOvercapPenaltyFullRatio,
      mainLevel: s.mainLevel,
      inFamine: !!s.inFamine,
      civilianCropPerHour: Math.round(s.currentPop * c.popCropPerLabor * 10) / 10,
      /** 每小时金币产量（仅劳动人口交税，绑定城镇中心，不受繁荣度影响；受宝物/声望倍率影响）。供资源条展示金币速率。 */
      goldPerHour: Math.round(s.currentPop * c.goldTaxPerCivilianPerHour * (s.treasureGoldMult ?? 1) * (s.reputationGoldTaxMult ?? 1)),
      growthBreakdown: this.growthBreakdown(s),
      goldBreakdown: this.goldBreakdown(s),
      /** 存储溢出扣减系数（0~1）。前端据此显示人口增长被扣减的原因。 */
      overflowRatio: Math.round((s.storedOverflowRatio ?? 0) * 100) / 100,
    };
  }

  // ── 饥荒状态机（G 项，保留减员）────────────────────────────────────────

  /** CropDeficit 边沿触发：若未运行，调度第一个 starve tick（每村仅一个活跃任务）。 */
  private async onCropDeficit(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s || s.starveTaskId) return;
    const c = this.config.constants;
    s.starveTaskId = this.scheduler.schedule(
      c.popFamineTickSec * 1000,
      () => this.runStarveTick(villageId),
      `population:starve:${villageId}`,
      `village:${villageId}`,
    );
    this.store.set(COLLECTION, villageId, s);
  }

  /** 当前是否仍处粮食赤字（currentCrop<=0 且净产率<0）。减员后重新评估以决定是否续排。 */
  private async computeDeficit(s: PopulationState): Promise<boolean | undefined> {
    const c = this.config.constants;
    let cropRes: CommandResult;
    try {
      cropRes = await this.commands.send({
        name: 'economy.GetCropContext', from: PopulationModule.NAME,
        payload: { villageId: s.villageId },
      });
    } catch { return undefined; }
    const { baseCropPerHour, nonCivilianUpkeep, currentCrop } = (cropRes.payload ?? {}) as {
      baseCropPerHour: number; nonCivilianUpkeep: number; currentCrop: number;
    };
    // 查询失败不等于粮食收支为零；未知时既不恢复也不减员，由下一次检查重试。
    if (!cropRes.ok || ![baseCropPerHour, nonCivilianUpkeep, currentCrop].every(Number.isFinite)) return undefined;
    const mult = this.prosperityMult(s);
    const civilianCrop = s.currentPop * c.popCropPerLabor;
    const netCropRatePerHour = baseCropPerHour * mult - nonCivilianUpkeep - civilianCrop;
    return currentCrop <= 0 && netCropRatePerHour < 0;
  }

  /** Scheduler 路径统一退出饥荒；只取消本村饥荒任务，恢复事件最多发一次。 */
  private async recoverFromFamine(s: PopulationState): Promise<void> {
    const wasInFamine = !!s.inFamine;
    this.scheduler.cancelByOwner(`population:starve:${s.villageId}`);
    s.starveTaskId = undefined;
    s.inFamine = false;
    // 饥荒期间禁止增长，不能把暂停的整段时间在恢复后补算成人口。
    if (wasInFamine) s.lastTick = this.now();
    this.store.set(COLLECTION, s.villageId, s);
    if (wasInFamine) {
      await this.bus.emit({
        name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
        payload: { ...this.publicPayload(s), event: 'recovery' },
      } as DomainEvent);
    }
  }

  /** 减员仅由正常 tick 执行；启动复核不减员，仍赤字则续排完整间隔。 */
  private async runStarveTick(villageId: string, applyLoss = true): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    s.starveTaskId = undefined;

    if (s.inFamine) await this.settle(s);
    await this.reportToEconomy(s);

    const deficit = await this.computeDeficit(s);
    if (deficit === false) {
      await this.recoverFromFamine(s);
      return;
    }

    const c = this.config.constants;
    if (deficit === undefined || !applyLoss) {
      await this.onCropDeficit(villageId);
      return;
    }
    const tickHours = c.popFamineTickSec / 3600;
    const reduced = Math.max(
      0,
      Math.min(s.currentPop, s.currentPop * (1 - Math.exp(-c.popDeathRateFactor * tickHours))),
    );
    s.currentPop = Math.max(0, s.currentPop - reduced);
    s.currentPop = Math.min(s.currentPop, s.hardCap);

    const wasInFamine = s.inFamine;
    s.inFamine = true;
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    const eventKind = wasInFamine ? 'starved' : 'famine';
    await this.bus.emit({
      name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
      payload: {
        ...this.publicPayload(s),
        event: eventKind,
        reduced: Math.round(reduced),
      },
    } as DomainEvent);

    // 减员后若仍赤字则续排，否则停止（避免永久空转）
    const stillInDeficit = await this.computeDeficit(s);
    if (stillInDeficit === false) {
      await this.recoverFromFamine(s);
    } else if (s.currentPop > 0) {
      s.starveTaskId = this.scheduler.schedule(
        c.popFamineTickSec * 1000,
        () => this.runStarveTick(villageId),
        `population:starve:${villageId}`,
        `village:${villageId}`,
      );
      this.store.set(COLLECTION, villageId, s);
    }
  }

  // ── 订阅处理：硬上限刷新 ─────────────────────────────────────────────────

  async refreshHardCap(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const capRes = await this.commands.send({
      name: 'building.GetPopCap', from: PopulationModule.NAME,
      payload: { villageId },
    });
    const hardCap: number = (capRes.payload as any)?.hardCap ?? s.hardCap;
    const mainLevel: number = (capRes.payload as any)?.mainLevel ?? s.mainLevel;
    const capChanged = hardCap !== s.hardCap || mainLevel !== s.mainLevel;
    s.hardCap = hardCap;
    s.mainLevel = mainLevel;
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);
    if (capChanged) {
      await this.bus.emit({
        name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
        payload: { ...this.publicPayload(s), event: 'capChanged' },
      } as DomainEvent);
    }
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  /** 获取人口面板快照（v3 硬上限结构）。 */
  private async getSnapshot(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    await this.settle(s);
    this.store.set(COLLECTION, villageId, s);

    const multRaw = this.prosperityMult(s);
    // 与 publicPayload 的 prosperityMult 同口径（显示级四舍五入到 2 位），保证两者严格相等
    const mult = Math.round(multRaw * 100) / 100;
    const laborMults = {
      production: mult,
      build: mult,
      train: mult,
      research: mult,
    };

    return {
      ok: true,
      payload: {
        ...this.publicPayload(s),
        laborMults,
        lastTick: s.lastTick,
      },
    };
  }

  /** 繁荣度乘数（v3 四轴统一；kind 参数保留兼容，不再区分）。 */
  private getLaborMult(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: true, payload: { mult: 1.0 } };
    return { ok: true, payload: { mult: this.prosperityMult(s) } };
  }

  /**
   * 训练人口校验 + 原子预留（劳动人口 → 士兵足迹转化，总数守恒）。
   * 训练开始时：currentPop（平民）即时扣减 cost，trainingPopCost 即时增加 cost，
   * 故 totalPop = currentPop + 足迹 在训练全程保持不变——无"先扣后补"闪烁。
   * 约束：① 平民不足（cost > currentPop）→ insufficient_population；
   *       ② 转化后士兵足迹超过本部族动员上限(popRaceMobilizeMax×totalPop) → mobilize_cap_exceeded。
   * 返回 consumed = 实际预留人口（供 military 训练失败回滚用 ReleaseTrainingPop）。
   */
  private async consumePop(cmd: Command): Promise<CommandResult> {
    const { villageId, unit, count } = cmd.payload as { villageId: string; unit: string; count: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const def = this.config.units[unit];
    if (!def) return { ok: false, payload: {}, reason: `unknown_unit:${unit}` };

    await this.settle(s);

    const cost = def.popCost * count;
    // ① 平民不足：可转化人口 = currentPop（已扣除此前预留）
    if (cost > s.currentPop + 1e-9) {
      this.store.set(COLLECTION, villageId, s);
      return { ok: false, payload: {}, reason: 'insufficient_population' };
    }

    // ② 动员上限：士兵足迹（含训练中）不得超过本部族 popRaceMobilizeMax × 总人口
    const totalPop = this.totalPop(s);
    const maxSoldier = this.mobilizeCap(s) * totalPop;
    if (this.soldierFootprint(s) + cost > maxSoldier + 1e-9) {
      this.store.set(COLLECTION, villageId, s);
      return { ok: false, payload: {}, reason: 'mobilize_cap_exceeded' };
    }

    // 原子转化：平民即时转出、训练中即时预留；totalPop 守恒
    s.currentPop -= cost;
    s.trainingPopCost = (s.trainingPopCost ?? 0) + cost;
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    await this.bus.emit({
      name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
      payload: { ...this.publicPayload(s), event: 'consumed', consumed: Math.round(cost) },
    } as DomainEvent);

    return { ok: true, payload: { ok: true, consumed: Math.round(cost) } };
  }

  /**
   * 祭祀台等消耗型效果：扣除 amount 个劳动人口（平民）。
   * 不足部分不在此扣（由调用方转扣士兵人口，见 military.SacrificeTroops）。
   * 返回 { consumed: 实际扣掉的劳动人口, remaining: 仍缺的人口 }。
   */
  private async consumeLabor(cmd: Command): Promise<CommandResult> {
    const { villageId, amount } = cmd.payload as { villageId: string; amount: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    await this.settle(s);
    const want = Math.max(0, Math.floor(amount));
    const consumed = Math.min(want, s.currentPop);
    s.currentPop = Math.max(0, s.currentPop - consumed);
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);
    await this.bus.emit({
      name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
      payload: { ...this.publicPayload(s), event: 'consumed_labor', consumed: Math.round(consumed) },
    } as DomainEvent);
    return { ok: true, payload: { consumed: Math.round(consumed), remaining: Math.max(0, want - consumed) } };
  }

  /** 伯乐翻倍：劳动人口直接转为驻军（不走训练预留通道，即时生效）。 */
  private async convertPopToGarrison(cmd: Command): Promise<CommandResult> {
    const { villageId, amount } = cmd.payload as { villageId: string; amount: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    await this.settle(s);
    const amt = Math.max(0, Math.floor(amount));
    if (amt > s.currentPop) return { ok: false, payload: {}, reason: 'insufficient_population' };
    s.currentPop -= amt;
    s.garrisonPopCost = (s.garrisonPopCost ?? 0) + amt;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { currentPop: s.currentPop, garrisonPopCost: s.garrisonPopCost } };
  }

  /**
   * 解散/返程：士兵离开村庄 → 人口返还平民池（currentPop 增加）。
   * 与训练对称：士兵 = 转化出去的平民，解散即"退役归田"。
   * 训练中预留(trainingPopCost)与此路径无关（解散只作用于已产出 troops）。
   */
  private async returnPop(cmd: Command): Promise<CommandResult> {
    const { villageId, units } = cmd.payload as { villageId: string; units: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    await this.settle(s);

    let returned = 0;
    for (const [unit, cnt] of Object.entries(units)) {
      if (cnt <= 0) continue;
      const udef = this.config.units[unit];
      if (!udef) continue;
      returned += udef.popCost * cnt;
    }
    s.currentPop = Math.min(this.popCeiling(s), s.currentPop + returned);
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    return { ok: true, payload: { ok: true, returned: Math.round(returned) } };
  }

  /**
   * 释放训练中预留人口。
   *  - 逐兵产出(produceOne)：restoreCivilian=false → 仅把 trainingPopCost 扣减 amount，
   *    该人口已由 SetGarrisonPop 计入 garrisonPopCost（footprint 不变、totalPop 守恒）。
   *  - 训练失败回滚(trainTroops)：restoreCivilian=true → 扣减 trainingPopCost 并加回 currentPop，
   *    抵消 consumePop 的"currentPop-=cost / trainingPopCost+=cost"，totalPop 守恒。
   */
  private async releaseTrainingPop(cmd: Command): Promise<CommandResult> {
    const { villageId, amount, restoreCivilian } = cmd.payload as { villageId: string; amount: number; restoreCivilian?: boolean };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const amt = Math.max(0, amount);
    const released = Math.min(amt, s.trainingPopCost ?? 0);
    s.trainingPopCost = (s.trainingPopCost ?? 0) - released;
    if (restoreCivilian) s.currentPop += released; // 仅回滚路径：恢复平民
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { ok: true, released: Math.round(released) } };
  }

  /**
   * 战死处理：士兵 = 转化出去的平民，战死即该平民永久失去（部分经医院回收为平民）。
   * 死亡士兵已在 military 侧 AdjustTroops 扣掉 → soldierFootprint 自动下降（totalPop 同步降）。
   * 此处按医院等级比例把 deadPop 的一部分回收为平民(currentPop += recovered)，其余计为永久损失(totalPop 净降)。
   * totalPop 守恒性：footprint 降 deadPop，currentPop 升 recovered → total 净降 (deadPop - recovered) = permanentDead。
   */
  private async recoverCasualties(cmd: Command): Promise<CommandResult> {
    const { villageId, losses } = cmd.payload as { villageId: string; losses: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const c = this.config.constants;

    await this.settle(s);

    const hospRes = await this.commands.send({
      name: 'building.GetBuildingLevel', from: PopulationModule.NAME,
      payload: { villageId, kind: 'hospital' },
    });
    const hospLv = (hospRes.payload as any)?.level ?? 0;
    const recoveryRatio = Math.min(
      c.popHospitalRecoveryMax,
      c.popHospitalRecoveryBase + hospLv * c.popHospitalRecoveryPerLevel,
    );

    let recovered = 0;
    let permanentDead = 0;
    for (const [unit, lostCount] of Object.entries(losses)) {
      if (lostCount <= 0) continue;
      const udef = this.config.units[unit];
      if (!udef) continue;
      const deadPop = lostCount * udef.popCost;
      const rec = deadPop * recoveryRatio;
      recovered += rec;
      permanentDead += deadPop - rec;
    }

    s.currentPop += recovered;
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    if (recovered > 0 || permanentDead > 0) {
      await this.bus.emit({
        name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
        payload: { ...this.publicPayload(s), event: 'recovered', recovered: Math.round(recovered), permanentDead: Math.round(permanentDead) },
      } as DomainEvent);
    }

    return { ok: true, payload: { ok: true, recovered: Math.round(recovered), permanentDead: Math.round(permanentDead) } };
  }

  private async setGarrisonPop(cmd: Command): Promise<CommandResult> {
    const { villageId, popCostSum } = cmd.payload as { villageId: string; popCostSum: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.garrisonPopCost = Math.max(0, popCostSum);
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  private async setEnRoutePop(cmd: Command): Promise<CommandResult> {
    const { villageId, popCostSum } = cmd.payload as { villageId: string; popCostSum: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.enRoutePopCost = Math.max(0, popCostSum);
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /** 宝物模块推送的人口增长/金币税倍率（乘数，默认 1）。增长速率(growthRateRaw)/金币税实时读取，无需重算。 */
  private async setTreasureGrowthMult(cmd: Command): Promise<CommandResult> {
    const { villageId, mult, goldMult, growthSources, goldSources } = cmd.payload as { villageId: string; mult: number; goldMult?: number; growthSources?: GrowthSource[]; goldSources?: GrowthSource[] };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.treasureGrowthMult = Number.isFinite(mult) && mult > 0 ? mult : 1;
    if (goldMult !== undefined) s.treasureGoldMult = Number.isFinite(goldMult) && goldMult > 0 ? goldMult : 1;
    if (Array.isArray(growthSources)) s.treasureGrowthSources = growthSources;
    if (Array.isArray(goldSources)) s.treasureGoldSources = goldSources;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /** 科研模块推送的人口增长倍率（乘数，默认 1）。与 treasure 倍率独立叠乘。 */
  private async setTechGrowthMult(cmd: Command): Promise<CommandResult> {
    const { villageId, mult, sources } = cmd.payload as { villageId: string; mult: number; sources?: GrowthSource[] };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.techGrowthMult = Number.isFinite(mult) && mult > 0 ? (1 + mult) : 1;
    if (Array.isArray(sources)) s.techGrowthSources = sources;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  private async setReputationGrowthMult(cmd: Command): Promise<CommandResult> {
    const { villageId, mult, sources } = cmd.payload as { villageId: string; mult: number; sources?: GrowthSource[] };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.reputationGrowthMult = Number.isFinite(mult) && mult > 0 ? mult : 1;
    if (Array.isArray(sources)) s.reputationGrowthSources = sources;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /** 声望模块推送的金币税收倍率（乘数，默认 1；正声望会降低税收）。 */
  private async setReputationGoldTaxMult(cmd: Command): Promise<CommandResult> {
    const { villageId, mult, sources } = cmd.payload as { villageId: string; mult: number; sources?: GrowthSource[] };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.reputationGoldTaxMult = Number.isFinite(mult) && mult > 0 ? mult : 1;
    if (Array.isArray(sources)) s.reputationGoldSources = sources;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /** 全民皆兵科技：提升动员上限比例（加法）。mobilizeCap = base + bonus。 */
  private async setConscriptionMult(cmd: Command): Promise<CommandResult> {
    const { villageId, bonus } = cmd.payload as { villageId: string; bonus: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.conscriptionBonus = Number.isFinite(bonus) ? bonus : 0;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /** 任务奖励直接增加平民人口；人口仍受当前村可用人口上限约束。 */
  private async grantPopulation(cmd: Command): Promise<CommandResult> {
    const { villageId, amount } = cmd.payload as { villageId: string; amount: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const requested = Math.max(0, Math.floor(Number(amount) || 0));
    if (requested <= 0) return { ok: true, payload: { requested: 0, applied: 0 } };
    await this.settle(s);
    const available = Math.max(0, this.popCeiling(s) - s.currentPop);
    const applied = Math.min(requested, Math.floor(available));
    if (applied <= 0) return { ok: true, payload: { requested, applied: 0 } };
    s.currentPop += applied;
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);
    await this.bus.emit({
      name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
      payload: { ...this.publicPayload(s), event: 'reward', delta: applied },
    } as DomainEvent);
    return { ok: true, payload: { requested, applied } };
  }

  /** 任务奖励提供临时人口增长倍率；到期由 Scheduler 清理，重启后 resume 会恢复剩余计时。 */
  private async applyTaskGrowthBuff(cmd: Command): Promise<CommandResult> {
    const { villageId, percent, durationSec } = cmd.payload as { villageId: string; percent: number; durationSec: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const pct = Number(percent);
    const duration = Math.floor(Number(durationSec));
    if (!Number.isFinite(pct) || pct <= 0 || !Number.isFinite(duration) || duration <= 0) {
      return { ok: false, payload: {}, reason: 'invalid_growth_buff' };
    }
    await this.settle(s);
    const expiresAt = this.now() + duration * 1000;
    s.taskGrowthMult = 1 + pct / 100;
    s.taskGrowthBuffExpiresAt = expiresAt;
    this.store.set(COLLECTION, villageId, s);
    this.scheduleTaskGrowthExpiry(villageId, expiresAt);
    return { ok: true, payload: { percent: pct, durationSec: duration, expiresAt } };
  }

  private scheduleTaskGrowthExpiry(villageId: string, expiresAt: number): void {
    const owner = `population:task-growth:${villageId}`;
    this.scheduler.cancelByOwner(owner);
    this.scheduler.schedule(
      Math.max(0, expiresAt - this.now()),
      () => { void this.expireTaskGrowthBuff(villageId, expiresAt); },
      owner,
      `village:${villageId}`,
    );
  }

  private async expireTaskGrowthBuff(villageId: string, expiresAt: number): Promise<void> {
    const s = this.load(villageId);
    if (!s || s.taskGrowthBuffExpiresAt !== expiresAt) return;
    await this.settle(s);
    s.taskGrowthMult = 1;
    s.taskGrowthBuffExpiresAt = undefined;
    this.store.set(COLLECTION, villageId, s);
    await this.bus.emit({
      name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
      payload: { ...this.publicPayload(s), event: 'taskGrowthExpired' },
    } as DomainEvent);
  }
}

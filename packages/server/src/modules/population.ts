import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Population（人口）v3 — 硬上限模型
 * 对应设计文档 13/14（「硬上限重做」章节）
 *
 * v3 核心机制：
 *  A. 硬上限 hardCap = Σ 建筑 popCapPerLevel × level（由 building.GetPopCap 提供，缓存到 state）。
 *  B. 劳动人口 currentPop（平民）；士兵人口 soldierPop = garrisonPopCost + enRoutePopCost（军事/行军上报）。
 *     availableLabor = hardCap − soldierPop（增长目标 / 拓荒门槛 / 三池口径）。
 *  C. 繁荣度由「平民占总人口比例」驱动（与硬上限解耦，建造/升级不再造成负收益）：
 *       civilFrac = currentPop / (currentPop + soldierPop)   // 平民(劳动)占总人口比例，∈[0,1]
 *       prosperityBonus = clamp(civilFrac / popProsperityFullRatio, 0, 1)   // ≥即满值；再乘拥挤惩罚
 *       prosperityMult  = popLaborFloor + (1 − popLaborFloor) × prosperityBonus   // ∈ [popLaborFloor, 1.0]
 *     五条速率轴（资源产出 / 研究 / 练兵 / 锻造 / 建造）统一消费 prosperityMult。
 *  D. 增长 growthPerHour = main.popGrowthPerLevel × mainLevel，朝 availableLabor 收敛（currentPop 已达则不再增长）。
 *     速率绑在城镇中心上（GM 面板可调）；旧版全局常数 popGrowthPerHour 已废弃。
 *  E. 开局人口：currentPop = 城镇中心当前等级贡献的 popCap 之和（mainPopCap），其他默认建筑只贡献 hardCap 不贡献人口。
 *  F. 口粮：平民 currentPop × popCropPerLabor /h（source='civilian_pop'）；士兵由 military 以 upkeep 上报（source='troops'）。
 *  G. 战死即时回收：RecoverCasualties 按医院等级比例把死亡士兵人口转回劳动人口，其余永久扣除（无伤兵池 / 无定时器）。
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
  /** 部族（决定各部族最大动员比例 popRaceMobilizeMax，用于限制士兵占总人口上限；不再参与繁荣度计算，繁荣度由平民占比驱动）。 */
  tribe: string;
  /** 饥荒减员任务 id（运行中非空）。 */
  starveTaskId?: string;
  /** 是否处于饥荒（用于快照/事件展示）。 */
  inFamine?: boolean;
  lastTick: number;
}

const COLLECTION = 'population';

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

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

  /** 热重载配置（改 CSV 后调用）。 */
  setConfig(config: GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.commands.register('population.GetSnapshot', (c) => this.getSnapshot(c));
    this.commands.register('population.GetLaborMult', (c) => this.getLaborMult(c));
    this.commands.register('population.ConsumePop', (c) => this.consumePop(c));
    this.commands.register('population.ReturnPop', (c) => this.returnPop(c));
    this.commands.register('population.RecoverCasualties', (c) => this.recoverCasualties(c));
    this.commands.register('population.SetGarrisonPop', (c) => this.setGarrisonPop(c));
    this.commands.register('population.SetEnRoutePop', (c) => this.setEnRoutePop(c));

    // 建筑建造/升级 → 硬上限或主城等级可能变化 → 重算繁荣度并广播
    this.bus.on('building.Built', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.refreshHardCap(villageId);
    });
    this.bus.on('building.Upgraded', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      void this.refreshHardCap(villageId);
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
      if (s.inFamine === undefined) s.inFamine = false;
      if (s.tribe === undefined) s.tribe = 'romans';
      if (s.mainLevel === undefined) s.mainLevel = 1;
      if (s.hardCap === undefined) s.hardCap = 0;

      // 若重启前处于饥荒但任务丢失，重新调度
      if (s.inFamine && !s.starveTaskId) {
        const c = this.config.constants;
        s.starveTaskId = this.scheduler.schedule(
          c.popFamineTickSec * 1000,
          () => this.runStarveTick(s.villageId),
          `population:starve:${s.villageId}`,
          `village:${s.villageId}`,
        );
      }
      this.store.set(COLLECTION, s.villageId, s);
      // 派生硬上限是建筑等级的纯函数，重启时一律从 building 重算（旧存档缺字段也能补全）
      void this.refreshHardCap(s.villageId);
    }
  }

  /**
   * 新村创建：查 building.GetPopCap 得 hardCap + mainLevel + mainPopCap；
   * 开局人口 = 城镇中心当前等级贡献的 popCap 之和（= mainPopCap），其他默认建筑只贡献 hardCap 不贡献人口。
   * 人口随后按 main.popGrowthPerLevel × mainLevel /h 慢慢增长至 hardCap。
   * 必须在 economy/building/military 已初始化之后调用。
   */
  async createVillage(villageId: string, tribe = 'romans'): Promise<void> {
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
      currentPop: mainPopCap,
      hardCap,
      mainLevel,
      garrisonPopCost: 0,
      enRoutePopCost: 0,
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

  private soldierPop(s: PopulationState): number {
    return s.garrisonPopCost + s.enRoutePopCost;
  }

  /** 可用劳动人口 = 硬上限 − 士兵人口（增长目标 / 拓荒门槛）。 */
  private availableLabor(s: PopulationState): number {
    return Math.max(0, s.hardCap - this.soldierPop(s));
  }

  /** 本部族最大动员比例（士兵占总人口上限）：条顿0.80/高卢0.70/罗马0.75。 */
  private mobilizeCap(s: PopulationState): number {
    const rm = this.config.constants.popRaceMobilizeMax;
    return (rm as Record<string, number>)[s.tribe] ?? rm.romans;
  }

  /** 平民（劳动人口）占总人口（平民+士兵）比例；与硬上限解耦，建造/升级不再影响繁荣度。 */
  private laborRatio(s: PopulationState): number {
    const total = s.currentPop + this.soldierPop(s);
    return total > 0 ? s.currentPop / total : 0;
  }

  /**
   * 繁荣度加成 ∈ [0,1]，由「平民占总人口比例」驱动（与硬上限解耦，建造/升级不再造成负收益）：
   *  - civilFrac = currentPop / (currentPop + soldierPop)，∈ [0,1]；平民占比越高越繁荣。
   *  - 达到 popProsperityFullRatio（默认 0.70，即≥70%平民）为满值，低于则线性降到 0。
   *  - 拥挤惩罚（保底）：平民实际超过硬上限（人口超 housing，多在拆房/减员回补瞬态）时，
   *    按 popOvercapPenaltyFullRatio 在 1→2 倍间线性降到 0。正常稳态 currentPop ≤ hardCap−soldierPop，不触发。
   */
  private prosperityBonus(s: PopulationState): number {
    const c = this.config.constants;
    const total = s.currentPop + this.soldierPop(s);
    const civilFrac = total > 0 ? s.currentPop / total : 0;
    const fillBonus = clamp(civilFrac / c.popProsperityFullRatio, 0, 1);
    let overcrowd = 1;
    if (s.hardCap > 0 && s.currentPop > s.hardCap) {
      const overRatio = s.currentPop / s.hardCap;
      const over = clamp((overRatio - 1) / (c.popOvercapPenaltyFullRatio - 1), 0, 1);
      overcrowd = 1 - over;
    }
    return fillBonus * overcrowd;
  }

  /** 五轴统一的繁荣度乘数 ∈ [popLaborFloor, 1.0]。 */
  private prosperityMult(s: PopulationState): number {
    const c = this.config.constants;
    return c.popLaborFloor + (1 - c.popLaborFloor) * this.prosperityBonus(s);
  }

  /** 原始增长速率（每小时，未夹紧到缺口）。速率绑在城镇中心上：main.popGrowthPerLevel × mainLevel（GM 面板可调）。 */
  private growthRateRaw(s: PopulationState): number {
    return (this.config.buildings.main?.popGrowthPerLevel ?? 0) * s.mainLevel;
  }

  /** 每小时实际增长量（已 clamp 到 availableLabor 缺口）。粮荒期间不增长（否则会与减员相互抵消）。 */
  private growthPerHour(s: PopulationState): number {
    if (s.inFamine) return 0;
    const gap = this.availableLabor(s) - s.currentPop;
    return Math.max(0, Math.min(gap, this.growthRateRaw(s)));
  }

  // ── Economy 同步（铁律#4：只上报，不回查软上限）──────────────────────────

  /**
   * 向 economy 上报：① 平民口粮 currentPop × popCropPerLabor（source='civilian_pop'）；
   * ② 五轴繁荣度乘数（source='pop_labor'，mult[res] = prosperityMult − 1）。
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
      payload: { villageId: s.villageId, source: 'pop_labor', mult: rateMult },
    });
  }

  // ── 惰性结算（只补算增长，永不 emit）────────────────────────────────────

  /**
   * 按 Δt 补算人口增长（朝 availableLabor 收敛）。不返回 context、不 emit
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

    const avail = this.availableLabor(s);
    // 粮荒期间不增长（减员路径由 runStarveTick 独占），避免与减员相互抵消导致人口卡在平衡点。
    if (!s.inFamine && s.currentPop < avail) {
      const grow = Math.min(avail - s.currentPop, this.growthRateRaw(s) * dtHours);
      s.currentPop = Math.min(avail, s.currentPop + grow);
    }
    s.currentPop = Math.max(0, s.currentPop);

    // 交税：仅劳动人口(currentPop)按税率交金币，绑定城镇中心、不受繁荣度影响。
    // 单向 Grant 到 economy（不读回，无环）；与资源惰性结算同节奏，按 Δt 累加。
    const goldGained = s.currentPop * c.goldTaxPerCivilianPerHour * dtHours;
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
    const avail = this.availableLabor(s);
    const ratio = this.laborRatio(s);
    const bonus = this.prosperityBonus(s);
    const mult = this.prosperityMult(s);
    const growth = this.growthPerHour(s);
    return {
      villageId: s.villageId,
      currentPop: Math.floor(s.currentPop),
      soldierPop: Math.floor(soldierPop),
      hardCap: Math.floor(s.hardCap),
      availableLabor: Math.floor(avail),
      // 兼容别名：movement.ts 拓荒门槛仍读 softLimit，等于 availableLabor
      softLimit: Math.floor(avail),
      laborRatio: Math.round(ratio * 100) / 100,
      prosperityBonus: Math.round(bonus * 100) / 100,
      prosperityMult: Math.round(mult * 100) / 100,
      growthPerHour: Math.round(growth),
      /** 原始增长速率（未夹紧到硬上限缺口）：达上限时仍展示人口流动潜力。 */
      potentialGrowthPerHour: Math.round(this.growthRateRaw(s)),
      /** 本部族最大动员比例（士兵占总人口上限）；用于前端展示/校验。 */
      mobilizeCap: this.mobilizeCap(s),
      /** 繁荣度满值阈值（平民占总人口比例 ≥此值时 prosperityBonus=1）；面板文案使用。 */
      popProsperityFullRatio: c.popProsperityFullRatio,
      mainLevel: s.mainLevel,
      inFamine: !!s.inFamine,
      civilianCropPerHour: Math.round(s.currentPop * c.popCropPerLabor * 10) / 10,
      /** 每小时金币产量（仅劳动人口交税，绑定城镇中心，不受繁荣度影响）。供资源条展示金币速率。 */
      goldPerHour: Math.round(s.currentPop * c.goldTaxPerCivilianPerHour),
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
  private async computeDeficit(s: PopulationState): Promise<boolean> {
    const c = this.config.constants;
    const cropRes = await this.commands.send({
      name: 'economy.GetCropContext', from: PopulationModule.NAME,
      payload: { villageId: s.villageId },
    });
    const baseCropPerHour: number = (cropRes.payload as any)?.baseCropPerHour ?? 0;
    const nonCivilianUpkeep: number = (cropRes.payload as any)?.nonCivilianUpkeep ?? 0;
    const currentCrop: number = (cropRes.payload as any)?.currentCrop ?? 0;
    const mult = this.prosperityMult(s);
    const civilianCrop = s.currentPop * c.popCropPerLabor;
    const netCropRatePerHour = baseCropPerHour * mult - nonCivilianUpkeep - civilianCrop;
    return currentCrop <= 0 && netCropRatePerHour < 0;
  }

  /**
   * 饥荒减员 tick：唯一可执行减员并 emit 的路径（铁律：settle 永不 emit）。
   * 减员公式（指数解析）：reduced = currentPop × (1 − exp(−popDeathRateFactor × dtHours))。
   * 退出赤字则发 'recovery' 并停止；仍在赤字则续排。
   */
  private async runStarveTick(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    s.starveTaskId = undefined;

    await this.reportToEconomy(s);

    if (!(await this.computeDeficit(s))) {
      const wasInFamine = s.inFamine;
      s.inFamine = false;
      this.store.set(COLLECTION, villageId, s);
      if (wasInFamine) {
        await this.bus.emit({
          name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
          payload: { ...this.publicPayload(s), event: 'recovery' },
        } as DomainEvent);
      }
      return;
    }

    const c = this.config.constants;
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
    if (s.currentPop > 0 && (await this.computeDeficit(s))) {
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
      smithy: mult,
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

  /** 繁荣度乘数（v3 五轴统一；kind 参数保留兼容，不再区分）。 */
  private getLaborMult(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: true, payload: { mult: 1.0 } };
    return { ok: true, payload: { mult: this.prosperityMult(s) } };
  }

  /** 训练扣劳动人口。不足则拒绝（不改动状态）。 */
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

    // 动员上限：士兵占总人口比例不得超过本部族 popRaceMobilizeMax（条顿0.80/高卢0.70/罗马0.75）。
    // 训练把平民(popCost)转为士兵，总人口(currentPop+soldierPop)守恒，故只需校验转化后士兵占比。
    const soldierPop = this.soldierPop(s);
    const totalPop = s.currentPop + soldierPop;
    const maxSoldier = this.mobilizeCap(s) * totalPop;
    if (soldierPop + totalCost > maxSoldier + 1e-9) {
      this.store.set(COLLECTION, villageId, s);
      return { ok: false, payload: {}, reason: 'mobilize_cap_exceeded' };
    }

    s.currentPop -= totalCost;
    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    await this.bus.emit({
      name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
      payload: { ...this.publicPayload(s), event: 'consumed', consumed: totalCost },
    } as DomainEvent);

    return { ok: true, payload: { ok: true, consumed: totalCost } };
  }

  /** 解散/返程归还劳动人口（跳过 popPermanent 单位）。 */
  private async returnPop(cmd: Command): Promise<CommandResult> {
    const { villageId, units } = cmd.payload as { villageId: string; units: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    await this.settle(s);

    let returned = 0;
    for (const [unit, cnt] of Object.entries(units)) {
      if (cnt <= 0) continue;
      const udef = this.config.units[unit];
      if (!udef || udef.popPermanent) continue;
      returned += udef.popCost * cnt;
    }
    s.currentPop += returned;

    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    if (returned > 0) {
      await this.bus.emit({
        name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
        payload: { ...this.publicPayload(s), event: 'returned', returned },
      } as DomainEvent);
    }

    return { ok: true, payload: { ok: true, returned } };
  }

  /**
   * 战死即时回收（替代旧 AddWounded 伤兵池）：按医院等级比例把死亡士兵人口转回劳动人口，
   * 其余永久扣除。死亡士兵已在 military 侧 AdjustTroops 扣掉 → soldierPopCost 自动下降 → availableLabor 上升。
   * popPermanent 单位（拓荒者）死亡不回收人口。
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
      if (udef.popPermanent) {
        // 拓荒者等永久人口：死亡不回收
        permanentDead += deadPop;
        continue;
      }
      const rec = Math.floor(deadPop * recoveryRatio);
      recovered += rec;
      permanentDead += deadPop - rec;
    }

    s.currentPop += recovered;

    await this.reportToEconomy(s);
    this.store.set(COLLECTION, villageId, s);

    if (recovered > 0 || permanentDead > 0) {
      await this.bus.emit({
        name: 'population.Changed', source: PopulationModule.NAME, ts: this.now(),
        payload: { ...this.publicPayload(s), event: 'recovered', recovered, permanentDead },
      } as DomainEvent);
    }

    return { ok: true, payload: { ok: true, recovered, permanentDead } };
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
}

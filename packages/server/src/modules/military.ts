import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, UnitDef } from '../infra/config.js';

/**
 * 领域模块 · Military（军队/兵种）
 * 对应设计文档 02_系统清单C组、10_兵种特性效果表、07_扩展与代码规范
 *
 * 职责：每村兵力数量、训练队列与军事科技派生快照的 owner。
 * 兵种数据来自 GameConfig（config/units.csv）——改 CSV 即改兵种/加部族。
 * 不直接改资源——训练时向 Economy 发 TrySpend 扣费（状态归属唯一）。
 *
 * 训练队列：逐个产出（每 trainSec 出 1 个），资源一次性预扣。
 */

export type { UnitDef };

interface TrainOrder {
  unit: string;
  /** 所属军事建筑实例 slotId（多实例并行训练的关键标识）。 */
  slotId: string;
  remaining: number; // 还要出几个
  nextDoneAt: number; // 下一个出兵的时刻
  taskId: string;
  /** 每个兵的实际训练时长(ms)，含人口加速与建筑等级提速（训练开始时快照，整批一致）。 */
  trainMsEach: number;
  /** 训练开始时快照的单兵资源成本；取消时仅退还尚未产出的兵。 */
  costPerUnit?: Record<string, number>;
}

interface TrainerSlot {
  slotId: string;
  kind: string;
  level: number;
}

interface MilitaryState {
  villageId: string;
  /** 该村种族，决定可训练哪些兵种 */
  tribe: string;
  /** 驻村兵力：兵种 -> 数量 */
  troops: Record<string, number>;
  /** 掠夺防守配置；未设置的旧存档按“全军防守”兼容。 */
  raidDefense?: { enabled: boolean; troops: Record<string, number> };
  /** 在途（行军/出征中）兵力：兵种 -> 数量，由 movement 模块推送；仍计入口粮消耗。 */
  marching?: Record<string, number>;
  /** 旧版单条训练队列（仅用于兼容旧存档；新训练一律走 trainingBySlot）。 */
  training: TrainOrder | null;
  /** 逐建筑实例训练队列：slotId -> 该建筑的独立训练队列（多实例并行训练）。 */
  trainingBySlot: Record<string, TrainOrder>;
  /** 宝物军事倍率（乘数，默认 1；由 treasure 模块推送，无环）：攻/防分别作用。 */
  treasureAtkMult?: number;
  treasureDefMult?: number;
  /** 科研攻击倍率（由 research 模块推送，叠加在宝物之上）。 */
  techAtkMult?: number;
  /** 科研防御倍率（由 research 模块推送，叠加在宝物之上）。 */
  techDefMult?: number;
  techCombatByUnit?: Record<string, { atk: number; def: number }>;
  techUnlockedUnits?: string[];
  techTrainSpeed?: number;
  /** 科技行军速度加成（加性百分比，已按 research cap 聚合）。 */
  techMarchSpeed?: number;
  /** 宝物骑兵训练加速倍率（默认 1；伯乐提供，training time 乘此值）。 */
  treasureCavalryTrainMult?: number;
  /** 精神食粮减粮（每兵每小时减免的绝对 crop 值，加性；默认 0）。 */
  treasureFoodReduce?: number;
}

const COLLECTION = 'military';
/** 旧版单队列的内部键；绝不直接作为公网 queueId 下发。 */
const LEGACY_QUEUE_KEY = 'legacy-training';

/** 骑兵兵种 code（伯乐翻倍/加速作用范围）。 */
const CAVALRY_CODES = ['equlegati', 'equimperatoris', 'equcaesaris', 'theutates', 'druidrider', 'haeduan', 'paladin', 'teutonknight'];

export class MilitaryModule {
  static readonly NAME = 'military';

  /**
   * 运行期的公网队列句柄。内部 slotId 属于 Building 的实现细节，不能越过
   * Military 边界；重启后允许重新发号，因此无需也不得写入存档。
   */
  private readonly publicQueueIds = new Map<string, string>();
  private readonly internalQueueKeys = new Map<string, { villageId: string; internalKey: string }>();
  private nextPublicQueueId = 0;
  /** 训练建筑的运行期不透明句柄；客户端只能用它选择本村建筑，不能伪造任意 slotId。 */
  private readonly publicTrainerIds = new Map<string, string>();
  private readonly internalTrainerKeys = new Map<string, { villageId: string; internalKey: string }>();
  private nextPublicTrainerId = 0;


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

  /** 宝物军事倍率（由 treasure 模块推送，无环）：攻/防分别作用。 */
  private setTreasureCombatMult(cmd: Command): CommandResult {
    const { villageId, atkMult, defMult } = cmd.payload as { villageId: string; atkMult: number; defMult: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.treasureAtkMult = atkMult > 0 ? atkMult : 1;
    s.treasureDefMult = defMult > 0 ? defMult : 1;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { atkMult: s.treasureAtkMult, defMult: s.treasureDefMult } };
  }

  /** 科研攻击/防御倍率（research 模块推送，独立叠加在宝物倍率之上）。 */
  private async setTechCombatMult(cmd: Command): Promise<CommandResult> {
    const { villageId, atkMult, defMult } = cmd.payload as { villageId: string; atkMult: number; defMult: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    if (atkMult > 0) s.techAtkMult = 1 + atkMult;
    if (defMult > 0) s.techDefMult = 1 + defMult;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  private setTechEffects(cmd: Command): CommandResult {
    const { villageId, combat, unlocks, trainSpeed } = cmd.payload as {
      villageId: string; combat: Record<string, { atk: number; def: number }>;
      unlocks: string[]; trainSpeed: number;
    };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.techCombatByUnit = combat ?? {};
    s.techUnlockedUnits = Array.isArray(unlocks) ? [...new Set(unlocks)] : [];
    s.techTrainSpeed = Math.max(0, Math.min(0.9, Number(trainSpeed) || 0));
    s.techMarchSpeed = Math.max(0, Math.min(0.9, Number((cmd.payload as any).marchSpeed) || 0));
    // 清掉旧覆盖，避免旧档的最后完成科技继续生效。
    s.techAtkMult = 1;
    s.techDefMult = 1;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /** 行军模块只可取得已聚合的最终最慢速度快照，不能读取军事状态。 */
  private getMarchSpeedSnapshot(cmd: Command): CommandResult {
    const { villageId, troops } = cmd.payload as { villageId: string; troops: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const units = Object.keys(troops ?? {}).filter((unit) => (troops[unit] ?? 0) > 0 && this.config.units[unit]);
    if (units.length === 0) return { ok: false, payload: {}, reason: 'empty_troops' };
    const bonus = 1 + (s.techMarchSpeed ?? 0);
    const slowest = Math.min(...units.map((unit) => this.config.units[unit].speed * bonus));
    return { ok: true, payload: { slowestSpeed: slowest } };
  }

  private units(): Record<string, UnitDef> {
    return this.config.units;
  }

  init(): void {
    this.commands.register('military.GetArmy', (c) => this.getArmy(c));
    this.commands.register('military.TrainTroops', (c) => this.trainTroops(c));
    this.commands.register('military.CancelTraining', (c) => this.cancelTraining(c));
    this.commands.register('military.DisbandTroops', (c) => this.disbandTroops(c));
    // 供 Combat/Movement 取"参战快照"：对外只给算好的最终三维（派生管线对外口径）
    this.commands.register('military.GetCombatSnapshot', (c) => this.getCombatSnapshot(c));
    this.commands.register('military.SetRaidDefense', (c) => this.setRaidDefense(c));
    // 增减驻村兵力（行军出征扣出、返程/训练完成加入），由 Movement 等调用
    this.commands.register('military.AdjustTroops', (c) => this.adjustTroops(c));
    // 在途（行军）兵力快照：由 Movement 汇总推送，仅用于计入粮耗（不影响驻村兵力/动员）。
    this.commands.register('military.SetMarchingTroops', (c) => this.setMarchingTroops(c));
    // 祭祀台等消耗型效果：按 popCost 升序移除驻村士兵直到满足人口缺口（允许超扣）。
    this.commands.register('military.SacrificeTroops', (c) => this.sacrificeTroops(c));
    // 雇佣兵：把雇佣兵永久写入 troops（popCost=0/upkeep=0 → 自动零副作用、自动参战）。
    this.commands.register('military.AddMercenaries', (c) => this.addMercenaries(c));
    this.commands.register('military.RemoveMercenaries', (c) => this.removeMercenaries(c));
    // 宝物军事倍率（攻/防分别作用），由 treasure 模块推送，无环。
    this.commands.register('military.SetTreasureCombatMult', (c) => this.setTreasureCombatMult(c));
    this.commands.register('military.SetTechCombatMult', (c) => this.setTechCombatMult(c));
    this.commands.register('military.SetTechEffects', (c) => this.setTechEffects(c));
    this.commands.register('military.GetMarchSpeedSnapshot', (c) => this.getMarchSpeedSnapshot(c));
    // 伯乐：骑兵训练加速倍率 + 使用后翻倍骑兵
    this.commands.register('military.SetTreasureCavalryTrainMult', (c) => this.setTreasureCavalryTrainMult(c));
    this.commands.register('military.DuplicateCavalry', (c) => this.duplicateCavalry(c));
    // 精神食粮：每兵粮耗减免
    this.commands.register('military.SetTreasureFoodReduce', (c) => this.setTreasureFoodReduce(c));

    // 极端饥荒逃兵：订阅 economy.CropDeficit 事件，扣除驻军（不返还人口，避免同步环）
    this.bus.on('economy.CropDeficit', (evt: DomainEvent) => {
      const { villageId } = evt.payload as { villageId: string };
      this.onCropDeficit(villageId);
    });
  }

  /**
   * 重启恢复：每个村庄状态都上报驻军维护和人口（不论是否在训练）；
   * 然后为进行中的训练重新登记出兵任务。
   * 修复：旧版 if (!s.training) continue 会跳过所有无训练的驻军，导致
   * reportUpkeep/reportGarrisonPop 从未被调用，economy 中 troops/soldier_pool 归零。
   */
  resume(): void {
    for (const s of this.store.all<MilitaryState>(COLLECTION)) {
    // 每个 state 都必须上报（包含无训练的驻村）
    this.reportUpkeep(s);
    this.reportGarrisonPop(s);

    s.trainingBySlot = s.trainingBySlot || {};
    // 宝物军事倍率迁移默认值（旧存档缺省置 1，无倍率）。
    if (s.treasureAtkMult === undefined) s.treasureAtkMult = 1;
    if (s.treasureDefMult === undefined) s.treasureDefMult = 1;
    if (s.techAtkMult === undefined) s.techAtkMult = 1;
    if (s.techDefMult === undefined) s.techDefMult = 1;
    if (s.treasureCavalryTrainMult === undefined) s.treasureCavalryTrainMult = 1;
    if (s.treasureFoodReduce === undefined) s.treasureFoodReduce = 0;
    // 旧档案兼容：trainMsEach 缺失时回退到 def.trainSec；逐建筑队列 + 旧单队列都重新登记出兵任务。
    const scheduleOrder = (order: TrainOrder | null, slotId?: string) => {
      if (!order) return;
      if (!order.trainMsEach) {
        order.trainMsEach = (this.config.units[order.unit]?.trainSec ?? 30) * 1000;
      }
      const delay = Math.max(0, order.nextDoneAt - this.now());
      order.taskId = this.scheduler.schedule(
        delay,
        () => this.produceOne(s.villageId, slotId),
        `military:${s.villageId}`,
        `village:${s.villageId}`,
      );
    };
    scheduleOrder(s.training); // 旧单队列（迁移前兼容，无 slotId）
    for (const [slotId, order] of Object.entries(s.trainingBySlot)) scheduleOrder(order, slotId);
    this.store.set(COLLECTION, s.villageId, s);
  }

  }

  createVillage(villageId: string, tribe = 'romans'): void {
    const s: MilitaryState = {
      villageId,
      tribe,
      troops: {},
      training: null,
      trainingBySlot: {},
    };
    this.store.set(COLLECTION, villageId, s);
  }

  private load(villageId: string): MilitaryState | undefined {
    return this.store.get<MilitaryState>(COLLECTION, villageId);
  }

  /**
   * 计算驻军总耗粮(每小时)并上报 Economy。
   *  - source='troops'：军晌（unit.upkeep，纯口粮消耗）。
   *  - source='soldier_pop'：v4 解耦后士兵不再占人口、不再吃人口粮，恒为 0（此处显式置 0 以覆盖旧存档残留值）。
   *  两来源均属"非平民"，纳入 nonCivilianUpkeep，参与粮荒判定。
   *  v5 起：训练队列中的士兵亦按 unit.upkeep 计入口粮（训练中已在吃粮，UI 也按 +1/h 显示）。
   *        一次性预扣的 costCrop 是训练费，养兵费是另一口径，叠加不冲突。
   */
  private reportUpkeep(s: MilitaryState): void {
    // v5b：每个兵的耗粮 = 默认口粮(popCost×popCropPerLabor，与平民同源) + 军晌(popCost×upkeep)。
    // 旧模型只算 upkeep、训练时平民那份口粮被"释放"；新模型士兵保留平民口粮再叠加 upkeep，
    // 即"每个兵默认1耗粮 + 1军晌"（popCost=1 的标准兵）。佣兵 popCost=0 自动零副作用。
    const base = this.config.constants.popCropPerLabor;
    let ration = 0; // 军晌（默认口粮 + upkeep，含精神食粮减免）
    for (const [unit, n] of Object.entries(s.troops)) {
      ration += this.foodPerSoldier(unit, s, base) * n;
    }
    // 在途（行军）部队同样耗粮（出征不减免口粮）。
    for (const [unit, n] of Object.entries(s.marching ?? {})) {
      ration += this.foodPerSoldier(unit, s, base) * n;
    }
    // 训练队列：每个未产出的兵也按 foodPerSoldier 计入（即便尚未入 troops）。
    if (s.training) {
      ration += this.foodPerSoldier(s.training.unit, s, base) * s.training.remaining;
    }
    for (const order of Object.values(s.trainingBySlot || {})) {
      ration += this.foodPerSoldier(order.unit, s, base) * order.remaining;
    }
    void this.commands.send({
      name: 'economy.SetUpkeep',
      from: MilitaryModule.NAME,
      payload: { villageId: s.villageId, source: 'troops', cropPerHour: ration },
    });
    // v4：士兵不占人口，故 soldier_pop 基础人口粮恒为 0（显式上报以清掉历史残留值）。
    void this.commands.send({
      name: 'economy.SetUpkeep',
      from: MilitaryModule.NAME,
      payload: { villageId: s.villageId, source: 'soldier_pop', cropPerHour: 0 },
    });
  }

  /**
   * 上报驻军人口权重总量给 Population（三池口粮·士兵池，v2 设计 G）。
   * 兵力变化后调用（与 reportUpkeep 配对）。Population 据此计算 soldier_pool 耗粮。
   */
  private reportGarrisonPop(s: MilitaryState): void {
    let popCostSum = 0;
    for (const [unit, n] of Object.entries(s.troops)) {
      popCostSum += (this.config.units[unit]?.popCost ?? 0) * n;
    }
    void this.commands.send({
      name: 'population.SetGarrisonPop',
      from: MilitaryModule.NAME,
      payload: { villageId: s.villageId, popCostSum },
    });
  }

  /**
   * 极端饥荒逃兵（v2 设计 E·闭环）：CropDeficit 边沿触发，按比例扣除驻军。
   * 不向 population.ReturnPop（逃兵不回补 currentPop，避免同步环）。
   * 扣兵后同步更新 upkeep 与 garrisonPop，让 economy 减少消耗，有助于退出赤字。
   */
  private onCropDeficit(villageId: string): void {
    const s = this.load(villageId);
    if (!s) return;
    // 逃兵率：10%驻军；若驻军为空则直接返回
    const desertRatio = 0.10;
    let anyDeserted = false;
    for (const unit of Object.keys(s.troops)) {
      const have = s.troops[unit] ?? 0;
      if (have <= 0) continue;
      // 雇佣兵(popCost=0)永久拥有，灾荒不逃兵——避免玩家花金币买的兵被饥荒清掉。
      if ((this.config.units[unit]?.popCost ?? 0) <= 0) continue;
      const desert = Math.max(1, Math.floor(have * desertRatio));
      s.troops[unit] = have - desert;
      if (s.troops[unit] <= 0) delete s.troops[unit];
      anyDeserted = true;
    }
    if (!anyDeserted) return;
    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);
    this.reportGarrisonPop(s); // 同步更新士兵池口粮（不返还人口）
  }

  /** 派生管线：最终数值 = 基础 × 科技/宝物倍率。对外只暴露最终结果快照。 */
  private finalStats(unit: string, atkMult = 1, defMult = 1) {
    const def = this.config.units[unit];
    return {
      form: def.form,
      meleeAtk: def.meleeAtk * atkMult,
      rangedAtk: def.rangedAtk * atkMult,
      meleeDef: def.meleeDef * defMult,
      rangedDef: def.rangedDef * defMult,
      speed: def.speed,
      carry: def.carry,
      upkeep: def.upkeep,
      isCavalry: this.config.constants.cavalryUnitCodes.includes(unit),
      traits: def.traits.flatMap((tc) => {
        const t = this.config.unitTraits[tc];
        return t.effects;
      }),
    };
  }

  private techCombatMult(s: MilitaryState, unit: string): { atk: number; def: number } {
    const all = s.techCombatByUnit?.all;
    const own = s.techCombatByUnit?.[unit];
    const form = this.config.units[unit]?.form;
    const byForm = form ? s.techCombatByUnit?.[`form:${form}`] : undefined;
    return {
      atk: 1 + (all?.atk ?? 0) + (byForm?.atk ?? 0) + (own?.atk ?? 0),
      def: 1 + (all?.def ?? 0) + (byForm?.def ?? 0) + (own?.def ?? 0),
    };
  }

  private needsTechUnlock(unit: string): boolean {
    return Object.values(this.config.research).some((t) => t.effects.some((e) => e.effectType === 'unit_unlock' && e.effectKey === unit));
  }

  // ---- Commands ----

  /** 解析本村建筑布局。建筑状态仍归 Building owner，Military 只取得快照。 */
  private async resolveLayout(villageId: string): Promise<{ slots: TrainerSlot[]; kindLevels: Map<string, number> }> {
    try {
      const res = await this.commands.send({ name: 'building.GetLayout', from: MilitaryModule.NAME, payload: { villageId } });
      if (!res.ok) return { slots: [], kindLevels: new Map() };
      const layout = res.payload as any;
      const slots: TrainerSlot[] = [];
      const kindLevels = new Map<string, number>();
      const add = (slotId: string, kind: string, level: number) => {
        slots.push({ slotId, kind, level });
        kindLevels.set(kind, Math.max(kindLevels.get(kind) ?? 0, level));
      };
      const tc = layout.townCenter;
      if (tc) add(tc.slotId, tc.kind, tc.level);
      for (const zone of ['inner', 'outer'] as const) {
        for (const p of (layout.zones?.[zone]?.placed || []) as any[]) add(p.slotId, p.kind, p.level);
      }
      return { slots, kindLevels };
    } catch {
      return { slots: [], kindLevels: new Map() };
    }
  }

  /** 军事建筑每级训练提速系数：Σ building_levels.trainTimeReducePerLevel，下限保护避免归零。 */
  private trainTimeFactor(level: number, buildingKind: string): number {
    const c = this.config.constants;
    const def = this.config.buildings[buildingKind];
    let totalReduce = 0;
    for (let lv = 1; lv <= level; lv++) {
      totalReduce += def?.levels[lv]?.trainTimeReducePerLevel ?? (lv === 1 ? 0 : c.trainTimeReducePerLevel);
    }
    const f = 1 - Math.min(c.trainTimeReduceCap, totalReduce);
    return Math.max(0.05, f);
  }

  /** 军事建筑每级训练降费系数：Σ building_levels.trainCostReducePerLevel，下限保护避免归零。 */
  private trainCostFactor(level: number, buildingKind: string): number {
    const c = this.config.constants;
    const def = this.config.buildings[buildingKind];
    let totalReduce = 0;
    for (let lv = 1; lv <= level; lv++) {
      totalReduce += def?.levels[lv]?.trainCostReducePerLevel ?? (lv === 1 ? 0 : c.trainCostReducePerLevel);
    }
    const f = 1 - Math.min(c.trainCostReduceCap, totalReduce);
    return Math.max(0.05, f);
  }

  /** 按建筑等级计算某兵种的实际资源消耗（逐资源四舍五入，最低 1）。 */
  private effectiveCost(base: Record<string, number>, level: number, buildingKind: string): Record<string, number> {
    const f = this.trainCostFactor(level, buildingKind);
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(base)) out[k] = Math.max(1, Math.round(v * f));
    return out;
  }

  /** 同类建筑的稳定顺序：高等级优先；同等级按 slotId 排序，避免同一快照下随机选队列。 */
  private sortTrainerSlots(slots: TrainerSlot[]): TrainerSlot[] {
    return [...slots].sort((a, b) => b.level - a.level || a.slotId.localeCompare(b.slotId));
  }

  /** 已建成、可训练指定兵种的建筑实例。 */
  private trainerSlotsFor(slots: TrainerSlot[], unit: string): TrainerSlot[] {
    const building = this.config.units[unit]?.building;
    return this.sortTrainerSlots(slots.filter((slot) => slot.kind === building && slot.level >= 1));
  }

  /**
   * 旧单队列没有 slotId。为保持其继续训练及不与同一训练建筑超卖并行，
   * 按当前稳定选址规则虚拟占用一个实例；新建队列仍只写 trainingBySlot。
   */
  private legacyReservedSlot(s: MilitaryState, slots: TrainerSlot[], unit: string): string | undefined {
    if (!s.training || this.config.units[s.training.unit]?.building !== this.config.units[unit]?.building) return undefined;
    return this.trainerSlotsFor(slots, unit)[0]?.slotId;
  }

  private queueMapKey(villageId: string, internalKey: string): string {
    return `${villageId}\u0000${internalKey}`;
  }

  /** 返回当前进程稳定、对外不透明的队列 id。 */
  private publicQueueId(villageId: string, internalKey: string): string {
    const mapKey = this.queueMapKey(villageId, internalKey);
    const existing = this.publicQueueIds.get(mapKey);
    if (existing) return existing;
    const queueId = `military-queue-${++this.nextPublicQueueId}`;
    this.publicQueueIds.set(mapKey, queueId);
    this.internalQueueKeys.set(queueId, { villageId, internalKey });
    return queueId;
  }

  /** 外部 queueId 只能反查本村当前进程已签发的队列，不能伪造 slotId。 */
  private internalQueueKey(villageId: string, queueId: string): string | undefined {
    const entry = this.internalQueueKeys.get(queueId);
    return entry?.villageId === villageId ? entry.internalKey : undefined;
  }

  private forgetPublicQueueId(villageId: string, internalKey: string): void {
    const mapKey = this.queueMapKey(villageId, internalKey);
    const queueId = this.publicQueueIds.get(mapKey);
    if (!queueId) return;
    this.publicQueueIds.delete(mapKey);
    this.internalQueueKeys.delete(queueId);
  }

  private trainerMapKey(villageId: string, internalKey: string): string {
    return `${villageId}\u0000${internalKey}`;
  }

  /** 返回当前进程稳定、对外不透明的训练建筑 id。 */
  private publicTrainerId(villageId: string, internalKey: string): string {
    const mapKey = this.trainerMapKey(villageId, internalKey);
    const existing = this.publicTrainerIds.get(mapKey);
    if (existing) return existing;
    const id = `military-building-${++this.nextPublicTrainerId}`;
    this.publicTrainerIds.set(mapKey, id);
    this.internalTrainerKeys.set(id, { villageId, internalKey });
    return id;
  }

  /** 仅允许反查当前村、当前进程签发的训练建筑句柄。 */
  private internalTrainerKey(villageId: string, publicId: string): string | undefined {
    const entry = this.internalTrainerKeys.get(publicId);
    return entry?.villageId === villageId ? entry.internalKey : undefined;
  }

  /** Military owner 选取可用训练队列：空闲最高等级，同级 slotId 稳定排序。 */
  private selectTrainSlot(s: MilitaryState, slots: TrainerSlot[], unit: string): TrainerSlot | undefined {
    const legacyReserved = this.legacyReservedSlot(s, slots, unit);
    return this.trainerSlotsFor(slots, unit).find((slot) =>
      !s.trainingBySlot[slot.slotId] && slot.slotId !== legacyReserved,
    );
  }

  /** 某兵种是否为骑兵（伯乐效果作用范围）。 */
  private isCavalry(unitCode: string): boolean {
    return CAVALRY_CODES.includes(unitCode);
  }

  /** 宝物骑兵训练加速（伯乐）：training time 乘此倍率。 */
  private setTreasureCavalryTrainMult(cmd: Command): CommandResult {
    const { villageId, mult } = cmd.payload as { villageId: string; mult: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.treasureCavalryTrainMult = Number.isFinite(mult) ? mult : 1;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: {} };
  }

  /** 精神食粮：每兵粮耗减免绝对值（加性，remove 时 reduce=0 自动归零）。 */
  private setTreasureFoodReduce(cmd: Command): CommandResult {
    const { villageId, reduce } = cmd.payload as { villageId: string; reduce: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.treasureFoodReduce = Number.isFinite(reduce) ? Math.max(0, reduce) : 0;
    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);
    return { ok: true, payload: {} };
  }

  /**
   * 每兵每小时口粮消耗（含精神食粮减免）。
   * 关键：减免是「绝对值」——减在「已乘完 popCost 的总量」上，绝不动被乘数 upkeep（否则会被 popCost 放大，popCost>1 立刻爆雷）。
   * 下限 = (base+1)*popCost（军晌降到 1 的水平；upkeep≤1 的兵不再减）。
   */
  private foodPerSoldier(unitCode: string, s: MilitaryState, base: number): number {
    const def = this.config.units[unitCode];
    const popCost = def?.popCost ?? 1;
    const upkeep = def?.upkeep ?? 0;
    const raw = (base + upkeep) * popCost;
    const floor = (base + 1) * popCost;
    const reduce = s.treasureFoodReduce ?? 0;
    return Math.max(floor, raw - reduce);
  }

  /** 伯乐使用效果：消耗资源和劳动人口，以当前骑兵为限等比例翻倍。不足则按比例缩减。 */
  private async duplicateCavalry(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    // 计算翻倍总成本（资源 + 人口）
    const totalCost: Record<string, number> = {};
    let totalPopCost = 0;
    const current: Record<string, number> = {};
    for (const code of CAVALRY_CODES) {
      const def = this.config.units[code];
      const cnt = s.troops[code] ?? 0;
      if (cnt <= 0 || !def) continue;
      current[code] = cnt;
      for (const [r, amt] of Object.entries(def.cost)) totalCost[r] = (totalCost[r] ?? 0) + amt * cnt;
      totalPopCost += (def.popCost ?? 0) * cnt;
    }
    if (Object.keys(current).length === 0) return { ok: true, payload: { count: 0, ratio: 0, spent: {}, popCost: 0, added: {} } };

    // 查可用资源与劳动人口 → 翻倍比例（资源/人口取最紧张的一方）
    const ecoRes = await this.commands.send({ name: 'economy.GetResources', from: MilitaryModule.NAME, payload: { villageId } });
    const haveRes = ecoRes.ok ? (ecoRes.payload as any)?.resources ?? {} : {};
    let ratio = 1;
    for (const [r, need] of Object.entries(totalCost)) {
      const have = haveRes[r] ?? 0;
      if (need > 0) ratio = Math.min(ratio, have / need);
    }
    const popRes = await this.commands.send({ name: 'population.GetSnapshot', from: MilitaryModule.NAME, payload: { villageId } });
    if (popRes.ok) {
      const labor = (popRes.payload as any)?.currentPop ?? 0;
      if (totalPopCost > 0) ratio = Math.min(ratio, labor / totalPopCost);
      // 动员上限：新增骑兵人口不得超过 mobilizeCap × totalPop - 当前士兵足迹
      const cap = (popRes.payload as any)?.mobilizeCap;
      const tp = (popRes.payload as any)?.totalPop;
      const sp = (popRes.payload as any)?.soldierPop;
      if (typeof cap === 'number' && typeof tp === 'number' && typeof sp === 'number' && totalPopCost > 0) {
        const maxAdd = Math.max(0, cap * tp - sp);
        ratio = Math.min(ratio, maxAdd / totalPopCost);
      }
    }
    ratio = Math.min(1, Math.max(0, ratio)); // 全额翻倍，不设安全边距

    // 实际增加量
    let duplicated = 0;
    for (const code of Object.keys(current)) {
      const add = Math.floor(ratio * current[code]);
      if (add <= 0) continue;
      s.troops[code] = (s.troops[code] ?? 0) + add;
      duplicated += add;
    }
    if (duplicated === 0) return { ok: true, payload: { count: 0, ratio: 0, spent: {}, popCost: 0, added: {} } };

    // 扣资源（失败回滚兵力）
    const spent: Record<string, number> = {};
    for (const [r, need] of Object.entries(totalCost)) spent[r] = Math.floor(ratio * need);
    const spendRes = await this.commands.send({ name: 'economy.TrySpend', from: MilitaryModule.NAME, payload: { villageId, cost: spent } });
    if (!spendRes.ok) {
      for (const code of Object.keys(current)) s.troops[code] = current[code];
      return { ok: false, payload: {}, reason: spendRes.reason ?? 'spend_failed' };
    }

    // 扣劳动人口（直接转驻军，不走训练预留通道）
    let popCost = 0;
    for (const code of Object.keys(current)) {
      const add = Math.floor(ratio * current[code]);
      if (add > 0) popCost += (this.config.units[code]?.popCost ?? 0) * add;
    }
    if (popCost > 0) {
      await this.commands.send({ name: 'population.ConvertPopToGarrison', from: MilitaryModule.NAME, payload: { villageId, amount: popCost } });
    }

    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);
    // 重新按 troops 核算驻军人口足迹（铁律：任何改兵力的路径都要 reportGarrisonPop，
    // 不能只靠 ConvertPopToGarrison 手动累加 garrisonPopCost，否则与解散/训练的重算口径不一致会漂移）
    this.reportGarrisonPop(s);
    const added: Record<string, number> = {};
    for (const code of Object.keys(current)) {
      const gain = (s.troops[code] ?? 0) - current[code];
      if (gain > 0) added[code] = gain;
    }
    return { ok: true, payload: { count: duplicated, ratio: Math.round(ratio * 100) / 100, spent, popCost, added } };
  }

  private async getArmy(cmd: Command): Promise<CommandResult> {
    const s = this.load((cmd.payload as any).villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.trainingBySlot = s.trainingBySlot || {};

    const tribeUnits = Object.values(this.config.units).filter((u) => u.tribe === s.tribe || u.tribe === 'all');
    const { slots, kindLevels } = await this.resolveLayout(s.villageId);

    // 本族可训练兵种列表（前端据此显示）：通用攻防字段保持最终值快照，供驻军汇总与详情使用；
    // baseStats 明确下发 CSV 基础值，仅供训练卡展示，避免把玩家科技/宝物加成误认为配置基础值。
    // unlocked / lockReason 与建筑页 GetBuildOptions 同形态：未满足前置时灰显并写明要求。
    const trainable = tribeUnits.map((u) => {
      const tm = this.techCombatMult(s, u.key);
      const st = this.finalStats(u.key, (s.treasureAtkMult ?? 1) * tm.atk, (s.treasureDefMult ?? 1) * tm.def);
      const trainers = this.trainerSlotsFor(slots, u.key);
      const selectedTrainer = this.selectTrainSlot(s, slots, u.key);
      // 队列全忙时仍以最高等级实例投影数值，保证卡片展示稳定且不暴露建筑实例。
      const projectedTrainer = selectedTrainer ?? trainers[0];
      const haveLv = u.building ? (kindLevels.get(u.building) ?? 0) : 1;
      const techUnlocked = !this.needsTechUnlock(u.key) || (s.techUnlockedUnits ?? []).includes(u.key);
      const unlocked = haveLv >= 1 && techUnlocked;
      const bldName = this.config.buildings[u.building]?.name ?? u.building;
      const level = projectedTrainer?.level ?? 1;
      const kind = projectedTrainer?.kind ?? u.building;
      return {
        key: u.key, name: u.name, icon: u.icon, form: u.form,
        buildingKind: u.building,
        cost: this.effectiveCost(u.cost, level, kind),
        trainSec: Math.max(1, Math.round(u.trainSec * this.trainTimeFactor(level, kind) * (1 - (s.techTrainSpeed ?? 0)) * (this.isCavalry(u.key) ? (s.treasureCavalryTrainMult ?? 1) : 1))),
        meleeAtk: st.meleeAtk, rangedAtk: st.rangedAtk,
        meleeDef: st.meleeDef, rangedDef: st.rangedDef,
        speed: st.speed, carry: st.carry, upkeep: st.upkeep,
        baseStats: {
          meleeAtk: u.meleeAtk, rangedAtk: u.rangedAtk,
          meleeDef: u.meleeDef, rangedDef: u.rangedDef,
          speed: u.speed, carry: u.carry, upkeep: u.upkeep,
        },
        // 每兵每小时口粮（含精神食粮减免）
        cropPerHourEach: this.foodPerSoldier(u.key, s, this.config.constants.popCropPerLabor),
        unlocked,
        lockReason: unlocked ? undefined : (!techUnlocked ? '需完成对应科技' : `需${bldName} 1 级`),
        trainableNow: unlocked && !!selectedTrainer,
        unavailableReason: unlocked && !selectedTrainer ? 'all_training_queues_busy' : undefined,
      };
    });

    // 训练建筑只下发不透明句柄；客户端据此选择训练建筑，不会看到内部 slotId。
    const trainingBuildings = this.sortTrainerSlots(slots)
      .filter((slot) => Object.values(this.config.units).some((u) => u.building === slot.kind))
      .map((slot) => {
        const legacyOrder = s.training
          && this.config.units[s.training.unit]?.building === slot.kind
          && this.trainerSlotsFor(slots, s.training.unit)[0]?.slotId === slot.slotId
          ? s.training
          : undefined;
        const order = s.trainingBySlot[slot.slotId]
          ?? legacyOrder;
        const queueId = order
          ? this.publicQueueId(s.villageId, order.slotId === slot.slotId ? slot.slotId : LEGACY_QUEUE_KEY)
          : undefined;
        return {
          buildingId: this.publicTrainerId(s.villageId, slot.slotId),
          kind: slot.kind,
          name: this.config.buildings[slot.kind]?.name ?? slot.kind,
          level: slot.level,
          busy: !!order,
          training: order ? { unit: order.unit, remaining: order.remaining, nextDoneAt: order.nextDoneAt, queueId } : undefined,
        };
      });

    // 队列 id 是 Military 运行期句柄；建筑来源通过上面的 buildingId/名称显式下发。
    const trainingQueues: Array<{
      queueId: string; unit: string; remaining: number; nextDoneAt: number;
      buildingId?: string; buildingKind?: string; buildingName?: string; buildingLevel?: number;
    }> = Object.entries(s.trainingBySlot)
      .map(([slotId, order]) => {
        const slot = slots.find((candidate) => candidate.slotId === slotId);
        return {
          queueId: this.publicQueueId(s.villageId, slotId),
          unit: order.unit,
          remaining: order.remaining,
          nextDoneAt: order.nextDoneAt,
          buildingId: this.publicTrainerId(s.villageId, slotId),
          buildingKind: slot?.kind,
          buildingName: slot ? (this.config.buildings[slot.kind]?.name ?? slot.kind) : undefined,
          buildingLevel: slot?.level,
        };
      });
    if (s.training) {
      const legacySlot = this.trainerSlotsFor(slots, s.training.unit)[0];
      trainingQueues.push({
        queueId: this.publicQueueId(s.villageId, LEGACY_QUEUE_KEY),
        unit: s.training.unit,
        remaining: s.training.remaining,
        nextDoneAt: s.training.nextDoneAt,
        buildingId: legacySlot ? this.publicTrainerId(s.villageId, legacySlot.slotId) : undefined,
        buildingKind: legacySlot?.kind,
        buildingName: legacySlot ? (this.config.buildings[legacySlot.kind]?.name ?? legacySlot.kind) : '旧版训练队列',
        buildingLevel: legacySlot?.level,
      });
    }
    trainingQueues.sort((a, b) => a.nextDoneAt - b.nextDoneAt || a.queueId.localeCompare(b.queueId));
    const reinforcementRes = await this.commands.send({
      name: 'movement.ListReinforcements', from: MilitaryModule.NAME,
      payload: { villageId: s.villageId },
    });

    return {
      ok: true,
      payload: {
        tribe: s.tribe,
        troops: { ...s.troops },
        raidDefense: {
          enabled: s.raidDefense?.enabled !== false,
          troops: { ...(s.raidDefense?.troops ?? s.troops) },
        },
        trainable,
        trainingQueues,
        trainingBuildings,
        reinforcements: reinforcementRes.ok ? ((reinforcementRes.payload as any)?.reinforcements ?? []) : [],
      },
    };
  }

  /**
   * 训练：客户端可指定一个本村空闲训练建筑；缺省时沿用空闲最高等级建筑。
   * 校验兵种(含种族) → 校验存在已建成训练建筑与可用队列 →
   * 扣人口 → 一次性预扣资源(数量×单价×建筑等级降费) → 入该 slot 队列，逐个产出。
   */
  private async trainTroops(cmd: Command): Promise<CommandResult> {
    const { villageId, unit, count, buildingId } = cmd.payload as { villageId: string; unit: string; count: number; buildingId?: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.trainingBySlot = s.trainingBySlot || {};

    const def = this.config.units[unit];
    if (!def) return { ok: false, payload: {}, reason: `unknown_unit:${unit}` };
    if (def.tribe !== s.tribe && def.tribe !== 'all') return { ok: false, payload: {}, reason: 'wrong_tribe_unit' };
    if (this.needsTechUnlock(unit) && !(s.techUnlockedUnits ?? []).includes(unit)) {
      return { ok: false, payload: {}, reason: 'tech_not_unlocked' };
    }
    if (!Number.isInteger(count) || count <= 0) return { ok: false, payload: {}, reason: 'bad_count' };

    // 服务端基于当前快照校验客户端选择的本村建筑；缺省时保持旧的自动选址规则。
    const layout = await this.resolveLayout(villageId);
    const trainers = this.trainerSlotsFor(layout.slots, unit);
    if (trainers.length === 0) return { ok: false, payload: {}, reason: `requires_building:${def.building}` };
    let slotInfo: TrainerSlot | undefined;
    if (buildingId) {
      const selectedSlotId = this.internalTrainerKey(villageId, buildingId);
      if (!selectedSlotId) return { ok: false, payload: {}, reason: 'training_building_not_found' };
      slotInfo = trainers.find((slot) => slot.slotId === selectedSlotId);
      if (!slotInfo) return { ok: false, payload: {}, reason: 'invalid_training_building' };
      if (s.trainingBySlot[slotInfo.slotId] || slotInfo.slotId === this.legacyReservedSlot(s, layout.slots, unit)) {
        return { ok: false, payload: {}, reason: 'queue_busy' };
      }
    } else {
      slotInfo = this.selectTrainSlot(s, layout.slots, unit);
    }
    if (!slotInfo) return { ok: false, payload: {}, reason: 'queue_busy' };
    const targetSlot = slotInfo.slotId;

    // 扣人口（训练开始时扣，不足则拒绝训练）
    const popResult = await this.commands.send({
      name: 'population.ConsumePop',
      from: MilitaryModule.NAME,
      payload: { villageId, unit, count },
    });
    if (!popResult.ok) return { ok: false, payload: {}, reason: popResult.reason ?? 'insufficient_population' };

    // 一次性预扣 count 份资源（已按建筑等级降费；人口已扣，资源失败需回滚人口）
    const perUnit = this.effectiveCost(def.cost, slotInfo.level, slotInfo.kind);
    const totalCost: Record<string, number> = {};
    for (const [r, v] of Object.entries(perUnit)) totalCost[r] = v * count;

    const spend = await this.commands.send({
      name: 'economy.TrySpend',
      from: MilitaryModule.NAME,
      payload: { villageId, cost: totalCost },
    });
    if (!spend.ok) {
      // 资源不足：回滚已预留的训练人口（释放 trainingPopCost 并恢复平民，与 ConsumePop 相反）
      const consumed = (popResult.payload as any)?.consumed ?? def.popCost * count;
      void this.commands.send({
        name: 'population.ReleaseTrainingPop',
        from: MilitaryModule.NAME,
        payload: { villageId, amount: consumed, restoreCivilian: true },
      });
      return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };
    }

    // 读取人口劳动力练兵加速（GetLaborMult，只读快照，无副作用）；再叠建筑等级提速
    const laborRes = await this.commands.send({
      name: 'population.GetLaborMult',
      from: MilitaryModule.NAME,
      payload: { villageId, buildingKind: def.building },
    });
    const laborMult: number = laborRes.ok ? ((laborRes.payload as any).mult as number) : 1.0;
    // 实际单兵耗时 = 基础耗时 × 建筑等级提速 ÷ 人口劳动力加速 × 骑兵训练加速（伯乐）
    let effectiveTrainSec = (def.trainSec * this.trainTimeFactor(slotInfo.level, slotInfo.kind)) / Math.max(0.01, laborMult);
    effectiveTrainSec *= 1 - (s.techTrainSpeed ?? 0);
    if (this.isCavalry(unit)) effectiveTrainSec *= (s.treasureCavalryTrainMult ?? 1);

    // 入该 slot 队列，登记第一个出兵
    const trainMsEach = Math.max(1, Math.round(effectiveTrainSec * 1000));
    const firstDoneMs = trainMsEach;
    const taskId = this.scheduler.schedule(firstDoneMs, () => this.produceOne(villageId, targetSlot), `military:${villageId}`, `village:${villageId}`);
    s.trainingBySlot[targetSlot] = {
      unit,
      slotId: targetSlot,
      remaining: count,
      nextDoneAt: this.now() + firstDoneMs,
      taskId,
      trainMsEach,
      costPerUnit: { ...perUnit },
    };
    this.store.set(COLLECTION, villageId, s);
    // v5：训练中士兵立刻按 unit.upkeep 计入 cropUpkeep（不必等 produceOne）。
    this.reportUpkeep(s);
    return { ok: true, payload: { unit, count, queueId: this.publicQueueId(villageId, targetSlot) } };
  }

  /**
   * 取消 Military 对外暴露的训练队列。
   * 已产出的士兵不会被撤回；尚未产出的部分返还预留人口和训练资源。
   * 旧存档没有 costPerUnit 时仍可取消，但只能返还人口（无法可靠重建当时的建筑等级折扣）。
   */
  private async cancelTraining(cmd: Command): Promise<CommandResult> {
    const { villageId, queueId } = cmd.payload as { villageId: string; queueId: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    s.trainingBySlot = s.trainingBySlot || {};
    const internalKey = this.internalQueueKey(villageId, queueId);
    if (!internalKey) return { ok: false, payload: {}, reason: 'training_not_found' };
    let order: TrainOrder | undefined;
    let orderSlotId: string | undefined;
    if (internalKey === LEGACY_QUEUE_KEY) {
      order = s.training ?? undefined;
    } else {
      order = s.trainingBySlot[internalKey];
      orderSlotId = internalKey;
    }
    if (!order) return { ok: false, payload: {}, reason: 'training_not_found' };

    if (order.taskId) this.scheduler.cancel(order.taskId);
    const remaining = Math.max(0, Math.floor(order.remaining));
    const def = this.config.units[order.unit];
    const returnedPop = def ? Math.max(0, def.popCost * remaining) : 0;
    const refund: Record<string, number> = {};
    for (const [resource, amount] of Object.entries(order.costPerUnit ?? {})) {
      const value = Math.max(0, Number(amount) || 0) * remaining;
      if (value > 0) refund[resource] = value;
    }

    if (orderSlotId) delete s.trainingBySlot[orderSlotId];
    else s.training = null;
    this.forgetPublicQueueId(villageId, internalKey);
    this.store.set(COLLECTION, villageId, s);

    if (returnedPop > 0) {
      await this.commands.send({
        name: 'population.ReleaseTrainingPop',
        from: MilitaryModule.NAME,
        payload: { villageId, amount: returnedPop, restoreCivilian: true },
      });
    }
    let refunded: Record<string, number> = {};
    if (Object.keys(refund).length > 0) {
      const grant = await this.commands.send({
        name: 'economy.Grant',
        from: MilitaryModule.NAME,
        payload: { villageId, gain: refund },
      });
      refunded = ((grant.payload as any)?.applied ?? {}) as Record<string, number>;
    }
    this.reportUpkeep(s);
    return { ok: true, payload: { unit: order.unit, remaining, returnedPop, refunded, refund } };
  }

  /**
   * 出一个兵，若还有剩余则登记下一个（逐个产出）。
   * 内部 slotId 指定则从 trainingBySlot 取队列；缺省兼容旧单队列 s.training。
   */
  private produceOne(villageId: string, slotId?: string): void {
    const s = this.load(villageId);
    if (!s) return;
    const order = slotId ? (s.trainingBySlot?.[slotId]) : s.training;
    if (!order) return;

    s.troops[order.unit] = (s.troops[order.unit] ?? 0) + 1;
    order.remaining -= 1;

    if (order.remaining > 0) {
      // 用开始训练时快照的每兵耗时（整批一致）
      const nextMs = order.trainMsEach ?? (this.config.units[order.unit]?.trainSec ?? 30) * 1000;
      order.nextDoneAt = this.now() + nextMs;
      order.taskId = this.scheduler.schedule(nextMs, () => this.produceOne(villageId, slotId), `military:${villageId}`, `village:${villageId}`);
    } else if (slotId) {
      delete s.trainingBySlot[slotId];
      this.forgetPublicQueueId(villageId, slotId);
    } else {
      s.training = null;
      this.forgetPublicQueueId(villageId, LEGACY_QUEUE_KEY);
    }
    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);
    this.reportGarrisonPop(s);
    // 每产出一个兵：把训练中预留(trainingPopCost)等量释放——该兵已由 SetGarrisonPop 计入 garrisonPopCost，
    // footprint 不变 → 总人口守恒，无"先扣后补"闪烁。
    const uDef = this.config.units[order.unit];
    if (uDef) {
      void this.commands.send({
        name: 'population.ReleaseTrainingPop',
        from: MilitaryModule.NAME,
        payload: { villageId, amount: uDef.popCost, restoreCivilian: false },
      });
    }

    const evt: DomainEvent = {
      name: 'military.TroopTrained',
      source: MilitaryModule.NAME,
      ts: this.now(),
      payload: { villageId, unit: order.unit, total: s.troops[order.unit] },
    };
    void this.bus.emit(evt);
  }

  /**
   * 解散驻村军队（DisbandTroops）：减兵力 + 归还人口 + 更新维护。
   * 只能解散驻村部队（出征中的军队不在 troops 里，归 movement 管辖）。
   * 100% 归还训练时占用的人口。
   * 资源不返还。
   */
  private async disbandTroops(cmd: Command): Promise<CommandResult> {
    const { villageId, units } = cmd.payload as { villageId: string; units: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    // 校验：兵种存在、数量合法、驻村兵力充足
    for (const [unit, cnt] of Object.entries(units)) {
      if (!Number.isInteger(cnt) || cnt <= 0) return { ok: false, payload: {}, reason: `bad_count:${unit}` };
      const have = s.troops[unit] ?? 0;
      if (have < cnt) return { ok: false, payload: {}, reason: `insufficient_troops:${unit}` };
    }

    // 扣减兵力
    for (const [unit, cnt] of Object.entries(units)) {
      s.troops[unit] = (s.troops[unit] ?? 0) - cnt;
      if (s.troops[unit] <= 0) delete s.troops[unit];
    }
    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);
    this.reportGarrisonPop(s);

    // 归还人口（population.ReturnPop 按各兵种 popCost 计算）
    const returnResult = await this.commands.send({
      name: 'population.ReturnPop',
      from: MilitaryModule.NAME,
      payload: { villageId, units },
    });
    const returnedPop = (returnResult.payload as any)?.returned ?? 0;

    return { ok: true, payload: { troops: { ...s.troops }, returnedPop } };
  }

  /**
   * 参战快照：对外只给"算好的最终三维 × 数量"。
   * Combat/Movement 拿这个去结算，不知道铁匠养成怎么算的（派生管线对外口径）。
   */
  private async getCombatSnapshot(cmd: Command): Promise<CommandResult> {
    const { villageId, units, purpose } = cmd.payload as { villageId: string; units?: Record<string, number>; purpose?: 'raid' | 'siege' };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const raidConfig = s.raidDefense ?? { enabled: true, troops: { ...s.troops } };
    if (purpose === 'raid' && !raidConfig.enabled) return { ok: true, payload: { snapshot: {} } };
    // 声望是玩家级派生加成；负声望的军队攻防 buff 适用于所有由该村出战/守城的快照，
    // 包括掠夺防守（掠夺仍不叠加城墙、宝物、科技等守城专属加成）。
    const reputation = await this.commands.send({
      name: 'reputation.GetByVillage', from: MilitaryModule.NAME, payload: { villageId },
    });
    const reputationPayload = (reputation.ok ? reputation.payload : {}) as { armyAttackMult?: number; armyDefenseMult?: number };
    const reputationAtk = Number.isFinite(reputationPayload.armyAttackMult) ? Math.max(1, reputationPayload.armyAttackMult!) : 1;
    const reputationDef = Number.isFinite(reputationPayload.armyDefenseMult) ? Math.max(1, reputationPayload.armyDefenseMult!) : 1;
    // units 指定已经由 Movement 验证并扣出村庄的参战兵力；此时不能再按当前驻军钳制，
    // 否则“派出20、城里剩10”会只用10人参战。缺省/掠夺防守才按现有驻军取值。
    const source = purpose === 'raid' ? raidConfig.troops : (units ?? s.troops);
    const snapshot: Record<string, any> = {};
    for (const [unit, n] of Object.entries(source)) {
      const requested = Math.max(0, Math.floor(Number(n) || 0));
      const available = units && purpose !== 'raid'
        ? requested
        : Math.min(requested, s.troops[unit] ?? 0);
      if (!this.config.units[unit] || available <= 0) continue;
      // 掠夺防守明确不吃城墙、宝物、科技等守城加成；基础兵种属性仍有效。
      const stats = purpose === 'raid'
        ? this.finalStats(unit, reputationAtk, reputationDef)
        : (() => {
          const tm = this.techCombatMult(s, unit);
          return this.finalStats(unit, (s.treasureAtkMult ?? 1) * tm.atk * reputationAtk, (s.treasureDefMult ?? 1) * tm.def * reputationDef);
        })();
      snapshot[unit] = { count: available, ...stats };
    }
    return { ok: true, payload: { snapshot } };
  }

  /** 设置守方参与掠夺战的兵力；enabled=false 表示放弃防守掠夺。 */
  private setRaidDefense(cmd: Command): CommandResult {
    const { villageId, enabled, troops } = cmd.payload as { villageId: string; enabled: boolean; troops?: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const selected: Record<string, number> = {};
    for (const [unit, raw] of Object.entries(troops ?? {})) {
      if (!this.config.units[unit]) continue;
      const count = Math.min(Math.max(0, Math.floor(Number(raw) || 0)), s.troops[unit] ?? 0);
      if (count > 0) selected[unit] = count;
    }
    s.raidDefense = { enabled: enabled !== false, troops: selected };
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { raidDefense: { ...s.raidDefense, troops: { ...selected } } } };
  }

  /**
   * 雇佣兵入库：把兵力加入 troops（popCost=0/upkeep=0 → reportUpkeep/reportGarrisonPop 自动零副作用，
   * 战斗快照自动含其战力）。是否有期限由调用方决定：营地购买由 MercenaryModule 登记合同，
   * 任务奖励直接调用本命令且不登记合同，因此永久保留；两者共用同一 troops 数据。
   */
  private addMercenaries(cmd: Command): CommandResult {
    const { villageId, units } = cmd.payload as { villageId: string; units: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    for (const [unit, n] of Object.entries(units)) {
      if (!this.config.units[unit]) continue;
      const v = Math.floor(n);
      if (v <= 0) continue;
      s.troops[unit] = (s.troops[unit] ?? 0) + v;
    }
    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);
    this.reportGarrisonPop(s);
    return { ok: true, payload: { troops: { ...s.troops } } };
  }

  private removeMercenaries(cmd: Command): CommandResult {
    const { villageId, units } = cmd.payload as { villageId: string; units: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    const removed: Record<string, number> = {};
    for (const [unit, requested] of Object.entries(units ?? {})) {
      if (!this.config.units[unit]?.isMercenary) continue;
      const take = Math.min(s.troops[unit] ?? 0, Math.max(0, Math.floor(requested)));
      if (take <= 0) continue;
      s.troops[unit] -= take;
      if (s.troops[unit] <= 0) delete s.troops[unit];
      removed[unit] = take;
    }
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { removed } };
  }

  /** 增减驻村兵力（出征扣出用负数，返程/补充用正数）。 */
  private adjustTroops(cmd: Command): CommandResult {
    const { villageId, delta } = cmd.payload as { villageId: string; delta: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    // 先校验不会扣成负数
    for (const [unit, d] of Object.entries(delta)) {
      const cur = s.troops[unit] ?? 0;
      if (cur + d < 0) return { ok: false, payload: {}, reason: `insufficient_troops:${unit}` };
    }
    for (const [unit, d] of Object.entries(delta)) {
      s.troops[unit] = (s.troops[unit] ?? 0) + d;
      if (s.troops[unit] === 0) delete s.troops[unit];
    }
    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);
    this.reportGarrisonPop(s);
    return { ok: true, payload: { troops: { ...s.troops } } };
  }

  /** 记录在途（行军）兵力快照：仅计粮耗，不改驻村兵力/动员上限（动员由 population.SetEnRoutePop 单独算）。 */
  private setMarchingTroops(cmd: Command): CommandResult {
    const { villageId, troops } = cmd.payload as { villageId: string; troops: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.marching = troops;
    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);
    return { ok: true, payload: { marching: { ...troops } } };
  }

  /**
   * 祭祀台等消耗型效果：扣除 popNeed 个「士兵人口」。
   * 优先移除 popCost 最小的兵种；若仍差 1 人口而该兵单个占多个人口，仍整兵扣除（允许超扣）。
   * popCost<=0 的兵（雇佣兵）不可献祭，跳过。返回实际移除的兵与折合人口。
   */
  private sacrificeTroops(cmd: Command): CommandResult {
    const { villageId, popNeed } = cmd.payload as { villageId: string; popNeed: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    let remaining = Math.max(0, Math.floor(popNeed));
    const removed: Record<string, number> = {};
    let sacrificedPop = 0;
    if (remaining > 0) {
      const entries = Object.entries(s.troops)
        .map(([unit, n]) => ({ unit, n, popCost: this.config.units[unit]?.popCost ?? 1 }))
        .filter((e) => e.popCost > 0)
        .sort((a, b) => a.popCost - b.popCost);
      for (const e of entries) {
        if (remaining <= 0) break;
        let take = 0;
        while (take < e.n && remaining > 0) {
          take++;
          sacrificedPop += e.popCost;
          remaining -= e.popCost; // 允许减到负值=超扣
        }
        if (take > 0) {
          removed[e.unit] = take;
          s.troops[e.unit] = (s.troops[e.unit] ?? 0) - take;
          if (s.troops[e.unit] <= 0) delete s.troops[e.unit];
        }
      }
    }
    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);
    this.reportGarrisonPop(s);
    return { ok: true, payload: { removed, sacrificedPop, remaining: Math.max(0, remaining) } };
  }
}

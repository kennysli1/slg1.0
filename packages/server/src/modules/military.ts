import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, UnitDef } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Military（军队/兵种）
 * 对应设计文档 02_系统清单C组、10_兵种特性效果表、07_扩展与代码规范
 *
 * 职责：每村兵力数量、训练队列、兵种养成(铁匠)等级的 owner。
 * 兵种数据来自 GameConfig（config/units.csv）——改 CSV 即改兵种/加部族。
 * 不直接改资源——训练时向 Economy 发 TrySpend 扣费（状态归属唯一）。
 *
 * 训练队列：逐个产出（每 trainSec 出 1 个），资源一次性预扣。
 * 铁匠养成：smithyLevel 提升某兵种攻防 → 派生管线（对外只给最终三维）。
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
}

interface MilitaryState {
  villageId: string;
  /** 该村种族，决定可训练哪些兵种 */
  tribe: string;
  /** 驻村兵力：兵种 -> 数量 */
  troops: Record<string, number>;
  /** 铁匠对各兵种的强化等级（养成层） */
  smithyLevel: Record<string, number>;
  /** 旧版单条训练队列（仅用于兼容旧存档；新训练一律走 trainingBySlot）。 */
  training: TrainOrder | null;
  /** 逐建筑实例训练队列：slotId -> 该建筑的独立训练队列（多实例并行训练）。 */
  trainingBySlot: Record<string, TrainOrder>;
  /**
   * 进行中的铁匠升级（一次仅一个；v3 改为耗时操作，受繁荣度加成加速）。
   * `startAt` 是可选的**新增**字段（客户端画进度条要有个起点）：老存档里没有，
   * 读取方一律按 `?? null` 兜底，因此不构成不兼容的落盘结构变更、无需刷档。
   */
  pendingSmithy?: { unit: string; taskId: string; startAt?: number; doneAt: number };
  /** 宝物军事倍率（乘数，默认 1；由 treasure 模块推送，无环）：攻/防分别作用。 */
  treasureAtkMult?: number;
  treasureDefMult?: number;
  /** 科研攻击倍率（由 research 模块推送，叠加在宝物之上）。 */
  techAtkMult?: number;
  /** 科研防御倍率（由 research 模块推送，叠加在宝物之上）。 */
  techDefMult?: number;
}

const COLLECTION = 'military';

export class MilitaryModule {
  static readonly NAME = 'military';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'military',
    publicActions: {
      GetArmy: { command: 'military.GetArmy', ownVillage: true, needAuth: true, schema: {} },
      TrainTroops: {
        command: 'military.TrainTroops', ownVillage: true, needAuth: true,
        schema: {
          slotId: { type: 'string', minLen: 1, maxLen: 32, optional: true },
          unit:  { type: 'string', minLen: 1, maxLen: 32 },
          count: { type: 'integer', min: 1, max: 10000 },
        },
      },
      UpgradeSmithy: {
        command: 'military.UpgradeSmithy', ownVillage: true, needAuth: true,
        schema: { unit: { type: 'string', minLen: 1, maxLen: 32 } },
      },
      DisbandTroops: {
        command: 'military.DisbandTroops', ownVillage: true, needAuth: true,
        schema: { units: { type: 'record_int', maxKeys: 20, minVal: 1, maxVal: 100000 } },
      },
    },
    eventPushMap: {
      'military.TroopTrained': 'TroopTrained',
      'military.SmithyUpgraded': 'SmithyUpgraded',
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

  private units(): Record<string, UnitDef> {
    return this.config.units;
  }

  init(): void {
    this.commands.register('military.GetArmy', (c) => this.getArmy(c));
    this.commands.register('military.TrainTroops', (c) => this.trainTroops(c));
    this.commands.register('military.UpgradeSmithy', (c) => this.upgradeSmithy(c));
    this.commands.register('military.DisbandTroops', (c) => this.disbandTroops(c));
    // 供 Combat/Movement 取"参战快照"：对外只给算好的最终三维（派生管线对外口径）
    this.commands.register('military.GetCombatSnapshot', (c) => this.getCombatSnapshot(c));
    // 增减驻村兵力（行军出征扣出、返程/训练完成加入），由 Movement 等调用
    this.commands.register('military.AdjustTroops', (c) => this.adjustTroops(c));
    // 祭祀台等消耗型效果：按 popCost 升序移除驻村士兵直到满足人口缺口（允许超扣）。
    this.commands.register('military.SacrificeTroops', (c) => this.sacrificeTroops(c));
    // 雇佣兵：把雇佣兵永久写入 troops（popCost=0/upkeep=0 → 自动零副作用、自动参战）。
    this.commands.register('military.AddMercenaries', (c) => this.addMercenaries(c));
    // 宝物军事倍率（攻/防分别作用），由 treasure 模块推送，无环。
    this.commands.register('military.SetTreasureCombatMult', (c) => this.setTreasureCombatMult(c));
    this.commands.register('military.SetTechCombatMult', (c) => this.setTechCombatMult(c));

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

    // 重注册进行中的铁匠升级（v3 耗时操作）
    for (const s of this.store.all<MilitaryState>(COLLECTION)) {
      if (!s.pendingSmithy) continue;
      const delay = Math.max(0, s.pendingSmithy.doneAt - this.now());
      s.pendingSmithy.taskId = this.scheduler.schedule(
        delay,
        () => this.onSmithyDone(s.villageId),
        `military:${s.villageId}`,
        `village:${s.villageId}`,
      );
      this.store.set(COLLECTION, s.villageId, s);
    }
  }

  createVillage(villageId: string, tribe = 'romans'): void {
    const s: MilitaryState = {
      villageId,
      tribe,
      troops: {},
      smithyLevel: {},
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
    let ration = 0; // 军晌（默认口粮 + upkeep）
    for (const [unit, n] of Object.entries(s.troops)) {
      const def = this.config.units[unit];
      const popCost = def?.popCost ?? 1;
      ration += (base + (def?.upkeep ?? 0)) * popCost * n;
    }
    // 训练队列：每个未产出的兵也按 (默认口粮 + upkeep) × popCost 计入（即便尚未入 troops）。
    if (s.training) {
      const def = this.config.units[s.training.unit];
      const popCost = def?.popCost ?? 1;
      ration += (base + (def?.upkeep ?? 0)) * popCost * s.training.remaining;
    }
    for (const order of Object.values(s.trainingBySlot || {})) {
      const def = this.config.units[order.unit];
      const popCost = def?.popCost ?? 1;
      ration += (base + (def?.upkeep ?? 0)) * popCost * order.remaining;
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

  /** 派生管线：最终数值 = 基础 × (1 + 铁匠等级×每级加成) × 宝物军事倍率。对外只暴露这个结果（含形态/特性）。 */
  private finalStats(unit: string, smithyLv: number, atkMult = 1, defMult = 1) {
    const def = this.config.units[unit];
    const bonus = 1 + smithyLv * this.config.constants.smithyBonusPerLevel; // 每级加成来自 config
    return {
      form: def.form,
      meleeAtk: def.meleeAtk * bonus * atkMult,
      rangedAtk: def.rangedAtk * bonus * atkMult,
      meleeDef: def.meleeDef * bonus * defMult,
      rangedDef: def.rangedDef * bonus * defMult,
      speed: def.speed,
      carry: def.carry,
      upkeep: def.upkeep,
      traits: def.traits.flatMap((tc) => {
        const t = this.config.unitTraits[tc];
        return t.effects;
      }),
    };
  }

  // ---- Commands ----

  /** 训练用军事建筑（其详情抽屉内嵌训练 UI）：兵营/马厩/兵工厂 + 城镇中心(特殊兵种)。 */
  private static readonly TRAINER_KINDS = new Set(['barracks', 'stable', 'workshop', 'main']);

  /** 解析本村建筑布局：返回所有槽位(slotId/kind/level)与每种建筑的最高等级。失败返回空（仅影响训练/可训展示）。 */
  private async resolveLayout(villageId: string): Promise<{ slots: { slotId: string; kind: string; level: number }[]; kindLevels: Map<string, number> }> {
    try {
      const res = await this.commands.send({ name: 'building.GetLayout', from: MilitaryModule.NAME, payload: { villageId } });
      if (!res.ok) return { slots: [], kindLevels: new Map() };
      const layout = res.payload as any;
      const slots: { slotId: string; kind: string; level: number }[] = [];
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

  /** 某兵种是否由该建筑 kind 训练。 */
  private unitBuildingMatches(unit: string, kind: string): boolean {
    return this.config.units[unit]?.building === kind;
  }

  private async getArmy(cmd: Command): Promise<CommandResult> {
    const s = this.load((cmd.payload as any).villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.trainingBySlot = s.trainingBySlot || {};

    const tribeUnits = Object.values(this.config.units).filter((u) => u.tribe === s.tribe);
    const { slots, kindLevels } = await this.resolveLayout(s.villageId);

    // 本族可训练兵种列表（前端据此显示）；攻防走派生管线只给最终值快照（含该村铁匠加成）。
    // unlocked / lockReason 与建筑页 GetBuildOptions 同形态：未满足前置时灰显并写明要求。
    const trainable = tribeUnits.map((u) => {
      const st = this.finalStats(u.key, s.smithyLevel[u.key] ?? 0, (s.treasureAtkMult ?? 1) * (s.techAtkMult ?? 1), (s.treasureDefMult ?? 1) * (s.techDefMult ?? 1));
      const haveLv = u.building ? (kindLevels.get(u.building) ?? 0) : 1;
      const unlocked = haveLv >= 1;
      const bldName = this.config.buildings[u.building]?.name ?? u.building;
      return {
        key: u.key, name: u.name, icon: u.icon, form: u.form, building: u.building,
        cost: u.cost, trainSec: u.trainSec,
        meleeAtk: st.meleeAtk, rangedAtk: st.rangedAtk,
        meleeDef: st.meleeDef, rangedDef: st.rangedDef,
        speed: st.speed, carry: st.carry, upkeep: st.upkeep,
        // v3：士兵直接以 upkeep 计入 troops 口粮（人口硬上限模型已无 soldier_pool 额外口粮）
        cropPerHourEach: st.upkeep,
        unlocked,
        lockReason: unlocked ? undefined : `需${bldName} 1 级`,
      };
    });

    // 逐建筑训练队列：每个军事建筑实例一份独立队列（多实例并行训练）。
    const slotsOut = slots
      .filter((sl) => MilitaryModule.TRAINER_KINDS.has(sl.kind))
      .map((sl) => {
        const trainableHere = tribeUnits
          .filter((u) => u.building === sl.kind)
          .map((u) => {
            const st = this.finalStats(u.key, s.smithyLevel[u.key] ?? 0, (s.treasureAtkMult ?? 1) * (s.techAtkMult ?? 1), (s.treasureDefMult ?? 1) * (s.techDefMult ?? 1));
            const unlocked = sl.level >= 1;
            return {
              key: u.key, name: u.name, icon: u.icon, form: u.form, building: u.building,
              cost: this.effectiveCost(u.cost, sl.level, sl.kind), // 已按建筑等级降费
              trainSec: Math.round(u.trainSec * this.trainTimeFactor(sl.level, sl.kind)), // 已按建筑等级提速
              meleeAtk: st.meleeAtk, rangedAtk: st.rangedAtk,
              meleeDef: st.meleeDef, rangedDef: st.rangedDef,
              speed: st.speed, carry: st.carry, upkeep: st.upkeep,
              cropPerHourEach: st.upkeep,
              unlocked,
              lockReason: unlocked ? undefined : '建筑建造中',
              level: sl.level,
            };
          });
        const order = s.trainingBySlot[sl.slotId];
        const training = order
          ? { unit: order.unit, remaining: order.remaining, nextDoneAt: order.nextDoneAt }
          : null;
        return { slotId: sl.slotId, kind: sl.kind, level: sl.level, trainable: trainableHere, training };
      });

    // 旧单队列兼容：挂到首个匹配建筑槽位上展示（避免重复挂多个槽位）。
    if (s.training) {
      const legacy = { unit: s.training.unit, remaining: s.training.remaining, nextDoneAt: s.training.nextDoneAt };
      const target = slotsOut.find((x) => !x.training && this.unitBuildingMatches(s.training!.unit, x.kind));
      if (target) target.training = legacy;
    }

    // top-level training：首个活跃队列（兼容旧调用方 / movement 读取）。
    const firstActive = Object.values(s.trainingBySlot)[0] ?? s.training;
    const training = firstActive
      ? { unit: firstActive.unit, remaining: firstActive.remaining, nextDoneAt: firstActive.nextDoneAt }
      : null;

    return {
      ok: true,
      payload: {
        tribe: s.tribe,
        troops: { ...s.troops },
        smithyLevel: { ...s.smithyLevel },
        // 进行中的铁匠升级（客户端画进度条用）。只给 unit/起止时刻，
        // taskId 是调度器内部句柄，不外泄。
        pendingSmithy: s.pendingSmithy
          ? { unit: s.pendingSmithy.unit, startAt: s.pendingSmithy.startAt ?? null, doneAt: s.pendingSmithy.doneAt }
          : null,
        trainable,
        training,
        slots: slotsOut,
      },
    };
  }

  /**
   * 训练：在指定军事建筑实例(slotId)内训练某兵种。
   * 校验兵种(含种族) → 校验该 slot 确为该兵种所属建筑且已建成 → 该建筑独立队列未占用 →
   * 扣人口 → 一次性预扣资源(数量×单价×建筑等级降费) → 入该 slot 队列，逐个产出。
   * slotId 缺省时回退到该兵种所属建筑的第一个已建成实例（兼容旧调用 / 测试）。
   */
  private async trainTroops(cmd: Command): Promise<CommandResult> {
    const { villageId, unit, count, slotId } = cmd.payload as { villageId: string; unit: string; count: number; slotId?: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    s.trainingBySlot = s.trainingBySlot || {};

    const def = this.config.units[unit];
    if (!def) return { ok: false, payload: {}, reason: `unknown_unit:${unit}` };
    if (def.tribe !== s.tribe) return { ok: false, payload: {}, reason: 'wrong_tribe_unit' };
    if (!Number.isInteger(count) || count <= 0) return { ok: false, payload: {}, reason: 'bad_count' };

    // 该兵种所属建筑：必须通过 slotId 指向的实例，且该实例确为 def.building
    const layout = await this.resolveLayout(villageId);
    let targetSlot = slotId;
    if (!targetSlot) {
      // 缺省：取该兵种所属建筑第一个 level>=1 的实例
      const found = layout.slots.find((sl) => sl.kind === def.building && sl.level >= 1);
      targetSlot = found?.slotId;
    }
    if (!targetSlot) return { ok: false, payload: {}, reason: `requires_building:${def.building}` };
    const slotInfo = layout.slots.find((sl) => sl.slotId === targetSlot);
    if (!slotInfo || slotInfo.kind !== def.building) return { ok: false, payload: {}, reason: 'wrong_slot' };
    if (slotInfo.level < 1) return { ok: false, payload: {}, reason: `requires_building:${def.building}` };
    // 该建筑实例独立队列占用则拒绝（多实例并行：各自独立队列）
    if (s.trainingBySlot[targetSlot]) return { ok: false, payload: {}, reason: 'queue_busy' };
    if (s.training) return { ok: false, payload: {}, reason: 'queue_busy' }; // 旧单队列兼容

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
    // 实际单兵耗时 = 基础耗时 × 建筑等级提速 ÷ 人口劳动力加速（人多练得快）
    const effectiveTrainSec = (def.trainSec * this.trainTimeFactor(slotInfo.level, slotInfo.kind)) / Math.max(0.01, laborMult);

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
    };
    this.store.set(COLLECTION, villageId, s);
    // v5：训练中士兵立刻按 unit.upkeep 计入 cropUpkeep（不必等 produceOne）。
    this.reportUpkeep(s);
    return { ok: true, payload: { unit, count, slotId: targetSlot } };
  }

  /**
   * 出一个兵，若还有剩余则登记下一个（逐个产出）。
   * slotId 指定则从 trainingBySlot[slotId] 取队列；缺省兼容旧单队列 s.training。
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
    } else {
      s.training = null;
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
   * 铁匠升级（v3 改为耗时操作）：扣资源 → 登记定时任务 → 完成时提升某兵种养成等级。
   * 时长受繁荣度加成加速：durMs = smithyUpgradeSec × 1000 / prosperityMult（population.GetLaborMult('smithy')）。
   * 同一时刻仅允许一个铁匠升级（队列占用则拒）。
   */
  private async upgradeSmithy(cmd: Command): Promise<CommandResult> {
    const { villageId, unit } = cmd.payload as { villageId: string; unit: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    if (!this.config.units[unit]) return { ok: false, payload: {}, reason: `unknown_unit:${unit}` };
    if (s.pendingSmithy) return { ok: false, payload: {}, reason: 'smithy_busy' };

    const nextLv = (s.smithyLevel[unit] ?? 0) + 1;
    const base = this.config.constants.smithyCostBase;
    const cost = { wood: base * nextLv, clay: base * nextLv }; // 成本基数来自 config
    const spend = await this.commands.send({
      name: 'economy.TrySpend',
      from: MilitaryModule.NAME,
      payload: { villageId, cost },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };

    // 读取人口劳动力锻造加速（GetLaborMult，只读快照，无副作用）
    const laborRes = await this.commands.send({
      name: 'population.GetLaborMult',
      from: MilitaryModule.NAME,
      payload: { villageId, buildingKind: 'smithy' },
    });
    const mult: number = laborRes.ok ? ((laborRes.payload as any).mult as number) : 1.0;
    const durMs = Math.max(1, Math.round((this.config.constants.smithyUpgradeSec * 1000) / Math.max(0.01, mult)));

    const startAt = this.now();
    const doneAt = startAt + durMs;
    const taskId = this.scheduler.schedule(durMs, () => this.onSmithyDone(villageId), `military:${villageId}`, `village:${villageId}`);
    s.pendingSmithy = { unit, taskId, startAt, doneAt };
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { unit, nextLevel: nextLv, doneAt, durationMs: durMs } };
  }

  /** 铁匠升级完成：提升养成等级并广播。 */
  private async onSmithyDone(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s || !s.pendingSmithy) return;
    const unit = s.pendingSmithy.unit;
    const level = (s.smithyLevel[unit] ?? 0) + 1;
    s.smithyLevel[unit] = level;
    s.pendingSmithy = undefined;
    this.store.set(COLLECTION, villageId, s);
    await this.bus.emit({
      name: 'military.SmithyUpgraded', source: MilitaryModule.NAME, ts: this.now(),
      payload: { villageId, unit, smithyLevel: level },
    } as DomainEvent);
  }

  /**
   * 解散驻村军队（DisbandTroops）：减兵力 + 归还人口 + 更新维护。
   * 只能解散驻村部队（出征中的军队不在 troops 里，归 movement 管辖）。
   * 100% 归还人口（但拓荒者 popPermanent=true，由 population.ReturnPop 跳过）。
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

    // 归还人口（population.ReturnPop 自行跳过 popPermanent 单位）
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
  private getCombatSnapshot(cmd: Command): CommandResult {
    const { villageId, units } = cmd.payload as { villageId: string; units?: Record<string, number> };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    // units 指定参战兵力；缺省取全部驻军
    const source = units ?? s.troops;
    const snapshot: Record<string, any> = {};
    for (const [unit, n] of Object.entries(source)) {
      if (!this.config.units[unit] || n <= 0) continue;
      const stats = this.finalStats(unit, s.smithyLevel[unit] ?? 0, (s.treasureAtkMult ?? 1) * (s.techAtkMult ?? 1), (s.treasureDefMult ?? 1) * (s.techDefMult ?? 1));
      snapshot[unit] = { count: n, ...stats };
    }
    return { ok: true, payload: { snapshot } };
  }

  /**
   * 雇佣兵入库：把雇佣兵永久加入 troops（popCost=0/upkeep=0 → reportUpkeep/reportGarrisonPop 自动零副作用，
   * 战斗快照自动含其战力）。与行军/训练是同一份 troops 数据，故雇佣兵自动参战、无需新字段/迁移。
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

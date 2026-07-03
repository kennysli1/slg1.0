import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, UnitDef } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Military（军队/兵种）
 * 对应设计文档 02_系统清单C组、1_原版拆解/03军事战斗、07_扩展与代码规范
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
  remaining: number; // 还要出几个
  nextDoneAt: number; // 下一个出兵的时刻
  taskId: string;
}

interface MilitaryState {
  villageId: string;
  /** 该村种族，决定可训练哪些兵种 */
  tribe: string;
  /** 驻村兵力：兵种 -> 数量 */
  troops: Record<string, number>;
  /** 铁匠对各兵种的强化等级（养成层） */
  smithyLevel: Record<string, number>;
  /** 当前训练队列（骨架阶段单条） */
  training: TrainOrder | null;
}

const COLLECTION = 'military';

export class MilitaryModule {
  static readonly NAME = 'military';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'military',
    publicActions: {
      GetArmy: { command: 'military.GetArmy', ownVillage: true, needAuth: true },
      TrainTroops: { command: 'military.TrainTroops', ownVillage: true, needAuth: true },
      UpgradeSmithy: { command: 'military.UpgradeSmithy', ownVillage: true, needAuth: true },
    },
    eventPushMap: {
      'military.TroopTrained': 'TroopTrained',
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

  private units(): Record<string, UnitDef> {
    return this.config.units;
  }

  init(): void {
    this.commands.register('military.GetArmy', (c) => this.getArmy(c));
    this.commands.register('military.TrainTroops', (c) => this.trainTroops(c));
    this.commands.register('military.UpgradeSmithy', (c) => this.upgradeSmithy(c));
    // 供 Combat/Movement 取"参战快照"：对外只给算好的最终三维（派生管线对外口径）
    this.commands.register('military.GetCombatSnapshot', (c) => this.getCombatSnapshot(c));
    // 增减驻村兵力（行军出征扣出、返程/训练完成加入），由 Movement 等调用
    this.commands.register('military.AdjustTroops', (c) => this.adjustTroops(c));
  }

  /** 重启恢复：为所有进行中的训练重新登记下一个出兵任务（过期则立即触发）。 */
  resume(): void {
    for (const s of this.store.all<MilitaryState>(COLLECTION)) {
      if (!s.training) continue;
      const delay = Math.max(0, s.training.nextDoneAt - this.now());
      s.training.taskId = this.scheduler.schedule(delay, () => this.produceOne(s.villageId));
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
    };
    this.store.set(COLLECTION, villageId, s);
  }

  private load(villageId: string): MilitaryState | undefined {
    return this.store.get<MilitaryState>(COLLECTION, villageId);
  }

  /** 计算驻军总耗粮(每小时)并上报 Economy。兵力变化后调用。 */
  private reportUpkeep(s: MilitaryState): void {
    let crop = 0;
    for (const [unit, n] of Object.entries(s.troops)) {
      crop += (this.config.units[unit]?.upkeep ?? 0) * n;
    }
    void this.commands.send({
      name: 'economy.SetUpkeep',
      from: MilitaryModule.NAME,
      payload: { villageId: s.villageId, source: 'troops', cropPerHour: crop },
    });
  }

  /** 派生管线：最终数值 = 基础 × (1 + 铁匠等级×每级加成)。对外只暴露这个结果（含形态/特性）。 */
  private finalStats(unit: string, smithyLv: number) {
    const def = this.config.units[unit];
    const bonus = 1 + smithyLv * this.config.constants.smithyBonusPerLevel; // 每级加成来自 config
    return {
      form: def.form,
      meleeAtk: def.meleeAtk * bonus,
      rangedAtk: def.rangedAtk * bonus,
      meleeDef: def.meleeDef * bonus,
      rangedDef: def.rangedDef * bonus,
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

  private getArmy(cmd: Command): CommandResult {
    const s = this.load((cmd.payload as any).villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    // 本族可训练兵种列表（前端据此显示）
    const trainable = Object.values(this.config.units)
      .filter((u) => u.tribe === s.tribe)
      .map((u) => ({ key: u.key, name: u.name, icon: u.icon, form: u.form, building: u.building, cost: u.cost, trainSec: u.trainSec }));
    return {
      ok: true,
      payload: {
        tribe: s.tribe,
        troops: { ...s.troops },
        smithyLevel: { ...s.smithyLevel },
        trainable,
        training: s.training
          ? { unit: s.training.unit, remaining: s.training.remaining, nextDoneAt: s.training.nextDoneAt }
          : null,
      },
    };
  }

  /** 训练：校验兵种(含种族) → 一次性预扣资源(数量×单价) → 入队，逐个产出。 */
  private async trainTroops(cmd: Command): Promise<CommandResult> {
    const { villageId, unit, count } = cmd.payload as { villageId: string; unit: string; count: number };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };

    const def = this.config.units[unit];
    if (!def) return { ok: false, payload: {}, reason: `unknown_unit:${unit}` };
    if (def.tribe !== s.tribe) return { ok: false, payload: {}, reason: 'wrong_tribe_unit' };
    if (!Number.isInteger(count) || count <= 0) return { ok: false, payload: {}, reason: 'bad_count' };
    if (s.training) return { ok: false, payload: {}, reason: 'queue_busy' };

    // 一次性预扣 count 份资源
    const totalCost: Record<string, number> = {};
    for (const [r, v] of Object.entries(def.cost)) totalCost[r] = v * count;

    const spend = await this.commands.send({
      name: 'economy.TrySpend',
      from: MilitaryModule.NAME,
      payload: { villageId, cost: totalCost },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };

    // 入队，登记第一个出兵
    const firstDoneMs = def.trainSec * 1000;
    const taskId = this.scheduler.schedule(firstDoneMs, () => this.produceOne(villageId));
    s.training = {
      unit,
      remaining: count,
      nextDoneAt: this.now() + firstDoneMs,
      taskId,
    };
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { unit, count } };
  }

  /** 出一个兵，若还有剩余则登记下一个（逐个产出）。 */
  private produceOne(villageId: string): void {
    const s = this.load(villageId);
    if (!s || !s.training) return;
    const order = s.training;

    s.troops[order.unit] = (s.troops[order.unit] ?? 0) + 1;
    order.remaining -= 1;

    if (order.remaining > 0) {
      const def = this.config.units[order.unit];
      const nextMs = def.trainSec * 1000;
      order.nextDoneAt = this.now() + nextMs;
      order.taskId = this.scheduler.schedule(nextMs, () => this.produceOne(villageId));
    } else {
      s.training = null;
    }
    this.store.set(COLLECTION, villageId, s);
    this.reportUpkeep(s);

    const evt: DomainEvent = {
      name: 'military.TroopTrained',
      source: MilitaryModule.NAME,
      ts: this.now(),
      payload: { villageId, unit: order.unit, total: s.troops[order.unit] },
    };
    void this.bus.emit(evt);
  }

  /** 铁匠升级：扣资源 → 提升某兵种养成等级（派生管线加层）。 */
  private async upgradeSmithy(cmd: Command): Promise<CommandResult> {
    const { villageId, unit } = cmd.payload as { villageId: string; unit: string };
    const s = this.load(villageId);
    if (!s) return { ok: false, payload: {}, reason: 'village_not_found' };
    if (!this.config.units[unit]) return { ok: false, payload: {}, reason: `unknown_unit:${unit}` };

    const nextLv = (s.smithyLevel[unit] ?? 0) + 1;
    const base = this.config.constants.smithyCostBase;
    const cost = { wood: base * nextLv, clay: base * nextLv }; // 成本基数来自 config
    const spend = await this.commands.send({
      name: 'economy.TrySpend',
      from: MilitaryModule.NAME,
      payload: { villageId, cost },
    });
    if (!spend.ok) return { ok: false, payload: {}, reason: spend.reason ?? 'spend_failed' };

    s.smithyLevel[unit] = nextLv;
    this.store.set(COLLECTION, villageId, s);
    return { ok: true, payload: { unit, smithyLevel: nextLv } };
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
      const stats = this.finalStats(unit, s.smithyLevel[unit] ?? 0);
      snapshot[unit] = { count: n, ...stats };
    }
    return { ok: true, payload: { snapshot } };
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
    return { ok: true, payload: { troops: { ...s.troops } } };
  }
}

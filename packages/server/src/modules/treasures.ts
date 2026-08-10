import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, TreasureDef } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';

/**
 * 领域模块 · Treasures（宝物）
 * 宝物属于城镇，储存于城镇的宝物栏（城镇中心自带 1 格；后续「宝库」建筑按等级增加格子），
 * 给该城镇提供加成或特殊效果。本模块是宝物状态的唯一 owner（铁律#1）。
 *
 * 设计要点：
 *  - 宝物栏（village.treasures）：被动宝物存于此即生效；特殊宝物(instantGold)也占格，
 *    经 treasure.Use 消费（发放金币）后移除。
 *  - 效果不在此模块内直接改经济/军事/人口，而是「推送」给各 owner 模块（铁律#4）：
 *      · 经济产出倍率 → economy.SetRateModifier(source='treasure')
 *      · 人口增长倍率 → population.SetTreasureGrowthMult
 *      · 攻防倍率     → military.SetTreasureCombatMult（作用于防守快照）
 *  - 军队携带宝物（出征+抵达转移归属）与「宝库」建筑为独立后续任务，本期仅做城镇储存+效果。
 */

/** 资源键（与 economy.RESOURCE_TYPES 对齐，但此处不复用 economy 模块以避免跨模块 import）。 */
type ResKey = 'wood' | 'clay' | 'iron' | 'crop' | 'gold';
type ResMult = Partial<Record<ResKey, number>>;

/** 聚合后的宝物效果（倍率以「乘数」表示，如 1.05 = +5%）。 */
export interface TreasureEffects {
  /** 各资源产出加成（加性分数，直接喂 economy.SetRateModifier 的 mult）。 */
  resMult: ResMult;
  /** 金币税倍率（人口交税路径单独乘，因金币无基础产出、rate modifier 对其无效）。 */
  goldMult: number;
  /** 军事攻击倍率（乘数）。 */
  atkMult: number;
  /** 军事防御倍率（乘数）。 */
  defMult: number;
  /** 人口增长倍率（乘数）。 */
  popGrowthMult: number;
}

interface TreasureState {
  villageId: string;
  /** 已储存宝物 code 列表（被动与特殊宝物同存于此；特殊宝物 use 后移除）。 */
  codes: string[];
}

const COLLECTION = 'treasure';

/**
 * 宝物栏槽位数：城镇中心自带 1 格基础栏。
 * 后续「宝库」建筑(treasury)按等级增加格子时，在此叠加其贡献
 * （查询 building.GetTreasureSlots 即可，本期宝库未实装，故恒为 1）。
 */
const TOWN_CENTER_BASE_SLOTS = 1;

export class TreasureModule {
  static readonly NAME = 'treasure';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'treasure',
    publicActions: {
      ListTreasures: { command: 'treasure.List', ownVillage: true, needAuth: true, schema: {} },
      // 使用宝物：仅对即时类(instantGold)有效，发放金币并移除；被动宝物返回 not_usable。
      UseTreasure: { command: 'treasure.Use', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 64 } } },
    },
    eventPushMap: {
      'treasure.Changed': 'TreasureChanged',
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
    this.commands.register('treasure.Grant', (c) => this.grant(c));
    this.commands.register('treasure.Use', (c) => this.use(c));
    this.commands.register('treasure.List', (c) => this.list(c));
  }

  /** 重启恢复：为每个存量村庄重算并推送效果（覆盖层改动后重载亦走此路径）。 */
  resume(): void {
    // 注意：不在此遍历其他模块的集合来补齐旧村庄的宝物文档——那样会违反铁律#1（集合归属唯一）。
    // 旧村庄（宝物模块上线前创建）的宝物文档由 ensureState 在首次 grant/list 时懒创建。
    for (const s of this.store.all<TreasureState>(COLLECTION)) {
      void this.recomputeAndPush(s.villageId);
    }
  }

  /** 重载配置后由 app 调用：重算全部村庄的推送效果。 */
  async recomputeAll(): Promise<void> {
    for (const s of this.store.all<TreasureState>(COLLECTION)) {
      await this.recomputeAndPush(s.villageId);
    }
  }

  createVillage(villageId: string): void {
    this.store.set(COLLECTION, villageId, { villageId, codes: [] } satisfies TreasureState);
    // 推送空效果（各层清零/置 1），保证其他模块的宝物修饰层存在且一致。
    void this.recomputeAndPush(villageId);
  }

  private load(villageId: string): TreasureState | undefined {
    return this.store.get<TreasureState>(COLLECTION, villageId);
  }

  /** 确保村庄有宝物状态：旧村庄在模块上线前创建、缺 treasure 文档时懒创建（避免 grant/list 报 village_not_found）。 */
  private ensureState(villageId: string): TreasureState {
    let s = this.load(villageId);
    if (!s) {
      s = { villageId, codes: [] };
      this.store.set(COLLECTION, villageId, s);
    }
    return s;
  }

  /** 当前宝物栏槽位数（城镇中心基础 1 格；宝库建筑实装后叠加）。 */
  getTreasureSlots(_villageId: string): number {
    return TOWN_CENTER_BASE_SLOTS;
  }

  /** 把已储存宝物 codes 聚合成统一效果。 */
  aggregate(codes: string[]): TreasureEffects {
    const resMult: ResMult = {};
    let goldMult = 1;
    let atkMult = 1;
    let defMult = 1;
    let popGrowthMult = 1;
    for (const code of codes) {
      const t: TreasureDef | undefined = this.config.treasures[code];
      if (!t) continue;
      const frac = t.effectValue / 100; // effectValue 为百分比
      switch (t.effectType) {
        case 'woodRate': resMult.wood = (resMult.wood ?? 0) + frac; break;
        case 'clayRate': resMult.clay = (resMult.clay ?? 0) + frac; break;
        case 'ironRate': resMult.iron = (resMult.iron ?? 0) + frac; break;
        case 'cropRate': resMult.crop = (resMult.crop ?? 0) + frac; break;
        case 'goldRate':
          resMult.gold = (resMult.gold ?? 0) + frac;
          goldMult *= 1 + frac;
          break;
        case 'allResRate':
          resMult.wood = (resMult.wood ?? 0) + frac;
          resMult.clay = (resMult.clay ?? 0) + frac;
          resMult.iron = (resMult.iron ?? 0) + frac;
          resMult.crop = (resMult.crop ?? 0) + frac;
          break;
        case 'atkMult': atkMult *= 1 + frac; break;
        case 'defMult': defMult *= 1 + frac; break;
        case 'popGrowth': popGrowthMult *= 1 + frac; break;
        case 'instantGold':
          // 即时宝物：储存时不产生被动效果，use 时一次性发放金币。
          break;
        default:
          break;
      }
    }
    return { resMult, goldMult, atkMult, defMult, popGrowthMult };
  }

  /** 重算并推送效果到 economy / population / military（铁律#4：只发命令，不回查）。 */
  async recomputeAndPush(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const eff = this.aggregate(s.codes);
    // 经济产出倍率（加性分数直接作 mult）
    await this.commands.send({
      name: 'economy.SetRateModifier', from: TreasureModule.NAME,
      payload: { villageId, source: 'treasure', mult: eff.resMult },
    });
    // 人口增长倍率 + 金币税倍率
    await this.commands.send({
      name: 'population.SetTreasureGrowthMult', from: TreasureModule.NAME,
      payload: { villageId, mult: eff.popGrowthMult, goldMult: eff.goldMult },
    });
    // 军事攻防倍率（作用于防守快照）
    await this.commands.send({
      name: 'military.SetTreasureCombatMult', from: TreasureModule.NAME,
      payload: { villageId, atkMult: eff.atkMult, defMult: eff.defMult },
    });
  }

  private async emitChanged(villageId: string): Promise<void> {
    const s = this.load(villageId);
    if (!s) return;
    const eff = this.aggregate(s.codes);
    await this.bus.emit({
      name: 'treasure.Changed', source: TreasureModule.NAME, ts: this.now(),
      payload: { villageId, codes: [...s.codes], slots: this.getTreasureSlots(villageId), effect: eff },
    } as DomainEvent);
  }

  /** 授予宝物到村庄宝物栏（受槽位限制；重复持有被拒）。 */
  private async grant(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    const t = this.config.treasures[code];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    const slots = this.getTreasureSlots(villageId);
    if (s.codes.length >= slots) {
      return { ok: false, payload: { slots, have: s.codes.length }, reason: 'treasure_slots_full' };
    }
    if (s.codes.includes(code)) return { ok: false, payload: { codes: [...s.codes] }, reason: 'already_have' };
    s.codes.push(code);
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { codes: [...s.codes], treasure: t } };
  }

  /**
   * 使用宝物：仅对特殊宝物(instantGold)有效，发放 effectValue 金币并移除。
   * 被动宝物不可「使用」，返回 reason='not_usable'。
   */
  private async use(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    const idx = s.codes.indexOf(code);
    if (idx < 0) return { ok: false, payload: {}, reason: 'not_held' };
    const t = this.config.treasures[code];
    if (!t || t.applyType !== 'instant' || t.effectType !== 'instantGold') {
      return { ok: false, payload: {}, reason: 'not_usable' };
    }
    const gold = t.effectValue;
    s.codes.splice(idx, 1);
    this.store.set(COLLECTION, villageId, s);
    // 发放金币（单向 Grant，无环）
    await this.commands.send({
      name: 'economy.Grant', from: TreasureModule.NAME,
      payload: { villageId, gain: { gold } },
    });
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { gold, codes: [...s.codes] } };
  }

  /** 列出村庄已储存宝物 + 聚合效果（客户端渲染用）。 */
  private list(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    const eff = this.aggregate(s.codes);
    return {
      ok: true,
      payload: {
        villageId,
        codes: [...s.codes],
        slots: this.getTreasureSlots(villageId),
        treasures: s.codes
          .map((code) => this.config.treasures[code])
          .filter((x): x is TreasureDef => !!x),
        effect: eff,
      },
    };
  }
}

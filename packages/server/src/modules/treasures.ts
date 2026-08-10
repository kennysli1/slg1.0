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
 *  - 军队携带宝物（出征+抵达转移归属）为独立后续任务；「宝库」建筑(treasury)已实装，按等级提供额外宝物栏槽位。
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
  /** 宝库(treasury)建筑贡献的额外宝物栏槽位（由 building 模块经 treasure.SetSlots 推送）。总槽位 = 城镇中心基础 1 格 + 此值。持久化以避免重启丢失（铁律#4：数值由 building 拥有，此处只存镜像）。 */
  extraSlots: number;
}

const COLLECTION = 'treasure';
/** 待领取宝物集合：军队带回、等待玩家确认领取的宝物（铁律#1：owner 仍是本模块）。键 = movementId。 */
const COLLECTION_PENDING = 'treasure_pending';

/** 待领取宝物（军队带回、待确认）。超时未确认由调度器自动遗弃。 */
interface PendingTreasure {
  movementId: string;
  villageId: string;
  code: string;
  name: string;
  icon: string;
  category: string;
  rarity: string;
  effectType: string;
  effectValue: number;
  applyType: string;
  priceGold: number;
  createdAt: number;
  expiresAt: number;
}

/** 待领取宝物视图（下发客户端用，含确认倒计时）。 */
interface PendingTreasureView {
  movementId: string;
  code: string;
  name: string;
  icon: string;
  category: string;
  rarity: string;
  effectType: string;
  effectValue: number;
  applyType: string;
  priceGold: number;
  expiresAt: number;
}

/**
 * 宝物栏槽位数：城镇中心自带 1 格基础栏。
 * 「宝库」建筑(treasury)按等级提供额外格子，经 treasure.SetSlots 推送叠加到本模块
 * （数值由 building 拥有，此处只存镜像，持久化避免重启丢失）。
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
      // 出售宝物：卖给 NPC 换金币(priceGold)并移除；被动/即时皆可。
      SellTreasure: { command: 'treasure.Sell', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 64 } } },
      // 丢弃宝物：直接移除（不给金币），用于腾出宝物栏格子。
      DiscardTreasure: { command: 'treasure.Discard', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 64 } } },
      // 确认领取待领取宝物（军队带回 → 战报确认；超时由服务端自动遗弃）
      ClaimPendingTreasure: { command: 'treasure.ClaimPending', ownVillage: true, needAuth: true, schema: { movementId: { type: 'string', minLen: 1, maxLen: 64 } } },
    },
    eventPushMap: {
      'treasure.Changed': 'TreasureChanged',
      'treasure.PendingDropped': 'TreasurePendingDropped',
      'treasure.PendingExpired': 'TreasurePendingExpired',
    },
  };

  constructor(
    private store: Store,
    private bus: EventBus,
    private commands: CommandBus,
    private scheduler: Scheduler,
    private now: () => number,
    private config: GameConfig,
    private rng: () => number = Math.random,
  ) {}

  /** 热重载配置（改 CSV 后调用）。 */
  setConfig(config: GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.commands.register('treasure.Grant', (c) => this.grant(c));
    this.commands.register('treasure.Use', (c) => this.use(c));
    this.commands.register('treasure.List', (c) => this.list(c));
    // 掉落结算（由 combat/pve 清营、trade 刷新等触发；铁律#2：他模块只发命令，不回查）
    this.commands.register('treasure.RollDrop', (c) => this.rollDrop(c));
    // 玩家主动出售/丢弃（客户端宝物面板触发）
    this.commands.register('treasure.Sell', (c) => this.sell(c));
    this.commands.register('treasure.Discard', (c) => this.discard(c));
    // 确认领取待领取宝物（客户端战报「确认领取」按钮触发；公开动作）
    this.commands.register('treasure.ClaimPending', (c) => this.claimPending(c));
    // 替换宝物：丢弃一个已持有的宝物并入新宝物（贸易中心「购买宝物-栏满替换」路径；内部命令）
    this.commands.register('treasure.Replace', (c) => this.replaceTreasure(c));
    // 宝库建筑推送的额外槽位（由 building 模块在建造/升级/拆除时发送；铁律#4：building 拥有数值，此处只存镜像）
    this.commands.register('treasure.SetSlots', (c) => this.setSlots(c));
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
    this.store.set(COLLECTION, villageId, { villageId, codes: [], extraSlots: 0 } satisfies TreasureState);
    // 推送空效果（各层清零/置 1），保证其他模块的宝物修饰层存在且一致。
    void this.recomputeAndPush(villageId);
  }

  /** 刷档/删村时清理本村待领取宝物并取消其超时任务（铁律#1：本模块拥有 treasure_pending 集合）。 */
  wipeSingleVillage(villageId: string): void {
    for (const p of this.store.all<PendingTreasure>(COLLECTION_PENDING)) {
      if (p.villageId === villageId) {
        this.scheduler.cancelByOwner(`treasure-pending:${p.movementId}`);
        this.store.delete(COLLECTION_PENDING, p.movementId);
      }
    }
  }

  private load(villageId: string): TreasureState | undefined {
    return this.store.get<TreasureState>(COLLECTION, villageId);
  }

  /** 确保村庄有宝物状态：旧村庄在模块上线前创建、缺 treasure 文档时懒创建（避免 grant/list 报 village_not_found）。 */
  private ensureState(villageId: string): TreasureState {
    let s = this.load(villageId);
    if (!s) {
      s = { villageId, codes: [], extraSlots: 0 };
      this.store.set(COLLECTION, villageId, s);
    }
    // 兼容旧存档（宝物模块上线前的村庄文档缺 extraSlots 字段）
    if (typeof s.extraSlots !== 'number') s.extraSlots = 0;
    return s;
  }

  /** 当前宝物栏总槽位数 = 城镇中心基础 1 格 + 宝库(treasury)建筑贡献的额外槽位（持久化镜像）。 */
  getTreasureSlots(villageId: string): number {
    return TOWN_CENTER_BASE_SLOTS + (this.load(villageId)?.extraSlots ?? 0);
  }

  /**
   * 由 building 模块推送：设置本村宝库(treasury)贡献的额外宝物栏槽位（内部命令，非客户端动作）。
   * 数值由 building 模块拥有（铁律#4），此处只存镜像并广播客户端刷新面板。
   * 槽位变小（如拆除宝库）时本模块不强制挤出已持有宝物，仅阻止后续新增，直到玩家自行腾位。
   */
  private async setSlots(cmd: Command): Promise<CommandResult> {
    const { villageId, extra } = cmd.payload as { villageId: string; extra: number };
    const s = this.ensureState(villageId);
    const next = Math.max(0, Math.floor(Number(extra) || 0));
    if (s.extraSlots === next) return { ok: true, payload: { slots: this.getTreasureSlots(villageId) } };
    s.extraSlots = next;
    this.store.set(COLLECTION, villageId, s);
    await this.emitChanged(villageId);
    return { ok: true, payload: { slots: this.getTreasureSlots(villageId) } };
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

  /**
   * 出售宝物：把已储存宝物卖给 NPC 换金币（priceGold），并从宝物栏移除、重算效果。
   * 被动/即时宝物皆可出售；即时宝物选择出售而非使用，则拿 priceGold 而非 effectValue。
   */
  private async sell(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    const idx = s.codes.indexOf(code);
    if (idx < 0) return { ok: false, payload: {}, reason: 'not_held' };
    const t = this.config.treasures[code];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    const gold = t.priceGold;
    s.codes.splice(idx, 1);
    this.store.set(COLLECTION, villageId, s);
    await this.commands.send({
      name: 'economy.Grant', from: TreasureModule.NAME,
      payload: { villageId, gain: { gold } },
    });
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { gold, codes: [...s.codes] } };
  }

  /** 丢弃宝物：直接移除（不给金币），用于腾出宝物栏格子。 */
  private async discard(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    const idx = s.codes.indexOf(code);
    if (idx < 0) return { ok: false, payload: {}, reason: 'not_held' };
    s.codes.splice(idx, 1);
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { codes: [...s.codes] } };
  }

  /**
   * 替换宝物：丢弃一个已持有的宝物(oldCode)，并入新宝物(newCode)。
   * 用于贸易中心「购买宝物-宝物栏满时替换」路径：一次性腾出格子并储存新宝物。
   * 不返还 oldCode 的金币（等价于「丢弃换新」）；新宝物重复持有或栏位不足时拒绝。
   */
  private async replaceTreasure(cmd: Command): Promise<CommandResult> {
    const { villageId, oldCode, newCode } = cmd.payload as { villageId: string; oldCode: string; newCode: string };
    const s = this.ensureState(villageId);
    if (!s.codes.includes(oldCode)) return { ok: false, payload: { codes: [...s.codes] }, reason: 'not_held' };
    if (s.codes.includes(newCode)) return { ok: false, payload: { codes: [...s.codes] }, reason: 'already_have' };
    const t = this.config.treasures[newCode];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    // 替换是「先移除 oldCode 再入 newCode」，净数量不变，原数量本就 ≤ 槽位，故无需再做槽位检查。
    s.codes = s.codes.filter((c) => c !== oldCode);
    s.codes.push(newCode);
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { codes: [...s.codes], treasure: t } };
  }

  /** 列出村庄已储存宝物 + 聚合效果 + 待领取宝物（客户端渲染用）。 */
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
        pending: this.listPending(villageId),
      },
    };
  }

  /**
   * 掉落结算：由 combat(清野营) 触发。
   *  - 先按总体概率门控（treasureCampDropChance）；
   *  - 命中后按各宝物 dropRate 加权抽选（轮盘赌）；
   *  - 抽中的宝物**不直接入栏**，而是生成一条「待领取」记录（treasure_pending），
   *    经 treasure.PendingDropped 进战报；玩家需在 treasureClaimTimeoutSec 内
   *    通过 ClaimPendingTreasure 确认领取，超时由调度器自动遗弃（treasure.PendingExpired）。
   * 这是「军队带回宝物 → 战报确认 + 超时自动遗弃」机制的服务端实现。
   */
  private async rollDrop(cmd: Command): Promise<CommandResult> {
    const { villageId, source, movementId, forceCode } = cmd.payload as {
      villageId: string;
      source: 'camp';
      /** 关联的行军 id（attack movement），用作待领取记录主键；缺省时自动生成。 */
      movementId?: string;
      /** 测试/调试用：强制抽中指定 code（跳过概率门控与加权）。 */
      forceCode?: string;
    };
    const c = this.config.constants;
    const baseChance = c.treasureCampDropChance;

    // 门控：未命中总体概率 → 无掉落
    const hit = forceCode ? true : this.rng() < baseChance;
    if (!hit) return { ok: true, payload: { dropped: null } };

    // 加权抽选宝物（按 dropRate 轮盘赌）
    const code = forceCode ?? this.weightedPick();
    if (!code) return { ok: true, payload: { dropped: null } };
    const t = this.config.treasures[code];
    if (!t) return { ok: true, payload: { dropped: null } };

    // 生成待领取记录（不直接入栏）
    const now = this.now();
    const timeoutMs = Math.max(1, Math.floor(c.treasureClaimTimeoutSec)) * 1000;
    const pid = movementId || `pend-${villageId}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const pending: PendingTreasure = {
      movementId: pid, villageId, code,
      name: t.name, icon: t.icon, category: t.category, rarity: t.rarity,
      effectType: t.effectType, effectValue: t.effectValue, applyType: t.applyType,
      priceGold: t.priceGold, createdAt: now, expiresAt: now + timeoutMs,
    };
    this.store.set(COLLECTION_PENDING, pid, pending);
    // 注册超时自动遗弃（按 village 串行，避免写竞争）
    this.scheduler.schedule(timeoutMs, () => this.expirePending(pid), `treasure-pending:${pid}`, `village:${villageId}`);

    // 进战报（待确认领取）
    await this.bus.emit({
      name: 'treasure.PendingDropped', source: TreasureModule.NAME, ts: now,
      payload: {
        villageId, movementId: pid, code, name: t.name, icon: t.icon, category: t.category,
        rarity: t.rarity, effectType: t.effectType, effectValue: t.effectValue,
        applyType: t.applyType, priceGold: t.priceGold, expiresAt: pending.expiresAt,
      },
    } as DomainEvent);

    const dropped = { code, name: t.name, rarity: t.rarity, category: t.category, pending: true, movementId: pid };
    return { ok: true, payload: { dropped } };
  }

  /**
   * 确认领取待领取宝物：把 treasure_pending 中的记录移入村庄宝物栏。
   * 受槽位/重复约束；栏满或重复持有 → 自动卖给 NPC 换金币（等价溢出处理）。
   * 成功后取消超时任务并移除待领取记录，再重算推送效果（铁律#4）。
   */
  private async claimPending(cmd: Command): Promise<CommandResult> {
    const { movementId } = cmd.payload as { movementId: string };
    const p = this.store.get<PendingTreasure>(COLLECTION_PENDING, movementId);
    if (!p) return { ok: false, payload: {}, reason: 'pending_not_found' };
    if (p.expiresAt < this.now()) {
      // 已在服务端超时（调度器尚未触发或竞态）→ 视为已遗弃
      this.store.delete(COLLECTION_PENDING, movementId);
      this.scheduler.cancelByOwner(`treasure-pending:${movementId}`);
      return { ok: false, payload: {}, reason: 'pending_expired' };
    }
    const t = this.config.treasures[p.code];
    const s = this.ensureState(p.villageId);
    const slots = this.getTreasureSlots(p.villageId);
    let sold = false;
    let gold = 0;
    if (!t || s.codes.length >= slots || s.codes.includes(p.code)) {
      // 宝物失效/栏满/重复持有 → 自动卖给 NPC 换金币（不占格）
      sold = true;
      gold = t ? t.priceGold : 0;
      if (gold > 0) {
        await this.commands.send({
          name: 'economy.Grant', from: TreasureModule.NAME,
          payload: { villageId: p.villageId, gain: { gold } },
        });
      }
    } else {
      s.codes.push(p.code);
      this.store.set(COLLECTION, p.villageId, s);
      await this.recomputeAndPush(p.villageId);
    }
    // 移除待领取记录并取消超时任务
    this.store.delete(COLLECTION_PENDING, movementId);
    this.scheduler.cancelByOwner(`treasure-pending:${movementId}`);
    await this.emitChanged(p.villageId);
    return { ok: true, payload: { treasure: t ?? { code: p.code, name: p.name }, sold, gold, codes: s.codes } };
  }

  /** 超时自动遗弃：调度器到点触发（treasureClaimTimeoutSec 后）。记录已不存在则安全跳过。 */
  private async expirePending(movementId: string): Promise<void> {
    const p = this.store.get<PendingTreasure>(COLLECTION_PENDING, movementId);
    if (!p) return;
    this.store.delete(COLLECTION_PENDING, movementId);
    await this.bus.emit({
      name: 'treasure.PendingExpired', source: TreasureModule.NAME, ts: this.now(),
      payload: {
        villageId: p.villageId, movementId, code: p.code, name: p.name, icon: p.icon,
        category: p.category, rarity: p.rarity, effectType: p.effectType,
        effectValue: p.effectValue, applyType: p.applyType, priceGold: p.priceGold,
      },
    } as DomainEvent);
  }

  /** 列出本村当前所有待领取宝物（客户端渲染战报确认卡片用）。 */
  private listPending(villageId: string): PendingTreasureView[] {
    return this.store.all<PendingTreasure>(COLLECTION_PENDING)
      .filter((p) => p.villageId === villageId)
      .map((p) => ({
        movementId: p.movementId, code: p.code, name: p.name, icon: p.icon,
        category: p.category, rarity: p.rarity, effectType: p.effectType,
        effectValue: p.effectValue, applyType: p.applyType, priceGold: p.priceGold,
        expiresAt: p.expiresAt,
      }));
  }

  /** 按各宝物 dropRate 归一化做轮盘赌，返回抽中的 code（无 dropRate>0 的宝物时返回 undefined）。 */
  private weightedPick(): string | undefined {
    const entries = Object.values(this.config.treasures).filter((t) => (t.dropRate ?? 0) > 0);
    if (entries.length === 0) return undefined;
    const total = entries.reduce((a, t) => a + t.dropRate, 0);
    let r = this.rng() * total;
    for (const t of entries) {
      r -= t.dropRate;
      if (r <= 0) return t.code;
    }
    return entries[entries.length - 1].code;
  }
}

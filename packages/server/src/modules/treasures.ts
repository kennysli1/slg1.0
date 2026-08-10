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
 *  - 宝物存放分两处：城镇中心(town, 基础1格) 与 宝库(treasury, 等级提供额外格)。新宝物优先入宝库。
 *  - 军队携带宝物（出征/运输）：treasure.AssignToArmy 把宝物装上军队（上限随兵力，
 *    min(treasureCarryMaxSlots, floor(总兵力/treasureCarryTroopsPerSlot))），在途时城镇失去加成、军队获得加成
 *    （movement 在出征快照叠加携带效果）。返程到家经 StoreCarried 存回；抵达另一村庄经 OffloadForeign
 *    转为 deliver 待处理报告；全歼时 pve 回收系统池 / pvp 转交防守方。宝库被拆除时经 SetSlots 触发
 *    「价值最高入城镇中心、其余转 deliver 报告」的归属转移。
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
  /** 城镇中心格子里的宝物（基础 1 格）。宝物在此即生效。 */
  town: string[];
  /** 宝库(treasury)格子里的宝物（容量 = extraSlots，由 building 模块经 treasure.SetSlots 推送镜像）。宝物在此即生效（优先存放点）。 */
  treasury: string[];
  /** 跟随军队的宝物：movementId → { villageId(归属村), codes }（铁律#1：本模块拥有）。宝物在途时城镇失去加成、军队获得加成。 */
  carried: Record<string, { villageId: string; codes: string[] }>;
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
  /** 来源类型：'camp'=清理野营掉落（确认即入栏，满/重复自动卖）；'deliver'=军队送达/宝库拆除（玩家须明确决定 收下/出售/遗弃）。 */
  kind: 'camp' | 'deliver';
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
  kind: 'camp' | 'deliver';
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
      // 确认领取待领取宝物（军队带回/送达 → 战报确认；超时由服务端自动遗弃）。
      // decision 仅对 kind='deliver' 的待领取必填：take=收下(替换入城镇中心)/sell=出售/discard=遗弃。
      ClaimPendingTreasure: {
        command: 'treasure.ClaimPending', ownVillage: true, needAuth: true,
        schema: {
          movementId: { type: 'string', minLen: 1, maxLen: 64 },
          decision: { type: 'enum', optional: true, values: ['take', 'sell', 'discard'] },
        },
      },
      // 把已储存的宝物装上某支出征/运输军队（携带上限由调用方按兵力计算后传入 maxCarry）。
      AssignToArmy: { command: 'treasure.AssignToArmy', ownVillage: true, needAuth: true, schema: {} },
      // 把跟随军队的宝物在返程到家后存回该村（优先宝库格子）。
      StoreCarried: { command: 'treasure.StoreCarried', ownVillage: false, needAuth: false, schema: {} },
      // 把跟随军队的宝物在抵达「另一个村庄」时转为该村庄玩家的待处理报告（deliver）。
      OffloadForeign: { command: 'treasure.OffloadForeign', ownVillage: false, needAuth: false, schema: {} },
      // 携带宝物的军队被全歼：pve=回收到系统宝物池(销毁)；pvp=转给防守方村庄作为 deliver 报告。
      LoseCarried: { command: 'treasure.LoseCarried', ownVillage: false, needAuth: false, schema: {} },
      // 查询某支军队当前携带宝物的聚合效果（供 movement 叠加到出征快照）。
      GetCarriedEffects: { command: 'treasure.GetCarriedEffects', ownVillage: false, needAuth: false, schema: {} },
    },
    eventPushMap: {
      'treasure.Changed': 'TreasureChanged',
      'treasure.PendingDropped': 'TreasurePendingDropped',
      'treasure.PendingExpired': 'TreasurePendingExpired',
      'treasure.CarriedArrived': 'TreasureCarriedArrived',
      'treasure.DemolishRedistributed': 'TreasureDemolishRedistributed',
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
    // 军队携带宝物（出征/运输时把储存的宝物装上军队；在途时城镇失去加成、军队获得加成）
    this.commands.register('treasure.AssignToArmy', (c) => this.assignToArmy(c));
    // 返程到家后把携带宝物存回该村
    this.commands.register('treasure.StoreCarried', (c) => this.storeCarried(c));
    // 抵达另一个村庄时把携带宝物转为该村庄的待处理报告
    this.commands.register('treasure.OffloadForeign', (c) => this.offloadForeign(c));
    // 携带宝物的军队被全歼：pve 回收系统池 / pvp 转交防守方
    this.commands.register('treasure.LoseCarried', (c) => this.loseCarried(c));
    // 查询某支军队携带宝物的聚合效果
    this.commands.register('treasure.GetCarriedEffects', (c) => this.getCarriedEffects(c));
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
    this.store.set(COLLECTION, villageId, { villageId, town: [], treasury: [], carried: {}, extraSlots: 0 } satisfies TreasureState);
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
    // 清理归属该村、却仍随军队在途的携带宝物（该村庄的军队一并被 movement 模块清掉）。
    for (const s of this.store.all<TreasureState>(COLLECTION)) {
      let changed = false;
      for (const mid of Object.keys(s.carried)) {
        if (s.carried[mid].villageId === villageId) { delete s.carried[mid]; changed = true; }
      }
      if (changed) this.store.set(COLLECTION, s.villageId, s);
    }
  }

  private load(villageId: string): TreasureState | undefined {
    return this.store.get<TreasureState>(COLLECTION, villageId);
  }

  /** 确保村庄有宝物状态：旧村庄在模块上线前创建、缺 treasure 文档时懒创建（避免 grant/list 报 village_not_found）。 */
  private ensureState(villageId: string): TreasureState {
    let s = this.load(villageId);
    if (!s) {
      s = { villageId, town: [], treasury: [], carried: {}, extraSlots: 0 };
      this.store.set(COLLECTION, villageId, s);
      return s;
    }
    // 兼容旧存档（宝物模块上线前的村庄文档用扁平 codes 字段 / 字段缺失 / 类型错误）
    const anyS = s as unknown as { codes?: string[] };
    let dirty = false;
    if (Array.isArray(anyS.codes)) { s.town = [...anyS.codes]; delete anyS.codes; dirty = true; }
    if (!Array.isArray(s.town)) { s.town = []; dirty = true; }
    if (!Array.isArray(s.treasury)) { s.treasury = []; dirty = true; }
    if (!s.carried || typeof s.carried !== 'object') { s.carried = {}; dirty = true; }
    // 兼容旧存档（缺 extraSlots 字段）
    if (typeof s.extraSlots !== 'number') { s.extraSlots = 0; dirty = true; }
    // 必须把归一化结果写回存档：否则重启后旧格式仍在，resume() 仍会崩溃循环
    if (dirty) this.store.set(COLLECTION, villageId, s);
    return s;
  }

  /** 当前宝物栏总槽位数 = 城镇中心基础 1 格 + 宝库(treasury)建筑贡献的额外槽位（持久化镜像）。 */
  getTreasureSlots(villageId: string): number {
    return TOWN_CENTER_BASE_SLOTS + (this.load(villageId)?.extraSlots ?? 0);
  }

  /** 城镇中心基础槽位（恒为 1）。 */
  getTownCapacity(): number {
    return TOWN_CENTER_BASE_SLOTS;
  }

  /** 宝库(treasury)当前可用额外槽位数。 */
  getTreasuryCapacity(villageId: string): number {
    return this.load(villageId)?.extraSlots ?? 0;
  }

  /** 已储存（在村）宝物 code 列表 = 城镇中心 + 宝库（不含在途携带）。 */
  private storedCodes(s: TreasureState): string[] {
    return [...(s.town ?? []), ...(s.treasury ?? [])];
  }

  /**
   * 由 building 模块推送：设置本村宝库(treasury)贡献的额外宝物栏槽位（内部命令，非客户端动作）。
   * 数值由 building 模块拥有（铁律#4），此处只存镜像并广播客户端刷新面板。
   *  - 槽位**增大**（升级/新建宝库）：直接接受，已储存宝物不动。
   *  - 槽位**缩小**（如拆除宝库）：触发「归属转移」——
   *      把 城镇中心 + 宝库 现有宝物合并，按价值降序，价值最高的放入城镇中心（1 格），
   *      其余转为该村庄的 deliver 待处理报告（玩家决定 收下/出售/遗弃）。
   *      这正是「宝库被拆除时价值最高的宝物放入城镇中心，剩下的随报告送达让玩家决定」的语义。
   */
  private async setSlots(cmd: Command): Promise<CommandResult> {
    const { villageId, extra } = cmd.payload as { villageId: string; extra: number };
    const s = this.ensureState(villageId);
    const next = Math.max(0, Math.floor(Number(extra) || 0));
    if (s.extraSlots === next) return { ok: true, payload: { slots: this.getTreasureSlots(villageId) } };

    // 增大：直接接受，无需重分布
    if (next > s.extraSlots) {
      s.extraSlots = next;
      this.store.set(COLLECTION, villageId, s);
      await this.emitChanged(villageId);
      return { ok: true, payload: { slots: this.getTreasureSlots(villageId) } };
    }

    // 缩小（拆除/降级）：归属转移
    const all = [...s.town, ...s.treasury].filter(Boolean);
    // 按价值(priceGold)降序
    all.sort((a, b) => (this.config.treasures[b]?.priceGold ?? 0) - (this.config.treasures[a]?.priceGold ?? 0));
    s.extraSlots = next;
    s.treasury = [];
    s.town = [];
    const pendingCodes: string[] = [];
    if (all.length === 0) {
      this.store.set(COLLECTION, villageId, s);
      await this.emitChanged(villageId);
      return { ok: true, payload: { slots: this.getTreasureSlots(villageId) } };
    }
    // 价值最高 → 城镇中心（1 格）
    s.town = [all[0]];
    // 其余 → deliver 待处理报告
    for (const code of all.slice(1)) {
      this.createDeliverPending(villageId, code, undefined);
      pendingCodes.push(code);
    }
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    // 广播拆除重分布事件（供通知/战报）
    await this.bus.emit({
      name: 'treasure.DemolishRedistributed', source: TreasureModule.NAME, ts: this.now(),
      payload: { villageId, kept: [all[0]], pending: pendingCodes, pendingCount: pendingCodes.length },
    } as DomainEvent);
    return { ok: true, payload: { slots: this.getTreasureSlots(villageId), kept: [all[0]], pending: pendingCodes } };
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

  /** 重算并推送效果到 economy / population / military（铁律#4：只发命令，不回查）。携带中的宝物不计入（城镇失去其加成）。 */
  async recomputeAndPush(villageId: string): Promise<void> {
    // 经 ensureState 归一化：旧存档 town/treasury 可能缺失或非数组（扁平 codes 等），
    // 直接 this.load 再 spread 会抛 "is not iterable"，导致 resume 崩溃循环。
    const s = this.ensureState(villageId);
    const eff = this.aggregate(this.storedCodes(s));
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
    const s = this.ensureState(villageId);
    const eff = this.aggregate(this.storedCodes(s));
    await this.bus.emit({
      name: 'treasure.Changed', source: TreasureModule.NAME, ts: this.now(),
      payload: {
        villageId,
        codes: this.storedCodes(s),
        town: [...s.town],
        treasury: [...s.treasury],
        carried: Object.fromEntries(Object.entries(s.carried).map(([k, v]) => [k, [...v.codes]])),
        slots: this.getTreasureSlots(villageId),
        effect: eff,
      },
    } as DomainEvent);
  }

  /** 把宝物存进村庄：优先宝库格子，其次城镇中心；满则失败（返回 false）。不触发重分布。 */
  private storeIfRoom(s: TreasureState, code: string): boolean {
    if (this.storedCodes(s).length >= this.getTreasureSlots(s.villageId)) return false;
    if (s.treasury.length < s.extraSlots) s.treasury.push(code);
    else s.town.push(code);
    return true;
  }

  /** 从已储存（town/treasury）中移除指定宝物，返回是否找到并移除。 */
  private removeStored(s: TreasureState, code: string): boolean {
    const i = s.town.indexOf(code);
    if (i >= 0) { s.town.splice(i, 1); return true; }
    const j = s.treasury.indexOf(code);
    if (j >= 0) { s.treasury.splice(j, 1); return true; }
    return false;
  }

  /**
   * 把宝物存进村庄（deliver 收下语义）：优先宝库，其次城镇中心；
   * 两者皆满时挤掉城镇中心里价值最低的宝物、把新宝物放进去（替换入城镇中心）。
   * 返回 'stored' | 'replaced' | 'full'。
   */
  private storeOne(s: TreasureState, code: string): 'stored' | 'replaced' | 'full' {
    if (s.treasury.length < s.extraSlots) { s.treasury.push(code); return 'stored'; }
    if (s.town.length < TOWN_CENTER_BASE_SLOTS) { s.town.push(code); return 'stored'; }
    // 两者皆满：仅当新宝物价值高于城镇中心里最低价者才替换（避免用低价值覆盖高价值）
    let lowIdx = -1; let lowVal = Infinity;
    s.town.forEach((c, i) => { const v = this.config.treasures[c]?.priceGold ?? 0; if (v < lowVal) { lowVal = v; lowIdx = i; } });
    const incoming = this.config.treasures[code]?.priceGold ?? 0;
    if (lowIdx >= 0 && incoming > lowVal) {
      s.town[lowIdx] = code;
      return 'replaced';
    }
    return 'full';
  }

  /** 生成一条 deliver 待领取记录（军队送达/宝库拆除）。movementId 缺省自动生成；超时自动遗弃。 */
  private createDeliverPending(villageId: string, code: string, movementId?: string): void {
    const t = this.config.treasures[code];
    if (!t) return;
    const now = this.now();
    const timeoutMs = Math.max(1, Math.floor(this.config.constants.treasureClaimTimeoutSec)) * 1000;
    const pid = movementId || `pend-${villageId}-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const pending: PendingTreasure = {
      movementId: pid, villageId, code,
      name: t.name, icon: t.icon, category: t.category, rarity: t.rarity,
      effectType: t.effectType, effectValue: t.effectValue, applyType: t.applyType,
      priceGold: t.priceGold, kind: 'deliver', createdAt: now, expiresAt: now + timeoutMs,
    };
    this.store.set(COLLECTION_PENDING, pid, pending);
    this.scheduler.schedule(timeoutMs, () => this.expirePending(pid), `treasure-pending:${pid}`, `village:${villageId}`);
  }

  /** 找到并移除某 movementId 的携带宝物，返回其 codes（不存在返回 null）。 */
  private removeCarried(movementId: string): string[] | null {
    for (const s of this.store.all<TreasureState>(COLLECTION)) {
      if (s.carried[movementId]) {
        const codes = s.carried[movementId].codes;
        delete s.carried[movementId];
        this.store.set(COLLECTION, s.villageId, s);
        return codes;
      }
    }
    return null;
  }

  /** 授予宝物到村庄宝物栏（受槽位限制；优先宝库格子；重复持有被拒）。 */
  private async grant(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    const t = this.config.treasures[code];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    if (this.storedCodes(s).includes(code)) return { ok: false, payload: { codes: this.storedCodes(s) }, reason: 'already_have' };
    if (!this.storeIfRoom(s, code)) {
      return { ok: false, payload: { slots: this.getTreasureSlots(villageId), have: this.storedCodes(s).length }, reason: 'treasure_slots_full' };
    }
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { codes: this.storedCodes(s), treasure: t } };
  }

  /**
   * 把已储存的宝物装上某支军队（出征/运输）。携带上限由调用方按兵力计算后传入 maxCarry。
   * 宝物离开 town/treasury → 不再计入城镇加成；转而随该军队生效（movement 在出征快照叠加其效果）。
   */
  private async assignToArmy(cmd: Command): Promise<CommandResult> {
    const { villageId, codes, movementId, maxCarry } = cmd.payload as {
      villageId: string; codes: string[]; movementId: string; maxCarry: number;
    };
    const s = this.ensureState(villageId);
    const want = Array.isArray(codes) ? codes.filter(Boolean) : [];
    const stored = new Set(this.storedCodes(s));
    for (const c of want) if (!stored.has(c)) return { ok: false, payload: { codes: this.storedCodes(s) }, reason: 'not_held' };
    const cap = Math.max(0, Math.floor(maxCarry ?? 0));
    const existing = s.carried[movementId]?.codes ?? [];
    if (existing.length + want.length > cap) {
      return { ok: false, payload: { cap, have: existing.length, want: want.length }, reason: 'carry_cap_exceeded' };
    }
    // 从 town/treasury 移除
    s.town = s.town.filter((c) => !want.includes(c));
    s.treasury = s.treasury.filter((c) => !want.includes(c));
    const entry = s.carried[movementId] ?? { villageId, codes: [] };
    entry.villageId = villageId;
    entry.codes = [...entry.codes, ...want];
    s.carried[movementId] = entry;
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { movementId, codes: entry.codes, cap } };
  }

  /** 返程到家：把携带宝物存回该村（优先宝库）；存不下的转为本村 deliver 报告。 */
  private async storeCarried(cmd: Command): Promise<CommandResult> {
    const { movementId, villageId } = cmd.payload as { movementId: string; villageId: string };
    const s = this.ensureState(villageId);
    const entry = s.carried[movementId];
    if (!entry || entry.codes.length === 0) return { ok: true, payload: { stored: [], pending: [] } };
    const storedCodes: string[] = [];
    const pendingCodes: string[] = [];
    for (const code of entry.codes) {
      if (this.storeIfRoom(s, code)) storedCodes.push(code);
      else pendingCodes.push(code);
    }
    delete s.carried[movementId];
    this.store.set(COLLECTION, villageId, s);
    for (const code of pendingCodes) this.createDeliverPending(villageId, code, undefined);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { stored: storedCodes, pending: pendingCodes } };
  }

  /** 抵达另一个村庄：把携带宝物转为该村庄玩家的 deliver 待处理报告（sell/discard/take）。 */
  private async offloadForeign(cmd: Command): Promise<CommandResult> {
    const { villageId, codes, fromMovementId } = cmd.payload as {
      villageId: string; codes?: string[]; fromMovementId?: string;
    };
    const got = fromMovementId ? (this.removeCarried(fromMovementId) ?? []) : (codes ?? []);
    for (const code of got) this.createDeliverPending(villageId, code, undefined);
    if (got.length > 0) {
      await this.bus.emit({
        name: 'treasure.CarriedArrived', source: TreasureModule.NAME, ts: this.now(),
        payload: { villageId, codes: got, fromMovementId },
      } as DomainEvent);
    }
    return { ok: true, payload: { villageId, codes: got } };
  }

  /**
   * 携带宝物的军队被全歼：pve=回收到系统宝物池（直接丢弃，可再掉落）；pvp=转交防守方村庄作为 deliver 报告。
   * 不论哪种，携带记录都从本模块清除（军队已不存在）。
   */
  private async loseCarried(cmd: Command): Promise<CommandResult> {
    const { movementId, mode, defenderVillage } = cmd.payload as {
      movementId: string; mode: 'pve' | 'pvp'; defenderVillage?: string;
    };
    const codes = this.removeCarried(movementId) ?? [];
    if (mode === 'pvp' && defenderVillage) {
      for (const code of codes) this.createDeliverPending(defenderVillage, code, undefined);
      if (codes.length > 0) {
        await this.bus.emit({
          name: 'treasure.CarriedArrived', source: TreasureModule.NAME, ts: this.now(),
          payload: { villageId: defenderVillage, codes, fromMovementId: movementId, captured: true },
        } as DomainEvent);
      }
    }
    // pve：codes 已被 removeCarried 清除（等价回收到系统池），无需额外动作
    return { ok: true, payload: { mode, codes } };
  }

  /** 查询某支军队当前携带宝物的聚合效果（供 movement 叠加到出征快照）。 */
  private getCarriedEffects(cmd: Command): CommandResult {
    const { movementId } = cmd.payload as { movementId: string };
    for (const s of this.store.all<TreasureState>(COLLECTION)) {
      const entry = s.carried[movementId];
      if (entry) return { ok: true, payload: { effects: this.aggregate(entry.codes) } };
    }
    return { ok: true, payload: { effects: this.aggregate([]) } };
  }

  /**
   * 使用宝物：仅对特殊宝物(instantGold)有效，发放 effectValue 金币并移除。
   * 被动宝物不可「使用」，返回 reason='not_usable'。
   */
  private async use(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    if (!this.removeStored(s, code)) return { ok: false, payload: {}, reason: 'not_held' };
    const t = this.config.treasures[code];
    if (!t || t.applyType !== 'instant' || t.effectType !== 'instantGold') {
      return { ok: false, payload: {}, reason: 'not_usable' };
    }
    const gold = t.effectValue;
    this.store.set(COLLECTION, villageId, s);
    // 发放金币（单向 Grant，无环）
    await this.commands.send({
      name: 'economy.Grant', from: TreasureModule.NAME,
      payload: { villageId, gain: { gold } },
    });
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { gold, codes: this.storedCodes(s) } };
  }

  /**
   * 出售宝物：把已储存宝物卖给 NPC 换金币（priceGold），并从宝物栏移除、重算效果。
   * 被动/即时宝物皆可出售；即时宝物选择出售而非使用，则拿 priceGold 而非 effectValue。
   */
  private async sell(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    if (!this.removeStored(s, code)) return { ok: false, payload: {}, reason: 'not_held' };
    const t = this.config.treasures[code];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    const gold = t.priceGold;
    this.store.set(COLLECTION, villageId, s);
    await this.commands.send({
      name: 'economy.Grant', from: TreasureModule.NAME,
      payload: { villageId, gain: { gold } },
    });
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { gold, codes: this.storedCodes(s) } };
  }

  /** 丢弃宝物：直接移除（不给金币），用于腾出宝物栏格子。 */
  private async discard(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    if (!this.removeStored(s, code)) return { ok: false, payload: {}, reason: 'not_held' };
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { codes: this.storedCodes(s) } };
  }

  /**
   * 替换宝物：丢弃一个已持有的宝物(oldCode)，并入新宝物(newCode)。
   * 用于贸易中心「购买宝物-宝物栏满时替换」路径：一次性腾出格子并储存新宝物。
   * 不返还 oldCode 的金币（等价于「丢弃换新」）；新宝物重复持有或栏位不足时拒绝。
   */
  private async replaceTreasure(cmd: Command): Promise<CommandResult> {
    const { villageId, oldCode, newCode } = cmd.payload as { villageId: string; oldCode: string; newCode: string };
    const s = this.ensureState(villageId);
    if (!this.storedCodes(s).includes(oldCode)) return { ok: false, payload: { codes: this.storedCodes(s) }, reason: 'not_held' };
    if (this.storedCodes(s).includes(newCode)) return { ok: false, payload: { codes: this.storedCodes(s) }, reason: 'already_have' };
    const t = this.config.treasures[newCode];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    // 替换是「先移除 oldCode 再入 newCode」，净数量不变，原数量本就 ≤ 槽位，故无需再做槽位检查。
    this.removeStored(s, oldCode);
    this.storeIfRoom(s, newCode);
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { codes: this.storedCodes(s), treasure: t } };
  }

  /** 列出村庄已储存宝物 + 聚合效果 + 待领取宝物（客户端渲染用）。 */
  private list(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    const stored = this.storedCodes(s);
    const eff = this.aggregate(stored);
    return {
      ok: true,
      payload: {
        villageId,
        codes: stored,
        town: [...s.town],
        treasury: [...s.treasury],
        carried: Object.fromEntries(Object.entries(s.carried).map(([k, v]) => [k, [...v.codes]])),
        slots: this.getTreasureSlots(villageId),
        slotBreakdown: { town: TOWN_CENTER_BASE_SLOTS, treasury: s.extraSlots, total: this.getTreasureSlots(villageId) },
        treasures: stored
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
      priceGold: t.priceGold, kind: 'camp', createdAt: now, expiresAt: now + timeoutMs,
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
   * 确认领取待领取宝物：把 treasure_pending 中的记录按决策移出。
   *  - kind='camp'（清理野营掉落）：默认收下（满/重复则自动卖）；可显式 decision=sell/discard/take。
   *  - kind='deliver'（军队送达/宝库拆除）：必填 decision：
   *      take=收下(优先宝库，无空位则替换入城镇中心)/sell=出售/discard=遗弃。
   * 超时未处理由调度器自动遗弃（treasure.PendingExpired）。
   */
  private async claimPending(cmd: Command): Promise<CommandResult> {
    const { movementId, decision } = cmd.payload as { movementId: string; decision?: 'take' | 'sell' | 'discard' };
    const p = this.store.get<PendingTreasure>(COLLECTION_PENDING, movementId);
    if (!p) return { ok: false, payload: {}, reason: 'pending_not_found' };
    if (p.expiresAt < this.now()) {
      // 已在服务端超时（调度器尚未触发或竞态）→ 视为已遗弃
      this.store.delete(COLLECTION_PENDING, movementId);
      this.scheduler.cancelByOwner(`treasure-pending:${movementId}`);
      return { ok: false, payload: {}, reason: 'pending_expired' };
    }
    if (p.kind === 'deliver' && !decision) {
      return { ok: false, payload: {}, reason: 'decision_required' };
    }
    const t = this.config.treasures[p.code];
    const s = this.ensureState(p.villageId);
    let sold = false;
    let gold = 0;
    let discarded = false;
    let stored = false;
    let replaced = false;

    if (decision === 'sell') {
      sold = true;
      gold = t ? t.priceGold : 0;
    } else if (decision === 'discard') {
      discarded = true;
    } else {
      // 'take' 或 camp 默认：收下
      if (p.kind === 'camp') {
        if (this.storeIfRoom(s, p.code)) {
          stored = true;
        } else {
          // 栏满/重复持有 → 自动卖给 NPC 换金币（等价溢出处理）
          sold = true;
          gold = t ? t.priceGold : 0;
        }
      } else {
        // deliver take：优先宝库、其次城镇中心、皆满则替换入城镇中心
        const r = this.storeOne(s, p.code);
        if (r === 'stored') {
          stored = true;
        } else if (r === 'replaced') {
          replaced = true;
        } else {
          // 栏满且新宝物价值不高于已有 → 拒绝替换，保留报告让玩家改选 sell/discard
          return { ok: false, payload: { codes: this.storedCodes(s) }, reason: 'no_room' };
        }
      }
    }

    if (sold && gold > 0) {
      await this.commands.send({
        name: 'economy.Grant', from: TreasureModule.NAME,
        payload: { villageId: p.villageId, gain: { gold } },
      });
    }
    if (stored || replaced) {
      this.store.set(COLLECTION, p.villageId, s);
      await this.recomputeAndPush(p.villageId);
    }
    // 移除待领取记录并取消超时任务
    this.store.delete(COLLECTION_PENDING, movementId);
    this.scheduler.cancelByOwner(`treasure-pending:${movementId}`);
    await this.emitChanged(p.villageId);
    return {
      ok: true,
      payload: {
        treasure: t ?? { code: p.code, name: p.name }, kind: p.kind,
        sold, gold, discarded, stored, replaced, codes: this.storedCodes(s),
      },
    };
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
        kind: p.kind, expiresAt: p.expiresAt,
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

import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig, TreasureDef } from '../infra/config.js';

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
  /** 骑兵训练速率倍率（乘数，默认 1；伯乐提供，training time 乘此值）。 */
  cavalryTrainMult: number;
  /** 精神食粮：每兵粮耗减免绝对值（加性累加，effectValue 直接累加，非百分比）。 */
  soldierFoodReduce: number;
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
  /** 本村是否拥有贸易中心（决定待领取宝物能否「出售」换金币）。由 building 模块经 treasure.SetTradeCenter 推送镜像（铁律#4：建筑拥有，此处只存镜像）。 */
  hasTradeCenter: boolean;
  /** 仅为旧存档迁移保留：早期任务宝物曾绕过栏位存入此桶。ensureState 会将其迁至正常栏位，满栏则转为待领取报告。 */
  locked: string[];
  /** 胜利的旗帜由本村拥有时累积的额外攻防百分比；易主时归零。 */
  victoryFlagBonus?: number;
  /** 已携胜利旗帜取得合格战果、等待归城的出征。 */
  victoryFlagQualified?: Record<string, true>;
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
  /** 军队到家时间戳（仅 kind='camp' 有效；deliver 在创建时已在场故无此字段）。claimPending 必须等军队归村后才允许领取 camp 掉落。 */
  arrivedAt?: number;
  /** 预计军队到家时间戳（仅 kind='camp' 有效）。rollDrop 时按运动常量估算占位，movement.onBattleEnded 创建返程后用真实 arrivesAt 精化。客户端在 !arrivedAt 时用此字段渲染「还有多久抵达」倒计时。 */
  expectedArrivalAt?: number;
  /** 该待领取宝物由「军队带出的宝物返程回家」产生（storeCarried 因满栏转出的 deliver）。仅为 UI 标记（显示「本村带回」badge），multiset 下重复不再特殊处理。 */
  fromCarry?: boolean;
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
  /** 军队到家时间戳（kind='camp' 才有，deliver 创建时已在场故为 undefined）。客户端据此前端显示「军队未归」不可领取。 */
  arrivedAt?: number;
  /** 预计军队到家时间戳（仅 camp 有效）。客户端在 arrivedAt 之前用它渲染「预计 X 抵达」倒计时。 */
  expectedArrivalAt?: number;
  /** 本村是否拥有贸易中心（决定待领取宝物能否「出售」换金币）。客户端据此决定显示「卖出」还是「丢弃」。 */
  hasTradeCenter: boolean;
  /** 该待领取宝物由「军队带出的宝物返程回家」产生（仅 UI 标记，显示「本村带回」badge）。 */
  fromCarry?: boolean;
}

/**
 * 宝物栏槽位数：城镇中心自带 1 格基础栏。
 * 「宝库」建筑(treasury)按等级提供额外格子，经 treasure.SetSlots 推送叠加到本模块
 * （数值由 building 拥有，此处只存镜像，持久化避免重启丢失）。
 */
const TOWN_CENTER_BASE_SLOTS = 1;

export class TreasureModule {
  static readonly NAME = 'treasure';



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
    // 贸易中心推送：本村是否拥有贸易中心（决定待领取宝物能否「出售」；铁律#4：building 拥有，此处只存镜像）
    this.commands.register('treasure.SetTradeCenter', (c) => this.setTradeCenter(c));
    // 军队携带宝物（出征/运输时把储存的宝物装上军队；在途时城镇失去加成、军队获得加成）
    this.commands.register('treasure.AssignToArmy', (c) => this.assignToArmy(c));
    // 返程到家后把携带宝物存回该村
    this.commands.register('treasure.StoreCarried', (c) => this.storeCarried(c));
    // 抵达另一个村庄时把携带宝物转为该村庄的待处理报告
    this.commands.register('treasure.OffloadForeign', (c) => this.offloadForeign(c));
    // 携带宝物的军队被全歼：pve 回收系统池 / pvp 转交防守方
    this.commands.register('treasure.LoseCarried', (c) => this.loseCarried(c));
    // 军队到家：标记本军队对应的 camp 掉落 pending 为已到达（仅标记，不删记录；claimPending 据此放行）
    this.commands.register('treasure.MarkPendingArrived', (c) => this.markPendingArrived(c));
    // 由 movement 模块调用：精化 camp pending 的预计归村时间为返程 movement 的真实 arrivesAt（覆盖 rollDrop 占位）。
    this.commands.register('treasure.SetExpectedArrival', (c) => this.setExpectedArrival(c));
    // 查询某支军队携带宝物的聚合效果
    this.commands.register('treasure.GetCarriedEffects', (c) => this.getCarriedEffects(c));
    this.commands.register('treasure.ExchangeQuestFlag', (c) => this.exchangeQuestFlag(c));
    this.bus.on('combat.BattleEnded', (evt: DomainEvent) => void this.onBattleEnded(evt));
  }

  /** 重启恢复：为每个存量村庄重算并推送效果（覆盖层改动后重载亦走此路径）。 */
  async resume(): Promise<void> {
    // 注意：不在此遍历其他模块的集合来补齐旧村庄的宝物文档——那样会违反铁律#1（集合归属唯一）。
    // 旧村庄（宝物模块上线前创建）的宝物文档由 ensureState 在首次 grant/list 时懒创建。
    for (const s of this.store.all<TreasureState>(COLLECTION)) {
      void this.recomputeAndPush(s.villageId);
    }
    await this.migratePendingsOnResume();
  }

  /**
   * 启动迁移：修复 pre-Bug3 修复前遗留的待领取记录。
   * 这批记录缺少 arrivedAt 字段，且其对应行军记录已随归村/全歼被删除，
   * 导致 MarkPendingArrived 从未触发、调度器超时任务也可能在服务器重启时丢失 —— 宝物卡在「等待归村」无法领取。
   * 处理：
   *  - 已过期 → 直接清理（超时任务可能因重启丢失）；
   *  - camp 类且未标记归村、对应行军已不存在（军队已归村或全歼）→ 视为已归村，允许玩家领取；
   *  - 其余未过期记录 → 重新登记调度器超时任务（防重启后丢失），归村时 MarkPendingArrived 仍会正常触发。
   */
  private async migratePendingsOnResume(): Promise<void> {
    const now = this.now();
    for (const p of this.store.all<PendingTreasure>(COLLECTION_PENDING)) {
      const owner = `treasure-pending:${p.movementId}`;
      // 1) 已超时（调度任务可能已丢失）→ 直接清理
      if (p.expiresAt <= now) {
        this.store.delete(COLLECTION_PENDING, p.movementId);
        this.scheduler.cancelByOwner(owner);
        continue;
      }
      // 2) camp 类、未标记归村、且对应行军已不存在 → 视为已归村
      //    跨模块查询走 Command（movement.GetMovement），绝不直读 movement 集合（铁律#1）。
      if (p.kind === 'camp' && !p.arrivedAt) {
        const res = await this.commands.send({
          name: 'movement.GetMovement',
          from: TreasureModule.NAME,
          payload: { movementId: p.movementId },
        });
        const exists = res.ok && ((res.payload as { exists?: boolean } | undefined)?.exists === true);
        if (!exists) {
          p.arrivedAt = now;
          this.store.set(COLLECTION_PENDING, p.movementId, p);
        }
        // 行军仍存在（军队还在外）→ 保持「等待归村」，归村时 MarkPendingArrived 会触发
      }
      // 3) 重新登记超时任务（先取消可能残留的，再登记，防重复 / 防重启丢失）
      const delay = Math.max(0, p.expiresAt - now);
      this.scheduler.cancelByOwner(owner);
      this.scheduler.schedule(delay, () => this.expirePending(p.movementId), owner, `village:${p.villageId}`);
    }
  }

  /** 重载配置后由 app 调用：重算全部村庄的推送效果。 */
  async recomputeAll(): Promise<void> {
    for (const s of this.store.all<TreasureState>(COLLECTION)) {
      await this.recomputeAndPush(s.villageId);
    }
  }

  createVillage(villageId: string): void {
    this.store.set(COLLECTION, villageId, { villageId, town: [], treasury: [], carried: {}, extraSlots: 0, hasTradeCenter: false, locked: [] } satisfies TreasureState);
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
      s = { villageId, town: [], treasury: [], carried: {}, extraSlots: 0, hasTradeCenter: false, locked: [] };
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
    // 兼容旧存档（缺 hasTradeCenter 字段）
    if (typeof s.hasTradeCenter !== 'boolean') { s.hasTradeCenter = false; dirty = true; }
    // 兼容旧存档（缺 locked 字段）
    if (!Array.isArray(s.locked)) { s.locked = []; dirty = true; }
    if (typeof s.victoryFlagBonus !== 'number') { s.victoryFlagBonus = 0; dirty = true; }
    if (!s.victoryFlagQualified || typeof s.victoryFlagQualified !== 'object') { s.victoryFlagQualified = {}; dirty = true; }
    // 兼容旧存档：宝库已扩容但城镇中心仍有宝物的历史数据，自动迁移到宝库（宝物优先存宝库）
    while (s.treasury.length < s.extraSlots && s.town.length > 0) {
      s.treasury.push(s.town.pop()!);
      dirty = true;
    }
    // multiset 语义：同一宝物可同时存在于城镇中心与宝库、或栏内重复出现（多个拷贝），不再去重；
    // 此处仅做「非字符串/空串」类型清理，剔除历史损坏数据。
    const norm = (arr: unknown[]): string[] =>
      arr.filter((x): x is string => typeof x === 'string' && x.length > 0);
    const rawTown = norm(s.town);
    const rawTreasury = norm(s.treasury);
    if (rawTown.length !== s.town.length || rawTreasury.length !== s.treasury.length) dirty = true;
    s.town = rawTown;
    s.treasury = rawTreasury;
    // 兼容旧的任务专属宝物桶：它曾绕过栏位，导致「勇士之证」等宝物
    // 不会显示在宝库或城镇中心、也无法交互。新版所有宝物都必须在栏位中。
    const rawLocked = norm(s.locked ?? []);
    if (rawLocked.length !== (s.locked ?? []).length) dirty = true;
    if (rawLocked.length) {
      s.locked = [];
      for (const code of rawLocked) {
        if (this.storeIfRoom(s, code)) continue;
        // 历史锁定宝物遇到满栏时，遵循当前任务奖励的统一规则：进入报告等待领取/出售/丢弃。
        this.createDeliverPending(villageId, code);
      }
      dirty = true;
    } else {
      s.locked = [];
    }
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

  /** 已储存 codes 的去重视图（防御性，避免任何残留重复被广播/聚合）。 */
  private storedCodesUnique(s: TreasureState): string[] {
    return Array.from(new Set(this.storedCodes(s)));
  }

  /** 已储存在村庄栏位中的宝物 code 列表。 */
  private allStoredCodes(s: TreasureState): string[] {
    return this.storedCodes(s);
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

    // 增大：宝库扩容 → 城镇中心宝物自动迁入宝库（宝物优先存宝库，城镇中心仅作兜底）
    if (next > s.extraSlots) {
      s.extraSlots = next;
      while (s.treasury.length < s.extraSlots && s.town.length > 0) {
        s.treasury.push(s.town.pop()!);
      }
      this.store.set(COLLECTION, villageId, s);
      await this.recomputeAndPush(villageId);
      await this.emitChanged(villageId);
      return { ok: true, payload: { slots: this.getTreasureSlots(villageId) } };
    }

    // 缩小（拆除/降级）：按新的总栏位保留价值最高的宝物，其余转待处理报告。
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
    // 宝库仍存在时优先填入宝库；城镇中心只使用其自带的一格。
    s.treasury = all.slice(0, next);
    if (all.length > next) s.town = [all[next]];
    // 超出新容量的其余 → deliver 待处理报告
    for (const code of all.slice(next + (all.length > next ? 1 : 0))) {
      this.createDeliverPending(villageId, code, undefined);
      pendingCodes.push(code);
    }
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    // 广播拆除重分布事件（供通知/战报）
    await this.bus.emit({
      name: 'treasure.DemolishRedistributed', source: TreasureModule.NAME, ts: this.now(),
      payload: { villageId, kept: [...s.treasury, ...s.town], pending: pendingCodes, pendingCount: pendingCodes.length },
    } as DomainEvent);
    return { ok: true, payload: { slots: this.getTreasureSlots(villageId), kept: [...s.treasury, ...s.town], pending: pendingCodes } };
  }

  /**
   * 由 building 模块推送：本村是否拥有贸易中心（决定待领取宝物能否「出售」换金币）。
   * 铁律#4：building 拥有数值，此处只存镜像并广播客户端刷新面板。
   */
  private async setTradeCenter(cmd: Command): Promise<CommandResult> {
    const { villageId, hasTradeCenter } = cmd.payload as { villageId: string; hasTradeCenter: boolean };
    const s = this.ensureState(villageId);
    const next = !!hasTradeCenter;
    if (s.hasTradeCenter === next) return { ok: true, payload: { hasTradeCenter: next } };
    s.hasTradeCenter = next;
    this.store.set(COLLECTION, villageId, s);
    await this.emitChanged(villageId);
    return { ok: true, payload: { hasTradeCenter: next } };
  }

  /** 把已储存宝物 codes 聚合成统一效果。 */
  aggregate(codes: string[], victoryFlagBonus = 0): TreasureEffects {
    const resMult: ResMult = {};
    let goldMult = 1;
    let atkMult = 1;
    let defMult = 1;
    let popGrowthMult = 1;
    let cavalryTrainMult = 1;
    let soldierFoodReduce = 0;
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
          goldMult = 1 + (goldMult - 1) + frac;
          break;
        case 'allResRate':
          resMult.wood = (resMult.wood ?? 0) + frac;
          resMult.clay = (resMult.clay ?? 0) + frac;
          resMult.iron = (resMult.iron ?? 0) + frac;
          resMult.crop = (resMult.crop ?? 0) + frac;
          break;
        case 'atkMult': atkMult = 1 + (atkMult - 1) + frac; break;
        case 'defMult': defMult = 1 + (defMult - 1) + frac; break;
        case 'popGrowth': popGrowthMult = 1 + (popGrowthMult - 1) + frac; break;
        case 'cavalryTrainSpeed': cavalryTrainMult *= (1 - frac); break; // 伯乐：效果值=减时百分比
        case 'soldierFoodReduce': soldierFoodReduce += t.effectValue; break; // 精神食粮：每兵减粮绝对值（非百分比，直接累加）
        case 'victoryFlag': {
          const total = frac + Math.max(0, victoryFlagBonus) / 100;
          atkMult = 1 + (atkMult - 1) + total;
          defMult = 1 + (defMult - 1) + total;
          break;
        }
        case 'instantGold':
          // 即时宝物：储存时不产生被动效果，use 时一次性发放金币。
          break;
        default:
          break;
      }
    }
    return { resMult, goldMult, atkMult, defMult, popGrowthMult, cavalryTrainMult, soldierFoodReduce };
  }

  /** 重算并推送效果到 economy / population / military（铁律#4：只发命令，不回查）。携带中的宝物不计入。
   *  储存维持 multiset：城镇中心/宝库中的每一件被动宝物都会生效，同名也可叠加。
   */
  async recomputeAndPush(villageId: string): Promise<void> {
    // 经 ensureState 归一化：旧存档 town/treasury 可能缺失或非数组（扁平 codes 等），
    // 直接 this.load 再 spread 会抛 "is not iterable"，导致 resume 崩溃循环。
    const s = this.ensureState(villageId);
    const eff = this.aggregate(this.allStoredCodes(s), s.victoryFlagBonus ?? 0);
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
    // 骑兵训练加速（伯乐）：总是下发（mult=1 即归零），避免移除宝物后加速永久残留
    await this.commands.send({
      name: 'military.SetTreasureCavalryTrainMult', from: TreasureModule.NAME,
      payload: { villageId, mult: eff.cavalryTrainMult },
    });
    // 精神食粮减粮：总是下发（reduce=0 即归零），避免移除宝物后减粮残留
    await this.commands.send({
      name: 'military.SetTreasureFoodReduce', from: TreasureModule.NAME,
      payload: { villageId, reduce: eff.soldierFoodReduce },
    });
  }

  private async emitChanged(villageId: string): Promise<void> {
    const s = this.ensureState(villageId);
    // multiset：广播 codes 保留重复，客户端按重复数量渲染多个持有图标（含锁定宝物）
    const codes = this.allStoredCodes(s);
    const eff = this.aggregate(codes, s.victoryFlagBonus ?? 0);
    await this.bus.emit({
      name: 'treasure.Changed', source: TreasureModule.NAME, ts: this.now(),
      payload: {
        villageId,
        codes,
        town: [...s.town],
        treasury: [...s.treasury],
        locked: [...s.locked],
        carried: Object.fromEntries(Object.entries(s.carried).map(([k, v]) => [k, [...v.codes]])),
        slots: this.getTreasureSlots(villageId),
        effect: eff,
      },
    } as DomainEvent);
  }

  /** 把宝物存进村庄：优先宝库格子，其次城镇中心；满则失败（返回 false）。不触发重分布。
 *  multiset 语义：允许重复持有同一宝物（每份占 1 格，效果在 aggregate 中累加）。
 */
  private storeIfRoom(s: TreasureState, code: string): boolean {
    if (!code) return false;
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

  /** 生成一条 deliver 待领取记录（军队送达/宝库拆除）。movementId 缺省自动生成；超时自动遗弃。fromCarry=true 表示由「军队带出的宝物返程回家」转出（收下时允许重复入栏）。 */
  private createDeliverPending(villageId: string, code: string, movementId?: string, fromCarry = false): void {
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
      fromCarry,
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

  /** 授予宝物到村庄宝物栏；任务奖励满栏时可转为待处理报告。 */
  private async grant(cmd: Command): Promise<CommandResult> {
    const { villageId, code, pendingIfFull } = cmd.payload as { villageId: string; code: string; pendingIfFull?: boolean };
    const s = this.ensureState(villageId);
    const t = this.config.treasures[code];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    if (!this.storeIfRoom(s, code)) {
      if (pendingIfFull) {
        this.createDeliverPending(villageId, code);
        await this.emitChanged(villageId);
        return { ok: true, payload: { codes: this.storedCodes(s), treasure: t, pending: true } };
      }
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
   * multiset：want 可含重复 code，按 want 出现次数精确移除 town/treasury 中的对应数量（优先城镇中心再宝库）。
   */
  private async assignToArmy(cmd: Command): Promise<CommandResult> {
    const { villageId, codes, movementId, maxCarry } = cmd.payload as {
      villageId: string; codes: string[]; movementId: string; maxCarry: number;
    };
    const s = this.ensureState(villageId);
    const want = Array.isArray(codes) ? codes.filter(Boolean) : [];
    // 统计 want 中各 code 的需求数量，并校验持有数量（multiset 下需按数量而非仅存在性判断）
    const wantCounts = new Map<string, number>();
    for (const c of want) wantCounts.set(c, (wantCounts.get(c) ?? 0) + 1);
    const storedCounts = new Map<string, number>();
    for (const c of this.storedCodes(s)) storedCounts.set(c, (storedCounts.get(c) ?? 0) + 1);
    for (const [c, n] of wantCounts) {
      if ((storedCounts.get(c) ?? 0) < n) return { ok: false, payload: { codes: this.storedCodes(s) }, reason: 'not_held' };
    }
    const cap = Math.max(0, Math.floor(maxCarry ?? 0));
    const existing = s.carried[movementId]?.codes ?? [];
    if (existing.length + want.length > cap) {
      return { ok: false, payload: { cap, have: existing.length, want: want.length }, reason: 'carry_cap_exceeded' };
    }
    // 精确移除：每个 code 移除 want 次数，优先城镇中心再宝库（不能 filter 掉所有同名，否则会把多份误删）
    const remaining = new Map<string, number>(wantCounts);
    const removeFrom = (arr: string[]): string[] => {
      const out: string[] = [];
      for (const c of arr) {
        const r = remaining.get(c) ?? 0;
        if (r > 0) remaining.set(c, r - 1);
        else out.push(c);
      }
      return out;
    };
    s.town = removeFrom(s.town);
    s.treasury = removeFrom(s.treasury);
    const entry = s.carried[movementId] ?? { villageId, codes: [] };
    entry.villageId = villageId;
    entry.codes = [...entry.codes, ...want];
    s.carried[movementId] = entry;
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    for (const [code] of wantCounts) {
      await this.bus.emit({ name: 'treasure.StoredRemoved', source: TreasureModule.NAME, ts: this.now(), payload: { villageId, code, remainingCount: this.storedCodes(s).filter((x) => x === code).length, via: 'assign' } } as DomainEvent);
    }
    return { ok: true, payload: { movementId, codes: entry.codes, cap } };
  }

  /** 返程到家：把携带宝物存回该村（优先宝库）；multiset 下重复直接再入一份，满则转 deliver 报告。 */
  private async storeCarried(cmd: Command): Promise<CommandResult> {
    const { movementId, villageId } = cmd.payload as { movementId: string; villageId: string };
    const s = this.ensureState(villageId);
    const entry = s.carried[movementId];
    if (!entry || entry.codes.length === 0) return { ok: true, payload: { stored: [], pending: [] } };
    const storedCodes: string[] = [];
    const pendingCodes: string[] = [];
    for (const code of entry.codes) {
      if (this.storeIfRoom(s, code)) {
        // 宝物栏有空位（含已有同码 → multiset 再入一份）→ 直接放回宝物栏
        storedCodes.push(code);
      } else {
        // 宝物栏已满 → 转 deliver 待处理报告（与「新获得的宝物」同等等待处理），标记 fromCarry
        pendingCodes.push(code);
      }
    }
    delete s.carried[movementId];
    // 成功战果只有在旗帜随幸存者归城并真正存回时才兑现；全灭、被夺或未归城均不会增长。
    if (storedCodes.includes('victory_flag') && s.victoryFlagQualified?.[movementId]) {
      s.victoryFlagBonus = Math.max(0, (s.victoryFlagBonus ?? 0) + 2);
      delete s.victoryFlagQualified[movementId];
    }
    this.store.set(COLLECTION, villageId, s);
    for (const code of pendingCodes) this.createDeliverPending(villageId, code, undefined, true);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    await this.bus.emit({ name: 'treasure.CarriedStored', source: TreasureModule.NAME, ts: this.now(), payload: { villageId, movementId, codes: storedCodes } } as DomainEvent);
    return { ok: true, payload: { stored: storedCodes, pending: pendingCodes } };
  }

  /** 任务归还军旗的原子兑换：先移除原旗，再以同一格子放入奖励旗。 */
  private async exchangeQuestFlag(cmd: Command): Promise<CommandResult> {
    const { villageId, fromCode, toCode } = cmd.payload as { villageId: string; fromCode: string; toCode: string };
    const s = this.ensureState(villageId);
    if (!this.config.treasures[toCode]) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    if (!this.removeStored(s, fromCode)) return { ok: false, payload: {}, reason: 'flag_not_stored' };
    this.storeIfRoom(s, toCode);
    s.victoryFlagBonus = 0;
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    return { ok: true, payload: { fromCode, toCode } };
  }

  /** 胜利旗在普通营地全灭、或成功取得 PvP 战利品后，回城才增加 2%。 */
  private async onBattleEnded(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { side?: string; villageId?: string; movementId?: string; targetKind?: string; attackerWins?: boolean; campCleared?: boolean; looted?: Record<string, number>; treasures?: string[] };
    if (p.side !== 'attacker' || !p.villageId || !p.movementId || !p.treasures?.includes('victory_flag') || !p.attackerWins) return;
    const qualifies = (p.targetKind === 'pve' && p.campCleared === true)
      || (p.targetKind === 'village' && Object.values(p.looted ?? {}).some((n) => n > 0));
    if (!qualifies) return;
    const s = this.ensureState(p.villageId);
    s.victoryFlagQualified ??= {};
    s.victoryFlagQualified[p.movementId] = true;
    this.store.set(COLLECTION, p.villageId, s);
  }

  /** 抵达另一个村庄：把携带宝物转为该村庄玩家的 deliver 待处理报告（sell/discard/take）。 */
  private async offloadForeign(cmd: Command): Promise<CommandResult> {
    const { villageId, codes, fromMovementId } = cmd.payload as {
      villageId: string; codes?: string[]; fromMovementId?: string;
    };
    const got = fromMovementId ? (this.removeCarried(fromMovementId) ?? []) : (codes ?? []);
    if (got.includes('victory_flag')) {
      const receiver = this.ensureState(villageId);
      receiver.victoryFlagBonus = 0;
      this.store.set(COLLECTION, villageId, receiver);
    }
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
    // 军队被全歼 → 该军队关联的 camp 掉落 pending 一并作废（宝物随军覆灭消失）
    const lostPending = this.cancelPending(movementId);
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
    return { ok: true, payload: { mode, codes, lostPending } };
  }

  /** 军队到家：标记本军队对应的 camp 掉落 pending 为已到达（claimPending 据此放行）。 */
  private async markPendingArrived(cmd: Command): Promise<CommandResult> {
    const { movementId } = cmd.payload as { movementId: string };
    const p = this.store.get<PendingTreasure>(COLLECTION_PENDING, movementId);
    if (!p) return { ok: true, payload: { movementId, marked: false } };
    if (p.kind !== 'camp') return { ok: true, payload: { movementId, marked: false } };
    if (p.arrivedAt) return { ok: true, payload: { movementId, marked: false } };
    const now = this.now();
    p.arrivedAt = now;
    // 超时计时器从「军队返回村庄」开始算：重置 expiresAt 并重新注册超时任务（覆盖 rollDrop 时基于掉落时刻的旧超时）
    const timeoutMs = Math.max(1, Math.floor(this.config.constants.treasureClaimTimeoutSec)) * 1000;
    p.expiresAt = now + timeoutMs;
    this.store.set(COLLECTION_PENDING, movementId, p);
    this.scheduler.cancelByOwner(`treasure-pending:${movementId}`);
    this.scheduler.schedule(timeoutMs, () => this.expirePending(movementId), `treasure-pending:${movementId}`, `village:${p.villageId}`);
    // 推动客户端 refreshAll → 重新拉取 pending（含 arrivedAt / 新的 expiresAt），让领取按钮从「等待归村」转为可点、倒计时从头开始
    await this.emitChanged(p.villageId);
    return { ok: true, payload: { movementId, marked: true, expiresAt: p.expiresAt } };
  }

  /** 由 movement.onBattleEnded 调用：用返程 movement 的真实 arrivesAt 精化 camp pending 的预计归村时间，覆盖 rollDrop 占位。 */
  private async setExpectedArrival(cmd: Command): Promise<CommandResult> {
    const { movementId, expectedArrivalAt } = cmd.payload as { movementId: string; expectedArrivalAt: number };
    const p = this.store.get<PendingTreasure>(COLLECTION_PENDING, movementId);
    if (!p) return { ok: true, payload: { movementId, updated: false } };
    p.expectedArrivalAt = expectedArrivalAt;
    this.store.set(COLLECTION_PENDING, movementId, p);
    await this.emitChanged(p.villageId);
    return { ok: true, payload: { movementId, updated: true, expectedArrivalAt } };
  }

  /** 取消指定 movementId 的 pending 记录（用于军队被全歼）；返回是否成功取消。 */
  private cancelPending(movementId: string): boolean {
    const p = this.store.get<PendingTreasure>(COLLECTION_PENDING, movementId);
    if (!p) return false;
    this.store.delete(COLLECTION_PENDING, movementId);
    this.scheduler.cancelByOwner(`treasure-pending:${movementId}`);
    return true;
  }

  /** 查询某支军队当前携带宝物的聚合效果（供 movement 叠加到出征快照）。 */
  private getCarriedEffects(cmd: Command): CommandResult {
    const { movementId } = cmd.payload as { movementId: string };
    for (const s of this.store.all<TreasureState>(COLLECTION)) {
      const entry = s.carried[movementId];
      if (entry) return { ok: true, payload: { effects: this.aggregate(entry.codes, s.victoryFlagBonus ?? 0) } };
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
    const t = this.config.treasures[code];
    // 先校验可用性再移除，避免「不可用也吞宝物」的旧隐患
    if (!t || t.applyType !== 'instant') return { ok: false, payload: {}, reason: 'not_usable' };
    if (!this.removeStored(s, code)) return { ok: false, payload: {}, reason: 'not_held' };
    this.store.set(COLLECTION, villageId, s);

    if (t.effectType === 'instantGold') {
      const gold = t.effectValue;
      // 发放金币（单向 Grant，无环）
      await this.commands.send({
        name: 'economy.Grant', from: TreasureModule.NAME,
        payload: { villageId, gain: { gold } },
      });
      await this.recomputeAndPush(villageId);
      await this.emitChanged(villageId);
      return { ok: true, payload: { gold, codes: this.storedCodes(s) } };
    }

    if (t.effectType === 'ritualBuff') {
      // 祭祀台：扣除劳动人口（不足转扣士兵）→ 全资源产量 +buffPct% 持续 durationSec 秒
      const c = this.config.constants;
      const popCost = c.ritualBuffPopCost ?? 5;
      const buffPct = t.effectValue;
      const durationSec = c.ritualBuffDurationSec ?? 7200;
      const labor = await this.commands.send({
        name: 'population.ConsumeLabor', from: TreasureModule.NAME,
        payload: { villageId, amount: popCost },
      });
      const laborConsumed = Number((labor.payload as any)?.consumed ?? 0);
      const remaining = Number((labor.payload as any)?.remaining ?? 0);
      let sacrificed: Record<string, number> = {};
      if (remaining > 0) {
        const sac = await this.commands.send({
          name: 'military.SacrificeTroops', from: TreasureModule.NAME,
          payload: { villageId, popNeed: remaining },
        });
        sacrificed = ((sac.payload as any)?.removed ?? {}) as Record<string, number>;
      }
      const frac = buffPct / 100;
      const mult = { wood: frac, clay: frac, iron: frac, crop: frac };
      await this.commands.send({
        name: 'economy.ApplyTimedBuff', from: TreasureModule.NAME,
        payload: { villageId, source: 'ritual', mult, durationSec },
      });
      await this.recomputeAndPush(villageId);
      await this.emitChanged(villageId);
      return {
        ok: true,
        payload: { buffPct, durationSec, laborConsumed, sacrificed, codes: this.storedCodes(s) },
      };
    }

    if (t.effectType === 'cavalryTrainSpeed') {
      // 伯乐：使用后按现有骑兵等比例翻倍（消耗资源 + 劳动人口）
      const res = await this.commands.send({
        name: 'military.DuplicateCavalry', from: TreasureModule.NAME,
        payload: { villageId },
      });
      await this.recomputeAndPush(villageId);
      await this.emitChanged(villageId);
      return {
        ok: true,
        payload: {
          count: (res.payload as any)?.count ?? 0,
          ratio: (res.payload as any)?.ratio ?? 0,
          spent: (res.payload as any)?.spent ?? {},
          popCost: (res.payload as any)?.popCost ?? 0,
          added: (res.payload as any)?.added ?? {},
          codes: this.storedCodes(s),
        },
      };
    }

    return { ok: false, payload: {}, reason: 'not_usable' };
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
    await this.bus.emit({ name: 'treasure.StoredRemoved', source: TreasureModule.NAME, ts: this.now(), payload: { villageId, code, remainingCount: this.storedCodes(s).filter((x) => x === code).length, via: 'sell' } } as DomainEvent);
    // 任务目标「出售/丢弃稀有+宝物」：广播出售事件供任务模块计数
    await this.bus.emit({
      name: 'treasure.SoldDiscarded', source: TreasureModule.NAME, ts: this.now(),
      payload: { villageId, code, rarity: t.rarity, via: 'sell' },
    } as DomainEvent);
    return { ok: true, payload: { gold, codes: this.storedCodes(s) } };
  }

  /** 丢弃宝物：直接移除（不给金币），用于腾出宝物栏格子。 */
  private async discard(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    const t = this.config.treasures[code];
    if (!this.removeStored(s, code)) return { ok: false, payload: {}, reason: 'not_held' };
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    await this.bus.emit({ name: 'treasure.StoredRemoved', source: TreasureModule.NAME, ts: this.now(), payload: { villageId, code, remainingCount: this.storedCodes(s).filter((x) => x === code).length, via: 'discard' } } as DomainEvent);
    // 任务目标「出售/丢弃稀有+宝物」：广播丢弃事件供任务模块计数
    if (t) {
      await this.bus.emit({
        name: 'treasure.SoldDiscarded', source: TreasureModule.NAME, ts: this.now(),
        payload: { villageId, code, rarity: t.rarity, via: 'discard' },
      } as DomainEvent);
    }
    return { ok: true, payload: { codes: this.storedCodes(s) } };
  }

  /**
   * 替换宝物：丢弃一个已持有的宝物(oldCode)，并入新宝物(newCode)。
   * 用于贸易中心「购买宝物-宝物栏满时替换」路径：一次性腾出格子并储存新宝物。
   * 不返还 oldCode 的金币（等价于「丢弃换新」）；multiset 下 newCode 已持有也允许（再入一份）。
   */
  private async replaceTreasure(cmd: Command): Promise<CommandResult> {
    const { villageId, oldCode, newCode } = cmd.payload as { villageId: string; oldCode: string; newCode: string };
    const s = this.ensureState(villageId);
    if (!this.storedCodes(s).includes(oldCode)) return { ok: false, payload: { codes: this.storedCodes(s) }, reason: 'not_held' };
    const t = this.config.treasures[newCode];
    if (!t) return { ok: false, payload: {}, reason: 'unknown_treasure' };
    // 替换是「先移除 oldCode 再入 newCode」，净数量不变，原数量本就 ≤ 槽位，故无需再做槽位检查。
    this.removeStored(s, oldCode);
    this.storeIfRoom(s, newCode);
    this.store.set(COLLECTION, villageId, s);
    await this.recomputeAndPush(villageId);
    await this.emitChanged(villageId);
    await this.bus.emit({ name: 'treasure.StoredRemoved', source: TreasureModule.NAME, ts: this.now(), payload: { villageId, code: oldCode, remainingCount: this.storedCodes(s).filter((x) => x === oldCode).length, via: 'replace' } } as DomainEvent);
    return { ok: true, payload: { codes: this.storedCodes(s), treasure: t } };
  }

  /** 列出村庄已储存宝物 + 聚合效果 + 待领取宝物（客户端渲染用）。
   *  multiset：codes 保留重复，treasures 数组按数量重复展开。
   */
  private list(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    const stored = this.allStoredCodes(s);
    const eff = this.aggregate(stored, s.victoryFlagBonus ?? 0);
    return {
      ok: true,
      payload: {
        villageId,
        codes: stored,
        town: [...s.town],
        treasury: [...s.treasury],
        locked: [...s.locked],
        carried: Object.fromEntries(Object.entries(s.carried).map(([k, v]) => [k, [...v.codes]])),
        slots: this.getTreasureSlots(villageId),
        slotBreakdown: { town: TOWN_CENTER_BASE_SLOTS, treasury: s.extraSlots, total: this.getTreasureSlots(villageId) },
        hasTradeCenter: s.hasTradeCenter,
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
    // 占位预计归村时间：rollDrop 时返程 movement 尚未创建（onBattleEnded 后才创建），
    // 此处先按 60s 占位，movement 模块在 scheduleReturn 后会通过 treasure.SetExpectedArrival 用真实 arrivesAt 精化。
    const expectedArrivalAt = now + 60_000;
    const pending: PendingTreasure = {
      movementId: pid, villageId, code,
      name: t.name, icon: t.icon, category: t.category, rarity: t.rarity,
      effectType: t.effectType, effectValue: t.effectValue, applyType: t.applyType,
      priceGold: t.priceGold, kind: 'camp', createdAt: now, expiresAt: now + timeoutMs,
      expectedArrivalAt,
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
   *  - kind='camp'（本村军队带回）：默认收下；可显式 decision=sell/discard/take。
   *  - kind='deliver'（军队送达/宝库拆除）：必填 decision：take=收下/sell=出售/discard=遗弃。
   *  - 收下(take)遇「已持有」或「宝物栏已满」一律拒绝（reason=already_have/no_room），
   *    由玩家显式选择「出售/遗弃」处理，杜绝静默自动出售。
   *  - 出售(sell)需本村拥有贸易中心（hasTradeCenter），否则拒绝 reason=no_trade_center。
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
    // camp 掉落必须等军队归村后才能领取（防止军队还在返程时直接收走宝物）
    if (p.kind === 'camp' && !p.arrivedAt) {
      return { ok: false, payload: {}, reason: 'army_not_returned' };
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

    if (decision === 'sell') {
      // 出售需贸易中心：无贸易中心则拒绝（玩家只能选择「丢弃」）
      if (!s.hasTradeCenter) {
        return { ok: false, payload: { hasTradeCenter: false }, reason: 'no_trade_center' };
      }
      sold = true;
      gold = t ? t.priceGold : 0;
    } else if (decision === 'discard') {
      discarded = true;
    } else {
      // 'take' 或 camp 默认：收下（multiset 下「重复」不再特殊处理，直接入栏再添一份；满则拒绝由玩家显式决策）
      if (this.storeIfRoom(s, p.code)) {
        stored = true;
      } else {
        // 宝物栏已满 → 拒绝领取并提示，由玩家明确决策（出售/遗弃腾位），不再自动出售
        return { ok: false, payload: { codes: this.storedCodes(s), slots: this.getTreasureSlots(p.villageId) }, reason: 'no_room' };
      }
    }

    if (sold && gold > 0) {
      await this.commands.send({
        name: 'economy.Grant', from: TreasureModule.NAME,
        payload: { villageId: p.villageId, gain: { gold } },
      });
    }
    if (stored) {
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
        sold, gold, discarded, stored, codes: this.storedCodes(s),
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
    const st = this.load(villageId);
    const hasTradeCenter = st?.hasTradeCenter ?? false;
    return this.store.all<PendingTreasure>(COLLECTION_PENDING)
      .filter((p) => p.villageId === villageId)
      .map((p) => ({
        movementId: p.movementId, code: p.code, name: p.name, icon: p.icon,
        category: p.category, rarity: p.rarity, effectType: p.effectType,
        effectValue: p.effectValue, applyType: p.applyType, priceGold: p.priceGold,
        kind: p.kind, expiresAt: p.expiresAt, arrivedAt: p.arrivedAt,
        expectedArrivalAt: p.expectedArrivalAt,
        hasTradeCenter, fromCarry: p.fromCarry,
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

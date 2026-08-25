/**
 * 领域模块 · 任务（TasksModule）
 *
 * 状态归属：task 集合按任务 scope 保存（global 锚定玩家主城，village 绑定具体村）；
 * 客户端任务页通过 GetPlayerState 分成全局区与当前村区。
 *
 * 设计要点（来自策划）：
 *  - 任务会给接了该任务的玩家在地图上显示专属内容；任务专属宝物不可出售/遗弃/丢失/超时。
 *  - 城内建筑「酒馆」用于接取日常任务：酒馆升级使日常任务刷新更频繁，且可同时接取的任务数变多。
 *  - 主线任务：全玩家共有，科技树式前置（requires），不可放弃，自动解锁（m1-m4 无需酒馆）。
 *  - 日常任务：酒馆随机刷新，可反复出现、完成后冷却可再次刷出，可放弃。
 *  - 支线任务：满足触发条件(trigger)+前置(requires)后出现的一次性任务，有任务线；放弃后永久不再出现（客户端需警告）。
 *  - v1 目标种类：submit_resources（上交资源）、clear_camp（清理地图上真实生成的任务营地）。
 *
 * 命令：
 *   task.GetState       → 完整快照（active / offered / offeredSide / completed*）
 *   task.Accept        → 接取日常(酒馆)/支线(任务栏)任务
 *   task.Abandon       → 放弃日常/支线任务（主线不可放弃）
 *   task.SubmitResources → 上交资源推进 submit_resources 类任务
 *
 * 内部订阅：
 *   building.Built / Upgraded / Demolished → 酒馆等级变化（重排随机刷新节奏 + 接取上限）
 *   combat.BattleEnded → 玩家清空任务营地时推进 clear_camp 类任务
 *
 * 跨模块协作（仅经 Commands，不读他模块 store）：
 *   world.GetTileByRef  取本村坐标
 *   world.FindFreeTile  在村内找空地放任务营地
 *   pve.Spawn / pve.Remove 生成 / 移除任务营地（task=true，不掉落/不自动重生）
 *   economy.TrySpend / economy.Grant 扣 / 发资源奖励
 *   treasure.Grant 发任务奖励；满栏时转待处理报告，由玩家决定领取、出售或丢弃
 */

import type { Store } from '../infra/store.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { GameConfig, QuestDef, QuestRewards, QuestScope } from '../infra/config.js';

const COLLECTION = 'task';

/** 已生成的任务营地（运行时，存于实例以便 resume 与客户端取坐标）。 */
interface TaskCamp {
  id: string;
  q: number;
  r: number;
  cleared: boolean;
}

/** 一个进行中的任务实例。 */
interface TaskInstance {
  code: string;
  /** 声明式任务图中的所属任务线；运行时只存引用，不复制配置。 */
  lineCode?: string;
  /** 接取时采用的任务图版本，GM 审查时可识别旧实例与新定义。 */
  definitionRevision?: string;
  type: 'main' | 'daily' | 'side';
  /** global 任务的逻辑实例存于玩家主城，但记录最后实际执行目标的村庄。 */
  executionVillageId?: string;
  /** 任务营地/NPC 生成时所在村庄；用于跨村事件和清理。 */
  spawnVillageId?: string;
  acceptedAt: number;
  /** submit_resources：已上交的资源累计。 */
  submitted: Record<string, number>;
  /** clear_camp：已生成的营地。 */
  camps: TaskCamp[];
  /** clear_camp：已清理的营地数。 */
  campCleared: number;
  /** sell_discard_treasure：已累计出售/丢弃的稀有+宝物数量。 */
  progress: number;
  /** carry_flag：已完成胜利、等待携旗归城的出征 movementId。 */
  qualifiedMovements?: string[];
  /** carry_flag：已合格且已存回本村的军旗对应出征；每项代表一面可用于交付的军旗。 */
  qualifiedFlagMovements?: string[];
  /** 目标已达成、等待玩家手动交付领取奖励。 */
  readyToDeliver?: boolean;
  spawnAttempts?: number;
  /** deliver_to_npc：NPC 村庄（幸福村）refId 与目标坐标。 */
  npcVillageId?: string;
  npcXY?: { q: number; r: number };
  /** deliver_to_npc：注入到贸易中心的幸福村订单 id。 */
  npcOrderId?: string;
  /** deliver_to_npc：订单要求的资源种类与数量。 */
  npcRes?: string;
  npcAmt?: number;
  /** deliver_to_npc：等待贸易中心建成后再生成幸福村的挂起标记。 */
  npcPending?: boolean;
  /** ② 调查坐标末营清剿后掉落的 captured_natalies 待玩家抉择（入库=完成任务 / 释放=领取奖励）。 */
  awaitingNatalieDecision?: boolean;
  /** 与 awaitingNatalieDecision 配套：等待抉择的宝物 code（当前固定 captured_natalies）。 */
  awaitingNatalieCode?: string;
  /** 玩家对 captured_natalies 的抉择结果：'store'=入库完成任务 / 'release'=释放领取奖励。 */
  natalieDecision?: 'store' | 'release';
}

/** 自动触发、尚未在客户端关闭的一次性任务对话。 */
interface PendingTaskDialogue {
  id: string;
  taskCode: string;
  trigger: string;
  /** 对话发生时的村庄；全局任务也要保留实际执行村。 */
  villageId: string;
  createdAt: number;
}

interface SerializedDialogueSession {
  id: string;
  code: string;
  taskCode: string;
  trigger: string;
  npcName: string;
  npcText: string;
  replies: { key: string; label: string }[];
}

interface TaskState {
  villageId: string;
  /** 已完成的主线任务 code。 */
  completedMain: string[];
  /** 已完成的支线任务 code（一次性，不再出现）。 */
  completedSide: string[];
  /** 已放弃的支线任务 code（一次性，永久不再出现）。 */
  abandonedSide: string[];
  /** 进行中任务：code → 实例（主线自动激活 + 接取的日常/支线）。 */
  active: Record<string, TaskInstance>;
  /** 酒馆当前展示、未接取的日常任务 code。 */
  offered: string[];
  /** 已触发、可接取的支线任务 code（不占酒馆，直接在任务栏展示）。 */
  offeredSide: string[];
  /** 已触发的支线任务触发条件 key（如 `building_built:treasury`）；触发后对应支线进入可接取。 */
  firedTriggers: string[];
  cooldownUntil?: Record<string, number>;
  pendingDialogues?: PendingTaskDialogue[];
}

interface TavernInfo {
  level: number;
  refreshSec: number;
  maxTasks: number;
}

/** 稀有度排序：普通0/稀有1/史诗2/传说3（用于「稀有及以上」判定）。 */
function rarityRank(rarity: string): number {
  const order = ['common', 'rare', 'epic', 'legendary'];
  const i = order.indexOf(rarity);
  return i < 0 ? 0 : i;
}

export class TasksModule {
  static readonly NAME = 'task';

  private config: GameConfig;
  private store: Store;
  private commands: CommandBus;
  private bus: EventBus;
  private scheduler: Scheduler;
  private now: () => number;
  private rng: () => number;

  constructor(
    store: Store, bus: EventBus, commands: CommandBus, scheduler: Scheduler,
    now: () => number, config: GameConfig, rng: () => number = Math.random,
    private playerVillages: (playerId: string) => string[] = () => [],
    private villageOwner: (villageId: string) => string | null = () => null,
    private villageName: (villageId: string) => string = (villageId) => villageId,
  ) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.commands = commands;
    this.scheduler = scheduler;
    this.now = now;
    this.rng = rng;
  }

  /** GM 热重载时更新配置。 */
  setConfig(config: GameConfig): void {
    this.config = config;
  }

  async init(): Promise<void> {
    this.commands.register('task.GetState', (c: Command) => this.getState(c));
    this.commands.register('task.GetPlayerState', (c: Command) => this.getPlayerState(c));
    this.commands.register('task.StartAccept', (c: Command) => this.startAccept(c));
    this.commands.register('task.ConsumeDialogue', (c: Command) => this.consumeDialogue(c));
    this.commands.register('task.Accept', (c: Command) => this.accept(c));
    this.commands.register('task.Abandon', (c: Command) => this.abandon(c));
    this.commands.register('task.SubmitResources', (c: Command) => this.submitResources(c));
    this.commands.register('task.Deliver', (c: Command) => this.deliver(c));
    // GM 运维命令（由 GM 面板经 commands.send({from:'gm'}) 调用，不暴露给客户端）
    this.commands.register('task.GmComplete', (c: Command) => this.gmComplete(c));
    this.commands.register('task.GmReopenCompleted', (c: Command) => this.gmReopenCompleted(c));
    this.commands.register('task.GmRefreshRandom', (c: Command) => this.gmRefreshRandom(c));
    this.commands.register('task.GmReset', (c: Command) => this.gmReset(c));
    this.commands.register('task.GmRetriggerAbandoned', (c: Command) => this.gmRetriggerAbandoned(c));

    // 酒馆建造/升级/拆除 → 重排随机刷新节奏 + 接取上限
    const onTavern = (evt: DomainEvent) => {
      const p = evt.payload as { villageId: string; kind: string };
      if (p.kind === 'tavern') void this.onTavernChanged(p.villageId);
    };
    this.bus.on('building.Built', onTavern);
    this.bus.on('building.Upgraded', onTavern);
    this.bus.on('building.Demolished', onTavern);

    // 建筑建成 → 触发带 building_built 触发条件的随机任务（如 宝库→祭祀筹备）
    this.bus.on('building.Built', (evt: DomainEvent) => void this.onBuildingBuilt(evt));

    // 出售/丢弃宝物 → 推进 sell_discard_treasure 任务
    this.bus.on('treasure.SoldDiscarded', (evt: DomainEvent) => void this.onTreasureSoldDiscarded(evt));

    // 战斗结束 → 推进 clear_camp 任务
    this.bus.on('combat.BattleEnded', (evt: DomainEvent) => void this.onBattleEnded(evt));
    this.bus.on('military.TroopTrained', (evt: DomainEvent) => void this.onTroopTrained(evt));
    this.bus.on('treasure.CarriedStored', (evt: DomainEvent) => void this.onCarriedStored(evt));
    this.bus.on('treasure.StoredRemoved', (evt: DomainEvent) => void this.onStoredRemoved(evt));
    // 商队抵达幸福村 → 完成 deliver_to_npc 目标
    this.bus.on('movement.CaravanArrivedNpc', (evt: DomainEvent) => void this.onCaravanArrivedNpc(evt));
    // 使用秘密字条生成战报 → 解锁「调查坐标」任务
    this.bus.on('treasure.ReportCoords', (evt: DomainEvent) => void this.onReportCoords(evt));
    // ② captured_natalies 报告被玩家抉择（入库/释放）→ 决定是否标记任务就绪
    this.bus.on('treasure.PendingClaimed', (evt: DomainEvent) => void this.onNatalieDecision(evt));
    this.bus.on('treasure.PendingExpired', (evt: DomainEvent) => void this.onNatalieExpired(evt));
  }

  async resume(): Promise<void> {
    for (const s of this.store.all<TaskState>(COLLECTION)) {
      // 任务营地持久化在 pve 集合。为旧存档回填 owner，并把历史遗留的全局 pve 地块收回私有 taskcamp。
      // 仅重排酒馆刷新节奏（若存在酒馆）。
      void this.resumeVillage(s.villageId).catch(() => {});
      for (const inst of Object.values(s.active)) {
        if (this.quest(inst.code)?.objective.kind !== 'clear_camp') continue;
        for (const camp of inst.camps) {
          if (!camp.cleared) await this.syncTaskCamp(inst, camp, inst.spawnVillageId ?? s.villageId);
        }
        // syncTaskCamp 可能根据现存实体回写坐标；即使没有变化，重复 set 也保持恢复路径幂等。
        this.store.set(COLLECTION, s.villageId, s);
        if (inst.camps.length < (this.quest(inst.code)?.objective.count ?? 1)) this.scheduleCampRetry(s.villageId, inst);
      // 补生成挂起的幸福村（贸易中心在任务接取后才建成的情况）
      for (const inst of Object.values(s.active)) {
        if (inst.npcPending) await this.retryNpcSpawn(s.villageId, s, inst);
      }
      }
      // 支线门槛可能在本次部署/重启前已经达到；恢复时补查，不能只依赖新训练事件。
      await this.checkTroopTriggers(s.villageId);
    }
  }

  /** 清档 / 删号：取消刷新调度、移除仍存在的任务营地、删本村 task 状态。 */
  wipeSingleVillage(villageId: string): void {
    this.scheduler.cancelByOwner(`task-refresh:${villageId}`);
    const s = this.store.get<TaskState>(COLLECTION, villageId);
    if (s) {
      for (const inst of Object.values(s.active)) {
        for (const c of inst.camps) {
          void this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: c.id } });
        }
      }
    }
    this.store.delete(COLLECTION, villageId);
  }

  // ── 建村：初始化 + 自动解锁主线 ──
  createVillage(villageId: string): void {
    const s: TaskState = { villageId, completedMain: [], completedSide: [], abandonedSide: [], active: {}, offered: [], offeredSide: [], firedTriggers: [], pendingDialogues: [] };
    this.store.set(COLLECTION, villageId, s);
    // 解锁前置已满足的主线（建村时通常仅 m1 无前置）。异步但无需等待。
    void this.unlockMainQuests(villageId).catch(() => {});
  }

  // ── 状态读写 ──
  private ensureState(villageId: string): TaskState {
    let s = this.store.get<TaskState>(COLLECTION, villageId);
    if (!s) {
      s = { villageId, completedMain: [], completedSide: [], abandonedSide: [], active: {}, offered: [], offeredSide: [], firedTriggers: [], pendingDialogues: [] };
      this.store.set(COLLECTION, villageId, s);
    }
    if (!Array.isArray(s.completedMain)) s.completedMain = [];
    if (!Array.isArray(s.completedSide)) s.completedSide = [];
    if (!Array.isArray(s.abandonedSide)) s.abandonedSide = [];
    if (!s.active || typeof s.active !== 'object') s.active = {};
    if (!Array.isArray(s.offered)) s.offered = [];
    if (!Array.isArray(s.offeredSide)) s.offeredSide = [];
    if (!Array.isArray(s.firedTriggers)) s.firedTriggers = [];
    if (!Array.isArray(s.pendingDialogues)) s.pendingDialogues = [];
    // 迁移旧字段 completedRandom → completedSide（支线）/ 丢弃（日常可反复）；旧 offered 中的支线 → offeredSide
    const legacy = s as unknown as { completedRandom?: string[] };
    if (Array.isArray(legacy.completedRandom)) {
      for (const code of legacy.completedRandom) {
        if (this.config.quests[code]?.type === 'side' && !s.completedSide.includes(code)) s.completedSide.push(code);
      }
      delete legacy.completedRandom;
    }
    if (s.offered.some((c) => this.config.quests[c]?.type === 'side')) {
      const remaining: string[] = [];
      for (const code of s.offered) {
        if (this.config.quests[code]?.type === 'side') { if (!s.offeredSide.includes(code)) s.offeredSide.push(code); }
        else remaining.push(code);
      }
      s.offered = remaining;
    }
    // 迁移旧任务 code（r1→d1, r2→d2, r3→d3, r4→s1；长支线代码→s3/s4）。
    // 任务 ID 是存档引用，改名时必须在读取路径完成惰性迁移，不能让旧实例变成“未知任务”。
    const CODE_MAP: Record<string, string> = {
      r1: 'd1', r2: 'd2', r3: 'd3', r4: 's1',
      villager_request: 's3', investigate_coords: 's4',
    };
    const remapCode = (c: string) => CODE_MAP[c] ?? c;
    s.completedSide = s.completedSide.map(remapCode);
    s.abandonedSide = s.abandonedSide.map(remapCode);
    s.offered = s.offered.map(remapCode);
    s.offeredSide = s.offeredSide.map(remapCode);
    for (const old of Object.keys(s.active)) {
      const neu = remapCode(old);
      if (neu !== old) {
        s.active[neu] = { ...s.active[old], code: neu, lineCode: this.config.questGraph.quests[neu]?.lineCode };
        delete s.active[old];
      }
    }
    s.cooldownUntil ??= {};
    for (const old of Object.keys(s.cooldownUntil)) {
      const neu = remapCode(old);
      if (neu !== old) { s.cooldownUntil[neu] = s.cooldownUntil[old]; delete s.cooldownUntil[old]; }
    }
    return s;
  }

  private load(villageId: string): TaskState | undefined {
    return this.store.get<TaskState>(COLLECTION, villageId);
  }

  private quest(code: string): QuestDef | undefined {
    return this.config.quests[code];
  }

  private questScope(code: string): QuestScope {
    const q = this.quest(code);
    return q?.scope ?? (q?.type === 'main' ? 'global' : 'village');
  }

  /** 全局任务以玩家第一座（主城）为持久化锚点；没有玩家索引的旧档退回调用村。 */
  private anchorVillage(villageId: string): string {
    const owner = this.villageOwner(villageId);
    if (!owner) return villageId;
    return this.playerVillages(owner)[0] ?? villageId;
  }

  private storageVillageForQuest(villageId: string, code: string): string {
    return this.questScope(code) === 'global' ? this.anchorVillage(villageId) : villageId;
  }

  private stateForQuest(villageId: string, code: string): TaskState {
    return this.ensureState(this.storageVillageForQuest(villageId, code));
  }

  private taskCandidates(villageId: string): { storageVillageId: string; state: TaskState }[] {
    const ids = [...new Set([villageId, this.anchorVillage(villageId)])];
    return ids.map((storageVillageId) => ({ storageVillageId, state: this.ensureState(storageVillageId) }));
  }

  /** 返回玩家名下的所有村庄；旧档或测试没有归属索引时至少保留调用村。 */
  private playerVillageIds(villageId: string): string[] {
    const owner = this.villageOwner(villageId);
    const ids = owner ? this.playerVillages(owner) : [];
    return [...new Set([...ids, villageId])];
  }

  /**
   * 查找玩家名下、仍在进行中的任务营地。
   *
   * 任务营地的 ownerVillageId 是“接取任务的村”，而不是实际出兵的村；
   * 因此不能只在 taskCandidates(attackerVillageId) 中查找。尤其是村庄级
   * 任务允许玩家从另一座己方村庄出兵，但进度、报告和奖励必须仍写回任务村。
   */
  private findTaskCamp(villageId: string, targetId: string): {
    storageVillageId: string;
    state: TaskState;
    inst: TaskInstance;
    quest: QuestDef;
    taskVillageId: string;
  } | undefined {
    const seen = new Set<string>();
    for (const taskVillageId of this.playerVillageIds(villageId)) {
      for (const q of Object.values(this.config.quests)) {
        if (q.objective.kind !== 'clear_camp') continue;
        const storageVillageId = this.storageVillageForQuest(taskVillageId, q.code);
        const key = `${storageVillageId}:${q.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const state = this.ensureState(storageVillageId);
        const inst = state.active[q.code];
        if (!inst) continue;
        const camp = inst.camps.find((item) => item.id === targetId && !item.cleared);
        if (!camp) continue;
        return {
          storageVillageId,
          state,
          inst,
          quest: q,
          // global 任务的营地仍绑定激活时村庄；旧档缺失时退回扫描到的村。
          taskVillageId: inst.spawnVillageId ?? taskVillageId,
        };
      }
    }
    return undefined;
  }

  /** 一个任务在玩家维度实际使用的存储村集合（global 任务通常只会得到主城锚点）。 */
  private playerTaskStorageIds(villageId: string, code: string): string[] {
    return [...new Set(this.playerVillageIds(villageId).map((id) => this.storageVillageForQuest(id, code)))];
  }

  /** 一次性支线只允许玩家名下一个村持有；防止另一村重新解锁或保留旧列表。 */
  private sideClaimedByPlayer(villageId: string, code: string): boolean {
    return this.playerTaskStorageIds(villageId, code).some((storageVillageId) => {
      const state = this.ensureState(storageVillageId);
      return Boolean(state.active[code])
        || state.completedSide.includes(code)
        || state.abandonedSide.includes(code);
    });
  }

  /** 接取支线时清除玩家其他村仍显示的同一可接取项。 */
  private clearPlayerSideOffers(villageId: string, code: string): void {
    for (const storageVillageId of this.playerTaskStorageIds(villageId, code)) {
      const state = this.ensureState(storageVillageId);
      if (!state.offeredSide.includes(code)) continue;
      state.offeredSide = state.offeredSide.filter((item) => item !== code);
      this.store.set(COLLECTION, storageVillageId, state);
    }
  }

  // ── 命令：GetState ──
  private getState(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    return { ok: true, payload: this.snapshotForVillage(villageId) };
  }

  /** 玩家任务板：聚合该玩家全部村庄的任务；执行动作仍携带来源村庄并走原有村庄状态。 */
  private getPlayerState(cmd: Command): CommandResult {
    const { playerId } = cmd.payload as { playerId?: string };
    if (!playerId) return { ok: false, payload: {}, reason: 'playerId_required' };
    const villageIds = [...new Set(this.playerVillages(playerId))];
    const anchor = villageIds[0];
    const global = anchor ? this.snapshot(anchor, this.ensureState(anchor), 'global') : this.emptySnapshot(anchor ?? null);
    const villages = villageIds.map((villageId) => this.snapshot(villageId, this.ensureState(villageId), 'village'));
    const activeByCode = new Map<string, Record<string, unknown>>();
    const offeredByCode = new Map<string, Record<string, unknown>>();
    const offeredSideByCode = new Map<string, Record<string, unknown>>();
    const completedMain = new Set<string>();
    const completedSide = new Set<string>();
    const abandonedSide = new Set<string>();
    const pendingDialogues = new Map<string, Record<string, unknown>>();
    for (const snap of [global, ...villages]) {
      for (const item of (snap.active as Record<string, unknown>[])) {
        const code = String(item.code ?? '');
        const prev = activeByCode.get(code);
        // 旧存档可能已在多村各有一份同 code 任务；统一任务板只展示一份，优先保留已就绪实例。
        if (!prev || (item.ready === true && prev.ready !== true)) activeByCode.set(code, item);
      }
      for (const item of (snap.offered as Record<string, unknown>[])) {
        const code = String(item.code ?? '');
        if (!offeredByCode.has(code)) offeredByCode.set(code, item);
      }
      for (const item of (snap.offeredSide as Record<string, unknown>[])) {
        const code = String(item.code ?? '');
        if (!offeredSideByCode.has(code)) offeredSideByCode.set(code, item);
      }
      for (const code of (snap.completedMain as string[])) completedMain.add(code);
      for (const code of (snap.completedSide as string[])) completedSide.add(code);
      for (const code of (snap.abandonedSide as string[])) abandonedSide.add(code);
      for (const item of ((snap.pendingDialogues as Record<string, unknown>[] | undefined) ?? [])) {
        const id = String(item.id ?? '');
        if (id && !pendingDialogues.has(id)) pendingDialogues.set(id, item);
      }
    }
    return {
      ok: true,
      payload: {
        playerId,
        villageIds,
        villages,
        global,
        active: [...activeByCode.values()],
        offered: [...offeredByCode.values()],
        offeredSide: [...offeredSideByCode.values()],
        completedMain: [...completedMain],
        completedSide: [...completedSide],
        abandonedSide: [...abandonedSide],
        pendingDialogues: [...pendingDialogues.values()],
      },
    };
  }

  private async validateAccept(villageId: string, code: string): Promise<
    { ok: true; q: QuestDef; storageVillageId: string; s: TaskState } | CommandResult
  > {
    const q = this.quest(code);
    if (!q) return { ok: false, payload: {}, reason: 'unknown_quest' };
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    if (s.active[code]) return { ok: false, payload: {}, reason: 'already_active' };
    if ((s.cooldownUntil?.[code] ?? 0) > this.now()) return { ok: false, payload: { cooldownUntil: s.cooldownUntil?.[code] }, reason: 'quest_cooldown' };

    if (q.type === 'daily') {
      if (!s.offered.includes(code)) return { ok: false, payload: {}, reason: 'not_offered' };
      const info = await this.tavernInfo(villageId);
      if (info.maxTasks <= 0) return { ok: false, payload: {}, reason: 'no_tavern' };
      const dailyActive = Object.values(s.active).filter((i) => i.type === 'daily').length;
      if (dailyActive >= info.maxTasks) return { ok: false, payload: {}, reason: 'too_many_active' };
    } else if (q.type === 'side') {
      if (!s.offeredSide.includes(code)) return { ok: false, payload: {}, reason: 'not_offered' };
      if (this.sideClaimedByPlayer(villageId, code)) return { ok: false, payload: {}, reason: 'already_claimed' };
    } else {
      return { ok: false, payload: {}, reason: 'main_auto_activated' };
    }
    return { ok: true, q, storageVillageId, s };
  }

  // ── 命令：StartAccept（检查接取资格并返回可选对话，不改变任务状态）──
  private async startAccept(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const check = await this.validateAccept(villageId, code);
    if (!check.ok) return check;
    const dialogue = await this.commands.send({
      name: 'dialogue.StartForTask', from: TasksModule.NAME,
      payload: { taskCode: code, trigger: 'accept', villageName: this.villageName(villageId) },
    });
    if (!dialogue.ok) return dialogue;
    return { ok: true, payload: { code, dialogue: (dialogue.payload as any).dialogue ?? null } };
  }

  /** 客户端关闭自动对话后确认一次；只允许从该玩家名下的任务状态移除。 */
  private consumeDialogue(cmd: Command): CommandResult {
    const { playerId, dialogueId } = cmd.payload as { playerId?: string; dialogueId?: string };
    if (!playerId || !dialogueId) return { ok: false, payload: {}, reason: 'playerId_and_dialogueId_required' };
    for (const villageId of this.playerVillages(playerId)) {
      const s = this.ensureState(villageId);
      const before = s.pendingDialogues?.length ?? 0;
      if (!before) continue;
      const next = s.pendingDialogues!.filter((item) => item.id !== dialogueId);
      if (next.length === before) continue;
      s.pendingDialogues = next;
      this.store.set(COLLECTION, villageId, s);
      return { ok: true, payload: { dialogueId } };
    }
    return { ok: false, payload: {}, reason: 'dialogue_not_found' };
  }

  // ── 命令：Accept（接取日常/支线任务）──
  private async accept(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const check = await this.validateAccept(villageId, code);
    if (!('q' in check)) return check;
    const { q, storageVillageId, s } = check;

    if (q.type === 'daily') {
      s.offered = s.offered.filter((c) => c !== code);
    } else if (q.type === 'side') {
      // 先从所有村庄移除 offer，再异步生成任务营地，避免同一玩家多村重复接取。
      this.clearPlayerSideOffers(villageId, code);
    } else {
      // 主线自动激活，不走接取
      return { ok: false, payload: {}, reason: 'main_auto_activated' };
    }

    this.store.set(COLLECTION, storageVillageId, s);
    await this.activateQuest(villageId, code);
    return { ok: true, payload: { code } };
  }

  // ── 命令：Abandon（放弃日常/支线任务；主线不可放弃）──
  private async abandon(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    const inst = s.active[code];
    if (!inst) return { ok: false, payload: {}, reason: 'not_active' };
    const q = this.quest(code);
    if (!q || q.type === 'main') return { ok: false, payload: {}, reason: 'main_cannot_abandon' };
    // 移除生成的营地
    for (const c of inst.camps) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: c.id } });
    }
    // 移除幸福村（deliver_to_npc 目标）
    if (inst.npcVillageId) await this.removeNpc(inst.spawnVillageId ?? villageId, inst);
    this.scheduler.cancelByOwner(`task-camp:${storageVillageId}:${code}`);
    delete s.active[code];
    // 支线任务：放弃后永久不再出现（记入 abandonedSide，并从可接取移除）
    if (q.type === 'side') {
      if (!s.abandonedSide.includes(code)) s.abandonedSide.push(code);
      s.offeredSide = s.offeredSide.filter((c) => c !== code);
    } else {
      // 日常任务：放弃冷却后仍可再次刷出
      s.cooldownUntil ??= {};
      s.cooldownUntil[code] = this.now() + q.abandonCooldownSec * 1000;
    }
    this.store.set(COLLECTION, storageVillageId, s);
    await this.pushList(villageId);
    await this.pushMap(villageId);
    return { ok: true, payload: { code, type: q.type } };
  }

  // ── 命令：SubmitResources（上交资源）──
  private async submitResources(cmd: Command): Promise<CommandResult> {
    const { villageId, code, resources } = cmd.payload as { villageId: string; code: string; resources: Record<string, number> };
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    const inst = s.active[code];
    if (!inst) return { ok: false, payload: {}, reason: 'not_active' };
    const q = this.quest(code);
    if (!q || q.objective.kind !== 'submit_resources') return { ok: false, payload: {}, reason: 'not_submit_quest' };
    const required = q.objective.resources ?? {};

    // 仅在「剩余需求」范围内扣资源，避免多扣
    const toSpend: Record<string, number> = {};
    for (const [res, need] of Object.entries(required)) {
      const already = inst.submitted[res] ?? 0;
      const remaining = Math.max(0, need - already);
      const want = Math.floor(Number(resources[res]) || 0);
      const amt = Math.max(0, Math.min(want, remaining));
      if (amt > 0) toSpend[res] = amt;
    }

    if (Object.keys(toSpend).length === 0) {
      // 无需扣（可能已全部满足或提交 0）
      const complete = this.submitMet(inst, required);
      if (complete) await this.markReady(villageId, code);
      return { ok: true, payload: { code, submitted: inst.submitted, remaining: this.remaining(inst, required), completed: complete } };
    }

    const spend = await this.commands.send({ name: 'economy.TrySpend', from: TasksModule.NAME, payload: { villageId, cost: toSpend } });
    if (!spend.ok) return spend; // 资源不足等

    for (const [res, amt] of Object.entries(toSpend)) {
      inst.submitted[res] = (inst.submitted[res] ?? 0) + amt;
    }
    inst.executionVillageId = villageId;
    this.store.set(COLLECTION, storageVillageId, s);

    const complete = this.submitMet(inst, required);
    if (complete) {
      await this.markReady(villageId, code);
    } else {
      await this.pushList(villageId);
    }
    return { ok: true, payload: { code, submitted: inst.submitted, remaining: this.remaining(inst, required), completed: complete } };
  }

  // ── 命令：Deliver（手动交付就绪任务，领取奖励）──
  private async deliver(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    const inst = s.active[code];
    if (!inst) return { ok: false, payload: {}, reason: 'not_active' };
    if (!inst.readyToDeliver) return { ok: false, payload: {}, reason: 'not_ready' };
    const q = this.quest(code);
    if (!q) return { ok: false, payload: {}, reason: 'unknown_quest' };
    if (q.objective.kind === 'carry_flag') {
      const returned = inst.qualifiedFlagMovements ?? [];
      if (!returned.length) return { ok: false, payload: {}, reason: 'qualifying_flag_not_stored' };
      // 多面合格军旗可用时等概率选择一面交付；军旗本体由宝物模块原子替换为胜利旗帜。
      const picked = returned[Math.floor(this.rng() * returned.length)];
      const exchange = await this.commands.send({
        name: 'treasure.ExchangeQuestFlag', from: TasksModule.NAME,
        payload: { villageId: inst.executionVillageId ?? villageId, fromCode: q.objective.flagCode ?? '', toCode: 'victory_flag' },
      });
      if (!exchange.ok) {
        inst.qualifiedFlagMovements = [];
        inst.readyToDeliver = false;
        this.store.set(COLLECTION, storageVillageId, s);
        await this.pushList(villageId);
        return { ok: false, payload: {}, reason: 'qualifying_flag_not_stored' };
      }
      inst.qualifiedFlagMovements = returned.filter((id) => id !== picked);
    }
    const rewards = await this.completeQuest(villageId, code);
    return { ok: true, payload: { code, type: q.type, rewards } };
  }

  /** 目标已达成 → 标记就绪可交付（不自动发奖），并推送给客户端。 */
  private async markReady(villageId: string, code: string): Promise<void> {
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    const inst = s.active[code];
    if (!inst || inst.readyToDeliver) return; // 幂等
    inst.readyToDeliver = true;
    inst.executionVillageId ??= villageId;
    this.store.set(COLLECTION, storageVillageId, s);
    await this.pushList(villageId);
    await this.pushMap(villageId);
  }

  // ── 激活任务（主线自动 / 随机接取共用）──
  private async activateQuest(villageId: string, code: string): Promise<void> {
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    if (s.active[code]) return; // 幂等
    const q = this.quest(code);
    if (!q) return;
    const graphQuest = this.config.questGraph.quests[code];
    const inst: TaskInstance = {
      code,
      lineCode: graphQuest?.lineCode,
      definitionRevision: 'task-graph-v1',
      type: q.type,
      executionVillageId: villageId,
      spawnVillageId: villageId,
      acceptedAt: this.now(),
      submitted: {},
      camps: [],
      campCleared: 0,
      progress: 0,
    };
    s.active[code] = inst;
    this.store.set(COLLECTION, storageVillageId, s);
    if (q.objective.kind === 'clear_camp') {
      await this.spawnCamps(villageId, inst, storageVillageId);
    } else if (q.objective.kind === 'deliver_to_npc') {
      await this.spawnNpcVillage(villageId, s, inst);
    }
    // 主线自动激活时展示“接取”对话；支线接取后展示可选的后续对话。
    // 对话定义可为空，GM 填写后仍可通过未消费的 pending 记录热生效。
    if (q.type === 'main') this.queueDialogue(storageVillageId, code, 'accept', villageId);
    else if (q.type === 'side') this.queueDialogue(storageVillageId, code, 'after_accept', villageId);
    await this.pushList(villageId);
    await this.pushMap(villageId);
  }

  private queueDialogue(storageVillageId: string, taskCode: string, trigger: string, villageId: string): void {
    const s = this.ensureState(storageVillageId);
    const pending = s.pendingDialogues ?? (s.pendingDialogues = []);
    if (pending.some((item) => item.taskCode === taskCode && item.trigger === trigger)) return;
    pending.push({
      id: `task-dialogue-${storageVillageId}-${taskCode}-${trigger}`,
      taskCode,
      trigger,
      villageId,
      createdAt: this.now(),
    });
    this.store.set(COLLECTION, storageVillageId, s);
  }

  /** 在村内找空地生成任务营地（task=true，不掉落/不自动重生）。 */
  private async spawnCamps(villageId: string, inst: TaskInstance, storageVillageId = villageId): Promise<void> {
    const q = this.quest(inst.code);
    if (!q || q.objective.kind !== 'clear_camp') return;
    const template = q.objective.campTemplate;
    if (!template || !this.config.pveTemplates[template]) return;
    const want = Math.max(1, q.objective.count ?? 1);

    const xy = await this.getVillageXY(villageId);
    if (!xy) return; // 村庄尚未落位（极端时序），交由后续解锁重试

    let placed = inst.camps.length;
    for (let i = inst.camps.length; i < want; i++) {
      const attempts = inst.spawnAttempts ?? 0;
      const radius = attempts >= 3
        ? this.config.constants.mapSize
        : Math.min(q.campMaxRadius, q.campSearchRadius + attempts * q.campSearchRadius);
      const free = await this.commands.send({ name: 'world.FindFreeTile', from: TasksModule.NAME, payload: { centerQ: xy.q, centerR: xy.r, radius } });
      if (!free.ok) break;
      const { q: cq, r: cr } = free.payload as { q: number; r: number };
      const campId = `taskcamp-${villageId}-${inst.code}-${i}`;
      const spawn = await this.commands.send({ name: 'pve.Spawn', from: TasksModule.NAME, payload: { id: campId, type: template, q: cq, r: cr, task: true, ownerVillageId: villageId } });
      if (spawn.ok) {
        inst.camps.push({ id: campId, q: cq, r: cr, cleared: false });
        placed++;
      } else {
        break;
      }
    }
    inst.spawnAttempts = (inst.spawnAttempts ?? 0) + 1;
    this.store.set(COLLECTION, storageVillageId, this.ensureState(storageVillageId));
    if (placed < want) this.scheduleCampRetry(storageVillageId, inst);
  }

  private scheduleCampRetry(villageId: string, inst: TaskInstance): void {
    const q = this.quest(inst.code);
    if (!q) return;
    const owner = `task-camp:${villageId}:${inst.code}`;
    this.scheduler.cancelByOwner(owner);
    this.scheduler.schedule(q.campRetrySec * 1000, () => {
      const current = this.ensureState(villageId).active[inst.code];
      if (current) void this.spawnCamps(current.spawnVillageId ?? villageId, current, villageId);
    }, owner, `village:${villageId}`);
  }

  // ── 完成任务：发奖励 + 收尾 + 解锁下游主线（返回实际发放的奖励，供客户端弹窗）──
  private async completeQuest(villageId: string, code: string): Promise<{ resources: Record<string, number> | null; treasures: string[]; reputation?: number; rewardVillageId?: string } | null> {
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    const inst = s.active[code];
    if (!inst) return null;
    const q = this.quest(code);
    if (!q) return null;
    const rewardVillageId = q.scope === 'global' ? (inst.executionVillageId ?? villageId) : villageId;

    // 移除残留营地
    for (const c of inst.camps) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: c.id } });
    }
    this.scheduler.cancelByOwner(`task-camp:${storageVillageId}:${code}`);

    const granted: { resources: Record<string, number> | null; treasures: string[]; reputation?: number; rewardVillageId?: string } = { resources: null, treasures: [], rewardVillageId };
    // 资源奖励
    if (q.rewards.resources && Object.keys(q.rewards.resources).length) {
      await this.commands.send({ name: 'economy.Grant', from: TasksModule.NAME, payload: { villageId: rewardVillageId, gain: q.rewards.resources } });
      granted.resources = { ...q.rewards.resources };
    }
    if (q.rewards.reputation) {
      await this.commands.send({
        name: 'reputation.AdjustByVillage', from: TasksModule.NAME,
        payload: { villageId: rewardVillageId, delta: q.rewards.reputation, reason: `task_${code}_success` },
      });
      granted.reputation = q.rewards.reputation;
    }
    // 任务专属宝物：被动(持续)类强制锁定；即时(一次性，如祭祀台)类不锁定，供玩家主动使用。
    for (const t of q.rewards.treasures ?? []) {
      // carry_flag 已在军旗归城时由 treasure.ExchangeQuestFlag 原子兑换，禁止通用奖励路径重复生成。
      if (q.objective.kind === 'carry_flag' && t === 'victory_flag') continue;
      const def = this.config.treasures[t];
      // 任务奖励与其他宝物一样占用栏位；满栏时进入待处理报告，由玩家决定领取/出售/丢弃。
      await this.commands.send({ name: 'treasure.Grant', from: TasksModule.NAME, payload: { villageId: rewardVillageId, code: t, pendingIfFull: true, rewardVillageId } });
      granted.treasures.push(t);
    }

    // captured_natalies 释放替代丢弃：玩家点「领取奖励」时才发放 500 金币 + 宝物「正直的心」。
    // natalieDecision 仅在 captured_natalies 任务被释放裁决时置为 'release'（见 onNatalieDecision）。
    if (inst.natalieDecision === 'release') {
      await this.commands.send({ name: 'economy.Grant', from: TasksModule.NAME, payload: { villageId: rewardVillageId, gain: { gold: 500 } } });
      granted.resources = { ...(granted.resources ?? {}), gold: ((granted.resources ?? {}).gold ?? 0) + 500 };
      const gh = await this.commands.send({ name: 'treasure.Grant', from: TasksModule.NAME, payload: { villageId: rewardVillageId, code: 'honest_heart', pendingIfFull: true, rewardVillageId } });
      if (gh.ok) granted.treasures.push('honest_heart');
      const releaseReputation = this.config.constants.reputationS4ReleaseDelta;
      if (releaseReputation !== 0) {
        await this.commands.send({
          name: 'reputation.AdjustByVillage', from: TasksModule.NAME,
          payload: { villageId: rewardVillageId, delta: releaseReputation, reason: 's4_release_natalies' },
        });
        granted.reputation = releaseReputation;
      }
    }

    delete s.active[code];
    if (q.type === 'main') {
      if (!s.completedMain.includes(code)) s.completedMain.push(code);
    } else if (q.type === 'side') {
      if (!s.completedSide.includes(code)) s.completedSide.push(code);
    } else {
      // 日常任务：不记完成历史（可反复），只设完成冷却
      s.cooldownUntil ??= {};
      s.cooldownUntil[code] = this.now() + q.cooldownSec * 1000;
    }
    this.store.set(COLLECTION, storageVillageId, s);

    await this.pushList(villageId);
    await this.pushMap(villageId);

    // 主线完成 → 解锁下游主线；支线完成 → 解锁下游支线（任务线）
    if (q.type === 'main') await this.unlockMainQuests(villageId);
    else if (q.type === 'side') await this.unlockSideQuests(villageId);
    return granted;
  }

  // ── GM 运维命令（由 GM 面板经 commands.send({from:'gm'}) 调用）──

  /** 强制完成某任务：移除营地、发放奖励、解锁下游（与正常完成一致）。 */
  private async gmComplete(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    if (!villageId || !code) return { ok: false, payload: {}, reason: 'villageId_and_code_required' };
    const s = this.stateForQuest(villageId, code);
    if (!s.active[code]) return { ok: false, payload: {}, reason: 'not_active' };
    await this.completeQuest(villageId, code);
    return { ok: true, payload: this.snapshotForVillage(villageId) };
  }

  /** 把已完成的一次性支线恢复为未完成，并要求再次满足触发条件才可接取。 */
  private async gmReopenCompleted(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    if (!villageId || !code) return { ok: false, payload: {}, reason: 'villageId_and_code_required' };
    const q = this.quest(code);
    if (!q) return { ok: false, payload: {}, reason: 'unknown_quest' };
    if (q.type !== 'side') return { ok: false, payload: {}, reason: 'only_completed_side_supported' };
    const s = this.stateForQuest(villageId, code);
    if (!s.completedSide.includes(code)) return { ok: false, payload: {}, reason: 'not_completed_side' };

    s.completedSide = s.completedSide.filter((x) => x !== code);
    s.offeredSide = s.offeredSide.filter((x) => x !== code);
    // 触发状态属于村庄运行态；撤销完成后必须重新触发，不能立刻再次接取。
    if (q.trigger) s.firedTriggers = s.firedTriggers.filter((x) => x !== q.trigger);
    this.store.set(COLLECTION, this.storageVillageForQuest(villageId, code), s);
    await this.pushList(villageId);
    await this.pushMap(villageId);
    // 没有触发条件的支线可立刻重新出现；有触发条件的由下一次领域事件解锁。
    if (!q.trigger) await this.unlockSideQuests(villageId);
    return { ok: true, payload: this.snapshotForVillage(villageId) };
  }

  /** ③ 把已放弃的支线任务恢复为可接取：移出 abandonedSide 并清空触发/冷却，重新进入可接取列表。 */
  private async gmRetriggerAbandoned(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    if (!villageId || !code) return { ok: false, payload: {}, reason: 'villageId_and_code_required' };
    const q = this.quest(code);
    if (!q) return { ok: false, payload: {}, reason: 'unknown_quest' };
    if (q.type !== 'side') return { ok: false, payload: {}, reason: 'only_side_supported' };
    const s = this.stateForQuest(villageId, code);
    if (!s.abandonedSide.includes(code)) return { ok: false, payload: {}, reason: 'not_abandoned' };
    s.abandonedSide = s.abandonedSide.filter((c) => c !== code);
    // 重新触发：补回触发条件并清冷却，使 unlockSideQuests 能再次把它推入可接取列表。
    // （与 gmReopenCompleted 相反：那里是已完成→需世界事件重新触发，故移除触发标记；
    //   这里是已放弃→GM 强制重新出现，故补回触发标记。）
    if (q.trigger && !s.firedTriggers.includes(q.trigger)) s.firedTriggers.push(q.trigger);
    if (s.cooldownUntil) delete s.cooldownUntil[code];
    this.store.set(COLLECTION, this.storageVillageForQuest(villageId, code), s);
    await this.unlockSideQuests(villageId);
    return { ok: true, payload: this.snapshotForVillage(villageId) };
  }

  /** ② captured_natalies 报告被玩家抉择（入库/释放）→ 标记调查坐标任务就绪。 */
  private async onNatalieDecision(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId: string; code: string; stored?: boolean; released?: boolean };
    if (p.code !== 'captured_natalies') return;
    const s = this.load(p.villageId);
    if (!s) return;
    const inst = Object.values(s.active).find((i) => i.awaitingNatalieDecision && i.awaitingNatalieCode === 'captured_natalies');
    if (!inst) return;
    inst.awaitingNatalieDecision = false;
    inst.natalieDecision = p.released ? 'release' : 'store';
    if (!p.released) {
      const failureReputation = this.quest(inst.code)?.failureRewards?.reputation ?? 0;
      if (failureReputation !== 0) {
        await this.commands.send({
          name: 'reputation.AdjustByVillage', from: TasksModule.NAME,
          payload: { villageId: p.villageId, delta: failureReputation, reason: 's4_store_natalies' },
        });
      }
      const code = inst.code;
      delete s.active[code];
      if (!s.abandonedSide.includes(code)) s.abandonedSide.push(code);
      this.store.set(COLLECTION, p.villageId, s);
      await this.pushList(p.villageId);
      await this.pushMap(p.villageId);
      return;
    }
    this.store.set(COLLECTION, p.villageId, s);
    await this.markReady(p.villageId, inst.code);
  }

  /** ② captured_natalies 报告超时未处理：重新投放，给玩家再次抉择机会（避免任务卡死）。 */
  private async onNatalieExpired(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId: string; code: string };
    if (p.code !== 'captured_natalies') return;
    const s = this.load(p.villageId);
    if (!s) return;
    const inst = Object.values(s.active).find((i) => i.awaitingNatalieDecision && i.awaitingNatalieCode === 'captured_natalies');
    if (!inst) return;
    await this.commands.send({
      name: 'treasure.Grant', from: TasksModule.NAME,
      payload: { villageId: p.villageId, code: 'captured_natalies', pendingIfFull: true },
    });
  }

  /** 清理任务营地并将进度写回任务所属村。实际出兵村只负责提供战斗结果。 */
  private async applyTaskCampBattle(
    attackerVillageId: string,
    match: NonNullable<ReturnType<TasksModule['findTaskCamp']>>,
    payload: { targetId: string; movementId?: string },
  ): Promise<void> {
    const { storageVillageId, state, inst, quest: q, taskVillageId } = match;
    const camp = inst.camps.find((item) => item.id === payload.targetId && !item.cleared);
    if (!camp) return;
    camp.cleared = true;
    // 全局任务沿用“最后实际执行村”奖励口径；村庄任务永远锁定接取村。
    const updateVillageId = q.scope === 'global' ? attackerVillageId : taskVillageId;
    inst.executionVillageId = updateVillageId;
    inst.campCleared = (inst.campCleared ?? 0) + 1;
    this.store.set(COLLECTION, storageVillageId, state);

    if (inst.campCleared >= inst.camps.length) {
      // 任务营地的待领取报告也归任务村；普通战利品仍由 Movement 按出兵村返还。
      await this.commands.send({
        name: 'treasure.RollDrop', from: TasksModule.NAME,
        payload: {
          villageId: updateVillageId,
          source: 'camp',
          movementId: payload.movementId,
          forceCode: 'captured_natalies',
        },
      });
      if (q.code === 's4') {
        inst.awaitingNatalieDecision = true;
        inst.awaitingNatalieCode = 'captured_natalies';
        this.store.set(COLLECTION, storageVillageId, state);
        await this.pushList(updateVillageId);
        await this.pushMap(updateVillageId);
      } else {
        await this.markReady(updateVillageId, q.code);
      }
    } else {
      await this.pushList(updateVillageId);
      await this.pushMap(updateVillageId);
    }
  }

  /**
   * 任务营地战败时不推进任务，也不让地图实体丢失。
   *
   * 任务营地不使用普通 PvE 的“清空后生命周期”：即使旧版本/并发结算已经
   * 删除了 pve 实体，仍要按任务快照坐标补回，直到任务放弃或正式交付完成。
   * 当前任务图没有“战败即任务失败”的目标，因此默认全部走保留路径。
   */
  private async preserveTaskCampAfterDefeat(villageId: string, targetId: string): Promise<void> {
    const match = this.findTaskCamp(villageId, targetId);
    if (!match) return;
    const camp = match.inst.camps.find((item) => item.id === targetId && !item.cleared);
    if (!camp) return;
    await this.syncTaskCamp(match.inst, camp, match.taskVillageId);
    this.store.set(COLLECTION, match.storageVillageId, match.state);
    await this.pushList(match.taskVillageId);
    await this.pushMap(match.taskVillageId);
  }

  /**
   * 恢复时校准任务状态与 PvE 实体的坐标。
   * 旧版本曾把同一任务的地图实体写在另一座村庄附近，导致任务卡和地图各显示一套坐标；
   * 任务实例保存的坐标是接取时的权威快照，空地可用时把实体搬回该坐标，否则采用现有实体
   * 坐标并回写任务快照，保证之后所有端都只读同一份坐标。
   */
  private async syncTaskCamp(inst: TaskInstance, camp: TaskCamp, ownerVillageId: string): Promise<void> {
    const q = this.quest(inst.code);
    const template = q?.objective.kind === 'clear_camp' ? q.objective.campTemplate : undefined;
    if (!template || !this.config.pveTemplates[template]) return;
    const target = await this.commands.send({ name: 'pve.GetTarget', from: TasksModule.NAME, payload: { id: camp.id } });
    if (!target.ok) {
      await this.commands.send({
        name: 'pve.Spawn', from: TasksModule.NAME,
        payload: { id: camp.id, type: template, q: camp.q, r: camp.r, task: true, ownerVillageId },
      });
      return;
    }
    const current = target.payload as { q?: number; r?: number; cleared?: boolean };
    // 战败恢复路径可能遇到旧状态已被标成 cleared、但任务实例仍未完成的实体；
    // 重新生成守军，避免地图标记还在却变成空营地，导致下一次出征被瞬间判定成功。
    if (current.cleared === true) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: camp.id } });
      await this.commands.send({
        name: 'pve.Spawn', from: TasksModule.NAME,
        payload: { id: camp.id, type: template, q: camp.q, r: camp.r, task: true, ownerVillageId },
      });
      return;
    }
    if (Number(current.q) === camp.q && Number(current.r) === camp.r) {
      await this.commands.send({ name: 'pve.AssignTaskOwner', from: TasksModule.NAME, payload: { id: camp.id, ownerVillageId } });
      return;
    }
    const tile = await this.commands.send({ name: 'world.GetTile', from: TasksModule.NAME, payload: { q: camp.q, r: camp.r } });
    const tileKind = (tile.payload as any)?.tile?.kind;
    if (tile.ok && (!tileKind || tileKind === 'empty')) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: camp.id } });
      await this.commands.send({
        name: 'pve.Spawn', from: TasksModule.NAME,
        payload: { id: camp.id, type: template, q: camp.q, r: camp.r, task: true, ownerVillageId },
      });
      return;
    }
    // 目标坐标已被其它设施占用，不能覆盖它；把任务快照改为现有实体坐标，避免双重标记。
    camp.q = Number(current.q);
    camp.r = Number(current.r);
  }

  /** 刷新酒馆随机任务（按权重重新抽取，填满接取上限）。 */
  private async gmRefreshRandom(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    if (!villageId) return { ok: false, payload: {}, reason: 'villageId_required' };
    const info = await this.tavernInfo(villageId);
    if (info.level <= 0) return { ok: false, payload: {}, reason: 'no_tavern' };
    await this.refreshOffered(villageId, info);
    return { ok: true, payload: this.snapshot(villageId, this.ensureState(villageId)) };
  }

  /** 重置本村全部任务进度（删状态+营地、重激活 m1）。 */
  private async gmReset(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    if (!villageId) return { ok: false, payload: {}, reason: 'villageId_required' };
    this.wipeSingleVillage(villageId);
    this.createVillage(villageId);
    return { ok: true, payload: this.snapshot(villageId, this.ensureState(villageId)) };
  }

  // ── 主线自动解锁（科技树式前置）──
  private async unlockMainQuests(villageId: string): Promise<void> {
    for (const q of Object.values(this.config.quests)) {
      if (q.type !== 'main') continue;
      const storageVillageId = this.storageVillageForQuest(villageId, q.code);
      const s = this.ensureState(storageVillageId);
      if (s.completedMain.includes(q.code)) continue;
      if (s.active[q.code]) continue;
      if (this.prereqsMet(villageId, q.requires)) {
        try {
          await this.activateQuest(villageId, q.code);
        } catch { /* 忽略单条失败，继续其它 */ }
      }
    }
  }

  /** 支线任务解锁（一次性 + 触发条件 + 前置链）：满足条件的支线进入可接取列表。 */
  private async unlockSideQuests(villageId: string): Promise<void> {
    for (const q of Object.values(this.config.quests)) {
      if (q.type !== 'side') continue;
      const storageVillageId = this.storageVillageForQuest(villageId, q.code);
      const s = this.ensureState(storageVillageId);
      let changed = false;
      if (s.completedSide.includes(q.code)) continue;
      if (s.abandonedSide.includes(q.code)) continue; // 放弃过 → 永久不再出现
      if (s.active[q.code]) continue;
      if (this.sideClaimedByPlayer(villageId, q.code)) continue;
      if (s.offeredSide.includes(q.code)) continue;
      if ((!q.trigger || s.firedTriggers.includes(q.trigger)) && this.prereqsMet(villageId, q.requires)) {
        s.offeredSide.push(q.code);
        changed = true;
      }
      if (changed) this.store.set(COLLECTION, storageVillageId, s);
    }
    await this.pushList(villageId);
  }

  private prereqsMet(villageId: string, requires: string[]): boolean {
    if (!requires.length) return true;
    const done = new Set<string>();
    for (const { state } of this.taskCandidates(villageId)) {
      for (const code of state.completedMain) done.add(code);
      for (const code of state.completedSide) done.add(code);
    }
    for (const req of requires) {
      // 每个 require 是「OR 组」：以 ' OR ' 分隔，组内任一完成即满足
      const orParts = req.split(' OR ');
      if (!orParts.some((p) => done.has(p.trim()))) return false;
    }
    return true;
  }

  // ── 战斗结束：推进 clear_camp ──
  private async onBattleEnded(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId?: string; side?: string; targetKind?: string; targetId?: string; attackerWins?: boolean; movementId?: string; treasures?: string[]; campCleared?: boolean; looted?: Record<string, number>; deployedTroops?: Record<string, number> };
    if (p.side !== 'attacker') return;
    const villageId = p.villageId;
    const targetId = p.targetId;
    if (!villageId || !targetId) return;

    // 默认战败不影响任务生命周期：任务营地继续留在地图上，允许玩家再次派兵。
    // 只有任务定义明确增加“战败即失败”规则时才应在这里另行处理；当前任务图没有此类任务。
    if (!p.attackerWins) {
      if (p.targetKind === 'pve') await this.preserveTaskCampAfterDefeat(villageId, targetId);
      return;
    }

    // 村民的请求：成功掠夺(清空)普通 PvE 营地后，按 GM 概率触发支线任务。
    if (p.targetKind === 'pve' && p.campCleared === true && !targetId.startsWith('happy-')) {
      const chance = this.gmNum('villager_request_trigger_chance', 0.3);
      if (this.rng() < chance) {
        for (const q of Object.values(this.config.quests).filter((x) => x.trigger === 'pve_camp_cleared')) {
          const storageVillageId = this.storageVillageForQuest(villageId, q.code);
          const state = this.ensureState(storageVillageId);
          if (!state.firedTriggers.includes('pve_camp_cleared')) {
            state.firedTriggers.push('pve_camp_cleared');
            this.store.set(COLLECTION, storageVillageId, state);
          }
        }
        await this.unlockSideQuests(villageId);
      }
    }

    // 任务营地属于接取任务的村庄，但可以由玩家其它村庄出兵清理。
    // 先走这条跨村路径，避免后面的 taskCandidates(villageId) 把进度写到出兵村。
    if (p.targetKind === 'pve' && p.campCleared === true) {
      const match = this.findTaskCamp(villageId, targetId);
      if (match) {
        await this.applyTaskCampBattle(villageId, match, {
          targetId,
          movementId: p.movementId,
        });
        return;
      }
    }

    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const [code, inst] of Object.entries(state.active)) {
        const q = this.quest(code);
        if (!q) continue;
        if (this.storageVillageForQuest(villageId, code) !== storageVillageId) continue;
        // 失败路径：玩家选择掠夺幸福村（而非送达粮食）→ 任务失败，改发「秘密字条」
        if (p.targetKind === 'pve' && q.objective.kind === 'deliver_to_npc' && inst.npcVillageId && targetId === inst.npcVillageId && p.attackerWins) {
          const rewardVillageId = inst.spawnVillageId ?? villageId;
          await this.removeNpc(rewardVillageId, inst);
          await this.commands.send({ name: 'treasure.Grant', from: TasksModule.NAME, payload: { villageId: rewardVillageId, code: 'secret_note', pendingIfFull: true, alwaysPending: true, rewardVillageId } });
          if (!state.abandonedSide.includes(code)) state.abandonedSide.push(code);
          delete state.active[code];
          this.store.set(COLLECTION, storageVillageId, state);
          await this.pushList(villageId);
          await this.pushMap(villageId);
          return;
        }
        if (q.objective.kind === 'carry_flag' && p.movementId && p.treasures?.includes(q.objective.flagCode ?? '')) {
          const troopCount = Object.values(p.deployedTroops ?? {}).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0);
          if (troopCount < (q.objective.minTroops ?? 1)) continue;
          const qualifies = (p.targetKind === 'pve' && p.campCleared === true)
            || (p.targetKind === 'village' && Object.values(p.looted ?? {}).some((n) => n > 0));
          if (qualifies) {
            inst.executionVillageId = villageId;
            inst.qualifiedMovements ??= [];
            if (!inst.qualifiedMovements.includes(p.movementId)) inst.qualifiedMovements.push(p.movementId);
            this.store.set(COLLECTION, storageVillageId, state);
            await this.pushList(villageId);
          }
          continue;
        }
        // clear_camp 只统计 PvE 的专属营地，PvP 仅能推进携旗任务。
        if (p.targetKind !== 'pve') continue;
        const camp = inst.camps.find((c) => c.id === targetId && !c.cleared);
        if (!camp) continue;
        camp.cleared = true;
        inst.executionVillageId = villageId;
        inst.campCleared = (inst.campCleared ?? 0) + 1;
        this.store.set(COLLECTION, storageVillageId, state);
        if (inst.campCleared >= inst.camps.length) {
          await this.commands.send({
            name: 'treasure.RollDrop', from: TasksModule.NAME,
            payload: { villageId, source: 'camp', movementId: p.movementId, forceCode: 'captured_natalies' },
          });
          if (code === 's4') {
            inst.awaitingNatalieDecision = true;
            inst.awaitingNatalieCode = 'captured_natalies';
            this.store.set(COLLECTION, storageVillageId, state);
            await this.pushList(villageId);
            await this.pushMap(villageId);
          } else {
            await this.markReady(villageId, code);
          }
        } else {
          await this.pushList(villageId);
          await this.pushMap(villageId);
        }
        return;
      }
    }
  }

  /** 训练完成后检查兵力门槛；同时 resume 会补查，避免服务器重启漏掉已达标玩家。 */
  private async onTroopTrained(evt: DomainEvent): Promise<void> {
    const villageId = (evt.payload as { villageId?: string }).villageId;
    if (!villageId) return;
    await this.checkTroopTriggers(villageId);
  }

  /** 训练事件与服务器恢复共用的兵力门槛检查。 */
  private async checkTroopTriggers(villageId: string): Promise<void> {
    const army = await this.commands.send({ name: 'military.GetArmy', from: TasksModule.NAME, payload: { villageId } });
    const troops = ((army.payload as { troops?: Record<string, number> } | undefined)?.troops) ?? {};
    const total = Object.values(troops).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0);
    for (const q of Object.values(this.config.quests)) {
      if (q.type !== 'side' || !q.trigger?.startsWith('troops_reached:')) continue;
      const storageVillageId = this.storageVillageForQuest(villageId, q.code);
      const s = this.ensureState(storageVillageId);
      const need = Number(q.trigger.split(':')[1]) || 0;
      if (total >= need && !s.firedTriggers.includes(q.trigger)) {
        s.firedTriggers.push(q.trigger);
        this.store.set(COLLECTION, storageVillageId, s);
        await this.unlockSideQuests(villageId);
      }
    }
  }

  /** 合格军队把军旗存回本村后，只标记为可手动交付，绝不自动发奖。 */
  private async onCarriedStored(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId?: string; movementId?: string; codes?: string[] };
    if (!p.villageId || !p.movementId) return;
    for (const { storageVillageId, state } of this.taskCandidates(p.villageId)) {
      for (const [code, inst] of Object.entries(state.active)) {
        const q = this.quest(code);
        if (q?.objective.kind !== 'carry_flag' || !inst.qualifiedMovements?.includes(p.movementId)) continue;
        const flag = q.objective.flagCode ?? '';
        if (!p.codes?.includes(flag)) continue;
        inst.executionVillageId = p.villageId;
        inst.qualifiedMovements = inst.qualifiedMovements.filter((id) => id !== p.movementId);
        inst.qualifiedFlagMovements ??= [];
        if (!inst.qualifiedFlagMovements.includes(p.movementId)) inst.qualifiedFlagMovements.push(p.movementId);
        this.store.set(COLLECTION, storageVillageId, state);
        await this.markReady(p.villageId, code);
        await this.pushList(p.villageId);
        return;
      }
    }
  }

  /** 军旗离开本村储存时，按“先移除未合格军旗”的规则收缩可交付标记。 */
  private async onStoredRemoved(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId?: string; code?: string; remainingCount?: number };
    if (!p.villageId || !p.code) return;
    for (const { storageVillageId, state } of this.taskCandidates(p.villageId)) {
      let changed = false;
      for (const [code, inst] of Object.entries(state.active)) {
        const q = this.quest(code);
        if (q?.objective.kind !== 'carry_flag' || q.objective.flagCode !== p.code) continue;
        const eligible = inst.qualifiedFlagMovements ?? [];
        const keep = Math.min(eligible.length, Math.max(0, Number(p.remainingCount) || 0));
        if (keep === eligible.length) continue;
        inst.qualifiedFlagMovements = eligible.slice(0, keep);
        if (keep === 0) inst.readyToDeliver = false;
        changed = true;
      }
      if (changed) { this.store.set(COLLECTION, storageVillageId, state); await this.pushList(p.villageId); }
    }
  }

  /** 建筑建成 → 标记已触发的支线任务触发条件，并解锁满足条件的支线任务。 */
  private async onBuildingBuilt(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId: string; kind: string };
    const villageId = p.villageId;
    const kind = p.kind;
    if (!villageId || !kind) return;
    // 贸易中心建成 → 为接取「村民的请求」时尚未建贸易中心的村庄补生成幸福村
    if (kind === 'tradecenter') {
      const s = this.ensureState(villageId);
      for (const inst of Object.values(s.active)) {
        if (inst.npcPending) await this.retryNpcSpawn(villageId, s, inst);
      }
    }
    const triggerKey = `building_built:${kind}`;
    const matched = Object.values(this.config.quests).filter((q) => q.trigger === triggerKey);
    if (!matched.length) return;
    for (const q of matched) {
      const storageVillageId = this.storageVillageForQuest(villageId, q.code);
      const s = this.ensureState(storageVillageId);
      if (s.firedTriggers.includes(triggerKey)) continue;
      s.firedTriggers.push(triggerKey);
      this.store.set(COLLECTION, storageVillageId, s);
    }
    await this.unlockSideQuests(villageId);
  }

  /** 出售/丢弃宝物 → 推进 sell_discard_treasure 任务的累计计数。 */
  private async onTreasureSoldDiscarded(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId: string; code: string; rarity: string };
    const villageId = p.villageId;
    const rarity = p.rarity;
    if (!villageId || !rarity) return;
    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const [code, inst] of Object.entries(state.active)) {
        const q = this.quest(code);
        if (!q || q.objective.kind !== 'sell_discard_treasure') continue;
        const minRank = rarityRank(q.objective.minRarity ?? 'rare');
        if (rarityRank(rarity) < minRank) continue; // 品质不达标，不计入
        inst.executionVillageId = villageId;
        inst.progress = (inst.progress ?? 0) + 1;
        this.store.set(COLLECTION, storageVillageId, state);
        if (inst.progress >= (q.objective.count ?? 1)) {
          await this.markReady(villageId, code);
        } else {
          await this.pushList(villageId);
        }
        return;
      }
    }
  }

  // ── 酒馆等级变化 ──
  private async onTavernChanged(villageId: string): Promise<void> {
    const s = this.ensureState(villageId);
    this.scheduler.cancelByOwner(`task-refresh:${villageId}`);
    const info = await this.tavernInfo(villageId);
    if (info.level <= 0) {
      // 酒馆没了：清空展示中的随机任务（已接取的保留）
      s.offered = [];
      this.store.set(COLLECTION, villageId, s);
      await this.pushList(villageId);
      return;
    }
    await this.refreshOffered(villageId, info);
    this.scheduleRefresh(villageId, info);
  }

  private async resumeVillage(villageId: string): Promise<void> {
    const info = await this.tavernInfo(villageId);
    if (info.level <= 0) return;
    await this.refreshOffered(villageId, info);
    this.scheduleRefresh(villageId, info);
  }

  /** 排下一次随机刷新（按酒馆等级的 taskRefreshSec）。 */
  private scheduleRefresh(villageId: string, info: TavernInfo): void {
    this.scheduler.schedule(
      Math.max(1000, info.refreshSec * 1000),
      () => void this.onRefreshTick(villageId),
      `task-refresh:${villageId}`,
      `village:${villageId}`,
    );
  }

  private async onRefreshTick(villageId: string): Promise<void> {
    const info = await this.tavernInfo(villageId);
    if (info.level <= 0) {
      const s = this.ensureState(villageId);
      s.offered = [];
      this.store.set(COLLECTION, villageId, s);
      await this.pushList(villageId);
      return; // 酒馆已无，不再续排
    }
    await this.refreshOffered(villageId, info);
    this.scheduleRefresh(villageId, info);
  }

  /** 加权随机抽取日常任务填满酒馆（不超过 maxTasks）。日常任务可反复，不过滤完成历史，仅受冷却约束。 */
  private async refreshOffered(villageId: string, info: TavernInfo): Promise<void> {
    const s = this.ensureState(villageId);
    const need = info.maxTasks - s.offered.length;
    if (need <= 0) return;

    const pool = Object.values(this.config.quests).filter((q) =>
      q.type === 'daily' &&
      (s.cooldownUntil?.[q.code] ?? 0) <= this.now() &&
      !s.active[q.code] &&
      !s.offered.includes(q.code),
    );
    if (!pool.length) return;

    const picked = this.weightedPick(pool, need);
    for (const c of picked) s.offered.push(c);
    this.store.set(COLLECTION, villageId, s);
    await this.pushList(villageId);
  }

  private dayKey(): string { return new Date(this.now()).toISOString().slice(0, 10); }

  private weightedPick(pool: QuestDef[], n: number): string[] {
    const out: string[] = [];
    const work = pool.slice();
    for (let i = 0; i < n && work.length; i++) {
      const total = work.reduce((a, q) => a + Math.max(0, q.weight || 1), 0);
      let roll = this.rng() * total;
      let idx = 0;
      for (let j = 0; j < work.length; j++) {
        roll -= Math.max(0, work[j].weight || 1);
        if (roll <= 0) { idx = j; break; }
      }
      out.push(work[idx].code);
      work.splice(idx, 1);
    }
    return out;
  }

  // ── 酒馆参数 ──
  private async tavernInfo(villageId: string): Promise<TavernInfo> {
    const level = await this.tavernLevel(villageId);
    if (level <= 0) return { level: 0, refreshSec: 0, maxTasks: 0 };
    const def = this.config.buildings['tavern']?.levels[level];
    return {
      level,
      refreshSec: def?.taskRefreshSec ?? 3600,
      maxTasks: def?.taskMaxTasks ?? 1,
    };
  }

  private async tavernLevel(villageId: string): Promise<number> {
    try {
      const res = await this.commands.send({ name: 'building.GetLayout', from: TasksModule.NAME, payload: { villageId } });
      if (!res.ok) return 0;
      const layout = res.payload as any;
      const zones = layout?.zones ?? {};
      const placed = [...(zones.inner?.placed ?? []), ...(zones.outer?.placed ?? [])];
      let max = 0;
      for (const p of placed) {
        if (p?.kind === 'tavern' && (p.level ?? 0) > max) max = p.level;
      }
      return max;
    } catch {
      return 0;
    }
  }

  // ── 坐标查询 ──
  private async getVillageXY(villageId: string): Promise<{ q: number; r: number } | null> {
    const res = await this.commands.send({ name: 'world.GetTileByRef', from: TasksModule.NAME, payload: { refId: villageId, kind: 'village' } });
    const tile = (res.payload as any)?.tile;
    return res.ok && tile ? { q: tile.q, r: tile.r } : null;
  }

  // ── GM 常量（运行时可在 /gm/balance 调整）──
  private gmNum(key: string, def: number): number {
    const v = this.config.constants.raw?.[key];
    return typeof v === 'number' ? v : def;
  }
  private gmStr(key: string, def: string): string {
    const v = this.config.constants.raw?.[key];
    return typeof v === 'string' ? v : def;
  }

  /** 读贸易中心建筑等级（口径唯一）。 */
  private async getTradeCenterLevel(villageId: string): Promise<number> {
    const res = await this.commands.send({ name: 'building.GetBuildingLevel', from: TasksModule.NAME, payload: { villageId, kind: 'tradecenter' } });
    return (res.payload as any)?.level ?? 0;
  }

  // ── 幸福村（NPC 村庄 / deliver_to_npc 目标）──

  /** 接取时立即生成幸福村；贸易中心只决定送达订单何时可用。 */
  private async spawnNpcVillage(villageId: string, s: TaskState, inst: TaskInstance): Promise<void> {
    const level = await this.getTradeCenterLevel(villageId);
    if (inst.npcVillageId && inst.npcXY) {
      if (level <= 0) { inst.npcPending = true; this.store.set(COLLECTION, villageId, s); return; }
      if (!inst.npcOrderId) {
        const order = await this.commands.send({ name: 'trade.CreateNpcOrder', from: TasksModule.NAME, payload: { villageId, npcId: inst.npcVillageId, npcXY: inst.npcXY, want: { [inst.npcRes ?? 'crop']: inst.npcAmt ?? 1 }, ownerName: '幸福村' } });
        inst.npcOrderId = (order.payload as any)?.id ?? null;
      }
      inst.npcPending = false;
      this.store.set(COLLECTION, villageId, s);
      await this.pushList(villageId);
      return;
    }
    const xy = await this.getVillageXY(villageId);
    if (!xy) {
      inst.npcPending = true;
      this.store.set(COLLECTION, villageId, s);
      return;
    }
    const radius = this.gmNum('villager_request_spawn_radius', 3);
    const free = await this.commands.send({ name: 'world.FindFreeTile', from: TasksModule.NAME, payload: { centerQ: xy.q, centerR: xy.r, radius } });
    if (!free.ok) {
      // 临时无空地：挂起并稍后重试
      inst.npcPending = true;
      this.store.set(COLLECTION, villageId, s);
      this.scheduleNpcRetry(villageId, inst);
      return;
    }
    const { q, r } = free.payload as { q: number; r: number };
    const npcId = `happy-${villageId}`;
    const loot = {
      wood: this.gmNum('villager_request_npc_wood', 200),
      clay: this.gmNum('villager_request_npc_clay', 200),
      iron: this.gmNum('villager_request_npc_iron', 200),
      gold: this.gmNum('villager_request_npc_gold', 100),
    };
    const spawn = await this.commands.send({
      name: 'pve.Spawn', from: TasksModule.NAME,
      payload: { id: npcId, type: 'happy_village', q, r, task: false, ownerVillageId: villageId, loot, noRespawn: true },
    });
    if (!spawn.ok) {
      inst.npcPending = true;
      this.store.set(COLLECTION, villageId, s);
      this.scheduleNpcRetry(villageId, inst);
      return;
    }
    const orderRes = this.gmStr('villager_request_order_resource', 'crop');
    const orderAmt = this.gmNum('villager_request_order_amount', 500);
    inst.npcVillageId = npcId;
    inst.npcXY = { q, r };
    inst.npcRes = orderRes;
    inst.npcAmt = orderAmt;
    inst.npcOrderId = undefined;
    inst.npcPending = level <= 0;
    this.store.set(COLLECTION, villageId, s);
    if (level > 0) await this.spawnNpcVillage(villageId, s, inst);
    await this.pushList(villageId);
    await this.pushMap(villageId);
  }

  /** 挂起态重试：贸易中心建成后或临时无空地恢复后补生成幸福村。 */
  private async retryNpcSpawn(villageId: string, s: TaskState, inst: TaskInstance): Promise<void> {
    if (!inst.npcPending) return;
    inst.npcPending = false;
    await this.spawnNpcVillage(villageId, s, inst);
  }

  private scheduleNpcRetry(villageId: string, inst: TaskInstance): void {
    this.scheduler.schedule(30_000, () => {
      const s = this.load(villageId);
      const cur = s?.active[inst.code];
      if (s && cur && cur.npcPending) void this.retryNpcSpawn(villageId, s, cur);
    }, `task-npc:${villageId}:${inst.code}`, `village:${villageId}`);
  }

  /** 移除幸福村地块与对应贸易订单（任务完成/失败/放弃时清理）。 */
  private async removeNpc(villageId: string, inst: TaskInstance): Promise<void> {
    if (!inst.npcVillageId) return;
    await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: inst.npcVillageId } });
    if (inst.npcOrderId) {
      await this.commands.send({ name: 'trade.RemoveNpcOrder', from: TasksModule.NAME, payload: { villageId, orderId: inst.npcOrderId } });
    }
  }

  /** 商队抵达幸福村（npc 非玩家村庄）→ 校验货量达标则完成任务（发娜塔莉 + 清幸福村 + 清订单）。 */
  private async onCaravanArrivedNpc(evt: DomainEvent): Promise<void> {
    const { villageId, npcId, cargo } = evt.payload as { villageId: string; npcId: string; cargo?: Record<string, number> };
    if (!villageId || !npcId) return;
    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const [code, inst] of Object.entries(state.active)) {
        const q = this.quest(code);
        if (q?.objective.kind !== 'deliver_to_npc') continue;
        if (this.storageVillageForQuest(villageId, code) !== storageVillageId || inst.npcVillageId !== npcId) continue;
        const res = q.objective.deliverResource ?? 'crop';
        const amount = q.objective.deliverAmount ?? 1;
        const have = Math.floor(Number(cargo?.[res]) || 0);
        if (have < amount) continue; // 货量不足：忽略本次，等待后续送达
        inst.executionVillageId = villageId;
        await this.removeNpc(inst.spawnVillageId ?? villageId, inst);
        await this.completeQuest(villageId, code);
        return;
      }
    }
  }

  /** 使用秘密字条生成战报 → 解锁后续「调查坐标」任务。 */
  private async onReportCoords(evt: DomainEvent): Promise<void> {
    const { villageId } = evt.payload as { villageId: string };
    if (!villageId) return;
    const s = this.ensureState(villageId);
    if (!s.firedTriggers.includes('secret_note_used')) {
      s.firedTriggers.push('secret_note_used');
      this.store.set(COLLECTION, villageId, s);
      await this.unlockSideQuests(villageId);
    }
  }

  // ── 进度判定 ──
  private submitMet(inst: TaskInstance, required: Record<string, number>): boolean {
    for (const [res, need] of Object.entries(required)) {
      if ((inst.submitted[res] ?? 0) < need) return false;
    }
    return true;
  }

  private remaining(inst: TaskInstance, required: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [res, need] of Object.entries(required)) {
      out[res] = Math.max(0, need - (inst.submitted[res] ?? 0));
    }
    return out;
  }

  // ── 序列化 + 推送 ──
  private emptySnapshot(villageId: string | null): Record<string, unknown> {
    return { villageId, active: [], offered: [], offeredSide: [], completedMain: [], completedSide: [], abandonedSide: [], pendingDialogues: [] };
  }

  /** 当前村任务页快照：本村 village 任务 + 玩家锚点上的 global 任务。 */
  private snapshotForVillage(villageId: string): Record<string, unknown> {
    const local = this.snapshot(villageId, this.ensureState(villageId), 'village');
    const anchor = this.anchorVillage(villageId);
    const global = this.snapshot(anchor, this.ensureState(anchor), 'global');
    return {
      villageId,
      active: [...(global.active as unknown[]), ...(local.active as unknown[])],
      offered: [...(global.offered as unknown[]), ...(local.offered as unknown[])],
      offeredSide: [...(global.offeredSide as unknown[]), ...(local.offeredSide as unknown[])],
      completedMain: [...(global.completedMain as string[])],
      completedSide: [...(global.completedSide as string[]), ...(local.completedSide as string[])],
      abandonedSide: [...(global.abandonedSide as string[]), ...(local.abandonedSide as string[])],
      pendingDialogues: [
        ...((global.pendingDialogues as unknown[]) ?? []),
        ...((local.pendingDialogues as unknown[]) ?? []),
      ],
      global,
      village: local,
    };
  }

  private snapshot(villageId: string, s: TaskState, scopeFilter?: QuestScope): Record<string, unknown> {
    const include = (code: string) => !scopeFilter || this.questScope(code) === scopeFilter;
    const active = Object.values(s.active).filter((inst) => include(inst.code)).map((inst) => this.serializeInstance(inst, villageId));
    const offered = s.offered
      .filter(include)
      .map((code) => this.quest(code))
      .filter((q): q is QuestDef => !!q)
      .map((q) => this.serializeOffer(q, villageId));
    const offeredSide = s.offeredSide
      .filter(include)
      .map((code) => this.quest(code))
      .filter((q): q is QuestDef => !!q)
      .map((q) => this.serializeOffer(q, villageId));
    const pendingDialogues = (s.pendingDialogues ?? [])
      .filter((item) => include(item.taskCode))
      .map((item) => this.serializePendingDialogue(item));
    return {
      villageId,
      active,
      offered,
      offeredSide,
      completedMain: s.completedMain.filter(include),
      completedSide: s.completedSide.filter(include),
      abandonedSide: s.abandonedSide.filter(include),
      pendingDialogues,
    };
  }

  private serializePendingDialogue(item: PendingTaskDialogue): Record<string, unknown> {
    const def = Object.values(this.config.dialogues ?? {})
      .find((dialogue) => dialogue.taskCode === item.taskCode && dialogue.trigger === item.trigger);
    if (!def) return { ...item, dialogue: null };
    const render = (value: string) => value.replaceAll('{villageName}', this.villageName(item.villageId));
    const dialogue: SerializedDialogueSession = {
      id: item.id,
      code: def.code,
      taskCode: def.taskCode,
      trigger: def.trigger,
      npcName: render(def.npcName),
      npcText: render(def.npcText),
      replies: def.replies.map((reply) => ({ ...reply })),
    };
    return { ...item, dialogue };
  }

  private serializeOffer(q: QuestDef, villageId?: string): Record<string, unknown> {
    return {
      villageId: villageId ?? null,
      code: q.code,
      name: q.name,
      desc: q.desc,
      type: q.type,
      scope: q.scope,
      objective: this.serializeObjective(q),
      rewards: this.serializeRewards(q),
      trigger: q.trigger ?? null,
    };
  }

  private serializeObjective(q: QuestDef): Record<string, unknown> {
    return {
      kind: q.objective.kind,
      resources: q.objective.resources ?? null,
      campTemplate: q.objective.campTemplate ?? null,
      minRarity: q.objective.minRarity ?? null,
      count: q.objective.count ?? 0,
      flagCode: q.objective.flagCode ?? null,
      minTroops: q.objective.minTroops ?? 0,
      deliverResource: q.objective.deliverResource ?? null,
      deliverAmount: q.objective.deliverAmount ?? 0,
    };
  }

  private serializeInstance(inst: TaskInstance, villageId?: string): Record<string, unknown> {
    const q = this.quest(inst.code);
    const objective = q ? this.serializeObjective(q) : { kind: 'unknown' };
    return {
      villageId: villageId ?? null,
      code: inst.code,
      lineCode: inst.lineCode ?? this.config.questGraph.quests[inst.code]?.lineCode ?? null,
      definitionRevision: inst.definitionRevision ?? 'legacy-v2',
      type: inst.type,
      scope: q?.scope ?? (inst.type === 'main' ? 'global' : 'village'),
      executionVillageId: inst.executionVillageId ?? villageId ?? null,
      storageVillageId: villageId ?? null,
      name: q?.name ?? inst.code,
      desc: q?.desc ?? '',
      objective,
      rewards: q ? this.serializeRewards(q) : null,
      submitted: { ...inst.submitted },
      required: q?.objective.resources ?? {},
      campCleared: inst.campCleared,
      campTotal: inst.camps.length,
      progress: inst.progress ?? 0,
      awaitingReturn: inst.qualifiedMovements?.length ?? 0,
      deliverableFlags: inst.qualifiedFlagMovements?.length ?? 0,
      camps: inst.camps.map((c) => ({ id: c.id, q: c.q, r: c.r, cleared: c.cleared })),
      npcVillageId: inst.npcVillageId ?? null,
      npcXY: inst.npcXY ?? null,
      npcRes: inst.npcRes ?? null,
      npcAmt: inst.npcAmt ?? 0,
      npcOrderId: inst.npcOrderId ?? null,
      npcPending: inst.npcPending === true,
      canAbandon: inst.type !== 'main',
      ready: inst.readyToDeliver === true,
      canDeliver: inst.readyToDeliver === true,
      awaitingNatalieDecision: inst.awaitingNatalieDecision === true,
      natalieDecision: inst.natalieDecision ?? null,
      acceptedAt: inst.acceptedAt,
    };
  }

  /** 任务结局奖励：资源(含金币)、宝物和声望，供客户端卡片与领奖弹窗展示。 */
  private serializeOutcome(rewards?: QuestRewards): Record<string, unknown> {
    return {
      resources: rewards?.resources ?? null,
      treasures: rewards?.treasures ?? [],
      reputation: rewards?.reputation ?? 0,
    };
  }

  private serializeRewards(q: QuestDef): Record<string, unknown> {
    return {
      ...this.serializeOutcome(q.rewards),
      failure: q.failureRewards ? this.serializeOutcome(q.failureRewards) : null,
      choices: (q.choiceRewards ?? []).map((choice) => ({ key: choice.key, label: choice.label, ...this.serializeOutcome(choice.rewards) })),
    };
  }

  private async pushList(villageId: string): Promise<void> {
    await this.bus.emit({
      name: 'task.ListChanged', source: TasksModule.NAME, ts: this.now(),
      payload: this.snapshotForVillage(villageId),
    });
  }

  private async pushMap(villageId: string): Promise<void> {
    const camps: { id: string; q: number; r: number; cleared: boolean }[] = [];
    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const inst of Object.values(state.active)) {
        if (this.storageVillageForQuest(villageId, inst.code) !== storageVillageId) continue;
      // 地图标记只表示仍可交互的任务营地；已清理的营地保留在任务快照中用于进度展示，
      // 但绝不能再次推给地图，否则客户端会在已还原的空地上留下幽灵任务标。
      for (const c of inst.camps) {
        if (!c.cleared) camps.push({ id: c.id, q: c.q, r: c.r, cleared: false });
      }
      }
    }
    await this.bus.emit({
      name: 'task.MapUpdated', source: TasksModule.NAME, ts: this.now(),
      payload: { villageId, camps },
    });
  }
}

/**
 * 领域模块 · 任务（TasksModule）
 *
 * 状态归属：task 集合按任务 scope 保存（global 锚定玩家主城，village 绑定具体村）；
 * 客户端任务页通过 GetPlayerState 分成全局区与当前村区。
 *
 * 设计要点（来自策划）：
 *  - 任务会给接了该任务的玩家在地图上显示专属内容；任务专属宝物不可出售/遗弃/丢失/超时。
 *  - 城内建筑「酒馆」用于接取日常任务：酒馆升级使日常任务刷新更频繁，且可同时接取的任务数变多。
 *  - 主线任务：全玩家共有，科技树式前置（requires），不可放弃；仅 m1 建村自动激活，后续主线解锁后进入可接取提示。
 *  - 日常任务：酒馆随机刷新，可反复出现、完成后冷却可再次刷出，可放弃。
 *  - 支线任务：满足触发条件(trigger)+前置(requires)后出现的一次性任务，有任务线；放弃后永久不再出现（客户端需警告）。
 *  - 目标种类：submit_resources（上交资源）、repair_buildings（修复指定建筑）、build_buildings（建造数量）、population_reached（人口门槛）、resource_owned（拥有资源）、explore_tiles（累计探索格数）、reputation_at_most（声望值达到阈值或更低）、clear_camp（清理地图上真实生成的任务营地）。
 *
 * 命令：
 *   task.GetState       → 完整快照（active / offeredMain / offered / offeredSide / completed*）
 *   task.Accept        → 接取主线（M1 除外）/日常(酒馆)/支线(任务栏)任务
 *   task.Abandon       → 放弃日常/支线任务（主线不可放弃）
 *   task.SubmitResources → 上交资源推进 submit_resources 类任务
 *
 * 内部订阅：
 *   building.Built / Upgraded / Demolished → 酒馆等级变化（重排随机刷新节奏 + 接取上限）
 *   combat.BattleEnded → 玩家清空任务营地时推进 clear_camp 类任务
 *
 * 跨模块协作（仅经 Commands，不读他模块 store）：
 *   world.GetTileByRef  取本村坐标
 *   world.FindFreeTile  在村庄周围配置范围内随机找空地放任务营地
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
// eslint-disable-next-line no-restricted-imports -- task/state 是同一 task owner 的内部持久化边界；architecture.test.ts 同时校验其 owner 一致性。
import {
  TASK_COLLECTION as COLLECTION, emptyTaskState, ensureTaskState,
  type PendingTaskDialogue, type SerializedDialogueSegment, type SerializedDialogueSession,
  type TaskCamp, type TaskInstance, type TaskState, type TavernInfo,
} from './task/state.js';
// eslint-disable-next-line no-restricted-imports -- task/player-directory 是同一 task owner 的内部 Command 适配器；architecture.test.ts 校验其 owner 一致性。
import { TaskPlayerDirectory } from './task/player-directory.js';
// eslint-disable-next-line no-restricted-imports -- task/catalog 是同一 task owner 的配置适配器；architecture.test.ts 校验其 owner 一致性。
import { TaskCatalog } from './task/catalog.js';
import { neighborsWrapped, hexDistanceWrapped } from '../infra/hex.js';

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
  private readonly playerDirectory: TaskPlayerDirectory;
  private catalog: TaskCatalog;
  /** 同一任务的奖励领取互斥，避免两个并发 Deliver 在删除 active 前各发一遍奖励。 */
  private readonly deliveryInFlight = new Set<string>();

  constructor(
    store: Store, bus: EventBus, commands: CommandBus, scheduler: Scheduler,
    now: () => number, config: GameConfig, rng: () => number = Math.random,
  ) {
    this.config = config;
    this.store = store;
    this.bus = bus;
    this.commands = commands;
    this.scheduler = scheduler;
    this.now = now;
    this.rng = rng;
    this.playerDirectory = new TaskPlayerDirectory(commands);
    this.catalog = new TaskCatalog(config);
  }

  /** GM 热重载时更新配置。 */
  setConfig(config: GameConfig): void {
    this.config = config;
    this.catalog = new TaskCatalog(config);
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
    this.commands.register('task.Fail', (c: Command) => this.fail(c));
    // GM 运维命令（由 GM 面板经 commands.send({from:'gm'}) 调用，不暴露给客户端）
    this.commands.register('task.GmComplete', (c: Command) => this.gmComplete(c));
    this.commands.register('task.GmReopenCompleted', (c: Command) => this.gmReopenCompleted(c));
    this.commands.register('task.GmRetriggerCompletedMain', (c: Command) => this.gmRetriggerCompletedMain(c));
    this.commands.register('task.GmUntriggerMain', (c: Command) => this.gmUntriggerMain(c));
    this.commands.register('task.GmRefreshRandom', (c: Command) => this.gmRefreshRandom(c));
    this.commands.register('task.GmReset', (c: Command) => this.gmReset(c));
    this.commands.register('task.GmResetAll', (c: Command) => this.gmResetAll(c));
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
    // 建筑完整拆除后释放槽位；build_buildings 任务把该槽位视为可重新建造的空地。
    this.bus.on('building.Demolished', (evt: DomainEvent) => void this.onBuildingDemolished(evt));
    // 建筑修复完成 → 推进 repair_buildings 类任务（如新村开局主线 m1）
    this.bus.on('building.Repaired', (evt: DomainEvent) => void this.onBuildingRepaired(evt));
    // 建筑建成、人口变化、行军视野更新 → 推进门槛类主线目标。
    this.bus.on('building.Built', (evt: DomainEvent) => void this.syncThresholdObjectives((evt.payload as { villageId?: string }).villageId ?? ''));
    this.bus.on('building.Upgraded', (evt: DomainEvent) => {
      const villageId = (evt.payload as { villageId?: string }).villageId ?? '';
      void this.syncThresholdObjectives(villageId);
      void this.unlockMainQuests(villageId);
    });
    this.bus.on('population.Changed', (evt: DomainEvent) => void this.syncThresholdObjectives((evt.payload as { villageId?: string }).villageId ?? ''));
    this.bus.on('reputation.Changed', (evt: DomainEvent) => void this.onReputationChanged(evt));
    this.bus.on('movement.VisionUpdated', (evt: DomainEvent) => void this.syncThresholdObjectives((evt.payload as { villageId?: string }).villageId ?? ''));
    // M13 秘密营地只有进入玩家视野后才在地图上标记；视野推进时及时
    // 更新任务标记，让玩家探索到营地附近即可发现它。
    this.bus.on('movement.VisionUpdated', (evt: DomainEvent) => void this.pushMap((evt.payload as { villageId?: string }).villageId ?? ''));
    this.bus.on('research.TechCompleted', (evt: DomainEvent) => void this.syncThresholdObjectives((evt.payload as { villageId?: string }).villageId ?? ''));

    // 出售/丢弃宝物 → 推进 sell_discard_treasure 任务
    this.bus.on('treasure.SoldDiscarded', (evt: DomainEvent) => void this.onTreasureSoldDiscarded(evt));

    // 战斗结束 → 推进 clear_camp 任务
    // Combat 会等待该事件：任务营地清除必须先广播目标失效，慢军队才能在同一结算内返程。
    this.bus.on('combat.BattleEnded', (evt: DomainEvent) => this.onBattleEnded(evt));
    this.bus.on('military.TroopTrained', (evt: DomainEvent) => void this.onTroopTrained(evt));
    this.bus.on('treasure.CarriedStored', (evt: DomainEvent) => void this.onCarriedStored(evt));
    this.bus.on('treasure.StoredRemoved', (evt: DomainEvent) => void this.onStoredRemoved(evt));
    // 商队抵达幸福村 → 完成 deliver_to_npc 目标
    this.bus.on('movement.CaravanArrivedNpc', (evt: DomainEvent) => void this.onCaravanArrivedNpc(evt));
    // 使用秘密字条生成战报 → 解锁「调查坐标」任务
    this.bus.on('treasure.ReportCoords', (evt: DomainEvent) => void this.onReportCoords(evt));
    this.bus.on('treasure.Used', (evt: DomainEvent) => void this.onTreasureUsed(evt));
    this.bus.on('movement.Investigated', (evt: DomainEvent) => void this.onInvestigated(evt));
    // ② captured_natalies 报告被玩家抉择（入库/释放）→ 决定是否标记任务就绪
    this.bus.on('treasure.PendingClaimed', (evt: DomainEvent) => void this.onNatalieDecision(evt));
    // player owner 的公开变更仅刷新 task 的只读目录镜像，绝不读取 player 集合。
    this.bus.on('player.Registered', (evt: DomainEvent) => void this.playerDirectory.refreshPlayer(String((evt.payload as { playerId?: string }).playerId ?? '')));
    this.bus.on('player.VillageAttached', (evt: DomainEvent) => {
      const payload = evt.payload as { playerId?: string; villageId?: string };
      // 新村庄建成时会立即获得初始视野；让同一事件顺手检查 M13，
      // 避免玩家必须重新探索一次或刷新页面才能发现已在视野内的秘密营地。
      void (async () => {
        await this.playerDirectory.refreshPlayer(String(payload.playerId ?? ''));
        if (payload.villageId) await this.pushMap(payload.villageId);
      })().catch(() => {});
    });
    this.bus.on('player.VillageRenamed', (evt: DomainEvent) => void this.playerDirectory.refreshPlayer(String((evt.payload as { playerId?: string }).playerId ?? '')));
  }

  async resume(): Promise<void> {
    await this.playerDirectory.refreshAll();
    for (const s of this.store.all<TaskState>(COLLECTION)) {
      // 任务营地持久化在 pve 集合。为旧存档回填 owner，并把历史遗留的全局 pve 地块收回私有 taskcamp。
      // 仅重排酒馆刷新节奏（若存在酒馆）。
      void this.resumeVillage(s.villageId).catch(() => {});
      await this.unlockMainQuests(s.villageId);
      for (const inst of Object.values(s.active)) {
        if (this.quest(inst.code)?.objective.kind === 'clear_camp') {
          for (const camp of inst.camps) {
            if (!camp.cleared) await this.syncTaskCamp(inst, camp, inst.spawnVillageId ?? s.villageId);
          }
          this.store.set(COLLECTION, s.villageId, s);
          if (inst.camps.length < (this.quest(inst.code)?.objective.count ?? 1)) this.scheduleCampRetry(s.villageId, inst);
        }
        if (inst.npcPending) await this.retryNpcSpawn(s.villageId, s, inst);
        if (inst.code === 'm8' && !inst.outcome && !inst.taskVillageAttackDispatched) {
          await this.repairM8TaskVillage(s.villageId, s, inst);
          if (inst.taskVillageId && !inst.taskVillageAttackAt) {
            // 旧存档可能在“任务村已生成、攻城时间尚未写入”的窗口中停机。
            // 不能让这类任务永久停在进行中；恢复时立即补上一次攻城调度。
            inst.taskVillageAttackAt = this.now();
            this.store.set(COLLECTION, s.villageId, s);
            this.scheduleM8Attack(s.villageId, inst);
          } else if (inst.taskVillageId) this.scheduleM8Attack(s.villageId, inst);
          else if (!inst.taskVillageId) this.scheduleM8VillageRetry(s.villageId, inst);
        }
        if (inst.code === 'm13' && !inst.outcome && !inst.taskVillageId) {
          const mainVillageId = this.anchorVillage(s.villageId);
          inst.spawnVillageId = mainVillageId;
          const spawned = await this.spawnM13TaskVillage(mainVillageId, s, inst);
          if (!spawned) this.scheduleM13VillageRetry(s.villageId, inst);
        }
      }
      // 支线门槛可能在本次部署/重启前已经达到；恢复时补查，不能只依赖新训练事件。
      await this.syncTaskVillageCoordinates(s.villageId);
      await this.checkTroopTriggers(s.villageId);
      // 只在恢复/视野事件时查询 M13 的真实视野，避免每次任务页读取都扫描地图。
      await this.pushMap(s.villageId);
    }
  }

  /** 返回本村任务状态中登记的所有运行时实体（营地、NPC 村、M8 任务村）。 */
  private taskEntityIds(state: TaskState): string[] {
    const ids = new Set<string>();
    for (const inst of Object.values(state.active)) {
      for (const camp of inst.camps ?? []) if (camp.id) ids.add(camp.id);
      if (inst.npcVillageId) ids.add(inst.npcVillageId);
      if (inst.taskVillageId) ids.add(inst.taskVillageId);
    }
    for (const entity of Object.values(state.taskVillages ?? {})) {
      if (entity?.id) ids.add(entity.id);
    }
    return [...ids];
  }

  /** 通过 PvE owner 命令移除任务实体，必须等待完成才能安全重建同一稳定 id。 */
  private async removeTaskEntities(state: TaskState): Promise<void> {
    for (const id of this.taskEntityIds(state)) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id } });
    }
  }

  /** 清档 / 删号：取消刷新调度、移除仍存在的任务实体、删本村 task 状态。 */
  private async wipeSingleVillageAsync(villageId: string): Promise<void> {
    this.scheduler.cancelByOwner(`task-refresh:${villageId}`);
    const s = this.store.get<TaskState>(COLLECTION, villageId);
    if (s) await this.removeTaskEntities(s);
    this.store.delete(COLLECTION, villageId);
  }

  /** 等待清理完成的入口，供放弃村庄时同步完成目标失效事件。 */
  async wipeSingleVillageAndWait(villageId: string): Promise<void> {
    await this.wipeSingleVillageAsync(villageId);
  }

  /** 兼容删号生命周期的同步入口；GM 重置使用上面的 await 版本。 */
  wipeSingleVillage(villageId: string): void {
    void this.wipeSingleVillageAsync(villageId).catch(() => {});
  }

  // ── 建村：初始化 + M1 自动解锁 ──
  createVillage(villageId: string): void {
    this.store.set(COLLECTION, villageId, emptyTaskState(villageId));
    // 解锁前置已满足的主线（建村时通常仅 m1 无前置）。异步但无需等待。
    void this.unlockMainQuests(villageId).catch(() => {});
  }

  // ── 状态读写 ──
  private ensureState(villageId: string): TaskState {
    return ensureTaskState(this.store, villageId, this.config);
  }

  private load(villageId: string): TaskState | undefined {
    return this.store.get<TaskState>(COLLECTION, villageId);
  }

  private quest(code: string): QuestDef | undefined {
    return this.catalog.legacy(code);
  }

  private questScope(code: string): QuestScope {
    const q = this.quest(code);
    return q?.scope ?? (q?.type === 'main' ? 'global' : 'village');
  }

  /** 全局任务以玩家第一座（主城）为持久化锚点；没有玩家索引的旧档退回调用村。 */
  private anchorVillage(villageId: string): string {
    const owner = this.playerDirectory.villageOwner(villageId);
    if (!owner) return villageId;
    return this.playerDirectory.villages(owner)[0] ?? villageId;
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
    const owner = this.playerDirectory.villageOwner(villageId);
    const ids = owner ? this.playerDirectory.villages(owner) : [];
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
      for (const q of this.catalog.all()) {
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
      const offered = state.offered.filter((item) => item !== code);
      const offeredSide = state.offeredSide.filter((item) => item !== code);
      if (offered.length === state.offered.length && offeredSide.length === state.offeredSide.length) continue;
      state.offered = offered;
      state.offeredSide = offeredSide;
      this.store.set(COLLECTION, storageVillageId, state);
    }
  }

  // ── 命令：GetState ──
  private async getState(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    await this.playerDirectory.refreshVillage(villageId);
    await this.syncThresholdObjectives(villageId);
    await this.syncSuccessConditions(villageId);
    await this.syncTaskVillageCoordinates(villageId);
    return { ok: true, payload: await this.snapshotForVillage(villageId) };
  }

  /** 玩家任务板：聚合该玩家全部村庄的任务；执行动作仍携带来源村庄并走原有村庄状态。 */
  private async getPlayerState(cmd: Command): Promise<CommandResult> {
    const { playerId } = cmd.payload as { playerId?: string };
    if (!playerId) return { ok: false, payload: {}, reason: 'playerId_required' };
    await this.playerDirectory.refreshPlayer(playerId);
    const villageIds = [...new Set(this.playerDirectory.villages(playerId))];
    for (const villageId of villageIds) {
      await this.syncThresholdObjectives(villageId);
      await this.syncSuccessConditions(villageId);
      await this.syncTaskVillageCoordinates(villageId);
    }
    const anchor = villageIds[0];
    const global = anchor
      ? this.redactHiddenTaskVillages(await this.snapshot(anchor, this.ensureState(anchor), 'global'))
      : this.emptySnapshot(anchor ?? null);
    const villages = await Promise.all(villageIds.map((villageId) =>
      this.snapshot(villageId, this.ensureState(villageId), 'village').then((snapshot) => this.redactHiddenTaskVillages(snapshot))));
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
      for (const item of ((snap.offeredMain as Record<string, unknown>[] | undefined) ?? [])) {
        const code = String(item.code ?? '');
        if (!offeredByCode.has(`main:${code}`)) offeredByCode.set(`main:${code}`, item);
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
        offered: [...offeredByCode.values()].filter((item) => (item as any).type !== 'main'),
        offeredMain: [...offeredByCode.values()].filter((item) => (item as any).type === 'main'),
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
    await this.playerDirectory.refreshVillage(villageId);
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
      // 酒馆刷出的支线占用 mixed `offered` 槽；事件触发型支线仍在 offeredSide。
      const tavernOffer = s.offered.includes(code);
      if (!tavernOffer && !s.offeredSide.includes(code)) return { ok: false, payload: {}, reason: 'not_offered' };
      if (tavernOffer) {
        const info = await this.tavernInfo(villageId);
        if (info.maxTasks <= 0) return { ok: false, payload: {}, reason: 'no_tavern' };
      }
      if (this.sideClaimedByPlayer(villageId, code)) return { ok: false, payload: {}, reason: 'already_claimed' };
    } else {
      if (code === 'm1') return { ok: false, payload: {}, reason: 'main_auto_activated' };
      if (!s.offeredMain.includes(code)) return { ok: false, payload: {}, reason: 'not_offered' };
    }
    return { ok: true, q, storageVillageId, s };
  }

  // ── 命令：StartAccept（检查接取资格并返回可选对话，不改变任务状态）──
  private async startAccept(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const check = await this.validateAccept(villageId, code);
    if (!check.ok) return check;
    const context = await this.playerDirectory.dialogueContext(villageId);
    const dialogue = await this.commands.send({
      name: 'dialogue.StartForTask', from: TasksModule.NAME,
      payload: { taskCode: code, trigger: this.dialogueTrigger(villageId, code, 'accept'), ...context },
    });
    if (!dialogue.ok) return dialogue;
    return { ok: true, payload: { code, dialogue: (dialogue.payload as any).dialogue ?? null } };
  }

  /** 客户端关闭自动对话后确认一次；只允许从该玩家名下的任务状态移除。 */
  private async consumeDialogue(cmd: Command): Promise<CommandResult> {
    const { playerId, dialogueId } = cmd.payload as { playerId?: string; dialogueId?: string };
    if (!playerId || !dialogueId) return { ok: false, payload: {}, reason: 'playerId_and_dialogueId_required' };
    await this.playerDirectory.refreshPlayer(playerId);
    for (const villageId of this.playerDirectory.villages(playerId)) {
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
      // clearPlayerSideOffers 通过 store 清理其他村状态；当前状态对象 `s`
      // 可能是清理前取得的引用，必须同步移除后再写回，避免把当前村的旧槽位复原。
      s.offered = s.offered.filter((c) => c !== code);
      s.offeredSide = s.offeredSide.filter((c) => c !== code);
    } else {
      if (code === 'm1') return { ok: false, payload: {}, reason: 'main_auto_activated' };
      s.offeredMain = s.offeredMain.filter((c) => c !== code);
    }

    this.store.set(COLLECTION, storageVillageId, s);
    await this.activateQuest(villageId, code);
    await this.syncThresholdObjectives(villageId);
    return { ok: true, payload: { code } };
  }

  // ── 命令：Abandon（放弃日常/支线任务；主线不可放弃）──
  private async abandon(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    await this.playerDirectory.refreshVillage(villageId);
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
      // 酒馆刷出的支线占用混合 `offered` 槽；事件触发型支线占用
      // `offeredSide`。两处都清理，避免放弃后旧槽位残留导致再次显示。
      s.offered = s.offered.filter((c) => c !== code);
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
    await this.playerDirectory.refreshVillage(villageId);
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
    await this.playerDirectory.refreshVillage(villageId);
    await this.syncThresholdObjectives(villageId);
    await this.syncSuccessConditions(villageId);
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const lockKey = `${storageVillageId}:${code}`;
    if (this.deliveryInFlight.has(lockKey)) {
      return { ok: false, payload: {}, reason: 'delivery_in_progress' };
    }
    this.deliveryInFlight.add(lockKey);
    try {
      return await this.deliverUnlocked(cmd, storageVillageId);
    } finally {
      this.deliveryInFlight.delete(lockKey);
    }
  }

  /** Deliver 的实际逻辑由上层互斥包裹，保证任务奖励（尤其 m8/m9 铁壁勋章）最多发放一次。 */
  private async deliverUnlocked(cmd: Command, storageVillageId: string): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
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
    // 交付对话与奖励同一响应返回。模板默认为空，因此不会改变现有领取流程；
    // GM 填写后客户端会在奖励明细中展示 NPC 对话，且不会再次执行任务逻辑。
    const rewardVillageId = (rewards as any)?.rewardVillageId ?? villageId;
    const context = await this.playerDirectory.dialogueContext(rewardVillageId);
    const dialogue = await this.commands.send({
      name: 'dialogue.StartForTask', from: TasksModule.NAME,
      payload: { taskCode: code, trigger: this.dialogueTrigger(rewardVillageId, code, 'deliver', inst), ...context },
    });
    return {
      ok: true,
      payload: {
        code,
        type: q.type,
        rewards,
        dialogue: dialogue.ok ? (dialogue.payload as any)?.dialogue ?? null : null,
      },
    };
  }

  /**
   * 手动确认任务失败：失败状态先保留在任务卡，避免战斗/错误选择后任务凭空消失。
   * 失败奖励仍由 quest_effects.csv 的 failure 阶段定义；没有失败奖励（如 M8）则只
   * 触发失败对话并结束任务。M8 失败会记录结局并解锁 M9，M9 再按该结局选择奖励。
   */
  private async fail(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    await this.playerDirectory.refreshVillage(villageId);
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const state = this.ensureState(storageVillageId);
    const inst = state.active[code];
    if (!inst) return { ok: false, payload: {}, reason: 'not_active' };
    if (!inst.failureReady || inst.outcome !== 'failure') return { ok: false, payload: {}, reason: 'not_failed' };
    const q = this.quest(code);
    if (!q) return { ok: false, payload: {}, reason: 'unknown_quest' };

    const rewardVillageId = q.scope === 'global' ? (inst.executionVillageId ?? villageId) : (inst.spawnVillageId ?? villageId);
    const rewardsDef = q.failureRewards;
    const granted: { resources: Record<string, number> | null; treasures: string[]; reputation?: number; population?: number; populationGrowth?: { percent: number; durationSec: number; expiresAt?: number }; resourceGrowth?: { percent: number; durationSec: number; expiresAt?: number }; buildingUnlocks?: string[]; researchPoints?: number; rewardVillageId?: string } = {
      resources: null, treasures: [], rewardVillageId,
    };

    if (rewardsDef?.resources && Object.keys(rewardsDef.resources).length) {
      await this.commands.send({ name: 'economy.Grant', from: TasksModule.NAME, payload: { villageId: rewardVillageId, gain: rewardsDef.resources } });
      granted.resources = { ...rewardsDef.resources };
    }
    if (rewardsDef?.population && rewardsDef.population > 0) {
      const population = await this.commands.send({
        name: 'population.GrantPopulation', from: TasksModule.NAME,
        payload: { villageId: rewardVillageId, amount: rewardsDef.population },
      });
      if (population.ok) granted.population = Number((population.payload as any)?.applied) || 0;
    }
    if (rewardsDef?.populationGrowth) {
      const growth = await this.commands.send({
        name: 'population.ApplyTaskGrowthBuff', from: TasksModule.NAME,
        payload: { villageId: rewardVillageId, percent: rewardsDef.populationGrowth.percent, durationSec: rewardsDef.populationGrowth.durationSec },
      });
      if (growth.ok) {
        granted.populationGrowth = {
          ...rewardsDef.populationGrowth,
          expiresAt: Number((growth.payload as any)?.expiresAt) || undefined,
        };
      }
    }
    if (rewardsDef?.reputation) {
      await this.commands.send({
        name: 'reputation.AdjustByVillage', from: TasksModule.NAME,
        payload: { villageId: rewardVillageId, delta: rewardsDef.reputation, reason: `task_${code}_failure` },
      });
      granted.reputation = rewardsDef.reputation;
    }
    if (rewardsDef?.researchPoints && rewardsDef.researchPoints > 0) {
      const rp = await this.commands.send({ name: 'research.GrantPoints', from: TasksModule.NAME, payload: { villageId: rewardVillageId, amount: rewardsDef.researchPoints } });
      if (rp.ok) granted.researchPoints = Number((rp.payload as any)?.amount) || rewardsDef.researchPoints;
    }
    for (const treasure of rewardsDef?.treasures ?? []) {
      // 失败确认的任务专属宝物沿用旧失败路径，进入报告待处理；玩家可明确领取/丢弃。
      await this.commands.send({ name: 'treasure.Grant', from: TasksModule.NAME, payload: { villageId: rewardVillageId, code: treasure, pendingIfFull: true, alwaysPending: true, rewardVillageId } });
      granted.treasures.push(treasure);
    }

    for (const camp of inst.camps ?? []) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: camp.id } });
    }
    if (inst.npcVillageId) await this.removeNpc(inst.spawnVillageId ?? villageId, inst);
    if (code === 'm13' && inst.taskVillageId) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: inst.taskVillageId } });
      if (state.taskVillages) delete state.taskVillages.m13;
    }
    this.scheduler.cancelByOwner(`task-camp:${storageVillageId}:${code}`);
    this.scheduler.cancelByOwner(`task-m8-attack:${storageVillageId}`);
    this.scheduler.cancelByOwner(`task-village:${storageVillageId}:m8`);

    delete state.active[code];
    if (q.type === 'main') {
      // 失败确认是主线终点，同样推进主线链；outcomes 保留实际结局供 M9 选奖励。
      if (!state.completedMain.includes(code)) state.completedMain.push(code);
      state.outcomes ??= {};
      state.outcomes[code] = 'failure';
    } else if (q.type === 'side') {
      if (!state.abandonedSide.includes(code)) state.abandonedSide.push(code);
    } else {
      state.cooldownUntil ??= {};
      state.cooldownUntil[code] = this.now() + q.cooldownSec * 1000;
    }
    this.store.set(COLLECTION, storageVillageId, state);
    await this.pushList(villageId);
    await this.pushMap(villageId);
    if (q.type === 'main') await this.unlockMainQuests(villageId);
    else if (q.type === 'side') await this.unlockSideQuests(villageId);

    const context = await this.playerDirectory.dialogueContext(rewardVillageId);
    const dialogue = await this.commands.send({
      name: 'dialogue.StartForTask', from: TasksModule.NAME,
      payload: { taskCode: code, trigger: this.failureDialogueTrigger(code, inst), ...context },
    });
    return {
      ok: true,
      payload: {
        code, type: q.type, rewards: granted,
        dialogue: dialogue.ok ? (dialogue.payload as any)?.dialogue ?? null : null,
      },
    };
  }

  /** 目标已达成 → 标记就绪可交付（不自动发奖），并推送给客户端。 */
  private async markReady(villageId: string, code: string): Promise<void> {
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    const inst = s.active[code];
    if (!inst || inst.readyToDeliver || inst.failureReady) return; // 幂等
    inst.readyToDeliver = true;
    inst.failureReady = false;
    inst.executionVillageId ??= villageId;
    this.store.set(COLLECTION, storageVillageId, s);
    await this.pushList(villageId);
    await this.pushMap(villageId);
  }

  /** M8 战斗结算统一入口：保留任务村、记录结局并等待玩家手动领取。 */
  private async resolveM8Battle(
    storageVillageId: string,
    inst: TaskInstance,
    executionVillageId: string,
    outcome: 'success' | 'failure',
    survivors: Record<string, number>,
  ): Promise<void> {
    if (!inst.taskVillageId || inst.outcome) return;
    await this.commands.send({
      name: 'pve.ApplyTaskVillageOutcome', from: TasksModule.NAME,
      payload: { id: inst.taskVillageId, survivors },
    });
    inst.outcome = outcome;
    inst.executionVillageId = executionVillageId;
    inst.readyToDeliver = outcome === 'success';
    inst.failureReady = outcome === 'failure';
    const state = this.ensureState(storageVillageId);
    state.outcomes ??= {};
    state.outcomes.m8 = outcome;
    this.scheduler.cancelByOwner(`task-m8-attack:${storageVillageId}`);
    this.scheduler.cancelByOwner(`task-village:${storageVillageId}:m8`);
    this.store.set(COLLECTION, storageVillageId, state);
    await this.pushList(executionVillageId);
    await this.pushMap(executionVillageId);
  }

  /**
   * 任务图 success 条件是隐藏的运行时兜底条件，不序列化到玩家任务卡。
   * 当前用于测试账号的 M1：没有任何仍需修复到 1 级的资源田时，
   * 与原有“四块资源田均已修复”目标二选一即可交付。
   */
  private async successConditionMet(villageId: string, code: string): Promise<boolean> {
    const rows = this.config.questGraph.conditions.filter((row) => row.questCode === code && row.phase === 'success');
    if (!rows.length) return false;
    const q = this.quest(code);
    const sourceVillageId = q?.scope === 'global' ? this.anchorVillage(villageId) : villageId;
    for (const row of rows) {
      if (row.kind !== 'no_damaged_resource_level') continue;
      const kinds = row.value.split('|').map((kind) => kind.trim()).filter(Boolean);
      // 旧存档/测试夹具可能没有完整的建筑队列字段；隐藏兜底条件不能阻断
      // 正常任务板读取。完整建筑状态仍按正常路径校验，异常状态视为条件未满足。
      let layout: CommandResult;
      try {
        layout = await this.commands.send({ name: 'building.GetLayout', from: TasksModule.NAME, payload: { villageId: sourceVillageId } });
      } catch {
        continue;
      }
      if (!layout.ok) continue;
      const zones = ((layout.payload as any)?.zones ?? {}) as Record<string, { placed?: Array<{ kind?: string; repairTargetLevel?: number }> }>;
      const placed = Object.values(zones).flatMap((zone) => zone?.placed ?? []);
      const damagedLevel = placed.some((building) => kinds.includes(String(building.kind ?? '')) && Number(building.repairTargetLevel) === 1);
      if (!damagedLevel) return true;
    }
    return false;
  }

  private async syncSuccessConditions(villageId: string): Promise<void> {
    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const [code, inst] of Object.entries(state.active)) {
        if (inst.readyToDeliver || this.storageVillageForQuest(villageId, code) !== storageVillageId) continue;
        if (await this.successConditionMet(villageId, code)) await this.markReady(villageId, code);
      }
    }
  }

  // ── 激活任务（m1 自动 / 其余任务手动接取共用）──
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
      repairedBuildings: [],
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
    } else if (q.objective.kind === 'build_buildings') {
      // 记录接取时已经占用的槽位（包括正在建造的建筑）。只有此前真正
      // 空着的槽位第一次建成 1 级才算 M2 的一次建造，拆除后重建不重复计数。
      const sourceVillageId = q.scope === 'global' ? this.anchorVillage(villageId) : villageId;
      const layout = await this.commands.send({ name: 'building.GetLayout', from: TasksModule.NAME, payload: { villageId: sourceVillageId } });
      const zone = q.objective.buildingZone ?? 'inner';
      const placed = ((layout.payload as any)?.zones?.[zone]?.placed ?? []) as Array<{ slotId?: string }>;
      inst.buildingInitialSlots = placed.map((p) => p.slotId).filter((slotId): slotId is string => Boolean(slotId));
      // 新任务从 0 开始累计完成事件；不能用接取后的建筑总数差值代替，
      // 否则接取时槽位已满、拆除后再建会永远无法完成目标。
      inst.buildingBaseline = placed.length;
      inst.buildingBuiltCount = 0;
      inst.buildingFreedSlots = [];
      inst.buildingCountedSlots = [];
      this.store.set(COLLECTION, storageVillageId, s);
    } else if (code === 'm8') {
      const spawned = await this.spawnTaskVillage(villageId, s, inst);
      if (spawned) {
        inst.taskVillageAttackAt = this.now() + this.config.constants.m8AttackDelaySec * 1000;
        this.store.set(COLLECTION, storageVillageId, s);
        this.scheduleM8Attack(storageVillageId, inst);
      } else {
        // 地图暂时没有空格时保持任务 active，稍后重试生成；不创建一个永远没有目标的倒计时。
        this.scheduleM8VillageRetry(storageVillageId, inst);
      }
    } else if (code === 'm9') {
      const target = s.taskVillages?.m8;
      if (target) {
        inst.taskVillageId = target.id;
        inst.taskVillageXY = { q: target.q, r: target.r };
      }
      this.store.set(COLLECTION, storageVillageId, s);
    } else if (code === 'm13') {
      // M13 的目标位置以玩家主城（全局任务锚点）为中心计算，即使玩家
      // 从分城接取也不能把“第二近丘陵群”误算成分城附近。
      const mainVillageId = this.anchorVillage(villageId);
      inst.spawnVillageId = mainVillageId;
      const spawned = await this.spawnM13TaskVillage(mainVillageId, s, inst);
      if (!spawned) this.scheduleM13VillageRetry(storageVillageId, inst);
    }
    if (await this.successConditionMet(villageId, code)) await this.markReady(villageId, code);
    // 仅建村自动激活的 m1 展示一次自动对话；手动接取的任务由 StartAccept 返回接取对话。
    // S3 的接取后追问是独立的 after_accept 对话，必须在任务真正接取成功后排入待弹队列。
    if (q.type === 'main' && code === 'm1') this.queueDialogue(storageVillageId, code, 'accept', villageId);
    else if (q.type === 'side' && code === 's3') this.queueDialogue(storageVillageId, code, 'after_accept', villageId);
    await this.pushList(villageId);
    await this.pushMap(villageId);
  }

  /**
   * 门槛类目标统一从各自 owner 模块读取结果快照，不复制建筑、人口、资源或战争迷雾状态。
   * 这些目标是“拥有/累计”而不是提交消耗；达到门槛后只标记 ready，仍需玩家手动交付。
   */
  private async syncThresholdObjectives(villageId: string): Promise<void> {
    if (!villageId) return;
    const storageIds = [...new Set(this.playerTaskStorageIds(villageId, 'm1'))];
    for (const storageVillageId of storageIds) {
      const state = this.ensureState(storageVillageId);
      let changed = false;
      for (const [code, inst] of Object.entries(state.active)) {
        const q = this.quest(code);
        if (!q || inst.readyToDeliver) continue;
        const kind = q.objective.kind;
        if (kind !== 'build_buildings' && kind !== 'population_reached' && kind !== 'resource_owned' && kind !== 'explore_tiles' && kind !== 'research_completed' && kind !== 'main_base_level' && kind !== 'reputation_at_most') continue;
        const sourceVillageId = kind === 'main_base_level'
          ? villageId
          : (q.scope === 'global' ? this.anchorVillage(villageId) : storageVillageId);
        let current = 0;
        if (kind === 'build_buildings') {
          const layout = await this.commands.send({ name: 'building.GetLayout', from: TasksModule.NAME, payload: { villageId: sourceVillageId } });
          const zone = q.objective.buildingZone ?? 'inner';
          const placed = ((layout.payload as any)?.zones?.[zone]?.placed ?? []) as Array<{ level?: number; demolishing?: boolean }>;
          const builtNow = placed.filter((p) => Number(p.level) >= 1 && !p.demolishing).length;
          // 新版只按 building.Built 事件累计，不再以当前建筑总数与 baseline
          // 做差值。这样接取时槽位已满，拆除释放后仍可在空槽完成新建。
          // 旧存档没有新字段时保留一次性 baseline 兼容；新任务在激活时已
          // 初始化 buildingInitialSlots/buildingBuiltCount，不会走这条分支。
          if (inst.buildingBaseline === undefined) {
            inst.buildingBaseline = builtNow;
            changed = true;
          }
          if (inst.buildingBuiltCount === undefined) {
            inst.buildingBuiltCount = inst.buildingInitialSlots ? Math.max(0, inst.progress ?? 0) : Math.max(inst.progress ?? 0, builtNow - inst.buildingBaseline);
            changed = true;
          }
          current = Math.max(0, inst.buildingBuiltCount);
        } else if (kind === 'population_reached') {
          const pop = await this.commands.send({ name: 'population.GetSnapshot', from: TasksModule.NAME, payload: { villageId: sourceVillageId } });
          // 人口门槛按 PopulationModule 的 totalPop 口径计算：平民、驻军、
          // 在途和训练中的士兵都属于村庄总人口。此前优先使用 currentPop
          // 会漏掉已训练士兵，导致“人丁兴旺”进度少算兵力。
          const currentPop = Number((pop.payload as any)?.currentPop);
          const soldierPop = Number((pop.payload as any)?.soldierPop);
          const trainingPop = Number((pop.payload as any)?.trainingPop);
          const totalPop = Number((pop.payload as any)?.totalPop);
          const derivedTotal = Number.isFinite(currentPop) && Number.isFinite(soldierPop)
            ? currentPop + soldierPop + (Number.isFinite(trainingPop) ? trainingPop : 0)
            : Number.NaN;
          current = Math.max(0, Math.floor(
            Number.isFinite(totalPop) ? totalPop : (Number.isFinite(derivedTotal) ? derivedTotal : (Number.isFinite(currentPop) ? currentPop : 0)),
          ));
        } else if (kind === 'resource_owned') {
          const resources = await this.commands.send({ name: 'economy.GetResources', from: TasksModule.NAME, payload: { villageId: sourceVillageId } });
          current = Math.max(0, Number((resources.payload as any)?.resources?.[q.objective.resourceKey ?? '']) || 0);
        } else if (kind === 'main_base_level') {
          const level = await this.commands.send({ name: 'building.GetBuildingLevel', from: TasksModule.NAME, payload: { villageId: sourceVillageId, kind: 'main' } });
          current = Math.max(0, Math.floor(Number((level.payload as any)?.level) || 0));
        } else if (kind === 'research_completed') {
          // 全局科技目标可由任意己方村庄完成；不要只读取任务锚点村的科技树。
          // 同时按任务文案要求校验至少有一座学院，避免仅凭旧档科技快照误判。
          const researchVillages = q.scope === 'global' ? this.playerVillageIds(villageId) : [storageVillageId];
          const completed = new Set<string>();
          let hasAcademy = false;
          for (const researchVillageId of researchVillages) {
            const research = await this.commands.send({ name: 'research.GetState', from: TasksModule.NAME, payload: { villageId: researchVillageId } });
            for (const code of (((research.payload as any)?.completed ?? []) as string[])) completed.add(code);
            const layout = await this.commands.send({ name: 'building.GetLayout', from: TasksModule.NAME, payload: { villageId: researchVillageId } });
            const placed = ((layout.payload as any)?.zones?.inner?.placed ?? []) as Array<{ kind?: string; level?: number; demolishing?: boolean }>;
            if (placed.some((building) => building.kind === 'academy' && Number(building.level) >= 1 && !building.demolishing)) hasAcademy = true;
          }
          current = hasAcademy
            ? (q.objective.researchCode ? (completed.has(q.objective.researchCode) ? 1 : 0) : completed.size)
            : 0;
        } else if (kind === 'reputation_at_most') {
          const reputation = await this.commands.send({ name: 'reputation.GetByVillage', from: TasksModule.NAME, payload: { villageId: sourceVillageId } });
          current = Number((reputation.payload as any)?.value);
          if (!Number.isFinite(current)) current = 0;
        } else {
          const playerId = this.playerDirectory.villageOwner(sourceVillageId);
          if (playerId) {
            const explored = await this.commands.send({ name: 'vision.GetExploredCount', from: TasksModule.NAME, payload: { playerId } });
            current = Math.max(0, Math.floor(Number((explored.payload as any)?.count) || 0));
          }
        }
        const target = q.objective.count ?? 1;
        const nextProgress = kind === 'build_buildings'
          ? Math.max(inst.progress ?? 0, current)
          : current;
        if (nextProgress !== (inst.progress ?? 0)) {
          inst.progress = nextProgress;
          changed = true;
        }
        const thresholdMet = kind === 'reputation_at_most'
          ? current <= (q.objective.threshold ?? 0)
          : nextProgress >= target;
        if (thresholdMet) {
          // 全局研究/探索可由任意己方村执行，完成时奖励应落到本次产生进度的村庄；
          // 仍以主城锚点读取资源、人口等“主城”口径目标。
          const executionVillageId = q.scope === 'global' && (kind === 'research_completed' || kind === 'explore_tiles')
            ? villageId
            : sourceVillageId;
          inst.executionVillageId = executionVillageId;
          this.store.set(COLLECTION, storageVillageId, state);
          await this.markReady(executionVillageId, code);
        }
      }
      if (changed) this.store.set(COLLECTION, storageVillageId, state);
    }
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

  /** M8/M9 的成功文本已并入默认 accept/deliver；只有失败分支保留 *_failure 触发器。 */
  private dialogueTrigger(villageId: string, code: string, phase: 'accept' | 'deliver', inst?: TaskInstance): string {
    if (code !== 'm8' && code !== 'm9') return phase;
    const storage = this.storageVillageForQuest(villageId, code);
    const outcome = inst?.outcome ?? this.ensureState(storage).outcomes?.m8;
    if (!outcome || outcome === 'success') return phase;
    return `${phase}_failure`;
  }

  /** 失败确认统一使用 deliver_failure；M8/M9 按结局复用同名触发器。 */
  private failureDialogueTrigger(code: string, inst: TaskInstance): string {
    if (code === 'm8' || code === 'm9') return this.dialogueTrigger(inst.executionVillageId ?? '', code, 'deliver', inst);
    return 'deliver_failure';
  }

  /** 生成 m8 的天王老子任务村并把实体坐标绑定到全局任务状态。 */
  private async spawnTaskVillage(villageId: string, state: TaskState, inst: TaskInstance): Promise<boolean> {
    if (state.taskVillages?.m8 && inst.taskVillageId) {
      const existing = await this.commands.send({ name: 'pve.GetTarget', from: TasksModule.NAME, payload: { id: inst.taskVillageId } });
      if (existing.ok) {
        const target = existing.payload as { type?: string; task?: boolean; ownerVillageId?: string; cleared?: boolean };
        // 活跃 M8 不应指向已清空的任务村。旧版重置漏删实体时，清空营地
        // 会被错误复用；清掉同属本村的残留实体后重新按当前 GM/CSV 生成。
        if (target.type === 'tianwang_village' && target.task === true && target.ownerVillageId === villageId && !target.cleared) return true;
        if (target.type !== 'tianwang_village' || (target.task !== true && target.ownerVillageId !== villageId) || (target.ownerVillageId && target.ownerVillageId !== villageId)) return false;
        const removed = await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: inst.taskVillageId } });
        if (!removed.ok) return false;
      }
      delete state.taskVillages.m8;
      inst.taskVillageId = undefined;
      inst.taskVillageXY = undefined;
      this.store.set(COLLECTION, this.storageVillageForQuest(villageId, 'm8'), state);
    }
    const xy = await this.getVillageXY(villageId);
    if (!xy) return false;
    const free = await this.commands.send({ name: 'world.FindFreeTile', from: TasksModule.NAME, payload: { centerQ: xy.q, centerR: xy.r, radius: this.config.constants.m8TaskVillageSpawnRadius } });
    if (!free.ok) return false;
    const point = free.payload as { q: number; r: number };
    const id = `taskvillage-${this.anchorVillage(villageId)}-m8`;
    let spawned = await this.commands.send({
      name: 'pve.Spawn', from: TasksModule.NAME,
      payload: {
        id, type: 'tianwang_village', q: point.q, r: point.r, task: true, ownerVillageId: villageId,
        loot: { wood: this.config.constants.m8TaskVillageResourceAmount, clay: this.config.constants.m8TaskVillageResourceAmount, iron: this.config.constants.m8TaskVillageResourceAmount, crop: this.config.constants.m8TaskVillageResourceAmount, gold: this.config.constants.m8TaskVillageGold },
      },
    });
    if (!spawned.ok && spawned.reason === 'already_exists') {
      // GM 重置/删档的旧实现可能没有及时移除稳定 id 对应的实体。只允许
      // 删除同属当前村、同类型的残留任务村，避免覆盖别的玩家的实体。
      const existing = await this.commands.send({ name: 'pve.GetTarget', from: TasksModule.NAME, payload: { id } });
      if (!existing.ok) return false;
      const target = existing.payload as { type?: string; task?: boolean; ownerVillageId?: string };
      if (target.type !== 'tianwang_village' || target.task !== true || (target.ownerVillageId && target.ownerVillageId !== villageId)) return false;
      const removed = await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id } });
      if (!removed.ok) return false;
      spawned = await this.commands.send({
        name: 'pve.Spawn', from: TasksModule.NAME,
        payload: {
          id, type: 'tianwang_village', q: point.q, r: point.r, task: true, ownerVillageId: villageId,
          loot: { wood: this.config.constants.m8TaskVillageResourceAmount, clay: this.config.constants.m8TaskVillageResourceAmount, iron: this.config.constants.m8TaskVillageResourceAmount, crop: this.config.constants.m8TaskVillageResourceAmount, gold: this.config.constants.m8TaskVillageGold },
        },
      });
    }
    if (!spawned.ok) return false;
    state.taskVillages ??= {};
    state.taskVillages.m8 = { id, q: point.q, r: point.r, name: '天王老子村' };
    inst.taskVillageId = id;
    inst.taskVillageXY = point;
    this.store.set(COLLECTION, this.storageVillageForQuest(villageId, 'm8'), state);
    await this.pushList(villageId);
    await this.pushMap(villageId);
    return true;
  }

  /** 在主城第二近的连片丘陵中随机生成 m13 秘密营地。 */
  private async spawnM13TaskVillage(villageId: string, state: TaskState, inst: TaskInstance): Promise<boolean> {
    if (state.taskVillages?.m13 && inst.taskVillageId) {
      const existing = await this.commands.send({ name: 'pve.GetTarget', from: TasksModule.NAME, payload: { id: inst.taskVillageId } });
      if (existing.ok) {
        const target = existing.payload as { type?: string; task?: boolean; ownerVillageId?: string; q?: number; r?: number };
        // 稳定 ID 可能被旧档/手工数据占用；只有确认为本玩家的秘密营地
        // 才可复用，避免把任意 PvE 目标误当成 M13 目标。
        if (target.type === 'secret_camp' && target.task === true
          && (!target.ownerVillageId || target.ownerVillageId === villageId)) {
          inst.taskVillageXY = { q: Number(target.q), r: Number(target.r) };
          inst.taskVillageName = '秘密营地';
          state.taskVillages.m13 = { id: inst.taskVillageId, q: inst.taskVillageXY.q, r: inst.taskVillageXY.r, name: '秘密营地' };
          this.store.set(COLLECTION, this.storageVillageForQuest(villageId, 'm13'), state);
          return true;
        }
      }
      delete state.taskVillages.m13;
      inst.taskVillageId = undefined;
      inst.taskVillageXY = undefined;
    }
    const origin = await this.getVillageXY(villageId);
    if (!origin) return false;
    const W = this.config.constants.worldW ?? 41;
    const H = this.config.constants.worldH ?? 41;
    const area = await this.commands.send({ name: 'world.GetArea', from: TasksModule.NAME, payload: { cq: origin.q, cr: origin.r, r: 0, full: true, includeEmpty: true } });
    if (!area.ok) return false;
    const tiles = ((area.payload as any)?.tiles ?? []) as Array<{ q: number; r: number; kind?: string; terrain?: string }>;
    const hills = new Map<string, { q: number; r: number; kind?: string }>();
    for (const tile of tiles) if (tile.terrain === 'hills') hills.set(`${tile.q},${tile.r}`, tile);
    const components: Array<Array<{ q: number; r: number; kind?: string }>> = [];
    const remaining = new Set(hills.keys());
    while (remaining.size) {
      const startKey = remaining.values().next().value as string;
      const queue = [hills.get(startKey)!];
      remaining.delete(startKey);
      const component: Array<{ q: number; r: number; kind?: string }> = [];
      while (queue.length) {
        const tile = queue.shift()!;
        component.push(tile);
        for (const next of neighborsWrapped(tile, W, H)) {
          const key = `${next.q},${next.r}`;
          if (remaining.has(key)) { remaining.delete(key); queue.push(hills.get(key)!); }
        }
      }
      components.push(component);
    }
    components.sort((a, b) => {
      const da = Math.min(...a.map((t) => hexDistanceWrapped(origin, t, W, H)));
      const db = Math.min(...b.map((t) => hexDistanceWrapped(origin, t, W, H)));
      return da - db;
    });
    const cluster = components[1] ?? components[0];
    if (!cluster?.length) return false;
    const free = cluster.filter((tile) => !tile.kind || tile.kind === 'empty');
    if (!free.length) return false;
    let point = free[Math.floor(this.rng() * free.length) % free.length];
    const id = `taskvillage-${this.anchorVillage(villageId)}-m13`;
    let spawned = await this.commands.send({ name: 'pve.Spawn', from: TasksModule.NAME, payload: { id, type: 'secret_camp', q: point.q, r: point.r, task: true, ownerVillageId: villageId, loot: { wood: 1000, clay: 1000, iron: 1000, crop: 1000, gold: 500 } } });
    if (!spawned.ok && spawned.reason === 'already_exists') {
      // 稳定 ID 冲突时只接受同类型、同玩家的任务村；若是其它实体，
      // 保留它并让调度器稍后重试，绝不覆盖别人的 PvE 目标。
      const existing = await this.commands.send({ name: 'pve.GetTarget', from: TasksModule.NAME, payload: { id } });
      const target = existing.ok ? existing.payload as { type?: string; task?: boolean; ownerVillageId?: string; q?: number; r?: number } : undefined;
      if (!target || target.type !== 'secret_camp' || target.task !== true || (target.ownerVillageId && target.ownerVillageId !== villageId)) return false;
      point.q = Number(target.q);
      point.r = Number(target.r);
      spawned = { ok: true, payload: { id, type: 'secret_camp', q: point.q, r: point.r } };
    }
    if (!spawned.ok) return false;
    state.taskVillages ??= {};
    state.taskVillages.m13 = { id, q: point.q, r: point.r, name: '秘密营地' };
    inst.taskVillageId = id;
    inst.taskVillageXY = { q: point.q, r: point.r };
    inst.taskVillageName = '秘密营地';
    this.store.set(COLLECTION, this.storageVillageForQuest(villageId, 'm13'), state);
    await this.pushList(villageId);
    await this.pushMap(villageId);
    return true;
  }

  private scheduleM13VillageRetry(storageVillageId: string, inst: TaskInstance): void {
    const owner = `task-village:${storageVillageId}:m13`;
    this.scheduler.cancelByOwner(owner);
    this.scheduler.schedule(30_000, async () => {
      const state = this.ensureState(storageVillageId);
      const current = state.active.m13;
      if (!current || current.outcome || current.taskVillageId) return;
      if (!(await this.spawnM13TaskVillage(current.spawnVillageId ?? storageVillageId, state, current))) this.scheduleM13VillageRetry(storageVillageId, current);
    }, owner, `village:${storageVillageId}`);
  }

  /**
   * 启动恢复时修复旧版“任务状态仍 active、但任务村已被清空”的半结算状态。
   * 正常的 M8 战斗会由 resolveM8Battle 写入 outcome 并把营地置回 cleared=false；
   * 只有旧重置漏删或进程在两个 owner 写入之间退出时才会命中这里。已发出的
   * NPC 攻城不在此自动改写，避免覆盖正在结算的战斗。
   */
  private async repairM8TaskVillage(storageVillageId: string, state: TaskState, inst: TaskInstance): Promise<void> {
    if (!inst.taskVillageId) return;
    const current = await this.commands.send({ name: 'pve.GetTarget', from: TasksModule.NAME, payload: { id: inst.taskVillageId } });
    let recreate = !current.ok;
    if (current.ok) {
      const target = current.payload as { type?: string; task?: boolean; ownerVillageId?: string; cleared?: boolean };
      recreate = target.type !== 'tianwang_village'
        || (target.ownerVillageId && target.ownerVillageId !== (inst.spawnVillageId ?? storageVillageId))
        || target.cleared === true;
    }
    if (!recreate) return;

    // 归属不匹配时绝不删除别的玩家的实体；清理自己的旧实体后再按稳定 id 重建。
    const target = current.ok ? current.payload as { type?: string; task?: boolean; ownerVillageId?: string } : undefined;
    const ownerVillageId = inst.spawnVillageId ?? storageVillageId;
    const ownsTarget = !target?.ownerVillageId || target.ownerVillageId === ownerVillageId;
    if (current.ok && !ownsTarget) return;
    if (current.ok) await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: inst.taskVillageId } });

    if (state.taskVillages?.m8?.id === inst.taskVillageId) delete state.taskVillages.m8;
    inst.taskVillageId = undefined;
    inst.taskVillageXY = undefined;
    this.store.set(COLLECTION, storageVillageId, state);
    const spawned = await this.spawnTaskVillage(ownerVillageId, state, inst);
    if (spawned) {
      inst.taskVillageAttackAt = this.now() + this.config.constants.m8AttackDelaySec * 1000;
      this.store.set(COLLECTION, storageVillageId, state);
    }
  }

  /** M8 生成失败时保留任务并稍后重试，避免地图满/落位时静默卡死。 */
  private scheduleM8VillageRetry(storageVillageId: string, inst: TaskInstance): void {
    const owner = `task-village:${storageVillageId}:m8`;
    this.scheduler.cancelByOwner(owner);
    this.scheduler.schedule(30_000, async () => {
      const state = this.ensureState(storageVillageId);
      const current = state.active.m8;
      if (!current || current.outcome || current.taskVillageId) return;
      const spawned = await this.spawnTaskVillage(current.spawnVillageId ?? storageVillageId, state, current);
      if (spawned) {
        current.taskVillageAttackAt = this.now() + this.config.constants.m8AttackDelaySec * 1000;
        this.store.set(COLLECTION, storageVillageId, state);
        this.scheduleM8Attack(storageVillageId, current);
      } else {
        this.scheduleM8VillageRetry(storageVillageId, current);
      }
    }, owner, `village:${storageVillageId}`);
  }

  /** m8 延迟攻城调度；重启时按剩余时间恢复，任务结局后自动取消。 */
  private scheduleM8Attack(storageVillageId: string, inst: TaskInstance): void {
    const at = inst.taskVillageAttackAt;
    if (!at || inst.outcome || !inst.taskVillageId) return;
    const owner = `task-m8-attack:${storageVillageId}`;
    this.scheduler.cancelByOwner(owner);
    const delay = Math.max(0, at - this.now());
    this.scheduler.schedule(delay, async () => {
      const state = this.ensureState(storageVillageId);
      const current = state.active.m8;
      if (!current || current.outcome || !current.taskVillageId) return;
      const targetVillage = this.anchorVillage(storageVillageId);
      const sent = await this.commands.send({ name: 'movement.SendTaskVillageAttack', from: TasksModule.NAME, payload: { taskVillageId: current.taskVillageId, targetVillage, taskCode: 'm8' } });
      if (!sent.ok) {
        // 目标实体仍在地图上，延迟重试而不把任务静默判为完成；
        // 避免旧档守军为空时 delay=0 的忙循环占满调度器。
        current.taskVillageAttackAt = this.now() + 60_000;
        this.store.set(COLLECTION, storageVillageId, state);
        this.scheduleM8Attack(storageVillageId, current);
      } else {
        current.taskVillageAttackDispatched = true;
        this.store.set(COLLECTION, storageVillageId, state);
      }
    }, owner, `village:${storageVillageId}`);
  }

  /** 在村庄周围范围内随机选点生成任务营地（task=true，不掉落/不自动重生）。 */
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
      const campId = `taskcamp-${villageId}-${inst.code}-${i}`;
      const free = await this.commands.send({ name: 'world.FindFreeTile', from: TasksModule.NAME, payload: { centerQ: xy.q, centerR: xy.r, radius, salt: campId } });
      if (!free.ok) break;
      const { q: cq, r: cr } = free.payload as { q: number; r: number };
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
  private async completeQuest(villageId: string, code: string): Promise<{ resources: Record<string, number> | null; treasures: string[]; reputation?: number; reputationResetFrom?: number; population?: number; populationGrowth?: { percent: number; durationSec: number; expiresAt?: number }; resourceGrowth?: { percent: number; durationSec: number; expiresAt?: number }; buildingUnlocks?: string[]; researchPoints?: number; mercenaries?: Record<string, number>; rewardVillageId?: string } | null> {
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    const inst = s.active[code];
    if (!inst) return null;
    const q = this.quest(code);
    if (!q) return null;
    const rewardVillageId = q.scope === 'global' ? (inst.executionVillageId ?? villageId) : villageId;
    // m8 自身无论守城成功/失败都按同一份奖励领取；m9 则按 m8 结局
    // 从声明式条件奖励中选择人口或铁壁勋章。
    const outcome = inst.outcome ?? (code === 'm9' ? s.outcomes?.m8 : undefined);
    const outcomeKey = (code === 'm8' || code === 'm9') && outcome
      ? (outcome === 'success' ? 'm8_success' : 'm8_failure')
      : undefined;
    const rewardsDef: QuestRewards = (code === 'm9' && outcomeKey ? q.conditionalRewards?.[outcomeKey] : undefined) ?? q.rewards;

    // 移除残留营地
    for (const c of inst.camps) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: c.id } });
    }
    this.scheduler.cancelByOwner(`task-camp:${storageVillageId}:${code}`);
    if (code === 'm8') {
      this.scheduler.cancelByOwner(`task-m8-attack:${storageVillageId}`);
      this.scheduler.cancelByOwner(`task-village:${storageVillageId}:m8`);
    }

    const granted: { resources: Record<string, number> | null; treasures: string[]; reputation?: number; reputationResetFrom?: number; population?: number; populationGrowth?: { percent: number; durationSec: number; expiresAt?: number }; resourceGrowth?: { percent: number; durationSec: number; expiresAt?: number }; buildingUnlocks?: string[]; researchPoints?: number; mercenaries?: Record<string, number>; rewardVillageId?: string } = { resources: null, treasures: [], rewardVillageId };
    // 资源奖励
    if (rewardsDef.resources && Object.keys(rewardsDef.resources).length) {
      await this.commands.send({ name: 'economy.Grant', from: TasksModule.NAME, payload: { villageId: rewardVillageId, gain: rewardsDef.resources } });
      granted.resources = { ...rewardsDef.resources };
    }
    if (rewardsDef.population && rewardsDef.population > 0) {
      const population = await this.commands.send({
        name: 'population.GrantPopulation', from: TasksModule.NAME,
        payload: { villageId: rewardVillageId, amount: rewardsDef.population },
      });
      if (population.ok) granted.population = Number((population.payload as any)?.applied) || 0;
    }
    if (rewardsDef.populationGrowth) {
      const growth = await this.commands.send({
        name: 'population.ApplyTaskGrowthBuff', from: TasksModule.NAME,
        payload: { villageId: rewardVillageId, percent: rewardsDef.populationGrowth.percent, durationSec: rewardsDef.populationGrowth.durationSec },
      });
      if (growth.ok) {
        granted.populationGrowth = {
          ...rewardsDef.populationGrowth,
          expiresAt: Number((growth.payload as any)?.expiresAt) || undefined,
        };
      }
    }
    if (rewardsDef.resourceGrowth) {
      const percent = rewardsDef.resourceGrowth.percent / 100;
      const resource = rewardsDef.resourceGrowth.resource;
      const mult = resource
        ? { [resource]: percent }
        : { wood: percent, clay: percent, iron: percent, crop: percent };
      const growth = await this.commands.send({
        name: 'economy.ApplyTimedBuff', from: TasksModule.NAME,
        payload: {
          villageId: rewardVillageId,
          source: `task:${code}:resource_growth`,
          mult,
          durationSec: rewardsDef.resourceGrowth.durationSec,
        },
      });
      if (growth.ok) {
        granted.resourceGrowth = {
          ...rewardsDef.resourceGrowth,
          expiresAt: Number((growth.payload as any)?.until) || undefined,
        };
      }
    }
    if (rewardsDef.buildingUnlocks?.length) {
      const unlocked = await this.commands.send({
        name: 'building.UnlockBuildings', from: TasksModule.NAME,
        payload: { villageId: rewardVillageId, kinds: rewardsDef.buildingUnlocks },
      });
      if (unlocked.ok) granted.buildingUnlocks = rewardsDef.buildingUnlocks;
    }
    if (rewardsDef.reputation) {
      await this.commands.send({
        name: 'reputation.AdjustByVillage', from: TasksModule.NAME,
        payload: { villageId: rewardVillageId, delta: rewardsDef.reputation, reason: `task_${code}_success` },
      });
      granted.reputation = rewardsDef.reputation;
    }
    // M14：交付时读取当前总声望；若为正数则归零，每减少 1 点发放配置数量的
    // 无期限佣兵。任务奖励直接写入 military.troops，不创建 mercenary contract，
    // 因而既不占人口/粮耗，也不会被雇佣兵营地的合同到期逻辑移除。
    if (rewardsDef.reputationMercenaryExchange) {
      const exchange = rewardsDef.reputationMercenaryExchange;
      const reputation = await this.commands.send({ name: 'reputation.GetByVillage', from: TasksModule.NAME, payload: { villageId: rewardVillageId } });
      const before = Math.max(0, Math.trunc(Number((reputation.payload as any)?.value) || 0));
      if (reputation.ok && before > 0) {
        const count = Math.max(0, Math.floor(before * exchange.perPoint));
        const added = await this.commands.send({
          name: 'military.AddMercenaries', from: TasksModule.NAME,
          payload: { villageId: rewardVillageId, units: { [exchange.unitCode]: count } },
        });
        if (added.ok) {
          const reset = await this.commands.send({
            name: 'reputation.AdjustByVillage', from: TasksModule.NAME,
            payload: { villageId: rewardVillageId, delta: -before, reason: `task_${code}_reputation_exchange` },
          });
          if (reset.ok) {
            granted.reputation = (granted.reputation ?? 0) - before;
            granted.reputationResetFrom = before;
            granted.mercenaries = { [exchange.unitCode]: count };
          }
        }
      }
    }
    if (rewardsDef.researchPoints && rewardsDef.researchPoints > 0) {
      const rp = await this.commands.send({ name: 'research.GrantPoints', from: TasksModule.NAME, payload: { villageId: rewardVillageId, amount: rewardsDef.researchPoints } });
      if (rp.ok) granted.researchPoints = Number((rp.payload as any)?.amount) || rewardsDef.researchPoints;
    }
    // 任务专属宝物：被动(持续)类强制锁定；即时(一次性，如祭祀台)类不锁定，供玩家主动使用。
    for (const t of rewardsDef.treasures ?? []) {
      // carry_flag 已在军旗归城时由 treasure.ExchangeQuestFlag 原子兑换，禁止通用奖励路径重复生成。
      if (q.objective.kind === 'carry_flag' && t === 'victory_flag') continue;
      const def = this.config.treasures[t];
      // 任务奖励与其他宝物一样占用栏位；满栏时进入待处理报告，由玩家决定领取/出售/丢弃。
      await this.commands.send({ name: 'treasure.Grant', from: TasksModule.NAME, payload: { villageId: rewardVillageId, code: t, pendingIfFull: true, rewardVillageId } });
      granted.treasures.push(t);
    }

    if ((code === 'm9' || code === 'm13') && inst.taskVillageId) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: inst.taskVillageId } });
      if (s.taskVillages) delete s.taskVillages[code === 'm13' ? 'm13' : 'm8'];
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
    return { ok: true, payload: await this.snapshotForVillage(villageId) };
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
    s.offered = s.offered.filter((x) => x !== code);
    s.offeredSide = s.offeredSide.filter((x) => x !== code);
    // 触发状态属于村庄运行态；撤销完成后必须重新触发，不能立刻再次接取。
    if (q.trigger) s.firedTriggers = s.firedTriggers.filter((x) => x !== q.trigger);
    this.store.set(COLLECTION, this.storageVillageForQuest(villageId, code), s);
    await this.pushList(villageId);
    await this.pushMap(villageId);
    // 没有触发条件的支线可立刻重新出现；有触发条件的由下一次领域事件解锁。
    if (!q.trigger) await this.unlockSideQuests(villageId);
    return { ok: true, payload: await this.snapshotForVillage(villageId) };
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
    return { ok: true, payload: await this.snapshotForVillage(villageId) };
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
    await this.notifyTaskCampRemoved(camp);

    if (inst.campCleared >= inst.camps.length) {
      // 临时任务营地不走普通 droprate，也不能随机掉落其它任务专属宝物。
      // 只有 S4 的最后一处营地明确配置了“被囚禁的娜塔莉们”阶段性道具，
      // 该道具仍通过报告等待处理；M4/D2 等其它任务营地完全不产宝物。
      if (q.code === 's4') {
        await this.commands.send({
          name: 'treasure.RollDrop', from: TasksModule.NAME,
          payload: {
            villageId: updateVillageId,
            source: 'camp',
            movementId: payload.movementId,
            forceCode: 'captured_natalies',
            taskRelated: true,
          },
        });
        inst.awaitingNatalieDecision = true;
        inst.awaitingNatalieCode = 'captured_natalies';
        this.store.set(COLLECTION, storageVillageId, state);
        await this.pushList(updateVillageId);
        await this.pushMap(updateVillageId);
      } else if (q.code === 'm12') {
        // m12 的最后一个强盗营地固定掉落“我的努力”，走报告待领取流程，
        // 不参加普通 PvE 掉落表，也不重复发放任务奖励。
        await this.commands.send({ name: 'treasure.RollDrop', from: TasksModule.NAME, payload: { villageId: updateVillageId, source: 'camp', movementId: payload.movementId, forceCode: 'my_effort', taskRelated: true } });
        await this.markReady(updateVillageId, q.code);
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

  /** 任务营地清除后立即使目标失效；实体状态仍保留到任务收尾，避免破坏任务快照。 */
  private async notifyTaskCampRemoved(camp: TaskCamp): Promise<void> {
    await this.bus.emit({
      name: 'pve.TargetRemoved', source: TasksModule.NAME, ts: this.now(),
      payload: { id: camp.id, q: camp.q, r: camp.r, task: true },
    } as DomainEvent);
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

  /** M8/M9 任务村坐标统一以 PvE/World 的 refId 查询结果为准。 */
  private async syncTaskVillageCoordinates(villageId: string): Promise<void> {
    const seen = new Set<string>();
    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const inst of Object.values(state.active)) {
        if ((inst.code !== 'm8' && inst.code !== 'm9' && inst.code !== 'm13') || !inst.taskVillageId) continue;
        const key = `${storageVillageId}:${inst.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const target = await this.commands.send({ name: 'pve.GetTarget', from: TasksModule.NAME, payload: { id: inst.taskVillageId } });
        if (!target.ok) continue;
        const row = target.payload as { q?: number; r?: number };
        const q = Number(row.q), r = Number(row.r);
        if (!Number.isFinite(q) || !Number.isFinite(r)) continue;
        const villageKey = inst.code === 'm13' ? 'm13' : 'm8';
        if (inst.taskVillageXY?.q === q && inst.taskVillageXY?.r === r && state.taskVillages?.[villageKey]?.q === q && state.taskVillages?.[villageKey]?.r === r) continue;
        inst.taskVillageXY = { q, r };
        if (state.taskVillages?.[villageKey]?.id === inst.taskVillageId) state.taskVillages[villageKey] = { ...state.taskVillages[villageKey], q, r };
        this.store.set(COLLECTION, storageVillageId, state);
      }
    }
  }

  /** 刷新酒馆随机任务（按权重重新抽取，填满接取上限）。 */
  private async gmRefreshRandom(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    if (!villageId) return { ok: false, payload: {}, reason: 'villageId_required' };
    const info = await this.tavernInfo(villageId);
    if (info.level <= 0) return { ok: false, payload: {}, reason: 'no_tavern' };
    await this.refreshOffered(villageId, info);
    return { ok: true, payload: await this.snapshot(villageId, this.ensureState(villageId)) };
  }

  /** 重置本村全部任务进度（删状态+营地、重激活 m1）。 */
  private async gmReset(cmd: Command): Promise<CommandResult> {
    const { villageId } = cmd.payload as { villageId: string };
    if (!villageId) return { ok: false, payload: {}, reason: 'villageId_required' };
    // 必须先等待旧实体从 pve/world 两个 owner 中移除，再允许 M8 重新生成。
    // 旧实现只异步删除 active.camps，漏掉 taskVillages.m8，导致稳定 id 复用
    // 已清空的天王老子村，表现为“重置后再次接取但守军/资源全为空”。
    await this.wipeSingleVillageAsync(villageId);
    this.store.set(COLLECTION, villageId, emptyTaskState(villageId));
    await this.unlockMainQuests(villageId);
    return { ok: true, payload: await this.snapshot(villageId, this.ensureState(villageId)) };
  }

  /** 重置所有玩家/村庄的任务进度；只清 task 状态和任务营地，不触碰其他游戏存档。 */
  private async gmResetAll(_cmd: Command): Promise<CommandResult> {
    const players = await this.commands.send({ name: 'player.ListAll', from: TasksModule.NAME, payload: {} });
    if (!players.ok) return { ok: false, payload: {}, reason: players.reason ?? 'players_unavailable' };
    const playerRows = ((players.payload as any)?.players ?? []) as Array<{ villages?: Array<{ id?: string }> }>;
    const villageIds = [...new Set(playerRows.flatMap((p) => (p.villages ?? []).map((v) => String(v.id ?? '')).filter(Boolean)))];
    const existingIds = this.store.all<TaskState>(COLLECTION).map((state) => state.villageId).filter(Boolean);
    const allIds = [...new Set([...existingIds, ...villageIds])];
    // 旧版本曾出现 task 状态与 pve 任务营地脱节：只遍历 active.camps 会留下孤儿营地。
    // 全量重置必须以 pve 目录为最终边界，逐个调用 owner 模块的 Remove，连同地图地块一起清理。
    const targets = await this.commands.send({ name: 'pve.ListTargets', from: TasksModule.NAME, payload: {} });
    const taskCampIds = targets.ok
      ? (((targets.payload as any)?.targets ?? []) as Array<{ id?: string; task?: boolean }>).filter((target) => target.task && target.id).map((target) => String(target.id))
      : [];
    for (const villageId of allIds) await this.wipeSingleVillageAsync(villageId);
    for (const id of taskCampIds) await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id } });
    for (const villageId of villageIds) {
      this.store.set(COLLECTION, villageId, emptyTaskState(villageId));
      await this.unlockMainQuests(villageId);
      await this.pushList(villageId);
    }
    return {
      ok: true,
      payload: { resetPlayers: playerRows.length, resetVillages: villageIds.length, clearedTaskStates: existingIds.length, clearedTaskCamps: taskCampIds.length },
    };
  }

  // ── 主线解锁（m1 自动激活，其余进入手动接取列表）──
  private async mainTriggerSatisfied(villageId: string, trigger: string | undefined): Promise<boolean> {
    if (!trigger) return true;
    const [kind, rawValue] = trigger.split(':');
    if (kind !== 'main_base_level') return true;
    const required = Math.max(1, Number(rawValue) || 1);
    const level = await this.commands.send({ name: 'building.GetBuildingLevel', from: TasksModule.NAME, payload: { villageId, kind: 'main' } });
    return level.ok && Number((level.payload as any)?.level) >= required;
  }

  /** 声明式 offer 条件的运行时求值；所有 offer 行必须满足（group=any 的行可作为 OR 组）。 */
  private async offerConditionsSatisfied(villageId: string, q: QuestDef): Promise<boolean> {
    const rows = this.config.questGraph.conditions.filter((row) => row.questCode === q.code && row.phase === 'offer');
    if (!rows.length) return true;
    const state = this.ensureState(this.storageVillageForQuest(villageId, q.code));
    const evaluate = async (row: typeof rows[number]): Promise<boolean> => {
      const value = row.value.trim();
      if (row.kind === 'main_base_level') {
        const level = await this.commands.send({ name: 'building.GetBuildingLevel', from: TasksModule.NAME, payload: { villageId, kind: 'main' } });
        return level.ok && Number((level.payload as any)?.level) >= Math.max(1, Number(value) || 1);
      }
      if (row.kind === 'building_level') {
        const [kind, rawLevel] = value.split(':');
        const level = await this.commands.send({ name: 'building.GetBuildingLevel', from: TasksModule.NAME, payload: { villageId, kind } });
        return level.ok && Number((level.payload as any)?.level) >= Math.max(1, Number(rawLevel) || 1);
      }
      const key = row.kind + (value ? `:${value}` : '');
      return state.firedTriggers.includes(row.kind) || state.firedTriggers.includes(key);
    };
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) { const list = grouped.get(row.group) ?? []; list.push(row); grouped.set(row.group, list); }
    for (const [group, groupRows] of grouped) {
      const results = await Promise.all(groupRows.map(evaluate));
      if (group.toLowerCase() === 'any' ? !results.some(Boolean) : !results.every(Boolean)) return false;
    }
    return true;
  }

  private async unlockMainQuests(villageId: string): Promise<void> {
    for (const q of this.catalog.all()) {
      if (q.type !== 'main') continue;
      const storageVillageId = this.storageVillageForQuest(villageId, q.code);
      const s = this.ensureState(storageVillageId);
      if (s.completedMain.includes(q.code)) continue;
      if (s.active[q.code] || s.offeredMain.includes(q.code)) continue;
      if (this.prereqsMet(villageId, q.requires) && await this.mainTriggerSatisfied(villageId, q.trigger) && await this.offerConditionsSatisfied(villageId, q)) {
        try {
          if (q.code === 'm1') await this.activateQuest(villageId, q.code);
          else {
            s.offeredMain.push(q.code);
            this.store.set(COLLECTION, storageVillageId, s);
          }
        } catch { /* 忽略单条失败，继续其它 */ }
      }
    }
  }

  /** 支线任务解锁（一次性 + 触发条件 + 前置链）：满足条件的支线进入可接取列表。 */
  private async unlockSideQuests(villageId: string): Promise<void> {
    for (const q of this.catalog.all()) {
      if (q.type !== 'side') continue;
      const storageVillageId = this.storageVillageForQuest(villageId, q.code);
      const s = this.ensureState(storageVillageId);
      let changed = false;
      if (s.completedSide.includes(q.code)) continue;
      if (s.abandonedSide.includes(q.code)) continue; // 放弃过 → 永久不再出现
      if (s.active[q.code]) continue;
      if (this.sideClaimedByPlayer(villageId, q.code)) continue;
      // 酒馆刷新型支线由 refreshOffered 按槽位概率管理，不走事件触发解锁。
      if (q.trigger === 'tavern_refresh') continue;
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
    const p = evt.payload as { villageId?: string; side?: string; targetKind?: string; targetId?: string; attackerWins?: boolean; movementId?: string; treasures?: string[]; campCleared?: boolean; looted?: Record<string, number>; deployedTroops?: Record<string, number>; survivors?: Record<string, number>; taskCode?: string; npcService?: boolean };
    if (p.side !== 'attacker') return;
    const villageId = p.villageId;
    const targetId = p.targetId;
    // m13 规定只要对秘密营地选择掠夺即失败（无论战斗胜负），
    // 失败仍需玩家在任务页确认后结束，避免任务凭空消失。
    if (p.targetKind === 'pve' && targetId) {
      for (const { storageVillageId, state } of this.taskCandidates(villageId ?? '')) {
        const inst = state.active.m13;
        if (inst?.taskVillageId === targetId && !inst.outcome) {
          inst.executionVillageId = villageId;
          inst.outcome = 'failure';
          inst.failureReady = true;
          inst.readyToDeliver = false;
          this.store.set(COLLECTION, storageVillageId, state);
          await this.pushList(villageId ?? storageVillageId);
          await this.pushMap(villageId ?? storageVillageId);
          return;
        }
      }
    }
    // m8 的 NPC 攻城贡献没有真实出发村；通过目标村反查玩家任务锚点，
    // 战斗结束后保存任务村剩余兵力/减半资源，并把 m8 置为可手动领取。
    if (p.taskCode === 'm8' && p.npcService && p.targetKind === 'village' && targetId) {
      await this.playerDirectory.refreshVillage(targetId);
      const owner = this.playerDirectory.villageOwner(targetId);
      const storageVillageId = owner ? (this.playerDirectory.villages(owner)[0] ?? targetId) : targetId;
      const state = this.ensureState(storageVillageId);
      const inst = state.active.m8;
      if (!inst || !inst.taskVillageId || inst.outcome) return;
      await this.resolveM8Battle(storageVillageId, inst, targetId, p.attackerWins ? 'failure' : 'success', p.survivors ?? {});
      return;
    }
    if (!villageId || !targetId) return;

    // 玩家在 NPC 预定攻城前主动清空天王老子村，也算 M8 防守成功。
    // Combat 已先调用 pve.ApplyResult；这里把任务村恢复为“战后幸存者”状态，
    // 保留实体与剩余任务村，避免被普通 PvE 清空逻辑删除。
    if (p.targetKind === 'pve' && p.attackerWins && p.campCleared === true) {
      const state = this.stateForQuest(villageId, 'm8');
      const inst = state.active.m8;
      if (inst?.taskVillageId === targetId && !inst.outcome) {
        // ApplyResult 已将任务村守军全部扣除；此处传空快照，不能误把进攻方幸存者
        // 当成任务村守军，否则任务村会凭空复活一批玩家自己的兵。
        await this.resolveM8Battle(this.storageVillageForQuest(villageId, 'm8'), inst, villageId, 'success', {});
        return;
      }
    }

    // m9 只要求成功抵达并掠夺任务村；不要求把战后残余守军清零。
    if (p.targetKind === 'pve' && p.attackerWins && targetId) {
      const state = this.stateForQuest(villageId, 'm9');
      const inst = state.active.m9;
      if (inst?.taskVillageId === targetId) {
        inst.executionVillageId = villageId;
        await this.markReady(villageId, 'm9');
        return;
      }
    }

    // 默认战败不影响任务生命周期：任务营地继续留在地图上，允许玩家再次派兵。
    // 只有任务定义明确增加“战败即失败”规则时才应在这里另行处理；当前任务图没有此类任务。
    if (!p.attackerWins) {
      if (p.targetKind === 'pve') await this.preserveTaskCampAfterDefeat(villageId, targetId);
      return;
    }

    // 村民的请求：只有清空常驻普通 PvE 营地后，才按 GM 概率触发支线任务。
    // 任务模块生成的临时营地（task=true）与幸福村等不重生 NPC（noRespawn=true）
    // 都不是常驻营地，不能意外推进“村民的请求”。Combat 的事件只携带通用字段，
    // 因此这里回查 PvE owner 的快照作为唯一判定依据，而不是依赖 targetId 命名约定。
    let residentPveCleared = false;
    if (p.targetKind === 'pve' && p.campCleared === true) {
      const target = await this.commands.send({ name: 'pve.GetTarget', from: TasksModule.NAME, payload: { id: targetId } });
      const targetState = target.payload as { task?: boolean; noRespawn?: boolean } | undefined;
      residentPveCleared = target.ok && !!targetState && targetState.task !== true && targetState.noRespawn !== true;
    }
    if (residentPveCleared) {
      const chance = this.gmNum('villager_request_trigger_chance', 0.3);
      if (this.rng() < chance) {
        for (const q of this.catalog.all().filter((x) => x.trigger === 'pve_camp_cleared')) {
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
        // 失败路径：玩家选择掠夺幸福村（而非送达粮食）→ 进入任务失败确认，
        // 由玩家在任务页点击“任务失败”后才发放 failure 阶段奖励/对话。
        if (p.targetKind === 'pve' && q.objective.kind === 'deliver_to_npc' && inst.npcVillageId && targetId === inst.npcVillageId && p.attackerWins) {
          const rewardVillageId = inst.spawnVillageId ?? villageId;
          await this.removeNpc(rewardVillageId, inst);
          inst.executionVillageId = villageId;
          inst.outcome = 'failure';
          inst.failureReady = true;
          inst.readyToDeliver = false;
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
        await this.notifyTaskCampRemoved(camp);
        if (inst.campCleared >= inst.camps.length) {
          // 任务营地不按宝物 droprate 抽取；S4 仅在最后一处营地发放其明确定义的阶段道具。
          if (code === 's4') {
            await this.commands.send({
              name: 'treasure.RollDrop', from: TasksModule.NAME,
              payload: { villageId, source: 'camp', movementId: p.movementId, forceCode: 'captured_natalies', taskRelated: true },
            });
            inst.awaitingNatalieDecision = true;
            inst.awaitingNatalieCode = 'captured_natalies';
            this.store.set(COLLECTION, storageVillageId, state);
            await this.pushList(villageId);
            await this.pushMap(villageId);
          } else if (code === 'm12') {
            await this.commands.send({ name: 'treasure.RollDrop', from: TasksModule.NAME, payload: { villageId, source: 'camp', movementId: p.movementId, forceCode: 'my_effort', taskRelated: true } });
            await this.markReady(villageId, code);
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

  /** 声望变化后及时推进“达到负声望阈值”类任务，而不是等玩家重新打开任务页。 */
  private async onReputationChanged(evt: DomainEvent): Promise<void> {
    const payload = evt.payload as { playerIds?: string[]; playerId?: string };
    const playerIds = [...new Set([...(payload.playerIds ?? []), payload.playerId].filter((id): id is string => Boolean(id)))];
    for (const playerId of playerIds) {
      await this.playerDirectory.refreshPlayer(playerId);
      for (const villageId of this.playerDirectory.villages(playerId)) {
        await this.syncThresholdObjectives(villageId);
      }
    }
  }

  /** 训练完成后检查兵力门槛；同时 resume 会补查，避免服务器重启漏掉已达标玩家。 */
  private async onTroopTrained(evt: DomainEvent): Promise<void> {
    const villageId = (evt.payload as { villageId?: string }).villageId;
    if (!villageId) return;
    await this.checkTroopTriggers(villageId);
  }

  private async onTreasureUsed(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId?: string; code?: string };
    if (!p.villageId || !p.code) return;
    const storageVillageId = this.storageVillageForQuest(p.villageId, 'm13');
    const state = this.ensureState(storageVillageId);
    const trigger = `treasure_used:${p.code}`;
    if (!state.firedTriggers.includes(trigger)) {
      state.firedTriggers.push(trigger);
      this.store.set(COLLECTION, storageVillageId, state);
    }
    await this.unlockMainQuests(p.villageId);
  }

  private async onInvestigated(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId?: string; targetId?: string };
    if (!p.villageId || !p.targetId) return;
    for (const { storageVillageId, state } of this.taskCandidates(p.villageId)) {
      const inst = state.active.m13;
      const q = this.quest('m13');
      if (!inst || !q || q.objective.kind !== 'investigate_task_village' || inst.taskVillageId !== p.targetId || inst.readyToDeliver) continue;
      inst.executionVillageId = p.villageId;
      this.store.set(COLLECTION, storageVillageId, state);
      await this.markReady(p.villageId, 'm13');
      return;
    }
  }

  /** 训练事件与服务器恢复共用的兵力门槛检查。 */
  private async checkTroopTriggers(villageId: string): Promise<void> {
    const army = await this.commands.send({ name: 'military.GetArmy', from: TasksModule.NAME, payload: { villageId } });
    const troops = ((army.payload as { troops?: Record<string, number> } | undefined)?.troops) ?? {};
    const total = Object.values(troops).reduce((sum, n) => sum + Math.max(0, Number(n) || 0), 0);
    for (const q of this.catalog.all()) {
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
    const p = evt.payload as { villageId: string; kind: string; level?: number; slotId?: string };
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
    // 建筑完成事件只在新建至 1 级时推进 build_buildings；升级不会计数。
    // 接取前已有建筑不会计数；接取后完整拆除释放的槽位再次建成时，
    // 视为空槽上的一次新建，从而避免接取时槽位全满把任务锁死。
    if (Number(p.level) === 1) {
      const builtDef = this.config.buildings[kind];
      for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
        for (const [code, inst] of Object.entries(state.active)) {
          const q = this.quest(code);
          if (!q || q.objective.kind !== 'build_buildings' || inst.readyToDeliver) continue;
          if (this.storageVillageForQuest(villageId, code) !== storageVillageId) continue;
          const expectedZone = q.objective.buildingZone ?? 'inner';
          if (!builtDef || builtDef.zone !== expectedZone) continue;
          // global 目标“主城建造”明确只统计锚定主城；村庄级目标统计所属村。
          const sourceVillageId = q.scope === 'global' ? this.anchorVillage(villageId) : storageVillageId;
          if (sourceVillageId !== villageId) continue;
          const slotId = p.slotId;
          if (!slotId) continue;
          const initialSlots = inst.buildingInitialSlots ?? [];
          const freedSlots = inst.buildingFreedSlots ?? [];
          if (initialSlots.includes(slotId) && !freedSlots.includes(slotId)) continue;
          inst.buildingCountedSlots ??= [];
          if (inst.buildingCountedSlots.includes(slotId)) continue;
          const target = q.objective.count ?? 1;
          inst.buildingCountedSlots.push(slotId);
          inst.buildingBuiltCount = (inst.buildingBuiltCount ?? 0) + 1;
          inst.progress = Math.max(inst.progress ?? 0, inst.buildingBuiltCount);
          inst.executionVillageId = villageId;
          this.store.set(COLLECTION, storageVillageId, state);
          if (inst.progress >= target) await this.markReady(villageId, code);
          else await this.pushList(villageId);
        }
      }
    }

    // Building-level offer conditions (for example M12's council requirement)
    // are evaluated when the building is completed as well as when the task
    // list is opened.  Do this independently of legacy building_built
    // triggers so a newly completed council can expose M12 immediately.
    await this.unlockMainQuests(villageId);

    const triggerKey = `building_built:${kind}`;
    const matched = this.catalog.all().filter((q) => q.trigger === triggerKey);
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

  /** 已完成主线重新置为可接取；M1 遵循其自动激活规则。 */
  private async gmRetriggerCompletedMain(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    if (!villageId || !code) return { ok: false, payload: {}, reason: 'villageId_and_code_required' };
    const q = this.quest(code);
    if (!q) return { ok: false, payload: {}, reason: 'unknown_quest' };
    if (q.type !== 'main') return { ok: false, payload: {}, reason: 'only_completed_main_supported' };
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    if (!s.completedMain.includes(code)) return { ok: false, payload: {}, reason: 'not_completed_main' };
    // M8 的任务村在结局后按设计保留，便于 M9 反击；但 GM 重新触发
    // M8 意味着开启一轮全新的冤家路窄流程，不能把上一轮战后的守军/库存
    // 带入新任务。先移除旧实体，再由 activateQuest 按当前 CSV/GM 模板重建。
    if ((code === 'm8' || code === 'm13') && s.taskVillages?.[code]) {
      const removed = await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: s.taskVillages[code].id } });
      if (!removed.ok) return removed;
      delete s.taskVillages[code];
      if (s.outcomes) delete s.outcomes[code];
    }
    s.completedMain = s.completedMain.filter((item) => item !== code);
    s.offeredMain = s.offeredMain.filter((item) => item !== code);
    this.store.set(COLLECTION, storageVillageId, s);
    if (code === 'm1') {
      await this.activateQuest(villageId, code);
    } else {
      s.offeredMain.push(code);
      this.store.set(COLLECTION, storageVillageId, s);
      await this.pushList(villageId);
      await this.pushMap(villageId);
    }
    return { ok: true, payload: await this.snapshotForVillage(villageId) };
  }

  /** 进行中的主线回退为未触发：清理实例/任务营地，不自动重新放入可接取列表。 */
  private async gmUntriggerMain(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    if (!villageId || !code) return { ok: false, payload: {}, reason: 'villageId_and_code_required' };
    const q = this.quest(code);
    if (!q) return { ok: false, payload: {}, reason: 'unknown_quest' };
    if (q.type !== 'main') return { ok: false, payload: {}, reason: 'only_active_main_supported' };
    const storageVillageId = this.storageVillageForQuest(villageId, code);
    const s = this.ensureState(storageVillageId);
    const inst = s.active[code];
    if (!inst) return { ok: false, payload: {}, reason: 'not_active_main' };
    for (const camp of inst.camps ?? []) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: camp.id } });
    }
    if (inst.npcVillageId) await this.removeNpc(inst.spawnVillageId ?? villageId, inst);
    if ((code === 'm8' || code === 'm13') && inst.taskVillageId) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: inst.taskVillageId } });
      if (s.taskVillages) delete s.taskVillages[code];
      if (s.outcomes) delete s.outcomes[code];
    }
    this.scheduler.cancelByOwner(`task-camp:${storageVillageId}:${code}`);
    this.scheduler.cancelByOwner(`task-m8-attack:${storageVillageId}`);
    this.scheduler.cancelByOwner(`task-village:${storageVillageId}:m8`);
    this.scheduler.cancelByOwner(`task-village:${storageVillageId}:m13`);
    delete s.active[code];
    s.offeredMain = s.offeredMain.filter((item) => item !== code);
    s.completedMain = s.completedMain.filter((item) => item !== code);
    this.store.set(COLLECTION, storageVillageId, s);
    await this.pushList(villageId);
    await this.pushMap(villageId);
    return { ok: true, payload: await this.snapshotForVillage(villageId) };
  }

  /**
   * 完整拆除建筑后，接取中的 build_buildings 任务把原本占用的槽位记为
   * “已释放空槽”。这只改变本任务的计数资格，不修改建筑模块的状态；
   * 同一槽位一旦已计数，后续重复拆建仍由 buildingCountedSlots 去重。
   */
  private async onBuildingDemolished(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId?: string; slotId?: string };
    const villageId = p.villageId;
    const slotId = p.slotId;
    if (!villageId || !slotId) return;
    let changed = false;
    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const [code, inst] of Object.entries(state.active)) {
        const q = this.quest(code);
        if (!q || q.objective.kind !== 'build_buildings' || inst.readyToDeliver) continue;
        if (this.storageVillageForQuest(villageId, code) !== storageVillageId) continue;
        const sourceVillageId: string = q.scope === 'global' ? this.anchorVillage(villageId) : storageVillageId;
        if (sourceVillageId !== villageId) continue;
        if (!(inst.buildingInitialSlots ?? []).includes(slotId)) continue;
        inst.buildingFreedSlots ??= [];
        if (inst.buildingFreedSlots.includes(slotId)) continue;
        inst.buildingFreedSlots.push(slotId);
        changed = true;
      }
      if (changed) this.store.set(COLLECTION, storageVillageId, state);
    }
    if (changed) await this.pushList(villageId);
  }

  /** 建筑修复完成 → 推进 repair_buildings 目标。全局任务可由任一玩家村庄执行。 */
  private async onBuildingRepaired(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId?: string; kind?: string };
    const villageId = p.villageId;
    const kind = p.kind;
    if (!villageId || !kind) return;
    // 隐藏 success 兜底条件也随建筑变更重算；不会写入玩家可见目标文本。
    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const [code, inst] of Object.entries(state.active)) {
        if (inst.readyToDeliver || this.storageVillageForQuest(villageId, code) !== storageVillageId) continue;
        if (await this.successConditionMet(villageId, code)) await this.markReady(villageId, code);
      }
    }
    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const [code, inst] of Object.entries(state.active)) {
        const q = this.quest(code);
        if (!q || q.objective.kind !== 'repair_buildings') continue;
        if (this.storageVillageForQuest(villageId, code) !== storageVillageId) continue;
        const required = q.objective.buildingKinds ?? [];
        if (!required.includes(kind)) continue;
        inst.repairedBuildings ??= [];
        if (inst.repairedBuildings.includes(kind)) continue;
        inst.repairedBuildings.push(kind);
        inst.executionVillageId = villageId;
        this.store.set(COLLECTION, storageVillageId, state);
        if (required.every((requiredKind) => inst.repairedBuildings?.includes(requiredKind))) {
          await this.markReady(villageId, code);
        } else {
          await this.pushList(villageId);
        }
        return;
      }
    }
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

  /** 按槽位填充酒馆：每个空槽独立按概率抽取支线，否则抽取日常。 */
  private async refreshOffered(villageId: string, info: TavernInfo): Promise<void> {
    const s = this.ensureState(villageId);
    const need = info.maxTasks - s.offered.length;
    if (need <= 0) return;

    const selected = new Set(s.offered);
    const dailyPool = this.catalog.all().filter((q) =>
      q.type === 'daily' &&
      (s.cooldownUntil?.[q.code] ?? 0) <= this.now() &&
      !s.active[q.code] &&
      !selected.has(q.code),
    );
    const sidePool = this.catalog.all().filter((q) =>
      q.type === 'side' &&
      q.trigger === 'tavern_refresh' &&
      !s.active[q.code] &&
      !s.completedSide.includes(q.code) &&
      !s.abandonedSide.includes(q.code) &&
      !selected.has(q.code) &&
      !this.sideClaimedByPlayer(villageId, q.code),
    );
    const chance = Math.min(1, Math.max(0, info.sideQuestChance));
    let changed = false;
    for (let i = 0; i < need; i++) {
      const preferSide = this.rng() < chance;
      const primary = preferSide ? sidePool : dailyPool;
      const fallback = preferSide ? dailyPool : sidePool;
      const code = this.weightedPick(primary.filter((q) => !selected.has(q.code)), 1)[0]
        ?? this.weightedPick(fallback.filter((q) => !selected.has(q.code)), 1)[0];
      if (!code) continue;
      selected.add(code);
      s.offered.push(code);
      changed = true;
    }
    if (!changed) return;
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
    if (level <= 0) return { level: 0, refreshSec: 0, maxTasks: 0, sideQuestChance: 0.5 };
    const def = this.config.buildings['tavern']?.levels[level];
    return {
      level,
      refreshSec: def?.taskRefreshSec ?? 3600,
      maxTasks: def?.taskMaxTasks ?? 1,
      sideQuestChance: Math.min(1, Math.max(0, def?.taskSideQuestChance ?? 0.5)),
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
    return { villageId, active: [], offeredMain: [], offered: [], offeredSide: [], completedMain: [], completedSide: [], abandonedSide: [], pendingDialogues: [] };
  }

  /** 查询村庄所属玩家；任务模块只通过公开 player 命令取归属，不读取 player 存档。 */
  private async playerIdForVillage(villageId: string): Promise<string | undefined> {
    const cached = this.playerDirectory.villageOwner(villageId);
    if (cached) return cached;
    const owner = await this.commands.send({ name: 'player.GetByVillage', from: TasksModule.NAME, payload: { villageId } });
    const playerId = (owner.payload as any)?.player?.id;
    return owner.ok && typeof playerId === 'string' && playerId ? playerId : undefined;
  }

  /** M13 秘密营地的地图发现判定：只有玩家当前视野覆盖目标格才算找到。 */
  private async isTaskVillageVisible(villageId: string, point?: { q?: number; r?: number }): Promise<boolean> {
    if (!point || !Number.isFinite(Number(point.q)) || !Number.isFinite(Number(point.r))) return false;
    const playerId = await this.playerIdForVillage(villageId);
    if (!playerId) return false;
    const result = await this.commands.send({
      name: 'vision.GetVisibility', from: TasksModule.NAME,
      payload: { playerId, q: Number(point.q), r: Number(point.r) },
    });
    return result.ok && (result.payload as any)?.visibility === 'visible';
  }

  /** 从任务快照中隐藏尚未发现的 M13 营地坐标，防止任务页/刷新接口泄露位置。 */
  private redactHiddenTaskVillages(snapshot: Record<string, unknown>): Record<string, unknown> {
    const active = Array.isArray(snapshot.active) ? snapshot.active as Record<string, any>[] : [];
    if (!active.some((item) => item.code === 'm13' && item.taskVillageXY)) return snapshot;
    const next = active.map((item) => {
      if (item.code !== 'm13' || !item.taskVillageXY) return item;
      if (item.taskVillageDiscovered === true) return { ...item, taskVillageVisible: true };
      return {
        ...item,
        taskVillageId: null,
        taskVillageXY: null,
        taskVillageName: null,
        taskVillageVisible: false,
      };
    });
    return { ...snapshot, active: next };
  }

  /** 当前村任务页快照：本村 village 任务 + 玩家锚点上的 global 任务。 */
  private async snapshotForVillage(villageId: string): Promise<Record<string, unknown>> {
    const local = this.redactHiddenTaskVillages(await this.snapshot(villageId, this.ensureState(villageId), 'village'));
    const anchor = this.anchorVillage(villageId);
    const global = this.redactHiddenTaskVillages(await this.snapshot(anchor, this.ensureState(anchor), 'global'));
    return {
      villageId,
      active: [...(global.active as unknown[]), ...(local.active as unknown[])],
      offeredMain: [...(global.offeredMain as unknown[])],
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

  private async snapshot(villageId: string, s: TaskState, scopeFilter?: QuestScope): Promise<Record<string, unknown>> {
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
    const pendingDialogues = await Promise.all((s.pendingDialogues ?? [])
      .filter((item) => include(item.taskCode))
      .map((item) => this.serializePendingDialogue(item)));
    return {
      villageId,
      active,
      offeredMain: s.offeredMain
        .filter(include)
        .map((code) => this.quest(code))
        .filter((q): q is QuestDef => !!q)
        .map((q) => this.serializeOffer(q, villageId)),
      offered,
      offeredSide,
      completedMain: s.completedMain.filter(include),
      completedSide: s.completedSide.filter(include),
      abandonedSide: s.abandonedSide.filter(include),
      pendingDialogues,
    };
  }

  private async serializePendingDialogue(item: PendingTaskDialogue): Promise<Record<string, unknown>> {
    const defs = Object.values(this.config.dialogues ?? {})
      .filter((dialogue) => dialogue.taskCode === item.taskCode && dialogue.trigger === item.trigger)
      .sort((a, b) => a.segment - b.segment)
      .filter((dialogue) => dialogue.npcName || dialogue.npcText);
    if (!defs.length) return { ...item, dialogue: null };
    const context = await this.playerDirectory.dialogueContext(item.villageId);
    const render = (value: string) => value
      .replaceAll('{villageName}', context.villageName)
      .replaceAll('{fiefName}', context.fiefName);
    const segments = defs.map((def): SerializedDialogueSegment => ({
      code: def.code,
      taskCode: def.taskCode,
      trigger: def.trigger,
      segment: def.segment,
      npcName: render(def.npcName),
      npcText: render(def.npcText),
      replies: def.replies.map((reply) => ({ ...reply })),
    }));
    const first = segments[0];
    const dialogue: SerializedDialogueSession = {
      id: item.id,
      code: first.code,
      taskCode: first.taskCode,
      trigger: first.trigger,
      segment: first.segment,
      segmentCount: segments.length,
      npcName: first.npcName,
      npcText: first.npcText,
      replies: first.replies,
      segments,
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
      buildingKinds: q.objective.buildingKinds ?? null,
      buildingZone: q.objective.buildingZone ?? null,
      resourceKey: q.objective.resourceKey ?? null,
      campTemplate: q.objective.campTemplate ?? null,
      minRarity: q.objective.minRarity ?? null,
      count: q.objective.count ?? 0,
      flagCode: q.objective.flagCode ?? null,
      minTroops: q.objective.minTroops ?? 0,
      deliverResource: q.objective.deliverResource ?? null,
      deliverAmount: q.objective.deliverAmount ?? 0,
      researchCode: q.objective.researchCode ?? null,
      taskVillageCode: q.objective.taskVillageCode ?? null,
      threshold: q.objective.threshold ?? null,
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
      repairedBuildings: [...(inst.repairedBuildings ?? [])],
      required: q?.objective.resources ?? {},
      campCleared: inst.campCleared,
      campTotal: inst.camps.length,
      progress: inst.progress ?? 0,
      buildingBaseline: inst.buildingBaseline ?? null,
      buildingInitialSlots: inst.buildingInitialSlots ?? null,
      buildingFreedSlots: inst.buildingFreedSlots ?? null,
      buildingCountedSlots: inst.buildingCountedSlots ?? null,
      buildingBuiltCount: inst.buildingBuiltCount ?? null,
      awaitingReturn: inst.qualifiedMovements?.length ?? 0,
      deliverableFlags: inst.qualifiedFlagMovements?.length ?? 0,
      camps: inst.camps.map((c) => ({ id: c.id, q: c.q, r: c.r, cleared: c.cleared })),
      npcVillageId: inst.npcVillageId ?? null,
      npcXY: inst.npcXY ?? null,
      npcRes: inst.npcRes ?? null,
      npcAmt: inst.npcAmt ?? 0,
      npcOrderId: inst.npcOrderId ?? null,
      npcPending: inst.npcPending === true,
      taskVillageId: inst.taskVillageId ?? null,
      taskVillageXY: inst.taskVillageXY ?? null,
      taskVillageName: inst.taskVillageName ?? null,
      taskVillageDiscovered: inst.taskVillageDiscovered === true,
      taskVillageAttackAt: inst.taskVillageAttackAt ?? null,
      taskVillageAttackDispatched: inst.taskVillageAttackDispatched === true,
      outcome: inst.outcome ?? null,
      failureReady: inst.failureReady === true,
      canAbandon: inst.type !== 'main',
      ready: inst.readyToDeliver === true,
      canDeliver: inst.readyToDeliver === true,
      canFail: inst.failureReady === true,
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
      population: rewards?.population ?? 0,
      populationGrowth: rewards?.populationGrowth ?? null,
      resourceGrowth: rewards?.resourceGrowth ?? null,
      buildingUnlocks: rewards?.buildingUnlocks ?? [],
      researchPoints: rewards?.researchPoints ?? 0,
      reputationMercenaryExchange: rewards?.reputationMercenaryExchange ?? null,
      mercenaries: rewards?.mercenaries ?? null,
    };
  }

  private serializeRewards(q: QuestDef): Record<string, unknown> {
    return {
      ...this.serializeOutcome(q.rewards),
      failure: q.failureRewards ? this.serializeOutcome(q.failureRewards) : null,
      conditional: q.conditionalRewards ? Object.fromEntries(Object.entries(q.conditionalRewards).map(([key, value]) => [key, this.serializeOutcome(value)])) : null,
      choices: (q.choiceRewards ?? []).map((choice) => ({ key: choice.key, label: choice.label, ...this.serializeOutcome(choice.rewards) })),
    };
  }

  private async pushList(villageId: string): Promise<void> {
    await this.syncTaskVillageCoordinates(villageId);
    await this.bus.emit({
      name: 'task.ListChanged', source: TasksModule.NAME, ts: this.now(),
      payload: await this.snapshotForVillage(villageId),
    });
  }

  private async pushMap(villageId: string): Promise<void> {
    await this.syncTaskVillageCoordinates(villageId);
    const camps: Array<{ id: string; q: number; r: number; cleared: boolean; name?: string; taskVillage?: boolean; taskInfo?: Record<string, unknown> }> = [];
    for (const { storageVillageId, state } of this.taskCandidates(villageId)) {
      for (const inst of Object.values(state.active)) {
        if (this.storageVillageForQuest(villageId, inst.code) !== storageVillageId) continue;
        // 地图标记只表示仍可交互的任务营地；已清理的营地保留在任务快照中用于进度展示，
        // 但绝不能再次推给地图，否则客户端会在已还原的空地上留下幽灵任务标。
        for (const c of inst.camps) {
          if (!c.cleared) camps.push({ id: c.id, q: c.q, r: c.r, cleared: false });
        }
        // m8/m9 的天王老子村同样是任务专属地块。World 会刻意过滤 taskcamp，
        // 所以必须随任务标记推送；否则任务卡虽有坐标，地图上却无法点击目标。
        if (inst.taskVillageId && inst.taskVillageXY) {
          // M13 秘密营地只有在生成时/探索后进入玩家视野才会被发现。
          // 一旦发现就持久化标记，后续离开视野仍可从任务地图标记找回。
          if (inst.code === 'm13' && !inst.taskVillageDiscovered) {
            if (await this.isTaskVillageVisible(villageId, inst.taskVillageXY)) {
              inst.taskVillageDiscovered = true;
              this.store.set(COLLECTION, storageVillageId, state);
            } else {
              continue;
            }
          }
          const task = this.quest(inst.code);
          camps.push({
            id: inst.taskVillageId,
            q: inst.taskVillageXY.q,
            r: inst.taskVillageXY.r,
            cleared: false,
            name: inst.taskVillageName ?? (inst.code === 'm13' ? '秘密营地' : '天王老子村'),
            taskVillage: true,
            ...(task ? {
              taskInfo: {
                code: task.code,
                name: task.name,
                desc: task.desc,
                type: task.type,
                scope: task.scope,
                campCleared: inst.campCleared,
                campTotal: inst.camps.length,
                villageId: this.storageVillageForQuest(villageId, inst.code),
                objective: this.serializeObjective(task),
              },
            } : {}),
          });
        }
      }
    }
    await this.bus.emit({
      name: 'task.MapUpdated', source: TasksModule.NAME, ts: this.now(),
      payload: { villageId, camps },
    });
  }
}

/**
 * 领域模块 · 任务（TasksModule）
 *
 * 状态归属：task 集合（每村任务进度：已完成主线、进行中任务实例、酒馆展示的随机任务）。
 *
 * 设计要点（来自策划）：
 *  - 任务会给接了该任务的玩家在地图上显示专属内容；任务专属宝物不可出售/遗弃/丢失/超时。
 *  - 城内建筑「酒馆」用于接取任务：酒馆升级使随机任务刷新更频繁，且可同时接取的任务数变多。
 *  - 主线任务：全玩家共有，科技树式前置（requires），不可放弃，自动解锁。
 *  - 随机任务：酒馆随机刷新，可放弃。
 *  - v1 目标种类：submit_resources（上交资源）、clear_camp（清理地图上真实生成的任务营地）。
 *
 * 命令：
 *   task.GetState       → 完整快照（active / offered / completed / camps）
 *   task.Accept        → 从酒馆接取随机任务
 *   task.Abandon       → 放弃随机任务（主线不可放弃）
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
 *   treasure.Grant {locked:true} 发任务专属宝物（锁定桶）
 */

import type { Store } from '../infra/store.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { ModuleManifest } from '../gateway/manifest.js';
import type { GameConfig, QuestDef } from '../infra/config.js';

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
  type: 'main' | 'random';
  acceptedAt: number;
  /** submit_resources：已上交的资源累计。 */
  submitted: Record<string, number>;
  /** clear_camp：已生成的营地。 */
  camps: TaskCamp[];
  /** clear_camp：已清理的营地数。 */
  campCleared: number;
}

interface TaskState {
  villageId: string;
  /** 已完成的主线任务 code。 */
  completedMain: string[];
  /** 已完成的随机任务 code（避免酒馆重复刷出）。 */
  completedRandom: string[];
  /** 进行中任务：code → 实例（主线自动激活 + 接取的随机）。 */
  active: Record<string, TaskInstance>;
  /** 酒馆当前展示、未接取的随机任务 code。 */
  offered: string[];
}

interface TavernInfo {
  level: number;
  refreshSec: number;
  maxTasks: number;
}

export class TasksModule {
  static readonly NAME = 'task';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'task',
    publicActions: {
      'task.GetState': { command: 'task.GetState', ownVillage: true, needAuth: true, schema: {} },
      'task.Accept': { command: 'task.Accept', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 32 } } },
      'task.Abandon': { command: 'task.Abandon', ownVillage: true, needAuth: true, schema: { code: { type: 'string', minLen: 1, maxLen: 32 } } },
      'task.SubmitResources': {
        command: 'task.SubmitResources', ownVillage: true, needAuth: true,
        schema: {
          code: { type: 'string', minLen: 1, maxLen: 32 },
          resources: { type: 'record_int', minVal: 0, maxVal: 2_000_000_000 },
        },
      },
    },
    // 左=内部事件名，右=推给客户端的裸名（与 research/tech 等保持一致）
    eventPushMap: {
      'task.ListChanged': 'TaskListChanged',
      'task.MapUpdated': 'TaskMapUpdated',
    },
  };

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
    this.commands.register('task.Accept', (c: Command) => this.accept(c));
    this.commands.register('task.Abandon', (c: Command) => this.abandon(c));
    this.commands.register('task.SubmitResources', (c: Command) => this.submitResources(c));
    // GM 运维命令（由 GM 面板经 commands.send({from:'gm'}) 调用，不暴露给客户端）
    this.commands.register('task.GmComplete', (c: Command) => this.gmComplete(c));
    this.commands.register('task.GmRefreshRandom', (c: Command) => this.gmRefreshRandom(c));
    this.commands.register('task.GmReset', (c: Command) => this.gmReset(c));

    // 酒馆建造/升级/拆除 → 重排随机刷新节奏 + 接取上限
    const onTavern = (evt: DomainEvent) => {
      const p = evt.payload as { villageId: string; kind: string };
      if (p.kind === 'tavern') void this.onTavernChanged(p.villageId);
    };
    this.bus.on('building.Built', onTavern);
    this.bus.on('building.Upgraded', onTavern);
    this.bus.on('building.Demolished', onTavern);

    // 战斗结束 → 推进 clear_camp 任务
    this.bus.on('combat.BattleEnded', (evt: DomainEvent) => void this.onBattleEnded(evt));
  }

  async resume(): Promise<void> {
    for (const s of this.store.all<TaskState>(COLLECTION)) {
      // 任务营地(pve.task=true)持久化在 pve 集合，重启后仍在地图；无需重新生成。
      // 仅重排酒馆刷新节奏（若存在酒馆）。
      void this.resumeVillage(s.villageId).catch(() => {});
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
    const s: TaskState = { villageId, completedMain: [], completedRandom: [], active: {}, offered: [] };
    this.store.set(COLLECTION, villageId, s);
    // 解锁前置已满足的主线（建村时通常仅 m1 无前置）。异步但无需等待。
    void this.unlockMainQuests(villageId).catch(() => {});
  }

  // ── 状态读写 ──
  private ensureState(villageId: string): TaskState {
    let s = this.store.get<TaskState>(COLLECTION, villageId);
    if (!s) {
      s = { villageId, completedMain: [], completedRandom: [], active: {}, offered: [] };
      this.store.set(COLLECTION, villageId, s);
    }
    if (!Array.isArray(s.completedMain)) s.completedMain = [];
    if (!Array.isArray(s.completedRandom)) s.completedRandom = [];
    if (!s.active || typeof s.active !== 'object') s.active = {};
    if (!Array.isArray(s.offered)) s.offered = [];
    return s;
  }

  private load(villageId: string): TaskState | undefined {
    return this.store.get<TaskState>(COLLECTION, villageId);
  }

  private quest(code: string): QuestDef | undefined {
    return this.config.quests[code];
  }

  // ── 命令：GetState ──
  private getState(cmd: Command): CommandResult {
    const { villageId } = cmd.payload as { villageId: string };
    const s = this.ensureState(villageId);
    return { ok: true, payload: this.snapshot(villageId, s) };
  }

  // ── 命令：Accept（接取随机任务）──
  private async accept(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    if (!s.offered.includes(code)) return { ok: false, payload: {}, reason: 'not_offered' };
    const q = this.quest(code);
    if (!q || q.type !== 'random') return { ok: false, payload: {}, reason: 'not_random' };
    if (s.active[code]) return { ok: false, payload: {}, reason: 'already_active' };

    const info = await this.tavernInfo(villageId);
    const activeCount = Object.keys(s.active).length;
    if (info.maxTasks <= 0) return { ok: false, payload: {}, reason: 'no_tavern' };
    if (activeCount >= info.maxTasks) return { ok: false, payload: {}, reason: 'too_many_active' };

    s.offered = s.offered.filter((c) => c !== code);
    await this.activateQuest(villageId, code);
    return { ok: true, payload: { code } };
  }

  // ── 命令：Abandon（放弃随机任务）──
  private async abandon(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    const s = this.ensureState(villageId);
    const inst = s.active[code];
    if (!inst) return { ok: false, payload: {}, reason: 'not_active' };
    const q = this.quest(code);
    if (!q || q.type !== 'random') return { ok: false, payload: {}, reason: 'main_cannot_abandon' };

    // 移除生成的营地
    for (const c of inst.camps) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: c.id } });
    }
    delete s.active[code];
    this.store.set(COLLECTION, villageId, s);
    await this.pushList(villageId);
    await this.pushMap(villageId);
    return { ok: true, payload: { code } };
  }

  // ── 命令：SubmitResources（上交资源）──
  private async submitResources(cmd: Command): Promise<CommandResult> {
    const { villageId, code, resources } = cmd.payload as { villageId: string; code: string; resources: Record<string, number> };
    const s = this.ensureState(villageId);
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
      if (complete) await this.completeQuest(villageId, code);
      return { ok: true, payload: { code, submitted: inst.submitted, remaining: this.remaining(inst, required), completed: complete } };
    }

    const spend = await this.commands.send({ name: 'economy.TrySpend', from: TasksModule.NAME, payload: { villageId, cost: toSpend } });
    if (!spend.ok) return spend; // 资源不足等

    for (const [res, amt] of Object.entries(toSpend)) {
      inst.submitted[res] = (inst.submitted[res] ?? 0) + amt;
    }
    this.store.set(COLLECTION, villageId, s);

    const complete = this.submitMet(inst, required);
    if (complete) {
      await this.completeQuest(villageId, code);
    } else {
      await this.pushList(villageId);
    }
    return { ok: true, payload: { code, submitted: inst.submitted, remaining: this.remaining(inst, required), completed: complete } };
  }

  // ── 激活任务（主线自动 / 随机接取共用）──
  private async activateQuest(villageId: string, code: string): Promise<void> {
    const s = this.ensureState(villageId);
    if (s.active[code]) return; // 幂等
    const q = this.quest(code);
    if (!q) return;
    const inst: TaskInstance = {
      code,
      type: q.type,
      acceptedAt: this.now(),
      submitted: {},
      camps: [],
      campCleared: 0,
    };
    s.active[code] = inst;
    this.store.set(COLLECTION, villageId, s);
    if (q.objective.kind === 'clear_camp') {
      await this.spawnCamps(villageId, inst);
    }
    await this.pushList(villageId);
    await this.pushMap(villageId);
  }

  /** 在村内找空地生成任务营地（task=true，不掉落/不自动重生）。 */
  private async spawnCamps(villageId: string, inst: TaskInstance): Promise<void> {
    const q = this.quest(inst.code);
    if (!q || q.objective.kind !== 'clear_camp') return;
    const template = q.objective.campTemplate;
    if (!template || !this.config.pveTemplates[template]) return;
    const want = Math.max(1, q.objective.count ?? 1);

    const xy = await this.getVillageXY(villageId);
    if (!xy) return; // 村庄尚未落位（极端时序），交由后续解锁重试

    let placed = 0;
    for (let i = 0; i < want; i++) {
      const free = await this.commands.send({ name: 'world.FindFreeTile', from: TasksModule.NAME, payload: { centerQ: xy.q, centerR: xy.r, radius: 8 } });
      if (!free.ok) break; // 无空地则少放（避免卡死）
      const { q: cq, r: cr } = free.payload as { q: number; r: number };
      const campId = `taskcamp-${villageId}-${inst.code}-${i}`;
      const spawn = await this.commands.send({ name: 'pve.Spawn', from: TasksModule.NAME, payload: { id: campId, type: template, q: cq, r: cr, task: true } });
      if (spawn.ok) {
        inst.camps.push({ id: campId, q: cq, r: cr, cleared: false });
        placed++;
      } else {
        break;
      }
    }
    // 实际放置数即完成所需数（防软锁）
    if (placed === 0) {
      // 连一块空地都找不到：放弃营地生成，任务无法以清理方式完成——记录但不卡死界面
      inst.camps = [];
    }
    this.store.set(COLLECTION, villageId, this.ensureState(villageId));
  }

  // ── 完成任务：发奖励 + 收尾 + 解锁下游主线 ──
  private async completeQuest(villageId: string, code: string): Promise<void> {
    const s = this.ensureState(villageId);
    const inst = s.active[code];
    if (!inst) return;
    const q = this.quest(code);
    if (!q) return;

    // 移除残留营地
    for (const c of inst.camps) {
      await this.commands.send({ name: 'pve.Remove', from: TasksModule.NAME, payload: { id: c.id } });
    }

    // 资源奖励
    if (q.rewards.resources && Object.keys(q.rewards.resources).length) {
      await this.commands.send({ name: 'economy.Grant', from: TasksModule.NAME, payload: { villageId, gain: q.rewards.resources } });
    }
    // 任务专属宝物（强制锁定）
    for (const t of q.rewards.treasures ?? []) {
      await this.commands.send({ name: 'treasure.Grant', from: TasksModule.NAME, payload: { villageId, code: t, locked: true } });
    }

    delete s.active[code];
    if (q.type === 'main') {
      if (!s.completedMain.includes(code)) s.completedMain.push(code);
    } else {
      if (!s.completedRandom.includes(code)) s.completedRandom.push(code);
    }
    this.store.set(COLLECTION, villageId, s);

    await this.pushList(villageId);
    await this.pushMap(villageId);

    // 主线完成 → 解锁下游主线
    if (q.type === 'main') await this.unlockMainQuests(villageId);
  }

  // ── GM 运维命令（由 GM 面板经 commands.send({from:'gm'}) 调用）──

  /** 强制完成某任务：移除营地、发放奖励、解锁下游（与正常完成一致）。 */
  private async gmComplete(cmd: Command): Promise<CommandResult> {
    const { villageId, code } = cmd.payload as { villageId: string; code: string };
    if (!villageId || !code) return { ok: false, payload: {}, reason: 'villageId_and_code_required' };
    const s = this.ensureState(villageId);
    if (!s.active[code]) return { ok: false, payload: {}, reason: 'not_active' };
    await this.completeQuest(villageId, code);
    return { ok: true, payload: this.snapshot(villageId, this.ensureState(villageId)) };
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
    const s = this.ensureState(villageId);
    for (const q of Object.values(this.config.quests)) {
      if (q.type !== 'main') continue;
      if (s.completedMain.includes(q.code)) continue;
      if (s.active[q.code]) continue;
      if (this.prereqsMet(s, q.requires)) {
        try {
          await this.activateQuest(villageId, q.code);
        } catch { /* 忽略单条失败，继续其它 */ }
      }
    }
  }

  private prereqsMet(s: TaskState, requires: string[]): boolean {
    if (!requires.length) return true;
    const done = new Set(s.completedMain);
    for (const req of requires) {
      // 每个 require 是「OR 组」：以 ' OR ' 分隔，组内任一完成即满足
      const orParts = req.split(' OR ');
      if (!orParts.some((p) => done.has(p.trim()))) return false;
    }
    return true;
  }

  // ── 战斗结束：推进 clear_camp ──
  private async onBattleEnded(evt: DomainEvent): Promise<void> {
    const p = evt.payload as { villageId?: string; side?: string; targetKind?: string; targetId?: string; attackerWins?: boolean };
    if (p.side !== 'attacker') return;
    if (p.targetKind !== 'pve') return;
    if (!p.attackerWins) return;
    const villageId = p.villageId;
    const targetId = p.targetId;
    if (!villageId || !targetId) return;

    const s = this.load(villageId);
    if (!s) return;
    for (const [code, inst] of Object.entries(s.active)) {
      const camp = inst.camps.find((c) => c.id === targetId && !c.cleared);
      if (!camp) continue;
      camp.cleared = true;
      inst.campCleared = (inst.campCleared ?? 0) + 1;
      this.store.set(COLLECTION, villageId, s);
      if (inst.campCleared >= inst.camps.length) {
        await this.completeQuest(villageId, code);
      } else {
        await this.pushList(villageId);
        await this.pushMap(villageId);
      }
      return;
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

  /** 加权随机抽取随机任务填满酒馆（不超过 maxTasks）。 */
  private async refreshOffered(villageId: string, info: TavernInfo): Promise<void> {
    const s = this.ensureState(villageId);
    const need = info.maxTasks - s.offered.length;
    if (need <= 0) return;

    const pool = Object.values(this.config.quests).filter((q) =>
      q.type === 'random' &&
      !s.completedRandom.includes(q.code) &&
      !s.active[q.code] &&
      !s.offered.includes(q.code),
    );
    if (!pool.length) return;

    const picked = this.weightedPick(pool, need);
    for (const c of picked) s.offered.push(c);
    this.store.set(COLLECTION, villageId, s);
    await this.pushList(villageId);
  }

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
  private snapshot(villageId: string, s: TaskState): Record<string, unknown> {
    const active = Object.values(s.active).map((inst) => this.serializeInstance(inst));
    const offered = s.offered
      .map((code) => this.quest(code))
      .filter((q): q is QuestDef => !!q)
      .map((q) => ({
        code: q.code,
        name: q.name,
        desc: q.desc,
        type: q.type,
        objective: this.serializeObjective(q),
        rewards: this.serializeRewards(q),
      }));
    return {
      villageId,
      active,
      offered,
      completedMain: [...s.completedMain],
      completedRandom: [...s.completedRandom],
    };
  }

  private serializeObjective(q: QuestDef): Record<string, unknown> {
    return {
      kind: q.objective.kind,
      resources: q.objective.resources ?? null,
      campTemplate: q.objective.campTemplate ?? null,
      count: q.objective.count ?? 0,
    };
  }

  private serializeInstance(inst: TaskInstance): Record<string, unknown> {
    const q = this.quest(inst.code);
    const objective = q ? this.serializeObjective(q) : { kind: 'unknown' };
    return {
      code: inst.code,
      type: inst.type,
      name: q?.name ?? inst.code,
      desc: q?.desc ?? '',
      objective,
      rewards: q ? this.serializeRewards(q) : null,
      submitted: { ...inst.submitted },
      required: q?.objective.resources ?? {},
      campCleared: inst.campCleared,
      campTotal: inst.camps.length,
      camps: inst.camps.map((c) => ({ id: c.id, q: c.q, r: c.r, cleared: c.cleared })),
      canAbandon: inst.type === 'random',
      acceptedAt: inst.acceptedAt,
    };
  }

  /** 任务奖励：资源(含金币)与任务专属宝物 code 列表，供客户端卡片展示。 */
  private serializeRewards(q: QuestDef): Record<string, unknown> {
    return {
      resources: q.rewards?.resources ?? null,
      treasures: q.rewards?.treasures ?? [],
    };
  }

  private async pushList(villageId: string): Promise<void> {
    const s = this.ensureState(villageId);
    await this.bus.emit({
      name: 'task.ListChanged', source: TasksModule.NAME, ts: this.now(),
      payload: this.snapshot(villageId, s),
    });
  }

  private async pushMap(villageId: string): Promise<void> {
    const s = this.load(villageId) ?? this.ensureState(villageId);
    const camps: { id: string; q: number; r: number; cleared: boolean }[] = [];
    for (const inst of Object.values(s.active)) {
      for (const c of inst.camps) camps.push({ id: c.id, q: c.q, r: c.r, cleared: c.cleared });
    }
    await this.bus.emit({
      name: 'task.MapUpdated', source: TasksModule.NAME, ts: this.now(),
      payload: { villageId, camps },
    });
  }
}

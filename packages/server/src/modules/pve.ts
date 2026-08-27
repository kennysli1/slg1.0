import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Snapshot } from '../infra/combat-types.js';
import { wrapHex } from '../infra/hex.js';

/**
 * 领域模块 · PvE（NPC 目标 / 发育地板）
 * 对应设计文档 02_系统清单E组、S0(PvE=稳定发育地板)
 *
 * 职责：PvE 目标的 owner——每个目标有守军快照 + 战利品库存。
 * 提供给 Movement：取守军快照(打)、扣战利品(抢)、击败后重生。
 * 守军快照口径与 Military.GetCombatSnapshot 一致 → Combat 同一套结算（PvE/PvP同源）。
 *
 * 目标模板来自 GameConfig（config/pve_targets.csv + pve_defenders.csv）——改 CSV 即改目标。
 */

interface PveState {
  id: string;
  type: string;
  q: number; // 六边形轴坐标
  r: number;
  /** 当前守军（被打会减员；重生时恢复满） */
  defender: Snapshot;
  loot: Record<string, number>;
  /** 是否已被清空（待重生） */
  cleared: boolean;
  /** 累计被清空次数（战利品浮动的确定性 LCG 种子，保证可复现） */
  clearCount: number;
  /** 任务营地标记：由任务模块运行时生成（pve.Spawn task=true）。任务营地清空后不触发普通掉落、
   *  不自动重生（由任务模块在目标达成后显式 pve.Remove 清除），resume 也不自动重生。 */
  task?: boolean;
  /** 任务营地的拥有村庄 id（仅该村可攻击该营地，防止其它玩家越权攻打）。非任务营地为空。 */
  ownerVillageId?: string;
  /** 不重生标记：幸福村（happy_village）这类 0 守军 NPC 村庄清空后不重生、不掉落普通宝物，生命周期由任务模块接管。 */
  noRespawn?: boolean;
  /** 天王老子村库存已按 M8 配置初始化；旧存档缺失时由 resume 惰性迁移。 */
  taskVillageLootInitialized?: boolean;
}

const COLLECTION = 'pve';

export class PveModule {
  static readonly NAME = 'pve';



  constructor(
    private store: Store,
    private _bus: EventBus,
    private commands: CommandBus,
    private scheduler: import('../infra/scheduler.js').Scheduler,
    private now: () => number,
    private config: import('../infra/config.js').GameConfig,
  ) {}

  /** 热重载配置（改 CSV 后调用）。 */
  setConfig(config: import('../infra/config.js').GameConfig): void {
    this.config = config;
  }

  init(): void {
    this.normalizeCoords();
    this.commands.register('pve.GetTarget', (c) => this.getTarget(c));
    this.commands.register('pve.ListTargets', () => this.listTargets());
    this.commands.register('pve.GetDefenderSnapshot', (c) => this.getDefenderSnapshot(c));
    this.commands.register('pve.ApplyResult', (c) => this.applyResult(c));
    this.commands.register('pve.ApplyTaskVillageOutcome', (c) => this.applyTaskVillageOutcome(c));
    // 任务模块运行时生成/移除任务营地（内部命令）
    this.commands.register('pve.Spawn', (c) => this.spawn(c));
    this.commands.register('pve.AssignTaskOwner', (c) => this.assignTaskOwner(c));
    this.commands.register('pve.Remove', (c) => this.remove(c));
  }

  /** 运行时创建一个 PvE 目标（任务营地）。返回 ok:false 若 id 已存在或模板不存在。 */
  private spawn(cmd: Command): CommandResult {
    const { id, type, q, r, task, ownerVillageId, loot, noRespawn } = cmd.payload as { id: string; type: string; q: number; r: number; task?: boolean; ownerVillageId?: string; loot?: Record<string, number>; noRespawn?: boolean };
    if (this.load(id)) return { ok: false, payload: {}, reason: 'already_exists' };
    const tpl = this.config.pveTemplates[type];
    if (!tpl) return { ok: false, payload: {}, reason: 'unknown_template' };
    this.create(id, type, q, r, !!task, ownerVillageId, loot, !!noRespawn);
    return { ok: true, payload: { id, type, q, r } };
  }

  /** 任务模块在启动恢复时为旧营地回填 owner，并把旧的全局地块归一为私有任务地块。 */
  private async assignTaskOwner(cmd: Command): Promise<CommandResult> {
    const { id, ownerVillageId } = cmd.payload as { id: string; ownerVillageId: string };
    const s = this.load(id);
    if (!s) return { ok: false, payload: {}, reason: 'target_not_found' };
    if (!s.task || !ownerVillageId) return { ok: false, payload: {}, reason: 'not_task_camp' };
    if (s.ownerVillageId && s.ownerVillageId !== ownerVillageId) return { ok: false, payload: {}, reason: 'task_owner_mismatch' };
    if (s.ownerVillageId !== ownerVillageId) this.store.set(COLLECTION, id, { ...s, ownerVillageId });
    const tpl = this.config.pveTemplates[s.type];
    const placed = await this.commands.send({
      name: 'world.PlacePve', from: PveModule.NAME,
      payload: { q: s.q, r: s.r, refId: s.id, name: tpl?.name ?? '任务营地', icon: tpl?.icon, task: true },
    });
    return placed.ok ? { ok: true, payload: { id, ownerVillageId } } : placed;
  }

  /** 移除一个 PvE 目标：取消重生调度、删状态、清除地图地块（幂等）。 */
  private async remove(cmd: Command): Promise<CommandResult> {
    const { id } = cmd.payload as { id: string };
    const s = this.load(id);
    if (!s) return { ok: true, payload: {} }; // 已不存在，幂等成功
    this.scheduler.cancelByOwner(`pve:${id}`);
    this.store.delete(COLLECTION, id);
    await this.commands.send({
      name: 'world.RemoveTile', from: PveModule.NAME,
      payload: { q: s.q, r: s.r, refId: id },
    });
    // 目标被移除：通知行军模块——所有前往该目标的出征/商队应原路返回（见 movement.onTargetRemoved）。
    void this._bus.emit({
      name: 'pve.TargetRemoved', source: PveModule.NAME, ts: this.now(),
      payload: { id, q: s.q, r: s.r },
    } as DomainEvent);
    return { ok: true, payload: { id } };
  }

  /** 归一 PvE 坐标进环面（幂等，兼容旧档）。 */
  private normalizeCoords(): void {
    const W = this.config.constants.worldW ?? 41, H = this.config.constants.worldH ?? 41;
    for (const s of this.store.all<PveState>(COLLECTION)) {
      const w = wrapHex({ q: s.q, r: s.r }, W, H);
      if (w.q !== s.q || w.r !== s.r) {
        this.store.set(COLLECTION, s.id, { ...s, q: w.q, r: w.r });
      }
    }
  }

  /** 重启恢复：被清空的目标直接重生（服务器停机期间视为已过重生冷却）。任务营地不在此重生。 */
  resume(): void {
    for (const s of this.store.all<PveState>(COLLECTION)) {
      this.migrateTaskVillageDefender(s);
      const current = this.load(s.id) ?? s;
      this.migrateTaskVillageLoot(current);
      // 任务营地清空后不自动重生（交由任务模块 resume 处理其生命周期）
      if (s.cleared && !s.task && !s.noRespawn) this.respawn(s.id);
    }
  }

  /** 创建一个 PvE 目标，并登记到地图。坐标为六边形轴坐标 (q,r)。task=true 时登记为任务营地，ownerVillageId 标记所属村庄。 */
  create(id: string, type: string, q: number, r: number, task = false, ownerVillageId?: string, loot?: Record<string, number>, noRespawn = false): void {
    const tpl = this.config.pveTemplates[type];
    const s: PveState = {
      id,
      type,
      q,
      r,
      defender: structuredClone(tpl.defender),
      // M8 任务村的初始库存只能来自 GM/CSV 常量；忽略调用方携带的旧模板库存，
      // 避免历史代码或手工请求把“各 500”重新写成过万。战斗后的库存仍由
      // applyTaskVillageOutcome 结算，不会在这里被覆盖。
      loot: task && type === 'tianwang_village'
        ? {
          wood: this.config.constants.m8TaskVillageResourceAmount,
          clay: this.config.constants.m8TaskVillageResourceAmount,
          iron: this.config.constants.m8TaskVillageResourceAmount,
          crop: this.config.constants.m8TaskVillageResourceAmount,
          gold: this.config.constants.m8TaskVillageGold,
        }
        : (loot ? { ...loot } : { ...tpl.loot }),
      cleared: false,
      clearCount: 0,
      task: task || undefined,
      ownerVillageId: ownerVillageId || undefined,
      noRespawn: noRespawn || undefined,
      taskVillageLootInitialized: task && type === 'tianwang_village' ? true : undefined,
    };
    this.store.set(COLLECTION, id, s);
    void this.commands.send({
      name: 'world.PlacePve',
      from: PveModule.NAME,
      payload: { q, r, refId: id, name: tpl.name, icon: tpl.icon, task: !!task },
    });
  }

  private load(id: string): PveState | undefined {
    return this.store.get<PveState>(COLLECTION, id);
  }

  /**
   * 旧版 M8 曾把条顿棍棒兵错误写成独立的 club 标签。只迁移仍保留该标签
   * 的天王老子村：保留存档中的数量，战斗属性统一替换为 units.csv 的
   * clubswinger 模板，并从存档中删除 club，避免继续向地图/战报泄露旧兵种。
   */
  private migrateTaskVillageDefender(s: PveState): void {
    if (!s.task || s.type !== 'tianwang_village' || !s.defender?.club) return;
    const legacy = s.defender.club;
    const template = this.config.pveTemplates[s.type]?.defender?.clubswinger;
    const clubswinger = {
      ...(template ?? legacy),
      count: Math.max(0, Math.floor(Number(s.defender.clubswinger?.count ?? legacy.count) || 0)),
    };
    const { club: _removed, ...withoutLegacy } = s.defender;
    this.store.set(COLLECTION, s.id, { ...s, defender: { ...withoutLegacy, clubswinger } });
  }

  /**
   * M8 初始库存曾经随模板/旧代码写成过万。只迁移尚未发生战斗的旧任务村：
   * clearCount=0 且守军仍是模板满编时才覆盖库存，战后剩余兵力/资源绝不回滚。
   * 迁移结果写回 JSON，因此后续删档/重启继续以当前 CSV 数值为默认值。
   */
  private migrateTaskVillageLoot(s: PveState): void {
    if (!s.task || s.type !== 'tianwang_village' || s.taskVillageLootInitialized) return;
    const tpl = this.config.pveTemplates[s.type];
    if (!tpl) return;
    const defenderFull = Object.keys(tpl.defender).every((unit) =>
      Number(s.defender?.[unit]?.count ?? 0) === Number(tpl.defender[unit]?.count ?? 0),
    ) && Object.keys(s.defender).every((unit) =>
      Number(s.defender[unit]?.count ?? 0) === Number(tpl.defender[unit]?.count ?? 0),
    );
    const amount = this.config.constants.m8TaskVillageResourceAmount;
    const gold = this.config.constants.m8TaskVillageGold;
    const currentResources = ['wood', 'clay', 'iron', 'crop'].map((key) => Number(s.loot?.[key] ?? 0));
    const looksLikeLegacyInventory = currentResources.some((value) => value > amount) || Number(s.loot?.gold ?? 0) > gold;
    if ((s.clearCount ?? 0) !== 0 || !defenderFull || !looksLikeLegacyInventory) {
      this.store.set(COLLECTION, s.id, { ...s, taskVillageLootInitialized: true });
      return;
    }
    this.store.set(COLLECTION, s.id, {
      ...s,
      loot: { wood: amount, clay: amount, iron: amount, crop: amount, gold },
      taskVillageLootInitialized: true,
    });
  }

  private async getTarget(cmd: Command): Promise<CommandResult> {
    const s = this.load((cmd.payload as any).id);
    if (!s) return { ok: false, payload: {}, reason: 'target_not_found' };
    // 读路径也执行一次惰性迁移，确保没有走完整 resume（例如 GM/API
    // 直接查看目标）时，旧 M8 库存仍会立即切到当前 CSV 默认值。
    this.migrateTaskVillageDefender(s);
    const afterDefender = this.load(s.id) ?? s;
    this.migrateTaskVillageLoot(afterDefender);
    const current = this.load(s.id) ?? afterDefender;
    // World owns the displayed tile coordinate. Older task-village records can
    // retain stale q/r after a map edit or a failed asynchronous PlacePve;
    // resolve the refId through World so scouting, raiding and map details agree.
    const tile = await this.commands.send({
      name: 'world.GetTileByRef', from: PveModule.NAME,
      payload: { refId: current.id },
    });
    const mapped = (tile.payload as any)?.tile;
    if (tile.ok && mapped && Number.isFinite(Number(mapped.q)) && Number.isFinite(Number(mapped.r))) {
      const q = Number(mapped.q), r = Number(mapped.r);
      if (q !== current.q || r !== current.r) {
        const next = { ...current, q, r };
        this.store.set(COLLECTION, current.id, next);
        return { ok: true, payload: { ...next } };
      }
    }
    return { ok: true, payload: { ...current } };
  }

  /** 内部目录：供王国等系统从地图已有普通 PvE 中选择目标，不暴露守军详情给客户端。 */
  private listTargets(): CommandResult {
    return {
      ok: true,
      payload: {
        targets: this.store.all<PveState>(COLLECTION).map((s) => ({
          id: s.id, type: s.type, q: s.q, r: s.r, cleared: s.cleared,
          task: !!s.task, noRespawn: !!s.noRespawn,
        })),
      },
    };
  }

  /** 给 Movement/Combat：当前守军快照。 */
  private getDefenderSnapshot(cmd: Command): CommandResult {
    const s = this.load((cmd.payload as any).id);
    if (!s) return { ok: false, payload: {}, reason: 'target_not_found' };
    // 快照是跨模块的只读边界，不能把 PvE 存档里的守军对象直接交给 Combat。
    // Combat 会在逐 tick 结算时原地修改快照；若这里返回原引用，Pve 状态会先被
    // 战斗过程扣减，随后 ApplyResult 再按 defenderLosses 扣一次，导致失败战斗
    // 也把幸存守军清成 0（例如 13 -> 3 后又 3 -> 0）。
    const snapshot = s.cleared ? {} : structuredClone(s.defender);
    return { ok: true, payload: { snapshot, loot: structuredClone(s.loot), noRespawn: !!s.noRespawn } };
  }

  /**
   * 战斗后应用结果：扣守军损失、若被清空则标记重生、返回实际可被搬走的战利品。
   * looterCarry = 进攻方幸存载货量；战利品按 carry 上限搬运。
   */
  private applyResult(cmd: Command): CommandResult {
    const { id, defenderLosses, attackerWins, looterCarry } = cmd.payload as {
      id: string;
      defenderLosses: Record<string, number>;
      attackerWins: boolean;
      looterCarry: number;
    };
    const s = this.load(id);
    if (!s) return { ok: false, payload: {}, reason: 'target_not_found' };

    // 扣守军
    for (const [unit, dead] of Object.entries(defenderLosses)) {
      if (s.defender[unit]) s.defender[unit].count = Math.max(0, s.defender[unit].count - dead);
    }
    const remain = Object.values(s.defender).reduce((a, u) => a + u.count, 0);

    let looted: Record<string, number> = {};
    if (attackerWins && remain <= 0) {
      // 清空：累计次数（战利品浮动种子）→ 按载货上限搬运（含 ±variance 浮动）
      s.clearCount = (s.clearCount ?? 0) + 1;
      looted = this.takeLoot(s, looterCarry);
      s.cleared = true;
      // 任务营地 / 不重生 NPC 村庄（幸福村）不自动重生，生命周期由任务模块接管
      if (!s.task && !s.noRespawn) {
        const tpl = this.config.pveTemplates[s.type];
        this.scheduler.schedule(tpl.respawnSec * 1000, () => this.respawn(id), `pve:${id}`, `pve:${id}`);
      }
    }
    this.store.set(COLLECTION, id, s);
    // 返回模板类型给 Combat：历史存档可能缺少 task 标记，但天王老子村仍
    // 必须按任务村处理，不能走普通 PvE 的随机宝物掉落路径。
    return {
      ok: true,
      payload: {
        looted,
        cleared: s.cleared,
        task: !!s.task,
        taskType: s.type,
        noRespawn: !!s.noRespawn,
      },
    };
  }

  /** m8 战斗结束后的任务村持久化：保留实体，守军变为战后幸存者，资源减半且金币归零。 */
  private applyTaskVillageOutcome(cmd: Command): CommandResult {
    const { id, survivors } = cmd.payload as { id?: string; survivors?: Record<string, number> };
    if (!id) return { ok: false, payload: {}, reason: 'target_id_required' };
    const s = this.load(id);
    if (!s) return { ok: false, payload: {}, reason: 'target_not_found' };
    if (!s.task || s.type !== 'tianwang_village') return { ok: false, payload: {}, reason: 'not_tianwang_task_village' };
    const alive = survivors ?? {};
    for (const [unit, entry] of Object.entries(s.defender)) entry.count = Math.max(0, Math.floor(Number(alive[unit]) || 0));
    for (const key of Object.keys(s.loot)) s.loot[key] = key === 'gold' ? 0 : Math.floor(Math.max(0, Number(s.loot[key]) || 0) / 2);
    s.cleared = false;
    this.store.set(COLLECTION, id, s);
    return { ok: true, payload: { id, survivors: alive, loot: { ...s.loot } } };
  }

  private takeLoot(s: PveState, carry: number): Record<string, number> {
    const capacity = Math.max(0, Math.floor(Number(carry) || 0));
    const entries = Object.entries(s.loot)
      .map(([type, raw]) => ({ type, available: Math.max(0, Math.floor(Number(raw) || 0)) }))
      .filter((entry) => entry.available > 0);
    const total = entries.reduce((sum, entry) => sum + entry.available, 0);
    const looted: Record<string, number> = {};
    if (capacity <= 0 || total <= 0) return looted;

    // 载货足够时必须可以搬空营地的全部资源；随机浮动只影响“运力不足时”
    // 的资源分配，不能让战利品凭空超过库存或超过部队 carry。
    const target = Math.min(capacity, total);
    if (target === total) {
      for (const entry of entries) {
        looted[entry.type] = entry.available;
        s.loot[entry.type] = 0;
      }
      return looted;
    }

    // 运力不足时按带确定性浮动权重的比例分配，并用余数补齐到恰好 target。
    // 这样仍保留 pve_loot_variance 的可复现随机性，同时严格满足 carry 上限。
    const weighted = entries.map((entry, index) => ({
      ...entry,
      weight: entry.available * Math.max(0.0001, this.lootFactor(s, index)),
    }));
    const weightTotal = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    const allocations = weighted.map((entry) => Math.min(entry.available, Math.floor(target * entry.weight / weightTotal)));
    let remaining = target - allocations.reduce((sum, amount) => sum + amount, 0);
    while (remaining > 0) {
      let progressed = false;
      for (let i = 0; i < weighted.length && remaining > 0; i++) {
        if (allocations[i]! >= weighted[i]!.available) continue;
        allocations[i]! += 1;
        remaining -= 1;
        progressed = true;
      }
      if (!progressed) break;
    }
    for (let i = 0; i < weighted.length; i++) {
      const entry = weighted[i]!;
      const take = allocations[i]!;
      if (take <= 0) continue;
      looted[entry.type] = take;
      s.loot[entry.type] = Math.max(0, entry.available - take);
    }
    return looted;
  }

  /**
   * 确定性伪随机浮动系数 ∈ [1-variance, 1+variance)。
   * 用 LCG（种子=clearCount×资源槽位偏移）而非 Math.random，保证存档/测试可复现（同 world/player 口径）。
   */
  private lootFactor(s: PveState, slot: number): number {
    const v = this.config.constants.pveLootVariance;
    if (v <= 0) return 1;
    const seed = (s.clearCount * 4 + slot + 1) >>> 0;
    const x = (seed * 1103515245 + 12345) & 0x7fffffff;
    const u = (x % 1000) / 1000; // [0,1)
    return 1 - v + u * 2 * v;
  }

  private respawn(id: string): void {
    const s = this.load(id);
    if (!s) return;
    const tpl = this.config.pveTemplates[s.type];
    s.defender = structuredClone(tpl.defender);
    s.loot = { ...tpl.loot };
    s.cleared = false;
    this.store.set(COLLECTION, id, s);
  }
}

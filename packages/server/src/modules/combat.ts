import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import type { CombatUnit, Snapshot, TraitEffect } from '../infra/combat-types.js';
import { makeLogger } from '../infra/logger.js';

const log = makeLogger('combat');

/**
 * 领域模块 · Combat（战斗）— 有状态模块
 * 对应设计文档 docs/2_2.0设计/08_战斗系统重做设计.md
 *
 * 从"瞬时结算纯函数"改为"一个有状态的战斗流程"：
 *  - owns `battle` 集合：每个进行中的战场一条记录（铁律#1 状态归属唯一）。
 *  - 时间推进走注入的 Scheduler：每个战场登记"下一 tick"任务（铁律#3）。
 *  - combat 只算结果，发 Command 让 owner(military/economy/pve) 改状态，发 Event 出战报（铁律#2/#4）。
 *
 * 核心机制（§4）：
 *  - 一地一场战：同一目标只有一个战场；后到的部队按阵营并入，下一 tick 生效。
 *  - 两排：前排=melee，后排=ranged。永远先掉前排，前排全灭才掉后排。
 *  - 远程兵按"己方/敌方近战是否存活"切换用 rangedAtk / meleeAtk（§4.3）。
 *  - 逐 tick 减员，势均力敌打得久、一边倒最快（§4.4 雪球公式）。
 *  - 打到一方归零结束，不撤退（§4.5）。
 *
 * 本轮范围：PvE/PvP 单场 + 攻击方并入（一地一场战）+ 每 tick 实时快照推送。
 * 暂缓：协防 reinforce、PvE 多人合战分战利品（见 08 文档§七）。
 */

/** 一支来攻部队的贡献记录（用于战斗结束后各自返程/分战利品）。 */
interface Contribution {
  movementId: string;
  fromVillage: string;
  fromXY: { q: number; r: number }; // 六边形轴坐标（对 combat 为不透明透传，用于结束后返程）
  /** 原始出征兵力（code -> count），返程按幸存比例分配。 */
  troops: Record<string, number>;
  /** 该军队携带的宝物 code（军队携带宝物机制）；全歼时按 pve/pvp 规则处理。 */
  treasures: string[];
  /** 王国议会厅购买的 NPC 军队：不占玩家人口，也不触发玩家伤亡回收或营地宝物掉落。 */
  npcService?: boolean;
  kingdomMercenary?: boolean;
  returnPveId?: string;
}

/** 防守方独立兵力池：本村驻军与每支临时援军在战斗快照中保持来源边界。 */
interface DefenderContribution {
  sourceId: string;
  movementId?: string;
  fromVillage?: string;
  npcService?: boolean;
  troops: Record<string, number>;
}

interface BattleRound {
  round: number;
  attackerLosses: Record<string, number>;
  defenderLosses: Record<string, number>;
  attacker: Record<string, number>;
  defender: Record<string, number>;
}

interface Battle {
  id: string;
  targetKind: 'village' | 'pve' | 'field';
  /** 玩家村战斗模式；PvE/野战没有该字段。 */
  battleType?: 'raid' | 'siege' | 'ambush';
  /** 任务标识，供任务模块识别 NPC 攻城等特殊战斗。 */
  taskCode?: string;
  targetId: string; // 防守方村 id、PvE 目标 id 或野战时的 defender movement id
  targetXY: { q: number; r: number }; // 六边形轴坐标（不透明透传）
  wallLevel: number;
  /** 进攻方：key = `${movementId}#${code}`（多支来攻并入时按贡献命名空间隔离，各自 smithy 数值不同）。 */
  attacker: Snapshot;
  /** 防守方：key = code（单一来源：驻军或 PvE 守军）。 */
  defender: Snapshot;
  /** 防守方开战时各兵种原始数量（结束时算实际损失，交回 owner 扣兵）。 */
  defenderOriginal: Record<string, number>;
  /** 防守方来源索引；旧战斗没有该字段时按目标村驻军兼容。 */
  defenderContributions?: Record<string, DefenderContribution>;
  contributions: Record<string, Contribution>; // movementId -> 贡献
  /** 野战时防守方行军贡献（用于 BattleEnded 中恢复防守方行军）。 */
  defenderContribution?: Contribution;
  /** 分数击杀累加（不足1个的伤害留到下tick，保证战斗必然推进）。 */
  attackerPending: number;
  defenderPending: number;
  /** 开战时双方阵容（包含之后并入的进攻部队），用于战报回放。 */
  initialAttacker: Record<string, number>;
  initialDefender: Record<string, number>;
  /** 每轮结算后的兵力快照，战斗结束后写入 BattleEnded。 */
  rounds: BattleRound[];
  attackPower0: number; // 开战时总攻(战报展示)
  defensePower0: number;
  startedAt: number;
  ticks: number;
  status: 'active' | 'ended';
}

const COLLECTION = 'battle';
const MAX_TICKS = 20000; // 安全阀：极端情况下(双方都0攻)兜底结束，避免无限循环
const MAX_REPLAY_ROUNDS = 120; // 战报只保留均匀抽样的关键轮次，避免极端战斗产生数 MB 推送/存档

export class CombatModule {
  static readonly NAME = 'combat';



  /**
   * 同步预占集合：记录当前正在执行 fetchDefender async 阶段的 targetId。
   * 防止两条并发 Engage 命令在同一目标上都走"新建"路径，导致重复战场（TOCTOU）。
   * Key: targetId；Value: 最终 battle id（先占位，fetchDefender 完成后再写 store）。
   */
  private readonly claiming = new Set<string>();

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
    this.commands.register('combat.Engage', (c) => this.engage(c)); // 内部：Movement 到达时调用
    this.commands.register('combat.GetBattle', (c) => this.getBattle(c));
    this.commands.register('combat.GetFieldBattle', (c) => this.getFieldBattle(c));
    this.commands.register('combat.CancelFieldBattle', (c) => this.cancelFieldBattle(c));
  }

  /** 重启恢复：为所有进行中的战场重新登记下一 tick。 */
  resume(): void {
    for (const b of this.store.all<Battle>(COLLECTION)) {
      if (b.status === 'active') this.scheduler.schedule(this.tickMs(), () => this.tick(b.id), `combat:${b.id}`, `battle:${b.id}`);
    }
  }

  private tickMs(): number {
    return this.config.constants.combatTickMs;
  }

  private load(id: string): Battle | undefined {
    const battle = this.store.get<Battle>(COLLECTION, id);
    if (battle) this.ensureBattleLog(battle);
    return battle;
  }

  private nextId(): string {
    const n = (this.store.get<number>('battle_seq', 'n') ?? 0) + 1;
    this.store.set('battle_seq', 'n', n);
    return `bt-${n}`;
  }

  /** 找到目标格上进行中的战场（一地一场战）。 */
  private findActive(targetId: string): Battle | undefined {
    const battle = this.store.all<Battle>(COLLECTION).find((b) => b.targetId === targetId && b.status === 'active');
    if (battle) this.ensureBattleLog(battle);
    return battle;
  }

  /** 兼容上线前已落盘的进行中战斗，首次访问时补齐战报回放字段。 */
  private ensureBattleLog(b: Battle): void {
    b.initialAttacker ??= aggregateCounts(b.attacker);
    b.initialDefender ??= aggregateCounts(b.defender);
    b.rounds ??= [];
  }

  // ---- Commands ----

  private getBattle(cmd: Command): CommandResult {
    const { targetId, villageId } = cmd.payload as { targetId: string; villageId?: string };
    const b = this.findActive(targetId);
    if (!b) return { ok: true, payload: { battle: null } };
    if (villageId && !this.canViewBattle(b, villageId)) {
      return { ok: false, payload: {}, reason: 'battle_forbidden' };
    }
    return { ok: true, payload: { battle: this.snapshotForClient(b) } };
  }

  /** Movement 的内部查询：返回包含指定行军的进行中野战及其双方行军 id。 */
  private getFieldBattle(cmd: Command): CommandResult {
    const { movementId } = cmd.payload as { movementId?: string };
    if (!movementId) return { ok: false, payload: {}, reason: 'movement_id_required' };
    const battle = this.store.all<Battle>(COLLECTION).find((b) => {
      if (b.status !== 'active' || b.targetKind !== 'field') return false;
      return Boolean(b.contributions?.[movementId] || b.defenderContribution?.movementId === movementId);
    });
    if (!battle) return { ok: true, payload: { battle: null } };
    const movementIds = [
      ...Object.keys(battle.contributions ?? {}),
      ...(battle.defenderContribution?.movementId ? [battle.defenderContribution.movementId] : []),
    ];
    return { ok: true, payload: { battle: { id: battle.id, movementIds: [...new Set(movementIds)] } } };
  }

  /** Movement 的内部运维命令：删除一场野战并取消其下一 tick，不结算伤亡。 */
  private cancelFieldBattle(cmd: Command): CommandResult {
    const { battleId, movementId } = cmd.payload as { battleId?: string; movementId?: string };
    const battle = battleId
      ? this.store.get<Battle>(COLLECTION, battleId)
      : movementId
        ? this.store.all<Battle>(COLLECTION).find((b) => b.status === 'active' && b.targetKind === 'field'
          && Boolean(b.contributions?.[movementId] || b.defenderContribution?.movementId === movementId))
        : undefined;
    if (!battle || battle.status !== 'active' || battle.targetKind !== 'field') {
      return { ok: true, payload: { cancelled: false } };
    }
    this.scheduler.cancelByOwner(`combat:${battle.id}`);
    this.store.delete(COLLECTION, battle.id);
    void this.bus.emit({
      name: 'combat.BattleCancelled', source: CombatModule.NAME, ts: this.now(),
      payload: { battleId: battle.id, targetKind: 'field', reason: 'scout_immunity' },
    } as DomainEvent);
    const movementIds = [
      ...Object.keys(battle.contributions ?? {}),
      ...(battle.defenderContribution?.movementId ? [battle.defenderContribution.movementId] : []),
    ];
    return { ok: true, payload: { cancelled: true, battleId: battle.id, movementIds: [...new Set(movementIds)] } };
  }

  private canViewBattle(b: Battle, villageId: string): boolean {
    if (b.targetKind === 'village' && b.targetId === villageId) return true;
    if (b.defenderContribution?.fromVillage === villageId) return true;
    return Object.values(b.contributions).some((c) => c.fromVillage === villageId);
  }

  /**
   * 开战 / 并入。Movement 到达目标时发来：来攻方兵力快照(已含 smithy 加成) + 归属信息。
   * 已有战场 → 并入 attacker 阵营；否则新开一场并拉取防守方快照。
   *
   * TOCTOU 修复（同步预占 + 二次安全并入）：
   *  findActive 是同步操作，结果立即可信；但 fetchDefender 是 async，
   *  在 await 期间另一条并发 Engage 也可能走到"新建"分支。
   *  解决方案：进入新建分支后立即同步写入 claiming 集合预占 targetId，
   *  fetchDefender 完成后再次检查——若此时已有战场（由并发 Engage 创建），
   *  则安全并入而非重复建立，保证"一地一场战"不变式。
   */
  private async engage(cmd: Command): Promise<CommandResult> {
    const p = cmd.payload as {
      targetKind: 'village' | 'pve' | 'field';
      battleType?: 'raid' | 'siege' | 'ambush';
      targetId: string;
      targetXY: { q: number; r: number };
      movementId: string;
      fromVillage: string;
      fromXY: { q: number; r: number };
      originalFromXY?: { q: number; r: number };
      troops: Record<string, number>;
      attackerSnapshot: Snapshot;
      /** 该军队携带的宝物（军队携带宝物机制）。 */
      treasures?: string[];
      /** 野战时：防守方行军贡献信息（由 movement 模块提供）。 */
      defenderField?: {
        movementId: string; fromVillage: string; fromXY: { q: number; r: number };
        originalFromXY?: { q: number; r: number };
        troops: Record<string, number>; attackerSnapshot: Snapshot; treasures?: string[];
      };
      npcService?: boolean;
      kingdomMercenary?: boolean;
      returnPveId?: string;
      taskCode?: string;
    };

    const contribId = p.movementId;
    const treasures = p.treasures ?? [];
    const existing = this.findActive(p.targetId);
    if (existing) {
      // 并入已有战场的 attacker 阵营（下一 tick 生效）
      existing.contributions[contribId] = {
        movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops }, treasures: [...treasures], npcService: !!p.npcService, kingdomMercenary: !!p.kingdomMercenary, returnPveId: p.returnPveId,
      };
      for (const [code, u] of Object.entries(p.attackerSnapshot)) {
        existing.attacker[`${contribId}#${code}`] = existing.battleType === 'ambush' ? applyAmbushBonus(u, this.config.constants.ambushAttackBonus) : { ...u };
      }
      existing.attackPower0 += totalPower(existing.battleType === 'ambush' ? applyAmbushSnapshot(p.attackerSnapshot, this.config.constants.ambushAttackBonus) : p.attackerSnapshot);
      mergeCounts(existing.initialAttacker, aggregateCounts(p.attackerSnapshot));
      this.store.set(COLLECTION, existing.id, existing);
      log('援军并入', { battleId: existing.id, from: p.fromVillage, troops: p.troops, newAtkPower: Math.round(existing.attackPower0) });
      return { ok: true, payload: { battleId: existing.id, merged: true } };
    }

    // 同步预占：标记该 targetId 正在被新建流程占用
    // 若已有其他并发 Engage 在预占中，直接返回等它完成后再并入
    if (this.claiming.has(p.targetId)) {
      // 短路等待：再做一次 findActive（此时另一个 engage 可能已写入 store）
      // 若仍未就绪（极罕见的 ABA 场景），保守地返回 merged=false 让调用方重试
      const raceCheck = this.findActive(p.targetId);
      if (raceCheck) {
        raceCheck.contributions[contribId] = {
          movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops }, treasures: [...treasures], npcService: !!p.npcService, kingdomMercenary: !!p.kingdomMercenary, returnPveId: p.returnPveId,
        };
        for (const [code, u] of Object.entries(p.attackerSnapshot)) {
          raceCheck.attacker[`${contribId}#${code}`] = raceCheck.battleType === 'ambush' ? applyAmbushBonus(u, this.config.constants.ambushAttackBonus) : { ...u };
        }
        raceCheck.attackPower0 += totalPower(raceCheck.battleType === 'ambush' ? applyAmbushSnapshot(p.attackerSnapshot, this.config.constants.ambushAttackBonus) : p.attackerSnapshot);
        this.store.set(COLLECTION, raceCheck.id, raceCheck);
        log('竞态并入（claiming）', { battleId: raceCheck.id, from: p.fromVillage });
        return { ok: true, payload: { battleId: raceCheck.id, merged: true } };
      }
    }
    // 野战（field）：从 payload 直接取防守方，跳过 fetchDefender
    if (p.targetKind === 'field') {
      const df = p.defenderField;
      if (!df) return { ok: false, payload: {}, reason: 'field_missing_defender' };
      const defender: Snapshot = {};
      for (const [code, u] of Object.entries(df.attackerSnapshot)) {
        // 伏击只打击路过军队的远程排，并让这些单位按近战数据加入前排。
        defender[code] = p.battleType === 'ambush' && u.form === 'ranged' ? { ...u, form: 'melee', ambushPriority: true } : { ...u };
      }
      const defenderOriginal: Record<string, number> = {};
      for (const [code, u] of Object.entries(defender)) defenderOriginal[code] = u.count;
      const attacker: Snapshot = {};
      for (const [code, u] of Object.entries(p.attackerSnapshot)) attacker[`${contribId}#${code}`] = p.battleType === 'ambush' ? applyAmbushBonus(u, this.config.constants.ambushAttackBonus) : { ...u };

      const id = this.nextId();
      const defContrib: Contribution = {
        movementId: df.movementId, fromVillage: df.fromVillage, fromXY: df.fromXY,
        troops: { ...df.troops }, treasures: df.treasures ?? [],
      };
      const battle: Battle = {
        id, targetKind: 'field', targetId: p.targetId, targetXY: p.targetXY,
        wallLevel: 0, attacker, defender, defenderOriginal,
        battleType: p.battleType, taskCode: p.taskCode,
        contributions: { [contribId]: { movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops }, treasures: [...treasures], npcService: !!p.npcService, kingdomMercenary: !!p.kingdomMercenary, returnPveId: p.returnPveId } },
        defenderContribution: defContrib,
        attackerPending: 0, defenderPending: 0,
        initialAttacker: aggregateCounts(attacker), initialDefender: aggregateCounts(defender), rounds: [],
        attackPower0: totalPower(attacker), defensePower0: totalPower(defender),
        startedAt: this.now(), ticks: 0, status: 'active',
      };
      this.store.set(COLLECTION, id, battle);
      log('野战开始', { battleId: id, at: p.targetXY, atkPower: Math.round(battle.attackPower0), defPower: Math.round(battle.defensePower0) });
      this.emitToParties(battle, 'combat.BattleStarted', (villageId, side) => ({
        villageId, side, battleId: id, targetKind: 'field', targetId: p.targetId,
        attackPower: Math.round(battle.attackPower0), defensePower: Math.round(battle.defensePower0),
        attacker: battle.initialAttacker, defender: battle.initialDefender, round: 0,
      }));
      this.scheduler.schedule(this.tickMs(), () => this.tick(id), `combat:${id}`, `battle:${id}`);
      return { ok: true, payload: { battleId: id, merged: false } };
    }

    this.claiming.add(p.targetId);

    let fetchedDefender: { defender: Snapshot; wallLevel: number; defenderContributions?: Record<string, DefenderContribution> } | null = null;
    try {
      fetchedDefender = await this.fetchDefender(p.targetKind, p.targetId, p.battleType);
    } finally {
      this.claiming.delete(p.targetId);
    }

    // 二次安全检查：fetchDefender 是 async，并发 Engage 可能在此期间已创建战场
    const raceExisting = this.findActive(p.targetId);
    if (raceExisting) {
      // 安全并入
      raceExisting.contributions[contribId] = {
        movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops }, treasures: [...treasures], npcService: !!p.npcService, kingdomMercenary: !!p.kingdomMercenary, returnPveId: p.returnPveId,
      };
      for (const [code, u] of Object.entries(p.attackerSnapshot)) {
        raceExisting.attacker[`${contribId}#${code}`] = raceExisting.battleType === 'ambush' ? applyAmbushBonus(u, this.config.constants.ambushAttackBonus) : { ...u };
      }
      raceExisting.attackPower0 += totalPower(raceExisting.battleType === 'ambush' ? applyAmbushSnapshot(p.attackerSnapshot, this.config.constants.ambushAttackBonus) : p.attackerSnapshot);
      mergeCounts(raceExisting.initialAttacker, aggregateCounts(p.attackerSnapshot));
      this.store.set(COLLECTION, raceExisting.id, raceExisting);
      log('二次检查并入', { battleId: raceExisting.id, from: p.fromVillage });
      return { ok: true, payload: { battleId: raceExisting.id, merged: true } };
    }

    const { defender, wallLevel, defenderContributions } = fetchedDefender!;

    const attacker: Snapshot = {};
    for (const [code, u] of Object.entries(p.attackerSnapshot)) attacker[`${contribId}#${code}`] = { ...u };

    const defenderOriginal: Record<string, number> = {};
    for (const [code, u] of Object.entries(defender)) defenderOriginal[code] = u.count;

    const id = this.nextId();
    const battle: Battle = {
      id,
      targetKind: p.targetKind,
      battleType: p.battleType ?? (p.targetKind === 'village' ? 'siege' : undefined),
      taskCode: p.taskCode,
      targetId: p.targetId,
      targetXY: p.targetXY,
      wallLevel,
      attacker,
      defender,
      defenderOriginal,
      defenderContributions,
      contributions: { [contribId]: { movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops }, treasures: [...treasures], npcService: !!p.npcService, kingdomMercenary: !!p.kingdomMercenary, returnPveId: p.returnPveId } },
      attackerPending: 0,
      defenderPending: 0,
      initialAttacker: aggregateCounts(attacker), initialDefender: aggregateCounts(defender), rounds: [],
      attackPower0: totalPower(attacker),
      defensePower0: totalPower(defender),
      startedAt: this.now(),
      ticks: 0,
      status: 'active',
    };
    this.store.set(COLLECTION, id, battle);

    log('战斗开始', {
      battleId: id, targetKind: p.targetKind, targetId: p.targetId,
      wallLevel,
      atkPower: Math.round(battle.attackPower0), defPower: Math.round(battle.defensePower0),
      attacker: snapshotSummary(attacker),
      defender: snapshotSummary(defender),
    });

    // 开战事件（推给双方）
    this.emitToParties(battle, 'combat.BattleStarted', (villageId, side) => ({
      villageId, side, battleId: id, targetKind: p.targetKind, targetId: p.targetId,
      attackPower: Math.round(battle.attackPower0), defensePower: Math.round(battle.defensePower0),
      attacker: battle.initialAttacker, defender: battle.initialDefender, round: 0,
    }));

    this.scheduler.schedule(this.tickMs(), () => this.tick(id), `combat:${id}`, `battle:${id}`);
    return { ok: true, payload: { battleId: id, merged: false } };
  }

  /** 拉取防守方快照 + 城墙等级。PvP 找 military+building；PvE 找 pve。 */
  private async fetchDefender(kind: 'village' | 'pve', targetId: string, battleType?: 'raid' | 'siege' | 'ambush'): Promise<{ defender: Snapshot; wallLevel: number; defenderContributions?: Record<string, DefenderContribution> }> {
    if (kind === 'pve') {
      const res = await this.commands.send({ name: 'pve.GetDefenderSnapshot', from: CombatModule.NAME, payload: { id: targetId, purpose: battleType } });
      return { defender: ((res.payload as any)?.snapshot ?? {}) as Snapshot, wallLevel: Number((res.payload as any)?.wallLevel ?? 0) };
    }
    const defRes = await this.commands.send({
      name: 'military.GetCombatSnapshot', from: CombatModule.NAME,
      payload: battleType === 'raid' ? { villageId: targetId, purpose: 'raid' } : { villageId: targetId },
    });
    const resident = ((defRes.payload as any)?.snapshot ?? {}) as Snapshot;
    const defender: Snapshot = {};
    const defenderContributions: Record<string, DefenderContribution> = {};
    const residentSource = `resident:${targetId}`;
    const residentTroops: Record<string, number> = {};
    // 防守方同兵种也按来源命名空间保存，战斗计算仍使用相同的兵种属性，
    // 结算时再按来源扣除，避免援军与本村部队混成一个兵力池。
    for (const [code, unit] of Object.entries(resident)) {
      defender[`${residentSource}#${code}`] = { ...unit };
      residentTroops[code] = unit.count;
    }
    defenderContributions[residentSource] = { sourceId: residentSource, fromVillage: targetId, troops: residentTroops };

    // 临时增援不写入目标村 military；战斗只在结算快照中合并，并由 Movement 在战后按 movementId 扣除。
    const reinforcement = await this.commands.send({
      name: 'movement.GetReinforcementSnapshot', from: CombatModule.NAME,
      payload: { villageId: targetId, purpose: battleType === 'raid' ? 'raid' : 'siege' },
    });
    const reinforcementContributions = ((reinforcement.payload as any)?.contributions ?? []) as Array<{ id: string; fromVillage?: string; npcService?: boolean; troops?: Snapshot }>;
    for (const source of reinforcementContributions) {
      const sourceId = `reinforcement:${source.id}`;
      const sourceTroops: Record<string, number> = {};
      for (const [code, unit] of Object.entries(source.troops ?? {})) {
        defender[`${sourceId}#${code}`] = { ...unit };
        sourceTroops[code] = unit.count;
      }
      defenderContributions[sourceId] = {
        sourceId,
        movementId: source.id,
        fromVillage: source.fromVillage,
        npcService: source.npcService,
        troops: sourceTroops,
      };
    }
    const build = await this.commands.send({ name: 'building.GetDefenseSnapshot', from: CombatModule.NAME, payload: { villageId: targetId } });
    // 掠夺战即使守方派兵也不启用城墙；攻城战才取城墙加成。
    const wallLevel = battleType === 'raid' ? 0 : ((build.payload as any)?.wallLevel ?? 0);
    return { defender, wallLevel, defenderContributions };
  }

  // ---- Tick 推进 ----

  private async tick(id: string): Promise<void> {
    const b = this.load(id);
    if (!b || b.status !== 'active') return;
    b.ticks += 1;

    const dt = this.tickMs() / 1000;
    const k = this.config.constants.combatStrength;
    const wallMult = (() => {
      const wallDef = this.config.buildings['wall'];
      let totalDef = 0;
      for (let lv = 1; lv <= b.wallLevel; lv++) {
        totalDef += wallDef.levels[lv]?.defensePerLevel ?? this.config.constants.wallBonusPerLevel;
      }
      return 1 + totalDef;
    })();

    const attackerBefore = aggregateCounts(b.attacker);
    const defenderBefore = aggregateCounts(b.defender);

    // 双方同时用 tick 开始时的兵力互算（避免先手偏差）
    const killsToDef = computeKills(b.attacker, b.defender, k, dt, wallMult);
    const killsToAtk = computeKills(b.defender, b.attacker, k, dt, 1);

    b.defenderPending = applyKills(b.defender, killsToDef + b.defenderPending);
    b.attackerPending = applyKills(b.attacker, killsToAtk + b.attackerPending);

    const atkAlive = totalCount(b.attacker);
    const defAlive = totalCount(b.defender);

    const attackerAfter = aggregateCounts(b.attacker);
    const defenderAfter = aggregateCounts(b.defender);
    b.rounds.push({
      round: b.ticks,
      attackerLosses: countDelta(attackerBefore, attackerAfter),
      defenderLosses: countDelta(defenderBefore, defenderAfter),
      attacker: attackerAfter,
      defender: defenderAfter,
    });

    // 每10 tick 记录一次兵力变化（避免刷屏）
    if (b.ticks % 10 === 0) {
      log(`tick#${b.ticks}`, { battleId: id, atkAlive, defAlive, killsToDef: Math.round(killsToDef * 100) / 100, killsToAtk: Math.round(killsToAtk * 100) / 100 });
    }

    if (atkAlive <= 0 || defAlive <= 0 || b.ticks >= MAX_TICKS) {
      await this.finish(b);
      return;
    }

    this.store.set(COLLECTION, id, b);

    // 每若干 tick 推一次实时快照（约每 500ms 一次，避免刷屏；可调参）
    const pushEvery = Math.max(1, Math.round(500 / this.tickMs()));
    if (b.ticks % pushEvery === 0) {
      this.emitToParties(b, 'combat.BattleTick', (villageId, side) => ({
        villageId, side, battleId: id,
        attacker: attackerAfter, defender: defenderAfter,
        attackerLosses: b.rounds[b.rounds.length - 1].attackerLosses,
        defenderLosses: b.rounds[b.rounds.length - 1].defenderLosses,
        round: b.ticks,
      }));
    }

    this.scheduler.schedule(this.tickMs(), () => this.tick(id), `combat:${id}`, `battle:${id}`);
  }

  /** 结算：算损失/幸存/战利品 → 发 Command 让 owner 改状态 → 发 Event 出战报与返程信息。 */
  private async finish(b: Battle): Promise<void> {
    b.status = 'ended';
    this.store.set(COLLECTION, b.id, b);

    const defAlive = totalCount(b.defender);
    const attackerWins = defAlive <= 0;

    // 防守方实际损失（原始 - 现存）。内部快照按来源命名空间，
    // 同时生成按兵种聚合的战报数据和按来源扣兵数据。
    const defenderLosses: Record<string, number> = {};
    const defenderLossesByMovement: Record<string, Record<string, number>> = {};
    const residentDefenderLosses: Record<string, number> = {};
    for (const [key, orig] of Object.entries(b.defenderOriginal)) {
      const dead = orig - (b.defender[key]?.count ?? 0);
      if (dead <= 0) continue;
      const split = key.indexOf('#');
      const sourceId = split >= 0 ? key.slice(0, split) : `resident:${b.targetId}`;
      const code = split >= 0 ? key.slice(split + 1) : key;
      defenderLosses[code] = (defenderLosses[code] ?? 0) + dead;
      const source = b.defenderContributions?.[sourceId];
      if (source?.movementId) {
        const sourceLosses = defenderLossesByMovement[source.movementId] ?? {};
        sourceLosses[code] = (sourceLosses[code] ?? 0) + dead;
        defenderLossesByMovement[source.movementId] = sourceLosses;
      } else {
        residentDefenderLosses[code] = (residentDefenderLosses[code] ?? 0) + dead;
      }
    }

    // 进攻方按 code 聚合的损失（战报用）
    const attackerLosses: Record<string, number> = {};
    for (const [cid, contrib] of Object.entries(b.contributions)) {
      for (const [code, orig] of Object.entries(contrib.troops)) {
        const alive = b.attacker[`${cid}#${code}`]?.count ?? 0;
        const dead = orig - alive;
        if (dead > 0) attackerLosses[code] = (attackerLosses[code] ?? 0) + dead;
      }
    }

    // 进攻方总幸存载货能力（决定能搬多少）
    let totalCarry = 0;
    for (const u of Object.values(b.attacker)) totalCarry += u.count * u.carry;

    log('战斗结束', { battleId: b.id, ticks: b.ticks, attackerWins, atkAlive: totalCount(b.attacker), defAlive, attackerLosses, defenderLosses, totalCarry });

    // 野战（field）分支：跳过 pve/pvp 逻辑，双方各自处理伤亡
    if (b.targetKind === 'field') {
      await this.finishField(b, attackerLosses, defenderLosses, attackerWins);
      this.store.delete(COLLECTION, b.id);
      return;
    }

    // 应用防守方损失 + 取战利品
    let looted: Record<string, number> = {};
    let storedLoot: Record<string, number> = {};
    let buildingLoot: Record<string, number> = {};
    let buildingDamage: unknown[] = [];
    let campCleared = false;
    let isTaskCamp = false;
    let isNoRespawn = false;
    if (b.targetKind === 'pve') {
      const apply = await this.commands.send({
        name: 'pve.ApplyResult', from: CombatModule.NAME,
        payload: {
          id: b.targetId, defenderLosses, attackerWins, looterCarry: totalCarry, battleType: b.battleType,
          buildingPower: totalPower(filterNonSiegeWeapons(b.attacker)) + totalPower(filterSiegeWeapons(b.attacker)),
        },
      });
      looted = (apply.payload as any)?.looted ?? {};
      buildingLoot = (apply.payload as any)?.buildingLoot ?? {};
      storedLoot = (apply.payload as any)?.storedLoot ?? {};
      buildingDamage = (apply.payload as any)?.buildingDamage ?? [];
      campCleared = !!((apply.payload as any)?.cleared);
      // M8/M9 的天王老子村是任务专属目标，不应触发普通 PvE 宝物掉落。
      // 旧存档可能没有 task=true 标记，因此同时按模板类型兜底识别。
      isTaskCamp = !!((apply.payload as any)?.task)
        || (apply.payload as any)?.taskType === 'tianwang_village';
      isNoRespawn = !!((apply.payload as any)?.noRespawn);
      // 不重生的 NPC（当前为幸福村）被清空后即代表实体被摧毁：移除地图地块并
      // 发出 pve.TargetRemoved，让所有仍在前往该目标的商队/军队立即从当前位置返程。
      // 任务营地仍由 TasksModule 在推进任务后显式清理，不能在这里提前移除。
      if (campCleared && attackerWins && isNoRespawn) {
        await this.commands.send({ name: 'pve.Remove', from: CombatModule.NAME, payload: { id: b.targetId } });
      }
    } else {
      // PvP：扣防守方兵力
      if (Object.keys(residentDefenderLosses).length) {
        const delta: Record<string, number> = {};
        for (const [code, dead] of Object.entries(residentDefenderLosses)) delta[code] = -dead;
        await this.commands.send({ name: 'military.AdjustTroops', from: CombatModule.NAME, payload: { villageId: b.targetId, delta } });
      }
      const battleType = b.battleType ?? 'siege';
      const siegeWeapons = filterSiegeWeapons(b.attacker);
      const regularTroops = filterNonSiegeWeapons(b.attacker);
      const siegePower = totalPower(siegeWeapons);
      const regularPower = totalPower(regularTroops);
      // 只有战后仍有进攻方幸存者才结算建筑：攻城武器先拆除，普通部队随后破坏。
      // 两种操作都产生对应建筑等级的战利品；区别在于普通部队的破坏可修复，
      // 攻城武器的拆除在降到 0 级时会移除建筑。
      if (attackerWins && totalCount(b.attacker) > 0) {
        const outerThreshold = battleType === 'raid'
          ? this.config.constants.pvpRaidPowerPerBuildingLevel
          : this.config.constants.pvpSiegePowerPerBuildingLevel;

        // 武器先处理外围拆除，保证随后普通部队的破坏以最新等级为准。
        if (siegePower > 0) {
          const weaponOuter = await this.commands.send({
            name: 'building.ApplyBattleDamage', from: CombatModule.NAME,
            payload: { villageId: b.targetId, zone: 'outer', power: siegePower, powerPerLevel: outerThreshold, mode: 'demolish' },
          });
          buildingDamage = [...buildingDamage, ...((weaponOuter.payload as any)?.destroyed ?? [])];
          buildingLoot = mergeResources(buildingLoot, (weaponOuter.payload as any)?.loot ?? {});
        }
        if (regularPower > 0) {
          const regularOuter = await this.commands.send({
            name: 'building.ApplyBattleDamage', from: CombatModule.NAME,
            payload: { villageId: b.targetId, zone: 'outer', power: regularPower, powerPerLevel: outerThreshold, mode: 'damage' },
          });
          buildingDamage = [...buildingDamage, ...((regularOuter.payload as any)?.destroyed ?? [])];
          buildingLoot = mergeResources(buildingLoot, (regularOuter.payload as any)?.loot ?? {});
        }

        // 攻城时内城只能被攻城武器拆除，普通部队不能对内城造成破坏。
        if (battleType === 'siege' && siegePower > 0) {
          const inner = await this.commands.send({
            name: 'building.ApplyBattleDamage', from: CombatModule.NAME,
            payload: { villageId: b.targetId, zone: 'inner', power: siegePower, powerPerLevel: this.config.constants.pvpSiegeWeaponPowerPerBuildingLevel, mode: 'demolish' },
          });
          buildingDamage = [...buildingDamage, ...((inner.payload as any)?.destroyed ?? [])];
          buildingLoot = mergeResources(buildingLoot, (inner.payload as any)?.loot ?? {});
        }

        // 战利品装载顺序：金币优先；木/泥/铁/粮尽量平均装载。
        // 攻城时四种基础资源优先来自仓库/粮仓，只有仓储战利品装满后才装建筑拆除收益。
        // 规划在一次纯函数中完成，随后只把仓储来源的部分交给 Economy 扣除。
        let storedAvailable: Record<string, number> = {};
        if (battleType === 'siege' && totalCarry > 0 && this.config.constants.pvpSiegeStorageLootRatio > 0) {
          const lootRes = await this.commands.send({
            name: 'economy.GetLootable', from: CombatModule.NAME,
            payload: { villageId: b.targetId, ignoreSafe: true },
          });
          const available = (lootRes.payload as any)?.lootable ?? {};
          // 保险库保护在建筑拆除后查询：攻城器械若先拆掉保险库，保护量立即下降，
          // 随后读取的仓储战利品才按新的保护量计算。
          const vaultRes = await this.commands.send({
            name: 'building.GetVaultProtection', from: CombatModule.NAME,
            payload: { villageId: b.targetId },
          });
          const protectedAmount = (vaultRes.payload as any)?.protection ?? {};
          const afterVault = subtractProtected(available, protectedAmount);
          storedAvailable = scaleResources(afterVault, this.config.constants.pvpSiegeStorageLootRatio);
        }
        const lootPlan = planPvpLoot(storedAvailable, buildingLoot, totalCarry);
        if (Object.keys(lootPlan.stored).length > 0) {
          const taken = await this.commands.send({ name: 'economy.TakeLoot', from: CombatModule.NAME, payload: { villageId: b.targetId, amount: lootPlan.stored } });
          storedLoot = (taken.payload as any)?.taken ?? {};
        }
        looted = mergeResources(looted, lootPlan.building);
        looted = mergeResources(looted, storedLoot);
      }

      const pvp = await this.commands.send({ name: 'player.GetPvpContext', from: CombatModule.NAME, payload: { villageId: b.targetId } });
      const hasLoot = Object.values(looted).some((amount) => amount > 0);
      let recovered = false;
      if ((pvp.payload as any)?.recoveryAvailable) {
        const recovery = await this.commands.send({ name: 'economy.ApplyPvpRecovery', from: CombatModule.NAME, payload: { villageId: b.targetId } });
        recovered = Boolean((recovery.payload as any)?.triggered);
      }
      if (hasLoot || recovered) {
        await this.commands.send({ name: 'player.RecordPvpHit', from: CombatModule.NAME, payload: { villageId: b.targetId, recovered, recordHit: hasLoot } });
      }
      log('PvP 结算', { target: b.targetId, battleType, buildingDamage, buildingLoot, storedLoot, looted });
    }

    const totalLootCarry = totalCarry || 1;
    const reportBase = {
      attackerWins,
      attackPower: Math.round(b.attackPower0),
      defensePower: Math.round(b.defensePower0),
      attackerLosses,
      defenderLosses,
      targetKind: b.targetKind,
      targetId: b.targetId,
      taskCode: b.taskCode,
      battleType: b.battleType,
      battleLabel: b.battleType === 'raid' ? '掠夺' : b.battleType === 'siege' ? '攻城' : b.battleType === 'ambush' ? '伏击' : undefined,
      attackerLineup: b.initialAttacker,
      defenderLineup: b.initialDefender,
      totalRounds: b.rounds.length,
      rounds: sampleBattleRounds(b.rounds),
      buildingDamage,
      buildingLoot,
      storedLoot,
      // 任务结算需要区分“击败部分守军”和“真正清空营地”；必须随 BattleEnded 透传。
      campCleared,
    };

    // 多支军队共同攻击同一玩家村庄时，按各支出征兵力占比分摊被消灭的守军，
    // 让声望奖励按实际归属结算而不是每支军队重复领取整场击杀数。
    const contributionEntries = Object.entries(b.contributions);
    const contributionSize = new Map<string, number>();
    const totalContributionSize = contributionEntries.reduce((sum, [cid, c]) => {
      const size = Object.values(c.troops).reduce((n, count) => n + Math.max(0, Math.floor(count)), 0);
      contributionSize.set(cid, size);
      return sum + size;
    }, 0);
    const remainingDefenderLosses = { ...defenderLosses };

    // 每支来攻部队：算各自幸存兵力 + 按载货比例分战利品 → 发结束事件（Movement 据此返程）
    for (const [index, [cid, contrib]] of contributionEntries.entries()) {
      const survivors: Record<string, number> = {};
      const attackerLossesForVillage: Record<string, number> = {};
      let carry = 0;
      for (const code of Object.keys(contrib.troops)) {
        const u = b.attacker[`${cid}#${code}`];
        const survived = u?.count ?? 0;
        const lost = contrib.troops[code] - survived;
        if (survived > 0) {
          survivors[code] = survived;
          carry += survived * (u?.carry ?? 0);
        }
        if (lost > 0) attackerLossesForVillage[code] = lost;
      }
      const share: Record<string, number> = {};
      if (Object.keys(looted).length && carry > 0) {
        const ratio = carry / totalLootCarry;
        for (const [t, v] of Object.entries(looted)) share[t] = Math.floor(v * ratio);
      }

      // 向攻击方村庄登记战死即时回收（combat 只传原始损失，population 按医院等级换算回收比例）
      if (!contrib.npcService && Object.keys(attackerLossesForVillage).length > 0) {
        void this.commands.send({
          name: 'population.RecoverCasualties',
          from: CombatModule.NAME,
          payload: { villageId: contrib.fromVillage, losses: attackerLossesForVillage },
        });
      }

      // 清野营掉落宝物：命中的村庄按概率抽宝物，生成「待领取」记录（不直接入栏），
      // 经 treasure.PendingDropped 进战报，玩家需确认领取，超时自动遗弃。
      // 任务营地（isTaskCamp）或不可重生 NPC 村庄（isNoRespawn，如幸福村）清空不触发普通掉落，奖励由任务模块另行发放。
      if (!contrib.npcService && campCleared && attackerWins && !isTaskCamp && !isNoRespawn) {
        void this.commands.send({
          name: 'treasure.RollDrop', from: CombatModule.NAME,
          payload: { villageId: contrib.fromVillage, source: 'camp', movementId: contrib.movementId },
        });
      }

      const defenderLossesAttributed: Record<string, number> = {};
      for (const [code, lost] of Object.entries(remainingDefenderLosses)) {
        const allocated = index === contributionEntries.length - 1
          ? lost
          : Math.min(lost, Math.floor(lost * (contributionSize.get(cid) ?? 0) / Math.max(1, totalContributionSize)));
        if (allocated > 0) {
          defenderLossesAttributed[code] = allocated;
          remainingDefenderLosses[code] = lost - allocated;
        }
      }

      await this.bus.emit({
        name: 'combat.BattleEnded', source: CombatModule.NAME, ts: this.now(),
        payload: {
          villageId: contrib.fromVillage, side: 'attacker', battleId: b.id,
          movementId: contrib.movementId, fromVillage: contrib.fromVillage,
          fromXY: contrib.fromXY, toXY: b.targetXY,
          survivors, loot: share, looted: share, treasures: contrib.treasures, deployedTroops: contrib.troops, defenderLossesAttributed, npcService: !!contrib.npcService, kingdomMercenary: !!contrib.kingdomMercenary, returnPveId: contrib.returnPveId, ...reportBase,
        },
      } as DomainEvent);
    }

    // 防守方玩家（村庄战）收一份战报 + 登记战死即时回收
    if (b.targetKind === 'village') {
      if (Object.keys(defenderLossesByMovement).length > 0) {
        const temp = await this.commands.send({
          name: 'movement.ApplyReinforcementLosses', from: CombatModule.NAME,
          payload: { villageId: b.targetId, lossesByMovement: defenderLossesByMovement },
        });
        const lossesByVillage = ((temp.payload as any)?.lossesByVillage ?? {}) as Record<string, Record<string, number>>;
        for (const [sourceVillage, losses] of Object.entries(lossesByVillage)) {
          if (Object.keys(losses).length === 0) continue;
          void this.commands.send({ name: 'population.RecoverCasualties', from: CombatModule.NAME, payload: { villageId: sourceVillage, losses } });
        }
      }
      if (Object.keys(residentDefenderLosses).length > 0) {
        void this.commands.send({
          name: 'population.RecoverCasualties',
          from: CombatModule.NAME,
          payload: { villageId: b.targetId, losses: residentDefenderLosses },
        });
      }
      await this.bus.emit({
        name: 'combat.BattleEnded', source: CombatModule.NAME, ts: this.now(),
        payload: { villageId: b.targetId, side: 'defender', battleId: b.id, looted, ...reportBase },
      } as DomainEvent);
    }

    this.store.delete(COLLECTION, b.id);
  }

  /** 野战结算：双方同等对待，各自处理伤亡回收，然后发 BattleEnded（targetKind:'field'）给双方。 */
  private async finishField(b: Battle, attackerLosses: Record<string, number>, defenderLosses: Record<string, number>, attackerWins: boolean): Promise<void> {
    const reportBase = {
      attackPower: Math.round(b.attackPower0), defensePower: Math.round(b.defensePower0),
      attackerLosses, defenderLosses, targetKind: 'field' as const, targetId: b.targetId, battleType: b.battleType,
      battleLabel: b.battleType === 'ambush' ? '伏击' : undefined, campCleared: false,
      attackerLineup: b.initialAttacker,
      defenderLineup: b.initialDefender,
      totalRounds: b.rounds.length,
      rounds: sampleBattleRounds(b.rounds),
    };

    // 进攻方（各贡献村）幸存者 → BattleEnded(attacker)
    for (const [cid, contrib] of Object.entries(b.contributions)) {
      const survivors: Record<string, number> = {};
      const losses: Record<string, number> = {};
      for (const code of Object.keys(contrib.troops)) {
        const alive = b.attacker[`${cid}#${code}`]?.count ?? 0;
        const dead = contrib.troops[code] - alive;
        if (alive > 0) survivors[code] = alive;
        if (dead > 0) losses[code] = dead;
      }
      if (Object.keys(losses).length > 0) {
        void this.commands.send({ name: 'population.RecoverCasualties', from: CombatModule.NAME, payload: { villageId: contrib.fromVillage, losses } });
      }
      await this.bus.emit({
        name: 'combat.BattleEnded', source: CombatModule.NAME, ts: this.now(),
        payload: {
          villageId: contrib.fromVillage, side: 'attacker', battleId: b.id,
          movementId: contrib.movementId, fromVillage: contrib.fromVillage,
          fromXY: contrib.fromXY, toXY: b.targetXY,
          survivors, loot: {}, treasures: contrib.treasures, deployedTroops: contrib.troops,
          attackerWins, ...reportBase,
        },
      } as DomainEvent);
    }

    // 防守方（另一支行军）幸存者 → BattleEnded(defender)。
    // side 表示这支军队在本场战斗中的真实阵营，不能为了“己方视角”伪装成 attacker；
    // 否则客户端会把 attackerLosses（伏击方损失）误显示成被伏击方自己的损失。
    const dc = b.defenderContribution;
    if (dc) {
      const defSurvivors: Record<string, number> = {};
      const defLosses: Record<string, number> = {};
      for (const [code, orig] of Object.entries(dc.troops)) {
        const alive = orig - (defenderLosses[code] ?? 0);
        if (alive > 0) defSurvivors[code] = alive;
        if (defenderLosses[code]) defLosses[code] = defenderLosses[code]!;
      }
      if (Object.keys(defLosses).length > 0) {
        void this.commands.send({ name: 'population.RecoverCasualties', from: CombatModule.NAME, payload: { villageId: dc.fromVillage, losses: defLosses } });
      }
      await this.bus.emit({
        name: 'combat.BattleEnded', source: CombatModule.NAME, ts: this.now(),
        payload: {
          villageId: dc.fromVillage, side: 'defender', battleId: b.id,
          movementId: dc.movementId, fromVillage: dc.fromVillage,
          fromXY: dc.fromXY, toXY: b.targetXY,
          survivors: defSurvivors, loot: {}, treasures: dc.treasures, deployedTroops: dc.troops,
          attackerWins, ...reportBase,
        },
      } as DomainEvent);
    }
  }

  /** 给战场相关的双方各发一个事件（attacker 各贡献村 + defender 村/野战防守方村）。 */
  private emitToParties(b: Battle, name: string, make: (villageId: string, side: 'attacker' | 'defender') => Record<string, unknown>): void {
    const seen = new Set<string>();
    for (const contrib of Object.values(b.contributions)) {
      if (seen.has(contrib.fromVillage)) continue;
      seen.add(contrib.fromVillage);
      void this.bus.emit({ name, source: CombatModule.NAME, ts: this.now(), payload: make(contrib.fromVillage, 'attacker') } as DomainEvent);
    }
    if (b.targetKind === 'village') {
      void this.bus.emit({ name, source: CombatModule.NAME, ts: this.now(), payload: make(b.targetId, 'defender') } as DomainEvent);
    } else if (b.targetKind === 'field' && b.defenderContribution) {
      const v = b.defenderContribution.fromVillage;
      if (!seen.has(v)) {
        void this.bus.emit({ name, source: CombatModule.NAME, ts: this.now(), payload: make(v, 'defender') } as DomainEvent);
      }
    }
  }

  /** 客户端可读的战场快照（GetBattle 用）。 */
  private snapshotForClient(b: Battle) {
    return {
      battleId: b.id, targetKind: b.targetKind, targetId: b.targetId,
      battleType: b.battleType,
      attacker: aggregateCounts(b.attacker), defender: aggregateCounts(b.defender),
      attackPower: Math.round(b.attackPower0), defensePower: Math.round(b.defensePower0),
    };
  }
}

// ───────────────── 纯计算辅助（无状态，作用于快照） ─────────────────

/** 某特性效果在一个单位上的累计倍率（1 + Σvalue）。 */
function traitMult(u: CombatUnit, effect: TraitEffect): number {
  let m = 1;
  for (const t of u.traits ?? []) if (t.effect === effect) m += t.value;
  return m;
}

/** 该阵营是否还有存活的某形态兵。 */
function hasAliveForm(snap: Snapshot, form: 'melee' | 'ranged'): boolean {
  for (const u of Object.values(snap)) if (u.form === form && u.count > 0) return true;
  return false;
}

/** 阵营总兵力。 */
function totalCount(snap: Snapshot): number {
  let n = 0;
  for (const u of Object.values(snap)) n += u.count;
  return n;
}

/** 粗略总战力（战报展示用：count×(近攻+远攻)）。 */
function totalPower(snap: Snapshot): number {
  let p = 0;
  for (const u of Object.values(snap)) p += u.count * (u.meleeAtk + u.rangedAtk);
  return p;
}

/** 复制并放大攻击字段；防御、速度和运力不受伏击加成影响。 */
function applyAmbushBonus(unit: CombatUnit, bonus: number): CombatUnit {
  const mult = 1 + Math.max(0, Number(bonus) || 0);
  return { ...unit, meleeAtk: unit.meleeAtk * mult, rangedAtk: unit.rangedAtk * mult };
}

function applyAmbushSnapshot(snap: Snapshot, bonus: number): Snapshot {
  return Object.fromEntries(Object.entries(snap).map(([code, unit]) => [code, applyAmbushBonus(unit, bonus)]));
}

/** 只保留攻城武器（兵种表以 workshop 为训练建筑；代码命名兼容三族器械）。 */
function filterSiegeWeapons(snap: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [key, unit] of Object.entries(snap)) {
    const code = key.includes('#') ? key.slice(key.indexOf('#') + 1) : key;
    if (/ram|catapult|trebuchet/i.test(code)) out[key] = unit;
  }
  return out;
}

/** 去除攻城武器，供普通部队建筑破坏结算；攻城武器不能重复计入破坏战力。 */
function filterNonSiegeWeapons(snap: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [key, unit] of Object.entries(snap)) {
    const code = key.includes('#') ? key.slice(key.indexOf('#') + 1) : key;
    if (!/ram|catapult|trebuchet/i.test(code)) out[key] = unit;
  }
  return out;
}

function mergeResources(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) out[key] = (out[key] ?? 0) + n;
  }
  return out;
}

/** 从攻城战可掠夺存量中扣除保险库保护额；保护额不会形成负数库存。 */
export function subtractProtected(
  resources: Record<string, number>,
  protectedAmount: Record<string, number>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(resources)) {
    const available = Math.max(0, Number(value) || 0);
    const safe = Math.max(0, Number(protectedAmount[key]) || 0);
    out[key] = Math.max(0, available - safe);
  }
  return out;
}

const BASIC_LOOT_RESOURCES = ['wood', 'clay', 'iron', 'crop'] as const;

type LootPlan = {
  /** 从仓库/粮仓实际扣除的战利品。 */
  stored: Record<string, number>;
  /** 从被拆建筑收益中带回的战利品（建筑状态本身不扣资源）。 */
  building: Record<string, number>;
  /** 两种来源合计，供战报/返程使用。 */
  looted: Record<string, number>;
};

/**
 * 规划 PvP 战利品装载：金币优先，四种基础资源在各自来源内尽量平均。
 *
 * 仓储来源优先于建筑来源只针对四种基础资源；仓储不足时才用建筑拆除收益补齐。
 * 返回值中的 stored 只能传给 economy.TakeLoot，避免把建筑收益误扣到守方库存。
 */
export function planPvpLoot(
  storedAvailable: Record<string, number>,
  buildingLoot: Record<string, number>,
  carry: number,
): LootPlan {
  const stored: Record<string, number> = {};
  const building: Record<string, number> = {};
  let remaining = Math.max(0, Math.floor(Number(carry) || 0));

  // 金币无仓储上限，但仍占用部队的单位运力；仓库金币优先于建筑拆除所得金币。
  const storedGold = positiveInt(storedAvailable.gold);
  const storedGoldTake = Math.min(storedGold, remaining);
  if (storedGoldTake > 0) stored.gold = storedGoldTake;
  remaining -= storedGoldTake;

  const buildingGold = positiveInt(buildingLoot.gold);
  const buildingGoldTake = Math.min(buildingGold, remaining);
  if (buildingGoldTake > 0) building.gold = buildingGoldTake;
  remaining -= buildingGoldTake;

  // 四种资源先平均取仓储战利品，再用剩余运力平均取建筑拆除收益。
  const storedBasic = allocateAverage(storedAvailable, remaining);
  mergeInto(stored, storedBasic);
  remaining -= sumResources(storedBasic);

  const buildingBasic = allocateAverage(buildingLoot, remaining);
  mergeInto(building, buildingBasic);

  return {
    stored,
    building,
    looted: mergeResources(building, stored),
  };
}

function positiveInt(value: unknown): number {
  const n = Math.floor(Number(value) || 0);
  return Math.max(0, n);
}

/** 在给定来源中按四种资源尽量等量分配有限运力，短缺资源会让位给其他资源。 */
function allocateAverage(source: Record<string, number>, carry: number): Record<string, number> {
  const available: Record<string, number> = {};
  for (const key of BASIC_LOOT_RESOURCES) available[key] = positiveInt(source[key]);
  const out: Record<string, number> = {};
  let remaining = Math.max(0, Math.floor(Number(carry) || 0));

  while (remaining > 0) {
    const active = BASIC_LOOT_RESOURCES.filter((key) => (available[key] ?? 0) > (out[key] ?? 0));
    if (active.length === 0) break;
    const share = Math.floor(remaining / active.length);
    if (share <= 0) {
      // 不足一轮时逐个补齐，结果仍保持四种资源数量差不超过 1（受库存短缺约束）。
      for (const key of active) {
        if (remaining <= 0) break;
        if ((out[key] ?? 0) < (available[key] ?? 0)) {
          out[key] = (out[key] ?? 0) + 1;
          remaining -= 1;
        }
      }
      continue;
    }
    for (const key of active) {
      if (remaining <= 0) break;
      const room = (available[key] ?? 0) - (out[key] ?? 0);
      const take = Math.min(room, share);
      if (take > 0) {
        out[key] = (out[key] ?? 0) + take;
        remaining -= take;
      }
    }
  }
  return out;
}

function mergeInto(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function sumResources(resources: Record<string, number>): number {
  return Object.values(resources).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
}

function scaleResources(resources: Record<string, number>, ratio: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(resources)) {
    const n = Math.floor(Math.max(0, Number(value) || 0) * Math.max(0, ratio));
    if (n > 0) out[key] = n;
  }
  return out;
}

/** 按 code 聚合数量（去掉贡献命名空间前缀），用于推送/展示。 */
function aggregateCounts(snap: Snapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, u] of Object.entries(snap)) {
    if (u.count <= 0) continue;
    const code = key.includes('#') ? key.slice(key.indexOf('#') + 1) : key;
    out[code] = (out[code] ?? 0) + u.count;
  }
  return out;
}

/** 把一支增援部队的兵种数量并入战报阵容。 */
function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [code, count] of Object.entries(source)) target[code] = (target[code] ?? 0) + count;
}

/**
 * 战斗运算仍保留完整逐轮状态直到结算，但对外战报只发送固定数量的均匀采样。
 * 首尾轮始终保留；totalRounds 由调用方单独下发，客户端可明确标注这是关键轮次回放。
 */
function sampleBattleRounds<T>(rounds: T[]): T[] {
  if (rounds.length <= MAX_REPLAY_ROUNDS) return rounds;
  const sampled: T[] = [];
  let previous = -1;
  for (let i = 0; i < MAX_REPLAY_ROUNDS; i++) {
    const index = Math.round((i * (rounds.length - 1)) / (MAX_REPLAY_ROUNDS - 1));
    if (index !== previous) sampled.push(rounds[index]);
    previous = index;
  }
  return sampled;
}

/** 计算一轮中各兵种实际减少的数量（只记录正数）。 */
function countDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const lost = (before[code] ?? 0) - (after[code] ?? 0);
    if (lost > 0) out[code] = lost;
  }
  return out;
}

/**
 * A 阵营这一 tick 对 B 阵营造成的击杀数（§4.3 攻击力选择 + §4.4 承伤公式）。
 * defWallMult：防守方城墙倍率（>1 表示更耐打），只在 B 是防守方时>1。
 */
function computeKills(A: Snapshot, B: Snapshot, k: number, dt: number, defWallMult: number): number {
  const aMelee = hasAliveForm(A, 'melee');
  const bMelee = hasAliveForm(B, 'melee');

  let meleeDmg = 0;
  let rangedDmg = 0;
  for (const u of Object.values(A)) {
    if (u.count <= 0) continue;
    if (u.form === 'melee') {
      meleeDmg += u.count * u.meleeAtk * traitMult(u, 'atk_melee');
    } else {
      // 远程兵：己方近战在→放后排(rangedAtk)；己方近战没了但敌方近战在→被迫肉搏(meleeAtk)；都没近战→对射(rangedAtk)
      if (aMelee || !bMelee) rangedDmg += u.count * u.rangedAtk * traitMult(u, 'atk_ranged');
      else meleeDmg += u.count * u.meleeAtk * traitMult(u, 'atk_melee');
    }
  }
  if (meleeDmg <= 0 && rangedDmg <= 0) return 0;

  // B 的当前承伤排：前排(melee)还活着就打前排，否则打后排(ranged)
  const targetForm: 'melee' | 'ranged' = bMelee ? 'melee' : 'ranged';
  let rowCount = 0;
  let effMeleeHP = 0; // 该排对近战的等效耐久
  let effRangedHP = 0; // 该排对远程的等效耐久
  const priority = Object.values(B).some((u) => u.ambushPriority && u.count > 0);
  for (const u of Object.values(B)) {
    if (u.form !== targetForm || u.count <= 0 || (priority && !u.ambushPriority)) continue;
    rowCount += u.count;
    effMeleeHP += u.count * u.meleeDef * traitMult(u, 'def_melee') / Math.max(0.05, traitMult(u, 'dmg_taken_melee'));
    effRangedHP += u.count * u.rangedDef * traitMult(u, 'def_ranged') / Math.max(0.05, traitMult(u, 'dmg_taken_ranged'));
  }
  if (rowCount <= 0) return 0;

  const mDefAvg = Math.max(0.5, (effMeleeHP / rowCount) * defWallMult);
  const rDefAvg = Math.max(0.5, (effRangedHP / rowCount) * defWallMult);

  return k * dt * (meleeDmg / mDefAvg + rangedDmg / rDefAvg);
}

/**
 * 把 killsFloat 击杀数摊到承伤排各兵种上并扣减，返回剩余的分数击杀(<1，留到下tick)。
 * 承伤排=前排(melee)若还有活兵，否则后排(ranged)。
 */
function applyKills(snap: Snapshot, killsFloat: number): number {
  const n = Math.floor(killsFloat);
  const frac = killsFloat - n;
  if (n <= 0) return killsFloat;

  const targetForm: 'melee' | 'ranged' = hasAliveForm(snap, 'melee') ? 'melee' : 'ranged';
  const priority = Object.values(snap).some((u) => u.ambushPriority && u.count > 0);
  const row = Object.entries(snap).filter(([, u]) => u.form === targetForm && u.count > 0 && (!priority || u.ambushPriority));
  const rowCount = row.reduce((a, [, u]) => a + u.count, 0);
  if (rowCount <= 0) return frac;

  // 击杀数 >= 整排 → 整排清空
  if (n >= rowCount) {
    for (const [, u] of row) u.count = 0;
    pruneZero(snap);
    return frac;
  }

  // 按数量比例分配，最大余数法保证正好击杀 n 个
  const alloc = row.map(([key, u]) => {
    const exact = (n * u.count) / rowCount;
    return { key, u, base: Math.floor(exact), rem: exact - Math.floor(exact) };
  });
  let assigned = alloc.reduce((a, x) => a + x.base, 0);
  alloc.sort((x, y) => y.rem - x.rem);
  let i = 0;
  while (assigned < n) {
    const a = alloc[i % alloc.length];
    if (a.base < a.u.count) { a.base += 1; assigned += 1; }
    i += 1;
    if (i > alloc.length * 3) break; // 兜底防呆
  }
  for (const a of alloc) a.u.count = Math.max(0, a.u.count - a.base);
  pruneZero(snap);
  return frac;
}

/** 移除数量归零的条目。 */
function pruneZero(snap: Snapshot): void {
  for (const [key, u] of Object.entries(snap)) if (u.count <= 0) delete snap[key];
}

/** 日志用：快照摘要，列出每兵种数量+关键战斗属性+特性名。 */
function snapshotSummary(snap: Snapshot): Record<string, unknown>[] {
  return Object.entries(snap).map(([key, u]) => ({
    code: key.includes('#') ? key.slice(key.indexOf('#') + 1) : key,
    count: u.count, form: u.form,
    meleeAtk: u.meleeAtk, rangedAtk: u.rangedAtk,
    meleeDef: u.meleeDef, rangedDef: u.rangedDef,
    carry: u.carry,
    traits: u.traits?.map((t) => `${t.effect}:${t.value}`) ?? [],
  }));
}

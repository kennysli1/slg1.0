import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import type { Snapshot } from '../infra/combat-types.js';
import { normalizeTotalAdSnapshot, TOTAL_AD_RULESET_VERSION } from '../infra/total-ad-combat.js';
import { makeLogger } from '../infra/logger.js';
// eslint-disable-next-line no-restricted-imports -- combat/** 是同一 combat owner 的内部边界；架构测试按 owner 归并校验。
import type { Battle, Contribution, DefenderContribution } from './combat/types.js';
// eslint-disable-next-line no-restricted-imports -- combat/** 是同一 combat owner 的纯计算层。
import {
  aggregateCounts,
  countDelta,
  filterNonSiegeWeapons,
  filterSiegeWeapons,
  sampleBattleRounds,
  simulateCombatTick,
  totalCount,
  totalPower,
} from './combat/engine.js';
// eslint-disable-next-line no-restricted-imports -- combat/** 是同一 combat owner 的结算辅助层。
import { mergeResources, planPvpLoot, scaleResources, subtractProtected } from './combat/loot.js';
// eslint-disable-next-line no-restricted-imports -- combat/** 是同一 combat owner 的结算规划层。
import { buildSettlementPlan } from './combat/resolution.js';

export { planPvpLoot, subtractProtected };

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
 *  - 每回合仅按总攻击、总防御和 hp 计算；伤害按回合初始人数比例分摊。
 *  - 双方同时结算，任一方归零立即结束；不设回合上限。
 *
 * 本轮范围：PvE/PvP 单场 + 攻击方并入（一地一场战）+ 每 tick 实时快照推送。
 * 暂缓：协防 reinforce、PvE 多人合战分战利品（见 08 文档§七）。
 */

const COLLECTION = 'battle';

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
    for (const raw of this.store.all<Battle>(COLLECTION)) {
      const b = this.load(raw.id);
      if (!b) continue;
      if (b.status === 'active') {
        this.scheduler.schedule(this.tickMs(), () => this.tick(b.id), `combat:${b.id}`, `battle:${b.id}`);
      } else if (b.status === 'resolving') {
        this.scheduler.schedule(0, () => this.resumeResolution(b.id), `combat:${b.id}`, `battle:${b.id}`);
      }
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

  /** 找到目标上的进行中战场；按 targetKind+targetId 隔离 PvE、村庄和野战。 */
  private findActive(targetId: string, targetKind?: Battle['targetKind']): Battle | undefined {
    const battle = this.store.all<Battle>(COLLECTION).find((b) => b.targetId === targetId && (!targetKind || b.targetKind === targetKind) && b.status === 'active');
    if (battle) this.ensureBattleLog(battle);
    return battle;
  }

  private battleKey(targetKind: Battle['targetKind'], targetId: string): string {
    return `${targetKind}:${targetId}`;
  }

  /** 兼容上线前已落盘的进行中战斗，首次访问时补齐战报回放字段。 */
  private ensureBattleLog(b: Battle): void {
    b.initialAttacker ??= aggregateCounts(b.attacker);
    b.initialDefender ??= aggregateCounts(b.defender);
    b.rounds ??= [];
    // 新增字段均为可选兼容字段，旧战斗在第一次访问时惰性初始化。
    if (b.status === 'ended') b.status = 'resolving';
  }

  // ---- Commands ----

  private getBattle(cmd: Command): CommandResult {
    const { targetId, targetKind, villageId } = cmd.payload as { targetId: string; targetKind?: Battle['targetKind']; villageId?: string };
    const b = this.findActive(targetId, targetKind);
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
    const battleKey = this.battleKey(p.targetKind, p.targetId);
    const existing = this.findActive(p.targetId, p.targetKind);
    if (existing) {
      // 并入已有战场的 attacker 阵营（下一 tick 生效）
      existing.contributions[contribId] = {
        movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops }, treasures: [...treasures], npcService: !!p.npcService, kingdomMercenary: !!p.kingdomMercenary, returnPveId: p.returnPveId,
      };
      for (const [code, u] of Object.entries(p.attackerSnapshot)) {
        existing.attacker[`${contribId}#${code}`] = { ...u };
      }
      existing.attackPower0 += totalPower(p.attackerSnapshot);
      mergeCounts(existing.initialAttacker, aggregateCounts(p.attackerSnapshot));
      this.store.set(COLLECTION, existing.id, existing);
      log('援军并入', { battleId: existing.id, from: p.fromVillage, troops: p.troops, newAtkPower: Math.round(existing.attackPower0) });
      return { ok: true, payload: { battleId: existing.id, merged: true } };
    }

    // 同步预占：标记该 targetId 正在被新建流程占用
    // 若已有其他并发 Engage 在预占中，直接返回等它完成后再并入
    if (this.claiming.has(battleKey)) {
      // 短路等待：再做一次 findActive（此时另一个 engage 可能已写入 store）
      // 若仍未就绪（极罕见的 ABA 场景），保守地返回 merged=false 让调用方重试
      const raceCheck = this.findActive(p.targetId, p.targetKind);
      if (raceCheck) {
        raceCheck.contributions[contribId] = {
          movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops }, treasures: [...treasures], npcService: !!p.npcService, kingdomMercenary: !!p.kingdomMercenary, returnPveId: p.returnPveId,
        };
        for (const [code, u] of Object.entries(p.attackerSnapshot)) {
          raceCheck.attacker[`${contribId}#${code}`] = { ...u };
        }
        raceCheck.attackPower0 += totalPower(p.attackerSnapshot);
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
      for (const [code, u] of Object.entries(p.attackerSnapshot)) attacker[`${contribId}#${code}`] = { ...u };

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
        attackerDamageCarry: {}, defenderDamageCarry: {}, rulesetVersion: TOTAL_AD_RULESET_VERSION,
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

    this.claiming.add(battleKey);

    let fetchedDefender: { defender: Snapshot; wallLevel: number; defenderContributions?: Record<string, DefenderContribution> } | null = null;
    try {
      fetchedDefender = await this.fetchDefender(p.targetKind, p.targetId, p.battleType);
    } finally {
      this.claiming.delete(battleKey);
    }

    // 二次安全检查：fetchDefender 是 async，并发 Engage 可能在此期间已创建战场
    const raceExisting = this.findActive(p.targetId, p.targetKind);
    if (raceExisting) {
      // 安全并入
      raceExisting.contributions[contribId] = {
        movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops }, treasures: [...treasures], npcService: !!p.npcService, kingdomMercenary: !!p.kingdomMercenary, returnPveId: p.returnPveId,
      };
      for (const [code, u] of Object.entries(p.attackerSnapshot)) {
        raceExisting.attacker[`${contribId}#${code}`] = { ...u };
      }
      raceExisting.attackPower0 += totalPower(p.attackerSnapshot);
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
      attackerDamageCarry: {},
      defenderDamageCarry: {},
      rulesetVersion: TOTAL_AD_RULESET_VERSION,
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
    // 存量战场没有 rulesetVersion 或仍是旧四维快照时，在首个未结算回合安全迁移。
    if (b.rulesetVersion !== TOTAL_AD_RULESET_VERSION) {
      b.attacker = normalizeTotalAdSnapshot(b.attacker as any);
      b.defender = normalizeTotalAdSnapshot(b.defender as any);
      b.attackerDamageCarry = {};
      b.defenderDamageCarry = {};
      b.rulesetVersion = TOTAL_AD_RULESET_VERSION;
    }
    b.ticks += 1;
    const result = simulateCombatTick({
      attacker: b.attacker,
      defender: b.defender,
      attackerDamageCarry: b.attackerDamageCarry,
      defenderDamageCarry: b.defenderDamageCarry,
    });
    b.attacker = result.attacker;
    b.defender = result.defender;
    b.attackerDamageCarry = result.attackerDamageCarry;
    b.defenderDamageCarry = result.defenderDamageCarry;

    const atkAlive = totalCount(b.attacker);
    const defAlive = totalCount(b.defender);

    const attackerAfter = result.attackerAfter;
    const defenderAfter = result.defenderAfter;
    b.rounds.push({
      round: b.ticks,
      attackerLosses: countDelta(result.attackerBefore, attackerAfter),
      defenderLosses: countDelta(result.defenderBefore, defenderAfter),
      attacker: attackerAfter,
      defender: defenderAfter,
      attackerTotalAttack: result.attackerTotalAttack,
      attackerTotalDefense: result.attackerTotalDefense,
      defenderTotalAttack: result.defenderTotalAttack,
      defenderTotalDefense: result.defenderTotalDefense,
      damageToAttacker: result.damageToAttacker,
      damageToDefender: result.damageToDefender,
    });

    // 每10 tick 记录一次兵力变化（避免刷屏）
    if (b.ticks % 10 === 0) {
      log(`round#${b.ticks}`, { battleId: id, atkAlive, defAlive, damageToDef: Math.round(result.damageToDefender * 100) / 100, damageToAtk: Math.round(result.damageToAttacker * 100) / 100 });
    }

    if (atkAlive <= 0 || defAlive <= 0) {
      await this.beginResolution(b);
      return;
    }

    this.store.set(COLLECTION, id, b);

    // 每若干 tick 推一次实时快照（约每 500ms 一次，避免刷屏；可调参）
    const pushEvery = Math.max(1, Math.round(500 / this.tickMs()));
    if (b.ticks % pushEvery === 0) {
      this.emitToParties(b, 'combat.BattleTick', (villageId, side) => ({
        villageId, side, battleId: id,
        attacker: attackerAfter, defender: defenderAfter,
        attackerLosses: b.rounds[b.rounds.length - 1]!.attackerLosses,
        defenderLosses: b.rounds[b.rounds.length - 1]!.defenderLosses,
        attackerTotalAttack: result.attackerTotalAttack,
        attackerTotalDefense: result.attackerTotalDefense,
        defenderTotalAttack: result.defenderTotalAttack,
        defenderTotalDefense: result.defenderTotalDefense,
        damageToAttacker: result.damageToAttacker,
        damageToDefender: result.damageToDefender,
        round: b.ticks,
      }));
    }

    this.scheduler.schedule(this.tickMs(), () => this.tick(id), `combat:${id}`, `battle:${id}`);
  }

  /** 进入可恢复结算状态；结算失败时保留 battle 记录，重启后由 resume() 继续。 */
  private async beginResolution(b: Battle): Promise<void> {
    if (b.status !== 'active') return;
    b.status = 'resolving';
    b.resolution ??= { id: `${b.id}:${b.startedAt}`, step: 'apply_domain', startedAt: this.now() };
    this.store.set(COLLECTION, b.id, b);
    await this.finish(b);
  }

  private async resumeResolution(id: string): Promise<void> {
    const battle = this.load(id);
    if (!battle || battle.status !== 'resolving') return;
    await this.finish(battle);
  }

  /** 结算：算损失/幸存/战利品 → 发 Command 让 owner 改状态 → 发 Event 出战报与返程信息。 */
  private async finish(b: Battle): Promise<void> {
    b.status = 'resolving';
    b.resolution ??= { id: `${b.id}:${b.startedAt}`, step: 'apply_domain', startedAt: this.now() };
    this.store.set(COLLECTION, b.id, b);

    const settlementPlan = buildSettlementPlan(b);
    const defAlive = totalCount(b.defender);
    const attackerWins = b.resolution.attackerWins ?? settlementPlan.attackerWins;
    b.resolution.attackerWins = attackerWins;

    // 防守方实际损失（原始 - 现存）。内部快照按来源命名空间，
    // 同时生成按兵种聚合的战报数据和按来源扣兵数据。
    const { attackerLosses, defenderLosses, defenderLossesByMovement, residentDefenderLosses, totalCarry } = settlementPlan;

    log('战斗结束', { battleId: b.id, ticks: b.ticks, attackerWins, atkAlive: totalCount(b.attacker), defAlive, attackerLosses, defenderLosses, totalCarry });

    // 野战（field）分支：跳过 pve/pvp 逻辑，双方各自处理伤亡
    if (b.targetKind === 'field') {
      await this.finishField(b, attackerLosses, defenderLosses, attackerWins);
      this.store.delete(COLLECTION, b.id);
      return;
    }

    // 应用防守方损失 + 取战利品。完成后先持久化域状态结果，
    // 后续战报/返程失败时可以从同一份结算快照继续，不会重新规划战利品。
    let looted: Record<string, number> = {};
    let storedLoot: Record<string, number> = {};
    let buildingLoot: Record<string, number> = {};
    let buildingDamage: unknown[] = [];
    let campCleared = false;
    let isTaskCamp = false;
    let isNoRespawn = false;
    const shouldApplyDomain = b.resolution.step === 'apply_domain';
    if (shouldApplyDomain && b.targetKind === 'pve') {
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
    } else if (shouldApplyDomain) {
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

    if (!shouldApplyDomain) {
      looted = b.resolution.looted ?? {};
      storedLoot = b.resolution.storedLoot ?? {};
      buildingLoot = b.resolution.buildingLoot ?? {};
      buildingDamage = b.resolution.buildingDamage ?? [];
      campCleared = !!b.resolution.campCleared;
      isTaskCamp = !!b.resolution.isTaskCamp;
      isNoRespawn = !!b.resolution.isNoRespawn;
    } else {
      b.resolution.looted = looted;
      b.resolution.storedLoot = storedLoot;
      b.resolution.buildingLoot = buildingLoot;
      b.resolution.buildingDamage = buildingDamage;
      b.resolution.campCleared = campCleared;
      b.resolution.isTaskCamp = isTaskCamp;
      b.resolution.isNoRespawn = isNoRespawn;
      b.resolution.attackerLosses = attackerLosses;
      b.resolution.defenderLosses = defenderLosses;
      b.resolution.step = 'emit_attacker_reports';
      b.resolution.attackerReportIndex ??= 0;
      this.store.set(COLLECTION, b.id, b);
    }

    const totalLootCarry = totalCarry || 1;
    const reportBase = {
      attackerWins,
      resolutionId: b.resolution.id,
      phase: 'resolved' as const,
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
    const attackerReportStart = b.resolution.attackerReportIndex ?? 0;
    for (const [index, [cid, contrib]] of contributionEntries.entries()) {
      if (index < attackerReportStart) continue;
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
      b.resolution.attackerReportIndex = index + 1;
      this.store.set(COLLECTION, b.id, b);
    }

    b.resolution.step = 'emit_defender_report';
    this.store.set(COLLECTION, b.id, b);

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
      resolutionId: b.resolution?.id,
      phase: 'resolved' as const,
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

/** 把一支增援部队的兵种数量并入战报阵容。 */
function mergeCounts(target: Record<string, number>, source: Record<string, number>): void {
  for (const [code, count] of Object.entries(source)) target[code] = (target[code] ?? 0) + count;
}

  /** 日志用：快照摘要，列出每兵种数量+关键战斗属性+特性名。 */
function snapshotSummary(snap: Snapshot): Record<string, unknown>[] {
  return Object.entries(snap).map(([key, u]) => ({
    code: key.includes('#') ? key.slice(key.indexOf('#') + 1) : key,
    count: u.count, popCost: u.popCost,
    attack: u.attack, defense: u.defense, hp: u.hp,
    carry: u.carry,
  }));
}

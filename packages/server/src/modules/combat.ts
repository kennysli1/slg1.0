import type { Command, CommandResult, DomainEvent } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { Scheduler } from '../infra/scheduler.js';
import type { GameConfig } from '../infra/config.js';
import type { ModuleManifest } from '../gateway/manifest.js';
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
}

interface Battle {
  id: string;
  targetKind: 'village' | 'pve';
  targetId: string; // 防守方村 id 或 PvE 目标 id
  targetXY: { q: number; r: number }; // 六边形轴坐标（不透明透传）
  wallLevel: number;
  /** 进攻方：key = `${movementId}#${code}`（多支来攻并入时按贡献命名空间隔离，各自 smithy 数值不同）。 */
  attacker: Snapshot;
  /** 防守方：key = code（单一来源：驻军或 PvE 守军）。 */
  defender: Snapshot;
  /** 防守方开战时各兵种原始数量（结束时算实际损失，交回 owner 扣兵）。 */
  defenderOriginal: Record<string, number>;
  contributions: Record<string, Contribution>; // movementId -> 贡献
  /** 分数击杀累加（不足1个的伤害留到下tick，保证战斗必然推进）。 */
  attackerPending: number;
  defenderPending: number;
  attackPower0: number; // 开战时总攻(战报展示)
  defensePower0: number;
  startedAt: number;
  ticks: number;
  status: 'active' | 'ended';
}

const COLLECTION = 'battle';
const MAX_TICKS = 20000; // 安全阀：极端情况下(双方都0攻)兜底结束，避免无限循环

export class CombatModule {
  static readonly NAME = 'combat';

  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'combat',
    publicActions: {
      GetBattle: { command: 'combat.GetBattle', needAuth: true },
    },
    eventPushMap: {
      'combat.BattleStarted': 'BattleStarted',
      'combat.BattleTick': 'BattleTick',
      'combat.BattleEnded': 'BattleEnded',
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

  init(): void {
    this.commands.register('combat.Engage', (c) => this.engage(c)); // 内部：Movement 到达时调用
    this.commands.register('combat.GetBattle', (c) => this.getBattle(c));
  }

  /** 重启恢复：为所有进行中的战场重新登记下一 tick。 */
  resume(): void {
    for (const b of this.store.all<Battle>(COLLECTION)) {
      if (b.status === 'active') this.scheduler.schedule(this.tickMs(), () => this.tick(b.id));
    }
  }

  private tickMs(): number {
    return this.config.constants.combatTickMs;
  }

  private load(id: string): Battle | undefined {
    return this.store.get<Battle>(COLLECTION, id);
  }

  private nextId(): string {
    const n = (this.store.get<number>('battle_seq', 'n') ?? 0) + 1;
    this.store.set('battle_seq', 'n', n);
    return `bt-${n}`;
  }

  /** 找到目标格上进行中的战场（一地一场战）。 */
  private findActive(targetId: string): Battle | undefined {
    return this.store.all<Battle>(COLLECTION).find((b) => b.targetId === targetId && b.status === 'active');
  }

  // ---- Commands ----

  private getBattle(cmd: Command): CommandResult {
    const { targetId } = cmd.payload as { targetId: string };
    const b = this.findActive(targetId);
    if (!b) return { ok: true, payload: { battle: null } };
    return { ok: true, payload: { battle: this.snapshotForClient(b) } };
  }

  /**
   * 开战 / 并入。Movement 到达目标时发来：来攻方兵力快照(已含 smithy 加成) + 归属信息。
   * 已有战场 → 并入 attacker 阵营；否则新开一场并拉取防守方快照。
   */
  private async engage(cmd: Command): Promise<CommandResult> {
    const p = cmd.payload as {
      targetKind: 'village' | 'pve';
      targetId: string;
      targetXY: { q: number; r: number };
      movementId: string;
      fromVillage: string;
      fromXY: { q: number; r: number };
      troops: Record<string, number>;
      attackerSnapshot: Snapshot;
    };

    const contribId = p.movementId;
    const existing = this.findActive(p.targetId);
    if (existing) {
      // 并入已有战场的 attacker 阵营（下一 tick 生效）
      existing.contributions[contribId] = {
        movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops },
      };
      for (const [code, u] of Object.entries(p.attackerSnapshot)) {
        existing.attacker[`${contribId}#${code}`] = { ...u };
      }
      existing.attackPower0 += totalPower(p.attackerSnapshot);
      this.store.set(COLLECTION, existing.id, existing);
      log('援军并入', { battleId: existing.id, from: p.fromVillage, troops: p.troops, newAtkPower: Math.round(existing.attackPower0) });
      return { ok: true, payload: { battleId: existing.id, merged: true } };
    }

    // 新开一场：拉防守方快照
    const { defender, wallLevel } = await this.fetchDefender(p.targetKind, p.targetId);

    const attacker: Snapshot = {};
    for (const [code, u] of Object.entries(p.attackerSnapshot)) attacker[`${contribId}#${code}`] = { ...u };

    const defenderOriginal: Record<string, number> = {};
    for (const [code, u] of Object.entries(defender)) defenderOriginal[code] = u.count;

    const id = this.nextId();
    const battle: Battle = {
      id,
      targetKind: p.targetKind,
      targetId: p.targetId,
      targetXY: p.targetXY,
      wallLevel,
      attacker,
      defender,
      defenderOriginal,
      contributions: { [contribId]: { movementId: p.movementId, fromVillage: p.fromVillage, fromXY: p.fromXY, troops: { ...p.troops } } },
      attackerPending: 0,
      defenderPending: 0,
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
    }));

    this.scheduler.schedule(this.tickMs(), () => this.tick(id));
    return { ok: true, payload: { battleId: id, merged: false } };
  }

  /** 拉取防守方快照 + 城墙等级。PvP 找 military+building；PvE 找 pve。 */
  private async fetchDefender(kind: 'village' | 'pve', targetId: string): Promise<{ defender: Snapshot; wallLevel: number }> {
    if (kind === 'pve') {
      const res = await this.commands.send({ name: 'pve.GetDefenderSnapshot', from: CombatModule.NAME, payload: { id: targetId } });
      return { defender: ((res.payload as any)?.snapshot ?? {}) as Snapshot, wallLevel: 0 };
    }
    const defRes = await this.commands.send({ name: 'military.GetCombatSnapshot', from: CombatModule.NAME, payload: { villageId: targetId } });
    const defender = ((defRes.payload as any)?.snapshot ?? {}) as Snapshot;
    const build = await this.commands.send({ name: 'building.GetDefenseSnapshot', from: CombatModule.NAME, payload: { villageId: targetId } });
    const wallLevel = (build.payload as any)?.wallLevel ?? 0;
    return { defender, wallLevel };
  }

  // ---- Tick 推进 ----

  private async tick(id: string): Promise<void> {
    const b = this.load(id);
    if (!b || b.status !== 'active') return;
    b.ticks += 1;

    const dt = this.tickMs() / 1000;
    const k = this.config.constants.combatStrength;
    const wallMult = 1 + b.wallLevel * this.config.constants.wallBonusPerLevel;

    // 双方同时用 tick 开始时的兵力互算（避免先手偏差）
    const killsToDef = computeKills(b.attacker, b.defender, k, dt, wallMult);
    const killsToAtk = computeKills(b.defender, b.attacker, k, dt, 1);

    b.defenderPending = applyKills(b.defender, killsToDef + b.defenderPending);
    b.attackerPending = applyKills(b.attacker, killsToAtk + b.attackerPending);

    const atkAlive = totalCount(b.attacker);
    const defAlive = totalCount(b.defender);

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
        attacker: aggregateCounts(b.attacker), defender: aggregateCounts(b.defender),
      }));
    }

    this.scheduler.schedule(this.tickMs(), () => this.tick(id));
  }

  /** 结算：算损失/幸存/战利品 → 发 Command 让 owner 改状态 → 发 Event 出战报与返程信息。 */
  private async finish(b: Battle): Promise<void> {
    b.status = 'ended';
    this.store.set(COLLECTION, b.id, b);

    const defAlive = totalCount(b.defender);
    const attackerWins = defAlive <= 0;

    // 防守方实际损失（原始 - 现存）
    const defenderLosses: Record<string, number> = {};
    for (const [code, orig] of Object.entries(b.defenderOriginal)) {
      const dead = orig - (b.defender[code]?.count ?? 0);
      if (dead > 0) defenderLosses[code] = dead;
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

    // 应用防守方损失 + 取战利品
    let looted: Record<string, number> = {};
    if (b.targetKind === 'pve') {
      const apply = await this.commands.send({
        name: 'pve.ApplyResult', from: CombatModule.NAME,
        payload: { id: b.targetId, defenderLosses, attackerWins, looterCarry: totalCarry },
      });
      looted = (apply.payload as any)?.looted ?? {};
    } else {
      // PvP：扣防守方兵力
      if (Object.keys(defenderLosses).length) {
        const delta: Record<string, number> = {};
        for (const [code, dead] of Object.entries(defenderLosses)) delta[code] = -dead;
        await this.commands.send({ name: 'military.AdjustTroops', from: CombatModule.NAME, payload: { villageId: b.targetId, delta } });
      }
      // 掠夺（攻方胜且有载货）
      if (attackerWins && totalCarry > 0) {
        const lootRes = await this.commands.send({ name: 'economy.GetLootable', from: CombatModule.NAME, payload: { villageId: b.targetId } });
        const lootable: Record<string, number> = (lootRes.payload as any)?.lootable ?? {};
        const total = Object.values(lootable).reduce((a, v) => a + v, 0);
        const want: Record<string, number> = {};
        if (total > 0) {
          const ratio = Math.min(1, totalCarry / total);
          for (const [t, v] of Object.entries(lootable)) want[t] = Math.floor(v * ratio);
        }
        log('PvP 掠夺前', { target: b.targetId, lootable, totalCarry, ratio: total > 0 ? Math.min(1, totalCarry / total).toFixed(3) : 0, want });
        const taken = await this.commands.send({ name: 'economy.TakeLoot', from: CombatModule.NAME, payload: { villageId: b.targetId, amount: want } });
        looted = (taken.payload as any)?.taken ?? {};
        log('PvP 掠夺后', { target: b.targetId, looted });
      }
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
    };

    // 每支来攻部队：算各自幸存兵力 + 按载货比例分战利品 → 发结束事件（Movement 据此返程）
    for (const [cid, contrib] of Object.entries(b.contributions)) {
      const survivors: Record<string, number> = {};
      let carry = 0;
      for (const code of Object.keys(contrib.troops)) {
        const u = b.attacker[`${cid}#${code}`];
        if (u && u.count > 0) {
          survivors[code] = u.count;
          carry += u.count * u.carry;
        }
      }
      const share: Record<string, number> = {};
      if (Object.keys(looted).length && carry > 0) {
        const ratio = carry / totalLootCarry;
        for (const [t, v] of Object.entries(looted)) share[t] = Math.floor(v * ratio);
      }
      void this.bus.emit({
        name: 'combat.BattleEnded', source: CombatModule.NAME, ts: this.now(),
        payload: {
          villageId: contrib.fromVillage, side: 'attacker', battleId: b.id,
          movementId: contrib.movementId, fromVillage: contrib.fromVillage,
          fromXY: contrib.fromXY, toXY: b.targetXY,
          survivors, loot: share, looted: share, ...reportBase,
        },
      } as DomainEvent);
    }

    // 防守方玩家（村庄战）收一份战报
    if (b.targetKind === 'village') {
      void this.bus.emit({
        name: 'combat.BattleEnded', source: CombatModule.NAME, ts: this.now(),
        payload: { villageId: b.targetId, side: 'defender', battleId: b.id, looted, ...reportBase },
      } as DomainEvent);
    }

    this.store.delete(COLLECTION, b.id);
  }

  /** 给战场相关的双方各发一个事件（attacker 各贡献村 + defender 村）。 */
  private emitToParties(b: Battle, name: string, make: (villageId: string, side: 'attacker' | 'defender') => Record<string, unknown>): void {
    const seen = new Set<string>();
    for (const contrib of Object.values(b.contributions)) {
      if (seen.has(contrib.fromVillage)) continue;
      seen.add(contrib.fromVillage);
      void this.bus.emit({ name, source: CombatModule.NAME, ts: this.now(), payload: make(contrib.fromVillage, 'attacker') } as DomainEvent);
    }
    if (b.targetKind === 'village') {
      void this.bus.emit({ name, source: CombatModule.NAME, ts: this.now(), payload: make(b.targetId, 'defender') } as DomainEvent);
    }
  }

  /** 客户端可读的战场快照（GetBattle 用）。 */
  private snapshotForClient(b: Battle) {
    return {
      battleId: b.id, targetKind: b.targetKind, targetId: b.targetId,
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
  for (const u of Object.values(B)) {
    if (u.form !== targetForm || u.count <= 0) continue;
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
  const row = Object.entries(snap).filter(([, u]) => u.form === targetForm && u.count > 0);
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

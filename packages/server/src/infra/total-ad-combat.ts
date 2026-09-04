import type { CombatPhase, CombatUnit, CombatRole, Snapshot, UnitTraitDef } from './combat-types.js';

/** 新创建战斗使用 v3；已落盘 v2 必须继续走旧回合函数。 */
export const TOTAL_AD_RULESET_VERSION = 3;
export const TOTAL_AD_V2_RULESET_VERSION = 2;
export interface DamageCarries { [snapshotKey: string]: number }

export interface TotalAdRoundResult {
  attacker: Snapshot;
  defender: Snapshot;
  attackerDamageCarry: DamageCarries;
  defenderDamageCarry: DamageCarries;
  attackerBefore: Record<string, number>;
  defenderBefore: Record<string, number>;
  attackerAfter: Record<string, number>;
  defenderAfter: Record<string, number>;
  damageToAttacker: number;
  damageToDefender: number;
  attackerTotalAttack: number;
  attackerTotalDefense: number;
  defenderTotalAttack: number;
  defenderTotalDefense: number;
}

function unitCode(key: string): string {
  const hash = key.indexOf('#');
  return hash >= 0 ? key.slice(hash + 1) : key;
}

function nonNegative(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 深复制并把旧四维战斗快照安全收敛为三维快照。 */
export function normalizeTotalAdSnapshot(snapshot: Snapshot | Record<string, any>): Snapshot {
  const out: Snapshot = {};
  for (const [key, raw] of Object.entries(snapshot ?? {})) {
    const legacy = raw as any;
    const count = Math.max(0, Math.floor(Number(legacy.count) || 0));
    if (count <= 0) continue;
    out[key] = {
      count,
      // 所有可参战兵种必须具备双位数最小攻击，避免零攻对零攻无限战斗。
      attack: Math.max(10, nonNegative(legacy.attack) || Math.max(nonNegative(legacy.meleeAtk), nonNegative(legacy.rangedAtk))),
      defense: nonNegative(legacy.defense) || Math.max(nonNegative(legacy.meleeDef), nonNegative(legacy.rangedDef)),
      hp: Math.max(1, nonNegative(legacy.hp) || 1),
      carry: Math.max(0, Number(legacy.carry) || 0),
      form: legacy.form === 'ranged' ? 'ranged' : 'melee',
      role: normalizeRole(legacy.role, legacy.isCavalry),
      traits: Array.isArray(legacy.traits) ? structuredClone(legacy.traits) as UnitTraitDef[] : [],
      ...(legacy.popCost === undefined ? {} : { popCost: Math.max(0, Number(legacy.popCost) || 0) }),
    };
  }
  return out;
}

function normalizeRole(raw: unknown, isCavalry: unknown): CombatRole {
  if (raw === 'infantry' || raw === 'cavalry' || raw === 'siege' || raw === 'scout' || raw === 'special') return raw;
  return isCavalry ? 'cavalry' : 'infantry';
}

export function aggregateSnapshotCounts(snapshot: Snapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, unit] of Object.entries(snapshot)) {
    if (unit.count <= 0) continue;
    const code = unitCode(key);
    out[code] = (out[code] ?? 0) + unit.count;
  }
  return out;
}

export function totalSnapshotCount(snapshot: Snapshot): number {
  return Object.values(snapshot).reduce((sum, unit) => sum + Math.max(0, unit.count), 0);
}

function totalStat(snapshot: Snapshot, side: 'attacker' | 'defender', stat: 'attack' | 'defense'): number {
  return Object.entries(snapshot).reduce((sum, [key, unit]) => {
    if (unit.count <= 0) return sum;
    let value = nonNegative(unit[stat]);
    // 仅这两个首个基础步兵在其“原始角色”触发种族特性。
    if (stat === 'attack' && side === 'attacker' && unitCode(key) === 'clubswinger') value *= 1.074;
    if (stat === 'defense' && side === 'defender' && unitCode(key) === 'phalanx') value *= 1.2206;
    return sum + unit.count * value;
  }, 0);
}

function damage(totalAttack: number, enemyTotalDefense: number): number {
  return totalAttack <= 0 ? 0 : totalAttack * totalAttack / Math.max(totalAttack + enemyTotalDefense, 0.000001);
}

/** 分摊入场伤害：按回合开始时数量比例，逐条目累计余伤并按 hp 折算阵亡。 */
function applyIncomingDamage(snapshot: Snapshot, incoming: number, carries: DamageCarries): { snapshot: Snapshot; carries: DamageCarries } {
  const beforeCount = totalSnapshotCount(snapshot);
  const next: Snapshot = {};
  const nextCarries: DamageCarries = {};
  for (const [key, original] of Object.entries(snapshot)) {
    const unit: CombatUnit = { ...original };
    if (unit.count <= 0) continue;
    const allocated = beforeCount > 0 ? incoming * unit.count / beforeCount : 0;
    const pool = Math.max(0, Number(carries[key]) || 0) + allocated;
    const hp = Math.max(1, nonNegative(unit.hp) || 1);
    const deaths = Math.min(unit.count, Math.floor(pool / hp));
    unit.count -= deaths;
    if (unit.count > 0) {
      next[key] = unit;
      nextCarries[key] = pool - deaths * hp;
    }
  }
  return { snapshot: next, carries: nextCarries };
}

/** 一个“总攻击 / 总防御”回合；双方始终基于同一轮开始快照同时结算。 */
export function simulateTotalAdRound(input: {
  attacker: Snapshot | Record<string, any>;
  defender: Snapshot | Record<string, any>;
  attackerDamageCarry?: DamageCarries;
  defenderDamageCarry?: DamageCarries;
}): TotalAdRoundResult {
  const attacker = normalizeTotalAdSnapshot(input.attacker);
  const defender = normalizeTotalAdSnapshot(input.defender);
  const attackerBefore = aggregateSnapshotCounts(attacker);
  const defenderBefore = aggregateSnapshotCounts(defender);
  const attackA = totalStat(attacker, 'attacker', 'attack');
  const defenseA = totalStat(attacker, 'attacker', 'defense');
  const attackD = totalStat(defender, 'defender', 'attack');
  const defenseD = totalStat(defender, 'defender', 'defense');
  const damageToDefender = damage(attackA, defenseD);
  const damageToAttacker = damage(attackD, defenseA);
  const nextAttacker = applyIncomingDamage(attacker, damageToAttacker, input.attackerDamageCarry ?? {});
  const nextDefender = applyIncomingDamage(defender, damageToDefender, input.defenderDamageCarry ?? {});
  return {
    attacker: nextAttacker.snapshot,
    defender: nextDefender.snapshot,
    attackerDamageCarry: nextAttacker.carries,
    defenderDamageCarry: nextDefender.carries,
    attackerBefore,
    defenderBefore,
    attackerAfter: aggregateSnapshotCounts(nextAttacker.snapshot),
    defenderAfter: aggregateSnapshotCounts(nextDefender.snapshot),
    damageToAttacker,
    damageToDefender,
    attackerTotalAttack: attackA,
    attackerTotalDefense: defenseA,
    defenderTotalAttack: attackD,
    defenderTotalDefense: defenseD,
  };
}

export type BattleStepKind = 'bow_cavalry' | 'cavalry_charge' | 'ranged' | 'melee';

export interface PhaseStepInput {
  attacker: Snapshot | Record<string, any>;
  defender: Snapshot | Record<string, any>;
  attackerDamageCarry?: DamageCarries;
  defenderDamageCarry?: DamageCarries;
  step: BattleStepKind;
  /** 阶段三从 1 开始；只供第三阶段的“每回合”特性累积。 */
  meleeRound?: number;
}

export interface PhaseStepResult extends TotalAdRoundResult {
  step: BattleStepKind;
  phase: Exclude<CombatPhase, 'all'>;
  attackerParticipants: Record<string, number>;
  defenderParticipants: Record<string, number>;
}

function keyCode(key: string): string { return unitCode(key); }
function phaseForStep(step: BattleStepKind): Exclude<CombatPhase, 'all'> {
  return step === 'ranged' ? 'ranged' : step === 'melee' ? 'melee' : 'charge';
}
function participates(unit: CombatUnit, step: BattleStepKind): boolean {
  if (step === 'melee') return true;
  if (step === 'ranged') return unit.form === 'ranged';
  if (step === 'bow_cavalry') return unit.role === 'cavalry' && unit.form === 'ranged';
  return unit.role === 'cavalry' && unit.form !== 'ranged';
}

interface Modifiers { attack: number; defense: number; }
function initialModifiers(snapshot: Snapshot): Record<string, Modifiers> {
  return Object.fromEntries(Object.keys(snapshot).map((key) => [key, { attack: 0, defense: 0 }]));
}

/**
 * 特性是“同一 code 活着便触发一次”的群体效果。来源 key 可能因多支行军包含
 * contribution 前缀，所以必须先按 code 去重；不同 code 的百分点做加法。
 */
function applyTraits(
  own: Snapshot,
  enemy: Snapshot,
  ownSide: 'attacker' | 'defender',
  phase: CombatPhase,
  meleeRound: number,
): { own: Record<string, Modifiers>; enemy: Record<string, Modifiers> } {
  const ownMods = initialModifiers(own);
  const enemyMods = initialModifiers(enemy);
  const seenCodes = new Set<string>();
  for (const [sourceKey, source] of Object.entries(own)) {
    if (source.count <= 0) continue;
    const sourceCode = keyCode(sourceKey);
    if (seenCodes.has(sourceCode)) continue;
    seenCodes.add(sourceCode);
    for (const trait of source.traits ?? []) {
      for (const effect of trait.effects ?? []) {
        if (effect.phase && effect.phase !== 'all' && effect.phase !== phase) continue;
        const amount = Number(effect.value) || 0;
        const ramp = effect.effect === 'ramp_attack' || effect.effect === 'ramp_defense';
        const value = ramp ? amount * Math.max(1, meleeRound) : amount;
        const ownTarget = (predicate: (unit: CombatUnit, key: string) => boolean, stat: keyof Modifiers, add = value) => {
          for (const [key, unit] of Object.entries(own)) if (unit.count > 0 && predicate(unit, key)) ownMods[key]![stat] += add;
        };
        const enemyTarget = (predicate: (unit: CombatUnit, key: string) => boolean, stat: keyof Modifiers) => {
          for (const [key, unit] of Object.entries(enemy)) if (unit.count > 0 && predicate(unit, key)) enemyMods[key]![stat] += value;
        };
        switch (effect.effect) {
          // 同 code 的多支行军共享一次特性结算，且该兵种的全部兵力都获得效果。
          case 'self_attack': case 'ramp_attack': ownTarget((_unit, key) => keyCode(key) === sourceCode, 'attack'); break;
          case 'self_defense': case 'ramp_defense': ownTarget((_unit, key) => keyCode(key) === sourceCode, 'defense'); break;
          case 'origin_attacker_attack': if (ownSide === 'attacker') ownTarget((_unit, key) => keyCode(key) === sourceCode, 'attack'); break;
          case 'origin_defender_defense': if (ownSide === 'defender') ownTarget((_unit, key) => keyCode(key) === sourceCode, 'defense'); break;
          case 'enemy_cavalry_attack': enemyTarget((unit) => unit.role === 'cavalry', 'attack'); break;
          case 'enemy_cavalry_defense': enemyTarget((unit) => unit.role === 'cavalry', 'defense'); break;
          case 'enemy_ranged_attack': enemyTarget((unit) => unit.form === 'ranged', 'attack'); break;
          case 'enemy_ranged_defense': enemyTarget((unit) => unit.form === 'ranged', 'defense'); break;
          case 'enemy_infantry_defense': enemyTarget((unit) => unit.role === 'infantry', 'defense'); break;
          case 'enemy_lower_hp_defense': enemyTarget((unit) => (unit.hp ?? 0) < (source.hp ?? 0), 'defense'); break;
          case 'ally_cavalry_defense': ownTarget((unit, key) => keyCode(key) !== sourceCode && unit.role === 'cavalry', 'defense'); break;
        }
      }
    }
  }
  return { own: ownMods, enemy: enemyMods };
}

function effectiveStats(
  snapshot: Snapshot,
  step: BattleStepKind,
  ownModifiers: Record<string, Modifiers>,
): { attack: number; defense: number; participants: Record<string, number> } {
  let attack = 0;
  let defense = 0;
  const participants: Record<string, number> = {};
  for (const [key, unit] of Object.entries(snapshot)) {
    if (unit.count <= 0) continue;
    const mod = ownModifiers[key] ?? { attack: 0, defense: 0 };
    // 防御是被攻击方所有幸存单位的总防御；攻击仅计算本步骤可出手的单位。
    defense += unit.count * Math.max(0, nonNegative(unit.defense) * (1 + mod.defense));
    if (!participates(unit, step)) continue;
    participants[keyCode(key)] = (participants[keyCode(key)] ?? 0) + unit.count;
    attack += unit.count * Math.max(0, nonNegative(unit.attack) * (1 + mod.attack));
  }
  return { attack, defense, participants };
}

/**
 * v3 单步骤：弓骑预射 → 近战骑冲锋 → 远程 → 全员近战。双方严格取步骤开始
 * 快照同时结算；HP 余伤由调用方跨每个步骤与近战轮保存。
 */
export function simulatePhaseStep(input: PhaseStepInput): PhaseStepResult {
  const attacker = normalizeTotalAdSnapshot(input.attacker);
  const defender = normalizeTotalAdSnapshot(input.defender);
  const phase = phaseForStep(input.step);
  const meleeRound = input.meleeRound ?? 1;
  const aTraits = applyTraits(attacker, defender, 'attacker', phase, meleeRound);
  const dTraits = applyTraits(defender, attacker, 'defender', phase, meleeRound);
  // 每方对自己的加成和敌方施加的减益相加。
  const mergeMods = (left: Record<string, Modifiers>, right: Record<string, Modifiers>) => Object.fromEntries(Object.keys(left).map((key) => [key, {
    attack: left[key]!.attack + (right[key]?.attack ?? 0),
    defense: left[key]!.defense + (right[key]?.defense ?? 0),
  }])) as Record<string, Modifiers>;
  const a = effectiveStats(attacker, input.step, mergeMods(aTraits.own, dTraits.enemy));
  const d = effectiveStats(defender, input.step, mergeMods(dTraits.own, aTraits.enemy));
  const damageToDefender = damage(a.attack, d.defense);
  const damageToAttacker = damage(d.attack, a.defense);
  const nextAttacker = applyIncomingDamage(attacker, damageToAttacker, input.attackerDamageCarry ?? {});
  const nextDefender = applyIncomingDamage(defender, damageToDefender, input.defenderDamageCarry ?? {});
  return {
    step: input.step, phase,
    attacker: nextAttacker.snapshot, defender: nextDefender.snapshot,
    attackerDamageCarry: nextAttacker.carries, defenderDamageCarry: nextDefender.carries,
    attackerBefore: aggregateSnapshotCounts(attacker), defenderBefore: aggregateSnapshotCounts(defender),
    attackerAfter: aggregateSnapshotCounts(nextAttacker.snapshot), defenderAfter: aggregateSnapshotCounts(nextDefender.snapshot),
    damageToAttacker, damageToDefender,
    attackerTotalAttack: a.attack, attackerTotalDefense: a.defense,
    defenderTotalAttack: d.attack, defenderTotalDefense: d.defense,
    attackerParticipants: a.participants, defenderParticipants: d.participants,
  };
}

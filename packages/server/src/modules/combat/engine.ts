import type { CombatUnit, Snapshot, TraitEffect } from '../../infra/combat-types.js';

export const MAX_REPLAY_ROUNDS = 120;

export interface CombatTickInput {
  attacker: Snapshot;
  defender: Snapshot;
  attackerPending: number;
  defenderPending: number;
  combatStrength: number;
  dt: number;
  defenderWallMultiplier: number;
  /** 攻击方携带的敌方骑兵防御削弱倍率。 */
  attackerCavalryDefMultiplier?: number;
  /** 防守方携带的敌方骑兵防御削弱倍率（野战/行军防守方）。 */
  defenderCavalryDefMultiplier?: number;
}

export interface CombatTickResult {
  attacker: Snapshot;
  defender: Snapshot;
  attackerPending: number;
  defenderPending: number;
  attackerBefore: Record<string, number>;
  defenderBefore: Record<string, number>;
  attackerAfter: Record<string, number>;
  defenderAfter: Record<string, number>;
  killsToAttacker: number;
  killsToDefender: number;
}

/**
 * 纯战斗引擎：输入战斗快照，输出下一轮快照，不读写 Store、不发 Command/Event。
 * 双方使用 tick 开始时的快照同时计算伤害，先打前排，远程在己方近战
 * 消失且敌方近战仍存活时被迫使用近战攻击。单类伤害采用平滑除法口径：
 * damageRate = k × attack / defense，再用兰开斯特平方律：
 * dA/dt = -βB、dB/dt = -αA，并用该方程在一个 tick 内的解析解推进，
 * 让人数优势通过战斗全过程的平方律累积体现，同时避免攻击低于防御时完全不掉血。
 */
export function simulateCombatTick(input: CombatTickInput): CombatTickResult {
  const attacker = cloneSnapshot(input.attacker);
  const defender = cloneSnapshot(input.defender);
  const attackerBefore = aggregateCounts(attacker);
  const defenderBefore = aggregateCounts(defender);
  const attackerRate = computeKillRate(attacker, defender, input.combatStrength, input.defenderWallMultiplier, input.attackerCavalryDefMultiplier ?? 1);
  const defenderRate = computeKillRate(defender, attacker, input.combatStrength, 1, input.defenderCavalryDefMultiplier ?? 1);
  const { killsToAttacker, killsToDefender } = solveLanchesterTick(attackerRate, defenderRate, input.dt);
  const defenderPending = applyKills(defender, killsToDefender + input.defenderPending);
  const attackerPending = applyKills(attacker, killsToAttacker + input.attackerPending);
  return {
    attacker,
    defender,
    attackerPending,
    defenderPending,
    attackerBefore,
    defenderBefore,
    attackerAfter: aggregateCounts(attacker),
    defenderAfter: aggregateCounts(defender),
    killsToAttacker,
    killsToDefender,
  };
}

export function cloneSnapshot(snap: Snapshot): Snapshot {
  return Object.fromEntries(
    Object.entries(snap).map(([key, unit]) => [key, { ...unit, traits: unit.traits?.map((trait) => ({ ...trait })) }]),
  );
}

/** 某特性效果在一个单位上的累计倍率（1 + Σvalue）。 */
function traitMult(u: CombatUnit, effect: TraitEffect): number {
  let multiplier = 1;
  for (const trait of u.traits ?? []) if (trait.effect === effect) multiplier += trait.value;
  return multiplier;
}

function hasAliveForm(snap: Snapshot, form: 'melee' | 'ranged'): boolean {
  return Object.values(snap).some((unit) => unit.form === form && unit.count > 0);
}

export function totalCount(snap: Snapshot): number {
  return Object.values(snap).reduce((total, unit) => total + unit.count, 0);
}

export function totalPower(snap: Snapshot): number {
  return Object.values(snap).reduce((power, unit) => power + unit.count * (unit.meleeAtk + unit.rangedAtk), 0);
}

export function applyAmbushBonus(unit: CombatUnit, bonus: number): CombatUnit {
  const multiplier = 1 + Math.max(0, Number(bonus) || 0);
  return { ...unit, meleeAtk: unit.meleeAtk * multiplier, rangedAtk: unit.rangedAtk * multiplier };
}

export function applyAmbushSnapshot(snap: Snapshot, bonus: number): Snapshot {
  return Object.fromEntries(Object.entries(snap).map(([code, unit]) => [code, applyAmbushBonus(unit, bonus)]));
}

export function filterSiegeWeapons(snap: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [key, unit] of Object.entries(snap)) {
    const code = key.includes('#') ? key.slice(key.indexOf('#') + 1) : key;
    if (/ram|catapult|trebuchet/i.test(code)) out[key] = unit;
  }
  return out;
}

export function filterNonSiegeWeapons(snap: Snapshot): Snapshot {
  const out: Snapshot = {};
  for (const [key, unit] of Object.entries(snap)) {
    const code = key.includes('#') ? key.slice(key.indexOf('#') + 1) : key;
    if (!/ram|catapult|trebuchet/i.test(code)) out[key] = unit;
  }
  return out;
}

/** 按 code 聚合数量，去掉贡献来源命名空间。 */
export function aggregateCounts(snap: Snapshot): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, unit] of Object.entries(snap)) {
    if (unit.count <= 0) continue;
    const code = key.includes('#') ? key.slice(key.indexOf('#') + 1) : key;
    out[code] = (out[code] ?? 0) + unit.count;
  }
  return out;
}

export function sampleBattleRounds<T>(rounds: T[]): T[] {
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

export function countDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const code of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const lost = (before[code] ?? 0) - (after[code] ?? 0);
    if (lost > 0) out[code] = lost;
  }
  return out;
}

interface CombatRate {
  /** 该方当前可开火的有效人数。 */
  forceCount: number;
  /** 按每秒计算的对敌减员速率。 */
  killsPerSecond: number;
}

function computeKillRate(A: Snapshot, B: Snapshot, k: number, defenderWallMultiplier: number, cavalryDefMultiplier = 1): CombatRate {
  const attackerHasMelee = hasAliveForm(A, 'melee');
  const defenderHasMelee = hasAliveForm(B, 'melee');
  let meleeDamage = 0;
  let rangedDamage = 0;
  for (const unit of Object.values(A)) {
    if (unit.count <= 0) continue;
    if (unit.form === 'melee') {
      meleeDamage += unit.count * unit.meleeAtk * traitMult(unit, 'atk_melee');
    } else if (attackerHasMelee || !defenderHasMelee) {
      rangedDamage += unit.count * unit.rangedAtk * traitMult(unit, 'atk_ranged');
    } else {
      meleeDamage += unit.count * unit.meleeAtk * traitMult(unit, 'atk_melee');
    }
  }
  const effectiveAttackerCount = Object.values(A).reduce((total, unit) => total + (unit.count > 0 ? unit.count : 0), 0);
  if (meleeDamage <= 0 && rangedDamage <= 0) return { forceCount: effectiveAttackerCount, killsPerSecond: 0 };

  const targetForm: 'melee' | 'ranged' = defenderHasMelee ? 'melee' : 'ranged';
  const priority = Object.values(B).some((unit) => unit.ambushPriority && unit.count > 0);
  let rowCount = 0;
  let effectiveMeleeHp = 0;
  let effectiveRangedHp = 0;
  for (const unit of Object.values(B)) {
    if (unit.form !== targetForm || unit.count <= 0 || (priority && !unit.ambushPriority)) continue;
    rowCount += unit.count;
    const unitDefMultiplier = unit.isCavalry ? Math.max(0, cavalryDefMultiplier) : 1;
    effectiveMeleeHp += unit.count * unit.meleeDef * unitDefMultiplier * traitMult(unit, 'def_melee') / Math.max(0.05, traitMult(unit, 'dmg_taken_melee'));
    effectiveRangedHp += unit.count * unit.rangedDef * unitDefMultiplier * traitMult(unit, 'def_ranged') / Math.max(0.05, traitMult(unit, 'dmg_taken_ranged'));
  }
  if (rowCount <= 0) return { forceCount: effectiveAttackerCount, killsPerSecond: 0 };
  const meleeDefenseAverage = Math.max(0.5, (effectiveMeleeHp / rowCount) * defenderWallMultiplier);
  const rangedDefenseAverage = Math.max(0.5, (effectiveRangedHp / rowCount) * defenderWallMultiplier);
  return {
    forceCount: effectiveAttackerCount,
    killsPerSecond: k * (meleeDamage / meleeDefenseAverage + rangedDamage / rangedDefenseAverage),
  };
}

/**
 * 推进兰开斯特平方律的一个 tick。
 *
 * A、B 是双方当前可开火人数，α/β 是单个敌方战斗员造成的减员速率：
 *   dA/dt = -βB
 *   dB/dt = -αA
 * 解析解能在大兵力差时保持平方律的战果，不受“先算哪一方”的顺序影响。
 */
function solveLanchesterTick(attacker: CombatRate, defender: CombatRate, dt: number): { killsToAttacker: number; killsToDefender: number } {
  const attackerCount = attacker.forceCount;
  const defenderCount = defender.forceCount;
  if (attackerCount <= 0 || defenderCount <= 0) return { killsToAttacker: 0, killsToDefender: 0 };

  const alpha = attacker.killsPerSecond / attackerCount;
  const beta = defender.killsPerSecond / defenderCount;
  let remainingAttacker = attackerCount;
  let remainingDefender = defenderCount;

  if (alpha <= 0 && beta <= 0) return { killsToAttacker: 0, killsToDefender: 0 };
  if (alpha <= 0) {
    remainingAttacker = Math.max(0, attackerCount - beta * defenderCount * dt);
  } else if (beta <= 0) {
    remainingDefender = Math.max(0, defenderCount - alpha * attackerCount * dt);
  } else {
    const lambdaDt = Math.sqrt(alpha * beta) * dt;
    const cosh = Math.cosh(lambdaDt);
    const sinh = Math.sinh(lambdaDt);
    remainingAttacker = attackerCount * cosh - Math.sqrt(beta / alpha) * defenderCount * sinh;
    remainingDefender = defenderCount * cosh - Math.sqrt(alpha / beta) * attackerCount * sinh;

    // 解析解可以跨过“某方归零”的时刻；此时用兰开斯特不变量
    // αA² - βB² 决定剩余胜方，避免出现负兵力或双方同时被错误清空。
    if (remainingAttacker < 0 || remainingDefender < 0) {
      const invariant = alpha * attackerCount ** 2 - beta * defenderCount ** 2;
      if (invariant > 0) {
        remainingAttacker = Math.sqrt(invariant / alpha);
        remainingDefender = 0;
      } else if (invariant < 0) {
        remainingAttacker = 0;
        remainingDefender = Math.sqrt(-invariant / beta);
      } else {
        remainingAttacker = 0;
        remainingDefender = 0;
      }
    }
  }

  return {
    killsToAttacker: Math.max(0, attackerCount - Math.max(0, remainingAttacker)),
    killsToDefender: Math.max(0, defenderCount - Math.max(0, remainingDefender)),
  };
}

function applyKills(snap: Snapshot, killsFloat: number): number {
  const kills = Math.floor(killsFloat);
  const fraction = killsFloat - kills;
  if (kills <= 0) return killsFloat;
  const targetForm: 'melee' | 'ranged' = hasAliveForm(snap, 'melee') ? 'melee' : 'ranged';
  const priority = Object.values(snap).some((unit) => unit.ambushPriority && unit.count > 0);
  const row = Object.entries(snap).filter(([, unit]) => unit.form === targetForm && unit.count > 0 && (!priority || unit.ambushPriority));
  const rowCount = row.reduce((total, [, unit]) => total + unit.count, 0);
  if (rowCount <= 0) return fraction;
  if (kills >= rowCount) {
    for (const [, unit] of row) unit.count = 0;
    pruneZero(snap);
    return fraction;
  }

  const allocations = row.map(([key, unit]) => {
    const exact = (kills * unit.count) / rowCount;
    return { key, unit, base: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let assigned = allocations.reduce((total, item) => total + item.base, 0);
  allocations.sort((left, right) => right.remainder - left.remainder);
  let index = 0;
  while (assigned < kills) {
    const allocation = allocations[index % allocations.length]!;
    if (allocation.base < allocation.unit.count) {
      allocation.base += 1;
      assigned += 1;
    }
    index += 1;
    if (index > allocations.length * 3) break;
  }
  for (const allocation of allocations) allocation.unit.count = Math.max(0, allocation.unit.count - allocation.base);
  pruneZero(snap);
  return fraction;
}

function pruneZero(snap: Snapshot): void {
  for (const [key, unit] of Object.entries(snap)) if (unit.count <= 0) delete snap[key];
}

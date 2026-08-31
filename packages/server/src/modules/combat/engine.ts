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
 * 规则保持现状：双方使用 tick 开始时的快照同时计算伤害，先打前排，
 * 远程在己方近战消失且敌方近战仍存活时被迫使用近战攻击。
 */
export function simulateCombatTick(input: CombatTickInput): CombatTickResult {
  const attacker = cloneSnapshot(input.attacker);
  const defender = cloneSnapshot(input.defender);
  const attackerBefore = aggregateCounts(attacker);
  const defenderBefore = aggregateCounts(defender);
  const killsToDefender = computeKills(attacker, defender, input.combatStrength, input.dt, input.defenderWallMultiplier, input.attackerCavalryDefMultiplier ?? 1);
  const killsToAttacker = computeKills(defender, attacker, input.combatStrength, input.dt, 1, input.defenderCavalryDefMultiplier ?? 1);
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

function computeKills(A: Snapshot, B: Snapshot, k: number, dt: number, defenderWallMultiplier: number, cavalryDefMultiplier = 1): number {
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
  if (meleeDamage <= 0 && rangedDamage <= 0) return 0;

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
  if (rowCount <= 0) return 0;
  const meleeDefenseAverage = Math.max(0.5, (effectiveMeleeHp / rowCount) * defenderWallMultiplier);
  const rangedDefenseAverage = Math.max(0.5, (effectiveRangedHp / rowCount) * defenderWallMultiplier);
  return k * dt * (meleeDamage / meleeDefenseAverage + rangedDamage / rangedDefenseAverage);
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

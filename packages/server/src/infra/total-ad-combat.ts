import type { CombatUnit, Snapshot } from './combat-types.js';

export const TOTAL_AD_RULESET_VERSION = 2;
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
      ...(legacy.popCost === undefined ? {} : { popCost: Math.max(0, Number(legacy.popCost) || 0) }),
    };
  }
  return out;
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

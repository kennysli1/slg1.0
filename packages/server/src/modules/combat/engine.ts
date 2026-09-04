import type { Snapshot } from '../../infra/combat-types.js';
import {
  aggregateSnapshotCounts,
  normalizeTotalAdSnapshot,
  simulateTotalAdRound,
  simulatePhaseStep,
  totalSnapshotCount,
  type DamageCarries,
  type BattleStepKind,
} from '../../infra/total-ad-combat.js';

export const MAX_REPLAY_ROUNDS = 120;

export interface CombatTickInput {
  attacker: Snapshot;
  defender: Snapshot;
  attackerDamageCarry?: DamageCarries;
  defenderDamageCarry?: DamageCarries;
}

export interface CombatTickResult {
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
  phase?: 'charge' | 'ranged' | 'melee';
  step?: BattleStepKind;
}

export interface StagedCombatTickInput extends CombatTickInput {
  step: BattleStepKind;
  meleeRound?: number;
}

/** Combat owner 对基础设施纯回合器的薄封装。 */
export function simulateCombatTick(input: CombatTickInput): CombatTickResult {
  return simulateTotalAdRound(input);
}

/** v3 线上与独立模拟器共享的单阶段步骤封装。 */
export function simulateStagedCombatTick(input: StagedCombatTickInput) {
  return simulatePhaseStep(input);
}

export function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return normalizeTotalAdSnapshot(snapshot);
}

export function totalCount(snapshot: Snapshot): number { return totalSnapshotCount(snapshot); }
export function totalPower(snapshot: Snapshot): number {
  return Object.values(normalizeTotalAdSnapshot(snapshot)).reduce((sum, unit) => sum + unit.count * (unit.attack ?? 0), 0);
}
export function aggregateCounts(snapshot: Snapshot): Record<string, number> { return aggregateSnapshotCounts(snapshot); }

/** 攻城器械仅影响建筑破坏，不参与新战斗的独立阶段。 */
export function filterSiegeWeapons(snapshot: Snapshot): Snapshot {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => /ram|catapult|trebuchet/i.test(key)));
}
export function filterNonSiegeWeapons(snapshot: Snapshot): Snapshot {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => !/ram|catapult|trebuchet/i.test(key)));
}

export function sampleBattleRounds<T>(rounds: T[]): T[] {
  if (rounds.length <= MAX_REPLAY_ROUNDS) return rounds;
  const sampled: T[] = [];
  let previous = -1;
  for (let i = 0; i < MAX_REPLAY_ROUNDS; i++) {
    const index = Math.round(i * (rounds.length - 1) / (MAX_REPLAY_ROUNDS - 1));
    if (index !== previous) sampled.push(rounds[index]!);
    previous = index;
  }
  return sampled;
}

export function countDelta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const loss = (before[key] ?? 0) - (after[key] ?? 0);
    if (loss > 0) out[key] = loss;
  }
  return out;
}

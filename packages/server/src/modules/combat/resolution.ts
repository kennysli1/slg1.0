// eslint-disable-next-line no-restricted-imports -- combat/** 是同一 combat owner 的内部类型层。
import type { Battle } from './types.js';
// eslint-disable-next-line no-restricted-imports -- combat/** 是同一 combat owner 的纯引擎层。
import { totalCount } from './engine.js';

export interface SettlementPlan {
  attackerWins: boolean;
  attackerLosses: Record<string, number>;
  defenderLosses: Record<string, number>;
  defenderLossesByMovement: Record<string, Record<string, number>>;
  residentDefenderLosses: Record<string, number>;
  totalCarry: number;
}

/**
 * 纯结算规划：只从战斗最终快照计算伤亡和运力，不执行跨模块副作用。
 * 这层让结算流程可以在失败重试时复用同一份确定性输入。
 */
export function buildSettlementPlan(battle: Battle): SettlementPlan {
  const defenderLosses: Record<string, number> = {};
  const defenderLossesByMovement: Record<string, Record<string, number>> = {};
  const residentDefenderLosses: Record<string, number> = {};
  for (const [key, original] of Object.entries(battle.defenderOriginal)) {
    const dead = original - (battle.defender[key]?.count ?? 0);
    if (dead <= 0) continue;
    const split = key.indexOf('#');
    const sourceId = split >= 0 ? key.slice(0, split) : `resident:${battle.targetId}`;
    const code = split >= 0 ? key.slice(split + 1) : key;
    defenderLosses[code] = (defenderLosses[code] ?? 0) + dead;
    const source = battle.defenderContributions?.[sourceId];
    if (source?.movementId) {
      const losses = defenderLossesByMovement[source.movementId] ?? {};
      losses[code] = (losses[code] ?? 0) + dead;
      defenderLossesByMovement[source.movementId] = losses;
    } else {
      residentDefenderLosses[code] = (residentDefenderLosses[code] ?? 0) + dead;
    }
  }

  const attackerLosses: Record<string, number> = {};
  for (const [contributionId, contribution] of Object.entries(battle.contributions)) {
    for (const [code, original] of Object.entries(contribution.troops)) {
      const alive = battle.attacker[`${contributionId}#${code}`]?.count ?? 0;
      const dead = original - alive;
      if (dead > 0) attackerLosses[code] = (attackerLosses[code] ?? 0) + dead;
    }
  }

  const totalCarry = Object.values(battle.attacker).reduce((carry, unit) => carry + unit.count * unit.carry, 0);
  return {
    attackerWins: totalCount(battle.defender) <= 0,
    attackerLosses,
    defenderLosses,
    defenderLossesByMovement,
    residentDefenderLosses,
    totalCarry,
  };
}

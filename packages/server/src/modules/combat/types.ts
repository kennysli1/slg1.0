import type { Snapshot } from '../../infra/combat-types.js';

/** 一支来攻部队的贡献记录（战斗状态的内部类型）。 */
export interface Contribution {
  movementId: string;
  fromVillage: string;
  fromXY: { q: number; r: number };
  troops: Record<string, number>;
  treasures: string[];
  npcService?: boolean;
  kingdomMercenary?: boolean;
  returnPveId?: string;
}

/** 防守方兵力来源：驻军或临时增援。 */
export interface DefenderContribution {
  sourceId: string;
  movementId?: string;
  fromVillage?: string;
  npcService?: boolean;
  troops: Record<string, number>;
}

export interface BattleRound {
  round: number;
  attackerLosses: Record<string, number>;
  defenderLosses: Record<string, number>;
  attacker: Record<string, number>;
  defender: Record<string, number>;
  attackerTotalAttack: number;
  attackerTotalDefense: number;
  defenderTotalAttack: number;
  defenderTotalDefense: number;
  damageToAttacker: number;
  damageToDefender: number;
}

export type ResolutionStep = 'apply_domain' | 'emit_attacker_reports' | 'emit_defender_report';

export interface BattleResolution {
  /** 用于日志、幂等追踪和后续 Command 的稳定结算 id。 */
  id: string;
  step: ResolutionStep;
  startedAt: number;
  attackerWins?: boolean;
  attackerLosses?: Record<string, number>;
  defenderLosses?: Record<string, number>;
  looted?: Record<string, number>;
  storedLoot?: Record<string, number>;
  buildingLoot?: Record<string, number>;
  buildingDamage?: unknown[];
  campCleared?: boolean;
  isTaskCamp?: boolean;
  isNoRespawn?: boolean;
  attackerReportIndex?: number;
}

export interface Battle {
  id: string;
  targetKind: 'village' | 'pve' | 'field';
  battleType?: 'raid' | 'siege' | 'ambush';
  taskCode?: string;
  targetId: string;
  targetXY: { q: number; r: number };
  wallLevel: number;
  attacker: Snapshot;
  defender: Snapshot;
  defenderOriginal: Record<string, number>;
  defenderContributions?: Record<string, DefenderContribution>;
  contributions: Record<string, Contribution>;
  defenderContribution?: Contribution;
  /** Total-AD v2 每个快照条目的生命值余伤；旧字段保留只为平滑读旧档。 */
  attackerDamageCarry?: Record<string, number>;
  defenderDamageCarry?: Record<string, number>;
  /** 规则版本：缺省的旧战场会在下次 tick 惰性迁移到 v2。 */
  rulesetVersion?: number;
  initialAttacker: Record<string, number>;
  initialDefender: Record<string, number>;
  rounds: BattleRound[];
  attackPower0: number;
  defensePower0: number;
  startedAt: number;
  ticks: number;
  status: 'active' | 'resolving' | 'ended';
  /** 旧存档没有该字段时由 Combat 惰性初始化。 */
  resolution?: BattleResolution;
}

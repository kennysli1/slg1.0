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
  /** 野战主动追击标记；普通交叉相遇为 false。 */
  fieldPursuer?: boolean;
  /** 该军队在此前野战中缴获、尚未归城入库的宝物。 */
  capturedTreasures?: string[];
}

/** 防守方兵力来源：驻军或临时增援。 */
export interface DefenderContribution {
  sourceId: string;
  movementId?: string;
  fromVillage?: string;
  npcService?: boolean;
  troops: Record<string, number>;
}

/**
 * 远弦圣地战场的冻结上下文。
 *
 * Sanctum 仍是占领/旧占领者资格的唯一 owner；Combat 只保存已经通过 Command
 * 查询到的参战人口和开战前守军基线。这样同一时刻多支部队并入时，能在首 tick
 * 前用完整的主指挥人口占比重新判断是否取消圣地防御，而不用跨模块读取 Sanctum 状态。
 */
export interface SanctumAttackerContribution {
  playerId?: string;
  effectivePop: number;
  isMainCommander: boolean;
}

export interface SanctumBattleContext {
  eventTarget: boolean;
  sanctuary: boolean;
  /** 圣地第一次遭到进攻时的守军快照，首 tick 前可据此安全重算防守加成。 */
  defenderBaseSnapshot?: Snapshot;
  /** 驻守圣地的真实行军归属；仅由 Sanctum→Movement 受控快照提供。 */
  defenderMovementId?: string;
  defenderVillageId?: string;
  defenderPlayerId?: string;
  /** 守望棱镜等守军携物冻结出的第二阶段远程防御倍率。 */
  defenderWatcherRangedDefMult?: number;
  attackerContributions: Record<string, SanctumAttackerContribution>;
  disableSanctuaryBonuses?: boolean;
  defenderDefenseMult?: number;
  defenderRangedAtkMult?: number;
  defenderRangedDefMult?: number;
}

export interface BattleRound {
  round: number;
  /** v3 阶段；旧 v2 回放缺失时按 total-ad 兼容展示。 */
  phase?: 'charge' | 'ranged' | 'melee';
  /** v3 的具体步骤：弓骑预射/骑兵冲锋/远程/近战。 */
  step?: 'bow_cavalry' | 'cavalry_charge' | 'ranged' | 'melee';
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
  /** 清营宝物掉落档位；仅普通 PvE 掉落使用。 */
  treasureTier?: 1 | 2 | 3;
  attackerReportIndex?: number;
  /** 野战结算的来源游标，恢复后不重做已经完成的伤亡回收/战报步骤。 */
  fieldCasualtyIndex?: number;
  defenderReportIndex?: number;
  caravanResultEmitted?: boolean;
  /** 圣地驻军的损失已由 Movement owner 落盘，避免 resolving 恢复时重复扣兵。 */
  sanctumDefenderApplied?: boolean;
  sanctumDefenderDestroyed?: boolean;
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
  /** 可选以兼容旧战报/历史存档；仅远弦活动 PvE 战使用。 */
  sanctum?: SanctumBattleContext;
  contributions: Record<string, Contribution>;
  defenderContribution?: Contribution;
  /** 商队护送战按行军隔离守方快照；缺省继续使用旧单行军野战。 */
  defenderFieldContributions?: Record<string, Contribution>;
  caravanId?: string;
  /** Total-AD v2 每个快照条目的生命值余伤；旧字段保留只为平滑读旧档。 */
  attackerDamageCarry?: Record<string, number>;
  defenderDamageCarry?: Record<string, number>;
  /** 规则版本：缺省的旧战场会在下次 tick 惰性迁移到 v2。 */
  rulesetVersion?: number;
  /** v3 当前待结算步骤；只对 rulesetVersion=3 有意义。 */
  stagedStep?: 'bow_cavalry' | 'cavalry_charge' | 'ranged' | 'melee';
  /** 阶段三轮次，供“每回合”特性只在阶段三累积。 */
  meleeRound?: number;
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

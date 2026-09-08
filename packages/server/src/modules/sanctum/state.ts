/**
 * 远弦圣地（sanctum）owner 的持久化契约。
 *
 * 这不是任务、PvE 或宝物的副本：本集合只记录公共活动的轮次、公共条件、
 * 玩家在本轮中的资格/线索，以及唯一圣物的所在位置。其它领域状态一律由
 * 它们各自的 owner 继续维护，并通过 Command / Event 与本模块协作。
 */

export const SANCTUM_COLLECTION = 'sanctum';
export const SANCTUM_STATE_KEY = 'current';

export type SanctumPhase = 'dormant' | 'active' | 'ended';
export type SanctumTargetStatus = 'open' | 'in_progress' | 'completed' | 'cooldown' | 'removed';
export type SanctumRelicStatus = 'at_sanctum' | 'carried' | 'settling' | 'awarded';

export interface SanctumPoint {
  q: number;
  r: number;
}

/** 当前轮在开启时冻结的关键规则，避免配置热更新重写已开始活动。 */
export interface SanctumRuleSnapshot {
  roundId: string;
  requiredConditions: number;
  guardDurationMs: number;
  oldOccupierContributionRatio: number;
  defenderDefenseMultiplier: number;
  defenderRangedPhaseMultiplier: number;
  relicCode: string;
  activatedAt: number;
}

export interface SanctumConditionContribution {
  playerId: string;
  villageId?: string;
  resources: Record<string, number>;
  troops: Record<string, number>;
  preparedAt?: number;
  updatedAt: number;
}

/**
 * 调查型条件的驻留计时。它只保存 Movement owner 已认证的行军 id 和目标格，
 * 到期时 Sanctum 会再次向 Movement 查询是否仍驻扎，不能由前端倒计时完成。
 */
export interface SanctumInvestigation {
  playerId: string;
  villageId: string;
  movementId: string;
  point: SanctumPoint;
  dueAt: number;
}

/** 一个公共条件实例；同 code 可有多个实例，repeatable 实例可以经历多次成功。 */
export interface SanctumTarget {
  id: string;
  code: string;
  name: string;
  type: string;
  point?: SanctumPoint;
  /** 动态 PvE 条件的真实目标实体；只保存引用，PvE 仍独占守军/战利品。 */
  pveId?: string;
  status: SanctumTargetStatus;
  repeatable: boolean;
  /** 一次性条件为 1；可重复条件可保持为 Infinity 的序列化替代值 0。 */
  completionLimit: number;
  completionCount: number;
  cooldownUntil?: number;
  createdAt: number;
  updatedAt: number;
  completedBy?: string[];
  /** 同一玩家已启动本目标的时刻；不会包含谜题答案。 */
  startedBy: Record<string, number>;
  /** 玩家在此实例的最近一次成功时刻，用于个人重复冷却。 */
  completedAtBy: Record<string, number>;
  contributions: Record<string, SanctumConditionContribution>;
  /** `holdSec` 调查的服务端驻留计时，key 为 playerId。 */
  investigations: Record<string, SanctumInvestigation>;
  /** 本实例可见的谜题标识；真实答案始终只保留在配置服务器侧。 */
  puzzleCode?: string;
  /** 对方承诺的唯一宝物接收者（合作一次性条件）。 */
  rewardRecipientPlayerId?: string;
}

export interface SanctumConditionRecord {
  id: string;
  targetId: string;
  code: string;
  completedAt: number;
  rewardStatus: 'pending' | 'granted';
  clueId?: string;
}

export interface SanctumClueRecord {
  id: string;
  targetId: string;
  code: string;
  /** 客户端可展示的文字，不把服务端完整坐标候选集落盘到公开目标里。 */
  text: string;
  createdAt: number;
}

export interface SanctumPlayerState {
  playerId: string;
  /** s23 手动确认后才为 true。 */
  joinedAt?: number;
  activatedAt?: number;
  conditionRecords: SanctumConditionRecord[];
  clues: SanctumClueRecord[];
  /** 资格取得、发现、现场说明和各阶段奖励均是本轮一次性标记。 */
  qualifiedAt?: number;
  discoveredAt?: number;
  siteDialogueAt?: number;
  claimedAt?: number;
  guardRewardedAt?: number;
  /** 曾守满并实际取过圣物；不是短暂占领。 */
  oldOccupierAt?: number;
  relicAwardedAt?: number;
}

export interface SanctumSiteState {
  /** 圣地不公开；GetState 仅向已发现/有权玩家下发坐标。 */
  point?: SanctumPoint;
  /** 圣地门扉的动态 PvE 实体，在被击破后保留坐标而非重建守军。 */
  pveId?: string;
  pveClearedAt?: number;
  activatedAt?: number;
  occupantPlayerId?: string;
  occupantVillageId?: string;
  occupantMovementId?: string;
  guardStartedAt?: number;
  guardDueAt?: number;
  guardPausedAt?: number;
  guardElapsedMs: number;
}

export interface SanctumRelicState {
  code: string;
  status: SanctumRelicStatus;
  carrierPlayerId?: string;
  carrierVillageId?: string;
  carrierMovementId?: string;
  returnVillageId?: string;
  takenAt?: number;
  settlingAt?: number;
  awardedPlayerId?: string;
  awardedVillageId?: string;
  awardedAt?: number;
}

export interface SanctumState {
  version: 1;
  phase: SanctumPhase;
  /** 单轮稳定 id；结束后默认不自动开下一轮。 */
  roundId: string;
  revision: number;
  rules?: SanctumRuleSnapshot;
  pioneerPlayerId?: string;
  pioneerVillageId?: string;
  targets: Record<string, SanctumTarget>;
  players: Record<string, SanctumPlayerState>;
  site: SanctumSiteState;
  relic: SanctumRelicState;
  endedAt?: number;
  winnerPlayerId?: string;
  winnerVillageId?: string;
}

export function emptySanctumState(roundId = 'sanctum-round-1', relicCode = 'farstring_relic'): SanctumState {
  return {
    version: 1,
    phase: 'dormant',
    roundId,
    revision: 0,
    targets: {},
    players: {},
    site: { guardElapsedMs: 0 },
    relic: { code: relicCode, status: 'at_sanctum' },
  };
}

/** 旧档 / 半成品状态的惰性归一化。新集合缺失时不要求删档。 */
export function normalizeSanctumState(value: SanctumState | undefined, roundId: string, relicCode: string): SanctumState {
  const state = value ? structuredClone(value) : emptySanctumState(roundId, relicCode);
  state.version = 1;
  state.roundId = state.roundId || roundId;
  state.revision = Math.max(0, Math.floor(Number(state.revision) || 0));
  state.targets ??= {};
  state.players ??= {};
  state.site ??= { guardElapsedMs: 0 };
  state.site.guardElapsedMs = Math.max(0, Number(state.site.guardElapsedMs) || 0);
  state.relic ??= { code: relicCode, status: 'at_sanctum' };
  state.relic.code ||= relicCode;
  if (!['at_sanctum', 'carried', 'settling', 'awarded'].includes(state.relic.status)) state.relic.status = 'at_sanctum';
  if (!['dormant', 'active', 'ended'].includes(state.phase)) state.phase = 'dormant';
  for (const [playerId, player] of Object.entries(state.players)) {
    player.playerId ||= playerId;
    player.conditionRecords = Array.isArray(player.conditionRecords) ? player.conditionRecords : [];
    player.clues = Array.isArray(player.clues) ? player.clues : [];
  }
  for (const target of Object.values(state.targets)) {
    target.startedBy ??= {};
    target.completedAtBy ??= {};
    target.contributions ??= {};
    target.investigations ??= {};
    target.completedBy = Array.isArray(target.completedBy) ? target.completedBy : [];
    target.completionCount = Math.max(0, Math.floor(Number(target.completionCount) || 0));
    target.completionLimit = Math.max(0, Math.floor(Number(target.completionLimit) || 0));
  }
  return state;
}

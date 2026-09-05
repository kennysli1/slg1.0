/** 六边形轴坐标（地图几何唯一表示）。 */
export interface Hex {
  q: number;
  r: number;
}

export type MovementType =
  | 'raid' | 'attack' | 'return' | 'found'
  | 'transport' | 'caravan' | 'caravan_raid' | 'caravan_escort' | 'garrison' | 'explore' | 'auto_explore' | 'scout' | 'incoming_scout' | 'ambush' | 'investigate';

/** 商队公开信息；不包含货物数量、王国保护或护送兵力。权限按查看者计算。 */
export interface CaravanInfo {
  originVillageId: string;
  originVillageName: string;
  destinationVillageId: string;
  destinationVillageName: string;
  destination: Hex;
  phase: 'delivery' | 'return';
  canRaid: boolean;
  canEscort: boolean;
}

export type MovementStatus = 'marching' | 'paused' | 'stationed' | 'stopped';
export type MovementDir = 'in' | 'out';

/**
 * 目标消失/撤回时当前段内的连续掉头状态。
 *
 * `from`/`to` 是掉头前正在经过的两个格子，`progress` 是掉头瞬间
 * 已完成的比例。该字段只用于地图平滑渲染，不改变服务端的离散占格、
 * 遭遇判定或路径寻路。
 */
export interface MovementTurnTransition {
  from: Hex;
  to: Hex;
  progress: number;
  startedAt: number;
  durationMs: number;
}

/** 己方视图：movement.List 下发的完整行军。 */
export interface Movement {
  id: string;
  /** 该军队实际出发的己方村庄；地图跨村展示与切换操作使用。 */
  fromVillage?: string;
  type: MovementType;
  dir: MovementDir;
  status: MovementStatus;
  targetId?: string;
  targetVillage?: string;
  /** transport 的语义；reinforce 为不并入目标村的临时增援。 */
  transportMode?: 'transfer' | 'transport' | 'reinforce';
  npcService?: boolean;
  reinforcementUntil?: number;
  /** 途中侦察锁定的来袭行军 id；仅己方视图下发。 */
  targetMovementId?: string;
  caravan?: CaravanInfo;
  escortCaravanId?: string;
  escortAttached?: boolean;
  scoutType?: 'scout_resources' | 'scout_buildings';
  /** 玩家村战斗模式：掠夺或攻城。 */
  battleType?: 'raid' | 'siege' | 'ambush';
  from: Hex;
  originalFrom: Hex;
  to: Hex;
  abandonedTo?: Hex;
  path: Hex[];
  pos: Hex;
  stepIndex: number;
  perStepMs: number;
  nextStepAt: number;
  /** 目标消失/撤回时，地图从当前段内实际位置无缝切入返程。 */
  turningPoint?: MovementTurnTransition;
  arriveAt: number;
  troops: Record<string, number>;
  cargo?: Record<string, number>;
  loot?: Record<string, number>;
  treasures?: string[];
  requested?: Hex;
  /** 自动探索的返程原因；仅自动探索的去程和由其转化的返程军携带。 */
  autoExplore?: { reason?: 'pve' | 'village' | 'foreign_army' | 'path_end'; foundAt?: Hex; foundName?: string };
  /** 服务端权威判定：本军当前是否可被玩家撤回。 */
  recallable: boolean;
  /** 服务端权威判定：本军当前是否可被玩家原地停止。 */
  stoppable: boolean;
  /** 服务端权威判定：撤回是否会造成不可退还的损失（found 的开城包）。 */
  recallForfeits?: boolean;
}

/** 他国视图：不含路径、兵力或携带物；仅商队通过 caravan 公开目的地。 */
export interface ForeignArmy {
  id: string;
  caravan?: CaravanInfo;
  type: MovementType;
  status: MovementStatus;
  ownerPlayerId?: string;
  ownerPlayerName?: string;
  ownerVillageName?: string;
  pos: Hex;
  /** 朝向：指向下一格的单位增量（六邻居之一）。stationed/paused 时为 null。 */
  heading: Hex | null;
  perStepMs: number;
  nextStepAt: number;
  turningPoint?: MovementTurnTransition;
}

export interface MarchPointState {
  used: number;
  cap: number;
}

/** 侦察来袭成功后保存在该来袭行军上的最新情报。 */
export interface IncomingIntelligence {
  /** 侦察战结束后的来袭军当前兵种与数量。 */
  troops: Record<string, number>;
  /** 仅进攻侦察方完胜（零损失且有幸存者）时公开。 */
  treasures?: string[];
  scoutedAt: number;
  perfectVictory: boolean;
}

/**
 * 当前处于目标玩家视野内的来袭军。它是服务端按实时视野派生的临时快照，
 * 不进入通知/战报；默认不含兵力和携带物。
 */
export interface IncomingWarning {
  id: string;
  type: 'raid' | 'attack';
  battleType?: 'raid' | 'siege';
  targetVillage: string;
  targetVillageName: string;
  fromVillage: string;
  fromVillageName: string;
  from: Hex;
  to: Hex;
  path: Hex[];
  pos: Hex;
  stepIndex: number;
  perStepMs: number;
  nextStepAt: number;
  turningPoint?: MovementTurnTransition;
  arriveAt: number;
  intelligence?: IncomingIntelligence;
}

export interface ListMovementsPayload {
  movements: Movement[];
  /** 只包含此刻仍在视野中的来袭军；离开视野后下一次快照立即消失。 */
  incomingWarnings: IncomingWarning[];
  marchPoints: MarchPointState;
}

export interface ListForeignPayload {
  movements: ForeignArmy[];
}

/** 增量推送载荷（己方逐格推进，或定向发送给受袭村的来袭预警逐格推进）。 */
export interface MarchStepPush {
  villageId: string;
  id: string;
  pos: Hex;
  stepIndex: number;
  nextStepAt: number;
  perStepMs: number;
  status: MovementStatus;
  arriveAt: number;
  turningPoint?: MovementTurnTransition;
}

export interface MarchRemovedPush {
  villageId: string;
  id: string;
  reason: 'arrived' | 'returned' | 'destroyed' | 'converted';
}

export interface ForeignArmyStepPush {
  army: ForeignArmy;
}

export interface ForeignArmyRemovedPush {
  id: string;
}

/**
 * 应用级共享状态：服务端数据缓存、战报列表、当前页签、地图选中目标。
 * 各 feature 模块通过这里读写，避免互相直接依赖。
 */
import { resourceKeys } from './config.js';
import type { ListMovementsPayload, MarchStepPush, Movement } from '@slg/shared';

/** 服务端下发的产出组成项；expiresAt 缺省表示永久生效。 */
export interface RateBreakdownEntry {
  kind?: 'base' | 'modifier' | 'timed' | 'upkeep';
  source: string;
  label: string;
  ratePerHour: number;
  percent?: number;
  expiresAt?: number;
}

export interface SelectedTarget {
  refId: string; kind: string; q: number; r: number; name: string; icon?: string;
  relation?: 'allied' | 'neutral' | 'hostile';
  cityState?: boolean;
  /** 地图可见玩家村庄的公开详情（由 World.GetArea 动态补齐）。 */
  playerName?: string;
  reputation?: number;
  population?: number;
  mainBaseLevel?: number;
  mainBaseName?: string;
  /** 同一格叠放的可交互目标；由地图点击层填充。 */
  stackedTargets?: SelectedTarget[];
}

/** 待领取宝物视图（只有普通 PvE 随机掉落含确认倒计时，任务/送达宝物无期限）。 */
export interface PendingTreasureView {
  movementId: string;
  code: string;
  name: string;
  icon: string;
  category: string;
  rarity: string;
  effectType: string;
  effectValue: number;
  applyType: string;
  priceGold: number;
  /** 'camp'=本村军队带回（默认收下即可）；'deliver'=送达另一村/宝库拆除（需玩家选 收下/出售/遗弃）。 */
  kind?: 'camp' | 'deliver';
  expiresAt?: number;
  /** camp 类型专用：军队是否已归村。未归村时不可领取（Bug3 修复）。 */
  arrivedAt?: number;
  /** camp 类型专用：预计军队到家时间戳。客户端在 arrivedAt 之前用它渲染「还有多久抵达」倒计时；归村后才显示「过期」倒计时。 */
  expectedArrivalAt?: number;
  /** 本村是否拥有贸易中心（决定待领取宝物能否「出售」换金币；客户端据此显示「卖出」还是「丢弃」）。 */
  hasTradeCenter?: boolean;
  /** 该待领取宝物由「军队带出的宝物返程回家」产生（仅 UI 标记，显示「本村带回」badge）。 */
  fromCarry?: boolean;
  /** 转移军队送达的来源村庄，报告卡片据此标识来源。 */
  fromVillageId?: string;
  fromVillageName?: string;
  /** 任务奖励的最终收件村（报告页明确显示）。 */
  rewardVillageId?: string;
}

/** 人口面板快照（来自 GetPopulation 响应 + PopulationChanged push 校正）。v3 硬上限模型 + 劳动→士兵原子转化。 */
export interface PopSnapshot {
  /** 劳动人口（平民）。训练士兵即时转出，是可用于转化为士兵的池子。 */
  currentPop: number;
  /** 实际驻军人口权重（驻军 + 在途，由 military/movement 上报）。 */
  soldierPop: number;
  /** 总人口 = 平民 + 士兵足迹（驻军+在途+训练中）。训练/战死回收守恒，是面板大数字。 */
  totalPop: number;
  /** 训练中预留人口（已转出劳动人口、尚未产出为驻军）。 */
  trainingPop: number;
  /** 人口硬上限（建筑提供：Σ popCapPerLevel × level）。 */
  hardCap: number;
  /** 可用劳动人口 = 平民(currentPop)，用于生产/建造/练兵。 */
  availableLabor: number;
  /** 平民增长上限（占 housing 余量）= 硬上限 − 士兵足迹；客户端外插增长用。 */
  popCeiling: number;
  /** 平民占总人口比例 [0,1]（驱动繁荣度）。 */
  laborRatio: number;
  /** 繁荣度加成 [0,1]（劳动人口占比从动员上限对应最低值到满值处的线性插值）。 */
  prosperityBonus: number;
  /** 四轴统一繁荣度倍率 ∈ [1.0, 1.0 + popProsperityMaxBonus]；低繁荣度不降低基础值。 */
  prosperityMult: number;
  /** 每小时增长（朝 popCeiling 收敛）。 */
  growthPerHour: number;
  /** 原始增长速率（未夹紧到硬上限缺口）；达上限时用于展示人口流动潜力。 */
  potentialGrowthPerHour?: number;
  /** 存储溢出扣减系数（0~1，四资源均溢率）；>0 表示人口增长被仓库溢出扣减。 */
  overflowRatio?: number;
  /** 本部族最大动员比例（士兵占总人口上限；条顿0.80/高卢0.70/罗马0.75）。 */
  mobilizeCap: number;
  /** 繁荣度满值阈值（劳动人口占总人口比例 ≥此值时额外加成达到上限）。 */
  popProsperityFullRatio?: number;
  /** 繁荣度满值时的额外速率加成（默认 +30%）。 */
  popProsperityMaxBonus?: number;
  /** 人口达到硬上限几倍时繁荣额外加成降为 0（默认 2 倍）。 */
  popOvercapPenaltyFullRatio?: number;
  /** 城镇中心等级（增长速率因子）。 */
  mainLevel: number;
  /** 是否处于饥荒（服务端权威）。 */
  inFamine: boolean;
  /** 每小时金币产量（仅劳动人口交税，绑定城镇中心，不受繁荣度影响）。供资源条展示金币速率。 */
  goldPerHour?: number;
  /** 人口增长与金币税收的来源明细（悬浮说明使用）。 */
  growthBreakdown?: RateBreakdownEntry[];
  goldBreakdown?: RateBreakdownEntry[];
  /** 平民耗粮 /h。 */
  civilianCropPerHour: number;
  /** 实际驻军人口（含在途），旧面板展示与总人数重算用；服务端权威为 soldierPop。GetPopulation 快照不携带，由 bootstrap 用 soldierPop 兜底。 */
  garrisonPop: number;
  /** 充裕比（住房余量 / 总人口），旧面板展示用。 */
  lambdaRatio: number;
  /** 伤兵池：总数 + 各伤兵治愈倒计时列表。 */
  wounded: { total: number; entries: any[] };
  /** 每小时粮食赤字速率（饥荒减员速率），由 famine_reduction push 校正。 */
  cropDeficitRate: number;
  /** 四轴繁荣度倍率（全 = prosperityMult，1.0 为基础值）。 */
  laborMults: {
    production: number;
    build: number;
    train: number;
    research: number;
  };
  /** 兼容别名 = availableLabor（movement 拓荒门槛）。 */
  softLimit: number;
  lastTick: number;
  /** 客户端本地记录的快照获取时刻（ms），用于本地外插。 */
  fetchedAt: number;
}

/**
 * 战报语义分类。定义在这里（而非 features/reports）是为了守住依赖方向：
 * features 可以依赖 app，app 不能反过来依赖 features。
 */
export type ReportKind =
  | 'build' | 'train' | 'battle' | 'march' | 'alarm' | 'treasure' | 'pop' | 'trade' | 'research' | 'info';

/** 一条战报：渲染好的文案 + 语义分类 + 发生时刻。 */
export interface StoredReport {
  text: string;
  kind: ReportKind;
  ts: number;
  /** 战斗报告的结构化回放数据；其他类型战报不携带详情。 */
  details?: Record<string, any>;
}

let cache: any = {};
const reports: StoredReport[] = [];
let currentTab = 'village';
let selected: SelectedTarget | null = null;
/** 进行中战斗的实时快照：battleId -> 双方兵力聚合（来自 BattleTick 推送）。 */
const battles: Record<string, any> = {};
/** 人口系统快照（GetPopulation + PopulationChanged 校正）。 */
let popState: PopSnapshot | null = null;

export function getCache(): any { return cache; }
export function setCache(c: any): void { cache = c; }

/** 增量更新：将 MarchStep 推送的字段合并到己方行军或 incomingWarnings 中对应的条目。 */
export function patchMovement(push: MarchStepPush): void {
  const patchOne = (source: ListMovementsPayload | undefined): ListMovementsPayload | undefined => {
    if (!source) return source;
    let changed = false;
    const next: ListMovementsPayload = { ...source };

    // 普通己方行军在 movements 中；任务村 NPC 攻城军没有玩家出发村，
    // 因此只会出现在 incomingWarnings。两者都必须消费同一条 MarchStep，
    // 否则路线会更新而预警图标会停在首次出现的位置。
    if (source.movements) {
      const idx = source.movements.findIndex((m) => m.id === push.id);
      if (idx >= 0) {
        const movements = [...source.movements];
        const prev = movements[idx];
        movements[idx] = { ...prev, pos: push.pos, stepIndex: push.stepIndex, nextStepAt: push.nextStepAt, perStepMs: push.perStepMs, turningPoint: push.turningPoint, status: push.status, arriveAt: push.arriveAt };
        next.movements = movements;
        changed = true;
      }
    }
    if (source.incomingWarnings) {
      const idx = source.incomingWarnings.findIndex((warning) => warning.id === push.id);
      if (idx >= 0) {
        const incomingWarnings = [...source.incomingWarnings];
        const prev = incomingWarnings[idx];
        incomingWarnings[idx] = { ...prev, pos: push.pos, stepIndex: push.stepIndex, nextStepAt: push.nextStepAt, perStepMs: push.perStepMs, turningPoint: push.turningPoint, arriveAt: push.arriveAt };
        next.incomingWarnings = incomingWarnings;
        changed = true;
      }
    }
    return changed ? next : source;
  };
  cache.moves = patchOne(cache.moves);
  cache.playerMoves = patchOne(cache.playerMoves);
}

/**
 * 用服务端在行军状态切换瞬间下发的完整快照替换现有条目。
 * 目标消失后的返程不能等待全量刷新，否则旧请求可能让地图先回到旧路线。
 */
export function replaceMovementSnapshot(snapshot: Movement): void {
  if (!snapshot?.id) return;
  const replaceOne = (source: ListMovementsPayload | undefined): ListMovementsPayload | undefined => {
    if (!source?.movements) return source;
    const idx = source.movements.findIndex((m) => m.id === snapshot.id);
    if (idx < 0) return source;
    const movements = [...source.movements];
    movements[idx] = snapshot;
    return { ...source, movements };
  };
  cache.moves = replaceOne(cache.moves);
  cache.playerMoves = replaceOne(cache.playerMoves);
}

/** 增量更新：从 cache.moves.movements 中移除指定 id 的行军条目。 */
export function dropMovement(id: string): void {
  const dropOne = (source: ListMovementsPayload | undefined): ListMovementsPayload | undefined => {
    if (!source?.movements) return source;
    const next = source.movements.filter((m) => m.id !== id);
    return next.length !== source.movements.length ? { ...source, movements: next } : source;
  };
  cache.moves = dropOne(cache.moves);
  cache.playerMoves = dropOne(cache.playerMoves);
}

export function getReports(): StoredReport[] { return reports; }

/**
 * 战报统一按事件发生时间倒序排列。历史通知和实时推送的到达顺序
 * 不一定相同，不能用 unshift/push 的接收顺序代替服务端事件时间。
 * Array#sort 在当前运行环境中稳定，相同时间戳会保留原有顺序。
 */
function sortReportsNewestFirst(): void {
  reports.sort((a, b) => {
    const at = Number.isFinite(Number(a.ts)) ? Number(a.ts) : 0;
    const bt = Number.isFinite(Number(b.ts)) ? Number(b.ts) : 0;
    return bt - at;
  });
}

/**
 * 追加一条战报。`kind` 由 `notificationKind(event, payload)` 算好后传进来 ——
 * 分类必须来自事件名，**不能**回头去猜已渲染的中文文案（宝物名里带「人口」之类
 * 就会误判）。`ts` 缺省为现在。
 */
export function addReport(text: string, kind: ReportKind = 'info', ts: number = Date.now(), details?: Record<string, any>): void {
  reports.push({ text, kind, ts, ...(details ? { details } : {}) });
  sortReportsNewestFirst();
  if (reports.length > 60) reports.splice(60);
}

/** 用服务端历史通知初始化战报列表（登录后调用一次，替换当前内存内容）。 */
export function seedReports(list: StoredReport[]): void {
  reports.length = 0;
  reports.push(...(Array.isArray(list) ? list : []));
  sortReportsNewestFirst();
  if (reports.length > 60) reports.splice(60);
}

/** 待领取宝物（军队带回、待确认）：来自 ListTreasures.pending，用于报告页交互卡片。 */
let pendingTreasures: PendingTreasureView[] = [];
export function getPendingTreasures(): PendingTreasureView[] { return pendingTreasures; }
export function setPendingTreasures(list: PendingTreasureView[]): void { pendingTreasures = list ?? []; }

/** 进行中战斗快照读写（战斗实时进度用）。 */
export function getBattles(): Record<string, any> { return battles; }
export function setBattleSnapshot(payload: any): void {
  if (payload?.battleId) battles[payload.battleId] = payload;
}
export function clearBattleSnapshot(battleId: string): void {
  if (battleId) delete battles[battleId];
}

export function getTab(): string { return currentTab; }
export function setTab(t: string): void { currentTab = t; }

export function getSelected(): SelectedTarget | null { return selected; }
export function setSelected(s: SelectedTarget | null): void { selected = s; }

/** 人口快照读写。 */
export function getPopState(): PopSnapshot | null { return popState; }
export function setPopState(s: PopSnapshot): void { popState = s; }

/**
 * 本地外插当前「平民（劳动）人口」（不发请求）。
 * 公式：若 currentPop < popCeiling 且增长率 > 0，则按 growthPerHour 线性外插，上限 popCeiling。
 * 下降（饥荒减员 / 超限）由服务端处理，客户端保守显示不模拟减员。
 * 注意：这是平民（可训/可增长）人口，不含士兵；训练容量判定用此值（见 army.ts）。
 */
export function interpolatePop(): number {
  if (!popState) return 0;
  const { currentPop, popCeiling, growthPerHour, fetchedAt } = popState;
  if (currentPop < popCeiling && growthPerHour > 0) {
    const elapsedHours = (Date.now() - fetchedAt) / 3_600_000;
    return Math.min(popCeiling, Math.round(currentPop + growthPerHour * elapsedHours));
  }
  return Math.round(currentPop);
}

/**
 * 本地外插「总人口」= 平民 + 士兵(驻军+在途) + 训练中。
 * 训练士兵是劳动→士兵的原子转化，总人口守恒，故大数字在训练中不会闪烁。
 * 用于顶栏/人口面板的大数字与进度条（分子 = 总人口 / 硬上限）。
 */
export function interpolateTotalPop(): number {
  if (!popState) return 0;
  const civ = interpolatePop();
  return Math.round(civ + (popState.soldierPop ?? 0) + (popState.trainingPop ?? 0));
}

/** 资源快照时刻（ms）。refreshAll 拉到 res 后校正回 now，资源条据此本地外插。
 *  必须放在 state 而非 bootstrap：widgets.canAfford/costPreview 也要用它来跟资源条同源判断买得起，
 *  否则资源条按 base+rate×elapsed 显示充足、买得起按原始快照看到 0，会误报「资源不足」。 */
let resFetchedAt = 0;
export function markResFetched(): void { resFetchedAt = Date.now(); }
export function getResFetchedAt(): number { return resFetchedAt; }

/** 单资源实时本地外插值：缓存快照 + 净速率×elapsed，受 capacity 上限约束（gold 无限）。
 *  与资源条渲染同一公式，确保 canAfford/costPreview 与资源条数字一致。 */
export function liveResource(t: string): number {
  const r = getCache().res;
  if (!r || !r.resources) return 0;
  const base = r.resources[t] ?? 0;
  if (!resFetchedAt) return base;
  const elapsedSec = (Date.now() - resFetchedAt) / 1000;
  let ratePerSec: number;
  if (t === 'gold') ratePerSec = (popState?.goldPerHour ?? 0) / 3600;
  else ratePerSec = r.netRate?.[t] ?? 0;
  let v = base + ratePerSec * elapsedSec;
  if (t !== 'gold') {
    const baseCap = r.capacity?.[t] ?? Infinity;
    const effCap = baseCap * (1 + (r.overflowCap ?? 0)); // 有效容量（露天仓库科技）
    // 自然产出只能顶到 capacity；仅当 base 本身已溢出（掠夺/购买/转交入库）时，才允许显示到 effCap
    const limit = base > baseCap ? effCap : baseCap;
    v = Math.min(limit, Math.max(0, v));
  }
  return v;
}

/** 全资源实时快照（覆盖全部 resourceKeys，缓存缺键也按 0+速率外插，不为 0）。用于 canAfford/costPreview。 */
export function liveResources(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of resourceKeys()) out[t] = liveResource(t);
  return out;
}

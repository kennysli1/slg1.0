/**
 * 应用级共享状态：服务端数据缓存、战报列表、当前页签、地图选中目标。
 * 各 feature 模块通过这里读写，避免互相直接依赖。
 */

export interface SelectedTarget {
  refId: string; kind: string; q: number; r: number; name: string; icon?: string;
}

/** 人口面板快照（来自 GetPopulation 响应 + PopulationChanged push 校正）。v3 硬上限模型。 */
export interface PopSnapshot {
  /** 劳动人口（平民）。 */
  currentPop: number;
  /** 士兵人口（驻军 + 在途，由 military/movement 上报）。 */
  soldierPop: number;
  /** 人口硬上限（建筑提供：Σ popCapPerLevel × level）。 */
  hardCap: number;
  /** 可用劳动人口 = 硬上限 − 士兵人口（增长目标 / 拓荒门槛）。 */
  availableLabor: number;
  /** 劳动人口占硬上限比例 [0,1]。 */
  laborRatio: number;
  /** 繁荣度加成 [0,1]（劳动占比从种族最低到满值处的线性插值）。 */
  prosperityBonus: number;
  /** 五轴统一繁荣度乘数 ∈ [popLaborFloor, 1.0]。 */
  prosperityMult: number;
  /** 每小时增长（朝 availableLabor 收敛）。 */
  growthPerHour: number;
  /** 种族最低劳动占比（繁荣度满值基准）。 */
  raceMin: number;
  /** 繁荣度满值阈值（劳动占比 ≥此值时繁荣度=100%）。 */
  popProsperityFullRatio?: number;
  /** 城镇中心等级（增长速率因子）。 */
  mainLevel: number;
  /** 是否处于饥荒（服务端权威）。 */
  inFamine: boolean;
  /** 平民耗粮 /h。 */
  civilianCropPerHour: number;
  /** 五轴繁荣度乘数（全 = prosperityMult）。 */
  laborMults: {
    production: number;
    build: number;
    train: number;
    research: number;
    smithy: number;
  };
  /** 兼容别名 = availableLabor（movement 拓荒门槛）。 */
  softLimit: number;
  lastTick: number;
  /** 客户端本地记录的快照获取时刻（ms），用于本地外插。 */
  fetchedAt: number;
}

let cache: any = {};
const reports: string[] = [];
let currentTab = 'village';
let selected: SelectedTarget | null = null;
/** 进行中战斗的实时快照：battleId -> 双方兵力聚合（来自 BattleTick 推送）。 */
const battles: Record<string, any> = {};
/** 人口系统快照（GetPopulation + PopulationChanged 校正）。 */
let popState: PopSnapshot | null = null;

export function getCache(): any { return cache; }
export function setCache(c: any): void { cache = c; }

export function getReports(): string[] { return reports; }
export function addReport(line: string): void {
  reports.unshift(line.startsWith('[') ? line : `[${new Date().toLocaleTimeString()}] ${line}`);
  if (reports.length > 60) reports.pop();
}
/** 用服务端历史通知初始化战报列表（登录后调用一次，替换当前内存内容）。 */
export function seedReports(lines: string[]): void {
  reports.length = 0;
  // 历史条目是 old→new 顺序，unshift 逐条反序 → 最终 reports[0] 为最新
  for (let i = lines.length - 1; i >= 0; i--) reports.unshift(lines[i]);
}

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

let mapCenter: { q: number; r: number } | null = null;
export function getMapCenter(): { q: number; r: number } | null { return mapCenter; }
export function setMapCenter(c: { q: number; r: number } | null): void { mapCenter = c; }

/** 人口快照读写。 */
export function getPopState(): PopSnapshot | null { return popState; }
export function setPopState(s: PopSnapshot): void { popState = s; }

/**
 * 本地外插当前「劳动人口」（不发请求）。
 * 公式：若 currentPop < availableLabor 且增长率 > 0，则按 growthPerHour 线性外插，上限 availableLabor。
 * 下降（饥荒减员 / 超限）由服务端处理，客户端保守显示不模拟减员。
 * 注意：这是平民（可训/可增长）人口，不含士兵；训练容量判定用此值（见 army.ts）。
 */
export function interpolatePop(): number {
  if (!popState) return 0;
  const { currentPop, availableLabor, growthPerHour, fetchedAt } = popState;
  if (currentPop < availableLabor && growthPerHour > 0) {
    const elapsedHours = (Date.now() - fetchedAt) / 3_600_000;
    return Math.min(availableLabor, Math.round(currentPop + growthPerHour * elapsedHours));
  }
  return Math.round(currentPop);
}

/**
 * 本地外插「占用总人口」= 劳动人口 + 士兵人口（占用硬上限的那部分）。
 * 用于顶栏/人口面板的大数字与进度条（分子 = 总人口 / 硬上限）。
 * 与 military.reportUpkeep 上报的 soldier_pop（士兵基础粮）口径一致：士兵算作人口占用。
 */
export function interpolateTotalPop(): number {
  if (!popState) return 0;
  return interpolatePop() + popState.soldierPop;
}

/**
 * 应用级共享状态：服务端数据缓存、战报列表、当前页签、地图选中目标。
 * 各 feature 模块通过这里读写，避免互相直接依赖。
 */

export interface SelectedTarget {
  refId: string; kind: string; q: number; r: number; name: string; icon?: string;
}

/** 人口面板快照（来自 GetPopulation 响应 + PopulationChanged push 校正）。 */
export interface PopSnapshot {
  /**
   * 平民人口（不含驻军、不含伤兵）。
   * availablePop = currentPop（平民即可训练上限）。
   */
  currentPop: number;
  /** 驻军占用人口（已征召的兵种）。 */
  garrisonPop: number;
  /** 总人口 = currentPop + garrisonPop + wounded.total。 */
  totalPop: number;
  softLimit: number;
  growthPerHour: number;
  lambdaRatio: number;
  /** 劳动力比（平民 / 总人口），体现劳动力是否充裕。 */
  laborRatio: number;
  /** 粮食赤字速率（/h），伤兵与驻军的耗粮共同影响；仅饥荒时非零。 */
  cropDeficitRate: number;
  /** 是否处于饥荒状态（服务端权威）。 */
  inFamine: boolean;
  wounded: { total: number; entries: { count: number; healAt: number }[] };
  laborMults: {
    production: { wood: number; clay: number; iron: number; crop: number };
    build: number;
    train: { barracks: number; stable: number; workshop: number };
    smithy: number;
  };
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
 * 本地外插当前人口（不发请求）。
 * 公式：若 currentPop < softLimit 且增长率 > 0，则按 growthPerHour 线性外插，上限 softLimit。
 * 下降（超限减员）由服务端处理，客户端保守显示不模拟减员。
 */
export function interpolatePop(): number {
  if (!popState) return 0;
  const { currentPop, softLimit, growthPerHour, fetchedAt } = popState;
  if (currentPop < softLimit && growthPerHour > 0) {
    const elapsedHours = (Date.now() - fetchedAt) / 3_600_000;
    return Math.min(softLimit, Math.round(currentPop + growthPerHour * elapsedHours));
  }
  return Math.round(currentPop);
}

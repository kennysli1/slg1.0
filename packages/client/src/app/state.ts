/**
 * 应用级共享状态：服务端数据缓存、战报列表、当前页签、地图选中目标。
 * 各 feature 模块通过这里读写，避免互相直接依赖。
 */

export interface SelectedTarget {
  refId: string; kind: string; q: number; r: number; name: string; icon?: string;
}

let cache: any = {};
const reports: string[] = [];
let currentTab = 'village';
let selected: SelectedTarget | null = null;
/** 进行中战斗的实时快照：battleId -> 双方兵力聚合（来自 BattleTick 推送）。 */
const battles: Record<string, any> = {};

export function getCache(): any { return cache; }
export function setCache(c: any): void { cache = c; }

export function getReports(): string[] { return reports; }
export function addReport(line: string): void {
  reports.unshift(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (reports.length > 60) reports.pop();
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

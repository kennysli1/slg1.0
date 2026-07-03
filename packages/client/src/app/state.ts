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

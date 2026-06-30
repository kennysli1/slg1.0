/**
 * 应用级共享状态：服务端数据缓存、战报列表、当前页签、地图选中目标。
 * 各 feature 模块通过这里读写，避免互相直接依赖。
 */

export interface SelectedTarget {
  refId: string; kind: string; x: number; y: number; name: string; icon?: string;
}

let cache: any = {};
const reports: string[] = [];
let currentTab = 'village';
let selected: SelectedTarget | null = null;

export function getCache(): any { return cache; }
export function setCache(c: any): void { cache = c; }

export function getReports(): string[] { return reports; }
export function addReport(line: string): void {
  reports.unshift(`[${new Date().toLocaleTimeString()}] ${line}`);
  if (reports.length > 60) reports.pop();
}

export function getTab(): string { return currentTab; }
export function setTab(t: string): void { currentTab = t; }

export function getSelected(): SelectedTarget | null { return selected; }
export function setSelected(s: SelectedTarget | null): void { selected = s; }

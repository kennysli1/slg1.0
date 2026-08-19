/**
 * 响应式仓库（signals）：把「服务端快照缓存」「1 秒心跳」「弹层栈」「Toast」
 * 暴露为信号，视图组件订阅后自动局部重渲，不再整页重建 DOM。
 *
 * 分工：
 *  - `state.ts` 是纯数据/插值逻辑（无框架依赖，单测直接跑）；
 *  - 本文件只负责「谁变了要重渲」，不含业务计算。
 */
import { signal } from '@preact/signals';
import type { VNode } from 'preact';
import { me } from '../api.js';

/** 每秒心跳。读取本地外插值（资源/人口/倒计时）的组件订阅它即可每秒刷新。 */
export const tick = signal(0);

/** 服务端数据版本号。refreshAll 写入新缓存后自增，触发依赖数据的组件重渲。 */
export const dataVersion = signal(0);
export function bumpData(): void { dataVersion.value++; }

/** 战报列表版本号（战报是数组原地 unshift，靠版本号触发重渲）。 */
export const reportsVersion = signal(0);
export function bumpReports(): void { reportsVersion.value++; }

/** 当前页签。 */
export type TabKey = 'village' | 'army' | 'map' | 'tech' | 'reports';
export const tab = signal<TabKey>('village');

/** 登录态版本号（登录/切村后自增，驱动整壳重渲）。 */
export const sessionVersion = signal(0);
export function bumpSession(): void { sessionVersion.value++; }

// ---------- 弹层栈 ----------

let modalSeq = 0;
export interface ModalEntry {
  id: number;
  /** 渲染函数：接收关闭回调，返回弹层内容（通常是 <Modal>）。 */
  render: (close: () => void) => VNode;
  /** 同 key 的弹层只允许一个，重复打开会替换（如建筑详情）。 */
  key?: string;
}
export const modals = signal<ModalEntry[]>([]);

/** 打开弹层，返回它的 id。 */
export function openModal(render: ModalEntry['render'], key?: string): number {
  const id = ++modalSeq;
  const next = key ? modals.value.filter((m) => m.key !== key) : modals.value.slice();
  next.push({ id, render, key });
  modals.value = next;
  return id;
}
export function closeModal(id?: number): void {
  if (id == null) { modals.value = modals.value.slice(0, -1); return; }
  modals.value = modals.value.filter((m) => m.id !== id);
}
export function closeModalByKey(key: string): void {
  modals.value = modals.value.filter((m) => m.key !== key);
}
export function hasModalKey(key: string): boolean {
  return modals.value.some((m) => m.key === key);
}
export function anyModalOpen(): boolean { return modals.value.length > 0; }

// ---------- Toast ----------

let toastSeq = 0;
export interface ToastEntry { id: number; msg: string; kind: 'info' | 'ok' | 'bad' }
export const toasts = signal<ToastEntry[]>([]);

export function showToast(msg: string, kind: ToastEntry['kind'] = 'info'): void {
  const id = ++toastSeq;
  toasts.value = [...toasts.value, { id, msg, kind }];
  window.setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 2600);
}

// ---------- 地图选中目标 ----------

export interface SelectedTarget {
  refId: string; kind: string; q: number; r: number; name: string; icon?: string; visibility?: 'unexplored' | 'explored' | 'visible';
}
export const selected = signal<SelectedTarget | null>(null);

/** 已驻扎军选择“行军”后暂存的续行命令；玩家再点地图目标格即可下达。 */
export const garrisonContinue = signal<{ movementId: string } | null>(null);

/** 地图相机中心（环面坐标 q,r）；跳转/拖拽后写入，供 refresh 与 HexMap 共享。 */
export const mapCenter = signal<{ q: number; r: number } | null>(null);

// ---------- 次级数据源（不在主刷新包里、按需拉取的面板数据） ----------

/** 雇佣兵营地快照（GetMercCamp）。营地弹层打开时按 push 事件重拉。 */
export const mercCamp = signal<any>(null);
/** 贸易中心快照（GetTradeCenter）。 */
export const tradeCenter = signal<any>(null);
/** 科技树快照（research.GetTechTree）。 */
export const techTree = signal<any>(null);
/** 学院/科研状态快照（research.GetState）。 */
export const researchState = signal<any>(null);
/** 进行中战斗的实时快照：battleId → 双方兵力聚合（来自 BattleTick 推送）。 */
export const battles = signal<Record<string, any>>({});

/** 视野内的外国军队（脱敏）快照（ListForeign）。地图页定时轮询填充，供 HexMap 渲染与 TargetPanel 展示。 */
export const foreignMoves = signal<any>(null);

// ---------- 任务数据（服务端快照 + 推送，按 villageId 分桶） ----------

/** 任务完整快照：villageId → task.GetState 的 payload（active/offered/completed）。 */
export const taskStates = signal<Record<string, any>>({});
/** 任务营地地图标记：villageId → [{id,q,r,cleared}]。 */
export const taskMarkers = signal<Record<string, any[]>>({});

/** 写入/更新某村的完整任务快照（同时派生地图标记）。 */
export function setTaskState(payload: any): void {
  if (!payload?.villageId) return;
  const vid = payload.villageId as string;
  taskStates.value = { ...taskStates.value, [vid]: payload };
  // 已清理营地仍会留在任务快照里显示进度，但不能成为地图标记。
  // 同时过滤可抵御旧服务端推送、缓存快照或消息乱序造成的幽灵标记。
  const camps: any[] = (payload.active ?? [])
    .flatMap((a: any) => (a.camps ?? []))
    .filter((camp: any) => !camp?.cleared);
  taskMarkers.value = { ...taskMarkers.value, [vid]: camps };
}

/** 单独推送的地图标记更新（TaskMapUpdated）。 */
export function setTaskMarkers(payload: any): void {
  if (!payload?.villageId) return;
  const camps = Array.isArray(payload.camps) ? payload.camps.filter((camp: any) => !camp?.cleared) : [];
  taskMarkers.value = { ...taskMarkers.value, [payload.villageId as string]: camps };
}

/** 读取当前村庄的任务快照（无则返回 null）。 */
export function currentTaskState(): any | null {
  const vid = (typeof me !== 'undefined' && me?.villageId) || null;
  if (!vid) return null;
  return taskStates.value[vid] ?? null;
}

/**
 * 写入战斗快照。**必须是合并而非覆盖**：
 * `BattleStarted` 带 `attackPower/defensePower/targetKind/targetId`，
 * 而随后每 tick 的 `BattleTick` 只带双方兵力表 —— 直接覆盖会把那些字段抹掉，
 * 战斗面板就再也拿不到攻防数值和目标信息了。
 */
export function putBattle(payload: any): void {
  if (!payload?.battleId) return;
  const prev = battles.value[payload.battleId];
  battles.value = { ...battles.value, [payload.battleId]: { ...prev, ...payload } };
}
export function dropBattle(battleId: string): void {
  if (!battleId || !battles.value[battleId]) return;
  const next = { ...battles.value };
  delete next[battleId];
  battles.value = next;
}

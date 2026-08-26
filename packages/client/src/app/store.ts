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
import type { ListForeignPayload, ForeignArmy } from '@slg/shared';
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
export type TabKey = 'village' | 'army' | 'map' | 'tech' | 'tasks' | 'reports';
export const tab = signal<TabKey>('village');

/** 登录态版本号（登录/切村后自增，驱动整壳重渲）。 */
export const sessionVersion = signal(0);
export function bumpSession(): void { sessionVersion.value++; }

/** 当前村庄正在切换时的全局互斥状态；切换完成前禁止向旧村庄发起操作。 */
export interface VillageSwitchState {
  targetVillageId: string;
  targetVillageName: string;
}
export const villageSwitching = signal<VillageSwitchState | null>(null);
export function beginVillageSwitch(targetVillageId: string, targetVillageName: string): boolean {
  if (villageSwitching.value) return false;
  villageSwitching.value = { targetVillageId, targetVillageName };
  return true;
}
export function endVillageSwitch(): void { villageSwitching.value = null; }

/** 非地图页切村时暂不拉整张地图，进入地图页再补拉。 */
export const mapAreaStale = signal(false);

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
  taskInfo?: TaskCampInfo;
}
export const selected = signal<SelectedTarget | null>(null);

/** 已驻扎军选择“行军”后暂存的续行命令；玩家再点地图目标格即可下达。 */
export const garrisonContinue = signal<{ movementId: string; movementType?: 'garrison' | 'ambush' } | null>(null);

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

/** 视野内的外国军队（脱敏）快照（ListForeign）。由 ForeignArmyStep/ForeignArmyRemoved 推送增量更新，供 HexMap 渲染与 TargetPanel 展示。 */
export const foreignMoves = signal<ListForeignPayload | null>(null);

/** 增量更新：插入或替换一条外国军队记录。 */
export function patchForeignArmy(army: ForeignArmy): void {
  const prev = foreignMoves.value?.movements ?? [];
  const idx = prev.findIndex((m) => m.id === army.id);
  const next = idx >= 0
    ? [...prev.slice(0, idx), army, ...prev.slice(idx + 1)]
    : [...prev, army];
  foreignMoves.value = { movements: next };
}

/** 增量更新：移除一条外国军队记录。 */
export function dropForeignArmy(id: string): void {
  const prev = foreignMoves.value?.movements ?? [];
  const next = prev.filter((m) => m.id !== id);
  if (next.length !== prev.length) foreignMoves.value = { movements: next };
}

// ---------- 任务数据（服务端快照 + 推送，按 villageId 分桶） ----------

/** 任务完整快照：villageId → task.GetState 的 payload（active/offered/completed）。 */
export const taskStates = signal<Record<string, any>>({});
/** 玩家任务页聚合快照；任务执行仍通过每条记录携带的 villageId 定位来源村庄。 */
export const playerTaskState = signal<any | null>(null);
/** 玩家级王国任务与当前村议会厅服务快照。 */
export const kingdomState = signal<any | null>(null);
/** 任务营地地图标记：villageId → [{id,q,r,cleared}]。 */
export const taskMarkers = signal<Record<string, any[]>>({});

/** 地图详情使用的任务营地关联信息（由任务快照中的父任务实例派生）。 */
export interface TaskCampInfo {
  code: string;
  name: string;
  desc: string;
  type?: string;
  scope?: string;
  campCleared?: number;
  campTotal?: number;
  villageId?: string;
  objective?: Record<string, unknown> | null;
}

function decorateTaskCamps(active: any[]): any[] {
  return active
    .flatMap((task: any) => {
      const hasInfo = Boolean(task.code || task.name || task.desc || task.objective);
      const taskInfo = hasInfo ? {
        code: String(task.code ?? ''),
        name: String(task.name ?? task.code ?? '任务'),
        desc: String(task.desc ?? ''),
        type: typeof task.type === 'string' ? task.type : undefined,
        scope: typeof task.scope === 'string' ? task.scope : undefined,
        campCleared: Number(task.campCleared ?? 0),
        campTotal: Number(task.campTotal ?? task.camps?.length ?? 0),
        villageId: typeof task.villageId === 'string' ? task.villageId : undefined,
        objective: task.objective ?? null,
      } satisfies TaskCampInfo : undefined;
      const camps = (task?.camps ?? []).map((camp: any) => ({
        ...camp,
        ...(taskInfo ? { taskInfo } : {}),
      }));
      const taskVillage = task?.taskVillageId && task?.taskVillageXY
        ? [{
          id: String(task.taskVillageId),
          q: Number(task.taskVillageXY.q),
          r: Number(task.taskVillageXY.r),
          cleared: false,
          taskVillage: true,
          name: '天王老子村',
          ...(taskInfo ? { taskInfo } : {}),
        }]
        : [];
      return [...camps, ...taskVillage];
    })
    .filter((camp: any) => !camp?.cleared);
}

/** 写入/更新某村的完整任务快照（同时派生地图标记）。 */
export function setTaskState(payload: any): void {
  if (!payload?.villageId) return;
  const vid = payload.villageId as string;
  taskStates.value = { ...taskStates.value, [vid]: payload };
  // 已清理营地仍会留在任务快照里显示进度，但不能成为地图标记。
  // 同时过滤可抵御旧服务端推送、缓存快照或消息乱序造成的幽灵标记。
  const camps = decorateTaskCamps(payload.active ?? []);
  taskMarkers.value = { ...taskMarkers.value, [vid]: camps };
}

export function setPlayerTaskState(payload: any): void {
  if (!payload) return;
  playerTaskState.value = payload;
  // 聚合响应也回填按村缓存，地图任务标记和旧组件仍能正常工作。
  // 全局任务只持久化在玩家锚点村，但其营地对玩家名下所有村庄都可见；
  // 旧实现只写 villages，切换村庄后地图会继续显示另一村的旧营地坐标。
  const globalCamps = decorateTaskCamps(payload.global?.active ?? []);
  for (const village of (payload.villages ?? [])) {
    setTaskState(village);
    const vid = village?.villageId as string | undefined;
    if (!vid) continue;
    const localCamps = taskMarkers.value[vid] ?? [];
    const byId = new Map<string, any>();
    for (const camp of [...globalCamps, ...localCamps]) {
      if (camp?.id) byId.set(String(camp.id), camp);
    }
    taskMarkers.value = { ...taskMarkers.value, [vid]: [...byId.values()] };
  }
}

/** 单独推送的地图标记更新（TaskMapUpdated）。 */
export function setTaskMarkers(payload: any): void {
  if (!payload?.villageId) return;
  const previous = taskMarkers.value[payload.villageId as string] ?? [];
  const previousById = new Map(previous.filter((camp: any) => camp?.id).map((camp: any) => [String(camp.id), camp]));
  const camps = Array.isArray(payload.camps)
    ? payload.camps
      .map((camp: any) => ({ ...(previousById.get(String(camp?.id)) ?? {}), ...camp }))
      .filter((camp: any) => !camp?.cleared)
    : [];
  taskMarkers.value = { ...taskMarkers.value, [payload.villageId as string]: camps };
}

/** 按地图目标坐标/引用查找任务营地，供目标详情补全任务名称与说明。 */
export function findTaskCampMarker(refId: string | undefined, q: number, r: number): any | undefined {
  for (const camps of Object.values(taskMarkers.value)) {
    const match = camps.find((camp: any) =>
      !camp?.cleared
      && (refId ? String(camp.id) === refId : true)
      && Number(camp.q) === q
      && Number(camp.r) === r,
    );
    if (match) return match;
  }
  return undefined;
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

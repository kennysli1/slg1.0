/**
 * 任务卡中依赖服务端就绪状态的进度投影。
 *
 * M1 有一个隐藏的 success 条件：四块资源田在任务激活前已经没有待修复
 * 状态时，服务端会直接把任务标记为可交付。此时 repairedBuildings 仍可能
 * 是空数组，因此任务卡不能只依赖事件累计列表判断单项是否完成。
 */
export interface RepairTaskState {
  ready?: boolean;
  repairedBuildings?: string[];
}

export function isRepairBuildingDone(task: RepairTaskState, kind: string): boolean {
  return task.ready === true || (task.repairedBuildings ?? []).includes(kind);
}

export function hasRepairBuildingPending(task: RepairTaskState, buildingKinds: string[]): boolean {
  return task.ready !== true && buildingKinds.some((kind) => !isRepairBuildingDone(task, kind));
}

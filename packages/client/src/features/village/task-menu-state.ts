/**
 * 任务页菜单展开状态。
 *
 * 这是纯 UI 偏好，不属于游戏存档：按玩家 id 分桶写入浏览器本地存储，
 * 因此刷新页面或重新进入任务页时会恢复上次的一级/二级/三级菜单状态。
 */

export type TaskMenuOpenState = Record<string, boolean>;

export interface TaskMenuStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'kow.task-menu-open.';

export function taskMenuStorageKey(playerId: string): string {
  return `${PREFIX}${playerId || 'guest'}`;
}

export function readTaskMenuOpenState(playerId: string, storage?: TaskMenuStorage): TaskMenuOpenState {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!target) return {};
  try {
    const raw = target.getItem(taskMenuStorageKey(playerId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'boolean'),
    ) as TaskMenuOpenState;
  } catch {
    return {};
  }
}

export function writeTaskMenuOpenState(playerId: string, state: TaskMenuOpenState, storage?: TaskMenuStorage): void {
  const target = storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined);
  if (!target) return;
  try {
    target.setItem(taskMenuStorageKey(playerId), JSON.stringify(state));
  } catch {
    // 隐私模式/存储配额不足时退化为本次页面状态，不影响任务功能。
  }
}

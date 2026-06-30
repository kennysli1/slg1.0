/**
 * 接入层 · 模块清单（Manifest）声明式注册
 * 对应 review1.0 §8.4 / 阶段C：把"模块实现了命令"和"网关能路由到它"绑在一起，
 * 减少"模块已实现但前端调不到（漏配网关）"的失误。
 *
 * 每个领域模块导出一个 ModuleManifest，列出：
 *  - publicActions：对外动作名 → 内部命令名 + 鉴权/自己村标记
 *  - eventPushMap：内部事件名 → 对外推送事件名
 * Gateway 启动时汇总所有 manifest 生成 ACTION_ROUTES / EVENT_TO_PUSH。
 *
 * 这是"自描述优先"：新增一个 action，只在对应模块的 manifest 加一行即可，
 * 不必再回头改 gateway.ts。
 */

/** 单条对外动作的路由声明。 */
export interface ActionRoute {
  /** 内部命令名（CommandBus 注册名，如 'building.UpgradeBuilding'） */
  command: string;
  /** true=作用于"玩家自己的村"，Gateway 强制注入会话 villageId（防伪造他人村） */
  ownVillage?: boolean;
  /** true=需登录态 */
  needAuth?: boolean;
}

export interface ModuleManifest {
  moduleName: string;
  /** 对外动作名 → 路由 */
  publicActions: Record<string, ActionRoute>;
  /** 内部事件名 → 对外推送事件名（payload 须含 villageId 用于定向投递） */
  eventPushMap?: Record<string, string>;
}

/** 汇总多个 manifest 为 Gateway 用的扁平路由表（重复 action/event 名会抛错，提前暴露冲突）。 */
export function aggregateManifests(manifests: ModuleManifest[]): {
  actionRoutes: Record<string, ActionRoute>;
  eventToPush: Record<string, string>;
} {
  const actionRoutes: Record<string, ActionRoute> = {};
  const eventToPush: Record<string, string> = {};
  for (const m of manifests) {
    for (const [action, route] of Object.entries(m.publicActions)) {
      if (actionRoutes[action]) {
        throw new Error(`[Manifest] 动作名冲突 "${action}"（模块 ${m.moduleName}）`);
      }
      actionRoutes[action] = route;
    }
    for (const [internal, push] of Object.entries(m.eventPushMap ?? {})) {
      if (eventToPush[internal]) {
        throw new Error(`[Manifest] 事件名冲突 "${internal}"（模块 ${m.moduleName}）`);
      }
      eventToPush[internal] = push;
    }
  }
  return { actionRoutes, eventToPush };
}

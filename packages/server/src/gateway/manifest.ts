/**
 * 接入层路由声明。只描述外部 action、鉴权、会话注入和 payload 校验。
 *
 * routes.ts 按业务域分组列出：
 *  - publicActions：对外动作名 → 内部命令名 + 鉴权/自己村标记
 *  - eventPushMap：内部事件名 → 对外推送事件名
 * Gateway 启动时汇总所有 manifest 生成 ACTION_ROUTES / EVENT_TO_PUSH。
 *
 * 领域模块不 import 本文件，避免领域层反向依赖接入层。
 */

export type { FieldSchema, PayloadSchema } from './validate.js';
import type { PayloadSchema } from './validate.js';

/** 单条对外动作的路由声明。 */
export interface ActionRoute {
  /** 内部命令名（CommandBus 注册名，如 'building.UpgradeBuilding'） */
  command: string;
  /** true=作用于"玩家自己的村"，Gateway 强制注入会话 villageId（防伪造他人村） */
  ownVillage?: boolean;
  /** true=需登录态 */
  needAuth?: boolean;
  /** true=Gateway 强制注入会话 playerId（防伪造他人身份） */
  injectPlayerId?: boolean;
  /**
   * payload 校验 schema。Gateway 在派发前：
   *  1. 按 schema 校验类型/范围/长度/枚举；
   *  2. 剥离未声明字段；
   *  3. 再执行 ownVillage 注入。
   * schema={} 表示 payload 必须是空对象（不接受任何客户端字段）。
   */
  schema?: PayloadSchema;
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

/**
 * 边界② · 框架内信封：模块 ↔ 模块（进程内/未来跨服务）
 * 对应设计文档 04_通信格式规范.md 边界②
 *
 * Command：A 模块请 B 模块做事，等返回（写操作、需立即确认成败）
 * Event：某模块状态变了，广播（通知、解耦）
 */

/**
 * Command 信封：name/from/payload 三件套固定，payload 自由。
 * 例：TrySpend{ village, cost:{...} }
 */
export interface Command<P = Record<string, unknown>> {
  /** 命令名 */
  name: string;
  /** 发起方模块名 */
  from: string;
  /** 命令内容，自由 */
  payload: P;
}

/** Command 的返回信封 */
export interface CommandResult<R = Record<string, unknown>> {
  ok: boolean;
  payload: R;
  /** 失败原因，如 "insufficient:wood" */
  reason?: string;
}

/**
 * Event 信封：name/source/ts/payload。
 * 例：BuildingUpgraded{ village, building, level }
 */
export interface DomainEvent<P = Record<string, unknown>> {
  /** 事件名 */
  name: string;
  /** 来源模块名 */
  source: string;
  /** 发生时间戳(ms) */
  ts: number;
  /** 事件内容，自由 */
  payload: P;
}

/** 命令处理器签名：领域模块注册自己能处理的 Command */
export type CommandHandler<P = any, R = any> = (
  cmd: Command<P>,
) => CommandResult<R> | Promise<CommandResult<R>>;

/** 事件处理器签名：订阅者响应 Event */
export type EventHandler<P = any> = (evt: DomainEvent<P>) => void | Promise<void>;

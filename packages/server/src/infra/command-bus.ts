import type { Command, CommandResult, CommandHandler } from '@slg/shared';

/**
 * 基础设施 · 命令总线
 * 对应设计文档 04_通信格式规范.md 边界②(Command)
 *
 * 职责：领域模块注册自己能处理的 Command（按命令名）；
 * 调用方通过 send() 发命令并等待结果。
 *
 * 与 EventBus 的区别：
 * - Command 是一对一、要返回结果（写操作/需确认）；每个命令名只能有一个处理器。
 * - Event 是一对多、无返回（通知/解耦）。
 */
export class CommandBus {
  private handlers = new Map<string, CommandHandler>();

  /** 注册一个命令处理器。命令名重复注册会报错（避免静默覆盖）。 */
  register<P = any, R = any>(name: string, handler: CommandHandler<P, R>): void {
    if (this.handlers.has(name)) {
      throw new Error(`[CommandBus] command "${name}" already registered`);
    }
    this.handlers.set(name, handler as CommandHandler);
  }

  /** 发送一个命令，等待结果。无处理器则返回失败。 */
  async send<P = any, R = any>(cmd: Command<P>): Promise<CommandResult<R>> {
    const handler = this.handlers.get(cmd.name);
    if (!handler) {
      return { ok: false, payload: {} as R, reason: `no_handler:${cmd.name}` };
    }
    return (await handler(cmd)) as CommandResult<R>;
  }
}

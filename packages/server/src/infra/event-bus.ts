import type { DomainEvent, EventHandler } from '@slg/shared';

/**
 * 基础设施 · 事件总线
 * 对应设计文档 03_架构总览.md 第四节、04_通信格式规范.md 边界②(Event)
 *
 * 职责：模块广播 Event，订阅者按事件名接收。发布者不关心谁在听（解耦）。
 * 不含任何游戏逻辑。
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  /** 订阅某事件名。返回取消订阅的函数。 */
  on<P = any>(eventName: string, handler: EventHandler<P>): () => void {
    let set = this.handlers.get(eventName);
    if (!set) {
      set = new Set();
      this.handlers.set(eventName, set);
    }
    set.add(handler as EventHandler);
    return () => set!.delete(handler as EventHandler);
  }

  /** 广播一个事件。异步处理器的错误被隔离，不影响其它订阅者。 */
  async emit<P = any>(evt: DomainEvent<P>): Promise<void> {
    const set = this.handlers.get(evt.name);
    if (!set || set.size === 0) return;
    // 拷贝一份，避免处理器在回调里增删订阅导致迭代异常
    const handlers = [...set];
    await Promise.all(
      handlers.map(async (h) => {
        try {
          await h(evt);
        } catch (err) {
          // 单个订阅者出错不应影响其它订阅者
          console.error(`[EventBus] handler error for "${evt.name}":`, err);
        }
      }),
    );
  }
}

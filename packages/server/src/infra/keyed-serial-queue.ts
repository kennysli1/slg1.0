/**
 * 基础设施 · KeyedSerialQueue（按 key FIFO 串行队列）
 *
 * 同一 key 下的异步任务严格串行：后来者排队等待前驱完成后才执行。
 * 不同 key 的任务完全独立、可并行。
 *
 * 设计约束：
 *  - 不在领域模块内直接使用（铁律#2：模块间只传 Command/Event）。
 *  - 由接入层（Gateway）注入，用于把同一村庄的并发写请求串行化。
 *  - Scheduler 任务可选地通过同一实例排队（传入 key 时）。
 *  - 不做死锁检测：调用方不得在 fn 内部等待同一 key 的另一个 run() 调用
 *    （即 Gateway 层的 ownVillage 请求不能触发另一个 Gateway 层的请求，
 *    内部 CommandBus 调用绕过此队列，不存在自锁）。
 */
export class KeyedSerialQueue {
  private queues = new Map<string, Promise<void>>();

  /**
   * 将 fn 加入 key 对应的串行队列并返回其执行结果的 Promise。
   * 若 key 当前无排队任务，fn 立即执行。
   * fn 抛出的错误不会阻断该 key 后续任务的执行。
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    // next: 等前驱完成后执行 fn（即使前驱失败也继续）
    const next = prev.then(() => fn());
    // 存入队列的链节：把 fn 的错误吞掉，避免影响下一个任务
    const chain = next.then((): void => undefined, (): void => undefined);
    this.queues.set(key, chain);
    // 当该链节结算后清除条目（防 Map 无界增长）
    chain.then(() => {
      if (this.queues.get(key) === chain) this.queues.delete(key);
    });
    return next;
  }

  /**
   * 清除所有等待队列（刷档 / 测试重置用）。
   * 已在执行中的任务不受影响（Node.js 单线程，当前 await 链路结束后自然终止）。
   */
  reset(): void {
    this.queues.clear();
  }

  /** 当前排队中的 key 数（测试/监控用）。 */
  get size(): number {
    return this.queues.size;
  }
}

/** WebSocket OPEN readyState，避免业务代码依赖具体 ws 实现。 */
const WS_OPEN = 1;

export interface BufferedSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** 发送前检查发送缓冲，慢客户端超过上限时主动断开，避免进程内存持续增长。 */
export function sendWithBackpressure(socket: BufferedSocket, data: string, maxBufferedBytes: number): boolean {
  if (socket.readyState !== WS_OPEN) return false;
  if (socket.bufferedAmount + Buffer.byteLength(data) > maxBufferedBytes) {
    try { socket.close(1013, 'client too slow'); } catch { /* ignore */ }
    return false;
  }

  try {
    socket.send(data);
    return true;
  } catch {
    try { socket.close(1011, 'send failed'); } catch { /* ignore */ }
    return false;
  }
}

/** 单连接串行执行器：限制正在处理与等待处理的消息总数。 */
export class BoundedSerialExecutor {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly maxQueued: number) {
    if (!Number.isInteger(maxQueued) || maxQueued < 1) throw new Error('maxQueued must be a positive integer');
  }

  get pending(): number { return this.queued; }

  enqueue(task: () => Promise<void>): boolean {
    if (this.queued >= this.maxQueued) return false;
    this.queued++;
    const run = this.tail.then(task);
    this.tail = run
      .catch(() => { /* 保持后续队列可运行 */ })
      .finally(() => { this.queued--; });
    return true;
  }
}

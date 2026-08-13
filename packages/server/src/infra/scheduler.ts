/**
 * 基础设施 · 调度器
 * 对应设计文档 03_架构总览.md 第四节、08_系统逻辑详解.md §2(时间与事件系统)
 *
 * 职责：登记"未来某时刻触发某任务"，到点回调。全游戏唯一时间源。
 * 模块不自己藏定时器，统一登记到这里——便于崩溃恢复与测试快进。
 *
 * 设计要点：
 * - now() 可注入：生产用真实时间；测试用假时钟，可瞬间快进，不必真等。
 * - ownerKey：任务可携带业务 owner 标识（如 "building:v-p-1"），支持按 owner 批量取消。
 * - serializationKey：任务可携带串行化 key（如 "village:v-p-1"），运行时通过
 *   共享 KeyedSerialQueue 与同 key 的 Gateway 请求严格串行，消除定时任务与
 *   WS 请求之间的写竞争。不设此 key 的任务（movement/pve/battle）不参与村级车道。
 * - 重入保护：fireDue 执行期间再次触发的定时器回调会被安全忽略，
 *   等当前批次结束后由 arm() 重新调度，不会丢任务。
 */

import type { KeyedSerialQueue } from './keyed-serial-queue.js';

export interface ScheduledTask {
  id: string;
  /** 触发时刻(ms, epoch) */
  triggerAt: number;
  /** 到点执行的逻辑 */
  run: () => void | Promise<void>;
  /** 同一时刻多任务的二级排序键，保证可复现（对应设计 §13.6） */
  seq: number;
  /**
   * 业务 owner 标识（可选）。用于 cancelByOwner 按业务实体批量取消。
   * 示例："building:v-p-1"、"military:v-p-1"、"combat:bt-3"。
   */
  ownerKey?: string;
  /**
   * 串行化 key（可选）。若设置，任务通过共享 KeyedSerialQueue 执行，
   * 与 Gateway 同 key 请求严格 FIFO，消除写竞争。
   * 约定：村级任务用 "village:<villageId>"；战斗用 "battle:<battleId>"；
   *       PvE 用 "pve:<pveId>"；行军用 "movement:<mvId>"。
   */
  serializationKey?: string;
}

export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seqCounter = 0;
  private nextId = 1;
  /** 重入保护：fireDue 执行期间为 true，防止定时器并发触发。 */
  private running = false;

  constructor(
    /** 当前时间源，默认真实时间；测试可注入假时钟 */
    private now: () => number = () => Date.now(),
    /**
     * 手动模式：不挂真实 setTimeout，完全由 advanceTo 驱动触发。
     * 测试中配合假时钟使用，避免真实定时器与假时钟不一致导致进程挂死。
     */
    private manual: boolean = false,
    /**
     * 共享串行队列（可选）。注入后，带 serializationKey 的任务会通过此队列
     * 与 Gateway 同 key 请求串行执行，消除定时任务与 WS 请求之间的写竞争。
     */
    private serialQueue?: KeyedSerialQueue,
  ) {}

  /**
   * 登记一个延时任务。delayMs 从现在起算。返回任务 id。
   * @param ownerKey         可选业务标识，用于 cancelByOwner 批量取消。
   * @param serializationKey 可选串行化 key，通过共享队列与 Gateway 请求共用同一车道。
   */
  schedule(
    delayMs: number,
    run: () => void | Promise<void>,
    ownerKey?: string,
    serializationKey?: string,
  ): string {
    const id = `task-${this.nextId++}`;
    const task: ScheduledTask = {
      id,
      triggerAt: this.now() + Math.max(0, delayMs),
      run,
      seq: this.seqCounter++,
      ownerKey,
      serializationKey,
    };
    this.insert(task);
    this.arm();
    return id;
  }

  /** 在绝对时刻触发。 */
  scheduleAt(
    triggerAt: number,
    run: () => void | Promise<void>,
    ownerKey?: string,
    serializationKey?: string,
  ): string {
    const id = `task-${this.nextId++}`;
    this.insert({ id, triggerAt, run, seq: this.seqCounter++, ownerKey, serializationKey });
    this.arm();
    return id;
  }

  /** 取消一个尚未触发的任务（按 id）。 */
  cancel(id: string): boolean {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    return true;
  }

  /**
   * 取消所有属于 ownerKey 的未触发任务，返回取消数量。
   * 用于批量清除某村庄/某战场的全部待处理任务（如删除玩家、刷档时）。
   */
  cancelByOwner(ownerKey: string): number {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.ownerKey !== ownerKey);
    return before - this.tasks.length;
  }

  /**
   * 清空所有待处理任务，重置定时器（刷档 / 测试重置用）。
   * 正在执行中的任务不受影响（Node.js 单线程，当前 await 链路结束后自然终止）。
   */
  reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.tasks = [];
  }

  /** 按 triggerAt、再按 seq 有序插入，保证同刻任务确定性处理顺序。 */
  private insert(task: ScheduledTask): void {
    let lo = 0;
    let hi = this.tasks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = this.tasks[mid];
      if (t.triggerAt < task.triggerAt || (t.triggerAt === task.triggerAt && t.seq < task.seq)) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.tasks.splice(lo, 0, task);
  }

  /** 设置定时器指向最近的任务。手动模式下不挂真实定时器。 */
  private arm(): void {
    if (this.manual) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const head = this.tasks[0];
    if (!head) return;
    const delay = Math.max(0, head.triggerAt - this.now());
    this.timer = setTimeout(() => void this.fireDue(), delay);
    // 调度任务不应单独阻止进程退出（测试、管理命令与优雅停服都依赖这一点）。
    this.timer.unref?.();
  }

  /**
   * 触发所有到期任务（含因延迟而堆积的多个）。
   *
   * 重入保护：若前一批次尚未执行完（某任务内有 await），本次调用直接返回。
   * 重入的定时器触发安全忽略——当前批次结束后 arm() 会重新计算并设置下一个定时器，
   * 确保任何到期任务最终都会被执行，不会永久丢失。
   *
   * 串行化：带 serializationKey 的任务通过共享 KeyedSerialQueue 执行，
   * 与 Gateway 同 key 请求共用同一车道，确保同村定时任务与 WS 请求严格 FIFO。
   */
  private async fireDue(): Promise<void> {
    if (this.running) return; // 重入保护：忽略并发触发
    this.running = true;
    try {
      const t = this.now();
      while (this.tasks.length && this.tasks[0].triggerAt <= t) {
        const task = this.tasks.shift()!;
        try {
          if (task.serializationKey && this.serialQueue) {
            await this.serialQueue.run(task.serializationKey, () => Promise.resolve(task.run()));
          } else {
            await task.run();
          }
        } catch (err) {
          console.error(`[Scheduler] task "${task.id}" run error:`, err);
        }
      }
    } finally {
      this.running = false;
    }
    this.arm();
  }

  /**
   * 测试用：把假时钟推进到指定时刻，并同步触发期间所有到期任务。
   * 仅当 now 为可控假时钟时有意义。
   */
  async advanceTo(t: number, setClock: (t: number) => void): Promise<void> {
    setClock(t);
    await this.fireDue();
  }

  /** 当前待处理任务数（测试/监控用）。 */
  get pending(): number {
    return this.tasks.length;
  }
}

/**
 * 基础设施 · 调度器
 * 对应设计文档 03_架构总览.md 第四节、08_系统逻辑详解.md §2(时间与事件系统)
 *
 * 职责：登记"未来某时刻触发某任务"，到点回调。全游戏唯一时间源。
 * 模块不自己藏定时器，统一登记到这里——便于崩溃恢复与测试快进。
 *
 * 设计要点：
 * - now() 可注入：生产用真实时间；测试用假时钟，可瞬间快进，不必真等。
 * - 任务持久化交给 Persistence（骨架阶段先内存），重启后可重建（后续实现）。
 */

export interface ScheduledTask {
  id: string;
  /** 触发时刻(ms, epoch) */
  triggerAt: number;
  /** 到点执行的逻辑 */
  run: () => void | Promise<void>;
  /** 同一时刻多任务的二级排序键，保证可复现（对应设计 §13.6） */
  seq: number;
}

export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seqCounter = 0;
  private nextId = 1;

  constructor(
    /** 当前时间源，默认真实时间；测试可注入假时钟 */
    private now: () => number = () => Date.now(),
    /**
     * 手动模式：不挂真实 setTimeout，完全由 advanceTo 驱动触发。
     * 测试中配合假时钟使用，避免真实定时器与假时钟不一致导致进程挂死。
     */
    private manual: boolean = false,
  ) {}

  /** 登记一个延时任务。delayMs 从现在起算。返回任务 id。 */
  schedule(delayMs: number, run: () => void | Promise<void>): string {
    const id = `task-${this.nextId++}`;
    const task: ScheduledTask = {
      id,
      triggerAt: this.now() + Math.max(0, delayMs),
      run,
      seq: this.seqCounter++,
    };
    this.insert(task);
    this.arm();
    return id;
  }

  /** 在绝对时刻触发。 */
  scheduleAt(triggerAt: number, run: () => void | Promise<void>): string {
    const id = `task-${this.nextId++}`;
    this.insert({ id, triggerAt, run, seq: this.seqCounter++ });
    this.arm();
    return id;
  }

  /** 取消一个尚未触发的任务。 */
  cancel(id: string): boolean {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.tasks.splice(idx, 1);
    return true;
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
  }

  /** 触发所有到期任务（含因延迟而堆积的多个）。 */
  private async fireDue(): Promise<void> {
    const t = this.now();
    while (this.tasks.length && this.tasks[0].triggerAt <= t) {
      const task = this.tasks.shift()!;
      try {
        await task.run();
      } catch (err) {
        console.error(`[Scheduler] task "${task.id}" run error:`, err);
      }
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

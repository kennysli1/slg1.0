/**
 * 基础设施 · 持久化层
 * 对应设计文档 03_架构总览.md 第四节、05_技术栈与工程结构.md(数据存储分阶段)
 *
 * 职责：封装数据的读写。对外是接口；领域模块各自持有自己的集合
 * （村庄、建筑、部队…），互不直接访问彼此的集合。
 *
 * 提供两种实现：
 *  - MemoryStore：纯内存，测试用。
 *  - JsonFileStore：内存操作 + 落盘 JSON，重启数据不丢，生产用。
 * 以后要换 SQLite/PostgreSQL 只改本层，领域模块零改动。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Store {
  /** 读一个文档。不存在返回 undefined。 */
  get<T>(collection: string, key: string): T | undefined;
  /** 写一个文档（覆盖）。 */
  set<T>(collection: string, key: string, value: T): void;
  /** 删除一个文档。 */
  delete(collection: string, key: string): boolean;
  /** 列出某集合所有文档（骨架阶段够用；DB 阶段会换成带条件查询）。 */
  all<T>(collection: string): T[];
}

/** 内存实现：关机即失，仅用于测试与快速验证。 */
export class MemoryStore implements Store {
  protected data = new Map<string, Map<string, unknown>>();

  protected col(collection: string): Map<string, unknown> {
    let c = this.data.get(collection);
    if (!c) {
      c = new Map();
      this.data.set(collection, c);
    }
    return c;
  }

  get<T>(collection: string, key: string): T | undefined {
    return this.col(collection).get(key) as T | undefined;
  }

  set<T>(collection: string, key: string, value: T): void {
    this.col(collection).set(key, value);
  }

  delete(collection: string, key: string): boolean {
    return this.col(collection).delete(key);
  }

  all<T>(collection: string): T[] {
    return [...this.col(collection).values()] as T[];
  }
}

/**
 * JSON 文件实现：数据在内存（读写快），变更后防抖写盘（原子替换）。
 * 适合轻量服务器 + 几十人规模；零原生依赖、跨平台。
 * 启动时从文件载入；以后换 SQLite/PG 只换这个类。
 */
export class JsonFileStore extends MemoryStore {
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private filePath: string,
    /** 防抖写盘间隔(ms)：变更后最多等这么久落盘 */
    private flushDelayMs = 1000,
  ) {
    super();
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const obj = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      for (const [coll, docs] of Object.entries(obj)) {
        const c = this.col(coll);
        for (const [k, v] of Object.entries(docs)) c.set(k, v);
      }
    } catch (err) {
      console.error('[JsonFileStore] 载入失败，从空开始:', err);
    }
  }

  set<T>(collection: string, key: string, value: T): void {
    super.set(collection, key, value);
    this.markDirty();
  }

  delete(collection: string, key: string): boolean {
    const r = super.delete(collection, key);
    if (r) this.markDirty();
    return r;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs);
  }

  /** 立即写盘（原子：写临时文件再 rename）。进程退出前应调用一次。 */
  flush(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.dirty) return;
    const obj: Record<string, Record<string, unknown>> = {};
    for (const [coll, c] of this.data) {
      obj[coll] = {};
      for (const [k, v] of c) obj[coll][k] = v;
    }
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj));
    renameSync(tmp, this.filePath);
    this.dirty = false;
  }
}


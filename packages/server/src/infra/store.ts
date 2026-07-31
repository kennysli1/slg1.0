/**
 * 基础设施 · 持久化层
 * 对应设计文档 03_架构总览.md 第四节、05_技术栈与工程结构.md(数据存储分阶段)
 *
 * 职责：封装数据的读写。对外是接口；领域模块各自持有自己的集合
 * （村庄、建筑、部队…），互不直接访问彼此的集合。
 *
 * 提供两种实现：
 *  - MemoryStore：纯内存，测试用。
 *  - JsonFileStore：内存操作 + JSONL WAL + 全量快照，重启数据不丢，生产用。
 *
 * 持久化路径（单进程、零原生依赖）：
 *  1. 每次 set/delete/clear → 先追加 WAL 并 fsync，再改内存（崩溃最多丢未落 WAL 的当前调用）。
 *  2. 防抖生成全量快照（原子写：tmp → fsync → rename），成功后截断 WAL。
 *  3. 启动：载入快照 + 回放 WAL；坏档拒绝空启动，避免覆盖原数据。
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  appendFileSync,
  truncateSync,
  unlinkSync,
} from 'node:fs';
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
  /** 清空整个集合（运维/刷档用）。集合不存在则无操作。 */
  clear(collection: string): void;
  /** 列出某集合所有 key。 */
  keys(collection: string): string[];
  /** 列出所有集合名。 */
  collections(): string[];
  /**
   * 立即将脏数据刷到持久化层。
   * MemoryStore 为空操作；JsonFileStore 写全量快照并截断 WAL。
   */
  flush(): void;
}

/** WAL 条目：一行一条 JSON。 */
type WalEntry =
  | { op: 'set'; c: string; k: string; v: unknown }
  | { op: 'delete'; c: string; k: string }
  | { op: 'clear'; c: string };

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

  clear(collection: string): void {
    this.data.get(collection)?.clear();
  }

  keys(collection: string): string[] {
    return [...this.col(collection).keys()];
  }

  collections(): string[] {
    return [...this.data.keys()];
  }

  flush(): void {
    /* 内存实现无持久化 */
  }
}

/**
 * 原子写文件：写临时文件 → fsync → rename 覆盖目标。
 * 保证进程崩溃时不会留下半截目标文件。
 */
function atomicWriteSync(filePath: string, contents: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, contents, null, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  // 尽力同步目录项（Windows 上可能不支持目录 fsync，忽略失败）
  try {
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* ignore */ }
}

/**
 * JSON 文件实现：内存操作 + WAL 即时落盘 + 防抖全量快照。
 * 适合轻量服务器 + 几十人规模；零原生依赖、跨平台。
 */
export class JsonFileStore extends MemoryStore {
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly walPath: string;
  /** 启动回放期间为 true：禁止写 WAL（避免把回放再写入自身）。 */
  private replaying = false;

  constructor(
    private filePath: string,
    /** 防抖写全量快照间隔(ms)：变更后最多等这么久压缩快照并截断 WAL */
    private flushDelayMs = 1000,
  ) {
    super();
    this.walPath = `${filePath}.wal`;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    let loadedSnapshot = false;
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, 'utf8');
        const obj = JSON.parse(raw) as Record<string, Record<string, unknown>>;
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
          throw new Error('存档根节点必须是对象');
        }
        for (const [coll, docs] of Object.entries(obj)) {
          if (!docs || typeof docs !== 'object' || Array.isArray(docs)) {
            throw new Error(`集合 ${coll} 必须是对象`);
          }
          const c = this.col(coll);
          for (const [k, v] of Object.entries(docs)) c.set(k, v);
        }
        loadedSnapshot = true;
      } catch (err) {
        throw new Error(
          `[JsonFileStore] 载入快照失败，拒绝从空存档启动以避免覆盖原数据: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // 回放 WAL（即使无快照，单独的 WAL 也可恢复——例如首次写入后崩溃在 flush 前）
    if (existsSync(this.walPath)) {
      let lines: string[] = [];
      try {
        this.replaying = true;
        const walRaw = readFileSync(this.walPath, 'utf8');
        lines = walRaw.split('\n').filter((l) => l.trim().length > 0);
        for (let i = 0; i < lines.length; i++) {
          let entry: WalEntry;
          try {
            entry = JSON.parse(lines[i]) as WalEntry;
          } catch (err) {
            throw new Error(`WAL 第 ${i + 1} 行 JSON 无效: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.applyWalEntry(entry);
        }
      } catch (err) {
        throw new Error(
          `[JsonFileStore] 回放 WAL 失败，拒绝从空存档启动以避免覆盖原数据: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        this.replaying = false;
      }

      // 有实质条目时压缩：写快照并截断 WAL；空 WAL 文件直接删掉避免每次启动无意义 flush
      if (lines.length > 0) {
        this.dirty = true;
        this.flush();
      } else {
        try { unlinkSync(this.walPath); } catch { /* ignore */ }
      }
    } else if (!loadedSnapshot) {
      // 全新启动：无快照无 WAL，正常
    }
  }

  private applyWalEntry(entry: WalEntry): void {
    if (entry.op === 'set') {
      this.col(entry.c).set(entry.k, entry.v);
    } else if (entry.op === 'delete') {
      this.col(entry.c).delete(entry.k);
    } else if (entry.op === 'clear') {
      this.data.get(entry.c)?.clear();
    } else {
      throw new Error(`未知 WAL 操作: ${(entry as any).op}`);
    }
  }

  /** 追加一条 WAL 并 fsync（崩溃安全）。回放期间跳过。 */
  private appendWal(entry: WalEntry): void {
    if (this.replaying) return;
    const dir = dirname(this.walPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    // appendFileSync 后单独 open+fsync，确保落到磁盘
    appendFileSync(this.walPath, line, 'utf8');
    const fd = openSync(this.walPath, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  set<T>(collection: string, key: string, value: T): void {
    this.appendWal({ op: 'set', c: collection, k: key, v: value });
    super.set(collection, key, value);
    this.markDirty();
  }

  delete(collection: string, key: string): boolean {
    // 即使 key 不存在也写 delete（幂等），但仅在真正删除时 markDirty 以减少无谓快照
    const existed = this.col(collection).has(key);
    if (existed) {
      this.appendWal({ op: 'delete', c: collection, k: key });
    }
    const r = super.delete(collection, key);
    if (r) this.markDirty();
    return r;
  }

  clear(collection: string): void {
    this.appendWal({ op: 'clear', c: collection });
    super.clear(collection);
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs);
  }

  /**
   * 立即写全量快照（原子：tmp → fsync → rename），然后截断 WAL。
   * 进程退出前 / GM 写操作后 / 启动回放后应调用。
   */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;

    const obj: Record<string, Record<string, unknown>> = {};
    for (const [coll, c] of this.data) {
      obj[coll] = {};
      for (const [k, v] of c) obj[coll][k] = v;
    }
    atomicWriteSync(this.filePath, JSON.stringify(obj));

    // 截断 WAL（快照已包含全部状态）
    if (existsSync(this.walPath)) {
      try {
        truncateSync(this.walPath, 0);
        // 也可用 unlink；保留空文件便于运维观察路径存在
      } catch {
        try { unlinkSync(this.walPath); } catch { /* ignore */ }
      }
    }
    this.dirty = false;
  }
}

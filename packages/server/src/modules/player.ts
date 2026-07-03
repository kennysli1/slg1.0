import type { Command, CommandResult } from '@slg/shared';
import type { Store } from '../infra/store.js';
import type { EventBus } from '../infra/event-bus.js';
import type { CommandBus } from '../infra/command-bus.js';
import type { ModuleManifest } from '../gateway/manifest.js';
import { hexKey, hexDistance } from '../infra/hex.js';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 领域模块 · Player（玩家身份）
 * 多人化与上线的核心：玩家账号（用户名+密码）、种族、拥有一个村庄。
 *
 * 职责：玩家账号的 owner。注册（用户名+密码+种族）、登录（校验密码）、
 *       玩家↔村庄双向映射、为新玩家分配地图空位。
 *
 * 密码安全：scrypt 加盐哈希（Node 内置 crypto，无第三方依赖），不存明文。
 *
 * 扩展点：一个玩家多村庄、更多玩家属性后续在此扩展。
 */

interface PlayerState {
  id: string;
  name: string;
  /** 密码哈希：salt:hash（hex） */
  pwd: string;
  /** 种族：romans/gauls/teutons */
  tribe: string;
  villageId: string;
  q: number; // 六边形轴坐标
  r: number;
  createdAt: number;
}

const COLLECTION = 'player';
const COLLECTION_BYNAME = 'player_byname';
const COLLECTION_BYVILLAGE = 'player_byvillage';

const VALID_TRIBES = ['romans', 'gauls', 'teutons'];

function hashPassword(pwd: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pwd, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(pwd: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(pwd, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export class PlayerModule {
  static readonly NAME = 'player';

  /** 对外动作清单（被 Gateway 汇总）。注册/登录是公开动作，无需鉴权。 */
  static readonly MANIFEST: ModuleManifest = {
    moduleName: 'player',
    publicActions: {
      Register: { command: 'player.Register' },
      Login: { command: 'player.Login' },
    },
  };

  constructor(
    private store: Store,
    private _bus: EventBus,
    private commands: CommandBus,
    private now: () => number,
    /** 由 app 提供：实际创建一个村庄（拼装 economy/building/military + 放地图）。 */
    private createVillage: (villageId: string, q: number, r: number, name: string, tribe: string) => void,
    /** 地图半径，用于随机分配出生坐标范围（默认 20）。 */
    private mapSize: number = 20,
  ) {}

  init(): void {
    this.commands.register('player.Register', (c) => this.register(c));
    this.commands.register('player.Login', (c) => this.login(c));
    this.commands.register('player.Get', (c) => this.get(c));
    this.commands.register('player.GetByVillage', (c) => this.getByVillage(c));
  }

  private load(id: string): PlayerState | undefined {
    return this.store.get<PlayerState>(COLLECTION, id);
  }

  /** 注册：用户名唯一 + 密码 + 种族 → 创建玩家与村庄。 */
  private register(cmd: Command): CommandResult {
    const { name, password, tribe } = cmd.payload as { name: string; password: string; tribe: string };
    const clean = (name ?? '').trim();
    if (!clean) return { ok: false, payload: {}, reason: 'empty_name' };
    if (clean.length > 16) return { ok: false, payload: {}, reason: 'name_too_long' };
    if (!password || password.length < 4) return { ok: false, payload: {}, reason: 'password_too_short' };
    const t = VALID_TRIBES.includes(tribe) ? tribe : 'romans';

    if (this.store.get<string>(COLLECTION_BYNAME, clean)) {
      return { ok: false, payload: {}, reason: 'name_taken' };
    }

    const id = `p-${this.nextSeq()}`;
    const villageId = `v-${id}`;
    const { q, r } = this.allocateSpot();
    this.createVillage(villageId, q, r, `${clean}的村庄`, t);

    const p: PlayerState = {
      id, name: clean, pwd: hashPassword(password), tribe: t,
      villageId, q, r, createdAt: this.now(),
    };
    this.store.set(COLLECTION, id, p);
    this.store.set(COLLECTION_BYNAME, clean, id);
    this.store.set(COLLECTION_BYVILLAGE, villageId, id);
    return { ok: true, payload: { player: this.publicPlayer(p) } };
  }

  /** 登录：校验用户名+密码。 */
  private login(cmd: Command): CommandResult {
    const { name, password } = cmd.payload as { name: string; password: string };
    const clean = (name ?? '').trim();
    const id = this.store.get<string>(COLLECTION_BYNAME, clean);
    if (!id) return { ok: false, payload: {}, reason: 'no_such_user' };
    const p = this.load(id);
    if (!p) return { ok: false, payload: {}, reason: 'no_such_user' };
    if (!verifyPassword(password ?? '', p.pwd)) return { ok: false, payload: {}, reason: 'wrong_password' };
    return { ok: true, payload: { player: this.publicPlayer(p) } };
  }

  private get(cmd: Command): CommandResult {
    const p = this.load((cmd.payload as any).playerId);
    if (!p) return { ok: false, payload: {}, reason: 'player_not_found' };
    return { ok: true, payload: { player: this.publicPlayer(p) } };
  }

  /** 村庄→玩家反查（PvP 攻击时找被攻击村的主人）。 */
  private getByVillage(cmd: Command): CommandResult {
    const pid = this.store.get<string>(COLLECTION_BYVILLAGE, (cmd.payload as any).villageId);
    if (!pid) return { ok: false, payload: {}, reason: 'owner_not_found' };
    const p = this.load(pid);
    if (!p) return { ok: false, payload: {}, reason: 'owner_not_found' };
    return { ok: true, payload: { player: this.publicPlayer(p) } };
  }

  /** 对外只暴露安全字段（绝不含 pwd）。 */
  private publicPlayer(p: PlayerState) {
    return { id: p.id, name: p.name, tribe: p.tribe, villageId: p.villageId, q: p.q, r: p.r };
  }

  private nextSeq(): number {
    const n = (this.store.get<number>('player_seq', 'n') ?? 0) + 1;
    this.store.set('player_seq', 'n', n);
    return n;
  }

  /**
   * 为新玩家分配地图空位：在地图内随机散布，与现有玩家保持最小间距（MIN_SPACING）。
   * 使用 LCG 伪随机（基于玩家总数做种子偏移），不用 Math.random()，保证可复现性。
   * 地图边缘留 2 格缓冲；若随机尝试失败（地图很满）则降级为螺旋兜底。
   */
  private allocateSpot(): { q: number; r: number } {
    const existing = this.store.all<PlayerState>(COLLECTION);
    const taken = new Set(existing.map((p) => hexKey(p.q, p.r)));

    // 最小玩家间距：地图半径的 1/4，最少 3 格，最多 8 格
    const MIN_SPACING = Math.max(3, Math.min(8, Math.floor(this.mapSize / 4)));
    const border = 2; // 距离地图边缘的最小距离
    const usableRadius = this.mapSize - border;

    // LCG 伪随机，种子基于当前玩家数（保证分布可复现但不集中）
    let seed = existing.length * 2654435761 + 1;
    const lcg = () => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 0x100000000;
    };

    const MAX_ATTEMPTS = 200;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // 在 usableRadius 范围内随机生成 axial 坐标
      const q = Math.round((lcg() * 2 - 1) * usableRadius);
      const r = Math.round((lcg() * 2 - 1) * usableRadius);
      // 确保在六边形地图内
      if (Math.abs(q) + Math.abs(r) + Math.abs(-q - r) > this.mapSize * 2) continue;
      if (taken.has(hexKey(q, r))) continue;
      // 检查与现有玩家的最小间距
      const tooClose = existing.some((p) => hexDistance({ q, r }, { q: p.q, r: p.r }) < MIN_SPACING);
      if (tooClose) continue;
      return { q, r };
    }

    // 兜底：螺旋向外找第一个空格（地图很满时）
    const DIRS = [
      { q: 1, r: 0 }, { q: 0, r: 1 }, { q: -1, r: 1 },
      { q: -1, r: 0 }, { q: 0, r: -1 }, { q: 1, r: -1 },
    ];
    for (let k = 1; k <= this.mapSize; k++) {
      let q = DIRS[4].q * k;
      let r = DIRS[4].r * k;
      for (let side = 0; side < 6; side++) {
        for (let step = 0; step < k; step++) {
          if (!taken.has(hexKey(q, r))) return { q, r };
          q += DIRS[side].q;
          r += DIRS[side].r;
        }
      }
    }
    return { q: 1, r: 0 };
  }

  /**
   * 运维：为所有现存账号重建村庄（刷档后调用）。账号本身（用户名/密码/种族）不动。
   * 调用前提：economy/building/military/world 等游戏进度集合已被清空、世界已重新 setup。
   *
   * @param reassignSpots false=保留每个账号原有地图坐标；true=按注册顺序重新螺旋分配坐标
   *                      （用于地图尺寸/布局也变了的情况），并同步更新账号记录与归属索引。
   */
  rebuildVillages(reassignSpots: boolean): void {
    // 按注册顺序（id 里的序号）稳定排序，保证重分配坐标可复现。
    const players = this.store
      .all<PlayerState>(COLLECTION)
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

    if (reassignSpots) {
      // 归属索引会整体重建，先清空避免残留旧 villageId 映射。
      this.store.clear(COLLECTION_BYVILLAGE);
    }

    for (const p of players) {
      let { q, r, villageId } = p;
      if (reassignSpots) {
        const spot = this.allocateSpot(); // 依赖已写回的 q/r 去重，逐个分配
        q = spot.q;
        r = spot.r;
        villageId = `v-${p.id}`;
        const updated: PlayerState = { ...p, q, r, villageId };
        this.store.set(COLLECTION, p.id, updated);
        this.store.set(COLLECTION_BYVILLAGE, villageId, p.id);
      }
      this.createVillage(villageId, q, r, `${p.name}的村庄`, p.tribe);
    }
  }
}
